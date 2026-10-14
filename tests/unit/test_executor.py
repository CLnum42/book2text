"""识别子进程的执行器（说明书 Phase 2 的"Job 执行器（子进程）"）。

这里的"子进程"是**假命令**（`python -c "time.sleep(30)"`），不是真的识别进程：
要验证的是进程管理本身——起、跟踪、终止、对账、退出时收尾。
真识别子进程的端到端在 `tests/integration/test_worker_subprocess.py`。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from book2text.core.project import executor as executor_module
from book2text.core.project import jobs
from book2text.core.storage import db as db_module

SLEEP_COMMAND = [sys.executable, "-c", "import time; time.sleep(30)"]


def sleeper(directory: Path, job_id: str) -> list[str]:
    return list(SLEEP_COMMAND)


@pytest.fixture
def supervisor() -> executor_module.Supervisor:
    return executor_module.Supervisor(command_builder=sleeper, terminate_grace=2.0)


def make_job(directory: Path, *page_ids: str) -> jobs.JobRecord:
    return jobs.create_job(
        directory,
        pages=[(page_id, index + 1) for index, page_id in enumerate(page_ids)],
        params={"dpi": 300, "language": "ch"},
    )


# ---------------------------------------------------------------- 起与跟踪

def test_start_tracks_a_live_child(supervisor, minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1")

    pid = supervisor.start(minimal_project, job.job_id)
    try:
        assert pid > 0
        assert supervisor.is_alive(job.job_id)
        assert supervisor.process_id(job.job_id) == pid
        assert supervisor.running_job_ids_for(minimal_project) == {job.job_id}
        assert supervisor.running_job_ids_for(Path("/elsewhere")) == set()
        assert supervisor.live_entries() == [(job.job_id, minimal_project)]
    finally:
        supervisor.shutdown()

    assert not supervisor.is_alive(job.job_id)
    assert supervisor.live_entries() == []


def test_log_file_is_written_inside_the_project(supervisor, minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1")
    try:
        supervisor.start(minimal_project, job.job_id)
        log_path = minimal_project / "logs" / f"{executor_module.LOG_PREFIX}{job.job_id}.log"
        assert log_path.parent.is_dir()
        assert log_path.exists(), "子进程的输出要落进项目的 logs/"
    finally:
        supervisor.shutdown()


def test_stop_terminates_the_child(supervisor, minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1")
    supervisor.start(minimal_project, job.job_id)

    assert supervisor.stop(job.job_id) is True, "确实杀掉了一个活着的进程"
    assert not supervisor.is_alive(job.job_id)
    assert supervisor.stop(job.job_id) is False, "再杀一次没有活进程可杀"


def test_finished_children_are_reaped(supervisor, tmp_path: Path) -> None:
    """已经退出的子进程要自动清理（否则日志句柄会一直开着）。"""

    def quick(directory: Path, job_id: str) -> list[str]:
        return [sys.executable, "-c", "pass"]

    fast = executor_module.Supervisor(command_builder=quick)
    fast.start(tmp_path, "jobX")
    # 子进程马上退出；下一次查询时应当被清掉
    for _ in range(50):
        if not fast.is_alive("jobX"):
            break
        import time

        time.sleep(0.05)
    assert not fast.is_alive("jobX")
    assert fast.live_entries() == []
    assert fast.process_id("jobX") is None


# ---------------------------------------------------------------- 对账

def test_reconcile_marks_stale_running_jobs_interrupted(
    supervisor, minimal_project: Path
) -> None:
    """子进程没了（崩了 / 服务重启过）但任务还写着 running —— 必须如实改成中断。"""
    job = make_job(minimal_project, "page1")
    jobs.set_status(minimal_project, job.job_id, jobs.STATUS_RUNNING)
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute("UPDATE job_item SET status = 'running' WHERE job_id = ?", (job.job_id,))
        # 把创建时间改老——跳过"刚建出来还没起进程"的宽限期
        conn.execute(
            "UPDATE job SET created_at = '2026-01-01T00:00:00+00:00' WHERE job_id = ?",
            (job.job_id,),
        )
        conn.commit()

    assert supervisor.reconcile(minimal_project) == 1
    assert jobs.get_job(minimal_project, job.job_id).status == jobs.STATUS_INTERRUPTED
    item = jobs.list_job_items(minimal_project, job.job_id)[0]
    assert item.status == jobs.STATUS_FAILED
    assert "中断" in (item.error_message or "")


def test_reconcile_spares_a_live_child(supervisor, minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1")
    jobs.set_status(minimal_project, job.job_id, jobs.STATUS_RUNNING)
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job SET created_at = '2026-01-01T00:00:00+00:00' WHERE job_id = ?",
            (job.job_id,),
        )
        conn.commit()

    supervisor.start(minimal_project, job.job_id)
    try:
        assert supervisor.reconcile(minimal_project) == 0
        assert jobs.get_job(minimal_project, job.job_id).status == jobs.STATUS_RUNNING
    finally:
        supervisor.shutdown()


def test_reconcile_spares_a_freshly_created_job(supervisor, minimal_project: Path) -> None:
    """刚建出来、子进程还没起来的任务不算中断（建任务与起进程之间有个缝）。"""
    job = make_job(minimal_project, "page1")
    assert supervisor.reconcile(minimal_project) == 0
    assert jobs.get_job(minimal_project, job.job_id).status == jobs.STATUS_QUEUED


def test_reconcile_ignores_finished_jobs(supervisor, minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1")
    jobs.set_status(minimal_project, job.job_id, jobs.STATUS_SUCCEEDED)
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job SET created_at = '2026-01-01T00:00:00+00:00' WHERE job_id = ?",
            (job.job_id,),
        )
        conn.commit()
    assert supervisor.reconcile(minimal_project) == 0
    assert jobs.get_job(minimal_project, job.job_id).status == jobs.STATUS_SUCCEEDED
