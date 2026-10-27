"""版面检测与页面工作流接口（任务 58 / `docs/workflow.md` 阶段 2、第 2 节）。

- `POST /jobs/layout`：建检测任务并起子进程（复用现有任务控制）；
- `GET  /pages/{page_no}/layout`：读一页最近一次成功检测的行框；
- `GET  /workflow`：页面状态列表 / 按状态筛选 / 各状态数量。

**这一刀只记录**：接口不改识别、版心、页码、导出。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from ..core.layout import detection as layout_detection
from ..core.project import executor as executor_module
from ..core.project import jobs as jobs_module
from ..core.project import library as project_library
from ..core.project import workflow as workflow_module
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["layout"])


def _directory(request: Request, project_id: str) -> Path:
    return project_library.project_dir(_library(request), project_id)


def _supervisor(request: Request) -> executor_module.Supervisor:
    supervisor = getattr(request.app.state, "job_supervisor", None)
    if supervisor is None:  # pragma: no cover - 装配错误
        raise AppError(500, "server_not_ready", "服务未正确初始化（缺少任务执行器）")
    return supervisor


class LayoutJobRequest(BaseModel):
    """检测范围：`pages`（具体页码）与 `scope="body"`（全部正文页）二选一。"""

    pages: list[int] | None = Field(default=None, max_length=5000)
    scope: Literal["body"] | None = None
    # 默认跳过已检测的页；重新检测时显式传 false（界面不做批量重测入口）
    skip_detected: bool = True
    dpi: int | None = Field(default=None, ge=72, le=600)
    # 任务 62：「检测并定版心」：已有检测行的页只拟合，不再重检测
    prepare: bool = False


def _job_payload(
    request: Request, project_id: str, job: jobs_module.JobRecord
) -> dict[str, Any]:
    directory = _directory(request, project_id)
    items = jobs_module.list_job_items(directory, job.job_id)
    return {
        "job": job.to_dict(),
        "items": [item.to_dict() for item in items],
        "failed_items": [
            item.to_dict()
            for item in items
            if item.status == jobs_module.ITEM_STATUS_FAILED
        ],
        "alive": _supervisor(request).is_alive(job.job_id),
        "process_id": _supervisor(request).process_id(job.job_id),
    }


@router.post("/{project_id}/jobs/layout")
def start_layout_job(
    request: Request, project_id: str, body: LayoutJobRequest
) -> dict[str, Any]:
    """建一个版面检测任务并立刻开始跑（只检测不识别）。"""
    _require_main(request, project_id)
    library = _library(request)
    directory = _directory(request, project_id)
    try:
        job = layout_detection.create_layout_job(
            project_id,
            library=library,
            pages=body.pages,
            scope=body.scope,
            skip_detected=body.skip_detected,
            dpi=body.dpi,
            prepare=body.prepare,
        )
    except layout_detection.LayoutUnavailable as exc:
        raise AppError(
            503, "layout_engine_unavailable", "版面检测引擎不可用", detail=str(exc)
        ) from exc
    except project_library.ProjectError as exc:
        status = 404 if not project_library.project_exists(project_id, library=library) else 400
        raise _project_error(exc, status=status) from exc

    supervisor = _supervisor(request)
    try:
        supervisor.start(directory, job.job_id)
    except jobs_module.JobError as exc:
        jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_FAILED)
        jobs_module.repair_unfinished(directory, message=str(exc), job_id=job.job_id)
        raise AppError(500, "job_error", "任务启动失败", detail=str(exc)) from exc
    return _job_payload(request, project_id, jobs_module.get_job(directory, job.job_id))


@router.get("/{project_id}/layout/plan")
def get_layout_plan(request: Request, project_id: str) -> dict[str, Any]:
    """检测计划：哪些正文页还没检测、按本项目历史实测大概要多久。"""
    try:
        plan = layout_detection.layout_plan(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        status = 404 if not project_library.project_exists(
            project_id, library=_library(request)
        ) else 400
        raise _project_error(exc, status=status) from exc
    return {"ok": True, **plan}


@router.get("/{project_id}/pages/{page_no}/layout")
def get_page_layout(
    request: Request, project_id: str, page_no: int
) -> dict[str, Any]:
    """一页最近一次成功检测的运行与行框；没检测过时 `run` 为 null。"""
    try:
        return layout_detection.page_layout(
            project_id, page_no, library=_library(request)
        )
    except project_library.ProjectError as exc:
        status = 404 if not project_library.project_exists(
            project_id, library=_library(request)
        ) else 400
        raise _project_error(exc, status=status) from exc


@router.get("/{project_id}/workflow")
def get_workflow(
    request: Request,
    project_id: str,
    stage: str | None = Query(default=None),
    failed: bool | None = Query(default=None),
    page_number_state: str | None = Query(default=None),
) -> dict[str, Any]:
    """页面状态列表 + 各状态数量 + 摘要；可只取某个状态 / 只看有失败的页。"""
    try:
        return workflow_module.project_workflow(
            project_id,
            library=_library(request),
            stage=stage,
            failed=failed,
            page_number_state=page_number_state,
        )
    except workflow_module.WorkflowError as exc:
        status = 404 if not project_library.project_exists(
            project_id, library=_library(request)
        ) else 400
        raise AppError(status, "workflow_error", "工作流状态读取失败", detail=str(exc)) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


__all__ = ["router"]
