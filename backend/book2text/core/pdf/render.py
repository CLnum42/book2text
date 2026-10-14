"""PDF 打开与页面渲染。

**选型未定。** 说明书 Phase 0 第 3 项要求对比 ``pypdfium2`` 与 ``PyMuPDF``
（渲染效果、页码标签读取、文本层检测、许可证）。本模块暂用 ``pypdfium2``
（许可证较宽松；``PyMuPDF`` 为 AGPL，见说明书 4.2），等 Phase 0 实测后再定，
因此这里有意把 pypdfium2 的调用收在一个模块里，换库时只改这一处。

**关于 /Rotate（2026-10-14 实测结论）：**

PDFium **已经按页面 ``/Rotate`` 正确处理了尺寸与渲染**——``get_size()`` 返回的是
"显示尺寸"（``/Rotate`` 为 90/270 时宽高已交换），``render()`` 默认参数渲染出的
就是显示方向。因此**不要**再给 ``render()`` 传 ``rotation``，那会重复旋转。

实测过程中踩到的两个坑，记录在此以免重犯：

1. **reportlab 的 ``setPageRotation()`` 生成的文件是坏的**：PDFium 与 macOS PDFKit
   都渲染不出任何内容（实测墨迹像素为 0）。制作旋转页夹具不要用它。
2. 正确做法见 `scripts/make_test_fixtures.py`：把横向内容旋转后放进竖向页面，
   再写 ``/Rotate``——这正是真实扫描书的存储方式。
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image

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


def _guarded_page(document: pdfium.PdfDocument, page_index: int):
    total = len(document)
    if not 0 <= page_index < total:
        raise PdfError(f"页码越界：请求第 {page_index} 页，共 {total} 页")
    return document[page_index]


def info(path: Path) -> PdfInfo:
    """页数与首页的**显示尺寸**（pt）。

    显示尺寸 = ``/Rotate`` 已应用之后的尺寸（90/270 度时宽高已交换），
    与渲染出的图像成比例。说明书 5.2 的归一化坐标正是相对这个方向。
    """
    document = _open(path)
    try:
        count = len(document)
        if count == 0:
            raise PdfError("PDF 没有任何页面")
        page = _guarded_page(document, 0)
        try:
            width, height = page.get_size()
        finally:
            page.close()
        return PdfInfo(page_count=count, page_width_pt=width, page_height_pt=height)
    finally:
        document.close()


def page_rotation(path: Path, page_index: int) -> int:
    """页面的 ``/Rotate`` 声明值（度）。

    **仅供记录**——对应说明书 5.3 的 ``Page.rotation`` 字段。
    渲染时**不要**再把它传给 ``render()``：PDFium 已经应用过它了。
    """
    document = _open(path)
    try:
        page = _guarded_page(document, page_index)
        try:
            return int(page.get_rotation()) % 360
        finally:
            page.close()
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


def render_page_image(
    path: Path,
    page_index: int,
    *,
    dpi: int = 300,
    max_pixels: int = MAX_RENDER_PIXELS,
) -> Image.Image:
    """把某一页渲染成 PIL 图像（RGB）。

    **界面显示与 OCR 都必须经过这个函数**：两者用同一条路径产出图像，
    归一化坐标才能和用户看到的画面对齐（说明书 5.2）。

    返回的图像即"显示方向"，其宽高与 ``info()`` 报告的显示尺寸成比例，
    因此 OCR 得到的像素坐标除以本图像的宽高即得归一化坐标。
    """
    document = _open(path)
    try:
        page = _guarded_page(document, page_index)
        try:
            scale = dpi / _POINTS_PER_INCH
            width_pt, height_pt = page.get_size()  # 已是显示尺寸
            estimated = (width_pt * scale) * (height_pt * scale)
            if estimated > max_pixels:
                raise PdfError(
                    f"页面渲染尺寸过大（约 {estimated / 1e6:.0f} 百万像素，"
                    f"上限 {max_pixels / 1e6:.0f} 百万）"
                )
            bitmap = page.render(scale=scale)
            try:
                return bitmap.to_pil().convert("RGB")
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        document.close()


def render_page_png(path: Path, page_index: int, *, profile: str = DEFAULT_PROFILE) -> bytes:
    """把某一页渲染成 PNG 字节。``page_index`` 从 0 开始。"""
    if profile not in RENDER_PROFILES:
        raise PdfError(
            f"未知的渲染档位 {profile!r}，可选：{', '.join(sorted(RENDER_PROFILES))}"
        )
    image = render_page_image(path, page_index, dpi=RENDER_PROFILES[profile])
    try:
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()
    finally:
        image.close()


def page_sizes_pt(path: Path) -> list[tuple[float, float]]:
    """所有页的**显示尺寸**（pt）。打开一次文档读完，避免逐页开关文件。"""
    document = _open(path)
    try:
        sizes = []
        for index in range(len(document)):
            page = document[index]
            try:
                sizes.append(page.get_size())
            finally:
                page.close()
        return sizes
    finally:
        document.close()


def page_rotations(path: Path) -> list[int]:
    """所有页的 ``/Rotate`` 声明值（度），一次读完。"""
    document = _open(path)
    try:
        return [int(document[index].get_rotation()) % 360 for index in range(len(document))]
    finally:
        document.close()


def text_layer_char_count(path: Path, page_index: int) -> int:
    """该页文本层里的字符数。

    说明书 6.1 要求新建项目时"检测文本层"，并在**大部分页面已有文本层**时提示
    "这本 PDF 可能已包含文本"。扫描版图书的这里应接近 0。
    """
    document = _open(path)
    try:
        page = _guarded_page(document, page_index)
        try:
            return int(page.get_textpage().count_chars())
        finally:
            page.close()
    finally:
        document.close()


def text_layer_char_counts(path: Path) -> list[int]:
    """逐页文本层字符数。只读文本层、不渲染，因此比渲染快得多。"""
    document = _open(path)
    try:
        counts = []
        for index in range(len(document)):
            page = document[index]
            try:
                counts.append(int(page.get_textpage().count_chars()))
            finally:
                page.close()
        return counts
    finally:
        document.close()


def backend_version() -> str:
    """当前 PDF 后端的版本，用于引擎自检接口。"""
    try:
        from importlib.metadata import version

        return version("pypdfium2")
    except Exception:  # pragma: no cover - 元数据缺失时不影响主流程
        return "unknown"
