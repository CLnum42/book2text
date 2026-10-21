"""`scripts/region_rules.py` 的纯函数单测（行级版面归属判定）。

这个模块是**离线实验**用的，不在 `backend/` 里，因此测试用路径加载，不新增包。
规则本身要能脱离 OCR 引擎、脱离真书复现——每个用例都是合成的小版面。

用例对应 `docs/region-classification-eval.md` 里的实测结论：

- 竖排书眉（左栏、跨页重复）→ high，正文不动；
- 页码（纯数字 / 罗马数字，带 `· 62 ·` 这类装饰）→ page_number high；
- **3 个字的章题（第一回 / 第二回 / 第三回）不能因为"换了数字、位置相同"被当成重复的书眉**；
- 正文段末的短行落在正文框底部时**不动它**（第 37 页误伤的回归）；
- 边缘条带里的长行不动（字数上限保护正文）；
- 书眉被 OCR 拆成两行时，碎片只能拿到 review——这是规则判不准的地方，单测把它钉住。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def _load_region_rules():
    spec = importlib.util.spec_from_file_location(
        "region_rules_under_test", SCRIPTS / "region_rules.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # dataclasses 在 exec 时要能按模块名找到模块（否则 @dataclass 会炸）
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


rr = _load_region_rules()

BODY_TEXT = "他说这石头上面叙着堕落之乡投胎之处"  # 18 字，够长，不会被字数上限保护
HEADER_TEXT = "红楼梦／第{回}回"
HEADER_BOX = (0.02, 0.30, 0.05, 0.40)  # 竖排，贴在左栏
PAGE_NUMBER_BOX = (0.02, 0.62, 0.06, 0.64)


def body_lines(start_y: float = 0.10, count: int = 10,
               last_text: str = BODY_TEXT, last_width: float = 0.6):
    """一页正文：x 0.2–0.8，行高 0.02，行距 0.05。"""
    lines = []
    for index in range(count):
        y0 = start_y + index * 0.05
        text = last_text if index == count - 1 else BODY_TEXT
        width = last_width if index == count - 1 else 0.6
        lines.append(rr.Line(text=text, bbox=(0.2, y0, 0.2 + width, y0 + 0.02)))
    return lines


def page(page_no: int, *extra: rr.Line, body: list[rr.Line] | None = None):
    return rr.PageLines(page_no=page_no, lines=tuple(extra) + tuple(body or body_lines()))


def index_lines(pages):
    """{(page_no, index): Line}，让断言不用再猜下标。"""
    return {
        (page_lines.page_no, index): line
        for page_lines in pages
        for index, line in enumerate(page_lines.lines)
    }


def test_repeated_vertical_header_is_high_and_body_untouched():
    pages = [
        page(no, rr.Line(text=HEADER_TEXT.format(回=no), bbox=HEADER_BOX))
        for no in (2, 3, 4)
    ]
    lines = index_lines(pages)
    for verdict in rr.classify_pages(pages):
        if lines[(verdict.page_no, verdict.index)].text == HEADER_TEXT.format(回=verdict.page_no):
            assert verdict.kind == rr.KIND_HEADER
            assert verdict.confidence == rr.CONFIDENCE_HIGH
            assert "left" in verdict.signals
        else:
            assert verdict.kind == rr.KIND_BODY
            assert verdict.confidence is None


def test_page_number_with_decoration_is_high():
    pages = [
        page(no, rr.Line(text="· 62 ·", bbox=PAGE_NUMBER_BOX))
        for no in (2, 3, 4)
    ]
    verdict = next(v for v in rr.classify_pages(pages) if v.page_no == 2 and v.index == 0)
    assert verdict.kind == rr.KIND_PAGE_NUMBER
    assert verdict.confidence == rr.CONFIDENCE_HIGH
    assert "number_form" in verdict.signals


def test_roman_numeral_page_number_is_high():
    pages = [rr.PageLines(page_no=1, lines=(
        *body_lines(count=3),
        rr.Line(text="iv", bbox=(0.02, 0.30, 0.06, 0.32)),
    ))]
    verdict = rr.classify_pages(pages)[-1]
    assert verdict.kind == rr.KIND_PAGE_NUMBER
    assert verdict.confidence == rr.CONFIDENCE_HIGH


def test_three_character_chapter_titles_are_not_repeated_headers():
    """第一回 / 第二回 / 第三回 位置相同、只差一个字——不能当成重复书眉。

    实测里它们出现在 3 个章首页的同一位置；2/3 的相似度刚好过 0.6 的门槛，
    如果按相似度判，3 行章题会被自动剔除。规则要求 3 个字以内逐字相等。
    """
    pages = [
        page(no, rr.Line(text=f"第{number}回", bbox=(0.13, 0.06, 0.23, 0.08)))
        for no, number in ((1, "一"), (14, "二"), (25, "三"))
    ]
    lines = index_lines(pages)
    for verdict in rr.classify_pages(pages):
        if lines[(verdict.page_no, verdict.index)].text.startswith("第"):
            assert verdict.kind == rr.KIND_HEADER  # 类型上仍算"边缘文字"
            assert verdict.confidence == rr.CONFIDENCE_REVIEW  # 但绝不 auto 剔除


def test_short_last_body_line_at_the_bottom_is_body():
    """第 37 页误伤的回归：段末短行落在正文最后一行的位置，不能被当成页脚。"""
    pages = [
        rr.PageLines(page_no=1, lines=(
            *body_lines(last_text="悲哀。", last_width=0.1),
        )),
    ]
    verdicts = rr.classify_pages(pages)
    last = verdicts[-1]
    assert last.kind == rr.KIND_BODY
    assert last.confidence is None


def test_long_line_in_margin_band_is_protected_by_max_chars():
    pages = [
        rr.PageLines(page_no=1, lines=(
            *body_lines(),
            # 落在左侧条带里的一行长文字（例如印在页边的长注释）：不因为"在条带里"就删
            rr.Line(text="这是一句很长的文字恰好落在了页面边缘的条带里", bbox=(0.02, 0.60, 0.18, 0.62)),
        )),
    ]
    verdict = rr.classify_pages(pages)[-1]
    assert verdict.kind == rr.KIND_BODY
    assert "too_long" in verdict.signals


def test_digits_in_the_middle_of_the_body_are_body():
    pages = [
        rr.PageLines(page_no=1, lines=(
            *body_lines(),
            rr.Line(text="1999", bbox=(0.4, 0.30, 0.46, 0.32)),
        )),
    ]
    verdict = rr.classify_pages(pages)[-1]
    assert verdict.kind == rr.KIND_BODY


def test_short_page_has_no_frame_and_no_candidates():
    pages = [rr.PageLines(page_no=1, lines=(rr.Line(text="红楼梦", bbox=(0.02, 0.3, 0.05, 0.4)),))]
    verdict = rr.classify_pages(pages)[0]
    assert verdict.kind == rr.KIND_BODY


def test_fragment_of_a_split_header_only_gets_review():
    """书眉被 OCR 拆成两行时，第二行 `CO三` 与其它页的书眉不像 → 只能 review。

    这正是实测里唯一漏标的那一行（第 8 页）：块级规则靠分组把两行并回一个块能救，
    行级规则救不回来。单测把这个已知缺陷钉住，避免以后误以为它消失了。
    """
    pages = [
        page(2, rr.Line(text=HEADER_TEXT.format(回=2), bbox=HEADER_BOX)),
        page(3, rr.Line(text=HEADER_TEXT.format(回=3), bbox=HEADER_BOX),
             rr.Line(text="CO三", bbox=(0.02, 0.34, 0.05, 0.39))),
        page(4, rr.Line(text=HEADER_TEXT.format(回=4), bbox=HEADER_BOX)),
    ]
    fragment = next(
        verdict for verdict in rr.classify_pages(pages)
        if verdict.page_no == 3 and verdict.index == 1
    )
    assert fragment.kind == rr.KIND_HEADER
    assert fragment.confidence == rr.CONFIDENCE_REVIEW


def test_max_chars_none_disables_the_length_guard():
    rules = rr.Rules(max_chars=None)
    pages = [
        rr.PageLines(page_no=1, lines=(
            *body_lines(),
            rr.Line(text="很长" * 20, bbox=(0.02, 0.60, 0.18, 0.62)),
        )),
    ]
    verdict = rr.classify_pages(pages, rules)[-1]
    assert verdict.kind == rr.KIND_FOOTER
    assert verdict.confidence == rr.CONFIDENCE_REVIEW
