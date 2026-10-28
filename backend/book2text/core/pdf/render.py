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

import functools
import threading

import pypdfium2 as pdfium
from PIL import Image

# **pdfium 不是线程安全的**（2026-10-14 在真机上撞到：接口层用线程池渲染缩略图，
# 并发时 `document[i]` 抛 "Failed to load page."、`import_pages` 抛
# "Failed to import pages."，任务包生成也就跟着失败）。碰 pdfium 的公开函数
# 统统串行化在这一把锁上：渲染本来就是 CPU 密集，加锁的代价可以忽略。
#
# 锁是**进程内**的；识别子进程是单线程，不受影响。
_PDFIUM_LOCK = threading.RLock()


def _serialized(func):
    """把整个函数体放进 pdfium 互斥区（见 `_PDFIUM_LOCK` 的说明）。"""

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        with _PDFIUM_LOCK:
            return func(*args, **kwargs)

    return wrapper

# 渲染档位 → 目标 DPI。说明书 8.2 注明默认值由 Phase 0 样本测试决定，
# 当前数值是待验证的初值，不是最终结论。
RENDER_PROFILES: dict[str, int] = {
    "thumb": 40,   # 缩略图
    "view": 150,   # 标准（原"中等分辨率"）
    # 任务 72：150 不够、300 太大（一页 650 KB）是最常见的情况。
    # 612pt 的页面在 220 DPI 下约 1870px、200–300 KB，正好覆盖"容器 700–900 CSS px
    # × dpr 2"这一档——用户报糊的正是这一档。
    "mid": 220,
    "zoom": 300,   # 放大查看 / 高清
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


@_serialized
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


@_serialized
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


@_serialized
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


@_serialized
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


#: 编码格式：`view` / `zoom` 用 JPEG（扫描页的灰度噪点让 PNG 大一个数量级）。
#: 2026-10-28 实测（447pt 宽页面，第 36 页）：view@150DPI 的 PNG 1.77 MB → JPEG(q=82) 0.42 MB；
#: zoom@300DPI 的 PNG 约 7 MB → JPEG 1.3 MB。缩略图仍用 PNG（小图，边缘干净）。
ENCODE_FORMAT = {"thumb": "PNG", "view": "JPEG", "zoom": "JPEG"}
JPEG_QUALITY = 82


@_serialized
def render_page_png(path: Path, page_index: int, *, profile: str = DEFAULT_PROFILE) -> bytes:
    """把某一页渲染成 **PNG** 字节。``page_index`` 从 0 开始。

    比 `render_page_encoded` 大一个数量级（扫描页），接口层不要用它传大图；
    留着是为了"要无损 PNG"的调用方与测试。
    """
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


@_serialized
def render_page_encoded(
    path: Path, page_index: int, *, profile: str = DEFAULT_PROFILE
) -> tuple[str, bytes]:
    """渲染一页并编码，返回 `(content_type, bytes)`。

    `view` / `zoom` 用 JPEG q=82（体积降一个数量级，肉眼几乎无差），`thumb` 用 PNG。
    调用方按返回的 content_type 设置响应头即可。
    """
    if profile not in RENDER_PROFILES:
        raise PdfError(
            f"未知的渲染档位 {profile!r}，可选：{', '.join(sorted(RENDER_PROFILES))}"
        )
    image = render_page_image(path, page_index, dpi=RENDER_PROFILES[profile])
    try:
        buffer = BytesIO()
        if ENCODE_FORMAT.get(profile, "PNG") == "JPEG":
            image.convert("RGB").save(
                buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True
            )
            return "image/jpeg", buffer.getvalue()
        image.save(buffer, format="PNG")
        return "image/png", buffer.getvalue()
    finally:
        image.close()


@_serialized
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


@_serialized
def page_rotations(path: Path) -> list[int]:
    """所有页的 ``/Rotate`` 声明值（度），一次读完。"""
    document = _open(path)
    try:
        return [int(document[index].get_rotation()) % 360 for index in range(len(document))]
    finally:
        document.close()


@_serialized
def page_text_chars(
    path: Path, page_index: int
) -> list[tuple[str, tuple[float, float, float, float], list[tuple[str, tuple[float, float, float, float]]]]] | None:
    """文字层的行 + **行内逐字框**（任务 59 的字框来源）。

    返回 ``[(行文本, 行框, [(字, 字框), ...]), ...]``；没有文字层 / 页面旋转不是 0 时
    返回 None。字框与行框同口径（归一化、原点左上）。
    """
    document = _open(path)
    try:
        page = _guarded_page(document, page_index)
        try:
            if int(page.get_rotation()) % 360 != 0:
                return None
            width, height = (float(value) for value in page.get_size())
            if width <= 0 or height <= 0:
                return None
            textpage = page.get_textpage()
            try:
                count = int(textpage.count_chars())
                if count <= 0:
                    return None
                lines = []
                chars: list[str] = []
                boxes: list[tuple[float, float, float, float]] = []
                left = bottom = right = top = None

                def flush() -> None:
                    nonlocal chars, boxes, left, bottom, right, top
                    if "".join(chars).strip() and left is not None:
                        line_box = (
                            left / width,
                            1 - top / height,
                            right / width,
                            1 - bottom / height,
                        )
                        lines.append(
                            ("".join(chars), line_box, list(zip(chars, boxes)))
                        )
                    chars = []
                    boxes = []
                    left = bottom = right = top = None

                for index in range(count):
                    char = textpage.get_text_range(index, 1)
                    if char in ("\r", "\n"):
                        flush()
                        continue
                    try:
                        c_left, c_bottom, c_right, c_top = textpage.get_charbox(index)
                    except Exception:  # noqa: BLE001
                        continue
                    chars.append(char)
                    boxes.append(
                        (
                            c_left / width,
                            1 - c_top / height,
                            c_right / width,
                            1 - c_bottom / height,
                        )
                    )
                    left = c_left if left is None else min(left, c_left)
                    right = c_right if right is None else max(right, c_right)
                    bottom = c_bottom if bottom is None else min(bottom, c_bottom)
                    top = c_top if top is None else max(top, c_top)
                flush()
                return lines or None
            finally:
                textpage.close()
        finally:
            page.close()
    finally:
        document.close()


@_serialized
def page_text_lines(
    path: Path, page_index: int
) -> list[tuple[str, tuple[float, float, float, float]]] | None:
    """这一页文字层的**行**（文本 + 归一化 bbox），没有可用文字层时返回 None。

    为什么用它：可搜索 PDF 的文字层本身就是某一版 OCR 的产物（这本书的文字层就是
    Apple Vision 做的）。用它当第二引擎，不用再花几十分钟跑一遍同样的模型。

    行怎么来：pypdfium2 的文字层按字符给框，文本里带换行；这里**按换行切行**，
    行框取这一行所有字符框的外接矩形。页面 ``/Rotate`` 不是 0 时返回 None——
    文字层坐标与"渲染后图像"的坐标不一致，宁可不猜。

    归一化口径与应用其它地方一致：原点左上，取 (x0, y0, x1, y1)，0–1。
    """
    document = _open(path)
    try:
        page = _guarded_page(document, page_index)
        try:
            if int(page.get_rotation()) % 360 != 0:
                return None
            width, height = (float(value) for value in page.get_size())
            if width <= 0 or height <= 0:
                return None
            textpage = page.get_textpage()
            try:
                count = int(textpage.count_chars())
                if count <= 0:
                    return None
                lines: list[tuple[str, tuple[float, float, float, float]]] = []
                chars: list[str] = []
                left = bottom = right = top = None
                for index in range(count):
                    char = textpage.get_text_range(index, 1)
                    if char in ("\r", "\n"):
                        if "".join(chars).strip() and left is not None:
                            lines.append(
                                (
                                    "".join(chars),
                                    (
                                        left / width,
                                        1 - top / height,
                                        right / width,
                                        1 - bottom / height,
                                    ),
                                )
                            )
                        chars = []
                        left = bottom = right = top = None
                        continue
                    try:
                        c_left, c_bottom, c_right, c_top = textpage.get_charbox(index)
                    except Exception:  # noqa: BLE001 - 个别字符没有框，跳过它不影响整行
                        continue
                    chars.append(char)
                    left = c_left if left is None else min(left, c_left)
                    right = c_right if right is None else max(right, c_right)
                    bottom = c_bottom if bottom is None else min(bottom, c_bottom)
                    top = c_top if top is None else max(top, c_top)
                if "".join(chars).strip() and left is not None:
                    lines.append(
                        (
                            "".join(chars),
                            (
                                left / width,
                                1 - top / height,
                                right / width,
                                1 - bottom / height,
                            ),
                        )
                    )
                return lines or None
            finally:
                textpage.close()
        finally:
            page.close()
    finally:
        document.close()


@_serialized
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


@_serialized
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


@_serialized
def extract_subset(source: Path, page_indexes: list[int], destination: Path) -> int:
    """把若干页抽成一个新的 PDF（说明书 6.7.2 的任务包子集）。

    返回实际抽出的页数。**顺序按传入的 `page_indexes` 来**——任务包里
    "上下文页夹在前后"的顺序由调用方决定，这里不做重排。
    """
    if not page_indexes:
        raise PdfError("要抽取的页面是空的")
    document = _open(source)
    subset = pdfium.PdfDocument.new()
    try:
        valid = [index for index in page_indexes if 0 <= index < len(document)]
        if not valid:
            raise PdfError("要抽取的页面都不在这份 PDF 里")
        subset.import_pages(document, valid)
        destination.parent.mkdir(parents=True, exist_ok=True)
        subset.save(str(destination))
        return len(valid)
    except PdfError:
        raise
    except Exception as exc:  # pragma: no cover - 底层库异常统一成 PdfError
        raise PdfError(f"抽取页面失败：{exc}") from exc
    finally:
        subset.close()
        document.close()


def backend_version() -> str:
    """当前 PDF 后端的版本，用于引擎自检接口。"""
    try:
        from importlib.metadata import version

        return version("pypdfium2")
    except Exception:  # pragma: no cover - 元数据缺失时不影响主流程
        return "unknown"
