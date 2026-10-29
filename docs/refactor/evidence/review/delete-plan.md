# `review` 切片的删除许可证（脚本生成，按内容哈希锚定）

**用途**：UX V3 重写会删掉 `view-review` 一大片渲染代码。删之前必须知道「哪些东西还在别处被用」——这份表就是删的许可证。

- 锚定：`app.js` sha256 `19a9a9df6bfd4c93` · `index.html` sha256 `9cd594fc6cc05ef1`
- 名单：`HEAD:movers.json` sha256 `ced9c4b08f9de814`（movers 120 / stays 50 / external 17）
- 源码：`HEAD:app.js` 15,311 行

## 1. 删前三问（每个符号都要过）

1. **还有谁在引用它？** —— 只看 `HEAD:app.js` 的调用点，不看注释、不看文档。
2. **删了以后谁红？** —— `node tests/js/run.mjs` 的 R3（字面量）/ R5（导出）/ R11（边棘轮），三张登记表必须先改，再删。
3. **它是状态还是渲染？** —— 状态只许改持有者，渲染可以整段删。

## 2. 随 movers 一起走的 120 个函数（2,974 行）

整段可以删（内容已进模块）：

| 名字 | 行数 |
|---|---:|
| blockCard | 285 |
| renderReviewTree | 177 |
| blockDivergenceSection | 124 |
| drawDiffLayer | 94 |
| applyQueueAckLocally | 76 |
| renderPageDetail | 73 |
| drawDetailOverlay | 64 |
| structureAction | 63 |
| renderDiffQueue | 63 |
| updateReviewTreeAfterAck | 57 |
| renderReviewBanner | 55 |
| renderAuxiliary | 51 |
| setupViewerTools | 48 |
| renderReviewBlocks | 45 |
| setupReviewAutoPass | 42 |
| diffCompareLines | 42 |
| renderReviewFilter | 41 |
| syncReviewTreeToPage | 41 |
| applyCandidateBlock | 39 |
| ensureReviewTree | 36 |
| recognizeBoxRegion | 33 |
| activateDiff | 33 |
| diffRowFragment | 33 |
| createBlockFromBox | 33 |
| blockSuggestionBadge | 31 |
| candidateBlockActions | 31 |
| fillCandidateColumn | 31 |
| snapBox | 30 |
| decideCandidate | 29 |
| loadPageDetail | 27 |
| renderReviewHeadline | 27 |
| buildDiffQueue | 26 |
| confirmCurrentPage | 26 |
| drawInkGapMarks | 24 |
| renderReviewPager | 24 |
| runAuxiliary | 24 |
| confirmPageLayout | 23 |
| renderLayoutPanel | 23 |
| treeItemsFromBlocks | 23 |
| paintReviewMargin | 22 |
| startBoxDrag | 22 |
| reviewAction | 22 |
| loadInkGaps | 21 |
| pageNumberSplitHint | 21 |
| refreshDetailSuggestions | 21 |
| loadReviewTreeItems | 21 |
| renderSuggestionTools | 21 |
| onBoxMouseUp | 21 |
| selectReviewBlock | 21 |
| aggregateDivergence | 20 |
| openTreeItem | 20 |
| drawDetailLines | 19 |
| undoAutoApply | 18 |
| adoptLine | 18 |
| restoreQueueAfterUndo | 18 |
| setupBoxCreate | 17 |
| updateDiffActive | 17 |
| treeItemSummary | 16 |
| setupReviewPager | 15 |
| renderInkGapBar | 14 |
| applyDetailSuggestions | 14 |
| renderCandidate | 14 |
| bestShift | 14 |
| setBoxCreateMode | 13 |
| openPageDetail | 13 |
| drawBoxDraft | 13 |
| captureQueueSnapshot | 12 |
| startRegionRecognition | 12 |
| selectSpanInTextarea | 12 |
| openCandidateCompare | 12 |
| applyZoom | 11 |
| queueDotFor | 10 |
| closePageDetail | 10 |
| reviewMarginSplit | 10 |
| effectiveReviewFilter | 10 |
| autoSizeTextarea | 10 |
| renderQueueFooter | 10 |
| syncDiffStrip | 10 |
| onBoxMouseDown | 10 |
| lineEdges | 10 |
| toggleReviewMargin | 10 |
| queueCounts | 10 |
| initDiffQueue | 10 |
| toggleReviewTreeChapter | 9 |
| renderReviewWorkflowStatus | 9 |
| autoMarginProvisional | 9 |
| blockHasDrawableDiff | 9 |
| pagerPages | 9 |
| ensureBlockListed | 9 |
| boxDraftRect | 9 |
| setReviewMargin | 9 |
| pendingPageReasons | 9 |
| normalizedPoint | 9 |
| focusSiblingBlock | 8 |
| setReviewTreeOnlyTodo | 8 |
| scrollViewerTo | 8 |
| onBoxMouseMove | 8 |
| nextUnfinishedPage | 8 |
| setReviewOverlay | 8 |
| toggleReviewTreePage | 8 |
| scheduleBlockSave | 8 |
| renderHistoryButtons | 8 |
| scrollRowIntoList | 8 |
| stepPage | 7 |
| runPageAux | 7 |
| saveReviewMarginPreference | 7 |
| flashDiffElement | 7 |
| zoomBy | 7 |
| refreshReviewFilterOnly | 6 |
| lineDiffSpanCount | 6 |
| diffLevelLabel | 6 |
| setupAuxControls | 6 |
| findDiffMark | 5 |
| treeLevelLabel | 5 |
| focusQueueBar | 4 |
| treeChapterOfPage | 4 |
| truncate | 4 |
| fitWidth | 4 |
| queueHasPendingItems | 4 |
| inkGapBarVisible | 3 |

## 3. 留在 `app.js`、但写着 review 的 DOM 的函数（9 个 / 888 行）

**这些是删除的硬边界**：删 review 渲染时它们的函数体里还有 review 的 id 字面量。

| 名字 | 行范围 | 行数 | 三区 | review 字面量 | 经 el() 碰的 review id |
|---|---|---:|---|---:|---|
| setupReviewControls | 13265–13400 | 136 | 无 | 19 | candidate-apply, candidate-close, candidate-decline, candidate-open… |
| applyPackageMode | 14372–14432 | 61 | 无 | 4 | aux-run, detail-recognize, finish-open-review |
| setupLibrary | 13496–13644 | 149 | 无 | 3 | detail-close, detail-recognize, review-apply-all |
| showView | 210–275 | 66 | stays | 1 | review-pager |
| setupShell | 1325–1367 | 43 | 无 | 1 | detail-close |
| recognizePage | 6937–6964 | 28 | 无 | 1 | page-detail-error |
| updateFinishChips | 11620–11633 | 14 | 无 | 1 |  |
| renderFinishPanel | 11676–11810 | 135 | stays | 1 | review-continuations |
| boot | 15054–15309 | 256 | 无 | 1 | review-margin-toggle |

## 4. 会留在 `app.js` 的 review 字面量（删除账）

| 持有者 | 留几处 | 是些什么 id | 删的时候怎么办 |
|---|---:|---|---|
| setupReviewControls | 19 | candidate-apply, candidate-close, candidate-decline, candidate-open, candidate-panel, diff-queue-toggle… | **最大一笔**：拆成 review 部分进模块 + 其余留外壳，或豁免 |
| applyPackageMode | 4 | aux-run, detail-recognize, finish-open-review | 跨视图引用：跟着它所属的视图走，别在 review 这一刀删 |
| setupLibrary | 3 | detail-close, detail-recognize, review-apply-all | 跨视图引用：跟着它所属的视图走，别在 review 这一刀删 |
| showView | 1 | review-pager | 跨视图引用：跟着它所属的视图走，别在 review 这一刀删 |
| setupShell | 1 | detail-close | 跨视图引用：跟着它所属的视图走，别在 review 这一刀删 |
| recognizePage | 1 | page-detail-error | 跨视图引用：跟着它所属的视图走，别在 review 这一刀删 |
| updateFinishChips | 1 | finish-open-review | 跨视图引用：跟着它所属的视图走，别在 review 这一刀删 |
| renderFinishPanel | 1 | review-continuations | 跨视图引用：跟着它所属的视图走，别在 review 这一刀删 |
| boot | 1 | review-margin-toggle | 跨视图引用：跟着它所属的视图走，别在 review 这一刀删 |

合计 **32 处**。其中 19 处在 `setupReviewControls`——它按闭包是叶子、不在三区，所以**名单没为它作判断**，这是名单的一个已知缺口，不是实现漏了。

## 5. 接缝（模块正文会引用的、三区之外的顶层声明）

| 处理 | 个数 | 删的时候要不要动它 |
|---|---:|---|
| 注入函数 | 45 | 生产者在 `app.js`，**外壳函数一个都不许删** |
| 注入值 | 20 | 常量留外壳，删了模块就 ReferenceError |
| 注入 get（只读） | 5 | 留外壳 |
| 注入 get（外壳持有） | 1 | 留外壳 |
| 搬进模块 | 27 | **声明跟着搬**，外壳那份删掉（否则两份状态） |
| 注入 get/set | 12 | 留外壳，模块只 get/set |

## 6. 删除顺序（每步都能单独回滚）

1. 先改三张登记表（`OWNERS` / `VIEW_EXPORTS` / `VIEW_STATE_PREFIXES`），让闸知道即将发生什么；
2. 删 movers 的函数体（`app.js` 侧），模块侧已等价；
3. 删 review 的 DOM 写点（含 `setupReviewControls` 里那 19 处）——**这一步才是 R3 归零**；
4. 最后删状态声明（只删「搬进模块」那批，别删 get/set 那批的声明）。

**任何时候 `node tests/js/run.mjs` 红，就停在这一步，别往下删。**
