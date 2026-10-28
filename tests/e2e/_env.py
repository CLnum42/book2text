"""QA 隔离环境：从干净的源复制项目库 → 起一个独立服务 → 收尾时全部拆掉。

设计约束（都是被真实事故逼出来的）：

1. **每次从源复制，绝不复用被改过的副本**。上一轮测试改过的块不会漏到下一轮。
2. **数据库用 sqlite backup API 复制**，不是 `cp`：用户的应用可能正在写库，
   直接拷贝文件可能拿到撕裂的 WAL。
3. **独立端口 + 固定令牌**：不碰用户正在用的 8765，也不依赖随机令牌去猜。
4. 临时目录固定落在系统 temp 下的 `b2t-qa-*`，`down` 只删这个前缀，不会误删别处。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(os.environ.get("B2T_QA_REPO") or Path(__file__).resolve().parents[2])
PYTHON = REPO_ROOT / ".venv" / "bin" / "python"
if not PYTHON.is_file():  # pragma: no cover - 只在没建 venv 的机器上走到
    PYTHON = Path(sys.executable)

DEFAULT_LIBRARY = Path.home() / "Documents" / "Book2Text"
RUNTIME_ROOT = Path(tempfile.gettempdir()) / "b2t-qa"
CURRENT_POINTER = RUNTIME_ROOT / "current.json"

_SAFE_RUN_PREFIX = "b2t-qa-"


def _check_under_runtime(path: Path) -> Path:
    """删除/写入前必须先证明路径在 QA 临时根下（防止拼错路径删到用户数据）。"""
    resolved = path.resolve()
    root = RUNTIME_ROOT.resolve()
    if root not in resolved.parents and resolved != root:
        raise RuntimeError(f"拒绝操作临时根之外的路径：{resolved}")
    return resolved


def _free_port(start: int = 18765) -> int:
    for port in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"从 {start} 起连续 40 个端口都被占用")


def _copy_project(project_id: str, library: Path) -> Path:
    """把一个项目复制到临时库里。项目数据库用 backup API，其余文件原样拷。"""
    source = DEFAULT_LIBRARY / project_id
    if not (source / "project.db").is_file():
        raise FileNotFoundError(f"找不到项目：{source}")
    library.mkdir(parents=True, exist_ok=True)
    target = library / project_id
    shutil.copytree(
        source,
        target,
        ignore=shutil.ignore_patterns("project.db", "project.db-wal", "project.db-shm"),
    )
    with sqlite3.connect(f"file:{source / 'project.db'}?mode=ro", uri=True) as src:
        with sqlite3.connect(target / "project.db") as dst:
            src.backup(dst)
    return target


def _tail(path: Path, lines: int = 30) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return ""


def start(
    *,
    project_id: str,
    library_root: Path = DEFAULT_LIBRARY,
    port: int | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    """复制项目 → 起服务 → 等它就绪。返回可直接写进 state 的字典。"""
    global DEFAULT_LIBRARY
    DEFAULT_LIBRARY = library_root

    run_id = time.strftime("%Y%m%d-%H%M%S") + f"-{os.getpid()}"
    run_dir = _check_under_runtime(RUNTIME_ROOT / f"{_SAFE_RUN_PREFIX}{run_id}")
    (run_dir / "library").mkdir(parents=True)
    (run_dir / "screenshots").mkdir()

    project_copy = _copy_project(project_id, run_dir / "library")
    # 用户设置（名字）跟着库走。不拷的话首次运行卡片会挡住界面，
    # 而 QA 要验的是工作流，不是"第一次运行"的引导。
    settings = library_root / ".settings.json"
    if settings.is_file():
        shutil.copy2(settings, run_dir / "library" / ".settings.json")
    chosen_port = port or _free_port()
    chosen_token = token or f"qa-{run_id}"
    log_path = run_dir / "server.log"

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    # 默认用仓库工作区；B2T_QA_REPO 指向 git worktree 时可以精确测某个提交，
    # 不被别人未提交的改动污染（本轮 HEAD=90d96fc，工作区有未提交改动）。
    env["PYTHONPATH"] = str(REPO_ROOT / "backend") + (
        os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
    )
    command = [
        str(PYTHON),
        "-c",
        "from book2text.main import main; raise SystemExit(main())",
        "--library",
        str(run_dir / "library"),
        "--token",
        chosen_token,
        "--port",
        str(chosen_port),
        "--no-browser",
    ]
    log_file = log_path.open("wb")
    process = subprocess.Popen(
        command,
        cwd=REPO_ROOT,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    deadline = time.monotonic() + 90
    actual_port = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"服务启动失败（退出码 {process.returncode}）：\n{_tail(log_path)}")
        try:
            text = log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        match = re.search(r"界面地址：http://127\.0\.0\.1:(\d+)/\?token=", text)
        if match:
            actual_port = int(match.group(1))
            break
        time.sleep(0.05)
    if actual_port is None:
        process.terminate()
        raise RuntimeError(f"90 秒内没等到服务就绪：\n{_tail(log_path)}")

    state = {
        "run_id": run_id,
        "run_dir": str(run_dir),
        "library": str(run_dir / "library"),
        "project_id": project_id,
        "source_project": str(library_root / project_id),
        "port": actual_port,
        "token": chosen_token,
        # checktext=1 打开应用自带的「右栏显示 = 导出段文本」自检
        "url": f"http://127.0.0.1:{actual_port}/?token={chosen_token}&checktext=1",
        "base_url": f"http://127.0.0.1:{actual_port}",
        "pid": process.pid,
        "log": str(log_path),
        "space": f"b2t-qa-{run_id}",
        "screenshots": str(run_dir / "screenshots"),
    }
    (run_dir / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2))
    CURRENT_POINTER.parent.mkdir(parents=True, exist_ok=True)
    CURRENT_POINTER.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    return state


def load_state() -> dict[str, Any]:
    if not CURRENT_POINTER.is_file():
        raise RuntimeError("没有正在运行的 QA 环境；先执行 `qa.py up`")
    state = json.loads(CURRENT_POINTER.read_text())
    if not _process_alive(int(state["pid"])):
        raise RuntimeError(f"state 里的服务已不在（pid {state['pid']}）；执行 `qa.py down` 清理后再 up")
    return state


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop(*, remove: bool = True) -> dict[str, Any]:
    """关服务、删临时库。只处理临时根下、由本工具创建的目录。"""
    if not CURRENT_POINTER.is_file():
        return {"stopped": False, "reason": "没有 state"}
    state = json.loads(CURRENT_POINTER.read_text())
    pid = int(state["pid"])
    killed = False
    if _process_alive(pid):
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and _process_alive(pid):
            time.sleep(0.1)
        if _process_alive(pid):
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)
            killed = True

    removed = False
    run_dir = _check_under_runtime(Path(state["run_dir"]))
    if remove and run_dir.name.startswith(_SAFE_RUN_PREFIX) and run_dir.is_dir():
        shutil.rmtree(run_dir)
        removed = True
    CURRENT_POINTER.unlink(missing_ok=True)
    return {
        "stopped": True,
        "pid": pid,
        "forced": killed,
        "removed": removed,
        "run_dir": str(run_dir),
    }
