"""导出接口（说明书第 9 节的临时形态）。

**这不是说明书第 11 节的正式接口。** 正式接口以 `/projects/{id}/export/...` 为中心，
需要项目、页面与块的持久化（Phase 1/2），导出文件写入项目的 `exports/` 目录并配
"在文件夹中显示"（说明书 4.5）。

当前没有持久化，服务端看不到客户端手上的识别结果，因此这个接口是**无状态的**：
客户端把块（含原始行与标记）提交上来，服务端跑完整的
9.1 段生成 → 9.3 清理 → 9.4 TXT 渲染，把文本返回。
**规则实现只有服务端这一份**——客户端不需要懂拼接、分段与清理规则。

说明书 11 把预检与导出分成 `/preflight` 与 `/export` 两个接口；这里合并为一个响应
（`preflight` 字段 + `text`），这处临时差异记在 `docs/known-limitations.md` L-24。
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..core.export import cleanup, segments as segments_module, txt
from ..core.export.joining import join_lines
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


class TxtExportRequest(BaseModel):
    blocks: list[BlockInput] = Field(default_factory=list)
    options: ExportOptions = Field(default_factory=ExportOptions)
    page_labels: dict[int, str] = Field(default_factory=dict)
    preview_chars: int = Field(default=3000, ge=0, le=200_000)


def _rules_from(options: ExportOptions) -> cleanup.CleanupRules:
    return cleanup.CleanupRules(
        exclude_header_footer=options.exclude_header_footer,
        merge_lines_in_block=options.merge_lines_in_block,
        restore_hyphenation=options.restore_hyphenation,
    )


def _join_block(block: BlockInput, rules: cleanup.CleanupRules) -> tuple[str, int]:
    """把一个块的行拼成段落文本，返回 ``(文本, 被断词还原的位置数)``。"""
    lines = cleanup.clean_lines(block.lines, rules)
    if not rules.merge_lines_in_block:
        # 说明书 9.3：关闭段内行合并时保留原始换行
        return "\n".join(line for line in lines if line), 0
    result = join_lines(lines, restore_hyphenation=rules.restore_hyphenation)
    return result.text, len(result.hyphenations)


@router.post("/txt")
def export_txt(payload: TxtExportRequest) -> dict[str, Any]:
    """按说明书 9.1 / 9.3 / 9.4 生成 TXT 文本与预检摘要。"""
    rules = _rules_from(payload.options)

    sources: list[segments_module.SegmentSource] = []
    hyphenations_restored = 0
    for block in payload.blocks:
        text, hyphenations = _join_block(block, rules)
        hyphenations_restored += hyphenations
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
            )
        )

    built = segments_module.build_segments(
        sources,
        excluded_types=rules.excluded_block_types,
        confirmed_only=payload.options.confirmed_only,
    )

    text = txt.render_txt(
        built,
        options=txt.TxtOptions(
            page_markers=payload.options.page_markers,
            include_footnotes=payload.options.include_footnotes,
        ),
        page_labels=payload.page_labels,
    )

    if payload.blocks and not text:
        # 有输入却没有任何输出，必须说明原因，不能静默给一个空文件
        raise AppError(
            400,
            "nothing_to_export",
            "按照当前规则没有任何内容可以导出",
            detail="块可能全被排除（include=false，或块类型在排除范围内），"
                   "或「仅已确认」范围下没有已确认的块",
        )

    pages = sorted({block.page_no for block in payload.blocks})

    return {
        "format": "txt",
        "text": text,
        "filename": "book2text-export.txt",
        "preflight": {
            "input_blocks": len(payload.blocks),
            "segment_count": len(built),
            "char_count": len(text),
            "page_count": len(pages),
            "pages": pages,
            "unreviewed_segments": sum(1 for s in built if s.review.unreviewed),
            "uncertain_segments": sum(1 for s in built if s.review.uncertain),
            "merged_segments": sum(1 for s in built if len(s.block_ids) > 1),
            "hyphenations_restored": hyphenations_restored,
            "rules": payload.options.model_dump(),
        },
        "preview": text[: payload.preview_chars],
        "segments": [segment.to_dict() for segment in built],
    }
