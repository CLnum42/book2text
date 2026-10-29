# `pages` 的 63 个转发器：谁在调、属于哪一类（DevLead 2026-10-29）

> **作废（2026-10-29，DevLead）**：本文的「无调用 20」口径不对——它**排除了 movers 之间的互调**，
> 于是只被模块内部调用的函数被算成"无调用"。按定死的口径复算见 `forwarders-recount.md`：
> **接线 12 / 流程 51 / 无调用 0 = 63**（63 个 mover 全部有调用者，不存在死代码）。
> 本文的接线/流程分栏也一并作废（同一原因）。
>
> **定死的口径（从此不再两种算法）**：
> ```
> 调用点 = 任何非自身位置的出现（含 movers 间互调、作为值传递、?. 调用）
> 无调用 = 调用点总数 0
> 接线 / 流程 = 只看「非 mover 的调用者」：
>              全在 {boot, setupShell, setupLibrary, setupPages, setup*} → 接线
>              任一在 stays / external → 流程
> ```
> **两个问题分开**：「它活着吗」看总数（含 movers 互调）；「谁该搬它」看非 mover 调用者。
> 混在一起就会得出 12/47/4 与 14/29/20 两个自洽答案。

**为什么有这张表**：落盘时发现转发器要调 `window.PagesView.<fn>`，而模块按 R8 只导出 `{init, enter}`。
A（加 `call()` 分发口）与 B（全导出）都不批，走 C：**先分类，接线类搬进 `init`、流程类做成具名域操作（目标 ≤6）**。

- 数据：`HEAD:app.js` 15,311 行 · 名单 movers 63
- 口径：调用点 = 该名字出现在**自己函数体之外**的 `名字(` 处；调用者 = 包住该行的那一层顶层函数；
  接线类 = `boot` / `setup*` / 出现在 `addEventListener` 那一行；其余算流程类。

## 0. 汇总

| 分类 | 个数 | 处理 |
|---|---:|---|
| 没有外部调用者（不需要转发器） | 20 | 无 |
| **接线类**（`boot` / `setup*`） | **14** | 那段接线搬进 `init`，转发器消失 |
| **流程类** | **29** | 做成具名域操作，**目标 ≤6** |

**结论：流程类 29 个，是目标 6 的 4.8 倍。**按裁决「超过 6 个就停手」——
**`pages` 的边界画错了**：这 63 个函数里有一大半本来就不该全归模块，或者调用它们的那些代码本该一起搬。
**在重画边界之前不落盘。**

## 1. 接线类（14）→ 接线搬进 init

| 函数 | 行数 | 调用者 |
|---|---:|---|
| `applyPageRangeInput` | 23 | `setupLibrary:13553` |
| `checkSelection` | 31 | `setupLibrary:13532` · `setupLibrary:13533` · `setupReviewControls:13301` |
| `openPageSetup` | 10 | `boot:15219` |
| `recognizeSelection` | 34 | `setupLibrary:13565` |
| `rerunAuxiliary` | 21 | `setupLibrary:13621` |
| `resetMarginsToAuto` | 70 | `renderMarginPanel:5448` · `renderMarginPanel:5498` |
| `savePageMarginPreference` | 7 | `boot:15114` · `boot:15166` · `boot:15291` |
| `savePageOverlayPreference` | 7 | `boot:15115` · `boot:15167` · `boot:15292` |
| `setAutoApplySetting` | 32 | `setupLibrary:13507` |
| `setupPageMore` | 28 | `boot:15298` |
| `setupRecognitionSettings` | 18 | `boot:15143` |
| `startBatchRecognition` | 22 | `setupLibrary:13560` · `setupLibrary:13590` |
| `toggleMarginView` | 16 | `boot:15169` · `boot:15294` |
| `togglePageBlocksOverlay` | 15 | `boot:15168` · `boot:15295` |

## 2. 流程类（29）→ 具名域操作，目标 ≤6

| 函数 | 行数 | 调用者（外壳/别的视图） | 建议 |
|---|---:|---|---|
| `applyRecognizedPages` | 8 | `recognizePage:6953` | |
| `capturePageTileMetrics` | 32 | `applyPageZoom:4838` · `updatePageVisibility:4662` | |
| `confirmPageIds` | 25 | `confirmAllUnconfirmed:4444` | |
| `ensureMarginAudit` | 49 | `renderMarginPanel:5490` | |
| `ensurePageSuggestion` | 18 | `refreshRecognizedPages:7262` · `updatePageVisibility:4687` | |
| `ensureSuggestionScrollListener` | 9 | `applyPageZoom:4832` | |
| `hideMarginFitProgressSoon` | 6 | `ensureMarginFitted:771` | |
| `loadLanguageSummary` | 19 | `showView:230` | |
| `loadSetupSuggestions` | 19 | `showView:235` | |
| `marginBasisForUndetermined` | 7 | `renderMarginPanel:5485` | |
| `pageLayoutLines` | 3 | `pageHasFitLines:679` | |
| `pageTextLines` | 3 | `pageHasFitLines:679` | |
| `pausePageThumbnails` | 8 | `showView:222` | |
| `pumpPageSuggestionQueue` | 31 | `showView:243` | |
| `renderLayoutBlocks` | 101 | `renderStepPanels:615` | |
| `renderPageSetup` | 28 | `renderPages:6883` · `showView:232` · `syncPageStates:6911` | |
| `renderPageSummary` | 11 | `renderPages:6867` · `syncPageStates:6910` | |
| `renderRecognitionVerdict` | 115 | `renderRecognitionStatus:5760` | |
| `resetOverlayQueue` | 4 | `applyPageZoom:4806` | |
| `scheduleLayoutBlocks` | 14 | `renderStepPanels:614` | |
| `scheduleSuggestionScan` | 4 | `applyPageZoom:4833` | |
| `selectionPages` | 3 | `renderMarginPanel:5414` | |
| `showMarginDetectProgress` | 8 | `startLayoutDetectFromDialog:7541` · `updateMarginDetectProgress:7556` | |
| `showMarginFitProgress` | 11 | `ensureMarginFitted:728` · `ensureMarginFitted:755` | |
| `startLayoutDetection` | 24 | `startLayoutDetectFromDialog:7526` | |
| `syncStepToggles` | 32 | `renderStepPanels:607` | |
| `trimMarginUndo` | 3 | `savePageMargin:5262` | |
| `updateSelectionPanel` | 167 | `renderPages:6884` · `syncPageStates:6912` | |
| `warnUnconfirmed` | 8 | `recognizePage:6940` | |

## 3. 没有外部调用者（20）：只在模块内部被调，不需要转发器

| 函数 | 行数 |
|---|---:|
| `applySetupSuggestion` | 23 |
| `auxEstimateText` | 7 |
| `confirmLayoutFromPanel` | 23 |
| `confirmSelectedPages` | 10 |
| `firstUnfinishedPanel` | 12 |
| `highConfidenceCount` | 3 |
| `initPanelAccordion` | 34 |
| `layoutBlockPageRecord` | 5 |
| `loadLayoutBlocks` | 40 |
| `pageSetupStats` | 17 |
| `patchRecognitionSetting` | 23 |
| `patchSelectedPages` | 25 |
| `renderSuggestionPanel` | 57 |
| `renderTypePicker` | 47 |
| `scanVisiblePageSuggestions` | 39 |
| `selectedSuggestions` | 4 |
| `setRecognitionStatus` | 13 |
| `startAuxiliaryAll` | 24 |
| `suggestionPagesByType` | 8 |
| `textLayerPages` | 4 |

## 4. 下一步（等裁决）

1. 14 个接线类：把调用点搬进 `init`（`library` 那刀就是这么解的），转发器整条删掉；
2. 29 个流程类：**先合族**——`margin*`（`ensureMarginAudit` / `marginBasisForUndetermined` / `trimMarginUndo` / `showMarginFit*`）
   其实是一个域；`suggestion*`（`ensurePageSuggestion` / `pumpPageSuggestionQueue` / `scheduleSuggestionScan` /
   `ensureSuggestionScrollListener`）是一个域；`candidate/selection*` 是一个域。合族之后大概率落到 5–7 个，
   **到那时候才决定要不要开第二个出口**，而不是现在开 63 个。
3. 如果合族后仍 >6：说明 `pages` 该拆成两个模块（页列渲染 / 版心识别），不是硬凑导出。
