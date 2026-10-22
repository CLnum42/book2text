"""结构编辑的集成测试（说明书 6.4 的块操作、5.4 的 R4）。

合并 / 拆分 / 上移下移 / 新增 / 删除——五个都改结构，因此都记事件、都能撤销。
行记录的搬迁也在测试里（说明书 5.3：合并时行记录随文本拼接保留原 bbox）。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.storage import db as db_module
from tests.fakes import FAKE_LINES, FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "结构编辑", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


@pytest.fixture
def page_ready(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> str:
    """识别好第 1 页的项目（假引擎产出 3 行 → 2 块）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    return project_id


def blocks_of(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> dict:
    return client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    ).json()


def lines_in_db(library_dir: Path, project_id: str) -> list[dict]:
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT line_id, block_id, line_index, bbox, text FROM block_line"
            " ORDER BY block_id, line_index"
        ).fetchall()
    return [dict(row) for row in rows]


# ---------------------------------------------------------------- 合并

def test_merge_prev_joins_text_and_lines(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, page_ready: str
) -> None:
    """说明书 R4：文本以 \\n 连接、bbox 取并集、ocr_text 同样合并。"""
    project_id = page_ready
    first, second = blocks_of(client, auth_headers, project_id)["blocks"]

    response = client.post(
        f"/api/projects/{project_id}/blocks/{second['block_id']}/merge-prev",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["merged_into"] == first["block_id"]
    assert len(data["blocks"]) == 1, "两块变一块"
    merged = data["blocks"][0]
    assert merged["text"] == f"{first['text']}\n{second['text']}"
    assert merged["ocr_text"] == f"{first['ocr_text']}\n{second['ocr_text']}"
    assert merged["origin"] == "merge"
    assert merged["review_status"] == "unreviewed"
    # bbox 取并集：左上取小、右下取大
    assert merged["bbox"][0] == min(first["bbox"][0], second["bbox"][0])
    assert merged["bbox"][3] == max(first["bbox"][3], second["bbox"][3])
    assert merged["revision"] == first["revision"] + 1

    # 行记录也在（说明书 5.3：合并时行记录随文本拼接保留原 bbox）
    assert [line["text"] for line in merged["lines"]] == [
        text for text, _, _ in FAKE_LINES
    ]
    assert [line["line_index"] for line in merged["lines"]] == [0, 1, 2]
    assert all(line["bbox"] for line in merged["lines"])
    # 被合并掉的那一块留在库里，只是软删除
    assert len(lines_in_db(library_dir, project_id)) == 3


def test_merge_prev_on_the_first_block_is_refused(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    project_id = page_ready
    first = blocks_of(client, auth_headers, project_id)["blocks"][0]
    response = client.post(
        f"/api/projects/{project_id}/blocks/{first['block_id']}/merge-prev",
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "第一块" in response.json()["error"]["detail"]


def test_merge_is_undone_completely(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    """撤销一次合并要还原三件事：文本、被合并掉的那一块、行记录的归属。"""
    project_id = page_ready
    before = blocks_of(client, auth_headers, project_id)["blocks"]
    first, second = before

    client.post(
        f"/api/projects/{project_id}/blocks/{second['block_id']}/merge-prev",
        headers=auth_headers,
    )
    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undone.status_code == 200, undone.text
    after = undone.json()["blocks"]

    assert [block["block_id"] for block in after] == [first["block_id"], second["block_id"]]
    assert after[0]["text"] == first["text"]
    assert after[0]["origin"] == "ocr"
    assert after[0]["bbox"] == first["bbox"]
    assert [line["text"] for line in after[1]["lines"]] == [
        line["text"] for line in second["lines"]
    ]
    assert [line["line_index"] for line in after[1]["lines"]] == [0]


# ---------------------------------------------------------------- 拆分

def test_split_block_at_cursor(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    """在光标处切开：行按位置分配，**两块各有自己的框**（任务 47 改掉"暂沿用原 bbox"）。

    R4 原文是"两块暂沿用原 bbox"；真书上是两个完全重叠的框，用户还得手动拖一次，
    所以现在按行框估算：切在行边界时前块 = 前几行的并集、后块 = 其余行。
    """
    project_id = page_ready
    block = blocks_of(client, auth_headers, project_id)["blocks"][0]
    offset = block["text"].index("\n") + 1  # 在第一行之后切开

    response = client.post(
        f"/api/projects/{project_id}/blocks/{block['block_id']}/split",
        json={"offset": offset},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data["parts"]) == 2

    head, tail = [b for b in data["blocks"] if b["block_id"] in data["parts"]]
    assert head["text"] == block["text"][:offset]
    assert tail["text"] == block["text"][offset:]
    assert tail["origin"] == "split"
    assert head["bbox"] != tail["bbox"], "拆开后两块不能还共用同一个框"
    original = block["bbox"]
    for rect in (head["bbox"], tail["bbox"]):
        assert rect[0] >= original[0] and rect[1] >= original[1]
        assert rect[2] <= original[2] and rect[3] <= original[3]
    assert head["bbox"][3] <= tail["bbox"][1], "前块的框只盖第一行，不和后块重叠"
    assert head["continues_to_next"] is False
    assert tail["continues_to_next"] is False
    assert data["blocks"][0]["block_id"] == head["block_id"], "新块插在原来那块后面"
    assert data["blocks"][1]["block_id"] == tail["block_id"]
    assert data["blocks"][2]["block_id"] != tail["block_id"], "后面的块被后移了一位"

    assert len(head["lines"]) == 1
    assert [line["line_index"] for line in tail["lines"]] == [0]


def test_split_in_the_middle_of_a_line_clears_that_line_bbox(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    """说明书 5.3：被从中间切开的行清空 bbox（它不再精确对应任何半边）。"""
    project_id = page_ready
    block = blocks_of(client, auth_headers, project_id)["blocks"][0]
    offset = 4  # 第一行中间

    data = client.post(
        f"/api/projects/{project_id}/blocks/{block['block_id']}/split",
        json={"offset": offset},
        headers=auth_headers,
    ).json()
    head = next(b for b in data["blocks"] if b["block_id"] == block["block_id"])
    tail = next(b for b in data["blocks"] if b["block_id"] == data["parts"][1])
    assert len(head["lines"]) == 1, "被切开的行归前块"
    assert head["lines"][0]["bbox"] is None, "它的坐标被清掉了——不再精确对应任何半边"
    assert tail["lines"][0]["bbox"], "后面的行坐标不受影响"


def test_split_out_of_range_is_refused(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    project_id = page_ready
    block = blocks_of(client, auth_headers, project_id)["blocks"][0]
    for offset in (0, len(block["text"]) + 5):
        response = client.post(
            f"/api/projects/{project_id}/blocks/{block['block_id']}/split",
            json={"offset": offset},
            headers=auth_headers,
        )
        assert response.status_code in (400, 422), offset


def test_split_is_undone_completely(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    project_id = page_ready
    before = blocks_of(client, auth_headers, project_id)["blocks"]
    block = before[0]
    offset = block["text"].index("\n") + 1

    client.post(
        f"/api/projects/{project_id}/blocks/{block['block_id']}/split",
        json={"offset": offset},
        headers=auth_headers,
    )
    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers).json()
    after = undone["blocks"]

    assert [b["block_id"] for b in after] == [b["block_id"] for b in before]
    assert after[0]["text"] == block["text"], "文本合回来"
    assert [line["text"] for line in after[0]["lines"]] == [
        line["text"] for line in block["lines"]
    ]
    assert [line["line_index"] for line in after[0]["lines"]] == [0, 1]
    assert after[1]["order_index"] == before[1]["order_index"], "后面的块回到原位"


# ---------------------------------------------------------------- 上移 / 下移

def test_move_block_swaps_order(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    project_id = page_ready
    first, second = blocks_of(client, auth_headers, project_id)["blocks"]

    moved = client.post(
        f"/api/projects/{project_id}/blocks/{second['block_id']}/move",
        json={"direction": "up"},
        headers=auth_headers,
    )
    assert moved.status_code == 200, moved.text
    after = moved.json()["blocks"]
    assert [block["block_id"] for block in after] == [second["block_id"], first["block_id"]]
    assert [block["order_index"] for block in after] == [0, 1]

    # 撤销换回来
    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers).json()
    assert [block["block_id"] for block in undone["blocks"]] == [
        first["block_id"],
        second["block_id"],
    ]


def test_move_beyond_the_edge_is_refused(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    project_id = page_ready
    first = blocks_of(client, auth_headers, project_id)["blocks"][0]
    response = client.post(
        f"/api/projects/{project_id}/blocks/{first['block_id']}/move",
        json={"direction": "up"},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "到头了" in response.json()["error"]["detail"]


# ---------------------------------------------------------------- 新增 / 删除

def test_create_block_without_bbox_has_no_position(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    """说明书 6.4：不框选则按"无位置信息"处理。"""
    project_id = page_ready
    response = client.post(
        f"/api/projects/{project_id}/pages/1/blocks",
        json={"page_no": 1, "text": "漏掉的一行"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    created = response.json()["created"]

    assert created["origin"] == "manual"
    assert created["bbox"] is None
    assert created["ocr_text"] == "", "人工新增的块没有 OCR 原文"
    assert created["modified"] is True, "没有原文 ⇒ 一直显示为已修改（如实）"
    assert created["order_index"] == 2, "排在这一页最后"
    assert response.json()["blocks"][-1]["block_id"] == created["block_id"]


def test_create_block_with_bbox_and_insertion_point(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    project_id = page_ready
    first = blocks_of(client, auth_headers, project_id)["blocks"][0]

    response = client.post(
        f"/api/projects/{project_id}/pages/1/blocks",
        json={
            "page_no": 1,
            "text": "补一个页眉",
            "bbox": [0.1, 0.02, 0.9, 0.06],
            "after_block_id": first["block_id"],
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    created = response.json()["created"]
    assert created["bbox"] == [0.1, 0.02, 0.9, 0.06]
    assert created["order_index"] == first["order_index"] + 1
    blocks = response.json()["blocks"]
    assert blocks[1]["block_id"] == created["block_id"], "插在指定块之后"
    assert [block["order_index"] for block in blocks] == [0, 1, 2], "后面的块被后移"


def test_create_block_rejects_a_bad_bbox(
    client: TestClient, auth_headers: dict[str, str], page_ready: str
) -> None:
    response = client.post(
        f"/api/projects/{page_ready}/pages/1/blocks",
        json={"page_no": 1, "text": "x", "bbox": [0.1, 0.2, 3.0, 0.6]},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_bbox"


def test_delete_block_is_soft_and_undoable(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, page_ready: str
) -> None:
    project_id = page_ready
    first, second = blocks_of(client, auth_headers, project_id)["blocks"]

    response = client.delete(
        f"/api/projects/{project_id}/blocks/{second['block_id']}", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    assert len(response.json()["blocks"]) == 1

    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT deleted_at FROM block WHERE block_id = ?", (second["block_id"],)
        ).fetchone()
    assert row["deleted_at"], "软删除：行还在，只是标记了时间"

    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers).json()
    assert [block["block_id"] for block in undone["blocks"]] == [
        first["block_id"],
        second["block_id"],
    ]


def test_structure_changes_survive_a_restart(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    from book2text.api.app import create_app
    from tests.conftest import TEST_ORIGIN, TEST_TOKEN

    project_id = create_project(client, auth_headers, sample_pdf)
    client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    first, second = blocks_of(client, auth_headers, project_id)["blocks"]
    client.post(
        f"/api/projects/{project_id}/blocks/{second['block_id']}/merge-prev",
        headers=auth_headers,
    )

    fresh = TestClient(
        create_app(session_token=TEST_TOKEN, origins=[TEST_ORIGIN], library_dir=library_dir)
    )
    after = fresh.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()
    assert len(after["blocks"]) == 1
    assert after["blocks"][0]["origin"] == "merge"
    assert after["blocks"][0]["text"] == f"{first['text']}\n{second['text']}"
    assert len(after["blocks"][0]["lines"]) == 3


def test_structure_edits_are_recorded_as_events(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, page_ready: str
) -> None:
    """结构操作也要进事件表（说明书 5.1：所有修改写入事件表）。"""
    import json

    project_id = page_ready
    first, second = blocks_of(client, auth_headers, project_id)["blocks"]
    client.post(
        f"/api/projects/{project_id}/blocks/{second['block_id']}/merge-prev",
        headers=auth_headers,
    )

    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT entity_type, action, batch_id FROM event ORDER BY rowid"
        ).fetchall()
    actions = [row["action"] for row in rows]
    assert "merge" in actions
    assert "delete" in actions, "被合并掉的那一块记为软删除"
    assert "move_line" in actions, "行的搬迁也有记录"
    assert {row["entity_type"] for row in rows} == {"block", "block_line"}
    assert len({row["batch_id"] for row in rows}) == 1, "一次合并就是一批"
    assert len(rows) >= 2 + 1  # 合并 + 软删除 + 行搬迁
