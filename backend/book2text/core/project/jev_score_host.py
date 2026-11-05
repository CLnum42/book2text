"""Jev 打分层并进主进程（2026-11-05 第 2 笔），外加第 3 步"真能打分"探针。

**为什么不另起一个服务**：打分层是纯 Python（fastapi + uvicorn + httpx + pydantic + PyYAML +
Pillow，都已经在主进程的依赖里），独立跑的时候 RSS 只有 56 MB。多一个进程就多一处
"谁起、谁看健康、谁收尸"，而它本身不占算力（真正的算力在 llama-server 里）。

**第 3 步为什么不能省**：2026-11-05 的故障是"引擎进程起了、`/v1/models` 也通、但模型没加载完"——
前两步全绿，真去打分才炸。所以这里的判据是：**拿固定 fixture 走一次完整 `/v1/score`，
`prob_1` 必须是 0–1 的数**，不是"健康检查返回 200"。

**启动顺序**：`ScoreHost.start(engine_port)` 只在引擎就绪之后调用；打分层自己的 lifespan 里
还有一道"等引擎 `/v1/models` 能答"的兜底（见 `vendor/jev_score/server.py` 的 `_wait_for_engine`），
所以顺序反了也不会变成"服务直接退出"。
"""

from __future__ import annotations

import base64
import json
import logging
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

VENDOR_CONFIG = Path(__file__).resolve().parents[2] / "vendor" / "jev_score" / "backends" / "llamacpp.yaml"

#: 第 3 步用的固定 fixture（64×64 白底、一个"一"字、PNG 263 B）。
#: 直接内嵌而不是随包放一张图：少一个"打包时忘了带数据文件"的失败面。
PROBE_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAzklEQVR42u3ZMQqEMBCF4cx2ooWkUjygtZW9"
    "p/AcFl7BoygEAiksk2y3xRbLuuqK8L8+w3zDpBqJMao756FuHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AOD7TNPUNM08z3sLxSvinCuKQimltR6GYU+pawBt274mKCJd150CWNfVWuu9P7Z7Y0yapm+LUNd1COFgwLI"
    "seZ7/7Vf0ff8DQD7fyMZxTJKkLMuzuxeRqqqyLNv8kCMfAAAAAAAAAAAAAAAAAAAAAAAAAAAAtucJ7ZV2VV"
    "JtGEcAAAAASUVORK5CYII="
)
PROBE_TEXT = "一"

#: 等 uvicorn 起来（含自检：要跑一次前向）。冷机第一次会慢，给足。
STARTUP_TIMEOUT = 180.0
#: 一次打分的上限（batch=1、fixture 很小；实测 0.31 s/条）。
PROBE_TIMEOUT = 60.0
#: 打分层 lifespan 里等引擎就绪的兜底秒数。
ENGINE_WAIT = 60.0


@dataclass(frozen=True)
class ScoreCheck:
    """第 3 步的结论。失败一律 `step=3`——它回答的就是"真能出分吗"。"""

    ok: bool
    detail: str = ""
    port: int | None = None
    prob_1: float | None = None
    step: int = 3

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "step": self.step,
            "detail": self.detail,
            "port": self.port,
            "prob_1": self.prob_1,
        }


def _free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def _default_app_factory(engine_wait: float) -> Callable[[int], object]:
    """真实的打分层：vendored 的 FastAPI app，后端指向刚起的引擎端口。"""

    def build(engine_port: int) -> object:
        import os

        from ...vendor.jev_score.server import create_app

        os.environ["JEV_BACKEND_CONFIG"] = str(VENDOR_CONFIG)
        os.environ["JEV_BACKEND_URL"] = f"http://127.0.0.1:{engine_port}"
        os.environ.setdefault("JEV_ENGINE_WAIT", str(engine_wait))
        return create_app()

    return build


class _LogCapture(logging.Handler):
    """把 uvicorn 的启动日志收下来：自检失败时真正的异常只在日志里（uvicorn 抛的是 SystemExit）。"""

    def __init__(self) -> None:
        super().__init__()
        self.setFormatter(logging.Formatter("%(message)s"))
        self.messages: list[str] = []
        #: 异常的**原始一句话**（`str(exc)`）。自检失败时真正能读的就是它——
        #: 日志里的 traceback 只有调用栈，末尾还会被截掉最关键的那条引擎回话。
        self.exceptions: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        text = self.format(record)
        if record.exc_info:
            self.messages.append(f"{text}\n{self.formatException(record.exc_info)}")
            exc = record.exc_info[1]
            if exc is not None:
                self.exceptions.append(str(exc))
            return
        self.messages.append(text)


#: 日志里"真正的异常那一行"：`RuntimeError: …` / `ValueError: …` / `SystemExit: 3`
_EXC_LINE = re.compile(r"^[A-Za-z_][\w.]*(Error|Exception|Exit)\b")


def _exception_message(text: str) -> str:
    """从一段日志/traceback 里挑出异常原文（含它后面的几行说明）。

    uvicorn 那条记录有时不带 `exc_info`（traceback 已经被拼进 message 了），
    所以不能只靠 `record.exc_info`——按行找最后一个异常声明更可靠。
    """
    lines = (text or "").splitlines()
    for index in range(len(lines) - 1, -1, -1):
        if _EXC_LINE.match(lines[index]):
            return "\n".join(lines[index:]).strip()
    return ""


def _shorten(text: str, limit: int = 1200) -> str:
    """从**开头**截断：自检失败的说明是三段式（结论 / 引擎回话 / 怎么绕过），
    掐掉尾巴只会丢掉"start it with --mmproj"这类能照着修的线索。"""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


class ScoreHost:
    """主进程里的 uvicorn 线程。一个应用实例一份，跟着引擎端口走。"""

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        app_factory: Callable[[int], object] | None = None,
        startup_timeout: float = STARTUP_TIMEOUT,
        probe_timeout: float = PROBE_TIMEOUT,
        engine_wait: float = ENGINE_WAIT,
    ) -> None:
        self._host = host
        self._app_factory = app_factory or _default_app_factory(engine_wait)
        self._startup_timeout = startup_timeout
        self._probe_timeout = probe_timeout
        self._lock = threading.RLock()
        self._server: object | None = None
        self._thread: threading.Thread | None = None
        self._port = 0
        self._engine_port = 0
        self._failure: str = ""
        self._capture: _LogCapture | None = None

    # ---------------------------------------------------------------- 查询

    @property
    def port(self) -> int:
        with self._lock:
            return self._port

    @property
    def running(self) -> bool:
        with self._lock:
            server = self._server
            return bool(server is not None and getattr(server, "started", False))

    def failure(self) -> str:
        with self._lock:
            return self._failure

    # ---------------------------------------------------------------- 起停

    def start(self, engine_port: int) -> ScoreCheck:
        """起（或重起）打分层，等它自检通过。已在跑且端口没变则直接返回。"""
        with self._lock:
            if self.running and self._engine_port == engine_port:
                return ScoreCheck(ok=True, port=self._port)
            self.stop()
            self._port = _free_port(self._host)
            self._engine_port = engine_port
            self._failure = ""
            try:
                app = self._app_factory(engine_port)
            except Exception as exc:  # noqa: BLE001 - 起不来就是第 3 步失败，要把原因带出去
                self._failure = f"打分层搭不起来：{exc}"
                return ScoreCheck(ok=False, detail=self._failure, port=self._port)
            server, thread = self._spawn(app)
            self._server = server
            self._thread = thread
        return self._wait_started()

    def stop(self) -> None:
        with self._lock:
            server = self._server
            thread = self._thread
            self._server = None
            self._thread = None
            self._port = 0
            self._engine_port = 0
        if server is not None:
            try:
                setattr(server, "should_exit", True)
            except Exception:  # noqa: BLE001 - pragma: no cover
                pass
        if thread is not None and thread.is_alive():
            thread.join(timeout=10)
        self._detach_capture()

    # ---------------------------------------------------------------- 第 3 步

    def probe(self) -> ScoreCheck:
        """拿固定 fixture 走一次完整 `/v1/score`；`prob_1` 必须是 0–1 的数。"""
        with self._lock:
            port = self._port
            running = self.running
            failure = self._failure
        if not running or not port:
            return ScoreCheck(ok=False, detail=failure or "打分层没在跑", port=port or None)
        payload = json.dumps(
            {
                "items": [
                    {
                        "original_image": PROBE_PNG_B64,
                        "render_image": PROBE_PNG_B64,
                        "ocr_text": PROBE_TEXT,
                    }
                ]
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"http://{self._host}:{port}/v1/score",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._probe_timeout) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            snippet = ""
            try:
                snippet = exc.read()[:300].decode("utf-8", "replace")
            except Exception:  # noqa: BLE001 - pragma: no cover
                pass
            return ScoreCheck(
                ok=False, detail=f"打分接口回 {exc.code}：{snippet or exc.reason}", port=port
            )
        except (urllib.error.URLError, OSError) as exc:
            return ScoreCheck(ok=False, detail=f"打分接口连不上（{exc}）", port=port)
        try:
            data = json.loads(body)
        except ValueError:
            return ScoreCheck(ok=False, detail=f"打分接口返回的不是 JSON：{body[:200]!r}", port=port)
        results = data.get("results") or []
        if not results or not isinstance(results[0], dict):
            return ScoreCheck(ok=False, detail=f"打分接口没有 results：{data!r}"[:400], port=port)
        value = results[0].get("prob_1")
        if value is None:
            return ScoreCheck(ok=False, detail=f"这一条没有 prob_1：{results[0]!r}"[:400], port=port)
        try:
            prob = float(value)
        except (TypeError, ValueError):
            return ScoreCheck(ok=False, detail=f"prob_1 不是数：{value!r}", port=port)
        if not 0.0 <= prob <= 1.0:
            return ScoreCheck(ok=False, detail=f"prob_1 越界：{prob}", port=port)
        return ScoreCheck(ok=True, port=port, prob_1=prob)

    def check(self, engine_port: int) -> ScoreCheck:
        """第 3 步全流程：起（如需）→ 真打一次分。"""
        started = self.start(engine_port)
        if not started.ok:
            return started
        return self.probe()

    # ---------------------------------------------------------------- 内部

    def _startup_detail(self, fallback: str) -> str:
        """从 uvicorn 的启动日志里挑出真正的异常；没有就退回 fallback。"""
        capture = self._capture
        self._detach_capture()
        picked = ""
        if capture is not None:
            # 异常原文优先：它带着引擎的真实回话（例如 "start it with --mmproj"）
            texts = list(capture.exceptions)
            if not texts:
                texts = [
                    message
                    for message in capture.messages
                    if "lifespan" in message or "Error" in message or "error" in message
                ] or capture.messages
            if texts:
                picked = _exception_message(texts[-1]) or texts[-1]
        return f"打分层自检没过：{_shorten(picked.strip() or fallback)}"

    def _detach_capture(self) -> None:
        capture = self._capture
        self._capture = None
        if capture is not None:
            try:
                logging.getLogger("uvicorn.error").removeHandler(capture)
            except Exception:  # noqa: BLE001 pragma: no cover
                pass

    def _spawn(self, app: object) -> tuple[object, threading.Thread]:
        import uvicorn

        class _Server(uvicorn.Server):
            """把 startup 的异常留下来——uvicorn 默认只打印，调用方看不到原因。"""

            def __init__(self, config: "uvicorn.Config") -> None:
                super().__init__(config)
                self.failure: BaseException | None = None

            async def startup(self, sockets: list | None = None) -> None:  # type: ignore[override]
                try:
                    await super().startup(sockets)
                except BaseException as exc:  # noqa: BLE001 - 不往外抛：线程里抛只会变成噪音
                    self.failure = exc
                    self.should_exit = True

        config = uvicorn.Config(
            app,
            host=self._host,
            port=self._port,
            log_level="warning",
            access_log=False,
            lifespan="on",
        )
        capture = _LogCapture()
        logging.getLogger("uvicorn.error").addHandler(capture)
        self._capture = capture
        server = _Server(config)
        thread = threading.Thread(target=server.run, name="jev-score-host", daemon=True)
        thread.start()
        return server, thread

    def _wait_started(self) -> ScoreCheck:
        deadline = time.monotonic() + self._startup_timeout
        while time.monotonic() < deadline:
            with self._lock:
                server = self._server
                thread = self._thread
                port = self._port
            if server is None:  # pragma: no cover - 另一个线程刚 stop 了
                return ScoreCheck(ok=False, detail="打分层被停掉了", port=port or None)
            failure = getattr(server, "failure", None)
            if failure is not None:
                detail = self._startup_detail(str(failure))
                with self._lock:
                    self._failure = detail
                return ScoreCheck(ok=False, detail=detail, port=port)
            if getattr(server, "started", False):
                self._detach_capture()
                return ScoreCheck(ok=True, port=port)
            if thread is not None and not thread.is_alive():
                detail = self._startup_detail("打分层启动了又退出（没有留下原因）")
                with self._lock:
                    self._failure = detail
                return ScoreCheck(ok=False, detail=detail, port=port)
            time.sleep(0.1)
        detail = f"等了 {self._startup_timeout:.0f} 秒，打分层还没起来"
        with self._lock:
            self._failure = detail
        return ScoreCheck(ok=False, detail=detail, port=self._port)


def probe_image_bytes() -> bytes:
    """fixture 的原始字节（测试与打包自检用）。"""
    return base64.b64decode(PROBE_PNG_B64)
