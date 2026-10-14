"""迁移 0003：编辑历史表 `event`（说明书 5.3）。

说明书 5.1 的数据原则："所有修改写入事件表，支持撤销与追溯"，
5.3 又规定撤销 / 重做**基于 Event、按 batch 进行**——所以这张表从第一天就得在，
否则审校改过的每一个字都无从追溯。

``before_json`` / ``after_json`` 存的是**这次改动涉及的字段**（不是整行快照）：
撤销时把它们反过来写回去就够了，事件本身也保持可读。

同一次批量操作（例如"确认整页"）共享一个 ``batch_id``，撤销按 batch 走。
``package_id`` 属于协作阶段（Phase 5 的结果包合并），按 R7 先建出来。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 3
DESCRIPTION = "编辑历史表：event"

# 说明书 5.3 的候选人 / 执行者
_ACTORS = "'user', 'system', 'agent', 'reviewer'"


def apply(conn: Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE event (
            event_id    TEXT PRIMARY KEY,
            batch_id    TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id   TEXT NOT NULL,
            action      TEXT NOT NULL,
            before_json TEXT,
            after_json  TEXT,
            actor       TEXT NOT NULL DEFAULT 'user' CHECK (actor IN ({_ACTORS})),
            actor_name  TEXT,
            package_id  TEXT,
            created_at  TEXT NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX idx_event_batch ON event (batch_id)")
    conn.execute("CREATE INDEX idx_event_entity ON event (entity_type, entity_id, created_at)")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
