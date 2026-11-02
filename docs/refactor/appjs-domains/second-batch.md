# ③ 第二批施工书：导出 · 协作 · 跨视图服务（草案，等 Chief 批）

> 上位：`appjs-domain-map.md`（域划分与风险分档）· `overlay-registry-contract.md`（服务模块形态）·
> `first-batch.md`（刀 A–D 的模块形态与闸）。
> **基线 = 开工时那棵树**：本文写于 `dde778d`，app.js **10,169** 行 / **402** 个顶层函数 / deps **171**。
> 行号只作对照，开工第一件事是**按 §1 的名单重贴**（段头不可靠——见 §1.0）。

## 0. 顺序与理由（**Chief 2026-11-02 定稿：复杂度递增**）

```
导出（16 函数 / 491 行 · 单宿主） → 跨视图服务（16 / 223 · 多宿主 3 个）
  → 协作（22 / 426 · 多宿主 + 13 处写盘）
```

理由（按"宿主形态的复杂度"，不按行数）：

```
① 导出只有一个宿主（31 个 id 里 30 个在 #view-merge，1 个在 chrome）：先做它，
   验证"merge 视图的服务模块"长什么样，代价最低、纠错最便宜。
② 跨视图服务是**多宿主**（7 merge + 4 chrome + 1 review，11 个入口横跨 5 个视图）：
   它在第二刀，把"多宿主 + 按事件命名"这条形态定下来；协作随后照着做，不用再发明一次。
③ 协作最贵（多宿主 + **13 处写盘**）：放最后，因为"请求→读回→重画"闭环要在前两刀验证过的注入表上做，
   而不是边搬边发明接口。13 处写盘是本批唯一真正练"能力键 vs 状态访问器"的地方。
依赖方向不影响顺序：导出依赖跨视图服务的 marginJudgementOn（exportScopeText）——
  第一刀时这条以"外壳注入"存在；第二刀搬完，接线从"外壳函数"换成"模块导出"，
  **仍然是外壳注入，不是两个模块直呼**（R6/R7 那条线）。
```

**不可并行**：三块都动 app.js 与 merge 视图；`协作` 与 `导出` 共享 `refreshExportPreflight` 所在的那一段。

## 1. 三个域的实测（**按函数归属，不按段名**）

### 1.0 为什么不能按段头量

`app.js` 的段头（`// ---- 名字`）已经不准确：`exportOptions`（1187）与 `refreshExportPreflight`（1387）
落在"结构工具"那段里（那段现在只剩三行注释），而它们明明是导出域的。
**本节的名单是唯一口径**；段头只用来找位置。**"按归属判，不按段名判"是默认口径，不是特例**：
同一条规则已经用过五次——`openPageSetup`、`layoutBlockPageRecord`、页面块缓存簇、S1 的状态归属、
以及这里的 `exportOptions` / `refreshExportPreflight`。以后看到"函数不归这个段"先别惊讶，按归属写。
三条硬规矩（上一批吃过的亏）：

```
· 名单是"函数名 + 行范围 + 行数"，不报总数
· 状态按**声明行**归属（域的状态就声明在域的第一段头前一行）；不按"函数里用到了"判
· id 按 **index.html 的 view section** 归属，按 `el("id")` 取；不按命名前缀
```

### 1.1 导出（16 函数 / 491 行；span 1187–1701）

```
函数（行数）：exportOptions 32(1187-1218) · renderPreflight 166(1220-1385) · refreshExportPreflight 23(1387-1409)
  · exportScopeText 15(1412-1426) · loadExportPreview 12(1435-1446) · renderCompare 52(1448-1499)
  · selectSegment 18(1501-1518) · loadComparePage 29(1521-1549) · drawCompareOverlay 18(1551-1568)
  · schedulePreflight 6(1570-1575) · runExport 23(1577-1599) · renderExportRecord 22(1601-1622)
  · loadExports 11(1624-1634) · renderExportHistory 22(1636-1657) · revealExport 10(1659-1668)
  · setupExportPanel 32(1670-1701)
自己状态 5：lastExport(1183) · exportPreviewTimer(1184) · compareSegments(1430) · compareIndex(1431)
  · comparePageBlocks(1433, const Map)
外来状态 2：projectExports · currentProject
外部函数 7：apiJson · showError · fillDefinitionList · syncWorkflowSteps · parsePageRange ·
  marginJudgementOn · setMarginJudgementSetting
el( 50 次 / 31 个 id：**30 个在 #view-merge**，1 个在 chrome（margin-judgement-notice-ok）
写盘 6：preflight / export / history / compare-page
视图入口 2：exportOptions ← preview-view.js · reading-view.js（注意：是**被视图调**，不是调视图）
```

**形态**：`export-panel.js`（`window.ExportPanel`），`init({ root: #export-panel, … })`
——**不是 `#view-merge`**（Builder 按 index.html 真实嵌套量出来的，我复核过）：

```
#view-merge 的 span = 43525–45414（1900 字符），里面只放合并视图的静态内容
30 个导出 id 与 #export-panel 本体全在顶层 mask `<div class="mask" id="export-panel">` 56502–62971
⇒ 在 #view-merge 子树里的导出 id = **0 个**（按旧书写法建归属表，并集会立刻是空集）
root = #export-panel（modal 本身）⇒ 30 个 id 全在它子树里，并集 == 子树，归属表可建
chrome 里只剩 1 个：margin-judgement-notice-ok ⇒ 注入节点（与 currentProject 一样走注入）
```

**通则（写进三批共用，别每刀现议）**：

> **服务模块的 root 是它真正拥有的那块 DOM，不是它看起来所属的视图。**
> 判据：那个 root 的子树里，模块要写的 id **并集 == 子树被引用的 id 全集**（能建归属表）；
> 若某视图子树里"看起来该归它"的 id 实际是 0 个，说明它根本不是那个视图的东西。

同形先例：`structure-tools.js` 的 root 也是 mask（`#structure-panel`），不是 `#view-pages`。
两处都是"挂在某个视图概念下、实际住在顶层 mask 里"——**别按名字猜归属，按 index.html 的嵌套量**。
**难点**：`renderPreflight` 166 行（全仓最大的单函数之一）——它同时写 12 个 id 与 2 段状态，
搬之前先问"它是不是两个函数"（预检结果 vs 规则说明），别整块搬进去再拆。

> **已拆（`ed2e724`，`wt/builder`，行为零变化；合入前以 main 为准）**——DevLead 的判定：
> **`renderPreflight` 是一个纯装配 + 一个薄写手**：
> ```
> preflightRows(data)    67 行  纯：算出那 12 行预检行（不碰 DOM）
> preflightNotes(data)   99 行  纯：算出提醒文案（不碰 DOM）
> renderPreflight(data)   7 行  薄写手：fillDefinitionList + 挂提醒
> ⇒ 166 → 7 + 67 + 99（三个签名与 return 让总行数比原来多一点，属正常）
> ```
> 所以 1.1 那条"别整块搬进去再拆"的顾虑消失了：**按三个函数搬**，
> 两个纯函数可以直接单测（这也正是拆的理由——166 行的函数没法喂数据进去验）。

### 1.2 协作（22 函数 / 426 行；span 8720–9182）

```
函数：assignRequestBody 7 · openAssignPanel 11 · previewAssign 22 · renderAssignPreview 27 ·
  createAssignment 25 · loadAssignments 10 · renderAssignments 63 · downloadPackage 18 · rebuildPackage 12 ·
  revealPackage 11 · cancelAssignment 16 · saveBlob 10 · setupPackageControls 10 · openPackageFile 24 ·
  applyPackageMode 43 · loadPackageResults 25 · exportResultPackage 24 · downloadResultPackage 11 ·
  pickResultFile 4 · onResultFileChosen 33 · setupCollabControls 15 · toggleAssignList 5
自己状态 4：assignPreviewData(8716) · currentAssignments(8717) · mergeState(8718) · packagePending(8966)
外来状态 1：currentProject（`project_id` 是属性、`setSaveState` 是动作，都不算状态——别混）
外部函数 8：apiJson · showError · showView · syncWorkflowSteps · closeModal · refreshPageStates ·
  setSaveState · closeFinishPanel
el( 57 次 / 25 个 id：**20 在 #view-merge · 5 在 chrome/review**
  （open-package · open-package-file · package-banner · package-open · finish-open-review）
写盘 **13**（全仓第二多）：分派预览 / 建分派 / 列表 / 任务包下载 · 重建 · 取消 / 结果包导入 · 导出 · 下载
视图入口 3：openAssignPanel ← pages-view.js · loadAssignments ← merge-view.js · toggleAssignList ← pages-view.js
```

**难点（也是本批最贵的一刀）**：

```
① 13 处写盘 ⇒ 接口必须按**动作**命名（不准给 setter）。每个动作内部"请求 → 读回 → 重画"闭环，
   外壳不参与顺序编排（`knife-numbering.md` §七）。搬之前先列"每个动作读回之后要重画什么"。
② 三个子簇（分派 assign / 任务包 package / 导入 result）共享 mergeState 与 packagePending；
   先按子簇列名单（§1.2 的行号），再决定是"一个模块三个子域"还是"两个模块"——
   **默认一个**：拆两个会出现两份 mergeState 读取（两套路径），正是契约 §1 禁止的。
③ 5 个 chrome id 分散在工具栏与 finish 面板 ⇒ 多宿主：root=#view-merge + 注入 5 个节点
   （照 getAuxWarningEls 的形态，**模块里不许出现这 5 个 id 字符串**，否则 id 归属闸红）。
```

### 1.3 跨视图服务（16 函数 / 223 行；span 8351–8602）

```
函数：marginJudgementOn 5 · applyProjectSettings 13 · renderMarginJudgementNotice 6 ·
  dismissMarginJudgementNotice 14 · autoApplyTypeText 6 · loadAutoApplyStatus 31 · showNoticeBar 6 ·
  showAutoApplyNotice 7 · hideAutoApplyNotice 3 · refreshAfterTypeChanges 10 · undoAutoApply 18 ·
  notifyApplied 5 · setMarginJudgementSetting 18 · openSuggestionApplyPanel 24 ·
  renderSuggestionApplyPreview 28 · runSuggestionApply 29
自己状态 3：suggestionApplyPlan(8344) · latestAutoApply(8346) · autoApplyAnnouncedId(8348)
外来状态 2：currentProject · detailPageNo（`el` 是 DOM 助手、`BLOCK_TYPE_LABELS` 是常量表，
  都不算状态；常量按值注入，DOM 由模块自己在 root 子树里取）
外部函数 10：apiJson · showError · openModal · closeModal · refreshExportPreflight ·
  renderRecognitionSettings · forgetPageBlocks · refreshPageStates · loadPageDetail · setSaveState
el( 25 次 / 12 个 id：**7 在 #view-merge · 4 在 chrome · 1 在 #view-review**
  （margin-judgement-notice · auto-apply-notice(-text) · auto-apply-undo · page-detail-error）
写盘 6：采用状态 / 摘要 / 全库采用 / 撤销 / 版心判定设置
视图入口 **11 个**（5 个视图）：applyProjectSettings(library/pages) · autoApplyTypeText(pages) ·
  loadAutoApplyStatus(library) · showNoticeBar(index/preview/reading) · undoAutoApply(pages) ·
  notifyApplied(pages) · setMarginJudgementSetting(pages) · openSuggestionApplyPanel(pages)
```

**形态（本批唯一需要新设计的一块）**：它不是"一个 section 的服务"，是**跨 5 个视图的流程**。
建议 `suggestion-flow.js`（`window.SuggestionFlow`），只拿 3 个宿主：`#view-merge`（建议面板）、
chrome 的通知条容器、`#view-review` 的 `page-detail-error`；其余 11 个入口按**事件**命名，
**不许**变成"谁都能喊一下刷新"（§6 ⑧ 神入口判据）。若量下来发现"通知条 / 自动应用状态 / 建议面板"
三簇之间只共享 1–2 个状态，就拆成两个模块（通知条 + 建议流程），**但同一簇内不许两份实现**。

## 2. 接口面与注入（预测；落盘时以闸实测为准）

```
共同：init(deps)；导出面只放"有调用点"的成员（刀 A 的规矩），没调用点的不导出（宁可先不搬）

导出 export-panel.js
  L init · T setupExportPanel（boot 调）· T refreshExportPreflight（外壳 3 处调：onProjectPagesReloaded /
    afterCleanupApplied / 收尾）· T exportOptions（preview/reading 注入调用）· T revealExport?（看调用点）
  **新增 T `reloadPanel()`（Chief 2026-11-02 批）**：外壳今天有两句连排 `refreshExportPreflight(); loadExports();`
    ⇒ 收成一个模块动作（内部**先预检、后历史**），外壳只喊一次。
    理由：**外壳不许编排模块内的出图顺序**（第二批书 §1.2 那条硬要求的同一句话）。
    外壳的调用点变成 `exportPanel.reloadPanel()` 一处；两句的顺序与并发细节归模块。
  C 0（不调别的模块）
  注入：root · getCurrentProject · apiJson · showError · syncWorkflowSteps · parsePageRange ·
        fillDefinitionList · marginJudgementOn（来自外壳；跨视图服务搬完后改指模块导出）·
        setMarginJudgementSetting · getProjectExports · getLastExport/setLastExport（如果外壳还要读）

协作 collab.js
  L init · T openAssignPanel · T loadAssignments · T toggleAssignList · T applyPackageMode · setupCollabControls
  注入：root · apiJson · showError · showView · closeModal · syncWorkflowSteps · refreshPageStates ·
        setSaveState · closeFinishPanel · getCurrentProject · getMergeState/setMergeState ·
        getAssignPreviewData/setAssignPreviewData · getCurrentAssignments/setCurrentAssignments ·
        getPackagePending/setPackagePending · 5 个 chrome 节点（一组 getter）

跨视图服务 suggestion-flow.js
  L init · T applyProjectSettings · T autoApplyTypeText · T loadAutoApplyStatus · T showNoticeBar ·
    T undoAutoApply · T notifyApplied · T openSuggestionApplyPanel · T setMarginJudgementSetting ·
    T marginJudgementOn（导出域要它）
  注入：apiJson · showError · openModal/closeModal · refreshExportPreflight · renderRecognitionSettings ·
        forgetPageBlocks · refreshPageStates · loadPageDetail · setSaveState ·
        getCurrentProject · getDetailPageNo · BLOCK_TYPE_LABELS · 12 个节点（3 组）
```

**接口面通则（Chief 2026-11-02 定，三批共用）**：

```
① 动作名按**语义**取，不许用"语义布尔"让模块猜调用点：
   ❌ refreshPreflight({ withPreview: true/false })
   ✅ refreshPreflight()  /  refreshPreflightWithPreview()     ← 两个具名动作
   理由：参数里出现"该走哪条路"的布尔，就是规则①（一个能力键不许兼两种语义）的变体——
        模块只能靠参数猜调用点，而调用点一旦挪了位置，参数不会跟着变。
② 外壳不许编排模块内的出图顺序：像 `refreshExportPreflight(); loadExports();` 这种连排，
   收成模块动作（见上面 `reloadPanel()`）；外壳只表达"发生了什么"，不表达"先做什么后做什么"。
```

## 3. 闸（沿用 + 新增两条）

```
沿用（三批共用，缺一不可）：
  · 模块 DOM 面：el( / document.getElementById / document.querySelector 各 0；root.querySelector 走白名单
    **白名单现有三个模块**：`structure-tools.js` · `page-detail-editor.js` · **`export-panel.js`（本批新增）**
  · 导出面：沙箱执行 Object.keys，逐个要求在 app.js 有调用点（无调用点 = 预留 = 红）
  · 注入双向：boot 传的键必须被模块读；模块读的必须传（死注入 / 漏注入）
  · 跨模块直呼：模块里出现 window.<其它模块> ⇒ 红（godDoorProblems 已补这条）
  · id 归属三支：模块 id ⊆ 归属表 · 两集不交 · 并集 == 该 view 子树的 id 全集
新增两条（本批特有）：
 ① **多宿主模块的 id 归属**：一个模块用多个 view 的 id 时，归属表要按"宿主"分组，
    且每组的并集要等于对应子树（否则"壳里多了一个没人认的 id"不会红）。
 ② **写盘动作命名**：每个含 apiJson(POST/PUT/DELETE) 的导出成员，必须在模块里有
    "请求 → 读回 → 重画"三段的顺序（静态判：动作函数体里出现 await apiJson，且之后至少一次写 DOM/状态）；
    外壳侧不许出现"先调模块动作、再调另一个模块重画"的编排（扫 app.js 的调用点）。
```

**白名单第三个模块的登记规矩（三处同批，缺一处就红）**：

```
加一个模块进 ALLOW_QUERY_SELECTOR_WHITELIST ⇒ 必须同时改【白名单】【DOMAIN_MODULES】【书】三处，
并在书里写明："为什么它需要 root 能力 + 这三处分别是哪几行 + querySelectorAll 只许 root 作用域（不许 document）"

export-panel.js 的用例：`exportOptions` 与 `setupExportPanel` 里有 **3 处 querySelectorAll**，
  要找 10 个 checkbox（导出规则那一组）——逐个注入不现实，所以要 root 能力。
  约束：3 处都必须是 `root.querySelectorAll(...)`，**不许 document.querySelectorAll**（白名单只放 root 作用域）。
```

## 4. 预算（预估，开工现量）

```
导出：491 行函数体 + 骨架 40 + 接线 30 → 模块 ≈ 560；app.js −约 560（16 函数全走）
协作：426 + 40 + 60（多宿主） → ≈ 530；app.js −约 530（22 函数全走）
跨视图：223 + 40 + 40 → ≈ 300；app.js −约 300（16 函数全走）
deps：不改（三块都不新增注入键到 PagesView 那块；各模块的 deps 是新表，不进 171）
```

## 5. 不许顺手改

```
① 不动后端接口形状（导出包 / 分派 / 结果包 / 建议采用）——本批只搬前端
② 不动 #view-merge 的 DOM 结构与 class（app.css 0 行）
③ 不把 merge 视图的"导入合并"逻辑拆给别的模块（它只读 mergeState，不写别人的 DOM）
④ 不给注册表/调度器加第二个（三块都不碰 overlay registry）
⑤ 跨视图服务的 11 个入口不许合并成"onChanged()"这类万能键——按语义分组（§19 的教训）
```

## 6. 复现命令

```bash
# 三个域的名单与行数（本文 §1；按函数名，不按段头）
node /tmp/domains.mjs            # 脚本见本次提交（/tmp 不留档，按 §1 的名单 grep 定义行亦可）
# 函数集合与行数
grep -nE "^(async )?function (exportOptions|renderPreflight|refreshExportPreflight)" backend/book2text/static/app.js
# id 归属（按 view section）
node -e '...'                     # 见本次提交的 /tmp/dom2.mjs（按 <section id="view-*"> 切）
# 基线
wc -l backend/book2text/static/app.js            # 10,169
```
