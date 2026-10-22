"""块类型建议接口（只读）的集成测试。

验收要求有三条，这里逐条钉住：

1. 第 30 页那种"书眉 + 页码挤在一行"的块能给出 header 建议，并把页码候选
   （`2` / `11`）一起返回；
2. 正文块不出建议（正文里单独出现的数字不能被当页码）；
3. **调完接口后 `block_type` 一个都没变**（本文件用数据库快照对比，不依赖接口自述）。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.storage import db as db_module
from book2text.core.storage.ulid import new_ulid
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "块建议", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, *pages: int) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": list(pages), "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def add_block(
    library_dir: Path,
    project_id: str,
    *,
    page_no: int,
    text: str,
    bbox: list[float],
    block_type: str = "paragraph",
) -> str:
    """直接往库里塞块：造出页眉 / 页码 / 标题这类真实书页上才有的东西。"""
    block_id = new_ulid()
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        page = conn.execute("SELECT page_id FROM page WHERE page_no = ?", (page_no,)).fetchone()
        order = conn.execute(
            "SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM block WHERE page_id = ?",
            (page["page_id"],),
        ).fetchone()["next"]
        conn.execute(
            """
            INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,
                               ocr_text, text, review_status, include, continues_to_next,
                               revision, created_at, updated_at)
            VALUES (?, ?, 'ocr', ?, ?, ?, ?, ?, 'unreviewed', 1, 0, 0, ?, ?)
            """,
            (
                block_id,
                page["page_id"],
                order,
                str(bbox).replace("'", '"'),
                block_type,
                text,
                text,
                "2026-01-01T00:00:00+00:00",
                "2026-01-01T00:00:00+00:00",
            ),
        )
        conn.commit()
    return block_id


def block_state(library_dir: Path, project_id: str) -> tuple[list[tuple], int]:
    """块的类型 / 版本 / 更新时间，加事件条数——接口前后必须完全一致。"""
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT block_id, block_type, revision, updated_at FROM block "
            "WHERE deleted_at IS NULL ORDER BY block_id"
        ).fetchall()
        events = conn.execute("SELECT COUNT(*) AS n FROM event").fetchone()["n"]
    return [tuple(row) for row in rows], events


def suggestions(client: TestClient, headers: dict[str, str], project_id: str, page_no: int) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/block-suggestions", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def project_with_chrome(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> dict:
    """三页：每页都有同一条书眉和页码；第 2 页另有一条"书眉 + 页码同行"。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1, 2, 3)

    blocks = {}
    for page_no, number in ((1, "10"), (2, "11"), (3, "12")):
        blocks[f"header_{page_no}"] = add_block(
            library_dir, project_id, page_no=page_no,
            text="第一章 测试", bbox=[0.1, 0.02, 0.5, 0.05],
        )
        blocks[f"number_{page_no}"] = add_block(
            library_dir, project_id, page_no=page_no,
            text=number, bbox=[0.02, 0.96, 0.06, 0.98],
        )
        blocks[f"footer_{page_no}"] = add_block(
            library_dir, project_id, page_no=page_no,
            text="第二版 · 测试", bbox=[0.1, 0.93, 0.5, 0.95],
        )
    # 第二本书第 30 页的真实形态：节号 + 节名 + 页码挤在一行
    blocks["merged_header"] = add_block(
        library_dir, project_id, page_no=2,
        text="2 谁是巴赫金? 11", bbox=[0.6, 0.02, 0.9, 0.05],
    )
    # 正文里的数字：不能被当成页码
    blocks["body_number"] = add_block(
        library_dir, project_id, page_no=1,
        text="1999", bbox=[0.1, 0.5, 0.9, 0.53],
    )
    # 章题：只给 heading review，永不 high
    blocks["heading"] = add_block(
        library_dir, project_id, page_no=1,
        text="第一回\n甄士隐梦幻识通灵\n贾雨村风尘怀闺秀",
        bbox=[0.13, 0.14, 0.38, 0.23],
    )
    return {"project_id": project_id, "blocks": blocks, "library_dir": library_dir}


def test_suggestions_find_chrome_and_never_touch_body(
    client: TestClient, auth_headers: dict[str, str], project_with_chrome: dict
) -> None:
    project_id = project_with_chrome["project_id"]
    blocks = project_with_chrome["blocks"]
    before = block_state(project_with_chrome["library_dir"], project_id)

    data = suggestions(client, auth_headers, project_id, 2)
    assert data["suggestion_count"] == 4
    by_id = {item["block_id"]: item for item in data["suggestions"]}

    # 跨 3 页重复的书眉 → header high
    header = by_id[blocks["header_2"]]
    assert header["suggested_type"] == "header"
    assert header["confidence"] == "high"
    assert header["current_type"] == "paragraph"

    # 页码 → page_number high
    number = by_id[blocks["number_2"]]
    assert number["suggested_type"] == "page_number"
    assert number["confidence"] == "high"
    assert number["page_number_hint"]["text"] == "11"

    # 书眉 + 页码同行 → header（review：这一页的节名只出现一次），页码候选都返回
    merged = by_id[blocks["merged_header"]]
    assert merged["suggested_type"] == "header"
    assert merged["confidence"] == "review"
    assert [item["text"] for item in merged["page_number_candidates"]] == ["2", "11"]
    assert merged["page_number_hint"]["text"] == "11"

    # 跨页重复的页脚 → footer high
    footer = by_id[blocks["footer_2"]]
    assert footer["suggested_type"] == "footer"
    assert footer["confidence"] == "high"

    # 正文里的 1999 不出现在建议里；第 2 页也没有别的建议
    assert blocks["body_number"] not in by_id
    assert set(by_id) == {
        blocks["header_2"], blocks["number_2"], blocks["merged_header"], blocks["footer_2"],
    }

    # 只读：块类型 / revision / updated_at / 事件数一个都没变
    assert block_state(project_with_chrome["library_dir"], project_id) == before


def test_heading_is_only_ever_a_review_suggestion(
    client: TestClient, auth_headers: dict[str, str], project_with_chrome: dict
) -> None:
    data = suggestions(client, auth_headers, project_with_chrome["project_id"], 1)
    by_id = {item["block_id"]: item for item in data["suggestions"]}
    heading = by_id[project_with_chrome["blocks"]["heading"]]
    assert heading["suggested_type"] == "heading"
    assert heading["confidence"] == "review"
    assert all(
        item["confidence"] == "review"
        for item in data["suggestions"]
        if item["suggested_type"] == "heading"
    )


def test_already_typed_blocks_are_not_repeated(
    client: TestClient, auth_headers: dict[str, str], project_with_chrome: dict
) -> None:
    project_id = project_with_chrome["project_id"]
    blocks = project_with_chrome["blocks"]
    with db_module.open_database(
        project_with_chrome["library_dir"] / project_id, apply_migrations=False
    ) as conn:
        conn.execute(
            "UPDATE block SET block_type = 'header' WHERE block_id = ?",
            (blocks["header_2"],),
        )
        conn.commit()

    data = suggestions(client, auth_headers, project_id, 2)
    by_id = {item["block_id"]: item for item in data["suggestions"]}
    assert blocks["header_2"] not in by_id  # 已经是 header，不再报
    assert by_id[blocks["number_2"]]["suggested_type"] == "page_number"


def test_non_body_page_gets_an_empty_plan_with_a_note(
    client: TestClient, auth_headers: dict[str, str], project_with_chrome: dict
) -> None:
    project_id = project_with_chrome["project_id"]
    with db_module.open_database(
        project_with_chrome["library_dir"] / project_id, apply_migrations=False
    ) as conn:
        conn.execute("UPDATE page SET page_type = 'toc' WHERE page_no = 2")
        conn.commit()

    data = suggestions(client, auth_headers, project_id, 2)
    assert data["suggestions"] == []
    assert data["suggestion_count"] == 0
    assert "不在建议范围" in (data["note"] or "")


def test_unknown_page_is_404(
    client: TestClient, auth_headers: dict[str, str], project_with_chrome: dict
) -> None:
    response = client.get(
        f"/api/projects/{project_with_chrome['project_id']}/pages/99/block-suggestions",
        headers=auth_headers,
    )
    assert response.status_code == 404
