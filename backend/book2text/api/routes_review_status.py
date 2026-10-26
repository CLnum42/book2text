"""审校「待处理」与自动通过接口（任务 61 / 工作流阶段 9）。

- `GET  /review/pending`：页面视图的待处理页清单与理由计数；
- `GET  /review/auto-passed`：自动通过的页清单（可抽查 / 单页撤销）；
- `GET  /pages/{n}/auto-pass`：这一页能不能自动通过、卡在哪；
- `POST /pages/{n}/auto-pass`：满足全部条件才写状态；
- `POST /pages/{n}/auto-pass/revoke`：撤销自动通过。

**所有接口都不改块文本 / 类型 / 框。**
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..core.project import library as project_library
from ..core.project import review_status
from ..core.project import workflow as workflow_module
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["review-status"])



def _review_error(exc: Exception) -> AppError:
    return AppError(400, "review_status_error", "审校状态操作失败", detail=str(exc))


@router.get("/{project_id}/review/pending")
def get_pending(request: Request, project_id: str) -> dict[str, Any]:
    _require_main(request, project_id)
    try:
        return review_status.project_pending(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.get("/{project_id}/review/auto-passed")
def get_auto_passed(request: Request, project_id: str) -> dict[str, Any]:
    _require_main(request, project_id)
    try:
        data = workflow_module.project_workflow(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    pages = [
        {
            "page_no": item["page_no"],
            "page_id": item["page_id"],
            "confirmed_at": item["confirmed_at"],
            "stage_label": item["stage_label"],
        }
        for item in data["pages"]
        if item["confirm_mode"] == workflow_module.CONFIRM_AUTO
    ]
    return {"count": len(pages), "pages": pages}


@router.get("/{project_id}/pages/{page_no}/auto-pass")
def check_auto_pass(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    _require_main(request, project_id)
    try:
        return review_status.evaluate_page(project_id, page_no, library=_library(request))
    except (project_library.ProjectError, workflow_module.WorkflowError) as exc:
        raise _review_error(exc) from exc


@router.post("/{project_id}/pages/{page_no}/auto-pass")
def run_auto_pass(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    _require_main(request, project_id)
    try:
        result = review_status.auto_pass_page(project_id, page_no, library=_library(request))
    except (project_library.ProjectError, workflow_module.WorkflowError) as exc:
        raise _review_error(exc) from exc
    if not result.get("applied"):
        raise AppError(
            409,
            "auto_pass_not_eligible",
            "这一页还不满足自动通过条件",
            detail="；".join(reason["label"] for reason in result.get("reasons", [])),
        )
    return result


@router.post("/{project_id}/pages/{page_no}/auto-pass/revoke")
def revoke_auto_pass(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    _require_main(request, project_id)
    try:
        return review_status.revoke_auto_pass(project_id, page_no, library=_library(request))
    except (project_library.ProjectError, workflow_module.WorkflowError) as exc:
        raise _review_error(exc) from exc


__all__ = ["router"]


class AutoPassBatchRequest(BaseModel):
    page_numbers: list[int] = Field(min_length=1, max_length=5000)


@router.get("/{project_id}/review/finish-summary")
def get_finish_summary(request: Request, project_id: str) -> dict[str, Any]:
    """收尾面板的六个状态（实时聚合；不写任何东西）。"""
    _require_main(request, project_id)
    try:
        return review_status.finish_summary(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.post("/{project_id}/review/auto-pass")
def run_auto_pass_batch(
    request: Request, project_id: str, body: AutoPassBatchRequest
) -> dict[str, Any]:
    """批量自动通过：逐页重算条件，只有满足的才写状态；不改任何块。"""
    _require_main(request, project_id)
    applied: list[int] = []
    skipped: list[dict[str, Any]] = []
    for page_no in sorted(set(body.page_numbers)):
        try:
            result = review_status.auto_pass_page(
                project_id, page_no, library=_library(request)
            )
        except (project_library.ProjectError, workflow_module.WorkflowError) as exc:
            skipped.append({"page_no": page_no, "reason": str(exc)})
            continue
        if result.get("applied"):
            applied.append(page_no)
        else:
            skipped.append(
                {
                    "page_no": page_no,
                    "reasons": [item.get("label") for item in result.get("reasons", [])],
                }
            )
    return {"applied": applied, "applied_count": len(applied), "skipped": skipped}


@router.post("/{project_id}/review/auto-pass/revoke")
def revoke_auto_pass_batch(
    request: Request, project_id: str, body: AutoPassBatchRequest
) -> dict[str, Any]:
    """整批撤销自动通过（只撤 auto，人工确认不动）。"""
    _require_main(request, project_id)
    revoked: list[int] = []
    skipped: list[dict[str, Any]] = []
    for page_no in sorted(set(body.page_numbers)):
        try:
            review_status.revoke_auto_pass(project_id, page_no, library=_library(request))
            revoked.append(page_no)
        except (project_library.ProjectError, workflow_module.WorkflowError) as exc:
            skipped.append({"page_no": page_no, "reason": str(exc)})
    return {"revoked": revoked, "revoked_count": len(revoked), "skipped": skipped}
