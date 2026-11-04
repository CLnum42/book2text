"""家具块类型清理（任务 41 / F2）。

背景：有几页的书眉 / 页码被 OCR 拼进了正文块，而且落在版心内，按版心判定排不掉，
导出正文里就出现 `红楼梦238`、`66` 这类脏字。

Extractor 核过：这类块一共 25 个，**整块都是家具/噪声，没有一条正文行**；
第 394 页 `{《红楼梦》第三卷终}` 是正文收尾行，不能动。

所以这里**只按块判**，绝不按行拆：

- 块内**每一行**都是家具行 → 整块改类型；
- 有一行像正文（哪怕另一行正好是「红楼梦」或「99」）→ 整块不动；
- 含「红楼梦」→ `header`；纯数字 → `page_number`。

家具行的定义（保守）：

1. 整行纯数字（≤ 4 位）→ 页码；
2. 含「红楼梦」，去掉它之后只剩空 / ASCII 字符 / 不超过一个汉字（OCR 噪声）→ 书眉；
3. 短的 OCR 噪声行：≤ 6 字符、没有句读标点、含 ASCII 字母数字（如 `860S8`、`x`）。

第 394 页那行去掉「红楼梦」还剩「{《》第三卷终}」（4 个汉字），不满足 2，
也不是 1 / 3，所以整块不会被判成家具。
"""

from __future__ import annotations

import json
from pathlib import Path

from ..storage import db as db_module
from . import blocks as blocks_module
from . import editing
from . import library as library_module
from . import margin_box as margin_box_module

SENTENCE_PUNCT = set("，。！？；：、（）《》「」『』【】")
MAX_NOISE_CHARS = 6
MAX_PAGE_NUMBER_DIGITS = 4


def analyze(project_id: str, *, library: Path | None = None) -> dict:
    """只读：找出"整块都是家具"的块，给出建议类型。"""
    target_library = library if library is not None else library_module.default_library_dir()
    project = library_module.load_project(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    directory = library_module.require_project_dir(project_id, library=target_library)
    lines = _block_lines(directory)

    entries: list[dict] = []
    for page in pages:
        for block in blocks_module.list_blocks(
            project_id, library=target_library, page_no=page.page_no
        ):
            if not block.include or block.block_type in ("header", "footer", "page_number"):
                continue
            if not margin_box_module.block_inside_margin(project, page, block.bbox):
                continue
            block_lines = [item for item in lines.get(block.block_id, []) if item["text"].strip()]
            if not block_lines:
                continue
            if not all(_is_furniture_line(item["text"]) for item in block_lines):
                continue
            has_head = any("红楼梦" in item["text"] for item in block_lines)
            if not has_head and not all(item["text"].strip().isdigit() for item in block_lines):
                continue  # 纯噪声块不猜类型，留给人工
            proposed = "header" if has_head else "page_number"
            entries.append(
                {
                    "page_no": page.page_no,
                    "block_id": block.block_id,
                    "current_type": block.block_type,
                    "proposed_type": proposed,
                    "chars": len(block.text or ""),
                    "lines": [item["text"] for item in block_lines],
                }
            )

    by_type: dict[str, int] = {}
    for entry in entries:
        by_type[entry["proposed_type"]] = by_type.get(entry["proposed_type"], 0) + 1
    return {
        "entries": entries,
        "stats": {
            "blocks": len(entries),
            "pages": len({entry["page_no"] for entry in entries}),
            "by_type": by_type,
            "chars": sum(entry["chars"] for entry in entries),
        },
    }


def apply(project_id: str, *, library: Path | None = None, actor_name: str | None = None) -> dict:
    """执行：整块改类型（一个 batch，可一次撤销）。"""
    target_library = library if library is not None else library_module.default_library_dir()
    plan = analyze(project_id, library=target_library)
    items = [(entry["block_id"], entry["proposed_type"]) for entry in plan["entries"]]
    events, by_type, pages = editing.apply_block_types(
        project_id,
        items,
        library=target_library,
        actor_name=actor_name,
    )
    return {
        "stats": plan["stats"],
        "changed": len(items),
        "by_type": by_type,
        "pages": list(pages),
        "events": events,
        "batch_id": events[0].batch_id if events else None,
    }


# ---------------------------------------------------------------- 内部


def _is_furniture_line(text: str) -> bool:
    value = (text or "").strip()
    if not value:
        return True
    # '②'.isdigit() 是 True 但 int('②') 抛 ValueError（2026-11-05，P0）
    if value.isdecimal() and len(value) <= MAX_PAGE_NUMBER_DIGITS:
        return True
    if "红楼梦" in value:
        rest = value.replace("红楼梦", "").strip()
        if not rest:
            return True
        cjk = sum(1 for char in rest if _is_cjk(char))
        if cjk == 0 and all(ord(char) < 128 or char in "/·、 " for char in rest):
            return True
        if cjk <= 1 and len(rest) <= 3:
            return True
        return False
    if len(value) <= MAX_NOISE_CHARS and not any(char in SENTENCE_PUNCT for char in value):
        has_ascii = any(char.isascii() and char.isalnum() for char in value)
        cjk = sum(1 for char in value if _is_cjk(char))
        if has_ascii or cjk <= 1:
            return True
    return False


def _is_cjk(char: str) -> bool:
    return "\u4e00" <= char <= "\u9fff"


def _block_lines(directory: Path) -> dict[str, list[dict]]:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT block_id, line_index, text FROM block_line ORDER BY block_id, line_index"
        ).fetchall()
    lines: dict[str, list[dict]] = {}
    for row in rows:
        lines.setdefault(row["block_id"], []).append({"text": row["text"] or ""})
    return lines
