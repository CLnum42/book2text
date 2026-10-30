# 刀 6 施工图：片段抽取（7 个宿主 / 25 处 → R3 50→25）

> 基线 **main@ab7a23f**（刀 5 已落；TOTAL_CAP 已按新闸从 156 收到 155）：`app.js` **13,465** 行 · R3 **50 处 / 24 种 id** ·
> R8 **53** · PagesView deps **211** · seed **14 行 / 11 名** · 豁免表 **64 项 / cap 155 / TOTAL_CAP 155 / 受阻 7**。
> 机读名单：`docs/refactor/pages/knife6-movers.json`（25 条逐行：宿主 / app.js 行号 / id / 取值形态 / 抽到哪）。
> 刀号见 `docs/refactor/pages/knife-numbering.md`（刀 6 = 片段抽取，原「刀 5b」）。

## ⓪ 一句话

七个宿主函数里还有 **25 处** `el("…view-pages 的 id…")`。本刀把这 25 处搬进 `pages-view.js`，
**只搬行、只加注入**，不改任何渲染逻辑；搬完这七个函数里 pages id 引用 = **0**，
R3 **50 → 25**（剩下 25 处全部属刀 7 / 刀 8 的四个函数）。

## ① 机读名单（25 处，`main@86b8d7a` 实测）

| # | 宿主（app.js 行） | 处数 | id | 抽到 |
|---:|---|---:|---|---|
| 1 | `setupLibrary` 11594–11662 | **9** | `apply-high-suggestions` · `word-boxes-open` · `page-more-menu`×4 · `backups-open` · `aux-rerun` · `layout-detect-open` | `wirePagesMoreMenuEntries()` |
| 2 | `boot` 13021–13429（**4 个 deps 对**） | **8** | `pages-margin-toggle`×4 · `pages-overlay-toggle`×4 | 删 deps 对 + `PagesView.syncToolbarToggles()` |
| 3 | `setupShell` 1055 / 1068 | **2** | `stats-open` · `selection-review-open` | `wirePagesShellEntries()` |
| 4 | `setupCollabControls` 12515–12516 | **2** | `assign-open` · `assign-list-toggle` | `wirePagesCollabEntries()` |
| 5 | `startLayoutDetectFromDialog` 5701（**同一行两处**） | **2** | `pages-error` | `pagesErrorMessage()` |
| 6 | `finishRevokeAutoPass` 11366 | **1** | `pages-error` | `showPagesError(error)` |
| 7 | `setMarginJudgementSetting` 11855 | **1** | `rec-margin-judgement` | `setMarginJudgementCheckbox(on)` |
| | **合计** | **25** | | |

> 口径：`node scripts/r3_pages_count.mjs --json` 的 `occurrences`（`el` / `getElementById` /
> `querySelector(All)("#id")`，只扫 `app.js`）。数字与 Chief 给的 9 / 8 / 2 / 2 / 2 / 1 / 1 逐项相等。

## ② 三段接线：进 `wireAll()`，**不新增 api 键**

刀 2.5 已经确立了形态：`init(deps)` 里 `wireWhenReady → wireAll()` 挂 14 段接线。
本刀的三段同形（模块内函数，`wireAll()` 里加三行调用），所以**不占 R8**：

```
wirePagesMoreMenuEntries()    ← setupLibrary 的 9 处
   · apply-high-suggestions / word-boxes-open / backups-open / layout-detect-open 四个监听
   · 四个 handler 里"点完先收起 ⋯ 菜单"（page-more-menu 4 处）
   · aux-rerun 的 handler 直呼模块内 rerunAuxiliary()（刀 5 已搬进来，不经注入）
   deps 新增：openSuggestionApplyPanel · openWordBoxesDialog · openBackups · openLayoutDetectDialog

wirePagesShellEntries()       ← setupShell 的 2 处
   · stats-open：换成一个具名能力 injected.openStatsPanel()（= openModal("stats-panel") + loadSummary()）
     ——**这个函数是新建的**（app.js 今天 0 处引用），落地时先在 app.js 里定义它，别去 grep（grep 不到）
     —— 不允许模块里出现 openModal("stats-panel")：那等于把"模块零豁免"换成"字符串豁免"
   · selection-review-open：模块自己实现（selectionPages()[0] || visiblePages()[0] → showView("review")
     → openPageDetail(page_no)），三个依赖全都已有
   deps 新增：openStatsPanel（能力）

wirePagesCollabEntries()      ← setupCollabControls 的 2 处
   · assign-open：注入 openAssignPanel()
   · assign-list-toggle：**不能整段搬**——handler 里 `el("assign-panel")` 是全局 chrome id，
     模块碰不得 ⇒ 整个动作收成具名能力 injected.toggleAssignList()（翻转 hidden + loadAssignments）
     ——**同样新建**（0 处引用）；不新建就会有人在模块里直接写 openModal("assign-panel")，正是要防的
   deps 新增：openAssignPanel · toggleAssignList（能力）
```

## ③ 四处操作入口：新增 **4 个 api 键**（R8 53 → 57）

```
syncToolbarToggles()          ← boot 的 8 处（4 个 deps 对）
   **四个**消费者（不是三个：Architect 说 LibraryView 是死 provider，实测不成立）：
     reading-view.js:3563/3568（setReviewOverlaysForReading）· index-view.js:98/103（openPageIndex）
     · preview-view.js:482/487（openPreview）· library-view.js:298/299（openProject —— 打开任何项目都走这条）
   它们现在拿 `injected.getPagesMarginToggle()?` 去 add("is-on") / toggle("is-on", state)。改成调 `window.PagesView.syncToolbarToggles()`，
   模块内按 `injected.getPagesMarginOn()` / `getPagesOverlayOn()` 刷两个按钮的 is-on（一次覆盖 4 处消费者）。
   ⇒ 4 个 deps 对（8 行）从四个模块的 deps 块里删掉，app.js 对 pages 子树的引用 −8。

showPagesError(error)         ← finishRevokeAutoPass：`showError(el("pages-error"), error)` 收进模块
pagesErrorMessage()           ← startLayoutDetectFromDialog：读 `#pages-error` 的文本兜底
setMarginJudgementCheckbox(on)← setMarginJudgementSetting：写 `#rec-margin-judgement` 的 checked
```

**为什么是 4 个键而不是 0 个**：这四处是 app.js **主动调用**模块（方向与前面三段相反），
必须有公开入口。合成一个 `pagesOp(op, arg)` 会退化成"把意图变成参数"，
和 `chrome.toggle("package-mask")` 是同一类错误——宁可多三个键。

**曲线要重签**（Architect 2026-10-30 改）：

```
36(刀4) → 53(刀5) → 57(刀6) → 57+m(刀7) → 57+m+n(刀8) → 22(刀9) → 3(刀10)
```

原来的「40」是「review/package 先落、+4」那个旧顺序的残留点，两刀排到刀 7 / 刀 8 之后**这个点不存在**。

**刀 9 要死 35 个键**（57 − 22 = 35），不许只写总和：

```
18 个刀 5 转发键：checkSelection finishMarginDetectBar forgetAllPageBlocks forgetAllPageSuggestions
  pageScroller pausePageThumbnails pumpOverlayRender queueOverlayRender rerunAuxiliary
  scanVisiblePageSuggestions setMarginStatus setPageNumberStatus showMarginDetectProgress
  startLayoutDetection visiblePages openPageSetup toggleMarginView togglePageBlocksOverlay
4 个刀 6 新键：syncToolbarToggles showPagesError pagesErrorMessage setMarginJudgementCheckbox
13 个候选键：**本刀的账只到「13」这个数**——逐个列名属刀 9 的图，因为要点名必须先定「哪 30 个调用者
  在刀 9 搬走」；刀 5 的图（§⑧）当时也只给到「16 个候选键」这个数，从没列过名字。
  ⇒ 刀 6 不猜这 13 个，写进刀 9 的入场条件：**逐键列名 + 每键带「app.js 引用 = 0」的到点判据**。
```

**4 个新键逐键带死亡刀号**（棘轮要求，缺一个就等于开了一张无限期）

**四个新键逐键带死亡刀号**（棘轮要求，缺一个就等于开了一张无限期）

| 键 | 死亡刀 | 到点判据 |
|---|---|---|
| `showPagesError` | 刀 9 | 调用者 `finishRevokeAutoPass` 搬走/改写后，该键在 `app.js` 的引用 = 0 且不在 api 表 |
| `pagesErrorMessage` | 刀 9 | 同上（调用者 `startLayoutDetectFromDialog`） |
| `setMarginJudgementCheckbox` | 刀 9 | 同上（调用者 `setMarginJudgementSetting`） |
| `syncToolbarToggles` | 刀 10 | 调用者是**四个 view 模块**、不是 app.js ⇒ 判据要换成「`window.PagesView.syncToolbarToggles` 在全仓引用 = 0 且不在 api 表」 |

> 最后一条是本刀要新登记的口径：刀 5 的「到点必须死 = 该键在 app.js 的引用 = 0」对**模块间调用**不成立
> （它一出生在 app.js 里就是 0 次）。别让这种键混在旧判据里——那等于"永远年轻、永远不会死"。

## ④ 数（都能对集）

| 项 | 前 | 后 | 口径 |
|---|---:|---:|---|
| R3 处数 | 50 | **25** | `r3_pages_count.mjs` 的 `total`（只扫 app.js） |
| R3 ids | 24 | **14** | 同上 `ids`；归零 10 个：`page-more-menu` `apply-high-suggestions` `aux-rerun` `backups-open` `layout-detect-open` `selection-review-open` `stats-open` `word-boxes-open` `pages-margin-toggle` `pages-overlay-toggle` |
| R8 | 53 | **57** | +4（syncToolbarToggles / showPagesError / pagesErrorMessage / setMarginJudgementCheckbox） |
| PagesView deps | 211 | **218** | +7（4 个 open* + openStatsPanel + openAssignPanel + toggleAssignList） |
| seed 行 | 14 | **4** | 删 10 行（刀 6 组全部：boot / setupCollabControls / setupLibrary×4 / setupShell / finishRevokeAutoPass / setMarginJudgementSetting / startLayoutDetectFromDialog）；剩 applyPackageMode · applyProjectSettings · applySplitBatch（刀 8）· recognizePage（刀 7） |
| 豁免项 | 64 | **54** | 删 10 项（上表归零的 10 个 id，cap 27）；剩余声明 cap 之和 155 → 128（只是记账） |
| `PAGES_R3_TOTAL_CAP` | 155 | **25** | 上限口径是**实测合计处数**（闸：`pagesActualTotal > pagesTotalCap` 才红），不是 cap 之和 ⇒ 跟着 R3 50→25 收紧 |
| 受阻项 | 7 | **0** | 7 个带「阻塞段」的项全在删除名单里 ⇒ `PAGES_R3_BLOCKED_MAX 7 → 0`，`knife2.5-split-plan.md` 的留外壳段对 pages 不再被引用 |

`PAGES_R3_TOTAL_CAP` 的三条定义（Architect 2026-10-30 签字口径，别用第四条解释）：

```
a) 闸判的是 `Σ min(该项实测处数, 该项 cap) > TOTAL_CAP`——没有一项超 cap 时它就等于 r3.total（今天 50）
b) TOTAL_CAP 是**冻结基线**，只降不升；放宽要签字
c) 终态三者合一：清理陈账后 Σitem.cap == TOTAL_CAP == r3.total
   （今天 `pages-error` cap 26 / 实测 5 —— cap 是"允许留下多少"的回归预算，不是实测值）
```

**剩下 25 处的归属**（本刀不动，别顺手改）：

```
applyPackageMode 20 · recognizePage 2 · applyProjectSettings 2 · applySplitBatch 1
⇒ 刀 7（review）吃掉 recognizePage 的 2 处；刀 8（package）吃掉其余 23 处；R3 才到 0
```

## ⑤ 验收判据（集合，不用相加式）

```
① 七个宿主里 pages id 引用 = 0（逐个函数的体扫，不是全文件）
   脚本：对 25 条 refs 的 (host, line) 逐条确认 `el("<id>")` 已不在该函数体里
② R3 == 25 处 / 14 种（按名对集：上面 10 个 id 不在实测集里；四个刀 7/刀 8 函数的 id 仍在）
③ R8 == 57，新 4 键在 api 里；**两类键的判据不同**（Architect 2026-10-30）：
   · app.js 调用（showPagesError / pagesErrorMessage / setMarginJudgementCheckbox）：
     `grep -c "PagesView\.<键>" app.js` == 1，且该行**替换掉了**原来那处 pages id 引用（前后配对）
   · 模块调用（syncToolbarToggles）：app.js 里**按设计 0 次**，判据换成
     `grep -l "PagesView.syncToolbarToggles" backend/book2text/static/*-view.js` == 4 个文件
     （reading / index / preview / library）——写成 "app.js ≥ 1" 会自相矛盾
④ deps == 218，新增 7 键逐个在 init 块里；删除的 4 个 deps 对在两模块 deps 块里 = 0
⑤ seed 4 行 / 4 名；豁免 54 项（实活 14 项 / 声明 cap 60）、TOTAL_CAP 25、BLOCKED_MAX 0
⑥ 「显示 = 导出」三道锁照跑：连续切片结构 / `?checktext=1` / QA 的 A 条（本刀不改渲染，但改了 init 时序）
⑦ 真机一次：页面视图的 ⋯ 菜单四项、页面工具栏两个开关、统计 / 开始审校入口、批量指派、版心判定 checkbox
```

## ⑥ 执行顺序（六步，与刀 5 的差别：**没有 dry run 可跑**）

`build_view.py` 只搬整函数，本刀是**片段** ⇒ 手改，判据用 ⑤ 的脚本兜。顺序写死：

```
1. 先落"三段接线"进 wireAll()（模块内，不碰 api）：每段搬完立刻跑一次 ⑤① 的单函数判据
2. 再落四个操作入口（api +4）：模块里加函数 → api 表加键 → app.js 三个调用点改成调入口
3. 再处理 boot 的 4 个 deps 对：四个消费者模块改调 PagesView.syncToolbarToggles()，
   然后删 app.js 里那 8 行 deps（**先改消费者再删 provider**，反了就是运行时 undefined）
4. deps 块：加 7 个新键（每个键都能解析，R13 会查）
5. 账本（**另开一笔 test-contract**，见 §⑦）：删 10 行 seed + 删 10 项豁免 + TOTAL_CAP 25 + BLOCKED_MAX 0
6. 全闸 + 真机
```

## ⑦ 提交形态：**两笔**（代码与账本分开，Chief 2026-10-30 定）

```
第一笔（本刀的主体，move: 单笔）
move(pages): 刀 6 —— 7 个宿主的 25 处片段抽进 pages-view（R3 50→25）
Move-Gate: tests/js/boundary.test.mjs
Approved-by: DevLead
  ① app.js：删 25 处片段 + 加 3 段 wire 调用 + 4 个入口调用点 + deps +7 / 删 4 个 deps 对
  ② pages-view.js：+3 段接线 + 6 个函数（含 4 个 api 键）
  ③ 四个 view 模块：getPagesMarginToggle/OverlayToggle → PagesView.syncToolbarToggles()
  ④ tests/js/boundary.test.mjs：VIEW_EXPORTS pages 53 → 57（4 个新键逐条带死亡刀号，见 §③）
  ⑤ docs/refactor/pages/knife6-*

第二笔（test-contract：账本，不与代码混）
test-contract: 刀 6 账本 —— 删 10 行 seed + 删 10 项豁免 + TOTAL_CAP 155→25 + BLOCKED_MAX 7→0
Approved-by: DevLead
  · 判据：删完 seed 4 行 / 4 名、豁免 54 项、R3 仍 25/14（账不跟着代码一起改，红了分不清是谁错）
```

**为什么分两笔**：Chief 2026-10-30 定的口径——**账不是片段**（`move:` 笔只搬行）。

技术上 `move:` 笔**能**改豁免表（`MOVE_EXEMPTION_BLOCKS` 白名单里就有 `PAGES_R3_EXEMPTIONS` /
`PAGES_R3_TOTAL_CAP`，方向判据管着只许收紧），但混在一笔里只有一个后果：红了分不清是
"片段搬错"还是"账算错"。刀 5 就是靠 `e05a9ba` 单独对齐账本的。

## ⑧ 风险（每条都有前科）

```
· 先删 provider 再改消费者 → 运行时 undefined，而 node/pytest/accept 全绿（刀 5 的 36 处直呼同类）
· 把 handler 整段搬进模块 → 里面夹着 chrome id（assign-panel / stats-panel），R3 模块零豁免会红；
  必须收成具名能力，不许 chrome.toggle("…")
· wireAll() 里加三段 = 接线时机从 setupLibrary 提前到 init：DOM 必须就绪（wireWhenReady 已管），
  但**回调依赖的 app.js 状态**要在调用时读，不许在接线时快照
· 本刀改 init 时序 → 「显示 = 导出」三道锁照跑；QA 的 A 条断言对 pages 视图仍要绿
· **`window.PagesView?.syncToolbarToggles()` 的 `?.` 会静默跳过**（Architect 抓到）：四个调用点
  （`openPageIndex` / `setReviewOverlaysForReading` / `openPreview` / `openProject`）若在 PagesView.init
  之前执行，`?.` 直接吞掉 → 按钮永久不亮，而 node / pytest / R3 / R8 全绿。
  ⇒ 两条一起落：① `init()` 末尾（wireAll 之后）补一次 `syncToolbarToggles()` 兜底；
     ② 真机逐个进这四个视图，看两个按钮的 `is-on`（不是看页面有没有报错）
```

## ⑨ 另案（不在本刀，但要有人认领）

豁免表里有 **40 项在 `app.js` 里 0 引用**（cap 合计 **68**）：这些 id 已经只出现在 `pages-view.js` 里
（抽查 `rec-dual-strategy` 4 处 / `margin-verdict-state` 1 处 / `page-number-summary` 2 处，全在模块里）。
表上只有「cap ≥ 实测」的上行判据，**没有「0 引用就删项」的下行判据**，于是 64 项里 40 项是陈账——
本刀把实活项从 24 减到 14，陈账从 40 变成 40（不受影响）。

建议单开一笔（**不要混进本刀的 move 笔**，否则红了分不清是搬行错还是账本错）。
位置（Architect 2026-10-30 定）：**刀 6 之后、刀 7 之前**。一笔里按顺序做完三件事，不分三笔：

```
① 删 40 项（0 引用的陈账）
② 把存活项的 cap 收到实测值（例如 pages-error cap 26 / 实测 5 —— cap 是回归预算，收不收要一次性决定）
③ 再定 TOTAL_CAP：让 Σitem.cap == TOTAL_CAP == r3.total 三者合一（今天 50；本刀之后 25）
附带一条下行机检：表里每一项都必须实测 ≥ 1 处（现在这条空缺 = 陈账只能涨不能消）
```
