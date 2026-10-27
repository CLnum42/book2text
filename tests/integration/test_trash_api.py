"""项目删除 / 废纸篓（任务 35）的接口测试。"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from book2text.core.project import jobs as jobs_module
from book2text.core.project import library as library_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "废纸篓测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(
    client: TestClient, headers: dict[str, str], project_id: str, pages: list[int]
) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": pages, "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def project_ids(client: TestClient, headers: dict[str, str]) -> list[str]:
    response = client.get("/api/projects", headers=headers)
    assert response.status_code == 200, response.text
    return [item["project_id"] for item in response.json()["projects"]]


def test_trash_restore_and_permanent_delete(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, [1, 2, 3])
    directory = library_dir / project_id
    assert directory.is_dir()
    assert project_ids(client, auth_headers) == [project_id]

    # 删除必须二次确认
    refused = client.delete(f"/api/projects/{project_id}", headers=auth_headers)
    assert refused.status_code == 400
    assert refused.json()["error"]["code"] == "confirmation_required"

    trashed = client.delete(
        f"/api/projects/{project_id}?confirm=true", headers=auth_headers
    )
    assert trashed.status_code == 200, trashed.text
    assert trashed.json()["project"]["page_count"] == 3
    assert project_ids(client, auth_headers) == []
    assert not directory.exists()
    trashed_dir = library_dir / library_module.TRASH_DIR_NAME / project_id
    assert trashed_dir.is_dir()

    # 按项目 ID 的接口也看不到它（前后台一致）
    assert client.get(f"/api/projects/{project_id}", headers=auth_headers).status_code == 404

    listing = client.get("/api/trash", headers=auth_headers).json()
    assert listing["count"] == 1
    entry = listing["projects"][0]
    assert entry["project_id"] == project_id
    assert entry["name"] == "废纸篓测试"
    assert entry["page_count"] == 3
    assert entry["deleted_at"]

    # 恢复：目录搬回、页数 / 识别状态还在
    restored = client.post(
        f"/api/trash/{project_id}/restore", headers=auth_headers
    )
    assert restored.status_code == 200, restored.text
    assert directory.is_dir()
    assert not trashed_dir.exists()
    assert project_ids(client, auth_headers) == [project_id]
    opened = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()
    assert opened["project"]["page_count"] == 3
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()
    assert len(pages["pages"]) == 3
    preflight = client.post(
        f"/api/projects/{project_id}/export/preflight",
        json={"format": "txt"},
        headers=auth_headers,
    )
    assert preflight.status_code == 200, preflight.text
    assert preflight.json()["workflow_status"]["total"] == 3

    # 再删一次，然后彻底删除（真删目录）
    client.delete(f"/api/projects/{project_id}?confirm=true", headers=auth_headers)
    purge_refused = client.delete(
        f"/api/trash/{project_id}", headers=auth_headers
    )
    assert purge_refused.status_code == 400
    purged = client.delete(
        f"/api/trash/{project_id}?confirm=true", headers=auth_headers
    )
    assert purged.status_code == 200, purged.text
    assert not trashed_dir.exists()
    assert client.get("/api/trash", headers=auth_headers).json()["count"] == 0


def test_busy_project_is_refused(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    opened = client.post(f"/api/projects/{project_id}/open", headers=auth_headers)
    assert opened.status_code == 200, opened.text

    busy = client.delete(
        f"/api/projects/{project_id}?confirm=true", headers=auth_headers
    )
    assert busy.status_code == 409
    assert busy.json()["error"]["code"] == "project_busy"
    assert busy.json()["error"]["detail"]
    assert project_ids(client, auth_headers) == [project_id]

    client.post(f"/api/projects/{project_id}/close", headers=auth_headers)
    ok = client.delete(f"/api/projects/{project_id}?confirm=true", headers=auth_headers)
    assert ok.status_code == 200, ok.text


def test_active_job_blocks_delete(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    directory = library_dir / project_id
    # 造一个"排队中"的任务：即使项目没被打开，也不能删
    pages = client.get(
        f"/api/projects/{project_id}/pages", headers=auth_headers
    ).json()["pages"]
    jobs_module.create_job(
        directory,
        pages=[(pages[0]["page_id"], pages[0]["page_no"])],
        params={"pages": [1]},
    )
    busy = client.delete(
        f"/api/projects/{project_id}?confirm=true", headers=auth_headers
    )
    assert busy.status_code == 409
    assert busy.json()["error"]["code"] == "project_busy"
    assert "任务" in busy.json()["error"]["detail"]
