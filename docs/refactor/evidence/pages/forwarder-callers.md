# `pages` 63 个转发器：调用者与性质（只读分析，不动代码）

> 基线：`HEAD`，`app.js` = 15,311 行；名单来自 `movers.json` 的 63 个 movers（= 落盘时生成的 63 条转发器）。
> **两个问题、两个口径（别混用）**：
> - **调用点** = 任何非自身位置的出现（含 movers 之间互调、值传递、`?.`）→ 用来回答"它是不是死代码"；
> - **无调用** = 上述总数 == 0；
> - **接线 / 流程** = 只看**非 mover** 的调用者 → 用来回答"它被外壳还是被模块内部驱动"。
>
> 混用的后果：把 movers 互调当成"外壳在调"，47 个流程类会凭空变多；把值传递漏扫，"无调用"会假报 4 个。
>
> 判据（Chief 2026-10-29）：**接线类**（初始化/绑事件时调一次）→ 接线可搬进 `init`，转发器消失；**流程类**（外壳流程在调）→ 能力要变成**具名域操作**。

## 结论（先说数）

| 性质 | 个数 | 含义 |
|---|---:|---|
| **接线类** | **12** | 调用点全在 `setup*` / `boot` / `setupShell` 里 → 那段接线搬进 `init` 即可，转发器消失 |
| **流程类** | **47** | 被 `stays` / `external` / 外壳流程调用 → **转发器形态不成立**，要变成具名域操作（注入） |
| 无调用 | **4** | 名单内外零调用 → 复核后按死代码处理 |
| 合计 | **63** | 对账：12+47+4 = 63 ✅ |

**判据触发：流程类 = 47 > 6 → 按 Chief 的规则，这条明确写着「边界画错了」。**

**错在哪**：把「只有 C 内函数引用」当成「能搬的叶子」，但 `pages` 的渲染函数大量被 `stays` 里的外壳流程（`renderPages` / `loadPages` / `openPages` / `confirmCurrentPage` 等）调用。
**转发器假设的是「app.js 只剩薄转发、逻辑全在模块」，而这些调用者本身搬不动**——于是转发器只能去调模块内部函数，才撞上 `window.PagesView.<fn>` 是 `undefined`。

**正确形状**：
- **接线类 12 个**：接线搬进 `init`，转发器**整个删掉**（不是改成 `call()`）；
- **流程类 47 个**：**不做转发器**，走注入——模块 `init(deps)` 里拿到具名域操作（如 `applyRecognizedPages` → `deps.applyRecognizedPages`），外壳保留真实现；
- **无调用 4 个**：先复核是否死代码（今天已两次栽在"零引用= 死"的误判上，要逐个人工确认）。

## 逐条表（63 行）

| # | 转发器 | 调用点（文件:行 → 所在函数） | 调用者所在区 | 性质 |
|---:|---|---|---|---|
| 1 | `applyPageRangeInput` | app.js:13553→`setupLibrary`(外壳/其他) | 外壳/其他 | 接线类 |
| 2 | `checkSelection` | app.js:13301→`setupReviewControls`(外壳/其他)、app.js:13532→`setupLibrary`(外壳/其他)、app.js:13533→`setupLibrary`(外壳/其他) | 外壳/其他 | 接线类 |
| 3 | `openPageSetup` | app.js:15219→`boot`(外壳/其他) | 外壳/其他 | 接线类 |
| 4 | `patchRecognitionSetting` | app.js:3321→`setupRecognitionSettings`(movers)、app.js:3326→`setupRecognitionSettings`(movers)、app.js:3331→`setupRecognitionSettings`(movers)、app.js:3334→`setupRecognitionSettings`(movers) | movers | 接线类 |
| 5 | `recognizeSelection` | app.js:13565→`setupLibrary`(外壳/其他) | 外壳/其他 | 接线类 |
| 6 | `rerunAuxiliary` | app.js:13621→`setupLibrary`(外壳/其他) | 外壳/其他 | 接线类 |
| 7 | `setAutoApplySetting` | app.js:13507→`setupLibrary`(外壳/其他) | 外壳/其他 | 接线类 |
| 8 | `setupPageMore` | app.js:15298→`boot`(外壳/其他) | 外壳/其他 | 接线类 |
| 9 | `setupRecognitionSettings` | app.js:15143→`boot`(外壳/其他) | 外壳/其他 | 接线类 |
| 10 | `startBatchRecognition` | app.js:13560→`setupLibrary`(外壳/其他)、app.js:13590→`setupLibrary`(外壳/其他) | 外壳/其他 | 接线类 |
| 11 | `toggleMarginView` | app.js:15169→`boot`(外壳/其他)、app.js:15294→`boot`(外壳/其他) | 外壳/其他 | 接线类 |
| 12 | `togglePageBlocksOverlay` | app.js:15168→`boot`(外壳/其他)、app.js:15295→`boot`(外壳/其他) | 外壳/其他 | 接线类 |
| 13 | `confirmLayoutFromPanel` | **无** | — | 无调用 |
| 14 | `confirmSelectedPages` | **无** | — | 无调用 |
| 15 | `scanVisiblePageSuggestions` | **无** | — | 无调用 |
| 16 | `startAuxiliaryAll` | **无** | — | 无调用 |
| 17 | `applyRecognizedPages` | app.js:6953→`recognizePage`(stays)、app.js:6980→`startBatchRecognition`(movers)、app.js:7028→`checkSelection`(movers)、app.js:13455→`recognizeSelection`(movers) | movers/stays | 流程类 |
| 18 | `applySetupSuggestion` | app.js:4356→`renderSuggestionPanel`(movers) | movers | 流程类 |
| 19 | `auxEstimateText` | app.js:5827→`renderRecognitionVerdict`(movers) | movers | 流程类 |
| 20 | `capturePageTileMetrics` | app.js:4662→`updatePageVisibility`(stays)、app.js:4838→`applyPageZoom`(stays) | stays | 流程类 |
| 21 | `confirmPageIds` | app.js:4430→`confirmSelectedPages`(movers)、app.js:4444→`confirmAllUnconfirmed`(stays) | movers/stays | 流程类 |
| 22 | `ensureMarginAudit` | app.js:5490→`renderMarginPanel`(stays) | stays | 流程类 |
| 23 | `ensurePageSuggestion` | app.js:3580→`scanVisiblePageSuggestions`(movers)、app.js:4687→`updatePageVisibility`(stays)、app.js:7262→`refreshRecognizedPages`(stays) | movers/stays | 流程类 |
| 24 | `ensureSuggestionScrollListener` | app.js:4832→`applyPageZoom`(stays) | stays | 流程类 |
| 25 | `firstUnfinishedPanel` | app.js:4193→`initPanelAccordion`(movers) | movers | 流程类 |
| 26 | `hideMarginFitProgressSoon` | app.js:771→`ensureMarginFitted`(stays) | stays | 流程类 |
| 27 | `highConfidenceCount` | app.js:5603→`renderLayoutBlocks`(movers) | movers | 流程类 |
| 28 | `initPanelAccordion` | app.js:4155→`renderPageSetup`(movers) | movers | 流程类 |
| 29 | `layoutBlockPageRecord` | app.js:5524→`scheduleLayoutBlocks`(movers)、app.js:5591→`renderLayoutBlocks`(movers)、app.js:5686→`confirmLayoutFromPanel`(movers) | movers | 流程类 |
| 30 | `loadLanguageSummary` | app.js:230→`showView`(stays) | stays | 流程类 |
| 31 | `loadLayoutBlocks` | app.js:5535→`scheduleLayoutBlocks`(movers)、app.js:5700→`confirmLayoutFromPanel`(movers) | movers | 流程类 |
| 32 | `loadSetupSuggestions` | app.js:235→`showView`(stays)、app.js:4220→`openPageSetup`(movers)、app.js:4389→`applySetupSuggestion`(movers)、app.js:4416→`confirmPageIds`(movers) | movers/stays | 流程类 |
| 33 | `marginBasisForUndetermined` | app.js:5352→`ensureMarginAudit`(movers)、app.js:5485→`renderMarginPanel`(stays) | movers/stays | 流程类 |
| 34 | `pageLayoutLines` | app.js:679→`pageHasFitLines`(stays)、app.js:5327→`marginBasisForUndetermined`(movers) | movers/stays | 流程类 |
| 35 | `pageSetupStats` | app.js:3767→`updateSelectionPanel`(movers)、app.js:4140→`renderPageSetup`(movers) | movers | 流程类 |
| 36 | `pageTextLines` | app.js:679→`pageHasFitLines`(stays)、app.js:5327→`marginBasisForUndetermined`(movers) | movers/stays | 流程类 |
| 37 | `patchSelectedPages` | app.js:4308→`renderTypePicker`(movers) | movers | 流程类 |
| 38 | `pausePageThumbnails` | app.js:222→`showView`(stays) | stays | 流程类 |
| 39 | `pumpPageSuggestionQueue` | app.js:243→`showView`(stays)、app.js:3485→`ensurePageSuggestion`(movers) | movers/stays | 流程类 |
| 40 | `renderLayoutBlocks` | app.js:615→`renderStepPanels`(stays)、app.js:5528→`scheduleLayoutBlocks`(movers)、app.js:5532→`scheduleLayoutBlocks`(movers)、app.js:5543→`loadLayoutBlocks`(movers) | movers/stays | 流程类 |
| 41 | `renderPageSetup` | app.js:232→`showView`(stays)、app.js:6883→`renderPages`(stays)、app.js:6911→`syncPageStates`(stays) | stays | 流程类 |
| 42 | `renderPageSummary` | app.js:6867→`renderPages`(stays)、app.js:6910→`syncPageStates`(stays) | stays | 流程类 |
| 43 | `renderRecognitionVerdict` | app.js:5760→`renderRecognitionStatus`(stays) | stays | 流程类 |
| 44 | `renderSuggestionPanel` | app.js:3858→`updateSelectionPanel`(movers)、app.js:4154→`renderPageSetup`(movers)、app.js:4231→`loadSetupSuggestions`(movers)、app.js:4241→`loadSetupSuggestions`(movers) | movers | 流程类 |
| 45 | `renderTypePicker` | app.js:3857→`updateSelectionPanel`(movers)、app.js:4153→`renderPageSetup`(movers)、app.js:4242→`loadSetupSuggestions`(movers) | movers | 流程类 |
| 46 | `resetMarginsToAuto` | app.js:5448→`renderMarginPanel`(stays)、app.js:5498→`renderMarginPanel`(stays) | stays | 流程类 |
| 47 | `resetOverlayQueue` | app.js:4806→`applyPageZoom`(stays)、app.js:4862→`togglePageBlocksOverlay`(movers) | movers/stays | 流程类 |
| 48 | `savePageMarginPreference` | app.js:5075→`toggleMarginView`(movers)、app.js:15114→`boot`(外壳/其他)、app.js:15166→`boot`(外壳/其他)、app.js:15291→`boot`(外壳/其他) | movers/外壳/其他 | 流程类 |
| 49 | `savePageOverlayPreference` | app.js:4856→`togglePageBlocksOverlay`(movers)、app.js:15115→`boot`(外壳/其他)、app.js:15167→`boot`(外壳/其他)、app.js:15292→`boot`(外壳/其他) | movers/外壳/其他 | 流程类 |
| 50 | `scheduleLayoutBlocks` | app.js:614→`renderStepPanels`(stays)、app.js:3903→`updateSelectionPanel`(movers) | movers/stays | 流程类 |
| 51 | `scheduleSuggestionScan` | app.js:3515→`pumpPageSuggestionQueue`(movers)、app.js:4833→`applyPageZoom`(stays) | movers/stays | 流程类 |
| 52 | `selectedSuggestions` | app.js:4254→`suggestionPagesByType`(movers)、app.js:4319→`renderSuggestionPanel`(movers) | movers | 流程类 |
| 53 | `selectionPages` | app.js:1348→`setupShell`(外壳/其他)、app.js:3756→`updateSelectionPanel`(movers)、app.js:4268→`renderTypePicker`(movers)、app.js:4423→`confirmSelectedPages`(movers) | movers/stays/外壳/其他 | 流程类 |
| 54 | `setRecognitionStatus` | app.js:3311→`patchRecognitionSetting`(movers)、app.js:3314→`patchRecognitionSetting`(movers) | movers | 流程类 |
| 55 | `showMarginDetectProgress` | app.js:7541→`startLayoutDetectFromDialog`(stays)、app.js:7556→`updateMarginDetectProgress`(stays) | stays | 流程类 |
| 56 | `showMarginFitProgress` | app.js:728→`ensureMarginFitted`(stays)、app.js:755→`ensureMarginFitted`(stays) | stays | 流程类 |
| 57 | `startLayoutDetection` | app.js:7526→`startLayoutDetectFromDialog`(stays) | stays | 流程类 |
| 58 | `suggestionPagesByType` | app.js:4278→`renderTypePicker`(movers) | movers | 流程类 |
| 59 | `syncStepToggles` | app.js:607→`renderStepPanels`(stays) | stays | 流程类 |
| 60 | `textLayerPages` | app.js:5838→`renderRecognitionVerdict`(movers)、app.js:5898→`auxEstimateText`(movers) | movers | 流程类 |
| 61 | `trimMarginUndo` | app.js:5262→`savePageMargin`(stays)、app.js:6000→`resetMarginsToAuto`(movers) | movers/stays | 流程类 |
| 62 | `updateSelectionPanel` | app.js:4152→`renderPageSetup`(movers)、app.js:6884→`renderPages`(stays)、app.js:6912→`syncPageStates`(stays) | movers/stays | 流程类 |
| 63 | `warnUnconfirmed` | app.js:6940→`recognizePage`(stays)、app.js:6972→`startBatchRecognition`(movers)、app.js:13433→`recognizeSelection`(movers) | movers/stays | 流程类 |

## 对账

- 总数 = 63（= `movers.json` 的 movers 数）
- 接线类 12 / 流程类 47 / 无调用 4，三者相加 = 63 ✅
- 每个转发器的调用点都来自 `HEAD` 树（`git show HEAD:...app.js`），不看工作区

## 一句话

**63 个转发器里只有 12 个该存在（接线类），47 个不该以转发器形态存在。**这不是"多写了几行"，是"把搬不动的调用者当成了搬得动的叶子"——
**转发器是结果，边界判断才是原因。**
