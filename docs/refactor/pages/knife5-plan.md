# 刀 5 施工图：R3 归零 —— 31 个函数搬家 + 7 处片段抽取

> **状态**：施工图（未动代码）。量于 `7caff23` 树：`app.js` **14,095** 行 · `pages-view.js` **2,287** 行 ·
> R3 **101 处 / 38 种** · 模块 api **36** 键 · init deps **213** 键。
> 名单唯一出处：`knife5-movers.json` · 规则：`knife5-rules.py`（可跑，dry run 已绿）。
> **R3 归零要走三步**（本刀只做前两步里属于"函数搬家"的那部分）：
> 31 个 mover（51 处）→ 7 处片段抽取（25 处）→ 推迟的两刀（25 处）。**101 = 51 + 25 + 25**。

## 摘要（先给数）

| 指标 | 前 | 后（本刀） | 归零（本刀 + 片段抽取 + 两刀） |
|---|---|---|---|
| R3 处数 | **101** | **50**（−51） | **0** |
| R3 id 种数 | **38** | **24**（−14） | **0** |
| R8 模块导出 | **36** | **50**（+15 转发 −1 死） | 22（要等**导出收口刀**，见 §⑧） |
| init deps 键 | **213** | **211**（−20 +18） | — |
| `app.js` 行数 | 14,095 | **≈13,457**（−651 +15 −2） | — |
| `pages-view.js` 行数 | 2,287 | **≈2,984**（+651 源行 +31 空行 +15 api） | — |
| R3 seed 名字 | 42（45 行） | **11**（14 行） | — |
| dry run | — | `residue []` · `anti []` · `injected_keys 80` · `deps_literal_keys 80` | — |

## ① 名单与口径

```
口径：view-pages 子树 id 引用，三种形态 el(id) / getElementById(id) / querySelector(All)("#id…")，
      模式锚 = **前缀匹配** `#id`（与闸 R3 的 domIdsIn 逐字一致）；先剥注释，字符串保留。
      量具：scripts/r3_pages_count.mjs --json（只读一棵树）。
分类判据（本刀特有）：候选 = 持有 view-pages id 的顶层函数；
      再按"是否也持有别的视图/弹层的 id"分成 **可搬（0 个别的 id）** 与 **片段抽取（有别的 id）**。
      ——这条分类直接推出处理方式，不是按名字或重要性分。
```

| 函数 | 行范围 | 行数 | refs | 搬运形态 |
|---|---|---|---|---|
| `visiblePages` | 3283–3301 | 19 | 5 | 搬 |
| `finishMarginDetectBar` | 6344–6353 | 10 | 4 | 搬 |
| `showMarginFitProgress` | 634–644 | 11 | 3 | 搬 |
| `checkSelection` | 5537–5573 | 37 | 3 | 搬 |
| `showMarginDetectProgress` | 6275–6282 | 8 | 3 | 搬 |
| `togglePageBlocksOverlay` | 3985–3999 | 15 | 2 | 搬 |
| `toggleMarginView` | 4204–4219 | 16 | 2 | 搬 |
| `ensureMarginAudit` | 4419–4467 | 49 | 2 | 搬 |
| `startBatchRecognition` | 5492–5519 | 28 | 2 | 搬 |
| `startLayoutDetection` | 6092–6115 | 24 | 2 | 搬 |
| `patchSelectedPages` | 12083–12107 | 25 | 2 | 搬 |
| `setAutoApplySetting` | 12418–12449 | 32 | 2 | 搬 |
| `pausePageThumbnails` | 142–149 | 8 | 1 | 搬 |
| `hideMarginFitProgressSoon` | 646–651 | 6 | 1 | 搬 |
| `setRecognitionStatus` | 2983–2995 | 13 | 1 | 搬 |
| `patchRecognitionSetting` | 3001–3023 | 23 | 1 | 搬 |
| `ensureSuggestionScrollListener` | 3217–3225 | 9 | 1 | 搬 |
| `scanVisiblePageSuggestions` | 3238–3276 | 39 | 1 | 搬 |
| `openPageSetup` | 3692–3701 | 10 | 1 | 搬 |
| `pageScroller` | 3878–3880 | 3 | 1 | 搬 |
| `capturePageTileMetrics` | 3882–3913 | 32 | 1 | 搬 |
| `queueOverlayRender` | 4007–4017 | 11 | 1 | 搬 |
| `pumpOverlayRender` | 4029–4061 | 33 | 1 | 搬 |
| `setMarginStatus` | 4349–4361 | 13 | 1 | 搬 |
| `startAuxiliaryAll` | 4553–4576 | 24 | 1 | 搬 |
| `resetMarginsToAuto` | 4620–4689 | 70 | 1 | 搬 |
| `setPageNumberStatus` | 4739–4751 | 13 | 1 | 搬 |
| `rerunAuxiliary` | 13241–13261 | 21 | 1 | 搬 |
| `forgetAllPageSuggestions` | 3097–3104 | 8 | 1 | 搬 |
| `initPanelAccordion` | 3656–3689 | 34 | 1 | 搬 |
| `forgetAllPageBlocks` | 3856–3862 | 7 | 1 | 搬 |
| **合计** | | **651** | **51** | 31 个 |

## ② 每条：搬去哪 · 谁调它 · 留哪些转发器

**搬去哪**：`pages-view.js` 里 `function wireAll()` 之后、`function init(deps)` 之前（同刀 3/4）。

**15 个需要转发器**（外壳还有调用者；括号里是外壳调用者）：

```
checkSelection(←setupReviewControls) · finishMarginDetectBar(←reportLayoutDetectOutcome)
forgetAllPageBlocks(←refreshAfterTypeChanges) · forgetAllPageSuggestions(←afterCleanupApplied/applySplitBatch/pollTask/refreshAfterTypeChanges)
pageScroller(←ensurePageScrollListener) · pausePageThumbnails(←showView)
pumpOverlayRender(←scheduleOverlayPump) · queueOverlayRender(←fetchPageBlocks)
rerunAuxiliary(←setupLibrary) · scanVisiblePageSuggestions(←scheduleSuggestionScan)
setMarginStatus(←reportLayoutDetectOutcome/startLayoutDetectFromDialog)
setPageNumberStatus(←adoptPageNumberTemplate/removePageNumberRange/savePageNumberManual)
showMarginDetectProgress(←startLayoutDetectFromDialog) · startLayoutDetection(←startLayoutDetectFromDialog)
visiblePages(←selectAllVisiblePages/selectNextPage/selectRangeTo/setupShell)
```

**16 个不需要转发器**：`capturePageTileMetrics` · `ensureMarginAudit` · `ensureSuggestionScrollListener` ·
`hideMarginFitProgressSoon` · `initPanelAccordion` · `openPageSetup` · `patchRecognitionSetting` ·
`patchSelectedPages` · `resetMarginsToAuto` · `setAutoApplySetting` · `setRecognitionStatus` ·
`showMarginFitProgress` · `startAuxiliaryAll` · `startBatchRecognition` · `toggleMarginView` ·
`togglePageBlocksOverlay`。

> 判据同刀 4：**引用**而非调用（值引用也算：`addEventListener(..., f)` / 回调 / `?.` 后不带括号）；
> 排除装配块 deps 行、排除自身声明体、排除注释。

## ③ 形态：本刀与刀 3/4 都不同（混的）

```
刀 3：全是"加注入"（外壳没有注入面 → 搬完新增 deps 键 + 14 转发器）
刀 4：全是"减注入"（12 个早就是 deps 键 → 搬完删键 + 模块内 injected.X→X 直呼）
刀 5：**混** ——
      · 20 个是 deps 键（搬完删键 + 模块内直呼）
      · 11 个不是（搬完新增 deps 键给它们的注解面用）
      · 另有 4 个 let 状态只搬"读面"（getter），写点走 SETTERS（新增 5 条，含 recStatusTimer）
      · 两处多行写点用 SET_BLOCKS（marginStatusTimer / pageNumberStatusTimer / recStatusTimer 三个 setTimeout）
```

## ④ 7 处片段抽取（不搬函数，只把 pages 的那几行摘出来）

| 函数 | pages refs | 涉及的 pages id | 别的视图 refs | 做法 |
|---|---|---|---|---|
| `setupLibrary` | 9 | `apply-high-suggestions` `aux-rerun` `backups-open` `layout-detect-open` `page-more-menu` `word-boxes-open` | 46 | 抽成模块 `wirePagesFromLibrary()`，外壳只调用它 |
| `boot` | 8 | `pages-margin-toggle` `pages-overlay-toggle` | 8 | 抽成模块 `wirePageToggles()` / `syncPageToggles()`，boot 只调入口 |
| `setupShell` | 2 | `selection-review-open` `stats-open` | 12 | 抽成模块 `wirePagesShellEntries()` |
| `setupCollabControls` | 2 | `assign-list-toggle` `assign-open` | 7 | 只把 pages 两个开关的读数抽成模块函数 |
| `startLayoutDetectFromDialog` | 2 | `pages-error` | 6 | 错误渲染与进度改走模块入口 |
| `finishRevokeAutoPass` | 1 | `pages-error` | 1 | 错误渲染改走模块入口 |
| `setMarginJudgementSetting` | 1 | `rec-margin-judgement` | 2 | checkbox 同步抽成模块函数 |
| **合计** | **25** | | | |

**抽取的判据**（不是"看起来搬完了"）：抽完**外壳函数里剩下的 pages id 引用 = 0**，
且抽出来的模块函数引用的 id ⊆ view-pages 子树（R3 模块零豁免）。每条抽完跑一次 node 闸。

## ⑤ deps：减 20 加 18

```
删（20 个：31 个 mover 里当前是 deps 键的那些）
  capturePageTileMetrics · checkSelection · ensureMarginAudit · ensureSuggestionScrollListener
  hideMarginFitProgressSoon · initPanelAccordion · pageScroller · patchRecognitionSetting
  patchSelectedPages · queueOverlayRender · resetMarginsToAuto · setAutoApplySetting
  setMarginStatus · showMarginDetectProgress · showMarginFitProgress · startAuxiliaryAll
  startBatchRecognition · toggleMarginView · togglePageBlocksOverlay · visiblePages

加（18 个，dry run 原值；来自 31 个 mover 函数体对新名字的引用）
  函数 6：firstUnfinishedPanel · matchesTriage · matchesWorkflow · savePageMarginPreference
         savePageOverlayPreference · setJobStartBusy
  let 4（getter）：jobStartPending · marginStatusTimer · overlayPumpScheduled · pageNumberStatusTimer
  常量 3：PAGE_BLOCK_FETCH_LIMIT · pageBlockCacheOrder · pageSuggestionOrder
  能力 2：indexRefresh · libraryNotify        ← 31 个体里有两处跨视图调用
  setter 5：setJobStartPending · setMarginStatusTimer · setOverlayPumpScheduled
           setPageNumberStatusTimer · setRecStatusTimer   ← 写点，不算"加键"（setter 与 getter 同一状态只占一个 deps 键位）

四栏（按声明形态，相加必须等于 dry run）：
  函数 / 值 46 + getter 19 + setter 13 + 能力 2 = 80 == injected_keys == deps_literal_keys
总数：213 − 20 + 18 = 211；判据 = 按名对集，不用相加。
```

## ⑥ 验收数

```
R3 处数   101 → 50（本刀 −51）；归零要再加：片段抽取 25 + 推迟两刀 25
R3 id 种  38 → 24（本刀归零 14 个）； 剩 24 种里 7 种是"部分归零"（下面逐个列）
R8        36 → 50（+15 转发 −1 死亡，见 §⑧——**本轮不是 22**）
app.js    14,095 → ≈13,457
module    2,287 → ≈2,984
seed      42 名（45 行）→ 11 名（14 行）
```

**本刀归零的 14 个 id**：`filter-recognition` `filter-triage` `filter-type` `filter-workflow` ·
`margin-audit` `margin-basis` `margin-fit-fill` `margin-fit-progress` `margin-fit-text` ·
`margin-status` `page-grid` `page-number-status` `pages-only-included` `rec-status`

**7 个部分归零**（本刀减量、但仍有非 mover 持有）：`auto-apply-suggestions`(applyProjectSettings) ·
`pages-error`(finishRevokeAutoPass / recognizePage / startLayoutDetectFromDialog) ·
`pages-margin-toggle`(boot) · `pages-overlay-toggle`(boot) · `selection-hint`(applySplitBatch) ·
`selection-skip-checked`(applyPackageMode) · `setup-panel`(applyPackageMode)

## ⑦ 执行顺序（六步）

```
1. 无 test-contract 笔（本刀不改任何断言；若发现某条测试因"再搬一层"而红，停下报我，不许顺手校准）。
2. dry run（不 --write）：
   python3 docs/refactor/evidence/build_view.py --movers docs/refactor/pages/knife5-movers.json \
     --rules docs/refactor/pages/knife5-rules.py --name Pages \
     --app backend/book2text/static/app.js --out /tmp/k5-dry
   期望：residue [] · anti [] · injected_keys 80 · deps_literal_keys 80
3. 逐个搬，每个函数之后跑一次 node 闸（不是 node --check）。**一次一个函数的三件事同批完成**：
   ①函数体搬进模块；②模块内 `injected.X` → 直呼（若它是 deps 键）；③deps 块删该键（若删）；
   ④有外壳调用者则加转发器 + api 补键。
4. 7 处片段抽取按 §④ 的顺序做（先 setupLibrary，再 boot，再其余）：抽一处跑一次闸，
   判据 = 外壳函数里剩下 pages id 引用 0。
5. 收尾：核对 §⑥ 每个数；删 seed 31 行；跑 node 闸整套。
6. 模块内"刀3 遗留的死注入"顺手清一处：`injected.renderPageSummary` → 直呼 + 删 deps 键 + 删 api 键
   （它是本刀唯一能死的导出键，见 §⑧）。
```

## ⑧ R8：36 → 50（**不是 22**），以及为什么

本刀 31 个 mover 里 15 个仍被外壳调用 → **+15 个转发键**；唯一能死的是 `renderPageSummary`
（0 个外壳调用者，只有一条 deps 键 + 模块内 `injected.` 死注入）→ 36 − 1 + 15 = **50**。

**16 个候选死亡键，本刀一个都死不了**（逐键证据，量于当前树）：

| 键 | 仍存的外壳调用者 | 结论 |
|---|---|---|
| `loadFinishSummary` | 12 个（`pollTask` `refreshProject` `setupReviewControls` `finishRunAutoPass` …） | 调用者不在本刀 |
| `loadLanguageSummary` | `showView` | **永留外壳**，要等路由改走入口 |
| `loadPageNumberSummary` | `hydrateView` + 3 个 | **永留外壳**，同上 |
| `refreshLayoutDetectEntry` / `refreshMarginDetectHint` | `renderLayoutStatus` | 调用者不在本刀 |
| `refreshMarginTiles` | `refreshMarginState` | 同上 |
| `renderAutoApplyStatus` | `loadAutoApplyStatus` | 同上 |
| `renderMarginStepVerdict` | `reportLayoutDetectOutcome` / `startLayoutDetectFromDialog` | 同上 |
| `renderPageNumberMetrics` | `loadPageNumberMetrics` / `refreshPageNumberAnalysis` | 同上 |
| `renderRecognitionSettings` | `applyProjectSettings`（推迟）/ `loadAppInfo` | 同上 |
| `renderStepPanels` | `syncWorkflowSteps` | 同上 |
| `renderWorkflowFilter` | `loadWorkflow` | 同上 |
| `updateRecognitionAuxProgress` | `pollTask` | 同上 |
| `applyPageZoom` | `goToWorkflowStep` / `setPageZoom` / `showView` | 同上 |
| `confirmAllUnconfirmed` | `finishConfirmPages` | 同上 |

这些调用者共 **30 个函数 / 1,124 行**（已逐个数过）。⇒ **"一次清 18 个键到 22" 在本刀不可达**，
它需要再搬这 30 个函数并把 `showView` / `hydrateView` 改成调模块入口（`enter`）。

**建议单开一刀：导出收口刀（刀 6）**

```
范围：16 个候选死亡键的 30 个调用者函数 / 1,124 行 + 路由入口改造（showView / hydrateView 不再点名导出）
目标：R8 50 → 22（14 个键死；loadLanguageSummary / loadPageNumberSummary 要等路由改造才死）
之后：收口刀 22 → 3（init / enter / exit）
曲线：34 → 36 → **50** → 22 → 3   ← 本刀 +14 需要重新签字（按判据③"曲线只许下调，上调需重签"）
```

**为什么不合并成一刀**：31 + 30 = 61 个函数、约 1,775 行、三个轴（R3 / R8 / 路由）同时动，
红了一点都二分不了；而每一刀单独都能过闸、都能验数。

## ⑨ 提交形态：一笔 `move(pages):`

```
move(pages): 刀 5 —— 31 个函数搬进 pages-view（651 行）+ 7 处 pages 片段抽取
Move-Gate: tests/js/boundary.test.mjs
Approved-by: DevLead

① app.js        −31 函数体（651）+15 转发器 +deps 块 −20 +18 +7 处片段抽取
② pages-view.js +31 函数体 +若干 injected.X 直呼 +api +15
③ tests/js/boundary.test.mjs  VIEW_EXPORTS pages 36 → 50（15 个新键逐条注释"死亡刀号"，见 §⑧）
④ docs/refactor/evidence/pages/stage2-movers-seed.md  −31 行（42 名 → 11 名；45 行 → 14 行）
⑤ docs/refactor/pages/knife5-*
```

## ⑩ 三条硬规矩 + 本刀新增两条

```
① 报计数先声明分子分母形态 + 模式锚（前缀 vs 精确）；
② 判据用集合相等，不用数字相加；
③ --write 是刀 1 形态，本刀别用；
④（新）片段抽取的判据是"外壳函数里剩下 pages id 引用 = 0"，不是"我搬了那几行"；
⑤（新）混形态刀（既加注入又减注入）必须逐函数标形态——标错一个，那个函数的写点会写不到真实状态上。
```

## ⑪ 前置依赖（决定 R3 能不能到 0）

```
· 本刀自己只能把 R3 降到 50；剩下的 50 = 7 处片段抽取（25，本刀后段做）+ 推迟 4 个（25，归 knife-review / knife-package）
· 也就是说：R3 → 0 需要 **knife-review + knife-package 先落**（或与本刀同批），
  而这两刀的前提是 knife-package 的 §四 集合判据（chrome 具名方法 + navigate）先立住。
· 提交顺序建议：knife-review → knife-package → 本刀（片段抽取部分）→ 导出收口刀 → 收口刀。
  若必须先做本刀：按 §⑦ 做完 mover 部分即可，片段抽取留到两刀之后再收尾（那时 pages-error 一族已归 0）。
```
