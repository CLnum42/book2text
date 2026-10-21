"""迁移 0006：版面块的人工确认与行归属（说明书 5.3 的 Block / BlockLine 扩展）。

两处结构变化：

1. **`block.layout_confirmed`**：这一块的**版面**（框、类型、页内顺序）是否被人工确认过。
   它是**状态标记，不是硬闸门**——导出照常进行，整本一个都没确认时只给警告。
   确认的人与时间记在 `event` 表里（action = ``set_layout_confirmed``），
   不另外加两列：事件表本来就是"谁在什么时候做了什么"的唯一出处。

2. **`block_line.layout_status`**：改框之后重新算「行 → 块」归属的结果。
   取值 ``assigned``（只落在一个块里）/ ``conflict``（落在多个块里，按重叠面积归给最大者）/
   ``unassigned``（哪个块都不沾）。**行不会被删除或丢弃**：未归属的行仍留在它原来的块下，
   只是状态变了，界面据此用灰色虚线画出来并计数。

**为什么不是新表：** 现有 `block` 的 ``block_id / page_id / bbox / block_type / order_index /
origin / confidence`` 已经就是版面块，`block_line` 也已经存了行级 bbox；另建 `layout_block`
会立刻产生"两份块、哪份是真的"的问题。这里只加两个字段。

**figure / decoration 两个新块类型不需要迁移：** `block_type` 从 0002 起就是普通 TEXT，
没有 CHECK 约束（当时的理由见 0002 的注释），因此新增取值是代码层的事。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 6
DESCRIPTION = "版面：block.layout_confirmed、block_line.layout_status"

_LAYOUT_STATUS = "'assigned', 'conflict', 'unassigned'"


def apply(conn: Connection) -> None:
    conn.execute(
        "ALTER TABLE block ADD COLUMN layout_confirmed INTEGER NOT NULL DEFAULT 0"
    )
    conn.execute(
        f"""
        ALTER TABLE block_line ADD COLUMN layout_status TEXT NOT NULL DEFAULT 'assigned'
        CHECK (layout_status IN ({_LAYOUT_STATUS}))
        """
    )


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
