# 刀 5 施工图：R3 归零第一步 —— 31 个函数搬家（+18 个转发键）

> **状态**：施工图（未动代码）。量于 `c4e45f9` 树：`app.js` **14,101** 行（`c4e45f9` 的 showNoticeBar 两行 deps 让基线 +6；R3 不变） · `pages-view.js` **2,287** 行 ·
> R3 **101 处 / 38 种** · 模块 api **36** 键 · init deps **213** 键。
> 名单唯一出处：`knife5-movers.json` · 规则：`knife5-rules.py`（可跑，dry run 已绿）。
> **R3 归零要三步**：31 mover（51 处）→ 7 处片段抽取（25 处）→ 推迟的两刀（25 处）。**101 = 51 + 25 + 25**。
> **本刀只交 mover 部分**：R3 验收只取 **50**；片段抽取**另开一笔**（判据不同，混一笔红了二分不了）。

## 摘要（先给数）

| 指标 | 前 | 后（本刀） | 归零（本刀 + 片段抽取 + 两刀） |
|---|---|---|---|
| R3 处数 | **101** | **50**（−51） | **0** |
| R3 id 种数 | **38** | **24**（−14） | **0** |
| R8 模块导出 | **36** | **53**（36 + 18 转发 − 1 死亡） | 22（要等**导出收口刀**，见 §⑧） |
| init deps 键 | **213** | **211**（−20 +18） | — |
| `app.js` 行数 | 14,101 | **≈13,466**（−651 +18 −2） | — |
| `pages-view.js` 行数 | 2,287 | **≈2,987**（+651 源行 +31 空行 +18 api） | — |
| R3 seed 名字 | 42（45 行） | **11**（14 行） | — |
| dry run | — | `residue []` · `anti []` · `injected_keys 80` · `deps_literal_keys 80` | — |

## ① 名单与口径

```
口径：view-pages 子树 id 引用，三种形态 el(id) / getElementById(id) / querySelector(All)("#id…")，
      模式锚 = **前缀匹配** `#id`（与闸 R3 的 domIdsIn 逐字一致）；先剥注释，字符串保留。
分类判据（本刀特有）：候选 = 持有 view-pages id 的顶层函数；
      再按"是否也持有别的视图/弹层的 id"分成 **可搬（0 个别的 id）** 与 **片段抽取（有别的 id）**。
      ——这条分类直接推出处理方式，不是按名字或重要性分。

**引用口径（2026-10-30 Architect 修正，上一版算错过一次）**：
  统计"外壳还有没有调用者"时，**只排除 PagesView 自己的 deps 块**（app.js:13709–13923）。
  其余五个模块的 init 块（IndexView / LibraryView / PreviewView / ReviewView / MergeView）里的引用
  **全是真引用**：模块要它，就得有一个 api 键 —— 上一版把这些一起当噪声排掉，漏了 3 个键（见 §②）。
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

## ② 每条：搬去哪 · 谁调它 · 留哪些转发器（**18 个**）

**搬去哪**：`pages-view.js` 里 `function wireAll()` 之后、`function init(deps)` 之前（同刀 3/4）。

### 2.1 十五个"外壳函数调用"的转发器

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

### 2.2 另外三个"别的模块要它"的转发器（上一版漏掉的）

| 函数 | 谁要它（别的模块的 init deps） | 模块里的调用点 |
|---|---|---|
| `openPageSetup` | `LibraryView` deps（app.js:14003） | `library-view.js:246` |
| `toggleMarginView` | `IndexView` deps（app.js:13953）、`PreviewView` deps（app.js:14078） | `index-view.js:1110`、`preview-view.js:462` |
| `togglePageBlocksOverlay` | `IndexView` deps（app.js:13952）、`PreviewView` deps（app.js:14079） | `index-view.js:1105`、`preview-view.js:468` |

**这三处改成 `window.PagesView.x` 也跑不掉**：跨模块要一个函数，就得有一个 api 键。
⇒ 转发键 = 15 + 3 = **18**，R8 = 36 + 18 − 1 = **53**。

### 2.3 十三个"不转发"的（外壳引用数 0）

`capturePageTileMetrics` · `ensureMarginAudit` · `ensureSuggestionScrollListener` ·
`hideMarginFitProgressSoon` · `initPanelAccordion` · `patchRecognitionSetting` · `patchSelectedPages` ·
`resetMarginsToAuto` · `setAutoApplySetting` · `setRecognitionStatus` · `showMarginFitProgress` ·
`startAuxiliaryAll` · `startBatchRecognition`。

> 判据：**引用**而非调用（值引用也算：`addEventListener(..., f)` / 回调 / `?.` 后不带括号）；
> 排除范围**只限 PagesView 自己的 deps 块**（见 §①），其余五个模块 init 块里的引用都算。

## ③ 形态：本刀与刀 3/4 都不同（混的）

```
刀 3：全是"加注入"；刀 4：全是"减注入"；刀 5：**混** ——
 · 20 个当前是 deps 键（搬完删键 + 模块内 injected.X→X 直呼）
 · 11 个不是（搬完新增 deps 键给它们的引用面用）
 · 4 个 let 状态只搬读面（getter），写点走 SETTERS（新增 5 条，含 recStatusTimer）
 · 3 处多行写点用 SET_BLOCKS（marginStatusTimer / pageNumberStatusTimer / recStatusTimer 三个 setTimeout）
逐函数标形态 —— 标错一个，那个函数的写点就写不到真实状态上。
```

## ④ 模块内必须改直呼的 **36 处**（20 个删键 × 逐名，漏一个就是运行时 undefined）

删 20 个 deps 键，模块里对应就有 36 处 `injected.X` 要改成直呼。**逐名归零**（不是"改一下"）。

> **这 36 处全部在"早就搬进模块"的函数体里，没有一个在本刀 31 个 mover 的体内**（2026-10-30 实测）：
> 宿主是 `ensureMarginFitted`(5) · `wirePagesRecognitionSettings`(4) · `wirePagesPanes`(4) ·
> `updatePageVisibility`(3) · `renderMarginPanel`(3) · `applyPageZoom`(2) · `updateSelectionPanel`(2) ·
> `renderPageSummary`(1) · `renderPageSetup`(1) · `renderTypePicker`(1) · `refreshRecognizedPages`(1) ·
> `renderPages`(1) · `syncPageStates`(1) · `updateMarginDetectProgress`(1) · `savePageMargin`(1) ·
> `undoMarginEdit`(1) · `confirmLayoutFromPanel`(1) · `wirePagesSelectionCheck`(1) ·
> `wirePagesCheckPending`(1) · `wirePagesAutoApplySuggestions`(1)。
> ⇒ **不能随"搬这个函数"顺手改**：只改 mover 体里的 24 处（其实 mover 体里 0 处）会漏掉全部 36 处，
> 而漏改的症状是"语法合法 + node 闸全绿 + 运行时 `injected.X is not a function`"。
> **正确顺序：先按本表把 36 处直呼改完，再删 deps 键。**

| 键 | 处数 | 模块行号 |
|---|---|---|
| `setMarginStatus` | 5 | 1055 · 1107 · 1164 · 1213 · 1873 |
| `patchRecognitionSetting` | 4 | 2070 · 2075 · 2080 · 2083 |
| `visiblePages` | 5 | 363 · 747 · 923 · 999 · 1508 |
| `capturePageTileMetrics` | 2 | 800 · 1814 |
| `checkSelection` | 2 | 2259 · 2265 |
| `queueOverlayRender` | 2 | 88 · 853 |
| `resetMarginsToAuto` | 2 | 272 · 322 |
| `showMarginFitProgress` | 2 | 1069 · 1096 |
| `ensureMarginAudit` | 1 | 314 |
| `ensureSuggestionScrollListener` | 1 | 1808 |
| `hideMarginFitProgressSoon` | 1 | 1112 |
| `initPanelAccordion` | 1 | 353 |
| `pageScroller` | 1 | 795 |
| `patchSelectedPages` | 1 | 734 |
| `setAutoApplySetting` | 1 | 2252 |
| `showMarginDetectProgress` | 1 | 774 |
| `startAuxiliaryAll` | 1 | 2235 |
| `startBatchRecognition` | 1 | 2224 |
| `toggleMarginView` | 1 | 2216 |
| `togglePageBlocksOverlay` | 1 | 2215 |
| **合计** | **36** | |

**归零判据（机检，跑一遍就够）**：

```sh
for n in capturePageTileMetrics checkSelection ensureMarginAudit ensureSuggestionScrollListener \
         hideMarginFitProgressSoon initPanelAccordion pageScroller patchRecognitionSetting \
         patchSelectedPages queueOverlayRender resetMarginsToAuto setAutoApplySetting \
         setMarginStatus showMarginDetectProgress showMarginFitProgress startAuxiliaryAll \
         startBatchRecognition toggleMarginView togglePageBlocksOverlay visiblePages; do
  c=$(grep -c "injected\.$n\b" backend/book2text/static/pages-view.js)
  echo "$n $c"
done   # 每行都必须是 0
```

漏改的症状：**语法合法、node 闸全绿、运行时 `injected.X is not a function`** —— 这正是 bodyPending 那类。

## ⑤ 7 处片段抽取（**另开一笔**，不属于本刀的验收）

| 函数 | pages refs | 涉及的 pages id | 别的视图 refs | 做法 |
|---|---|---|---|---|
| `setupLibrary` | 9 | `apply-high-suggestions` `aux-rerun` `backups-open` `layout-detect-open` `page-more-menu` `word-boxes-open` | 46 | 抽成模块 `wirePagesFromLibrary()` |
| `boot` | 8 | `pages-margin-toggle` `pages-overlay-toggle` | 8 | 抽成模块 `wirePageToggles()` / `syncPageToggles()` |
| `setupShell` | 2 | `selection-review-open` `stats-open` | 12 | 抽成模块 `wirePagesShellEntries()` |
| `setupCollabControls` | 2 | `assign-list-toggle` `assign-open` | 7 | 只把 pages 两个开关的读数抽出来 |
| `startLayoutDetectFromDialog` | 2 | `pages-error` | 6 | 错误渲染 / 进度改走模块入口 |
| `finishRevokeAutoPass` | 1 | `pages-error` | 1 | 错误渲染改走模块入口 |
| `setMarginJudgementSetting` | 1 | `rec-margin-judgement` | 2 | checkbox 同步抽成模块函数 |
| **合计** | **25** | | | |

**为什么另开一笔**：它们的判据是"抽完外壳函数里剩下 pages id 引用 = 0"，和"搬函数"是两种动作；
混在一笔里，红了分不清是搬错还是抽漏。**本刀的 R3 验收只取 50。**

## ⑥ deps：减 20 加 18

```
删（20 个：31 个 mover 里当前是 deps 键的）
  capturePageTileMetrics · checkSelection · ensureMarginAudit · ensureSuggestionScrollListener
  hideMarginFitProgressSoon · initPanelAccordion · pageScroller · patchRecognitionSetting
  patchSelectedPages · queueOverlayRender · resetMarginsToAuto · setAutoApplySetting
  setMarginStatus · showMarginDetectProgress · showMarginFitProgress · startAuxiliaryAll
  startBatchRecognition · toggleMarginView · togglePageBlocksOverlay · visiblePages

加（18 个，dry run 原值）
  函数 6：firstUnfinishedPanel · matchesTriage · matchesWorkflow · savePageMarginPreference
         savePageOverlayPreference · setJobStartBusy
  let 4（getter）：jobStartPending · marginStatusTimer · overlayPumpScheduled · pageNumberStatusTimer
  常量 3：PAGE_BLOCK_FETCH_LIMIT · pageBlockCacheOrder · pageSuggestionOrder
  能力 2：indexRefresh（`window.IndexView?.refresh()`）· libraryNotify（`(...args)=>window.LibraryView?.notify(...args)`）
  setter 5：setJobStartPending · setMarginStatusTimer · setOverlayPumpScheduled
           setPageNumberStatusTimer · setRecStatusTimer（与同状态 getter 共用一个键位，不额外加键）

四栏（按声明形态）：函数/值 46 + getter 19 + setter 13 + 能力 2 = 80 == injected_keys == deps_literal_keys
总数：213 − 20 + 18 = 211；判据 = 按名对集，不用相加。
```

## ⑦ 验收数

```
R3 处数   101 → 50（**只交 mover 部分**；片段抽取另开一笔，那 25 处不在本刀验收里）
R3 id 种  38 → 24（本刀归零 14 个；剩 24 种里 7 种"部分归零"逐个列在下面）
R8        36 → 53（+18 转发 −1 死亡，见 §⑧）
app.js    14,101 → ≈13,466
module    2,287 → ≈2,987
seed      42 名（45 行）→ 11 名（14 行）
```

**本刀归零的 14 个 id**：`filter-recognition` `filter-triage` `filter-type` `filter-workflow` ·
`margin-audit` `margin-basis` `margin-fit-fill` `margin-fit-progress` `margin-fit-text` ·
`margin-status` `page-grid` `page-number-status` `pages-only-included` `rec-status`

**7 个部分归零**：`auto-apply-suggestions`(applyProjectSettings) · `pages-error`(finishRevokeAutoPass /
recognizePage / startLayoutDetectFromDialog) · `pages-margin-toggle`(boot) · `pages-overlay-toggle`(boot) ·
`selection-hint`(applySplitBatch) · `selection-skip-checked`(applyPackageMode) · `setup-panel`(applyPackageMode)

## ⑧ R8：36 → **53**，以及"22"为什么不在本刀

```
R8 = 36（当前） + 18（本刀新转发键） − 1（renderPageSummary 能死） = 53
```

`renderPageSummary` 是本刀唯一能死的键：**0 个外壳调用者**，只剩一条 deps 键 + 模块内一处
`injected.renderPageSummary` 死注入 → 改成直呼、删 deps 键、删 api 键。

**16 个候选死亡键，本刀其余 15 个一个都死不了**（逐键的外壳调用者见 `knife5-movers.json` 的
`刀5验收.r8Exports`；共同点：调用者都不在本刀 31 个 mover 里）。其中两个是**永留外壳**：

```
loadLanguageSummary  ← showView（路由）
loadPageNumberSummary ← hydrateView（路由）
⇒ 这两键的死亡判据不是"调用者搬走了"，而是"app.js 里对它们的引用 = 0"——
  要等 showView / hydrateView 改成调模块入口（enter）才算数。
```

### 8.1 导出收口刀（刀 6）重出图：它要死 **31** 个键，不是 14 个

```
53 − 22 = 31 = 13 个候选键（16 − 1 已死 − 2 永留外壳）+ 18 个本刀新转发键
```

**光靠"那 30 个调用者"不够**：18 个新转发键的调用者里有 6 个不在那 30 个里 ——
`setupLibrary`(12236 rerunAuxiliary) · `showView`(222 pausePageThumbnails) · `pollTask`(5936) ·
`applySplitBatch`(12651) · `startLayoutDetectFromDialog`(6236/6251/6252) · `setupReviewControls`(11981)。
⇒ 刀 6 必须重出图（不是补一句），并且要连这三行 deps 一起改，否则键一死库页/阅读页预取就断：

```
app.js:13640  loadFinishSummary        → 改指 reading-view（ReadingView 的 deps）
app.js:13999  loadFinishSummary        → 改指 library-view（LibraryView 的 deps）
app.js:14006  renderRecognitionSettings → 改指 library-view
```

### 8.2 曲线（重签）

```
34 → 36 → 40 → 53 → 22 → 3
    刀4   推迟4   刀5   刀6   收口

签字条件（Architect）：每个键带死亡刀号并逐条列名（18 个）；"到点必须死"的判据是
**该键在 app.js 的引用 = 0**，不是"调用者搬走了"——本轮就有 3 个键的调用者住在别的模块里，永远搬不走。
```

## ⑨ 执行顺序（六步）

```
1. 无 test-contract 笔（本刀不改断言；若某条测试因"再搬一层"而红，停下报我，不许顺手校准）。
2. dry run（不 --write）：
   python3 docs/refactor/evidence/build_view.py --movers docs/refactor/pages/knife5-movers.json \
     --rules docs/refactor/pages/knife5-rules.py --name Pages \
     --app backend/book2text/static/app.js --out /tmp/k5-dry
   期望：residue [] · anti [] · injected_keys 80 · deps_literal_keys 80
3. 逐个搬，每个函数之后跑一次 node 闸。**一个函数的三件事同批完成**：
   ①函数体搬进模块；②deps 块删该键（若删，**删之前先确认该键在模块里的直呼已按 §④ 改完**）；
   ③有外壳/别模块调用者则加转发器 + api 补键（§2.1 + §2.2 共 18 个）。
   **注意顺序**：36 处直呼点住在别的（早就搬进去的）函数里，不在你正在搬的这个函数体内 ——
   所以"删键 + 直呼"是一个**单独的一遍**（按 §④ 表逐名），不要指望搬函数时顺手带上。
4. 每搬完一批（5 个），跑一次 §④ 的逐名归零脚本：还没搬到的键允许非 0，已搬的必须 0。
5. 收尾：核对 §⑦ 每个数；删 seed 31 行；跑 node 闸整套。
6. `injected.renderPageSummary` → 直呼（**2 处：365、762**）+ 删 deps 键 + 删 api 键（本刀唯一能死的键）。
```

## ⑩ 提交形态：一笔 `move(pages):`（片段抽取另开一笔）

```
move(pages): 刀 5 —— 31 个函数搬进 pages-view（651 行）
Move-Gate: tests/js/boundary.test.mjs
Approved-by: DevLead

① app.js        −31 函数体（651）+18 转发器 +deps 块 −20 +18
② pages-view.js +31 函数体 +36 处 injected.X 直呼 +api +18
③ tests/js/boundary.test.mjs  VIEW_EXPORTS pages 36 → 53（18 个新键逐条注释"死亡刀号 = 刀6"）
④ docs/refactor/evidence/pages/stage2-movers-seed.md  −31 行（42 名 → 11 名；45 行 → 14 行）
⑤ docs/refactor/pages/knife5-*

第二笔（另开）：move(pages): 刀 5b —— 7 处 pages 片段抽取（25 处）
   判据：抽完外壳函数里 pages id 引用 = 0；R3 101 →（本刀后）50 → 25
```

## ⑪ 三条硬规矩 + 本刀新增三条

```
① 报计数先声明分子分母形态 + 模式锚（前缀 vs 精确）；
② 判据用集合相等，不用数字相加；
③ --write 是刀 1 形态，本刀别用；
④（新）"还有没有调用者"只排除 PagesView 自己的 deps 块（13709–13923）；别的模块 init 块里的引用全是真引用；
⑤（新）片段抽取的判据是"外壳函数里剩下 pages id 引用 = 0"，不是"我搬了那几行"；且它另开一笔；
⑥（新）删键必须逐名归零 §④ 的 36 处 injected.X（语法与 node 闸都看不出漏改）；
   且这 36 处都在**别的**函数里 —— "搬体处"与"直呼处"不是同一个地方，必须按清单单独一遍。
⑦（新）访问形态实测只有 `injected.X` 一种：`injected["X"]` / `injected?.X` 全 0 命中（Builder 反查），
   所以逐名 `grep -c "injected\.$n\b"` 的归零判据成立；将来若出现别形态，判据要同步扩。
```

## ⑫ 前置依赖

```
· 本刀只把 R3 降到 50；剩下 50 = 片段抽取 25（刀 5b）+ 推迟 4 个 25（knife-review / knife-package）
· R3 → 0 需要：knife-review + knife-package + 刀 5b 三笔都落
· 导出收口刀（刀 6）要重出图：31 个键 + 6 个漏网的调用者 + 3 行 deps 改指
```

## 附：生成器的一个真 bug（本刀第一次踩到，已修）

`count_checks` 对 `SET_REWRITES` 的判据原来是**反的**：它数旧行，而 `SET_REWRITES` 的语义是"旧行 → 新行"，
旧行改写后必然 0 次 ⇒ **做对了判红（拦下正确的改写）、没做判绿（放过漏改）**。
不是"永远绿"，是反着——这比永远绿更危险，因为它会逼人把正确的改写撤回去。

修法：数改写后的行；并加一条反证"改写后的模块里旧行必须 0 次"。
另一条陷阱（刀 6 会踩）：`want` 只在本刀的 mover 体里数（`pre_rewrite`），
按整个 `app.js` 数会让"同一条旧行同时出现在要搬和不搬的函数里"变成不可满足的判据。
