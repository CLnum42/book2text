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
pages-view.js 的 api 字面量：const api = { init, enter }  → 2 个（第 1204 行）
app.js 15,311 → 14,372（减量 939）· pages-view.js 1,206 行 · R3 270 → 198（硬判据，已过）
```

## 2. 裁定：R8 改成收敛棘轮（Chief 2026-10-29）

```
本刀登记值 = 模块**真实**导出键集合（从 pages-view.js 的 api 字面量读出，不许猜、不许凑）
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
工作区：已回滚（app.js 15,311 / pages-view.js 已删 / node 127 pass 0 fail）
未提交：rules.py（三处改注入 + EXPECT_SEAMS 87）、build_view.py（重名守卫 + 交集守卫）、
        stage1-movers.json（去重 19 条 / 1,090 行）、HANDOFF 本文
已提交未推：9 笔（见 git log）
```
## 8. 两条待修（登记时发现，别现在改闸）

**① 同一个判据、两个入口、两种结论**（2026-10-29 实测）：

```
node tests/js/run.mjs                                                → ✔ R12 登记全绿
node tests/js/contract-registry.mjs --strict --allow-transitional-base → ✖ 1 条不合格（A1b）
```

而 **pre-push 跑的是 `--strict`**，所以 **pre-push 是唯一算数的入口**：
`run.mjs` 绿不代表能推。以后说「R12 绿了」要么写清入口，要么写「按 pre-push 的口径」。
同一判据两处结论不同，是最容易让人白推一次的东西。

**② `A1b` 只报数量、不点名**：

```
A1b: 未登记的 test-contract / move: 提交合计删除 tests/js 8 行
```

它不说是哪一笔——今天靠逐笔 `git show --numstat -- tests/js` 才定位到 `a9ecee1`。
**这和项目自己的「按名字对集，不按数字」直接冲突**。待修：A1b 输出里带上 sha 列表。
## 9. 今天能立成规则的形态（每条一句，全部有事故出处）

1. **判据空跑**：任何 `if (collection.size > 0)` 保护的自检，必须同时断言 `size === 预期值`。
   （出处：`a104332` 之前，seed 正则列序不符 → `seedStages.size === 0` → 两个 `if` 从不执行，闸全绿。）
2. **两入口不同结论**：报告「某闸绿了」必须写入口；**pre-push 是唯一算数的入口**。
   （出处：`run.mjs` 绿、`--strict` 红；今天为此白推过一次。）
3. **旧名可以留，但必须带解释**：允许防御性 `rm -f 旧名 新名`，但那一行要有注释说清旧名是改名前的产物。
   （出处：`land_pages_stage1.sh`；今天两次因为看到旧名去查「改名做完没有」。）
4. **验红要能分清两层**：「测试骗我」还是「我的破坏值不到位」。
   （出处：R4-dup 变异；如果破坏值本身没生效，红不红都不说明问题。）
5. **数量对得上 ≠ 形态对得上**：`anti` 为 0 只证明「没有裸赋值」，证明不了「次数对」。
   （出处：`layoutBlockPayload` 源里 2 处、模块里 4 次 setter，`anti` 与 `node --check` 全绿。）
6. **边改边算 depth 是 bug 源**：批量改写必须先在同一份原文上算完所有范围，再从后往前一次性替换。
   （出处：同上，后处理的块看见了前一次插入的行。）
7. **省略号不能当名单**：要名单就逐个列名 + 行范围，不接受「16 个函数…」。
   （出处：`semantic-ops.md` 的 `…`；今天为「10 个名字没列」空等一轮。）

## 9b. 补三条（我加的，同样各有出处）

8. **提交信息不许写会变的数字**：只写「做了什么、为什么」，数指向文件 + sha。
   （出处：`a2d07da` 写 21/1,159，文件实际 19/1,090；同型 `8b88e48` 的 43/120。）
9. **签别人的输出要标「我看了证据并接受」，不是「我也跑过」**：登记行的变异栏只有真跑过的人能写。
   （出处：今天两次拒绝替别人签；`a9ecee1` 的 A/B/C 是 TestDev 实跑的。）
10. **数据归属必须列两侧引用行号**：外壳有写点或读点就注入，不搬。
   （出处：`libraryProjects` / `marginFitRunning` / `pageBlockCache` / `detailPageNo` 四次。）
## 10. 刀 2 启动条件（四样，缺一不开工）

### ① 名单（要逐个列名 + 行范围，不接受只有数量）

```
规模：9 个装配函数 / 59 处调用点（Chief 2026-10-29 给的数）
要求：按 §9⑦，落成表（函数名 | start–end | 行数 | 非 mover 调用者 | 调用点行号），
      总数与 9 / 59 对不上就退回，不自行补名字。
来源：docs/refactor/evidence/pages/semantic-ops.md 操作 2
```

### ② 到期判据

```
accept_pages --acid 通过（四字段齐）：同页同档 img.src 赋值 = 1 · observer ≤ 6
缺字段 = 未验（exit 2），不许当通过
```

### ③ 前置

```
刀 1 已推（origin 上有 pages-view.js 与 §18.6 两行登记）
三闸绿：node tests/js/run.mjs / contract-registry --strict / pytest
树是干净的 HEAD（不是落盘中间态）
```

### ④ **这次不做什么**（写死，防止顺手扩大）

```
不动 PageTile 之外的取图路径：不新增第二套 img、不改 max-age 策略、不数网络请求
不开 call(name) 分发口、不用测试替身遮 undefined
不为过闸新增豁免；R8 导出数必须 ≤ 本刀实测（只降不升）
不手改 app.js：生成器 fail-closed 说了就改规则，不改产物
```

### 开跑顺序（同刀 1，只多一条双向烟测）

```
名单冻结（自算 sha）→ dry run 绿（residue 0 / anti 0 / 数量自检 0）
→ --write → 双向烟测（外壳→模块无缺键 / 模块→外壳无死键）→ 三张表
→ node 闸 → pytest → accept --stage 2 --expect-sha <自算>
```11. **`0 0` 只说明「指针对齐」，不说明「工作区干净」**（Architect 的话）：`git status -sb` 的
    `[ahead 0, behind 0]` 与 `git status --short` 的 `M`/`M ` 是两件事，**必须分开报**。
    看到 `0 0` 就以为可以放心提交，是今天那种「验错了对象」的又一形态。
    （出处：刀 1 推送后 `origin/main...HEAD → 0 0`，而 Worktree 里仍有未暂存/已暂存两行。）
## 11. QA 对照实验留下的四条待办（今天不修）

> **每一条都带这句：A/B 两组结果完全一致 → 不是刀 1 的回归。**
> 不写这句，明天第一个人会以为是今天弄坏的，重查一遍。

| # | 现象 | 类型 | 归属 | 证据 |
|---|---|---|---|---|
| ① | 选中页卡后页图约 0.6s 空白（`src` 换成 `size=zoom` 后未预载） | 真缺陷 | 待派 | **A/B 已证不是刀 1 回归**（两组 `naturalWidth 0 / complete false` 完全一致）；修法方向：先显示旧图/占位，别让图消失 |
| ② | 改回原类型后「已确认」不恢复（`unconfirmed` 标记未被撤销，摘要随之少 1 页） | 真缺陷 | 待派 | **A/B 已证不是刀 1 回归**；修法方向：撤销标记时要同步撤销 `unconfirmed` 并重算摘要 |
| ③ | 「版心」按钮看不出开/关（文案前后都是「版心」） | UX | Designer | **A/B 已证不是刀 1 回归** |
| ④ | 识别页两个按钮 `disabled` 但界面没说为什么 | UX | PM/Designer | **A/B 已证不是刀 1 回归**；用户规则：不该有「点了没反应」的入口 |12. **`--staged` 单独不够**：要让**工作区与索引同时**回到 HEAD，必须 `git restore --source=HEAD --staged --worktree <单一路径>`。
    只给 `--staged` 会留下旧内容在工作区 → 仍是 `M` → 一旦被提交就把旧值写回去。
    这是「改动一半在索引、一半在工作区」那类事故的**反向操作**——同一个机制，两个方向都会咬人。
    （出处：刀 1 收工前，`reading-view-boundary.md` 工作区是旧 sha、HEAD 是新 sha。）
