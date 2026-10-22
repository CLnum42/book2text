"""迁移 0010：自动应用高把握建议的批次记录（`auto_apply_run`）。

**为什么要一张表：** 自动应用发生在**识别子进程**里，而撤销栈只活在 API 进程的内存里
（说明书 5.3："撤销栈仅限本次会话"）。子进程写的事件在 `event` 表里已经带 `batch_id`，
但没有地方记"哪一批是自动应用的、应用了几页几块、有没有撤销过"。这张表补的就是这个：

- `auto_apply_id` 同时当作 `batch_id` 用（撤销时按它把事件捞回来）；
- `status` 只有 applied / undone，撤销一次之后不再重复撤销；
- `by_type_json` 存"页眉 N / 页脚 N / 页码 N"，界面据此显示"上次自动应用了什么"。

不加 `project_id` 列：一个项目一个数据库文件（与其他表一致）。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 10
DESCRIPTION = "自动应用高把握建议：auto_apply_run"

_STATUS = "'applied', 'undone'"


def apply(conn: Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE auto_apply_run (
            auto_apply_id TEXT PRIMARY KEY,
            job_id        TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ({_STATUS})),
            pages         INTEGER NOT NULL DEFAULT 0,
            blocks        INTEGER NOT NULL DEFAULT 0,
            by_type_json  TEXT NOT NULL DEFAULT '{{}}',
            created_at    TEXT NOT NULL,
            undone_at     TEXT
        )
        """
    )
    conn.execute("CREATE INDEX idx_auto_apply_created ON auto_apply_run (created_at)")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
