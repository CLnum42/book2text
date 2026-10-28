"""派生缓存的"忙时复用"策略（任务 68）。

识别 / 复核在跑的时候，**每认完一页都会写一次库**。我们四个派生缓存的失效键是
"库内容签名"，于是签名每 3–5 秒变一次，四个缓存永远命不中：

| 请求 | 空闲 | 识别中（复用前） |
|---|---:|---:|
| `/review/finish-summary` | 5 ms | **760 ms** |
| `/review/marks?page=…` | 5 ms | **423 ms** |
| `/export/preview?segments_only=1` | 20 ms | 每次重算 |

这些数字全都是"因为一页 OCR 刚写完，整本重算"——对用户没有意义：识别期间用户看的
是"还有多少页没认完"，不是"这一页的字数变了没有"。

所以给它们一条**有界的**放宽规则：**只有当本项目确实有任务在跑、且缓存不超过
`MAX_AGE_SECONDS` 时**，才复用旧结果。任务一结束签名立刻稳定，马上回到实时。
过期上限 3 秒是刻意的：长任务里落后 3 秒看不见，而"永远读旧值"是另一类 bug。
"""

from __future__ import annotations

import time
from pathlib import Path

from . import jobs as jobs_module
from . import library as library_module

#: 有任务在跑时，派生结果允许复用的最长秒数
MAX_AGE_SECONDS = 10.0


_JOB_STATE: dict[str, tuple[float, bool]] = {}
"""项目 → (查询时刻, 有没有任务在跑)。

为什么记得住：识别写库时 SQLite 有写锁，每次请求都查任务表会在锁上等
（实测 finish-summary 因此出现 220–420 ms 毛刺）。任务动辄跑几十分钟，
"2 秒前查过"和"现在查"没有区别；而任务结束后最多多给 2 秒旧快照，
下一次请求就会重算成真实值。
"""

_JOB_STATE_TTL = 2.0


def job_running(project_id: str, library: Path) -> bool:
    """这个项目现在有没有识别 / 复核 / 版面任务在跑（结果记忆 2 秒）。"""
    now = time.monotonic()
    cached = _JOB_STATE.get(project_id)
    if cached and now - cached[0] < _JOB_STATE_TTL:
        return cached[1]
    try:
        directory = library_module.project_dir(library, project_id)
        running = bool(jobs_module.active_jobs(directory))
    except Exception:  # noqa: BLE001 - 任务表读不到就按"没在跑"处理（退回实时计算）
        running = False
    _JOB_STATE[project_id] = (now, running)
    return running


def can_reuse(project_id: str, library: Path, cached_at: float | None) -> bool:
    """缓存能否在"忙时"被复用：有任务在跑 **且** 缓存不过期（默认 10 秒）。"""
    if cached_at is None:
        return False
    if time.monotonic() - cached_at > MAX_AGE_SECONDS:
        return False
    return job_running(project_id, library)


def can_serve_stale(project_id: str, library: Path) -> bool:
    """有任务在跑时**一律**复用旧快照（不看年龄）。

    只给"整本重算很贵、而用户此刻并不需要实时值"的接口用（目前是收尾面板）。
    识别 662 页要 20–55 分钟，每认完一页都写库、每写一次都会让缓存失效；
    按 10 秒窗口复用等于每两三页就整本重算一次（662 页 340 ms–3.5 s），
    而它算出来的只是步骤条上几个此刻没人盯的数字。

    正确性边界：任务结束时签名稳定，第一次请求就会重算成真实值；
    响应里带 `stale: true` / `served_at`，界面上写「识别进行中，数据更新中…」。
    """
    return job_running(project_id, library)
