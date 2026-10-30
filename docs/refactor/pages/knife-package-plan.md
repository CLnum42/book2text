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
现在留外壳**不需要转发键**；改判后（2026-10-30）本刀**不搬函数**，把 pages 写点收成 **3 个能力键**
（R8 +3：setPackageModeChrome / syncProjectSettings / setSelectionHint），另 1 个是刀 7 的 `recognizePage`。

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
| review 的 3 处（`finish-open-review`×2 / `detail-recognize` / `aux-run`） | **不搬 id**：留外壳直写（review 未落盘，不进 R3；见 `docs/refactor/panel-ownership.md` 的「别给外壳函数造能力壳」） | review |

## 四、验收判据（一条集合判据，取代"review 子树 = 0"）

```
① 任何 *-view.js 内出现的 id 字面量集合 ⊆ 它自己的 #view-<name> 子树 id 集合（差集为空）
   —— 现在就有这条闸（R3 模块零豁免），本刀要求它搬完后仍然为空；
② 全局 chrome 只能经注入键访问：模块内 `chrome.*` / `navigate(*)` 的**参数里不允许出现 id 字面量**
   （用 index.html 的已知 id 集合对调用参数做正则扫描，命中即红）；
③ chrome 方法必须是具名方法：不许出现 `chrome.toggle("x")` / `chrome.show("x")` 这类"id 当参数"的形态
   —— 判据 ② 的扫描同时覆盖它（id 字面量出现在参数里就红）；
④ R8：刀 7 之后 58（+1 = recognizePage），本刀 **58 → 61**（+3 个能力键）——曲线里的 61 就是终点；
   VIEW_EXPORTS 逐键登记死亡刀号（活着的老键一律重算成刀 9，依据是曲线不是拍脑袋）；
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
真正成本在测量，不在改代码。曲线（Architect 2026-10-30 重签）：

```
36(刀4) → 53(刀5) → 57(刀6) → 58(刀7) → 61(刀8) → 22(刀9) → 3(刀10)
刀 9 要死 **39** 个键（= 61 − 22）——**逐键列名，不写总和**
（原图写的 35 作废：那是"搬函数也 +3、再加 10 个能力键 = 71"那套算法的残留）
```

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
· （2026-10-30 作废）刀 7 **不产出** review 入口——review 未落盘、3 处写点留外壳直写，本刀开工前没有这个前置条件。
```

## 八、与刀 4 的账

刀 4 的验收（R3 101 / ids 38 / R8 36 / deps 213）**不含**这 3 个函数；它们的 25 处 refs、
10 处非本视图写点、以及 `libraryNotify` 能力，全部记在本刀账上。

## 九、施工顺序与终态（TestDev 2026-10-30 把终态先造出来验过，Chief 复核）

### 9.1 **一笔落完**：代码 + seed + 豁免表 + TOTAL_CAP + registry 同批

```
① 代码：**三个函数留在 app.js**（跨域编排不搬），把 pages 那批写点收成 **3 个能力**（pages-view.js 侧实现）：
        `setPackageModeChrome(on)`    ← applyPackageMode 的 20 处 pages 写点
        `syncProjectSettings(settings)` ← applyProjectSettings 的 2 处
        `setSelectionHint(text)`      ← applySplitBatch 的 1 处
        app.js 改调 `window.PagesView.<能力>(…)` ⇒ app.js 对 pages id 的引用 **23 → 0**，R3 23 → 0
   ② 7 个 chrome id + 3 个 review id **仍由 app.js 直接写**（合法）：外壳 id 永不进 R3，
      review 未落盘也不进 R3 ⇒ **不存在"模块侧 10 条红"**
      （外壳直写的依据见 `docs/refactor/panel-ownership.md`：外壳写自己域里的东西不需要给自己包一层接口）
③ seed：3 行 → **0 行**（刀 7 已删 recognizePage 那行；剩的 3 行就是这三个函数）
④ 豁免表：13 项 → **0 项**（整张表清空，R3 这一章结账）
⑤ TOTAL_CAP 23 → **0** · Σcap 23 → **0**（三者合一落到 0）· BLOCKED_MAX 0 不变
⑥ knife-registry：刀 8 标 landed（同一笔里必须是 `move(pages): 刀 8` 首行，否则 delta 自检红）
```

**三个函数实际碰的 id 不是 13 种，是 23 种 / 37 处**（实测 `main@f450a44`，按 `index.html` 的
`<section id="view-*">` 逐 id 归属）：

```
applyPackageMode      12330–12389 · 不同 id 17 · 出现 31
applyProjectSettings  11683–11693 · 不同 id  3 · 出现  3
applySplitBatch       12003–12037 · 不同 id  3 · 出现  3
合计 23 种 / 37 处，按归属分三类：

  view-pages   13 种 / 23 处   ← **R3 要归零的就这一批**（10 种 ×2 + auto-apply-suggestions / rec-margin-judgement / selection-hint 各 1）
  view-review   3 种           ← finish-open-review / detail-recognize / aux-run（**留外壳直写**；刀 7 不建 review 入口）
  不属于任何 view section 7 种 ← package-open · package-banner · structure-open · package-result-meta
                                 · export-margin-judgement · split-batch-apply · split-batch-error
```

后两类共 **10 种不进任何模块**：函数留外壳之后它们仍由 app.js 写，所以既不进 R3，也不触发
模块侧零豁免（`boundary.test.mjs:1715`）——**旧版「模块侧 10 条红必须同时归零」随形态改判作废**。

> Architect 2026-10-30 的规则（判据来自代码形态）：**单视图动作 → 该模块；跨域编排 → 留外壳、各域写点收成能力**。
> 这三个函数同时碰 pages（13）+ review（3）+ 外壳（7），搬进 pages 模块等于让 pages 去点顶栏和审校入口，
> 边界弄反了。代价是 **3 个导出键**（不是 10 个能力）。

**别分两笔，也别"先清表"**：只清豁免表、seed 不动的中间态会红，原文

```
pages 的 seed 里有函数的自身名与 wire 名在实测里都不存在（1 个）：recognizePage
——这是真丢函数，不是改名
```

这条**判得对**：那条判据拿「豁免表里的 id 所属的函数」当实测集合，表一清空就是空集，
seed 里还挂着名字自然全都显得"丢了"。表空 + 函数还挂着就是矛盾态。
⇒ **不修判据，改顺序**：一条命令里的中间态不落盘，所以一笔落完即可。

### 9.2 预期红：**0 条**（新形态下 R3 侧不再有「还引用着」）

新形态是**函数留外壳 + 收能力**，所以 app.js 里那批 `el("…pages id…")` 是被**替换成能力调用**，
不是随函数搬走——落完之后 app.js 对 pages id 的引用就是 0，那条循环自然一条都不吐。
本刀落盘前是 **23 处**（刀 7 已把 recognizePage 的 2 处 pages-error 带走）；我做模拟时是刀 7 之前，
所以替换的是 25 处。两个数都对，看的是哪棵树。

我在 `main@cf4ebb7` 上模拟过一遍端点（表清空 + `TOTAL_CAP=0` + seed 空 + registry 刀 8 landed +
把那 25 处 `el("<id>")` 换成 `el()`），实测：

```
「还引用着 view-pages 的 id」= **0 条**
唯一那条红是「当前刀由两源现算：…delta=2」——因为模拟里没有真实的 `move(pages): 刀 8` 提交首行，
  真落盘时那一笔就是 move 笔，delta = 0，这条不会红
```

> 旧数字作废：**25 条 / 23 条（输出 50 / 46 行）是"搬函数"那个形态下的数**，改判后不再适用。
> 记录口径：`assert.deepEqual(problems, [], problems.join("；"))` 会把同一份 problems 打两遍，
> 所以**日志行数是判据条数的 2×**——这条口径在任何形态下都成立，别拿日志行数当判据条数。

### 9.3 终态判据（四条一起看，缺一条都可能"绿着坏"）

```
r3.total == 0   且   r3.ids == 0   且   豁免项数 == 0   且   Σcap == TOTAL_CAP == 0
另加：seed 0 行 · BLOCKED_MAX 0 · registry 刀 8 landed
R8 = **61**（本刀 +3 个能力键：setPackageModeChrome / syncProjectSettings / setSelectionHint）
```

### 9.4 风险：`TOTAL_CAP = 0` 是**第一次**出现"上限为零"

要确认没有别的判据把 0 当成"未设置"。TestDev 已验过：

```
· boundary.test.mjs:2078  assert.ok(rows > 0, "seed 里一行函数表都没有…")  ← 唯一会被空 seed 触发的，
  正在修：seed 空且表也空 → 绿；seed 空但表非空 → 红（seed 被误清空）；seed 非空 → 原判据照旧
· seed 的两条判据、豁免表逐项遍历：空集时整体跳过是合理的，没有静默变绿
```

修完之后这条自检要能喂红：**只把 seed 清空、表留着** → 必须红；**两边都空** → 绿。
