"""迁移注册表。新增迁移时在这里追加，版本号必须递增且唯一。"""

from __future__ import annotations

from ..migration import Migration
from . import (
    migration_0001_project_page,
    migration_0002_recognition,
    migration_0003_event,
    migration_0004_export_record,
)

MIGRATIONS: list[Migration] = [
    migration_0001_project_page.MIGRATION,
    migration_0002_recognition.MIGRATION,
    migration_0003_event.MIGRATION,
    migration_0004_export_record.MIGRATION,
]

LATEST_VERSION = max(migration.version for migration in MIGRATIONS)
