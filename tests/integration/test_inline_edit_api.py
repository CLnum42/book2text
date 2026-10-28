"""就地编辑的提交与撤销（任务 66）。

两条钉住：

1. **只写被编辑的那一行**——其它行的文本一个字节都不许变（2026-10-28 我一度改成
   "整块重写"，会把 5000 多个本来一致的块全动一遍，已退回）；
2. **一次撤销全退**：3 处编辑在同一个 batch 里，撤销后块文本与行文本都回到提交前。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module


def _lines(library: Path, project_id: str) -> dict[tuple[str, int], str]:
    return {
        (line.block_id, line.line_index): line.text
        for line in blocks_module.list_block_lines(project_id, library=library)
    }


def _blocks(library: Path, project_id: str) -> dict[str, str]:
    return {
        block.block_id: block.text
        for block in blocks_module.list_blocks(project_id, library=library)
    }


@pytest.fixture
def recognized_page(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs,
) -> str:
    """一页已识别（假引擎）：就地编辑只关心块 / 行文本，不需要真 OCR。"""
    response = client.post(
        "/api/projects",
        params={"name": "就地编辑", "filename": sample_pdf.name},
        content=sample_pdf.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    project_id = response.json()["project"]["project_id"]
    started = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert started.status_code == 200, started.text
    return project_id


def test_inline_edit_writes_only_that_line_and_undo_restores(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_page: str,
) -> None:
    project_id = recognized_page
    before_lines = _lines(library_dir, project_id)
    before_blocks = _blocks(library_dir, project_id)

    # 挑一个至少 2 行的块：只改第 0 行
    target = None
    for block_id, text in before_blocks.items():
        count = len([k for k in before_lines if k[0] == block_id])
        if count >= 2:
            target = (block_id, text)
            break
    assert target, "夹具里应当有 2 行以上的块"
    block_id, block_text = target
    old_line = before_lines[(block_id, 0)]
    items = [{"block_id": block_id, "line_index": 0, "new_line_text": old_line + "X", "ack": None}]

    response = client.post(
        f"/api/projects/{project_id}/review/submit-drafts",
        json={"items": items},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["committed"] == 1

    after_lines = _lines(library_dir, project_id)
    after_blocks = _blocks(library_dir, project_id)
    assert after_lines[(block_id, 0)] == old_line + "X"
    # 其它行一个字节都不许变
    for key, value in before_lines.items():
        if key == (block_id, 0):
            continue
        assert after_lines[key] == value, f"{key} 不该被改动"
    # 块文本与行文本一致
    joined = "\n".join(after_lines[(block_id, i)] for i in range(
        len([k for k in after_lines if k[0] == block_id])
    ))
    assert after_blocks[block_id] == joined

    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undone.status_code == 200, undone.text
    restored_lines = _lines(library_dir, project_id)
    restored_blocks = _blocks(library_dir, project_id)
    assert restored_lines[(block_id, 0)] == old_line
    assert restored_blocks[block_id] == block_text
    assert restored_lines == before_lines, "撤销后所有行文本都要回到提交前"


def test_three_inline_edits_share_one_batch_and_one_undo(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_page: str,
) -> None:
    project_id = recognized_page
    before = _lines(library_dir, project_id)
    keys = list(before.keys())[:3]
    items = [
        {"block_id": block_id, "line_index": line_index,
         "new_line_text": before[(block_id, line_index)] + "Y", "ack": None}
        for block_id, line_index in keys
    ]
    response = client.post(
        f"/api/projects/{project_id}/review/submit-drafts",
        json={"items": items},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["committed"] == 3
    assert response.json()["history"]["undo"] == 1, "一次提交只该占一格撤销"

    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undone.status_code == 200, undone.text
    assert _lines(library_dir, project_id) == before
