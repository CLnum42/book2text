"""迁移 0020：跨页边界是否**人工看过**（任务 42）。

``block.continues_reviewed`` 取值：

- ``1``：这一块的「延续到下一页」已经人看过并决定（延续或结束都算）；
- ``0``：没看过。自动判定（F1）只写 `continues_to_next`，不动这一列——
  机器判出来的延续 / 结束不是"人看过"。

为什么单独存一列：`continues_to_next` 的默认值也是 0，所以"人工判定为结束"和
"根本没人看"在数据上分不出来。而 F1 的第三桶（16 处走满行但末字是句末标点）
必须能算准、能点掉、能撤销——撤销就是把这一列写回 0，那一处重新回到待确认。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 20
DESCRIPTION = "block.continues_reviewed：跨页边界是否经人工确认"


def apply(conn: Connection) -> None:
    conn.execute(
        "ALTER TABLE block ADD COLUMN continues_reviewed INTEGER NOT NULL DEFAULT 0"
    )


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
