"""迁移 0005：协作（说明书 5.3 的 Assignment，6.7 的审校任务包）。

三处结构变化：

1. **`assignment` 表**（负责人侧）：一次分派 = 一条记录——分派给谁、哪些页、
   什么时候发的、任务包文件在哪、导入了第几次结果、合并到什么程度、有没有作废。
   分派时的**基准快照**不在这张表里：它在 ``assignments/<assignment_id>/snapshot.json``，
   因为它是"一整页块的状态"，放进表里会变成一列很大的 JSON，也不方便人工查看。

2. **`project.kind`**：主项目（`main`）还是审校包项目（`package`）。
   助手打开的 `.b2tpkg` 会变成一个 `kind='package'` 的项目，功能按说明书 6.7.3
   做限制（不能识别、不能改页面类型、不能导出 TXT/JSONL）。

3. **`page` 上的两列**：
   - ``is_context``：任务包里的**只读上下文页**（分派范围前后各 1 页，说明书 6.7.2）；
   - ``pdf_page_index``：这一页在**本项目的 PDF** 里是第几页（0 起）。
     主项目里它等于 `page_no - 1`，可以不填；任务包项目的 PDF 是子集，
     页码与索引不再一致，必须单独记——否则渲染出来的图会是别的页。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 5
DESCRIPTION = "协作：assignment 表、project.kind、page.is_context / pdf_page_index"

ASSIGNMENT_STATUS = "'issued', 'returned', 'partially_merged', 'merged', 'cancelled'"
PROJECT_KIND = "'main', 'package'"


def apply(conn: Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE assignment (
            assignment_id    TEXT PRIMARY KEY,
            project_id       TEXT NOT NULL,
            reviewer_name    TEXT NOT NULL,
            note             TEXT NOT NULL DEFAULT '',
            due_date         TEXT,
            page_ids         TEXT NOT NULL DEFAULT '[]',
            context_page_ids TEXT NOT NULL DEFAULT '[]',
            status           TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ({ASSIGNMENT_STATUS})),
            package_name     TEXT NOT NULL DEFAULT '',
            created_at       TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            cancelled_at     TEXT,
            imported_seq     INTEGER NOT NULL DEFAULT 0,
            merged_seq       INTEGER NOT NULL DEFAULT 0,
            merged_pages     INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        "CREATE INDEX idx_assignment_project ON assignment (project_id, created_at)"
    )
    # 同一页同一时间只允许在一个**未完成**的任务包里（说明书 6.7.1）——
    # 这条约束由业务层保证（要在 page_ids 这个 JSON 里查），数据库层只保证记录完整

    conn.execute(
        f"ALTER TABLE project ADD COLUMN kind TEXT NOT NULL DEFAULT 'main' CHECK (kind IN ({PROJECT_KIND}))"
    )
    conn.execute("ALTER TABLE page ADD COLUMN is_context INTEGER NOT NULL DEFAULT 0")
    conn.execute("ALTER TABLE page ADD COLUMN pdf_page_index INTEGER")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
