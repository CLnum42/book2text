"""迁移 0022：每页的识别语言（任务 64）。

背景：项目级只有 `ch`，Vision 因此对英文页也开着中文模型，英文撇号大量丢失
（实测英文页 F1 0.47；只开 en-US 是 0.90）。双语书里中文页与英文页各占一半，
所以语言必须**按页**定，并且**落库可查可覆盖**——每次现算既慢又无法人工纠正。

取值：`zh-Hans` / `en-US` / `mixed`（中英都开）；NULL 表示还没判过，
运行时按主引擎的正文文本判一次再写回来。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 22
DESCRIPTION = "page.ocr_language：每页识别语言（自动判定，可覆盖）"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE page ADD COLUMN ocr_language TEXT")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
