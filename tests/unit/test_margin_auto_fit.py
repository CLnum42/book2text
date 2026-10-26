"""每页自动拟合版心（任务 62）的算法与写库测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from book2text.core.project import margin_box
from book2text.core.storage import db as db_module
from book2text.core.storage.ulid import new_ulid


def test_fit_uses_long_lines_and_quantiles() -> None:
    # 20 条正文长行，左右稳定；上下有少量抖动
    lines = [
        [0.10, 0.10 + i * 0.03, 0.90, 0.10 + i * 0.03 + 0.02]
        for i in range(20)
    ]
    result = margin_box.fit_box_from_lines(lines)
    assert result is not None
    left, top, right, bottom = result
    # 每行按自身宽高外扩 2%：左右 0.8*0.02=0.016
    assert left == pytest.approx(0.084, abs=1e-6)
    assert right == pytest.approx(0.916, abs=1e-6)
    # 5%/95% 后按同一页相邻行距做安全扩张：这组行距 0.03，
    # 两端的行被收回，所以上下到全长 0.0996 / 0.6904。
    assert top == pytest.approx(0.0996, abs=1e-4)
    assert bottom == pytest.approx(0.6904, abs=1e-4)


def test_fit_ignores_short_lines_and_needs_three() -> None:
    short = [[0.45, 0.10, 0.55, 0.12] for _ in range(10)]  # 宽度 10%，是书眉 / 页码
    assert margin_box.fit_box_from_lines(short) is None
    two = [[0.10, 0.10, 0.90, 0.12], [0.10, 0.20, 0.90, 0.22]]
    assert margin_box.fit_box_from_lines(two) is None


def test_fit_rescues_tail_body_lines_beyond_safety_gap() -> None:
    # 30 条正文长行，行距 0.02；另有一条正文行在页顶 0.02，离 5% 分位 > 安全扩张 0.034。
    lines = [
        [0.10, 0.10 + i * 0.02, 0.90, 0.10 + i * 0.02 + 0.018]
        for i in range(30)
    ]
    lines.append([0.10, 0.02, 0.90, 0.038])
    result = margin_box.fit_box_from_lines(lines)
    assert result is not None
    # 尾部回收把页顶那行按 2% 行框外扩收进来，而不是停在 5% 分位的 0.0996 附近。
    assert result[1] < 0.02


def test_fit_tail_rescue_skips_thick_rule() -> None:
    # 页底一条 10% 高的横线（装饰 / 跨页线）中心在外，但不是"一行字"，不回收。
    lines = [
        [0.10, 0.10 + i * 0.02, 0.90, 0.10 + i * 0.02 + 0.018]
        for i in range(30)
    ]
    lines.append([0.10, 0.92, 0.90, 1.0])
    result = margin_box.fit_box_from_lines(lines)
    assert result is not None
    assert result[3] < 0.90


def _insert_layout_lines(directory: Path, page_no: int) -> None:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        page = conn.execute("SELECT page_id FROM page WHERE page_no = ?", (page_no,)).fetchone()
        run_id = new_ulid()
        conn.execute(
            """
            INSERT INTO layout_run (
                run_id, page_id, engine_id, engine_version, params_json,
                status, line_count, created_at
            ) VALUES (?, ?, 'fake-layout', '1', '{}', 'succeeded', 3, ?)
            """,
            (run_id, page["page_id"], "2026-01-01T00:00:00+00:00"),
        )
        conn.executemany(
            """
            INSERT INTO page_layout_line (
                line_id, run_id, page_id, line_index, bbox, confidence, reading_order
            ) VALUES (?, ?, ?, ?, ?, 0.9, ?)
            """,
            [
                (
                    new_ulid(),
                    run_id,
                    page["page_id"],
                    index,
                    json.dumps([0.10, 0.10 + index * 0.10, 0.90, 0.12 + index * 0.10]),
                    index,
                )
                for index in range(3)
            ],
        )
        conn.commit()


def test_fit_page_margin_caches_auto_and_never_overwrites_custom(
    minimal_project: Path,
) -> None:
    # minimal_project 的页面是直接插的，默认 inherit；这里显式模拟新项目默认 auto
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute("UPDATE page SET margin_box_mode = 'auto' WHERE page_no IN (1, 2)")
        conn.execute(
            "UPDATE page SET margin_box_mode = 'custom', margin_box = ? WHERE page_no = 2",
            (json.dumps([0.2, 0.2, 0.8, 0.8]),),
        )
        conn.commit()
    _insert_layout_lines(minimal_project, 1)
    _insert_layout_lines(minimal_project, 2)

    fitted = margin_box.fit_page_margin(minimal_project.name, 1, library=minimal_project.parent)
    assert fitted["updated"] is True
    assert fitted["fallback"] is False
    page1 = next(
        p for p in margin_box.library_module.list_pages(
            minimal_project.name, library=minimal_project.parent
        ) if p.page_no == 1
    )
    assert page1.margin_box_mode == "auto"
    assert page1.margin_box is not None

    skipped = margin_box.fit_page_margin(minimal_project.name, 2, library=minimal_project.parent)
    assert skipped["updated"] is False
    assert skipped["reason"] == "custom_or_none"


def test_fit_all_only_touches_inherit_and_auto(minimal_project: Path) -> None:
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute("UPDATE page SET margin_box_mode = 'inherit' WHERE page_no = 1")
        conn.execute(
            "UPDATE page SET margin_box_mode = 'custom', margin_box = ? WHERE page_no = 2",
            (json.dumps([0.2, 0.2, 0.8, 0.8]),),
        )
        conn.execute("UPDATE page SET margin_box_mode = 'none' WHERE page_no = 3")
        conn.commit()
    _insert_layout_lines(minimal_project, 1)

    result = margin_box.fit_all_pages(minimal_project.name, library=minimal_project.parent)
    assert result == {
        "updated": 1,
        "fitted": 1,
        "fallback": 0,
        "skipped_custom": 1,
        "skipped_none": 1,
    }
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        rows = {
            row["page_no"]: (row["margin_box_mode"], row["margin_box"])
            for row in conn.execute("SELECT page_no, margin_box_mode, margin_box FROM page")
        }
    assert rows[1][0] == "auto"
    assert rows[1][1] is not None
    assert rows[2] == ("custom", json.dumps([0.2, 0.2, 0.8, 0.8]))
    assert rows[3] == ("none", None)


def test_migration_0017_turns_inherit_into_auto(tmp_path: Path) -> None:
    from book2text.core.storage.migration import migrate
    from book2text.core.storage.migrations import MIGRATIONS

    connection = db_module.connect(tmp_path / "m.db")
    try:
        before = [m for m in MIGRATIONS if m.version <= 16]
        migrate(connection, before)
        connection.execute(
            """
            INSERT INTO page (page_id, page_no, page_label, width_pt, height_pt, rotation,
                              page_type, include, has_text_layer, margin_box_mode)
            VALUES ('p1', 1, '', 595, 842, 0, 'body', 1, 0, 'inherit')
            """
        )
        connection.execute(
            """
            INSERT INTO page (page_id, page_no, page_label, width_pt, height_pt, rotation,
                              page_type, include, has_text_layer, margin_box_mode)
            VALUES ('p2', 2, '', 595, 842, 0, 'body', 1, 0, 'custom')
            """
        )
        connection.commit()
        migrate(connection, MIGRATIONS)
        rows = {
            row["page_id"]: row["margin_box_mode"]
            for row in connection.execute("SELECT page_id, margin_box_mode FROM page")
        }
        assert rows == {"p1": "auto", "p2": "custom"}
    finally:
        connection.close()
