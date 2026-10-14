"""导出接口（说明书第 9 节的临时形态）。

**这不是说明书第 11 节的正式接口。** 正式接口以 `/projects/{id}/export/...` 为中心，
需要项目、页面与块的持久化（Phase 1/2），导出文件按说明书 12.1 写入项目的
``exports/<时间戳>_<格式>/`` 目录并配"在文件夹中显示"（说明书 4.5）。

当前没有持久化，服务端看不到客户端手上的识别结果，因此这些接口是**无状态的**：
客户端把块（含原始行与标记）提交上来，服务端跑完整的
9.1 段生成 → 9.3 清理 → 9.4 TXT / 9.5 JSONL + manifest，把文本返回。
**规则实现只有服务端这一份**——客户端不需要懂拼接、分段与清理规则。

说明书 11 把预检与导出分成两个接口；这里合并成一个响应（``preflight`` 字段），
这处临时差异记在 `docs/known-limitations.md` L-24。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import __version__
from ..core.export import cleanup, jsonl as jsonl_module, manifest as manifest_module
from ..core.export import segments as segments_module, txt
from ..core.export.joining import HyphenationRestore, join_lines
from .errors import AppError

router = APIRouter(prefix="/api/export", tags=["export"])


class BlockInput(BaseModel):
    """客户端提交的一个块。

    ``lines`` 是该块的原始文本行（**未拼接**）——拼接由服务端按说明书 9.2 完成。
    """

    block_id: str = Field(min_length=1, max_length=128)
    page_no: int = Field(ge=1)
    order_index: int = Field(ge=0)
    block_type: str = "paragraph"
    lines: list[str] = Field(default_factory=list)
    include: bool = True
    review_status: Literal["unreviewed", "confirmed", "uncertain"] = "unreviewed"
    continues_to_next: bool = False
    ocr_text: str | None = None


class ExportOptions(BaseModel):
    page_markers: bool = False
    include_footnotes: bool = False
    exclude_header_footer: bool = True
    merge_lines_in_block: bool = True
    restore_hyphenation: bool = True
    confirmed_only: bool = False


class SourceInput(BaseModel):
    """源文件与引擎信息，写进 manifest 与 JSONL 的 ``source`` 字段。"""

    project_name: str | None = None
    file_name: str | None = None
    sha256: str | None = None
    engine_id: str | None = None
    engine_version: str | None = None


class ExportRequest(BaseModel):
    blocks: list[BlockInput] = Field(default_factory=list)
    options: ExportOptions = Field(default_factory=ExportOptions)
    page_labels: dict[int, str] = Field(default_factory=dict)
    source: SourceInput = Field(default_factory=SourceInput)
    preview_chars: int = Field(default=3000, ge=0, le=200_000)


@dataclass(frozen=True)
class _Prepared:
    """跑完 9.2 / 9.3 / 9.1 之后的中间结果，两种格式共用。"""

    blocks: list[BlockInput]
    rules: cleanup.CleanupRules
    segments: list[segments_module.Segment]


def _rules_from(options: ExportOptions) -> cleanup.CleanupRules:
    return cleanup.CleanupRules(
        exclude_header_footer=options.exclude_header_footer,
        merge_lines_in_block=options.merge_lines_in_block,
        restore_hyphenation=options.restore_hyphenation,
    )


def _join_block(
    block: BlockInput, rules: cleanup.CleanupRules
) -> tuple[str, tuple[HyphenationRestore, ...]]:
    """把一个块的行拼成段落文本，返回 ``(文本, 块内断词还原记录)``。"""
    lines = cleanup.clean_lines(block.lines, rules)
    if not rules.merge_lines_in_block:
        # 说明书 9.3：关闭段内行合并时保留原始换行
        return "\n".join(line for line in lines if line), ()
    result = join_lines(lines, restore_hyphenation=rules.restore_hyphenation)
    return result.text, result.hyphenations


def _prepare(payload: ExportRequest) -> _Prepared:
    rules = _rules_from(payload.options)

    sources: list[segments_module.SegmentSource] = []
    for block in payload.blocks:
        text, hyphenations = _join_block(block, rules)
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
        excluded_types=rules.excluded_block_types,
        confirmed_only=payload.options.confirmed_only,
    )
    return _Prepared(payload.blocks, rules, built)


def _preflight(prepared: _Prepared) -> dict[str, Any]:
    built = prepared.segments
    pages = sorted({block.page_no for block in prepared.blocks})
    # char_count 指**内容字数**（各段文本之和），不是文件字节长度——
    # 后者会随 TXT 的段间空行等格式变化，不适合作为统计口径。
    # manifest.stats.char_count 用的是同一个口径，两处必须一致（说明书 13.3）。
    char_count = sum(len(segment.text) for segment in built)
    return {
        "input_blocks": len(prepared.blocks),
        "segment_count": len(built),
        "char_count": char_count,
        "page_count": len(pages),
        "pages": pages,
        "unreviewed_segments": sum(1 for s in built if s.review.unreviewed),
        "uncertain_segments": sum(1 for s in built if s.review.uncertain),
        "merged_segments": sum(1 for s in built if len(s.block_ids) > 1),
        # 段内的断词还原：块内换行处的 + 跨块拼接处的，都算在内
        "hyphenations_restored": sum(len(s.hyphenations) for s in built),
    }


def _build_manifest(
    payload: ExportRequest,
    prepared: _Prepared,
    *,
    export_format: str,
    data_file: str,
    extra_files: list[str] | None = None,
) -> dict[str, Any]:
    pages = sorted({block.page_no for block in prepared.blocks})
    rules = payload.options.model_dump()
    return manifest_module.build_manifest(
        app_version=__version__,
        scope=manifest_module.ExportScope(
            page_numbers=tuple(pages),
            format=export_format,
            confirmed_only=payload.options.confirmed_only,
        ),
        rules=rules,
        segments=prepared.segments,
        data_file=data_file,
        source=manifest_module.SourceInfo(
            project_name=payload.source.project_name,
            file_name=payload.source.file_name,
            sha256=payload.source.sha256,
        ),
        extra_files=extra_files or [],
    )


def _guard_not_empty(payload: ExportRequest, output: str) -> None:
    if payload.blocks and not output:
        raise AppError(
            400,
            "nothing_to_export",
            "按照当前规则没有任何内容可以导出",
            detail="块可能全被排除（include=false，或块类型在排除范围内），"
                   "或「仅已确认」范围下没有已确认的块",
        )


@router.post("/txt")
def export_txt(payload: ExportRequest) -> dict[str, Any]:
    """按说明书 9.1 / 9.3 / 9.4 生成 TXT，并附上 manifest（9.5）。"""
    prepared = _prepare(payload)

    text = txt.render_txt(
        prepared.segments,
        options=txt.TxtOptions(
            page_markers=payload.options.page_markers,
            include_footnotes=payload.options.include_footnotes,
        ),
        page_labels=payload.page_labels,
    )
    _guard_not_empty(payload, text)

    data_file = "clean.txt"
    return {
        "format": "txt",
        "text": text,
        "filename": data_file,
        "manifest": _build_manifest(payload, prepared, export_format="txt", data_file=data_file),
        "preflight": _preflight(prepared),
        "preview": text[: payload.preview_chars],
        "segments": [segment.to_dict() for segment in prepared.segments],
    }


@router.post("/jsonl")
def export_jsonl(payload: ExportRequest) -> dict[str, Any]:
    """按说明书 9.5 生成 JSONL，并附上 manifest。"""
    prepared = _prepare(payload)

    content = jsonl_module.render_jsonl(
        prepared.segments,
        page_labels=payload.page_labels,
        engine_id=payload.source.engine_id,
        engine_version=payload.source.engine_version,
    )
    _guard_not_empty(payload, content)

    data_file = "segments.jsonl"
    return {
        "format": "jsonl",
        "jsonl": content,
        "filename": data_file,
        "manifest": _build_manifest(payload, prepared, export_format="jsonl", data_file=data_file),
        "preflight": _preflight(prepared),
        "preview": content[: payload.preview_chars],
        "segments": [segment.to_dict() for segment in prepared.segments],
    }
