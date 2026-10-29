"""`GET /pages/human-touched` 的五条契约（重新识别前先问它"哪些页有人工成果"）。

判据源**只有一份**：后端 `_has_human_results`（recognition.py:1645）。测试里的"人工痕迹"
必须真的造成 `text != ocr_text`（改块 text），不是 mock 一个返回值——否则测的是替身，不是产品。

语义选择写明：**不存在的页号 → 整请求 400**，不是"静默跳过"。
静默跳过会让前端以为"这些页没人改过、可以放心覆盖"，而那正是这一批要防的谎报。
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from tests.fakes import FakeOcrEngine

MANUAL_TEXT = "人工改过（这句不许被识别覆盖）"


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "人工痕迹", "filename": pdf.name},
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
    response = client.get(f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["blocks"]


def edit_block_text(client: TestClient, headers: dict[str, str], project_id: str, block: dict) -> None:
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": MANUAL_TEXT, "expected_revision": block["revision"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def human_touched(client: TestClient, headers: dict[str, str], project_id: str, pages: str) -> tuple[int, dict]:
    response = client.get(
        f"/api/projects/{project_id}/pages/human-touched", params={"pages": pages}, headers=headers
    )
    return response.status_code, (response.json() if response.headers.get("content-type", "").startswith("application/json") else {})


def test_human_touched_two_pages_count_2(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> None:
    """① 两页都有人工痕迹 → count == 2，page_no 对得上且按升序。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1, 2)
    for page_no in (1, 2):
        blocks = blocks_of(client, auth_headers, project_id, page_no)
        assert blocks, f"第 {page_no} 页首次识别没有落块"
        edit_block_text(client, auth_headers, project_id, blocks[0])

    status, body = human_touched(client, auth_headers, project_id, "2,1")
    assert status == 200, body
    assert body["count"] == 2, body
    assert [row["page_no"] for row in body["pages"]] == [1, 2], "结果必须按 page_no 升序"


def test_human_touched_all_clean_count_0(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> None:
    """② 刚识别完、没人改过 → count == 0。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)

    status, body = human_touched(client, auth_headers, project_id, "1")
    assert status == 200, body
    assert body["count"] == 0, body
    assert body["pages"] == [{"page_no": 1, "human_touched": False}], body


def test_human_touched_out_of_range_rejects_whole_request(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> None:
    """③ 越界页号 → 400 page_not_found，且 detail 带本项目页码范围（可行动的错误信息）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    status, body = human_touched(client, auth_headers, project_id, "999")
    assert status == 400, body
    assert body["error"]["code"] == "page_not_found", body
    detail = body["error"].get("detail") or ""
    assert "本项目页码" in detail, f"detail 应给可行动的页码范围，实际 {detail!r}"


def test_human_touched_unknown_page_rejects_whole_request(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> None:
    """④ 不存在的页号 → **整请求 400**（不是 200 + 静默跳过）。

    测试名里写明 rejects_whole_request：静默跳过会让前端以为"没人改过、可以放心覆盖"，
    而那是这一批要防的谎报。以后谁想"优化"成跳过，这条名字会先拦住。
    """
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    status, body = human_touched(client, auth_headers, project_id, "1,999")
    assert status == 400, f"整请求必须拒绝，实际 {status} {body}"
    assert body["error"]["code"] == "page_not_found", body


def test_human_touched_empty_pages_400(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> None:
    """⑤ pages 空 / 非数字 → 400 bad_pages（不许静默返回 count=0）。"""
    project_id = create_project(client, auth_headers, sample_pdf)

    status, body = human_touched(client, auth_headers, project_id, "")
    assert status == 400, body
    assert body["error"]["code"] == "bad_pages", body

    status, body = human_touched(client, auth_headers, project_id, "a,b")
    assert status == 400, body
    assert body["error"]["code"] == "bad_pages", body
