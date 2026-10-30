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
   + 10 C
```

- 复现口径：`api` 键取自 `pages-view.js` 的 `const api = {`；同名薄转发器 = app.js 顶层函数，
  名字与键相同且 ≤6 行、函数体里出现 `window.PagesView.<键>`；"宿主"= 调用点所属的顶层函数
  （折叠同名转发器这一层）。
- **8 个死 T**（app.js 里 0 个调用点、也没有别的模块用）：
  `renderRecognitionVerdict` · `renderSuggestionPanel` · `renderTypePicker` · `undoMarginEdit` ·
  `updateSelectionPanel` · `pumpOverlayRender` · `rerunAuxiliary` · `scanVisiblePageSuggestions`
  ⇒ 删的是**键 + 转发器**；模块内部仍在用的函数保留。
- 39 个活 T 的宿主表见 §六（这就是刀 9b 的施工依据：搬一个宿主，死它那一列键）。

## 四、C 清册（今日 10 个 + 刀 7/8 的 4 个）

| C 键 | 触发者（effective callers） | 为什么是跨域 |
|---|---|---|
| `init` | boot | 生命周期 |
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

**39 个活 T 里有 3 个其实属于 C**，列名单独记：

```
applyPageZoom          ← (顶层初始化) / showView / goToWorkflowStep / setPageZoom   （缩放三步共用）
startLayoutDetection   ← startLayoutDetectFromDialog                               （版心检测对话框发起）
confirmAllUnconfirmed  ← finishConfirmPages                                        （收尾面板发起）
```

⇒ C = 10 + 3 = **13**；T-to-die = 39 − 3 = **36**。

> `checkSelection`（← setupReviewControls）我先按 T 记：`setupReviewControls` 是 pages 工具栏的接线，
> 该整段搬进模块（reading-view 就是这么做的）。若刀 9 的图判定这段接线留外壳，它就转 C，终态 +1。

## 五、曲线重推（每个数的来历）

```
今天            57 = 8 死T + 36 活T + 13 C
刀 7  （+1 C）   58 = 8 死T + 36 活T + 14 C     recognizePage
刀 8  （+3 C）   61 = 8 死T + 36 活T + 17 C     setPackageModeChrome / syncProjectSettings / setSelectionHint
刀 9a （−8 死T） 53 =            36 活T + 17 C   删键 + 删转发器（0 个调用点，纯删；今天就能做）
刀 9b （−36 +2） 19 =                    19 C   搬 78 个调用点（§六）+ 建 enter / refresh
刀 10 （不变）   19                             冻结清册 + 落地 §七 的机检
```

每一步的"来历"只有两种动作：**删一个 0 调用点的键**（−8），或**搬 n 个调用点进模块**（−36，+2）。
没有"拍一个数"。

## 六、刀 9b 的施工依据：宿主 → 可一次杀掉的键（41 行）

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

> 注：19 = 17 C + enter + refresh（init 已在 17 里）。若 `checkSelection` 也判 C，则 20。
> 这两个值都在"清册"里逐键可查，不再是一个减法。

## 八、机检（四条，交 TestDev）

```
① kind 登记：VIEW_EXPORTS 每键必须带 { kind: "T" | "C" }
     T：必须带 death（刀号）· 不许带 callers
     C：必须带 callers（函数名/模块名清单）+ Capability-Reason · 不许带 death
     未分类 / 两类字段混填 → 红
② T 到点未死 = 红：death <= stageNow() 且（键仍在 api ∪ 同名转发器仍在 app.js）→ 红
     —— 这条同时修掉今天那 20 个「写着刀5/刀6 死期却还活着」的键（重算成刀 9）
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
· 刀 9a：删 8 个死 T（键 + 转发器）+ 把 20 个过期死期重算到刀 9 + 落 §八 ②
· 刀 9b：建 enter / refresh（§八 ④）+ 按 §六 逐宿主搬 78 个调用点，36 个 T 逐个死
· 刀 10：不再减数，落 §八 ③（C 清册两向）+ 冻清单册
```
