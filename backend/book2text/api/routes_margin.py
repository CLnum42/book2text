"""版心接口（任务 50）：推算建议、项目级默认、页级三态、批量。

这一组**不改变任何导出结果**：写入的只是 `project.margin_box` 与
`page.margin_box(_mode)`，导出 / 组装 / 识别都不读它们。

读接口对审校包也开放（助手的项目是只读快照）；写接口只允许主项目。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..core.project import library as project_library
from ..core.project import margin_box as margin_box_module
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["margin-box"])


def _bad_request(exc: margin_box_module.MarginBoxError) -> AppError:
    return AppError(400, "bad_margin_box", "版心参数不合法", detail=str(exc))


class MarginBoxPut(BaseModel):
    """项目级默认版心；``null`` 表示清空。"""

    margin_box: list[float] | None = None


class PageMarginBoxPatch(BaseModel):
    """一页的版心三态；`custom` 时必须带四边。"""

    margin_box_mode: str
    margin_box: list[float] | None = None


class BatchMarginBoxPatch(BaseModel):
    """批量设置：选中页统一改三态（custom 时四边相同）。"""

    page_nos: list[int] = Field(default_factory=list, max_length=5000)
    margin_box_mode: str
    margin_box: list[float] | None = None


@router.get("/{project_id}/margin-box")
def get_margin_box(request: Request, project_id: str) -> dict[str, Any]:
    """项目版心概览：默认四边、三态计数、非默认页。"""
    try:
        return margin_box_module.margin_box_state(
            project_id, library=_library(request)
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.get("/{project_id}/margin-box/suggestion")
def get_margin_suggestion(request: Request, project_id: str) -> dict[str, Any]:
    """从已有 `block_line` 跨页推算版心。**只读，不写库**（返回里也不带任何写操作）。"""
    library = _library(request)
    try:
        suggestion = margin_box_module.suggest_margin_box(project_id, library=library)
        state = margin_box_module.margin_box_state(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"suggestion": suggestion.to_dict(), "current": state}


@router.put("/{project_id}/margin-box")
def put_margin_box(
    request: Request, project_id: str, body: MarginBoxPut
) -> dict[str, Any]:
    """设置 / 清空项目级默认版心。只影响「沿用全局」的页。"""
    _require_main(request, project_id)
    library = _library(request)
    try:
        project = margin_box_module.set_project_margin_box(
            project_id, body.margin_box, library=library
        )
        state = margin_box_module.margin_box_state(project_id, library=library)
    except margin_box_module.MarginBoxError as exc:
        raise _bad_request(exc) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"project": project.to_dict(), "margin_box": state}


@router.patch("/{project_id}/pages/{page_no}/margin-box")
def patch_page_margin_box(
    request: Request, project_id: str, page_no: int, body: PageMarginBoxPatch
) -> dict[str, Any]:
    """设置一页的版心三态（沿用全局 / 本页自定义 / 不适用）。"""
    _require_main(request, project_id)
    try:
        page = margin_box_module.set_page_margin_box(
            project_id,
            page_no,
            body.margin_box_mode,
            body.margin_box,
            library=_library(request),
        )
    except margin_box_module.MarginBoxError as exc:
        raise _bad_request(exc) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"page": page.to_dict()}


@router.patch("/{project_id}/margin-box/pages")
def patch_pages_margin_box(
    request: Request, project_id: str, body: BatchMarginBoxPatch
) -> dict[str, Any]:
    """批量设置版心三态（整批一个事务）。

    路径放在 `/margin-box/pages` 而不是 `/pages/margin-box`：后者会被
    项目路由的 `PATCH /pages/{page_id}` 先匹配走（`page_id` 吃掉 "margin-box"）。
    """
    _require_main(request, project_id)
    try:
        pages = margin_box_module.set_pages_margin_box(
            project_id,
            body.page_nos,
            body.margin_box_mode,
            body.margin_box,
            library=_library(request),
        )
    except margin_box_module.MarginBoxError as exc:
        raise _bad_request(exc) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"updated": len(pages), "pages": [page.to_dict() for page in pages]}
