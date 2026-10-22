"""段生成（说明书 9.1）。

按全书阅读顺序遍历块，把 ``continues_to_next = true`` 的块与下一个符合条件的块
合并为同一段。段是导出的单位，也是"段 ID"的载体。

**段 ID = 首块的 `block_id`**（说明书 5.3）。只要首块不被删除或拆分，段 ID 就稳定，
可供后续双语对齐引用。

**关于 `continues_to_next`：** 说明书**没有**设计自动判断跨页段落——它出现在
"块操作"清单里（6.4 / 7.4 的"标记延续到下一页"），是**人工标记**。
因此本模块只按标记行事，不猜测"这两段看起来该连"。

**与持久化的关系：** `SegmentSource` 是说明书 5.3 的 `Block` 实体中与段生成相关的
字段子集。真正的 `Block`（含 `block_id`、`review_status`、`revision` 等）已在
`core/project/` 的存储层实现，由 `core/export/project.py` 从项目数据库读出后
装成 `SegmentSource` 喂进来。本模块仍只依赖这个轻量输入，便于独立测试，
也不把存储细节带进文本规则。
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass, field

from .joining import HyphenationRestore, head_fragment, join_pair

# ---------------------------------------------------------------- 块类型常量
#
# 说明书 5.3 的 block_type 取值。本模块只用到其中几个来判定"单独成段"与"导出范围内"。

BLOCK_TYPE_HEADING = "heading"
BLOCK_TYPE_PARAGRAPH = "paragraph"
BLOCK_TYPE_HEADER = "header"
BLOCK_TYPE_FOOTER = "footer"
BLOCK_TYPE_PAGE_NUMBER = "page_number"
BLOCK_TYPE_FOOTNOTE = "footnote"
BLOCK_TYPE_MARGIN_NOTE = "margin_note"
BLOCK_TYPE_CAPTION = "caption"
BLOCK_TYPE_FIGURE = "figure"
BLOCK_TYPE_DECORATION = "decoration"
BLOCK_TYPE_OTHER = "other"

ALL_BLOCK_TYPES = frozenset({
    BLOCK_TYPE_HEADING, BLOCK_TYPE_PARAGRAPH, BLOCK_TYPE_HEADER, BLOCK_TYPE_FOOTER,
    BLOCK_TYPE_PAGE_NUMBER, BLOCK_TYPE_FOOTNOTE, BLOCK_TYPE_MARGIN_NOTE,
    BLOCK_TYPE_CAPTION, BLOCK_TYPE_FIGURE, BLOCK_TYPE_DECORATION, BLOCK_TYPE_OTHER,
})

# 插图与侧边装饰**永远不输出文本**（第 35 号任务的口径）：它们可以没有文本，
# 也可能带着 OCR 读出来的零星字符，但那些字符不属于正文。导出开关不覆盖这一条。
TEXT_FREE_TYPES = frozenset({BLOCK_TYPE_FIGURE, BLOCK_TYPE_DECORATION})

# 说明书 9.3：「排除页眉 / 页脚 / 页码块」默认开启，按块类型排除。
DEFAULT_EXCLUDED_TYPES = frozenset({
    BLOCK_TYPE_HEADER, BLOCK_TYPE_FOOTER, BLOCK_TYPE_PAGE_NUMBER,
})

# 说明书 9.1 第 3 条：标题块单独成段，不与前后正文合并。
STANDALONE_TYPES = frozenset({BLOCK_TYPE_HEADING})

REVIEW_UNREVIEWED = "unreviewed"
REVIEW_CONFIRMED = "confirmed"
REVIEW_UNCERTAIN = "uncertain"


@dataclass(frozen=True)
class SegmentHyphenation:
    """段内的一次断词还原，供 manifest 抽查（说明书 9.2 / 9.5）。

    断词还原有两个来源，``scope`` 区分它们；``position`` 相对于各自那份文本：

    - ``"block"``：块内换行处，``position`` 相对**该块的拼接文本**。
    - ``"segment"``：跨块拼接处，``position`` 相对**该段的拼接文本**。
    """

    block_id: str
    scope: str
    position: int
    left_fragment: str
    right_fragment: str
    hyphen: str

    def to_dict(self) -> dict[str, object]:
        return {
            "block_id": self.block_id,
            "scope": self.scope,
            "position": self.position,
            "left_fragment": self.left_fragment,
            "right_fragment": self.right_fragment,
            "hyphen": self.hyphen,
        }


@dataclass(frozen=True)
class SegmentSource:
    """段生成的输入：一个块的必要字段。

    字段名与说明书 5.3 的 `Block` 实体保持一致，便于将来直接对接。
    """

    block_id: str
    page_no: int
    order_index: int
    block_type: str
    text: str                        # 已按 9.2 拼好的段落文本（不含行内换行）
    include: bool = True
    deleted: bool = False
    review_status: str = REVIEW_UNREVIEWED
    continues_to_next: bool = False
    ocr_text: str | None = None      # 用于推导"已修改"，缺省表示未知
    # 该块内部（块内换行处）的断词还原记录，位置相对本块的拼接文本
    hyphenations: tuple[HyphenationRestore, ...] = ()


@dataclass(frozen=True)
class ReviewSummary:
    all_confirmed: bool
    unreviewed: int
    uncertain: int
    modified: bool | None            # None 表示输入未提供 ocr_text，无法判断

    def to_dict(self) -> dict[str, object]:
        return {
            "all_confirmed": self.all_confirmed,
            "unreviewed": self.unreviewed,
            "uncertain": self.uncertain,
            "modified": self.modified,
        }


@dataclass(frozen=True)
class Segment:
    """一个导出段（说明书 5.3：Segment 是导出时推导的，不单独存储）。"""

    seq: int                      # 全书顺序，从 1 开始
    segment_id: str               # = 首块的 block_id（说明书 5.3）
    block_type: str               # 取首块的类型
    text: str
    pages: tuple[int, ...]
    block_ids: tuple[str, ...]
    review: ReviewSummary
    # 段内所有断词还原：块内的（scope="block"）与跨块拼接处的（scope="segment"）
    hyphenations: tuple[SegmentHyphenation, ...] = ()

    @property
    def char_count(self) -> int:
        return len(self.text)

    def to_dict(self) -> dict[str, object]:
        return {
            "seq": self.seq,
            "segment_id": self.segment_id,
            "type": self.block_type,
            "text": self.text,
            "pages": list(self.pages),
            "block_ids": list(self.block_ids),
            "review": self.review.to_dict(),
            "hyphenations": [item.to_dict() for item in self.hyphenations],
        }


@dataclass
class _Pending:
    """正在累积的段——只是一个块列表，文本在 flush 时统一拼接。"""

    blocks: list[SegmentSource] = field(default_factory=list)

    def clear(self) -> None:
        self.blocks = []


def build_segments(
    sources: Sequence[SegmentSource],
    *,
    excluded_types: Collection[str] = DEFAULT_EXCLUDED_TYPES,
    allowed_types: Collection[str] | None = None,
    confirmed_only: bool = False,
    included_pages: Collection[int] | None = None,
    pages_in_scope: Collection[int] | None = None,
) -> list[Segment]:
    """按说明书 9.1 生成段。

    参数对应 9.1 第 1 条的筛选条件：

    - ``included_pages``：``Page.include = true`` 的页；``None`` 表示不按页筛选。
    - ``pages_in_scope``：页面类型在导出范围内的页；``None`` 表示不筛选。
    - ``excluded_types``：按块类型排除（9.3 默认排除页眉 / 页脚 / 页码）。
    - ``allowed_types``：块类型必须在导出范围内；``None`` 表示不限制。
    - ``confirmed_only``：范围设为"仅已确认"时，块须为 confirmed。

    排序按 ``(page_no, order_index)``——即全书阅读顺序。
    """
    if included_pages is not None and not isinstance(included_pages, (set, frozenset)):
        included_pages = set(included_pages)
    if pages_in_scope is not None and not isinstance(pages_in_scope, (set, frozenset)):
        pages_in_scope = set(pages_in_scope)

    ordered = sorted(sources, key=lambda item: (item.page_no, item.order_index))

    qualified: list[SegmentSource] = []
    for block in ordered:
        if block.deleted:
            continue
        if not block.include:
            continue
        if block.block_type in TEXT_FREE_TYPES:
            continue
        if block.block_type in excluded_types:
            continue
        if allowed_types is not None and block.block_type not in allowed_types:
            continue
        if included_pages is not None and block.page_no not in included_pages:
            continue
        if pages_in_scope is not None and block.page_no not in pages_in_scope:
            continue
        if confirmed_only and block.review_status != REVIEW_CONFIRMED:
            continue
        if not block.text.strip():
            continue
        qualified.append(block)

    segments: list[Segment] = []
    pending = _Pending()

    def flush() -> None:
        if pending.blocks:
            segments.append(_finish_segment(pending.blocks, len(segments) + 1))
            pending.clear()

    for block in qualified:
        if not pending.blocks:
            pending.blocks.append(block)
            continue

        previous = pending.blocks[-1]
        # 说明书 9.1 第 2、3 条：只有"上一块声明延续"且两侧都不是标题时才合并。
        # 被排除的页眉 / 页脚 / 页码块已在前面过滤掉，因此"自动跳过"是自然结果。
        mergeable = (
            previous.continues_to_next
            and previous.block_type not in STANDALONE_TYPES
            and block.block_type not in STANDALONE_TYPES
        )
        if mergeable:
            pending.blocks.append(block)
        else:
            flush()
            pending.blocks.append(block)

    flush()
    return segments


def _finish_segment(blocks: Iterable[SegmentSource], seq: int) -> Segment:
    block_list = list(blocks)
    first = block_list[0]

    pages: list[int] = []
    for block in block_list:
        if not pages or pages[-1] != block.page_no:
            pages.append(block.page_no)

    unreviewed = sum(1 for b in block_list if b.review_status == REVIEW_UNREVIEWED)
    uncertain = sum(1 for b in block_list if b.review_status == REVIEW_UNCERTAIN)
    all_confirmed = all(b.review_status == REVIEW_CONFIRMED for b in block_list)

    ocr_texts = [b.ocr_text for b in block_list]
    if any(text is None for text in ocr_texts):
        modified: bool | None = None
    else:
        modified = any(
            b.text != b.ocr_text for b in block_list if b.ocr_text is not None
        )

    text = ""
    hyphenations: list[SegmentHyphenation] = []
    for block in block_list:
        # 块内换行处的断词还原（由 9.2 的 join_lines 产出，位置相对本块文本）
        for record in block.hyphenations:
            hyphenations.append(
                SegmentHyphenation(
                    block_id=block.block_id,
                    scope="block",
                    position=record.position,
                    left_fragment=record.left_fragment,
                    right_fragment=record.right_fragment,
                    hyphen=record.hyphen,
                )
            )

        if not text:
            text = block.text
            continue

        # 说明书 9.2：跨块拼接与块内换行使用同一规则，因此这里也可能触发断词还原
        merged, left_fragment, hyphen = join_pair(text, block.text)
        if hyphen is not None:
            hyphenations.append(
                SegmentHyphenation(
                    block_id=block.block_id,
                    scope="segment",
                    position=len(merged) - len(block.text),
                    left_fragment=left_fragment,
                    right_fragment=head_fragment(block.text),
                    hyphen=hyphen,
                )
            )
        text = merged

    return Segment(
        seq=seq,
        segment_id=first.block_id,
        block_type=first.block_type,
        text=text,
        pages=tuple(dict.fromkeys(pages)),
        block_ids=tuple(b.block_id for b in block_list),
        review=ReviewSummary(
            all_confirmed=all_confirmed,
            unreviewed=unreviewed,
            uncertain=uncertain,
            modified=modified,
        ),
        hyphenations=tuple(hyphenations),
    )
