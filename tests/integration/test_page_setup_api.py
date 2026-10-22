"""页面确认的集成测试（说明书 6.2：类型 / 纳入 / 确认状态；第 36 号任务）。"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "页面确认", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def pages(client: TestClient, headers: dict[str, str], project_id: str) -> list[dict]:
    response = client.get(f"/api/projects/{project_id}/pages", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["pages"]


def confirm(client: TestClient, headers: dict[str, str], project_id: str, ids: list[str]) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/pages/confirm",
        json={"page_ids": ids},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def project(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> tuple[str, list[dict]]:
    project_id = create_project(client, auth_headers, sample_pdf)
    return project_id, pages(client, auth_headers, project_id)


def test_new_project_pages_are_unconfirmed(project) -> None:
    _project_id, items = project
    assert len(items) == 3
    assert all(page["page_confirmed"] is False for page in items)
    assert all(page["page_type"] == "body" for page in items)


def test_confirm_pages_sets_state_and_summary(project, client, auth_headers) -> None:
    project_id, items = project
    data = confirm(client, auth_headers, project_id, [items[0]["page_id"]])
    assert data["confirmed"] == 1
    assert data["summary"] == {
        "total": 3,
        "body": 3,
        "other_types": 0,
        "included": 3,
        "excluded": 0,
        "confirmed": 1,
        "unconfirmed": 2,
    }
    refreshed = pages(client, auth_headers, project_id)
    assert [page["page_confirmed"] for page in refreshed] == [True, False, False]

    # 重复确认是幂等的
    again = confirm(client, auth_headers, project_id, [items[0]["page_id"]])
    assert again["summary"]["confirmed"] == 1


def test_changing_type_or_include_resets_confirmation(project, client, auth_headers) -> None:
    project_id, items = project
    confirm(client, auth_headers, project_id, [page["page_id"] for page in items])
    assert all(page["page_confirmed"] for page in pages(client, auth_headers, project_id))

    # 改类型 → 回到未确认
    response = client.patch(
        f"/api/projects/{project_id}/pages/{items[0]['page_id']}",
        json={"page_type": "toc"},
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert response.json()["page_confirmed"] is False
    assert response.json()["page_type"] == "toc"

    # 改纳入 → 回到未确认
    response = client.patch(
        f"/api/projects/{project_id}/pages",
        json={"page_ids": [items[1]["page_id"]], "include": False},
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert response.json()["pages"][0]["page_confirmed"] is False
    assert response.json()["pages"][0]["include"] is False


def test_same_value_does_not_reset_confirmation(project, client, auth_headers) -> None:
    project_id, items = project
    confirm(client, auth_headers, project_id, [items[0]["page_id"]])
    response = client.patch(
        f"/api/projects/{project_id}/pages",
        json={"page_ids": [items[0]["page_id"]], "page_type": "body"},
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert response.json()["pages"][0]["page_confirmed"] is True, "值没变就不该假装改过"


def test_suggestions_are_read_only(project, client, auth_headers) -> None:
    project_id, items = project
    response = client.get(
        f"/api/projects/{project_id}/pages/suggestions", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["suggestions"], "至少首页应有建议"
    assert data["suggestions"][0]["page_no"] == 1
    assert data["suggestions"][0]["suggested_type"] == "cover"
    assert data["suggestions"][0]["confidence"] in ("high", "medium", "low")
    # **没有自动应用**：页面还是默认类型、未确认
    refreshed = pages(client, auth_headers, project_id)
    assert all(page["page_type"] == "body" for page in refreshed)
    assert all(page["page_confirmed"] is False for page in refreshed)


def test_excluded_pages_never_enter_recognition(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    items = pages(client, auth_headers, project_id)
    excluded = items[1]
    response = client.patch(
        f"/api/projects/{project_id}/pages",
        json={"page_ids": [excluded["page_id"]], "include": False},
        headers=auth_headers,
    )
    assert response.status_code == 200

    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"scope": "all"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["job"]["total"] == 2
    assert sorted(page["page_no"] for page in data["pages"]) == [1, 3]
    assert all(page["page_no"] != excluded["page_no"] for page in data["pages"])


def test_unconfirmed_pages_do_not_block_recognition(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["job"]["total"] == 1
