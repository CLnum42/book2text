"""刀 4 的 rules —— **在刀 3 的规则上继续扩展，不重写**。

继承链：`docs/refactor/evidence/pages/rules.py`（刀 1/2.5 的 INTERFACE / SET_BLOCKS / FORWARDERS…）
       → `docs/refactor/pages/knife3-rules.py`（刀 3 的 45 条 IDENT / 8 条 SETTERS / 1 条能力）
       → **本文件**（刀 4：12 个 mover 的注入名）。

刀 4 与刀 3 的一处**本质差别**（写进 knife4-plan.md §③，别用刀 3 的直觉套）：

    刀 3 搬的函数在外壳里**没有注入面**（它们不是 PagesView 的 deps 键），搬走后要**新加** deps；
    刀 4 的 12 个函数**早就以 deps 键的形式注入了模块**（`wireAll` 里写的是 `injected.applyPageZoom()`），
    所以本刀是**减**：删 deps 键 + 模块内 `injected.X` → `X` 直呼；只有 6 个仍被外壳调用的
    才需要新转发器（R8 +6，见 plan §⑧）。

用法：
  python3 docs/refactor/evidence/build_view.py \
    --movers docs/refactor/pages/knife4-movers.json \
    --rules  docs/refactor/pages/knife4-rules.py \
    --name Pages --app backend/book2text/static/app.js --out /tmp/k4-dry
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

_HERE = Path(__file__).resolve()
_K3 = _HERE.parent / "knife3-rules.py"       # 同目录：刀 3 的规则（它自己再 import 基规则）

_spec = importlib.util.spec_from_file_location("_b2t_k3_rules", _K3)
_k3 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_k3)

# ---- 原样继承 ----
INTERFACE = _k3.INTERFACE
SET_BLOCKS = _k3.SET_BLOCKS
SET_REWRITES = getattr(_k3, "SET_REWRITES", {})
MOVED_STATES = []                 # 刀 4 不搬状态（12 个 mover 都是函数）
INIT_ANCHOR = _k3.INIT_ANCHOR
FORWARDERS = _k3.FORWARDERS
RESIDUE_OK = getattr(_k3, "RESIDUE_OK", [])
SETTERS = list(getattr(_k3, "SETTERS", []))

#: 本刀搬走的 12 个函数（名单唯一出处是 json，不在这里手抄一遍）
_MOVERS = {
    entry["name"]
    for entry in json.loads((_HERE.parent / "knife4-movers.json").read_text(encoding="utf-8"))["movers"]
}

#: 模块里已有声明的名字（刀 1/2.5/3 搬进去的）**不许再注入**——与刀 3 同一口径。
_MODULE_SRC = _HERE.parents[3] / "backend" / "book2text" / "static" / "pages-view.js"
_MODULE_DECLARED: set[str] = set()
if _MODULE_SRC.is_file():
    _src = _MODULE_SRC.read_text(encoding="utf-8")
    _MODULE_DECLARED = set(re.findall(r"(?m)^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", _src))
    _MODULE_DECLARED |= set(re.findall(r"(?m)^\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)", _src))

#: 刀 4 新增的注入名（19 个：17 函数 + 2 常量）。
#: **由脚本从 12 个 mover 的函数体里扫出来**（顶层声明 − movers − 已在刀 1/2.5/3 规则里 − 模块已声明），
#: 不是手分的；形态规则沿用：function → 值，const → 值。
#: 本刀**没有新增 let 状态**，所以 SETTERS 不增（沿用刀 3 的 8 条），dry run 也没有"给 getter 赋值"。
IDENT_KNIFE4 = [
    ('PAGE_ZOOM_LEVELS', "injected.PAGE_ZOOM_LEVELS", "const"),
    ('RESTORE_DETAIL_TEXT', "injected.RESTORE_DETAIL_TEXT", "const"),
    ('applyRecognizedPages', "injected.applyRecognizedPages", "function"),
    ('closeFinishPanel', "injected.closeFinishPanel", "function"),
    ('closeModal', "injected.closeModal", "function"),
    ('confirmAction', "injected.confirmAction", "function"),
    ('ensurePageScrollListener', "injected.ensurePageScrollListener", "function"),
    ('ensureSuggestionScrollListener', "injected.ensureSuggestionScrollListener", "function"),
    ('forgetAllPageSuggestions', "injected.forgetAllPageSuggestions", "function"),
    ('humanTouchedPages', "injected.humanTouchedPages", "function"),
    ('loadPackageResults', "injected.loadPackageResults", "function"),
    ('marginJudgementOn', "injected.marginJudgementOn", "function"),
    ('pageImageUrl', "injected.pageImageUrl", "function"),
    ('pageZoomLevel', "injected.pageZoomLevel", "function"),
    ('renderMarginJudgementNotice', "injected.renderMarginJudgementNotice", "function"),
    ('resetOverlayQueue', "injected.resetOverlayQueue", "function"),
    ('scheduleSuggestionScan', "injected.scheduleSuggestionScan", "function"),
    ('splitBatchScope', "injected.splitBatchScope", "function"),
    ('warnUnconfirmed', "injected.warnUnconfirmed", "function"),
]

#: **跨视图能力（R2）**：`applyPackageMode` 体内有一处 `window.LibraryView?.notify(…)`。
#: 能力名 `libraryNotify` 只在这个文件里定义形态——deps 生成可变参闭包（见 build_view.deps_literal）。
CAPABILITIES = [
    ("libraryNotify", "(...args) => window.LibraryView?.notify(...args)"),
]
LIT = list(getattr(_k3, "LIT", [])) + [
    ("window.LibraryView?.notify(", "injected.libraryNotify?.("),
]


def _keep(entry):
    return entry[0] not in _MOVERS and entry[0] not in _MODULE_DECLARED


IDENT = [(old, new, *rest) for old, new, *rest in _k3.IDENT if _keep((old, new))] + [
    entry for entry in IDENT_KNIFE4 if _keep(entry)
]
IDENT_FULL = [(old, new, *rest) for old, new, *rest in _k3.IDENT_FULL if _keep((old, new))] + [
    entry for entry in IDENT_KNIFE4 if _keep(entry)
]
EXPECT_SEAMS = len(IDENT)
