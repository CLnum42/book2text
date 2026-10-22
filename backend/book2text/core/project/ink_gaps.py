"""可疑漏行检测：**有墨迹、但没有任何行框覆盖**的横向条带（只读）。

用户截图里的问题是"检测阶段漏了一行"：那行文字在页面上，但没有对应的 `block_line`。
现在的补救是「✚ 框选新增块」，但它要用户手打文字——先得知道"哪里可能漏了"。

做法（全部在内存里，不写库）：

1. 用 **view 档（150 DPI）** 渲染这一页（与审校显示的档位一致），转灰度；
2. 用 Otsu 阈值二值化，得到"墨迹掩码"；
3. 把**块内行框**与**插图 / 装饰块**的框画成"覆盖掩码"；
4. 墨迹减去覆盖 = "没有被任何行框认领的墨迹"；逐行求它占页宽的比例；
5. 连续超阈值的行组成条带，再按下面的规则筛掉噪声。

**宁可少报。** 阈值是按真书调的（第 3 页 24 个密集块、第 30 页正文页零误报），
误报会变成噪声，比漏报更烦人。所有常量都在这里，调的时候只动这一处。
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

from ..pdf import render
from . import blocks as blocks_module
from . import library as project_library

# 渲染档位：与审校显示一致（150 DPI）。检测只关心"有没有墨迹"，不需要 300 DPI。
DETECT_DPI = 150
# 页面最外侧这个比例内的条带一律不报（扫描仪边缘、裁切黑边）
OUTER_MARGIN = 0.03
# 一行里"未被行框覆盖的墨迹"至少占页宽的这个比例，才算可疑
ROW_INK_RATIO = 0.01
# 条带高度：一行正文大约占页高的 2%–4%；太薄是笔画边缘，太高多半是图
MIN_BAND_HEIGHT = 0.012
MAX_BAND_HEIGHT = 0.06
# 条带与已有行框的竖直重叠超过这个比例，就认为"这行其实有框"（行框画得比字紧）
LINE_OVERLAP_LIMIT = 0.4
# 整页墨迹占比超过这个值时不做检测（背景太暗，二值化不可靠）
MAX_PAGE_INK = 0.45
# 一眼能报的条带上限：多了就不是"漏了一行"，而是这页本来就没识别好
MAX_CANDIDATES = 6
# 条带宽度至少占页宽的这个比例（孤立的几个墨点是噪声）
MIN_BAND_WIDTH = 0.08
# 宽高比：一行文字是"扁"的。表格边框 / 竖排侧栏是"高"的，靠这条挡掉
MIN_BAND_ASPECT = 3.0


def _otsu_threshold(histogram: list[int], total: int) -> int:
    """灰度直方图上的 Otsu 阈值（前景 = 比阈值暗的像素）。"""
    if total <= 0:
        return 160
    total_sum = sum(index * count for index, count in enumerate(histogram))
    weight_back = 0
    sum_back = 0
    best = 160
    best_variance = -1.0
    for index, count in enumerate(histogram):
        weight_back += count
        if weight_back == 0:
            continue
        weight_front = total - weight_back
        if weight_front == 0:
            break
        sum_back += index * count
        mean_back = sum_back / weight_back
        mean_front = (total_sum - sum_back) / weight_front
        variance = weight_back * weight_front * (mean_back - mean_front) ** 2
        if variance > best_variance:
            best_variance = variance
            best = index
    return best


def _merge_intervals(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """把竖直区间合并（求"被行框覆盖的高度"时不能重复计数）。"""
    if not intervals:
        return []
    ordered = sorted(intervals)
    merged = [list(ordered[0])]
    for start, end in ordered[1:]:
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def _covered_height(band, intervals) -> float:
    """条带被这些竖直区间覆盖的高度（并集）。"""
    start, end = band
    total = 0.0
    for left, right in _merge_intervals(intervals):
        overlap = min(end, right) - max(start, left)
        if overlap > 0:
            total += overlap
    return total


def find_ink_gaps(
    project_id: str,
    page_no: int,
    *,
    library: Path | None = None,
    dpi: int = DETECT_DPI,
) -> dict:
    """返回这一页"可疑漏行"的条带（只读，不写库、不改任何记录）。

    `candidates` 里每项：`bbox`（归一化，页面坐标）、`ink_ratio`（条带里未被覆盖的
    墨迹占页宽的比例）、`height_ratio`（条带高度占页高的比例）。
    """
    target_library = library if library is not None else project_library.default_library_dir()
    project = project_library.load_project(project_id, library=target_library)
    if project.directory is None:  # pragma: no cover - 装配错误
        raise project_library.ProjectError("项目缺少目录信息")
    page = next(
        (item for item in project_library.list_pages(project_id, library=target_library)
         if item.page_no == page_no),
        None,
    )
    if page is None:
        raise project_library.ProjectError(f"没有第 {page_no} 页")

    page_blocks, lines = _page_geometry(project_id, page_no, library=target_library)
    if not lines:
        return _empty("这一页没有行记录（还没识别，或本来就没有文字）")

    source = project.directory / project_library.SOURCE_DIR_NAME / project_library.SOURCE_FILE_NAME
    index = page.pdf_page_index if page.pdf_page_index is not None else page_no - 1
    try:
        image = render.render_page_image(source, index, dpi=dpi)
    except render.PdfError as exc:
        raise project_library.ProjectError(f"这一页渲染失败：{exc}") from exc

    try:
        return _detect(image, page_blocks, lines)
    finally:
        image.close()


def _empty(note: str) -> dict:
    return {"candidates": [], "note": note, "rendered_dpi": DETECT_DPI}


def _page_geometry(project_id: str, page_no: int, *, library: Path):
    """这一页的有效块与行（与审校视图看到的同一份数据）。"""
    _page, _runs, page_blocks, lines = blocks_module.load_page_content(
        project_id, page_no, library=library
    )
    active = {block.block_id for block in page_blocks}
    return page_blocks, [line for line in lines if line.block_id in active and line.bbox]


def _detect(image: Image.Image, page_blocks, lines) -> dict:
    width, height = image.size
    gray = image.convert("L")
    histogram = gray.histogram()
    threshold = _otsu_threshold(histogram, width * height)
    # 墨迹 = 比 Otsu 阈值暗的像素
    ink = gray.point(lambda value: 255 if value <= threshold else 0, mode="L")
    ink_pixels = ink.histogram()[255]
    if ink_pixels / (width * height) > MAX_PAGE_INK:
        return _empty("整页偏暗（背景/扫描噪声太多），不做漏行检测")

    coverage = Image.new("L", (width, height), 0)
    drawer = ImageDraw.Draw(coverage)
    for line in lines:
        _fill_rect(drawer, line.bbox, width, height)
    # 这些块盖住的区域不算漏行：
    # - 插图 / 装饰块本身不是文字；
    # - **没有行记录的块**是人工新增 / 拆分出来的（人已经给它建了块），再报就是噪声。
    covered_types = {"figure", "decoration"}
    blocks_with_lines = {line.block_id for line in lines}
    covered_blocks = [
        block
        for block in page_blocks
        if block.bbox is not None
        and (block.block_type in covered_types or block.block_id not in blocks_with_lines)
    ]
    for block in covered_blocks:
        _fill_rect(drawer, block.bbox, width, height)

    uncovered = ImageChops.subtract(ink, coverage)
    # 逐行求"未被覆盖的墨迹"占页宽的比例：缩到 1 像素宽取平均（全在 C 里做）
    profile_image = uncovered.resize((1, height), Image.BOX)
    profile = [value / 255 for value in profile_image.tobytes()]
    profile_image.close()

    bands = _bands(profile, height)
    # 已有行框的竖直区间：给"行框画得比字紧"兜底
    line_intervals = [(line.bbox[1], line.bbox[3]) for line in lines]
    figure_intervals = [(block.bbox[1], block.bbox[3]) for block in covered_blocks]

    candidates: list[dict[str, object]] = []
    for top, bottom in bands:
        band = (top, bottom)
        height_ratio = bottom - top
        if height_ratio < MIN_BAND_HEIGHT or height_ratio > MAX_BAND_HEIGHT:
            continue
        # 最外侧 3%：扫描仪边缘、裁切黑边
        if top < OUTER_MARGIN or bottom > 1 - OUTER_MARGIN:
            continue
        # 这一行其实有框（框比字紧）：条带的大部分落在某个行框的竖直范围里
        if height_ratio > 0 and _covered_height(band, line_intervals) / height_ratio >= LINE_OVERLAP_LIMIT:
            continue
        # 落在插图 / 装饰块里
        if height_ratio > 0 and _covered_height(band, figure_intervals) / height_ratio >= LINE_OVERLAP_LIMIT:
            continue

        top_px = max(0, int(top * height))
        bottom_px = min(height, int(bottom * height) + 1)
        slice_image = uncovered.crop((0, top_px, width, bottom_px))
        ink_box = slice_image.getbbox()
        slice_image.close()
        if ink_box is None:
            continue
        x0, y0, x1, y1 = ink_box
        width_ratio = (x1 - x0) / width
        if width_ratio < MIN_BAND_WIDTH:
            continue
        # 表格边框 / 竖排文字是"高"的：一行文字至少是"宽高比 3 倍"的扁条
        if height_ratio > 0 and width_ratio / height_ratio < MIN_BAND_ASPECT:
            continue
        ink_ratio = sum(profile[top_px:bottom_px]) / max(1, bottom_px - top_px)
        if ink_ratio < ROW_INK_RATIO:
            continue
        candidates.append(
            {
                "bbox": [
                    round(x0 / width, 6),
                    round((top_px + y0) / height, 6),
                    round(x1 / width, 6),
                    round((top_px + y1) / height, 6),
                ],
                "ink_ratio": round(ink_ratio, 4),
                "height_ratio": round((y1 - y0) / height, 4),
            }
        )
        if len(candidates) >= MAX_CANDIDATES:
            break
    return {
        "candidates": candidates,
        "note": None if candidates else "没有发现疑似漏行",
        "rendered_dpi": DETECT_DPI,
    }


def _fill_rect(drawer: ImageDraw.ImageDraw, bbox, width: int, height: int) -> None:
    x0 = max(0, min(width - 1, int(bbox[0] * width)))
    y0 = max(0, min(height - 1, int(bbox[1] * height)))
    x1 = max(0, min(width - 1, int(bbox[2] * width)))
    y1 = max(0, min(height - 1, int(bbox[3] * height)))
    if x1 < x0 or y1 < y0:  # pragma: no cover - 退化框
        return
    drawer.rectangle((x0, y0, x1, y1), fill=255)


def _bands(profile: list[float], height: int) -> list[tuple[float, float]]:
    """连续的"有未覆盖墨迹"的行 → 归一化条带（上下边界）。"""
    bands: list[tuple[float, float]] = []
    start = None
    for index, value in enumerate(profile):
        if value >= ROW_INK_RATIO:
            if start is None:
                start = index
        elif start is not None:
            bands.append((start / height, index / height))
            start = None
    if start is not None:
        bands.append((start / height, 1.0))
    return bands
