"""项目锁（说明书 7.6）。

打开项目时在项目文件夹写入 `.lock`（主机名、进程号、时间）。
**用途是防止网盘同步的文件夹被两台电脑同时编辑**，不是权限系统。

判定规则：

- 锁不存在 → 可用。
- 锁属于**别的机器** → 视为占用（无法验证对方是否还在运行，宁可保守）。
- 锁属于**本机**且进程仍在 → 占用。
- 锁属于**本机**但进程已不在 → **失效**（上次异常退出留下的），可覆盖。

保守方向的选择理由：说明书 1.4 的决策优先级里"不丢失用户数据"排第一。
误判为"被占用"只是多问一句，误判为"空闲"则可能让两台电脑同时写入同一个数据库。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

LOCK_FILE_NAME = ".lock"


@dataclass(frozen=True)
class LockInfo:
    hostname: str
    pid: int
    acquired_at: str

    def to_dict(self) -> dict[str, object]:
        return {"hostname": self.hostname, "pid": self.pid, "acquired_at": self.acquired_at}


@dataclass(frozen=True)
class LockStatus:
    """锁的当前状态。"""

    held: bool                    # 是否应视为"被别人占用"
    stale: bool                   # 是否为本机遗留的失效锁
    info: LockInfo | None
    reason: str = ""              # 被占用时的说明

    def describe(self, *, current_host: str | None = None) -> str:
        if not self.held or self.info is None:
            return ""
        if current_host is None:
            current_host = _hostname()
        if self.info.hostname != current_host:
            return f"该项目正被另一台电脑使用：{self.info.hostname}（{self.info.acquired_at}）"
        return (
            f"该项目正被另一个 Book2Text 窗口使用"
            f"（进程 {self.info.pid}，{self.info.acquired_at}）"
        )


def lock_path(project_dir: Path) -> Path:
    return project_dir / LOCK_FILE_NAME


def _hostname() -> str:
    return os.uname().nodename if hasattr(os, "uname") else os.environ.get("COMPUTERNAME", "unknown")


def _process_alive(pid: int) -> bool:
    """判断本机某个进程是否还在运行。

    跨平台的做法：向进程发信号 0。Windows 上 `os.kill` 对不存在的进程会抛 OSError，
    行为与 POSIX 一致（PowerShell 下也一样——Python 的 os.kill 在 Windows 上
    对 pid 0 信号会调用 OpenProcess）。
    """
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # 进程存在但不属于当前用户
        return True
    except OSError:
        return False
    return True


def read_lock(project_dir: Path) -> LockInfo | None:
    path = lock_path(project_dir)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # 锁文件损坏：当作最后一次异常退出留下的
        return None
    try:
        return LockInfo(
            hostname=str(payload["hostname"]),
            pid=int(payload["pid"]),
            acquired_at=str(payload["acquired_at"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def status(project_dir: Path) -> LockStatus:
    """判断项目当前是否被占用。"""
    info = read_lock(project_dir)
    if info is None:
        return LockStatus(held=False, stale=False, info=None)

    if info.hostname != _hostname():
        return LockStatus(held=True, stale=False, info=info)

    if _process_alive(info.pid):
        return LockStatus(held=True, stale=False, info=info)

    return LockStatus(held=False, stale=True, info=info)


def acquire(project_dir: Path) -> LockInfo:
    """写入锁文件。调用方应先检查 `status()`。"""
    info = LockInfo(
        hostname=_hostname(),
        pid=os.getpid(),
        acquired_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    project_dir.mkdir(parents=True, exist_ok=True)
    lock_path(project_dir).write_text(
        json.dumps(info.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return info


def release(project_dir: Path) -> bool:
    """删除锁文件。返回是否真的删掉了。"""
    path = lock_path(project_dir)
    if not path.is_file():
        return False
    path.unlink()
    return True
