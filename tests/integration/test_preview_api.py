"""结果预览（任务 38）：预览必须与导出共用同一份组装结果。

用户的话：预览和导出不一致，用户看什么都是白看。所以这里钉死三件事：

1. 预览返回的 segments 与导出写出的 `body.txt` **逐字一致**（同一套拼接规则）；
2. 某一页的预览文本，能在 `body.txt` 里原样找到；
3. 标了「延续」的块跨页合并成一个段，预览据此显示「跨页续」。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.storage import db as db_module
from book2text.core.storage.ulid import new_ulid


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "结果预览测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def add_block(
    library_dir: Path,
    project_id: str,
    *,
    page_no: int,
    text: str,
    continues_to_next: bool = False,
) -> str:
    block_id = new_ulid()
    bbox = [0.1, 0.1, 0.9, 0.3]
    now = "2026-01-01T00:00:00+00:00"
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        page = conn.execute(
            "SELECT page_id FROM page WHERE page_no = ?", (page_no,)
        ).fetchone()
        order = conn.execute(
            "SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM block WHERE page_id = ?",
            (page["page_id"],),
        ).fetchone()["next"]
        conn.execute(
            """
            INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,
                               ocr_text, text, review_status, include, continues_to_next,
                               revision, created_at, updated_at)
            VALUES (?, ?, 'ocr', ?, ?, 'paragraph', ?, ?, 'confirmed', 1, ?, 0, ?, ?)
            """,
            (
                block_id,
                page["page_id"],
                order,
                str(bbox).replace("'", '"'),
                text,
                text,
                1 if continues_to_next else 0,
                now,
                now,
            ),
        )
        conn.commit()
    return block_id


def preview(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/export/preview",
        json={"format": "txt"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def run_export(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/export",
        json={"format": "txt"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def export_dir(library_dir: Path, project_id: str, payload: dict) -> Path:
    record = payload["record"]
    directory = library_dir / project_id / record["file_paths"][0]
    if directory.is_dir():
        return directory
    return library_dir / project_id


def body_text(library_dir: Path, project_id: str, payload: dict) -> str:
    record = payload["record"]
    candidates = [
        library_dir / project_id / "exports" / record["export_id"] / "body.txt",
        library_dir / project_id / "exports" / (record.get("directory") or "") / "body.txt",
    ]
    for path in candidates:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    # 兜底：在项目导出目录里找最新的 body.txt
    found = sorted((library_dir / project_id / "exports").glob("*/body.txt"))
    assert found, "导出没有写出 body.txt"
    return found[-1].read_text(encoding="utf-8")


@pytest.fixture
def preview_project(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
) -> str:
    project_id = create_project(client, auth_headers, sample_pdf)
    # 第 1 页最后一块声明「延续」到第 2 页第一块（跨页段）
    add_block(library_dir, project_id, page_no=1, text="甲段上句，", continues_to_next=True)
    add_block(library_dir, project_id, page_no=2, text="甲段下句。")
    add_block(library_dir, project_id, page_no=2, text="乙段独立成段。")
    return project_id


def test_preview_matches_export_body_byte_for_byte(
    client: TestClient,
    auth_headers: dict[str, str],
    preview_project: str,
    library_dir: Path,
) -> None:
    data = preview(client, auth_headers, preview_project)
    segments = data["segments"]
    assert segments, "预览应当有段"
    # 与 txt 渲染同一规则：空段不出现、段间一个空行、结尾一个换行
    rendered = "\n\n".join(
        segment["text"] for segment in segments if segment["text"].strip()
    ) + "\n"
    exported = body_text(library_dir, preview_project, run_export(client, auth_headers, preview_project))
    assert rendered == exported

    # 某一页（第 1 页）的预览文本，与导出正文里对应内容逐字一致
    page1 = "\n\n".join(
        segment["text"]
        for segment in segments
        if any(page["page_no"] == 1 for page in segment["pages"])
    )
    assert page1
    assert page1 in exported


def test_cross_page_segment_is_merged_and_marked(
    client: TestClient,
    auth_headers: dict[str, str],
    preview_project: str,
) -> None:
    segments = preview(client, auth_headers, preview_project)["segments"]
    spans = [
        segment
        for segment in segments
        if [page["page_no"] for page in segment["pages"]] == [1, 2]
    ]
    assert len(spans) == 1, "标了延续的块应当合并成一个跨页段"
    assert "甲段上句，甲段下句。" in spans[0]["text"]
    # 预览据此显示「跨页续」：判据就是 pages 多于一个
    assert len(spans[0]["pages"]) > 1


def test_preview_reports_what_margin_excluded(
    client: TestClient,
    auth_headers: dict[str, str],
    preview_project: str,
) -> None:
    data = preview(client, auth_headers, preview_project)
    preflight = data["preflight"]
    blocks = preflight.get("margin_blocks") or {}
    assert "excluded" in blocks
    # 预览条上显示的就是这几个数：段数 / 字数 / 跨页 / 版心外排除
    assert data["segment_count"] == len(data["segments"])
    assert sum(len(segment["text"]) for segment in data["segments"]) == preflight["char_count"]
