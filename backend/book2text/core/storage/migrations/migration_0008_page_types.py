"""迁移 0008：页面类型收成五类，`include` 变成派生值。

2026-10-22 用户拍板：页面类型只保留 **前置 / 目录 / 正文 / 正文排除 / 后置**
（`front / toc / body / body_excluded / back`），去掉"纳入 / 排除"这个独立开关。
`page.include` **保留列**（协作包、导出、识别范围都在用），但从此只由 `page_type`
写穿：`body` → 1，其余 → 0。

老库按"行为不变"映射（用户确认过）：

| 旧状态 | 新类型 |
|---|---|
| include = 1（不论旧类型） | body |
| include = 0 且旧类型 body | body_excluded |
| include = 0 且 cover / front / foreword / copyright | front |
| include = 0 且 toc | toc |
| include = 0 且 appendix / index / blank / other | back |

迁移后 `include` 与新类型一致；**不删列、不丢页**。老项目打开即升级。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 8
DESCRIPTION = "页面类型收成五类；page.include 改为 page_type 的派生值"


def apply(conn: Connection) -> None:
    # 先按旧状态算新类型（一条 UPDATE，整库原子）
    conn.execute(
        """
        UPDATE page
           SET page_type = CASE
                 WHEN include = 1 THEN 'body'
                 WHEN page_type = 'body' THEN 'body_excluded'
                 WHEN page_type IN ('cover', 'front', 'foreword', 'copyright') THEN 'front'
                 WHEN page_type = 'toc' THEN 'toc'
                 ELSE 'back'
               END
        """
    )
    # 再让派生列与类型严格一致（旧 include=0 的非正文仍是 0；body 一律 1）
    conn.execute(
        """
        UPDATE page
           SET include = CASE WHEN page_type = 'body' THEN 1 ELSE 0 END
        """
    )


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
