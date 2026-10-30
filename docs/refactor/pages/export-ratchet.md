# 导出棘轮：两类键 + 生命周期类（Architect 裁定）

> 裁定 2026-10-30。回答 `docs/refactor/pages/knife9-key-ledger.md` §三 的 a/b/c。
> 量数树：`6d4492f`（app.js 13,462 行 · pages-view.js 3,126 行 · api **57** 键）。
> 一句话：**两类的划分成立，但"能力面"必须是一份逐键清册（不是数字上限）；
> `22` 是减法算出来的、`3` 做不到，可达终态 ≈ 19。**

## 一、三类，不是两类

| 类 | 定义 | 判据（机检） |
|---|---|---|
| **L** lifecycle | `init` / `enter` / `refresh(scope)`——进出视图、状态变化后重画 | 固定 3 个名字，不许改名（刀 9 建 enter/refresh） |
| **T** transitional | 只因为"代码还没搬完"而存在的键：它唯一的调用形态是**同名薄转发器**，转发器的调用者是 pages 域、迟早搬进模块 | **必须带 `death: 刀N`**；到点后键与转发器都必须不存在 |
| **C** capability | 触发者在**别的域**：别的 `*-view.js` 经 `injected` 调，或外壳的**永留编排函数**调 | **不写死期**；必须登记 `callers`（函数名 / 模块名清单）+ `Capability-Reason` |

**C 的"数量上限"不用数字，用清册。** 数字管不住身份（换个名字就多一个），清册管得住：
新增一个 C 键 = 往清册加一行并在提交信息里写理由，评审当场可见。上限就是"清册条数"，
所以它天然有真值来源（代码里的调用者），不需要再拍一个 22。

## 二、为什么 `22` 和 `3` 都没有推导依据

```
22  来自 `53 − 31`（刀5 图的减法），从来没有一份"哪 22 个键"的名单
    → 账本一逐键列名就露：其中 8 个（列表见 §四）根本不该有死期，它们属于 C
3   来自 `init / enter / exit` 这个口号（reading-view 的终态形状）
    → 但 reading-view 是 **5 个键**（init/enter/getCurrent/reload/toggleFollow，MAX_EXPORTS=5），
      不是 3；而且它的"小"来自**接线和轮询都在模块里**，不是来自"只有 3 个名字"
```

刀 9 的 39 = 61 − 22 这个推导因此作废。下面按实际分类重推。

## 三、今日实测（57 键，可复现）

```
57 = 8 死 T（0 调用点，可立即删）
   + 39 活 T（78 个调用点 / 41 个宿主函数）
   + 9 C + 1 L（`init`）
```

- 复现口径：`api` 键取自 `pages-view.js` 的 `const api = {`；同名薄转发器 = app.js 顶层函数，
  名字与键相同且 ≤6 行、函数体里出现 `window.PagesView.<键>`；"宿主"= 调用点所属的顶层函数
  （折叠同名转发器这一层）。
- **8 个死 T**（app.js 里 0 个调用点、也没有别的模块用）：
  `renderRecognitionVerdict` · `renderSuggestionPanel` · `renderTypePicker` · `undoMarginEdit` ·
  `updateSelectionPanel` · `pumpOverlayRender` · `rerunAuxiliary` · `scanVisiblePageSuggestions`
  ⇒ 删的是**键 + 转发器**；模块内部仍在用的函数保留。
- 39 个活 T 的宿主表见 §六（这就是 **9.1–9.5** 的施工依据：搬一个宿主，死它那一列键）。

## 四、C 清册（今日 9 个 + 刀 7/8 的 4 个；`init` 单列在 L）

| L 键 | 触发者 | 为什么是 L |
|---|---|---|
| `init` | boot | 生命周期（不占 C 清册；落盘表里 `L:1`） |

| C 键 | 触发者（effective callers） | 为什么是跨域 |
|---|---|---|
| `syncToolbarToggles` | 4 个视图模块 + boot 的 4 行 deps | 模块→模块（第一个此类键） |
| `loadFinishSummary` | 13 个外壳函数 + reading×2 / library×1 | 收尾状态被三个视图共用 |
| `renderRecognitionSettings` | loadAppInfo / applyProjectSettings / boot + library×1 | 项目设置落在 pages 面板上 |
| `openPageSetup` | boot + library×1 | 首启/库页打开页面设置 |
| `toggleMarginView` | boot + index/preview | 三步共用的工具栏开关 |
| `togglePageBlocksOverlay` | boot + index/preview | 同上 |
| `showPagesError` | finishRevokeAutoPass | 收尾面板的任务失败要显示在页面错误条 |
| `pagesErrorMessage` | startLayoutDetectFromDialog | 版心检测对话框读错误文案 |
| `setMarginJudgementCheckbox` | setMarginJudgementSetting | 项目设置 → 导出面板勾选态 |
| **刀 7** `recognizePage` | buildTile / setupLibrary（review 的「重新识别」） | 单页识别可从页面网格和审校面板发起 |
| **刀 8** `setPackageModeChrome` · `syncProjectSettings` · `setSelectionHint` | applyPackageMode / applyProjectSettings / applySplitBatch | 跨域编排 |

> **口径修正（TestDev 必看）**：`knife9-key-ledger.md` 的「模块引用」列把 **pages-view 自己**的
> `injected.<键>` 也算进去了（`refreshMarginDetectHint` 3 · `renderMarginStepVerdict` 4 ·
> `refreshMarginTiles` 2 · `refreshLayoutDetectEntry` 1 · `renderStepPanels` 1 · `loadFinishSummary` 3
> = 6 个键 14 处自环）。**只有别的 `*-view.js` 的引用才算 C 的证据**；自环是本模块要清的债（§十），
> 不升级成 C——否则账上会凭空多 5 个"能力键"。


**39 个活 T 里有 3 个其实属于 C**，列名单独记：
```
applyPageZoom          ← (顶层初始化) / showView / goToWorkflowStep / setPageZoom   （缩放三步共用）
startLayoutDetection   ← startLayoutDetectFromDialog                               （版心检测对话框发起）
confirmAllUnconfirmed  ← finishConfirmPages                                        （收尾面板发起）
```

⇒ C = 9 + 3 = **12**（另有 **L = 1**：`init`）；T-to-die = 39 − 3 = **36**。

> **标签口径**（2026-10-30 与落盘数据对齐）：`init` 归 **L**，不占 C 的清册。
> 落盘后的 `kinds` 表就是这么记的（`L:1 · T:44 · C:13`，58 键），所以本文后面
> 凡写 C 的地方都不含 `init`；含它的时候会明说「C+L」。

> `checkSelection`（← setupReviewControls）我先按 T 记：`setupReviewControls` 是 pages 工具栏的接线，
> 该整段搬进模块（reading-view 就是这么做的）。若刀 9 的图判定这段接线留外壳，它就转 C，终态 +1。

## 五、曲线重推（每个数的来历）

```
今天            57 = 8 死T + 36 活T + 12 C + 1 L
刀 7  （+1 C）   58 = 8 死T + 36 活T + 13 C + 1 L   recognizePage   ← 现状（main 的 kinds 表就是这个）
刀 8  （+3 C）   61 = 8 死T + 36 活T + 16 C + 1 L   setPackageModeChrome / syncProjectSettings / setSelectionHint
刀 9   （−8 死T） 53 =            36 活T + 16 C + 1 L   删键 + 删转发器（0 个调用点，纯删）
刀 9.1–9.5（−36 +2） 19 =                  16 C + 3 L   搬 78 个调用点（§六）+ 建 enter / refresh
刀 10 （不变）   19 = 16 C + 3 L（init / enter / refresh）  冻结清册 + 落地 §八 的机检
```

每一步的"来历"只有两种动作：**删一个 0 调用点的键**（−8），或**搬 n 个调用点进模块**（−36，+2）。
没有"拍一个数"。子刀怎么分、死期写哪个号，见 §十（闸不允许"一刀多笔"）。

## 六、刀 9.1–9.5 的施工依据：宿主 → 可一次杀掉的键（41 行）

搬一个宿主的 pages 段，就把"它的键"全杀掉（多数宿主只调 1–3 个键，同批改完）。
**加粗**那 3 个属于 C，不随宿主死。

| 宿主函数 | 可杀掉的键 |
|---|---|
| `pollTask` | `refreshRecognizedPages` · `syncPageStates` · `updateMarginDetectProgress` · `updateRecognitionAuxProgress` · `forgetAllPageSuggestions` |
| `showView` | `loadSetupSuggestions` · `renderPageSetup` · `loadLanguageSummary` · ~~`applyPageZoom`~~（C） · `pausePageThumbnails` |
| `startLayoutDetectFromDialog` | `renderMarginStepVerdict` · `setMarginStatus` · `showMarginDetectProgress` · ~~`startLayoutDetection`~~（C） |
| `refreshMarginState` | `ensureMarginFitted` · `renderMarginPanel` · `refreshMarginTiles` |
| `reportLayoutDetectOutcome` | `renderMarginStepVerdict` · `finishMarginDetectBar` · `setMarginStatus` |
| `adoptPageNumberTemplate` / `removePageNumberRange` / `savePageNumberManual` | `loadPageNumberSummary` · `setPageNumberStatus` |
| `refreshAfterTypeChanges` | `forgetAllPageBlocks` · `forgetAllPageSuggestions` |
| `renderLayoutStatus` | `refreshLayoutDetectEntry` · `refreshMarginDetectHint` |
| `scheduleLayoutBlocks` | `loadLayoutBlocks` · `renderLayoutBlocks` |
| `selectAllVisiblePages` / `selectNextPage` | `renderPages` · `visiblePages` |
| `(顶层)` / `goToWorkflowStep` / `setPageZoom` | ~~`applyPageZoom`~~（C，只改直呼形态，不走`enter`） |
| `afterCleanupApplied` | `forgetAllPageSuggestions` |
| `applyHeaderFooter` / `controlJob` | `reloadProjectPages` |
| `applySplitBatch` | `forgetAllPageSuggestions` |
| `clearPageSelection` / `handleTileClick` / `renderProject` / `finishShowFallbackPages` / `recognizePage` | `renderPages` |
| `confirmAllMargins` | `ensureMarginFitted` |
| `ensurePageScrollListener` | `pageScroller` |
| `fetchPageBlocks` | `queueOverlayRender` |
| `finishConfirmPages` | ~~`confirmAllUnconfirmed`~~（C） |
| `hydrateView` | `loadPageNumberSummary` |
| `loadAutoApplyStatus` | `renderAutoApplyStatus` |
| `loadPageNumberMetrics` / `refreshPageNumberAnalysis` | `renderPageNumberMetrics` |
| `loadWorkflow` | `renderWorkflowFilter` |
| `onMarginPointerUp` | `savePageMargin` |
| `refreshPageStates` | `syncPageStates` |
| `schedulePageVisibility` | `updatePageVisibility` |
| `selectRangeTo` | `visiblePages` |
| `setupReviewControls` | `checkSelection` |
| `syncWorkflowSteps` | `renderStepPanels` |
| `waitForAuxThenReview` | `renderRecognitionStatus` |

（连同 8 个死 T 一起，本章的 36 个 T 全部有归属，没有一个键"没人负责死"。）

## 七、`3` 做不到——说清楚为什么

`init / enter / exit` 只能表达"进出视图"，表达不了下面这些**跨域触发**：

```
别的视图要它：syncToolbarToggles（4 个模块）· loadFinishSummary（3 个模块）
外壳编排要它：setPackageModeChrome / syncProjectSettings / setSelectionHint（刀 8）
             showPagesError / pagesErrorMessage / setMarginJudgementCheckbox（刀 6）
             applyPageZoom（缩放三步共用）· startLayoutDetection（版心对话框）· confirmAllUnconfirmed（收尾面板）
入口要它：   recognizePage（审校面板的「重新识别」）
```

要凑到 3，只有一条路：**把命令改成"注入状态 + 单一 render"**（比如「识别这一页」改成
`setRecognizeRequests([pageNo])` 再 `refresh()`）。那等于重写交互模型，而且会撞本项目的头号反面模式
——**多处写同一份状态**（就是 `PAGES_STAGE` 那类账的代码版：谁都能 push 一个请求，没人知道它什么时候被消费）。
所以我不为迁就旧曲线去改代码：**终态 19，不是 3。**

> 注：19 = **16 C + 3 L**（init / enter / refresh）。若 `checkSelection` 也判 C，则 20。
> 这两个值都在"清册"里逐键可查，不再是一个减法。

## 八、机检（四条，交 TestDev）

```
① kind 登记：VIEW_EXPORTS 每键必须带 { kind: "T" | "C" }
     T：必须带 death（刀号）· 不许带 callers
     C：必须带 callers（函数名/模块名清单）+ Capability-Reason · 不许带 death
     未分类 / 两类字段混填 → 红
② T 到点未死 = 红：death <= stageNow() 且（键仍在 api ∪ 同名转发器仍在 app.js ∪
     模块里还有 `injected.<该键>` 的自环）→ 红
     —— 这条同时修掉今天那 20 个「写着刀5/刀6 死期却还活着」的键：6 个转 C（删死期）、
        3 个是死键（刀 9 直接删）、11 个按 §十 的表重算到 9.1–9.5
③ C 清册两向：
     a) 每个 C 键的 effective callers ⊆ 清册的 callers（多一个没登记的调用者 → 红）
     b) 清册里的每个 caller 必须真的调用它（虚报 → 红）
     —— 这样"把 T 改标成 C"就必须把调用者逐个写进清单，评审能看见，不会悄悄发生
④ refresh 的 scope 枚举：PAGES_REFRESH_SCOPES 登记（≤6 个），只许是"数据变化域"
     （pages / setup / margin / recognition / page-number / jobs）
     出现操作型 scope（delete / apply / run / recognize）→ 红（那是 pagesOp(op,arg) 的变体）
```

**为什么 ② 必须现在就做**：死亡刀号今天只是注释，没有任何闸；20 个键已经过了自己写的死期还活着
（刀 5 两个、刀 6 十八个）。没有 ②，本次的分类也只是把清单从"错的"换成"新写的"。

## 九、落位（不改刀 7 / 刀 8 的排期）

```
· 刀 7 / 刀 8 的新键：先按 C 记账（recognizePage / setPackageModeChrome / syncProjectSettings / setSelectionHint）
· 刀 9：删 8 个死 T（键 + 转发器）+ 20 个过期死期逐键重判（6 转 C / 3 删 / 11 重算）+ 落 §八 ②
· 刀 9.1–9.5：建 enter / refresh（§八 ④）+ 按 §六 逐宿主搬 78 个调用点，36 个 T 逐个死
· 刀 10：不再减数，落 §八 ③（C 清册两向）+ 冻清单册
```

## 十、9 与 9.1–9.5 的死期怎么记（TestDev 可直接抄成数据）

> **叫法**：子刀一律写 `9.1`–`9.5`；`9b` 只是这五刀的合称，**不许写进账本、不许写进死期**
> （刀号的真值源是 `tests/js/knife-registry.mjs`，那里没有 `9b` 这个号）。

**结论：拆子刀号、每个子刀一笔落完；T 的死期 = 搬它宿主的那一刀，多宿主取 max（与 R3 的
「到期刀 = max(引用它的函数)」同一语义）。**

### 为什么不能"一刀两段"（Chief 的选项②）

不是记账麻烦，是判据矛盾——闸不允许：

```
git log --format=%s origin/main | grep -oE "^move\(pages\): 刀 [0-9.]+" | sort | uniq -c
   2 刀 2.5 · 1 刀 3 · 1 刀 4 · 1 刀 5 · 1 刀 6 · 1 刀 7
```

一刀一笔是既有事实（2.5 那两笔在交叉校验上线之前）。而 `stageNow = max(git 最大刀号, 登记表 landed 最大)`，
`stageSourceProblems` 对 `登记表 < git` 直接红（"只落了笔没更新登记表"）。于是：

- 多笔共用一个号、每笔首行都写 `move(pages): 刀 9` → **第二笔就红**（git=9，登记表还没跟上）；
- 第一笔就把登记表标 landed=9 → `stageNow` 立刻到 9，36 个 T 当场到期，而它们还没搬完 → **红一片**。

⇒ **多笔共用一个刀号在当前闸下不可能。** 选项③（死期写 9 + 给 9.1–9.5 那批键开白名单）否掉：
给 36 个键开白名单，就是把豁免表再办一次。

### 子刀与死期（可直接抄成 `kind: "T", death: <号>`）

| 子刀 | 内容 | 死期写这个号的 T 键 |
|---|---|---|
| **9** | 删 8 个死 T（键 + 转发器）；20 个过期死期重判（6 转 C · 3 删 · 11 重算）；落 §八 ② | 8 个（§三） |
| **9.1** | 视图切换：`showView` / `hydrateView` | 4：`loadSetupSuggestions` · `renderPageSetup` · `loadLanguageSummary` · `pausePageThumbnails` |
| **9.2** | 任务轮询与可见性：`pollTask` / `fetchPageBlocks` / `schedulePageVisibility` | 5：`refreshRecognizedPages` · `updateMarginDetectProgress` · `updateRecognitionAuxProgress` · `queueOverlayRender` · `updatePageVisibility` |
| **9.3** | 版心一族（对话框 / 进度 / 瓷砖 / 拖动保存） | 12：`renderMarginStepVerdict`* · `setMarginStatus` · `showMarginDetectProgress` · `ensureMarginFitted` · `renderMarginPanel` · `refreshMarginTiles`* · `finishMarginDetectBar` · `refreshLayoutDetectEntry`* · `refreshMarginDetectHint`* · `loadLayoutBlocks` · `renderLayoutBlocks` · `savePageMargin` |
| **9.4** | 页码一族（三个面板宿主 + 指标） | 3：`loadPageNumberSummary` · `setPageNumberStatus` · `renderPageNumberMetrics` |
| **9.5** | 选择 / 网格 / 步骤 / 收尾 / 其它 | 12：`syncPageStates` · `forgetAllPageSuggestions` · `forgetAllPageBlocks` · `renderPages` · `visiblePages` · `reloadProjectPages` · `pageScroller` · `renderAutoApplyStatus` · `renderWorkflowFilter` · `checkSelection` · `renderStepPanels`* · `renderRecognitionStatus` |

合计 **8 + 4 + 5 + 12 + 3 + 12 = 44 = 8 死 T + 36 活 T** ✓

多宿主取 max 的两个例子：`loadPageNumberSummary` 的宿主是 `adopt/remove/save`（9.4）与 `hydrateView`（9.1）
⇒ 死期 **9.4**；`syncPageStates` 的宿主是 `pollTask`（9.2）与 `refreshPageStates`（9.5）⇒ 死期 **9.5**。

### 带 `*` 的 5 个键还欠一刀：**模块调自己的导出键（自环）**

实测 `pages-view.js` 里有 **14 处** `injected.<自己的 api 键>`，绕道外壳再回到自己
（`injected.refreshMarginDetectHint()` → app.js:691 转发器 → `window.PagesView.refreshMarginDetectHint()`）：

```
renderMarginStepVerdict ×4 · refreshMarginDetectHint ×3 · loadFinishSummary ×3(C)
refreshMarginTiles ×2 · refreshLayoutDetectEntry ×1 · renderStepPanels ×1
```

这是刀 3/刀 5 的遗留（当时被调方还没搬进来）。**死这些键的同一笔里必须把自环改成直呼**，
否则键一删，这 14 处就成了运行时 undefined。§八 ② 的到点判据已把"模块里还有 `injected.<键>`"算进去。

### 每个子刀的最后一笔必须同批做三件

```
① 该组的调用点搬完（§六 那几行宿主）
② 登记的 T 键从 api + VIEW_EXPORTS 删掉，模块里的自环改直呼
③ knife-registry 那一行标 landed
```

少任何一件，下一笔的 pre-commit 就会红（`stageNow` 已跳到这个子刀）。

### 编号登记

`knife-registry.mjs` 支持小数（`2.5` 已有；`gitMaxKnifeFromLog` 用 `Number` 不用 `parseInt`）。
新增 **9.1–9.5** 五行（每行一条 scope）；**刀 9 的原 scope 作废**——它写的是
「导出收口：R8 53 → 22，要死 31 个键」，改成「删 8 个死键 + 重算过期死期 + 落 T 到点未死机检」。


## 十一、另案：零引用代码（`ensureReviewPage` 不是孤例）

**它和刀 9 那 8 个"死 T"是两件事**：那 8 个是**导出键**（占 R8 的账，删了曲线才动）；
这些是 app.js 的**内部函数**（不占 R8、不占 R3，删了不会让任何闸变绿，也不会让任何数字动）。
所以**不并在刀 9 里做**，但也别忘——留到最后会让"app.js 还有什么用"没法回答。

**实测（`a167fc6`，口径与命令见下）**：

```
app.js 列 0 的 `function` 声明 **587** 个；全仓按**词边界**扫，扣掉
  ① 定义位（`function <name>(`）
  ② 属性位（`window.<name>` / `obj.<name>`；注意 `...<name>(` 是**展开调用**，不是属性位）
⇒ 0 引用 **9** 个：

ensureReviewPage(6206) · pendingBlockCount(6606) · textAdvance(7335) · queueKey(7647) ·
textRows(8923) · handleDiffMarkClick · selectLineInTextarea · punctGroupByKey
divergenceCandidatesOn(2189) —— **不能直接删**：tests/integration/test_ui_assets.py:778 断言
                              `"function divergenceCandidatesOn(" in script`
```

口径的坑（我自己第一次扫错了一次，值得写下来）：只用 `(?<![\w$.])name` 会把
`list.append(...statsRow(…))` 里的**展开调用**当成属性位漏掉（`statsRow` 明明是活的），
于是报出 11 个"死函数"而不是 9 个。判据要三栏都扫：定义位 / 值位 / 调用位，属性位单列。
另外 `statsRow` 这类名字是**别的活名字的子串**（`renderStatsRow…`），人肉 grep 也会骗人。

**顺序：先删到 0，再开闸。** 现在开"0 引用函数 = 红"会红 9 条，其中 1 条还被测试断言撑着；
先开闸等于又要一张豁免表（本项目已经在这上面栽过两次）。

**到期点：刀 10（收口）**，逐个选，不是整批：

```
ensureReviewPage        → **接上或删**。它是"进 review 自动挑页"的唯一实现，而今天四个入口都走
                          openPageDetail()（显式带页号）。将来若要"回到上次审校页"，接它比新写一个对
其余 7 个               → 删（重构/改名后的残留，没有任何"将来会用到"的迹象）
divergenceCandidatesOn  → 先判那条断言还有没有意义：它断的是**源码里有这个函数**，不是行为。
                          行为（双引擎候选不自动采用）若已有真的落点，函数与断言一起删；
                          若没有，说明这条行为其实没接上——那是另一个 bug，不是清理
```

清理完这 9 条，才把「0 引用顶层函数 = 红」开成闸（判据带上 §上面那三栏口径，
并把 `tests/` 里的源码断言算进"引用"，否则永远多一条）。
