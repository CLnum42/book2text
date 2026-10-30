# knife-review 施工图（定稿）：recognizePage 搬进 pages 模块 + 跨域写点走注入能力（**刀 7**）

> 刀号见 `docs/refactor/pages/knife-numbering.md`（真值源 = `tests/js/knife-registry.mjs`，本刀 = **7**）。
> 旧记法「刀 6」= 本刀，已在登记表里改成 7。

> **状态：定稿**（Architect 2026-10-30，替代原「占位」版）。
> 核心裁定：**不新建 `review-view.js`**（理由见「裁定一」，是实测不是取舍）；
> 本刀新增的跨域能力只有 **1 个**：外壳的 `showPageDetailError(error)`。
> 量数树：`f9e1b63` —— app.js **13,462 行** · pages-view.js **3,126 行** ·
> index.html **682 个 id**（其中 **351 个不属于任何 view section**）· R3 **25 处 / 14 种** ·
> R8 **57** · PagesView deps **218** · 豁免表 **14 项 / Σcap 25 / TOTAL_CAP 25**。
> 复现：`node scripts/r3_pages_count.mjs --json`（R3）、`node tests/js/run.mjs`（四闸）。

## 为什么有这一刀

加上刀 6 之后，pages 的 R3 还剩 25 处，其中 `recognizePage` 独占 2 处（`pages-error`）。
它属于 pages 的动作族——同族的 `checkSelection`（pages-view.js:2534）和
`startLayoutDetection`（pages-view.js:2573）早就在模块里，形态一模一样
（先 `el("pages-error").hidden = true`，再 POST 建 job，再 `startTaskPolling`），
只有 `recognizePage` 还留在外壳。本刀把它归位。

它体内唯一的跨域写点是 `catch` 里的 `page-detail-error`（`view-review` 的 id）：

```
app.js:5007   if (detailPageNo !== null) showError(el("page-detail-error"), error);
app.js:5008   else showError(el("pages-error"), error);
```

## 裁定一：**不新建 `review-view.js`**（三个选项，选 B 的变体）

### 实测：A 不是"多花几小时"，是"同一笔必须把整个 review 视图搬完"

```
git worktree add --detach /tmp/wtA f9e1b63
printf '…' > backend/book2text/static/review-view.js      # 26 行桩：window.ReviewView = { init, showError }
node tests/js/run.mjs        →  退出码 1
```

R3 当场报 **223 条**（去重后的 (行号, id) 对）/ **90 个 id**，全部是这个形状：

```
app.js:6804 还引用着 view-review 的 id review-auto-pass——这个视图已经有 review-view.js，
             旧字面量必须收干净
```

原因在 `tests/js/boundary.test.mjs:1782-1796`：**任何**已经有 `*-view.js` 的视图，
app.js 里对它 id 的引用是**零容忍**的——只有 `reading`（审校块内合法）和 `pages`
（过渡豁免表）有开口，review 没有任何表可挂。所以"落一个只有 3 个函数的 review 模块"
等于宣告 review 视图已模块化，然后把 223 处引用一起点着。

> 口径说明：这 **223 处 / 90 种** 是闸的**出现次数**口径（`el(` / `getElementById(` /
> `querySelector("#…")`，同一行出现两次算两处）；`docs/refactor/evidence/pages/review-ids-ledger.md`
> 里的 **267** 是**行**口径（同一行只算一处）。两个数都对，别混用。

顺带一条：A 的桩让 R5 / R7 / R7b / R8 / R13 各红一条（表登记类，能补）；
**唯独 R3 那 223 条没有表可补**。这就是 A 的代价的全部来源。

### 三个选项

| 选项 | 做法 | 代价 |
|---|---|---|
| **A** 新建 `review-view.js` | 26 行桩 + index.html 脚本标签 + OWNERS / VIEW_STATE_PREFIXES / VIEW_EXPORTS 三表 + R5/R6/R13 接线 | **同一笔必须把 223 处 / 90 个 id 搬完**，否则 R3 红 223 条；且现在就把一个 93 id / 223 处视图的模块形状钉死（它还含整棵审校树、详情面板、逐行复核），下一刀要重画 |
| **B** 不建模块，外壳持有 review 的 id | `recognizePage` 的跨域那一行改成调外壳能力 | 3 个文件、+1 能力、+1 导出键；review 落模块时**pages 侧一行不用改**（外壳函数体换成 `ReviewView.showError` 即可） |
| **C** 并进刀 8 | 刀 7 取消 | 刀 8 变成 23 处 + 3 函数，问题一点没少；且 recognizePage 与包管理无关，混进同一笔之后谁红都说不清 |

**选 B 的变体。** 它保住的东西是"调用点稳定"：`pages-view.js` 里只有一处
`injected.showPageDetailError(error)`，将来 review 有了模块，改的是外壳那一行函数体，
模块侧不动。

## 裁定二：id 所有权规则（**刀 7 和刀 8 用同一张**，不要一刀一个形态）

1. **归属的唯一来源 = `index.html` 的 `<section id="view-X">` 子树。**
   不在任何 section 里的 id（今天 **351 / 682**）**归外壳**——顶栏按钮、通知条、
   `.mask` 弹层面板（`#export-panel` / `#split-batch-panel` / `#package-result` / `#stats-panel` …）。
2. **`*-view.js` 零豁免**：只许碰**自己** section 的 id。别的视图的 id、外壳 chrome 的 id，
   一律只能经**注入的具名能力**（或由外壳直接写——外壳写任何 id 都合法，这不是豁免，
   是"外壳本来就是这些东西的所有者"）。
3. **能力粒度 = （归属域 × 语义动作），不是（id）。**
   一个能力可以写它那个域里的多个 id（`syncToolbarToggles` 写 2 个）；
   一个 id 的两种操作可以是两个能力（`showPagesError` / `clearPagesError`）。
4. **函数的去处看它改的是谁的状态**：
   - 单一视图的**动作**（建 job、重画、翻页）→ 该视图模块；
   - 跨多个域的**编排**（模式切换、项目设置、批处理）→ **留外壳**，域内写点各自收成 1 个能力。

**被否的形态**（每种都别写）：`chrome.toggle("id")` · `pagesOp(op, arg)` ·
把 DOM 节点从外壳递进模块（`getPagesErrorNode()` 之类——那是把 id 让渡洗了一遍）·
在模块里把别的域的 id 当字符串传给通用能力（见附二）。

**为什么不用 C（新增 `#shell-*` 段、R3 允许模块碰）**：一旦存在"可碰的外壳段"，
那 351 个 id 就全部合法可碰，要守住只能再加一张"哪个模块碰哪几个"的白名单——
那正是零豁免的开洞。C 里唯一可取的部分是**名字**：红文里要能认出"这是外壳 chrome"
（见附一），但判定不放宽。

### 按这张规则看那 7 个 id

刀 8 的三个函数（`applyPackageMode` 12330 / `applyProjectSettings` 11683 /
`applySplitBatch` 12003）碰的 7 个非 section id，与 3 个 review id **同一处置**：
**都不进任何 `*-view.js`**。区别只在"谁写它"：

| id | index.html | 住在哪个外壳容器 | 今天谁写 | review 落模块后 |
|---|---|---|---|---|
| `package-open` | :35 | 顶栏 | 外壳 | 不变 |
| `package-banner` | :42 | 通知条 | 外壳 | 不变 |
| `export-margin-judgement` | :1143 | `#export-panel` mask | 外壳 | 不变 |
| `structure-open` | :1154 | `#export-panel` mask | 外壳 | 不变 |
| `split-batch-error` | :1260 | `#split-batch-panel` mask | 外壳 | 不变 |
| `split-batch-apply` | :1269 | `#split-batch-panel` mask | 外壳 | 不变 |
| `package-result-meta` | :1329 | `#package-result` mask | 外壳 | 不变 |
| `finish-open-review` / `detail-recognize` / `aux-run` | :617 / :627 / :623 | `#view-review` | 外壳 | 改调 `ReviewView` 的 1 个能力 |

## 接口定稿（刀 7）

### ① 新增：外壳能力 `showPageDetailError(error)`（新写，**不是搬来的**）

```js
// app.js —— 放在 showError（:69）后面。它是"把错误写到审校面板的错误条上"这一个动作的名字。
// #page-detail-error 属 view-review；review 还没有模块 ⇒ 由外壳持有。review 落模块时，
// 这个函数体换成 window.ReviewView.showError(error) 即可，pages 侧的调用点不动。
function showPageDetailError(error) {
  showError(el("page-detail-error"), error);
}
```

> `openStatsPanel` / `toggleAssignList` 是同一族（刀 6 新建的外壳能力），照它们的形态写。

### ② deps：+1 键、−1 死键，净 0

```
+ showPageDetailError: showPageDetailError        // 新能力（R13 会要求它在 init 块里）
− recognizePage: recognizePage                    // app.js:13202 —— **死键**：pages-view.js 里
                                                    一次 `injected.recognizePage` 都没有（已核）
```

deps 218 → 218。

### ③ pages 模块代码（目标形态）

```js
  el("pages-error").hidden = true;                    // 自己的 id，直接写（同 checkSelection:2540）
  …
  } catch (error) {
    // 审校面板开着时错误显示在手边那一块；支路条件沿用 refreshRecognizedPages(:98-102) 的同一对 getter。
    if (injected.getDetailPageNo() !== null) injected.showPageDetailError(error);
    else showPagesError(error);                        // 模块自己的错误条（刀 6 的既有入口）
  }
```

### ④ 调用点（app.js 两处，改直调模块）

```
app.js:3394   buildTile（3327–3425）内        →  window.PagesView.recognizePage(page)
app.js:11657  setupLibrary（11591–11659）内   →  window.PagesView.recognizePage(page)
```

### ⑤ 导出键：`recognizePage`（R8 57 → 58）

| 键 | 类型 | 死亡刀号 | 到点判据 |
|---|---|---|---|
| `recognizePage` | 外壳调用（刀 3/4/5 同族） | **刀 9** | `app.js` 里 `window.PagesView.recognizePage` 引用 = 0 且不在 api 表 |

**到点判据写清楚，别只写号码**：今天两个调用者都在外壳（`buildTile`、`setupLibrary`）。
刀 9（导出收口）若仍有一个在外壳，这个键**死不了**——届时要么把键改判到刀 10（收口），
要么把调用者搬走；**不许把一个已经过去的刀号留在表上当装饰**（现状见「附三」）。

## 验收判据（机检，逐条给命令）

```
① R3 模块侧零豁免（**不用新写判据**）：pages-view.js 里出现 page-detail-error 即红
   —— boundary.test.mjs:1715-1722 的通用循环；本刀要求 `node tests/js/run.mjs` 全绿即可。

② pages 的 R3：25 处 / 14 种 → **23 处 / 13 种**（pages-error 2 → 0，整类归零）
   node scripts/r3_pages_count.mjs --json                    → total 23 · ids 13
   node scripts/r3_pages_count.mjs --lines pages-error        → "pages-error: 0 处"

③ app.js 里不再有 recognizePage 的真实现（只剩两个 window.PagesView 调用点）
   grep -c "^async function recognizePage" backend/book2text/static/app.js     → 0
   grep -c "window\.PagesView\.recognizePage" backend/book2text/static/app.js  → 2

④ 跨域只走能力，不藏 id
   grep -c "page-detail-error" backend/book2text/static/pages-view.js    → 0
   grep -c "showPageDetailError" backend/book2text/static/pages-view.js  → 1
     （且必须是 `injected.showPageDetailError(error)`，不是 `?.` —— 见「风险 1」）
   R13 自动兜住"deps 里没这个键"

⑤ 行为（真机，两条）：审校面板开着 → 把某页的识别弄失败 → **面板上的错误条**出现；
   页面视图开着 → 同样失败 → **网格上方的错误条**出现。两处都不许静默。

⑥ 四闸：node tests/js/run.mjs 全绿 · pytest -q 全绿 · R8 == 58 · deps == 218
```

## 账本（与代码**分两笔**，形态照抄刀 6）

```
· 删豁免 1 项：pages-error（cap 2，引用归零 → 会撞「0 引用就删项」那条下行机检）
· 存活 13 项逐项 cap 已 == 实测（刀 6 账本笔刚收过）⇒ Σcap 25 → 23 是删项的自然结果
· PAGES_R3_TOTAL_CAP 25 → 23（== Σcap == r3.total）
· PAGES_R3_PENDING 0 · PAGES_R3_BLOCKED_MAX 0 不变
· knife-registry 刀 7 → landed（scope 行要改：现写「recognizePage + review 具名入口」，
  应改成「recognizePage 搬入 pages 模块 + 外壳能力 showPageDetailError」——tests/js 由 TestDev 落）
```

## 本刀边界（**写死，越界即退回**）

```
· 不新建 backend/book2text/static/review-view.js；不动 index.html 的脚本标签
· 不动 applyPackageMode / applyProjectSettings / applySplitBatch（属刀 8）
· 不动 applyPackageMode 里那 3 处 review 写点（finish-open-review / detail-recognize / aux-run）
· 不动外壳那 7 个 chrome id 的写点
· 允许触碰的文件只有：pages-view.js · app.js · tests/js/boundary.test.mjs（R8 表一行）·
  tests/js/pages-r3-exemptions.mjs（账本）· tests/js/knife-registry.mjs（scope 行）· 本文
```

## 刀 8 的形态（Architect 裁定，**改掉"把三个函数搬进模块"**）

刀 8 图里的"三个 mover"改成"**三个函数留外壳，只把它们的 pages 写点收成 3 个能力**"。
理由就是裁定二第 4 条：它们是**跨三个域的编排**（pages 13 处 + review 3 处 + 外壳 4 处），
搬进 pages 模块等于让 pages 模块去点顶栏、通知条和审校入口——那是把边界弄反。
按"搬函数"落，模块侧必红 **10 条**（7 个 chrome + 3 个 review，与附二同一类）。本刀已用同形实验验证。

```
applyPackageMode      pages 写点 20 处（10 个 id × 2 支） → 1 个导出键
                      setPackageModeChrome(on)        // 模块决定自己哪些入口在包模式下藏起来
applyProjectSettings  pages 写点 2 处                    → 1 个导出键
                      syncProjectSettings(settings)   // 两个勾选态（auto-apply / rec-margin）
applySplitBatch       pages 写点 1 处（selection-hint）  → 1 个导出键
                      setSelectionHint(text)
review 的 3 处 + 外壳的 4 处：**留在 app.js**（review 未落盘 ⇒ 不进 R3；外壳 chrome 永不进 R3）

⇒ 刀 8 后：R3 23 → 0 · ids 13 → 0 · 豁免表清空（Σcap 0 == TOTAL_CAP 0 == r3.total 0）
⇒ R8：58 → **61**（+3）；**刀 9 要死的键数因此从 35 变 39**（61 − 22），曲线里那个
   「57 − 22 = 35」作废，按刀 8 落地时的实际表重算并逐键列名
⇒ deps 不变（三个函数本来就已注入给 pages 模块）
```

> 注意：`applyProjectSettings` 留在外壳还有个硬约束——它调的外壳函数
> `renderMarginJudgementNotice()`（:11697）不在 pages 的 api 里；搬走它就得再开一个键。

## 施工六步（Builder）

```
1. pages-view.js：把 app.js:4965-5013 的 recognizePage 整段搬进 IIFE；
   改两处（4987 保持 `el("pages-error").hidden = true`；catch 两行按 §③）；
   在 api 表加 recognizePage（注释带死亡刀号 = 刀9 与到点判据）。
2. app.js：`:3394` / `:11657` 改 `window.PagesView.recognizePage(page)`；删 4965-5013；
   在 showError 后加 showPageDetailError（§①）。
3. app.js 的 PagesView.init 块：加 `showPageDetailError: showPageDetailError`、
   删 `recognizePage: recognizePage`。
4. 本地 `node tests/js/run.mjs` 跑到只剩 R8 那一条（表还没改），再改表。
5. boundary.test.mjs 的 VIEW_EXPORTS（pages 侧）加 `"recognizePage"` 一行 + 死亡刀号注释；
   复跑，R8 == 58。
6. 账本笔（单独提交）：pages-r3-exemptions.mjs 删 pages-error + TOTAL_CAP → 23；
   跑 `node scripts/r3_pages_count.mjs --json` 确认 total 23 / ids 13。
```

提交拆两笔（同刀 6 纪律）：`move(pages): 刀 7 —— recognizePage 搬入 + showPageDetailError` +
`test-contract: 刀 7 账本（删 pages-error / TOTAL_CAP 25→23 / registry 刀7 landed）`。

## 风险（都会"全闸绿、用户看不见错误"）

```
1. `injected.showPageDetailError` 写成 `?.` → R13 只提示不红，错误被静默吞掉。
   本刀要求**必读形态**：`injected.showPageDetailError(error)`（验收 ④ 已给 grep）。
2. 支路条件写成 `getCurrentView() === "review"` 再取反 → 与 `detailPageNo` 不同源
   （离开审校时 detailPageNo 被置 null，见 app.js:6261）。照抄 refreshRecognizedPages 的写法。
3. 搬完忘了删 deps 里那个死键 `recognizePage` → 不会红（R13 只查缺键不查多键），
   但下一个人会以为模块还用着它。验收加：`grep -c "injected.recognizePage" pages-view.js` → 0。
```

## 附一：R3 红文分两档（交 TestDev，**只改文案，不放宽判据**）

现在两种越界报同一句话，改法却完全不同。建议按"这个 id 属于谁"分两句：

```
✗ pages-view.js:1234 引用了 view-review 的 id page-detail-error
  ⇒ 它属于另一个视图。跨视图动作走 init(deps) 注入（形如 showPageDetailError）。
✗ pages-view.js:1234 引用了外壳 chrome id package-open（不在任何 <section id="view-*"> 里）
  ⇒ 它归外壳。能力粒度 =（归属域 × 语义动作），不是（id）——不许在模块里写这个 id，
    也不许把它当字符串传给通用能力。
```

## 附二：新机检——模块里不许出现别域的 **id 字符串**（交 TestDev）

R3 只认 `el("x")` / `getElementById("x")` / `querySelector("#x")` 三种形态；
把 id 当**参数**递给通用能力，就绕过去了。现测这条缝**已经有人在用**：

```
library-view.js:235   injected.closeModal("new-project-mask")
merge-view.js:594     injected.closeModal("assign-panel")
```

口径与红文：

```
扫每个 *-view.js：先剥注释（保留字符串，同 R3 的 stripCommentsOnly），再取所有字符串字面量；
若字面量 == index.html 里某个 id 且该 id 不属于本视图的 section（含"外壳 chrome"）→ 红。
（现状：2 处；pages-view.js 的 6 处命中全在注释里，剥注释后归 0 —— 说明刀 6 的写法是对的）
```

```
✗ library-view.js:235 把外壳 id "new-project-mask" 当字符串传给 closeModal
  ⇒ 这是把 id 豁免换成字符串豁免。要收成"关掉新建项目对话框"这个动作（形如 closeNewProjectDialog）。
```

这条落地前，那 2 行要先改（各 1 行 + 各 1 个外壳能力）。

## 附三：现状提醒——**20 个已经过点未死的导出键**（不是本刀范围，但是本刀的判据前提）

`VIEW_EXPORTS.pages-view.js` 的注释里给 24 个键写了死亡刀号，其中 **20 个已过点仍在 api**：

```
刀 5（2 个）：applyPageZoom · confirmAllUnconfirmed
刀 6（18 个）：checkSelection · finishMarginDetectBar · forgetAllPageBlocks ·
      forgetAllPageSuggestions · pageScroller · pausePageThumbnails · pumpOverlayRender ·
      queueOverlayRender · rerunAuxiliary · scanVisiblePageSuggestions · setMarginStatus ·
      setPageNumberStatus · showMarginDetectProgress · startLayoutDetection · visiblePages ·
      openPageSetup · toggleMarginView · togglePageBlocksOverlay
```

原因是刀号在 2026-10-30 重编号过（6 = 片段、7 = review、8 = package、9 = 收口），
那批注释还写着旧号；而且**"到点未死"没有任何闸**（死亡刀号是注释，不是判据）。
所以本刀给新键写的死亡刀号只是记账，**真正能核的是到点判据那一句**——
要不要把这 20 个键的号重算、并给"到点未死"补一条机检，请 Chief 与 TestDev 决定；本文不越界。
