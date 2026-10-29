# 刀2–5 的可机读名单（按“谁让 R3 到期项到期”，每函数带刀号）

> 口径：`HEAD:app.js` 里仍引用 `view-pages` id 的函数（已排除刀1 的 19 个 movers）。**67 个函数 / 197 处**。
> 刀号规则：装配点→刀2；渲染/加载/同步/可见性→刀3；确认/采纳/版心/建议/选择→刀4；批量/识别等→刀5。

## 刀2（9 个函数 / 59 处）

| 函数 | 处数 | 行范围 | 到期刀 |
|---|---:|---|---|
| `boot` | 8 | 15054–15308（256 行） | 刀2 |
| `setupCollabControls` | 2 | 14541–14558（19 行） | 刀2 |
| `setupExportPanel` | 1 | 2283–2319（38 行） | 刀2 |
| `setupLibrary` | 38 | 13496–13643（149 行） | 刀2 |
| `setupPageMore` | 2 | 7953–7979（28 行） | 刀2 |
| `setupPageNumberPanel` | 2 | 6829–6843（16 行） | 刀2 |
| `setupRecognitionSettings` | 3 | 3319–3335（18 行） | 刀2 |
| `setupReviewControls` | 1 | 13265–13399（136 行） | 刀2 |
| `setupShell` | 2 | 1325–1366（43 行） | 刀2 |

## 刀3（15 个函数 / 40 处）

| 函数 | 处数 | 行范围 | 到期刀 |
|---|---:|---|---|
| `loadFinishSummary` | 1 | 11643–11673（32 行） | 刀3 |
| `loadLanguageSummary` | 1 | 14646–14663（19 行） | 刀3 |
| `loadPageNumberSummary` | 1 | 6227–6243（18 行） | 刀3 |
| `refreshLayoutDetectEntry` | 1 | 961–972（13 行） | 刀3 |
| `refreshMarginDetectHint` | 1 | 935–957（24 行） | 刀3 |
| `renderAutoApplyStatus` | 1 | 13711–13734（25 行） | 刀3 |
| `renderMarginStepVerdict` | 4 | 866–920（56 行） | 刀3 |
| `renderPageNumberMetrics` | 3 | 6164–6206（44 行） | 刀3 |
| `renderPageSummary` | 1 | 6850–6859（11 行） | 刀3 |
| `renderRecognitionSettings` | 10 | 3238–3291（55 行） | 刀3 |
| `renderStepPanels` | 10 | 558–617（61 行） | 刀3 |
| `renderWorkflowFilter` | 1 | 7359–7388（31 行） | 刀3 |
| `syncStepToggles` | 1 | 626–656（32 行） | 刀3 |
| `updateFinishChips` | 1 | 11620–11632（14 行） | 刀3 |
| `updateRecognitionAuxProgress` | 3 | 5932–5949（19 行） | 刀3 |

## 刀4（12 个函数 / 48 处）

| 函数 | 处数 | 行范围 | 到期刀 |
|---|---:|---|---|
| `applyPackageMode` | 21 | 14372–14431（61 行） | 刀4 |
| `applyPageRangeInput` | 3 | 3726–3747（23 行） | 刀4 |
| `applyPageZoom` | 8 | 4784–4839（57 行） | 刀4 |
| `applyProjectSettings` | 2 | 13668–13677（11 行） | 刀4 |
| `applySetupSuggestion` | 2 | 4372–4393（23 行） | 刀4 |
| `applySplitBatch` | 1 | 14045–14078（35 行） | 刀4 |
| `confirmAllUnconfirmed` | 1 | 4433–4444（13 行） | 刀4 |
| `confirmLayoutFromPanel` | 2 | 5685–5706（23 行） | 刀4 |
| `confirmPageIds` | 2 | 4396–4419（25 行） | 刀4 |
| `confirmSelectedPages` | 1 | 4422–4430（10 行） | 刀4 |
| `recognizePage` | 2 | 6937–6963（28 行） | 刀4 |
| `recognizeSelection` | 3 | 13429–13461（34 行） | 刀4 |

## 刀5（31 个函数 / 50 处）

| 函数 | 处数 | 行范围 | 到期刀 |
|---|---:|---|---|
| `capturePageTileMetrics` | 1 | 4594–4624（32 行） | 刀5 |
| `checkSelection` | 3 | 7005–7034（31 行） | 刀5 |
| `ensureMarginAudit` | 2 | 5334–5381（49 行） | 刀5 |
| `ensureSuggestionScrollListener` | 1 | 3526–3533（9 行） | 刀5 |
| `finishMarginDetectBar` | 4 | 7649–7657（10 行） | 刀5 |
| `finishRevokeAutoPass` | 1 | 13224–13244（22 行） | 刀5 |
| `hideMarginFitProgressSoon` | 1 | 811–815（6 行） | 刀5 |
| `openPageSetup` | 1 | 4215–4223（10 行） | 刀5 |
| `pageScroller` | 1 | 4590–4591（3 行） | 刀5 |
| `patchRecognitionSetting` | 1 | 3295–3316（23 行） | 刀5 |
| `patchSelectedPages` | 2 | 13403–13426（25 行） | 刀5 |
| `pausePageThumbnails` | 1 | 142–148（8 行） | 刀5 |
| `pumpOverlayRender` | 1 | 4898–4929（33 行） | 刀5 |
| `queueOverlayRender` | 1 | 4876–4885（11 行） | 刀5 |
| `rerunAuxiliary` | 1 | 14672–14691（21 行） | 刀5 |
| `resetMarginsToAuto` | 1 | 5988–6056（70 行） | 刀5 |
| `scanVisiblePageSuggestions` | 1 | 3547–3584（39 行） | 刀5 |
| `setAutoApplySetting` | 2 | 13830–13860（32 行） | 刀5 |
| `setMarginJudgementSetting` | 1 | 13867–13884（19 行） | 刀5 |
| `setMarginStatus` | 1 | 5229–5240（13 行） | 刀5 |
| `setPageNumberStatus` | 1 | 6147–6158（13 行） | 刀5 |
| `setRecognitionStatus` | 1 | 3223–3234（13 行） | 刀5 |
| `showMarginDetectProgress` | 3 | 7580–7586（8 行） | 刀5 |
| `showMarginFitProgress` | 3 | 799–808（11 行） | 刀5 |
| `startAuxiliaryAll` | 1 | 5906–5928（24 行） | 刀5 |
| `startBatchRecognition` | 2 | 6966–6986（22 行） | 刀5 |
| `startLayoutDetectFromDialog` | 1 | 7518–7546（30 行） | 刀5 |
| `startLayoutDetection` | 2 | 7398–7420（24 行） | 刀5 |
| `toggleMarginView` | 1 | 5073–5087（16 行） | 刀5 |
| `togglePageBlocksOverlay` | 2 | 4854–4867（15 行） | 刀5 |
| `visiblePages` | 5 | 3592–3609（19 行） | 刀5 |


## 刀 5 的执行形态（2026-10-29 裁定：不拆刀，但分多批落盘）

**按处数把 31 个函数劈成两刀是错的**——同一批代码动两遍，风险比压在一刀里更高。
判据是「**同一类改动要一起做**」，不是「每刀处数一样多」。

```
刀 5 不拆；豁免表的 stage 仍是 5，不新增刀号
每批落盘后，R3 剩余处数必须严格下降（判据现成）
31 个函数名单已逐个列出，分批照着切
```

**效果**：`刀 5 = 0` 不再是押在末尾的一注，而是**在刀 5 内部逐批逼近**；风险从"最后一把 blast radius"变成"每次一小步、每步有下降判据"。

## 报告数的规矩（本条因本文件而生）

- 本版 **67 函数 / 197 处**，上一版 64 / 185：**增量是口径补全**（`setupXxx` 前缀的装配函数全数纳入），**不是漂移**。
- 以后报数必须带一句「**比上一版多了什么、为什么**」，否则下一个人会当成漂。
- **省略号不能当名单用**：要名单就逐个列，列不出就是还没想清楚。
