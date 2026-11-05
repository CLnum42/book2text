"""字级差异（"处"）的边界：切分、合并、字框映射、退化。

这一层是**新概念**——"一行"变成"若干处"。没有钉死的话，后端数出来的处数、
前端画出来的色块、用户点的顺序会三套数不一致。所以每条判据都写死期望值。
"""

from __future__ import annotations

import json

import pytest

from book2text.core.project import line_diff


def runs(current: str, candidate: str, **kwargs):
    return line_diff.runs_for_text(current, candidate, **kwargs)


def shape(payload) -> list[tuple[str, int, int, int, int]]:
    return [(run["kind"], run["a_start"], run["a_end"], run["b_start"], run["b_end"]) for run in payload["runs"]]


# ---------------------------------------------------------------- 切分（十种形态）

def test_adjacent_two_wrong_chars_make_one_run() -> None:
    """相邻两字都错 ⇒ 一处（等长快路径把连续不等的一段并成一处）。"""
    assert shape(runs("甲乙丙丁", "甲XY丁")) == [("replace", 1, 3, 1, 3)]


def test_two_errors_separated_by_one_correct_char_make_two_runs() -> None:
    """隔一个正确字 ⇒ 两处。一处 = 一个判断，不许把两次判断并成一次。"""
    assert shape(runs("甲乙丙丁", "甲X丙Y")) == [
        ("replace", 1, 2, 1, 2),
        ("replace", 3, 4, 3, 4),
    ]


def test_inserted_quote_is_one_run_with_empty_a_side() -> None:
    assert shape(runs("他说好", "他说“好")) == [("insert", 2, 2, 2, 3)]
    payload = runs("他说好", "他说“好")
    assert payload["runs"][0]["from"] == ""
    assert payload["runs"][0]["to"] == "“"


def test_deleted_comma_is_one_run_with_empty_b_side() -> None:
    assert shape(runs("甲乙、丙", "甲乙丙")) == [("delete", 2, 3, 2, 2)]
    assert runs("甲乙、丙", "甲乙丙")["runs"][0]["to"] == ""


def test_insert_at_line_start_and_delete_at_line_end() -> None:
    assert shape(runs("红楼梦", "《红楼梦")) == [("insert", 0, 0, 0, 1)]
    assert shape(runs("红楼梦。", "红楼梦")) == [("delete", 3, 4, 3, 3)]


def test_repeated_punctuation_drops_the_later_one() -> None:
    """`，，` → `，`：tie-break 固定"优先 j += 1" ⇒ 保留靠前那份，删第二个。"""
    assert shape(runs("，，", "，")) == [("delete", 1, 2, 1, 1)]


def test_touching_replace_and_insert_are_merged() -> None:
    assert shape(runs("甲乙丙", "甲X“丙")) == [("replace", 1, 2, 1, 3)]


def test_fullwidth_punctuation_replacement() -> None:
    assert shape(runs("一盏；然后", "一盏，然后")) == [("replace", 2, 3, 2, 3)]


def test_merge_touching_only_joins_zero_gap_runs() -> None:
    """相接（两侧 gap 都是 0）才合并；差一个字就不合并。"""
    found = [(1, 2, 1, 2, "replace"), (2, 3, 2, 4, "insert")]
    assert line_diff.merge_touching(found) == [(1, 3, 1, 4, "replace")]
    apart = [(1, 2, 1, 2, "replace"), (3, 4, 3, 4, "replace")]
    assert line_diff.merge_touching(apart) == apart


def test_over_long_line_degrades_to_one_run() -> None:
    current = "甲" * 300
    candidate = "乙" * 300
    payload = runs(current, candidate)
    assert payload["degraded"] is True
    assert len(payload["runs"]) == 1
    assert (payload["runs"][0]["a_start"], payload["runs"][0]["a_end"]) == (0, 300)


# ---------------------------------------------------------------- 字框映射

def char_boxes(text: str, width: float = 0.02, height: float = 0.03) -> str:
    """逐字框：拼接长度等于行文本长度 ⇒ 走偏移分支。"""
    entries = [
        {"text": ch, "bbox": [index * width, 0.5, (index + 1) * width, 0.5 + height], "confidence": 1.0}
        for index, ch in enumerate(text)
    ]
    return json.dumps(entries, ensure_ascii=False)


def test_replace_bbox_covers_exactly_the_changed_chars() -> None:
    payload = runs("甲乙丙丁", "甲XY丁", word_boxes=char_boxes("甲乙丙丁"))
    run = payload["runs"][0]
    assert run["box_indices"] == [1, 2]
    assert run["bbox"] == [0.02, 0.5, 0.06, 0.53]


def test_insert_bbox_is_a_zero_width_point_between_neighbours() -> None:
    payload = runs("他说好", "他说“好", word_boxes=char_boxes("他说好"))
    run = payload["runs"][0]
    assert run["box_indices"] == [1, 2]  # 取景要用左右邻
    left, right = run["bbox"][0], run["bbox"][2]
    assert left == right, "插入是零宽点，不该给一个宽度"
    assert left == pytest.approx((0.04 + 0.04) / 2)  # 左邻右沿 0.04 与右邻左沿 0.04 的中点
    assert run["anchor_bbox"] is not None
    assert run["anchor_bbox"][2] - run["anchor_bbox"][0] > 0, "取景框要有宽度"


def test_insert_at_line_start_uses_the_first_char_box() -> None:
    payload = runs("红楼梦", "《红楼梦", word_boxes=char_boxes("红楼梦"))
    run = payload["runs"][0]
    assert run["box_indices"] == [0]
    assert run["bbox"][0] == pytest.approx(0.0)


def test_english_word_boxes_map_by_position() -> None:
    """英文逐词框（拼接长度 < 行文本长度）走位置分支，bbox 落在那几个词上。"""
    line = "The quick brown fox"
    boxes = json.dumps(
        [
            {"text": "The", "bbox": [0.0, 0.2, 0.06, 0.24]},
            {"text": "quick", "bbox": [0.08, 0.2, 0.16, 0.24]},
            {"text": "brown", "bbox": [0.18, 0.2, 0.27, 0.24]},
            {"text": "fox", "bbox": [0.29, 0.2, 0.35, 0.24]},
        ],
        ensure_ascii=False,
    )
    payload = runs(line, "The quick red fox", word_boxes=boxes)
    run = payload["runs"][0]
    assert payload["quality"] == line_diff.QUALITY_WORD
    assert run["box_indices"] == [2]
    assert run["bbox"] == [0.18, 0.2, 0.27, 0.24]


def test_unmatched_word_boxes_fall_back_to_the_line_box() -> None:
    """字框和行文本对不上（回填脏了）⇒ 退化整行框，不抛、不瞎画。"""
    boxes = json.dumps(
        [{"text": "alpha", "bbox": [0, 0, 0.2, 0.1]}, {"text": "zzz", "bbox": [0.2, 0, 0.4, 0.1]}],
        ensure_ascii=False,
    )
    payload = runs("alpha beta", "alpha gamma", word_boxes=boxes, line_bbox=(0.1, 0.2, 0.9, 0.24))
    run = payload["runs"][0]
    assert payload["quality"] == line_diff.QUALITY_LINE
    assert run["bbox"] == [0.1, 0.2, 0.9, 0.24]
    assert run["box_indices"] == []


def test_no_word_boxes_uses_line_box() -> None:
    payload = runs("甲乙丙", "甲X丙", line_bbox=(0.1, 0.2, 0.9, 0.24))
    assert payload["quality"] == line_diff.QUALITY_LINE
    assert payload["runs"][0]["bbox"] == [0.1, 0.2, 0.9, 0.24]


def test_equal_text_has_no_runs() -> None:
    assert runs("一模一样", "一模一样", word_boxes=char_boxes("一模一样"))["runs"] == []
    assert runs("", "任何", )["runs"] == []
