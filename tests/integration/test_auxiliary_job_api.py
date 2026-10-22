"""第二引擎批量复核任务的集成测试（说明书 8.5 / R1b，任务机制见 6.3）。

说明书 8.5 说复核"可以随时对已识别的页面**单独补跑或重跑**"；
接进任务执行器之后，"批量"这件事就自动获得了识别任务的那一整套能力：
进度、暂停 / 继续 / 取消、重试失败页、中断恢复（都有测试覆盖，见
`test_jobs_control_api.py` 与 `test_worker_subprocess.py`）。

这里验证的是**复核特有的那部分**：

- 范围解析：只有已识别的页能复核；默认跳过已复核的页；`scope=unchecked` 只挑没复核过的；
- 任务类型：`job_type = auxiliary`，两种任务共用同一个 `run_job` 分派；
- 第二引擎不可用时**明确报错**（说明书 8.6：不显示分歧标记、也不假装还在比对）；
- 失败原因可见：某页复核失败时，任务照常跑完其余页，失败原因写进 `job_item.error_message`。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module
from book2text.core.project import jobs as jobs_module
from tests.fakes import FakeOcrEngine, FakeSecondEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "批量复核", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, *page_nos: int) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": list(page_nos), "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def check_pages(
    client: TestClient, headers: dict[str, str], project_id: str, body: dict
) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/jobs/auxiliary", json=body, headers=headers
    )
    return {"status": response.status_code, "data": response.json() if response.content else {}}


def lines_of(project_id: str, library_dir: Path, page_no: int = 1):
    return blocks_module.list_block_lines(project_id, library=library_dir, page_no=page_no)


@pytest.fixture
def recognized_project(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    """第 1、2 页已识别的项目。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1, 2)
    return project_id


# ---------------------------------------------------------------- 批量复核

def test_batch_check_writes_line_candidates_for_every_selected_page(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """复核任务：按页一个单元，每页写一条辅助运行与行级候选，块与审校状态一点不动。"""
    project_id = recognized_project
    before_texts = {no: [line.text for line in lines_of(project_id, library_dir, no)] for no in (1, 2)}

    started = check_pages(client, auth_headers, project_id, {"pages": [1, 2]})
    assert started["status"] == 200, started
    data = started["data"]
    assert data["job"]["job_type"] == "auxiliary"
    assert data["job"]["status"] == "succeeded"
    assert data["job"]["done"] == 2
    assert data["job"]["total"] == 2

    for no in (1, 2):
        lines = lines_of(project_id, library_dir, no)
        assert all(line.aux_text is not None for line in lines), f"第 {no} 页的行都该有候选"
        assert [line.text for line in lines] == before_texts[no], "行文本（第一引擎的）不该动"

    # 每页一条辅助运行，且不抢 active run
    runs = blocks_module.list_runs(project_id, library=library_dir, run_type="auxiliary")
    assert len(runs) == 2
    assert all(run.status == "succeeded" for run in runs)
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    assert all(page["recognition"]["status"] == "recognized" for page in pages[:2])

    # 页面载荷立刻带上复核结果（缩略图标记与筛选靠它）
    payload = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()
    assert all(page["divergence"]["checked"] for page in payload["pages"][:2])


def test_already_checked_pages_are_skipped_by_default(
    client: TestClient,
    auth_headers: dict[str, str],
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """说明书 8.5 的"补跑"语义：已复核的页默认跳过；要去掉勾选才会重跑。"""
    project_id = recognized_project
    first = check_pages(client, auth_headers, project_id, {"pages": [1]})
    assert first["status"] == 200
    assert first["data"]["job"]["total"] == 1

    skipped = check_pages(client, auth_headers, project_id, {"pages": [1]})
    assert skipped["status"] == 400
    assert "没有需要复核的页面" in skipped["data"]["error"]["detail"]

    again = check_pages(
        client, auth_headers, project_id, {"pages": [1], "skip_checked": False}
    )
    assert again["status"] == 200, again
    assert again["data"]["job"]["total"] == 1


def test_scope_unchecked_picks_only_pages_never_checked(
    client: TestClient,
    auth_headers: dict[str, str],
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """`scope=unchecked`：全部已识别页里还没有复核记录的那些。"""
    project_id = recognized_project
    check_pages(client, auth_headers, project_id, {"pages": [1], "skip_checked": False})

    response = check_pages(client, auth_headers, project_id, {"scope": "unchecked"})
    assert response["status"] == 200, response
    items = response["data"]["items"]
    assert [item["page_no"] for item in items] == [2], "第 1 页复核过了，只剩第 2 页"


def test_pages_without_recognition_are_rejected_with_a_reason(
    client: TestClient,
    auth_headers: dict[str, str],
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """没识别过的页不能复核——第二引擎读的是第一引擎切出的行图。"""
    project_id = recognized_project
    refused = check_pages(client, auth_headers, project_id, {"pages": [3]})
    assert refused["status"] == 400
    assert "还没有第一引擎的识别结果" in refused["data"]["error"]["detail"]


def test_excluded_page_is_rejected(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    project_id = recognized_project
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    client.patch(
        f"/api/projects/{project_id}/pages",
        json={"page_ids": [pages[0]["page_id"]], "page_type": "body_excluded"},
        headers=auth_headers,
    )
    refused = check_pages(client, auth_headers, project_id, {"pages": [1]})
    assert refused["status"] == 400
    assert "不是「正文」类型" in refused["data"]["error"]["detail"]


def test_second_engine_unavailable_is_reported_as_503(
    client: TestClient,
    auth_headers: dict[str, str],
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """说明书 8.6：第二引擎不可用要**明确说出来**，不建注定失败的任务。"""
    from book2text.core.project import recognition

    unavailable = FakeSecondEngine(
        available=False, reason="这台机器上没有可用的系统 OCR"
    )
    monkeypatch.setattr(recognition, "default_secondary_engine", lambda: unavailable)

    refused = check_pages(client, auth_headers, recognized_project, {"pages": [1]})
    assert refused["status"] == 503
    assert refused["data"]["error"]["code"] == "secondary_engine_unavailable"
    assert "第二意见" not in refused["data"]["error"]["detail"]  # 原因原样带出来，不自己编
    assert "这台机器上没有可用的系统 OCR" in refused["data"]["error"]["detail"]


def test_one_active_job_at_a_time(
    client: TestClient,
    auth_headers: dict[str, str],
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """说明书 6.3：默认只跑 1 个 OCR 子进程——复核任务也占这个名额。"""
    from book2text.core.project import executor as executor_module
    from book2text.core.project import recognition, jobs

    project_id = recognized_project
    directory = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers)
    assert directory.status_code == 200

    # 造一个"正在跑"的任务：直接把单元写成排队状态，且不让 fixture 立刻跑完
    calls: list[str] = []

    def slow_start(self, directory, job_id):  # noqa: ANN001
        calls.append(job_id)  # 不真跑，让它停在 queued

    monkeypatch.setattr(executor_module.Supervisor, "start", slow_start)

    first = check_pages(client, auth_headers, project_id, {"pages": [1]})
    assert first["status"] == 200 and first["data"]["job"]["status"] == "queued"

    refused = check_pages(client, auth_headers, project_id, {"pages": [2]})
    assert refused["status"] == 400
    assert "已经有一个任务在进行中" in refused["data"]["error"]["detail"]


# ---------------------------------------------------------------- 失败可见与重试

def test_a_failing_page_is_recorded_and_the_rest_still_run(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """一页复核失败不影响其余页，原因写进 job_item.error_message（验收：失败原因可见）。"""
    from book2text.core.project import recognition

    fake = FakeSecondEngine(["一样的文本"])
    # 第 2 页复核时炸掉：第 1 页应当照样完成
    real_run_auxiliary = recognition.run_auxiliary

    def flaky(directory, page_no, *, engine=None):  # noqa: ANN001
        if page_no == 2:
            raise recognition.ProjectError("模拟：这一页的行图读不出来")
        return real_run_auxiliary(directory, page_no, engine=engine)

    monkeypatch.setattr(recognition, "run_auxiliary", flaky)
    monkeypatch.setattr(recognition, "default_secondary_engine", lambda: fake)

    project_id = recognized_project
    started = check_pages(client, auth_headers, project_id, {"pages": [1, 2]})
    assert started["status"] == 200
    job = started["data"]["job"]
    assert job["status"] == "failed"
    assert (job["done"], job["failed"]) == (1, 1) or (job["done"], job["failed"]) == (1, 1)
    failures = started["data"]["failed_items"]
    assert [item["page_no"] for item in failures] == [2]
    assert "行图读不出来" in failures[0]["error_message"]

    # 失败的那一页没有复核结果，成功的那一页有
    assert all(line.aux_text is not None for line in lines_of(project_id, library_dir, 1))
    assert all(line.aux_text is None for line in lines_of(project_id, library_dir, 2))


def test_failed_pages_can_be_retried(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """重试失败页：把失败的单元退回排队再跑一遍（与识别任务是同一套接口）。"""
    from book2text.core.project import recognition

    state = {"fail": True}
    real_run_auxiliary = recognition.run_auxiliary

    def flaky(directory, page_no, *, engine=None):  # noqa: ANN001
        if state["fail"]:
            raise recognition.ProjectError("模拟：第一次复核失败")
        return real_run_auxiliary(directory, page_no, engine=engine)

    monkeypatch.setattr(recognition, "run_auxiliary", flaky)
    project_id = recognized_project
    started = check_pages(client, auth_headers, project_id, {"pages": [1]})
    assert started["status"] == 200
    job_id = started["data"]["job"]["job_id"]
    assert started["data"]["job"]["failed"] == 1

    state["fail"] = False
    retried = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/retry-failed", headers=auth_headers
    )
    assert retried.status_code == 200, retried.text
    body = retried.json()
    assert body["retried"] == 1
    assert body["job"]["status"] == "succeeded"
    assert all(line.aux_text is not None for line in lines_of(project_id, library_dir, 1))


def test_review_view_single_page_check_still_works_alongside_the_job(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """审校视图里的单页复核（同步接口）没被批量任务取代，两条路并存。"""
    project_id = recognized_project
    response = client.post(
        f"/api/projects/{project_id}/pages/1/auxiliary", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    assert response.json()["line_count"] == 3
    assert all(line.aux_text is not None for line in lines_of(project_id, library_dir, 1))

    # 复核过之后再批量复核同一页：默认跳过
    skipped = check_pages(client, auth_headers, project_id, {"pages": [1]})
    assert skipped["status"] == 400


# ---------------------------------------------------------------- 执行循环的控制信号
#
# 复核任务与识别任务共用 `run_job` 的循环，因此"暂停 / 取消"的形状必须一模一样。
# 下面两条用**脚本化的决定**直接驱动循环（真子进程那套见 test_worker_subprocess.py）。

def scripted(decisions: list[str]):
    """按脚本依次返回决定，用完之后一直返回最后一个。"""
    queue = list(decisions)

    def decide() -> str:
        return queue.pop(0) if len(queue) > 1 else queue[0]

    return decide


def make_aux_job(library_dir: Path, project_id: str, *page_nos: int) -> jobs_module.JobRecord:
    """按页码建一个复核任务（绕过 resolve，直接测执行循环）。"""
    directory = library_dir / project_id
    pages = {
        page.page_no: page
        for page in blocks_module.list_pages(project_id, library=library_dir)
    }
    return jobs_module.create_job(
        directory,
        pages=[(pages[no].page_id, no) for no in page_nos],
        params={"engine_id": "fake-second"},
        job_type=jobs_module.JOB_TYPE_AUXILIARY,
    )


def test_auxiliary_loop_pauses_between_pages_then_continues(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """暂停时不去复核任何一页，恢复之后接着做（说明书 6.3："当前页完成后停止"）。"""
    from book2text.core.project import recognition

    project_id = recognized_project
    job = make_aux_job(library_dir, project_id, 1, 2)
    directory = library_dir / project_id

    outcome = recognition.run_job(
        directory,
        job.job_id,
        engine=inprocess_aux_jobs,
        should_continue=scripted(
            [recognition.DECISION_PAUSE, recognition.DECISION_RUN, recognition.DECISION_RUN]
        ),
    )

    assert outcome.job.status == "succeeded"
    assert outcome.job.done == 2, "恢复之后两页都复核了"
    assert [item.status for item in outcome.items] == ["succeeded", "succeeded"]


def test_auxiliary_loop_stops_when_cancelled_and_resumes_without_redoing(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_project: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """取消（或父进程没了）就收工：已经复核的页保留，继续时只做没做完的。"""
    from book2text.core.project import recognition

    project_id = recognized_project
    job = make_aux_job(library_dir, project_id, 1, 2)
    directory = library_dir / project_id

    outcome = recognition.run_job(
        directory,
        job.job_id,
        engine=inprocess_aux_jobs,
        should_continue=scripted([recognition.DECISION_RUN, recognition.DECISION_STOP]),
    )

    assert outcome.job.status == jobs_module.STATUS_RUNNING, "结算留给取消方"
    assert all(line.aux_text is not None for line in lines_of(project_id, library_dir, 1))
    assert all(line.aux_text is None for line in lines_of(project_id, library_dir, 2))

    # 继续：只做第 2 页
    again = recognition.run_job(directory, job.job_id, engine=inprocess_aux_jobs)
    assert again.job.status == "succeeded"
    assert [item.status for item in again.items] == ["succeeded", "succeeded"]
    assert all(line.aux_text is not None for line in lines_of(project_id, library_dir, 2))
