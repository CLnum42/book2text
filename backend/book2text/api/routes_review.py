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
from ..core.project import structure as structure_module
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


def _block_payload(block: blocks_module.BlockRecord, lines) -> dict[str, Any]:
    divergence = blocks_module.block_divergence(block, lines)
    return {
        **block.to_dict(),
        "lines": [line.to_dict() for line in lines],
        # 第二引擎的分歧（说明书 8.5）：界面据此在块里逐行标出另一路候选，
        # 并显示"这一块有 N 行两路不一致"。标记按**块里现在的文本**现算（见 blocks.py）。
        "divergence": divergence.to_dict(),
        "diff_line_count": divergence.lines,
    }


def _require_page_editable(request: Request, project_id: str, block_id: str, *, library) -> None:
    """只读上下文页（说明书 6.7.2）不能改：块在那种页上就拒绝。

    `deps.require_editable_page` 是按**页码**判的，块编辑路径手里只有块 id，这里先查它在哪一页。
    审校包里上下文页的存在本身就是"给你看跨页段落用的"，改它会让结果包与主项目对不上。
    """
    for page in project_library.list_pages(project_id, library=library):
        blocks = blocks_module.list_blocks(project_id, library=library, page_no=page.page_no)
        if any(block.block_id == block_id for block in blocks):
            require_editable_page(project_id, page.page_no, library=library)
            return
    # 查不到就交给编辑层报"找不到块"（保持原来的 404 语义）


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
    return {
        "page": {**page.to_dict(), "recognition": (state or blocks_module.empty_recognition(page.page_id)).to_dict()},
        "runs": [run.to_dict() for run in runs],
        "active_run": active.to_dict() if active else None,
        "block_count": len(blocks),
        "blocks": [_block_payload(block, by_block.get(block.block_id, [])) for block in blocks],
        "review": _review_summary(blocks),
        # 行归属统计（改框之后看得见）：冲突 / 未归属的行一条都不会丢
        "layout_lines": _line_layout_summary(lines),
        "divergence": blocks_module.page_divergence_summary(blocks, lines, runs).to_dict(),
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


# ---------------------------------------------------------------- 块类型建议（只读）


@router.get("/{project_id}/pages/{page_no}/block-suggestions")
def block_suggestions(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """一页的块类型建议（**只读**，不写库、不改 `block_type`）。

    规则与「结构工具」的页眉页脚预览是同一套：位置条带 + 字数上限 + 跨页重复 +
    数字形态；只返回"与当前类型不同"的建议。书眉里夹着的页码（如
    `2谁是巴赫金?11`）以 `page_number_candidates` 返回，`page_number_hint`
    只是按页面左右侧给的提示，**不是结论**；标题（章 / 回 / 节标记）只给 review。
    """
    _require_main(request, project_id)
    library = _library(request)
    try:
        plan = structure_module.suggest_block_types(project_id, page_no, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return plan.to_dict()
