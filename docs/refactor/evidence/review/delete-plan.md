# `review` 删/拆施工图（2026-10-29，DevLead）

**用途**：`view-review`（2,000+ 行）在 UX V3 之后大概率被删。**删之前必须知道"哪些东西还在别处被用"**——这张图就是删的许可证。
**口径**：35 个残余接缝按 `app.js` 声明形态分类（不是按"在不在三区"）；40 个 entangled 取 `entangled.json`（count=40 / lines=1557）。

## 1. 残余接缝 35（形态 → 处理）

| 形态 | 个数 | 处理 | 判据 |
|---|---:|---|---|
| `const` 大写常量 | 4 | **注入值** `injected.NAME` | 不是 getter——写成 `getX()` 是错的 |
| `let` 状态 | 14 | **注入 get/set** | 写点 2–6 个，跨 movers 与外壳 → 按「谁写谁持有」留外壳 |
| `function` / `async function` | 17 | **注入函数** | 13 个在 `stays`，4 个不在三区（`blockNeedsReview` / `fetchPageSuggestions` / `matchesTriage` / `openTreeItem`） |

**逐行表见 [`seam-table.md`](seam-table.md)**。

## 2. entangled 40（引用 review 的 id，但被外壳/路由调用）

**这些就是"删不了"的原因**：它们写 `view-review` 的 DOM，而调用方在外壳里。删之前要么**拆成"渲染"与"流程"两半**，要么**整块保留并登记豁免**。

| 函数 | 行数 | 渲染的 review id | 被谁调用（外壳/C 外） |
|---|---:|---|---|
| `renderReviewTree` | 177 | review-tree-list, review-tree-stats | syncReviewTreeToPage, toggleReviewTreeChapter, toggleReviewTreePage, updateReviewTreeAfterAck |
| `setupReviewControls` | 136 | candidate-apply, candidate-close, candidate-decline, candidate-open… | setupLibrary |
| `renderFinishPanel` | 135 | review-continuations | finishRunAutoPass, loadFinishSummary, openFinishPanel |
| `drawDiffLayer` | 94 | detail-canvas, detail-diff-layer, toggle-diff-marks | activateDiff, adoptQueueCurrent, focusQueueItem, keepQueueCurrent… |
| `applyQueueAckLocally` | 76 | detail-blocks | adoptQueueCurrent, keepQueueCurrent |
| `showView` | 66 | review-pager | boot, closeProject, enterReviewStep, finishShowFallbackPages… |
| `drawDetailOverlay` | 64 | detail-overlay | refreshMarginState |
| `renderDiffQueue` | 63 | diff-queue, diff-queue-dots, diff-queue-meta, diff-queue-note… | adoptQueueCurrent, keepQueueCurrent, openTreeItem, previousQueueItem… |
| `structureAction` | 63 | page-detail-error | blockCard |
| `applyPackageMode` | 61 | aux-run, detail-recognize, finish-open-review | refreshProject |
| `setupViewerTools` | 48 | detail-overlay, review-drawer-toggle, review-filter, review-footer-count… | boot |
| `renderReviewBlocks` | 45 | detail-blocks | ensureBlockListed, refreshDetailSuggestions, setReviewBlockFilter |
| `setupReviewAutoPass` | 42 | review-auto-pass, review-auto-revoke | boot |
| `renderReviewFilter` | 41 | review-filter, review-filter-note | refreshReviewFilterOnly, renderReviewBlocks |
| `syncReviewTreeToPage` | 41 | review-tree-scroll | openTreeItem, renderReviewTree, stepReviewDiff |
| `activateDiff` | 33 | detail-blocks | blockDivergenceSection, drawDiffLayer, handleDiffMarkClick, openTreeItem |
| `snapBox` | 30 | detail-image | onBoxPointerMove |
| `recognizePage` | 28 | page-detail-error | buildTile, setupLibrary |
| `loadPageDetail` | 27 | page-detail-error | adoptAllHighSuggestions, afterCleanupApplied, applySplitBatch, finishRunLayout… |
| `renderReviewHeadline` | 27 | page-detail-meta | loadInkGaps, renderDiffQueue |
| `confirmCurrentPage` | 26 | page-detail-error | setupReviewControls |
| `paintReviewMargin` | 22 | detail-canvas, detail-margin | refreshMarginState |
| `selectReviewBlock` | 21 | block-position, detail-blocks, detail-overlay | activateDiff, blockCard, drawDetailOverlay, focusQueueItem |
| `undoAutoApply` | 18 | page-detail-error | renderAutoApplyStatus, setupLibrary |
| `setupBoxCreate` | 17 | box-select-cancel, box-select-confirm, box-select-recognize, detail-box-create… | setupLibrary |
| `updateDiffActive` | 17 | detail-blocks, detail-diff-layer | activateDiff, adoptQueueCurrent, focusQueueItem, keepQueueCurrent… |
| `setupReviewPager` | 15 | review-jump, review-jump-filter, review-next, review-prev | boot |
| `renderInkGapBar` | 14 | ink-gap-bar, ink-gap-text, ink-gap-toggle | loadInkGaps, setupBoxCreate |
| `drawBoxDraft` | 13 | box-select-rect | onBoxMouseMove |
| `openPageDetail` | 13 | page-detail-error | boot, buildTile, confirmCurrentPage, ensureReviewPage… |
| `applyZoom` | 11 | detail-canvas, detail-image, detail-overlay, zoom-fit | setupViewerTools, zoomBy |
| `closePageDetail` | 10 | aux-panel, candidate-panel | closeProject, refreshProject, setupLibrary |
| `syncDiffStrip` | 10 | detail-blocks | activateDiff, blockDivergenceSection, selectReviewBlock |
| `ensureBlockListed` | 9 | detail-blocks | activateDiff, drawDetailOverlay, restoreEditorFocus, structureAction |
| `normalizedPoint` | 9 | detail-image | onBoxMouseMove |
| `pagerPages` | 9 | review-jump-filter | stepPage |
| `focusSiblingBlock` | 8 | detail-blocks | blockCard |
| `renderHistoryButtons` | 8 | review-redo, review-undo | adoptQueueCurrent, keepQueueCurrent |
| `setupAuxControls` | 6 | aux-close, aux-panel, aux-run | setupLibrary |
| `focusQueueBar` | 4 | diff-queue | adoptQueueCurrent, keepQueueCurrent, previousQueueItem |

## 3. 删之前的三个问题（每条都要答案才能删）

1. **它的 DOM 写点还能不能有别的宿主？** 能 → 拆渲染进模块；不能 → 保留。
2. **它被谁调用？** 调用方也在 `view-review` 内 → 可以一起删；调用方在外壳/路由 → 必须有替代。
3. **删了之后 `view-review` 那段 HTML 还有用吗？** 没用的 `<section>` 一起删，别留空壳。

## 4. 结论（一句话）

**40 个 entangled / 1,557 行是 `view-review` 的"锚"**——`seam-table.md` 的 35 个决定"模块要注入什么"，这份决定"删的时候会不会踩到别人"。
两件事都不在 UX V3 范围内，但**UX V3 改完之后这两份文件的数字会变**，届时重跑 `build_movers.py` 与本文生成命令即可。
