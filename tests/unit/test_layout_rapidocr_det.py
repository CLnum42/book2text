"""RapidOCR 只检测适配器（任务 58）。

**依赖可选：** 与 `test_rapidocr_adapter.py` 一样，未安装 OCR 运行时整个模块跳过；
Windows CI 用显式 `--ignore` 排除这个文件，避免摘要出现 skipped。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from book2text.core.layout.adapters import RapidOcrDetAdapter
from book2text.core.layout.base import LayoutEngine, LayoutParams
from book2text.core.pdf import render

pytestmark = [pytest.mark.ocr, pytest.mark.macos_only]

adapter = RapidOcrDetAdapter()


@pytest.fixture(autouse=True)
def _require_layout_engine():
    """同上：跳过放到运行时，模块级 skip 会污染 marker 过滤后的零 skip 守卫。"""
    available, reason = adapter.available()
    if not available:
        pytest.skip(f"未安装 OCR 引擎（uv sync --group ocr-eval）：{reason}")


def test_adapter_satisfies_protocol() -> None:
    assert isinstance(adapter, LayoutEngine)


def test_detects_lines_without_producing_text(rotated_pdf: Path) -> None:
    image = render.render_page_image(rotated_pdf, 0, dpi=200)
    try:
        result = adapter.detect(image, LayoutParams(dpi=200))
    finally:
        image.close()

    assert result.engine_id == adapter.engine_id
    assert len(result.lines) >= 2, "旋转页上有三行文字，检测结果不应为空"
    assert result.raw["mode"] == "det_only"
    assert result.raw["use_rec"] is False
    # LayoutLine 上根本没有 text 字段：检测阶段不产生文字
    assert not hasattr(result.lines[0], "text")
    for index, line in enumerate(result.lines):
        assert line.reading_order == index
        assert 0.0 <= line.bbox.x0 <= line.bbox.x1 <= 1.0
        assert 0.0 <= line.bbox.y0 <= line.bbox.y1 <= 1.0
