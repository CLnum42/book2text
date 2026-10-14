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
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from ..storage import db as db_module
from ..storage.ulid import new_ulid
from . import blocks as blocks_module
from . import editing
from .library import ProjectError, default_library_dir, list_pages, project_dir

# 说明书 6.5 的默认区域高度
DEFAULT_REGION_RATIO = 0.08
# "字数少于 N" 的默认值：页眉页脚通常很短（"第三章 · 45"），正文段落不会这么短
DEFAULT_MAX_CHARS = 20

# 位置的归属：落在顶部区域算页眉、底部区域算页脚；数字形态的算页码
REGION_TOP = "top"
REGION_BOTTOM = "bottom"

BLOCK_TYPE_HEADER = "header"
BLOCK_TYPE_FOOTER = "footer"
BLOCK_TYPE_PAGE_NUMBER = "page_number"
BLOCK_TYPE_PARAGRAPH = "paragraph"

# 纯数字 / 罗马数字（允许常见的装饰字符包着，如 "· 62 ·"、"- iv -"）
_NUMBER_PATTERN = re.compile(
    r"^[\s.·•\-–—_=~*()\[\]{}【】〔〕「」『』<>]*"
    r"(\d{1,4}|[ivxlcdmIVXLCDM]{1,12})"
    r"[\s.·•\-–—_=~*()\[\]{}【】〔〕「」『』<>]*$"
)


@dataclass(frozen=True)
class HeaderFooterRules:
    """说明书 6.5 的规则参数。全部以**比例**表示，与渲染尺寸无关。"""

    top_ratio: float = DEFAULT_REGION_RATIO
    bottom_ratio: float = DEFAULT_REGION_RATIO
    max_chars: int | None = DEFAULT_MAX_CHARS
    # 作用范围：默认全部纳入的正文页
    page_types: tuple[str, ...] = ("body",)
    # 是否把"纯数字 / 罗马数字"单独标成页码（说明书 6.5 的文本条件）
    detect_page_numbers: bool = True

    def to_dict(self) -> dict:
        return {
            "top_ratio": self.top_ratio,
            "bottom_ratio": self.bottom_ratio,
            "max_chars": self.max_chars,
            "page_types": list(self.page_types),
            "detect_page_numbers": self.detect_page_numbers,
        }


@dataclass(frozen=True)
class Candidate:
    """一个"将会被标注"的块。"""

    block_id: str
    page_no: int
    text: str
    bbox: tuple[float, float, float, float] | None
    current_type: str
    proposed_type: str
    region: str
    reason: str

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
        return {
            "rules": self.rules.to_dict(),
            "candidate_count": len(self.candidates),
            "by_type": by_type,
            "pages_scanned": self.pages_scanned,
            "sample_pages": sorted({item.page_no for item in self.candidates}),
            "candidates": [item.to_dict() for item in self.candidates],
            "skipped": [item.to_dict() for item in self.skipped][:50],
            "skipped_count": len(self.skipped),
        }


def looks_like_a_number(text: str) -> bool:
    """纯数字或罗马数字（允许被装饰字符包着）。"""
    return bool(_NUMBER_PATTERN.match(text.strip()))


def _region_of(bbox: tuple[float, float, float, float], rules: HeaderFooterRules) -> str | None:
    """块落在顶部 / 底部区域吗？都不是就返回 None。"""
    x0, y0, x1, y1 = bbox
    # 整块都在区域里才算：跨界的大段落不该被当成页眉
    if y1 <= rules.top_ratio:
        return REGION_TOP
    if y0 >= 1 - rules.bottom_ratio:
        return REGION_BOTTOM
    return None


def _propose(text: str, region: str, rules: HeaderFooterRules) -> tuple[str, str]:
    """位置 + 文本条件 → 该标成什么类型。"""
    if rules.detect_page_numbers and looks_like_a_number(text):
        return BLOCK_TYPE_PAGE_NUMBER, "在区域内，且是纯数字 / 罗马数字"
    if region == REGION_TOP:
        return BLOCK_TYPE_HEADER, "整块落在页面顶部区域"
    return BLOCK_TYPE_FOOTER, "整块落在页面底部区域"


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
        if page.include and page.page_type in active.page_types
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
        candidates=tuple(candidates),
        skipped=tuple(skipped),
        pages_scanned=len(pages),
    )


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
