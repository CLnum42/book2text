"""项目接口（说明书第 6.1 / 7.2 节）。

这一组是**正式接口**：项目落在项目库目录里，关了应用再打开还在。

项目库目录由启动入口决定（`--library`，缺省为用户"文稿 / 文档"下的 Book2Text），
挂在 `app.state.library_dir` 上。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, Field

from ..core.pdf import render
from ..core.collab import assignments as assignments_module
from ..core.project import blocks as blocks_module
from ..core.project import library as project_library
from ..core.project import margin_box as margin_box_module
from ..core.project import page_setup as page_setup_module
from ..core.project import stats as stats_module
from ..core.project import workflow as workflow_module
from .deps import library_dir as _library
from .deps import page_payload, project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _page_payloads(request: Request, project_id: str, pages) -> list[dict[str, object]]:
    """给页面附上识别状态、审校进度与分歧概况（各一次聚合查询，不做 N+1）。"""
    library = _library(request)
    states = blocks_module.page_recognition_states(project_id, library=library)
    reviews = blocks_module.page_review_states(project_id, library=library)
    divergences = blocks_module.page_divergences(project_id, library=library)
    occupied = assignments_module.page_assignment_map(project_id, library=library)
    layout_lines = _layout_line_counts(request, project_id)
    text_lines = _text_line_counts(request, project_id)
    return [
        page_payload(
            page,
            states.get(page.page_id),
            reviews.get(page.page_id),
            divergences.get(page.page_id),
            _assignment_brief(occupied.get(page.page_id), page.page_id),
            layout_lines.get(page.page_id, 0),
            text_lines.get(page.page_id, 0),
        )
        for page in pages
    ]


def _layout_line_counts(request: Request, project_id: str) -> dict[str, int]:
    """每页检测行数；老库没有检测表时按"还没检测"处理，不让页面接口挂掉。"""
    try:
        return workflow_module.layout_line_counts(project_id, library=_library(request))
    except Exception:  # noqa: BLE001 - 检测表缺失只是少一个提示，页面本身还要能看
        return {}


def _text_line_counts(request: Request, project_id: str) -> dict[str, int]:
    """每页识别行数（刀 1：版心可以回退 OCR 行拟合）。"""
    try:
        return workflow_module.text_line_counts(project_id, library=_library(request))
    except Exception:  # noqa: BLE001 - 只影响"有没有行可拟合"的提示
        return {}


def _assignment_brief(assignment, page_id: str) -> dict[str, object] | None:
    """页面载荷里的分派摘要（谁在审、是不是上下文页）。"""
    if assignment is None:
        return None
    return {
        "assignment_id": assignment.assignment_id,
        "reviewer_name": assignment.reviewer_name,
        "status": assignment.status,
        "status_label": assignments_module.STATUS_LABELS.get(
            assignment.status, assignment.status
        ),
        "is_context": page_id in assignment.context_page_ids,
    }


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


@router.get("/{project_id}/summary")
def get_summary(request: Request, project_id: str) -> dict[str, Any]:
    """项目摘要与质量统计（说明书第 11 节的「摘要」+ 8.5 / 13.4 的质量指标）。

    **不写任何东西**，所有数字都是实时聚合。产品里算不出来的指标
    （CER/WER、捕获率、一致但都错……）在 `not_measured` 里如实列出并写明原因，
    不假装算过。
    """
    try:
        summary = stats_module.project_summary(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return summary.to_dict()


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
    except project_library.ProjectLocked as exc:
        # 锁挡住打开：带上结构化信息，界面才能说清"谁在写、锁是不是已经过期"，
        # 而不是只给一句"项目操作失败"。仍按 400（不是删除那条 409 路径）。
        lock_detail = exc.status.detail()
        lock_detail["project_id"] = project_id
        raise AppError(
            400,
            "project_lock_expired" if exc.expired else "project_busy",
            "这个项目暂时打不开",
            detail=str(exc),
            data={"lock": lock_detail},
        ) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    payload = result.to_dict()
    # 任务 53：升级前就识别过的项目没有"识别收尾时自动推算"那次机会。
    # 打开主项目时补一次（只补没存过建议的；手动版心不会被覆盖）。
    # 推算失败只当没补：打开项目不能因为一个显示用的框而失败。
    if not result.read_only and result.project.kind == "main":
        try:
            updated = margin_box_module.ensure_margin_suggestion(
                project_id, library=library
            )
        except Exception:  # noqa: BLE001 - 见上
            updated = None
        if updated:
            payload["project"] = project_library.load_project(
                project_id, library=library
            ).to_dict()
        # 任务 58：给没有工作流状态行的页面补初始状态（只插不改）。
        # 回填失败只当没补：打开项目不能因为一个索引表而失败。
        try:
            workflow_module.backfill_project(project_id, library=library)
        except Exception:  # noqa: BLE001 - 见上
            pass
    return payload


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
    # 只为**明确拒绝**保留：include 是 page_type 的派生值（body → 1，其余 → 0），
    # 不能再从界面 / API 单独设置。字段留着是为了给旧客户端一个清楚的 400，
    # 而不是被 pydantic 静默忽略。
    include: bool | None = None
    note: str | None = Field(default=None, max_length=500)


def _reject_include(include: bool | None) -> None:
    if include is not None:
        raise AppError(
            400,
            "include_is_derived",
            "include 是派生字段，不能单独设置",
            detail="page.include 由页面类型决定：body → 1，其余 → 0。改 page_type 即可。",
        )


@router.patch("/{project_id}/pages/{page_id}")
def patch_page(request: Request, project_id: str, page_id: str, patch: PagePatch) -> dict:
    """更新单页的类型 / 备注（说明书 6.2）；`include` 由类型派生，不接受。"""
    _reject_include(patch.include)
    library = _library(request)
    try:
        page = project_library.update_page(
            project_id,
            page_id,
            library=library,
            page_type=patch.page_type,
            note=patch.note,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return page.to_dict()


class PagesPatch(BaseModel):
    """批量设置页面类型（说明书第 11 节的 `PATCH /projects/{id}/pages`）。"""

    page_ids: list[str] = Field(default_factory=list, max_length=5000)
    page_type: str | None = None
    include: bool | None = None


@router.patch("/{project_id}/pages")
def patch_pages(
    request: Request, project_id: str, patch: PagesPatch
) -> dict[str, Any]:
    """批量更新页面的类型（说明书 6.2 的批量操作）；`include` 由类型派生，不接受。

    整批一个事务：批次里有一个页面 id 不存在就整批拒绝，界面上不会出现"改了一半"。
    """
    _reject_include(patch.include)
    _require_main(request, project_id)
    library = _library(request)
    try:
        updated = project_library.update_pages(
            project_id,
            patch.page_ids,
            library=library,
            page_type=patch.page_type,
        )
        states = blocks_module.page_recognition_states(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    reviews = blocks_module.page_review_states(project_id, library=library)
    divergences = blocks_module.page_divergences(project_id, library=library)
    layout_lines = _layout_line_counts(request, project_id)
    text_lines = _text_line_counts(request, project_id)
    return {
        "updated": len(updated),
        "pages": [
            page_payload(
                page,
                states.get(page.page_id),
                reviews.get(page.page_id),
                divergences.get(page.page_id),
                None,
                layout_lines.get(page.page_id, 0),
                text_lines.get(page.page_id, 0),
            )
            for page in updated
        ],
    }


class ConfirmPagesRequest(BaseModel):
    page_ids: list[str] = Field(default_factory=list, max_length=5000)


def _setup_summary(pages) -> dict[str, int]:
    """页面确认的汇总（界面与接口共用同一口径）。

    五类各报各的，不把"正文排除"混进"已排除"：总数 = 五类之和，
    用户不会觉得页数丢了。
    """
    counts = {page_type: 0 for page_type in project_library.PAGE_TYPES}
    for page in pages:
        counts[page.page_type] = counts.get(page.page_type, 0) + 1
    body = counts["body"]
    return {
        "total": len(pages),
        "body": body,
        "body_excluded": counts["body_excluded"],
        "front": counts["front"],
        "toc": counts["toc"],
        "back": counts["back"],
        # 兼容旧字段：included 现在就是正文页数
        "included": body,
        "excluded": len(pages) - body,
        "confirmed": sum(1 for page in pages if page.page_confirmed),
        "unconfirmed": sum(1 for page in pages if not page.page_confirmed),
    }


@router.post("/{project_id}/pages/confirm")
def confirm_pages(
    request: Request, project_id: str, body: ConfirmPagesRequest
) -> dict[str, Any]:
    """把若干页标成「已确认」（类型是用户认可的）。

    只记状态，不拦识别：未确认页照样能识别，界面在识别前提示一次就走。
    """
    _require_main(request, project_id)
    library = _library(request)
    if not body.page_ids:
        raise AppError(400, "no_pages", "没有指定要确认的页面")
    try:
        updated = project_library.confirm_pages(
            project_id, body.page_ids, library=library
        )
        all_pages = project_library.list_pages(project_id, library=library)
        payloads = _page_payloads(request, project_id, updated)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {
        "confirmed": len(updated),
        "pages": payloads,
        "summary": _setup_summary(all_pages),
    }


@router.get("/{project_id}/pages/suggestions")
def page_suggestions(request: Request, project_id: str) -> dict[str, Any]:
    """页面类型的自动建议（只读）。规则见 `core/project/page_setup.py`：只给建议，不落库。"""
    _require_main(request, project_id)
    library = _library(request)
    try:
        result = page_setup_module.suggest_pages_for_project(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return result


@router.get("/{project_id}/pages/{page_no}/image")
def page_image(
    request: Request,
    project_id: str,
    page_no: int,
    size: str = Query(default="thumb"),
) -> Response:
    """渲染项目里某一页的图像。

    说明书 6.1 要求缩略图由后台 Job 生成并缓存到 `cache/thumbs/`；
    **缩略图缓存 Job 还没做（Phase 1 余项）**，因此这里按需渲染（不写缓存）。
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
    # **PDF 下标不一定等于 page_no - 1**：审校包项目的 PDF 是任务包里的子集
    # （说明书 6.7.2），每页记着自己的 `pdf_page_index`。主项目里它是空的，
    # 就退回 `page_no - 1`。
    try:
        page = next(
            item for item in project_library.list_pages(project_id, library=library)
            if item.page_no == page_no
        )
    except StopIteration:
        raise AppError(404, "page_not_found", f"没有第 {page_no} 页") from None
    index = page.pdf_page_index if page.pdf_page_index is not None else page_no - 1
    try:
        png = render.render_page_png(source, index, profile=size)
    except render.PdfError as exc:
        raise AppError(400, "render_failed", "无法渲染该页", str(exc)) from exc

    return Response(content=png, media_type="image/png", headers={"Cache-Control": "private, max-age=300"})


class LastViewPatch(BaseModel):
    view: Literal["library", "pages", "review", "structure", "export"] | None = None
    page_id: str | None = None


class ProjectSettingsPatch(BaseModel):
    """项目级设置：自动应用建议 / 按版心判定正文 / 识别设置（任务 51 / 54）。"""

    auto_apply_high_suggestions: bool | None = None
    margin_box_judgement: bool | None = None
    margin_judgement_notice: bool | None = None
    # 识别设置：建识别任务时读取（不是只存不用，见 recognition.create_ocr_job）。
    # 取值白名单放在 core/project/library.update_settings，接口统一转 400（而不是 422），
    # 这样错误信息是中文、带可选值，和前两个开关一致。
    recognition_engine: str | None = None
    recognition_dpi: int | None = None
    recognition_language: str | None = None
    dual_engine_strategy: str | None = None


@router.patch("/{project_id}/settings")
def patch_settings(
    request: Request, project_id: str, patch: ProjectSettingsPatch
) -> dict[str, Any]:
    """改项目设置；返回合并后的完整设置。

    这不是"静默应用"的开关：打开后每次自动应用都记一条 `auto_apply_run`，
    界面有提示、可一键撤销（见 `core/project/auto_apply.py`）。
    """
    library = _library(request)
    values = patch.model_dump(exclude_none=True)
    try:
        settings = project_library.update_settings(project_id, values, library=library)
    except project_library.ProjectError as exc:
        status = 404 if not project_library.project_exists(project_id, library=library) else 400
        raise _project_error(exc, status=status) from exc
    return {"settings": settings}


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


# ---------------------------------------------------------------- 识别记录
#
# 块的读取在 `routes_review.py`（它还要返回审校进度与撤销栈深度）；这里只留运行记录。

@router.get("/{project_id}/pages/{page_no}/runs")
def list_page_runs(request: Request, project_id: str, page_no: int) -> dict[str, Any]:
    """某一页的识别运行记录（说明书第 11 节的 `GET .../pages/{pid}/runs`）。"""
    library = _library(request)
    try:
        runs = blocks_module.list_runs(project_id, library=library, page_no=page_no)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"count": len(runs), "runs": [run.to_dict() for run in runs]}
