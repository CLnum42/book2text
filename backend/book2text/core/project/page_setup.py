"""页面确认的自动建议（说明书 6.2 的「页面准备」；只给建议，绝不自动应用）。

**为什么只给建议：** 说明书 6.5 同一条规矩——任何自动判定都必须经过预览 / 人工确认。
`docs/region-classification-eval.md` 也说明自动规则已经够准，但"够准"不等于可以替用户
做决定：页类型会影响识别范围与导出，标错一页的代价比多点一下大。

**建议规则（保守，宁可少给）：**

- 空白：整页墨迹占比 < 1%（几乎没有内容）→ `blank`，把握高。
- 首页：第 1 页（且不是空白）→ `cover`，把握中。
- 图像页：已经跑过识别（项目里有块），但这一页 0 块、墨迹占比 ≥ 45%
  （整页图像 / 插图）→ `front`，把握中。
- 疑似空白：已经跑过识别，这一页 0 块且墨迹占比 < 5% → `blank`，把握低。
- 文字形态：页首文字里出现「目录 / Contents」「索引 / Index」「附录 / Appendix」
  → 对应类型，把握中。
- 没有识别行、也没有文本层**本身不算证据**：新项目还没识别时每一页都如此，
  按它给建议会把整本书都建议成空白 / 前置。

**墨迹占比**用缩略图（50 DPI）算：灰度值 < 240 的像素占全页比例。只对"没有块"
或"首页"的候选页渲染，最多分析 60 页，避免一本 400 页的书打开时卡住。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from ..pdf import render
from . import blocks as blocks_module
from . import library as library_module

# 建议最多分析多少页（按页序取前 N 个未确认的纳入页）
MAX_ANALYZED_PAGES = 60

# 墨迹判定：灰度 < 240 算"有内容"；比例阈值按样本书实测取的保守值
_INK_PIXEL_THRESHOLD = 240
BLANK_INK_HIGH = 0.01
BLANK_INK_LOW = 0.05
IMAGE_HEAVY_INK = 0.45

CONFIDENCE_HIGH = "high"
CONFIDENCE_MEDIUM = "medium"
CONFIDENCE_LOW = "low"
CONFIDENCE_LABELS = {
    CONFIDENCE_HIGH: "高",
    CONFIDENCE_MEDIUM: "中",
    CONFIDENCE_LOW: "低",
}

# 页首文字里的关键词 → 页面类型
_TEXT_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("toc", ("目录", "目 录", "contents")),
    ("index", ("索引", "index")),
    ("appendix", ("附录", "appendix")),
)


@dataclass(frozen=True)
class PageSignals:
    """一页参与建议的最小事实集合（纯函数入参，测试不必建整本书）。"""

    page_id: str
    page_no: int
    page_type: str
    include: bool
    page_confirmed: bool
    has_text_layer: bool
    block_count: int
    text: str = ""


@dataclass(frozen=True)
class PageSuggestion:
    page_id: str
    page_no: int
    suggested_type: str
    confidence: str
    reason: str
    signals: dict[str, object]

    def to_dict(self) -> dict[str, object]:
        return {
            "page_id": self.page_id,
            "page_no": self.page_no,
            "suggested_type": self.suggested_type,
            "confidence": self.confidence,
            "confidence_label": CONFIDENCE_LABELS.get(self.confidence, self.confidence),
            "reason": self.reason,
            "signals": self.signals,
        }


def ink_ratio(image) -> float:
    """一张页面图里"有墨迹"的像素占比（0–1）。"""
    gray = image.convert("L")
    histogram = gray.histogram()
    total = gray.width * gray.height
    if total <= 0:
        return 0.0
    return sum(histogram[:_INK_PIXEL_THRESHOLD]) / total


def suggest_page(
    signals: PageSignals,
    *,
    ink: float | None,
    project_has_blocks: bool,
) -> PageSuggestion | None:
    """给一页算一条建议；没有把握或不必要就返回 None。"""
    if not signals.include or signals.page_confirmed:
        return None

    base = {
        "block_count": signals.block_count,
        "has_text_layer": signals.has_text_layer,
        "ink_ratio": round(ink, 4) if ink is not None else None,
    }

    def make(suggested_type: str, confidence: str, reason: str) -> PageSuggestion | None:
        if suggested_type == signals.page_type:
            return None
        return PageSuggestion(
            page_id=signals.page_id,
            page_no=signals.page_no,
            suggested_type=suggested_type,
            confidence=confidence,
            reason=reason,
            signals=base,
        )

    # 空白优先于"首页"：一张全空的第一页更像是空白页，而不是封面
    if ink is not None and ink < BLANK_INK_HIGH:
        return make("blank", CONFIDENCE_HIGH, f"几乎空白：墨迹占比 {ink:.2%}")

    if signals.page_no == 1:
        return make("cover", CONFIDENCE_MEDIUM, "第 1 页（通常为封面），且不是空白页")

    if signals.block_count > 0:
        head = signals.text[:160].casefold()
        for page_type, keywords in _TEXT_KEYWORDS:
            if any(keyword in head for keyword in keywords):
                return make(
                    page_type,
                    CONFIDENCE_MEDIUM,
                    f"页首文字里出现「{keywords[0]}」，但没有识别出该类型",
                )
        return None

    if not project_has_blocks:
        # 还没识别过：除空白与首页外不给建议，否则整本书都会被建议成空白 / 前置
        return None

    if ink is not None and ink >= IMAGE_HEAVY_INK:
        return make(
            "front",
            CONFIDENCE_MEDIUM,
            f"整页图像、没有识别行：墨迹占比 {ink:.0%}",
        )
    if ink is not None and ink < BLANK_INK_LOW:
        return make(
            "blank",
            CONFIDENCE_LOW,
            f"没有识别行、墨迹很少（{ink:.1%}），可能是一张空白页",
        )
    return None


def _page_signals(page, block_count: int, text: str) -> PageSignals:
    return PageSignals(
        page_id=page.page_id,
        page_no=page.page_no,
        page_type=page.page_type,
        include=page.include,
        page_confirmed=page.page_confirmed,
        has_text_layer=page.has_text_layer,
        block_count=block_count,
        text=text,
    )


def suggest_pages_for_project(
    project_id: str,
    *,
    library: Path | None = None,
) -> dict[str, object]:
    """给一个项目的未确认页算建议（只读，不改任何页面）。"""
    target_library = library if library is not None else library_module.default_library_dir()
    pages = library_module.list_pages(project_id, library=target_library)
    blocks = blocks_module.list_blocks(project_id, library=target_library)
    by_page: dict[int, list] = {}
    for block in blocks:
        by_page.setdefault(block.page_no, []).append(block)
    project_has_blocks = bool(blocks)

    candidates = [page for page in pages if page.include and not page.page_confirmed]
    analyzed = candidates[:MAX_ANALYZED_PAGES]
    truncated = len(candidates) > len(analyzed)

    project_directory = library_module.project_dir(target_library, project_id)
    pdf_path = project_directory / library_module.SOURCE_DIR_NAME / library_module.SOURCE_FILE_NAME

    suggestions: list[dict[str, object]] = []
    for page in analyzed:
        page_blocks = by_page.get(page.page_no, [])
        text = "\n".join(block.text for block in page_blocks[:3])
        index = page.pdf_page_index if page.pdf_page_index is not None else page.page_no - 1
        ink = None
        # 只有"没有块"或首页才需要看图像；有文字的页不必再渲染
        if not page_blocks or page.page_no == 1:
            try:
                image = render.render_page_image(pdf_path, index, dpi=50)
                ink = ink_ratio(image)
            except (render.PdfError, OSError):
                ink = None
        suggestion = suggest_page(
            _page_signals(page, len(page_blocks), text),
            ink=ink,
            project_has_blocks=project_has_blocks,
        )
        if suggestion is not None:
            suggestions.append(suggestion.to_dict())

    return {
        "count": len(suggestions),
        "analyzed_pages": len(analyzed),
        "truncated": truncated,
        "project_has_blocks": project_has_blocks,
        "suggestions": suggestions,
    }
