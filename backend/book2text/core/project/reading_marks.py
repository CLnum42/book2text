"""阅读审校的逐行差异标记（`/review/marks` 的数据源）。

**为什么单独一个模块（任务 67）**

之前 `/review/marks` 每次请求都把 5036 个块重算一遍 `block_divergence`，
490 页双语书实测 **0.90 s / 1.52 MB**——开机首屏红字全卡在这上面。

这里做三件事：

1. **复用 `divergence_index()`**：块级分歧全项目只算一次（那边按 `project.db`
   的 mtime 缓存），marks 只做筛选，实测 11 ms；
2. **按页窗口切**：阅读流一次只需要当前页 ±N 页的标记，接口支持
   `page` / `radius`，窗口内实测 1 ms / ~77 KB；
3. **落盘缓存**：`<项目>/cache/reading-marks.json`，键是数据库 mtime 签名。
   新进程第一次请求不用再等索引冷启动（0.74 s）。

计数口径仍然是 `review_status.queue_items()`——左树 / 顶栏 / 收尾面板共用
那一份，这里不再另算一套（否则三个数字对不上）。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from ..ocr import compare as compare_module
from ..export import header_cleanup
from . import blocks as blocks_module
from ..storage import db as db_module
from . import cache_policy
from . import library as library_module
from . import punct_groups as punct_groups_module
from . import review_status

#: 阅读流默认窗口半径（页）：当前页 ±10，与页图内存缓存同一个尺度
DEFAULT_RADIUS = 10

#: marks payload 的结构版本；改了字段或语义就 +1
MARKS_CACHE_VERSION = 2

_CACHE: dict[str, tuple[str, dict]] = {}
"""项目 → (签名, 数据)。只留最近两个项目，避免内存无限涨。"""

_CACHE_AT: dict[str, float] = {}

_BUILD_LOCK = threading.Lock()
"""并发首次请求时只让一个线程读盘 / 重算（任务 67）。"""


def _signature(project_id: str, library: Path) -> str:
    parts: list[str] = []
    try:
        project = library_module.load_project(project_id, library=library)
        parts.append(project.updated_at)
    except library_module.ProjectError:
        return ""
    directory = library_module.project_dir(library, project_id)
    parts.append(db_module.content_signature(directory))
    parts.append(f"v{MARKS_CACHE_VERSION}")
    return "|".join(parts)


def _cache_path(project_id: str, library: Path) -> Path:
    return library_module.project_dir(library, project_id) / "cache" / "reading-marks.json"


def _read_disk(project_id: str, library: Path, signature: str) -> dict | None:
    if not signature:
        return None
    try:
        payload = json.loads(_cache_path(project_id, library).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("signature") != signature:
        return None
    data = payload.get("payload")
    return data if isinstance(data, dict) else None


def _write_disk(project_id: str, library: Path, signature: str, payload: dict) -> None:
    if not signature:
        return
    path = _cache_path(project_id, library)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(
            json.dumps({"signature": signature, "payload": payload}, ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(temp, path)
    except OSError:
        # 写不进去只是少一次缓存，不影响正确性
        pass


def _build_items(index: blocks_module.DivergenceIndex) -> list[dict[str, Any]]:
    """把索引里的块级分歧摊平成"一行一处差异"的列表（文档顺序）。"""
    page_no_by_block = {block.block_id: block.page_no for block in index.blocks}
    items: list[dict[str, Any]] = []
    for block in index.blocks:
        if not block.include:
            continue
        # 队列口径（任务 58 / 61）：只有正文块（paragraph / heading）进审校队列。
        # 这里不一起过滤的话，marks 会比队列多出几行（脚注等），进度条的分母就对不上。
        if block.block_type not in review_status.QUEUE_BLOCK_TYPES:
            continue
        page = index.pages.get(block.page_id)
        if page is None:
            continue
        if not index.inside(block):
            continue
        divergence = index.by_block.get(block.block_id)
        if divergence is None:
            continue
        lines = {line.line_index: line for line in index.lines_by_block.get(block.block_id, [])}
        for mark in divergence.marks:
            if mark.level not in (compare_module.DIFFERS_CHARS, compare_module.DIFFERS_PUNCT):
                continue
            line = lines.get(mark.line_index)
            # 任务 82：整行就是页码的差异不进队列（与 review_status.queue_items 同一判据，
            # 两边口径必须一致，否则左树计数和列表条数对不上）
            if line is not None and header_cleanup.is_page_number_noise(
                line.text or "", line.bbox, first_line=mark.line_index == 0
            ):
                continue
            items.append(
                {
                    "page_no": page_no_by_block.get(block.block_id, block.page_no),
                    "block_id": block.block_id,
                    "line_index": mark.line_index,
                    "level": mark.level,
                    "current": mark.current,
                    "candidate": mark.candidate,
                    "ack": mark.ack,
                    # 行框（归一化）：跟随模式下在左 PDF 上框出当前行
                    "bbox": list(line.bbox) if line is not None and line.bbox else None,
                    # 纯标点差异的"模式键"（`；→，`、`∅→‘`）：主队列据此把这几百行
                    # 交给「标点差异 · 按模式批量」面板，而不是让用户逐条点（任务 61）
                    "pattern_key": (
                        punct_groups_module.pattern_key(
                            punct_groups_module.fragments(
                                mark.current,
                                line.aux_text if line is not None else "",
                            )
                        )
                        if mark.level == compare_module.DIFFERS_PUNCT
                        and line is not None
                        and line.aux_text is not None
                        else None
                    ),
                }
            )
    return items


def marks_data(project_id: str, *, library: Path | None = None) -> dict[str, Any]:
    """全书标记 + 计数 + 每页计数（内部用，窗口切分由调用方做）。"""
    target_library = library if library is not None else library_module.default_library_dir()
    signature = _signature(project_id, target_library)
    cached = _CACHE.get(project_id)
    if cached and signature and cached[0] == signature:
        return cached[1]
    # 识别在跑时签名每 3–5 秒变一次：允许复用 3 秒内的结果（任务 68，见 cache_policy）
    if cached and cache_policy.can_reuse(
        project_id, target_library, _CACHE_AT.get(project_id)
    ):
        return cached[1]
    # 开项目时 marks / tree / finish 同时打进来：只让一个线程读盘 / 重算
    with _BUILD_LOCK:
        cached = _CACHE.get(project_id)
        if cached and signature and cached[0] == signature:
            return cached[1]
        return _build_marks_data(project_id, target_library, signature)


def _build_marks_data(project_id: str, target_library: Path, signature: str) -> dict[str, Any]:
    disk = _read_disk(project_id, target_library, signature)
    if disk is not None:
        if len(_CACHE) >= 2 and project_id not in _CACHE:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[project_id] = (signature, disk)
        _CACHE_AT[project_id] = time.monotonic()
        return disk
    index = blocks_module.divergence_index(project_id, library=target_library)
    items = _build_items(index)
    queue = review_status.queue_items(project_id, library=target_library, index=index)
    totals = queue["totals"]
    page_counts = {
        str(page_no): {
            "total": int(counts.get("total") or 0),
            "unacked": int(counts.get("unacked") or 0),
            "acked": int(counts.get("acked") or 0),
            # 分两类：主队列只放含汉字差异的行，"下一处未审"要按汉字找页
            "chars": 0,
            "chars_unacked": 0,
            "punct": 0,
            "punct_unacked": 0,
        }
        for page_no, counts in sorted(queue["per_page"].items())
    }
    for item in items:
        detail = page_counts.get(str(item["page_no"]))
        if detail is None:
            continue
        kind = "punct" if item["level"] == compare_module.DIFFERS_PUNCT else "chars"
        detail[kind] += 1
        if not item["ack"]:
            detail[f"{kind}_unacked"] += 1
    first_unacked = next(
        (int(page_no) for page_no, counts in page_counts.items() if counts["unacked"] > 0),
        None,
    )
    counts = {
        "total": len(items),
        "chars": 0,
        "punct": 0,
        "acked": 0,
        # 显示分两类、判定看合并：进度条只算汉字，标点走面板
        "chars_total": totals["chars_total"],
        "chars_unacked": totals["chars_unacked"],
        "punct_total": totals["punct_total"],
        "punct_unacked": totals["punct_unacked"],
    }
    for item in items:
        counts["punct" if item["level"] == compare_module.DIFFERS_PUNCT else "chars"] += 1
        if item["ack"]:
            counts["acked"] += 1
    data = {
        "items": items,
        "counts": counts,
        "page_counts": page_counts,
        "first_unacked_page": first_unacked,
        "page_total": len(index.pages),
    }
    if signature:
        if project_id not in _CACHE and len(_CACHE) >= 2:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[project_id] = (signature, data)
        _CACHE_AT[project_id] = time.monotonic()
        _write_disk(project_id, target_library, signature, data)
    return data


def window_bounds(page: int | None, radius: int, page_total: int) -> tuple[int, int] | None:
    """窗口页范围（含端点）；`page is None` = 不切窗口（全书）。"""
    if page is None:
        return None
    radius = max(0, int(radius))
    low = max(1, int(page) - radius)
    high = min(page_total or int(page) + radius, int(page) + radius)
    return low, high


def marks_window(
    project_id: str,
    *,
    library: Path | None = None,
    page: int | None = None,
    radius: int = DEFAULT_RADIUS,
    first: bool = False,
) -> dict[str, Any]:
    """按页窗口返回标记（阅读流用）。

    `page=None` 且 `first=False` 时不切窗口，返回全书（兼容旧调用 / 调试用）。
    `first=True` 表示"窗口套在第一处未审页上"——阅读流打开时还不知道该看哪页，
    让服务端一次算好，省掉"先拉第 1 页再多拉一次"的往返。

    响应里的 `counts` / `page_counts` 始终是**全书**的——进度条和"下一处"
    要靠它们，不能只给窗口内的数字。
    """
    data = marks_data(project_id, library=library)
    if page is None and first:
        page = data.get("first_unacked_page") or 1
    items = data["items"]
    window = None
    if page is not None:
        total_pages = int(data.get("page_total") or 0)
        bounds = window_bounds(page, radius, total_pages)
        if bounds is not None:
            window = {"page_from": bounds[0], "page_to": bounds[1]}
            items = [item for item in items if bounds[0] <= item["page_no"] <= bounds[1]]
    return {
        "items": items,
        "counts": data["counts"],
        "page_counts": data["page_counts"],
        "first_unacked_page": data.get("first_unacked_page"),
        "page_total": data.get("page_total"),
        "window": window,
    }
