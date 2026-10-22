"""拆分框的几何估算：不依赖数据库，直接测 `_estimate_split_rects` 与批量条件。

真书上的两个问题由这里钉住：
1. R4 原来让两块沿用同一个 bbox（两个框 100% 重叠）；
2. 页码候选夹在正文中间时，批量拆会把正文拆坏。
"""

from __future__ import annotations

import pytest

from book2text.core.project import editing


def _overlap(a, b, eps: float = 1e-9) -> bool:
    return (
        min(a[2], b[2]) - max(a[0], b[0]) > eps
        and min(a[3], b[3]) - max(a[1], b[1]) > eps
    )


def _lines(*rects):
    return [rect for rect in rects]


def test_line_boundary_split_takes_the_disjoint_line_unions() -> None:
    base = (0.1, 0.1, 0.9, 0.5)
    lines = _lines(
        (0.10, 0.10, 0.90, 0.14),
        (0.10, 0.20, 0.90, 0.24),
        (0.10, 0.30, 0.90, 0.34),
    )
    head, tail = editing._estimate_split_rects(
        base, lines, whole_head_lines=1, split_line=None, ratio=None
    )
    assert head == (0.1, 0.1, 0.9, 0.14)
    assert tail == (0.1, 0.2, 0.9, 0.34)
    assert not _overlap(head, tail)


def test_a_single_line_split_shares_the_exact_cut() -> None:
    base = (0.6, 0.03, 0.9, 0.06)
    head, tail = editing._estimate_split_rects(
        base, [base], whole_head_lines=0, split_line=0, ratio=7 / 9
    )
    assert head[2] == tail[0], "同一个 cut 值给两边，不能有浮点重叠"
    assert head[2] == pytest.approx(0.6 + 0.3 * 7 / 9, abs=1e-6)
    assert not _overlap(head, tail)
    assert head[0] == base[0] and tail[2] == base[2]


def test_a_multi_line_mid_line_split_does_not_leave_overlapping_rects() -> None:
    base = (0.1, 0.1, 0.9, 0.5)
    lines = _lines(
        (0.10, 0.10, 0.90, 0.14),
        (0.10, 0.20, 0.90, 0.24),
        (0.10, 0.30, 0.90, 0.34),
    )
    # 切在第 2 行，前块只占这一行的一小半（比例 <= 0.5）：整行算给后块
    head, tail = editing._estimate_split_rects(
        base, lines, whole_head_lines=1, split_line=1, ratio=0.2
    )
    assert not _overlap(head, tail)
    assert head[3] <= tail[1]
    assert tail[1] == 0.20
    # 切在这一行的大半（比例 > 0.5）：整行算给前块
    head2, tail2 = editing._estimate_split_rects(
        base, lines, whole_head_lines=1, split_line=1, ratio=0.8
    )
    assert not _overlap(head2, tail2)
    assert head2[3] == 0.24 and tail2[1] == 0.30


def test_rects_are_clipped_into_the_original_block() -> None:
    base = (0.2, 0.2, 0.8, 0.8)
    lines = _lines((0.05, 0.15, 0.95, 0.25), (0.10, 0.40, 0.90, 0.50))
    head, tail = editing._estimate_split_rects(
        base, lines, whole_head_lines=1, split_line=None, ratio=None
    )
    for rect in (head, tail):
        assert rect[0] >= base[0] and rect[1] >= base[1]
        assert rect[2] <= base[2] and rect[3] <= base[3]


def test_a_block_without_line_rects_falls_back_to_a_proportional_cut() -> None:
    base = (0.1, 0.1, 0.9, 0.5)
    # 一行、没有行框：按字符比例横切
    head, tail = editing._estimate_split_rects(
        base, [None], whole_head_lines=0, split_line=0, ratio=0.5
    )
    assert head[2] == tail[0] == pytest.approx(0.5)
    assert not _overlap(head, tail)
    # 两行都没有行框：按行数比例竖切
    head2, tail2 = editing._estimate_split_rects(
        base, [None, None], whole_head_lines=1, split_line=None, ratio=None
    )
    assert head2[3] == tail2[1] == pytest.approx(0.3)
    assert not _overlap(head2, tail2)
    # 没有行信息、且没有 bbox：两边都没有框
    assert editing._estimate_split_rects(None, [None], whole_head_lines=0, split_line=0, ratio=0.5) == (
        None,
        None,
    )


class _FakeBlock:
    def __init__(self, text, *, block_type="paragraph", bbox=(0.1, 0.9, 0.9, 0.95), block_id="x"):
        self.text = text
        self.block_type = block_type
        self.bbox = bbox
        self.block_id = block_id
        self.deleted_at = None
        self.order_index = 0


def test_batch_skips_footnotes_and_body_paragraphs_with_numbers() -> None:
    """批量只收书眉页脚 / 页面上下带里的短块，正文段落里的数字一个都不动。"""
    footnote = _FakeBlock(
        "1 这里采用的是《巴赫金全集》第1卷中的译法。", bbox=(0.1, 0.88, 0.9, 0.95), block_id="footnote"
    )
    reference = _FakeBlock(
        "北京：北京大学出版社,2007:5.", bbox=(0.1, 0.90, 0.9, 0.93), block_id="ref"
    )
    middle = _FakeBlock("第 11 章 导论", bbox=(0.1, 0.02, 0.9, 0.05), block_id="middle")
    body_paragraph = _FakeBlock(
        "1917 年 11 月，十月革命发生。", bbox=(0.1, 0.4, 0.9, 0.5), block_id="body"
    )
    header = _FakeBlock(
        "2谁是巴赫金?11", block_type="header", bbox=(0.6, 0.03, 0.9, 0.06), block_id="header"
    )
    plans = editing._batch_page_number_plans(
        [footnote, reference, middle, body_paragraph, header], page_count=267
    )
    assert [item["block"].block_id for item in plans] == ["header"]
    assert plans[0]["plan"].number == "11"


def test_batch_rejects_page_numbers_larger_than_the_book() -> None:
    block = _FakeBlock("2007 年出版", bbox=(0.1, 0.90, 0.9, 0.93), block_id="year")
    assert editing._batch_page_number_plans([block], page_count=267) == []
    # 同一块如果本来就标成页脚，仍按"用户已经确认过类型"处理，不拿页数挡
    typed = _FakeBlock("2007", block_type="footer", bbox=(0.1, 0.90, 0.9, 0.93), block_id="footer")
    plans = editing._batch_page_number_plans([typed], page_count=267)
    assert plans == []  # 只有页码没有别的字：拆完剩空块，也不行
