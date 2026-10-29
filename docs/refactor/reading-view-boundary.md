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
| **R9** | **被引用但没声明的标识符一律红**（no-undef）。`readingTreeOpen` 就是这条抓出来的：HEAD 上 7 次引用、0 次声明，渲染左树直接 `ReferenceError` | `boundary.test.mjs`（`4a6f675` 上闸） |

**依赖方向一句话**：`views → core → 平台`；外壳只能通过接口对象调视图；视图永远不许知道外壳和别的视图。

**例外表纪律（R4-dup 的 AC 例外名额）**：例外表里每条都要带 `owner` 与到期切片；**死代码一旦删除，对应例外必须同批删掉，否则例外表本身失信**。当前状态：`rerenderReadingLine` 之外的两对同名函数已批删（单独提交，不计入任何层），删完 AC 例外应从 3 条缩到 1 条，到期点仍是"正文流① 搬完"。

**R10（评审清单，不上闸）**：共享状态（`currentProject` / `token` / `exportOptions`）只以 getter 注入，不许缓存在模块级变量里。
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

## 3. 状态归属表（现状 66 + 破环期新增 3 = 69）

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

**合计：58 私有 / 5 有外部引用 / 3 可删。破环期新增 3 行全私有（见 S10），合计 61 私有 / 5 / 3 = 69。**

### S10 破环期新增（3，计划；破环第一个提交落地）

| 状态 | 行号 | 类型 | 赋值点 | 引用 | 归属判定 | 备注 |
|---|---|---|---|---|---|---|
| `readingIntents` | 待定 | Map | 1（`queueReadingIntent`） | 内部 | 私有 | key ⊆ 6 kind，项内无函数值，`size ≤ 6`；见 §12.1.1 |
| `readingFlushRaf` | 待定 | let | 2 | 内部 | 私有 | 模块自己的 rAF，一帧最多一次 |
| `readingIntentStats` | 待定 | const 对象 | 0（`.coalesced/.dropped++` 属原地变更） | 内部 | 私有 | 覆盖计数 + 丢弃计数，只读不改 |

> **R5 联动**：L4 基线仍是 66 行；破环第一个提交必须**同提交**加这 3 行并把 R5 期望值 66→69，否则表过期即红。

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
  getCurrent(),          // → { pageNo }：enterReviewStep 用，必须同步、便宜（§12.4）
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

**`getCurrent()` 只给一个字段**（`pageNo`；`projectId` 全仓库 0 读者，按 §12.4 删掉），别加 `done/total/draftCount`：那是"顶部数字"，由模块自己渲染（badge 与它的数据源切在一起，见 §6 R8），外壳不拉。外壳拉一次状态，就会有第二个写点。

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

## 11. L1 施工表（**搬 160 + 删 52 = 212 行**；另有 1 个函数留 app.js）

> **行号基准 `c45b8a5`（app.js 21,065 行）。施工树已经漂过三次，行号整体偏移 100+ 行——施工前必须按「函数名」重新定位，行号只作参考。删除和搬运一律以函数名为唯一定位依据。**

**212 行 = 160 行搬 + 52 行删。** 8 个函数全仓库零引用，是死代码，**不要搬，直接删**；搬的只有 2 个。

> **`setReviewOverlaysForReading` 不搬**（Chief 2026-10-28 定，数据支持）：它用的 4 个符号 `pagesOverlayOn`/`pagesMarginOn`/`savePageMarginPreference`/`savePageOverlayPreference` 被 **11+ 个函数**共用（`openProject`(3014)、`renderProjectMeta`(3262)、`updatePageVisibility`(4974)、`applyPageZoom`(5103)、`openPageIndex`(8257)、`syncIndexToggles`(9198)、`openPreview`(9684)、`paintPreviewTile`(9567) 等），不是审校私有。搬进 reading 等于让审校模块**永久依赖**页面/目录/预览三个视图的显示状态——把已知放错的东西固化进边界。**留在 app.js 当外壳级的"显示状态适配"，等 pages/punct 搬时归 `core/display-prefs`。**

| 函数 | 行号 | 行数 | 处理 | 为什么在 L1 而不是 L2 |
|---|---|---:|---|---|
| `setReviewOverlaysForReading` | 18099–18116 | 18 | **留（不搬）** | 调用者 = `showView`(250) + `boot` 的 `enter:` lambda；**待归 `core/display-prefs`**（它依赖的 4 个页面显示符号被 20+ 函数共用）。**不计入 212** |
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

**判据**：L1 里的函数，其调用者只有两种——① 零引用（删）；② `boot()` 这个已被 `init` 覆盖的入口（`readingReloadAfterBatch` 走 `reload` 导出）。只要有一个调用者在 L2–L12，它就必须等那一层。

**L1 注入 = 临时 21 + 永久 3 = 24**（`el` 模块自带、`currentView` 改本地 `active`，都不注入）。

**L1 的注入依赖 = 24 个**（临时 21 + 永久 3）。**逐条名单以 §13.3 为准**，这里不重复（重复会漂）：
- 临时 21 按消失层：L2 10 / L3 2 / L4 1 / L5 3 / L6 1 / L8 4；
- 永久 3：`showView`（→`navigate()`）、`openPageDetail`（→注入）、`renderPunctGroupBadge`（→`onPunctGroups`）；
- 不注入 2 个：`el`（模块自带）、`currentView`（改本地 `active`）。

**L1 执行记录（工作区，2026-10-28，未提交）**：

| 数 | 值 | 说明 |
|---|---|---|
| 搬走行数 | **160** | `setupReading` 152 + `readingReloadAfterBatch` 8 |
| app.js | 21,015 → **20,885** | **净减 130** |
| reading-view.js | 229 → **400** | +171 |
| 差额 | **30** | `boot()` 里新增的注入 lambdas |
| 导出 keys | **11**（未变） | 棘轮没动 |
| `setupReading` | 模块 1 个定义 / app.js **0** | "真实现份数=1"成立 |

**三个数必须分开报：搬走 160 / 净减 130 / 骨架 +30。** 混成一个数以后对不上账——和"50 行死代码不进任何一层的账"是同一条。

**行数账（3,061 到底怎么来的；L1 改为 212 后更新）**：
- 3,061 = 53（头部：节注释 + 状态声明）+ 3,008（各函数区间）
- 3,008 = 2,995（121 个不同函数名）+ 13（**重名死定义**：`rerenderReadingLine` 首份 18860–18872，被 19289 覆盖）
- 12 层合计 = **2,977**（L1 从 230 降到 212，`setReviewOverlaysForReading` 的 18 行留在 app.js）
- 未归层 = 3,061 − 2,977 = **84** = 53（头部）+ 13（重名死定义）+ 18（`setReviewOverlaysForReading` 留外壳）× —— **没有 668 行缺口**
- `668 = 3,061 − 2,393`，而 2,393 是 **L1–L6 的累计**，不是 12 层合计。

---

### 11.1 L2–L12（只给函数名；行数已删）

> **逐函数行数全部删掉了**（2026-10-29，DevLead 提议、Architect 采纳）。理由：文档里的行数会变成第二个出处，第二个出处必然过期——今晚已经因此错三次（668、230→212、302→270）。
> **施工与对账一律按函数名**；层头的「估算 X 行」只用于排期和 19k 可达性估算，**不是施工依据**。
> 已执行层请在提交里报 §13.2c 的三个数（搬走 / 净减 / 骨架），**实测以提交报告为准**。


> L1 见 §11（**212 = 搬 160 + 删 52**；`setReviewOverlaysForReading` 18 行留 app.js，不计入）。`app.js ≈` 只扣函数体行，未扣 53 行头注释与状态声明。

**L1（212 = 搬 160 + 删 52）→ 累计估算 212，app.js ≈ 20,853，注入 24（临时 21 + 永久 3）**

- 函数清单见 §11 表；`setReviewOverlaysForReading`(18099–18116, 18 行) 留 app.js，不计入。

**L2（估算 342 行 / 11 函数）→ 累计估算 554，app.js ≈ 20,511，临时注入 30**

- `markReadingUserMoved 18128–18139`
- `startInlineEdit 18807–18835`
- `setReadingFilter 19068–19073`
- `setReadingHoverByBlock 20105–20133`
- `onReadingPdfScroll 20288–20312`
- `setReadingFollow 20404–20417`
- `renderReadingPreflight 20427–20466`
- `onReadingScroll 20511–20601`
- `stepReadingPage 20602–20611`
- `submitReadingDrafts 20747–20806`
- `undoReadingSubmit 20807–20832`

**L3（估算 213 行 / 7 函数）→ 累计估算 767，app.js ≈ 20,298，临时注入 35**

- `readingMovedSinceOpen 18140–18150`
- `openReading 18159–18279`
- `readingLineBox 18783–18796`
- `markEditingLineBox 18797–18806`
- `exitInlineEdit 18875–18898`
- `onInlineKeydown 18899–18914`
- `drawEditingLineBox 20480–20496`

**L4（估算 139 行 / 7 函数）→ 累计估算 906，app.js ≈ 20,159，临时注入 33**

- `loadReadingInlineEdits 18006–18025`
- `restoreInlineEditsPrompt 18026–18039`
- `loadReadingDrafts 18057–18071`
- `onInlineInput 18836–18843`
- `measureReadingTops 20276–20287`
- `gotoNextUnreviewed 20629–20694`
- `applyReadingSplit 20837–20840`

**L5（估算 1,041 行 / 32 函数）→ 累计估算 1,947，app.js ≈ 19,118，临时注入 36**

- `readingOptions 18086–18098`
- `applyReadingMarksPayload 18280–18291`
- `rebuildReadingEntries 18292–18316`
- `readingWindowHas 18327–18342`
- `ensureReadingMarksWindow 18343–18370`
- `loadReadingMarksWindow 18371–18391`
- `refreshReadingMarksPaint 18392–18443`
- `ensureReadingLineRendered 18444–18470`
- `renderReading 18509–18576`
- `buildReadingSentinel 18577–18599`
- `saveInlineEdit 18844–18861`
- `centerReadingLinePair 19095–19122`
- `openReadingPanel 19128–19201`
- `renderReadingTree 19382–19493`
- `scrollReadingToPage 19494–19520`
- `markReadingTreeCurrent 19521–19548`
- `jumpReadingTo 19549–19582`
- `ensureReadingPages 19583–19590`
- `buildReadingPages 19591–19637`
- `observeReadingTiles 19645–19698`
- `refreshReadingImageProfiles 19699–19719`
- `observeReadingColumnResize 19738–19750`
- `ensureReadingTile 19751–19755`
- `retryReadingPendingPanel 19900–19919`
- `ensureReadingBlocks 19920–19941`
- `setReadingHover 20134–20166`
- `markReadingCurrentTile 20167–20176`
- `updateReadingPageFromLeftScroll 20198–20240`
- `scrollStreamToPage 20254–20275`
- `verifyReadingPageSync 20313–20374`
- `updateReadingPage 20375–20403`
- `gotoReadingEntry 20701–20746`

**L6（估算 428 行 / 24 函数）→ 累计估算 2,375，app.js ≈ 18,690，临时注入 20**

- `saveReadingInlineEdits 18040–18056`
- `readingFlowPages 18471–18478`
- `readingEntryDone 18494–18498`
- `removeReadingSentinel 18600–18612`
- `buildReadingSegment 18663–18706`
- `scrollScrollerToCenter 19074–19090`
- `suppressReadingFollow 19091–19094`
- `hideReadingPanelHost 19202–19210`
- `startReadingEdit 19259–19279`
- `buildReadingTreePreview 19338–19368`
- `readingEntriesForPage 19369–19381`
- `disconnectReadingObservers 19638–19644`
- `warmSwapReadingImage 19720–19737`
- `ensureReadingImage 19756–19771`
- `pumpReadingImages 19781–19841`
- `releaseReadingImage 19842–19861`
- `markReadingImageFailed 19862–19899`
- `clearReadingDecorations 19965–19972`
- `scrollPdfColumnToPage 20177–20197`
- `markReadingDriver 20241–20245`
- `readingDriverActive 20246–20253`
- `hideReadingPdfBox 20467–20479`
- `drawReadingPdfBox 20497–20510`
- `logReadingNext 20612–20628`

**L7（估算 95 行 / 8 函数）→ 累计估算 2,470，app.js ≈ 18,595，临时注入 15**

- `readingInlineStorageKey 18002–18005`
- `readingMarkOrder 18317–18320`
- `checkReadingSegmentText 18640–18662`
- `span_at 18915–18918`
- `draftReading 19280–19296`
- `readingEntryLineText 19322–19337`
- `showReadingPlaceholder 19772–19780`
- `paintReadingTile 19942–19959`

**L8（估算 112 行 / 7 函数）→ 累计估算 2,582，app.js ≈ 18,483，临时注入 10**

- `saveReadingDrafts 18072–18085`
- `textCheckEnabled 18631–18639`
- `renderReadingProgress 19042–19067`
- `closeReadingPanel 19211–19232`
- `rerenderReadingLine 19297–19313`
- `readingPageRecord 19960–19964`
- `applyReadingLinked 19982–20000`

**L9（估算 163 行 / 5 函数）→ 累计估算 2,745，app.js ≈ 18,320，临时注入 8**

- `readingDraftStorageKey 17997–18001`
- `buildReadingLine 18919–19030`
- `readingProgressNumbers 19031–19041`
- `refreshReadingCurrentHighlight 19233–19258`
- `readingHoveredBlockIds 19973–19981`

**L10（估算 166 行 / 6 函数）→ 累计估算 2,911，app.js ≈ 18,154，临时注入 3**

- `readingVisibleSegments 18479–18493`
- `expandToWordRange 18613–18630`
- `readingLineText 18707–18717`
- `paintInlineRevision 18718–18782`
- `readingLineNode 19123–19127`
- `paintReadingDiffBoxes 20053–20104`

**L11（估算 62 行 / 2 函数）→ 累计估算 2,973，app.js ≈ 18,092，临时注入 1**

- `readingEntryVisible 18499–18508`
- `readingDiffUnits 20001–20052`

**L12（估算 4 行 / 1 函数）→ 累计估算 2,977，app.js ≈ 18,088，临时注入 0**

- `readingKey 17993–17996`

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
   **必须排第 1，不能先切 9 条边**（Chief 2026-10-28）：先切边的话审校环还挂在母环上，切完看不出改善，还会把母环的症状误判成"切错了"。
2. **切审校环的 9 条回调边**（渲染 → 数据/状态）：
   `renderReading→ensureReadingMarksWindow`、`renderReading→retryReadingPendingPanel`、
   `renderReadingTree→ensureReadingMarksWindow`、`renderReadingTree→scrollReadingToPage`、
   `openReadingPanel→updateReadingPage`、`setReadingHover→ensureReadingBlocks`、
   `verifyReadingPageSync→updateReadingPage`、`gotoReadingEntry→jumpReadingTo`、`gotoReadingEntry→updateReadingPage`。
   统一改法：**渲染只读状态、只把"要补数据/要跳页"塞进队列，由帧末的同步函数消费**；渲染不再直接调加载器、不再改页码。

#### 12.1.1 队列与帧末消费（Chief 决定一；Architect 定稿，HEAD `df77f19`）

**归属**：队列归审校模块，不归外壳。L5 之前声明在审校块内（`app.js:17938–20950` 内顶层），L5 时整段搬进 `reading-view.js`——**源码位置变，owner 不变**。

**形状**（这是全部，不许扩展）：

| kind | payload | 出队时调用 | 来自哪条边（HEAD `df77f19`） |
|---|---|---|---|
| `marks` | `{ pageNo }` | `ensureReadingMarksWindow(pageNo)` | 18549、19461 |
| `blocks` | `{ pageNos: number[] }` | `ensureReadingBlocks(pageNo)`（逐页） | 20136 |
| `panel` | `{}` | `retryReadingPendingPanel()` | 18527 |
| `jump` | `{ segmentIndex }` | `jumpReadingTo(segmentIndex)` | 20675 |
| `goto` | `{ pageNo, scrollLeft, syncStream }` | `updateReadingPage(…)` | 19164、20339、20670 |
| `scroll` | `{ pageNo }` | `scrollReadingToPage(pageNo)` | 19453 |

**四条硬规则**（都可机检）：
1. **队列项只能是字面量数据**，值里出现函数即违规——能塞函数就能塞"重绘完了通知我"，那就是事件总线，桥从后门接回来。
2. **每个 kind 只保留"当前愿望"，后写覆盖先写**（last-write-wins）。所以 **长度 ≤ 6 = kind 数**，是结构上限不是数值上限；出现第 7 项说明有人塞了非幂等事件，直接红。丢弃策略 = 覆盖，不排队。`blocks` 是唯一允许数组的 payload（一次悬浮覆盖多页），入队时按 `Set` 去重。
3. **单点写入、单点消费**：写只经 `queueReadingIntent(kind, payload)`；消费只在 `flushReadingIntents()`。渲染路径函数体内**不许出现** `ensureReadingMarksWindow / ensureReadingBlocks / retryReadingPendingPanel / jumpReadingTo / updateReadingPage / scrollReadingToPage` 这 6 个名字。渲染路径 = `renderReading`(18497) / `renderReadingTree`(19359) / `openReadingPanel`(19110) / `setReadingHover`(20111) / `verifyReadingPageSync`(20290) / `gotoReadingEntry`(20663)。用户主动操作的处理函数不受此限。
4. **消费用模块自己的 rAF，一帧最多一次**：`readingFlushRaf` 非 0 时不重复排帧；flush 期间新入队 → 不递归，排下一帧；`!active` 或 `exit()` → 清空、不消费；`enter()` 换项目同样清空。

**出队顺序固定**：`marks → blocks → panel → jump → goto → scroll`（数据先于跳页，跳页先于滚动校正）。写死顺序的理由：`goto` 后紧跟 `scroll` 会互相覆盖，这正是"页码跳回第 1 页"的成因之一，不能让实现者各自挑顺序。

**intent 粒度 = 用户可见的一次动作，不是一次函数调用。** `gotoReadingEntry`（20663）本来是 `updateReadingPage` + `scrollPdfColumnToPage` + `jumpReadingTo` 三件事（20670–20675）连着做；入队时必须是**一个** `goto` + 一个 `jump`，不许只搬其中一半——半搬会双滚，行为就变了。

**数据到达后的重绘不算渲染路径。** 19461 的 `ensureReadingMarksWindow(...).then(() => renderReadingTree())`、20136 的 `ensureReadingBlocks(...).then(paint…)` 是"数据到了补一次"的路径，消费方可以在 promise 回来后直调渲染/绘画；禁止的是**渲染函数自己**去调加载器。

**对外壳的推论（把 Chief 的"不持有外壳引用"变成可判定的句子）**：
- 允许：`init(deps)` 一次性注入、之后**不可增补**的依赖对象。判定 = 该对象上没有注册 API（`on*` / `add*` / `subscribe`）、没有 setter。
- 禁止：外壳的 rAF / setTimeout / 事件总线 / 全局回调表；以及**外壳在运行期主动驱动审校重绘**。
- 现存违规 1 处，破环必须一起清：`app.js:20967–20972` 的 `onViewportResize` 注入——外壳在 resize 时直接调 `measureReadingTops()` + `updateReadingPage()`。resize 是模块自己的事，改成模块自己绑 `addEventListener("resize", …)`、内部判断 active。

**与 §18 的两处对齐（DevLead 改措辞，我这边定口径）**：
- **队列上限 = 6，不是 32**。§18.1.4 的"上限 32"和 §18.4 C4 的"≤32"按本节改为 **≤6**；C4 的"丢弃计数"改读 `readingIntentStats.dropped`（`!active`/`exit`/换项目清空时累加），`coalesced`（同 kind 覆盖次数）只作发现、不算失败——高频覆盖是正常重绘，不是 bug。
- **§18.3 第 9 条边名字写错**：`gotoReadingEntry→jumpReadingToPage` 里的函数不存在（全仓库 0 处），实际是 `jumpReadingTo`（`app.js:19526`，调用点 20675）。按 `jumpReadingToPage` 数，这条永远 0 → 假绿，而且 base 上只能红 **12/13**，13/13 这条自证永远达不到。

**上闸三条（交给 TestDev，随破环第一个提交进 `run.mjs`）**：
1. 渲染路径 6 个函数体内不出现上列 6 个调用名（作用域 = 函数体；口径 = 去注释后文本匹配）；
2. 队列 payload 里不出现函数值（对象/数组递归查 `typeof === "function"`）；
3. `readingIntents` 的 key ⊆ 6 个 kind，且 `size ≤ 6`。

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

### 12.4 快照字段表：外壳从审校模块拉什么（唯一方向）

**量法**（HEAD `df77f19`，块 `app.js:17938–20950`，去注释后整词匹配）：块内顶层 `let/var` **62** 个，被块外引用 **2** 个——`readingPageNo`（20955、20970 两行）、`readingFollow`（20963 一行）；块内顶层函数 **113** 个，被块外引用 **7** 个，全在 `boot()` 注入对象（20953–20966）与 `showView` 兜底（`app.js:246–251`）。

**唯一快照 = `getCurrent()`，只许 1 个字段。下面这个块是唯一来源**（闸直接解析它，不许有第二份；§5 的接口注释也指向这里）：

```text
# snapshot-fields v1 —— 一行一个字段：<注入函数名> <字段名> <类型>
# 解析：跳过空行与 # 行；每行必须正好 3 列（空格分隔）；列数不符 / 函数名重复 / 0 条 → 闸红，不默认放行。
getCurrent pageNo number|null
```

**闸怎么用这张表（替代 §18.4 C2 的"名字以 get 开头"白名单，Chief 2026-10-28 定）**：
- `render*` 调用栈内，注入面只允许出现第 1 列的**函数名**；出现表外名字 = 红，不管它叫不叫 `get*`。把写操作改名叫 `getX` 洗白这条路因此不存在。
- 第 1 列里有、但名字不以 `get` 开头 → 放行。判据是表，不是命名习惯。
- 目前表里只有 `getCurrent`，而它在 `render*` 里实际 **0 处调用**（唯一读者是 `enterReviewStep`，`app.js:992`）；C2 的预期读数因此仍是 **0**，不是 1。

**加字段的流程**：只改上面这个块（+ §5 注释），上限 = 表行数，超过 3 行要 Architect 单独签字。**不许在代码里先加 getter、再回头补表**——闸在表里找不到就是红，这条正好卡死 Builder 担心的"各自加 getter 把导出面撑大"。

**证据裁掉的四个**：

| 候选字段 | 块外读者 | 裁定 |
|---|---|---|
| `projectId` | 0（`.projectId` 只在 2599 行是 `card.dataset`，无关） | 删；§5 的 `{projectId, pageNo}` 收成 `{pageNo}` |
| `done/total` / 未审校计数 | 0 | 不进快照；badge 由模块自己渲染（§6 R8） |
| 导出范围 | 0 | 不进快照；导出走 `export/preview?segments_only=1`（D-106），不读审校状态 |
| 草稿是否脏 | 0（`submitReadingDrafts` 20709 / `undoReadingSubmit` 20769 块外 0 调用者） | 不进快照；将来导出前若需先提交，加的是**命令** `flushDrafts(): Promise<void>`，不是字段，且要走本节 + §5 并带到期点 |

**契约**：同步、便宜（O(1)，不读 DOM、不触发渲染）、只读；返回对象只含上表字段，多一个都算越界。`Object.keys(getCurrent()).length` = 表行数 = **1**，不得为 0（992 行依赖它）。

---

## 13. 注入依赖数的口径（今天这个数飘了 24/28/30，写死在这里）

**数的定义（唯一口径）**：某一层搬完之后，**已搬进模块的代码**所引用、**但仍留在 app.js 的"审校块内顶层函数名"**个数。按名去重，一个名字算 1。

**明确不算**：状态变量（`readingData` 等本轮不搬）、块外服务符号（`apiJson`/`exportOptions`/`currentProject`/`localStorage`）、浏览器 API、本层已搬进来的函数。

> 所以文档里那个"28 个外部符号"是**另一个数**（整个块对外部世界的依赖面，含状态与服务），**不是**这个仪表盘；`el`（模块自带 3 行）和 `currentView`（改模块自己的 `active`）都不在 28 里。

**怎么数（可复现）**：对 app.js 做引用图，取已搬层所有函数的出边，减去落在已搬集合内的目标，按名去重计数。

### 13.1 每层预期值

| 层 | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 | L9 | L10 | L11 | L12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 预期注入（估算） | 24 | 30 | 35 | 33 | **36** | 20 | 15 | 10 | 8 | 3 | 1 | 0 |
| **实测** | **24** | **26** | — | — | — | — | — | — | — | — | — | — |

### 13.2 它不单调递减——"变大就是切错"作废

形状是**先升后降**：L1→L5 上升（24→36，峰值在 L5），L6 起单调降到 0。
原因：每搬走一层，会新增"这一层 → 尚未搬的叶子"的出边；L5 是核心环，它的出边最多。**L6 之后变大才算切错**；L2–L5 变大是预期行为。

### 13.3 两个数分开报

- **临时注入**（会被内化）：上表。**L4 结束时是 33，不是 0**；到 L12 才归零。
- **永久依赖**（永远内化不了，属 core/服务层）。**到 L4 结束实测 = 14 个，不是 5 个**：`apiJson`、`currentProject`、`loadFinishSummary`、`openPageDetail`、`pagesMarginOn`、`pagesOverlayOn`、`project_id`、`refreshGarbledLines`、`refreshPunctGroups`、`renderPunctGroupBadge`、`savePageMarginPreference`、`savePageOverlayPreference`、`showNoticeBar`、`showView`。
  （`el`、`currentView` 不算：模块自带 `el`、`currentView` 改本地 `active`。Chief 批的"永久 5"只是其中的"块外服务"子集——`apiJson`/`exportOptions`/`currentProject`/`localStorage`/`performance.now`；L4 的真集合还要加上路由 2 个、标点 3 个、页面视图状态与偏好 4 个。）
  **`refreshPunctGroups` / `renderPunctGroupBadge` 不算临时债**——它们是跨模块（标点），必须走已存在的 `onPunctGroups` 注入，不许由 `openReading` 直接调。

---

## 14. 面板落位：6 个写点收敛归哪一层

**归前置清障（L0），在 L4 之后、破环之前，不归 L5。**

理由：写点分属 **L5（3 个函数）、L8（1 个函数）**，任何一层单独搬都会留下"模块写一次、app.js 写一次"的中间态，正是反模式 #3。收敛必须在 L5 之前做完；放 L4 之后是因为 L1–L4 碰不到这两个状态，提前做反而会和搬运混在一起。

**排期位置（Chief 2026-10-28 定）**：`L1–L4 → L0（面板收敛）→ 破环 → L5 六刀`。L0 独立提交、不单独 tag（回滚它会让 L5 编译不过，tag 的独立回退价值不成立），净增约 15 行。

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
2. 消息发出后，**必须拿到对方的一句回执**（例："L1 表收到，212=160+52"）；没有回执 = 未交接。
3. 回执里要复述关键数字——复述不了说明没真读。
4. **含行号的名单必须写基准 SHA。** 给名单时标注"行号基准 = 哪个 commit"；接收方施工时**按名字定位，行号只作参考**。
5. **删除/搬运一律以函数名为唯一定位依据。** 行号会漂，名字不会。按行号范围切，任何一次上游改动都会把范围切在别的东西上——**复核边界挡不住漂移**。
6. 已知事故（两个）：
   - Builder 的"前置页有差异但不可审"结论一路交接下来，QA 一条实测（流外队列页 = 0）就否了，白改一轮。**传错的结论比多贴一遍表贵得多。**
   - `readingTreeOpen` 事故（2026-10-28）：L1 的 52 行删除拿 `c45b8a5` 的行号范围去切 `2b67132` 的树，范围上移吞掉了 `const readingTreeOpen = new Set();`。HEAD 上该名字出现 7 次、声明 0 次，进审校页打开左树直接 `ReferenceError`。**JS 单测不加载渲染器，所以那时还是全绿。**
7. **施工后按名字复核**：`git grep -c` 逐个核"要删的确实没人用、要留的确实还在"，别只跑测试。
8. **提交署名（2026-10-28，破环前已发生）**：`84c26f8` / `ae71e48` 两笔的提交信息没有列出 Architect 的四处改动（§12.1.1 / §12.4 / §3 S10），是别人 `git commit -a` 卷进来的。内容已核对无误，**不回退、不改写已推历史**，追溯靠本节这一行。**破环期间禁用 `git commit -a`，只 `git add <具体路径>`**——破环的提交序列要能单独回退、单独署名。


---

## 16. R3（DOM 归属）上闸规格 —— 目标 4/8

**规则（按作用域分两条）：**
1. **模块文件**（`static/*-view.js`）：出现的每个 DOM id 字面量，必须能在自己 `<section id="view-X">` 的子树里找到。**零豁免。**
2. **外壳 `app.js`**：引用 `#view-reading` 的 id 的语句，**其所在函数必须归 reading 所有**。归 reading 的函数 → 合法（它们随 L1–L12 搬走）；**不归 reading 的函数 → 一律红**。

**"归 reading 所有"怎么判**（与 R5 同一套口径：按 owner 判，不按行号）：
- 函数区间落在审校块标记内（起点 = 含 `阅读审校（L 刀` 的行，终点 = `^function boot\(` 前一行，每次运行重算）；**等价于 §11/§11.1 那 121 个名字**；
- 已搬进 `reading-view.js` 的函数归模块所有；
- **行号不作判据**（§15 第 5 条）。

**豁免表：4 行**（到期 = punct 整体搬完），`MAX = 4`，**只降不升**，过期也红：

| 行（`c45b8a5` 基准） | id | 所在函数（不归 reading） | 到期 |
|---|---|---|---|
| 17647 | `reading-garbled-count` | `renderGarbledBadge` | punct 整体搬 |
| 17651 | `reading-garbled-open` | `renderGarbledBadge` | 同上 |
| 17753 | `reading-punct-count` | `renderPunctGroupBadge` | 同上 |
| 17761 | `reading-punct-open` | `renderPunctGroupBadge` | 同上 |

**实测读数（HEAD `c45b8a5`）**：
- `#view-reading` 子树 id：**39 个**
- `app.js` 引用到的：**34 个**（只经 `el("…")` 的 30 个；另有 4 个还有非 el 用法：`reading-stream` / `reading-tree` / `reading-pdf-scroll` / `reading-diff-layer`）
- 由 **reading 所有的函数**引用（天然合法，不进豁免表）：**30 个**
- 由**非 reading 函数**引用（真越界，进豁免表）：**4 个 id / 4 行 / 2 个函数**
- `app.js` 完全不引用：5 个（`reading-grip-pdf` / `reading-grip-tree` / `reading-next-hint` / `reading-proof-holder` / `reading-split`）

**为什么不用 id 级豁免**（Chief 2026-10-28 裁定，推翻 `4a6f675` 的 34 行方案）：

| | 按 id 豁免 34 条 | 按引用位置判（本版） |
|---|---|---|
| 审校块内 30 个引用 | 靠豁免表放行 | **天然合法，不需要豁免** |
| 块外 4 行真越界 | 埋在 34 条里，看不见 | **单独 4 条，带到期点** |
| 将来 punct/pages 新写一个 `reading-*` | **被豁免表盖住** | **立刻红** |

同一份代码、同一个 HEAD，两种判据一样绿；**差别只在未来那个洞**。这和"例外表挂着已删代码"是同一类松。（**已落地**：`2046673`，位置判；豁免 4 条、`MAX=4`；变异验证覆盖"块内顶层代码引用 → 红"这条只有位置判才抓得住的情形。）

> **一处待改的文案**：测试里 4 条豁免的 `expires` 写的是「正文流① 搬完」，但它们的触发点是 **punct 整体搬完**（那 4 行是 `renderGarbledBadge`/`renderPunctGroupBadge` 在写）。不影响行为（测试是"引用消失即红"），但会误导排期——正文流① 在 punct 之前，照字面读会以为豁免更早到期。

**算法**：① 按标签深度扫 `index.html`，取 `view-reading` 子树 id（别见第一个 `</section>` 就停，里有嵌套）；② 去注释与字符串后扫 id 字面量；③ **每个引用点归属到包裹它的顶层函数**，判断该函数是否归 reading；④ 非 reading 函数的引用必须命中 4 行豁免表。

**红/绿**：红 = Slice 3（`6a99114`）之前 7 行 / 5 个 id；绿 = 非 reading 函数只剩上表 4 行。**L1–L12 全部搬完后，非 reading 函数对 reading id 的引用应为 0，豁免表清空，R3 进入零豁免形态。**

## 17. R5（一状态一 owner）上闸规格 —— 目标 6/8

**判据**：文档 §3 的 66 行归属表就是 owner 清单。某状态的**任何赋值点**落在非 owner 文件里 = 违规。

**口径（三件套）**：
- **作用域**：全仓库 JS（`static/app.js` + `static/*-view.js`），按文件归属。
- **口径**：去注释与字符串；赋值点 = `NAME =` / `+=` / `-=` / `++` / `--`；**排除** `==` / `===`、声明行（`let NAME =`）、以及 `NAME.set/.add/.push/.delete` 这类原地变更（第一版不查原地变更，口径写在这里，别以后争执）。
- **对象**：被测 SHA 的源码树。

**怎么数**：
1. 测试里硬编码 `OWNERS = { 状态名: "app.js" | "reading-view.js" }`（来源 = 文档 §3）。
2. 逐文件扫每个状态的赋值点行号。
3. 断言每条的所在文件 == owner。
4. **另加两条防表过期**：OWNERS 里的每个状态必须在源码里还存在（删了状态不删表项 → 红）；每次搬层要把对应表项改成模块文件（同批提交，不同批 → 红）。

**现状读数**：**67 条** = 66 个 app.js 状态 + `readingSplitState`（owner = `reading-view.js`）。当前 `reading-view.js` 不写任何 app.js 状态 → **违规 0、豁免 0**。

> 更正（2026-10-28，TestDev 实测）：原写 66 条，漏了 `readingTreeOpen`——它在 `09e6af3` 被误删、随后补回，现在是活声明（`5fd4ac7`），所以 OWNERS 必须是 67。**这不是数字打架，是"被删掉的状态还算不算"的判据：算。因为它被引用。**

**变异样例（必须先在假数据上红）**：在 `reading-view.js` 里插一行 `readingPageNo = 5;` → 期望报
`readingPageNo 的 owner 是 app.js，reading-view.js:NNN 写了它`。
反向变异：把 `readingSplitState` 的 owner 改成 `app.js` 且 app.js 不写它 → 表过期检查应报"owner 与写点不一致"。

**为什么现在就有用**：面板那个"6 写点"就是这条规则的现实证据——`readingPendingPanelKey` 的写点横跨 L5 和 L8。R5 上闸后，任何"顺手在别处写一下"都会立刻红。


### 13.2b 机检覆盖数（架构健康指标之一）

**定义**：`(已上闸的规则数) / (应当上闸的规则总数)`。统计对象 = 文档 §2 的规则表。

规则清单（**R4 与 R4b 算同一判据的两种形态，计 1 条**）：
R1 依赖方向 / R2 视图互引 / R3 DOM 归属 / R4 真实现份数（含同文件重名）/ R5 一状态一 owner / R6 一模块一接口对象 / R7 禁 `type=module` / R8 不许新增导出 / R9 no-undef = **9 条**。
`R10`（注入不缓存）是评审清单，**不计入分母**。

**现状 7/9**：已上闸 R1、R3、R4(含 R4b)、R5、R7、R8、R9；待上闸 **R2**（要等第二个视图模块）、**R6**（一模块一窗口接口对象）。

> 分母曾经从 8 变到 9，是 R9 加进来造成的；**报这个数必须同时报"分母由哪些规则组成"**，否则又会飘。TestDev 报过 7/8，是分母没跟着加 R9。

### 13.2c 一笔提交的三个行数（搬走 / 净减 / 骨架）

**每搬一层，必须报三个数，不许合并**：
1. **搬走行数**（函数体行，按名字可数）；
2. **净减行数**（`app.js` 前后差）；
3. **骨架增量**（模块侧新增的 IIFE/注入 lambdas/注释）。
三者关系近似 `净减 = 搬走 − 骨架`，但不必相等——差额要能解释。L1 的实例：搬走 160、净减 130、骨架 +30。
另：**死代码删除单独记账，不进任何一层**（`09e6af3` 的 52 行属于删除账，不属于 L1 的搬走账）。

### 13.3 报数必须带对象（Chief 2026-10-28）

同一个数在不同对象上不同值，**报数时必须写清对象**：

| 数 | 对象 | 口径 | 状态 |
|---|---|---|---|
| **24** | **新 L1**（`setupReading` + `readingReloadAfterBatch`） | 出边 = 临时 21 + 永久 3 | **现行** |
| 21 | 新 L1 临时 | 块内顶层函数名，按名去重 | 现行 |
| 3 | 新 L1 永久 | 块外符号（`showView`/`openPageDetail`/`renderPunctGroupBadge`） | 现行 |
| 28 | **全块** | 审校块所有代码 → 块外顶层符号 | 现行 |
| 22 | 方案 A（L1 也搬 `setReviewOverlays`）临时 | 块内函数名 | 已否决（见 §11） |
| 7 | 方案 A 永久 | 块外符号 | 已否决 |
| 23 | **旧 8 函数 L1 名单**（208 行版） | 块内函数名 | **作废** |
| 30 | — | 那是"上限"，不是读数 | **作废** |

**新 L1 临时 21 个，按消失层**：L2 10（`markReadingUserMoved`/`startInlineEdit`/`setReadingFilter`/`setReadingHoverByBlock`/`onReadingPdfScroll`/`setReadingFollow`/`onReadingScroll`/`stepReadingPage`/`submitReadingDrafts`/`undoReadingSubmit`）；L3 2（`openReading`/`exitInlineEdit`）；L4 1（`gotoNextUnreviewed`）；L5 3（`renderReading`/`openReadingPanel`/`setReadingHover`）；L6 1（`saveReadingInlineEdits`）；L8 4（`saveReadingDrafts`/`renderReadingProgress`/`closeReadingPanel`/`rerenderReadingLine`）。
**永久 3 个**：`showView`（→ `navigate()`）、`openPageDetail`（→ 注入）、`renderPunctGroupBadge`（→ `onPunctGroups`）。
**不注入 2 个**：`el`（模块自带）、`currentView`（改本地 `active`）。

> 前一版报的"24 临时"里有 3 个（`renderReadingPreflight`/`paintReadingTile`/`readingMarkOrder`）分别来自 3 个**将被删除的死函数**，死函数一删它们就不在账上了。这就是"先剔死代码再量耦合"（§2）的现实价值。

---

## 18. 破环验收判据（DevLead，2026-10-28）

这是 Chief「决定二」的可执行层。**切完 = 13 条边（4 桥 + 9 回调）同时满足静态判据（闸 B）与运行时判据（闸 C），且特征测试契约（闸 A）未被破坏。** 缺一条只能报「切了，未验收」，不能报「通过」。

### 18.1 一条边算完的定义（DoD）

1. 静态：该边的调用点 = 0（闸 B）
2. 行为：锁住该边的特征测试在 `ring-break-base` 上绿，切边提交后仍绿（闸 A）
3. 运行时：模块的注入面不向外壳回流（闸 C）
4. 队列：kind 名 ⊆ 6 个、`flush` 后残留 **0**、单点写入单点消费、payload 内无函数值；`!active`/`exit`/换项目清空，`readingIntentStats.dropped` 可读（口径在 §12.1.1，归 Architect）
5. 提交：切边提交不含 L1–L4 搬运，不含 `tests/js/` 的删除行（闸 A）

§12.3 说「先写特征测试，切完必须一样」——**测试放在哪次提交**必须写死，否则「一样」是自证。见 18.2。

### 18.2 闸 A：特征测试契约（删除行 0 + 回放）

基点 = tag `ring-break-base`（L4 结束那份，§12.3）。对象 = 被测 SHA 的树。

| # | 断言 | 怎么红 |
|---|---|---|
| **A1** | **逐笔**：任何一笔切边/产品代码提交，`git show --name-only <sha>` ∩ `tests/js/` = ∅（新增也算） | 切边提交里带测试文件 → 红 |
| **A1b** | **序列合计**：`git diff --numstat ring-break-base..HEAD -- tests/js` 删除行合计 = **0**，删除文件 = **0** | 测试提交里删/改旧断言 → 红 |
| **A2** | **回放**：序列内新增的每个测试文件，在 `ring-break-base` 的 worktree 上跑必须**绿** | 只为切后行为量身写的测试，在 tag 上红 → 红 |
| **A3** | 改判据必须单开提交：不含产品代码、首行 `test-contract:`、DevLead 在 §18.6 登记；该提交后 `ring-break-base` 前移 | 夹在切边提交里 → 红 |
| **A4** | **变异红（两遍，同一份文件、同一个 base worktree）**：① 拷测试进 base 树、不插变异跑一遍必须**绿**（= A2 回放）；② 在 base 树上按**变异阶梯**插一处变异（临时，不进提交），同一份测试必须**红**。阶梯：**T1** `callee` 全仓库只有 1 个调用点 → 插 `callee` 首行 `throw`；**T2** `callee` 有多个调用点 → 把**该边的这一次调用**替换成 `void 0`（caller 其它行为不动，仍能证明测试依赖的是这条边）；**T3** 调用点无法单独中和 → 退回 `caller` 首行 `throw`，提交说明写明 T1/T2 为什么做不到。两遍都过才算锁住；绿了但没红 = 锁的不是这条边，单列报，该边不算算完 | 不插变异不绿 = A2 红；插了仍绿 = 假锁，红 |

**为什么要有 A2**：只查「不许改测试」挡不住「新写一条只对切后成立的测试」——结局和改断言一样。回放把「它锁的是旧行为」变成可机检的事。
**为什么要有 A4**：A2 只证明「测试在旧树上绿」，挡不住「测试根本没走那条边」——绿可能锁的是外壳按钮。
**A4 为什么打在 callee 上**（Chief）：打 `caller` 首行只能证明「测试跑到了这个函数」——任何顺带调用 `renderReading` 的断言都会失败，证明不了它依赖的是**这条边的效果**。所以变异插在基线树上**被调用那一端**；`callee` 被多个调用方共用、隔离不到这条边，才退回 `caller`，并在提交说明里写明理由。
**9 条边的预期阶梯**（HEAD `d90aa45` 的树，按名字数，行号会漂）：**T1 只有 1 条**——`renderReadingTree→scrollReadingToPage`（`scrollReadingToPage` 全仓库 1 个调用点）；其余 8 条 callee 都共用（`ensureReadingMarksWindow` 4 个调用点 / `updateReadingPage` 10 个 / `retryReadingPendingPanel` 2 个 / `ensureReadingBlocks` 2 个 / `jumpReadingTo` 3 个），走 T2。**共用不等于判不了**：T2 中和的是那一次调用，不是整个 callee。**边 8、边 9 共用 caller `gotoReadingEntry`，T3 对两者是同一个变异、区分不了，这两条必须 T2。** 9 个调用点全是独立语句，`void 0` 语法都合法。
**A4 的对象固定死在 base 树上**（Architect）：切完队列后 9 条边的效果都挪到帧末 flush，在切后代码上插 `throw` 也会红，但那时红的是「队列还在跑」，证明不了同一条边。所以只认 base 树上的红。
**只锁用户可感知的结果**（面板开了、页码对上、树高亮）：新增测试里**不许断言调用次数、调用顺序、注入面调用**（C1–C4 探针除外）。锁了顺序的测试切完队列必红，会被误判成「切错了」；而顺手在切边提交里改测试会立刻撞 A1（删除行 0），只能走 A3 单开提交。这条由 TestDev 做成静态检查，与八道闸并列领 R 编号。

**权限**：只有 DevLead 能登记 A3 并移动 `ring-break-base`；Builder 不可。A4 的插 `throw` 小脚本归 TestDev（插一行、跑一条、2 秒级）。

### 18.3 闸 B：静态边棘轮（13 条）

对象 = 被测 SHA 的源码树，纯文本扫描，不加载、不跑 DOM。

| 组 | 条数 | 判定式（全仓库计数） |
|---|---|---|
| 桥 | 4 | `showView(` 出现 = 0：模块文件内 + 这 4 个函数体内各自 `showView(` = 0 |
| 回调边 | 9 | 每条：`caller` 函数体内 `callee` 出现 = 0 |

**桥（4）**：`setupReading`、`openPageDetail`、`renderMergeView`、`submitMergeDecisions` —— 改走注入的 `navigate()`。
**回调边（9）**：`renderReading→ensureReadingMarksWindow`、`renderReading→retryReadingPendingPanel`、`renderReadingTree→ensureReadingMarksWindow`、`renderReadingTree→scrollReadingToPage`、`openReadingPanel→updateReadingPage`、`setReadingHover→ensureReadingBlocks`、`verifyReadingPageSync→updateReadingPage`、`gotoReadingEntry→jumpReadingTo`、`gotoReadingEntry→updateReadingPage`。

**棘轮**：13 条合计预期 **0**，任何一条从 0 变 ≥1 = 红。**红/绿证据**：在 `ring-break-base` 上同一份检查必须红出 **13/13**（证明抓得到这些边），最终提交 0/13。模块里 `showView` 现在还挂在 R1 例外表上，破环后该行必须删、例外表回 0 行（上限 3 不动）。
R 编号由 TestDev 在闸表里领，§2 的 R1–R8 不动。

> **第 9 条边 2026-10-28 更正**：旧名 `jumpReadingToPage` 全仓库 **0 处**，照它数永远 0——假绿，base 上最多只能红 12/13。实为 `jumpReadingTo`（`app.js:19526`，调用点 20675）。更正后实测：**HEAD `e0a8f4b` 的树，13/13 全部可检出**（9 条回调边 + 4 条桥，各命中 ≥1 处）。这只是证明名字对、边在；**真正的 13/13 红证据要在 `ring-break-base` 上重验**。
>
> 若某一条在破环范围内做不到 0（合法到期点在 L5），**不许悄悄放过**：走 §18.6 登记、条数从 13 改成 12 并写明到期切片。

**base 13/13 红证据（L4 打 tag 时填实数；四件缺一 = 不算证过）**

「闸抓得到」和「边还在」是两件事：今天证的只是前者，后者必须在 `ring-break-base` 同一棵树上重证，且要留下能复查的东西——否则三个月后只剩一句「我们当时说 13/13」。

| 件 | 填什么 |
|---|---|
| SHA | `git rev-parse ring-break-base` 的输出（长 sha） |
| 谁跑 | **DevLead 跑**并落文件；**TestDev 用同一命令复跑**比对，字节不一致 = 红 |
| 命令 | 一行、可复制（跑闸 B 的入口 + `--expect-red`，入口名以 TestDev 落地为准） |
| 输出文件 | `docs/refactor/evidence/edge-ratchet-<shortsha>.txt`，原样 stdout，随 tag 同批提交 |

**判据**：输出里必须**逐条列出 13 条边的名字**且每条标 RED。少于 13 条 = 不许打 tag；也不许把证据降成 N/13 再宣布通过——那走 §18.6 登记到期点。

### 18.4 闸 C：运行时注入面探针（一次运行，四条断言）

对象 = e2e 在真实 662 页书上跑的固定序列 **S1**，不是「随便点几下」。
**S1 七步**：进审校 → 「下一处未审」×3 → 编辑一条并保存 → 开面板 → 关面板 → 打开批量采用面板（不执行）→ 导出预检。

探针：包住 `init()` 注入的每个函数，记录「调用栈里当前是否在模块的 `render*` / `flush` / 模块自持 rAF 内」。

| # | 断言 |
|---|---|
| **C1** | `render*` / `flush` 路径内调用 `navigate()` 次数 = **0** |
| **C2** | `render*` 调用栈内，**快照表外**注入面调用次数 = **0**。白名单 = §12.4 的 `snapshot-fields v1` 可解析块（一行一个字段 `函数名 字段名 类型`），**闸直接读这个块，文档与闸同源** —— 名字以 `get` 开头但不在表里 = 拒；在表里但名字不以 `get` 开头 = 放行；**0 条 / 列数不符 / 解析失败 = 红，不默认放行** |
| **C3** | `flush` 重入 = **0**；同一队列快照被消费 = **1** 次 |
| **C4** | 队列 kind 名 ⊆ `{marks, blocks, panel, jump, goto, scroll}`（6 是**结构上限**不是数值上限；出现第 7 个 kind = 设计变更，走登记）；`flush` 后**残留 = 0**（>0 = 消费不清，红）；`readingIntentStats.dropped`（清空时累加）≠ 0 单列报；`coalesced` 只作发现、不算失败；payload 内函数值 = **0**（出现即违规，堵事件总线从后门接回来） |

C2 是这条闸真正的价值：9 条边的共同形态就是「渲染里顺手取数/改页」，C2 直接量它。
C4 不查深度：6 个 kind 每 kind 覆盖写，深度 ≤6 是构造出来的恒真，查它等于没查（Chief）；真正会出事的是「消费不清」，所以判据是 flush 后残留 0。
若真实数据上某条 `render*` 必须同步取数 → **不许改闸**：报 Architect 改设计，或走 §18.6 判据变更。

### 18.5 联合验收（报「通过」的唯一格式）

**第 0 步（先于三条闸）**：`python3 tests/e2e/qa.py fingerprint` 逐字段全等（离线，不起服务、不开浏览器）。**不等 = 直接拒**，闸 A/B/C 不用跑——输入都换了，数漂不说明任何事。锚在 QA 的 `BASELINE.md`「三元组」。

之后四条全绿才签收：

1. 闸 A / B / C 在 **被测 HEAD 的 sha** 上全绿，附可复现命令与读数
2. 基线三元组逐项相同（输入指纹 + 管线产物指纹 + 前端读数，归 QA 的 `BASELINE.md`）。**输入指纹不符 = 不受理**，不叫「数漂了」
3. 已知 FAIL **必须原地 FAIL**：K1（手动滚走后面板/顶部/左栏三方分叉）、K2（尺寸变化后 `line=0 mark=0`）。它们变绿要单独报，不算破环收益，也不算「顺手修好」
4. 报数格式：`HEAD <sha> / 工作区 <状态> / 读数 <对象> <值>`

### 18.6 判据变更登记

| 日期 | 判据 | 变更 | 批准人 | 提交 |
|---|---|---|---|---|
| 2026-10-28 | A1 | 按字面逐笔执行：切边提交内出现 `tests/js/` 即拒；新增测试放相邻独立提交，再受 A2 约束 | Chief | f69df40 |
| 2026-10-28 | A4（新增） | 变异红两遍：拷测试进 base 树跑绿 → 按 T1/T2/T3 阶梯插变异跑红；callee 共用时 T2 中和该次调用（不是整个 callee），T3 仅兜底并写明理由 | Chief | f69df40 |
| 2026-10-28 | 特征测试口径 | 新增测试不许断言调用次数、顺序、注入面调用（C1–C4 探针除外），TestDev 做成静态检查领 R 编号 | Chief | f69df40 |
| 2026-10-28 | C2 | 白名单改为 §12.4 `snapshot-fields` 可解析块（同源），废掉 `get` 前缀法 | Chief | f69df40 |
| 2026-10-28 | C4 | 上限改为「kind ⊆ 6 且 flush 后残留 0」，改读 `readingIntentStats.dropped`，不查深度 | Chief | f69df40 |
| 2026-10-29 | A1b / A3 | 删：旧偏好用例里借 `splitPrefs/saveSplit` 直读内部的两行，以及「序列净删除 0」的旧判法；补：偏好用例改真实拖动事件（`pointerdown→pointermove→pointerup`，断言 CSS 变量 232→300px + localStorage + 重载保持），A1b 改成「只有合规 test-contract 提交可删 tests/js 行」，合规 = 三样俱全；变异：`MAX_EXPORTS 6→5`／`TEMPORARY` 塞回 `splitPrefs`／产品侧松手不 save 各自红在目标断言 | DevLead | 50bc45f |
| 2026-10-29 | R9 / R11 | 删：R9 只认「成员访问/调用/赋值目标」的旧口径、R11 写死两份文件且把缺函数体记 0 的旧实现；补：R9 三种裸引用（实参/条件/模板 `${}`）与 class 参数声明，R11 扫全目录 `*.js` 且缺函数体即红，两条各加「喂合成样例必须红」的自检；变异：三种裸引用喂进去必红、六种非引用必不红；caller 改名/搬到第三份文件必红；删掉 §18.6 某行 → A3+A1b 红，清空「变异」一格 → A3 红 | DevLead | 5c2f5ab |
| 2026-10-29 | L7–L10 测试耦合 | 删：草稿用例直调 `ctx.draftReading` 的两行、「已审计数」的 `progressNumbersSkip` 守卫（它会让这条永久 skip = 覆盖倒退）、R4b 例外表最后一条与 `MAX 1`；补：草稿改走「下一处未审」开面板 + 点「保留原文/采用候选」，「已审计数」改读 `#reading-progress-text` 并对换窗口前后各断言一次，installReadingDeps 的 setter 改成"宿主对象直接赋进 vm"（Map/观察器不再被 JSON 抹成 `{}`），两条集成断言改 module==1 + 合查；变异：进度总数改回按窗口条目数、草稿 key 加时间戳、setter 回退 JSON、app.js 塞两份同名函数、模块两处字面量改名，各自红在目标断言 | DevLead | f70f544 |
| 2026-10-29 | L7–L12 契约 | 删：`load-app` 默认 require `readingDiffUnits`、behavior 里对 `ctx.readingKey/readingEntryVisible/readingProgressNumbers/draftReading` 的 vm 直调、「当前项」两条在 app.js 里找 `is-current` 的断言（抓到的是左侧按钮同名类）；补：新增 `load-reading-view.mjs`（测试侧剥 IIFE，零侵入取模块纯函数）、3 条被 skip 的 `compute-char-spans` 用例改跑、5 处集成改 module==1 + 合查、`line_spans` 合查、当前项改锁"panelKey 决定 + 有 is-current 着色"；变异：改坏 readingDiffUnits 分支条件 / 去掉 chars 过滤判断 / 改 readingKey 键格式 / 改掉 panelKey 与 is-current，各自红在目标断言 | DevLead | 381099c |
| 2026-10-29 | ① 状态迁移 | 删：behavior 里对 app.js 状态的读写（`resetState`/`setEntries`/`readState` 走 `runInApp`）、R4-dup 里 `injected.setReadingFilterValue` 注入链断言、R3 的"找不到审校块即红"、OWNERS 里 3 个零引用状态的表项；补：`installReadingView` 在 IIFE 内追加测试专用 `window.__rvEval` （读写模块词法作用域状态，不改产品文件）、OWNERS 64 条 owner 全量改 `reading-view.js`、R4-dup 改锁"写值 + 立即重画"、R3 把空块当合法（块外引用仍判越界）；变异：owner 改回 app.js / 补回已删状态 / app.js 塞 `el("reading-stream")` / 去掉重画 / 不挂统计对象 / 草稿不参与过滤，各自红在目标断言 | DevLead | cf10d42 |
| 2026-10-29 | R6 / R2 上闸 | 删：无（新增两条闸）；补：R6 判"每个 *-view.js 恰一个 window.XxxView、名字由文件名决定"，加 7 条 `__b2t*` 埋点例外（owner + 到期点 + MAX 只降不升 + 条目必须存在）；R2 判"x-view.js 不得引用 window.YView（Y≠X）"，跨视图走 deps 注入；两条各带合成样例自检；变异：多露一个接口 / 接口改名 / 引用别视图接口，逐条红在目标断言；自检里名字错、零接口、未登记埋点、跨视图引用喂进去必须红，正例必须绿 | DevLead | f8e690a |
| 2026-10-29 | R6 埋点判定 | 删：R6 里"每个 *-view.js 都必须有那 7 个埋点"的判法（第二个模块一出现就假红 7 条）；补：改成"出现即登记"（扫到的 `window.__b2tXxx` 不在表里才红；没有埋点完全合法），表本身的两条改成跨所有 view 文件判，自检加"无埋点合法"与"全仓库都没有则表过期"；同时把 preview 试点 4 处集成断言改 `script + preview-view.js` 合查；变异：preview 加未登记埋点 → 红「未登记的 window 埋点」；删 `__b2tNextLog` → 红「表挂着不存在的埋点」；模块里改名 `onPreviewScroll` → 集成红在 `preview_both` | DevLead | 03ea679 |
| 2026-10-29 | R6 埋点 + preview 集成 | 删：R6 里"只滤已登记埋点"的过滤顺序（新埋点会被报成接口对象，文案带偏）；补：登记 `__b2tPreviewMetrics`/`__b2tPreviewTileTops`（`MAX 7→9`），改成先按 `__b2t` 命名分类再判接口数量，自检加"混合样例里接口检查零问题、埋点检查必须报"；preview 两个集成用例 13 处改合查、`builder` 切片从合查取、`pagesMarginOn` 拆成"模块调注入 + app setter 写状态"两条；变异：加未登记埋点 / 删已登记埋点 / 去掉 `setPagesMarginOn(true)` / setter 不写状态 / 切片里塞监听，逐条红在目标断言 | DevLead | 25f4787 |
| 2026-10-29 | R5 状态登记 | 删：无；补：OWNERS 增加 preview 的 27 条（owner = `preview-view.js`，按源码声明核过）与 reading 一直漏登的 `readingIntents`/`readingIntentStats`/`readingFlushRaf`，总数 64 → 94；新增"R5 防漏检"：每个 `*-view.js` 的顶层状态必须全部在表里且 owner 指向自己，未登记前缀的新视图直接红（`VIEW_STATE_PREFIXES`）；变异：`previewData` owner 改回 app.js / 删掉该条目 / 造未登记前缀的 `probe-view.js`，三条各自红在目标断言 | DevLead | e4a02ab |
| 2026-10-29 | index 视图收尾 | 删：无；补：OWNERS 增加 index 的 24 条（列 0 声明核过，含 `INDEX_*` 与`IMAGE_QUALITY_LABELS`——后者标注"暂驻，到期点 = 建 core/display-prefs 时改 owner"）与 reading 的 8 个模块级常量，总数 94 → 126；`VIEW_STATE_PREFIXES` 加 index 一行；防漏检扫描口径从"任意缩进"收紧到**只看列 0**（index 里有 `let index` 这类局部量，按任意缩进会假红）；R6 登记 3 个 index 埋点（`MAX 9→12`）；5 个集成用例改合查，三处开关断言拆成"模块调注入 + app setter 写状态"两半；README 记 `exit()` 零调用点待办；变异：owner 改回 app.js / 删表项 / 加未登记埋点 / 删已登记埋点 / 模块函数改名，逐条红在目标断言 | DevLead | fba5c21 |

只有 DevLead 能加行。没有登记行的放宽一律按违规算。

---

## 19. 待办（必须带触发条件，不许"下次顺手"）

| # | 事项 | 触发条件 | 状态 |
|---|---|---|---|
| T1 | `boundary.test.mjs` 里 4 条 R3 豁免的 `expires` 从「正文流① 搬完」改为「**punct 整体搬完**」（`reading-garbled-count`/`reading-garbled-open`/`reading-punct-count`/`reading-punct-open`） | **下一笔碰 `boundary.test.mjs` 的提交必须带上这 4 个字符串**；若该提交没改，单独开一笔（30 秒） | 未做 |
| T2 | R2（视图互引）上闸 | 第二个视图模块（`pages-view.js` 或 `index-view.js`）创建时 | 未做 |
| T3 | R6（一模块一 window 接口对象）上闸 | 同上 | 未做 |

**为什么写进表而不是记在脑子里**：T1 的错法很具体——正文流① 排在前，做完会有人按表检查这 4 条该不该到期、发现不该，然后记一句"待 punct"就沉了；下次再看表，写的还是「正文流①」。**到期点写错 = 这条豁免永远不会被主动清理**，和"例外表挂着已删代码"是同一种松，只是松在文字上。

---

## 20. 其它视图的模块契约（2026-10-29，拆 `preview/index/review/pages/merge/library` 之前定）

### 20.1 公开接口：必选 3 + 按需 1

| 方法 | 要求 | 判据 |
|---|---|---|
| `init(deps)` | **必选** | `boot()` 调一次；`deps` 见 20.4 |
| `enter()` | **必选** | `showView(name)` 进这个视图时调 |
| `exit()` | **必选** | 离开时调（断 observer/timer，置 `active=false`） |
| `getCurrent()` | **按需** | **只有外壳真有调用点时才加**（目前只有 reading：`savePosition` 要页码） |
| 业务方法（如 `reload`/`toggleFollow`） | **允许，逐个签字** | 每加一个过 R8：棘轮只降不升、写明调用点、Architect 签字 |

**不许这样加**：为了"将来可能用"预留方法。`on`/`emit` 已经被删过一次，理由相同——没有订阅者的事件缝不是缝。

### 20.2 R6 现在可以机检（8/9）

**判定式**：扫每个 `static/*-view.js`，找 `window\.[A-Za-z_$][\w$]*\s*=` 的赋值，断言**恰好 1 个**，且名字 = 文件名转驼峰（`preview-view.js` → `PreviewView`）。
违反 = 红。实现成本约 10 行，可直接上闸。

### 20.3 R2 判定式（等第二个模块出现即可上闸）

**判定式**：`static/x-view.js` 内不得出现 `window.YView`（Y≠X）的**任何**引用（含 `window.PagesView.xxx()`、`ReadingView.on(...)`）。
- 需要跨视图能力 → 走 `deps` 注入，不走模块之间的直接引用；
- 别人 `<section>` 里的 id 也不许碰（R3 已覆盖）。
反例：`preview-view.js` 里写 `window.ReadingView.reload()` → 红。

### 20.4 共享物：不建 core 文件，用一个 deps 字面量

**结论：不新建共享文件**（同意 DevLead：那会变成第 8 个上帝对象）。做法：

```js
// boot() 里构造一次，按引用传给每个 init()
const deps = {
  api: apiJson,            // HTTP + token + 错误归一
  navigate: (name) => showView(name),
  notify: (text, opts) => showNoticeBar(text, opts),
  getProject: () => currentProject,
  savePosition,            // (view, pageNo) => void
  openPageDetail,          // (pageNo) => void
  storage: window.localStorage,
};
```

规则：
- **`el` 不进 deps**：每个模块自带 `const el = (id) => document.getElementById(id)`（reading 已经这么做）；
- 模块只取自己用到的键，**不许把 `getProject()` 的返回值缓存到模块级变量**（R10）；
- deps 的键是**稳定契约**，加键不经过棘轮（它不在 `window` 上），但要在本表登记；
- 任何模块都不许直接读 `currentView`（自己记 `active`）。

### 20.5 拆的顺序

**同意** `preview`(41) → `index`(48) → `review`(221) → `pages`(270) → `merge`(663)，两条附加条件：

1. **拆 `pages` 之前先定页面瓷砖服务**。`review` 和 `pages` 都用页面图/瓷砖渲染（`pageImageUrl`/`pageProfileFor`/`paintTile*`），不先定就会拆出两份实现——正是我们要收的"正文流两个口径"。放在 `review` 和 `pages` 之间做，不要拖到 `merge` 之后。
2. **拆 `merge` 之前先确认它的 DOM 段能不能按子面板切**（337 个 id / 1,008 行 HTML 是最大单块）。切不开就整块搬，但要在文档里写明"merge 是单块，不可再分"。

**每个新模块的验收 = 现有四基线 + R1/R2/R3/R5/R6/R9 全绿 + 导出 keys 不增。**

### 20.6 已签字的出生接口（按模块分别建棘轮）

**R8 的棘轮按模块建**：每个模块出生时由 Architect 签字确定初始接口，此后**只降不升**。
出生接口的判据：**每个方法都必须有真实调用点**（今天就有，不许为将来预留）。

| 模块 | 出生接口 | 签字 | 依据 |
|---|---|---|---|
| `ReadingView` | `init/enter/exit/getCurrent/toggleFollow/reload`（6） | 已在册 | 6 个都有调用点 |
| `IndexView` | `init/enter/exit/refresh`（4） | **2026-10-29 批准** | 见下 |

**`IndexView.refresh()` 批准**，三条理由（DevLead 举证，我复核过）：

1. 原来 4 处 `if (currentView === "index") paintIndexDecorations();`（`app.js:636/645/5185/5405`）**是外壳替模块读 `currentView`**，直接违反 §20「模块自己记 `active`」。`refresh()` 一进模块，守卫跟着回家。
2. `syncIndexToggles`(5 行) / `paintIndexDecorations`(8 行) 都是**纯写自己子树 DOM** 的镜子函数，不往外捐能力。
3. 替代方案（不加导出、删掉 4 处戳）要改行为，且 index 隐藏期间按钮 class 可能陈旧——不拿新造的 UI 陈旧隐患换一个导出数字。

**`refresh()` 的正确形态（修正 DevLead 提案）**：`paintIndexDecorations()` **本身已经有守卫**（`if (!currentProject || currentView !== "index" || !indexTiles.size) return;`），且**结尾已经调 `syncIndexToggles()`**。所以：

```js
function refresh() {
  syncIndexToggles();       // 无条件，对应原 5185/5405 的显式调用
  paintIndexDecorations();  // 自己守 active（把 currentView 改成模块的 active）
}
```

不需要 `active ? ... : skip` 的 ternary——守卫留在 `paintIndexDecorations` 里，写一次就够。

**认可的偏差（记录在案）**：`syncStepToggles` 那 2 处（636/645）原来只在 index 可见时画；走 `refresh()` 后，**index 隐藏时也会多一次 `syncIndexToggles()`**（写 4 个按钮的 class，幂等、不可观察）。接受，**不为它发明 `refresh({toggles:false})` 参数包**——参数化入口是把简单接口做成配置项的典型开头。

**一条否决**：DevLead 表格第 5 行（preview 的 `init deps` 注入 `syncIndexToggles`）**不是 `refresh()` 的调用点**，也不许改成 preview 调 `window.IndexView.refresh()`——那是 R2 违规（模块互引）。它保持"外壳在 boot 里注入一个 lambda"的形态，由外壳决定是否顺带 `IndexView.refresh()`。

