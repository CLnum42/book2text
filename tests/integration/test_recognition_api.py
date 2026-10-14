"""识别落库的集成测试（说明书 Phase 2 的开头：识别接到项目上）。

**用假引擎。** 这条链路要验证的是"识别 → 落库 → 重启还在"、R1 / R2 两条业务规则、
失败原因可见、原始输出落盘——这些都与"认得多准"无关，用假引擎能把它们跑得又快又确定。
真实引擎的端到端验证在 `test_recognition_engine.py`（需要 ocr 依赖，未装则跳过）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.api.app import create_app
from book2text.core.ocr.base import BBox, OcrEngineError, OcrLine, OcrParams, OcrResult
from book2text.core.project import recognition
from book2text.core.storage import db as db_module
from tests.conftest import TEST_ORIGIN, TEST_TOKEN

# 三行文本，第二段与前一段之间留出明显行距 → 分段规则应切成 2 块
FAKE_LINES = (
    ("第一段第一行。", 0.10, 0.13),
    ("第一段第二行。", 0.14, 0.17),
    ("第二段第一行。", 0.26, 0.29),
)
FAKE_LEFT, FAKE_RIGHT = 0.10, 0.90


class FakeOcrEngine:
    """假引擎：不加载模型、不看图像内容，按固定坐标返回几行。

    只实现 `core.ocr.base.OcrEngine` 协议要求的方法。
    """

    engine_id = "fake"
    version_string = "fake-0.1"

    def __init__(
        self,
        *,
        lines: tuple[tuple[str, float, float], ...] = FAKE_LINES,
        fail_message: str | None = None,
        available: bool = True,
        reason: str = "",
    ) -> None:
        self._lines = lines
        self._fail_message = fail_message
        self._available = available
        self._reason = reason
        self.calls = 0

    def version(self) -> str:
        return self.version_string

    def available(self) -> tuple[bool, str]:
        return (True, "") if self._available else (False, self._reason)

    def supported_languages(self) -> list[str]:
        return ["ch", "en"]

    def recognize(self, image, params: OcrParams) -> OcrResult:
        self.calls += 1
        if self._fail_message:
            raise OcrEngineError(self._fail_message)
        width, height = image.size
        lines = tuple(
            OcrLine(
                text=text,
                bbox=BBox(FAKE_LEFT, y0, FAKE_RIGHT, y1),
                confidence=0.95,
            )
            for text, y0, y1 in self._lines
        )
        return OcrResult(
            engine_id=self.engine_id,
            engine_version=self.version_string,
            lines=lines,
            image_width=width,
            image_height=height,
            elapsed_seconds=0.012,
            raw={"note": "fake", "line_count": len(lines)},
        )


@pytest.fixture
def fake_engine(monkeypatch: pytest.MonkeyPatch) -> FakeOcrEngine:
    """把生产代码里的 RapidOCR 换成假引擎（走同一条落库路径）。"""
    engine = FakeOcrEngine()
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: engine)
    return engine


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


def recognize(client: TestClient, headers: dict[str, str], project_id: str, *pages: int):
    return client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": list(pages)},
        headers=headers,
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
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, fake_engine: FakeOcrEngine
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

    item = data["items"][0]
    assert item["status"] == "succeeded"
    assert item["page_no"] == 1
    assert item["run_id"]

    page = data["pages"][0]
    assert page["recognition"]["status"] == "recognized"
    assert page["recognition"]["active_run_id"] == item["run_id"]
    assert page["recognition"]["block_count"] == 2, "三行两段应切成 2 块"
    assert page["recognition"]["last_error"] is None

    # 块与行都落库了，文本与坐标可核对
    content = blocks_of(client, auth_headers, project_id, 1)
    assert content["block_count"] == 2
    assert content["active_run"]["run_id"] == item["run_id"]
    assert content["active_run"]["engine_id"] == "fake"
    assert content["active_run"]["status"] == "succeeded"
    assert content["active_run"]["elapsed_seconds"] > 0

    first, second = content["blocks"]
    assert first["text"] == "第一段第一行。\n第一段第二行。", "块文本保留行内换行（说明书 5.3）"
    assert first["ocr_text"] == first["text"], "刚识别出来的块，ocr_text 与 text 相同"
    assert first["review_status"] == "unreviewed"
    assert first["origin"] == "ocr"
    assert first["origin_run_id"] == item["run_id"]
    assert first["revision"] == 0
    assert first["include"] is True
    assert first["continues_to_next"] is False
    assert first["modified"] is False
    assert first["order_index"] == 0
    assert second["order_index"] == 1
    assert second["text"] == "第二段第一行。"

    assert [line["line_index"] for line in first["lines"]] == [0, 1]
    assert [line["text"] for line in first["lines"]] == ["第一段第一行。", "第一段第二行。"]
    for block in content["blocks"]:
        for key in ("bbox",):
            box = block[key]
            assert len(box) == 4
            assert all(0.0 <= value <= 1.0 for value in box), f"坐标越界：{box}"
            assert box[2] > box[0] and box[3] > box[1]
        for line in block["lines"]:
            assert len(line["bbox"]) == 4
            assert line["aux_text"] is None
            assert line["diff_status"] is None


def test_recognize_writes_the_raw_engine_output(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    fake_engine: FakeOcrEngine,
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
    assert payload["engine_version"] == "fake-0.1"
    assert payload["params"] == {"dpi": 300, "language": "ch"}
    assert payload["image_width"] > 0 and payload["image_height"] > 0
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
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    fake_engine: FakeOcrEngine, restart_client,
) -> None:
    """这一条是本阶段的重点：识别结果不再"刷新即丢"。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    before = blocks_of(client, auth_headers, project_id, 1)

    fresh = restart_client(library_dir)
    after = blocks_of(fresh, auth_headers, project_id, 1)

    assert after["blocks"] == before["blocks"]
    assert after["runs"] == before["runs"]
    assert after["active_run"] == before["active_run"]

    # 任务记录也在
    jobs = fresh.get(f"/api/projects/{project_id}/jobs", headers=auth_headers).json()
    assert jobs["count"] == 1
    assert jobs["jobs"][0]["status"] == "succeeded"

    detail = fresh.get(
        f"/api/projects/{project_id}/jobs/{jobs['jobs'][0]['job_id']}", headers=auth_headers
    ).json()
    assert detail["items"][0]["page_no"] == 1
    assert detail["items"][0]["run_id"]

    # 项目库里的"已识别"计数也跟着留下来
    listing = fresh.get("/api/projects", headers=auth_headers).json()["projects"][0]
    assert listing["recognized_pages"] == 1


def test_page_state_before_recognition(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, fake_engine
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
    project_id = create_project(client, auth_headers, sample_pdf)

    data = recognize(client, auth_headers, project_id, 1).json()
    assert data["job"]["status"] == "succeeded"
    assert data["pages"][0]["recognition"]["status"] == "recognized"
    assert data["pages"][0]["recognition"]["block_count"] == 0
    assert blocks_of(client, auth_headers, project_id, 1)["blocks"] == []


# ---------------------------------------------------------------- 重新识别（R2）

def test_re_recognize_replaces_blocks_when_nothing_was_reviewed(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    fake_engine: FakeOcrEngine,
) -> None:
    """R2：没有人工成果时，新运行直接替换（旧块软删除）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    first = recognize(client, auth_headers, project_id, 1).json()
    before = blocks_of(client, auth_headers, project_id, 1)

    second = recognize(client, auth_headers, project_id, 1).json()
    after = blocks_of(client, auth_headers, project_id, 1)

    assert second["job"]["status"] == "succeeded"
    assert after["active_run"]["run_id"] == second["items"][0]["run_id"]
    assert after["active_run"]["run_id"] != first["items"][0]["run_id"]
    assert after["block_count"] == before["block_count"], "块数不变"
    assert {block["block_id"] for block in after["blocks"]}.isdisjoint(
        {block["block_id"] for block in before["blocks"]}
    ), "新运行生成的是一批新块"
    assert len(after["runs"]) == 2, "两次运行都留着"

    # 旧块是**软删除**：还在库里，只是不再是当前块（说明书 5.1）
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT deleted_at FROM block WHERE block_id = ?",
            (before["blocks"][0]["block_id"],),
        ).fetchall()
    assert len(rows) == 1
    assert rows[0]["deleted_at"], "旧块必须留下 deleted_at 而不是被删掉"


def test_re_recognize_never_overwrites_human_work(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    fake_engine: FakeOcrEngine,
) -> None:
    """R2 的另一半：已有人工成果时，新运行只作为**待选结果**，不碰块。

    说明书原话："系统绝不自动覆盖人工成果。"
    """
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    before = blocks_of(client, auth_headers, project_id, 1)
    simulate_human_edit(library_dir, project_id, before["blocks"][0]["block_id"])

    second = recognize(client, auth_headers, project_id, 1).json()
    after = blocks_of(client, auth_headers, project_id, 1)

    assert second["job"]["status"] == "succeeded"
    assert [block["block_id"] for block in after["blocks"]] == [
        block["block_id"] for block in before["blocks"]
    ], "块没被替换"
    assert after["blocks"][0]["text"].endswith("（人工改）"), "人工修改还在"
    assert after["blocks"][0]["review_status"] == "confirmed"
    assert after["blocks"][0]["modified"] is True
    assert after["active_run"]["run_id"] == before["active_run"]["run_id"], "active run 不换"

    # 新结果被记为"待选"
    page = page_state(client, auth_headers, project_id, 1)
    assert page["recognition"]["status"] == "has_candidate"
    assert page["recognition"]["pending_run_id"] == second["items"][0]["run_id"]
    assert page["recognition"]["active_run_id"] == before["active_run"]["run_id"]
    assert len(after["runs"]) == 2


# ---------------------------------------------------------------- 失败原因可见

def test_failed_recognition_is_recorded_everywhere(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, monkeypatch
) -> None:
    """识别失败不是"500 一扔了事"：任务、单元、运行三处都留下原因。"""
    engine = FakeOcrEngine(fail_message="模拟引擎崩了")
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: engine)
    project_id = create_project(client, auth_headers, sample_pdf)

    response = recognize(client, auth_headers, project_id, 1)
    assert response.status_code == 200, "任务失败不是 HTTP 错误：任务是建成了的"
    data = response.json()

    assert data["job"]["status"] == "failed"
    assert data["job"]["failed"] == 1
    assert data["job"]["done"] == 0
    assert "模拟引擎崩了" in data["items"][0]["error_message"]

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
    assert "模拟引擎崩了" in failed_run["error_message"]
    assert failed_run["raw_result_path"] is None, "失败的运行不写原始输出"


def test_render_failure_is_recorded(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, monkeypatch
) -> None:
    from book2text.core.pdf import render

    def boom(*args, **kwargs):
        raise render.PdfError("模拟渲染失败")

    monkeypatch.setattr(recognition.render, "render_page_image", boom)
    engine = FakeOcrEngine()
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: engine)
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
    # 引擎不可用是环境问题，不该在项目里留下一条"第 1 页识别失败"的运行
    assert blocks_of(client, auth_headers, project_id, 1)["runs"] == []
    assert client.get(f"/api/projects/{project_id}/jobs", headers=auth_headers).json()["count"] == 0


# ---------------------------------------------------------------- 中断恢复

def test_interrupted_job_is_marked_when_reopening_the_project(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    monkeypatch,
) -> None:
    """说明书 5.3：状态仍为 running 的任务要改成 interrupted。

    这里模拟"识别到一半应用被强杀"：让引擎抛 KeyboardInterrupt（不是 Exception，
    应用里的错误处理不拦它）——识别进程就此消失，数据库里留下 running 的任务与运行。
    """
    class InterruptingEngine(FakeOcrEngine):
        def recognize(self, image, params):
            super().recognize(image, params)
            raise KeyboardInterrupt("模拟应用被关闭")

    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: InterruptingEngine())
    project_id = create_project(client, auth_headers, sample_pdf)

    with pytest.raises(KeyboardInterrupt):
        recognition.recognize_pages(project_id, [1], library=library_dir)

    jobs = client.get(f"/api/projects/{project_id}/jobs", headers=auth_headers).json()["jobs"]
    assert jobs[0]["status"] == "running", "强杀时任务停在 running"

    fresh = TestClient(
        create_app(session_token=TEST_TOKEN, origins=[TEST_ORIGIN], library_dir=library_dir)
    )
    opened = fresh.post(f"/api/projects/{project_id}/open", headers=auth_headers).json()
    assert opened["interrupted"] == 1
    assert "中断" in opened["warning"]

    assert fresh.get(f"/api/projects/{project_id}/jobs", headers=auth_headers).json()["jobs"][0][
        "status"
    ] == "interrupted"
    run = fresh.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["runs"][0]
    assert run["status"] == "failed"
    assert run["error_code"] == "interrupted"


def test_running_run_shows_as_in_progress(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    fake_engine: FakeOcrEngine,
) -> None:
    """识别中/排队中的状态也由 run 推导（说明书 5.3 的状态清单）。"""
    from book2text.core.storage.ulid import new_ulid

    project_id = create_project(client, auth_headers, sample_pdf)
    page_id = page_state(client, auth_headers, project_id, 1)["page_id"]

    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO ocr_run (run_id, page_id, run_type, engine_id, engine_version,
                                 params_json, status, created_at)
            VALUES (?, ?, 'primary', 'fake', 'fake-0.1', '{}', 'running', '2026-01-01T00:00:00+00:00')
            """,
            (new_ulid(), page_id),
        )
        conn.commit()

    assert page_state(client, auth_headers, project_id, 1)["recognition"]["status"] == "running"


# ---------------------------------------------------------------- 参数与边界

def test_batch_request_is_refused_with_a_reason(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, fake_engine
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = recognize(client, auth_headers, project_id, 1, 2)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "batch_not_implemented"
    assert "执行器" in error["detail"]


def test_empty_page_list_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, fake_engine
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = recognize(client, auth_headers, project_id)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "no_pages"


def test_unknown_page_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, fake_engine
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    response = recognize(client, auth_headers, project_id, 99)
    assert response.status_code == 400
    assert "没有第 99 页" in response.json()["error"]["detail"]


def test_excluded_page_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, fake_engine
) -> None:
    """界面上的说明是"排除的页不参与识别"，接口必须当真。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    page = page_state(client, auth_headers, project_id, 1)
    client.patch(
        f"/api/projects/{project_id}/pages/{page['page_id']}",
        json={"include": False},
        headers=auth_headers,
    )

    response = recognize(client, auth_headers, project_id, 1)
    assert response.status_code == 400
    assert "已排除" in response.json()["error"]["detail"]
    assert fake_engine.calls == 0


def test_absurd_dpi_is_refused(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, fake_engine
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
    client: TestClient, auth_headers: dict[str, str], fake_engine
) -> None:
    response = recognize(client, auth_headers, "b2t_ZZZZZZ", 1)
    assert response.status_code == 404
