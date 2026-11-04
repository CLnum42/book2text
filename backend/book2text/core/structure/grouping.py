"""把文本行组合成块（说明书 8.1）。

PP-OCR 只返回**行**，不返回块；块由本模块按**行距、缩进、对齐**组合而成。
说明书 8.1 要求"规则必须有测试"，所以每条规则都有对应的单元测试。

**与版面组件的关系（说明书 8.4）：** 版面模型给出的是**区域**而不是自然段，
一个"文本"区域通常含多个自然段。因此启用版面组件时，**对每个区域调用一次
`group_lines()` 即可**——本模块不需要知道区域的存在，只需保证"在给定的一组行内
正确分段"。这样路线 B（有版面）与路线 C（无版面）共用同一套分段规则。

**阅读顺序（说明书 8.1）：** 单栏按从上到下；检测到疑似多栏时按栏排序，
并**标记"阅读顺序待检查"**——说明书写明"不假装已正确排序"，因此本模块给出
`reading_order_uncertain` 标志而不是默默保证正确。

**块类型：** 本模块一律给 `paragraph`。说明书写明块类型的来源是版面组件的建议
（需预览确认）或人工标注 / 6.5 的批量工具，本模块不越权猜测页眉页脚。

**段内行合并（说明书 9.2）不在这里做：** 说明书 5.3 规定 ``Block.text``
"保留行内换行"，把行拼成连续文本是**导出时**的规则（9.2），属于另一个模块。
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field, replace
from typing import Sequence

from ..ocr.base import BBox, OcrLine

# 块类型。说明书 5.3 的取值里，本模块只会产出 PARAGRAPH，外加一条**几何判据**产出的
# FIGURE（见 `_figure_groups`）：短行组落在本页正文栏之外时，它不是正文（插图题字 /
# 竖排书眉）。这条不是"猜页眉页脚"，是"这一组短行不在正文栏里"的可复算判据。
BLOCK_TYPE_PARAGRAPH = "paragraph"
BLOCK_TYPE_FIGURE = "figure"

# ---------------------------------------------------------------- 规则参数
#
# 全部以"行高"或"字宽"的倍数表示，而不是绝对坐标——这样同一套参数
# 在 300 DPI 与 200 DPI 下、在不同版心宽度的书上都能用。

# 行距超过"常规行距 + 本系数 × 行高"时另起一块
DEFAULT_GAP_FACTOR = 0.6
# 行首缩进超过"本系数 × 字宽"时另起一块
DEFAULT_INDENT_FACTOR = 1.2
# 行尾比版心右边界短出"本系数 × 字宽"以上时，视为段落末行
DEFAULT_SHORT_LINE_FACTOR = 2.0
# 两行的横向区间重叠比例低于此值时，认为它们不在同一栏
DEFAULT_COLUMN_OVERLAP = 0.15


@dataclass(frozen=True)
class Block:
    """一组被判定为同一自然段的文本行。

    对应说明书 5.3 的 ``Block`` 实体，但**不含**持久化字段
    （``block_id`` / ``review_status`` / ``revision`` / ``origin`` 等）——
    那些属于 Phase 1/2 的存储层。这里只描述"分段的结果"。
    """

    order_index: int
    bbox: BBox | None
    block_type: str
    lines: tuple[OcrLine, ...]
    column: int = 0

    @property
    def text(self) -> str:
        """块文本，**行以 ``\\n`` 连接**（说明书 5.3：保留行内换行）。"""
        return "\n".join(line.text for line in self.lines)

    @property
    def line_count(self) -> int:
        return len(self.lines)


@dataclass(frozen=True)
class PageLayout:
    """一页（或一个区域内）的分段结果。"""

    blocks: tuple[Block, ...]
    column_count: int
    reading_order_uncertain: bool
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def line_count(self) -> int:
        return sum(block.line_count for block in self.blocks)


# ---------------------------------------------------------------- 小工具

def _median(values: Sequence[float], fallback: float) -> float:
    clean = [value for value in values if value > 0]
    return statistics.median(clean) if clean else fallback


def _overlap_ratio(a: BBox, b: BBox) -> float:
    """两个横向区间 [x0, x1] 的重叠长度占比（相对较短的那个）。"""
    width_a = a.width
    width_b = b.width
    if width_a <= 0 or width_b <= 0:
        return 0.0
    overlap = min(a.x1, b.x1) - max(a.x0, b.x0)
    if overlap <= 0:
        return 0.0
    return overlap / min(width_a, width_b)


def _cluster_columns(lines: Sequence[OcrLine], min_overlap: float) -> list[list[int]]:
    """把行的下标按"横向区间是否重叠"聚成若干栏。

    用**区间重叠**而不是左边界或中心点：居中标题的左边界远大于正文，
    用左边界会被误判成单独一栏；而居中标题的区间与正文区间重叠，不会被拆开。
    """
    parent = list(range(len(lines)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(a: int, b: int) -> None:
        root_a, root_b = find(a), find(b)
        if root_a != root_b:
            parent[root_b] = root_a

    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            if _overlap_ratio(lines[i].bbox, lines[j].bbox) >= min_overlap:
                union(i, j)

    grouped: dict[int, list[int]] = {}
    for index in range(len(lines)):
        grouped.setdefault(find(index), []).append(index)
    return list(grouped.values())


# ---------------------------------------------------------------- 主流程

def group_lines(
    lines: Sequence[OcrLine],
    *,
    gap_factor: float = DEFAULT_GAP_FACTOR,
    indent_factor: float = DEFAULT_INDENT_FACTOR,
    short_line_factor: float = DEFAULT_SHORT_LINE_FACTOR,
    column_overlap: float = DEFAULT_COLUMN_OVERLAP,
) -> PageLayout:
    """把一页（或一个版面容器的区域）内的行组合成块。

    传入选区时应传入**该区域内的行**——区域内分段与整页分段用的是同一套规则。
    """
    usable = [line for line in lines if line.text.strip() and line.bbox is not None]
    if not usable:
        return PageLayout(blocks=(), column_count=0, reading_order_uncertain=False)

    notes: list[str] = []
    if len(usable) != len(lines):
        notes.append(f"忽略了 {len(lines) - len(usable)} 个空行或缺少坐标的行")

    columns = _cluster_columns(usable, column_overlap)
    if len(columns) > 1:
        notes.append(
            f"检测到疑似 {len(columns)} 栏：已按栏排序（从左到右、栏内从上到下），"
            "但阅读顺序仍需人工确认（说明书 8.1）"
        )

    # 栏按最左边界排序（从左到右）
    columns.sort(key=lambda indexes: min(usable[i].bbox.x0 for i in indexes))

    blocks: list[Block] = []
    order = 0
    for column_index, indexes in enumerate(columns):
        ordered = sorted(indexes, key=lambda i: (usable[i].bbox.y0, usable[i].bbox.x0))
        for group in _split_into_paragraphs(
            [usable[i] for i in ordered],
            gap_factor=gap_factor,
            indent_factor=indent_factor,
            short_line_factor=short_line_factor,
        ):
            blocks.append(
                Block(
                    order_index=order,
                    bbox=_union_bbox([line.bbox for line in group]),
                    block_type=BLOCK_TYPE_PARAGRAPH,
                    lines=tuple(group),
                    column=column_index,
                )
            )
            order += 1

    blocks = _figure_groups(blocks, usable)
    return PageLayout(
        blocks=tuple(blocks),
        column_count=len(columns),
        reading_order_uncertain=len(columns) > 1,
        notes=tuple(notes),
    )


#: ③ 短行组判据（2026-11-04，CER 首测 p14）：块内每行 ≤6 字、≥2 行、
#: 块中心落在本页正文栏外 ⇒ 非正文块。40 页实测命中 32 块（31 个竖排书眉 + p14 题字），
#: 正文栏内 0 块。字形高度不可用（题字与正文字高一样），所以用"短行 + 栏外"这两条。
SHORT_LINE_MAX_CHARS = 6
SHORT_GROUP_MIN_LINES = 2
#: 正文栏用**长行**估：≥12 字的行才算正文，至少 3 行才认为这一页有稳定的正文栏
BODY_COLUMN_MIN_CHARS = 12
BODY_COLUMN_MIN_LINES = 3


def _figure_groups(blocks: Sequence[Block], lines: Sequence[OcrLine]) -> list[Block]:
    """把"短行组且整块在本页正文栏外"的块标成 figure。

    正文栏取**长行（≥12 字）**的横向范围；短行（书眉 / 题字 / 页码）本来就不该
    参与定栏。没有足够长行时（诗页、图页、区域分组）不判——宁可不标，不误伤。
    多栏页上长行横跨两栏 ⇒ 栏范围被拉宽，短行组只要在范围内就不标，天然安全。
    """
    body = [
        line
        for line in lines
        if line.bbox is not None and len(line.text.strip()) >= BODY_COLUMN_MIN_CHARS
    ]
    if len(body) < BODY_COLUMN_MIN_LINES:
        return list(blocks)
    column_x0 = min(line.bbox.x0 for line in body)
    column_x1 = max(line.bbox.x1 for line in body)

    result: list[Block] = []
    for block in blocks:
        texts = [line.text.strip() for line in block.lines if line.text.strip()]
        short_group = (
            len(texts) >= SHORT_GROUP_MIN_LINES
            and all(len(text) <= SHORT_LINE_MAX_CHARS for text in texts)
        )
        if short_group and block.bbox is not None:
            center = (block.bbox.x0 + block.bbox.x1) / 2
            if center < column_x0 or center > column_x1:
                result.append(replace(block, block_type=BLOCK_TYPE_FIGURE))
                continue
        result.append(block)
    return result


def _union_bbox(boxes: Sequence[BBox]) -> BBox:
    return BBox(
        x0=min(box.x0 for box in boxes),
        y0=min(box.y0 for box in boxes),
        x1=max(box.x1 for box in boxes),
        y1=max(box.y1 for box in boxes),
    )


def _split_into_paragraphs(
    lines: Sequence[OcrLine],
    *,
    gap_factor: float,
    indent_factor: float,
    short_line_factor: float,
) -> list[list[OcrLine]]:
    """把**同一栏内、已按从上到下排序**的行切成自然段。

    三条规则（说明书 8.1 点名的行距 / 缩进 / 对齐），任一命中即在两行之间断开：

    1. **行距**：`下一行的顶 - 本行的底` 明显大于常规行距 → 另起一段。
    2. **对齐（末行短）**：本行右边界明显短于版心右边界 → 本行是段落末行。
       这是两端对齐的正文最可靠的段落边界信号。
    3. **缩进**：下一行左边界比本行明显右移 → 下一行是段首缩进 → 另起一段。
    """
    if not lines:
        return []

    heights = [line.bbox.height for line in lines]
    line_height = _median(heights, 0.02)

    # 字宽的粗估：用"行宽 / 字数"的中位数。用它把阈值换算成"几个字"，
    # 这样阈值能随字号自动缩放。
    char_widths = [
        line.bbox.width / len(line.text)
        for line in lines
        if line.text and line.bbox.width > 0
    ]
    char_width = _median(char_widths, line_height * 0.6)

    # 版心右边界：两端对齐时大多数行都顶到这个位置
    right_edge = _median([line.bbox.x1 for line in lines], 0.0)

    # 常规行距 = 相邻行间距的中位数
    gaps = [
        lines[index + 1].bbox.y0 - lines[index].bbox.y1
        for index in range(len(lines) - 1)
    ]
    typical_gap = _median([max(gap, 0.0) for gap in gaps], 0.0)

    paragraphs: list[list[OcrLine]] = [[lines[0]]]
    for index in range(len(lines) - 1):
        current, following = lines[index], lines[index + 1]

        gap = following.bbox.y0 - current.bbox.y1
        gap_break = gap > typical_gap + gap_factor * line_height
        short_break = (right_edge - current.bbox.x1) > short_line_factor * char_width
        indent_break = (following.bbox.x0 - current.bbox.x0) > indent_factor * char_width

        if gap_break or short_break or indent_break:
            paragraphs.append([following])
        else:
            paragraphs[-1].append(following)

    return paragraphs
