"""结构工具接口（说明书第 11 节的「结构工具」一组，6.5 页眉页脚批量标注）。

流程是**预览 → 人工确认 → 批量应用**，与说明书写的一致：

1. `POST .../structure/header-footer/preview`：按位置规则与文本条件算出会被标注的块，
   **不改任何东西**；返回候选列表（可逐个取消）、被跳过的块与原因。
2. `POST .../structure/header-footer/apply`：把用户确认保留的那些块**一次批量**改类型，
   整批共享一个 `batch_id`，可以整体撤销。

**模型建议绝不静默生效**：版面组件还没接入（说明书 8.4 的路线未选定），
因此当前只有"位置规则"这一种来源，而它同样必须过一遍预览。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from ..core.project import editing
from ..core.project import library as project_library
from ..core.project import structure
from .deps import library_dir as _library
from .deps import project_error as _project_error
from .errors import AppError

router = APIRouter(prefix="/api/projects", tags=["structure"])


class HeaderFooterRulesModel(BaseModel):
    top_ratio: float = Field(default=structure.DEFAULT_REGION_RATIO, ge=0, le=0.5)
    bottom_ratio: float = Field(default=structure.DEFAULT_REGION_RATIO, ge=0, le=0.5)
    max_chars: int | None = Field(default=structure.DEFAULT_MAX_CHARS, ge=0, le=500)
    page_types: list[str] = Field(default_factory=lambda: ["body"])
    detect_page_numbers: bool = True

    def rules(self) -> structure.HeaderFooterRules:
        return structure.HeaderFooterRules(
            top_ratio=self.top_ratio,
            bottom_ratio=self.bottom_ratio,
            max_chars=self.max_chars,
            page_types=tuple(self.page_types),
            detect_page_numbers=self.detect_page_numbers,
        )


@router.post("/{project_id}/structure/header-footer/preview")
def header_footer_preview(
    request: Request, project_id: str, body: HeaderFooterRulesModel | None = None
) -> dict[str, Any]:
    """预览：会被标注哪些块、标成什么、哪些被跳过（说明书 6.5 第 3 条）。"""
    library = _library(request)
    rules = (body or HeaderFooterRulesModel()).rules()
    try:
        plan = structure.plan_header_footer(project_id, library=library, rules=rules)
    except project_library.ProjectError as exc:
        raise _project_error(exc, status=404) from exc
    return plan.to_dict()


class ApplyItem(BaseModel):
    block_id: str = Field(min_length=1, max_length=64)
    block_type: str = Field(min_length=1, max_length=32)


class ApplyRequest(BaseModel):
    items: list[ApplyItem] = Field(default_factory=list, max_length=5000)
    actor_name: str | None = Field(default=None, max_length=100)


@router.post("/{project_id}/structure/header-footer/apply")
def header_footer_apply(
    request: Request, project_id: str, body: ApplyRequest
) -> dict[str, Any]:
    """应用：把确认保留的块一次批量改类型（整批可撤销）。"""
    library = _library(request)
    if not body.items:
        raise AppError(
            400, "nothing_to_apply", "没有要标注的块", detail="预览里至少要保留一个块"
        )
    try:
        result = structure.apply_header_footer(
            project_id,
            [(item.block_id, item.block_type) for item in body.items],
            library=library,
            actor_name=body.actor_name,
        )
    except editing.BlockConflict as exc:  # pragma: no cover - 批量应用不做并发检查
        raise AppError(409, "block_conflict", "块已经被改过", detail=str(exc)) from exc
    except project_library.ProjectError as exc:
        raise _project_error(exc) from exc

    history = getattr(request.app.state, "review_history", None)
    if history is not None:
        # 整批进撤销栈：撤销一次回到标注之前
        history.push(project_id, _batch(result))

    return {
        "changed": result.changed,
        "by_type": result.by_type,
        "pages": list(result.pages),
        "history": _depth(history, project_id),
    }


def _batch(result: structure.ApplyResult):
    from .routes_review import _Batch  # 复用同一个批次类型

    return _Batch(events=result.events, page_nos=result.pages)


def _depth(history, project_id: str) -> dict[str, int] | None:
    if history is None:  # pragma: no cover - 装配错误
        return None
    undo, redo = history.depth(project_id)
    return {"undo": undo, "redo": redo}
