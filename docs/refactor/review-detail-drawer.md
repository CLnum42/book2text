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
