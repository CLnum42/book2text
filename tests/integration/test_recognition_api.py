"""识别落库的集成测试（识别接到项目上 + 任务状态机）。

**用假引擎、在本进程里跑**（`inprocess_jobs` 夹具）：这条链路要验证的是
"识别 → 落库 → 重启还在"、R1 / R2 两条业务规则、失败原因可见、范围选择——
都与"认得多准"无关。

真子进程 + 真引擎的端到端在 `test_worker_subprocess.py`；真实坐标与耗时在
`test_recognition_engine.py`。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.api.app import create_app
from book2text.core.project import jobs as jobs_module
from book2text.core.project import recognition
from book2text.core.storage import db as db_module
from book2text.core.ocr.base import OcrEngineError
from tests.conftest import TEST_ORIGIN, TEST_TOKEN
from tests.fakes import FAKE_LINES, FAKE_LEFT, FAKE_RIGHT, FailingEngine, FakeOcrEngine


class FlakyEngine(FakeOcrEngine):
    """第一次调用失败、之后成功——用来造出"部分失败的任务"。"""

    def recognize(self, image, params):
        if self.calls == 0:
            self.calls += 1
            raise OcrEngineError("第一次就是不行")
        return super().recognize(image, params)


@pytest.fixture
def restart_client():
    def _restart(library_dir: Path) -> TestClient:
        return TestClient(
            create_app(
                session_token=TEST_TOKEN, origins=[TEST_ORIGIN], library_dir=library_dir
            )
        )

    return _restart


def create_project(
    client: TestClient, headers: dict[str, str], pdf: Path, *, name: str = "识别测试"
) -> str:
    response = client.post(
        "/api/projects",
        params={"name": name, "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(
    client: TestClient,
    headers: dict[str, str],
    project_id: str,
    *pages: int,
    skip_recognized: bool | None = None,
):
    body: dict[str, object] = {"pages": list(pages)}
    if skip_recognized is not None:
        body["skip_recognized"] = skip_recognized
    return client.post(
        f"/api/projects/{project_id}/jobs/ocr", json=body, headers=headers
    )


def start_scope(client: TestClient, headers: dict[str, str], project_id: str, scope: str):
    return client.post(
        f"/api/projects/{project_id}/jobs/ocr", json={"scope": scope}, headers=headers
    )


def blocks_of(client: TestClient, headers: dict[str, str], project_id: str, page_no: int):
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def page_state(client: TestClient, headers: dict[str, str], project_id: str, page_no: int):
    pages = client.get(f"/api/projects/{project_id}/pages", headers=headers).json()["pages"]
    return next(page for page in pages if page["page_no"] == page_no)


def simulate_human_edit(library_dir: Path, project_id: str, block_id: str) -> None:
    """模拟审校（Phase 3）改过这个块。

    审校接口还不存在，所以直接改库——**这正是 R2 要保护的那类成果**：
    text 与 ocr_text 不同、状态已确认。
    """
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        conn.execute(
            """
            UPDATE block SET text = text || '（人工改）', revision = revision + 1,
                             review_status = 'confirmed'
            WHERE block_id = ?
            """,
            (block_id,),
        )
        conn.commit()


# ---------------------------------------------------------------- 首次识别（R1）

def test_recognize_persists_blocks_and_run(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)

    response = recognize(client, auth_headers, project_id, 1)
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["job"]["status"] == "succeeded"
    assert data["job"]["total"] == 1
    assert data["job"]["done"] == 1
    assert data["job"]["failed"] == 0
    assert data["job"]["finished_at"]
    assert data["job"]["percent"] == 100.0
    assert data["items"][0]["status"] == "succeeded"

    page = data["pages"][0]
    assert page["recognition"]["status"] == "recognized"
    assert page["recognition"]["block_count"] == 2, "三行两段应切成 2 块"

    # 块与行都落库了，文本与坐标可核对
    content = blocks_of(client, auth_headers, project_id, 1)
    assert content["block_count"] == 2
    assert content["active_run"]["run_id"] == data["items"][0]["run_id"]
    assert content["active_run"]["engine_id"] == "fake"
    assert content["active_run"]["elapsed_seconds"] > 0

    first, second = content["blocks"]
    assert first["text"] == "第一段第一行。\n第一段第二行。", "块文本保留行内换行（说明书 5.3）"
    assert first["ocr_text"] == first["text"], "刚识别出来的块，ocr_text 与 text 相同"
    assert first["review_status"] == "unreviewed"
    assert first["origin"] == "ocr"
    assert first["revision"] == 0
    assert first["include"] is True
    assert first["continues_to_next"] is False
    assert first["modified"] is False
    assert first["order_index"] == 0
    assert second["order_index"] == 1
    assert second["text"] == "第二段第一行。"

    assert [line["line_index"] for line in first["lines"]] == [0, 1]
    for block in content["blocks"]:
        box = block["bbox"]
        assert len(box) == 4
        assert all(0.0 <= value <= 1.0 for value in box), f"坐标越界：{box}"
        assert box[2] > box[0] and box[3] > box[1]
        for line in block["lines"]:
            assert len(line["bbox"]) == 4
            assert line["aux_text"] is None
            assert line["diff_status"] is None


def test_recognize_writes_the_raw_engine_output(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """说明书 5.3：`raw_result_path` 指向 `ocr_runs/<run_id>.json`。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    run_id = recognize(client, auth_headers, project_id, 1).json()["items"][0]["run_id"]

    raw_path = library_dir / project_id / "ocr_runs" / f"{run_id}.json"
    assert raw_path.is_file()
    payload = json.loads(raw_path.read_text(encoding="utf-8"))

    assert payload["schema"] == recognition.RAW_SCHEMA_ID
    assert payload["run_id"] == run_id
    assert payload["page_no"] == 1
    assert payload["engine_id"] == "fake"
    assert payload["params"] == {"dpi": 200, "language": "ch"}
    assert payload["line_count"] == 3
    assert [line["text"] for line in payload["lines"]] == [text for text, _, _ in FAKE_LINES]
    assert payload["lines"][0]["bbox"] == [FAKE_LEFT, 0.10, FAKE_RIGHT, 0.13]
    assert payload["engine_raw"]["note"] == "fake"
    # 分段当时的版面判断也留着：块本身入库了，判断依据不该丢
    assert payload["layout"]["block_count"] == 2
    assert payload["layout"]["column_count"] == 1
    assert payload["layout"]["reading_order_uncertain"] is False

    # 库里存的是**相对**路径：整包拷到别的机器仍然有效（说明书第 10 节）
    content = blocks_of(client, auth_headers, project_id, 1)
    assert content["active_run"]["raw_result_path"] == f"ocr_runs/{run_id}.json"


def test_recognition_survives_a_restart(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
    restart_client,
) -> None:
    """识别结果不再"刷新即丢"。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    before = blocks_of(client, auth_headers, project_id, 1)

    fresh = restart_client(library_dir)
    after = blocks_of(fresh, auth_headers, project_id, 1)

    assert after["blocks"] == before["blocks"]
    assert after["runs"] == before["runs"]
    assert after["active_run"] == before["active_run"]

    jobs = fresh.get(f"/api/projects/{project_id}/jobs", headers=auth_headers).json()
    assert jobs["count"] == 1
    assert jobs["jobs"][0]["status"] == "succeeded"
    assert jobs["active"] is None

    detail = fresh.get(
        f"/api/projects/{project_id}/jobs/{jobs['jobs'][0]['job_id']}", headers=auth_headers
    ).json()
    assert detail["items"][0]["page_no"] == 1
    assert detail["alive"] is False

    listing = fresh.get("/api/projects", headers=auth_headers).json()["projects"][0]
    assert listing["recognized_pages"] == 1


def test_page_state_before_recognition(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    page = page_state(client, auth_headers, project_id, 1)
    assert page["recognition"]["status"] == "unrecognized"
    assert page["recognition"]["block_count"] == 0
    assert page["recognition"]["run_count"] == 0


def test_blank_page_recognizes_to_zero_blocks(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, monkeypatch
) -> None:
    """空白页：识别成功但没有块，active run 照样记录下来。"""
    engine = FakeOcrEngine(lines=())
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: engine)

    def fake_start(self, directory, job_id):
        recognition.run_job(directory, job_id, engine=engine)
        return 0

    from book2text.core.project import executor as executor_module

    monkeypatch.setattr(executor_module.Supervisor, "start", fake_start)

    project_id = create_project(client, auth_headers, sample_pdf)
    data = recognize(client, auth_headers, project_id, 1).json()
    assert data["job"]["status"] == "succeeded"
    assert data["pages"][0]["recognition"]["status"] == "recognized"
    assert data["pages"][0]["recognition"]["block_count"] == 0
    assert blocks_of(client, auth_headers, project_id, 1)["blocks"] == []


# ---------------------------------------------------------------- 批量与范围

def test_batch_recognition_runs_every_page(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    """说明书 6.3 的批量识别：一次建一个任务，每页一个单元。"""
    project_id = create_project(client, auth_headers, sample_pdf)

    data = recognize(client, auth_headers, project_id, 1, 2, 3).json()
    assert data["job"]["status"] == "succeeded"
    assert data["job"]["total"] == 3
    assert data["job"]["done"] == 3
    assert [item["page_no"] for item in data["items"]] == [1, 2, 3]
    assert all(item["status"] == "succeeded" for item in data["items"])
    assert len(data["pages"]) == 3
    assert all(page["recognition"]["status"] == "recognized" for page in data["pages"])


def test_explicit_pages_skip_recognized_by_default(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    """说明书 6.3：批量识别时"已有识别结果的页面默认跳过"。

    界面上"跳过已识别的页"勾选着时就是这个行为；去掉勾选才会重新识别（走 R2）。
    """
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 2)

    data = recognize(client, auth_headers, project_id, 1, 2, 3).json()
    assert [item["page_no"] for item in data["items"]] == [1, 3], "第 2 页已识别，跳过"

    # 三页都认过了：再来一次就没什么可做，接口如实拒绝并提示原因
    again = recognize(client, auth_headers, project_id, 1, 3)
    assert again.status_code == 400
    assert "跳过" in again.json()["error"]["detail"]


def test_scope_unrecognized_skips_pages_that_already_have_results(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 2)

    data = start_scope(client, auth_headers, project_id, "unrecognized").json()
    assert [item["page_no"] for item in data["items"]] == [1, 3], "已识别的第 2 页要跳过"


def test_scope_unrecognized_includes_failed_pages(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, monkeypatch
) -> None:
    """失败页属于"还没有可用结果"，批量识别要把它带上。"""
    from book2text.core.project import executor as executor_module

    failing = FailingEngine()
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: failing)

    def fake_start(self, directory, job_id):
        recognition.run_job(directory, job_id, engine=failing)
        return 0

    monkeypatch.setattr(executor_module.Supervisor, "start", fake_start)
    project_id = create_project(client, auth_headers, sample_pdf)

    # 先制造一个失败页
    failing_first = recognize(client, auth_headers, project_id, 1).json()
    assert failing_first["job"]["status"] == "failed"

    data = start_scope(client, auth_headers, project_id, "unrecognized").json()
    assert [item["page_no"] for item in data["items"]] == [1, 2, 3]


def test_scope_all_re_recognizes_everything(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1, 2)

    data = start_scope(client, auth_headers, project_id, "all").json()
    assert [item["page_no"] for item in data["items"]] == [1, 2, 3]


def test_scope_skips_excluded_pages(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    page = page_state(client, auth_headers, project_id, 2)
    client.patch(
        f"/api/projects/{project_id}/pages/{page['page_id']}",
        json={"page_type": "body_excluded"},
        headers=auth_headers,
    )

    data = start_scope(client, auth_headers, project_id, "all").json()
    assert [item["page_no"] for item in data["items"]] == [1, 3]


def test_scope_with_nothing_to_do_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1, 2, 3)

    response = start_scope(client, auth_headers, project_id, "unrecognized")
    assert response.status_code == 400
    assert "没有需要识别的页面" in response.json()["error"]["detail"]


def test_second_job_is_refused_while_one_is_active(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs,
) -> None:
    """说明书 6.3：默认 1 个 OCR 子进程。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    # 造一个"正在进行中"的任务（不起进程）
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    jobs_module.create_job(
        library_dir / project_id,
        pages=[(pages[0]["page_id"], 1)],
        params={"dpi": 300, "language": "ch"},
    )

    response = recognize(client, auth_headers, project_id, 2)
    assert response.status_code == 400
    assert "已经有一个识别任务在进行中" in response.json()["error"]["detail"]


# ---------------------------------------------------------------- 重新识别（R2）

def test_re_recognize_replaces_blocks_when_nothing_was_reviewed(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs,
) -> None:
    """R2：没有人工成果时，新运行直接替换（旧块软删除）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    first = recognize(client, auth_headers, project_id, 1).json()
    before = blocks_of(client, auth_headers, project_id, 1)

    # 单页重新识别：界面上的"识别"按钮会显式关掉"跳过已识别"
    second = recognize(
        client, auth_headers, project_id, 1, skip_recognized=False
    ).json()
    after = blocks_of(client, auth_headers, project_id, 1)

    assert second["job"]["status"] == "succeeded"
    assert after["active_run"]["run_id"] == second["items"][0]["run_id"]
    assert after["active_run"]["run_id"] != first["items"][0]["run_id"]
    assert after["block_count"] == before["block_count"]
    assert {block["block_id"] for block in after["blocks"]}.isdisjoint(
        {block["block_id"] for block in before["blocks"]}
    ), "新运行生成的是一批新块"
    assert len(after["runs"]) == 2, "两次运行都留着"

    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT deleted_at FROM block WHERE block_id = ?",
            (before["blocks"][0]["block_id"],),
        ).fetchall()
    assert len(rows) == 1
    assert rows[0]["deleted_at"], "旧块必须留下 deleted_at 而不是被删掉"


def test_re_recognize_never_overwrites_human_work(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    inprocess_jobs,
) -> None:
    """R2 的另一半：已有人工成果时，新运行只作为**待选结果**，不碰块。

    说明书原话："系统绝不自动覆盖人工成果。"
    """
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    before = blocks_of(client, auth_headers, project_id, 1)
    simulate_human_edit(library_dir, project_id, before["blocks"][0]["block_id"])

    second = recognize(
        client, auth_headers, project_id, 1, skip_recognized=False
    ).json()
    after = blocks_of(client, auth_headers, project_id, 1)

    assert second["job"]["status"] == "succeeded"
    assert [block["block_id"] for block in after["blocks"]] == [
        block["block_id"] for block in before["blocks"]
    ], "块没被替换"
    assert after["blocks"][0]["text"].endswith("（人工改）"), "人工修改还在"
    assert after["blocks"][0]["review_status"] == "confirmed"
    assert after["blocks"][0]["modified"] is True
    assert after["active_run"]["run_id"] == before["active_run"]["run_id"], "active run 不换"

    page = page_state(client, auth_headers, project_id, 1)
    assert page["recognition"]["status"] == "has_candidate"
    assert page["recognition"]["pending_run_id"] == second["items"][0]["run_id"]
    assert len(after["runs"]) == 2


# ---------------------------------------------------------------- 失败原因可见

def test_failed_recognition_is_recorded_everywhere(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, monkeypatch
) -> None:
    """识别失败不是"500 一扔了事"：任务、单元、运行三处都留下原因。"""
    from book2text.core.project import executor as executor_module

    failing = FailingEngine(message="模拟引擎崩了")
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: failing)

    def fake_start(self, directory, job_id):
        recognition.run_job(directory, job_id, engine=failing)
        return 0

    monkeypatch.setattr(executor_module.Supervisor, "start", fake_start)
    project_id = create_project(client, auth_headers, sample_pdf)

    response = recognize(client, auth_headers, project_id, 1)
    assert response.status_code == 200, "任务失败不是 HTTP 错误：任务是建成了的"
    data = response.json()

    assert data["job"]["status"] == "failed"
    assert data["job"]["failed"] == 1
    assert data["job"]["done"] == 0
    assert "模拟引擎崩了" in data["items"][0]["error_message"]
    assert data["failed_items"][0]["page_no"] == 1

    page = data["pages"][0]["recognition"]
    assert page["status"] == "failed"
    assert "模拟引擎崩了" in page["last_error"]
    assert page["active_run_id"] is None
    assert page["block_count"] == 0

    content = blocks_of(client, auth_headers, project_id, 1)
    assert content["blocks"] == []
    failed_run = content["runs"][0]
    assert failed_run["status"] == "failed"
    assert failed_run["error_code"] == "ocr_failed"
    assert failed_run["raw_result_path"] is None, "失败的运行不写原始输出"


def test_failed_pages_can_be_retried_without_duplicating_blocks(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    monkeypatch,
) -> None:
    """Phase 2 的验收："重试不产生重复块"。

    第一次有一页失败、另一页成功；重试失败页之后：失败的那页有了块，
    成功的那页**一个块都没多**（它的单元是 succeeded，重试不碰它）。
    """
    from book2text.core.project import executor as executor_module

    flaky = FlakyEngine()
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: flaky)

    def fake_start(self, directory, job_id):
        recognition.run_job(directory, job_id, engine=flaky)
        return 0

    monkeypatch.setattr(executor_module.Supervisor, "start", fake_start)
    project_id = create_project(client, auth_headers, sample_pdf)

    first = recognize(client, auth_headers, project_id, 1, 2).json()
    assert first["job"]["failed"] == 1, first["items"]
    failed_page = next(i["page_no"] for i in first["items"] if i["status"] == "failed")
    ok_page = next(i["page_no"] for i in first["items"] if i["status"] == "succeeded")
    blocks_before = blocks_of(client, auth_headers, project_id, ok_page)["blocks"]

    retried = client.post(
        f"/api/projects/{project_id}/jobs/{first['job']['job_id']}/retry-failed",
        headers=auth_headers,
    )
    assert retried.status_code == 200, retried.text
    assert retried.json()["retried"] == 1
    assert retried.json()["job"]["status"] == "succeeded"

    after_failed = blocks_of(client, auth_headers, project_id, failed_page)
    assert after_failed["block_count"] == 2, "失败的那页现在有块了"
    assert len(after_failed["runs"]) == 2, "两次运行（一次失败一次成功）都在"
    assert [run["status"] for run in after_failed["runs"]] == ["succeeded", "failed"]

    after_ok = blocks_of(client, auth_headers, project_id, ok_page)
    assert after_ok["blocks"] == blocks_before, "成功的那页一个块都没多、也没变"
    assert len(after_ok["runs"]) == 1


def test_render_failure_is_recorded(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, monkeypatch
) -> None:
    from book2text.core.pdf import render
    from book2text.core.project import executor as executor_module

    def boom(*args, **kwargs):
        raise render.PdfError("模拟渲染失败")

    monkeypatch.setattr(recognition.render, "render_page_image", boom)
    engine = FakeOcrEngine()
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: engine)

    def fake_start(self, directory, job_id):
        recognition.run_job(directory, job_id, engine=engine)
        return 0

    monkeypatch.setattr(executor_module.Supervisor, "start", fake_start)
    project_id = create_project(client, auth_headers, sample_pdf)

    data = recognize(client, auth_headers, project_id, 1).json()
    assert data["job"]["status"] == "failed"
    run = blocks_of(client, auth_headers, project_id, 1)["runs"][0]
    assert run["error_code"] == "render_failed"
    assert engine.calls == 0, "渲染都没成功，不该去调引擎"


def test_unavailable_engine_is_a_capability_error_not_a_page_error(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, monkeypatch
) -> None:
    engine = FakeOcrEngine(available=False, reason="未安装 Python 包 rapidocr")
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: engine)
    project_id = create_project(client, auth_headers, sample_pdf)

    response = recognize(client, auth_headers, project_id, 1)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "ocr_engine_unavailable"
    # 引擎不可用是环境问题，不该在项目里留下一个注定失败的任务
    assert client.get(f"/api/projects/{project_id}/jobs", headers=auth_headers).json()["count"] == 0
    assert blocks_of(client, auth_headers, project_id, 1)["runs"] == []


# ---------------------------------------------------------------- 中断恢复

def test_running_job_is_marked_interrupted_when_opening_the_project(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    """说明书 5.3：状态仍为 running 的任务要改成 interrupted。

    模拟"识别到一半应用被强杀"：库里留下 running 的任务、running 的单元与运行记录。
    重新打开项目时，这些残留要被结算——而且**本进程正在跑的任务不受影响**。
    """
    project_id = create_project(client, auth_headers, sample_pdf)
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    directory = library_dir / project_id

    job = jobs_module.create_job(
        directory,
        pages=[(pages[0]["page_id"], 1)],
        params={"dpi": 300, "language": "ch"},
    )
    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_RUNNING)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'running' WHERE job_id = ?", (job.job_id,)
        )
        run_id = "01RUNRUNRUNRUNRUNRUNRUNRUN"
        conn.execute(
            """
            INSERT INTO ocr_run (run_id, page_id, run_type, engine_id, engine_version,
                                 params_json, status, created_at)
            VALUES (?, ?, 'primary', 'fake', 'fake-0.1', '{}', 'running', '2026-01-01T00:00:00+00:00')
            """,
            (run_id, pages[0]["page_id"]),
        )
        conn.execute(
            "UPDATE job_item SET run_id = ? WHERE job_id = ?", (run_id, job.job_id)
        )
        conn.commit()

    opened = client.post(f"/api/projects/{project_id}/open", headers=auth_headers).json()
    assert opened["interrupted"] == 1
    assert "中断" in opened["warning"]

    assert client.get(
        f"/api/projects/{project_id}/jobs/{job.job_id}", headers=auth_headers
    ).json()["job"]["status"] == "interrupted"
    assert client.get(
        f"/api/projects/{project_id}/jobs/{job.job_id}", headers=auth_headers
    ).json()["items"][0]["status"] == "failed"
    run = blocks_of(client, auth_headers, project_id, 1)["runs"][0]
    assert run["status"] == "failed"
    assert run["error_code"] == "interrupted"


def test_running_run_shows_as_in_progress(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    """识别中/排队中的状态也由记录推导（说明书 5.3 的状态清单）。"""
    from book2text.core.storage.ulid import new_ulid

    project_id = create_project(client, auth_headers, sample_pdf)
    page = page_state(client, auth_headers, project_id, 1)

    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO ocr_run (run_id, page_id, run_type, engine_id, engine_version,
                                 params_json, status, created_at)
            VALUES (?, ?, 'primary', 'fake', 'fake-0.1', '{}', 'running', '2026-01-01T00:00:00+00:00')
            """,
            (new_ulid(), page["page_id"]),
        )
        conn.commit()

    assert page_state(client, auth_headers, project_id, 1)["recognition"]["status"] == "running"

    # 任务里的排队单元同样让页面显示"排队中"
    directory = library_dir / project_id
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE ocr_run SET status = 'failed', error_code = 'x' WHERE status = 'running'"
        )
        conn.commit()
    jobs = jobs_module.create_job(
        directory, pages=[(page["page_id"], 1)], params={"dpi": 300, "language": "ch"}
    )
    assert page_state(client, auth_headers, project_id, 1)["recognition"]["status"] == "queued"

    jobs_module.set_status(directory, jobs.job_id, jobs_module.STATUS_RUNNING)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute("UPDATE job_item SET status = 'running' WHERE job_id = ?", (jobs.job_id,))
        conn.commit()
    assert page_state(client, auth_headers, project_id, 1)["recognition"]["status"] == "running"


# ---------------------------------------------------------------- 参数与边界

def test_no_pages_and_no_scope_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr", json={}, headers=auth_headers
    )
    assert response.status_code == 400
    assert "必须给出且只给出一个" in response.json()["error"]["detail"]


def test_pages_and_scope_together_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "scope": "all"},
        headers=auth_headers,
    )
    assert response.status_code == 400


def test_unknown_page_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = recognize(client, auth_headers, project_id, 99)
    assert response.status_code == 400
    assert "没有第 99 页" in response.json()["error"]["detail"]


def test_excluded_page_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    """界面上的说明是"排除的页不参与识别"，接口必须当真。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    page = page_state(client, auth_headers, project_id, 1)
    client.patch(
        f"/api/projects/{project_id}/pages/{page['page_id']}",
        json={"page_type": "body_excluded"},
        headers=auth_headers,
    )

    response = recognize(client, auth_headers, project_id, 1)
    assert response.status_code == 400
    assert "不是「正文」类型" in response.json()["error"]["detail"]
    assert inprocess_jobs.calls == 0


def test_absurd_dpi_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "dpi": 5000},
        headers=auth_headers,
    )
    assert response.status_code == 422


def test_recognition_requires_token(client: TestClient, sample_pdf: Path) -> None:
    response = client.post("/api/projects/b2t_ZZZZZZ/jobs/ocr", json={"pages": [1]})
    assert response.status_code == 401


def test_unknown_project_returns_404(
    client: TestClient, auth_headers: dict[str, str], inprocess_jobs
) -> None:
    response = recognize(client, auth_headers, "b2t_ZZZZZZ", 1)
    assert response.status_code == 404
