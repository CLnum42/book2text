# 刀 3 施工图：版心操作（15 个函数 / 32 处 id 引用）

> **机读名单**：`docs/refactor/pages/knife3-movers.json`（本文件是它的可读版，两处若冲突以 json 为准）。
> **量于** `app.js` 14,752 行 · `pages-view.js` 1,511 行 · R3 `total 155 / ids 64`（2026-10-30）。
> 行范围是**当前树**的，不是 seed 里的旧行号（seed 写于刀 2.5，已漂）。

## ① 可机读名单（函数名 + 行范围 + 口径 + 处数）

口径 = `view-pages` 子树 id 引用（`el()` / `getElementById()` / `querySelector("#…")`），与 R3 闸逐字一致。

| 函数 | 行范围（当前树） | 行数 | id 处数 | 需转发器 | 主要调用者 | 主要 deps |
|---|---|---:|---:|---|---|---|
| `loadFinishSummary` | 10909–10940 | 32 | 1 | 是 | `afterCleanupApplied`、`afterContinuationChange`、`boot`、`confirmCurrentPage` | `apiJson`、`currentProject`、`el`、`finishSummary`、`finishSummaryAgain` |
| `loadLanguageSummary` | 13905–13923 | 19 | 1 | 是 | `showView` | `apiJson`、`currentProject`、`el` |
| `loadPageNumberSummary` | 5274–5291 | 18 | 1 | 是 | `adoptPageNumberTemplate`、`hydrateView`、`removePageNumberRange`、`savePageNumberManual` | `apiJson`、`currentProject`、`el`、`loadPageNumberMetrics` |
| `refreshLayoutDetectEntry` | 888–918 | 31 | 1 | 是 | `boot`、`renderLayoutStatus` | `currentProject`、`el`、`marginUndeterminedPages`、`selectedPages`、`selectionPages` |
| `refreshMarginDetectHint` | 862–885 | 24 | 1 | 是 | `boot`、`renderLayoutStatus` | `currentProject`、`el`、`marginStepVerdict` |
| `refreshMarginTiles` | 4748–4759 | 12 | 1 | 是 | `boot`、`refreshMarginState`、`resetMarginsToAuto`、`syncStepToggles` | `clearTileMargin`、`currentProject`、`pagesMarginOn`、`paintTileMargin`、`visiblePageNos` |
| `renderAutoApplyStatus` | 12971–12995 | 25 | 1 | 是 | `loadAutoApplyStatus` | `autoApplyTypeText`、`el`、`latestAutoApply`、`undoAutoApply` |
| `renderMarginStepVerdict` | 793–848 | 56 | 4 | 是 | `boot`、`reportLayoutDetectOutcome`、`startLayoutDetectFromDialog` | `currentProject`、`el`、`layoutDetectActive`、`marginStepVerdict` |
| `renderPageNumberMetrics` | 5211–5254 | 44 | 3 | 是 | `loadPageNumberMetrics`、`loadPageNumberSummary`、`refreshPageNumberAnalysis` | `currentProject`、`el`、`pageNumberAnalysis` |
| `renderPageSummary` | 5896–5906 | 11 | 1 | 是 | `boot` | `currentProject`、`el`、`recognitionOf`、`visiblePages` |
| `renderRecognitionSettings` | 3198–3252 | 55 | 10 | 是 | `applyProjectSettings`、`boot`、`loadAppInfo`、`patchRecognitionSetting` | `RECOGNITION_ENGINE_LABELS`、`el`、`engineProbe`、`recognitionSetting` |
| `renderStepPanels` | 558–618 | 61 | 1 | 是 | `boot`、`syncWorkflowSteps` | `currentProject`、`currentView`、`el`、`ensureMarginFitted`、`lastStepPanelKey` |
| `renderWorkflowFilter` | 6608–6638 | 31 | 1 | 是 | `loadWorkflow` | `WORKFLOW_FILTERS`、`el`、`pendingPageCount`、`workflowConfirmationCounts` |
| `syncStepToggles` | 626–657 | 32 | 2 | 否 | `renderStepPanels` | `clearTileMargin`、`currentProject`、`currentView`、`el`、`pagesMarginOn` |
| `updateRecognitionAuxProgress` | 5016–5034 | 19 | 3 | 是 | `pollTask` | `el`、`estimateRemainingSeconds`、`formatDuration` |

**合计**：15 个函数 / 470 行 / 32 处 id 引用。

## ② 每一条搬去哪里

全部搬进 `backend/book2text/static/pages-view.js`（刀 1 起就是唯一的 pages 模块）。搬完留在 `app.js` 的转发器
**只有 14 条**（每个有外部调用者的函数一条，形如 `function X(){ return window.PagesView.X.apply(window.PagesView, arguments); }`）；
`syncStepToggles` 的唯一调用者 `renderStepPanels` 也在本刀内搬走 → **不需要转发器**。

## ③ deps 新增清单（45 个名字：**25 函数 + 20 状态/常量**）

跨刀仍住在 `app.js`、被搬走的函数体引用的名字（生成器按 IDENT 生成 deps 键）：

**函数（25）**：`apiJson` · `autoApplyTypeText` · `clearTileMargin` · `engineProbe` · `ensureMarginFitted` ·
`estimateRemainingSeconds` · `flushBootQueue` · `formatDuration` · `loadPageNumberMetrics` · `marginStepVerdict` ·
`marginUndeterminedPages` · `paintTileMargin` · `recognitionOf` · `recognitionSetting` · `renderFinishPanel` ·
`renderLayoutBlocks` · `renderMarginPanel` · `renderRecognitionStatus` · `scheduleLayoutBlocks` · `selectionPages` ·
`showError` · `syncWorkflowSteps` · `undoAutoApply` · `updateFinishChips` · `visiblePages`

**状态 / 常量（20）**：`RECOGNITION_ENGINE_LABELS` · `WORKFLOW_FILTERS` · `currentProject` · `currentView` · `el` ·
`finishSummary` · `finishSummaryAgain` · `finishSummaryLoading` · `finishSummaryProject` · `lastStepPanelKey` ·
`latestAutoApply` · `layoutDetectActive` · `pageNumberAnalysis` · `pagesMarginOn` · `pendingPageCount` ·
`selectedPages` · `stepsReady` · `visiblePageNos` · `workflowConfirmationCounts` · `workflowStep`

（分类由脚本按「`^function` / `^let|const`」判定，不是手分——总数 45 对但分栏反了正是"函数与状态混一栏"的老亏。）
最终键名以生成器 dry run 的 `injected_keys` 与 R13 为准。

## ④ 验收判据（具体数，不是"会下降"）

```
· R3 total：155 → 123
  算式：155 − 32（15 个 mover 在 app.js 里的 id 引用处数）
  形态分解：基线 155 = el 148 + querySelector 7；mover 32 = el 29 + querySelector 3
  **口径必须在两端一致**：若按 el-only 数 mover 得 29 → 会算成 126，但基线 155 含 querySelector，
  那样就变成「分子漏 3 处」的假数——验收时 R3 会显示 123，写 126 的人会以为漏搬了函数。
· R3 ids：64 → 44（本刀触及 25 个 id：20 个归零 + 5 个只部分归零）
  部分归零（**本刀不归零，责任在刀 4**）：page-grid · pages-margin-toggle · pages-overlay-toggle ·
  pages-zoom-in · pages-zoom-label（applyPageZoom / toggleMarginView / togglePageBlocksOverlay 也引用它们）
· 导出面：16 → 16（本刀不删导出，只减 app.js 里的 DOM 字面量）
· app.js 行数：14,752 → 约 14,282（−470）
· pages-view.js：1,511 → 约 1,981（+470）
· 硬判据：node 闸 152 pass / 0 fail · R13「模块必读键都在注入表里」= 0 · accept --stage 2 exit 0
```

## ④b 口径两条（写进名单，避免再算错）

```
(a) refs 是**函数级**的，不是 id 级：多 id 的 mover 按 id 累加会把同一处算两次
    （Architect 第一次这么算出 inside=118 > total=77）。
(b) page-grid / pages-margin-toggle 本刀**不归零**，归零责任在刀 4。
```

## ⑤ 施工顺序（先测后码）

```
1. test-contract: 一笔，只动 tests/js（把 pages-wire 的量随函数搬迁校准）
2. 产品一笔：app.js 少 15 个函数体 + 14 条转发器，pages-view.js 多 15 个函数 + wireAll 接线不变
3. 每搬一处跑 node 闸（不是 node --check）
4. 自检：movers 重名 / 声明重复 / api 键集合（生成器三条守卫）
```

## ⑥ 未决（需要复核人拍）

```
· `applyPageZoom` / `toggleMarginView` / `togglePageBlocksOverlay` 三个"版心/缩放开关"也引用 pages id，
  但它们在 seed 里归刀 4 —— 本刀不碰，避免和刀 4 的名单打架。
· 本刀搬完，`pages-view.js` 到约 1,981 行；刀 4/5 之后仍需再收 exports 16 → 3。
```
