"""Phase 0 临时上传接口。

对应说明书 Phase 0 第 4 项的「页面可上传 PDF 并显示第一页图像」。
**这些接口不是最终 API 设计**：说明书第 11 节的正式接口以 `/projects/{id}/...`
为中心，要等 Phase 1 引入项目与数据库后才存在。
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Request, Response

from ..core import platform as b2t_platform
from ..core.ocr.adapters import RapidOcrAdapter
from ..core.ocr.base import OcrEngineError, OcrParams
from ..core.pdf import render
from ..core.storage import scratch as scratch_store
from .errors import AppError

router = APIRouter(prefix="/api/scratch", tags=["scratch"])

_MAX_FILENAME_LENGTH = 120


def _sanitize_filename(raw: str) -> str:
    """净化原始文件名。

    说明书第 10 节要求项目内文件名只用 ASCII、书名不入路径。上传后的文件固定
    叫 ``original.pdf``，这里保存的名字**只用于界面显示**，因此只做最小净化：
    剥掉路径部分并限制长度，防止它被当路径用或在界面上撑破布局。
    """
    name = Path(raw.replace("\\", "/")).name.strip()
    return (name or "upload.pdf")[:_MAX_FILENAME_LENGTH]


def _require_pdf_path(upload_id: str) -> Path:
    try:
        if not scratch_store.exists(upload_id):
            raise AppError(
                404, "upload_not_found", "找不到这次上传", detail=f"upload_id={upload_id}"
            )
        return scratch_store.pdf_path(upload_id)
    except scratch_store.UploadError as exc:
        raise AppError(
            404, "upload_not_found", "上传 ID 格式不正确", detail=str(exc)
        ) from exc


@router.post("/upload")
async def upload(
    request: Request,
    filename: str = Query(default="upload.pdf"),
) -> dict[str, Any]:
    """接收 PDF 请求体（原始字节流，不是 multipart），边收边写盘。

    用原始请求体而不是 multipart 是为了能直接流式落盘：说明书 4.5 要求
    边传边算 SHA-256 并显示进度，multipart 会先把整个文件缓冲到内存。
    """
    safe_name = _sanitize_filename(filename)

    try:
        uploaded = await scratch_store.save_stream(request.stream(), safe_name)
    except scratch_store.UploadError as exc:
        raise AppError(400, "invalid_upload", "上传失败", str(exc)) from exc

    try:
        info = render.info(uploaded.path)
    except render.PdfError as exc:
        # magic bytes 对了但文件损坏，同样不留残留。
        scratch_store.delete(uploaded.upload_id)
        raise AppError(
            400, "invalid_pdf", "这个文件无法作为 PDF 打开", str(exc)
        ) from exc

    uploaded_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    scratch_store.write_metadata(
        uploaded.upload_id,
        original_name=uploaded.original_name,
        size_bytes=uploaded.size_bytes,
        sha256=uploaded.sha256,
        page_count=info.page_count,
        page_width_pt=info.page_width_pt,
        page_height_pt=info.page_height_pt,
        uploaded_at=uploaded_at,
    )

    return {
        "upload_id": uploaded.upload_id,
        "original_name": uploaded.original_name,
        "size_bytes": uploaded.size_bytes,
        "sha256": uploaded.sha256,
        "page_count": info.page_count,
        "page_width_pt": info.page_width_pt,
        "page_height_pt": info.page_height_pt,
        "uploaded_at": uploaded_at,
    }


@router.get("/{upload_id}")
def get_upload(upload_id: str) -> dict[str, Any]:
    _require_pdf_path(upload_id)
    metadata = scratch_store.read_metadata(upload_id)
    if metadata is None:
        raise AppError(404, "upload_not_found", "找不到这次上传的记录")
    return metadata


@router.get("/{upload_id}/page/{page_index}/image")
def get_page_image(
    upload_id: str,
    page_index: int,
    size: str = Query(default=render.DEFAULT_PROFILE),
) -> Response:
    """渲染某一页为 PNG。``page_index`` 从 0 开始。"""
    pdf_path = _require_pdf_path(upload_id)
    try:
        png = render.render_page_png(pdf_path, page_index, profile=size)
    except render.PdfError as exc:
        raise AppError(400, "render_failed", "无法渲染该页", str(exc)) from exc

    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


@router.post("/{upload_id}/page/{page_index}/recognize")
def recognize_page(
    upload_id: str,
    page_index: int,
    dpi: int = Query(default=300, ge=72, le=600),
) -> dict[str, Any]:
    """识别一页，返回**带归一化 bbox 的行**。

    坐标为 0–1 的归一化值（说明书 5.2），与渲染 DPI 无关：
    界面把 bbox 乘以当前显示图像的宽高即可对齐。

    **这不是说明书第 11 节的正式接口。** 正式接口以 `/projects/{id}/...` 为中心，
    并且识别要走 Job / JobItem 执行器（Phase 2）；这里同步识别单页，
    只是为了让「上传 → 渲染 → 识别」这条链路先跑通。
    """
    pdf_path = _require_pdf_path(upload_id)

    adapter = RapidOcrAdapter()
    ok, reason = adapter.available()
    if not ok:
        raise AppError(
            503,
            "ocr_engine_unavailable",
            "OCR 引擎不可用",
            detail=f"{reason}；安装后重试：uv sync --group ocr-eval",
        )

    try:
        image = render.render_page_image(pdf_path, page_index, dpi=dpi)
    except render.PdfError as exc:
        raise AppError(400, "render_failed", "无法渲染该页", str(exc)) from exc

    try:
        result = adapter.recognize(image, OcrParams(dpi=dpi))
    except OcrEngineError as exc:
        raise AppError(500, "ocr_failed", "识别失败", str(exc)) from exc
    finally:
        image.close()

    return {
        "upload_id": upload_id,
        "page_index": page_index,
        "dpi": dpi,
        "engine_id": result.engine_id,
        "engine_version": result.engine_version,
        "image_width": result.image_width,
        "image_height": result.image_height,
        "elapsed_seconds": round(result.elapsed_seconds, 3),
        "line_count": len(result.lines),
        "lines": [
            {
                "text": line.text,
                "bbox": line.bbox.as_list(),
                "confidence": line.confidence,
            }
            for line in result.lines
        ],
    }


@router.post("/{upload_id}/reveal")
def reveal_upload(upload_id: str) -> dict[str, Any]:
    """在系统文件管理器中定位上传的文件（说明书 4.5 的平台分支验证）。"""
    pdf_path = _require_pdf_path(upload_id)
    ok, reason = b2t_platform.reveal_in_file_manager(pdf_path)
    if not ok:
        raise AppError(500, "reveal_failed", "无法在文件管理器中显示", reason)
    return {"ok": True, "path": str(pdf_path)}


@router.delete("/{upload_id}")
def delete_upload(upload_id: str) -> dict[str, Any]:
    """删除一次上传，避免 scratch 目录无限增长。"""
    try:
        removed = scratch_store.delete(upload_id)
    except scratch_store.UploadError as exc:
        raise AppError(
            404, "upload_not_found", "上传 ID 格式不正确", detail=str(exc)
        ) from exc
    if not removed:
        raise AppError(404, "upload_not_found", "找不到这次上传")
    return {"ok": True}
