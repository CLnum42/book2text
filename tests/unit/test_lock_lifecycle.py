"""项目锁的生命周期（任务 60）：判死、心跳、接管、启动清理。

2026-10-27 用户删项目被"另一台电脑"挡住，而那台电脑就是本机改了名、锁是应用被强杀后
留下的死锁。这一组用例把那张判定表逐行钉住，重点是三件事：

1. 同机（**machine_id 相同**，与主机名无关）+ 进程已死 → 过期，可以直接接管；
2. 跨机 + 心跳停了 → 过期，但**要用户确认**；心跳正常 → 真占用；
3. 真占用（另一个活进程）**不接受强制**——那是两台电脑同时写一个 SQLite 的前置条件。

机器身份是**持久化 UUID**（首次运行生成、存在库根），不是主机名、也不是硬件指纹：
主机名会改，硬件指纹在 CI runner 上每台都不同——两者都不能当"同一台机器"的判据。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from book2text.core.project import lock


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "b2t_LOCK01"
    directory.mkdir()
    return directory


@pytest.fixture
def live_process() -> object:
    """一个真的活着的进程（拿它的 pid 当"另一个窗口"）。"""
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        yield process.pid
    finally:
        process.kill()
        process.wait(timeout=5)


def write_lock(
    project_dir: Path,
    *,
    hostname: str,
    pid: int,
    acquired_at: str = "2026-01-01T00:00:00+00:00",
    heartbeat_at: str = "",
    machine_id: str | None = None,
) -> None:
    """造一把锁。

    `machine_id=None`（默认）⇒ 写成**本机**的 id（"造一把本机锁"，绝大多数用例要这个）；
    显式传 `""` ⇒ 真的没有 machine_id（老版本写的锁 ⇒ 未知机器）。
    """
    if machine_id is None:
        machine_id = lock.machine_id_for(project_dir.parent)
    payload = {
        "schema": 2 if machine_id else 1,
        "hostname": hostname,
        "pid": pid,
        "acquired_at": acquired_at,
        "heartbeat_at": heartbeat_at,
        "machine_id": machine_id,
    }
    lock.lock_path(project_dir).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def now_iso(seconds_ago: float = 0) -> str:
    from datetime import datetime, timedelta, timezone

    stamp = datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)
    return stamp.isoformat(timespec="seconds")


# ---------------------------------------------------------------- 同机

def test_same_machine_dead_process_is_stale(project_dir: Path) -> None:
    write_lock(project_dir, hostname=lock._hostname(), pid=999_999)

    status = lock.status(project_dir)

    assert status.state == lock.STATE_EXPIRED_SAME_MACHINE
    assert status.stale is True
    assert status.expired is True
    assert status.mine is False
    assert "过期" in status.describe()


def test_same_machine_live_process_is_held(
    project_dir: Path, live_process: int
) -> None:
    write_lock(project_dir, hostname=lock._hostname(), pid=live_process)

    status = lock.status(project_dir)

    assert status.state == lock.STATE_HELD
    assert status.held is True
    assert status.expired is False
    assert status.can_take_over is False
    assert str(live_process) in status.describe()


def test_own_pid_is_mine(project_dir: Path) -> None:
    write_lock(project_dir, hostname=lock._hostname(), pid=os.getpid())

    status = lock.status(project_dir)

    assert status.held is True
    assert status.mine is True


MACHINE_A = "11111111-1111-4111-8111-111111111111"
MACHINE_B = "22222222-2222-4222-8222-222222222222"


def _pin_machine_id(library_root: Path, machine_id: str) -> None:
    """把"本机 id"钉成测试想要的值（产品读同一个文件）。"""
    (library_root / lock.MACHINE_ID_FILE_NAME).write_text(machine_id, encoding="utf-8")


def test_same_machine_id_counts_as_stale_even_if_hostname_changed(
    project_dir: Path,
) -> None:
    """同 id + 主机名不同 ⇒ 本机旧锁，直接接管（判据只看 id，不看名字）。"""
    _pin_machine_id(project_dir.parent, MACHINE_A)
    write_lock(
        project_dir,
        hostname="Old-Name.local",
        pid=999_998,
        machine_id=MACHINE_A,
    )

    status = lock.status(project_dir)

    assert status.state == lock.STATE_EXPIRED_SAME_MACHINE
    assert status.same_machine is True
    assert status.can_take_over is True


def test_different_machine_id_is_other_machine(project_dir: Path) -> None:
    """异 id ⇒ 另一台电脑：心跳老了才算过期，且要用户确认（不是本机死锁）。"""
    _pin_machine_id(project_dir.parent, MACHINE_A)
    write_lock(
        project_dir,
        hostname=lock._hostname(),
        pid=999_998,
        machine_id=MACHINE_B,
    )

    status = lock.status(project_dir)

    assert status.state == lock.STATE_EXPIRED_OTHER_MACHINE
    assert status.same_machine is False
    assert status.stale is False
    assert status.machine_known is True


def test_legacy_lock_without_machine_id_is_unknown_machine(project_dir: Path) -> None:
    """老锁没有 machine_id ⇒ **未知机器**：只走心跳/超时，绝不自动接管。

    主机名一样也不算本机——名字是显示的，不是判据（改名 / CI runner 上会骗人）。
    """
    _pin_machine_id(project_dir.parent, MACHINE_A)
    write_lock(project_dir, hostname=lock._hostname(), pid=999_998, machine_id="")  # 老锁

    status = lock.status(project_dir)

    assert status.machine_known is False
    assert status.same_machine is False
    assert status.stale is False, "老锁不许被当成「本机死锁」直接清掉"
    # 心跳过期 ⇒ 仍走"过期"这条路（要用户确认），不是永久 held
    assert status.state == lock.STATE_EXPIRED_OTHER_MACHINE
    assert status.can_take_over is True


# ---------------------------------------------------------------- 跨机

def test_foreign_lock_with_fresh_heartbeat_is_held(project_dir: Path) -> None:
    write_lock(
        project_dir,
        hostname="Old-PC.local", machine_id=MACHINE_B,
        pid=44729,
        acquired_at=now_iso(120),
        heartbeat_at=now_iso(30),
    )

    status = lock.status(project_dir)

    assert status.state == lock.STATE_HELD
    assert status.can_take_over is False
    assert "另一台电脑" in status.describe()


def test_foreign_lock_with_old_heartbeat_is_expired(project_dir: Path) -> None:
    write_lock(
        project_dir,
        hostname="Old-PC.local", machine_id=MACHINE_B,
        pid=44729,
        acquired_at=now_iso(12 * 86400),
        heartbeat_at=now_iso(12 * 86400),
    )

    status = lock.status(project_dir)

    assert status.state == lock.STATE_EXPIRED_OTHER_MACHINE
    assert status.expired is True
    assert status.can_take_over is True
    assert "过期" in status.describe()
    assert "另一台电脑" in status.describe()
    assert "12 天" in status.describe()


def test_heartbeat_at_wins_over_file_mtime(project_dir: Path) -> None:
    """网盘同步会把 mtime 刷成"现在"，判死必须看 `heartbeat_at`。"""
    write_lock(
        project_dir,
        hostname="Old-PC.local", machine_id=MACHINE_B,
        pid=44729,
        acquired_at=now_iso(12 * 86400),
        heartbeat_at=now_iso(12 * 86400),
    )
    os.utime(lock.lock_path(project_dir), None)  # 刚"同步"过

    status = lock.status(project_dir)

    assert status.state == lock.STATE_EXPIRED_OTHER_MACHINE


def test_lock_without_heartbeat_falls_back_to_acquired_at(project_dir: Path) -> None:
    write_lock(
        project_dir, hostname="Old-PC.local", machine_id=MACHINE_B, pid=44729, acquired_at=now_iso(3600)
    )

    status = lock.status(project_dir)

    assert status.state == lock.STATE_EXPIRED_OTHER_MACHINE


# ---------------------------------------------------------------- 心跳 / 释放

def test_heartbeat_keeps_refreshing(project_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lock, "HEARTBEAT_INTERVAL_SECONDS", 0.2)
    try:
        lock.acquire(project_dir)
        first = lock.read_lock(project_dir)
        assert first is not None
        time.sleep(1.5)
        second = lock.read_lock(project_dir)
        assert second is not None
        assert second.heartbeat_at != first.heartbeat_at
        assert second.acquired_at == first.acquired_at, "心跳不能改写拿锁时间"
    finally:
        lock.release(project_dir)


def test_acquire_writes_machine_fingerprint(project_dir: Path) -> None:
    info = lock.acquire(project_dir)
    try:
        stored = lock.read_lock(project_dir)
        assert stored is not None
        assert stored.machine_id == info.machine_id
        assert stored.heartbeat_at
    finally:
        lock.release(project_dir)


def test_release_refuses_someone_elses_live_lock(project_dir: Path, live_process: int) -> None:
    write_lock(project_dir, hostname=lock._hostname(), pid=live_process)

    assert lock.release(project_dir) is False
    assert lock.lock_path(project_dir).is_file()


def test_release_clears_a_dead_local_lock(project_dir: Path) -> None:
    write_lock(project_dir, hostname=lock._hostname(), pid=999_997)

    assert lock.release(project_dir) is True
    assert not lock.lock_path(project_dir).is_file()


def test_release_all_drops_every_lock_this_process_holds(project_dir: Path) -> None:
    other = project_dir.parent / "b2t_LOCK02"
    other.mkdir()
    lock.acquire(project_dir)
    lock.acquire(other)

    assert lock.release_all() >= 2
    assert not lock.lock_path(project_dir).is_file()
    assert not lock.lock_path(other).is_file()


# ---------------------------------------------------------------- 启动清理

def test_clean_stale_locks_removes_local_dead_and_corrupt(tmp_path: Path) -> None:
    library = tmp_path / "lib"
    dead = library / "b2t_DEAD01"
    corrupt = library / "b2t_BAD001"
    foreign = library / "b2t_FAR001"
    live = library / "b2t_LIVE01"
    for directory in (dead, corrupt, foreign, live):
        directory.mkdir(parents=True)
    write_lock(dead, hostname=lock._hostname(), pid=999_996)
    lock.lock_path(corrupt).write_text("{ 半个 json", encoding="utf-8")
    write_lock(
        foreign,
        hostname="Old-PC.local", machine_id=MACHINE_B,
        pid=44729,
        acquired_at=now_iso(12 * 86400),
        heartbeat_at=now_iso(12 * 86400),
    )

    cleaned = lock.clean_stale_locks(library)

    assert cleaned["removed"] == [dead.name]
    assert cleaned["corrupt"] == [corrupt.name]
    assert not lock.lock_path(dead).is_file()
    assert not lock.lock_path(corrupt).is_file()
    assert lock.lock_path(foreign).is_file(), "别的电脑的锁不能偷偷清"


def test_status_of_missing_or_corrupt_lock_is_free(project_dir: Path) -> None:
    assert lock.status(project_dir).state == lock.STATE_FREE

    lock.lock_path(project_dir).write_text("not json", encoding="utf-8")

    assert lock.status(project_dir).state == lock.STATE_FREE
    assert lock.read_lock(project_dir) is None


def test_detail_payload_is_machine_readable(project_dir: Path) -> None:
    write_lock(
        project_dir,
        hostname="Old-PC.local", machine_id=MACHINE_B,
        pid=44729,
        acquired_at=now_iso(12 * 86400),
        heartbeat_at=now_iso(12 * 86400),
    )

    detail = lock.status(project_dir).detail()

    assert detail["state"] == lock.STATE_EXPIRED_OTHER_MACHINE
    assert detail["expired"] is True
    assert detail["can_take_over"] is True
    assert detail["host_note"] == "另一台电脑"
    assert detail["age_seconds"] >= 11 * 86400
    assert "过期" in str(detail["reason"])
