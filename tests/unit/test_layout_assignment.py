"""行归属重算的纯函数测试（说明书 5.3 的 BlockLine 扩展）。"""

from __future__ import annotations

from book2text.core.project import layout


def box(x0, y0, x1, y1):
    return (x0, y0, x1, y1)


def test_line_in_one_block_is_assigned() -> None:
    lines = [layout.LineBox("l1", "old", box(0.1, 0.1, 0.9, 0.2))]
    blocks = [layout.BlockBox("b1", box(0.0, 0.0, 1.0, 0.5))]
    [assignment] = layout.assign_lines(lines, blocks)
    assert assignment.block_id == "b1"
    assert assignment.status == layout.LAYOUT_ASSIGNED
    assert assignment.overlap > 0


def test_line_in_no_block_is_unassigned_but_keeps_its_old_block() -> None:
    lines = [layout.LineBox("l1", "old", box(0.1, 0.6, 0.9, 0.7))]
    blocks = [layout.BlockBox("b1", box(0.0, 0.0, 1.0, 0.5))]
    [assignment] = layout.assign_lines(lines, blocks)
    assert assignment.block_id == "old", "未归属的行不换块，只是状态变了"
    assert assignment.status == layout.LAYOUT_UNASSIGNED
    assert assignment.overlap == 0


def test_line_in_two_blocks_is_a_conflict_and_goes_to_the_larger_overlap() -> None:
    # 行 0.10–0.13：与上方块重叠 0.01，与下方块重叠 0.03 → 归下方并标冲突
    lines = [layout.LineBox("l1", "old", box(0.1, 0.10, 0.9, 0.13))]
    blocks = [
        layout.BlockBox("upper", box(0.0, 0.00, 1.0, 0.11)),
        layout.BlockBox("lower", box(0.0, 0.10, 1.0, 0.30)),
    ]
    [assignment] = layout.assign_lines(lines, blocks)
    assert assignment.block_id == "lower"
    assert assignment.status == layout.LAYOUT_CONFLICT


def test_tie_goes_to_the_more_specific_block() -> None:
    # 行完全落在两个块里；小块更具体，归小块（再按页内顺序稳定决胜）
    lines = [layout.LineBox("l1", "old", box(0.1, 0.10, 0.9, 0.20))]
    blocks = [
        layout.BlockBox("big", box(0.0, 0.00, 1.0, 0.90), order_index=0),
        layout.BlockBox("small", box(0.0, 0.05, 1.0, 0.25), order_index=1),
    ]
    [assignment] = layout.assign_lines(lines, blocks)
    assert assignment.block_id == "small"
    assert assignment.status == layout.LAYOUT_CONFLICT


def test_lines_without_bbox_are_left_alone() -> None:
    lines = [
        layout.LineBox("l1", "old", None),
        layout.LineBox("l2", "old", box(0.1, 0.1, 0.9, 0.2)),
    ]
    blocks = [layout.BlockBox("b1", box(0.0, 0.0, 1.0, 0.5))]
    assignments = layout.assign_lines(lines, blocks)
    assert [item.line_id for item in assignments] == ["l2"], "没有坐标的行不参与归属"


def test_touching_edges_do_not_count_as_overlap() -> None:
    # 行的底边正好压在块的上边：面积为 0，不算落进去
    lines = [layout.LineBox("l1", "old", box(0.1, 0.10, 0.9, 0.20))]
    blocks = [layout.BlockBox("b1", box(0.0, 0.20, 1.0, 0.40))]
    [assignment] = layout.assign_lines(lines, blocks)
    assert assignment.status == layout.LAYOUT_UNASSIGNED
