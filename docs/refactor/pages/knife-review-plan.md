# knife-review 施工图（占位）：把 review 入口从 pages 的跨视图写法里摘出来（**刀 7**）

> 刀号见 `docs/refactor/pages/knife-numbering.md`（旧记法「刀 6」= 本刀；刀号真值源是
> `tests/js/knife-registry.mjs`）。

> **状态**：占位（Architect 2026-10-30 裁定"两刀，review 先、package 后"）。**未做实测设计**：
> 行范围与 refs 是当前树的只读量数，函数体怎么切、review 模块要开哪些具名入口，要等本刀开工前再出图。
> 名字按**碰的视图**取，不叫「pages 刀 4.5」。

## 为什么有这一刀

刀 4 的名单从 12 缩到 8，被推迟的 4 个里有 4 处写点落在 **view-review** 子树（用闸自己的
`parseViewSections` 量，只认 `<section id="view-*">`）：

```
finish-open-review ×2   （在 applyPackageMode 体内）
detail-recognize        （在 applyPackageMode 体内）
aux-run                 （在 applyPackageMode 体内）
page-detail-error       （在 recognizePage 体内）
```

R3 模块侧**零豁免**：`*-view.js` 只许引用自己 view section 的 id。所以这些写点既不能跟着
pages 走，也不能跟着 package 走——它们要么归 review 模块，要么改成调 review 的**具名入口**。

## 范围（实测于 `main@a5dd595`，刀 6 落盘之后）

| 项 | 数据 |
|---|---|
| `recognizePage` | **4965–5013（49 行）**，函数体内 `el(` **3 处**：4987 `pages-error`、5007 `page-detail-error`、5008 `pages-error`（即 `pages-error` 2 处 + `page-detail-error` 1 处） |
| 调用点 | `app.js:3394`、`app.js:11657`（仍在外壳，所以本刀要给 pages 模块 +1 个导出键） |
| `applyPackageMode` 的 3 处 review 写点 | `finish-open-review`×2、`detail-recognize`、`aux-run` —— **属 package 那一刀**，本刀只负责**先把 review 的入口做出来** |

> 行号每刀都要重量（刀 6 之后 app.js 13,462 / pages-view 3,126；本表是这一版）。
> 上一版写 4962–5010 是 `743f5bc` 前后的数，被刀 6 挪了 +3。

本刀的产出：`review-view.js` 上新增的**具名入口**（初拟 `showFinishPanelEntry()` / `openDetail()` / `runAux()`，
名字待 Architect 定），它们自己持有那 3 个 id；`applyPackageMode` 之后只调用入口，不再碰 id。

## 验收判据（机检）

```
① recognizePage 内不再引用 page-detail-error（体内该 id 出现 = 0）
② recognizePage 搬走后 **pages 的 R3：25 → 23**（`pages-error` **2 → 0**，它体内 2 处全部迁走；**ids 14 → 13**——该 id 归零后整类消失）
③ review-view.js 引用的 id ⊆ view-review 子树（R3 模块零豁免，天然判据）
④ 新增入口在 api 里登记，且 VIEW_EXPORTS 的 pages 侧不增键（本刀不动 pages 的导出面）；
   新增入口逐个带死亡刀号
⑤ node 闸 + pytest 全绿；真机：点「完成 → 打开审校」「详情识别」「第二引擎」三条入口行为不变
```

**原判据「app.js 里 page-detail-error 引用 = 0」做不到，已作废**（2026-10-30 实测）：

```
`page-detail-error` 是 **view-review** 的 id，app.js 里共 **23 处 / 15 个宿主**
（按顶层函数归属数出 15，TestDev 独立复核也是 15；名单见 `docs/refactor/evidence/pages/review-ids-ledger.md`）。
搬走 recognizePage 只减它体内那 1 处 → **22**。
而且这 22 处**不进 pages 的 R3**：R3 只数 `#view-pages` 子树的 id。
⇒ 「R3 到 0」**不需要**把 review 视图收干净：review 是**另一本账**
   （93 个 id / 89 个被 app.js 引用 / 267 处，见 `docs/refactor/evidence/pages/review-ids-ledger.md`，TestDev 出）。
   拿「app.js 全局引用 = 0」当本刀判据，等于要求这一刀顺手把整个 review 视图也搬完。
```

## 到期点

```
· recognizePage 本刀必须搬走（不留外壳）；
· review 的 3 个具名入口必须在 knife-package 开工前就位，否则 applyPackageMode 无法满足
  「体内 review id 引用 = 0」这条判据。
```

## R3 / R8 / 账本（基 `main@a5dd595`）

```
本刀前：pages R3 **25 处 / 14 种 id** · R8 **57** · PagesView deps 218 · app.js 13,462
        豁免表 **14 项 / Σcap 25 / TOTAL_CAP 25 / BLOCKED_MAX 0**
本刀后：pages R3 **23 处 / 13 种 id**（recognizePage 体内 pages-error 2 → 0，该 id 整类归零）
R8：**57 → 58**（recognizePage 仍被 app.js:3394 / 11657 调用 → +1 键），死亡刀号 = 刀 9
        （「外壳调用」类，到点判据 = 该键在 app.js 的引用 = 0 且不在 api 表）
账本（与代码**分两笔**，形态照抄刀 6）：
        · 删豁免 1 项：`pages-error`（cap 2，引用归零 → 会撞「陈账，删项」那条下行机检）
        · 存活 13 项的 cap **现在逐项都等于实测**（刀 6 账本笔刚收过），所以 Σcap 25 → **23** 是删项自然结果
        · `TOTAL_CAP 25 → 23`（== Σcap == r3.total）
        · `BLOCKED_MAX 0` 不变
剩余 23 处全部属刀 8：applyPackageMode 20 + applyProjectSettings 2 + applySplitBatch 1
        ⇒ **R3 到 0 在刀 8**，不是本刀
```

## 刀 8 的账（同一形态，一次清空，先记在这别只写"到 0"）

```
R3    23 → **0**（applyPackageMode 20 + applyProjectSettings 2 + applySplitBatch 1）
ids   13 → **0**（剩的这 13 种 id 全在这三个函数体内，没有一个有别的宿主）
豁免表 13 项 → **0 项**（整表清空）
Σcap 23 → 0 · TOTAL_CAP 23 → **0** · BLOCKED_MAX 0 不变
       ⇒ 三者合一落到 0：Σcap == TOTAL_CAP == r3.total == 0，R3 这一章结账
```

**验收（本刀）**：`Σcap == TOTAL_CAP == r3.total == 23`，且 `r3.ids == 豁免项数 == 13`。

刀 4 的验收（R3 101 / ids 38 / R8 36 / deps 213）是**历史账**，不含这 4 个函数；
本刀只按上面这张当前基线结算。
