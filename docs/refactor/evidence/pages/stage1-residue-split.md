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

## ⑤ `showView("pages")` 的调用点逐个核（Chief 要求：不许只在脑子里过）

实测 **7 处**（不是 5 处）：

| # | 位置 | 所在函数 | 上下文 | 是否「进 pages 就是为了进 pages」 |
|---:|---|---|---|---|
| 1 | `app.js:1255` | `goToWorkflowStep` | 工作流跳到某步 → 该步就是 pages | ✔ 是 |
| 2 | `app.js:1352` | `setupShell` | `detail-close` 点击 → 关详情回页列 | ✔ 是（回退动作，目标就是 pages） |
| 3 | `app.js:2787` | `resumeLastPosition` | 恢复上次所在视图 | ✔ 是 |
| 4 | `app.js:2935` | `renderProject` | `currentView === "library" && !bootingProject` → 切到 pages | ✔ 是（项目渲染完的落点就是页列） |
| 5 | `app.js:4217` | `openPageSetup` | 打开页设置前先切到 pages | ✘ **不是**：进 pages 是为了打开设置面板，是"前置动作" |
| 6 | `app.js:13021` | `finishShowFallbackPages` | 兜底：内容缺失时回页列 | ✔ 是 |
| 7 | `app.js:15059` | `boot` 里的对象属性 | `exit: () => showView("pages")` | ✔ 是（默认落点，不是调用点） |

**结论：7 处里 6 处是「进 pages 就是目的」，第 5 处 `openPageSetup` 是「为了打开面板而先进 pages」。**

→ 所以 `PagesView.enter()` 的语义必须同时容纳这一种：**"进入页列 + 打开页设置面板"**。
   要么 `enter()` 带一个可选的 `openPanel` 参数，要么 `openPageSetup` 留在外壳、`enter()` 之后自己开面板（**后者更干净**：外壳保留"打开面板"这个知识，模块只管渲染）。

→ 第 7 处是 `boot` 里给某对象挂的 `exit` 回调，**不是执行路径**，改成 `PagesView.enter()` 时它跟着走，不需要额外处理。

**没有发现别视图反向依赖 pages**：这 7 处都发生在"当前视图要变成 pages"的场合，没有 `library`/`merge`/`preview` 依赖 pages 内部状态的情况。
