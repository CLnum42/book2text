# 刀 4 施工图：选择 / 识别 / 缩放 / 设置 的 12 个函数搬进 `pages-view.js`

> **状态**：施工图（未动代码）。量于 `dce41b8` 树：`app.js` **14,324** 行 · `pages-view.js` **2,041** 行 ·
> R3 **123 处 / 44 种** · 模块 api **34** 键 · init deps **208** 键。
> 机读名单：`knife4-movers.json`（**名单唯一出处**，本文件的表由它生成）· 规则：`knife4-rules.py`。
> 复核口径同刀 3：行范围抽 3 个 · R3 分子分母 · deps 四栏相加 · 死亡刀号对账。

## 摘要（先给数）

| 指标 | 前 | 后 | 判据 |
|---|---|---|---|
| R3 总处数 | **123** | **76**（−47） | `node scripts/r3_pages_count.mjs --json` 的 `total` |
| R3 id 种数 | **44** | **32**（−12） | 同上 `ids`；12 个归零 id 逐个列在 §④ |
| R8 模块导出 | **34** | **40**（+6） | **不是预期里的 25**——原因见 §⑧（需 Architect 重签） |
| init deps 键 | **208** | **219**（−9 +20） | 集合相等：`208 − 9 ∪ 20` |
| `app.js` 行数 | 14,324 | **≈13,950**（−391 +6 +11） | 落盘实测，±20 内且差额可解释 |
| `pages-view.js` 行数 | 2,041 | **≈2,438**（+391 +6 api 键） | 同上 |
| R3 seed 名字 | 50（53 行） | **38**（41 行） | 删本刀 12 行 |
| dry run | — | `residue []` · `anti []` · `injected_keys 47` · `deps_literal_keys 47` | 生成器原值 |

## ① 名单与口径（先声明分子分母，再报数）

```
口径：view-pages 子树 id 引用，三种形态 el(id) / getElementById(id) / querySelector(All)("#id…")
      —— 模式锚是 **前缀匹配** `#id`（含 `#page-grid .page-tile` 这类后代选择器），
      与闸 R3（boundary.test.mjs 的 domIdsIn）逐字一致。
      先剥注释后计数；字符串保留。量具：scripts/r3_pages_count.mjs --json（只读一棵树）。
```

| 函数 | 行范围 | 行数 | refs | 归零 id | 转发器 |
|---|---|---|---|---|---|
| `applyPackageMode` | 13194–13253 | 60 | 20 | 6 | **要** |
| `applyPageRangeInput` | 3417–3439 | 23 | 3 | 1 | 不要 |
| `applyPageZoom` | 4064–4120 | 57 | 8 | 3 | **要** |
| `applyProjectSettings` | 12514–12524 | 11 | 2 | 0 | **要** |
| `applySetupSuggestion` | 3752–3774 | 23 | 2 | 0 | 不要 |
| `applySplitBatch` | 12867–12901 | 35 | 1 | 0 | **要** |
| `confirmAllUnconfirmed` | 3813–3825 | 13 | 1 | 0 | **要** |
| `confirmLayoutFromPanel` | 4665–4687 | 23 | 2 | 1 | 不要 |
| `confirmPageIds` | 3776–3800 | 25 | 2 | 0 | 不要 |
| `confirmSelectedPages` | 3802–3811 | 10 | 1 | 0 | 不要 |
| `recognizePage` | 5588–5636 | 49 | 2 | 0 | **要** |
| `recognizeSelection` | 12300–12361 | 62 | 3 | 1 | 不要 |
| **合计** | | **391** | **47** | **12** | **6 要 / 6 不要** |

**12 个全是 seed 里"到期刀 = 刀4"的行**（`stage2-movers-seed.md` 刀4 段），一个不多一个不少。
理由：`applyPageRangeInput` / `applySetupSuggestion` / `confirmAllUnconfirmed` / `confirmLayoutFromPanel` /
`confirmPageIds` / `confirmSelectedPages` / `recognizePage` / `recognizeSelection` /
`applyPackageMode` / `applyPageZoom` / `applyProjectSettings` / `applySplitBatch` 在 seed 里逐行签过刀号，
本刀按签字搬；**不夹带**任何刀5 的函数（刀5 有 34 个，混进来这张表就失去复核意义）。

## ② 每条：搬去哪 · 谁调它 · 留哪些转发器

**搬去哪**：`pages-view.js` 里 `function wireAll()` 之后、`function init(deps)` 之前（与刀 3 同一位置）。

### 2.1 六个"要转发器"的（外壳还有调用者）

| 函数 | 外壳调用者（行号） | 模块内注入调用点 |
|---|---|---|
| `applyPackageMode` | `refreshProject` (2574) | 无 |
| `applyPageZoom` | `showView` (241)、`goToWorkflowStep` (1010)、`setPageZoom` (4131) | `pages-view.js:380` |
| `applyProjectSettings` | `setAutoApplySetting` (12673)、`setMarginJudgementSetting` (12699) | 无 |
| `applySplitBatch` | `setupLibrary` (12421) | 无 |
| `confirmAllUnconfirmed` | `finishConfirmPages` (11858) | `pages-view.js:1999` |
| `recognizePage` | `buildTile` (3546)、`setupLibrary` (12488) | 无 |

### 2.2 六个"不转发"的（外壳搬完就没有引用）

| 函数 | 搬完后外壳引用数 | 说明 |
|---|---|---|
| `applyPageRangeInput` | 0 | 只在 `wireAll` 里以 `injected.applyPageRangeInput` 被用（:1923、:1925） |
| `applySetupSuggestion` | 0 | `wireAll:671` |
| `confirmLayoutFromPanel` | 0 | `wireAll:1972` |
| `confirmPageIds` | 0 | 唯一调用者是本刀内的 `confirmSelectedPages` / `confirmAllUnconfirmed` |
| `confirmSelectedPages` | 0 | `wireAll:1997` |
| `recognizeSelection` | 0 | `wireAll:1982`、`:1986` |

> "外壳引用数 0" 的口径：**排除装配块**（`window.PagesView?.init({…})` 里的 deps 键行）、
> 排除函数自己的声明体、排除注释。这三条不排除，每个函数都会假报 1–2 处。

### 2.3 模块内要改的 9 处（`injected.X` → `X` 直呼）

```
pages-view.js:380   injected.applyPageZoom()            → applyPageZoom()
pages-view.js:671   injected.applySetupSuggestion(item, apply)   → applySetupSuggestion(item, apply)
pages-view.js:1923  injected.applyPageRangeInput        → applyPageRangeInput
pages-view.js:1925  injected.applyPageRangeInput()      → applyPageRangeInput()
pages-view.js:1972  injected.confirmLayoutFromPanel     → confirmLayoutFromPanel
pages-view.js:1982  injected.recognizeSelection(false)  → recognizeSelection(false)
pages-view.js:1986  injected.recognizeSelection(true)   → recognizeSelection(true)
pages-view.js:1997  injected.confirmSelectedPages       → confirmSelectedPages
pages-view.js:1999  injected.confirmAllUnconfirmed      → confirmAllUnconfirmed
```

**这 9 处是本刀与刀 3 最大的形态差别**：刀 3 搬的函数在外壳里没有注入面；刀 4 的 12 个**早就以 deps 键
的形式注入模块**，所以本刀是"**减注入**"——删 deps 键 + 模块内直呼。漏改任何一处，`injected.X` 会因为
deps 键被删而变成 `undefined`：**语法合法、node 闸可能照绿、运行时才炸**（bodyPending 那类）。

## ③ deps：本刀是"减 9 加 20"，不是"只加"

### 3.1 删（9 个键：12 个 mover 里只有 9 个当前是 deps 键）

```
applyPageRangeInput · applyPageZoom · applyProjectSettings · applySetupSuggestion · confirmAllUnconfirmed
confirmLayoutFromPanel · confirmSelectedPages · recognizePage · recognizeSelection
```

（`applyPackageMode` / `applySplitBatch` / `confirmPageIds` 本来就不是 deps 键，删不了。）

### 3.2 加（20 个键，dry run 的原值；按归类）

```
函数（17）：applyRecognizedPages · closeFinishPanel · closeModal · confirmAction · ensurePageScrollListener
           ensureSuggestionScrollListener · forgetAllPageSuggestions · humanTouchedPages · loadPackageResults
           marginJudgementOn · pageImageUrl · pageZoomLevel · renderMarginJudgementNotice · resetOverlayQueue
           scheduleSuggestionScan · splitBatchScope · warnUnconfirmed
常量（2）：PAGE_ZOOM_LEVELS · RESTORE_DETAIL_TEXT
能力（1）：libraryNotify = (...args) => window.LibraryView?.notify(...args)
```

### 3.3 四栏构成（相加必须等于 dry run 的 `injected_keys`）

```
函数 / 值 38 + getter 6 + setter 2 + 能力 1 = 47        ← dry run: injected_keys 47
```

（47 是"模块正文里实际出现的键"，其中 **27 个是已有键**（复用不新增），**20 个是新增**；
所以 deps 总数是 `208 − 9 + 20 = 219`，不是 `208 + 47`。）

### 3.4 能力的形态（生成器新能力，刀 3 那版只有零参闭包）

`libraryNotify` 要透传参数，`deps_literal` 已支持"表达式自带箭头就直接出"：
`libraryNotify: (...args) => window.LibraryView?.notify(...args),`（`=>` 在表达式里 → 不再套一层 `() => `）。
正文侧靠 `LIT` 把 `window.LibraryView?.notify(` 换成 `injected.libraryNotify?.(`，参数原样保留。

## ④ 验收数（每一项都是具体数 + 集合判据）

```
R3：123 → 76（−47 = 12 个 mover 的 refs 之和）；ids：44 → 32
     判据 = id 集合相等：新 ids == 旧 ids − {12 个归零 id}（不是"少了 12 个"这种数字判据）
R8：34 → 40（+6 转发器；本刀 0 死亡，§⑧ 有逐键证明）
app.js：14,324 → ≈13,950   = −391（12 个函数体）+6（转发器）+11（deps 块 −9 +20）
pages-view.js：2,041 → ≈2,438 = +391（函数体）+6（api 新增 6 键）
init deps：208 → 219；判据 = 按名对集：新 deps == (旧 208 − 9 个删键) ∪ 20 个新键
```

**12 个归零的 id**（引用它的函数全部在本刀名单内）：

```
check-pending · layout-block-confirm · page-range · page-setup-bar · pages-zoom-in · pages-zoom-label
pages-zoom-out · panel-pagenum-settings · panel-recognition-settings · selection-actionbar
selection-check · selection-skip-recognized
```

**11 个"部分归零"（本刀减量但不归零，别误记成归零）**：
`assign-list-toggle`（`setupCollabControls` 还在）· `assign-open`（同）· `setup-panel`（`initPanelAccordion`/`openPageSetup` 还在）·
`selection-skip-checked`（`checkSelection` 还在）· `selection-hint`（`setAutoApplySetting` 还在）· `page-grid` · `pages-error` ·
`pages-margin-toggle` · `pages-overlay-toggle` · `auto-apply-suggestions` · `rec-margin-judgement`。

> `pages-margin-toggle` / `pages-overlay-toggle` / `page-grid` 三个**仍然不归零**：`boot`（各 4 处）与
> `toggleMarginView` / `togglePageBlocksOverlay` 还在外壳里 → 归零责任在刀 5。
> 刀 3 文档里写的"这 5 个 id 归零责任在刀 4"是**错的**，本刀以数据改正（见 §⑧ 同一张证据）。

## ⑤ 执行顺序（六步；第 3–5 步是本刀特有）

```
1. 无 test-contract 笔。tests/js 只改一张登记表：boundary.test.mjs 的 VIEW_EXPORTS pages 34 → 40
   （6 个转发键进 R8 表，逐键带死亡刀号=刀5）。move: 笔允许改，但必须写 Move-Gate。
2. 生成器 dry run（不 --write）：
   python3 docs/refactor/evidence/build_view.py --movers docs/refactor/pages/knife4-movers.json \
     --rules docs/refactor/pages/knife4-rules.py --name Pages \
     --app backend/book2text/static/app.js --out /tmp/k4-dry
   期望：residue [] · anti [] · injected_keys 47 · deps_literal_keys 47
3. 先搬 6 个"不转发"的（applyPageRangeInput / applySetupSuggestion / confirmLayoutFromPanel /
   confirmPageIds / confirmSelectedPages / recognizeSelection）：
   **一次编辑内同时**做三件事 —— ①函数体从 app.js 删掉、插进模块；②模块里 injected.X 改直呼；
   ③init deps 块删该键（若它本来是 deps 键）。然后跑 node 闸。
4. 再搬 6 个"要转发"的（applyPackageMode / applyPageZoom / applyProjectSettings / applySplitBatch /
   confirmAllUnconfirmed / recognizePage）：同样的三件事，外加 ④app.js 里留一条转发器、
   ⑤模块 api 补该键。每个函数之后跑一次 node 闸。
5. **顺序红线**：这三件事分开做必然中途炸——函数体搬走了但模块还在 `injected.X`、或 deps 键已删但模块没改直呼，
   都是"语法合法 + node 闸绿 + 运行时 undefined"。一次只搬一个函数，就是为了让红能二分。
6. 收尾核对 §④ 的每个数；最后删 seed 的 12 行；跑 `node tests/js/run.mjs`（不是 node --check）。
```

**为什么不能先删 deps 键再搬体**：`injected.applyPageZoom` 在模块里是**运行时**取值，删键不会让任何静态检查红。

## ⑥ 提交形态：一笔 `move(pages):`

```
move(pages): 刀 4 —— 12 个选择/识别/缩放/设置函数搬进 pages-view（391 行）
Move-Gate: tests/js/boundary.test.mjs
Approved-by: DevLead

改动清单（缺一条都红）：
  ① backend/book2text/static/app.js            −12 函数体（391）+6 转发器 +deps 块 −9 +20
  ② backend/book2text/static/pages-view.js     +12 函数体 +9 处直呼 +api +6
  ③ tests/js/boundary.test.mjs                 VIEW_EXPORTS pages 34 → 40
  ④ docs/refactor/evidence/pages/stage2-movers-seed.md   −12 行（50 → 38 名字；53 → 41 数据行）
  ⑤ docs/refactor/pages/knife4-movers.json · knife4-rules.py · knife4-plan.md
```

拆开任一脚都红：只落模块 → R8 见 40 但登记 34；只改表 → R8 见 34 但模块里没这些导出；只删 seed → R3 少名。

## ⑦ 三条硬规矩（照抄，这是每一刀的入场券）

```
① 报计数先声明分子分母各含哪些形态（el / getElementById / querySelector），再声明模式锚
   （`"#id"` 前缀匹配 还是 精确匹配）。只说"同口径"不够。
② 判据用**集合相等**，不用数字相加：34 ≠ 16 + 14（刀 2.5 加过 4 个）；208 ≠ 180 + 46（重叠 18）。
③ `--write` 是刀 1 形态（整份替换 + 第二个 init）。增量拼法见 docs/refactor/pages/incremental-write.md，
   本刀别用 --write。
④ 导出棘轮按「到点必须死」判，**不按「每刀必须降」判**（§8.2 三条判据）——判据要能机检：
   每键带死亡刀号 + 到点未死就红 + 曲线只许下调。
```

## ⑧ R8 死亡刀号对账：**"刀 4 清 9 个"不成立**（需 Architect 重签）

刀 3 的 R8 表把 9 个导出键的死亡刀号签成"刀 4"。用当前树核每个键的**调用者**，没有一个能在本刀死：

| 键 | 外壳调用者 | 谁把它挡住 |
|---|---|---|
| `loadFinishSummary` | 14 个（`pollTask` / `setupReviewControls` / `finishRunAutoPass` … **含 `boot`**） | `boot` + 12 个不在本刀 |
| `loadLanguageSummary` | `showView`（**路由，永留外壳**） | `showView` |
| `loadPageNumberSummary` | `hydrateView`（**路由**）/ `adoptPageNumberTemplate` / `removePageNumberRange` / `savePageNumberManual` | `hydrateView` |
| `refreshLayoutDetectEntry` | `renderLayoutStatus`、**`boot`** | `boot` |
| `refreshMarginDetectHint` | `renderLayoutStatus`、**`boot`** | `boot` |
| `refreshMarginTiles` | `resetMarginsToAuto`、`refreshMarginState`、**`boot`** | `boot` |
| `renderAutoApplyStatus` | `loadAutoApplyStatus` | 调用者不在本刀（刀5） |
| `renderMarginStepVerdict` | `startLayoutDetectFromDialog`、`reportLayoutDetectOutcome`、**`boot`** | `boot` |
| `renderPageNumberMetrics` | `loadPageNumberMetrics`、`refreshPageNumberAnalysis` | 调用者不在本刀（刀5） |

**结论与本刀的实际账**：

```
刀 4：0 个键死亡；+6 个临时转发键（§2.1）→ R8 34 → 40
刀 5：boot 与 27 个调用者一搬，可清 18 个键：
      · 9 个里的 7 个（除 loadLanguageSummary / loadPageNumberSummary）
      · 刀 3 表里签成"刀 5"的 5 个（renderPageSummary / renderRecognitionSettings / renderStepPanels /
        renderWorkflowFilter / updateRecognitionAuxProgress）
      · 本刀的 6 个临时键
      → 40 − 18 = 22
收口刀：最后 2 个（loadLanguageSummary / loadPageNumberSummary）要等路由改走 enter/api
      —— 只要 showView / hydrateView 还直接点名导出，这两个键就删不掉。
```

**所以 R8 不是单调下降：34 → 40 → 22 → 3。** 把 +6 看成"为了搬走 47 处 id 引用而借的临时债"，
死亡刀号写进 VIEW_EXPORTS 注释里（逐键 = 刀5）。**这一条需要 Architect 重签**（原表 9 个"刀4"改为
"0 个刀4 / 7 个刀5 / 2 个收口刀"）。

### 8.1 `applySplitBatch` 复核：**+6 成立，不改**（2026-10-30，附可复现证据）

复核意见提出"`applySplitBatch` 的刀外调用者 = 0（12421 那行在 `applyPackageMode` 里）⇒ 应 +5、曲线 39 → 21 → 3"。
用当前树核，这条不成立：

```
$ python3 逐行配对顶层函数（与 r3_pages_count 同一套 bounds）
包含 12421 的顶层函数: [('setupLibrary', 12405, 12490)]
setupLibrary    12405–12490
applyPackageMode 13194–13253     ← 12421 不在它的范围内（差 773 行，不可能包含）
```

即 12421 是 `setupLibrary` 里的 `el("split-batch-apply").addEventListener("click", applySplitBatch);`，
而 `setupLibrary` **本刀不搬**（§⑩）。这条引用不是"调用"而是**值引用**（回调），转发器的判据是
**引用**不是**调用**——把 `name(` 当成唯一形态就会漏掉这一类（今天"扫描三栏"教训的同一个形状）。
**决定性论证**：不补转发器，`setupLibrary` 在 boot 阶段执行到那一行时 `applySplitBatch` 是未绑定标识符
→ **ReferenceError**，而语法检查、node 闸都照绿。

所以：**R8 34 → 40，曲线 40 → 22 → 3，`applySplitBatch` 的转发器必须留**。

### 8.2 「逐刀严格下降」判据改写（Architect 定稿，替换旧的单调性条款）

```
旧判据：每刀导出数 < 前一刀。   ← 34 → 40 这一步合法却过不去；而且它逼着人为"降数"去搬不该搬的东西。
新判据（三条，可机检）：
  ① 同一刀内不许出现"无死亡刀号"的键——每个导出键都必须登记**死于哪一刀**；
  ② 每个死亡刀号到时，该键必须真的消失（到点未死 = 红）；
  ③ 曲线只许下调：任何一处上调都要重新签字（本刀的 +6 已签，理由 = §2.1 的六个转发器）。
用"到点必须死"替代"每刀必须降"——前者能机检、能追责，后者只能靠人盯着数。
```

按新判据，本刀的 6 个转发键在 `VIEW_EXPORTS` 注释里逐键写 `死亡刀号 = 刀5`；刀 5 收口时若有一个还在，
就按判据 ② 红。

## ⑨ 两件未决的结论

**（1）`--append` 本刀不实现。** 代价与收益：

```
它只覆盖两段：插入函数体（在 function init 之前）、合并 api 键。
本刀真正容易错的三处它都不管：模块内 injected.X → X 直呼（9 处）、删 9 个 deps 键、加 6 个转发器。
实现它要改组装逻辑 + 加三条守卫 + 自检，约 3–4 小时，还要在刀 5 再验一遍——省不下最容易错的部分。
替代：按 incremental-write.md §一 的三段拼法 + §二 的五条机检，逐函数搬、每个跑一次 node 闸。
（若刀 5 之后还要搬 review/library 视图，那时再实现，收益才够。）
```

**（2）`indexRefresh` 的形态等价性：已逐字核过。**

```
app.js:14137  indexRefresh: () => window.IndexView?.refresh(),   ← 现在是手写闭包
deps_literal 生成（CAPABILITIES: ("indexRefresh", "window.IndexView?.refresh()")）
              indexRefresh: () => window.IndexView?.refresh(),   ← 逐字相同
```

本刀重跑生成器**不会**重新生成这条：它是刀 3 的 deps 键，刀 4 的 `CAPABILITIES` 只有 `libraryNotify`，
不再声明 `indexRefresh`（生成器还有"能力声明了但正文没用到 = 空声明红"的守卫兜着）。

## ⑩ 本刀明确不碰

```
· boot（466 行）/ showView / hydrateView / setupLibrary / refreshProject / pollTask / setupReviewControls
  —— 这些是装配与路由，归刀 5 或永留外壳
· 不搬状态（MOVED_STATES = []）；不动 SETTERS（沿用刀 3 的 8 条）
· 不动 PAGES_R3_TOTAL_CAP、不动 pages-r3-exemptions.mjs（本刀 0 项变动）
· 不动 app.css / index.html
```
