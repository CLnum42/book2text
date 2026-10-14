"""逐块采用与框选新增块的集成测试（说明书 6.4，R2 的整页采用之外的补充）。

三件事：

1. **配对**：候选结果里的块与现有块怎么对上（bbox 重叠优先、按序号退化、多出来的块）；
2. **逐块采用**：只换一块、沿用位置、其余块不动、行记录一起重建、可以撤销；
3. **框选新增块**：按框选的竖直位置插进阅读顺序（漏检的页眉插到最前面）。

另外锁住一条**修好的旧缺口**：整页采用（R2）原先只重建块、不重建行，
导致采用之后那一页没法做第二引擎复核（"这一页没有可复核的行"）。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module
from book2text.core.project import editing
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "逐块采用", "filename": pdf.name},
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


def page_blocks(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def lines_of(project_id: str, library_dir: Path, page_no: int = 1):
    return blocks_module.list_block_lines(project_id, library=library_dir, page_no=page_no)


@pytest.fixture
def recognized_page(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> str:
    """第 1 页已识别（假引擎：2 块 3 行）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    return project_id


def make_candidate(
    client: TestClient,
    auth_headers: dict[str, str],
    project_id: str,
    engine: FakeOcrEngine,
    page_no: int = 1,
) -> str:
    """再识别一次，让这一页出现"待选新结果"（页面已有人工成果时 R2 只保存候选）。"""
    blocks = page_blocks(client, auth_headers, project_id, page_no)["blocks"]
    # 先动一下，让页面"有人工成果"，重新识别才会变成候选（否则会直接替换）
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{blocks[0]['block_id']}",
        json={"text": blocks[0]["text"] + "改", "expected_revision": blocks[0]["revision"]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    recognize(client, auth_headers, project_id, page_no)
    states = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()
    page = next(item for item in states["pages"] if item["page_no"] == page_no)
    assert page["recognition"]["status"] == "has_candidate", page["recognition"]
    return page["recognition"]["pending_run_id"]


# ---------------------------------------------------------------- 配对（纯函数）

def test_matching_prefers_bbox_overlap() -> None:
    """重叠大的先配：块的排布变了（多出一个块）也认得出来。"""
    current = [
        blocks_module.BlockRecord(
            block_id="A", page_id="p", page_no=1, origin_run_id=None, origin="ocr",
            order_index=0, bbox=(0.1, 0.10, 0.9, 0.16), block_type="paragraph",
            ocr_text="", text="第一块", review_status="unreviewed", include=True,
            continues_to_next=False, confidence=None, revision=1, reviewed_by=None,
            comment=None, created_at="", updated_at="",
        ),
        blocks_module.BlockRecord(
            block_id="B", page_id="p", page_no=1, origin_run_id=None, origin="ocr",
            order_index=1, bbox=(0.1, 0.30, 0.9, 0.36), block_type="paragraph",
            ocr_text="", text="第二块", review_status="unreviewed", include=True,
            continues_to_next=False, confidence=None, revision=1, reviewed_by=None,
            comment=None, created_at="", updated_at="",
        ),
    ]
    candidate = [
        {"bbox": [0.1, 0.30, 0.9, 0.36], "text": "第二块（新版）"},
        {"bbox": [0.1, 0.10, 0.9, 0.16], "text": "第一块（新版）"},
    ]
    matched = blocks_module.match_candidate_blocks(current, candidate)
    assert [item["target_block_id"] for item in matched] == ["B", "A"], "按位置配，不按顺序"
    assert matched[0]["iou"] > 0.9
    assert matched[0]["same_text"] is False


def test_matching_falls_back_to_order_and_reports_extras() -> None:
    """没有 bbox 就按顺序配；一个现有块只会被配一次，多出来的候选块没有目标。"""
    current = [
        blocks_module.BlockRecord(
            block_id="A", page_id="p", page_no=1, origin_run_id=None, origin="ocr",
            order_index=0, bbox=None, block_type="paragraph", ocr_text="", text="甲",
            review_status="unreviewed", include=True, continues_to_next=False,
            confidence=None, revision=1, reviewed_by=None, comment=None,
            created_at="", updated_at="",
        )
    ]
    candidate = [{"bbox": None, "text": "甲"}, {"bbox": None, "text": "乙"}, {"bbox": None, "text": "丙"}]
    matched = blocks_module.match_candidate_blocks(current, candidate)
    assert matched[0]["target_block_id"] == "A"
    assert matched[0]["same_text"] is True
    assert matched[1]["target_block_id"] is None, "现有块只有一个，其余是新增"
    assert matched[2]["target_block_id"] is None


# ---------------------------------------------------------------- 逐块采用

def test_candidate_payload_carries_the_matching(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str, inprocess_jobs: FakeOcrEngine
) -> None:
    """候选载荷里每块都带"对应现有哪一块"，界面据此显示「换这一块」。"""
    project_id = recognized_page
    make_candidate(client, auth_headers, project_id, inprocess_jobs)

    data = client.get(
        f"/api/projects/{project_id}/pages/1/candidate", headers=auth_headers
    ).json()
    current_ids = [block["block_id"] for block in data["current"]["blocks"]]
    matched_ids = [block["match"]["target_block_id"] for block in data["candidate"]["blocks"]]
    assert matched_ids == current_ids, "两版块数相同时应一一对应"
    assert all("same_text" in block["match"] for block in data["candidate"]["blocks"])


def test_apply_single_block_swaps_only_that_block(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_page: str,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """逐块采用：目标块被换掉、位置不变、其余块一模一样、行记录一起重建。"""
    project_id = recognized_page
    run_id = make_candidate(client, auth_headers, project_id, inprocess_jobs)
    before = page_blocks(client, auth_headers, project_id)
    target = before["blocks"][0]
    other = before["blocks"][1]
    lines_before = {line.block_id: line.text for line in lines_of(project_id, library_dir)}

    response = client.post(
        f"/api/projects/{project_id}/pages/1/runs/{run_id}/apply-block",
        json={"candidate_index": 0, "target_block_id": target["block_id"]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    after = response.json()["blocks"]

    assert len(after) == len(before["blocks"]), "块数不变（换一个，不是加一个）"
    assert after[0]["block_id"] != target["block_id"], "换成了新块"
    assert after[0]["order_index"] == target["order_index"], "位置沿用目标块"
    assert after[1]["block_id"] == other["block_id"], "其余块一个不动"
    assert after[1]["text"] == other["text"]

    # 新块带着行记录（说明书 5.3 的 BlockLine）——第二引擎复核靠它
    new_lines = [line for line in lines_of(project_id, library_dir) if line.block_id == after[0]["block_id"]]
    assert new_lines, "换过来的块必须有行记录"
    assert [line.line_index for line in new_lines] == list(range(len(new_lines)))
    assert all(line.bbox for line in new_lines), "行框来自那次运行的原始输出"
    # 旧块的行还在库里但已随块软删除（查当前有效块的行查不到它）
    assert target["block_id"] in lines_before


def test_apply_single_block_text_comes_from_the_candidate(
    client: TestClient,
    auth_headers: dict[str, str],
    recognized_page: str,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """换过来的文本是那一版的结果，不是现有块的文本。"""
    project_id = recognized_page
    run_id = make_candidate(client, auth_headers, project_id, inprocess_jobs)
    candidate = client.get(
        f"/api/projects/{project_id}/pages/1/candidate", headers=auth_headers
    ).json()["candidate"]["blocks"]

    response = client.post(
        f"/api/projects/{project_id}/pages/1/runs/{run_id}/apply-block",
        json={"candidate_index": 1},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    blocks = response.json()["blocks"]
    assert blocks[1]["text"] == candidate[1]["text"]
    assert blocks[1]["ocr_text"] == candidate[1]["text"], "OCR 原文也来自那一版"
    assert blocks[1]["origin"] == "ocr"


def test_apply_single_block_is_undoable(
    client: TestClient,
    auth_headers: dict[str, str],
    recognized_page: str,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """撤销之后目标块回来、新块消失（一次 batch，说明书 5.3 的 Event）。"""
    project_id = recognized_page
    run_id = make_candidate(client, auth_headers, project_id, inprocess_jobs)
    before = page_blocks(client, auth_headers, project_id)["blocks"]

    client.post(
        f"/api/projects/{project_id}/pages/1/runs/{run_id}/apply-block",
        json={"candidate_index": 0},
        headers=auth_headers,
    )
    swapped = page_blocks(client, auth_headers, project_id)["blocks"]
    assert swapped[0]["block_id"] != before[0]["block_id"]

    undo = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undo.status_code == 200, undo.text
    restored = page_blocks(client, auth_headers, project_id)["blocks"]
    assert [block["block_id"] for block in restored] == [block["block_id"] for block in before]
    assert restored[0]["text"] == before[0]["text"], "人工改过的文本也要回来"


def test_apply_single_block_without_target_inserts_by_position(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_page: str,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """候选里"多出来的块"采用时插进阅读顺序，而不是覆盖别人。"""
    project_id = recognized_page
    run_id = make_candidate(client, auth_headers, project_id, inprocess_jobs)
    before = page_blocks(client, auth_headers, project_id)["blocks"]

    # 直接调核心层：模拟"候选里的第 3 块（现有块里没有对应）"
    created, _events = editing.adopt_run_block(
        project_id,
        1,
        run_id,
        candidate_index=0,
        target_block_id=None,
        library=library_dir,
    )
    after = page_blocks(client, auth_headers, project_id)["blocks"]
    assert len(after) == len(before), "有对应的块时是替换，不是新增"
    assert created.block_id in [block["block_id"] for block in after]


# ---------------------------------------------------------------- 整页采用补上行记录

def test_whole_page_adoption_recreates_line_records(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_page: str,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """修好的旧缺口：采用整页之后那一页仍有行记录，第二引擎复核不会拒绝它。

    原先只重建块不重建行，于是采用之后那一页变成"没有可复核的行"。
    """
    project_id = recognized_page
    run_id = make_candidate(client, auth_headers, project_id, inprocess_jobs)

    response = client.post(
        f"/api/projects/{project_id}/pages/1/runs/{run_id}/apply", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    blocks = response.json()["blocks"]

    lines = lines_of(project_id, library_dir)
    by_block: dict[str, list] = {}
    for line in lines:
        by_block.setdefault(line.block_id, []).append(line)
    for block in blocks:
        assert by_block.get(block["block_id"]), f"块 {block['block_id']} 缺行记录"
        assert all(line.bbox for line in by_block[block["block_id"]])
        assert all(line.text for line in by_block[block["block_id"]])


# ---------------------------------------------------------------- 框选新增块

def test_creating_a_block_with_a_box_inserts_it_by_position(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """框选的竖直位置决定插在阅读顺序的哪里（说明书 6.4 的框选补 bbox）。"""
    project_id = recognized_page
    before = page_blocks(client, auth_headers, project_id)["blocks"]
    assert len(before) >= 2
    # 假引擎的两块分别在 y=0.10–0.17 与 0.26–0.29 附近；框在最上面 → 应该插到第 0 位
    response = client.post(
        f"/api/projects/{project_id}/pages/1/blocks",
        json={"text": "漏检的书眉", "bbox": [0.1, 0.02, 0.9, 0.06]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    blocks = response.json()["blocks"]
    assert blocks[0]["text"] == "漏检的书眉", "框在最上面就该排第一"
    assert blocks[0]["bbox"] == [0.1, 0.02, 0.9, 0.06]
    assert [block["block_id"] for block in blocks[1:]] == [b["block_id"] for b in before]
    assert [block["order_index"] for block in blocks] == list(range(len(blocks)))


def test_creating_a_block_in_the_middle_keeps_reading_order(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    project_id = recognized_page
    before = page_blocks(client, auth_headers, project_id)["blocks"]
    # 框在第一块与第二块之间 → 插在第 1 位
    response = client.post(
        f"/api/projects/{project_id}/pages/1/blocks",
        json={"text": "中间漏掉的一行", "bbox": [0.1, 0.20, 0.9, 0.24]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    blocks = response.json()["blocks"]
    assert [block["text"] for block in blocks][:3][1] == "中间漏掉的一行"
    assert blocks[0]["block_id"] == before[0]["block_id"]


def test_creating_a_block_without_a_box_goes_last_and_has_no_position(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """不框选就是"无位置信息"（说明书 6.4），追加在最后。"""
    project_id = recognized_page
    before = page_blocks(client, auth_headers, project_id)["blocks"]
    response = client.post(
        f"/api/projects/{project_id}/pages/1/blocks",
        json={"text": "补的一段"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    blocks = response.json()["blocks"]
    assert blocks[-1]["text"] == "补的一段"
    assert blocks[-1]["bbox"] is None
    assert len(blocks) == len(before) + 1


def test_box_coordinates_must_be_normalized(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    response = client.post(
        f"/api/projects/{recognized_page}/pages/1/blocks",
        json={"text": "越界", "bbox": [0.1, 0.1, 1.4, 0.5]},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_bbox"


def test_box_created_block_is_undoable(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """框选新增也进撤销栈（说明书 6.4 / 5.3）。"""
    project_id = recognized_page
    before = page_blocks(client, auth_headers, project_id)["blocks"]
    client.post(
        f"/api/projects/{project_id}/pages/1/blocks",
        json={"text": "误框的", "bbox": [0.1, 0.02, 0.9, 0.06]},
        headers=auth_headers,
    )
    undo = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undo.status_code == 200, undo.text
    after = page_blocks(client, auth_headers, project_id)["blocks"]
    assert [block["block_id"] for block in after] == [block["block_id"] for block in before]
