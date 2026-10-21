"""改框之后重新计算「行 → 块」归属（说明书 5.3 的 BlockLine 扩展）。

**绝不重跑 OCR。** 识别出的行已经带着行级 bbox 存在 `block_line` 里；改一个块的框
只是重新回答"这一行现在落在哪个块里"，不调用引擎、不重新切行、不改任何行文本。

规则（本任务定下来的口径，见 docs/decisions.md D-051）：

1. 一行与块的框有**正面积重叠**才候选。恰好贴边（面积为 0）不算，避免浮点噪声。
2. 只落在一个块里 → ``assigned``，归这个块。
3. 落在多个块里 → ``conflict``，按**重叠面积**归给最大者。
   面积相同（例如一个块完全套在另一个里）时取**面积更小的块**（更具体），
   再相同则取页内顺序靠前的块——保证结果稳定、可复现。
4. 哪个块都不沾 → ``unassigned``。行**仍留在原来的块下**（`block_line.block_id`
   保持不动），只是状态变了；行不会被删除，界面用灰色虚线画出来并计数。

本模块是纯函数，不碰数据库：调用方把行与块的 bbox 传进来，拿回归属结果。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

BBox = tuple[float, float, float, float]

LAYOUT_ASSIGNED = "assigned"
LAYOUT_CONFLICT = "conflict"
LAYOUT_UNASSIGNED = "unassigned"

LAYOUT_STATUSES = (LAYOUT_ASSIGNED, LAYOUT_CONFLICT, LAYOUT_UNASSIGNED)


@dataclass(frozen=True)
class LineBox:
    """参与归属计算的一行。``block_id`` 是它**当前**挂着的块（未归属时保持原样）。"""

    line_id: str
    block_id: str
    bbox: BBox | None


@dataclass(frozen=True)
class BlockBox:
    """参与归属计算的一个块。``order_index`` 只用于并列时的稳定决胜。"""

    block_id: str
    bbox: BBox | None
    order_index: int = 0


@dataclass(frozen=True)
class Assignment:
    line_id: str
    block_id: str
    status: str
    overlap: float


def bbox_area(bbox: BBox | None) -> float:
    if not bbox:
        return 0.0
    width = max(bbox[2] - bbox[0], 0.0)
    height = max(bbox[3] - bbox[1], 0.0)
    return width * height


def intersection_area(left: BBox | None, right: BBox | None) -> float:
    """两个框的交集面积；无交集或任一为空时返回 0。"""
    if not left or not right:
        return 0.0
    x0 = max(left[0], right[0])
    y0 = max(left[1], right[1])
    x1 = min(left[2], right[2])
    y1 = min(left[3], right[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    return (x1 - x0) * (y1 - y0)


def assign_lines(
    lines: Sequence[LineBox], blocks: Sequence[BlockBox]
) -> list[Assignment]:
    """给每一行算归属。**只返回有 bbox 的行**——没有坐标的行无从判断，调用方不动它。"""
    positioned = [block for block in blocks if block.bbox is not None]
    assignments: list[Assignment] = []

    for line in lines:
        if line.bbox is None:
            continue
        hits = [
            (overlap, block)
            for block in positioned
            if (overlap := intersection_area(line.bbox, block.bbox)) > 0.0
        ]
        if not hits:
            assignments.append(
                Assignment(
                    line_id=line.line_id,
                    block_id=line.block_id,
                    status=LAYOUT_UNASSIGNED,
                    overlap=0.0,
                )
            )
            continue

        # 重叠面积大的优先；并列时取更具体的块（面积小），再按页内顺序
        hits.sort(
            key=lambda item: (
                -item[0],
                bbox_area(item[1].bbox),
                item[1].order_index,
                item[1].block_id,
            )
        )
        overlap, best = hits[0]
        assignments.append(
            Assignment(
                line_id=line.line_id,
                block_id=best.block_id,
                status=LAYOUT_CONFLICT if len(hits) > 1 else LAYOUT_ASSIGNED,
                overlap=overlap,
            )
        )
    return assignments
