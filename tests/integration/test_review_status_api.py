"""审校「待处理」与自动通过接口（任务 61 / 工作流阶段 9）。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import recognition
from book2text.core.project import review_status
from tests.conftest import TEST_TOKEN
from tests.fakes import FAKE_LINES, FakeSecondEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "审校状态测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def ocr(client: TestClient, headers: dict[str, str], project_id: str, pages: list[int]) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": pages, "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def page_blocks(client: TestClient, headers: dict[str, str], project_id: str, page_no: int):
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def blocks_digest(payload: dict) -> str:
    texts = [
        (block["block_id"], block["text"], block["block_type"], block["bbox"])
        for block in payload["blocks"]
    ]
    return hashlib.sha256(
        json.dumps(texts, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def prepare_page(
    client: TestClient,
    headers: dict[str, str],
    project_id: str,
    pages: list[int],
) -> None:
    response = client.put(
        f"/api/projects/{project_id}/margin-box",
        json={"margin_box": [0.1, 0.1, 0.9, 0.9]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    response = client.post(
        f"/api/projects/{project_id}/pages/{pages[0]}/layout/confirm",
        json={"page_numbers": pages},
        headers=headers,
    )
    assert response.status_code == 200, response.text


@pytest.fixture
def project_with_ocr(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs,
) -> str:
    project_id = create_project(client, auth_headers, sample_pdf)
    ocr(client, auth_headers, project_id, [1, 2])
    prepare_page(client, auth_headers, project_id, [1, 2])
    return project_id


def test_auto_pass_marks_auto_without_changing_text_and_can_be_revoked(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
    library_dir: Path,
    monkeypatch,
) -> None:
    project_id = project_with_ocr
    # 合成样书的空白区域会被判成"可能漏行"；本用例只验证自动通过的状态逻辑，
    # 漏行检测本身由 ink_gaps 的既有测试与真浏览器验收覆盖。
    monkeypatch.setattr(
        review_status.ink_gaps_module,
        "find_ink_gaps",
        lambda *args, **kwargs: {"candidates": []},
    )
    before = page_blocks(client, auth_headers, project_id, 1)
    before_digest = blocks_digest(before)
    assert before["workflow"]["confirm_mode"] is None

    # 第二引擎按同样的三行文本复核：无分歧，满足自动通过
    recognition.run_auxiliary(
        library_dir / project_id,
        1,
        engine=FakeSecondEngine(texts=[text for text, _, _ in FAKE_LINES]),
    )

    pending = client.get(
        f"/api/projects/{project_id}/review/pending", headers=auth_headers
    ).json()
    # 第 2 页版面已确认、版心已定，但没跑第二引擎 → 仍在待处理里，理由是单引擎
    page2 = next(item for item in pending["pages"] if item["page_no"] == 2)
    assert any(reason["code"] == "single_engine" for reason in page2["reasons"])

    response = client.post(
        f"/api/projects/{project_id}/pages/1/auto-pass", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    assert response.json()["applied"] is True

    after = page_blocks(client, auth_headers, project_id, 1)
    assert blocks_digest(after) == before_digest, "自动通过绝不能改块文本 / 类型 / 框"
    assert after["workflow"]["stage"] == "human_confirmed"
    assert after["workflow"]["confirm_mode"] == "auto"
    assert after["workflow"]["stage_label"] == "自动通过（未经人工）"

    auto_list = client.get(
        f"/api/projects/{project_id}/review/auto-passed", headers=auth_headers
    ).json()
    assert [item["page_no"] for item in auto_list["pages"]] == [1]

    revoked = client.post(
        f"/api/projects/{project_id}/pages/1/auto-pass/revoke", headers=auth_headers
    )
    assert revoked.status_code == 200, revoked.text
    after_revoke = page_blocks(client, auth_headers, project_id, 1)
    assert after_revoke["workflow"]["confirm_mode"] is None
    assert after_revoke["workflow"]["auto_pass_excluded"] is True
    pending_after = client.get(
        f"/api/projects/{project_id}/review/pending", headers=auth_headers
    ).json()
    page1 = next(item for item in pending_after["pages"] if item["page_no"] == 1)
    assert any(
        reason["code"] == "auto_pass_excluded" for reason in page1["reasons"]
    ), "撤销自动通过的页必须回到待处理"
    # 撤销后不再自动通过（即使条件仍然满足）
    again = client.post(
        f"/api/projects/{project_id}/pages/1/auto-pass", headers=auth_headers
    )
    assert again.status_code == 409
    assert "自动通过" in again.text or "条件" in again.text


def test_single_engine_page_cannot_auto_pass(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
) -> None:
    project_id = project_with_ocr
    check = client.get(
        f"/api/projects/{project_id}/pages/2/auto-pass", headers=auth_headers
    )
    assert check.status_code == 200, check.text
    data = check.json()
    assert data["eligible"] is False
    assert any(reason["code"] == "single_engine" for reason in data["reasons"])
    response = client.post(
        f"/api/projects/{project_id}/pages/2/auto-pass", headers=auth_headers
    )
    assert response.status_code == 409


def test_human_confirmation_is_distinguished_from_auto(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
) -> None:
    project_id = project_with_ocr
    response = client.post(
        f"/api/projects/{project_id}/pages/2/confirm", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    payload = page_blocks(client, auth_headers, project_id, 2)
    assert payload["workflow"]["confirm_mode"] == "human"
    assert payload["workflow"]["stage_label"] == "人工已确认"
    data = client.get(
        f"/api/projects/{project_id}/workflow", headers=auth_headers
    ).json()
    assert data["confirmation_counts"]["human"] == 1
    assert data["confirmation_counts"]["auto"] == 0
    # 人工确认后不允许自动通过覆盖
    auto = client.post(
        f"/api/projects/{project_id}/pages/2/auto-pass", headers=auth_headers
    )
    assert auto.status_code == 409


def test_export_preflight_and_manifest_include_workflow_snapshot(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
    library_dir: Path,
) -> None:
    project_id = project_with_ocr
    preflight = client.post(
        f"/api/projects/{project_id}/export/preflight",
        json={"format": "txt"},
        headers=auth_headers,
    )
    assert preflight.status_code == 200, preflight.text
    status = preflight.json()["workflow_status"]
    assert status["total"] == 3
    assert status["layout_unconfirmed"] >= 1
    for key in (
        "human_confirmed",
        "auto_passed",
        "single_engine",
        "layout_unconfirmed",
        "recognition_failed",
    ):
        assert key in status

    exported = client.post(
        f"/api/projects/{project_id}/export",
        json={"format": "txt"},
        headers=auth_headers,
    )
    assert exported.status_code == 200, exported.text
    record = exported.json()["record"]
    manifest_path = (
        library_dir / project_id / "exports" / record["export_id"] / "manifest.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["workflow"] == status


def test_finish_summary_and_batch_auto_pass_are_real_and_safe(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
    library_dir: Path,
    monkeypatch,
) -> None:
    """任务 66：收尾汇总六个状态 + 批量自动通过（只标状态、可整批撤销）。"""
    project_id = project_with_ocr
    monkeypatch.setattr(
        review_status.ink_gaps_module,
        "find_ink_gaps",
        lambda *args, **kwargs: {"candidates": []},
    )
    recognition.run_auxiliary(
        library_dir / project_id,
        1,
        engine=FakeSecondEngine(texts=[text for text, _, _ in FAKE_LINES]),
    )

    summary = client.get(
        f"/api/projects/{project_id}/review/finish-summary", headers=auth_headers
    )
    assert summary.status_code == 200, summary.text
    data = summary.json()
    assert set(data) >= {
        "page_type",
        "margin",
        "layout",
        "page_numbers",
        "review",
        "engine",
        "k",
    }
    assert data["page_type"]["total"] >= 1
    assert data["layout"]["confirmed"] == 2
    assert 1 in data["review"]["auto_passable_pages"]
    assert 2 not in data["review"]["auto_passable_pages"], "单引擎页不能自动通过"
    assert data["engine"]["checked"] >= 1
    assert data["k_total"] == 6

    before = blocks_digest(page_blocks(client, auth_headers, project_id, 1))
    processed = client.post(
        f"/api/projects/{project_id}/review/auto-pass",
        json={"page_numbers": [1, 2]},
        headers=auth_headers,
    )
    assert processed.status_code == 200, processed.text
    payload = processed.json()
    assert payload["applied"] == [1]
    assert payload["applied_count"] == 1
    assert any(item["page_no"] == 2 for item in payload["skipped"])
    after = blocks_digest(page_blocks(client, auth_headers, project_id, 1))
    assert after == before, "批量自动通过也不能改块文本"

    revoked = client.post(
        f"/api/projects/{project_id}/review/auto-pass/revoke",
        json={"page_numbers": [1]},
        headers=auth_headers,
    )
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["revoked"] == [1]
    page1 = page_blocks(client, auth_headers, project_id, 1)
    assert page1["workflow"]["confirm_mode"] is None
    assert page1["workflow"]["auto_pass_excluded"] is True
