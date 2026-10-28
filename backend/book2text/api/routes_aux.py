"""第二引擎复核的"重跑"与语言统计（任务 64）。

用户拍板：**以后一律用第二引擎（Apple Vision）识别，不用文字层**。这条接口是给
已有项目"把 aux 换掉"用的：先备份、只覆盖 `aux_text` / `diff_status`，
`text` / 块 / 版心 / 块类型 / 已裁决的行一律不动，分批可续、可中断，撤销走全局历史。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from ..core.project import library as project_library
from ..core.project import recognition
from ..core.storage import db as db_module
from .deps import actor_name as _actor_name
from .deps import library_dir as _library
from .errors import AppError

router = APIRouter(prefix="/api", tags=["aux"])


@router.get("/projects/{project_id}/aux/languages")
def aux_languages(request: Request, project_id: str) -> dict[str, Any]:
    """每页语言分布（判过的才计）+ 还没判的页数。"""
    library = _library(request)
    try:
        pages = project_library.list_pages(project_id, library=library)
    except project_library.ProjectError as exc:
        raise AppError(404, "project_error", str(exc)) from exc
    counts: dict[str, int] = {}
    unknown = 0
    for page in pages:
        if not page.include:
            continue
        if page.ocr_language:
            counts[page.ocr_language] = counts.get(page.ocr_language, 0) + 1
        else:
            unknown += 1
    return {"counts": counts, "unknown": unknown, "total": sum(counts.values()) + unknown}


@router.post("/projects/{project_id}/aux/rerun")
def rerun_auxiliary(request: Request, project_id: str) -> dict[str, Any]:
    """重跑第二引擎：**先备份**，再建一个覆盖式的复核任务。

    - 用 Apple Vision（不走文字层）；
    - 语言按页判定（`page.ocr_language`，没有就现判并写回）；
    - 已裁决且文本没变的行由 `run_auxiliary` 跳过，不覆盖。
    """
    library = _library(request)
    directory = project_library.require_project_dir(project_id, library=library)
    try:
        backup = db_module.backup_database(directory)
        job = recognition.create_auxiliary_job(
            project_id,
            library=library,
            scope="all",             # 全部已识别的页都重跑：这次是换引擎
            skip_checked=False,      # 已复核过的页也要重跑
        )
    except project_library.ProjectError as exc:
        raise AppError(400, "aux_rerun_failed", str(exc)) from exc
    return {
        "job": job.to_dict(),
        "backup_path": str(backup),
        "engine": "apple_vision",
        "language": "auto",
        "actor": _actor_name(request) or "",
    }
