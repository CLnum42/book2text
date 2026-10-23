"""迁移 0012：版心自动推算的来源、时间与最近一次建议（任务 53）。

用户 2026-10-23 早上提出：版心应随识别自动算出来，页面视图与审校视图都该直接显示，
不需要先点「推算版心」。识别在**子进程**里收尾，所以推算也必须由服务端在收尾时做，
不能靠浏览器点按钮。

需要记的三件事互相关联，因此一起加在 `project` 表：

- ``margin_box_source``：当前全局版心是谁写的——``auto``（识别后自动推算）/
  ``manual``（用户手动设置或采用）/ NULL（没设置过）。
  "已经手动设过就绝不覆盖"就靠它判断；**老项目**（0011 之后手动设过但还没有这一列）
  是 NULL + 版心非空，按"手动"对待（见 `margin_box.can_auto_write`）。
- ``margin_box_set_at``：当前全局版心最后一次写入的时间（ISO 8601）。与
  ``project.updated_at`` 分开：任何一次编辑都会更新后者，不能用来回答"版心何时定的"。
- ``margin_box_suggestion``：最近一次推算的完整结果（JSON 文本），给界面直接显示
  "建议 vs 当前"，不必为了看一眼建议再算一遍。里面有 ``suggested_at`` / ``trigger`` /
  ``job_id`` / ``applied``，与 `core/project/margin_box.py` 的
  ``SUGGESTION_SCHEMA`` 对应。

**为什么不用 `settings_json`：** 设置表存的是用户开关（布尔），这三个是项目级的
实体状态（辨识来源、时间戳、一份带 schema 的结果），而且识别子进程要写、
API 与界面要读。单独成列以后加查询 / 迁移都更直接，也不会被"未知设置键"的校验挡住。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 12
DESCRIPTION = "版心自动推算：project.margin_box_source / set_at / suggestion"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE project ADD COLUMN margin_box_source TEXT")
    conn.execute("ALTER TABLE project ADD COLUMN margin_box_set_at TEXT")
    conn.execute("ALTER TABLE project ADD COLUMN margin_box_suggestion TEXT")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
