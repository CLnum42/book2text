"""项目接口的集成测试（说明书 Phase 1 的验收标准）。

Phase 1 验收：**创建项目、关闭、重启后状态完整；原始 PDF 未被修改；
项目文件夹跨平台拷贝后可以打开。** 这三条都有对应测试。
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.api.app import create_app
from book2text.core.project import library as project_library
from tests.conftest import TEST_ORIGIN, TEST_TOKEN


def create(client: TestClient, headers: dict[str, str], pdf: Path, *, name: str = "测试书"):
    return client.post(
        "/api/projects",
        params={"name": name, "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )


def restart(library_dir: Path) -> TestClient:
    """模拟"关掉应用再打开"：全新装配一个应用，指向同一个项目库。"""
    return TestClient(
        create_app(session_token=TEST_TOKEN, origins=[TEST_ORIGIN], library_dir=library_dir)
    )


# ---------------------------------------------------------------- 创建

def test_create_project_requires_token(client: TestClient, sample_pdf: Path) -> None:
    response = client.post(
        "/api/projects", params={"filename": sample_pdf.name}, content=sample_pdf.read_bytes()
    )
    assert response.status_code == 401


def test_create_project(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    response = create(client, auth_headers, sample_pdf, name="我的第一本书")
    assert response.status_code == 200, response.text
    data = response.json()

    project = data["project"]
    assert project["project_id"].startswith("b2t_")
    assert len(project["project_id"]) == len("b2t_") + 6
    assert project["name"] == "我的第一本书"
    assert project["source_file_name"] == sample_pdf.name
    assert project["page_count"] == 3
    assert project["schema_version"] >= 1
    assert project["source_sha256"] == hashlib.sha256(sample_pdf.read_bytes()).hexdigest()


def test_create_project_rejects_non_pdf(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path
) -> None:
    response = client.post(
        "/api/projects",
        params={"filename": "fake.pdf"},
        content=b"definitely not a pdf",
        headers={**auth_headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 400
    # 失败时不留半个项目目录
    assert list(library_dir.glob("b2t_*")) == []


def test_create_project_builds_the_spec_directory_layout(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    """说明书 12.1 的项目数据目录。"""
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    directory = library_dir / project_id

    assert (directory / "project.db").is_file()
    assert (directory / "source" / "original.pdf").is_file()
    for name in ("ocr_runs", "exports", "backups", "logs"):
        assert (directory / name).is_dir(), name
    for name in ("thumbs", "view", "ocr", "lines"):
        assert (directory / "cache" / name).is_dir(), name


def test_default_name_falls_back_to_the_file_name(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    data = create(client, auth_headers, sample_pdf, name="   ").json()
    assert data["project"]["name"] == sample_pdf.stem


# ---------------------------------------------------------------- 重启后状态完整

def test_project_survives_a_restart(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    """Phase 1 验收：创建项目、关闭、重启后状态完整。"""
    created = create(client, auth_headers, sample_pdf, name="重启测试").json()["project"]
    project_id = created["project_id"]
    before_pages = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()["pages"]

    fresh = restart(library_dir)
    listing = fresh.get("/api/projects", headers=auth_headers).json()

    assert listing["count"] == 1
    entry = listing["projects"][0]
    assert entry["project_id"] == project_id
    assert entry["name"] == "重启测试"
    assert entry["page_count"] == 3

    after = fresh.get(f"/api/projects/{project_id}", headers=auth_headers).json()["pages"]
    assert after == before_pages, "重启后页记录必须一致"


def test_page_records_keep_geometry_and_rotation(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path
) -> None:
    project_id = create(client, auth_headers, rotated_pdf).json()["project"]["project_id"]
    page = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()["pages"][0]

    assert page["page_no"] == 1
    assert page["rotation"] == 90
    # 显示尺寸：/Rotate=90 时宽高已交换（说明书 5.2 的坐标基准）
    assert page["width_pt"] > page["height_pt"]
    assert page["page_type"] == "body"
    assert page["include"] is True


# ---------------------------------------------------------------- 原始 PDF 未被修改

def test_source_pdf_is_not_modified(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    """Phase 1 验收：原始 PDF 未被修改（说明书 5.1）。"""
    before_hash = hashlib.sha256(sample_pdf.read_bytes()).hexdigest()
    before_mtime = sample_pdf.stat().st_mtime

    create(client, auth_headers, sample_pdf)

    assert hashlib.sha256(sample_pdf.read_bytes()).hexdigest() == before_hash
    assert sample_pdf.stat().st_mtime == before_mtime


def test_copied_pdf_in_project_is_a_separate_file(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    copied = library_dir / project_id / "source" / "original.pdf"

    assert copied.read_bytes() == sample_pdf.read_bytes()
    assert copied.resolve() != sample_pdf.resolve(), "项目里必须是副本，不是链接"


# ---------------------------------------------------------------- 跨平台拷贝

def test_project_folder_can_be_copied_to_another_library(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path, tmp_path: Path
) -> None:
    """Phase 1 验收：项目文件夹跨平台拷贝后可以打开。

    这里模拟"拷到另一台电脑"：整个项目文件夹复制到另一个项目库目录，
    用新装配的应用去读它。
    """
    project_id = create(client, auth_headers, sample_pdf, name="拷来拷去").json()["project"]["project_id"]

    other_library = tmp_path / "AnotherComputer" / "Book2Text"
    other_library.mkdir(parents=True)
    shutil.copytree(library_dir / project_id, other_library / project_id)

    other_client = restart(other_library)
    listing = other_client.get("/api/projects", headers=auth_headers).json()
    assert listing["count"] == 1
    assert listing["projects"][0]["name"] == "拷来拷去"

    opened = other_client.post(f"/api/projects/{project_id}/open", headers=auth_headers)
    assert opened.status_code == 200, opened.text


# ---------------------------------------------------------------- 打开与关闭

def test_open_creates_a_backup_and_a_lock(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    directory = library_dir / project_id

    data = client.post(f"/api/projects/{project_id}/open", headers=auth_headers).json()

    assert data["read_only"] is False
    assert data["lock"] is not None
    assert Path(data["backup_path"]).is_file()
    assert (directory / "backups").glob("project-*.db")
    assert (directory / ".lock").is_file()


def test_reopening_in_the_same_process_is_allowed(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    """同一个应用进程里再开一次不算冲突（另一个标签页看到的还是"我开着它"）。"""
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    client.post(f"/api/projects/{project_id}/open", headers=auth_headers)

    again = client.post(f"/api/projects/{project_id}/open", headers=auth_headers)
    assert again.status_code == 200, again.text


def test_open_is_refused_when_another_instance_holds_the_lock(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    """锁在**别人**手里（另一台电脑或另一个应用实例）时要拒绝并说明原因。"""
    import json

    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    (library_dir / project_id / ".lock").write_text(
        json.dumps(
            {
                "hostname": "another-mac",
                "pid": 12345,
                "acquired_at": "2026-01-01T00:00:00+00:00",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    refused = client.post(f"/api/projects/{project_id}/open", headers=auth_headers)
    assert refused.status_code == 400
    assert "另一台电脑" in refused.json()["error"]["detail"]


def test_read_only_open_works_while_locked(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    client.post(f"/api/projects/{project_id}/open", headers=auth_headers)

    read_only = client.post(
        f"/api/projects/{project_id}/open", params={"read_only": True}, headers=auth_headers
    )
    assert read_only.status_code == 200
    assert read_only.json()["read_only"] is True
    assert read_only.json()["warning"]


def test_force_open_reports_the_risk(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    client.post(f"/api/projects/{project_id}/open", headers=auth_headers)

    forced = client.post(
        f"/api/projects/{project_id}/open", params={"force": True}, headers=auth_headers
    )
    assert forced.status_code == 200
    assert "强制打开" in forced.json()["warning"]


def test_close_releases_the_lock(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    client.post(f"/api/projects/{project_id}/open", headers=auth_headers)

    closed = client.post(f"/api/projects/{project_id}/close", headers=auth_headers)
    assert closed.status_code == 200
    assert closed.json()["lock_released"] is True
    assert not (library_dir / project_id / ".lock").exists()

    # 释放后可以再次正常打开
    assert client.post(f"/api/projects/{project_id}/open", headers=auth_headers).status_code == 200


def test_listing_shows_when_a_project_is_locked_by_another_instance(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    """说明书 7.2：项目库里要能看出项目是否正被**别人**占用。"""
    import json

    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    (library_dir / project_id / ".lock").write_text(
        json.dumps(
            {"hostname": "another-mac", "pid": 12345, "acquired_at": "2026-01-01T00:00:00+00:00"},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    entry = client.get("/api/projects", headers=auth_headers).json()["projects"][0]
    assert entry["lock_held"] is True
    assert "另一台电脑" in entry["lock_reason"]


def test_own_lock_does_not_mark_the_project_as_busy(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    """自己开着的项目在项目卡上不该显示成"使用中"。"""
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    client.post(f"/api/projects/{project_id}/open", headers=auth_headers)

    entry = client.get("/api/projects", headers=auth_headers).json()["projects"][0]
    assert entry["lock_held"] is False
    assert entry["lock_reason"] == ""


# ---------------------------------------------------------------- 页面操作

def test_patch_page(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]

    updated = client.patch(
        f"/api/projects/{project_id}/pages/{pages[0]['page_id']}",
        json={"page_type": "cover", "include": False, "note": "封面不参与识别"},
        headers=auth_headers,
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["page_type"] == "cover"
    assert body["include"] is False
    assert body["note"] == "封面不参与识别"


def test_patch_page_persists(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    client.patch(
        f"/api/projects/{project_id}/pages/{pages[0]['page_id']}",
        json={"include": False},
        headers=auth_headers,
    )

    fresh = restart(library_dir)
    after = fresh.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    assert after[0]["include"] is False

    listing = fresh.get("/api/projects", headers=auth_headers).json()["projects"][0]
    assert listing["included_pages"] == 2


def test_patch_page_rejects_unknown_type(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    response = client.patch(
        f"/api/projects/{project_id}/pages/{pages[0]['page_id']}",
        json={"page_type": "不存在的类型"},
        headers=auth_headers,
    )
    assert response.status_code == 404
    assert "未知的页面类型" in response.json()["error"]["detail"]


def test_batch_patch_pages_sets_type_and_include(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    """说明书 6.2 的批量操作、第 11 节的 PATCH /projects/{id}/pages。"""
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]

    response = client.patch(
        f"/api/projects/{project_id}/pages",
        json={
            "page_ids": [pages[0]["page_id"], pages[1]["page_id"]],
            "page_type": "cover",
            "include": False,
        },
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["updated"] == 2
    assert [page["page_type"] for page in data["pages"]] == ["cover", "cover"]
    assert all(page["include"] is False for page in data["pages"])

    fresh = restart(library_dir)
    after = fresh.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    assert [page["page_type"] for page in after] == ["cover", "cover", "body"]
    assert [page["include"] for page in after] == [False, False, True]


def test_batch_patch_pages_is_all_or_nothing(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    """批次里有一个页面 id 不存在就整批拒绝——界面上不该出现"改了一半"。"""
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]

    response = client.patch(
        f"/api/projects/{project_id}/pages",
        json={"page_ids": [pages[0]["page_id"], "nope"], "include": False},
        headers=auth_headers,
    )
    assert response.status_code == 404
    assert "找不到这些页面" in response.json()["error"]["detail"]

    after = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    assert all(page["include"] is True for page in after), "整批都没改"


def test_batch_patch_pages_rejects_unknown_type(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]

    response = client.patch(
        f"/api/projects/{project_id}/pages",
        json={"page_ids": [pages[0]["page_id"]], "page_type": "不存在"},
        headers=auth_headers,
    )
    assert response.status_code == 404
    assert "未知的页面类型" in response.json()["error"]["detail"]


def test_batch_patch_pages_requires_something_to_do(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]

    empty_ids = client.patch(
        f"/api/projects/{project_id}/pages",
        json={"page_ids": [], "include": False},
        headers=auth_headers,
    )
    assert empty_ids.status_code == 404

    no_fields = client.patch(
        f"/api/projects/{project_id}/pages",
        json={"page_ids": [pages[0]["page_id"]]},
        headers=auth_headers,
    )
    assert no_fields.status_code == 404
    assert "没有要更新的字段" in no_fields.json()["error"]["detail"]


def test_unknown_page_returns_404(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    response = client.patch(
        f"/api/projects/{project_id}/pages/nope",
        json={"include": False},
        headers=auth_headers,
    )
    assert response.status_code == 404


def test_save_position(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    """说明书 7.2：记录上次位置，重启后"继续"回到那里。"""
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]

    saved = client.put(
        f"/api/projects/{project_id}/position",
        json={"view": "review", "page_id": pages[1]["page_id"]},
        headers=auth_headers,
    )
    assert saved.status_code == 200

    fresh = restart(library_dir)
    project = fresh.get(f"/api/projects/{project_id}", headers=auth_headers).json()["project"]
    assert project["last_view"] == "review"
    assert project["last_page_id"] == pages[1]["page_id"]


def test_page_image_endpoint(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]

    thumb = client.get(
        f"/api/projects/{project_id}/pages/1/image", params={"size": "thumb"}, headers=auth_headers
    )
    assert thumb.status_code == 200
    assert thumb.headers["content-type"] == "image/png"
    assert thumb.content.startswith(b"\x89PNG\r\n\x1a\n")

    bad = client.get(
        f"/api/projects/{project_id}/pages/1/image", params={"size": "huge"}, headers=auth_headers
    )
    assert bad.status_code == 400

    # 项目里根本没有第 99 页 → 404（"找不到"而不是"渲染失败"）。
    # 2026-10-14 起：图片接口先按**页记录**解析 PDF 下标（任务包的 PDF 是子集，
    # 页码与下标不相等），页不存在时在这里就拦住了。
    out_of_range = client.get(
        f"/api/projects/{project_id}/pages/99/image", headers=auth_headers
    )
    assert out_of_range.status_code == 404
    assert out_of_range.json()["error"]["code"] == "page_not_found"


# ---------------------------------------------------------------- 文本层提示

def test_text_layer_hint_for_a_born_digital_pdf(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    """说明书 6.1：若大部分页面已有文本层，提示"这本 PDF 可能已包含文本"。

    用 Phase 0 的合成冒烟样本——它是原生排版 PDF，三页都有文本层。
    扫描样本（sample-20p / rotated-page-90）反过来验证不提示。
    """
    data = create(client, auth_headers, sample_pdf).json()
    assert data["pages_with_text_layer"] == 3
    assert data["text_layer_hint"] is True


def test_no_text_layer_hint_for_scanned_like_pdf(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path
) -> None:
    """图像型 PDF（如扫描件）不应触发提示。"""
    data = create(client, auth_headers, rotated_pdf).json()
    assert data["pages_with_text_layer"] == 0
    assert data["text_layer_hint"] is False


# ---------------------------------------------------------------- 安全与错误

@pytest.mark.parametrize(
    "bad_id",
    ["..", "../etc", "b2t_", "b2t_TOOLONG", "notaprefix_ABC123", "b2t_ABCDEi"],
)
def test_invalid_project_id_is_rejected(
    client: TestClient, auth_headers: dict[str, str], bad_id: str
) -> None:
    """ID 来自请求路径，必须先校验再拼接，避免路径穿越（说明书 4.4）。"""
    response = client.get(f"/api/projects/{bad_id}", headers=auth_headers)
    assert response.status_code == 404


def test_unknown_project_returns_404(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = client.get("/api/projects/b2t_ZZZZZZ", headers=auth_headers)
    assert response.status_code == 404


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("get", "/api/projects/b2t_ZZZZZZ/pages", None),
        ("get", "/api/projects/b2t_ZZZZZZ/pages/1/blocks", None),
        ("get", "/api/projects/b2t_ZZZZZZ/jobs", None),
        ("patch", "/api/projects/b2t_ZZZZZZ/pages", {"page_ids": ["x"], "include": False}),
        ("put", "/api/projects/b2t_ZZZZZZ/position", {"view": "pages"}),
        ("post", "/api/projects/b2t_ZZZZZZ/structure/header-footer/preview", {}),
        ("post", "/api/projects/b2t_ZZZZZZ/export/preflight", {}),
    ],
)
def test_unknown_project_is_404_everywhere(
    client: TestClient, auth_headers: dict[str, str], method: str, path: str, body
) -> None:
    """项目不存在时，各个接口都该回 404——而不是让 sqlite 抛出 500。

    这一条是补的：`list_pages` 之类直接开库的函数原先没有检查目录存在，
    对不存在的项目会抛 `OperationalError`（500）。
    """
    call = getattr(client, method)
    response = call(path, json=body, headers=auth_headers) if body is not None else call(
        path, headers=auth_headers
    )
    assert response.status_code == 404, f"{method} {path} → {response.status_code}"
    assert response.json()["error"]["code"] in ("project_error", "job_error", "export_failed")


def test_empty_library_lists_nothing(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path
) -> None:
    data = client.get("/api/projects", headers=auth_headers).json()
    assert data["count"] == 0
    assert data["projects"] == []
    assert data["library_dir"] == str(library_dir)


def test_listing_shows_review_progress(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs,  # noqa: ANN001 - conftest 的夹具，把识别换成本进程同步跑
) -> None:
    """项目卡上的识别 / 审校进度（UI 效果图 01 的两条进度条）。

    数字必须来自真实库：识别前是 0；认完但没确认还是 0；确认一整页才算 1 页；
    标了不确定就不算审完。UI 只负责显示，不自己推算。
    """
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    first = client.get("/api/projects", headers=auth_headers).json()["projects"][0]
    assert first["reviewed_pages"] == 0
    assert first["uncertain_blocks"] == 0

    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    blocks = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"]
    assert blocks, "假引擎应当在这一页切出块"

    recognized = client.get("/api/projects", headers=auth_headers).json()["projects"][0]
    assert recognized["recognized_pages"] == 1
    assert recognized["reviewed_pages"] == 0, "认完还没审，审校进度不该动"

    client.post(f"/api/projects/{project_id}/pages/1/confirm", headers=auth_headers)
    reviewed = client.get("/api/projects", headers=auth_headers).json()["projects"][0]
    assert reviewed["reviewed_pages"] == 1
    assert reviewed["uncertain_blocks"] == 0

    # 把一块重新标成不确定：这一页就不算审完了
    client.patch(
        f"/api/projects/{project_id}/blocks/{blocks[0]['block_id']}",
        json={"review_status": "uncertain"},
        headers=auth_headers,
    )
    questioned = client.get("/api/projects", headers=auth_headers).json()["projects"][0]
    assert questioned["uncertain_blocks"] == 1
    assert questioned["reviewed_pages"] == 0


def test_listing_shows_last_position(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    """项目卡上的"上次位置：审校 · 第 N 页"（说明书 7.2 的"继续"）。

    页码要现查（卡片上要显示"第几页"，不是内部 page_id），所以这一条单独测。
    """
    project_id = create(client, auth_headers, sample_pdf).json()["project"]["project_id"]
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    second = pages[1]

    saved = client.put(
        f"/api/projects/{project_id}/position",
        json={"view": "review", "page_id": second["page_id"]},
        headers=auth_headers,
    )
    assert saved.status_code == 200, saved.text

    entry = client.get("/api/projects", headers=auth_headers).json()["projects"][0]
    assert entry["last_view"] == "review"
    assert entry["last_page_no"] == second["page_no"]
    assert entry["failed_pages"] == 0
