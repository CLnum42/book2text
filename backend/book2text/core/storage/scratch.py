"""Phase 0 专用的临时上传存储。

**这不是最终的数据模型。** 说明书 Phase 0 第 4 项只要求「上传 PDF 并显示
第一页图像」，此时还没有项目（Project）与 SQLite。上传的文件先落在应用数据
目录下的 ``scratch/`` 中，按上传 ID 分目录保存：

    <应用数据目录>/scratch/<upload_id>/original.pdf
    <应用数据目录>/scratch/<upload_id>/upload.json

Phase 1 建立项目库与 ``project.db`` 之后，本模块的职责应由
``core/storage`` 的项目层取代。届时 scratch 可直接删除。
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import uuid
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from platformdirs import user_data_dir

PDF_MAGIC = b"%PDF-"

_UPLOAD_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


class UploadError(Exception):
    """上传被拒绝：内容为空、非 PDF，或上传 ID 不合法。"""


@dataclass(frozen=True)
class UploadedFile:
    upload_id: str
    path: Path
    size_bytes: int
    sha256: str
    original_name: str


def app_data_dir() -> Path:
    """应用数据目录（跨平台，由 platformdirs 决定）。"""
    return Path(user_data_dir("Book2Text", appauthor=False))


def scratch_dir() -> Path:
    return app_data_dir() / "scratch"


def _upload_dir(upload_id: str) -> Path:
    # 上传 ID 来自请求路径，必须先校验再拼接，避免路径穿越（说明书 4.4）。
    if not _UPLOAD_ID_PATTERN.match(upload_id):
        raise UploadError(f"上传 ID 格式不正确：{upload_id!r}")
    return scratch_dir() / upload_id


def pdf_path(upload_id: str) -> Path:
    return _upload_dir(upload_id) / "original.pdf"


def metadata_path(upload_id: str) -> Path:
    return _upload_dir(upload_id) / "upload.json"


def exists(upload_id: str) -> bool:
    try:
        return pdf_path(upload_id).is_file()
    except UploadError:
        return False


async def save_stream(chunks: AsyncIterator[bytes], original_name: str) -> UploadedFile:
    """边接收边写盘，同时计算 SHA-256，并校验 PDF magic bytes（说明书 4.5）。

    流式写入而不是先读进内存，是为了处理几百页的扫描书。
    任何失败都会清掉整个上传目录，不留半个文件。
    """
    upload_id = uuid.uuid4().hex
    target_dir = _upload_dir(upload_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "original.pdf"

    digest = hashlib.sha256()
    size = 0
    head = b""
    try:
        with target.open("wb") as handle:
            async for chunk in chunks:
                if not chunk:
                    continue
                if len(head) < len(PDF_MAGIC):
                    head += chunk[: len(PDF_MAGIC) - len(head)]
                digest.update(chunk)
                size += len(chunk)
                handle.write(chunk)

        if size == 0:
            raise UploadError("上传内容为空")
        if not head.startswith(PDF_MAGIC):
            raise UploadError("文件不是 PDF（magic bytes 校验失败）")
    except BaseException:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise

    return UploadedFile(
        upload_id=upload_id,
        path=target,
        size_bytes=size,
        sha256=digest.hexdigest(),
        original_name=original_name,
    )


def write_metadata(upload_id: str, **fields: Any) -> None:
    payload = {"upload_id": upload_id, **fields}
    path = metadata_path(upload_id)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def read_metadata(upload_id: str) -> dict[str, Any] | None:
    path = metadata_path(upload_id)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def delete(upload_id: str) -> bool:
    """删除一次上传。用于界面上清理，避免 scratch 无限增长。"""
    try:
        target_dir = _upload_dir(upload_id)
    except UploadError:
        return False
    if not target_dir.is_dir():
        return False
    shutil.rmtree(target_dir, ignore_errors=True)
    return True


def as_dict(uploaded: UploadedFile) -> dict[str, Any]:
    data = asdict(uploaded)
    data["path"] = str(data["path"])
    return data
