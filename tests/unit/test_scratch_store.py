"""临时上传存储测试。

重点是安全问题：上传 ID 来自请求路径，必须挡住路径穿越（说明书 4.4）。
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from book2text.core.storage import scratch


async def _chunks(*parts: bytes) -> AsyncIterator[bytes]:
    for part in parts:
        yield part


def _save(*parts: bytes, name: str = "sample.pdf"):
    return asyncio.run(scratch.save_stream(_chunks(*parts), name))


def test_save_stream_computes_hash_and_size(scratch_dir: Path, sample_pdf: Path) -> None:
    data = sample_pdf.read_bytes()
    uploaded = _save(data, name="sample.pdf")

    assert uploaded.sha256 == hashlib.sha256(data).hexdigest()
    assert uploaded.size_bytes == len(data)
    assert uploaded.path.is_file()
    assert uploaded.path.name == "original.pdf"
    assert uploaded.original_name == "sample.pdf"


def test_save_stream_handles_many_small_chunks(scratch_dir: Path, sample_pdf: Path) -> None:
    """分块到达时哈希必须与整块一致——流式上传正是这么走的。"""
    data = sample_pdf.read_bytes()
    chunk_size = 512
    parts = [data[i : i + chunk_size] for i in range(0, len(data), chunk_size)]
    uploaded = _save(*parts)

    assert uploaded.sha256 == hashlib.sha256(data).hexdigest()
    assert uploaded.size_bytes == len(data)


def test_pdf_magic_split_across_chunks_is_accepted(scratch_dir: Path, sample_pdf: Path) -> None:
    """magic bytes 被切在两个分块之间时也要认出来。"""
    data = sample_pdf.read_bytes()
    uploaded = _save(data[:2], data[2:5], data[5:])
    assert uploaded.size_bytes == len(data)


def test_save_stream_rejects_non_pdf(scratch_dir: Path) -> None:
    with pytest.raises(scratch.UploadError, match="magic bytes"):
        _save(b"this is plainly not a pdf")


def test_save_stream_rejects_empty_upload(scratch_dir: Path) -> None:
    with pytest.raises(scratch.UploadError, match="为空"):
        _save(b"")


def test_rejected_upload_leaves_nothing_behind(scratch_dir: Path) -> None:
    with pytest.raises(scratch.UploadError):
        _save(b"nope")
    # 失败的目录必须被清掉，不能留半个文件
    leftovers = list(scratch_dir.iterdir()) if scratch_dir.exists() else []
    assert leftovers == []


@pytest.mark.parametrize(
    "bad_id",
    [
        "",
        "abc",
        "..",
        "../etc",
        "../../../etc/passwd",
        "d652d6406a08416b91c5fb5b09faf72C",  # 大写
        "g" * 32,                             # 非十六进制
        "d652d6406a08416b91c5fb5b09faf72",    # 31 位
        "d652d6406a08416b91c5fb5b09faf72cc",  # 33 位
        "d652d6406a08416b91c5fb5b09faf72c/..",
    ],
)
def test_upload_id_validation_blocks_path_traversal(scratch_dir: Path, bad_id: str) -> None:
    with pytest.raises(scratch.UploadError):
        scratch.pdf_path(bad_id)
    with pytest.raises(scratch.UploadError):
        scratch._upload_dir(bad_id)


def test_valid_upload_id_resolves_inside_scratch_dir(scratch_dir: Path) -> None:
    good_id = "d652d6406a08416b91c5fb5b09faf72c"
    resolved = scratch.pdf_path(good_id).resolve()
    assert str(resolved).startswith(str(scratch.scratch_dir().resolve()))


def test_exists_and_delete(scratch_dir: Path, sample_pdf: Path) -> None:
    uploaded = _save(sample_pdf.read_bytes())
    assert scratch.exists(uploaded.upload_id) is True
    assert scratch.delete(uploaded.upload_id) is True
    assert scratch.exists(uploaded.upload_id) is False
    assert scratch.delete(uploaded.upload_id) is False


def test_metadata_round_trip(scratch_dir: Path, sample_pdf: Path) -> None:
    uploaded = _save(sample_pdf.read_bytes())
    scratch.write_metadata(uploaded.upload_id, page_count=3, original_name="sample.pdf")

    metadata = scratch.read_metadata(uploaded.upload_id)
    assert metadata is not None
    assert metadata["upload_id"] == uploaded.upload_id
    assert metadata["page_count"] == 3
    assert metadata["original_name"] == "sample.pdf"


def test_missing_metadata_returns_none(scratch_dir: Path) -> None:
    assert scratch.read_metadata("d652d6406a08416b91c5fb5b09faf72c") is None
