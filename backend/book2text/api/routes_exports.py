"""项目导出接口（说明书第 11 节的「导出」一组，6.6 的导出流程）。

导出是**项目自己的操作**：服务端从项目数据库取块，跑 9.1–9.5，
按说明书 12.1 写进 ``exports/<export_id>/``，并记一条 `export_record`。

这与 Phase 0 的无状态导出（客户端把块提交上来、服务端把文本还回去）是两件事——
那一套连同临时上传已经删掉了：项目里已有几百页成果，没道理还要客户端来回搬。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..core import platform as b2t_platform
from ..core.export import project as project_export
from ..core.project import library as project_library
from .deps import library_dir as _library
from .deps import require_main_project as _require_main
from .deps import project_error as _project_error
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["export"])

PAGE_TYPES = project_library.PAGE_TYPES


class ExportRequest(BaseModel):
    """说明书 6.6 的导出选项（默认值就是说明书里写的默认）。"""

    format: Literal["txt", "jsonl", "both"] = "txt"
    confirmed_only: bool = False
    page_types: list[str] = Field(default_factory=lambda: ["body"])
    page_numbers: list[int] | None = Field(default=None, max_length=5000)
    include_footnotes: bool = False
    include_captions: bool = True
    include_other: bool = False
    page_markers: bool = False
    # 注释流默认不生成文件；勾选「同时导出注释」才写 notes.txt / notes.jsonl
    include_notes: bool = False
    exclude_header_footer: bool = True
    merge_lines_in_block: bool = True
    restore_hyphenation: bool = True
    normalize_newlines: bool = True
    strip_line_whitespace: bool = True

    def options(self) -> project_export.ExportOptions:
        unknown = [name for name in self.page_types if name not in PAGE_TYPES]
        if unknown:
            raise AppError(
                400, "bad_page_types", "未知的页面类型", detail="、".join(unknown)
            )
        return project_export.ExportOptions(
            format=self.format,
            confirmed_only=self.confirmed_only,
            page_types=tuple(self.page_types),
            page_numbers=tuple(self.page_numbers) if self.page_numbers else None,
            include_footnotes=self.include_footnotes,
            include_captions=self.include_captions,
            include_other=self.include_other,
            page_markers=self.page_markers,
            include_notes=self.include_notes,
            exclude_header_footer=self.exclude_header_footer,
            merge_lines_in_block=self.merge_lines_in_block,
            restore_hyphenation=self.restore_hyphenation,
            normalize_newlines=self.normalize_newlines,
            strip_line_whitespace=self.strip_line_whitespace,
        )


def _export_error(exc: project_export.ExportError, *, status: int = 400) -> AppError:
    return AppError(status, "export_failed", "导出没有完成", detail=str(exc))


def _project_or_404(request: Request, project_id: str):
    library = _library(request)
    try:
        return library, project_library.load_project(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.post("/{project_id}/export/preflight")
def export_preflight(
    request: Request, project_id: str, body: ExportRequest
) -> dict[str, Any]:
    """预检摘要（说明书 6.6 第 5 条）：不动文件，只算这次导出会是什么样。"""
    _require_main(request, project_id)
    library, _project = _project_or_404(request, project_id)
    try:
        result = project_export.preflight(project_id, library=library, options=body.options())
    except project_export.ExportError as exc:
        raise _export_error(exc) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    return result


@router.post("/{project_id}/export/preview")
def export_preview(
    request: Request,
    project_id: str,
    body: ExportRequest,
    limit: int = Query(default=20000, ge=0, le=200_000),
) -> dict[str, Any]:
    """预览（说明书 6.6 第 7 条）：算一遍但不写文件。"""
    _require_main(request, project_id)
    library, _project = _project_or_404(request, project_id)
    try:
        result = project_export.preview(
            project_id, library=library, options=body.options(), limit=limit
        )
    except project_export.ExportError as exc:
        raise _export_error(exc) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc
    return result


@router.post("/{project_id}/export")
def export_now(request: Request, project_id: str, body: ExportRequest) -> dict[str, Any]:
    """生成导出文件（说明书 6.6 / 12.1），并记一条导出记录。"""
    _require_main(request, project_id)
    library, _project = _project_or_404(request, project_id)
    try:
        return project_export.run_export(project_id, library=library, options=body.options())
    except project_export.ExportError as exc:
        raise _export_error(exc) from exc
    except OSError as exc:
        raise AppError(500, "export_write_failed", "写导出文件失败", detail=str(exc)) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc


@router.get("/{project_id}/exports")
def list_exports(request: Request, project_id: str) -> dict[str, Any]:
    """导出记录（说明书第 11 节的 `GET /projects/{id}/exports`）。"""
    library, _project = _project_or_404(request, project_id)
    try:
        records = project_export.list_records(project_id, library=library)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return {"count": len(records), "exports": [record.to_dict() for record in records]}


@router.get("/{project_id}/exports/{export_id}/download")
def download_export(
    request: Request,
    project_id: str,
    export_id: str,
    file: str | None = Query(default=None),
) -> FileResponse:
    """下载导出文件（默认数据文件；`?file=manifest.json` 可以取 manifest）。"""
    library, project = _project_or_404(request, project_id)
    if project.directory is None:  # pragma: no cover
        raise AppError(500, "project_error", "项目缺少目录信息")
    try:
        record = project_export.load_record(project_id, export_id, library=library)
        path = project_export.resolve_file(record, project.directory, file)
    except project_export.ExportError as exc:
        raise _export_error(exc, status=404) from exc

    return FileResponse(
        path,
        media_type="text/plain; charset=utf-8",
        filename=path.name,
    )


@router.post("/{project_id}/exports/{export_id}/reveal")
def reveal_export(request: Request, project_id: str, export_id: str) -> dict[str, Any]:
    """在系统文件管理器中显示导出目录（说明书 4.5）。"""
    library, project = _project_or_404(request, project_id)
    if project.directory is None:  # pragma: no cover
        raise AppError(500, "project_error", "项目缺少目录信息")
    try:
        record = project_export.load_record(project_id, export_id, library=library)
    except project_export.ExportError as exc:
        raise _export_error(exc, status=404) from exc

    directory = project.directory / project_export.EXPORTS_DIR_NAME / record.export_id
    ok, reason = b2t_platform.reveal_in_file_manager(directory)
    if not ok:
        raise AppError(500, "reveal_failed", "无法在文件管理器中显示", detail=reason)
    return {"ok": True, "path": str(directory)}
