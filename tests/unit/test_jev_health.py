"""Jev 四步检查（`jev_health`）的单元测试（2026-11-05 第 3 笔）。

锁三件事：**第几步失败**要准（1 进程 / 2 引擎答 / 3 真打分 / 4 可用）、`ensure()` 要幂等、
`check_urls()` 与运行时那条走同一套判据。真实引擎与真实模型由真机验收覆盖。
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from book2text.core.project import jev_engine as engine_module
from book2text.core.project import jev_health as health_module
from book2text.core.project.jev_score_host import ScoreCheck


class FakeEngine:
    """只记调用、按脚本回话；不 spawn 任何东西。"""

    def __init__(self, check: engine_module.EngineCheck, ensure: engine_module.EngineCheck | None = None):
        self._check = check
        self._ensure = ensure or check
        self.check_calls = 0
        self.ensure_calls = 0
        self.stop_calls = 0
        self.ensured_port = None

    def check(self):
        self.check_calls += 1
        # 起过之后 check() 看到的是起之后的状态（真实引擎也是这样）
        return self._ensure if self.ensure_calls else self._check

    def ensure(self):
        self.ensure_calls += 1
        self.ensured_port = self._ensure.port
        return self._ensure

    def stop(self):
        self.stop_calls += 1


class FakeHost:
    def __init__(
        self,
        *,
        probe: ScoreCheck | None = None,
        start: ScoreCheck | None = None,
        failure: str = "",
    ):
        self._probe = probe or ScoreCheck(ok=True, port=5001, prob_1=0.25)
        self._start = start or ScoreCheck(ok=True, port=5001)
        self._failure = failure
        self.running = False
        self.starts: list[int] = []
        self.stop_calls = 0

    def start(self, engine_port: int):
        self.starts.append(engine_port)
        self.running = self._start.ok
        return self._start

    def probe(self):
        return self._probe

    def failure(self) -> str:
        return self._failure

    def stop(self):
        self.stop_calls += 1
        self.running = False


def _pack(directory) -> "object":
    """造一个小号模型包：manifest + 两个小文件。让单测不依赖本机私域目录。"""
    import hashlib
    import json

    target = directory / "pack"
    target.mkdir(parents=True, exist_ok=True)
    files = []
    for name, role in (("model.gguf", "model"), ("mmproj.gguf", "mmproj")):
        payload = f"fake-{name}".encode()
        (target / name).write_bytes(payload)
        files.append(
            {
                "name": name,
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "role": role,
            }
        )
    (target / "manifest.json").write_text(
        json.dumps({"kind": "jev-model-pack", "files": files}), encoding="utf-8"
    )
    return target


def _engine_ok(port: int = 41000) -> engine_module.EngineCheck:
    return engine_module.EngineCheck(ok=True, step=2, pid=4242, port=port)


# ---------------------------------------------------------------- 四步判定


def test_missing_model_pack_is_step1_naming_the_file(tmp_path) -> None:
    """/ready 在引擎还没起时也要说清"缺哪个文件"，不许只说"引擎没起"。"""
    runtime = health_module.JevRuntime(model_dir=tmp_path / "没有这个目录", engine=FakeEngine(_engine_ok()), host=FakeHost())

    verdict = runtime.check()

    assert verdict.ok is False and verdict.step == 1
    assert "manifest.json" in verdict.detail
    assert "没有这个目录" in verdict.detail


def test_engine_down_is_step1(tmp_path) -> None:
    runtime = health_module.JevRuntime(
        model_dir=_pack(tmp_path),
        engine=FakeEngine(engine_module.EngineCheck(ok=False, step=1, detail="引擎没起（还没启动过）")),
        host=FakeHost(),
    )

    verdict = runtime.check()

    assert verdict.ok is False
    assert verdict.step == 1
    assert "引擎没起" in verdict.detail
    assert verdict.problems() == ["第 1 步（引擎进程）没过：引擎没起（还没启动过）"]


def test_engine_answers_but_score_host_missing_is_step3(tmp_path) -> None:
    runtime = health_module.JevRuntime(model_dir=_pack(tmp_path), engine=FakeEngine(_engine_ok()), host=FakeHost())
    runtime.host.running = False

    verdict = runtime.check()

    assert verdict.step == 3, "引擎通了但打分层没起：这是第 3 步，不是第 2 步"
    assert "打分层没在跑" in verdict.detail


def test_score_host_failure_detail_is_carried_verbatim(tmp_path) -> None:
    """打分层起不来时，detail 必须是引擎原话，不许换成"没在跑"那种误导。"""
    engine = FakeEngine(_engine_ok())
    engine_message = (
        "打分层自检没过：RuntimeError: refusing to start: "
        "the engine does not assemble the prompt this checkpoint was trained on.\n"
        'the engine could not score the startup probe: backend HTTP 501: {"error": '
        '"start it with `--mmproj`"}'
    )
    host = FakeHost(failure=engine_message)
    runtime = health_module.JevRuntime(model_dir=_pack(tmp_path), engine=engine, host=host)

    verdict = runtime.check()

    assert verdict.step == 3
    assert verdict.detail == engine_message, "原样带出，不概括、不截断"
    assert "501" in verdict.detail and "--mmproj" in verdict.detail


def test_score_host_cleanly_stopped_keeps_the_plain_message(tmp_path) -> None:
    """打分层只是被正常停掉（没有 failure）⇒ 仍然是那句常规文案，别把停机写成故障。"""
    engine = FakeEngine(_engine_ok())
    host = FakeHost(failure="")
    runtime = health_module.JevRuntime(model_dir=_pack(tmp_path), engine=engine, host=host)

    verdict = runtime.check()

    assert verdict.step == 3
    assert verdict.detail == "打分层没在跑（点「Jev 打分」会自动起）"


def test_probe_failure_is_step3_with_engine_message(tmp_path) -> None:
    engine = FakeEngine(_engine_ok())
    host = FakeHost(probe=ScoreCheck(ok=False, detail="打分接口回 501：start it with --mmproj", port=5001))
    host.running = True
    runtime = health_module.JevRuntime(model_dir=_pack(tmp_path), engine=engine, host=host)

    verdict = runtime.check()

    assert verdict.step == 3
    assert "--mmproj" in verdict.detail
    assert verdict.pid == 4242


def test_all_good_is_step4_with_probability(tmp_path) -> None:
    engine = FakeEngine(_engine_ok())
    host = FakeHost(probe=ScoreCheck(ok=True, port=5001, prob_1=0.013))
    host.running = True
    runtime = health_module.JevRuntime(model_dir=_pack(tmp_path), engine=engine, host=host)

    verdict = runtime.check()

    assert verdict.ok is True and verdict.step == 4
    assert verdict.prob_1 == pytest.approx(0.013)
    assert verdict.engine_port == 41000 and verdict.score_port == 5001
    assert verdict.problems() == []


# ---------------------------------------------------------------- 启动（幂等）


def test_ensure_starts_engine_then_host_and_reports_step4(tmp_path) -> None:
    engine = FakeEngine(engine_module.EngineCheck(ok=False, step=1), ensure=_engine_ok(41001))
    host = FakeHost()
    runtime = health_module.JevRuntime(model_dir=_pack(tmp_path), engine=engine, host=host)

    verdict = runtime.ensure()

    assert engine.ensure_calls == 1
    assert host.starts == [41001], "打分层必须跟着引擎的真实端口起"
    assert verdict.ok is True and verdict.step == 4


def test_ensure_is_idempotent_for_same_engine_port(tmp_path) -> None:
    engine = FakeEngine(_engine_ok(41002), ensure=_engine_ok(41002))
    host = FakeHost()
    runtime = health_module.JevRuntime(model_dir=_pack(tmp_path), engine=engine, host=host)

    first = runtime.ensure()
    second = runtime.ensure()

    assert first.ok and second.ok
    assert engine.ensure_calls == 2, "第二次也要问一次引擎（它可能刚崩），但要便宜"
    assert host.starts == [41002, 41002], "端口没变就不要再起一个打分层（ScoreHost 自己会跳过）"


def test_ensure_when_engine_fails_does_not_start_host(tmp_path) -> None:
    engine = FakeEngine(
        engine_module.EngineCheck(ok=False, step=1),
        ensure=engine_module.EngineCheck(ok=False, step=1, detail="模型文件缺失：…/mmproj.gguf"),
    )
    host = FakeHost()
    runtime = health_module.JevRuntime(model_dir=_pack(tmp_path), engine=engine, host=host)

    verdict = runtime.ensure()

    assert verdict.ok is False and verdict.step == 1
    assert host.starts == [], "引擎都没起来，不许再起打分层"
    assert "mmproj" in verdict.detail


def test_stop_stops_host_before_engine(tmp_path) -> None:
    order: list[str] = []

    class Ordered(FakeHost):
        def stop(self):  # type: ignore[override]
            order.append("host")
            super().stop()

    class OrderedEngine(FakeEngine):
        def stop(self):  # type: ignore[override]
            order.append("engine")
            super().stop()

    runtime = health_module.JevRuntime(model_dir=_pack(tmp_path), engine=OrderedEngine(_engine_ok()), host=Ordered())
    runtime.stop()

    assert order == ["host", "engine"], "先停打分层（它连着引擎），再停引擎"


# ---------------------------------------------------------------- 外部服务


class _Stub(BaseHTTPRequestHandler):
    """一个够用的假引擎/假打分服务：两条路径 + 可控分数。"""

    prob: float = 0.5
    status: int = 200
    models: list[str] = []

    def do_GET(self):  # noqa: N802 - http.server 的约定
        if self.path != "/v1/models":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps({"data": [{"id": value} for value in self.models]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        if self.status != 200:
            body = json.dumps({"error": "引擎还没热"}).encode()
            self.send_response(self.status)
        else:
            body = json.dumps({"results": [{"prob_1": self.prob}]}).encode()
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


@pytest.fixture
def stub_server():
    server = HTTPServer(("127.0.0.1", 0), _Stub)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_check_urls_ok_reports_step4(stub_server: HTTPServer, tmp_path) -> None:
    from book2text.core.project import jev_engine

    pack_dir = tmp_path / "models"
    pack_dir.mkdir()
    for name, role in (("model.gguf", "model"), ("mmproj.gguf", "mmproj")):
        (pack_dir / name).write_bytes(b"x")
    (pack_dir / "manifest.json").write_text(
        json.dumps(
            {
                "kind": "jev-model-pack",
                "files": [
                    {"name": "model.gguf", "bytes": 1, "sha256": "", "role": "model"},
                    {"name": "mmproj.gguf", "bytes": 1, "sha256": "", "role": "mmproj"},
                ],
            }
        ),
        encoding="utf-8",
    )
    _Stub.models = [str(pack_dir / "model.gguf")]
    _Stub.prob = 0.125
    port = stub_server.server_address[1]

    verdict = health_module.check_urls(f"http://127.0.0.1:{port}", f"http://127.0.0.1:{port}", model_dir=pack_dir)

    assert verdict.ok is True, verdict.detail
    assert verdict.step == 4
    assert verdict.prob_1 == pytest.approx(0.125)
    assert jev_engine.load_model_pack(pack_dir).model.name == "model.gguf"


def test_check_urls_score_error_is_step3(stub_server: HTTPServer, tmp_path) -> None:
    # 不给 manifest ⇒ 不做 model id 比对（这里只想验第 3 步）
    _Stub.models = []
    _Stub.status = 500
    port = stub_server.server_address[1]
    try:
        verdict = health_module.check_urls(
            f"http://127.0.0.1:{port}", f"http://127.0.0.1:{port}", model_dir=tmp_path / "没有 manifest"
        )
    finally:
        _Stub.status = 200

    assert verdict.ok is False
    assert verdict.step == 3, "引擎与 /v1/models 都通，只有打分失败 ⇒ 第 3 步"
    assert "500" in verdict.detail


def test_check_urls_unreachable_engine_is_step1(tmp_path) -> None:
    verdict = health_module.check_urls("http://127.0.0.1:9", "http://127.0.0.1:9")

    assert verdict.ok is False
    assert verdict.step == 1
    assert "连不上" in verdict.detail


def test_missing_font_fails_at_step3_not_a_separate_branch(stub_server: HTTPServer, tmp_path) -> None:
    """字体缺失要落在第 3 步里——`/ready` 不该出现"引擎 ok / 字体缺"这种组合态。"""
    import json as _json

    _Stub.models = []
    port = stub_server.server_address[1]
    verdict = health_module.check_urls(
        f"http://127.0.0.1:{port}",
        f"http://127.0.0.1:{port}",
        model_dir=tmp_path / "没有 manifest",
        font_path=str(tmp_path / "nope.ttc"),
    )

    assert verdict.ok is False
    assert verdict.step == 3, "字体问题归第 3 步，不是独立分支"
    assert "字体缺失" in verdict.detail
    assert verdict.prob_1 is not None, "引擎其实已经出分了，只是候选渲染不可信——分数照样带出来"
