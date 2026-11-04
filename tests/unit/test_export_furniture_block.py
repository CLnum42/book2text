"""「书眉 + 页码」被 OCR 并成正文块时，导出必须把它当家具（2026-11-04，CER 首测 p36）。

**现象**：红楼梦 40 页项目 p36 的导出正文里出现了 `红楼梦画\\n72`——竖排书眉
「红楼梦 第三回」与页脚页码「72」被识别成一个 `paragraph` 块。其余 37 页同样的块
靠"版心外"被排掉，p36 的版心拟合把左侧竖排栏包进了版心，于是它落在版心内，
`exclude_header_footer`（按块类型）与首块页眉规则（只认 `Page N`）都拦不住。

**修法**：`header_cleanup.is_furniture_block` 只看形状——至少两行、至少一行是整行页码、
其余行短且无句读。导出侧只在"页首 / 页尾块"上判它，正文段与标题块必须放行。

夹具就是 p36 那块的真实文本（数据库 `block.text`），不是编出来的形态。
"""

from __future__ import annotations

from book2text.core.export import header_cleanup

#: 夹具：b2t_H6GXVG p36 首块的真实文本（block 01M62XF2M5RNJE4RJY7MWR7PFG）
P36_LINES = ["红楼梦画", "72"]


def test_p36_vertical_header_block_is_furniture() -> None:
    """p36 那块：「红楼梦画」+ 页码 → 家具，不许进正文。"""
    assert header_cleanup.is_furniture_block(P36_LINES)


def test_same_shape_with_ocr_noise_suffix_is_furniture() -> None:
    """同一本书别的页：书眉被识别成「红楼梦/000」这种噪声形态，也必须是家具。"""
    assert header_cleanup.is_furniture_block(["红楼梦/000", "70"])
    assert header_cleanup.is_furniture_block(["红楼梦", "36", "1"])


def test_title_block_without_page_number_is_kept() -> None:
    """标题块「红楼梦 / 第三回」没有页码行 ⇒ 不归这条规则（它可能是真标题）。"""
    assert not header_cleanup.is_furniture_block(["红楼梦", "第三回"])


def test_body_paragraph_with_number_line_is_kept() -> None:
    """正文里出现句读、行也长 ⇒ 放行（哪怕末行是个数字）。"""
    assert not header_cleanup.is_furniture_block(
        ["宝玉听了，便笑道：“好。”", "72"]
    )


def test_single_page_line_block_is_handled_by_another_rule() -> None:
    """单行页码块归 `is_labeled_page_line` 那条，本规则不重叠（避免两处抢同一种块）。"""
    assert not header_cleanup.is_furniture_block(["Page 28"])
    assert not header_cleanup.is_furniture_block(["72"])
