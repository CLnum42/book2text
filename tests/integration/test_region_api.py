"""框选区域局部识别（任务 49）：只识别这一块，**不落库**。

验证三件事：
1. 结果把行框从"裁图坐标"映射回整页坐标；
2. 调用前后块 / 行 / 运行 / 事件的数量一个都不变（不建 Run、不建块、不写事件）；
3. 坏框被拒绝、引擎不可用时如实报 503。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import recognition
from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "框选识别", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def table_counts(library_dir: Path, project_id: str) -> dict[str, int]:
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        return {
            table: conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
            for table in ("block", "block_line", "ocr_run", "event")
        }


@pytest.fixture
def project_ready(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> str:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    return project_id


def test_region_recognition_returns_text_and_page_coordinates(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    project_ready: str,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = project_ready
    before = table_counts(library_dir, project_id)
    bbox = [0.2, 0.2, 0.6, 0.4]
    response = client.post(
        f"/api/projects/{project_id}/pages/1/recognize-region",
        json={"bbox": bbox},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["dpi"] == 300
    assert "第一段第一行。" in data["text"]
    assert len(data["lines"]) == 3
    # 行框映射回整页坐标：落在框选区域（外扩 2%）里
    crop = data["crop_bbox"]
    assert crop[0] <= bbox[0] and crop[1] <= bbox[1]
    assert crop[2] >= bbox[2] and crop[3] >= bbox[3]
    for line in data["lines"]:
        x0, y0, x1, y1 = line["bbox"]
        assert 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1
        assert crop[0] - 0.01 <= x0 and x1 <= crop[2] + 0.01
        assert crop[1] - 0.01 <= y0 and y1 <= crop[3] + 0.01
    # 文本是逐行的原文，没有润色 / 拼接
    assert data["text"].split("\n") == [line["text"] for line in data["lines"]]

    # **不落库**：块 / 行 / 运行 / 事件一个都没多
    assert table_counts(library_dir, project_id) == before


def test_bad_boxes_are_refused(
    client: TestClient, auth_headers: dict[str, str], project_ready: str
) -> None:
    for bbox in ([0.6, 0.2, 0.4, 0.4], [0.2, 0.2, 0.2, 0.4], [-0.1, 0.2, 0.4, 0.4], [1.2, 0.2, 0.4, 0.4]):
        response = client.post(
            f"/api/projects/{project_ready}/pages/1/recognize-region",
            json={"bbox": bbox},
            headers=auth_headers,
        )
        assert response.status_code in (400, 422), (bbox, response.text)


def test_engine_unavailable_is_503(
    client: TestClient,
    auth_headers: dict[str, str],
    project_ready: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dead = FakeOcrEngine(available=False, reason="没装模型")
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: dead)
    response = client.post(
        f"/api/projects/{project_ready}/pages/1/recognize-region",
        json={"bbox": [0.2, 0.2, 0.6, 0.4]},
        headers=auth_headers,
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "ocr_engine_unavailable"


def test_unknown_page_is_404(
    client: TestClient, auth_headers: dict[str, str], project_ready: str
) -> None:
    response = client.post(
        f"/api/projects/{project_ready}/pages/99/recognize-region",
        json={"bbox": [0.2, 0.2, 0.6, 0.4]},
        headers=auth_headers,
    )
    assert response.status_code == 404
