# 刀2 的可机读名单（种子，按“谁让 R3 到期项到期”生成）

> 口径：`HEAD:app.js` 里仍引用 `view-pages` id 的函数（已排除刀1 的 19 个 movers）。剩余 **185 处 / 64 个函数**。

## 装配点（对 `view-pages` 的 DOM 接线 → 归模块 `init`，到期 = 刀2）

| 函数 | 处数 | 行范围 |
|---|---:|---|
| `setupLibrary` | 38 | 13496–13643（149 行） |
| `boot` | 8 | 15054–15308（256 行） |
| `setupRecognitionSettings` | 3 | 3319–3335（18 行） |
| `setupShell` | 2 | 1325–1366（43 行） |
| `setupPageNumberPanel` | 2 | 6829–6843（16 行） |
| `setupPageMore` | 2 | 7953–7979（28 行） |
| `setupCollabControls` | 2 | 14541–14558（19 行） |
| `setupExportPanel` | 1 | 2283–2319（38 行） |

装配点合计：**58 处 / 8 个函数**

## 其余 stays（刀3–5，按到期刀分配）

| 函数 | 处数 | 行范围 |
|---|---:|---|
| `applyPackageMode` | 21 | 14372–14431（61 行） |
| `renderRecognitionSettings` | 10 | 3238–3291（55 行） |
| `applyPageZoom` | 8 | 4784–4839（57 行） |
| `visiblePages` | 5 | 3592–3609（19 行） |
| `renderMarginStepVerdict` | 4 | 866–920（56 行） |
| `finishMarginDetectBar` | 4 | 7649–7657（10 行） |
| `showMarginFitProgress` | 3 | 799–808（11 行） |
| `applyPageRangeInput` | 3 | 3726–3747（23 行） |
| `updateRecognitionAuxProgress` | 3 | 5932–5949（19 行） |
| `renderPageNumberMetrics` | 3 | 6164–6206（44 行） |
| `checkSelection` | 3 | 7005–7034（31 行） |
| `showMarginDetectProgress` | 3 | 7580–7586（8 行） |
| `recognizeSelection` | 3 | 13429–13461（34 行） |
| `applySetupSuggestion` | 2 | 4372–4393（23 行） |
| `confirmPageIds` | 2 | 4396–4419（25 行） |
| `togglePageBlocksOverlay` | 2 | 4854–4867（15 行） |
| `ensureMarginAudit` | 2 | 5334–5381（49 行） |
| `confirmLayoutFromPanel` | 2 | 5685–5706（23 行） |
| `recognizePage` | 2 | 6937–6963（28 行） |
| `startBatchRecognition` | 2 | 6966–6986（22 行） |
| `startLayoutDetection` | 2 | 7398–7420（24 行） |
| `patchSelectedPages` | 2 | 13403–13426（25 行） |
| `applyProjectSettings` | 2 | 13668–13677（11 行） |
| `setAutoApplySetting` | 2 | 13830–13860（32 行） |
| `pausePageThumbnails` | 1 | 142–148（8 行） |
| `syncStepToggles` | 1 | 626–656（32 行） |
| `hideMarginFitProgressSoon` | 1 | 811–815（6 行） |
| `refreshMarginDetectHint` | 1 | 935–957（24 行） |
| `refreshLayoutDetectEntry` | 1 | 961–972（13 行） |
| `setRecognitionStatus` | 1 | 3223–3234（13 行） |
| `patchRecognitionSetting` | 1 | 3295–3316（23 行） |
| `ensureSuggestionScrollListener` | 1 | 3526–3533（9 行） |
| `scanVisiblePageSuggestions` | 1 | 3547–3584（39 行） |
| `openPageSetup` | 1 | 4215–4223（10 行） |
| `confirmSelectedPages` | 1 | 4422–4430（10 行） |
| `confirmAllUnconfirmed` | 1 | 4433–4444（13 行） |
| `pageScroller` | 1 | 4590–4591（3 行） |
| `capturePageTileMetrics` | 1 | 4594–4624（32 行） |
| `queueOverlayRender` | 1 | 4876–4885（11 行） |
| `pumpOverlayRender` | 1 | 4898–4929（33 行） |
| `toggleMarginView` | 1 | 5073–5087（16 行） |
| `setMarginStatus` | 1 | 5229–5240（13 行） |
| `startAuxiliaryAll` | 1 | 5906–5928（24 行） |
| `resetMarginsToAuto` | 1 | 5988–6056（70 行） |
| `setPageNumberStatus` | 1 | 6147–6158（13 行） |
| `loadPageNumberSummary` | 1 | 6227–6243（18 行） |
| `renderPageSummary` | 1 | 6850–6859（11 行） |
| `renderWorkflowFilter` | 1 | 7359–7388（31 行） |
| `startLayoutDetectFromDialog` | 1 | 7518–7546（30 行） |
| `loadFinishSummary` | 1 | 11643–11673（32 行） |
| `finishRevokeAutoPass` | 1 | 13224–13244（22 行） |
| `renderAutoApplyStatus` | 1 | 13711–13734（25 行） |
| `setMarginJudgementSetting` | 1 | 13867–13884（19 行） |
| `applySplitBatch` | 1 | 14045–14078（35 行） |
| `loadLanguageSummary` | 1 | 14646–14663（19 行） |
| `rerunAuxiliary` | 1 | 14672–14691（21 行） |
