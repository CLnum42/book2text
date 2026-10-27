"""目录确认 / 页码跳转索引（任务 37 / C 刀）。

用户要的是"能直接跳页的页码列表"，不是书籍目录。这里钉住服务端的语义：

- 每页都出现在索引里（缺页码也不例外，`missing=true`）；
- 印刷页码优先 `page.printed_page`，否则用页码候选（不重新 OCR）；
- 编号步长（1 或 2）只解释编号规律：标签只写实际检测到的那个号，
  步长 2 时输入框额外接受"同一叶的另一面"（不写进标签）；
- 章首从页面靠前的文字块首行匹配 `^第X回`；
- 索引生成成功即"完成"，不需要人工逐条确认。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import page_index as page_index_module
from book2text.core.storage import db as db_module
from book2text.core.storage.ulid import new_ulid
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "页码索引测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(
    client: TestClient, headers: dict[str, str], project_id: str, pages: list[int]
) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": pages, "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def add_block(
    library_dir: Path,
    project_id: str,
    *,
    page_no: int,
    text: str,
    x: float,
    y: float,
    order: int | None = None,
) -> None:
    """塞一个单行块（页码行或章首行）。"""
    width, height = 0.05, 0.025
    bbox = [round(x - width / 2, 4), round(y - height / 2, 4),
            round(x + width / 2, 4), round(y + height / 2, 4)]
    block_id = new_ulid()
    line_id = new_ulid()
    now = "2026-01-01T00:00:00+00:00"
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        page = conn.execute(
            "SELECT page_id FROM page WHERE page_no = ?", (page_no,)
        ).fetchone()
        if order is None:
            order = conn.execute(
                "SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM block WHERE page_id = ?",
                (page["page_id"],),
            ).fetchone()["next"]
        conn.execute(
            """
            INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,
                               ocr_text, text, review_status, include, continues_to_next,
                               revision, created_at, updated_at)
            VALUES (?, ?, 'ocr', ?, ?, 'paragraph', ?, ?, 'unreviewed', 1, 0, 0, ?, ?)
            """,
            (block_id, page["page_id"], order, str(bbox).replace("'", '"'), text, text, now, now),
        )
        conn.execute(
            "INSERT INTO block_line (line_id, block_id, line_index, bbox, text)"
            " VALUES (?, ?, 0, ?, ?)",
            (line_id, block_id, str(bbox).replace("'", '"'), text),
        )
        conn.commit()


@pytest.fixture
def indexed_project(
    client: TestClient,
    auth_headers: dict[str, str],
    scan_sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
    library_dir: Path,
) -> str:
    project_id = create_project(client, auth_headers, scan_sample_pdf)
    recognize(client, auth_headers, project_id, [1, 2, 3, 4, 5, 6, 7])
    # 1–6 页底部有页码：2×页序（这本书影印按叶编号，页码隔 2）；
    # 第 7 页故意不塞，验"未识别页码"。
    for page_no in range(1, 7):
        add_block(
            library_dir,
            project_id,
            page_no=page_no,
            text=str(2 * page_no),
            x=0.5,
            y=0.95,
        )
    # 第 1 页第一个文字块是章首。
    add_block(
        library_dir,
        project_id,
        page_no=1,
        text="第五十四回\n史太君破陈腐旧套",
        x=0.5,
        y=0.2,
        order=-1,
    )
    return project_id


def index(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/page-index", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_index_lists_every_page_with_printed_numbers_and_chapters(
    client: TestClient,
    auth_headers: dict[str, str],
    indexed_project: str,
) -> None:
    data = index(client, auth_headers, indexed_project)
    assert data["schema"] == "book2text.page-index.v1"
    pages = data["pages"]
    total = client.get(
        f"/api/projects/{indexed_project}/pages", headers=auth_headers
    ).json()["pages"]
    assert len(pages) == len(total)  # 每一页都在列表里

    by_no = {entry["page_no"]: entry for entry in pages}
    # 标签只写实际检测到的那个号（这里 4）；不是"一页两个印刷页"。
    assert data["numbering_step"] == 2
    assert by_no[2]["printed"] == ["4"]
    assert by_no[2]["missing"] is False
    # 跳转便利：同一叶的另一面 5 也能命中这一页，但不写进标签
    assert by_no[2]["jump"] == ["4", "5"]
    # 章首：第 1 页
    assert by_no[1]["chapter"] == "第五十四回"
    assert data["chapters"][0]["page_no"] == 1
    assert data["chapters"][0]["title"] == "第五十四回"
    # 缺页码：第 7 页照样列出、标 missing，不隐藏
    assert by_no[7]["printed"] == []
    assert by_no[7]["missing"] is True
    stats = data["stats"]
    assert stats["total"] == len(total)
    assert stats["numbered"] == 6
    assert stats["missing"] == len(total) - 6
    assert stats["complete"] is True


def test_finish_summary_reports_index_generated_without_manual_work(
    client: TestClient,
    auth_headers: dict[str, str],
    indexed_project: str,
) -> None:
    response = client.get(
        f"/api/projects/{indexed_project}/review/finish-summary", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    state = response.json()["index"]
    assert state["complete"] is True
    assert state["numbered"] == 6
    assert state["chapters"] == 1
    assert state["numbering_step"] == 2


def test_manual_printed_page_wins_over_candidates(
    client: TestClient,
    auth_headers: dict[str, str],
    indexed_project: str,
) -> None:
    page_index_module.forget_page_index(indexed_project)
    response = client.post(
        f"/api/projects/{indexed_project}/page-numbers/manual",
        json={"page_no": 3, "printed_page": "301"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = index(client, auth_headers, indexed_project)
    entry = next(item for item in data["pages"] if item["page_no"] == 3)
    assert entry["printed"] == ["301"]
    assert entry["jump"] == ["301"]
    assert entry["source"] == "manual"


def test_numbering_step_detection() -> None:
    # 相邻页印刷页码差 ≈2 → 步长 2（按叶编号）；≈1 → 步长 1
    assert page_index_module._numbering_step({1: 2, 2: 4, 3: 6}) == 2
    assert page_index_module._numbering_step({1: 1, 2: 2, 3: 3}) == 1
    assert page_index_module._numbering_step({}) == 1


def test_chapter_regex_only_matches_chapter_openings() -> None:
    assert page_index_module._chapter_of("第五十四回\n史太君破陈腐旧套") == "第五十四回"
    assert page_index_module._chapter_of("第八十回") == "第八十回"
    assert page_index_module._chapter_of("话说第五十四回那天") is None
    assert page_index_module._chapter_of("红楼梦\n6") is None
