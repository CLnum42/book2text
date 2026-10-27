"""批量数据清理（任务 41）：跨页延续自动判定 + 家具块类型清理。

两条纪律都在测试里钉住：

- F1：三桶（continue / end / review），人工标过的不覆盖；只改 `continues_to_next`；
- F2：**整块**都是家具才改类型，块里混一行正文就不动；不按行拆。

两件都整批一个 batch，撤销一次回到原样。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import furniture as furniture_module
from book2text.core.storage import db as db_module
from book2text.core.storage.ulid import new_ulid


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "数据清理测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def set_margin(client: TestClient, headers, project_id: str, page_no: int) -> None:
    response = client.patch(
        f"/api/projects/{project_id}/pages/{page_no}/margin-box",
        json={"margin_box_mode": "custom", "margin_box": [0.05, 0.05, 0.95, 0.95]},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def add_block(
    library_dir: Path,
    project_id: str,
    *,
    page_no: int,
    lines: list[tuple[str, float, float, float, float]],
    continues: bool = False,
) -> str:
    """插入一个块与若干行：lines = [(text, x0, y0, x1, y1), ...]（归一化）。"""
    block_id = new_ulid()
    top = min(line[2] for line in lines)
    bottom = max(line[4] for line in lines)
    bbox = [min(line[1] for line in lines), top, max(line[3] for line in lines), bottom]
    now = "2026-01-01T00:00:00+00:00"
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        page = conn.execute(
            "SELECT page_id FROM page WHERE page_no = ?", (page_no,)
        ).fetchone()
        order = conn.execute(
            "SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM block WHERE page_id = ?",
            (page["page_id"],),
        ).fetchone()["next"]
        conn.execute(
            """
            INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,
                               ocr_text, text, review_status, include, continues_to_next,
                               revision, created_at, updated_at)
            VALUES (?, ?, 'ocr', ?, ?, 'paragraph', ?, ?, 'unreviewed', 1, ?, 0, ?, ?)
            """,
            (
                block_id,
                page["page_id"],
                order,
                json.dumps(bbox),
                "".join(line[0] for line in lines),
                "\n".join(line[0] for line in lines),
                1 if continues else 0,
                now,
                now,
            ),
        )
        for index, (text, x0, y0, x1, y1) in enumerate(lines):
            conn.execute(
                "INSERT INTO block_line (line_id, block_id, line_index, bbox, text)"
                " VALUES (?, ?, ?, ?, ?)",
                (new_ulid(), block_id, index, json.dumps([x0, y0, x1, y1]), text),
            )
        conn.commit()
    return block_id


@pytest.fixture
def cleanup_project(
    client: TestClient,
    auth_headers: dict[str, str],
    scan_sample_pdf: Path,
    library_dir: Path,
) -> dict:
    project_id = create_project(client, auth_headers, scan_sample_pdf)
    for page_no in range(1, 6):
        set_margin(client, auth_headers, project_id, page_no)

    # 四个页边界：continue / end / manual / review
    add_block(
        library_dir,
        project_id,
        page_no=1,
        lines=[
            ("第一行，", 0.10, 0.10, 0.90, 0.12),
            ("第二行，", 0.10, 0.12, 0.90, 0.14),
            ("页末走满且逗号", 0.10, 0.14, 0.94, 0.16),
        ],
    )
    add_block(
        library_dir,
        project_id,
        page_no=2,
        lines=[
            ("短行结束", 0.10, 0.10, 0.90, 0.12),
            ("页末短句。", 0.10, 0.12, 0.40, 0.14),
        ],
    )
    manual_block = add_block(
        library_dir,
        project_id,
        page_no=3,
        lines=[
            ("人工标过，", 0.10, 0.10, 0.90, 0.12),
            ("页末走满但人工不改", 0.10, 0.12, 0.94, 0.14),
        ],
        continues=True,
    )
    # 人工把它改成 0（事件 actor=user），自动判定必须不覆盖
    patched = client.patch(
        f"/api/projects/{project_id}/blocks/{manual_block}",
        json={"continues_to_next": False},
        headers=auth_headers,
    )
    assert patched.status_code == 200, patched.text
    add_block(
        library_dir,
        project_id,
        page_no=4,
        lines=[
            ("正文行。", 0.10, 0.10, 0.90, 0.12),
            ("走满但句末。", 0.10, 0.12, 0.94, 0.14),
        ],
    )
    # 第 5 页：两个整块家具 + 一个混着正文的块（不能动）+ 一个正文块
    header_block = add_block(
        library_dir, project_id, page_no=5,
        lines=[("红楼梦", 0.10, 0.05, 0.30, 0.07), ("238", 0.10, 0.07, 0.20, 0.09)],
    )
    number_block = add_block(
        library_dir, project_id, page_no=5,
        lines=[("99", 0.10, 0.10, 0.18, 0.12)],
    )
    mixed_block = add_block(
        library_dir, project_id, page_no=5,
        lines=[
            ("正文第一行", 0.10, 0.15, 0.90, 0.17),
            ("红楼梦", 0.10, 0.17, 0.30, 0.19),
            ("正文第二行", 0.10, 0.19, 0.90, 0.21),
        ],
    )
    add_block(
        library_dir, project_id, page_no=5,
        lines=[("后面的正文。", 0.10, 0.25, 0.90, 0.27)],
    )
    return {
        "project": project_id,
        "manual_block": manual_block,
        "header_block": header_block,
        "number_block": number_block,
        "mixed_block": mixed_block,
    }


def test_continuation_plan_and_apply_buckets(
    client: TestClient,
    auth_headers: dict[str, str],
    cleanup_project: dict,
) -> None:
    project_id = cleanup_project["project"]
    response = client.get(
        f"/api/projects/{project_id}/cleanup/continuations", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    stats = response.json()["stats"]
    assert stats["boundaries"] == 4
    assert stats["continue"] == 1
    assert stats["end"] == 1
    assert stats["review"] == 1
    assert stats["manual"] == 1

    applied = client.post(
        f"/api/projects/{project_id}/cleanup/continuations", headers=auth_headers
    )
    assert applied.status_code == 200, applied.text
    result = applied.json()
    assert result["stats"]["continue"] == 1
    assert result["changed"] == 1  # end 那条本来就是 0，不写无用事件
    assert result["history"]["undo"] >= 1

    undo = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undo.status_code == 200, undo.text
    assert undo.json()["changed_blocks"] == 1


def test_furniture_only_marks_all_furniture_blocks_and_undoes(
    client: TestClient,
    auth_headers: dict[str, str],
    cleanup_project: dict,
) -> None:
    project_id = cleanup_project["project"]
    response = client.get(
        f"/api/projects/{project_id}/cleanup/furniture", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    plan = response.json()
    assert plan["stats"]["blocks"] == 2
    assert plan["stats"]["by_type"] == {"header": 1, "page_number": 1}
    by_id = {entry["block_id"]: entry["proposed_type"] for entry in plan["entries"]}
    assert by_id[cleanup_project["header_block"]] == "header"
    assert by_id[cleanup_project["number_block"]] == "page_number"
    # 混着正文的块不动（它有一行正好是「红楼梦」）
    assert cleanup_project["mixed_block"] not in by_id

    applied = client.post(
        f"/api/projects/{project_id}/cleanup/furniture", headers=auth_headers
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["changed"] == 2
    assert applied.json()["by_type"] == {"header": 1, "page_number": 1}

    types = _block_types(client, auth_headers, project_id)
    assert types[cleanup_project["header_block"]] == "header"
    assert types[cleanup_project["number_block"]] == "page_number"
    assert types[cleanup_project["mixed_block"]] == "paragraph"

    undo = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undo.status_code == 200, undo.text
    types = _block_types(client, auth_headers, project_id)
    assert types[cleanup_project["header_block"]] == "paragraph"
    assert types[cleanup_project["number_block"]] == "paragraph"


def test_furniture_line_rules_are_conservative() -> None:
    # 书眉 / 页码 / OCR 噪声 → 家具
    for text in ("红楼梦", "红楼梦238", "红楼梦SO", "红楼梦/", "860S8", "x", "州红楼梦", "99"):
        assert furniture_module._is_furniture_line(text), text
    # 正文行（含整行「红楼梦」/「99」，它们是靠"块里还有别的正文行"保护的）
    for text in ("西施", "虞姬", "{《红楼梦》第三卷终}", "第三卷终", "；", "这是一行正文"):
        assert not furniture_module._is_furniture_line(text), text


def _block_types(client: TestClient, headers, project_id: str) -> dict[str, str]:
    pages = client.get(f"/api/projects/{project_id}/pages", headers=headers).json()["pages"]
    result: dict[str, str] = {}
    for page in pages:
        payload = client.get(
            f"/api/projects/{project_id}/pages/{page['page_no']}/blocks", headers=headers
        ).json()
        for block in payload["blocks"]:
            result[block["block_id"]] = block["block_type"]
    return result
