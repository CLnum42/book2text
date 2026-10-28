"""识别任务的执行器：在**子进程**里跑识别（说明书 Phase 2 要求）。

为什么非要是子进程：

- **内存：** RapidOCR 认一页的峰值约 2.7 GB（Phase 0 实测）。跑在服务进程里，
  界面会跟着一起卡顿，任务结束后内存也未必归还。
- **可取消：** 取消要立刻停手。杀一个进程是最干脆的实现——服务进程没法"停一半"。
- **崩溃隔离：** ONNX 引擎崩了不该把整个应用带走。

父进程（服务）做四件事：起进程、跟踪存活、终止（取消 / 退出时）、
**对账**（子进程没了但任务还写着 running——比如引擎进程被杀）。
子进程只做一件事：把这个任务里还没成功的页逐页认完（`recognition.run_job`）。

**父子之间的接口只有数据库和一根管子。** 状态、进度、失败原因都写数据库，
因此哪一边重启都不会丢进度；另外父进程持有一根**从不写入**的 stdin 管子，
它随父进程一起被关闭——子进程读到 EOF 就知道自己成了孤儿，会在当前页之后收工
（`book2text.worker` 的看门狗）。这样应用被强杀也不会留下一个还在写数据库的孤儿进程。
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .. import limits as limits_module
from ..project import jobs as jobs_module

LOG_DIR_NAME = "logs"
LOG_PREFIX = "ocr-"

# 取消时给子进程的宽限（秒）：先等它自己在页与页之间收工，超时再强杀
TERMINATE_GRACE = 2.0
KILL_GRACE = 5.0

# 刚建出来、还没来得及起子进程的任务不参与对账（避免误判成"中断"）
CREATED_GRACE_SECONDS = 15.0


def worker_command(directory: Path, job_id: str) -> list[str]:
    """子进程的命令行。

    用**同一个解释器**（``sys.executable``），这样虚拟环境里的依赖照样可用。

    **PyInstaller 打包（Phase 6）时这里要改。** 打包后没有"用源码跑模块"这条路，
    通常的做法是 ``[sys.executable, "--b2t-worker", "--project-dir", ..., "--job", ...]``，
    并在入口里识别这个标记（配合 ``sys.frozen``）。现在先用源码运行的方式，
    到打包那一步只改这一个函数。
    """
    if getattr(sys, "frozen", False):
        # 打包运行（PyInstaller）：改用同一个可执行文件的 `--b2t-worker` 入口
        return [
            sys.executable,
            "--b2t-worker",
            "--project-dir",
            str(directory),
            "--job",
            job_id,
        ]
    return [
        sys.executable,
        "-m",
        "book2text.worker",
        "--project-dir",
        str(directory),
        "--job",
        job_id,
    ]


@dataclass
class _Child:
    job_id: str
    directory: Path
    process: subprocess.Popen
    log_handle: object
    started_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())

    @property
    def alive(self) -> bool:
        return self.process.poll() is None


# 原生层崩溃的信号：只有这些才按"引擎崩溃 · 已跳过"结算。
# SIGSEGV(11) / SIGBUS(10) / SIGABRT(6) / SIGILL(4) / SIGFPE(8)。
# SIGKILL(9) / SIGTERM(15) / SIGINT(2) 属于"被停"，仍按中断处理。
CRASH_SIGNALS = frozenset({4, 6, 8, 10, 11})


class Supervisor:
    """跟踪本进程起过的识别子进程。

    一个应用实例一份（挂在 ``app.state`` 上）。**它不跨进程**：
    服务重启后注册表是空的，那时"数据库里还写着 running"的任务由
    `jobs.mark_interrupted`（打开项目时）或本类的 `reconcile` 收拾。
    """

    def __init__(
        self,
        *,
        command_builder: Callable[[Path, str], Sequence[str]] | None = None,
        terminate_grace: float = TERMINATE_GRACE,
        kill_grace: float = KILL_GRACE,
    ) -> None:
        self._children: dict[str, _Child] = {}
        self._lock = threading.Lock()
        # 缺省命令在**调用时**取，测试可以直接替换 worker_command
        self._command_builder = command_builder or worker_command
        self._terminate_grace = terminate_grace
        self._kill_grace = kill_grace

    # ---------------------------------------------------------------- 查询

    def is_alive(self, job_id: str) -> bool:
        with self._lock:
            self._reap_locked()
            child = self._children.get(job_id)
            return child is not None and child.alive

    def running_job_ids_for(self, directory: Path) -> set[str]:
        """某个项目正在跑的任务 id（打开项目做中断清理时要避开它们）。"""
        with self._lock:
            self._reap_locked()
            return {
                job_id
                for job_id, child in self._children.items()
                if child.alive and child.directory == directory
            }

    def live_entries(self) -> list[tuple[str, Path]]:
        """还活着的任务：(job_id, 项目目录)。服务退出时按它逐个收拾。"""
        with self._lock:
            self._reap_locked()
            return [
                (job_id, child.directory)
                for job_id, child in self._children.items()
                if child.alive
            ]

    def process_id(self, job_id: str) -> int | None:
        with self._lock:
            child = self._children.get(job_id)
            return child.process.pid if child is not None and child.alive else None

    # ---------------------------------------------------------------- 起

    def start(self, directory: Path, job_id: str) -> int:
        """起一个子进程跑这个任务，返回进程号。"""
        log_path = directory / LOG_DIR_NAME / f"{LOG_PREFIX}{job_id}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handle = log_path.open("a", encoding="utf-8")

        command = list(self._command_builder(directory, job_id))
        # 任务 68：给 UI 留核。识别子进程里 onnxruntime 默认把**所有核**开满，
        # 662 页英文书实测识别期间 `/review/finish-summary` 从 5 ms 掉到 357 ms、
        # 取页图从 126 ms 掉到 260 ms。这里在 spawn 之前把 BLAS / OMP 的线程数
        # 限到 `cpu_count - 2`（子进程继承环境变量），适配器里再设
        # `intra_op_num_threads`——两处都要设：ONNX Runtime 只认后者，
        # numpy / OpenBLAS 只认环境变量。
        child_env = _limited_thread_env()
        try:
            process = subprocess.Popen(  # noqa: S603 - 命令由本模块拼装，不由用户输入决定
                command,
                stdin=subprocess.PIPE,  # 从不写入：父进程一死它就关，子进程据此识别孤儿
                stdout=handle,
                stderr=subprocess.STDOUT,
                # 自成进程组：终端上的 Ctrl+C 不该直接打断子进程——
                # 收尾由服务自己的 shutdown 做（它知道要不要修理任务状态）
                start_new_session=True,
                env=child_env,
                # 识别是后台活：低一档优先级，前台请求先拿 CPU（POSIX 用 nice，
                # Windows 走 BELOW_NORMAL_PRIORITY_CLASS）
                **_priority_kwargs(),
            )
        except OSError as exc:
            handle.close()
            raise jobs_module.JobError(f"无法启动识别子进程：{exc}") from exc

        with self._lock:
            self._reap_locked()
            self._children[job_id] = _Child(
                job_id=job_id, directory=directory, process=process, log_handle=handle
            )
        return process.pid

    # ---------------------------------------------------------------- 停

    def stop(self, job_id: str) -> bool:
        """终止这个任务的子进程；返回是否真的杀了一个活着的进程。

        调用方**必须**在返回之后才修理数据库里还没结算的记录
        （见 `jobs.repair_unfinished` 的说明：修理做在执行者退出之后）。
        """
        with self._lock:
            child = self._children.pop(job_id, None)
        if child is None:
            return False
        alive = child.alive
        if alive:
            child.process.terminate()
            try:
                child.process.wait(timeout=self._terminate_grace)
            except subprocess.TimeoutExpired:
                child.process.kill()
                try:
                    child.process.wait(timeout=self._kill_grace)
                except subprocess.TimeoutExpired:  # pragma: no cover - 系统卡死时
                    pass
        self._close(child)
        return alive

    def shutdown(self) -> None:
        """服务退出：把所有子进程收掉。

        任务的最终状态由调用方（应用退出钩子）在此之前写库——这里只负责不让
        子进程活过服务：否则应用都关了，还有进程在写项目数据库。
        """
        with self._lock:
            job_ids = list(self._children)
        for job_id in job_ids:
            self.stop(job_id)

    # ---------------------------------------------------------------- 对账

    def reconcile(self, directory: Path) -> int:
        """把"数据库说在跑、但本进程没有对应子进程"的任务标记为中断。

        只可能有两种来源：子进程自己崩了（引擎段错误之类），或者服务重启过
        （那种情况通常已被 `jobs.mark_interrupted` 处理）。返回被收拾的任务数。
        """
        now = datetime.now(timezone.utc)
        fixed = 0
        for job in jobs_module.active_jobs(directory):
            if self.is_alive(job.job_id):
                continue
            if _created_recently(job.created_at, now, CREATED_GRACE_SECONDS):
                # 刚建出来：子进程还没起来（POST 里建任务与起进程之间有个缝）
                continue
            jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_INTERRUPTED)
            jobs_module.repair_unfinished(
                directory,
                message="识别进程意外结束（任务被标记为中断，可继续或重试失败页）",
                job_id=job.job_id,
            )
            fixed += 1
        return fixed

    # ---------------------------------------------------------------- 内部

    def _reap_locked(self) -> None:
        """清掉已经退出的子进程（关闭日志句柄）。调用方持锁。

        **被信号杀掉的子进程**（原生层段错误等）在这里结算：把正在跑的那一页记成
        "引擎崩溃 · 已跳过"，任务标中断，剩下的页还能"继续"跑完。Python 里捕获不到
        SIGSEGV，这是唯一能拿到崩溃页号的地方（`returncode` 是负的信号号）。
        """
        for job_id, child in list(self._children.items()):
            if child.alive:
                continue
            code = child.process.returncode
            # 负值 = 被信号终止；0 / 正数都算正常退出（Python 层已自己结算）。
            # 只有**原生层崩溃**那几种信号才按"引擎崩溃 · 已跳过"处理：
            # SIGKILL / SIGTERM 是用户或服务自己停的（应用退出时先写 interrupted 再杀），
            # 把它们记成崩溃会让"我主动停的"变成"这本书崩了"，走向反了。
            if isinstance(code, int) and abs(code) in CRASH_SIGNALS:
                try:
                    jobs_module.mark_crashed(
                        child.directory, job_id, signal_no=abs(code)
                    )
                except Exception:  # noqa: BLE001 - 结算失败也不能卡住收尾
                    pass
            del self._children[job_id]
            self._close(child)

    @staticmethod
    def _close(child: _Child) -> None:
        try:
            child.log_handle.close()  # type: ignore[attr-defined]
        except OSError:  # pragma: no cover
            pass


def _created_recently(created_at: str, now: datetime, seconds: float) -> bool:
    try:
        created = datetime.fromisoformat(created_at)
    except ValueError:  # pragma: no cover - 时间戳由本应用写入
        return False
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (now - created).total_seconds() < seconds

def worker_thread_count() -> int:
    """识别子进程该用几个线程（规则见 `core/limits.py`）。"""
    return limits_module.worker_thread_count()


def _limited_thread_env() -> dict[str, str]:
    """子进程环境：限掉 BLAS / OMP 的默认线程数（它们各干各的，互不认识）。"""
    env = dict(os.environ)
    threads = str(worker_thread_count())
    for name in (
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
    ):
        env[name] = threads
    return env


def _priority_kwargs() -> dict[str, object]:
    """让子进程低一档优先级（POSIX 用 nice，Windows 用创建标志）。"""
    if os.name == "nt":  # pragma: no cover - Windows 打包未验证
        return {"creationflags": 0x00004000}   # BELOW_NORMAL_PRIORITY_CLASS
    return {"preexec_fn": _nice_child}


def _nice_child() -> None:  # pragma: no cover - 只在子进程里跑
    try:
        os.nice(10)
    except OSError:
        pass
