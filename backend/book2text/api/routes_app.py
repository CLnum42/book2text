"""应用级接口：版本、平台、引擎自检、设置与诊断日志（说明书第 11 节的 `/app` 一组）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from .. import __version__
from ..core import platform as b2t_platform
from ..core import settings as settings_module
from ..core.ocr import selfcheck
from ..core.pdf import render
from . import diagnostics as diagnostics_module
from .deps import library_dir as _library

router = APIRouter(prefix="/api/app", tags=["app"])

# 当前骨架做不到的事，如实列出（说明书 1.6：不用模拟状态）。
_CURRENT_LIMITS = [
    "识别：一次只跑一个子进程（并发数设置项未做）；样本试识别还没有独立的对照形态",
    "审校：页眉页脚预览的图上高亮、说明书 7.5 余下的快捷键还没做",
    "第二引擎（Apple Vision）：分歧逐行标出（汉字级 / 标点级）、可一键换候选、能批量复核，"
    "但实测它比第一引擎弱、分歧多数是它的错；捕获率需要金标准，产品里只报分歧率",
    "导出：能做整本书，且能点一段跳回来源页与来源块；未识别页在对照里没有占位",
    "上传的原始 PDF 只被读取，不会被修改",
]


@router.get("/info")
def app_info(request: Request) -> dict[str, Any]:
    supported, unsupported_reason = b2t_platform.is_supported_platform()
    settings = settings_module.load_settings(_library(request))
    return {
        "app": {
            "name": "Book2Text",
            "version": __version__,
            "stage": "Phase 4 已完成（MVP 走通）；现在在做 Phase 8 Step 1（双路 OCR）",
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
        # 说明书 Phase 6 的"首次运行环境检查（含填写我的名字）"：没有设置文件就是首次运行
        "settings": settings.to_dict(),
        "limits": _CURRENT_LIMITS,
    }


class SettingsPatch(BaseModel):
    user_name: str = Field(default="", max_length=settings_module.MAX_NAME_LENGTH)


@router.get("/settings")
def get_settings(request: Request) -> dict[str, Any]:
    """读设置（说明书第 11 节的 `/app/settings`）。"""
    return settings_module.load_settings(_library(request)).to_dict()


@router.put("/settings")
def put_settings(request: Request, body: SettingsPatch) -> dict[str, Any]:
    """写设置。**我的名字**会作为审校事件的 `actor_name` 记进项目数据库（说明书 5.3）。"""
    return settings_module.save_settings(_library(request), user_name=body.user_name).to_dict()


@router.get("/diagnostics")
def download_diagnostics(request: Request) -> Response:
    """导出诊断日志（说明书 Phase 6）。

    纯文本下载：环境信息、引擎自检、每个项目的统计与任务日志末尾。
    **不含识别文本、不含项目外的个人绝对路径**（家目录 → `~`），也不会上传任何东西。
    """
    report = diagnostics_module.build_report(library=_library(request))
    return Response(
        content=report.text,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{report.file_name}"',
            "Cache-Control": "no-store",
        },
    )
