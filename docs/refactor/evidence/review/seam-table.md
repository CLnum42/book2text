# `review` 切片的残余接缝（脚本生成，按内容哈希锚定）

**这份表是脚本吐的，不是手抄的**：`python3 docs/refactor/evidence/review/rescan.py`。

- 锚定：`app.js` sha256 `19a9a9df6bfd4c93` · `index.html` sha256 `9cd594fc6cc05ef1`（**记内容哈希不记提交号**：提交号每提交一次就过期，内容哈希不会）
- 名单：`HEAD:movers.json`，sha256 `ced9c4b08f9de814`（movers 120 / stays 50 / external 17）
- 源码：`HEAD:app.js` 15,311 行；`view-review` 子树 94 个 id
- **`movers.txt` 不参与任何计算**：同一提交里它只有 43 条（是 movers 的子集，少 77 条）——照它搬就是「落盘后审校树空着、静态门全绿」。真源只有 `movers.json`。
- 口径：**接缝 = movers 的函数体里引用、但不在 movers 内的顶层声明**。
**性质**：这是模块正文会裸引用、必须由 `app.js` 通过 `injected` 提供的全部符号。处理方式按 Chief 2026-10-29 定的「谁负责写，谁持有」分三类。

## 0. 汇总

| 处理 | 个数 | 判据 |
|---|---:|---|
| 注入函数 | 45 | 形态 `function`（含 `const f = (…) =>`），写点无关 |
| 注入值 | 20 | 形态 `const`，模块只读——**是值，不是 getter** |
| 注入 get（只读） | 5 | `let`，写点只有声明本身 → 模块只读 |
| 注入 get（外壳持有） | 1 | `let`，写点全在外壳 → 模块只读，声明不搬 |
| 搬进模块 | 27 | `let`，写点全在 movers → 模块自己持有 |
| 注入 get/set | 12 | `let`，写点跨 movers 与外壳/stays |
| **合计** | 110 | 三区之外的全部顶层声明依赖 |

## 1. 注入函数（45）

外壳保留声明，模块调 `injected.name(...)`。`stays` 的按注入面走；**`无` 的是三区未覆盖的（需要人判是否该归 stays）**。

| 名字 | 形态 | 写点 | 三区 | 被几个 mover 用 |
|---|---|---:|---|---:|
| adoptBlockSuggestion | function | — | stays | 1 |
| apiJson | function | — | stays | 16 |
| applyBoxElementRect | function | — | stays | 1 |
| applyMarginRect | function | — | stays | 1 |
| blockCountedInMargin | function | — | stays | 5 |
| blockInsideMargin | function | — | stays | 2 |
| blockNeedsReview | function | — | stays | 2 |
| boxTypeLabel | function | — | stays | 1 |
| buildBoxLabel | function | — | stays | 1 |
| buildBoxOrder | function | — | stays | 1 |
| computeCharSpans | function | — | stays | 6 |
| detailPageRecord | function | — | stays | 13 |
| divergenceOf | function | — | stays | 10 |
| el | function → | — | 无 | 69 |
| fetchPageSuggestions | function | — | stays | 1 |
| flushPendingSave | function | — | stays | 2 |
| focusQueueItem | function | — | stays | 3 |
| forgetPageBlocks | function | — | stays | 2 |
| forgetPageSuggestions | function | — | stays | 3 |
| globalMarginIsAuto | function | — | stays | 2 |
| hideAutoApplyNotice | function | — | stays | 1 |
| isPackageProject | function | — | stays | 1 |
| layoutOverlayAnnotations | function | — | stays | 1 |
| loadAutoApplyStatus | function | — | stays | 1 |
| loadFinishSummary | function | — | stays | 1 |
| loadWorkflow | function | — | stays | 1 |
| marginBoxOfPage | function | — | stays | 2 |
| matchesTriage | function | — | stays | 1 |
| nearestEdge | function | — | stays | 1 |
| notifyApplied | function | — | stays | 1 |
| observeOverlaySize | function | — | stays | 1 |
| pageNumberHintChip | function | — | stays | 1 |
| patchBlock | function | — | stays | 2 |
| project_id | function | — | stays | 1 |
| recognitionOf | function | — | stays | 3 |
| refreshAfterTypeChanges | function | — | stays | 1 |
| refreshPageStates | function | — | stays | 8 |
| reviewMarginStorageKey | function | — | stays | 1 |
| savePosition | function | — | stays | 1 |
| scheduleOverlayLayout | function | — | stays | 4 |
| setReviewBlockFilter | function | — | stays | 1 |
| setSaveState | function | — | stays | 13 |
| showError | function | — | stays | 13 |
| showView | function | — | stays | 1 |
| suggestionHighList | function | — | stays | 2 |

## 2. 注入值（const）（20）

**值不是 getter**：`injected.BOX_MIN_HEIGHT`，写成 `getBoxMinHeight()` 是错的（library 第一版就这么错过）。

| 名字 | 形态 | 写点 | 三区 | 被几个 mover 用 |
|---|---|---:|---|---:|
| BLOCK_TYPE_LABELS | const | 1 | 无 | 3 |
| BOX_MIN_HEIGHT | const | 1 | 无 | 1 |
| BOX_MIN_WIDTH | const | 1 | 无 | 1 |
| CHROME_BLOCK_TYPES | const | 1 | 无 | 2 |
| DIFF_LEVELS | const | 1 | 无 | 3 |
| DRAG_SNAP_PX | const | 1 | 无 | 1 |
| HANDLE_CORNERS | const | 1 | 无 | 1 |
| MAX_DIVERGENCE_ROWS | const | 1 | 无 | 1 |
| MIN_BOX_SIDE | const | 1 | 无 | 1 |
| NOTE_BLOCK_TYPES | const | 1 | 无 | 1 |
| PAGE_TYPE_LABELS | const | 1 | 无 | 1 |
| REVIEW_STATUS_LABELS | const | 1 | 无 | 1 |
| TEXT_FREE_BLOCK_TYPES | const | 1 | 无 | 2 |
| TREE_DIFF_LEVELS | const | 1 | 无 | 1 |
| ZOOM_STEPS | const | 1 | 无 | 1 |
| cursorByBlock | const | 1 | 无 | 2 |
| diffStripOpen | const | 1 | 无 | 5 |
| pageSuggestionCache | const | 1 | 无 | 1 |
| queueDecisions | const | 1 | 无 | 6 |
| token | const | 12 | 无 | 1 |

## 3. 注入 get（只读状态）（5）

写点只有声明本身（`writePoints == 1`）：模块拿 `injected.getX()` 即可，不必开 setter。

| 名字 | 形态 | 写点 | 三区 | 被几个 mover 用 |
|---|---|---:|---|---:|
| reviewTreeChapterRows | let | 1 | 无 | 3 |
| reviewTreeExpandedChapters | let | 1 | 无 | 4 |
| reviewTreeItemRows | let | 1 | 无 | 4 |
| reviewTreeItems | let | 1 | 无 | 5 |
| reviewTreePageRows | let | 1 | 无 | 4 |

## 3b. 注入 get（外壳持有的状态）（1）

写点全在外壳、模块只读 → 声明留外壳，模块只 get。

| 名字 | 形态 | 写点 | 三区 | 被几个 mover 用 |
|---|---|---:|---|---:|
| currentProject | let | 3 | 无 | 24 |

## 4. 搬进模块（状态，写点全在 movers）（27）

写点全部落在 movers 的函数体里 → 状态归属模块，**声明随搬，`OWNERS` 同批改**。

| 名字 | 形态 | 写点 | 三区 | 被几个 mover 用 |
|---|---|---:|---|---:|
| activeReviewBlockId | let | 3 | 无 | 2 |
| auxData | let | 3 | 无 | 2 |
| boxCreateMode | let | 2 | 无 | 6 |
| boxDraft | let | 5 | 无 | 6 |
| candidateRunId | let | 5 | 无 | 5 |
| detailImagePageNo | let | 2 | 无 | 1 |
| detailInkGaps | let | 3 | 无 | 5 |
| detailLayoutConfirmed | let | 2 | 无 | 4 |
| detailLines | let | 2 | 无 | 4 |
| detailMargin | let | 2 | 无 | 3 |
| detailNumberHints | let | 2 | 无 | 2 |
| detailPageNo | let | 3 | 无 | 28 |
| detailSuggestionByBlock | let | 2 | 无 | 4 |
| detailSuggestions | let | 2 | 无 | 1 |
| detailWorkflow | let | 5 | 无 | 5 |
| diffMarksMode | let | 2 | 无 | 2 |
| diffQueue | let | 3 | 无 | 10 |
| inkGapsShown | let | 4 | 无 | 4 |
| pendingPageAux | let | 5 | 无 | 4 |
| queuePageNo | let | 2 | 无 | 3 |
| reviewBlocks | let | 4 | 无 | 16 |
| reviewTree | let | 2 | 无 | 5 |
| reviewTreeExpandedPage | let | 5 | 无 | 4 |
| reviewTreeLoading | let | 3 | 无 | 1 |
| reviewTreeOnlyTodo | let | 2 | 无 | 5 |
| reviewTreeProjectId | let | 2 | 无 | 1 |
| zoomLevel | let | 3 | 无 | 3 |

## 5. 注入 get/set（状态，写点跨区）（12）

写点同时落在 movers 与外壳/stays → 按「谁写谁持有」留外壳，模块 `get/set`，**不要把副本存进模块**（⑧ 状态归属）。

| 名字 | 形态 | 写点 | 三区 | 被几个 mover 用 |
|---|---|---:|---|---:|
| activeDiff | let | 6 | 无 | 6 |
| boxDrag | let | 3 | 无 | 1 |
| detailHistoryState | let | 4 | 无 | 1 |
| lastQueueDecisionKey | let | 5 | 无 | 3 |
| queueIndex | let | 9 | 无 | 7 |
| queueOpen | let | 6 | 无 | 4 |
| reviewBlockFilter | let | 5 | 无 | 3 |
| reviewFilterExplicit | let | 4 | 无 | 3 |
| reviewMarginOn | let | 4 | 无 | 5 |
| reviewPendingSave | let | 3 | 无 | 1 |
| reviewSaveTimer | let | 3 | 无 | 1 |
| suppressBoxClick | let | 3 | 无 | 1 |

## 6. 三区覆盖不到、但确实被 movers 引用的顶层声明

这些既不在 `movers`/`stays`/`external`，也不在 `states_and_consts` 里——**名单的三个区是按函数闭包切的，顶层状态/常量本来就不在闭包里**，所以「无」不代表判断错，只代表「名单没有为它作判断」。

| 名字 | 形态 | 写点 | 被几个 mover 用 | 说明 |
|---|---|---:|---:|---|
| el | function | 1 | 69 | DOM 取元素助手（69 个 movers 调它） |

## 7. `token` 的写点数是个假阳性（写进文档，别再被它误导）

`token` 是 `const`（第 14 行），名单报 **12 个写点**，实际是 **1 个**（就是声明本身）。原因：写点正则 `(?<![\w$.])NAME\s*=(?!=)` 会把 URL 查询串里的 `?token=…` 也算成赋值。**同类符号只要名字出现在查询串里就会中招**；本切片只有 `token` 一个。按 `const` 处理 → 注入值，不受影响。

## 8. 结论：R3（字面量归零）的真实目标不是 0

`view-review` 子树 94 个 id 在 `HEAD:app.js` 里的字面量出现 **221 处**：

| 持有者 | 总出现 | 随 movers 搬走 | 留在 app.js |
|---|---:|---:|---:|
| setupReviewControls | 19 | 0 | 19 |
| applyPackageMode | 4 | 0 | 4 |
| setupLibrary | 3 | 0 | 3 |
| showView | 1 | 0 | 1 |
| setupShell | 1 | 0 | 1 |
| recognizePage | 1 | 0 | 1 |
| updateFinishChips | 1 | 0 | 1 |
| renderFinishPanel | 1 | 0 | 1 |
| boot | 1 | 0 | 1 |

**搬完 120 个 movers 后，`app.js` 里还剩 32 处**（不是 0，更不是旧表说的 218——218 是更早一版的口径，与 HEAD 对不上）。
其中 `setupReviewControls` 一个函数占 19 处：它混用了 17 个 review id 与 35 个别的视图 id，按闭包算法被判成叶子、**不在三区任何一区**，所以既不搬也不在警示区。
要让这 19 处归零，只有两条路：拆 `setupReviewControls`（review 部分进模块、其余留外壳），或显式豁免。**纯搬运做不到。**

