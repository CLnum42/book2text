"""任务与任务单元的数据层（说明书 5.3 的 Job / JobItem）。

只碰记录，不跑识别：建任务、算进度、切状态、修理中断、重试失败页。
执行与进程管理在 `test_executor.py`，端到端在集成测试里。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from book2text.core.project import jobs
from book2text.core.storage import db as db_module


def make_job(directory: Path, *page_ids: str, **params) -> jobs.JobRecord:
    return jobs.create_job(
        directory,
        pages=[(page_id, index + 1) for index, page_id in enumerate(page_ids)],
        params={"dpi": 300, "language": "ch", **params},
    )


# ---------------------------------------------------------------- 建与读

def test_create_job_makes_one_item_per_page(minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1", "page2", "page3")

    assert job.status == jobs.STATUS_QUEUED
    assert job.total == 3
    assert job.done == 0 and job.failed == 0
    assert job.params["dpi"] == 300
    assert job.is_active

    items = jobs.list_job_items(minimal_project, job.job_id)
    assert [item.page_no for item in items] == [1, 2, 3]
    assert {item.status for item in items} == {jobs.ITEM_STATUS_QUEUED}
    assert all(item.attempts == 0 for item in items)


def test_create_job_refuses_an_empty_page_list(minimal_project: Path) -> None:
    with pytest.raises(jobs.JobError):
        jobs.create_job(minimal_project, pages=[], params={})


def test_missing_project_directory_is_reported(tmp_path: Path) -> None:
    """不存在的项目不该被 sqlite 悄悄建出一个空库。"""
    missing = tmp_path / "nope"
    with pytest.raises(jobs.JobError, match="找不到项目数据库"):
        jobs.list_jobs(missing)
    assert not (missing / "project.db").exists()


def test_progress_follows_item_status(minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1", "page2", "page3")
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'succeeded' WHERE page_id = 'page1'"
        )
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = '引擎崩了'"
            " WHERE page_id = 'page2'"
        )
        conn.commit()

    updated = jobs.update_progress(minimal_project, job.job_id)
    assert (updated.done, updated.failed, updated.remaining) == (1, 1, 1)
    assert updated.percent == pytest.approx(66.7, abs=0.1)
    assert updated.is_active, "任务还在进行中（第三个单元还没做完）"


# ---------------------------------------------------------------- 状态机

def test_set_status_records_start_and_finish(minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1")

    running = jobs.set_status(minimal_project, job.job_id, jobs.STATUS_RUNNING)
    assert running.status == jobs.STATUS_RUNNING
    assert running.started_at and not running.finished_at

    # 暂停再继续不改 started_at
    paused = jobs.set_status(minimal_project, job.job_id, jobs.STATUS_PAUSED)
    assert paused.status == jobs.STATUS_PAUSED
    resumed = jobs.set_status(minimal_project, job.job_id, jobs.STATUS_RUNNING)
    assert resumed.started_at == running.started_at

    finished = jobs.set_status(minimal_project, job.job_id, jobs.STATUS_SUCCEEDED)
    assert finished.finished_at
    assert not finished.is_active


def test_set_status_refuses_unexpected_source_state(minimal_project: Path) -> None:
    """并发操作不互相覆盖：后到的那个得到明确的拒绝。"""
    job = make_job(minimal_project, "page1")
    jobs.set_status(minimal_project, job.job_id, jobs.STATUS_SUCCEEDED)

    with pytest.raises(jobs.JobError, match="不能这样操作"):
        jobs.set_status(
            minimal_project,
            job.job_id,
            jobs.STATUS_PAUSED,
            expect=(jobs.STATUS_RUNNING,),
        )


def test_active_job_tracks_the_running_one(minimal_project: Path) -> None:
    assert jobs.active_job(minimal_project) is None

    job = make_job(minimal_project, "page1")
    assert jobs.active_job(minimal_project).job_id == job.job_id

    jobs.set_status(minimal_project, job.job_id, jobs.STATUS_RUNNING)
    assert [item.job_id for item in jobs.active_jobs(minimal_project)] == [job.job_id]

    jobs.set_status(minimal_project, job.job_id, jobs.STATUS_SUCCEEDED)
    assert jobs.active_job(minimal_project) is None


def test_unknown_job_is_reported(minimal_project: Path) -> None:
    with pytest.raises(jobs.JobError, match="找不到任务"):
        jobs.get_job(minimal_project, "nope")


# ---------------------------------------------------------------- 续跑与重试

def test_pending_items_are_the_unfinished_ones(minimal_project: Path) -> None:
    """说明书 5.3："继续"只处理未成功的单元。"""
    job = make_job(minimal_project, "page1", "page2", "page3")
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute("UPDATE job_item SET status = 'succeeded' WHERE page_id = 'page1'")
        conn.execute("UPDATE job_item SET status = 'failed', error_message = 'x' WHERE page_id = 'page2'")
        conn.execute("UPDATE job_item SET status = 'running' WHERE page_id = 'page3'")
        conn.commit()

    assert [item.page_no for item in jobs.pending_items(minimal_project, job.job_id)] == [2, 3]


def test_reset_failed_items_only_touches_failed(minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1", "page2", "page3")
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute("UPDATE job_item SET status = 'succeeded' WHERE page_id = 'page1'")
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = '坏了' WHERE page_id = 'page2'"
        )
        conn.commit()

    changed = jobs.reset_failed_items(minimal_project, job.job_id)
    assert changed == 1

    items = {item.page_no: item for item in jobs.list_job_items(minimal_project, job.job_id)}
    assert items[2].status == jobs.ITEM_STATUS_QUEUED
    assert items[2].error_message is None, "失败原因要清掉，否则界面会显示过期的错误"
    assert items[1].status == jobs.ITEM_STATUS_SUCCEEDED
    assert items[3].status == jobs.ITEM_STATUS_QUEUED
    assert jobs.get_job(minimal_project, job.job_id).failed == 0


def test_reset_failed_items_on_a_clean_job_changes_nothing(minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1")
    assert jobs.reset_failed_items(minimal_project, job.job_id) == 0


# ---------------------------------------------------------------- 修理

def test_repair_unfinished_settles_running_records(minimal_project: Path) -> None:
    """执行者退出之后才能做的事：把还没结算的单元与运行记录写成失败。"""
    job = make_job(minimal_project, "page1", "page2")
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO ocr_run (run_id, page_id, run_type, engine_id, engine_version,
                                 params_json, status, created_at)
            VALUES ('run1', 'page1', 'primary', 'fake', '1', '{}', 'running',
                    '2026-01-01T00:00:00+00:00')
            """
        )
        conn.execute(
            "UPDATE job_item SET status = 'running', run_id = 'run1' WHERE page_id = 'page1'"
        )
        conn.execute("UPDATE job_item SET status = 'succeeded' WHERE page_id = 'page2'")
        conn.commit()

    counts = jobs.repair_unfinished(minimal_project, message="断了", job_id=job.job_id)
    assert counts == {"runs": 1, "items": 1}

    item = jobs.list_job_items(minimal_project, job.job_id)[0]
    assert item.status == jobs.ITEM_STATUS_FAILED
    assert item.error_message == "断了"
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        run = conn.execute("SELECT * FROM ocr_run WHERE run_id = 'run1'").fetchone()
    assert run["status"] == "failed"
    assert run["error_code"] == "interrupted"
    assert run["finished_at"]

    updated = jobs.get_job(minimal_project, job.job_id)
    assert updated.failed == 1 and updated.done == 1


def test_repair_is_scoped_to_one_job(minimal_project: Path) -> None:
    first = make_job(minimal_project, "page1")
    second = make_job(minimal_project, "page2")
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute("UPDATE job_item SET status = 'running'")
        conn.commit()

    jobs.repair_unfinished(minimal_project, message="断了", job_id=first.job_id)

    assert jobs.list_job_items(minimal_project, first.job_id)[0].status == "failed"
    assert jobs.list_job_items(minimal_project, second.job_id)[0].status == "running"


def test_mark_interrupted_settles_stale_jobs_but_spares_live_ones(minimal_project: Path) -> None:
    """说明书 5.3 的中断清理，以及"别打断自己正在跑的任务"。"""
    stale = make_job(minimal_project, "page1")
    live = make_job(minimal_project, "page2")
    done = make_job(minimal_project, "page3")
    jobs.set_status(minimal_project, stale.job_id, jobs.STATUS_RUNNING)
    jobs.set_status(minimal_project, live.job_id, jobs.STATUS_RUNNING)
    jobs.set_status(minimal_project, done.job_id, jobs.STATUS_SUCCEEDED)

    marked = jobs.mark_interrupted(minimal_project, keep_job_ids={live.job_id})
    assert marked == 1
    assert jobs.get_job(minimal_project, stale.job_id).status == jobs.STATUS_INTERRUPTED
    assert jobs.get_job(minimal_project, live.job_id).status == jobs.STATUS_RUNNING
    assert jobs.get_job(minimal_project, done.job_id).status == jobs.STATUS_SUCCEEDED


def test_mark_interrupted_is_a_no_op_when_nothing_is_running(minimal_project: Path) -> None:
    job = make_job(minimal_project, "page1")
    jobs.set_status(minimal_project, job.job_id, jobs.STATUS_SUCCEEDED)
    assert jobs.mark_interrupted(minimal_project) == 0
