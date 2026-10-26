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
COVERAGE_HIGH = 0.30
COVERAGE_MIN = 0.20

# 推算结果向外让 2% 页宽：OCR 的边缘有千分位抖动，直接贴着众数会切到个别页的字。
# 这只是**建议框**的安全边距；用户拖动时会吸附到真正的行边界。
EDGE_PADDING = 0.02

# 版心最短边：再小就没有"正文区"的意义了（防止拖成一条线 / 手滑输入 0）
MIN_MARGIN_SIDE = 0.02

# 显式版面块：不参与推算（与 export/streams.py 的边缘判断同一类证据）
SKIP_BLOCK_TYPES = frozenset(
    {"header", "footer", "page_number", "figure", "decoration"}
)

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
    - ``auto``：本页拟合四边；还没有拟合结果时回退全局兜底；
    - ``inherit``：显式沿用全局兜底。
    """
    if page.margin_box_mode == MODE_NONE:
        return None
    if page.margin_box_mode == MODE_CUSTOM:
        return page.margin_box
    if page.margin_box_mode == MODE_AUTO:
        return page.margin_box or project.margin_box
    return project.margin_box


def page_margin_source_label(
    project: library_module.Project, page: library_module.Page
) -> str:
    """页级版心来源（界面文案）。"""
    if page.margin_box_mode == MODE_NONE:
        return "不适用"
    if page.margin_box_mode == MODE_CUSTOM:
        return "本页自定义"
    if page.margin_box_mode == MODE_AUTO:
        return "自动拟合" if page.margin_box else "沿用默认版心（行不足）"
    return "沿用默认版心"


def margin_box_for_export(
    project: library_module.Project, page: library_module.Page
) -> BBox | None:
    """导出仍沿用旧口径：auto 页不把拟合框带进导出，避免改变既有导出结果。

    这是任务 62 的明确边界：页面 / 审校用每页拟合；导出开关保持默认关，
    开关关闭时结果必须与升级前逐字节相同。将来若要导出按页版心，需要单独决策。
    """
    return export_margin_box(project, page)


def export_margin_box(
    project: library_module.Project, page: library_module.Page
) -> BBox | None:
    """**导出**用的版心（任务 53 的安全阀）。

    与 `effective_margin_box` 的区别只有一处：全局版心是**自动推算**
    （``margin_box_source == "auto"``）且这一页「沿用全局」时，导出**不认**它，退回块类型判定。

    为什么：自动推算随识别页增加会小幅移动（见 docs/development-log.md 任务 53 的实测），
    而版心在导出里是"正文 = 版心内"的硬判据——一个还没人确认过的框不该决定哪些字进正文。
    自动框只用于**显示与审校过滤**；用户在页面视图点「采用为全局版心」之后
    （source 变成 manual）导出才按它判定。这样"这一刀不改导出"对所有既有项目成立。
    """
    if page.margin_box_mode == MODE_NONE:
        return None
    if page.margin_box_mode == MODE_CUSTOM:
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
    worst = max(stat.spread for stat in edges.values())
    coverage = min(left_coverage, right_coverage)
    reliable = (
        participating >= MIN_PAGES
        and worst <= SPREAD_UNRELIABLE
        and coverage >= COVERAGE_MIN
    )
    if participating < MIN_PAGES:
        notes.append(
            f"只有 {participating} 页有可用的行数据（少于 {MIN_PAGES} 页），建议不可靠。"
        )
    if worst > SPREAD_MEDIUM:
        notes.append(
            f"边缘离散较大（最大 {worst:.1%} 页宽），建议不可靠：可能是双栏、竖排或旁批较多。"
        )
    if coverage < COVERAGE_MIN:
        notes.append(
            f"左右的边缘只覆盖 {coverage:.0%} 的正文行，建议不可靠：各页的缩进 / 分栏可能不一致。"
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
    ):
        confidence = CONFIDENCE_HIGH
    elif worst <= SPREAD_MEDIUM:
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

    ocr_page_boxes: dict[int, list[BBox]] = {}
    for line in lines:
        block = active_block.get(line.block_id)
        if block is None or line.bbox is None:
            continue
        page = page_by_id.get(block.page_id)
        if page is None:
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
AUTO_SAFETY_GAP = 0.034
AUTO_SAFETY_PASSES = 3


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


def fit_box_from_lines(lines: Sequence[Sequence[float]]) -> BBox | None:
    """用一页的检测行拟合版心（纯函数）。

    - 只保留宽度 > 45% 页宽的正文长行；
    - 每行先按**行框自身**外扩 2%；
    - 左 / 右 / 上 / 下分别取 5% / 95% 分位；
    - 有效行 < 3 或结果不合法 → None（调用方回退全局兜底）。
    """
    valid: list[BBox] = []
    for raw in lines:
        box = _parse_box(raw)
        if box is None:
            continue
        if box[2] - box[0] <= AUTO_LONG_LINE:
            continue
        valid.append(_expand_line(box, AUTO_PADDING))
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
    try:
        return normalize_margin_box(box)
    except MarginBoxError:
        return None


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


def fit_page_margin(
    project_id: str,
    page_no: int,
    *,
    library: Path | None = None,
    only_auto: bool = True,
) -> dict[str, object]:
    """用这一页的检测行拟合版心，写回 `page.margin_box`（只更新 auto 页）。

    - **不覆盖 custom**；`none` 也不动；
    - 有效行 < 3 → `margin_box = NULL`，读取时回退全局兜底；
    - 重检测后再次调用会覆盖上一次的自动拟合结果。
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
    boxes = _latest_layout_boxes(directory, page.page_id)
    fitted = fit_box_from_lines(boxes)
    with db_module.open_database(directory) as conn:
        conn.execute(
            "UPDATE page SET margin_box = ? WHERE page_id = ? AND margin_box_mode IN ('auto','inherit')",
            (serialize_margin_box(fitted), page.page_id),
        )
        conn.execute("UPDATE project SET updated_at = ?", (_now(),))
        conn.commit()
    return {
        "page_no": page_no,
        "updated": True,
        "margin_box": list(fitted) if fitted else None,
        "fallback": fitted is None,
        "lines": len(boxes),
    }


def fit_all_pages(project_id: str, *, library: Path | None = None) -> dict[str, object]:
    """把 inherit / auto 的页全部改为每页自动拟合；custom / none 不动。"""
    target_library = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    updated = fitted = fallback = 0
    skipped_custom = skipped_none = 0
    for page in pages:
        if page.margin_box_mode == MODE_CUSTOM:
            skipped_custom += 1
            continue
        if page.margin_box_mode == MODE_NONE:
            skipped_none += 1
            continue
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
            if result.get("fallback"):
                fallback += 1
            else:
                fitted += 1
    return {
        "updated": updated,
        "fitted": fitted,
        "fallback": fallback,
        "skipped_custom": skipped_custom,
        "skipped_none": skipped_none,
    }


def page_margin_audit(
    project_id: str, page_no: int, *, library: Path | None = None
) -> dict[str, object]:
    """这一页有多少"正文长行"落在**该页自己的**生效版心之外（可疑提示用）。"""
    target_library = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    page = next((item for item in pages if item.page_no == page_no), None)
    if page is None:
        raise library_module.ProjectError(f"没有第 {page_no} 页")
    project = library_module.load_project(project_id, library=target_library)
    box = effective_margin_box(project, page)
    boxes = _latest_layout_boxes(directory, page.page_id)
    long_lines = [
        b for b in boxes if b[2] - b[0] > AUTO_LONG_LINE
    ]
    if box is None:
        return {"page_no": page_no, "total_lines": len(long_lines), "outside": 0, "samples": []}
    outside = []
    for b in long_lines:
        cx = (b[0] + b[2]) / 2
        cy = (b[1] + b[3]) / 2
        if not (box[0] <= cx <= box[2] and box[1] <= cy <= box[3]):
            outside.append(list(b))
    return {
        "page_no": page_no,
        "total_lines": len(long_lines),
        "outside": len(outside),
        "samples": outside[:5],
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
            "UPDATE page SET margin_box = ?, margin_box_mode = ? WHERE page_id = ?",
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
    """批量设置版心三态（整批一个事务；有一页不存在就整批拒绝）。

    `custom` 时所有选中页用**同一个**四边（界面上的"设为自定义"就是复制当前版心）；
    想逐页微调再拖框。
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
        conn.execute(
            f"UPDATE page SET margin_box = ?, margin_box_mode = ? WHERE page_no IN ({condition})",
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
