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
import threading
import time
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ... import __version__
from ..ocr.adapters import RapidOcrAdapter
from ..project import blocks as blocks_module
from ..project import review_status
from ..project import library as library_module
from ..project import structure as structure_module
from ..project.library import Page
from ..storage import db as db_module
from . import cleanup, header_cleanup, jsonl as jsonl_module, manifest as manifest_module
from . import margin_rules as margin_rules_module
from . import segments as segments_module, streams as streams_module, txt
from .joining import join_lines

EXPORTS_DIR_NAME = library_module.EXPORTS_DIR_NAME

FORMAT_TXT = "txt"
FORMAT_JSONL = "jsonl"
FORMAT_BOTH = "both"
FORMATS = (FORMAT_TXT, FORMAT_JSONL, FORMAT_BOTH)

# 三条流的文件名（第 37 号任务）：不让人猜哪个是哪个
BODY_TXT_FILE_NAME = "body.txt"
BODY_JSONL_FILE_NAME = "body.jsonl"
NOTES_TXT_FILE_NAME = "notes.txt"
NOTES_JSONL_FILE_NAME = "notes.jsonl"
META_FILE_NAME = "meta.json"
MANIFEST_FILE_NAME = "manifest.json"

# 兼容旧代码里对正文文件名的引用（新导出不再写 clean.txt）
TXT_FILE_NAME = BODY_TXT_FILE_NAME
JSONL_FILE_NAME = BODY_JSONL_FILE_NAME

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
    # 注释流（footnote + margin_note）默认不生成文件；勾选「同时导出注释」才写 notes.*
    include_notes: bool = False
    # 按版心判定正文（项目设置，默认关）。由 `_prepare` 从项目设置解析，不直接由 API 传。
    margin_judgement: bool = False
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
        # 插图 / 装饰永远不进正文；它们不参与"内容类型"开关
        excluded = set(self.rules().excluded_block_types) | set(segments_module.TEXT_FREE_TYPES)
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
            "include_notes": self.include_notes,
            "margin_judgement": self.margin_judgement,
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
    """跑完 9.2 行合并与 9.1 段生成之后的中间结果（正文 + 注释 + 元数据）。"""

    options: ExportOptions
    sources: tuple[segments_module.SegmentSource, ...]
    segments: tuple[segments_module.Segment, ...]          # 正文流
    notes: tuple[streams_module.NoteEntry, ...]            # 注释流
    meta: dict[str, Any]                                    # 元数据（一页一条）
    blocks: tuple[Any, ...]                                 # 导出范围内页面的全部块
    pages: tuple[Page, ...]                      # 参与导出的页面记录
    dropped_pages: tuple[Page, ...]              # 被排除的页面（用于预检说明）
    # 按版心判定（任务 51）：开关关掉时为空、不参与任何行为
    margin_enabled: bool = False
    margin_layouts: dict[int, Any] | None = None


def _prepare(project_id: str, *, library: Path | None, options: ExportOptions) -> Prepared:
    if options.format not in FORMATS:
        raise ExportError(f"未知的格式：{options.format!r}（可选：{'、'.join(FORMATS)}）")

    target_library = library if library is not None else library_module.default_library_dir()
    project = library_module.load_project(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    wanted_pages = set(options.page_numbers) if options.page_numbers else None
    rules = options.rules()
    # 项目级开关：任务 34 起**默认开**（显式关过才关）。关着时下面的版心判定
    # 完全不参与，导出结果与升级前逐字节相同。
    margin_enabled = library_module.margin_judgement_enabled(project)
    if margin_enabled:
        options = replace(options, margin_judgement=True)

    selected: list[Page] = []
    dropped: list[Page] = []
    for page in pages:
        # 页面去留由 page_type 决定；这里只按类型（或用户明确点名的页码）过滤，
        # 不再看派生列 include——否则显式选「正文排除」也导不出来。
        if wanted_pages is not None and page.page_no not in wanted_pages:
            dropped.append(page)
            continue
        if options.page_numbers is None and page.page_type not in options.page_types:
            # 明确指定了页码时不再按页面类型过滤：用户已经指名道姓了
            dropped.append(page)
            continue
        selected.append(page)

    exporting = {page.page_no for page in selected}
    page_blocks = [
        block
        for block in blocks_module.list_blocks(project_id, library=target_library)
        if block.page_no in exporting
    ]
    blocks_by_page: dict[int, list] = {}
    for block in page_blocks:
        blocks_by_page.setdefault(block.page_no, []).append(block)

    margin_layouts = (
        margin_rules_module.classify_pages(
            selected, blocks_by_page, project, enabled=True
        )
        if margin_enabled
        else {}
    )

    # 任务 74：每页**第一个块**（按 order_index）才可能带页眉行；别一页里每个块都去剥
    first_block_of_page: dict[int, str] = {}
    for block in sorted(page_blocks, key=lambda item: (item.page_no, item.order_index)):
        first_block_of_page.setdefault(block.page_no, block.block_id)

    sources: list[segments_module.SegmentSource] = []
    for block in page_blocks:
        include = block.include
        if margin_enabled:
            layout = margin_layouts.get(block.page_no)
            # 版心外不进正文；没有生效版心的页（unset / none）退回块类型判定。
            if layout is not None and layout.applied:
                include = include and block.block_id in layout.inside_ids
        # 导出的是 Block.text（说明书 5.3：保留行内换行），按 `\n` 拆回行再做 9.2 的合并。
        # 不要用 block_line 的文本：那是识别原文，人工改过的字会丢。
        raw_lines = block.text.split("\n")
        # 任务 80：**整块就是一行页码**的块，无论排在第几个，都肯定是页眉而不是正文
        # （目录页那种 "Page viii 153 155…" 不是整行匹配，不会被误删）。
        # 这本书第 38 页的 `Page 1` 就是独立块、且不是该页第一个块，靠首块规则漏掉了。
        if len(raw_lines) == 1 and header_cleanup.is_page_line(raw_lines[0]):
            continue
        # 任务 74：**页眉页码行**（`Page 28`）识别时落成了 paragraph 块，
        # 会被当正文导出。只从"每页第一个块的第一行"判断（严格的窄规则）——
        # 全书行级正则替换踩过坑：正文里真有整行是"红楼梦"的。
        if first_block_of_page.get(block.page_no) == block.block_id:
            raw_lines = header_cleanup.strip_leading_header_line(raw_lines)
            if not raw_lines:
                # 整块就是一行页码：这一块不进正文
                continue
        text, hyphenations, line_spans = _join_block(raw_lines, rules)
        sources.append(
            segments_module.SegmentSource(
                block_id=block.block_id,
                page_no=block.page_no,
                order_index=block.order_index,
                block_type=block.block_type,
                text=text,
                include=include,
                deleted=False,
                review_status=block.review_status,
                continues_to_next=block.continues_to_next,
                ocr_text=block.ocr_text,
                hyphenations=hyphenations,
                line_spans=line_spans,
            )
        )

    # 正文流只收 body + heading：图注 / 脚注 / 页眉 / 页码 / 其他都不进正文
    built = segments_module.build_segments(
        sources,
        allowed_types=streams_module.BODY_BLOCK_TYPES,
        confirmed_only=options.confirmed_only,
    )

    # 注释流：footnote 单独成条，引用位置取"最近的前一个正文块/段"
    notes = streams_module.build_notes(
        page_blocks,
        built,
        text_for_block=lambda block: _join_block(block.text.split("\n"), rules)[0],
        confirmed_only=options.confirmed_only,
    )

    # 行归属统计（版面确认那一刀加的 layout_status），按页汇总
    page_of_block = {block.block_id: block.page_no for block in page_blocks}
    line_stats: dict[int, dict[str, int]] = {
        page.page_no: {"assigned": 0, "conflict": 0, "unassigned": 0}
        for page in selected
    }
    for line in blocks_module.list_block_lines(project_id, library=target_library):
        page_no = page_of_block.get(line.block_id)
        if page_no is None:
            continue
        line_stats[page_no][line.layout_status] = (
            line_stats[page_no].get(line.layout_status, 0) + 1
        )

    meta = streams_module.page_metadata(
        selected,
        blocks_by_page,
        line_stats,
        margin_layouts=margin_layouts,
        margin_enabled=margin_enabled,
    )

    return Prepared(
        options=options,
        sources=tuple(sources),
        segments=tuple(built),
        notes=tuple(notes),
        meta=meta,
        blocks=tuple(page_blocks),
        pages=tuple(selected),
        dropped_pages=tuple(dropped),
        margin_enabled=margin_enabled,
        margin_layouts=margin_layouts,
    )


def _join_block(lines: list[str], rules: cleanup.CleanupRules):
    """把一个块的行拼成段落文本（说明书 9.2 / 9.3）。

    返回 (文本, 断词还原记录, 行区间)。行区间供阅读审校把差异标到行内。
    """
    cleaned = cleanup.clean_lines(lines, rules)
    if not rules.merge_lines_in_block:
        text = "\n".join(line for line in cleaned if line)
        spans = []
        offset = 0
        for index, line in enumerate(cleaned):
            if not line:
                continue
            spans.append({"line_index": index, "start": offset, "end": offset + len(line)})
            offset += len(line) + 1
        return text, (), tuple(spans)
    result = join_lines(cleaned, restore_hyphenation=rules.restore_hyphenation)
    return result.text, result.hyphenations, result.line_spans


# ---------------------------------------------------------------- 预检

def preflight(project_id: str, *, library: Path | None = None, options: ExportOptions) -> dict:
    """预检摘要（说明书 6.6 第 5 条）：不动文件，只算“这次导出会是什么样”。"""
    prepared = _prepare(project_id, library=library, options=options)
    segments = prepared.segments
    target_library = library if library is not None else library_module.default_library_dir()
    states = blocks_module.page_recognition_states(project_id, library=target_library)
    # 按版心判定打开时，"页眉 / 页码还没标类型"的嫌疑提示不再适用：
    # 版心外本来就不进正文，再提示会自相矛盾。
    chrome = (
        []
        if prepared.margin_enabled
        else _chrome_suspects(project_id, library=target_library, options=options)
    )
    # 版面确认是块级状态；预检只报"整本有没有人确认过"，不阻止导出（说明书 1.6 / D-051）
    all_blocks = blocks_module.list_blocks(project_id, library=target_library)
    layout_confirmed = sum(1 for block in all_blocks if block.layout_confirmed)
    # 整页版面确认（0009）：只统计这次导出范围内的页；未确认只警告、不阻断
    layout_unconfirmed_pages = [
        page.page_no for page in prepared.pages if not page.layout_confirmed
    ]

    # 未识别或识别失败的纳入页：导出的内容会缺这些页，必须让用户看见
    unfinished = [
        page.page_no
        for page in prepared.pages
        if (states.get(page.page_id) is None)
        or states[page.page_id].status
        in (blocks_module.STATUS_UNRECOGNIZED, blocks_module.STATUS_FAILED)
    ]

    notes = prepared.notes
    meta_summary = prepared.meta.get("summary", {})
    body_char_count = sum(len(segment.text) for segment in segments)
    note_char_count = sum(len(note.text) for note in notes)

    layouts = prepared.margin_layouts or {}
    margin_exclusion = _margin_exclusion(prepared)
    margin_blocks = {
        "inside": sum(len(layout.inside_ids) for layout in layouts.values()),
        "outside": sum(len(layout.outside_ids) for layout in layouts.values()),
        "page_number": sum(len(layout.page_number_values) for layout in layouts.values()),
        # 任务 34：被版心排除的块数 + 类型分布（页眉 / 页脚 / 页码 / 装饰等）。
        # judged_* 只算**这一页真的有生效版心**的块（没有版心的页不参与版心判定）。
        "judged_inside": margin_exclusion["inside_blocks"],
        "judged_outside": margin_exclusion["outside_blocks"],
        "excluded": margin_exclusion["excluded_blocks"],
        "excluded_by_type": margin_exclusion["excluded_by_type"],
    }
    margin_notes_total = sum(len(layout.note_ids) for layout in layouts.values())
    margin_notes_inside = sum(len(layout.note_inside_ids) for layout in layouts.values())
    margin_unset_pages = sorted(
        layout.page_no for layout in layouts.values() if layout.unset
    )
    margin_none_pages = sorted(
        layout.page_no
        for layout in layouts.values()
        if layout.margin_box_mode == "none" and not layout.applied
    )
    # 任务 33：auto 页没有落库的框 = **未定**（没有检测行 / 还没拟合）。
    # 不算进导出（不拿全局框顶替），但预检必须如实报出来——否则用户不会知道
    # 这些页在"按版心判定"打开时根本没有判据。
    # 刀 1：识别跑过、整页没有字的页是「无文字，跳过」，不算未定、不挡完成。
    text_pages = blocks_module.pages_with_text(project_id, library=target_library)
    margin_no_text_pages = sorted(
        page.page_no
        for page in prepared.pages
        if page.margin_box_mode == "auto"
        and page.margin_box is None
        and page.page_id not in text_pages
        and (states.get(page.page_id) is not None)
        and states[page.page_id].status
        in (blocks_module.STATUS_RECOGNIZED, blocks_module.STATUS_HAS_CANDIDATE)
    )
    no_text_nos = set(margin_no_text_pages)
    margin_undetermined_pages = sorted(
        page.page_no
        for page in prepared.pages
        if page.margin_box_mode == "auto"
        and page.margin_box is None
        and page.page_no not in no_text_nos
    )
    page_number_pages = [
        int(record.get("pdf_page") or 0)
        for record in prepared.meta.get("pages", [])
        if record.get("printed_page_candidates")
    ]
    workflow_status = review_status.status_counts(
        project_id,
        library=target_library,
        page_numbers=[page.page_no for page in prepared.pages],
    )

    return {
        "input_blocks": len(prepared.sources),
        # 兼容字段：segment_count / char_count 仍指**正文流**
        "segment_count": len(segments),
        "char_count": body_char_count,
        # 三条流的分开统计（第 37 号任务）
        "streams": {
            "body": {
                "segments": len(segments),
                "chars": body_char_count,
                "blocks": sum(len(segment.block_ids) for segment in segments),
            },
            "notes": {"notes": len(notes), "chars": note_char_count},
            "meta": {
                "pages": int(meta_summary.get("page_count") or 0),
                "printed_page_found": int(meta_summary.get("printed_page_found") or 0),
                "printed_page_missing": list(meta_summary.get("printed_page_missing") or []),
            },
        },
        "notes_count": len(notes),
        "notes_char_count": note_char_count,
        "page_number_mapping": {
            "found": int(meta_summary.get("printed_page_found") or 0),
            "total": int(meta_summary.get("page_count") or 0),
            "missing_pages": list(meta_summary.get("printed_page_missing") or []),
        },
        "page_count": len({page for segment in segments for page in segment.pages}),
        "pages": sorted({page for segment in segments for page in segment.pages}),
        "exported_pages": [page.page_no for page in prepared.pages],
        "dropped_pages": [page.page_no for page in prepared.dropped_pages],
        "unreviewed_segments": sum(1 for s in segments if s.review.unreviewed),
        "uncertain_segments": sum(1 for s in segments if s.review.uncertain),
        "merged_segments": sum(1 for s in segments if len(s.block_ids) > 1),
        "hyphenations_restored": sum(len(s.hyphenations) for s in segments),
        "unfinished_pages": sorted(unfinished),
        "excluded_block_types": sorted(
            set(segments_module.ALL_BLOCK_TYPES) - set(streams_module.BODY_BLOCK_TYPES)
        ),
        "rules": prepared.options.to_dict(),
        # 整块落在页面边缘、却还没标类型的块：它们**现在会被导出**，
        # 而这正是页眉 / 页码混进正文的来源。界面据此提醒去用结构工具。
        "chrome_suspect_count": len(chrome),
        "chrome_suspects": chrome[:20],
        # 整本一个版面块都没确认过时，界面给一条警告——只是提醒，导出照常进行
        "layout_blocks": len(all_blocks),
        "layout_confirmed_blocks": layout_confirmed,
        # 整页版面确认（与上面块级的两个兼容字段分开命名）
        "layout_pages": len(prepared.pages),
        "layout_confirmed_pages": len(prepared.pages) - len(layout_unconfirmed_pages),
        "layout_unconfirmed_pages": layout_unconfirmed_pages,
        # 按版心判定（任务 51）的两层计数：版心层 / 类型层分开报，用户能判断是哪层在起作用
        "margin_judgement": prepared.margin_enabled,
        "margin_blocks": margin_blocks,
        "margin_notes": {
            "total": margin_notes_total,
            "inside": margin_notes_inside,
            "outside": margin_notes_total - margin_notes_inside,
        },
        "margin_page_numbers": {
            "pages": len(page_number_pages),
            "page_nos": page_number_pages,
        },
        # 任务 61：工作流状态快照（导出预检与 manifest 用同一组数）
        "workflow_status": workflow_status,
        "margin_pages": {
            "applied": sum(1 for layout in layouts.values() if layout.applied),
            "unset": margin_unset_pages,
            "none": margin_none_pages,
            "no_text": margin_no_text_pages,
            "undetermined": margin_undetermined_pages,
            # 任务 53：全局版心是自动推算、还没人确认 —— 导出**不认**它（见 export_margin_box），
            # 界面据此说明"为什么版心视图里看得到框、预检却说没生效"。
            "auto": (
                prepared.margin_enabled
                and library_module.load_project(project_id, library=target_library).margin_box_source
                == "auto"
            ),
        },
    }


def _margin_exclusion(prepared: Prepared) -> dict[str, object]:
    """版心外被排除的块数 + 类型分布（任务 34：预检与 manifest 共用这一份）。

    只统计**这一页真的有生效版心**（applied）的块：没有版心的页按块类型判定，
    不能把那里的块算成"被版心排除"。
    """
    layouts = prepared.margin_layouts or {}
    inside = outside = 0
    by_type: dict[str, int] = {}
    for block in prepared.blocks:
        layout = layouts.get(block.page_no)
        if layout is None or not getattr(layout, "applied", False):
            continue
        if block.block_id in layout.inside_ids:
            inside += 1
        elif block.block_id in layout.outside_ids:
            outside += 1
            by_type[block.block_type] = by_type.get(block.block_type, 0) + 1
    return {
        "inside_blocks": inside,
        "outside_blocks": outside,
        "excluded_blocks": outside,
        "excluded_by_type": dict(sorted(by_type.items())),
    }


def _chrome_suspects(project_id: str, *, library: Path, options: ExportOptions) -> list[dict]:
    """还会被导出、但像是页眉 / 页码的块。

    这里直接用**结构工具的预览结果**，而不是自己再写一套位置判断：
    预检里说的"有多少嫌疑"必须正好等于"结构工具能一键标掉多少"，
    否则会出现"提示说有 3 个，打开工具却一个都不给标"这种自相矛盾
    （本项目的真书上就撞到过：页面最后一行的正文落在底部区域里，
    位置规则命中、但被"字数上限"保护住——那种不该算嫌疑）。
    """
    excluded = options.excluded_block_types()
    plan = structure_module.plan_header_footer(project_id, library=library)
    return [
        {
            "block_id": item.block_id,
            "page_no": item.page_no,
            "region": item.region,
            "proposed_type": item.proposed_type,
            "text": item.text[:60],
        }
        for item in plan.candidates
        # 判据是"它**现在**算不算被排除"：proposed_type 本身就是页眉 / 页码，
        # 拿它去过滤会把要提醒的块全滤掉（写反过一次）
        if item.current_type not in excluded
    ]


def preview(project_id: str, *, library: Path | None = None, options: ExportOptions,
            limit: int = 20000, segments_only: bool = False) -> dict:
    """预览（说明书 6.6 第 7 条）：算一遍但不写文件。

    返回里带上**逐段记录**（与 JSONL 里的形状一致）：导出对照模式要用它做
    "段 → 块 → 页"的溯源——点一段就知道它来自哪一页、哪些块（说明书 9.1 的段 ID 与来源）。
    """
    prepared = _prepare(project_id, library=library, options=options)
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
    if segments_only:
        # 阅读审校只要段 + line_spans：跳过 text / jsonl / preflight（preflight 会再 _prepare 一次）
        return {
            "segments": records,
            "segment_count": len(records),
            "preflight": None,
            "text": "",
            "jsonl": "",
            "truncated": False,
        }
    text = _render_text(prepared)
    content = _render_jsonl(prepared, library=library)
    return {
        "preflight": preflight(project_id, library=library, options=options),
        "text": text[:limit],
        "jsonl": content[:limit],
        "truncated": len(text) > limit,
        "segments": records,
        "segment_count": len(records),
    }


# ---------------------------------------------------------------- 阅读流段的缓存（任务 67）
#
# 阅读审校一进来就要**全书**的 segments（4364 段 / 3.8 MB）：`_prepare` 362 ms、
# `json.dumps` 23 ms，但走 FastAPI 默认序列化再传出去实测 1.88 s。
# 这里缓存"已经序列化好的 JSON 字符串"，并按 `project.db` 的 mtime + 选项签名失效：
# 重复打开（含重启后）实测 ~40 ms，而且能直接 `Response(content=...)` 交给 uvicorn，
# 不再过一遍 `jsonable_encoder`。

#: 阅读流 segments 的结构版本；改了字段或语义就 +1
PREVIEW_CACHE_VERSION = 1

_PREVIEW_CACHE: dict[str, tuple[str, str]] = {}
"""项目 → (签名, JSON 字符串)。只留最近两个项目。"""

_PREVIEW_CACHE_AT: dict[str, float] = {}

_PREVIEW_LOCK = threading.Lock()
"""并发首次请求时只让一个线程算（任务 67）。"""


def _db_mtime_signature(project_id: str, library: Path) -> str:
    # 结构版本号：payload 形状变了也要让磁盘缓存失效
    return (
        f"v{PREVIEW_CACHE_VERSION}|"
        + db_module.content_signature(library_module.project_dir(library, project_id))
    )


def _options_signature(options: ExportOptions) -> str:
    data = []
    for field_name in sorted(options.__dataclass_fields__):
        value = getattr(options, field_name)
        if isinstance(value, (tuple, list)):
            value = list(value)
        data.append(f"{field_name}={value!r}")
    return ";".join(data)


def preview_segments_signature(
    project_id: str, *, library: Path, options: ExportOptions
) -> str:
    return f"{_db_mtime_signature(project_id, library)}#{_options_signature(options)}"


def _preview_cache_path(project_id: str, library: Path) -> Path:
    return library_module.project_dir(library, project_id) / "cache" / "preview-segments.json"


def preview_segments_json(
    project_id: str, *, library: Path, options: ExportOptions
) -> str:
    """阅读流要的 segments，返回**已序列化**的 JSON 字符串（内存 + 磁盘两级缓存）。"""
    signature = preview_segments_signature(project_id, library=library, options=options)
    cached = _PREVIEW_CACHE.get(project_id)
    if cached and cached[0] == signature:
        return cached[1]
    # 识别在跑时每认完一页都会让签名变化：允许复用 3 秒内的结果（任务 68）
    from ..project import cache_policy

    if cached and cache_policy.can_reuse(
        project_id, library, _PREVIEW_CACHE_AT.get(project_id)
    ):
        return cached[1]
    with _PREVIEW_LOCK:
        cached = _PREVIEW_CACHE.get(project_id)
        if cached and cached[0] == signature:
            return cached[1]
        return _build_preview_segments_json(project_id, library, options, signature)


def _build_preview_segments_json(
    project_id: str, library: Path, options: ExportOptions, signature: str
) -> str:
    path = _preview_cache_path(project_id, library)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and payload.get("signature") == signature:
            raw = payload.get("json")
            if isinstance(raw, str):
                _remember_preview(project_id, signature, raw)
                return raw
    except (OSError, json.JSONDecodeError):
        pass
    prepared = _prepare(project_id, library=library, options=options)
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
    raw = json.dumps(
        {
            "segments": records,
            "segment_count": len(records),
            "preflight": None,
            "text": "",
            "jsonl": "",
            "truncated": False,
        },
        ensure_ascii=False,
    )
    _remember_preview(project_id, signature, raw)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(
            json.dumps({"signature": signature, "json": raw}, ensure_ascii=False),
            encoding="utf-8",
        )
        temp.replace(path)
    except OSError:
        # 写不进去只是少一层缓存，不影响正确性
        pass
    return raw


def _remember_preview(project_id: str, signature: str, raw: str) -> None:
    if project_id not in _PREVIEW_CACHE and len(_PREVIEW_CACHE) >= 2:
        _PREVIEW_CACHE.pop(next(iter(_PREVIEW_CACHE)))
    _PREVIEW_CACHE[project_id] = (signature, raw)
    _PREVIEW_CACHE_AT[project_id] = time.monotonic()


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
    if not prepared.segments and not prepared.notes:
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
    body_file = BODY_TXT_FILE_NAME if options.format in (FORMAT_TXT, FORMAT_BOTH) else BODY_JSONL_FILE_NAME
    if options.format in (FORMAT_TXT, FORMAT_BOTH):
        (directory / BODY_TXT_FILE_NAME).write_text(_render_text(prepared), encoding="utf-8", newline="\n")
        written.append(BODY_TXT_FILE_NAME)
        data_files.append(BODY_TXT_FILE_NAME)
        if options.include_notes:
            (directory / NOTES_TXT_FILE_NAME).write_text(
                streams_module.render_notes_txt(prepared.notes), encoding="utf-8", newline="\n"
            )
            written.append(NOTES_TXT_FILE_NAME)
            data_files.append(NOTES_TXT_FILE_NAME)
    if options.format in (FORMAT_JSONL, FORMAT_BOTH):
        (directory / BODY_JSONL_FILE_NAME).write_text(
            _render_jsonl(prepared, library=target_library), encoding="utf-8", newline="\n"
        )
        written.append(BODY_JSONL_FILE_NAME)
        data_files.append(BODY_JSONL_FILE_NAME)
        if options.include_notes:
            (directory / NOTES_JSONL_FILE_NAME).write_text(
                streams_module.render_notes_jsonl(prepared.notes), encoding="utf-8", newline="\n"
            )
            written.append(NOTES_JSONL_FILE_NAME)
            data_files.append(NOTES_JSONL_FILE_NAME)

    (directory / META_FILE_NAME).write_text(
        json.dumps(prepared.meta, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n"
    )
    written.append(META_FILE_NAME)

    workflow_status = review_status.status_counts(
        project_id,
        library=target_library,
        page_numbers=[page.page_no for page in prepared.pages],
    )
    margin_payload = None
    if prepared.margin_enabled:
        exclusion = _margin_exclusion(prepared)
        margin_payload = {
            "judgement": True,
            **exclusion,
        }
    manifest = manifest_module.build_manifest(
        app_version=__version__,
        scope=manifest_module.ExportScope(
            page_numbers=tuple(sorted(page.page_no for page in prepared.pages)),
            format=options.format,
            confirmed_only=options.confirmed_only,
        ),
        rules=prepared.options.to_dict(),
        segments=prepared.segments,
        data_file=body_file,
        source=manifest_module.SourceInfo(
            project_name=project.name,
            file_name=project.source_file_name,
            sha256=project.source_sha256,
        ),
        exported_at=moment,
        extra_files=[name for name in written if name != body_file],
        # manifest 描述的是"这次导出了什么"：没勾注释时 notes 统计为 0，files 里也没有它们
        notes=prepared.notes if options.include_notes else (),
        meta=prepared.meta,
        workflow=workflow_status,
        margin=margin_payload,
    )
    (directory / MANIFEST_FILE_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n"
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
