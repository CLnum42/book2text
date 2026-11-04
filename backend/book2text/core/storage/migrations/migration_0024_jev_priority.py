"""迁移 0024：行级 Jev 可疑度分数（2026-11-05，审校队列排序）。

背景：审校队列现在按「正文流顺序」排，用户要先看过 261 行分歧才知道哪几行最可疑。
Jev（MiniCPM-OCR-Jev）给每一行一个「候选文本与原图一致的概率」（0–1，越低越可疑），
把最可疑的排到前面，能把前 50 行的命中率从 28% 抬到 45% 左右。

为什么分数落在 `block_line` 上：
- 一行一个分数，与 `diff_status` 同一粒度；排序、筛选、清除都按行做；
- `NULL` = 没跑过（与 0 分严格区分：0 分是"极可疑"，NULL 是"没测"）。

**本迁移只加列，不写数据**：跑分是用户手动触发的后台任务（`job_type='jev_priority'`），
默认关闭，不进识别链路。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 24
DESCRIPTION = "block_line.jev_score：行级 Jev 可疑度（NULL = 没跑过）"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE block_line ADD COLUMN jev_score REAL")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
