"""审校包接口（助手侧，说明书 6.7.3 / 6.7.4）。

| 接口 | 作用 |
|---|---|
| `POST /packages/open` | 上传 `.b2tpkg` → 建一个审校包项目（`kind='package'`） |
| `GET /projects/{id}/package` | 这个项目的任务包信息（谁派的、哪些页、截止日期、说明） |
| `POST /projects/{id}/package/result` | 导出结果包 `.b2tres`（可多次，带序号） |
| `GET /projects/{id}/package/results` | 已导出的结果包列表 |
| `GET /projects/{id}/package/results/{name}` | 下载某个结果包 |

权限限制在 `deps.py` 的两个守卫里（`require_main_project` / `require_editable_page`），
所有"助手不该做的"接口都会在服务端被拒（不是只把按钮藏起来）。
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse

from ..core.collab import packages as packages_module
from ..core.project import library as project_library
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .errors import AppError

router = APIRouter(prefix="/api", tags=["collab"])

MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB：一本厚书的子集也到不了


@router.post("/packages/open")
async def open_package(
    request: Request, filename: str = Query(default="package.b2tpkg", max_length=255)
) -> dict[str, Any]:
    """打开任务包（说明书 7.9.2）：上传 `.b2tpkg`，在项目库里建出审校包项目。

    **用原始请求体流式接收**（与上传 PDF 同一条路，说明书 4.5）：不装 multipart 依赖，
    也不把整个任务包读进内存——厚书的子集也有几十 MB。
    """
    library = _library(request)
    name = filename.strip() or "package.b2tpkg"
    if not name.lower().endswith(packages_module.PACKAGE_EXTENSION):
        raise AppError(
            400,
            "bad_package",
            "这不是任务包",
            detail=f"任务包的扩展名是 {packages_module.PACKAGE_EXTENSION}",
        )

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / name
        size = 0
        with path.open("wb") as handle:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_PACKAGE_BYTES:
                    raise AppError(400, "package_too_large", "任务包太大")
                handle.write(chunk)
        if size == 0:
            raise AppError(400, "bad_package", "任务包是空的")
        try:
            project = packages_module.open_package(path, library=library)
        except project_library.ProjectError as exc:
            raise AppError(400, "bad_package", "任务包打不开", detail=str(exc)) from exc
        info = packages_module.package_info(project.project_id, library=library)

    return {
        "project": project.to_dict(),
        "package": info.to_dict() if info else None,
    }


@router.get("/projects/{project_id}/package")
def get_package(request: Request, project_id: str) -> dict[str, Any]:
    info = packages_module.package_info(project_id, library=_library(request))
    if info is None:
        raise AppError(404, "not_a_package", "这个项目不是审校包项目")
    return {"package": info.to_dict()}


@router.post("/projects/{project_id}/package/result")
def export_result(
    request: Request, project_id: str, body: dict | None = None
) -> dict[str, Any]:
    """导出审校结果包（说明书 6.7.4）：允许部分完成，可以多次导出（带序号）。"""
    library = _library(request)
    try:
        path, summary = packages_module.export_result(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    return {
        "file_name": path.name,
        "file_path": str(path),
        "size": path.stat().st_size,
        "summary": summary,
    }


@router.get("/projects/{project_id}/package/results")
def list_results(request: Request, project_id: str) -> dict[str, Any]:
    return {"results": packages_module.list_results(project_id, library=_library(request))}


@router.get("/projects/{project_id}/package/results/{file_name}")
def download_result(request: Request, project_id: str, file_name: str) -> FileResponse:
    try:
        path = packages_module.result_path(project_id, file_name, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return FileResponse(
        path, media_type="application/zip", filename=path.name, headers={"Cache-Control": "no-store"}
    )


@router.post("/projects/{project_id}/package/results/{file_name}/reveal")
def reveal_result(request: Request, project_id: str, file_name: str) -> dict[str, Any]:
    from ..core import platform as b2t_platform

    try:
        path = packages_module.result_path(project_id, file_name, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    opened, reason = b2t_platform.reveal_in_file_manager(path)
    return {"revealed": opened, "reason": reason, "path": str(path)}


@router.get("/packages/limits")
def package_limits() -> dict[str, Any]:
    """审校包模式允不允许某类操作（界面据此决定按钮显示；服务端另有一道守卫）。"""
    from ..core.collab import assignments as assignments_module

    return {
        "allowed": list(assignments_module.ALLOWED_OPERATIONS),
        "forbidden": list(assignments_module.FORBIDDEN_OPERATIONS),
    }
