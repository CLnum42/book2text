# 导出棘轮：两类键 + 生命周期类（Architect 裁定）

> **当前状态（2026-11-01，`20049f9`，刀 11 已落盘）**：导出面 36 键 = **T 0 / C 34 / L 2**，`death:` 字段全表消失，
> names 与 kinds 两向相等 ⇒ §七 的终态判据**已达成**（10.2 达成，11 坐实）。另两条只涨不消的账也归零：
> **deps 173 里模块 0 读 = 0 条** · **顶层 function 371 里 0 引用 = 0 个**，两条闸已打开且带喂坏样本自检。
> 一句话口径：**T 归零在 10.2，账本干净在 11。**
>
> 裁定 2026-10-30。回答 `docs/refactor/pages/knife9-key-ledger.md` §三 的 a/b/c。
> 量数树：`6d4492f`（app.js 13,462 行 · pages-view.js 3,126 行 · api **57** 键）。
> 一句话（当日）：**两类的划分成立，但"能力面"必须是一份逐键清册（不是数字上限）；
> `22` 是减法算出来的、`3` 做不到。** ← 后半句"可达终态 ≈ 19"已于 2026-11-01 作废：
> 终态不是一个数，是 §七 那五条判据；实际落在 36（② 推导值，不是目标）。

> 判据本身怎么失效（恒真 / 空转 / 错位）见 [`docs/refactor/false-green-criteria.md`](../false-green-criteria.md)——每条都带可复现命令。

## 一、三类，不是两类

| 类 | 定义 | 判据（机检） |
|---|---|---|
| **L** lifecycle | `init` / `enter` 必备——进出视图；**`refresh` 不是 L 的固定成员**（刀 11 裁定，见 §七） | `{init, enter}` 必须齐；额外 L 键只在**点名表**里合法（今天空表）。`refresh` 只在 `index-view.js` 有，且是**业务方法**不是生命周期键 |
| **T** transitional | 只因为"代码还没搬完"而存在的键：它唯一的调用形态是**同名薄转发器**，转发器的调用者是 pages 域、迟早搬进模块 | **必须带 `death: 刀N`**；到点后键与转发器都必须不存在。**终态实测形态：T 归零后 `death:` 这个字段整张表一个都不剩**（不是留空数组、不是留 `death: null`）——机检据此判「还没有死期残留」 |
| **C** capability | 触发者在**别的域**：别的 `*-view.js` 经 `injected` 调，或外壳的**永留编排函数**调 | **不写死期**；必须登记 `callers`（函数名 / 模块名清单，**非空**）+ `Capability-Reason` |

**接线算不算能力，看被挂载的元素归谁**（2026-10-30 由 9.3 实测定下，比"9.6 有先例"更根本）：

```
元素在自己 section 里            → 模块自己接（搬接线）：window 级 pointer 监听、
                                  9.6 的 marginUndoButton（壳给空件、模块挂 handler）
元素在 dialog / 外壳 chrome 里    → 模块**碰不到**它（R3 模块侧零豁免），只能收能力：
                                  如 #confirm-dialog 里的 layout-detect-start（:1641，字符位置在全部
                                  section 之后）⇒ 9.3 的 onLayoutDetectStarted 是**不得不**收的键
                                  第二个实例（9.5）：#finish-check-engine（index.html:1721，字符位置
                                  87,506，也在所有 view section 之后）⇒ checkSelection 的唯一天线
                                  （setupReviewControls:11176）搬不动 ⇒ **T 换类成 C**，不是删键
```

所以"能不能搬接线"不是偏好问题，是 DOM 归属问题——先查那个元素在哪个 section 里，再决定。

**一个能力键不许兼两种语义**（2026-10-30 由 9.3 的真实缺陷定下）

```
反例：原先想用 onTaskProgress 兼两件事——每 tick 的进度、收尾后的重画。
      两处的 payload 是**同一份 job 对象** ⇒ 模块无法判断"这次调用来自哪一点"；
      若按 status 分派，收尾那一 tick 会在读回状态之前就先重画/拟合（写盘用了旧 state）。

判据：一个 C 键的多个调用点，若 **payload 相同而语义不同** ⇒ 必须按语义拆成两个键。
      payload 里不许塞"该调哪个函数"的字段来补救（那是 pagesOp(op,arg) 的变体）。

边界：**按数据分派允许**——job_type / status 决定"画哪个面板"是模块自己的事；
      **按数据猜调用点不允许**——同一份 payload 在两个时刻含义不同，就不许合并成一个键。

落地（9.3）：最终是 `onTaskProgress`（每 tick）+ `onTaskFinished`（收尾）**两个键**，
      没有做"扩语义 + 改名"。这条规则就是那次的产物。


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

### 9.3 的形态（2026-10-30 落盘后回填，两份独立分类表逐字吻合）

```
12 个键的调用点全部落在 7 个宿主里，没有一个漏在别处
⇒ 这刀的风险不在键，在宿主：7 个宿主里 5 个是 b 类（跨域编排），只有 2 个是 a 类（单视图动作）
```

| 死法 | 键 | 处理 |
|---|---|---|
| **a（跟宿主搬）2** | `loadLayoutBlocks` · `renderLayoutBlocks` | 宿主 `scheduleLayoutBlocks` 只被模块调 |
| **b（收能力 / 改直呼 / 搬接线）10** | 其余 10 个 | 6 处以事件能力收（B1 的 12 个调用点）· 2 处接线：**版心拖动搬进模块**（window 级 pointer 监听 + handler 有 `tileMarginDrag` 守卫）、**`layout-detect-start` 搬不动**（在 `#confirm-dialog` 里，不属于任何 view section）→ 收能力 |
| **+3 入口键（实际落盘值）** | `onTaskFinished` · `onWorkflowLoaded` · `onLayoutDetectStarted` | 前两个是"收尾"与"工作流重载"两个**不同语义**（规则①：不许合进 `onTaskProgress`）、第三个是搬不动的那处接线 |

⇒ **9.3 = 52 − 12 + 3 = 43** · C 18 → 21 · ② 推导值 24 · deps **219 → 214**
（逐笔核过：−4 自环 · −2 宿主 · −1 死键 `startTileMarginDrag` · +2 拖拽簇共用的 helper `applyMarginRect` / `nearestEdge`。**213 是 9.3 中途那一版的数，作废**——那时还没有这两处 helper）
（自环 −4 在"改直呼"那笔死、宿主 −2 跟 a 类键走，**两列分开记**）

> `onTaskProgress` **没有改名**：扩语义的方案被 §一 的规则①否掉，改成新增 `onTaskFinished`。
> 曾写过的 `onTaskEvent` 与 `onWorkflowRefreshed` 两个名字**作废**（前者是合并、后者与落盘名不符）。

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
| **9.2** `onTaskProgress(data)`（**不改名**——扩语义方案被 §一 规则①否掉） | pollTask（每轮轮询，:5366-5367） | 外壳持有 job，模块只负责把进度画到版心/复核面板；job_type 的分派模块**本来就有**（pages-view:770 / :1718 自带守卫），外壳那两行 `if` 是重复分派 |
| **9.2** `onRecognitionFinished(donePages, opts)` | pollTask（收尾分支 :5398 / 运行分支 :5419） | 任务结束后的"作废旧块 + 重载"由外壳触发；两个调用点参数不同（`reloadDetail`） |
| **9.3** `onLayoutDetectStarted(...)` | setupLibrary 的 `layout-detect-start` 接线（:1641，在 `#confirm-dialog` 里） | 该按钮不在任何 view section，模块碰不到 ⇒ 只能由外壳调用 |
| **9.3** `onTaskFinished(...)` | pollTask（收尾分支） | 「收尾重画」与「每 tick 进度」payload 相同、语义不同 ⇒ 按规则①拆键，不并进 onTaskProgress |
| **9.3** `onWorkflowLoaded(...)` | loadWorkflow（经 renderLayoutStatus） | 工作流数据重载后，模块重画版心检测入口 |

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
刀 9.1 （−4 +1）  53 = T 35 + C 16 + L 2   showView 的 pages 段搬进 enter()（hydrateView 的 loadPageNumberSummary 随 9.4）
刀 9.2 （−3 +2）  52 = T 32 + C 18 + L 2   pollTask 的三处收成 2 个能力（§三）
刀 9.3 （−12 +3） 43 = T 20 + C 21 + L 2   版心 12 键全死；+3 键（onTaskFinished / onWorkflowLoaded / onLayoutDetectStarted）
刀 9.4 （−3）     42 = T 17 + C 23 + L 2   ← 已落盘（先前的 40 是预测值，作废）
刀 9.5 （−11 +8） 39 = T 5 + C 32 + L 2   ← 已落盘（`b135d44`）
          42 − 11(T 死) + 8(新能力) = 39；checkSelection 是**同一个键换类**（T −1 / C +1，总数不动）
          · 11 个 T 死 · 8 个新能力（onPagesReloaded / onPagesRendered / onAuxStatusChanged /
            onPageStatesChanged / onAutoApplyChanged / onWorkflowStepChanged /
            onPageBlocksInvalidated / onPageSuggestionsInvalidated）· renderWorkflowFilter 并入 onWorkflowLoaded（0 新增）
          · deps **208**（214 − 7 + 1 openMasks）· 行数 app.js 13,197 → **13,078**（−119）· pages-view 3,532 → **3,704**（+172）
          · 转发器删 **11** 个（不是 12：:4774 是 checkSelection 的转发器，它判 C 后仍在 api）
          · 选择族搬入 **75** 行（不是 62：另含 selectOnly 5 行 / toggleSelection 8 行，族内 3241/3269/3271 调它们）
          · keydown 块 **12777–12791**（15 行含 1 行注释），12792 起是 platform-warning
刀 9.6 （−1 +0）  38 = T 4 + C 32 + L 2   ← 已落盘（`834b8a1`）
          undoMarginEdit 接线收回模块（撤销按钮由模块自建）；② 推导值仍是 35（C 未变）
          · deps 208 → **206**：只删 `marginUndoButton` / `trimMarginUndo` 两条
          · **`getMarginUndoStack` 不属 9.6**：它在 **LibraryView** 的 init 块（app.js:12933–12982），
            library-view.js:292 用它清撤销栈 ⇒ 不是 pages 块的字死注入，别下一刀再判一次
          · 行数 app.js 13,078 → **13,054** · pages-view 3,704 → **3,723**
刀 10.1（−3 +1） 36 = T 1 + C 33 + L 2   ← 已落盘（`c210bd0`，拆刀见 `09087db`）
           块框队列与可见性调度搬进模块：3 键死（updatePageVisibility / pumpOverlayRender / queueOverlayRender），
           新能力 `onPagesNeedReflow`（callers 4：refreshAfterTypeChanges · applySplitBatch · showView · library-view）
刀 10.2（−1 +1） 36 = T 0 + C 34 + L 2   ← 已落盘（`b61634d`）**T 归零**
           建议扫描队列搬进模块：`scanVisiblePageSuggestions` 死 + `pumpPageSuggestionQueue` /
           `ensurePageSuggestion` / `scheduleSuggestionScan` 与七份队列状态搬入，新能力 `onPagesShown`
           · 实测对集（我复算，非抄）：**names 36 == kinds 36**，两向无孤儿（36 键全有 kind、无 kind 不在 names）
           · 全表 `death:` **0 个**（不是空数组）· `init` 的 callers 缺省、34 个 C 的 callers 全非空
           · deps **186** · app.js 13,054 → **12,866**（−188）· pages-view 3,723 → **3,907**（+184）
刀 11 （±0）      36 = T 0 + C 34 + L 2   ← 已落盘（`20049f9`，5 笔）**账本干净**：导出面一个键不动
           清理刀，清的是"只涨不消"那两笔 + 开闸（不是补一个到达终态的键）：
           · 13 条死 dep：deps **186 → 173**；落盘后实测「deps 173 里模块 0 读」= **0 条**
           · 0 引用顶层函数 **10 个**（9 + 级联 1）：381 → **371**；落盘后实测 0 引用 = **0 个**
           · 3 处孤儿注释（"重置为「本页自动」""第二引擎复核全书"等，实现都在模块里）
           · 行数 app.js 12,866 → **12,755**（−111）· pages-view **3,907 不变**（清理没碰模块）
           · 两条闸打开（`fd2e35e`）：deps 多键 / 0 引用顶层函数，各带"喂坏样本必须红"的自检；
             另有反向闸（导出 `refresh` 或 C 键带 `scope:`/`op:` 字段 = 红，替代已作废的 `PAGES_REFRESH_SCOPES`）
           · 实际提交形态：**两笔 test-contract + 一笔产品清理 + 一笔级联**（比计划多一笔——
             `divergenceCandidatesOn` 下面那条 `dual_engine_strategy` 断言锁的源码也只存在于该函数体内）
           · **「11 个」是错的，用 10**：`3e00037` 只删 9 个函数，`charAdvance` 在 `20049f9` 才删。
             381 − 10 = 371 与实测吻合；按 11 算会得 370，与树对不上。
             ⚠ 根因：`3e00037` 提交说明写的是"这一刀要删的清单"，不是"这一笔删了什么"——
             **账要按 diff 记，不按清单记。**

> 记录更正：`92ddc4e`（刀 10.1）提交说明里写「② 推导值 37」，实际是 **36 = C33 + 3**。不改历史，在此更正。
```

> **T 归零在 10.2（`b61634d`），账本干净在 11（`20049f9`）**——两件事，别写成一句"10.2 收口完成"。
> 10.2 只保证"外壳不再有函数级转发"；11 保证"注入面与死代码也归零"。判据（§七 五条）在 10.2 就全绿，
> 11 是把它**坐实**成一个不会回涨的状态：两条闸就是那两根钉子，钉的是"下次不许再攒回来"。

> **`onWorkflowLoaded` 扩参的落法（9.5 实测）**：调用**留在 try/catch 之外**（今天的 5382 那一处 +
> package 分支 5356，共 2 处调用位），参数用 try 前声明的变量带出；**别把调用挪进 try**——
> 9.3 的 `refreshLayoutDetectEntry` 一抛错会被本 catch 抓住、再用 `{}` 调一次 ⇒ 双重调用 + 错参数。

**曲线以后按"这个键能不能搬"算，不按"这一刀有几个键"算**（今天三次同型）：每个 T 只有三种死法——

```
① 宿主是单视图动作 → 宿主搬走，键死于那一刀（9.1 / 9.3 / 9.4 / 9.5）
② 宿主是跨域编排（pollTask / 面板 / 别的视图）→ 键**本来就不是 T**：收成 C（9.2），
   或由"宿主搬走 + 元素归属"判出的接线搬入吃掉（9.6 / 10.1）
   ~~「由 refresh 吸收」~~——**这条路 9.5 之后作废**：`refresh` 从未建成，也不该建（§七 刀 11 裁定）
③ 宿主属于"子系统"（队列 / 渲染域）→ 随子系统整体搬（刀 10.1 / 10.2）
```

没有第四种。所以"某刀 −5"这种数要先逐键过这三条才能写。`enter` 建在 9.1 是按语义钉的；
`refresh` 曾在 9.5 的图里被当成第三个 L 键，实际 9.5 落盘时 **L 仍是 2**（`b135d44` 实测 `init/enter`），
刀 11 已把「`refresh` 要存在」这条假设正式作废 —— 中间值会动，但 **T 归零这一步不会**。
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

（连同 8 个死 T 一起，本章的 36 个 T 全部有归属，没有一个键"没人负责死"。
**2026-11-01 更新**：这 36 个已全部死完（刀 10.2 `b61634d` 起 T = 0），本节留作逐刀的施工依据与快照。）

## 七、终态的**三个概念**：别混成一个数字（`3` 因此作废）

2026-10-30 那天出过「22 / 19 / 21」三个数打架，根子就是把下面三件事混在一个数字里讲。以后分开说：

| 概念 | 判据 | 现在（`20049f9` 实测） |
|---|---|---|
| **① 终态判据**（定义"收完"） | `T == 0` ∧ `L ⊇ {init, enter}`（额外 L 键须在点名表，今天空）∧ `kinds` 与 `names` **两向相等** ∧ 每个 C 的 `callers` 非空 ∧ 表里 `death:` 字段 0 个 | **已达成**（T 0 / L 2 / C 34 / names 36 两向无孤儿 / death 0） |
| **② 推导值**（会变，**不是目标**） | `C 的条数 + L 的条数` | **36 = C 34 + L 2**（T 归零后未再变；此后随 C 变，不预先写死） |
| **③ 防漂兜底**（只降不升） | `R8.total` 每刀 ≤ 上一刀；历史峰值 **61** | 现在 **36**（9.3 的 43 是中途高点，此后 42 → 39 → 38 → 36 → 36 一路降） |

- ① 是**判据**，能被机检（五个条件各自可数）；② 是 ① 的算术后果——C 一变它就变，
  **它不许进任何"目标"句式**；③ 是防"收口反涨"的棘轮，不是"要做到多少"。
- 谁在报告里写"终态 36"，必须同时说明那是 ②（推导值），不是 ①（判据），否则下一个人会拿它当目标去凑。

**五条判据各自落在哪条闸上**（写清楚，免得下次有人以为"判据"是纸面承诺）：

```
T == 0                         → 死期表翻面（66a5c78 / a511dd8：空表 + T==0 → 绿，终态合法）
kinds 与 names 两向相等        → exportKindProblems（boundary.test.mjs:4157，两个方向都查）
每个 C 的 callers 非空         → exportKindProblems:4188
kinds 里 death: 字段 0 个      → 同上（T 才许带 death；表里没有 T 就没有 death 字段）
L ⊇ {init, enter}              → ⚠ **还没有闸**。今天它是"数据事实"（`init`/`enter` 在 names 且 kind=L），
                                 靠人看。**待补一条**：每个视图模块的 names 必含 `init` 与 `enter`，
                                 且两者 kind 为 L——约 6 行，交 TestDev 同批加（刀 11 开闸时漏了这条）
```

最后一行是本节的**已知缺口**，不是"已达成"的一部分：判据里写着"必须机检"，就不能有一条只靠人眼。

### 一条实测佐证：判据翻面不该改代码（TestDev，刀 10.2）

死期表那条判据在 T 归零前后**分支代码一行没改**——数据从「T 还有 1 个」变成「T = 0」，
同一条 `exportDeathProblems` 自己从"看表里哪条到期"走到终态分支（`boundary.test.mjs:4090–4105`；
翻面说明在 `:4041–4047`）。它没有"空表 + 到期刀"那个常数了：`EXPORT_DEATH_EXPIRES` 当场删掉，
理由是——翻面后它不再影响任何分支，却还挂在开关表里写着"死期表为空时是否已经到期"，
**看着在管、实际不管**，正是这半年一直在收的那种东西。

判据该是这样：**它描述事实；事实变了它翻面，不追着事实改。** 反过来（为终态改一版判据、
下一次再改回来）会留下两套口径——本项目最贵的三次弯路都是同一族的。

### 刀 11 裁定：`L == 3` 作废，判据改成 `L ⊇ {init, enter}`（2026-11-01）

原判据里那句 `L == 3（init / enter / refresh）` 是我 2026-10-30 定的，当时假定 views 都该有第三个
生命周期键 `refresh`。**`refresh` 从来没建成**（9.5 落盘实测 L 仍是 2），刀 11 要决定的是要不要为凑
这个数去建它。裁定：**不建**，判据改 `L ⊇ {init, enter}`，理由是四条**代码里的事实**，不是偏好：

```
① 项目已经否决过这个形态。index-view.js:34–35 写着「**没有参数包**……（§20.6 明确否决
   `refresh({toggles:false})` 这类配置项化入口）」。刀 11 的 A 形态 `refresh({pages:true})`
   正是把被否决的那个入口换个字段名复活。
② `refresh` 在本项目里有**写死的窄语义**：index-view.js:36–37「`refresh()` 只重画装饰与开关态，
   **不做数据加载、不做全量重建**；换清晰度档要取图，所以走 `applyImageQuality()`，不走 `refresh()`」。
   而候选键里 `onProjectPagesReloaded`（pages-view.js:3396–3398）就是 `await reloadProjectPages()`——
   **一次数据加载**。并进去 = 同一个词在两个模块里两个意思 ⇒ 又造一个"同一概念两个口径"（D-106 那族）。
③ 那几个键各自绑一个**单一动作**，不是"重画"的粒度：
   `onPageStatesRefreshed→syncPageStates`(3406) · `onWorkflowStepChanged→renderStepPanels`(3416) ·
   `onPageBlocksInvalidated→forgetAllPageBlocks`(3421) · `onPageSuggestionsInvalidated→forgetAllPageSuggestions`(3426) ·
   `onPagesNeedReflow→schedulePageVisibility`(3436) · `onPagesShown→pumpPageSuggestionQueue`(3446) ·
   `onAuxReviewFinished→renderRecognitionStatus`(3401)。
   合成 `refresh(scope)` 后模块内部仍是一条 if 链——**调用点失去语义**，§八 ③ 的"每键 callers"清册
   塌成一条大名单，两向机检失去分辨率（"把 T 改标 C 必须逐个写调用者"这条防线随之失效）。
④ 数字收益是假的：A 形态的 24 只是把 14 个身份藏进一个 `scope` 字段。
   导出面按"身份"算一个都没少，只是变得不可机检——与规则①（`export-ratchet.md` §一
   「一个能力键不许兼两种语义」）同一条：**不许靠字段猜调用点**。
```

**判据应描述事实，不该反过来逼事实。** C 是"为判据加键"（C 形态 `refresh()` 无参全量重画 = 纯数字达标、
不吸收任何 C、还多一个语义含糊的键），所以不走。

```
终态（2026-11-01 版）≡ T == 0（外壳不再有任何函数级转发）
     ∧ L ⊇ {init, enter}，额外 L 键必须点名（今天空表）
     ∧ kinds 与 names 两向相等（36 == 36，无孤儿键、无未分类）
     ∧ 每个 C 的 callers 非空
     ∧ kinds 表里 `death:` 字段 0 个（T 归零的机检形态：字段整个消失，不是留空数组）

数字由设计决定，不由指标决定。C 多一个少一个，不改"收干净了没有"这个判断。
```

**`refresh` 的合法复活路径**（写下来挡住"下次又有一个人想加"）：某个视图真需要"状态变了、重画一下"
的入口时，它进**点名表**（`额外 L 键`）+ 写清三件事——为什么现有的 C 键吃不下、payload 是什么、
callers 是谁；过不了这三关就不加。今天点名表是**空表**。

### 为什么 `3` 做不到（判据作废，理由是历史，留着防再犯）


`init / enter / exit` 只能表达"进出视图"，表达不了下面这些**跨域触发**：

```
别的视图要它：syncToolbarToggles（4 个模块）· loadFinishSummary（3 个模块）
外壳编排要它：setPackageModeChrome / syncProjectSettings / setSelectionHint（刀 8）
             showPagesError / pagesErrorMessage / setMarginJudgementCheckbox（刀 6）
             applyPageZoom（缩放三步共用）· startLayoutDetection（版心对话框）· confirmAllUnconfirmed（收尾面板）
入口要它：   recognizePage（审校面板的「重新识别」）
```

**「T 归零」这条判据是 2026-10-30 定下的**（作废「导出到 3」与「终态 19」），
`L == 3` 那一半由 2026-11-01 的刀 11 裁定改成 `L ⊇ {init, enter}`（见上）；完整版只剩上面那一处，
**本节不再有第二份抄本**（同一判据写两遍就是下一个漂点）。

**为什么不是数字**：今晚三次同型（刀 8 的三个函数、9.6 的两个泵、9.2 的三个宿主）说明——
宿主搬不动时，杀掉一个键就多一个能力键，总数只是换了个类；拿数字当目标会逼人为凑数做设计选择
（我们差点为 3 凑一次）。而「T 归零」可判定，且正是 R8 的初心：外壳不许伸手进模块内部，
只能按语义叫它。

**防漂的替代**（不留空档）：① `R8.total` **只降不升**（峰值 61，今天 36，往后每个数都不许回升）；
② 每加一个 C 键 = 改清册 + 写 `Capability-Reason`，两向机检（§八 ③）会拦"清册被随手放宽"。

> **推导值的正确读法**（别再抄成目标）：`b61634d` 实测 **36 = C 34 + L 2**。
> 历史上它被写成 19 / 21 / 22 / 24 / 25 / 35 都只是各刀当时的算术后果，逐一作废。
> 它随 C 变，所以**任何一句"终态 N"都必须紧跟一句"这是②不是①"**。

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
④ ~~refresh 的 scope 枚举：PAGES_REFRESH_SCOPES 登记（≤6 个）~~
     **作废（2026-11-01 刀 11 裁定）**：`refresh` 不建 ⇒ 没有 scope 可枚举。
     但这条的**意图**保留成一条反向闸：`pages-view.js` 的导出名里若出现 `refresh`、
     或任何 C 键出现 `scope:` / `kind:` / `op:` 这类"该走哪条路"的字段 → 红。
     （它防的正是被否掉的两种形态：`refresh({pages:true})` 与 `pagesOp(op,arg)`）
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
| **9.2** | 任务轮询：`pollTask` 的 pages 写点收成 2 个能力（`fetchPageBlocks` / `schedulePageVisibility` 随刀 10） | 3：`refreshRecognizedPages` · `updateMarginDetectProgress` · `updateRecognitionAuxProgress`（收成 C，净 −1） |
| **9.3** | 版心一族（对话框 / 进度 / 瓷砖 / 拖动保存）。**12 个键的调用点全部落在 7 个宿主里，没有一个漏在别处；这刀的风险不在键，在宿主——7 个宿主里 5 个是 b 类** | 12 全死：死法 **a 2**（`loadLayoutBlocks` · `renderLayoutBlocks`）· **b 10**（6 处以事件能力收、2 处接线搬进模块、其余并入上述入口）· **+3 个入口键**（落盘值）：`onTaskFinished` · `onWorkflowLoaded` · `onLayoutDetectStarted` |
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

**已于刀 11（`20049f9`）全部删除**：实际删了 **10 个**——原名单 9 个之外还有 `charAdvance`
（`textAdvance` 删掉后它成了新叶子，被「0 引用顶层函数 = 红」闸在实树上抓出来，不是人眼找的）。
测试侧同批改两处：`divergenceCandidatesOn` 的存在性断言，以及它下面那条锁
`dual_engine_strategy === "candidates"` 源码的断言（改成查模块里的读点
`recognitionSetting("dual_engine_strategy")`，语义不变）。


**复测（`b61634d`，app.js 12,866 行；三栏口径同上）**：顶层 `function` 声明去重 **381** 个，
**production 代码 0 引用 8 个 + 1 个只被测试源码断言撑着 = 9 条，一条没少**（只是行号全移了）：

```
ensureReviewPage(5708) · pendingBlockCount(6108) · textAdvance(6837) · handleDiffMarkClick(7143) ·
queueKey(7149) · selectLineInTextarea(8409) · textRows(8425) · punctGroupByKey(12102)
divergenceCandidatesOn(2187) —— 只被 tests/integration/test_ui_assets.py:797 的源码断言撑着
```

**口径提醒**：把 `tests/` 算进"引用"时，`divergenceCandidatesOn` 就不是 0 引用；把它算进"待清理"时，
它就是 0 引用。**同一个名字两个数，取决于你数哪棵树**——所以清理账要两列并列写，别只写一个数。

### ✅ 已于刀 11 删除（`20049f9`，2026-11-01）

上面那 9 条**全部删掉了**，另加 1 条级联，共 **10 个**；app.js 顶层 `function` **381 → 371**，
落盘后实测「0 引用」= **0 个**，闸②（0 引用顶层函数 = 红）已打开并带喂坏样本自检。

```
3e00037  删 9 个：ensureReviewPage · pendingBlockCount · textAdvance · handleDiffMarkClick · queueKey ·
                 selectLineInTextarea · textRows · punctGroupByKey · divergenceCandidatesOn
20049f9  删 1 个级联：charAdvance——原只被 textAdvance 调用，textAdvance 一删它就是新的叶子
```

三条值得留档的事实：

```
① **级联是新闸抓出来的，不是人眼找到的**：闸②第一次在实树上跑就报了 charAdvance。
   这是"判据自己抓到了它该抓的东西"的证据——比任何一次绿色都更说明闸是活的。
   （也说明"从叶子往上删"这句话是对的：删叶子会生新叶子，要跑到 0 为止，不是删一轮。）
② `divergenceCandidatesOn` 的死因链比预想长：函数删了，但它体内那句 dual_engine_strategy 断言
   还锁着源码，pytest 红 ⇒ `4fac5b4` 把断言改指模块的 `recognitionSetting(...)`。
   **"0 引用函数"不等于"删了就绿"——源码断言也算耦合**，而且是 grep 最容易漏的那一半。
③ 提交说明里的数要按 diff 记：`3e00037` 的标题写「10 个」、正文写「9 个」、列了 10 个名字，
   实际 diff 只删 9 个。这类错不会让任何闸变红，只会让下一刀的账算错——**账按 diff 记，不按清单记**。

口径的坑（我自己第一次扫错了一次，值得写下来）：只用 `(?<![\w$.])name` 会把
`list.append(...statsRow(…))` 里的**展开调用**当成属性位漏掉（`statsRow` 明明是活的），
于是报出 11 个"死函数"而不是 9 个。判据要三栏都扫：定义位 / 值位 / 调用位，属性位单列。
另外 `statsRow` 这类名字是**别的活名字的子串**（`renderStatsRow…`），人肉 grep 也会骗人。

**顺序：先删到 0，再开闸。** 现在开"0 引用函数 = 红"会红 9 条，其中 1 条还被测试断言撑着；
先开闸等于又要一张豁免表（本项目已经在这上面栽过两次）。

**到期点：刀 11（已完成，`20049f9`）**，逐个选，不是整批：

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

## 十三、另案：deps 表里的死键（**0 个**，刀 11 已清；`20049f9` 前是 13）

**口径**：`window.PagesView?.init({ … })` 里的每个键，在 `pages-view.js` 里搜 `injected.<键>` /
`injected["<键>"]`；0 次 = 模块从未读过。

```
实测（`b61634d`）：deps **186** 键，**13 个从未读**：

pageMarginStorageKey · pageOverlayStorageKey · renderRecognitionSettings · AUX_TEXT_LAYER_SECONDS_PER_PAGE ·
getSetupSuggestions · divergenceChip · recognitionChip · reviewBadge · tileClassName · tileTitle ·
workflowChip · token · setPageBlockPending
```

历史（**别照抄旧名单**，每刀都在掉键）：`b1c22e4` 是 219 / 22，`e9ddc2a` 是 218 / 23。刀 9.4–10.2
搬走队列与渲染子系统时，`PAGE_SUGGESTION_CONCURRENCY` / `getPageSuggestionActive` / `pageSuggestionPending` /
`pageSuggestionQueue` / `getSuggestionScanTimer` / `renderPages` / `handleTileClick` / `startTileMarginDrag` /
`getSelectionAnchor` / `getSetupSuggestionsLoaded` 这 10 条**跟着一起没了**——不是被单独删掉的，
是搬家时注入表整段重写带走的。**所以清理账每次都要重扫，不能按旧清单减。**

**为什么它今天不会被发现**：R13 只查「缺键」（`injected.x` 必读形态而 deps 没这个键 → 红），
**多出来一个键不红**。于是注入面只涨不消 —— 和「豁免表只涨不消」「0 引用函数没人删」是同一族。

```
到期点：刀 11 —— **已完成**（3e00037，deps 186 → 173）。落盘后实测「deps 173 里模块 0 读」= **0 条**，
      闸①（deps 多键 = 红）已打开（fd2e35e），口径是**剥注释**：注释里提到 dep 名不算"模块读过"，
      自带一条喂坏样本自检（只在注释里出现的 dep 必须判红）。
注意：删键前先确认模块里没有**同名本地实现**（历史上 `renderPages` 就是这种自环，已在 10.2 带走）。
      这 13 条复核时全是"注入面残留"，不是自环（已按 `injected.<键>` 逐条核过）。
```

**顺带修掉一个潜伏 bug（删死 dep 的真正理由）**：

```
:12622  setPageBlockPending: (value) => { pageBlockPending = value; return value; },
而 :2999  const pageBlockPending = new Set();     ← const
⇒ 这个 setter 一旦被调用就 TypeError。它今天靠"模块从不读它 / 也没人调"活着。
```

**死注入不只是冗余，它会藏运行时错误**——这就是闸①值得开、而不是"清完就算"的原因。

