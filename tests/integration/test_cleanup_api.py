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


def _page_blocks(client: TestClient, headers, project_id: str, page_no: int) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def _find_block(client: TestClient, headers, project_id: str, page_no: int, block_id: str) -> dict:
    payload = _page_blocks(client, headers, project_id, page_no)
    return next(block for block in payload["blocks"] if block["block_id"] == block_id)


def test_continuation_pending_lists_review_bucket_with_context(
    client: TestClient,
    auth_headers: dict[str, str],
    cleanup_project: dict,
) -> None:
    """任务 42：F1 第三桶必须有人能看到——每条都带两页原文，不用回上下文猜。"""
    project_id = cleanup_project["project"]
    response = client.get(
        f"/api/projects/{project_id}/cleanup/continuations/pending", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["count"] == 1
    assert data["total"] == 4  # 四个页边界
    entry = data["entries"][0]
    assert entry["page_no"] == 4
    assert entry["next_page_no"] == 5
    assert entry["bucket"] == "review"
    assert entry["reviewed"] is False
    assert entry["continues_to_next"] is False
    assert "走满但句末。" in entry["last_text"]
    assert entry["next_text"], "下页首行原文要带上，人才判断得了这一段是否跨页"
    assert entry["gap"] is not None
    # G 刀：面板要在交界两行上画框，坐标必须给到
    assert len(entry["last_bbox"]) == 4
    assert len(entry["next_bbox"]) == 4
    assert all(0.0 <= value <= 1.0 for value in entry["last_bbox"] + entry["next_bbox"])
    # 框要落在真实行上：夹具里第 4 页末行 y0=0.12，第 5 页首行 y0=0.05
    assert abs(entry["last_bbox"][1] - 0.12) < 1e-6
    assert abs(entry["next_bbox"][1] - 0.05) < 1e-6
    assert entry["last_bbox"] != entry["next_bbox"]


def test_continuation_resolve_end_is_recorded_and_can_reopen(
    client: TestClient,
    auth_headers: dict[str, str],
    cleanup_project: dict,
) -> None:
    """「标结束」时块的值本来就是 0——必须靠 continues_reviewed 记住"人看过"。"""
    project_id = cleanup_project["project"]
    base = f"/api/projects/{project_id}/cleanup/continuations"
    block_id = client.get(f"{base}/pending", headers=auth_headers).json()["entries"][0][
        "block_id"
    ]

    resolved = client.post(
        f"{base}/resolve",
        json={"block_id": block_id, "continues": False},
        headers=auth_headers,
    )
    assert resolved.status_code == 200, resolved.text
    payload = resolved.json()
    assert payload["reviewed"] is True
    assert payload["continues_to_next"] is False
    assert payload["remaining"] == 0
    assert client.get(f"{base}/pending", headers=auth_headers).json()["count"] == 0

    block = _find_block(client, auth_headers, project_id, 4, block_id)
    assert block["continues_reviewed"] is True
    assert block["continues_to_next"] is False

    # 确认过的不能重复确认（避免把别处的裁决当成这一处）
    again = client.post(
        f"{base}/resolve",
        json={"block_id": block_id, "continues": True},
        headers=auth_headers,
    )
    assert again.status_code == 400, again.text

    # 改判：放回待确认，值不变
    reopened = client.post(
        f"{base}/reopen", json={"block_id": block_id}, headers=auth_headers
    )
    assert reopened.status_code == 200, reopened.text
    assert reopened.json()["bucket"] == "review"
    assert reopened.json()["remaining"] == 1
    block = _find_block(client, auth_headers, project_id, 4, block_id)
    assert block["continues_reviewed"] is False
    assert block["continues_to_next"] is False


def test_continuation_resolve_only_accepts_review_bucket(
    client: TestClient,
    auth_headers: dict[str, str],
    cleanup_project: dict,
) -> None:
    """自动判定能定的页边界不走人工接口：防止面板/接口把机器判定当人工裁决写坏。"""
    project_id = cleanup_project["project"]
    base = f"/api/projects/{project_id}/cleanup/continuations"
    # 第 1 页末块属于 continue 桶（自动判定能定），不是待人工
    blocks = _page_blocks(client, auth_headers, project_id, 1)["blocks"]
    auto_block = blocks[-1]["block_id"]
    response = client.post(
        f"{base}/resolve",
        json={"block_id": auto_block, "continues": True},
        headers=auth_headers,
    )
    assert response.status_code == 400, response.text
    assert "待人工" in response.json()["error"]["detail"]


def test_continuation_resolve_is_undoable(
    client: TestClient,
    auth_headers: dict[str, str],
    cleanup_project: dict,
) -> None:
    """每条确认都是一个可撤销批次：撤销后这一处回到待确认，值也回去。"""
    project_id = cleanup_project["project"]
    base = f"/api/projects/{project_id}/cleanup/continuations"
    block_id = client.get(f"{base}/pending", headers=auth_headers).json()["entries"][0][
        "block_id"
    ]
    resolved = client.post(
        f"{base}/resolve",
        json={"block_id": block_id, "continues": True},
        headers=auth_headers,
    )
    assert resolved.status_code == 200, resolved.text
    assert resolved.json()["history"]["undo"] >= 1
    assert _find_block(client, auth_headers, project_id, 4, block_id)[
        "continues_to_next"
    ] is True

    undo = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undo.status_code == 200, undo.text
    assert client.get(f"{base}/pending", headers=auth_headers).json()["count"] == 1
    block = _find_block(client, auth_headers, project_id, 4, block_id)
    assert block["continues_reviewed"] is False
    assert block["continues_to_next"] is False


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


def test_human_continuation_decision_is_not_overwritten_by_auto_apply(
    client: TestClient,
    auth_headers: dict[str, str],
    cleanup_project: dict,
) -> None:
    """人工裁决过的边界，重跑自动判定不许覆盖（包括"标结束"这种值没变的情况）。"""
    project_id = cleanup_project["project"]
    base = f"/api/projects/{project_id}/cleanup/continuations"
    block_id = client.get(f"{base}/pending", headers=auth_headers).json()["entries"][0][
        "block_id"
    ]
    resolved = client.post(
        f"{base}/resolve",
        json={"block_id": block_id, "continues": False},
        headers=auth_headers,
    )
    assert resolved.status_code == 200, resolved.text

    applied = client.post(base, headers=auth_headers)
    assert applied.status_code == 200, applied.text
    stats = applied.json()["stats"]
    assert stats["review"] == 0
    assert stats["manual"] == 2  # 第 3 页人工 + 第 4 页这次裁决
    assert applied.json()["changed"] == 1  # 只有第 1 页的延续是真正新写的
    block = _find_block(client, auth_headers, project_id, 4, block_id)
    assert block["continues_to_next"] is False, "人工判为结束，自动判定不许改成延续"
    assert block["continues_reviewed"] is True
