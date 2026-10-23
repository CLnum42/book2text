"""迁移 0014：页码模板的**页码范围**（第二套模板，任务 56）。

用户 2026-10-23 拍板：页码模板默认整本一个，但允许手动给某段页码范围指定第二套模板
（换版式 / 分卷）。默认模板仍存 `project.page_number_template`；这里只加一份有序、
互不重叠的范围列表：

```json
[{"from_page": 100, "to_page": 150, "template": {...}, "created_at": "..."}]
```

- 归一化页码，不存像素 / 点数；
- 后端在写入前校验 `from <= to`、不越界、**不与已有范围重叠**——不允许某页同时命中两套；
- 空列表 = 没有第二套模板，行为与 0013 完全一样。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 14
DESCRIPTION = "页码模板页码范围：project.page_number_ranges"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE project ADD COLUMN page_number_ranges TEXT")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
