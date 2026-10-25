"""迁移 0016：页面确认模式与自动通过标记（任务 61，工作流阶段 9）。

`page_workflow.stage = 'human_confirmed'` 只说明"这一页审校完成了"，不说明是谁确认的。
自动通过必须与人工确认在数据上可区分，因此加三列：

- ``confirm_mode``：``human`` / ``auto`` / NULL（还没确认）；
- ``confirmed_at``：确认时间（人工或自动）；
- ``auto_pass_excluded``：1 = 用户撤销过自动通过，之后不再自动标记。

**只加可空列 / 带默认值的列，不改现有行**；老项目的 `human_confirmed` 行
`confirm_mode` 为 NULL，界面会如实显示"已确认（来源未知）"，不会冒充人工。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 16
DESCRIPTION = "页面确认模式与自动通过标记：confirm_mode / confirmed_at / auto_pass_excluded"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE page_workflow ADD COLUMN confirm_mode TEXT")
    conn.execute("ALTER TABLE page_workflow ADD COLUMN confirmed_at TEXT")
    conn.execute(
        "ALTER TABLE page_workflow ADD COLUMN auto_pass_excluded INTEGER NOT NULL DEFAULT 0"
    )


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
