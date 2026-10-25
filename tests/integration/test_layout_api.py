"""版面检测 / 工作流接口的集成测试（任务 58）。

用假检测引擎在本进程里跑：验证任务状态、行框落库、工作流记录与筛选、
暂停 / 继续 / 取消 / 重试失败页都复用现有任务机制。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.layout import detection as layout_detection
from book2text.core.project import executor as executor_module
from book2text.core.storage import db as db_module
from tests.fakes import FakeLayoutEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "版面检测测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def start_layout(client: TestClient, headers: dict[str, str], project_id: str, **body):
    return client.post(
        f"/api/projects/{project_id}/jobs/layout", json=body, headers=headers
    )


def workflow_of(client: TestClient, headers: dict[str, str], project_id: str, **params):
    response = client.get(
        f"/api/projects/{project_id}/workflow", params=params, headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_layout_job_persists_line_boxes_and_records_detected(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_layout_jobs: FakeLayoutEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = start_layout(client, auth_headers, project_id, pages=[1, 2])
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["job"]["job_type"] == "layout"
    assert data["job"]["status"] == "succeeded"
    assert data["job"]["total"] == 2
    assert data["job"]["done"] == 2

    layout = client.get(
        f"/api/projects/{project_id}/pages/1/layout", headers=auth_headers
    )
    assert layout.status_code == 200
    payload = layout.json()
    assert payload["run"]["engine_id"] == "fake-layout"
    assert payload["run"]["line_count"] == 3
    assert len(payload["lines"]) == 3
    assert [line["reading_order"] for line in payload["lines"]] == [0, 1, 2]
    for line in payload["lines"]:
        assert len(line["bbox"]) == 4
        assert all(0.0 <= value <= 1.0 for value in line["bbox"])

    # 原始输出落盘，而且明确标记"没有产生文字"
    raw = Path(payload["run"]["raw_result_path"])
    assert raw.name.endswith(".json")
    assert raw.parent.name == "layout_runs"
    directory = Path(client.app.state.library_dir) / project_id
    content = json.loads((directory / raw).read_text(encoding="utf-8"))
    assert content["text_produced"] is False
    assert content["line_count"] == 3

    state = workflow_of(client, auth_headers, project_id)
    assert state["counts"]["detected"] == 2
    assert state["summary"]["body"] == 3
    pages = {page["page_no"]: page for page in state["pages"]}
    assert pages[1]["stage"] == "detected"
    assert pages[1]["layout"]["line_count"] == 3
    assert pages[3]["stage"] == "page_unconfirmed"

    only_detected = workflow_of(client, auth_headers, project_id, stage="detected")
    assert [page["page_no"] for page in only_detected["pages"]] == [1, 2]


def test_scope_body_skips_already_detected_pages(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_layout_jobs: FakeLayoutEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    first = start_layout(client, auth_headers, project_id, pages=[1, 2])
    assert first.status_code == 200

    second = start_layout(client, auth_headers, project_id, scope="body")
    assert second.status_code == 200, second.text
    assert second.json()["job"]["total"] == 1

    third = start_layout(client, auth_headers, project_id, scope="body")
    assert third.status_code == 400
    assert "没有需要检测的页面" in third.text


def test_layout_failure_is_recorded_without_advancing_stage(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = FakeLayoutEngine(fail_message="模拟检测崩了")
    monkeypatch.setattr(layout_detection, "default_layout_engine", lambda: engine)

    def fake_start(self, directory, job_id):  # noqa: ANN001
        from book2text.core.project import recognition

        recognition.run_job(directory, job_id, engine=engine)
        return 0

    monkeypatch.setattr(executor_module.Supervisor, "start", fake_start)
    project_id = create_project(client, auth_headers, sample_pdf)
    response = start_layout(client, auth_headers, project_id, pages=[1])
    assert response.status_code == 200
    assert response.json()["job"]["status"] == "failed"

    state = workflow_of(client, auth_headers, project_id)
    page = next(item for item in state["pages"] if item["page_no"] == 1)
    assert page["stage"] == "page_unconfirmed"
    assert page["failed_stage"] == "detected"
    assert "模拟检测崩了" in page["failure_reason"]
    assert state["summary"]["failed"] == 1


def test_layout_job_can_pause_resume_and_cancel(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """控制信号走现有任务表：这里只验证接口与状态，不真跑检测。"""
    engine = FakeLayoutEngine()
    monkeypatch.setattr(layout_detection, "default_layout_engine", lambda: engine)
    monkeypatch.setattr(executor_module.Supervisor, "start", lambda self, d, j: 0)

    project_id = create_project(client, auth_headers, sample_pdf)
    response = start_layout(client, auth_headers, project_id, pages=[1, 2])
    assert response.status_code == 200
    job_id = response.json()["job"]["job_id"]
    assert response.json()["job"]["status"] == "queued"

    paused = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/pause", headers=auth_headers
    )
    assert paused.status_code == 200
    assert paused.json()["job"]["status"] == "paused"

    resumed = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/resume", headers=auth_headers
    )
    assert resumed.status_code == 200
    assert resumed.json()["job"]["status"] == "running"

    cancelled = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/cancel", headers=auth_headers
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["job"]["status"] == "cancelled"


def test_retry_failed_layout_item(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = FakeLayoutEngine(fail_message="第一次不行")
    monkeypatch.setattr(layout_detection, "default_layout_engine", lambda: engine)

    def fake_start(self, directory, job_id):  # noqa: ANN001
        from book2text.core.project import recognition

        recognition.run_job(directory, job_id, engine=engine)
        return 0

    monkeypatch.setattr(executor_module.Supervisor, "start", fake_start)
    project_id = create_project(client, auth_headers, sample_pdf)
    started = start_layout(client, auth_headers, project_id, pages=[1])
    job_id = started.json()["job"]["job_id"]
    assert started.json()["job"]["status"] == "failed"

    engine._fail_message = None  # 模拟环境恢复
    retried = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/retry-failed", headers=auth_headers
    )
    assert retried.status_code == 200, retried.text
    payload = retried.json()
    assert payload["retried"] == 1
    assert payload["job"]["status"] == "succeeded"
    assert payload["job"]["done"] == 1


def test_ocr_job_records_ocr1_done(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    state = workflow_of(client, auth_headers, project_id)
    page = next(item for item in state["pages"] if item["page_no"] == 1)
    assert page["stage"] == "ocr1_done"
    assert state["summary"]["ocr1_done"] == 1


def test_workflow_rejects_unknown_stage(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.get(
        f"/api/projects/{project_id}/workflow",
        params={"stage": "not-a-stage"},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "workflow_error"


def test_page_layout_returns_empty_before_detection(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.get(
        f"/api/projects/{project_id}/pages/1/layout", headers=auth_headers
    )
    assert response.status_code == 200
    assert response.json()["run"] is None
    assert response.json()["lines"] == []
