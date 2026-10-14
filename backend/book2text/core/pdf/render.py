"""PDF 打开与页面渲染。

**选型未定。** 说明书 Phase 0 第 3 项要求对比 ``pypdfium2`` 与 ``PyMuPDF``
（渲染效果、页码标签读取、文本层检测、许可证）。本模块暂用 ``pypdfium2``
（许可证较宽松；``PyMuPDF`` 为 AGPL，见说明书 4.2），等 Phase 0 实测后再定，
因此这里有意把 pypdfium2 的调用收在一个模块里，换库时只改这一处。
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import pypdfium2 as pdfium

# 渲染档位 → 目标 DPI。说明书 8.2 注明默认值由 Phase 0 样本测试决定，
# 当前数值是待验证的初值，不是最终结论。
RENDER_PROFILES: dict[str, int] = {
    "thumb": 40,   # 缩略图
    "view": 150,   # 审校显示用的中等分辨率
    "zoom": 300,   # 放大查看
}

DEFAULT_PROFILE = "view"

# 单页渲染的像素上限，防止超大页面把内存吃光。
MAX_RENDER_PIXELS = 40_000_000

_POINTS_PER_INCH = 72.0


class PdfError(Exception):
    """PDF 无法打开、页码越界或渲染失败。"""


@dataclass(frozen=True)
class PdfInfo:
    page_count: int
    page_width_pt: float
    page_height_pt: float


def _open(path: Path) -> pdfium.PdfDocument:
    try:
        return pdfium.PdfDocument(str(path))
    except Exception as exc:  # pypdfium2 抛出多种底层异常，统一成 PdfError
        raise PdfError(f"无法打开 PDF：{exc}") from exc


def info(path: Path) -> PdfInfo:
    """页数与首页尺寸（pt）。首页尺寸仅作展示，各页尺寸可能不同。"""
    document = _open(path)
    try:
        count = len(document)
        if count == 0:
            raise PdfError("PDF 没有任何页面")
        width, height = document.get_page_size(0)
        return PdfInfo(page_count=count, page_width_pt=width, page_height_pt=height)
    finally:
        document.close()


def page_labels(path: Path) -> list[str]:
    """读取每页的页码标签。

    说明书 Phase 0 第 3 项把「页码标签读取」列为 PDF 库对比项之一，
    此处先提供能力，实际对比结论写在 docs/technical-feasibility.md。
    """
    document = _open(path)
    try:
        return [document.get_page_label(index) for index in range(len(document))]
    finally:
        document.close()


def render_page_png(path: Path, page_index: int, *, profile: str = DEFAULT_PROFILE) -> bytes:
    """把某一页渲染成 PNG 字节。``page_index`` 从 0 开始。"""
    if profile not in RENDER_PROFILES:
        raise PdfError(
            f"未知的渲染档位 {profile!r}，可选：{', '.join(sorted(RENDER_PROFILES))}"
        )

    document = _open(path)
    try:
        total = len(document)
        if not 0 <= page_index < total:
            raise PdfError(f"页码越界：请求第 {page_index} 页，共 {total} 页")

        page = document[page_index]
        try:
            dpi = RENDER_PROFILES[profile]
            scale = dpi / _POINTS_PER_INCH

            width_pt, height_pt = page.get_size()
            estimated = (width_pt * scale) * (height_pt * scale)
            if estimated > MAX_RENDER_PIXELS:
                raise PdfError(
                    f"页面渲染尺寸过大（约 {estimated / 1e6:.0f} 百万像素，"
                    f"上限 {MAX_RENDER_PIXELS / 1e6:.0f} 百万）"
                )

            bitmap = page.render(scale=scale)
            try:
                image = bitmap.to_pil()
                try:
                    buffer = BytesIO()
                    image.save(buffer, format="PNG")
                    return buffer.getvalue()
                finally:
                    image.close()
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        document.close()


def backend_version() -> str:
    """当前 PDF 后端的版本，用于引擎自检接口。"""
    try:
        from importlib.metadata import version

        return version("pypdfium2")
    except Exception:  # pragma: no cover - 元数据缺失时不影响主流程
        return "unknown"
