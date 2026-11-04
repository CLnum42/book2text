"""迁移 0025：项目记下「版心真的生成过」（2026-11-05，版心确认交互改动）。

背景：进「版心确认」不再自动拟合（产品改动，用户拍板）。于是"从没开始生成"与
"跑过但一页也没拟合出来"在数据上都表现为"没有框"——界面靠数据分不出这两件事，
而它们要交给用户的话不一样（前者说"点全局识别开始"，后者说"哪几页为什么没拟出来"）。

``project.margin_fit_at``：**最后一次成功写入版心的时间**（ISO 8601），
``NULL`` = 这本书从没生成过版心。写入点在 ``margin_box.fit_page_margin``
（单页拟合与整体拟合都经过它），读在收尾面板的 ``margin.fit_started``。

为什么不用 ``settings_json``：那张表存的是**用户开关**（``library.PROJECT_SETTING_KEYS``
有白名单），塞一个系统时间戳进去会让"设置"变成两义。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 25
DESCRIPTION = "project.margin_fit_at：版心最后一次生成时间（NULL = 从没生成过）"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE project ADD COLUMN margin_fit_at TEXT")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
