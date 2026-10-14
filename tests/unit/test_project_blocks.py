"""块记录里纯函数部分的单元测试（说明书 5.2 的坐标、5.3 的"已修改"）。"""

from __future__ import annotations

import pytest

from book2text.core.ocr.base import BBox
from book2text.core.project import blocks as blocks_module


# ---------------------------------------------------------------- 坐标 JSON

def test_bbox_round_trip() -> None:
    box = BBox(0.1, 0.25, 0.9, 0.3)
    text = blocks_module.bbox_to_json(box)
    assert blocks_module.bbox_from_json(text) == pytest.approx((0.1, 0.25, 0.9, 0.3))


def test_none_bbox_is_stored_as_null() -> None:
    assert blocks_module.bbox_to_json(None) is None
    assert blocks_module.bbox_from_json(None) is None
    assert blocks_module.bbox_from_json("") is None


@pytest.mark.parametrize(
    "broken",
    ["not json", "{}", "[1, 2, 3]", "[1, 2, 3, 4, 5]", "null", '"text"'],
)
def test_broken_bbox_does_not_crash_the_reader(broken: str) -> None:
    """一块坏坐标不该让整页读不出来——读不出来就当没有坐标。"""
    assert blocks_module.bbox_from_json(broken) is None


def test_bbox_is_rounded_but_keeps_precision() -> None:
    """坐标存成 JSON 时保留 6 位小数：0–1 的坐标不需要更多精度。"""
    box = BBox(0.123456789, 0.2, 0.99, 0.87654321)
    assert blocks_module.bbox_to_json(box) == "[0.123457, 0.2, 0.99, 0.876543]"


# ---------------------------------------------------------------- 已修改

def _block(**overrides) -> blocks_module.BlockRecord:
    defaults = dict(
        block_id="01",
        page_id="p1",
        page_no=1,
        origin_run_id="01R",
        origin="ocr",
        order_index=0,
        bbox=(0.1, 0.1, 0.9, 0.2),
        block_type="paragraph",
        ocr_text="原文",
        text="原文",
        review_status="unreviewed",
        include=True,
        continues_to_next=False,
        confidence=0.9,
        revision=0,
        reviewed_by=None,
        comment=None,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
    )
    return blocks_module.BlockRecord(**{**defaults, **overrides})


def test_modified_is_derived_from_text_not_stored() -> None:
    """说明书 5.3：已修改 = text != ocr_text，不需要用户设置。"""
    assert _block().modified is False
    assert _block(text="改过了").modified is True
    # 只改状态、没改文本，不算"已修改"
    assert _block(review_status="confirmed").modified is False


def test_block_payload_carries_the_derived_flag() -> None:
    payload = _block(text="改过了").to_dict()
    assert payload["modified"] is True
    assert payload["bbox"] == [0.1, 0.1, 0.9, 0.2]
