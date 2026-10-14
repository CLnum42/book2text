"""应用设置与诊断日志（说明书 Phase 6：首次运行检查、我的名字、导出诊断日志）。

两条日志规则是这里的验收点（说明书 Phase 6 原文）：
**不写识别文本内容**、**不写项目外的个人绝对路径**。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core import settings as settings_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "诊断用书", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


# ---------------------------------------------------------------- 设置（我的名字）

def test_first_run_then_name_is_saved(library_dir: Path) -> None:
    """没有设置文件就是首次运行；存了名字之后不再是。"""
    first = settings_module.load_settings(library_dir)
    assert first.first_run is True
    assert first.user_name == ""

    saved = settings_module.save_settings(library_dir, user_name="  小林  ")
    assert saved.user_name == "小林"
    assert saved.first_run is False
    assert settings_module.load_settings(library_dir).user_name == "小林"

    # 名字存在项目库里的一个纯文本 JSON 里（随项目库搬走）
    payload = json.loads(
        (library_dir / settings_module.SETTINGS_FILE_NAME).read_text(encoding="utf-8")
    )
    assert payload == {"user_name": "小林"}


def test_settings_file_is_trimmed_and_bounded(library_dir: Path) -> None:
    saved = settings_module.save_settings(library_dir, user_name="x" * 200)
    assert len(saved.user_name) == settings_module.MAX_NAME_LENGTH


def test_broken_settings_file_falls_back_to_first_run(library_dir: Path) -> None:
    """设置文件读坏了不该挡住用应用——当成没设置（界面会再问一次名字）。"""
    (library_dir / settings_module.SETTINGS_FILE_NAME).write_text("{不是 JSON", encoding="utf-8")
    loaded = settings_module.load_settings(library_dir)
    assert loaded.first_run is True
    assert loaded.user_name == ""


def test_settings_api_round_trip(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    info = client.get("/api/app/info", headers=auth_headers).json()
    assert info["settings"]["first_run"] is True

    saved = client.put("/api/app/settings", json={"user_name": "阿明"}, headers=auth_headers)
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"user_name": "阿明", "first_run": False}

    again = client.get("/api/app/info", headers=auth_headers).json()
    assert again["settings"] == {"user_name": "阿明", "first_run": False}


def test_name_is_recorded_as_actor_name(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """说明书 5.3：设置里的名字作为审校事件的 `actor_name` 记下来（谁改的可追溯）。"""
    from book2text.core.storage import db as db_module

    client.put("/api/app/settings", json={"user_name": "阿明"}, headers=auth_headers)
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    block = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"][0]

    # 界面不传 actor_name 时也应该用设置里的名字
    patched = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={"text": block["text"] + "改", "expected_revision": block["revision"]},
        headers=auth_headers,
    )
    assert patched.status_code == 200, patched.text

    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT actor_name FROM event WHERE action = 'edit_text' ORDER BY created_at DESC"
        ).fetchone()
    assert row["actor_name"] == "阿明"


def test_explicit_actor_name_wins_over_settings(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """显式给了名字（例如将来协作包里带的）就不该被设置覆盖。"""
    from book2text.core.storage import db as db_module

    client.put("/api/app/settings", json={"user_name": "阿明"}, headers=auth_headers)
    project_id = create_project(client, auth_headers, sample_pdf)
    client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    block = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"][0]
    client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={
            "text": block["text"] + "改",
            "expected_revision": block["revision"],
            "actor_name": "协作包里的名字",
        },
        headers=auth_headers,
    )
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT actor_name FROM event WHERE action = 'edit_text' ORDER BY created_at DESC"
        ).fetchone()
    assert row["actor_name"] == "协作包里的名字"


# ---------------------------------------------------------------- 诊断日志

def test_diagnostics_has_no_text_and_no_home_path(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """两条日志规则：不写识别文本、不写项目外的个人绝对路径。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    blocks = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"]
    recognized_text = blocks[0]["text"]
    assert recognized_text, "先确认确实认出了字，下面才谈得上「不含识别文本」"

    response = client.get("/api/app/diagnostics", headers=auth_headers)
    assert response.status_code == 200, response.text
    assert "text/plain" in response.headers["content-type"]
    assert "attachment" in response.headers["content-disposition"]
    report = response.text

    assert recognized_text not in report, "报告里不能出现识别出来的文字"
    assert str(Path.home()) not in report, "报告里不能出现个人家目录路径"
    assert "项目库目录：<已略去" in report
    # 该有的都在：版本、平台、引擎自检、项目统计、任务日志末尾
    assert "Book2Text 诊断报告" in report
    assert "引擎自检" in report
    assert "[primary]" in report
    assert project_id in report, "项目要按 id 列出来（不含目录路径）"
    assert "页面：" in report and "任务：" in report
    assert "不含识别文本" in report


def test_diagnostics_on_empty_library(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path
) -> None:
    response = client.get("/api/app/diagnostics", headers=auth_headers)
    assert response.status_code == 200
    assert "（还没有项目）" in response.text


def test_diagnostics_reports_the_saved_name(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path
) -> None:
    client.put("/api/app/settings", json={"user_name": "阿明"}, headers=auth_headers)
    report = client.get("/api/app/diagnostics", headers=auth_headers).text
    assert "我的名字：阿明" in report
