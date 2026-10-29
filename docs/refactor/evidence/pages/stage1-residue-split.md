# 刀一 `residue 53` 的分类（数据归谁谁持有；能力跨刀才注入）

干跑读数：movers 19 · moved 1090 行 · module 1206 行 · residue 53 · anti 1

## ① 数据（4 个）→ **搬进模块**，不是注入

判据：它们是 pages 的运行时数据/常量；注入 = 外壳一份、模块一份（`libraryProjects` 那次的教训）。

| 名字 | 形态 |
|---|---|
| `PAGE_OVERLAY_FRAME_LIMIT` | const |
| `detailPageNo` | let |
| `pageBlockCache` | map/let |
| `pageBlockPending` | map/let |

## ② 能力（49 个）→ **走 IDENT 注入**，模块只调用

判据：它们是其余四刀的入口/工具函数，不属于本刀；搬进来等于把别刀的能力一起吞掉。

`applyPageZoom`, `applySetupSuggestion`, `applyTileState`, `auxEstimateText`, `buildTile`, `capturePageTileMetrics`, `ensureMarginAudit`, `ensurePageSuggestion`, `estimateRemainingSeconds`, `fetchPageBlocks`, `forgetPageBlocks`, `formatMarginBox`, `hideMarginFitProgressSoon`, `highConfidenceCount`, `initPanelAccordion`, `layoutBlockPageRecord`, `loadPageDetail`, `marginBasisForUndetermined`, `marginFitSummaryText`, `marginPagesWithoutLines`, `marginSourceText`, `marginUndeterminedPages`, `marginUndoButton`, `mergePageRecord`, `pageBlockKey`, `pageMarginSourceLabel`, `pageSetupStats`, `paintTileMargin`, `patchSelectedPages`, `percentText`, `pumpPageBlockPrefetch`, `refreshLayoutDetectEntry`, `refreshMarginDetectHint`, `reloadDetailAfterRecognition`, `renderMarginStepVerdict`, `renderPageBlocks`, `renderPageSummary`, `repaintTileMargin`, `resetMarginsToAuto`, `scheduleLayoutBlocks`, `scheduleOverlayPump`, `selectNextPage`, `selectedSuggestions`, `selectionPages`, `showMarginDetectProgress`, `showMarginFitProgress`, `suggestionPagesByType`, `textLayerPages`, `trimMarginUndo`

## ③ `anti 1` 定位：**真漏，不是范围过宽**

```
给 getter 赋值 2 处（injected.getMarginFitRunning() =）——写点没走 setter，这是 SETTERS 漏项
```
`marginFitRunning` 在 rules.py 的分类是「注入 get（外壳持有）」，**没有 setter**；
但刀一里有一处**在模块正文内**给它赋值（`injected.getMarginFitRunning() =`）。
→ 修法：把它加进 `SETTERS`（`('marginFitRunning', 'setMarginFitRunning')`），不是收窄反证范围。
→ 若改成收窄范围，必须同时补一条变异：模块正文里人为造一个裸赋值 `x = 1` → 必须红。

## ④ 结论：刀一到底是不是「搬渲染」

函数侧 15 个 + 私有调用者 6 个（去重后）= 21 条 / 1,159 行，**依赖 49 个别刀函数**。
也就是说：**刀一是「渲染」+ 一条对 49 个能力的注入面**——它搬得动，但要先把那 49 个名字写进 IDENT，
否则模块正文在运行时全是 ReferenceError。**这不是边界问题，是规则表的补齐问题。**
