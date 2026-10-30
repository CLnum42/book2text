# 刀 4 施工图：8 个"选择 / 识别 / 缩放"函数搬进 `pages-view.js`

> **状态**：施工图（未动代码）。量于 `dce41b8` 树：`app.js` **14,324** 行 · `pages-view.js` **2,041** 行 ·
> R3 **123 处 / 44 种** · 模块 api **34** 键 · init deps **208** 键。
> 名单唯一出处：`knife4-movers.json` · 规则：`knife4-rules.py`（可跑，dry run 已绿）。
> **12 → 8**：原名单里 4 个会写别的视图/弹层的 DOM，撞 R3「模块文件零豁免」，按 Architect 裁定甲推迟，
> 见 §⑪（那一刀定名 `knife-review` / `knife-package`，判据与到期点同节）。

## 摘要（先给数）

| 指标 | 前 | 后 | 判据 |
|---|---|---|---|
| R3 总处数 | **123** | **101**（−22） | `node scripts/r3_pages_count.mjs --json` 的 `total` |
| R3 id 种数 | **44** | **38**（−6） | 同上 `ids`；6 个归零 id 逐个列在 §④ |
| R8 模块导出 | **34** | **36**（+2） | `applyPageZoom` / `confirmAllUnconfirmed` 两个转发键；死亡刀号 = 刀5 |
| init deps 键 | **208** | **213**（−7 +12） | 集合相等：`208 − 7 ∪ 12` |
| `app.js` 行数 | 14,324 | **14,095**（−236 +2 +5） | 落盘实测 ±20 |
| `pages-view.js` 行数 | 2,041 | **2,287**（236 源行 + 8 空行 + 2 api 键） | 落盘实测 ±20 |
| R3 seed 名字 | 50（53 行） | **42**（45 行） | 删本刀 8 行 |
| dry run | — | `residue []` · `anti []` · `injected_keys 33` · `deps_literal_keys 33` | 生成器原值 |

## ① 名单与口径（先声明分子分母，再报数）

```
口径：view-pages 子树 id 引用，三种形态 el(id) / getElementById(id) / querySelector(All)("#id…")
      —— 模式锚是 **前缀匹配** `#id`（含 `#page-grid .page-tile` 这类后代选择器），
      与闸 R3（boundary.test.mjs 的 domIdsIn）逐字一致；先剥注释后计数，字符串保留。
      量具：scripts/r3_pages_count.mjs --json（只读一棵树）。
```

| 函数 | 行范围 | 行数 | refs | 归零 id | 转发器 |
|---|---|---|---|---|---|
| `applyPageRangeInput` | 3417–3439 | 23 | 3 | 1 | 不要 |
| `applyPageZoom` | 4064–4120 | 57 | 8 | 3 | **要** |
| `applySetupSuggestion` | 3752–3774 | 23 | 2 | 0 | 不要 |
| `confirmAllUnconfirmed` | 3813–3825 | 13 | 1 | 0 | **要** |
| `confirmLayoutFromPanel` | 4665–4687 | 23 | 2 | 1 | 不要 |
| `confirmPageIds` | 3776–3800 | 25 | 2 | 0 | 不要 |
| `confirmSelectedPages` | 3802–3811 | 10 | 1 | 0 | 不要 |
| `recognizeSelection` | 12300–12361 | 62 | 3 | 1 | 不要 |
| **合计** | | **236** | **22** | **6** | **2 要 / 6 不要** |

**为什么是这 8 个**：它们是 seed 里"到期刀 = 刀4"的 12 行，减去会写别的视图 DOM 的 4 个（§⑪）。
一个不多一个不少；不夹带任何刀5 的函数。

## ② 每条：搬去哪 · 谁调它 · 留哪些转发器

**搬去哪**：`pages-view.js` 里 `function wireAll()` 之后、`function init(deps)` 之前（与刀 3 同一位置）。

### 2.1 两个"要转发器"的

| 函数 | 外壳调用者（行号） | 模块内注入调用点 |
|---|---|---|
| `applyPageZoom` | `showView` (241)、`goToWorkflowStep` (1010)、`setPageZoom` (4131) | `pages-view.js:380` |
| `confirmAllUnconfirmed` | `finishConfirmPages` (11858) | `pages-view.js:1999` |

### 2.2 六个"不转发"的（外壳引用数 0）

| 函数 | 说明 |
|---|---|
| `applyPageRangeInput` | 只在 `wireAll` 里以 `injected.applyPageRangeInput` 被用（:1923、:1925） |
| `applySetupSuggestion` | `wireAll:671` |
| `confirmLayoutFromPanel` | `wireAll:1972` |
| `confirmPageIds` | 唯一调用者是本刀内的 `confirmSelectedPages` / `confirmAllUnconfirmed` |
| `confirmSelectedPages` | `wireAll:1997` |
| `recognizeSelection` | `wireAll:1982`、`:1986` |

> "外壳引用数 0" 的口径：**排除装配块**（`window.PagesView?.init({…})` 的 deps 键行）、排除自身声明体、排除注释。
> 而且**值引用也算引用**（`addEventListener(..., f)` / 回调 / `?.` 后不带括号）——只扫 `f(` 会漏一整类，
> 漏的形式还是"看起来判过了"（`applySplitBatch` 就栽在这上面，见 §⑪）。

### 2.3 模块内要改的 9 处（`injected.X` → `X` 直呼）

```
pages-view.js:380   injected.applyPageZoom()                   → applyPageZoom()
pages-view.js:671   injected.applySetupSuggestion(item, apply)  → applySetupSuggestion(item, apply)
pages-view.js:1923  injected.applyPageRangeInput               → applyPageRangeInput
pages-view.js:1925  injected.applyPageRangeInput()             → applyPageRangeInput()
pages-view.js:1972  injected.confirmLayoutFromPanel            → confirmLayoutFromPanel
pages-view.js:1982  injected.recognizeSelection(false)         → recognizeSelection(false)
pages-view.js:1986  injected.recognizeSelection(true)          → recognizeSelection(true)
pages-view.js:1997  injected.confirmSelectedPages              → confirmSelectedPages
pages-view.js:1999  injected.confirmAllUnconfirmed             → confirmAllUnconfirmed
```

**这是本刀与刀 3 的形态差别**：刀 3 搬的函数在外壳没有注入面；刀 4 的 8 个**早就以 deps 键注入模块**，
所以本刀是"**减注入**"——删 deps 键 + 模块内直呼。漏改一处 `injected.X` 会因 deps 键被删而变成 `undefined`：
**语法合法、node 闸可能照绿、运行时才炸**。

## ③ deps：减 7 加 12

### 3.1 删（7 个：8 个 mover 里只有 7 个当前是 deps 键）

```
applyPageRangeInput · applyPageZoom · applySetupSuggestion · confirmAllUnconfirmed
confirmLayoutFromPanel · confirmSelectedPages · recognizeSelection
```

（`confirmPageIds` 本来就不是 deps 键，删不了。）

### 3.2 加（12 个，全部来自这 8 个函数体对新名字的引用）

```
函数（10）：applyRecognizedPages · confirmAction · ensurePageScrollListener · ensureSuggestionScrollListener
           humanTouchedPages · pageImageUrl · pageZoomLevel · resetOverlayQueue
           scheduleSuggestionScan · warnUnconfirmed
常量（2）：PAGE_ZOOM_LEVELS · RESTORE_DETAIL_TEXT
能力（0）：**本刀没有跨视图能力**
```

> `libraryNotify`（来自 `applyPackageMode` 的 `window.LibraryView?.notify(…)`）**不在本刀**：
> 它的使用者被推迟了，留着就是"空声明"，生成器会直接 anti 红并拒绝落盘（实测已报）。
> 这条能力随 `applyPackageMode` 挪去 **knife-package**。

### 3.3 四栏构成（相加必须等于 dry run 的 `injected_keys`）

```
函数 / 值 26 + getter 5 + setter 2 + 能力 0 = 33        ← dry run: injected_keys 33 == deps_literal_keys 33
```

- getter 5：`getCurrentProject` · `getPageZoomIndex` · `getPagesMarginOn` · `getPagesOverlayOn` · `getSelectedPages`
- setter 2：`setPageTileMetrics` · `setSelectionAnchor`（deps 形如 `(v) => { X = v; return v; }`）
- **`setMarginStatus` 记在"函数 / 值"一栏，不记 setter**：它是 app.js 的**真函数**（`setMarginStatus(name, ok)`），
  deps 形如 `setMarginStatus: setMarginStatus,`。**分栏要按声明形态，不按名字前缀 `set`**——
  按前缀分成 3 个 setter，总数照样 33，但那一栏推不出处理方式（"两个数看着都对"的老亏）。

### 3.4 总数

```
208 − 7 + 12 = 213；判据 = 按名对集：新 deps == (旧 208 − 7 个删键) ∪ 12 个新键
```

## ④ 验收数（每项具体数 + 集合判据）

```
R3：123 → 101（−22 = 8 个 mover 的 refs 之和）；ids：44 → 38
     判据 = id 集合相等：新 ids == 旧 ids − {6 个归零 id}（不是"少了 6 个"这种数字判据）
R8：34 → 36（+2 转发器；本刀 0 死亡；死亡刀号见 §⑧）
app.js：14,324 → 14,095 = −236（8 个函数体）+2（转发器）+5（deps 块 −7 +12）
pages-view.js：2,041 → 2,287 = +236（源行）+8（函数间空行）+2（api 新增）
init deps：208 → 213；判据 = 集合相等（见 §3.4）
```

**6 个归零的 id**：`layout-block-confirm` · `page-range` · `pages-zoom-in` · `pages-zoom-label` · `pages-zoom-out` · `selection-skip-recognized`

**5 个部分归零**（本刀减量但不归零，别误记成归零）：`pages-error`(25) · `page-grid`(12) ·
`pages-margin-toggle`(7) · `pages-overlay-toggle`(7) · `selection-hint`(4)

> 后三个（`page-grid` / `pages-margin-toggle` / `pages-overlay-toggle`）归零责任在 **刀 5**：
> `boot`（各 4 处）与 `toggleMarginView` / `togglePageBlocksOverlay` 还在外壳。

## ⑤ 执行顺序（六步；第 1 步与第 3–5 步是本刀特有）

```
1. **两笔 test-contract 先落**（§⑨，这是入场条件，不是可选项）：
   a) reading-view-behavior.test.mjs —— harness 补 PagesView.init(deps)，断言不变；
   b) recognition-target.test.mjs —— 把"桩住 recognizeSelection"改成"验最终 POST 体"。
   两笔都必须在**旧树**上先绿（判据见 §⑨），否则不得进产品笔。
2. dry run（不 --write）：
   python3 docs/refactor/evidence/build_view.py --movers docs/refactor/pages/knife4-movers.json \
     --rules docs/refactor/pages/knife4-rules.py --name Pages \
     --app backend/book2text/static/app.js --out /tmp/k4-dry
   期望：residue [] · anti [] · injected_keys 33 · deps_literal_keys 33（五条守卫全过）
3. 先搬 6 个"不转发"的（applyPageRangeInput / applySetupSuggestion / confirmLayoutFromPanel /
   confirmPageIds / confirmSelectedPages / recognizeSelection）：
   **一次编辑内同时**做三件事 —— ①函数体从 app.js 删掉、插进模块；②模块里 injected.X 改直呼；
   ③init deps 块删该键（若它本来是 deps 键）。然后跑 node 闸。
4. 再搬 2 个"要转发"的（applyPageZoom / confirmAllUnconfirmed）：同样的三件事，外加
   ④app.js 留转发器、⑤模块 api 补该键。每个之后跑一次 node 闸。
5. **顺序红线**：三件事分开做必然中途炸——函数体搬走了但模块还在 `injected.X`、或 deps 键已删但模块没改直呼，
   都是"语法合法 + node 闸绿 + 运行时 undefined"。一次只搬一个函数，红才能二分。
6. 收尾核对 §④ 每个数；删 seed 8 行；跑 `node tests/js/run.mjs`（不是 node --check）。
```

## ⑥ 提交形态：一笔 `move(pages):`

```
move(pages): 刀 4 —— 8 个选择/识别/缩放函数搬进 pages-view（236 行）
Move-Gate: tests/js/boundary.test.mjs
Approved-by: DevLead

① app.js            −8 函数体（236）+2 转发器 +deps 块 −7 +12
② pages-view.js     +8 函数体 +9 处直呼 +api +2
③ tests/js/boundary.test.mjs   VIEW_EXPORTS pages 34 → 36（两键注释写"死亡刀号=刀5"）
④ docs/refactor/evidence/pages/stage2-movers-seed.md   −8 行（名字 50 → 42；数据行 53 → 45）
⑤ docs/refactor/pages/knife4-*（只在需要改数字时动）
```

拆开任一脚都红：只落模块 → R8 见 36 但登记 34；只改表 → R8 见 34 但模块里没这些导出；只删 seed → R3 少名。

## ⑦ 三条硬规矩（照抄，这是每一刀的入场券）

```
① 报计数先声明分子分母各含哪些形态（el / getElementById / querySelector），再声明模式锚
   （`"#id"` 前缀匹配 还是 精确匹配）。只说"同口径"不够。
② 判据用**集合相等**，不用数字相加：34 ≠ 16 + 14（刀 2.5 加过 4 个）；208 ≠ 180 + 46（重叠 18）。
③ `--write` 是刀 1 形态（整份替换 + 第二个 init）。增量拼法见 docs/refactor/pages/incremental-write.md，
   本刀别用 --write。
④ 导出棘轮按「到点必须死」判，**不按「每刀必须降」判**（§8.1 三条判据）。
```

## ⑧ R8：34 → 36，死亡刀号与曲线

```
刀 4：0 个键死亡；+2 临时转发键（applyPageZoom / confirmAllUnconfirmed）→ 36
推迟 4 个搬走时：+4（它们的调用者 refreshProject / boot / setAutoApplySetting / buildTile / setupLibrary 全在刀外）→ 40
刀 5：boot 与 27 个调用者一搬，可清 18 个键 → 22
收口刀：最后 2 个（loadLanguageSummary / loadPageNumberSummary）要等路由改走 enter/api → 3

曲线：34 → 36 → 40 → 22 → 3
```

**死亡刀号（逐键登记，写进 `VIEW_EXPORTS` 注释）**：

| 键 | 死于 | 为什么到那时才能死 |
|---|---|---|
| `applyPageZoom` | 刀5 | 4 个调用者（`showView` 常驻外壳；`goToWorkflowStep` / `setPageZoom` 刀5）搬完或改注入 |
| `confirmAllUnconfirmed` | 刀5 | `finishConfirmPages` 搬走 |

刀 3 那 9 个键的死期不变（本刀一个都不动它们：`boot` 挡住 5 个、`showView` 挡住 1 个、
`hydrateView` 挡住 1 个、另 2 个的调用者在刀5）。

### 8.1 判据（Architect 定稿，替换旧的单调性条款）

```
① 同一刀内不许出现"无死亡刀号"的键；
② 每个死亡刀号到时，该键必须真的消失（到点未死 = 红）；
③ 曲线只许下调，任何上调都要重新签字（刀 4 的 +2 已签，理由 = 两个临时转发键）。
```

## ⑨ 测试账：3 条红不是搬错，是本刀的入场条件

Builder 在 12-mover 版上撞到 3 条红，缩到 8 个后**仍然存在**（`applyPageZoom`、`recognizeSelection` 都在 8 个里）：

```
① reading-view-behavior.test.mjs:440「退出审校再回来：视图切换，但页码不被重置」
   现象：TypeError: Cannot read properties of undefined (reading 'label') @ pages-view.js applyPageZoom
   根因：harness 没 init PagesView → 模块拿到空 deps。以前 applyPageZoom 住 app.js，不需要 init。
   修法：harness 补 PagesView.init(deps)（与 installReadingDeps 同款自动桩：get*/is* → 读状态、
        set* → 写状态、其余空实现）。**断言一个字不改。**

② recognition-target.test.mjs:154「点击分派：selection / force → 进入对应识别」（2 条）
   现象：测试桩住 deps.recognizeSelection 看分派；搬走后模块调自己的函数，桩不再被调用。
   修法：**harness 升级到 app 级 + fetch 桩**，验最终 POST 体（不是模块级改断言，理由见下）。

   为什么必须换 app 级 harness（TestDev 核过，这条决定了工作量）：
     · pages-view.js:1974 的 handler 只调 `injected.recognizeSelection(false/true)` 或
       `injected.startBatchRecognition("unrecognized")` —— **分派**在模块边界上；
     · 但 **POST 体是在 app.js 的 recognizeSelection / startBatchRecognition 里拼的**，不在模块边界上；
     · 而这两笔 test-contract 必须在**旧树**上先绿（那时函数还住 app.js）
     ⇒ 模块级 harness 无论怎么改都做不到"旧树也绿"；只有 app.js + pages-view.js + fetch 桩 三者同在场才行。

   断言（逐条，强度不降：从"某函数被调"变成"请求形状对不对"）：
     selection → url 命中 `/jobs/ocr`，body.skip_recognized === true（测试把 #selection-skip-recognized 置勾选），
                 且 body 里**没有** force 键
     force     → body.skip_recognized === false，body.force === true
     batch     → body.scope === "unrecognized"，且 body 里**没有** pages 键（顺带覆盖）
   配套桩：`humanTouchedPages: async () => []`（否则会走确认框分支）、`warnUnconfirmed: () => true`、
          `apiJson` 换成记录 (url, body) 的 fetch 桩。

   **这不是"改两行"**：它是 harness 换代（app 级装配 + fetch 桩 + 三条断言的请求体口径），
   Builder 排期与验收要按这个算，不要当小修。

判据（两笔都必须满足）：**改完的测试在旧树上先绿**（产品代码没动时跑一次）。
做不到 → 退回「放宽 → 产品 → 收紧」三笔，弱断言窗口标 `Temp-Relax:`，收紧后必须消失。

红线：`move:` 笔只许改 OWNERS / VIEW_STATE_PREFIXES / VIEW_EXPORTS 三张表
      ⇒ 这两个测试文件必须在产品笔**之前**、单独以 `test-contract:` 提交。
```

## ⑩ 本刀明确不碰

```
· boot / showView / hydrateView / setupLibrary / refreshProject / pollTask / setupReviewControls / 27 个调用者
· 推迟的 4 个函数（§⑪）：applyPackageMode · applyProjectSettings · applySplitBatch · recognizePage
· 不搬状态（MOVED_STATES = []）；不动 SETTERS（沿用刀 3 的 8 条）
· 不动 PAGES_R3_TOTAL_CAP、不动 pages-r3-exemptions.mjs（本刀 0 项变动）
· 不动 app.css / index.html
```

## ⑪ 推迟的 4 个：为什么不在本刀，以及它们要去哪两刀

### 11.1 撞的是哪道闸

`boundary.test.mjs` 的 R3 模块侧**零豁免**：每个 `*-view.js` 只许引用**自己 view section** 的 id
（`r3Problems` 里 `if (!expected.has(id)) problems.push(...)`，没有豁免表可绕）。这 4 个会写别的视图/弹层的 DOM：

| 函数 | 行范围 | 行数 | refs | 跨视图写点 |
|---|---|---|---|---|
| `applyPackageMode` | 13194–13253 | 60 | 20 | package-banner×2 · package-open×2 · structure-open×2 · finish-open-review×2 · detail-recognize · aux-run · package-result-meta（11 处） |
| `applyProjectSettings` | 12514–12524 | 11 | 2 | export-margin-judgement（1 处） |
| `applySplitBatch` | 12867–12901 | 35 | 1 | split-batch-apply · split-batch-error（2 处） |
| `recognizePage` | 5588–5636 | 49 | 2 | page-detail-error（1 处） |

切分干净（Architect 核过，我复核同结论）：推迟 4 → 调用保留 8：**0 处**；保留 8 → 调用推迟 4：**0 处**；
推迟 4 互相调用：**0 处**。它们的调用者（`refreshProject` / `boot` / `setAutoApplySetting` / `buildTile` /
`setupLibrary`）全在刀外 ⇒ 留在外壳**不需要转发键**。

### 11.2 那 15 处写点归谁（按 id 所在 section 实测，不按函数名猜）

用闸自己的解析器（只认 `<section id="view-*">`）跑当前 `index.html`：

```
view-review 子树（5 处 / 4 个 id）：finish-open-review×2 · detail-recognize · aux-run · page-detail-error
不在任何 view-* section（10 处 / 7 个 id）：
    package-banner×2 · package-open×2 · structure-open×2      ← 在 topbar（外壳）
    package-result-meta · export-margin-judgement · split-batch-apply · split-batch-error   ← 各自在 .mask 弹层里
```

⇒ **这 15 处不是 pages 的债**：5 处是 review 的，10 处是 topbar / 弹层的（外壳级）。
所以那一刀**不能叫"pages 刀 4.5"**——名字错了，下一刀又会被塞回 pages。

### 11.3 两刀的顺序、命名与验收判据（Architect 裁定：review 先、package 后）

```
knife-review（先）
  范围：recognizePage（写 page-detail-error，属 view-review）
        + 为 applyPackageMode 的 review 入口做准备（finish-open-review / detail-recognize / aux-run）
  占位：docs/refactor/pages/knife-review-plan.md

knife-package（后）
  范围：applyPackageMode / applyProjectSettings / applySplitBatch
  占位：docs/refactor/pages/knife-package-plan.md
  前置条件（Architect 的关键条件）：
    applyPackageMode 对 review 的 3 处写点必须改成调 review 模块的**具名入口**
    （如 ReviewView.showFinishPanelEntry() / openDetail() / runAux()），**不是把 review 的 id 一起搬过去**；
    否则跨视图问题只是从 pages 换到 package。
  验收判据：**applyPackageMode 体内 review 子树 id 引用 = 0**，且那 3 处是具名入口调用。
  再加一条同样要过的：它另外 10 处写点落在 **topbar / 弹层**，而弹层不在任何 view-* section 里
    （R3 模块零豁免 ⇒ 任何 *-view.js 都不能引用它们）。所以 knife-package 的入场条件二选一：
      (a) 把这几个 .mask 弹层移进归属的 view section（改 index.html，属结构变更），或
      (b) 明确让 applyPackageMode 留在外壳，并写下理由（它操作的是外壳级顶栏与弹层，不是某个视图的 DOM）。
    这条要在 knife-package 开工前由 Architect 拍。
  到期点：knife-package 结束时 applyPackageMode 必须已搬走，或**明确留外壳并写理由**；
          不许出现"跨视图函数长期悬空"（那和转发器债务是同一种东西）。
```

**为什么现在就把判据写死**：刀 4 的教训是"图里只统计了本视图的 id"。下一刀若不先把
review id 引用 = 0 写成机检判据，搬完会把 3 处 review 写点带进 package 模块，问题只是换个文件名复发。
