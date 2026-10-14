"""应用级接口：版本、平台、引擎自检（对应说明书第 11 节的 `GET /app/info`）。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .. import __version__
from ..core import platform as b2t_platform
from ..core.ocr import selfcheck
from ..core.pdf import render
from ..core.storage import scratch

router = APIRouter(prefix="/api/app", tags=["app"])

# 当前骨架做不到的事，如实列出（说明书 1.6：不用模拟状态）。
_CURRENT_LIMITS = [
    "识别：一次只能识别一页，不能批量、暂停、继续、重试失败页（任务执行器尚未实现）",
    "审校：块还不能编辑、确认、合并、拆分，也没有撤销",
    "分歧检测：第二引擎与按行比对尚未实现",
    "导出：目前仍走临时上传流程，还没接到项目上；项目里已识别的页暂时不能导出",
    "上传的原始 PDF 只被读取，不会被修改",
]


@router.get("/info")
def app_info() -> dict[str, Any]:
    supported, unsupported_reason = b2t_platform.is_supported_platform()
    return {
        "app": {
            "name": "Book2Text",
            "version": __version__,
            "stage": "Phase 2 进行中（识别已落库；批量任务、审校、导出未完成）",
        },
        "platform": {
            "label": b2t_platform.platform_label(),
            "supported": supported,
            "unsupported_reason": unsupported_reason,
            "os_version": b2t_platform.os_version(),
            "python_version": b2t_platform.python_version(),
        },
        "pdf_backend": {
            "name": "pypdfium2",
            "version": render.backend_version(),
            "selected": False,
            "note": "说明书 Phase 0 第 3 项的库对比尚未完成，当前为暂用后端",
        },
        "engines": selfcheck.report(),
        "data_dir": str(scratch.app_data_dir()),
        "scratch_dir": str(scratch.scratch_dir()),
        "limits": _CURRENT_LIMITS,
    }
