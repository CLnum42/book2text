"""测试共用夹具。"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.api.app import create_app
from book2text.core.storage import scratch

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLE_PDF = REPO_ROOT / "fixtures" / "pdf" / "synthetic-smoke-3pages.pdf"
SCAN_SAMPLE_PDF = REPO_ROOT / "fixtures" / "pdf" / "sample-20p-300dpi.pdf"
ROTATED_PDF = REPO_ROOT / "fixtures" / "pdf" / "rotated-page-90.pdf"

TEST_TOKEN = "test-session-token"
TEST_ORIGIN = "http://127.0.0.1:8765"


@pytest.fixture(scope="session")
def sample_pdf() -> Path:
    """Phase 0 的合成测试 PDF，用于渲染与上传链路的冒烟测试。

    真实的扫描样本书见 `scan_sample_pdf`；这个文件只验证"能上传、能渲染"。
    """
    if not SAMPLE_PDF.is_file():
        pytest.skip(f"缺少测试样本：{SAMPLE_PDF}")
    return SAMPLE_PDF


@pytest.fixture(scope="session")
def scan_sample_pdf() -> Path:
    """20 页真实书籍扫描样本（无文本层），见 docs/scan-sample-set.md。"""
    if not SCAN_SAMPLE_PDF.is_file():
        pytest.skip(f"缺少扫描样本：{SCAN_SAMPLE_PDF}")
    return SCAN_SAMPLE_PDF


@pytest.fixture(scope="session")
def rotated_pdf() -> Path:
    """声明 /Rotate=90 的单页 PDF。

    由 `scripts/make_test_fixtures.py` 生成——横向内容旋转后放进竖向页面，
    这正是真实扫描书的存储方式。**不要**改用 reportlab 的 setPageRotation，
    它生成的文件在 PDFium 与 PDFKit 里都渲染不出内容。
    """
    if not ROTATED_PDF.is_file():
        pytest.skip(f"缺少旋转页夹具：{ROTATED_PDF}")
    return ROTATED_PDF


@pytest.fixture
def scratch_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """把临时上传目录重定向到 pytest 的 tmp_path。

    否则测试会往真实的用户应用数据目录里写东西。
    """
    monkeypatch.setattr(scratch, "app_data_dir", lambda: tmp_path)
    yield tmp_path / "scratch"


@pytest.fixture
def client(scratch_dir: Path) -> Iterator[TestClient]:
    app = create_app(session_token=TEST_TOKEN, origins=[TEST_ORIGIN])
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"X-B2T-Token": TEST_TOKEN}
