"""页码设置接口（任务 55 / 56）：模板聚类、确认填充、页码范围、手动映射、异常列表。

这一组**不改变识别**；导出从任务 56 起会优先读 `page.printed_page`（见 `export/streams.py`）。
写接口只允许主项目。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..core.project import library as project_library
from ..core.project import page_index as page_index_module
from ..core.project import page_numbers as page_numbers_module
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["page-numbers"])


def _bad_template(exc: page_numbers_module.PageNumberError) -> AppError:
    return AppError(400, "bad_page_number_template", "页码模板不合法", detail=str(exc))


class TemplateRange(BaseModel):
    from_page: int
    to_page: int


class ApplyTemplateRequest(BaseModel):
    """用户确认采用的模板；`range` 为空 = 设为整本默认，否则 = 这段页码的第二套模板。"""

    template: dict[str, Any]
    range: TemplateRange | None = None


class RemoveRangeRequest(BaseModel):
    from_page: int
    to_page: int


class ManualPageRequest(BaseModel):
    """逐页手动映射；`printed_page` 留空 = 取消这一页的手动值。"""

    page_no: int
    printed_page: str | None = Field(default=None, max_length=16)


@router.get("/{project_id}/page-numbers")
def get_page_numbers(request: Request, project_id: str) -> dict[str, Any]:
    """候选模板 + 当前映射 + 页码范围 + 异常分组（只读）。"""
    try:
        return page_numbers_module.analyze(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.get("/{project_id}/page-index")
def get_page_index(request: Request, project_id: str) -> dict[str, Any]:
    """目录确认（任务 37）：印刷页码 → PDF 页的跳转索引（只读、有缓存）。

    - 印刷页码优先读 `page.printed_page`，否则用页码候选（不重新 OCR）；
    - 对开双页（一张 PDF 页含两个印刷页）一行给两个号码；
    - 缺页码的页照样列出，`missing=true`；
    - 生成一次约 0.15 秒，按 `project.updated_at` 缓存 60 秒。
    """
    try:
        return page_index_module.build_page_index(
            project_id, library=_library(request)
        )
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.get("/{project_id}/page-numbers/summary")
def get_page_number_summary(request: Request, project_id: str) -> dict[str, Any]:
    """右栏摘要：默认模板 / 页码范围 / 已填 / 手动页数（不跑聚类）。"""
    try:
        return page_numbers_module.page_number_state(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.post("/{project_id}/page-numbers/apply")
def apply_page_number_template(
    request: Request, project_id: str, body: ApplyTemplateRequest
) -> dict[str, Any]:
    """采用模板（整本或一段页码范围），重算模板页并返回最新异常列表。"""
    _require_main(request, project_id)
    try:
        return page_numbers_module.apply_template(
            project_id,
            body.template,
            range_payload=body.range.model_dump() if body.range else None,
            library=_library(request),
        )
    except page_numbers_module.PageNumberError as exc:
        raise _bad_template(exc) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.post("/{project_id}/page-numbers/ranges/remove")
def remove_page_number_range(
    request: Request, project_id: str, body: RemoveRangeRequest
) -> dict[str, Any]:
    """移除一段页码范围模板，并按默认模板重算（手动页不动）。"""
    _require_main(request, project_id)
    try:
        return page_numbers_module.remove_range(
            project_id,
            from_page=body.from_page,
            to_page=body.to_page,
            library=_library(request),
        )
    except page_numbers_module.PageNumberError as exc:
        raise _bad_template(exc) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.post("/{project_id}/page-numbers/manual")
def set_manual_page_number(
    request: Request, project_id: str, body: ManualPageRequest
) -> dict[str, Any]:
    """逐页手动改印刷页码；手动值不参与后续模板重算。"""
    _require_main(request, project_id)
    try:
        return page_numbers_module.set_manual_page(
            project_id, body.page_no, body.printed_page, library=_library(request)
        )
    except page_numbers_module.PageNumberError as exc:
        raise _bad_template(exc) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
