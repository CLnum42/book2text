# ① 主刀：review 线三格归属表（178 个函数 / 4,259 行）

> 实测树 `4231b03`（刀 A 已落）。口径：review 代码块内**全部顶层函数**（`5466–9030` 审校视图…漏行、
> `9893–10924` 左树/收尾邻接、`1272–1359` 第二引擎复核、`706–827` 第二引擎可选）；按函数起始行归属。
> 三格互斥、无遗漏：**48/1,332 + 45/902 + 85/2,025 = 178/4,259**。复算脚本见本文件 §四。

| 函数 | 起 | 止 | 行数 | 格 | 备注 |
|---|---:|---:|---:|---|---|
| activeAuxJob | 735 | 745 | 11 | 搬进模块 |  |
| openAuxWarning | 747 | 764 | 18 | 搬进模块 |  |
| waitForAuxThenReview | 767 | 826 | 60 | 搬进模块 |  |
| runAuxiliary | 1276 | 1299 | 24 | 搬进模块 |  |
| renderAuxiliary | 1301 | 1351 | 51 | 搬进模块 |  |
| setupAuxControls | 1353 | 1358 | 6 | 搬进模块 |  |
| applyDetailSuggestions | 5636 | 5649 | 14 | 搬进模块 |  |
| refreshDetailSuggestions | 5667 | 5687 | 21 | 搬进模块 |  |
| blockNeedsReview | 5944 | 5948 | 5 | 搬进模块 |  |
| suggestionHighList | 7512 | 7514 | 3 | 搬进模块 |  |
| renderSuggestionTools | 7516 | 7536 | 21 | 搬进模块 |  |
| renderLayoutPanel | 7539 | 7561 | 23 | 搬进模块 |  |
| confirmPageLayout | 7563 | 7585 | 23 | 搬进模块 |  |
| pageNumberHintChip | 7591 | 7606 | 16 | 搬进模块 |  |
| blockSuggestionBadge | 7608 | 7638 | 31 | 搬进模块 |  |
| adoptBlockSuggestion | 7641 | 7654 | 14 | 搬进模块 |  |
| adoptAllHighSuggestions | 7660 | 7720 | 61 | 搬进模块 |  |
| blockCard | 7722 | 8006 | 285 | 搬进模块 |  |
| blockDivergenceSection | 8019 | 8142 | 124 | 搬进模块 |  |
| diffCompareLines | 8146 | 8187 | 42 | 搬进模块 |  |
| diffRowFragment | 8189 | 8221 | 33 | 搬进模块 |  |
| truncate | 8224 | 8227 | 4 | 搬进模块 |  |
| autoSizeTextarea | 8230 | 8239 | 10 | 搬进模块 |  |
| renderReviewBlocks | 8241 | 8285 | 45 | 搬进模块 |  |
| selectReviewBlock | 8287 | 8307 | 21 | 搬进模块 |  |
| focusSiblingBlock | 8309 | 8316 | 8 | 搬进模块 |  |
| scheduleBlockSave | 8321 | 8328 | 8 | 搬进模块 |  |
| flushPendingSave | 8336 | 8344 | 9 | 搬进模块 |  |
| adoptLine | 8347 | 8364 | 18 | 搬进模块 |  |
| patchBlock | 8366 | 8400 | 35 | 搬进模块 |  |
| captureEditorFocus | 8403 | 8415 | 13 | 搬进模块 |  |
| restoreEditorFocus | 8418 | 8430 | 13 | 搬进模块 |  |
| setBoxCreateMode | 8672 | 8684 | 13 | 搬进模块 |  |
| normalizedPoint | 8687 | 8695 | 9 | 搬进模块 |  |
| onBoxMouseDown | 8697 | 8706 | 10 | 搬进模块 |  |
| onBoxMouseMove | 8708 | 8715 | 8 | 搬进模块 |  |
| onBoxMouseUp | 8717 | 8737 | 21 | 搬进模块 |  |
| boxDraftRect | 8740 | 8748 | 9 | 搬进模块 |  |
| drawBoxDraft | 8750 | 8762 | 13 | 搬进模块 |  |
| createBlockFromBox | 8764 | 8796 | 33 | 搬进模块 |  |
| inkGapBarVisible | 8808 | 8810 | 3 | 搬进模块 |  |
| loadInkGaps | 8812 | 8832 | 21 | 搬进模块 |  |
| renderInkGapBar | 8834 | 8847 | 14 | 搬进模块 |  |
| drawInkGapMarks | 8849 | 8872 | 24 | 搬进模块 |  |
| startRegionRecognition | 8875 | 8886 | 12 | 搬进模块 |  |
| recognizeBoxRegion | 8889 | 8921 | 33 | 搬进模块 |  |
| setupBoxCreate | 8923 | 8939 | 17 | 搬进模块 |  |
| reviewAction | 8971 | 8992 | 22 | 搬进模块 |  |
| engineState | 715 | 717 | 3 | 留壳 |  |
| auxNeedsWarning | 719 | 727 | 9 | 留壳 |  |
| enterReviewStep | 729 | 733 | 5 | 留壳 |  |
| savePosition | 5588 | 5598 | 11 | 留壳 |  |
| runPageAux | 5658 | 5664 | 7 | 留壳 |  |
| stepPage | 5728 | 5734 | 7 | 留壳 |  |
| zoomBy | 5759 | 5765 | 7 | 留壳 |  |
| setReviewBlockFilter | 5936 | 5941 | 6 | 留壳 |  |
| pendingPageReasons | 5951 | 5959 | 9 | 留壳 |  |
| refreshReviewFilterOnly | 6010 | 6015 | 6 | 留壳 |  |
| project_id | 6122 | 6124 | 3 | 留壳 |  |
| setSaveState | 6191 | 6195 | 5 | 留壳 |  |
| lineEdges | 6208 | 6217 | 10 | 留壳 |  |
| nearestEdge | 6220 | 6231 | 12 | 留壳 |  |
| bestShift | 6234 | 6247 | 14 | 留壳 |  |
| snapBox | 6253 | 6282 | 30 | 留壳 |  |
| startBoxDrag | 6285 | 6306 | 22 | 留壳 |  |
| onBoxPointerMove | 6308 | 6335 | 28 | 留壳 |  |
| applyBoxElementRect | 6337 | 6343 | 7 | 留壳 |  |
| onBoxPointerUp | 6345 | 6355 | 11 | 留壳 |  |
| setupBoxDrag | 6357 | 6361 | 5 | 留壳 |  |
| boxTypeLabel | 6379 | 6381 | 3 | 留壳 |  |
| pxRect | 6383 | 6390 | 8 | 留壳 |  |
| rectsOverlap | 6392 | 6399 | 8 | 留壳 |  |
| buildBoxOrder | 6402 | 6407 | 6 | 留壳 |  |
| buildBoxLabel | 6413 | 6483 | 71 | 留壳 |  |
| findOrderSpot | 6486 | 6509 | 24 | 留壳 |  |
| findLabelSpot | 6516 | 6564 | 49 | 留壳 |  |
| layoutOverlayAnnotations | 6570 | 6612 | 43 | 留壳 |  |
| scheduleOverlayLayout | 6615 | 6627 | 13 | 留壳 |  |
| observeOverlaySize | 6637 | 6650 | 14 | 留壳 |  |
| blockHasDrawableDiff | 6658 | 6666 | 9 | 留壳 |  |
| computeCharSpans | 6674 | 6731 | 58 | 留壳 |  |
| diffLevelLabel | 6734 | 6739 | 6 | 留壳 |  |
| lineDiffSpanCount | 6749 | 6754 | 6 | 留壳 |  |
| flashDiffElement | 6857 | 6863 | 7 | 留壳 |  |
| selectSpanInTextarea | 6885 | 6896 | 12 | 留壳 |  |
| aggregateDivergence | 7016 | 7035 | 20 | 留壳 |  |
| ackQueueLine | 7255 | 7264 | 10 | 留壳 |  |
| pageNumberSplitHint | 8437 | 8457 | 21 | 留壳 |  |
| fillCandidateColumn | 8556 | 8586 | 31 | 留壳 |  |
| candidateBlockActions | 8589 | 8619 | 31 | 留壳 |  |
| setupReviewControls | 10654 | 10789 | 136 | 留壳 |  |
| closeProject | 10813 | 10843 | 31 | 留壳 |  |
| setupLibrary | 10855 | 10922 | 68 | 留壳 |  |
| openPageDetail | 5561 | 5574 | 14 | 别的域 | 抽屉域 |
| closePageDetail | 5576 | 5585 | 10 | 别的域 | 抽屉域 |
| loadPageDetail | 5608 | 5634 | 27 | 别的域 | 抽屉域 |
| queueHasPendingItems | 5652 | 5655 | 4 | 别的域 | 清洗/删 |
| pagerPages | 5692 | 5700 | 9 | 别的域 | 抽屉域 |
| renderReviewPager | 5703 | 5726 | 24 | 别的域 | 抽屉域 |
| fitWidth | 5742 | 5745 | 4 | 别的域 | 抽屉域 |
| applyZoom | 5747 | 5757 | 11 | 别的域 | 抽屉域 |
| setReviewOverlay | 5767 | 5774 | 8 | 别的域 | 抽屉域 |
| setReviewMargin | 5776 | 5784 | 9 | 别的域 | 抽屉域 |
| setupViewerTools | 5786 | 5833 | 48 | 别的域 | 抽屉域 |
| setupReviewAutoPass | 5835 | 5876 | 42 | 别的域 | 收尾域 |
| setupReviewPager | 5879 | 5893 | 15 | 别的域 | 抽屉域 |
| paintReviewMargin | 5901 | 5922 | 22 | 别的域 | 抽屉域 |
| toggleReviewMargin | 5924 | 5933 | 10 | 别的域 | 抽屉域 |
| renderReviewFilter | 5967 | 6007 | 41 | 别的域 | 抽屉域 |
| ensureBlockListed | 6023 | 6031 | 9 | 别的域 | 抽屉域 |
| renderPageDetail | 6033 | 6109 | 77 | 别的域 | 抽屉域 |
| renderReviewWorkflowStatus | 6112 | 6120 | 9 | 别的域 | 抽屉域 |
| renderReviewBanner | 6126 | 6180 | 55 | 别的域 | 抽屉域 |
| renderHistoryButtons | 6182 | 6189 | 8 | 别的域 | 抽屉域 |
| findDiffMark | 6741 | 6745 | 5 | 别的域 | 抽屉域 |
| drawDiffLayer | 6762 | 6855 | 94 | 别的域 | 抽屉域 |
| scrollViewerTo | 6866 | 6873 | 8 | 别的域 | 抽屉域 |
| scrollRowIntoList | 6875 | 6882 | 8 | 别的域 | 抽屉域 |
| syncDiffStrip | 6899 | 6908 | 10 | 别的域 | 抽屉域 |
| updateDiffActive | 6910 | 6926 | 17 | 别的域 | 抽屉域 |
| activateDiff | 6932 | 6964 | 33 | 别的域 | 抽屉域 |
| buildDiffQueue | 6968 | 6993 | 26 | 别的域 | 清洗/删 |
| queueCounts | 6995 | 7004 | 10 | 别的域 | 清洗/删 |
| nextPendingQueueIndex | 7006 | 7014 | 9 | 别的域 | 清洗/删 |
| renderReviewHeadline | 7038 | 7064 | 27 | 别的域 | 抽屉域 |
| queueDotFor | 7066 | 7075 | 10 | 别的域 | 清洗/删 |
| renderQueueFooter | 7077 | 7086 | 10 | 别的域 | 清洗/删 |
| renderDiffQueue | 7089 | 7151 | 63 | 别的域 | 清洗/删 |
| focusQueueItem | 7154 | 7164 | 11 | 别的域 | 清洗/删 |
| initDiffQueue | 7166 | 7175 | 10 | 别的域 | 清洗/删 |
| applyQueueAckLocally | 7178 | 7253 | 76 | 别的域 | 清洗/删 |
| adoptQueueCurrent | 7268 | 7325 | 58 | 别的域 | 清洗/删 |
| keepQueueCurrent | 7327 | 7360 | 34 | 别的域 | 清洗/删 |
| previousQueueItem | 7362 | 7377 | 16 | 别的域 | 清洗/删 |
| setQueueOpen | 7379 | 7382 | 4 | 别的域 | 清洗/删 |
| focusQueueBar | 7384 | 7387 | 4 | 别的域 | 抽屉域 |
| captureQueueSnapshot | 7389 | 7400 | 12 | 别的域 | 抽屉域 |
| restoreQueueAfterUndo | 7403 | 7420 | 18 | 别的域 | 抽屉域 |
| drawDetailOverlay | 7421 | 7484 | 64 | 别的域 | 抽屉域 |
| drawDetailLines | 7487 | 7505 | 19 | 别的域 | 抽屉域 |
| structureAction | 8459 | 8521 | 63 | 别的域 | 结构/识别域 |
| openCandidateCompare | 8527 | 8538 | 12 | 别的域 | 清洗/删 |
| renderCandidate | 8540 | 8553 | 14 | 别的域 | 清洗/删 |
| applyCandidateBlock | 8622 | 8660 | 39 | 别的域 | 清洗/删 |
| decideCandidate | 8941 | 8969 | 29 | 别的域 | 清洗/删 |
| confirmCurrentPage | 8994 | 9019 | 26 | 别的域 | 收尾域 |
| nextUnfinishedPage | 9022 | 9029 | 8 | 别的域 | 收尾域 |
| ensureReviewTree | 9911 | 9946 | 36 | 别的域 | 树→index |
| treeItemsFromBlocks | 9948 | 9970 | 23 | 别的域 | 树→index |
| loadReviewTreeItems | 9972 | 9992 | 21 | 别的域 | 树→index |
| treeItemSummary | 9995 | 10010 | 16 | 别的域 | 树→index |
| treeLevelLabel | 10012 | 10016 | 5 | 别的域 | 树→index |
| treeChapterOfPage | 10018 | 10021 | 4 | 别的域 | 树→index |
| renderReviewTree | 10023 | 10199 | 177 | 别的域 | 树→index |
| toggleReviewTreeChapter | 10201 | 10209 | 9 | 别的域 | 树→index |
| toggleReviewTreePage | 10211 | 10218 | 8 | 别的域 | 树→index |
| setReviewTreeOnlyTodo | 10220 | 10227 | 8 | 别的域 | 树→index |
| syncReviewTreeToPage | 10230 | 10270 | 41 | 别的域 | 树→index |
| updateReviewTreeAfterAck | 10272 | 10328 | 57 | 别的域 | 树→index |
| openTreeItem | 10330 | 10349 | 20 | 别的域 | 树→index |
| stepReviewDiff | 10352 | 10375 | 24 | 别的域 | 清洗/删 |
| openFinishPanel | 10377 | 10387 | 11 | 别的域 | 收尾域 |
| closeFinishPanel | 10389 | 10392 | 4 | 别的域 | 收尾域 |
| finishConfirmPages | 10394 | 10397 | 4 | 别的域 | 收尾域 |
| finishShowFallbackPages | 10399 | 10412 | 14 | 别的域 | 收尾域 |
| finishRunLayout | 10414 | 10490 | 77 | 别的域 | 收尾域 |
| finishConfirmLayout | 10492 | 10496 | 5 | 别的域 | 收尾域 |
| finishStopLayout | 10498 | 10500 | 3 | 别的域 | 收尾域 |
| finishResumeLayout | 10502 | 10505 | 4 | 别的域 | 收尾域 |
| finishRunAutoPass | 10507 | 10597 | 91 | 别的域 | 收尾域 |
| finishStartAutoPass | 10599 | 10602 | 4 | 别的域 | 收尾域 |
| finishStopAutoPass | 10604 | 10606 | 3 | 别的域 | 收尾域 |
| finishResumeAutoPass | 10608 | 10611 | 4 | 别的域 | 收尾域 |
| finishRevokeAutoPass | 10613 | 10634 | 22 | 别的域 | 收尾域 |
| finishOpenPageNumbers | 10636 | 10639 | 4 | 别的域 | 收尾域 |
| finishStartReview | 10641 | 10647 | 7 | 别的域 | 收尾域 |
| finishOpenExport | 10649 | 10652 | 4 | 别的域 | 收尾域 |
| humanTouchedPages | 10799 | 10810 | 12 | 别的域 | 收尾域 |

## 四、复算

```bash
# 本表由 /tmp/three-col.mjs 生成（脚本全文见 ① 书 §10 的复现命令）；口径：
# 代码块 = 段头行号；函数 = ^(async )?function；格 = 显式名单（模块/清洗/树/抽屉/收尾/结构）
node /tmp/three-col.mjs
```
