# 增量落盘：`build_view.py --write` 的刀 1 形态与正确拼法

> **警告**：`build_view.py --write` 目前仍是**刀 1 形态**——它把 `pages-view.js` 整份替换成
> 「IIFE 头 + 本刀函数体 + INTERFACE」（`build_view.py` 里 `module = header + out + INTERFACE`）。
> 从刀 3 起，模块里已经有刀 1/2.5 的 1,511 行，整份替换会**冲掉它们**，而 `node --check` 照样过。
> 另一处：`FORWARDERS` 分支会在 `INIT_ANCHOR`（`  setupLibrary();`）后再插一次
> `window.PagesView?.init({…})`，刀 3 之后就会**出现第二个 init 调用**——语法合法、运行时把 deps 覆盖成半套。


## 零、为什么 `--write` 会毁掉模块（读 Builder 的拼法后补，字都是核过的）

生成器（`build_view.py`）里组装模块只有一句：

```python
module = header + out + INTERFACE      # header = IIFE 头 + let injected + const el；out = 本刀函数体
```

它**从来没有读过现有 `pages-view.js`**——所以 `--write` 是「整份替换」：刀 3 跑一次，模块从
1,511 行变成 550 行，刀 1/2.5 的 34 个导出与 `wireAll` 全部消失；而 `node --check` 只查语法，
一个「结构完整但内容缺一半」的文件在它眼里完全合法。

第二处更隐蔽：`FORWARDERS` 分支会在 `INIT_ANCHOR`（`  setupLibrary();`）之后再插一次
`window.PagesView?.init({…})`。刀 1 当时模块里没有 init 调用（第一次），所以只有一处；
现在 `boot()` 里已经有一处，再插就是**两个 init**：后一个的 deps 只带本刀的键，
把前一份 `Object.assign` 出来的 deps 覆盖成半套——运行时表现为「有些页面功能突然 undefined」，
而语法、单测、node 闸全绿。

Builder 手工拼完的两个文件可以当基准（`/tmp/app-merged.js` / `/tmp/pages-view-merged.js`，2026-10-30 11:05）：

```
app-merged.js      14,323 行 · PagesView?.init( 出现 **1** 次 · init deps 键 **208**（11:05 那份读作 207，见下）
pages-view-merged  2,041 行 · function init(deps) **1** 次 · api 键 **34**（16 + 本刀 14 + 4？见下）
```

> **deps 键正确值是 208，11:05 的 207 少一个 `indexRefresh`**（当时能力键还没进 deps）。复算口径：
> 量 `HEAD:backend/book2text/static/app.js` 的 init 对象 **180** 键，∪ 本刀模块正文实际用到的 **46** 键，
> 重叠 **18**，新增 **28** → **208**。规矩：**以实际生成物 + 集合相等为准，不以相加为准**
> （今天已经因为"相加式判据"返工四次）。

> `api 34` 与计划里「16 + 14 = 30」差 4：那 4 个是刀 2.5 之后、本刀之前新增过的导出（`a582baa` 一带）。
> **对账时要按"当前模块里的 api 键集合"数，不要按历史数字加**——这正是"用算术凑"的另一面。

**所以增量拼法的判据是"计数为 1 + 集合相等"，不是"看起来对"**：

```
· app.js 里 `PagesView?.init(` 恰好 1 次            ← 防第二个 init 覆盖 deps
· 模块里 `function init(deps)` 恰好 1 次
· api 键 = 旧 api 键集合 ∪ 本刀 14 个（集合相等，不是数字相加）
· deps 键 = HEAD 180 ∪ dry run 46 = 208（重叠 18、新增 28；集合相等，不是 180+46）
· 模块行数 = 旧行数 + 本刀函数体行数（刀 3：1,511 + 470 ≈ 1,981；Builder 实际 2,041，差 60 是注释/空行，要说明）
```

## 零点五、46 这个数从哪来（三个数别混：45 / 46 / 208）

| 数 | 是什么 | 怎么量 | 不是 |
|---|---|---|---|
| **45** | `knife3-rules.py` 里 `IDENT_KNIFE3` 的**声明条数** | 数列表长 | 不是 deps 键数 |
| **40** | 真正进 `IDENT` 的条数（45 − 5 条"模块已声明"：`el`/`ensureMarginFitted`/`renderLayoutBlocks`/`renderMarginPanel`/`renderRecognitionStatus`） | 生成器同一口径过滤 | — |
| **46** | dry run 的 `injected_keys`：模块正文里**实际出现**的 `injected.X` 键 | `re.findall(r"injected\.(\w+)", strip_code(blank_deps(module)))` | 不是"计划里的 45 相加" |
| **208** | 最终 init deps 键总数 | HEAD 180 ∪ 46 | 不是 180 + 46（重叠 18） |

46 的来源逐栏（**相加必须等于 46，不等就是分类错**）：刀 3 自己的 IDENT 键 36 + SETTERS 7 + capability 1 + 基规则补 2
（`getSelectedPages` / `setPagesMarginOn`）= 46。声明了但正文没用到、**不进 deps** 的 5 个：
`getFinishSummary` / `getFinishSummaryProject` / `getLatestAutoApply` / `selectedPages` / `setCurrentView`
（前两个 HEAD 里本来就有，留着无害；后三个只是扫描over-collect，不许往 init 里加死键）。

> 生成器已按这个口径改：`deps_literal(rules, used)` 只输出 `used` 里的键（整表有 202 条，倒进 init 会加
> 156 个没人用的键）。dry run 现在同时报 `injected_keys` 与 `deps_literal_keys`，**两个必须相等**。

## 一、三段各自往哪去（照这个拼，不要整份替换）

```
① 本刀函数体（生成器产物 /tmp/k3-dry/module.js 里 INTERFACE 之前的那一段）
   → 追加到**现有** pages-view.js 的 `function wireAll() {…}` 之后、`function init(deps)` 之前
   → 不要碰已有的 IIFE 头、`let injected = {}`、`const el = …`、`wireAll`、`init`、`api`
② INTERFACE 里的 `const api = { … }` 新增键
   → **只往现有 api 对象里补 14 个键**（顺序跟在最后一个键后，逗号别漏）
   → 不要整块替换 api：现有 16 个键里有刀 1/2.5 仍在用的
③ init 的 deps 字面量（在 **app.js** 的 `window.PagesView?.init({…})` 里，不在模块里）
   → 只插 **`deps_literal_keys` − 已有键** 那些行（刀 3：46 − 18 = **28** 行），插在对象**内部**（`}` 之前）
   → 别在 init 之后再拼第二段；也别整份 `deps_literal` 倒进去（那是 46 行，18 行会重复定义，后者覆盖前者）
   → 跨视图能力（`indexRefresh`）由 `CAPABILITIES` 生成 `键: () => 表达式,`，**不要手写**
```

**跨视图能力（R2）的唯一出口是 rules 里的 `CAPABILITIES`**（`build_view.py` 2026-10-30 加）：

```python
CAPABILITIES = [("indexRefresh", "window.IndexView?.refresh()")]   # → deps 生成 `indexRefresh: () => window.IndexView?.refresh(),`
```

把它当 function 写进 `IDENT`（刀 3 第一版就是这么写的）会让 deps 生成 `indexRefresh: indexRefresh,`
——外壳没有这个声明，`node --check` 过、**运行时才 TypeError**；Builder 当时只能手工改成闭包才过。
生成器现有三条守卫，任一命中即 exit 2：**setter 进 IDENT** · **能力进 IDENT** · **同一键既 CAPABILITIES 又 SETTERS**；
另有一条 anti：**能力声明了但模块正文没用到 → 空声明红**（deps 会多一个没人用的键）。

## 二、判据（拼完立刻能验，都是机检）

```
· 模块里 `function init(` 只出现 1 次；`window.PagesView?.init(` 在 app.js 里只出现 1 次
  （第二个出现 = 踩了刀 1 形态的坑）
· 模块行数 = 旧行数 + 本刀函数体行数（刀 3：1,511 + 470 ≈ 1,981，不是 550）
· `api` 键数 = 16 + 本刀新增（刀 3：16 + 14 = 30；实际 34 见上，按集合数）
· init deps 键数 = HEAD 180 ∪ 46 = **208**（重叠 18、新增 28）；且 `injected_keys == deps_literal_keys`（刀 3：46 = 46）
· residue [] / anti []（生成器 dry run）
· node 闸（不是 node --check）152/0
```

## 三、给生成器加 `--append` 的最小改法（下一刀前做，别在搬函数时顺手改）

```
① 读现有 pages-view.js，定位 `function init(` 起点；新函数体插在它之前
② api 对象按名字合并：新键追加，已存在的键不重复、不改顺序
③ 本刀 movers 里若已有同名函数 → 拒绝写（重名守卫，已有）
④ 干跑时打印「旧行数 + 追加行数 = 新行数」与「api 16 → N」，与 dry run 的 injected_keys 对账
```

**在 `--append` 落地之前：手工拼，按上面三段 + 五条判据。** 别用 `--write`。
