"""版心（type area）：推算、读写与三态（任务 50）。

**为什么做版心：** 大多数书的正文都在版心里，页眉 / 页脚 / 页码在版心外。
与其逐块标注，不如先把"正文在纸面上的哪一块"确认一次——一本确认一次，
比每页改二三十个块省力（用户 2026-10-23 拍板）。

**这一刀不改任何导出结果。** 版心只存储、展示、可调整；组装 / 导出 / 识别 /
块类型判定都不读它。将来要用它做裁栏或预筛，是下一刀的事。

**坐标一律归一化**（说明书 5.2）：``[x0, y0, x1, y1]``，范围 0–1，不写像素 / 点数。
存储格式与 ``block.bbox`` 一致，是 JSON 文本。

三态（页级）：

- ``inherit``（默认）：跟随项目级默认版心；
- ``custom``：这一页用自己的四边；
- ``none``：这一页不适用版心（整页插图、插页等），**不参与推算**，版心视图里也不压暗。

**推算算法（只读，不写库）：**

1. **优先读检测行**（``page_layout_line``，任务 58）：检测在识别之前完成，
   因此"检测完就能定版心"。没有检测行的页回退到 OCR 行（``block_line``，老项目兼容）；
   一个页只要有一版成功的检测运行，就用它，不与 OCR 行混合。
   回退 OCR 行时，显式标注为 ``header / footer / page_number / figure / decoration``
   的块整块跳过；其余行按**几何**判断（OCR 出来的块类型常常全是 ``paragraph``）。
2. 每页剔掉短行：宽度 < max(页宽的 25%, 该页行宽中位数的一半)，以及落在
   页面上下 4% 带里的行（书眉 / 页码 / 扫描噪声）。剩下不足 3 行的页不参与。
3. 左右：把全书的行 ``x0`` / ``x1`` 排序，找**宽度 1% 页宽**的最密一簇，
   取这簇的中位数。这样不受 OCR 的千分位抖动影响，也不会被居中的标题行带跑。
4. 上下：每页取正文行最上的 ``y0`` / 最下的 ``y1``，再跨页取 **5% / 95% 分位**。
   个别页行少、末行早收，不会把下边缘拉上去；个别版权页从更低处开始，也不会把
   上边缘拉下来。
5. 每边给一个**离散度**（左右 = 最密簇的四分位距；上下 = 贴边那 1/4 页的四分位距）
   和参与页数。离散度 > 2% 页宽、或参与页数 < 5 时，如实返回"建议不可靠"。

**已知会失准的版式：** 双栏 / 多栏（左右取的是整页外缘，不是单栏）、
竖排、整页居中的版权页 / 扉页、大量旁批、旋转页。这些版式仍能给出一个大致的
外框，但需要用户拖一下；不假装它准（见 `docs/known-limitations.md`）。
"""

from __future__ import annotations

import json
import math
import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..storage import db as db_module
from . import blocks as blocks_module
from ..export import header_cleanup
from . import library as library_module

# 页级四态（任务 62）：auto 是默认，每页用自己的检测行拟合；inherit 是显式沿用兜底
MODE_AUTO = "auto"
MODE_INHERIT = "inherit"
MODE_CUSTOM = "custom"
MODE_NONE = "none"
MARGIN_BOX_MODES = (MODE_AUTO, MODE_INHERIT, MODE_CUSTOM, MODE_NONE)

# 当前全局版心是谁写的（`project.margin_box_source`，迁移 0012）
SOURCE_AUTO = "auto"
SOURCE_MANUAL = "manual"

# 自动推算结果（`project.margin_box_suggestion`）的 schema 标记
SUGGESTION_SCHEMA = "book2text.margin-suggestion.v1"

# 推算参数（全部用"页宽 / 页高"的归一化比例，与 DPI 无关）
MIN_PAGES = 5
MIN_LINES_PER_PAGE = 3
# 左右：1% 页宽的最密窗口；OCR 的千分位抖动远小于它
EDGE_WINDOW = 0.010
# 短行：至少 25% 页宽，且不小于该页行宽中位数的一半
SHORT_LINE_MIN_WIDTH = 0.25
SHORT_LINE_RATIO = 0.5
# 页面上下 4% 带：书眉 / 页码 / 扫描噪声
EDGE_BAND = 0.04

SPREAD_HIGH = 0.010
SPREAD_MEDIUM = 0.020
SPREAD_UNRELIABLE = 0.030
MAX_PAGES_NOTE = 10
# 左右边缘的"覆盖率" = 落在最密一簇里的行数 / 全部长行数。
# 双栏、逐页不同的缩进、大量旁批会让它很低；此时众数只代表一小撮行。
#: 上下边缘允许的离散（章末页只排半页是正常现象，比左右宽一档）
VERTICAL_SPREAD_MEDIUM = 0.040
VERTICAL_SPREAD_UNRELIABLE = 0.070

COVERAGE_HIGH = 0.30
COVERAGE_MIN = 0.20

# 推算结果向外让 2% 页宽：OCR 的边缘有千分位抖动，直接贴着众数会切到个别页的字。
# 这只是**建议框**的安全边距；用户拖动时会吸附到真正的行边界。
EDGE_PADDING = 0.02

# 版心最短边：再小就没有"正文区"的意义了（防止拖成一条线 / 手滑输入 0）
MIN_MARGIN_SIDE = 0.02

# 显式版面块：不参与推算（与 export/streams.py 的边缘判断同一类证据）
# 与 `blocks.FURNITURE_BLOCK_TYPES` 是同一份口径（只在这里留个别名，别再抄一遍字面量）
SKIP_BLOCK_TYPES = blocks_module.FURNITURE_BLOCK_TYPES

CONFIDENCE_HIGH = "high"
CONFIDENCE_MEDIUM = "medium"
CONFIDENCE_LOW = "low"
CONFIDENCE_LABELS = {
    CONFIDENCE_HIGH: "高",
    CONFIDENCE_MEDIUM: "中",
    CONFIDENCE_LOW: "低",
}

EDGE_NAMES = ("left", "top", "right", "bottom")
EDGE_LABELS = {"left": "左", "top": "上", "right": "右", "bottom": "下"}

BBox = tuple[float, float, float, float]


class MarginBoxError(library_module.ProjectError):
    """版心参数不合法（接口层转 400）。"""


# ---------------------------------------------------------------- 校验与派生

def normalize_margin_box(values: Sequence[float] | None) -> BBox | None:
    """校验并规整一个归一化版心；``None`` 表示清空。

    规则：四个有限数、都在 0–1、``x0 < x1`` / ``y0 < y1``、最短边 ≥ 2% 页宽。
    与 ``blocks.bbox_to_json`` 一样保留 6 位小数。
    """
    if values is None:
        return None
    if len(values) != 4:
        raise MarginBoxError("版心必须是四个数：[左, 上, 右, 下]")
    try:
        x0, y0, x1, y1 = (float(value) for value in values)
    except (TypeError, ValueError) as exc:
        raise MarginBoxError("版心的四边必须是数字") from exc
    if not all(math.isfinite(value) for value in (x0, y0, x1, y1)):
        raise MarginBoxError("版心的四边必须是有限数字")
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise MarginBoxError("版心必须落在页面内，且左 < 右、上 < 下（归一化 0–1）")
    if x1 - x0 < MIN_MARGIN_SIDE:
        raise MarginBoxError(f"版心太窄：左右至少相差 {MIN_MARGIN_SIDE:.0%} 页宽")
    if y1 - y0 < MIN_MARGIN_SIDE:
        raise MarginBoxError(f"版心太矮：上下至少相差 {MIN_MARGIN_SIDE:.0%} 页高")
    return (round(x0, 6), round(y0, 6), round(x1, 6), round(y1, 6))


def serialize_margin_box(bbox: BBox | None) -> str | None:
    """存库用的 JSON 文本（与 `blocks.bbox_to_json` 同格式）。"""
    return None if bbox is None else json.dumps([round(value, 6) for value in bbox])


def effective_margin_box(
    project: library_module.Project, page: library_module.Page
) -> BBox | None:
    """这一页实际生效的版心。

    - ``none``：无；
    - ``custom``：本页四边；
    - ``auto``：**本页落库的拟合框**（任务 33 起不再回退全局）；
    - ``inherit``：显式沿用全局兜底。

    ``auto`` 页的 ``margin_box`` 为 NULL 表示**未定**（没有检测行 / 还没拟合）：
    返回 None，调用方按"不参与版心判定"处理，绝不拿全局框顶替。
    """
    if page.margin_box_mode == MODE_NONE:
        return None
    if page.margin_box_mode == MODE_CUSTOM:
        return page.margin_box
    if page.margin_box_mode == MODE_AUTO:
        return page.margin_box
    return project.margin_box


def block_center(bbox: Sequence[float] | None) -> tuple[float, float] | None:
    """块的几何中心（归一化坐标）；没有框返回 None。"""
    if not bbox or len(bbox) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(value) for value in bbox)
    except (TypeError, ValueError):
        return None
    return ((x0 + x1) / 2, (y0 + y1) / 2)


def center_inside(center: Sequence[float], box: Sequence[float]) -> bool:
    """中心点是否在版心内（含边界）。审校与导出**共用这一个判断**。"""
    return box[0] <= center[0] <= box[2] and box[1] <= center[1] <= box[3]


def block_inside_margin(
    project: library_module.Project,
    page: library_module.Page,
    bbox: Sequence[float] | None,
) -> bool:
    """一个块算不算"版心内"——审校队列、页头计数、待处理、导出第一层共用。

    - 没有生效框（``none`` / 未定 / ``inherit`` 且没有全局框）：整页都算，不排除；
    - 有框但没有 bbox：算版心内（宁可多审一块，也不把文字藏起来）；
    - 否则看**块中心**是否在 `export_margin_box` 的框里——与导出 `classify_page`
      用的是同一个 `export_margin_box` + `center_inside`，不另写一套。
    """
    box = export_margin_box(project, page)
    if box is None:
        return True
    center = block_center(bbox)
    if center is None:
        return True
    return center_inside(center, box)


def margin_applies(project: library_module.Project, page: library_module.Page) -> bool:
    """这一页是否有生效版心（有框且不是 ``none``）——导出第一层 `applied` 同口径。"""
    return page.margin_box_mode != MODE_NONE and export_margin_box(project, page) is not None


def page_margin_source_label(
    project: library_module.Project, page: library_module.Page
) -> str:
    """页级版心来源（界面文案）。"""
    if page.margin_box_mode == MODE_NONE:
        return "不适用"
    if page.margin_box_mode == MODE_CUSTOM:
        return "本页自定义"
    if page.margin_box_mode == MODE_AUTO:
        method = getattr(page, "margin_box_method", None)
        if page.margin_box is not None:
            return FIT_METHOD_LABELS.get(method or FIT_METHOD_FIT, "自动拟合")
        return FIT_METHOD_LABELS[FIT_METHOD_UNDETERMINED]
    return "沿用默认版心"


def margin_box_for_export(
    project: library_module.Project, page: library_module.Page
) -> BBox | None:
    """导出用的版心：**读与界面 / 审计同一份落库结果**（任务 33）。

    任务 62 时导出刻意不认每页拟合框、只在开关打开时按旧口径（全局框）判定；
    现在每页拟合结果真正落库（``page.margin_box``），界面、导出、审计读同一个框。
    开关仍然默认关——关着时导出与升级前逐字节相同。
    """
    return export_margin_box(project, page)


def export_margin_box(
    project: library_module.Project, page: library_module.Page
) -> BBox | None:
    """**导出**用的版心（任务 53 的安全阀 + 任务 33 的落库口径）。

    - ``custom``：本页四边；
    - ``auto``：本页**落库的**拟合框 / 包围盒；NULL = 未定 → 不判定（不拿全局框顶替）；
    - ``inherit``：沿用全局框，但全局框是**自动推算、还没人确认**（source=auto）时
      导出不认它，退回块类型判定——一个还没人确认过的框不该决定哪些字进正文。

    为什么 ``inherit`` 还保留这条安全阀：全局框只作"行不足时的显式兜底"，用户没有
    确认之前不该影响导出。``auto`` 页现在有本页自己的框，不再受这条影响。
    """
    if page.margin_box_mode == MODE_NONE:
        return None
    if page.margin_box_mode == MODE_CUSTOM:
        return page.margin_box
    if page.margin_box_mode == MODE_AUTO:
        return page.margin_box
    if project.margin_box_source == SOURCE_AUTO:
        return None
    return project.margin_box


def modes_summary(pages: Sequence[library_module.Page]) -> dict[str, int]:
    counts = {mode: 0 for mode in MARGIN_BOX_MODES}
    for page in pages:
        counts[page.margin_box_mode] = counts.get(page.margin_box_mode, 0) + 1
    return counts


# ---------------------------------------------------------------- 推算（纯函数）

@dataclass(frozen=True)
class EdgeStat:
    value: float
    spread: float
    samples: int
    # 左右：这一簇行占全部长行的比例；上下：参与页数 / 参与页数（恒为 1）
    coverage: float = 1.0

    def to_dict(self) -> dict[str, object]:
        return {
            "value": round(self.value, 6),
            "spread": round(self.spread, 6),
            "samples": self.samples,
            "coverage": round(self.coverage, 4),
        }


@dataclass(frozen=True)
class MarginSuggestion:
    margin_box: BBox | None
    pages: int
    lines: int
    edges: dict[str, EdgeStat]
    confidence: str
    reliable: bool
    notes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "margin_box": list(self.margin_box) if self.margin_box else None,
            "pages": self.pages,
            "lines": self.lines,
            "confidence": self.confidence,
            "confidence_label": CONFIDENCE_LABELS.get(self.confidence, self.confidence),
            "reliable": self.reliable,
            "edges": {name: stat.to_dict() for name, stat in self.edges.items()},
            "notes": list(self.notes),
        }


def _quantile(values: Sequence[float], fraction: float) -> float:
    """线性插值分位（与 numpy 的默认口径一致，测试不依赖 numpy）。"""
    ordered = sorted(values)
    if not ordered:
        raise ValueError("空序列没有分位数")
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * weight


def _iqr(values: Sequence[float]) -> float:
    return _quantile(values, 0.75) - _quantile(values, 0.25)


def _densest_edge(values: Sequence[float], window: float) -> tuple[float, float, int]:
    """找宽度 ``window`` 的最密一簇，返回 (中位数, 四分位距, 样本数)。

    先排序再双指针：267 页约几千条行，这个复杂度足够（O(n log n)）。
    用**中位数**而不是窗口中心：OCR 的边缘有千分位抖动，中心值会来回跳。
    """
    ordered = sorted(values)
    best_start = 0
    best_end = 0
    end = 0
    for start in range(len(ordered)):
        if end < start:
            end = start
        while end < len(ordered) and ordered[end] - ordered[start] <= window:
            end += 1
        if end - start > best_end - best_start:
            best_start, best_end = start, end
    inliers = ordered[best_start:best_end]
    if not inliers:
        raise ValueError("没有可用的边缘值")
    return statistics.median(inliers), _iqr(inliers), len(inliers)


def _body_boxes(boxes: Sequence[Sequence[float]]) -> list[BBox]:
    """一页里参与推算的"正文长行"：去掉短行与页面上下边缘带。"""
    usable: list[BBox] = []
    for raw in boxes:
        if not raw or len(raw) != 4:
            continue
        try:
            x0, y0, x1, y1 = (float(value) for value in raw)
        except (TypeError, ValueError):
            continue
        if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
            continue
        usable.append((x0, y0, x1, y1))
    if not usable:
        return []

    widths = [box[2] - box[0] for box in usable]
    median_width = statistics.median(widths)
    min_width = max(SHORT_LINE_MIN_WIDTH, SHORT_LINE_RATIO * median_width)
    return [
        box
        for box in usable
        if box[2] - box[0] >= min_width
        and box[1] >= EDGE_BAND
        and box[3] <= 1 - EDGE_BAND
    ]


def suggest_from_page_boxes(
    page_boxes: Mapping[int, Sequence[Sequence[float]]],
) -> MarginSuggestion:
    """从"页号 → 行框列表"推算版心（纯函数，测试不必建整本书）。"""
    lefts: list[float] = []
    rights: list[float] = []
    tops: list[float] = []
    bottoms: list[float] = []
    # 每页的"文字块外边界"：左端最左、右端最右。参差（ragged）排版里，
    # **这一对的稳定性才是版心稳不稳的证据**（行尾随机短，但每页最宽的那一行都顶到版心）。
    page_left_min: list[float] = []
    page_right_max: list[float] = []
    participating = 0
    line_count = 0

    for page_no in sorted(page_boxes):
        boxes = _body_boxes(page_boxes[page_no])
        if len(boxes) < MIN_LINES_PER_PAGE:
            continue
        participating += 1
        line_count += len(boxes)
        lefts.extend(box[0] for box in boxes)
        rights.extend(box[2] for box in boxes)
        tops.append(min(box[1] for box in boxes))
        bottoms.append(max(box[3] for box in boxes))
        page_left_min.append(min(box[0] for box in boxes))
        page_right_max.append(max(box[2] for box in boxes))

    empty = MarginSuggestion(
        margin_box=None,
        pages=participating,
        lines=line_count,
        edges={},
        confidence=CONFIDENCE_LOW,
        reliable=False,
        notes=("还没有可用的行数据：先做版面检测或识别几页正文再推算。",),
    )
    if not tops:
        return empty

    left_value, left_spread, left_samples = _densest_edge(lefts, EDGE_WINDOW)
    right_value, right_spread, right_samples = _densest_edge(rights, EDGE_WINDOW)
    left_coverage = left_samples / len(lefts) if lefts else 0.0
    right_coverage = right_samples / len(rights) if rights else 0.0
    top_value = _quantile(tops, 0.05)
    bottom_value = _quantile(bottoms, 0.95)
    top_spread = _iqr(sorted(tops)[: max(1, len(tops) // 4)])
    bottom_spread = _iqr(sorted(bottoms)[-max(1, len(bottoms) // 4) :])

    edges = {
        "left": EdgeStat(left_value, left_spread, left_samples, left_coverage),
        "top": EdgeStat(top_value, top_spread, len(tops), 1.0),
        "right": EdgeStat(right_value, right_spread, right_samples, right_coverage),
        "bottom": EdgeStat(bottom_value, bottom_spread, len(bottoms), 1.0),
    }
    try:
        margin_box = normalize_margin_box(
            (
                max(0.0, left_value - EDGE_PADDING),
                max(0.0, top_value - EDGE_PADDING),
                min(1.0, right_value + EDGE_PADDING),
                min(1.0, bottom_value + EDGE_PADDING),
            )
        )
    except MarginBoxError:
        margin_box = None

    notes: list[str] = []
    # 左右与上下的离散要**分开看**（任务 71）：章末页的最后一行常常只到半页，
    # 所以"下边缘"的离散天然比左右大得多，拿它和左右一起取 max 会把正常的书判成不可靠
    # （《安乐哲 译本处理》：左右离散 0.6%，下边缘 3.5% → 原来直接 low）。
    worst = max(edges["left"].spread, edges["right"].spread)
    worst_vertical = max(edges["top"].spread, edges["bottom"].spread)
    coverage = min(left_coverage, right_coverage)
    # 任务 71：**不能只看"左右两边都贴边"**。左对齐（ragged-right）的英文书——
    # 大多数英文书都是——行右端天然参差，右边缘覆盖率必然很低，但版心是确定的：
    # 左边缘极整齐、上下覆盖 100%。原来的规则会把这类书全部判成"低可信，可能双栏"，
    # 实测《安乐哲 译本处理》662 页：左 74.6% / 右 11.7%，被判 low。
    # 现在改成：**只要有一侧贴得很齐**（这一侧就是对齐边）+ 离散度达标，就算可靠；
    # 另一侧参差只在 notes 里说明，并且置信度最多判到 medium（不判 high，因为它确实
    # 少了一条边的证据）。
    aligned_coverage = max(left_coverage, right_coverage)
    ragged_side = "right" if right_coverage < left_coverage else "left"
    # 参差那一侧的**外边界**稳不稳：右参差看每页最右端，左参差看每页最左端。
    # 单看覆盖率会把"版心本身在漂移"的书也放过（测试里左右各页差 40% 页宽那种），
    # 所以再加这一条：外边界的中段离散必须很小。
    if ragged_side == "right":
        outer = sorted(page_right_max)
    else:
        outer = sorted(page_left_min)
    if len(outer) >= 5:
        tail = outer[len(outer) // 4 : len(outer) - len(outer) // 4 or None]
        ragged_outer_spread = _iqr(tail) if len(tail) >= 2 else 0.0
    else:
        ragged_outer_spread = 0.0
    ragged_book = (
        aligned_coverage >= COVERAGE_MIN
        and coverage < COVERAGE_MIN
        and ragged_outer_spread <= SPREAD_MEDIUM
    )
    reliable = (
        participating >= MIN_PAGES
        and worst <= SPREAD_UNRELIABLE
        and worst_vertical <= VERTICAL_SPREAD_UNRELIABLE
        and aligned_coverage >= COVERAGE_MIN
        and (coverage >= COVERAGE_MIN or ragged_book)
    )
    if participating < MIN_PAGES:
        notes.append(
            f"只有 {participating} 页有可用的行数据（少于 {MIN_PAGES} 页），建议不可靠。"
        )
    if worst > SPREAD_MEDIUM:
        notes.append(
            f"左右边缘离散较大（最大 {worst:.1%} 页宽），建议不可靠：可能是双栏、竖排或旁批较多。"
        )
    elif worst_vertical > VERTICAL_SPREAD_MEDIUM:
        notes.append(
            f"上下边缘离散 {worst_vertical:.1%}（章末页往往只排到半页，这是正常的）。"
        )
    if coverage < COVERAGE_MIN and not ragged_book:
        notes.append(
            f"左右的边缘只覆盖 {coverage:.0%} 的正文行，建议不可靠：各页的缩进 / 分栏可能不一致。"
        )
    elif ragged_book:
        side_label = "右" if ragged_side == "right" else "左"
        good_side = "左" if ragged_side == "right" else "右"
        notes.append(
            f"这本书是「{good_side}对齐」排版：{good_side}侧有 {aligned_coverage:.0%} 的行贴边，"
            f"{side_label}侧参差（{coverage:.0%}）是正常的，不是双栏。"
        )
    if MIN_PAGES <= participating < MAX_PAGES_NOTE:
        notes.append(f"参与页数较少（{participating} 页），多识别几页会更稳。")
    if margin_box is not None:
        notes.append(
            f"建议框的四边已向外让 {EDGE_PADDING:.0%} 页宽，避免 OCR 抖动切到个别页的字；"
            "拖动可收紧到行边界。"
        )

    if not reliable:
        confidence = CONFIDENCE_LOW
    elif (
        worst <= SPREAD_HIGH
        and participating >= MAX_PAGES_NOTE
        and coverage >= COVERAGE_HIGH
        and not ragged_book
    ):
        confidence = CONFIDENCE_HIGH
    elif worst <= SPREAD_MEDIUM and worst_vertical <= VERTICAL_SPREAD_MEDIUM:
        confidence = CONFIDENCE_MEDIUM
    else:
        confidence = CONFIDENCE_LOW

    if margin_box is None:
        # 推算出来的四边本身不合法（例如上下极端重叠）：不返回一个假框
        return MarginSuggestion(
            margin_box=None,
            pages=participating,
            lines=line_count,
            edges=edges,
            confidence=CONFIDENCE_LOW,
            reliable=False,
            notes=tuple(notes) + ("推算出的四边不合法（可能只有很少的正文行），请手动拖。",),
        )

    return MarginSuggestion(
        margin_box=margin_box,
        pages=participating,
        lines=line_count,
        edges=edges,
        confidence=confidence,
        reliable=reliable,
        notes=tuple(notes),
    )


# ---------------------------------------------------------------- 从项目推算

def _latest_layout_runs(conn) -> dict[str, str]:
    """每页最近一次成功检测运行的 ``page_id → run_id``（没有则不在字典里）。"""
    rows = conn.execute(
        """
        SELECT l.page_id, l.run_id
        FROM layout_run l
        WHERE l.status = 'succeeded'
          AND NOT EXISTS (
              SELECT 1 FROM layout_run newer
              WHERE newer.page_id = l.page_id AND newer.status = 'succeeded'
                AND (newer.created_at > l.created_at
                     OR (newer.created_at = l.created_at AND newer.rowid > l.rowid))
          )
        """
    ).fetchall()
    return {row["page_id"]: row["run_id"] for row in rows}


def _detected_page_boxes(
    project_id: str,
    *,
    library: Path,
    page_by_id: Mapping[str, library_module.Page],
    candidates: set[str],
) -> dict[int, list[BBox]]:
    """读**检测行**（`page_layout_line`），按页号分组。只读，不写库。

    老项目 / 还没跑迁移 0015 的库没有这张表：返回空，让调用方回退 OCR 行。
    """
    directory = library_module.require_project_dir(project_id, library=library)
    try:
        with db_module.open_database(directory, apply_migrations=False) as conn:
            run_ids = _latest_layout_runs(conn)
            wanted = [run_id for page_id, run_id in run_ids.items() if page_id in candidates]
            if not wanted:
                return {}
            placeholders = ", ".join("?" for _ in wanted)
            rows = conn.execute(
                f"SELECT page_id, bbox FROM page_layout_line WHERE run_id IN ({placeholders})",
                wanted,
            ).fetchall()
    except Exception as exc:  # noqa: BLE001 - 老库没有检测表时回退 OCR
        if "no such table" in str(exc):
            return {}
        raise

    page_boxes: dict[int, list[BBox]] = {}
    for row in rows:
        page = page_by_id.get(row["page_id"])
        if page is None:
            continue
        try:
            values = json.loads(row["bbox"])
            box = tuple(float(value) for value in values)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if len(box) != 4:
            continue
        page_boxes.setdefault(page.page_no, []).append(box)
    return page_boxes


def suggest_margin_box(
    project_id: str, *, library: Path | None = None
) -> MarginSuggestion:
    """读项目里的**检测行**（没有则 OCR 行），跨页推算版心。**只读，不写库。**"""
    target_library = library if library is not None else library_module.default_library_dir()
    pages = library_module.list_pages(project_id, library=target_library)
    page_by_id = {page.page_id: page for page in pages}
    # 只统计正文页；"不适用版心"的页（整页插图等）不参与，否则会把边缘拉歪
    candidates = {
        page.page_id
        for page in pages
        if page.include and page.margin_box_mode != MODE_NONE
    }

    # 检测行优先：阶段 2（检测）在阶段 3（版心）之前，不必等识别
    page_boxes = _detected_page_boxes(
        project_id,
        library=target_library,
        page_by_id=page_by_id,
        candidates=candidates,
    )

    # 没有检测行的页回退 OCR 行（老项目 / 只识别没检测过的页）
    blocks = blocks_module.list_blocks(project_id, library=target_library)
    active_block = {
        block.block_id: block
        for block in blocks
        if block.page_id in candidates and block.block_type not in SKIP_BLOCK_TYPES
    }
    lines = blocks_module.list_block_lines(project_id, library=target_library)

    # 任务 74：拟合前先剔掉**页眉带**里那一行页码（`Page 28`）。
    # 不剔的话顶边会贴着页眉拟合——用户看到"页码几乎全落在版心内部"就是这么来的。
    # 只认"每页第一个块的第一行"，与导出侧同一条窄规则。
    first_line_of_page: dict[int, str] = {}
    ordered_blocks = sorted(active_block.values(), key=lambda item: (item.page_no, item.order_index))
    seen_pages: set[int] = set()
    for block in ordered_blocks:
        if block.page_no in seen_pages:
            continue
        seen_pages.add(block.page_no)
        page_lines = [
            line for line in lines if line.block_id == block.block_id and line.line_index == 0
        ]
        if page_lines and page_lines[0].bbox is not None:
            first_line_of_page[block.page_no] = str(page_lines[0].line_id)

    ocr_page_boxes: dict[int, list[BBox]] = {}
    for line in lines:
        block = active_block.get(line.block_id)
        if block is None or line.bbox is None:
            continue
        page = page_by_id.get(block.page_id)
        if page is None:
            continue
        if first_line_of_page.get(page.page_no) == str(line.line_id):
            # 只看这一行"像不像页眉"：整行页码，或"页码 + 正文"并在一起（长行也算）
            head_text = " ".join((line.text or "").split())
            if header_cleanup.is_page_line(head_text) or header_cleanup.merged_header_prefix(head_text):
                continue
        ocr_page_boxes.setdefault(page.page_no, []).append(line.bbox)
    for page_no, boxes in ocr_page_boxes.items():
        page_boxes.setdefault(page_no, boxes)

    return suggest_from_page_boxes(page_boxes)


# ---------------------------------------------------------------- 每页自动拟合（任务 62）

# 只取"正文长行"：宽度 > 45% 页宽；页码 / 书眉 / 短行 / 装饰会被滤掉
AUTO_LONG_LINE = 0.45
# 拟合出的四边按**行框相对**外扩 2%（不是页面宽高的 2%）
AUTO_PADDING = 0.02
AUTO_MIN_LINES = 3
AUTO_QUANTILE_LOW = 0.05
AUTO_QUANTILE_HIGH = 0.95
# 5/95 会切掉两端的正文行；再用**同一页的相邻行距**把紧邻的正文行收回来。
# 页眉 / 页脚与正文之间的行距更大，不会被卷进来。上限 3% 页高，避免一路爬到页边。
# 实测调出来的值：真书《红楼梦》394 页上，只做 5%/95% 时正文长行有约 9.1%
# 任一边越出拟合框；按同页中位行距做 0.034 的安全扩张后降到 1.83%。不是拍的。
AUTO_SAFETY_GAP = 0.034
AUTO_SAFETY_PASSES = 3
# 尾部回收的上限：只收"像一行字"的长行，避免把跨页横线 / 装饰框当成正文。
AUTO_TAIL_MAX_HEIGHT = 0.06

# ---- 迭代纳入（任务 33）：长行框只覆盖正文宽行，诗行 / 段末短行 / 章节末行会漏掉。
# 从长行框出发，反复把"中心在框内、与框相交、或中心距框边 < 1 个行距"的**像一行字**
# 的行纳入，重算四边，直到不再变化。行距用本页相邻行中心的**中位间距**（不是单个
# 行框的高度）：真书上中位行距约 0.034，诗行与上一行常隔着 1–1.5 个字高。
AUTO_INCLUDE_PASSES = 200
# 行距的上下限：太小会把抖动当相邻，太大（>6% 页高）会一路爬到页眉 / 页码。
AUTO_INCLUDE_MIN_GAP = 0.012
AUTO_INCLUDE_MAX_GAP = 0.06
# "像一行字"的最低线：再薄就是横线 / 装饰（真书正文行高约 0.017–0.021）。
AUTO_MIN_LINE_HEIGHT = 0.003
AUTO_MIN_LINE_WIDTH = 0.005
# 横排正文行的宽高比下限：真书诗行约 2.5–22，竖排旁批约 0.5。
# 不加这一条，页边那些"又高又窄"的竖排旁批会因为纵向与正文框相交被误并进来，
# 把版心左 / 右边界一路拉到页边（第 159 页实测）。
AUTO_MIN_LINE_ASPECT = 1.5
# 章节末行 / 段末诗行与下半页正文之间常隔 1.5–2 个行距，1 个行距够不到。
# 对这些行放宽到 AUTO_INCLUDE_MAX_GAP，但要求它**够宽**（占当前框宽 ≥25%）：
# 页码（真书约 2–7%）仍然进不来；真书第一卷 p15 的章末对句（58%）能进来。
AUTO_EDGE_REACH_RATIO = 0.25


def _parse_box(raw) -> BBox | None:
    if not raw or len(raw) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(value) for value in raw)
    except (TypeError, ValueError):
        return None
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        return None
    return (x0, y0, x1, y1)


def _expand_line(box: BBox, fraction: float) -> BBox:
    """按**行框自己的宽高**外扩 fraction（与 `BBox.expanded` 同口径）。"""
    x0, y0, x1, y1 = box
    dx = (x1 - x0) * fraction
    dy = (y1 - y0) * fraction
    return (
        max(0.0, x0 - dx),
        max(0.0, y0 - dy),
        min(1.0, x1 + dx),
        min(1.0, y1 + dy),
    )


def _is_line_like(box: BBox) -> bool:
    """像一条**检测出来的文字行**：不是横线 / 装饰，也不是退化框。

    只用于"兜底包围盒"：竖排书的行框可能很高（> 6% 页高），不能按横排的行高上限
    过滤，否则整页都会变成"未定"。所以这里只挡极薄、极窄的框。
    """
    width = box[2] - box[0]
    height = box[3] - box[1]
    return width >= AUTO_MIN_LINE_WIDTH and height >= AUTO_MIN_LINE_HEIGHT


def _looks_like_text_line(box: BBox) -> bool:
    """像**正文的一行横排字**：行高合理、宽度不是一条线。

    竖排旁批 / 跨页横线 / 装饰框会被排除：真书第 12、16、370 页里那些
    ``h≈0.07–0.13``、``w≈0.02–0.05`` 的竖条就是竖排旁批，不属于正文行。
    """
    height = box[3] - box[1]
    if height <= 0 or height > AUTO_TAIL_MAX_HEIGHT:
        return False
    return _is_line_like(box) and (box[2] - box[0]) / height >= AUTO_MIN_LINE_ASPECT


def _union_boxes(boxes: Sequence[BBox]) -> BBox:
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def _line_pitch(boxes: Sequence[BBox]) -> float:
    """本页相邻行中心的**中位间距**（"1 行高"的实用口径）。"""
    centers = sorted((box[1] + box[3]) / 2 for box in boxes)
    gaps = [
        later - earlier
        for earlier, later in zip(centers, centers[1:])
        if later - earlier > 0.001
    ]
    if not gaps:
        return AUTO_SAFETY_GAP
    median = _quantile(gaps, 0.5)
    return min(AUTO_INCLUDE_MAX_GAP, max(AUTO_INCLUDE_MIN_GAP, median))


def _within_reach(line: BBox, box: Sequence[float], pitch: float) -> bool:
    """这一行该不该被纳入版心：中心在框内 / 与框相交 / 中心距框边 < 1 行距。"""
    cx = (line[0] + line[2]) / 2
    cy = (line[1] + line[3]) / 2
    if box[0] <= cx <= box[2] and box[1] <= cy <= box[3]:
        return True
    if not (
        line[2] < box[0]
        or line[0] > box[2]
        or line[3] < box[1]
        or line[1] > box[3]
    ):
        return True
    dx = max(box[0] - cx, 0.0, cx - box[2])
    dy = max(box[1] - cy, 0.0, cy - box[3])
    reach = max(dx, dy)
    if reach <= pitch:
        return True
    # 章节间的空白可以到 2 个行距；只对"像正文一行、且够宽"的行放宽。
    box_width = box[2] - box[0]
    line_width = line[2] - line[0]
    return (
        reach <= AUTO_INCLUDE_MAX_GAP
        and box_width > 0
        and line_width / box_width >= AUTO_EDGE_REACH_RATIO
    )


def fit_box_from_lines(lines: Sequence[Sequence[float]]) -> BBox | None:
    """用一页的检测行拟合版心（纯函数；**只管拟合，不做兜底**）。

    - 只保留宽度 > 45% 页宽的正文长行作为起点；
    - 每行先按**行框自身**外扩 2%；
    - 左 / 右 / 上 / 下分别取 5% / 95% 分位；
    - 按行距做安全扩张，再把"中心仍在框外"的首尾正文长行收回来；
    - **迭代纳入**（任务 33）：从长行框出发，把中心在框内 / 与框相交 / 中心距框边
      小于 1 个本页行距的"像一行字"的行纳入，重算四边，直到不再变化（上限
      ``AUTO_INCLUDE_PASSES`` 轮）。诗行、段末短行、章节末行会因此被收回；
      竖排旁批 / 横线 / 装饰框（行高 > 6% 或极薄）不会。
    - 有效长行 < 3 或结果不合法 → None（调用方改走本页包围盒兜底，**不用全局框**）。

    返回的四边是**纳入行框的并集**（每行先外扩 2%），不再保留 5%/95% 的余量。
    """
    parsed = [box for box in (_parse_box(raw) for raw in lines) if box is not None]
    valid: list[BBox] = [
        _expand_line(box, AUTO_PADDING)
        for box in parsed
        if box[2] - box[0] > AUTO_LONG_LINE and _looks_like_text_line(box)
    ]
    if len(valid) < AUTO_MIN_LINES:
        return None
    lefts = [box[0] for box in valid]
    rights = [box[2] for box in valid]
    tops = [box[1] for box in valid]
    bottoms = [box[3] for box in valid]
    try:
        box = list(normalize_margin_box(
            (
                _quantile(lefts, AUTO_QUANTILE_LOW),
                _quantile(tops, AUTO_QUANTILE_LOW),
                _quantile(rights, AUTO_QUANTILE_HIGH),
                _quantile(bottoms, AUTO_QUANTILE_HIGH),
            )
        ))
    except (ValueError, MarginBoxError):
        return None

    # 安全扩张：把"紧邻边框、且与上一行/下一行行距不超过中位行距"的正文长行收回来。
    # 这一步只作用在长行上，短行（页码 / 书眉）不参与；页眉页脚与正文的间距通常更大。
    ordered = sorted(valid, key=lambda item: (item[1] + item[3]) / 2)
    gaps = [
        ((ordered[index + 1][1] + ordered[index + 1][3]) / 2)
        - ((ordered[index][1] + ordered[index][3]) / 2)
        for index in range(len(ordered) - 1)
    ]
    positive = [gap for gap in gaps if gap > 0.001]
    median_gap = _quantile(positive, 0.5) if positive else 0.02
    margin = min(AUTO_SAFETY_GAP, max(0.005, median_gap))
    for _ in range(AUTO_SAFETY_PASSES):
        changed = False
        for line in valid:
            cx = (line[0] + line[2]) / 2
            cy = (line[1] + line[3]) / 2
            dx = max(box[0] - cx, 0.0, cx - box[2])
            dy = max(box[1] - cy, 0.0, cy - box[3])
            if max(dx, dy) > margin:
                continue
            if cx < box[0]:
                box[0] = line[0]
            if cx > box[2]:
                box[2] = line[2]
            if cy < box[1]:
                box[1] = line[1]
            if cy > box[3]:
                box[3] = line[3]
            changed = True
        if not changed:
            break

    # 尾部回收（任务 62 验收补充）：5%/95% 会切掉首尾各 5% 的正文长行，安全扩张只收
    # 行距 ≤ 0.034 的相邻行；真书上仍有 69 条正文长行中心落在框外（多为每页第一/末行）。
    # 这里对"中心仍在框外、且高度像一行字"的长行按行框收回来，保证正文行不被标成版心外。
    for line in valid:
        if line[3] - line[1] > AUTO_TAIL_MAX_HEIGHT:
            continue
        cx = (line[0] + line[2]) / 2
        cy = (line[1] + line[3]) / 2
        if cx < box[0]:
            box[0] = line[0]
        if cx > box[2]:
            box[2] = line[2]
        if cy < box[1]:
            box[1] = line[1]
        if cy > box[3]:
            box[3] = line[3]

    # 迭代纳入（任务 33）：短行（诗行 / 段末 / 章节末行）不在 valid 里，但它们是正文。
    # 从上面的长行框出发，把它够得着的"像一行字"的行并进来，重算四边，直到不再变化。
    bodies = [
        _expand_line(line, AUTO_PADDING)
        for line in parsed
        if _looks_like_text_line(line)
    ]
    pitch = _line_pitch(bodies)
    included = {index for index, line in enumerate(bodies) if _within_reach(line, box, pitch)}
    # 每轮至少并入一行；顺序扫描时"更靠上"的行可能在同一轮里被过早检查，
    # 所以轮数上限按本页行数算（+2 轮收尾），再套一个硬上限。
    passes = min(AUTO_INCLUDE_PASSES, len(bodies) + 2)
    for _ in range(passes):
        if included:
            box = list(_union_boxes([bodies[index] for index in included]))
        grew = False
        for index, line in enumerate(bodies):
            if index in included:
                continue
            if not _within_reach(line, box, pitch):
                continue
            included.add(index)
            box = list(_union_boxes([bodies[i] for i in included]))
            grew = True
        if not grew:
            break
    try:
        return normalize_margin_box(box)
    except MarginBoxError:
        return None


# 兜底方式：没有全局框可退，退"本页所有检测行的包围盒"；连行都没有才算"未定"。
FIT_METHOD_FIT = "fit"
FIT_METHOD_BBOX = "bbox"
FIT_METHOD_UNDETERMINED = "undetermined"
FIT_METHOD_LABELS = {
    FIT_METHOD_FIT: "自动拟合",
    FIT_METHOD_BBOX: "本页包围盒（兜底）",
    FIT_METHOD_UNDETERMINED: "未定（还没有拟合框）",
}


@dataclass(frozen=True)
class FittedMargin:
    """一页的拟合结果：四边 + 怎么来的 + 用了多少行。"""

    box: BBox | None
    method: str
    lines: int
    long_lines: int

    @property
    def undetermined(self) -> bool:
        return self.method == FIT_METHOD_UNDETERMINED

    def to_dict(self) -> dict[str, object]:
        return {
            "margin_box": list(self.box) if self.box else None,
            "method": self.method,
            "label": FIT_METHOD_LABELS.get(self.method, self.method),
            "lines": self.lines,
            "long_lines": self.long_lines,
        }


def fit_page_margin_box(lines: Sequence[Sequence[float]]) -> FittedMargin:
    """一页的版心：先拟合；拟合不出来就退本页所有检测行的包围盒。

    **绝不回退全局版心**（任务 33）：全局框对这本书根本不成立，退过去就等于
    在"按版心判定"打开时把正文从两头切掉。本页连一条检测行都没有时标"未定"，
    不参与版心判定（导出预检会报"版心未定 N 页"）。
    """
    parsed = [box for box in (_parse_box(raw) for raw in lines) if box is not None]
    bodies = [box for box in parsed if _looks_like_text_line(box)]
    long_lines = [box for box in bodies if box[2] - box[0] > AUTO_LONG_LINE]
    fitted = fit_box_from_lines(lines)
    if fitted is not None:
        return FittedMargin(fitted, FIT_METHOD_FIT, len(parsed), len(long_lines))
    usable = [box for box in parsed if _is_line_like(box)]
    if not usable:
        return FittedMargin(None, FIT_METHOD_UNDETERMINED, len(parsed), len(long_lines))
    # 2026-11-04（CER 首测 p36）：兜底取"本页所有行"会把竖排书眉（宽 0.035）与页码算进
    # 包围盒，x0 被拉到 0.0347（同书拟合页在 0.13–0.26）。
    # "长行"按**本页最宽行的比例**判：这本书正文列只有 0.42 宽，固定 0.45（AUTO_LONG_LINE）
    # 会把正文也判成短行；书眉/页码只有 0.03，与正文差一个量级。有 ≥3 条长行时只用长行
    # 定框；长行不够（诗页 / 图页）就退回原来的"所有行"，行为不变。
    widest = max(box[2] - box[0] for box in usable)
    long_threshold = max(AUTO_LONG_LINE * 0.4, widest * 0.45)
    wide = [box for box in usable if box[2] - box[0] >= long_threshold]
    chosen = wide if len(wide) >= 3 else usable
    try:
        box = normalize_margin_box(
            _union_boxes([_expand_line(line, AUTO_PADDING) for line in chosen])
        )
    except (ValueError, MarginBoxError):
        return FittedMargin(None, FIT_METHOD_UNDETERMINED, len(parsed), len(long_lines))
    return FittedMargin(box, FIT_METHOD_BBOX, len(parsed), len(long_lines))


def _latest_layout_boxes(directory: Path, page_id: str) -> list[BBox]:
    """这一页最近一次成功检测的行框；没有检测表时返回空。"""
    try:
        with db_module.open_database(directory, apply_migrations=False) as conn:
            row = conn.execute(
                """
                SELECT run_id FROM layout_run
                WHERE page_id = ? AND status = 'succeeded'
                ORDER BY created_at DESC, rowid DESC LIMIT 1
                """,
                (page_id,),
            ).fetchone()
            if row is None:
                return []
            rows = conn.execute(
                "SELECT bbox FROM page_layout_line WHERE run_id = ? ORDER BY line_index",
                (row["run_id"],),
            ).fetchall()
    except Exception as exc:  # noqa: BLE001 - 老库没有检测表
        if "no such table" in str(exc):
            return []
        raise
    boxes: list[BBox] = []
    for item in rows:
        try:
            values = json.loads(item["bbox"])
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        box = _parse_box(values)
        if box is not None:
            boxes.append(box)
    return boxes


def _page_ocr_line_boxes(
    project_id: str, page: library_module.Page, *, library: Path | None
) -> tuple[list[BBox], bool, bool]:
    """这一页的 OCR 行框（`block_line`）+ 有没有文字 + 有没有识别过。

    与 `suggest_margin_box` 的回退口径同源：显式 `header / footer / page_number /
    figure / decoration` 整块跳过（书眉页码不参与拟合），其余块的行框都算正文行。

    ``has_text`` / ``recognized`` 合起来才能区分三件事：还没识别（未定）、
    识别过但整页没有字（无文字，跳过）、有字（能拟合）。
    """
    blocks = blocks_module.list_blocks(project_id, library=library, page_no=page.page_no)
    has_text = any((block.text or "").strip() for block in blocks)
    active = {
        block.block_id for block in blocks if block.block_type not in SKIP_BLOCK_TYPES
    }
    if not active:
        recognized = blocks_module.page_has_successful_run(
            project_id, page.page_id, library=library
        )
        return [], has_text, recognized
    lines = blocks_module.list_block_lines(
        project_id, library=library, page_no=page.page_no
    )
    boxes = [
        line.bbox
        for line in lines
        if line.block_id in active and line.bbox is not None
    ]
    return boxes, has_text, True


def _page_fit_lines(
    directory: Path,
    project_id: str,
    page: library_module.Page,
    *,
    library: Path | None,
) -> tuple[list[BBox], str, bool, bool]:
    """拟合这一页该用哪些行框：**识别行优先**，没有识别行才看检测行（刀 2）。

    返回 ``(行框, 来源, 有没有文字, 有没有识别过)``。

    顺序在 2026-10-27 调换（任务 56）：新版工作流是「识别 → 版心」，识别行一定先有；
    识别行的块类型已经分好（书眉 / 页脚 / 页码整块跳过），比裸检测行更适合拟合。
    检测行降级成兜底：只识别过没检测过的老数据、或只跑过检测的页用它。
    """
    boxes, has_text, recognized = _page_ocr_line_boxes(
        project_id, page, library=library
    )
    if boxes:
        return boxes, "ocr", has_text, recognized
    layout_boxes = _latest_layout_boxes(directory, page.page_id)
    if layout_boxes:
        return layout_boxes, "layout", True, True
    return [], "none", has_text, recognized


def fit_page_margin(
    project_id: str,
    page_no: int,
    *,
    library: Path | None = None,
    only_auto: bool = True,
) -> dict[str, object]:
    """用这一页的**行框**拟合版心，写回 `page.margin_box` + `margin_box_method`。

    - **不覆盖 custom**；`none` 也不动；
    - 行框来源：检测行优先（`page_layout_line`），没有检测行就回退**识别行**
      （`block_line`，刀 1）——识别行就是同一套行框，不必为了版心先等一遍检测；
    - 拟合不出（有效长行 < 3）→ 退**本页所有行的包围盒**（method=`bbox`）；
    - 一条行都没有 → `margin_box = NULL` + method=NULL（**未定**），
      读取时**不回退全局框**，也不参与版心判定；本页连文字都没有时另报 `no_text`；
    - 重检测 / 重新拟合时覆盖上一次的结果（界面、导出、审计读同一份）。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    page = next((item for item in pages if item.page_no == page_no), None)
    if page is None:
        raise library_module.ProjectError(f"没有第 {page_no} 页")
    if page.margin_box_mode in (MODE_CUSTOM, MODE_NONE):
        return {"page_no": page_no, "updated": False, "reason": "custom_or_none"}
    if only_auto and page.margin_box_mode != MODE_AUTO:
        return {"page_no": page_no, "updated": False, "reason": "not_auto"}
    boxes, source, has_text, recognized = _page_fit_lines(
        directory, project_id, page, library=target_library
    )
    fitted = fit_page_margin_box(boxes)
    method = None if fitted.undetermined else fitted.method
    # 「无文字」不等于「还没识别」（刀 1）：识别跑过、结果整页没有字（插图 / 空白）才算
    # 无文字，跳过；从没识别过的页是未定，不能拿"无文字"把它放过去。
    no_text = bool(fitted.undetermined and not has_text and recognized)
    with db_module.open_database(directory) as conn:
        conn.execute(
            "UPDATE page SET margin_box = ?, margin_box_method = ?"
            " WHERE page_id = ? AND margin_box_mode IN ('auto','inherit')",
            (serialize_margin_box(fitted.box), method, page.page_id),
        )
        conn.execute("UPDATE project SET updated_at = ?", (_now(),))
        conn.commit()
    return {
        "page_no": page_no,
        "updated": True,
        "margin_box": list(fitted.box) if fitted.box else None,
        "method": fitted.method,
        "fallback": fitted.method == FIT_METHOD_BBOX,
        "undetermined": fitted.undetermined,
        "no_text": no_text,
        "source": source,
        "lines": fitted.lines,
        "long_lines": fitted.long_lines,
    }


def fit_all_pages(
    project_id: str,
    *,
    library: Path | None = None,
    only_missing: bool = False,
    limit: int | None = None,
    body_only: bool = False,
) -> dict[str, object]:
    """把 inherit / auto 的页全部改为每页自动拟合；custom / none 不动。

    任务 36B 追加两个只影响"做多少"的参数，默认值保持旧行为：

    - ``only_missing=True``：只处理 ``mode=auto`` 且 ``margin_box`` 仍是 NULL 的页
      （界面「全局识别」）。``inherit`` 是用户显式选择沿用默认框，
      这一类也不碰——自动补拟合不该改变它。非正文页（``include=False``）也不在
      自动补拟合的范围里：它们不参与版心判定，算进分母会让步骤条永远绿不了。
    - ``limit``：这一轮最多处理多少页；``remaining`` 回传还有多少页没轮到，
      界面据此分批调用并显示真实进度。
    - ``body_only=True``（2026-11-05，界面「重新识别」）：只处理正文页。重跑全书时
      非正文页（封面 / 目录 / 空白）不该跟着重算——它们的框不进任何判定。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    skipped_custom = skipped_none = skipped_inherit = skipped_fitted = 0
    skipped_not_body = 0
    targets: list[library_module.Page] = []
    for page in pages:
        if page.margin_box_mode == MODE_CUSTOM:
            skipped_custom += 1
            continue
        if page.margin_box_mode == MODE_NONE:
            skipped_none += 1
            continue
        if body_only and not page.include:
            skipped_not_body += 1
            continue
        if only_missing:
            if page.margin_box_mode != MODE_AUTO:
                skipped_inherit += 1
                continue
            if not page.include:
                skipped_not_body += 1
                continue
            if page.margin_box is not None:
                skipped_fitted += 1
                continue
        targets.append(page)
    batch = targets[:limit] if limit is not None else targets
    remaining = len(targets) - len(batch)
    updated = fitted = fallback = undetermined = no_text = 0
    for page in batch:
        if page.margin_box_mode == MODE_INHERIT:
            with db_module.open_database(directory) as conn:
                conn.execute(
                    "UPDATE page SET margin_box_mode = 'auto' WHERE page_id = ?",
                    (page.page_id,),
                )
                conn.commit()
        result = fit_page_margin(project_id, page.page_no, library=target_library)
        if result.get("updated"):
            updated += 1
            if result.get("no_text"):
                no_text += 1
            elif result.get("undetermined"):
                undetermined += 1
            elif result.get("fallback"):
                fallback += 1
            else:
                fitted += 1
    return {
        "updated": updated,
        "fitted": fitted,
        "fallback": fallback,
        "undetermined": undetermined,
        "no_text": no_text,
        "skipped_custom": skipped_custom,
        "skipped_none": skipped_none,
        "skipped_inherit": skipped_inherit,
        "skipped_fitted": skipped_fitted,
        "skipped_not_body": skipped_not_body,
        "remaining": remaining,
        "only_missing": only_missing,
    }


def page_margin_audit(
    project_id: str, page_no: int, *, library: Path | None = None
) -> dict[str, object]:
    """这一页的版心审计：行越界（拟合准不准）+ 被例外救回来的块（异常页）。

    两件事分开报，因为后果不同：

    - ``outside`` / ``total_lines``：正文长行**任一边**越出版心（任务 33 口径）。
      中心在框内、字却被切掉一条，正是"版心框切过正文"的情况，只看中心会漏。
    - ``rescued``：中心在框外、但按导出同一套规则**留在正文**的块（刀 0：文字列内的
      标题 / 章首）。它们不会丢，但这一页值得看一眼——导出与审计用同一个函数判定，
      不会出现"审计说 0 页、导出少了 30 个标题"。

    行框来源与拟合同源：检测行优先，没有就回退 OCR 行（刀 1）。
    """
    from ..export import margin_rules  # 局部导入：margin_rules 反向依赖本模块

    target_library = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    page = next((item for item in pages if item.page_no == page_no), None)
    if page is None:
        raise library_module.ProjectError(f"没有第 {page_no} 页")
    project = library_module.load_project(project_id, library=target_library)
    boxes, line_source, _has_text, _recognized = _page_fit_lines(
        directory, project_id, page, library=target_library
    )
    long_lines = [
        b for b in boxes if b[2] - b[0] > AUTO_LONG_LINE and _looks_like_text_line(b)
    ]
    blocks = blocks_module.list_blocks(
        project_id, library=target_library, page_no=page_no
    )
    layout = margin_rules.classify_page(page, blocks, project, enabled=True)
    box = layout.margin_box if layout.applied else None
    rescued_blocks = [b for b in blocks if b.block_id in layout.rescued_ids]
    method = None if box is None else getattr(page, "margin_box_method", None)

    outside: list[list[float]] = []
    if box is not None:
        for b in long_lines:
            if (
                b[0] < box[0] - 1e-9
                or b[1] < box[1] - 1e-9
                or b[2] > box[2] + 1e-9
                or b[3] > box[3] + 1e-9
            ):
                outside.append(list(b))
    return {
        "page_no": page_no,
        "total_lines": len(long_lines),
        "outside": len(outside),
        "samples": outside[:5],
        "rescued": len(rescued_blocks),
        "rescued_samples": [(b.text or "").strip()[:40] for b in rescued_blocks[:5]],
        "rescued_ids": [b.block_id for b in rescued_blocks],
        "anomalous": bool(outside or rescued_blocks),
        "lines_source": line_source,
        "method": method if page.margin_box_mode == MODE_AUTO else None,
        "source": page_margin_source_label(project, page),
        "undetermined": box is None and page.margin_box_mode == MODE_AUTO,
    }


# ---------------------------------------------------------------- 自动推算（任务 53）

def can_auto_write(project: library_module.Project) -> bool:
    """自动推算能不能覆盖当前全局版心。

    **只有两种情形可以写**：

    1. 项目还没有全局版心（``margin_box is None``）；
    2. 当前全局版心本来就是自动写的（``source == "auto"``）。

    手动设置过（``source == "manual"``）绝不覆盖。**老项目**（迁移 0012 之前
    在任务 50 里手动设过版心）是 ``source is None`` + 版心非空——同样按手动对待，
    否则升级后第一次识别就会悄悄改掉用户定好的版心。
    """
    if project.margin_box is None:
        return True
    return project.margin_box_source == SOURCE_AUTO


def suggestion_record(
    suggestion: MarginSuggestion,
    *,
    trigger: str,
    job_id: str | None,
    applied: bool,
) -> dict[str, object]:
    """一条可存库 / 可回给界面的建议记录（schema + 时间 + 触发来源 + 是否已写入生效）。"""
    payload = suggestion.to_dict()
    payload.update(
        {
            "schema": SUGGESTION_SCHEMA,
            "suggested_at": _now(),
            "trigger": trigger,
            "job_id": job_id,
            "applied": applied,
        }
    )
    return payload


def write_margin_suggestion(
    project_id: str,
    *,
    trigger: str,
    job_id: str | None = None,
    library: Path | None = None,
) -> dict[str, object]:
    """算一次版心并把结果写进项目（检测 / 识别收尾、打开老项目时调用）。

    - **总是**更新 `margin_box_suggestion`（"建议"是只读参考，任何人都可以看）；
    - 只在 `can_auto_write` 为真时把建议写进 `margin_box`，并把来源标成 ``auto``；
    - 已经有手动版心时**只更新建议、不动当前值**。

    一次检测 / 识别任务只在收尾调用一次（不是每页一次），避免处理过程中框来回跳。
    """
    project = library_module.load_project(project_id, library=library)
    suggestion = suggest_margin_box(project_id, library=library)
    if suggestion.margin_box is None:
        # 还没有可用的行数据：不写一个空建议，免得界面显示"建议 0 页"
        return {
            "suggestion": None,
            "applied": False,
            "source": project.margin_box_source,
            "margin_box": list(project.margin_box) if project.margin_box else None,
        }

    applied = can_auto_write(project)
    record = suggestion_record(
        suggestion, trigger=trigger, job_id=job_id, applied=applied
    )
    now = _now()
    directory = library_module.require_project_dir(project_id, library=library)
    with db_module.open_database(directory) as conn:
        if applied:
            conn.execute(
                "UPDATE project SET margin_box = ?, margin_box_source = ?,"
                " margin_box_set_at = ?, margin_box_suggestion = ?, updated_at = ?",
                (
                    serialize_margin_box(suggestion.margin_box),
                    SOURCE_AUTO,
                    now,
                    json.dumps(record, ensure_ascii=False),
                    now,
                ),
            )
        else:
            # 手动值不动、也不动 updated_at：项目卡片的排序不该因为一次自动推算而变
            conn.execute(
                "UPDATE project SET margin_box_suggestion = ?",
                (json.dumps(record, ensure_ascii=False),),
            )
        conn.commit()

    return {
        "suggestion": record,
        "applied": applied,
        "source": SOURCE_AUTO if applied else project.margin_box_source,
        "margin_box": list(suggestion.margin_box) if applied else (
            list(project.margin_box) if project.margin_box else None
        ),
    }


def ensure_margin_suggestion(
    project_id: str, *, library: Path | None = None
) -> dict[str, object] | None:
    """打开项目时给**老项目**补一次：没有存过建议就现在算一次。

    识别任务收尾会自动算（`recognition._auto_margin_after_job`）；但升级前就识别过的项目
    没有那次收尾，打开时不该还让用户先点「推算版心」。已经存过建议的项目直接跳过
    （不反复重算、不动框）。
    """
    project = library_module.load_project(project_id, library=library)
    if project.kind != "main":
        return None
    if project.margin_box_suggestion is not None:
        return None
    return write_margin_suggestion(project_id, trigger="open", library=library)


# ---------------------------------------------------------------- 写入

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def set_project_margin_box(
    project_id: str,
    margin_box: Sequence[float] | None,
    *,
    library: Path | None = None,
) -> library_module.Project:
    """设置 / 清空项目级默认版心。只影响 `inherit` 的页，不改任何导出的内容。

    这是**用户手动**写入：来源记成 ``manual``（任务 53 的"自动推算不覆盖手动值"就靠它）。
    清空（``None``）把来源也清掉：之后识别收尾可以重新自动推算。
    """
    bbox = normalize_margin_box(margin_box)
    now = _now()
    directory = library_module.require_project_dir(project_id, library=library)
    with db_module.open_database(directory) as conn:
        conn.execute(
            "UPDATE project SET margin_box = ?, margin_box_source = ?,"
            " margin_box_set_at = ?, updated_at = ?",
            (
                serialize_margin_box(bbox),
                SOURCE_MANUAL if bbox is not None else None,
                now if bbox is not None else None,
                now,
            ),
        )
        conn.commit()
    return library_module.load_project(project_id, library=library)


def _page_row(conn, page_no: int):
    row = conn.execute("SELECT * FROM page WHERE page_no = ?", (page_no,)).fetchone()
    if row is None:
        raise library_module.ProjectError(f"没有第 {page_no} 页")
    return row


def _validated_mode(mode: str) -> str:
    if mode not in MARGIN_BOX_MODES:
        raise MarginBoxError(
            f"未知的版心模式：{mode!r}（可选 {' / '.join(MARGIN_BOX_MODES)}）"
        )
    return mode


def set_page_margin_box(
    project_id: str,
    page_no: int,
    mode: str,
    margin_box: Sequence[float] | None = None,
    *,
    library: Path | None = None,
) -> library_module.Page:
    """设置一页的版心三态；`custom` 必须给四边，`inherit` / `none` 会清空本页四边。"""
    _validated_mode(mode)
    bbox = normalize_margin_box(margin_box) if mode == MODE_CUSTOM else None
    if mode == MODE_CUSTOM and bbox is None:
        raise MarginBoxError("设为「本页自定义」时必须提供四边")

    directory = library_module.require_project_dir(project_id, library=library)
    with db_module.open_database(directory) as conn:
        row = _page_row(conn, page_no)
        conn.execute(
            "UPDATE page SET margin_box = ?, margin_box_mode = ?, margin_box_method = NULL"
            " WHERE page_id = ?",
            (serialize_margin_box(bbox), mode, row["page_id"]),
        )
        conn.execute("UPDATE project SET updated_at = ?", (_now(),))
        conn.commit()

    for page in library_module.list_pages(project_id, library=library):
        if page.page_no == page_no:
            return page
    raise library_module.ProjectError(f"没有第 {page_no} 页")  # pragma: no cover


def set_pages_margin_box(
    project_id: str,
    page_nos: Sequence[int],
    mode: str,
    margin_box: Sequence[float] | None = None,
    *,
    library: Path | None = None,
) -> list[library_module.Page]:
    """批量设置版心四态（整批一个事务；有一页不存在就整批拒绝）。

    `custom` 时所有选中页用**同一个**四边（界面上的"设为自定义"就是复制当前版心）；
    想逐页微调再拖框。切到 `auto` 时**已经 auto 的页保留自己的框**（换模式不该
    把刚拟合好的框清掉）；从 `custom` / `inherit` / `none` 过来的页清空，等重新拟合。
    """
    _validated_mode(mode)
    if not page_nos:
        raise MarginBoxError("没有指定要设置的页面")
    unique = list(dict.fromkeys(int(value) for value in page_nos))
    bbox = normalize_margin_box(margin_box) if mode == MODE_CUSTOM else None
    if mode == MODE_CUSTOM and bbox is None:
        raise MarginBoxError("设为「本页自定义」时必须提供四边")

    directory = library_module.require_project_dir(project_id, library=library)
    condition = ", ".join("?" for _ in unique)
    with db_module.open_database(directory) as conn:
        found = {
            int(row["page_no"])
            for row in conn.execute(
                f"SELECT page_no FROM page WHERE page_no IN ({condition})", unique
            ).fetchall()
        }
        missing = [value for value in unique if value not in found]
        if missing:
            raise library_module.ProjectError(
                f"找不到这些页面：{'、'.join(str(value) for value in missing[:5])}"
            )
        if mode == MODE_AUTO:
            # 已经是 auto 的页保留原框；其它模式过来的页清空框与方法，等重新拟合。
            conn.execute(
                f"UPDATE page SET margin_box_mode = 'auto',"
                f" margin_box = CASE WHEN margin_box_mode = 'auto' THEN margin_box ELSE NULL END,"
                f" margin_box_method = CASE WHEN margin_box_mode = 'auto'"
                f" THEN margin_box_method ELSE NULL END"
                f" WHERE page_no IN ({condition})",
                unique,
            )
        else:
            conn.execute(
                f"UPDATE page SET margin_box = ?, margin_box_mode = ?, margin_box_method = NULL"
                f" WHERE page_no IN ({condition})",
                (serialize_margin_box(bbox), mode, *unique),
            )
        conn.execute("UPDATE project SET updated_at = ?", (_now(),))
        conn.commit()

    pages = library_module.list_pages(project_id, library=library)
    wanted = set(unique)
    return [page for page in pages if page.page_no in wanted]


def margin_box_state(
    project_id: str, *, library: Path | None = None
) -> dict[str, object]:
    """项目版心概览：默认版心 + 来源 / 时间 + 最近一次建议 + 三态计数 + 非默认页。"""
    project = library_module.load_project(project_id, library=library)
    pages = library_module.list_pages(project_id, library=library)
    method_counts = {FIT_METHOD_FIT: 0, FIT_METHOD_BBOX: 0, FIT_METHOD_UNDETERMINED: 0}
    for page in pages:
        if page.margin_box_mode != MODE_AUTO:
            continue
        if page.margin_box is None:
            method_counts[FIT_METHOD_UNDETERMINED] += 1
        else:
            method = getattr(page, "margin_box_method", None) or FIT_METHOD_FIT
            method_counts[method] = method_counts.get(method, 0) + 1
    return {
        "margin_box": list(project.margin_box) if project.margin_box else None,
        "source": project.margin_box_source,
        "set_at": project.margin_box_set_at,
        "suggestion": (
            dict(project.margin_box_suggestion)
            if project.margin_box_suggestion
            else None
        ),
        "modes": modes_summary(pages),
        # 任务 33：auto 页的框是哪来的（拟合 / 本页包围盒兜底 / 未定），界面据此说清来源
        "auto_methods": method_counts,
        "exceptions": [
            {
                "page_no": page.page_no,
                "margin_box_mode": page.margin_box_mode,
                "margin_box": list(page.margin_box) if page.margin_box else None,
            }
            for page in pages
            if page.margin_box_mode in (MODE_CUSTOM, MODE_NONE)
        ],
    }
