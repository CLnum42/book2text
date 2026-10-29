# `pages` 转发器复算（第三份计算，判前两份谁错）

> **定死的口径（从此不再有第二种算法）**：
> ```
> 调用点 = 任何非自身位置的出现（含 movers 间互调、作为值传递、?. 调用）
> 无调用 = 调用点总数 0
> 接线 / 流程 = 只看「非 mover 的调用者」：
>              全在 {boot, setupShell, setupLibrary, setupPages, setup*} → 接线
>              任一在 stays / external → 流程
> ```
> **两个问题两个口径**：「它活着吗」看总数（含 movers 互调）；「谁该搬它」看非 mover 调用者。
> 混在一起就会得出 `12/47/4` 与 `14/29/20` 两个自洽答案——今天对账的差异全部来自这一条。
>
> 扫 `app.js` + 所有 `*-view.js`；排除函数自己的定义行；
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
（全是一次性接线），却被分到流程类。

**接线/流程分栏：已知缺陷（行范围用 `}` 匹配，嵌套函数会归错），不作判据、也不重算。**
该分类原本只为在 `call()` 与域操作之间二选一，**那条路已否**；现在按 `pages-plan.md` 的 5 个语义操作走
（哪几个函数一起搬），**判据是名单，不是分栏**。

→ **可用的结论只有两条**：① 63 个 mover 全部有调用者（不存在死代码）；② 「无调用 4」是漏检。
→ **接线/流程的分栏不再出下一版**：分类路线已撤销（见上），这版不作为任何判据。

## ⑤ 哪份作废

- `forwarders.md`（我第一版）作废：它的「无调用 20」是因为**排除掉 movers 间互调**，口径不对；
- `forwarder-callers.md` 的「无调用 4」作废：值位置漏检；它的 12/47 分栏**同样不作判据**（分栏路线已撤销）。
## ⑥ 写死这一句（今天第三次踩同一个坑）

```
调用点必须扫「值位置」：addEventListener(..., f) / requestAnimationFrame(f) / 回调参数 / ?. 调用
只扫 `f(` 会把一整类调用漏掉 —— 今天三次栽在这里（review 闭包、pages 转发器、本表）
```

前两次：`review` 的闭包按「名字出现在括号里」算，漏掉事件处理器（6 个 / 105 行）；
`33 个符号按前缀 grep`，漏掉 `project-list` / `create-progress`。**这次是第三类：值位置。**
