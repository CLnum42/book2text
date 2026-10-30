"""刀 3 的 rules —— **只扩展刀 2.5 的规则，不重写**。

为什么是"扩展"而不是复制一份：
`docs/refactor/evidence/pages/rules.py` 里有刀 1/2.5 已验过的 INTERFACE(16) / SET_BLOCKS /
MOVED_STATES / INIT_ANCHOR / FORWARDERS，它们是**跨刀共用**的装配知识。复制一份出去，两份会漂。
所以这里用 importlib 把基规则读进来，只把「刀 3 的 15 个函数体里引用、但仍住在外壳的名字」
加进 IDENT（45 个：25 函数 + 15 let + 5 const），其余原样继承。

movers（15 个函数 + 行范围）不在这里：生成器用 `--movers docs/refactor/pages/knife3-movers.json` 传。

用法：
  python3 docs/refactor/evidence/build_view.py \
    --movers docs/refactor/pages/knife3-movers.json \
    --rules  docs/refactor/pages/knife3-rules.py \
    --name Pages --app backend/book2text/static/app.js --out /tmp/k3-dry
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_HERE = Path(__file__).resolve()
_BASE = _HERE.parents[1] / "evidence" / "pages" / "rules.py"   # docs/refactor/evidence/pages/rules.py

_spec = importlib.util.spec_from_file_location("_b2t_base_rules", _BASE)
_base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_base)

# ---- 原样继承（跨刀共用的装配知识）----
INTERFACE = _base.INTERFACE
SET_BLOCKS = _base.SET_BLOCKS
SET_REWRITES = getattr(_base, "SET_REWRITES", {})
MOVED_STATES = getattr(_base, "MOVED_STATES", [])      # 刀 3 没有"搬状态"，保持继承值
INIT_ANCHOR = _base.INIT_ANCHOR
FORWARDERS = _base.FORWARDERS
RESIDUE_OK = getattr(_base, "RESIDUE_OK", [])

#: 刀 3 新增的注入键（25 函数 + 15 let + 5 const），由脚本按声明形态生成，不是手分的。
#: 形态规则沿用 IDENT_FULL 头那两行：function → 值；let → injected.getX()；const → 值。
IDENT_KNIFE3 = [
    ('RECOGNITION_ENGINE_LABELS', "injected.RECOGNITION_ENGINE_LABELS", "const"),
    ('WORKFLOW_FILTERS', "injected.WORKFLOW_FILTERS", "const"),
    ('apiJson', "injected.apiJson", "function"),
    ('autoApplyTypeText', "injected.autoApplyTypeText", "function"),
    ('clearTileMargin', "injected.clearTileMargin", "function"),
    ('currentProject', "injected.getCurrentProject()", "let"),
    ('currentView', "injected.getCurrentView()", "let"),
    ('el', "injected.el", "const"),
    ('engineProbe', "injected.engineProbe", "function"),
    ('ensureMarginFitted', "injected.ensureMarginFitted", "function"),
    ('estimateRemainingSeconds', "injected.estimateRemainingSeconds", "function"),
    ('finishSummary', "injected.getFinishSummary()", "let"),
    ('finishSummaryAgain', "injected.getFinishSummaryAgain()", "let"),
    ('finishSummaryLoading', "injected.getFinishSummaryLoading()", "let"),
    ('finishSummaryProject', "injected.getFinishSummaryProject()", "let"),
    ('flushBootQueue', "injected.flushBootQueue", "function"),
    ('formatDuration', "injected.formatDuration", "function"),
    ('lastStepPanelKey', "injected.getLastStepPanelKey()", "let"),
    ('latestAutoApply', "injected.getLatestAutoApply()", "let"),
    ('layoutDetectActive', "injected.getLayoutDetectActive()", "let"),
    ('loadPageNumberMetrics', "injected.loadPageNumberMetrics", "function"),
    ('marginStepVerdict', "injected.marginStepVerdict", "function"),
    ('marginUndeterminedPages', "injected.marginUndeterminedPages", "function"),
    ('pageNumberAnalysis', "injected.getPageNumberAnalysis()", "let"),
    ('pagesMarginOn', "injected.getPagesMarginOn()", "let"),
    ('paintTileMargin', "injected.paintTileMargin", "function"),
    ('pendingPageCount', "injected.getPendingPageCount()", "let"),
    ('recognitionOf', "injected.recognitionOf", "function"),
    ('recognitionSetting', "injected.recognitionSetting", "function"),
    ('renderFinishPanel', "injected.renderFinishPanel", "function"),
    ('renderLayoutBlocks', "injected.renderLayoutBlocks", "function"),
    ('renderMarginPanel', "injected.renderMarginPanel", "function"),
    ('renderRecognitionStatus', "injected.renderRecognitionStatus", "function"),
    ('scheduleLayoutBlocks', "injected.scheduleLayoutBlocks", "function"),
    ('selectedPages', "injected.selectedPages", "const"),
    ('selectionPages', "injected.selectionPages", "function"),
    ('showError', "injected.showError", "function"),
    ('stepsReady', "injected.getStepsReady()", "let"),
    ('syncWorkflowSteps', "injected.syncWorkflowSteps", "function"),
    ('undoAutoApply', "injected.undoAutoApply", "function"),
    ('updateFinishChips', "injected.updateFinishChips", "function"),
    ('visiblePageNos', "injected.visiblePageNos", "const"),
    ('visiblePages', "injected.visiblePages", "function"),
    ('workflowConfirmationCounts', "injected.getWorkflowConfirmationCounts()", "let"),
    ('workflowStep', "injected.getWorkflowStep()", "let"),
]

#: **本刀搬走的函数必须从注入表里剔除**：搬进模块后由模块自己调用，再注入就是两份。
#: 生成器有 `movers ∩ IDENT 必须为空` 的守卫，这里按名单过滤是为了让守卫能过、且不留僵尸键。
_MOVERS = {
    entry["name"]
    for entry in json.loads(
        (_HERE.parent / "knife3-movers.json").read_text(encoding="utf-8")
    )["movers"]
}


#: **(b) 本刀函数体里的写点要补 SETTERS**（2026-10-30）：dry run 报「给 getter 赋值 9 处」，
#: 那意味着搬过去的函数体会直接对 `injected.getX()` 赋值——写不到真实状态上（bodyPending 那类静默错）。
#: 这 8 个名字（9 处）按 dry run 的错误串逐条取，不是手猜；setter 键名 = set + 驼峰。
#: **setter 不许进 IDENT**（2026-10-30 修正）：把这 8 个 setter 名当 function 写进 IDENT，
#: 会让 deps 生成成 `setFinishSummary: setFinishSummary`（自引用，app.js 里没有这个声明）→ 运行时才炸。
#: setter 的唯一出口是 SETTERS（deps_literal 会生成 `setX: (v) => { X = v; }`）。生成器已加守卫。

SETTERS = list(getattr(_base, "SETTERS", [])) + [
    ("finishSummary", "setFinishSummary"),
    ("finishSummaryAgain", "setFinishSummaryAgain"),
    ("finishSummaryLoading", "setFinishSummaryLoading"),
    ("finishSummaryProject", "setFinishSummaryProject"),
    ("lastStepPanelKey", "setLastStepPanelKey"),
    ("latestAutoApply", "setLatestAutoApply"),
    ("stepsReady", "setStepsReady"),
    ("currentView", "setCurrentView"),
]

#: **模块里已经自己声明的名字不许再注入**（两份实现会打架）：`el` 与刀 1 搬进去的
#: `ensureMarginFitted` / `renderLayoutBlocks` / `renderMarginPanel` / `renderRecognitionStatus`
#: 在 pages-view.js 顶层有声明，模块内裸引用就是对的。
#: 这 5 条是 dry run `injected_keys` 比计划多出来的全部来源——**不改计划去迁就它，而是把重复注入剔掉**。
_MODULE_SRC = (_HERE.parents[3] / "backend" / "book2text" / "static" / "pages-view.js")
_MODULE_DECLARED = set()
if _MODULE_SRC.is_file():
    _src = _MODULE_SRC.read_text(encoding="utf-8")
    import re as _re
    _MODULE_DECLARED = set(_re.findall(r"(?m)^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", _src))
    _MODULE_DECLARED |= set(_re.findall(r"(?m)^\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)", _src))


#: **syncStepToggles 体内有两处 `window.IndexView?.refresh()`**（Architect 裁定②：本刀照搬，注入 indexRefresh）。
#: 用 LIT 做字面量替换（不是 IDENT：它是表达式不是标识符）。
LIT = list(getattr(_base, "LIT", [])) + [
    ("window.IndexView?.refresh()", "injected.indexRefresh?.()"),
]

#: **跨视图能力必须有自己的出口**（R2）：CAPABILITIES 生成 `键: () => 表达式,`。
#: 2026-10-30 真事故：把 `indexRefresh` 当 function 写进 IDENT_FULL，deps 生成
#: `indexRefresh: indexRefresh,`（外壳没有这个声明）→ node --check 过、运行时才 TypeError；
#: Builder 只好在产品里手写成闭包才通过。能力的唯一出口是本表，生成器有「能力不得进 IDENT」守卫。
CAPABILITIES = [
    ("indexRefresh", "window.IndexView?.refresh()"),
]

IDENT = [(old, new, *rest) for old, new, *rest in _base.IDENT if old not in _MOVERS and old not in _MODULE_DECLARED] + [
    entry for entry in IDENT_KNIFE3 if entry[0] not in _MOVERS and entry[0] not in _MODULE_DECLARED
]
IDENT_FULL = [
    (old, new, *rest) for old, new, *rest in _base.IDENT_FULL if old not in _MOVERS and old not in _MODULE_DECLARED
] + [entry for entry in IDENT_KNIFE3 if entry[0] not in _MOVERS and entry[0] not in _MODULE_DECLARED]
EXPECT_SEAMS = len(IDENT)
