"""刀 5 的 rules —— 在刀 4 的规则上继续扩展（不改前几刀的规则，只加本刀的注入名）。

继承链：evidence/pages/rules.py（刀1/2.5）→ knife3-rules.py → knife4-rules.py → **本文件**。

本刀的形态与刀 3/4 都不同（写进 knife5-plan.md §③）：
  · 31 个函数**大部分不是 deps 键**（它们住 app.js 且被 app.js 调用），搬走后要**加** deps 键；
  · 少数是 deps 键（`wireAll` 里以 `injected.X` 引用）→ 搬完要**删**键 + 模块内直呼；
  · 4 个 let 状态随函数进入模块的读面，写点走 SETTERS（本刀新增 4 条）。

用法：
  python3 docs/refactor/evidence/build_view.py --movers docs/refactor/pages/knife5-movers.json \
    --rules docs/refactor/pages/knife5-rules.py --name Pages \
    --app backend/book2text/static/app.js --out /tmp/k5-dry
"""

from __future__ import annotations

import importlib.util, json, re
from pathlib import Path

_HERE = Path(__file__).resolve()
_K4 = _HERE.parent / "knife4-rules.py"
_spec = importlib.util.spec_from_file_location("_b2t_k4_rules", _K4)
_k4 = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_k4)

INTERFACE = _k4.INTERFACE
SET_BLOCKS = list(_k4.SET_BLOCKS) + [
    # 本刀两处多行写点：`timer = setTimeout(() => { … }, ms);`
    {"match": "marginStatusTimer = setTimeout(", "head": "const __marginStatusTimer = setTimeout(() => {",
     "after": "injected.setMarginStatusTimer(__marginStatusTimer);"},
    {"match": "pageNumberStatusTimer = setTimeout(", "head": "const __pageNumberStatusTimer = setTimeout(() => {",
     "after": "injected.setPageNumberStatusTimer(__pageNumberStatusTimer);"},
    {"match": "recStatusTimer = setTimeout(", "head": "const __recStatusTimer = setTimeout(() => {",
     "after": "injected.setRecStatusTimer(__recStatusTimer);"},
]
SET_REWRITES = getattr(_k4, "SET_REWRITES", {})
MOVED_STATES = []          # 本刀不搬状态声明（4 个 let 只搬读面，写点走 SETTERS）
INIT_ANCHOR = _k4.INIT_ANCHOR
FORWARDERS = _k4.FORWARDERS
RESIDUE_OK = getattr(_k4, "RESIDUE_OK", [])

_MOVERS = {e["name"] for e in json.loads((_HERE.parent / "knife5-movers.json").read_text(encoding="utf-8"))["movers"]}

_MODULE_SRC = _HERE.parents[3] / "backend" / "book2text" / "static" / "pages-view.js"
_MODULE_DECLARED: set[str] = set()
if _MODULE_SRC.is_file():
    _src = _MODULE_SRC.read_text(encoding="utf-8")
    _MODULE_DECLARED = set(re.findall(r"(?m)^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", _src))
    _MODULE_DECLARED |= set(re.findall(r"(?m)^\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)", _src))

#: 本刀新增注入名（由脚本从 31 个 mover 的函数体扫出：顶层声明 − movers − 已在前几刀规则 − 模块已声明）
IDENT_KNIFE5 = [
    ('PAGE_BLOCK_FETCH_LIMIT', "injected.PAGE_BLOCK_FETCH_LIMIT", "const"),
    ('pageBlockCacheOrder', "injected.pageBlockCacheOrder", "const"),
    ('pageSuggestionOrder', "injected.pageSuggestionOrder", "const"),
    ('jobStartPending', "injected.getJobStartPending()", "let"),
    ('marginStatusTimer', "injected.getMarginStatusTimer()", "let"),
    ('overlayPumpScheduled', "injected.getOverlayPumpScheduled()", "let"),
    ('pageNumberStatusTimer', "injected.getPageNumberStatusTimer()", "let"),
    ('firstUnfinishedPanel', "injected.firstUnfinishedPanel", "function"),
    ('matchesTriage', "injected.matchesTriage", "function"),
    ('matchesWorkflow', "injected.matchesWorkflow", "function"),
    ('savePageMarginPreference', "injected.savePageMarginPreference", "function"),
    ('savePageOverlayPreference', "injected.savePageOverlayPreference", "function"),
    ('setJobStartBusy', "injected.setJobStartBusy", "function"),
]

#: 本刀新增的 5 条 setter（5 个 let 状态的写点：jobStartPending×4 / marginStatusTimer 1 / overlayPumpScheduled 1 / pageNumberStatusTimer 1 / recStatusTimer 1）
SETTERS = list(getattr(_k4, "SETTERS", [])) + [
    ('jobStartPending', "setJobStartPending"),
    ('marginStatusTimer', "setMarginStatusTimer"),
    ('overlayPumpScheduled', "setOverlayPumpScheduled"),
    ('pageNumberStatusTimer', "setPageNumberStatusTimer"),
    ('recStatusTimer', "setRecStatusTimer"),
]

#: 跨视图能力（R2）：31 个函数体里有两处跨视图调用
CAPABILITIES = [
    ("indexRefresh", "window.IndexView?.refresh()"),
    ("libraryNotify", "(...args) => window.LibraryView?.notify(...args)"),
]
LIT = list(getattr(_k4, "LIT", [])) + [
    ("window.IndexView?.refresh()", "injected.indexRefresh?.()"),
    ("window.LibraryView?.notify(", "injected.libraryNotify?.("),
]


def _keep(entry):
    return entry[0] not in _MOVERS and entry[0] not in _MODULE_DECLARED

IDENT = [(o, n, *r) for o, n, *r in _k4.IDENT if _keep((o, n))] + [e for e in IDENT_KNIFE5 if _keep(e)]
IDENT_FULL = [(o, n, *r) for o, n, *r in _k4.IDENT_FULL if _keep((o, n))] + [e for e in IDENT_KNIFE5 if _keep(e)]
EXPECT_SEAMS = len(IDENT)
