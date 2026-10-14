"""识别任务接口（说明书第 11 节的「识别任务」一组，6.3 的任务控制）。

**任务是异步的**：`POST /jobs/ocr` 建任务、起子进程，立刻返回（状态 `queued`），
界面靠轮询 `GET /jobs/{jid}` 看进度。真正的识别在子进程里跑
（见 `core/project/executor.py`），因此工具条不会被一本书的识别卡住。

**控制信号也走数据库**：暂停 / 取消就是把任务状态写成 `paused` / `cancelled`，
子进程在页与页之间读到就照办。所以"暂停"在**当前页做完之后**生效——
说明书 6.3 的原话就是"暂停（当前页完成后停止）"。

**失败不抛 HTTP 错误**：任务建成了就是建成了，失败原因记在
`job_item.error_message` 与 `ocr_run.error_message` 里，界面按任务结果展示
（说明书 Phase 2 的验收"失败原因可见"）。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from ..core.project import blocks as blocks_module
from ..core.project import executor as executor_module
from ..core.project import jobs as jobs_module
from ..core.project import library as project_library
from ..core.project import recognition
from .deps import library_dir as _library
from .deps import page_payload, project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["jobs"])

MAX_JOB_LIST = 50


def _supervisor(request: Request) -> executor_module.Supervisor:
    supervisor = getattr(request.app.state, "job_supervisor", None)
    if supervisor is None:  # pragma: no cover - 装配错误
        raise AppError(500, "server_not_ready", "服务未正确初始化（缺少任务执行器）")
    return supervisor


def _directory(request: Request, project_id: str) -> Path:
    return project_library.project_dir(_library(request), project_id)


def _job_error(exc: Exception, *, status: int = 400) -> AppError:
    return AppError(status, "job_error", "任务操作失败", detail=str(exc))


class OcrJobRequest(BaseModel):
    """批量识别的范围：`pages`（具体页码）与 `scope`（按状态取）二选一。"""

    pages: list[int] | None = Field(default=None, max_length=5000)
    scope: Literal["unrecognized", "all"] | None = None
    # 说明书 6.3：批量识别"已有识别结果的页面默认跳过"（界面上有勾选框）
    skip_recognized: bool = True
    dpi: int = Field(
        default=recognition.DEFAULT_DPI, ge=recognition.MIN_DPI, le=recognition.MAX_DPI
    )
    language: str = Field(default=recognition.DEFAULT_LANGUAGE, max_length=16)


class AuxiliaryJobRequest(BaseModel):
    """批量复核的范围：`pages` 与 `scope` 二选一（说明书 8.5）。

    范围里**只有已识别的页**：第二引擎读的是第一引擎切出的行图。
    """

    pages: list[int] | None = Field(default=None, max_length=5000)
    scope: Literal["unchecked", "all"] | None = None
    # 说明书 8.5："可以随时对已识别的页面单独补跑或重跑"——默认跳过已复核的
    skip_checked: bool = True


def _job_payload(request: Request, project_id: str, job: jobs_module.JobRecord) -> dict[str, Any]:
    supervisor = _supervisor(request)
    directory = _directory(request, project_id)
    items = jobs_module.list_job_items(directory, job.job_id)
    running_item = next(
        (item for item in items if item.status == jobs_module.ITEM_STATUS_RUNNING), None
    )
    return {
        "job": job.to_dict(),
        "items": [item.to_dict() for item in items],
        "failed_items": [
            item.to_dict()
            for item in items
            if item.status == jobs_module.ITEM_STATUS_FAILED
        ],
        # 子进程是否还活着：界面据此区分"正在跑"与"进程没了但状态没结算"
        "alive": supervisor.is_alive(job.job_id),
        "process_id": supervisor.process_id(job.job_id),
        "current_page_no": running_item.page_no if running_item else None,
        "log_path": f"logs/{executor_module.LOG_PREFIX}{job.job_id}.log",
    }


def _page_payloads(
    request: Request, project_id: str, page_ids: set[str]
) -> list[dict[str, object]]:
    library = _library(request)
    states = blocks_module.page_recognition_states(project_id, library=library)
    reviews = blocks_module.page_review_states(project_id, library=library)
    divergences = blocks_module.page_divergences(project_id, library=library)
    return [
        page_payload(
            page,
            states.get(page.page_id),
            reviews.get(page.page_id),
            divergences.get(page.page_id),
        )
        for page in project_library.list_pages(project_id, library=library)
        if page.page_id in page_ids
    ]


def _start_job(
    request: Request,
    project_id: str,
    job: jobs_module.JobRecord,
) -> dict[str, Any]:
    """建好的任务：起子进程，然后返回任务、单元与该任务涉及的页面。

    起不来就**别留一个永远排队的任务**——标失败、修好没结算的记录，再如实报错。
    """
    directory = _directory(request, project_id)
    supervisor = _supervisor(request)
    try:
        supervisor.start(directory, job.job_id)
    except jobs_module.JobError as exc:
        jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_FAILED)
        jobs_module.repair_unfinished(directory, message=str(exc), job_id=job.job_id)
        raise _job_error(exc, status=500) from exc

    payload = _job_payload(request, project_id, jobs_module.get_job(directory, job.job_id))
    return {
        "job": payload["job"],
        "items": payload["items"],
        "failed_items": payload["failed_items"],
        "pages": _page_payloads(
            request, project_id, {item["page_id"] for item in payload["items"]}
        ),
    }


@router.post("/{project_id}/jobs/ocr")
def start_ocr_job(request: Request, project_id: str, body: OcrJobRequest) -> dict[str, Any]:
    """建一个识别任务并立刻开始跑（说明书 6.3 的批量识别）。"""
    _require_main(request, project_id)
    library = _library(request)
    try:
        job = recognition.create_ocr_job(
            project_id,
            library=library,
            pages=body.pages,
            scope=body.scope,
            skip_recognized=body.skip_recognized,
            dpi=body.dpi,
            language=body.language,
        )
    except recognition.EngineUnavailable as exc:
        raise AppError(503, "ocr_engine_unavailable", "OCR 引擎不可用", detail=str(exc)) from exc
    except project_library.ProjectError as exc:
        status = 404 if not project_library.project_exists(project_id, library=library) else 400
        raise _project_error(exc, status=status) from exc

    return _start_job(request, project_id, job)


@router.post("/{project_id}/jobs/auxiliary")
def start_auxiliary_job(
    request: Request, project_id: str, body: AuxiliaryJobRequest
) -> dict[str, Any]:
    """建一个第二引擎复核任务并立刻开始跑（说明书 8.5 / R1b）。

    与识别任务共用一整套任务机制：进度、暂停 / 继续 / 取消、重试失败页、中断恢复。
    """
    _require_main(request, project_id)
    library = _library(request)
    try:
        job = recognition.create_auxiliary_job(
            project_id,
            library=library,
            pages=body.pages,
            scope=body.scope,
            skip_checked=body.skip_checked,
        )
    except recognition.EngineUnavailable as exc:
        # 说明书 8.6：第二引擎不可用时要明确说出来，不显示分歧标记、也不假装还在比对
        raise AppError(
            503, "secondary_engine_unavailable", "第二引擎不可用", detail=str(exc)
        ) from exc
    except project_library.ProjectError as exc:
        status = 404 if not project_library.project_exists(project_id, library=library) else 400
        raise _project_error(exc, status=status) from exc

    return _start_job(request, project_id, job)


@router.get("/{project_id}/jobs")
def list_jobs(
    request: Request,
    project_id: str,
    limit: int = Query(default=20, ge=1, le=MAX_JOB_LIST),
) -> dict[str, Any]:
    """最近的任务（说明书 7.3 的任务抽屉读取这里）。"""
    directory = _directory(request, project_id)
    supervisor = _supervisor(request)
    try:
        # 读之前先对账：子进程崩了而服务还活着时，状态必须立刻如实
        supervisor.reconcile(directory)
        found = jobs_module.list_jobs(directory, limit=limit)
        active = jobs_module.active_job(directory)
    except jobs_module.JobError as exc:
        status = 404 if not project_library.project_exists(project_id, library=_library(request)) else 400
        raise _job_error(exc, status=status) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc

    return {
        "count": len(found),
        "jobs": [job.to_dict() for job in found],
        "active": _job_payload(request, project_id, active) if active else None,
    }


@router.get("/{project_id}/jobs/{job_id}")
def get_job(request: Request, project_id: str, job_id: str) -> dict[str, Any]:
    """一个任务及其全部单元——界面就靠它轮询进度。"""
    directory = _directory(request, project_id)
    supervisor = _supervisor(request)
    try:
        supervisor.reconcile(directory)
        job = jobs_module.get_job(directory, job_id)
    except jobs_module.JobError as exc:
        status = 404 if not project_library.project_exists(project_id, library=_library(request)) else 400
        raise _job_error(exc, status=status) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return _job_payload(request, project_id, job)


# ---------------------------------------------------------------- 任务控制
#
# 说明书 6.3："暂停（当前页完成后停止）、继续、取消；失败页可单独重试。
# 只显示技术上真实支持的操作。" 下面四个就是全部，界面只暴露这四个。


def _control(
    request: Request, project_id: str, job_id: str
) -> tuple[Path, executor_module.Supervisor]:
    """任务控制的前置：先对账。

    子进程崩了而状态还写着 `running` 时，直接按状态判断会给出误导性的回答
    （"任务正在运行中，不需要继续"）。任何操作之前先把状态弄真。
    """
    directory = _directory(request, project_id)
    supervisor = _supervisor(request)
    supervisor.reconcile(directory)
    return directory, supervisor


@router.post("/{project_id}/jobs/{job_id}/pause")
def pause_job(request: Request, project_id: str, job_id: str) -> dict[str, Any]:
    """暂停：写状态，子进程在**当前页做完之后**停下并原地等待。"""
    directory, _ = _control(request, project_id, job_id)
    try:
        job = jobs_module.set_status(
            directory,
            job_id,
            jobs_module.STATUS_PAUSED,
            expect=(jobs_module.STATUS_RUNNING, jobs_module.STATUS_QUEUED),
        )
    except jobs_module.JobError as exc:
        raise _job_error(exc) from exc
    return _job_payload(request, project_id, job)


@router.post("/{project_id}/jobs/{job_id}/resume")
def resume_job(request: Request, project_id: str, job_id: str) -> dict[str, Any]:
    """继续：暂停中的任务原地接着跑；已中断 / 失败的任务则只重做**没成功**的页。"""
    directory, supervisor = _control(request, project_id, job_id)
    try:
        job = jobs_module.get_job(directory, job_id)
        if job.status in (jobs_module.STATUS_RUNNING,):
            raise jobs_module.JobError("任务正在运行中，不需要继续")
        if job.status == jobs_module.STATUS_SUCCEEDED:
            raise jobs_module.JobError("任务已经完成，不需要继续")

        jobs_module.set_status(
            directory,
            job_id,
            jobs_module.STATUS_RUNNING,
            expect=(
                jobs_module.STATUS_PAUSED,
                jobs_module.STATUS_INTERRUPTED,
                jobs_module.STATUS_FAILED,
                jobs_module.STATUS_CANCELLED,
                jobs_module.STATUS_QUEUED,
            ),
        )
        if not supervisor.is_alive(job_id):
            # 子进程已经不在（中断 / 崩溃 / 服务重启过）：起一个新的接着做
            supervisor.start(directory, job_id)
        job = jobs_module.get_job(directory, job_id)
    except jobs_module.JobError as exc:
        raise _job_error(exc) from exc
    return _job_payload(request, project_id, job)


@router.post("/{project_id}/jobs/{job_id}/cancel")
def cancel_job(request: Request, project_id: str, job_id: str) -> dict[str, Any]:
    """取消：先写状态（子进程可能自己看到就收工），再终止，最后修理没结算的记录。

    顺序很重要——`stop()` 返回之后才修理，才不会和还活着的子进程抢着写同一条记录。
    已经认完的页**保留**：取消不等于回滚。
    """
    directory, supervisor = _control(request, project_id, job_id)
    try:
        jobs_module.set_status(
            directory,
            job_id,
            jobs_module.STATUS_CANCELLED,
            expect=jobs_module.ACTIVE_STATUSES,
        )
        supervisor.stop(job_id)
        jobs_module.repair_unfinished(
            directory, message="任务已取消（当前页已中止，可继续或重试失败页）", job_id=job_id
        )
    except jobs_module.JobError as exc:
        raise _job_error(exc) from exc
    return _job_payload(request, project_id, jobs_module.get_job(directory, job_id))


@router.post("/{project_id}/jobs/{job_id}/retry-failed")
def retry_failed(request: Request, project_id: str, job_id: str) -> dict[str, Any]:
    """重试失败页：把失败的单元退回排队，然后起一个子进程只做这些页。"""
    directory, supervisor = _control(request, project_id, job_id)
    try:
        job = jobs_module.get_job(directory, job_id)
        if job.is_active and supervisor.is_alive(job_id):
            raise jobs_module.JobError("任务还在跑，先暂停或取消它再重试失败页")
        if job.failed == 0:
            raise jobs_module.JobError("这个任务没有失败的页")

        retried = jobs_module.reset_failed_items(directory, job_id)
        jobs_module.set_status(
            directory,
            job_id,
            jobs_module.STATUS_RUNNING,
            expect=jobs_module.TERMINAL_STATUSES + (jobs_module.STATUS_PAUSED, jobs_module.STATUS_QUEUED),
        )
        supervisor.stop(job_id)  # 清掉可能残留的注册项（进程已死）
        supervisor.start(directory, job_id)
        job = jobs_module.get_job(directory, job_id)
    except jobs_module.JobError as exc:
        raise _job_error(exc) from exc
    return {
        "retried": retried,
        **_job_payload(request, project_id, job),
    }
