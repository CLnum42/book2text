"""页码设置接口（任务 55）：模板聚类 → 确认填充 → 数值校验 → 异常列表。

用 20 页扫描样本 + 假引擎跑通状态机，然后直接往库里塞"页眉页码"行
（真实书页的页码往往和章名排在同一行，这里先造清楚的单数字行）。
真书的填充率与异常数在任务报告里（导读巴赫金 40/58 页、红楼梦判为不可靠）。
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
        params={"name": "页码模板测试", "filename": pdf.name},
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


def add_number_line(
    library_dir: Path,
    project_id: str,
    *,
    page_no: int,
    text: str,
    x: float,
    y: float,
) -> None:
    """往某一页塞一条"页眉里的页码"（块 + 行；候选收集读的是 block_line）。"""
    width = 0.04
    height = 0.02
    bbox = [round(x - width / 2, 4), round(y - height / 2, 4),
            round(x + width / 2, 4), round(y + height / 2, 4)]
    block_id = new_ulid()
    line_id = new_ulid()
    now = "2026-01-01T00:00:00+00:00"
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


def seed_header_numbers(
    library_dir: Path, project_id: str, pages: list[int], *, value_fn=None
) -> None:
    for page_no in pages:
        text = str(value_fn(page_no) if value_fn else page_no)
        # 全部页都在顶部居中：简单的"全部页"模板
        add_number_line(library_dir, project_id, page_no=page_no, text=text, x=0.5, y=0.05)


def analysis(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/page-numbers", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def apply_template(
    client: TestClient, headers: dict[str, str], project_id: str, template: dict
) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/page-numbers/apply",
        json={"template": template},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def book_project(
    client: TestClient,
    auth_headers: dict[str, str],
    scan_sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    project_id = create_project(client, auth_headers, scan_sample_pdf)
    recognize(client, auth_headers, project_id, [1, 2, 3, 4, 5, 6, 7])
    return project_id


def test_analysis_finds_a_template_and_apply_fills_pages(
    client: TestClient,
    auth_headers: dict[str, str],
    book_project: str,
    library_dir: Path,
) -> None:
    seed_header_numbers(library_dir, book_project, [1, 2, 3, 4, 5, 6])
    data = analysis(client, auth_headers, book_project)

    assert data["templates"], "应当聚出一个模板"
    template = data["templates"][0]
    assert template["mode"] == "all"
    assert template["coverage"] == 6
    assert template["reliable"] is True
    assert "顶部" in template["label"]

    result = apply_template(client, auth_headers, book_project, template)
    assert result["applied"]["filled"] == 6
    counts = result["current"]["counts"]
    assert counts["filled"] == 6
    assert counts["jump"] == 0
    assert counts["offset_break"] == 0
    assert counts["no_candidate"] == 1       # 第 7 页识别过、但没有页码行
    assert counts["not_recognized"] == 13    # 第 8–20 页没识别
    assert result["current"]["template"]["label"] == template["label"]

    payload = client.get(
        f"/api/projects/{book_project}/pages/1/blocks", headers=auth_headers
    ).json()
    printed = {
        page["page_no"]: page for page in
        client.get(f"/api/projects/{book_project}", headers=auth_headers).json()["pages"]
    }
    assert printed[1]["printed_page"] == "1"
    assert printed[1]["printed_page_source"] == "template"

    summary = client.get(
        f"/api/projects/{book_project}/page-numbers/summary", headers=auth_headers
    ).json()
    assert summary["filled"] == 6
    assert summary["template"]["label"] == template["label"]


def test_artificial_break_reports_jump_and_offset(
    client: TestClient,
    auth_headers: dict[str, str],
    book_project: str,
    library_dir: Path,
) -> None:
    seed_header_numbers(library_dir, book_project, [1, 2, 3, 4, 5, 6])
    template = analysis(client, auth_headers, book_project)["templates"][0]
    apply_template(client, auth_headers, book_project, template)

    # 人为把第 4 页改成 99（模拟用户 / 错误数据），校验必须同时报两类
    with db_module.open_database(library_dir / book_project, apply_migrations=False) as conn:
        conn.execute("UPDATE page SET printed_page = '99' WHERE page_no = 4")
        conn.commit()

    data = analysis(client, auth_headers, book_project)
    assert data["current"]["counts"]["jump"] == 1
    assert data["current"]["counts"]["offset_break"] == 1
    assert data["current"]["anomalies"]["jump"][0]["page_no"] == 4
    assert data["current"]["anomalies"]["offset_break"][0]["page_no"] == 4


def test_two_candidates_at_the_same_position_are_ambiguous(
    client: TestClient,
    auth_headers: dict[str, str],
    book_project: str,
    library_dir: Path,
) -> None:
    seed_header_numbers(library_dir, book_project, [1, 2, 3, 4, 5, 6])
    # 第 2 页同一个位置再塞一个不同的数字
    add_number_line(library_dir, book_project, page_no=2, text="99", x=0.503, y=0.05)

    template = analysis(client, auth_headers, book_project)["templates"][0]
    result = apply_template(client, auth_headers, book_project, template)
    counts = result["current"]["counts"]
    assert counts["ambiguous"] == 1
    assert result["current"]["anomalies"]["ambiguous"][0]["page_no"] == 2
    pages = client.get(
        f"/api/projects/{book_project}", headers=auth_headers
    ).json()["pages"]
    page_two = next(page for page in pages if page["page_no"] == 2)
    assert page_two["printed_page"] is None, "多个候选打架时必须留空，不猜"


def test_bad_template_is_rejected(
    client: TestClient, auth_headers: dict[str, str], book_project: str
) -> None:
    response = client.post(
        f"/api/projects/{book_project}/page-numbers/apply",
        json={"template": {"band": "middle", "mode": "all", "centers": {"all": [0.5, 0.05]}}},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_page_number_template"


def _template(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    return analysis(client, headers, project_id)["templates"][0]


def test_range_template_boundaries_and_no_overlap(
    client: TestClient,
    auth_headers: dict[str, str],
    book_project: str,
    library_dir: Path,
) -> None:
    """默认模板 + 第 3–5 页第二套模板：边界页归属清晰，重叠范围被拒绝。"""
    seed_header_numbers(library_dir, book_project, [1, 2, 3, 4, 5, 6, 7])
    base = _template(client, auth_headers, book_project)
    apply_template(client, auth_headers, book_project, base)

    # 第 3–5 页在底部另有一组数字，作为第二套模板的候选
    for page_no, value in ((3, "103"), (4, "104"), (5, "105")):
        add_number_line(library_dir, book_project, page_no=page_no, text=value, x=0.5, y=0.98)
    templates = analysis(client, auth_headers, book_project)["templates"]
    bottom = next(item for item in templates if item["band"] == "bottom")

    response = client.post(
        f"/api/projects/{book_project}/page-numbers/apply",
        json={"template": bottom, "range": {"from_page": 3, "to_page": 5}},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["current"]["ranges"][0]["from_page"] == 3
    segments = data["current"]["assignments"]
    assert {(item["from_page"], item["to_page"]) for item in segments} == {
        (1, 2), (3, 5), (6, 20)
    }
    mapping = {item["page_no"]: item["printed_page"] for item in data["current"]["mapping"]}
    assert mapping[1] == "1" and mapping[2] == "2"
    assert mapping[3] == "103" and mapping[4] == "104" and mapping[5] == "105"
    assert mapping[6] == "6" and mapping[7] == "7"

    # 与已有范围重叠 → 400，不允许一页命中两套
    overlap = client.post(
        f"/api/projects/{book_project}/page-numbers/apply",
        json={"template": bottom, "range": {"from_page": 4, "to_page": 6}},
        headers=auth_headers,
    )
    assert overlap.status_code == 400
    assert overlap.json()["error"]["code"] == "bad_page_number_template"

    # 移除范围 → 第 3–5 页回到默认模板
    removed = client.post(
        f"/api/projects/{book_project}/page-numbers/ranges/remove",
        json={"from_page": 3, "to_page": 5},
        headers=auth_headers,
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["current"]["ranges"] == []
    mapping = {
        item["page_no"]: item["printed_page"]
        for item in removed.json()["current"]["mapping"]
    }
    assert mapping[3] == "3" and mapping[5] == "5"


def test_manual_value_survives_recalculation(
    client: TestClient,
    auth_headers: dict[str, str],
    book_project: str,
    library_dir: Path,
) -> None:
    seed_header_numbers(library_dir, book_project, [1, 2, 3, 4])
    template = _template(client, auth_headers, book_project)
    apply_template(client, auth_headers, book_project, template)

    manual = client.post(
        f"/api/projects/{book_project}/page-numbers/manual",
        json={"page_no": 3, "printed_page": "99"},
        headers=auth_headers,
    )
    assert manual.status_code == 200, manual.text
    assert manual.json()["current"]["filled"] == 4
    rows = {item["page_no"]: item for item in manual.json()["current"]["mapping"]}
    assert rows[3]["printed_page"] == "99"
    assert rows[3]["source"] == "manual"

    # 再应用一次默认模板：手动页不被覆盖
    again = apply_template(client, auth_headers, book_project, template)
    rows = {item["page_no"]: item for item in again["current"]["mapping"]}
    assert rows[3]["printed_page"] == "99"
    assert rows[3]["source"] == "manual"

    # 清空手动值 → 模板重算能重新填
    cleared = client.post(
        f"/api/projects/{book_project}/page-numbers/manual",
        json={"page_no": 3, "printed_page": None},
        headers=auth_headers,
    )
    assert cleared.status_code == 200, cleared.text
    rows = {item["page_no"]: item for item in cleared.json()["current"]["mapping"]}
    assert rows[3]["printed_page"] == "3"
    assert rows[3]["source"] == "template"


def test_duplicate_printed_pages_are_reported(
    client: TestClient,
    auth_headers: dict[str, str],
    book_project: str,
    library_dir: Path,
) -> None:
    seed_header_numbers(library_dir, book_project, [1, 2, 3, 4])
    template = _template(client, auth_headers, book_project)
    apply_template(client, auth_headers, book_project, template)
    # 手动把第 4 页改成与第 3 页相同的值
    response = client.post(
        f"/api/projects/{book_project}/page-numbers/manual",
        json={"page_no": 4, "printed_page": "3"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    duplicates = response.json()["current"]["anomalies"]["duplicate"]
    assert {item["page_no"] for item in duplicates} == {3, 4}
    assert response.json()["current"]["counts"]["duplicate"] == 2


def test_export_prefers_new_mapping_and_marks_legacy_fallback(
    client: TestClient,
    auth_headers: dict[str, str],
    book_project: str,
    library_dir: Path,
) -> None:
    """导出：新映射优先；没有映射的页退回块类型抽取并标 legacy。"""
    seed_header_numbers(library_dir, book_project, [1, 2, 3])  # 只给 1–3 页模板
    template = _template(client, auth_headers, book_project)
    apply_template(client, auth_headers, book_project, template)
    # 第 1 页块类型里还有一个"77"（与模板值 1 冲突）——新映射必须赢
    add_number_line(library_dir, book_project, page_no=1, text="77", x=0.2, y=0.05)
    # 第 7 页没有模板，但有一个显式 page_number 块 → legacy 77
    add_number_line(library_dir, book_project, page_no=7, text="77", x=0.9, y=0.95)
    with db_module.open_database(library_dir / book_project, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE block SET block_type = 'page_number' WHERE page_id ="
            " (SELECT page_id FROM page WHERE page_no = 7) AND text = '77'"
        )
        conn.commit()
    manual = client.post(
        f"/api/projects/{book_project}/page-numbers/manual",
        json={"page_no": 2, "printed_page": "99"},
        headers=auth_headers,
    )
    assert manual.status_code == 200, manual.text

    response = client.post(
        f"/api/projects/{book_project}/export",
        json={"format": "txt", "page_numbers": [1, 2, 7]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    record = response.json()["record"]
    directory = library_dir / book_project / "exports" / record["export_id"]
    import json as _json

    meta = _json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    by_page = {item["pdf_page"]: item for item in meta["pages"]}
    assert by_page[1]["printed_page"] == "1", "新映射优先于块类型抽取"
    assert by_page[1]["printed_page_source"] == "template"
    assert by_page[2]["printed_page"] == "99"
    assert by_page[2]["printed_page_source"] == "manual"
    assert by_page[7]["printed_page"] == "77"
    assert by_page[7]["printed_page_source"] == "legacy"
