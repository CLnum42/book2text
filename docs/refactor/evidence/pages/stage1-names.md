# `pages` 刀一：16 个函数 + 它们的非 mover 调用者

> 名单来源：`semantic-ops.md` 操作 1（16 个 / 987 行，`…` 已补全）。
> 行范围与行数是**表中原样**；调用者是本脚本从 `HEAD:app.js` 现算（`f(` 与值位置都扫，排除自身定义）。
> 判据：**搬谁看这张名单**，不看接线/流程分栏（那条路线已撤销）。

## ① 16 个函数

| # | 函数 | 行范围 | 行数 | 非 mover 调用者（`:行 → 所在函数`） |
|---:|---|---|---:|---|
| 1 | `loadLayoutBlocks` | 5538–5576 | 40 | `5535→scheduleLayoutBlocks` · `5700→confirmLayoutFromPanel` |
| 2 | `loadSetupSuggestions` | 4226–4243 | 19 | `235→showView` · `4220→openPageSetup` · `4389→applySetupSuggestion` |
| 3 | `refreshRecognizedPages` | 7252–7275 | 25 | `7185→pollTask` · `7195→pollTask` · `7216→pollTask` |
| 4 | `renderLayoutBlocks` | 5579–5678 | 101 | `615→renderStepPanels` · `5528→scheduleLayoutBlocks` · `5532→scheduleLayoutBlocks` |
| 5 | `renderMarginPanel` | 5390–5504 | 116 | `609→renderStepPanels` · `760→ensureMarginFitted` · `3859→updateSelectionPanel` |
| 6 | `renderPageSetup` | 4133–4159 | 28 | `232→showView` · `6883→renderPages` · `6911→syncPageStates` |
| 7 | `renderPages` | 6862–6884 | 24 | `2932→renderProject` · `3682→selectAllVisiblePages` · `3690→clearPageSelection` |
| 8 | `renderRecognitionStatus` | 5714–5760 | 48 | `617→renderStepPanels` · `1093→waitForAuxThenReview` · `3904→updateSelectionPanel` |
| 9 | `renderRecognitionVerdict` | 5769–5882 | 115 | `5760→renderRecognitionStatus` |
| 10 | `renderStepPanels` | 558–617 | 61 | `546→syncWorkflowSteps` · `4156→renderPageSetup` |
| 11 | `renderSuggestionPanel` | 4314–4369 | 57 | `3858→updateSelectionPanel` · `4154→renderPageSetup` · `4231→loadSetupSuggestions` |
| 12 | `renderTypePicker` | 4265–4310 | 47 | `3857→updateSelectionPanel` · `4153→renderPageSetup` · `4242→loadSetupSuggestions` |
| 13 | `syncPageStates` | 6893–6912 | 21 | `6848→<top>` · `7174→pollTask` · `7296→refreshPageStates` |
| 14 | `updateMarginDetectProgress` | 7550–7564 | 16 | `7163→pollTask` |
| 15 | `updatePageVisibility` | 4655–4755 | 102 | `3975→buildTile` · `4609→capturePageTileMetrics` · `4643→schedulePageVisibility` |
| 16 | `updateSelectionPanel` | 3754–3919 | 167 | `4152→renderPageSetup` · `6884→renderPages` · `6912→syncPageStates` |
| — | **合计** | — | **987** | — |

**算式：40 + 19 + 25 + 101 + 116 + 28 + 24 + 48 + 115 + 61 + 57 + 47 + 21 + 16 + 102 + 167 = 987**  ← 与 `semantic-ops.md` 的 987 一致。

## ② 必须同批进模块的非 mover 调用者（15 个）

判据：这些函数在刀一里**被搬走的函数调用**，它们自己不属于 mover → 不同批搬走，模块内就会引用外壳函数。

| 调用者 | 区 | 行数 |
|---|---|---:|
| `<top>` | shell/top | ? |
| `applyPageZoom` | stays | 57 |
| `ensureMarginFitted` | stays | 74 |
| `notifyApplied` | stays | 5 |
| `recognizePage` | stays | 28 |
| `refreshPageStates` | stays | 13 |
| `reloadProjectPages` | stays | 13 |
| `renderPages` | stays | 24 |
| `renderRecognitionStatus` | stays | 48 |
| `renderStepPanels` | stays | 61 |
| `savePageMargin` | stays | 36 |
| `schedulePageVisibility` | stays | 8 |
| `showView` | stays | 66 |
| `syncPageStates` | stays | 21 |
| `undoMarginEdit` | stays | 41 |

## ③ 这一刀不碰的

- 装配点 `boot` / `setupShell` / `setupLibrary` / `showView`（它们是线，不是能力，`pages-plan.md §0`）；
- 其余四刀的函数（仍在 app.js 里渲染 → **刀一 R3 不归零**，只要求低于基线 270 处）。
