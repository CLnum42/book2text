"""识别后自动推算版心（任务 53）的集成测试。

用户 2026-10-23 早上的两条要求：

1. 版心随 OCR 自动计算并显示（页面视图 + 审校视图），不用先点按钮；
2. 审校默认只列版心内的块。

这里钉住服务端那半边的规则：

- 识别任务收尾自动写一次版心（source=auto），一次任务只算一次；
- 手动设过就**只更新建议、不覆盖当前值**（含迁移 0012 之前的老项目）；
- 打开项目时给升级前就识别过的项目补一次（没有建议才算）；
- **自动版心不参与导出**（"这一刀不改导出"的安全阀）。

界面（审校过滤 / 边框）在 `test_ui_assets.py` 的静态约定与真浏览器验收里。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "自动版心测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(
    client: TestClient, headers: dict[str, str], project_id: str, pages: list[int]
) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": pages, "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def project_data(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def margin_state(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/margin-box", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def put_margin(client: TestClient, headers: dict[str, str], project_id: str, box) -> dict:
    response = client.put(
        f"/api/projects/{project_id}/margin-box",
        json={"margin_box": box},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def set_judgement(
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


def export_files(library_dir: Path, project_id: str, response) -> dict[str, bytes]:
    assert response.status_code == 200, response.text
    record = response.json()["record"]
    directory = library_dir / project_id / "exports" / record["export_id"]
    return {
        name: (directory / name).read_bytes()
        for name in ("body.txt", "meta.json")
        if (directory / name).is_file()
    }


@pytest.fixture
def auto_project(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, [1, 2, 3])
    return project_id


def test_recognition_writes_auto_margin_and_suggestion(
    client: TestClient, auth_headers: dict[str, str], auto_project: str
) -> None:
    """识别收尾自动算出四边：来源 auto、有时间、建议随项目一起返回。"""
    project = project_data(client, auth_headers, auto_project)["project"]
    assert project["margin_box"] is not None
    assert project["margin_box_source"] == "auto"
    assert project["margin_box_set_at"]

    suggestion = project["margin_box_suggestion"]
    assert suggestion is not None
    assert suggestion["schema"] == "book2text.margin-suggestion.v1"
    assert suggestion["trigger"] == "ocr_job"
    assert suggestion["job_id"]
    assert suggestion["applied"] is True
    assert suggestion["suggested_at"]
    assert suggestion["margin_box"] == project["margin_box"]
    assert suggestion["pages"] == 3

    state = margin_state(client, auth_headers, auto_project)
    assert state["source"] == "auto"
    assert state["suggestion"]["job_id"] == suggestion["job_id"]


def test_manual_margin_is_never_overwritten_but_suggestion_updates(
    client: TestClient,
    auth_headers: dict[str, str],
    auto_project: str,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """手动设过之后，下一次识别只更新"建议"，当前值一个字都不动。"""
    manual = [0.12, 0.13, 0.88, 0.89]
    put_margin(client, auth_headers, auto_project, manual)
    before = project_data(client, auth_headers, auto_project)["project"]
    assert before["margin_box"] == manual
    assert before["margin_box_source"] == "manual"
    first_job = before["margin_box_suggestion"]["job_id"]

    # 再识别一次（同一批页，假引擎）：任务收尾仍会重算建议
    recognize(client, auth_headers, auto_project, [1, 2, 3])
    after = project_data(client, auth_headers, auto_project)["project"]

    assert after["margin_box"] == manual, "手动版心绝不能被自动值覆盖"
    assert after["margin_box_source"] == "manual"
    suggestion = after["margin_box_suggestion"]
    assert suggestion["job_id"] != first_job, "建议应该被这一次任务更新"
    assert suggestion["applied"] is False, "没采用就不该标记为已生效"
    # 建议本身仍然按数据算出来（不是把当前值抄回去）
    assert suggestion["margin_box"] != manual


def test_legacy_manual_margin_without_source_is_treated_as_manual(
    client: TestClient,
    auth_headers: dict[str, str],
    auto_project: str,
    library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """迁移 0012 之前手动设过的项目：source 是 NULL + 版心非空，同样不许覆盖。"""
    legacy = [0.1, 0.11, 0.9, 0.91]
    with db_module.open_database(
        library_dir / auto_project, apply_migrations=False
    ) as conn:
        conn.execute(
            "UPDATE project SET margin_box = ?, margin_box_source = NULL,"
            " margin_box_suggestion = NULL",
            (json.dumps(legacy),),
        )
        conn.commit()

    recognize(client, auth_headers, auto_project, [1, 2, 3])
    project = project_data(client, auth_headers, auto_project)["project"]
    assert project["margin_box"] == legacy
    assert project["margin_box_source"] is None
    assert project["margin_box_suggestion"] is not None


def test_opening_a_legacy_project_backfills_the_suggestion(
    client: TestClient,
    auth_headers: dict[str, str],
    auto_project: str,
    library_dir: Path,
) -> None:
    """升级前就识别过的项目：打开时补一次，不用用户先点「推算版心」。"""
    with db_module.open_database(
        library_dir / auto_project, apply_migrations=False
    ) as conn:
        conn.execute(
            "UPDATE project SET margin_box = NULL, margin_box_source = NULL,"
            " margin_box_set_at = NULL, margin_box_suggestion = NULL"
        )
        conn.commit()

    response = client.post(
        f"/api/projects/{auto_project}/open?force=true", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    project = response.json()["project"]
    assert project["margin_box"] is not None
    assert project["margin_box_source"] == "auto"
    assert project["margin_box_suggestion"]["trigger"] == "open"


def test_auto_margin_is_ignored_by_export(
    client: TestClient,
    auth_headers: dict[str, str],
    auto_project: str,
    library_dir: Path,
) -> None:
    """自动推算的版心只用于显示 / 审校；打开「按版心判定」导出时仍按块类型。

    这是"这一刀不改导出"的可执行证明：同一项目，删除自动版心前后导出的
    `body.txt` / `meta.json` 必须逐字节相同。
    """
    set_judgement(client, auth_headers, auto_project, True)
    with_auto = export_files(
        library_dir, auto_project, export(client, auth_headers, auto_project)
    )
    assert with_auto, "导出应产生 body.txt / meta.json"

    put_margin(client, auth_headers, auto_project, None)  # 清掉自动值（source 也清空）
    without_box = export_files(
        library_dir, auto_project, export(client, auth_headers, auto_project)
    )
    assert with_auto == without_box, "自动版心不得影响导出内容"


def test_clearing_the_manual_margin_lets_auto_fill_again(
    client: TestClient,
    auth_headers: dict[str, str],
    auto_project: str,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    put_margin(client, auth_headers, auto_project, [0.2, 0.2, 0.8, 0.8])
    assert (
        project_data(client, auth_headers, auto_project)["project"]["margin_box_source"]
        == "manual"
    )
    put_margin(client, auth_headers, auto_project, None)
    recognize(client, auth_headers, auto_project, [1, 2, 3])
    project = project_data(client, auth_headers, auto_project)["project"]
    assert project["margin_box"] is not None
    assert project["margin_box_source"] == "auto"


def test_preflight_explains_auto_pages_without_own_box(
    client: TestClient, auth_headers: dict[str, str], auto_project: str
) -> None:
    """任务 33：auto 页没有本页落库框 = 未定；不拿项目默认框顶替，预检要报出来。"""
    set_judgement(client, auth_headers, auto_project, True)

    def preflight() -> dict:
        response = client.post(
            f"/api/projects/{auto_project}/export/preflight",
            json={"format": "txt"},
            headers=auth_headers,
        )
        assert response.status_code == 200, response.text
        return response.json()

    auto = preflight()
    assert auto["margin_judgement"] is True
    assert auto["margin_pages"]["auto"] is True
    assert auto["margin_pages"]["applied"] == 0
    assert len(auto["margin_pages"]["undetermined"]) == 3

    # 设了人工默认框也不影响 auto 页：它们没有本页框，仍不参与判定
    put_margin(client, auth_headers, auto_project, [0.1, 0.1, 0.9, 0.9])
    manual = preflight()
    assert manual["margin_pages"]["auto"] is False
    assert manual["margin_pages"]["applied"] == 0
    assert len(manual["margin_pages"]["undetermined"]) == 3

    # 只有给了本页框的页才参与
    response = client.patch(
        f"/api/projects/{auto_project}/pages/1/margin-box",
        json={"margin_box_mode": "custom", "margin_box": [0.1, 0.1, 0.9, 0.9]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    with_page_box = preflight()
    assert with_page_box["margin_pages"]["applied"] == 1
    assert len(with_page_box["margin_pages"]["undetermined"]) == 2


def test_layout_job_writes_auto_margin_before_recognition(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_layout_jobs,
) -> None:
    """任务 59：检测收尾就能算出并写入版心，不需要先识别。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/layout",
        json={"pages": [1, 2, 3]},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["job"]["status"] == "succeeded"

    project = project_data(client, auth_headers, project_id)["project"]
    assert project["margin_box"] is not None
    assert project["margin_box_source"] == "auto"
    suggestion = project["margin_box_suggestion"]
    assert suggestion["trigger"] == "layout_job"
    assert suggestion["job_id"] == response.json()["job"]["job_id"]
    assert suggestion["applied"] is True
    assert suggestion["pages"] == 3

    # 这三页还没有任何识别结果：版心确实是在识别之前算出来的
    pages = client.get(
        f"/api/projects/{project_id}/pages", headers=auth_headers
    ).json()["pages"]
    assert all(page["recognition"]["status"] == "unrecognized" for page in pages)


def test_prepare_job_fits_existing_detection_and_skips_custom(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_layout_jobs,
) -> None:
    """任务 62：准备任务已有检测行的页只拟合，没有的页先检测；custom 不动。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    first = client.post(
        f"/api/projects/{project_id}/jobs/layout",
        json={"pages": [1]},
        headers=auth_headers,
    )
    assert first.status_code == 200, first.text
    assert first.json()["job"]["status"] == "succeeded"

    custom_box = [0.2, 0.2, 0.8, 0.8]
    custom = client.patch(
        f"/api/projects/{project_id}/pages/2/margin-box",
        json={"margin_box_mode": "custom", "margin_box": custom_box},
        headers=auth_headers,
    )
    assert custom.status_code == 200, custom.text

    prepared = client.post(
        f"/api/projects/{project_id}/jobs/layout",
        json={"pages": [1, 2], "prepare": True},
        headers=auth_headers,
    )
    assert prepared.status_code == 200, prepared.text
    job = prepared.json()["job"]
    assert job["status"] == "succeeded"
    assert job["params"]["mode"] == "prepare"
    assert job["done"] == 2

    pages = client.get(
        f"/api/projects/{project_id}/pages", headers=auth_headers
    ).json()["pages"]
    by_no = {page["page_no"]: page for page in pages}
    assert by_no[1]["margin_box_mode"] == "auto"
    assert by_no[1]["margin_box"] is not None
    assert by_no[2]["margin_box_mode"] == "custom"
    assert by_no[2]["margin_box"] == custom_box

    audit = client.get(
        f"/api/projects/{project_id}/pages/1/margin-box/audit", headers=auth_headers
    )
    assert audit.status_code == 200
    assert audit.json()["outside"] == 0


def test_fit_all_api_keeps_custom_and_none(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_layout_jobs,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    # 先检测 1、2 页，3 页保持没有检测行
    response = client.post(
        f"/api/projects/{project_id}/jobs/layout",
        json={"pages": [1, 2]},
        headers=auth_headers,
    )
    assert response.status_code == 200
    for page_no, mode, box in (
        (2, "custom", [0.2, 0.2, 0.8, 0.8]),
        (3, "none", None),
    ):
        patched = client.patch(
            f"/api/projects/{project_id}/pages/{page_no}/margin-box",
            json={"margin_box_mode": mode, "margin_box": box},
            headers=auth_headers,
        )
        assert patched.status_code == 200, patched.text

    result = client.post(
        f"/api/projects/{project_id}/margin-box/fit-all", headers=auth_headers
    )
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["updated"] == 1
    assert data["fitted"] == 1
    assert data["skipped_custom"] == 1
    assert data["skipped_none"] == 1

    pages = client.get(
        f"/api/projects/{project_id}/pages", headers=auth_headers
    ).json()["pages"]
    by_no = {page["page_no"]: page for page in pages}
    assert by_no[1]["margin_box_mode"] == "auto"
    assert by_no[1]["margin_box"] is not None
    assert by_no[2]["margin_box_mode"] == "custom"
    assert by_no[2]["margin_box"] == [0.2, 0.2, 0.8, 0.8]
    assert by_no[3]["margin_box_mode"] == "none"


def test_fit_all_only_missing_batches_and_keeps_custom(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_layout_jobs,
) -> None:
    """任务 36B：进「版心确认」时只补没拟合的页，绝不覆盖用户拖过的框。

    - `only_missing` 只处理 `mode=auto` 且 `margin_box` 还是 NULL 的页；
    - `custom` / `none` / `inherit` 一律跳过（`inherit` 是用户显式选择沿用默认框）；
    - `limit` 一次处理一批，`remaining` 回传还剩多少页，界面据此显示真实进度；
    - 已经有框的 auto 页不会被重新拟合。
    """
    project_id = create_project(client, auth_headers, sample_pdf)
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()[
        "pages"
    ]
    assert len(pages) >= 2

    # 只让第 1、2 页参与：第 3 页及以后标「不适用」，避免"没有检测行"的页混进计数。
    for page in pages[2:]:
        patched = client.patch(
            f"/api/projects/{project_id}/pages/{page['page_no']}/margin-box",
            json={"margin_box_mode": "none", "margin_box": None},
            headers=auth_headers,
        )
        assert patched.status_code == 200, patched.text
    detected = client.post(
        f"/api/projects/{project_id}/jobs/layout",
        json={"pages": [1, 2]},
        headers=auth_headers,
    )
    assert detected.status_code == 200, detected.text
    assert detected.json()["job"]["status"] == "succeeded"

    # 制造两页"有检测行、但没有拟合框"：等价于升级前就检测过、还没拟合的项目。
    with db_module.open_database(library_dir / project_id) as conn:
        conn.execute(
            "UPDATE page SET margin_box = NULL, margin_box_method = NULL"
            " WHERE page_no IN (1, 2)"
        )
        conn.commit()

    first = client.post(
        f"/api/projects/{project_id}/margin-box/fit-all",
        json={"only_missing": True, "limit": 1},
        headers=auth_headers,
    )
    assert first.status_code == 200, first.text
    data = first.json()
    assert data["only_missing"] is True
    assert data["updated"] == 1
    assert data["remaining"] == 1
    assert data["skipped_custom"] == 0

    second = client.post(
        f"/api/projects/{project_id}/margin-box/fit-all",
        json={"only_missing": True},
        headers=auth_headers,
    )
    assert second.status_code == 200, second.text
    assert second.json()["updated"] == 1
    assert second.json()["remaining"] == 0

    # 把第 2 页设成 custom：再补拟合必须跳过它，四边原样保留。
    custom_box = [0.11, 0.12, 0.89, 0.9]
    patched = client.patch(
        f"/api/projects/{project_id}/pages/2/margin-box",
        json={"margin_box_mode": "custom", "margin_box": custom_box},
        headers=auth_headers,
    )
    assert patched.status_code == 200, patched.text

    third = client.post(
        f"/api/projects/{project_id}/margin-box/fit-all",
        json={"only_missing": True},
        headers=auth_headers,
    )
    assert third.status_code == 200, third.text
    third_data = third.json()
    assert third_data["updated"] == 0
    assert third_data["remaining"] == 0
    assert third_data["skipped_custom"] == 1
    assert third_data["skipped_fitted"] == 1

    after = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()[
        "pages"
    ]
    by_no = {page["page_no"]: page for page in after}
    assert by_no[1]["margin_box"] is not None
    assert by_no[2]["margin_box_mode"] == "custom"
    assert by_no[2]["margin_box"] == custom_box
