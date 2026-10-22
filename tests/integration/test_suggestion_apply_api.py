"""全库采用高把握建议 + 识别完成后自动应用（任务 48）。

- 扫描只读：`dry_run` 不写库、不进撤销栈；
- 应用一次一个 batch：撤销一次全部回退；
- 自动应用开关默认关；打开后由**识别任务收尾**在服务端执行，记一条 `auto_apply_run`；
- 撤销自动应用按 batch_id 从事件表把那一批捞回来；之后有别的修改就拒绝。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module
from book2text.core.project import recognition
from tests.fakes import FakeOcrEngine

HEADER_RECT = [0.10, 0.01, 0.90, 0.05]


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "批量建议", "filename": pdf.name},
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


def blocks_of(
    client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1
) -> list[dict]:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()["blocks"]


def patch_block(
    client: TestClient, headers: dict[str, str], project_id: str, block: dict, values: dict
) -> None:
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json=values,
        headers=headers,
    )
    assert response.status_code == 200, response.text


def make_headers(
    client: TestClient, headers: dict[str, str], project_id: str, pages: list[int]
) -> None:
    """把每页第一块伪装成书眉（页面顶部 + 跨页重复的文字）。"""
    for page_no in pages:
        blocks = blocks_of(client, headers, project_id, page_no)
        patch_block(
            client,
            headers,
            project_id,
            blocks[0],
            {"text": "导读巴赫金", "bbox": HEADER_RECT},
        )


def use_header_engine(engine: FakeOcrEngine) -> None:
    """让假引擎吐一行"页面顶部的书眉 + 一行正文"。

    `inprocess_jobs` 把引擎实例绑在闭包里，这里改它的行定义即可（同一个对象）。
    """
    # 三行：顶部书眉 + 两行正文。两行时"常规行距"等于唯一那个行距，
    # 分段规则永远不会另起一块（见 grouping.py 的 median 规则）。
    engine._lines = (
        ("导读巴赫金", 0.01, 0.04),
        ("第一段第一行。", 0.30, 0.33),
        ("第一段第二行。", 0.34, 0.37),
    )


@pytest.fixture
def project_with_pages(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, [1, 2, 3])
    return project_id


# ---------------------------------------------------------------- 全库扫描 / 应用

def test_scan_preview_is_read_only_and_apply_is_one_batch(
    client: TestClient, auth_headers: dict[str, str], project_with_pages: str
) -> None:
    project_id = project_with_pages
    make_headers(client, auth_headers, project_id, [1, 2, 3])
    # 再来一个纯数字块：按"页码形态"也应该是 high
    blocks = blocks_of(client, auth_headers, project_id, 1)
    patch_block(client, auth_headers, project_id, blocks[1], {"text": "12", "bbox": HEADER_RECT})
    # 正文区域里像标题的块：标题只给 review，永远不进批量
    blocks = blocks_of(client, auth_headers, project_id, 2)
    patch_block(client, auth_headers, project_id, blocks[1], {"text": "第一章 导论"})

    before = blocks_of(client, auth_headers, project_id, 1)[0]["block_type"]
    assert before == "paragraph"
    undo_before = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["history"]["undo"]

    preview = client.post(
        f"/api/projects/{project_id}/suggestions/apply",
        json={"dry_run": True},
        headers=auth_headers,
    )
    assert preview.status_code == 200, preview.text
    plan = preview.json()
    assert plan["dry_run"] is True
    assert plan["pages"] == 3 and plan["blocks"] == 4, plan
    assert plan["by_type"] == {"header": 3, "page_number": 1}
    assert "heading" not in plan["by_type"]
    assert plan["history"]["undo"] == undo_before, "扫描不写库、也不进撤销栈"
    assert blocks_of(client, auth_headers, project_id, 1)[0]["block_type"] == "paragraph"

    applied = client.post(
        f"/api/projects/{project_id}/suggestions/apply",
        json={"dry_run": False},
        headers=auth_headers,
    )
    assert applied.status_code == 200, applied.text
    result = applied.json()
    assert result["blocks"] == 4
    assert result["history"]["undo"] == undo_before + 1, "整批只占一次撤销"
    assert blocks_of(client, auth_headers, project_id, 1)[0]["block_type"] == "header"
    assert any(block["block_type"] == "page_number" for block in blocks_of(client, auth_headers, project_id, 1))

    undo = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undo.status_code == 200, undo.text
    assert undo.json()["history"]["undo"] == undo_before
    assert blocks_of(client, auth_headers, project_id, 1)[0]["block_type"] == "paragraph"


def test_scan_reports_nothing_when_every_block_is_already_typed(
    client: TestClient, auth_headers: dict[str, str], project_with_pages: str
) -> None:
    project_id = project_with_pages
    preview = client.post(
        f"/api/projects/{project_id}/suggestions/apply",
        json={"dry_run": True},
        headers=auth_headers,
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["blocks"] == 0
    assert preview.json()["pages"] == 0


# ---------------------------------------------------------------- 项目设置

def test_auto_apply_setting_defaults_off_and_round_trips(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    detail = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()
    assert detail["project"]["settings"] == {}, "默认关：不写任何设置"

    response = client.patch(
        f"/api/projects/{project_id}/settings",
        json={"auto_apply_high_suggestions": True},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["settings"]["auto_apply_high_suggestions"] is True
    detail = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()
    assert detail["project"]["settings"]["auto_apply_high_suggestions"] is True

    bad = client.patch(
        f"/api/projects/{project_id}/settings",
        json={"unknown_setting": True},
        headers=auth_headers,
    )
    assert bad.status_code == 400, bad.text


# ---------------------------------------------------------------- 自动应用

def test_auto_apply_runs_at_job_end_and_can_be_undone(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    use_header_engine(inprocess_jobs)
    project_id = create_project(client, auth_headers, sample_pdf)
    client.patch(
        f"/api/projects/{project_id}/settings",
        json={"auto_apply_high_suggestions": True},
        headers=auth_headers,
    )
    recognize(client, auth_headers, project_id, [1, 2, 3])

    for page_no in (1, 2, 3):
        types = [block["block_type"] for block in blocks_of(client, auth_headers, project_id, page_no)]
        assert "header" in types, f"第 {page_no} 页的书眉应当自动改成 header：{types}"

    latest = client.get(f"/api/projects/{project_id}/auto-apply", headers=auth_headers).json()["latest"]
    assert latest is not None
    assert latest["status"] == "applied"
    assert latest["pages"] == 3 and latest["blocks"] == 3
    assert latest["by_type"] == {"header": 3}

    undone = client.post(
        f"/api/projects/{project_id}/auto-apply/{latest['auto_apply_id']}/undo",
        headers=auth_headers,
    )
    assert undone.status_code == 200, undone.text
    assert undone.json()["status"] == "undone"
    assert undone.json()["pages_affected"] == [1, 2, 3]
    for page_no in (1, 2, 3):
        types = [block["block_type"] for block in blocks_of(client, auth_headers, project_id, page_no)]
        assert "header" not in types

    again = client.post(
        f"/api/projects/{project_id}/auto-apply/{latest['auto_apply_id']}/undo",
        headers=auth_headers,
    )
    assert again.status_code == 400, "同一批不许重复撤销"


def test_auto_apply_undo_is_refused_after_later_edits(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    use_header_engine(inprocess_jobs)
    project_id = create_project(client, auth_headers, sample_pdf)
    client.patch(
        f"/api/projects/{project_id}/settings",
        json={"auto_apply_high_suggestions": True},
        headers=auth_headers,
    )
    recognize(client, auth_headers, project_id, [1, 2, 3])
    latest = client.get(f"/api/projects/{project_id}/auto-apply", headers=auth_headers).json()["latest"]
    assert latest and latest["status"] == "applied"

    # 自动应用之后又手改了一块：撤销整批会覆盖这次修改，所以拒绝
    blocks = blocks_of(client, auth_headers, project_id, 1)
    patch_block(client, auth_headers, project_id, blocks[0], {"block_type": "other"})
    refused = client.post(
        f"/api/projects/{project_id}/auto-apply/{latest['auto_apply_id']}/undo",
        headers=auth_headers,
    )
    assert refused.status_code == 400, refused.text
    assert "别的修改" in refused.json()["error"]["message"]


def test_switching_auto_apply_off_keeps_plain_suggestions(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    use_header_engine(inprocess_jobs)
    project_id = create_project(client, auth_headers, sample_pdf)
    client.patch(
        f"/api/projects/{project_id}/settings",
        json={"auto_apply_high_suggestions": False},
        headers=auth_headers,
    )
    recognize(client, auth_headers, project_id, [1, 2, 3])
    latest = client.get(f"/api/projects/{project_id}/auto-apply", headers=auth_headers).json()["latest"]
    assert latest is None, "开关关着时不该写自动应用记录"
    for page_no in (1, 2, 3):
        types = [block["block_type"] for block in blocks_of(client, auth_headers, project_id, page_no)]
        assert "header" not in types, "关着时行为与以前一样：只建议，不改类型"
    # 建议还在：扫描仍然能算出来（只是不自动应用）
    preview = client.post(
        f"/api/projects/{project_id}/suggestions/apply",
        json={"dry_run": True},
        headers=auth_headers,
    ).json()
    assert preview["blocks"] == 3
