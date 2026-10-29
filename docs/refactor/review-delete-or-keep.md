# `view-review` 删还是留（分析，不动代码）

> 依据：`main@57890e1` 的树（`git show 57890e1:backend/book2text/static/app.js`，15,311 行）、
> `docs/refactor/evidence/review/{delete-plan.md,entangled.json,movers.json}`。
> 本文只出结论与清单，**任何代码改动等 `pages` 落盘之后**。

## 结论一句话

**删。** 两个视图都映射到步骤 6（"正文审校"），而用户在用的是 `reading` 的连续流——
**同一个步骤两个实现，正是"每个视图自己算一遍正文流"那条反模式的最后一处**。
但**不能今天删**：它还有 4 个真实入口、3 项 `reading` 没有的能力，删之前必须先搬。

## 依据 1：它还有入口，而且是三条不同的路

`grep -n 'showView("review")' HEAD:app.js` → **4 处**，触发条件各不相同：

| 行 | 所在 | 触发条件 |
|---|---|---|
| **1349** | `setupShell` 里的 `selection-review-open` 点击 | `pages` 视图点"审校选区"→ 取 `selectionPages()[0] || visiblePages()[0]`，再 `openPageDetail(page_no)` |
| **8078** | `openPageDetail(pageNo)` 首行 | **通用"看某页详情"动作**，全仓库 **14 个调用点**——这一条最危险：任何走 `openPageDetail` 的路径都会**把用户从别的视图拽到 review** |
| **12088** | 动态建的"看原文"按钮（候选/收尾面板内） | 点"看原文"→ review |
| **13256** | `finishStartReview()` | 收尾面板"开始审校"→ review + `openPageDetail(target)` |

**步骤映射**（`app.js:442` 附近）：

```js
if (currentView === "review" || currentView === "reading") return "review";
if (currentView !== "pages") return "review";     // 其余视图也落到这一步
```

（中间省略 `index` / `preview` 两处）

→ **两个视图共用同一个步骤号**。用户在步骤条上看不出区别，但从哪进去决定了他看到的是旧单页还是新连续流。

## 依据 2：删会失去什么（`reading` 现在没有的）

`#view-review` 有 **94 个 id**，`#view-reading` 只有 **39 个**。逐项比对后，**只在 review 存在**的能力是：

| 能力 | 证据（review 独有的 id） | 处置建议 |
|---|---|---|
| **差异队列开关** | `diff-queue-toggle` | 迁进 reading 工具栏（连续流也在逐行判差异，队列语义仍需要） |
| **候选替换面板** | `candidate-panel` / `candidate-apply` / `candidate-decline` / `candidate-close` / `candidate-open` | **必须迁**：这是"AI 给候选、人裁决"的唯一入口，丢了就没有裁决 UI |
| **整本应用** | `review-apply-all` | 迁进 reading 或收尾面板 |
| **分页器** | `review-pager` | 大概率**不要迁**：连续流不需要分页；删时注意它被 `showView` 引用（跨视图，跟着 `showView` 走） |

**不属于"能力丢失"的**：续页确认 / 收尾面板 / 自动通过 / 清理撤销——`delete-plan §3` 已确认它们是**流程函数**，留在外壳，与 review 的 DOM 无关。

## 依据 3：不删的代价（每天都在付）

| 项 | 数 | 出处 |
|---|---:|---|
| 随模块搬走（若保留就得维护） | **120 函数 / 2,974 行** | `delete-plan §2` |
| 留在 `app.js` 但写着 review DOM 的函数 | **9 函数 / 888 行** | `delete-plan §3` |
| 其中 `setupReviewControls` 的 review 字面量 | **19 处** | `delete-plan §4` |
| 视图 id | **94** | `HEAD:index.html` |
| 接缝（模块正文要引用的外壳声明） | **71 项**（注入函数 45 / 值 20 / get 5 / get-set 12 …） | `delete-plan §5` |

**维护成本的实证**：今天为它的名单吵了三轮（`120/2,974`、`53/1,282` 三个数各算一遍），
而它**大概率不是用户会主动打开的界面**——一个"看运气才会进入"的视图，占着 `app.js` 近 4,000 行的维护义务。

## 删的话要动哪些文件（清单，不含执行顺序）

1. **`app.js`**
   - 删 movers 120 个函数（2,974 行）；
   - 拆 `delete-plan §3` 那 9 个函数里的 review 字面量（**888 行**，其中 `setupReviewControls` 19 处）；
   - **4 个入口改指向**：`1349` / `12088` / `13256` → `showView("reading")`（或迁后的新入口）；`8078` 的 `openPageDetail` 必须换宿主——**它是 14 个调用点共用的"看页详情"，不能继续把用户拽进 review**。
2. **`index.html`**：删整个 `<section id="view-review">`（94 个 id）；`review-pager` 若被 `showView` 引用，跟着 `showView` 一起处理。
3. **`reading-view.js`**：承接迁过来的 3 项能力（差异队列 / 候选面板 / 整本应用）——**这是这次删除的真正工作量，不是删代码**。
4. **`tests/js`**：`OWNERS` / `VIEW_EXPORTS` / `VIEW_STATE_PREFIXES` 同步删条目；R3 对 review 的 4 条豁免（到期点就是"punct 整体搬完"）一并退役；`§18.6` 登记一笔。
5. **`docs/`**：`delete-plan.md` 按步勾销；`reading-view-boundary.md` §19 T5 的口径不改（它已经不写数）。

## 一句话判据（什么时候可以动手）

**当且仅当**：① 3 项 review-only 能力已在 `reading` 里可用（有特征测试）；② `openPageDetail` 已换宿主（14 个调用点全部指向新宿主）；③ 4 个入口全部重定向。
三条缺一条，删了就是**功能消失但没人报错**——那种缺失不会红。
