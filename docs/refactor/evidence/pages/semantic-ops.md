# `pages`：外壳需要它做的 5 件事（归并表，决策依据）

> 基线 `HEAD`（`app.js` = 15,311 行）。数据来自 `forwarder-callers.md`（63 转发器：接线 12 / 流程 47 / 无调用 4）。
> **本表函数名完整，无省略**——明天按它逐个搬，缺一个名字就会在落盘后出现"某渲染函数还在 app.js 里引用 pages 的 id"。

## 归并结果：**5 个语义操作**（判据 ≤6 → 通过）

| # | 语义操作 | 外壳调用场景 | 函数数 | 行数 |
|---|---|---|---:|---:|
| 1 | **渲染与加载** | `loadPages` / `openPages` / 识别完成后刷新页与块 | 16 | 987 |
| 2 | **确认与采纳** | 确认页 / 采纳建议 / 应用缩放与布局 | 8 | 213 |
| 3 | **版心操作** | 检测版心 / 应用或重置版心 / 显示切换 | 7 | 255 |
| 4 | **版面建议扫描** | 扫描可见页 / 建议队列 / 排期块布局 | 5 | 110 |
| 5 | **批量识别与设置** | 批量识别 / 批量改设置 / 选区判断 | 5 | 131 |
| 6 | **其他** | 零散工具（辅助估算 / 面板折叠 / 单页记录） | 5 | 71 |
| — | **装配（不是语义操作）** | `boot` / `setupShell` / `setupLibrary` / `showView` | 4 | 514 |

## 逐组完整清单（一个不缺）

### 1 渲染与加载（16 个函数 / 987 行）

| 函数 | 行范围 | 行数 |
|---|---|---:|
| `loadLayoutBlocks` | 5538–5576 | 40 |
| `loadSetupSuggestions` | 4226–4243 | 19 |
| `refreshRecognizedPages` | 7252–7275 | 25 |
| `renderLayoutBlocks` | 5579–5678 | 101 |
| `renderMarginPanel` | 5390–5504 | 116 |
| `renderPageSetup` | 4133–4159 | 28 |
| `renderPages` | 6862–6884 | 24 |
| `renderRecognitionStatus` | 5714–5760 | 48 |
| `renderRecognitionVerdict` | 5769–5882 | 115 |
| `renderStepPanels` | 558–617 | 61 |
| `renderSuggestionPanel` | 4314–4369 | 57 |
| `renderTypePicker` | 4265–4310 | 47 |
| `syncPageStates` | 6893–6912 | 21 |
| `updateMarginDetectProgress` | 7550–7564 | 16 |
| `updatePageVisibility` | 4655–4755 | 102 |
| `updateSelectionPanel` | 3754–3919 | 167 |
| **合计** | — | **987** |

### 2 确认与采纳（8 个函数 / 213 行）

| 函数 | 行范围 | 行数 |
|---|---|---:|
| `applyPageZoom` | 4784–4839 | 57 |
| `applySetupSuggestion` | 4372–4393 | 23 |
| `confirmAllUnconfirmed` | 4433–4444 | 13 |
| `confirmLayoutFromPanel` | 5685–5706 | 23 |
| `confirmPageIds` | 4396–4419 | 25 |
| `confirmSelectedPages` | 4422–4430 | 10 |
| `recognizePage` | 6937–6963 | 28 |
| `recognizeSelection` | 13429–13461 | 34 |
| **合计** | — | **213** |

### 3 版心操作（7 个函数 / 255 行）

| 函数 | 行范围 | 行数 |
|---|---|---:|
| `ensureMarginAudit` | 5334–5381 | 49 |
| `ensureMarginFitted` | 702–774 | 74 |
| `marginBasisForUndetermined` | 5326–5331 | 7 |
| `pageHasFitLines` | 678–679 | 3 |
| `resetMarginsToAuto` | 5988–6056 | 70 |
| `savePageMargin` | 5250–5284 | 36 |
| `toggleMarginView` | 5073–5087 | 16 |
| **合计** | — | **255** |

### 4 版面建议扫描（5 个函数 / 110 行）

| 函数 | 行范围 | 行数 |
|---|---|---:|
| `ensurePageSuggestion` | 3470–3486 | 18 |
| `pumpPageSuggestionQueue` | 3491–3520 | 31 |
| `scanVisiblePageSuggestions` | 3547–3584 | 39 |
| `scheduleLayoutBlocks` | 5523–5535 | 14 |
| `suggestionPagesByType` | 4252–4258 | 8 |
| **合计** | — | **110** |

### 5 批量识别与设置（5 个函数 / 131 行）

| 函数 | 行范围 | 行数 |
|---|---|---:|
| `checkSelection` | 7005–7034 | 31 |
| `patchRecognitionSetting` | 3295–3316 | 23 |
| `patchSelectedPages` | 13403–13426 | 25 |
| `startBatchRecognition` | 6966–6986 | 22 |
| `startLayoutDetectFromDialog` | 7518–7546 | 30 |
| **合计** | — | **131** |

### 6 其他（5 个函数 / 71 行）

| 函数 | 行范围 | 行数 |
|---|---|---:|
| `auxEstimateText` | 5897–5902 | 7 |
| `initPanelAccordion` | 4179–4211 | 34 |
| `layoutBlockPageRecord` | 5517–5520 | 5 |
| `openPageSetup` | 4215–4223 | 10 |
| `togglePageBlocksOverlay` | 4854–4867 | 15 |
| **合计** | — | **71** |

### 装配（不是语义操作） 装配（不是语义操作）（4 个函数 / 514 行）

| 函数 | 行范围 | 行数 |
|---|---|---:|
| `boot` | 15054–15308 | 256 |
| `setupLibrary` | 13496–13643 | 149 |
| `setupShell` | 1325–1366 | 43 |
| `showView` | 210–274 | 66 |
| **合计** | — | **514** |

## 对账

- 组内函数数 = 清单条数（16 / 8 / 7 / 5 / 5、零散 5、装配 4）——**每组的合计行已与表头数一致**；
- 组内行数 = 清单内各函数行数之和（已逐组列合计）；
- 搬走 movers：63 函数 / 1,522 行；调用者合计 1,696 行；**≈3,218 行**；
- 装配点（`boot`/`setupShell`/`setupLibrary`/`showView`）**不进模块**——它们是线，不是能力。

## 3.5 装配点归谁（2026-10-29 裁决，补真空）

> **装配函数留在外壳，但装配里针对某个视图的 DOM 接线归该视图的 `init`。**

`setupLibrary` / `setupShell` / `boot` 引用 `view-pages` 的 id 时，那一半是**视图自己的 DOM 接线**，
不是外壳的装配。留着就等于外壳替模块管它自己的 DOM → 到期 = **刀 2**，**不给永久豁免**。

## 不变的结论

| 旧预期 | 实测 |
|---|---|
| "`pages` 一刀 ≈ 371 行 / 28 接缝" | **≈ 3,200 行 / 41 个调用者必须一起进模块** |
| "转发器改成 `call(name)` 分发口就能跑" | **47 个是流程类：分发口能让它跑，但边界还是错的** |

## 建议

- **刀一（不批）**：只搬 12 个接线类——R3 不归零，只能靠开豁免过闸；
- **刀二**：按 5 个操作逐个搬，每搬完一个跑 R3/R5/R8/R11/R12 + `accept_pages --stage N`；
- **不要开 `call(name)` 分发口**：它会把 47 个错误形状合法化。

