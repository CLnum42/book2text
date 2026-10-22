"""可疑漏行检测（任务 49）：有墨迹、但没有任何行框覆盖的横条。

算法用**渲染出来的图**判断，所以这里测的是"真的渲染 → 真的二值化 → 真的求差"，
不是 mock。漏行的构造方式与真实情况一致：把一条 `block_line` 记录删掉——
页面上的字还在，只是没有行框认领它。
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
        params={"name": "漏行检测", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, pages: list[int]) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": pages, "skip_recognized": False},
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


def ink_gaps(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/ink-gaps", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def delete_line(library_dir: Path, project_id: str, line_id: str) -> dict:
    """删掉一条行记录（模拟检测阶段漏了一行），返回它的原值以便还原。"""
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        row = conn.execute("SELECT * FROM block_line WHERE line_id = ?", (line_id,)).fetchone()
        values = {name: row[name] for name in row.keys()}
        conn.execute("DELETE FROM block_line WHERE line_id = ?", (line_id,))
        conn.commit()
    return values


def restore_line(library_dir: Path, project_id: str, values: dict) -> None:
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        conn.execute(
            "INSERT INTO block_line (line_id, block_id, line_index, bbox, text, aux_text,"
            " diff_status, layout_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                values["line_id"],
                values["block_id"],
                values["line_index"],
                values["bbox"],
                values["text"],
                values["aux_text"],
                values["diff_status"],
                values["layout_status"],
            ),
        )
        conn.commit()


@pytest.fixture
def recognized_page(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, [1])
    return project_id


def test_a_page_whose_lines_are_all_covered_reports_nothing(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """行框齐全时一处都不报（误报会变成噪声）。"""
    result = ink_gaps(client, auth_headers, recognized_page)
    assert result["candidates"] == []
    assert result["rendered_dpi"] == 150


def test_a_deleted_line_is_reported_and_disappears_when_restored(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_page: str,
) -> None:
    """把中间那条行记录删掉 → 报 1 处，位置与那一行重合；还原后回到 0。"""
    project_id = recognized_page
    blocks = page_blocks(client, auth_headers, project_id)["blocks"]
    lines = [line for block in blocks for line in block["lines"]]
    assert len(lines) == 3, "假引擎：3 行"
    target = lines[1]
    values = delete_line(library_dir, project_id, target["line_id"])

    result = ink_gaps(client, auth_headers, project_id)
    assert len(result["candidates"]) == 1, result
    band = result["candidates"][0]["bbox"]
    # 条带的中心落在删掉那一行的竖直范围内（笔画比行框略窄，不要求完全覆盖）
    center = (band[1] + band[3]) / 2
    assert target["bbox"][1] - 0.01 <= center <= target["bbox"][3] + 0.01
    assert 0 < result["candidates"][0]["ink_ratio"] < 1
    assert result["candidates"][0]["height_ratio"] >= 0.01

    restore_line(library_dir, project_id, values)
    assert ink_gaps(client, auth_headers, project_id)["candidates"] == []


def test_a_page_without_lines_is_not_checked(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    result = ink_gaps(client, auth_headers, project_id)
    assert result["candidates"] == []
    assert "没有行记录" in (result["note"] or "")


def test_unknown_page_is_404(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    response = client.get(
        f"/api/projects/{recognized_page}/pages/99/ink-gaps", headers=auth_headers
    )
    assert response.status_code == 404


def test_creating_a_manual_block_clears_the_candidate(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_page: str,
) -> None:
    """用户用「框选新增块」补上这一行之后，不该再提示它。

    人工新增的块没有行记录——但它就是"人已经处理过这块区域"的证据。
    """
    project_id = recognized_page
    blocks = page_blocks(client, auth_headers, project_id)["blocks"]
    target = [line for block in blocks for line in block["lines"]][1]
    values = delete_line(library_dir, project_id, target["line_id"])
    assert len(ink_gaps(client, auth_headers, project_id)["candidates"]) == 1

    created = client.post(
        f"/api/projects/{project_id}/pages/1/blocks",
        json={"text": "这一行是人工补的", "bbox": target["bbox"]},
        headers=auth_headers,
    )
    assert created.status_code == 200, created.text
    assert ink_gaps(client, auth_headers, project_id)["candidates"] == []
    restore_line(library_dir, project_id, values)
