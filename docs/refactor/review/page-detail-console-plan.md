# ① 主刀施工书 v1：page-detail 编辑面板模块

> 来源：QA 2026-11-01 真机走查（Chief 转述）。量数树 `main@4676772`（app.js **12,755** / **505** 顶层函数 / deps **173**）。
> **状态：草案，等 Chief/Architect 批；本文件不改代码。**
> 前置：`review-ledger.md`（DOM/函数/接口底账）、`review-detail-drawer.md`（抽屉形态）。
> 顺序：**先落 T0（树可达性修复，见 §8）**，再落本刀；两刀之间重贴基线。

## 0. 形态：非视图服务模块，不是 `*-view.js`

```
文件   backend/book2text/static/page-detail.js
接口   window.PageDetail        （R7b 自动要求 <script> 在 app.js 之前）
root   init({ root: el("view-review"), … })
```

**为什么不是 `*-view.js`**：R3 对 `*-view.js` 零豁免——只要挂上这个后缀，`#view-review` 的 90 个 id 就全归模块，
树（325 行）· 收尾面板 · 清洗/延续弹窗 · 确认并下一页 · `setupReviewControls`（136 行）都得一起搬，
正好是 QA 否掉的「整体切约 2,000 行」。走非视图服务模块：模块只碰 §2 表里「归模块」的 id，外壳继续持有其余 id。

**代价与对策**：一个 section 两个 owner。必须同批加一条**新闸**（§2 表可机检）：

```
① page-detail.js 源码里出现的 id 字符串 ⊆ 「归模块」集合（剥注释口径）
② 「归模块」∩「归外壳」= ∅，且两集合并集 == view-review 子树全部被引用的 id
③ 变异：把一条外壳 id 写进模块 → ① 必红；把模块 id 从表里删掉 → ② 必红
```

## 1. 范围：QA 四件唯一能力 + 它们的闭包（逐函数实测于 4676772）

| 片 | 能力 | 函数数 | 行数 | 组成（逐函数行数） |
|---|---|---:|---:|---|
| S1 | **块列表编辑** | 24 | **855** | `blockCard`285 · `blockDivergenceSection`124 · `adoptAllHighSuggestions`61 · `renderReviewBlocks`45 · `diffCompareLines`42 · `patchBlock`35 · `diffRowFragment`33 · `blockSuggestionBadge`31 · `reviewAction`22 · `refreshDetailSuggestions`21 · `adoptLine`18 · `pageNumberHintChip`16 · `applyDetailSuggestions`14 · `adoptBlockSuggestion`14 · `captureEditorFocus`13 · `restoreEditorFocus`13 · `autoSizeTextarea`10 · `flushPendingSave`9 · `selectReviewBlock`21 · `focusSiblingBlock`8 · `scheduleBlockSave`8 · `blockNeedsReview`5 · `truncate`4 · `suggestionHighList`3 |
| S2 | **框选新增块** | 15 | **240** | `createBlockFromBox`33 · `recognizeBoxRegion`33 · `drawInkGapMarks`24 · `onBoxMouseUp`21 · `loadInkGaps`21 · `setupBoxCreate`17 · `renderInkGapBar`14 · `setBoxCreateMode`13 · `drawBoxDraft`13 · `startRegionRecognition`12 · `onBoxMouseDown`10 · `normalizedPoint`9 · `boxDraftRect`9 · `onBoxMouseMove`8 · `inkGapBarVisible`3 |
| S3 | **版面确认** | 3 | **67** | `renderLayoutPanel`23 · `confirmPageLayout`23 · `renderSuggestionTools`21 |
| S4 | **第二引擎复核** | 6 | **170** | `waitForAuxThenReview`60 · `renderAuxiliary`51 · `runAuxiliary`24 · `openAuxWarning`18 · `activeAuxJob`11 · `setupAuxControls`6 |
| 合计 | | **48** | **1,332** | （`applyDetailSuggestions` 在 S1/S4 复用，只算一次） |

**不进口的四块**（各有归属，别硬塞）：

```
核心抽屉  loadPageDetail(27) renderPageDetail(77) drawDetailOverlay(64) drawDetailLines(19)
          pagerPages/renderReviewPager/setupReviewPager/renderReviewFilter(89) renderReviewBanner(55) 等 ≈ 430 行
          —— 它先于四件能力存在；本刀只把「编辑面板」交出去，抽屉仍由外壳画，画完调 PageDetail.renderBlocks()
块框拖动/缩放  348 行（lineEdges…buildBoxLabel）—— applyBoxElementRect 同时被 preview-view 注入用，
          属 overlay 域（② registry），搬它会让 preview 多一条模块依赖
树        325 行（含 T0 要改的分组）—— 归 index 域，T0 单独修，不在本刀
收尾/确认/自动通过  confirmCurrentPage(26) setupReviewAutoPass(42) renderFinishPanel(135) finishStartReview
          —— 按钮在编辑面板里，但动作归收尾域 ⇒ 模块只绑定按钮、调注入能力
清洗件     差异队列(167) / 候选对比 —— 清洗刀先删，删完本刀不必碰
4 个零引用 id  review-toolbar · page-detail-warning · review-split · layout-info —— 清洗刀删
```

## 2. id 归属（机检表的初稿）

**归模块（20 个）**：`detail-blocks` · `block-position` · `review-filter` · `review-filter-note` ·
`box-select-panel` · `box-select-info` · `box-select-text` · `box-select-recognize` · `box-select-confirm` ·
`box-select-cancel` · `box-select-status` · `review-undo` · `review-redo` · `layout-panel` · `layout-panel-status` ·
`suggestion-apply-all` · `aux-panel` · `aux-summary` · `aux-hint` · `aux-lines`（+ `aux-close` 的接线）

**归外壳**：`review-tree*`（树）· `review-pager`/`review-prev`/`review-next`/`review-page-no`/`review-jump*`（抽屉）·
`detail-image`/`detail-canvas`/`detail-lines`/`detail-overlay`/`detail-margin`/`detail-diff-layer`/`detail-ink-gaps`（viewer）·
`page-detail-title`/`page-detail-meta`/`page-detail-error`/`review-banner`（抽屉）· `review-more*`（菜单容器）·
`review-confirm`/`review-continuations`/`finish-open-review`（收尾）· 清洗件。

**16 个冲突 id，逐条裁决**（这就是本刀真正的接线工作量）：

| id | 冲突 | 裁决 |
|---|---|---|
| `detail-blocks` | 模块渲染；外壳 `setupReviewControls` 只做「点别处关菜单」 | 移到模块内部（点击消失逻辑随块列表走） |
| `page-detail-error` | 模块写；外壳 8 处写（结构/候选/确认/树/撤销） | 外壳改调 `PageDetail.showError(error)`；模块内部直写 |
| `aux-run` / `detail-recognize` | 模块绑定；外壳 `applyPackageMode` 隐藏 | 模块导出 `setPackageModeChrome(on)` |
| `candidate-*` / `diff-queue*` | 模块渲染；外壳动作 | **清洗刀先删**，冲突自然消失 |
| `layout-confirm` / `suggestion-apply-all` / `review-undo` / `review-redo` | 模块渲染；外壳 `setupReviewControls` 绑监听 | 监听搬进模块（`init` 里统一挂） |
| `review-margin-toggle` / `review-footer-count` | 外壳 viewer 绑定/渲染 | 归外壳（模块不碰） |
| `review-tree-filter` | 模块 `setupViewerTools` 碰了一下 | 归外壳（删掉模块里那处） |
| `review-auto-pass` / `review-auto-revoke` | 模块只读（`renderReviewWorkflowStatus` 改文案）；外壳绑定 | 归外壳，模块改为「读状态画文案」的注入值 |

## 3. 接口面：L / T / C

```
L  init({ root, …deps })         生命周期（挂载模块自己的接线）
T  renderBlocks(blocks)          外壳 renderPageDetail 画完块列表后调它（唯一重画入口）
   setFilter(filter, explicit)   reviewBlockFilter 的写点收成能力（外壳 setReviewBlockFilter 调）
   setPackageModeChrome(on)      applyPackageMode 的隐藏动作
   showError(error)              page-detail-error 的唯一写入口（外壳 8 处改调）
   openBoxCreate() / cancelBoxCreate()   框选模式开关（菜单项在外壳，动作在模块）
C  0 个                           别的视图模块不直接用本模块；pages/reading 要的 openPageDetail /
                                 loadPageDetail / showPageDetailError 仍由外壳持有（核心抽屉没搬）
```

**不新增「谁都能喊重画」的入口**：`renderBlocks` 是唯一重画口，外壳只在 `renderPageDetail` 末尾调一次；
块内改类型/换第二路/加备注全部走模块内部的动作，不再回头喊外壳。

## 4. 依赖面（顶层状态：跟随搬 / 留壳注入）

| 跟随搬（review 私有派生量） | 留壳注入（别的域也在读写） |
|---|---|
| `activeReviewBlockId` · `cursorByBlock` · `detailSuggestionByBlock`（读写） · `detailLayoutConfirmed`（读写） · `boxCreateMode` · `boxDraft` · `detailInkGaps`/`inkGapsShown` · `auxData` · `auxWarningWaitToken` | `detailPageNo`（读写，外壳 30+ 函数用） · `reviewBlocks`（读写） · `reviewBlockFilter`/`reviewFilterExplicit`（读写） · `currentProject` · `pageSuggestionCache` · `token` · `PAGE_TYPE_LABELS`/`BLOCK_TYPE_LABELS`/`REVIEW_STATUS_LABELS`/`TEXT_FREE_*`/`CHROME_*`/`NOTE_*` |

注入形态照 `pages-view`：getter 只读、有写点的给 setter，`apiJson`/`showError`/`notify` 按动作给。

## 5. 切片（每片独立绿，不并刀）

```
S1 块列表编辑（855）   renderBlocks + blockCard + 编辑保存 + 建议采纳 + 撤销重做
                     验收：改类型/换第二路/加备注 各一条；撤销/重做各一次；块列表 0 失焦丢字
S2 框选新增块（240）   框选模式 + 草稿 + 创建 + 「识别这块」+ 漏行条
                     验收：拖框 → 创建 → 块出现且可编辑；识别这块回填文本；取消不写库
S3 版面确认（67）      layout-panel + 确认动作 + 建议一键采纳
                     验收：确认后状态变、改块类型后回到未确认、可撤销
S4 第二引擎复核（170） aux 面板 + 逐行 + 收尾后刷新
                     验收：复核一页 → 面板逐行出现；采/留各一条；面板关闭不丢状态
```

## 6. 验收（落盘后）

```
① 函数名集合相减：app.js 少 48 个名字、page-detail.js 多 48 + init/5 个导出；两边名单对集，不报总数
   基线在 T0 之后重贴（505 会变；deps 仍 173）
② 新闸：id 归属表三支（模块 id ⊆ 表 · 两集不交 · 并集 == 被引用集合）+ 变异各红一次
③ 模块 DOM 面：剥注释后 `el(` / `document.getElementById` 各 0；只许 root.querySelector
④ R3 pages 0/0 不变；PagesView 导出 36 不变；deps 173 不变（本刀不改 pages deps）
⑤ 四闸 + audit：node / pytest / accept [0] / registry 0 不合格 / audit 会假红 0
⑥ QA 复验（同一套走查）：块编辑 / 框选新增块 / 版面确认 / 第二引擎复核 四件逐条；外加
   「块列表数字 == 实际可点块数」「面板关闭再开不丢状态」
⑦ 真机一条变异：把 `detail-blocks` 的写点留一句在 app.js → 新闸②必须红
```

## 7. 不做什么

```
· 不搬核心抽屉（load/render/pager/viewer/diff）—— 那是下一刀，和 ② overlay registry 一起排
· 不搬块框拖动/缩放（348 行，overlay 域，preview 也在用）
· 不搬树（T0 只修可达性；整棵树的模块化归 index 域）
· 不动收尾面板 / 清洗 / 延续弹窗 / 确认并下一页 / 自动通过
· 不在本刀修「章节检测只归出 7 章、29 页无归属」（记账，另开）
```

## 8. 前置 T0：树可达性修复（单独一小笔，先于本刀；不进口 ① 主刀，也不进清洗刀）

**点击语义（先核 DOM，回答 QA 的「疑为展开」）**——逐行读 `renderReviewTree`：

```
回目行 .review-tree__row--chapter   → toggleReviewTreeChapter（只展开/折叠，不跳页）   ← "条目是展开钮"只对这一行成立
页行   .review-tree__row--page      → openPageDetail(page.page_no)（跳页）
页行内 ▸/▾ 小按钮 .review-tree__caret → 只展开该页的差异条目（stopPropagation）
条目行 .review-tree__row--item      → openTreeItem（跳页并定位到该条）
```

⇒ **"跳页失效"不成立**；真正的缺陷在下面：没有章节归属的页根本不出现在树上，点不到。

**缺陷**（QA 实测 + 代码核实）：`renderReviewTree` 只在 `chapter === page.chapter` 时把页挂进树；
`page.chapter` 匹配不到任何 `chapter.id` 的页（29 页，其中 21 页背着全部 90 处待审）**永远没有行**，
而头部「N 处待审」取自全部页 ⇒ **数字和点得到的东西对不上**。

**形态**：分组算成纯函数，渲染只拿结果。

```
function reviewTreeGroups(pages, chapters)   // ≈18 行
  · chapters 空 → [{ id:null, title:null, pages }]（平铺）
  · 否则：每个章一组（空章跳过）+ 末尾「未归章」一组（page.chapter 不在 chapters 里）
renderReviewTree：删掉内联的 filter/continue（≈−25 行），改成 for (group of reviewTreeGroups(...))（+10）
净：+1 个顶层函数 / app.js ±10 行（实测对账）；deps 不变 173
```

**判据（可红）**：`sum(树上可达页的 unacked) == 头部 unacked 总数`，四组夹具（全有章 / 全无章 / 混合 / chapters 空）；
变异：删掉「未归章」分支 → 合计断言红。真机：点「未归章」里的页 → `openPageDetail` 生效。
分工：TestDev 出测试笔（`Approved-by: DevLead`，红证据写提交正文：修前可达 0 / 头部 90），Builder 落产品笔。
另记一条事实（不修）：490 页只归出 7 章、29 页无归属，可能是章节检测的问题，不在这一笔里碰。

## 9. 顺序与基线（Chief 点名的三样）

```
T0（树修复）→ 清洗刀（差异队列/候选/4 个零引用 id）→ S1 → S2 → S3 → S4
每一刀落完重贴 app.js 顶层函数数与 deps 实测值；本文件的 505 / 173 只在 4676772 上成立。
```

## 10. 复现命令

```bash
# 四件能力的函数集与行数（本文件 §1）
node /tmp/cap-groups.mjs        # 脚本见本文件附录（或按名字 grep 定义行后逐段量）

# id 归属与冲突（§2）
node /tmp/id-owner.mjs

# 状态归属（§4）
node /tmp/state-owners.mjs

# 基线
grep -cE "^(async )?function [A-Za-z_]" backend/book2text/static/app.js    # 505
node scripts/r3_pages_count.mjs --json
```
