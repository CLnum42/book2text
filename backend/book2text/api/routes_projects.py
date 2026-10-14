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
from ..core.project import blocks as blocks_module
from ..core.project import library as project_library
from .deps import library_dir as _library
from .deps import page_payload, project_error as _project_error
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _page_payloads(request: Request, project_id: str, pages) -> list[dict[str, object]]:
    """给页面附上识别状态（一次查询取回所有页的状态，不做 N+1）。"""
    states = blocks_module.page_recognition_states(project_id, library=_library(request))
    return [page_payload(page, states.get(page.page_id)) for page in pages]


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
        payloads = _page_payloads(request, project_id, pages)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc

    return {
        "project": project.to_dict(),
        "pages": payloads,
    }


@router.post("/{project_id}/open")
def open_project(
    request: Request,
    project_id: str,
    force: bool = Query(default=False),
    read_only: bool = Query(default=False),
) -> dict[str, Any]:
    """打开项目：上锁 + 自动备份 + 清理中断的任务（说明书 6.1 / 7.6 / 5.3）。

    清理时要避开**本进程正在跑的任务**：它们不是中断，而是真的在跑
    （用户可以关掉项目再打开，任务照跑）。
    """
    library = _library(request)
    supervisor = getattr(request.app.state, "job_supervisor", None)
    try:
        directory = project_library.project_dir(library, project_id)
        keep = supervisor.running_job_ids_for(directory) if supervisor else set()
        result = project_library.open_project(
            project_id,
            library=library,
            force=force,
            read_only=read_only,
            keep_job_ids=keep,
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
        payloads = _page_payloads(request, project_id, pages)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"count": len(payloads), "pages": payloads}


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


class PagesPatch(BaseModel):
    """批量设置页面类型 / 纳入（说明书第 11 节的 `PATCH /projects/{id}/pages`）。"""

    page_ids: list[str] = Field(default_factory=list, max_length=5000)
    page_type: str | None = None
    include: bool | None = None


@router.patch("/{project_id}/pages")
def patch_pages(
    request: Request, project_id: str, patch: PagesPatch
) -> dict[str, Any]:
    """批量更新页面的类型 / 纳入（说明书 6.2 的批量操作）。

    整批一个事务：批次里有一个页面 id 不存在就整批拒绝，界面上不会出现"改了一半"。
    """
    library = _library(request)
    try:
        updated = project_library.update_pages(
            project_id,
            patch.page_ids,
            library=library,
            page_type=patch.page_type,
            include=patch.include,
        )
        states = blocks_module.page_recognition_states(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {
        "updated": len(updated),
        "pages": [page_payload(page, states.get(page.page_id)) for page in updated],
    }


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


# ---------------------------------------------------------------- 块与识别记录

def _block_dict(
    block: blocks_module.BlockRecord,
    lines: list[blocks_module.BlockLineRecord],
) -> dict[str, object]:
    return {
        **block.to_dict(),
        "lines": [line.to_dict() for line in lines],
    }


@router.get("/{project_id}/pages/{page_no}/blocks")
def list_page_blocks(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """某一页当前有效的块与块内行（说明书第 11 节的 `GET .../pages/{pid}/blocks`）。

    同时返回该页的运行记录与推导出的识别状态：界面要显示"这是哪个引擎认的、
    什么时候认的、有没有待选的新结果"，这些都不该由客户端自己拼。
    """
    library = _library(request)
    try:
        page, runs, blocks, lines = blocks_module.load_page_content(
            project_id, page_no, library=library
        )
        states = blocks_module.page_recognition_states(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc

    by_block: dict[str, list[blocks_module.BlockLineRecord]] = {}
    for line in lines:
        by_block.setdefault(line.block_id, []).append(line)

    state = states.get(page.page_id)
    active_run_id = state.active_run_id if state else None
    active = next((run for run in runs if run.run_id == active_run_id), None)
    return {
        "page": page_payload(page, state),
        "runs": [run.to_dict() for run in runs],
        "active_run": active.to_dict() if active else None,
        "block_count": len(blocks),
        "blocks": [_block_dict(block, by_block.get(block.block_id, [])) for block in blocks],
    }


@router.get("/{project_id}/pages/{page_no}/runs")
def list_page_runs(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """某一页的识别运行记录（说明书第 11 节的 `GET .../pages/{pid}/runs`）。"""
    library = _library(request)
    try:
        runs = blocks_module.list_runs(project_id, library=library, page_no=page_no)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"count": len(runs), "runs": [run.to_dict() for run in runs]}
