"""manifest.json 的生成（说明书 9.5）。

说明书要求 manifest 包含：**项目名、源文件名与 SHA-256、导出时间、应用版本、
导出范围、启用的规则、断词还原位置列表、统计数据**。

**为什么"断词还原位置列表"要单独记：** 说明书 9.2 要求在 manifest 里记录所有被
"英文断词还原"处理过的位置，"便于抽查（例如 ``self-`` + ``evident`` 这类真实连字符
可能被误处理）"。也就是说这个列表是**给人复核用的**，因此每条都带段号与前后片段，
而不是只记一个偏移量。

**`export_id` 是本模块的补充：** 说明书 12.1 的导出目录是
``exports/20250301-1432_txt/``，时间戳 + 格式即导出标识。当前没有项目目录，
文件由浏览器下载，因此把标识放进 manifest 里，让每次导出仍可区分。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone

from .segments import Segment

MANIFEST_SCHEMA_ID = "book2text.manifest.v1"


@dataclass(frozen=True)
class SourceInfo:
    """源文件信息。没有项目模型时这些字段可以为空（如实留空，不编造）。"""

    project_name: str | None = None
    file_name: str | None = None
    sha256: str | None = None


@dataclass(frozen=True)
class ExportScope:
    """导出范围。"""

    page_numbers: tuple[int, ...]
    format: str                       # "txt" / "jsonl"
    confirmed_only: bool = False

    def to_dict(self) -> dict[str, object]:
        return {
            "pages": list(self.page_numbers),
            "page_count": len(self.page_numbers),
            "format": self.format,
            "confirmed_only": self.confirmed_only,
        }


def export_id(exported_at: datetime, export_format: str) -> str:
    """按说明书 12.1 的目录命名习惯生成导出标识，如 ``20250301-1432_txt``。"""
    return f"{exported_at.strftime('%Y%m%d-%H%M')}_{export_format}"


def build_manifest(
    *,
    app_version: str,
    scope: ExportScope,
    rules: Mapping[str, object],
    segments: Sequence[Segment],
    data_file: str,
    source: SourceInfo | None = None,
    exported_at: datetime | None = None,
    extra_files: Sequence[str] = (),
) -> dict[str, object]:
    """生成 manifest 内容。

    ``exported_at`` 缺省用当前 UTC 时间；显式传入便于测试与复现。
    """
    moment = exported_at or datetime.now(timezone.utc)
    info = source or SourceInfo()

    hyphenations: list[dict[str, object]] = []
    for segment in segments:
        for record in segment.hyphenations:
            hyphenations.append(
                {
                    "segment_id": segment.segment_id,
                    "seq": segment.seq,
                    **record.to_dict(),
                }
            )

    char_count = sum(len(segment.text) for segment in segments)
    page_numbers = sorted({page for segment in segments for page in segment.pages})

    return {
        "schema": MANIFEST_SCHEMA_ID,
        "export_id": export_id(moment, scope.format),
        "exported_at": moment.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "app_version": app_version,
        "project": {
            "name": info.project_name or "",
            "source_file_name": info.file_name or "",
            "source_sha256": info.sha256 or "",
        },
        "scope": scope.to_dict(),
        "rules": dict(rules),
        "files": [data_file, *extra_files, "manifest.json"],
        "hyphenations_restored": hyphenations,
        "stats": {
            "segment_count": len(segments),
            "block_count": sum(len(segment.block_ids) for segment in segments),
            "char_count": char_count,
            "page_count": len(page_numbers),
            "pages": page_numbers,
            "merged_segments": sum(1 for s in segments if len(s.block_ids) > 1),
            "unreviewed_segments": sum(1 for s in segments if s.review.unreviewed),
            "uncertain_segments": sum(1 for s in segments if s.review.uncertain),
            "hyphenations_restored": len(hyphenations),
        },
        "notes": [
            "项目名与源文件 SHA-256 在无项目模型时为空字符串（见 docs/known-limitations.md L-09）",
            "断词还原位置只需人工抽查——被处理的可能包含 self- + evident 这类真实连字符",
        ],
    }
