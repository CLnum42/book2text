"""识别子进程的入口：``python -m book2text.worker --project-dir <项目目录> --job <任务 id>``。

它只做一件事：把这个任务里**还没成功**的页面逐页识别并落库，然后把任务结算掉。
进度、失败原因、状态全写在项目数据库里，因此父进程（服务）重启也不会丢进度，
父子之间不需要额外的通信协议。

**三条"该不该继续"的信号**（按优先级）：

1. **父进程还活着吗** —— 父进程持有一根从不写入的管子；它一死（哪怕 ``kill -9``），
   管子关闭，这里读到 EOF，于是**当前页做完就收工**并把任务标为中断。
   没有这一条，应用被强杀后会留下一个还在写数据库的孤儿进程。
2. **任务被取消了吗** —— 数据库里状态变成 ``cancelled``：收工，任务状态由父进程结算。
3. **任务被暂停了吗** —— 状态变成 ``paused``：原地等着，直到恢复运行或收到上面两条信号。

日志只写页码、结果与耗时：**不写识别文本，也不写路径**（说明书 Phase 6 的日志规则）。
"""

from __future__ import annotations

import argparse
import os
import stat
import sys
import threading
from pathlib import Path

from .core.project import executor, jobs, recognition


def _orphan_watchdog() -> threading.Event | None:
    """开一个后台线程读 stdin 的**文件描述符**：读到 EOF 就说明父进程没了。

    父进程用 ``stdin=PIPE`` 起本进程并且**从不写入**，所以正常情况下这个读会一直阻塞；
    父进程一旦退出（包括被强杀），操作系统会关掉管子的另一头，读立即返回空，即 EOF。

    两个实现细节都是有原因的：

    - 直接 ``os.read(0, ...)`` 而不是 ``sys.stdin.buffer.read()``：后者会在解释器退出时
      与 daemon 线程抢缓冲对象的锁，留下 "Fatal Python error: _enter_buffered_busy"。
    - **只有 stdin 是管道/套接字时才启用**：手动在终端里跑（stdin 是终端或
      ``/dev/null``）时"读到 EOF"不代表父进程死了，启用会让它立刻自己收工。
    """
    try:
        mode = os.fstat(0).st_mode
    except OSError:  # pragma: no cover - 没有 stdin
        return None
    if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
        return None

    orphaned = threading.Event()

    def reader() -> None:
        while True:
            try:
                chunk = os.read(0, 4096)
            except OSError:  # pragma: no cover - 管道被异常关闭
                break
            if not chunk:
                break
        orphaned.set()

    thread = threading.Thread(target=reader, name="orphan-watchdog", daemon=True)
    thread.start()
    return orphaned


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="book2text.worker",
        description="识别子进程：把某个任务里还没成功的页面逐页识别并落库",
    )
    parser.add_argument("--project-dir", required=True, help="项目文件夹（含 project.db）")
    parser.add_argument("--job", required=True, help="任务 id")
    args = parser.parse_args(argv)

    directory = Path(args.project_dir)
    orphaned = _orphan_watchdog() or threading.Event()  # 没有管道时给一个永不触发的

    def log(message: str) -> None:
        print(message, flush=True)

    def decide() -> str:
        if orphaned.is_set():
            # 父进程没了：做完当前页就停，并把任务结算成中断（父进程已经不在，
            # 这件事只能由我们来做）
            return recognition.DECISION_STOP
        status = jobs.get_job(directory, args.job).status
        if status == jobs.STATUS_PAUSED:
            return recognition.DECISION_PAUSE
        if status == jobs.STATUS_RUNNING:
            return recognition.DECISION_RUN
        return recognition.DECISION_STOP

    try:
        outcome = recognition.run_job(directory, args.job, should_continue=decide, log=log)
    except jobs.JobError as exc:
        print(f"job {args.job} error {exc}", flush=True)
        return 2

    if orphaned.is_set():
        # 父进程已死：把任务标为中断并修理没结算的记录，让下次打开项目时状态是干净的
        log(f"job {args.job} orphaned, 标记为中断")
        try:
            jobs.set_status(directory, args.job, jobs.STATUS_INTERRUPTED)
            jobs.repair_unfinished(
                directory, message=jobs.INTERRUPTED_MESSAGE, job_id=args.job
            )
        except jobs.JobError:  # pragma: no cover - 数据库不可用时只能放弃
            return 3

    return 0 if outcome.job.status == jobs.STATUS_SUCCEEDED else 1


if __name__ == "__main__":  # pragma: no cover - 由 `python -m book2text.worker` 触发
    sys.exit(main())
