"""行 → 块 的分组规则测试（说明书 8.1 明确要求"规则必须有测试"）。

测试数据用手工构造的归一化坐标，这样每条规则的触发条件都是可验证的，
而不是"跑出来看着像"。

坐标约定（说明书 5.2）：0–1，原点左上。

本文件里反复出现的基准几何：

    行高 0.02；正文左边界 0.10、右边界 0.90（宽 0.80）
    每行 10 个字符 → 字宽 0.08
    因此：末行短于 0.74（右边界差 > 2.0 字宽）算段落末行
          下一行左边界右移超过 0.096（1.2 字宽）算段首缩进
          行间距超过 0.022（常规 0.01 + 0.6 行高）算空行
"""

from __future__ import annotations

import pytest

from book2text.core.ocr.base import BBox, OcrLine
from book2text.core.structure import grouping

BODY_X0 = 0.10
BODY_X1 = 0.90
LINE_HEIGHT = 0.02
PITCH = 0.03
GAP = PITCH - LINE_HEIGHT  # 0.01


def line(text: str, y0: float, *, x0: float = BODY_X0, x1: float = BODY_X1) -> OcrLine:
    return OcrLine(text=text, bbox=BBox(x0, y0, x1, y0 + LINE_HEIGHT), confidence=0.99)


def paragraph(start_y: float, count: int, prefix: str = "这是一行正文文字") -> list[OcrLine]:
    """生成 `count` 行整齐的正文。

    刻意让每行 10 个字符、撑满 0.10–0.90——这样"字宽 = 行宽 / 字数"估出来是 0.08，
    与真实正文（长行、字数稳定）一致。若用几字短行撑满整行，估出的字宽会虚高，
    缩进与末行短的阈值都会跟着放大，测试就测不到规则本身了。
    """
    return [line(f"{prefix}{index:02d}", start_y + index * PITCH) for index in range(count)]


# ---------------------------------------------------------------- 基本行为

def test_empty_input_gives_no_blocks() -> None:
    layout = grouping.group_lines([])
    assert layout.blocks == ()
    assert layout.column_count == 0
    assert layout.reading_order_uncertain is False


def test_single_line_gives_one_block() -> None:
    layout = grouping.group_lines([line("只有一行字", 0.10)])
    assert len(layout.blocks) == 1
    assert layout.blocks[0].line_count == 1
    assert layout.blocks[0].block_type == grouping.BLOCK_TYPE_PARAGRAPH


def test_uniform_lines_form_one_block() -> None:
    layout = grouping.group_lines(paragraph(0.10, 6))
    assert len(layout.blocks) == 1
    assert layout.blocks[0].line_count == 6
    assert layout.column_count == 1
    assert layout.reading_order_uncertain is False


def test_lines_without_coordinates_are_skipped_with_note() -> None:
    lines = [*paragraph(0.10, 3), OcrLine(text="无坐标", bbox=None)]
    layout = grouping.group_lines(lines)
    assert layout.line_count == 3
    assert any("忽略" in note for note in layout.notes)


def test_blank_lines_are_skipped() -> None:
    lines = [*paragraph(0.10, 2), line("   ", 0.20), *paragraph(0.30, 2)]
    layout = grouping.group_lines(lines)
    assert layout.line_count == 4


# ---------------------------------------------------------------- 规则 1：行距

def test_large_vertical_gap_starts_new_block() -> None:
    """行间距明显大于常规行距 → 另起一段。"""
    lines = [*paragraph(0.10, 3), *paragraph(0.10 + 3 * PITCH + 0.05, 3)]
    layout = grouping.group_lines(lines)
    assert len(layout.blocks) == 2
    assert [block.line_count for block in layout.blocks] == [3, 3]


def test_normal_gap_does_not_split() -> None:
    layout = grouping.group_lines(paragraph(0.10, 8))
    assert len(layout.blocks) == 1


# ---------------------------------------------------------------- 规则 2：末行短（对齐）

def test_short_line_ends_block() -> None:
    """两端对齐的正文里，末行明显短 → 该行是段落末行。"""
    lines = [
        *paragraph(0.10, 3),
        line("末行只有几个字", 0.10 + 3 * PITCH, x1=0.50),
        *paragraph(0.10 + 4 * PITCH, 3),
    ]
    layout = grouping.group_lines(lines)
    assert len(layout.blocks) == 2
    assert layout.blocks[0].line_count == 4
    assert layout.blocks[1].line_count == 3


def test_slightly_short_line_still_stays_in_block() -> None:
    """只差一个字宽不算段落末行——阈值以内不拆。"""
    lines = [
        line("十一个字的一行文字", 0.10, x1=0.86),
        line("下一行接着写文字", 0.10 + PITCH),
    ]
    layout = grouping.group_lines(lines)
    assert len(layout.blocks) == 1


# ---------------------------------------------------------------- 规则 3：缩进

def test_indented_line_starts_new_block() -> None:
    """段首缩进 → 另起一段。"""
    lines = [
        *paragraph(0.10, 3),
        line("　　缩进两格的段首", 0.10 + 3 * PITCH, x0=0.22),
        line("这一行回到左边界", 0.10 + 4 * PITCH),
    ]
    layout = grouping.group_lines(lines)
    assert len(layout.blocks) == 2
    assert layout.blocks[1].lines[0].text == "　　缩进两格的段首"


def test_small_indent_does_not_split() -> None:
    lines = [
        line("第一行文字内容", 0.10),
        line("第二行略微右移", 0.10 + PITCH, x0=0.16),  # 0.06 < 0.096
    ]
    layout = grouping.group_lines(lines)
    assert len(layout.blocks) == 1


# ---------------------------------------------------------------- 多栏与阅读顺序

def test_two_columns_are_detected_and_flagged() -> None:
    """说明书 8.1：检测到疑似多栏时标记"阅读顺序待检查"，不假装已正确排序。"""
    left = [line(f"左栏第{i}行", 0.10 + i * PITCH, x0=0.10, x1=0.40) for i in range(3)]
    right = [line(f"右栏第{i}行", 0.10 + i * PITCH, x0=0.55, x1=0.90) for i in range(3)]

    layout = grouping.group_lines(right + left)  # 故意打乱输入顺序

    assert layout.column_count == 2
    assert layout.reading_order_uncertain is True
    assert any("阅读顺序" in note for note in layout.notes)
    # 栏内自上而下，栏间自左而右
    assert [block.column for block in layout.blocks] == [0, 1]
    assert layout.blocks[0].lines[0].text == "左栏第0行"
    assert layout.blocks[1].lines[0].text == "右栏第0行"


def test_single_column_is_not_flagged() -> None:
    layout = grouping.group_lines(paragraph(0.10, 5))
    assert layout.reading_order_uncertain is False
    assert layout.notes == ()


def test_centered_heading_does_not_create_a_column() -> None:
    """居中标题的左边界远大于正文，但横向区间与正文重叠，不应被当成独立一栏。"""
    lines = [
        line("居中标题", 0.10, x0=0.35, x1=0.65),
        *paragraph(0.16, 3),
    ]
    layout = grouping.group_lines(lines)
    assert layout.column_count == 1
    assert layout.reading_order_uncertain is False


def test_narrow_page_number_does_not_create_a_column() -> None:
    """页脚页码的区间落在正文宽度以内，属于同一栏。"""
    lines = [
        *paragraph(0.10, 4),
        line("　　12　　", 0.30, x0=0.45, x1=0.55),
    ]
    layout = grouping.group_lines(lines)
    assert layout.column_count == 1


def test_grouping_within_a_region_reuses_the_same_rules() -> None:
    """说明书 8.4：版面组件给的是区域，区域内分段用同一套规则。

    因此对"只含右栏行"的集合调用一次，应当得到单栏结果——这正是路线 B 的接法。
    """
    left = [line(f"左{i}", 0.10 + i * PITCH, x0=0.10, x1=0.40) for i in range(3)]
    right = [line(f"右{i}", 0.10 + i * PITCH, x0=0.55, x1=0.90) for i in range(3)]

    only_right = grouping.group_lines(right)
    assert only_right.column_count == 1
    assert only_right.reading_order_uncertain is False
    assert only_right.line_count == 3

    whole_page = grouping.group_lines(left + right)
    assert whole_page.column_count == 2


# ---------------------------------------------------------------- 块的内容与几何

def test_block_bbox_is_union_of_lines() -> None:
    lines = paragraph(0.10, 3)
    block = grouping.group_lines(lines).blocks[0]
    assert block.bbox is not None
    assert block.bbox.x0 == pytest.approx(BODY_X0)
    assert block.bbox.x1 == pytest.approx(BODY_X1)
    assert block.bbox.y0 == pytest.approx(0.10)
    assert block.bbox.y1 == pytest.approx(0.10 + 2 * PITCH + LINE_HEIGHT)


def test_block_text_preserves_line_breaks() -> None:
    """说明书 5.3：Block.text 保留行内换行。拼接成连续文本是导出时的事（9.2）。"""
    layout = grouping.group_lines(paragraph(0.10, 3))
    text = layout.blocks[0].text
    assert text.count("\n") == 2
    assert text.split("\n") == [line.text for line in layout.blocks[0].lines]


def test_order_index_is_sequential() -> None:
    lines = [
        *paragraph(0.10, 2),
        *paragraph(0.10 + 2 * PITCH + 0.05, 2),
        *paragraph(0.10 + 4 * PITCH + 0.10, 2),
    ]
    layout = grouping.group_lines(lines)
    assert [block.order_index for block in layout.blocks] == list(range(len(layout.blocks)))


def test_all_lines_are_accounted_for() -> None:
    lines = [*paragraph(0.10, 5), line("末行短", 0.10 + 5 * PITCH, x1=0.40)]
    layout = grouping.group_lines(lines)
    assert layout.line_count == len(lines)


# ---------------------------------------------------------------- 真实数据（需要 OCR）

@pytest.mark.ocr
@pytest.mark.macos_only
def test_real_chinese_two_column_page() -> None:
    """用真实样本页验证：中文双栏页应被识别为多栏，且章节标题自成一块。"""
    from book2text.core.ocr.adapters import RapidOcrAdapter
    from book2text.core.pdf import render

    adapter = RapidOcrAdapter()
    if not adapter.available()[0]:
        pytest.skip("未安装 OCR 引擎")

    from book2text.core.ocr.base import OcrParams
    from tests.conftest import SCAN_SAMPLE_PDF

    if not SCAN_SAMPLE_PDF.is_file():
        pytest.skip("缺少扫描样本")

    image = render.render_page_image(SCAN_SAMPLE_PDF, 0, dpi=300)
    try:
        result = adapter.recognize(image, OcrParams(dpi=300))
    finally:
        image.close()

    layout = grouping.group_lines(result.lines)

    assert layout.line_count == len(result.lines)
    assert layout.column_count >= 2, "该页左栏是章标题与插图，应为多栏"
    assert layout.reading_order_uncertain is True
    # 章回标题"第二十七回"应当独立成块，且排在正文之前
    first_texts = [block.text for block in layout.blocks[:3]]
    assert any("第二十七回" in text for text in first_texts), first_texts
