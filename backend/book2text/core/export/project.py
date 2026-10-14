"""项目导出：从项目数据库取块，按说明书第 9 节算段、清理、落盘（说明书 6.6 / 12.1）。

**这是"成果出得去"的那一步。** 在此之前导出走的是 Phase 0 的临时上传流程：
客户端把块提交上来、服务端算完把文本还回去——项目里已识别的几百页导不出来。
现在导出是**项目自己的操作**：读 `block` / `block_line`，跑 9.1–9.5，
按说明书 12.1 写进 ``exports/<export_id>/``，并记一条 `export_record`。

**规则实现仍然只有一份**（`core/export/` 下的 segments / cleanup / txt / jsonl / manifest），
本模块只负责"把库里的块喂进去、把结果写到该写的地方"。

导出目录命名（说明书 12.1）：``exports/20250301-1432_txt/`` 内含数据文件与 manifest.json。
格式选"两种"时用 ``_txt-jsonl``，一个目录里放两份数据文件——它们属于同一次导出。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ... import __version__
from ..ocr.adapters import RapidOcrAdapter
from ..project import blocks as blocks_module
from ..project import library as library_module
from ..project.library import Page
from ..storage import db as db_module
from . import cleanup, jsonl as jsonl_module, manifest as manifest_module
from . import segments as segments_module, txt
from .joining import join_lines

EXPORTS_DIR_NAME = library_module.EXPORTS_DIR_NAME

FORMAT_TXT = "txt"
FORMAT_JSONL = "jsonl"
FORMAT_BOTH = "both"
FORMATS = (FORMAT_TXT, FORMAT_JSONL, FORMAT_BOTH)

# 数据文件名（说明书 12.1 的例子是 clean.txt）
TXT_FILE_NAME = "clean.txt"
JSONL_FILE_NAME = "segments.jsonl"
MANIFEST_FILE_NAME = "manifest.json"

# 默认导出的页面类型（说明书 6.6："正文与标题（默认）……'其他'类型默认不导出，可勾选"）
DEFAULT_PAGE_TYPES = ("body",)


class ExportError(Exception):
    """导出过程中的错误（范围为空、写盘失败等）。"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class ExportOptions:
    """说明书 6.6 的导出选项。"""

    format: str = FORMAT_TXT
    confirmed_only: bool = False
    page_types: tuple[str, ...] = DEFAULT_PAGE_TYPES
    page_numbers: tuple[int, ...] | None = None      # 页面范围；None = 全书
    include_footnotes: bool = False
    include_captions: bool = True
    include_other: bool = False
    page_markers: bool = False
    # 9.3 的清理规则开关
    exclude_header_footer: bool = True
    merge_lines_in_block: bool = True
    restore_hyphenation: bool = True
    normalize_newlines: bool = True
    strip_line_whitespace: bool = True

    def rules(self) -> cleanup.CleanupRules:
        return cleanup.CleanupRules(
            exclude_header_footer=self.exclude_header_footer,
            merge_lines_in_block=self.merge_lines_in_block,
            restore_hyphenation=self.restore_hyphenation,
            normalize_newlines=self.normalize_newlines,
            strip_line_whitespace=self.strip_line_whitespace,
        )

    def excluded_block_types(self) -> frozenset[str]:
        """按 9.3 的规则与 6.6 的内容类型选项算出要排除的块类型。"""
        excluded = set(self.rules().excluded_block_types)
        if not self.include_footnotes:
            excluded.add(segments_module.BLOCK_TYPE_FOOTNOTE)
        if not self.include_captions:
            excluded.add(segments_module.BLOCK_TYPE_CAPTION)
        if not self.include_other:
            excluded.add(segments_module.BLOCK_TYPE_OTHER)
        return frozenset(excluded)

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": self.format,
            "confirmed_only": self.confirmed_only,
            "page_types": list(self.page_types),
            "page_numbers": list(self.page_numbers) if self.page_numbers else None,
            "include_footnotes": self.include_footnotes,
            "include_captions": self.include_captions,
            "include_other": self.include_other,
            "page_markers": self.page_markers,
            "exclude_header_footer": self.exclude_header_footer,
            "merge_lines_in_block": self.merge_lines_in_block,
            "restore_hyphenation": self.restore_hyphenation,
            "normalize_newlines": self.normalize_newlines,
            "strip_line_whitespace": self.strip_line_whitespace,
        }


@dataclass(frozen=True)
class ExportRecord:
    export_id: str
    format: str
    scope: dict
    rules: dict
    file_paths: tuple[str, ...]
    segment_count: int
    char_count: int
    unreviewed_count: int
    uncertain_count: int
    created_at: str
    status: str

    @property
    def directory(self) -> str:
        """导出目录名（相对项目目录），就是 export_id。"""
        return self.export_id

    def to_dict(self) -> dict[str, Any]:
        return {
            "export_id": self.export_id,
            "format": self.format,
            "scope": self.scope,
            "rules": self.rules,
            "file_paths": list(self.file_paths),
            "segment_count": self.segment_count,
            "char_count": self.char_count,
            "unreviewed_count": self.unreviewed_count,
            "uncertain_count": self.uncertain_count,
            "created_at": self.created_at,
            "status": self.status,
        }


def _row_to_record(row) -> ExportRecord:
    def _load(raw: str | None, fallback):
        try:
            return json.loads(raw) if raw else fallback
        except json.JSONDecodeError:
            return fallback

    return ExportRecord(
        export_id=row["export_id"],
        format=row["format"],
        scope=_load(row["scope_json"], {}),
        rules=_load(row["rules_json"], {}),
        file_paths=tuple(_load(row["file_paths"], [])),
        segment_count=int(row["segment_count"]),
        char_count=int(row["char_count"]),
        unreviewed_count=int(row["unreviewed_count"]),
        uncertain_count=int(row["uncertain_count"]),
        created_at=row["created_at"],
        status=row["status"],
    )


# ---------------------------------------------------------------- 取块与算段

@dataclass(frozen=True)
class Prepared:
    """跑完 9.2 行合并与 9.1 段生成之后的中间结果。"""

    options: ExportOptions
    sources: tuple[segments_module.SegmentSource, ...]
    segments: tuple[segments_module.Segment, ...]
    pages: tuple[Page, ...]                      # 参与导出的页面记录
    dropped_pages: tuple[Page, ...]              # 被排除的页面（用于预检说明）


def _prepare(project_id: str, *, library: Path | None, options: ExportOptions) -> Prepared:
    if options.format not in FORMATS:
        raise ExportError(f"未知的格式：{options.format!r}（可选：{'、'.join(FORMATS)}）")

    target_library = library if library is not None else library_module.default_library_dir()
    pages = library_module.list_pages(project_id, library=target_library)
    wanted_pages = set(options.page_numbers) if options.page_numbers else None
    rules = options.rules()

    selected: list[Page] = []
    dropped: list[Page] = []
    for page in pages:
        if not page.include:
            dropped.append(page)
            continue
        if wanted_pages is not None and page.page_no not in wanted_pages:
            dropped.append(page)
            continue
        if options.page_numbers is None and page.page_type not in options.page_types:
            # 明确指定了页码时不再按页面类型过滤：用户已经指名道姓了
            dropped.append(page)
            continue
        selected.append(page)

    exporting = {page.page_no for page in selected}
    sources: list[segments_module.SegmentSource] = []
    for block in blocks_module.list_blocks(project_id, library=target_library):
        if block.page_no not in exporting:
            continue
        # 导出的是 Block.text（说明书 5.3：保留行内换行），按 `\n` 拆回行再做 9.2 的合并。
        # 不要用 block_line 的文本：那是识别原文，人工改过的字会丢。
        text, hyphenations = _join_block(block.text.split("\n"), rules)
        sources.append(
            segments_module.SegmentSource(
                block_id=block.block_id,
                page_no=block.page_no,
                order_index=block.order_index,
                block_type=block.block_type,
                text=text,
                include=block.include,
                deleted=False,
                review_status=block.review_status,
                continues_to_next=block.continues_to_next,
                ocr_text=block.ocr_text,
                hyphenations=hyphenations,
            )
        )

    built = segments_module.build_segments(
        sources,
        excluded_types=options.excluded_block_types(),
        confirmed_only=options.confirmed_only,
    )
    return Prepared(
        options=options,
        sources=tuple(sources),
        segments=tuple(built),
        pages=tuple(selected),
        dropped_pages=tuple(dropped),
    )


def _join_block(lines: list[str], rules: cleanup.CleanupRules):
    """把一个块的行拼成段落文本（说明书 9.2 / 9.3），返回 (文本, 断词还原记录)。"""
    cleaned = cleanup.clean_lines(lines, rules)
    if not rules.merge_lines_in_block:
        return "\n".join(line for line in cleaned if line), ()
    result = join_lines(cleaned, restore_hyphenation=rules.restore_hyphenation)
    return result.text, result.hyphenations


# ---------------------------------------------------------------- 预检

def preflight(project_id: str, *, library: Path | None = None, options: ExportOptions) -> dict:
    """预检摘要（说明书 6.6 第 5 条）：不动文件，只算“这次导出会是什么样”。"""
    prepared = _prepare(project_id, library=library, options=options)
    segments = prepared.segments
    states = blocks_module.page_recognition_states(
        project_id,
        library=library if library is not None else library_module.default_library_dir(),
    )

    # 未识别或识别失败的纳入页：导出的内容会缺这些页，必须让用户看见
    unfinished = [
        page.page_no
        for page in prepared.pages
        if (states.get(page.page_id) is None)
        or states[page.page_id].status
        in (blocks_module.STATUS_UNRECOGNIZED, blocks_module.STATUS_FAILED)
    ]

    return {
        "input_blocks": len(prepared.sources),
        "segment_count": len(segments),
        "char_count": sum(len(segment.text) for segment in segments),
        "page_count": len({page for segment in segments for page in segment.pages}),
        "pages": sorted({page for segment in segments for page in segment.pages}),
        "exported_pages": [page.page_no for page in prepared.pages],
        "dropped_pages": [page.page_no for page in prepared.dropped_pages],
        "unreviewed_segments": sum(1 for s in segments if s.review.unreviewed),
        "uncertain_segments": sum(1 for s in segments if s.review.uncertain),
        "merged_segments": sum(1 for s in segments if len(s.block_ids) > 1),
        "hyphenations_restored": sum(len(s.hyphenations) for s in segments),
        "unfinished_pages": sorted(unfinished),
        "excluded_block_types": sorted(prepared.options.excluded_block_types()),
        "rules": prepared.options.to_dict(),
    }


def preview(project_id: str, *, library: Path | None = None, options: ExportOptions,
            limit: int = 20000) -> dict:
    """预览（说明书 6.6 第 7 条）：算一遍但不写文件。

    返回里带上**逐段记录**（与 JSONL 里的形状一致）：导出对照模式要用它做
    "段 → 块 → 页"的溯源——点一段就知道它来自哪一页、哪些块（说明书 9.1 的段 ID 与来源）。
    """
    prepared = _prepare(project_id, library=library, options=options)
    text = _render_text(prepared)
    content = _render_jsonl(prepared, library=library)
    labels = {page.page_no: page.page_label for page in prepared.pages if page.page_label}
    records = [
        jsonl_module.segment_to_record(
            segment,
            page_labels=labels,
            engine_id=_engine_id(),
            engine_version=_engine_version(),
        )
        for segment in prepared.segments
    ]
    return {
        "preflight": preflight(project_id, library=library, options=options),
        "text": text[:limit],
        "jsonl": content[:limit],
        "truncated": len(text) > limit,
        "segments": records,
        "segment_count": len(records),
    }


# ---------------------------------------------------------------- 生成与落盘

def _render_text(prepared: Prepared) -> str:
    labels = {page.page_no: page.page_label for page in prepared.pages if page.page_label}
    return txt.render_txt(
        prepared.segments,
        options=txt.TxtOptions(
            page_markers=prepared.options.page_markers,
            include_footnotes=prepared.options.include_footnotes,
        ),
        page_labels=labels,
    )


def _render_jsonl(prepared: Prepared, *, library: Path | None) -> str:
    labels = {page.page_no: page.page_label for page in prepared.pages if page.page_label}
    return jsonl_module.render_jsonl(
        prepared.segments,
        page_labels=labels,
        engine_id=_engine_id(),
        engine_version=_engine_version(),
    )


def _engine_id() -> str:
    try:
        return RapidOcrAdapter().engine_id
    except Exception:  # pragma: no cover - 引擎缺失不影响导出
        return ""


def _engine_version() -> str:
    try:
        return RapidOcrAdapter().version()
    except Exception:  # pragma: no cover
        return ""


def _export_dir_name(moment: datetime, export_format: str) -> str:
    """目录名与 manifest 里的 ``export_id`` **必须一致**（记录的主键就是目录名）。

    因此这里直接用格式名当后缀（`txt` / `jsonl` / `both`），
    与 `manifest.export_id(moment, scope.format)` 的算法保持同源。
    """
    return manifest_module.export_id(moment, export_format)


def run_export(
    project_id: str,
    *,
    library: Path | None = None,
    options: ExportOptions,
) -> dict[str, Any]:
    """生成导出文件并记一条 `export_record`（说明书 6.6 / 12.1）。"""
    target_library = library if library is not None else library_module.default_library_dir()
    project = library_module.load_project(project_id, library=target_library)
    if project.directory is None:  # pragma: no cover
        raise ExportError("项目缺少目录信息")

    prepared = _prepare(project_id, library=target_library, options=options)
    if not prepared.segments:
        raise ExportError(
            "按照当前设置没有任何内容可以导出：块可能全被排除、页面类型不在导出范围内，"
            "或「仅已确认」下没有已确认的块"
        )

    moment = _now()
    # 说明书 12.1 的目录名精确到分钟；同一分钟内连做两次就加后缀，避免目录与记录撞名
    base_name = _export_dir_name(moment, options.format)
    directory = project.directory / EXPORTS_DIR_NAME / base_name
    suffix = 2
    while directory.exists():
        directory = project.directory / EXPORTS_DIR_NAME / f"{base_name}-{suffix}"
        suffix += 1
    directory.mkdir(parents=True)

    written: list[str] = []
    data_files: list[str] = []
    if options.format in (FORMAT_TXT, FORMAT_BOTH):
        (directory / TXT_FILE_NAME).write_text(_render_text(prepared), encoding="utf-8")
        written.append(TXT_FILE_NAME)
        data_files.append(TXT_FILE_NAME)
    if options.format in (FORMAT_JSONL, FORMAT_BOTH):
        (directory / JSONL_FILE_NAME).write_text(
            _render_jsonl(prepared, library=target_library), encoding="utf-8"
        )
        written.append(JSONL_FILE_NAME)
        data_files.append(JSONL_FILE_NAME)

    manifest = manifest_module.build_manifest(
        app_version=__version__,
        scope=manifest_module.ExportScope(
            page_numbers=tuple(sorted({page for s in prepared.segments for page in s.pages})),
            format=options.format,
            confirmed_only=options.confirmed_only,
        ),
        rules=prepared.options.to_dict(),
        segments=prepared.segments,
        data_file=data_files[0],
        source=manifest_module.SourceInfo(
            project_name=project.name,
            file_name=project.source_file_name,
            sha256=project.source_sha256,
        ),
        exported_at=moment,
        extra_files=data_files[1:],
    )
    (directory / MANIFEST_FILE_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    written.append(MANIFEST_FILE_NAME)

    export_id = directory.name
    _insert_record(
        target_library,
        project_id,
        export_id=export_id,
        options=prepared.options,
        manifest=manifest,
        file_paths=written,
        moment=moment,
    )
    return {
        "record": load_record(project_id, export_id, library=target_library).to_dict(),
        "manifest": manifest,
        "preflight": preflight(project_id, library=target_library, options=options),
        "files": written,
    }


def _insert_record(
    library: Path,
    project_id: str,
    *,
    export_id: str,
    options: ExportOptions,
    manifest: dict,
    file_paths: list[str],
    moment: datetime,
) -> None:
    directory = library_module.project_dir(library, project_id)
    stats = manifest.get("stats") or {}
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO export_record (
                export_id, format, scope_json, rules_json, file_paths,
                segment_count, char_count, unreviewed_count, uncertain_count,
                created_at, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded')
            """,
            (
                export_id,
                options.format,
                json.dumps(manifest.get("scope") or {}, ensure_ascii=False),
                json.dumps(options.to_dict(), ensure_ascii=False),
                json.dumps(file_paths, ensure_ascii=False),
                int(stats.get("segment_count") or 0),
                int(stats.get("char_count") or 0),
                int(stats.get("unreviewed_segments") or 0),
                int(stats.get("uncertain_segments") or 0),
                moment.isoformat(timespec="seconds"),
            ),
        )
        conn.execute(
            "UPDATE project SET updated_at = ?", (moment.isoformat(timespec="seconds"),)
        )
        conn.commit()


# ---------------------------------------------------------------- 记录与文件

def list_records(project_id: str, *, library: Path | None = None) -> list[ExportRecord]:
    target = library if library is not None else library_module.default_library_dir()
    directory = library_module.project_dir(target, project_id)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT * FROM export_record ORDER BY created_at DESC, export_id DESC"
        ).fetchall()
    return [_row_to_record(row) for row in rows]


def load_record(
    project_id: str, export_id: str, *, library: Path | None = None
) -> ExportRecord:
    target = library if library is not None else library_module.default_library_dir()
    directory = library_module.project_dir(target, project_id)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT * FROM export_record WHERE export_id = ?", (export_id,)
        ).fetchone()
    if row is None:
        raise ExportError(f"找不到这次导出：{export_id}")
    return _row_to_record(row)


def resolve_file(record: ExportRecord, project_dir_path: Path, file_name: str | None) -> Path:
    """把导出记录里的文件名解析成真实路径（**只允许记录里列出的文件**）。"""
    allowed = set(record.file_paths)
    name = file_name or record.file_paths[0]
    if name not in allowed:
        raise ExportError(f"这次导出里没有这个文件：{name}")
    path = project_dir_path / EXPORTS_DIR_NAME / record.export_id / name
    if not path.is_file():
        raise ExportError(f"导出文件不在了：{name}")
    return path
