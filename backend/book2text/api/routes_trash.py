"""废纸篓接口（任务 35）：删除项目 = 移入废纸篓，可恢复 / 彻底删除。

- `DELETE /api/projects/{id}`：移入废纸篓（必须 `?confirm=true`）；
- `GET /api/trash`：废纸篓列表；
- `POST /api/trash/{id}/restore`：恢复；
- `DELETE /api/trash/{id}`：彻底删除（必须 `?confirm=true`，真删目录）。

项目目录整体移到 `<库>/.trash/<项目 id>/`：库列表只扫库根的一层目录，`.trash`
不是合法项目 ID，所以列表 / 统计 / 所有按项目 ID 的接口天然看不到它；恢复就是搬回来。

**`.lock` 挡住删除时不再只回一句"正在使用中"**（任务 60）：接口带结构化信息
（谁、什么时候、进程还在不在、锁是否过期），界面据此画确认框：

- 过期锁 → `?force=true` 可以删（用户已经在本机确认过一次）；
- 真占用（另一个窗口 / 另一台电脑心跳正常）→ 不给强制，先关掉那个窗口。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from ..core.project import library as project_library
from .deps import actor_name as _actor_name
from .deps import library_dir as _library
from .errors import AppError

router = APIRouter(prefix="/api", tags=["trash"])


def _project_error_with_trash(exc: project_library.ProjectError) -> AppError:
    message = str(exc)
    status = 404 if "找不到" in message or "废纸篓里没有" in message else 400
    return AppError(status, "project_error", message)


def _locked_error(exc: project_library.ProjectLocked, project_id: str) -> AppError:
    detail = exc.status.detail()
    detail["project_id"] = project_id
    if exc.expired:
        return AppError(
            409,
            "project_lock_expired",
            "这个项目的锁已过期，确认后可以删除",
            detail=str(exc),
            data={"lock": detail},
        )
    return AppError(
        409,
        "project_busy",
        "项目正在使用中，不能删除",
        detail=str(exc),
        data={"lock": detail},
    )


@router.delete("/projects/{project_id}")
def delete_project(
    request: Request,
    project_id: str,
    confirm: bool = Query(default=False),
    force: bool = Query(default=False),
) -> dict[str, Any]:
    """把项目移入废纸篓（不删数据）。`force=true` 只用于接管**已过期**的锁。"""
    if not confirm:
        raise AppError(400, "confirmation_required", "删除项目需要二次确认")
    try:
        entry = project_library.trash_project(
            project_id,
            library=_library(request),
            actor=_actor_name(request) or "",
            force=force,
        )
    except project_library.ProjectLocked as exc:
        raise _locked_error(exc, project_id) from exc
    except project_library.ProjectBusy as exc:
        raise AppError(
            409,
            "project_busy",
            "项目正在使用中，不能删除",
            detail=str(exc),
        ) from exc
    except project_library.ProjectError as exc:
        raise _project_error_with_trash(exc) from exc
    return {"trashed": True, "project": entry.to_dict()}


@router.get("/trash")
def list_trash(request: Request) -> dict[str, Any]:
    library = _library(request)
    entries = project_library.list_trash(library=library)
    return {"count": len(entries), "projects": [entry.to_dict() for entry in entries]}


@router.post("/trash/{project_id}/restore")
def restore_project(request: Request, project_id: str) -> dict[str, Any]:
    try:
        project = project_library.restore_project(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error_with_trash(exc) from exc
    return {"restored": True, "project": project.to_dict()}


@router.delete("/trash/{project_id}")
def purge_project(
    request: Request,
    project_id: str,
    confirm: bool = Query(default=False),
) -> dict[str, Any]:
    """彻底删除（真删目录）。必须二次确认。"""
    if not confirm:
        raise AppError(400, "confirmation_required", "彻底删除需要二次确认")
    try:
        project_library.delete_trashed_project(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error_with_trash(exc) from exc
    return {"deleted": True, "project_id": project_id}
