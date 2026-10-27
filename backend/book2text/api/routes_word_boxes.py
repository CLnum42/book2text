"""字框回填接口（任务 59）：只写 `block_line.word_boxes`。

- `GET  /projects/{id}/word-boxes`：要回填多少页 / 行、预计多久、当前覆盖率；
- `POST /projects/{id}/word-boxes/backfill`：分批回填（`limit` 页），可续跑；
- `POST /projects/{id}/word-boxes/clear`：撤销（把字框置空）。

接口**不碰**其它字段：文本、第二引擎、分歧裁决、跨页延续、版心都由各自的接口管。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..core.project import library as project_library
from ..core.project import word_boxes as word_boxes_module
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["word-boxes"])


class BackfillRequest(BaseModel):
    pages: list[int] | None = Field(default=None, max_length=5000)
    limit: int | None = Field(default=None, ge=1, le=200)


@router.get("/{project_id}/word-boxes")
def get_word_boxes(request: Request, project_id: str) -> dict[str, Any]:
    """回填计划 + 覆盖率（只读）。"""
    try:
        plan = word_boxes_module.analyze(project_id, library=_library(request))
        cov = word_boxes_module.coverage(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"ok": True, **plan, "coverage": cov}


@router.post("/{project_id}/word-boxes/backfill")
def post_backfill(
    request: Request, project_id: str, body: BackfillRequest
) -> dict[str, Any]:
    """回填一批（默认不限页数；界面按 limit 分批调，进度真实）。"""
    _require_main(request, project_id)
    try:
        result = word_boxes_module.backfill(
            project_id,
            library=_library(request),
            pages=body.pages,
            limit=body.limit,
        )
        coverage = word_boxes_module.coverage(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    except Exception as exc:  # noqa: BLE001 - 引擎崩溃 / 渲染失败都要说清
        raise AppError(500, "word_boxes_failed", "字框回填失败", detail=str(exc)) from exc
    return {"ok": True, **result, "coverage": coverage}


@router.post("/{project_id}/word-boxes/clear")
def post_clear(request: Request, project_id: str) -> dict[str, Any]:
    """撤销回填：只有字框被清掉，其它字段本来就没动过。"""
    _require_main(request, project_id)
    try:
        return {"ok": True, **word_boxes_module.clear(project_id, library=_library(request))}
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


__all__ = ["router"]
