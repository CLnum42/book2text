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

> **判据的顺序**：C 要按"**它想干什么**"判，**不按"今天是哪段代码在接"**判。
> 后者会把所有"接线放错地方"的键都判成 C —— 而"接线放错地方"恰恰是刀 7/刀 8 一直在收的那类，
> 判成 C 就等于把错位固化成接口。今天的样子不是归属的证据；"这个动作属于哪个域"才是。

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
- **"0 调用点"的键有 8 个，但真死只有 5 个**（2026-10-30 复核，`main@e9ddc2a`）：
  另外 3 个是**值位引用**——只扫调用位 `key(` 就会把它们当死的。
  这是团队第三次栽在值位（前两次：R3 闭包漏 71 个值引用、pages 转发器"无调用 4"）：

  ```
  4244  button.addEventListener("click", undoMarginEdit);                    ← 值位
  3806  requestAnimationFrame(pumpOverlayRender);                            ← 值位
  3181  suggestionScanTimer = setTimeout(scanVisiblePageSuggestions, 60);    ← 值位
  ```

  - **5 个真死**（删键 + 转发器）：`renderRecognitionVerdict` · `renderSuggestionPanel` ·
    `renderTypePicker` · `rerunAuxiliary` · `updateSelectionPanel`
    （`updateSelectionPanel` 唯一那处是 **app.js:11794 的注释**——**不剥注释**会把它当成引用，
     于是"只扫调用位"漏 3 个、`"不剥注释"`多算 1 个，两向都会错）
  - **3 个值位**：`undoMarginEdit` · `pumpOverlayRender` · `scanVisiblePageSuggestions`

**裁定：A —— 让这 3 个键真死**（不判 C、也不用"改箭头"绕过）。三条理由：

```
① 它们是模块**自己的渲染循环/接线**，而调度状态被放在外壳 —— 一份状态两边写、一边读：
   overlayPumpScheduled（app.js:3021，外壳读 :3804）· suggestionScanTimer（:3170，外壳读/清）；
   模块通过 injected.setOverlayPumpScheduled / setSuggestionScanTimer 去写外壳的变量。
② C 的定义是"**别的域**需要这个操作"；外壳的 setTimeout / requestAnimationFrame 触发
   不是跨域需求，是模块自己的调度被放在了外面。判 C 等于把这份错位冻成"合法接口"。
③ marginUndoButton()（app.js:4234）只是造一个 button 元素、零 id；模块自己造按钮零风险。
```

**为什么不采用 DevLead 的箭头改法**（`() => window.PagesView.undoMarginEdit()`）：

```
· 键没有死：api 里还在，R8 还是 61；
· `PagesView.<key>` 的引用也还在，「到点未死」判据照样看得见它；
· 它把"删键后 TypeError"换成"看起来删了、其实没删"——最难发现的一种绿。
```

### 排期：三个键不在一刀（Builder 量出真规模之后改判）

| 键 | 死在哪 | 依据 |
|---|---|---|
| `undoMarginEdit` | **9.6** | 纯 DOM 构造 + 绑模块自己的函数；三处 `actions.append`（pages-view :247/273/323）改用本地工厂。零行为风险 |
| `pumpOverlayRender` | **10** | 队列入口是 `fetchPageBlocks`（外壳），队列状态（`pageBlockPending` / `pageBlockVersions` / `pageBlockPrefetchInFlight` + `overlayPumpScheduled`）也在外壳 ⇒ **只搬调度器不成立**：外壳 `.finally` 没有喊话对象，只能改喊 `window.PagesView.pumpOverlayRender()`，键死不了 |
| `scanVisiblePageSuggestions` | **10** | 同上：`pumpPageSuggestionQueue().finally` 收尾调 `scheduleSuggestionScan`，而 `suggestionScanQueued` 是"外壳持有、模块写"的两向耦合 |

**为什么不判 C**：C 的定义是"永不死"。这三个会死——死在"整条队列搬进模块"那一刀。
判 C 等于承诺"队列子系统永远留在外壳"，而队列的入口是 pages 自己的块抓取（`fetchPageBlocks`），它该搬。

**为什么不给 `death: null`**：那要抬 `T_DEATH_PENDING_MAX`（今天 0），而它是**手写常数**——
抬它正是这半年一直在收的那类东西。能按期就给它一个号。

**所以：登记 刀 10 = 队列子系统搬进模块**（原「刀 10 收口」顺延为 **刀 11**），两个泵 `death = 10`。
到期没搬，判据自己红，不需要任何常数。

刀 10 的边界与入场条件：

```
边界：overlay 侧 fetchPageBlocks 的队列 + pageBlockPending/Versions/PrefetchInFlight + overlayPumpScheduled
     + queueOverlayRender / pumpOverlayRender / resetOverlayQueue；
     suggestion 侧 pumpPageSuggestionQueue + suggestionScanQueued + suggestionScanTimer
     + scanVisiblePageSuggestions + scheduleSuggestionScan
⇒ R8 −2（两个泵）· deps −8（逐键见下表；不是 −5）

入场条件（Builder 三条风险，原样）：
① 测试沙箱没有 requestAnimationFrame / setTimeout（vm 只给 window/document/localStorage）——
   搬进去后走到 queueOverlayRender / scanVisiblePageSuggestions 的用例会抛；先给 harness 补桩。
② 取消语义保持：resetOverlayQueue 不取消已排的帧；scheduleSuggestionScan 是唯一的 clearTimeout。
   **不许顺手加 cancelAnimationFrame**。
③ PAGE_BLOCK_FETCH_LIMIT 与 pump 的"放回队尾 + waiting"是一对，同进同出，否则空转或饿死。
```

**deps 逐键**（9 个键全部只被 pages-view 读过；读次数实测）：

| deps 键 | 模块读 | app.js 定义位 | 哪一刀删 |
|---|---|---|---|
| `marginUndoButton` | 3 | :13119 | **9.6**（模块自建按钮；壳里 :4234 的工厂随之删除） |
| `scheduleOverlayPump` | 3 | :13134 | 10 |
| `setOverlayPumpScheduled` | 1 | :13246 | 10 |
| `resetOverlayQueue` | 2 | :13228 | 10 |
| `scheduleSuggestionScan` | 3 | :13229 | 10 |
| `getSuggestionScanTimer` | **0**（今天就是死的） | :13096 | 10 |
| `setSuggestionScanTimer` | 1 | :13179 | 10 |
| `getSuggestionScanQueued` | 1 | :13095 | 10 |
| `setSuggestionScanQueued` | 1 | :13249 | 10 |

**三个口径必须分开写，别混成一个数**（今天三次打架都是这么来的）：

```
口径 ① 最小删（只删"直接死"的）          **219 → 218**   只有 9.6a 的 marginUndoButton
口径 ② 整条队列（9 个里除 button 的 8 个） **218 → 210**   211 是"219 − 8"（不含 button）；含它就是 210
口径 ③ 连缓存族一起搬（下面这族若也进模块，deps 还要再减，**落盘时按逐键清单核，不按预估**）
        pageBlockPending / pageBlockVersions / pageBlockPrefetchInFlight
        + suggestionScanQueued 之外的队列计数器（若还有）
        ⇒ 目标 **≤ 210**，但"≤"不是承诺，逐键清单才是
```

**别把口径 ② 的 210 当成"渲染循环归位"的证据**（DevLead 提的，很准）：刀 10 搬的是
调度器与队列，**块缓存家族（`pageBlockVersions` / `pageBlockPending` / `pageBlockPrefetchInFlight`）
是否同批搬由该刀图定**。它们留在壳里的话，只能说"调度归位"，不能说"循环归位"——
这句话必须写在刀 10 的图里，否则下一个人会拿 210 当"已经搬完"的依据。

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
| **9.2** `onTaskProgress(data)` | pollTask（每轮轮询，:5366-5367） | 外壳持有 job，模块只负责把进度画到版心/复核面板；job_type 的分派模块**本来就有**（pages-view:770 / :1718 自带守卫），外壳那两行 `if` 是重复分派 |
| **9.2** `onRecognitionFinished(donePages, opts)` | pollTask（收尾分支 :5398 / 运行分支 :5419） | 任务结束后的"作废旧块 + 重载"由外壳触发；两个调用点参数不同（`reloadDetail`） |

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
刀 8 （现状）    61 = T 44 + C 16 + L 1
刀 9   （−5）     56 = T 39 + C 16 + L 1   5 个真死的：删键 + 删转发器
刀 9.1 （−4 +1）  53 = T 35 + C 16 + L 2   showView 的 pages 段搬进 enter()（hydrateView 的 loadPageNumberSummary 随 9.4）  ← 现状
刀 9.2 （−3 +2）  52 = T 32 + C 18 + L 2   pollTask 的三处收成 2 个能力（§三）
刀 9.3 （−12）    40 = T 20 + C 18 + L 2
刀 9.4 （−3）     37 = T 17 + C 18 + L 2
刀 9.5 （−12 +1） 26 = T  5 + C 18 + L 3   搬完 + 建 refresh()
刀 9.6 （−1）     25 = T  4 + C 18 + L 3   只做 undoMarginEdit
刀 10  （−4）     21 = T  0 + C 18 + L 3   队列子系统（两个泵 + queueOverlayRender + updatePageVisibility）
刀 11 （不变）    21 = T  0 + C 18 + L 3   冻结清册 + 落地 §八 的机检
```

**曲线以后按"这个键能不能搬"算，不按"这一刀有几个键"算**（今天三次同型）：每个 T 只有三种死法——

```
① 宿主是单视图动作 → 宿主搬走，键死于那一刀（9.1 / 9.3 / 9.4 / 9.5）
② 宿主是跨域编排（pollTask / 面板 / 别的视图）→ 键**本来就不是 T**：收成 C（9.2），或由 refresh 吸收
③ 宿主属于"子系统"（队列 / 渲染域）→ 随子系统整体搬（刀 10）
```

没有第四种。所以"某刀 −5"这种数要先逐键过这三条才能写。`enter` 建在 9.1、`refresh` 建在 9.5
是按语义钉的；若该刀图把入口提前/推后，中间值会动，但 **T 归零这一步不会**。
子刀怎么分、死期写哪个号，见 §十（闸不允许"一刀多笔"）。

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

**终态判据改成「T 归零」，不再用「总数 X」**（2026-10-30 裁定，作废「导出到 3」与「终态 19」）：

```
终态 ≡ T == 0（外壳不再有任何函数级转发）
     ∧ L == 3（init / enter / refresh）
     ∧ C == 清册里那一批（每键 callers + Capability-Reason，两向机检）

数字由设计决定，不由指标决定。C 多一个少一个，不改"收干净了没有"这个判断。
```

**为什么不是数字**：今晚三次同型（刀 8 的三个函数、9.6 的两个泵、9.2 的三个宿主）说明——
宿主搬不动时，杀掉一个键就多一个能力键，总数只是换了个类；拿数字当目标会逼人为凑数做设计选择
（我们差点为 3 凑一次）。而「T 归零」可判定，且正是 R8 的初心：外壳不许伸手进模块内部，
只能按语义叫它。

**防漂的替代**（不留空档）：① `R8.total` **只降不升**（今天 61，往后每个数都不许回升）；
② 每加一个 C 键 = 改清册 + 写 `Capability-Reason`，两向机检（§八 ③）会拦"清册被随手放宽"。

> 现阶段的**推导值**（预测，不是目标）：**21 = C 18 + L 3**。它比旧的 19 多 2，因为
> pollTask 那两个进度写点是被判错了类（它们本来就是跨域能力，见 §三 9.2）——多出来的 2 个是
> **诚实税**，不是设计变松。若 9.5 的图判定 `checkSelection` 留外壳，它转 C，推导值 22。

## 八、机检（四条 + 一条配套的文档判据，交 TestDev）

```
① kind 登记：VIEW_EXPORTS 每键必须带 { kind: "T" | "C" }
     T：必须带 death（刀号）· 不许带 callers
     C：必须带 callers（函数名/模块名清单）+ Capability-Reason · 不许带 death
     未分类 / 两类字段混填 → 红
② T 到点未死 = 红：death <= stageNow() 且（该键在 app.js 的**任何引用** > 0 ∪ 键仍在 api ∪
     模块里还有 `injected.<该键>` 的自环）→ 红
     · **"任何引用"= 三栏**：裸标识符（**含值位**）· `PagesView.<键>` · `injected.<键>`；**先剥注释**
     · ⚠ 现在的实现 `appCallsOfExportKey`（boundary.test.mjs:3746）只数 `(window.)?PagesView.<键>`，
       对"转发器 + 值位"是**瞎的**：4244 / 3806 / 3181 三处它全看不见 ⇒ 删键当天绿、运行时 ReferenceError
     · `updateSelectionPanel` 反过来证明"剥注释"这半也得有：它唯一的出现是 11794 的**注释**
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

### ② 的实现有两个静默洞（2026-10-30 实测，必须同批补）

```
洞一：`Number(death) <= Number(stage)` 对 NaN 恒为 false
      ⇒ 死期写成 `"9b"` / `"9."` / `"9,1"` 的键**永远不会被判到点**，而且不报错。
      今天 44 个死期全是数字，所以没炸；但死期是手写数据，改一个字符就静默。
洞二：死期可以写一个**不存在**的刀号（如 `9.7`）——它不会静默，但会"晚一刀到期"，
      而刀号的唯一真值源是 `tests/js/knife-registry.mjs`（`isRegisteredKnife`）。
```

补法（两行 + 两个喂红样例）：

```
① exportKindProblems 的 T 分支加：
     Number.isFinite(Number(death)) && Number(death) > 0，否则红
     红文：死期 "9b" 不是正数刀号——Number() 会得 NaN，`NaN <= stage` 恒 false，
          这个键的「到点未死」永远不判
② 再加 isRegisteredKnife(death)（刀号必须在登记表里）
③ 自检样例（必须真红）：{ kind:"T", death:"9b" } → 红；{ kind:"T", death:8.7 } → 红
```

### ⑤ 配套的文档刀号判据（A/B/C 三选，裁定 C）

**C：带字母的刀号必须"看得见是名字"**——只许出现在引号/反引号里（`` `刀 5b` `` / 「刀 5b」），
裸写一律红。判据实现：逐行先剥掉 `` `…` `` / 「…」 / "…" 的区间，再扫 `刀\s*\d+[a-z]`。

为什么不是 A（只扫账本级文件）或 B（历史写法要带"原/旧"标记）：

```
A 的清单会漂：每个刀都会新建一份 `knifeN-plan.md`，它到底是"当前状态"还是"历史"，
  取决于每句话而不是文件；把文件分类写死，下一个作者就得再判一次该不该登记。
B 的标记会漂：现有 6 处命中里，:9 / :35 / :71 三处是"描述坏形态"，不是"引用旧名"，
  还得再设计一种写法（`刀 5b`（历史坏形态，勿用）），反而把人绕进去。
C 没有清单：规则一句话——裸写必须是真刀号，名字必须加引号。代价是改 1 行
  （`knife-numbering.md:35` 的表格里 `刀 5b` 补反引号），其余 5 处本来就在引号里。
```

现行 6 处命中（实测）里 5 处合规、1 处要补反引号；**而 `刀9b 19 = 19 C` 这种裸写会被 C 直接挡住**——
那正是这条判据要防的。

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
| **9** | 删 **5 个真死的** T（键 + 转发器）；20 个过期死期重判（6 转 C · 3 删 · 11 重算）；落 §八 ② | 5 个（§三） |
| **9.1** | 视图切换：`showView` 的 pages 段进 `enter`（`hydrateView` 的 `loadPageNumberSummary` 随 9.4） | 4：`loadSetupSuggestions` · `renderPageSetup` · `loadLanguageSummary` · `pausePageThumbnails` |
| **9.2** | 任务轮询与可见性：`pollTask` / `fetchPageBlocks` / `schedulePageVisibility` | 5：`refreshRecognizedPages` · `updateMarginDetectProgress` · `updateRecognitionAuxProgress` · `queueOverlayRender` · `updatePageVisibility` |
| **9.3** | 版心一族（对话框 / 进度 / 瓷砖 / 拖动保存） | 12：`renderMarginStepVerdict`* · `setMarginStatus` · `showMarginDetectProgress` · `ensureMarginFitted` · `renderMarginPanel` · `refreshMarginTiles`* · `finishMarginDetectBar` · `refreshLayoutDetectEntry`* · `refreshMarginDetectHint`* · `loadLayoutBlocks` · `renderLayoutBlocks` · `savePageMargin` |
| **9.4** | 页码一族（三个面板宿主 + 指标） | 3：`loadPageNumberSummary` · `setPageNumberStatus` · `renderPageNumberMetrics` |
| **9.5** | 选择 / 网格 / 步骤 / 收尾 / 其它 | 12：`syncPageStates` · `forgetAllPageSuggestions` · `forgetAllPageBlocks` · `renderPages` · `visiblePages` · `reloadProjectPages` · `pageScroller` · `renderAutoApplyStatus` · `renderWorkflowFilter` · `checkSelection` · `renderStepPanels`* · `renderRecognitionStatus` |
| **9.6** | 版心撤销按钮的接线收回模块（§三 改判） | 1：`undoMarginEdit`（→ 模块自建按钮 + `marginUndoButton` 工厂删除） |
| **10** | 队列子系统 + 渲染域：`fetchPageBlocks`（连三份缓存）+ `schedulePageVisibility` + 两个泵 | 4：`pumpOverlayRender` · `scanVisiblePageSuggestions` · `queueOverlayRender` · `updatePageVisibility` |

合计 **5 + 4 + 3 + 12 + 3 + 12 + 1 + 4 = 44** ✓（刀 9 的 5 = 真死；9.2 的 3 收成 2 个 C，净 −1）
（刀 10 与其它子刀的区别：那两个键的"死"不是删键，是**把整条队列搬走**——它们今天有值位引用，
 只删键会留下 ReferenceError；而且是**队列先行、键后死**：只搬调度器，外壳的泵就没有喊话对象。）

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

## 十二、刀 8 落盘对集（快照，不是权威；权威 = §五 + 落盘 `kinds` 表）

> 树：`main@64f5e3a`（刀 8 已落）。日期 2026-10-30。方法：**集合相减**，不数总数。

```
① R3          node scripts/r3_pages_count.mjs --json → total 0 · ids 0 · rows 0     ✅
② 豁免表      0 项 · TOTAL_CAP 0 · Σcap 0 · PENDING 0 · BLOCKED_MAX 0               ✅
③ seed        0 行（stage2-movers-seed.md 里 `| \`` 行计数 = 0）                     ✅
④ R8          61 键（pages-view api 现扫）                                            ✅
⑤ kinds       L 1 · T 44 · C 16 = 61                                                 ✅
⑥ 死期分组    刀9:8 · 9.1:4 · 9.2:5 · 9.3:12 · 9.4:3 · 9.5:12 = 44（与 §十 逐键相等）✅

集合对集（不是总数）：
  T  文档 44 vs 落盘 44 —— 只在文档：无 · 只在落盘：无
  C  文档 16 vs 落盘 16 —— 只在文档：无 · 只在落盘：无
  （C 的 16 = §四 的 13 + 刀 8 的 setPackageModeChrome / syncProjectSettings / setSelectionHint）

> 本快照之后（同日）复核出：`9:8` 里只有 5 个真死、3 个是值位引用 ⇒ 死期表要改成
> `9:5`（真死）· `9.6:1`（undoMarginEdit）· `10:2`（两个泵，随队列子系统搬）
> 快照保留原样（它记的是那一刻的树），但别拿它当现表。

记法坑验证（§四 的预登记）：app.js 里 `setPackageModeChrome` 是 **2 处**（applyPackageMode 的 if/else
两个分支），而 kinds 的 `callers` 是 `["applyPackageMode"]`——**函数名，不是处数**。落盘正确。

旁证（刀 8 按裁定落，不是按旧图）：app.js **13,428 → 13,428**（一行没少），pages-view **3,194 → 3,243**（+49）。
刀 8 是"把 pages 的 13 处写点换成 3 个能力调用"，不是"搬三个函数"——所以 app.js 行数不该降。
若将来有人报"刀 8 搬走了 applyPackageMode"，与这个行数矛盾，一查就出来。

## 十三、另案：deps 表里的死键（23 个，2026-10-30 实测）

**口径**：`window.PagesView?.init({ … })` 里的每个键，在 `pages-view.js` 里搜 `injected.<键>`；
0 次 = 模块从未读过（无解构、无 `injected["x"]`，已核）。

```
实测（`b1c22e4`）：deps **219** 键，**22 个从未读**（`main@e9ddc2a` 时是 218 / 23——9.1 加了 `queueAfterSteps`，它被读，所以未读数反而少 1）：

pageMarginStorageKey · pageOverlayStorageKey · renderRecognitionSettings ·
AUX_TEXT_LAYER_SECONDS_PER_PAGE · PAGE_SUGGESTION_CONCURRENCY · getPageSuggestionActive ·
pageSuggestionPending · pageSuggestionQueue · getSelectionAnchor · getSetupSuggestions ·
getSetupSuggestionsLoaded · getSuggestionScanTimer · renderPages · divergenceChip · handleTileClick ·
recognitionChip · reviewBadge · startTileMarginDrag · tileClassName · tileTitle · workflowChip ·
token · setPageBlockPending
```

**为什么它今天不会被发现**：R13 只查「缺键」（`injected.x` 必读形态而 deps 没这个键 → 红），
**多出来一个键不红**。于是注入面只涨不消 —— 和「豁免表只涨不消」「0 引用函数没人删」是同一族。

```
到期点：刀 10（收口）与 §十一 的零引用函数一起清；清完再开「deps 多键 = 红」。
注意：删 `renderPages` 这类键之前要确认模块里没有**同名本地实现**（pages-view 自己有 renderPages，
      这个 deps 是自环）；`getSuggestionScanTimer` 已在刀 10 的清单里。
```
