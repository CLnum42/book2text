# `view-review` 迁移清单（不是删除清单）

> 依据 `HEAD` 树：`app.js` 15,311 行、`reading-view.js`、`index.html`。
> 结论沿用 `review-delete-or-keep.md`：**要删**，但删之前先把**东西搬到哪**写死。
> **本文不改代码。**

## 0. 一句话方案（决定 ① 里所有"替代宿主"）

**`openPageDetail` 不再切视图，改成"详情抽屉"**：在**当前视图**上叠加一层看页详情（`pages` / `reading` / `index` 里都能开），关闭即回。
这一条同时解决：

- 13 个调用点里 **13 个都在"想看一眼这一页"**，没有一个是"想切到旧审校视图"；
- 现在它们全都会 `showView("review")`——**用户点一下缩略图，就被搬到另一个视图，这是今天最实际的 UX 债务**；
- 抽屉落地后，`#view-review` 就不再是"看页详情"的宿主，只剩 3 项块级能力。

## ① 13 个 `openPageDetail` 调用点（`grep -n 'openPageDetail(' HEAD:app.js`，含定义 14 处）

| 文件:行 | 所在函数 | 流程（用户动作） | 替代宿主 |
|---|---|---|---|
| `app.js:1350` | `setupShell` | `pages` 点"审校选区" → 取首个选中页 | **详情抽屉**（停在 `pages`），随后由用户决定进不进 reading |
| `app.js:4029` | `buildTile` | `pages` 点页面缩略图 | **详情抽屉** |
| `app.js:4047` | `buildTile` | 同上的另一分支（多选/键盘） | **详情抽屉** |
| `app.js:7745` | `renderTask` | 任务列表里点一条 → 跳到那页 | **详情抽屉**（不再换视图） |
| `app.js:8104` | `ensureReviewPage` | 旧审校内部"确保在某页" | 随 review 删除一并消失 |
| `app.js:8264` | `stepPage` | 旧审校分页器翻页 | 随 review 删除（`review-pager` 不迁） |
| `app.js:8422` | `setupReviewPager` | 分页器按钮 | 随 review 删除 |
| `app.js:11594` | `confirmCurrentPage` | 确认当前页后自动跳下一页详情 | **reading 的"下一处"**（`ReadingView.nextUnreviewed`），不是详情抽屉——这里要的是继续审校 |
| `app.js:12089` | `openOrthographyPanel` | 字词/标点面板里点"看原文" | **详情抽屉**（面板之上再叠一层） |
| `app.js:12689` | `renderReviewTree` | 旧审校左树点条目 | 随 review 删除（左树只在旧视图里） |
| `app.js:12943` | `openTreeItem` | 通用树条目点击 | **详情抽屉** |
| `app.js:13257` | `finishStartReview` | 收尾面板"开始审校" | **`showView("reading")`**（不是抽屉——这是"开始工作"） |
| `app.js:15067` | `boot` | 注入 `openPageDetail` 给模块 | 改指抽屉实现（注入名可保留） |

**净结果**：8 个 → 详情抽屉 / 1 个 → `nextUnreviewed` / 1 个 → `showView("reading")` / 3 个 → 随 review 消失。

## ② 三项 review-only 能力：有没有等价物、迁到哪

### ②-1 候选裁决（最大的一项，**不能含糊**）

先分清两种：

| 形态 | 现在在哪 | 有没有等价物 |
|---|---|---|
| **按行采纳候选** | `reading-view.js:1700` `draftReading(entry, "adopted", entry.candidate)`（另有 `:491` `:511` 键盘采纳） | **有**——`reading` 的逐行面板已能采纳 |
| **块级候选：并排对比 + 整块应用** | `app.js` 7 个函数 / **160 行**：`openCandidateCompare`(12) `renderCandidate`(14) `fillCandidateColumn`(31) `candidateBlockActions`(31) `applyCandidateBlock`(39) `decideCandidate`(29) `divergenceCandidatesOn`(4) | **没有**。`reading-view.js` 里 `candidate` 只有 17 处，全是逐行面板，没有块级对比 UI |

**建议（要产品确认）**：
- **迁最小块级能力**：`applyCandidateBlock` + `decideCandidate`（68 行）→ 放进 `reading` 的行内操作，做成"整块采纳/拒绝"；
- **放弃并排对比**：`openCandidateCompare` + `fillCandidateColumn` + `renderCandidate`（57 行）→ 连续流里并排两列本身与"一行一处"的交互模型冲突，**先不做**，但要写在已知限制里（不是删掉当没发生）。

### ②-2 差异队列开关（`diff-queue-toggle`，`app.js` 2 处）

`reading` **没有**等价物。迁移量小：一个开关 + 队列面板渲染（`reading` 已有按差异排序的数据源，只是没有那个开关的 UI）。
**迁到 `reading` 工具栏**，谁做：DevLead 那一刀里顺手，**估算 1 个函数 + 1 个 id**。

### ②-3 整本应用（`review-apply-all`，`app.js` 1 处）

`reading` **没有**等价物。**迁到收尾面板**（它已经是"整本动作"的聚集地：自动通过 / 版面检测 / 撤销都在那儿），**不迁进 `reading`**——整本动作不属于连续流。

## ③ 删的判据（可勾清单）

- [ ] **13 个调用点全部有新宿主**（①表：8 抽屉 / 1 `nextUnreviewed` / 1 `reading` / 3 消失），且 `grep -c 'showView("review")' = 0`
- [ ] **详情抽屉有特征测试**：在 `pages` 打开一页 → 关闭 → 仍在 `pages`（不是"能开",是"关得回来"）
- [ ] **按行采纳**在 `reading` 有测试（已有能力，补一条断言即可）
- [ ] **块级最小能力**（`applyCandidateBlock` / `decideCandidate` 68 行）已在 `reading` 可用，或有明确"不做"的决策记录
- [ ] **差异队列开关**已迁进 `reading`
- [ ] **整本应用**已迁进收尾面板
- [ ] `#view-review` 的 94 个 id 全部有归宿（删 / 迁 / 明确放弃）
- [ ] `tests/js` 三张登记表同批更新（`OWNERS` / `VIEW_EXPORTS` / `VIEW_STATE_PREFIXES`）+ R3 对 review 的 4 条豁免退役
- [ ] `§18.6` 登记一笔（`move(review):` 或 `delete(review):`）

**一条否决线**：**上述任一项没落地就删** = 功能消失且不会有任何闸响。今天所有"看起来删干净了"的事故，都是这一条。
