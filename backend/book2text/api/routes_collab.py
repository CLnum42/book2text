"""协作接口：分派任务包（负责人侧，说明书 6.7.1 / 7.9.1）。

| 接口 | 作用 |
|---|---|
| `POST /projects/{id}/assignments/preview` | 分派前的检查：能派哪些页、哪些要跳过、大概多大 |
| `POST /projects/{id}/assignments` | 建分派 + 写快照 + 生成 `.b2tpkg` |
| `GET /projects/{id}/assignments` | 任务包列表（审校人、页范围、状态、最近导入序号） |
| `POST /projects/{id}/assignments/{aid}/cancel` | 作废（页面恢复为未分派） |
| `POST /projects/{id}/assignments/{aid}/rebuild` | 重新导出任务包（用原来那份快照） |
| `GET /projects/{id}/assignments/{aid}/package` | 下载 `.b2tpkg` |
| `POST /projects/{id}/assignments/{aid}/reveal` | 在访达 / 资源管理器里显示 |

助手侧（打开任务包、导出结果包）在 `routes_packages.py`，
导入与合并（`/results`）也在这一组里，见说明书第 11 节的表。
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..core import platform as b2t_platform
from ..core.collab import assignments as assignments_module
from ..core.collab import merge as merge_module
from ..core.project import blocks as blocks_module
from ..core.project import library as project_library
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .errors import AppError
from .routes_review import _Batch, _history

router = APIRouter(prefix="/api/projects", tags=["collab"])

# 任务包 / 结果包的体积上限：一本厚书的子集与结果包都远到不了这个量级
MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024


class PreviewRequest(BaseModel):
    pages: list[int] = Field(default_factory=list, max_length=5000)
    reviewer_name: str = Field(default="", max_length=100)
    with_context: bool = True


class CreateRequest(PreviewRequest):
    note: str = Field(default="", max_length=2000)
    due_date: str | None = Field(default=None, max_length=32)


def _directory(request: Request, project_id: str) -> Path:
    return project_library.project_dir(_library(request), project_id)


def _known_reviewer_names(project_id: str, library: Path) -> list[str]:
    """用过的审校人名字（说明书 7.9.1："记住用过的名字"）——从已有任务包里取。"""
    names: list[str] = []
    for assignment in assignments_module.list_assignments(project_id, library=library):
        if assignment.reviewer_name and assignment.reviewer_name not in names:
            names.append(assignment.reviewer_name)
    return names


@router.post("/{project_id}/assignments/preview")
def preview_assignment(
    request: Request, project_id: str, body: PreviewRequest
) -> dict[str, Any]:
    library = _library(request)
    try:
        preview = assignments_module.preview_assignment(
            project_id,
            pages=body.pages,
            reviewer_name=body.reviewer_name,
            with_context=body.with_context,
            library=library,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    preview["known_reviewers"] = _known_reviewer_names(project_id, library)
    return preview


@router.post("/{project_id}/assignments")
def create_assignment(
    request: Request, project_id: str, body: CreateRequest
) -> dict[str, Any]:
    library = _library(request)
    try:
        assignment, package_path = assignments_module.create_assignment(
            project_id,
            pages=body.pages,
            reviewer_name=body.reviewer_name,
            note=body.note,
            due_date=body.due_date,
            with_context=body.with_context,
            library=library,
        )
    except project_library.ProjectError as exc:
        status = 404 if not project_library.project_exists(project_id, library=library) else 400
        raise _project_error(exc, status=status) from exc
    return {
        "assignment": assignment.to_dict(),
        "package_name": package_path.name,
        "package_dir": str(package_path.parent),
    }


@router.get("/{project_id}/assignments")
def list_assignments(request: Request, project_id: str) -> dict[str, Any]:
    library = _library(request)
    try:
        found = assignments_module.list_assignments(project_id, library=library)
        pages = project_library.list_pages(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc

    by_id = {page.page_id: page for page in pages}
    return {
        "count": len(found),
        "known_reviewers": _known_reviewer_names(project_id, library),
        "assignments": [
            {
                **assignment.to_dict(),
                "page_nos": [
                    by_id[page_id].page_no for page_id in assignment.page_ids if page_id in by_id
                ],
                "context_page_nos": [
                    by_id[page_id].page_no
                    for page_id in assignment.context_page_ids
                    if page_id in by_id
                ],
                "package_exists": (
                    assignments_module.assignment_dir(
                        _directory(request, project_id), assignment.assignment_id
                    )
                    / assignment.package_name
                ).is_file()
                if assignment.package_name
                else False,
            }
            for assignment in found
        ],
    }


def _assignment_package(request: Request, project_id: str, assignment_id: str):
    library = _library(request)
    directory = _directory(request, project_id)
    assignment = assignments_module.get_assignment(
        project_id, assignment_id, library=library
    )
    if not assignment.package_name:
        raise AppError(404, "package_missing", "这个任务包没有文件名记录")
    path = assignments_module.assignment_dir(directory, assignment_id) / assignment.package_name
    if not path.is_file():
        raise AppError(
            404, "package_missing", "任务包文件不在了", detail="可以点「重新导出任务包」再生成一份"
        )
    return assignment, path


@router.get("/{project_id}/assignments/{assignment_id}/package")
def download_package(
    request: Request, project_id: str, assignment_id: str
) -> FileResponse:
    _assignment, path = _assignment_package(request, project_id, assignment_id)
    return FileResponse(
        path,
        media_type="application/zip",
        filename=path.name,
        headers={"Cache-Control": "no-store"},
    )


@router.post("/{project_id}/assignments/{assignment_id}/reveal")
def reveal_package(request: Request, project_id: str, assignment_id: str) -> dict[str, Any]:
    """在访达 / 资源管理器里显示任务包（说明书 7.9.1）。"""
    _assignment, path = _assignment_package(request, project_id, assignment_id)
    opened, reason = b2t_platform.reveal_in_file_manager(path)
    return {"revealed": opened, "reason": reason, "path": str(path)}


@router.post("/{project_id}/assignments/{assignment_id}/rebuild")
def rebuild_package(request: Request, project_id: str, assignment_id: str) -> dict[str, Any]:
    library = _library(request)
    try:
        path = assignments_module.rebuild_package(
            project_id, assignment_id, library=library
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    return {"package_name": path.name, "package_dir": str(path.parent)}


@router.post("/{project_id}/assignments/{assignment_id}/cancel")
def cancel_assignment(request: Request, project_id: str, assignment_id: str) -> dict[str, Any]:
    library = _library(request)
    try:
        assignment = assignments_module.cancel_assignment(
            project_id, assignment_id, library=library
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    return {"assignment": assignment.to_dict()}


# ---------------------------------------------------------------- 导入结果与合并（说明书 6.7.5）
#
# 三步：导入（校验 + 分类，不写正文）→ 看差异 → 逐页决定（接受 / 拒绝 / 冲突处理）。
# 写的动作走 `core/collab/merge.apply_decisions()`，一次一个 batch，可整体撤销。


class ImportResultRequest(BaseModel):
    allow_cancelled: bool = False
    allow_older: bool = False


class DecisionItem(BaseModel):
    page_id: str
    action: Literal["accept", "reject", "keep_mine"]
    # 只给块级变化用：不给就是整页
    block_ids: list[str] | None = None


class DecisionsRequest(BaseModel):
    decisions: list[DecisionItem] = Field(default_factory=list, max_length=5000)
    reviewer_name: str = Field(default="", max_length=100)


@router.post("/{project_id}/results")
async def import_result(
    request: Request,
    project_id: str,
    allow_cancelled: bool = Query(default=False),
    allow_older: bool = Query(default=False),
    filename: str = Query(default="result.b2tres", max_length=255),
) -> dict[str, Any]:
    """导入结果包（说明书第 11 节的 `POST /projects/{id}/results`）。

    请求体是结果包本体（原始字节流，与上传 PDF / 任务包同一条路）。
    返回差异摘要与逐页分类，**不改任何正文**——接受与否由负责人逐页决定。
    """
    library = _library(request)
    name = filename.strip() or "result.b2tres"
    if not name.lower().endswith(".b2tres"):
        raise AppError(400, "bad_result", "这不是结果包", detail="结果包的扩展名是 .b2tres")

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / name
        size = 0
        with path.open("wb") as handle:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_PACKAGE_BYTES:
                    raise AppError(400, "result_too_large", "结果包太大")
                handle.write(chunk)
        if size == 0:
            raise AppError(400, "bad_result", "结果包是空的")
        try:
            state = merge_module.import_result(
                project_id,
                path=path,
                source_name=name,
                library=library,
                allow_cancelled=allow_cancelled,
                allow_older=allow_older,
            )
        except project_library.ProjectError as exc:
            raise AppError(400, "bad_result", "结果包导入失败", detail=str(exc)) from exc

    return state.to_dict()


@router.get("/{project_id}/assignments/{assignment_id}/merge")
def merge_state(request: Request, project_id: str, assignment_id: str) -> dict[str, Any]:
    """重新算一次"导入过的这一份结果"的差异（刷新合并审阅视图用）。"""
    library = _library(request)
    directory = _directory(request, project_id)
    try:
        assignment = assignments_module.get_assignment(
            project_id, assignment_id, library=library
        )
        if assignment.imported_seq <= 0:
            raise AppError(400, "not_imported", "还没导入过结果包")
        archived = merge_module.latest_result_path(directory, assignment_id, assignment.imported_seq)
        if archived is None:
            raise AppError(404, "result_missing", "找不到结果包留档")
        state = merge_module.import_result(
            project_id,
            path=archived,
            source_name=archived.name,
            library=library,
            allow_cancelled=True,
            allow_older=True,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    return state.to_dict()


@router.post("/{project_id}/assignments/{assignment_id}/merge")
def apply_merge(
    request: Request, project_id: str, assignment_id: str, body: DecisionsRequest
) -> dict[str, Any]:
    """按逐页决定把助手的改动写进主项目：一次一个 batch，可整体撤销。"""
    library = _library(request)
    try:
        outcome = merge_module.apply_decisions(
            project_id,
            assignment_id=assignment_id,
            decisions=[item.model_dump() for item in body.decisions],
            reviewer_name=body.reviewer_name,
            library=library,
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    events = outcome["events"]
    if events:
        _history(request).push(
            project_id,
            _Batch(events=tuple(events), page_nos=tuple(sorted({_page_no_of(project_id, library, e) for e in events} - {None}))),
        )
    return {
        "accepted_pages": outcome["accepted_pages"],
        "rejected_pages": outcome["rejected_pages"],
        "assignment": outcome["assignment"],
        "events": [event.to_dict() for event in events],
        "history": _history(request).depth(project_id),
    }


def _page_no_of(project_id: str, library: Path, event) -> int | None:
    """事件落在哪一页（撤销栈要知道涉及哪些页才能刷新界面）。"""
    if event.entity_type != "block":
        return None
    for page in project_library.list_pages(project_id, library=library):
        blocks = blocks_module.list_blocks(project_id, library=library, page_no=page.page_no)
        if any(block.block_id == event.entity_id for block in blocks):
            return page.page_no
    return None
