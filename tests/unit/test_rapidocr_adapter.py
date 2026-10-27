"""RapidOCR 适配器测试。

**依赖可选：** OCR 运行时在 `ocr-eval` 依赖组里（`uv sync --group ocr-eval`），
选型未定前不进核心依赖。未安装时整个模块跳过，核心测试仍可运行——
这是刻意的，见 docs/decisions.md D-011 与 pyproject.toml 的说明。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from book2text.core.ocr.adapters import RapidOcrAdapter
from book2text.core.ocr.base import OcrEngine, OcrParams
from book2text.core.pdf import render

pytestmark = [pytest.mark.ocr, pytest.mark.macos_only]

adapter = RapidOcrAdapter()


@pytest.fixture(autouse=True)
def _require_ocr_engine():
    """没装 OCR 依赖时跳过（只在本模块的用例真正执行时判断）。

    注意：这里**不用模块级 skip**——模块级 skip 发生在 marker 过滤之前，
    会让 Ubuntu CI 的"零 skip"守卫误报。macOS 全量跑时依赖都在，不会跳过。
    """
    available, reason = adapter.available()
    if not available:
        pytest.skip(f"未安装 OCR 引擎（uv sync --group ocr-eval）：{reason}")


def test_adapter_satisfies_protocol() -> None:
    assert isinstance(adapter, OcrEngine)


def test_available_reports_no_reason_when_usable() -> None:
    ok, reason = adapter.available()
    assert ok is True
    assert reason == ""


def test_version_is_reported() -> None:
    assert adapter.version() not in ("", "unknown")


def test_supported_languages_include_chinese_and_english() -> None:
    languages = adapter.supported_languages()
    assert "ch" in languages
    assert "en" in languages


def test_recognize_returns_line_level_boxes(rotated_pdf: Path) -> None:
    """核心断言：每一行都有自己的 bbox（说明书 8.4 的门槛项）。"""
    image = render.render_page_image(rotated_pdf, 0, dpi=200)
    try:
        result = adapter.recognize(image, OcrParams())
    finally:
        image.close()

    assert result.engine_id == adapter.engine_id
    assert len(result.lines) >= 2, "旋转页上有三行文字，识别结果不应为空"
    assert all(line.text.strip() for line in result.lines)
    assert all(line.bbox is not None for line in result.lines)


def test_recognized_boxes_are_normalized_and_in_range(rotated_pdf: Path) -> None:
    image = render.render_page_image(rotated_pdf, 0, dpi=200)
    try:
        result = adapter.recognize(image, OcrParams())
        expected_width, expected_height = image.size
    finally:
        image.close()

    assert result.image_width == expected_width
    assert result.image_height == expected_height

    for line in result.lines:
        for value in line.bbox.as_list():
            assert 0.0 <= value <= 1.0, f"归一化坐标越界：{line.bbox.as_list()}"
        assert line.bbox.width > 0
        assert line.bbox.height > 0


def test_box_is_independent_of_render_dpi(rotated_pdf: Path) -> None:
    """说明书 5.2：归一化坐标与渲染 DPI 无关。

    同一页在两个 DPI 下识别，同一行的 bbox 应当基本一致。这是"与 DPI 无关"
    这条规范最直接的验证方式。
    """
    boxes: dict[int, list[float]] = {}
    for dpi in (150, 300):
        image = render.render_page_image(rotated_pdf, 0, dpi=dpi)
        try:
            result = adapter.recognize(image, OcrParams(dpi=dpi))
        finally:
            image.close()
        assert result.lines, f"{dpi} DPI 下没有识别到任何行"
        boxes[dpi] = result.lines[0].bbox.as_list()

    for low, high in zip(boxes[150], boxes[300]):
        assert low == pytest.approx(high, abs=0.03), "归一化坐标随 DPI 变了"


def test_recognize_accepts_path(rotated_pdf: Path) -> None:
    """协议允许传 Path（说明书 8.2 将来渲染到 cache/ocr/ 后走这条路）。"""
    from book2text.core.pdf import render as r

    image = r.render_page_image(rotated_pdf, 0, dpi=150)
    try:
        temporary = Path("/tmp/b2t-adapter-path-input.png")
        image.save(temporary)
    finally:
        image.close()

    try:
        result = adapter.recognize(temporary, OcrParams())
        assert result.engine_id == adapter.engine_id
    finally:
        temporary.unlink(missing_ok=True)
