"""页边重复候选：正例与两条反例（2026-11-05）。

只读检测：`collect()` 给候选，不落库、不改块类型。
反例必须不命中：脚注（下边带长行 + 数字递增）、目录页（page_type=toc）。
"""

from __future__ import annotations

from pathlib import Path

from book2text.core.project import furniture_candidates as fc
from book2text.core.storage import db as db_module


def _project(
    tmp_path: Path,
    pages: list[tuple[int, str]],
    *,
    margin: str | None = "[0.10,0.12,0.90,0.90]",
) -> Path:
    directory = tmp_path / "b2t_TESF01"
    directory.mkdir()
    with db_module.open_database(directory) as conn:
        conn.execute(
            "INSERT INTO project (project_id, name, source_file_name, source_sha256,"
            " page_count, created_at, updated_at, schema_version)"
            " VALUES ('b2t_TESF01', 't', 'a.pdf', 'x', ?, '2026-01-01', '2026-01-01', 0)",
            (len(pages),),
        )
        for page_no, page_type in pages:
            conn.execute(
                "INSERT INTO page (page_id, page_no, page_label, width_pt, height_pt, rotation,"
                " page_type, include, has_text_layer, margin_box)"
                " VALUES (?, ?, '', 595.0, 842.0, 0, ?, 1, 0, ?)",
                (f"pg{page_no}", page_no, page_type, margin),
            )
        conn.commit()
    return directory


def _line(directory: Path, page_no: int, index: int, text: str, y0: float, y1: float) -> None:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        block_id = f"b{page_no}_{index}"
        conn.execute(
            "INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,"
            " ocr_text, text, review_status, include, continues_to_next, revision,"
            " created_at, updated_at)"
            " VALUES (?, ?, 'ocr', ?, ?, 'paragraph', ?, ?, 'unreviewed', 1, 0, 0,"
            " '2026-01-01', '2026-01-01')",
            (block_id, f"pg{page_no}", index, f"[0.2,{y0},0.8,{y1}]", text, text),
        )
        conn.execute(
            "INSERT INTO block_line (line_id, block_id, line_index, bbox, text)"
            " VALUES (?, ?, 0, ?, ?)",
            (f"l{page_no}_{index}", block_id, f"[0.2,{y0},0.8,{y1}]", text),
        )
        conn.commit()


def test_repeated_top_header_is_detected(tmp_path: Path) -> None:
    directory = _project(tmp_path, [(no, "body") for no in range(1, 11)])
    for page_no in range(1, 11):
        _line(directory, page_no, 0, f"《红楼梦》情感讲述语词的研究{page_no}", 0.05, 0.08)
        _line(directory, page_no, 1, "正文第一行", 0.30, 0.34)

    rows = fc.collect("b2t_TESF01", library=tmp_path)

    assert len(rows) == 2, "奇偶页各一个候选（每组 5 页）"
    assert {row["parity"] for row in rows} == {"even", "odd"}
    assert all(row["band"] == "top" and row["count"] == 5 for row in rows)
    assert all(row["suggested_type"] == "header" for row in rows)


def test_long_footnote_in_bottom_band_is_not_a_candidate(tmp_path: Path) -> None:
    """反例：下边带出现"数字递增的长行"（脚注）——不许命中。"""
    directory = _project(tmp_path, [(no, "body") for no in range(1, 11)])
    for page_no in range(1, 11):
        _line(directory, page_no, 0, "正文第一行", 0.30, 0.34)
        _line(directory, page_no, 1, f"①这是脚注的第{page_no}条说明文字比较长", 0.94, 0.97)

    rows = fc.collect("b2t_TESF01", library=tmp_path)

    assert rows == []


def test_toc_pages_are_not_scanned(tmp_path: Path) -> None:
    """反例：目录页（标题……页码）不参与检测。"""
    directory = _project(tmp_path, [(no, "toc") for no in range(1, 11)])
    for page_no in range(1, 11):
        _line(directory, page_no, 0, f"第一章 绪论 {page_no}", 0.05, 0.08)

    rows = fc.collect("b2t_TESF01", library=tmp_path)

    assert rows == []


def test_pages_without_margin_use_the_default_band(tmp_path: Path) -> None:
    """新书第一次识别：一页版心都没有时也要能认出页眉（页面默认页边带，置信度降一档）。

    这是用户抱怨的那个 bug 的第一次复现路径：没有框 ⇒ 没候选 ⇒ 第一次拟出来仍把页眉
    包进去，用户得点第二次才对。判据：候选照样出、并打上 `used_default_band`。
    """
    directory = _project(tmp_path, [(no, "body") for no in range(1, 11)], margin=None)
    for page_no in range(1, 11):
        _line(directory, page_no, 0, "《红楼梦》情感讲述语词的研究", 0.05, 0.08)
        _line(directory, page_no, 1, "正文第一行", 0.30, 0.34)

    rows = fc.collect("b2t_TESF01", library=tmp_path)

    assert len(rows) == 2, "奇偶页各一个候选（每组 5 页）"
    assert all(row["used_default_band"] is True for row in rows)
    # 5/5 命中本来给 1.0；默认页边带比"版心之外"弱，降一档到 0.8
    assert all(row["confidence"] == 0.8 for row in rows)
    # 排除矩形要跟着出来，拟合那边才剔得掉页眉
    exclusions = fc.page_exclusions("b2t_TESF01", library=tmp_path)
    assert set(exclusions) == set(range(1, 11))
    for page_no, rects in exclusions.items():
        box = rects[0]
        assert box[1] <= 0.05 and box[3] >= 0.08, f"第 {page_no} 页的排除矩形没盖住页眉：{box}"


def test_pages_with_margin_do_not_set_the_default_band_flag(tmp_path: Path) -> None:
    """有版心、页眉本来就在版心外：同一条判据走"版心之外"，不该标成兜底。"""
    directory = _project(tmp_path, [(no, "body") for no in range(1, 11)])
    for page_no in range(1, 11):
        _line(directory, page_no, 0, "《红楼梦》情感讲述语词的研究", 0.05, 0.08)
        _line(directory, page_no, 1, "正文第一行", 0.30, 0.34)

    rows = fc.collect("b2t_TESF01", library=tmp_path)

    assert len(rows) == 2
    assert all(row["used_default_band"] is False for row in rows)
    assert all(row["confidence"] == 1.0 for row in rows)
