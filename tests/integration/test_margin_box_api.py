"""版心接口（任务 50）：推算只读、项目级/页级三态、批量、导出不变。

真书 + 真浏览器上的"框压不压字、拖不拖得动"在任务报告的验收里；
这里保证接口契约与数据一致性。
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
        params={"name": "版心测试", "filename": pdf.name},
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


def put_margin(client: TestClient, headers: dict[str, str], project_id: str, box):
    return client.put(
        f"/api/projects/{project_id}/margin-box",
        json={"margin_box": box},
        headers=headers,
    )


def patch_page(client: TestClient, headers: dict[str, str], project_id: str, page_no: int, **body):
    return client.patch(
        f"/api/projects/{project_id}/pages/{page_no}/margin-box",
        json=body,
        headers=headers,
    )


def patch_pages(client: TestClient, headers: dict[str, str], project_id: str, **body):
    return client.patch(
        f"/api/projects/{project_id}/margin-box/pages",
        json=body,
        headers=headers,
    )


def margin_state(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/margin-box", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def recognized_project(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, [1, 2, 3])
    return project_id


def test_project_and_page_payloads_have_margin_fields(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    data = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()
    assert data["project"]["margin_box"] is None
    assert data["pages"][0]["margin_box"] is None
    assert data["pages"][0]["margin_box_mode"] == "inherit"


def test_suggestion_is_read_only_and_reports_dispersion(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_project: str,
) -> None:
    """三页假识别：给出四边，但页数少于 5，如实标"不可靠"。

    任务 53 起识别收尾会自动写一次版心（source=auto），所以这里比的是"调用推算接口前
    后"，证明 GET suggestion 本身仍然只读；自动那一次由下面的用例单独验证。
    """
    before = margin_state(client, auth_headers, recognized_project)
    assert before["source"] == "auto", "识别收尾应自动写入版心"
    assert before["suggestion"] is not None
    response = client.get(
        f"/api/projects/{recognized_project}/margin-box/suggestion", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    suggestion = response.json()["suggestion"]

    assert suggestion["margin_box"] is not None
    left, top, right, bottom = suggestion["margin_box"]
    assert 0 <= left < right <= 1 and 0 <= top < bottom <= 1
    assert suggestion["pages"] == 3
    assert suggestion["reliable"] is False
    assert suggestion["confidence"] == "low"
    assert any("少于 5 页" in note for note in suggestion["notes"])
    assert set(suggestion["edges"]) == {"left", "top", "right", "bottom"}
    for edge in suggestion["edges"].values():
        assert 0 <= edge["value"] <= 1
        assert edge["spread"] >= 0
        assert edge["samples"] > 0

    after = margin_state(client, auth_headers, recognized_project)
    assert after == before, "GET 推算接口必须只读"

    with db_module.open_database(library_dir / recognized_project, apply_migrations=False) as conn:
        project_row = conn.execute(
            "SELECT margin_box, margin_box_source FROM project"
        ).fetchone()
        page_rows = conn.execute("SELECT margin_box_mode FROM page").fetchall()
    assert json.loads(project_row["margin_box"]) == suggestion["margin_box"]
    assert project_row["margin_box_source"] == "auto"
    assert {row["margin_box_mode"] for row in page_rows} == {"inherit"}


def test_project_margin_box_round_trip(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    response = put_margin(client, auth_headers, recognized_project, [0.1, 0.12, 0.9, 0.92])
    assert response.status_code == 200, response.text
    assert response.json()["project"]["margin_box"] == [0.1, 0.12, 0.9, 0.92]

    data = client.get(f"/api/projects/{recognized_project}", headers=auth_headers).json()
    assert data["project"]["margin_box"] == [0.1, 0.12, 0.9, 0.92]
    # 页没有自己的设置：沿用全局
    assert data["pages"][0]["margin_box"] is None
    assert data["pages"][0]["margin_box_mode"] == "inherit"

    cleared = put_margin(client, auth_headers, recognized_project, None)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["project"]["margin_box"] is None


def test_project_margin_box_rejects_bad_geometry(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    for box in (
        [0.9, 0.1, 0.2, 0.9],      # 左 > 右
        [-0.1, 0.1, 0.9, 0.9],     # 越界
        [0.49, 0.1, 0.50, 0.9],    # 太窄
        [0.1, 0.1, 0.9],           # 不是四个数
    ):
        response = put_margin(client, auth_headers, recognized_project, box)
        assert response.status_code == 400, (box, response.text)
        assert response.json()["error"]["code"] == "bad_margin_box"


def test_page_margin_box_three_modes(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    put_margin(client, auth_headers, recognized_project, [0.1, 0.1, 0.9, 0.9])

    custom = patch_page(
        client,
        auth_headers,
        recognized_project,
        2,
        margin_box_mode="custom",
        margin_box=[0.2, 0.2, 0.8, 0.8],
    )
    assert custom.status_code == 200, custom.text
    assert custom.json()["page"]["margin_box_mode"] == "custom"
    assert custom.json()["page"]["margin_box"] == [0.2, 0.2, 0.8, 0.8]

    state = margin_state(client, auth_headers, recognized_project)
    assert state["modes"] == {"inherit": 2, "custom": 1, "none": 0}
    assert state["exceptions"] == [
        {"page_no": 2, "margin_box_mode": "custom", "margin_box": [0.2, 0.2, 0.8, 0.8]}
    ]

    none = patch_page(client, auth_headers, recognized_project, 3, margin_box_mode="none")
    assert none.status_code == 200, none.text
    assert none.json()["page"]["margin_box"] is None
    assert none.json()["page"]["margin_box_mode"] == "none"

    # 回到"沿用全局"会清掉本页四边，避免留下一个看不见的旧框
    inherit = patch_page(client, auth_headers, recognized_project, 2, margin_box_mode="inherit")
    assert inherit.status_code == 200, inherit.text
    assert inherit.json()["page"]["margin_box_mode"] == "inherit"
    assert inherit.json()["page"]["margin_box"] is None


def test_custom_mode_requires_a_box(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    response = patch_page(
        client, auth_headers, recognized_project, 1, margin_box_mode="custom"
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_margin_box"


def test_unknown_mode_is_rejected(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    response = patch_page(
        client, auth_headers, recognized_project, 1, margin_box_mode="whatever"
    )
    assert response.status_code == 400


def test_batch_sets_modes_atomically(
    client: TestClient, auth_headers: dict[str, str], recognized_project: str
) -> None:
    batch = patch_pages(
        client,
        auth_headers,
        recognized_project,
        page_nos=[1, 2, 3],
        margin_box_mode="custom",
        margin_box=[0.15, 0.15, 0.85, 0.85],
    )
    assert batch.status_code == 200, batch.text
    assert batch.json()["updated"] == 3
    for page in batch.json()["pages"]:
        assert page["margin_box_mode"] == "custom"
        assert page["margin_box"] == [0.15, 0.15, 0.85, 0.85]

    # 有一页不存在：整批拒绝，已存在的页保持原样
    rejected = patch_pages(
        client,
        auth_headers,
        recognized_project,
        page_nos=[1, 99],
        margin_box_mode="none",
    )
    assert rejected.status_code == 404
    assert margin_state(client, auth_headers, recognized_project)["modes"] == {
        "inherit": 0,
        "custom": 3,
        "none": 0,
    }

    cleared = patch_pages(
        client, auth_headers, recognized_project, page_nos=[1, 2, 3], margin_box_mode="inherit"
    )
    assert cleared.status_code == 200, cleared.text
    assert margin_state(client, auth_headers, recognized_project)["modes"] == {
        "inherit": 3,
        "custom": 0,
        "none": 0,
    }


def test_margin_box_does_not_change_exports(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    recognized_project: str,
) -> None:
    """本刀不改导出的硬证据：同一范围导出两次，body.txt / meta.json 逐字节相同。"""

    def run_export() -> tuple[bytes, bytes]:
        response = client.post(
            f"/api/projects/{recognized_project}/export",
            json={"format": "both", "page_numbers": [1, 2, 3]},
            headers=auth_headers,
        )
        assert response.status_code == 200, response.text
        record = response.json()["record"]
        directory = library_dir / recognized_project / "exports" / record["export_id"]
        return (
            (directory / "body.txt").read_bytes(),
            (directory / "meta.json").read_bytes(),
        )

    before = run_export()

    # 设置全局版心 + 一页自定义 + 一页"不适用"
    assert put_margin(
        client, auth_headers, recognized_project, [0.11, 0.12, 0.89, 0.9]
    ).status_code == 200
    assert patch_page(
        client,
        auth_headers,
        recognized_project,
        2,
        margin_box_mode="custom",
        margin_box=[0.2, 0.2, 0.8, 0.8],
    ).status_code == 200
    assert patch_page(
        client, auth_headers, recognized_project, 3, margin_box_mode="none"
    ).status_code == 200

    after = run_export()
    assert after[0] == before[0], "body.txt 不能因为版心变化"
    assert after[1] == before[1], "meta.json 不能因为版心变化"

    meta = json.loads(after[1])
    assert "margin_box" not in json.dumps(meta), "版心不进导出元数据"
