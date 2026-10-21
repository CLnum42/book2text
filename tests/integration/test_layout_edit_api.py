"""版面块编辑的集成测试（改框 → 行归属重算 → 导出；第 35 号任务）。

用假引擎识别两段文字（三行 → 两块），然后走真实的 PATCH / 导出路径。
重点：改框**不重跑 OCR**（引擎调用次数不变），行只搬 block_line，冲突 / 未归属都留痕。
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
        params={"name": "版面测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [page_no], "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def page_data(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def lines_by_block(page: dict) -> dict[str, list[dict]]:
    return {block["block_id"]: block["lines"] for block in page["blocks"]}


def patch_block(
    client: TestClient,
    headers: dict[str, str],
    project_id: str,
    block: dict,
    patch: dict,
) -> dict:
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={**patch, "expected_revision": block["revision"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()["block"]


def preview(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/export/preview",
        json={"format": "txt", "page_types": ["body"], "page_numbers": [1]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def preflight(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/export/preflight",
        json={"format": "txt", "page_types": ["body"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def event_actions(library_dir: Path, project_id: str) -> list[str]:
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        rows = conn.execute("SELECT action FROM event ORDER BY created_at, event_id").fetchall()
    return [row["action"] for row in rows]


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


# ---------------------------------------------------------------- 改框 → 行归属

def test_moving_a_box_away_marks_its_lines_unassigned(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    ready_page: tuple[str, dict],
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id, page = ready_page
    first, second = page["blocks"]
    calls_before = inprocess_jobs.calls

    moved = patch_block(
        client, auth_headers, project_id, first, {"bbox": [0.0, 0.0, 0.05, 0.05]}
    )
    assert moved["bbox"] == [0.0, 0.0, 0.05, 0.05]
    assert inprocess_jobs.calls == calls_before, "改框绝不能重跑 OCR"

    after = page_data(client, auth_headers, project_id)
    block_lines = lines_by_block(after)
    assert all(line["layout_status"] == "unassigned" for line in block_lines[first["block_id"]])
    assert all(line["layout_status"] == "assigned" for line in block_lines[second["block_id"]])
    assert after["layout_lines"] == {"assigned": 1, "conflict": 0, "unassigned": 2}
    # 行没有被删除，还留在原来的块下
    assert len(block_lines[first["block_id"]]) == 2

    assert "set_bbox" in event_actions(library_dir, project_id)
    assert "reassign_line" in event_actions(library_dir, project_id)


def test_moving_a_box_over_lines_takes_them_from_the_old_block(
    client: TestClient,
    auth_headers: dict[str, str],
    ready_page: tuple[str, dict],
) -> None:
    project_id, page = ready_page
    first, second = page["blocks"]
    # 先把第一块的框挪开，让它的两行变成未归属
    patch_block(client, auth_headers, project_id, first, {"bbox": [0.0, 0.0, 0.05, 0.05]})
    # 再把第二块的框扩大到第一段所在的位置
    second = next(
        block for block in page_data(client, auth_headers, project_id)["blocks"]
        if block["block_id"] == second["block_id"]
    )
    patch_block(client, auth_headers, project_id, second, {"bbox": [0.05, 0.09, 0.95, 0.18]})

    after = page_data(client, auth_headers, project_id)
    block_lines = lines_by_block(after)
    assert block_lines[first["block_id"]] == [], "两行搬走了"
    taken = block_lines[second["block_id"]]
    assert [line["line_index"] for line in taken] == [0, 1, 2]
    # 第二块原来的第三行（0.26–0.29）现在在框外 → 未归属，且没有丢
    assert [line["layout_status"] for line in taken] == ["assigned", "assigned", "unassigned"]
    assert after["layout_lines"] == {"assigned": 2, "conflict": 0, "unassigned": 1}


def test_a_line_in_two_boxes_is_a_conflict(
    client: TestClient,
    auth_headers: dict[str, str],
    ready_page: tuple[str, dict],
) -> None:
    project_id, page = ready_page
    first, second = page["blocks"]
    patch_block(client, auth_headers, project_id, first, {"bbox": [0.0, 0.09, 1.0, 0.18]})
    second = next(
        block for block in page_data(client, auth_headers, project_id)["blocks"]
        if block["block_id"] == second["block_id"]
    )
    patch_block(client, auth_headers, project_id, second, {"bbox": [0.0, 0.11, 1.0, 0.31]})

    after = page_data(client, auth_headers, project_id)
    assert after["layout_lines"] == {"assigned": 1, "conflict": 2, "unassigned": 0}
    first_lines = lines_by_block(after)[first["block_id"]]
    assert [line["layout_status"] for line in first_lines] == ["conflict", "conflict"]


def test_undo_restores_boxes_and_line_assignment(
    client: TestClient,
    auth_headers: dict[str, str],
    ready_page: tuple[str, dict],
) -> None:
    project_id, page = ready_page
    first = page["blocks"][0]
    patch_block(client, auth_headers, project_id, first, {"bbox": [0.0, 0.0, 0.05, 0.05]})
    assert page_data(client, auth_headers, project_id)["layout_lines"]["unassigned"] == 2

    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undone.status_code == 200, undone.text
    after = undone.json()
    restored = next(block for block in after["blocks"] if block["block_id"] == first["block_id"])
    assert restored["bbox"] == first["bbox"]
    assert all(line["layout_status"] == "assigned" for line in restored["lines"])
    for block in after["blocks"]:
        assert all(line["layout_status"] == "assigned" for line in block["lines"])


@pytest.mark.parametrize(
    "bbox",
    [
        [-0.1, 0.1, 0.5, 0.5],
        [0.1, 0.1, 0.5, 1.5],
        [0.5, 0.1, 0.4, 0.5],
        [0.1, 0.1, 0.1001, 0.5],
    ],
)
def test_bad_boxes_are_refused(
    client: TestClient,
    auth_headers: dict[str, str],
    ready_page: tuple[str, dict],
    bbox: list[float],
) -> None:
    project_id, page = ready_page
    block = page["blocks"][0]
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"bbox": bbox, "expected_revision": block["revision"]},
        headers=auth_headers,
    )
    assert response.status_code == 400, response.text


# ---------------------------------------------------------------- 版面确认

def test_layout_confirmation_is_a_marker_and_undoable(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    ready_page: tuple[str, dict],
) -> None:
    project_id, page = ready_page
    block = page["blocks"][0]
    assert block["layout_confirmed"] is False
    assert preflight(client, auth_headers, project_id)["layout_confirmed_blocks"] == 0

    confirmed = patch_block(client, auth_headers, project_id, block, {"layout_confirmed": True})
    assert confirmed["layout_confirmed"] is True
    assert preflight(client, auth_headers, project_id)["layout_confirmed_blocks"] == 1
    assert "set_layout_confirmed" in event_actions(library_dir, project_id)

    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers).json()
    restored = next(
        item for item in undone["blocks"] if item["block_id"] == block["block_id"]
    )
    assert restored["layout_confirmed"] is False


# ---------------------------------------------------------------- 类型与导出

def test_reordering_changes_export_order(
    client: TestClient, auth_headers: dict[str, str], ready_page: tuple[str, dict]
) -> None:
    project_id, page = ready_page
    first, second = page["blocks"]
    before = preview(client, auth_headers, project_id)
    assert before["segments"][0]["block_ids"][0] == first["block_id"]

    response = client.post(
        f"/api/projects/{project_id}/blocks/{second['block_id']}/move",
        json={"direction": "up"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text

    after = preview(client, auth_headers, project_id)
    assert after["segments"][0]["block_ids"][0] == second["block_id"], "导出按 order_index 走"


@pytest.mark.parametrize("block_type", ["figure", "decoration"])
def test_text_free_types_are_never_exported(
    client: TestClient,
    auth_headers: dict[str, str],
    ready_page: tuple[str, dict],
    block_type: str,
) -> None:
    project_id, page = ready_page
    target = page["blocks"][1]
    assert target["text"], "这个块本来有文本，才需要验证它被排除"
    updated = patch_block(client, auth_headers, project_id, target, {"block_type": block_type})
    assert updated["block_type"] == block_type

    after = preview(client, auth_headers, project_id)
    exported = {block_id for segment in after["segments"] for block_id in segment["block_ids"]}
    assert target["block_id"] not in exported
    assert block_type in after["preflight"]["excluded_block_types"]


def test_a_block_can_exist_without_text(
    client: TestClient, auth_headers: dict[str, str], ready_page: tuple[str, dict]
) -> None:
    project_id, _page = ready_page
    response = client.post(
        f"/api/projects/{project_id}/pages/1/blocks",
        json={"bbox": [0.2, 0.4, 0.8, 0.6], "text": ""},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    created = response.json()["created"]
    assert created["text"] == ""
    assert created["bbox"] == [0.2, 0.4, 0.8, 0.6]
    assert created["layout_confirmed"] is False

    after = page_data(client, auth_headers, project_id)
    shown = next(block for block in after["blocks"] if block["block_id"] == created["block_id"])
    assert shown["lines"] == []
    assert shown["text"] == ""
    assert shown["block_type"] == "paragraph"


def test_page_payload_reports_layout_line_counts(
    client: TestClient, auth_headers: dict[str, str], ready_page: tuple[str, dict]
) -> None:
    project_id, page = ready_page
    assert page["layout_lines"] == {"assigned": 3, "conflict": 0, "unassigned": 0}
    assert page["review"]["layout_confirmed"] == 0
