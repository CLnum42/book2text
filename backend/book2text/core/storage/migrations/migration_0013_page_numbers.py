"""迁移 0013：印刷页码（page.printed_page / source）与项目级页码模板（任务 55）。

用户 2026-10-23 的口径：大多数页码坐标在页面上是稳定的（奇偶页可能不同但会重复），
所以不该逐页确认——聚出位置模板 → 确认一次 → 全书自动填充 → 只把异常页推给人。

三列：

- ``page.printed_page``：这一页的**印刷页码**（TEXT，允许罗马数字）。NULL = 还没确定。
  与 ``page.page_label`` 分开：老字段来自 PDF 自己的页标签，可能为空、也可能是别的编号；
  模板填充 / 以后的手动映射都写这一列，来源记在下一列。
- ``page.printed_page_source``：``template``（按页码模板自动填充）/ ``manual``（人工）
  / NULL（还没填）。以后逐页手动改映射时用 ``manual``，本任务不提供该入口。
- ``project.page_number_template``：用户确认采用的页码模板（JSON 文本，可空）。
  包含位置（顶部 / 底部 / 左侧 / 右侧）、奇偶交替模式、中心坐标、覆盖页数、
  示例页、识别到的页码值序列与采用时间。**不存像素 / 点数**，坐标一律归一化。

老项目打开时自动升级：两列可空、模板为 NULL，行为不变（导出不读这三列）。
"""

from __future__ import annotations

from sqlite3 import Connection

from ..migration import Migration

VERSION = 13
DESCRIPTION = "印刷页码：page.printed_page / printed_page_source + project.page_number_template"


def apply(conn: Connection) -> None:
    conn.execute("ALTER TABLE page ADD COLUMN printed_page TEXT")
    conn.execute("ALTER TABLE page ADD COLUMN printed_page_source TEXT")
    conn.execute("ALTER TABLE project ADD COLUMN page_number_template TEXT")


MIGRATION = Migration(version=VERSION, description=DESCRIPTION, apply=apply)
