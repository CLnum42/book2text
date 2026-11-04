"""页码索引：一行不可解析的数字不许打死整个视图（2026-11-05，P0）。

`'②'.isdigit()` 是 True、`'②'.isdecimal()` 是 False、`int('②')` 抛 ValueError。
守卫写成 `isdigit()` 再 `int()` 就是假守卫——真机上 `_bottom_line_numbers` 因此 500。
"""

from __future__ import annotations

from pathlib import Path

from book2text.core.project import page_index as page_index_module
from book2text.core.storage import db as db_module


def _add_line(project_dir: Path, page_no: int, text: str, y: float) -> None:
    bbox = [0.45, y - 0.01, 0.55, y + 0.01]
    with db_module.open_database(project_dir, apply_migrations=False) as conn:
        page = conn.execute(
            "SELECT page_id FROM page WHERE page_no = ?", (page_no,)
        ).fetchone()
        conn.execute(
            "INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,"
            " ocr_text, text, review_status, include, continues_to_next, revision,"
            " created_at, updated_at)"
            " VALUES (?, ?, 'ocr', 9, ?, 'paragraph', ?, ?, 'unreviewed', 1, 0, 0,"
            " '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')",
            ("b" + text, page["page_id"], str(bbox).replace("'", '"'), text, text),
        )
        conn.execute(
            "INSERT INTO block_line (line_id, block_id, line_index, bbox, text)"
            " VALUES (?, ?, 0, ?, ?)",
            ("l" + text, "b" + text, str(bbox).replace("'", '"'), text),
        )
        conn.commit()


def test_bottom_band_circled_number_is_skipped(minimal_project: Path) -> None:
    """下边带一行 `②`：索引照常生成，不抛；`②` 也不会被当成页码。"""
    _add_line(minimal_project, 1, "②", 0.95)
    _add_line(minimal_project, 2, "7", 0.95)

    index = page_index_module.build_page_index(
        "b2t_TESTS1", library=minimal_project.parent
    )

    assert index["pages"], "坏一行不该让整页索引空掉"
    by_page = {entry["page_no"]: entry for entry in index["pages"]}
    assert not by_page[1].get("printed"), "② 不是页码，不能被记成 2"
