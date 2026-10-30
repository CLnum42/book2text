## 三条后补：PageTile 接线函数（到期判据 = acid 通过）

`buildTile` / `applyTileState` / `capturePageTileMetrics` 归 **刀 2**（证据：刀 1 落盘后
662 个页块仍走 `size=thumb`、`__pageTile` 句柄 0、`writes(size=view)=0`）。

**它们的到期判据不是"函数搬走"，是 `accept_pages --stage 2 --acid` 通过**
（`img.src` 赋值 = 1 / observer ≤ 6 / 三消费者同一张 `img`）。搬走但 acid 不过 = 没到期。

# 刀2–5 可机读名单（函数 → 引用 id → 刀号）

> **函数集合来自 `scripts/r3_pages_count.mjs` 的落盘后实测，不是手工列举。**
> 树：工作区（`app.js` = **14,387 行**，刀 1 已落盘）；口径：`el` / `getElementById` / `querySelector("#")`（与 R3 闸一致）。
> 实测 69 个函数 / 193 处 / 79 种 id。**seed 函数集合 == 脚本 `functions` 并集（逐字相等）**。

## 刀2（8 个函数 / 49 种 id）

> 刀 6 已落盘：本段 7 个宿主的 25 处片段搬进 `pages-view.js`（`wireAll()` 里三段接线 +
> 4 个操作入口），数据行随之删除：`boot` / `setupCollabControls` / `setupLibrary`×4 / `setupShell`。

| 函数 | 引用的 id | 行范围 | 到期刀 | wire |
|---|---|---|---|---|

## 刀3（15 个函数 / 29 种 id）

> 刀 3 已落盘：15 个函数搬进 `pages-view.js`（470 行），本段数据行随之删除；
> 两侧数（seed 函数名 / 实测函数并集）= 65 → 50，见 `knife3-plan.md` §⑪。

| 函数 | 引用的 id | 行范围 | 到期刀 | wire |
|---|---|---|---|---|

## 刀4（12 个函数 / 31 种 id）

> 刀 4 已落盘：8 个函数搬进 `pages-view.js`（236 行）；applyPackageMode / applyProjectSettings /
> applySplitBatch / recognizePage 移出本刀（见 knife-review / knife-package 两刀占位）。

| 函数 | 引用的 id | 行范围 | 到期刀 | wire |
|---|---|---|---|---|
| `applyPackageMode` | `assign-list-toggle`、`assign-open`、`check-pending`、`page-setup-bar`、`panel-pagenum-settings`、`panel-recognition-settings`、`selection-actionbar`、`selection-check`、`selection-recognize`、`selection-skip-checked`、`setup-panel` | 13301–13360（61 行） | 刀8 |  |
| `applyProjectSettings` | `auto-apply-suggestions`、`rec-margin-judgement` | 12597–12606（11 行） | 刀8 |  |
| `applySplitBatch` | `selection-hint` | 12974–13007（35 行） | 刀8 |  |

## 刀5（34 个函数 / 49 种 id）

> 刀 6 已落盘：本段 3 个宿主的 4 处片段搬进 `pages-view.js` 的 3 个操作入口
> （`showPagesError` / `setMarginJudgementCheckbox` / `pagesErrorMessage`），数据行随之删除。

| 函数 | 引用的 id | 行范围 | 到期刀 | wire |
|---|---|---|---|---|

## 不在 seed 里的 37 种（宽口径，另纸，不参与判据）

我第一版按宽口径（任一字面量/值传递）数出 116 种；按裁决**只认闸口径的 79 种**。
差出来的那些**不进 seed**——混在一起会让集合差重新出现。若其中有必须现在处理的，单列一张纸给 Chief。
