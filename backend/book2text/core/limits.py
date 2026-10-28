"""后台重活对 CPU 的占用上限（任务 68）。

识别 / 复核跑在独立子进程里，但 onnxruntime 默认把**所有核**开满：662 页英文书实测，
识别期间界面请求从 5 ms 掉到 357 ms、取页图 126 ms → 260 ms，用户感觉"应用卡了"。

这里的规则只有一条：**后台重活最多用 `cpu_count - 2` 个线程，并降低一档优先级**，
把核留给界面。两边都要设，因为它们互不认识：

- `ONNX Runtime` 只认 `SessionOptions.intra_op_num_threads`（经 RapidOCR 的
  `EngineConfig.onnxruntime.intra_op_num_threads` 传进去）；
- numpy / OpenBLAS / MKL / Accelerate 只认各自的环境变量（在 spawn 之前设，子进程继承）。
"""

from __future__ import annotations

import os

#: 至少给界面留几个核（多核机器不用留太多）
UI_RESERVED_CORES = 2


def worker_thread_count() -> int:
    """后台重活可用的线程数：总核数 - 给界面留的核，至少 1。"""
    total = os.cpu_count() or 2
    reserve = min(UI_RESERVED_CORES, max(1, total - 1))
    return max(1, total - reserve)
