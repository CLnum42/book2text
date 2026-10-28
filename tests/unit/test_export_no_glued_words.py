"""导出文本里不许出现"两个英文单词直接相连"（任务 79）。

**为什么要这条**：审校右栏丢空格那个 bug（`preventthe people`）在库里、导出里都是对的，
错在渲染层；而所有 CER 统计都把空格归一化了，所以**质量指标完全看不见这类问题**。
它不抛异常、不弄红测试、也不降 CER，只会让用户审到错的东西。

这条测试用一份 200 个常见词的词表，把"两词一行"的正文拼成 200 行导出，
再检查导出文本里有没有"这个词本身不在词表里、却能拆成两个词表里的词"的 token。
"""

from __future__ import annotations

import re

import pytest

from book2text.core.export import joining as joining_module
from book2text.core.export import segments as segments_module

#: 200 个常见英文词（够覆盖这本书的虚词 + 高频实词，不引第三方词典依赖）
WORDS = """
the of and to in a is that it for on with as was at by an be this from or have not
are but they his her their its our your which who whom whose what when where why how
all any both each few more most other some such no nor only own same so than too very
can could may might must shall should will would do does did done doing been being
one two three four five six seven eight nine ten first second third last next
people person man woman child ruler state law order power way thing time year day
prevent subject code essay level ultimate enable passage please just like make made
take taken give given find found think thought know known see seen come came go went
good great small large new old long short high low right left same other another
about above after again against among around before behind below beneath beside
between beyond during except inside near outside over through toward under until
upon within without because before though although while where whether since
must may can shall will would could should might need ought used able likely
also always never often sometimes usually already still even ever much many
word words line lines text texts page pages block blocks chapter chapters book books
""".split()

WORDS = sorted(set(WORDS))
assert len(WORDS) >= 180, len(WORDS)

WORD_SET = set(WORDS)


def _glued_tokens(text: str) -> list[str]:
    """找出"不是单词、却能拆成两个单词"的 token（长度 ≥6 才算，避免误报）。"""
    found = []
    for token in re.findall(r"[A-Za-z]{6,}", text):
        low = token.lower()
        if low in WORD_SET:
            continue
        for index in range(2, len(low) - 1):
            left, right = low[:index], low[index:]
            if left in WORD_SET and right in WORD_SET:
                found.append(token)
                break
    return found


def _join(pairs: list[tuple[str, str]]) -> str:
    """按导出同一条规则把"两行"拼成一段（`join_lines` 是真正加空格的地方）。"""
    return "\n".join(
        joining_module.join_lines([first, second]).text for first, second in pairs
    )


def _build_sources(line_pairs: list[tuple[str, str]]):
    sources = []
    for index, pair in enumerate(line_pairs):
        joined = joining_module.join_lines(list(pair)).text
        sources.append(
            segments_module.SegmentSource(
                block_id=f"blk{index:04d}",
                page_no=index + 1,
                order_index=0,
                block_type="paragraph",
                text=joined,
            )
        )
    return sources


def test_export_lines_join_with_a_space_and_never_glue_words() -> None:
    """200 行"两词一行"的正文：拼出来的导出一词都不能粘在一起。"""
    pairs = []
    for index in range(200):
        first = WORDS[index % len(WORDS)]
        second = WORDS[(index * 7 + 13) % len(WORDS)]
        pairs.append((first, second))

    text = _join(pairs)
    built = segments_module.build_segments(_build_sources(pairs))
    assert len(built) == len(pairs)

    glued = _glued_tokens(text)
    assert glued == [], f"导出文本里出现粘连词：{glued[:5]}"

    # 反向确认：每一对词之间确实有一个空格（不是靠"没有粘连"蒙过去）
    for first, second in pairs[:40]:
        assert f"{first} {second}" in text, (first, second)


@pytest.mark.parametrize(
    "first,second",
    [
        ("prevent", "the"),
        ("subject", "to"),
        ("enable", "people"),
        ("deepest", "level"),
    ],
)
def test_known_glue_cases_keep_the_space(first: str, second: str) -> None:
    """这本书上真实出现过的粘连点，逐个钉住。"""
    text = _join([(first, second)])
    assert f"{first} {second}" in text
    assert f"{first}{second}" not in text
