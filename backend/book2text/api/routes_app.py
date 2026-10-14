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
    "没有项目与数据库：上传的 PDF 只落在临时目录，不作为正式项目保存",
    "没有 OCR 识别：不能把图像转成文本",
    "没有审校、结构与导出功能",
    "上传的原始 PDF 只被读取，不会被修改",
]


@router.get("/info")
def app_info() -> dict[str, Any]:
    supported, unsupported_reason = b2t_platform.is_supported_platform()
    return {
        "app": {
            "name": "Book2Text",
            "version": __version__,
            "stage": "Phase 0 骨架（说明书第 14 节第 4 项）",
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
