"""迁移 0011：版心（type area）——项目级默认 + 页级三态。

2026-10-23 用户拍板的设计：大多数书的正文都在**版心**里，页眉 / 页脚 / 页码在版心外，
所以先确定版心，比每页改二三十个块省力。

- ``project.margin_box``：项目级默认版心，JSON 文本 ``[x0, y0, x1, y1]``，
  **归一化坐标**（说明书 5.2：不写像素 / 点数）。没设置过是 NULL。
- ``page.margin_box``：这一页的自定义版心（仅 ``margin_box_mode = 'custom'`` 时有意义）。
- ``page.margin_box_mode``：``inherit``（默认，跟随项目）/ ``custom``（本页）/ ``none``（不适用）。

**为什么用 JSON 文本而不是四列：** 与 ``block.bbox`` 同一个约定，读写共用
`blocks.bbox_to_json` / `bbox_from_json`；四边是一个整体，分开存反而容易写出
"只改了三边"的半截状态。

**为什么不在数据库里加 CHECK：** SQLite 的 ``ALTER TABLE ADD COLUMN`` 不能带
CHECK 约束；取值与几何合法性统一在 `core/project/margin_box.py` 里校验
（与 `page_type` 的校验同一套路），接口层把错误转成 400。

老项目打开时自动升级；两张表都只加可空列 / 带默认值的列，现有行不需要回填。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 11
DESCRIPTION = "版心：project.margin_box + page.margin_box / margin_box_mode"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE project ADD COLUMN margin_box TEXT")
    conn.execute("ALTER TABLE page ADD COLUMN margin_box TEXT")
    # 默认 inherit：不设置版心的老项目打开后行为完全不变（版心视图默认关）。
    conn.execute(
        "ALTER TABLE page ADD COLUMN margin_box_mode TEXT NOT NULL DEFAULT 'inherit'"
    )


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
