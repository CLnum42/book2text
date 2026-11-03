# 2026-11-03 片 1a 页码面板真机 + 缩放修复独立复核

**测的树**：`origin/main` = **`ca82b0f`**（片 1a 三笔 + 缩放修复 + 刀 12 两笔 + 跨根闸 + 注释刀号闸）。
`git ls-tree` 确认 `page-number-panel.js`（664 行）在树里，静态请求 200；`app.js` 8,028 行；`page-detail-drawer.js` 含
`image.style.width`（缩放修复）。片 1b 两笔未推，未涉及。

**环境**：worktree `/tmp/b2t-wt-p1a`，`PYTHONPATH=$PWD/backend`，端口 8871，token `qa4`，库 `/tmp/b2t-qa4/lib`；
`paths.STATIC_DIR = /private/tmp/b2t-wt-p1a/backend/book2text/static`；静态自检：`page-number-panel.js` 200、`image.style.width` 命中。
项目：`b2t_T7JH61`（490 页，正文 487，已识别 101–104 页）。视口 1469×738（② 另把 200% 档单独复核）。

**结论**
- ② **缩放修复通过**：四档三宽全等，fit maxDev 0.01px、125/150/200 各 0.01px（修前 0.01 / 33.34 / 191.13 / 507.53）。
- ① **三个动作本身都通，但每次写盘后带一条 P1 回归**：错误条弹 `Cannot read properties of null (reading 'hidden')`，
  并导致 `onPageNumberChanged` 被跳过 ⇒ 页面视图侧栏页码数字/入口不刷新，和面板/服务器对不上。
  根因是本刀把 `el("page-number-review-panel")` 改成了 `reviewPart("page-number-review-panel")`——根元素自己不在自己的子树里。

---

## ② 缩放四档（page 6，10 块框，overlay 开）

测试框取每档偏差最大的那个块（四档分别是 `…2AQT / 2AQM / 2AQR / 2AQJ`），`expX = bbox[0] × image 宽`。

| 档 | image 渲染宽 | canvas 宽 | overlay 宽 | 测试框 offsetX | maxDev | 修前基线 |
|---|---|---|---|---|---|---|
| fit | 778.00 | 778.00 | 778.00 | −0.01 | **0.01** | 0.01 |
| 125% | 973.00 | 973.00 | 973.00 | 0.00 | **0.01** | 33.34 |
| 150% | 1167.00 | 1167.00 | 1167.00 | −0.01 | **0.01** | 191.13 |
| 200% | 1556.00 | 1556.00 | 1556.00 | −0.01 | **0.01** | 507.53 |

判据核对：三宽逐档相等 ✓；fit ≤ 0.5px ✓；其余三档 ≤ 2px ✓。**通过**。
截图 `zoom200.jpg`：200% 下块框与正文行对齐（修前这一档最宽块会偏 507.53px）。

---

## ① 页码面板

### 入口与加载

- pages 视图入口藏在「页面类型 → 页码（可跳过）」折叠里，且 **`#panel-pagenum-settings` 只在 `workflowStep === "pages"` 时可见**
  （`renderStepPanels`）。本项目的步骤默认是 `recognition`，要先点顶部「页面确认」才出现「定位页码…」。
- 面板打开后先显示「正在从已识别页里收集页码候选…」，约 **2.5–4 秒**后出 2 个模板（444 页 / 72 页）。
  未停在「加载中」✓。
- 顺带一条小坑（非本刀）：折叠区展开后，右栏底部那条 sticky「收尾 1/6 ⋯」条会压住「定位页码…」按钮
  （`elementFromPoint` 命中 `.selection-actionbar__row`，重叠 40px），把「页面类型」折叠起来 / 视口再高一点才能点。

### A 改模板（模板 1 设为整本默认）

```
POST /api/projects/b2t_T7JH61/page-numbers/apply  200（confirm 文案正确：会按位置重抽、手动值不覆盖）
面板 meta：已填 0 → 已填 60 / 490 页
assignments：第 1–490 页 · 底部外侧 · 奇右偶左（默认）
当前映射：41 行（40 + 「…共 60 页」）；异常列表：无候选 33 / 歧义 11 / 溢出 2 / 重复 4
关面板重开：meta 仍 60、assignment 仍在  → 读数不丢 ✓
```

### B 移范围（模板 2 用于第 36–42 页，再移除）

```
加范围：POST /page-numbers/apply(range 36–42) 200
  assignments：1–35 默认 / 36–42 右侧（第二套，带「移除」）/ 43–490 默认
  面板 meta：已填 55 / 490 页（60 → 55：这 5 页换成右侧模板后没抽到候选）
移除：POST /page-numbers/ranges/remove 200
  server：ranges 0，assignments 回到 1–490 默认，filled 60
  面板同步：meta 60、只剩一条 assignment  → 该页回到默认模板 ✓
```

### C 手动改号（第 36 页 → 444）

```
入口：#page-number-review-open「核对 55 页异常…」（60 页异常时也见过「核对 60 页异常…」）
打开：约 4–9 秒空白后渲染（meta「已填 60 / 490 页 · 手动 1 页」、490 行、7 个筛选、441 条问题）
第 36 页输入 444 → blur → POST /page-numbers/manual 200
  行 source 变「手动」，状态「页码不连续 / 偏移突变」，表格 scrollTop 0 → 961.5，该行滚到可视区 ✓
  面板 meta 追加「· 手动 1 页」✓
```

### 500 错误路径

注入 `POST /page-numbers/apply` → 500（计数器 1 次，只命中该端点）：
错误条 `#page-number-error` hidden=false，文案「请求失败（HTTP 500）」；面板不崩（2 个模板仍在、meta 不变、
mask 仍在、可继续操作）；`pageerror` / `unhandledrejection` 0。**通过**。

---

## ③ P1 回归：写盘后 `reviewPart("page-number-review-panel")` 抛 null

**现象**（A、B 都复现，C 不复现）：
每次 `apply` / `ranges/remove` 成功后，面板底部错误条显示

```
Cannot read properties of null (reading 'hidden')
```

同时页面视图侧栏的页码数字**不刷新**，与面板/服务器对不上：

| 时刻 | 服务器 `filled` | 面板 meta | 侧栏 `#page-number-summary` |
|---|---|---|---|
| 加范围后 | 55 | 已填 55 | 底部外侧 · 奇右偶左 · 已填 60 · 异常 56 |
| 移除范围后 | 60 | 已填 60 | 底部外侧 · 奇右偶左 · 已填 55 · 异常 60 |
| 冷启动进入项目 | 60 | — | 未定位 · 可跳过（连 summary 都没请求） |

**根因**（代码坐标，`ca82b0f`）：

```js
// page-number-panel.js:387 / :411
if (!reviewPart("page-number-review-panel").hidden) renderPageNumberReview(data);
// page-number-panel.js:28
const reviewPart = (id) => (reviewRoot ? reviewRoot.querySelector(`#${id}`) : null);
// app.js:7421
reviewRoot: el("page-number-review-panel"),   // ← reviewRoot 就是那块 mask 本身
```

`reviewRoot.querySelector("#page-number-review-panel")` 查不到**自己**（querySelector 只查后代）⇒ 返回 null ⇒ `.hidden` 抛
TypeError ⇒ 被 catch 送进 `showError(#page-number-error)`，**并且**跳过紧随其后的
`await injected.onPageNumberChanged(...)`（侧栏刷新 + 页卡状态）⇒ 数字停在写入前。

**是本刀引入的回归**：修前 `3d7151d` 同一处是 `el("page-number-review-panel")`（document 级 getElementById，能找到 mask 本身）：

```
3d7151d app.js:3122  if (!el("page-number-review-panel").hidden) renderPageNumberReview(data);
3d7151d app.js:3148  if (!el("page-number-review-panel").hidden) renderPageNumberReview(data);
```

本刀 05cc494「15 处 part() 改成 reviewPart()」把它们一起换了。**新的跨根闸（4bba5e6）没拦住**：
它校验「part()/reviewPart() 的 id 落在各自根子树里」，而根元素自己不在自己的子树里，这类调用天然不匹配它。

**影响**：A/B 两条主路径每次写盘都留一条红错 + 侧栏数字与面板打架（团队规则「界面数字必须能和点下去的事对上」）；
`核对异常…` 入口在写盘当次不出现/文案过期（要等下一次 summary 刷新）。
**修法**：这两行改回 `el("page-number-review-panel")`，或 `if (!reviewRoot.hidden)`；测试闸补一条「reviewPart 的 id 不能是 root 自身」。

### 冷启动侧栏不加载（另记，待判）

重载后进入本项目，右栏直接显示「未定位 · 可跳过」，且全程没有 `GET /page-numbers/summary`
（点「页面确认」步骤也不触发），要打开一次页码面板才刷新。
`loadPageNumberSummary()` 全仓只有 `onPageNumberChanged()` 一个调用点（`pages-view.js:1407`），
而 `3d7151d` 的 `app.js` 里同样没有别的调用点 ⇒ **看起来是既有行为，不是本刀**；但它同样违反「数字要对得上」，请 DevLead 定性。

---

## ④ 加条：可拆书眉/页码样本（DevLead 追加）

- 单页（第 9 页）：「批量拆分书眉页码…」→「没有找到需要拆的块（扫了 1 页）」。
- **全书 490 页（全选后）**：「会影响 **4 页 · 4 块**」，每条都带「段落：… → 拆出页码 N（块首/块尾）」：

```
第 1 页  · 段落：THE STORY OF THE STONE 4        → 拆出页码 4（块尾）
第 32 页 · 段落：228 送果品小郎惊叵测 Chapter 90 → 拆出页码 228（块首）
第 60 页 · 段落：27 1                            → 拆出页码 1（块尾）
第 88 页 · 段落：55 1                            → 拆出页码 1（块尾）
```

「执行拆分（4 块）」**可点（disabled=false）**。我只读到预览，**没有点执行**（会改数据）；
所以「执行后的块类型/文本、整批撤销」仍未验，见下。

---

## ⑤ 未验

1. 「执行拆分（4 块）」的真实结果与「审校视图 → 撤销」整批回退：只读预览，未执行（会改共享测试库数据）。
2. 页码面板在 >490 页书上的候选收集耗时（本机 2.5–4 秒；没有更大的书）。
3. 审核面板打开的 4–9 秒空白期没有「加载中」提示——判据按「最终渲染、不停在加载中」算过，但体验上像卡住，建议加 loading 态。
4. 侧栏冷启动不加载 summary（§③末，疑既有）——需要定性。
5. 「已知错误条被 500 注入覆盖后再恢复正常路径」未回归（500 之后没再走一次成功 apply）。

## ⑥ 证据

| 文件 | 大小 | 说明 |
|---|---|---|
| `panel-loaded.jpg` | 154,186 B | 页码面板：2 个候选模板、已填 60 / 490 页、当前映射与异常 |
| `review-row36.jpg` | 125,686 B | 核对面板：第 36 页「手动 444」、状态「页码不连续 / 偏移突变」 |
| `zoom200.jpg` | 123,060 B | 200% 缩放：块框与正文行对齐（三宽 1556，maxDev 0.01） |
| `result.json` | — | 机读读数（四档表、A/B/C、回归坐标、拆分样本） |

**副作用**（共享库 `/tmp/b2t-qa4/lib`，已尽量复原）：项目 `b2t_T7JH61` 的页码状态被本次验收改过——
默认模板 = 「底部外侧 · 奇右偶左」（本来没有模板）、`filled 60/490`、第 36 页手动映射 `444`、第二套范围已移除；
块数据未改（未执行拆分）；项目位置记录随打开更新。
