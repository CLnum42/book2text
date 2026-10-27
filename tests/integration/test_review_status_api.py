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
    # 任务 33：auto 页读本页落库框，不再继承全局框；这些用例没有检测行，
    # 所以显式给每页一个本页框（否则版心未定，自动通过按设计拒绝）。
    for page_no in pages:
        response = client.patch(
            f"/api/projects/{project_id}/pages/{page_no}/margin-box",
            json={"margin_box_mode": "custom", "margin_box": [0.1, 0.1, 0.9, 0.9]},
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
        "diff_kept",
        "diff_adopted",
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


def test_diff_ack_kept_persists_survives_aux_and_undoes(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
    library_dir: Path,
    monkeypatch,
) -> None:
    """任务 67：保留原文持久化；重跑复核不覆盖；撤销回 pending。"""
    project_id = project_with_ocr
    monkeypatch.setattr(
        review_status.ink_gaps_module,
        "find_ink_gaps",
        lambda *args, **kwargs: {"candidates": []},
    )
    # 让第 1 页每一行都和第二路不同，便于取第一条差异
    recognition.run_auxiliary(
        library_dir / project_id,
        1,
        engine=FakeSecondEngine(texts=["完全不同的第二路文本"]),
    )
    before = page_blocks(client, auth_headers, project_id, 1)
    block = next(item for item in before["blocks"] if item["divergence"]["marks"])
    mark = block["divergence"]["marks"][0]
    before_lines = block["divergence"]["lines"]
    assert mark["ack"] is None

    acked = client.post(
        f"/api/projects/{project_id}/blocks/{block['block_id']}/diff-ack",
        json={"line_index": mark["line_index"], "ack": "kept"},
        headers=auth_headers,
    )
    assert acked.status_code == 200, acked.text
    after = page_blocks(client, auth_headers, project_id, 1)
    block_after = next(item for item in after["blocks"] if item["block_id"] == block["block_id"])
    assert block_after["divergence"]["lines"] == before_lines - 1
    saved = next(
        item for item in block_after["divergence"]["marks"]
        if item["line_index"] == mark["line_index"]
    )
    assert saved["ack"] == "kept"

    # 重跑复核：行文本没变，ack 仍然保留
    recognition.run_auxiliary(
        library_dir / project_id,
        1,
        engine=FakeSecondEngine(texts=["完全不同的第二路文本"]),
    )
    rerun = page_blocks(client, auth_headers, project_id, 1)
    block_rerun = next(item for item in rerun["blocks"] if item["block_id"] == block["block_id"])
    saved = next(
        item for item in block_rerun["divergence"]["marks"]
        if item["line_index"] == mark["line_index"]
    )
    assert saved["ack"] == "kept"
    assert block_rerun["divergence"]["lines"] == before_lines - 1
    preflight = client.post(
        f"/api/projects/{project_id}/export/preflight",
        json={"format": "txt"},
        headers=auth_headers,
    )
    assert preflight.status_code == 200, preflight.text
    assert preflight.json()["workflow_status"]["diff_kept"] == 1

    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undone.status_code == 200, undone.text
    restored = page_blocks(client, auth_headers, project_id, 1)
    block_restored = next(item for item in restored["blocks"] if item["block_id"] == block["block_id"])
    assert block_restored["divergence"]["lines"] == before_lines
    saved = next(
        item for item in block_restored["divergence"]["marks"]
        if item["line_index"] == mark["line_index"]
    )
    assert saved["ack"] is None


def test_adopt_ack_changes_text_and_undoes_in_one_batch(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
    library_dir: Path,
) -> None:
    """任务 67：采纳 = 文本 + ack 同一个 batch，⌘Z 一次全退。"""
    project_id = project_with_ocr
    recognition.run_auxiliary(
        library_dir / project_id,
        1,
        engine=FakeSecondEngine(texts=["完全不同的第二路文本"]),
    )
    payload = page_blocks(client, auth_headers, project_id, 1)
    block = next(item for item in payload["blocks"] if item["divergence"]["marks"])
    mark = block["divergence"]["marks"][0]
    lines = block["text"].split("\n")
    lines[mark["line_index"]] = mark["candidate"]
    new_text = "\n".join(lines)

    adopted = client.post(
        f"/api/projects/{project_id}/blocks/{block['block_id']}/diff-ack",
        json={"line_index": mark["line_index"], "ack": "adopted", "text": new_text},
        headers=auth_headers,
    )
    assert adopted.status_code == 200, adopted.text
    after = page_blocks(client, auth_headers, project_id, 1)
    changed = next(item for item in after["blocks"] if item["block_id"] == block["block_id"])
    assert changed["text"] == new_text
    assert changed["divergence"]["acked"] == 1

    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undone.status_code == 200, undone.text
    restored = page_blocks(client, auth_headers, project_id, 1)
    back = next(item for item in restored["blocks"] if item["block_id"] == block["block_id"])
    assert back["text"] == block["text"]
    assert back["divergence"]["acked"] == 0


def test_all_diff_ack_makes_page_eligible_for_auto_pass(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
    library_dir: Path,
    monkeypatch,
) -> None:
    """任务 67 验收：全部差异 ack 后，页面不再因差异被自动通过拒绝。"""
    project_id = project_with_ocr
    monkeypatch.setattr(
        review_status.ink_gaps_module,
        "find_ink_gaps",
        lambda *args, **kwargs: {"candidates": []},
    )
    recognition.run_auxiliary(
        library_dir / project_id,
        1,
        engine=FakeSecondEngine(texts=["完全不同的第二路文本"]),
    )
    payload = page_blocks(client, auth_headers, project_id, 1)
    for block in payload["blocks"]:
        for mark in block["divergence"]["marks"]:
            response = client.post(
                f"/api/projects/{project_id}/blocks/{block['block_id']}/diff-ack",
                json={"line_index": mark["line_index"], "ack": "kept"},
                headers=auth_headers,
            )
            assert response.status_code == 200, response.text
    after = page_blocks(client, auth_headers, project_id, 1)
    assert after["divergence"]["lines"] == 0
    check = client.get(
        f"/api/projects/{project_id}/pages/1/auto-pass", headers=auth_headers
    )
    assert check.status_code == 200, check.text
    assert check.json()["eligible"] is True


def test_page_payload_marks_margin_inside_and_counts_outside(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
    library_dir: Path,
) -> None:
    """任务 34：页详情逐块标 margin_inside；页头差异只算版心内，版心外单独计数。"""
    project_id = project_with_ocr
    recognition.run_auxiliary(
        library_dir / project_id,
        1,
        engine=FakeSecondEngine(texts=[text for text, _, _ in FAKE_LINES]),
    )
    # 把第 1 页版心压到第一个块那一小块：其余块都算版心外
    original = page_blocks(client, auth_headers, project_id, 1)
    first_box = original["blocks"][0]["bbox"]
    narrow = [
        max(0.0, first_box[0] - 0.02),
        max(0.0, first_box[1] - 0.02),
        min(1.0, first_box[2] + 0.02),
        min(1.0, first_box[3] + 0.02),
    ]
    response = client.patch(
        f"/api/projects/{project_id}/pages/1/margin-box",
        json={"margin_box_mode": "custom", "margin_box": narrow},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text

    data = page_blocks(client, auth_headers, project_id, 1)
    assert data["margin"]["applied"] is True
    outside = [block for block in data["blocks"] if not block["margin_inside"]]
    inside = [block for block in data["blocks"] if block["margin_inside"]]
    assert outside, "压窄版心后应该有块落在版心外"
    assert inside, "上半页至少还有块在版心内"
    assert data["margin"]["outside_blocks"] == len(outside)

    expected_chars = sum(
        block["divergence"]["chars"] for block in inside if not block["divergence"]["stale"]
    )
    expected_punct = sum(
        block["divergence"]["punct"] for block in inside if not block["divergence"]["stale"]
    )
    assert data["divergence"]["chars"] == expected_chars
    assert data["divergence"]["punct"] == expected_punct

    outside_lines = sum(
        block["divergence"]["chars"] + block["divergence"]["punct"]
        for block in outside
        if not block["divergence"]["stale"]
    )
    assert data["margin"]["outside_lines"]["lines"] == outside_lines

    # 页级 none：整页都算，不排除任何块
    response = client.patch(
        f"/api/projects/{project_id}/pages/1/margin-box",
        json={"margin_box_mode": "none"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    none_page = page_blocks(client, auth_headers, project_id, 1)
    assert none_page["margin"]["none"] is True
    assert none_page["margin"]["applied"] is False
    assert all(block["margin_inside"] for block in none_page["blocks"])


def test_finish_summary_keeps_review_open_until_continuations_confirmed(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
    library_dir: Path,
    monkeypatch,
) -> None:
    """任务 42：F1 第三桶（跨页延续待人工）没确认完，正文审校不算完成。"""
    project_id = project_with_ocr
    # 合成样书 3 页；夹具只识别了前两页，这里把第 3 页也补齐，好让"审校"只剩跨页延续
    ocr(client, auth_headers, project_id, [3])
    prepare_page(client, auth_headers, project_id, [1, 2, 3])
    monkeypatch.setattr(
        review_status.ink_gaps_module,
        "find_ink_gaps",
        lambda *args, **kwargs: {"candidates": []},
    )
    for page_no in (1, 2, 3):
        recognition.run_auxiliary(
            library_dir / project_id,
            page_no,
            engine=FakeSecondEngine(texts=[text for text, _, _ in FAKE_LINES]),
        )
    passed = client.post(
        f"/api/projects/{project_id}/review/auto-pass",
        json={"page_numbers": [1, 2, 3]},
        headers=auth_headers,
    )
    assert passed.status_code == 200, passed.text
    assert sorted(passed.json()["applied"]) == [1, 2, 3]

    summary = client.get(
        f"/api/projects/{project_id}/review/finish-summary", headers=auth_headers
    ).json()
    review = summary["review"]
    assert review["needs_human"] == 0
    assert review["auto_passable"] == 0
    assert review["continuation_pending"] == 2
    assert review["continuation_total"] == 2
    assert review["complete"] is False, "跨页延续还有人没看，审校不能算完成"

    pending = client.get(
        f"/api/projects/{project_id}/cleanup/continuations/pending",
        headers=auth_headers,
    ).json()
    assert pending["count"] == 2
    assert [entry["page_no"] for entry in pending["entries"]] == [1, 2]
    for entry in pending["entries"]:
        resolved = client.post(
            f"/api/projects/{project_id}/cleanup/continuations/resolve",
            json={"block_id": entry["block_id"], "continues": True},
            headers=auth_headers,
        )
        assert resolved.status_code == 200, resolved.text

    summary = client.get(
        f"/api/projects/{project_id}/review/finish-summary", headers=auth_headers
    ).json()
    assert summary["review"]["continuation_pending"] == 0
    assert summary["review"]["complete"] is True

def test_block_edit_looks_up_page_in_one_query(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
    monkeypatch,
) -> None:
    """任务 43：块编辑不再"逐页翻块找这一块"。

    以前 `_require_page_editable` 从第 1 页开始每页 list_blocks，直到找到这块：
    第 370 页的块要 370 次查询，一次按键多等约 290 ms。现在一次 JOIN 拿页码。
    """
    from book2text.api import routes_review

    project_id = project_with_ocr
    payload = client.get(
        f"/api/projects/{project_id}/pages/2/blocks", headers=auth_headers
    ).json()
    block_id = payload["blocks"][0]["block_id"]

    calls: list[object] = []
    original = routes_review.blocks_module.list_blocks

    def counting(*args, **kwargs):
        calls.append(kwargs.get("page_no"))
        return original(*args, **kwargs)

    monkeypatch.setattr(routes_review.blocks_module, "list_blocks", counting)
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block_id}",
        json={"review_status": "uncertain"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert calls == [], "块编辑不该逐页 list_blocks 找块"
def test_review_tree_lists_every_page_and_groups_by_chapter(
    client: TestClient,
    auth_headers: dict[str, str],
    project_with_ocr: str,
    monkeypatch,
) -> None:
    """任务 45：左树要**每一页**（含 0 处差异的页），回目从目录索引来。"""
    from book2text.core.project import review_status

    project_id = project_with_ocr
    monkeypatch.setattr(
        review_status.page_index_module,
        "build_page_index",
        lambda *args, **kwargs: {
            "chapters": [
                {"title": "第一回", "page_no": 1, "printed": []},
                {"title": "第二回", "page_no": 3, "printed": ["9"]},
            ]
        },
    )
    response = client.get(
        f"/api/projects/{project_id}/review/tree", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert [page["page_no"] for page in data["pages"]] == [1, 2, 3]
    assert data["chapters"][0]["page_to"] == 2
    assert data["chapters"][1]["page_to"] == 3
    assert data["chapters"][1]["printed_page"] == "9"
    assert data["pages"][0]["chapter"] == "c0"
    assert data["pages"][2]["chapter"] == "c1"
    # 夹具没跑第二引擎文本 → 每页 0 处差异，但页行必须都在
    assert all(page["unacked"] == 0 for page in data["pages"])
    assert data["stats"]["pages"] == 3

