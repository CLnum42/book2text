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
    "识别：一次只跑一个子进程（并发数设置项未做）；样本试识别还没有独立的对照形态",
    "审校：还不能在疑难页之间跳转，也不能采用新的识别结果；页眉页脚批量标注未做",
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
            "stage": "Phase 3 进行中（识别、选页、审校与结构编辑可用）；导出未开始",
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
