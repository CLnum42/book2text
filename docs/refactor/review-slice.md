# `review` 切片计划（2026-10-29，DevLead）

> 来源：`docs/refactor/review-attribution.md`（Builder 的归属调查，闭包 = 176 函数 / 4,336 行）。
> 本文件只定**边界、顺序、判据**；名单以 `review-attribution.md` §1 的四栏表为准。
> 基线：`dd835c4`（merge 已推）。

## 1. 两刀边界（Chief 定）

### 第一刀：17 个函数 / 420 行「外部流程」归位

名单（`review-attribution.md` §1，按函数名定位，不按行号）：

```
finishRunAutoPass(91) finishRunLayout(77) revertContinuation(41) markContinuation(40)
onContinuationKeydown(27) loadContinuationReview(23) finishRevokeAutoPass(22)
undoLastCleanup(21) loadLanguageSummary(19) afterCleanupApplied(13) advanceContinuation(12)
openFinishPanel(11) pausePageThumbnails(8) afterContinuationChange(5) continuationRemaining(5)
closeFinishPanel(4) renderContinuationPanel(1)
```

**归位 = `app.js` 内 relocation**（本刀的选择，理由见 §3）：把它们从审校块所在区间挪到各自流程
（续页 / 收尾 / 自动通过 / 清理撤销）的代码区，**不改一行逻辑、不新增导出、不新增注入**。

**判据**：函数名逐个 `grep -c` 结果不变（仍是 1 处）；`app.js` 行数**不变**；三套测试（node / pytest / 验收脚本）全绿；
`git diff` 里除位置与空行外零差异（`git show -M` 按重命名/移动核对）。

### 第二刀：106 个函数 / 2,585 行 → `review-view.js`（一个模块，不按 id 前缀细分）

口径 = 能搬 113 / 2,825 **减去树 7 函数 / 240 行**（`renderReviewTree`/`loadReviewTreeItems`/
`treeItemSummary`/`toggleReviewTreeChapter`/`toggleReviewTreePage`/`treeLevelLabel`/`treeChapterOfPage`），
树单独一刀（Chief 2026-10-29 定：先不动树）。

**判据**：`accept_review.py` exit 0（TestDev 出）+ 一笔 `move(review):` + 推送。
减量门槛按真归属算，不沿用 250 / 520（见 §4）。

## 2. 与「拆模块」纪律的关系

- 第二刀是 **§22.6 级巨提交**（>2,500 行）：逐字节全量、账对上、完整验收后再提交；
- 接缝 **65 函数 / 226 边 / 914 行**是这刀的主要风险，按**边数**排序复核，不按行数；
- 树 7 函数与第一刀的 17 个都不许混进第二刀（混进去 = 边界失守，回退重切）。

## 3. 第一刀为什么选「app.js 内 relocation」而不是新模块

1. 这 17 个是 shell 流程（续页/收尾/自动通过/清理），**没有自己的 `<section>`**，做模块就要一个新的
   导出面 + 新的注入表——R8 要签字，且与第二刀的注入表会缠在一起；
2. relocation 是零行为改动、可单独回退的一刀，先做它能把审校块的「区间」清干净，第二刀按闭包收集时
   自然不再吸进这 17 个；
3. 如果以后要给它们做模块（按 §21 判据），那是独立的一刀，不与本次两刀混。

**待确认（一句就行）**：若 Chief 要的是「17 个搬进独立模块」而不是 relocation，本刀改法完全不同
（要新增导出面 + 注入表），而且和 R8 的分母一起动。

## 4. 门槛（第二刀，落地前按实测重算）

第二刀搬走 2,585 行，`review-view.js` 预计 ~2,700 行（含骨架/注入）。`app.js` 净减门槛先按 **≥ 2,400**
（≈92.8%）——低于它说明有函数没搬（复制不是搬）；高于 2,650 说明顺手删了别的。**最终数在 cut 2 干跑后写死**。

## 5. 风险（来自 `review-attribution.md` §5，逐条要复核）

1. 树 8 函数里 `openTreeItem` 归外壳、7 个归模块——本次先不搬树，**不阻塞**；
2. 闭包用引用图会包含「只是被传出去」的函数（`pausePageThumbnails` 就在第一刀里）：第一刀 relocation 时
   按引用点复核，确实不属于流程的**退回**并记录；
3. 226 条边里 >30 条来自少数工具：cut 2 干跑先输出「函数 → 边数」排序，再决定注入表的形状；
4. 第一刀若发现某函数其实该跟审校模块走（例如 `renderContinuationPanel` 只有 review 引用），
   **不移**，并在本文件记录理由——边界以引用为准，不以「看起来像流程」为准。
