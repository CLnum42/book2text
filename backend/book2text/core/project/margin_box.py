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
import logging
import math
import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..storage import db as db_module
from ..storage.ulid import new_ulid
from . import blocks as blocks_module
from ..export import header_cleanup
from . import furniture_candidates
from . import library as library_module

_LOG = logging.getLogger(__name__)

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

    # 2026-11-05：跨页推算与每页拟合**同一套剔除**——页边重复行（书眉 / 页脚 / 页码）
    # 在两条输入路径（检测行 / OCR 行）合并之后统一剔，避免同一行从另一个入口溜进来。
    exclusions = _page_exclusions_for(project_id, library=target_library)
    bands = _furniture_bands_for(project_id, library=target_library)
    if exclusions or bands:
        page_boxes = {
            page_no: drop_furniture_zone_lines(
                strip_furniture_lines(
                    boxes, exclusions.get(page_no), page_no=page_no
                ),
                parity="even" if page_no % 2 == 0 else "odd",
                bands=bands,
            )
            for page_no, boxes in page_boxes.items()
        }

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

# ---- 同一栏内**所有**非家具行都参与纵向取界（2026-11-05 改）。
# 原来用"逐行够得着"扩张，对"隔得远但同属一栏"的短行天然无解：p61 的小结标题与第一行
# 长行隔 1.7 个行高，够不着 ⇒ 标题被扔在版心外。现在横向用长行定义"栏"，纵向取
# "x 范围与栏重叠的行"的并集；页眉 / 页脚在拟合前已按页边重复剔掉。
# "像一行字"的最低线：再薄就是横线 / 装饰（真书正文行高约 0.017–0.021）。
AUTO_MIN_LINE_HEIGHT = 0.003
AUTO_MIN_LINE_WIDTH = 0.005
# 横排正文行的宽高比下限：真书诗行约 2.5–22，竖排旁批约 0.5。
# 不加这一条，页边那些"又高又窄"的竖排旁批会因为纵向与正文框相交被误并进来，
# 把版心左 / 右边界一路拉到页边（第 159 页实测）。
AUTO_MIN_LINE_ASPECT = 1.5


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


#: 双栏 / 双页合一的**栏缝**最小宽度（归一化页宽）。预验（2026-11-05，两本书全本）：
#: YR5EJ0 单栏论文 230 页 → 0 页被判成双栏；H6GXVG 双页合一 40 页 → 27 页双栏 / 13 页单栏
#: （那 13 页是"只有左半有内容"的真实单栏页）。
COLUMN_GUTTER_MIN = 0.08


def column_gutter(boxes: Sequence[Sequence[float]]) -> tuple[float, float] | None:
    """这一页的栏缝 `(左栏右沿, 右栏左沿)`；没有 ≥ ``COLUMN_GUTTER_MIN`` 的内部空带 ⇒ None。

    判据是**栏缝不是行数**：把行框投影到 x 轴、合并覆盖区间，找"左右两侧都有行"的空带，
    取最宽的一条。竖排页的行框极窄但横向连续（没有 8% 的竖向空带），自然落在单栏。

    **调用前提**：传入的必须是**已经剔掉页边重复行**的行框。顺序反了会出两种错：
    书眉（x 0.008–0.055）被当成"左栏有内容"、栏缝右移；或者"书眉 + 一栏正文"之间
    出现 ≥8% 的空带，整页被判成双栏、把书眉又盖回框里。`fit_box_from_lines` 收到的
    本来就是剔过的行（见 `fit_page_margin`），这里再按"像一行字"滤一次，挡住竖排旁批。
    """
    parsed = [
        box
        for box in (_parse_box(raw) for raw in boxes)
        if box is not None and _looks_like_text_line(box)
    ]
    if len(parsed) < 2:
        return None
    merged: list[list[float]] = []
    for box in sorted(parsed, key=lambda item: item[0]):
        if merged and box[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], box[2])
        else:
            merged.append([box[0], box[2]])
    best: tuple[float, float, float] | None = None
    for left, right in zip(merged, merged[1:]):
        width = right[0] - left[1]
        if width >= COLUMN_GUTTER_MIN and (best is None or width > best[2]):
            best = (left[1], right[0], width)
    return None if best is None else (best[0], best[1])


def fit_box_from_lines(lines: Sequence[Sequence[float]]) -> BBox | None:
    """用一页的检测行拟合版心（纯函数；**只管拟合，不做兜底**）。

    - 只保留宽度 > 45% 页宽的正文长行作为起点；
    - 每行先按**行框自身**外扩 2%；
    - 左 / 右 / 上 / 下分别取 5% / 95% 分位；
    - 按行距做安全扩张，再把"中心仍在框外"的首尾正文长行收回来；
    - **纵向取界**（2026-11-05）：横向用长行的 x 范围定义"这一栏"，纵向取**所有与该栏
      有横向重叠的非家具行**的并集——居中小标题、诗行、段末短行因此自然进框，不再依赖
      "逐行够得着"（它对隔得远但同属一栏的短行无解，真机 p61 因此把标题扔在框外）。
      竖排旁批 / 横线 / 装饰框（行高 > 6%、极薄或宽高比 < 1.5）不参与。
    - **双栏 / 双页合一**（2026-11-05）：长行只落在右栏时，上面的横向分位会只框右栏
      （真机 H6GXVG p14 把左栏的回目扔出版心）。所以先用 `column_gutter` 判栏缝：
      内部有 ≥8% 页宽的空带 ⇒ 双栏，左右界取两侧最外沿；没有 ⇒ 单栏，行为不变。
      **必须在剔完页边重复行之后再判**（书眉会伪造"左栏有内容"，或把栏缝桥掉）。
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

    bodies = [
        _expand_line(line, AUTO_PADDING)
        for line in parsed
        if _looks_like_text_line(line)
    ]

    # 双栏 / 双页合一（2026-11-05）：长行只落在右栏时，横向 5%/95% 分位会把左栏整个丢掉
    # （真机 H6GXVG p14：框 x0≈0.51，左栏的回目被判在版心外、导出里消失）。
    # 判据用**栏缝**（见 column_gutter）+ 两侧最外沿；单栏页走不到这里，行为不变。
    gutter = column_gutter(parsed)
    if gutter is not None:
        split = (gutter[0] + gutter[1]) / 2
        left_edges = [line[0] for line in bodies if (line[0] + line[2]) / 2 < split]
        right_edges = [line[2] for line in bodies if (line[0] + line[2]) / 2 >= split]
        if left_edges and right_edges:
            box[0] = min(left_edges)
            box[2] = max(right_edges)

    # 纵向取界（2026-11-05，真机 p61）：**同一栏内的所有非家具行都并进来**。
    # 原来靠"逐行够得着"扩张，对"隔得远但同属一栏"的短行天然无解：p61 的「小结」标题
    # 与第一行长行隔了 1.7 个行高，够不着 ⇒ 框从第一行长行才开始（y0=0.2285），
    # 标题被扔到版心外。修之前是页眉把框顶上去、顺带盖住了标题，所以没暴露。
    # 栏 = 上面长行（valid）的 x 范围（双栏页已被栏缝拓宽成"两栏都包"）；
    # 页眉 / 页脚在拟合前已按页边重复剔掉，竖排旁批不算"像一行字"，都不会被并进来。
    in_column: list[BBox] = []
    for line in bodies:
        if min(line[2], box[2]) - max(line[0], box[0]) <= 0:
            continue          # 与栏没有横向重叠：旁批 / 页边注 / 另一个栏
        in_column.append(line)
    if in_column:
        box[1] = min(box[1], min(line[1] for line in in_column))
        box[3] = max(box[3], max(line[3] for line in in_column))
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


#: 剔除页边重复行之后，仍允许落在框外的正文行数下限（拟合本来就会留一两行）；
#: 超过就说明"剔完拟出来的框盖不住正文"，改用"全行拟合 + 切掉页边带"。
FURNITURE_COVERAGE_SLACK = 2
#: 从框上切掉页边带时留的余量（归一化）：别让书眉行框外沿正好压在框线上。
FURNITURE_CUT_PAD = 0.002


def fit_page_margin_box(
    lines: Sequence[Sequence[float]],
    *,
    rects: Sequence[Sequence[float]] | None = None,
) -> FittedMargin:
    """一页的版心：先拟合；拟合不出来就退本页所有检测行的包围盒。

    **绝不回退全局版心**（任务 33）：全局框对这本书根本不成立，退过去就等于
    在"按版心判定"打开时把正文从两头切掉。本页连一条检测行都没有时标"未定"，
    不参与版心判定（导出预检会报"版心未定 N 页"）。

    ``rects``（可选）= 这一页的**页边重复排除矩形**（书眉 / 页脚 / 页码）：
    先剔掉再拟合（2026-11-05 真机 p98：页眉宽 0.402 不参与长行起步，却被后面
    "够得着就并进来"那一轮吸进版心）。剔完还要**验覆盖**：真机 p221 是表格页，
    剔掉书眉后长行起点全落在下半页，拟出来的框从 y0=0.53 才开始，把整张表扔在框外。
    那种情况退回"用全部行拟合，再把页边带从框上切掉"——框仍然盖住正文，书眉在框外。
    """
    parsed = [box for box in (_parse_box(raw) for raw in lines) if box is not None]
    result = _fit_parsed_lines(parsed)
    if not rects or not parsed or result.undetermined:
        return result
    cleaned = strip_furniture_lines(parsed, rects)
    if len(cleaned) == len(parsed):
        return result                     # 这一页没有页边重复行（或护栏放弃剔除）
    tight = _fit_parsed_lines(cleaned)
    if not tight.undetermined and _covers_body_lines(cleaned, tight.box):
        return tight
    if result.box is not None:
        cut = _cut_furniture_rects(result.box, rects)
        if cut is not None and _covers_body_lines(cleaned, cut):
            return FittedMargin(cut, result.method, result.lines, result.long_lines)
    # 切不出来（矩形横跨整个框 / 切完盖不住正文）：宁可窄一点的 tight，也不用旧框
    return tight


def _fit_parsed_lines(parsed: Sequence[BBox]) -> FittedMargin:
    """`fit_page_margin_box` 的拟合本体（输入已经是解析好的行框）。"""
    bodies = [box for box in parsed if _looks_like_text_line(box)]
    long_lines = [box for box in bodies if box[2] - box[0] > AUTO_LONG_LINE]
    fitted = fit_box_from_lines(parsed)
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


def _covers_body_lines(parsed: Sequence[BBox], box: Sequence[float]) -> bool:
    """剔完页边带之后，拟出来的框还盖不盖得住正文行（判据：多数文字行的中心在框内）。

    为什么不要求"全部在框内"：拟合本身就会把个别竖排旁批 / 图注留在框外，那种页
    不该因此退回旧框。允许 ``FURNITURE_COVERAGE_SLACK`` 行（且不少于 2%）。
    """
    candidates = [line for line in parsed if _looks_like_text_line(line)]
    if not candidates:
        return True
    outside = 0
    for line in candidates:
        cx = (line[0] + line[2]) / 2
        cy = (line[1] + line[3]) / 2
        if not (box[0] <= cx <= box[2] and box[1] <= cy <= box[3]):
            outside += 1
    limit = max(FURNITURE_COVERAGE_SLACK, int(len(candidates) * 0.02))
    return outside <= limit


def _cut_furniture_rects(
    box: Sequence[float], rects: Sequence[Sequence[float]]
) -> BBox | None:
    """把页边重复矩形从框上**切掉**：沿"矩形中心离哪条框边最近"的那个方向内收。

    只用来兜底（见 `fit_page_margin_box`）：切完必须让每个矩形的中心都在框外，
    否则返回 None（宁可不用这个框，也不要留一半页眉在框里）。
    """
    x0, y0, x1, y1 = (float(value) for value in box)
    for rect in rects:
        cx = (rect[0] + rect[2]) / 2
        cy = (rect[1] + rect[3]) / 2
        if not (x0 <= cx <= x1 and y0 <= cy <= y1):
            continue                       # 这个矩形已经在框外
        width = max(x1 - x0, 1e-9)
        height = max(y1 - y0, 1e-9)
        options = [
            ((cy - y0) / height, "top", min(1.0, rect[3] + FURNITURE_CUT_PAD)),
            ((y1 - cy) / height, "bottom", max(0.0, rect[1] - FURNITURE_CUT_PAD)),
            ((cx - x0) / width, "left", min(1.0, rect[2] + FURNITURE_CUT_PAD)),
            ((x1 - cx) / width, "right", max(0.0, rect[0] - FURNITURE_CUT_PAD)),
        ]
        _, edge, value = min(options, key=lambda item: item[0])
        if edge == "top":
            y0 = max(y0, value)
        elif edge == "bottom":
            y1 = min(y1, value)
        elif edge == "left":
            x0 = max(x0, value)
        else:
            x1 = min(x1, value)
    try:
        cut = normalize_margin_box((x0, y0, x1, y1))
    except (ValueError, MarginBoxError):
        return None
    for rect in rects:
        cx = (rect[0] + rect[2]) / 2
        cy = (rect[1] + rect[3]) / 2
        if cut[0] <= cx <= cut[2] and cut[1] <= cy <= cut[3]:
            return None                    # 还有页边带留在框里，不用这个框
    return cut


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

    这里给的是**原始行框**（两条路径：OCR 行 / 检测行）；页边重复行（书眉 / 页脚 /
    页码）在 `fit_page_margin_box` 里剔——那里才知道"剔完的框还盖不盖得住正文"。

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


# ---------------------------------------------------------------- 页边重复行的剔除（2026-11-05）
#: 一页上被剔掉的行占全部行的比例上限。超过就认为"候选把正文吃进去了"：
#: 整页放弃剔除（宁可回到旧行为，也不能把正文行剔光、把版心缩成一条）。
FURNITURE_EXCLUDE_MAX_SHARE = 0.30


def strip_furniture_lines(
    boxes: Sequence[Sequence[float]],
    rects: Sequence[Sequence[float]] | None,
    *,
    page_no: int | None = None,
) -> list[BBox]:
    """剔掉**行中心落在页边重复矩形里**的行（纯函数，不读写数据库）。

    只剔"候选清单已经算出来的重复页边行"（书眉 / 页脚 / 页码）；**不按短行 / 长行剔**——
    按长短剔会把诗行、章节末行一起吃掉（这是 `furniture_candidates` 里那条防误判的同一理由）。
    没有候选的页（`rects` 为空）原样返回，行为与改动前一致。

    护栏：一页被剔的行超过 ``FURNITURE_EXCLUDE_MAX_SHARE`` ⇒ 整页放弃剔除并记一条日志
    （说明候选把正文吃进去了，宁可保留那句错误的页眉，也不能把正文剔掉）。
    """
    if not rects or not boxes:
        return list(boxes)
    kept: list[BBox] = []
    for raw in boxes:
        box = _parse_box(raw)
        if box is None:
            continue
        cx = (box[0] + box[2]) / 2
        cy = (box[1] + box[3]) / 2
        if any(
            rect[0] <= cx <= rect[2] and rect[1] <= cy <= rect[3] for rect in rects
        ):
            continue
        kept.append(box)
    removed = len(boxes) - len(kept)
    if removed and removed > len(boxes) * FURNITURE_EXCLUDE_MAX_SHARE:
        _LOG.info(
            "版心拟合：第 %s 页 %d 行里有 %d 行落在页边重复带内（>%.0f%%），放弃剔除",
            page_no if page_no is not None else "?",
            len(boxes),
            removed,
            FURNITURE_EXCLUDE_MAX_SHARE * 100,
        )
        return list(boxes)
    return kept


def _furniture_bands_for(project_id: str, *, library: Path | None) -> dict:
    """现算"页眉 / 页脚位置带"；算不出来就返回空字典（= 与改动前行为一致）。"""
    try:
        return furniture_candidates.parity_bands(project_id, library=library)
    except Exception as exc:  # noqa: BLE001 - 见 _page_exclusions_for：降级 + 日志
        _LOG.warning("页边重复位置带算不出来，这一轮不按位置剔页眉：%s", exc)
        return {}


def drop_furniture_zone_lines(
    boxes: Sequence[BBox], *, parity: str, bands: Mapping[tuple[str, str], Sequence[float]] | None
) -> list[BBox]:
    """剔掉落在**同奇偶页的页眉 / 页脚位置带**里的短行（纯函数，不读写数据库）。

    为什么需要它：真机 `b2t_YR5EJ0` p29 的页眉被 OCR 读成「论21」，模板对不上任何候选，
    于是它既不在排除矩形里、又会把版心顶到 y0=0.066。但它的位置（y 0.066–0.084）正好在
    奇数页页眉带里——位置带由**其它奇数页**的候选给出，这一页自己读花了也照样剔得掉。

    只剔**短行**（宽 ≤ `AUTO_LONG_LINE`）：正文偶尔从页边带开始，宽行是正文不是页眉；
    标题变长（如整句）时也不该被位置带误伤。没有位置带的（没有候选）原样返回。
    """
    if not bands or not boxes:
        return list(boxes)
    zones = [rect for (band, side), rect in bands.items() if side == parity]
    if not zones:
        return list(boxes)
    kept: list[BBox] = []
    for raw in boxes:
        box = _parse_box(raw)
        if box is None:
            continue
        if box[2] - box[0] > AUTO_LONG_LINE:
            kept.append(box)
            continue
        cx = (box[0] + box[2]) / 2
        cy = (box[1] + box[3]) / 2
        if any(rect[0] <= cx <= rect[2] and rect[1] <= cy <= rect[3] for rect in zones):
            continue
        kept.append(box)
    return kept


def _page_exclusions_for(project_id: str, *, library: Path | None) -> dict[int, list[BBox]]:
    """现算每页的页边重复排除矩形；算不出来就返回空字典（= 与改动前行为一致）。

    算不出来（候选模块抛错 / 老库结构不齐）不能让版心生成失败：版心是后续判定的输入，
    为了"更准的顶边"把整步打死是不划算的。降级要留痕，不静默。
    """
    try:
        return furniture_candidates.page_exclusions(project_id, library=library)
    except Exception as exc:  # noqa: BLE001 - 见上：降级 + 日志，不吞成"成功"
        _LOG.warning("页边重复候选算不出来，这一轮不剔除页眉页脚：%s", exc)
        return {}



def _record_custom_override(conn, page, box, *, now: str) -> None:
    """手工页的框被自动生成覆盖时留一条 event（旧框 / 新框 / 页号 / 原因）。

    为什么必须留痕：`custom` 的框是用户一格格拖出来的，覆盖是不可逆的（没有撤销栈
    存到库里）。事后要能回答"我手调的框没了，是哪一次、被什么替了"。
    """
    before = {
        "page_no": page.page_no,
        "margin_box": list(page.margin_box) if page.margin_box else None,
        "margin_box_mode": page.margin_box_mode,
    }
    after = {
        "page_no": page.page_no,
        "margin_box": list(box) if box else None,
        "margin_box_mode": page.margin_box_mode,
        "reason": "识别版心含手工页",
    }
    conn.execute(
        """
        INSERT INTO event (event_id, batch_id, entity_type, entity_id, action,
                           before_json, after_json, actor, actor_name, package_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            new_ulid(),
            new_ulid(),
            "page",
            page.page_id,
            "margin_fit_override",
            json.dumps(before, ensure_ascii=False),
            json.dumps(after, ensure_ascii=False),
            "user",
            None,
            None,
            now,
        ),
    )


def fit_page_margin(
    project_id: str,
    page_no: int,
    *,
    library: Path | None = None,
    only_auto: bool = True,
    allow_custom: bool = False,
    exclusions: Mapping[int, Sequence[Sequence[float]]] | None = None,
    bands: Mapping[tuple[str, str], Sequence[float]] | None = None,
) -> dict[str, object]:
    """用这一页的**行框**拟合版心，写回 `page.margin_box` + `margin_box_method`。

    - **不覆盖 custom**；`none` 也不动；
    - 行框来源：检测行优先（`page_layout_line`），没有检测行就回退**识别行**
      （`block_line`，刀 1）——识别行就是同一套行框，不必为了版心先等一遍检测；
    - 拟合不出（有效长行 < 3）→ 退**本页所有行的包围盒**（method=`bbox`）；
    - 一条行都没有 → `margin_box = NULL` + method=NULL（**未定**），
      读取时**不回退全局框**，也不参与版心判定；本页连文字都没有时另报 `no_text`；
    - 重检测 / 重新拟合时覆盖上一次的结果（界面、导出、审计读同一份）；
    - ``allow_custom=True``（2026-11-05，界面勾了「包括手工调整的页」）：**只改框**，
      `margin_box_mode` 仍是 `custom`——用户手调过的页在自动生成之后不能被当成
      "自动拟合"的页（否则下次看会以为是机器定的）。覆盖前后写一条 event 留痕。
    - ``exclusions``：每页的页边重复排除矩形（`furniture_candidates.page_exclusions`）。
      不传就现算**一次**（单页调用不划算，但保证行为与批量拟合一致）；批量调用方
      必须传，否则每页都重算一遍候选。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    page = next((item for item in pages if item.page_no == page_no), None)
    if page is None:
        raise library_module.ProjectError(f"没有第 {page_no} 页")
    if page.margin_box_mode == MODE_NONE or (
        page.margin_box_mode == MODE_CUSTOM and not allow_custom
    ):
        return {"page_no": page_no, "updated": False, "reason": "custom_or_none"}
    override_custom = allow_custom and page.margin_box_mode == MODE_CUSTOM
    if only_auto and page.margin_box_mode != MODE_AUTO and not override_custom:
        return {"page_no": page_no, "updated": False, "reason": "not_auto"}
    if exclusions is None:
        exclusions = _page_exclusions_for(project_id, library=target_library)
    if bands is None:
        bands = _furniture_bands_for(project_id, library=target_library)
    boxes, source, has_text, recognized = _page_fit_lines(
        directory, project_id, page, library=target_library
    )
    boxes = drop_furniture_zone_lines(
        boxes,
        parity="even" if page.page_no % 2 == 0 else "odd",
        bands=bands,
    )
    # 页边重复行（书眉 / 页脚 / 页码）在这一步剔：只有这里能同时看到"原始行"
    # 与"剔完还盖不盖得住正文"，见 fit_page_margin_box 的注释。
    fitted = fit_page_margin_box(boxes, rects=(exclusions or {}).get(page.page_no))
    method = None if fitted.undetermined else fitted.method
    # 「无文字」不等于「还没识别」（刀 1）：识别跑过、结果整页没有字（插图 / 空白）才算
    # 无文字，跳过；从没识别过的页是未定，不能拿"无文字"把它放过去。
    no_text = bool(fitted.undetermined and not has_text and recognized)
    now = _now()
    with db_module.open_database(directory) as conn:
        if override_custom:
            conn.execute(
                "UPDATE page SET margin_box = ?, margin_box_method = ? WHERE page_id = ?",
                (serialize_margin_box(fitted.box), method, page.page_id),
            )
            _record_custom_override(conn, page, fitted.box, now=now)
        else:
            conn.execute(
                "UPDATE page SET margin_box = ?, margin_box_method = ?"
                " WHERE page_id = ? AND margin_box_mode IN ('auto','inherit')",
                (serialize_margin_box(fitted.box), method, page.page_id),
            )
        # 迁移 0025：记下"这本书真的生成过版心"。没有它，"从没开始"与"跑过但全失败"
        # 在数据上都是"没有框"，界面只能靠猜（见 marginStepVerdict 的「未开始」）。
        conn.execute(
            "UPDATE project SET margin_fit_at = ?, updated_at = ?", (now, now)
        )
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
    page_nos: Sequence[int] | None = None,
    include_custom: bool = False,
) -> dict[str, object]:
    """把 inherit / auto 的页全部改为每页自动拟合；custom / none 不动。

    任务 36B 追加两个只影响"做多少"的参数，默认值保持旧行为：

    - ``only_missing=True``：只处理 ``mode=auto`` 且 ``margin_box`` 仍是 NULL 的页
      （界面「全局识别」）。``inherit`` 是用户显式选择沿用默认框，
      这一类也不碰——自动补拟合不该改变它。非正文页（``include=False``）也不在
      自动补拟合的范围里：它们不参与版心判定，算进分母会让步骤条永远绿不了。
    - ``limit``：这一轮最多处理多少页；``remaining`` 回传**这一轮里**还有多少页没轮到。
      **``limit`` 不是游标**：它只截取目标列表的前 N 页，不记录"上次做到哪"。所以
      只有 ``only_missing=True`` 时才能靠 ``remaining`` 驱动循环（补完的页会从"缺框"里
      消失）；``only_missing=False`` 时每次调用都会重新处理同一批前 N 页、``remaining``
      恒等于 ``total - limit`` —— 跨批调用**必须自己传 ``page_nos``**（界面就是这么做的），
      否则会一遍遍重做同一批。
    - ``body_only=True``（2026-11-05，界面「重新识别」）：只处理正文页。重跑全书时
      非正文页（封面 / 目录 / 空白）不该跟着重算——它们的框不进任何判定。
    - ``page_nos``（2026-11-05，选中若干页后重跑）：只处理这些页；空 / None = 全书。
    - ``include_custom=True``（界面勾了「包括手工调整的页」）：``custom`` 页也重新生成，
      但**只改框**，``margin_box_mode`` 仍是 ``custom``；每次覆盖写一条 event 留痕。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    selected = set(page_nos) if page_nos else None
    skipped_custom = skipped_none = skipped_inherit = skipped_fitted = 0
    skipped_not_body = 0
    targets: list[library_module.Page] = []
    for page in pages:
        if selected is not None and page.page_no not in selected:
            continue
        custom = page.margin_box_mode == MODE_CUSTOM
        if custom and not include_custom:
            skipped_custom += 1
            continue
        if page.margin_box_mode == MODE_NONE:
            skipped_none += 1
            continue
        if (only_missing or body_only) and not page.include:
            skipped_not_body += 1
            continue
        # 勾了「包括手工调整的页」时，custom 页即使在 only_missing 模式下也要处理：
        # 那一轮的意思就是"这些手工页也重生成"，不能被"只补缺框"的守卫吞掉
        # （否则确认窗上的「仍要覆盖 M 页」点了什么都不会发生）。
        if only_missing and not (custom and include_custom):
            if page.margin_box_mode != MODE_AUTO:
                skipped_inherit += 1
                continue
            if page.margin_box is not None:
                skipped_fitted += 1
                continue
        targets.append(page)
    batch = targets[:limit] if limit is not None else targets
    remaining = len(targets) - len(batch)
    # 页边重复（书眉 / 页脚 / 页码）的排除矩形：**一次算好、逐页复用**。
    # 放在循环外是因为候选要扫全书的块与行；每页重算一次会让 662 页的书卡住。
    exclusions = _page_exclusions_for(project_id, library=target_library) if batch else {}
    bands = _furniture_bands_for(project_id, library=target_library) if batch else {}
    updated = fitted = fallback = undetermined = no_text = 0
    for page in batch:
        if page.margin_box_mode == MODE_INHERIT:
            with db_module.open_database(directory) as conn:
                conn.execute(
                    "UPDATE page SET margin_box_mode = 'auto' WHERE page_id = ?",
                    (page.page_id,),
                )
                conn.commit()
        result = fit_page_margin(
            project_id,
            page.page_no,
            library=target_library,
            allow_custom=include_custom,
            exclusions=exclusions,
            bands=bands,
        )
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
