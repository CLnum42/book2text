# vendored：MiniCPM-OCR-Jev 的 score 层

来源：MiniCPM-OCR 仓库 `scripts/minicpm-ocr-jev/sdk/jev_score/`（2026-11-04 那版）。
这里放的只是**打分**这一层（不含渲染、不含 Chromium）。

## 为什么随包内置

用户要求"点一下就能打分"。这一层是纯 Python（fastapi / uvicorn / httpx / pydantic / PyYAML /
Pillow，全部已经在主进程依赖里），源码 80 KB。放进来之后打分层跑在主进程的 uvicorn 线程里，
不用再管第二个服务的起停与健康检查。

## 相对上游改了哪四处（升级时整目录替换，别手工合）

1. `backends/__init__.py`：只保留 llama.cpp 适配器。`KNOWN_ENGINES = {"llamacpp"}`，
   删掉 vllm / sglang / ollama 三个 `return` 分支与其 import；`DEFAULT_CONFIG` 改成
   `llamacpp.yaml`；`CONFIG_DIR` 指向**包内**（原来是 `sdk/backends/`，这棵树里没有那个上级目录）。
   随之 `backends/` 下只留 `__init__.py` / `base.py` / `llamacpp_backend.py` / `llamacpp.yaml`。
2. `server.py`：lifespan 里新增 `_wait_for_engine()`——引擎 `/v1/models` 没答时**先等**
   （`JEV_ENGINE_WAIT`，默认 0，启动器传 60），而不是立刻 `refusing to start` 退出。
   自检仍然在等完之后跑，**不过照样拒绝启动**（那是真的不能用，不是还没热）。
3. 同文件补 `import time`（新函数用到）。
4. 新增 `prompt_source.py`，并把 `prompt.py` / `images.py` 改成从它 import。原因：上游这两个文件
   从 `infer_vllm.py` 取模板常量，而那个文件在顶层 import 了渲染器（Chromium / Node）——
   打分层不该把渲染器拖进应用。`prompt_source.py` 里每一行都与上游逐字相同（含
   `PROMPT_TEMPLATE_MD5` 的 import 时自检），只是搬了个位置。

其余文件（`scorer.py` / `selfcheck.py` / `backends/base.py` / `backends/llamacpp_backend.py`）
与上游一致，未改一行——分数口径靠的就是它们。`prompt.py` / `images.py` 只改了 import 来源（第 4 处），
逻辑未动。

## 口径提醒

`prob_1` 越大越"像原文"；**越低越可疑**。阈值与排序在 `book2text/core/project/jev_priority.py`，
不在这里。打分层只回答"这条候选与原图一致的概率是多少"。
