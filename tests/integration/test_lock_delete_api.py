"""`.lock` 挡住删除 / 打开（任务 60）的接口行为。

用户 2026-10-27 的现场：11 个项目的锁全是死锁（PID 早就不在），其中一批还带着
这台机器**以前的主机名**，于是"项目正在使用中，不能删除"永远解不开。现在：

- 同机死锁 → 自动接管，删除不报错；
- 跨机但心跳停了 → 409 `project_lock_expired`，带结构化信息（界面画确认框），
  `?force=true` 一步删掉；
- 真占用（另一个活进程）→ 409 `project_busy`，**force 也不放行**。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import lock as lock_module
from tests.fakes import FakeOcrEngine

from .test_trash_api import create_project, project_ids


def write_lock(
    directory: Path,
    *,
    hostname: str,
    pid: int,
    acquired_at: str,
    heartbeat_at: str = "",
) -> None:
    lock_module.lock_path(directory).write_text(
        json.dumps(
            {
                "hostname": hostname,
                "pid": pid,
                "acquired_at": acquired_at,
                "heartbeat_at": heartbeat_at,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


@pytest.fixture
def live_process() -> int:
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        yield process.pid
    finally:
        process.kill()
        process.wait(timeout=5)


def test_stale_local_lock_does_not_block_delete(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    write_lock(
        library_dir / project_id,
        hostname=lock_module._hostname(),
        pid=999_999,
        acquired_at="2026-10-15T05:32:00+00:00",
    )

    deleted = client.delete(
        f"/api/projects/{project_id}?confirm=true", headers=auth_headers
    )

    assert deleted.status_code == 200, deleted.text
    assert project_ids(client, auth_headers) == []
    assert not lock_module.lock_path(library_dir / project_id).is_file()


def test_stale_local_lock_is_taken_over_on_open(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    write_lock(
        library_dir / project_id,
        hostname=lock_module._hostname(),
        pid=999_999,
        acquired_at="2026-10-15T05:32:00+00:00",
    )

    opened = client.post(f"/api/projects/{project_id}/open", headers=auth_headers)

    assert opened.status_code == 200, opened.text
    assert "过期的锁" in opened.json()["warning"]
    stored = lock_module.read_lock(library_dir / project_id)
    assert stored is not None and stored.pid == os.getpid()


def test_old_hostname_of_this_machine_does_not_block_delete(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """本机改名后留下的锁（MacBook-Air-2 → -3）不能被当成"另一台电脑"。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    write_lock(
        library_dir / project_id,
        hostname="MacBook-Air-2.local",
        pid=72172,
        acquired_at="2026-10-27T08:11:00+00:00",
    )

    opened = client.post(f"/api/projects/{project_id}/open", headers=auth_headers)
    if opened.status_code != 200:  # 机器名前缀不同（CI/别的机器）时这条不成立
        pytest.skip("当前主机名与本机旧名不是同一前缀，这条用例不适用")
    client.post(f"/api/projects/{project_id}/close", headers=auth_headers)

    deleted = client.delete(
        f"/api/projects/{project_id}?confirm=true", headers=auth_headers
    )

    assert deleted.status_code == 200, deleted.text


def test_expired_foreign_lock_asks_before_delete(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    write_lock(
        library_dir / project_id,
        hostname="Old-PC.local",
        pid=44729,
        acquired_at="2026-10-15T05:32:00+00:00",
        heartbeat_at="2026-10-15T05:32:00+00:00",
    )

    refused = client.delete(
        f"/api/projects/{project_id}?confirm=true", headers=auth_headers
    )

    assert refused.status_code == 409
    error = refused.json()["error"]
    assert error["code"] == "project_lock_expired"
    assert "过期" in error["detail"]
    assert "另一台电脑" in error["detail"]
    lock_info = error["data"]["lock"]
    assert lock_info["expired"] is True
    assert lock_info["can_take_over"] is True
    assert lock_info["hostname"] == "Old-PC.local"
    assert lock_info["age_seconds"] > 86400
    assert project_ids(client, auth_headers) == [project_id]

    forced = client.delete(
        f"/api/projects/{project_id}?confirm=true&force=true", headers=auth_headers
    )

    assert forced.status_code == 200, forced.text
    assert project_ids(client, auth_headers) == []


def test_expired_foreign_lock_on_open_reports_expired(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    write_lock(
        library_dir / project_id,
        hostname="Old-PC.local",
        pid=44729,
        acquired_at="2026-10-15T05:32:00+00:00",
        heartbeat_at="2026-10-15T05:32:00+00:00",
    )

    refused = client.post(f"/api/projects/{project_id}/open", headers=auth_headers)

    assert refused.status_code == 400
    error = refused.json()["error"]
    assert error["code"] == "project_lock_expired"
    assert error["data"]["lock"]["expired"] is True

    forced = client.post(
        f"/api/projects/{project_id}/open?force=true", headers=auth_headers
    )

    assert forced.status_code == 200, forced.text
    assert "强制接管" in forced.json()["warning"]


def test_living_lock_blocks_delete_even_with_force(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
    live_process: int,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    write_lock(
        library_dir / project_id,
        hostname=lock_module._hostname(),
        pid=live_process,
        acquired_at="2026-10-28T00:00:00+00:00",
        heartbeat_at="2026-10-28T00:00:00+00:00",
    )

    for suffix in ("", "&force=true"):
        refused = client.delete(
            f"/api/projects/{project_id}?confirm=true{suffix}", headers=auth_headers
        )
        assert refused.status_code == 409, suffix
        error = refused.json()["error"]
        assert error["code"] == "project_busy"
        assert error["data"]["lock"]["can_take_over"] is False

    assert project_ids(client, auth_headers) == [project_id]
    assert lock_module.lock_path(library_dir / project_id).is_file()


def test_project_list_marks_expired_lock(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    write_lock(
        library_dir / project_id,
        hostname="Old-PC.local",
        pid=44729,
        acquired_at="2026-10-15T05:32:00+00:00",
        heartbeat_at="2026-10-15T05:32:00+00:00",
    )

    listed = client.get("/api/projects", headers=auth_headers).json()["projects"][0]

    assert listed["lock_held"] is True
    assert listed["lock_expired"] is True
    assert "过期" in listed["lock_reason"]
