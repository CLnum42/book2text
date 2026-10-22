"""脚注 / 旁批建议的接口级测试（任务 52）。

只读建议：脚注 / 旁批永远 review；「全库采用高把握建议」不碰它们。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.storage import db as db_module
from book2text.core.storage.ulid import new_ulid
from tests.integration.test_structure_tools_api import add_block


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "注文建议测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def add_lines(library_dir: Path, project_id: str, block_id: str, boxes) -> None:
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        for index, box in enumerate(boxes):
            conn.execute(
                "INSERT INTO block_line (line_id, block_id, line_index, bbox, text)"
                " VALUES (?, ?, ?, ?, '')",
                (new_ulid(), block_id, index, json.dumps(box)),
            )
        conn.commit()


def set_margin(client: TestClient, headers: dict[str, str], project_id: str) -> None:
    response = client.put(
        f"/api/projects/{project_id}/margin-box",
        json={"margin_box": [0.1, 0.1, 0.9, 0.9]},
        headers=headers,
    )
    assert response.status_code == 200, response.text


@pytest.fixture
def page_with_notes(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
) -> tuple[str, dict[str, str]]:
    project_id = create_project(client, auth_headers, sample_pdf)
    body_id = add_block(
        library_dir, project_id, page_no=1, text="正文段落",
        bbox=[0.1, 0.2, 0.9, 0.26],
    )
    add_lines(library_dir, project_id, body_id, [[0.1, 0.2, 0.9, 0.22], [0.1, 0.23, 0.9, 0.25]])

    note_id = add_block(
        library_dir, project_id, page_no=1, text="1 注文：卢那察尔斯基",
        bbox=[0.1, 0.85, 0.9, 0.87],
    )
    add_lines(library_dir, project_id, note_id, [[0.1, 0.85, 0.9, 0.865]])

    long_text = "这是很长的正文段落，" * 20
    long_id = add_block(
        library_dir, project_id, page_no=1, text=long_text,
        bbox=[0.1, 0.72, 0.9, 0.80],
    )
    add_lines(library_dir, project_id, long_id, [[0.1, 0.72, 0.9, 0.74], [0.1, 0.75, 0.9, 0.77]])

    side_id = add_block(
        library_dir, project_id, page_no=1, text="旁批：这一行要核对",
        bbox=[0.02, 0.5, 0.08, 0.55],
    )
    add_lines(library_dir, project_id, side_id, [[0.02, 0.5, 0.08, 0.52]])

    number_id = add_block(
        library_dir, project_id, page_no=1, text="11",
        bbox=[0.45, 0.96, 0.55, 0.98],
    )
    add_lines(library_dir, project_id, number_id, [[0.45, 0.96, 0.55, 0.98]])

    set_margin(client, auth_headers, project_id)
    return project_id, {
        "body": body_id,
        "note": note_id,
        "long": long_id,
        "side": side_id,
        "number": number_id,
    }


def suggestions(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/1/block-suggestions", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_footnote_and_margin_note_are_review_only(
    client: TestClient,
    auth_headers: dict[str, str],
    page_with_notes: tuple[str, dict[str, str]],
) -> None:
    project_id, ids = page_with_notes
    data = suggestions(client, auth_headers, project_id)
    by_id = {item["block_id"]: item for item in data["suggestions"]}

    note = by_id[ids["note"]]
    assert note["suggested_type"] == "footnote"
    assert note["confidence"] == "review"
    assert note["confidence_label"] == "需确认"
    assert len(note["note_signals"]) >= 2
    assert "脚注建议只给「需确认」" in note["reason"]

    side = by_id[ids["side"]]
    assert side["suggested_type"] == "margin_note"
    assert side["confidence"] == "review"
    assert "旁批建议只给「需确认」" in side["reason"]

    # 长正文末段即使位置 + 间距像，也不能给脚注
    assert ids["long"] not in by_id
    # 纯数字是页码（high），不是脚注
    number = by_id[ids["number"]]
    assert number["suggested_type"] == "page_number"
    assert number["confidence"] == "high"

    # 全局不变式：这两个类型的建议永远不是 high
    assert all(
        item["confidence"] != "high"
        for item in data["suggestions"]
        if item["suggested_type"] in {"footnote", "margin_note"}
    )


def test_high_suggestion_apply_never_touches_notes(
    client: TestClient,
    auth_headers: dict[str, str],
    page_with_notes: tuple[str, dict[str, str]],
) -> None:
    project_id, ids = page_with_notes
    response = client.post(
        f"/api/projects/{project_id}/suggestions/apply",
        json={"dry_run": True},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert "footnote" not in data["by_type"]
    assert "margin_note" not in data["by_type"]
    # 页码仍然是 high（正常入口）
    assert data["by_type"].get("page_number", 0) >= 1
    assert all(item["block_id"] != ids["note"] for item in data["samples"])
    assert all(item["block_id"] != ids["side"] for item in data["samples"])


def test_high_scan_skips_note_like_blocks_at_page_edge(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
) -> None:
    """边缘条带会把版心底部的注文算成 high 页脚——全库扫描必须再挡一次。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    note_ids = [
        add_block(
            library_dir, project_id, page_no=page_no, text="① 注文：译者说明",
            bbox=[0.2, 0.94, 0.8, 0.96],
        )
        for page_no in (1, 2, 3)
    ]
    response = client.put(
        f"/api/projects/{project_id}/margin-box",
        json={"margin_box": [0.1, 0.1, 0.9, 0.98]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text

    page_suggestions = suggestions(client, auth_headers, project_id)
    by_id = {item["block_id"]: item for item in page_suggestions["suggestions"]}
    assert by_id[note_ids[0]]["suggested_type"] == "footnote"
    assert by_id[note_ids[0]]["confidence"] == "review"

    response = client.post(
        f"/api/projects/{project_id}/suggestions/apply",
        json={"dry_run": True},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert "footnote" not in data["by_type"]
    assert "footer" not in data["by_type"]
    assert all(item["block_id"] not in note_ids for item in data["samples"])
