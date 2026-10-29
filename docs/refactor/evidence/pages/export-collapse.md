# 导出收敛名单（export-collapse）

> **扫描时点：`c7c0c57` 的树（`app.js` 14,387 行）· 导出集合 = 19（含 4 个刀2 待删死面）。**
> **刀 2 落盘后必须用同一脚本重扫（导出 16），函数集合可能减少——届时更新本表。**
> 不写这句，刀 2 落盘后这份表就是旧快照，而它会被当成施工清单用。


> 判据一（覆盖性）：本文件函数集合 == 「外壳里调用任一 `PagesView` 导出名的函数」；判据二（收敛性）：每刀导出数严格下降，刀5 结束 == 3（enter/render/refresh）。

> 实测：导出名 19 个；调用它们的函数 **31** 个 / 47 处；刀分布 {'刀5': 15, '刀3': 4, '刀4': 12}。

| 函数 | 调了哪些导出 | 调用点行号 | 刀号 |
|---|---|---|---|
| `applyHeaderFooter` | `reloadProjectPages` | 1702 | 刀4 |
| `applyPageRangeInput` | `renderPages` | 3674 | 刀4 |
| `applyPageZoom` | `updatePageVisibility` | 4352 | 刀4 |
| `applySetupSuggestion` | `loadSetupSuggestions`、`renderPages` | 4002, 4003 | 刀4 |
| `checkSelection` | `renderPages` | 6009 | 刀5 |
| `clearPageSelection` | `renderPages` | 3617 | 刀5 |
| `confirmAllMargins` | `ensureMarginFitted` | 853 | 刀4 |
| `confirmLayoutFromPanel` | `loadLayoutBlocks` | 4924 | 刀4 |
| `confirmPageIds` | `loadSetupSuggestions`、`renderPages` | 4028, 4030 | 刀4 |
| `controlJob` | `reloadProjectPages` | 6765 | 刀5 |
| `finishShowFallbackPages` | `renderPages` | 11951 | 刀5 |
| `handleTileClick` | `renderPages` | 3628 | 刀4 |
| `onMarginPointerUp` | `savePageMargin` | 4700 | 刀5 |
| `openPageSetup` | `loadSetupSuggestions`、`renderPages` | 3953, 3954 | 刀5 |
| `patchSelectedPages` | `loadSetupSuggestions`、`renderPages` | 12350, 12352 | 刀5 |
| `pollTask` | `refreshRecognizedPages`、`syncPageStates`、`updateMarginDetectProgress` | 6131, 6142, 6163, 6184 | 刀5 |
| `recognizePage` | `renderPages` | 5924, 5942 | 刀4 |
| `recognizeSelection` | `renderPages` | 12385 | 刀4 |
| `refreshMarginState` | `ensureMarginFitted`、`renderMarginPanel` | 5153, 5154 | 刀3 |
| `refreshPageStates` | `syncPageStates` | 6240 | 刀3 |
| `renderProject` | `renderPages` | 2859 | 刀3 |
| `renderStepPanels` | `ensureMarginFitted`、`renderLayoutBlocks`、`renderMarginPanel`、`renderRecognitionStatus` | 609, 610, 615, 617 | 刀3 |
| `resetMarginsToAuto` | `renderMarginPanel` | 5081, 5112 | 刀5 |
| `scheduleLayoutBlocks` | `loadLayoutBlocks`、`renderLayoutBlocks` | 4891, 4895, 4898 | 刀5 |
| `schedulePageVisibility` | `updatePageVisibility` | 4257 | 刀5 |
| `selectAllVisiblePages` | `renderPages` | 3609 | 刀4 |
| `selectNextPage` | `renderPages` | 5040 | 刀4 |
| `showView` | `loadSetupSuggestions`、`renderPageSetup` | 232, 235 | 刀5 |
| `startBatchRecognition` | `renderPages` | 5961 | 刀5 |
| `toggleMarginView` | `renderMarginPanel` | 4600 | 刀5 |
| `waitForAuxThenReview` | `renderRecognitionStatus` | 1020 | 刀5 |
