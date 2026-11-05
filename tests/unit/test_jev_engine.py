"""Jev 引擎守护的单元测试（2026-11-05）。

只验**进程这一层**：spawn / 端口 / 就绪等待 / stderr 环形缓冲 / 崩溃自愈 / 收尸 / 孤儿清理。
不碰打分层（第 2 笔）、不碰 API 与界面（第 3、4 笔）。

跑的是**真的子进程**（一个假引擎脚本，用 `http.server` 占端口、答 `/v1/models`），
因为这一层最容易"看起来对"：只 mock 一个 Popen 的话，端口到底有没有人监听、
SIGTERM 到底等不等得到，全都验不出来。
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from pathlib import Path

import pytest

from book2text.core.project import jev_engine as engine_module
from book2text.core.project.jev_engine import (
    EngineConfig,
    JevEngine,
    JevEngineError,
    load_model_pack,
    port_listening_pids,
    verify_model_files,
)

# 注意：venv 的路径里有空格（`/Users/…/DeepSeek Bot/…`），shebang 会被内核从空格处截断，
# 所以入口用一层 **sh 包装**（能引号包裹解释器路径），Python 源码单独放 fake-engine.py。
FAKE_ENGINE = '''
"""假 llama-server：只为验守护进程这一层，不加载模型、不算分。"""
import argparse
import json
import os
import signal
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

parser = argparse.ArgumentParser()
parser.add_argument("-m", dest="model", required=True)
parser.add_argument("--mmproj", dest="mmproj", required=True)
parser.add_argument("-ngl", type=int, default=0)
parser.add_argument("-c", type=int, default=0)
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, required=True)
args, _unknown = parser.parse_known_args()

mode = os.environ.get("FAKE_ENGINE_MODE", "ok")
if mode == "exit":
    for index in range(30):
        print(f"fake stderr line {index}", file=sys.stderr, flush=True)
    sys.exit(3)
if mode == "hang":
    time.sleep(120)
    sys.exit(0)
if mode == "ignore-term":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/v1/models":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps({"data": [{"id": args.model}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

class Server(HTTPServer):
    allow_reuse_address = True

Server((args.host, args.port), Handler).serve_forever()
'''


def _write_pack(directory: Path, *, sizes: tuple[int, int] = (2048, 1024)) -> Path:
    """造一个小号"模型包"：两个文件 + manifest（结构与应用私域里那份完全一致）。"""
    directory.mkdir(parents=True, exist_ok=True)
    files = []
    for name, size, role in (
        ("MiniCPM-OCR-Jev-Q8_0.gguf", sizes[0], "model"),
        ("mmproj-model-f16.gguf", sizes[1], "mmproj"),
    ):
        payload = bytes((index % 251 for index in range(size)))
        (directory / name).write_bytes(payload)
        files.append(
            {
                "name": name,
                "bytes": len(payload),
                "sha256": engine_module._sha256(directory / name),
                "role": role,
            }
        )
    manifest = {
        "manifest_version": 1,
        "kind": "jev-model-pack",
        "engine": {"llama_cpp_version": "0.8.0", "binary": "llama-server"},
        "files": files,
    }
    (directory / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8"
    )
    return directory


def _write_engine(tmp_path: Path) -> Path:
    source = tmp_path / "fake-engine.py"
    source.write_text(FAKE_ENGINE, encoding="utf-8")
    wrapper = tmp_path / "fake-engine"
    wrapper.write_text(
        '#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, source),
        encoding="utf-8",
    )
    wrapper.chmod(0o755)
    return wrapper


def _config(tmp_path: Path, **overrides) -> EngineConfig:
    pack = _write_pack(tmp_path / "models")
    base = dict(
        model_dir=pack,
        binary=str(_write_engine(tmp_path)),
        state_dir=tmp_path / "state",
        ready_timeout=15.0,
        shutdown_grace=1.0,
        backoff=(0.05, 0.1, 0.2),
    )
    base.update(overrides)
    return EngineConfig(**base)


def _wait_dead(pid: int, *, timeout: float = 10.0) -> bool:
    """等到这个 pid 真的没了。**僵尸算没了**：被 SIGKILL 的子进程在父进程 wait 之前
    会以 Z 状态一直挂着，`kill -0` 也会成功——拿它当"还活着"会让测试空等 10 秒。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if engine_module._process_command(pid) is None:
            return True
        time.sleep(0.05)
    return False


@pytest.fixture
def engine(tmp_path: Path):
    instance = JevEngine(_config(tmp_path))
    yield instance
    instance.stop()


# ---------------------------------------------------------------- 起、查、停


def test_start_ready_and_listening_pid_matches(engine: JevEngine) -> None:
    check = engine.start()

    assert check.ok is True, check.detail
    assert check.step == 2
    assert engine.pid is not None and check.pid == engine.pid
    assert engine.port > 0 and check.port == engine.port
    assert engine.pid in port_listening_pids(engine.port), "端口必须是这个 pid 在监听，不是别人"


def test_ensure_is_idempotent(engine: JevEngine) -> None:
    first = engine.ensure()
    pid = engine.pid
    second = engine.ensure()

    assert first.ok and second.ok
    assert pid is not None and second.pid == pid, "已在跑就不许再起一个"
    assert engine.restarts == 0


def test_check_before_start_says_step1(engine: JevEngine) -> None:
    check = engine.check()

    assert check.ok is False
    assert check.step == 1
    assert "引擎没起" in check.detail


def test_stop_reaps_process_and_frees_port(engine: JevEngine) -> None:
    engine.start()
    pid = engine.pid
    port = engine.port

    engine.stop()

    assert pid is not None and _wait_dead(pid), "stop() 之后引擎进程必须没了"
    assert engine.check().step == 1
    assert port_listening_pids(port) == set(), "端口要空出来，下次才能重新起"


def test_stop_kills_process_that_ignores_sigterm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_ENGINE_MODE", "ignore-term")
    instance = JevEngine(_config(tmp_path, shutdown_grace=0.3))
    instance.start()
    pid = instance.pid

    started = time.monotonic()
    instance.stop()  # 忽略 SIGTERM 的进程必须退到 SIGKILL，不能让 App 退不掉
    spent = time.monotonic() - started

    assert pid is not None and _wait_dead(pid)
    assert spent < 5.0, f"收尸不该拖这么久（{spent:.1f}s）"


# ---------------------------------------------------------------- 失败要能说清


def test_missing_manifest_names_the_directory(tmp_path: Path) -> None:
    with pytest.raises(JevEngineError) as raised:
        load_model_pack(tmp_path / "nowhere")

    assert "manifest.json" in str(raised.value)
    assert "nowhere" in str(raised.value)


def test_missing_model_file_is_reported(tmp_path: Path) -> None:
    pack_dir = _write_pack(tmp_path / "models")
    pack = load_model_pack(pack_dir)
    (pack_dir / pack.model.name).unlink()

    problems = verify_model_files(pack)

    assert any("模型文件缺失" in item and pack.model.name in item for item in problems)


def test_size_mismatch_is_reported(tmp_path: Path) -> None:
    pack_dir = _write_pack(tmp_path / "models")
    pack = load_model_pack(pack_dir)
    with (pack_dir / pack.model.name).open("ab") as handle:
        handle.write(b"x")

    problems = verify_model_files(pack)

    assert any("大小不符" in item for item in problems)


def test_deep_verification_catches_hash_mismatch(tmp_path: Path) -> None:
    pack_dir = _write_pack(tmp_path / "models")
    pack = load_model_pack(pack_dir)
    payload = bytearray((pack_dir / pack.model.name).read_bytes())
    payload[-1] ^= 0xFF  # 同大小、不同内容
    (pack_dir / pack.model.name).write_bytes(bytes(payload))

    assert verify_model_files(pack) == [], "默认只比字节数：同大小要先放过"
    deep = verify_model_files(pack, deep=True)
    assert any("sha256 不符" in item for item in deep)


def test_engine_that_exits_immediately_shows_last_stderr_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_ENGINE_MODE", "exit")
    instance = JevEngine(_config(tmp_path))

    with pytest.raises(JevEngineError) as raised:
        instance.start()
    message = str(raised.value)

    assert "引擎加载失败" in message
    assert "fake stderr line 29" in message, "最后一行必须在报错里"
    assert "fake stderr line 0\n" not in message, "只给最后 20 行，不要把 30 行全倒出来"


def test_timeout_when_engine_never_answers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_ENGINE_MODE", "hang")
    instance = JevEngine(_config(tmp_path, ready_timeout=1.0))

    with pytest.raises(JevEngineError) as raised:
        instance.start()

    assert raised.value.step == 2
    assert "还没答 /v1/models" in str(raised.value)
    assert instance.pid is None, "超时后必须把半死的进程收掉，别留在后台"
    instance.stop()


# ---------------------------------------------------------------- 自愈


def test_kill_9_then_ensure_restarts(engine: JevEngine) -> None:
    engine.start()
    pid = engine.pid
    assert pid is not None

    os.kill(pid, signal.SIGKILL)
    assert _wait_dead(pid)

    check = engine.ensure()

    assert check.ok is True, check.detail
    assert engine.pid is not None and engine.pid != pid
    assert engine.restarts == 1, "自愈必须记一次重启"


def test_restart_budget_stops_after_limit(tmp_path: Path) -> None:
    instance = JevEngine(_config(tmp_path, max_restarts=1))
    instance.start()
    os.kill(instance.pid, signal.SIGKILL)
    assert _wait_dead(instance.pid)
    assert instance.ensure().ok is True

    os.kill(instance.pid, signal.SIGKILL)
    assert _wait_dead(instance.pid)
    check = instance.ensure()

    assert check.ok is False and check.step == 1
    assert "不再重启" in check.detail and "连续自愈 1 次" in check.detail
    instance.stop()


def test_orphan_engine_from_previous_run_is_reaped(tmp_path: Path) -> None:
    """模拟 App 被强杀：pid 文件留着、引擎还在跑；下次启动必须先清掉它。"""
    config = _config(tmp_path)
    abandoned = JevEngine(config)
    abandoned.start()
    orphan_pid = abandoned.pid
    assert orphan_pid is not None and orphan_pid in port_listening_pids(abandoned.port)

    fresh = JevEngine(config)  # 同一个 state_dir ⇒ 看得到上一份 pid 文件
    check = fresh.start()

    assert check.ok is True, check.detail
    # 孤儿是被"新引擎"杀的：它成了僵尸，得由它的父进程（本测试）回收才能确认退出
    abandoned._process.wait(timeout=10)
    assert abandoned._process.returncode is not None, "上一份引擎必须被清掉，否则端口与 3 GB 内存都还在"
    assert fresh.pid != orphan_pid
    fresh.stop()
    abandoned.stop()


# ---------------------------------------------------------------- 路径纪律


def test_no_code_points_at_the_old_tmp_model_copy() -> None:
    """2026-11-05 的教训：模型曾只放在 /tmp，测试也读它，换台机器就红。"""
    root = Path(__file__).resolve().parents[2]
    offenders: list[str] = []
    for folder in ("backend", "tests", "scripts"):
        for path in (root / folder).rglob("*"):
            if not path.is_file() or path.suffix not in {".py", ".js", ".mjs", ".sh", ".bat"}:
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:  # pragma: no cover
                continue
            needle = "/tmp/" + "ocrev"  # 拼出来，免得这条测试自己的字面量污染那条 grep
            if needle in text:
                offenders.append(str(path.relative_to(root)))
    assert offenders == [], f"代码/测试/脚本里不许再出现旧的临时模型目录：{offenders}"
