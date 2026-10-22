"""版心推算与校验（任务 50）的单元测试。

算法是纯函数 `suggest_from_page_boxes`：这里用手写的行框覆盖
"抖动、短行、书眉页码、页数太少、边缘离散"几种情况，不建整本书。
真书上的效果在 `tests/integration/test_margin_box_api.py` 与真浏览器验收里。
"""

from __future__ import annotations

import pytest

from book2text.core.project import margin_box
from book2text.core.project.library import Page, Project


def _page(no: int, mode: str = "inherit", box=None) -> Page:
    return Page(
        page_id=f"p{no}",
        page_no=no,
        page_label="",
        width_pt=595.0,
        height_pt=842.0,
        rotation=0,
        page_type="body",
        include=True,
        has_text_layer=False,
        margin_box=box,
        margin_box_mode=mode,
    )


def _project(box=None) -> Project:
    return Project(
        project_id="b2t_TEST01",
        name="测试",
        source_file_name="a.pdf",
        source_sha256="x",
        page_count=10,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
        schema_version=11,
        margin_box=box,
    )


def _body_lines(no: int, *, left=0.10, right=0.90, top=0.10, bottom=0.90) -> list[list[float]]:
    """一页 5 行正文（每行宽度都过短行阈值）。"""
    return [
        [left, top + index * 0.18, right, top + index * 0.18 + 0.02]
        for index in range(5)
    ]


def test_normalize_rejects_bad_geometry() -> None:
    with pytest.raises(margin_box.MarginBoxError):
        margin_box.normalize_margin_box([0.9, 0.1, 0.2, 0.9])
    with pytest.raises(margin_box.MarginBoxError):
        margin_box.normalize_margin_box([0.1, 0.1, 0.9, 1.2])
    with pytest.raises(margin_box.MarginBoxError):
        margin_box.normalize_margin_box([0.49, 0.1, 0.50, 0.9])  # 太窄
    with pytest.raises(margin_box.MarginBoxError):
        margin_box.normalize_margin_box([0.1, 0.1, 0.9])


def test_normalize_accepts_and_rounds() -> None:
    assert margin_box.normalize_margin_box(None) is None
    assert margin_box.normalize_margin_box([0.12345678, 0.2, 0.9, 0.95]) == (
        0.123457,
        0.2,
        0.9,
        0.95,
    )


def test_suggestion_is_stable_against_ocr_jitter() -> None:
    """边缘 ±0.003 的抖动不该改变结果：最密窗口取中位数。"""
    page_boxes = {}
    for page_no in range(1, 21):
        jitter = (page_no % 5 - 2) * 0.0015
        page_boxes[page_no] = _body_lines(
            page_no, left=0.10 + jitter, right=0.90 + jitter, top=0.10, bottom=0.90
        )
    result = margin_box.suggest_from_page_boxes(page_boxes)
    assert result.reliable is True
    assert result.pages == 20
    assert result.margin_box is not None
    # 建议框向外让了 2%（防止 OCR 抖动切字）；识别到的原始边缘在 edges 里
    left, top, right, bottom = result.margin_box
    assert left == pytest.approx(0.10 - margin_box.EDGE_PADDING, abs=0.004)
    assert right == pytest.approx(0.90 + margin_box.EDGE_PADDING, abs=0.004)
    assert top == pytest.approx(0.10 - margin_box.EDGE_PADDING, abs=0.002)
    assert bottom == pytest.approx(0.84 + margin_box.EDGE_PADDING, abs=0.002)
    assert result.edges["left"].value == pytest.approx(0.10, abs=0.004)
    assert result.edges["right"].value == pytest.approx(0.90, abs=0.004)
    assert result.confidence == "high"


def test_short_lines_and_edge_bands_do_not_pull_the_box() -> None:
    """页眉 / 页码那种短行与页面边缘行被剔除；居中标题也不改变左边缘。"""
    page_boxes = {}
    for page_no in range(1, 11):
        boxes = _body_lines(page_no)
        boxes.append([0.65, 0.03, 0.80, 0.05])  # 书眉：页面最上
        boxes.append([0.48, 0.96, 0.52, 0.98])  # 页码：页面最下
        boxes.append([0.40, 0.30, 0.60, 0.32])  # 居中短行（宽度 20%）
        page_boxes[page_no] = boxes
    result = margin_box.suggest_from_page_boxes(page_boxes)
    assert result.margin_box is not None
    assert result.edges["left"].value == pytest.approx(0.10, abs=0.002), (
        "短行不能把左边缘拉到 0.4"
    )
    assert result.edges["top"].value == pytest.approx(0.10, abs=0.002), (
        "书眉不能把上边缘拉到 0.03"
    )
    assert result.edges["bottom"].value == pytest.approx(0.84, abs=0.002), (
        "页码不能把下边缘拉到 0.98（正文最后一行的底是 0.84）"
    )


def test_too_few_pages_is_reported_as_unreliable() -> None:
    result = margin_box.suggest_from_page_boxes(
        {no: _body_lines(no) for no in range(1, 4)}
    )
    assert result.reliable is False
    assert result.confidence == "low"
    assert any("少于 5 页" in note for note in result.notes)


def test_large_edge_spread_is_reported_as_unreliable() -> None:
    """每页左右边缘差很多（双栏 / 旁批 / 拼版）→ 如实说不可靠。"""
    page_boxes = {
        no: _body_lines(no, left=0.05 + (no % 10) * 0.045, right=0.90)
        for no in range(1, 21)
    }
    result = margin_box.suggest_from_page_boxes(page_boxes)
    assert result.reliable is False
    assert result.confidence == "low"
    assert any("覆盖" in note or "离散较大" in note for note in result.notes)


def test_no_lines_gives_no_box() -> None:
    result = margin_box.suggest_from_page_boxes({1: []})
    assert result.margin_box is None
    assert result.reliable is False
    assert result.pages == 0


def test_effective_margin_box_three_modes() -> None:
    project = _project(box=(0.1, 0.1, 0.9, 0.9))
    assert margin_box.effective_margin_box(project, _page(1)) == (0.1, 0.1, 0.9, 0.9)
    assert margin_box.effective_margin_box(
        project, _page(2, mode="custom", box=(0.2, 0.2, 0.8, 0.8))
    ) == (0.2, 0.2, 0.8, 0.8)
    assert margin_box.effective_margin_box(project, _page(3, mode="none")) is None
    # custom 页缺四边（历史坏数据）时不要退回全局：那会显示一个不是用户设置的框
    assert margin_box.effective_margin_box(project, _page(4, mode="custom", box=None)) is None
