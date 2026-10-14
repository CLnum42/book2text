"""段生成测试（说明书 9.1）。

说明书 9.1 的四条规则各有对应测试：
1. 筛选条件（页 include、块 include、未删除、类型范围、仅已确认）
2. `continues_to_next` 与下一个符合条件的块合并（中间被排除的块自动跳过）
3. 标题块单独成段
4. 每段记录来源（页码、块 ID、审校状态）
"""

from __future__ import annotations

import pytest

from book2text.core.export import segments as seg


def src(
    block_id: str,
    text: str,
    *,
    page_no: int = 1,
    order_index: int = 0,
    block_type: str = seg.BLOCK_TYPE_PARAGRAPH,
    include: bool = True,
    deleted: bool = False,
    review_status: str = seg.REVIEW_UNREVIEWED,
    continues_to_next: bool = False,
    ocr_text: str | None = None,
) -> seg.SegmentSource:
    return seg.SegmentSource(
        block_id=block_id,
        page_no=page_no,
        order_index=order_index,
        block_type=block_type,
        text=text,
        include=include,
        deleted=deleted,
        review_status=review_status,
        continues_to_next=continues_to_next,
        ocr_text=ocr_text,
    )


# ---------------------------------------------------------------- 基本行为

def test_empty_input_gives_no_segments() -> None:
    assert seg.build_segments([]) == []


def test_each_block_becomes_one_segment_by_default() -> None:
    """没有 continues_to_next 标记时，一块一段。"""
    result = seg.build_segments([src("a", "第一段"), src("b", "第二段", order_index=1)])
    assert [item.text for item in result] == ["第一段", "第二段"]
    assert [item.seq for item in result] == [1, 2]


def test_blocks_are_sorted_by_page_then_order() -> None:
    """说明书 9.1 第 1 条：按 (page_no, order_index) 遍历。"""
    result = seg.build_segments([
        src("c", "第三", page_no=2, order_index=0),
        src("a", "第一", page_no=1, order_index=0),
        src("b", "第二", page_no=1, order_index=1),
    ])
    assert [item.text for item in result] == ["第一", "第二", "第三"]


def test_blank_blocks_are_skipped() -> None:
    result = seg.build_segments([src("a", "有内容"), src("b", "   ", order_index=1)])
    assert [item.text for item in result] == ["有内容"]


# ---------------------------------------------------------------- 第 2 条：延续合并

def test_continues_to_next_merges_with_following_block() -> None:
    result = seg.build_segments([
        src("a", "话说黛玉正自悲泣，", continues_to_next=True),
        src("b", "只见宝钗出来了。", order_index=1),
        src("c", "另一段开始。", order_index=2),
    ])
    assert len(result) == 2
    assert result[0].text == "话说黛玉正自悲泣，只见宝钗出来了。"
    assert result[0].block_ids == ("a", "b")
    assert result[1].text == "另一段开始。"


def test_merge_uses_the_9_2_rules_for_latin_boundaries() -> None:
    """说明书 9.2：跨块拼接与块内换行使用同一规则。"""
    result = seg.build_segments([
        src("a", "The argument is elegant", continues_to_next=True),
        src("b", "but rests on an assumption.", order_index=1),
    ])
    assert result[0].text == "The argument is elegant but rests on an assumption."


def test_merge_chain_of_three_blocks() -> None:
    result = seg.build_segments([
        src("a", "一", continues_to_next=True),
        src("b", "二", order_index=1, continues_to_next=True),
        src("c", "三", order_index=2),
    ])
    assert len(result) == 1
    assert result[0].text == "一二三"
    assert result[0].block_ids == ("a", "b", "c")


def test_excluded_blocks_between_merged_blocks_are_skipped() -> None:
    """说明书 9.1 第 2 条：中间被排除的页眉 / 页脚 / 页码块自动跳过。"""
    result = seg.build_segments([
        src("a", "正文上半", page_no=1, order_index=0, continues_to_next=True),
        src("pg", "　12　", page_no=1, order_index=1, block_type=seg.BLOCK_TYPE_PAGE_NUMBER),
        src("b", "正文下半", page_no=2, order_index=0),
    ])
    assert len(result) == 1
    assert result[0].text == "正文上半正文下半"
    assert result[0].block_ids == ("a", "b")
    assert result[0].pages == (1, 2)


def test_merge_across_pages_records_both_pages() -> None:
    result = seg.build_segments([
        src("a", "跨页前半", page_no=3, continues_to_next=True),
        src("b", "跨页后半", page_no=4),
    ])
    assert len(result) == 1
    assert result[0].pages == (3, 4)


def test_trailing_continues_to_next_without_a_follower_stays_standalone() -> None:
    """最后一块声明延续却没有下一块时，它自己成段（不报错、不丢内容）。"""
    result = seg.build_segments([src("a", "最后一块", continues_to_next=True)])
    assert len(result) == 1
    assert result[0].text == "最后一块"


# ---------------------------------------------------------------- 第 3 条：标题单独成段

def test_heading_does_not_absorb_the_following_block() -> None:
    """说明书 9.1 第 3 条：标题块单独成段，不与前后正文合并。"""
    result = seg.build_segments([
        src("h", "第三章 山谷里", block_type=seg.BLOCK_TYPE_HEADING, continues_to_next=True),
        src("a", "正文开始。", order_index=1),
    ])
    assert len(result) == 2
    assert result[0].text == "第三章 山谷里"
    assert result[1].text == "正文开始。"


def test_paragraph_is_not_merged_into_a_following_heading() -> None:
    result = seg.build_segments([
        src("a", "正文结尾。", continues_to_next=True),
        src("h", "第四章", order_index=1, block_type=seg.BLOCK_TYPE_HEADING),
    ])
    assert len(result) == 2
    assert result[0].text == "正文结尾。"
    assert result[1].text == "第四章"


def test_consecutive_headings_stay_separate() -> None:
    result = seg.build_segments([
        src("h1", "上篇", block_type=seg.BLOCK_TYPE_HEADING, continues_to_next=True),
        src("h2", "第一章", order_index=1, block_type=seg.BLOCK_TYPE_HEADING),
    ])
    assert [item.text for item in result] == ["上篇", "第一章"]


# ---------------------------------------------------------------- 第 1 条：筛选

def test_excluded_flag_drops_the_block() -> None:
    result = seg.build_segments([src("a", "保留"), src("b", "排除", order_index=1, include=False)])
    assert [item.text for item in result] == ["保留"]


def test_soft_deleted_block_is_dropped() -> None:
    """说明书 5.1：删除一律为软删除。"""
    result = seg.build_segments([src("a", "保留"), src("b", "已删", order_index=1, deleted=True)])
    assert [item.text for item in result] == ["保留"]


def test_header_footer_and_page_number_excluded_by_default() -> None:
    """说明书 9.3 默认排除页眉 / 页脚 / 页码块。"""
    result = seg.build_segments([
        src("h", "书名", block_type=seg.BLOCK_TYPE_HEADER),
        src("a", "正文", order_index=1),
        src("f", "页码", order_index=2, block_type=seg.BLOCK_TYPE_FOOTER),
        src("n", "12", order_index=3, block_type=seg.BLOCK_TYPE_PAGE_NUMBER),
    ])
    assert [item.text for item in result] == ["正文"]


def test_exclusion_can_be_disabled() -> None:
    result = seg.build_segments(
        [src("h", "书名", block_type=seg.BLOCK_TYPE_HEADER), src("a", "正文", order_index=1)],
        excluded_types=frozenset(),
    )
    assert [item.text for item in result] == ["书名", "正文"]


def test_allowed_types_limits_scope() -> None:
    result = seg.build_segments(
        [
            src("a", "正文", block_type=seg.BLOCK_TYPE_PARAGRAPH),
            src("n", "注释", order_index=1, block_type=seg.BLOCK_TYPE_FOOTNOTE),
        ],
        excluded_types=frozenset(),
        allowed_types={seg.BLOCK_TYPE_PARAGRAPH},
    )
    assert [item.text for item in result] == ["正文"]


def test_confirmed_only_filters_unreviewed() -> None:
    result = seg.build_segments(
        [
            src("a", "已确认", review_status=seg.REVIEW_CONFIRMED),
            src("b", "未审校", order_index=1),
            src("c", "不确定", order_index=2, review_status=seg.REVIEW_UNCERTAIN),
        ],
        confirmed_only=True,
    )
    assert [item.text for item in result] == ["已确认"]


def test_page_filters() -> None:
    sources = [src("a", "第一页", page_no=1), src("b", "第二页", page_no=2)]
    assert [i.text for i in seg.build_segments(sources, included_pages={1})] == ["第一页"]
    assert [i.text for i in seg.build_segments(sources, pages_in_scope={2})] == ["第二页"]


def test_page_filters_accept_plain_lists() -> None:
    """传 list 也应工作（内部会转成 set）。"""
    sources = [src("a", "第一页", page_no=1), src("b", "第二页", page_no=2)]
    assert [i.text for i in seg.build_segments(sources, included_pages=[2])] == ["第二页"]


# ---------------------------------------------------------------- 第 4 条：来源记录

def test_segment_id_is_the_first_block_id() -> None:
    """说明书 5.3：段 ID = 首块的 block_id，首块不删则段 ID 稳定。"""
    result = seg.build_segments([
        src("first-block", "上半", continues_to_next=True),
        src("second-block", "下半", order_index=1),
    ])
    assert result[0].segment_id == "first-block"


def test_pages_are_deduplicated_and_ordered() -> None:
    result = seg.build_segments([
        src("a", "甲", page_no=7, order_index=0, continues_to_next=True),
        src("b", "乙", page_no=7, order_index=1, continues_to_next=True),
        src("c", "丙", page_no=8, order_index=0),
    ])
    assert result[0].pages == (7, 8)


def test_review_summary_counts_statuses() -> None:
    result = seg.build_segments([
        src("a", "甲", review_status=seg.REVIEW_CONFIRMED, continues_to_next=True),
        src("b", "乙", order_index=1),
        src("c", "丙", order_index=2, review_status=seg.REVIEW_UNCERTAIN),
    ])
    # 第一段是 a + b（a 声明延续）；丙 未声明延续，自成第二段
    assert len(result) == 2
    assert result[0].block_ids == ("a", "b")
    assert result[0].review.unreviewed == 1
    assert result[0].review.uncertain == 0
    assert result[0].review.all_confirmed is False
    assert result[1].block_ids == ("c",)
    assert result[1].review.uncertain == 1


def test_all_confirmed_is_true_only_when_every_block_is_confirmed() -> None:
    result = seg.build_segments([
        src("a", "甲", review_status=seg.REVIEW_CONFIRMED),
        src("b", "乙", order_index=1, review_status=seg.REVIEW_CONFIRMED),
    ])
    assert result[0].review.all_confirmed is True
    assert result[1].review.all_confirmed is True


def test_modified_is_true_when_text_differs_from_ocr_text() -> None:
    """说明书 5.3：已修改 = text != ocr_text。"""
    result = seg.build_segments([
        src("a", "改过的文本", ocr_text="原始识别"),
    ])
    assert result[0].review.modified is True


def test_modified_is_false_when_text_matches_ocr_text() -> None:
    result = seg.build_segments([src("a", "一样的", ocr_text="一样的")])
    assert result[0].review.modified is False


def test_modified_is_unknown_without_ocr_text() -> None:
    result = seg.build_segments([src("a", "没有基准")])
    assert result[0].review.modified is None


def test_segment_serializes_to_dict() -> None:
    result = seg.build_segments([src("a", "内容", page_no=5, ocr_text="内容")])
    payload = result[0].to_dict()
    assert payload["seq"] == 1
    assert payload["segment_id"] == "a"
    assert payload["type"] == seg.BLOCK_TYPE_PARAGRAPH
    assert payload["pages"] == [5]
    assert payload["block_ids"] == ["a"]
    assert payload["review"]["all_confirmed"] is False
