"""审校接口（说明书第 11 节的「块」与「历史」两组，6.4 的审校功能）。

- `PATCH /projects/{id}/blocks/{bid}`：改块（文本 / 状态 / 类型 / 纳入 / 延续 / 备注）。
- `POST /projects/{id}/pages/{pid}/confirm`：确认整页（规则 R3）。
- `POST /projects/{id}/undo` / `/redo`：按 batch 撤销 / 重做。

**撤销栈只存在内存里**（说明书 5.3："撤销栈仅限本次会话，应用重启后不可撤销历史操作"）。
栈以项目为键，挂在 `app.state.review_history` 上——因此重启应用后栈就空了，
但**已保存的成果不受影响**，事件表里的历史也一条不少。
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..core.project import blocks as blocks_module
from ..core.project import editing
from ..core.project import library as project_library
from ..core.project import recognition
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


def _block_payload(block: blocks_module.BlockRecord, lines) -> dict[str, Any]:
    payload = {
        **block.to_dict(),
        "lines": [line.to_dict() for line in lines],
    }
    # 第二引擎的分歧行（说明书 8.5）：界面据此提示"这一块有 N 行两路不一致"
    payload["diff_line_count"] = sum(
        1 for line in lines if line.diff_status and line.diff_status != "identical"
    )
    return payload


def _page_blocks_payload(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    library = _library(request)
    page, runs, blocks, lines = blocks_module.load_page_content(
        project_id, page_no, library=library
    )
    states = blocks_module.page_recognition_states(project_id, library=library)
    by_block: dict[str, list[blocks_module.BlockLineRecord]] = {}
    for line in lines:
        by_block.setdefault(line.block_id, []).append(line)

    state = states.get(page.page_id)
    active_run_id = state.active_run_id if state else None
    active = next((run for run in runs if run.run_id == active_run_id), None)
    undo, redo = _history(request).depth(project_id)
    return {
        "page": {**page.to_dict(), "recognition": (state or blocks_module.empty_recognition(page.page_id)).to_dict()},
        "runs": [run.to_dict() for run in runs],
        "active_run": active.to_dict() if active else None,
        "block_count": len(blocks),
        "blocks": [_block_payload(block, by_block.get(block.block_id, [])) for block in blocks],
        "review": _review_summary(blocks),
        "history": {"undo": undo, "redo": redo},
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
    }


# ---------------------------------------------------------------- 改块

class BlockPatch(BaseModel):
    text: str | None = Field(default=None, max_length=20000)
    review_status: str | None = None
    block_type: str | None = None
    include: bool | None = None
    continues_to_next: bool | None = None
    comment: str | None = Field(default=None, max_length=500)
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
            expected_revision=patch.expected_revision,
            expected_updated_at=patch.expected_updated_at,
            actor_name=patch.actor_name,
        )
    except editing.BlockConflict as exc:
        # 409：客户端该提示"这一页在别处被改过"，而不是把它当参数错误
        raise AppError(409, "block_conflict", "这个块已经被改过", detail=str(exc)) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    if events:
        _history(request).push(project_id, _Batch(events=tuple(events), page_nos=(block.page_no,)))
    return {"block": block.to_dict(), "events": [event.to_dict() for event in events]}


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
    return {
        "run": run.to_dict(),
        "candidate": payload,
        "current": {
            "blocks": current["blocks"],
            "review": current["review"],
        },
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


class MoveRequest(BaseModel):
    direction: Literal["up", "down"]


@router.post("/{project_id}/blocks/{block_id}/move")
def move_block(
    request: Request, project_id: str, block_id: str, body: MoveRequest
) -> dict[str, Any]:
    """与相邻的块交换位置（说明书 6.4 的上移 / 下移）。"""
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
    page_no: int = Field(ge=1)
    text: str = Field(default="", max_length=20000)
    # 框选位置（归一化坐标，说明书 5.2）；不给就按"无位置信息"处理
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    after_block_id: str | None = None
    actor_name: str | None = Field(default=None, max_length=100)


@router.post("/{project_id}/pages/{page_no}/blocks")
def create_block(
    request: Request, project_id: str, page_no: int, body: CreateBlockRequest
) -> dict[str, Any]:
    """新增一个块（说明书 6.4；不框选位置就按"无位置信息"处理）。"""
    library = _library(request)
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
            actor_name=body.actor_name,
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
    payload = _page_blocks_payload(request, project_id, page_no)
    return {
        "page_no": result.page_no,
        "confirmed": result.confirmed,
        "uncertain": result.uncertain,
        "blocks": payload["blocks"],
        "review": payload["review"],
        "history": payload["history"],
    }


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
    try:
        events, pages = editing.revert_events(
            project_id, list(batch.events), library=library, direction=direction
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

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


@router.get("/{project_id}/pages/{page_no}/blocks")
def page_blocks(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """一页的块、行、运行记录与审校进度（审校视图读这个）。"""
    try:
        return _page_blocks_payload(request, project_id, page_no)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
