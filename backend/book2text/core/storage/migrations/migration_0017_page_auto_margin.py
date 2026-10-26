"""迁移 0017：页级版心新增 ``auto``（每页自动拟合），并把它设为默认（任务 62）。

新工作流里"版心"不再是一个全书共用框，而是**每页用自己的检测行拟合**；
全局版心降级为"页内行不足时的兜底值"。

老项目的 ``inherit`` 行在这里转成 ``auto``：升级后打开项目，页级版心会按已有检测行
拟合；没有检测行的页保持空框，读取时回退全局。``custom`` / ``none`` 一律不动。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 17
DESCRIPTION = "页级版心：inherit → auto（每页自动拟合），全局仅兜底"


def apply(conn: Connection) -> None:
    # 不重建表：mode 是 TEXT，没有 CHECK；这里只做一次数据归一化。
    conn.execute("UPDATE page SET margin_box_mode = 'auto' WHERE margin_box_mode = 'inherit'")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
