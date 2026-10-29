# `pages`：外壳需要它做的 5 件事（归并表，决策依据）

> 基线 `HEAD`（`app.js` = 15,311 行）。数据来自 `forwarder-callers.md`（63 转发器：接线 12 / 流程 47 / 无调用 4）。
> 47 个流程类的"调用者"是外壳流程——**它们不搬，转发器就没有意义**。正确修法是**把调用者一起搬进来**，而不是开 47 个注入点。

## 归并结果：**5 个语义操作**（判据 ≤6 → 通过）

| # | 语义操作 | 外壳调用场景 | 必须一起进模块的 `stays` 函数 | 进模块后 `app.js` 减少 |
|---|---|---|---|---:|
| 1 | **渲染与加载** | `loadPages` / `openPages` / 识别完成后刷新页与块 | `loadLayoutBlocks`、`loadSetupSuggestions`、`refreshRecognizedPages`、`renderLayoutBlocks`、`renderMarginPanel`、`renderPageSetup`… | 987 行（16 函数） |
| 2 | **确认与采纳** | 确认页 / 采纳建议 / 应用缩放与布局 | `applyPageZoom`、`applySetupSuggestion`、`confirmAllUnconfirmed`、`confirmLayoutFromPanel`、`confirmPageIds`、`confirmSelectedPages`… | 213 行（8 函数） |
| 3 | **版心操作** | 检测版心 / 应用或重置版心 / 显示切换 | `ensureMarginAudit`、`ensureMarginFitted`、`marginBasisForUndetermined`、`pageHasFitLines`、`resetMarginsToAuto`、`savePageMargin`… | 255 行（7 函数） |
| 4 | **版面建议扫描** | 扫描可见页 / 建议队列 / 排期块布局 | `ensurePageSuggestion`、`pumpPageSuggestionQueue`、`scanVisiblePageSuggestions`、`scheduleLayoutBlocks`、`suggestionPagesByType` | 110 行（5 函数） |
| 5 | **批量识别与设置** | 批量识别 / 批量改设置 / 选区判断 | `checkSelection`、`patchRecognitionSetting`、`patchSelectedPages`、`startBatchRecognition`、`startLayoutDetectFromDialog` | 131 行（5 函数） |
| 6 | **其他** | 零散工具（辅助估算 / 面板折叠 / 单页记录） | `auxEstimateText`、`initPanelAccordion`、`layoutBlockPageRecord`、`openPageSetup`、`togglePageBlocksOverlay` | 71 行（5 函数） |
| — | **装配（不是语义操作）** | `boot` / `setupShell` / `setupLibrary` / `showView` | `boot`、`setupLibrary`、`setupShell`、`showView` | 514 行（4 函数） |

## 对账

- **5 个语义操作** + 装配点 + 零散工具 → 判据 ≤6，**不触发"耦合解不开"**；
- 涉及 `stays` 调用者：**41 个函数 / 1,696 行**（987 + 213 + 255 + 110 + 131）；
- 搬走的 movers：**63 函数 / 1,522 行**；
- **合计 `app.js` 预计减少 ≈ 3,218 行**（按名去重后略有出入，落盘以实测为准）；
- 装配点（`boot`/`setupShell`/`setupLibrary`/`showView`，514 行）**不进模块**——它们是线，不是能力。

## 这条结论推翻了什么

| 旧预期 | 实测 |
|---|---|
| "`pages` 一刀 ≈ 371 行 / 28 接缝" | **≈ 3,200 行 / 41 个调用者必须一起进模块** |
| "转发器改成 `call(name)` 分发口就能跑" | **47 个是流程类：分发口能让它跑，但边界还是错的** |

**这就是它落盘两次失败、两次回滚的原因**：按 371 行的预期去切一刀 3,200 行的边界，必然撞上"调用者还在外壳"。

## 建议

- **刀一**：只搬 12 个接线类 → 接线进 `init`、转发器删掉。**R3 不会因此归零**，但风险小、可独立回滚；
- **刀二**：按 5 个语义操作逐个搬（每个操作 = movers + 它的调用者一起），每搬完一个跑 R3/R5/R8/R11 + 特征测试；
- **不要开 `call(name)` 分发口**：它会把 47 个错误形状合法化，之后没人再动。

## 留给你的判断

**3,200 行的一刀，值不值得在 7/7 之前做？** 我的意见是不值得——`pages` 是画布型视图，`page-tile` 接线刚开始，
现在切等于在移动的地基上浇筑。**先让 `page-tile` 稳定，再按 5 个操作切**，每个操作都能单独验收。
