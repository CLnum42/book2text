"""Jev 可疑度排序接口（2026-11-05）。

三件事：**跑一次**（建 `job_type="jev_priority"` 的任务）、**看状态**（有多少行有分数 /
任务跑到哪了）、**清掉**（清列 + 写 event，队列回原顺序）。

默认关闭：这些接口只有用户点了才会被调，识别 / 审校 / 导出链路都不经过这里。
探测不过（引擎 / 打分服务 / 模型 / 字体缺）时**直接报 503 并说清缺什么**，不建任务。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from ..core.project import jev_priority as jev_module
from ..core.project import jobs as jobs_module
from ..core.project import library as project_library
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError
from .routes_jobs import _job_payload, _start_job

router = APIRouter(prefix="/api/projects", tags=["jev-priority"])


@router.get("/{project_id}/jev-priority/ready")
def jev_ready(request: Request, project_id: str) -> dict[str, Any]:
    """跑之前先问一句：环境齐不齐。`problems` 非空 ⇒ 界面上把按钮置灰并显示原因。"""
    _require_main(request, project_id)
    config = jev_module.JevConfig.from_env()
    problems = jev_module.probe(config)
    counts = jev_module.scored_counts(project_id, library=_library(request))
    return {"ready": not problems, "problems": problems, **counts}


@router.post("/{project_id}/jev-priority/start")
def jev_start(request: Request, project_id: str) -> dict[str, Any]:
    """建任务并起子进程。探测不过 / 没有分歧行 / 已有任务 ⇒ 4xx/503，队列不动。"""
    _require_main(request, project_id)
    library = _library(request)
    try:
        job = jev_module.create_job(project_id, library=library)
    except jev_module.JevUnavailable as exc:
        raise AppError(503, "jev_unavailable", "Jev 不能开始", detail=str(exc)) from exc
    except jobs_module.JobError as exc:
        raise AppError(409, "job_conflict", "已有任务在跑", detail=str(exc)) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return _start_job(request, project_id, job)


@router.get("/{project_id}/jev-priority")
def jev_status(request: Request, project_id: str) -> dict[str, Any]:
    """状态：有分数的行数 / 分歧行总数 / 最近一次打分任务。"""
    _require_main(request, project_id)
    directory = _library(request) / project_id
    counts = jev_module.scored_counts(project_id, library=_library(request))
    latest = None
    try:
        found = jobs_module.list_jobs(directory, limit=20)
    except jobs_module.JobError:
        found = []
    for job in found:
        if job.job_type == jobs_module.JOB_TYPE_JEV:
            latest = _job_payload(request, project_id, job)["job"]
            break
    return {"latest_job": latest, **counts}


@router.post("/{project_id}/jev-priority/clear")
def jev_clear(request: Request, project_id: str) -> dict[str, Any]:
    """一键清除：清列 + 写 event。清完逐行回原顺序（查询侧不再有分数）。"""
    _require_main(request, project_id)
    library = _library(request)
    try:
        cleared = jev_module.clear_scores(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"cleared": cleared, "scored": 0}
