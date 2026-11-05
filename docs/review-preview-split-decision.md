# 审校页 / 预览页拆分：决议稿（v2）

- 日期：2026-11-05 / 更新 2026-11-06
- 状态：**方案已齐，待用户点头进施工**；未改产品代码。
- 本文只收「已定的」与「要拍板的」，细节看三份详稿：
  `docs/pm/review-preview-split.md` · `docs/arch/review-preview-split.md` · `docs/ux/review-preview-split.md`；
  审校列表另见 `docs/pm/review-cat-list.md`、`docs/ux/review-cat-list-v3.md`。

---

## 1. 一句话

审校页只回答「这处差异留哪个」，预览导出页只回答「成品还要改哪里」。这不是把一屏切成两屏，而是把**人工审核（阶段 9）**和**组装 / 预览 / 导出（阶段 10–11）**分开——两者的完成判据本来就不同。

分界线按「谁负责发现」切：机器指得出的疑点归审校页；机器指不出的错（两路一致但都错、段落合并、标点归一误伤、断词）归预览页。**能力可以重叠，责任不重叠。**

---

## 2. 两页边界

| | 审校页（第 5 步 → `#view-reading`） | 预览导出页（第 6 步 → `#view-preview`） |
|---|---|---|
| 唯一目的 | 把机器标出的每一处判完，让「还剩多少」能对齐 | 以读者方式通读成品、改错、确认要交的东西 |
| 左栏 | 全书差异目录（汉字级逐条 + 标点汇总入口） | 书籍目录（章节） |
| 中栏 | 当前页 PDF，只标差异字（不填色、不压字） | 当前页 PDF 原文 |
| 右栏 | 当前差异 A/B 两版，一屏一条（并排两按钮） | 组装后的干净文本，点字改这一行 |
| 完成度 | 进 k/6（队列归零） | **不进完成态**（D-090） |
| 数据 | `next-lines` + `marks?page` + 页图 | `segments`（唯一成品来源）+ 页图 |

---

## 3. 已定技术口径（每条能指到代码）

1. **不建成品版本表。** `Segment` 导出时推导（`core/export/segments.py:178`），`segment_id` = 首块 `block_id`（`:138`），合并/拆分就变；一存就与导出发叉（D-106）。
2. **预览页编辑是行级。** 点到的字落在哪个 `line_span` 就改哪一行；跨行走 `merge-prev` / `split` / `continues_to_next`；合并插入的空格、断词删掉的连字符只读（实测 43 字 / span 41 / 派生 2）。
3. **写文本只有一条路：`submit-drafts`。** 唯一同时写 `block.text` 并 `sync_line_text` 的入口（`routes_review.py:656–666`）。`PATCH /blocks` 只许用于 `block_type` / `include` / `continues_to_next`，**不许改字**（不改行记录）。
4. **手改 = 写 `edited`。** 三值 `kept` / `adopted` / `edited`；`kept` 带文本静默丢弃（`editing.py:877/904`）要改成 400。判据：改完 `block.text` 变 + `block_line.text` 同步 + `diff_ack=edited` 且 `diff_ack_text` = 新文本。
5. **编辑必须先提交（2026-11-05 用户定）。** 两页都是「草稿 → 确认 → 写库」；待提交是页面内存态，刷新即丢（`beforeunload` 拦一次）；**有未提交时导出置灰**，保证「导出的版本 = 预览的版本」。上一版「预览页即写即存」作废。
6. **审校页不读 `segments`。** 队列 `next-lines`、差异 `marks?page`、页图自取；成品只剩预览页一个消费者，前端 `/export/preview` 字面量 2 处 → 1 处（R14 棘轮，例外表只降不升）。
7. **Jev 分数加在 `next-lines` items**（`include_scores=1`，默认关，实测 ~7 ms / +20 KB），不加 marks；排序仍是 `(tier, 阅读顺序)`，只改文案。
8. **失效链**：写库 → mtime → 签名变；忙时缓存 10 秒（`cache_policy.py:29`），写后必须清该项目 preview 缓存。
9. **步骤条 6 步不改**：第 5 步「正文审校」→ `#view-reading`；第 6 步从「文件导出」改名「**预览导出**」→ `#view-preview`，组装/通读/改/提交/预检/导出都在这一页；老 `#export-panel` 的 compare 退役。**不设「预览完成」**，第 6 步普通态，不进 k/6。
10. **队列外条目不进分母**：版心外 47 处（审计项目）在目录底部一行「不进审校与完成度」，点开去页面面板的版心外筛选；其他类型（图注/脚注）差异 6 条不进目录。不为此加接口。

---

## 4. 施工前置：采纳候选后行文本不同步（已实测）

`ack_diff_line` 的 `adopted` 分支只写 `block.text` + `diff_ack`，**不写 `block_line.text`**；`resync_lines` 只在撤销/重做后跑。后果：**显示文字不错**（走 `block.text`/segments），错的是**差异框**——`reading-view.js:3893` 用行记录算差异区间，采纳后会在旧文本上画框；页码噪声判据也读行记录。

修法（DevLead 定，二选一）：① adopted 分支就地 `UPDATE block_line SET text` + 记行级事件（同一事务）；② 提交后跑 `resync_lines(project_id, [block_id])`。**别把 `sync_line_text` 嵌进 `ack_diff_line`**（独立连接、自己 commit，会锁库）。

判据：采纳一行后 `block_line.text` 与 `block.text` 该行逐字相同（脚本见 arch 文档 §8.1，当前打印 `False`）。这条必须排在**新审校页动工之前**——列表的字级标记依赖它。

---

## 5. 验收判据（能机检的）

| 判据 | 怎么查 |
|---|---|
| 预览 = 导出 | 同 options 下 `export/preview` 与导出的 `segment_id`/`text` 逐条相等 |
| 改一行三件事 | 块文本变 / 行文本同步 / `diff_ack=edited` 且 `diff_ack_text`=新文本 |
| 采纳后行文本一致 | 上面 §4 的脚本，`逐字相同 = True` |
| `kept` 带文本不再静默丢弃 | 接口回 400，不是 200 + 文本没改 |
| 成品单一入口 | `/export/preview` 调用点 ⊆ 例外表，只降不升 |
| 没有第二份成品 | `migrations/` 无 segment 覆盖表；`grep -rn "segment_override" backend/` 为空 |
| 有未提交不能导出 | 草稿非空时导出按钮 disabled，写明「先提交 N 处」 |
| 排完不回队列 | 改行文本 + `ack=edited` → 该行退出 `next-lines`（现状必红） |

---

## 6. 未实测 / 待核

- **色觉障碍**下红/黄/绿的可分性：只按 WCAG 对比度核了（红 4.83、黄 `#a16207` 4.92、绿 `#15803d` 5.02），模拟值用了红绿色盲矩阵，未做真人测试。
- 真人 22px 辨字、虚拟滚动与页图共用的真实请求数：未实测。
- 1747 / 3031 / 20.5 三个数：仍标「待核」。
- Jev「前 50 条命中率 68% → 76%」：方案里的数，本轮未复测；只有产品接受「允许判前 N 条就停」才值得改排序。
- 版心外 47 是 PM 审计项目读数、45 是开发副本读数；真项目分母以 `queue_items()` 为准。
