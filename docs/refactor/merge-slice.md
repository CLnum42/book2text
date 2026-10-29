# `merge` 切片落地记录（2026-10-29）

> 对象：`backend/book2text/static/app.js` 的合并审校视图 → `merge-view.js`。
> 基线：`8e95b8e`（产品与 `cd0a508` 相同，未改动）+ 本笔 `cef331b`。
> 逐字节口径：每个搬走的函数都比对了「搬前体 / 搬后体」，差异只允许是本文件 §2 的替换清单。

## 1. 边界（按调用闭包，不按名字）

**围栏 9 函数（361 行，Chief / `accept_merge.py` 口径）**：`renderMergeView`、`loadMergePageImage`、
`renderMergeListView`、`showMergePage`、`drawMergeOverlay`、`submitMergeDecisions`、
`renderMergeFooter`、`openMergeView`、`mergeVisiblePages`。

**闭包补 6 个（围栏调到它们，组外零调用者）**：`charDiff`、`diffMiddle`、`mergeBlockItem`、
`decideMergePage`、`mergePageRow`、`acceptAllClean`。合计 **15 个函数**，另有 `MERGE_KIND_CLASS`
与 3 个状态（`mergeHandled` / `mergeDecisions` / `mergeActivePageId`）。

**外壳只留 1 处调用点**：结果包导入后 `mergeState = payload; showView("merge")`。
合并视图的另一个入口（「查看差异」按钮）改为 `window.MergeView?.enter(id)`，
取数在模块里做（`enter(assignmentId)` → `openMergeView` → `setMergeState` → `navigate("merge")`）。
`renderMergeView` 原来的 2 个直调点全部改成「设 state + `showView`」（§20.10）。

## 2. 依赖替换清单（开搬前写死，搬后逐行核）

| 原符号 | 模块里 |
|---|---|
| `apiJson` / `showError` / `closeModal` / `setSaveState` / `loadAssignments` / `refreshProject` | `injected.*` 同名 |
| `currentProject` | `injected.getProject()` |
| `project_id()` | 模块内 `projectId()`（`(injected.getProject() \|\| {}).project_id \|\| ""`） |
| `token` | `injected.token` |
| `showView(...)` | `injected.navigate(...)`（**桥在这里切掉**） |
| `el("assign-error")`（错误回显，跨子树） | `injected.getAssignError()`（DOM 句柄注入，R3） |
| `mergeState`（读） | `injected.getMergeState()` 现取（⑧：不缓存副本） |
| `mergeState = null`（写） | `injected.setMergeState(null)` |
| `renderMergeView(payload)` 两处直调 | 外壳改「设 state + `showView("merge")`」 |

**其他改写（各写理由，不是顺手改）**：
1. `renderMergeView` 开头的「重置 handled/decisions」与 `showView("merge")` 移到 `enter()`——
   §20.10 的重置语义：**只在换数据（对象身份变化）时重置**；`showView` 由外壳发起，模块不再调路由。
2. `#merge-footer` 从运行时创建改为 `index.html` 里的静态元素——R3 要求模块引用的每个 id 都在
   `#view-merge` 子树里，运行时创建的那个 id 在静态 HTML 里找不到（这条是 R3 逼出来的，不是设计）。

## 3. 接口与状态

- `window.MergeView = { init, enter }`，**恰 2 个**（§20.10 定稿；`renderMergeView` 不导出）。
- `mergeState` → owner `app.js`（3 处写：`let`、导入结果包、`openMergeView`）；
  `mergeHandled` / `mergeDecisions` / `mergeActivePageId` / `lastStateRef` → 模块私有。
- 控制按钮（`merge-close` / `merge-filter` / `merge-accept-all`）在 `init` 里绑一次；
  `enter()` 可反复调用（幂等），`showView` 不调 exit，所以**没有 exit**。

## 4. 数字（口径 = 行数，span）

| 项 | 值 |
|---|---|
| `app.js` | 15,870 → **15,305**（净减 **565**） |
| `merge-view.js` | 新增 **633** 行（搬走 608 + 骨架/注入/改写 25） |
| 搬走函数 | 围栏 **9/9** + 闭包 6，合计 **15/15** 各 1 处，app.js 0 处 |
| `app.js` 里 `merge-*` id 字面量 | **0**（落地前 19 个 id 全在 `#view-merge` 子树） |
| 导出 | **2**（init / enter） |
| 注入键 | **12**（无缓存副本，全部现取） |
| 桥 | `renderMergeView` / `submitMergeDecisions` → 0，`edge-budget` 同笔记 0，例外表上限 3→1 |

**减量门槛（本切片专用，不沿用 library 的 250）**：`app.js` 净减 **≥ 520**（实测 565 的 92%）。
低于 520 = 有函数还在原地（复制不是搬）；高于 600 = 顺手删了别的东西。理由：这刀搬走 608 行、
外壳侧新增 43（12 键注入 + showView merge 分支 4 行 + 按钮改接 + 静态 footer），
565 = 608 − 43，账能对上；门槛按「真归属」而不是按别的视图的数字抄。

## 5. 机检（本笔实测）

```
node tests/js/run.mjs        → tests 89 / pass 89 / fail 0（含 R1/R3/R5/R6/R7/R8/R9/R11/R12/R13/A5）
.venv/bin/python -m pytest   → 1002 passed
node tests/js/edge-ratchet.mjs → merge 两条桥 GREEN，模块 showView( = 0
.venv/bin/python scripts/accept_merge.py --min-shrink 520 → [0] 全过
  （① 0 个 id / 0 处 ② 15,305 行、减 565 ③ 2 个导出 ④ 9/9 各 1 处 ⑤ script 标签在）
```

**变异（真跑，不是描述）**：
- 删 `merge-view.js` 的 `<script>` → R7 红「index.html 里没有 merge-view.js 的 `<script>`」；
- 模块多一个导出 `refresh` → R8 红「多出未申报的导出」；
- 外壳不传 `getMergeState` → R13 红「模块读了 injected.getMergeState（必读形态），但外壳注入表里没有这个键」。

## 6. 页面级验证（**未完成，卡在这里**）

`qa.py up` 在本机跑不起来基线项目：`FileNotFoundError: /Users/chenlin/Documents/Book2Text/b2t_ZAQHGH`；
本机只有 `b2t_H6GXVG`，且 `ego-browser` 未安装（`command not found`）。用 `b2t_H6GXVG` 起过环境
（`http://127.0.0.1:18765`）但无法开浏览器。

**交给 QA / Builder 的验收（必须在推之前做完）**：
1. `qa.py prepare` 打开页面，控制台 0 报错；
2. `Object.keys(window.MergeView)` == `["init", "enter"]`；
3. 从任务包/来源列表点「查看差异」进入合并视图：页列表、原图、逐页接受/拒绝、提交按钮各跑一次；
4. 提交后回页面视图，`⌘/Ctrl+Z` 可撤销；
5. 切走再切回：**未提交的裁决不被清空**（§20.10 重置语义）。
