"""PDF 渲染模块测试。

只验证「能不能打开、能不能渲染」，不评估渲染质量——那属于 Phase 0 第 3 项。
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from book2text.core.pdf import render


def test_info_reports_page_count(sample_pdf: Path) -> None:
    info = render.info(sample_pdf)
    assert info.page_count == 3
    assert info.page_width_pt > 0
    assert info.page_height_pt > 0


def test_page_labels_readable(sample_pdf: Path) -> None:
    labels = render.page_labels(sample_pdf)
    assert len(labels) == 3


def test_render_returns_png_bytes(sample_pdf: Path) -> None:
    data = render.render_page_png(sample_pdf, 0)
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    assert len(data) > 1000


def test_render_profiles_increase_resolution(sample_pdf: Path) -> None:
    widths = {}
    for profile in ("thumb", "view", "zoom"):
        with Image.open(BytesIO(render.render_page_png(sample_pdf, 0, profile=profile))) as image:
            widths[profile] = image.width
    assert widths["thumb"] < widths["view"] < widths["zoom"]


def test_render_page_out_of_range(sample_pdf: Path) -> None:
    with pytest.raises(render.PdfError, match="越界"):
        render.render_page_png(sample_pdf, 99)


def test_render_negative_page_index(sample_pdf: Path) -> None:
    with pytest.raises(render.PdfError, match="越界"):
        render.render_page_png(sample_pdf, -1)


def test_render_rejects_unknown_profile(sample_pdf: Path) -> None:
    with pytest.raises(render.PdfError, match="未知的渲染档位"):
        render.render_page_png(sample_pdf, 0, profile="gigantic")


def test_opening_non_pdf_raises(tmp_path: Path) -> None:
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.4\nthis is not a real pdf")
    with pytest.raises(render.PdfError):
        render.info(broken)


def test_backend_version_is_reported() -> None:
    assert render.backend_version() != ""


def test_concurrent_rendering_is_serialized(scan_sample_pdf: Path) -> None:
    """并发渲染不能随机失败。

    **真机上撞到过**（2026-10-14）：pdfium 不是线程安全的，接口层用线程池渲染缩略图时，
    `document[i]` 会抛 "Failed to load page."，任务包生成里的 `import_pages` 也跟着失败。
    修法是 `render.py` 里所有碰 pdfium 的函数都串行化在同一把锁上（`_serialized`）。
    """
    import threading

    errors: list[str] = []

    def worker(index: int) -> None:
        try:
            image = render.render_page_image(scan_sample_pdf, index, dpi=72)
            image.close()
        except Exception as exc:  # noqa: BLE001 - 记录任何失败
            errors.append(f"第 {index} 页：{exc}")

    threads = [
        threading.Thread(target=worker, args=(index,))
        for index in range(min(12, render.info(scan_sample_pdf).page_count))
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors, f"并发渲染失败：{errors}"
