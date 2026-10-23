"""项目级识别设置（任务 54）：引擎 / DPI / 语言 / 双引擎策略。

这里钉住"设置不是只存不用"：建识别任务时读取项目设置，并写进 `job.params_json`
（子进程按它挑适配器与渲染参数）。真实 OCR 的验收在任务报告里；这里用假引擎跑
任务状态机，只验证参数传递与引擎选择逻辑。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.ocr.adapters.apple_vision import AppleVisionAdapter
from book2text.core.project import recognition
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "识别设置测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def patch_settings(client: TestClient, headers: dict[str, str], project_id: str, **values):
    return client.patch(
        f"/api/projects/{project_id}/settings", json=values, headers=headers
    )


def start_ocr(client: TestClient, headers: dict[str, str], project_id: str, pages: list[int]):
    return client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": pages, "skip_recognized": False},
        headers=headers,
    )


@pytest.fixture
def project_id(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    return create_project(client, auth_headers, sample_pdf)


def test_settings_are_validated_and_persisted(
    client: TestClient, auth_headers: dict[str, str], project_id: str
) -> None:
    response = patch_settings(
        client,
        auth_headers,
        project_id,
        recognition_engine="rapidocr",
        recognition_dpi=300,
        recognition_language="en",
        dual_engine_strategy="candidates",
    )
    assert response.status_code == 200, response.text
    settings = response.json()["settings"]
    assert settings["recognition_dpi"] == 300
    assert settings["recognition_language"] == "en"
    assert settings["dual_engine_strategy"] == "candidates"

    data = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()
    assert data["project"]["settings"]["recognition_dpi"] == 300

    # 取值白名单：不在三档里的 DPI、未知引擎都直接 400
    for bad in (
        {"recognition_dpi": 250},
        {"recognition_engine": "paddle"},
        {"recognition_language": "ja"},
        {"dual_engine_strategy": "auto"},
    ):
        response = patch_settings(client, auth_headers, project_id, **bad)
        assert response.status_code == 400, (bad, response.text)
        assert response.json()["error"]["code"] == "project_error"


def test_dpi_and_language_go_into_the_job_params(
    client: TestClient, auth_headers: dict[str, str], project_id: str
) -> None:
    """改 DPI 300 → 起任务 → 任务参数里确实是 300（不是只写设置文件）。"""
    patch_settings(client, auth_headers, project_id, recognition_dpi=300, recognition_language="en")
    response = start_ocr(client, auth_headers, project_id, [1])
    assert response.status_code == 200, response.text
    params = response.json()["job"]["params"]
    assert params["dpi"] == 300
    assert params["language"] == "en"
    assert params["engine_setting"] == "rapidocr"
    # 测试把第一引擎换成了假引擎，所以 engine_id 是 fake；engine_setting 才是设置的原值
    assert params["engine_id"]


def test_default_settings_keep_the_old_behaviour(
    client: TestClient, auth_headers: dict[str, str], project_id: str
) -> None:
    """没有动过设置的项目：仍是 200 DPI / ch / RapidOCR。"""
    response = start_ocr(client, auth_headers, project_id, [1])
    assert response.status_code == 200, response.text
    params = response.json()["job"]["params"]
    assert params["dpi"] == 200
    assert params["language"] == "ch"
    assert params["engine_setting"] == "rapidocr"
    assert params["engine_id"]  # 假引擎的 id，测试环境替换了 RapidOCR 适配器


def test_explicit_dpi_argument_still_wins(
    client: TestClient, auth_headers: dict[str, str], project_id: str
) -> None:
    """旧客户端 / 测试显式传 dpi 时优先于项目设置。"""
    patch_settings(client, auth_headers, project_id, recognition_dpi=300)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False, "dpi": 150},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["job"]["params"]["dpi"] == 150


def test_apple_vision_can_be_the_primary_engine(
    client: TestClient, auth_headers: dict[str, str], project_id: str
) -> None:
    available, reason = AppleVisionAdapter().available()
    if not available:
        pytest.skip(f"Apple Vision 在当前环境不可用：{reason}")
    response = patch_settings(client, auth_headers, project_id, recognition_engine="apple_vision")
    assert response.status_code == 200, response.text

    started = start_ocr(client, auth_headers, project_id, [1])
    assert started.status_code == 200, started.text
    params = started.json()["job"]["params"]
    assert params["engine_id"] == "apple_vision"
    assert params["engine_setting"] == "apple_vision"


def test_dual_engine_records_both_engines(
    client: TestClient, auth_headers: dict[str, str], project_id: str
) -> None:
    available, reason = AppleVisionAdapter().available()
    if not available:
        pytest.skip(f"双引擎需要 Apple Vision：{reason}")
    response = patch_settings(client, auth_headers, project_id, recognition_engine="dual")
    assert response.status_code == 200, response.text

    started = start_ocr(client, auth_headers, project_id, [1])
    assert started.status_code == 200, started.text
    params = started.json()["job"]["params"]
    assert params["engine_setting"] == "dual"
    assert params["secondary_engine_id"] == "apple_vision"


def test_unavailable_engine_is_rejected_at_job_creation(
    client: TestClient, auth_headers: dict[str, str], project_id: str
) -> None:
    """设置里存了不可用的引擎（比如 Mac 上做好、在 Windows 打开）：建任务时明确 503。"""
    available, _ = AppleVisionAdapter().available()
    if available:
        pytest.skip("当前环境 Apple Vision 可用，无法验证不可用分支")
    patch_settings(client, auth_headers, project_id, recognition_engine="apple_vision")
    response = start_ocr(client, auth_headers, project_id, [1])
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "ocr_engine_unavailable"


def test_recognition_settings_fall_back_on_bad_stored_values(
    client: TestClient, auth_headers: dict[str, str], project_id: str, library_dir: Path
) -> None:
    """数据库里存了脏值（手改 / 旧版本）时退回默认，不让识别被一个坏设置挡住。"""
    from book2text.core.storage import db as db_module

    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE project SET settings_json = ?",
            ('{"recognition_engine": "nope", "recognition_dpi": 999, '
             '"recognition_language": "xx", "dual_engine_strategy": "weird"}',),
        )
        conn.commit()

    resolved = recognition.recognition_settings(project_id, library=library_dir)
    assert resolved == {
        "recognition_engine": "rapidocr",
        "recognition_dpi": 200,
        "recognition_language": "ch",
        "dual_engine_strategy": "mark",
    }


def test_dual_engine_compares_each_page_in_the_worker(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """双引擎设置真的会让子进程在第一路之后跑第二路（按页，不是只写参数）。

    这里不碰真平台：把第一 / 第二引擎换成测试用的假引擎，直接走 `run_job` 的
    生产分支（engine=None + job.params 里 engine_setting=dual）。
    """
    from book2text.core.project import jobs as jobs_module
    from book2text.core.storage import db as db_module
    from tests.fakes import FakeOcrEngine, FakeSecondEngine

    project_id = create_project(client, auth_headers, sample_pdf)
    monkeypatch.setattr(recognition, "adapter_for_engine", lambda engine_id: FakeOcrEngine())
    monkeypatch.setattr(recognition, "default_secondary_engine", lambda: FakeSecondEngine())

    directory = library_dir / project_id
    with db_module.open_database(directory) as conn:
        page = conn.execute("SELECT page_id FROM page WHERE page_no = 1").fetchone()
    job = jobs_module.create_job(
        directory,
        pages=[(page["page_id"], 1)],
        params={
            "dpi": 200,
            "language": "ch",
            "engine_id": "fake",
            "engine_setting": "dual",
            "secondary_engine_id": "fake-second",
        },
    )
    outcome = recognition.run_job(directory, job.job_id)
    assert outcome.job.status == "succeeded"

    data = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()
    run_types = {run.get("run_type") for run in data.get("runs") or []}
    assert run_types == {"primary", "auxiliary"}
    assert data["divergence"]["checked"] is True
    assert data["divergence"]["engine_id"] == "fake-second"
