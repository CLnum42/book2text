"""接口层的共用零件：项目库目录、错误转换、页面载荷。

单独成模块是为了让 `routes_projects` / `routes_jobs` 共用同一份实现，
而不是各自复制一遍。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import Request

from ..core import settings as settings_module
from ..core.project import blocks as blocks_module
from ..core.project import library as project_library
from .errors import AppError


def library_dir(request: Request) -> Path:
    """项目库目录由启动入口决定（`--library`），挂在 `app.state` 上。"""
    library = getattr(request.app.state, "library_dir", None)
    if library is None:  # pragma: no cover - 装配错误
        raise AppError(500, "server_not_ready", "服务未正确初始化（缺少项目库目录）")
    return Path(library)


def project_error(exc: project_library.ProjectError, *, status: int = 400) -> AppError:
    return AppError(status, "project_error", "项目操作失败", detail=str(exc))


def page_payload(
    page: project_library.Page,
    recognition: blocks_module.PageRecognition | None,
    review: blocks_module.PageReview | None = None,
    divergence: blocks_module.PageDivergence | None = None,
) -> dict[str, object]:
    """页面载荷 = 页记录 + **推导出的识别状态与审校进度**（说明书 5.3 不单独存储状态）。

    ``divergence`` 是第二引擎的分歧概况（说明书 8.5）：界面据此在缩略图上打标记，
    并支持"有分歧"这条疑难筛选。没传时是"没复核过"的空值，不是"两路一致"。
    """
    state = recognition or blocks_module.empty_recognition(page.page_id)
    return {
        **page.to_dict(),
        "recognition": state.to_dict(),
        "review": (review or blocks_module.empty_review()).to_dict(),
        "divergence": (divergence or blocks_module.EMPTY_PAGE_DIVERGENCE).to_dict(),
    }


def actor_name(request: Request, provided: str | None = None) -> str | None:
    """审校事件里的 `actor_name`（说明书 5.3 的协作字段）。

    界面显式给了就用它；没给就用设置里的**我的名字**（说明书 Phase 6 的首次运行填写项）。
    两处都没有就是 None——不编造名字。
    """
    if provided:
        return provided
    name = settings_module.load_settings(Path(request.app.state.library_dir)).user_name
    return name or None
