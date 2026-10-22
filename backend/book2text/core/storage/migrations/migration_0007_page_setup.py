"""迁移 0007：页面确认（说明书 6.2 / 7.3 的「页面准备」显式化）。

只加一列：

- ``page.page_confirmed INTEGER NOT NULL DEFAULT 0``：这一页的**类型与纳入状态**是否
  经过人工确认。它是状态标记，不是识别的硬闸门——还有未确认页时识别只提示一次。
- 改 `page_type` / `include` 会把这一列重置为 0（业务层做，见 `update_page` /
  `update_pages`），所以它永远反映"当前这一版类型与纳入状态确认过没有"。
- 老项目打开即升级，全部默认"未确认"——不假装以前确认过。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 7
DESCRIPTION = "页面确认：page.page_confirmed"


def apply(conn: Connection) -> None:
    conn.execute(
        "ALTER TABLE page ADD COLUMN page_confirmed INTEGER NOT NULL DEFAULT 0"
    )


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
