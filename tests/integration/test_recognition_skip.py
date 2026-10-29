"""有人工痕迹的页再识别：不覆盖，记「跳过」（刀 2.5 的识别侧行为）。

三条都是**走 API 验用户能观察到的结果**（块文本 + 任务的 skipped），不直接调
`_persist_blocks`——函数改名时这类测试不该假红。

背景（2026-10-30）：`applied = not has_active or not _has_human_results(...)` 里的
`not has_active` 会让"页面上没有 active run 但有人工成果"的页被整页覆盖。
用户看到"识别完成"，改过的文本却没了。收紧成只调 `_has_human_results` 之后，
这类页改为**跳过**：块不动、任务记 skipped（独立计数，不进 done、不进 failed）。

先红方式：把 applied 改回 `not has_active or not _has_human_results(conn, page_id)`
→ ① 必须红，且红的形态是「块被替换」，不是接口 500。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.fakes import FakeOcrEngine

MANUAL_TEXT = "人工改过（这句不许被识别覆盖）"


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "跳过人工页", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, *page_nos: int) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": list(page_nos), "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def blocks_of(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> list[dict]:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()["blocks"]


def latest_job(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/jobs", headers=headers)
    assert response.status_code == 200, response.text
    jobs = response.json()["jobs"]
    assert jobs, "任务列表为空"
    return jobs[0]


def edit_block_text(
    client: TestClient, headers: dict[str, str], project_id: str, block: dict, text: str
) -> None:
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": text, "expected_revision": block["revision"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def test_human_touched_page_is_skipped_not_overwritten(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """① 有人工痕迹 + 再识别 → 块文本逐字不变；任务记 skipped=1，done 不含该页。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)

    blocks = blocks_of(client, auth_headers, project_id)
    assert blocks, "首次识别没有落块"
    first = blocks[0]
    edit_block_text(client, auth_headers, project_id, first, MANUAL_TEXT)

    recognize(client, auth_headers, project_id, 1)

    after = blocks_of(client, auth_headers, project_id)
    edited = next(item for item in after if item["block_id"] == first["block_id"])
    assert edited["text"] == MANUAL_TEXT, "人工改过的文本被识别覆盖了——applied 的收紧失效"

    job = latest_job(client, auth_headers, project_id)
    assert job["skipped"] == 1, f"该页应记为跳过，实际 skipped={job.get('skipped')}（job={job})"
    assert job["done"] == 0, f"跳过不许算进 done（done={job['done']}）"
    assert job["status"] == "succeeded_with_skips", (
        f"全部页都被跳过时任务状态应为 succeeded_with_skips，实际 {job['status']}"
    )
    assert job["failed"] == 0, "跳过不是失败"


def test_clean_page_is_replaced_normally(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """② 无人工痕迹 → 正常替换，skipped=0。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)

    first_round = [item["text"] for item in blocks_of(client, auth_headers, project_id)]
    assert first_round, "首次识别没有落块"

    recognize(client, auth_headers, project_id, 1)
    second_round = [item["text"] for item in blocks_of(client, auth_headers, project_id)]

    assert second_round == first_round, "无人工痕迹时应当照常替换成新一轮结果"
    job = latest_job(client, auth_headers, project_id)
    assert job["skipped"] == 0, f"没有人工痕迹不该跳过，实际 skipped={job['skipped']}"
    assert job["status"] == "succeeded"


def test_first_recognition_on_empty_page(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """③ 页上还没有块（首次识别）→ 正常落库，skipped=0，不抛。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    assert blocks_of(client, auth_headers, project_id) == []

    recognize(client, auth_headers, project_id, 1)

    assert blocks_of(client, auth_headers, project_id), "首次识别应当正常落库"
    job = latest_job(client, auth_headers, project_id)
    assert job["skipped"] == 0
    assert job["status"] == "succeeded"


def test_human_touched_page_without_active_run_is_not_overwritten(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """④ 有人工痕迹 **且 page.active_run_id 为 NULL** → 仍然不许覆盖。

    这一条才是 `not has_active` 被删掉的意义所在：旧式
    ``applied = not has_active or not _has_human_results(...)`` 在 active_run 为空时
    直接 applied=True，于是整页软删重建——用户改过的文本就没了，而软删除在界面上
    找不回来（说明书 R2 / 用户数据优先）。

    造这个状态：首次识别 → 改一个块 → 把 page.active_run_id 置 NULL（模拟运行指针丢失）。
    然后重新识别：块必须原样保留，任务记 skipped=1。
    """
    from backend.book2text.core.storage import db as db_module

    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)

    blocks = blocks_of(client, auth_headers, project_id)
    assert blocks, "首次识别没有落块"
    first = blocks[0]
    edit_block_text(client, auth_headers, project_id, first, MANUAL_TEXT)

    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        conn.execute("UPDATE page SET active_run_id = NULL WHERE page_no = 1")
        conn.commit()
        row = conn.execute(
            "SELECT active_run_id FROM page WHERE page_no = 1"
        ).fetchone()
    assert row["active_run_id"] is None, "夹具没把 active_run_id 置空"

    recognize(client, auth_headers, project_id, 1)

    after = blocks_of(client, auth_headers, project_id)
    after_ids = [item["block_id"] for item in after]
    # 先断言"旧块还在"：覆盖发生时是整页软删重建，旧 block_id 会消失，
    # 直接 next(...) 找块会抛 StopIteration——那种红读不出"人工文本被冲掉"这件事。
    assert first["block_id"] in after_ids, (
        "旧块被替换了：没有 active run 但有人工成果时整页软删重建，人工文本随之丢失"
        f"（覆盖前 block_id={first['block_id']}，覆盖后={after_ids}）"
    )
    edited = next(item for item in after if item["block_id"] == first["block_id"])
    assert edited["text"] == MANUAL_TEXT, (
        f"人工改过的文本被覆盖了（期望 {MANUAL_TEXT!r}，实际 {edited['text']!r}）"
    )
    job = latest_job(client, auth_headers, project_id)
    assert job["skipped"] == 1
    assert job["status"] == "succeeded_with_skips"
