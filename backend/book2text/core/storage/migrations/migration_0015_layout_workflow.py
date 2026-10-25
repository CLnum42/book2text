"""迁移 0015：版面检测产物 + 页面工作流状态索引（任务 58）。

对应 `docs/workflow.md` 的第 2 节：版面检测（只检测不识别）产出**行框**，
页面状态显式化。这里只建三张表，不改任何现有表 / 现有列，因此对老项目的
识别、版心、页码、导出行为没有影响。

```text
layout_run        一次检测运行（引擎、版本、参数、耗时、原始输出路径）
page_layout_line  该次运行检出的每个文本行（归一化 bbox、阅读顺序、置信度）
page_workflow     页面状态索引 / 缓存（stage、失败阶段、阶段时间、页码旁路状态）
```

**为什么行框单独成表、不塞进 `block_line`：** 检测阶段不产生文字，块 / 行是
识别阶段的产物；混在一起会让"没识别但已检测"的页看起来像有块。两者通过
归一化 bbox 同口径（`docs/workflow.md` 3.1），将来按检测行裁图识别时再合并。

**为什么 `page_workflow` 只是索引：** 权威产物是 `page` / `layout_run` /
`ocr_run` / `block` 等；索引坏了可以重建（`core/project/workflow.py` 的
`rebuild_page_stage`）。这一刀只记录，不驱动现有流程（见决策 D-073）。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 15
DESCRIPTION = "版面检测产物与页面工作流状态：layout_run / page_layout_line / page_workflow"


def apply(conn: Connection) -> None:
    conn.execute(
        """
        CREATE TABLE layout_run (
            run_id          TEXT PRIMARY KEY,
            page_id         TEXT NOT NULL REFERENCES page(page_id),
            engine_id       TEXT NOT NULL,
            engine_version  TEXT NOT NULL,
            params_json     TEXT NOT NULL DEFAULT '{}',
            status          TEXT NOT NULL,
            line_count      INTEGER NOT NULL DEFAULT 0,
            elapsed_seconds REAL,
            raw_result_path TEXT,
            error_code      TEXT,
            error_message   TEXT,
            created_at      TEXT NOT NULL,
            finished_at     TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX idx_layout_run_page ON layout_run(page_id, created_at)"
    )
    conn.execute(
        """
        CREATE TABLE page_layout_line (
            line_id       TEXT PRIMARY KEY,
            run_id        TEXT NOT NULL REFERENCES layout_run(run_id),
            page_id       TEXT NOT NULL REFERENCES page(page_id),
            line_index    INTEGER NOT NULL,
            bbox          TEXT NOT NULL,
            confidence    REAL,
            reading_order INTEGER NOT NULL DEFAULT 0,
            UNIQUE(run_id, line_index)
        )
        """
    )
    conn.execute(
        "CREATE INDEX idx_page_layout_line_page ON page_layout_line(page_id)"
    )
    conn.execute(
        """
        CREATE TABLE page_workflow (
            page_id            TEXT PRIMARY KEY REFERENCES page(page_id),
            stage              TEXT NOT NULL DEFAULT 'page_unconfirmed',
            failed_stage       TEXT,
            failure_reason     TEXT,
            stage_times_json   TEXT NOT NULL DEFAULT '{}',
            page_number_state  TEXT NOT NULL DEFAULT 'missing',
            revision           INTEGER NOT NULL DEFAULT 0,
            updated_at         TEXT NOT NULL
        )
        """
    )


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
