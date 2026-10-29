"""force 通道：强制重识别「有人工成果」的页时，先备份整库再覆盖（2026-10-30）。

背景：默认行为是「有人工成果的页跳过、不覆盖」（说明书 R2，见 test_recognition_skip.py）。
用户确实要整页重来时，界面给一个显式的 force 通道——但覆盖人工成果是有代价的，
所以服务端在**建任务之前**先备份一次整库（`before-recognize`），备份失败就不建任务。

三条判据（与产品侧约定一致）：

1. force=false：行为完全不变（由 test_recognition_skip.py 的三条守着）；
2. force=true：块被新结果替换，且 backups/ 里出现 `before-recognize` 那份；
3. 备份失败（backups 目录不可写）：接口报错、**任务不建立**、块文本逐字未变。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.fakes import FakeOcrEngine

MANUAL_TEXT = "人工改过（这句只允许 force 覆盖）"


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "强制重识别", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def start_ocr(
    client: TestClient,
    headers: dict[str, str],
    project_id: str,
    *page_nos: int,
    force: bool = False,
) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": list(page_nos), "skip_recognized": False, "force": force},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def blocks_of(client: TestClient, headers: dict[str, str], project_id: str) -> list[dict]:
    response = client.get(f"/api/projects/{project_id}/pages/1/blocks", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["blocks"]


def jobs_of(client: TestClient, headers: dict[str, str], project_id: str) -> list[dict]:
    response = client.get(f"/api/projects/{project_id}/jobs", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["jobs"]


def backups_of(client: TestClient, headers: dict[str, str], project_id: str) -> list[dict]:
    response = client.get(f"/api/projects/{project_id}/backups", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["backups"]


def edit_block_text(
    client: TestClient, headers: dict[str, str], project_id: str, block: dict, text: str
) -> None:
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": text, "expected_revision": block["revision"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def test_force_replaces_human_work_and_backs_up_first(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """② force=true：块被替换；备份里的 note 是「重识别前的自动备份」。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    start_ocr(client, auth_headers, project_id, 1)

    blocks = blocks_of(client, auth_headers, project_id)
    assert blocks, "首次识别没有落块"
    edit_block_text(client, auth_headers, project_id, blocks[0], MANUAL_TEXT)
    assert backups_of(client, auth_headers, project_id) == [], "第一次识别不该产生备份"

    start_ocr(client, auth_headers, project_id, 1, force=True)

    after = blocks_of(client, auth_headers, project_id)
    assert all(block["text"] != MANUAL_TEXT for block in after), (
        "force=true 应当用新结果覆盖人工文本"
    )
    backups = backups_of(client, auth_headers, project_id)
    assert len(backups) == 1, f"force 重识别应当留下一份备份，实际 {backups}"
    assert backups[0]["note"] == "重识别前的自动备份", backups[0]

    job = jobs_of(client, auth_headers, project_id)[0]
    assert job["status"] == "succeeded", f"force 覆盖是成功，不是跳过（实际 {job['status']}）"
    assert job["skipped"] == 0
    assert job["done"] == 1


def test_force_backup_failure_does_not_create_job(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """③ 备份失败：接口报错、任务不建立、块文本逐字未变。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    start_ocr(client, auth_headers, project_id, 1)

    blocks = blocks_of(client, auth_headers, project_id)
    assert blocks, "首次识别没有落块"
    edit_block_text(client, auth_headers, project_id, blocks[0], MANUAL_TEXT)
    before_texts = [block["text"] for block in blocks_of(client, auth_headers, project_id)]
    before_jobs = len(jobs_of(client, auth_headers, project_id))

    backups_dir = library_dir / project_id / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(backups_dir, 0o500)
    try:
        response = client.post(
            f"/api/projects/{project_id}/jobs/ocr",
            json={"pages": [1], "skip_recognized": False, "force": True},
            headers=auth_headers,
        )
    finally:
        os.chmod(backups_dir, 0o700)

    assert response.status_code >= 400, (
        f"备份不可写时不该建任务，实际 {response.status_code}：{response.text}"
    )
    assert len(jobs_of(client, auth_headers, project_id)) == before_jobs, (
        "备份失败时任务不该被建立"
    )
    assert [block["text"] for block in blocks_of(client, auth_headers, project_id)] == before_texts, (
        "备份失败时块一个都不该变"
    )


def test_force_backup_survives_page_failure(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """④ 备份成功之后这一页失败了：备份必须留着（那是用户唯一的退路）。

    顺序是「建任务前备份 → 逐页覆盖」。所以页失败时：
    · 备份还在（退路没被"清理失败残留"顺手删掉）；
    · 人工文本没有被半覆盖（这一页根本没应用）；
    · 任务状态是 failed，不是 succeeded，也不是 succeeded_with_skips。
    """
    project_id = create_project(client, auth_headers, sample_pdf)
    start_ocr(client, auth_headers, project_id, 1)

    blocks = blocks_of(client, auth_headers, project_id)
    assert blocks, "首次识别没有落块"
    edit_block_text(client, auth_headers, project_id, blocks[0], MANUAL_TEXT)

    # 让 force 那一轮在识别阶段就失败（同一个假引擎，按页生效：这一批只有 1 页）
    inprocess_jobs._fail_message = "模拟引擎崩了"

    start_ocr(client, auth_headers, project_id, 1, force=True)

    backups = backups_of(client, auth_headers, project_id)
    assert len(backups) == 1, f"备份成功之后页失败，备份必须还在，实际 {backups}"
    assert backups[0]["note"] == "重识别前的自动备份", backups[0]

    texts = [block["text"] for block in blocks_of(client, auth_headers, project_id)]
    assert MANUAL_TEXT in texts, f"页失败了却把人工文本覆盖掉了：{texts}"

    job = jobs_of(client, auth_headers, project_id)[0]
    assert job["status"] == "failed", f"这一页失败了，任务不该报成功（实际 {job['status']}）"
    assert job["skipped"] == 0, "它是失败，不是跳过"
