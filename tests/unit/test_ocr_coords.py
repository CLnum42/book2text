"""坐标归一化测试（说明书 5.2）。

说明书 5.2 明确要求："OCR 适配器负责把引擎返回的像素坐标转换为归一化坐标，
**并有单元测试覆盖（含旋转页）**"。因此这里既测纯函数，也测真实 PDF 上的
显示尺寸与渲染结果。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from book2text.core.ocr.base import BBox, normalize_quad
from book2text.core.pdf import render


# ---------------------------------------------------------------- 纯函数

def test_normalize_quad_maps_full_page() -> None:
    quad = [[0, 0], [100, 0], [100, 50], [0, 50]]
    box = normalize_quad(quad, width=100, height=50)
    assert box.as_list() == [0.0, 0.0, 1.0, 1.0]


def test_normalize_quad_takes_bounding_rectangle_of_rotated_quad() -> None:
    """引擎给的是旋转四边形，本项目只需轴对齐外接矩形。"""
    quad = [[10, 20], [60, 5], [70, 40], [15, 55]]
    box = normalize_quad(quad, width=100, height=100)
    assert box.x0 == pytest.approx(0.10)
    assert box.y0 == pytest.approx(0.05)
    assert box.x1 == pytest.approx(0.70)
    assert box.y1 == pytest.approx(0.55)


def test_normalize_quad_clamps_out_of_range() -> None:
    """引擎的框可能越界（尤其裁行图外扩 2% 之后），结果必须仍在 0–1。"""
    quad = [[-30, -20], [150, 0], [150, 130], [-30, 100]]
    box = normalize_quad(quad, width=100, height=100)
    assert box.as_list() == [0.0, 0.0, 1.0, 1.0]


def test_normalize_quad_rejects_zero_size_image() -> None:
    with pytest.raises(ValueError):
        normalize_quad([[0, 0], [1, 1], [1, 0], [0, 1]], width=0, height=10)


def test_bbox_expanded_can_exceed_page_for_cropping() -> None:
    """说明书 8.5：裁行图要外扩约 2% 以保留笔画。

    因此 `expanded()` **故意不夹紧**到 0–1——裁图时按图像边界处理即可，
    在这里截断会丢掉边缘笔画。
    """
    box = BBox(0.0, 0.0, 0.5, 0.5)
    grown = box.expanded(0.02)
    assert grown.x0 < 0
    assert grown.y0 < 0
    assert grown.x1 > 0.5


def test_bbox_width_and_height() -> None:
    box = BBox(0.1, 0.2, 0.4, 0.5)
    assert box.width == pytest.approx(0.3)
    assert box.height == pytest.approx(0.3)


# ---------------------------------------------------------------- 旋转页

def test_rotated_page_display_size_is_landscape(rotated_pdf: Path) -> None:
    """/Rotate=90 的页，显示尺寸应当宽高交换（横向）。"""
    info = render.info(rotated_pdf)
    assert info.page_count == 1
    assert info.page_width_pt > info.page_height_pt, "显示尺寸应为横向"


def test_page_rotation_is_reported(rotated_pdf: Path) -> None:
    assert render.page_rotation(rotated_pdf, 0) == 90


def test_unrotated_page_reports_zero_rotation(sample_pdf: Path) -> None:
    assert render.page_rotation(sample_pdf, 0) == 0


def test_rotated_page_renders_visible_content(rotated_pdf: Path) -> None:
    """回归测试：曾经因为踩到坏夹具，误以为 PDFium 需要手工补旋转。

    真相是 PDFium **已经正确应用了 /Rotate**；这里锁定"默认渲染必须
    有内容"这一事实，防止今后又给它加上重复旋转而渲染出空白页。
    """
    image = render.render_page_image(rotated_pdf, 0, dpi=100)
    try:
        assert image.width > image.height, "渲染出的图像应为横向（显示方向）"
        # 用直方图统计暗像素，避免依赖 numpy（OCR 依赖是可选装的）
        histogram = image.convert("L").histogram()
        ink = sum(histogram[:160])
        assert ink > 1000, f"默认渲染几乎是空白（墨迹像素 {ink}）"
    finally:
        image.close()


def test_render_size_matches_display_size_ratio(rotated_pdf: Path) -> None:
    """渲染出的图像必须与 display 尺寸成比例，否则归一化坐标对不上。"""
    info = render.info(rotated_pdf)
    image = render.render_page_image(rotated_pdf, 0, dpi=144)
    try:
        page_ratio = info.page_width_pt / info.page_height_pt
        image_ratio = image.width / image.height
        assert image_ratio == pytest.approx(page_ratio, rel=0.01)
    finally:
        image.close()


def test_display_and_ocr_share_one_render_path(rotated_pdf: Path) -> None:
    """显示用的 PNG 与 OCR 用的图像必须同源，否则框会错位。"""
    from io import BytesIO

    png = render.render_page_png(rotated_pdf, 0, profile="view")
    with Image.open(BytesIO(png)) as shown:
        shown_size = shown.size
    expected = render.render_page_image(rotated_pdf, 0, dpi=render.RENDER_PROFILES["view"])
    try:
        assert shown_size == expected.size
    finally:
        expected.close()
