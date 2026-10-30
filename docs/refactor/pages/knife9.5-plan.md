# 刀 9.5 施工图：选择 / 网格 / 步骤 / 收尾 11 键（R8 42 → 39，deps 214 → 208）

> 基线 `main@3abf939`。行号是 **2026-10-30 实测的原始行号**；开工前必须重量（`knife-numbering.md §六`）。
> 权威曲线见 `export-ratchet.md §五`，本文件不复制曲线数字。
> 口径：**12 个名字 / 26 个调用点 / 20 个宿主；`checkSelection` → C**（Builder 那份 25/19 是把它放表外，同一个数两种记法）。

## 一、13 行分类表（renderPages 拆两半）

| 键 | 调用点 | 死法 | 去向 |
|---|---|---|---|
| `reloadProjectPages` | :1509 · :5759 | b | `onProjectPagesReloaded` ← applyHeaderFooter / controlJob |
| `renderPages`（a 半） | :3254 · :3262 · :3273 · :4110 | a | 4 个选择宿主搬入 |
| `renderPages`（b 半） | :2681 · :10899 | b | `onPageListChanged` ← renderProject / finishShowFallbackPages |
| `renderRecognitionStatus` | :824 | b | `onAuxReviewFinished` ← waitForAuxThenReview |
| `syncPageStates` | :5224 · :5322 | b | `onPageStatesRefreshed` ← pollTask / refreshPageStates |
| `renderAutoApplyStatus` | :11490 | b | `onAutoApplyStatusChanged` ← loadAutoApplyStatus |
| `renderStepPanels` | :558 | b | `onWorkflowStepChanged` ← syncWorkflowSteps |
| `renderWorkflowFilter` | :5355 · :5372 · :5380 | b | 并入 `onWorkflowLoaded(counts, summary)`，0 新键 |
| `checkSelection` | :11178 | **C** | 不写死期；callers: ["setupReviewControls"]，reason 写 DOM 归属（按钮 index.html:1721 在 section 外） |
| `forgetAllPageBlocks` | :11541 | b | `onPageBlocksInvalidated` ← refreshAfterTypeChanges |
| `forgetAllPageSuggestions` | :5237 · :9979 · :11543 · :11774 | b | `onPageSuggestionsInvalidated` ← pollTask / afterCleanupApplied / refreshAfterTypeChanges / applySplitBatch |
| `pageScroller` | :3708 | a | 宿主 `ensurePageScrollListener`(3706–3715) 搬入 |
| `visiblePages` | :3237 · :3250 · :4100 | a | 随 3 个选择宿主搬入（selectRangeTo / selectAllVisiblePages / selectNextPage） |

## 二、八个新键（C，不写死期）+ 一个复用

```
onPageListChanged            ← renderProject / finishShowFallbackPages
onProjectPagesReloaded       ← applyHeaderFooter / controlJob
onAuxReviewFinished          ← waitForAuxThenReview
onPageStatesRefreshed        ← pollTask / refreshPageStates
onAutoApplyStatusChanged     ← loadAutoApplyStatus
onWorkflowStepChanged        ← syncWorkflowSteps
onPageBlocksInvalidated      ← refreshAfterTypeChanges（带 pageNos 时只丢那几页，if/else 保持）
onPageSuggestionsInvalidated ← pollTask / afterCleanupApplied / refreshAfterTypeChanges / applySplitBatch
（复用）onWorkflowLoaded(counts?, summary?)
```

## 三、`renderWorkflowFilter` 并入 `onWorkflowLoaded`（定稿写法）

```js
let filterCounts = {}, filterSummary = {};      // try 之前
try {
  …
  filterCounts = data.counts || {}; filterSummary = data.summary || {};   // 原 :5372 只赋值
} catch { … }                                   // catch 不碰默认值
window.PagesView?.onWorkflowLoaded(filterCounts, filterSummary);          // 原 :5382 传参
// package 分支：原 :5355 删，:5356 改成 onWorkflowLoaded({}, {})
```

**为什么不挪进 try**：`onWorkflowLoaded` 一旦被 9.3 的 `refreshLayoutDetectEntry` 等抛错路径抓住，
catch 里会再用 `{}, {}` 调一次 ⇒ 双重调用 + 错参数。所以调用位只有 **5356 / 5382 两处**。

## 四、26 个调用位的去向（8 搬 + 17 换/删 + 1 不动 = 26）

```
8 随宿主搬进模块：renderPages :3254/:3262/:3273/:4110 · visiblePages :3237/:3250/:4100 · pageScroller :3708
1 不动：checkSelection :11178（只改调用目标为 api）
3 删除（并入 onWorkflowLoaded）：:5355 · :5372 · :5380
14 原位换成能力调用：
   :1509 :5759 reloadProjectPages · :2681 :10899 renderPages(b) · :824 renderRecognitionStatus
   · :5224 :5322 syncPageStates · :11490 renderAutoApplyStatus · :558 renderStepPanels
   · :11541 forgetAllPageBlocks · :5237 :9979 :11543 :11774 forgetAllPageSuggestions
```

转发器删除 **11 行**：`:4873 :4794 :4049 :4802 :11479 :570 :5385 :3687 :3050 :3703 :3182`
（**:4870 `checkSelection` 必须留**——它是 C 键、仍在 api 里，壳 :11178 经它调用）

## 五、搬入 **75 行**（逐函数实测）

```
selectOnly               3221–3225   5   （只被 selectRangeTo:3241 / handleTileClick:3271 调）
toggleSelection          3227–3234   8   （只被 handleTileClick:3269 调）
selectRangeTo            3236–3246  11
selectAllVisiblePages    3249–3255   7   （boot:12789 的 Ctrl+A 接线搬进模块 init）
clearPageSelection       3258–3263   6   （boot:12780 的 Esc 接线搬进模块 init）
handleTileClick          3265–3274  10   （buildTile:3426 的 click 改 #page-grid 委托；3427 dblclick 不动）
selectNextPage           4098–4115  18   （自环：模块 :328 经 injected.selectNextPage ⇒ 改直呼）
ensurePageScrollListener 3706–3715  10   （自环：模块 :1829 ⇒ 改直呼）
合计 75
```

keydown 块 **12777–12791**（15 行，含 12777 注释；12792 起是 platform-warning，不搬）一起搬进模块 init。

## 六、deps 214 → 208（逐键）

```
−1 renderPages              :12914  死注入（模块 injected.renderPages = 0，本地直呼 13 处）
−1 renderStepPanels         :12824  自环改直呼（模块 :354）
−1 ensurePageScrollListener :12993  跟随宿主搬入（模块 :1829 改直呼）
−4 选择族 :12938 selectAllVisiblePages · :12916 clearPageSelection
          · :12918 handleTileClick · :12906 selectNextPage
+1 openMasks                （keydown 搬入后的遮罩判断；不复制一份到模块，理由同 9.3 的 applyMarginRect / nearestEdge）
= 208
```

其余 9 个名字不在注入表 ⇒ 8 个新能力**不增 deps**。

## 七、账本

```
R8 = 42 − 11 + 8 = 39 · VIEW_EXPORTS 39
kinds T5 / C32 / L2 = 39   （checkSelection 换类：T 少 1、C 多 1；T 17 − 11 − 1 = 5，C 23 + 1 + 8 = 32）
② 推导值 = C + 3 = 35
```

## 八、验收（八条）

```
① R8 39：api 39 · VIEW_EXPORTS 39 · kinds T5 / C32 / L2
② 11 个死键三栏归零（剥注释含值位）；checkSelection 留在 api，全仓只有 :11178 一处经 api 的调用，:4870 转发器在
③ 8 个新键真被调用（各给行号）
④ deps 208 逐键（7 删 + 1 增，逐条行号）
⑤ audit_ui_asset_literals.py →「会假红 = 0」
⑥ 四闸原文 + paths.STATIC_DIR + pytest（PYTHONPATH）
⑦ 顺序两条机检：onWorkflowLoaded 全仓只在 :5356（传 ({}, {})）与 :5382（传 filterCounts/filterSummary）；
   :5382 之前存在 filterCounts / filterSummary 的赋值
⑧ 行数逐块对账（搬出 75 + 转发器 11 + buildTile:3426 一行 + keydown 15；14 处能力调用 1:1；3 处 filter 删除）
```

## 九、真机（入场条件）

```
① 网格：Ctrl+A 全选 / Esc 清选 / 拖选区间 / 单击瓷砖 / 「下一处」逐条
② 整表重载：改页眉页脚后页数刷新；任务取消后刷新
③ 步骤条与自动应用角标：切视图不闪、不重复重画
④ 块框/建议失效：清理、拆分批量、内容变更（pageNos 分支只丢那几页）
```

## 十、提交

```
move(pages): 刀 9.5 —— 选择/网格/步骤/收尾 11 键 + 8 个事件能力（R8 42 → 39，deps 214 → 208）
Move-Gate: tests/js/boundary.test.mjs, tests/js/knife-registry.mjs
Approved-by: DevLead
```

## 十一、预算与对账口径

```
搬入 75 行 · 删除 11 转发器 + 75 搬出 + buildTile:3426 一行 + keydown 15 行 + 3 处 filter 删除
插入 14 处能力调用 + #page-grid click 委托 + keydown 段 + filterCounts/filterSummary 两行
跨行调用（:5372 带参最长）不按 1 行算；落盘逐块对账，对不上说明「预算错」还是「范围变了」
```
