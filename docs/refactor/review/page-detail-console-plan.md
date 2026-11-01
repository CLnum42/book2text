# ① 主刀施工书 v1.1：page-detail-editor 模块（编辑面板）

> 来源：QA 2026-11-01 真机走查（Chief 转述）。量数树 `main@4676772`（app.js **12,755** / **505** 顶层函数 / deps **173**）。
> **状态：草案，等 Chief/Architect 批；本文件不改代码。**
> 前置：`review-ledger.md`（DOM/函数/接口底账）、`review-detail-drawer.md`（抽屉形态）。
> 顺序：**先落 T0（树可达性修复，见 §8）**，再落本刀；两刀之间重贴基线。

## 0. 形态：非视图服务模块，不是 `*-view.js`

```
文件   backend/book2text/static/page-detail-editor.js
接口   window.PageDetailEditor        （R7b 自动要求 <script> 在 app.js 之前）
root   init({ root: el("view-review"), … })
```

**为什么不是 `*-view.js`**：R3 对 `*-view.js` 零豁免——只要挂上这个后缀，`#view-review` 的 90 个 id 就全归模块，
树（325 行）· 收尾面板 · 清洗/延续弹窗 · 确认并下一页 · `setupReviewControls`（136 行）都得一起搬，
正好是 QA 否掉的「整体切约 2,000 行」。走非视图服务模块：模块只碰 §2 表里「归模块」的 id，外壳继续持有其余 id。
**命名（Chief 2026-11-01 裁决）**：核心抽屉留壳 ⇒ 本刀叫 `page-detail-editor.js`；将来抽屉单独一刀叫
`page-detail-drawer.js`。两个 owner 用两个名字写明白，别让人去 editor 里找抽屉。

**代价与对策**：一个 section 两个 owner。必须同批加一条**新闸**（§2 表可机检）：

```
① page-detail.js 源码里出现的 id 字符串 ⊆ 「归模块」集合（剥注释口径）
② 「归模块」∩「归外壳」= ∅，且两集合并集 == view-review 子树全部被引用的 id
③ 变异：把一条外壳 id 写进模块 → ① 必红；把模块 id 从表里删掉 → ② 必红
```

## 1. 范围：QA 四件唯一能力 + 它们的闭包（逐函数实测于 4676772）

| 片 | 能力 | 函数数 | 行数 | 组成（逐函数行数） |
|---|---|---:|---:|---|
| S1 | **块列表编辑** | 24 | **851**（原 855） | `blockCard`285 · `blockDivergenceSection`124 · `adoptAllHighSuggestions`61 · `renderReviewBlocks`45 · `diffCompareLines`42 · `patchBlock`35 · `diffRowFragment`33 · `blockSuggestionBadge`31 · `reviewAction`**18**（清洗刀 −4）· `refreshDetailSuggestions`21 · `adoptLine`18 · `pageNumberHintChip`16 · `applyDetailSuggestions`14 · `adoptBlockSuggestion`14 · `captureEditorFocus`13 · `restoreEditorFocus`13 · `autoSizeTextarea`10 · `flushPendingSave`9 · `selectReviewBlock`21 · `focusSiblingBlock`8 · `scheduleBlockSave`8 · `blockNeedsReview`5 · `truncate`4 · `suggestionHighList`3 |
| S2 | **框选新增块** | 15 | **238**（原 240） | `createBlockFromBox`33 · `recognizeBoxRegion`33 · `drawInkGapMarks`24 · `onBoxMouseUp`21 · `loadInkGaps`21 · `setupBoxCreate`**15**（搬进模块后 −2：canvas 改走 `getDetailCanvas` 注入）· `renderInkGapBar`14 · `setBoxCreateMode`13 · `drawBoxDraft`13 · `startRegionRecognition`12 · `onBoxMouseDown`10 · `normalizedPoint`9 · `boxDraftRect`9 · `onBoxMouseMove`8 · `inkGapBarVisible`3 |
| S3 | **版面确认** | 3 | **67** | `renderLayoutPanel`23 · `confirmPageLayout`23 · `renderSuggestionTools`21 |
| S4 | **第二引擎复核** | 6 | **170** | `waitForAuxThenReview`60 · `renderAuxiliary`51 · `runAuxiliary`24 · `openAuxWarning`18 · `activeAuxJob`11 · `setupAuxControls`6 |
| 合计 | | **48** | **1,326**（原 1,332） | （`applyDetailSuggestions` 在 S1/S4 复用，只算一次） |

> 本表是 `4676772` 的读数。两次落盘后的修正：清洗刀（`02213d8`）使 S1 的 `reviewAction` 22 → 18；
> S2 落盘（`33e5261`）时 `setupBoxCreate` 17 → 15（canvas 改走 `getDetailCanvas` 注入）。
> 全刀合计 1,332 → **1,326**。S1 的逐函数起止行见 **§11（清洗后重贴）**，开工按那张表。

### 1.1 三格对账（Chief 2026-11-01 要求：三格合计 == 这条线的总行数）

口径：**review 代码块内的全部顶层函数**（`5466–9030` 审校视图…框选/漏行 ＋ `9893–10924` 左树/收尾邻接
＋ `1272–1359` 第二引擎复核 ＋ `706–827` 第二引擎可选；按当前树 `4231b03` 的段头，函数按起始行归属）。
合计 **178 个函数 / 4,259 行**，三格互斥、无遗漏：

| 格 | 函数数 | 行数 | 内容 |
|---|---:|---:|---|
| 搬进模块（本刀） | 48 | **1,332** → 清洗后 **1,328** | S1 块编辑 855 → **851** · S2 框选 240 · S3 版面 67 · S4 二引擎 170 |
| 留壳 | 45 | **902** | 块框拖动/缩放 348 · 收尾/清洗/候选的辅助（computeCharSpans 58 · aggregateDivergence 20 …） · 接线 `setupReviewControls` 136 · `setupLibrary` 68 · `closeProject` 31 · 其它小函数 |
| 别的域 | 85 | **2,025** | 抽屉域 32/729 · 清洗/删 19/459 · 收尾域 20/349 · 树→index 13/425 · 结构域 1/63 |

**与 `review-ledger.md` 的 A′ 59 / 1,341 对账（2026-11-01 重量，已可复算）：**

```
A（只碰 review id 的函数，含字符串/展开调用）    78 / 2,957
  − 5 个 B 类（boot/setupShell/setupLibrary/applyPackageMode/renderFinishPanel）  −717
  − blockCard（285）——它的 id 藏在字符串/展开里，三取法扫不到                −285
= A（ledger 口径）                              72 / 1,955   ✓ 与 ledger 一致
  − 9 个非 review（showView/runAuxiliary/renderAuxiliary/setupAuxControls/confirmCurrentPage/
    applyQueueAckLocally/structureAction/undoAutoApply/openPageDetail）        −352
  − 4 个树（ensureReviewTree/renderReviewTree/setReviewTreeOnlyTodo/syncReviewTreeToPage） −262
= A′                                            59 / 1,341   ✓ 与 ledger 一致
```

⇒ **ledger 的 A′ 1,341 是对的**；我上一版说的「A′ 自身差 168、应为 1,509」是错的（忘了 blockCard 已先出局、
也漏了 4 个树名），已撤回。59 个逐名 + 行范围见 `review-ledger.md` §二·补；
复算脚本 `scripts/review_a_prime.mjs`。

本刀的 1,332 与 A′ 仍是**两批东西**：1,332 是能力闭包（含 blockCard 285 + 块内差异 199，不含抽屉 729 / 清洗 459）；
A′ 是「碰 review id 的函数全集 − 非 review − 树」，含抽屉、不含 blockCard。两个数接近是巧合。

**逐函数三格表**：`docs/refactor/review/three-column-attribution.md`（178 行，名字/起/止/行数/格/备注），
复算脚本 `scripts/review_three_columns.mjs`。

**这条线的真实规模**：4,259 行里，本刀搬 1,332（31%），留壳 902（21%），别的域 2,025（48%）。

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

### 3.1 外壳喊模块 = 接口面（R8/R7 管这一边，**S3 定稿 20 个**）

```
init（L）
renderBlocks 5657/5718 · setFilter 5574 · setPackageModeChrome 5678/9441 · setBoxCreateMode 5273
loadInkGaps 5326 · renderSuggestionTools 5723 · renderLayoutPanel 5724
applyDetailSuggestions 5307 · refreshDetailSuggestions 5327 · blockNeedsReview 5601
pageNumberHintChip 6092 · adoptBlockSuggestion 6071/10117 · adoptAllHighSuggestions 10209
truncate 6453/6454/7873 · selectReviewBlock 5721/6560/6688 · flushPendingSave 4666
adoptLine 1342 · patchBlock 5974 · reviewAction 8609/8612
```
（行号是 `9e38260` 的实测；每个名字都在 app.js 里有真实调用点，闸 S3 直接执行模块拿 `Object.keys` 逐个核。）

**5 个曾出现、但 S3 按 §1 ⑦ 删掉的导出**（别以为少了，也别再加回来）：

```
showError          模块自己实现 showEditorError 写 #page-detail-error；外壳不需要"喊模块报错"
openBoxCreate      菜单项 → 模块 init 里自己 bind("detail-box-create")，外壳不再调
cancelBoxCreate    同上：bind("box-select-cancel")
setupBoxCreate     唯一调用在模块 init 的 wired 守卫里（S2 复核时被我抓出来，S3 删）
suggestionHighList 它的两处调用原本在被搬走的两个函数体内 ⇒ 搬完后外壳 0 调用（S3 的导出面闸当场抓到）
```

**判据**：导出面 = "每个导出都能指出谁在哪调"，**不是**"导出数等于某个数"。要加导出，先加调用点；
S3 的闸会执行模块取真实 api 键，再逐个在 app.js 里找 `PageDetailEditor?.<key>(`。

### 3.2 模块喊外壳 = **注入**（不进接口面，**不许和 3.1 混成一张清单**）

口径：模块源码里**实际读**的 `injected.X`。S3 定稿实测（`9e38260`）：
**53 个键 = 26 个外壳函数 + 6 个常量表 + 20 个状态/元素访问器 + root**，且**传入 53 / 读出 53，两个方向都对得上**
（S3 的闸双向判：传了没人读 = 死注入；读了没传 = 漏注入）。

```
函数 26：activateDiff · apiJson · blockInsideMargin · computeCharSpans · detailPageRecord · diffLevelLabel ·
        divergenceOf · drawDiffLayer · effectiveReviewFilter · ensureBlockListed · fetchPageSuggestions ·
        forgetPageBlocks · forgetPageSuggestions · loadPageDetail · pageNumberSplitHint · pendingPageReasons ·
        refreshPageStates · refreshReviewFilterOnly · renderReviewFilter · renderReviewHeadline ·
        reviewMarginSplit · scrollViewerTo · setSaveState · structureAction · syncDiffStrip · updateDiffActive
常量表 6：BLOCK_TYPE_LABELS · TEXT_FREE_BLOCK_TYPES · CHROME_BLOCK_TYPES · NOTE_BLOCK_TYPES ·
        REVIEW_STATUS_LABELS · MAX_DIVERGENCE_ROWS
状态/元素访问器 20：getCurrentProject · getDetailPageNo · getReviewBlocks · getCursorByBlock ·
        getDetailSuggestionByBlock · setDetailSuggestionByBlock · setDetailNumberHints · setActiveReviewBlockId ·
        getDiffStripOpen · getDetailOverlay · getDetailCanvas · getDetailImage · getDetailInkGaps ·
        getDetailInkGapsState · setDetailInkGapsState · getDetailLayoutConfirmed · getBoxCreateMode ·
        setBoxCreateMode · setReviewBlockFilter · setReviewFilterExplicit
宿主 1：root（= #view-review）
```

**两个曾经死掉的注入已清（S3）**：`getActiveReviewBlockId`、`PAGE_TYPE_LABELS` —— S1/S2 期间它们传了但 0 读；
S3 把"死注入"做成闸（双向判），顺手删掉这两行。**以后加注入键必须同时能指出模块哪一行读它**。

**为什么必须分开**：接口面是"外壳按语义叫模块"，有 R8 的 kinds 表与 T 的死期管着；
注入是"模块按签名叫外壳"，**没有死期、也不该有**——把两者写成一张清单，下一个人就会问
"`apiJson` 的死期是哪一刀"。§6 ⑧ 的"神入口判据"用的是**两表的并集**，但两张表本身要分开写。

**不新增「谁都能喊重画」的入口**：`renderBlocks` 是唯一重画口，外壳只在 `renderPageDetail` 末尾调一次；
块内改类型/换第二路/加备注全部走模块内部的动作，不再回头喊外壳。

## 4. 依赖面：顶层状态分三类（S1 实测 + 裁决 A，2026-11-02）

Builder 按 S1 的 24 个函数体逐个体扫过（不是估计）。**S1 实际只碰这 8 份状态，其中 3 份纯私有、5 份借用**：

| 类 | 状态 | 谁在用（证据） | 处理 |
|---|---|---|---|
| **跟随搬（3）** | `detailSuggestions` · `reviewPendingSave` · `reviewSaveTimer` | 只在被搬的 24 个函数里读写 | 搬进模块，模块内 `let` |
| **借用（5）** | `activeReviewBlockId`（`renderPageDetail:5714` 复位）· `diffStripOpen`（`:5716` 复位、`6570`/`6607` activateDiff）· `detailSuggestionByBlock`（`:6712` 外壳画角标）· `detailNumberHints`（`:7703` 外壳页码拆分提示）· `cursorByBlock`（`:7769` drawDetailOverlay 外壳清空） | 模块要用，**外壳也在读写它** | **留在 app.js、名字不变**；`init` 拿 `getX`/`setX`（5 份 × 2 = **10 个注入键，不进 deps 表**，deps 仍 173）；**模块里不许缓存副本**，每处读写都走注入 |

**裁决 A 的理由**（与刀 C 的页面块缓存、刀 D 的同构）：**状态属于"谁还在用它"的那个域，不属于"哪个函数先动"**。
核心抽屉在 S1 里留在外壳 ⇒ 这五份**随抽屉走**，等抽屉单独成模块（`page-detail-drawer.js`）时再一起搬。
若现在搬进 editor，就会出现"editor 持有抽屉的状态"，下一个问题必然是"谁拥有它"。

**"借用不许留副本"要能红**（判据，不是口号）：

```
测试形态（模块单测，假壳）：
 ① 模块选一个块 → 断言 injected.getActiveReviewBlockId() === 那个块的 id（写回外壳了）
 ② 外壳复位（走 renderPageDetail 的 5714 路径）→ 断言模块读到的也是 null（没有拿本地旧值覆盖）
变异：把模块里那处 `injected.setActiveReviewBlockId(x)` 改成只赋值给模块内 `let activeReviewBlockId`
 ⇒ ① 立刻红（外壳读到 null）。这条变异证明"副本"存在时判据抓得住。
```

**其余状态不在 S1 里**（别照抄旧表）：`detailLayoutConfirmed` · `boxCreateMode` · `boxDraft` ·
`detailInkGaps`/`inkGapsShown` · `auxData` · `auxWarningWaitToken` 属于 S2/S3/S4（框选 / 版面确认 / 二引擎），
**各自开工前按同样口径重测一遍**，不许沿用今天这张表的归类——今天它就是这么错的（把 8 份写成 9 份、且一半不是 S1 的）。

注入形态照 `pages-view`：getter 只读、有写点的给 setter，`apiJson`/`showError`/`notify` 按动作给（见 §3.2）。

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
⑧ **借用状态不留副本**：见 §4 的两步测试（选块 → 外壳读到的 id 变了；外壳复位 → 模块读到 null）；
   变异"模块绕过 setter 只改本地" ⇒ 必红
⑨ **神入口判据**：模块源码里出现的 app.js 顶层函数名 ⊆ 接口面 T ∪ 注入键——扫出来凡不在集合里的，
   就是"谁都能喊一下"的入口（不是行数问题）；再加无环证据：编辑 → 重画只许经 `onPageDetailChanged` 一处

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

**定性更正（Chief 2026-11-01）**：不是"一处都点不到"——`#review-tree-filter`「只看未完成」打开后走
`:10152` 那支（`pages.filter(unacked > 0)` 平铺，不按章节），90 处**按一次就能点到**。所以缺陷是：

**同一棵树的两种模式对同一份数据给出不同的可达集合**——默认模式（filter=false）静默丢掉无章节页，
还把 7 个回目记成「✓ 完成」；过滤模式能列全。头部数字取自全部页，跟默认可点集合不是同一个集合。

**缺陷**（代码核实）：`renderReviewTree` 只在 `chapter === page.chapter` 时把页挂进树；
`page.chapter` 匹配不到任何 `chapter.id` 的页（29 页，其中 21 页背着全部 90 处待审）**永远没有行**。

**形态**：分组算成纯函数，渲染只拿结果。

```
function reviewTreeGroups(pages, chapters)   // 函数体 14 行 + 注释
  · chapters 空 → [{ id:null, title:null, pages }]（平铺）
  · 否则：每个章一组（空章跳过）+ 末尾「未归章」一组（page.chapter 不在 chapters 里）
renderReviewTree：分组交给纯函数，自己只渲染
```

**预测 vs 实测**（落盘 `5e2a995` / 合入 `223932d`；预测是写书时的估，不是验收数）：

| 项 | 预测（写书时） | 实测 | 差在哪 |
|---|---|---|---|
| 顶层函数 | 501 → 502（+1） | **496 → 496** | +`reviewTreeGroups`，−`treeChapterOfPage`（分组函数接管后它 0 引用；留着会撞刀 11 闸②「0 引用顶层函数 = 红」） |
| app.js 行数 | ±5～10 | **12,606 → 12,636（+30）** | 函数替换 +16 · `renderReviewTree` +9 · `syncReviewTreeToPage` +2 · `updateReviewTreeAfterAck` +3 |
| `renderReviewTree` | ≈ −15 | **+9** | 书的 −25 是拿「删内联 filter/continue」估的；实际能删的只有 `chapterPages` 两行与 chapters 空支两行，章头/页行/条目行本来就该留在 render 里 |
| deps | 173 | **173** | — |

⇒ **账按 diff 记，不按清单记**：函数数看差集（`+reviewTreeGroups, −treeChapterOfPage`），不看总数；行数看 `git diff`，不看估。

**判据（可红，两条都要）**：

```
① 必须在**默认模式**（reviewTreeOnlyTodo=false）下成立——否则测试会被过滤模式那支顺带满足，等于没验
② 比**集合**不比合计：树上出现的 page_no 集合 == 数据里 unacked>0 的页集合；另外总和也要比（两条都断言）
③ 模式二（filter=true）再跑一组，防回归
夹具四组：全有章节 / 全无章节 / 混合 / chapters 空。变异：删掉「未归章」分支 → 集合与合计断言都红。
真机：点「未归章」里的页 → openPageDetail 生效。
分工：TestDev 出测试笔（`Approved-by: DevLead`，红证据写提交正文：修前可达 0 / 头部 90），Builder 落产品笔。
另记一条事实（不修）：490 页只归出 7 章、29 页无归属，可能是章节检测的问题，不在这一笔里碰。
```

**交付项不含「当前页落在无归属页时该组自动展开」**（2026-11-02 撤）：这句不是缺陷要求，落盘后它成了回归来源——
`syncReviewTreeToPage` 用 `group.title` 判断强制展开，未归章（`id=null`）也被算进去，把用户手动的回目展开/折叠复原。
修法一行：`group && group.id !== null && group.title && …`（Builder 修，TestDev 补一条「修前必红」，QA 修后复验三件）。
验收只要求：未归章组出现、页可点、可达页集合与头部总数对得上；**不要求**进页时自动展开未归章。

**T0 结案（2026-11-02）**：修法**两处**——`:9994 renderReviewTree` 与 `:10202 syncReviewTreeToPage`
都改成 `group.id !== null`；只改一处会 **6 绿 1 红**（TestDev 三树对照 `d4c45c9`，红的是「点回目行后展开集合被复原成 [null]」）。
测试 212 / 210 pass / 0 fail / 2 skipped；QA 真机三项 + 未归章第 20 页跳转全过；
证据 `tests/e2e/artifacts/2026-11-02-review-tree-fix/`（README + result.json + 2 张 JPEG）。
唯一遗留：当前页在有章节的组里时该组收不起来 ⇒ 记 `known-limitations.md` L-33（T0 前既有，另刀修）。

## 9. 顺序与基线（Chief 点名的三样）

```
刀 C（Builder）→ 刀 D → 清洗刀（差异队列/候选/4 个零引用 id）→ S1 → S2 → S3 → S4
（Chief 2026-11-02 调整：清洗刀必须在 S1 之前——先清死代码再搬，别把马上要删的函数先进新模块再删一遍。
 已核：清洗删的 25 个函数与本刀 48 个**交集为空**；但 S1 的 `reviewAction` 会因
 captureQueueSnapshot / restoreQueueAfterUndo 被删而变短，S1 行数按清洗后的树重贴。）
基线链（按实际落盘顺序，不按写书时的预测）：
  刀 A（113a552 + 4231b03）：505 → 501 / app.js 12,658 / deps 173
  刀 B（1c9fb42 + fd3c392）：501 → 496 / app.js 12,606 / deps 173
  T0（5e2a995，合 223932d）：496 → 496 / app.js 12,636 / deps 173（预测 502 作废，见 §8 两栏表）
  ① 主刀的 48 函数 / 1,332 行是**函数集合**，不随 496/501 变；开工时按当时树重贴 app.js 函数数
每一刀落完重贴实测值；本文件的 505 / 12,755 只在 4676772 上成立；刀 A 落完是 501 / 12,658（删 106 + 加 9 = 净 −97）。
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

## 11. 清洗后重贴：S1 的 24 个函数逐名 + 行范围（基线 `02213d8`，DevLead 实测）

**这张表是 S1 开工的唯一依据**（§1 的表是 `4676772` 的读数）。基线：

```
app.js 11,743 · 顶层函数 458（335 function + 123 async function）· deps 173 · R3 review 71/181
```

口径：`^(async )?function NAME(` 的定义行 = 起；从该行起做花括号配平，**第一个列 0 的 `}`** = 止；
行数 = 止 − 起 + 1。三个切片 S2/S3/S4 在同一棵树上重算后与 §1 完全一致（240 / 67 / 170），
说明**切片边界没有挪动，变的只有 `reviewAction`**。

| # | 函数 | 起 | 止 | 行数 |
|---:|---|---:|---:|---:|
| 1 | `applyDetailSuggestions` | 5326 | 5339 | 14 |
| 2 | `refreshDetailSuggestions` | 5349 | 5369 | 21 |
| 3 | `blockNeedsReview` | 5620 | 5624 | 5 |
| 4 | `suggestionHighList` | 6776 | 6778 | 3 |
| 5 | `pageNumberHintChip` | 6855 | 6870 | 16 |
| 6 | `blockSuggestionBadge` | 6872 | 6902 | 31 |
| 7 | `adoptBlockSuggestion` | 6905 | 6918 | 14 |
| 8 | `adoptAllHighSuggestions` | 6924 | 6984 | 61 |
| 9 | `blockCard` | 6986 | 7270 | 285 |
| 10 | `blockDivergenceSection` | 7283 | 7406 | 124 |
| 11 | `diffCompareLines` | 7410 | 7451 | 42 |
| 12 | `diffRowFragment` | 7453 | 7485 | 33 |
| 13 | `truncate` | 7488 | 7491 | 4 |
| 14 | `autoSizeTextarea` | 7494 | 7503 | 10 |
| 15 | `renderReviewBlocks` | 7505 | 7549 | 45 |
| 16 | `selectReviewBlock` | 7551 | 7571 | 21 |
| 17 | `focusSiblingBlock` | 7573 | 7580 | 8 |
| 18 | `scheduleBlockSave` | 7585 | 7592 | 8 |
| 19 | `flushPendingSave` | 7600 | 7608 | 9 |
| 20 | `adoptLine` | 7611 | 7628 | 18 |
| 21 | `patchBlock` | 7630 | 7664 | 35 |
| 22 | `captureEditorFocus` | 7667 | 7679 | 13 |
| 23 | `restoreEditorFocus` | 7682 | 7694 | 13 |
| 24 | `reviewAction` | 8072 | 8089 | **18**（清洗前 22） |
| | **合计** | | | **851**（清洗前 855） |

### 11.1 清洗刀对 S1 的影响：只有 `reviewAction`，接口面不变

```
清洗刀删 25 个函数（队列 19 + 候选 6），与 S1 的 24 个**交集为空**；
但函数体被改过的**非删除**函数共 9 个（Chief 的清单是 8 个，漏了 setupViewerTools 48→42）：
  setupViewerTools 48→42 · setupReviewControls 136→100 · drawDiffLayer 94→92 · renderPageDetail 77→70
  loadPageDetail 27→23 · reviewAction 22→18 · closePageDetail 10→7 · openTreeItem 20→8 · runPageAux 7→5
其中落在 S1 的只有 reviewAction（−4）：
  × const queueSnapshot = path === "undo" ? captureQueueSnapshot() : null;
  × if (queueSnapshot) restoreQueueAfterUndo(queueSnapshot);    ×2
  ⇒ 去掉的都是**队列内部**的调用，reviewAction 的外部依赖一个没少：
     currentProject / apiJson / setSaveState / forgetPageBlocks / detailPageNo / loadPageDetail /
     refreshPageStates / showError / el("page-detail-error")
  ⇒ **S1 的接口面（T 键）不跟着减**。其余 8 个改过的函数属核心抽屉 / 左树，不进口 ① 主刀。
另：新树全仓对被删的 25 个名字**残留 0**（含 S1 的 24 个函数体），被删的 8 个 id 也是 0。
```

### 11.2 `renderReviewHeadline` 不进 S1

清洗后它只剩核心抽屉那一份（3 处），队列判断已随删消失。**S1 是块列表编辑，不许顺手把 headline 带进来**——
它属于抽屉域，留在 S1 之外。

## 12. S4 施工书：第二引擎复核（6 函数 / 170 行，基线 `9e38260`）

落进**同一个** `page-detail-editor.js`（一个 section 一个 owner，S2/S3 已按这条走）。

**搬什么**（行号是 `9e38260` 实测；函数体行数合计 170）

```
activeAuxJob          735-745   11
openAuxWarning        747-764   18
waitForAuxThenReview  767-826   60
runAuxiliary         1273-1296  24
renderAuxiliary      1298-1348  51
setupAuxControls     1350-1355   6
```

### 12.1 状态归属（逐个核过读写点，不沿用旧归类）

```
auxData                 写 2：runAuxiliary:1283、closePageDetail:5274；**读 0**
                        ⇒ 死状态（全仓 3 处命中，没有一处是读）。本刀删：
                          模块里不留、closePageDetail 那行（5274）也删。
                          这是 S1 两个死注入之后同型的第三例——写点看着像"状态"，其实没人用。
auxWarningWaitToken     只被 waitForAuxThenReview 读写（:768 自增、:799/:821 比较）
                        ⇒ 随函数搬进模块（模块级变量），**不做外壳注入**。
currentProject          外壳状态 ⇒ 借（注入 getCurrentProject）
detailPageNo            外壳状态 ⇒ 借（注入 getDetailPageNo）
token                   局部变量
```

### 12.2 外部依赖：11 个外壳函数 + 2 处跨模块调用

```
外壳函数 11：apiJson · showError · setSaveState · loadPageDetail · engineState · openModal · closeModal ·
            openTaskDrawer · startTaskPolling · loadFinishSummary · enterReviewStep
跨模块 2 处（搬进模块后**必须转注入**，模块里不许直呼 window.X——那是 R6/R7 的那条线）：
  · waitForAuxThenReview:823  window.PagesView?.onAuxReviewFinished()
  · renderAuxiliary:1342     window.PageDetailEditor?.adoptLine(block, line_index, aux_text)（「采用这一路」按钮）
```

### 12.3 DOM 面：6 个 id 在子树内，5 个在子树外（这条决定形态）

```
在 #view-review 子树里（模块可 root.querySelector）：
  aux-panel · aux-run · aux-close · aux-lines · aux-summary · aux-hint
不在子树里（index.html:1521–1542 的 modal）：
  aux-warning-mask · aux-warning-title · aux-warning-text · aux-warning-wait · aux-warning-error
⇒ 这 5 个**必须由 init 注入**（一个 `getAuxWarningEls()` 返回这 5 个节点，照 getDetailCanvas 的形态）；
  模块里**不许出现这 5 个 id 字符串**，否则 S1/S3 的 id 归属闸会红（它们不在 EDITOR_IDS 里）。
  别选"把 modal 挪进 #view-review"：它是全屏遮罩，挪位置会改 z-index 栈。
```

### 12.4 接口面（预测，落盘时以导出面闸实测为准）

```
导出：openAuxWarning（showView 的 review 入口 :971 调它）
不导出：runAuxiliary / renderAuxiliary / activeAuxJob（只在模块内被调用）
        setupAuxControls / waitForAuxThenReview —— **前提是把 bind 搬进模块 init**：
          aux-run / aux-close 在子树内可直接 part() 绑；aux-warning-wait 等用注入的节点绑
  若图表决定"模态框的绑定留在外壳"，则这两者要导出；推荐前者（模块自洽，外壳不再摸 aux 逻辑）。
```

### 12.5 判据（**预测 → 落盘后实测**，两栏都留，别只留一边）

```
函数差集   预测 419 → 413 ｜ 实测 **416 → 410**（写书时基线抄错成 S2 的 419；S3 之后是 416）
           （恰这 6 个，新增 0）
app.js     预测 −190 上下 ｜ 实测 10,572 → **10,402（−170）**
deps       173 不变（实测 173）
模块       预测只写"实测" ｜ 实测 1,345 → **1,549**（代码 1,367 + 注释 83 + 空行 99）
三取法     实测仍 0（root.querySelector 2 处 · part( 51 处；没有新增 document 级查询）
R3 review  预测 **−5 种 / −10 处** ｜ 实测 54/127 → **49/117**（总数对，但**单项预测错了两处**）：
             · 消失的 5 种：aux-close / aux-hint / aux-lines / aux-run / aux-summary（各 1 处）
             · aux-panel：3 → **1**（预测写"仍有 1 处"结果没错，但没写清它是从 3 掉到 1）
             · page-detail-error：11 → **8**（预测写"仍有 11 处"是错的——那 11 是 S3 的数，
               runAuxiliary 里的 3 处随函数走了）
           ⇒ 教训：**总数对不等于单项对**；写书时单项数要标明"哪一个基线"，别混用 S3/S4。
闸         导出面每个都有调用点 · 注入双向对（传=读）· init 接线在 wired 守卫之后
真机       第二引擎面板：运行 → 逐行分歧 → 采用这一路（可撤销）→ 关闭 ·
           未跑完时的警告：等它跑完再进 / 跳过 / 取消（ego 恢复后补）
```

**落盘后与 §12.2 / §12.4 的两处偏差（以实作为准）**：`openModal` / `closeModal` 没用上——模块直接改
`els.mask.hidden`（外壳那两个函数就是 hidden 开关 + 两个面板特判，对 `aux-warning-mask` 等价）；
导出面净变化是 `+openAuxWarning −adoptLine`（adoptLine 唯一的外壳调用点在 renderAuxiliary 里，随它进了模块）。
