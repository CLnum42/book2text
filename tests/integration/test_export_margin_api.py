"""按版心判定正文 + 注释可选（任务 51）的导出集成测试。

真实 PDF 的验收在任务报告里；这里用合成项目把两层判定、页码抽取、开关回退钉死。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine
from tests.integration.test_structure_tools_api import add_block


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "版心导出测试", "filename": pdf.name},
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


def export(client: TestClient, headers: dict[str, str], project_id: str, **options):
    return client.post(
        f"/api/projects/{project_id}/export",
        json={"format": "txt", **options},
        headers=headers,
    )


def preflight(client: TestClient, headers: dict[str, str], project_id: str, **options) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/export/preflight",
        json={"format": "txt", **options},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def set_margin(client: TestClient, headers: dict[str, str], project_id: str, box) -> None:
    response = client.put(
        f"/api/projects/{project_id}/margin-box",
        json={"margin_box": box},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def set_page_margin(
    client: TestClient,
    headers: dict[str, str],
    project_id: str,
    page_no: int,
    mode: str,
    box=None,
) -> None:
    payload = {"margin_box_mode": mode}
    if box is not None:
        payload["margin_box"] = box
    response = client.patch(
        f"/api/projects/{project_id}/pages/{page_no}/margin-box",
        json=payload,
        headers=headers,
    )
    assert response.status_code == 200, response.text


def set_judgement(client: TestClient, headers: dict[str, str], project_id: str, enabled: bool) -> None:
    response = client.patch(
        f"/api/projects/{project_id}/settings",
        json={"margin_box_judgement": enabled},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def set_page_label(library_dir: Path, project_id: str, page_no: int, label: str) -> None:
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        conn.execute("UPDATE page SET page_label = ? WHERE page_no = ?", (label, page_no))
        conn.commit()


def export_dir(library_dir: Path, project_id: str, response) -> Path:
    assert response.status_code == 200, response.text
    record = response.json()["record"]
    return library_dir / project_id / "exports" / record["export_id"]


def read_files(directory: Path, names: list[str]) -> dict[str, bytes]:
    return {
        name: (directory / name).read_bytes()
        for name in names
        if (directory / name).is_file()
    }


@pytest.fixture
def project_ready(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, [1, 2, 3])
    return project_id


def test_notes_files_are_off_by_default_and_opt_in(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    default = export(client, auth_headers, project_ready)
    assert default.status_code == 200, default.text
    record = default.json()["record"]
    assert record["file_paths"] == ["body.txt", "meta.json", "manifest.json"]
    directory = export_dir(library_dir, project_ready, default)
    assert not (directory / "notes.txt").exists()

    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["files"] == ["body.txt", "meta.json", "manifest.json"]
    assert manifest["stats"]["notes_count"] == 0, "没导出注释时 manifest 不报注释统计"

    opted = export(client, auth_headers, project_ready, format="both", include_notes=True)
    assert opted.status_code == 200, opted.text
    both_dir = export_dir(library_dir, project_ready, opted)
    assert (both_dir / "notes.txt").is_file()
    assert (both_dir / "notes.jsonl").is_file()
    assert "notes.jsonl" in opted.json()["record"]["file_paths"]


def test_two_layer_margin_judgement_and_page_numbers(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    project_ready: str,
) -> None:
    """版心外段落 / 页码不进正文；版心内脚注也不进正文（进注释流）；none 页整页按正文。"""
    add_block(
        library_dir, project_ready, page_no=1, text="书眉：红楼梦",
        bbox=[0.1, 0.02, 0.9, 0.05],
    )
    add_block(
        library_dir, project_ready, page_no=1, text="11",
        bbox=[0.45, 0.96, 0.55, 0.98],
    )
    add_block(
        library_dir, project_ready, page_no=1, text="① 注文：卢那察尔斯基",
        bbox=[0.1, 0.5, 0.9, 0.55], block_type="footnote",
    )
    add_block(
        library_dir, project_ready, page_no=1, text="图 1 手势",
        bbox=[0.2, 0.6, 0.8, 0.7], block_type="figure",
    )
    # 页级 none：整页插图 / 特殊版式；版心外也按块类型留在正文
    add_block(
        library_dir, project_ready, page_no=3, text="整页插图页也要保留",
        bbox=[0.1, 0.02, 0.9, 0.05],
    )
    set_page_margin(client, auth_headers, project_ready, 3, "none")
    # 任务 33：auto 页读本页落库的框，不继承项目默认框；这里给 1、2 页各设一个框。
    set_page_margin(client, auth_headers, project_ready, 1, "custom", [0.05, 0.1, 0.95, 0.9])
    set_page_margin(client, auth_headers, project_ready, 2, "custom", [0.05, 0.1, 0.95, 0.9])
    set_margin(client, auth_headers, project_ready, [0.05, 0.1, 0.95, 0.9])

    # 基线：开关关掉（默认）——书眉与页码都是 paragraph，会被当作正文
    set_judgement(client, auth_headers, project_ready, False)
    baseline = export(
        client, auth_headers, project_ready, format="both", include_notes=True
    )
    baseline_dir = export_dir(library_dir, project_ready, baseline)
    baseline_files = read_files(
        baseline_dir, ["body.txt", "meta.json", "notes.txt", "notes.jsonl"]
    )
    assert "书眉：红楼梦" in baseline_files["body.txt"].decode("utf-8")
    assert "11" in baseline_files["body.txt"].decode("utf-8")

    # 打开按版心判定
    set_judgement(client, auth_headers, project_ready, True)
    result = preflight(client, auth_headers, project_ready)
    assert result["margin_judgement"] is True
    assert result["margin_blocks"]["outside"] >= 2
    assert result["margin_notes"] == {"total": 1, "inside": 1, "outside": 0}
    assert result["margin_page_numbers"]["pages"] == 1
    assert result["margin_pages"]["applied"] == 2
    assert result["margin_pages"]["none"] == [3]
    assert result["chrome_suspect_count"] == 0, "按版心判定时不再提示块类型嫌疑"

    without_notes = export(client, auth_headers, project_ready, format="both")
    plain_dir = export_dir(library_dir, project_ready, without_notes)
    body = (plain_dir / "body.txt").read_text(encoding="utf-8")
    meta = json.loads((plain_dir / "meta.json").read_text(encoding="utf-8"))
    page1 = next(item for item in meta["pages"] if item["pdf_page"] == 1)
    page3 = next(item for item in meta["pages"] if item["pdf_page"] == 3)

    assert "书眉：红楼梦" not in body
    assert "① 注文" not in body, "脚注在版心内也不进正文（类型层）"
    assert "图 1 手势" not in body
    assert "整页插图页也要保留" in body, "页级 none 不做版心排除"
    assert "headers" not in page1, "书眉不进元数据，连字段都不写"
    assert "edge_texts" not in page1
    assert page1["printed_page"] == "11"
    assert page1["printed_page_source"] == "legacy"
    assert page1["margin_box"] == [0.05, 0.1, 0.95, 0.9]
    assert page1["block_counts"]["outside"] >= 2
    assert page1["block_counts"]["page_number"] == 1
    assert page3["margin_box_mode"] == "none"
    assert page3["margin_applied"] is False
    assert page3["block_counts"]["outside"] == 0
    assert not (plain_dir / "notes.txt").exists()

    # 勾选注释：脚注进 notes.*，正文不变
    with_notes = export(
        client, auth_headers, project_ready, format="both", include_notes=True
    )
    notes_dir = export_dir(library_dir, project_ready, with_notes)
    notes_txt = (notes_dir / "notes.txt").read_text(encoding="utf-8")
    notes_jsonl = (notes_dir / "notes.jsonl").read_text(encoding="utf-8")
    assert "① 注文：卢那察尔斯基" in notes_txt
    assert '"source_type":"footnote"' in notes_jsonl
    assert "① 注文" not in (notes_dir / "body.txt").read_text(encoding="utf-8")

    # 关掉开关：body / meta / notes 与基线逐字节一致（行为完全回到旧口径）
    set_judgement(client, auth_headers, project_ready, False)
    restored = export(
        client, auth_headers, project_ready, format="both", include_notes=True
    )
    restored_dir = export_dir(library_dir, project_ready, restored)
    restored_files = read_files(
        restored_dir, ["body.txt", "meta.json", "notes.txt", "notes.jsonl"]
    )
    assert restored_files == baseline_files, "开关关掉必须与改动前完全一致"


def test_mixed_header_uses_page_label_and_conflicts_become_null(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    project_ready: str,
) -> None:
    """书眉 + 页码粘连时按 PDF 印刷页码取数；多个不同值不猜（null）。"""
    set_page_label(library_dir, project_ready, 1, "11")
    add_block(
        library_dir, project_ready, page_no=1, text="2 谁是巴赫金? 11",
        bbox=[0.4, 0.02, 0.9, 0.05],
    )
    set_page_label(library_dir, project_ready, 2, "20")
    add_block(
        library_dir, project_ready, page_no=2, text="20", bbox=[0.45, 0.02, 0.55, 0.04]
    )
    add_block(
        library_dir, project_ready, page_no=2, text="21", bbox=[0.6, 0.02, 0.7, 0.04]
    )
    set_page_margin(client, auth_headers, project_ready, 1, "custom", [0.05, 0.1, 0.95, 0.9])
    set_page_margin(client, auth_headers, project_ready, 2, "custom", [0.05, 0.1, 0.95, 0.9])
    set_judgement(client, auth_headers, project_ready, True)

    record = export(client, auth_headers, project_ready, page_numbers=[1, 2]).json()["record"]
    directory = library_dir / project_ready / "exports" / record["export_id"]
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    by_page = {item["pdf_page"]: item for item in meta["pages"]}
    assert by_page[1]["printed_page"] == "11"
    assert "headers" not in by_page[1]
    assert by_page[2]["printed_page"] is None, "20 与 21 打架：不猜"
    assert [item["value"] for item in by_page[2]["printed_page_candidates"]] == ["20", "21"]

    body = (directory / "body.txt").read_text(encoding="utf-8")
    assert "2 谁是巴赫金? 11" not in body


def test_preflight_and_manifest_record_margin_exclusions(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    project_ready: str,
) -> None:
    """任务 34：预检与 manifest 报"版心外被排除的块数 + 类型分布"；关掉开关则不写。"""
    # 第 1 页只保留顶部一条版心：其余块都被版心排除
    set_page_margin(client, auth_headers, project_ready, 1, "custom", [0.0, 0.09, 1.0, 0.18])

    pre = preflight(client, auth_headers, project_ready)
    assert pre["margin_judgement"] is True
    excluded = pre["margin_blocks"]["excluded"]
    assert excluded > 0
    assert excluded == pre["margin_blocks"]["outside"]
    assert pre["margin_blocks"]["excluded_by_type"], "要按块类型给出分布"

    record = export(client, auth_headers, project_ready, format="both").json()["record"]
    directory = library_dir / project_ready / "exports" / record["export_id"]
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["margin"]["excluded_blocks"] == excluded, (
        manifest["margin"], pre["margin_blocks"]
    )
    assert manifest["margin"]["excluded_by_type"] == pre["margin_blocks"]["excluded_by_type"]
    assert manifest["margin"]["inside_blocks"] == pre["margin_blocks"]["judged_inside"]

    # 显式关掉：manifest 不写 margin 段（与升级前一致）
    response = client.patch(
        f"/api/projects/{project_ready}/settings",
        json={"margin_box_judgement": False},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    off = export(client, auth_headers, project_ready, format="both").json()["record"]
    off_dir = library_dir / project_ready / "exports" / off["export_id"]
    off_manifest = json.loads((off_dir / "manifest.json").read_text(encoding="utf-8"))
    assert "margin" not in off_manifest
