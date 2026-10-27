"""按版心判定正文（任务 51）。

用户 2026-10-23 拍板的口径：**正文 = 版心内**；版心外一律不进正文。
这是导出的**主判据**；块类型降级为两类用途：

1. **结构信息**：`heading` / `paragraph` 仍然是标题层级与段类型的来源；
2. **人工显式例外**：即使中心落在版心内，`footnote` / `margin_note` / `figure` /
   `decoration` / `caption` / `header` / `footer` / `page_number` 也不进正文
   （用户补的口径：《导读巴赫金》的脚注就印在版心内）。

**两层判定**（预检里分开报数，用户能看出是哪一层在起作用）：

- 第一层（版心）：块**中心点**落在版心外 → 非正文。页眉 / 页脚 / 页码按此处理。
  用中心点而不是"完全包含"：一个块跨过版心边界时，完全包含会把正文块也排除；
  中心点是"这一块主要在哪边"的稳定近似，且与用户在版心视图里看到的框一致。
  **例外（刀 0，2026-10-27）**：版心只用来排除"列外 / 上下边带"的家具，不删文字列
  里的字——块的 x 范围与版心的 x 范围有重叠、且中心不在上下 8% 边带里时，即使中心
  在框外也留在正文（计入异常页）；`heading` / `title` 无条件保留。书眉（顶带）、
  页码（列外）仍然排除。原因：拟合框天然只包连续正文长行，章首 / 节标题在其上方、
  间距更大，收不进来；纯中心判定会把它们静默删掉（《导读巴赫金》267 页实测 30 个
  标题块，导出后少约 195 字，而当时的审计报 0 页异常）。
- 第二层（类型）：中心在版心内，但类型是脚注 / 旁批 / 插图 / 装饰 / 图注等 → 非正文。
  脚注与旁批进注释流（用户勾"同时导出注释"时），其余只作结构信息。

**页码**：版心外、且在页面上下 8% 边带里的数字。先看整块是否纯数字 / 罗马数字；
混合文本（书眉 `2 谁是巴赫金? 11`）只接受**与 PDF 印刷页码 `page_label` 一致**的候选——
不靠"第几个数字"猜；多个不同候选就是 null。

**缺省退回**：页级 `margin_box_mode = none`（整页插图 / 特殊版式）按"整页都是正文"处理
（不做版心排除，仍按块类型）；项目没设版心 / 页面沿用却没有全局版心时，也退回块类型判定。
开关关掉时整个模块不参与，行为与以前完全一致。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from ..project import margin_box as margin_box_module
from ..project.library import Page
from ..structure.regions import page_number_candidates
from . import segments as segments_module
from . import streams as streams_module

MODE_NONE = margin_box_module.MODE_NONE

# 页面上下边带（与 `streams.EDGE_TOP / EDGE_BOTTOM` 同口径）
PAGE_NUMBER_EDGE_BAND = 0.08

# 版心不删文字列里的字（刀 0）：块的 x 与版心 x 有重叠、且中心不在这条边带里就保留。
RESCUE_EDGE_BAND = PAGE_NUMBER_EDGE_BAND
# 标题无条件保留：章首 / 节标题常在正文块上方、间距更大，拟合框收不进来。
ALWAYS_KEEP_TYPES = frozenset({
    segments_module.BLOCK_TYPE_HEADING,
    "title",  # 早期数据 / 外部导入可能用 title 表示标题
})

NOTE_TYPES = frozenset({
    segments_module.BLOCK_TYPE_FOOTNOTE,
    segments_module.BLOCK_TYPE_MARGIN_NOTE,
})
NON_TEXT_TYPES = frozenset({
    segments_module.BLOCK_TYPE_FIGURE,
    segments_module.BLOCK_TYPE_DECORATION,
})


@dataclass(frozen=True)
class PageMarginLayout:
    """一页的两层判定结果（纯数据，测试不必建整本书）。"""

    page_no: int
    margin_box: tuple[float, float, float, float] | None
    margin_box_mode: str
    # 是否真的用版心筛了（开关开 + 有框 + 不是 none）
    applied: bool
    # 开关开、但这一页没有生效版心（项目没设 / 页面沿用却没全局）：退回块类型判定
    unset: bool
    inside_ids: frozenset[str]
    outside_ids: frozenset[str]
    # 页码候选（可能是版心外的纯数字，也可能是显式 page_number 块）
    page_number_values: Mapping[str, str]
    note_ids: frozenset[str]
    note_inside_ids: frozenset[str]
    # 中心在框外、但按刀 0 的例外留在正文的块（文字列内 / 标题）：**异常页的依据**，
    # 导出保留它们，界面与预检要列出来让用户看。
    rescued_ids: frozenset[str] = frozenset()

    @property
    def page_number_ids(self) -> frozenset[str]:
        return frozenset(self.page_number_values)

    @property
    def counts(self) -> dict[str, int]:
        """块数统计：inside + outside = 总块数；page_number 是其中的标记数（可重叠）。"""
        return {
            "inside": len(self.inside_ids),
            "outside": len(self.outside_ids),
            "rescued": len(self.rescued_ids),
            "page_number": len(self.page_number_values),
        }


# 这两个判断搬到了 `core/project/margin_box.py`，审校与导出共用同一份实现；
# 这里保留同名导入，`classify_page` 与既有测试都继续按原名使用。
block_center = margin_box_module.block_center
center_inside = margin_box_module.center_inside


def _page_label_value(page: Page) -> str | None:
    return streams_module.page_value(page.page_label or "")


def _page_number_value(block, page: Page, *, applied: bool) -> str | None:
    """一个块能确定出的页码值；确定不了就 None（不猜）。

    - 显式 `page_number` 块：纯数字 / 罗马数字直接用；混合文本只认与 `page_label` 一致的那个。
    - 版心外、上下边带里的块：先看整块是否纯数字 / 罗马数字；混合文本同样只认 `page_label`。
    """
    text = block.text or ""
    direct = streams_module.page_value(text)
    if direct is not None:
        return direct

    # 混合文本（书眉 + 页码）：只有和 PDF 印刷页码一致才采信，不按位置猜第几个数字
    if not applied:
        return None
    label = _page_label_value(page)
    if label is None:
        return None
    for candidate in page_number_candidates(text):
        value = candidate.text.upper() if candidate.kind == "roman" else candidate.text
        if value == label:
            return value
    return None


def _in_edge_band(center: tuple[float, float] | None) -> bool:
    if center is None:
        return False
    return center[1] <= PAGE_NUMBER_EDGE_BAND or center[1] >= 1 - PAGE_NUMBER_EDGE_BAND


def _bbox_tuple(raw) -> tuple[float, float, float, float] | None:
    if raw is None:
        return None
    try:
        values = tuple(float(value) for value in raw)
    except (TypeError, ValueError):
        return None
    if len(values) != 4:
        return None
    return values  # type: ignore[return-value]


def x_overlaps_box(bbox, box: tuple[float, float, float, float]) -> bool:
    """块的 x 范围与版心的 x 范围有重叠（列内的字，即使中心在上下框外也不该删）。"""
    parsed = _bbox_tuple(bbox)
    if parsed is None:
        return False
    x0, _, x1, _ = parsed
    return x1 > box[0] + 1e-9 and x0 < box[2] - 1e-9


def classify_page(
    page: Page,
    blocks: Sequence[object],
    project,
    *,
    enabled: bool,
) -> PageMarginLayout:
    """判一页：版心层 + 类型层。**不写库**，只返回集合与计数。

    版心取 `export_margin_box`：任务 33 起 ``auto`` 页读**本页落库的**拟合框 /
    包围盒（界面、导出、审计同一份）；``inherit`` 页才读全局框，且全局框是自动推算、
    还没人确认（source=auto）时不认它——一个没人确认的框不该决定哪些字进正文。
    """
    box = margin_box_module.export_margin_box(project, page)
    mode = page.margin_box_mode
    applied = bool(enabled and mode != MODE_NONE and box is not None)
    unset = bool(enabled and mode != MODE_NONE and box is None)

    inside: set[str] = set()
    outside: set[str] = set()
    rescued: set[str] = set()
    numbers: dict[str, str] = {}
    notes: set[str] = set()
    notes_inside: set[str] = set()

    for block in blocks:
        block_type = getattr(block, "block_type", "")
        bbox = getattr(block, "bbox", None)
        center = block_center(bbox)
        # 没有框的块判断不了位置：按"版心内"处理，宁可留在正文里也不静默丢数据
        is_inside = True
        if applied and center is not None and not center_inside(center, box):
            # 刀 0：中心在框外 ≠ 该删。只删"列外 / 上下边带"的家具。
            if block_type in ALWAYS_KEEP_TYPES:
                is_inside = True
                rescued.add(block.block_id)
            elif x_overlaps_box(bbox, box) and not _in_edge_band(center):
                is_inside = True
                rescued.add(block.block_id)
            else:
                is_inside = False

        block_id = block.block_id
        if is_inside:
            inside.add(block_id)
        else:
            outside.add(block_id)

        if block_type in NOTE_TYPES:
            notes.add(block_id)
            if is_inside:
                notes_inside.add(block_id)

        # 页码：版心生效时**只看版心外 + 上下边带**（版心是主判据）；
        # 版心缺省 / none 时才退回"显式 page_number 块"的旧口径。
        explicit = block_type == segments_module.BLOCK_TYPE_PAGE_NUMBER
        if applied:
            candidate = not is_inside and _in_edge_band(center)
        else:
            candidate = explicit
        if candidate:
            value = _page_number_value(block, page, applied=applied)
            if value is not None:
                numbers[block_id] = value

    return PageMarginLayout(
        page_no=page.page_no,
        margin_box=box if applied else None,
        margin_box_mode=mode,
        applied=applied,
        unset=unset,
        inside_ids=frozenset(inside),
        outside_ids=frozenset(outside),
        rescued_ids=frozenset(rescued),
        page_number_values=dict(numbers),
        note_ids=frozenset(notes),
        note_inside_ids=frozenset(notes_inside),
    )


def classify_pages(
    pages: Sequence[Page],
    blocks_by_page: Mapping[int, Sequence[object]],
    project,
    *,
    enabled: bool,
) -> dict[int, PageMarginLayout]:
    return {
        page.page_no: classify_page(
            page, blocks_by_page.get(page.page_no, ()), project, enabled=enabled
        )
        for page in pages
    }
