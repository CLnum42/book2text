"""迁移 0004：导出记录表 `export_record`（说明书 5.3）。

说明书 6.6 要求每次导出都是一次有记录的动作：导出了哪一段范围、用了哪些清理规则、
生成了哪些文件、有多少段多少字、其中多少还没审校——这些都要能事后查得到，
因为"这份文本是怎么来的"是这本书的核心价值之一。

``export_id`` 就是导出目录名（说明书 12.1 的 ``20250301-1432_txt``），
因此它同时也是下载接口里的那个 id：文件名与记录天然对齐，不会各说各话。

`status` 按说明书保留取值；当前导出是**同步**完成的，写成功才落这条记录，
所以实际只会出现 `succeeded`（失败的导出以接口报错呈现，不写半截文件）。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 4
DESCRIPTION = "导出记录表：export_record"

_STATUS = "'queued', 'running', 'succeeded', 'failed'"


def apply(conn: Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE export_record (
            export_id        TEXT PRIMARY KEY,
            format           TEXT NOT NULL,
            scope_json       TEXT NOT NULL DEFAULT '{{}}',
            rules_json       TEXT NOT NULL DEFAULT '{{}}',
            file_paths       TEXT NOT NULL DEFAULT '[]',
            segment_count    INTEGER NOT NULL DEFAULT 0,
            char_count       INTEGER NOT NULL DEFAULT 0,
            unreviewed_count INTEGER NOT NULL DEFAULT 0,
            uncertain_count  INTEGER NOT NULL DEFAULT 0,
            created_at       TEXT NOT NULL,
            status           TEXT NOT NULL DEFAULT 'succeeded' CHECK (status IN ({_STATUS}))
        )
        """
    )
    conn.execute("CREATE INDEX idx_export_record_time ON export_record (created_at)")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
