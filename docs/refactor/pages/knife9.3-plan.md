# 刀 9.3 施工图：版心一族 12 键（R8 52 → 43，deps 219 → 214）

> 基线 `main@b7c05a6`（app.js 13,416 · pages-view.js 3,277 · deps 219 · R8 52 · kinds L2/T32/C18）。
> 行号是 **2026-10-30 实测的原始行号**（`knife-numbering.md §六`）；开工前必须重量。
> 权威曲线见 `export-ratchet.md §五`，本文件不复制曲线数字。

## 一、三句前提

```
① 12 个键的调用点全部落在 7 个宿主里，一个不漏
   ⇒「12 个键能不能死」完全等价于「7 个宿主能不能搬干净」
② 能不能搬接线，取决于被挂载的元素归谁：
     归自己的 view section（或挂 window）→ 能搬进模块（9.6 形态，0 新键）
     归 dialog / 外壳                     → 搬不了（R3 模块侧零豁免）⇒ 收能力
③ 「谁在搬」（宿主整段 / 只搬写点）决定加不加键；
   「deps 哪一笔死」（改直呼 / 搬宿主）决定 215 与 213 两个中间数
```

## 二、12 个键（死期 9.3）与它们带走的 dep

| 键 | 死法 | 它带走的 dep |
|---|---|---|
| `loadLayoutBlocks` | a 跟宿主搬（`scheduleLayoutBlocks` 只被模块调） | `scheduleLayoutBlocks` :13121（与下一行共 1 个） |
| `renderLayoutBlocks` | a | 同上（不重复计） |
| `ensureMarginFitted` | a（:700）+ `onTaskFinished`（:4297） | `confirmAllMargins` :13134 |
| `renderMarginPanel` | `onTaskFinished`（:4296） | — |
| `refreshMarginTiles` | `onTaskFinished`（:4295） | `refreshMarginTiles` :13035（自环 2 处） |
| `finishMarginDetectBar` | `onTaskFinished`（收尾 4 处） | — |
| `renderMarginStepVerdict` | `onTaskFinished`（:5702）+ `onLayoutDetectStarted`（:5670） | `renderMarginStepVerdict` :13118（自环 4 处） |
| `setMarginStatus` | `onTaskFinished`（4 处）+ `onLayoutDetectStarted`（:5673） | — |
| `savePageMargin` | 拖拽接线搬 + pointerdown 委托（:4049） | — |
| `refreshLayoutDetectEntry` | `onWorkflowLoaded`（:5533 ← `loadWorkflow`） | `refreshLayoutDetectEntry` :13115（自环 1 处） |
| `refreshMarginDetectHint` | `onWorkflowLoaded`（:5532） | `refreshMarginDetectHint` :13116（自环 3 处） |
| `showMarginDetectProgress` | `onLayoutDetectStarted`（:5672） | — |

## 三、三个新键（`onTaskProgress` 原样保留，**改名作废**）

```js
// 已存在，不动：onTaskProgress(data) —— pollTask:5358 每 tick，只更进度，不许碰瓷砖
function onTaskFinished(data)               // 新增：收尾一次（:5368 / 识别分支收尾），payload 只许数据
function onLayoutDetectStarted(totalPages)  // 新增：:5670 / :5672–:5673（两个调用位，closeModal:5671 留壳）
function onWorkflowLoaded()                 // 新增：:5532 / :5533（loadWorkflow 触发）
```

payload 只许带**数据**（`job_type` / `status` / `done` / `total` / 文案），**不许带「该调哪个函数」的字段**。

## 四、收尾调用位（定稿）

```
layout 分支：  :5361 stopTaskPolling() 之后置 `layoutDetectActive = false`（现 :5701 那次的提前版；
               原 :5701 随 reportLayoutDetectOutcome 整段删除，不再需要）
               :5367 await refreshMarginState() 之后（= 现 :5368 位置）调 onTaskFinished(data)
               :5370 reportLayoutDetectOutcome(data) **整段删除**
识别分支：     :5388 await refreshMarginState() 之后调 onTaskFinished(data)

为什么不能挂在 loadTasks 之后：ensureMarginFitted 会 POST /api/.../margin-box/fit-all（pages-view:1085），
多等一个 await 就多一个静默失败面。
```

`layoutDetectActive` 的时序是**状态正确性问题**，不是文案先后：
`marginStepVerdict()`（app.js:679）用 `if (layoutDetectActive || marginFitRunning) key = "working"` 决定 verdict；
若任务已结束而它仍为 true，模块画出来的是「检测进行中」——结论说反。
**机检：layout 分支里 `layoutDetectActive = false` 的行号必须小于 `onTaskFinished` 调用点。**

`reportLayoutDetectOutcome`（app.js:5698–5754）**整段搬进模块**（作为 `onTaskFinished` 的 layout 分支）：
正文文案逐字保持（5703–5716 / 5743–5747 的字符串不改）。它用到的 `marginPagesWithoutLines`、
`getLayoutDetectActive`、`renderMarginStepVerdict` 都已在注入表里（我核过），**不新增 dep**。

## 五、拖拽簇（方案 A：事件委托）

搬进模块（99 行）：`MARGIN_SNAP_PX:3888` · `MIN_MARGIN_SIDE:3890` · `tileMarginDrag:3895` ·
`pageLineEdges:3953–3966` · `clampMarginBox:3967–3975` · `snapMarginBox:3980–3993` ·
`startTileMarginDrag:3995–4019` · `onMarginPointerMove:4021–4039` · `onMarginPointerUp:4041–4050` ·
`setupMarginDrag:4052–4056`；`:11618` 的 `setupMarginDrag()` 调用搬进模块 init。

```
四个必须随簇搬入（不是注入；若改成注入 deps = 216，必须报出来）：
  pageLineEdges   → 只被 snapMarginBox:3981 用
  clampMarginBox  → 只被 snapMarginBox:3992 用
  MARGIN_SNAP_PX  → 只被 snapMarginBox:3985/3986 用
  MIN_MARGIN_SIDE → 只被 clampMarginBox:3969–3972 用
```

入口改委托（`buildTile` 是外壳函数，搬不进模块）：

```js
// wirePagesPageGrid（pages-view:3082，已有 #page-grid click 委托）
el("page-grid").addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".page-margin__handle");
  if (!handle) return;
  const tile = handle.closest(".page-tile");
  startTileMarginDrag(event, Number(tile.dataset.pageNo), handle.closest(".page-margin__box"), handle.dataset.edge);
});
// 删 app.js buildTile:3388–3391 三行 listener
```

`#page-grid` 归 view-pages（R3 允许）、`wirePagesPageGrid` 同一形态、:3087 已跳过 `.page-margin__handle`。
审校视图的 `.page-margin__box`（`paintReviewMargin:6569`）在 `#page-grid` 之外，委托碰不到，行为不变。

## 六、deps 214（逐键）

```
219
 −4  自环 13035 · 13115 · 13116 · 13118     「改直呼」那一笔 → 215
 −2  宿主 13121 · 13134                     「宿主搬走」那一笔 → 213
 −1  死键 13159 startTileMarginDrag（提供者搬走后键不存在，被迫删；模块从未读过）
 +2  applyMarginRect（壳里 3936 / 6569 仍用）· nearestEdge（壳里 snapBox:6924–6927 仍用）—— 注入，不复制
= 214
```

两只钟分开记：**自环 −4 在「改直呼」那笔死，宿主 −2 在「搬宿主」那笔死**，不写成一个减法。

## 七、硬约束（自环是附加动作，不是第四种死法）

```
任何键死亡那一笔，若模块里还有 injected.<键>：
  ① 同笔改直呼 ② 同笔删 deps 对应键 ③ 机检 injected.<键> == 0
10 处：renderMarginStepVerdict 4（216/1053/1067/1114）· refreshMarginDetectHint 3（239/1044/1113）
       · refreshMarginTiles 2（1100/1211）· refreshLayoutDetectEntry 1（240）
```

## 八、账本

```
registry 9.3 → landed
kinds：删 12 行 T · 加 3 行 C（onTaskFinished / onLayoutDetectStarted / onWorkflowLoaded）；onTaskProgress 不变
VIEW_EXPORTS names：52 − 12 + 3 = 43
kinds 三数：T 32 → 20 · C 18 → 21 · L 2        ② 推导值 21 → 24
```

## 九、验收（八条）

```
① R8 43：api 43 · VIEW_EXPORTS 43 · kinds T20 / C21 / L2
② 12 键三栏归零（剥注释含值位）：app.js 裸标识符 = 0 · PagesView.<键> = 0 · 其它模块 injected.<键> = 0
③ 3 个新键在 api 且**真被调用**（onTaskFinished / onLayoutDetectStarted / onWorkflowLoaded 各有调用点）
④ 自环 10 处改直呼；grep injected.<那 4 个键> = 0
⑤ deps 214 逐键（含 13159 删、+2 helper；若 216 必须解释）
⑥ scripts/audit_ui_asset_literals.py →「会假红 = 0」
⑦ 四闸原文 + paths.STATIC_DIR + pytest（PYTHONPATH）
⑧ 机检两条：
   · onTaskProgress 函数体内 grep refreshMarginTiles|renderMarginPanel|ensureMarginFitted
     |renderMarginStepVerdict|setMarginStatus|finishMarginDetectBar = 0（每 tick 只更进度）
   · 收尾一次：refreshMarginTiles / renderMarginPanel / ensureMarginFitted 各被调 1 次（今天也是 1 次）；每 tick 0 次
   · layout 分支里 layoutDetectActive = false 的行号 < onTaskFinished 调用点
```

## 十、真机（入场条件）

```
① 版心检测：#margin-fit-text 随 job.done 真增长（不是能力直调 + 合成数据）；未验写「未验」
② 版心拖动保存：拖一次、松手、刷新后框还在（走新委托路径）
③ 全页确认版心：点一次，页数对得上
```

## 十一、提交

```
move(pages): 刀 9.3 —— 版心一族 12 键 + 3 个事件能力（R8 52 → 43，deps 219 → 214）
Move-Gate: tests/js/boundary.test.mjs, tests/js/knife-registry.mjs
Approved-by: DevLead
```

## 十二、预算（落盘后对账）

```
顺序：宿主搬走 · layoutDetectActive 提前归零 · onTaskFinished 两个调用位 · 两个接线能力接上
     · 拖拽 99 行搬入 + buildTile 三行删除 + 委托 · reportLayoutDetectOutcome 整段搬入
deps：219 → 215 → 213 → 214（逐笔见 §六）
行数：app.js 大减 / pages-view.js 大增，逐块报
键数：52 − 12 + 3 = 43
```
