# 审校页（#view-reading）模块边界 — 权威版

> **本版取代 `5ef9287` 的草案**（草案由 DevLead 主笔启动 Slice 1，权威版归 Architect）。
> 基线：`main@5d7e0ef`（Slice 1 已落地：三栏宽度偏好 + 视图外壳迁入 `static/reading-view.js`；R1 已修）。
> 复核对象：`backend/book2text/static/app.js` = **21,096 行**；审校区块 = **17,994–21,036 行（3,043 行）**；块内 **119 个顶层函数**、**66 个顶层状态**（62 `let` + 4 `const`）。
> 所有行号按该 commit；变动超过 5 行后重新扫一遍，别按记忆改。

---

## 0. 与前版草案的差异（请先看这张表）

| 草案说法 | 实际 | 证据 |
|---|---|---|
| 审校块 18,003–21,187 | **17,994–21,036**（到 `function boot()` 之前） | `app.js:17994` 区块注释；`app.js:21037` 是 `boot()`，属于外壳不是审校 |
| 67 个状态（63 let + 4 const） | 迁出 `readingSplitState` 后 **66 个（62 let + 4 const）** | `reading-view.js:31` |
| 7 簇的表格合计 61，实际列表 64 | 分簇可加总是最低要求：本版 66 全部分配，见 §3 | 前版 §1 表 |
| 只有 2 处越界（987、9347） | **16 处跨边界引用，去掉 `boot()` 注入接缝后仍有 11 处**，其中 4 处在 `app.js:17985–17988` **写**审校状态 | §4 |
| 共享输入 11 个 | **28 个**顶层符号被块内引用；`token` 引用 0 次（草案误记），`el()` 99 次（草案 105） | §2.2 |
| `readingPageNo` 被 41 处写 | **3 处直接赋值**：`20262`、`20305`、`20415`；36 处引用 | §3 S8 |
| 分簇 | 按"搬的时候会不会互相扯"重分 9 组（S1–S9），不是按名字前缀 | §3 |

---

## 1. 模块地图

### 1.1 分层（依赖只能向下，同一层不许互相依赖）

```
L3 外壳 shell        app.js 剩余部分（boot 装配、showView 路由、尚未迁的 6 个视图）
                      ↓ 只调公开接口
L2 视图模块          static/<name>-view.js —— 每个视图一个文件、一个 window 上的接口对象
                      ↓ 只用注入进来的服务
L1 域服务            core/*.js —— 无视图状态，有数据归属（项目、页面图、导出正文流、marks 计数）
                      ↓
L0 平台              core/dom.js（el）、core/api.js（apiJson + token）、浏览器 API
```

### 1.2 文件与归属（目标态；Slice 1 已建 `static/reading-view.js`，**保持扁平路径**，不为目录层级再搬一次）

| 文件 | 拥有什么 | 绝不做什么 |
|---|---|---|
| `static/index.html` | 7 个 `<section id="view-*">` 的 DOM 骨架；`<script>` 按 L0→L3 顺序加载 | 不含内联脚本逻辑 |
| `static/core/dom.js` | `el(id)`、`on()`、`closest()` 等无状态 DOM 工具 | 不缓存任何节点（缓存节点 = 重绘制后指向旧 DOM，本项目栽过） |
| `static/core/api.js` | `apiJson()`、`token`、错误归一 | 不认识任何视图 |
| `static/core/project.js` | `currentProject` 的唯一 owner：`get()`、`set()`、`subscribe()` | 不被视图直接写 |
| `static/core/pages.js` | 页码 ↔ 页面图 URL / 清晰度档位 / 瓷砖渲染（`pageImageUrl`、`pageProfileFor`、渲染瓷砖、版心框绘制） | 不含"审校"或"页面确认"的业务判断 |
| `static/core/export.js` | `exportOptions()`、`/export/preview` 的唯一前端调用点、`segments_only` 解析（D-106） | 不渲染任何视图 DOM |
| `static/reading-view.js` | `#view-reading` 整棵 DOM + §3 全部 66 个状态 | 不引用 app.js 任何顶层符号 |
| `static/pages-view.js` … | 各自 `<section id="view-*">` | 同上 |
| `static/app.js` | `boot()` 装配、`showView()` 路由、视图间跳转 | 不读任何视图的私有状态 |

**为什么 PDF 栏必须下沉到 `core/pages.js`**：审校页 PDF 栏现在直接调 `pageImageUrl`（4 次）、`pageProfileFor`（2）、`renderPageBlocks`（2）、`clearPageBlocks`（2）、`paintTileMargin`（2）、`clearTileMargin`（2）、`clearImagePlaceholder`（4）、`INDEX_IMAGE_WINDOW`（1）、`loadIndexBlocks`（1）——这 9 个是"页面确认"视图的内部函数。不抽出来，审校模块就会永久依赖 `pages-view`，迁移顺序会被锁死成"先 pages 后 reading"，而实际顺序是反的。

**为什么标点 / 乱码不是独立视图**：它们的按钮和计数长在 `#view-reading` 的工具栏里（`index.html:714–720`），面板是模态框。所以判定为**审校域的子面板**：
- DOM 归 `reading-view.js`（现在归错地方了，见 §4 第 3 组）；
- 子面板逻辑可以仍在 app.js，但只能通过 reading 注入的 `openPunctGroups` / `openGarbledPanel` 被调起，通过 `ReadingView.reload()` 通知正文流作废。

---

## 2. 依赖规则（每条都可判定）

| # | 规则 | 判定方式 |
|---|---|---|
| **R1** | **视图模块文件内不得出现 `app.js` 的任何顶层声明名**（`function` / `let` / `const` / `var` 在缩进 0 声明的名字）。缺依赖就加到 `init()` 的注入参数里 | 静态扫描，见 §6 |
| **R2** | 视图模块之间不得互相引用：`static/x-view.js` 内不得出现 `window.YView`（Y≠X）；需要共享的能力下沉到 `core/` | 静态扫描 `window\.[A-Z]\w*` |
| **R3** | 视图只许操作自己 `<section id="view-x">` 内的 id：`static/x-view.js` 里出现的 DOM id 必须能在该 section 的子树里找到 | 解析 `index.html` 的 section 范围 + 扫 `el("…")` 字面量 |
| **R4**（= `R4-dup`） | **同名函数全仓库只许一份真实现**。跨文件：一份真实现 + 其余 ≤6 行转发。**同文件重名 = 函数声明提升后后者覆盖前者，前者永不可调用**（这也是债，但性质不同，报错必须分开写） | `boundary.test.mjs`；同文件判为"重名覆盖"，跨文件判为"两份真实现" |
| **R5** | 每个状态只有一个 owner 模块；其他模块只能通过 owner 的公开方法改。**同层双写一律算错** | 本文件的 §3 表就是 owner 清单；跨文件写同一名字 = 违规 |
| **R6** | 一个模块文件只向 `window` 挂**一个**接口对象，且必须在 `init()` 之后才可被调用 | 扫 `window.X =` 赋值次数 |
| **R7** | 禁止 `<script type="module">`（D-046 无构建 + ES module 默认 deferred 会改 boot 时序）；且 `reading-view.js` 必须在 `app.js` **之前**加载 | 扫 `index.html`（`c425eb2` 已上闸） |
| **R8** | **重构不许新增导出**（Chief，2026-10-28）。需要新增一个导出才能搬动一块代码 = 这一刀边界切错，改边界别加接口 | 导出棘轮：`Object.keys(window.ReadingView)` ≤11 且只降不升 |

**依赖方向一句话**：`views → core → 平台`；外壳只能通过接口对象调视图；视图永远不许知道外壳和别的视图。

**例外表纪律（R4-dup 的 AC 例外名额）**：例外表里每条都要带 `owner` 与到期切片；**死代码一旦删除，对应例外必须同批删掉，否则例外表本身失信**。当前状态：`rerenderReadingLine` 之外的两对同名函数已批删（单独提交，不计入任何层），删完 AC 例外应从 3 条缩到 1 条，到期点仍是"正文流① 搬完"。

**R9（评审清单，不上闸）**：共享状态（`currentProject` / `token` / `exportOptions`）只以 getter 注入，不许缓存在模块级变量里。
原编号是 R4，**与"真实现份数"撞号，已让位**。降级理由：判定"有没有把 getter 缓存下来"要数据流分析，正则做不到，硬写成测试只会自欺。这条靠评审，不靠闸。

**两笔债要分开记**（Chief 2026-10-28）：**"真没法机检"**（R9）和**"没人写"**（R3/R5/R7 曾经）是两回事。前者认了，后者今天还能还。

**划边界之前先剔死代码**（Chief 2026-10-28，已验）：零引用的函数不计入耦合图与层表，否则量到的是残骸不是耦合。实证：审校块 121 个函数里 8 个零引用（52 行），全落在 L1；`refreshPunctGroups` 那条"越界"也是死代码残骸（`punctLeft` 算而未用、`punctNote` 恒 null）。**把不存在的东西算进账里，和虚报 marks 1,000 行是同一类错。**

### 2.1 审校块当前需要的外部符号（28 个，就是 `init()` 的注入清单）

按块内出现次数：

| 次数 | 符号 | 归属层 | 迁移建议 |
|---|---|---|---|
| 99 | `el` | L0 | 模块自带 3 行实现（`reading-view.js:17–19` 已经这么做了），**不注入** |
| 26 | `currentProject` | L1 project | 注入 `getProject()`（getter） |
| 12 | `performance.now` | 浏览器 | 直接用 |
| 8 | `apiJson` | L0 | 注入 `api` |
| 8 | `currentView` | L3 shell | **不许注入**：模块自己记 `active`，由 `enter/exit` 置位 |
| 7 | `localStorage` | 浏览器 | 直接用（只管自己的 key） |
| 6 | `setTimeout` / 4 `requestAnimationFrame` | 浏览器 | 直接用 |
| 5 | `showNoticeBar` | L3 shell | 注入 `notify()` |
| 4 | `computeCharSpans` | L1 文本 | 纯函数，下沉 `core/text.js` |
| 4 | `pageImageUrl`、4 `clearImagePlaceholder` | L1 pages | 下沉 `core/pages.js` |
| 10 | `project_id()`（`app.js:10996`） | L1 project | 被 `getProject()` 覆盖，消失 |
| 3 | `pagesOverlayOn`、2 `pagesMarginOn` | pages 视图状态 | 下沉 `core/pages.js` 的显示偏好 |
| 2 | `exportOptions` | L1 export | 注入 `getExportOptions()` |
| 2 | `pageProfileFor`、2 `clearPageBlocks`、2 `renderPageBlocks`、2 `paintTileMargin`、2 `clearTileMargin`、1 `INDEX_IMAGE_WINDOW`、1 `loadIndexBlocks` | L1 pages | 下沉 `core/pages.js` |
| 2 | `refreshPunctGroups`、1 `punctReviewSet`、1 `punctGroupsData`、1 `refreshGarbledLines` | 审校子面板 | 见 §1.2：只留 `openPunctGroups/openGarbledPanel/getPunctBadge/getGarbledBadge` 四个注入点 |
| 2 | `loadFinishSummary` | L1 导出收尾 | 注入或事件 |
| 1 | `savePageMarginPreference`、1 `savePageOverlayPreference` | pages 偏好 | 下沉 `core/pages.js` |
| 1 | `showView`、1 `openPageDetail` | L3 shell | 注入 `navigate()` / `openPageDetail()` |

> `token` 在块内引用 **0** 次——草案里的"token（2 处）"是错的，别为它设计注入。

---

## 3. 状态归属表（66 个，全量）

判定：**私有** = 块外零引用，随切片整组搬；**越界** = 块外有读或写，见 §4；**死状态** = 可直接删。
"赋值点"指 `x = / += / ++` 这类直接赋值行数（`Map/Set` 的 `.set/.add/.push` 未计入，属原地变更）。

### S1 生命周期（2）

| 状态 | 行号 | 类型 | 赋值点 | 引用 | 归属判定 | 备注 |
|---|---|---|---|---|---|---|
| `readingData` | 18003 | let | 4 | 14 | 越界-读+写 | 17791 读、17986 写（punct 批次重置） |
| `readingProject` | 18004 | let | 4 | 2 | 越界-写 | 17985 写（punct 批次重置） |

### S2 正文流（9）

| 状态 | 行号 | 类型 | 赋值点 | 引用 | 归属判定 |
|---|---|---|---|---|---|
| `readingEntries` | 18007 | let | 2 | 9 | 私有 |
| `readingSegmentNodes` | 18024 | let | 1 | 4 | 私有 |
| `readingRendered` | 18023 | let | 2 | 6 | 私有 |
| `readingTops` | 19613 | let | 2 | 5 | 私有 |
| `readingObserver` | 18030 | let | 2 | 4 | 私有 |
| `readingAppendScheduled` | 18034 | let | 2 | 1 | 私有 |
| `readingSpanCache` | 18033 | const | 0 | 2 | 私有 |
| `readingOpenStartedAt` | 18032 | let | 1 | 1 | 私有 |
| `readingAutoJumpDone` | 18169 | let | 1 | 2 | 私有 |

### S3 marks 与计数（7）

| 状态 | 行号 | 类型 | 赋值点 | 引用 | 归属判定 | 备注 |
|---|---|---|---|---|---|---|
| `readingMarks` | 18006 | let | 3 | 8 | 越界-写 | 17987 写（punct 批次重置） |
| `readingMarksWindow` | 18010 | let | 2 | 5 | 私有 | |
| `readingGlobalCounts` | 18011 | let | 2 | 1 | 私有 | |
| `readingPageCounts` | 18012 | let | 2 | 2 | 私有 | |
| `readingFirstUnackedPage` | 18013 | let | 2 | **0** | **死状态** | 任务 67 窗口化后只剩写，删 |
| `readingMarksInFlight` | 18014 | let | 2 | 3 | 私有 | |
| `readingMarksRequestSeq` | 18408 | let | 1 | 1 | 私有 | |

### S4 树与筛选（4）

| 状态 | 行号 | 类型 | 赋值点 | 引用 | 归属判定 |
|---|---|---|---|---|---|
| `readingTreeData` | 18005 | let | 1 | 4 | 私有 |
| `readingTreeOpen` | 19355 | const | 0 | 8 | 私有 |
| `readingFilter` | 18021 | let | 1 | 2 | 私有 |
| `readingCursorEntry` | 18029 | let | 1 | 5 | 私有 |

### S5 图片与 PDF 栏（16）

| 状态 | 行号 | 类型 | 赋值点 | 引用 | 归属判定 | 备注 |
|---|---|---|---|---|---|---|
| `readingTiles` | 19602 | let | 0 | 24 | 私有 | `.set/.delete` 原地变更 |
| `readingPageBlocks` | 19603 | let | 0 | 9 | 私有 | 同上 |
| `readingBlockPromises` | 19604 | let | 0 | 4 | 私有 | 同上 |
| `readingLoadedImages` | 19605 | let | 0 | 6 | 私有 | 同上 |
| `readingImageQueue` | 19606 | let | 1 | 2 | 私有 | |
| `readingImagePumping` | 19607 | let | 2 | 1 | 私有 | |
| `readingImageProfile` | 19732 | let | 2 | 2 | 私有 | |
| `readingImageToken` | 18031 | let | 0 | **0** | **死状态** | 删 |
| `readingNearObserver` | 19608 | let | 2 | 3 | 私有 | |
| `readingVisibleObserver` | 19609 | let | 2 | 3 | 私有 | |
| `readingNearSet` | 19610 | let | 0 | 3 | 私有 | |
| `readingVisibleSet` | 19611 | let | 0 | 4 | 私有 | |
| `readingResizeObserver` | 19733 | let | 1 | 2 | 私有 | |
| `readingStackProject` | 19612 | let | 1 | 1 | 私有 | |
| `readingHoveredSeq` | 19614 | let | 2 | 8 | 私有 | |
| `readingPdfScrollRaf` | 19615 | let | 2 | 1 | 私有 | |

### S6 面板落位（6）— 双写重灾区

| 状态 | 行号 | 类型 | 赋值点 | 引用 | 归属判定 | 赋值行 |
|---|---|---|---|---|---|---|
| `readingPanelKey` | 18025 | let | 4 | 20 | 私有（但**4 个写点**） | 18556, 19171, 19257, 19943 |
| `readingPendingPanelKey` | 19933 | let | 6 | 1 | 私有（**6 个写点**） | 18503, 19252, 19950, 20742, 20763, 20769 |
| `readingPendingPanelEntry` | 19934 | let | 6 | 4 | 私有（**6 个写点**） | 同上 |
| `readingJumpSettleKey` | 18027 | let | 5 | 3 | 私有 | 19250, 20584, 20592, 20601, 20760 |
| `readingJumpSettleTicks` | 18028 | let | 2 | 1 | 私有 | 20596, 20761 |
| `readingPendingBox` | 18044 | let | 4 | 2 | 私有 | 19226, 20434, 20506, 20630 |

**这是反模式 #3 的实证**：`readingPendingPanelKey` / `readingPendingPanelEntry` 各有 6 个写点、只被读 1/4 次，且写点分散在 18503（重绘）、19252（跳转）、19950（落位）、20742/20763/20769（结算）。"面板 142 / 顶部 141"这类 bug 就长在这里。搬进模块时必须收敛成**一个 `setPanel(entry)` + 一个 `settlePanel()`**，不是把 6 个写点原样搬过去。

### S7 草稿与行内编辑（5）

| 状态 | 行号 | 类型 | 赋值点 | 引用 | 归属判定 | 备注 |
|---|---|---|---|---|---|---|
| `readingDrafts` | 18020 | let | 2 | 15 | 私有 | |
| `readingInlineEdits` | 18038 | let | 2 | 17 | 私有 | |
| `readingEditingKey` | 18039 | let | 2 | 6 | 私有 | |
| `readingInlineTimer` | 18042 | let | 0 | **0** | **死状态** | 删 |
| `readingRepaintPending` | 18015 | let | 3 | 1 | 私有 | |

### S8 页码与滚动同步（12）

| 状态 | 行号 | 类型 | 赋值点 | 引用 | 归属判定 | 备注 |
|---|---|---|---|---|---|---|
| `readingPageNo` | 18022 | let | 3 | 36 | 越界-读 | 987 的兜底分支；赋值行 20262/20305/20415 |
| `readingSyncDriver` | 18017 | let | 1 | 2 | 私有 | |
| `readingSyncUntil` | 18018 | let | 1 | 1 | 私有 | |
| `readingScrollRaf` | 18043 | let | 2 | 1 | 私有 | |
| `readingUserMovedAt` | 18177 | let | 1 | 2 | 私有 | |
| `readingUserScrollSeq` | 18179 | let | 1 | 2 | 私有 | |
| `readingProgramScrollSeq` | 18180 | let | 1 | 1 | 私有 | |
| `readingSuppressFollowUntil` | 19124 | let | 1 | 1 | 私有 | |
| `readingPageSyncTimer` | 20336 | let | 1 | 1 | 私有 | |
| `readingPageSyncFixing` | 20337 | let | 2 | 1 | 私有 | |
| `readingPageSyncLog` | 20347 | const | 0 | 4 | 私有 | |
| `readingNextLog` | 20645 | const | 0 | 4 | 私有 | |

### S9 显示偏好（5）

| 状态 | 行号 | 类型 | 赋值点 | 引用 | 归属判定 | 备注 |
|---|---|---|---|---|---|---|
| `readingFollow` | 18035 | let | 1 | 12 | 越界-读写 | 9347 chip（DOM 归属错） |
| `readingProof` | 18036 | let | 1 | 4 | 私有 | |
| `readingMarkupLevel` | 18040 | let | 1 | 2 | 私有 | |
| `readingPendingOn` | 18041 | let | 1 | 1 | 私有 | |
| `readingPreflightData` | 18045 | let | 1 | 2 | 私有 | |

**合计：58 私有 / 5 有外部引用 / 3 可删。**

---

## 4. 跨边界现状（16 处，按性质分 4 组）

`boot()` 里的 4 行（21041/21043/21045/21077）是**注入接缝**，暂时允许，但要带到期标记，Slice 2 结束前清空。

**第 1 组：外壳把"进审校"写成两处**
- `app.js:246–247` —— `showView()` 直接调 `setReviewOverlaysForReading()` + `openReading()`。
- `app.js:987` —— `enterReviewStep()` 读 `readingPageNo` 存位置（Slice 1 已改成三元兜底，仍读）。
- 改法：`showView("reading")` → `ReadingView.enter()`；位置由 `getCurrent().pageNo` 提供，兜底分支删掉。

**第 2 组：工具栏控件被别的模块占着（DOM 归属错，不是状态归属错）**
- `app.js:9347` —— `setupPageIndex()` 里绑 `reading-follow-chip`，直接读 `readingFollow`。
- `app.js:15947–15948` —— `reading-punct-open` / `reading-garbled-open` 的点击绑在设置区。
- `app.js:17694/17698/17802/17810` —— 标点 / 乱码的计数与禁用态直接写这两个按钮。
- 这 5 个 id 都在 `#view-reading` 里（`index.html:698–783`），却由 punct / garbled / page-index 三处代码持有 → 两个模块写一个视图的 DOM，正是"重绘互相吃掉"的根。
- 改法：`reading-view.js` 绑这 5 个控件；数值通过注入的 `getPunctBadge()` / `getGarbledBadge()` 取；点击通过注入的 `openPunctGroups()` / `openGarbledPanel()` 派发。反过来 punct 改完批次只调 `ReadingView.reload()`。

**第 3 组：标点批次直接重置审校状态（真·边界划错）**
- `app.js:17985–17988` —— `reloadReadingAfterBatch()` 直接写 `readingProject = null` / `readingData = null` / `readingMarks = new Map()` 再 `await openReading()`。
- 这个函数本身是审校的函数，却长在标点代码段里，还被 `17765` / `17930` / `17958` 三处调用。
- 改法：搬进 reading 模块，暴露 `reload()`。外部三个调用点改成 `ReadingView.reload()`。

**第 4 组：审校状态被当作"信号"读**
- `app.js:17772` —— `refreshPunctGroups()` 里 `if (readingData) renderReadingProgress();`：标点数据到了就顺手让审校重画一次进度条。
- **原改法作废**（"reading 发 `'content-changed'` 事件"）：事件机制已在 `e5c4c37` 整体删除，0 订阅者的缝不留。
- **新改法：直接删掉这行，连同 `renderReadingProgress` 里那段读标点数据的死代码。** 证据：
  - `renderReadingProgress`（`app.js:19070–19095`）里 `const punctLeft = Number(punctTotals.undecided_lines || 0);` 算出来**从未使用**，紧接着 `const punctNote = null;` 恒为 null，`if (punctNote)` 分支永不执行（任务 66 把标点计数挪到工具条按钮后留下的残骸）；
  - 标点角标的文本由 `renderPunctGroupBadge()`（`app.js:17776`）自己写 `reading-punct-count`，与进度条无关；
  - 进度条依赖的是 `readingProgressNumbers()`（marks 计数 + 草稿数），不含标点。
- 删完之后 reading 不再读 `punctGroupsData`——**块内对标点数据的引用清零**（原 28 个共享输入再少一个）。前置于 L8（`renderReadingProgress` 在 L8）。

**结论**：草案说"边界基本干净、只有 2 处越界"不成立。**真正的问题是 DOM 归属被三个模块瓜分 + 标点模块反向写审校状态**，这两条不修，Slice 2 搬正文流时会把它们一起搬歪。

---

## 5. 对外接口（按证据裁到 6 个，无事件）

```js
window.ReadingView = {
  init(deps),            // 由 boot() 调一次
  enter(projectId),      // showView("reading") / enterReviewStep 都走这里
  exit(),                // 置 active=false，断 observer/timer（现在没有任何清理，切走即在跑）
  getCurrent(),          // → { projectId, pageNo }：savePosition 用，必须同步、便宜
  reload(),              // 标点 / 乱码批次裁决后"整条流重开"
  toggleFollow(),        // 9347 chip
};
```

**从草案删掉的 4 个**：`nextUnreviewed` / `prevUnreviewed` / `gotoPage` / `jumpToEntry` —— 全仓库**没有任何块外调用者**（`gotoNextUnreviewed` 只有 18943/21023/21029 三处调用，都在 `#view-reading` 的键盘与按钮里）。等真有外部调用者再加。接口宽一寸，边界就薄一分。

**`submitDrafts` / `undo` 同理**：`submitReadingDrafts`、`undoReadingSubmit` 目前 0 个块外调用者，留在模块内部。导出流程将来若要先"提交草稿再导出"，那时再加 `flushDrafts(): Promise<void>`。

**`enter()` 的契约**（现在 `openReading()` 自己读 `currentProject`，要改）：
1. 参数缺省时用 `getProject()`；
2. 先套三栏宽度（等视图可见才量得到宽度）；
3. 同项目且已加载 → 重绘不重拉；否则拉 `segments_only=1`；
4. 进入时置 `active = true`，`exit()` 置 `false`——模块内部 8 处 `currentView === "reading"` 判断全部改成本地 `active`。

**`on` / `emit` 整个事件机制都要删，不只是 `emit`**（`db37d1d` 时是 13 个 key）。理由：
- `emit` 是**写路径**——任何模块拿到 `window.ReadingView.emit('content-changed')` 就能驱动审校重绘，等于给边界开后门；0 个外部调用者。
- `on` 0 个订阅者，且按 §1.2 的子面板方案，标点角标走 `getPunctBadge()` 注入 + `reload()`，**不需要事件**。
- 两者加上 `listeners` Map 共 22 行（`reading-view.js:196–211`、`:221–222`），全是死代码。没有订阅者的事件缝不是缝，是下一次被人当成接口写进去的邀请。

删完公开接口 = **6 个 key**：`init / enter / exit / getCurrent / reload / toggleFollow`。

**过渡期例外（必须有到期点）**：`db37d1d` 的接口对象还多挂了 `splitPrefs / applySplit / saveSplit / resetSplit / setupSplit` 五个拆分偏好函数，同时 app.js 留着 5 个转发 stub。这是搬运期的临时态，**到期点 = Slice 2 结束**：届时这 5 个名字必须从 `window.ReadingView` 消失（改成模块内部函数 + 模块自己绑事件），app.js 的 stub 一并删除。

**上闸时机与机制**：现在就上，不要等 Slice 2 收尾——"收尾时再加"的门禁等于没有门禁。做法是**只降不升的棘轮**：
- 删完 `on`/`emit` 后：`Object.keys(window.ReadingView)` = **11** = 6 稳定 + 5 临时；上限钉 11。
- 今天的使用断言：keys ⊆ `{init, enter, exit, getCurrent, reload, toggleFollow}` ∪ `{splitPrefs, applySplit, saveSplit, resetSplit, setupSplit}`，且长度 ≤ 11。
- Slice 2 收尾把临时集合清空、上限改成 **6**；此后任何新增导出都会让这条立即红。
- 长度只许往下调，注释里写明"改小可以，改大必须 Architect 签字"。

**`getCurrent()` 只给两个字段**，别加 `done/total/draftCount`：那是"顶部数字"，由模块自己渲染（badge 与它的数据源切在一起，见 §6 R8），外壳不拉。外壳拉一次状态，就会有第二个写点。

---

## 6. 可自动检查的边界规则（第一条：R1）

> 交给 TestDev 做成 `tests/js/boundary.test.mjs`，进 `node tests/js/run.mjs`，2 秒内跑完，不依赖 DOM。

### 规则

**R1：`static/reading-view.js` 里不得出现 `app.js` 顶层声明过、且该文件自己没有声明的任何名字。**

### 判定算法（无需加载、无需 jsdom，纯文本）

1. 读 `static/app.js`，取顶层声明名集合 `S`：`^function\s+NAME`、`^async function\s+NAME`、`^(let|const|var)\s+NAME`（多声明按逗号拆）。
2. 读 `static/reading-view.js`，**去掉注释与字符串字面量**（不去会把注释里的名字算成引用），取标识符集合 `I`。
3. 读同一个文件，取**该文件自己声明过的名字** `L`：任意缩进层级的 `function NAME` / `(let|const|var) NAME`。
4. 断言 `|I ∩ (S \ L)| == 0`。失败时报：`reading-view.js:行 用了 app.js:行 的 <名字>`。
5. 例外表 `ALLOW` 必须为空。例外表上限 3 条，超过即失败；每条必须带 `owner` 与"到期切片"注释，由 Architect 在切片验收时手删。

**第 3 步不能省（我第一版写错了，TestDev 别照抄）**：不加 `L` 会在当前代码上报 26 条假红——
`reading-view.js` 自己声明了 `el`，而 `app.js:28` 也有 `const el`；它还自己声明了
`readingSplitPrefs` / `applyReadingSplit` / `saveReadingSplit` / `setupReadingSplit`，而
`app.js:20869–20881` 还留着这 4 个转发 stub。这是**同名不同物**，不是依赖。
正确判据是"这个标识符在模块里有没有自己的绑定"，不是"app.js 有没有同名声明"。

**这也顺带守住了"真实现份数=1"**：如果哪天有人把实现搬回 app.js、模块只留转发，`L` 里就没有这些名字了，检查会立刻把它们标成依赖——正是我们要它红的时候。

### 红/绿证据（TestDev 的"先在已知坏数据上红过"要求）

| 版本 | 结果 | 明细 |
|---|---|---|
| `7c1d00c`（Slice 1 原始提交） | **红：5 处 / 4 个符号** | `reading-view.js:157` `currentView`(app.js:105)、`:158` `measureReadingTops`(20312)、`:159` `readingPageNo`(18022，两次)、`:159` `updateReadingPage`(20411) |
| `5d7e0ef`（修完） | **绿：0** | 4 个名字只剩在注释里，去注释后为 0 |

红的那版里 4 个符号全在同一个 `resize` 回调（`157–159` 行）里。`reading-view.js` 在 app.js **之前**加载（`index.html:1835–1836`），这 4 个符号在加载时并不存在，能跑只因为回调在 `boot()` 之后才触发——正是这个仓库一半 bug 的成因（时序靠运气）。

**已采用的修法（零行为变化）**：`init()` 增加 `onViewportResize: () => void`，`reading-view.js` 里改成：

```js
window.addEventListener("resize", () => {
  applyReadingSplit();
  injected.onViewportResize?.();
});
```

`boot()` 注入（`5d7e0ef` 已落地）：

```js
onViewportResize: () => {
  if (currentView !== "reading") return;
  measureReadingTops();
  if (readingPageNo) updateReadingPage(readingPageNo, { scrollLeft: true });
},
```

Slice 2 把 `readingPageNo` / `measureReadingTops` / `updateReadingPage` 搬进模块后，这个注入自然消失（R1 保持绿）；`currentView` 换成模块自己的 `active`。

### R8（Chief 定，2026-10-28）：重构不许新增导出

> **重构不许新增导出。如果需要新增一个导出才能搬动一块代码，说明这一刀的边界切错了——改边界，别加接口。**

为什么 `refreshChrome` 看起来需要、其实不需要：它是把 **badge 和它的数据源切开了**。**切在一起就不需要接口。**
和 D-106 同理——**接口是结构不清的补偿**：正文明明只有一份，却要给三个视图各造一个入口，于是有了"唯一入口"的规定；
模块边界明明切在数据源上，却要给外面递一个刷新方法，于是有了新导出。两步都是同一个错误：切在数据上，不切在调用上。

**这条规则的可检查形态**：导出棘轮（`tests/js/boundary.test.mjs`）只降不升，当前 11；任何"为了搬代码"而加的 key 都必须先过 Architect 的签字，默认答案是重切边界。

---

### 为什么先上 R1，不是 R2/R3

- R1 **已绿**（`5d7e0ef`），且**每次提取新模块都会自动被同一道闸拦住**——它守的是"新模块不许偷看老代码"这个方向，正是 254 个全局长回来的路径。
- R3（DOM 归属）现在有 7 行违规，但它需要解析 `index.html` 的 section 范围，而且 5 个 id 的归属改法要先定 §1.2 的子面板方案，**排给 Slice 2 之后**。
- R2 依赖第二个视图模块出现才有意义（现在只有一个）。

---

## 7. 给排期的耦合约束（排期本身归 DevLead）

只说"哪几块必须一起搬、哪几块可以拆开"，不排日期：

| 切片 | 内容 | 必须同批的 | 理由 |
|---|---|---|---|
| S1 | `readingData` / `readingProject` + `enter/exit/getCurrent` | §4 第 1、3 组（外壳入口 + `reload()`） | `reload()` 是这三处越界的唯一出口，分开做就会出现中间态：punct 还在直接写状态 |
| S2 | 正文流（9 个） | S3 的 marks（7 个） | `readingData` 回来就立刻要 `readingMarks`，两者共享一次 `applyReadingMarksPayload` |
| S5 | 图片列（16 个） | `core/pages.js` 先抽 | 不抽就会让 `reading-view.js` 依赖 `pages-view.js`（R2 违规），把迁移顺序锁死 |
| S6 | 面板落位（6 个） | **先把 6 个写点收敛成 2 个方法** | 原样搬 = 把双写 bug 搬进新文件，之后更难查 |
| S8 | 页码 / 滚动（12 个） | `readingPageNo` + `active` | 8 处 `currentView` 判断必须和页码一起换成本地状态 |
| S9 | 显示偏好（5 个） | §4 第 2 组的 5 个控件 | follow chip 的 handler 不搬，`readingFollow` 就永远有外部写点 |

**可以延后的（明确说"不急"）**：
- R2 检查器（等第二个视图模块）；
- `core/text.js` 抽 `computeCharSpans`（4 处引用，纯函数，不挡住任何切片）；
- `submitDrafts` / `undo` 的对外暴露（现在没有外部调用者）。

**Slice 1 顺手可做、零行为变化的三处删除**：`readingImageToken`（18031）、`readingInlineTimer`（18042）、`readingFirstUnackedPage`（18013）——共 0 读；前两个连写都没有。

---

## 8. 复核命令

```bash
# 状态清单与行号（66 个，块边界 17994..boot）
python3 - <<'PY'
import re
L=open('backend/book2text/static/app.js',encoding='utf-8').read().split('\n')
R=[re.sub(r'//.*$','',x) for x in L]
s=next(i for i,x in enumerate(L,1) if '阅读审校（L 刀' in x)
e=next(i for i,x in enumerate(L,1) if re.match(r'function boot\(',x))-1
d=[(m.group(2),i) for i,x in enumerate(R,1) if (m:=re.match(r'(let|const|var)\s+(reading\w*)\b',x))]
print(f"块 {s}..{e} ({e-s+1} 行); 状态 {len(d)}")
PY

# 依赖方向（R1 的人工版）：block 外引用 block 内声明
grep -nE '\b(readingPageNo|readingFollow|readingData|readingProject|readingMarks)\b' \
  backend/book2text/static/app.js | awk -F: '$1<17994 || $1>21036'

# JS 用例基线（本机：/opt/homebrew/bin/node）
/opt/homebrew/bin/node tests/js/run.mjs   # 25 pass / 0 fail / 1 todo（代理对是已知 TODO），退出码 0
```

## 9. Slice 1 验收口径（Chief 更正后）

原判据"`app.js` 减少行数 ≈ 新文件增加行数（±30）"**作废**——它会被骨架代码骗：
IIFE 包装、依赖注入、头注释、4 个转发 stub 都是搬运必然带的，实测 -109 / +201 差 93 行却完全正确。

**新判据（可机检，交 TestDev 做成测试）**：

> 每个被搬走的函数，全仓库只许有**一份真实现**。
> `app.js` 若保留同名函数，函数体必须 **≤6 行**，且只含 `return window.ReadingView.x(...)` 或 `window.ReadingView.x(...)`。

±30 行降级为参考值，**不作为通过条件**。

Slice 1 实测（2026-10-28）：
- 搬走 4 个函数 + 6 个常量：137 行
- `app.js` 21,198 → 21,089（-109）；`reading-view.js` +201（137 搬 + 64 骨架）
- 真实现份数：`readingSplitPrefs` / `applyReadingSplit` / `saveReadingSplit` / `setupReadingSplit` **各 1**
- 四个数：段数 4821、字数 753335、正文归一化 sha256 `9ca42f50a3ed1dd6`、差异 567（与基线逐项相同）
- `pytest` 1002 passed；`tests/js` 25 pass / 1 todo

---

## 10. Slice 4 裁定记档（2026-10-28，Architect）

**裁定：** Slice 4（`reading-follow-chip` 之外的 `punct` / `garbled` 两个 badge）**并进「punct 整体搬」**，不单独成刀。

三条理由，按重要性：
1. **不破棘轮**：单独搬 badge 需要从模块往外递一个 `refreshChrome`（或等价方法），会让公开导出从 11 变 12。按 R8，这就是边界切错——badge 和它的数据源被切开了。
2. **不留两份 badge 数据**：现在 `reading-punct-count` / `reading-garbled-count` 的文本由 punct / garbled 模块算、DOM 归 `#view-reading`。分开搬等于让两个模块各算一份，正是"面板 142 / 顶部 141"的成因（反模式 #3）。
3. **到期点明确**：punct 整体搬时，badge 的数据与 DOM 一起进模块，`getPunctBadge()` 这类注入点**一个都不需要**。

**验收侧的连带影响**：该切片的验收必须同时看"标点数与审校进度同屏一致"这一条（顶栏 badge 与正文流进度不同步，是两个写点的典型症状）。

---

## 11. L1 施工表（HEAD `c45b8a5`，11 函数 / 230 行）

**230 行 = 178 行搬 + 52 行删。** 8 个函数全仓库零引用，是死代码，**不要搬，直接删**；搬的只有 3 个。

| 函数 | 行号 | 行数 | 处理 | 为什么在 L1 而不是 L2 |
|---|---|---:|---|---|
| `setReviewOverlaysForReading` | 18099–18116 | 18 | 搬 | 唯一调用点 `showView()`(250)，由 `enter` 导出覆盖；L2–L12 无人调用 |
| `readingReloadAfterBatch` | 18151–18158 | 8 | 搬 | 唯一调用点是 `boot()` 的 `reload:` 注入(21016)，属 `reload` 导出 |
| `setupReading` | 20849–21000 | 152 | 搬 | 唯一调用点是 `boot()`(21053)，由 `init` 导出覆盖 |
| `readingPdfScrollTop` | 18117–18127 | 11 | **删** | 全仓库零引用（含块外） |
| `readingOrderAfter` | 18321–18326 | 6 | **删** | 全仓库零引用 |
| `buildReadingTree` | 19314–19321 | 8 | **删** | 全仓库零引用 |
| `toggleReadingProof` | 20418–20426 | 9 | **删** | 全仓库零引用（任务 66 去掉「成稿」按钮后遗留） |
| `readingCursorOrder` | 20695–20700 | 6 | **删** | 全仓库零引用 |
| `readingSplitPrefs` | 20833–20836 | 4 | **删** | 0 调用；真实现已在 `reading-view.js` |
| `saveReadingSplit` | 20841–20844 | 4 | **删** | 同上 |
| `setupReadingSplit` | 20845–20848 | 4 | **删** | 同上 |

**判据**：L1 里的函数，其调用者只有两种——① 零引用（删）；② `boot()` / `showView()` 这两个已被导出覆盖的入口。只要有一个调用者在 L2–L12，它就必须等那一层。

**L1 的注入依赖 = 24 个**（`setupReading` 绑 30 个处理器带来的）：`saveReadingInlineEdits`(18040) / `saveReadingDrafts`(18072) / `markReadingUserMoved`(18128) / `openReading`(18159) / `readingMarkOrder`(18317) / `renderReading`(18509) / `startInlineEdit`(18807) / `exitInlineEdit`(18875) / `renderReadingProgress`(19042) / `setReadingFilter`(19068) / `openReadingPanel`(19128) / `closeReadingPanel`(19211) / `rerenderReadingLine`(19297) / `paintReadingTile`(19942) / `setReadingHoverByBlock`(20105) / `setReadingHover`(20134) / `onReadingPdfScroll`(20288) / `setReadingFollow`(20404) / `renderReadingPreflight`(20427) / `onReadingScroll`(20511) / `stepReadingPage`(20602) / `gotoNextUnreviewed`(20629) / `submitReadingDrafts`(20747) / `undoReadingSubmit`(20807)

**行数账（3,061 到底怎么来的）**：
- 3,061 = 53（头部：节注释 + 状态声明）+ 3,008（各函数区间）
- 3,008 = 2,995（121 个不同函数名）+ 13（**重名死定义**：`rerenderReadingLine` 首份 18860–18872，被 19289 覆盖）
- 12 层合计 2,995 → 未归层的只有 **53 + 13 = 66 行**，没有 668 行缺口。

---

### 11.1 L2–L12（同一份采样，`c45b8a5`；行号 = 函数起止，括号内 = 行数）

> L1 见上表（230 = 搬 178 + 删 52）。`app.js ≈` 只扣函数体行，未扣 53 行头注释与状态声明。

**L1（230 行 / 11 函数）→ 累计 230，app.js ≈ 20,835，临时注入 24**

- `setReviewOverlaysForReading 18099–18116(18)`
- `readingPdfScrollTop 18117–18127(11)`
- `readingReloadAfterBatch 18151–18158(8)`
- `readingOrderAfter 18321–18326(6)`
- `buildReadingTree 19314–19321(8)`
- `toggleReadingProof 20418–20426(9)`
- `readingCursorOrder 20695–20700(6)`
- `readingSplitPrefs 20833–20836(4)`
- `saveReadingSplit 20841–20844(4)`
- `setupReadingSplit 20845–20848(4)`
- `setupReading 20849–21000(152)`

**L2（342 行 / 11 函数）→ 累计 572，app.js ≈ 20,493，临时注入 30**

- `markReadingUserMoved 18128–18139(12)`
- `startInlineEdit 18807–18835(29)`
- `setReadingFilter 19068–19073(6)`
- `setReadingHoverByBlock 20105–20133(29)`
- `onReadingPdfScroll 20288–20312(25)`
- `setReadingFollow 20404–20417(14)`
- `renderReadingPreflight 20427–20466(40)`
- `onReadingScroll 20511–20601(91)`
- `stepReadingPage 20602–20611(10)`
- `submitReadingDrafts 20747–20806(60)`
- `undoReadingSubmit 20807–20832(26)`

**L3（213 行 / 7 函数）→ 累计 785，app.js ≈ 20,280，临时注入 35**

- `readingMovedSinceOpen 18140–18150(11)`
- `openReading 18159–18279(121)`
- `readingLineBox 18783–18796(14)`
- `markEditingLineBox 18797–18806(10)`
- `exitInlineEdit 18875–18898(24)`
- `onInlineKeydown 18899–18914(16)`
- `drawEditingLineBox 20480–20496(17)`

**L4（139 行 / 7 函数）→ 累计 924，app.js ≈ 20,141，临时注入 33**

- `loadReadingInlineEdits 18006–18025(20)`
- `restoreInlineEditsPrompt 18026–18039(14)`
- `loadReadingDrafts 18057–18071(15)`
- `onInlineInput 18836–18843(8)`
- `measureReadingTops 20276–20287(12)`
- `gotoNextUnreviewed 20629–20694(66)`
- `applyReadingSplit 20837–20840(4)`

**L5（1041 行 / 32 函数）→ 累计 1965，app.js ≈ 19,100，临时注入 36**

- `readingOptions 18086–18098(13)`
- `applyReadingMarksPayload 18280–18291(12)`
- `rebuildReadingEntries 18292–18316(25)`
- `readingWindowHas 18327–18342(16)`
- `ensureReadingMarksWindow 18343–18370(28)`
- `loadReadingMarksWindow 18371–18391(21)`
- `refreshReadingMarksPaint 18392–18443(52)`
- `ensureReadingLineRendered 18444–18470(27)`
- `renderReading 18509–18576(68)`
- `buildReadingSentinel 18577–18599(23)`
- `saveInlineEdit 18844–18861(18)`
- `centerReadingLinePair 19095–19122(28)`
- `openReadingPanel 19128–19201(74)`
- `renderReadingTree 19382–19493(112)`
- `scrollReadingToPage 19494–19520(27)`
- `markReadingTreeCurrent 19521–19548(28)`
- `jumpReadingTo 19549–19582(34)`
- `ensureReadingPages 19583–19590(8)`
- `buildReadingPages 19591–19637(47)`
- `observeReadingTiles 19645–19698(54)`
- `refreshReadingImageProfiles 19699–19719(21)`
- `observeReadingColumnResize 19738–19750(13)`
- `ensureReadingTile 19751–19755(5)`
- `retryReadingPendingPanel 19900–19919(20)`
- `ensureReadingBlocks 19920–19941(22)`
- `setReadingHover 20134–20166(33)`
- `markReadingCurrentTile 20167–20176(10)`
- `updateReadingPageFromLeftScroll 20198–20240(43)`
- `scrollStreamToPage 20254–20275(22)`
- `verifyReadingPageSync 20313–20374(62)`
- `updateReadingPage 20375–20403(29)`
- `gotoReadingEntry 20701–20746(46)`

**L6（428 行 / 24 函数）→ 累计 2393，app.js ≈ 18,672，临时注入 20**

- `saveReadingInlineEdits 18040–18056(17)`
- `readingFlowPages 18471–18478(8)`
- `readingEntryDone 18494–18498(5)`
- `removeReadingSentinel 18600–18612(13)`
- `buildReadingSegment 18663–18706(44)`
- `scrollScrollerToCenter 19074–19090(17)`
- `suppressReadingFollow 19091–19094(4)`
- `hideReadingPanelHost 19202–19210(9)`
- `startReadingEdit 19259–19279(21)`
- `buildReadingTreePreview 19338–19368(31)`
- `readingEntriesForPage 19369–19381(13)`
- `disconnectReadingObservers 19638–19644(7)`
- `warmSwapReadingImage 19720–19737(18)`
- `ensureReadingImage 19756–19771(16)`
- `pumpReadingImages 19781–19841(61)`
- `releaseReadingImage 19842–19861(20)`
- `markReadingImageFailed 19862–19899(38)`
- `clearReadingDecorations 19965–19972(8)`
- `scrollPdfColumnToPage 20177–20197(21)`
- `markReadingDriver 20241–20245(5)`
- `readingDriverActive 20246–20253(8)`
- `hideReadingPdfBox 20467–20479(13)`
- `drawReadingPdfBox 20497–20510(14)`
- `logReadingNext 20612–20628(17)`

**L7（95 行 / 8 函数）→ 累计 2488，app.js ≈ 18,577，临时注入 15**

- `readingInlineStorageKey 18002–18005(4)`
- `readingMarkOrder 18317–18320(4)`
- `checkReadingSegmentText 18640–18662(23)`
- `span_at 18915–18918(4)`
- `draftReading 19280–19296(17)`
- `readingEntryLineText 19322–19337(16)`
- `showReadingPlaceholder 19772–19780(9)`
- `paintReadingTile 19942–19959(18)`

**L8（112 行 / 7 函数）→ 累计 2600，app.js ≈ 18,465，临时注入 10**

- `saveReadingDrafts 18072–18085(14)`
- `textCheckEnabled 18631–18639(9)`
- `renderReadingProgress 19042–19067(26)`
- `closeReadingPanel 19211–19232(22)`
- `rerenderReadingLine 19297–19313(17)`
- `readingPageRecord 19960–19964(5)`
- `applyReadingLinked 19982–20000(19)`

**L9（163 行 / 5 函数）→ 累计 2763，app.js ≈ 18,302，临时注入 8**

- `readingDraftStorageKey 17997–18001(5)`
- `buildReadingLine 18919–19030(112)`
- `readingProgressNumbers 19031–19041(11)`
- `refreshReadingCurrentHighlight 19233–19258(26)`
- `readingHoveredBlockIds 19973–19981(9)`

**L10（166 行 / 6 函数）→ 累计 2929，app.js ≈ 18,136，临时注入 3**

- `readingVisibleSegments 18479–18493(15)`
- `expandToWordRange 18613–18630(18)`
- `readingLineText 18707–18717(11)`
- `paintInlineRevision 18718–18782(65)`
- `readingLineNode 19123–19127(5)`
- `paintReadingDiffBoxes 20053–20104(52)`

**L11（62 行 / 2 函数）→ 累计 2991，app.js ≈ 18,074，临时注入 1**

- `readingEntryVisible 18499–18508(10)`
- `readingDiffUnits 20001–20052(52)`

**L12（4 行 / 1 函数）→ 累计 2995，app.js ≈ 18,070，临时注入 0**

- `readingKey 17993–17996(4)`

---

## 12. 作战地图：全前端的环（优化阶段用，拆分期不动）

采样：`HEAD` 全文 833 个顶层函数，节点 = 顶格 `function` 声明，边 = 函数体里出现另一个函数名（**裸引用算边**）。多节点强连通分量 **10 个**，环内 188 个函数 / 7,633 行。

| 环 | 规模 | 性质 |
|---|---|---|
| **showView 母环** | **5,908 行 / 144 函数（87–20,738）** | 唯一的系统性病根：`showView` → 视图 open → 视图里又调 `showView` |
| 合并页 | 408 / 11 | 潜在雷，`renderMergeView`(16,956) 内部调 `showView` |
| 页码模板 | 406 / 8 | 潜在雷 |
| 项目库 | 223 / 4 | 潜在雷 |
| 目录图片泵 | 178 / 5 | 与审校图片泵同构 |
| 候选对照 | 145 / 5 | 潜在雷 |
| 标点面板 | 138 / 2 | 潜在雷 |
| 建议扫描 | 106 / 4 | 潜在雷 |
| 回收站 | 81 / 3 | 潜在雷 |
| 行内编辑 | 40 / 2 | 已随 L2/L3 走 |

**审校的 1,010 行环不独立，它嵌在母环里。** 接点 = `setupReading`(20,841) → `showView("review")` → `openPageDetail`。全仓库"视图内部调路由"只有 4 处：`openPageDetail`(10,370)、`setupReading`(20,841)、`renderMergeView`(16,956)、`submitMergeDecisions`(17,371)。只要这 4 条边在，每个视图的环都和全 app 的环一起转——这是"面板被重绘清掉 / 页码跳回第 1 页 / 高亮丢"能跨视图复现的结构原因。

### 12.1 破环轮廓（三步，按收益排）

1. **切桥**：4 处视图内 `showView` 改成注入的 `navigate()`。审校环从母环上摘下来，审校侧症状才能独立治。
2. **切审校环的 9 条回调边**（渲染 → 数据/状态）：
   `renderReading→ensureReadingMarksWindow`、`renderReading→retryReadingPendingPanel`、
   `renderReadingTree→ensureReadingMarksWindow`、`renderReadingTree→scrollReadingToPage`、
   `openReadingPanel→updateReadingPage`、`setReadingHover→ensureReadingBlocks`、
   `verifyReadingPageSync→updateReadingPage`、`gotoReadingEntry→jumpReadingTo`、`gotoReadingEntry→updateReadingPage`。
   统一改法：**渲染只读状态、只把"要补数据/要跳页"塞进队列，由帧末的同步函数消费**；渲染不再直接调加载器、不再改页码。
3. **母环余下 12 处**都是外壳按钮（用户主动换视图），合法，保留。

### 12.2 破环后 L5 能切多细（实测）

删掉那 9 条边后，1,010 行 SCC 碎成 **21 块**，最大 240 行。按功能合并约 **6 刀**：
页码同步 240 / 树 173 / 正文渲染 219 / 面板 102 / 校验与图片档位 96 / 悬浮与懒加载 60。
**结论：破环把"1,041 行一刀"变成"6 刀 60–240 行"。**

### 12.3 破环是独立阶段，硬条件

`L1–L4 纯搬运 → 破环 → L5 六刀 → L6`（Chief 2026-10-28 定）。

- 破环**不混进任何纯搬运切片**：独立提交序列（切桥 1 个 / 9 条边逐条 / 母环 4 处）、独立基线（L4 结束那份）、独立 tag（可单独回退）。
- **每切一条边，先写特征测试锁住当前可观察行为，切完必须一样。** 9 条边里 6 条正是这周 bug 的来源；不先锁行为就切 = 拿行为改造赌博。

---

## 13. 注入依赖数的口径（今天这个数飘了 24/28/30，写死在这里）

**数的定义（唯一口径）**：某一层搬完之后，**已搬进模块的代码**所引用、**但仍留在 app.js 的"审校块内顶层函数名"**个数。按名去重，一个名字算 1。

**明确不算**：状态变量（`readingData` 等本轮不搬）、块外服务符号（`apiJson`/`exportOptions`/`currentProject`/`localStorage`）、浏览器 API、本层已搬进来的函数。

> 所以文档里那个"28 个外部符号"是**另一个数**（整个块对外部世界的依赖面，含状态与服务），**不是**这个仪表盘；`el`（模块自带 3 行）和 `currentView`（改模块自己的 `active`）都不在 28 里。

**怎么数（可复现）**：对 app.js 做引用图，取已搬层所有函数的出边，减去落在已搬集合内的目标，按名去重计数。

### 13.1 每层预期值

| 层 | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 | L9 | L10 | L11 | L12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 预期注入 | 24 | 30 | 35 | 33 | **36** | 20 | 15 | 10 | 8 | 3 | 1 | 0 |

### 13.2 它不单调递减——"变大就是切错"作废

形状是**先升后降**：L1→L5 上升（24→36，峰值在 L5），L6 起单调降到 0。
原因：每搬走一层，会新增"这一层 → 尚未搬的叶子"的出边；L5 是核心环，它的出边最多。**L6 之后变大才算切错**；L2–L5 变大是预期行为。

### 13.3 两个数分开报

- **临时注入**（会被内化）：上表。**L4 结束时是 33，不是 0**；到 L12 才归零。
- **永久依赖**（永远内化不了，属 core/服务层）：`apiJson`、`exportOptions`、`currentProject`、`localStorage`、`performance.now`、`computeCharSpans`、`pageImageUrl`/`pageProfileFor`（页面图）、`punctGroupsData`/`punctReviewSet`（标点）。
  **`refreshPunctGroups` / `renderPunctGroupBadge` 不算临时债**——它们是跨模块（标点），必须走已存在的 `onPunctGroups` 注入，不许由 `openReading` 直接调。

---

## 14. 面板落位：6 个写点收敛归哪一层

**归前置清障（L0），在 L4 之前，不归 L5。**

理由：写点分属 **L5（3 个函数）、L8（1 个函数）**，任何一层单独搬都会留下"模块写一次、app.js 写一次"的中间态，正是反模式 #3。收敛只能在层之前做。

**现状（HEAD，4 个函数 / 5 组赋值）**：

| 行 | 函数 | 层 | 动作 |
|---|---|---|---|
| 18462–18463 | `ensureReadingLineRendered` | L5 | 写 key+entry |
| 19208–19209 | `closeReadingPanel` | L8 | 清空 |
| 19906–19907 | `retryReadingPendingPanel` | L5 | 清空 |
| 20698–20699 / 20719–20720 / 20725–20726 | `gotoReadingEntry` | L5 | 写 / 清 / 写 |
| 19888–19889 | （状态声明，不是写点） | — | 声明本身，随 L5 走 |

收敛成三个入口：`setPanel(entry)` / `clearPendingPanel()` / `settlePanel(entry)`。
**这不是顺手改行为**：4 个入口合成 3 个，可观察行为不变；原样搬才是把病根搬进新房子。


---

## 15. 交接纪律（Chief 定，2026-10-28）

**交接要么贴全文，要么确认对方收到。"我发了"不算。**

执行方式（本项目专用，因为 CI 死了、消息会丢）：
1. **任何"表格级"资产先进 repo**（`docs/refactor/`），消息只做指路 + 贴全文二选一；**repo 里的版本是唯一权威**。
2. 消息发出后，**必须拿到对方的一句回执**（例："L1 表收到，230=178+52"）；没有回执 = 未交接。
3. 回执里要复述关键数字——复述不了说明没真读。
4. 已知事故：Builder 的"前置页有差异但不可审"结论一路交接下来，QA 一条实测（流外队列页 = 0）就否了，白改一轮。**传错的结论比多贴一遍表贵得多。**
