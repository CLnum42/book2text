"""迁移 0009：整页「版面确认」状态 + 块改动自动重置。

- ``page.layout_confirmed INTEGER NOT NULL DEFAULT 0``：这一页**里面哪些块算正文**
  是否经过人工确认。它和 `page.page_confirmed`（这页算不算正文）是两个概念。
- **自动重置**：任何块的类型、框、顺序（包括新增 / 软删除）改动都会把该页的
  `layout_confirmed` 置 0。用触发器实现而不是在每条编辑路径里各写一遍——
  以后新增编辑入口也不会漏。只有值真的变了才触发（`WHEN OLD.x IS NOT NEW.x`）。
- 确认人与时间记在 `event` 表（action = ``confirm_layout``），不新增列。

**为什么用触发器：** 块的写入路径很多（PATCH、结构编辑、合并审阅、任务包导入、
撤销重做）；在业务层逐个补"顺手重置"必然会漏。触发器与数据在同一个事务里，
且不会改变现有行的其它字段。块级 `block.layout_confirmed`（0006）保留不动，
它是"单块确认"，本次新增的是整页状态。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 9
DESCRIPTION = "整页版面确认：page.layout_confirmed + 块改动自动重置"


def apply(conn: Connection) -> None:
    conn.execute(
        "ALTER TABLE page ADD COLUMN layout_confirmed INTEGER NOT NULL DEFAULT 0"
    )

    # 新增块（识别落库 / 手工新增 / 合并拆分的产物）→ 整页版面重新算未确认
    conn.execute(
        """
        CREATE TRIGGER block_layout_changed_insert
        AFTER INSERT ON block
        BEGIN
            UPDATE page SET layout_confirmed = 0 WHERE page_id = NEW.page_id;
        END
        """
    )
    # 类型 / 框 / 顺序 / 软删除变了才重置；改文本、改审校状态、改块级 include 不重置
    conn.execute(
        """
        CREATE TRIGGER block_layout_changed_update
        AFTER UPDATE OF block_type, bbox, order_index, deleted_at ON block
        WHEN OLD.block_type IS NOT NEW.block_type
          OR OLD.bbox IS NOT NEW.bbox
          OR OLD.order_index IS NOT NEW.order_index
          OR OLD.deleted_at IS NOT NEW.deleted_at
        BEGIN
            UPDATE page SET layout_confirmed = 0 WHERE page_id = NEW.page_id;
        END
        """
    )


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
