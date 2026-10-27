"""跨页延续自动判定（任务 41 / F1）。

背景：OCR 按页落块，段落被页切开时导出会变成两段。审校里可以逐块标「延续」，
但全书 393 个页边界，人工标不现实。金标准 40 页量出来的结论是：

- 页末行**走满版心**（gap ≤ 1.4 行距）且末字不是句末标点 → 真延续（R1 & R3）；
- 页末行**明显短**（gap 大）→ 真段落结束（R3）；
- 其余（走满行但末字是句末标点）→ 进审校队列，人工看。

R2（下页首行缩进）**不参与自动判定**——诗行会骗它；它只作为队列里的提示文字。

两条纪律：

1. **人工标过的不覆盖**：事件表里有非 system 的 ``set_continues`` 事件，就跳过。
2. **只写 `continues_to_next`**，不改文字、类型、框；整批一个 batch，可一次撤销。
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

from ..storage import db as db_module
from . import blocks as blocks_module
from . import editing
from . import library as library_module
from . import margin_box as margin_box_module

# 句末标点：末字落在这些里就认为"这一句说完了"，不能自动标延续。
SENTENCE_END = set("。？！…」』）】》\"'.")
# 页末行右端离版心右边界多远算"走满"（单位：行距，不是字形高度）。
FULL_LINE_GAP = 1.4
# 不参与"页末行"的块类型（书眉 / 页码 / 插图 / 装饰）。
NON_BODY_TYPES = ("header", "footer", "page_number", "figure", "decoration")


def analyze(project_id: str, *, library: Path | None = None) -> dict:
    """只读分析每个页边界，分三个桶（continue / end / review）。"""
    target_library = library if library is not None else library_module.default_library_dir()
    project = library_module.load_project(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    directory = library_module.require_project_dir(project_id, library=target_library)

    blocks_by_page: dict[int, list] = {page.page_no: [] for page in pages}
    page_by_no = {page.page_no: page for page in pages}
    # 一次读全书（逐页 list_blocks 会为 394 页各开一次连接）：顺序与按页读一致
    for block in blocks_module.list_blocks(project_id, library=target_library):
        page = page_by_no.get(block.page_no)
        if page is None or not block.include:
            continue
        if block.block_type in NON_BODY_TYPES:
            continue
        if not margin_box_module.block_inside_margin(project, page, block.bbox):
            continue
        blocks_by_page[block.page_no].append(block)

    lines = _block_lines(directory)
    manual = _manual_blocks(directory)

    entries: list[dict] = []
    for page in pages:
        next_no = page.page_no + 1
        current = blocks_by_page.get(page.page_no) or []
        following = blocks_by_page.get(next_no) or []
        if not current or not following:
            continue
        last_block = current[-1]
        block_lines = lines.get(last_block.block_id) or []
        if not block_lines:
            continue
        last_line = block_lines[-1]
        # 人看过这一处：不管是哪个方向，都不再算"待确认"，也不被自动判定覆盖。
        # 两条来源——新的 continues_reviewed 列（面板裁决）与老的 set_continues 事件
        # （审校里直接拨开关），老项目升级后两种都要认。
        reviewed = bool(last_block.continues_reviewed) or last_block.block_id in manual
        box = margin_box_module.export_margin_box(project, page)
        if box is None:
            entries.append(
                _entry(
                    page.page_no,
                    last_block.block_id,
                    "",
                    "",
                    None,
                    "manual" if reviewed else "review",
                    "这一处已经人工确认过" if reviewed else "版心未定，无法判断页末行是否走满",
                    following,
                    lines,
                    reviewed=reviewed,
                    continues_to_next=last_block.continues_to_next,
                )
            )
            continue
        pitch = _line_pitch(current, lines, last_line)
        right = box[2]
        gap = (right - last_line["bbox"][2]) / pitch if pitch > 0 else 0.0
        text = (last_line["text"] or "").strip()
        last_char = text[-1] if text else ""
        if reviewed:
            bucket, reason = "manual", "这一处已经人工确认过，不覆盖"
        elif gap > FULL_LINE_GAP:
            bucket, reason = "end", "页末行明显短，判断为段落结束"
        elif last_char and last_char not in SENTENCE_END:
            bucket, reason = "continue", "页末行走满版心，且末字不是句末标点"
        else:
            bucket, reason = "review", "页末行走满版心，但末字是句末标点，需要人看"
        entries.append(
            _entry(
                page.page_no,
                last_block.block_id,
                last_char,
                text,
                gap,
                bucket,
                reason,
                following,
                lines,
                reviewed=reviewed,
                continues_to_next=last_block.continues_to_next,
            )
        )

    stats = {
        "boundaries": len(entries),
        "continue": sum(1 for item in entries if item["bucket"] == "continue"),
        "end": sum(1 for item in entries if item["bucket"] == "end"),
        "review": sum(1 for item in entries if item["bucket"] == "review"),
        "manual": sum(1 for item in entries if item["bucket"] == "manual"),
    }
    return {
        "entries": entries,
        "stats": stats,
        "rules": {
            "full_line_gap": FULL_LINE_GAP,
            "sentence_end": "".join(sorted(SENTENCE_END)),
            "gap_unit": "行距（同一页正文行顶边的中位差）",
        },
    }


def apply(project_id: str, *, library: Path | None = None, actor_name: str | None = None) -> dict:
    """执行自动判定：continue → 1，end → 0；review / manual 不动。整批可撤销。"""
    target_library = library if library is not None else library_module.default_library_dir()
    plan = analyze(project_id, library=target_library)
    items: list[tuple[str, bool]] = []
    for entry in plan["entries"]:
        if entry["bucket"] == "continue":
            items.append((entry["block_id"], True))
        elif entry["bucket"] == "end":
            items.append((entry["block_id"], False))
    events, changed, pages = editing.apply_continuations(
        project_id,
        items,
        library=target_library,
        actor_name=actor_name,
    )
    return {
        "stats": plan["stats"],
        "rules": plan["rules"],
        "changed": changed,
        "pages": list(pages),
        "events": events,
        "batch_id": events[0].batch_id if events else None,
    }


def pending(project_id: str, *, library: Path | None = None) -> dict:
    """只读：F1 第三桶（review）的逐条明细，给「跨页延续待确认」面板用。

    每条都带上判断依据（页末行原文、走满程度、下页首行缩进与首行原文），
    人在面板上直接点「标延续 / 标结束」，不用再回头翻两页猜。
    """
    plan = analyze(project_id, library=library)
    entries = [entry for entry in plan["entries"] if entry["bucket"] == "review"]
    return {
        "count": len(entries),
        "total": plan["stats"]["boundaries"],
        "entries": entries,
        "stats": plan["stats"],
        "rules": plan["rules"],
    }


def resolve(
    project_id: str,
    block_id: str,
    continues: bool,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> dict:
    """人工裁决一处待确认的页边界：标延续 / 标结束，整条一个 batch，可撤销。"""
    target_library = library if library is not None else library_module.default_library_dir()
    plan = analyze(project_id, library=target_library)
    entry = next((item for item in plan["entries"] if item["block_id"] == block_id), None)
    if entry is None:
        raise library_module.ProjectError(
            "找不到这一块对应的页边界（它可能不是本页最后一块正文）"
        )
    if entry["bucket"] != "review":
        raise library_module.ProjectError("这一处已经确认过，或自动判定已经能定（不在待人工里）")
    block, events = editing.review_continuation(
        project_id,
        block_id,
        continues,
        library=target_library,
        actor_name=actor_name,
    )
    return {
        "block_id": block.block_id,
        "page_no": block.page_no,
        "next_page_no": block.page_no + 1,
        "continues_to_next": block.continues_to_next,
        "reviewed": block.continues_reviewed,
        # 每个页边界互相独立：确认一条就少一条，不用重扫全书
        "remaining": max(0, int(plan["stats"]["review"]) - 1),
        "pages": [block.page_no],
        "events": events,
    }


def reopen(
    project_id: str,
    block_id: str,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> dict:
    """把一处已确认的边界放回待确认（改判 / 点错了）。不动 `continues_to_next`。"""
    target_library = library if library is not None else library_module.default_library_dir()
    plan = analyze(project_id, library=target_library)
    entry = next((item for item in plan["entries"] if item["block_id"] == block_id), None)
    if entry is None:
        raise library_module.ProjectError(
            "找不到这一块对应的页边界（它可能不是本页最后一块正文）"
        )
    if entry["bucket"] != "manual":
        raise library_module.ProjectError("这一处还没被人工确认过")
    block, events = editing.reopen_continuation(
        project_id, block_id, library=target_library, actor_name=actor_name
    )
    # 放回之后这一处会不会真的回到待确认，取决于几何规则（可能自动就能判了）
    after = analyze(project_id, library=target_library)
    back = next((item for item in after["entries"] if item["block_id"] == block_id), None)
    return {
        "block_id": block.block_id,
        "page_no": block.page_no,
        "next_page_no": block.page_no + 1,
        "continues_to_next": block.continues_to_next,
        "reviewed": block.continues_reviewed,
        "bucket": back["bucket"] if back is not None else None,
        "remaining": int(after["stats"]["review"]),
        "pages": [block.page_no],
        "events": events,
    }


# ---------------------------------------------------------------- 内部


def _entry(
    page_no: int,
    block_id: str,
    last_char: str,
    last_text: str,
    gap: float | None,
    bucket: str,
    reason: str,
    following: list,
    lines: dict,
    *,
    reviewed: bool = False,
    continues_to_next: bool = False,
) -> dict:
    first_block = following[0]
    first_lines = lines.get(first_block.block_id) or []
    indent = None
    next_text = ""
    if first_lines:
        first = first_lines[0]["bbox"]
        lefts = [item["bbox"][0] for item in first_lines]
        if lefts:
            indent = round(first[0] - min(lefts), 4)
        next_text = (first_lines[0]["text"] or "").strip()[:200]
    return {
        "page_no": page_no,
        "next_page_no": page_no + 1,
        "block_id": block_id,
        "gap": None if gap is None else round(float(gap), 2),
        "last_char": last_char,
        "last_text": last_text[:200],
        "next_text": next_text,
        "next_indent": indent,
        "bucket": bucket,
        "reason": reason,
        "reviewed": bool(reviewed),
        "continues_to_next": bool(continues_to_next),
    }


def _block_lines(directory: Path) -> dict[str, list[dict]]:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT block_id, line_index, bbox, text FROM block_line"
            " ORDER BY block_id, line_index"
        ).fetchall()
    lines: dict[str, list[dict]] = {}
    for row in rows:
        try:
            bbox = json.loads(row["bbox"]) if row["bbox"] else None
        except (TypeError, ValueError):
            bbox = None
        if not bbox or len(bbox) < 4:
            continue
        lines.setdefault(row["block_id"], []).append(
            {"bbox": bbox, "text": row["text"] or ""}
        )
    return lines


def _line_pitch(blocks: list, lines: dict[str, list[dict]], last_line: dict) -> float:
    tops: list[float] = []
    heights: list[float] = []
    for block in blocks:
        for line in lines.get(block.block_id, []):
            bbox = line["bbox"]
            tops.append(float(bbox[1]))
            heights.append(float(bbox[3]) - float(bbox[1]))
    tops.sort()
    gaps = [round(b - a, 6) for a, b in zip(tops, tops[1:]) if b - a > 1e-6]
    if gaps:
        return statistics.median(gaps)
    if heights:
        return statistics.median(heights)
    bbox = last_line["bbox"]
    return float(bbox[3]) - float(bbox[1])


def _manual_blocks(directory: Path) -> set[str]:
    """人工标过延续 / 结束的块：有非 system 的 set_continues 事件。"""
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT DISTINCT entity_id FROM event"
            " WHERE entity_type = 'block' AND action = ? AND actor <> ?",
            (editing.ACTION_SET_CONTINUES, editing.ACTOR_SYSTEM),
        ).fetchall()
    return {row["entity_id"] for row in rows}
