"""清理规则与 TXT 输出测试（说明书 9.3 / 9.4）。"""

from __future__ import annotations

from dataclasses import fields

import pytest

from book2text.core.export import cleanup, txt
from book2text.core.export.segments import (
    BLOCK_TYPE_FOOTNOTE,
    BLOCK_TYPE_HEADING,
    BLOCK_TYPE_PARAGRAPH,
    ReviewSummary,
    Segment,
)


def segment(
    text: str,
    *,
    seq: int = 1,
    block_type: str = BLOCK_TYPE_PARAGRAPH,
    pages: tuple[int, ...] = (1,),
    segment_id: str = "b1",
) -> Segment:
    return Segment(
        seq=seq,
        segment_id=segment_id,
        block_type=block_type,
        text=text,
        pages=pages,
        block_ids=(segment_id,),
        review=ReviewSummary(
            all_confirmed=False, unreviewed=1, uncertain=0, modified=None
        ),
    )


# ================================================================
# 说明书 9.3 清理规则
# ================================================================

def test_rules_default_to_all_on() -> None:
    """说明书 9.3 的规则表里五项默认值都是"开"。"""
    rules = cleanup.CleanupRules()
    assert rules.exclude_header_footer is True
    assert rules.merge_lines_in_block is True
    assert rules.restore_hyphenation is True
    assert rules.normalize_newlines is True
    assert rules.strip_line_whitespace is True


def test_rules_field_set_is_locked() -> None:
    """**防止往清理规则里塞进说明书禁止的规则。**

    说明书 9.3 明文规定"不得提供或默认开启：全局替换引号或破折号、
    统一全角 / 半角、拼写纠正、删除'疑似重复行'"。若有人新增字段，这项测试会失败，
    逼使改动者先回答"这条是不是被禁止的"。
    """
    expected = {
        "exclude_header_footer",
        "merge_lines_in_block",
        "restore_hyphenation",
        "normalize_newlines",
        "strip_line_whitespace",
    }
    assert set(cleanup.rules_field_names()) == expected
    assert len(fields(cleanup.CleanupRules)) == len(expected)


def test_forbidden_rules_are_documented() -> None:
    assert "拼写纠正" in cleanup.FORBIDDEN_RULES
    assert "删除疑似重复行" in cleanup.FORBIDDEN_RULES


def test_excluded_block_types_follows_the_switch() -> None:
    assert cleanup.CleanupRules().excluded_block_types == frozenset(
        {"header", "footer", "page_number"}
    )
    assert (
        cleanup.CleanupRules(exclude_header_footer=False).excluded_block_types
        == frozenset()
    )


def test_normalize_line_handles_crlf() -> None:
    rules = cleanup.CleanupRules()
    assert cleanup.normalize_line("  内容\r\n", rules) == "内容"


def test_normalize_line_can_skip_stripping() -> None:
    rules = cleanup.CleanupRules(strip_line_whitespace=False)
    assert cleanup.normalize_line("  内容  ", rules) == "  内容  "


def test_clean_lines_applies_to_every_line() -> None:
    lines = ["  第一行\r\n", "第二行  "]
    assert cleanup.clean_lines(lines, cleanup.CleanupRules()) == ["第一行", "第二行"]


# ================================================================
# 说明书 9.4 TXT 输出
# ================================================================

def test_segments_separated_by_exactly_one_blank_line() -> None:
    text = txt.render_txt([
        segment("第一段", seq=1),
        segment("第二段", seq=2, segment_id="b2"),
    ])
    assert text == "第一段\n\n第二段\n"


def test_output_ends_with_a_single_newline() -> None:
    text = txt.render_txt([segment("只有一段")])
    assert text.endswith("\n")
    assert not text.endswith("\n\n")


def test_output_has_no_carriage_returns() -> None:
    """说明书 9.4：换行 LF。"""
    text = txt.render_txt([segment("甲"), segment("乙", seq=2, segment_id="b2")])
    assert "\r" not in text


def test_empty_segments_give_empty_string() -> None:
    assert txt.render_txt([]) == ""


def test_blank_segment_is_skipped() -> None:
    assert txt.render_txt([segment("   ")]) == ""


def test_heading_gets_blank_lines_around_it() -> None:
    """说明书 9.4：标题前后各空一行。

    说明书 9.1 第 3 条已保证标题单独成段，而所有段一律以一个空行分隔，
    因此标题前后天然各有一个空行，无需额外分支。
    """
    text = txt.render_txt([
        segment("正文一", seq=1),
        segment("第三章", seq=2, segment_id="h", block_type=BLOCK_TYPE_HEADING),
        segment("正文二", seq=3, segment_id="b3"),
    ])
    assert text == "正文一\n\n第三章\n\n正文二\n"


def test_page_markers_off_by_default() -> None:
    text = txt.render_txt([
        segment("第一页正文", seq=1, pages=(1,)),
        segment("第二页正文", seq=2, pages=(2,), segment_id="b2"),
    ])
    assert "〔" not in text


def test_page_markers_when_enabled() -> None:
    text = txt.render_txt(
        [
            segment("第一页正文", seq=1, pages=(1,)),
            segment("第二页正文", seq=2, pages=(2,), segment_id="b2"),
        ],
        options=txt.TxtOptions(page_markers=True),
    )
    assert text.startswith("〔p.1〕\n\n第一页正文")
    assert "〔p.2〕" in text


def test_page_marker_includes_printed_label_when_known() -> None:
    text = txt.render_txt(
        [segment("正文", pages=(87,))],
        options=txt.TxtOptions(page_markers=True),
        page_labels={87: "71"},
    )
    assert text.startswith("〔p.87 / 印71〕")


def test_page_marker_emitted_once_per_page() -> None:
    """同一页上的多个段不应重复打页码标记。"""
    text = txt.render_txt(
        [
            segment("甲", seq=1, pages=(5,)),
            segment("乙", seq=2, pages=(5,), segment_id="b2"),
            segment("丙", seq=3, pages=(6,), segment_id="b3"),
        ],
        options=txt.TxtOptions(page_markers=True),
    )
    assert text.count("〔p.5〕") == 1
    assert text.count("〔p.6〕") == 1


def test_cross_page_segment_marker_uses_its_first_page() -> None:
    text = txt.render_txt(
        [segment("跨页段", pages=(3, 4))],
        options=txt.TxtOptions(page_markers=True),
    )
    assert text.startswith("〔p.3〕")


def test_footnotes_excluded_by_default() -> None:
    """说明书 9.4：默认不导出脚注。"""
    text = txt.render_txt([
        segment("正文", seq=1),
        segment("脚注内容", seq=2, segment_id="f", block_type=BLOCK_TYPE_FOOTNOTE),
    ])
    assert text == "正文\n"


def test_footnotes_included_when_asked() -> None:
    text = txt.render_txt(
        [
            segment("正文", seq=1),
            segment("脚注内容", seq=2, segment_id="f", block_type=BLOCK_TYPE_FOOTNOTE),
        ],
        options=txt.TxtOptions(include_footnotes=True),
    )
    assert text == "正文\n\n脚注内容\n"


def test_page_marker_format() -> None:
    assert txt.page_marker(12) == "〔p.12〕"
    assert txt.page_marker(12, "8") == "〔p.12 / 印8〕"


def test_realistic_book_output() -> None:
    """一段跨页正文 + 一个标题 + 一个脚注的完整输出。"""
    segments = [
        segment("第三章 山谷", seq=1, segment_id="h", block_type=BLOCK_TYPE_HEADING),
        segment(
            "第一天清晨，山谷里还浮着薄薄的雾。他把窗推开一条缝，冷空气涌进来。",
            seq=2,
            pages=(3, 4),
            segment_id="p1",
        ),
        segment("1. 参见前注。", seq=3, pages=(4,), segment_id="f", block_type=BLOCK_TYPE_FOOTNOTE),
    ]
    text = txt.render_txt(segments)
    assert text == (
        "第三章 山谷\n\n"
        "第一天清晨，山谷里还浮着薄薄的雾。他把窗推开一条缝，冷空气涌进来。\n"
    )
    assert "\r" not in text
    assert not text.startswith("\ufeff")
