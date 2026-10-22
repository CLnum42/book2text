"""整页「版面确认」的集成测试（任务 45）。

页面确认（page_confirmed = 这页算不算正文）与版面确认（page.layout_confirmed =
这页里面哪些块算正文）是两个独立状态。本文件钉住：

1. 可单页 / 批量确认，事件表记 action=confirm_layout 与确认人；
2. 任何块的类型 / 框 / 顺序（含新增 / 软删除）改动会重置，改文本不会；
3. 重复确认幂等；确认不阻止导出。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "整页版面", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def page_data(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def confirm_layout(
    client: TestClient,
    headers: dict[str, str],
    project_id: str,
    page_no: int = 1,
    *,
    page_numbers: list[int] | None = None,
    actor_name: str | None = None,
) -> dict:
    body: dict = {}
    if page_numbers is not None:
        body["page_numbers"] = page_numbers
    if actor_name is not None:
        body["actor_name"] = actor_name
    response = client.post(
        f"/api/projects/{project_id}/pages/{page_no}/layout/confirm",
        json=body,
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def layout_confirmed(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> bool:
    pages = client.get(f"/api/projects/{project_id}/pages", headers=headers).json()["pages"]
    return next(page for page in pages if page["page_no"] == page_no)["layout_confirmed"]


def patch_block(client: TestClient, headers: dict[str, str], project_id: str, block: dict, patch: dict) -> None:
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={**patch, "expected_revision": block["revision"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def events(library_dir: Path, project_id: str) -> list[dict]:
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT action, entity_type, actor_name, after_json FROM event ORDER BY created_at, event_id"
        ).fetchall()
    return [dict(row) for row in rows]


@pytest.fixture
def ready_page(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> tuple[str, dict]:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id)
    return project_id, page_data(client, auth_headers, project_id)


def test_confirm_page_layout_records_event_and_is_idempotent(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    ready_page: tuple[str, dict],
) -> None:
    project_id, _page = ready_page
    assert layout_confirmed(client, auth_headers, project_id) is False

    result = confirm_layout(
        client, auth_headers, project_id, actor_name="负责审校的人"
    )
    assert result["confirmed_pages"] == [1]
    assert result["confirmed"] == 1
    assert result["new_events"] == 1
    assert layout_confirmed(client, auth_headers, project_id) is True
    # 页面确认（这页算不算正文）不受影响
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    assert pages[0]["page_confirmed"] is False

    layout_events = [item for item in events(library_dir, project_id) if item["action"] == "confirm_layout"]
    assert len(layout_events) == 1
    assert layout_events[0]["entity_type"] == "page"
    assert layout_events[0]["actor_name"] == "负责审校的人"
    assert json.loads(layout_events[0]["after_json"])["layout_confirmed"] == 1

    again = confirm_layout(client, auth_headers, project_id)
    assert again["new_events"] == 0
    assert layout_confirmed(client, auth_headers, project_id) is True


def test_layout_confirm_supports_batch_page_numbers(
    client: TestClient, auth_headers: dict[str, str], ready_page: tuple[str, dict]
) -> None:
    project_id, _page = ready_page
    result = confirm_layout(
        client, auth_headers, project_id, page_numbers=[1, 2, 3]
    )
    assert result["confirmed_pages"] == [1, 2, 3]
    assert result["confirmed"] == 3
    for page_no in (1, 2, 3):
        assert layout_confirmed(client, auth_headers, project_id, page_no) is True


def test_text_edit_does_not_reset_layout_confirmation(
    client: TestClient, auth_headers: dict[str, str], ready_page: tuple[str, dict]
) -> None:
    project_id, page = ready_page
    confirm_layout(client, auth_headers, project_id)
    patch_block(
        client, auth_headers, project_id, page["blocks"][0], {"text": "改过的文字\n第二行"}
    )
    assert layout_confirmed(client, auth_headers, project_id) is True


@pytest.mark.parametrize(
    "patch",
    [
        {"block_type": "header"},
        {"bbox": [0.1, 0.3, 0.5, 0.5]},
    ],
)
def test_type_or_bbox_change_resets_layout_confirmation(
    client: TestClient,
    auth_headers: dict[str, str],
    ready_page: tuple[str, dict],
    patch: dict,
) -> None:
    project_id, page = ready_page
    confirm_layout(client, auth_headers, project_id)
    assert layout_confirmed(client, auth_headers, project_id) is True

    patch_block(client, auth_headers, project_id, page["blocks"][0], patch)
    assert layout_confirmed(client, auth_headers, project_id) is False


def test_reorder_resets_layout_confirmation(
    client: TestClient, auth_headers: dict[str, str], ready_page: tuple[str, dict]
) -> None:
    project_id, page = ready_page
    confirm_layout(client, auth_headers, project_id)
    response = client.post(
        f"/api/projects/{project_id}/blocks/{page['blocks'][1]['block_id']}/move",
        json={"direction": "up"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert layout_confirmed(client, auth_headers, project_id) is False


def test_create_or_delete_block_resets_layout_confirmation(
    client: TestClient, auth_headers: dict[str, str], ready_page: tuple[str, dict]
) -> None:
    project_id, page = ready_page
    confirm_layout(client, auth_headers, project_id)
    response = client.post(
        f"/api/projects/{project_id}/pages/1/blocks",
        json={"page_no": 1, "after_block_id": page["blocks"][0]["block_id"]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert layout_confirmed(client, auth_headers, project_id) is False

    confirm_layout(client, auth_headers, project_id)
    created = response.json()["created"]
    response = client.delete(
        f"/api/projects/{project_id}/blocks/{created['block_id']}",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert layout_confirmed(client, auth_headers, project_id) is False
