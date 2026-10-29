# `pages` 刀一 交接（2026-10-29，DevLead）

## 0. 一句话

**刀一的边界没闭合**：19 个渲染叶函数搬走了，41 个调用者还在外壳，于是 `app.js` 里有 **20 个
`PagesView.<fn>` 函数级调用点**，而模块只导出 `{init, enter}` → 运行时全是 `undefined`。
**这不是生成器缺陷，是拆分单位选错了。**

> **最危险的绿（Chief 2026-10-29）**：`api` 只导 3–4 个键时，外壳那 20 个函数级调用点里
> 有 16–17 个是 `undefined`。**node / pytest / accept 三条闸都看不见**——闸全绿、UI 已坏。
> 所以 api 的键必须与外壳实际调用的名字集合**同源**（现扫，不设计），并配双向烟测。

## 1. 实测事实（全部可复跑）

```
grep -oE 'PagesView\.[A-Za-z_]+' backend/book2text/static/app.js | sort -u   → 20 个（见 §4）
page-pages.js 的 api 字面量：const api = { init, enter }  → 2 个（第 1204 行）
app.js 15,311 → 14,372（减量 939）· page-pages.js 1,206 行 · R3 270 → 198（硬判据，已过）
```

## 2. 裁定：R8 改成收敛棘轮（Chief 2026-10-29）

```
本刀登记值 = 模块**真实**导出键集合（从 page-pages.js 的 api 字面量读出，不许猜、不许凑）
本刀实测    = 20（或 20+1，以 grep 扫描为准）· 终点 3
落差说明    = 本刀 20 → 终点 3，靠把 41 个调用者搬进模块逐刀收敛；注释里必须写这句
终点       = 3（enter / render / refresh），写在同一表项的注释里
新硬要求   = 刀 2–5 每刀落盘后导出数必须严格小于前一刀；不降即红
```

**红线**：不许 `api = { init, enter, ops: {...} }` 这种包一层骗 `Object.keys`——
那和被驳回的 `call(name, args)` 是同一个招。Architect 正在签这条表述，**它没回之前：
表值按实测键集合写，别写死 3。**

## 3. 两条数据归属改判（判据第三次生效）

```
layoutBlockPage           外壳 app.js:4889 写它   → 改注入，不搬
suggestionScrollListening 外壳 app.js:3454 读它   → 改注入
（同前：pageBlockCache / detailPageNo）
```

**判据一句话（写进 pages-plan.md）**：外壳有写点或读点的状态，一律注入；
**判归属必须列两侧引用行号**，只列模块侧等于没判。

## 4. 外壳实际用到的 20 个导出（真值，别用「3 个」定表）

```
init · ensureMarginFitted · loadLayoutBlocks · loadSetupSuggestions · refreshRecognizedPages ·
reloadProjectPages · renderLayoutBlocks · renderMarginPanel · renderPageSetup · renderPages ·
renderRecognitionStatus · renderRecognitionVerdict · renderSuggestionPanel · renderTypePicker ·
savePageMargin · syncPageStates · undoMarginEdit · updateMarginDetectProgress ·
updatePageVisibility · updateSelectionPanel
```

## 5. 下一轮的顺序（不要改变顺序）

```
1. rules.py：**INTERFACE 的键集合 = `grep -oE 'PagesView\.[A-Za-z_]+' app.js | sort -u` 的结果**
   （本刀 20 个，一个不多一个不少）。**不要自己设计 3 个或 4 个入口**——
   `api` 少一个键，外壳那处就是 `undefined.apply`，而 node / pytest / accept **三条闸全看不见**。
   同时：layoutBlockPage / suggestionScrollListening 改注入；rules.py 自检三条全过。
2. rollback_pages.sh → dry run 绿 → --write
3. **双向烟测（5 秒，硬闸）**——这是唯一能看见「闸绿但产品坏」的眼睛：
   ```
   ① 外壳每个 PagesView.X  → 模块 api 必须有 X     （缺 = 运行时 undefined，三条闸都看不见）
   ② 模块 api 每个键       → 外壳必须有调用点      （多 = 死面，账上又不降）
   ```
   **两个方向都要报，缺哪边都算红。** 不要等 node 闸第 4 条才发现（这一轮为此付了一整轮）。
4. 三张表：VIEW_EXPORTS 按实测键集合 + 终点注释；OWNERS 按**闸点名的名字**补，不按「13」这个数
5. node 全绿 → pytest → accept_pages --stage 1 --movers stage1-movers.json --expect-sha <自算 sha>
```

## 6. 两条硬判据（缺一条就停下报）

```
R3 必须仍是 198（实测 198 ✔）
导出数必须能从模块字面量读出来，且等于表
双向烟测必须全过（外壳→模块无缺键、模块→外壳无死键）
```

## 7. 当前树的状态（交接时刻）

```
工作区：已回滚（app.js 15,311 / page-pages.js 已删 / node 127 pass 0 fail）
未提交：rules.py（三处改注入 + EXPECT_SEAMS 87）、build_view.py（重名守卫 + 交集守卫）、
        stage1-movers.json（去重 19 条 / 1,090 行）、HANDOFF 本文
已提交未推：9 笔（见 git log）
```
