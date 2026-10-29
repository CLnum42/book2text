# 页详情抽屉：把"看一页"从"换一个视图"里拆出来

> 依据 `HEAD` 树：`app.js` 15,311 行、`index.html`、`reading-view.js`。**本文不改代码。**
> 前置：`review-migration.md`（13 个 `openPageDetail` 调用点逐条定宿主）。

## 0. 一句话

**不新造东西**：把现有的"页详情"DOM（`detail-*`，十几个 id）从 `#view-review` 里搬到一个**全局抽屉**，
`openPageDetail()` 从"`showView("review")` + 渲染"改成"打开抽屉 + 渲染"（**不再切视图**）。

**这一步真正的收益不是"少点一次"，是结构性的**：现在用户点一张缩略图，`currentView` 被改成 `review`；
改完之后 **`currentView` 根本不变**——于是"关得回来"从**测试问题**变成**结构问题**（没有状态被改，就不需要恢复）。

## ① 复用哪个抽屉

现成设施（`app.js` / `index.html`）：

```
#task-drawer            index.html:1656   <aside class="drawer" id="task-drawer" hidden>
openTaskDrawer()        app.js:7075        el("task-drawer").hidden = false
closeTaskDrawer()       app.js:7079        el("task-drawer").hidden = true
结构：.drawer > .drawer__head(标题/状态/✕) + .drawer__body
```

**复用它的 CSS 类与开合形态，新建 `#page-detail-drawer` 实例**（不改 task drawer 的任何逻辑——
它有自己的状态机，塞进去等于让两个东西共用一个生命周期）。

**要搬的 DOM**（现在都在 `#view-review` 里）：

```
detail-image / detail-canvas / detail-lines / detail-blocks /
detail-diff-layer / detail-margin / detail-ink-gaps /
detail-image-status / detail-box-create / detail-close / detail-recognize / page-detail-error
```

## ② 8 个调用点：进抽屉显示什么、关得回来吗

| 调用点 | 抽屉里显示 | 关得回来 |
|---|---|---|
| `setupShell:1350`（pages"审校选区"） | 首个选中页的页图 + 行/块叠加 | ✅ `currentView` 仍是 `pages` |
| `buildTile:4029` / `:4047`（点缩略图） | 同上 | ✅ 同上 |
| `renderTask:7745`（任务列表点一条） | 同上（跳到该页） | ✅ 回到任务列表所在视图 |
| `openOrthographyPanel:12089`（面板"看原文"） | 同上（叠在面板之上） | ✅ 关抽屉后面板仍在 |
| `openTreeItem:12943`（通用树条目） | 同上 | ✅ |
| `boot:15067`（注入给模块） | — | 注入名不变，实现换掉 |
| `ensureReviewPage:8104` / `stepPage:8264` / `setupReviewPager:8422` | 旧审校内部翻页 | ⚠️ 这三条**随 `view-review` 一起消失**，不在抽屉范围 |
| `confirmCurrentPage:11594` | **不进抽屉** → `ReadingView.nextUnreviewed` | 继续审校，不是"看一眼" |
| `finishStartReview:13257` | **不进抽屉** → `showView("reading")` | "开始工作"不是"看详情" |

**⚠️ 过渡期的一条硬约束**：`detail-*` 搬出 `#view-review` 之后，**旧审校视图自己也要用这个抽屉**——
否则在删除旧视图之前，它就没有页图了。所以抽屉不是"给别的视图加个功能"，**是"把 detail 从 review 里搬出来"**。
搬完 `#view-review` 剩的是：左树 / 差异队列 / 候选面板 / 分页器——**那时才谈删。**

## ③ "关得回来"的回归测试（这一条昨天差点变成能开不能关）

**要断言的三个量**（缺一个就会退化成"能开"）：

1. `currentView` **开抽屉前后相同**（结构性保证，也是这条设计的意义）；
2. 抽屉 `hidden` 由 true→false→true；
3. **关闭后原来的滚动/页码没被动过**：`pages` 视图断言 `detailPageNo` 变了、但 `currentView` 与列表滚动位置不变；`reading` 视图断言 `readingPageNo` 不变。

具体用例（`tests/js/`，node 侧用 DOM 桩；e2e 侧可加一条真浏览器）：

```
① pages：点第 3 页缩略图 → 抽屉开（detailPageNo=3）→ ✕ → 抽屉关、currentView="pages"、列表仍在第 3 页附近
② reading：在行上点"看原文" → 抽屉开 → Esc → 抽屉关、readingPageNo 不变、面板仍开
③ 连续开两页：抽屉内容替换而不是叠加（幂等）——防"抽屉里塞了两个 canvas"
④ 关抽屉**不能**触发 renderReading / renderPages（否则"关得回来"变成"关完重绘、位置丢了"）
```

第 ④ 条是这条设计最容易翻车的地方：**抽屉关闭时如果顺手重绘宿主视图，位置就会丢**——这正是我们要躲开的反模式 #2（异步重绘吞状态）。

## ④ 改动清单

| 文件 | 改什么 | 量级 |
|---|---|---|
| `index.html` | 新增 `#page-detail-drawer`（`aside.drawer`）；把 12 个 `detail-*` 节点从 `#view-review` 移进去 | 1 个 DOM 块，**不加新 id** |
| `app.js` | `openPageDetail()` 去掉 `showView("review")`、改为开抽屉；新增 `openDetailDrawer/closeDetailDrawer`；`detail-close` 的处理器从 `showView("pages")` 改为关抽屉 | **约 80–150 行**（大部分是搬走的渲染调用点改上下文） |
| `app.js` | `finishStartReview` → `showView("reading")`；`confirmCurrentPage` → `nextUnreviewed` | 各 1–3 行（可拆另一笔） |
| `reading-view.js` | **不碰**。它已经通过注入的 `openPageDetail` 调用，行为自动从"切视图"变成"开抽屉" | 0 行 |
| `tests/js` | 新用例（③ 四条）；R3 的 review 子树 id 数从 94 减到 ~82（detail-* 搬走），`delete-plan` 的字面量账要同步 | 1 个测试文件 + 2 张表 |
| `docs/` | `review-migration.md` 勾掉 ① 那 8 条；`known-limitations.md` 记"并排对比暂不做" | 2 处 |

**不碰**：`pages` 的搬迁（它独占 `app.js`，等它落盘）、`page-tile.js`、任何 `backend/**.py`。

## ⑤ 顺序（别倒）

```
pages 落盘 → 抽屉（这一步）→ 用户"点缩略图不再被拽走"
          → 迁 3 项能力（差异队列 / 块级最小 68 行 / 整本应用）
          → 删 #view-review（2,974 + 888 行、94 id）
```

**先让用户感到变化，再删代码。** 反过来做，删完没人觉得变好，还会因为"少了个页面"被问一句"我那页去哪了"。

---

## ⑥ 改动点清单（`HEAD` 行号 → 改什么；**只是标注，不动代码**）

### `backend/book2text/static/index.html`

`detail-*` / `page-detail-*` **不是一整块**，它和 review 自己的控件交错着，**分 5 段**（搬的时候逐段可回滚）：

| 段 | 行 | 内容 | 处置 |
|---|---|---|---|
| A | **510–511** | `page-detail-error` / `page-detail-warning` | 移入抽屉 |
| B | **573–586** | `detail-canvas` / `detail-image` / `detail-margin` / `detail-lines` / `detail-overlay` / `detail-diff-layer` / `detail-ink-gaps` / `detail-image-status` | 移入抽屉（**页图那一整列**） |
| C | **615–616** | `page-detail-title` / `page-detail-meta` | 移入抽屉头（`.drawer__head`） |
| D | **627–629** | `detail-box-create` / `detail-recognize` | 移入抽屉工具条 |
| E | **682 / 689** | `detail-blocks`（块列表）/ `detail-close`（返回按钮） | 移入抽屉体；`detail-close` 的文案从"返回页面"改成"关闭" |
| — | 485–698 | `#view-review` 本体 | **本次不动**（删是下一步） |

**不加新 id**：全部沿用现有名字，渲染函数一行不用改（`renderPageDetail` 等 8 个函数按 id 取节点，节点搬了照样取得到）。

### `backend/book2text/static/app.js`

| 行 | 现状 | 改成 |
|---|---|---|
| **8072–8082** `openPageDetail` | `showView("review")` + `renderReviewPager()` + `loadPageDetail` + `savePosition("review", …)` | 去掉 `showView` 与 `savePosition`（**`currentView` 不变**），改为 `openDetailDrawer()` + `loadPageDetail`；`reviewBlockFilter` 那两行的默认值挪进"进 review 时"的路径 |
| **1352** `detail-close` 处理器 | `showView("pages")` | `closeDetailDrawer()`（**不回任何视图**，因为没离开过） |
| **13256–13257** `finishStartReview` | `showView("review")` + `openPageDetail(target)` | `showView("reading")`（"开始工作"不是"看详情"） |
| **11594** `confirmCurrentPage` | `await openPageDetail(next)` | `await ReadingView.nextUnreviewed()`（继续审校） |
| **15067** `boot` 注入 | `openPageDetail: (pageNo) => openPageDetail(pageNo)` | 名字不变，实现自然改变（**注入面零改动**） |
| **7270** 重载守卫 | `currentView === "review" && detailPageNo !== null` | 改成 `detailDrawerOpen && detailPageNo !== null`（否则抽屉开着时识别完成不重载） |
| 新增 | — | `openDetailDrawer()` / `closeDetailDrawer()`（约 20 行：`hidden` 开关 + 焦点/ESC + `detailDrawerOpen` 标志） |

**注意 8072 那四行里藏着一条状态**：`savePosition("review", pageNo)` 会把"上次看到的页"记到 review 名下。抽屉化之后**这一句必须删**——否则用户只是看了一眼详情，就被改成"我在旧审校里看到第 N 页"。

### 同批必须重算的三份输入（否则静默过期）

`detail-*` 一离开 `#view-review`，这三份立刻变：

| 文件 | 会变成什么 | 动作 |
|---|---|---|
| `docs/refactor/evidence/review/movers.json` | review 子树 id 94 → 约 82，闭包与三区会变 | **重算**（`build_movers.py`，脚本生成不手抄） |
| `docs/refactor/evidence/review/delete-plan.md` | 字面量账（§4 的 19/4/3/1/1）要重算 | **重算**（`gen_rules.py` / 对应脚本） |
| `docs/refactor/review-attribution.md` | 94 → 约 82 | **重算或标死** |

**二选一，不许不动**：要么按新树重算，要么在文件头写死「本文件基线为抽屉之前（`f73e756`），勿引」。
今天已经因为"名单没冻结/没重算"白跑三轮（`43 / 120 / 114` 三个数）。
