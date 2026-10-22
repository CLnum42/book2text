"""分派与任务包（说明书 6.7.1 / 6.7.2 / 7.9.1）。

负责人侧：预览（哪些页能派、为什么跳过）、建分派、快照、`.b2tpkg`（package.json +
source/subset.pdf + data.json）、列表、作废、重新导出、下载。

助手侧的打开与结果包在 `test_package_project_api.py`，导入合并在 `test_merge_api.py`。
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.collab import assignments as assignments_module
from book2text.core.project import library as project_library
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "协作测试书", "filename": pdf.name},
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


def preview(client: TestClient, headers: dict[str, str], project_id: str, **body) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/assignments/preview", json=body, headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def create_assignment(
    client: TestClient, headers: dict[str, str], project_id: str, **body
) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/assignments", json=body, headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def assignment_list(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/assignments", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def recognized_project(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> str:
    """3 页的合成 PDF，第 1–2 页已识别。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1, 2)
    return project_id


# ---------------------------------------------------------------- 预览

def test_preview_excludes_unrecognized_pages(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    """说明书 7.9.1：未识别的页不能分派（助手端没有识别功能），要明确提示。"""
    data = preview(client, auth_headers, recognized_project, pages=[1, 2, 3])
    assert data["selected_pages"] == [1, 2]
    assert data["page_count"] == 2
    assert any("识别" in item["reason"] and item["page_no"] == "3" for item in data["skipped"])


def test_preview_excludes_excluded_pages(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    pages = client.get(
        f"/api/projects/{recognized_project}/pages", headers=auth_headers
    ).json()["pages"]
    client.patch(
        f"/api/projects/{recognized_project}/pages",
        json={"page_ids": [pages[0]["page_id"]], "page_type": "body_excluded"},
        headers=auth_headers,
    )
    data = preview(client, auth_headers, recognized_project, pages=[1, 2])
    assert data["selected_pages"] == [2]
    assert any("已排除" in item["reason"] for item in data["skipped"])


def test_preview_lists_context_pages_and_size(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    data = preview(client, auth_headers, recognized_project, pages=[2], with_context=True)
    assert data["selected_pages"] == [2]
    assert data["context_pages"] == [1, 3]
    assert data["estimated_bytes"] > 0

    without = preview(client, auth_headers, recognized_project, pages=[2], with_context=False)
    assert without["context_pages"] == []


def test_preview_excludes_pages_already_in_another_package(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    """说明书 6.7.1：同一页同一时间只能在一个未完成的任务包里。"""
    create_assignment(
        client, auth_headers, recognized_project, pages=[1], reviewer_name="张三"
    )
    data = preview(client, auth_headers, recognized_project, pages=[1, 2])
    assert data["selected_pages"] == [2], "第 1 页已经在张三的任务包里"
    assert any("已分派给 张三" in item["reason"] for item in data["skipped"])


# ---------------------------------------------------------------- 建分派与任务包

def test_create_assignment_writes_snapshot_and_package(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_project: str
) -> None:
    created = create_assignment(
        client,
        auth_headers,
        recognized_project,
        pages=[1, 2],
        reviewer_name="张三",
        note="注意人名统一",
        due_date="2025-03-08",
        with_context=False,
    )
    assignment = created["assignment"]
    assert assignment["status"] == "issued"
    assert assignment["status_label"] == "已发出"
    assert assignment["page_count"] == 2
    assert assignment["reviewer_name"] == "张三"
    assert assignment["due_date"] == "2025-03-08"

    directory = library_dir / recognized_project
    base = assignments_module.assignment_dir(directory, assignment["assignment_id"])
    package = base / created["package_name"]
    assert package.is_file(), "任务包要真的生成出来"
    assert assignments_module.snapshot_path(directory, assignment["assignment_id"]).is_file()

    # 任务包内容（说明书 6.7.2）：package.json + data.json + source/subset.pdf
    with zipfile.ZipFile(package) as archive:
        names = set(archive.namelist())
        assert names == {"package.json", "data.json", "source/subset.pdf"}
        manifest = json.loads(archive.read("package.json"))
        data = json.loads(archive.read("data.json"))

    assert manifest["schema"] == "book2text.package.v1"
    assert manifest["package_id"] == assignment["assignment_id"]
    assert manifest["project_id"] == recognized_project
    assert manifest["reviewer_name"] == "张三"
    assert manifest["note"] == "注意人名统一"
    assert manifest["page_count"] == 2
    assert manifest["context_page_count"] == 0
    assert manifest["source_sha256"] == project_library.load_project(
        recognized_project, library=library_dir
    ).source_sha256
    assert "ocr" in manifest["forbidden_operations"], "助手端不允许识别"
    assert "edit_text" in manifest["allowed_operations"]
    # 页序与 pdf_index 必须一一对应（子集 PDF 里的下标）
    assert [page["pdf_index"] for page in manifest["pages"]] == [0, 1]
    assert [page["page_no"] for page in manifest["pages"]] == [1, 2]

    # data.json 是快照：块带 revision 与全部状态
    assert data["schema"] == "book2text.package-data.v1"
    first_page = data["pages"][0]
    assert first_page["page_no"] == 1
    assert first_page["blocks"], "分派页要有块"
    assert all("revision" in block and "text" in block for block in first_page["blocks"])
    assert all(block["review_status"] == "unreviewed" for block in first_page["blocks"])

    # 子集 PDF 真的只有分派的那几页
    import pypdfium2 as pdfium

    subset_path = base / "subset-check.pdf"
    with zipfile.ZipFile(package) as archive:
        subset_path.write_bytes(archive.read("source/subset.pdf"))
    document = pdfium.PdfDocument(str(subset_path))
    assert len(document) == 2


def test_package_includes_context_pages(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_project: str
) -> None:
    """说明书 6.7.2：分派范围前后各 1 页作为**只读**上下文一并带上。"""
    created = create_assignment(
        client,
        auth_headers,
        recognized_project,
        pages=[2],
        reviewer_name="张三",
        with_context=True,
    )
    directory = library_dir / recognized_project
    snapshot = assignments_module.load_snapshot(
        directory, created["assignment"]["assignment_id"]
    )
    # 页序按阅读顺序（子集 PDF 就是这么抽的），上下文页只做标记
    assert [page["page_no"] for page in snapshot["pages"]] == [1, 2, 3]
    assert [page["is_context"] for page in snapshot["pages"]] == [True, False, True]
    assert created["assignment"]["context_page_ids"], "上下文页要记进分派记录"


def test_requires_a_reviewer_name(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    response = client.post(
        f"/api/projects/{recognized_project}/assignments",
        json={"pages": [1], "reviewer_name": "  "},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "请填写审校人" in response.json()["error"]["detail"]


def test_create_assignment_rejects_when_nothing_left(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    create_assignment(client, auth_headers, recognized_project, pages=[1], reviewer_name="张三")
    response = client.post(
        f"/api/projects/{recognized_project}/assignments",
        json={"pages": [1], "reviewer_name": "李四"},
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "没有可以分派的页面" in response.json()["error"]["detail"]


# ---------------------------------------------------------------- 列表 / 状态 / 页面标记

def test_list_assignments_shows_pages_and_status(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    create_assignment(
        client, auth_headers, recognized_project, pages=[1, 2], reviewer_name="张三",
        with_context=False,
    )
    data = assignment_list(client, auth_headers, recognized_project)
    assert data["count"] == 1
    assert data["known_reviewers"] == ["张三"]
    entry = data["assignments"][0]
    assert entry["page_nos"] == [1, 2]
    assert entry["status_label"] == "已发出"
    assert entry["package_exists"] is True
    assert entry["imported_seq"] == 0


def test_pages_in_a_package_are_marked_in_the_page_payload(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    """说明书 6.7.6：分派中的页面在页面视图显示"张三 · 审校中"。"""
    create_assignment(
        client, auth_headers, recognized_project, pages=[1], reviewer_name="张三",
        with_context=False,
    )
    pages = client.get(
        f"/api/projects/{recognized_project}/pages", headers=auth_headers
    ).json()["pages"]
    assert pages[0]["assignment"]["reviewer_name"] == "张三"
    assert pages[0]["assignment"]["status_label"] == "已发出"
    assert pages[1]["assignment"] is None


def test_cancel_assignment_frees_the_pages(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    """说明书 6.7.6：作废之后页面恢复为未分派。"""
    created = create_assignment(
        client, auth_headers, recognized_project, pages=[1], reviewer_name="张三",
        with_context=False,
    )
    assignment_id = created["assignment"]["assignment_id"]

    response = client.post(
        f"/api/projects/{recognized_project}/assignments/{assignment_id}/cancel",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["assignment"]["status"] == "cancelled"

    pages = client.get(
        f"/api/projects/{recognized_project}/pages", headers=auth_headers
    ).json()["pages"]
    assert pages[0]["assignment"] is None, "作废之后不再占用页面"

    again = preview(client, auth_headers, recognized_project, pages=[1])
    assert again["selected_pages"] == [1], "页面可以重新分派"

    # 重复作废要如实报错
    twice = client.post(
        f"/api/projects/{recognized_project}/assignments/{assignment_id}/cancel",
        headers=auth_headers,
    )
    assert twice.status_code == 400
    assert "已经作废" in twice.json()["error"]["detail"]


# ---------------------------------------------------------------- 下载与重新导出

def test_download_and_rebuild_package(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_project: str
) -> None:
    created = create_assignment(
        client, auth_headers, recognized_project, pages=[1], reviewer_name="张三",
        with_context=False,
    )
    assignment_id = created["assignment"]["assignment_id"]

    downloaded = client.get(
        f"/api/projects/{recognized_project}/assignments/{assignment_id}/package",
        headers=auth_headers,
    )
    assert downloaded.status_code == 200
    assert downloaded.headers["content-type"] == "application/zip"
    # 中文文件名按 RFC 5987 编码，解回来对比
    from urllib.parse import unquote

    assert created["package_name"] in unquote(downloaded.headers["content-disposition"])

    # 删掉文件之后：下载要如实报错，重新导出能修好
    directory = library_dir / recognized_project
    package = assignments_module.assignment_dir(directory, assignment_id) / created["package_name"]
    package.unlink()
    missing = client.get(
        f"/api/projects/{recognized_project}/assignments/{assignment_id}/package",
        headers=auth_headers,
    )
    assert missing.status_code == 404
    assert "重新导出" in missing.json()["error"]["detail"]

    rebuilt = client.post(
        f"/api/projects/{recognized_project}/assignments/{assignment_id}/rebuild",
        headers=auth_headers,
    )
    assert rebuilt.status_code == 200, rebuilt.text
    assert package.is_file()


def test_rebuild_uses_the_original_snapshot(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_project: str
) -> None:
    """重新导出要用**原来那份快照**：负责人后来改了正文也不该混进任务包。"""
    created = create_assignment(
        client, auth_headers, recognized_project, pages=[1], reviewer_name="张三",
        with_context=False,
    )
    assignment_id = created["assignment"]["assignment_id"]

    block = client.get(
        f"/api/projects/{recognized_project}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"][0]
    client.patch(
        f"/api/projects/{recognized_project}/blocks/{block['block_id']}",
        json={"text": "负责人后来改的", "expected_revision": block["revision"]},
        headers=auth_headers,
    )
    client.post(
        f"/api/projects/{recognized_project}/assignments/{assignment_id}/rebuild",
        headers=auth_headers,
    )
    directory = library_dir / recognized_project
    package = (
        assignments_module.assignment_dir(directory, assignment_id) / created["package_name"]
    )
    with zipfile.ZipFile(package) as archive:
        data = json.loads(archive.read("data.json"))
    texts = [block["text"] for block in data["pages"][0]["blocks"]]
    assert "负责人后来改的" not in texts, "任务包里是分派那一刻的快照"


def test_cancelled_package_cannot_be_rebuilt(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    created = create_assignment(
        client, auth_headers, recognized_project, pages=[1], reviewer_name="张三",
        with_context=False,
    )
    assignment_id = created["assignment"]["assignment_id"]
    client.post(
        f"/api/projects/{recognized_project}/assignments/{assignment_id}/cancel",
        headers=auth_headers,
    )
    response = client.post(
        f"/api/projects/{recognized_project}/assignments/{assignment_id}/rebuild",
        headers=auth_headers,
    )
    assert response.status_code == 400
    assert "已作废" in response.json()["error"]["detail"]
