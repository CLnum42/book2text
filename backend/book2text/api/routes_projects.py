"""项目接口（说明书第 6.1 / 7.2 节）。

与 Phase 0 的 `/api/scratch/*` 不同，这一组是**正式的、有持久化的**接口：
项目落在项目库目录里，关了应用再打开还在。

项目库目录由启动入口决定（`--library`，缺省为用户"文稿 / 文档"下的 Book2Text），
挂在 `app.state.library_dir` 上。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, Field

from ..core.pdf import render
from ..core.project import library as project_library
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _library(request: Request) -> Path:
    library = getattr(request.app.state, "library_dir", None)
    if library is None:  # pragma: no cover - 装配错误
        raise AppError(500, "server_not_ready", "服务未正确初始化（缺少项目库目录）")
    return Path(library)


def _project_error(exc: project_library.ProjectError, *, status: int = 400) -> AppError:
    return AppError(status, "project_error", "项目操作失败", detail=str(exc))


# ---------------------------------------------------------------- 项目库

@router.get("")
def list_projects(request: Request) -> dict[str, Any]:
    """项目库列表（说明书 7.2）。所有数字来自项目数据库的实时统计。"""
    library = _library(request)
    summaries = project_library.list_projects(library=library)
    return {
        "library_dir": str(library),
        "count": len(summaries),
        "projects": [summary.to_dict() for summary in summaries],
    }


@router.post("")
async def create_project(
    request: Request,
    name: str = Query(default="", max_length=200),
    filename: str = Query(default="upload.pdf"),
) -> dict[str, Any]:
    """新建项目：上传 PDF → 复制进项目文件夹 → 读元数据 → 检测文本层（说明书 6.1）。

    用原始请求体流式上传（说明书 4.5），不把整个文件读进内存。
    """
    library = _library(request)
    safe_name = Path(filename.replace("\\", "/")).name.strip() or "upload.pdf"

    try:
        result = await project_library.create_project(
            name=name,
            original_name=safe_name,
            chunks=request.stream(),
            library=library,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    return {
        "project": result.project.to_dict(),
        "text_layer_hint": result.text_layer_hint,
        "pages_with_text_layer": result.pages_with_text_layer,
    }


@router.get("/{project_id}")
def get_project(request: Request, project_id: str) -> dict[str, Any]:
    library = _library(request)
    try:
        project = project_library.load_project(project_id, library=library)
        pages = project_library.list_pages(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc

    return {
        "project": project.to_dict(),
        "pages": [page.to_dict() for page in pages],
    }


@router.post("/{project_id}/open")
def open_project(
    request: Request,
    project_id: str,
    force: bool = Query(default=False),
    read_only: bool = Query(default=False),
) -> dict[str, Any]:
    """打开项目：上锁 + 自动备份（说明书 6.1 / 7.6）。"""
    library = _library(request)
    try:
        result = project_library.open_project(
            project_id, library=library, force=force, read_only=read_only
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    return result.to_dict()


@router.post("/{project_id}/close")
def close_project(request: Request, project_id: str) -> dict[str, Any]:
    library = _library(request)
    try:
        released = project_library.close_project(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"ok": True, "lock_released": released}


# ---------------------------------------------------------------- 页面

@router.get("/{project_id}/pages")
def list_pages(request: Request, project_id: str) -> dict[str, Any]:
    library = _library(request)
    try:
        pages = project_library.list_pages(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"count": len(pages), "pages": [page.to_dict() for page in pages]}


class PagePatch(BaseModel):
    page_type: str | None = None
    include: bool | None = None
    note: str | None = Field(default=None, max_length=500)


@router.patch("/{project_id}/pages/{page_id}")
def patch_page(request: Request, project_id: str, page_id: str, patch: PagePatch) -> dict:
    """更新单页的类型 / 纳入 / 备注（说明书 6.2）。"""
    library = _library(request)
    try:
        page = project_library.update_page(
            project_id,
            page_id,
            library=library,
            page_type=patch.page_type,
            include=patch.include,
            note=patch.note,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return page.to_dict()


@router.get("/{project_id}/pages/{page_no}/image")
def page_image(
    request: Request,
    project_id: str,
    page_no: int,
    size: str = Query(default="thumb"),
) -> Response:
    """渲染项目里某一页的图像。

    说明书 6.1 要求缩略图由后台 Job 生成并缓存到 `cache/thumbs/`；
    **Job 属于 Phase 2，尚未实现**，因此这里按需渲染（不写缓存）。
    """
    library = _library(request)
    if size not in render.RENDER_PROFILES:
        raise AppError(
            400, "unknown_profile", "未知的渲染档位",
            detail=f"可选：{', '.join(sorted(render.RENDER_PROFILES))}",
        )

    try:
        project = project_library.load_project(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc

    if project.directory is None:  # pragma: no cover
        raise AppError(500, "project_error", "项目缺少目录信息")

    source = project.directory / project_library.SOURCE_DIR_NAME / project_library.SOURCE_FILE_NAME
    try:
        png = render.render_page_png(source, page_no - 1, profile=size)
    except render.PdfError as exc:
        raise AppError(400, "render_failed", "无法渲染该页", str(exc)) from exc

    return Response(content=png, media_type="image/png", headers={"Cache-Control": "private, max-age=300"})


class LastViewPatch(BaseModel):
    view: Literal["library", "pages", "review", "structure", "export"] | None = None
    page_id: str | None = None


@router.put("/{project_id}/position")
def save_position(request: Request, project_id: str, patch: LastViewPatch) -> dict[str, Any]:
    """记录上次位置（说明书 7.2："继续"回到上次的视图与页面）。"""
    library = _library(request)
    try:
        project_library.update_last_view(
            project_id, library=library, view=patch.view, page_id=patch.page_id
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"ok": True}
