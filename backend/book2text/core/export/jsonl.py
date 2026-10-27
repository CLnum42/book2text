"""JSONL 输出（说明书 9.5）。

说明书规定的形状（原始示例，为便于阅读而折行，实际每条占一行）::

    {"schema": "book2text.segment.v1",
     "segment_id": "01J9ZK3M8Q…",
     "seq": 57,
     "type": "paragraph",
     "text": "In the early years of the …",
     "pages": [{"page_no": 87, "page_label": "71"}, {"page_no": 88, "page_label": "72"}],
     "block_ids": ["01J9ZK3M8Q…", "01J9ZK4A2B…"],
     "review": {"all_confirmed": false, "unreviewed": 1, "uncertain": 0, "modified": true},
     "source": {"engine": "rapidocr", "engine_version": "x.y.z"}}

**本模块只负责序列化。** 段本身由 `segments.py` 生成——JSONL 的字段在 `Segment`
里已经齐了，只是 `pages` 需要补上印刷页码 `page_label`（那段信息不在 Segment 里，
因为它是页面的属性，不是段的）。

说明书 13.2 要求"校验 JSONL 每行都是有效 JSON"，因此每行都用
``ensure_ascii=False`` 单行输出，段文本里的换行会被 JSON 转义成 ``\\n``，
不会破坏"一行一段"的结构。
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence

from .segments import Segment

SCHEMA_ID = "book2text.segment.v1"


def segment_to_record(
    segment: Segment,
    *,
    page_labels: Mapping[int, str] | None = None,
    engine_id: str | None = None,
    engine_version: str | None = None,
) -> dict[str, object]:
    """把一段转成 JSONL 记录（说明书 9.5 的字段形状）。"""
    labels = page_labels or {}

    record: dict[str, object] = {
        "schema": SCHEMA_ID,
        "segment_id": segment.segment_id,
        "seq": segment.seq,
        "type": segment.block_type,
        "text": segment.text,
        "pages": [
            {"page_no": page_no, "page_label": labels.get(page_no, "")}
            for page_no in segment.pages
        ],
        "block_ids": list(segment.block_ids),
        "line_spans": [dict(span) for span in segment.line_spans],
        "review": {
            "all_confirmed": segment.review.all_confirmed,
            "unreviewed": segment.review.unreviewed,
            "uncertain": segment.review.uncertain,
            "modified": segment.review.modified,
        },
    }

    if engine_id:
        record["source"] = {
            "engine": engine_id,
            "engine_version": engine_version or "",
        }
    else:
        # 说明书示例里有 source；拿不到引擎信息时如实置空，不编造
        record["source"] = {"engine": "", "engine_version": ""}

    return record


def render_jsonl(
    segments: Sequence[Segment],
    *,
    page_labels: Mapping[int, str] | None = None,
    engine_id: str | None = None,
    engine_version: str | None = None,
) -> str:
    """渲染成 JSONL 文本（每行一个段，以 ``\\n`` 结尾）。"""
    lines = [
        json.dumps(
            segment_to_record(
                segment,
                page_labels=page_labels,
                engine_id=engine_id,
                engine_version=engine_version,
            ),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        for segment in segments
    ]
    if not lines:
        return ""
    return "\n".join(lines) + "\n"
