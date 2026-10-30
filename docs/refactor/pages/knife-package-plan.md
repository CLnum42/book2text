# knife-package 施工图（占位）：包 / 导出 / 拆分弹层那 3 个函数

> **状态**：占位（Architect 2026-10-30 裁定）。开工顺序：**knife-review 先、本刀后**。
> 未做实测设计；下面的数是当前树的只读量数，函数体怎么切、弹层往哪归，开工前再出图。

## 范围

| 函数 | 行范围 | 行数 | refs | 跨视图写点 |
|---|---|---|---|---|
| `applyPackageMode` | 13194–13253 | 60 | 20 | `package-banner`×2 · `package-open`×2 · `structure-open`×2 · `finish-open-review`×2 · `detail-recognize` · `aux-run` · `package-result-meta`（11 处） |
| `applyProjectSettings` | 12514–12524 | 11 | 2 | `export-margin-judgement`（1 处） |
| `applySplitBatch` | 12867–12901 | 35 | 1 | `split-batch-apply` · `split-batch-error`（2 处） |

调用者全在刀外（`refreshProject` / `boot` / `setAutoApplySetting` / `buildTile` / `setupLibrary`），
所以它们现在留在外壳**不需要转发键**；搬走时各 +1 转发键（R8 +3，另 1 个是 knife-review 的 `recognizePage`）。

## 两个前置条件（任一没满足就别开工）

### 条件一（Architect 定，硬判据）

```
applyPackageMode 对 review 的 3 处写点（finish-open-review / detail-recognize / aux-run）
必须改成调 review 模块的具名入口（ReviewView.showFinishPanelEntry() / openDetail() / runAux() 之类），
不是把 review 的 id 一起搬过来。

验收判据：applyPackageMode 体内 **review 子树 id 引用 = 0**，且那 3 处是具名入口调用。
```

不这么做，搬完只是把"跨视图"从 pages 换成 package —— 同一个缺陷换了文件名。

### 条件二（刀 4 实测出来的，需 Architect 拍）

用闸的解析器量当前 `index.html`：这 10 处写点所在 id **不在任何 `<section id="view-*">` 里**：

```
package-banner×2 · package-open×2 · structure-open×2      ← 在 topbar（外壳）
package-result-meta                                       ← div#package-result（.mask 弹层）
export-margin-judgement                                   ← div#export-panel（.mask 弹层）
split-batch-apply · split-batch-error                     ← div#split-batch-panel（.mask 弹层）
```

R3 模块零豁免 ⇒ **任何 `*-view.js` 都不能引用这些 id**。所以二选一：

```
(a) 把这几个 .mask 弹层与顶栏按钮移进归属的 view section（改 index.html，属结构变更，
    要连带验 showView 的显隐、遮罩层叠、以及 R3 对 index.html 的其它断言），或
(b) 明确让 applyPackageMode 留在外壳并写下理由：它操作的是外壳级顶栏与弹层，不是某个视图的 DOM。
```

**到期点**：本刀结束时这 3 个函数必须已搬走，或**明确留外壳并写理由**（写进本文件 + `docs/decisions.md`）。
不许"跨视图函数长期悬空"——那和转发器债务是同一种东西：没有到期点就会一直在那儿，
而且每次都会被下一个出图的人当成"pages 的残留"再数一遍。

## 验收判据（机检）

```
① applyPackageMode 体内 review 子树 id 引用 = 0（条件一）
② 本刀搬走的函数，其 id 引用所在 section ⊆ 目标模块自己的 section（或按条件二(b) 留外壳）
③ R8：34 → 36（刀4）→ 40（本刀 +4）；VIEW_EXPORTS 逐键登记死亡刀号
④ index.html 若有结构变更：R3 对 index.html 的断言全绿 + 真机点一遍导出/拆分/结构工具三条路
```

## 与刀 4 的账

刀 4 的验收（R3 101 / ids 38 / R8 36 / deps 213）**不含**这 3 个函数；它们的 25 处 refs、
14 处非本视图写点、以及 `libraryNotify` 能力，全部记在本刀账上。
