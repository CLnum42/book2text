"""批量数据清理接口（任务 41 / F1 + F2）。

两件都是**批量写库**，所以都：

- 先给只读计划（GET），界面用它确认"要改多少"；
- 应用时整批一个 `batch_id`、进同一个撤销栈（POST `/undo` 一次退回）；
- 只改块字段（`continues_to_next` / `block_type`），不动文字、框、审校状态。

F1 跨页延续：三桶（continue / end / review），人工标过的不覆盖。
F2 家具块：整块全是家具才改类型，绝不按行拆。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..core.project import continuations as continuations_module
from ..core.project import editing
from ..core.project import furniture as furniture_module
from ..core.project import library as project_library
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["cleanup"])


class CleanupRequest(BaseModel):
    actor_name: str | None = Field(default=None, max_length=100)


@router.get("/{project_id}/cleanup/continuations")
def continuation_plan(request: Request, project_id: str) -> dict[str, Any]:
    """只读：393 个页边界各属哪个桶（continue / end / review / manual）。"""
    try:
        return continuations_module.analyze(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.post("/{project_id}/cleanup/continuations")
def continuation_apply(
    request: Request, project_id: str, body: CleanupRequest | None = None
) -> dict[str, Any]:
    """自动标延续：continue → 1，end → 0；review / manual 不动。整批可撤销。"""
    _require_main(request, project_id)
    try:
        result = continuations_module.apply(
            project_id,
            library=_library(request),
            actor_name=body.actor_name if body else None,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    except editing.BlockConflict as exc:  # pragma: no cover - 批量不做并发检查
        raise AppError(409, "block_conflict", "块已经被改过", detail=str(exc)) from exc
    return _with_history(request, project_id, result)


@router.get("/{project_id}/cleanup/furniture")
def furniture_plan(request: Request, project_id: str) -> dict[str, Any]:
    """只读：整块都是家具的块，以及建议类型（header / page_number）。"""
    try:
        return furniture_module.analyze(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.post("/{project_id}/cleanup/furniture")
def furniture_apply(
    request: Request, project_id: str, body: CleanupRequest | None = None
) -> dict[str, Any]:
    """把整块都是家具的块改成 header / page_number。整批可撤销。"""
    _require_main(request, project_id)
    try:
        result = furniture_module.apply(
            project_id,
            library=_library(request),
            actor_name=body.actor_name if body else None,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    except editing.BlockConflict as exc:  # pragma: no cover
        raise AppError(409, "block_conflict", "块已经被改过", detail=str(exc)) from exc
    return _with_history(request, project_id, result)


def _with_history(request: Request, project_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """把这一批放进撤销栈（与结构工具 / 建议应用同一套），并返回撤销深度。"""
    from .routes_review import _Batch  # 复用同一个批次类型

    history = getattr(request.app.state, "review_history", None)
    events = result.pop("events", ())
    if history is not None and events:
        history.push(
            project_id,
            _Batch(events=tuple(events), page_nos=tuple(result.get("pages") or ())),
        )
    depth = None
    if history is not None:
        undo, redo = history.depth(project_id)
        depth = {"undo": undo, "redo": redo}
    result["history"] = depth
    return result
