## 三条后补：PageTile 接线函数（到期判据 = acid 通过）

`buildTile` / `applyTileState` / `capturePageTileMetrics` 归 **刀 2**（证据：刀 1 落盘后
662 个页块仍走 `size=thumb`、`__pageTile` 句柄 0、`writes(size=view)=0`）。

**它们的到期判据不是"函数搬走"，是 `accept_pages --stage 2 --acid` 通过**
（`img.src` 赋值 = 1 / observer ≤ 6 / 三消费者同一张 `img`）。搬走但 acid 不过 = 没到期。

# 刀2–5 可机读名单（函数 → 引用 id → 刀号）

> **函数集合来自 `scripts/r3_pages_count.mjs` 的落盘后实测，不是手工列举。**
> 树：工作区（`app.js` = **14,387 行**，刀 1 已落盘）；口径：`el` / `getElementById` / `querySelector("#")`（与 R3 闸一致）。
> 实测 69 个函数 / 193 处 / 79 种 id。**seed 函数集合 == 脚本 `functions` 并集（逐字相等）**。

## 刀2（8 个函数 / 49 种 id）

| 函数 | 引用的 id | 行范围 | 到期刀 | wire |
|---|---|---|---|---|
| `boot` | `pages-margin-toggle`、`pages-overlay-toggle` | 13983–14384（403 行） | 刀5 |  |
| `setupCollabControls` | `assign-list-toggle`、`assign-open` | 13470–13487（19 行） | 刀4 |  |
| `setupLibrary` | `check-pending` | 12608–12703（96 行） | 刀4 |  |
| `setupLibrary` | `layout-detect-open` | 12608–12703（96 行） | 刀3 |  |
| `setupLibrary` | `apply-high-suggestions`、`aux-rerun`、`backups-open`、`page-more-menu`、`word-boxes-open` | 12608–12703（96 行） | 刀5 |  |
| `setupLibrary` | `layout-block-apply-all`、`page-more`、`page-number-open`、`page-range-select`、`rec-aux-all`、`rec-start-all`、`selection-all`、`selection-clear`、`selection-more`、`selection-more-menu`、`selection-select-all`、`setup-confirm-all`、`setup-confirm-selected`、`split-page-numbers` | 12608–12703（96 行） | 刀2 |  |
| `setupShell` | `selection-review-open`、`stats-open` | 1252–1293（43 行） | 刀5 |  |

## 刀3（15 个函数 / 29 种 id）

| 函数 | 引用的 id | 行范围 | 到期刀 | wire |
|---|---|---|---|---|
| `loadFinishSummary` | `pages-error` | 10572–10602（32 行） | 刀3 |  |
| `loadLanguageSummary` | `rec-language-summary` | 13575–13592（19 行） | 刀3 |  |
| `loadPageNumberSummary` | `page-number-summary` | 5250–5266（18 行） | 刀3 |  |
| `refreshLayoutDetectEntry` | `layout-detect-open` | 888–899（13 行） | 刀3 |  |
| `refreshMarginDetectHint` | `margin-detect-hint` | 862–884（24 行） | 刀3 |  |
| `refreshMarginTiles` | `page-grid` | 4727–4737（12 行） | 刀3 |  |
| `renderAutoApplyStatus` | `auto-apply-status` | 12640–12663（25 行） | 刀3 |  |
| `renderMarginStepVerdict` | `margin-confidence`、`margin-confirm-all`、`margin-verdict-line`、`margin-verdict-state` | 793–847（56 行） | 刀3 |  |
| `renderPageNumberMetrics` | `page-number-metrics`、`page-number-review-open`、`page-number-summary` | 5187–5229（44 行） | 刀3 |  |
| `renderPageSummary` | `page-summary` | 5873–5882（11 行） | 刀3 |  |
| `renderRecognitionSettings` | `rec-dual-strategy`、`rec-engine`、`rec-engine-note`、`rec-language`、`rec-strategy-label`、`rec-strategy-note`、`rec-summary` | 3165–3218（55 行） | 刀3 |  |
| `renderStepPanels` | `setup-panel` | 558–617（61 行） | 刀3 |  |
| `renderWorkflowFilter` | `filter-workflow` | 6303–6332（31 行） | 刀3 |  |
| `syncStepToggles` | `page-grid`、`pages-margin-toggle` | 626–656（32 行） | 刀3 |  |
| `updateRecognitionAuxProgress` | `rec-aux-num`、`rec-status`、`rec-verdict-line` | 4995–5012（19 行） | 刀3 |  |

## 刀4（12 个函数 / 31 种 id）

| 函数 | 引用的 id | 行范围 | 到期刀 | wire |
|---|---|---|---|---|
| `applyPackageMode` | `assign-list-toggle`、`assign-open`、`check-pending`、`page-setup-bar`、`panel-pagenum-settings`、`panel-recognition-settings`、`selection-actionbar`、`selection-check`、`selection-recognize`、`selection-skip-checked`、`setup-panel` | 13301–13360（61 行） | 刀4 |  |
| `applyPageRangeInput` | `page-range`、`pages-error` | 3653–3674（23 行） | 刀4 |  |
| `applyPageZoom` | `page-grid`、`pages-margin-toggle`、`pages-overlay-toggle`、`pages-zoom-in`、`pages-zoom-label`、`pages-zoom-out` | 4297–4352（57 行） | 刀4 |  |
| `applyProjectSettings` | `auto-apply-suggestions`、`rec-margin-judgement` | 12597–12606（11 行） | 刀4 |  |
| `applySetupSuggestion` | `pages-error` | 3986–4007（23 行） | 刀4 |  |
| `applySplitBatch` | `selection-hint` | 12974–13007（35 行） | 刀4 |  |
| `confirmAllUnconfirmed` | `selection-hint` | 4047–4058（13 行） | 刀4 |  |
| `confirmLayoutFromPanel` | `layout-block-confirm`、`pages-error` | 4909–4930（23 行） | 刀4 |  |
| `confirmPageIds` | `pages-error` | 4010–4033（25 行） | 刀4 |  |
| `confirmSelectedPages` | `selection-hint` | 4036–4044（10 行） | 刀4 |  |
| `recognizePage` | `pages-error` | 5917–5943（28 行） | 刀4 |  |
| `recognizeSelection` | `pages-error`、`selection-skip-recognized` | 12358–12390（34 行） | 刀4 |  |

## 刀5（34 个函数 / 49 种 id）

| 函数 | 引用的 id | 行范围 | 到期刀 | wire |
|---|---|---|---|---|
| `capturePageTileMetrics` | `page-grid` | 4208–4238（32 行） | 刀5 |  |
| `checkSelection` | `pages-error`、`selection-skip-checked` | 5985–6014（31 行） | 刀5 |  |
| `ensureMarginAudit` | `margin-audit`、`margin-basis` | 4812–4859（49 行） | 刀5 |  |
| `ensureSuggestionScrollListener` | `page-grid` | 3453–3460（9 行） | 刀5 |  |
| `finishMarginDetectBar` | `margin-fit-fill`、`margin-fit-progress`、`margin-fit-text` | 6578–6586（10 行） | 刀5 |  |
| `finishRevokeAutoPass` | `pages-error` | 12153–12173（22 行） | 刀5 |  |
| `forgetAllPageBlocks` | `page-grid` | 4182–4187（7 行） | 刀5 |  |
| `forgetAllPageSuggestions` | `page-grid` | 3333–3339（8 行） | 刀5 |  |
| `hideMarginFitProgressSoon` | `margin-fit-progress` | 738–742（6 行） | 刀5 |  |
| `initPanelAccordion` | `setup-panel` | 3913–3945（34 行） | 刀5 |  |
| `openPageSetup` | `setup-panel` | 3949–3957（10 行） | 刀5 |  |
| `pageScroller` | `page-grid` | 4204–4205（3 行） | 刀5 |  |
| `patchRecognitionSetting` | `pages-error` | 3222–3243（23 行） | 刀5 |  |
| `patchSelectedPages` | `pages-error` | 12332–12355（25 行） | 刀5 |  |
| `pausePageThumbnails` | `page-grid` | 142–148（8 行） | 刀5 |  |
| `pumpOverlayRender` | `page-grid` | 4411–4442（33 行） | 刀5 |  |
| `queueOverlayRender` | `page-grid` | 4389–4398（11 行） | 刀5 |  |
| `rerunAuxiliary` | `pages-error` | 13601–13620（21 行） | 刀5 |  |
| `resetMarginsToAuto` | `pages-error` | 5051–5119（70 行） | 刀5 |  |
| `scanVisiblePageSuggestions` | `page-grid` | 3474–3511（39 行） | 刀5 |  |
| `setAutoApplySetting` | `auto-apply-suggestions`、`selection-hint` | 12759–12789（32 行） | 刀5 |  |
| `setMarginJudgementSetting` | `rec-margin-judgement` | 12796–12813（19 行） | 刀5 |  |
| `setMarginStatus` | `margin-status` | 4742–4753（13 行） | 刀5 |  |
| `setPageNumberStatus` | `page-number-status` | 5170–5181（13 行） | 刀5 |  |
| `setRecognitionStatus` | `rec-status` | 3150–3161（13 行） | 刀5 |  |
| `showMarginDetectProgress` | `margin-fit-fill`、`margin-fit-progress`、`margin-fit-text` | 6509–6515（8 行） | 刀5 |  |
| `showMarginFitProgress` | `margin-fit-fill`、`margin-fit-progress`、`margin-fit-text` | 726–735（11 行） | 刀5 |  |
| `startAuxiliaryAll` | `rec-status` | 4969–4991（24 行） | 刀5 |  |
| `startBatchRecognition` | `pages-error` | 5946–5966（22 行） | 刀5 |  |
| `startLayoutDetectFromDialog` | `pages-error` | 6462–6490（30 行） | 刀5 |  |
| `startLayoutDetection` | `pages-error` | 6342–6364（24 行） | 刀5 |  |
| `toggleMarginView` | `page-grid`、`pages-margin-toggle` | 4586–4600（16 行） | 刀5 |  |
| `togglePageBlocksOverlay` | `page-grid`、`pages-overlay-toggle` | 4367–4380（15 行） | 刀5 |  |
| `visiblePages` | `filter-recognition`、`filter-triage`、`filter-type`、`filter-workflow`、`pages-only-included` | 3519–3536（19 行） | 刀5 |  |

## 不在 seed 里的 37 种（宽口径，另纸，不参与判据）

我第一版按宽口径（任一字面量/值传递）数出 116 种；按裁决**只认闸口径的 79 种**。
差出来的那些**不进 seed**——混在一起会让集合差重新出现。若其中有必须现在处理的，单列一张纸给 Chief。
