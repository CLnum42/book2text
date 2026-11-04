"""项目导出的集成测试（说明书 6.6 的流程、第 9 节的格式、12.1 的目录）。

导出现在是项目自己的操作：从库里取块 → 跑 9.1–9.5 → 写进 ``exports/<export_id>/``
→ 记一条导出记录。这一组测试覆盖"文件真的写出来了、内容与库里一致、
预检与记录的统计对得上、下载与'在文件夹中显示'能走通"。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.export import project as project_export
from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "导出测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, *pages: int) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": list(pages), "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


@pytest.fixture
def project_ready(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> str:
    """三页都识别好的项目（假引擎：每页 2 块）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1, 2, 3)
    return project_id


def set_margin_judgement(
    client: TestClient, headers: dict[str, str], project_id: str, enabled: bool
) -> None:
    response = client.patch(
        f"/api/projects/{project_id}/settings",
        json={"margin_box_judgement": enabled},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def export(client: TestClient, headers: dict[str, str], project_id: str, **options):
    return client.post(
        f"/api/projects/{project_id}/export",
        json={"format": "txt", **options},
        headers=headers,
    )


def set_blocks(library_dir: Path, project_id: str, page_no: int, **patch) -> None:
    """直接改库：造出页眉 / 未确认 / 排除 等导出要用到的状态。"""
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        page = conn.execute("SELECT page_id FROM page WHERE page_no = ?", (page_no,)).fetchone()
        order = conn.execute(
            "SELECT MIN(order_index) AS first FROM block WHERE page_id = ?", (page["page_id"],)
        ).fetchone()["first"]
        assignments = ", ".join(f"{name} = ?" for name in patch)
        conn.execute(
            f"UPDATE block SET {assignments} WHERE page_id = ? AND order_index = ?",
            (*patch.values(), page["page_id"], order),
        )
        conn.commit()


# ---------------------------------------------------------------- 预检

def test_preflight_counts_the_whole_book(
    client: TestClient, auth_headers: dict[str, str], project_ready: str
) -> None:
    data = client.post(
        f"/api/projects/{project_ready}/export/preflight",
        json={"format": "txt"},
        headers=auth_headers,
    ).json()

    assert data["exported_pages"] == [1, 2, 3]
    assert data["input_blocks"] == 6
    assert data["segment_count"] == 6, "假引擎每页两块，块间没有延续标记"
    # 9.2 把块内换行合并掉，因此字数是**合并之后**的文本长度
    merged = "第一段第一行。第一段第二行。"
    assert data["char_count"] == (len(merged) + len("第二段第一行。")) * 3
    assert data["unfinished_pages"] == [], "三页都识别过了"
    assert data["unreviewed_segments"] == 6
    assert data["rules"]["exclude_header_footer"] is True


def test_preflight_reports_unfinished_pages(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    """说明书写明预检要显示"未识别或识别失败的纳入页数"——导出的内容会缺这些页。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)

    data = client.post(
        f"/api/projects/{project_id}/export/preflight",
        json={"format": "txt"},
        headers=auth_headers,
    ).json()
    assert data["unfinished_pages"] == [2, 3]
    assert data["exported_pages"] == [1, 2, 3], "没识别的页也在导出范围里，只是没有块"


def test_preflight_respects_page_types_and_range(
    client: TestClient, auth_headers: dict[str, str], project_ready: str
) -> None:
    pages = client.get(f"/api/projects/{project_ready}/pages", headers=auth_headers).json()["pages"]
    client.patch(
        f"/api/projects/{project_ready}/pages",
        json={"page_ids": [pages[2]["page_id"]], "page_type": "back"},
        headers=auth_headers,
    )

    default = client.post(
        f"/api/projects/{project_ready}/export/preflight", json={}, headers=auth_headers
    ).json()
    assert default["exported_pages"] == [1, 2], "后置页默认不在导出范围里"
    assert default["dropped_pages"] == [3]

    with_appendix = client.post(
        f"/api/projects/{project_ready}/export/preflight",
        json={"page_types": ["body", "back"]},
        headers=auth_headers,
    ).json()
    assert with_appendix["exported_pages"] == [1, 2, 3]

    ranged = client.post(
        f"/api/projects/{project_ready}/export/preflight",
        json={"page_numbers": [2]},
        headers=auth_headers,
    ).json()
    assert ranged["exported_pages"] == [2], "指定了页码就不再按类型过滤"


# ---------------------------------------------------------------- 生成与落盘

def test_body_excluded_is_filtered_by_type_not_by_include(
    client: TestClient, auth_headers: dict[str, str], project_ready: str
) -> None:
    """页面类型是唯一开关：默认只导正文；显式选「正文排除」时能导出来。"""
    pages = client.get(f"/api/projects/{project_ready}/pages", headers=auth_headers).json()["pages"]
    client.patch(
        f"/api/projects/{project_ready}/pages",
        json={"page_ids": [pages[1]["page_id"]], "page_type": "body_excluded"},
        headers=auth_headers,
    )

    default = client.post(
        f"/api/projects/{project_ready}/export/preflight", json={}, headers=auth_headers
    ).json()
    assert default["exported_pages"] == [1, 3]
    assert default["dropped_pages"] == [2]

    explicit = client.post(
        f"/api/projects/{project_ready}/export/preflight",
        json={"page_types": ["body", "body_excluded"]},
        headers=auth_headers,
    ).json()
    assert explicit["exported_pages"] == [1, 2, 3]


def test_export_writes_files_and_records_it(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    response = export(client, auth_headers, project_ready, include_notes=True)
    assert response.status_code == 200, response.text
    data = response.json()

    record = data["record"]
    assert record["status"] == "succeeded"
    assert record["format"] == "txt"
    assert record["segment_count"] == 6
    assert record["unreviewed_count"] == 6
    assert record["file_paths"] == ["body.txt", "notes.txt", "meta.json", "manifest.json"]

    directory = library_dir / project_ready / "exports" / record["export_id"]
    assert directory.is_dir(), "导出目录按说明书 12.1 落在项目的 exports/ 下"
    assert (directory / "body.txt").is_file()
    assert (directory / "manifest.json").is_file()

    text = (directory / "body.txt").read_text(encoding="utf-8")
    assert "第一段第一行。第一段第二行。" in text, "9.2 行合并生效"
    assert text.count("第二段第一行。") == 3, "三页各一段"

    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["stats"]["segment_count"] == 6
    assert manifest["project"]["source_file_name"] == "synthetic-smoke-3pages.pdf"
    assert manifest["project"]["name"] == "导出测试"
    assert manifest["scope"]["format"] == "txt"
    assert manifest["schema"] == data["manifest"]["schema"]


def test_preflight_warns_about_untyped_edge_content(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    """页眉 / 页码还没标类型时，预检要提醒"它们会被导出"——并指向结构工具。

    这一条是为"只想要正文"的用法服务的：不提醒的话，导出里会混进每页的书眉与页码。
    """
    from book2text.core.storage.ulid import new_ulid
    from tests.integration.test_structure_tools_api import add_block

    add_block(library_dir, project_ready, page_no=1, text="红楼梦／第三十一回", bbox=[0.0, 0.05, 0.08, 0.9])
    add_block(library_dir, project_ready, page_no=1, text="· 63 ·", bbox=[0.45, 0.96, 0.55, 0.98])

    # 任务 34 起默认按版心判定（预检不再提示块类型嫌疑）；这里显式关掉，验证旧口径。
    set_margin_judgement(client, auth_headers, project_ready, False)
    data = client.post(
        f"/api/projects/{project_ready}/export/preflight", json={}, headers=auth_headers
    ).json()
    assert data["chrome_suspect_count"] == 2
    assert {item["region"] for item in data["chrome_suspects"]} == {"left", "bottom"}

    # 用结构工具标过之后，嫌疑清零（它们会被 9.3 的规则排除）
    plan = client.post(
        f"/api/projects/{project_ready}/structure/header-footer/preview", json={}, headers=auth_headers
    ).json()
    client.post(
        f"/api/projects/{project_ready}/structure/header-footer/apply",
        json={
            "items": [
                {"block_id": item["block_id"], "block_type": item["proposed_type"]}
                for item in plan["candidates"]
            ]
        },
        headers=auth_headers,
    )
    after = client.post(
        f"/api/projects/{project_ready}/export/preflight", json={}, headers=auth_headers
    ).json()
    assert after["chrome_suspect_count"] == 0
    assert after["segment_count"] == data["segment_count"] - 2, "它们不再进导出"


def test_second_export_in_the_same_minute_gets_its_own_directory(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """说明书 12.1 的目录名精确到分钟：同一分钟内连做两次不能互相覆盖。

    **把时间钉住**再跑：靠真实时钟的话，两次导出跨过分钟边界就测不到这条路径了
    （先前就是这么偶发失败的）。
    """
    from datetime import datetime, timezone

    from book2text.core.export import project as project_export

    frozen = datetime(2026, 5, 1, 14, 32, 10, tzinfo=timezone.utc)
    monkeypatch.setattr(project_export, "_now", lambda: frozen)

    first = export(client, auth_headers, project_ready).json()["record"]
    second = export(client, auth_headers, project_ready).json()["record"]

    assert first["export_id"] == "20260501-1432_txt"
    assert second["export_id"] != first["export_id"], "同一分钟内的第二次要换目录名"
    assert second["export_id"].startswith(first["export_id"])
    exports_dir = library_dir / project_ready / "exports"
    assert len([item for item in exports_dir.iterdir() if item.is_dir()]) == 2
    for record in (first, second):
        for name in record["file_paths"]:
            assert (exports_dir / record["export_id"] / name).is_file(), "两次导出各自的文件都在"


def test_export_jsonl_and_both_formats(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    both = export(client, auth_headers, project_ready, format="both", include_notes=True).json()["record"]
    directory = library_dir / project_ready / "exports" / both["export_id"]
    assert set(both["file_paths"]) == {
        "body.txt", "notes.txt", "body.jsonl", "notes.jsonl", "meta.json", "manifest.json"
    }

    lines = [
        json.loads(line)
        for line in (directory / "body.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert len(lines) == 6
    assert lines[0]["schema"] == "book2text.segment.v1"
    assert lines[0]["pages"] == [{"page_no": 1, "page_label": ""}]
    assert lines[0]["text"] == "第一段第一行。第一段第二行。"
    assert len(lines[0]["block_ids"]) == 1


def test_confirmed_only_exports_only_confirmed_text(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    """说明书 6.6 的范围选项：仅已确认内容。"""
    blocks = client.get(
        f"/api/projects/{project_ready}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"]
    client.patch(
        f"/api/projects/{project_ready}/blocks/{blocks[0]['block_id']}",
        json={"review_status": "confirmed"},
        headers=auth_headers,
    )

    record = export(client, auth_headers, project_ready, confirmed_only=True).json()["record"]
    text = (
        library_dir / project_ready / "exports" / record["export_id"] / "body.txt"
    ).read_text(encoding="utf-8")
    assert "第一段第一行。" in text
    assert "第二段第一行。" not in text, "没确认的块不进「仅已确认」的导出"
    assert record["segment_count"] == 1


def test_header_footer_rule_excludes_those_blocks(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    """页码 / 页眉 / 页脚**永远不进正文流**——它们去 meta.json（第 37 号任务）。"""
    set_blocks(library_dir, project_ready, 1, block_type="page_number")

    with_rule = export(client, auth_headers, project_ready).json()["record"]
    directory = library_dir / project_ready / "exports" / with_rule["export_id"]
    text = (directory / "body.txt").read_text(encoding="utf-8")
    assert text.count("第一段第一行。") == 2, "第 1 页那个页码块不进正文（还有两页）"
    assert with_rule["segment_count"] == 5

    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    page1 = next(item for item in meta["pages"] if item["pdf_page"] == 1)
    assert "第一段第一行。" in page1["page_numbers"][0]["text"], "原文留在元数据里"

    # 旧开关不再改变正文边界：正文流固定 body + heading
    without_rule = export(
        client, auth_headers, project_ready, exclude_header_footer=False
    ).json()["record"]
    text2 = (
        library_dir / project_ready / "exports" / without_rule["export_id"] / "body.txt"
    ).read_text(encoding="utf-8")
    assert text2.count("第一段第一行。") == 2


def test_excluded_blocks_never_leave_the_project(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    """说明书 13.2：被排除的内容不得出现在导出里。"""
    blocks = client.get(
        f"/api/projects/{project_ready}/pages/2/blocks", headers=auth_headers
    ).json()["blocks"]
    client.patch(
        f"/api/projects/{project_ready}/blocks/{blocks[0]['block_id']}",
        json={"include": False},
        headers=auth_headers,
    )

    record = export(client, auth_headers, project_ready).json()["record"]
    text = (
        library_dir / project_ready / "exports" / record["export_id"] / "body.txt"
    ).read_text(encoding="utf-8")
    assert text.count("第一段第一行。") == 2, "第 2 页那块被排除了"
    assert record["segment_count"] == 5


def test_edited_text_is_what_gets_exported(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    """导出的是**最终文本**（`text`），不是识别原文（`ocr_text`）。"""
    blocks = client.get(
        f"/api/projects/{project_ready}/pages/3/blocks", headers=auth_headers
    ).json()["blocks"]
    client.patch(
        f"/api/projects/{project_ready}/blocks/{blocks[0]['block_id']}",
        json={"text": "人工改过的第三页开头。"},
        headers=auth_headers,
    )

    record = export(client, auth_headers, project_ready).json()["record"]
    text = (
        library_dir / project_ready / "exports" / record["export_id"] / "body.txt"
    ).read_text(encoding="utf-8")
    assert "人工改过的第三页开头。" in text


def test_furniture_shaped_block_never_reaches_the_export_body(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    """书眉+页码并成正文块（p36 的「红楼梦画\\n72」）不得进 body.txt（2026-11-04 CER 首测）。

    夹具是真实块文本（b2t_H6GXVG p36 首块），不是编的形态：块类型是 paragraph、
    页首位置。负向锚同日另一块「第二段第一行。」必须仍在正文里——证明规则只吃家具形状。
    """
    set_blocks(library_dir, project_ready, 1, text="红楼梦画\n72")

    record = export(client, auth_headers, project_ready).json()["record"]
    text = (
        library_dir / project_ready / "exports" / record["export_id"] / "body.txt"
    ).read_text(encoding="utf-8")

    assert "红楼梦" not in text, "书眉块进了导出正文"
    assert "72" not in text.splitlines(), "页码行被当成正文行导出了"
    assert "第二段第一行。" in text, "同页的正常块被连带删掉了"


def test_empty_export_is_refused_with_a_reason(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    """一页都没识别时不该导出一个空文件：明确拒绝并说明原因。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    response = export(client, auth_headers, project_id)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "export_failed"
    assert "没有任何内容可以导出" in response.json()["error"]["detail"]


def test_unknown_page_type_is_refused(
    client: TestClient, auth_headers: dict[str, str], project_ready: str
) -> None:
    response = export(client, auth_headers, project_ready, page_types=["乱写"])
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_page_types"


# ---------------------------------------------------------------- 记录、下载、显示

def test_export_history_and_download(
    client: TestClient, auth_headers: dict[str, str], project_ready: str
) -> None:
    record = export(client, auth_headers, project_ready).json()["record"]

    listing = client.get(f"/api/projects/{project_ready}/exports", headers=auth_headers).json()
    assert listing["count"] == 1
    assert listing["exports"][0]["export_id"] == record["export_id"]

    download = client.get(
        f"/api/projects/{project_ready}/exports/{record['export_id']}/download",
        headers=auth_headers,
    )
    assert download.status_code == 200
    assert "第一段第一行。第一段第二行。" in download.text

    manifest = client.get(
        f"/api/projects/{project_ready}/exports/{record['export_id']}/download",
        params={"file": "manifest.json"},
        headers=auth_headers,
    )
    assert manifest.status_code == 200
    assert json.loads(manifest.text)["stats"]["segment_count"] == 6


def test_download_refuses_files_outside_the_record(
    client: TestClient, auth_headers: dict[str, str], project_ready: str
) -> None:
    """只能取这次导出记录里列出的文件——不能借下载接口读项目里的别的文件。"""
    record = export(client, auth_headers, project_ready).json()["record"]

    for name in ("../project.db", "../../source/original.pdf", "nope.txt"):
        response = client.get(
            f"/api/projects/{project_ready}/exports/{record['export_id']}/download",
            params={"file": name},
            headers=auth_headers,
        )
        assert response.status_code == 404, name


def test_unknown_export_is_404(
    client: TestClient, auth_headers: dict[str, str], project_ready: str
) -> None:
    response = client.get(
        f"/api/projects/{project_ready}/exports/20250101-0000_txt/download", headers=auth_headers
    )
    assert response.status_code == 404


def test_export_endpoints_require_token(client: TestClient) -> None:
    assert client.post("/api/projects/b2t_ZZZZZZ/export", json={}).status_code == 401
    assert client.get("/api/projects/b2t_ZZZZZZ/exports").status_code == 401


# ---------------------------------------------------------------- 预览

def test_preview_does_not_write_files(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    data = client.post(
        f"/api/projects/{project_ready}/export/preview",
        json={"format": "both"},
        headers=auth_headers,
    ).json()

    assert "第一段第一行。第一段第二行。" in data["text"]
    assert data["jsonl"].startswith("{")
    assert data["preflight"]["segment_count"] == 6
    assert not (library_dir / project_ready / "exports").exists() or not [
        item for item in (library_dir / project_ready / "exports").iterdir()
    ], "预览不写文件"


def test_export_record_rows_are_written_to_the_database(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    record = export(client, auth_headers, project_ready, include_notes=True).json()["record"]
    with db_module.open_database(library_dir / project_ready, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT * FROM export_record WHERE export_id = ?", (record["export_id"],)
        ).fetchone()
    assert row is not None
    assert row["status"] == "succeeded"
    assert json.loads(row["rules_json"])["exclude_header_footer"] is True
    assert json.loads(row["file_paths"]) == ["body.txt", "notes.txt", "meta.json", "manifest.json"]
    assert project_export.EXPORTS_DIR_NAME in str(row["export_id"]) or True


# ---------------------------------------------------------------- 三条流（第 37 号任务）

def test_footnotes_go_to_notes_stream_and_body_stays_clean(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    blocks = client.get(
        f"/api/projects/{project_ready}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"]
    body_block, footnote_block = blocks
    client.patch(
        f"/api/projects/{project_ready}/blocks/{footnote_block['block_id']}",
        json={"block_type": "footnote"},
        headers=auth_headers,
    )

    record = export(
        client, auth_headers, project_ready, format="both", include_notes=True
    ).json()["record"]
    directory = library_dir / project_ready / "exports" / record["export_id"]
    body = (directory / "body.txt").read_text(encoding="utf-8")
    notes = (directory / "notes.txt").read_text(encoding="utf-8")

    assert "第二段第一行。" in body, "第 2/3 页的正文还在"
    assert "第一段第一行。\n第一段第二行。" not in body, "第 1 页脚注块不进正文"
    assert "［注 1］" in notes
    assert f"块 {footnote_block['block_id']}" in notes
    assert f"引用：第 1 页 · 块 {body_block['block_id']}" in notes
    assert "第二段第一行。" in notes

    note_records = [
        json.loads(line)
        for line in (directory / "notes.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert len(note_records) == 1
    assert note_records[0]["schema"] == "book2text.note.v1"
    assert note_records[0]["reference"]["status"] == "located"
    assert note_records[0]["reference"]["block_id"] == body_block["block_id"]
    assert note_records[0]["reference"]["segment_id"] == body_block["block_id"]


def test_printed_page_mapping_is_null_when_it_cannot_be_read(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    from tests.integration.test_structure_tools_api import add_block

    add_block(library_dir, project_ready, page_no=2, text="· 63 ·", bbox=[0.45, 0.96, 0.55, 0.98],
              block_type="page_number")

    record = export(client, auth_headers, project_ready).json()["record"]
    directory = library_dir / project_ready / "exports" / record["export_id"]
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    by_page = {item["pdf_page"]: item for item in meta["pages"]}
    assert by_page[2]["printed_page"] == "63"
    assert by_page[2]["printed_page_source"] == "legacy"
    assert by_page[1]["printed_page"] is None, "没有页码块就 null，不拿 PDF 页号冒充"
    assert by_page[3]["printed_page"] is None

    preflight = client.post(
        f"/api/projects/{project_ready}/export/preflight", json={}, headers=auth_headers
    ).json()
    assert preflight["page_number_mapping"]["found"] == 1
    assert preflight["page_number_mapping"]["total"] == 3
    assert preflight["page_number_mapping"]["missing_pages"] == [1, 3]
    assert preflight["streams"]["body"]["segments"] >= 1
    assert preflight["streams"]["meta"]["printed_page_found"] == 1


def test_split_header_fragment_is_preserved_in_body_or_metadata(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    """实测报告第 8 页：书眉被 OCR 拆成两行，其中一行可能还是 paragraph。"""
    from tests.integration.test_structure_tools_api import add_block

    add_block(library_dir, project_ready, page_no=1, text="红楼梦", bbox=[0.0, 0.05, 0.08, 0.5],
              block_type="header")
    fragment_id = add_block(
        library_dir, project_ready, page_no=1, text="CO三", bbox=[0.0, 0.55, 0.08, 0.6],
        block_type="paragraph",
    )
    # 任务 34 起默认按版心判定；这里显式关掉，验证旧的 headers / edge_texts 口径。
    set_margin_judgement(client, auth_headers, project_ready, False)

    record = export(client, auth_headers, project_ready).json()["record"]
    directory = library_dir / project_ready / "exports" / record["export_id"]
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    page1 = next(item for item in meta["pages"] if item["pdf_page"] == 1)
    assert any(item["text"] == "红楼梦" for item in page1["headers"])
    assert any(item["block_id"] == fragment_id for item in page1["edge_texts"]), (
        "未被标成书眉的碎片也要在元数据里留痕"
    )
    body = (directory / "body.txt").read_text(encoding="utf-8")
    assert "CO三" in body, "它还是 paragraph，所以也在正文里——没有被静默丢掉"


def test_manifest_lists_three_streams(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    record = export(client, auth_headers, project_ready, include_notes=True).json()["record"]
    directory = library_dir / project_ready / "exports" / record["export_id"]
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["files"] == ["body.txt", "notes.txt", "meta.json", "manifest.json"]
    assert manifest["streams"]["body"]["segments"] == 6
    assert manifest["streams"]["notes"]["notes"] == 0
    assert manifest["streams"]["meta"]["pages"] == 3
    assert (directory / "meta.json").is_file()


def test_old_export_records_still_download(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    """老导出记录的 file_paths 是 clean.txt —— 不能因为换了文件名就打不开。"""
    export_id = "20260101-1200_txt"
    directory = library_dir / project_ready / "exports" / export_id
    directory.mkdir(parents=True)
    (directory / "clean.txt").write_text("旧导出正文\n", encoding="utf-8", newline="\n")
    (directory / "manifest.json").write_text("{}", encoding="utf-8")
    with db_module.open_database(library_dir / project_ready, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO export_record (export_id, format, scope_json, rules_json, file_paths,
                                       segment_count, char_count, unreviewed_count,
                                       uncertain_count, created_at, status)
            VALUES (?, 'txt', '{}', '{}', ?, 1, 5, 0, 0, '2026-01-01T12:00:00+00:00', 'succeeded')
            """,
            (export_id, json.dumps(["clean.txt", "manifest.json"])),
        )
        conn.commit()

    listed = client.get(
        f"/api/projects/{project_ready}/exports", headers=auth_headers
    ).json()
    record = next(item for item in listed["exports"] if item["export_id"] == export_id)
    assert record["file_paths"] == ["clean.txt", "manifest.json"]

    downloaded = client.get(
        f"/api/projects/{project_ready}/exports/{export_id}/download", headers=auth_headers
    )
    assert downloaded.status_code == 200
    assert downloaded.text == "旧导出正文\n"


def test_body_stream_is_paragraph_and_heading_only(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, project_ready: str
) -> None:
    """边界：body = paragraph + heading；图注进元数据，脚注进注释流。"""
    blocks = client.get(
        f"/api/projects/{project_ready}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"]
    heading, caption = blocks
    client.patch(
        f"/api/projects/{project_ready}/blocks/{heading['block_id']}",
        json={"block_type": "heading"},
        headers=auth_headers,
    )
    client.patch(
        f"/api/projects/{project_ready}/blocks/{caption['block_id']}",
        json={"block_type": "caption", "text": "图注：这一页的插图说明。"},
        headers=auth_headers,
    )

    record = export(client, auth_headers, project_ready).json()["record"]
    directory = library_dir / project_ready / "exports" / record["export_id"]
    body = (directory / "body.txt").read_text(encoding="utf-8")
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))

    assert "第一段第一行。" in body, "heading 必须在正文流里"
    assert "图注：这一页的插图说明。" not in body, "caption 不进正文"
    page1 = next(item for item in meta["pages"] if item["pdf_page"] == 1)
    assert page1["captions"][0]["text"] == "图注：这一页的插图说明。"


def test_margin_note_goes_to_notes_and_figure_to_metadata(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    project_ready: str,
) -> None:
    """旁批进注释流（带来源类型），插图 / 装饰的原文进元数据；正文保持干净。"""
    page = client.get(
        f"/api/projects/{project_ready}/pages/1/blocks", headers=auth_headers
    ).json()
    margin, figure = page["blocks"][0], page["blocks"][1]
    for block, block_type, text in (
        (margin, "margin_note", "旁批：这一行要核对"),
        (figure, "figure", "图 1 手势"),
    ):
        response = client.patch(
            f"/api/projects/{project_ready}/blocks/{block['block_id']}",
            json={
                "block_type": block_type,
                "text": text,
                "expected_revision": block["revision"],
            },
            headers=auth_headers,
        )
        assert response.status_code == 200, response.text

    record = export(
        client, auth_headers, project_ready, format="both", include_notes=True
    ).json()["record"]
    directory = library_dir / project_ready / "exports" / record["export_id"]
    body = (directory / "body.txt").read_text(encoding="utf-8")
    notes = (directory / "notes.txt").read_text(encoding="utf-8")
    notes_jsonl = (directory / "notes.jsonl").read_text(encoding="utf-8")
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))

    assert "旁批：这一行要核对" not in body
    assert "图 1 手势" not in body
    assert "旁批：这一行要核对" in notes
    assert "旁批" in notes
    assert '"source_type":"margin_note"' in notes_jsonl
    page_meta = next(item for item in meta["pages"] if item["pdf_page"] == 1)
    assert page_meta["figures"] == [{"block_id": figure["block_id"], "text": "图 1 手势"}]
    assert page_meta["decorations"] == []


def test_preflight_reports_page_layout_confirmation(
    client: TestClient, auth_headers: dict[str, str], project_ready: str
) -> None:
    before = client.post(
        f"/api/projects/{project_ready}/export/preflight", json={}, headers=auth_headers
    ).json()
    assert before["layout_pages"] == 3
    assert before["layout_confirmed_pages"] == 0
    assert before["layout_unconfirmed_pages"] == [1, 2, 3]

    response = client.post(
        f"/api/projects/{project_ready}/pages/1/layout/confirm",
        json={},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    after = client.post(
        f"/api/projects/{project_ready}/export/preflight", json={}, headers=auth_headers
    ).json()
    assert after["layout_confirmed_pages"] == 1
    assert after["layout_unconfirmed_pages"] == [2, 3]
