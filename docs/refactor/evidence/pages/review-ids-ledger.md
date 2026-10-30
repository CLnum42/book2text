# review 视图的 id 账（为什么它「不计入 pages 的 R3」）

> **量于 `743f5bc`**（`app.js` = 13,465 行，最后一次改动是 `f9e595a`；
> `index.html` 同树。本文件之后的两笔只动 `tests/js`，不影响下面的数）。
> 口径：
> - 「处数」= `app.js` 里**含该 id 的行**数，一行里出现两次算一处；
> - 「宿主」= 该行所属的**顶层函数**（按 `^(async )?function name(` 划区间，顶层代码单独一档）；
> - 「住在哪个 section」= 按 `index.html` 的 `<section ... id="view-X">` 区间判定。

## ① `page-detail-error`：23 处 / 15 个宿主

| 宿主 | 处数 |
|---|---|
| `runAuxiliary` | 3 |
| `openCandidateCompare` / `applyCandidateBlock` / `createBlockFromBox` / `decideCandidate` / `reviewAction` / `confirmCurrentPage` | 各 2 |
| `recognizePage` / `openPageDetail` / `loadPageDetail` / `confirmPageLayout` / `structureAction` / `recognizeBoxRegion` / `ensureReviewTree` / `undoAutoApply` | 各 1 |

合计 **23 处**，分属 **15 个函数**。它住在 `view-review`（`index.html:483` 起的那段，元素在 `:508`）。

## ② `view-review` 的整体体量：93 个 id / 89 个被引用 / 267 处

| view | section 里的 id | 被 `app.js` 引用 | 处数 |
|---|---|---|---|
| **review** | **93** | **89** | **267** |
| pages | 124 | 30 | 69 |
| index | 23 | 1 | 3 |
| library | 8 | 0 | 0 |

review 里最重的几个（同一口径）：`review-tree` 18、`detail-blocks` 16、`diff-queue` 12、`detail-image` 10、
`viewer-scroll` / `detail-canvas` / `detail-overlay` / `box-select-text` 各 7、`toggle-overlay` /
`review-margin-toggle` 各 6。

这就是「review 视图是下一座山」的量化依据：**被 app.js 引用的 id 数与处数都比 pages 大一个量级**
（89/267 vs 30/69），而它还没有自己的模块。

## ③ 边界：这些**不计入** pages 的 R3

R3 只数 `#view-pages` 子树的 id。`page-detail-error` 是 `view-review` 的 id，
所以它在 `app.js` 里的 22 处**不进 pages 的 R3**——`recognizePage` 那 1 处虽然写在 pages 的 mover 里，
也一样不占 pages 的 R3 额度。

pages 的 R3 归零靠两刀：**刀 7 的 `recognizePage`（2 处 `pages-error`）+ 刀 8 的 23 处**
（`applyPackageMode` 20 / `applyProjectSettings` 2 / `applySplitBatch` 1）。剩下那 22 处是 review 视图自己的债，
要等 review 那一刀（登记表里的 `n: 7`「knife-review」只是它的入口）。

## 附：这不是「范围错了」，是「验收判据写错了」

`docs/refactor/pages/knife-review-plan.md` 的验收判据写的是
「`app.js` 里 `page-detail-error` 引用 = 0（现在 1 处）」——实测是 **23 处**，
而且**在写计划的那棵树（`dce41b8`）上也是 23 处**：当时数的是 `recognizePage` 内的那一处，不是全文件的。
搬走 `recognizePage` 只会让 23 → 22，这条判据永远达不到。

行号也漂了：计划的 `recognizePage 5588–5636` → 实测 `4962–5010`（右移 626 行，49 行不变）；
函数体内 `el()` 引用是 **3 处**（`pages-error`×2 + `page-detail-error`×1），计划写 2。
