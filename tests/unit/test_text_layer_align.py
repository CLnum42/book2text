"""用 PDF 文字层当第二引擎：配对与坐标验证（任务 58）。"""

from __future__ import annotations

from book2text.core.ocr import text_layer as tl


def line(text: str, y0: float, x0: float = 0.1, x1: float = 0.9) -> tl.TextLayerLine:
    return tl.TextLayerLine(text, (x0, y0, x1, y0 + 0.02))


def row(text: str, y0: float, x0: float = 0.1, x1: float = 0.9) -> dict:
    return {"text": text, "bbox": (x0, y0, x1, y0 + 0.02)}


def test_pairs_by_reading_order_and_similarity() -> None:
    rows = [row("第一行文字", 0.10), row("第二行文字", 0.13), row("第三行文字", 0.16)]
    lines = [line("第一行文字", 0.10), line("第二行文字", 0.13), line("第三行文字", 0.16)]

    assert tl.align_rows(rows, lines) == ["第一行文字", "第二行文字", "第三行文字"]


def test_survives_an_extra_text_layer_line() -> None:
    """文字层多切一行（比如页眉）时，不能把后面的行整体错位。"""
    rows = [row("第一行", 0.10), row("第二行", 0.13)]
    lines = [line("页眉", 0.02), line("第一行", 0.10), line("第二行", 0.13)]

    assert tl.align_rows(rows, lines) == ["第一行", "第二行"]


def test_recovers_by_coordinates_when_order_breaks() -> None:
    """顺序对不上（文字层把这行放到别处），但坐标几乎完全重叠 → 补配回来。"""
    rows = [row("同一行", 0.10)]
    lines = [line("同一行", 0.101)]

    assert tl.align_rows(rows, lines) == ["同一行"]


def test_does_not_force_a_pair_when_both_text_and_coordinates_disagree() -> None:
    rows = [row("完全不同的内容", 0.10)]
    lines = [line("another sentence entirely", 0.40)]

    assert tl.align_rows(rows, lines) == [""]


def test_empty_text_layer_means_no_candidates() -> None:
    assert tl.align_rows([row("x", 0.1)], []) == [""]
    assert tl.align_rows([], [line("x", 0.1)]) == []
