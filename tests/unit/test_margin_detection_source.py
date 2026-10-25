"""版心推算的数据源：检测行优先、OCR 行回退（任务 59）。

这里直接建最小库（块 / 行 / 检测运行），验证 `suggest_margin_box` 真的读哪一张表；
真书上的前后对比在开发日志任务 59 里。
"""

from __future__ import annotations

import json
from pathlib import Path

from book2text.core.project import margin_box
from book2text.core.storage import db as db_module
from book2text.core.storage.ulid import new_ulid


def _insert_block_lines(directory: Path, *, left: float, right: float) -> None:
    """给 minimal_project 的三页各插一个块与 4 条 OCR 行。"""
    with db_module.open_database(directory, apply_migrations=False) as conn:
        for page_no in (1, 2, 3):
            page_id = f"page{page_no}"
            block_id = new_ulid()
            conn.execute(
                """
                INSERT INTO block (
                    block_id, page_id, origin, order_index, block_type, ocr_text, text,
                    created_at, updated_at
                ) VALUES (?, ?, 'ocr', 0, 'paragraph', '正文', '正文', ?, ?)
                """,
                (block_id, page_id, "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"),
            )
            conn.executemany(
                """
                INSERT INTO block_line (line_id, block_id, line_index, bbox, text)
                VALUES (?, ?, ?, ?, '正文')
                """,
                [
                    (
                        new_ulid(),
                        block_id,
                        index,
                        json.dumps([left, 0.10 + index * 0.10, right, 0.20 + index * 0.10]),
                    )
                    for index in range(4)
                ],
            )
        conn.commit()


def _insert_layout_lines(directory: Path, *, left: float, right: float) -> None:
    """给三页各插一次成功的检测运行与 4 条检测行。"""
    with db_module.open_database(directory, apply_migrations=False) as conn:
        for page_no in (1, 2, 3):
            page_id = f"page{page_no}"
            run_id = new_ulid()
            conn.execute(
                """
                INSERT INTO layout_run (
                    run_id, page_id, engine_id, engine_version, params_json,
                    status, line_count, created_at
                ) VALUES (?, ?, 'fake-layout', '1', '{}', 'succeeded', 4, ?)
                """,
                (run_id, page_id, "2026-01-01T00:00:00+00:00"),
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
                        page_id,
                        index,
                        json.dumps([left, 0.15 + index * 0.10, right, 0.25 + index * 0.10]),
                        index,
                    )
                    for index in range(4)
                ],
            )
        conn.commit()


def test_detection_lines_win_over_ocr_lines(
    minimal_project: Path, tmp_path: Path
) -> None:
    _insert_block_lines(minimal_project, left=0.10, right=0.90)
    _insert_layout_lines(minimal_project, left=0.20, right=0.80)

    result = margin_box.suggest_margin_box(minimal_project.name, library=tmp_path)
    assert result.pages == 3
    assert result.lines == 12
    assert result.margin_box is not None
    left, top, right, bottom = result.margin_box
    # 检测行在 0.20 / 0.80，上下 0.15–0.45；再向外让 0.02
    assert left == 0.18
    assert right == 0.82
    assert top == 0.13
    assert bottom == 0.57


def test_pages_without_detection_lines_fall_back_to_ocr(
    minimal_project: Path, tmp_path: Path
) -> None:
    _insert_block_lines(minimal_project, left=0.10, right=0.90)

    result = margin_box.suggest_margin_box(minimal_project.name, library=tmp_path)
    assert result.pages == 3
    assert result.lines == 12
    assert result.margin_box is not None
    left, top, right, bottom = result.margin_box
    assert left == 0.08
    assert right == 0.92
    assert top == 0.08
    assert bottom == 0.52
