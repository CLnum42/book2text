"""Jev 引擎（llama.cpp）的守护：起进程、等就绪、查健康、崩溃自愈、退出收尸（2026-11-05）。

**为什么单独一个模块**：Jev 打分要同时具备三样东西——引擎进程、模型包、打分层。
2026-11-05 之前的做法是让人手工 `llama-server …` 再 `bash sdk/start_score.sh …`，
于是"点了没反应"变成用户自己诊断环境问题（真机复现：三项 detail 一起报）。
这里把**引擎的整个生命周期收进应用**，UI 只问一句话："能不能打分"。

**进程模型（三条边界）**

1. **懒启动**：引擎常驻约 3.1 GB RSS，不在开机时占着。进审校视图 / 第一次点「Jev 打分…」
   时才 `ensure()`，起来之后常驻到应用退出。
2. **懒自愈**：`ensure()` 发现子进程没了（包括被 `kill -9`）就重启，最多 3 次、指数退避
   （1 / 2 / 4 秒）。**不起后台看门狗**——崩溃本来就只在下一次用的时候才需要知道，
   少一个常驻线程就少一处"看起来活着其实死了"。
3. **退出收尸**：`stop()` 先 SIGTERM、等 3 秒、再 SIGKILL；pid 文件写在应用私域目录，
   下次启动先按它清孤儿（端口和 pid 都可能被上一次异常退出留下）。

**健康检查的四步**（`check()` 负责 1–3，第 4 步"界面点亮"由 API 层拼）：

```
1 引擎进程真在：进程活着 **且** lsof 显示这个 pid 正在监听这个端口
2 引擎能答：GET /v1/models 200 且模型 id 就是我们这份模型（不是别的引擎占了端口）
3 真能打分：走一次完整打分（打分层自己实现，见 jev_score_host）——前两步证明不了"能出分"，
  2026-11-05 那次故障正是"进程起了、接口通了、模型没加载完"
```

**模型从哪来**：只认 `manifest.json`（应用私域目录 / 打包内置目录），
不在代码里另写一份字节数或哈希——校验逻辑只有 `verify_model_files()` 一处。
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Sequence

from ... import paths as paths_module

#: 引擎就绪的等待上限（秒）。冷盘读 2.68 GB 权重也要几十秒，60 s 是"慢但还愿意等"的边界。
READY_TIMEOUT = 60.0
#: 退出时先礼后兵：SIGTERM 之后等这么久再 SIGKILL。
SHUTDOWN_GRACE = 3.0
#: 崩溃自愈预算：最多重启这么多次；退避按 (1, 2, 4) 秒。
MAX_RESTARTS = 3
RESTART_BACKOFF = (1.0, 2.0, 4.0)
#: 报错时给用户看的 stderr 行数（"加载失败"的真实原因几乎总在最后几行）。
STDERR_TAIL_LINES = 20
#: 内存里保留的 stderr 行数（比上面多留一些，便于诊断打印）。
STDERR_KEEP_LINES = 400

MANIFEST_NAME = "manifest.json"


class JevEngineError(RuntimeError):
    """引擎起不来 / 起来了不能用。`detail` 里必须能看出**卡在哪一步、缺什么**。"""

    def __init__(self, message: str, *, step: int = 1) -> None:
        super().__init__(message)
        self.step = step


# ---------------------------------------------------------------- 模型包（manifest 是唯一出处）


@dataclass(frozen=True)
class ModelFile:
    name: str
    bytes: int
    sha256: str
    role: str = ""


@dataclass(frozen=True)
class ModelPack:
    directory: Path
    files: tuple[ModelFile, ...]
    engine_version: str | None = None

    def path_of(self, role: str) -> Path:
        for item in self.files:
            if item.role == role:
                return self.directory / item.name
        raise JevEngineError(f"模型包 manifest 里没有 role={role} 的文件（{self.directory}）")

    @property
    def model(self) -> Path:
        return self.path_of("model")

    @property
    def mmproj(self) -> Path:
        return self.path_of("mmproj")


def default_model_dir() -> Path:
    """模型包目录：环境变量 > 打包内置 > 应用私域。

    **代码里不许出现 /tmp 之类的临时目录**：2026-11-05 之前唯一一份模型放在 /tmp，
    重启就没了；现在默认是私域目录，打包后换成随包内置的那份。
    """
    override = os.environ.get("B2T_JEV_MODEL_DIR")
    if override:
        return Path(override)
    if getattr(sys, "frozen", False):  # pragma: no cover - 打包后才有
        bundled = Path(getattr(sys, "_MEIPASS", paths_module.PACKAGE_DIR)) / "jev"
        if (bundled / MANIFEST_NAME).is_file():
            return bundled
    return paths_module.app_data_dir() / "jev"


def default_engine_binary() -> str:
    """llama-server 的可执行文件：环境变量 > 打包内置 > PATH 里的那个。"""
    override = os.environ.get("B2T_JEV_ENGINE_BIN")
    if override:
        return override
    if getattr(sys, "frozen", False):  # pragma: no cover - 打包后才有
        bundled = (
            Path(getattr(sys, "_MEIPASS", paths_module.PACKAGE_DIR)) / "jev-engine" / "llama-server"
        )
        if bundled.is_file():
            return str(bundled)
    return shutil.which("llama-server") or "llama-server"


def load_model_pack(directory: Path | None = None) -> ModelPack:
    """读 `manifest.json`。缺文件 / 格式不对都要说清**是哪个目录缺什么**。"""
    target = Path(directory) if directory is not None else default_model_dir()
    manifest_path = target / MANIFEST_NAME
    if not manifest_path.is_file():
        raise JevEngineError(f"模型包缺 manifest.json（{manifest_path}）")
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise JevEngineError(f"manifest.json 读不了：{manifest_path}（{exc}）") from exc
    entries = data.get("files") or []
    files: list[ModelFile] = []
    for entry in entries:
        name = entry.get("name")
        if not name:
            continue
        files.append(
            ModelFile(
                name=str(name),
                bytes=int(entry.get("bytes") or 0),
                sha256=str(entry.get("sha256") or ""),
                role=str(entry.get("role") or ""),
            )
        )
    if not files:
        raise JevEngineError(f"manifest.json 里没有 files（{manifest_path}）")
    version = (data.get("engine") or {}).get("llama_cpp_version")
    return ModelPack(directory=target, files=tuple(files), engine_version=version)


def verify_model_files(pack: ModelPack, *, deep: bool = False) -> list[str]:
    """核对模型包；返回**缺什么/哪里不对**（空列表 = 齐）。

    默认只比字节数（毫秒级）；`deep=True` 才逐个算 sha256（2.68 GB 约几秒）。
    这是**唯一**一处校验实现：打包脚本与启动器都调它，不各写一套。
    """
    problems: list[str] = []
    for item in pack.files:
        path = pack.directory / item.name
        if not path.is_file():
            problems.append(f"模型文件缺失：{path}")
            continue
        size = path.stat().st_size
        if item.bytes and size != item.bytes:
            problems.append(f"模型文件大小不符：{item.name}（{size} ≠ {item.bytes} 字节）")
            continue
        if deep and item.sha256 and _sha256(path) != item.sha256:
            problems.append(f"模型文件 sha256 不符：{item.name}（可能下坏了或被改过）")
    return problems


def _sha256(path: Path, *, chunk: int = 1 << 20) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


# ---------------------------------------------------------------- 四步健康检查


@dataclass(frozen=True)
class EngineCheck:
    """一步一报的结论。`step` 是**失败在哪一步**；成功时 step=3（第 4 步由 API 层点亮界面）。"""

    ok: bool
    step: int
    detail: str = ""
    pid: int | None = None
    port: int | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "step": self.step,
            "detail": self.detail,
            "pid": self.pid,
            "port": self.port,
        }


@dataclass
class EngineConfig:
    """引擎怎么起。默认值都是**实测过的**（2026-11-05，M5 / 32 GB）。"""

    model_dir: Path | None = None
    binary: str | None = None
    host: str = "127.0.0.1"
    port: int = 0  # 0 = 每次挑一个空闲端口（避免和用户自己起的 llama-server 撞）
    ctx: int = 32768
    ngl: int = 99
    ready_timeout: float = READY_TIMEOUT
    shutdown_grace: float = SHUTDOWN_GRACE
    max_restarts: int = MAX_RESTARTS
    backoff: Sequence[float] = RESTART_BACKOFF
    state_dir: Path | None = None  # pid 文件所在目录；默认跟模型包同一个私域根
    extra_args: tuple[str, ...] = ()


def find_free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def port_listening_pids(port: int) -> set[int]:
    """哪个 pid 正在监听这个端口（macOS 用 lsof）。

    没有 lsof 的环境返回空集；调用方据此退化成"连得上就算"（见 `_check_step1`）。
    """
    if shutil.which("lsof") is None:  # pragma: no cover - macOS 一定有
        return set()
    try:
        done = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):  # pragma: no cover - 极端环境
        return set()
    return {int(token) for token in done.stdout.split() if token.strip().isdigit()}


def _http_json(url: str, *, timeout: float = 2.0) -> dict[str, object] | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            if response.status != 200:
                return None
            return json.loads(response.read())
    except (urllib.error.URLError, OSError, ValueError):
        return None


class JevEngine:
    """一个应用实例一份（挂在 app.state 上）。**不跨进程**：进程重启后 pid 文件负责清孤儿。"""

    def __init__(self, config: EngineConfig | None = None) -> None:
        self._config = config or EngineConfig()
        self._lock = threading.RLock()
        self._process: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None
        self._stderr: deque[str] = deque(maxlen=STDERR_KEEP_LINES)
        # stderr 自己的锁：stop() 持主锁时会 join reader 线程，reader 若再抢主锁就会空等 2 秒
        self._stderr_lock = threading.Lock()
        self._port: int = 0
        self._started_at: float | None = None
        self._heals = 0         # 自愈尝试次数（预算用：最多 max_restarts 次）
        self._restarts = 0      # 其中真正起来的次数（报表用）
        self._next_restart_at = 0.0
        self._stopping = False
        self._last_error = ""

    # ---------------------------------------------------------------- 对外

    @property
    def pid(self) -> int | None:
        with self._lock:
            return self._process.pid if self._process is not None else None

    @property
    def port(self) -> int:
        with self._lock:
            return self._port

    @property
    def restarts(self) -> int:
        with self._lock:
            return self._restarts

    def stderr_tail(self, lines: int = STDERR_TAIL_LINES) -> str:
        with self._stderr_lock:
            return "\n".join(list(self._stderr)[-lines:]).strip()

    def ensure(self) -> EngineCheck:
        """要用引擎了：没起就起，崩了就自愈（预算内）。返回**当前**四步结论（1–3）。"""
        with self._lock:
            # 冷启动（从没起过）不算"自愈"，不占重启预算；有进程但死了才算
            recovering = self._process is not None
            if self._process is not None and self._process.poll() is None:
                check = self.check()
                if check.ok:
                    return check
                if check.step != 2:  # 进程在但不答：按崩溃处理（端口被占 / 加载失败）
                    self._record_error(check.detail)
            elif self._process is not None:
                self._record_error(
                    f"引擎进程已退出（exit={self._process.returncode}）"
                )
            try:
                self._restart_locked(self_heal=recovering)
                return self.check()
            except JevEngineError as exc:
                return EngineCheck(ok=False, step=exc.step, detail=str(exc), pid=self.pid, port=self._port)

    def start(self) -> EngineCheck:
        """无条件起一次（已在跑则先停）。启动器与"重新启动引擎"用它。"""
        with self._lock:
            self.stop()
            self._heals = 0
            self._restarts = 0
            self._next_restart_at = 0.0
            self._restart_locked(self_heal=False)
            return self.check()

    def stop(self) -> None:
        """收尸：SIGTERM → 等 3 秒 → SIGKILL。可重复调用。

        **没有自己的进程时不清 pid 文件**：那可能是上一次异常退出留下的孤儿，
        清掉它等于把"该杀谁"的唯一线索删了（`start()` 会先 stop 再起，正好踩这条）。
        """
        with self._lock:
            process = self._process
            if process is None:
                return
            self._stopping = True
            try:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=self._config.shutdown_grace)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:  # pragma: no cover - 内核级卡死
                            pass
            finally:
                self._close_reader()
                self._process = None
                self._port = 0
                self._started_at = None
                self._stopping = False
                self._clear_state_file()

    def check(self) -> EngineCheck:
        """四步里的 1–3（第 3 步要打分层，由调用方通过 `score_probe` 传进来才验）。"""
        with self._lock:
            return self._check_locked()

    def check_with_score(self, score_probe: Callable[[int], str | None]) -> EngineCheck:
        """先验 1–2，再让打分层真打一次分（第 3 步）。

        `score_probe(port)` 返回 `None` = 通过；返回字符串 = 失败原因。
        """
        with self._lock:
            check = self._check_locked()
            if not check.ok:
                return check
            detail = score_probe(self._port)
            if detail:
                return EngineCheck(ok=False, step=3, detail=detail, pid=self.pid, port=self._port)
            return EngineCheck(ok=True, step=3, pid=self.pid, port=self._port)

    # ---------------------------------------------------------------- 内部

    def _check_locked(self) -> EngineCheck:
        process = self._process
        if process is None:
            return EngineCheck(ok=False, step=1, detail="引擎没起（还没启动过）")
        if process.poll() is not None:
            self._record_error(f"引擎进程已退出（exit={process.returncode}）")
            return EngineCheck(
                ok=False,
                step=1,
                detail=f"引擎进程已退出（exit={process.returncode}）" + self._tail_suffix(),
                pid=process.pid,
                port=self._port,
            )
        owners = port_listening_pids(self._port)
        if owners:
            if process.pid not in owners:
                return EngineCheck(
                    ok=False,
                    step=1,
                    detail=f"端口 {self._port} 被别的进程占着（pid {sorted(owners)}），不是我们起的引擎",
                    pid=process.pid,
                    port=self._port,
                )
        elif not self._tcp_ok(self._port):
            return EngineCheck(
                ok=False,
                step=1,
                detail=f"引擎进程在（pid {process.pid}），但 {self._config.host}:{self._port} 还没监听",
                pid=process.pid,
                port=self._port,
            )
        data = _http_json(f"http://{self._config.host}:{self._port}/v1/models")
        if data is None:
            return EngineCheck(
                ok=False,
                step=2,
                detail=f"引擎不答 /v1/models（{self._config.host}:{self._port}）" + self._tail_suffix(),
                pid=process.pid,
                port=self._port,
            )
        ids = [str(item.get("id") or "") for item in data.get("data") or [] if isinstance(item, dict)]
        expected = self._model_name()
        if expected and not any(Path(value).name == expected for value in ids):
            return EngineCheck(
                ok=False,
                step=2,
                detail=f"/v1/models 里没有这份模型（期望 {expected}，实际 {ids or '空'}）",
                pid=process.pid,
                port=self._port,
            )
        return EngineCheck(ok=True, step=2, pid=process.pid, port=self._port)

    def _restart_locked(self, *, self_heal: bool) -> None:
        now = time.monotonic()
        if self_heal and self._heals >= self._config.max_restarts:
            raise JevEngineError(
                f"引擎已经连续自愈 {self._heals} 次仍不能用，先不再重启了"
                + (f"：{self._last_error}" if self._last_error else "")
                + self._tail_suffix(),
                step=1,
            )
        if self._next_restart_at and now < self._next_restart_at:
            # 有退避窗口：用户正在等，就睡过去（最多一个退避档），别回一句"1 秒后再试"
            cap = max(self._config.backoff) if self._config.backoff else 0.0
            time.sleep(min(self._next_restart_at - now, cap))
            now = time.monotonic()
        if self_heal:
            self._heals += 1
        self._reap_orphan_locked()
        pack = load_model_pack(self._config.model_dir)
        problems = verify_model_files(pack)
        if problems:
            raise JevEngineError("；".join(problems))
        binary = self._config.binary or default_engine_binary()
        if not Path(binary).is_file() and shutil.which(binary) is None:
            raise JevEngineError(f"找不到引擎可执行文件：{binary}（打包时随包内置，或用 B2T_JEV_ENGINE_BIN）")
        self._port = self._config.port or find_free_port(self._config.host)
        argv = [
            binary,
            "-m",
            str(pack.model),
            "--mmproj",
            str(pack.mmproj),
            "-ngl",
            str(self._config.ngl),
            "-c",
            str(self._config.ctx),
            "--host",
            self._config.host,
            "--port",
            str(self._port),
            *self._config.extra_args,
        ]
        with self._stderr_lock:
            self._stderr.clear()
        try:
            process = subprocess.Popen(  # noqa: S603 - 命令由本模块拼装，不由用户输入决定
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                bufsize=1,
            )
        except OSError as exc:
            raise JevEngineError(f"引擎起不来：{binary}（{exc}）") from exc
        self._process = process
        self._started_at = time.monotonic()
        if self_heal:
            self._restarts += 1
        self._reader = threading.Thread(
            target=self._drain, args=(process,), name="jev-engine-stderr", daemon=True
        )
        self._reader.start()
        self._write_state_file(process.pid, self._port)
        self._wait_ready_locked(process)

    def _wait_ready_locked(self, process: subprocess.Popen) -> None:
        deadline = time.monotonic() + self._config.ready_timeout
        expected = self._model_name()
        while time.monotonic() < deadline:
            if process.poll() is not None:
                self._record_error(f"引擎起来了又退出（exit={process.returncode}）")
                self._after_failure_locked()
                raise JevEngineError(
                    f"引擎加载失败（exit={process.returncode}）" + self._tail_suffix(), step=1
                )
            data = _http_json(f"http://{self._config.host}:{self._port}/v1/models", timeout=1.0)
            if data is not None:
                ids = [
                    str(item.get("id") or "")
                    for item in data.get("data") or []
                    if isinstance(item, dict)
                ]
                if not expected or any(Path(value).name == expected for value in ids):
                    return
            time.sleep(0.2)
        self._record_error(f"等了 {self._config.ready_timeout:.0f} 秒引擎还没就绪")
        self._after_failure_locked()
        raise JevEngineError(
            f"等了 {self._config.ready_timeout:.0f} 秒，引擎还没答 /v1/models"
            + self._tail_suffix(),
            step=2,
        )

    def _after_failure_locked(self) -> None:
        """一次失败之后：把半死的进程收掉，记一次重启，排下一次的自愈时间。"""
        process = self._process
        if process is not None and process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:  # pragma: no cover
                pass
        self._close_reader()
        self._process = None
        self._clear_state_file()
        index = min(max(self._heals - 1, 0), len(self._config.backoff) - 1)
        self._next_restart_at = time.monotonic() + self._config.backoff[index]

    def _drain(self, process: subprocess.Popen) -> None:
        stream = process.stderr
        if stream is None:  # pragma: no cover - 我们总是传 PIPE
            return
        try:
            for line in stream:
                text = line.rstrip("\n")
                if text:
                    with self._stderr_lock:
                        self._stderr.append(text)
        except (ValueError, OSError):  # pragma: no cover - 进程被杀时管道会断
            pass
        out = process.stdout
        if out is not None:  # 把 stdout 读干净，避免管道写满把引擎卡住
            try:
                for _ in out:  # pragma: no cover - llama-server 基本不写 stdout
                    pass
            except (ValueError, OSError):
                pass

    def _close_reader(self) -> None:
        reader = self._reader
        self._reader = None
        if reader is not None and reader.is_alive() and reader is not threading.current_thread():
            reader.join(timeout=2)

    def _record_error(self, detail: str) -> None:
        if detail and detail != self._last_error:
            self._last_error = detail

    def _tail_suffix(self) -> str:
        tail = self.stderr_tail()
        return f"\n引擎 stderr 最后 {STDERR_TAIL_LINES} 行：\n{tail}" if tail else ""

    def _model_name(self) -> str:
        try:
            return load_model_pack(self._config.model_dir).model.name
        except JevEngineError:
            return ""

    def _tcp_ok(self, port: int) -> bool:
        try:
            with socket.create_connection((self._config.host, port), timeout=0.5):
                return True
        except OSError:
            return False

    # ---- pid 文件：跨进程的"谁占着引擎"账本 ----

    @property
    def _state_path(self) -> Path:
        base = self._config.state_dir or (paths_module.app_data_dir() / "jev")
        return Path(base) / "engine.json"

    def _write_state_file(self, pid: int, port: int) -> None:
        path = self._state_path
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "pid": pid,
                "port": port,
                "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "model": self._model_name(),
            }
            temp = path.with_suffix(".tmp")
            temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.replace(temp, path)
        except OSError:  # pragma: no cover - 写不了 pid 文件不该挡住引擎
            pass

    def _clear_state_file(self) -> None:
        try:
            self._state_path.unlink(missing_ok=True)
        except OSError:  # pragma: no cover
            pass

    def _reap_orphan_locked(self) -> None:
        """上一次异常退出留下的引擎：确认是本应用的（命令行里有我们的模型名）才杀。"""
        path = self._state_path
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        pid = int(payload.get("pid") or 0)
        if pid <= 0:
            path.unlink(missing_ok=True)
            return
        if pid == os.getpid():
            return
        command = _process_command(pid)
        own_model = self._model_name()
        if command and own_model and own_model in command:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.kill(pid, sig)
                except OSError:
                    break
                for _ in range(20):
                    if _process_command(pid) is None:
                        break
                    time.sleep(0.1)
                if _process_command(pid) is None:
                    break
        try:
            path.unlink(missing_ok=True)
        except OSError:  # pragma: no cover
            pass


def _process_command(pid: int) -> str | None:
    """这个 pid 的命令行；进程不存在（或只剩僵尸）返回 None。

    僵尸要当"已死"：被 SIGKILL 的子进程在父进程 wait 之前会一直以 Z 状态出现，
    拿它当"还活着"会让收尸循环空等，也让测试里 `kill -0` 永远成功。
    """
    try:
        done = subprocess.run(
            ["ps", "-p", str(pid), "-o", "state=,command="],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):  # pragma: no cover
        return None
    text = done.stdout.strip()
    if not text or text.startswith("Z"):
        return None
    return text
