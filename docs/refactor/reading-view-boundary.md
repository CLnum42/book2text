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
| 共享输入 11 个 | **28 个**顶层符号被块内引用；`token` 引用 0 次（草案误记），`el()` 99 次（草案 105） | §2.1 |
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
| **R8 的迁移期细则（2026-10-29 裁定，以此为准）**：R8 的原意是"不许**永久**膨胀"，不是"迁到一半也不许长"。
迁移期用**终点 + 逐刀单调下降**取代一句"只降不升"：

- 每刀的登记值 = **模块真实导出键集合**（由 `<module>.js` 的 api 字面量读出，不猜、不自报）；
- 终点 = **3**（`enter` / `render` / `refresh`），写在同一条登记项里，注释写明"刀5 收敛到此"；
- **刀2–5 每刀落盘后，导出数必须严格小于前一刀；不降 = 红**；
- **不许嵌套藏键**：`api = { init, enter, ops: {...} }` 让 `Object.keys` 数出 3 个，是
  被驳回的 `call(name, args)` 分发口的同义写法。**导出面必须扁平，一个一个列出来。**
- 每刀报告加**第六个数：本刀导出数**，从模块字面量读。

**R8** | **重构不许新增导出**（Chief，2026-10-28）。需要新增一个导出才能搬动一块代码 = 这一刀边界切错，改边界别加接口 | 导出棘轮：`Object.keys(window.ReadingView)` ≤11 且只降不升 |
| **R9** | **被引用但没声明的标识符一律红**（no-undef）。`readingTreeOpen` 就是这条抓出来的：HEAD 上 7 次引用、0 次声明，渲染左树直接 `ReferenceError` | `boundary.test.mjs`（`4a6f675` 上闸） |
| **R11** | **已切掉的边不许回长**（闸 B）：§18.3 的 13 条边（4 桥 + 9 回调）调用点必须为 0，且只降不升（对照 `ring-break-base` 现算） | `boundary.test.mjs`（2026-10-29 上闸，规格 §18.3） |
| **R12** | **特征测试契约**（闸 A）：产品提交不许碰 `tests/js`；序列删除行 = 0；改旧断言必须单开 `test-contract:` 提交并在 §18.6 登记 | `boundary.test.mjs`（2026-10-29 上闸，规格 §18.2） |
| **R13** | **注入表来源可证**（待上闸）：生成器产出的每个注入键，其表达式里的自由标识符必须属于 `app.js` 顶层声明 / 该工厂作用域声明 / globals 白名单 | 生成器注入表（当前 45 键）静态解析；`getProject: () => project` 必红。规格见本节下文 |

**依赖方向一句话**：`views → core → 平台`；外壳只能通过接口对象调视图；视图永远不许知道外壳和别的视图。

**例外表纪律（R4-dup 的 AC 例外名额）**：例外表里每条都要带 `owner` 与到期切片；**死代码一旦删除，对应例外必须同批删掉，否则例外表本身失信**。当前状态：`rerenderReadingLine` 之外的两对同名函数已批删（单独提交，不计入任何层），删完 AC 例外应从 3 条缩到 1 条，到期点仍是"正文流① 搬完"。

**R10（评审清单，不上闸）**：共享状态（`currentProject` / `token` / `exportOptions`）只以 getter 注入，不许缓存在模块级变量里。
原编号是 R4，**与"真实现份数"撞号，已让位**。降级理由：判定"有没有把 getter 缓存下来"要数据流分析，正则做不到，硬写成测试只会自欺。这条靠评审，不靠闸。

**R13 上闸规格（Chief 2026-10-29 定；TestDev 实现，merge 切片落盘前必须通过）**
- **对象**：只查**生成器产出的注入表**（`window.LibraryView.init(deps)` 那个对象，当前 45 键），不扫全仓库——输入有限、可枚举，误报空间小。
- **判据**：每个注入键的表达式里出现的**自由标识符**，必须属于三类之一：① `app.js` 顶层声明；② 该工厂作用域内声明（函数参数 / 局部 `const`·`let`）；③ globals 白名单（`window`/`document`/`console`/`localStorage`/`performance`/`setTimeout`/`requestAnimationFrame` 等，白名单写死在测试里、只减不增）。不在三类里 = 红。
- **必红样例**：`getProject: () => project`（`app.js` 没有顶层 `project`，它只在别的函数里出现过）→ 红。**变异证明**：喂这条必红；改成 `getProject: () => currentProject` 必绿。
- **为什么不扩成完整 no-undef**：`known-limitations.md:1553` 已写明 R9 只把成员访问/调用/赋值目标算引用，裸引用一律不算；要收裸引用得处理 globals、解构默认值、模板插值，误报会让整条闸失去可信度。
- **回合**：merge 切片落盘前必须通过；它验的是**生成器**，不验手写代码。

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

> **行号基准 = `main@5d7e0ef`**（与文首同一棵树，`app.js` 21,096 行）。§11 的 L1 施工表另有基准 `c45b8a5`（那份是切范围用的树），**两处不能混用**；施工一律按名字定位。

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

⑯ **账本只增不删、只标不改**；改历史会让账本失去可追溯性。
   出处：2026-10-29 `ecdcc36` 的假 BYPASS——追加更正行（MARK 被并发覆盖、tree 实为一致），**不改原记录**。
   **任何"先写标记、后读标记"的配对在共享工作区里必须加锁**（`pre-commit` 写、`post-commit` 读，
   并发时后写覆盖先写，误判方向是"把通过记成绕过"，比漏判更难发现）。


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

**L1 的注入依赖 = 24 个**（临时 21 + 永久 3）。**逐条名单以 §13.4 为准**，这里不重复（重复会漂）：
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

- 函数清单见 §11 表；`setReviewOverlaysForReading`（18 行） 留 app.js，不计入。

**L2（估算 342 行 / 11 函数）→ 累计估算 554，app.js ≈ 20,511，临时注入 30**

- `markReadingUserMoved`
- `startInlineEdit`
- `setReadingFilter`
- `setReadingHoverByBlock`
- `onReadingPdfScroll`
- `setReadingFollow`
- `renderReadingPreflight`
- `onReadingScroll`
- `stepReadingPage`
- `submitReadingDrafts`
- `undoReadingSubmit`

**L3（估算 213 行 / 7 函数）→ 累计估算 767，app.js ≈ 20,298，临时注入 35**

- `readingMovedSinceOpen`
- `openReading`
- `readingLineBox`
- `markEditingLineBox`
- `exitInlineEdit`
- `onInlineKeydown`
- `drawEditingLineBox`

**L4（估算 139 行 / 7 函数）→ 累计估算 906，app.js ≈ 20,159，临时注入 33**

- `loadReadingInlineEdits`
- `restoreInlineEditsPrompt`
- `loadReadingDrafts`
- `onInlineInput`
- `measureReadingTops`
- `gotoNextUnreviewed`
- `applyReadingSplit`

**L5（估算 1,041 行 / 32 函数）→ 累计估算 1,947，app.js ≈ 19,118，临时注入 36**

- `readingOptions`
- `applyReadingMarksPayload`
- `rebuildReadingEntries`
- `readingWindowHas`
- `ensureReadingMarksWindow`
- `loadReadingMarksWindow`
- `refreshReadingMarksPaint`
- `ensureReadingLineRendered`
- `renderReading`
- `buildReadingSentinel`
- `saveInlineEdit`
- `centerReadingLinePair`
- `openReadingPanel`
- `renderReadingTree`
- `scrollReadingToPage`
- `markReadingTreeCurrent`
- `jumpReadingTo`
- `ensureReadingPages`
- `buildReadingPages`
- `observeReadingTiles`
- `refreshReadingImageProfiles`
- `observeReadingColumnResize`
- `ensureReadingTile`
- `retryReadingPendingPanel`
- `ensureReadingBlocks`
- `setReadingHover`
- `markReadingCurrentTile`
- `updateReadingPageFromLeftScroll`
- `scrollStreamToPage`
- `verifyReadingPageSync`
- `updateReadingPage`
- `gotoReadingEntry`

**L6（估算 428 行 / 24 函数）→ 累计估算 2,375，app.js ≈ 18,690，临时注入 20**

- `saveReadingInlineEdits`
- `readingFlowPages`
- `readingEntryDone`
- `removeReadingSentinel`
- `buildReadingSegment`
- `scrollScrollerToCenter`
- `suppressReadingFollow`
- `hideReadingPanelHost`
- `startReadingEdit`
- `buildReadingTreePreview`
- `readingEntriesForPage`
- `disconnectReadingObservers`
- `warmSwapReadingImage`
- `ensureReadingImage`
- `pumpReadingImages`
- `releaseReadingImage`
- `markReadingImageFailed`
- `clearReadingDecorations`
- `scrollPdfColumnToPage`
- `markReadingDriver`
- `readingDriverActive`
- `hideReadingPdfBox`
- `drawReadingPdfBox`
- `logReadingNext`

**L7（估算 95 行 / 8 函数）→ 累计估算 2,470，app.js ≈ 18,595，临时注入 15**

- `readingInlineStorageKey`
- `readingMarkOrder`
- `checkReadingSegmentText`
- `span_at`
- `draftReading`
- `readingEntryLineText`
- `showReadingPlaceholder`
- `paintReadingTile`

**L8（估算 112 行 / 7 函数）→ 累计估算 2,582，app.js ≈ 18,483，临时注入 10**

- `saveReadingDrafts`
- `textCheckEnabled`
- `renderReadingProgress`
- `closeReadingPanel`
- `rerenderReadingLine`
- `readingPageRecord`
- `applyReadingLinked`

**L9（估算 163 行 / 5 函数）→ 累计估算 2,745，app.js ≈ 18,320，临时注入 8**

- `readingDraftStorageKey`
- `buildReadingLine`
- `readingProgressNumbers`
- `refreshReadingCurrentHighlight`
- `readingHoveredBlockIds`

**L10（估算 166 行 / 6 函数）→ 累计估算 2,911，app.js ≈ 18,154，临时注入 3**

- `readingVisibleSegments`
- `expandToWordRange`
- `readingLineText`
- `paintInlineRevision`
- `readingLineNode`
- `paintReadingDiffBoxes`

**L11（估算 62 行 / 2 函数）→ 累计估算 2,973，app.js ≈ 18,092，临时注入 1**

- `readingEntryVisible`
- `readingDiffUnits`

**L12（估算 4 行 / 1 函数）→ 累计估算 2,977，app.js ≈ 18,088，临时注入 0**

- `readingKey`

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
- **队列上限 = 6，不是 32**。原 §18.1 / §18.4 C4 里的"上限 32"**已作废**（C4 的 6 是结构上限、不是数值上限），本节按 **≤6**；C4 的"丢弃计数"改读 `readingIntentStats.dropped`（`!active`/`exit`/换项目清空时累加），`coalesced`（同 kind 覆盖次数）只作发现、不算失败——高频覆盖是正常重绘，不是 bug。
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

### 13.2b 机检覆盖数（架构健康指标之一）

**定义**：`(已上闸的规则数) / (应当上闸的规则总数)`。统计对象 = 文档 §2 的规则表。

规则清单（**R4 与 R4b 算同一判据的两种形态，计 1 条**）：
R1 依赖方向 / R2 视图互引 / R3 DOM 归属 / R4 真实现份数（含同文件重名）/ R5 一状态一 owner / R6 一模块一接口对象 / R7 禁 `type=module` / R8 不许新增导出 / R9 no-undef = **9 条**。
`R10`（注入不缓存）是评审清单，**不计入分母**。

**现状 12/12**（分母 = **12 条可机检规则**：R1、R2、R3、R4(含 R4b)、R5、R6、R7、R8、R9、R11、R12、R13；**R10 按设计不上闸，不计入分母**）：12 条全部上闸（R13 于 `511df76` 上闸，变异证明见 §18.6 同一行）。

> **2026-10-29 第二次修正**：上一版写「11/12（分母 = R1–R12 共 12 条）」——同一句里又说「R10 不计入分母」，自相矛盾（12 把 R10 算进去了），且漏记 R13。**分母一律按组成列名，不按区间写 `R1–R12`**：区间会把不上闸的 R10 自动吞进去，"分母跟着规则表长"就成空话。这是分母第三次改（7→8→9→11→12），每次的组成都记在这一节。
>
> **规则表是唯一权威**：R11/R12 曾在 §13.2b 和 README 被引用、§2 表里却没有——登记不是"某处提到"，是"规则表里有一行"。这次补进 §2 表，三处同批改。

> 分母曾经从 8 变到 9，是 R9 加进来造成的；**报这个数必须同时报"分母由哪些规则组成"**，否则又会飘。TestDev 报过 7/8，是分母没跟着加 R9。

### 13.2c 一笔提交的三个行数（搬走 / 净减 / 骨架）

**每搬一层，必须报三个数，不许合并**：
1. **搬走行数**（函数体行，按名字可数）；
2. **净减行数**（`app.js` 前后差）；
3. **骨架增量**（模块侧新增的 IIFE/注入 lambdas/注释）。
三者关系近似 `净减 = 搬走 − 骨架`，但不必相等——差额要能解释。L1 的实例：搬走 160、净减 130、骨架 +30。
另：**死代码删除单独记账，不进任何一层**（`09e6af3` 的 52 行属于删除账，不属于 L1 的搬走账）。

### 13.2d 派生化边界：能算的是"现状"，要写的是"意图"

| 能派生（有唯一答案） | 必须手写（没有唯一答案） |
|---|---|
| 环在哪些边上（SCC） | 该切哪条边 |
| 有几个导出（`Object.keys`） | 某个导出的职责是什么 |
| 注入依赖几个（引用图） | 哪个字段算 `nonrender` |
| 例外还剩几条（源码反查） | 哪条例外该保留 |

**这条边界对所有"派生化"都成立。** 尤其**不许把 `CUT_EDGES` 自动化**——那是把判断换成计算，会得到一个"算法认为该切"的东西，而不是"我们决定切"的东西。

**每派生一样东西，必须配一条"派生结果 vs 手工表不符即红"的对账**，否则只是把"手工表漂"换成"派生脚本悄悄坏了"。

### 13.2e 派生化三层（方法论，2026-10-29 定稿）

```
① 怎么分：能派生的是"现状"（有唯一答案），要写的是"意图"（没有唯一答案）
② 怎么收：派生之后，手工副本只是过渡态，该退休——两个真源必然漂
③ 别越界：意图永远不能派生，别让算法替人决定
```

**①的分法**见 §13.2d 的表。**③的后果**：`CUT_EDGES`、`nonrender` 字段、导出的职责，**永远手写、永远只有一份，且永远不许自动生成**。

**②的落地（最容易忘）**：过渡期允许"派生 + 手工表 + 对账"三者并存，但**终态是删掉手工表**。
**判据**：**对账连续全绿，且手工表再没被单独改过 → 就该删表。**
留着就是债——`VIEW_EXPORTS` 手写那次（`MergeView` 3→2 只改了一处）已经证明过：**"下一次有人改手工表"只是时间问题。**

| 类别 | 终态 |
|---|---|
| **派生出来的（现状）** | 手工副本**退休**，只留派生一处 |
| **手写的（意图）** | **永远只有一份**，且永远不许自动生成 |

**两类东西的终态相反**。混起来就会出现"自动生成的意图"或"手写的现状"。

### 13.3 两个数分开报（临时 / 永久）

> 原编号与「报数必须带对象」撞号；那一节现为 **§13.4**。

- **临时注入**（会被内化）：上表。**L4 结束时是 33，不是 0**；到 L12 才归零。
- **永久依赖**（永远内化不了，属 core/服务层）。**到 L4 结束实测 = 14 个，不是 5 个**：`apiJson`、`currentProject`、`loadFinishSummary`、`openPageDetail`、`pagesMarginOn`、`pagesOverlayOn`、`project_id`、`refreshGarbledLines`、`refreshPunctGroups`、`renderPunctGroupBadge`、`savePageMarginPreference`、`savePageOverlayPreference`、`showNoticeBar`、`showView`。
  （`el`、`currentView` 不算：模块自带 `el`、`currentView` 改本地 `active`。Chief 批的"永久 5"只是其中的"块外服务"子集——`apiJson`/`exportOptions`/`currentProject`/`localStorage`/`performance.now`；L4 的真集合还要加上路由 2 个、标点 3 个、页面视图状态与偏好 4 个。）
  **`refreshPunctGroups` / `renderPunctGroupBadge` 不算临时债**——它们是跨模块（标点），必须走已存在的 `onPunctGroups` 注入，不许由 `openReading` 直接调。

---

### 13.4 报数必须带对象（Chief 2026-10-28）

**「调用点数」和「写点数」是两个对象（2026-10-29 实证）**：`notify` 的**调用点**数出 5 个函数，而**写点**是 10 处（同一函数里可能出现多处）。**搬运验收要数写点**——R3 判的是"app.js 里还有没有直接写该视图 DOM 的语句"，漏一处就红。

由此得到一条更硬的判据：**「要留」不等于「可以继续写该视图的 DOM」**。外壳函数搬不走（`loadLibrary` 8 个调用点、一半在模块外），但它写本视图 DOM 的那些语句**必须同笔改成注入接口**（`LibraryView.notify`）。实测账：`view-library` 6 个残留 id / 24 处引用 = 外壳侧 10 处 + 搬走函数 8 处 → **19 → 0 之后，6 个 id 才真归零**。

**写进规矩不够，得写进每个数旁边**（2026-10-29 假警报的教训）：连刚写完这条规矩的人，看到"30/636"和"17/371"并列，第一反应仍是"对不上"。**规则写在总则里＝没人看；对象写在数字旁边＝跑不掉。** 以后每个数字就地标注（`(闭包)` / `(能搬栏)` / `(临时注入)`），不要在文末统一解释。

**暂不上闸**（2026-10-29 定）：「文档里的数字没有括号标注就红」这类正则检查**先不做**——它容易退化成形式主义（为了过检查去标 `(数字)`）。**等它真漏一次再上**，和 D-110 的"兜底要等真的漏过才加，否则是负担"同一条。

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
8. **本地未推提交上限 3 笔；到 4 必须推。** 未推的提交不构成"已交付"，也不进任何人的基线。
9. **改文档用"首尾切片"之前，先 `grep -c` 起点与终点关键词，两处都必须 = 1；不等于 1 就停。** 切片替换是**盲改**——它不看你切的是什么，只管切。**"量错对象"在文本编辑上的同构版本就是"切错位置"**：今晚文档被整份复制成两遍（3,147 行），就是切片切在被拼接过的文本上。
10. **跨人改章节：改前确认对方无未提交改动，改后要回执。** 只是"已告知"不算——对方若有本地旧版本未推，下一次提交会把你的覆盖顶回去，**而且没有冲突提示，只有"改动不见了"**。
11. **契约落定必须含两层**：①**要什么**（能力/边界/接口）；②**在真实 DOM/运行时里会发生什么**（生命周期、异常与可观察性、已知成本、兜底路径）。只写①的契约会在落盘时被迫补②，而那时补的人不是定契约的人。
12. **提交署名（2026-10-28，破环前已发生）**：`84c26f8` / `ae71e48` 两笔的提交信息没有列出 Architect 的四处改动（§12.1.1 / §12.4 / §3 S10），是别人 `git commit -a` 卷进来的。内容已核对无误，**不回退、不改写已推历史**，追溯靠本节这一行。**破环期间禁用 `git commit -a`，只 `git add <具体路径>`**——破环的提交序列要能单独回退、单独署名。


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
| **A5** | **特征测试只锁行为**：不许断言调用次数 / 调用顺序 / 注入面调用。判定：扫 `tests/js/*.test.mjs` 每条 `assert`（先去注释与字符串），命中 ① 计数名 `calls/callCount/callsMade/invokedCount/invocations/timesCalled/hitCount` ② 顺序名 `order/seq/sequence/trace/callLog/callOrder/callStack` ③ `mock/spy/stub/fake` 命名 → 红。C1–C4 探针单独成文件、文件名含 `probe` 且登记在 `A5_PROBE_FILES`（带 owner + 到期点），未登记即红；例外表 `A5_EXCUSES` 现状 0、上限 0，按「文件+语句指纹」定位，**违规消失也红**。附则：`tests/js/*.test.mjs` 必须在 `run.mjs` 注册，没注册 = 红（写了不跑比写错更坏） | 违反即红；已用临时文件 `assert.equal(calls,1)` 先红后绿验过 |

**为什么要有 A2**：只查「不许改测试」挡不住「新写一条只对切后成立的测试」——结局和改断言一样。回放把「它锁的是旧行为」变成可机检的事。
**A3 拆两段（Chief 2026-10-29 定；TestDev 实现，作为 R12 的一部分在 merge 落盘前完成）**
- **pre-commit 段（阻断提交）**：只判**形态**——一笔提交改了 `tests/js/**`（`.md` 除外）且删除行 > 0，首行不是 `test-contract:` 且不是 `move:` → 红。单人可判，不查登记。
- **登记段（不阻断，但要看得见）**：`test-contract:` / `move:` 提交是否在 §18.6 登记（sha + 删/补/变异三样）→ 进 CI 与 `scripts/status.sh` 的**可见红灯**。**不放 pre-commit**：登记只有 DevLead 能做，放进去会让每次契约变更都要两人接力；接不上就有人 `--no-verify`，而绕过记录比漏检更难查（`511df76` 就是实例：闸红着，下一个人提交只能绕过）。
- **验收（两段各喂一次红）**：形态段——非 `test-contract:` 删一行 `*.test.mjs` → pre-commit 红；登记段——`test-contract:` 提交未登记 → `status.sh`/CI 红，但 `git commit` 放行。

**为什么要有 A4**：A2 只证明「测试在旧树上绿」，挡不住「测试根本没走那条边」——绿可能锁的是外壳按钮。
**A4 为什么打在 callee 上**（Chief）：打 `caller` 首行只能证明「测试跑到了这个函数」——任何顺带调用 `renderReading` 的断言都会失败，证明不了它依赖的是**这条边的效果**。所以变异插在基线树上**被调用那一端**；`callee` 被多个调用方共用、隔离不到这条边，才退回 `caller`，并在提交说明里写明理由。
**9 条边的预期阶梯**（HEAD `d90aa45` 的树，按名字数，行号会漂）：**T1 只有 1 条**——`renderReadingTree→scrollReadingToPage`（`scrollReadingToPage` 全仓库 1 个调用点）；其余 8 条 callee 都共用（`ensureReadingMarksWindow` 4 个调用点 / `updateReadingPage` 10 个 / `retryReadingPendingPanel` 2 个 / `ensureReadingBlocks` 2 个 / `jumpReadingTo` 3 个），走 T2。**共用不等于判不了**：T2 中和的是那一次调用，不是整个 callee。**边 8、边 9 共用 caller `gotoReadingEntry`，T3 对两者是同一个变异、区分不了，这两条必须 T2。** 9 个调用点全是独立语句，`void 0` 语法都合法。
**A5 为什么在闸 A、不占 R 编号**（DevLead，2026-10-29，同日更正）：A5 约束的是**测试证据**，和 A1–A4 同一族，是**闸 A 的第五条断言**——编号随闸 A（R12）走，不另领 R 号；R11/R12 的号当天已被闸 B / 闸 A 领走，新落的生成器检查是 R13。我最初的判据「R11 还空着」写这一节时成立、当天作废，保留在前一版记录里便于对照。**若要把 A5 单列成 R 号**：分母 12→13、§2 / §13.2b / README 三处同批改，由我落。
**A5 的已知盲区**（TestDev 报）：只认语句级文本；先存变量、隔几行再断言的拼装形态抓不到——那种形态靠 A4 的变异红兜底。

**A4 的对象固定死在 base 树上**（Architect）：切完队列后 9 条边的效果都挪到帧末 flush，在切后代码上插 `throw` 也会红，但那时红的是「队列还在跑」，证明不了同一条边。所以只认 base 树上的红。
**只锁用户可感知的结果**（面板开了、页码对上、树高亮）：新增测试里**不许断言调用次数、调用顺序、注入面调用**（C1–C4 探针除外）。锁了顺序的测试切完队列必红，会被误判成「切错了」；而顺手在切边提交里改测试会立刻撞 A1（删除行 0），只能走 A3 单开提交。这条由 TestDev 做成静态检查，与八道闸并列领 R 编号。

**权限**：只有 DevLead 能登记 A3 并移动 `ring-break-base`；Builder 不可。A4 的插 `throw` 小脚本归 TestDev（插一行、跑一条、2 秒级）。

**基点的现状（2026-10-29，Chief 核出）**：`ring-break-base` = `afe20fe`，打在 **L0** 上——`git show ring-break-base:backend/book2text/static/app.js | wc -l` = 20,275（HEAD 15,870），`ls-tree` 的 `static/` 下只有 `reading-view.js` 一个模块。**它不是回放基，A2 / A4 现在暂停使用**：在它上面跑新测试，红的原因是「`init` 注入不存在、模块没拆」，会把「测试锁错对象」和「实现错了」混成同一个红。
**真 base 判据（2026-10-29 更新）**：`ring-break-base` 已切到 **merge 落盘后的检查点**（`static/` 下 5 个 `*-view.js`：index / library / merge / preview / reading）。打 tag 同批三件已全部落地：删 `--allow-transitional-base`、更新 `tests/js/replay-base-modules.txt`、§18.3 的 13 条证据。**

**这是检查点，不是终态**：`pages` 落盘后要**再切一次**（那时 6 个模块）。不写这句，下一次切 tag 会被当成"重复劳动"而拖到明年。

#### 18.2.1 `move:` 笔类（迁移笔的例外，2026-10-29 Chief 定；TestDev 实现须与本段一字不差）

**为什么要有它**：A1 / A1b 与 R5 / R8 会互相锁死——产品笔让 R5 红（状态换了 owner），测试笔先提又让 `VIEW_EXPORTS` 红（登记了但文件不存在）。**两笔没有一笔是绿的。** 解法不是"绕过"，是给迁移笔一个**带期效的例外**：

- 首行 `move(<视图>): …`；该笔可同时含 `backend/book2text/static/` 与 `tests/js`；
- `tests/js` 变更行**只许落在** `OWNERS` / `VIEW_STATE_PREFIXES` / `VIEW_EXPORTS` 三块内，**块边界从源码派生，不许写行号**（行号是会漂的手工副本，且任何插入都会让它失效）；
- `EXCUS` / `MAX` 类常数**一律不放行**——那是削弱闸的旋钮，和"登记一个模块叫什么"是两回事；
- 登记 §18.6 三样不变，且**"变异"栏口径固定**：把这笔的 `tests/js` 改动整体撤回 → 红必须出现且**点名本笔搬入的模块文件**；撤回后全绿 = 多余登记行 = 红；
- **§18.6 登记行允许写在同一笔 `move:` 提交里**（它是文档行，A1 只拦 `tests/js`，不拦文档）。**这条是 2026-10-29 补的**：要求"登记在另一笔"会让每一笔 `move:` 都产生一个**欠账窗口**，而欠账会堵住所有人（当天堵了 4 笔推送）。
- **但"不能自己批自己"必须还在**：登记行的「批准人」**等于该笔提交的作者**→ 红（`git log -1 --format=%an <sha>` 对比登记行批准人字段）。**同批是为了消掉欠账窗口，不是为了让人自己签自己。**
- **期效**：§20.9 ⑪（导出面从代码生成）落地当笔，`grep -c "move:" tests/js/feature-contract.mjs` 必须归零，否则 ⑪ 不算完成。**过渡态不许活成终态。**

**它不是第二套闸**：逐笔断言（A1）、删除行合计 0（A1b）、回放（A2）、变异红（A4）全部不变，变的只是"`tests/js` 里允许出现哪几行"。**允许出现的只有登记，没有断言。**


### 18.3 闸 B：静态边棘轮（13 条）

对象 = 被测 SHA 的源码树，纯文本扫描，不加载、不跑 DOM。

| 组 | 条数 | 判定式（全仓库计数） |
|---|---|---|
| 桥 | 4 | `showView(` 出现 = 0：模块文件内 + 这 4 个函数体内各自 `showView(` = 0 |
| 回调边 | 9 | 每条：`caller` 函数体内 `callee` 出现 = 0 |

**桥（4）**：`setupReading`、`openPageDetail`、`renderMergeView`、`submitMergeDecisions` —— 改走注入的 `navigate()`。
**现状（2026-10-29，`cef331b` 之后）**：4 条里 3 条已 0——`setupReading` 随 L1 模块化归零、`renderMergeView` / `submitMergeDecisions` 随 merge 搬迁切到 `navigate()`（`edge-budget` 同笔记 0，桥例外上限 3→1）；只剩 `openPageDetail` 1 处（例外，到期点 = pages 搬进模块）。
**回调边（9）**：`renderReading→ensureReadingMarksWindow`、`renderReading→retryReadingPendingPanel`、`renderReadingTree→ensureReadingMarksWindow`、`renderReadingTree→scrollReadingToPage`、`openReadingPanel→updateReadingPage`、`setReadingHover→ensureReadingBlocks`、`verifyReadingPageSync→updateReadingPage`、`gotoReadingEntry→jumpReadingTo`、`gotoReadingEntry→updateReadingPage`。

**棘轮**：13 条合计预期 **0**，任何一条从 0 变 ≥1 = 红。**红/绿证据（Chief 2026-10-29 裁定 ①+②）**：真 base 上逐条给出——现役 6 条标 **RED**，已归零 7 条标 **GREEN + 归零提交 + 父提交上同一条闸的红**（表见 §18.3「13 条闸证据」）。**不再要求 13/13 全红**：7 条在 L1–L4 / merge 搬迁时合法归零，要求它们再红等于要求代码回退。**当前 tag `ring-break-base` = `afe20fe` 是 L0 树，暂停使用**。模块里 `showView` 现在还挂在 R1 例外表上，破环后该行必须删、例外表回 0 行（上限 3 不动）。
R 编号由 TestDev 在闸表里领，§2 的 R1–R8 不动。

> **第 9 条边 2026-10-28 更正**：旧名 `jumpReadingToPage` 全仓库 **0 处**，照它数永远 0——假绿，base 上最多只能红 12/13。实为 `jumpReadingTo`（`app.js:19526`，调用点 20675）。更正后实测：**HEAD `e0a8f4b` 的树，13/13 全部可检出**（9 条回调边 + 4 条桥，各命中 ≥1 处）。**量的对象是 HEAD 的树，不是 tag 那棵树**——这两件事不要混：HEAD 上的 13/13 只证明名字对、边在；**红证据要在真 base 上重验**。
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

**判据（Chief 2026-10-29 裁定 ①+②）**：输出里必须**逐条列出 13 条边的名字**，每条二选一：
- 现役边 → 标 **RED**（真 base 上仍有调用点）；
- 已归零边 → 标 **GREEN + 两样证据**：归零提交 sha、**父提交上同一条闸跑红**（见 §18.3 的 13 条证据表）。

只写「GREEN + 注明归零提交」不够——那证明边没了，不证明闸能发现它。少于 13 条 = 不许打 tag。

**13 条「闸抓得到」证据（2026-10-29 实测，Chief 裁定 ①+② 后逐条跑）**

当前 13 项 = **6 RED / 7 GREEN**（量的是 **HEAD 的树**，不是 tag）。每条 GREEN 两样证据齐：

| 边 | 归零提交 | 父提交上同一条闸的红（原样） |
|---|---|---|
| 桥 `setupReading` | `53c539b` | `53c539b^` → `RED 桥 setupReading → showView(（reading-view.js 体内 1 处）` |
| 桥 `renderMergeView` | `cef331b` | `8e95b8e` → `RED 桥 renderMergeView → showView(（app.js 体内 1 处）` |
| 桥 `submitMergeDecisions` | `cef331b` | `8e95b8e` → `RED 桥 submitMergeDecisions → showView(（app.js 体内 1 处）` |
| 边 `renderReading→ensureReadingMarksWindow` | `cd18546` | `ee156f7` → `RED 边 renderReading → ensureReadingMarksWindow（app.js 体内 1 处）` |
| 边 `renderReading→retryReadingPendingPanel` | `bb69de8` | `cd18546` → `RED 边 renderReading → retryReadingPendingPanel（app.js 体内 1 处）` |
| 边 `renderReadingTree→scrollReadingToPage` | `4ed8f0b` | `bb69de8` → `RED 边 renderReadingTree → scrollReadingToPage（app.js 体内 1 处）` |
| 边 `verifyReadingPageSync→updateReadingPage` | `2fd62e9` | `4ed8f0b` → `RED 边 verifyReadingPageSync → updateReadingPage（app.js 体内 1 处）` |

复现（每条 30 秒）：`git worktree add --detach /tmp/wt <父sha>` → `B2T_STATIC_DIR=/tmp/wt/backend/book2text/static node tests/js/edge-ratchet.mjs` → `git worktree remove --force /tmp/wt`。
**余下 6 条现役**（`openPageDetail` 桥 + 5 条回调边）在真 base 上仍 RED；切它们时各自补同款两样证据。

**「真 base」是哪个 sha（必须写死，否则又成第三个范围）**：`ring-break-base` 现指 **merge 落盘后的检查点**（5 个模块，2026-10-29 切）；此前的 L0 值 `afe20fe` 已作废。上面 6/7 量的是当时 HEAD 的树。**`pages` 落盘后需再切一次**（6 个模块）——检查点会随模块数前移，但**只在"套件全绿"时移**。

**打 tag 那一笔的同批动作（过渡态不许活成终态）**：
1. ✅ **已做（2026-10-29）**：把 CI 里 `contract-registry --strict --allow-transitional-base` 的 `--allow-transitional-base` **删掉了**。那面 flag 的存在是因为 tag 现在还打在 L0 上；真 base 一打出，它就成了「CI 永远放行 base 不合格」的常开开关。同批不删 = 这个 tag 不算切完。
2. 把 `tests/js/replay-base-modules.txt` 更新成**该笔提交** `backend/book2text/static/` 下的 `*-view.js` 列表（真 base 打出时会是 **5 个**，含 `merge-view.js`）。**漏写 = 红，多写 = 红**（fail closed）——这是 base 自检两个方向的机检落点，别手改记录去凑绿：记录是「打 tag 时刻的事实」，不是期望值的旋钮。
3. 上面两条做完，才允许把 13/13 四件证据的「SHA / 谁跑 / 命令 / 输出文件」填上实数。

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

**登记行的两条机检（2026-10-29 补，实现归 `tests/js/contract-registry.mjs`）**：

| 情形 | 判 |
|---|---|
| 登记行缺失 | **红**（现有行为不变） |
| 登记行「批准人」== 该笔提交作者 | **红**（自己批自己） |
| 登记行「批准人」是别人 | 绿 |
| 登记行写在**该笔提交自身**里 | 允许（`move:` 笔的欠账窗口因此消失） |

**为什么两条要一起**：只放开"同批"会变成自己给自己签字；只查"不能自己批"而要求另笔登记，又会制造欠账窗口——**今天的形态是后者：一个人漏登记，所有人推不了。**


| 日期 | 判据 | 变更 | 批准人 | 提交 |
|---|---|---|---|---|
| 2026-10-28 | A1 | 按字面逐笔执行：切边提交内出现 `tests/js/` 即拒；新增测试放相邻独立提交，再受 A2 约束 | Chief | f69df40 |
| 2026-10-28 | A4（新增） | 变异红两遍：拷测试进 base 树跑绿 → 按 T1/T2/T3 阶梯插变异跑红；callee 共用时 T2 中和该次调用（不是整个 callee），T3 仅兜底并写明理由 | Chief | f69df40 |
| 2026-10-28 | 特征测试口径 | 新增测试不许断言调用次数、顺序、注入面调用（C1–C4 探针除外）；编号落 **A5**，随闸 A（R12），不另领 R 号 | Chief | f69df40 + A5 条文 2026-10-29 |
| 2026-10-29 | A1 / A1b / A3 的对象 | `tests/js/**/*.md` 是文档、不是可执行断言：不参与 `deletions` / `touchesTests` / 删除文件 的判定（`*.mjs`、数据夹具照判）。理由：README 记机检覆盖率，改一行读数不算改断言，却会被 A3 要求 `test-contract:` + 删/补/变异 登记——登记表会被文档编辑灌满，下一个人就不再信它 | DevLead | 待补（TestDev 实现后填） |
| 2026-10-28 | C2 | 白名单改为 §12.4 `snapshot-fields` 可解析块（同源），废掉 `get` 前缀法 | Chief | f69df40 |
| 2026-10-28 | C4 | 上限改为「kind ⊆ 6 且 flush 后残留 0」，改读 `readingIntentStats.dropped`，不查深度 | Chief | f69df40 |
| 2026-10-29 | A1b / A3 | 删：旧偏好用例里借 `splitPrefs/saveSplit` 直读内部的两行，以及「序列净删除 0」的旧判法；补：偏好用例改真实拖动事件（`pointerdown→pointermove→pointerup`，断言 CSS 变量 232→300px + localStorage + 重载保持），A1b 改成「只有合规 test-contract 提交可删 tests/js 行」，合规 = 三样俱全；变异：`MAX_EXPORTS 6→5`／`TEMPORARY` 塞回 `splitPrefs`／产品侧松手不 save 各自红在目标断言 | DevLead | 50bc45f |
| 2026-10-29 | R9 / R11 | 删：R9 只认「成员访问/调用/赋值目标」的旧口径、R11 写死两份文件且把缺函数体记 0 的旧实现；补：R9 三种裸引用（实参/条件/模板 `${}`）与 class 参数声明，R11 扫全目录 `*.js` 且缺函数体即红，两条各加「喂合成样例必须红」的自检；变异：三种裸引用喂进去必红、六种非引用必不红；caller 改名/搬到第三份文件必红；删掉 §18.6 某行 → A3+A1b 红，清空「变异」一格 → A3 红 | DevLead | 5c2f5ab |
| 2026-10-29 | L7–L10 测试耦合 | 删：草稿用例直调 `ctx.draftReading` 的两行、「已审计数」的 `progressNumbersSkip` 守卫（它会让这条永久 skip = 覆盖倒退）、R4b 例外表最后一条与 `MAX 1`；补：草稿改走「下一处未审」开面板 + 点「保留原文/采用候选」，「已审计数」改读 `#reading-progress-text` 并对换窗口前后各断言一次，installReadingDeps 的 setter 改成"宿主对象直接赋进 vm"（Map/观察器不再被 JSON 抹成 `{}`），两条集成断言改 module==1 + 合查；变异：进度总数改回按窗口条目数、草稿 key 加时间戳、setter 回退 JSON、app.js 塞两份同名函数、模块两处字面量改名，各自红在目标断言 | DevLead | f70f544 |
| 2026-10-29 | L7–L12 契约 | 删：`load-app` 默认 require `readingDiffUnits`、behavior 里对 `ctx.readingKey/readingEntryVisible/readingProgressNumbers/draftReading` 的 vm 直调、「当前项」两条在 app.js 里找 `is-current` 的断言（抓到的是左侧按钮同名类）；补：新增 `load-reading-view.mjs`（测试侧剥 IIFE，零侵入取模块纯函数）、3 条被 skip 的 `compute-char-spans` 用例改跑、5 处集成改 module==1 + 合查、`line_spans` 合查、当前项改锁"panelKey 决定 + 有 is-current 着色"；变异：改坏 readingDiffUnits 分支条件 / 去掉 chars 过滤判断 / 改 readingKey 键格式 / 改掉 panelKey 与 is-current，各自红在目标断言 | DevLead | 381099c |
| 2026-10-29 | ① 状态迁移 | 删：behavior 里对 app.js 状态的读写（`resetState`/`setEntries`/`readState` 走 `runInApp`）、R4-dup 里 `injected.setReadingFilterValue` 注入链断言、R3 的"找不到审校块即红"、OWNERS 里 3 个零引用状态的表项；补：`installReadingView` 在 IIFE 内追加测试专用 `window.__rvEval` （读写模块词法作用域状态，不改产品文件）、OWNERS 64 条 owner 全量改 `reading-view.js`、R4-dup 改锁"写值 + 立即重画"、R3 把空块当合法（块外引用仍判越界）；变异：owner 改回 app.js / 补回已删状态 / app.js 塞 `el("reading-stream")` / 去掉重画 / 不挂统计对象 / 草稿不参与过滤，各自红在目标断言 | DevLead | cf10d42 |
| 2026-10-29 | R6 / R2 上闸 | 删：无（新增两条闸）；补：R6 判"每个 *-view.js 恰一个 window.XxxView、名字由文件名决定"，加 7 条 `__b2t*` 埋点例外（owner + 到期点 + MAX 只降不升 + 条目必须存在）；R2 判"x-view.js 不得引用 window.YView（Y≠X）"，跨视图走 deps 注入；两条各带合成样例自检；变异：多露一个接口 / 接口改名 / 引用别视图接口，逐条红在目标断言；自检里名字错、零接口、未登记埋点、跨视图引用喂进去必须红，正例必须绿 | DevLead | f8e690a |
| 2026-10-29 | page-tile / step-timing 按 §21.10 收口 | 删：`tests/js/tile-harness.mjs` 里旧依赖名 `imageUrl` 一行、`step-timing` 测试里 `init` 单行改成带定时器注入的一行（共 6 行删除，**没有删任何断言**，都是接口改名与新注入参数带来的机械改写）；补：page-tile 加「两宿主同挂同一页 → src 仍 1 / observer 仍 1 / 图在最后挂的宿主 / 旧宿主空」、「init 缺 `getImageUrl` → create 返回 null 并提示一次」、「没有 rAF 时注册表清空后不再排扫」；step-timing 加 6 条 stall 判据（500ms 无进展计一次 / 有进展不计 / 连续 3 次 stuck / 连续动作只挂一个定时器 / leave 清定时器 / 字段齐）；变异：① `armStall` 不先取消上一个定时器 → 「只挂一个定时器」红；② 删掉 `if (!ready) return null` → 「fail closed」两条红；③ `STUCK_AFTER 3→4` → 「连续 3 次 stuck」红 | Builder | e20b9df |
| 2026-10-29 | `library` 落盘（move:） | 删：无——本笔 `tests/js` 只增 6 行（`VIEW_STATE_PREFIXES` 一条 + `VIEW_EXPORTS` 一条 + 4 行注释），没有删旧断言；补：`library-view.js` 登记进 `VIEW_EXPORTS`（4 个导出 `init/enter/notify/open`，D-100 完整形态）与 `VIEW_STATE_PREFIXES`（IIFE 形态：状态全走注入，模块不存副本），这是新视图落盘 R5/R8 的必需品；变异：① 从 `VIEW_EXPORTS` 撤掉 `open` → R8 报「多出未申报的导出 open」；② 删掉 `library-view.js` 的状态前缀登记 → R5 防漏检报「没有登记状态前缀」；③ 从模块接口对象里删掉 `open` → R8 报「少了已登记的导出 open」 | Builder | 395170b |
| 2026-10-29 | R6 埋点判定 | 删：R6 里"每个 *-view.js 都必须有那 7 个埋点"的判法（第二个模块一出现就假红 7 条）；补：改成"出现即登记"（扫到的 `window.__b2tXxx` 不在表里才红；没有埋点完全合法），表本身的两条改成跨所有 view 文件判，自检加"无埋点合法"与"全仓库都没有则表过期"；同时把 preview 试点 4 处集成断言改 `script + preview-view.js` 合查；变异：preview 加未登记埋点 → 红「未登记的 window 埋点」；删 `__b2tNextLog` → 红「表挂着不存在的埋点」；模块里改名 `onPreviewScroll` → 集成红在 `preview_both` | DevLead | 03ea679 |
| 2026-10-29 | R6 埋点 + preview 集成 | 删：R6 里"只滤已登记埋点"的过滤顺序（新埋点会被报成接口对象，文案带偏）；补：登记 `__b2tPreviewMetrics`/`__b2tPreviewTileTops`（`MAX 7→9`），改成先按 `__b2t` 命名分类再判接口数量，自检加"混合样例里接口检查零问题、埋点检查必须报"；preview 两个集成用例 13 处改合查、`builder` 切片从合查取、`pagesMarginOn` 拆成"模块调注入 + app setter 写状态"两条；变异：加未登记埋点 / 删已登记埋点 / 去掉 `setPagesMarginOn(true)` / setter 不写状态 / 切片里塞监听，逐条红在目标断言 | DevLead | 25f4787 |
| 2026-10-29 | R5 状态登记 | 删：无；补：OWNERS 增加 preview 的 27 条（owner = `preview-view.js`，按源码声明核过）与 reading 一直漏登的 `readingIntents`/`readingIntentStats`/`readingFlushRaf`，总数 64 → 94；新增"R5 防漏检"：每个 `*-view.js` 的顶层状态必须全部在表里且 owner 指向自己，未登记前缀的新视图直接红（`VIEW_STATE_PREFIXES`）；变异：`previewData` owner 改回 app.js / 删掉该条目 / 造未登记前缀的 `probe-view.js`，三条各自红在目标断言 | DevLead | e4a02ab |
| 2026-10-29 | index 视图收尾 | 删：无；补：OWNERS 增加 index 的 24 条（列 0 声明核过，含 `INDEX_*` 与`IMAGE_QUALITY_LABELS`——后者标注"暂驻，到期点 = 建 core/display-prefs 时改 owner"）与 reading 的 8 个模块级常量，总数 94 → 126；`VIEW_STATE_PREFIXES` 加 index 一行；防漏检扫描口径从"任意缩进"收紧到**只看列 0**（index 里有 `let index` 这类局部量，按任意缩进会假红）；R6 登记 3 个 index 埋点（`MAX 9→12`）；5 个集成用例改合查，三处开关断言拆成"模块调注入 + app setter 写状态"两半；README 记 `exit()` 零调用点待办；变异：owner 改回 app.js / 删表项 / 加未登记埋点 / 删已登记埋点 / 模块函数改名，逐条红在目标断言 | DevLead | fba5c21 |
| 2026-10-29 | A1 / A1b | 补：新增 `move:` 笔类（迁移笔的例外，规格见 §18.2.1）——逐笔断言不变，例外只对首行 `move(<视图>):` 的提交生效 | Chief | 本次 |
| 2026-10-29 | 导出棘轮按模块 | 删：无（新增闸）；补：`VIEW_EXPORTS` 一表一模块（ReadingView 6 / PreviewView 3 / IndexView 4），**导出名集合也锁**（多一/少一/改名都红），未登记上限的新 `*-view.js` 直接红、表里登记了但文件不在也算过期，模块加载失败报成可读问题；自检喂"多一个/少一个/改名/未登记模块"四种形态必须红、正例必须绿；变异：IndexView 加 `debug` / PreviewView 删 `exit` / 造 `probe-view.js` / `exit` 改名 `leave`，逐条红在目标断言 | DevLead | 477beea |
| 2026-10-29 | loadPageIndex 行为改动 | 删：无（新增特征测试）；补：`index-view-behavior.test.mjs` 三条——① 预览那条路径调 `loadPageIndex()` 时目录 DOM 零写入（meta 哨兵 + append/innerHTML 双计数）、② 回目录时确实渲染（防"永远不渲染"骗过）、③ `busy` 一个字不写且返回 busy；假 DOM 的 `innerHTML` 改访问器计数（只数 append 会让"清空重画"假绿）；`B2T_INDEX_JS` 支持变异复跑；变异：DOM 写点塞回 `loadPageIndex` / 去掉 `openPageIndex` 里的渲染 / busy 清列表，逐条红在目标断言 | DevLead | a900b2e |
| 2026-10-29 | 导出棘轮降档 | 删：`STABLE` 里的 `exit`、`VIEW_EXPORTS` 里 preview/index 的 `exit` 项；补：`MAX_EXPORTS 6→5`、`VIEW_EXPORTS` preview 2 / index 3 / reading 5（复用 STABLE），自检两条换键（`const index` 去掉 exit；改名用例改 `enter→leave`；"少一个"用例改 `["init"]`——原来的 `["init","enter"]` 正好等于新登记值，会假绿）；README 的"exit 待接"改成"已删"并附量法；变异：PreviewView 加回 `exit` / IndexView 删掉 `refresh`，逐条红在目标断言 | DevLead | 1a4ad0c |
| 2026-10-29 | 文档结构闸 + 七条夹具 + move: 笔类 | 删：无（新增闸与夹具）；补：`docs-structure.test.mjs`（全层级章节号、五条自检、失败信息 `文件:行:节号`）、R1/R3/R4-dup/R4b/R5/R7/R12 的合成样例夹具（内核提成纯函数）、`move:` 笔类（三张登记表派生块边界、豁免/上限不放行、fail closed）、run.mjs 回读绕过留痕；顺带删掉文档第 1779 行的重复 H1（与第 1 行逐字节相同）；变异：各闸的合成违规样例逐条喂红、合规样例不红；`move:` 四条（表内绿/表外红/动 MAX 红/空声明红） | DevLead | 4fb0733 |
| 2026-10-29 | R3 作用域扩展 | 删：R3 只判 `reading` 子树的旧口径；补：**只要有 `<view>-view.js`，app.js 里该视图的 DOM 字面量必须为 0**（reading 保留块内例外 + 4 条豁免），开关是"有没有模块文件"；红夹具按验收形态造（已落盘视图 + app.js 留字面量），另配"收干净必须绿"的对照；变异：在 app.js 副本里加 `el("index-empty")` → 红在「还引用着 view-index 的 id index-empty」 | DevLead | 63a469f |
| 2026-10-29 | 文档结构闸扩三份 | 删：断链只认两级的旧正则（`§18.1.4` 只查 `§18.1` → 装闸也绿）、悬空引用写死行号 0；补：`DOC_FILES` 扩到 boundary/decisions/known-limitations 三份、断链全深度 + 跨文档并集 + 行内代码剔除、ID 型编号重复检测（只对 decisions 开红；`D-004 修订` 算独立号、`L-106`/`L-106b` 算两个号）、排序口径定死"字母后缀在数字子节之前"、已知答案回归（decisions 标题里只有一个 D-100）；变异：十条夹具逐条喂（含三级引用必红、行号必须 > 0、两个 D-100 必红、修订版与后缀版不算重复）；顺带修两处文档里指向不存在节的引用（1486 的示例写法、1290 的"设计稿 1.4 节"——原来写成带 § 的形式） | DevLead | 21fd027 |
| 2026-10-29 | pages 刀一闸侧（R3 过渡豁免 + 读模块断言 + load-app 预载） | 删：`boundary.test.mjs` 7 行（3 处 R4-dup 夹具里的 `page-pages.js` 假源、`r3Problems` 的默认形参 `exemptions = R3_EXEMPTIONS`、「其它已落盘视图 app.js 零引用」断言块与 `occurrences` 循环、`+ viewName-view.js 旧字面量必须收干净` 那行）+ `load-app.mjs` 1 行（`import { readFileSync }`）；补：R3 过渡豁免表、读模块断言、`load-app` 预载 `pages-view.js`；变异：A 删 `pages-error` 整项→红；B `page-grid` cap 14<15→红；C `rec-dual-strategy` stage 3→1→红。注：到期刀自检在该笔时因 seed 正则列序不符而空跑（`seedStages.size=0`，两个 `if` 从不执行），已在 `0b92372` 修复 | DevLead | 9679b16 |
| 2026-10-29 | 修 R3 到期判据空跑（seed 解析正则列序） | 删：`boundary.test.mjs:1425` 的旧 seed 正则、`:1553` 的 `const seedStages = …`（改为可注入）；补：`pagesSeed` 可注入、「到期判据存在性」自检、「到期刀手调必须红」自检；变异：`pages-error` stage 5→2 → 红「到期刀 2 ≠ 现算的 max 5——到期刀不许手调」，还原 → 129 pass / 0 fail。**修的是「判据没在跑」不是「表写错」**：修完后 79 项到期刀全部 == 现算 max，表里一条错值都没有——所以以后看到异常值，先怀疑判据是否在跑，再怀疑数据 | DevLead | 0b92372 |

| 2026-10-29 | R7 / R13 / A1-A3 对象 | 删：R7 里写死 `reading-view.js` 的判定（名单改成从 `static/` 目录列 `*-view.js`，空名单红、加载不存在的 `*-view.js` 也红）；A3 只按 `deletions>0` 判的口径（加 `touchesTests` 守卫，纯函数内核不会把「只改 README」判成改断言）。补：新闸 R13 注入表可解析——`*-view.js` 的 init 注入块里，键值表达式的自由标识符必须属于 `app.js` 顶层声明 / 该工厂作用域 / 全局白名单；模块必读（`injected.X(` / `.` / `[`）但外壳没传 = 红；注入项解析不了 = 红（fail closed）；四个模块各带合成样例自检。A1/A1b/A3 的对象排除 `tests/js/**/*.md`（`*.mjs` 与数据夹具照判），git pathspec 与 `isContractPath` 同口径。变异：删 `library-view.js` 的 script → R7 红「没有 library-view.js 的 <script>」；把 `library-view.js` 排到 `app.js` 之后 → R7 红；`getProject: () => currentProject` 改 `() => project` → R13 红「注入键 getProject 引用了 project」；`injected.getProject(` 改 `injected.ghostApi(` → R13 红「模块读了 injected.ghostApi」；临时 worktree 真提交两笔——只删 `tests/js/README.md` 一行 → R12 绿；删 `boundary.test.mjs` 一行且首行非 `test-contract:` → A3 红 | DevLead | 511df76 |
| 2026-10-29 | A3 拆两段 | pre-commit 只判形态（改 `tests/js` 且 deletions>0 → 首行必须 `test-contract:`），「是否已登记」改为 CI + `status.sh` 的可见红灯、不阻断提交。理由：登记只有 DevLead 能做，放 pre-commit 会让每次契约变更都要两人接力，接不上就有人 `--no-verify`，绕过记录比漏检更难查 | Chief | 待补（TestDev 实现 R12 两段后填） |
| 2026-10-29 | UX V3 面板三改（move:） | 删：无——本笔 `tests/js` 只增 4 行 `OWNERS` 表项，没有删旧断言；补：登记 `readingTreeExpandedChapters` / `readingTreeChapterAuto` / `readingJudgeTimes` / `readingAdvancing` 四个新顶层状态（owner = `reading-view.js`）；产品侧三改：面板只显示差异片段 ±6 字（差异字 `<b>` 加粗下划线、「看整行」展开）、判决即前进（Enter/空格记录后原地换下一条、面板不关）、进度「待判 N 处」+ 20 条后约剩分钟 + 汉字/标点双轨；变异：`tests/js/review-ux-v3.test.mjs` 文件头记录三组反向变异变异：DevLead 2026-10-29 在 `/tmp` 副本上逐条复跑（`B2T_REVIEW_UX_V3=1 B2T_READING_VIEW_JS=<副本>` `node tests/js/review-ux-v3.test.mjs`）——Enter 改回无条件 `gotoNextUnreviewed` → ② 红「按 Enter 之后草稿数是 0（应为 1）——当前条被跳过且没记录」；默认焦点挪到「采用候选」→ ③ 红「默认焦点在「采用候选」——回车会执行错的动作」；Enter 改成只关面板 → ② 红（同一条草稿数断言）；`e8a1ce3^` 历史版 4 条全红。本笔未另加变异。**「补」栏更正（Chief 2026-10-29 认错，以本条为准）**：本笔实际只新增 `OWNERS` 四行（`readingTreeExpandedChapters` / `readingTreeChapterAuto` / `readingJudgeTimes` / `readingAdvancing`）；`R3` 与边棘轮**经核对无需改动**（本笔无新增 review 子树 id 引用、无新增调用边，两条在 HEAD 上本就绿）。提交信息里的「OWNERS/R3/边棘轮」是**过度声明**——这类错比少写更坏：少写会被人查出来，多写会被当作已完成 | DevLead | 691bb60 |
| 2026-10-29 | 判决即前进·窗口边界（move:） | 删：无；补：`OWNERS` 登记 `readingPanelOpenedAt`；产品侧把 reset 的隐藏判定从「key 空就藏」改成「刚开 2.5s 内的面板还原 key」，并在服务端换页路径上按 `next-lines` 重试到面板真的在（已判条目服务端会排除，不跳条）；变异：恢复旧的 reset 判定后实机连判第 9 条后（跨页边界）面板消失、第 10 条按不动（2026-10-29 18:31 实测）；修复后同一脚本连判 22 条面板全程 open、`未提交` 逐条 +1；**DevLead 复跑：这一笔在 node 闸上没有覆盖**——把 `readingPanelOpenedAt < 2500` 改成 `< 0`、把 `retryReadingPendingPanel()` 直接 `return`，全量 `node tests/js/run.mjs` 两次都仍是 126 pass / 0 fail，所以上面那条是 e2e 实机证据、不是闸的变异证明；缺口原因：`renderReading` 的 reset 分支要更厚的假 DOM（`readingData` + 段构建 + 观察器）才够得着，补法待派 | DevLead | aac4568 |
| 2026-10-29 | page-tile 接线（move:） | 删：无；补：`OWNERS` 登记 `indexTileStartedAt`；`index.html` 在 `merge-view.js` 后、`app.js` 前加 `<script src="/static/page-tile.js">`；`preview-view.js` / `index-view.js` 的页图改走 `PageTile.create/update/release`（无模块时降级原路径），并加「同一页的图被另一视图移走后，本视图先 release 再重建」守卫；变异：两宿主同挂一页由 `tests/js/page-tile-acid.mjs` 锁（旧宿主空、仍只 1 次取图）；本轮实机同页 1 的 `size=view` 赋值全程 1 次、两视图 `handle.img` 同一节点（`sameImg=true`）、图在最后挂的预览宿主 | DevLead | 673c6bb |
| 2026-10-29 | index 撤旧 IO（move:） | 删：`tests/integration/test_ui_assets.py` 两处旧设计断言（`rootMargin`+`INDEX_NEAR_MARGIN`、`indexVisibleObserver`），**没删测试**；补：改守 `indexScrollBound` + `syncIndexWindow` + 无 `new IntersectionObserver` + `indexVisiblePages`；`OWNERS` 登记 `indexScrollBound` / `indexWindowRaf`；产品侧撤 index 自建 near/visible 两个 IO，改滚动几何 + PageTile 单调度，只给「视口 ±1」建瓷砖；变异：实机 observer 构造 11 → 6（≤ 基线 7）、同页 1 的 `size=view` 赋值仍 1、跨视图 `sameImg=true`、切回 index 图移回且不重取；酸测试两入口 exit 0 | DevLead | a7c1337 |
| 2026-10-29 | §18.6 授权签署人（test-contract） | 删：无（只增断言与实现）；补：`feature-contract.mjs` 从 `Approved-by:` trailer 取签署人并校验授权名单（`DevLead`），`boundary.test.mjs` 自检加「非授权签署人 Builder → 红」「表格路径签署人越权 → 红」两条；变异：`Approved-by: Builder` → 红「不在授权名单」；`Approved-by:DevLead` 无空格写法 → 绿；表格里写 `Builder` → 红 | DevLead | 94e83f3 |
| 2026-10-29 | R7b 报错可执行（test-contract） | 删：无（只改两处报错文案）；补：漏 `<script>` 与顺序反了两种红都写「三步修法」（加脚本 / 放到 app.js 前 / 核对文件名；顺序反了补「只留一处 + 刷新看 `window.X`」），红字直接是修法而不是判决；变异：不适用（判据内核未动，自检四条原样跑） | DevLead | 74d0959 |
| 2026-10-29 | review-ux-v3 四条转默认闸（test-contract） | 删：`SKIP_REASON` 与 `B2T_REVIEW_UX_V3` 强制开关（共 27 行，含文件头「为什么默认 skip」那段说明）；补：四条 UX V3 行为用例**默认跑**，历史版本定点复跑改走 `B2T_READING_VIEW_JS`（换被测源码、不关闸）——删掉的是"能关闸的旋钮"，一条断言都没删；变异：DevLead 2026-10-29 无 env 在 `/tmp` 副本上复跑 `node tests/js/review-ux-v3.test.mjs`：`e8a1ce3^` 历史版 → 4 条全红（② 红在「按 Enter 之后草稿数是 0（应为 1）——当前条被跳过且没记录」）；默认焦点挪到「采用候选」→ ③ 红「默认焦点在「采用候选」——回车会执行错的动作」；Enter 改成只关面板 → ② 红（同一条草稿数断言） | DevLead | 6efeedb |
| 2026-10-29 | §18.6 登记段加「批准人 == 提交作者 → 红」（test-contract） | 删：`registrationGap` 只判「有没有登记行」的单一判法（内容三样不变，没删任何断言行）、`registrationApprover` 用 `includes("批准人")` 找表头的写法（它会选中 §18.6 上面那张判据小表 → 列号 -1 → **永远绿**）；补：`registrationApprover` 按表头**整格**定位「批准人」列、`commitAuthor` 取 `git log -1 --format=%an` 整串比、批准人==作者 → 红 / 别人 → 绿 / 行在但读不出列 → 红 / sha 只在正文不算登记；`contract-registry.mjs` 加 `--doc <path>`（真实提交 + 改坏的登记表副本，坏样本不必进工作区）；变异：DevLead 2026-10-29 用 `--doc` 副本复跑——① 691bb60 行批准人改成 `CLnum42` → 红「A3: 691bb60 的 §18.6 登记「批准人」是它自己的提交作者（CLnum42）——自己签自己不算第二人复核」；② 保持 `DevLead` → 该行绿（只剩本笔自身的未登记）；③ 删掉该行 → 红「A3: 691bb60 是 move: 笔，但没登记在 §18.6」 | DevLead | e6cbb35 |

| 2026-10-29 | A3 拆两段（R12） | 删：A3 在 pre-commit 就要求「已登记」的单段判定（它会把登记提交自己也挡住，`511df76` 那种「闸红、下一个人只能绕过」的窗口）。补：内核按「谁有权判」切两段——形态段（A1 同笔、首行必须 `test-contract:`/`move:`、test-contract 动产品、普通提交删文件）留在 pre-commit；登记段（§18.6 有行且带删/补/变异、未登记删除行合计）改成 `tests/js/contract-registry.mjs`（仪表盘 exit 0，`--strict` 供 CI exit 1）+ `scripts/status.sh` 的「闸A登记」一行；R12 在 `B2T_CONTRACT_STRICT=1` 时把登记段也当失败。自检改成「形态段放行 + 登记段红灯」与「登记齐全两段全绿」。变异：非 test-contract 删一行 → 形态段红；test-contract 且不登记 → 提交放行（89/0，只打印红灯）+ 严格模式 exit 1 + status.sh 2 条红灯；只删 README 一行 → 绿。**R7 两条变异 DevLead 已复跑**（`/tmp` 的 static 副本 + `B2T_STATIC_DIR`）：删 `library-view.js` 的 `<script>` → 「index.html 里没有 library-view.js 的 `<script>`——文件存在但没加载」；把它排到 `app.js` 之后 → 「library-view.js 必须在 app.js 之前加载（现在顺序反了：view=93309 app=93268）」。其余变异未复跑，按 TestDev 在真实 worktree 上的结果 | DevLead | d04e6eb |
**登记允许同批（Chief 2026-10-29；从 `move:` 扩展到 `test-contract:`）**：这两类提交的 §18.6 登记行**允许写在该笔提交自身里**（登记只是一行文档，A1 不拦）。不这么做就必然开欠账窗口：登记要第二个人签，签不上就悬着，而**未登记的 `test-contract` / `move:` 会堵住所有人推送**——2026-10-29 一天内因此堵了 6 笔。

同批的代价是"自己批自己"，所以必须配机检，两条**按强度递增**：

1. **批准人 ≠ 提交作者**（`e6cbb35` 已实现）。它能拦住"直接抄作者字符串"，但本仓库所有 Bot 共用同一个提交账号（`CLnum42`），**拦不住真实形态 `Builder | aac4568`**——今天就发生过两笔，两条登记行的批准人写的都是干活的人。
2. **批准人 ∈ 授权签署人**（规格已定，实现待派）：当前只有 **DevLead**。这才是"第二人复核"的真判据；在它落地前，签名由 DevLead **逐条复跑变异后改写**，**不签别人的输出**（`ad88505` 就是这么把两行 `Builder` 改成 `DevLead` 的）。

**签名走 trailer（Chief 2026-10-29 批准，取代"表里同批登记"）**：登记表的主键是 sha，而**一笔提交不可能知道自己会被算成哪个 sha**——写完表格再提交，sha 就变了；`--amend` 补登记，sha 又变一次。所以"登记行写在同批提交里"在机制上不可能，改走提交信息：

```
Approved-by: DevLead
```

- 写在提交信息的 trailer 里，**不依赖 sha**，因此可以真正同批、不再开欠账窗口；
- 机检（待 TestDev 落，三条变异）：`move:` / `test-contract:` 提交缺 `Approved-by` → 红；`Approved-by` 等于 `%an` → 红（自己批自己）；`Approved-by` 是别人 → 绿；
- **两套并存**：本表是**历史记录**（`ring-break-base..4de5a8c` 及之前的笔），**新笔只走 trailer、不再往表里加行**；
- **什么时候删表（照 §13.2e）**：trailer 机检连续全绿、且本表**不再被单独修改** → 表转为历史记录并停止维护。在此之前**不许一刀切抹掉历史行**（抹掉就再也追不回"当时是谁批的"）。

**喂红不许改真文档（DevLead，2026-10-29）**：验证登记段/签名判据时，**不许**为了看红而去改
`docs/refactor/reading-view-boundary.md` 本身（改真文档 → 产生一笔无关提交、还可能被人当成真的判据变更）。
一律用 `--doc <path>` 把**改坏的副本**放 `/tmp` 喂进去：

```
cp docs/refactor/reading-view-boundary.md /tmp/bad.md   # 只改副本
# 把某行「批准人」改成提交作者 / 整行删掉 / 清空「变异」一格
node tests/js/contract-registry.mjs --strict --doc /tmp/bad.md   # 期望红
```

**这条是规则，不是习惯**：真文档是判据的唯一真源，喂红的样本污染它一次，下一个人就分不清
"这条是判据变更还是喂红残留"。

**`contract-registry.mjs` 的统计范围现在是过渡范围**：它算的是 `ring-break-base..HEAD`（今天 172 笔），而当前 tag 打在 L0 上（见 §18.2），这个范围**不等于破环序列**。真 base 切出前，「0 笔不合格」只能当「这一段历史里没有未登记的 test-contract 提交」，**不许当「登记齐全」的结论用**；输出里的那句 `… 笔提交的 §18.6 登记齐全` 也要在 TestDev 下次动它时改成「过渡范围」措辞。

| 2026-10-29 | registry 读数口径 + base 树自检 | 删：`0 笔（N 笔提交的 §18.6 登记齐全）`——base 不是回放基时这句会被读成结论。补：base 不合法时输出 `过渡范围 <base>..HEAD（N 笔）：… 不许当「登记齐全」用`；新增 `baseTreeGap()`——`<base>:static` 与 HEAD 的 `*-view.js` 集合必须相等，不等 fail closed（`--strict` 红），过渡期须显式 `--allow-transitional-base` 且输出注明；`--base <ref>` 可换基点。变异：base=`afe20fe`（只有 reading-view.js）→ 红并说明两种红会混；`--base HEAD` → 绿「HEAD..HEAD（0 笔）登记齐全」；`--strict` 配 tag → exit 1，配 HEAD → exit 0。**三条读数 DevLead 已复跑**：默认 exit 0（带过渡红字）、`--strict` exit 1、`--strict --base HEAD` exit 0 | DevLead | a78188d |
| 2026-10-29 | base 自检改口径 | 删：`baseTreeGap` 用「tag 树 = 运行时 HEAD 的 `*-view.js` 集合」判回放基（merge 后 HEAD 合法长模块会误红）。补：expected 改为冻结记录 `tests/js/replay-base-modules.txt`，切 tag 同批更新；记录缺失/为空/多写 = 红（fail closed）；运行时不读 HEAD 集合。变异：`tag=afe20fe` → 红（`[reading-view.js]` ≠ 记录 4 个）、`--strict` exit 1；`--base HEAD` → 绿；删记录 → 红「base 判定不能猜」；多写 `merge-view.js` → 红。**四条 DevLead 已复跑**，外加第 5 条：临时 clone 里真造出 `merge-view.js` 使 HEAD 有 5 个模块、`--base HEAD~1`（4 个模块）→ 绿（实测输出 `0 笔不合格（HEAD~1..HEAD（1 笔）登记齐全）`） | DevLead | 68adf16 |
| 2026-10-29 | 桥例外退休（merge 搬迁） | 删：`BRIDGE_EXCEPTIONS` 里 `renderMergeView` / `submitMergeDecisions` 两条（到期点正是「merge 视图搬进模块时」）；补：`BRIDGE_EXCEPTION_MAX` 3→1；13 条仍全在（退休的是例外，不是边）。变异：搬迁后把两条例外加回去、计数已归零 → `桥例外 submitMergeDecisions 已经归零（切掉了），请同批删除例外`（本笔落地后第一次全量跑就红在这条消息上）；删掉例外 → 绿 | DevLead | 8e95b8e |
| 2026-10-29 | move(merge) 落盘 | 删：`app.js` 14 函数（`charDiff`/`diffMiddle`/`mergeVisiblePages`/`renderMergeView`/`showMergePage`/`loadMergePageImage`/`drawMergeOverlay`/`mergeBlockItem`/`decideMergePage`/`mergePageRow`/`renderMergeListView`/`renderMergeFooter`/`submitMergeDecisions`/`acceptAllClean`）+ 3 处 merge 控件绑定 + 两处 `renderMergeView(payload)` 直调；补：`merge-view.js`（613 行、IIFE、2 导出 `init`/`enter`）+ `showView` 的 merge 分支 + boot 的 11 键注入 + 静态 `#merge-footer`（R3：模块不许引用 HTML 里没有的 id）。变异：删 script 标签 → R7「index.html 里没有 merge-view.js 的 `<script>`」；模块多一个导出 `refresh` → R8「多出未申报的导出」；外壳不传 `getMergeState` → R13「模块读了 injected.getMergeState（必读形态），但外壳注入表里没有这个键」 | DevLead | cef331b |
只有 DevLead 能加行。没有登记行的放宽一律按违规算。

---

## 19. 待办（必须带触发条件，不许"下次顺手"）

| # | 事项 | 触发条件 | 状态 |
|---|---|---|---|
| T1 | `boundary.test.mjs` 里 4 条 R3 豁免的 `expires` 从「正文流① 搬完」改为「**punct 整体搬完**」（`reading-garbled-count`/`reading-garbled-open`/`reading-punct-count`/`reading-punct-open`） | **下一笔碰 `boundary.test.mjs` 的提交必须带上这 4 个字符串**；若该提交没改，单独开一笔（30 秒） | **已完成** `50bc45f`（4 条 `expires` 现在都是「punct 整体搬完」） |
| T2 | R2（视图互引）上闸 | 第二个视图模块（`pages-view.js` 或 `index-view.js`）创建时 | **已完成** `f8e690a`：`x-view.js` 里出现 `window.YView`（Y≠X）即红，带合成样例自检 |
| T3 | R6（一模块一 window 接口对象）上闸 | 同上 | **已完成** `f8e690a`：每文件恰好 1 个接口对象、名字按文件名转驼峰；另配 `WINDOW_HOOK_EXCEPTIONS`（埋点出现即登记，`MAX` 12） |
| T4 | ~~`showView` 接 `exit()`~~ → **已裁决：删 `exit`**（三个模块）。`.exit(` 全仓库 0 个调用点，它是**永不执行的导出**；实测重复 `enter()` 不重复绑监听、不重建观察器，今天不需要"离开时清理"这个口子 | 证据见下方「T4 裁决证据」 | **已完成**：`ReadingView` 6→5 / `PreviewView` 3→2 / `IndexView` 4→3，棘轮同降 |

| T6 | **建 SCC 快照机制**：脚本算环内边 → 写 `docs/refactor/scc-snapshot.json`；与上次 diff，新增边必须解释或修掉 | 破环阶段末；之后每次大重构末 | 未做 |
| T5 | **导出棘轮按模块建**（`VIEW_EXPORTS`，新 `*-view.js` 不登记即红；导出名集合一起锁） | 每拆一个视图都必须同批登记 | **已完成** `477beea`；**权威源 = `tests/js/boundary.test.mjs` 的 `STABLE` / `VIEW_EXPORTS`，本行不复述任何数字**（2026-10-29 曾在此写死 6/3/4，删 `exit` 后过期——这条历史注记是"为什么这里不许写数"的证据，不是数字） |
| T6 | **`loadLibrary()` 不隐藏 `#library-error`**——上一次加载失败的错误会留在页面上，成功的刷新也不清（其余四个操作开头都清，只有它没有） | 已单独一笔修（**不混进搬运**，否则逐字节证书作废） | **已完成** `032d7cb`（stash 对照：修前 `hidden=false` → 修后 `hidden=true`） |

### T4 裁决证据（2026-10-29，真浏览器实测）

**问题**：`exit()` 三个模块都导出、`showView` 从不调用 → 是"永不执行的导出"。
但删之前必须先回答一个问题：**重复进入会不会重复绑定？** 如果会，`exit` 就不是死代码，而是被漏掉的清理点。

**量法**（`ego-browser` + 真页面，1423×900 dpr 2）：
1. 页面里替换 `EventTarget.prototype.addEventListener`，按「**元素 × 事件类型**」计数（`WeakMap` 挂在元素上）；
2. 替换 `IntersectionObserver`，记构造与 `disconnect` 次数；
3. `showView("pages")` ↔ `showView(...)` 来回切 **3 轮**，每轮只扫**仍挂在文档上的元素**，看有没有同类处理函数 > 1。

**读数**（同一元素上同类处理函数最大个数 / 有重复的元素数 / 新增 IO / disconnect）：

```
目录确认 3 轮：  1 / 0 个 / 0  / 0     ← 观察器一次都没重建（observeIndexTiles 认 indexObserver 非空就复用）
正文审校 3 轮：  1 / 0 个 / +1 / +1   ← 建 1 断 1，稳定在 3 个
结果预览 3 轮：  1 / 0 个 / 0  / 0
```

**结论**：三个模块的 `enter()` 都幂等，**没有双绑**。所以 `exit` 是永不执行的导出 → 删。

**两个量错的口径，记下来（都是我自己踩的）**：
- 第一次数的是"`addEventListener` 被调用了几次"——每轮都涨（+88 → +176 → +264），看起来像泄漏。
  抓栈后发现是 `buildBoxLabel`（app.js）**每次重画都造新元素、给新元素绑**，旧元素被丢掉时处理函数跟着走。
  **数"add 次数"量不出双绑，必须数"同一元素上活着几个"。**
- 第二次是在**视图隐藏**状态下直接调 `IndexView.enter()`，量到"每次 enter 重建 2 个观察器"。
  那是假象：隐藏时 `getBoundingClientRect().height = 0` → 页高算不出 → `buildIndexPages` 走重建分支。
  **必须走真实路径 `showView`，在可见状态下量。**

**留着的缺口（不在 T4 范围，别混进来）**：三个模块的观察器在切走视图后**不会断**，隐藏元素上的
`IntersectionObserver` 仍会回调（多半 `isIntersecting=false`，做了无用功）。那是**性能**问题不是
正确性问题，今天没有证据说明它影响任何可观测行为；要动它得单独一轮 + 收益数据。

**为什么写进表而不是记在脑子里**：T1 的错法很具体——正文流① 排在前，做完会有人按表检查这 4 条该不该到期、发现不该，然后记一句"待 punct"就沉了；下次再看表，写的还是「正文流①」。**到期点写错 = 这条豁免永远不会被主动清理**，和"例外表挂着已删代码"是同一种松，只是松在文字上。

---

## 20. 其它视图的模块契约（2026-10-29，拆 `preview/index/review/pages/merge/library` 之前定）

### 20.1 公开接口：必选 2 + 按需 N

| 方法 | 要求 | 判据 |
|---|---|---|
| `init(deps)` | **必选** | `boot()` 调一次；`deps` 见 20.4 |
| `enter()` | **必选** | `showView(name)` 进这个视图时调 |
| `exit()` | **已删**（2026-10-29） | 原定必选。实测 `enter()` 幂等、无清理需求，且 `showView` 从不调用 → 按"永不执行的导出"删除（见 §19 T4）。将来真要清理，再立一个有真实调用点的导出 |
| `getCurrent()` | **按需** | **只有外壳真有调用点时才加**（目前只有 reading：`savePosition` 要页码） |
| 业务方法（如 `reload`/`toggleFollow`） | **允许，逐个签字** | 每加一个过 R8：棘轮只降不升、写明调用点、Architect 签字 |

**`active` 的终态口径（2026-10-29 定稿）**：模块**不自己记 `active`**，统一用 `injected.isActive()`。**这不是过渡态，没有到期点。**
原因：`showView` 从不调 `exit()`，而 `exit` 已在 T4 被裁决删除——模块没有"离开"的时点。要改成自己记 `active`，前提是先有一个**有真实调用点的 `exit`**；补一个没人调的 `exit` 正是 R8 要防的事，得从 §20.1 重新立项。
`isActive()` 读外壳的 `currentView`，语义清楚、不缓存，与 §20「模块不读 `currentView`」不冲突——读的是注入进来的判断，不是全局变量本身。

**不许这样加**：为了"将来可能用"预留方法。`on`/`emit` 已经被删过一次，理由相同——没有订阅者的事件缝不是缝。

### 20.2 R6 现在可以机检（覆盖数见 §13.2b，别在这里另记一个）

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

| 模块 | 出生接口 | 调用点数（每个导出，实测 `app.js`） | 0 个的处置 | 签字 |
|---|---|---|---|---|
| `ReadingView` | `init/enter/getCurrent/reload`（**4**，`toggleFollow` 已定删） | init **1** / enter **1** / getCurrent **1** / reload **4** | `toggleFollow` **0 → 删**（⑦ 第一个当场命中：follow chip 已搬进模块） | 曾在册 6 个，2026-10-29 删 `exit`、删 `toggleFollow` 后 4 |

**`toggleFollow` 删除是"三处同批"**（Chief 2026-10-29）：产品代码（`reading-view.js` 删导出）+ 本节（5→4）+ 导出棘轮（`STABLE`/`MAX` 5→4），**由 DevLead 一处牵头、同一轮改完**。
完成判据：`grep -c "ReadingView.toggleFollow(" = 0`。
**已知半成品形态**（三处分开落必现其一）：代码删了棘轮还写 5（闸不响，可悄悄加回）；登记表写 4 实际 5（下一个人按 4 推理，结论全错）；棘轮收了登记表没改（两处数打架，再对一轮账）。
**本节先记 4 是"定稿值"，落地以 `grep = 0` 为准。**
| `PreviewView` | `init/enter`（2） | init **1** / enter **4** | — | 2026-10-29 下调（原 3，删 `exit`） |
| `IndexView` | `init/enter/refresh`（3） | init **1** / enter **1** / refresh **6** | — | 2026-10-29 批准 4 个，同日删 `exit` 降到 3 |
| `LibraryView` | `init/enter/notify`（3） | 未落盘；预计 1 / 1 / **5** | — | **2026-10-29 批准**（§20.8） |
| `MergeView` | `init/enter`（**2**） | **已落盘**（`cef331b`）：init 1 / enter 1（`showView` 的 merge 分支） | — | 2026-10-29 落盘；`renderMergeView` 不导出（§20.10），桥随之切到 `navigate()` |

**关于 Merge 3 vs 2（必须写清，两个数不能同时成立）**：
- **2026-10-29 签的是 3**（`init/enter/renderMergeView`），依据是"外壳有数据、视图负责画"、`renderMergeView` 有 2 个调用点。
- **2026-10-29 改成 2**：⑧ 要求"模块不缓存视图数据、只通过注入 getter 现取"落地后，`renderMergeView(state)` 只剩 `navigate` 一个动作——**它没有存在的理由**。外壳两处调用点改为 `mergeState = payload; showView("merge")`，`enter()` 用 `getMergeState()` 现取。
- **结论：3 作废，2 生效。** 作废理由不是"少一个导出更好"，是"这个导出在新契约下没有职责"。

**本表的合计不在这里写死**（§19 T5 的教训）：表里既有**已落地**的模块（`Reading/Preview/Index`），也有**已签字未落盘**的（`Library/Merge`），两种"合计"是两个对象——早前那句"合计 10（5+3+2）"数的是前者，表格行数数的是后者，读的人以为打架。**要合计就说明数的是哪一组。**

**这张表和代码是同一份事实的两个副本，机检已经接上**：`tests/js/boundary.test.mjs` 的 `VIEW_EXPORTS` 登记每个 `*-view.js` 的导出名单——多一个 / 少一个 / 改名都红，**新 `*-view.js` 落盘不登记也红**。本表不会悄悄过期：和代码不一致时机检当场报，不用等下一个读注释的人。

**模块头注释写「为什么没有」，不写「已删」**（`c432e55` 起的做法，采纳为规则）："已删"只说明过去，"为什么没有"能挡住下一个把它当缺失生命周期补回来的人。三个模块头现在都带同一段「本模块不提供 `exit()`」+ 理由 + "将来若要断观察器（L-108）那时再引入，并附等价性证据与真实调用点"。

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

**`loadPageIndex` 的 DOM 写点必须与搬迁同笔（2026-10-29 裁定）**：它在写 `index-meta` / `index-list` / `index-empty`（目录子树 id）。模块一旦拥有该子树，这三行留在 `app.js` 里 R3 直接红，而"搬进模块"的前提是模块已存在——**结构上不存在"先行为后代码"的中间态**。裁定：**同笔提交**，但必须附契约测试（preview 触发过 `loadPageIndex` 之后，目录列表不被重画；断言 `#index-list` 子节点数与最后渲染页序号不变）。

**一条否决**：DevLead 表格第 5 行（preview 的 `init deps` 注入 `syncIndexToggles`）**不是 `refresh()` 的调用点**，也不许改成 preview 调 `window.IndexView.refresh()`——那是 R2 违规（模块互引）。它保持"外壳在 boot 里注入一个 lambda"的形态，由外壳决定是否顺带 `IndexView.refresh()`。

---

### 20.7 已有三个模块的 `enter()` 第二层（§15 第 8 条回溯应用，`pages` 落盘前必须补）

> 模板会复制缺陷，不会复制改进。三份现状都只写了"要什么"，下面是补齐的第二层。

| 模块 | 谁调它 / 时机 / 幂等 | 依赖什么时候会没 | 失败如何观察 | 已知成本 |
|---|---|---|---|---|
| `ReadingView` | `showView`（`app.js:249`，`target==="reading"` 且有项目）。同项目且已加载 → **重绘不重拉**（幂等） | 切走项目 → 外壳不调；`injected.getProject` 未注入 → 直接 return；DOM 被重写 → `openReading` 重铺 | `#reading-stream` 里出现「**正文流加载失败：…**」（不抛） | 每次进入最多 1 次 `export/preview?segments_only=1`；同项目已载 0 次 |
| `IndexView` | `showView`（`:262`）+ 步骤切换。有缓存 → 直接渲染；无缓存 → 生成一次（幂等） | 无项目 → 直接 return；`pageIndexData` 属于别的项目 → 重新生成 | `#index-meta` 显示「**页码索引读取失败：…**」 | 每次进入最多 1 次 `loadPageIndex()`；有缓存 0 次 |
| `PreviewView` | `showView`（`:266`）+ 3 处显式调用（`12419 {invalidate}` / `12427 {force}` / `12772 {invalidate}`）。`{invalidate}` 只丢缓存 | 切走项目 → 外壳不调；`{force}` 带 `isActive()` 守卫 | `#preview-meta` 显示「**预览失败：…**」 | 每次进入 1 次 `/export/preview`（全量）；`{force}` 由外壳控制 |

**新增视图（`pages` / `review` / `library` / `merge`）落盘时，这张表必须有对应一行**，否则不算契约完成（§15 第 8 条）。

### 20.8 `LibraryView.notify({kind, text})` 裁定：走 A（导出），不走 B（外壳持槽）

**冲突（2026-10-29）**：`#library-error` / `#library-warning` 被 **10 个函数 / 18 个写点**写（`library-error` 12 处、`library-warning` 6 处）。其中 5 个函数**不属于 library**（`openPackageFile` / `applyPackageMode` / `loadPackageResults` / `restoreSelectedBackup` / `rerunAuxiliary`——任务包导入、备份还原、第二引擎重跑，全是外壳流程）。
抽一条共享叶子容易，但 R3 不允许它留在 `app.js`（一旦 `view-library` 有模块，写它的 id 就是越界）。于是只有两条路：

| | A. 导出 `notify` | B. 外壳持槽 `registerNotice(fn)` |
|---|---|---|
| 公开接口 | 2 → **3** | 2（零新增） |
| 调用点 | 5 处，全是真实流程 | 外壳持一个变量 |
| 可发现性 | 有签名、有文档、棘轮登记 | **没有签名、没人知道谁在调** |
| 性质 | 外壳 → 模块（注入方向） | **模块 → 外壳（借出写能力）** |

**裁定：A。** 四条理由（第 1 条是决定性的，别删）：

1. **B 是"没有订阅者的事件缝"的变体**——我们删 `on`/`emit` 时否过同一种形状；区别只是那个是模块往外发事件，这个是模块往外注册一个"能写我 DOM 的函数"。
2. **B 会让 R3 变成空文**：`app.js` 里确实不再出现 `el("library-error")`，但外壳手上握着一个能写它的函数——**判据查不到的东西，等于没有判据**。
3. **A 的调用点整齐**：5 处，和 `IndexView.refresh()` 同级同量，不是"为将来预留"。
4. **这已经不是"多一个导出 vs 少一个导出"的取舍，是"判据能不能生效"的取舍**：R3 查的是**看得见的形态**（`app.js` 里的 id 字面量），而 B 用闭包/注入把写点藏到外壳持有的变量里——**字面量消失、违规还在、判据判绿**。**这和 R9 那个洞是同一族**：判据只认形态，间接引用（闭包、注入、改名、搬到第三份文件）都能绕过形态。

**`notify` 的第二层（§15 第 8 条）**：

| 项 | 定 |
|---|---|
| 谁调 / 时机 | 5 个外壳流程结束时（导入完成/失败、还原、重跑）。**重复调用以后者为准**，不排队 |
| 依赖什么时候没 | 模块未 init → 外壳用 `?.` 静默跳过（这是接线错误，不是运行态；靠 e2e 抓） |
| 失败如何观察 | 它**本身就是**错误显示，不抛；`kind` 区分 `error` / `warning` |
| 已知成本 | 零（一次文本写入） |

**一条必须写死的语义**：`notify` 可能在任何视图下被调（导入发生在页面视图）。所以它写的是**隐藏 DOM**——`enter()` **不许清空 notice**，否则"用户在页视图导入，切回 library 时提示已消失"。只有 library 自己的操作（`loadLibrary` 等）才覆盖它。

**由此得出一条通用判据（从 §22.8 的展开版补回，2026-10-29）**：

> **问一句「这段 DOM 的内容，触发者是不是当前视图？」不是 → `enter()` 就不能动它。**

这是"跨视图可见 DOM"这一类（提示、badge、进度条）的通用判据，不只适用于 library 的 notice。

### 20.9 搬迁验收模板：三条可数的（并入 §22 模板）

**⑦ 死导出检查（可数）**：搬完逐个导出 `grep -c "<Module>.<method>("`，**0 个就二选一——补接（补一行外壳）或删接口，不许留着。**
已发生四次：`ReadingView.exit` / `PreviewView.exit` / `IndexView.exit`（零调用点 → 删）、`MergeView.enter`（外壳没那行 → 差点零调用点）。
**规律不是"有人忘了调"，是"接口先于调用路径存在"。**

**⑦b 机检版：调用点必须指向已登记的导出（默认包含，不是枚举白名单）**

现行 `EDGES`/`BRIDGES` 是**枚举型白名单**（13 条边 + 4 个桥名硬编码）——**新增的桥/边不在名单里就不受管**，这正是"默认方向错了"的形态。改成：

1. 扫 `app.js` 里所有 `window\.<Name>View\.<method>\(` 的调用点；
2. `<Name>View` 必须在 `VIEW_EXPORTS` 登记过；
3. `<method>` 必须在该模块的导出名单里（不在 → 红：调了未登记的方法）；
4. 每个已登记导出的**调用点数**必须与 §20.6 表一致；**为 0 且未删除 → 红**（⑦ 的机检版）。

这样"新增一个没人调的导出"和"调一个没登记的方法"都当场红，不依赖有人在名单里记得加。

**⑦c 边的集合是 SCC 的输出，不是输入（2026-10-29，Chief 定）**

⑦b 只对**桥**成立——`window.X.method(` 是可枚举的代码形态。**对"边"不成立**：一条边是 `renderReading → ensureReadingMarksWindow` 这种**函数间调用关系**，"哪些算边"是**设计判断**，不是代码形态；硬要"默认包含"就得扫 800 函数全调用图，那不叫对账，叫重算。

**所以边表不靠"忘不了"，靠派生：**

```
E_scc        = SCC 分析算出的当前环内边（派生物，不手工维护）
CUT_EDGES    = 已切掉的边（手工，每条带 commit 与理由）
REMAINING    = 还在的边（派生）
断言①  E_scc = CUT ∪ REMAINING，且 CUT ∩ REMAINING = ∅
断言②  CUT 里的边不得重新出现在 E_scc（回退即红）
断言③  阶段末重跑 SCC 与上次快照 diff；**新增边必须解释或修掉**
```

**为什么这样够用**：边表主要防的是"环没切干净"。**边漏一条，SCC 会告诉你环还在**——不用逐笔提交盯，阶段末一定会报。

**这才是"默认包含"在边上的正确形态**：表由计算产出，人只维护"已切"这一侧；**新增的边自动进报告，不依赖谁记得往 13 条里加行。**

**⑩ 注入依赖数派生（优先做，2026-10-29 Chief 排第一）**

今晚这个数飘过 **24 / 30 / 23 / 31**，每次都是人工报、按对象吵。做成脚本：

- **输出必须是集合，不只是数字**：`{ 层, 模块引用但仍在 app.js 的顶层函数名 → 行号 }`；有集合才能对账，有数字只能吵架；
- 与 §13.1 的预期表对账：**集合与表不一致即红**（多一个少一个都算）——**这是过渡态**；对账连续全绿且预期表没被单独改过 → **删表，只留派生**（§13.2e ②）；
- 每次搬层末跑一次，结果贴进提交说明。

**⑪ `VIEW_EXPORTS` 从代码生成**

**它的完成判据含一条期效**：⑪ 落地当笔，`grep -c "move:" tests/js/feature-contract.mjs` 必须归零——`move:` 是 §18.2.1 的过渡例外，导出面能从代码生成之后，"登记一个模块叫什么"就不需要人工提交了。**过渡态不许活成终态。**

现在是手写名单，加导出就得记得改。**从 `Object.keys(window.XxxView)` 生成**（R8 已经在 vm 里真跑，照抄），再与 §20.6 表对账；**两处不一致即红**——**过渡态**。终态：§20.6 的手写表删掉，只留派生（§13.2e ②）。
理由：`MergeView` 从 3 变 2 那次，登记表改了、别处没改——**手写名单必然会漂，派生之后只有一个真源**。

**退休条件（可判定，别让过渡态活成终态）**：⑪ 一落地，`OWNERS` / `VIEW_EXPORTS` 都变成派生物，
"提交里手改登记表"这个动作本身就该消失——**那时 `move:` 笔类必须删除**。
验收形：**⑪ 落地当笔，`grep -c "move:" tests/js/feature-contract.mjs` 必须归零**，否则 ⑪ 不算完成。

**⑫ 章节号必须单调递增（文档结构机检，2026-10-29 Chief 提）**

文档结构也是"会漂的状态"，而且**代码漂了测试会红，章节号漂了没人报错**——只能靠人翻到的时候觉得奇怪。两个真实案例：`### 13.3` 出现两次且内容不同；`13.2b–13.2e` 四节夹在 §17 与 §18 之间（按编号去找永远找不到）。

**判据（可派生，几行）**：
1. 扫所有 `^#{1,6}` 标题，提取编号（`# N.` / `## N.M` / `### N.Mx`）——**能编号的层级都进闸，不只是 2/3 级**；
2. 排序键 = `(N, M, 后缀)`，后缀按字母序；`13.2b` 必须排在 `13.2` 之后、`13.3` 之前；
3. **序列必须单调不减**——重复编号 → 红；倒退（如 §16 之后又出现 13.x）→ 红；子节跑出父节范围（13.x 不在 §13 与 §14 之间）→ 红。
> **上面 1–3 已被下面的"覆盖面"六条取代**（口径从两级 `N.M` 扩到全层级）。保留它们只为对照，**实现以六条为准**；两段并列会让人按哪条都"有据可依"，改一处就漂。

**它抓的是"插错位置"这一类**，包括增量插入没重排、切片改错、以及将来任何一次"我就在这儿加一段"。

**抽取口径是这条闸的命门（2026-10-29 实证，Chief 的假警报）**：

```python
pat = re.compile(r'^(#{1,6})\s*(\d+(?:\.\d+)*)([a-z]?)\s*(.*)$')   # 层级全收；后缀 [a-z]? 必须保留
```

**只扫 `#{2,3}` + `N.M` 是选择性失明**（2026-10-29 实测）：顶层 `## N.` 完全不进闸，
两份相同 H1 也看不见——`N.M` 口径 59 条 vs 全量 84 条。当天文档里就真有一份重复 H1（第 1779 行，
与第 1 行逐字节相同，已删）。

**抹掉后缀的口径会自己造假重复**：`13.2b/13.2c/13.2d/13.2e` 塌缩成 4 个 `13.2`，`23.4b`→`23.4`，`23.5b/23.5c`→`23.5`——于是报出 **3 组**"重复"，一条都不真。**闸自己产生假警报，比没有闸更快被关掉**（人被误报两次就不看它了）。

**自检夹具（上闸时必须带这三条，缺一条不算上闸）**：

| 输入 | 期望 |
|---|---|
| `13.2` → `13.2b` → `13.2c` → `13.3` | **绿**（后缀被正确保留、按字母序排） |
| 两个 `13.3` | **红** |
| `13.2` → `13.3` → `13.2b` | **红**（顺序错，不是"重复"） |

**覆盖面（2026-10-29 补，Doc 审查指出）**：上面那版口径只数 `### N.M`，**顶层 `## N.` 和 `#` 根本不进闸**——所以"重复 H1""两个同名顶层节"它一条都抓不到（本文档曾有一份重复的文档头夹在 §22.8 与 §23 之间，闸没响）。补齐四条：

1. **`#` 只许 1 个**（H1 唯一）；扫之前**先剥掉 ``` 围栏代码块**，否则代码里的 `#` 注释会被当成 H1（本文档实测有 5 行这种假 H1）。
2. **`## N.` 顶层节：编号从 1 起连续递增**，重复/跳号/倒退都红。
3. **`### N.M.K` / `#### N.M.K` 三级编号也要认**；**匹配必须锚到编号结束**，否则 `12.1.1` 会被当成 `12.1` 的重复——那是正则造成的假警报，和"抹掉后缀"是同一类错。
4. 排序键按 `(第一级, 第二级, 后缀, 第三级)` 比较。
5. **断链检查必须认三级引用**（形如 `18.1.4`，三级；正文引用才带 `§`）：只认两级编号的版本，遇到三级编号只会去查它的前两级——前两级存在，于是悬空引用装闸也是绿的（Doc 实测）。
6. **扫的文件不止这一份**：`docs/decisions.md`、`docs/known-limitations.md` 也都有 `§` 引用与编号标题；只扫 `reading-view-boundary.md` 的闸，对它们等于不存在。
7. **排序键与父节记账**（2026-10-29 按实现对账补，此前规格缺）：排序键 `(第一级, 第二级, 字母后缀, 第三级, 第四级…)`——**字母后缀排在更深一级数字之前**，即 `12.1 → 12.1b → 12.1.1`；**父节只按数字前缀认**，所以 `12.1b` **不是** `12.1.1` 的父节，`12.1` 才是。旧判据第 3 条的"范围判"会把 `12.1b` 误当父节，别按它实现。

**本文档实测（2026-10-29）**：**全层级编号标题 85 个**；其中 `N.M` 两级口径 **58 个**（两个数不是一回事：口径一宽就变），真重复 **0 处**、逆序 **0 处**；旧口径会报 **3** 组假重复。命令（**旧的两级口径，作对照用，不是闸的实现**）：

```bash
python3 - <<'EOF'
import re
from collections import Counter
doc=open('docs/refactor/reading-view-boundary.md',encoding='utf-8').read().splitlines()
pat=re.compile(r'^(#{2,3})\s+(\d+)\.(\d+)([a-z]*)\s*(.*)$')
h=[(int(m.group(2)),int(m.group(3)),m.group(4)) for l in doc if (m:=pat.match(l))]
print('标题数',len(h),'真重复',[k for k,c in Counter(h).items() if c>1] or 0,
      '逆序',[(h[i],h[i+1]) for i in range(len(h)-1) if h[i+1]<h[i]] or 0)
EOF
```

**这条和 ⑩⑪ 一样是"过渡态"**：⑫ 一旦上闸，它检查的是文档自己的结构，没有手工副本要对账——**所以它上闸即终态，没有退休期**（§13.2e ② 只对有手工副本的派生物成立）。

**⑬（元规则，2026-10-29）每条闸必须能被样例喂红，并且能回答"它在谁的回合里跑"**

两问缺一不可：

| 问 | 合格答案 | 不合格答案 |
|---|---|---|
| 能被喂红吗？ | 给检测器一个**合成违规样例**，它报错；给合法样例，它不报 | "它现在全绿"（只证明此刻，不证明会红） |
| 在谁的回合里跑？ | **某个动作发生时自动跑**（提交、装 hook、跑 run.mjs） | "提交前记得跑一下"（这是习惯，不是回合） |

**现状审计（2026-10-29 实测）**：

| 闸 | 有喂红夹具 | 证据 |
|---|---|---|
| R2 / R6 | 有（共用一条自检用例） | `boundary.test.mjs:641` |
| R8（按模块） | 有 | `:1692` |
| R9 | 有 | `:961` |
| R11 | 有 | `:1522` |
| A5 | 有 | `:1851` |
| **R1 / R3 / R4-dup / R4b / R5 / R7 / R12** | **无** | 只有"现状绿"的断言 |

**13 条闸，6 条有喂红夹具，7 条没有。** 缺夹具的闸只证明"此刻没坏"，不证明"坏了会响"——**而"坏了会响"才是闸的定义**。补齐顺序按容易度：R1 / R3 / R7（纯文本扫描，喂合成源码即可）→ R4-dup / R4b / R5（需先把判定内核提成纯函数，像 `windowInterfaceProblems` 那样）→ R12。

**回合现状：13/13 都靠"有人手动跑 `node tests/js/run.mjs`"**（实测 **5.6s**，node 在 `/Users/chenlin/.local/bin/node`）。**这不是回合，是习惯。**

**改法：git hook**（CI 已死，本地 hook 免费且不靠任何人记得）：

```
pre-commit   → node tests/js/run.mjs，红则拒提交
post-commit  → 判断"这笔提交是否绕过"，绕过则留痕（--no-verify 也躲不掉）
```

**两条实测结论（决定了 hook 只能这么写）**：

1. **`--no-verify` 会同时跳过 `pre-commit` 和 `commit-msg`，但 `post-commit` 照跑**（`/tmp/hvtest` 实测：正常提交只打印 `PRE-COMMIT-RAN`；`--no-verify` 后打印 `POST-COMMIT-RAN`）。所以要"能绕但绕了留痕"，**留痕只能写在 post-commit 里，写在 commit-msg 里等于没写**。
2. **hook 的 PATH 不含 `~/.local/bin`**（GUI/ssh 环境更明显）。因此 hook 里必须显式找 node，且**找不到时 fail closed（拒绝提交），绝不允许 `|| exit 0`**——那是"装了一个永远不会红的闸"，比不装更坏。

**机制**：`pre-commit` 通过后把 `git write-tree` 的 tree oid 写进 `.git/b2t-gate-pass`；`post-commit` 比对 `HEAD^{tree}`，不一致即判定绕过，追加到 `.git/b2t-gate-bypass.log`（时间 / sha / 标题 / **有没有写 `Bypass-Reason:`**）。日志本身要在 `run.mjs` 开头被报出来，否则"留痕"只是留给自己看。

**hook 自己也要能被核**：`git config core.hooksPath` 没设置 = 未安装（2026-10-29 的现状就是未安装）。**一个"以为装了"的 hook，和不装完全一样。**

落地位置与装法（脚本已在仓库里）：

```bash
scripts/git-hooks/pre-commit     # 跑 tests/js/run.mjs；红则拒提交；缺 node 也拒（fail closed）
scripts/git-hooks/post-commit    # 比对 tree oid；绕过则写 .git/b2t-gate-bypass.log

git config core.hooksPath scripts/git-hooks   # 装
git config --unset core.hooksPath              # 卸
```

**五条行为在 `/tmp/hooktest` 沙盒里实测过**：绿→通过且无日志；红→拒绝提交；`--no-verify` 无理由→`NO-REASON`；`--no-verify` 带 `Bypass-Reason:`→`WITH-REASON`；`node` 全部找不到→拒绝提交并打印查过哪些路径。

**⑬-2 事故：闸验的是工作区，提交的是索引（2026-10-29，Chief 抓）**

第一版 `pre-commit` 直接跑 `node tests/js/run.mjs`（读**盘上**文件），随后用 `git write-tree` 记录并宣称"这笔提交通过了闸"。**索引和盘上不是一回事**，而四个 agent 共用一个工作区，盘上随时可能是别人未提交的半成品。

**已经真的错过一次**（证据链）：

```
tests/js/run.mjs                  mtime 10:32  +1 行（未提交）
tests/js/boundary.test.mjs        mtime 10:32  +175/-29（未提交）
tests/js/docs-structure.test.mjs  未跟踪
.git/b2t-precommit.log            10:32  退出码 0
62a532c                           10:32:27  只含 docs/decisions.md
```

**那次绿是给 TestDev 未提交的代码签的字；被提交的那份东西，闸根本没看。** 伤害为零（纯文档），但性质是"已经错过"，不是"可能出错"。

**改法：验索引，不验工作区。**

```sh
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
git checkout-index -a --prefix="$TMP/"        # 只导索引；未 add 的文件天然不在里面
( cd "$TMP" && GIT_DIR="$REPO/.git" env -u B2T_APP_JS -u B2T_VIEW_JS -u B2T_STATIC_DIR \
    node tests/js/run.mjs )
```

三条要点：

- **`checkout-index` 的语义正好是要的那个**：没 add 的改动不进去，所以"我以为我改了"不会变成"闸替我背书"；
- **必须带 `GIT_DIR`**：R11 与特征契约要 `git show <tag>:<path>` 读历史版本，临时目录没有 `.git`，不给就整条闸红；
- **必须 `env -u B2T_APP_JS -u B2T_VIEW_JS -u B2T_STATIC_DIR`**：它们是"对历史版本复跑"的口子，hook 继承到就等于**验了别的版本**——和这个洞同一类错。

**`git commit -- <paths>` 也成立**：给了 path 时 git 会让 hook 看到一个临时索引，`git write-tree` 记的正是将要提交的那棵树，所以"只提交我这一份"不会误报绕过（`/tmp/hpathspec` 实测：`x.txt`、`y.txt` 都已 add，`git commit -- x.txt` 只提交 x，无 bypass 记录）。**在四人共用工作区的现实下，这是默认提交姿势**——避免把别人已 add 的文件卷进自己的提交。

**实测（索引导出）**：746 个文件、`67 pass / 0 fail / 2 skipped`、**5.9s**。

**pytest 不在闸里，但必须"说出来"**：`post-commit` 检测到本次改了 `*.py` 就打印"闸里没有 pytest，后端回归要自己跑 `pytest -q`"。**沉默的未覆盖比红更坏**——红会有人看，沉默没人看。

**安装自检（`scripts/install-hooks.sh`，幂等）**：装完在一次性仓库里跑三种情形——**红→必须拒绝**、**索引绿+工作区脏→必须放行**、**索引红→必须拒绝**。第二条就是本次事故的回归用例：**如果哪天有人把闸改回"验工作区"，它会当场红。**

**⑬-3 两个闸、两种成本（2026-10-29）**

| 闸 | 装在哪 | 跑什么 | 代价 | 实测 |
|---|---|---|---|---|
| 提交闸 | `pre-commit` | `tests/js/run.mjs`（**索引版**） | **6s** | 全绿 / 红则拒提交 |
| 推送闸 | `pre-push` | `pytest -q` | **82–85s** | md-only 推送 → SKIP；含代码 → 85s PASS |

- **推送闸只在推送范围含非 `*.md` 改动时跑**：文档改不出 pytest 红。纯文档推送记一行 `SKIP`，不是"没闸"，是"这刀不需要"。
- **`.venv` 缺失时 fail closed**（拒绝推送）——跑不起来的闸不许静默放过；要绕就 `git push --no-verify`。
- **git 没有 post-push hook**，所以推送绕过没有"当场留痕"的位置。补法是把留痕挪到**下一次提交**：`pre-commit` 每次对账"`origin/main` 最近 20 笔里，谁没有 pytest 记录"，用 `.git/b2t-hooks-installed` 的时间戳划起点（免得把装闸之前的历史提交全报成没跑过）。**只报不拦**——推送已经发生了，红没有意义，点名才有。
- **pytest 不进提交闸**是刻意的：82s × 每笔提交 = 没人愿意提交，闸会被 `--no-verify` 训练成摆设。**闸的频率要和它的代价匹配，否则等于没有。**

**残留（写在文档里，不假装没有）**：`core.hooksPath` 是克隆本地配置，新 clone 不会自动有。补法是 AGENTS.md 里一行"session 打开本目录先核 `git config core.hooksPath`"（AGENTS.md 进版本库、每个 session 都读，是唯一"每个 clone 都存在"的回合）。**但这仍是把记忆搬进一个被读的文件；无视 AGENTS.md 的 agent 照样能提交。这条残留已知、已写，不靠制度补。**


**⑧ 状态归属**：视图数据由外壳持有，模块**通过注入 getter 现取，不缓存副本**（R5 一状态一 owner 的实例）。

**身份探针（具名概念，2026-10-29）**：模块允许存的唯一"数据引用"，用途只有一条——
> **只存引用、只比对象身份、永不读字段。读它的任何字段，就是违反 ⑧。**

它存在的唯一理由是回答"数据换没换"（如 `MergeView` 的 `lastStateRef`，决定要不要重置已处理集合）。
**它叫探针，不叫缓存**——这个区分很细，但以后一定有人拿"那我存一份也没事"当理由，所以名字要起死。

**⑨ 验收优先用直接计数**：用「入口被调几次 / 画了几次」这类**直接计数**，不用 DOM 变动次数当替代指标（`__mergeDraws` 优于数 `appendChild`——后者会被重排、占位、隐藏干扰）。

### 20.10 MergeView 最终形态：2 个导出（本裁定覆盖早前对 `renderMergeView` 的签字）

**问题**：Chief 定的 ⑧ 要求模块不缓存 state；一旦 `renderMergeView(state)` 不能存数据，它就只剩"navigate"一个动作——**那这个导出没有存在理由**。

**最终形态**：

```js
window.MergeView = { init, enter };   // 2 个

// 外壳侧（两处调用点，14850 / 14868）：
mergeState = payload;
showView("merge");        // → showView 的 merge 分支 → MergeView.enter()

// 模块内：
const enter = () => {
  const state = injected.getMergeState();   // 现取，不缓存副本
  if (!state) return showMergeEmpty();
  if (state !== lastStateRef) { lastStateRef = state; mergeHandled = new Set(); mergeDecisions = new Map(); }
  drawMergeView(state);
};
```

**三条要点**：
1. `renderMergeView` **不再导出**——它的两个调用点变成"设外壳 state + `showView("merge")`"，语义不变；
2. `mergeHandled` / `mergeDecisions` **只在换数据时重置**（用对象身份比较），重进视图不重置——否则"切走再回来，未提交的裁决被清空"，这是行为改变；
3. `lastStateRef` 只做"换没换新数据"的判断，**不是数据源**（⑧ 的允许项）。

**验收**：`window.__mergeDraws` 一次导入 = 1；"从别处 `showView("merge")` 进入 → 用 getter 重画、不重置裁决"各一条。

## 21. 什么时候该做模块，而不是注入叶子（判据 + 第一个实例：瓷砖服务）

> 2026-10-29 立。在此之前我们只有"能不能搬"的判据（caller-closed、零新增导出），**没有"该不该成为实体"的判据**。有了这条，以后遇到"这堆函数到底该不该独立"不用吵。

### 21.1 判据

> **如果一个概念存在"每个消费者都必须自己维护、并且必须唯一"的状态或生命周期，它就应当做成模块；只有"参数进、值出"的纯变换才应是叶子函数。**

三条**可判定**的检验（不是感觉）：
1. **唯一资源**——同一个键（如 `pageNo`）对应的资源必须只有一份（图 URL、尺寸档）；
2. **唯一生命周期**——同一个键对应的观察器/请求/释放必须只有一处；
3. **唯一失效语义**——资源变化时，必须一次作废、全部消费者同时更新，而不是各自碰运气。

**反判据（够不上就别做模块）**：无状态、无生命周期、无需失效广播的，就是叶子，继续注入或用纯函数。

**反判据的第二个实例（2026-10-29，library 提示元素）**：`loadPackageResults` / `applyPackageMode` / `openPackageFile` / `rerunAuxiliary` / `restoreSelectedBackup` / `downloadResultPackage` 六处各写一次 `library-error` / `library-warning`。**它们不该升成模块**——提示元素只写文本，无状态、无生命周期、无失效广播。抽一个共享叶子 `showLibraryNotice(kind, text)`，6 处调用即可。
**不是所有"被多处写"的东西都该升成模块；无生命周期的，共享叶子就够了。** 这条和 tile 是一对：同样是"多处重复"，一个升模块、一个只升叶子，差别只在**有没有必须唯一的生命周期**。

### 21.2 边界规则（第一个实例：瓷砖服务）

> **"同一页在任何视图里必须长得一样"的，归 tile；"哪些页、点它干什么"的，归视图。**

| 归 tile | 不归 tile |
|---|---|
| 图 URL、尺寸档（清晰度） | 显示哪些页、分页/窗口 |
| blocks 叠加绘制 | 怎么滚动、滚到哪 |
| 版心**线怎么画** | 版心**拖拽手柄**（归 pages 编排） |
| 占位/缺失态 | 点击、拖拽、键盘 |
| 懒加载与观察器 | 批量选择语义 |
| 缓存作废 | diff 高亮**怎么标**（tile 只给 `overlays` 插槽） |

**版心拆两半是本规则第一个实例**：线怎么画归 tile（一种 overlay），拖拽手柄归 pages（编排）。
**不做"整个页面视图一个模块"**——那会把 pages 的版心编辑、index 的缩放档、reading 的 diff 全吸进去，是新上帝对象。

### 21.3 为什么它必须是模块（数据）

8 个渲染叶子（`renderPageBlocks`/`paintTileMargin`/`pageImageUrl`/`pageProfileFor`/`loadIndexBlocks`/`clearImagePlaceholder`/`clearTile*`）现在被 reading / preview / index **各注入一份**；pages、review 拆完是 5 个消费者 → **40 个注入点**。实测：`reading-view.js` 里 `pageImageUrl`×4、`clearImagePlaceholder`×4；`index-view.js` 里 `pageProfileFor`×3、`loadIndexBlocks`×3、`clearIndexDecorations`×4。
5 个消费者 = 5 份缓存、5 个 observer、5 套占位逻辑——**这正是"两个口径"的来源**。

> **23 个注入点已经疼了，不是即将疼。**（2026-10-29 实测：reading 8/8、index 8/8、preview 7/8 个叶子**全部**已在 `injected.*` 上。）
> 所以 tile 不是预防性重构，是**止血**。将来一定有人说"不就有 23 个注入点，忍忍算了"——这句话用来挡它。

### 21.4 API

```js
window.PageTile = {
  init(deps),                                         // { api, getProject, getProfile, notify, getImageUrl }
  create(host, { pageNo, size, overlays, onReady }),  // → handle | null
  update(handle, patch),                              // size / overlays / state
  invalidate(target, reason),                         // target: pageNo | "*"; reason: image|profile|data
  release(handle),                                    // 解绑观察器、回收槽位
};
```

**硬约束**：`create` 的第一个参数是**宿主元素**，模块**不按 id 找 DOM**。它不属于任何 `<section>`——否则 R3 会把 5 个视图的 id 全判给它。

### 21.5 单例注册表（必须写死，否则唯一性不成立）

**`pageNo` 是全局唯一键**：一个 `pageNo` 全局只有 **一份缓存 + 一个 observer + 一组 handle**。
`create()` 对同一个 `pageNo` 的第二次调用**不新建缓存与 observer**，只往 handle 组里加一个。
`release(handle)` 只从组里移除该 handle；**组为空时才释放缓存与 observer**。
不是多实例——多实例就没有"唯一"，判据的三条全部落空。

**自动释放（2026-10-29 追加，Chief 定）——引用计数不能只靠调用方记得还**：

> **宿主元素从文档移除时，它对应的 handle 自动出组**；组为空则缓存 + observer 自动释放。

行为细则（写死，落盘照此）：
- **在帧末/微任务扫，不同步释放**：`appendChild` 移动节点会先触发"移除"再"插回"，同步释放会误杀。扫描时 `host.isConnected === false` 才出组。
- **同一个元素被重新插回**：若扫描前就插回（= 移动语义）→ **不释放、不重新请求图**；若已被释放 → **不自动复活**，消费者调用 `create()` 拿新 handle（拿到的仍是同一 `pageNo` 的注册表条目，重新入组）。
- 扫描只在注册表非空时进行，且只遍历**当前 handle 集合**（不遍历 DOM），注册表空了就停——不许留常驻定时器。

**已知成本（记下来，别以后当性能热点查）**：注册表非空期间，每帧对当前 handle 集合做一次 `isConnected` 扫描。量级很小（`isConnected` 是廉价属性，handle 数约 20–40），但它是**持续的、每帧的**成本。
**如果将来页面视图卡顿，先量这个，别从头查。** 把已知成本写下来 = 提前给它一个"这不是新发现"的标签。

**为什么这条必须有**（Chief 2026-10-29）：5 个消费者、每个都得在正确时机调 `release`，**只要一个忘了，那页的缓存/observer/图永远不释放**；而页面视图正是重绘最频繁的地方（今晚刚修过"重绘把状态吃掉"）。**契约里凡是"必须由所有消费者都记得做"的事，都要有一个不依赖记忆的兜底。**

### 21.6 不负责什么（写进模块头，挡人）

不决定显示哪些页；不绑点击/拖拽/键盘；不画 diff（只给插槽）；不写版心结果；不做批量选择；不管尺寸档从哪来（只接收，变化由视图调 `invalidate`）；不做预取策略；不读 `currentView`。

### 21.7 失败形态：不抛，但**不许静默**

| 情况 | 返回/状态 | 可观察性 |
|---|---|---|
| 图缺失 / 404 | `status:"missing"`，画占位 | `onReady({status:"missing"})` **必须被调用**；`handle.status` 可读 |
| 页不存在 | `create()` 返回 `null` | 调用方据此显示"页不存在"，与"图没到"**必须可分辨** |
| 尺寸档越界 | clamp 到合法档 + 一次 warn | 读 `handle.size` 能看到实际生效档 |
| 数据还没到 | `status:"pending"`，同一 handle | 靠 `invalidate` 推进，状态可读 |

**"不抛 ≠ 静默"**（Chief 2026-10-29）：`missing` / `pending` 必须真的可观察——`onReady` 真被调用、`status` 真能读到、占位能区分"图没到"和"页不存在"。
**tile 是 5 个视图共用的：它静默失败，就是 5 个视图同时静默失败。**

### 21.8 验收：一条酸测试 + 三个可数的指标（不许只进文档）

**酸测试（模块存在理由的证明）**：

> **两个消费者同时持有同一页 → 一处 `invalidate(pageNo)` → 两处同时更新，且只发起一次取图。**

配套可数量（**口径按 D-109，2026-10-29 改**）：
- 同一 `pageNo` 的**取图次数** = **1**——数的是 **`<img>.src` 赋值里带 `size=…` 的次数**，**不是网络请求数**；
- 同一 `pageNo` 的 observer 数量 = **1**；
- `release` 其中一个 handle **不影响另一个持有者的显示**。

**为什么不是网络请求数**：`/pages/N/image` 带 `max-age=300`，第二次取图命中 HTTP 缓存，网络计数 `+0`——**拿网络数当判据，酸测试今天就会误报通过**（Builder 实测：index 翻到页 48 请求 1 次，preview 再翻到 48 仍只 `+1` 网络、`+1` **`src` 赋值**；切回 index、再切 preview 都是网络 `+0`）。**缓存不是共享**，它只是让"重复取图"这段代码在网络上不可见。

**泄漏也必须可观察（与酸测试是一套：一条证明"共享成立"，下面两条证明"共享不会变成泄漏"）**：
- 建 N 个 tile → 全部从 DOM 移除 → **注册表条目数回 0、observer 数回 0**；
- 同页两个 handle → 移除其中一个宿主 → **另一个仍正常显示，注册表条目数不变**；
- **移动一个宿主节点**（`appendChild` 到另一个父节点）→ **不触发释放、不重新请求图**。

**酸测试不成立，"唯一资源/唯一生命周期/唯一失效"就是纸上的**，40 个注入点至少还各管各的。

### 21.9 落盘时的机检要求

- **R3 变体**：`page-tile.js` 里**不得出现任何 id 字面量或 `el("…")`**（服务模块没有自己的 `<section>`）；
- **R6**：一个文件一个 `window.PageTile`；
- **R8**：出生接口登记进 `SERVICE_EXPORTS`（或并入 `VIEW_EXPORTS`），只降不升；
- **R2**：不许引用 `window.XxxView`，需要视图给的一律走 deps。

### 21.10 签字：page-tile 三处待定（Architect，2026-10-29）

Builder 按 `29c2f2f` 实现时留了三处没自己定。**三处都批，各带一个条件**；条件不满足就别接 `pages`（接了再改成本高）。

**① 一个 `pageNo` 只有一个 `<img>`——批。**
理由不是省内存，是 §21.8 的判据给的：数的是 `<img>.src` 带 `size=…` 的赋值次数，不是网络数。两个 `<img>` 必然各赋一次 = 2，判据当场破。
**代价必须写死并测出来**：第二个宿主 `create` 同一页时，`el.append(record.img, slot)`（`page-tile.js:229`）是 DOM **移动**语义——图从宿主 A 搬走，宿主 A 的 `.ptile` 变空；而 `tileScanDetached`（`page-tile.js:74–80`）只看 `host.isConnected === false`，宿主 A 仍在文档里，**不会释放、不会告警，就是静默空白**。
所以补一条酸测试锁住这个语义：**两个宿主同时挂同一页 → `src` 赋值仍 = 1、observer 仍 = 1、图在最后挂的宿主里、旧宿主 `.ptile__image` 为空**。这条测试是"契约外行为"的记录，不是推荐用法。
接线规则（写进模块头）：**任何视图切换先 `release` 再 `create`，不许两个宿主同时持有同一页**；视图本来不同时可见，这条能守住。

**② deps 加 `getImageUrl(pageNo, size)`——批。**
理由：URL 是规则不是数据（项目 id + `token` + `size`，`app.js:4533` 的 `pageImageUrl` 依赖 `currentProject` 与 `token` 两个全局），模块自己拼一份就是复制规则，而且会顺手去读全局。
条件三条：**纯函数**（不 fetch、不碰 DOM、不缓存 token）；**`init` 收到缺的 `getImageUrl` 必须 fail closed**（不许静默出一片空 tile）；**名字就叫 `getImageUrl`**，别叫 `imageUrl`——它是"按页+档位生成"，不是一份现成 URL。§21.4 的 deps 已按此更新。

**③ Node 下 `setTimeout(16)` + `unref()` 兜底——批。**
条件：只在 `typeof requestAnimationFrame !== "function"` 时走（`page-tile.js:52` 已是）；**注册表清空后必须停扫**（`page-tile.js:62` 已有 `if (registry.size > 0)`）；`unref` 只作可选守卫，不许为了 Node 把浏览器路径也换成定时器。
补一条单测：**假 rAF 不存在 → 全部 release 后扫描计数不再增长**（用计数桩，别去查活动句柄，那个不稳定）。否则"停扫"只是代码里看着对。

---

## 22. 视图模块落地模板（2026-10-29，chief 批准；照 `index` 这一刀验证过的形态固化）

**每个视图模块照这张单子勾，不许每次重新设计一遍。** 六条里 ③ 和 ④ 是拿真事故换来的。

### 22.1 接口

1. **`init(deps)` / `enter()`** 必选；**不设 `exit()`**——`enter()` 幂等（监听只绑新元素、观察器非空即复用），
   而 `showView` 不调 `exit`，导出它就是永不执行的导出。**文件头必须写"为什么没有"，不写"已删"**（只写"已删"只说明过去）。
2. **域操作按需，逐个签字**：只有壳侧存在真实调用点才加（`IndexView.refresh`、`PreviewView.enter({force})`、
   预计的 `MergeView.renderMergeView(state)`）。**不许为将来预留**；`on`/`emit` 已被删过一次。
3. **`getCurrent()` 按需**：只有壳侧真要读它当前状态时才加（今天只有 `ReadingView`：`savePosition` 要页码）。

### 22.2 依赖

4. **`deps` 只给句柄**：状态 getter/setter 成对（有写点才给 setter）、仍留 `app.js` 的叶子函数、跨子树 DOM 句柄。
   **不注入值**，模块不许把 getter 返回值缓存到模块级（§13 / §20.4）。
5. **`el` 不进 deps**（模块自带一行）。`isActive()` 是终态（§20.1），不是过渡态。

### 22.3 搬运

6. **先判形态，再定搬法**（2026-10-29 补，`library` 逼出来的第二种形态）：

   | 形态 | 搬法 | 例子 |
   |---|---|---|
   | **连续段 + 段内单连通** | 整段搬（中间态不成立） | `reading` / `index` / `preview` |
   | **散落多簇** | **按调用闭包收集**，不按行区间 | `library`（5 簇散在 2.5k–15.6k 行之间） |

   **为什么闭包不能用名字匹配**：`applyPackageMode` 这种名字里没有 library，可能被 library 的流程调用，
   **也可能完全不属于 library**。判归属不是看名字，是看**"从哪个入口能到达它"**。

   **实证（2026-10-29，`library` 实测）**：闭包比种子多出 **19 个函数，其中名字带 library 前缀的 0 个**
   （`timeAgo` / `progressRow` / `progressPercent` / `ratioText` / `recognitionExtra` / `reviewExtra` /
   `showLockConflict` + 4 个 lock 文案 / `resumeLastPosition` …）。
   **没有数字，"名字匹配会漏"只是常识；有数字，它是证据。**

   **收集法**：
   ```
   从入口（openLibrary / enter / loadLibrary）出发 → 递归收集它调用的、且组外无调用者的函数
   → 碰到"组外还有调用者"就停，那个是接缝（注入或留）
   ```

   **散落集合有个特殊的漏法，必须防**：行区间搬漏了，`git diff` 看得出来（那段没动）；
   **闭包集合漏了没人看得出来**——模块少一个函数、app.js 多留一份，而**测试可能还是绿的**（那个函数还在原地能用）。
   所以每个视图搬完必须交一张**闭包清单**：模块里的函数名 × 数量，与收集结果逐条对账。

   **种子口径必须写死（2026-10-29，一次 62 个百分点的教训）**：
   **种子 = 只碰该 section id 的"非外壳入口"函数。`boot` / `setupShell` / `setupLibrary` 这类外壳根单独列，不进闭包。**

   同一份代码、同一个算法，只改这一条：

   | 口径 | 闭包 | "不属于" |
   |---|---:|---|
   | v1 **含**外壳根 | 216 函数 / **5,038 行** | 136 函数 / 3,435 行 = **68.2%** |
   | v2 **剔**外壳根 | 135 函数 / **3,223 行** | 9 函数 / 179 行 = **5.6%** |

   **68% 变成 5.6%，差的不是代码，是口径。** 原因很实在：`boot` 碰几乎全站的 id，
   把它当种子，闭包就会把整个 app 卷进来——那个"68.2% 不属于"其实是在说"boot 调了全站"，**是废话不是发现**。

   **归属分析的结论主要由"种子口径"决定，而不是由代码决定。口径不写进方法，下一份调查又是两个相反答案。**

   **每簇独立算段外调用方，分四类**（第四类是 2026-10-29 补）：
   **能搬 / 要留（外壳有调用者）/ 要注入（跨视图叶子）/ 不属于本视图（归属有误）**。
   第四类要**明说"这不归它"，不许硬塞**——`setReviewOverlaysForReading` 那次就是因为"放错位置的东西被搬进新模块"改过一回决定。

### 22.4 证据（比代码重要）

**整段搬的风险不在"改坏了"，在"改坏了没人能二分定位"。证据是它唯一的对价。**

7. **逐字节，全量，不抽样**：搬走的**每一个**函数都要过"正变换后与基线逐字节相同 + 逆变换逐字节还原"。
   `index` 是 46/46、`preview` 是 43/43。**大视图按比例更多，一个都不许漏。**
8. **唯一改写要单列**：`index` 只有两处（`openPageIndex` 的加载分支、`setupPageIndex` 的两处档位入口），
   每处写清"为什么必须改"，并由 `verify.py` 里的 `REWRITTEN` 集合锁定——**改写集合之外不允许出现差异**。
9. **账必须对上**：`app.js` 减 N ≤ 搬走行数、模块增 M，差额逐条列（同 L1 那次 `160 搬走 / 130 净减 / +30` 的格式）。
10. **先跑完整验收再提交**，不许"先提交再看"。

### 22.5 提交

11. **一笔 `move(<视图>):`**（规格见 §18.2.1）：产品改动 + `OWNERS`/`VIEW_STATE_PREFIXES`/`VIEW_EXPORTS` 三块登记同笔，§18.6 三样照登。**不再拆"产品一笔 + 测试一笔"**——那两笔必然有一笔红，而"承诺下一笔跟上"是没人检查的承诺。
12. **共享工作区**：`git add` **只点名**，不用 `-A`（会吞掉别人正在写的文件）；`commit --amend` 前先确认 HEAD 还是自己那笔。
13-1. **任何 fail-closed 的路径比较，比较前必须 `pwd -P` / `realpath` 规范化**（2026-10-29，第五次"验错树"）。
   macOS 上 `$${TMPDIR}` 是 `/var/...`、Python 打印的是 `/private/var/...`；`case "$X" in "$TMP"*)` 于是**永远不匹配**，
   一个"防读错树"的自检变成**永久红、与内容无关、挡住所有人**。**自检方向对，但它自己成了更坏的闸。**
   同时记住：**光 `cd` 到那棵树不够**——项目是 editable 安装，`from book2text import paths` 仍指向真实工作区，
   必须 `PYTHONPATH=<那棵树>/backend`，并把解析出的路径**打出来 + 断言**（有断言才有"咬人"的能力）。

13. **验收必须声明"验的是哪一棵树"**（2026-10-29，一天内三次栽在同一处）：

```
工作区（盘上） | 索引（git add 后） | HEAD 树 | 某个 tag / sha 的树
```

   判据写成三段：**<验的对象> + <怎么取到它（命令）> + <结果>**。
   例：`git archive HEAD | tar -x -C $TMP && (cd $TMP && node tests/js/run.mjs)` → exit 0（**HEAD 树**，不是工作区）。
   **理由一句话**：今天所有"两个数打架""白跑一轮""误判为绿"，根子都是没写清验的是哪棵树。

### 22.6 `pages` 的额外要求（Chief 补，2026-10-29）

`pages` 是 2,637 行 / 76 函数的巨提交，**违反"大笔提交 + 无法二分是最贵的东西"**，但段内单连通、中间态不成立，
所以只能整段搬。**对价是更严的证据**：

- 逐字节**全量**（76 个函数一个不漏），不是抽样；
- 账对上（见 9），差额逐条列；
- 搬完**先跑完整验收**（`node` + `pytest` + `qa.py smoke` + 导出对基线）**再提交**。

---

### 22.7 ⑦⑧⑨ 清单（正文只在 §20.9，本节不重复）

- [ ] **⑦ 死导出检查**：搬完逐个导出 `grep -c "<Module>.<method>("`；0 个 → 补接或删接口 —— 见 §20.9
- [ ] **⑧ 状态归属**：不存数据副本；唯一允许的是"身份探针"（只比对象身份、永不读字段） —— 见 §20.9
- [ ] **⑨ 计数验收**：断言"画了几次"，不数 DOM 动了几下 —— 见 §20.9
- [ ] **重置语义**：只在"换了新数据"时重置，重进视图不重置 —— 见 §20.10

> 标注"抄自"也会漂：§11 与 §11.1 就是这么分家的（一处改对、一处留旧，人只看先翻到的那份）。
> **模板要的是能打勾的短句，正文只在权威处存一份。**

### 22.8 跨视图可见的提示：`enter()` 不许清空它

> **`notify()` 写的是隐藏 DOM，`enter()` 不许清空 notice**——否则"用户在页面视图导入、切回目录页时提示已经不见了"。

细节（5 个调用点、谁可覆盖、为什么 library 自己的函数不走 notify）见 §20.8，本节不重复。


---

## 23. 画布 + 图层模型（共同 PDF 画布 + overlay registry）

> **状态：契约定稿（2026-10-29）。** 实现排在 `library` / `merge` 之后（tile → overlay）。
> 定稿标准：**这套契约里没有一处依赖"所有人都记得"**——版本是内容指纹（纯函数）、释放有自动兜底、窗口清单由调用方给、坐标只在画布算一次。

> 2026-10-29，用户提出的模型；Chief 复核后交 Architect 判。**先定契约，不实现。**

### 23.1 它解释了我们为什么拆得费劲

`pages` / `review` / `reading` 三者各自注入 8 个渲染叶子，本质是**没有"画布 + 图层"的公共模型，每个视图自己在拼**。所以 §21 的 tile 只是这个模型的一半（画布），还缺图层（overlay）。

### 23.2 三条精确化（Chief 提，Architect 确认）

**① "始终同步" ≠ "一变就重画"。** 正确形式：**数据是唯一真源，overlay 是数据的纯投影；数据变 → 置脏 → 帧末一次重画。** 同步的是最终状态，不是每次中间变化。
**并且必须复用已有的 `queueReadingIntent` + 帧末消费这套调度**——不许有第二套调度器（两套调度 = 两个口径的另一种形态）。

**② overlay 按"视觉元素类型"注册，不按"步骤"细分。** 一种视觉元素 = 一个渲染器（block 框 / 行 / 字词 / 版心线 / 区域标记）；**步骤只决定"注册哪些渲染器 + 每个用什么样式和数据源"**。
按步骤分会得到两份块框渲染器——正是今天的 8 叶子 × 5 消费者。

**③ 坐标变换是画布的独占职责。** overlay 只提交**页面坐标系**的几何；画布负责映射到屏幕。
**实现要点（补 Chief 的 ③）**：映射用**图层容器上的一次 `transform: scale()`**，不是逐个元素算坐标——逐个算是缩放错位的直接来源。

### 23.3 它是模块还是叶子（按 §21 判据）

三条检验逐条过：
1. **唯一资源**：每页的图层容器 + 全局渲染器注册表 + z 序（同一页的图层顺序必须唯一）；
2. **唯一生命周期**：渲染器注册/注销、图层随 tile 句柄创建/销毁、按类型失效；
3. **唯一失效语义**：数据变 → 按类型置脏 → 一次重画；若各视图自己管，同一页的叠加会被画两遍。

**判定：是模块**（不是叶子）。尤其**层级顺序**与**命中测试**（点击一个位置要判定命中哪一层）必须只有一处管。

**它与 tile 的关系（关键）**：
- **两个模块，不合并**：合并就是"整个页面视图一个模块"那个上帝对象；
- **依赖方向：谁也不引谁**（R2）。tile 句柄暴露一个 `layers` 容器元素，**由视图把它交给 overlay**：`overlay.mount(tileHandle.layers, { pageNo })`；
- 所以 `page-tile.js` 不认识 overlay，`overlay.js` 不认识 `PageTile`——两者都只认**宿主元素**（与 §21 同一条硬约束）。

### 23.4 API 草案

```js
window.OverlayLayer = {
  init(deps),
  register({ type, z, render, hitTest }),   // 全局一次：一种视觉元素一个渲染器
  unregister(type),
  mount(hostEl, { pageNo }),                // 每页一个图层容器（宿主由视图给）
  paint(handle, { data, active, styles }),  // active = 这一步注册哪些 type
  invalidate(handle, types),                // 帧末消费，不立即重画
  unmount(handle),
};
```

`render(item, style) → Element`（**无状态**：只吃 item + style，不读全局）；`hitTest(item, pagePoint) → boolean | null`。

### 23.4b `dataVersion` 从哪来：**内容指纹，不是人工 bump**

**定稿（2026-10-29，Chief 提议、采纳）：`version(scopeKey) = hash(该 scopeKey 的当前数据快照)`。**

**为什么不用"人工 bump"**（D-110 的试金石）：写点有 4 处（marks 应用 / 裁决回写 / 行内编辑保存 / 版心与目录落库后），**任何一处忘了 bump 就是静默 stale**——元素数对、几何对、版本"等于它自己"，**没有任何闸会红**。而且它比 `release` 那次更隐蔽：`release` 忘了会累积（数得出来），`bump` 忘了**什么都不增长**。
指纹把"版本"从**一个要维护的状态**变成**一个纯函数**——**纯函数不需要任何人记得。**

**"就地修改"也因此不再是问题**：审校改一个字 → 快照变 → 指纹变（这正是对象身份比不出来的）。

| 项 | 定 |
|---|---|
| 算什么 | **`hash(该 key 的全部字段 − 显式标注 nonrender 的字段)`**——**默认全含，排除要显式**（见下） |
| 何时算 | **帧末、对即将绘制的 key 算一次**（成本随屏幕上内容走，不是全库） |
| 怎么读 | 注入 `getVersion(scopeKey)`；模块不许自己维护版本 |
| 稳定性 | 同一快照 → 同一 hash；字段顺序必须先规范化（按键排序）再序列化 |
| 成本 | 一页几十条 marks / 几百个字框，`JSON.stringify` + FNV-1a 在微秒级；**若实测不可接受再退 (b)** |

**投影方向反过来：默认全含，排除要显式（2026-10-29，Chief 定，本版修正）**

原写法"只 hash 渲染相关字段"是一份**白名单**——它同样要求"有人记得维护"。反例很具体：某天给 mark 加 `severity` 字段，它影响颜色、影响显示，**但没人记得加进白名单** → 指纹不变 → 不重画 → **静默显示旧颜色，没有闸会红**。而且白名单的通用毛病是：**漏掉的永远是最新加的那个字段，也就是最该被渲染的那个。**

```
version = hash(该 key 的全部字段  −  nonrender 黑名单)
```

- **新增字段自动进指纹**（想漏都漏不掉）；
- 真属纯元数据（时间戳、内部 id）→ **显式标注为 `nonrender` 并写明理由**；
- **两个失败方向选吵的那个**：白名单漏 → 少画一次（静默错）；黑名单漏 → 多画一次（无害）。

**机检（把黑名单本身也钉住）**：取一份真实数据对象，断言
`Object.keys(obj) − NONRENDER_FIELDS === hash 实际吃进去的字段集合`。
这样"新字段既没进指纹也没进黑名单"会当场红——**白名单改成黑名单还不够，黑名单也要被机检盯着。**

**退路 (b)（只有在指纹成本实测不可接受时才用）**：数据写入必须 **immutable**（禁止 `mark.acked = true` 这类就地改），版本退化为对象身份比较。
**前提要写死：就地修改即违反**，并用 R5 式的机检盯住"写入必须走 setter"；**没有这条机检，(b) 会静默失效**。

### 23.5 "始终同步"的可机检判据（这条是"同步"唯一的落地形态）

**定义**：对每一页、每一种 active 类型，在**帧末之后**：
1. **数量**：`overlay 元素数 == 数据条数`（窗口内）；
2. **几何**：每个元素的**页面坐标几何** == 数据几何（零容差——页面坐标不受缩放影响，有差就是错）；
3. **版本一致（防撕裂）**：每个已绘元素带 `dataVersion = getVersion(scopeKey)`；帧末后**所有**元素的版本 == 当前版本（内容指纹，见 §23.4b）。**中途不许出现"旧 overlay 挂在新数据上"**；
4. **幂等**：同数据重画两次，元素数与版本不变。

**可观测手段**：模块暴露只读 `window.__overlayStats(pageNo) → { version, counts: {type: n}, geomHash }`，e2e 在 rAF 回调里采样断言。**这比截图比对稳**（截图会被动画、抗锯齿干扰）。

**实现含义**：重画必须是**原子替换或键控 diff**——先建后换或按 key 复用，不许"清空再逐个 append"（那正是撕裂的来源）。

### 23.5b 一次 `transform: scale()` 的副作用：线宽与字号（必须定，否则 1× 和 2× 是两个东西）

容器上一次 transform 是对的，但它会连**描边宽度和字**一起放大。所以**每个渲染器必须声明自己的缩放模式**：

| 模式 | 含义 | 用在 |
|---|---|---|
| `scaling: "page"` | 随页面缩放（描边变粗、几何贴合图像） | **行框 / 字词高亮 / 版心线 / 区域标记**——它们标的是页面几何 |
| `scaling: "screen"` | 不随缩放：内部套一次反向 `scale(1/s)`，CSS px 保持不变 | **置信度标签 / 页码标注 / 命中提示**——字缩到不可读就失去意义 |

**判据（可机检）**：同一页在 1× 与 2× 两档下：
- `page` 模式的框：**页面坐标几何完全相等**，屏幕矩形恰好 2 倍；
- `screen` 模式的标签：**CSS px 尺寸相等**（不随缩放变）。

> 这是"同一页在任何视图里必须长得一样"那条规则在缩放维度的落地：**一样的是页面坐标，不是屏幕像素。**

### 23.5c 两条边界（写进 §23 的"不负责"清单）

1. **"窗口内"由调用方给**：overlay 不知道哪些页在视野里——`paint()` 收到的是**页面清单**，它只按清单画。和 §21.6"不决定显示哪些页"是同一条边界。
2. **释放顺序由视图保证**：`tile.release()` 后 `layers` 容器会从 DOM 移除，所以**视图必须先 `overlay.unmount(h)` 再 `tile.release(h)`**。
   兜底（D-110）：`overlay.paint()` 遇到已脱离文档的宿主 → **no-op + 记一次 warn**，不许往死容器里画。

### 23.6 不负责什么

不拥有 PDF 图本身（那是 tile）；不做缩放/滚动（画布）；不决定显示哪些页（视图）；不做 OCR/审校数据读取（数据由视图传进来）；不做命中后的**行为**（只回答"命中谁"，点击做什么归视图）。


---

## 24. `library` 搬迁复核清单（Architect 复核用，2026-10-29）

> **施工数字是子集关系，不是两个版本**（2026-10-29 更正）：
> ```
> 30 函数 / 639 行  = 闭包（能搬 + 要留 + 不属于 的总和）
> 17 函数 / 371 行  = "能搬"那一栏
>  6 函数 / 176 行  = "不属于"那一栏（任务包/备份/重跑流程）
>  7 函数 /  92 行  = "要留"那一栏
> 17 + 6 + 7 = 30；371 + 176 + 92 = 639 ✓
> ```
> **以函数名为准，行数不作判据**——理由不是"两个数打架"，而是**行数会随归属分类变化**：同一个函数今天算"能搬"、明天归属分析一变就进"要留"，行数跟着跳。**名字不会变。**

**0. 落地前后硬数（不靠读 diff，靠计数，2026-10-29 基线）**

| 项 | 落地前 | 落地后应为 |
|---|---|---|
| `app.js` | **16,161** | ≈ 16,161 − 371 + (≤6 转发) ≈ **15,796**（容差 ±20） |
| `library-view.js` | 不存在 | ≈ **371 + 骨架**（骨架通常 +20~40） |

**0b. 函数体等价性（比三个数更硬，2026-10-29 Chief 补）**

"复制"最难抓的不是"两份真实现"（R4-dup 会红），而是**"一份真实现 + 一份看起来像转发的复制"**（多几行、加个 `return`、包一层）——**R4-dup 按真实现份数判，这种能过。**

所以对每个被搬函数做**体比对**：
1. 取 `git show <落地前SHA>:backend/book2text/static/app.js` 里该函数的原始体；
2. 取模块里同名函数的体；
3. **两边去缩进后逐行 diff**；
4. **任何差异行，都必须对应本切片声明的"依赖替换清单"**（如 `currentProject` → `injected.getProject()`、`el("x")` → 局部 `el("x")`）；
5. **差异行不在清单里 → 停**：要么顺手改了逻辑，要么复制了一份。

**时序要求（堵"事后伪造来源"，2026-10-29 Chief 补）**：

> **依赖替换清单必须在开搬之前声明，并由第二个人核一遍清单本身。**

- **搬之前**：清单定稿（哪几个符号 → 换成什么），进提交说明；
- **搬之后**：差异行逐条对清单；
- **对不上的、清单里没有的 → 停**。

否则清单会变成"事后解释一切"的工具——**和"test-contract 可删测试行"是同一类风险**（声明在前，比对在后）。

**清单不许照抄**：每个视图的依赖面不同，照抄会让清单里出现这个视图根本不用的替换项。**用空模板逐项填**；**"清单里有、实际没用到"也要报**——那是声明阶段估错了，是信号不是噪音。

> **搬运只改"访问依赖的方式"，不改逻辑。** 逐字节相同做不到（R1 要求模块不引用 app.js 顶层名），但"**差异必须是声明过的那几行**"做得到——这才是可执行的等价判据。

**反例判据（最重要一条）**：**新文件出现、但 `app.js` 减少 < 300 行 → 那是复制不是搬，停。**
搬是"从一个文件搬走"，复制是"出现在新文件、原文件还留着"——后者会把两份实现同时留在仓库里，比没搬更糟（两份真实现，R4-dup 会红，但可能被当成"转发"糊过去）。

**A. 名单与边界**
1. 搬迁名单逐个 `grep -c "function <name>(" app.js` = **0**、模块里 = **1**（真实现份数=1）。
2. **6 个种子函数不得进模块**：`loadPackageResults` / `applyPackageMode` / `openPackageFile` / `rerunAuxiliary` / `restoreSelectedBackup` / `downloadResultPackage`——它们属任务包/备份/重跑流程，只经 `notify` 接触 library。
3. `diff` 形状只允许"搬走 + 转发（≤6 行）"；**任何行为改动单独一笔**（§22.4）。

**B. 接口（§20.6 / §20.8）**
4. `window.LibraryView` = `init / enter / notify`，**恰 3 个**。
5. `notify` 调用点 = **5**（任务包导入完成/失败、备份还原、第二引擎重跑）；`enter` 调用点 ≥1（`showView` 的 library 分支）。
6. 逐个导出数调用点，**0 个 → 补接或删**（⑦）。
7. `enter()` **不清空 notice**（§20.8 硬语义）；library 自己的 4 个函数直接调内部函数、不走 `notify`。

**C. 机检**
8. **R3**：模块里出现的每个 id ⊆ `view-library` 子树；`app.js` 不再出现 `library-*` 的 id 字面量（写提示的那 18 个写点应全部收进模块或改为 `notify` 调用）。
9. **R5**：搬走的状态在 §3 表里的 owner 同批改成模块；OWNERS 条数不变（除非状态删除）。
10. **R2**：`library-view.js` 里无 `window.XxxView`；需要别的视图一律走 deps。
11. **R6/R8**：`VIEW_EXPORTS` 同批登记 `library-view.js: [init, enter, notify]`。

**D. 四基线**（与 §22.4 一致）
12. `node tests/js/run.mjs` fail 0；`pytest` 全过；smoke ≥43/44 且唯一 FAIL 只能是 K1；导出 `body.txt` sha 与基线一致。

**E. 记账**
13. 提交报告三个数：**搬走行数 / app.js 净减 / 模块骨架增量**（§13.2c），并注明"行数口径"（span 还是代码行）。
14. 注入依赖：报**集合**（函数名 → 行号），不只报数字（§20.9 ⑩）。
