"""三条导出流里的「注释」与「元数据」（说明书 6.6 / 9.4 / 9.5 的扩展）。

- **正文流**仍由 `segments.py` 生成（页面类型 / 块类型过滤在 `project.py` 里）。
- **注释流**：`footnote` 块单独成条；每条带页码、块 id、以及"最近的前一个正文块/段"
  作为引用位置。找不到可靠前文就如实写"未定位"，不猜。
- **元数据**：一页一条，保留 `pdf_page ↔ printed_page` 映射、页眉 / 页脚 / 页码原文、
  图注原文、类型分布与行归属统计。印刷页码只从 `page_number` 块与页眉页脚里的
  纯数字 / 罗马数字块抽取，抽不到就是 null，并给出候选。

**为什么图注进元数据而不是注释流：** 图注不是脚注，也没有"引用到哪一段"的语义；
但它是有用的原文，不能丢。放在每页的 `captions` 里，正文保持干净。
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Sequence

from ..project import structure as structure_module
from .segments import BLOCK_TYPE_HEADING, BLOCK_TYPE_PARAGRAPH, Segment

BODY_BLOCK_TYPES = frozenset({BLOCK_TYPE_PARAGRAPH, BLOCK_TYPE_HEADING})

NOTE_BLOCK_TYPE = "footnote"
HEADER_BLOCK_TYPE = "header"
FOOTER_BLOCK_TYPE = "footer"
PAGE_NUMBER_BLOCK_TYPE = "page_number"
CAPTION_BLOCK_TYPE = "caption"

META_SCHEMA_ID = "book2text.meta.v1"
NOTE_SCHEMA_ID = "book2text.note.v1"

# 与 structure.py 的结构工具同口径：页面顶部 / 底部 8%、左右 10%，短文本
EDGE_TOP = 0.08
EDGE_BOTTOM = 0.08
EDGE_LEFT = 0.10
EDGE_RIGHT = 0.10
EDGE_MAX_CHARS = 20

_DIGIT_OR_ROMAN = re.compile(r"\d+|[ivxlcdmIVXLCDM]+")


@dataclass(frozen=True)
class NoteEntry:
    seq: int
    page_no: int
    block_id: str
    text: str
    reference_page: int | None
    reference_block_id: str | None
    reference_segment_id: str | None
    located: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "schema": NOTE_SCHEMA_ID,
            "seq": self.seq,
            "page": self.page_no,
            "block_id": self.block_id,
            "text": self.text,
            "reference": {
                "status": "located" if self.located else "unlocated",
                "page": self.reference_page,
                "block_id": self.reference_block_id,
                "segment_id": self.reference_segment_id,
            },
        }


def build_notes(
    blocks: Sequence,
    segments: Sequence[Segment],
    *,
    text_for_block,
    confirmed_only: bool = False,
) -> list[NoteEntry]:
    """把脚注块排成注释流，并给每条找"最近的前一个正文块/段"。

    `text_for_block(block)` 由调用方传入（复用正文的 9.2 行合并与清理规则）。
    """
    ordered = sorted(blocks, key=lambda block: (block.page_no, block.order_index, block.block_id))
    body_blocks = [
        block
        for block in ordered
        if block.block_type in BODY_BLOCK_TYPES
        and block.include
        and (not confirmed_only or block.review_status == "confirmed")
    ]
    segment_of: dict[str, str] = {}
    for segment in segments:
        for block_id in segment.block_ids:
            segment_of[block_id] = segment.segment_id

    notes: list[NoteEntry] = []
    for block in ordered:
        if block.block_type != NOTE_BLOCK_TYPE or not block.include:
            continue
        if confirmed_only and block.review_status != "confirmed":
            continue
        text = text_for_block(block)
        if not text.strip():
            continue
        key = (block.page_no, block.order_index)
        previous = None
        for candidate in body_blocks:
            if (candidate.page_no, candidate.order_index) < key:
                previous = candidate
            else:
                break
        notes.append(
            NoteEntry(
                seq=len(notes) + 1,
                page_no=block.page_no,
                block_id=block.block_id,
                text=text,
                reference_page=previous.page_no if previous else None,
                reference_block_id=previous.block_id if previous else None,
                reference_segment_id=segment_of.get(previous.block_id) if previous else None,
                located=previous is not None,
            )
        )
    return notes


def render_notes_txt(notes: Sequence[NoteEntry]) -> str:
    """注释流 TXT：一条一段，头两行写定位信息；未定位就直说。"""
    chunks: list[str] = []
    for note in notes:
        head = f"［注 {note.seq}］第 {note.page_no} 页 · 块 {note.block_id}"
        if note.located:
            where = f"引用：第 {note.reference_page} 页 · 块 {note.reference_block_id}"
            if note.reference_segment_id:
                where += f" · 段 {note.reference_segment_id}"
            chunks.append(f"{head}\n{where}\n{note.text}")
        else:
            chunks.append(f"{head}\n引用：未定位（前面没有正文块）\n{note.text}")
    return ("\n\n".join(chunks) + "\n") if chunks else ""


def render_notes_jsonl(notes: Sequence[NoteEntry]) -> str:
    lines = [
        json.dumps(note.to_dict(), ensure_ascii=False, separators=(",", ":"))
        for note in notes
    ]
    return ("\n".join(lines) + "\n") if lines else ""


# ---------------------------------------------------------------- 印刷页码

def _page_value(text: str) -> str | None:
    """从"纯数字 / 罗马数字"文本里取出值；不是这种形态就返回 None。"""
    compact = unicodedata.normalize("NFKC", re.sub(r"\s+", "", text or ""))
    if not compact or not structure_module.looks_like_a_number(compact):
        return None
    match = _DIGIT_OR_ROMAN.search(compact)
    if not match:
        return None
    value = match.group(0)
    return value.upper() if value.isalpha() else value


def extract_printed_page(blocks: Sequence):
    """返回 ``(printed_page, source, candidates)``；不确定时 value 为 None。

    - 只认 `page_number` 块，以及页眉 / 页脚里纯数字或罗马数字的块；
    - 多个不同候选（没有一个明确的 page_number 块）→ null，不猜；
    - 候选全部列在返回值里，供元数据/预检解释失败原因。
    """
    page_numbers = [block for block in blocks if block.block_type == PAGE_NUMBER_BLOCK_TYPE]
    edge_numbers = [
        block
        for block in blocks
        if block.block_type in (HEADER_BLOCK_TYPE, FOOTER_BLOCK_TYPE)
        and _page_value(block.text) is not None
    ]
    primary = page_numbers or edge_numbers
    candidates = [
        {"value": value, "block_type": block.block_type, "block_id": block.block_id}
        for block in primary
        if (value := _page_value(block.text)) is not None
    ]
    values = {item["value"] for item in candidates}
    if not candidates:
        return None, None, []
    if len(values) > 1:
        return None, None, candidates
    return candidates[0]["value"], candidates[0]["block_type"], candidates


# ---------------------------------------------------------------- 每页元数据

def _region(bbox) -> str | None:
    if not bbox:
        return None
    x0, y0, x1, y1 = bbox
    if y1 <= EDGE_TOP:
        return "top"
    if y0 >= 1 - EDGE_BOTTOM:
        return "bottom"
    if x1 <= EDGE_LEFT:
        return "left"
    if x0 >= 1 - EDGE_RIGHT:
        return "right"
    return None


def _edge_texts(blocks: Sequence) -> list[dict[str, object]]:
    """页面边缘的短文本，**不论块类型**。

    这是为"书眉被 OCR 拆成两行"准备的兜底：其中一行如果被分组成 paragraph，
    它仍会出现在这里（同时也会在正文里），不会静默消失。
    """
    items: list[dict[str, object]] = []
    for block in blocks:
        region = _region(block.bbox)
        text = block.text.strip()
        if not region or not text or len(text) > EDGE_MAX_CHARS:
            continue
        items.append(
            {
                "block_id": block.block_id,
                "region": region,
                "block_type": block.block_type,
                "text": text,
            }
        )
    return items


def page_metadata(
    pages: Sequence,
    blocks_by_page: dict[int, list],
    line_stats: dict[int, dict[str, int]],
) -> dict[str, object]:
    """生成 `meta.json`（一页一条）。"""
    page_records: list[dict[str, object]] = []
    missing: list[int] = []
    found = 0

    for page in pages:
        blocks = blocks_by_page.get(page.page_no, [])
        printed_page, source, candidates = extract_printed_page(blocks)
        if printed_page is None:
            missing.append(page.page_no)
        else:
            found += 1

        def texts(block_type: str) -> list[dict[str, object]]:
            return [
                {"block_id": block.block_id, "text": block.text}
                for block in blocks
                if block.block_type == block_type and block.text.strip()
            ]

        type_counts: dict[str, int] = {}
        for block in blocks:
            type_counts[block.block_type] = type_counts.get(block.block_type, 0) + 1

        page_records.append(
            {
                "pdf_page": page.page_no,
                "page_label": page.page_label,
                "printed_page": printed_page,
                "printed_page_source": source,
                "printed_page_candidates": candidates,
                "page_type": page.page_type,
                "include": page.include,
                "block_count": len(blocks),
                "block_types": type_counts,
                "lines": line_stats.get(
                    page.page_no, {"assigned": 0, "conflict": 0, "unassigned": 0}
                ),
                "headers": texts(HEADER_BLOCK_TYPE),
                "footers": texts(FOOTER_BLOCK_TYPE),
                "page_numbers": texts(PAGE_NUMBER_BLOCK_TYPE),
                "captions": texts(CAPTION_BLOCK_TYPE),
                "edge_texts": _edge_texts(blocks),
            }
        )

    return {
        "schema": META_SCHEMA_ID,
        "pages": page_records,
        "summary": {
            "page_count": len(page_records),
            "printed_page_found": found,
            "printed_page_missing": missing,
        },
    }
