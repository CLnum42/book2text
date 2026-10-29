# `pages` 转发器复算（第三份计算，判前两份谁错）

> 口径（Chief 2026-10-29 定死）：扫 `app.js` + 所有 `*-view.js`；排除函数自己的定义行；
> **`f(...)` 与「`f` 作为值传出去」都算调用点**；不计字符串里的同名。

## ① 三栏名单（对账 = 63）

接线类 **12**：`applyPageRangeInput`、`checkSelection`、`confirmLayoutFromPanel`、`confirmSelectedPages`、`openPageSetup`、`patchRecognitionSetting`、`recognizeSelection`、`rerunAuxiliary`、`setAutoApplySetting`、`setupRecognitionSettings`、`startAuxiliaryAll`、`startBatchRecognition`

流程类 **51**：`applyRecognizedPages`、`applySetupSuggestion`、`auxEstimateText`、`capturePageTileMetrics`、`confirmPageIds`、`ensureMarginAudit`、`ensurePageSuggestion`、`ensureSuggestionScrollListener`、`firstUnfinishedPanel`、`hideMarginFitProgressSoon`、`highConfidenceCount`、`initPanelAccordion`、`layoutBlockPageRecord`、`loadLanguageSummary`、`loadLayoutBlocks`、`loadSetupSuggestions`、`marginBasisForUndetermined`、`pageLayoutLines`、`pageSetupStats`、`pageTextLines`、`patchSelectedPages`、`pausePageThumbnails`、`pumpPageSuggestionQueue`、`renderLayoutBlocks`、`renderPageSetup`、`renderPageSummary`、`renderRecognitionVerdict`、`renderSuggestionPanel`、`renderTypePicker`、`resetMarginsToAuto`、`resetOverlayQueue`、`savePageMarginPreference`、`savePageOverlayPreference`、`scanVisiblePageSuggestions`、`scheduleLayoutBlocks`、`scheduleSuggestionScan`、`selectedSuggestions`、`selectionPages`、`setRecognitionStatus`、`setupPageMore`、`showMarginDetectProgress`、`showMarginFitProgress`、`startLayoutDetection`、`suggestionPagesByType`、`syncStepToggles`、`textLayerPages`、`toggleMarginView`、`togglePageBlocksOverlay`、`trimMarginUndo`、`updateSelectionPanel`、`warnUnconfirmed`

无调用 **0**：（空）

## ② 与 `forwarder-callers.md` 的**名字集合**差异

| 栏 | 我 | 它 | 仅我 | 仅它 |
|---|---:|---:|---|---|
| 接线类 | 12 | 12 | `confirmLayoutFromPanel`、`confirmSelectedPages`、`startAuxiliaryAll` | `setupPageMore`、`toggleMarginView`、`togglePageBlocksOverlay` |
| 流程类 | 51 | 47 | `scanVisiblePageSuggestions`、`setupPageMore`、`toggleMarginView`、`togglePageBlocksOverlay` | （无） |
| 无调用 | 0 | 4 | （无） | `confirmLayoutFromPanel`、`confirmSelectedPages`、`scanVisiblePageSuggestions`、`startAuxiliaryAll` |

## ③ 那 4 个「无调用」逐个验：**它们都有调用，只是写成值**

| 函数 | 真实调用点 | 形态 |
|---|---|---|
| `confirmLayoutFromPanel` | `app.js:13588` | `el("layout-block-confirm").addEventListener("click", confirmLayoutFromPanel)` |
| `confirmSelectedPages` | `app.js:13636` | `el("setup-confirm-selected").addEventListener("click", confirmSelectedPages)` |
| `scanVisiblePageSuggestions` | `app.js:3544` | `suggestionScanTimer = setTimeout(scanVisiblePageSuggestions, 60)` |
| `startAuxiliaryAll` | `app.js:13591` | `el("rec-aux-all").addEventListener("click", startAuxiliaryAll)` |

**结论：`forwarder-callers.md` 的「无调用 4」是漏检，不是死代码。** 它只扫了 `fn(`，漏掉
`addEventListener(…, fn)` 与 `setTimeout(fn, …)` 这种**值位置**——和今天 `19 vs 21` 写点数是同一类漏法。
**这 4 个不是死代码，63 个 movers 一个都不能因此减掉。**

## ④ 我这栏的已知缺陷（先自报，别当结论用）

`接线类 / 流程类` 的归属依赖「调用点属于哪个顶层函数」。我这次用的是 `}` 收尾的行范围匹配，
**嵌套函数会归错**——例如 `toggleMarginView` 的调用点是 `setupLibrary:13586` / `boot:15169` / `boot:15294`
（全是一次性接线），却被分到流程类。**所以两栏的分界目前不可信，需要按括号配对的函数边界重算。**

→ **可用的结论只有两条**：① 63 个 mover 全部有调用者（不存在死代码）；② 「无调用 4」是漏检。
→ **接线/流程 的最终分栏，等我把 `owner()` 换成括号配对后再出一版**，这版不用于决定搬谁。

## ⑤ 哪份作废

- `forwarders.md`（我第一版）作废：它的「无调用 20」是因为**排除掉 movers 间互调**，口径不对；
- `forwarder-callers.md` 的「无调用 4」作废：值位置漏检；它的 12/47 分栏暂留（等 §④ 重算后定）。
