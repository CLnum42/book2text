# knife-review 施工图（占位）：把 review 入口从 pages 的跨视图写法里摘出来

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

## 范围（待开工前定稿）

| 项 | 数据（量于 `dce41b8` 树） |
|---|---|
| `recognizePage` | 5588–5636（49 行），refs 2，写 `page-detail-error`（view-review）+ `pages-error`（view-pages） |
| `applyPackageMode` 的 3 处 review 写点 | `finish-open-review`×2、`detail-recognize`、`aux-run` —— **属 package 那一刀**，本刀只负责**先把 review 的入口做出来** |

本刀的产出：`review-view.js` 上新增的**具名入口**（初拟 `showFinishPanelEntry()` / `openDetail()` / `runAux()`，
名字待 Architect 定），它们自己持有那 3 个 id；`applyPackageMode` 之后只调用入口，不再碰 id。

## 验收判据（机检）

```
① recognizePage 搬走后：app.js 里 page-detail-error 引用 = 0（现在 1 处）
② review-view.js 引用的 id ⊆ view-review 子树（R3 模块零豁免，天然判据）
③ 新增入口在 api 里登记，且 VIEW_EXPORTS 的 pages 侧不增键（本刀不动 pages 的导出面）
④ node 闸 + pytest 全绿；真机：点「完成 → 打开审校」「详情识别」「第二引擎」三条入口行为不变
```

## 到期点

```
· recognizePage 本刀必须搬走（不留外壳）；
· review 的 3 个具名入口必须在 knife-package 开工前就位，否则 applyPackageMode 无法满足
  「体内 review id 引用 = 0」这条判据。
```

## 与刀 4 的账

本刀不从刀 4 的验收里扣任何数：刀 4 的 R3 101 / ids 38 / R8 36 / deps 213 是**不含**这 4 个函数的账。
这 4 个搬走时：R3 再降（4 处 review 写点 → 其中 1 处随 recognizePage 走），R8 +4（34→36 之后 → 40）。
