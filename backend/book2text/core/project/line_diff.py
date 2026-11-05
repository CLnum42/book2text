"""字级差异（"处"）：一行 current × candidate 的逐字切分 + 字框映射。

**唯一实现。** 第十一轮之前前端各自算一份（`app.js` 的 `computeCharSpans` + `reading-view.js`
的 `readingDiffUnits`），两处口径一分叉就会出现"色块画在这个字上、计数算在那个字上"。
现在后端算、前端只按 `box_indices` 画框、按 `anchor_bbox` 取景。

三条约定（验收逐条核对）：

1. **不落库。** runs 完全由 `text` × `aux_text` 推导；采用一处、撤销、重跑复核都会变。
   落表就要失效判据——`FINISH_CACHE_VERSION` 那类坑不重来（见 `punct_groups.group_counts` 的教训）。
2. **算法与旧前端逐字一致**：等长走逐字快路径，否则 LCS DP；`a.len*b.len > MAX_CELLS`
   退化成整行一处并标 `degraded`（不静默）。
3. **相接才合并**：两段 run 在 a 侧和 b 侧都首尾相接（gap == 0）才算一处；跨 ≥1 个相同字
   一律分开——一处 = 一个判断，隔一个正确字的两处错误是两次判断。

**已知退化（写清楚，免得下一个人当成 bug 查）**：`word_boxes` 是识别时的字框，采用一处
**插入 / 删除**之后行文本长度变了、字框对不上，这一行剩下的处会退化成整行框
（`quality="line"`，界面仍能判，只是取景不再精确到字）。重跑识别或回填字框即恢复。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..storage.ulid import new_ulid
from . import blocks as blocks_module
from . import library as library_module

RUN_REPLACE = "replace"
RUN_INSERT = "insert"
RUN_DELETE = "delete"

#: LCS 的格子上限（与旧前端同一个值）：超过就整行一处，界面上标"整行"。
MAX_CELLS = 40_000

#: 取景时左右各带几个字（处特写的上下文）。
CONTEXT_CHARS = 4

QUALITY_CHAR = "char"
QUALITY_WORD = "word"
QUALITY_LINE = "line"


@dataclass(frozen=True)
class WordBox:
    text: str
    bbox: tuple[float, float, float, float]
    start: int


def spans(current: str, candidate: str) -> list[tuple[int, int, int, int, str]]:
    """逐字切分：[(a_start, a_end, b_start, b_end, kind), …]。

    - 等长（绝大多数行）：逐字比，连续不等的若干字 = 一段。这就是"快路径"。
    - 不等长：LCS DP。tie-break 固定为"dp 相等时优先 j += 1"⇒ 重复标点保留靠前的那一份
      （`，，` → `，` 删的是第二个，测试里钉住）。
    - 超长：整行一段 + kind=replace（由调用方标 degraded）。
    """
    if not current or not candidate or current == candidate:
        return []
    if len(current) == len(candidate):
        found: list[tuple[int, int, int, int, str]] = []
        index = 0
        length = len(current)
        while index < length:
            if current[index] == candidate[index]:
                index += 1
                continue
            start = index
            while index < length and current[index] != candidate[index]:
                index += 1
            found.append((start, index, start, index, RUN_REPLACE))
        return found

    n, m = len(current), len(candidate)
    if n * m > MAX_CELLS:
        return [(0, n, 0, m, RUN_REPLACE)]
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        row, below = dp[i], dp[i + 1]
        for j in range(m - 1, -1, -1):
            row[j] = below[j + 1] + 1 if current[i] == candidate[j] else max(below[j], row[j + 1])
    found = []
    i = j = 0
    while i < n or j < m:
        if i < n and j < m and current[i] == candidate[j]:
            i += 1
            j += 1
            continue
        a_start, b_start = i, j
        while i < n or j < m:
            if i < n and j < m and current[i] == candidate[j]:
                break
            if j < m and (i >= n or dp[i][j + 1] >= dp[i + 1][j]):
                j += 1
            else:
                i += 1
        if i > a_start or j > b_start:
            kind = (
                RUN_REPLACE
                if i > a_start and j > b_start
                else (RUN_DELETE if i > a_start else RUN_INSERT)
            )
            found.append((a_start, i, b_start, j, kind))
    return found


def merge_touching(
    found: list[tuple[int, int, int, int, str]],
) -> list[tuple[int, int, int, int, str]]:
    """把 a 侧与 b 侧都首尾相接的两段并成一处（实测真实书里 0 对，见模块说明）。"""
    merged: list[list] = []
    for item in found:
        if merged and merged[-1][1] == item[0] and merged[-1][3] == item[2]:
            merged[-1][1] = item[1]
            merged[-1][3] = item[3]
            merged[-1][4] = RUN_REPLACE
        else:
            merged.append([item[0], item[1], item[2], item[3], item[4]])
    return [(a, b, c, d, kind) for a, b, c, d, kind in merged]


def _word_boxes(raw: str | None, line_text: str) -> list[WordBox] | None:
    """解析 `block_line.word_boxes` 并算出每个框在行文本里的起点。

    两条映射分支（与旧前端逐字一致）：

    - 拼接长度 == 行文本长度 ⇒ 按偏移（中文逐字框），不可能 miss；
    - 否则按位置找词（英文词间空格不属于任何框）；**找不到就返回 None**，调用方退化成整行框。
    """
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, list) or not parsed:
        return None
    items: list[tuple[str, tuple[float, float, float, float]]] = []
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        text = str(entry.get("text") or "")
        box = entry.get("bbox")
        if not (isinstance(box, list) and len(box) == 4):
            continue
        try:
            items.append((text, (float(box[0]), float(box[1]), float(box[2]), float(box[3]))))
        except (TypeError, ValueError):
            return None
    if not items:
        return None

    starts: list[int] = []
    if sum(len(text) for text, _ in items) == len(line_text):
        offset = 0
        for text, _ in items:
            starts.append(offset)
            offset += len(text)
    else:
        cursor = 0
        for text, _ in items:
            if not text:
                starts.append(cursor)
                continue
            at = line_text.find(text, cursor)
            if at < 0:
                return None
            starts.append(at)
            cursor = at + len(text)
    return [WordBox(text=text, bbox=box, start=start) for (text, box), start in zip(items, starts)]


def _union(boxes: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float] | None:
    if not boxes:
        return None
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def _pad(box: tuple[float, float, float, float], ratio: float = 0.5) -> tuple[float, float, float, float]:
    width = box[2] - box[0]
    height = box[3] - box[1]
    return (box[0] - width * ratio, box[1] - height * ratio, box[2] + width * ratio, box[3] + height * ratio)


def _run_geometry(
    a_start: int,
    a_end: int,
    boxes: list[WordBox],
) -> tuple[tuple[float, float, float, float] | None, tuple[float, float, float, float] | None, list[int]]:
    """一处 run 的 (bbox, anchor_bbox, box_indices)。

    - replace / delete：覆盖 `a_start..a_end` 的框并集；
    - insert（a_start == a_end）：零宽点 = 左邻右沿与右邻左沿的中点；anchor = 左右邻的并集；
      行首 / 行尾只有一侧邻字时，用那一侧的框、向外扩半个框宽。
    """
    covered = [
        index
        for index, box in enumerate(boxes)
        if box.start + len(box.text) > a_start and box.start < a_end
    ]
    if a_start != a_end:
        chosen = [boxes[index].bbox for index in covered]
        return _union(chosen), _union([_pad(box) for box in chosen]) if chosen else None, covered

    left = next(
        (index for index in range(len(boxes)) if boxes[index].start + len(boxes[index].text) == a_start),
        None,
    )
    right = next((index for index in range(len(boxes)) if boxes[index].start == a_start and boxes[index].text), None)
    neighbours = [index for index in (left, right) if index is not None]
    if not neighbours:
        return None, None, []
    boxes_of = [boxes[index].bbox for index in neighbours]
    if left is not None and right is not None:
        left_box, right_box = boxes[left].bbox, boxes[right].bbox
        x = (left_box[2] + right_box[0]) / 2
        y0 = min(left_box[1], right_box[1])
        y1 = max(left_box[3], right_box[3])
    elif left is not None:
        left_box = boxes[left].bbox
        x = left_box[2]
        y0, y1 = left_box[1], left_box[3]
    else:
        right_box = boxes[right].bbox  # type: ignore[index]
        x = right_box[0]
        y0, y1 = right_box[1], right_box[3]
    return (x, y0, x, y1), _union([_pad(box) for box in boxes_of]), neighbours


def runs_for_text(
    current: str,
    candidate: str,
    *,
    word_boxes: str | None = None,
    line_bbox: tuple[float, float, float, float] | None = None,
) -> dict:
    """纯函数：给两条文本（+ 字框 JSON）返回 runs 载荷。界面与测试都走这里。"""
    found = merge_touching(spans(current, candidate))
    boxes = _word_boxes(word_boxes, current)
    degraded = bool(current) and bool(candidate) and len(current) * len(candidate) > MAX_CELLS
    quality = QUALITY_CHAR if boxes is not None and sum(1 for b in boxes if len(b.text) > 1) == 0 else QUALITY_WORD
    if boxes is None:
        quality = QUALITY_LINE

    runs = []
    for index, (a_start, a_end, b_start, b_end, kind) in enumerate(found):
        bbox = anchor = None
        covered: list[int] = []
        if boxes is not None:
            bbox, anchor, covered = _run_geometry(a_start, a_end, boxes)
        if bbox is None:
            bbox = line_bbox
            anchor = line_bbox
            quality = QUALITY_LINE
        runs.append(
            {
                "index": index,
                "kind": kind,
                "a_start": a_start,
                "a_end": a_end,
                "b_start": b_start,
                "b_end": b_end,
                "from": current[a_start:a_end],
                "to": candidate[b_start:b_end],
                "bbox": list(bbox) if bbox else None,
                "anchor_bbox": list(anchor) if anchor else None,
                "box_indices": covered,
            }
        )
    return {
        "line_text": current,
        "candidate_text": candidate,
        "degraded": degraded,
        "quality": quality,
        "runs": runs,
    }


def runs_for_line(
    project_id: str,
    block_id: str,
    line_index: int,
    *,
    library: Path | None = None,
) -> dict:
    """读库版本：某一行的 runs（不落库、每次现算）。"""
    target = library if library is not None else library_module.default_library_dir()
    block = blocks_module.get_block(project_id, block_id, library=target)
    lines = (block.text or "").split("\n")
    if line_index < 0 or line_index >= len(lines):
        raise library_module.ProjectError(f"块 {block_id} 没有第 {line_index + 1} 行")
    record = None
    for item in blocks_module.list_block_lines(project_id, library=target, block_id=block_id):
        if item.line_index == line_index:
            record = item
            break
    if record is None:
        raise library_module.ProjectError(f"块 {block_id} 没有第 {line_index + 1} 行")
    payload = runs_for_text(
        lines[line_index],
        record.aux_text or "",
        word_boxes=record.word_boxes,
        line_bbox=record.bbox,
    )
    payload.update(
        {
            "block_id": block_id,
            "line_index": line_index,
            "line_id": record.line_id,
            "ack": record.diff_ack,
            "no_candidate": record.aux_text is None,
        }
    )
    return payload


def _line_record(project_id: str, block_id: str, line_index: int, target: Path):
    for item in blocks_module.list_block_lines(project_id, library=target, block_id=block_id):
        if item.line_index == line_index:
            return item
    return None


def decide_run(
    project_id: str,
    block_id: str,
    line_index: int,
    *,
    action: str,
    a_start: int,
    a_end: int,
    b_start: int,
    b_end: int,
    expected_line_text: str | None = None,
    judged: tuple[int, ...] = (),
    library: Path | None = None,
    actor_name: str | None = None,
) -> dict:
    """逐处裁决：`adopt` 改正文（只改那一段），`keep` 只记在本会话里。

    **行级 ack 只在"这一行没有未判的处"时写**（第十一轮的口径）：

    - 采用后文本 == 候选 ⇒ `adopted`（全采用）；
    - 否则 ⇒ `kept`（判完了、但仍与候选不同——混合行的唯一落法，见 devlog）。

    `judged` 是调用方报上来的"本次会话里已判过的处"（`a_start` 列表）。`keep` 不落库，
    所以它只能由前端记着；这正是"处级保留不落库"的代价，写在这里免得下一个人误以为漏了。
    """
    if action not in ("adopt", "keep"):
        raise library_module.ProjectError(f"未知的逐处裁决：{action!r}")
    target = library if library is not None else library_module.default_library_dir()
    block = blocks_module.get_block(project_id, block_id, library=target)
    lines = (block.text or "").split("\n")
    if line_index < 0 or line_index >= len(lines):
        raise library_module.ProjectError(f"块 {block_id} 没有第 {line_index + 1} 行")
    current = lines[line_index]
    if expected_line_text is not None and current != expected_line_text:
        raise library_module.ProjectError("这一行在别处被改过，请刷新后再判")
    record = _line_record(project_id, block_id, line_index, target)
    if record is None:
        raise library_module.ProjectError(f"块 {block_id} 没有第 {line_index + 1} 行")
    candidate = record.aux_text or ""

    before = runs_for_text(
        current, candidate, word_boxes=record.word_boxes, line_bbox=record.bbox
    )
    target_run = next(
        (run for run in before["runs"] if run["a_start"] == a_start and run["a_end"] == a_end),
        None,
    )
    if target_run is None:
        raise library_module.ProjectError("这一处已经不在了（文本被改过，或已被采用）")

    batch = new_ulid()
    events: list = []
    new_line = current
    new_block_text = block.text or ""
    ack = None
    if action == "adopt":
        from . import editing

        new_line = current[:a_start] + candidate[b_start:b_end] + current[a_end:]
        new_block_text = "\n".join([*lines[:line_index], new_line, *lines[line_index + 1 :]])
        events.extend(
            editing.update_block(
                project_id, block_id, text=new_block_text, library=target,
                actor_name=actor_name, batch_id=batch,
            )[1]
        )
        events.extend(
            editing.sync_line_text(
                project_id, block_id, line_index, new_line, library=target,
                actor_name=actor_name, batch_id=batch,
            )
        )
        remaining = runs_for_text(
            new_line, candidate, word_boxes=record.word_boxes, line_bbox=record.bbox
        )["runs"]
        if not remaining:
            ack = "adopted" if new_line == candidate else "kept"
    else:
        seen = set(judged) | {a_start}
        remaining = [run for run in before["runs"] if run["a_start"] not in seen]
        if not remaining:
            ack = "kept"

    if ack is not None:
        from . import editing

        events.extend(
            editing.ack_diff_line(
                project_id, block_id, line_index, ack,
                text=new_block_text if ack == "adopted" else None,
                library=target, actor_name=actor_name, batch_id=batch,
            )[2]
        )
    return {
        "action": action,
        "line_text": new_line,
        "ack": ack,
        "runs": remaining,
        "remaining": len(remaining),
        "batch_id": batch,
        "page_no": block.page_no,
        "events": events,
    }


def runs_for_page(
    project_id: str,
    page_no: int,
    *,
    library: Path | None = None,
) -> dict:
    """一页所有差异行的 runs（页面级红字与色块用这一份，别逐行发请求）。

    只返回**实质差异**行（汉字级 / 标点级），与审校队列同一判据（`compare.grade_line`）。
    行文本取 `block_line.text`（与块文本同步过），不额外读块。
    """
    from ..ocr import compare as compare_module

    target = library if library is not None else library_module.default_library_dir()
    items = []
    for record in blocks_module.list_block_lines(project_id, library=target, page_no=page_no):
        if record.aux_text is None:
            continue
        grade = compare_module.grade_line(record.text or "", record.aux_text)
        if grade not in (compare_module.DIFFERS_CHARS, compare_module.DIFFERS_PUNCT):
            continue
        payload = runs_for_text(
            record.text or "",
            record.aux_text,
            word_boxes=record.word_boxes,
            line_bbox=record.bbox,
        )
        items.append(
            {
                "block_id": record.block_id,
                "line_index": record.line_index,
                "line_id": record.line_id,
                "ack": record.diff_ack,
                "level": grade,
                **{key: payload[key] for key in ("runs", "quality", "degraded", "has_insert_delete", "order_note")},
            }
        )
    return {"page_no": page_no, "items": items}
