# knife-package 施工图（占位 + 设计纲要）：包 / 导出 / 拆分弹层那 3 个函数（**刀 8**）

> 刀号见 `docs/refactor/pages/knife-numbering.md`（旧记法「刀 7」= 本刀）。本刀开工前，刀 6
> （片段抽取）与刀 7（review 入口）必须已落盘。

> **状态**：占位。开工顺序 **knife-review 先、本刀后**。函数体怎么切、chrome 方法表具体几个，开工前再出图。
> **2026-10-30 Architect 裁定：选丙（两种能力：`navigate` + `chrome.*`），甲否决**。本文件按丙写纲要，
> 并把验收判据换成一条**能机检**的集合判据（取代原来的"review 子树 id 引用 = 0"单条判据）。

## 一、范围（不变）

| 函数 | 行范围 | 行数 | refs | 跨视图写点 |
|---|---|---|---|---|
| `applyPackageMode` | 13194–13253 | 60 | 20 | `package-banner`×2 · `package-open`×2 · `structure-open`×2 · `finish-open-review`×2 · `detail-recognize` · `aux-run` · `package-result-meta`（11 处） |
| `applyProjectSettings` | 12514–12524 | 11 | 2 | `export-margin-judgement`（1 处） |
| `applySplitBatch` | 12867–12901 | 35 | 1 | `split-batch-apply` · `split-batch-error`（2 处） |

调用者全在刀外（`refreshProject` / `boot` / `setAutoApplySetting` / `buildTile` / `setupLibrary`），
现在留外壳**不需要转发键**；搬走时各 +1（R8 +3，另 1 个是 knife-review 的 `recognizePage`）。

## 二、甲被否的理由（比"改 HTML 麻烦"硬）

```
topbar 按钮与 .mask 弹层不在任何 view section 里，是因为它们本来就是全局界面元素（chrome），
不是"无家可归"。搬进 section 会造成两个真实行为改动：
① 视图隐藏时它们跟着隐藏（现在顶栏常驻、弹层靠 .mask 自身 open 类控制）；
② #view-pages 子树的 id 集合会变 → R3 计数、豁免表、已锚基线文档全要重算。
⇒ 那是为迁就规则改掉 DOM 的实际生命周期，不是结构归位。
```

## 三、丙：两种能力（硬约束逐条）

```
navigate(toView, payload)
    只做视图切换 + 带过去的最小上下文；**不许带 DOM 意图**（不传 id、不传元素）。

chrome.<具名方法>()
    顶栏 / 弹层 / banner 的语义化操作。

硬约束：chrome 方法必须具名，**不许把 id 当参数传**。
    chrome.toggle("package-mask") ✗ —— 那等于把"模块零豁免"换成"字符串豁免"，同一道闸被绕过去。
    chrome.openPackageResult() / chrome.setTopbarBusy(true) ✓
```

### 3.1 那 10 处写点的宿主（实测：id → 宿主容器 → 谁在写）

```
package-banner        topbar 的 .noticebar                       applyPackageMode 写 hidden / textContent（×2）
package-open          topbar 按钮                                 applyPackageMode 写 hidden（×2）
structure-open        面板入口按钮（非任何 view section）          applyPackageMode 写 hidden（×2）
package-result-meta   div#package-result（.mask 弹层）            applyPackageMode 写 textContent；**还当 showError 的容器**
export-margin-judgement  div#export-panel（.mask 弹层）           applyProjectSettings 写 checked（读侧是 marginJudgementOn()）
split-batch-apply     div#split-batch-panel（.mask 弹层）         applySplitBatch 写 disabled / textContent
split-batch-error     同上                                        applySplitBatch 写 hidden；**还当 showError 的容器**
```

两条从数据里读出来的设计约束：

```
· showError 需要一个元素（`showError(el("package-result-meta"), error)`）⇒ chrome 方法要把"渲染错误"一起收进去：
  chrome.showPackageError(error) / chrome.showSplitBatchError(error)，不要暴露元素。
· 有写有读的（export-margin-judgement 的 checked）要成对：chrome.setExportMarginJudgement(on) / chrome.exportMarginJudgementOn()。
```

### 3.2 chrome 方法表（初拟，名字待 Architect 定稿）

| 现在的写法 | 换成 | 归属 |
|---|---|---|
| `el("package-banner").hidden = …` + `textContent` | `chrome.showPackageBanner(text)` / `chrome.hidePackageBanner()` | 顶栏 |
| `el("package-open").hidden = …` | `chrome.setPackageEntryVisible(bool)` | 顶栏 |
| `el("structure-open").hidden = …` | `chrome.setStructureEntryVisible(bool)` | 入口 |
| `el("package-result-meta").textContent = …` | `chrome.showPackageResult(meta)` | 弹层 |
| `showError(el("package-result-meta"), e)` | `chrome.showPackageError(e)` | 弹层 |
| `el("export-margin-judgement").checked = …` | `chrome.setExportMarginJudgement(bool)` / `chrome.exportMarginJudgementOn()` | 导出面板 |
| `el("split-batch-apply").disabled/textContent` | `chrome.setSplitBatchBusy(bool)` / `chrome.setSplitBatchActionText(text)` | 弹层 |
| `showError(el("split-batch-error"), e)` | `chrome.showSplitBatchError(e)` | 弹层 |
| review 的 3 处（`finish-open-review`×2 / `detail-recognize` / `aux-run`） | **不搬 id**：调 review 模块的具名入口（见 §五） | review |

## 四、验收判据（一条集合判据，取代"review 子树 = 0"）

```
① 任何 *-view.js 内出现的 id 字面量集合 ⊆ 它自己的 #view-<name> 子树 id 集合（差集为空）
   —— 现在就有这条闸（R3 模块零豁免），本刀要求它搬完后仍然为空；
② 全局 chrome 只能经注入键访问：模块内 `chrome.*` / `navigate(*)` 的**参数里不允许出现 id 字面量**
   （用 index.html 的已知 id 集合对调用参数做正则扫描，命中即红）；
③ chrome 方法必须是具名方法：不许出现 `chrome.toggle("x")` / `chrome.show("x")` 这类"id 当参数"的形态
   —— 判据 ② 的扫描同时覆盖它（id 字面量出现在参数里就红）；
④ R8：34 → 36（刀4）→ 40（本刀 +4）；VIEW_EXPORTS 逐键登记死亡刀号；
⑤ 真机：导出审校结果包 / 导出面板的版心判定开关 / 拆分批次三条路行为不变。
```

> 判据 ②③ 是同一条规则的两种写法：**零豁免保护的是"模块不认识这个 id"**，
> 而 `chrome.toggle("package-mask")` 让模块又认识了一个 id —— 只是换了引号。

## 五、落地顺序（Architect 给的，按这个写）

```
① 先量：10 个 id → 宿主函数 → 是否跨视图（这条决定有几个走乙）
② 再定 navigate 签名（只带视图名 + 最小上下文，不许带 DOM 意图）
③ chrome 方法表按 ① 逐条具名，进 deps（**不增 R8 导出键**，注入键算 deps）
④ knife-package 验收换成上面 §四 那条集合判据
```

代价（Architect 评估，我认同）：**最小的丙 = 量一遍 + 接一次注入 + 几个具名 shim，弹层逻辑一行不用重写**；
真正成本在测量，不在改代码。R8 曲线不变：**34 → 36 → 40 → 22 → 3**。

## 六、乙的边界（写清，防止被当通行证）

```
只允许"个别函数"留外壳（不是 applyPackageMode 整体），且必须登记：
    归属层 = 外壳/编排；到期点 = 外壳模块化那一刀
不允许用"它本质是编排"当通行证，把那 6 处 package/导出/批处理写点一起留下。
```

## 七、到期点

```
· knife-package 结束时 applyPackageMode / applyProjectSettings / applySplitBatch 必须已搬走，
  或按 §六 登记为"外壳/编排"并写明到期点；
· 不许出现"跨视图函数长期悬空" —— 那和转发器债务是同一种东西。
· knife-review 的 3 个 review 具名入口必须在本刀开工前就位。
```

## 八、与刀 4 的账

刀 4 的验收（R3 101 / ids 38 / R8 36 / deps 213）**不含**这 3 个函数；它们的 25 处 refs、
10 处非本视图写点、以及 `libraryNotify` 能力，全部记在本刀账上。
