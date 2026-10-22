"""兼容层：行级版面归属规则已移到产品代码 `core/structure/regions.py`。

**规则只能有一份实现。** 产品里的块类型建议（`core/project/structure.suggest_block_types`）
要 import 规则，而 `scripts/` 不进打包，所以实现放在 `backend/book2text/core/structure/regions.py`；
这个文件只做 re-export，保证 `scripts/measure_region_classification.py` 与旧的实验命令
仍然能用（实验可复跑）。
"""

from __future__ import annotations

from book2text.core.structure.regions import (  # noqa: F401
    CONFIDENCE_HIGH,
    CONFIDENCE_REVIEW,
    DEFAULT_BAND_CHARS,
    DEFAULT_BAND_LINES,
    DEFAULT_MAX_CHARS,
    KIND_BODY,
    KIND_FOOTER,
    KIND_HEADER,
    KIND_PAGE_NUMBER,
    REPEAT_POSITION_TOLERANCE,
    REPEAT_SIMILARITY,
    REPEAT_THRESHOLD,
    Frame,
    Line,
    NumberCandidate,
    PageLines,
    Rules,
    Verdict,
    classify_pages,
    estimate_body_frame,
    looks_like_a_number,
    looks_like_heading,
    normalize_for_repeat,
    page_number_candidates,
    page_number_hint,
    similar_text,
)

__all__ = [
    "CONFIDENCE_HIGH",
    "CONFIDENCE_REVIEW",
    "DEFAULT_BAND_CHARS",
    "DEFAULT_BAND_LINES",
    "DEFAULT_MAX_CHARS",
    "KIND_BODY",
    "KIND_FOOTER",
    "KIND_HEADER",
    "KIND_PAGE_NUMBER",
    "REPEAT_POSITION_TOLERANCE",
    "REPEAT_SIMILARITY",
    "REPEAT_THRESHOLD",
    "Frame",
    "Line",
    "NumberCandidate",
    "PageLines",
    "Rules",
    "Verdict",
    "classify_pages",
    "estimate_body_frame",
    "looks_like_a_number",
    "looks_like_heading",
    "normalize_for_repeat",
    "page_number_candidates",
    "page_number_hint",
    "similar_text",
]
