"""页码设置接口（任务 55）：位置模板聚类、确认填充、异常列表。

这一组**不改变导出**：写入的 `page.printed_page` 只用于页码模板 / 数值校验与界面显示；
`meta.json` 仍走原来的页码抽取。写接口只允许主项目。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from ..core.project import library as project_library
from ..core.project import page_numbers as page_numbers_module
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .deps import require_main_project as _require_main
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["page-numbers"])


def _bad_template(exc: page_numbers_module.PageNumberError) -> AppError:
    return AppError(400, "bad_page_number_template", "页码模板不合法", detail=str(exc))


class ApplyTemplateRequest(BaseModel):
    """用户确认采用的模板（就是分析接口返回的那一条，原样回传即可）。"""

    template: dict[str, Any]


@router.get("/{project_id}/page-numbers")
def get_page_numbers(request: Request, project_id: str) -> dict[str, Any]:
    """候选模板 + 当前映射 + 异常分组（只读）。"""
    try:
        return page_numbers_module.analyze(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.get("/{project_id}/page-numbers/summary")
def get_page_number_summary(request: Request, project_id: str) -> dict[str, Any]:
    """右栏摘要：已采用的模板与已填页数（不跑聚类）。"""
    try:
        return page_numbers_module.page_number_state(project_id, library=_library(request))
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc


@router.post("/{project_id}/page-numbers/apply")
def apply_page_number_template(
    request: Request, project_id: str, body: ApplyTemplateRequest
) -> dict[str, Any]:
    """按确认的模板填充 `page.printed_page`，返回填充结果与最新异常列表。"""
    _require_main(request, project_id)
    try:
        return page_numbers_module.apply_template(
            project_id, body.template, library=_library(request)
        )
    except page_numbers_module.PageNumberError as exc:
        raise _bad_template(exc) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
