# 验收记录 2026-11-02：片 1（overlay registry）+ 刀 C（page-index）+ 刀 D（structure-tools）+ 清洗刀 + S1 + S2 + S3

> 规则（2026-11-02 定）：**通过 / 未验分开写**；未验必须写阻塞原因与证据位置。
> 只在对话里说“我跑过”按**未验**计；环境起不来同理。
> 验收人：DevLead（独立核，不与 Builder 共用读数）。

## 一、片 1：overlay registry（`20264a4`；`b050063` 上代码未变）

### 通过（代码层，DevLead 在 `20264a4` 独立核）

```
app.js 12,638；git diff f722096 20264a4 -- app.js = 0
page-tile.js 409；全仓 paintOverlays 0
preview-view.js 1,112；page-overlay / _renderedBlocks / renderPageBlocks 各 0
overlay-registry.js 264 = 194 代码 + 46 注释 + 24 空行；el( / getElementById( / querySelector( 各 0；
  window.OverlayLayer；findOrderSpot / layoutLabel / drawDiffLayer 各 0
酸测试 5/5 绿；DOMAIN_MODULES 已登记 overlay-registry.js → OverlayLayer
deps 173 · PagesView 36 · R3 total 0 / ids 0 · node 209/207/0/2
```

### 通过（真机，QA 读数；DevLead 未复跑浏览器）

```
490/490 页有 .overlay-layer、带 page-overlay--readonly、zIndex 全 "2"、pointerEvents 全 "none"
hits zIndex 3 > 2；console 0
20264a4..b050063 对 preview-view.js / page-tile.js / overlay-registry.js / app.css 的 diff 为空
  ⇒ 这些读数对 b050063 同样成立，不需要重跑
```

### 未验（阻塞：ego-browser 服务无响应）

```
· .box 的 pointerEvents 逐点
· 类型框色逐类型（heading/paragraph/figure）
· elementFromPoint 甲/乙两组
· 开关不复用（图层数不涨）
· 块框清单旧/新对比
原因：ego-browser 无响应（另一 Bot 会话占 18 分钟后服务未恢复，最小探针 90s/120s 不返回）；
      不重启共享 GUI，等用户在场。
证据位置：QA 报告（对话）+ 其产物目录；恢复后补测并按新证据追加本表。
```

## 二、刀 C：page-index 服务模块（`b050063`）

提交链：`6e9d495`（Temp-Relax 放宽笔）→ `003b787`（产品）→ `b050063`（收紧笔）。

### 通过（代码层，DevLead 独立核）

```
顶层函数 496 → 490，移出恰好：loadPageIndex / loadIndexBlocks / clearImagePlaceholder /
  loadImageQuality / setImageQuality / syncImageQualityUi，新增 0
四个 let（pageIndexData / pageIndexProject / pageIndexLoading / imageQualityMode）在 app.js 各 0 次；
  四个都在 page-index.js（:32/:34/:36/:38）
deps 173（键名与条数不变；getPageIndex* / loadPageIndex / loadIndexBlocks / clearImagePlaceholder /
  getImageQualityMode / setImageQuality 全部转发到 window.PageIndexService）
page-index.js 172 = 103 代码 + 50 注释 + 19 空行；el( / getElementById( / querySelector( 各 0；
  window.PageIndexService（11 个导出）
app.js 12,584（−54）；index.html:1859 在 app.js 之前
Temp-Relax 残留 0（boundary / test_ui_assets 各 0）
node 221 / 219 pass / 0 fail / 2 skipped；R3 total 0 / ids 0
```

### 判定：两条 python 断言是“搬运假红”，不是放宽

```
· "/page-index"：原查 app.js → 改查 page-index.js；**同一个字符串**，只是收窄到模块文件
· "function loadIndexBlocks("：改查 page-index.js 的 "function loadBlocks("（函数在模块里改名）；
  仍断言“实现存在”，且 app.js 的转发器另外由 deps 覆盖
JS 侧（index-view-behavior）是同一性质：loadApp require 去掉已搬走的函数、
resetState 重跑模块源码拿干净实例；新增 page-index.test.mjs 补三件服务语义
（块缓存只有一份 → 同页两次只发一次请求 / 并发 loadIndex 第二次仍 busy / 档位 radio 由模块同步）。
```

### 与书 §4 的一处偏离（更严，记录在案）

书里写 `init({ apiJson, getCurrentProject, getSettingsRoot })`、radio 由 root 子树查；
实际实现是 `getQualityRadios: () => document.querySelectorAll('input[name="reading-quality"]')`
——壳里按 **name** 查好把列表给模块，模块连 `querySelector` 都是 0 次（域模块闸零豁免）。
按 name 不按 id ⇒ R3 不新增引用（实测 0/0）。判为更好的形态，不回改。

### 未验（阻塞：ego-browser 无响应，同片 1）

```
· 档位 radio（三档切换后 setImageQuality / syncImageQualityUi 的实际显示）
· localStorage 保持（换档后重开仍在）
· 预览块框档位跟随（preview 的 getImageQualityMode 读数）
处理：已并入 QA 正在跑的同一轮；结论回来后在“真机”一节追加，未回前按未验。
```

## 三、刀 D：结构工具 → `structure-tools.js`（`24c8ea5`）

提交链：`b3105ba`（放宽笔：C 键 `onProjectPagesReloaded` 的 effective callers 先改登记）→
`e0a6dfb`（产品）→ `24c8ea5`（收紧笔：域模块闸的唯一例外 + 请求体对集 4 条）。

### 通过（代码层，DevLead 独立核）

```
基线 b050063 → 24c8ea5
app.js 12,584 → 12,426（−158）
顶层函数 490 → 483：差集恰 7 个、新增 0（口径：^(async )?function 名集合相减，行号为 b050063 的定义行）
  structureRules@1364 · previewHeaderFooter@1378 · renderStructurePreview@1401 ·
  updateStructureApplyState@1472 · applyHeaderFooter@1479 · setupStructurePanel@1515 · setAllStructureKeeps@1522
structureCandidates 在 app.js 0 次
structure-tools.js 271 = 220 代码 + 27 注释 + 24 空行
  （提交说明写 275，实测 271——以 wc -l + 三分解为准，275 作废）
模块 DOM 面（剥注释）：el( 0 · document.getElementById 0 · document.querySelector 0；
  只有 root.querySelector（:39 part()、:253 li.querySelector 读候选勾选态）
17 个 structure-* 被模块引用（value 7 + part 7 + bind 4，apply-btn 重复计数 1）
  #structure-panel 子树共 20 个 ⇒ 剩下 4 个 id 属外壳接缝：
  structure-panel / structure-close / structure-cancel / 入口 structure-open，
  app.js 里 4 个 id / 7 处引用（:1023、:1063、:1064、:1065、:11339、:11348、:12406），全是开合与 root 传递
reset 有 2 个真调用点：app.js:1023（closeModal）、app.js:2365（refreshProject）⇒ 收进接口面
index.html:1860（structure-tools.js）在 index.html:1861（app.js）之前
deps 173（window.PagesView?.init({ 的 4 空格 key 行；我的独立数法，与闸的分列无关）
四闸：node 225 / 223 pass / 0 fail / 2 skipped（45.6s）· pytest 1035 passed（123.27s，
  STATIC_DIR 打印为本 worktree 内）· R3 review 90 种 / 223 处（与 b050063 逐字相同）·
  contract-registry 465 笔 0 不合格 · audit_ui_asset_literals 会因搬运假红 0 ·
  Temp-Relax 代码 0（5 处全在 docs）
接口面 6 个：init / setup / preview / apply / setAllKeeps / reset
变异复跑：把 part() 的 root.querySelector 换成 document.getElementById ⇒ 只红域模块闸 1 条，
  报错原文「structure-tools.js 里出现 1 次 document.getElementById(——同上」；还原后 git diff 为空
```

### 例外裁决：`allowQuerySelector`（收，附两条限制）

```
闸里的唯一例外：{ structure-tools.js → StructureTools, allowQuerySelector: true }
  · 放行 root.querySelector（模块里 3 处，全在 #structure-panel 子树）
  · document.querySelector / document.getElementById / el( 在例外模块里仍然红
  · 三分支自检已带：root 绿 / document 红 / el( 红（boundary.test.mjs:5609 起）
裁决：**收**。书 §1② 本来就允许"在 root 子树内 querySelector"，闸此前比书更严；
  例外是把闸对齐书，不是给模块开后门。
两条限制已写进书 §7：
  ① 例外只给 structure-tools.js 这一个文件；
  ② 第二个模块要它 ⇒ 改书的规则并重审，**不许往 DOMAIN_MODULES 里加 allowQuerySelector 名字**。
机检（`b2a6bbb` 补上，原先的缺口已闭）：`DOMAIN_MODULES.filter(m => m.allowQuerySelector).length <= 1`，
  超了红并点名（我实测：给 page-index 也开例外 ⇒ 红「只许有 1 个模块（现在 2 个：page-index.js、structure-tools.js）」）。
```

### 三条真实性问题：已补，且变异双向成立（`abbab59` + `b2a6bbb`，DevLead 在落地树上复跑）

```
① afterApply 的观察——**先假绿、后真绿**，这一段是本轮最值钱的判据
  原状：structure-tools.test.mjs:5 声称「应用后 afterApply 必须被等一次」，但无断言；
        calls（:73/:99/:102）是死变量。
  第一版补法（Builder 的 4700074）：let afterApplied = false + 同步 fake ⇒ assert equal。
  我在独立 worktree 上实测：**把模块里的 await 去掉，4/4 仍全绿** —— 同步 fake 下"调没调 await"测不出来，
  断言话术与文件头都高于实际覆盖 ⇒ 退回。
  落地版（b2a6bbb）：fake 跨一个宏任务
      afterApply: async () => { await new Promise((r) => setTimeout(r, 0)); afterApplied = true; }
  我在 b2a6bbb 的工作树副本上复跑：
      正树                              4/4 绿
      变异（模块去掉 await injected.afterApply()）3 绿 1 红，红的正是 ②「应用后必须等 afterApply 完成」
      还原后                            4/4 绿、git diff 空
  ⇒ 这一条现在真的锁"等完成"；文件头第 5 行「必须被等一次」成立（话术没放宽）。
② structure-tools.js:6 头注释的 notify ⇒ 已删（abbab59：产品文件仅此 1 行注释改动）。
③ 闸缺口 ⇒ 已补（b2a6bbb，照刀 B 的形态：沙箱执行后对 api 集，不读文本）：
   · moved 7 名逐个断言 app.js 里不再定义
   · api 恰好 6 个（含 reset），并断言 app.js 里 window.StructureTools?.reset() ≥ 2 处
   · 额外补了「allowQuerySelector 的模块 ≤1 个」（超出我的要求，原是我列在例外裁决里的缺口）
   我的复跑变异（都在 b2a6bbb 的副本上，还原后 diff 空）：
     app.js 末尾加 function previewHeaderFooter(){}   ⇒ 红 1 条「app.js 里还定义着 previewHeaderFooter」
     api 里删掉 reset                                  ⇒ 红 1 条「接口面必须恰好是 …」
     DOMAIN_MODULES 里给 page-index 也开 allowQuerySelector ⇒ 红 1 条「只许有 1 个模块（现在 2 个：…）」
四闸（b2a6bbb，独立 worktree，STATIC_DIR 在树内）：node 226 / 224 pass / 0 fail / 2 skipped ·
  pytest 1034 passed（129.08s）· 产品代码在这些笔里零差异（abbab59 只动 1 行注释，b2a6bbb 只动 tests/js）
注：pytest 从 1035 降到 1034 是清洗刀的测试侧 `ea8b80c` 删掉一条已退役能力的用例，不是回归。
```

> 记账（2026-11-02 04:0x）：这一节在 `87135b7` 写完，Chief 合 `38caf8d` 时只 pick 了后者，
> 于是 main 上一度同时存在「结论说已补」与「小节说待补」两句矛盾的话；本笔按 `87135b7` 的原文补回。
> 教训：**报待集成时要把自己所有未合的 sha 列全**——我当时只写了 `38caf8d`，漏了 `87135b7`。

### 撤销完整性：通过（接口路径，两本项目，QA 留档）

```
判据 = **逐块对基线**，不是候选数（候选数会被"应用态"误导，见下）。
证据：tests/e2e/artifacts/2026-11-02-structure-undo/（b2t_T7JH61，提交 b58616b）
      tests/e2e/artifacts/2026-11-02-structure-undo-brrbr0/（b2t_BRRBR0，提交 e373d6e）
方法：库整份复制到 /tmp + 独立端口跑；原件库只读，事后逐项相同。四步全 HTTP：
      基线(block_id→block_type) → preview → apply(只 high) → review/undo → 再 preview → 逐块对基线

b2t_T7JH61  基线 1233 全 paragraph
  preview 121（pn 45 / hdr 75 / ftr 1；high 112）→ apply 112（88 页）
  → undo 112/112 回基线（missing 0 / wrong_type 0）→ 再 preview 121（45/75/1，与 N0 逐项相同）
b2t_BRRBR0  基线 1780 全 paragraph
  N0 380（hdr 235 / ftr 2 / pn 143；high 372 / review 8）→ apply 372（241 页）
  → N1（应用后立刻预览）8 → undo 372 → N2 380（与 N0 逐项相同）
  → 逐块对基线：applied 372 / restored 372 / not_restored 0

「撤销后只剩 8 个候选」的定性：**读了应用态，不是缺陷**。
  380 − 372 = 8，正是未勾选的 review 级候选；应用后那 372 块已不是 paragraph，自然不再是候选。
  根因在测试方法：扫按钮取首个含「撤销」的（点到了 #review-undo）、sleep 2500ms 即读 ⇒ 读到应用态。
  （流程问题另记 L-114：同屏两个「撤销」，按文字找会点错。）
注：T7JH61 的 result.json 里还留着一条口径写反的旧 verdict（"候选里又出现 paragraph 块 = 缺陷"），
  随即被同文件的 verdict_corrected 改正——留旧值是有意的，对照时看 verdict_corrected。
```

### 真机 UI 路径：未验（ego-browser 无响应）

```
Builder 的 CDP 读数（打开面板 / 预览 380 / 应用 372 / 抽查第 3 页 24 块回 paragraph）无留档 ⇒ 未验；
  留档的只有上面那组接口路径读数（QA）。
未验：真机上点「应用标注」→ 点面板内「撤销」→ 类型色与块框回到原样。
原因：ego-browser 服务无响应，等用户重启；不重启共享 GUI。
```

## 四、清洗刀：删页内差异队列 / 块级候选对比 / 4 个零引用 id（`02213d8`）

提交链：`ea8b80c`（测试侧先挪 headline 断言、再删已退役用例）→ `e26382a`（补两条随删除退役的静态断言）
→ `ed50580`（产品）→ `02213d8`（闸：退役 id / queue-mode 三处归零 + 保留项仍在）。

### 通过（代码层，DevLead 独立核）

```
基线 b2a6bbb → 02213d8
app.js 12,426 → 11,743（−683）
顶层函数 483 → 458（−25），新增 0 —— 差集逐个对上：
  队列 19：queueHasPendingItems / buildDiffQueue / queueCounts / nextPendingQueueIndex / queueDotFor /
           renderQueueFooter / renderDiffQueue / focusQueueItem / initDiffQueue / applyQueueAckLocally /
           ackQueueLine / adoptQueueCurrent / keepQueueCurrent / previousQueueItem / setQueueOpen /
           focusQueueBar / captureQueueSnapshot / restoreQueueAfterUndo / stepReviewDiff
  候选 6：openCandidateCompare / renderCandidate / fillCandidateColumn / candidateBlockActions /
          applyCandidateBlock / decideCandidate
index.html 1,863 → 1,813（−50）· app.css 2,818 → 2,773（−45）
queue-mode：app.js 0 / index.html 0 / app.css 0（三处单独判）
reading-view.js：git diff b2a6bbb 02213d8 为空（未动）
renderReviewHeadline 仍在（3 处命中，队列判断已随删消失）
R3 review：90 种 / 223 处 → **71 种 / 181 处**（与书里原写的 68/194 不符 —— **期望值错，不是实现错**，
  已在书 §5① 写明口径：4 个零引用 id 本来就不进 R3 计数，种数只消失 19；处数 −42 ≠ −29，
  因为删掉的函数内部对同一 id 有多处引用）
deps 173 不变 · R3 pages 0/0 · registry 0 笔不合格
node 228 / 226 pass / 0 fail / 2 skipped · pytest 1034（119.52s，STATIC_DIR 在树内）
  （1035 → 1034 就是删掉的那条队列测试，不是回归）
audit_ui_asset_literals：会因搬运假红的源码字面量 0
被删的 25 个名字在新树全仓残留 0；被删的 8 个 id 在 static JS 里残留 0
```

### 通过（附带：清洗刀影响面的复核，供 S1 使用）

```
函数体被改过的**非删除**函数共 9 个（Chief 的清单是 8 个，漏了 setupViewerTools 48→42）：
  setupViewerTools 48→42 · setupReviewControls 136→100 · drawDiffLayer 94→92 · renderPageDetail 77→70
  loadPageDetail 27→23 · reviewAction 22→18 · closePageDetail 10→7 · openTreeItem 20→8 · runPageAux 7→5
落在 S1 的 24 个里只有 reviewAction（22→18，去掉的全是队列内部调用）⇒ S1 的接口面（T 键）不跟着减。
S1 重贴见 docs/refactor/review/page-detail-console-plan.md §11（24 个函数逐个起止行，合计 851）。
```

### 未验（真机，ego-browser 无响应）

```
· 页头不再有「差异 N」按钮
· 块内差异条仍可采纳 / 保留
· ⋯ 菜单不再有「对比新结果」
· 「重新识别」仍在
· 左树点击仍跳页
· reading 键盘裁决仍可用（Enter=保留 / Space=采用候选；review 侧 ⌫ / ← / [ ] 已随删消失，另记 known-limitations）
原因：ego-browser 服务无响应，等用户重启；不重启共享 GUI。
```

## 五、S1：块列表编辑 → `page-detail-editor.js`（`80f3a2b`）

提交链：`dafd9f0`（测试侧放宽：块编辑断言合查 app.js + 新模块）→ `0429e72`（产品）→
`fc1ed6a`（两处收口：子树查询走 root、注释不再写 showError(error)）→ `80f3a2b`（两道闸）。

### 通过（代码层，DevLead 独立核）

```
基线 02213d8 → 80f3a2b
app.js 11,743 → 10,910（−833）
顶层函数 458 → 434：移出恰 24 个（与书 §11 的表逐名相同）、新增 0
  applyDetailSuggestions refreshDetailSuggestions blockNeedsReview suggestionHighList pageNumberHintChip
  blockSuggestionBadge adoptBlockSuggestion adoptAllHighSuggestions blockCard blockDivergenceSection
  diffCompareLines diffRowFragment truncate autoSizeTextarea renderReviewBlocks selectReviewBlock
  focusSiblingBlock scheduleBlockSave flushPendingSave adoptLine patchBlock captureEditorFocus
  restoreEditorFocus reviewAction
page-detail-editor.js 989 = 875 代码 + 50 注释 + 64 空行
模块 DOM 面（**已剥注释**）：el( 0 · document.getElementById 0 · document.querySelector 0
  （裸 grep 的 2 个 `el(` 是 `Label(`/`Panel(` 的子串，不是调用）
  **root 级查询 2 处**（:27 part()、:388 菜单清理）——Chief 先前报 3 处是把 :6 注释里那句
  「只 root.querySelector」也数进去了；去注释后是 2 处（这条就是"数之前先剥注释"的实例）
  另有 4 处**元素级** querySelector（:369/:786/:792/:795/:891，都在已取到的子树节点上）
3 份状态跟随搬：detailSuggestions / reviewPendingSave / reviewSaveTimer 在 app.js 各 0 次
deps 173 不变 · index.html:1811（模块）在 :1812（app.js）之前
接口面 20 个（沙箱执行后 Object.keys 实测）：init · renderBlocks · setFilter · setPackageModeChrome ·
  showError · openBoxCreate · cancelBoxCreate + 13 个有真调用点的（行号见书 §3.1）
注入：init 传 48 个键，模块实际读 46 个 = 26 函数 + 7 常量表 + 13 状态访问器；
  **2 个死注入**：getActiveReviewBlockId / PAGE_TYPE_LABELS（传了 0 读，R13 反向查不到）
R3 review：71/181 → **69/165**（期望值已写进本表：2 个 id、16 处引用随 24 个函数进模块；
  这是"随函数搬家"的预期变化，不是新增引用）
R3 pages 0/0 · registry 0 笔不合格（481 笔）
node 232 / 230 pass / 0 fail / 2 skipped · pytest 1034（121.88s，STATIC_DIR 在树内）
```

### 未验（真机，ego-browser 无响应）

```
· 块列表编辑（点块 → 改文字 → 保存 → 重开还在）
· 框选新增块（框选 → 草稿 → 识别 → 新块出现）
· 版面确认（确认动作 / 建议一键采纳）
· 第二引擎复核（aux 面板逐行 / 收尾后刷新）
原因：ego-browser 服务无响应，等用户重启；不重启共享 GUI。
```

### 裁决（Chief 2026-11-02）：登记 + 具名白名单 + 完整性检查

```
事实：page-detail-editor.js 是第二个 root 宿主型服务模块（root = #view-review），
  但它没登记进 DOMAIN_MODULES ⇒ 域模块闸根本没查过它（三取法 0 靠 S1 自己那条闸）。
  这比"例外太多"更严重：**不登记就逃过闸**。

裁决（三条，TestDev 落 `tests/js/boundary.test.mjs`）：
  ① 登记：{ file: "page-detail-editor.js", exposes: "PageDetailEditor", allowQuerySelector: true }
  ② 把"allowQuerySelector ≤1 个"换成**具名白名单恰好两个文件**：
     structure-tools.js / page-detail-editor.js，双向对集（带标记却不在白名单 → 红；
     白名单里有空壳 → 红）。第三个要 root ⇒ 必须同时改白名单与书。
  ③ **新增完整性检查**：static/*.js 里凡是声明 `window.X = api` 的文件，必须在 DOMAIN_MODULES
     或 NON_DOMAIN_MODULES 之一，缺一个就红并报文件名（`*-view.js` 按后缀排除）。
     NON_DOMAIN_MODULES 逐条写理由：page-tile.js（组件，无 init(root)）、step-timing.js（纯计时，0 DOM）。
     ⇒ "新写一个模块忘了登记"不再能悄悄发生。
  自检三条：删登记 ⇒ 红并点名；白名单加第三个 ⇒ 红；static/ 里造 fake-module.js ⇒ 红并报它。
```

### 已落：`b34384f`（TestDev；进 main 时合为 `60fe297`，只动 `tests/js/boundary.test.mjs`，+154 −10）

```
做的是两件事（比原来"allowQuerySelector ≤1 个"强的地方：加第三个必须显式改名单和书）：
 ① 具名白名单 ALLOW_QUERY_SELECTOR_WHITELIST = structure-tools.js / page-detail-editor.js，**双向对集**
 ② 登记完整性：static 下每个挂 window.X = api 的文件必须在 DOMAIN_MODULES 或 NON_DOMAIN_MODULES 之一
    （*-view.js 按后缀排除）；NON_DOMAIN_MODULES 两条带理由（page-tile.js / step-timing.js）
 四条自检：删登记 ⇒ 红并点名 · 白名单加第三个 ⇒ 红 · 制造假模块文件 ⇒ 红并报文件名 · 两张表互斥 ⇒ 红
node 235 / 233 pass / 0 fail / 2 skipped（基线 232/230/0/2；+3 条测试，自检挂在既有 test 里不额外计数）
三条变异我自己重跑，不是转述：
 (a) 删掉 page-detail-editor.js 的登记 ⇒ 红 2 条：
     「白名单里的 page-detail-editor.js 不是已登记的域模块——白名单不许留空壳」
     「…既不在 DOMAIN_MODULES 也不在 NON_DOMAIN_MODULES——没登记就不受域模块闸检查，绿是假的」
 (b) 白名单加第三个 tool-x.js ⇒ 红 1 条，点名 tool-x.js
 (c) 造 static/fake-module.js（window.Fake = api）⇒ 红 2 条：R7b 报它没进 index.html +
     登记完整性报它的文件名（两条独立咬住）
实现细节两条（我核过）：① "空列表 ⇒ 红"排在"两张表互斥"之后，否则 files:[] 永远到不了互斥那支；
② ALLOW_QUERY_SELECTOR_WHITELIST 带 _WHITELIST 后缀，自动进 GATE_SWITCHES，source 只写来源、没抄现值。
还原后 git status 干净；产品代码零差异。
```

## 六、S2：框选新增块 + 漏行条 → 同一个 `page-detail-editor.js`（`33e5261`）

提交链：`e45eae9`（补合 S1 借用状态判据）→ `5ce7850`（测试侧：框选/漏行断言合查模块；id 归属表按 S2 挪三件）
→ `33e5261`（产品）。

### 通过（代码层，DevLead 在独立 worktree 独立核）

```
基线 80f3a2b → 33e5261
app.js 10,910 → 10,660（−250）
顶层函数 434 → 419：移出恰 15 个（与书 §1 的 S2 清单逐名相同）、新增 0
  setBoxCreateMode normalizedPoint onBoxMouseDown onBoxMouseMove onBoxMouseUp boxDraftRect drawBoxDraft
  createBlockFromBox inkGapBarVisible loadInkGaps renderInkGapBar drawInkGapMarks startRegionRecognition
  recognizeBoxRegion setupBoxCreate
模块 page-detail-editor.js 989 → 1,265 = 1,119 代码 + 63 注释 + 83 空行
15 个函数在模块里的函数体合计 238 行（书原写 240；−2 是 setupBoxCreate 17 → 15，
  canvas 改走 injected.getDetailCanvas() 注入，不再是 el("detail-canvas")）
三取法（剥注释）：el( 0 · document.getElementById 0 · document.querySelector 0
  root.querySelector 2 处 · 元素级 querySelector 8 处
canvas：模块里 2 处 injected.getDetailCanvas()（:1071 / :1104），外壳 app.js:10589 给的是 () => el("detail-canvas")
wired 幂等守卫在 :1214（let wired = false）/ :1221（if (!wired)）：重复 init 不重复绑
deps 173 不变
接口面 23 个（沙箱执行 Object.keys 实测）= S1 的 20 + setBoxCreateMode / loadInkGaps / setupBoxCreate
  ⚠ 其中 setupBoxCreate **没有外部调用点**（只有模块内部 :1223 调），按 §1 ⑦ 应删（已告 Builder 并在 S3 顺手删）
注入：init 传 56 个键，模块实读 54 个 —— **S1 那两个死注入仍未清**：
  getActiveReviewBlockId / PAGE_TYPE_LABELS（传了 0 读；已第二次提醒 Builder 在 S3 一起删）
R3 review：69/165 → **58/134**（−11 种 / −31 处，随 15 个函数进模块；书里没写 S2 的期望值，本表补上）
R3 pages total 0 / ids 0 · registry 0 笔不合格（485 笔）
node 234 / 232 pass / 0 fail / 2 skipped · pytest 1034（125.09s，STATIC_DIR 在树内）
```

### 未验（真机，ego-browser 无响应）

```
· 框选新增块：框选 → 草稿 → 确认 → 「识别这块」→ 新块出现且类型正确
· 漏行条（ink-gap）：开关、按页渲染、点「识别」后新块出现
· 框选模式下拖动与取消（Esc / 取消按钮）
原因：ego-browser 服务无响应，等用户重启；不重启共享 GUI。
```

## 七、S3：版面确认 + 建议工具 → 同一个 `page-detail-editor.js`（`9e38260`）

提交链：`e64f7fd`（id 表挪一件）→ `9a6beee`（pytest 三条断言合查模块）→ `ff7ba30`（产品）→
`d502797`（`suggestionHighList` 移出导出面）→ `9e38260`（三道闸）。**`60fe297` 是域模块闸那笔（TestDev 的
`b34384f`）**，与 S3 同批进 main。

### 通过（代码层，DevLead 在独立 worktree 独立核）

```
基线 33e5261 → 9e38260
app.js 10,660 → 10,572（−88）
顶层函数 419 → 416：移出恰 3 个（confirmPageLayout / renderLayoutPanel / renderSuggestionTools）、新增 0
模块 1,265 → 1,345 = 1,186 代码 + 72 注释 + 87 空行
三取法（剥注释）：el( 0 · document.getElementById 0 · document.querySelector 0
  root.querySelector 2 处 · part( 43 处
deps 173 不变
导出面 **20 个**（沙箱执行 Object.keys），我逐个核过：**每个都有 app.js 调用点**（闸也这么判）
  删掉的 5 个：showError / openBoxCreate / cancelBoxCreate / setupBoxCreate / suggestionHighList
  （后两个分别是我在 S2 复核时抓的"无外部调用点"与"搬完就没人喊"）
注入：init 传 53 个键、模块实读 53 个 —— **两个死注入已清**（getActiveReviewBlockId / PAGE_TYPE_LABELS）
init 幂等：`if (wired) return api; wired = true;` 之后才是 setupBoxCreate + 全部 bind（这条做成了闸）
R3 review 58/134 → **54/127**（−4 种 / −7 处）· pages 0/0 · registry 0 笔（490 笔）· audit 假红 0
node **241 / 239 pass / 0 fail / 2 skipped**（合了 60fe297 之后的数；Builder 报的 238/236 是它自己分支
  未含 TestDev 那 3 条闸时的读数）
pytest 1034（142.15s，STATIC_DIR 在树内）
```

### 三道闸的变异我实跑（不是转述）

```
① 把 suggestionHighList 塞回 api          ⇒ 红：「api.suggestionHighList 在 app.js 里一次都没被调用」
② 在 PageDetailEditor 的 init 块塞 getActiveReviewBlockId ⇒ 红：「boot 注入了 … 模块一次都没读——死注入」
③ 把 bind("early", …) 挪到 wired 守卫之前 ⇒ 红：「init 的接线跑在 wired 守卫之前」
三支还原后各自转绿；我第一版把 ② 的变异插进了 PagesView 的 init 块（红的是刀 11 那条），
说明"变异插错块 = 测错对象"，已按 PageDetailEditor 的块重做。
```

### 未验（真机，ego-browser 无响应）

```
· 版面确认面板：确认动作 / 建议一键采纳
· 建议工具（rendering tools）在面板里的显示与交互
原因：ego-browser 服务无响应，等用户重启；不重启共享 GUI。
```

## 八、结论

```
片 1：代码层通过；真机部分通过、5 项未验（ego 阻塞）
刀 C：代码层通过；真机 3 项未验（ego 阻塞）
刀 D：代码层通过（含唯一例外裁决 + 例外唯一性的机检）· 撤销完整性通过（接口路径、两本项目）·
      三条文档/测试真实性已补（abbab59 + b2a6bbb），三条断言我都做过"喂坏样本必须红"的复跑；
      真机 UI 路径未验（ego 阻塞）
清洗刀：代码层通过（含 R3 期望值更正与影响面复核）；真机 5 项未验（ego 阻塞）
S1：代码层通过（24 函数差集逐个对、模块 989、接口面 20、注入 48→读 46）；真机 4 件未验（ego 阻塞）
S2：代码层通过（15 函数差集逐个对、模块 1,265=1,119+63+83、接口面 23 但 setupBoxCreate 无外部调用点、
    2 个死注入未清）；真机 3 件未验（ego 阻塞）
S3：代码层通过（3 函数差集、模块 1,345=1,186+72+87、导出面 20 且每个有调用点、注入 53=53、
    wired 守卫在、R3 54/127）；三条闸我都实跑变异；真机 2 件未验（ego 阻塞）
七把刀都是“代码可结、真机未结”——验收表按此口径引用，不得写成“全部通过”。
```
