"""结构工具：页眉 / 页脚 / 页码批量标注（说明书 6.5）。

扫描书的页眉页脚每页都有，逐页处理不可行。说明书给的做法是**位置规则 + 预览 + 批量应用**：

1. 规则：页面顶部 / 底部区域高度（占页高的比例）、可选文本条件
   （纯数字或罗马数字 → 页码；字数少于 N）、作用范围（默认全部纳入的正文页）。
2. **预览**：算出会被标注哪些块、多少块，可逐个取消。
3. **应用**：作为**一次批量**写入事件，可整体撤销（`editing` 的机制）。
4. **已被人工改过类型的块不会被覆盖**——靠事件表判定：一个块只要有 `set_type` 事件，
   就说明有人给它定过类型，本工具不再动它。

模型建议（版面组件）与位置规则都必须经过预览与人工确认才生效，**建议绝不静默应用**；
版面组件本身还没接入（说明书 8.4 的路线未选定），因此当前只有位置规则这一种来源。

**同一套规则也以只读建议的形式给审校视图**（`GET .../pages/{no}/block-suggestions`，
`suggest_block_types()`）：只算"建议类型 + 把握 + 理由 + 页码候选"，**不写库、不改块类型**。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..storage import db as db_module
from ..storage.ulid import new_ulid
from ..structure.regions import (
    NumberCandidate,
    looks_like_a_number,
    looks_like_heading,
    normalize_for_repeat,
    page_number_candidates,
    page_number_hint,
    similar_text,
)
from . import blocks as blocks_module
from . import editing
from .library import ProjectError, default_library_dir, list_pages, project_dir

# 说明书 6.5 的默认区域高度
DEFAULT_REGION_RATIO = 0.08
# 左右边缘的默认宽度：正文一般不会整块贴在这一条里，而竖排书眉 / 边栏会
DEFAULT_MARGIN_RATIO = 0.10
# "字数少于 N" 的默认值：页眉页脚通常很短（"第三章 · 45"），正文段落不会这么短
DEFAULT_MAX_CHARS = 20

# 位置的归属：落在顶部区域算页眉、底部区域算页脚；数字形态的算页码
REGION_TOP = "top"
REGION_BOTTOM = "bottom"
REGION_LEFT = "left"
REGION_RIGHT = "right"

BLOCK_TYPE_HEADER = "header"
BLOCK_TYPE_FOOTER = "footer"
BLOCK_TYPE_PAGE_NUMBER = "page_number"
BLOCK_TYPE_PARAGRAPH = "paragraph"
# 章题 / 回目：建议只到 review（见 suggest_block_types），任何规则都不该自动删标题
BLOCK_TYPE_HEADING = "heading"

# 候选的把握程度（见 Candidate 的说明）
CONFIDENCE_HIGH = "high"
CONFIDENCE_REVIEW = "review"
# 同一区域里重复出现多少次才算"书眉 / 页脚"这种重复性文字
REPEAT_THRESHOLD = 3
# "像同一句"的相似度门槛（容忍 OCR 的个别错字）
REPEAT_SIMILARITY = 0.6

@dataclass(frozen=True)
class HeaderFooterRules:
    """说明书 6.5 的规则参数。全部以**比例**表示，与渲染尺寸无关。

    区域除了上 / 下，还有左 / 右：**竖排书眉**（如本书左栏的「红楼梦／第X回」）
    既不在顶部也不在底部，它整块贴在页面一侧——靠左右区域才捞得到。
    """

    top_ratio: float = DEFAULT_REGION_RATIO
    bottom_ratio: float = DEFAULT_REGION_RATIO
    left_ratio: float = DEFAULT_MARGIN_RATIO
    right_ratio: float = DEFAULT_MARGIN_RATIO
    max_chars: int | None = DEFAULT_MAX_CHARS
    # 作用范围：默认全部纳入的正文页
    page_types: tuple[str, ...] = ("body",)
    # 是否把"纯数字 / 罗马数字"单独标成页码（说明书 6.5 的文本条件）
    detect_page_numbers: bool = True

    def to_dict(self) -> dict:
        return {
            "top_ratio": self.top_ratio,
            "bottom_ratio": self.bottom_ratio,
            "left_ratio": self.left_ratio,
            "right_ratio": self.right_ratio,
            "max_chars": self.max_chars,
            "page_types": list(self.page_types),
            "detect_page_numbers": self.detect_page_numbers,
        }


@dataclass(frozen=True)
class Candidate:
    """一个"将会被标注"的块。

    ``confidence`` 是给界面用的：``high`` 表示"几乎可以肯定"（页码形态、
    或者在同一个区域里跨页重复出现），``review`` 表示"很可能是，但请看一眼"。
    界面默认只勾选 high 的候选——**宁可少标，不要标错**（D-034）：
    标错一个页脚，正文就会从导出里消失。
    """

    block_id: str
    page_no: int
    text: str
    bbox: tuple[float, float, float, float] | None
    current_type: str
    proposed_type: str
    region: str
    reason: str
    confidence: str = CONFIDENCE_REVIEW

    def to_dict(self) -> dict:
        return {
            "block_id": self.block_id,
            "page_no": self.page_no,
            "text": self.text,
            "bbox": list(self.bbox) if self.bbox else None,
            "current_type": self.current_type,
            "proposed_type": self.proposed_type,
            "region": self.region,
            "reason": self.reason,
            "confidence": self.confidence,
        }


@dataclass(frozen=True)
class Skipped:
    """一个"看起来在区域里、但不动它"的块，以及原因。"""

    block_id: str
    page_no: int
    text: str
    reason: str

    def to_dict(self) -> dict:
        return {
            "block_id": self.block_id,
            "page_no": self.page_no,
            "text": self.text,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class Plan:
    rules: HeaderFooterRules
    candidates: tuple[Candidate, ...]
    skipped: tuple[Skipped, ...]
    pages_scanned: int

    def to_dict(self) -> dict:
        by_type: dict[str, int] = {}
        for item in self.candidates:
            by_type[item.proposed_type] = by_type.get(item.proposed_type, 0) + 1
        high = sum(1 for item in self.candidates if item.confidence == CONFIDENCE_HIGH)
        return {
            "rules": self.rules.to_dict(),
            "candidate_count": len(self.candidates),
            "high_confidence_count": high,
            "review_count": len(self.candidates) - high,
            "by_type": by_type,
            "pages_scanned": self.pages_scanned,
            "sample_pages": sorted({item.page_no for item in self.candidates}),
            "candidates": [item.to_dict() for item in self.candidates],
            "skipped": [item.to_dict() for item in self.skipped][:50],
            "skipped_count": len(self.skipped),
        }


def _region_of(bbox: tuple[float, float, float, float], rules: HeaderFooterRules) -> str | None:
    """块落在哪条边缘区域里？都不在就返回 None。

    **整块**都在区域里才算：跨界的大段落不该被当成页眉。
    上下优先于左右：一页左上角的小块报"顶部"比报"左侧"更贴近人的说法。
    """
    x0, y0, x1, y1 = bbox
    if y1 <= rules.top_ratio:
        return REGION_TOP
    if y0 >= 1 - rules.bottom_ratio:
        return REGION_BOTTOM
    if x1 <= rules.left_ratio:
        return REGION_LEFT
    if x0 >= 1 - rules.right_ratio:
        return REGION_RIGHT
    return None


def _propose(text: str, region: str, rules: HeaderFooterRules) -> tuple[str, str]:
    """位置 + 文本条件 → 该标成什么类型。"""
    if rules.detect_page_numbers and looks_like_a_number(text):
        return BLOCK_TYPE_PAGE_NUMBER, "在区域内，且是纯数字 / 罗马数字"
    if region == REGION_TOP:
        return BLOCK_TYPE_HEADER, "整块落在页面顶部区域"
    if region == REGION_BOTTOM:
        return BLOCK_TYPE_FOOTER, "整块落在页面底部区域"
    if region == REGION_LEFT:
        return BLOCK_TYPE_HEADER, "整块贴在页面左侧（疑似竖排书眉 / 边栏）"
    return BLOCK_TYPE_HEADER, "整块贴在页面右侧（疑似竖排书眉 / 边栏）"


def _manually_typed_blocks(conn) -> set[str]:
    """**有人手动**给它定过类型的块（说明书 6.5：这类块不会被覆盖）。

    只看 `actor = 'user'` 的事件：批量结构工具自己的改动记的是 `system`
    ——"标注 → 撤销 → 再预览"时那些块应当重新出现在候选里，
    而不是因为"曾经被标过一次"就被永久排除。
    """
    rows = conn.execute(
        """
        SELECT DISTINCT entity_id FROM event
        WHERE entity_type = 'block' AND action = ? AND actor = ?
        """,
        (editing.ACTION_SET_TYPE, editing.ACTOR_USER),
    ).fetchall()
    return {row["entity_id"] for row in rows}


def plan_header_footer(
    project_id: str,
    *,
    library: Path | None = None,
    rules: HeaderFooterRules | None = None,
) -> Plan:
    """算出会被标注的块（说明书 6.5 的"预览"）：**不改任何东西**。"""
    active = rules or HeaderFooterRules()
    target_library = library if library is not None else default_library_dir()
    directory = project_dir(target_library, project_id)

    pages = {
        page.page_no: page
        for page in list_pages(project_id, library=target_library)
        if page.page_type in active.page_types
    }
    if not pages:
        return Plan(rules=active, candidates=(), skipped=(), pages_scanned=0)

    with db_module.open_database(directory, apply_migrations=False) as conn:
        protected = _manually_typed_blocks(conn)

    candidates: list[Candidate] = []
    skipped: list[Skipped] = []
    for block in blocks_module.list_blocks(project_id, library=target_library):
        if block.page_no not in pages or block.bbox is None:
            continue
        region = _region_of(block.bbox, active)
        if region is None:
            continue

        proposed, reason = _propose(block.text, region, active)

        if block.block_type != BLOCK_TYPE_PARAGRAPH:
            # 已经不是段落了（上一轮标注过、或人工设过）：只在"和这次要标的不一样"时提一句
            if block.block_type != proposed:
                skipped.append(
                    Skipped(block.block_id, block.page_no, block.text, f"已经是 {block.block_type}")
                )
            continue
        if block.block_id in protected:
            skipped.append(
                Skipped(block.block_id, block.page_no, block.text, "类型被人改过，不覆盖")
            )
            continue
        if active.max_chars is not None and len(block.text.strip()) > active.max_chars:
            skipped.append(
                Skipped(
                    block.block_id,
                    block.page_no,
                    block.text,
                    f"字数 {len(block.text.strip())} 超过 {active.max_chars}",
                )
            )
            continue

        candidates.append(
            Candidate(
                block_id=block.block_id,
                page_no=block.page_no,
                text=block.text,
                bbox=block.bbox,
                current_type=block.block_type,
                proposed_type=proposed,
                region=region,
                reason=reason,
            )
        )

    return Plan(
        rules=active,
        candidates=tuple(_with_confidence(candidates)),
        skipped=tuple(skipped),
        pages_scanned=len(pages),
    )


def _repeat_count(item: Candidate, candidates: list[Candidate]) -> int:
    """同一区域里"长得像"的候选有多少个（含它自己）。

    相似度与数字归一化走 `core.structure.regions` 的那一份实现；书眉每页的页码不同
    （`红楼梦／第 3 回`、`第 4 回`），数字不参与比较，否则每一页都会变成孤例。
    """
    normalized = normalize_for_repeat(item.text)
    return sum(
        1
        for other in candidates
        if other.region == item.region
        and similar_text(normalized, normalize_for_repeat(other.text), REPEAT_SIMILARITY)
    )


def _with_confidence(candidates: list[Candidate]) -> list[Candidate]:
    """给候选标上把握程度。

    判据只有两条，都指向"这东西是不是页面的重复性家具"：

    - **页码形态**（纯数字 / 罗马数字）→ high：正文里极少整段只有一个数字；
    - **同一区域里跨页重复出现**（≥ REPEAT_THRESHOLD 次）→ high：书眉、页脚是重复的。

    只出现一两次的（比如某页最后一行正文本就短）→ review：**默认不勾选**。
    这条规则是被真书打出来的：40 页实测里，第 37 页段落末行（19 字）落在底部区域，
    被当成页脚标掉，正文因此从导出里丢了一句话——"位置对"不等于"它就是页脚"。
    """
    # 同一区域里"长得像"的算一类：OCR 把书眉读成「红楼梦／第X回」「红楼梦0回」「CS」…
    # 它们显然是同一件家具，逐字相等会把它们判成孤例、白白推给人工
    marked: list[Candidate] = []
    for item in candidates:
        repeated = _repeat_count(item, candidates)
        if looks_like_a_number(item.text) or repeated >= REPEAT_THRESHOLD:
            marked.append(replace_candidate(item, CONFIDENCE_HIGH))
        else:
            marked.append(replace_candidate(item, CONFIDENCE_REVIEW))
    return marked


def replace_candidate(item: Candidate, confidence: str) -> Candidate:
    from dataclasses import replace

    return replace(item, confidence=confidence)


@dataclass(frozen=True)
class ApplyResult:
    changed: int
    by_type: dict[str, int]
    pages: tuple[int, ...]
    events: tuple[editing.Event, ...]


def apply_header_footer(
    project_id: str,
    items: list[tuple[str, str]],
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> ApplyResult:
    """把预览里确认过的块**一次批量**改成指定类型（说明书 6.5 第 4 条）。

    ``items`` 是 ``(block_id, block_type)`` 的列表——由界面把预览结果里用户
    **保留**的那些传回来，因此"逐个取消"天然生效：没传的就不动。
    整批共享一个 `batch_id`，撤销按 batch 走。
    """
    if not items:
        raise ProjectError("没有要标注的块")
    target_library = library if library is not None else default_library_dir()
    directory = project_dir(target_library, project_id)
    batch_id = new_ulid()
    pages: set[int] = set()
    by_type: dict[str, int] = {}
    events: list[editing.Event] = []

    for block_id, block_type in items:
        block, block_events = editing.update_block(
            project_id,
            block_id,
            library=target_library,
            block_type=block_type,
            actor_name=actor_name,
            actor=editing.ACTOR_SYSTEM,
            batch_id=batch_id,
        )
        pages.add(block.page_no)
        by_type[block_type] = by_type.get(block_type, 0) + 1
        events.extend(block_events)

    return ApplyResult(
        changed=len(items),
        by_type=by_type,
        pages=tuple(sorted(pages)),
        events=tuple(events),
    )


# ---------------------------------------------------------------- 块类型建议（只读）

CONFIDENCE_LABELS = {
    CONFIDENCE_HIGH: "把握较大",
    CONFIDENCE_REVIEW: "需确认",
}


@dataclass(frozen=True)
class BlockSuggestion:
    """一条**只读**的块类型建议。

    它与结构工具的候选是同一套规则算出来的，但**不写库、不改块类型**：
    界面上只是"这一块可能是页眉"的提示，用户点「采用」才会走正常的块编辑接口。
    """

    block_id: str
    page_no: int
    order_index: int
    current_type: str
    suggested_type: str
    confidence: str
    region: str | None
    reason: str
    chars: int
    repeat_matches: int
    page_number_candidates: tuple[NumberCandidate, ...] = ()
    page_number_hint: NumberCandidate | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "block_id": self.block_id,
            "page_no": self.page_no,
            "order_index": self.order_index,
            "current_type": self.current_type,
            "suggested_type": self.suggested_type,
            "confidence": self.confidence,
            "confidence_label": CONFIDENCE_LABELS.get(self.confidence, self.confidence),
            "region": self.region,
            "reason": self.reason,
            "signals": {
                "region": self.region,
                "chars": self.chars,
                "repeat_matches": self.repeat_matches,
            },
            "page_number_candidates": [item.to_dict() for item in self.page_number_candidates],
            "page_number_hint": (
                self.page_number_hint.to_dict() if self.page_number_hint else None
            ),
        }


@dataclass(frozen=True)
class BlockSuggestionPlan:
    page_no: int
    suggestions: tuple[BlockSuggestion, ...]
    blocks_scanned: int
    pages_compared: int
    note: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "page_no": self.page_no,
            "suggestion_count": len(self.suggestions),
            "blocks_scanned": self.blocks_scanned,
            "pages_compared": self.pages_compared,
            "note": self.note,
            "suggestions": [item.to_dict() for item in self.suggestions],
        }


def _suggestion_reason(candidate: Candidate, repeat: int) -> str:
    """给候选补上"为什么 high / review"的人话。"""
    if candidate.proposed_type == BLOCK_TYPE_PAGE_NUMBER:
        return candidate.reason
    if repeat >= REPEAT_THRESHOLD:
        return f"{candidate.reason}；同一区域有 {repeat} 处相似文字"
    return f"{candidate.reason}；只出现 {repeat} 处，需人工确认"


def suggest_block_types(
    project_id: str,
    page_no: int,
    *,
    library: Path | None = None,
    rules: HeaderFooterRules | None = None,
) -> BlockSuggestionPlan:
    """算一页的块类型建议（**只读**）。

    与 `plan_header_footer()` 的区别：

    - 只看一页，但跨页重复的统计仍用全书（同一区域里 ≥ 3 处相似文字才是 high）；
    - 不跳过"已经是页眉 / 页码"的块，而是算出内容上**应该**是什么类型，
      然后只返回"与当前类型不同"的那些——否则界面上全是"已经是段落"的噪声；
    - 额外提取书眉里夹着的**页码候选**（第二本书第 30 页的 `2谁是巴赫金?11`），
      以及只给 review 的**标题**建议（`第X回 / 第X章` 这类标记）。

    **任何规则都不自动改块类型**；本函数只读两个表：`page`、`block`。
    """
    active = rules or HeaderFooterRules()
    target_library = library if library is not None else default_library_dir()
    pages = list_pages(project_id, library=target_library)
    target = next((page for page in pages if page.page_no == page_no), None)
    if target is None:
        raise ProjectError(f"没有第 {page_no} 页")

    if target.page_type not in active.page_types:
        return BlockSuggestionPlan(
            page_no=page_no, suggestions=(), blocks_scanned=0, pages_compared=0,
            note=f"第 {page_no} 页不在建议范围内（只对正文页给建议；用结构工具可扩大类型范围）",
        )

    eligible = {
        page.page_no
        for page in pages
        if page.page_type in active.page_types
    }
    blocks = [
        block
        for block in blocks_module.list_blocks(project_id, library=target_library)
        if block.page_no in eligible
    ]
    page_blocks = [block for block in blocks if block.page_no == page_no]

    # 1) 边缘条带里的块：与结构工具**同一条规则**（_region_of + _propose + _with_confidence）
    candidates: list[Candidate] = []
    for block in blocks:
        text = block.text.strip()
        if not text or block.bbox is None:
            continue
        region = _region_of(block.bbox, active)
        if region is None:
            continue
        if active.max_chars is not None and len(text) > active.max_chars:
            continue
        proposed, reason = _propose(text, region, active)
        candidates.append(Candidate(
            block_id=block.block_id,
            page_no=block.page_no,
            text=text,
            bbox=block.bbox,
            current_type=block.block_type,
            proposed_type=proposed,
            region=region,
            reason=reason,
        ))
    scored = {candidate.block_id: candidate for candidate in _with_confidence(candidates)}

    suggestions: list[BlockSuggestion] = []
    for block in page_blocks:
        candidate = scored.get(block.block_id)
        if candidate is not None:
            if candidate.proposed_type == block.block_type:
                continue  # 已经是这个类型：不报，避免界面噪声
            repeat = _repeat_count(candidate, candidates)
            numbers = page_number_candidates(block.text)
            suggestions.append(BlockSuggestion(
                block_id=block.block_id,
                page_no=block.page_no,
                order_index=block.order_index,
                current_type=block.block_type,
                suggested_type=candidate.proposed_type,
                confidence=candidate.confidence,
                region=candidate.region,
                reason=_suggestion_reason(candidate, repeat),
                chars=len(candidate.text),
                repeat_matches=repeat,
                page_number_candidates=numbers,
                page_number_hint=page_number_hint(numbers, block.bbox) if numbers else None,
            ))
            continue

        # 2) 正文区域里的标题：只给 review，永不 high（标题不能自动删）
        text = block.text.strip()
        if block.block_type == BLOCK_TYPE_HEADING or not looks_like_heading(text):
            continue
        suggestions.append(BlockSuggestion(
            block_id=block.block_id,
            page_no=block.page_no,
            order_index=block.order_index,
            current_type=block.block_type,
            suggested_type=BLOCK_TYPE_HEADING,
            confidence=CONFIDENCE_REVIEW,
            region=None,
            reason="块首是章 / 节标记或常见标题词，可能是标题；标题只给建议，不自动剔除",
            chars=len(text),
            repeat_matches=0,
        ))

    suggestions.sort(key=lambda item: item.order_index)
    return BlockSuggestionPlan(
        page_no=page_no,
        suggestions=tuple(suggestions),
        blocks_scanned=len(page_blocks),
        pages_compared=len(eligible),
    )
