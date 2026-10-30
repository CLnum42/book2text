# 刀 3 施工图：版心操作（15 个函数 / 32 处 id 引用）

> **机读名单**：`docs/refactor/pages/knife3-movers.json`（本文件是它的可读版，两处若冲突以 json 为准）。
> **量于** `app.js` 14,752 行 · `pages-view.js` 1,511 行 · R3 `total 155 / ids 64`（2026-10-30）。
> 行范围是**当前树**的，不是 seed 里的旧行号（seed 写于刀 2.5，已漂）。

## ① 可机读名单（函数名 + 行范围 + 口径 + 处数）

口径 = `view-pages` 子树 id 引用（`el()` / `getElementById()` / `querySelector("#…")`），与 R3 闸逐字一致。

| 函数 | 行范围（当前树） | 行数 | id 处数 | 需转发器 | 主要调用者 | 主要 deps |
|---|---|---:|---:|---|---|---|
| `loadFinishSummary` | 10909–10940 | 32 | 1 | 是 | `afterCleanupApplied`、`afterContinuationChange`、`boot`、`confirmCurrentPage` | `apiJson`、`currentProject`、`el`、`finishSummary`、`finishSummaryAgain` |
| `loadLanguageSummary` | 13905–13923 | 19 | 1 | 是 | `showView` | `apiJson`、`currentProject`、`el` |
| `loadPageNumberSummary` | 5274–5291 | 18 | 1 | 是 | `adoptPageNumberTemplate`、`hydrateView`、`removePageNumberRange`、`savePageNumberManual` | `apiJson`、`currentProject`、`el`、`loadPageNumberMetrics` |
| `refreshLayoutDetectEntry` | 888–918 | 31 | 1 | 是 | `boot`、`renderLayoutStatus` | `currentProject`、`el`、`marginUndeterminedPages`、`selectedPages`、`selectionPages` |
| `refreshMarginDetectHint` | 862–885 | 24 | 1 | 是 | `boot`、`renderLayoutStatus` | `currentProject`、`el`、`marginStepVerdict` |
| `refreshMarginTiles` | 4748–4759 | 12 | 1 | 是 | `boot`、`refreshMarginState`、`resetMarginsToAuto`、`syncStepToggles` | `clearTileMargin`、`currentProject`、`pagesMarginOn`、`paintTileMargin`、`visiblePageNos` |
| `renderAutoApplyStatus` | 12971–12995 | 25 | 1 | 是 | `loadAutoApplyStatus` | `autoApplyTypeText`、`el`、`latestAutoApply`、`undoAutoApply` |
| `renderMarginStepVerdict` | 793–848 | 56 | 4 | 是 | `boot`、`reportLayoutDetectOutcome`、`startLayoutDetectFromDialog` | `currentProject`、`el`、`layoutDetectActive`、`marginStepVerdict` |
| `renderPageNumberMetrics` | 5211–5254 | 44 | 3 | 是 | `loadPageNumberMetrics`、`loadPageNumberSummary`、`refreshPageNumberAnalysis` | `currentProject`、`el`、`pageNumberAnalysis` |
| `renderPageSummary` | 5896–5906 | 11 | 1 | 是 | `boot` | `currentProject`、`el`、`recognitionOf`、`visiblePages` |
| `renderRecognitionSettings` | 3198–3252 | 55 | 10 | 是 | `applyProjectSettings`、`boot`、`loadAppInfo`、`patchRecognitionSetting` | `RECOGNITION_ENGINE_LABELS`、`el`、`engineProbe`、`recognitionSetting` |
| `renderStepPanels` | 558–618 | 61 | 1 | 是 | `boot`、`syncWorkflowSteps` | `currentProject`、`currentView`、`el`、`ensureMarginFitted`、`lastStepPanelKey` |
| `renderWorkflowFilter` | 6608–6638 | 31 | 1 | 是 | `loadWorkflow` | `WORKFLOW_FILTERS`、`el`、`pendingPageCount`、`workflowConfirmationCounts` |
| `syncStepToggles` | 626–657 | 32 | 2 | 否 | `renderStepPanels` | `clearTileMargin`、`currentProject`、`currentView`、`el`、`pagesMarginOn` |
| `updateRecognitionAuxProgress` | 5016–5034 | 19 | 3 | 是 | `pollTask` | `el`、`estimateRemainingSeconds`、`formatDuration` |

**合计**：15 个函数 / 470 行 / 32 处 id 引用。

## ② 每一条搬去哪里

全部搬进 `backend/book2text/static/pages-view.js`（刀 1 起就是唯一的 pages 模块）。搬完留在 `app.js` 的转发器
**只有 14 条**（每个有外部调用者的函数一条，形如 `function X(){ return window.PagesView.X.apply(window.PagesView, arguments); }`）；
`syncStepToggles` 的唯一调用者 `renderStepPanels` 也在本刀内搬走 → **不需要转发器**。

## ③ deps 新增清单（45 个名字：**25 函数 + 20 状态/常量**）

跨刀仍住在 `app.js`、被搬走的函数体引用的名字（生成器按 IDENT 生成 deps 键）：

**函数（25）**：`apiJson` · `autoApplyTypeText` · `clearTileMargin` · `engineProbe` · `ensureMarginFitted` ·
`estimateRemainingSeconds` · `flushBootQueue` · `formatDuration` · `loadPageNumberMetrics` · `marginStepVerdict` ·
`marginUndeterminedPages` · `paintTileMargin` · `recognitionOf` · `recognitionSetting` · `renderFinishPanel` ·
`renderLayoutBlocks` · `renderMarginPanel` · `renderRecognitionStatus` · `scheduleLayoutBlocks` · `selectionPages` ·
`showError` · `syncWorkflowSteps` · `undoAutoApply` · `updateFinishChips` · `visiblePages`

**状态 / 常量（20）**：`RECOGNITION_ENGINE_LABELS` · `WORKFLOW_FILTERS` · `currentProject` · `currentView` · `el` ·
`finishSummary` · `finishSummaryAgain` · `finishSummaryLoading` · `finishSummaryProject` · `lastStepPanelKey` ·
`latestAutoApply` · `layoutDetectActive` · `pageNumberAnalysis` · `pagesMarginOn` · `pendingPageCount` ·
`selectedPages` · `stepsReady` · `visiblePageNos` · `workflowConfirmationCounts` · `workflowStep`

（分类由脚本按「`^function` / `^let|const`」判定，不是手分——总数 45 对但分栏反了正是"函数与状态混一栏"的老亏。）
最终键名以生成器 dry run 的 `injected_keys` 与 R13 为准。

## ④ 验收判据（具体数，不是"会下降"）

```
· R3 total：155 → 123
  算式：155 − 32（15 个 mover 在 app.js 里的 id 引用处数）
  形态分解：基线 155 = el 148 + querySelector 7；mover 32 = el 29 + querySelector 3
  **口径必须在两端一致**：若按 el-only 数 mover 得 29 → 会算成 126，但基线 155 含 querySelector，
  那样就变成「分子漏 3 处」的假数——验收时 R3 会显示 123，写 126 的人会以为漏搬了函数。
· R3 ids：64 → 44（本刀触及 25 个 id：20 个归零 + 5 个只部分归零）
  部分归零（**本刀不归零，责任在刀 4**）：page-grid · pages-margin-toggle · pages-overlay-toggle ·
  pages-zoom-in · pages-zoom-label（applyPageZoom / toggleMarginView / togglePageBlocksOverlay 也引用它们）
· 导出面：16 → 16（本刀不删导出，只减 app.js 里的 DOM 字面量）
· app.js 行数：14,752 → 约 14,282（−470）
· pages-view.js：1,511 → 约 1,981（+470）
· 硬判据：node 闸 152 pass / 0 fail · R13「模块必读键都在注入表里」= 0 · accept --stage 2 exit 0
```

## ④b 口径两条（写进名单，避免再算错）

```
(a) refs 是**函数级**的，不是 id 级：多 id 的 mover 按 id 累加会把同一处算两次
    （Architect 第一次这么算出 inside=118 > total=77）。
(b) page-grid / pages-margin-toggle 本刀**不归零**，归零责任在刀 4。
```

## ④c 验收数与验收器同口径

```
R3 的 total 含 el / querySelector 两种形态（155 = 148 + 7）。
本刀搬走的 32 处 = el 29 + querySelector 3，故 155 − 32 = 123。
若按 el-only 数得 29（→126），那是分子分母不同口径，验收时会与闸的实际输出差 3。
```
**29 从哪来的（Architect 的根因，比"只数 el"更准确）**：它用的模式是
`querySelector(?:All)?\(\s*["']#([a-z0-9-]+)["']` —— **要求引号紧跟 id**；
而这三处 id 后面还有后代选择器，被它整条漏掉：

```
4751  querySelectorAll("#setup-panel details[data-panel]")     ← 本刀 renderStepPanels 内
598   querySelectorAll("#page-grid .page-tile")                 ← 本刀 refreshMarginTiles 内
653   querySelectorAll("#page-grid .page-tile")                 ← 本刀 syncStepToggles 内
```

验收器（`domIdsIn` / `r3_pages_count.mjs`）按 `#id` **前缀**匹配，所以含这三处 → 分子 32、分母 155。
**若有人用"精确匹配"重算，会得到 29，然后以为验收器错了**——所以这 3 行必须写在这里。

**规矩（两条）**：

1. 报任何 R3 计数前，先声明**分子与分母各含哪些形态**（el / getElementById / querySelector）;
2. 还要声明**模式锚在哪**：`"#id"` **精确匹配** 还是 `"#id…"` **前缀匹配**——只说"同口径"不够，
   今天这个 3 的差就是锚点不同造成的。

## ⑤ 施工顺序（照做，不要一次性搬完）

```
1. **步 1 跳过（本刀无 test 改动）**——结论与理由：
   · 这 15 个函数搬进模块**不改变 wireAll 的段数与 id 数**，所以 pages-wire 的 37/34 不动；
   · R3 豁免表的 cap 是**上限**，引用处数下降不需要改表（只在"引用归零"时才要删项，本刀归零的 20 个 id
     **不在豁免表里**——它们属于"总账 155"，不是过渡豁免表的项）；
   · 唯一会变的是 `r3_pages_count` 的 total（155→123）与 ids（64→44），这两个数**不在任何测试常数里**
     （测试只断言"下降且不归零"这类形态）。
   ⇒ 因此**没有 test-contract 笔**。若 Builder 在搬完后发现某个常数确实变了，停下报我，不要"顺手校准"。
2. 生成器 dry run（不 --write）：确认 movers 重名 / 状态声明重复 / api 键集合 三条守卫全过，
   且 `injected_keys` 与 ③ 的 45 键对得上；对不上先查名单，不要改规则迁就
3. 产品第一笔：只加装配 —— pages-view.js 里 15 个函数体的**空壳顺序** + deps 注入键骨架，
   app.js 里 14 条转发器；此时 node 闸必须仍绿（函数体还没搬，行为不变）
4. 逐函数搬：按行范围从下往上搬（避免行号漂移），**每搬一个跑一次 node 闸**（不是 node --check），
   搬完立即删掉 app.js 里的旧函数体，不许"新旧并存"过夜
5. 搬完核对：app.js 行数 ≈14,282、pages-view.js ≈1,981、R3 total 123 / ids 44；
   任一个差 >10 就停下查（差 3 就是 querySelector 那三处口径问题）
6. 最后才删不再需要的转发器（本刀 0 条：14 条全都要留，syncStepToggles 本就不需要）
```

**为什么强调「逐函数 + 每搬一个跑一次闸」**：`bodyPending` 那次是「插错作用域、语法对、
单测绿、真跑才炸」——一次搬 15 个函数时，红在哪里要靠二分，成本是逐个搬的数倍。



```
1. test-contract: 一笔，只动 tests/js（把 pages-wire 的量随函数搬迁校准）
2. 产品一笔：app.js 少 15 个函数体 + 14 条转发器，pages-view.js 多 15 个函数 + wireAll 接线不变
3. 每搬一处跑 node 闸（不是 node --check）
4. 自检：movers 重名 / 声明重复 / api 键集合（生成器三条守卫）
```

## ⑥ 未决（需要复核人拍）

```
· `applyPageZoom` / `toggleMarginView` / `togglePageBlocksOverlay` 三个"版心/缩放开关"也引用 pages id，
  但它们在 seed 里归刀 4 —— 本刀不碰，避免和刀 4 的名单打架。
· 本刀搬完，`pages-view.js` 到约 1,981 行；刀 4/5 之后仍需再收 exports 16 → 3。
```

## ⑦ rules 路线（甲）：`docs/refactor/pages/knife3-rules.py`

**不是复制一份，是扩展**：`importlib` 读入 `docs/refactor/evidence/pages/rules.py`，原样继承
`INTERFACE`(16) / `SET_BLOCKS` / `MOVED_STATES` / `INIT_ANCHOR` / `FORWARDERS`，只做一件事——
把这 15 个函数体引用、但仍住在外壳的 45 个名字（25 函数 + 15 `let` + 5 `const`）加进 `IDENT`，
并按 `knife3-movers.json` 把**本刀搬走的函数**从 `IDENT` 里剔掉（否则撞 `movers ∩ IDENT` 守卫）。

命令：

```sh
python3 docs/refactor/evidence/build_view.py \
  --movers docs/refactor/pages/knife3-movers.json \
  --rules  docs/refactor/pages/knife3-rules.py \
  --name Pages --app backend/book2text/static/app.js --out /tmp/k3-dry
```

**dry run 目前的状态（Builder 照实看，别以为是配置错）**：`residue: []`、
`injected_keys: 46`，但有两条**已知缺口**要补在 build_view 里，不是名单错：

```
(a) anti 报「renderPages / el / ensureMarginFitted / renderLayoutBlocks / renderMarginPanel /
    renderRecognitionStatus 判注入，但模块正文里仍裸引用」——这些名字**模块里本来就有声明**
    （el 与刀 1 搬进去的函数），裸引用是对的；anti 还没像 residue 那样把"现模块声明"算进去。
    修法同 residue：anti 计算时把现有 pages-view.js 的声明并进白名单。
(b) 「给 getter 赋值 9 处」——这些是本刀函数体里的写点（如 finishSummaryAgain = …），
    要补 `SETTERS`。名单下一步从 dry run 的错误串里逐条取，别手猜。
```

这两条属于生成器/规则的补齐，**不影响本施工图的名单与验收数**；补完再让 Builder 跑。
