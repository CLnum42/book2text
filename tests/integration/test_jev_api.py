"""Jev 排序接口：探测 / 拒绝建任务 / 清除（2026-11-05）。

真引擎那条（llama.cpp + 打分服务 + 40 页项目）不在自动化里——它要 2.7 GB 模型和常驻服务。
这里锁的是"环境不齐时**不建任务**、队列不动"与"清除幂等"。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import jobs as jobs_module
from book2text.core.storage import db as db_module


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "Jev 测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def test_ready_reports_missing_environment(client: TestClient, auth_headers: dict[str, str], sample_pdf: Path) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)

    data = client.get(f"/api/projects/{project_id}/jev-priority/ready", headers=auth_headers).json()

    assert data["ready"] is False
    assert data["problems"], "环境不齐时必须说清缺什么"
    assert data["scored"] == 0


def test_start_refuses_without_engine_and_creates_no_job(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)

    response = client.post(f"/api/projects/{project_id}/jev-priority/start", headers=auth_headers)

    assert response.status_code == 503, response.text
    assert response.json()["error"]["code"] == "jev_unavailable"
    # 队列不动：一个任务都没建
    assert jobs_module.list_jobs(library_dir / project_id, limit=10) == []


def test_clear_is_idempotent_and_writes_event_only_when_clearing(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)

    first = client.post(f"/api/projects/{project_id}/jev-priority/clear", headers=auth_headers)
    assert first.status_code == 200
    assert first.json()["cleared"] == 0

    # 手工写一个分数再清：应当清掉并留下一条 event
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        page = conn.execute("SELECT page_id FROM page LIMIT 1").fetchone()["page_id"]
        conn.execute(
            "INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,"
            " ocr_text, text, include, continues_to_next, created_at, updated_at)"
            " VALUES ('b1', ?, 'ocr', 0, '[0.1,0.1,0.9,0.2]', 'paragraph', '甲', '甲', 1, 0,"
            " '2026-01-01', '2026-01-01')",
            (page,),
        )
        conn.execute(
            "INSERT INTO block_line (line_id, block_id, line_index, bbox, text, jev_score)"
            " VALUES ('l1', 'b1', 0, '[0.1,0.1,0.9,0.2]', '甲', 0.02)"
        )
        conn.commit()

    second = client.post(f"/api/projects/{project_id}/jev-priority/clear", headers=auth_headers)

    assert second.status_code == 200
    assert second.json()["cleared"] == 1
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM block_line WHERE jev_score IS NOT NULL").fetchone()["n"] == 0
        event = conn.execute(
            "SELECT action FROM event WHERE action = 'jev_priority_cleared'"
        ).fetchone()
    assert event is not None
