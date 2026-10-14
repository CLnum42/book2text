"""任务控制的集成测试（说明书 6.3：暂停 / 继续 / 取消 / 重试失败页）。

**子进程用录制器替身**：这里验证的是状态机与接口语义，不是进程管理。
真的起进程、真的杀进程在 `tests/unit/test_executor.py` 与
`tests/integration/test_worker_subprocess.py`。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import executor as executor_module
from book2text.core.project import jobs as jobs_module
from book2text.core.project import recognition
from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


@pytest.fixture
def started_jobs(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """把"起子进程"换成记账本：返回一个列表，记下被要求启动的任务 id。"""
    started: list[str] = []

    def fake_start(self, directory, job_id):  # noqa: ANN001
        started.append(job_id)
        return 4242

    monkeypatch.setattr(executor_module.Supervisor, "start", fake_start)
    return started


@pytest.fixture
def engine(monkeypatch: pytest.MonkeyPatch) -> FakeOcrEngine:
    fake = FakeOcrEngine()
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: fake)
    return fake


def make_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "任务控制", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    return response.json()["project"]["project_id"]


def page_ids(client: TestClient, headers: dict[str, str], project_id: str) -> list[str]:
    pages = client.get(f"/api/projects/{project_id}/pages", headers=headers).json()["pages"]
    return [page["page_id"] for page in pages]


def make_job(library_dir: Path, project_id: str, page_ids_: list[str], **params) -> jobs.JobRecord:
    """直接在库里建一个任务（不起进程），用于构造各种状态。"""
    return jobs_module.create_job(
        library_dir / project_id,
        pages=[(page_id, index + 1) for index, page_id in enumerate(page_ids_)],
        params={"dpi": 300, "language": "ch", **params},
    )


def get_job(client: TestClient, headers: dict[str, str], project_id: str, job_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/jobs/{job_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------- 暂停 / 继续

def test_pause_then_resume(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    project_id = make_project(client, auth_headers, sample_pdf)
    job = make_job(library_dir, project_id, page_ids(client, auth_headers, project_id))
    jobs_module.set_status(library_dir / project_id, job.job_id, jobs_module.STATUS_RUNNING)

    paused = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/pause", headers=auth_headers
    )
    assert paused.status_code == 200, paused.text
    assert paused.json()["job"]["status"] == "paused"
    assert paused.json()["alive"] is False, "测试里没有真子进程"

    resumed = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/resume", headers=auth_headers
    )
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["job"]["status"] == "running"
    assert started_jobs == [job.job_id], "暂停后的继续要重新起一个执行者接着做"


def test_resume_after_interruption_starts_a_new_worker(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    """中断 / 失败 / 取消过的任务，"继续"就是只做没成功的那些页。"""
    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids)
    jobs_module.set_status(library_dir / project_id, job.job_id, jobs_module.STATUS_INTERRUPTED)

    response = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/resume", headers=auth_headers
    )
    assert response.status_code == 200
    assert response.json()["job"]["status"] == "running"
    assert started_jobs == [job.job_id]


def test_pause_a_finished_job_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    project_id = make_project(client, auth_headers, sample_pdf)
    job = make_job(library_dir, project_id, page_ids(client, auth_headers, project_id))
    jobs_module.set_status(library_dir / project_id, job.job_id, jobs_module.STATUS_SUCCEEDED)

    response = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/pause", headers=auth_headers
    )
    assert response.status_code == 400
    assert "不能这样操作" in response.json()["error"]["detail"]


def test_resume_a_running_job_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    project_id = make_project(client, auth_headers, sample_pdf)
    job = make_job(library_dir, project_id, page_ids(client, auth_headers, project_id))
    jobs_module.set_status(library_dir / project_id, job.job_id, jobs_module.STATUS_RUNNING)

    response = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/resume", headers=auth_headers
    )
    assert response.status_code == 400
    assert "正在运行" in response.json()["error"]["detail"]


# ---------------------------------------------------------------- 取消

def test_cancel_settles_the_in_flight_item(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    """取消要把还没结算的记录写成失败——不能留一条永远 running 的单元。"""
    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids)
    directory = library_dir / project_id
    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_RUNNING)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'succeeded' WHERE page_id = ?", (ids[0],)
        )
        conn.execute("UPDATE job_item SET status = 'running' WHERE page_id = ?", (ids[1],))
        conn.commit()
    jobs_module.update_progress(directory, job.job_id)

    response = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/cancel", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["job"]["status"] == "cancelled"
    assert data["job"]["done"] == 1
    assert data["job"]["failed"] == 1, "被中止的那页记为失败（可重试）"

    by_page = {item["page_no"]: item for item in data["items"]}
    assert by_page[1]["status"] == "succeeded", "已经认完的页保留成果——取消不回滚"
    assert by_page[2]["status"] == "failed"
    assert "取消" in by_page[2]["error_message"]
    assert by_page[3]["status"] == "queued", "还没轮到的页保持排队，继续时接着做"


def test_cancelled_job_can_be_resumed(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids)
    directory = library_dir / project_id
    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_RUNNING)
    client.post(f"/api/projects/{project_id}/jobs/{job.job_id}/cancel", headers=auth_headers)

    response = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/resume", headers=auth_headers
    )
    assert response.status_code == 200
    assert response.json()["job"]["status"] == "running"
    assert started_jobs == [job.job_id]


def test_cancel_a_finished_job_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    project_id = make_project(client, auth_headers, sample_pdf)
    job = make_job(library_dir, project_id, page_ids(client, auth_headers, project_id))
    jobs_module.set_status(library_dir / project_id, job.job_id, jobs_module.STATUS_SUCCEEDED)

    response = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/cancel", headers=auth_headers
    )
    assert response.status_code == 400


# ---------------------------------------------------------------- 重试失败页

def test_retry_failed_requeues_only_failed_pages(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids)
    directory = library_dir / project_id
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute("UPDATE job_item SET status = 'succeeded' WHERE page_id = ?", (ids[0],))
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = '引擎崩了' WHERE page_id = ?",
            (ids[1],),
        )
        conn.commit()
    jobs_module.update_progress(directory, job.job_id)
    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_FAILED)

    response = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/retry-failed", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["retried"] == 1
    assert data["job"]["status"] == "running"
    assert data["job"]["failed"] == 0
    assert started_jobs == [job.job_id]

    by_page = {item["page_no"]: item for item in data["items"]}
    assert by_page[1]["status"] == "succeeded", "成功的页不动"
    assert by_page[2]["status"] == "queued"
    assert by_page[2]["error_message"] is None


def test_retry_without_failures_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    project_id = make_project(client, auth_headers, sample_pdf)
    job = make_job(library_dir, project_id, page_ids(client, auth_headers, project_id))
    jobs_module.set_status(library_dir / project_id, job.job_id, jobs_module.STATUS_SUCCEEDED)

    response = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/retry-failed", headers=auth_headers
    )
    assert response.status_code == 400
    assert "没有失败的页" in response.json()["error"]["detail"]


def test_retry_while_a_worker_is_alive_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
) -> None:
    """任务真的在跑时不许重试失败页——否则两个执行者会同时写同一页。

    这里起一个**真的会活着的假进程**（sleep 30），因此走的是真实的 is_alive 判断。
    """
    import sys

    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids)
    directory = library_dir / project_id
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = 'x' WHERE page_id = ?",
            (ids[0],),
        )
        conn.commit()
    jobs_module.update_progress(directory, job.job_id)
    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_RUNNING)

    supervisor = client.app.state.job_supervisor
    supervisor._command_builder = lambda path, job_id: [
        sys.executable, "-c", "import time; time.sleep(30)"
    ]
    supervisor.start(directory, job.job_id)

    response = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/retry-failed", headers=auth_headers
    )
    assert response.status_code == 400
    assert "还在跑" in response.json()["error"]["detail"]
    supervisor.stop(job.job_id)


def test_retry_after_the_worker_disappeared_works(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    """子进程没了（崩了）时，"重试失败页"不该被一个过时的 running 状态挡住。

    先对账（把状态改成中断），再重试——这正是界面上会发生的顺序：
    轮询看到中断，用户点"重试失败页"。
    """
    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids)
    directory = library_dir / project_id
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = 'x' WHERE page_id = ?",
            (ids[0],),
        )
        conn.execute(
            "UPDATE job SET created_at = '2026-01-01T00:00:00+00:00' WHERE job_id = ?",
            (job.job_id,),
        )
        conn.commit()
    jobs_module.update_progress(directory, job.job_id)
    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_RUNNING)

    response = client.post(
        f"/api/projects/{project_id}/jobs/{job.job_id}/retry-failed", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    assert response.json()["retried"] == 1
    assert response.json()["job"]["status"] == "running"
    assert started_jobs == [job.job_id]


# ---------------------------------------------------------------- 对账与读取

def test_stale_running_job_is_reconciled_on_read(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    """子进程没了、服务还活着：读任务列表时状态必须立刻如实。"""
    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids)
    directory = library_dir / project_id
    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_RUNNING)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute("UPDATE job_item SET status = 'running' WHERE page_id = ?", (ids[0],))
        conn.execute(
            "UPDATE job SET created_at = '2026-01-01T00:00:00+00:00' WHERE job_id = ?",
            (job.job_id,),
        )
        conn.commit()

    listing = client.get(f"/api/projects/{project_id}/jobs", headers=auth_headers).json()
    assert listing["jobs"][0]["status"] == "interrupted"
    assert listing["active"] is None

    detail = get_job(client, auth_headers, project_id, job.job_id)
    assert detail["items"][0]["status"] == "failed"
    assert "中断" in detail["items"][0]["error_message"]


def test_job_listing_shows_progress_and_failures(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    started_jobs: list[str],
) -> None:
    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids)
    directory = library_dir / project_id
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute("UPDATE job_item SET status = 'succeeded' WHERE page_id = ?", (ids[0],))
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = '引擎崩了' WHERE page_id = ?",
            (ids[1],),
        )
        conn.execute("UPDATE job_item SET status = 'running' WHERE page_id = ?", (ids[2],))
        conn.commit()
    jobs_module.update_progress(directory, job.job_id)
    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_RUNNING)

    data = client.get(f"/api/projects/{project_id}/jobs", headers=auth_headers).json()
    active = data["active"]
    assert active["job"]["job_id"] == job.job_id
    assert active["job"]["total"] == 3
    assert active["job"]["done"] == 1
    assert active["job"]["failed"] == 1
    assert active["job"]["remaining"] == 1
    assert active["current_page_no"] == 3, "当前页 = 正在跑的那个单元"
    assert [item["page_no"] for item in active["failed_items"]] == [2]

    detail = get_job(client, auth_headers, project_id, job.job_id)
    assert detail["job"]["job_id"] == job.job_id
    assert detail["log_path"].endswith(f"ocr-{job.job_id}.log")


def test_unknown_job_returns_400(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, started_jobs: list[str]
) -> None:
    project_id = make_project(client, auth_headers, sample_pdf)
    response = client.get(
        f"/api/projects/{project_id}/jobs/01NOPE", headers=auth_headers
    )
    assert response.status_code == 400
    assert "找不到任务" in response.json()["error"]["detail"]


def test_control_requires_token(client: TestClient, sample_pdf: Path) -> None:
    for action in ("pause", "resume", "cancel", "retry-failed"):
        response = client.post(f"/api/projects/b2t_ZZZZZZ/jobs/01X/{action}")
        assert response.status_code == 401


# ---------------------------------------------------------------- 执行循环的暂停 / 停止

def scripted(decisions: list[str]):
    """按脚本依次返回决定，用完之后一直返回最后一个。"""
    queue = list(decisions)

    def decide() -> str:
        return queue.pop(0) if len(queue) > 1 else queue[0]

    return decide


def test_run_job_waits_while_paused_then_continues(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    engine: FakeOcrEngine,
) -> None:
    """暂停时执行循环不做事，恢复之后接着做——用的是同一套落库路径。"""
    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids[:2])
    directory = library_dir / project_id

    outcome = recognition.run_job(
        directory,
        job.job_id,
        engine=engine,
        should_continue=scripted(
            [recognition.DECISION_PAUSE, recognition.DECISION_RUN, recognition.DECISION_RUN]
        ),
    )

    assert outcome.job.status == jobs_module.STATUS_SUCCEEDED
    assert engine.calls == 2, "暂停期间不识别任何页，恢复后两页都认"
    assert [item.status for item in outcome.items] == ["succeeded", "succeeded"]


def test_run_job_stops_when_cancelled_and_leaves_state_to_the_caller(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    engine: FakeOcrEngine,
) -> None:
    """收到 stop（取消 / 父进程死了）就收工：已经做的保留，没做的不动。

    任务状态不由执行循环改写——取消的终态是 `cancelled`，由决定取消的那一方写，
    这里若写 `failed` 就会把"取消"和"失败"混为一谈。
    """
    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids[:3])
    directory = library_dir / project_id

    outcome = recognition.run_job(
        directory,
        job.job_id,
        engine=engine,
        should_continue=scripted([recognition.DECISION_RUN, recognition.DECISION_STOP]),
    )

    assert outcome.job.status == jobs_module.STATUS_RUNNING, "结算留给取消方"
    assert engine.calls == 1
    by_page = {item.page_no: item for item in outcome.items}
    assert by_page[1].status == "succeeded"
    assert by_page[2].status == "queued"
    assert by_page[3].status == "queued"

    # 继续：只做没成功的页
    again = recognition.run_job(directory, job.job_id, engine=engine)
    assert again.job.status == jobs_module.STATUS_SUCCEEDED
    assert engine.calls == 3, "第一页没有被重做"
    assert [item.status for item in again.items] == ["succeeded"] * 3


def test_item_pointing_at_a_missing_page_fails_loudly(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    engine: FakeOcrEngine,
) -> None:
    """单元指向的页面不存在时，任务**不能显示成功**——那会让人以为"都认完了"。

    这种单元只可能来自页面记录被删掉之后（job_item 按说明书没有外键）。
    """
    project_id = make_project(client, auth_headers, sample_pdf)
    directory = library_dir / project_id
    job = jobs_module.create_job(
        directory,
        pages=[("01BOGUSPAGEID000000000000", 9)],
        params={"dpi": 300, "language": "ch"},
    )

    outcome = recognition.run_job(directory, job.job_id, engine=engine)
    assert outcome.job.status == jobs_module.STATUS_FAILED
    assert outcome.job.failed == 1
    item = outcome.items[0]
    assert item.status == "failed"
    assert "页面不存在" in item.error_message
    assert engine.calls == 0


def test_run_job_on_a_finished_job_does_nothing(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    engine: FakeOcrEngine,
) -> None:
    project_id = make_project(client, auth_headers, sample_pdf)
    ids = page_ids(client, auth_headers, project_id)
    job = make_job(library_dir, project_id, ids[:1])
    directory = library_dir / project_id
    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_SUCCEEDED)

    outcome = recognition.run_job(directory, job.job_id, engine=engine)
    assert outcome.job.status == jobs_module.STATUS_SUCCEEDED
    assert engine.calls == 0
