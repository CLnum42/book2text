# 清洗刀施工书：删页内差异队列 / 块级候选对比 / 4 个零引用 id

> 前置：**T0 之后**，且排在**刀 C / 刀 D 之后、① S1 之前**（Chief 2026-11-02 调整：先清死代码再搬，
> 别把马上要删的函数搬进 page-detail-editor 再删一遍）。实测树 `4231b03`（app.js **12,658** / **501** 函数 / deps **173** / pages-view 3,952）。
> 依据：QA 2026-11-01 真机（队列数据填了但面板不可见、`#queue-adopt` inert；候选对比 0 页数据）＋ Chief 裁决。
> **本刀只删，不修任何 bug**；删不掉的东西说明它还有主，别硬删。

## 0. 一句话

三块死代码：页内差异队列（**19 函数 / 409 行** + 10 id）· 块级候选对比（**6 函数 / 156 行** + 8 id）·
4 个零引用 id（2 个被测试断言，test-contract 同批改）。删完 app.js 12,426 → **11,743**（−683），
R3 review 口径 90/223 → **71/181**（**期望值更正 2026-11-02**：原写 68/194，见 §5 的口径更正）。

## 1. 硬要求：先证明「没有活的功能依赖它」，并写清删后用户走哪条路

### 1.1 页内差异队列（删）

**证据**：QA 实测 `#diff-queue` 不可见、`#queue-adopt` 不响应；toggle 文案显示「差异 3 ▴」而面板 `display:none`
（数据与状态不一致）。**坏 ≠ 没人用**，所以逐个点名依赖：

| 依赖者 | 用途 | 删后怎么活 |
|---|---|---|
| `adoptQueueCurrent` / `keepQueueCurrent` / `previousQueueItem` | 队列里的采纳 / 保留 / 回上一处 | 队列专用 ⇒ 删 |
| `applyQueueAckLocally` / `ackQueueLine` | 队列的局部 ack（PATCH `/diff-ack`） | 队列专用；块内 `adoptLine` 走另一条 PATCH 路径，**保留** |
| `captureQueueSnapshot` / `restoreQueueAfterUndo` | 撤销时恢复队列下标 / 决定 | `reviewAction` 里删这两处调用；undo 仍恢复块 |
| `queueHasPendingItems` | `loadPageDetail` 里「有队列就等处理完再补算建议」 | 删分支 ⇒ **总是立即 `runPageAux`**（行为变化：不再延后建议，符合删队列后的语义） |
| `pendingPageAux` 状态 | 延后补算的页号 | 随删 |
| `openTreeItem` | 跳页后打开队列并定位到该条 | 改成只 `openPageDetail(pageNo)`；定位靠块内差异条 / 树高亮 |
| 键盘 `Enter`/`Space`（采纳）· `⌫`（保留）· `←`（回上一处）· `[` `]`（`stepReviewDiff` 跨块跳差异） | 队列推进 / 跨块跳差异 | 一并删；**逐个说替代/损失**：reading 有 `Enter`=保留、`Space`=采用候选（`reading-view.js:503–516`），但没有 `⌫`/`←`/`[` `]` ⇒ 后四个键是**净损失**，记 known-limitations |
| `body.queue-mode` | 队列展开时隐藏块内差异条 | 只由 `setQueueOpen` 加 ⇒ 随删 |

**用户操作路径（删前 → 删后）**：

```
删前：页头「差异 N ▾」→ 一个面板逐条推进（采纳/保留/回上一处），Enter/⌫/← 快捷键
删后：入口消失。仍能逐行裁决的是**每块展开后的差异条**（blockDivergenceSection，逐行「采纳第二路/保留原文」，
      调 adoptLine）；跨页连续流的差异队列在 reading 视图（reading-tree），不受影响。
      快捷键 Enter/⌫/← 与 [ ] 消失（它们只服务队列）。
```

### 1.2 块级候选对比（删）

**证据**：QA 实测项目里 `has_candidate` 页 **0**；入口 `#candidate-open` 默认 `hidden`，只有该状态才显示 ⇒ 用户没见过它。
**旧判决被推翻**：`review-delete-or-keep.md` 曾写「候选面板必须迁」（那时假设 review 会整体让位给 reading）；
QA 数据（0 页）＋「旧副本」的定性推翻了它——书写明依据，不让下一个人按旧文档复活它。

**用户操作路径**：

```
删前：⋯ →「对比新结果」→ 左右两列并排（现有块 vs 新识别结果）→ 采用新结果 / 换这一块 / 保留现有
删后：入口消失。整页重做识别走 ⋯ →「重新识别」（#detail-recognize，调 recognizePage，整页重跑）；
      pages 视图的「有待选新结果」chip 保留（它是数据事实），但今天 0 页；将来真有会看到没有动作的 chip
      ⇒ 记进 docs/known-limitations.md（不在这刀修）。
```

### 1.3 4 个零引用 id（删 id，不是删元素）

| id | 元素 | 处理 | 测试依赖 |
|---|---|---|---|
| `review-toolbar` | `.workspace-toolbar` div（:485） | **只删 id 属性**（class 与子元素都在用，CSS 保留） | `test_ui_assets.py:1051` 要删这一行 |
| `page-detail-warning` | 空 `.alert--warn`（:509） | **删整个元素**（从未被写，`alert--warn` 还有 5 处在用，CSS 保留） | 无 |
| `review-split` | `.review-split` div（:550） | **只删 id 属性**（class 布局在用，CSS 保留） | `test_ui_assets.py:1570` 要删这一行 |
| `layout-info` | ⓘ 按钮（:664） | **只删 id 属性**，元素保留（title 是版面确认说明，删了就没提示） | 无 |

## 2. 函数清单（逐个，25 个名字 / 565 行；行号为 `4231b03` 现状）

### 队列（19 / 409）

```
queueHasPendingItems(4) · buildDiffQueue(26) · queueCounts(10) · nextPendingQueueIndex(9) · queueDotFor(10)
focusQueueItem(11) · initDiffQueue(10) · renderDiffQueue(63) · renderQueueFooter(10) · adoptQueueCurrent(58)
keepQueueCurrent(34) · previousQueueItem(16) · setQueueOpen(4) · focusQueueBar(4) · stepReviewDiff(24)
applyQueueAckLocally(76) · captureQueueSnapshot(12) · restoreQueueAfterUndo(18) · ackQueueLine(10)
```

状态（9）：`diffQueue` · `queueIndex` · `queueOpen` · `queueDecisions` · `lastQueueDecisionKey` · `queuePageNo` ·
`pendingPageAux` · `queueSnapshot`（局部） · `body.queue-mode`。

### 候选（6 / 156）

```
openCandidateCompare(12) · renderCandidate(14) · fillCandidateColumn(31) · candidateBlockActions(31)
applyCandidateBlock(39) · decideCandidate(29)
```

状态（1）：`candidateRunId`。

### 调用点（删 / 改）

```
loadPageDetail    删 queueHasPendingItems 分支与 pendingPageAux（总是 runPageAux）
renderPageDetail  删 initDiffQueue() 与 candidate-open 的 hidden 写点（:6051）
closePageDetail   删 candidate-panel/candidateRunId 清理（:5581）
reviewAction      删 captureQueueSnapshot / restoreQueueAfterUndo 两处（:8974 / :8983 / :8986）
openTreeItem      删 diffQueue/focusQueueItem 分支（只 openPageDetail）
setupReviewControls 删 3 个队列监听 + 4 个候选监听 + 队列键位（Enter/Space/⌫/←）+ [ ] 快捷键
```

## 3. DOM 清单（index.html 行号，`4231b03`）

```
candidate-panel 块   512–536（25 行；含 candidate-meta/apply/decline/close/current/new）
candidate-open       632（review-more 菜单项）
diff-queue-toggle    616
diff-queue 块        637–655（19 行；含 position/meta/text/dots/note + queue-adopt/keep/prev）
零引用 4 个          485（review-toolbar id 属性）· 509（page-detail-warning 整元素）· 550（review-split id 属性）
                     · 664（layout-info id 属性）
```

## 4. CSS 归属（逐个点名；今晚 ② 片 1 的 `.page-overlay .box` 作用域坑就是没点名的代价）

**跟着删**：

```
.diff-queue …（1633–1665，17 条，含 body.queue-mode .diff-strip）
.diff-queue__top .review-footer-count（751）
.queue-toggle（1619）
.candidate / .candidate__*（1117–1128，12 条）
```

**拆规则**（不能整条删）：`.view--review > .candidate, .view--review > .aux-panel { margin: … }`（700）
→ 只去掉 `.candidate` 那一半，**保留 `.aux-panel`**。

**保留（还有别的使用者，逐个点名）**：

```
.alert--warn         library-warning / selection-hint / structure-note / page-number-empty 还在用
.info-dot            layout-info 元素保留（只删 id）
.workspace-toolbar*  review-toolbar 的 div 与 class 保留
.review-split        class 布局在用
.diff-strip*         块内差异条（blockDivergenceSection）与 reading 视图都在用
.review-footer-count efoot 页脚还在用
```

## 5. 判据（机检 + 变异）

```
① R3 review（新脚本 scripts/r3_review_count.mjs，逐字口径）
   **实测（02213d8）：90 种 / 223 处 → 71 种 / 181 处**
   ⚠ 期望值更正（2026-11-02，原写 68/194 —— 期望错，不是实现错）：
     · **零引用 id 不进 R3 计数**：那 4 个只活在被删的 `id=` 属性里，R3 从未数过它们 ⇒ 种数消失 19，不是 23
       （队列 10 种 + 候选 8 种 + review-footer-count 1 种）
     · 处数 −42 ≠ −29：删掉的函数内部对同一个 id 有多处引用（例如 `detail-canvas` 在一个函数里被取 3 次），
       所以"删 N 个 id"和"少 M 处引用"没有 1:1 关系
     · 以后判这条只看脚本实测（`node scripts/r3_review_count.mjs`），不要按 id 个数反推期望值
```
② 退役 id/状态归零（新闸 deadReviewIdProblems）：
   在 static/*.js + index.html + app.css 里 grep 退役名单：
   diff-queue / queue-adopt / queue-keep / queue-prev / queue-mode / diff-queue-toggle / diff-queue-position
   / diff-queue-meta / diff-queue-text / diff-queue-dots / diff-queue-note
   / candidate-panel / candidate-meta / candidate-apply / candidate-decline / candidate-close
   / candidate-current / candidate-new / candidate-open / candidateRunId / applyQueueAckLocally
   ↑ 每一条都必须是 0；喂坏样本（塞回一句 el("diff-queue")）必须红
   **`queue-mode` 单独再断言一次：app.js / index.html / app.css 各 0 次**（它只由 setQueueOpen 现加现删，
   只删 CSS 不够；test-contract 那笔同时删 :947 的断言）
③ 保留项仍在：.alert--warn / .info-dot / .workspace-toolbar / .review-split / .diff-strip / .review-footer-count
④ 四闸 + audit：node / pytest / accept [0] / registry / audit 会假红 0
⑤ 真机（QA 同一套走查）：页头不再有「差异 N」按钮；块内差异条仍可采纳/保留；⋯ 菜单不再有「对比新结果」；
   「重新识别」仍在；左树点击仍跳页；**reading 的键盘裁决仍可用**（Enter=保留 / Space=采用候选，
   见 reading-view.js:503–516）——否则就是净损失能力，不是删重复
```

## 6. 顺序（三笔，每笔各自绿）

```
1) test-contract（A1，单独一笔，正文写「删的是已退役能力的断言，不是为了让闸变绿」）：
   · **先挪** `assert "function renderReviewHeadline(" in script`（:935）到 `test_review_workspace_v2_is_wired`
     —— renderReviewHeadline 留在核心抽屉，本刀不删；整段删测试会把它一起带走
   · 再删 test_review_diff_queue_is_wired_for_local_adoption 的其余（911–948，含 :947 的 queue-mode 断言）
   · test_workflow_step_shell_is_wired 里 "review-toolbar"（:1051）
   · test_review_workspace_v2_is_wired 里 "review-split"（:1570）
   · test_review_workspace_v2_is_wired 里 loadPageDetail 的 queueHasPendingItems/pendingPageAux/renderDiffQueue 三条（:1553–1562）
2) 产品笔（A2）：HTML 块 + JS 25 函数/状态/调用点 + CSS（§2–§4 一次落）
3) 开闸笔（A3）：deadReviewIdProblems + queue-mode 归零 + 变异；R3 review 脚本进仓库（scripts/r3_review_count.mjs）
```

## 7. 行数预算

```
app.js      25 函数 565 行 + 状态/调用点/键盘   **实测 −683**（12,426 → 11,743；顶层函数 483 → 458）
index.html  **实测 −50**（1,863 → 1,813）
app.css     **实测 −45**（2,818 → 2,773）
R3 review   **实测 90/223 → 71/181**（期望已更正，见 §5①）
```

## 8. 不做什么

```
· 不修队列的显示 bug（删了，不修）
· 不动 reading 的差异队列（它才是跨页连续流的那一份）
· 不删后端 /diff-ack（后端路由有 pytest 覆盖；本刀只删前端调用点，后端另账。块内 adoptLine 走的是 patchBlock 文本编辑，不经它）
· **记 known-limitations**：review 页内差异队列的 `⌫`（保留）/`←`（回上一处）/`[` `]`（跨块跳差异）四个键随删消失；
  Enter/Space 在 reading 仍在（Enter=保留、Space=采用候选），但语义与 review 队列不同
· 不动 pages 的 has_candidate chip（记 known-limitations，另开）
· 不修章节检测（T0 账）
· 不为「以后可能有用」保留候选面板（0 页数据 + 旧副本，旧判决已推翻）
```

## 9. 复现命令

```bash
# 现状读数
node scripts/r3_review_count.mjs --json
grep -n "diff-queue\|candidate-panel\|candidate-open\|candidateRunId" backend/book2text/static/app.js

# 删后对账
node scripts/r3_review_count.mjs --json          # 71 / 181（实测；原期望 68/194 已更正）
grep -rc "diff-queue\|queue-mode\|candidate-panel\|candidateRunId\|applyQueueAckLocally" \
  backend/book2text/static/*.js backend/book2text/static/index.html   # 每条 0
node tests/js/run.mjs
PYTHONPATH="$PWD/backend" .venv/bin/python -m pytest -q
python3 scripts/accept_pages.py --stage 2 --expect-sha cfe695b7
```
