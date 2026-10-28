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
| **R4** | 共享状态（`currentProject` / `token` / `exportOptions`）只以 **getter** 注入（`getProject: () => …`），模块不许把返回值缓存在模块级变量里；每次用都重新取 | 人眼 + 代码评审（`init` 后不许出现 `injected.project = ` 这类赋值） |
| **R5** | 每个状态只有一个 owner 模块；其他模块只能通过 owner 的公开方法改。**同层双写一律算错** | 本文件的 §3 表就是 owner 清单；跨文件写同一名字 = 违规 |
| **R6** | 一个模块文件只向 `window` 挂**一个**接口对象，且必须在 `init()` 之后才可被调用 | 扫 `window.X =` 赋值次数 |
| **R7** | 禁止 `<script type="module">`（D-046 无构建 + ES module 默认 deferred 会改 boot 时序） | 扫 `index.html` |

**依赖方向一句话**：`views → core → 平台`；外壳只能通过接口对象调视图；视图永远不许知道外壳和别的视图。

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
- `app.js:17791` —— `refreshPunctGroups()` 用 `if (readingData) renderReadingProgress()` 判断"正文流在不在"。
- 改法：reading 发 `'content-changed'` 事件，punct 不读状态。

**结论**：草案说"边界基本干净、只有 2 处越界"不成立。**真正的问题是 DOM 归属被三个模块瓜分 + 标点模块反向写审校状态**，这两条不修，Slice 2 搬正文流时会把它们一起搬歪。

---

## 5. 对外接口（按证据裁到 6 个 + 事件）

```js
window.ReadingView = {
  init(deps),            // 由 boot() 调一次
  enter(projectId),      // showView("reading") / enterReviewStep 都走这里
  exit(),                // 置 active=false，断 observer/timer（现在没有任何清理，切走即在跑）
  getCurrent(),          // → { projectId, pageNo }：savePosition 用，必须同步、便宜
  reload(),              // 标点 / 乱码批次裁决后"整条流重开"
  toggleFollow(),        // 9347 chip
  on(event, fn),         // 'content-changed' | 'error'；返回退订函数
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

**`getCurrent()` 只给两个字段**，别加 `done/total/draftCount`：那是"顶部数字"，由 `on('content-changed')` 推给外壳渲染，不需要外壳来拉。外壳拉一次状态，就会有第二个写点。

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

## 6. Slice 1 验收口径（Chief 22:5x 更正后）

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
