"""归一化与比对模块测试。

说明书 8.7 规定该模块"不属于任何引擎，所有引擎共用，**必须有完整单元测试**"；
说明书 13.2 进一步点名要覆盖：中英文、全角半角、**中文中插入空格的场景**
（后者是 Windows OCR 的行为，不处理会把中文行全判成有分歧）。
"""

from __future__ import annotations

import pytest

from book2text.core.ocr import compare


# ---------------------------------------------------------------- 第 1 步：空白

def test_unify_whitespace_normalizes_line_endings() -> None:
    assert compare.unify_whitespace("a\r\nb\rc\nd") == "a\nb\nc\nd"


def test_unify_whitespace_trims_lines() -> None:
    assert compare.unify_whitespace("   中文   \n\t 测试  ") == "中文\n测试"


def test_unify_whitespace_collapses_full_width_space() -> None:
    assert compare.unify_whitespace("中文\u3000测试") == "中文 测试"


def test_unify_whitespace_can_drop_newlines_for_document_comparison() -> None:
    assert compare.unify_whitespace("第一行\n第二行", keep_newlines=False) == "第一行 第二行"


# ---------------------------------------------------------------- 第 2 步：全角半角

@pytest.mark.parametrize(
    ("full_width", "half_width"),
    [
        ("，", ","), ("。", "."), ("！", "!"), ("？", "?"), ("；", ";"), ("：", ":"),
        ("（", "("), ("）", ")"), ("【", "["), ("】", "]"), ("、", ","), ("～", "~"),
    ],
)
def test_fullwidth_punctuation_is_normalized(full_width: str, half_width: str) -> None:
    assert compare.normalize_fullwidth_punctuation(full_width) == half_width


def test_fullwidth_normalization_leaves_han_characters_alone() -> None:
    text = "中文内容，包含标点。"
    normalized = compare.normalize_fullwidth_punctuation(text)
    assert "中文内容" in normalized
    assert "，" not in normalized
    assert "。" not in normalized


# ---------------------------------------------------------------- 第 3 步：中日韩之间的空格

def test_spaces_between_cjk_are_removed() -> None:
    """说明书 13.2 点名的场景：Windows OCR 会在汉字之间插空格。"""
    assert compare.strip_spaces_between_cjk("中 文 测 试") == "中文测试"
    assert compare.strip_spaces_between_cjk("这 是 一段 话 。") == "这是一段话。"


def test_spaces_at_cjk_punctuation_boundary_removed() -> None:
    assert compare.strip_spaces_between_cjk("他说 ： “ 好 ” 。") == "他说：“好”。"


def test_spaces_around_latin_are_preserved() -> None:
    """中英混排中拉丁词两侧的空格是真实的，不能删。"""
    assert compare.strip_spaces_between_cjk("中文 English 混排") == "中文 English 混排"


def test_pure_english_text_untouched() -> None:
    text = "the quick brown fox"
    assert compare.strip_spaces_between_cjk(text) == text


def test_multiple_spaces_between_cjk_collapsed() -> None:
    assert compare.strip_spaces_between_cjk("中  文") == "中文"


# ---------------------------------------------------------------- 第 4 步：等价符号

@pytest.mark.parametrize(
    ("variant", "canonical"),
    [
        ("\u201c", '"'), ("\u201d", '"'), ("\u2018", "'"), ("\u2019", "'"),
        ("\u2014", "-"), ("\u2013", "-"), ("\u2212", "-"), ("\u2015", "-"),
    ],
)
def test_equivalent_symbols_normalized(variant: str, canonical: str) -> None:
    assert compare.normalize_equivalent_symbols(variant) == canonical


def test_dash_runs_are_not_merged() -> None:
    """中文的 —— 会变成 --，与英文单个 - 仍不相同。

    合并连续破折号更激进且会改变长度，说明书未要求，本模块不做。
    """
    assert compare.normalize_equivalent_symbols("——") == "--"
    assert compare.normalize_equivalent_symbols("—") == "-"


# ---------------------------------------------------------------- 三态比对

def test_identical_when_equal() -> None:
    assert compare.compare_line("中文测试", "中文测试") == compare.IDENTICAL


def test_identical_ignores_surrounding_whitespace() -> None:
    assert compare.compare_line("  中文测试  ", "中文测试") == compare.IDENTICAL


def test_format_only_for_fullwidth_halfwidth() -> None:
    assert compare.compare_line("中文，测试。", "中文,测试.") == compare.FORMAT_ONLY_DIFFERS


def test_format_only_for_spaces_inserted_in_chinese() -> None:
    """说明书 8.6：不处理会让中文行因空格差异全被标为分歧。"""
    assert (
        compare.compare_line("中文测试内容", "中 文 测 试 内 容")
        == compare.FORMAT_ONLY_DIFFERS
    )


def test_format_only_for_quote_variants() -> None:
    assert compare.compare_line('他说“好”', '他说"好"') == compare.FORMAT_ONLY_DIFFERS


def test_differs_for_real_character_change() -> None:
    assert compare.compare_line("中文测试", "中文试验") == compare.DIFFERS


def test_differs_for_case_change_by_default() -> None:
    """说明书第 5 步：拉丁字母大小写默认不归一化（大小写属于原文）。"""
    assert compare.compare_line("English Text", "english text") == compare.DIFFERS


def test_differs_for_missing_punctuation() -> None:
    assert compare.compare_line("春天。”", "春天。") == compare.DIFFERS


def test_ellipsis_forms_are_not_treated_as_equivalent() -> None:
    """说明书没把 … 与 ... 列为等价符号，因此它们是实质差异。"""
    assert compare.compare_line("等等…", "等等...") == compare.DIFFERS


# ---------------------------------------------------------------- 编辑距离与错误率

def test_levenshtein_basics() -> None:
    assert compare.levenshtein("", "") == 0
    assert compare.levenshtein("abc", "abc") == 0
    assert compare.levenshtein("", "abc") == 3
    assert compare.levenshtein("abc", "") == 3
    assert compare.levenshtein("kitten", "sitting") == 3
    assert compare.levenshtein("中文", "中文本") == 1


def test_levenshtein_substitution_counts_once() -> None:
    assert compare.levenshtein("黢黑", "黔黑") == 1


def test_character_error_rate() -> None:
    assert compare.character_error_rate("abcdef", "abcdef") == 0.0
    assert compare.character_error_rate("abcdef", "abcxef") == pytest.approx(1 / 6)
    assert compare.character_error_rate("", "") == 0.0


def test_character_error_rate_can_exceed_one() -> None:
    """识别出多余内容时 CER 可以大于 1——如实反映，不截断。"""
    assert compare.character_error_rate("ab", "abcdefgh") > 1.0


def test_word_error_rate() -> None:
    assert compare.word_error_rate("the quick fox", "the quick fox") == 0.0
    assert compare.word_error_rate("the quick fox", "the slow fox") == pytest.approx(1 / 3)


def test_word_error_rate_handles_reordering() -> None:
    assert compare.word_error_rate("a b c", "c b a") == pytest.approx(2 / 3)


def test_score_text_reports_both() -> None:
    score = compare.score_text("the quick brown fox", "the quick brown box")
    assert score.reference_chars == 19
    assert score.distance == 1
    assert score.wer == pytest.approx(1 / 4)


# ---------------------------------------------------------------- 忽略空白的额外口径

def test_whitespace_insensitive_removes_all_spaces() -> None:
    assert compare.normalize_whitespace_insensitive("中 文 English 混 排") == "中文English混排"


def test_whitespace_insensitive_is_separate_from_spec_normalization() -> None:
    """这个口径是测量用的补充，不改变说明书 8.7 定义的比对结果。"""
    gold = "这份文档的格式是 PDF，编码是 UTF-8。"
    ocr = "这份文档的格式是PDF，编码是UTF-8。"
    # 按说明书 8.7：中日韩与拉丁边界的空格不在规则内，因此判为实质差异
    assert compare.compare_line(gold, ocr) == compare.DIFFERS
    # 忽略空白后：内容一致
    assert compare.normalize_whitespace_insensitive(
        compare.normalize_for_comparison(gold)
    ) == compare.normalize_whitespace_insensitive(compare.normalize_for_comparison(ocr))


# ---------------------------------------------------------------- 归一化的稳定性

def test_normalization_is_idempotent() -> None:
    text = "他 说 ： “ 好 ” —— 就这样 。"
    once = compare.normalize_for_comparison(text)
    assert compare.normalize_for_comparison(once) == once


def test_normalization_does_not_mutate_input() -> None:
    original = "中文，测试。"
    compare.normalize_for_comparison(original)
    assert original == "中文，测试。"
