"""Jev 排序接口：探测 / 拒绝建任务 / 清除（2026-11-05）。

真引擎那条（llama.cpp + 打分服务 + 40 页项目）不在自动化里——它要 2.7 GB 模型和常驻服务。
这里锁的是"环境不齐时**不建任务**、队列不动"与"清除幂等"。
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import jobs as jobs_module
from book2text.core.storage import db as db_module


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "Jev 测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def test_ready_reports_missing_environment(client: TestClient, auth_headers: dict[str, str], sample_pdf: Path) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)

    data = client.get(f"/api/projects/{project_id}/jev-priority/ready", headers=auth_headers).json()

    assert data["ready"] is False
    assert data["problems"], "环境不齐时必须说清缺什么"
    assert data["scored"] == 0


def test_start_refuses_without_engine_and_creates_no_job(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)

    response = client.post(f"/api/projects/{project_id}/jev-priority/start", headers=auth_headers)

    assert response.status_code == 503, response.text
    assert response.json()["error"]["code"] == "jev_unavailable"
    # 队列不动：一个任务都没建
    assert jobs_module.list_jobs(library_dir / project_id, limit=10) == []


def test_clear_is_idempotent_and_writes_event_only_when_clearing(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)

    first = client.post(f"/api/projects/{project_id}/jev-priority/clear", headers=auth_headers)
    assert first.status_code == 200
    assert first.json()["cleared"] == 0

    # 手工写一个分数再清：应当清掉并留下一条 event
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        page = conn.execute("SELECT page_id FROM page LIMIT 1").fetchone()["page_id"]
        conn.execute(
            "INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,"
            " ocr_text, text, include, continues_to_next, created_at, updated_at)"
            " VALUES ('b1', ?, 'ocr', 0, '[0.1,0.1,0.9,0.2]', 'paragraph', '甲', '甲', 1, 0,"
            " '2026-01-01', '2026-01-01')",
            (page,),
        )
        conn.execute(
            "INSERT INTO block_line (line_id, block_id, line_index, bbox, text, jev_score)"
            " VALUES ('l1', 'b1', 0, '[0.1,0.1,0.9,0.2]', '甲', 0.02)"
        )
        conn.commit()

    second = client.post(f"/api/projects/{project_id}/jev-priority/clear", headers=auth_headers)

    assert second.status_code == 200
    assert second.json()["cleared"] == 1
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM block_line WHERE jev_score IS NOT NULL").fetchone()["n"] == 0
        event = conn.execute(
            "SELECT action FROM event WHERE action = 'jev_priority_cleared'"
        ).fetchone()
    assert event is not None


# ---------------------------------------------------------------- 四步机检（2026-11-05 第 3 笔）


class _FakeRuntime:
    """把"引擎 + 打分层"换成一个只会回话的替身：接口形状与幂等性不需要真模型。"""

    def __init__(self, *, ok: bool = True, step: int = 4, detail: str = "") -> None:
        self.ensure_calls = 0
        self.check_calls = 0
        self.stop_calls = 0
        self._ok = ok
        self._step = step
        self._detail = detail

    def _verdict(self):
        from book2text.core.project.jev_health import JevVerdict

        return JevVerdict(
            ok=self._ok,
            step=self._step,
            detail=self._detail,
            pid=4242 if self._ok else None,
            engine_port=41000 if self._ok else None,
            score_port=5001 if self._ok else None,
            prob_1=0.25 if self._ok else None,
        )

    def check(self):
        self.check_calls += 1
        return self._verdict()

    def ensure(self):
        self.ensure_calls += 1
        return self._verdict()

    def stop(self):
        self.stop_calls += 1


def _fake_model_pack(tmp_path: Path) -> Path:
    """小号模型包：让这条集成测试不依赖本机私域里那 2.68 GB。"""
    import hashlib
    import json

    pack = tmp_path / "pack"
    pack.mkdir(parents=True, exist_ok=True)
    files = []
    for name, role in (("model.gguf", "model"), ("mmproj.gguf", "mmproj")):
        payload = f"fake-{name}".encode()
        (pack / name).write_bytes(payload)
        files.append(
            {"name": name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(), "role": role}
        )
    (pack / "manifest.json").write_text(json.dumps({"kind": "jev-model-pack", "files": files}), encoding="utf-8")
    return pack


def test_ready_reports_which_step_fails(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, tmp_path: Path
) -> None:
    """引擎没起时 `/ready` 必须说"第 1 步"，而不是一句含糊的"环境不齐"。"""
    from book2text.core.project.jev_health import JevRuntime

    project_id = create_project(client, auth_headers, sample_pdf)
    client.app.state.jev_runtime = JevRuntime(model_dir=_fake_model_pack(tmp_path))

    data = client.get(f"/api/projects/{project_id}/jev-priority/ready", headers=auth_headers).json()

    assert data["ok"] is False
    assert data["step"] == 1
    assert data["step_label"] == "引擎进程"
    assert "引擎没起" in data["detail"]
    assert data["ready"] is False and data["problems"], "老键要保留，界面不用同时改两处"


def test_ready_lights_up_at_step4_with_stub_runtime(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    client.app.state.jev_runtime = _FakeRuntime()

    data = client.get(f"/api/projects/{project_id}/jev-priority/ready", headers=auth_headers).json()

    assert data["ok"] is True and data["step"] == 4
    assert data["ready"] is True and data["problems"] == []
    assert data["prob_1"] == 0.25, "第 3 步的分要带出来（界面用它说明真的出分了）"


def test_engine_start_is_idempotent_over_http(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    fake = _FakeRuntime()
    client.app.state.jev_runtime = fake

    first = client.post(f"/api/projects/{project_id}/jev-priority/engine/start", headers=auth_headers)
    second = client.post(f"/api/projects/{project_id}/jev-priority/engine/start", headers=auth_headers)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["ok"] is True and second.json()["ok"] is True
    assert fake.ensure_calls == 2, "两次都走 ensure；真实现里第二次不会再 spawn（见单元测试）"


def test_ready_after_engine_start_reports_probability(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    project_id = create_project(client, auth_headers, sample_pdf)
    client.app.state.jev_runtime = _FakeRuntime()

    started = client.post(f"/api/projects/{project_id}/jev-priority/engine/start", headers=auth_headers).json()
    then = client.get(f"/api/projects/{project_id}/jev-priority/ready", headers=auth_headers).json()

    assert started["step"] == 4 and then["step"] == 4
    assert started["prob_1"] == then["prob_1"] == 0.25


def test_ready_carries_score_host_failure_at_step3(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    """引擎 ok、打分层起不来 ⇒ `/ready` 必须停在 step 3，且 detail 带着引擎原话。

    这条防的是"信息被换成一句概括"：真实故障里唯一能照做的线索就是那句 `--mmproj`。
    """
    from fastapi import FastAPI

    from book2text.core.project.jev_engine import EngineCheck
    from book2text.core.project.jev_health import JevRuntime
    from book2text.core.project.jev_score_host import ScoreHost

    engine_message = (
        "refusing to start: the engine does not assemble the prompt this checkpoint was trained on.\n"
        'the engine could not score the startup probe: backend HTTP 501: {"error": '
        '"start it with `--mmproj`"}'
    )

    def failing_app(_port: int) -> FastAPI:
        @asynccontextmanager
        async def lifespan(_app: FastAPI):
            raise RuntimeError(engine_message)
            yield  # pragma: no cover

        return FastAPI(lifespan=lifespan)

    class _Engine:
        def check(self):
            return EngineCheck(ok=True, step=2, pid=4242, port=41000)

        def ensure(self):
            return self.check()

        def stop(self) -> None:
            pass

    project_id = create_project(client, auth_headers, sample_pdf)
    runtime = JevRuntime(engine=_Engine(), host=ScoreHost(app_factory=failing_app, startup_timeout=20))
    try:
        ensured = runtime.ensure()          # 起打分层 → 失败，failure 记下引擎原话
        client.app.state.jev_runtime = runtime
        data = client.get(f"/api/projects/{project_id}/jev-priority/ready", headers=auth_headers).json()
    finally:
        runtime.stop()

    assert ensured.step == 3 and "501" in ensured.detail
    assert data["ok"] is False
    assert data["step"] == 3, "引擎 ok、打分层起不来 ⇒ 第 3 步（不是第 2 步）"
    assert "--mmproj" in data["detail"], "可照做的线索必须原样带到 /ready"
    assert "没在跑" not in data["detail"], "不许被概括成一句误导"
