"""`pages` 切片的注入规则表（`IDENT` 函数表 + `STATES` 状态表），**自校验，不靠人眼**。

按 `docs/refactor/evidence/pages/movers.json`（HEAD 树，movers 63 / stays 67 / external 9）派生：
接缝 = movers 的函数体里引用、但不在 movers 内的**顶层声明**（`git show HEAD:<path>` 取源码，不读工作区）。

用法：
    python3 docs/refactor/evidence/pages/rules.py        # 三条自检 + 分类分布，红则 exit 1

## 两个已知的假阳性（上一刀踩过，写在这里挡人）

① **写点正则会把声明行本身算成一处写点**（`let x = …` 命中 `x =`）。所以「只读」不能判
   `writePoints == 0`，要判「**除声明行以外没有写点**」——本文件里 `STATES` 的第 3 列就是
   **已扣掉声明行**的写点数。review 那一刀有 5 个只读状态被误判成「搬进模块」，就是没扣。

② **查询串里的 `?token=` 会被当成赋值**：`(?<![\w$.])NAME\s*=(?!=)` 在
   `…?token=${encodeURIComponent(token)}` 上命中。本文件数写点前先 `strip_js(line)` 抹掉字符串
   **内容**（保留模板 `${…}` 里的表达式），并对 `?&=` 也加进后视黑名单。

## 形态与处理（Chief 2026-10-29 定，判据是「谁负责写，谁持有」）

| 形态 | 写点分布 | 处理 |
|---|---|---|
| `const` | 无写点 | **注入值** `injected.NAME`——是值，不是 getter |
| `let` | 除声明外无写点 | 注入 `getX`（只读） |
| `let` | 写点全在 `stays`/`external`/外壳 | 注入 `getX/setX`，**状态留外壳** |
| `let` | 写点全在 `movers` | **搬进模块**，声明随搬，同批改 `OWNERS` |
| `let` | 写点跨 `movers` 与别的区 | 注入 `getX/setX`，**模块不存副本** |
| `const f = (…) =>` | — | 按**函数**处理（进 `IDENT`），`el` 就是这一类 |

## `el` 的位置（名单与形态不一致的一条）

`movers.json` 的 `states_and_consts` 是 **46 条**（只有名字，没有形态），其中 `el` 是
`const el = (id) => …` —— **函数，不是状态**。所以本文件把它放进 `IDENT`，`STATES` 是 45 条；
**46 = 45 + `el`**，条数没丢，只是归到对的那张表（69 个 mover 调它，按状态注入会写成 getter，调用即炸）。

## 一个必须说清的数：接缝是 38 个，不是 53 个

`movers 63 / 1,522` 之外，被 movers 引用、但不在 movers 里的顶层声明共 **83 个**：
**函数 38 个**（含 `el`）+ **状态/常量 45 个**。
Chief 转来的「接缝 53 / 1,282」按本定义复现不出来；我用三种口径各算了一遍：

| 口径 | 个数 | 行数 |
|---|---:|---:|
| movers 引用、不在 movers 内的顶层函数（本文件采用） | 38 | 785 |
| 同上但按「(调用者, 被调用者) 边」计 | 102 | — |
| 闭包（movers+stays+external）引用、闭包外的函数 | 80 | 1,490 |

53 / 1,282 一个都对不上。**落盘前请 Architect 指认它用的是哪一口径**；本文件按第一行那张
（可复跑、定义写在上面）走，`--expect-seams` 可核。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
REL_APP = "backend/book2text/static/app.js"
REL_MOVERS = "docs/refactor/evidence/pages/movers.json"

# ---------------------------------------------------------------- 注入表

#: `(app.js 里的名字, 注入表达式, 形态)`；形态只有 function 一类时也留着，方便落盘时对表。
IDENT = [
    ('adoptBlockSuggestion', 'injected.adoptBlockSuggestion', 'function'),
    ('apiJson', 'injected.apiJson', 'function'),
    ('applyProjectSettings', 'injected.applyProjectSettings', 'function'),
    ('clearPageBlocks', 'injected.clearPageBlocks', 'function'),
    ('clearTileMargin', 'injected.clearTileMargin', 'function'),
    ('fetchPageSuggestions', 'injected.fetchPageSuggestions', 'function'),
    ('forgetPageSuggestions', 'injected.forgetPageSuggestions', 'function'),
    ('formatDuration', 'injected.formatDuration', 'function'),
    ('loadFinishSummary', 'injected.loadFinishSummary', 'function'),
    ('loadTasks', 'injected.loadTasks', 'function'),
    ('marginBodyPages', 'injected.marginBodyPages', 'function'),
    ('marginBoxOfPage', 'injected.marginBoxOfPage', 'function'),
    ('notifyApplied', 'injected.notifyApplied', 'function'),
    ('openTaskDrawer', 'injected.openTaskDrawer', 'function'),
    ('pageHasFitLines', 'injected.pageHasFitLines', 'function'),
    ('pageMarginMethod', 'injected.pageMarginMethod', 'function'),
    ('pageMarginStorageKey', 'injected.pageMarginStorageKey', 'function'),
    ('pageOverlayStorageKey', 'injected.pageOverlayStorageKey', 'function'),
    ('pageScroller', 'injected.pageScroller', 'function'),
    ('parsePageRange', 'injected.parsePageRange', 'function'),
    ('queueOverlayRender', 'injected.queueOverlayRender', 'function'),
    ('recognitionOf', 'injected.recognitionOf', 'function'),
    ('refreshMarginTiles', 'injected.refreshMarginTiles', 'function'),
    ('refreshPageStates', 'injected.refreshPageStates', 'function'),
    ('renderMarginPanel', 'injected.renderMarginPanel', 'function'),
    ('renderPages', 'injected.renderPages', 'function'),
    ('renderProjectMeta', 'injected.renderProjectMeta', 'function'),
    ('renderRecognitionSettings', 'injected.renderRecognitionSettings', 'function'),
    ('renderRecognitionStatus', 'injected.renderRecognitionStatus', 'function'),
    ('renderStepPanels', 'injected.renderStepPanels', 'function'),
    ('renderTask', 'injected.renderTask', 'function'),
    ('schedulePageVisibility', 'injected.schedulePageVisibility', 'function'),
    ('setMarginStatus', 'injected.setMarginStatus', 'function'),
    ('showError', 'injected.showError', 'function'),
    ('showView', 'injected.showView', 'function'),
    ('startTaskPolling', 'injected.startTaskPolling', 'function'),
    ('visiblePages', 'injected.visiblePages', 'function'),
]

#: `(名字, 形态, 除声明行外的写点数, 写点归属, 处理)`；`—` 表示除声明外没有写点。
STATES = [
    ('AUX_SECONDS_PER_PAGE', 'const', 0, '—', '注入值'),
    ('AUX_TEXT_LAYER_SECONDS_PER_PAGE', 'const', 0, '—', '注入值'),
    ('BLOCK_TYPE_LABELS', 'const', 0, '—', '注入值'),
    ('PAGE_SUGGESTION_CONCURRENCY', 'const', 0, '—', '注入值'),
    ('PAGE_TYPE_LABELS', 'const', 0, '—', '注入值'),
    ('PAGE_TYPE_ORDER', 'const', 0, '—', '注入值'),
    ('RECOGNITION_LABELS', 'const', 0, '—', '注入值'),
    ('currentProject', 'let', 2, 'shell', '注入 get（外壳持有）'),
    ('currentView', 'let', 1, 'stays', '注入 get（外壳持有）'),
    ('finishSummary', 'let', 2, 'shell+stays', '注入 get（外壳持有）'),
    ('finishSummaryProject', 'let', 2, 'shell+stays', '注入 get（外壳持有）'),
    ('lastTaskData', 'let', 2, 'shell+stays', '注入 get（外壳持有）'),
    ('layoutBlockLoading', 'let', 3, 'movers', '搬进模块'),
    ('layoutBlockPage', 'let', 2, 'movers', '搬进模块'),
    ('layoutBlockPayload', 'let', 5, 'movers', '搬进模块'),
    ('marginAuditLoading', 'let', 2, 'movers', '搬进模块'),
    ('marginAuditPage', 'let', 2, 'movers+shell', '注入 get/set（跨区）'),
    ('marginFitRunning', 'let', 2, 'stays', '注入 get（外壳持有）'),
    ('marginFitTried', 'const', 0, '—', '注入值'),
    ('marginUndoStack', 'const', 0, '—', '注入值'),
    ('overlayRenderQueue', 'const', 0, '—', '注入值'),
    ('overlayRenderQueued', 'const', 0, '—', '注入值'),
    ('pageSuggestionActive', 'let', 0, '—', '注入 get（只读）'),
    ('pageSuggestionCache', 'const', 0, '—', '注入值'),
    ('pageSuggestionFailed', 'const', 0, '—', '注入值'),
    ('pageSuggestionPending', 'const', 0, '—', '注入值'),
    ('pageSuggestionQueue', 'const', 0, '—', '注入值'),
    ('pageTileMetrics', 'let', 7, 'movers+shell+stays', '注入 get/set（跨区）'),
    ('pageZoomIndex', 'let', 6, 'shell', '注入 get（外壳持有）'),
    ('pagesMarginOn', 'let', 7, 'movers+shell', '注入 get/set（跨区）'),
    ('pagesOverlayOn', 'let', 5, 'movers+shell', '注入 get/set（跨区）'),
    ('panelAccordionProject', 'let', 1, 'movers', '搬进模块'),
    ('projectSummary', 'let', 2, 'shell', '注入 get（外壳持有）'),
    ('recStatusTimer', 'let', 1, 'movers', '搬进模块'),
    ('selectedPages', 'const', 0, '—', '注入值'),
    ('selectionAnchor', 'let', 8, 'movers+shell', '注入 get/set（跨区）'),
    ('setupSuggestions', 'let', 4, 'movers+shell', '注入 get/set（跨区）'),
    ('setupSuggestionsLoaded', 'let', 2, 'movers+shell', '注入 get/set（跨区）'),
    ('setupSuggestionsLoading', 'let', 2, 'movers', '搬进模块'),
    ('suggestionScanQueued', 'let', 1, 'movers', '搬进模块'),
    ('suggestionScanTimer', 'let', 2, 'movers', '搬进模块'),
    ('suggestionScrollListening', 'let', 1, 'movers', '搬进模块'),
    ('taskJobId', 'let', 2, 'stays', '注入 get（外壳持有）'),
    ('visiblePageNos', 'const', 0, '—', '注入值'),
    ('workflowStep', 'let', 5, 'shell', '注入 get（外壳持有）'),
]


# ---------------------------------------------------------------- 生成器输入（build_view.py 直接读本文件）

#: `el` 是模块自建的（`const el = (id) => document.getElementById(id)`，与 app.js 第 28 行逐字相同），
#: **不进注入面**——它不需要外壳提供任何东西。列在这里是为了挡住"怎么没注入 el"的疑问。
MODULE_LOCAL = ["el"]

#: 写点全在 movers 的状态：**声明搬进模块、app.js 删掉**。
#: 判据是 app.js 里"声明消失"——两份状态比没搬更坏，而且没有任何静态门能发现。
MOVED_STATES = [
    "layoutBlockLoading",
    "layoutBlockPage",
    "layoutBlockPayload",
    "marginAuditLoading",
    "panelAccordionProject",
    "recStatusTimer",
    "setupSuggestionsLoading",
    "suggestionScanQueued",
    "suggestionScanTimer",
    "suggestionScrollListening",
]

#: 写点跨区的状态：`x = v;` → `injected.setX(v);`
SETTERS = [
    ("marginFitRunning", "setMarginFitRunning"),   # 刀1：模块正文里有写点（反证抓到），外壳持有
    ("marginAuditPage", "setMarginAuditPage"),
    ("pageTileMetrics", "setPageTileMetrics"),
    ("pagesMarginOn", "setPagesMarginOn"),
    ("pagesOverlayOn", "setPagesOverlayOn"),
    ("selectionAnchor", "setSelectionAnchor"),
    ("setupSuggestions", "setSetupSuggestions"),
    ("setupSuggestionsLoaded", "setSetupSuggestionsLoaded"),
]

#: 单行但自引用（`x = !x`）：setter 表达不了，逐行点名改。
SET_REWRITES = {
    "pagesMarginOn = !pagesMarginOn;": "injected.setPagesMarginOn(!injected.getPagesMarginOn());",
    "pagesOverlayOn = !pagesOverlayOn;": "injected.setPagesOverlayOn(!injected.getPagesOverlayOn());",
}

#: 多行赋值：先算到局部，再 `injected.setX(局部);`
SET_BLOCKS = [
    {"match": "pageTileMetrics = tiles.map(", "head": "const __pageTileMetrics = tiles.map((tile) => {",
     "after": "injected.setPageTileMetrics(__pageTileMetrics);"},
]


def _cap(name: str) -> str:
    return name[0].upper() + name[1:]


#: 生成器真正用的注入表 = 函数（IDENT）＋ 所有不搬走的状态。
#: `const` → **值** `injected.NAME`（写成 getter 是错的：library 第一版就这么错过）；
#: `let` → `injected.getX()`；写点跨区的另外还要 `SETTERS`（写在下面的表里）。
IDENT_FULL = list(IDENT) + [
    (name, "injected." + name if action.startswith("注入值") else "injected.get" + _cap(name) + "()")
    for name, _kind, _writes, _by, action in STATES
    if action != "搬进模块"
]

# ---------------------------------------------------------------- 装配（生成器用）

#: 模块对外接口：只有 init / enter（调用点：boot 的 `setupLibrary();` 之后 init 一次；
#: 切回目录页时 `window.PagesView.enter()`）。**不加第三个**——导出棘轮只降不升，没有调用点的导出不许加（§20.1）。
INTERFACE = """
  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    return api;
  }

  /** 进入目录视图：按当前项目与筛选重画页列（重绘幂等，可反复调）。
   *  `renderPages` 在 stays（被 clearPageSelection / handleTileClick 等外壳流程调用）→ 走注入。 */
  function enter() {
    injected.renderPages();
    return true;
  }

  const api = { init, enter };
  window.PagesView = api;
"""

#: 让生成器把 app.js 里 63 个函数体换成转发（保住 async），并在 `setupLibrary();` 之后调 init 一次。
FORWARDERS = True
INIT_ANCHOR = "boot();"

# ---- 刀 1 的跨刀能力注入（其余四刀的入口：模块只调用，不搬）----
IDENT_CROSS_SLICE = [
    ("applyPageZoom", "injected.applyPageZoom", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("applySetupSuggestion", "injected.applySetupSuggestion", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("applyTileState", "injected.applyTileState", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("auxEstimateText", "injected.auxEstimateText", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("buildTile", "injected.buildTile", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("capturePageTileMetrics", "injected.capturePageTileMetrics", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("ensureMarginAudit", "injected.ensureMarginAudit", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("ensurePageSuggestion", "injected.ensurePageSuggestion", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("estimateRemainingSeconds", "injected.estimateRemainingSeconds", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("fetchPageBlocks", "injected.fetchPageBlocks", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("forgetPageBlocks", "injected.forgetPageBlocks", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("formatMarginBox", "injected.formatMarginBox", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("hideMarginFitProgressSoon", "injected.hideMarginFitProgressSoon", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("highConfidenceCount", "injected.highConfidenceCount", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("initPanelAccordion", "injected.initPanelAccordion", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("layoutBlockPageRecord", "injected.layoutBlockPageRecord", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("loadPageDetail", "injected.loadPageDetail", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("marginBasisForUndetermined", "injected.marginBasisForUndetermined", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("marginFitSummaryText", "injected.marginFitSummaryText", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("marginPagesWithoutLines", "injected.marginPagesWithoutLines", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("marginSourceText", "injected.marginSourceText", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("marginUndeterminedPages", "injected.marginUndeterminedPages", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("marginUndoButton", "injected.marginUndoButton", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("mergePageRecord", "injected.mergePageRecord", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("pageBlockKey", "injected.pageBlockKey", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("pageMarginSourceLabel", "injected.pageMarginSourceLabel", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("pageSetupStats", "injected.pageSetupStats", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("paintTileMargin", "injected.paintTileMargin", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("patchSelectedPages", "injected.patchSelectedPages", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("percentText", "injected.percentText", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("pumpPageBlockPrefetch", "injected.pumpPageBlockPrefetch", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("refreshLayoutDetectEntry", "injected.refreshLayoutDetectEntry", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("refreshMarginDetectHint", "injected.refreshMarginDetectHint", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("reloadDetailAfterRecognition", "injected.reloadDetailAfterRecognition", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("renderMarginStepVerdict", "injected.renderMarginStepVerdict", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("renderPageBlocks", "injected.renderPageBlocks", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("renderPageSummary", "injected.renderPageSummary", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("repaintTileMargin", "injected.repaintTileMargin", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("resetMarginsToAuto", "injected.resetMarginsToAuto", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("scheduleLayoutBlocks", "injected.scheduleLayoutBlocks", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("scheduleOverlayPump", "injected.scheduleOverlayPump", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("selectNextPage", "injected.selectNextPage", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("selectedSuggestions", "injected.selectedSuggestions", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("selectionPages", "injected.selectionPages", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("showMarginDetectProgress", "injected.showMarginDetectProgress", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("showMarginFitProgress", "injected.showMarginFitProgress", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("suggestionPagesByType", "injected.suggestionPagesByType", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("textLayerPages", "injected.textLayerPages", "function"),   # 刀1 依赖（刀2-5 未搬）
    ("trimMarginUndo", "injected.trimMarginUndo", "function"),   # 刀1 依赖（刀2-5 未搬）
]

IDENT = IDENT + IDENT_CROSS_SLICE
IDENT_FULL = IDENT_FULL + IDENT_CROSS_SLICE   # 生成器读的是 IDENT_FULL，这里必须一起加

# ---- 刀 1 的 pages 私有数据：**模块自己持有**（注入 = 外壳一份、模块一份，libraryProjects 那次的起点）----
MOVED_STATES += ["PAGE_OVERLAY_FRAME_LIMIT", "detailPageNo", "pageBlockCache", "pageBlockPending"]

EXPECT_SEAMS = 86   # 37 基础 + 49 跨刀能力（刀 1 依赖刀 2-5 的入口）      # 函数接缝（**不含 el**：el 是模块自建，见 MODULE_LOCAL）
EXPECT_STATES = 45     # 状态/常量；46 = 45 + el（el 在 IDENT 里）
EXPECT_TOTAL = 46      # 名单 states_and_consts 的条数


def git_show(path: str) -> str:
    """**只认 HEAD 树**：工作区是多人共享的，随时会被别人改写。"""
    result = subprocess.run(["git", "show", f"HEAD:{path}"], cwd=REPO, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"✗ git show HEAD:{path} 失败：{result.stderr.strip()}")
    return result.stdout


def strip_js(line: str) -> str:
    """抹掉字符串内容，保留模板 `${…}` 里的表达式（token 只出现在那里）。"""
    line = re.sub(r"`[^`]*`", "``", line)
    line = re.sub(r"\"(?:[^\"\\]|\\.)*\"", "\"\"", line)
    line = re.sub(r"'(?:[^'\\]|\\.)*'", "''", line)
    return re.sub(r"//[^\n]*", "", line)


def functions_of(source: str) -> dict[str, int]:
    lines = source.split("\n")
    out = {}
    for match in re.finditer(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", source, re.M):
        start = source.count("\n", 0, match.start()) + 1
        end = start
        while end < len(lines) and lines[end] != "}":
            end += 1
        out[match.group(1)] = (start, end + 1)
    return out


def decl_kind(source: str, name: str) -> tuple[str, int]:
    """顶层声明的形态与行号：function / const / let（`const f = (…) =>` 判成 function）。"""
    for index, line in enumerate(source.split("\n"), 1):
        if re.match(rf"^(?:async\s+)?function\s+{re.escape(name)}\s*\(", line):
            return "function", index
        match = re.match(rf"^(const|let|var)\s+{re.escape(name)}\s*=", line)
        if match:
            return ("function" if "=>" in line else match.group(1)), index
    return "?", -1


def write_points(source: str, name: str) -> list[int]:
    pattern = re.compile(r"(?<![\w$?.&=])" + re.escape(name) + r"\s*=(?!=)")
    return [i for i, line in enumerate(source.split("\n"), 1) if pattern.search(strip_js(line))]


def main() -> int:
    source = git_show(REL_APP)
    raw = json.loads(git_show(REL_MOVERS))
    lines = source.split("\n")
    fns = functions_of(source)
    zones = {z: {x["name"]: x for x in raw[z]} for z in ("movers", "stays", "external")}
    movers = zones["movers"]
    owner: dict[int, str] = {}
    for zone in ("movers", "stays", "external"):
        for record in zones[zone].values():
            for i in range(record["start"], record["end"] + 1):
                owner[i] = zone

    problems: list[str] = []

    # ① 每个 IDENT 键都能在 HEAD app.js 里找到来源
    for name, expr, form in IDENT:
        kind, line = decl_kind(source, name)
        if kind == "?":
            problems.append(f"① {name} 在 HEAD app.js 里找不到声明——IDENT 有僵尸项")
        elif kind != form:
            problems.append(f"① {name} 形态不符：表里 {form} / 源码 {kind}（第 {line} 行）")

    # ② 46 个 states_and_consts 一个不漏：45 状态 + el（在 IDENT 里）
    listed = {e["name"] for e in raw["states_and_consts"]["entries"]}
    covered = {row[0] for row in STATES} | {name for name, _, _ in IDENT if name in listed} | set(MODULE_LOCAL)
    if len(listed) != EXPECT_TOTAL:
        problems.append(f"② 名单 states_and_consts 是 {len(listed)} 条，不是 {EXPECT_TOTAL}——名单变了，规则表要重算")
    if listed != covered:
        problems.append(f"② 名单与规则表对不上：名单多 {sorted(listed - covered)} / 规则表多 {sorted(covered - listed)}")
    if len(STATES) != EXPECT_STATES:
        problems.append(f"② STATES 是 {len(STATES)} 条，应为 {EXPECT_STATES}")
    if len(IDENT) != EXPECT_SEAMS:
        problems.append(f"② IDENT 是 {len(IDENT)} 个，应为 {EXPECT_SEAMS}——接缝数变了要写进切片文档")

    # ③ 搬进模块的那些：写点逐条验，必须在 movers 里，不许抽样
    for name, kind, _, _, action in STATES:
        if action != "搬进模块":
            continue
        _, decl_line = decl_kind(source, name)
        for i in write_points(source, name):
            if i == decl_line:
                continue
            if owner.get(i) != "movers":
                where = owner.get(i) or "外壳（不在三区）"
                problems.append(f"③ {name} 判成「搬进模块」，但第 {i} 行的写点在 {where}——搬走就断")

    from collections import Counter
    dist = Counter(row[4] for row in STATES)
    print(f"IDENT {len(IDENT)} 个函数接缝（含 el）· STATES {len(STATES)} 条状态/常量 · 名单 {EXPECT_TOTAL} 条 = 45 + el")
    for action, count in sorted(dist.items()):
        print(f"  {action}: {count}")
    if problems:
        print("\n✗ 自检失败：")
        for item in problems:
            print("  " + item)
        return 1
    print("\n✓ 三条自检全过：① IDENT 全部有来源 ② 46 条一个不漏 ③ 搬进模块的写点全在 movers 里")
    return 0


if __name__ == "__main__":
    sys.exit(main())
