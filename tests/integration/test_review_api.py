"""审校接口的集成测试（说明书 5.3 的 Event、5.4 的 R3 / R5、第 11 节的块与历史）。

用假引擎跑识别（`inprocess_jobs`），然后走真实的编辑路径：
改块 → 事件表里有据可查 → 撤销 / 重做按 batch 走 → 确认整页按 R3。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "审校测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, page_no: int) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [page_no], "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def page_blocks(client: TestClient, headers: dict[str, str], project_id: str, page_no: int) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def reviewed_page(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> tuple[str, dict]:
    """一个识别好第 1 页的项目（2 个块）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    return project_id, page_blocks(client, auth_headers, project_id, 1)


def events_in(library_dir: Path, project_id: str) -> list[dict]:
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        rows = conn.execute("SELECT * FROM event ORDER BY created_at, event_id").fetchall()
    return [
        {
            "action": row["action"],
            "entity_id": row["entity_id"],
            "batch_id": row["batch_id"],
            "before": json.loads(row["before_json"] or "{}"),
            "after": json.loads(row["after_json"] or "{}"),
            "actor": row["actor"],
        }
        for row in rows
    ]


# ---------------------------------------------------------------- 改块

def test_edit_block_text_records_an_event(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, reviewed_page
) -> None:
    project_id, content = reviewed_page
    block = content["blocks"][0]

    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": "改过的第一段。", "expected_revision": block["revision"]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    updated = response.json()["block"]

    assert updated["text"] == "改过的第一段。"
    assert updated["ocr_text"] == block["ocr_text"], "R5：改 text 不碰 ocr_text"
    assert updated["modified"] is True
    assert updated["revision"] == block["revision"] + 1
    assert updated["updated_at"] >= block["updated_at"]
    assert updated["review_status"] == "unreviewed", "改文本不自动改审校状态"

    events = events_in(library_dir, project_id)
    assert len(events) == 1
    assert events[0]["action"] == "edit_text"
    assert events[0]["entity_id"] == block["block_id"]
    assert events[0]["before"] == {"text": block["ocr_text"]}
    assert events[0]["after"] == {"text": "改过的第一段。"}
    assert events[0]["actor"] == "user"


def test_edit_block_survives_a_restart(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    from book2text.api.app import create_app
    from tests.conftest import TEST_ORIGIN, TEST_TOKEN

    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    block = page_blocks(client, auth_headers, project_id, 1)["blocks"][0]
    client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": "重启也要在", "review_status": "confirmed"},
        headers=auth_headers,
    )

    fresh = TestClient(
        create_app(session_token=TEST_TOKEN, origins=[TEST_ORIGIN], library_dir=library_dir)
    )
    after = fresh.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"][0]
    assert after["text"] == "重启也要在"
    assert after["review_status"] == "confirmed"


def test_stale_revision_is_refused_as_conflict(
    client: TestClient, auth_headers: dict[str, str], reviewed_page
) -> None:
    """说明书第 11 节的乐观并发检查：拿着旧版本去写要报冲突，不能静默覆盖。"""
    project_id, content = reviewed_page
    block = content["blocks"][0]
    client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": "第一次改"},
        headers=auth_headers,
    )

    stale = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": "拿着旧版本再改", "expected_revision": block["revision"]},
        headers=auth_headers,
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "block_conflict"

    current = page_blocks(client, auth_headers, project_id, 1)["blocks"][0]
    assert current["text"] == "第一次改", "冲突时不该覆盖"


def test_no_op_edit_does_not_bump_revision(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, reviewed_page
) -> None:
    """值没变就不记历史：界面"点一下没改"不该在历史里留垃圾。"""
    project_id, content = reviewed_page
    block = content["blocks"][0]

    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": block["ocr_text"]},
        headers=auth_headers,
    )
    assert response.status_code == 200
    assert response.json()["block"]["revision"] == block["revision"]
    assert response.json()["events"] == []
    assert events_in(library_dir, project_id) == []


def test_block_field_validation(
    client: TestClient, auth_headers: dict[str, str], reviewed_page
) -> None:
    project_id, content = reviewed_page
    block_id = content["blocks"][0]["block_id"]

    bad_status = client.patch(
        f"/api/projects/{project_id}/blocks/{block_id}",
        json={"review_status": "也许吧"},
        headers=auth_headers,
    )
    assert bad_status.status_code == 400
    assert "未知的审校状态" in bad_status.json()["error"]["detail"]

    bad_type = client.patch(
        f"/api/projects/{project_id}/blocks/{block_id}",
        json={"block_type": "乱写"},
        headers=auth_headers,
    )
    assert bad_type.status_code == 400

    empty = client.patch(
        f"/api/projects/{project_id}/blocks/{block_id}", json={}, headers=auth_headers
    )
    assert empty.status_code == 400
    assert "没有要更新的字段" in empty.json()["error"]["detail"]

    unknown = client.patch(
        f"/api/projects/{project_id}/blocks/nope", json={"text": "x"}, headers=auth_headers
    )
    assert unknown.status_code == 400
    assert "找不到块" in unknown.json()["error"]["detail"]


def test_block_flags_round_trip(
    client: TestClient, auth_headers: dict[str, str], reviewed_page
) -> None:
    project_id, content = reviewed_page
    block = content["blocks"][0]

    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={
            "include": False,
            "continues_to_next": True,
            "block_type": "header",
            "comment": "这行像是页眉",
        },
        headers=auth_headers,
    )
    updated = response.json()["block"]
    assert updated["include"] is False
    assert updated["continues_to_next"] is True
    assert updated["block_type"] == "header"
    assert updated["comment"] == "这行像是页眉"

    # 审校进度跟着块走：排除的块不计入"未审"
    review = page_blocks(client, auth_headers, project_id, 1)["review"]
    assert review["block_count"] == 2
    assert review["included"] == 1
    assert review["excluded"] == 1


# ---------------------------------------------------------------- 确认整页（R3）

def test_confirm_page_confirms_only_unreviewed(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, reviewed_page
) -> None:
    project_id, content = reviewed_page
    first, second = content["blocks"]
    # 第二个块先标成"不确定"
    client.patch(
        f"/api/projects/{project_id}/blocks/{second['block_id']}",
        json={"review_status": "uncertain"},
        headers=auth_headers,
    )

    response = client.post(
        f"/api/projects/{project_id}/pages/1/confirm", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["confirmed"] == 1, "只确认未审的那个"
    assert data["uncertain"] == 1, "不确定的块保持不动，并且要报出数量"
    by_id = {block["block_id"]: block for block in data["blocks"]}
    assert by_id[first["block_id"]]["review_status"] == "confirmed"
    assert by_id[second["block_id"]]["review_status"] == "uncertain"
    assert data["review"]["confirmed"] == 1
    assert data["review"]["unreviewed"] == 0

    # 确认整页是一批：一次操作一个 batch_id
    batch_ids = {event["batch_id"] for event in events_in(library_dir, project_id) if event["action"] == "set_status" and event["after"] == {"review_status": "confirmed"}}
    assert len(batch_ids) == 1


def test_confirm_page_skips_excluded_blocks(
    client: TestClient, auth_headers: dict[str, str], reviewed_page
) -> None:
    """说明书 R3："所有**纳入**且状态为 unreviewed 的块"——排除的块不动。"""
    project_id, content = reviewed_page
    client.patch(
        f"/api/projects/{project_id}/blocks/{content['blocks'][1]['block_id']}",
        json={"include": False},
        headers=auth_headers,
    )

    data = client.post(
        f"/api/projects/{project_id}/pages/1/confirm", headers=auth_headers
    ).json()
    assert data["confirmed"] == 1
    by_id = {block["block_id"]: block for block in data["blocks"]}
    assert by_id[content["blocks"][1]["block_id"]]["review_status"] == "unreviewed"


def test_confirm_unknown_page_is_404(
    client: TestClient, auth_headers: dict[str, str], reviewed_page
) -> None:
    project_id, _ = reviewed_page
    response = client.post(
        f"/api/projects/{project_id}/pages/99/confirm", headers=auth_headers
    )
    assert response.status_code == 404


# ---------------------------------------------------------------- 撤销 / 重做

def test_undo_and_redo_a_text_edit(
    client: TestClient, auth_headers: dict[str, str], reviewed_page
) -> None:
    project_id, content = reviewed_page
    block = content["blocks"][0]
    original_text = block["ocr_text"]
    client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": "改了一下"},
        headers=auth_headers,
    )

    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undone.status_code == 200, undone.text
    assert undone.json()["direction"] == "undo"
    assert undone.json()["pages"] == [1]
    by_id = {item["block_id"]: item for item in undone.json()["blocks"]}
    assert by_id[block["block_id"]]["text"] == original_text
    assert by_id[block["block_id"]]["modified"] is False
    assert undone.json()["history"]["redo"] == 1

    redone = client.post(f"/api/projects/{project_id}/redo", headers=auth_headers)
    assert redone.status_code == 200
    by_id = {item["block_id"]: item for item in redone.json()["blocks"]}
    assert by_id[block["block_id"]]["text"] == "改了一下"
    assert redone.json()["history"]["undo"] == 1


def test_undo_confirm_page_reverts_the_whole_batch(
    client: TestClient, auth_headers: dict[str, str], reviewed_page
) -> None:
    """撤销按 batch 走：确认整页是一次操作，撤销要一次全退回去。"""
    project_id, content = reviewed_page
    client.post(f"/api/projects/{project_id}/pages/1/confirm", headers=auth_headers)

    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers).json()
    assert undone["changed_blocks"] == 2, "两个块一起退回去"
    assert all(block["review_status"] == "unreviewed" for block in undone["blocks"])


def test_new_edit_clears_the_redo_stack(
    client: TestClient, auth_headers: dict[str, str], reviewed_page
) -> None:
    project_id, content = reviewed_page
    block = content["blocks"][0]
    client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": "第一次"},
        headers=auth_headers,
    )
    client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)

    current = page_blocks(client, auth_headers, project_id, 1)["blocks"][0]
    client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": "换一种改法", "expected_revision": current["revision"]},
        headers=auth_headers,
    )

    response = client.post(f"/api/projects/{project_id}/redo", headers=auth_headers)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "nothing_to_redo"


def test_undo_on_empty_stack_is_refused(
    client: TestClient, auth_headers: dict[str, str], reviewed_page
) -> None:
    project_id, _ = reviewed_page
    response = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "nothing_to_undo"
    assert "本次运行" in response.json()["error"]["detail"]


def test_undo_stack_is_session_scoped(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """说明书 5.3："撤销栈仅限本次会话"——重启后不能撤销历史操作，但成果还在。"""
    from book2text.api.app import create_app
    from tests.conftest import TEST_ORIGIN, TEST_TOKEN

    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    block = page_blocks(client, auth_headers, project_id, 1)["blocks"][0]
    client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": "改过的"},
        headers=auth_headers,
    )

    fresh = TestClient(
        create_app(session_token=TEST_TOKEN, origins=[TEST_ORIGIN], library_dir=library_dir)
    )
    assert fresh.post(f"/api/projects/{project_id}/undo", headers=auth_headers).status_code == 400
    after = fresh.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()
    assert after["blocks"][0]["text"] == "改过的", "成果本身不受影响"
    assert after["history"] == {"undo": 0, "redo": 0}


def test_review_progress_is_derived_on_the_page(
    client: TestClient, auth_headers: dict[str, str], reviewed_page
) -> None:
    """说明书 5.3：页面的审校状态由块推导（未开始 / 进行中 / 已完成 / 有疑问）。"""
    project_id, content = reviewed_page

    def page_state() -> dict:
        pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
        return pages[0]["review"]

    assert page_state()["status"] == "not_started"

    client.patch(
        f"/api/projects/{project_id}/blocks/{content['blocks'][0]['block_id']}",
        json={"review_status": "uncertain"},
        headers=auth_headers,
    )
    assert page_state()["status"] == "questioned"

    client.patch(
        f"/api/projects/{project_id}/blocks/{content['blocks'][0]['block_id']}",
        json={"review_status": "confirmed"},
        headers=auth_headers,
    )
    assert page_state()["status"] == "in_progress"

    client.post(f"/api/projects/{project_id}/pages/1/confirm", headers=auth_headers)
    assert page_state()["status"] == "done"


def test_review_endpoints_require_token(client: TestClient, sample_pdf: Path) -> None:
    assert client.patch("/api/projects/b2t_ZZZZZZ/blocks/x", json={"text": "a"}).status_code == 401
    assert client.post("/api/projects/b2t_ZZZZZZ/undo").status_code == 401
    assert client.post("/api/projects/b2t_ZZZZZZ/pages/1/confirm").status_code == 401
