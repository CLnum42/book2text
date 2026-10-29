# `review` 切片的 35 个残余接缝（逐行，2026-10-29，DevLead）

**性质**：这是 `movers.json`（冻结版 `cc2e73cc`，movers 43 / stays 61 / external 17 / 树函数 8）之外，
**模块正文还裸引用、但不在三区里的 35 个顶层符号**。它们是"拆分渲染/流程"那件事的输入。
**判据**：形态从 `app.js` 声明派生、写点数用 `(?<![\w$.])NAME\s*=(?!=)`、三区归属查 `movers.json`。

## 0. 汇总

| 形态 | 个数 | 处理 |
|---|---:|---|
| `const` 大写常量 | **4** | **注入（值，不是 getter）**：`injected.boxMinHeight` 这类 |
| `let` 状态 | **14** | **注入 get/set**：写点 2–6 个，**写点跨 movers 与外壳 → 按「谁写谁持有」留外壳** |
| `function` / `async function` | **17** | **注入（函数）**：其中 13 个在 `stays`，4 个**不在三区** |

**22 个不在三区**（三区只覆盖函数闭包，顶层状态/常量本来就不在里面）：
4 个常量 + 14 个状态 + 4 个函数（`blockNeedsReview` · `fetchPageSuggestions` · `matchesTriage` · `openTreeItem`）。

## 1. 常量（4）→ 注入值

| 名字 | 写点 | 三区 | 处理 |
|---|---:|---|---|
| `BOX_MIN_HEIGHT` | 1 | 无 | 注入值 |
| `BOX_MIN_WIDTH` | 1 | 无 | 注入值 |
| `PAGE_TYPE_LABELS` | 1 | 无 | 注入值 |
| `TREE_DIFF_LEVELS` | 1 | 无 | 注入值 |

**注意**：`const` 大写常量是**值**，不能映射成 `getXxx()`——我第一版就是这么错的。

## 2. 状态（14）→ 注入 get/set

| 名字 | 写点 | 三区 |
|---|---:|---|
| `activeDiff` | 6 | 无 |
| `detailWorkflow` | 5 | 无 |
| `queueOpen` | 6 | 无 |
| `reviewMarginOn` | 4 | 无 |
| `activeReviewBlockId` / `auxData` / `boxDrag` / `reviewPendingSave` / `reviewSaveTimer` | 3 | 无 |
| `boxCreateMode` / `detailImagePageNo` / `detailLayoutConfirmed` / `detailMargin` / `reviewTreeOnlyTodo` | 2 | 无 |

**写点全部 ≥2 且分布在 movers 与外壳两侧** → 按「谁写谁持有」**留外壳**，模块只 `get/set`。

## 3. 函数（17）→ 注入

| 名字 | 三区 | 说明 |
|---|---|---|
| `drawDetailOverlay` | stays | 单页详情叠层 |
| `drawDiffLayer` | stays | 差异层 |
| `focusQueueItem` | stays | 队列焦点 |
| `forgetPageBlocks` | stays | 块缓存 |
| `isPackageProject` | stays | 项目类型判定 |
| `openPageDetail` | stays | **`BRIDGE_EXCEPTIONS` 成员，到期点是 pages 搬模块，与本刀无关** |
| `paintReviewMargin` | stays | 版心绘制 |
| `recognitionOf` | stays | 识别结果 |
| `renderDiffQueue` | stays | 差异队列渲染 |
| `renderHistoryButtons` | stays | 历史按钮 |
| `reviewMarginStorageKey` | stays | 存储键 |
| `suggestionHighList` | stays | 建议列表 |
| `updateDiffActive` | stays | 当前差异 |
| `blockNeedsReview` | **无** | 纯判定（无 id、无写点） |
| `fetchPageSuggestions` | **无** | 拉建议（async） |
| `matchesTriage` | **无** | 分诊判定 |
| `openTreeItem` | **无** | 打开树条目（async） |

**那 4 个"无"是唯一需要人判的**：它们不碰 id、不在三区——可能是 `stays` 的漏项，也可能是 `movers` 该带走的纯辅助。

## 4. 这张表说明的结论（给方向的输入）

搬完 43 个 movers 之后，`app.js` 里仍有 **40 个函数（Builder 的「警示」区）在写 `view-review` 的 DOM**，
加上这 35 个符号的注入面 —— **`review` 按"纯搬运"做不到 R3 归零**。

两条路，等方向：

1. **部分搬运 + 显式豁免**：43 个进去，40 个留外壳并登记豁免（R3 判据加一条"这个视图允许 N 处未搬"）；
2. **先拆渲染/流程**：把那 40 个里"写 DOM"与"走流程"分开，写 DOM 的进模块、流程留外壳——**这是 UX V3 之后的工作**。
