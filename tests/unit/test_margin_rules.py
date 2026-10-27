"""按版心判定正文（任务 51）的单元测试：中心点、两层判定、页码候选。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from book2text.core.export import margin_rules
from book2text.core.project.library import Page, Project


def _page(no=1, *, mode="inherit", box=None, label="") -> Page:
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
        margin_box=box,
        margin_box_mode=mode,
    )


def _project(box=None, source=None) -> Project:
    return Project(
        project_id="b2t_TEST01",
        name="测试",
        source_file_name="a.pdf",
        source_sha256="x",
        page_count=1,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
        schema_version=12,
        margin_box=box,
        margin_box_source=source,
    )


def _block(block_id, block_type, bbox, text="") -> SimpleNamespace:
    return SimpleNamespace(
        block_id=block_id, block_type=block_type, bbox=bbox, text=text
    )


def test_center_point_inclusive_and_none_bbox() -> None:
    box = (0.1, 0.1, 0.9, 0.9)
    assert margin_rules.center_inside((0.1, 0.5), box) is True
    assert margin_rules.center_inside((0.05, 0.5), box) is False
    assert margin_rules.block_center([0.0, 0.2, 0.2, 0.4]) == pytest.approx((0.1, 0.3))
    assert margin_rules.block_center(None) is None


def test_two_layer_judgement_inside_notes_and_outside_paragraphs() -> None:
    """版心外段落不进正文；版心内脚注 / 插图也不进正文（类型层兜底）。"""
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page()
    blocks = [
        _block("b1", "paragraph", [0.2, 0.2, 0.8, 0.3], "正文"),
        _block("b2", "paragraph", [0.2, 0.02, 0.8, 0.05], "书眉"),
        _block("b3", "footnote", [0.1, 0.5, 0.9, 0.55], "① 注文"),
        _block("b4", "figure", [0.2, 0.6, 0.8, 0.7], "图"),
        _block("b5", "page_number", [0.45, 0.96, 0.55, 0.98], "11"),
    ]
    layout = margin_rules.classify_page(page, blocks, project, enabled=True)

    assert layout.applied is True
    assert layout.inside_ids == {"b1", "b3", "b4"}
    assert layout.outside_ids == {"b2", "b5"}
    assert layout.page_number_values == {"b5": "11"}
    assert layout.note_ids == {"b3"}
    assert layout.note_inside_ids == {"b3"}
    assert layout.counts == {"inside": 3, "outside": 2, "rescued": 0, "page_number": 1}


def test_straddling_block_uses_center_not_full_containment() -> None:
    """跨在版心左边界上的块留在正文（刀 0：文字列里的字不删），整块在列外的仍排除。

    只按中心点判会把"中心差一点在框外、字却在列里"的块整块删掉；现在的口径是：
    x 范围与版心有重叠、且中心不在上下 8% 边带 → 保留，并记进 `rescued_ids`。
    """
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page()
    blocks = [
        _block("inside", "paragraph", [0.02, 0.5, 0.2, 0.55]),   # 中心 0.11
        _block("straddle", "paragraph", [0.02, 0.5, 0.15, 0.55]),  # 中心 0.085，与列重叠
        _block("margin", "paragraph", [0.01, 0.5, 0.08, 0.55]),  # 整块在左列外
    ]
    layout = margin_rules.classify_page(page, blocks, project, enabled=True)
    assert layout.inside_ids == {"inside", "straddle"}
    assert layout.outside_ids == {"margin"}
    assert layout.rescued_ids == {"straddle"}


def test_page_none_disables_the_margin_layer() -> None:
    """页级 none：整页都是正文（不做版心排除），仍按块类型。"""
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page(mode="none")
    blocks = [
        _block("b1", "paragraph", [0.2, 0.02, 0.8, 0.05]),  # 版心外，但 none 不筛
        _block("b2", "paragraph", [0.45, 0.96, 0.55, 0.98]),  # 未标页码的数字也留在正文
        _block("b3", "page_number", [0.45, 0.97, 0.55, 0.99], "11"),
    ]
    layout = margin_rules.classify_page(page, blocks, project, enabled=True)
    assert layout.applied is False
    assert layout.unset is False
    assert layout.inside_ids == {"b1", "b2", "b3"}
    assert layout.outside_ids == set()
    assert layout.page_number_values == {"b3": "11"}


def test_missing_margin_falls_back_to_block_types() -> None:
    """项目没设版心：unset，全部按块类型判定；混合书眉也不猜页码。"""
    project = _project(None)
    page = _page(label="11")
    blocks = [
        _block("b1", "paragraph", [0.2, 0.02, 0.8, 0.05], "2 谁是巴赫金? 11"),
        _block("b2", "paragraph", [0.2, 0.2, 0.8, 0.3], "正文"),
        _block("b3", "page_number", [0.45, 0.96, 0.55, 0.98], "11"),
    ]
    layout = margin_rules.classify_page(page, blocks, project, enabled=True)
    assert layout.applied is False
    assert layout.unset is True
    assert layout.inside_ids == {"b1", "b2", "b3"}
    assert layout.page_number_values == {"b3": "11"}


def test_auto_margin_is_display_only_for_export() -> None:
    """任务 53：自动推算的全局版心（source=auto）不参与导出。

    页眉在版心外、正文在版心内——如果自动框生效，页眉会被排除；
    但自动框没人确认过，导出必须退回块类型判定（页眉仍是 paragraph → 留在正文）。
    手动采用之后（source=manual）才按版心判定。
    """
    box = (0.1, 0.1, 0.9, 0.9)
    blocks = [
        _block("header", "paragraph", [0.2, 0.02, 0.8, 0.05], "书眉"),
        _block("body", "paragraph", [0.2, 0.3, 0.8, 0.35], "正文"),
    ]

    auto = margin_rules.classify_page(
        _page(), blocks, _project(box, source="auto"), enabled=True
    )
    assert auto.applied is False
    assert auto.unset is True
    assert auto.inside_ids == {"header", "body"}

    manual = margin_rules.classify_page(
        _page(), blocks, _project(box, source="manual"), enabled=True
    )
    assert manual.applied is True
    assert manual.outside_ids == {"header"}
    assert manual.inside_ids == {"body"}

    # 迁移 0012 之前手动设过的项目：source 是 None + 版心非空，按手动对待
    legacy = margin_rules.classify_page(
        _page(), blocks, _project(box, source=None), enabled=True
    )
    assert legacy.applied is True
    assert legacy.outside_ids == {"header"}


def test_page_number_requires_outside_and_edge_band() -> None:
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page()
    blocks = [
        _block("top", "paragraph", [0.45, 0.02, 0.55, 0.04], "63"),
        _block("bottom", "paragraph", [0.45, 0.96, 0.55, 0.98], "· 64 ·"),
        _block("middle", "paragraph", [0.45, 0.5, 0.55, 0.52], "65"),
        # 人工标成 page_number、但在页中左侧（真书第 65 页那种正文引用）：不是页码
        _block("mid_number", "page_number", [0.04, 0.63, 0.08, 0.65], "39"),
        _block("inside", "paragraph", [0.15, 0.2, 0.25, 0.22], "66"),
    ]
    layout = margin_rules.classify_page(page, blocks, project, enabled=True)
    assert layout.page_number_values == {"top": "63", "bottom": "64"}


def test_mixed_header_uses_page_label_not_position_guess() -> None:
    """书眉 + 页码粘在一起时，只认与 PDF 印刷页码一致的那个数字。"""
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page(label="11")
    blocks = [
        _block("match", "paragraph", [0.4, 0.02, 0.9, 0.05], "2 谁是巴赫金? 11"),
        _block("mismatch", "paragraph", [0.4, 0.06, 0.9, 0.09], "3 谁是巴赫金? 12"),
    ]
    layout = margin_rules.classify_page(page, blocks, project, enabled=True)
    assert layout.page_number_values == {"match": "11"}


def test_off_switch_keeps_every_block_inside() -> None:
    project = _project((0.1, 0.1, 0.9, 0.9))
    page = _page()
    blocks = [_block("b1", "paragraph", [0.2, 0.02, 0.8, 0.05], "书眉")]
    layout = margin_rules.classify_page(page, blocks, project, enabled=False)
    assert layout.applied is False
    assert layout.unset is False
    assert layout.inside_ids == {"b1"}
