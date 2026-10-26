"""迁移 0018：块内行增加「人工裁决」标记（任务 67）。

``diff_ack`` 取值 ``NULL`` / ``kept`` / ``adopted``：

- `kept` = 人工看过并决定保留原文（不改文本）；
- `adopted` = 采纳了第二路（文本已改，差异自然消失，但保留记录便于审计）。

``diff_ack_text`` 记录做裁决时块内这一行的文本，重跑第二引擎复核时用它判断
"文本真的变了没有"：没变就保留 ack，变了才清空。老数据两列都是 NULL，视为未处理。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 18
DESCRIPTION = "块内行增加 diff_ack / diff_ack_text（保留原文 / 采纳的持久化裁决）"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE block_line ADD COLUMN diff_ack TEXT")
    conn.execute("ALTER TABLE block_line ADD COLUMN diff_ack_text TEXT")
    conn.execute("CREATE INDEX idx_block_line_diff_ack ON block_line (diff_ack)")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
