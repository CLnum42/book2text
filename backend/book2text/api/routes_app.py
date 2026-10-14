"""应用级接口：版本、平台、引擎自检（对应说明书第 11 节的 `GET /app/info`）。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .. import __version__
from ..core import platform as b2t_platform
from ..core.ocr import selfcheck
from ..core.pdf import render

router = APIRouter(prefix="/api/app", tags=["app"])

# 当前骨架做不到的事，如实列出（说明书 1.6：不用模拟状态）。
_CURRENT_LIMITS = [
    "识别：一次只跑一个子进程（并发数设置项未做）；样本试识别还没有独立的对照形态",
    "审校：页眉页脚批量标注、逐块采用新结果、在图上框选位置新增块都还没做",
    "分歧检测：第二引擎与按行比对尚未实现",
    "导出：能做整本书，但还没有「导出对照」（点一段跳回来源页与来源块）",
    "上传的原始 PDF 只被读取，不会被修改",
]


@router.get("/info")
def app_info() -> dict[str, Any]:
    supported, unsupported_reason = b2t_platform.is_supported_platform()
    return {
        "app": {
            "name": "Book2Text",
            "version": __version__,
            "stage": "Phase 4：导出已接到项目上（MVP 功能齐全，收尾中）",
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
        "limits": _CURRENT_LIMITS,
    }
