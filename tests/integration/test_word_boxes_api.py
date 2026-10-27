"""字框回填接口（任务 59）：只写 word_boxes，别的字段一个字节都不动。"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module
from book2text.core.project import word_boxes as word_boxes_module
from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "字框", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def _snapshot(project_id: str, library_dir: Path) -> list[tuple]:
    """除 word_boxes 之外的全部行字段（验收：回填前后一致）。"""
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        return [
            tuple(row)
            for row in conn.execute(
                """
                SELECT line_id, block_id, line_index, bbox, text, aux_text, diff_status,
                       diff_ack, diff_ack_text
                FROM block_line ORDER BY line_id
                """
            ).fetchall()
        ]


def test_backfill_plan_and_write_only_word_boxes(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    started = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert started.status_code == 200, started.text
    before = _snapshot(project_id, library_dir)

    plan = client.get(
        f"/api/projects/{project_id}/word-boxes", headers=auth_headers
    ).json()
    assert plan["pages"] >= 1
    assert plan["lines"] >= 1

    result = client.post(
        f"/api/projects/{project_id}/word-boxes/backfill",
        json={"limit": 1},
        headers=auth_headers,
    )
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["updated_pages"] == 1
    assert data["backup_path"], "第一次写库前必须备份"

    # 只写了 word_boxes：其它字段逐字节一致
    assert _snapshot(project_id, library_dir) == before
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        filled = conn.execute(
            "SELECT COUNT(*) AS n FROM block_line WHERE word_boxes IS NOT NULL"
        ).fetchone()["n"]
    assert filled >= 1

    cleared = client.post(
        f"/api/projects/{project_id}/word-boxes/clear", headers=auth_headers
    ).json()
    assert cleared["cleared_lines"] >= 1
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        left = conn.execute(
            "SELECT COUNT(*) AS n FROM block_line WHERE word_boxes IS NOT NULL"
        ).fetchone()["n"]
    assert left == 0
    assert _snapshot(project_id, library_dir) == before


def test_word_boxes_are_stored_on_fresh_recognition(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """假引擎没有字框 → NULL；真实引擎回来时才有（这条只验字段能写进去）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    started = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert started.status_code == 200, started.text
    lines = blocks_module.list_block_lines(project_id, library=library_dir, page_no=1)
    assert lines
    assert all(line.word_boxes is None for line in lines), "假引擎不产生字框"
