"""识别任务接口（说明书第 11 节的「识别任务」一组）。

**当前形态：同步执行、一次一页。** 说明书 Phase 2 要的是子进程执行器
（任务抽屉、暂停 / 继续 / 取消 / 重试失败页、断点续跑），那是下一步；
这一步先把"识别 → 落库 → 重启还在"这条链路打通：接口返回时这一页已经认完，
`job` / `job_item` / `ocr_run` / `block` / `block_line` 五张表都已经写好。

因此这里的接口形状按说明书写对，行为上先限制单页——同步识别一整本书会让
HTTP 请求挂上几小时，不如明确拒绝。换成执行器时，接口不变，只是立即返回排队中的任务
（见 `docs/decisions.md` D-022）。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from ..core.project import blocks as blocks_module
from ..core.project import library as project_library
from ..core.project import recognition
from .deps import library_dir as _library
from .deps import page_payload, project_error as _project_error
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["jobs"])

# 一次请求能识别的页数上限。同步执行下只允许 1 页（说明书 Phase 2 的执行器尚未实现）
MAX_PAGES_PER_REQUEST = 1
MAX_JOB_LIST = 50


class OcrJobRequest(BaseModel):
    pages: list[int] = Field(default_factory=list, max_length=1000)
    dpi: int = Field(
        default=recognition.DEFAULT_DPI, ge=recognition.MIN_DPI, le=recognition.MAX_DPI
    )
    language: str = Field(default=recognition.DEFAULT_LANGUAGE, max_length=16)


def _page_payloads(
    request: Request, project_id: str, page_nos: list[int]
) -> list[dict[str, object]]:
    library = _library(request)
    states = blocks_module.page_recognition_states(project_id, library=library)
    wanted = set(page_nos)
    return [
        page_payload(page, states.get(page.page_id))
        for page in project_library.list_pages(project_id, library=library)
        if page.page_no in wanted
    ]


@router.post("/{project_id}/jobs/ocr")
def start_ocr_job(request: Request, project_id: str, body: OcrJobRequest) -> dict[str, Any]:
    """识别指定的页面并落库（说明书 5.4 的 R1 / R2）。

    返回这次任务、它的每个单元（一页一个），以及这些页面的最新识别状态。
    失败**不抛 HTTP 错误**：任务已经建好、失败原因记在 `job_item.error_message`
    与 `ocr_run.error_message` 里，界面按任务结果显示（说明书 Phase 2 的验收
    "失败原因可见"）。
    """
    if not body.pages:
        raise AppError(
            400, "no_pages", "没有指定要识别的页面", detail="请在 pages 里给出页码，如 [3]"
        )
    if len(body.pages) > MAX_PAGES_PER_REQUEST:
        raise AppError(
            400,
            "batch_not_implemented",
            "一次只能识别一页",
            detail=(
                f"收到 {len(body.pages)} 页。批量识别需要任务执行器（说明书 Phase 2），"
                "尚未实现；见 docs/known-limitations.md"
            ),
        )

    library = _library(request)
    try:
        outcome = recognition.recognize_pages(
            project_id,
            body.pages,
            library=library,
            dpi=body.dpi,
            language=body.language,
        )
    except recognition.EngineUnavailable as exc:
        raise AppError(
            503,
            "ocr_engine_unavailable",
            "OCR 引擎不可用",
            detail=str(exc),
        ) from exc
    except project_library.ProjectError as exc:
        # 项目压根不在 → 404；项目在、但这一页不能识别 → 400
        status = 404 if not project_library.project_exists(project_id, library=library) else 400
        raise _project_error(exc, status=status) from exc

    return {
        "job": outcome.job.to_dict(),
        "items": [item.to_dict() for item in outcome.items],
        "pages": _page_payloads(request, project_id, body.pages),
    }


@router.get("/{project_id}/jobs")
def list_jobs(
    request: Request, project_id: str, limit: int = Query(default=20, ge=1, le=MAX_JOB_LIST)
) -> dict[str, Any]:
    """最近的任务列表（说明书 7.4 的任务抽屉读取这里）。"""
    library = _library(request)
    try:
        jobs = blocks_module.list_jobs(project_id, library=library, limit=limit)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"count": len(jobs), "jobs": [job.to_dict() for job in jobs]}


@router.get("/{project_id}/jobs/{job_id}")
def get_job(request: Request, project_id: str, job_id: str) -> dict[str, Any]:
    """一个任务及其全部单元。"""
    library = _library(request)
    try:
        job = blocks_module.get_job(project_id, job_id, library=library)
        items = blocks_module.list_job_items(project_id, job_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"job": job.to_dict(), "items": [item.to_dict() for item in items]}
