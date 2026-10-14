"""采用 / 保留新识别结果的集成测试（说明书 5.4 的 R2 后半段、第 11 节的 apply）。

R2 说：页面已有人工成果时，新运行只保存为"待选结果"，用户在审校视图中左右对比，
选择 [采用新结果]（旧块软删除，可撤销）或 [保留现有]。

这一组测试的重点是**"系统绝不自动覆盖人工成果"的另一面**：
用户想采用的时候，得真的能采用；想保留的时候，提示得真的消失。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "候选结果", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, page_no: int) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [page_no], "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def blocks_of(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> dict:
    return client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    ).json()


def simulate_human_edit(library_dir: Path, project_id: str, block_id: str, text: str) -> None:
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE block SET text = ?, review_status = 'confirmed', revision = revision + 1"
            " WHERE block_id = ?",
            (text, block_id),
        )
        conn.commit()


@pytest.fixture
def page_with_candidate(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> tuple[str, dict]:
    """一页**有候选结果**的页面：先识别，再人工改一块，然后重新识别。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    current = blocks_of(client, auth_headers, project_id, 1)
    simulate_human_edit(
        library_dir, project_id, current["blocks"][0]["block_id"], "人工改过的第一段。"
    )
    recognize(client, auth_headers, project_id, 1)

    after = blocks_of(client, auth_headers, project_id, 1)
    assert after["page"]["recognition"]["status"] == "has_candidate"
    return project_id, after


# ---------------------------------------------------------------- 对比

def test_candidate_payload_has_the_new_blocks(
    client: TestClient, auth_headers: dict[str, str], page_with_candidate
) -> None:
    project_id, after = page_with_candidate
    run_id = after["page"]["recognition"]["pending_run_id"]

    response = client.get(
        f"/api/projects/{project_id}/pages/1/candidate", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["run"]["run_id"] == run_id
    candidate = data["candidate"]
    assert candidate["blocks"], "候选结果要有块（原始输出里存着分段）"
    assert candidate["regrouped"] is False, "采用的就是用户对比过的那一份分组"
    assert candidate["blocks"][0]["text"] == "第一段第一行。\n第一段第二行。"
    assert len(candidate["blocks"]) == 2

    # 左边是现有的块（含人工改动）
    assert data["current"]["blocks"][0]["text"] == "人工改过的第一段。"
    assert data["current"]["review"]["confirmed"] == 1


def test_candidate_is_refused_when_there_is_none(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    response = client.get(
        f"/api/projects/{project_id}/pages/1/candidate", headers=auth_headers
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "no_candidate"


# ---------------------------------------------------------------- 采用

def test_apply_replaces_blocks_and_switches_the_active_run(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, page_with_candidate
) -> None:
    project_id, after = page_with_candidate
    run_id = after["page"]["recognition"]["pending_run_id"]
    old_block_ids = {block["block_id"] for block in after["blocks"]}

    response = client.post(
        f"/api/projects/{project_id}/pages/1/runs/{run_id}/apply", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["page"]["recognition"]["status"] == "recognized"
    assert data["page"]["recognition"]["active_run_id"] == run_id
    assert data["blocks"][0]["text"] == "第一段第一行。\n第一段第二行。", "块换成了新结果"
    assert {block["block_id"] for block in data["blocks"]}.isdisjoint(old_block_ids)
    assert data["blocks"][0]["origin"] == "ocr"
    assert data["blocks"][0]["review_status"] == "unreviewed", "新结果要重新审"

    # 旧块是软删除（说明书 5.1）
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT deleted_at FROM block WHERE block_id = ?", (next(iter(old_block_ids)),)
        ).fetchall()
    assert rows and rows[0]["deleted_at"]


def test_apply_is_undoable(
    client: TestClient, auth_headers: dict[str, str], page_with_candidate
) -> None:
    """说明书 R2 明说"旧块软删除，**可撤销**"——撤销要把块和 active run 一起还原。"""
    project_id, after = page_with_candidate
    run_id = after["page"]["recognition"]["pending_run_id"]
    old_ids = [block["block_id"] for block in after["blocks"]]
    old_active = after["page"]["recognition"]["active_run_id"]

    client.post(
        f"/api/projects/{project_id}/pages/1/runs/{run_id}/apply", headers=auth_headers
    )
    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undone.status_code == 200, undone.text
    data = undone.json()

    assert [block["block_id"] for block in data["blocks"]] == old_ids, "旧块回来了"
    assert data["blocks"][0]["text"] == "人工改过的第一段。", "人工成果回来了"
    assert data["blocks"][0]["review_status"] == "confirmed"
    assert data["page"]["recognition"]["active_run_id"] == old_active, "active run 也换回去"
    assert data["page"]["recognition"]["status"] == "has_candidate", "候选还在，可以再决定"


# ---------------------------------------------------------------- 保留现有

def test_decline_keeps_blocks_and_clears_the_prompt(
    client: TestClient, auth_headers: dict[str, str], page_with_candidate
) -> None:
    """保留现有之后，提示必须真的消失——否则用户关不掉它。"""
    project_id, after = page_with_candidate
    run_id = after["page"]["recognition"]["pending_run_id"]
    before_ids = [block["block_id"] for block in after["blocks"]]

    response = client.post(
        f"/api/projects/{project_id}/pages/1/runs/{run_id}/decline", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()

    assert [block["block_id"] for block in data["blocks"]] == before_ids, "块一点没动"
    assert data["blocks"][0]["text"] == "人工改过的第一段。"
    assert data["page"]["recognition"]["status"] == "recognized", "提示消失了"
    assert data["page"]["recognition"]["pending_run_id"] is None
    assert data["history"]["undo"] == 0, "保留现有没改数据，不进撤销栈"


def test_a_later_run_becomes_a_candidate_again(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    page_with_candidate,
) -> None:
    """决定**之后**再产生的运行仍然是新候选（"保留现有"不是一劳永逸的封杀）。"""
    import time

    project_id, after = page_with_candidate
    first_run = after["page"]["recognition"]["pending_run_id"]
    client.post(
        f"/api/projects/{project_id}/pages/1/runs/{first_run}/decline", headers=auth_headers
    )
    assert blocks_of(client, auth_headers, project_id, 1)["page"]["recognition"]["status"] == (
        "recognized"
    )

    time.sleep(1.1)  # created_at 是秒级时间戳，跨过一秒才排得清先后
    recognize(client, auth_headers, project_id, 1)
    again = blocks_of(client, auth_headers, project_id, 1)
    assert again["page"]["recognition"]["status"] == "has_candidate"
    assert again["page"]["recognition"]["pending_run_id"] != first_run


def test_decline_an_unknown_run_is_refused(
    client: TestClient, auth_headers: dict[str, str], page_with_candidate
) -> None:
    project_id, _ = page_with_candidate
    response = client.post(
        f"/api/projects/{project_id}/pages/1/runs/01NOPE/decline", headers=auth_headers
    )
    assert response.status_code == 400
    assert "没有这次运行" in response.json()["error"]["detail"]


def test_candidate_endpoints_require_token(client: TestClient) -> None:
    assert client.get("/api/projects/b2t_ZZZZZZ/pages/1/candidate").status_code == 401
    assert (
        client.post("/api/projects/b2t_ZZZZZZ/pages/1/runs/01X/apply").status_code == 401
    )
    assert (
        client.post("/api/projects/b2t_ZZZZZZ/pages/1/runs/01X/decline").status_code == 401
    )


def test_old_run_files_without_grouping_still_work(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, page_with_candidate
) -> None:
    """早期写下的原始输出没有 `blocks` 字段（本次才加的）：退化成就地重新分段。

    这条不做的话，升级之前识别过的项目一旦要采用候选就会 500。
    """
    import json

    project_id, after = page_with_candidate
    run_id = after["page"]["recognition"]["pending_run_id"]
    raw = library_dir / project_id / "ocr_runs" / f"{run_id}.json"
    payload = json.loads(raw.read_text(encoding="utf-8"))
    payload.pop("blocks")
    payload.pop("layout", None)
    raw.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    data = client.get(
        f"/api/projects/{project_id}/pages/1/candidate", headers=auth_headers
    ).json()
    assert data["candidate"]["regrouped"] is True
    assert data["candidate"]["blocks"], "重新分段也要给出块"

    applied = client.post(
        f"/api/projects/{project_id}/pages/1/runs/{run_id}/apply", headers=auth_headers
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["blocks"]
