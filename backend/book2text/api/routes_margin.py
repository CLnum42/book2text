"""版心接口（任务 50）：推算建议、项目级默认、页级四态、每页拟合、批量。

任务 33 起页级拟合结果**真正落库**（``page.margin_box`` + ``margin_box_method``），
界面、导出、审计读同一份。导出只有打开「按版心判定」才读它；开关默认关，
关着时导出与升级前逐字节相同。

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


class MarginFitAllRequest(BaseModel):
    """全部自动拟合（任务 36B 起支持"只补没拟合的页"）。

    - ``only_missing``：只动 ``mode=auto`` 且 ``margin_box`` 还是 NULL 的页；
      ``custom`` / ``none`` / ``inherit`` 一律不动。界面进「版心确认」时用它，
      打开就是拟合好的，同时绝不覆盖用户拖过的框。
    - ``limit``：一次最多处理多少页（界面分批调用，给出真实进度）。``None`` = 全部。
    """

    only_missing: bool = False
    limit: int | None = Field(default=None, ge=1, le=500)


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


@router.post("/{project_id}/pages/{page_no}/margin-box/fit")
def fit_page_margin_box(
    request: Request, project_id: str, page_no: int
) -> dict[str, Any]:
    """用这一页的检测行拟合并写入页级版心（只对 auto / inherit 有效）。"""
    _require_main(request, project_id)
    try:
        return margin_box_module.fit_page_margin(
            project_id, page_no, library=_library(request)
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.post("/{project_id}/margin-box/fit-all")
def fit_all_margin_boxes(
    request: Request, project_id: str, body: MarginFitAllRequest | None = None
) -> dict[str, Any]:
    """把 inherit / auto 的页全部改为每页自动拟合；custom / none 不动。

    带 body 时支持只补未拟合的页（``only_missing``）与分批（``limit``）；
    不带 body 与旧行为完全一致。
    """
    _require_main(request, project_id)
    only_missing = bool(body and body.only_missing)
    limit = body.limit if body else None
    try:
        return margin_box_module.fit_all_pages(
            project_id,
            library=_library(request),
            only_missing=only_missing,
            limit=limit,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.get("/{project_id}/pages/{page_no}/margin-box/audit")
def audit_page_margin(
    request: Request, project_id: str, page_no: int
) -> dict[str, Any]:
    """这一页有多少正文长行落在自己的版心外（可疑提示用）。"""
    try:
        return margin_box_module.page_margin_audit(
            project_id, page_no, library=_library(request)
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


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
