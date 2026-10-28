"""纯标点 / 空格差异：按**模式**分组批量裁决（任务 61）。

用户 2026-10-28 的现场（《红楼梦》3，1676 条差异行）：

- 含汉字差异 **966** 行；纯标点 / 空格差异 **710** 行。
- 先试过归一化（全角半角统一、去空格）：只消掉 **12** 行——这些不是等价写法，
  是真的不一致，所以不能靠"预处理"抹掉。
- 但按模式分组，710 行只有 **64 种模式**，前 50 种覆盖 98%：

```
293 行  ；→，
119 行  ∅→‘      （候选多一个单引号）
 50 行  ∅→”
 44 行  ∅→—
 19 行  ∅→——
```

`∅→‘` / `∅→”` / `∅→—` 这几类大概率是 RapidOCR 系统性地吞掉开头引号 / 破折号——
**批量采用候选是修掉真错**，不是为了省事。

所以主队列只放含汉字差异，纯标点进这个"按模式批量"面板：每组的三个动作是
全部采用候选 / 全部保留原文 / 逐条看。

**裁决落到行上（`block_line.diff_ack`），不是另存一份模式表。** 理由：

- 队列、进度、导出、撤销全部已经有"按行"的口径，再引入一套模式级状态就会出现
  两个真相（用户最怕的就是"数字对不上"）。
- 一个模式的所有行一次性写进**同一个 batch**，撤销一次全退——这就是"判过的模式可以撤销"。
- "逐条看"只在前端把这一组放回主队列，不需要后端状态。
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass
from pathlib import Path

from . import blocks as blocks_module
from . import editing
from . import library as library_module
from . import margin_box as margin_box_module
from ..ocr import compare as compare_module
from ..storage.ulid import new_ulid

EMPTY_MARK = "∅"
"""模式里表示"这一边没有字符"的记号：`∅→‘` 读作"原文缺单引号，候选有"。"""

#: 标点类别：**英文**按这一层归并（`'→∅`、`'→"`、`'→␣` 都算「引号被改动」）。
#: 中文保持精确片段（`；→，` 这种用户一眼能判断）。
PUNCT_CLASSES = {
    "'": "引号", '"': "引号", "‘": "引号", "’": "引号", "“": "引号", "”": "引号",
    ".": "句点", "。": "句点", ",": "逗号", "，": "逗号", ";": "分号", "；": "分号",
    ":": "冒号", "：": "冒号", "-": "破折号", "–": "破折号", "—": "破折号",
    "―": "破折号", "?": "问号", "？": "问号", "!": "叹号", "！": "叹号",
    " ": "空格", "␣": "空格", "∅": "无",
}


def punct_class(char: str) -> str:
    return PUNCT_CLASSES.get(char, "其他")


def _is_english_pattern(pairs: list[tuple[str, str]]) -> bool:
    """片段里是不是**全是 ASCII**（英文页的引号 / 句点 / 撇号这类）。"""
    chars = [c for a, b in pairs for c in (a + b) if c not in "␣∅"]
    return bool(chars) and all(ord(c) < 128 for c in chars)


def _dominant(pairs: list[tuple[str, str]]) -> tuple[str, str]:
    """一行里"最主要的那个改动"：非空格优先，其次片段更长。"""

    def weight(pair: tuple[str, str]) -> tuple[int, int]:
        a, b = pair
        non_empty = (a not in ("", " ")) or (b not in ("", " "))
        return (1 if non_empty else 0, max(len(a), len(b)))

    return sorted(pairs, key=weight, reverse=True)[0]


def _group_key(pairs: list[tuple[str, str]]) -> str:
    """分组键：中文 = 精确片段，英文 = 主片段的标点类别。"""
    if _is_english_pattern(pairs):
        a, b = _dominant(pairs)
        return f"[英] {punct_class(a[:1] or EMPTY_MARK)}→{punct_class(b[:1] or EMPTY_MARK)}"
    return pattern_key(pairs)


SAMPLE_LIMIT = 5
"""每组给几条带上下文的样例（用户凭 5 条就能判断整组该采用还是该保留）。"""


@dataclass(frozen=True)
class PunctLine:
    block_id: str
    page_no: int
    line_index: int
    text: str
    candidate_text: str
    ack: str | None
    key: str = ""
    pattern: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "block_id": self.block_id,
            "page_no": self.page_no,
            "line_index": self.line_index,
            "text": self.text,
            "candidate_text": self.candidate_text,
            "ack": self.ack,
            "pattern": self.pattern,
        }


def fragments(current: str, candidate: str) -> list[tuple[str, str]]:
    """一行的**差异片段**：[(原文片段, 候选片段), …]。

    整行文本不能当模式（710 行会变成 710 种"模式"）。按字符匹配找出真正变化的那几段，
    同一行里相同的片段只算一次——`；→，` 出现两次仍属于同一种模式。
    """
    matcher = difflib.SequenceMatcher(a=current, b=candidate, autojunk=False)
    seen: list[tuple[str, str]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        pair = (current[i1:i2], candidate[j1:j2])
        if pair not in seen:
            seen.append(pair)
    return seen


def pattern_key(pairs: list[tuple[str, str]]) -> str:
    """模式键：`；→，`、`∅→‘`；一行有多种片段时用 `|` 连接（稳定、可作接口参数）。"""
    return "|".join(f"{_raw(a)}→{_raw(b)}" for a, b in pairs)


def _hint(key: str, items: list[PunctLine]) -> str:
    """给一组的"该怎么办"。

    2026-10-28 实测（双语书）：`[英] 引号→无` 728 行里，原文有撇号、**候选把撇号
    变成了空格或直接删掉**（页 36 实图：`She'll` / `we'll` / `it's` 都在，文字层却读成
    `She ll`）。所以这一类**不能"全部采用候选"**——那会把正确的撇号删掉。
    """
    if not key.startswith("[英]"):
        return ""
    if "引号→无" in key or "引号→空格" in key or "引号→其他" in key:
        return "候选少了引号 / 撇号（多半是文字层的问题）· 建议保留原文"
    if "无→引号" in key:
        return "原文少了引号 / 撇号（OCR 吞掉了）· 建议采用候选"
    return ""


def _raw(text: str) -> str:
    """模式键里的原文：空格写成 `␣`，空串写成 `∅`（不然前端根本看不见/传不了）。"""
    if not text:
        return EMPTY_MARK
    return text.replace(" ", "␣").replace("\u3000", "␣")


def _collect_lines(
    project_id: str,
    library: Path | None = None,
    index: "blocks_module.DivergenceIndex | None" = None,
) -> list[tuple[PunctLine, str, str]]:
    """收集"只有标点 / 空格差异"的行：返回 (行, 模式键, 模式显示)。"""
    target_library = library if library is not None else library_module.default_library_dir()
    idx = index or blocks_module.divergence_index(project_id, library=target_library)
    project = idx.project
    pages = list(idx.pages.values())
    page_by_no = {page.page_no: page for page in pages}
    blocks = list(idx.blocks)
    lines_by_block = idx.lines_by_block

    collected: list[tuple[PunctLine, str, str]] = []
    for block in blocks:
        if not block.include:
            continue
        if block.block_type not in _QUEUE_BLOCK_TYPES:
            continue
        page = page_by_no.get(block.page_no)
        if page is None:
            continue
        if not margin_box_module.block_inside_margin(project, page, block.bbox):
            continue
        lines = lines_by_block.get(block.block_id, [])
        divergence = idx.by_block.get(block.block_id) or blocks_module.EMPTY_BLOCK_DIVERGENCE
        if divergence.stale:
            continue
        line_records = {line.line_index: line for line in lines}
        for mark in divergence.marks:
            if mark.level != compare_module.DIFFERS_PUNCT:
                continue
            record = line_records.get(mark.line_index)
            if record is None or record.aux_text is None:
                continue
            pairs = fragments(mark.current, record.aux_text)
            key = _group_key(pairs)
            collected.append(
                (
                    PunctLine(
                        block_id=block.block_id,
                        page_no=block.page_no,
                        line_index=mark.line_index,
                        # 样例给人看：整行原文 + 整行候选
                        text=mark.current,
                        candidate_text=record.aux_text,
                        ack=mark.ack,
                        key=key,
                        pattern=key.replace("|", " "),
                    ),
                    key,
                    key.replace("|", " "),
                )
            )
    return collected


#: 与审校队列同一集合（脚注 / 图注不进连续正文流）——导入放在这里避免循环依赖
_QUEUE_BLOCK_TYPES = frozenset({"paragraph", "heading"})


def collect(
    project_id: str,
    *,
    library: Path | None = None,
    index: "blocks_module.DivergenceIndex | None" = None,
) -> dict:
    """按"差异模式"分组（`；→，`、`∅→‘`…），每组给数量、样例与裁决进度。"""
    groups: dict[str, list[PunctLine]] = {}
    for line, key, _pattern in _collect_lines(project_id, library, index):
        groups.setdefault(key, []).append(line)

    payload = []
    for key, items in sorted(groups.items(), key=lambda pair: (-len(pair[1]), pair[0])):
        adopted = sum(1 for item in items if item.ack == "adopted")
        kept = sum(1 for item in items if item.ack == "kept")
        undecided = len(items) - adopted - kept
        payload.append(
            {
                "key": key,
                "pattern": key.replace("|", " "),
                "hint": _hint(key, items),
                "count": len(items),
                "adopted": adopted,
                "kept": kept,
                "undecided": undecided,
                "decided": undecided == 0,
                # 样例优先给"还没裁决"的行：判过的行不该占住用户看样例的位置
                "samples": [
                    item.to_dict()
                    for item in sorted(items, key=lambda item: (item.ack is not None, item.page_no))[
                        :SAMPLE_LIMIT
                    ]
                ],
            }
        )
    totals = {
        "groups": len(payload),
        "lines": sum(item["count"] for item in payload),
        "undecided_lines": sum(item["undecided"] for item in payload),
        "undecided_groups": sum(1 for item in payload if item["undecided"]),
    }
    return {"groups": payload, "totals": totals}


def decide(
    project_id: str,
    *,
    key: str,
    ack: str,
    library: Path | None = None,
    actor_name: str | None = None,
) -> dict:
    """一个模式的所有行一次性裁决（同一个 batch，⌘Z 一次全退）。

    - `adopted`：把那一行换成第二引擎的文本（不是只写 ack）——这才是"采用候选"；
    - `kept`：只写 `diff_ack='kept'`，文本不动。
    """
    if ack not in ("adopted", "kept"):
        raise library_module.ProjectError(f"未知的裁决：{ack!r}")
    target_library = (
        library if library is not None else library_module.default_library_dir()
    )
    matched = [
        line
        for line, line_key, _pattern in _collect_lines(project_id, target_library)
        if line_key == key
    ]
    if not matched:
        raise library_module.ProjectError("这个模式在当前项目里已经没有待裁决的行了")

    batch = new_ulid()
    events: list = []
    pages: set[int] = set()
    applied = 0
    skipped = 0
    # 同一块里可能有多行命中同一模式：按块累积文本，避免后一行覆盖前一行的改动
    block_texts: dict[str, list[str]] = {}
    for line in matched:
        try:
            block = blocks_module.get_block(project_id, line.block_id, library=target_library)
            if block.block_id not in block_texts:
                block_texts[block.block_id] = (block.text or "").split("\n")
            lines = block_texts[block.block_id]
            if line.line_index >= len(lines):
                skipped += 1
                continue
            text = None
            if ack == "adopted":
                lines[line.line_index] = line.candidate_text
                text = "\n".join(lines)
            block_after, _line, item_events = editing.ack_diff_line(
                project_id,
                line.block_id,
                line.line_index,
                ack,
                text=text,
                library=target_library,
                actor_name=actor_name,
                batch_id=batch,
            )
            events.extend(item_events)
            pages.add(block_after.page_no)
            applied += 1
        except (library_module.ProjectError, editing.BlockConflict):
            # 一行失败不连累整组：真实状态优先于"一次成功"的漂亮数字
            skipped += 1
    return {
        "batch_id": batch,
        "applied": applied,
        "skipped": skipped,
        "events": events,
        "pages": sorted(pages),
        "ack": ack,
    }


# ---------------------------------------------------------------- 计数（收尾面板用）

def group_counts(
    project_id: str,
    *,
    library: Path | None = None,
    index: "blocks_module.DivergenceIndex | None" = None,
) -> dict:
    """标点差异的组数 / 行数 / 已判组数（收尾面板显示用；判定看行级 ack）。

    **不缓存。** 试过按 `project.updated_at` + 60 s 缓存，结果：第二引擎复核重跑会把
    `aux_text` 从"`。`"换成"`、`"（长度不变、也不动 project.updated_at），缓存就拿着
    旧分组说"标点已判完"。加长的指纹（块数 / 字数 / 已裁决数）仍然抓不住等长替换。
    宁可多花 0.35 s（394 页实测），也不要给出一个错的"已判完"。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    data = collect(project_id, library=target_library, index=index)
    totals = data["totals"]
    return {
        "groups": totals["groups"],
        "lines": totals["lines"],
        "decided_groups": totals["groups"] - totals["undecided_groups"],
        "undecided_groups": totals["undecided_groups"],
        "undecided_lines": totals["undecided_lines"],
    }
