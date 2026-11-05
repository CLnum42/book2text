"""页边重复（书眉 / 页脚 / 页码）的**候选清单**（2026-11-05）。

**不自动排除**：只给候选（带 / 奇偶 / 模板 / 命中页 / 样例行 / 建议类型 / 置信度）；
用户在「页面确认」里看过、勾过，才由 `apply` 改块类型 + `include=0`（可撤销，写 event）。

判据（口径固定，参数可调）：
1. 只对 `page_type=body` 做。有版心的页按"版心之外"判；**没有版心的页（新书第一次识别）
   按页面默认页边带判**（`DEFAULT_BAND_*`），候选上标 `used_default_band`。
2. 四带 = 版心之外（按**行 bbox 中心**判归属）：top `y<margin.y0` · bottom `y>margin.y1` ·
   left `x<margin.x0` · right `x>margin.x2`；每带每页只取最靠边的 1–2 行。
3. 按奇偶分组、组内按页号排序。
4. 三种匹配：完全相同（NFKC + 去空白）/ 数字模板相同（`\\d+`→`{}`）且数字单调、步长恒定（±1）/
   模板相同但数字缺失。
5. 窗口：同组内 ≥5 页命中，允许缺 ≤2 页。
6. 位置稳定：同组内坐标极差 ≤0.02（中位差更小，这里取更严的极差）。
7. 防误判：**下边带**只收纯数字或 ≤4 字符的行（脚注更长）；**目录页不做**（只跑 body）。

2026-11-05 真机（b2t_YR5EJ0）：偶数页顶端标题 21 行完全相同、带页码前缀的 90 行模板一致；
奇数页顶端三种模板各带递增数字（12/12/14 行）。
"""

from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass

from . import blocks as blocks_module
from . import library as library_module

BANDS = ("top", "bottom", "left", "right")
MIN_PAGES = 5
MAX_MISSING_GAP = 2
MAX_MEDIAN_DEVIATION = 0.01
BOTTOM_MAX_CHARS = 4
PER_BAND_LINES = 2

PROPOSED = {"top": "header", "bottom": "footer", "left": "header", "right": "header"}


@dataclass(frozen=True)
class _Item:
    page_no: int
    block_id: str
    line_id: str
    text: str
    center: float
    bbox: tuple[float, float, float, float]
    used_default_band: bool


def _normalize(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text or "").split())


def _template(text: str) -> tuple[str, list[int]]:
    """数字串换成 `{}`，并取出数字序列（用于单调 / 步长判断）。"""
    numbers: list[int] = []
    out: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char.isdecimal():
            end = index
            while end < len(text) and text[end].isdecimal():
                end += 1
            numbers.append(int(text[index:end]))
            out.append("{}")
            index = end
            continue
        out.append(char)
        index += 1
    return "".join(out), numbers


def _center(bbox, band: str) -> float:
    if band == "top":
        return min(bbox[1], bbox[3])
    if band == "bottom":
        return max(bbox[1], bbox[3])
    if band == "left":
        return min(bbox[0], bbox[2])
    return max(bbox[0], bbox[2])


#: 页面**默认页边带**：没有版心的页（新书第一次识别）用它判断页边重复行；
#: 版心把页眉页脚包进去的页也退回它。**只有这一组阈值**——两条路径必须给同一个答案，
#: 否则"先有框再重拟"与"从零开始拟"会对同一页算出不同的版心。
DEFAULT_BAND_TOP = 0.12
DEFAULT_BAND_BOTTOM = 0.88
DEFAULT_BAND_LEFT = 0.08
DEFAULT_BAND_RIGHT = 0.92
#: 默认带比"版心之外"弱（可能吃到正文边缘）：置信度按这个比例降一档。
DEFAULT_BAND_CONFIDENCE = 0.8


def _band_of(bbox, margin) -> tuple[str, bool] | None:
    """行属于哪条页边带：**版心之外优先**，够不着再按页面默认页边带判。

    为什么需要默认带：真机 b2t_YR5EJ0 有大量页的自动版心把顶边书眉包进了框内
    （margin y0 低到 0.066，书眉中心 0.075），只按版心判会漏掉这些页 ⇒ 候选凑不齐；
    新书第一次识别更是**一页版心都没有**（2026-11-05：第一次拟出来仍然会包住书眉，
    用户得点第二次才对）。默认带只认页面最外侧的窄带，正文块在页面中部，位置口径仍然成立。
    """
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    if margin is not None:
        if cy < margin[1]:
            return "top", False
        if cy > margin[3]:
            return "bottom", False
        if cx < margin[0]:
            return "left", False
        if cx > margin[2]:
            return "right", False
    # 没有版心（新书第一次识别）或版心把页边包进来了：按页面默认页边带判
    if cy < DEFAULT_BAND_TOP:
        return "top", True
    if cy > DEFAULT_BAND_BOTTOM:
        return "bottom", True
    if cx < DEFAULT_BAND_LEFT:
        return "left", True
    if cx > DEFAULT_BAND_RIGHT:
        return "right", True
    return None


def _max_gap(pages: list[int]) -> int:
    if len(pages) < 2:
        return 0
    return max(b - a - 1 for a, b in zip(pages, pages[1:]))


def _gaps(pages: list[int]) -> int:
    if len(pages) < 2:
        return 0
    return sum(max(0, b - a - 1) for a, b in zip(pages, pages[1:]))


def _runs(items: list[_Item], gap_limit: int = MAX_MISSING_GAP) -> list[list[_Item]]:
    """按"允许缺 ≤gap_limit 页"把同一模板的命中切成连续段。"""
    runs: list[list[_Item]] = []
    current: list[_Item] = []
    previous_page = None
    for item in items:
        if previous_page is not None and item.page_no - previous_page - 1 > gap_limit:
            runs.append(current)
            current = []
        current.append(item)
        previous_page = item.page_no
    if current:
        runs.append(current)
    return runs


def _confidence(pages_hit: list[int]) -> float:
    """命中率：同组内按常见步长（奇偶页通常是 2）应有几页，实际命中几页。"""
    if len(pages_hit) < 2:
        return 1.0
    steps = sorted(b - a for a, b in zip(pages_hit, pages_hit[1:]))
    step = max(1, steps[len(steps) // 2])
    expected = (pages_hit[-1] - pages_hit[0]) // step + 1
    return round(min(1.0, len(pages_hit) / max(1, expected)), 3)


def _median_abs_deviation(values: list[float], median: float) -> float:
    """位置稳定：到中位数的绝对偏差的中位数（口径 ⑥，比极差稳）。"""
    deviations = sorted(abs(value - median) for value in values)
    return deviations[len(deviations) // 2]


def _monotonic(numbers: list[int]) -> bool:
    """单调不减；相邻差若都相同（±1 容差）通过；否则只要求单调。"""
    if len(numbers) < 3:
        return True
    if any(b < a for a, b in zip(numbers, numbers[1:])):
        return False
    diffs = [b - a for a, b in zip(numbers, numbers[1:])]
    return max(diffs) - min(diffs) <= 1


def collect(project_id: str, *, library=None) -> list[dict]:
    """现算候选清单（**只读、不落库**）。

    返回 `[{id, band, parity, template, pages, count, lines, block_ids,
    sample_text, suggested_type, confidence, used_default_band}]`；带 / 奇偶 / 模板 / 命中页
    都在里面。`used_default_band=True` 表示这条候选至少有一页是按**页面默认页边带**判的
    （新书还没有版心 / 版心把页眉包了进去），置信度已相应降一档。

    页边来源：有版心的页优先按"版心之外"判；没版心或版心把它包进来时退回
    `DEFAULT_BAND_*`（同一组阈值，两条路径必须给同一个答案）。

    内部版本 `_collect_detailed` 还会带一份 `_items`（命中的行框），
    给 `page_exclusions()` 生成"拟合前剔掉"的矩形用；对外这一份不暴露。
    """
    return [
        {key: value for key, value in candidate.items() if not key.startswith("_")}
        for candidate in _collect_detailed(project_id, library=library)
    ]


def _collect_detailed(project_id: str, *, library=None) -> list[dict]:
    """`collect` 的内部版本：候选 dict 里多一个 `_items`（命中的行框）。"""
    pages = [p for p in library_module.list_pages(project_id, library=library) if p.page_type == "body"]
    # 2026-11-05：**没有版心的页也参与**（新书第一次「全局识别」就靠默认页边带剔页眉）。
    page_by_no = {page.page_no: page for page in pages}
    wanted = set(page_by_no)
    block_by_id = {block.block_id: block for block in blocks_module.list_blocks(project_id, library=library)}
    # 行 → (带, 奇偶)
    groups: dict[tuple[str, str], list[_Item]] = {}
    for line in blocks_module.list_block_lines(project_id, library=library):
        block = block_by_id.get(line.block_id)
        if block is None or block.page_no not in wanted or not line.bbox:
            continue
        page = page_by_no[block.page_no]
        margin = (
            tuple(float(value) for value in page.margin_box)
            if page.margin_box
            else None
        )
        bbox = tuple(float(value) for value in line.bbox)
        resolved = _band_of(bbox, margin)
        if resolved is None:
            continue
        band, used_default_band = resolved
        text = _normalize(line.text)
        if not text:
            continue
        # 脚注防误判：下边带只收纯数字或 ≤4 字符
        if band == "bottom" and not (text.isdecimal() or len(text) <= BOTTOM_MAX_CHARS):
            continue
        parity = "even" if page.page_no % 2 == 0 else "odd"
        groups.setdefault((band, parity), []).append(
            _Item(
                block.page_no,
                block.block_id,
                line.line_id,
                text,
                _center(bbox, band),
                (bbox[0], bbox[1], bbox[2], bbox[3]),
                used_default_band,
            )
        )

    candidates: list[dict] = []
    for (band, parity), items in groups.items():
        per_page: dict[int, list[_Item]] = {}
        for item in items:
            per_page.setdefault(item.page_no, []).append(item)
        chosen: list[_Item] = []
        for page_items in per_page.values():
            page_items.sort(key=lambda it: it.center, reverse=band in ("bottom", "right"))
            chosen.extend(page_items[:PER_BAND_LINES])
        by_template: dict[str, list[_Item]] = {}
        for item in chosen:
            template, _ = _template(item.text)
            # 页眉的页码前缀在有些页被 OCR 并进来、有些页没有（`{}标题` vs `标题`）：
            # 归到同一个模板，否则同一行书眉会被拆成两组、两边都不够窗口。
            canonical = template[2:] if template.startswith("{}") and len(template) > 2 else template
            by_template.setdefault(canonical, []).append(item)
        if band in ("left", "right"):
            # 竖排书眉的 OCR 噪声大（红楼梦/0 / 红楼梦600 / 红楼梦画 都是同一块书眉）：
            # 左右带再按**首三字**粗归并一次，避免每页一个模板、候选全被拆碎。
            for item in chosen:
                prefix = item.text[:3]
                if len(prefix) == 3:
                    by_template.setdefault(f"{prefix}*", []).append(item)
        for template, group in by_template.items():
            group.sort(key=lambda it: it.page_no)
            # 窗口：按"允许缺 ≤2 页"切成连续段，每段单独出候选（识别失败的页不该打断整段，
            # 但也不能让一条模板跨整本书把无关的页并进来）。
            gap_limit = 4 if (band in ("left", "right") and template.endswith("*")) else MAX_MISSING_GAP
            for run in _runs(group, gap_limit):
                pages_hit = sorted({item.page_no for item in run})
                if len(pages_hit) < MIN_PAGES:
                    continue
                centers = [item.center for item in run]
                median = sorted(centers)[len(centers) // 2]
                if _median_abs_deviation(centers, median) > MAX_MEDIAN_DEVIATION:
                    continue
                numbers = [number for item in run for number in _template(item.text)[1]]
                # 数字递增判据只对**纯数字模板**成立：粗归并组（`红楼梦*`）与
                # "页眉前缀时有时无"的混合组（同一模板由 {}标题 与 标题 合并而来）里，
                # 数字是 OCR 噪声/页号混排，不能拿它判递增。
                mixed = len({_template(item.text)[0] for item in run}) > 1
                if not mixed and not template.endswith("*") and numbers and not _monotonic(numbers):
                    continue
                texts = {item.text for item in run}
                proposed = PROPOSED[band]
                if band == "bottom" and all(text.isdecimal() for text in texts):
                    proposed = "page_number"
                used_default_band = any(item.used_default_band for item in run)
                confidence = _confidence(pages_hit)
                if used_default_band:
                    # 默认页边带比"版心之外"弱（可能吃到正文边缘）：置信度降一档
                    confidence = round(confidence * DEFAULT_BAND_CONFIDENCE, 3)
                candidates.append(
                    {
                        "id": f"{band}:{parity}:" + hashlib.sha1(
                            (template + "|" + ",".join(str(no) for no in pages_hit)).encode("utf-8")
                        ).hexdigest()[:10],
                        "band": band,
                        "parity": parity,
                        "template": template,
                        "pages": pages_hit,
                        "count": len(pages_hit),
                        "lines": len(run),
                        "block_ids": sorted({item.block_id for item in run}),
                        "sample_text": sorted(texts)[0],
                        "samples": sorted(texts)[:3],
                        "suggested_type": proposed,
                        "confidence": confidence,
                        "used_default_band": used_default_band,
                        # 私有字段：拟合前的排除矩形用它，`collect()` 会滤掉
                        "_items": [(item.page_no, item.bbox) for item in run],
                    }
                )
    candidates.sort(key=lambda c: (c["band"], c["parity"], -c["count"]))
    return candidates


def band_basis(project_id: str, *, library=None) -> dict:
    """体检口径：body 页用哪条路判页边带。

    `{pages, with_margin, default_band}`：`pages` 是 body 页数，`with_margin` 是有版心、
    按"版心之外"判的页数，`default_band` 是只能靠默认页边带的页数（新书第一次识别）。
    """
    pages = [p for p in library_module.list_pages(project_id, library=library) if p.page_type == "body"]
    with_margin = sum(1 for page in pages if page.margin_box)
    return {
        "pages": len(pages),
        "with_margin": with_margin,
        "default_band": len(pages) - with_margin,
    }


#: 排除矩形四周再放宽一点：同一书眉被 OCR 拆成两行时，贴着外框的那一行中心可能刚好在框外。
EXCLUDE_PAD = 0.002


def page_exclusions(project_id: str, *, library=None) -> dict[int, list[tuple[float, float, float, float]]]:
    """每页的**页边重复排除矩形**（只读、现算）：拟合前把中心落在这些矩形里的行剔掉。

    为什么用它：2026-11-05 真机 `b2t_YR5EJ0` p98 的版心 y0=0.0631，把页眉
    （y0=0.0635、宽 0.402 < AUTO_LONG_LINE）包了进去。页眉在长行起步里**本来没参与**，
    是后面"够得着就并进来"那一轮把它吸进来的。把这几行剔掉，拟合就看不到它们了。

    判据与 `collect()` **同一份**（同样的带 / 模板 / 窗口 / 位置稳定），所以"候选清单里
    有的东西"就是"拟合时会剔的东西"，不会出现用户看不到的静默排除。

    返回 `{页号: [矩形, …]}`；没有候选的页（新书 / 还没版心）**不在字典里**，
    那些页的拟合行为与现在完全一致。矩形已合并重叠项，并四周放宽 `EXCLUDE_PAD`。
    """
    rects: dict[int, list[tuple[float, float, float, float]]] = {}
    for candidate in _collect_detailed(project_id, library=library):
        for page_no, bbox in candidate.get("_items", []):
            rects.setdefault(page_no, []).append(_pad_rect(bbox))
    return {page_no: _merge_rects(items) for page_no, items in rects.items()}


def _pad_rect(bbox) -> tuple[float, float, float, float]:
    return (
        max(0.0, float(bbox[0]) - EXCLUDE_PAD),
        max(0.0, float(bbox[1]) - EXCLUDE_PAD),
        min(1.0, float(bbox[2]) + EXCLUDE_PAD),
        min(1.0, float(bbox[3]) + EXCLUDE_PAD),
    )


def _merge_rects(rects: list[tuple[float, float, float, float]]) -> list[tuple[float, float, float, float]]:
    """合并重叠 / 相接的矩形（每页通常 1–4 个，O(n²) 足够）。"""
    merged: list[tuple[float, float, float, float]] = []
    for rect in rects:
        current = rect
        rest: list[tuple[float, float, float, float]] = []
        for other in merged:
            if (
                current[0] <= other[2]
                and other[0] <= current[2]
                and current[1] <= other[3]
                and other[1] <= current[3]
            ):
                current = (
                    min(current[0], other[0]),
                    min(current[1], other[1]),
                    max(current[2], other[2]),
                    max(current[3], other[3]),
                )
            else:
                rest.append(other)
        rest.append(current)
        merged = rest
    return merged


