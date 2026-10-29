# `review` 归属调查（2026-10-29）

## 0. 抬头状态（`sh scripts/status.sh` 原样）

```
HEAD        2a23b50
origin/main 65b22cb
ahead 2 / behind 0 / 工作区 脏（1 个已跟踪改动 / 1 个未跟踪）
---
app.js               16,161
index-view.js         1,195
preview-view.js         997
reading-view.js       3,320
---
闸：绕过 0 次（BYPASS 0 / BYPASS-WITH-REASON 0）
    重写 6 次（REWRITE，不计入绕过；最近一次 2026-10-29 10:48:53）
    最近一次 pre-push pytest：PASS 1002
```

## 0.1 口径声明（今晚修过的版本）

1. **种子不含外壳根**：`boot` / `setupShell` / `setupLibrary` 一律剔除。
2. **闭包用引用图，不用调用图**：函数名出现在非定义位置即算一条边，**后面跟不跟 `(` 都算**
   （`addEventListener("click", fn)`、`requestAnimationFrame(fn)` 这类“作为值传出去”的引用，
   调用图会整类漏掉）。**归属用超集，验证用子集。**
3. **“要注入”报三个数**：函数数 + 调用边数 + 行数。
4. id 段：`index.html` 的 `id="view-review"` section（第 **485–697** 行）。

## 1. 四栏表

| 项 | 数 |
|---|---:|
| `view-review` 段内 id | **94** |
| 种子（碰这些 id 的顶层函数，已剔外壳根） | **70 个 / 2,110 行** |
| 引用图闭包 | **176 个 / 4,336 行** |
| 闭包总行数 | **4,336** |

| 栏 | 函数 | 行数 | 占闭包 |
|---|---:|---:|---:|
| **能搬**（碰的 id 全在 review 段内） | **106** | **2,585** | 59.6% |
| ├ 其中跨视图、需注入 | 32 | 813 | 18.7% |
| **要留**（外壳拥有） | **17** | **484** | 11.2% |
| **要注入**（接缝：闭包外还有引用者） | **65** | **914** | 边数 **226** |
| **不属于 review**（碰的 id 全在别的段） | **17** | **420** | 9.7% |
| 未判定（无 id、引用者跨两类） | 4 | 34 | 0.8% |

**要留（17 个 / 484 行）**：`renderReviewTree(177) openOrthographyPanel(72) showView(62) confirmCurrentPage(26) loadReviewTreeItems(21) openTreeItem(20) treeItemSummary(16) setupReviewPager(15) finishShowFallbackPages(14) openPageDetail(13) toggleReviewTreeChapter(9) toggleReviewTreePage(8) nextUnfinishedPage(8) stepPage(7) finishStartReview(7) treeLevelLabel(5) treeChapterOfPage(4)`

> 注：`renderReviewTree` / `toggleReviewTree*` / `treeItem*` 被归到“要留”是因为它们写 `workflowStep`/`confirmCurrentPage` 这类外壳状态，**不是因为它们属于外壳**——这一栏要在切片时逐条复核（见 §4 风险 1）。

**不属于 review（17 个 / 420 行）**：`finishRunAutoPass(91) finishRunLayout(77) revertContinuation(41) markContinuation(40) onContinuationKeydown(27) loadContinuationReview(23) finishRevokeAutoPass(22) undoLastCleanup(21) loadLanguageSummary(19) afterCleanupApplied(13) advanceContinuation(12) openFinishPanel(11) pausePageThumbnails(8) afterContinuationChange(5) continuationRemaining(5) closeFinishPanel(4) renderContinuationPanel(1)`

> 这 17 个是**真正的其它流程**：续页确认（continuation）、收尾面板（finish）、自动通过（auto-pass）、清理撤销（cleanup）。
> 它们只因“碰了 review 段的某个 id / 被 review 的渲染函数引用”被吸进闭包。

## 2. 子面板分布（能搬 106 个，按 `data-` 前缀）

`view-review` 段 id 前缀分布：`review 29 / detail 12 / box 8 / candidate 8 / diff 7 / aux 6 / layout 4 / page 4 / ink 3 / queue 3 / zoom 3 / toggle 2`，其余各 1。

| 前缀组 | 函数 | 行数 |
|---|---:|---:|
| （无 id，纯工具/辅助） | 45 | **1,128** |
| 跨前缀（一个函数碰多组） | 16 | 507 |
| `detail-*` 详情面板 | 14 | 346 |
| `review-*` 审校主体 | 11 | 225 |
| `page-*` | 7 | 178 |
| `aux-*` 第二引擎 | 2 | 57 |
| `box-*` 块框 | 4 | 56 |
| `layout-*` | 1 | 23 |
| `suggestion-*` | 1 | 21 |
| `ink-*` / `candidate-*` | 1 / 1 | 14 / 14 |
| `viewer-*` / `diff-*` | 2 / 1 | 12 / 4 |

**45 个 / 1,128 行没有 id**——审校页的“粘合剂”比 pages（42 个 / 494 行）大一倍多，说明 review 的渲染函数大量依赖共享工具。

## 3. 结论：1 个模块还是 N 个？

**建议 1 个 review 模块 + 2 个流程归位，不是 N 个子模块。**

依据：

1. **子面板不独立**：`detail`(346) / `review`(225) / `page`(178) / `box`(56) / `candidate`(14) 加起来才 ~820 行，
   而**无 id 的共享工具就有 1,128 行**——按子面板切会让 45 个工具函数被 5 个模块各注入一份，
   直接重演 D-109 说的“40 个注入点”。
2. **接缝面 226 条边**（对比 pages 183、L1 的 24）：如此宽的注入面说明这些工具是**同一个渲染管线的内部件**，
   不是“两个模块共用两个服务”。
3. **真正该出去的是那 17 个 / 420 行**（续页、收尾、自动通过、清理）——它们是**独立流程**，
   有各自的入口和状态，不该跟审校详情挤在一个模块。

## 4. `review` 和 `pages` 是不是同一种病？

**是“一屏多子步骤”，但不是同一种解法。**

| | pages | review |
|---|---|---|
| 子面板 | 5 个（版心/识别/版面/选择/页砖），**都在 section 内** | 审校详情/候选/差异/树/队列，**也在 section 内** |
| 无 id 的共享工具 | 42 个 / 494 行 | **45 个 / 1,128 行** |
| “不属于” | 9 个 / 179 行（5.6%）= 预览/任务包 | **17 个 / 420 行（9.7%）= 续页/收尾/自动通过/清理** |
| 接缝 | 66 函数 / 183 边 / 817 行 | **65 函数 / 226 边 / 914 行** |
| 切法 | 5 个子模块（各 100–310 行）可行 | **不行**：共享工具占 26%，切了就是 5 份注入 |

一句话：**pages 的病在“子面板多但各自独立”，review 的病在“一个渲染管线的工具层太厚 + 4 个外部流程被吸进来”。**
所以 `pages` 的“按子面板切”**不能直接复用**；review 应该切出 2 刀：① 把 420 行的续页/收尾流程归位；
② 剩下的审校详情作为一个模块（含它那 1,128 行工具），不再按前缀细分。

## 5. 风险（逐条）

1. **“要留”里 8 个树函数可能误判**：`renderReviewTree(177)` 等是因为写 `workflowStep` 被规则归入“要留”，
   但它们显然是审校 UI。切片前要逐条看：写 `workflowStep` 是“外壳状态”还是“审校页自己的步骤高亮”，
   后者应归“能搬 + 注入 setter”。
2. **闭包用引用图会包含“只是被传出去”的函数**（如 `pausePageThumbnails(8)` 被 review 传给 rAF）——
   这些在“不属于”里可能是过度包含，切片时按引用点复核。
3. **226 条边**里超过 30 条来自少数几个工具（详情见 `docs/refactor/pages-attribution.md` 同型表），
   切片时要先按“边数”排序，而不是按行数——**行数看工作量，边数看风险**。

## 6. 可复现命令

```bash
# 1) 段内 id 数
awk 'NR>=485 && NR<=697' backend/book2text/static/index.html | grep -oE 'id="[^"]+"' | sort -u | wc -l   # → 94

# 2) 归属重算（引用图 + 剔外壳根；脚本见本次提交前的 /tmp/attr_review.py，逻辑同下）
#    - 顶层函数：^(async )?function NAME(
#    - 引用边：函数体里出现任意顶层函数名（不要求后跟 "("）
#    - 闭包：被调函数在闭包外无引用者才纳入
#    - 四栏判据：id 全在 review 段 / 写外壳状态 / id 全在外段 / 接缝

# 3) 闸状态
sh scripts/status.sh
```
