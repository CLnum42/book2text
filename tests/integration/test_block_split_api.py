"""拆分与"把页码拆出去"的集成测试（任务 47）。

重点：
- 拆开后**两个块各有自己的框**（R4 原来两块沿用同一个 bbox，真书上是两个完全重叠的框）；
- 拆页码只拆"贴着块首 / 块尾"的数字，正文段落里的数字不动；
- 批量拆页码整批算一个 batch，一次撤销全部回退。

界面约定在 `tests/integration/test_ui_assets.py`，几何估算的边界情况在
`tests/unit/test_block_split_geometry.py`。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "拆分", "filename": pdf.name},
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


def page_blocks(
    client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1
) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def patch_block(
    client: TestClient,
    headers: dict[str, str],
    project_id: str,
    block: dict,
    values: dict,
) -> dict:
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json=values,
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def recognized_page(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    """第 1 页已识别（假引擎：2 块 3 行）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    return project_id


def _rect_overlap(a, b, eps: float = 1e-9) -> bool:
    return (
        min(a[2], b[2]) - max(a[0], b[0]) > eps
        and min(a[3], b[3]) - max(a[1], b[1]) > eps
    )


def _inside(inner, outer, eps: float = 1e-9) -> bool:
    return (
        inner[0] >= outer[0] - eps
        and inner[1] >= outer[1] - eps
        and inner[2] <= outer[2] + eps
        and inner[3] <= outer[3] + eps
    )


def test_split_at_line_boundary_gives_each_half_its_own_bbox(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """行边界拆分：前块拿第一行、后块拿第二行，两个框不重叠、都在原框内。"""
    blocks = page_blocks(client, auth_headers, recognized_page)["blocks"]
    block = blocks[0]
    assert "\n" in block["text"], "假引擎的第一块是两行，才谈得上按行分框"
    original = block["bbox"]
    offset = len(block["text"].split("\n")[0]) + 1

    response = client.post(
        f"/api/projects/{recognized_page}/blocks/{block['block_id']}/split",
        json={"offset": offset},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    head, tail = response.json()["blocks"][0], response.json()["blocks"][1]

    assert head["bbox"] != tail["bbox"], "拆开后两块不能还用同一个框"
    assert _inside(head["bbox"], original) and _inside(tail["bbox"], original)
    assert not _rect_overlap(head["bbox"], tail["bbox"])
    # 前块的框只盖第一行：比原框矮、比后块高
    assert head["bbox"][3] <= tail["bbox"][1]
    assert head["bbox"][3] - head["bbox"][1] < original[3] - original[1]


def test_split_inside_one_line_estimates_a_horizontal_cut(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """单行块在行内切开：按字符比例横切，两块共用同一条切线。"""
    blocks = page_blocks(client, auth_headers, recognized_page)["blocks"]
    block = blocks[1]
    assert "\n" not in block["text"]
    original = block["bbox"]
    offset = 3
    ratio = offset / len(block["text"])

    response = client.post(
        f"/api/projects/{recognized_page}/blocks/{block['block_id']}/split",
        json={"offset": offset},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    head, tail = response.json()["blocks"][1], response.json()["blocks"][2]
    assert head["text"] == block["text"][:offset]
    assert tail["text"] == block["text"][offset:]

    expected = original[0] + (original[2] - original[0]) * ratio
    assert head["bbox"][2] == pytest.approx(expected, abs=1e-6)
    assert head["bbox"][2] == tail["bbox"][0], "同一个切线值给两边，浮点上也不许差"
    assert not _rect_overlap(head["bbox"], tail["bbox"])
    assert _inside(head["bbox"], original) and _inside(tail["bbox"], original)


def test_split_off_page_number_makes_a_page_number_block(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """书眉 `2谁是巴赫金?11` → header `2谁是巴赫金?` + page_number `11`，可撤销。"""
    blocks = page_blocks(client, auth_headers, recognized_page)["blocks"]
    block = blocks[1]
    patch_block(
        client,
        auth_headers,
        recognized_page,
        block,
        {"text": "2谁是巴赫金?11", "block_type": "header"},
    )
    fresh = page_blocks(client, auth_headers, recognized_page)["blocks"][1]
    original = fresh["bbox"]
    assert fresh["text"] == "2谁是巴赫金?11"

    response = client.post(
        f"/api/projects/{recognized_page}/blocks/{block['block_id']}/split-page-number",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["number"]["number"] == "11"
    assert payload["number"]["position"] == "end"
    head, tail = payload["blocks"][1], payload["blocks"][2]
    assert head["block_type"] == "header" and head["text"] == "2谁是巴赫金?"
    assert tail["block_type"] == "page_number" and tail["text"] == "11"
    assert head["bbox"][2] == tail["bbox"][0]
    assert not _rect_overlap(head["bbox"], tail["bbox"])
    assert _inside(head["bbox"], original) and _inside(tail["bbox"], original)

    # 两块都可继续拖拽 / 缩放：PATCH bbox 走的是同一条编辑路径
    moved = client.patch(
        f"/api/projects/{recognized_page}/blocks/{tail['block_id']}",
        json={"bbox": [0.5, 0.04, 0.6, 0.06]},
        headers=auth_headers,
    )
    assert moved.status_code == 200, moved.text

    # 上面那次拖框自己是一批，先把这一步撤掉，再撤拆分
    undo_move = client.post(f"/api/projects/{recognized_page}/undo", headers=auth_headers)
    assert undo_move.status_code == 200, undo_move.text
    undo = client.post(f"/api/projects/{recognized_page}/undo", headers=auth_headers)
    assert undo.status_code == 200, undo.text
    restored = page_blocks(client, auth_headers, recognized_page)["blocks"][1]
    assert restored["text"] == "2谁是巴赫金?11"
    assert restored["block_type"] == "header"
    assert restored["bbox"] == original


def test_page_number_split_refuses_a_number_in_the_middle(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """夹在中间的数字（"第 11 章"）不是页码：拒绝，不把正文拆坏。"""
    blocks = page_blocks(client, auth_headers, recognized_page)["blocks"]
    block = blocks[1]
    patch_block(client, auth_headers, recognized_page, block, {"text": "第 11 章 导论"})
    response = client.post(
        f"/api/projects/{recognized_page}/blocks/{block['block_id']}/split-page-number",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "页码" in response.json()["error"]["detail"]


def test_batch_split_preview_and_one_undo_reverts_everything(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """批量：先 dry_run 看影响范围，执行后整批可一次撤销。"""
    project_id = recognized_page
    recognize(client, auth_headers, project_id, 2)
    for page_no, text in ((1, "2谁是巴赫金?11"), (2, "2谁是巴赫金?12")):
        blocks = page_blocks(client, auth_headers, project_id, page_no)["blocks"]
        patch_block(
            client,
            auth_headers,
            project_id,
            blocks[1],
            {"text": text, "block_type": "header"},
        )

    undo_before = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["history"]["undo"]
    preview = client.post(
        f"/api/projects/{project_id}/split-page-numbers",
        json={"page_numbers": [1, 2], "dry_run": True},
        headers=auth_headers,
    )
    assert preview.status_code == 200, preview.text
    plan = preview.json()
    assert plan["dry_run"] is True
    assert plan["pages"] == 2 and plan["blocks"] == 2
    assert [item["number"] for item in plan["items"]] == ["11", "12"]
    assert plan["history"]["undo"] == undo_before, "预览不写库、也不进撤销栈"

    # 预览之后一个块都没变
    assert page_blocks(client, auth_headers, project_id, 1)["blocks"][1]["text"] == "2谁是巴赫金?11"

    applied = client.post(
        f"/api/projects/{project_id}/split-page-numbers",
        json={"page_numbers": [1, 2], "dry_run": False},
        headers=auth_headers,
    )
    assert applied.status_code == 200, applied.text
    result = applied.json()
    assert result["dry_run"] is False
    assert result["blocks"] == 2
    assert result["history"]["undo"] == undo_before + 1, "整批只占一次撤销"

    for page_no in (1, 2):
        blocks = page_blocks(client, auth_headers, project_id, page_no)["blocks"]
        assert blocks[1]["block_type"] == "header"
        assert blocks[2]["block_type"] == "page_number"
        assert blocks[2]["text"] in ("11", "12")

    undo = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undo.status_code == 200, undo.text
    assert undo.json()["history"]["undo"] == undo_before
    for page_no, text in ((1, "2谁是巴赫金?11"), (2, "2谁是巴赫金?12")):
        blocks = page_blocks(client, auth_headers, project_id, page_no)["blocks"]
        assert blocks[1]["text"] == text
        assert all(block["block_type"] != "page_number" for block in blocks)


def test_batch_only_uses_body_pages_when_no_page_list_is_given(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """没指定页码 = 全部正文页；被排除的页不算。"""
    project_id = recognized_page
    blocks = page_blocks(client, auth_headers, project_id)["blocks"]
    patch_block(
        client, auth_headers, project_id, blocks[1], {"text": "2谁是巴赫金?11", "block_type": "header"}
    )
    page_id = page_blocks(client, auth_headers, project_id)["page"]["page_id"]
    response = client.patch(
        f"/api/projects/{project_id}/pages",
        json={"page_ids": [page_id], "page_type": "body_excluded"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    preview = client.post(
        f"/api/projects/{project_id}/split-page-numbers",
        json={"dry_run": True},
        headers=auth_headers,
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["blocks"] == 0


def test_split_page_number_is_exported_as_metadata_not_body(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str, library_dir: Path
) -> None:
    """拆出来的 page_number 进 meta.json，不进正文流。"""
    project_id = recognized_page
    blocks = page_blocks(client, auth_headers, project_id)["blocks"]
    patch_block(
        client, auth_headers, project_id, blocks[1], {"text": "2谁是巴赫金?11", "block_type": "header"}
    )
    response = client.post(
        f"/api/projects/{project_id}/blocks/{blocks[1]['block_id']}/split-page-number",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text

    # 任务 34 起默认按版心判定；这条用例验证旧的 meta 形状，显式关掉。
    settings = client.patch(
        f"/api/projects/{project_id}/settings",
        json={"margin_box_judgement": False},
        headers=auth_headers,
    )
    assert settings.status_code == 200, settings.text
    exported = client.post(
        f"/api/projects/{project_id}/export",
        json={"page_numbers": [1], "format": "both"},
        headers=auth_headers,
    )
    assert exported.status_code == 200, exported.text
    record = exported.json()["record"]
    directory = library_dir / project_id / "exports" / record["export_id"]
    body = (directory / "body.txt").read_text(encoding="utf-8")
    assert "2谁是巴赫金?" not in body and "11" not in body
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    page = meta["pages"][0]
    assert page["printed_page"] == "11"
    assert page["printed_page_source"] == "legacy"
    assert [item["text"] for item in page["page_numbers"]] == ["11"]
    assert [item["text"] for item in page["headers"]] == ["2谁是巴赫金?"]
