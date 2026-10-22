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

import re
import statistics
from collections import defaultdict
from collections.abc import Collection
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
from . import library as library_module
from . import margin_box as margin_box_module
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
BLOCK_TYPE_FOOTNOTE = "footnote"
BLOCK_TYPE_MARGIN_NOTE = "margin_note"
BLOCK_TYPE_OTHER = "other"

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

# ---------------------------------------------------------------- 脚注 / 旁批建议
#
# **安全约束（不要放开）：** 脚注 / 旁批被误标的后果是这段文字从正文流里消失
# （进注释流或干脆不导出）——这是数据丢失。因此这两类建议**永远只给 review**：
# 「全库采用高把握建议」与"识别完成自动应用"都只动 high，不会碰它们；
# 必须由用户逐条看、逐条采用。`_note_suggestion()` 返回的 confidence 固定为 review，
# 现有入口再按 high 过滤一次（`scan_high_suggestions`）。
FOOTNOTE_BOTTOM_RATIO = 0.25
FOOTNOTE_SIZE_RATIO = 0.85
FOOTNOTE_GAP_RATIO = 1.5
# 保守上限：超过这个字数的块更像正文段落，不给脚注建议（宁可漏报，不要制造噪声）
FOOTNOTE_MAX_CHARS = 120
MARGIN_NOTE_MAX_CHARS = 40

# 注释符号：圈号 / * / "注：" / "［注" / "译者注"；"——译注" 可以出现在末尾
_NOTE_START_PATTERNS = (
    (re.compile(r"^[①-⑳]"), "圈号"),
    (re.compile(r"^[*＊]"), "*"),
    (re.compile(r"^(?:注[:：]|［注|\[注|译者注|译注)"), "注记"),
    (re.compile(r"^\d{1,2}\s"), "数字标记"),
)
_NOTE_SIGNATURE = re.compile(r"——译(?:者)?注")


@dataclass(frozen=True)
class BlockSuggestion:
    """一条**只读**的块类型建议。

    它与结构工具的候选是同一套规则算出来的，但**不写库、不改块类型**：
    界面上只是"这一块可能是页眉 / 脚注 / 旁批"的提示，用户点「采用」才会走正常的块编辑接口。
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
    # 脚注 / 旁批命中了哪几条信号（界面 tooltip / 报告用）；其他建议为空
    note_signals: tuple[str, ...] = ()

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
            "note_signals": list(self.note_signals),
        }


@dataclass(frozen=True)
class PageNumberHint:
    """书眉 / 页脚里"贴着块首或块尾"的页码候选（只读，供界面上的拆分按钮用）。

    与 `BlockSuggestion` 分开，是因为它**不看"建议类型 ≠ 当前类型"**：
    块已经是 header 的时候，用户仍然要能把粘着的页码拆出去。
    """

    block_id: str
    page_no: int
    order_index: int
    block_type: str
    text: str
    candidates: tuple[NumberCandidate, ...]
    hint: NumberCandidate | None

    def to_dict(self) -> dict[str, object]:
        return {
            "block_id": self.block_id,
            "page_no": self.page_no,
            "order_index": self.order_index,
            "block_type": self.block_type,
            "text": self.text,
            "page_number_candidates": [item.to_dict() for item in self.candidates],
            "page_number_hint": self.hint.to_dict() if self.hint else None,
        }


@dataclass(frozen=True)
class BlockSuggestionPlan:
    page_no: int
    suggestions: tuple[BlockSuggestion, ...]
    blocks_scanned: int
    pages_compared: int
    note: str | None = None
    page_numbers: tuple[PageNumberHint, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "page_no": self.page_no,
            "suggestion_count": len(self.suggestions),
            "blocks_scanned": self.blocks_scanned,
            "pages_compared": self.pages_compared,
            "note": self.note,
            "suggestions": [item.to_dict() for item in self.suggestions],
            "page_numbers": [item.to_dict() for item in self.page_numbers],
        }


def _suggestion_reason(candidate: Candidate, repeat: int) -> str:
    """给候选补上"为什么 high / review"的人话。"""
    if candidate.proposed_type == BLOCK_TYPE_PAGE_NUMBER:
        return candidate.reason
    if repeat >= REPEAT_THRESHOLD:
        return f"{candidate.reason}；同一区域有 {repeat} 处相似文字"
    return f"{candidate.reason}；只出现 {repeat} 处，需人工确认"


@dataclass(frozen=True)
class _LineProfile:
    """全书行框统计：正文行高中位数 / 行距中位数 / 每块的行高。"""

    median_height: float | None
    median_gap: float | None
    heights_by_block: dict[str, list[float]]


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def _line_profile(project_id: str, blocks, library: Path) -> _LineProfile:
    """读全书 `block_line`，算"字号代理"与"行距"。

    **为什么行框高度可以当字号代理：** `block_line.bbox` 是检测器给出的**行框**，
    高度覆盖了字形的主体（含扫描模糊），同一本书里正文与脚注的字号差会直接反映成
    行框高度差。阈值用**相对比值**（脚注 < 0.85 × 正文中位），不写死像素 / 毫米。
    反例见 `docs/known-limitations.md` L-61：只有标点 / 上标的行、竖排、旋转页、
    刻意用大字的脚注会失准；没有行框的块直接放弃字号信号。
    """
    by_id = {block.block_id: block for block in blocks}
    heights: dict[str, list[float]] = defaultdict(list)
    lines_by_block: dict[str, list[tuple[int, tuple[float, float, float, float]]]] = defaultdict(list)
    body_heights: list[float] = []
    for line in blocks_module.list_block_lines(project_id, library=library):
        block = by_id.get(line.block_id)
        if block is None or line.bbox is None:
            continue
        height = float(line.bbox[3]) - float(line.bbox[1])
        if height <= 0:
            continue
        heights[line.block_id].append(height)
        lines_by_block[line.block_id].append((line.line_index, line.bbox))
        if block.block_type in (BLOCK_TYPE_PARAGRAPH, BLOCK_TYPE_HEADING):
            body_heights.append(height)

    body_gaps: list[float] = []
    for block_id, lines in lines_by_block.items():
        block = by_id.get(block_id)
        if block is None or block.block_type not in (BLOCK_TYPE_PARAGRAPH, BLOCK_TYPE_HEADING):
            continue
        ordered = sorted(lines, key=lambda item: item[0])
        for (_, left), (_, right) in zip(ordered, ordered[1:]):
            gap = float(right[1]) - float(left[3])
            if gap > 0:
                body_gaps.append(gap)

    return _LineProfile(
        median_height=_median(body_heights),
        median_gap=_median(body_gaps),
        heights_by_block=dict(heights),
    )


def _note_marker(text: str) -> str | None:
    """块首的注释符号 / 块内的"——译注"签名；没有就 None。"""
    stripped = (text or "").strip()
    for pattern, label in _NOTE_START_PATTERNS:
        if pattern.match(stripped):
            return label
    if _NOTE_SIGNATURE.search(stripped):
        return "——译注"
    return None


def _footnote_signal_labels(
    block,
    page,
    page_blocks: list,
    index: int,
    profile: _LineProfile,
    project,
) -> list[str]:
    """命中几条脚注信号；**位置信号是前提**（脚注在版心下沿）。"""
    if block.bbox is None:
        return []
    box = margin_box_module.effective_margin_box(project, page)
    center_x = (block.bbox[0] + block.bbox[2]) / 2
    center_y = (block.bbox[1] + block.bbox[3]) / 2
    if box is not None and page.margin_box_mode != margin_box_module.MODE_NONE:
        inside = box[0] <= center_x <= box[2] and box[1] <= center_y <= box[3]
        bottom_start = box[3] - FOOTNOTE_BOTTOM_RATIO * (box[3] - box[1])
        position_label = "位于版心下沿"
    else:
        inside = True
        bottom_start = 1 - FOOTNOTE_BOTTOM_RATIO
        position_label = "位于页面底部（版心未设置）"
    if not inside or center_y < bottom_start:
        return []

    labels = [position_label]
    heights = profile.heights_by_block.get(block.block_id) or []
    if heights and profile.median_height:
        ratio = (sum(heights) / len(heights)) / profile.median_height
        if ratio < FOOTNOTE_SIZE_RATIO:
            labels.append(f"行高较小（{ratio:.2f}× 正文中位）")

    marker = _note_marker(block.text)
    if marker:
        labels.append(f"注释符号（{marker}）")

    if index > 0:
        previous = page_blocks[index - 1]
        if (
            previous.bbox is not None
            and previous.block_type in (BLOCK_TYPE_PARAGRAPH, BLOCK_TYPE_HEADING)
            and profile.median_gap
        ):
            gap = float(block.bbox[1]) - float(previous.bbox[3])
            if gap > 0 and gap / profile.median_gap > FOOTNOTE_GAP_RATIO:
                labels.append(f"与上一块间距较大（{gap / profile.median_gap:.1f}× 行距）")
    return labels


def _margin_note_signal(block, page, project) -> tuple[str, str] | None:
    """版心外左右两侧、短行、不是页码 → 旁批候选（只给 review）。"""
    text = (block.text or "").strip()
    if not text or len(text) > MARGIN_NOTE_MAX_CHARS:
        return None
    if looks_like_a_number(text):
        return None
    if block.bbox is None:
        return None
    center_x = (block.bbox[0] + block.bbox[2]) / 2
    center_y = (block.bbox[1] + block.bbox[3]) / 2
    box = margin_box_module.effective_margin_box(project, page)
    if box is not None and page.margin_box_mode != margin_box_module.MODE_NONE:
        if not (box[1] <= center_y <= box[3]):
            return None
        if center_x < box[0]:
            side, region = "左", REGION_LEFT
        elif center_x > box[2]:
            side, region = "右", REGION_RIGHT
        else:
            return None
        where = f"位于版心外{side}侧"
    else:
        if not (0.10 <= center_y <= 0.90):
            return None
        if center_x <= 0.10:
            side, region = "左", REGION_LEFT
        elif center_x >= 0.90:
            side, region = "右", REGION_RIGHT
        else:
            return None
        where = f"位于页面{side}侧（版心未设置）"
    return (
        f"{where}；短行（{len(text)} 字）；不是页码 / 罗马数字",
        region,
    )


def _note_suggestion(
    block,
    page,
    page_blocks: list,
    index: int,
    profile: _LineProfile,
    project,
    *,
    allow_margin_note: bool = True,
) -> BlockSuggestion | None:
    """脚注 / 旁批的**只读 review** 建议。

    **永远不返回 high**：误标会让这段文字离开正文。这里固定写 review，
    不经过 `_with_confidence`；`scan_high_suggestions` 也不会看到它们。
    """
    if block.block_type not in (BLOCK_TYPE_PARAGRAPH, BLOCK_TYPE_OTHER):
        return None
    text = (block.text or "").strip()
    if not text:
        return None
    # 纯数字 / 罗马数字是页码（或页码碎片），交给边缘条带的 page_number 建议
    if looks_like_a_number(text):
        return None

    if len(text) <= FOOTNOTE_MAX_CHARS:
        signals = _footnote_signal_labels(
            block, page, page_blocks, index, profile, project
        )
        # 位置 + 间距两条**还不够**：真书第 5/6 页的「豆瓣id:坏卡超」这类署名
        # 正好在版心下沿、与上一块间距很大，会被误报。必须再有"注释符号"或
        # "行高较小"其中一条才给建议——宁可漏报，也不制造噪声（只给 review 也一样）。
        anchored = any(
            label.startswith("注释符号") or label.startswith("行高较小")
            for label in signals
        )
        if len(signals) >= 2 and anchored:
            return BlockSuggestion(
                block_id=block.block_id,
                page_no=block.page_no,
                order_index=block.order_index,
                current_type=block.block_type,
                suggested_type=BLOCK_TYPE_FOOTNOTE,
                confidence=CONFIDENCE_REVIEW,
                region=REGION_BOTTOM,
                reason=(
                    f"命中 {len(signals)} 条脚注信号：" + "；".join(signals)
                    + "。脚注建议只给「需确认」——误标会让这段文字离开正文。"
                ),
                chars=len(text),
                repeat_matches=0,
                note_signals=tuple(signals),
            )

    if not allow_margin_note:
        return None
    margin = _margin_note_signal(block, page, project)
    if margin is not None:
        detail, region = margin
        return BlockSuggestion(
            block_id=block.block_id,
            page_no=block.page_no,
            order_index=block.order_index,
            current_type=block.block_type,
            suggested_type=BLOCK_TYPE_MARGIN_NOTE,
            confidence=CONFIDENCE_REVIEW,
            region=region,
            reason=(
                f"命中旁批信号：{detail}。旁批建议只给「需确认」——误标会让这段文字离开正文。"
            ),
            chars=len(text),
            repeat_matches=0,
            note_signals=(detail,),
        )
    return None


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
      以及只给 review 的**标题**建议（`第X回 / 第X章` 这类标记）；
    - **脚注 / 旁批**：位置 + 字号（行框高度代理）+ 注释符号 + 与上块间距；
      命中至少 2 条且有一条"注释符号 / 行高较小"才给建议，**永远只给 review**。
      误标会让这段文字离开正文，所以「全库采用高把握」与自动应用都不会碰它们
      （`scan_high_suggestions` 里还有一道同样的安全阀）。

    **任何规则都不自动改块类型**；本函数只读 `page` / `block` / `block_line`。
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
    page_blocks = sorted(
        (block for block in blocks if block.page_no == page_no),
        key=lambda block: (block.order_index, block.block_id),
    )
    project = library_module.load_project(project_id, library=target_library)
    line_profile = _line_profile(project_id, blocks, target_library)

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
    for block_index, block in enumerate(page_blocks):
        # 已经是脚注 / 旁批的块不再给建议（避免"脚注 → 页脚"这类改错的建议）
        if block.block_type in (BLOCK_TYPE_FOOTNOTE, BLOCK_TYPE_MARGIN_NOTE):
            continue
        # 脚注优先于边缘条带：脚注只给 review，比把脚注标成页脚（可能 high）安全。
        # 旁批不覆盖"跨页重复"的 high 页眉：竖排书的左侧短行通常是书眉，不是旁批。
        candidate = scored.get(block.block_id)
        # 高把握的**页眉**不覆盖（竖排书左侧短行是书眉）；高把握的页脚 / 页码才让旁批
        # 以 review 的形式优先——误标一个页脚也会让文字离开正文。
        allow_margin_note = not (
            candidate is not None
            and candidate.confidence == CONFIDENCE_HIGH
            and candidate.proposed_type == BLOCK_TYPE_HEADER
        )
        note = _note_suggestion(
            block,
            target,
            page_blocks,
            block_index,
            line_profile,
            project,
            allow_margin_note=allow_margin_note,
        )
        if note is not None:
            suggestions.append(note)
            continue

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
        page_numbers=tuple(_page_number_hints(page_no, page_blocks, scored, suggestions)),
    )


def _page_number_hints(page_no, page_blocks, scored, suggestions) -> list[PageNumberHint]:
    """这一页里"可能要把页码拆出去"的块（只读提示，不写库、不自动拆）。

    - 已经是 header / footer / page_number 的块：不看类型建议（类型已经对了）；
    - 被建议成这三类之一的块：也算（用户可能先拆页码、后采用类型）。
    只收**贴着块首 / 块尾**的候选：夹在正文中间的"第 11 章"不提示。
    """
    edge_types = {BLOCK_TYPE_HEADER, BLOCK_TYPE_FOOTER, BLOCK_TYPE_PAGE_NUMBER}
    suggested_edge = {
        item.block_id
        for item in suggestions
        if item.suggested_type in edge_types
    }
    hints: list[PageNumberHint] = []
    for block in page_blocks:
        if block.block_type not in edge_types and block.block_id not in suggested_edge:
            continue
        text = (block.text or "").strip()
        if not text:
            continue
        usable = tuple(
            item
            for item in page_number_candidates(text)
            if bool(text[: item.start].strip()) != bool(text[item.end :].strip())
        )
        if not usable:
            continue
        hints.append(
            PageNumberHint(
                block_id=block.block_id,
                page_no=page_no,
                order_index=block.order_index,
                block_type=block.block_type,
                text=text,
                candidates=usable,
                hint=page_number_hint(usable, block.bbox) if block.bbox else usable[-1],
            )
        )
    return hints


# ---------------------------------------------------------------- 全库扫描高把握建议

@dataclass(frozen=True)
class HighSuggestionPlan:
    """一次"全库采用高把握建议"的预览：只描述，不写库。"""

    pages_scanned: int
    blocks_scanned: int
    items: tuple[tuple[str, str, int], ...]
    """(block_id, suggested_type, page_no)，按页码 / 阅读顺序排列。"""

    by_type: dict[str, int]
    samples: tuple[dict[str, object], ...]

    @property
    def pages_affected(self) -> int:
        return len({page_no for _, _, page_no in self.items})

    def to_dict(self) -> dict[str, object]:
        return {
            "pages_scanned": self.pages_scanned,
            "blocks_scanned": self.blocks_scanned,
            "pages": self.pages_affected,
            "blocks": len(self.items),
            "by_type": dict(self.by_type),
            "samples": [dict(item) for item in self.samples],
        }


def scan_high_suggestions(
    project_id: str,
    *,
    library: Path | None = None,
    rules: HeaderFooterRules | None = None,
    page_numbers: Collection[int] | None = None,
    limit_samples: int = 8,
) -> HighSuggestionPlan:
    """全库扫一遍：哪些块会被"采用高把握建议"改类型（**只读**）。

    规则与 `suggest_block_types` 完全是同一套（`_region_of` + `_propose` +
    `_with_confidence`，跨页重复统计也一样），区别只在**一次算完所有页**：
    逐页调那个函数会对整本书的块重复扫描（267 页 × 全书块数），在真项目上要几分钟。

    `page_numbers` 只过滤**结果**（例如自动应用只处理本任务认完的页），
    跨页重复统计仍然用全书——否则书眉只出现一两次，会被误判成"需确认"。
    """
    active = rules or HeaderFooterRules()
    target_library = library if library is not None else default_library_dir()
    pages = list_pages(project_id, library=target_library)
    eligible = {page.page_no for page in pages if page.page_type in active.page_types}
    if not eligible:
        return HighSuggestionPlan(0, 0, (), {}, ())
    pages_by_no = {page.page_no: page for page in pages if page.page_no in eligible}

    blocks = [
        block
        for block in blocks_module.list_blocks(project_id, library=target_library)
        if block.page_no in eligible
    ]
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
        candidates.append(
            Candidate(
                block_id=block.block_id,
                page_no=block.page_no,
                text=text,
                bbox=block.bbox,
                current_type=block.block_type,
                proposed_type=proposed,
                region=region,
                reason=reason,
            )
        )
    scored = {candidate.block_id: candidate for candidate in _with_confidence(candidates)}

    # 安全阀：脚注 / 旁批只给 review，但边缘条带可能把同一块算成 high 页脚 / 书眉。
    # 全库扫描（「采用高把握」与自动应用都走这里）必须在 high 之前再挡一次：
    # 只要这一块命中脚注 / 旁批信号，就不进批量——否则自动应用会把注文改出正文。
    project = library_module.load_project(project_id, library=target_library)
    line_profile = _line_profile(project_id, blocks, target_library)
    blocks_by_page: dict[int, list] = {}
    for block in blocks:
        blocks_by_page.setdefault(block.page_no, []).append(block)
    for items in blocks_by_page.values():
        items.sort(key=lambda block: (block.order_index, block.block_id))
    page_index = {
        (block.page_no, block.block_id): index
        for page_no, page_blocks in blocks_by_page.items()
        for index, block in enumerate(page_blocks)
    }

    wanted = set(page_numbers) if page_numbers else None
    items: list[tuple[str, str, int]] = []
    by_type: dict[str, int] = {}
    samples: list[dict[str, object]] = []
    for block in blocks:
        if wanted is not None and block.page_no not in wanted:
            continue
        # 已经是注文类型：不许被批量改成页脚 / 书眉
        if block.block_type in (BLOCK_TYPE_FOOTNOTE, BLOCK_TYPE_MARGIN_NOTE):
            continue
        candidate = scored.get(block.block_id)
        if candidate is None:
            continue
        if candidate.proposed_type == block.block_type:
            continue
        if candidate.confidence != CONFIDENCE_HIGH:
            continue
        # 标题永远不进批量：`looks_like_heading` 只给 review，这里再挡一道
        if candidate.proposed_type == BLOCK_TYPE_HEADING:
            continue
        note = _note_suggestion(
            block,
            pages_by_no[block.page_no],
            blocks_by_page.get(block.page_no, []),
            page_index.get((block.page_no, block.block_id), 0),
            line_profile,
            project,
            # 高把握页眉保留（竖排书眉）；高把握页脚才让旁批 review 优先
            allow_margin_note=candidate.proposed_type != BLOCK_TYPE_HEADER,
        )
        if note is not None:
            continue
        items.append((block.block_id, candidate.proposed_type, block.page_no))
        by_type[candidate.proposed_type] = by_type.get(candidate.proposed_type, 0) + 1
        if len(samples) < limit_samples:
            samples.append(
                {
                    "page_no": block.page_no,
                    "order_index": block.order_index,
                    "block_id": block.block_id,
                    "text": block.text[:60],
                    "current_type": block.block_type,
                    "suggested_type": candidate.proposed_type,
                    "confidence_label": CONFIDENCE_LABELS.get(
                        candidate.confidence, candidate.confidence
                    ),
                }
            )

    return HighSuggestionPlan(
        pages_scanned=len(eligible),
        blocks_scanned=len(blocks),
        items=tuple(items),
        by_type=by_type,
        samples=tuple(samples),
    )
