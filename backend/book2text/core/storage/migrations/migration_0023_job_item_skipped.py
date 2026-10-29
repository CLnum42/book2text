"""迁移 0023：任务与任务单元允许「跳过」这一类终态（2026-10-30）。

背景：批量识别遇到「已有人工成果」的页时，`_persist_blocks` 本来就不写块（保住人工修改，
说明书 R2）。但那一页的 `job_item` 仍被记成 `succeeded`、任务仍记成 `succeeded` ——
统计说「识别完成」，页面上什么都没变，用户无从知道有几页被跳过。这是典型的
「界面说的和系统做的不是一件事」。

修法：新增两类取值，都表示「结束了、但不是失败」：

- `job_item.status = 'skipped'`：这一页被跳过（终态，不进 done、不进 failed，
  点「重试失败页」也不许把它捞回来）；
- `job.status = 'succeeded_with_skips'`：任务跑完了，但有页被跳过。

两张表在 0002 里都用 `CHECK` 钉住了取值，SQLite 改 `CHECK` 只能重建表。因为
`job_item.job_id` 外键指向 `job`，重建顺序必须是：**先把 job_item 挪到不带外键的临时表
→ 删 job_item → 重建 job → 重建 job_item（带外键与索引）**，否则一开
`PRAGMA foreign_keys = ON` 就删不掉父表。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 23
DESCRIPTION = "job / job_item：新增 skipped 与 succeeded_with_skips 两类终态"

_JOB_STATUS = (
    "'queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'interrupted', "
    "'succeeded_with_skips'"
)
_ITEM_STATUS = "'queued', 'running', 'succeeded', 'failed', 'skipped'"


def apply(conn: Connection) -> None:
    # ① job_item → 临时表（不带外键，后面才删得掉 job）
    conn.execute(
        f"""
        CREATE TABLE job_item_tmp (
            item_id       TEXT PRIMARY KEY,
            job_id        TEXT NOT NULL,
            page_id       TEXT NOT NULL,
            status        TEXT NOT NULL CHECK (status IN ({_ITEM_STATUS})),
            run_id        TEXT,
            error_message TEXT,
            attempts      INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        "INSERT INTO job_item_tmp"
        " (item_id, job_id, page_id, status, run_id, error_message, attempts)"
        " SELECT item_id, job_id, page_id, status, run_id, error_message, attempts"
        " FROM job_item"
    )
    conn.execute("DROP TABLE job_item")

    # ② 重建 job：CHECK 放开 succeeded_with_skips
    conn.execute(
        f"""
        CREATE TABLE job_new (
            job_id      TEXT PRIMARY KEY,
            job_type    TEXT NOT NULL,
            status      TEXT NOT NULL CHECK (status IN ({_JOB_STATUS})),
            total       INTEGER NOT NULL DEFAULT 0,
            done        INTEGER NOT NULL DEFAULT 0,
            failed      INTEGER NOT NULL DEFAULT 0,
            params_json TEXT NOT NULL DEFAULT '{{}}',
            created_at  TEXT NOT NULL,
            started_at  TEXT,
            finished_at TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO job_new"
        " (job_id, job_type, status, total, done, failed, params_json, created_at,"
        "  started_at, finished_at)"
        " SELECT job_id, job_type, status, total, done, failed, params_json, created_at,"
        "  started_at, finished_at"
        " FROM job"
    )
    conn.execute("DROP TABLE job")
    conn.execute("ALTER TABLE job_new RENAME TO job")

    # ③ 重建 job_item：带外键、新 CHECK、索引
    conn.execute(
        f"""
        CREATE TABLE job_item (
            item_id       TEXT PRIMARY KEY,
            job_id        TEXT NOT NULL REFERENCES job(job_id),
            page_id       TEXT NOT NULL,
            status        TEXT NOT NULL CHECK (status IN ({_ITEM_STATUS})),
            run_id        TEXT,
            error_message TEXT,
            attempts      INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.execute(
        "INSERT INTO job_item"
        " (item_id, job_id, page_id, status, run_id, error_message, attempts)"
        " SELECT item_id, job_id, page_id, status, run_id, error_message, attempts"
        " FROM job_item_tmp"
    )
    conn.execute("DROP TABLE job_item_tmp")
    conn.execute("CREATE INDEX idx_job_item_job ON job_item (job_id)")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
