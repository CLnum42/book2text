"""「疑似整行乱码」：识别把一整行打散成字母碎片，候选（Vision）是对的。

2026-10-28 用户书里实测：13,588 行有候选，其中 **106 行**原文字母散架：

```
原文：'phind,  n ons o ns a n onad'
候选：'philosophical traditions. By studying how such terms as'
```

这类行**长度远小于候选**（0.33–0.5 倍），或者单字母 token 占比过半。它们会直接进语料，
比个别错字严重得多，所以单独归一类，支持**批量采用候选**。

判据两条并列（都只针对"有候选"的行）：

1. 原文长度 < 候选长度的 55%；
2. 原文分词后，单字母单词占比 > 50%（至少 4 个 token 才判）。

裁决落到行上（`block_line.diff_ack` + 行文本），与「标点按模式批量」同一套机制：
一个 batch 一次全写，⌘Z 一次全退。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import blocks as blocks_module
from . import editing
from . import library as library_module
from ..storage.ulid import new_ulid

#: 原文长度 / 候选长度的下限（低于它判"散架"）
SHORT_RATIO = 0.55
#: 单字母 token 占比上限
SINGLE_LETTER_RATIO = 0.5
#: 判单字母占比前至少要有的 token 数（短行不判）
MIN_TOKENS = 4


@dataclass(frozen=True)
class GarbledLine:
    block_id: str
    line_index: int
    page_no: int
    text: str
    candidate: str

    @property
    def length_ratio(self) -> float:
        return len(self.text) / max(1, len(self.candidate))


def looks_garbled(text: str | None, candidate: str | None) -> bool:
    """这一行是不是"字母散架"。"""
    t = " ".join((text or "").split())
    c = " ".join((candidate or "").split())
    if not t or not c:
        return False
    if len(t) < SHORT_RATIO * len(c):
        return True
    tokens = t.split()
    if len(tokens) >= MIN_TOKENS:
        single = sum(1 for token in tokens if len(token) == 1 and token.isalpha())
        if single / len(tokens) > SINGLE_LETTER_RATIO:
            return True
    return False


def _collect(project_id: str, library: Path) -> list[GarbledLine]:
    rows = blocks_module.lines_with_candidates(project_id, library=library)
    out: list[GarbledLine] = []
    for row in rows:
        # 已经裁决过的行不再列出：采用候选改的是 `block.text`，`block_line.text`
        # 保留原样（审计用），所以只看文本会永远命中同一批行。
        if row.get("diff_ack"):
            continue
        if not looks_garbled(row.get("text"), row.get("aux_text")):
            continue
        out.append(
            GarbledLine(
                block_id=str(row["block_id"]),
                line_index=int(row["line_index"]),
                page_no=int(row.get("page_no") or 0),
                text=str(row.get("text") or ""),
                candidate=str(row.get("aux_text") or ""),
            )
        )
    return out


def collect(project_id: str, *, library: Path | None = None) -> dict:
    """列出疑似整行乱码的行（只读）。"""
    target = library if library is not None else library_module.default_library_dir()
    lines = _collect(project_id, target)
    pages = sorted({line.page_no for line in lines if line.page_no})
    return {
        "totals": {
            "lines": len(lines),
            "pages": len(pages),
            "candidates": blocks_module.count_lines_with_candidates(
                project_id, library=target
            ),
        },
        "items": [
            {
                "block_id": line.block_id,
                "line_index": line.line_index,
                "page_no": line.page_no,
                "text": line.text,
                "candidate": line.candidate,
                "length_ratio": round(line.length_ratio, 2),
            }
            for line in lines[:400]
        ],
        "pages": pages,
    }


def decide(
    project_id: str,
    *,
    ack: str,
    library: Path | None = None,
    actor_name: str | None = None,
) -> dict:
    """整批裁决（`adopted` = 全部换成候选；`kept` = 全部保留原文）。

    与「标点按模式批量」同一套写法：一次一个 batch，⌘Z 一次全退；
    一行失败不连累其它行（真实状态优先）。
    """
    if ack not in ("adopted", "kept"):
        raise library_module.ProjectError(f"未知的裁决：{ack!r}")
    target = library if library is not None else library_module.default_library_dir()
    lines = _collect(project_id, target)
    if not lines:
        raise library_module.ProjectError("当前项目没有疑似整行乱码的行了")

    batch = new_ulid()
    events: list = []
    pages: set[int] = set()
    applied = 0
    skipped = 0
    block_texts: dict[str, list[str]] = {}
    for line in lines:
        try:
            block = blocks_module.get_block(project_id, line.block_id, library=target)
            if block.block_id not in block_texts:
                block_texts[block.block_id] = (block.text or "").split("\n")
            parts = block_texts[line.block_id]
            if line.line_index >= len(parts):
                skipped += 1
                continue
            text = None
            if ack == "adopted":
                parts[line.line_index] = line.candidate
                text = "\n".join(parts)
            block_after, _line, item_events = editing.ack_diff_line(
                project_id,
                line.block_id,
                line.line_index,
                ack,
                text=text,
                library=target,
                actor_name=actor_name,
                batch_id=batch,
            )
            events.extend(item_events)
            pages.add(block_after.page_no)
            applied += 1
        except (library_module.ProjectError, editing.BlockConflict):
            skipped += 1
    return {
        "batch_id": batch,
        "applied": applied,
        "skipped": skipped,
        "ack": ack,
        "events": events,
        "pages": sorted(pages),
    }
