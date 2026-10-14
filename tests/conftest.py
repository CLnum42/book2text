"""测试共用夹具。"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.api.app import create_app
from book2text.core.project import executor as executor_module
from book2text.core.project import recognition
from book2text.core.storage import scratch
from tests.fakes import FakeOcrEngine

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
def client(scratch_dir: Path, tmp_path: Path) -> Iterator[TestClient]:
    # 项目库也重定向到 tmp_path：否则测试会往用户真实的"文稿 / 文档"目录里写项目
    app = create_app(
        session_token=TEST_TOKEN,
        origins=[TEST_ORIGIN],
        library_dir=tmp_path / "Book2Text",
    )
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def library_dir(tmp_path: Path) -> Path:
    """一个空的项目库目录。"""
    library = tmp_path / "Book2Text"
    library.mkdir(parents=True, exist_ok=True)
    return library


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"X-B2T-Token": TEST_TOKEN}


@pytest.fixture
def minimal_project(tmp_path: Path) -> Path:
    """一个最小的可用项目目录：建库、跑迁移、写一行 project 与三行 page。

    给只关心**记录**（任务、块、运行）的单元测试用——不需要真的 PDF 与识别。
    """
    from book2text.core.storage import db as db_module

    directory = tmp_path / "b2t_TESTS1"
    directory.mkdir()
    with db_module.open_database(directory) as conn:
        conn.execute(
            """
            INSERT INTO project (project_id, name, source_file_name, source_sha256,
                                 page_count, created_at, updated_at, schema_version)
            VALUES ('b2t_TESTS1', '测试项目', 'sample.pdf', 'x' * 64, 3,
                    '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', 2)
            """
        )
        conn.executemany(
            """
            INSERT INTO page (page_id, page_no, page_label, width_pt, height_pt, rotation,
                              page_type, include, has_text_layer)
            VALUES (?, ?, '', 595.0, 842.0, 0, 'body', 1, 0)
            """,
            [(f"page{index}", index) for index in (1, 2, 3)],
        )
        conn.commit()
    return directory


@pytest.fixture
def inprocess_jobs(monkeypatch: pytest.MonkeyPatch) -> FakeOcrEngine:
    """把"起子进程跑识别"换成本进程同步跑，并注入假引擎。

    测试要验证的是**任务的状态机与落库**，不是进程管理——真子进程那条路由
    `tests/integration/test_worker_subprocess.py` 用真引擎覆盖（需要 ocr 依赖）。
    换掉 `Supervisor.start` 之后，接口层看到的仍然是一份真实的任务记录，
    只是它已经跑完了。
    """
    engine = FakeOcrEngine()
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: engine)

    def fake_start(self, directory, job_id):  # noqa: ANN001 - 与 Supervisor.start 同形
        recognition.run_job(directory, job_id, engine=engine)
        return 0

    monkeypatch.setattr(executor_module.Supervisor, "start", fake_start)
    return engine
