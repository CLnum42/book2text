"""脚注 / 旁批建议（任务 52）的单元测试：信号、锚点、永不 high。"""

from __future__ import annotations

from types import SimpleNamespace

from book2text.core.project import structure
from book2text.core.project.library import Page, Project


def _page(no=1, mode="inherit", box=None) -> Page:
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
        page_count=1,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
        schema_version=11,
        margin_box=box,
    )


def _block(block_id, text, bbox, block_type="paragraph", order=0) -> SimpleNamespace:
    return SimpleNamespace(
        block_id=block_id,
        page_no=1,
        order_index=order,
        block_type=block_type,
        bbox=bbox,
        text=text,
    )


def _profile(heights=None) -> structure._LineProfile:
    return structure._LineProfile(
        median_height=0.02,
        median_gap=0.01,
        heights_by_block=heights or {},
    )


def test_note_marker_patterns() -> None:
    assert structure._note_marker("① 注文") == "圈号"
    assert structure._note_marker("* 注文") == "*"
    assert structure._note_marker("注：这是注") == "注记"
    assert structure._note_marker("［注 1］正文") == "注记"
    assert structure._note_marker("1 阿纳托利·卢那察尔斯基") == "数字标记"
    assert structure._note_marker("曾任教育人民委员会委员。——译注") == "——译注"
    # 四位年份 + 汉字不是"数字标记"；避免把正文年份当注释符号
    assert structure._note_marker("1917年2月，沙皇尼古拉二世退位") is None
    assert structure._note_marker("普通正文") is None


def test_footnote_signals_and_review_confidence() -> None:
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page()
    body = _block("body", "正文段落", [0.1, 0.2, 0.9, 0.25], order=0)
    note = _block("note", "1 注文：卢那察尔斯基", [0.1, 0.85, 0.9, 0.87], order=1)
    blocks = [body, note]
    profile = _profile({"body": [0.02], "note": [0.015]})
    labels = structure._footnote_signal_labels(note, page, blocks, 1, profile, project)
    assert "位于版心下沿" in labels
    assert any(item.startswith("行高较小") for item in labels)
    assert any(item.startswith("注释符号") for item in labels)
    assert any(item.startswith("与上一块间距较大") for item in labels)

    suggestion = structure._note_suggestion(note, page, blocks, 1, profile, project)
    assert suggestion is not None
    assert suggestion.suggested_type == "footnote"
    assert suggestion.confidence == structure.CONFIDENCE_REVIEW
    assert len(suggestion.note_signals) >= 2


def test_position_plus_gap_alone_is_not_enough() -> None:
    """真书第 5/6 页的「豆瓣id:…」只有位置 + 间距，必须被挡掉。"""
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page()
    body = _block("body", "上一段正文", [0.1, 0.2, 0.9, 0.25], order=0)
    byline = _block("byline", "豆瓣id:坏卡超", [0.1, 0.85, 0.4, 0.87], order=1)
    blocks = [body, byline]
    profile = _profile({"body": [0.02], "byline": [0.02]})
    labels = structure._footnote_signal_labels(byline, page, blocks, 1, profile, project)
    assert "位于版心下沿" in labels
    assert any(item.startswith("与上一块间距较大") for item in labels)
    assert not any(item.startswith("注释符号") or item.startswith("行高较小") for item in labels)
    assert structure._note_suggestion(byline, page, blocks, 1, profile, project) is None


def test_long_bottom_paragraph_is_not_a_footnote() -> None:
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page()
    body = _block("body", "正文", [0.1, 0.2, 0.9, 0.25], order=0)
    long_text = "这是很长的正文段落，" * 20
    paragraph = _block("paragraph", long_text, [0.1, 0.72, 0.9, 0.88], order=1)
    profile = _profile({"body": [0.02], "paragraph": [0.02]})
    # 即使位置 + 间距命中，超过字数上限也不给脚注（避免第 30 页那种正文末段）
    assert len(long_text) > structure.FOOTNOTE_MAX_CHARS
    assert structure._note_suggestion(
        paragraph, page, [body, paragraph], 1, profile, project
    ) is None


def test_margin_note_requires_outside_short_and_not_number() -> None:
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page()
    side = _block("side", "旁批：这一行要核对", [0.02, 0.5, 0.08, 0.55], order=0)
    suggestion = structure._note_suggestion(
        side, page, [side], 0, _profile({"side": [0.02]}), project
    )
    assert suggestion is not None
    assert suggestion.suggested_type == "margin_note"
    assert suggestion.confidence == structure.CONFIDENCE_REVIEW
    assert suggestion.region == "left"

    number = _block("number", "63", [0.02, 0.5, 0.08, 0.55], order=0)
    assert structure._note_suggestion(
        number, page, [number], 0, _profile({"number": [0.02]}), project
    ) is None

    inside = _block("inside", "短句", [0.2, 0.5, 0.4, 0.55], order=0)
    assert structure._note_suggestion(
        inside, page, [inside], 0, _profile({"inside": [0.02]}), project
    ) is None


def test_allow_margin_note_false_keeps_high_header() -> None:
    """竖排书左侧短行通常是书眉：不允许旁批覆盖 high 页眉。"""
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page()
    side = _block("side", "红楼梦\n6", [0.02, 0.566, 0.055, 0.989], order=0)
    suggestion = structure._note_suggestion(
        side,
        page,
        [side],
        0,
        _profile({"side": [0.02]}),
        project,
        allow_margin_note=False,
    )
    assert suggestion is None
