"""批量识别：范围形态的 human-touched + exclude_pages（越界必须 fail loud）。

两条判据都落在「平时不触发、一旦触发就静默漏跑」的地方：
· scope 形态走 resolve_pages（不自己算 pending）——反证是 pages 必须随范围变化
· exclude_pages 里出现不属于本范围的页 → 400（不许静默忽略）
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "范围与排除", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def test_human_touched_scope_uses_resolve_pages(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """① scope 形态：total = 该范围的页数，pages 是其子集且都为 human_touched。"""
    project_id = create_project(client, auth_headers, sample_pdf)

    response = client.get(
        f"/api/projects/{project_id}/pages/human-touched?scope=unrecognized",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["total"] >= 1, "新建项目应当有未识别页"
    assert data["total"] == len(client.get(
        f"/api/projects/{project_id}/pages", headers=auth_headers
    ).json()["pages"]), "未识别范围应当覆盖全部页面（此时都还没识别）"
    assert data["count"] == sum(1 for row in data["pages"] if row["human_touched"])
    assert all(row["page_no"] <= data["total"] for row in data["pages"])

    # 两个都给 → 400（二选一）
    both = client.get(
        f"/api/projects/{project_id}/pages/human-touched?scope=unrecognized&pages=1",
        headers=auth_headers,
    )
    assert both.status_code == 400, both.text


def test_exclude_pages_outside_range_is_400(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """② 排除页不属于本次范围 → 400（fail loud，不许静默漏跑）。"""
    project_id = create_project(client, auth_headers, sample_pdf)

    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"scope": "unrecognized", "exclude_pages": [999]},
        headers=auth_headers,
    )
    assert response.status_code == 400, response.text
    body = response.json()
    text = str(body)
    assert "不在本次识别范围内" in text, f"错误信息应点名越界，实际：{text[:200]}"
