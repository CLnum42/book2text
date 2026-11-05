"""Jev「能不能打分」——四步检查的**唯一实现**（2026-11-05 第 3 笔）。

**为什么要单独一个模块**：这个判断原来有两份——`jev_priority.probe()` 自己查了
打分服务 `/healthz`、引擎 `/v1/models`、模型字节数；引擎守护又查了一遍端口与模型 id。
2026-11-05 早上那条 bug 的形状就是"同一个语义两份实现，改了一份"。
现在只有这里判：

```
第 1 步  引擎进程真在（我们起的：pid 活着且端口归它；外部起的：端口有人监听）
第 2 步  引擎能答：GET /v1/models 200，且模型 id 就是我们这份（不是别的引擎占了端口）
第 3 步  真能打分：拿固定 fixture 走一次完整 /v1/score，prob_1 必须是 0–1 的数
第 4 步  可用（ok=true 时才到这一步；界面据此点亮）
```

第 3 步不是"健康检查 200"：进程起了、接口通了、模型不能用，前两步全绿——只有真打一次分才暴露。

两个入口，同一套步骤与文案：

- `JevRuntime.check()` / `.ensure()`：**应用自己管进程**（引擎 + 主进程内的打分层）。
- `check_urls(engine_url, score_url)`：**外部已经在跑**的服务（验收脚本、排障用）。
"""

from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from . import jev_engine as engine_module
from . import jev_score_host as host_module

STEP_LABELS = {1: "引擎进程", 2: "引擎能答", 3: "真能打分", 4: "可用"}

#: 候选文本渲染用的字体。它不影响"引擎能不能打分"，但影响"候选渲染得出来吗"——
#: 所以归到第 3 步（真能打分）的失败分支里，不让 `/ready` 出现"引擎 ok / 字体缺"的组合态。
DEFAULT_FONT = "/System/Library/Fonts/Supplemental/Songti.ttc"


@dataclass(frozen=True)
class JevVerdict:
    """四步结论。`step` 是**失败在哪一步**（ok 时=4）。"""

    ok: bool
    step: int
    detail: str = ""
    pid: int | None = None
    engine_port: int | None = None
    score_port: int | None = None
    prob_1: float | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "step": self.step,
            "step_label": STEP_LABELS.get(self.step, ""),
            "detail": self.detail,
            "pid": self.pid,
            "engine_port": self.engine_port,
            "score_port": self.score_port,
            "prob_1": self.prob_1,
        }

    def problems(self) -> list[str]:
        """给老调用方的形状：能跑 = 空列表；不能跑 = 一句话说清卡在哪一步。"""
        if self.ok:
            return []
        label = STEP_LABELS.get(self.step, "")
        return [f"第 {self.step} 步（{label}）没过：{self.detail}" if self.detail else f"第 {self.step} 步（{label}）没过"]


class JevRuntime:
    """一份应用实例的 Jev 家当：引擎进程 + 主进程内的打分层。**构造不启动任何东西**。"""

    def __init__(
        self,
        *,
        model_dir: Path | None = None,
        font_path: str | None = None,
        engine: engine_module.JevEngine | None = None,
        host: host_module.ScoreHost | None = None,
    ) -> None:
        self._model_dir = model_dir
        self._font_path = font_path or os.environ.get("B2T_JEV_FONT") or DEFAULT_FONT
        self._engine = engine or engine_module.JevEngine(engine_module.EngineConfig(model_dir=model_dir))
        self._host = host or host_module.ScoreHost()

    @property
    def engine(self) -> engine_module.JevEngine:
        return self._engine

    @property
    def host(self) -> host_module.ScoreHost:
        return self._host

    def check(self) -> JevVerdict:
        """只看不启动：我们已经起的进程现在能不能打分。"""
        check = self._engine.check()
        if not check.ok:
            return JevVerdict(
                ok=False,
                step=check.step,
                detail=check.detail,
                pid=check.pid,
                engine_port=check.port or None,
            )
        if not self._host.running:
            # 打分层起不来时，`failure()` 里是**引擎的原话**（例如 HTTP 501 … start it with
            # `--mmproj`）。丢掉它换成一句"没在跑"，用户点一辈子也不会好——那正是"点了没反应"。
            # 只有"干净停下"（failure 为空）才用那句常规文案。
            return JevVerdict(
                ok=False,
                step=3,
                detail=self._host.failure() or "打分层没在跑（点「Jev 打分」会自动起）",
                pid=check.pid,
                engine_port=check.port,
            )
        score = self._host.probe()
        if not score.ok:
            return JevVerdict(
                ok=False,
                step=3,
                detail=score.detail,
                pid=check.pid,
                engine_port=check.port,
                score_port=score.port,
            )
        font_problem = _font_problem(self._font_path)
        if font_problem:
            return JevVerdict(
                ok=False,
                step=3,
                detail=font_problem,
                pid=check.pid,
                engine_port=check.port,
                score_port=score.port,
                prob_1=score.prob_1,
            )
        return JevVerdict(
            ok=True,
            step=4,
            pid=check.pid,
            engine_port=check.port,
            score_port=score.port,
            prob_1=score.prob_1,
        )

    def ensure(self) -> JevVerdict:
        """要用它了：引擎没起就起、崩了就自愈，再把打分层跟上；最后真打一次分。幂等。"""
        started = self._engine.ensure()
        if not started.ok:
            return JevVerdict(
                ok=False,
                step=started.step,
                detail=started.detail,
                pid=started.pid,
                engine_port=started.port or None,
            )
        host_check = self._host.start(started.port or 0)
        if not host_check.ok:
            return JevVerdict(
                ok=False,
                step=3,
                detail=host_check.detail,
                pid=started.pid,
                engine_port=started.port,
                score_port=host_check.port,
            )
        return self.check()

    def stop(self) -> None:
        """退出时收尸：先停打分层（它连着引擎），再停引擎。可重复调用。"""
        try:
            self._host.stop()
        finally:
            self._engine.stop()


# ---------------------------------------------------------------- 外部已在跑的服务


def check_urls(
    engine_url: str,
    score_url: str,
    *,
    model_dir: Path | None = None,
    font_path: str | None = None,
    timeout: float = 60.0,
) -> JevVerdict:
    """查**外部**已经起好的引擎与打分服务（验收脚本 / 排障）。

    第 1 步只能退化成"端口有人监听"——外部引擎不是我们 spawn 的，没有 pid 可认。

    **注意**：外部路径拿不到引擎侧的应答原文。打分层是别人起的，我们看不到它的启动日志，
    所以第 3 步失败时只能给"打分接口回 5xx / 连不上"，拿不到那句 `start it with --mmproj`。
    要看引擎原话就走应用内那条（`JevRuntime.ensure()` / `.check()`，detail 来自打分层自检）。
    """
    engine = engine_url.rstrip("/")
    score = score_url.rstrip("/")
    if not _listening(engine):
        return JevVerdict(ok=False, step=1, detail=f"引擎连不上（{engine}）")
    data = _http_json(f"{engine}/v1/models")
    if data is None:
        return JevVerdict(ok=False, step=2, detail=f"引擎不答 /v1/models（{engine}）")
    ids = [str(item.get("id") or "") for item in data.get("data") or [] if isinstance(item, dict)]
    expected = _expected_model_name(model_dir)
    if expected and not any(Path(value).name == expected for value in ids):
        return JevVerdict(
            ok=False,
            step=2,
            detail=f"/v1/models 里没有这份模型（期望 {expected}，实际 {ids or '空'}）",
        )
    prob, detail = probe_score_url(score, timeout=timeout)
    if prob is None:
        return JevVerdict(ok=False, step=3, detail=detail)
    font_problem = _font_problem(font_path or DEFAULT_FONT)
    if font_problem:
        return JevVerdict(ok=False, step=3, detail=font_problem, prob_1=prob)
    return JevVerdict(ok=True, step=4, prob_1=prob)


def probe_score_url(score_url: str, *, timeout: float = 60.0) -> tuple[float | None, str]:
    """第 3 步：拿固定 fixture 真打一次分。返回 `(prob_1, 失败原因)`。"""
    payload = json.dumps(
        {
            "items": [
                {
                    "original_image": host_module.PROBE_PNG_B64,
                    "render_image": host_module.PROBE_PNG_B64,
                    "ocr_text": host_module.PROBE_TEXT,
                }
            ]
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{score_url.rstrip('/')}/v1/score",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        snippet = ""
        try:
            snippet = exc.read()[:300].decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 - pragma: no cover
            pass
        return None, f"打分接口回 {exc.code}：{snippet or exc.reason}"
    except (urllib.error.URLError, OSError) as exc:
        return None, f"打分接口连不上（{exc}）"
    try:
        data = json.loads(body)
    except ValueError:
        return None, f"打分接口返回的不是 JSON：{body[:200]!r}"
    results = data.get("results") or []
    if not results or not isinstance(results[0], dict):
        return None, f"打分接口没有 results：{data!r}"[:400]
    value = results[0].get("prob_1")
    if value is None:
        return None, f"这一条没有 prob_1：{results[0]!r}"[:400]
    try:
        prob = float(value)
    except (TypeError, ValueError):
        return None, f"prob_1 不是数：{value!r}"
    if not 0.0 <= prob <= 1.0:
        return None, f"prob_1 越界：{prob}"
    return prob, ""


def _font_problem(font_path: str) -> str:
    """候选渲染字体在不在。缺了就归第 3 步（能打分，但打出来的候选不可信）。"""
    if Path(font_path).is_file():
        return ""
    return f"候选文本字体缺失：{font_path}（渲染候选用；B2T_JEV_FONT 可覆盖）"


def _expected_model_name(model_dir: Path | None) -> str:
    try:
        return engine_module.load_model_pack(model_dir).model.name
    except engine_module.JevEngineError:
        return ""


def _listening(url: str) -> bool:
    parsed = urllib.parse.urlparse(url if "://" in url else f"http://{url}")
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 80
    try:
        with socket.create_connection((host, port), timeout=1.5):
            return True
    except OSError:
        return False


def _http_json(url: str, *, timeout: float = 2.0) -> dict[str, object] | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            if response.status != 200:
                return None
            return json.loads(response.read())
    except (urllib.error.URLError, OSError, ValueError):
        return None
