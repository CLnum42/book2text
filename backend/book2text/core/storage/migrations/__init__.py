"""迁移注册表。新增迁移时在这里追加，版本号必须递增且唯一。"""

from __future__ import annotations

from ..migration import Migration
from . import (
    migration_0001_project_page,
    migration_0002_recognition,
    migration_0003_event,
    migration_0004_export_record,
    migration_0005_collaboration,
    migration_0006_layout,
    migration_0007_page_setup,
    migration_0008_page_types,
    migration_0009_page_layout,
    migration_0010_auto_apply,
    migration_0011_margin_box,
    migration_0012_margin_suggestion,
    migration_0013_page_numbers,
    migration_0014_page_number_ranges,
    migration_0015_layout_workflow,
    migration_0016_page_confirmation,
    migration_0017_page_auto_margin,
    migration_0018_diff_ack,
    migration_0019_page_margin_method,
    migration_0020_continuation_review,
    migration_0021_line_word_boxes,
    migration_0022_page_ocr_language,
)

MIGRATIONS: list[Migration] = [
    migration_0001_project_page.MIGRATION,
    migration_0002_recognition.MIGRATION,
    migration_0003_event.MIGRATION,
    migration_0004_export_record.MIGRATION,
    migration_0005_collaboration.MIGRATION,
    migration_0006_layout.MIGRATION,
    migration_0007_page_setup.MIGRATION,
    migration_0008_page_types.MIGRATION,
    migration_0009_page_layout.MIGRATION,
    migration_0010_auto_apply.MIGRATION,
    migration_0011_margin_box.MIGRATION,
    migration_0012_margin_suggestion.MIGRATION,
    migration_0013_page_numbers.MIGRATION,
    migration_0014_page_number_ranges.MIGRATION,
    migration_0015_layout_workflow.MIGRATION,
    migration_0016_page_confirmation.MIGRATION,
    migration_0017_page_auto_margin.MIGRATION,
    migration_0018_diff_ack.MIGRATION,
    migration_0019_page_margin_method.MIGRATION,
    migration_0020_continuation_review.MIGRATION,
    migration_0021_line_word_boxes.MIGRATION,
    migration_0022_page_ocr_language.MIGRATION,
]

LATEST_VERSION = max(migration.version for migration in MIGRATIONS)
