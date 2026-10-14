"""行合并规则测试（说明书 9.2）。

说明书对这个模块的要求很具体："规则实现必须有覆盖上表每一行的单元测试"，
并且"块内换行和跨块拼接使用同一规则"。因此测试按**规则表的每一行**组织，
并单独覆盖本模块对说明书未列出情形的解释（见 joining.py 模块说明）。
"""

from __future__ import annotations

import pytest

from book2text.core.export import joining


def joined(*lines: str, restore: bool = True) -> str:
    return joining.join_lines(list(lines), restore_hyphenation=restore).text


# ================================================================
# 规则表 第 1 行：中日韩字符或全角标点 | 中日韩字符或全角标点 → 不加空格
# ================================================================

@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        ("他说这样", "很好", "他说这样很好"),
        ("这是一句话。", "下一句开始", "这是一句话。下一句开始"),
        ("全角逗号，", "后面接字", "全角逗号，后面接字"),
        ("中文问句？", "反问句", "中文问句？反问句"),
        ("书名号《红楼梦》", "很好看", "书名号《红楼梦》很好看"),
        ("引用结束”", "接着写", "引用结束”接着写"),
        ("日文假名です", "ね", "日文假名ですね"),
    ],
)
def test_cjk_to_cjk_joins_without_space(left: str, right: str, expected: str) -> None:
    assert joined(left, right) == expected


def test_cjk_lines_are_not_separated_by_space() -> None:
    """中文段落拼起来不该出现空格——这是最常见的场景。"""
    text = joined("他沉默了很久，", "最后只回了一句：", "“也许吧。”")
    assert text == "他沉默了很久，最后只回了一句：“也许吧。”"
    assert " " not in text


# ================================================================
# 规则表 第 2 行：拉丁字母 + 行尾连字符 | 小写拉丁字母
# ================================================================

def test_hyphenation_restored_when_enabled() -> None:
    """断词还原开启：删掉连字符直接连。"""
    assert joined("this is self-", "evident to anyone", restore=True) == (
        "this is selfevident to anyone"
    )


def test_hyphen_kept_when_disabled() -> None:
    """断词还原关闭：保留连字符直接连。"""
    assert joined("this is self-", "evident to anyone", restore=False) == (
        "this is self-evident to anyone"
    )


def test_hyphenation_uses_unicode_hyphen_too() -> None:
    """排版里的断词连字符可能是 U+2010，不是 ASCII 的 '-'。"""
    assert joined("self\u2010", "evident", restore=True) == "selfevident"
    assert joined("self\u2010", "evident", restore=False) == "self\u2010evident"


def test_hyphen_before_uppercase_is_kept_and_joined_directly() -> None:
    """说明书只规定小写的情形；大写时按"保留连字符直接连"处理。

    见 joining.py 模块说明第 4 条：``Anglo-`` + ``Saxon`` 应得 ``Anglo-Saxon``，
    若走规则 3 会得到错误的 ``Anglo- Saxon``。
    """
    assert joined("Anglo-", "Saxon rule", restore=True) == "Anglo-Saxon rule"
    assert joined("Anglo-", "Saxon rule", restore=False) == "Anglo-Saxon rule"


def test_hyphen_after_digit_is_joined_directly() -> None:
    """区间号断行：``1990-`` + ``1995`` 应得 ``1990-1995``，不是 ``1990- 1995``。

    见 joining.py 模块说明第 4 条（说明书只规定了"拉丁字母 + 连字符 | 小写拉丁字母"）。
    """
    assert joined("the years 1990-", "1995 were quiet") == "the years 1990-1995 were quiet"


def test_hyphen_before_digit_is_joined_directly() -> None:
    """连字符在行尾、下一行以数字开头，同样直接连接。"""
    assert joined("page nu-", "3 of them") == "page nu-3 of them"


def test_hyphen_inside_cjk_is_not_a_latin_run() -> None:
    """连字符前是中日韩字符时不算"拉丁串断行"，走规则 4（不加空格）。"""
    assert joined("他说中文-", "继续写下去") == "他说中文-继续写下去"


def test_hyphenation_position_and_fragments_are_recorded() -> None:
    """说明书 9.2 要求记录断词还原位置，供 manifest.json 抽查。

    片段记的是**末尾/开头的词**而不是整行——manifest 是给人抽查用的，
    ``self-`` + ``evident`` 比两整行文字有用。
    """
    result = joining.join_lines(["a long self-", "evident truth"])
    assert len(result.hyphenations) == 1

    record = result.hyphenations[0]
    assert record.left_fragment == "self-"
    assert record.right_fragment == "evident"
    assert record.hyphen == "-"
    # 位置指向还原后该词的首字符
    assert result.text[record.position : record.position + 7] == "evident"


def test_no_hyphenation_record_when_disabled() -> None:
    result = joining.join_lines(["self-", "evident"], restore_hyphenation=False)
    assert result.hyphenations == ()


def test_hyphenation_record_serializes_to_dict() -> None:
    result = joining.join_lines(["self-", "evident"])
    payload = result.to_dict()
    assert payload["text"] == "selfevident"
    assert payload["hyphenations"][0]["hyphen"] == "-"
    assert payload["hyphenations"][0]["right_fragment"] == "evident"


# ================================================================
# 规则表 第 3 行：拉丁字符或半角标点 | 拉丁字符 → 加一个空格
# ================================================================

@pytest.mark.parametrize(
    ("left", "right", "expected"),
    [
        ("the quick brown", "fox jumps", "the quick brown fox jumps"),
        ("chapter one,", "and so on", "chapter one, and so on"),
        ("a semicolon;", "then more", "a semicolon; then more"),
        ("ends with colon:", "continue here", "ends with colon: continue here"),
        ("curly quote,”", "and then", "curly quote,” and then"),
    ],
)
def test_latin_to_latin_joins_with_one_space(left: str, right: str, expected: str) -> None:
    assert joined(left, right) == expected


def test_digit_after_latin_gets_a_space() -> None:
    """模块说明第 1 条：规则 3 的"拉丁字符"含数字，否则会拼成 chapter3。"""
    assert joined("in this chapter", "3 we discuss") == "in this chapter 3 we discuss"


def test_latin_after_digit_gets_a_space() -> None:
    assert joined("as of 1994", "the rule changed") == "as of 1994 the rule changed"


def test_right_side_punctuation_gets_no_space() -> None:
    """模块说明第 2 条：右侧是标点时不加空格，否则会得到 "abc , def"。"""
    assert joined("some text", ", more text") == "some text, more text"
    assert joined("a sentence", ". Another sentence") == "a sentence. Another sentence"


def test_multiple_spaces_are_not_doubled() -> None:
    assert joined("english words   ", "   more words") == "english words more words"


# ================================================================
# 规则表 第 4 行：中日韩字符 | 拉丁字符（或反之）→ 直接连接，不额外加空格
# ================================================================

def test_cjk_then_latin_joins_without_space() -> None:
    assert joined("深度学习的英文是", "deep learning，", "指多层神经网络") == (
        "深度学习的英文是deep learning，指多层神经网络"
    )


def test_latin_then_cjk_joins_without_space() -> None:
    assert joined("The term is called", "深度学习在中文里", "的译法不统一") == (
        "The term is called深度学习在中文里的译法不统一"
    )


def test_cjk_to_latin_does_not_add_extra_space() -> None:
    """不额外加空格——即使两侧之间原本就没有空格。"""
    assert joined("使用 PDF", "格式存储") == "使用 PDF格式存储"


# ================================================================
# 未列出情形与边界
# ================================================================

def test_unlisted_combinations_join_without_space() -> None:
    """模块说明第 3 条：说明书未列出的组合一律不加空格。"""
    # 左侧以全角空格之外的非拉丁、非中日韩字符结尾（emoji），右侧拉丁
    assert joined("注意⚠", "danger") == "注意⚠danger"


def test_empty_and_blank_lines_are_skipped() -> None:
    assert joined("", "  ", "内容") == "内容"
    assert joined("   ", "") == ""


def test_single_line_is_returned_stripped() -> None:
    assert joined("   只有一行   ") == "只有一行"


def test_leading_and_trailing_whitespace_of_each_line_removed() -> None:
    """对应说明书 9.3 的"去除行首尾多余空白"。"""
    assert joined("  第一行  ", "  第二行  ") == "第一行第二行"


def test_cjk_to_latin_at_line_break_adds_no_space() -> None:
    """规则 4：中日韩字符 | 拉丁字符 → 直接连接，**不额外加空格**。

    注意这与"中文里拉丁词两侧留空隙"的排版习惯**相反**。说明书 9.2 明确如此规定，
    因此这里如实断言，而不是按习惯改成加空格。

    这条约定与说明书 8.7 空格归一化的关系，见 `docs/accuracy-report.md`
    第 2 节与 `docs/decisions.md` D-015——两处都涉及"中日韩/拉丁边界"，
    但管的是不同的事：9.2 管**行合并**，8.7 管**比对**。
    """
    assert joined("那年是 1971 年", "summer was hot") == "那年是 1971 年summer was hot"


def test_latin_to_cjk_at_line_break_adds_no_space() -> None:
    """规则 4 的反向：拉丁字符 | 中日韩字符 → 同样不额外加空格。"""
    assert joined("the term deep", "学习很难直译") == "the term deep学习很难直译"


def test_block_internal_and_cross_block_use_the_same_rules() -> None:
    """说明书 9.2：块内换行和跨块拼接使用同一规则——所以是同一个函数。"""
    block_a = ["他看到这一页，", "忽然想起往事。"]
    block_b = ["那是很多年前", "的事了。"]
    text = joining.join_lines([*block_a, *block_b]).text
    assert text == "他看到这一页，忽然想起往事。那是很多年前的事了。"

    # 逐对调用 join_pair 应当得到同一结果，证明"同一规则"不是空话
    merged, _, _ = joining.join_pair(block_a[0], block_a[1])
    merged, _, _ = joining.join_pair(merged, block_b[0])
    merged, _, _ = joining.join_pair(merged, block_b[1])
    assert merged == text


def test_join_is_idempotent_for_already_joined_text() -> None:
    once = joining.join_lines(["甲", "乙"]).text
    again = joining.join_lines([once]).text
    assert once == again


def test_realistic_chinese_paragraph_reassembles() -> None:
    """用样本页里真实的一段验证（行来自 OCR，含中文标点与换行）。"""
    lines = [
        "话说黛玉正自悲泣，忽听院门响处，",
        "只见宝钗出来了，宝玉、袭人一群人都送",
        "出来。待要上去问着宝玉，又恐当着众人",
        "问羞了宝玉不便，因而闪过一旁，让宝钗",
        "去了，宝玉等进去关了门，方转过来，尚",
        "望着门洒了几点泪。自觉无味，转身回来，",
        "无精打彩的卸了残妆。",
    ]
    text = joining.join_lines(lines).text
    assert " " not in text, "中文段落里不应出现空格"
    assert text.startswith("话说黛玉正自悲泣，忽听院门响处，只见宝钗出来了")
    assert text.endswith("无精打彩的卸了残妆。")


def test_realistic_english_paragraph_reassembles() -> None:
    lines = [
        "The argument is elegant but rests on an assumption nobody",
        "has tested. Whether the hypothesis holds under different",
        "conditions remains unclear.",
    ]
    text = joining.join_lines(lines).text
    assert text == (
        "The argument is elegant but rests on an assumption nobody "
        "has tested. Whether the hypothesis holds under different "
        "conditions remains unclear."
    )


def test_mixed_paragraph_keeps_latin_spaces_but_not_cjk_ones() -> None:
    lines = [
        "他把 Random Forest 和 Gradient",
        "Boosting 都试了一遍，效果差别不大。",
    ]
    text = joining.join_lines(lines).text
    assert text == "他把 Random Forest 和 Gradient Boosting 都试了一遍，效果差别不大。"
