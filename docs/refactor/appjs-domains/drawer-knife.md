# ① 主刀收尾：核心抽屉 → `page-detail-drawer.js`（草案，等 Chief 批）

> 上位：`page-detail-console-plan.md`（S1–S4 已落：editor = 块列表/框选/版面/二引擎）、
> `overlay-registry-contract.md`（服务模块形态）、`second-batch.md`（多宿主与闸）。
> **基线 = 当前树**（本文写于 `61d4920`，app.js **9,672** 行 / **386** 顶层函数 / deps **171** / R3 review 49/117）。
> 行号只作对照，开工第一件事是按 §1 的名单重贴（段头不可靠这条已经是默认口径）。

## 0. 范围与本刀的位置

```
范围：审校视图里还留在壳里的"页详情核心抽屉"——pager / viewer / zoom / 差异层 / 版心线 / headline
不开：左树（index 域，另一刀）· 收尾面板 · 更多菜单 · 确认框
顺序：跨视图（Builder 在做）→ 协作 → **抽屉** → 第三批（页面侧 / 审校侧）
```

本刀只做"搬家"，不改任何可见行为；唯一允许的形态变化是 §3 的回路（`renderBlocks` 由谁调）。

## 1. 实测：候选 23 函数 / 562 行 → **建议搬 20 个 / 456 行**，留壳 3 个 / 106 行

| # | 函数 | 行 | 行数 | 归属 |
|---:|---|---:|---:|---|
| 1 | `openPageDetail` | 4499–4512 | 14 | 搬 |
| 2 | `closePageDetail` | 4514–4519 | 6 | 搬 |
| 3 | `loadPageDetail` | 4542–4564 | 23 | 搬 |
| 4 | `renderPageDetail` | 4904–4972 | 69 | 搬（枢纽） |
| 5 | `setupReviewPager` | 4758–4772 | 15 | 搬（pager 接线随模块） |
| 6 | `applyZoom` | 4632–4642 | 11 | 搬 |
| 7 | `fitWidth` | 4627–4630 | 4 | 搬（内部） |
| 8 | `setReviewOverlay` | 4652–4659 | 8 | 搬 |
| 9 | `setReviewMargin` | 4661–4669 | 9 | 搬 |
| 10 | `paintReviewMargin` | 4780–4801 | 22 | 搬 |
| 11 | `toggleReviewMargin` | 4803–4812 | 10 | 搬 |
| 12 | `renderReviewPager` | 4588–4611 | 24 | 搬（内部） |
| 13 | `pagerPages` | 4577–4585 | 9 | 搬 |
| 14 | `renderReviewHeadline` | 5678–5704 | 27 | 搬 |
| 15 | `drawDetailOverlay` | 5706–5769 | 64 | 搬 |
| 16 | `drawDetailLines` | 5772–5790 | 19 | 搬（内部） |
| 17 | `drawDiffLayer` | 5452–5543 | 92 | 搬 |
| 18 | `findDiffMark` | 5431–5435 | 5 | 搬 |
| 19 | `scrollViewerTo` | 5554–5561 | 8 | 搬 |
| 20 | `updateDiffActive` | 5598–5614 | 17 | 搬 |
| | **搬的总计** | | **456** | |
| 21 | `renderReviewBanner` | 4989–5043 | 55 | **留壳**（识别/跨页状态条，属收尾域） |
| 22 | `renderReviewWorkflowStatus` | 4975–4983 | 9 | **留壳**（自动通过按钮文案，属收尾域） |
| 23 | `setupViewerTools` | 4671–4712 | 42 | **留壳，但必须拆成四份**（见 §1.1） |
| | 留壳总计 | | 106 | 562 = 456 + 106 ✓ |

**与 Chief 估的 ~430 的差**：多出 26 行，主要是 `renderReviewHeadline` 27 与 pager 接线 15 ——
它们不在旧估算里，但都写抽屉自己的 DOM，留壳会多两个跨 owner 写点。按 456 走。

### 1.1 `setupViewerTools` 必须拆（**范例：一个函数写四个 owner 的 DOM**）

> **这是 owner 划分的典型反例，留作范例**：一个 42 行的接线函数，同时绑抽屉 6 件、树 2 件、editor 2 件、
> 外壳 1 件。**判断一个函数归谁，看它写谁的 DOM**——四处都写，就说明它不是"一个函数"，是四段接线被
> 一次写在一起。下一个遇到类似函数的人照这个切法：按 owner 分份、每份留 owner + 死期刀号。

```
4671-4712 一次绑九件事：
  · zoom-in / zoom-out / zoom-fit / toggle-overlay / toggle-diff-marks / review-margin-toggle  → 抽屉
  · review-tree-filter / review-tree-rail                                                   → 树（index 域）
  · review-drawer-toggle（toggle 的是 .editor 的 class）                                     → editor 的容器
  · review-filter 里的 [data-margin-filter] 按钮（EDITOR_ID）                                → editor
  · window.resize → applyZoom（抽屉）
⇒ 本刀只搬抽屉那六件 + resize；其余三份**原样留壳**，但**每一份必须留一行 TODO：`owner 名 + 死期刀号`**
   （否则半年后没人知道这两行为什么在壳里）。`.editor` 的折叠**走 `toggleCollapsed()`**，不开例外。

闸（可机检）：**壳里剩下的 `setupViewerTools` 不许再出现抽屉那 6 个 id 字符串**
（zoom-in / zoom-out / zoom-fit / toggle-overlay / toggle-diff-marks / review-margin-toggle）；
出现任一 ⇒ 红。变异：把 `review-margin-toggle` 那行搬回壳 ⇒ 红。
```

## 2. id 归属：从"一个 section 两个 owner"变成三 owner

现状：`EDITOR_IDS` 30 + `SHELL_IDS` 41 = 71（#view-review 子树的全部 id）；闸判"两集不交 + 并集 == 子树"。
加抽屉后**必须重新表述**，不能只加一张表——而且**要写成通用形式**（Chief 2026-11-02：不是给
`#view-review` 特写）：

```
对任意 section 有 n 个 owner：
  ① 两两不交：任意两张表交集为空
  ② 并集 == 子树：n 张表的并集必须等于该 section 子树的 id 全集（缺一个 ⇒ 红，点名）
  ③ 引用落表：每个 owner 模块源码里 part("x") / querySelector("#x") 取到的 id ⊆ 它自己那张表
  ④ n 与"实际有几个模块"一致：模块数 +1 而 owner 表没加 ⇒ 红（不许默认放行）；
     反过来 owner 表比模块多一张 ⇒ 红（空表就是墓地）
  ⑤ **跨 owner 的 class 写**：模块里 classList 的写入对象只许是自己表的 id 或 registry 建的节点；
     **不设例外**——动作不写不属于它的 DOM。壳里对 `.editor` 的写必须移给 editor（`toggleCollapsed()`），
     不开"带到期刀的例外"（例外口一开会一直长，且没人记得收）。
```

**本刀的 n 与三张表**：`EDITOR_IDS` 30（不动）+ `DRAWER_IDS` 21（新）+ `SHELL_IDS` 20（从 41 里减掉 21）
= 71；模块数 3（editor / drawer / 外壳不算模块）——与 ④ 里的"owner 表 3 张、模块 2 个 + 壳"对齐，
别把"壳"当成第三个模块去凑 n。

**DRAWER_IDS（21，按实测：这 20 个函数实际取的 shell id；`review-pager` 不在内，它只有 showView 用）**

```
page-detail-title · page-detail-meta · review-prev · review-page-no · review-next · review-jump ·
review-jump-filter · viewer-scroll · detail-canvas · detail-image · detail-image-status · detail-margin ·
detail-lines · detail-overlay · detail-diff-layer · zoom-in · zoom-out · zoom-fit · toggle-overlay ·
toggle-diff-marks · review-margin-toggle
```

**SHELL_IDS（20，剩下的）**

```
review-pager · review-continuations · review-banner · review-tree · review-tree-rail · review-tree-stats ·
review-tree-filter · review-tree-scroll · review-tree-list · detail-ink-gaps · finish-open-review ·
review-drawer-toggle · review-more · review-more-menu · review-apply-all · review-auto-pass ·
review-auto-revoke · review-footer-count · detail-close · review-confirm
```

**通则：归属按"谁写它"，不按"它在谁的 div 里"**（Chief 批准升为通则）：
`page-detail-title` / `page-detail-meta` 物理上在 `.editor` 容器里（index.html:583 起），但归抽屉——
因为它们的内容由抽屉写。**别为了让归属表和 DOM 树长得一致去搬 DOM**；DOM 树是布局，归属表是写权限。

## 3. 边界与回路：`renderBlocks` 由谁调

现状（两处）：`renderReviewBlocks`（4900）与 `renderPageDetail`（4961）末尾各调一次
`window.PageDetailEditor?.renderBlocks(...)`——**外壳调模块**，这是"编辑 → 重画"的单一回路。

搬抽屉之后：`renderPageDetail` 在抽屉里，它不能再直接喊 editor（模块→模块，R6/R7 那条线）。
**方案（推荐）**：

```
外壳注入 onPageDetailChanged(data)   // 外壳实现：把 data.blocks 交 PageDetailEditor.renderBlocks，并做它原来那两件事
drawer：renderPageDetail(data) 画完 DOM → await injected.onPageDetailChanged(data)  // 一次，只有一处
editor：保持"没有反向入口"（闸已禁 injected.renderPageDetail / injected.renderReviewBlocks）
无环证据：editor 的导出面里没有 onPageDetailChanged 的反向调用；drawer 的导出面里没有 renderBlocks
```

**不许的写法**：drawer 拿 `renderEditor` 回调后再回写自己的 DOM（那会出现"editor 重画 → 又触发 drawer 重画"
的第二条回路）；也**不许**让外壳在两个模块之间编排顺序（"drawer 画完，外壳再调 editor，再调 drawer"）。

**闸（Chief 要求可证，不是口头约定）**：
```
① 全仓 `onPageDetailChanged(` 的**调用点恰好 1 处**（声明 1 处 + 调用 1 处；多一处 ⇒ 红）
② editor 源码里**没有任何**对 onPageDetailChanged / renderPageDetail 的调用（反向入口为 0）
③ drawer 导出面里**没有** renderBlocks（它只喊注入的回调，不直接调 editor）
变异：在 editor 里加一句 injected.onPageDetailChanged(...) ⇒ ②红；把回调改由两个地方调 ⇒ ①红。
```

## 4. 接口面（外壳喊抽屉）与调用点

```
L  init({ root, … })                       // root = #view-review（与 editor 同一个 root，靠 id 表分家）
T  openPageDetail(pageNo)                  // 壳 11 处（235/2276/2293/4239/4618/5956/6420/7041/7306/7582/9127）
                                           //   + pages-view / reading-view 经 injected 调
T  closePageDetail()                       // 壳 4 处（226/238/1663/7732）
T  loadPageDetail(pageNo, opts)            // 壳 11 处（3851/3912/4730/4748/5897/6437/7424/7961/8073/8187/9607）
                                           //   + pages-view 经 injected 调
T  setReviewOverlay(on) / setReviewMargin(on)   // showView 里各 1 处（265 / 266）
T  paintReviewMargin(page) / drawDetailOverlay(blocks)   // 页网格那两处（2760 / 2762，随块框/版心开关）
T  renderReviewHeadline() / pagerPages()    // 各 1 处（9576 / 4614）
T  drawDiffLayer() / findDiffMark(id,l,s) / scrollViewerTo(node) / updateDiffActive()  // 3 / 1 / 2 / 2 处
T  applyZoom()                              // 4649（缩放按钮外那处）
T  setupReviewPager()                       // boot 9359
内部（不导出）：renderPageDetail · fitWidth · toggleReviewMargin · renderReviewPager · drawDetailLines
```

**注入（模块喊外壳）**：`apiJson` · `showError` · `showView` · `recognitionOf` · `divergenceOf` ·
`marginBoxOfPage` · `detailPageRecord` · `saveReviewMarginPreference` · `blockInsideMargin` ·
`blockCountedInMargin` · `globalMarginIsAuto` · `matchesTriage` · `applyMarginRect` · `savePosition` ·
`runPageAux` · `stepPage` · `ensureBlockListed` · `applyBoxElementRect` · `boxTypeLabel` ·
`buildBoxOrder` · `buildBoxLabel` · `scheduleDetailOverlayLayout` · `blockHasDrawableDiff` ·
`diffLevelLabel` · `lineDiffSpanCount` · `activateDiff` · `aggregateDivergence` · `treeItemsFromBlocks` ·
`syncReviewTreeToPage` · `setSaveState` · `startBoxDrag`（框选拖动，归 editor 但今天在壳）·
`renderReviewBanner` / `renderReviewWorkflowStatus`（留壳的两件，由抽屉按需喊）· 9 个共享状态访问器（§5）· `root`

## 5. 状态归属（按声明行 + 谁读；共享的留壳）

```
搬进抽屉（11，只有它读）：lastDetailPageNo(4423) · detailImagePageNo(4424) · detailMargin(4427) ·
  detailLines(4429) · diffMarksMode(4437) · activeDiff(4438) · zoomLevel(4624) · reviewMarginOn(4479) ·
  detailWorkflow(4474) · suppressBoxClick(5069) · pagerNumbers（若确认只有 pager 读）
留壳共享（9，editor 已经在借）：detailPageNo · reviewBlocks · activeReviewBlockId ·
  detailSuggestionByBlock · detailLayoutConfirmed · reviewBlockFilter · reviewFilterExplicit ·
  boxCreateMode · detailInkGaps —— 全部走 get/set 访问器注入（editor 那边已有同一批，别复制第二份）
```

**判据**：搬完之后 `detailPageNo` 仍只声明一次在壳里；editor 与 drawer 各自只能通过访问器读写它
（闸：模块里不许出现同名的模块级 let/const）。

## 6. 闸（本刀要加的四条 + 沿用的四条）

```
沿用：模块 DOM 面（el( / document.* 各 0；root 能力走白名单第四项）· 导出面有调用点 · 注入双向 ·
      跨模块直呼 window.X ⇒ 红
新增（都按通用形式写，不针对 #view-review 特写）：
  ① n-owner 归属：两两不交 · 并集 == 子树 · 引用落表 · n 与模块数一致（§2 的 ①–④）
  ② 跨 owner class 写：模块只许写自己表的 id 或 registry 节点；**不设例外**（§2 的 ⑤）
  ③ 回路唯一：`onPageDetailChanged(` 全仓调用点恰好 1 处；editor 侧反向入口 0（§3 的三条）
  ④ 接线拆分：壳里 setupViewerTools 不许再出现抽屉那 6 个 id（§1.1）
变异（五条，至少跑前四条）：
  · 往 DRAWER_IDS 挪一个 editor 的 id ⇒ ①红（两两相交）
  · 从 SHELL_IDS 删一个 ⇒ ①红（并集缺 id）
  · 加一个模块却没加 owner 表 ⇒ ①④红（n 不一致）
  · 在 editor 源码里加 injected.onPageDetailChanged 调用 ⇒ ③红（反向回路）
  · 把 review-margin-toggle 搬回壳的 setupViewerTools ⇒ ④红
```

## 7. 预算

```
page-detail-drawer.js ≈ 456（函数体）+ 40（骨架）+ 50（接线/初始化）≈ **546**
app.js −456 ~ −470（留壳的三件还在）· 函数 386 → 369 左右（20 个搬出、2 个留壳的仍在外壳）
deps 171 不变（新增的注入是模块自己的表，不进 PagesView 那块）
R3 review 49/117 → **预期 37 / 74 起底（不是验收判据的"必须等于"）**：21 个抽屉 id 今天共 61 处，其中 **43 处在 20 个函数体内**
（必走），有 12 个 id 的全部引用都在这些函数里（title/meta/page-no/jump/jump-filter/viewer-scroll/
detail-margin/detail-lines/detail-diff-layer/image-status/prev/next）⇒ 这 12 种直接消失；
剩下的 9 种（canvas 6→1、image 5→3、overlay 7→3、toggle-overlay 6→5、margin-toggle 6→2、
zoom-fit 2→1、zoom-in/out、toggle-diff-marks）部分残留。
setupViewerTools 拆分里随抽屉走的 6 件还会再降几处。**以脚本实测为准，写书不算数；验收判据只写"回落方向 + 实测值"，不写"必须等于 37/74"。**
```

## 8. 不做什么 / 风险

```
· 不搬左树（review-tree* 6 个 id 归 index 域那刀）· 不搬收尾面板/更多菜单/确认框
· 不改 pager/viewer 的 CSS（app.css 本刀 0 行）
· 不改 `?checktext=1` 与导出链路（本刀不碰正文渲染）
· 风险①：root 与 editor 是同一个 #view-review ⇒ 两个模块都拿 root，靠 id 表分家；
  闸的"并集 == 子树"是唯一防线，别只测一个模块自己的引用
· 风险②：`renderReviewBanner` 留壳 ⇒ 抽屉要注入它；若将来 banner 也搬，注入改直呼模块导出（仍走外壳接线）
· 风险③：`.editor` 折叠今天是外壳写别人容器的 class ⇒ **本刀必须给 editor 出 `toggleCollapsed()`**
  （一个调用点），由 owner 写自己的容器；**不开例外、不设到期刀口子**（Chief 2026-11-02 裁决：
  动作不写不属于它的 DOM；例外口一开就会长，且没人记得收）
```

## 9. 复现命令

```bash
# 基线
wc -l backend/book2text/static/app.js          # 9,672
grep -cE "^(async )?function [A-Za-z_]" backend/book2text/static/app.js   # 386
# 抽屉候选（按名字，不按段头）
grep -nE "^(async )?function (openPageDetail|closePageDetail|loadPageDetail|renderPageDetail)\(" backend/book2text/static/app.js
# id 三集与闸
grep -n "EDITOR_IDS\|SHELL_IDS\|DRAWER_IDS" tests/js/boundary.test.mjs
# R3
node scripts/r3_review_count.mjs
```
