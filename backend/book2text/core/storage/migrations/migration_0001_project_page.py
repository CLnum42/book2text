"""迁移 0001：初始表结构（说明书 5.3 的 project 与 page）。

**只建当前用得上的两张表。** 说明书 5.3 还定义了 OCRRun / Block / BlockLine /
Event / Job / JobItem / Assignment / ExportRecord，它们各自属于后续阶段；
说明书 12.2 明确"不为了看起来完整而预建空模块"，表结构同理——
需要时再写迁移，这正是迁移框架存在的意义。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 1
DESCRIPTION = "初始表：project / page"


def apply(conn: Connection) -> None:
    # 说明书 5.3：project 表仅一行
    conn.execute(
        """
        CREATE TABLE project (
            project_id       TEXT PRIMARY KEY,
            name             TEXT NOT NULL,
            source_file_name TEXT NOT NULL,
            source_sha256    TEXT NOT NULL,
            page_count       INTEGER NOT NULL,
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            schema_version   INTEGER NOT NULL,
            settings_json    TEXT NOT NULL DEFAULT '{}',
            last_view        TEXT,
            last_page_id     TEXT,
            last_block_id    TEXT
        )
        """
    )

    # 说明书 5.3：页面的识别状态与审校状态不单独存储，由 OCRRun 与 Block 推导
    conn.execute(
        """
        CREATE TABLE page (
            page_id         TEXT PRIMARY KEY,
            page_no         INTEGER NOT NULL UNIQUE,
            page_label      TEXT,
            width_pt        REAL NOT NULL,
            height_pt       REAL NOT NULL,
            rotation        INTEGER NOT NULL DEFAULT 0,
            page_type       TEXT NOT NULL DEFAULT 'body',
            include         INTEGER NOT NULL DEFAULT 1,
            has_text_layer  INTEGER NOT NULL DEFAULT 0,
            active_run_id   TEXT,
            note            TEXT
        )
        """
    )
    conn.execute("CREATE INDEX idx_page_no ON page (page_no)")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
