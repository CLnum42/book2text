"""项目锁（说明书 7.6）。

打开项目时在项目文件夹写入 `.lock`（schema 版本、机器 id、主机名、进程号、时间、心跳）。
**用途是防止网盘同步的文件夹被两台电脑同时编辑**，不是权限系统。

## 为什么要有"判死"

2026-10-27 用户删项目时被挡住，报"该项目正被另一台电脑使用：<本机的旧主机名>"，
可那台"电脑"就是本机——系统给它改了名。库里 11 个项目的锁全是
被强杀 / 重启后留下的死锁（PID 早就不在了），旧代码只看"锁文件存在 + 主机名不同"，
于是同一台机器的旧锁变成了永远解不开的"另一台电脑"。

现在的判定分层，越往下越保守：

==============  ========================================  ==========================
情况            判据                                      结果
==============  ========================================  ==========================
没有锁 / 损坏    —                                         free（可打开；损坏文件会被清）
同一台机器      **machine_id 相同**（与主机名无关）       看进程：活着 → held，死了 → 过期
另一台电脑      id 不同                                  看心跳：10 分钟内 → held，更久 → 过期
未知机器        锁文件没有 machine_id（老版本写的）        只走心跳；过期也**不自动接管**
==============  ========================================  ==========================

"过期"不等于"没锁"：同机过期可以**直接接管**（进程都没了，没什么可保护的）；
跨机器 / 未知机器的过期只是"可疑"（心跳可能只是网盘没同步过来），**要用户确认一次**才接管。

## 机器身份为什么是持久 UUID

2026-11 之前判"同机"用的是**主机名前缀启发式**（去掉名字末尾的 `-2 / -3` 再比），
那是把开发机的历史写进了产品判据：换一台机器就判错，CI runner 上必然红。
硬件指纹（IOPlatformUUID / MachineGuid）也不行——CI runner 每台都不同，同样不是"同一台机器"。

现在：首次运行时生成一个 uuid4，存在项目库根目录的 `.machine_id`（跟着现有的数据目录走，
不新增位置），**独立随机、与主机名和硬件无关**。判"同机"只比这个 id；
主机名只用来显示（"该项目正被另一台电脑使用：xxx.local"）。

## 心跳

持锁期间每 `HEARTBEAT_INTERVAL_SECONDS` 秒刷新 `heartbeat_at`。这是跨机器判死的唯一
依据：对方被强杀后不会再写心跳，10 分钟后这把锁就会被判为过期。

## 生命周期

- 正常关闭项目 / 正常退出应用 → 删锁（`release` / `release_all`，`main.py` 用
  `atexit` + `finally` 兜住 SIGINT / SIGTERM）。
- 应用启动 → `clean_stale_locks` 扫一遍库，把**本机死进程**留下的锁直接清掉，
  别等用户撞上（用户那次就是攒了 11 个）。
- 被 SIGKILL / 断电 → 靠上面的"判死"。
"""

from __future__ import annotations

import atexit
import json
import os
import threading
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

LOCK_FILE_NAME = ".lock"

MACHINE_ID_FILE_NAME = ".machine_id"
"""机器身份文件：项目库根目录下，内容是首次运行生成的 uuid4（纯随机，与主机名/硬件无关）。"""

LOCK_SCHEMA_VERSION = 2
"""锁文件结构版本。1 = 老版本（只有主机名，没有 machine_id）。"""

HEARTBEAT_INTERVAL_SECONDS = 60
"""持锁期间多久刷一次心跳（秒）。"""

HEARTBEAT_TIMEOUT_SECONDS = 600
"""跨机器判为"心跳已停"的阈值（秒）。说明书建议 10 分钟：够容忍网盘延迟，
又不至于让一台已经关机的电脑把项目挡上一整天。"""

STATE_FREE = "free"
STATE_HELD = "held"
STATE_EXPIRED_SAME_MACHINE = "expired_same_machine"
STATE_EXPIRED_OTHER_MACHINE = "expired_other_machine"


@dataclass(frozen=True)
class LockInfo:
    hostname: str
    pid: int
    acquired_at: str
    heartbeat_at: str = ""
    machine_id: str = ""
    """上锁那台机器的**持久 UUID**（项目库根 `.machine_id` 的内容）。
    空 = 老版本写的锁（未知机器）：只走心跳/超时，绝不自动接管。"""
    schema: int = 1
    """锁文件结构版本；1 = 老版本（没有 machine_id）。"""

    def to_dict(self) -> dict[str, object]:
        return {
            "schema": self.schema,
            "hostname": self.hostname,
            "pid": self.pid,
            "acquired_at": self.acquired_at,
            "heartbeat_at": self.heartbeat_at,
            "machine_id": self.machine_id,
        }

    @property
    def last_seen_at(self) -> str:
        """最后一次能证明持有者还活着的时间。"""
        return self.heartbeat_at or self.acquired_at


@dataclass(frozen=True)
class LockStatus:
    """锁的当前状态。"""

    state: str
    info: LockInfo | None = None
    mine: bool = False
    """是不是**本进程**自己上的锁。"""
    same_machine: bool = False
    """是否确认是本机（machine_id 相同；主机名不参与判定）。"""
    machine_known: bool = True
    """锁文件里有没有可信的机器身份。False = 老锁（没有 machine_id）⇒ 未知机器，不自动接管。"""
    process_alive: bool | None = None
    """本机进程是否还在（只对"同机 / 本机旧名字"有意义）。"""
    age_seconds: float | None = None
    reason: str = ""

    @property
    def held(self) -> bool:
        """是否应视为"正被占用"（含另一台电脑心跳正常、以及本进程自己开着）。"""
        return self.state == STATE_HELD

    @property
    def stale(self) -> bool:
        """本机遗留的失效锁（进程已不存在）——可以直接接管、启动时可直接清掉。"""
        return self.state == STATE_EXPIRED_SAME_MACHINE

    @property
    def expired(self) -> bool:
        """锁已过期（同机或跨机器）。过期锁要清掉才能写项目。"""
        return self.state in (STATE_EXPIRED_SAME_MACHINE, STATE_EXPIRED_OTHER_MACHINE)

    @property
    def can_take_over(self) -> bool:
        """能不能由调用方接管。过期的锁都可以；真占用的一律不行。"""
        return self.expired

    @property
    def age_text(self) -> str:
        if self.age_seconds is None:
            return ""
        return _human_age(self.age_seconds)

    def describe(self, *, current_host: str | None = None) -> str:
        """一句能让人判断"该怎么办"的说明。"""
        if self.info is None:
            return ""
        info = self.info
        when = _short_time(info.last_seen_at)
        age = self.age_text
        when_text = f"{when}，{age}" if when and age else (when or age or "时间未知")

        if self.state == STATE_HELD:
            if not self.machine_known:
                return (
                    f"该项目正被另一个 Book2Text 窗口使用"
                    f"（锁文件来自老版本，没有机器标识；进程 {info.pid}，{when_text}）"
                )
            if self.same_machine:
                return (
                    f"该项目正被另一个 Book2Text 窗口使用"
                    f"（进程 {info.pid}，{when_text}）"
                )
            return f"该项目正被另一台电脑使用：{info.hostname}（{when_text}）"

        if self.state == STATE_EXPIRED_SAME_MACHINE:
            origin = "本机，"
            return (
                f"锁已过期：{origin}进程 {info.pid} 已经不存在"
                f"（{when_text}），可以直接接管"
            )

        if self.state == STATE_EXPIRED_OTHER_MACHINE:
            span = _human_span(self.age_seconds)
            if span:
                return (
                    f"锁看起来已过期：来自另一台电脑 {info.hostname}"
                    f"（{when_text}），已经 {span}没有更新过心跳，可以强制接管"
                )
            return (
                f"锁看起来已过期：来自另一台电脑 {info.hostname}"
                f"（{when_text}），很久没有更新过心跳，可以强制接管"
            )
        return ""

    def detail(self) -> dict[str, object]:
        """给界面的结构化信息：让用户自己判断"这锁该不该清"。"""
        info = self.info
        if info is None:
            return {"state": self.state}
        if not self.machine_known:
            host_note = "老版本锁（没有机器标识）"
        elif self.same_machine:
            host_note = "本机"
        else:
            host_note = "另一台电脑"
        return {
            "state": self.state,
            "expired": self.expired,
            "can_take_over": self.can_take_over,
            "hostname": info.hostname,
            "host_note": host_note,
            "pid": info.pid,
            "process_alive": self.process_alive,
            "acquired_at": info.acquired_at,
            "last_seen_at": info.last_seen_at,
            "age_seconds": int(self.age_seconds) if self.age_seconds is not None else None,
            "age_text": self.age_text,
            "reason": self.describe(),
        }


def lock_path(project_dir: Path) -> Path:
    return project_dir / LOCK_FILE_NAME


def _registry_key(project_dir: Path) -> Path:
    """登记表用的键：同一个目录不管传相对还是绝对路径都是同一个键。"""
    try:
        return lock_path(project_dir).resolve()
    except OSError:
        return lock_path(project_dir).absolute()


def _hostname() -> str:
    name = (
        os.uname().nodename
        if hasattr(os, "uname")
        else os.environ.get("COMPUTERNAME", "unknown")
    )
    return name or "unknown"


def machine_id_for(library_root: Path) -> str:
    """本机的机器身份（持久 UUID）。

    首次运行在**项目库根目录**写 `.machine_id`（跟着现有的数据目录走，不新增位置），
    之后每次读同一个值。**纯随机 uuid4**：与主机名、MAC、硬件指纹都无关——
    从任何一台机器能推出来的东西都不能当"同一台机器"的判据（改名会假换机，
    CI runner 会真换机）。

    读不出来（权限 / 只读盘）就返回空串：那种情况下判"同机"一律不成立（保守方向）。
    """
    path = library_root / MACHINE_ID_FILE_NAME
    try:
        existing = path.read_text(encoding="utf-8").strip()
    except OSError:
        existing = ""
    if existing:
        return existing
    generated = str(uuid.uuid4())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(generated, encoding="utf-8")
    except OSError:
        return ""
    return generated


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


def _parse_time(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _human_span(seconds: float | None) -> str:
    """时长（不带"前"）：`12 天`、`5 小时`、`20 分钟`。"""
    if seconds is None:
        return ""
    if seconds < 60:
        return "不到 1 分钟"
    minutes = int(seconds // 60)
    if minutes < 60:
        return f"{minutes} 分钟"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} 小时"
    days = hours // 24
    if days < 30:
        return f"{days} 天"
    months = days // 30
    if months < 12:
        return f"{months} 个月"
    return f"{days // 365} 年"


def _human_age(seconds: float) -> str:
    if seconds < 0:
        return "刚刚"
    if seconds < 60:
        return "刚刚"
    minutes = int(seconds // 60)
    if minutes < 60:
        return f"{minutes} 分钟前"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} 小时前"
    days = hours // 24
    if days < 30:
        return f"{days} 天前"
    months = days // 30
    if months < 12:
        return f"{months} 个月前"
    return f"{days // 365} 年前"


def _short_time(value: str) -> str:
    parsed = _parse_time(value)
    if parsed is None:
        return ""
    return parsed.astimezone().strftime("%m-%d %H:%M")


def _lock_age_seconds(info: LockInfo, path: Path) -> float | None:
    """锁"最后一次活动"距今多少秒。

    心跳是权威（网盘同步会把 mtime 刷新成"现在"，但改不了 `heartbeat_at`）；
    老锁没有心跳字段才退回文件 mtime，再退回 `acquired_at`。
    """
    now = datetime.now(timezone.utc)
    parsed = _parse_time(info.last_seen_at)
    if parsed is not None:
        return max(0.0, (now - parsed).total_seconds())
    try:
        return max(0.0, now.timestamp() - path.stat().st_mtime)
    except OSError:
        return None


def read_lock(project_dir: Path) -> LockInfo | None:
    """读锁文件。不存在或损坏都返回 None（损坏等同"上次异常退出留下的"）。"""
    path = lock_path(project_dir)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    try:
        return LockInfo(
            schema=int(payload.get("schema") or 1),
            hostname=str(payload["hostname"]),
            pid=int(payload["pid"]),
            acquired_at=str(payload.get("acquired_at") or ""),
            heartbeat_at=str(payload.get("heartbeat_at") or ""),
            machine_id=str(payload.get("machine_id") or ""),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _write_lock(path: Path, info: LockInfo) -> None:
    """原子写锁（先写临时文件再 rename），读的人不会读到半个 JSON。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(info.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def _is_same_machine(info: LockInfo, local_machine_id: str) -> bool:
    """判"同机"：**只比 machine_id**。主机名只用于显示，不参与判定。

    锁里没有 machine_id（老版本）⇒ 一律不算同机（未知机器，走心跳）。
    """
    if not info.machine_id or not local_machine_id:
        return False
    return info.machine_id == local_machine_id


def status(project_dir: Path) -> LockStatus:
    """判断项目当前是否被占用。见模块开头那张表。"""
    path = lock_path(project_dir)
    info = read_lock(project_dir)
    if info is None:
        return LockStatus(state=STATE_FREE)

    local_machine_id = machine_id_for(project_dir.parent)
    machine_known = bool(info.machine_id)
    same_machine = _is_same_machine(info, local_machine_id)
    local_process = same_machine
    alive = _process_alive(info.pid) if local_process else None
    age = _lock_age_seconds(info, path)

    if local_process:
        if alive:
            return LockStatus(
                state=STATE_HELD,
                info=info,
                mine=same_machine and info.pid == os.getpid(),
                same_machine=same_machine,
                machine_known=machine_known,
                process_alive=True,
                age_seconds=age,
            )
        return LockStatus(
            state=STATE_EXPIRED_SAME_MACHINE,
            info=info,
            same_machine=same_machine,
            machine_known=machine_known,
            process_alive=False,
            age_seconds=age,
        )

    fresh = age is not None and age < HEARTBEAT_TIMEOUT_SECONDS
    if fresh:
        return LockStatus(
            state=STATE_HELD,
            info=info,
            same_machine=False,
            machine_known=machine_known,
            process_alive=None,
            age_seconds=age,
        )
    return LockStatus(
        state=STATE_EXPIRED_OTHER_MACHINE,
        info=info,
        same_machine=False,
        machine_known=machine_known,
        process_alive=None,
        age_seconds=age,
    )


# ---------------------------------------------------------------- 心跳

_held_locks: dict[Path, LockInfo] = {}
"""本进程持有的锁：锁文件路径 → 最后写入的 LockInfo。"""
_registry_guard = threading.Lock()
_heartbeat_thread: threading.Thread | None = None
_heartbeat_stop = threading.Event()


def _heartbeat_loop() -> None:
    while not _heartbeat_stop.wait(HEARTBEAT_INTERVAL_SECONDS):
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with _registry_guard:
            items = list(_held_locks.items())
        for path, info in items:
            current = read_lock(path.parent)
            # 锁已经不是我们的了（被清理 / 被接管）→ 不再刷，免得把别人的锁改回来
            if current is None or current.pid != info.pid or current.hostname != info.hostname:
                with _registry_guard:
                    _held_locks.pop(path, None)
                continue
            updated = replace(info, heartbeat_at=now)
            try:
                _write_lock(path, updated)
            except OSError:
                continue
            with _registry_guard:
                if path in _held_locks:
                    _held_locks[path] = updated


def _ensure_heartbeat() -> None:
    global _heartbeat_thread
    with _registry_guard:
        if _heartbeat_thread is not None and _heartbeat_thread.is_alive():
            return
        _heartbeat_stop.clear()
        _heartbeat_thread = threading.Thread(
            target=_heartbeat_loop, name="b2t-lock-heartbeat", daemon=True
        )
        _heartbeat_thread.start()


def acquire(project_dir: Path) -> LockInfo:
    """写入锁文件（并开始刷新心跳）。调用方应先检查 `status()`。"""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    info = LockInfo(
        schema=LOCK_SCHEMA_VERSION,
        hostname=_hostname(),
        pid=os.getpid(),
        acquired_at=now,
        heartbeat_at=now,
        machine_id=machine_id_for(project_dir.parent),
    )
    path = lock_path(project_dir)
    _write_lock(path, info)
    with _registry_guard:
        _held_locks[_registry_key(project_dir)] = info
    _ensure_heartbeat()
    return info


def release(project_dir: Path, *, force: bool = False) -> bool:
    """删除锁文件。返回是否真的删掉了。

    默认只删**自己的锁**，或**本机已经没进程的过期锁**；别的机器 / 别的活进程的锁
    一律不动（`force=True` 由"用户确认接管过期锁"的流程显式传入）。
    """
    path = lock_path(project_dir)
    key = _registry_key(project_dir)
    if not path.is_file():
        with _registry_guard:
            _held_locks.pop(key, None)
        return False
    info = read_lock(project_dir)
    if info is not None and not force and info.pid != os.getpid():
        if not status(project_dir).stale:
            return False
    try:
        path.unlink()
    except OSError:
        return False
    with _registry_guard:
        _held_locks.pop(key, None)
    return True


def release_all() -> int:
    """释放本进程持有的**全部**锁（正常退出时用）。返回删掉的个数。"""
    with _registry_guard:
        paths = list(_held_locks)
        _held_locks.clear()
    _heartbeat_stop.set()
    removed = 0
    for path in paths:
        try:
            if path.is_file():
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def held_projects() -> list[Path]:
    """本进程当前持有锁的项目目录（诊断用）。"""
    with _registry_guard:
        return sorted({path.parent for path in _held_locks})


atexit.register(release_all)


# ---------------------------------------------------------------- 启动清理

def clean_stale_locks(library: Path) -> dict[str, list[str]]:
    """清掉本机残留的死锁（应用启动时调一次）。

    只清两类：**同机（machine_id 相同）+ 进程不存在**，以及**损坏到读不出来的锁**。
    别的机器的锁不管新旧都不碰——那是"可疑"，要用户确认。
    """
    removed: list[str] = []
    corrupt: list[str] = []
    if not library.is_dir():
        return {"removed": removed, "corrupt": corrupt}
    for entry in library.iterdir():
        if not entry.is_dir():
            continue
        path = lock_path(entry)
        if not path.is_file():
            continue
        info = read_lock(entry)
        if info is None:
            # 损坏的锁文件：谁也读不懂，留着只会让下次删除再报一次怪错
            try:
                path.unlink()
                corrupt.append(entry.name)
            except OSError:
                pass
            continue
        if status(entry).stale:
            try:
                path.unlink()
                removed.append(entry.name)
            except OSError:
                pass
    return {"removed": removed, "corrupt": corrupt}
