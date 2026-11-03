"""Book2Text 启动入口（说明书 10 节要求两个平台的启动脚本只调用这里）。

职责：选端口 → 生成会话令牌 → 装配应用 → 打开浏览器 → 启动服务。
"""

from __future__ import annotations

import argparse
import atexit
import secrets
import signal
import socket
import sys

import uvicorn

from pathlib import Path

from . import __version__
from .api.app import create_app
from .api.security import allowed_origins
from .core import platform as b2t_platform
from .core.ocr import selfcheck
from .core.project import lock as lock_module
from .core.project.library import default_library_dir

# 说明书 4.4：只监听 127.0.0.1，不监听 0.0.0.0。
HOST = "127.0.0.1"
DEFAULT_PORT = 8765
PORT_ATTEMPTS = 20


def find_free_port(start: int, attempts: int = PORT_ATTEMPTS) -> int:
    """从 `start` 向后找第一个可用端口（说明书 4.4）。

    这里只是探测，真正绑定发生在 uvicorn 启动时，两步之间理论上存在竞态；
    对单机单用户场景可以接受。
    """
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((HOST, port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"从 {start} 起的连续 {attempts} 个端口都被占用")


WORKER_FLAG = "--b2t-worker"
"""打包运行时用同一个可执行文件兼作识别子进程的入口。

源码运行时子进程的命令是 ``python -m book2text.worker``（见 `core/project/executor.py`）；
打包之后没有"用源码跑模块"这条路，于是改成 ``<应用可执行文件> --b2t-worker ...``。
两条路都调用同一个 `worker.main`，行为一致。
"""


def _worker_arguments(argv: list[str]) -> list[str]:
    """把 `--b2t-worker` 摘掉，剩下的（`--project-dir` / `--job`）原样交给 worker。"""
    return [item for item in argv if item != WORKER_FLAG]


def _configure_stdio() -> None:
    """让控制台按 UTF-8 输出（说明书第 10 节）。

    Windows 控制台默认代码页不是 UTF-8，直接打印中文会抛 UnicodeEncodeError。
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass


def _print_banner(
    port: int,
    url: str,
    library: Path,
    supported: bool,
    unsupported_reason: str,
) -> None:
    probes = selfcheck.probe_engines()
    available = sum(1 for probe in probes if probe.available)

    print()
    print(
        f"Book2Text {__version__} — 识别、审校、导出、协作任务包与 macOS 打包已跑通"
        "（Windows 打包未验证；其余限制见界面「当前限制」）"
    )
    print(f"平台：{b2t_platform.platform_label()}")
    if not supported:
        print(f"  ✗ 该平台不受支持：{unsupported_reason}")
        print("    （说明书第 10 节只支持 macOS Apple Silicon 与 Windows x64；仍可继续诊断）")
    print(f"界面地址：{url}")
    print(f"项目库目录：{library}")
    print(f"引擎自检：{available}/{len(probes)} 可用（详情见界面「引擎自检」）")
    print("按 Ctrl+C 停止服务")
    print()
    # 输出重定向到文件时 stdout 是块缓冲的，不刷新会让 uvicorn 的日志
    # （走 stderr）跑到横幅前面，日志顺序会误导排查。
    sys.stdout.flush()


def _install_exit_handlers() -> None:
    """正常退出（含 Ctrl+C / 关窗口 / 关终端）时释放本进程持有的项目锁。

    SIGINT / SIGTERM 由 uvicorn 自己接（它做优雅关闭，`uvicorn.run` 返回后
    `main()` 的 `finally` 会释放），所以这里只管它不接的两个：SIGHUP（关终端）
    和 Windows 的 SIGBREAK。`atexit` 再兜一层：任何走到解释器退出的路径都会清锁；
    真被 SIGKILL / 断电的，靠 `lock.status()` 的"判死"，这也是那张表存在的原因。
    """
    atexit.register(lock_module.release_all)

    def _release_and_exit(signum: int, _frame: object) -> None:
        lock_module.release_all()
        raise SystemExit(128 + signum)

    for name in ("SIGHUP", "SIGBREAK"):
        handler = getattr(signal, name, None)
        if handler is None:
            continue
        try:
            signal.signal(handler, _release_and_exit)
        except (ValueError, OSError):
            # 不在主线程 / 平台不支持：atexit 与"判死"仍然兜得住
            continue


def _clean_previous_locks(library: Path) -> None:
    """启动时清掉**本机**残留的死锁（应用被强杀 / 重启后留下的）。

    用户 2026-10-27 撞上的就是这个：库里 11 个项目的锁，PID 全是死的，其中一批
    还带着这台机器以前的主机名。只清"同机（machine_id）+
    进程已不存在"的，别的电脑的锁不动（那是"可疑"，要用户确认）。
    """
    cleaned = lock_module.clean_stale_locks(library)
    stale = cleaned.get("removed") or []
    corrupt = cleaned.get("corrupt") or []
    if not stale and not corrupt:
        return
    parts = []
    if stale:
        parts.append(f"{len(stale)} 把本机残留的锁（进程已退出）")
    if corrupt:
        parts.append(f"{len(corrupt)} 个损坏的锁文件")
    print(f"已清理 {'、'.join(parts)}：{'、'.join([*stale, *corrupt])}")


def main(argv: list[str] | None = None) -> int:
    raw = list(argv if argv is not None else sys.argv[1:])

    # 打包运行时的识别子进程走同一个可执行文件：**在 argparse 之前**分派，
    # 因为 `--project-dir` / `--job` 是 worker 的参数，主解析器不认识它们
    # （第一版放在解析之后，子进程直接以 "unrecognized arguments" 退出）。
    if WORKER_FLAG in raw:
        from . import worker

        return worker.main(_worker_arguments(raw))

    parser = argparse.ArgumentParser(
        prog="book2text",
        description="Book2Text 本地服务",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"起始端口，被占用时自动向后尝试（默认 {DEFAULT_PORT}）",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="启动后不自动打开浏览器",
    )
    parser.add_argument(
        "--library",
        type=Path,
        default=None,
        help="项目库目录（缺省为用户「文稿 / 文档」下的 Book2Text）",
    )
    parser.add_argument(
        WORKER_FLAG,
        action="store_true",
        help="内部使用：以识别子进程的身份启动（打包运行时由主程序调用）",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="固定会话令牌（仅供测试与调试；默认每次启动随机生成）",
    )
    args = parser.parse_args(raw)

    _configure_stdio()

    supported, unsupported_reason = b2t_platform.is_supported_platform()

    port = find_free_port(args.port)
    token = args.token or secrets.token_urlsafe(32)
    url = f"http://{HOST}:{port}/?token={token}"

    library = args.library or default_library_dir()
    _install_exit_handlers()
    _clean_previous_locks(library)
    app = create_app(
        session_token=token, origins=allowed_origins(port), library_dir=library
    )

    _print_banner(port, url, library, supported, unsupported_reason)

    if not args.no_browser:
        opened, reason = b2t_platform.open_in_browser(url)
        if not opened:
            print(f"自动打开浏览器失败：{reason}")
            print("请手动复制上面的界面地址到浏览器打开。")

    try:
        uvicorn.run(app, host=HOST, port=port, log_level="info")
    except KeyboardInterrupt:
        pass
    finally:
        # uvicorn 收到 SIGTERM / SIGINT 会优雅关闭然后返回；走到这里说明服务真的停了，
        # 把还挂着的项目锁一起放掉，不要留给下一次启动去"判死"。
        released = lock_module.release_all()
        if released:
            print(f"已释放 {released} 个项目锁。")

    print("\nBook2Text 已停止。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
