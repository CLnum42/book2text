"""迁移 0021：行级**逐字框**的位置（任务 59 预留）。

背景：RapidOCR 支持 ``return_word_box=True``，中文返回的是逐字四点框
（实测 ``('说', 0.99985, [[322,119],[348,119],[348,155],[322,155]])``，
耗时 2.82s → 2.77s，没有代价）。字级坐标一旦用上，能做的事是"按字定位"：
现在行内差异只能整行标红，有字框之后可以指到具体哪个字。

**这一刀只留字段，不写入、不读**：是否重识别由用户拍板。列先就位，免得
到时候再改表、再迁移一遍已有项目。

格式（将来写入时）：``block_line.word_boxes`` 存 JSON 数组，每项
``{"char": "说", "bbox": [x0, y0, x1, y1]}``，坐标与行框同口径（归一化、原点左上）。
NULL 表示没有字级坐标（老数据 / 引擎没给）。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 21
DESCRIPTION = "block_line.word_boxes：逐字框（预留，暂不写入）"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE block_line ADD COLUMN word_boxes TEXT")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
