"""迁移 0019：页级版心记录"框是怎么来的"（任务 33）。

``page.margin_box_method`` 取值：

- ``fit``：用本页检测行迭代拟合出来的四边；
- ``bbox``：拟合失败（有效长行不足 3 行），退**本页所有检测行的包围盒**；
- ``NULL``：没有框（``custom`` / ``inherit`` / ``none``，或这一页**未定**——连检测行都没有）。

为什么单独存一列：``custom`` 页也有四边，``auto`` 页拟合和兜底出来的四边在数据上
分不出来；界面要说清"这是自动拟合还是本页包围盒兜底"，导出预检要报"版心未定 N 页"。
老数据全是 NULL：`auto` + `margin_box` 为空视为未定，下次拟合时写入。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 19
DESCRIPTION = "页级版心记录 margin_box_method（fit / bbox / NULL 未定）"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE page ADD COLUMN margin_box_method TEXT")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
