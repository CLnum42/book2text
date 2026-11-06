# review-cat 边界契约（正文审校页 v3，2026-11-06）

> 依据：`docs/ux/review-cat-list-v3.md`（已冻结）+ `docs/ux/HANDOFF-ux-v3-devlead.md` §已落。
> 只写边界与判据，不写实现。前置契约：`docs/refactor/review-focus-boundary.md`（`eb96fd3`，本契约取代其 §1/§4 的模块数）。

## 1. 视图归属：改造 **#view-reading**，不新增 section

```
不是 #view-review，也不是 #view-review-cat。
证据：设计稿的落点全是 reading-view.js 的函数——openReadingPanel(108 行)/renderReadingProgress(27)/
      renderReadingTree（HANDOFF:19–21）；#view-review 是"页面详情屏"（72 个 id：viewer / detail-blocks /
      aux / box-select），SECTION_OWNERS 已有 4 个 owner，不在这张设计里。
理由：一个"审校屏"只能有一个 section——两个同名视图 = 两套状态、两套 id 归属、两次切换。
现文件分工（#view-reading）：reading-view.js = 唯一 DOM owner；app.js = boot 注入，**对该 section 的 id 字面量 0**
（R3 已锁）；本刀新增两个模块，**只拿新 id 子集**，旧 id 仍归 reading-view。
落点已确认为 #view-reading（不是待定）：设计稿与 HANDOFF 的落点函数全在 reading-view.js；#view-review 不在本次设计内。
SECTION_OWNERS 走两阶段（阶段一不建表项、阶段二建），见 §6——现在加表项会撞 S1 的 `length == 4`。
```

## 2. 模块切分：2 个模块 + 1 个共享纯渲染器

```
review-cat-list.js  window.ReviewCatList
  职责：上方列表 = 序号列 + 单行裁图 + 状态列 + 正文列（一行一差异）；只读投影 + 行级导航事件。
review-focus.js     window.ReviewFocus
  职责：下方 5 行上下文（左裁图 + 右正文）+ 三档取景 + 逐处导航 + 判定 + 手改。
  **三档取景与逐处导航只许有一份**（在 focus 里）；列表只发"我点了第 N 行"，不许另写一遍取景。
单行裁图 renderCrop(bbox, zone) → Element
  放 review-focus.js 里导出；列表经**外壳注入**拿到（#18 不许直呼）。不单开第三个文件：
  它无状态、无生命周期，第二个消费者通过注入复用，不是复制。出现第三个消费者或需要自身生命周期时再抽。

**init 签名（元素由外壳查好传进来，模块不拿 root 自查）**：

```
ReviewCatList.init({ listEl, counterEl, renderCrop, onSelect, onNavigate })   // 无 pull 键
  外壳另注入给 reading-view：publishCat({ listEl, counterEl, rows, total, currentIndex })
  → 首次收到：ReviewCatList.init(...) + setQueue(payload)；之后：setQueue(payload)
ReviewFocus.init({ panelEl, contextEl, cropHostEl, renderCrop, onVerdict, onManualEdit })
  选中项由外壳 push：ReviewFocus.show(item)（item 来自 setQueue 的 rows，不回调模块去取）
判据：两个模块源码里 el( / getElementById( / querySelector( / querySelectorAll( 各 0 次
     —— 域模块闸（刀 A 口径）对 querySelector 与 querySelectorAll 一视同仁，都算"按结构找 DOM"。
     要新增节点就在传入的元素里 createElement / append，不回头查树。
**为什么是 push 不是 pull**：队列住在 reading-view 内部（`readingMarks` / `readingEntries`，48–49 行）。
pull 版需要 `ReadingView.getQueue()` = 第二个新导出，会再顶一次 5→6 的棘轮（那一次已签给 `selectEntry`）。
push 版走既有模式：模块调外壳注入的回调（先例 `injected.onPunctGroups?.()`，3918 行），不新增导出。
```

## 3. 数据流（谁缓存、键、窗口）

```
队列        沿用 reading-view 现有的 marks 队列（按页窗口 ±10 加载，reading-view:50）。
            **push 模型**：reading-view 在每个刷新点调 `injected.publishCat({ listEl, counterEl, rows, total, currentIndex })`；
            外壳首次 init、之后 setQueue；模块不拉、不存第二份。
            分母用队列数（1,623），不拼 diff_status 的 2,134（design §109 已定）。
页级 runs   GET /api/projects/{id}/review/line-runs?page=N（23fb254）。
            **缓存归外壳**（唯一 owner），键 = `${project_id}:${page}`，窗口 = 当前页 ±1，
            LRU 上限 8 页；两个模块都不许自存第二份（#7）。
取景 bbox   runs 每条自带的 anchor_bbox；focus 的 5 行上下文用同一页 runs，不另发请求。
```

## 4. 写路径与"真相只有一份"

```
采用候选   POST /pages/{page_no}/runs/{run_id}/apply-block（路由已有）。
手改       行级编辑进**草稿**（readingDrafts + POST /review/submit-drafts），不即时写库。
ack        复用 draftReading(entry, kind, text) 的语义：kind = adopted | kept。
撤销       逐条 = 撤该条草稿；批量 = 既有 undo 路径，不新造。
真相       block_line.text 是唯一真相，草稿 Map 归外壳；模块只读显示，写一律回调外壳。
           **采纳/手改之后必须读回再重画**（HANDOFF §8 已记：采纳候选不同步 block_line.text）
           —— 不许用内存里的 candidate 直接替换显示。
```

## 5. 删除面与行数账（可复算）

```
app.js            **不减**（只减 1 行注入键）：computeCharSpans(3554) 本刀**不删**——它还有 4 个消费者：
                  壳内 3 处（3544 / 3624 / 3690 的 marks 摘要）· page-detail-editor 2 处 · review-tree 1 处。
                  它是"两段文本 → 字符 span"的通用工具；审校屏换 runs ≠ 它作废。
                  到期点：editor / 队列树的摘要也改读后端 spans 的那一刀（源码注释 2885–2887 已写
                  "将来 line_diff 落地后删掉前端 LCS，不允许两套口径并存"）。
                  **本文件取代 eb96fd3 §2 的"删除 computeCharSpans −58"**：那条的前提（runs 覆盖全部消费者）不成立。
reading-view.js  −202   readingDiffUnits(51) + openReadingPanel(108) + closeReadingPanel(12)
                        + retryReadingPendingPanel(18) + settlePanel(13)
                 另 −1：init deps 里的 computeCharSpans（3 处调用改读 runs 的 spans）
                 保留：paintReadingDiffBoxes(44，页面级色块，改读 runs) · renderReadingProgress(+Extras，改文案)
新增两文件：**预期 ≈300 行 / 上限 350 行**（review-cat-list.js · review-focus.js）；超上限必须在提交正文说明超出部分
判据：reading-view 净减 ≥200；**app.js 允许持平**（但必须在正文写"computeCharSpans 保留"的消费者证据）；
      "新文件 + 老的没动" ⇒ 判失败；reading-view 里 injected.computeCharSpans 出现次数 = 0；
      app.js 对 #view-reading 的 id 字面量仍 = 0（R3）。
```

## 6. 登记（三处，逐项说动几行）

```
OWNERS（boundary:2810）           不动。它管顶层状态归属；本刀不搬状态。
SECTION_OWNERS（boundary:5951）   **两阶段**（S1 判据今天只覆盖 #view-review，且有硬断言 length == 4）：
                                  阶段一（本刀，正在施工）**不建** `#view-reading` 表项。新增 id 只归 reading-view 用；
                                    app.js 对这些 id 的引用 = 0（R3 现成判据，仍然成立）。
                                  阶段二（LIST / FOCUS 落地那一笔）**建**表项（READING / LIST / FOCUS 三 owner），
                                    同一刀把 S1 从「一个 section」扩成「两张 section 表」，
                                    `length == 4` 的断言按表数重写（测试侧改动：TestDev 出，Architect 签）。
                                    id 名单从 index.html 派生；判据 = 三 owner 并集 == 该 section 被引用 id 全集，交集为空。
ALLOW_QUERY_SELECTOR_WHITELIST    **不动（0 行）**：两个模块的元素由 init 注入，不用 querySelector。
                                  闸口径比本契约严：querySelector 与 querySelectorAll 都算"按结构找 DOM"
                                  （刀 A 实测红：review-cat-list.js 里 2 次 .querySelector( 即被拦）。
```

## 6.1 `selectEntry` 签字（2026-11-06）

```
STABLE += "selectEntry"    // callers: app.js 的 onSelect；死亡条件：右侧正文面板将来并入 focus 时随面板死
MAX_EXPORTS 5 → 6          // 只属于 reading-view 这块测试；pages 等的上限在另一张表
落地**一笔**：产品与 STABLE 同笔（依据 R12 A1b 只拦"删除 tests/js 行"，新增行不拦）。
不需要放宽笔、不需要 Temp-Relax、不需要 Bypass-Reason——写上反而会让人以为默认要绕闸。
（TEMPORARY 走不通：它的判据是"已存在、等到期才死"，键还没写时放进 TEMPORARY 当场红。）
```

## 7. 依赖方向与硬约束

```
单向：外壳 boot → init({ root, …deps }) → 两个模块。模块不许 window.X 直呼别的模块（#18）、
     不许反向调 review-tree、不许自存队列或 runs、不许写对方 root 里的 id（#6）。
状态：队列 + 当前位置 + 草稿 = 外壳唯一所有；两个模块是纯投影，状态变由外壳调 show()/setRows()。
事件：列表点击 → 外壳 → focus.show(item)；判定/手改 → focus 回调 → 外壳写盘 → 读回 → 两边重画。
```

## 8. 终态判据（验收时逐条打勾）

```
① 契约入库（本文件）+ 实现提交正文点名"适用第 1–7 条"
② 行数账按 §5 复算：**app.js −1**（只减 init deps 里的 computeCharSpans 注入键；本文件取代 `eb96fd3` §2 的 −58）· reading-view −202；新增两文件落账（预期 ≈300 / 上限 350）
③ reading-view 净减 ≥200（#19 类）；app.js 允许持平但正文要写 computeCharSpans 的 4 个消费者证据
④ 四闸 + node/pytest 绿；SECTION_OWNERS 新项的三向对集绿；白名单 +2 行的理由在场
⑤ 真机三态色（红未判 / 黄待提交 / 绿已确认；绿+底纹=改过、绿无痕=保留）+ 行级编辑不丢字
⑥ 队列分母 = 1,623；顶栏"当前第 N / 1623"与列表行数同源
```
