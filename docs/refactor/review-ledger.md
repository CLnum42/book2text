# `review` 切视图底账（2026-11-01，实测于 `330d748`）

> 本文只记**可复现的数**与**已判定的归属**，不写施工步骤（施工书另出）。
> 口径：DevLead 与 Builder 各自独立扫一遍后对集，下面每个数都给复现命令。
> 基线 `main@330d748`（app.js 12,755 · pages-view 3,907）。

## 一、DOM 面：R3 逐字口径 = 90 种 / 223 处

`#view-review` 在 `index.html:483–693`（211 行 / 11.9 KB），section 内 `id` **94 个**（含 section 自身）。
按 **R3 的三种取法**（`el(...)` / `getElementById(...)` / `querySelector(All)("#id…")`，**先剥注释**）统计：

```
子孙 id：89 种 / 221 处      ← 先按 "id" 字面量粗扫得到 89/221，再按 R3 口径修正 4 处
+ view-review 本体：1 种 / 1 处（:5927 el("view-review").querySelector(".editor")，只当容器用）
= 90 种 / 223 处
```

四处修正（粗扫 → R3 口径）：

| id | 粗扫 | R3 | 差在哪 |
|---|---:|---:|---|
| `detail-blocks` | 14 | **16** | 漏了 `querySelectorAll("#detail-blocks .review-menu")` 两处（:7997 / :10764） |
| `diff-queue` | 2 | **3** | 漏了 `document.querySelector("#diff-queue .diff-queue__top")`（:5916） |
| `finish-open-review` | 4 | **2** | 其中两处是数组字面量 `["finish-open", "finish-open-review"]`（:9147 / :10779），R3 不认 |
| `view-review` | — | **1** | section 本体（:5927），见 §六 未决 |

引用最多的 12 个：`page-detail-error(23)` · `detail-blocks(16)` · `detail-overlay(7)` · `detail-canvas(7)` ·
`box-select-text(7)` · `toggle-overlay(6)` · `review-margin-toggle(6)` · `detail-image-status(5)` ·
`detail-image(5)` · `candidate-panel(5)` · `viewer-scroll(4)` · `finish-open-review(2)`。

零引用 4 个：`review-toolbar` · `page-detail-warning` · `review-split` · `layout-info`。

**复现**：把 `scripts/r3_pages_count.mjs` 复制一份，把 `view-pages` 换成 `view-review` 跑。
验收按**id 集合**判（每个 id 在 app.js 各 0 处），不按总数。

## 二、函数面：A 类 72 / 1,955 行 → 剥掉假阳性后 A' 59 / 1,341 行

判定分两步：先按「碰了哪些 id」分组，再按**「这函数为谁存在」**逐个人工复核（后一步不能省）。

```
A 类（只碰 review id，不碰其它视图 id）：72 个函数 / 1,955 行
B 类（同时碰别的视图 id）：7 个 / 858 行
   boot 426 · setupReviewControls 136 · renderFinishPanel 135 · setupLibrary 68
   · applyPackageMode 44 · setupShell 35 · updateFinishChips 14        ← 接线/编排，只能拆不能整段搬
A' = A 类减去"碰了 review id 但不为 review 存在"的 13 个：59 个函数 / 1,341 行
```

「非 review」名单（逐名 20 个，其中 13 个在 A 类、7 个属 B 类）：

```
showView(74)           壳的视图切换器，只为给 #review-pager 设 hidden 才碰 review id
enterReviewStep(5)     现在就是 showView("reading")，不进 review
waitForAuxThenReview(60) · runAuxiliary(24) · renderAuxiliary(51) · setupAuxControls(6)
  · activeAuxJob(11) · openAuxWarning(18)       ← aux（识别）域，只是画在 review 面板上
confirmCurrentPage(26)                         确认/收尾域
loadFinishSummary(137) · renderFinishPanel(135) · updateFinishChips(14)   收尾面板（pages 的 chrome）
applyQueueAckLocally(76)                       块编辑域（PATCH 块 + 队列本地状态）
structureAction(63)                            结构编辑域（拆分/合并/撤销）
undoAutoApply(18)                              识别域（自动应用撤销）
ensureReviewTree(36) · renderReviewTree(177) · setReviewTreeOnlyTodo(8) · syncReviewTreeToPage(41)
  ← 左树 262 行，与 index-view 的目录树职责重叠 ⇒ **归 index 域，不在 review 刀里搬**
openPageDetail(14)                             详情抽屉域：10 个调用点里 6 个来自别的域
```

> 名单逐名 20 个（此前口头说"18 个"是漏数，以本表为准）；它们合计约 700 行。

## 三、接口面：外部引用 43 条 → C 5 / T 34（去假阳性后 review 自己的 C = 2~4）

```
A 类里被集合外调用的函数：43 个（按函数去重）
  C（别的视图模块经 injected 调，R2 禁模块互引 ⇒ 由外壳做 deps 映射）5 个：
    openPageDetail    ← pages / reading
    loadPageDetail    ← pages
    showPageDetailError ← pages-view.js:2117
    undoAutoApply     ← pages
    showView          ← pages
  T（只被壳调用，带死期）34 个
```

**归属已判**：`openPageDetail`（详情抽屉域）与 `undoAutoApply`（识别域）不属 review ⇒ review 自己的 C 是
`loadPageDetail` / `showPageDetailError`（+ 取决于 `renderPageDetail` 重画入口怎么收，见 §五）。

## 四、依赖面（壳状态）

```
留壳注入（get/set）：detailPageNo · detailPageRecord · reviewBlocks · reviewTree · reviewTreeFilter
  · reviewOverlayOn · reviewMarginOn · diffActive · queueSnapshot · boxSelect 状态
  · imageQualityMode · pageZoomIndex
跟随搬（review 私有派生量）：pagerNumbers · lastDetailPageNo
```

## 五、切片：S1 = 12 函数 / 351 行（**不含 openPageDetail**）

```
openPageDetail 已判属详情抽屉域 ⇒ S1 去掉它（原 13 函数 / 365 行 → 12 函数 / 351 行）
S1 组成：loadPageDetail(27) renderPageDetail(77) renderReviewPager(24) renderReviewBanner(55)
  renderReviewHeadline(27) renderReviewWorkflowStatus(9) pagerPages(9) renderHistoryButtons(8)
  paintReviewMargin(22) drawDetailLines(19) drawDetailOverlay(64) closePageDetail(10)
外部入口：pollTask 调 loadPageDetail；壳的 openPageDetail / refreshMarginState 等触发重画
```

**`renderPageDetail` 是枢纽**：搬它之后，"谁触发重画"必须收成一个能力（例如
`onPageDetailChanged(pageNo)`），否则 review 模块会变成"谁都能喊一下重画"的上帝入口。
这也是 S1 贵的原因——贵在它先动枢纽，不在行数。

## 六、未决（写在这里，避免下一个人重判）

```
① 用户三选一未定：QA 真机走一遍（看 review 现在还有哪些功能可达）· 只拆「页详情 + 差异层」500–800 行
   · 按原计划整体切（约 2,000 行）。Builder 量出的事实：enterReviewStep() 现在进的是 reading 视图，
   #view-review 只剩 3 个入口、已降级成"页详情查看器" ⇒ 三条路的代价差三倍。
② view-review 本体那 1 处（:5927）：清掉（改 closest(".view--review")）还是进 R3 豁免（带到期刀），未定。
③ openPageDetail 归详情抽屉域、左树 262 行归 index 域 —— 两条已定，等形态定了再排刀。
```

## 复现命令

```bash
# DOM 面（R3 口径）
cp scripts/r3_pages_count.mjs /tmp/r3-review.mjs && sed -i '' 's/view-pages/view-review/g' /tmp/r3-review.mjs
node /tmp/r3-review.mjs --json

# 函数面（A/B 分类）
# 1) 取 section id 集合；2) 按三个 section 的 id 集合给每个顶层函数打"碰了谁"；3) 再人工按"为谁存在"复核
```
