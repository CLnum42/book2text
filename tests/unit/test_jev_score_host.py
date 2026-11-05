"""打分层并进主进程的单元测试（2026-11-05 第 2 笔）。

只验三件事：uvicorn 线程能不能起停、第 3 步的判据严不严（prob_1 必须 0–1 的数）、
起不来时原因能不能传到调用方。**真实的打分层**（vendor/jev_score）由真机验收覆盖——
那需要真模型与真引擎，不适合放进单元测试。
"""

from __future__ import annotations

import socket
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI, HTTPException

from book2text.core.project import jev_score_host as host_module
from book2text.core.project.jev_score_host import ScoreHost, probe_image_bytes


def _app_with(payload: dict | None = None, *, status: int = 200) -> FastAPI:
    app = FastAPI()

    @app.post("/v1/score")
    def score(_body: dict) -> dict:
        if status != 200:
            raise HTTPException(status_code=status, detail="引擎还没热")
        return payload if payload is not None else {"results": [{"prob_1": 0.42}]}

    return app


def _failing_app(message: str) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        raise RuntimeError(message)
        yield  # pragma: no cover

    return FastAPI(lifespan=lifespan)


def _port_listening(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


@pytest.fixture
def host():
    instance = ScoreHost(app_factory=lambda _engine: _app_with(), startup_timeout=20.0)
    yield instance
    instance.stop()


# ---------------------------------------------------------------- 起停


def test_start_then_probe_returns_probability(host: ScoreHost) -> None:
    started = host.start(12345)

    assert started.ok is True, started.detail
    assert host.running is True
    assert _port_listening(host.port)

    check = host.probe()

    assert check.ok is True, check.detail
    assert check.step == 3
    assert check.prob_1 == pytest.approx(0.42)


def test_start_is_idempotent_for_same_engine_port(host: ScoreHost) -> None:
    first = host.start(12345)
    port = host.port
    second = host.start(12345)

    assert first.ok and second.ok
    assert second.port == port, "引擎端口没变就不要再起一个打分层"


def test_stop_closes_the_port_and_probe_says_not_running(host: ScoreHost) -> None:
    host.start(12345)
    port = host.port

    host.stop()

    assert host.running is False
    assert not _port_listening(port)
    check = host.probe()
    assert check.ok is False and check.step == 3
    assert "没在跑" in check.detail


def test_startup_failure_detail_reaches_caller() -> None:
    instance = ScoreHost(
        app_factory=lambda _engine: _failing_app("refusing to start: engine does not answer"),
        startup_timeout=20.0,
    )
    try:
        check = instance.start(12345)
    finally:
        instance.stop()

    assert check.ok is False
    assert check.step == 3, "打分层起不来 = 第 3 步失败，不是第 1/2 步"
    assert "refusing to start" in check.detail
    assert "自检没过" in check.detail


# ---------------------------------------------------------------- 第 3 步的判据


def test_probability_out_of_range_fails() -> None:
    instance = ScoreHost(app_factory=lambda _engine: _app_with({"results": [{"prob_1": 1.5}]}))
    try:
        check = instance.check(12345)
    finally:
        instance.stop()

    assert check.ok is False
    assert "越界" in check.detail


def test_missing_results_fails() -> None:
    instance = ScoreHost(app_factory=lambda _engine: _app_with({"results": []}))
    try:
        check = instance.check(12345)
    finally:
        instance.stop()

    assert check.ok is False
    assert "没有 results" in check.detail


def test_non_numeric_probability_fails() -> None:
    instance = ScoreHost(app_factory=lambda _engine: _app_with({"results": [{"prob_1": "高"}]}))
    try:
        check = instance.check(12345)
    finally:
        instance.stop()

    assert check.ok is False
    assert "不是数" in check.detail


def test_http_error_body_is_reported() -> None:
    instance = ScoreHost(app_factory=lambda _engine: _app_with(status=500))
    try:
        check = instance.check(12345)
    finally:
        instance.stop()

    assert check.ok is False
    assert "500" in check.detail


def test_fixture_is_a_real_64x64_png() -> None:
    payload = probe_image_bytes()

    assert payload[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(payload) < 4096, "fixture 必须小：它每次自检都要过一遍网络与模型"
    # IHDR 紧跟签名：宽高各 4 字节（大端）
    width = int.from_bytes(payload[16:20], "big")
    height = int.from_bytes(payload[20:24], "big")
    assert (width, height) == (64, 64), f"fixture 尺寸应为 64×64，实际 {width}×{height}"


def test_default_factory_points_at_the_vendored_layer(monkeypatch: pytest.MonkeyPatch) -> None:
    """默认工厂必须用随包内置的那份配置，且后端地址跟着引擎端口走。"""
    import os

    captured: dict[str, str] = {}

    class _FakeApp:
        pass

    def fake_create_app() -> object:
        captured["config"] = os.environ.get("JEV_BACKEND_CONFIG", "")
        captured["url"] = os.environ.get("JEV_BACKEND_URL", "")
        return _FakeApp()

    monkeypatch.setattr("book2text.vendor.jev_score.server.create_app", fake_create_app)
    factory = host_module._default_app_factory(60.0)
    factory(54321)

    assert captured["config"].endswith("vendor/jev_score/backends/llamacpp.yaml")
    assert captured["url"] == "http://127.0.0.1:54321"
