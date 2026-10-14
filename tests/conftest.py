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

TEST_TOKEN = "test-session-token"
TEST_ORIGIN = "http://127.0.0.1:8765"


@pytest.fixture(scope="session")
def sample_pdf() -> Path:
    """Phase 0 的合成测试 PDF。

    真实的扫描样本书尚未制作（说明书 13.1 的前置输入），
    这个文件只用于验证「能上传、能渲染」这条链路，不用于评估识别质量。
    """
    if not SAMPLE_PDF.is_file():
        pytest.skip(f"缺少测试样本：{SAMPLE_PDF}")
    return SAMPLE_PDF


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
