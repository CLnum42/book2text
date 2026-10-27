"""第二引擎可选 + 文字层当第二引擎（任务 58）。

两件事：
1. 有文字层的页不再跑 Vision，直接读文字层，写进 `aux_text` / `diff_status`，
   引擎记成 `pdf_text_layer`；
2. 步骤完成判定只看主引擎——第二引擎 0 页不挡完成。
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module
from book2text.core.project import recognition
from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


def _create_recognized(
    client: TestClient,
    headers: dict[str, str],
    pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    """建项目并识别第 1 页（假引擎：2 块 3 行），返回项目 id。"""
    response = client.post(
        "/api/projects",
        params={"name": "文字层", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    project_id = response.json()["project"]["project_id"]
    started = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1, 2, 3], "skip_recognized": False},
        headers=headers,
    )
    assert started.status_code == 200, started.text
    return project_id


def _lines(project_id: str, library_dir: Path, page_no: int = 1):
    return blocks_module.list_block_lines(project_id, library=library_dir, page_no=page_no)


def test_text_layer_is_used_without_running_the_engine(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = _create_recognized(client, auth_headers, sample_pdf, inprocess_jobs)
    before = _lines(project_id, library_dir)

    result = recognition.run_auxiliary(
        library_dir / project_id, 1, prefer_text_layer=True
    )

    assert result["engine_id"] == recognition.TEXT_LAYER_ENGINE_ID
    assert result["source"] == "text_layer"
    # 只写候选与分歧状态；块文本一个字不动
    after = _lines(project_id, library_dir)
    assert [line.text for line in after] == [line.text for line in before]
    assert all(line.text == before_item.text for line, before_item in zip(after, before))


def test_auxiliary_run_records_the_text_layer_source(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = _create_recognized(client, auth_headers, sample_pdf, inprocess_jobs)
    result = recognition.run_auxiliary(
        library_dir / project_id, 1, prefer_text_layer=True
    )

    with db_module.open_database(library_dir / project_id) as conn:
        run = conn.execute(
            "SELECT engine_id, params_json FROM ocr_run WHERE run_id = ?",
            (result["run_id"],),
        ).fetchone()
    assert run["engine_id"] == recognition.TEXT_LAYER_ENGINE_ID
    assert '"source": "text_layer"' in run["params_json"]


def test_main_engine_completion_does_not_wait_for_the_second_engine(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """主引擎跑完就算完成：第二引擎 0 页不许把识别步卡成灰。"""
    project_id = _create_recognized(client, auth_headers, sample_pdf, inprocess_jobs)
    data = client.get(
        f"/api/projects/{project_id}/review/finish-summary", headers=auth_headers
    ).json()

    assert data["engine"]["checked"] == 0, "这一本还没跑第二引擎"
    assert data["engine"]["aux_complete"] is False
    assert data["engine"]["main_complete"] is True
    assert data["engine"]["complete"] is True
