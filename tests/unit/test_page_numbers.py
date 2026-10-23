"""页码模板聚类与数值校验（任务 55）的单元测试。

聚类 / 校验都是纯函数：这里用手写的候选和 Page 覆盖
"奇偶交替、单簇、步长不是 1、人为断点、多候选、未识别页"几种情况，
不建整本书。真书上的填充率与异常数在任务报告与
`tests/integration/test_page_numbers_api.py` 里。
"""

from __future__ import annotations

from book2text.core.project import page_numbers
from book2text.core.project.library import Page


def _page(no: int, label: str = "") -> Page:
    return Page(
        page_id=f"p{no}",
        page_no=no,
        page_label=label,
        width_pt=595.0,
        height_pt=842.0,
        rotation=0,
        page_type="body",
        include=True,
        has_text_layer=False,
    )


def _candidate(page_no: int, value: str, x: float, y: float, kind: str = "line"):
    return page_numbers.Candidate(
        page_no=page_no, value=value, kind=kind, x=x, y=y, text=value, block_type="paragraph"
    )


def test_alternate_clusters_merge_into_one_template() -> None:
    """奇数页在右、偶数页在左 → 一个"奇右偶左"的模板，不是两个单簇。"""
    candidates = {}
    for page_no in range(1, 7):
        center = (0.8, 0.05) if page_no % 2 else (0.2, 0.05)
        candidates[page_no] = [_candidate(page_no, str(page_no), *center)]
    templates = page_numbers.build_templates(candidates, [_page(n) for n in range(1, 7)])

    assert len(templates) == 1
    template = templates[0]
    assert template.mode == page_numbers.MODE_ALTERNATE
    assert template.coverage == 6
    assert template.reliable is True
    assert "奇右偶左" in template.label
    assert template.centers["odd"][0] > template.centers["even"][0]


def test_single_position_becomes_an_all_pages_template() -> None:
    candidates = {
        page_no: [_candidate(page_no, str(page_no), 0.5, 0.05)]
        for page_no in range(1, 7)
    }
    templates = page_numbers.build_templates(candidates, [_page(n) for n in range(1, 7)])
    assert len(templates) == 1
    assert templates[0].mode == page_numbers.MODE_ALL
    assert templates[0].coverage == 6
    assert templates[0].reliable is True


def test_step_two_numbers_are_flagged_unreliable() -> None:
    """《红楼梦》式的偶数页码（每页 +2）：结构上是模板，但数值偏移不恒定，必须标不可靠。"""
    candidates = {
        page_no: [_candidate(page_no, str(page_no * 2), 0.04, 0.98)]
        for page_no in range(2, 11)
    }
    templates = page_numbers.build_templates(candidates, [_page(n) for n in range(2, 11)])
    assert templates
    template = templates[0]
    assert template.mode == page_numbers.MODE_ALL
    assert template.reliable is False
    assert any("偏移不恒定" in note for note in template.notes)


def test_ambiguous_page_is_not_counted_in_template_values() -> None:
    candidates = {
        1: [_candidate(1, "1", 0.5, 0.05), _candidate(1, "9", 0.505, 0.05)],
        2: [_candidate(2, "2", 0.5, 0.05)],
        3: [_candidate(3, "3", 0.5, 0.05)],
    }
    templates = page_numbers.build_templates(candidates, [_page(n) for n in range(1, 4)])
    assert templates
    values = {item["page_no"] for item in templates[0].values}
    assert "1" not in values
    assert values == {"2", "3"}


def test_validate_flags_jump_and_offset_break_on_the_same_page() -> None:
    pages = [_page(n) for n in range(1, 7)]
    printed = {n: (str(n), "template") for n in range(1, 6)}
    printed[6] = ("99", "manual")  # 人为制造断点
    result = page_numbers.validate_mapping(pages, printed, recognized_pages={1, 2, 3, 4, 5, 6})
    assert result["counts"]["jump"] == 1
    assert result["counts"]["offset_break"] == 1
    assert result["anomalies"]["jump"][0]["page_no"] == 6
    assert result["anomalies"]["offset_break"][0]["page_no"] == 6


def test_validate_keeps_ambiguous_empty_and_unrecognized_separate() -> None:
    pages = [_page(1), _page(2)]
    result = page_numbers.validate_mapping(
        pages,
        {},
        recognized_pages={1},
        ambiguous={1: [{"value": "1"}, {"value": "7"}]},
        no_candidate={},
    )
    assert result["counts"]["ambiguous"] == 1
    assert result["counts"]["no_candidate"] == 0
    assert result["counts"]["not_recognized"] == 1
    assert result["not_recognized"]["pages"] == [2]
    assert result["anomalies"]["ambiguous"][0]["value"] is None


def test_normalize_template_rejects_bad_shapes() -> None:
    good = {
        "band": "top",
        "mode": "all",
        "centers": {"all": [0.5, 0.05]},
        "tolerance": {"x": 0.06, "y": 0.05},
    }
    normalized = page_numbers.normalize_template(good)
    assert normalized["band"] == "top"
    assert normalized["tolerance"] == {"x": 0.06, "y": 0.05}

    for bad in (
        {"band": "middle", "mode": "all", "centers": {"all": [0.5, 0.05]}},
        {"band": "top", "mode": "all", "centers": {}},
        {"band": "top", "mode": "alternate", "centers": {"all": [0.5, 0.05]}},
        {"band": "top", "mode": "all", "centers": {"all": [1.5, 0.05]}},
    ):
        try:
            page_numbers.normalize_template(bad)
        except page_numbers.PageNumberError:
            pass
        else:  # pragma: no cover - 失败时给出可读信息
            raise AssertionError(f"应当拒绝：{bad}")


def test_canonical_page_value() -> None:
    from book2text.core.structure import regions

    assert regions.canonical_page_value("12") == "12"
    assert regions.canonical_page_value("· 62 ·") == "62"
    assert regions.canonical_page_value("iv") == "IV"
    assert regions.canonical_page_value("IIII") is None
    assert regions.canonical_page_value("2 谁是巴赫金? 11") is None
    assert regions.canonical_page_value("0") is None
