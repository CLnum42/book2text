"""迁移 0002：识别相关表（说明书 5.3 的 ocr_run / block / block_line，以及 job / job_item）。

**为什么这五张表一起建：** 识别一次就同时产生这五项记录，缺任何一张都写不完整：
任务（谁在跑）→ 单元（跑哪一页）→ 运行（哪个引擎认的）→ 块 → 行。
说明书 R7 要求 `run_type`、`BlockLine.aux_text` / `diff_status`，以及
`revision` / `reviewed_by` / `comment` 等协作字段**从 Phase 1 / Phase 2 起就建立**，
因此这里一并建出，即使双路 OCR 与协作审校要到后续阶段才用上。

**没有建的表：** Event（编辑历史，Phase 3）、Assignment / ExportRecord（Phase 5 / 4）。
说明书 12.2 要求不为看起来完整而预建——用不上就不建。

几处具体取舍：

- ``bbox`` 存 JSON 文本（``[x0, y0, x1, y1]``，归一化，说明书 5.2），无坐标时为 NULL。
- ``raw_result_path`` 存**相对项目目录**的路径（``ocr_runs/<run_id>.json``）。
  说明书第 10 节要求项目内不留个人绝对路径，相对路径才能整包拷贝到另一台机器。
- ``elapsed_seconds`` 是说明书字段清单之外的**新增列**：界面要显示"这一页认了多久"，
  而它无法从 ``created_at`` / ``finished_at`` 推导（那两个之间还包含排队时间）。
  它记的是**整页耗时**（渲染 + 识别 + 落库），引擎自己报的耗时另记在
  ``ocr_runs/<run_id>.json`` 的 ``engine_elapsed_seconds`` 里。
- 外键只加在明确的父子关系上（block → page、block_line → block、job_item → job）。
  ``origin_run_id`` / ``run_id`` / ``active_run_id`` 不加外键：它们会指向被软删除或
  被替换的历史记录，加约束只会让软删除变复杂。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 2
DESCRIPTION = "识别表：ocr_run / block / block_line / job / job_item"

# 说明书 5.3 里各枚举字段的取值，用 CHECK 钉住，避免写入拼错的状态
_RUN_STATUS = "'queued', 'running', 'succeeded', 'failed'"
_RUN_TYPE = "'primary', 'auxiliary'"
_BLOCK_ORIGIN = "'ocr', 'manual', 'split', 'merge'"
_REVIEW_STATUS = "'unreviewed', 'confirmed', 'uncertain'"
_DIFF_STATUS = "'identical', 'format_only_differs', 'differs'"
_JOB_STATUS = (
    "'queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled', 'interrupted'"
)
_ITEM_STATUS = "'queued', 'running', 'succeeded', 'failed'"


def apply(conn: Connection) -> None:
    # 说明书 5.3：一个页面可以有多个 Run，Page.active_run_id 指向当前采用的那个
    conn.execute(
        f"""
        CREATE TABLE ocr_run (
            run_id          TEXT PRIMARY KEY,
            page_id         TEXT NOT NULL REFERENCES page(page_id),
            run_type        TEXT NOT NULL DEFAULT 'primary' CHECK (run_type IN ({_RUN_TYPE})),
            engine_id       TEXT NOT NULL,
            engine_version  TEXT NOT NULL,
            params_json     TEXT NOT NULL DEFAULT '{{}}',
            status          TEXT NOT NULL CHECK (status IN ({_RUN_STATUS})),
            error_code      TEXT,
            error_message   TEXT,
            raw_result_path TEXT,
            elapsed_seconds REAL,
            created_at      TEXT NOT NULL,
            finished_at     TEXT
        )
        """
    )
    conn.execute("CREATE INDEX idx_ocr_run_page ON ocr_run (page_id, created_at)")

    # 说明书 5.3 的 Block。ocr_text 是识别原文、永不改动；text 是最终文本（R5 文本隔离）
    conn.execute(
        f"""
        CREATE TABLE block (
            block_id          TEXT PRIMARY KEY,
            page_id           TEXT NOT NULL REFERENCES page(page_id),
            origin_run_id     TEXT,
            origin            TEXT NOT NULL DEFAULT 'ocr' CHECK (origin IN ({_BLOCK_ORIGIN})),
            order_index       INTEGER NOT NULL,
            bbox              TEXT,
            block_type        TEXT NOT NULL DEFAULT 'paragraph',
            ocr_text          TEXT NOT NULL DEFAULT '',
            text              TEXT NOT NULL DEFAULT '',
            review_status     TEXT NOT NULL DEFAULT 'unreviewed'
                              CHECK (review_status IN ({_REVIEW_STATUS})),
            include           INTEGER NOT NULL DEFAULT 1,
            continues_to_next INTEGER NOT NULL DEFAULT 0,
            confidence        REAL,
            revision          INTEGER NOT NULL DEFAULT 0,
            reviewed_by       TEXT,
            comment           TEXT,
            created_at        TEXT NOT NULL,
            updated_at        TEXT NOT NULL,
            deleted_at        TEXT
        )
        """
    )
    conn.execute("CREATE INDEX idx_block_page ON block (page_id, order_index)")
    conn.execute("CREATE INDEX idx_block_run ON block (origin_run_id)")

    # 说明书 5.3 的 BlockLine：行级坐标，供 bbox 联动、按行比对与断词抽查
    conn.execute(
        f"""
        CREATE TABLE block_line (
            line_id     TEXT PRIMARY KEY,
            block_id    TEXT NOT NULL REFERENCES block(block_id),
            line_index  INTEGER NOT NULL,
            bbox        TEXT,
            text        TEXT NOT NULL DEFAULT '',
            aux_text    TEXT,
            diff_status TEXT CHECK (diff_status IS NULL OR diff_status IN ({_DIFF_STATUS}))
        )
        """
    )
    conn.execute("CREATE INDEX idx_block_line_block ON block_line (block_id, line_index)")

    # 说明书 5.3 的 Job 与 JobItem：任务按页拆成 Item，以支持断点续跑与幂等重试
    conn.execute(
        f"""
        CREATE TABLE job (
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
    conn.execute("CREATE INDEX idx_job_item_job ON job_item (job_id)")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
