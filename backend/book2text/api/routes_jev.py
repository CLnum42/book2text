"""Jev 可疑度排序接口（2026-11-05）。

三件事：**跑一次**（建 `job_type="jev_priority"` 的任务）、**看状态**（有多少行有分数 /
任务跑到哪了）、**清掉**（清列 + 写 event，队列回原顺序）。

默认关闭：这些接口只有用户点了才会被调，识别 / 审校 / 导出链路都不经过这里。
探测不过（引擎 / 打分服务 / 模型 / 字体缺）时**直接报 503 并说清缺什么**，不建任务。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from ..core.project import jev_health as jev_health_module
from ..core.project import jev_priority as jev_module
from ..core.project import jobs as jobs_module
from ..core.project import library as project_library
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError
from .routes_jobs import _job_payload, _start_job

router = APIRouter(prefix="/api/projects", tags=["jev-priority"])


def _runtime(request: Request) -> "jev_health_module.JevRuntime":
    """本实例的 Jev 家当（引擎 + 主进程内打分层）。装配时挂在 app.state 上。"""
    runtime = getattr(request.app.state, "jev_runtime", None)
    if runtime is None:  # pragma: no cover - 正常装配一定有；测试里可以塞假的
        runtime = jev_health_module.JevRuntime()
        request.app.state.jev_runtime = runtime
    return runtime


def _verdict_payload(request: Request, project_id: str, verdict) -> dict[str, Any]:
    """四步结论 + 队列计数。老键 `ready` / `problems` 保留，界面不用同时改两处。"""
    counts = jev_module.scored_counts(project_id, library=_library(request))
    payload = {
        "ready": verdict.ok,
        "problems": verdict.problems(),
        **verdict.to_dict(),
        **counts,
    }
    payload["config"] = {
        "font": jev_module.JevConfig.from_env().font_path,
    }
    return payload


@router.get("/{project_id}/jev-priority/ready")
def jev_ready(request: Request, project_id: str) -> dict[str, Any]:
    """只看不启动：现在能不能打分（四步里的第几步没过）。

    界面进审校视图时调它——`ok=false` 就把按钮置灰并显示 `detail`，
    不再让用户"点下去才知道"。**真正启动**用下面的 `POST …/engine/start`。
    """
    _require_main(request, project_id)
    verdict = _runtime(request).check()
    return _verdict_payload(request, project_id, verdict)


@router.post("/{project_id}/jev-priority/engine/start")
def jev_engine_start(request: Request, project_id: str) -> dict[str, Any]:
    """把引擎与打分层起起来（幂等）：已在跑就只做一次真打分探针。

    懒启动的入口：界面第一次要用 Jev 时调这个，之后每点「Jev 打分」都便宜。
    """
    _require_main(request, project_id)
    verdict = _runtime(request).ensure()
    return _verdict_payload(request, project_id, verdict)


@router.post("/{project_id}/jev-priority/start")
def jev_start(request: Request, project_id: str) -> dict[str, Any]:
    """建任务并起子进程。探测不过 / 没有分歧行 / 已有任务 ⇒ 4xx/503，队列不动。"""
    _require_main(request, project_id)
    library = _library(request)
    try:
        job = jev_module.create_job(project_id, library=library, runtime=_runtime(request))
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
    ready, reason = jev_module.sort_ready(project_id, library=_library(request))
    return {"latest_job": latest, "sort_ready": ready, "sort_reason": reason, **counts}


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
