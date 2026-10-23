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

1. 只看正文页（``include = 1``）里**有行坐标**的块；显式标注为
   ``header / footer / page_number / figure / decoration`` 的块整块跳过。
   其余块按**几何**判断（OCR 出来的块类型常常全是 ``paragraph``，不能只靠类型）。
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

# 页级三态
MODE_INHERIT = "inherit"
MODE_CUSTOM = "custom"
MODE_NONE = "none"
MARGIN_BOX_MODES = (MODE_INHERIT, MODE_CUSTOM, MODE_NONE)

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
    """这一页实际生效的版心：none → 无；custom → 本页；inherit → 项目默认。"""
    if page.margin_box_mode == MODE_NONE:
        return None
    if page.margin_box_mode == MODE_CUSTOM:
        return page.margin_box
    return project.margin_box


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
        notes=("还没有可用的识别行：先识别几页正文再推算。",),
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

def suggest_margin_box(
    project_id: str, *, library: Path | None = None
) -> MarginSuggestion:
    """读项目里已有的 `block_line`，跨页推算版心。**只读，不写库。**"""
    target_library = library if library is not None else library_module.default_library_dir()
    pages = library_module.list_pages(project_id, library=target_library)
    page_by_id = {page.page_id: page for page in pages}
    # 只统计正文页；"不适用版心"的页（整页插图等）不参与，否则会把边缘拉歪
    candidates = {
        page.page_id
        for page in pages
        if page.include and page.margin_box_mode != MODE_NONE
    }

    blocks = blocks_module.list_blocks(project_id, library=target_library)
    active_block = {
        block.block_id: block
        for block in blocks
        if block.page_id in candidates and block.block_type not in SKIP_BLOCK_TYPES
    }
    lines = blocks_module.list_block_lines(project_id, library=target_library)

    page_boxes: dict[int, list[BBox]] = {}
    for line in lines:
        block = active_block.get(line.block_id)
        if block is None or line.bbox is None:
            continue
        page = page_by_id.get(block.page_id)
        if page is None:
            continue
        page_boxes.setdefault(page.page_no, []).append(line.bbox)

    return suggest_from_page_boxes(page_boxes)


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
    """算一次版心并把结果写进项目（识别收尾 / 打开老项目时调用）。

    - **总是**更新 `margin_box_suggestion`（"建议"是只读参考，任何人都可以看）；
    - 只在 `can_auto_write` 为真时把建议写进 `margin_box`，并把来源标成 ``auto``；
    - 已经有手动版心时**只更新建议、不动当前值**。

    一次识别任务只在收尾调用一次（不是每页一次），避免识别过程中框来回跳。
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
            if page.margin_box_mode != MODE_INHERIT
        ],
    }
