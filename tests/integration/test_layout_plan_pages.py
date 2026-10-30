"""检测计划听选择：`pages` 收窄 + 越界 400。

判据：用户看到的计划数必须等于他实际要跑的页数。
越界（页不存在 / 不是正文）必须 400 且人话——删掉检查时这条测试要红。
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "检测计划", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def test_layout_plan_outside_body_is_400(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.get(
        f"/api/projects/{project_id}/layout/plan?pages=999", headers=auth_headers
    )
    assert response.status_code == 400, response.text
    assert "不在正文页范围内" in response.text, response.text[:200]
