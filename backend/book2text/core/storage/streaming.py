"""流式写入文件（说明书 4.5：边传边算 SHA-256，不把整个文件读进内存）。

新建项目导入 PDF 时用：上传流边接收边写盘，大文件也不会占满内存。
"""

from __future__ import annotations

import hashlib
import shutil
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

PDF_MAGIC = b"%PDF-"


class StreamError(Exception):
    """上传内容不符合预期（为空、magic bytes 不符）。"""


@dataclass(frozen=True)
class StreamedFile:
    path: Path
    size_bytes: int
    sha256: str


async def stream_to_file(
    chunks: AsyncIterator[bytes],
    target: Path,
    *,
    expected_magic: bytes = PDF_MAGIC,
    failure_cleanup: Path | None = None,
) -> StreamedFile:
    """把数据流写入 `target`，同时计算 SHA-256 并校验 magic bytes。

    失败时删除 `failure_cleanup`（若给出），不留半个文件。
    """
    target.parent.mkdir(parents=True, exist_ok=True)

    digest = hashlib.sha256()
    size = 0
    head = b""
    try:
        with target.open("wb") as handle:
            async for chunk in chunks:
                if not chunk:
                    continue
                if len(head) < len(expected_magic):
                    head += chunk[: len(expected_magic) - len(head)]
                digest.update(chunk)
                size += len(chunk)
                handle.write(chunk)

        if size == 0:
            raise StreamError("上传内容为空")
        if not head.startswith(expected_magic):
            raise StreamError("文件不是 PDF（magic bytes 校验失败）")
    except BaseException:
        target.unlink(missing_ok=True)
        if failure_cleanup is not None:
            shutil.rmtree(failure_cleanup, ignore_errors=True)
        raise

    return StreamedFile(path=target, size_bytes=size, sha256=digest.hexdigest())
