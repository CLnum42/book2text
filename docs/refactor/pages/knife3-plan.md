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
1. **没有 test-contract 笔**，但 `tests/js` 会改**一张登记表**，落在同一笔 `move(pages):` 里：
   · 这 15 个函数搬进模块**不改变 wireAll 的段数与 id 数**，所以 pages-wire 的 37/34 不动；
   · R3 豁免表的 cap 是**上限**，引用处数下降不需要改表（只在"引用归零"时才要删项，本刀归零的 20 个 id
     **不在豁免表里**——它们属于"总账 155"，不是过渡豁免表的项）；
   · 唯一会变的是 `r3_pages_count` 的 total（155→123）与 ids（64→44），这两个数**不在任何测试常数里**
     （测试只断言"下降且不归零"这类形态）；
   · **但 R8（按模块导出棘轮）会红**：14 条转发器 = 模块多 14 个导出键，`VIEW_EXPORTS` 里 pages 那条
     必须同批从 20 改成 **34**（逐键带死亡刀号注释，见 ⑩）——它属于"三张登记表"，`move:` 笔允许改，
     **但必须在提交信息里写 `Move-Gate: tests/js/boundary.test.mjs`**；不写 = 判据照旧（A1 红，报"偷改判据"）。
   ⇒ **没有 test-contract 笔**，但**确实有 tests/js 改动**，且只能落在 `VIEW_EXPORTS` 块内。
   若 Builder 在搬完后发现别的常数确实变了，停下报我，不要"顺手校准"。
2. 生成器 dry run（不 --write）：确认 movers 重名 / 状态声明重复 / api 键集合 / setter 不进 IDENT /
   能力不进 IDENT 五条守卫全过，且 `injected_keys` 与 `deps_literal_keys` **相等且都等于 46**
   （46 = 模块正文实际用到的键，**不是** ③ 那个 45 条声明）；对不上先查名单，不要改规则迁就
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



**提交形态（单笔，不是「先 test-contract 后产品」）**：

```
一笔 move(pages): … 内同时含：
  ① backend/book2text/static/app.js         −15 个函数体 +14 条转发器 + 28 个新 deps 键
  ② backend/book2text/static/pages-view.js  +15 个函数体（470 行）+ api 补 14 键 + init 里的能力键
  ③ docs/refactor/evidence/pages/stage2-movers-seed.md  −15 行
  ④ tests/js/boundary.test.mjs              VIEW_EXPORTS 的 pages：20 → 34（只许这块）
  ⑤ docs/refactor/pages/knife3-rules.py + 本页文档

提交信息（两条登记缺一不可）：
  move(pages): <一句话>
  Move-Gate: tests/js/boundary.test.mjs      ← ④ 的声明；不写 = A1 报"改 tests/js 却没声明"
  Approved-by: DevLead                       ← move: 笔同样要留痕（9d2ac58 的先例）
```

拆开任何一脚都会红：app.js 单提 → seed 缺名（R3）；seed 单提 → 索引里没有新函数；
表单提 → R8 见到 34 个导出但登记 20 个。**只有一笔能过，所以它必须被审。**

## ⑥ 未决（需要复核人拍）

```
· `applyPageZoom` / `toggleMarginView` / `togglePageBlocksOverlay` 三个"版心/缩放开关"也引用 pages id，
  但它们在 seed 里归刀 4 —— 本刀不碰，避免和刀 4 的名单打架。
· 本刀搬完，`pages-view.js` 到约 1,981 行；刀 4/5 之后仍需再收 exports 16 → 3。
```

## ⑦ rules 路线（甲）：`docs/refactor/pages/knife3-rules.py`

**不是复制一份，是扩展**：`importlib` 读入 `docs/refactor/evidence/pages/rules.py`，原样继承
`INTERFACE`(16) / `SET_BLOCKS` / `MOVED_STATES` / `INIT_ANCHOR` / `FORWARDERS`，另外加三段：
① 把这 15 个函数体引用、但仍住在外壳的 45 个名字（25 函数 + 15 `let` + 5 `const`）加进 `IDENT`；
② 8 条同名 setter 进 `SETTERS`（写点走 `injected.setX(…)`，不是给 getter 赋值）；
③ 跨视图能力进 `CAPABILITIES`（`indexRefresh` → deps 生成 `indexRefresh: () => window.IndexView?.refresh(),`）。
再按 `knife3-movers.json` 把**本刀搬走的函数**从 `IDENT` 里剔掉（否则撞 `movers ∩ IDENT` 守卫）。
**setter 与能力都不许进 `IDENT`**——进了就生成 `键: 键` 自引用，语法过、运行时炸（生成器三条守卫）。

命令：

```sh
python3 docs/refactor/evidence/build_view.py \
  --movers docs/refactor/pages/knife3-movers.json \
  --rules  docs/refactor/pages/knife3-rules.py \
  --name Pages --app backend/book2text/static/app.js --out /tmp/k3-dry
```

**dry run 目前的状态**：`residue: []`、`anti: []`、`injected_keys: 46`、`deps_literal_keys: 46`。
文档里曾列的"两条已知缺口"（anti 不认模块已有声明 / 缺 SETTERS）**已按下面修完并在 dry run 上验过**：

```
(a) anti 与 residue 同口径：把现有 pages-view.js 的声明并进白名单
    → 修前 6 条误报（renderPages / el / ensureMarginFitted / renderLayoutBlocks / renderMarginPanel /
      renderRecognitionStatus），修后 anti []
    → 反证：把白名单临时去掉，6 条必须回来（2026-10-30 已验）
(b) SETTERS 8 条（9 处写点）从错误串逐条取；守卫「setter 不得进 IDENT」已加，
    反证：把某个 setter 名塞回 IDENT → exit 2「deps 会生成自引用」
(c) 能力（capability）出口：`CAPABILITIES` 段生成 `键: () => 表达式,`；
    守卫「能力不得进 IDENT」+「同一键不得既 CAPABILITIES 又 SETTERS」+ anti「能力声明了但正文没用到 = 空声明」，
    三条各喂过一次红（原文见提交说明 / docs/refactor/pages/incremental-write.md 零点五）
```

## ⑧ 四个数各是什么（45 / 40 / 46 / 208）——不要互相替代

| 数 | 是什么 | 量法 | 常见误用 |
|---|---|---|---|
| **45** | `knife3-rules.py` 里 `IDENT_KNIFE3` 的**声明条数**（25 函数 + 15 `let` + 5 `const`） | 数列表长 | 当成 deps 键数去验收 |
| **40** | 真正进 `IDENT` 的条数：45 − 5 条"模块已声明"（`el` / `ensureMarginFitted` / `renderLayoutBlocks` / `renderMarginPanel` / `renderRecognitionStatus`）；`movers ∩ IDENT` 交叉剔除 **0** 条 | 生成器同一口径过滤 | 以为 45 全进了规则表 |
| **46** | dry run 的 `injected_keys`：**模块正文实际出现**的 `injected.X` 键（40 条里用到 36 + SETTERS 用到 7 + 能力 1 + 基规则补 2：`getSelectedPages` / `setPagesMarginOn`） | `re.findall(r"injected\.(\w+)", strip_code(blank_deps(module)))` | 用"45 剔 5 个"算术凑 |
| **208** | 最终 init deps 键总数 | HEAD 180 ∪ 46，重叠 18、新增 28 | 180 + 46 = 226（忘了重叠） |

声明了但正文**没用到**、因此**不进 deps** 的 5 个：`getFinishSummary` / `getFinishSummaryProject`
（HEAD 里本来就有，留着无害、不新增）/ `getLatestAutoApply` / `selectedPages` / `setCurrentView`。
生成器的 `deps_literal(rules, used)` 现在只输出 `used` 里的键，所以它们不会变成死键。

**结论：验收看 46（`injected_keys` == `deps_literal_keys`）与 208（init 键集合 = 180 ∪ 46）。**
"45" 只作为名单条数存在，**不参与验收**。以后任何"计划与 dry run 差几"的情况，先把两边的
**键名清单**打出来对集，不要用总数猜——今天的 393/394、123/126、32/29 都是总数对不上、名字没人对。

## ⑨ deps 最终数（**以 dry run 为准**，不写算术凑出来的数）

dry run 原值：`injected_keys: 46`，四栏构成相加 = 46（不等就说明分类错了，停下查）：

```
函数 / 值 24 + getter 13 + setter 8 + 能力 1（indexRefresh）= 46
```

（上一版写"25 + 13 + 8"是把能力键并进了"函数/值"一栏——**分栏错了**，总数只是碰巧对。
本版按键名逐个归类，四栏相加 = 46，并单独留"能力"一栏。）

最终 init deps 键总数 **208**：HEAD 的 180 键 ∪ 本刀 46 键，重叠 18 → 新增 28。
`deps_literal_keys` 与 `injected_keys` **必须相等**（刀 3：46 = 46）；不等就是生成器又把整表倒出来了。

规矩：**deps 数字永远抄 dry run 原值，并给出四栏构成；四栏相加必须等于总数；最终总数用集合相等判，不用相加。**

## ⑩ 刀 3 的 R8 表（14 个导出键，逐条 + 死亡刀号）

本刀搬进模块后，外壳为每个有外部调用者的 mover 留一条转发器 → 模块多导出 14 个键，
R8（导出棘轮）从 20 → 34。**34 是本刀上限，不是新基线**：本刀之后任何新增键都要重新签字。

| 导出键 | 死亡刀号 | 说明 |
|---|---|---|
| `loadFinishSummary` | 刀 4 | 调用者（afterCleanupApplied / pollTask / setupReviewControls …）在刀 4 搬 |
| `loadLanguageSummary` | 刀 4 | 唯一调用者 `showView` 留在外壳（导航入口），到期即删转发器 |
| `loadPageNumberSummary` | 刀 4 | 调用者在页码相关函数里，刀 4 一并搬 |
| `refreshLayoutDetectEntry` | 刀 4 | boot / renderLayoutStatus 在刀 4/5 |
| `refreshMarginDetectHint` | 刀 4 | 同上 |
| `refreshMarginTiles` | 刀 4 | 调用者 refreshMarginState / resetMarginsToAuto 在刀 4 |
| `renderAutoApplyStatus` | 刀 4 | 唯一调用者 `loadAutoApplyStatus` 在刀 4 |
| `renderMarginStepVerdict` | 刀 4 | boot / reportLayoutDetectOutcome 在刀 4/5 |
| `renderPageNumberMetrics` | 刀 4 | 页码三函数在刀 4 |
| `renderPageSummary` | 刀 5 | 唯一调用者 `boot`（刀 5 收 boot）|
| `renderRecognitionSettings` | 刀 5 | boot / loadAppInfo / patchRecognitionSetting（刀 4/5）|
| `renderStepPanels` | 刀 5 | boot / syncWorkflowSteps（刀 5）|
| `renderWorkflowFilter` | 刀 5 | 唯一调用者 `loadWorkflow`（刀 5）|
| `updateRecognitionAuxProgress` | 刀 5 | 唯一调用者 `pollTask`（刀 5）|

逐刀下降核法：刀 3 后 34 → 刀 4 清 9 个（表中"刀 4"）→ 25 → 刀 5 清 5 个（"刀 5"）→ 20，
再往后的刀才处理"删转发器"那批。**每刀都要在 R8 表里重新签字，不能继承。**

## ⑪ seed：本刀要删的 15 条（随 `move(pages):` 一笔落）

搬到模块后 `app.js` 只剩单行转发器，R3 实测口径（`domIdsIn` 扫 app.js）不再认这 15 个名字，
seed 里对应行必须删。

**提交形态（2026-10-30 更正，我上一版写过两次"tests/js 一行不动"，都错了）**：不是「先 test-contract 后产品」，
是**一笔 `move(pages):`**，而且它**会**改 `tests/js` 的一张登记表。依据（`tests/js/feature-contract.mjs`）：

```
:511  const isMove = /^move[(:]/.test(subject);
:534  if (deletions > 0 && touchesTests && !isMove && !isContract) → A3 红
      ↑ move: 笔整支豁免 A3（不必先 test-contract，也不必拆两笔）
:137  const MOVE_TABLES = ["OWNERS", "VIEW_STATE_PREFIXES", "VIEW_EXPORTS"]
:399  A1: move: 笔必须**同时**含 backend/book2text/static/ 与 tests/js/ 改动（空声明的 move: 是伪装）
:175  Move-Gate 只认白名单：boundary.test.mjs / feature-contract.mjs / pages-r3-exemptions.mjs
:218  声明了却没改 = 空声明（伪装）；:224 改了 tests/js 却没声明 = 偷改判据
```

所以这一笔的全部改动（缺一条都红）：

```
① backend/book2text/static/app.js           −15 个函数体 + 14 条转发器 + 28 个新 deps 键
② backend/book2text/static/pages-view.js    +15 个函数体（470 行）+ api 补 14 键 + init 里的 indexRefresh
③ tests/js/boundary.test.mjs                VIEW_EXPORTS 的 pages：20 → 34（**只许这一块**，逐键带死亡刀号）
④ docs/refactor/evidence/pages/stage2-movers-seed.md   −15 行
⑤ docs/refactor/pages/knife3-rules.py + 本页文档

提交信息（两条登记缺一不可）：
  move(pages): <一句话>
  Move-Gate: tests/js/boundary.test.mjs
  Approved-by: DevLead
```

**为什么 ③ 跑不掉**：14 条转发器 = 模块多导出 14 个键，R8（按模块导出棘轮）要求
`VIEW_EXPORTS` 里的名字与数量**等于**模块实际导出——不登记就红在"34 ≠ 20"。
它属于三张登记表，`move:` 通道允许改；但 `Move-Gate` 是**声明**不是权限：声明了却没改、或改了没声明，两种都红。

**这三张表不存在"seed 落在哪张"**：`OWNERS`（视图名 → 守卫函数）/ `VIEW_STATE_PREFIXES`（状态前缀归属）/
`VIEW_EXPORTS`（每模块导出白名单）都在 `tests/js`，seed 是 `docs/` 下的 R3 数据文件，不在表内。

逐条（seed 里各占 1 行）：

```
loadFinishSummary · loadLanguageSummary · loadPageNumberSummary · refreshLayoutDetectEntry
refreshMarginDetectHint · refreshMarginTiles · renderAutoApplyStatus · renderMarginStepVerdict
renderPageNumberMetrics · renderPageSummary · renderRecognitionSettings · renderStepPanels
renderWorkflowFilter · syncStepToggles · updateRecognitionAuxProgress
```

**删后两侧数**（量于当前树）：seed 唯一函数名 65 → **50**；实测函数并集 65 → **50**。
（seed 数据行是 68，因为 `setupLibrary` 占了 4 行；**行数 ≠ 名字数**，对集用名字数。）

**seed 与 caps 是两套东西**：seed 是"函数 → 引用 id → 到期刀"的映射；`PAGES_R3_TOTAL_CAP`
是豁免表的处数上限。本刀只删 seed 行，**不动 `PAGES_R3_TOTAL_CAP`**（155 → 123 是总账下降，
不是豁免表收紧；豁免表本刀 0 项变动）。
