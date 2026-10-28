"""审校接口（说明书第 11 节的「块」与「历史」两组，6.4 的审校功能）。

- `PATCH /projects/{id}/blocks/{bid}`：改块（文本 / 状态 / 类型 / 纳入 / 延续 / 备注）。
- `POST /projects/{id}/pages/{pid}/confirm`：确认整页（规则 R3）。
- `POST /projects/{id}/undo` / `/redo`：按 batch 撤销 / 重做。

**撤销栈只存在内存里**（说明书 5.3："撤销栈仅限本次会话，应用重启后不可撤销历史操作"）。
栈以项目为键，挂在 `app.state.review_history` 上——因此重启应用后栈就空了，
但**已保存的成果不受影响**，事件表里的历史也一条不少。
"""

from __future__ import annotations

import json
import threading
from collections import deque
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import APIRouter, Body, Request
from pydantic import BaseModel, Field

from ..core.project import auto_apply as auto_apply_module
from ..core.project import blocks as blocks_module
from ..core.project import ink_gaps as ink_gaps_module
from ..core.project import editing
from ..core.project import garbled_lines as garbled_module
from ..core.project import library as project_library
from ..core.project import margin_box as margin_box_module
from ..core.project import punct_groups as punct_groups_module
from ..core.project import reading_marks as reading_marks_module
from ..core.project import review_status as review_status_module
from ..core.project import recognition
from ..core.project import structure as structure_module
from ..core.ocr import compare as compare_module
from ..core.project import workflow as workflow_module
from ..core.storage import db as db_module
from ..core.storage.ulid import new_ulid
from .deps import actor_name as _actor_name
from .deps import require_editable_page
from .deps import require_main_project as _require_main
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["review"])

MAX_HISTORY_BATCHES = 100


@dataclass
class _Batch:
    """一次可撤销的操作：一批事件 + 涉及的页码。"""

    events: tuple[editing.Event, ...]
    page_nos: tuple[int, ...]


class ReviewHistory:
    """本次会话的撤销 / 重做栈（每个项目一份）。

    只放在内存：说明书 5.3 明确"撤销栈仅限本次会话"。数据本身在数据库里，
    栈没了不影响任何已保存的成果。
    """

    def __init__(self) -> None:
        self._undo: dict[str, deque[_Batch]] = {}
        self._redo: dict[str, deque[_Batch]] = {}
        self._lock = threading.Lock()

    def push(self, project_id: str, batch: _Batch) -> None:
        with self._lock:
            self._undo.setdefault(project_id, deque(maxlen=MAX_HISTORY_BATCHES)).append(batch)
            # 新的操作进来，原来的"重做"就失效了（标准撤销模型）
            self._redo.pop(project_id, None)

    def pop_undo(self, project_id: str) -> _Batch | None:
        with self._lock:
            stack = self._undo.get(project_id)
            return stack.pop() if stack else None

    def push_redo(self, project_id: str, batch: _Batch) -> None:
        with self._lock:
            self._redo.setdefault(project_id, deque(maxlen=MAX_HISTORY_BATCHES)).append(batch)

    def pop_redo(self, project_id: str) -> _Batch | None:
        with self._lock:
            stack = self._redo.get(project_id)
            return stack.pop() if stack else None

    def push_undo(self, project_id: str, batch: _Batch) -> None:
        """重做之后把这一批放回撤销栈（不进 redo 栈）。"""
        with self._lock:
            self._undo.setdefault(project_id, deque(maxlen=MAX_HISTORY_BATCHES)).append(batch)

    def depth(self, project_id: str) -> tuple[int, int]:
        with self._lock:
            return (
                len(self._undo.get(project_id, ())),
                len(self._redo.get(project_id, ())),
            )

    def clear(self, project_id: str) -> None:
        with self._lock:
            self._undo.pop(project_id, None)
            self._redo.pop(project_id, None)


def _history(request: Request) -> ReviewHistory:
    history = getattr(request.app.state, "review_history", None)
    if history is None:  # pragma: no cover - 装配错误
        raise AppError(500, "server_not_ready", "服务未正确初始化（缺少撤销栈）")
    return history


def _block_payload(
    block: blocks_module.BlockRecord,
    lines,
    *,
    divergence: blocks_module.BlockDivergence | None = None,
    margin_inside: bool = True,
) -> dict[str, Any]:
    divergence = divergence or blocks_module.block_divergence(block, lines)
    return {
        **block.to_dict(),
        "lines": [line.to_dict() for line in lines],
        # 第二引擎的分歧（说明书 8.5）：界面据此在块里逐行标出另一路候选，
        # 并显示"这一块有 N 行两路不一致"。标记按**块里现在的文本**现算（见 blocks.py）。
        "divergence": divergence.to_dict(),
        "diff_line_count": divergence.lines,
        # 任务 34：块中心是否在版心内。与导出第一层同一函数（margin_box.block_inside_margin），
        # 审校队列 / 页头计数 / 待处理都按它过滤；版心外的块仍返回，供展开查看与编辑。
        "margin_inside": bool(margin_inside),
    }


def _require_page_editable(request: Request, project_id: str, block_id: str, *, library) -> None:
    """只读上下文页（说明书 6.7.2）不能改：块在那种页上就拒绝。

    `deps.require_editable_page` 是按**页码**判的，块编辑路径手里只有块 id，这里先查它在哪一页。
    审校包里上下文页的存在本身就是"给你看跨页段落用的"，改它会让结果包与主项目对不上。

    **一次 JOIN 拿到页码**，不逐页翻块：以前是"每页 list_blocks 直到找到这块"，
    第 370 页的块要跑 370 次查询，一次按键多等约 290 ms（任务 43 实测）。
    """
    directory = project_library.require_project_dir(project_id, library=library)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT p.page_no, p.is_context FROM block b"
            " JOIN page p ON p.page_id = b.page_id"
            " WHERE b.block_id = ? AND b.deleted_at IS NULL",
            (block_id,),
        ).fetchone()
    if row is None:
        # 查不到就交给编辑层报"找不到块"（保持原来的 404 语义）
        return
    if int(row["is_context"] or 0):
        raise AppError(
            403,
            "context_page_readonly",
            "这是只读上下文页",
            detail="任务包只附带分派范围前后各 1 页，用来判断跨页段落，不能编辑。",
        )


def _page_blocks_payload(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    library = _library(request)
    page, runs, blocks, lines = blocks_module.load_page_content(
        project_id, page_no, library=library
    )
    states = blocks_module.page_recognition_states(project_id, library=library)
    by_block: dict[str, list[blocks_module.BlockLineRecord]] = {}
    # 只统计当前有效块的行：软删除块的行还在库里（撤销要能找回来），但不属于这一页的版面
    active_blocks = {block.block_id for block in blocks}
    lines = [line for line in lines if line.block_id in active_blocks]
    for line in lines:
        by_block.setdefault(line.block_id, []).append(line)

    state = states.get(page.page_id)
    active_run_id = state.active_run_id if state else None
    active = next((run for run in runs if run.run_id == active_run_id), None)
    undo, redo = _history(request).depth(project_id)

    # 任务 34：审校只默认统计版心内。判定与导出第一层同一个函数
    # （`margin_box.block_inside_margin` → `export_margin_box` + `center_inside`）。
    project = project_library.load_project(project_id, library=library)
    divergences = {
        block.block_id: blocks_module.block_divergence(
            block, by_block.get(block.block_id, [])
        )
        for block in blocks
    }
    inside_ids = {
        block.block_id
        for block in blocks
        if margin_box_module.block_inside_margin(project, page, block.bbox)
    }
    outside_blocks = [block for block in blocks if block.block_id not in inside_ids]
    outside_counts = {"chars": 0, "punct": 0, "empty": 0, "format_only": 0, "acked": 0}
    for block in outside_blocks:
        divergence = divergences[block.block_id]
        for key in outside_counts:
            outside_counts[key] += int(getattr(divergence, key, 0) or 0)
    margin_box_used = margin_box_module.export_margin_box(project, page)
    margin_payload = {
        "box": list(margin_box_used) if margin_box_used else None,
        "applied": margin_box_module.margin_applies(project, page),
        "mode": page.margin_box_mode,
        "source": margin_box_module.page_margin_source_label(project, page),
        "undetermined": (
            page.margin_box_mode in ("auto", "inherit")
            and margin_box_used is None
        ),
        "none": page.margin_box_mode == "none",
        "outside_blocks": len(outside_blocks),
        "outside_lines": {
            **outside_counts,
            "lines": outside_counts["chars"] + outside_counts["punct"],
        },
    }

    return {
        "page": {**page.to_dict(), "recognition": (state or blocks_module.empty_recognition(page.page_id)).to_dict()},
        "runs": [run.to_dict() for run in runs],
        "active_run": active.to_dict() if active else None,
        "block_count": len(blocks),
        "blocks": [
            _block_payload(
                block,
                by_block.get(block.block_id, []),
                divergence=divergences[block.block_id],
                margin_inside=block.block_id in inside_ids,
            )
            for block in blocks
        ],
        "review": _review_summary(blocks),
        # 行归属统计（改框之后看得见）：冲突 / 未归属的行一条都不会丢
        "layout_lines": _line_layout_summary(lines),
        # 任务 34：分歧概况只算版心内；版心外的计数单独给，页头写"未计入"
        "divergence": blocks_module.page_divergence_summary(
            blocks, lines, runs, inside_block_ids=inside_ids
        ).to_dict(),
        "margin": margin_payload,
        "history": {"undo": undo, "redo": redo},
        # 任务 61：确认方式（人工 / 自动 / 未确认）给审校按钮与状态展示用
        "workflow": workflow_module.page_workflow(
            project_library.require_project_dir(project_id, library=library), page.page_id
        ),
    }


def _review_summary(blocks) -> dict[str, int]:
    """审校进度（说明书 7.3：一页上"未审 / 不确定"各多少）。"""
    included = [block for block in blocks if block.include]
    return {
        "block_count": len(blocks),
        "included": len(included),
        "unreviewed": sum(1 for b in included if b.review_status == "unreviewed"),
        "confirmed": sum(1 for b in included if b.review_status == "confirmed"),
        "uncertain": sum(1 for b in included if b.review_status == "uncertain"),
        "modified": sum(1 for b in included if b.modified),
        "excluded": len(blocks) - len(included),
        # 版面确认：块级状态；页面自身的确认步骤在下一包，这里只做汇总
        "layout_confirmed": sum(1 for b in included if b.layout_confirmed),
    }


def _line_layout_summary(lines) -> dict[str, int]:
    """这一页的行归属统计（说明书 5.3 的扩展）：assigned / conflict / unassigned。"""
    counts = {"assigned": 0, "conflict": 0, "unassigned": 0}
    for line in lines:
        counts[line.layout_status] = counts.get(line.layout_status, 0) + 1
    return counts


# ---------------------------------------------------------------- 改块

class BlockPatch(BaseModel):
    text: str | None = Field(default=None, max_length=20000)
    review_status: str | None = None
    block_type: str | None = None
    include: bool | None = None
    continues_to_next: bool | None = None
    comment: str | None = Field(default=None, max_length=500)
    # 手动拖拽 / 缩放后的块框（归一化坐标，说明书 5.2）；改它会让服务端重算行归属
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    # 版面（框 / 类型 / 顺序）的人工确认：状态标记，不是导出硬闸门
    layout_confirmed: bool | None = None
    # 乐观并发检查（说明书第 11 节）：
    expected_revision: int | None = None
    expected_updated_at: str | None = None
    actor_name: str | None = Field(default=None, max_length=100)


@router.patch("/{project_id}/blocks/{block_id}")
def patch_block(
    request: Request, project_id: str, block_id: str, patch: BlockPatch
) -> dict[str, Any]:
    """改一个块。每次成功写入都会加 revision 并记一条 Event（说明书 5.1 / 5.3）。"""
    library = _library(request)
    _require_page_editable(request, project_id, block_id, library=library)
    try:
        block, events = editing.update_block(
            project_id,
            block_id,
            library=library,
            text=patch.text,
            review_status=patch.review_status,
            block_type=patch.block_type,
            include=patch.include,
            continues_to_next=patch.continues_to_next,
            comment=patch.comment,
            bbox=tuple(patch.bbox) if patch.bbox is not None else None,
            layout_confirmed=patch.layout_confirmed,
            expected_revision=patch.expected_revision,
            expected_updated_at=patch.expected_updated_at,
            actor_name=_actor_name(request, patch.actor_name),
        )
    except editing.BlockConflict as exc:
        # 409：客户端该提示"这一页在别处被改过"，而不是把它当参数错误
        raise AppError(409, "block_conflict", "这个块已经被改过", detail=str(exc)) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    if events:
        _history(request).push(project_id, _Batch(events=tuple(events), page_nos=(block.page_no,)))
    return {"block": block.to_dict(), "events": [event.to_dict() for event in events]}


class DiffAckRequest(BaseModel):
    line_index: int = Field(ge=0)
    ack: Literal["kept", "adopted"]
    text: str | None = None


@router.get("/{project_id}/review/marks")
def review_marks(
    request: Request,
    project_id: str,
    page: int | None = None,
    radius: int | None = None,
    first: bool = False,
) -> dict[str, Any]:
    """逐行的差异标记（阅读审校连续流用），**默认按页窗口返回**。

    一条 = 一行的一处实质差异（汉字级 / 标点级），带 A/B 文本与已有的裁决。
    阅读流要靠它把红字标到 `line_spans` 切出来的行元素里。

    任务 67：全书 4435 条一次返回是 1.52 MB / 0.90 s，开机首屏全卡在这里。
    现在带 `page` 就只返回该页 ±`radius`（默认 10）页的标记（~77 KB / 1 ms）；
    `counts` / `page_counts` / `first_unacked_page` 仍然是全书的，进度条和
    "下一处未审"要用。不带 `page` 时行为与以前一致（全书），供调试 / 脚本使用。
    """
    library = _library(request)
    try:
        return reading_marks_module.marks_window(
            project_id,
            library=library,
            page=page,
            radius=reading_marks_module.DEFAULT_RADIUS if radius is None else radius,
            first=first,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


class PunctGroupDecideRequest(BaseModel):
    """一个"标点差异模式"的批量裁决（任务 61）。"""

    key: str = Field(min_length=1, max_length=400)
    ack: Literal["kept", "adopted"]


@router.post("/{project_id}/review/next-lines")
def review_next_lines(
    request: Request, project_id: str, raw_body: dict | None = Body(default=None)
) -> dict[str, Any]:
    """「下一处未审」的唯一数据源：**正文流顺序**的未审行表 + 流外差异计数。

    为什么不用页级计数找：`page_counts` 是队列口径（按页），而阅读流里的行
    （`line_spans`）才是用户能审的东西。实测第 11/14/18/23 页各有 1–2 处未审差异，
    但那些行**不在任何 segment 的 line_spans 里**（脚注 / 被排除块），
    于是「找到页 → 找不到行」→ 前端只能报"没有下一处"。这里按行给，前端不再自己筛页。

    segments 用**和 `export/preview?segments_only=1` 完全同一个函数**（含缓存），
    保证"显示 = 导出"的口径不在这里分叉。
    """
    # 延迟导入：routes_exports 与这里共用 ExportRequest 的形状，模块级导入会成环
    from .routes_exports import ExportRequest as _ExportRequest
    from ..core.export import project as project_export
    from ..core.project import reading_marks as marks_module

    # FastAPI 不把 `Any` 当 body 参数：`body: Any = None` 永远是 None，
    # 接口会静默用默认 options，和 export/preview 的口径分叉。必须用 Body 收 raw dict。
    body = _ExportRequest(**(raw_body or {}))
    library = _library(request)
    _require_main(request, project_id)
    try:
        raw = project_export.preview_segments_json(
            project_id, library=library, options=body.options()
        )
        segments = json.loads(raw).get("segments") or []
        data = marks_module.marks_data(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc

    # 流内顺序：segment 顺序 × line_span 顺序
    order: dict[tuple[str, int], int] = {}
    seq = 0
    for segment in segments:
        for span in segment.get("line_spans") or []:
            key = (str(span.get("block_id")), int(span.get("line_index", -1)))
            if key not in order:
                order[key] = seq
                seq += 1

    lines: list[dict[str, Any]] = []
    outside: list[dict[str, Any]] = []
    for item in data.get("items") or []:
        if item.get("ack"):
            continue
        if item.get("level") == "differs_punct":
            continue
        key = (str(item.get("block_id")), int(item.get("line_index", -1)))
        if key in order:
            lines.append(
                {
                    "block_id": key[0],
                    "line_index": key[1],
                    "page_no": int(item.get("page_no") or 0),
                    "order": order[key],
                }
            )
        else:
            outside.append(
                {
                    "page_no": int(item.get("page_no") or 0),
                    "block_id": key[0],
                    "line_index": key[1],
                    "reason": "not_in_stream",
                }
            )
    lines.sort(key=lambda item: item["order"])
    for item in lines:
        item.pop("order", None)
    counts = data.get("counts") or {}
    return {
        "lines": lines,
        "total": len(lines),
        "outside_stream": {
            "count": len(outside),
            "by_reason": {"not_in_stream": len(outside)},
            "sample": outside[:5],
        },
        "chars_unacked": int(counts.get("chars_unacked") or 0),
        "options_echo": {
            "page_types": list(getattr(body.options(), "page_types", ()) or ()),
            "include_footnotes": bool(getattr(body.options(), "include_footnotes", False)),
            "include_captions": bool(getattr(body.options(), "include_captions", True)),
            "include_notes": bool(getattr(body.options(), "include_notes", False)),
        },
    }


@router.get("/{project_id}/review/garbled-lines")
def review_garbled_lines(request: Request, project_id: str) -> dict[str, Any]:
    """疑似整行乱码（识别把整行打散成字母碎片）：只读清单 + 分母。

    判据见 `core/project/garbled_lines.py`：原文长度 < 候选 55%，或单字母 token 过半。
    候选在这些行上是对的；批量采用走下面那个 POST。
    """
    try:
        return garbled_module.collect(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


class GarbledDecideRequest(BaseModel):
    ack: Literal["kept", "adopted"]


@router.post("/{project_id}/review/garbled-lines/decide")
def decide_garbled_lines(
    request: Request, project_id: str, body: GarbledDecideRequest
) -> dict[str, Any]:
    """整批裁决：`adopted` = 全部换成候选文本，`kept` = 只写裁决不改文本。"""
    try:
        result = garbled_module.decide(
            project_id,
            ack=body.ack,
            library=_library(request),
            actor_name=_actor_name(request, None),
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    if result["events"]:
        _history(request).push(
            project_id,
            _Batch(events=tuple(result["events"]), page_nos=tuple(result["pages"])),
        )
    undo, redo = _history(request).depth(project_id)
    return {
        "batch_id": result["batch_id"],
        "applied": result["applied"],
        "skipped": result["skipped"],
        "ack": result["ack"],
        "history": {"undo": undo, "redo": redo},
    }


@router.get("/{project_id}/review/punct-groups")
def review_punct_groups(request: Request, project_id: str) -> dict[str, Any]:
    """纯标点 / 空格差异按模式分组（每组给数量 + 5 条样例 + 裁决进度）。

    只读。主队列（阅读流）只放含汉字差异的行；这 700 来行由用户按模式批量判，
    一次覆盖几百行——书里 `；→，` 一种就有 293 行，`∅→‘` 119 行（OCR 吞了引号）。
    """
    try:
        return punct_groups_module.collect(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.post("/{project_id}/review/punct-groups/decide")
def decide_punct_group(
    request: Request, project_id: str, body: PunctGroupDecideRequest
) -> dict[str, Any]:
    """一个模式的所有行一次性裁决：采用候选 / 保留原文。

    同一批写进一个 batch，撤销一次全退；一行失败不连累整组（真实状态优先）。
    """
    try:
        result = punct_groups_module.decide(
            project_id,
            key=body.key,
            ack=body.ack,
            library=_library(request),
            actor_name=_actor_name(request, None),
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    if result["events"]:
        _history(request).push(
            project_id,
            _Batch(
                events=tuple(result["events"]),
                page_nos=tuple(result["pages"]),
            ),
        )
    undo, redo = _history(request).depth(project_id)
    return {
        "batch_id": result["batch_id"],
        "applied": result["applied"],
        "skipped": result["skipped"],
        "ack": result["ack"],
        "history": {"undo": undo, "redo": redo},
    }


class DraftItem(BaseModel):
    """一处待提交的草稿：采用 / 保留 / 手改。"""

    block_id: str = Field(min_length=1, max_length=64)
    line_index: int = Field(ge=0)
    ack: Literal["kept", "adopted"] | None = None
    # 这一行提交后的文本：采用=候选、手改=用户输入；保留=None（文本不变）
    new_line_text: str | None = Field(default=None, max_length=20000)


class SubmitDraftsRequest(BaseModel):
    items: list[DraftItem] = Field(min_length=1, max_length=500)


@router.post("/{project_id}/review/submit-drafts")
def submit_drafts(
    request: Request, project_id: str, body: SubmitDraftsRequest
) -> dict[str, Any]:
    """把草稿层一次提交写库（一个 batch，撤销一次全退）。

    采用 / 手改：替换那一行后写块文本；保留：只写 `diff_ack=kept`。
    行号对不上的项失败并原样返回，成功的照常提交。
    """
    library = _library(request)
    events: list = []
    pages: set[int] = set()
    batch = new_ulid()
    results = []
    for item in body.items:
        try:
            block = blocks_module.get_block(project_id, item.block_id, library=library)
            current = (block.text or "").split("\n")
            if item.line_index >= len(current):
                raise blocks_module.ProjectError("这一块的行号对不上了")
            new_text = None
            if item.new_line_text is not None:
                lines = list(current)
                lines[item.line_index] = item.new_line_text
                new_text = "\n".join(lines)
            if item.ack:
                block_after, _line, item_events = editing.ack_diff_line(
                    project_id,
                    item.block_id,
                    item.line_index,
                    item.ack,
                    text=new_text,
                    library=library,
                    actor_name=_actor_name(request, None),
                    batch_id=batch,
                )
            elif new_text is not None:
                block_after, item_events = editing.update_block(
                    project_id,
                    item.block_id,
                    library=library,
                    text=new_text,
                    actor_name=_actor_name(request, None),
                    batch_id=batch,
                )
                # 任务 66：就地编辑改的是"这一行"，行文本必须跟着块文本一起改，
                # 否则会出现"块文本改了、行文本没改"（审的字不是导出的字）。
                line_events = editing.sync_line_text(
                    project_id,
                    item.block_id,
                    item.line_index,
                    new_text.split("\n")[item.line_index],
                    library=library,
                    batch_id=batch,
                    actor_name=_actor_name(request, None),
                )
                events.extend(line_events)
            else:
                raise blocks_module.ProjectError("草稿没有要写的内容")
            events.extend(item_events)
            pages.add(block_after.page_no)
            results.append({"block_id": item.block_id, "line_index": item.line_index, "ok": True})
        except (blocks_module.ProjectError, editing.BlockConflict) as exc:
            results.append(
                {
                    "block_id": item.block_id,
                    "line_index": item.line_index,
                    "ok": False,
                    "error": str(exc),
                }
            )
    if events:
        _history(request).push(
            project_id, _Batch(events=tuple(events), page_nos=tuple(sorted(pages)))
        )
    undo, redo = _history(request).depth(project_id)
    return {
        "results": results,
        "committed": sum(1 for item in results if item["ok"]),
        "failed": sum(1 for item in results if not item["ok"]),
        "history": {"undo": undo, "redo": redo},
    }


@router.post("/{project_id}/blocks/{block_id}/diff-ack")
def ack_block_line(
    request: Request, project_id: str, block_id: str, body: DiffAckRequest
) -> dict[str, Any]:
    """保存一行差异的裁决（保留原文 / 采纳第二路）。

    采纳会与文本改动在同一个 batch 里写，⌘Z 一次同时退回文本与 ack；
    事件表记录 actor / 时间。只写状态或文本，不改块类型 / 框。
    """
    _require_page_editable(request, project_id, block_id, library=_library(request))
    try:
        block, line, events = editing.ack_diff_line(
            project_id,
            block_id,
            body.line_index,
            body.ack,
            text=body.text,
            library=_library(request),
            actor_name=_actor_name(request, None),
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    if events:
        _history(request).push(
            project_id,
            _Batch(events=tuple(events), page_nos=(block.page_no,)),
        )
    undo, redo = _history(request).depth(project_id)
    return {
        "block": block.to_dict(),
        "line": line,
        "events": [event.to_dict() for event in events],
        "history": {"undo": undo, "redo": redo},
    }


# ---------------------------------------------------------------- 新识别结果（R2）
#
# 说明书 R2：重新识别时若页面已有人工成果，新运行只保存为"待选结果"，
# 用户在审校视图中**左右对比**后选择 [采用新结果] 或 [保留现有]。


def _candidate_run(request: Request, project_id: str, page_no: int):
    """这一页的"待选新结果"（没有就抛错）。"""
    library = _library(request)
    page, runs, _blocks, _lines = blocks_module.load_page_content(
        project_id, page_no, library=library
    )
    states = blocks_module.page_recognition_states(project_id, library=library)
    state = states.get(page.page_id)
    if state is None or state.status != blocks_module.STATUS_HAS_CANDIDATE or not state.pending_run_id:
        raise AppError(
            400, "no_candidate", "这一页没有待选的新识别结果", detail=f"第 {page_no} 页"
        )
    run = next((item for item in runs if item.run_id == state.pending_run_id), None)
    if run is None:  # pragma: no cover - 状态与运行记录同源
        raise AppError(400, "no_candidate", "找不到那次运行")
    return page, run


@router.get("/{project_id}/pages/{page_no}/candidate")
def get_candidate(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """候选结果的块与行（对比界面左边是现有的、右边是这份）。"""
    try:
        page, run = _candidate_run(request, project_id, page_no)
        project = project_library.load_project(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    if project.directory is None:  # pragma: no cover
        raise AppError(500, "project_error", "项目缺少目录信息")

    try:
        payload = recognition.read_run_result(project.directory, run)
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    current = _page_blocks_payload(request, project_id, page_no)
    # 逐块采用（说明书 6.4）：先算好"候选的每一块对应现有的哪一块"，
    # 界面据此显示对应关系与「换这一块」，采用时把 target_block_id 原样传回来
    matches = blocks_module.match_candidate_blocks(
        blocks_module.list_blocks(project_id, library=_library(request), page_no=page_no),
        payload["blocks"],
    )
    candidate_blocks = [
        {**item, "match": matches[index]} for index, item in enumerate(payload["blocks"])
    ]
    return {
        "run": run.to_dict(),
        "candidate": {**payload, "blocks": candidate_blocks},
        "current": {
            "blocks": current["blocks"],
            "review": current["review"],
        },
    }


@router.post("/{project_id}/pages/{page_no}/runs/{run_id}/apply-block")
def apply_run_block(
    request: Request, project_id: str, page_no: int, run_id: str, body: ApplyBlockRequest
) -> dict[str, Any]:
    """**逐块**采用新结果（说明书 6.4 的两版对比；R2 只要求整页二选一）。

    只换这一块：目标块软删除、候选块按原样插回来（含行记录）、沿用目标块的位置，
    其余块一个不动。整件事一个 batch，可以撤销。
    """
    library = _library(request)
    try:
        _block, events = editing.adopt_run_block(
            project_id,
            page_no,
            run_id,
            candidate_index=body.candidate_index,
            target_block_id=body.target_block_id,
            library=library,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    _history(request).push(project_id, _Batch(events=tuple(events), page_nos=(page_no,)))
    payload = _page_blocks_payload(request, project_id, page_no)
    return {
        "applied_run_id": run_id,
        "candidate_index": body.candidate_index,
        "page": payload["page"],
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


@router.post("/{project_id}/pages/{page_no}/runs/{run_id}/apply")
def apply_run(request: Request, project_id: str, page_no: int, run_id: str) -> dict[str, Any]:
    """采用新结果（说明书第 11 节的 `.../runs/{rid}/apply`，R2）：旧块软删除、可撤销。"""
    library = _library(request)
    try:
        _blocks, events = editing.adopt_run(
            project_id, page_no, run_id, library=library
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    _history(request).push(project_id, _Batch(events=tuple(events), page_nos=(page_no,)))
    payload = _page_blocks_payload(request, project_id, page_no)
    return {
        "applied_run_id": run_id,
        "page": payload["page"],
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


@router.post("/{project_id}/pages/{page_no}/runs/{run_id}/decline")
def decline_run(request: Request, project_id: str, page_no: int, run_id: str) -> dict[str, Any]:
    """保留现有（说明书 R2）：不动块，只记一条决定，之后不再提示这一份候选。

    说明书第 11 节的接口表里只有 `apply`——这个 `decline` 是 R2 的"保留现有"
    需要的一条落库记录（否则提示关不掉），属本次新增。
    """
    library = _library(request)
    try:
        editing.decline_run(project_id, page_no, run_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    # 决定不进撤销栈：它没有改动任何数据
    payload = _page_blocks_payload(request, project_id, page_no)
    return {
        "declined_run_id": run_id,
        "page": payload["page"],
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


# ---------------------------------------------------------------- 结构编辑
#
# 说明书 6.4 的块操作：与上一块合并、在光标处拆分、上移 / 下移、新增、删除。
# 它们都改结构，因此都记事件、都能撤销（与改文本走同一套机制）。


@router.post("/{project_id}/blocks/{block_id}/merge-prev")
def merge_prev(request: Request, project_id: str, block_id: str) -> dict[str, Any]:
    """把这一块合并到上一块（说明书 R4：文本与 ocr_text 以 \n 连接、bbox 取并集）。"""
    _require_page_editable(request, project_id, block_id, library=_library(request))
    library = _library(request)
    try:
        merged, events = editing.merge_with_previous(
            project_id, block_id, library=library
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    _history(request).push(
        project_id, _Batch(events=tuple(events), page_nos=(merged.page_no,))
    )
    payload = _page_blocks_payload(request, project_id, merged.page_no)
    return {
        "merged_into": merged.block_id,
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


class SplitRequest(BaseModel):
    # 在文本的第几个字符处切开（界面用编辑框的光标位置）
    offset: int = Field(ge=1, le=20000)


@router.post("/{project_id}/blocks/{block_id}/split")
def split_block(
    request: Request, project_id: str, block_id: str, body: SplitRequest
) -> dict[str, Any]:
    """在光标处拆成两块（说明书 R4：两块暂沿用原 bbox，行按位置分配）。"""
    _require_page_editable(request, project_id, block_id, library=_library(request))
    library = _library(request)
    try:
        parts, events = editing.split_block(
            project_id, block_id, library=library, offset=body.offset
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    _history(request).push(
        project_id, _Batch(events=tuple(events), page_nos=(parts[0].page_no,))
    )
    payload = _page_blocks_payload(request, project_id, parts[0].page_no)
    return {
        "parts": [part.block_id for part in parts],
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


class SplitPageNumberRequest(BaseModel):
    """页码候选的文本（可空：空就按页面左右侧给出的提示挑一个）。"""

    candidate_text: str | None = Field(default=None, max_length=32)


@router.post("/{project_id}/blocks/{block_id}/split-page-number")
def split_page_number(
    request: Request, project_id: str, block_id: str, body: SplitPageNumberRequest | None = None
) -> dict[str, Any]:
    """把这一块里（块首 / 块尾）的页码拆成独立的 `page_number` 块。

    只在用户点按钮时执行：建议接口里的 `page_number_hint` 只是提示，不自动拆。
    """
    _require_page_editable(request, project_id, block_id, library=_library(request))
    library = _library(request)
    try:
        parts, events, info = editing.split_off_page_number(
            project_id,
            block_id,
            library=library,
            candidate_text=body.candidate_text if body else None,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    _history(request).push(
        project_id, _Batch(events=tuple(events), page_nos=(parts[0].page_no,))
    )
    payload = _page_blocks_payload(request, project_id, parts[0].page_no)
    return {
        "parts": [part.block_id for part in parts],
        "number": info,
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


class BatchSplitPageNumbersRequest(BaseModel):
    # 哪些页；空 = 全部正文页
    page_numbers: list[int] | None = Field(default=None, max_length=5000)
    # 预览（只算不写）。界面先 dry_run 再让用户确认执行。
    dry_run: bool = True


@router.post("/{project_id}/split-page-numbers")
def split_page_numbers(
    request: Request, project_id: str, body: BatchSplitPageNumbersRequest
) -> dict[str, Any]:
    """批量把书眉 / 页脚里粘着的页码拆成 `page_number` 块（整批一个撤销单元）。"""
    _require_main(request, project_id)
    library = _library(request)
    try:
        result, events = editing.split_page_numbers_batch(
            project_id,
            body.page_numbers,
            library=library,
            dry_run=body.dry_run,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    if not body.dry_run and events:
        _history(request).push(
            project_id,
            _Batch(events=tuple(events), page_nos=tuple(result["pages_affected"])),
        )
    undo, redo = _history(request).depth(project_id)
    result["history"] = {"undo": undo, "redo": redo}
    return result


class MoveRequest(BaseModel):
    direction: Literal["up", "down"]


@router.post("/{project_id}/blocks/{block_id}/move")
def move_block(
    request: Request, project_id: str, block_id: str, body: MoveRequest
) -> dict[str, Any]:
    """与相邻的块交换位置（说明书 6.4 的上移 / 下移）。"""
    _require_page_editable(request, project_id, block_id, library=_library(request))
    library = _library(request)
    try:
        moved, events = editing.move_block(
            project_id, block_id, library=library, direction=body.direction
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    _history(request).push(
        project_id, _Batch(events=tuple(events), page_nos=(moved.page_no,))
    )
    payload = _page_blocks_payload(request, project_id, moved.page_no)
    return {
        "moved": moved.block_id,
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


class CreateBlockRequest(BaseModel):
    # 页码在路径里已经有了，这里保留一个可选字段只是为了兼容老界面（传了就按路径为准）
    page_no: int | None = Field(default=None, ge=1)
    text: str = Field(default="", max_length=20000)
    # 框选位置（归一化坐标，说明书 5.2）；不给就按"无位置信息"处理
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    after_block_id: str | None = None
    actor_name: str | None = Field(default=None, max_length=100)


class ApplyBlockRequest(BaseModel):
    """逐块采用（说明书 6.4）：候选里的第几块 + 用它换掉现有的哪一块。"""

    candidate_index: int = Field(ge=0)
    # 不给就由后端按 bbox 重叠配（配不上按序号）
    target_block_id: str | None = None


@router.post("/{project_id}/pages/{page_no}/blocks")
def create_block(
    request: Request, project_id: str, page_no: int, body: CreateBlockRequest
) -> dict[str, Any]:
    """新增一个块（说明书 6.4；不框选位置就按"无位置信息"处理）。"""
    library = _library(request)
    require_editable_page(project_id, page_no, library=library)
    bbox = tuple(body.bbox) if body.bbox else None
    if bbox is not None and not all(0.0 <= value <= 1.0 for value in bbox):
        raise AppError(400, "bad_bbox", "框选坐标必须是 0–1 的归一化坐标")
    try:
        created, events = editing.create_block(
            project_id,
            page_no,
            library=library,
            text=body.text,
            bbox=bbox,
            after_block_id=body.after_block_id,
            actor_name=_actor_name(request, body.actor_name),
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    _history(request).push(
        project_id, _Batch(events=tuple(events), page_nos=(page_no,))
    )
    payload = _page_blocks_payload(request, project_id, page_no)
    return {
        "created": created.to_dict(),
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


@router.delete("/{project_id}/blocks/{block_id}")
def delete_block(request: Request, project_id: str, block_id: str) -> dict[str, Any]:
    """软删除一个块（说明书 5.1：删除一律软删除）。"""
    _require_page_editable(request, project_id, block_id, library=_library(request))
    library = _library(request)
    try:
        events, page_no = editing.delete_block(project_id, block_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    _history(request).push(project_id, _Batch(events=tuple(events), page_nos=(page_no,)))
    payload = _page_blocks_payload(request, project_id, page_no)
    return {
        "deleted": block_id,
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


# ---------------------------------------------------------------- 第二引擎（说明书 8.5 / R1b）


@router.post("/{project_id}/pages/{page_no}/auxiliary")
def run_auxiliary(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """用第二引擎逐行复核这一页（按第一引擎切出的行图）。

    返回两份文本的比对结果：逐行相同的、只有格式差异的、真正有分歧的。
    **不改任何块**——第二引擎只作为行级候选（说明书 8.5）。
    """
    library = _library(request)
    directory = project_library.project_dir(library, project_id)
    try:
        result = recognition.run_auxiliary(directory, page_no)
    except recognition.EngineUnavailable as exc:
        raise AppError(503, "secondary_engine_unavailable", "第二引擎不可用", detail=str(exc)) from exc
    except project_library.ProjectError as exc:
        status = 404 if not project_library.project_exists(project_id, library=library) else 400
        raise _project_error(exc, status=status) from exc

    payload = _page_blocks_payload(request, project_id, page_no)
    return {**result, "blocks": payload["blocks"]}


# ---------------------------------------------------------------- 确认整页

@router.post("/{project_id}/pages/{page_no}/confirm")
def confirm_page(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """确认整页（规则 R3）：纳入且未审的块 → 已确认；不确定的块保持不动。"""
    library = _library(request)
    try:
        result = editing.confirm_page(project_id, page_no, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc

    if result.events:
        _history(request).push(
            project_id, _Batch(events=result.events, page_nos=(page_no,))
        )
    # 任务 61：人工确认本页 → 工作流记 human（与自动通过区分）
    try:
        page = next(
            item
            for item in project_library.list_pages(project_id, library=library)
            if item.page_no == page_no
        )
        workflow_module.set_confirmation(
            project_library.require_project_dir(project_id, library=library),
            page.page_id,
            workflow_module.CONFIRM_HUMAN,
        )
    except Exception:  # noqa: BLE001 - 状态索引失败不影响已有的整页确认
        pass
    payload = _page_blocks_payload(request, project_id, page_no)
    return {
        "page_no": result.page_no,
        "confirmed": result.confirmed,
        "uncertain": result.uncertain,
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


# ---------------------------------------------------------------- 确认整页版面

class LayoutConfirmRequest(BaseModel):
    """确认整页版面；`page_numbers` 为空时只确认路径里的那一页。

    批量页码是给"一次确认所选 / 一段页"用的；不传页码范围也能正常调用。
    """

    page_numbers: list[int] = Field(default_factory=list, max_length=1000)
    actor_name: str | None = Field(default=None, max_length=100)


@router.post("/{project_id}/pages/{page_no}/layout/confirm")
def confirm_page_layout(
    request: Request, project_id: str, page_no: int, body: LayoutConfirmRequest | None = None
) -> dict[str, Any]:
    """确认整页的**版面**（哪些块算正文），可批量；与页面确认（page_confirmed）分开。

    确认人 / 时间写进事件表（action=confirm_layout）；不进撤销栈——它是状态标记，
    不是内容修改。任何块的类型 / 框 / 顺序改动都会由迁移 0009 的触发器自动重置。
    """
    payload = body or LayoutConfirmRequest()
    page_nos = sorted(set(payload.page_numbers or [page_no]))
    library = _library(request)
    for no in page_nos:
        require_editable_page(project_id, no, library=library)
    try:
        events = editing.confirm_page_layout(
            project_id,
            page_nos,
            library=library,
            actor_name=_actor_name(request, payload.actor_name),
        )
        pages = project_library.list_pages(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    confirmed = [page.page_no for page in pages if page.page_no in set(page_nos)]
    return {
        "confirmed_pages": confirmed,
        "confirmed": len(page_nos),
        "new_events": len(events),
        "events": [event.to_dict() for event in events],
    }


# ---------------------------------------------------------------- 全库采用高把握建议

class ApplySuggestionsRequest(BaseModel):
    # 预览（只读，不写库）；界面先预览再让用户确认
    dry_run: bool = True
    # 只处理这些页（空 = 全部正文页）
    page_numbers: list[int] | None = Field(default=None, max_length=5000)


@router.post("/{project_id}/suggestions/apply")
def apply_high_suggestions(
    request: Request, project_id: str, body: ApplySuggestionsRequest
) -> dict[str, Any]:
    """全库扫一遍高把握建议：`dry_run` 只预览，否则一次应用（可整体撤销）。

    与审校视图的单页「采用全部建议」用的是同一套规则；区别是这里**一次算完所有页**
    （逐页调会对整本书的块重复扫描），并且**只应用 high**：标题与"需确认"永远不动。
    """
    _require_main(request, project_id)
    library = _library(request)
    try:
        plan = structure_module.scan_high_suggestions(
            project_id, library=library, page_numbers=body.page_numbers
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc

    result: dict[str, Any] = plan.to_dict()
    result["dry_run"] = bool(body.dry_run)
    if body.dry_run or not plan.items:
        undo, redo = _history(request).depth(project_id)
        result["history"] = {"undo": undo, "redo": redo}
        return result

    try:
        events, by_type, pages = editing.apply_block_types(
            project_id,
            [(block_id, block_type) for block_id, block_type, _ in plan.items],
            library=library,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    _history(request).push(project_id, _Batch(events=tuple(events), page_nos=pages))
    undo, redo = _history(request).depth(project_id)
    result["dry_run"] = False
    result["events"] = len(events)
    result["by_type"] = by_type
    result["pages_affected"] = list(pages)
    result["history"] = {"undo": undo, "redo": redo}
    return result


# ---------------------------------------------------------------- 自动应用（识别完成后）

@router.get("/{project_id}/auto-apply")
def get_auto_apply(request: Request, project_id: str) -> dict[str, Any]:
    """最近一次"识别完成后自动应用"的记录（没有就是 null）。"""
    directory = project_library.project_dir(_library(request), project_id)
    return {"latest": auto_apply_module.latest_run(directory)}


@router.post("/{project_id}/auto-apply/{auto_apply_id}/undo")
def undo_auto_apply(request: Request, project_id: str, auto_apply_id: str) -> dict[str, Any]:
    """撤销**最近一次**自动应用（整批）。

    自动应用发生在识别子进程里，不在 API 的撤销栈里，所以这里按 batch_id 从事件表
    把那一批读回来再反过来应用；这一批之后如果还有别的修改就拒绝（先撤后面的）。
    """
    _require_main(request, project_id)
    directory = project_library.project_dir(_library(request), project_id)
    try:
        result = auto_apply_module.undo_run(directory, auto_apply_id)
    except auto_apply_module.AutoApplyError as exc:
        raise AppError(400, "auto_apply_undo_refused", str(exc)) from exc
    return result


# ---------------------------------------------------------------- 撤销 / 重做

def _apply_history(
    request: Request, project_id: str, *, direction: str
) -> dict[str, Any]:
    history = _history(request)
    batch = history.pop_undo(project_id) if direction == "undo" else history.pop_redo(project_id)
    if batch is None:
        raise AppError(
            400,
            "nothing_to_undo" if direction == "undo" else "nothing_to_redo",
            "没有可撤销的操作" if direction == "undo" else "没有可重做的操作",
            detail="撤销栈只保留本次运行的最近操作（说明书 5.3）",
        )

    library = _library(request)
    # 同一块在一批里被改过多次（例如两行草稿落在同一块）：撤销必须**倒序**写回
    # before，否则后一次的快照会把前一次覆盖掉。重做仍然正序。
    ordered = list(batch.events) if direction == "redo" else list(reversed(batch.events))
    try:
        events, pages = editing.revert_events(
            project_id, ordered, library=library, direction=direction
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    # 撤销 / 重做只回放块事件；行文本（任务 66 的就地编辑）要跟着块文本校正。
    # `resync_lines` 只写"确实对不上"的行，对得上的一行都不动。
    touched_blocks = [
        event.entity_id
        for event in batch.events
        if getattr(event, "entity_type", "") == "block"
    ]
    if touched_blocks:
        editing.resync_lines(project_id, touched_blocks, library=library)

    # 栈里放的是**原始那一批事件**：撤销写回 before、重做再写 after，
    # 于是同一个批次可以在两个栈之间来回搬（放"新事件"进去会让值绕圈走到别处去）。
    if direction == "undo":
        history.push_redo(project_id, batch)
    else:
        history.push_undo(project_id, batch)

    undo, redo = history.depth(project_id)
    result: dict[str, Any] = {
        "direction": direction,
        "changed_blocks": len(events),
        "pages": sorted(pages),
        "history": {"undo": undo, "redo": redo},
    }
    if len(pages) == 1:
        page_no = next(iter(pages))
        payload = _page_blocks_payload(request, project_id, page_no)
        result["page"] = payload["page"]
        result["blocks"] = payload["blocks"]
        result["review"] = payload["review"]
    return result


@router.post("/{project_id}/undo")
def undo(request: Request, project_id: str) -> dict[str, Any]:
    return _apply_history(request, project_id, direction="undo")


@router.post("/{project_id}/redo")
def redo(request: Request, project_id: str) -> dict[str, Any]:
    return _apply_history(request, project_id, direction="redo")


class RecognizeRegionRequest(BaseModel):
    # 框选区域（归一化、相对页面显示方向）
    bbox: list[float] = Field(min_length=4, max_length=4)


@router.post("/{project_id}/pages/{page_no}/recognize-region")
def recognize_region(
    request: Request, project_id: str, page_no: int, body: RecognizeRegionRequest
) -> dict[str, Any]:
    """框选一块区域**只识别这一块**（局部重识别）。

    **不落库**：结果只返回给界面填进「框选新增块」的输入框，用户确认后才走新增块接口。
    这个接口不建 Run、不建块、不建行，不写事件。
    """
    _require_main(request, project_id)
    library = _library(request)
    try:
        project = project_library.load_project(project_id, library=library)
        pages = project_library.list_pages(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    page = next((item for item in pages if item.page_no == page_no), None)
    if page is None:
        raise AppError(404, "page_not_found", f"没有第 {page_no} 页")
    if project.directory is None:  # pragma: no cover - 装配错误
        raise AppError(500, "project_error", "项目缺少目录信息")
    source = project.directory / project_library.SOURCE_DIR_NAME / project_library.SOURCE_FILE_NAME
    index = page.pdf_page_index if page.pdf_page_index is not None else page_no - 1
    try:
        result = recognition.recognize_region(source, index, body.bbox)
    except recognition.EngineUnavailable as exc:
        raise AppError(503, "ocr_engine_unavailable", "OCR 引擎不可用", detail=str(exc)) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    return {**result, "page_no": page_no}


@router.get("/{project_id}/pages/{page_no}/ink-gaps")
def ink_gaps(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """可疑漏行：有墨迹、但没有被任何行框覆盖的横条（**只读**）。

    误报就是噪声，所以阈值取得保守（见 `core/project/ink_gaps.py` 的常量）。
    """
    library = _library(request)
    try:
        return ink_gaps_module.find_ink_gaps(project_id, page_no, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.get("/{project_id}/pages/{page_no}/blocks")
def page_blocks(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """一页的块、行、运行记录与审校进度（审校视图读这个）。"""
    try:
        return _page_blocks_payload(request, project_id, page_no)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


# ---------------------------------------------------------------- 块类型建议（只读）


@router.get("/{project_id}/pages/{page_no}/block-suggestions")
def block_suggestions(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """一页的块类型建议（**只读**，不写库、不改 `block_type`）。

    规则与「结构工具」的页眉页脚预览是同一套：位置条带 + 字数上限 + 跨页重复 +
    数字形态；只返回"与当前类型不同"的建议。书眉里夹着的页码（如
    `2谁是巴赫金?11`）以 `page_number_candidates` 返回，`page_number_hint`
    只是按页面左右侧给的提示，**不是结论**；标题（章 / 回 / 节标记）只给 review。
    脚注 / 旁批也只给 review：命中位置 / 字号 / 注释符号 / 间距信号，**永不 high**
    ——误标会让注文离开正文，「全库采用高把握」与自动应用都不会碰它们。
    """
    _require_main(request, project_id)
    library = _library(request)
    try:
        plan = structure_module.suggest_block_types(project_id, page_no, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return plan.to_dict()
