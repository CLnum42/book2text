# 前端单元测试（tests/js/）

Book2Text 的前端没有构建步骤（D-046），`app.js` 是**经典脚本**，不是 ES module。
这里用 `node:vm` 把它载进一个空壳上下文，直接调用它的顶层函数——**不改 app.js 一行**。

## 怎么跑

```bash
node tests/js/run.mjs
```

- 只用 Node 内置的 `node:test` / `node:assert` / `node:vm`，**不需要 npm install**，没有 `package.json` 依赖。
- 退出码：全绿 `0`，有失败 `1`。
- 耗时约 15ms（含加载 21k 行的 app.js）。
- macOS 上 `node` 可能不在默认 PATH：`/opt/homebrew/bin/node tests/js/run.mjs`。

对历史上某个版本跑同一批用例（用来证明用例真的会红）：

```bash
git show <commit>:backend/book2text/static/app.js > /tmp/app-old.js
B2T_APP_JS=/tmp/app-old.js node tests/js/run.mjs
```

只跑其中一个文件（旧版本可能还没有别的函数，整套跑会在加载阶段失败）：

```bash
B2T_APP_JS=/tmp/app-old.js node tests/js/run.mjs compute-char-spans
```

已知缺陷用 `test(name, { todo: "原因" }, fn)` 标记，不写成裸红（裸红会让 `run.mjs` 退出码非 0，
分不清"回归"和"已知缺陷"）。跑出来是 `⚠ … # 原因` + `ℹ todo N`，退出码仍是 0。

## 能力边界（重要，别越界）

| 能测 | 不能测 |
| --- | --- |
| 顶层 `function` 声明（参数进、值出、不读全局） | 依赖模块级 `let`/`var`/`const` 状态的函数 |
| 源码主动挂到 `window` 上的对象（如 `window.__b2tWordBoxStats`） | 需要真实 `document` / 布局 / 事件 / 网络的东西 |

原因：`vm.runInNewContext` 之后，只有函数声明会成为上下文全局对象的属性；顶层 `const`/`let`
留在 vm 的词法环境里，`ctx` 上取不到。所以**纯函数**能直接测，碰 DOM 和模块状态的函数不能。

另有一个坑，写测试前必须知道：`app.js` 第 14 行是
`const token = new URLSearchParams(location.search).get("token")`。
上下文里少给 `URLSearchParams`，脚本会在第 14 行就中断——函数声明照样能拿到（声明提升），
但一调用就 `ReferenceError: Cannot access 'x' before initialization`。
`load-app.mjs` 已经补了这些全局（`loadApp({ require: [...] })` 可指定本文件要用的函数，
对历史版本复跑时用），并且 `ranges` 是 vm 里另一个 realm 的数组，
比较前要 JSON 归一化，否则 `deepStrictEqual` 会因原型不同误报。

## 文件

- `load-app.mjs` —— 零侵入加载器：读源码、剥掉末尾的 `boot();`、给最小浏览器 stub、`vm.runInContext`。
- `reading-diff-units.test.mjs` —— `readingDiffUnits(lineText, candidate, wordBoxes)`（`app.js:19945`）。
  包含英文整行退化那次事故的回归用例。
- `compute-char-spans.test.mjs` —— `computeCharSpans(current, candidate)`（`app.js:11574`）：
  等长快路径 vs LCS、代理对（UTF-16 下标会切开代理对，挂 todo）、组合字符、全角标点、
  空输入、超长行的耗时上限（防 O(n²)）。
- `index-view-behavior.test.mjs` —— 目录确认视图的**行为改动**特征测试（Slice I1）：
  `loadPageIndex` 从"取数 + 写三处 DOM + 顺手渲染"改成纯数据服务，返回 `{status: ok|error|busy}`，
  渲染归模块的 `openPageIndex`。锁三条：① 预览那条路径调它时目录 DOM 一个字节都不写（哨兵）；
  ② 回目录时确实渲染（不然第一条可以靠"永远不渲染"骗过）；③ `busy` 时一个字不写且返回 busy 不是 error。
  变异：把 DOM 写点塞回 `loadPageIndex` / 去掉 `openPageIndex` 里的渲染 / busy 分支清列表，各自红。
  `B2T_INDEX_JS` 可把被测模块指到别处（变异验证用，与 `B2T_APP_JS` 同口径）。
- `boundary.test.mjs` —— 模块边界守门（R1 + R4，规格 `docs/refactor/reading-view-boundary.md` §6）：
  R1 新模块不许引用 app.js 的顶层声明（去注释/字符串，排除自己声明过的同名符号）；
  R4 同名函数只许一份真实现，其余 ≤6 行薄转发。`B2T_VIEW_JS` / `B2T_STATIC_DIR` 可指向别处复跑。
- `run.mjs` —— 入口，只汇总耗时和退出码，不替 `node:test` 宣布"全绿"。

## 一条踩过的坑：判定"代码行数"要用原文

`boundary.test.mjs` 的 R4 判"转发 stub 是否 ≤6 行"。第一版先抹注释再数行，结果**行尾注释
被当成空行 trim 掉**：7 行的 stub 被数成 1 行，变异验证跑绿（假通过）。

正确做法：**行数用原文（`bodyRaw`）数，注释行、空行都算一行；判断"只含转发调用"才用去注释后的 body。**
两件事用的是两份文本，混用就会漏判。以后所有"代码行数/体积"判定都照这个来。

## 去注释/字符串的扫描器必须认正则字面量

`boundary.test.mjs` 里所有静态检查都先把文件"去注释与字符串"再扫。第一版只处理
`//`、`/* */`、引号与模板串，**没处理正则字面量**——app.js 里的 `/["']/` 会被当成字符串开头，
把后面一大片代码抹成空白，"状态是否存在"直接误报 43 个。

写这类扫描器时必须：① 认正则字面量（`/` 前面是 `([{=,:;!&|?+-*%~^<>` 或 `return` 这类关键字时开正则，
并跳过转义与 `[...]` 字符类）；② 赋值点用**全位置**匹配，别用行首锚定——`{ foo = 1; }` 这种同行写法会漏。

## 静态扫描器的三条教训

1. **正则字面量必须识别**。`/["']/` 如果被当成字符串开头，会把后半个文件抹成空白——
   R5 的"状态是否存在"因此误报 43 个。识别规则：`/` 前面是 `([{=,:;!&|?+-*%~^<>` 或
   `return`/`typeof` 这类关键字时开正则，并跳过转义与 `[...]` 字符类。
2. **赋值点必须全位置匹配，不能行首锚定**。`{ readingPageNo = 5; }` 这种同行写法会被漏掉。
   排除属性写 `a.NAME =`、比较 `==/===/=>`、声明行 `let NAME =`。
3. **替换实现时别把辅助函数一起删掉**。改 `stripCommentsAndStrings` 时顺手删掉了
   `lineOf`/`columnOf`，R1/R4 直接 `ReferenceError`。辅助函数与主逻辑分开改、分开验证。


## 记录"位置"时必须记全部出现行，不能只记首次

R3 要判"某个 DOM id 的引用落在哪个函数里"。第一版用 `Map<id, 首个行号>`，变异验证时踩到：
**块内先引用一次、块外后来又引用一次**，只记首次会把块外那次吞掉，判定为绿——一个真实的越界被"实现偷懒"放过了。

正确做法：`domIdsIn` 记**该 id 的全部出现行**（`Map<id, 行号[]>`），再逐行找包围它的顶层函数。
同类教训在 R4 已经有过一次（"行数用原文数"）：**判据本身对，不代表实现没把它吃掉**。
写守卫时先问一句"我这个数据结构能不能表示反例"，表示不了就是漏。

## 例外表：上限必须跟着收

`boundary.test.mjs` 里有两张例外表（R1 的 `ALLOW`、R4b 的 `SAME_FILE_DUP_EXCEPTIONS`），
都带 `MAX` 上限。**删条目时必须同时把 `MAX` 收到实际条数**——只删行、不改上限，等于给未来
留了两格偷来的预算，下一个人往空位里塞新例外不用经过任何人。

例子：`c45b8a5` 删掉两对死代码时，`SAME_FILE_DUP_EXCEPTIONS` 从 3 条收到 1 条，
`SAME_FILE_DUP_EXCEPTION_MAX` 也从 3 收到 1。只做前半截，守卫会变松而不是变紧。

## 破环期的两道闸（§18）

**闸 B · 静态边棘轮**

```bash
node tests/js/edge-ratchet.mjs              # 期望非例外边全 0；不满足 = 退出码 1
node tests/js/edge-ratchet.mjs --expect-red # 期望 13/13 全红（只用于 base 证据）
B2T_STATIC_DIR=/tmp/rb-base/backend/book2text/static node tests/js/edge-ratchet.mjs --expect-red
```

- 13 条边 = 4 桥（桥内 `showView(` 计数）+ 9 回调边（caller 体内 callee 计数）
- 计数口径：**去注释与字符串后的全部出现**（不是首次；没去注释会多数出注释里的名字）
- 只降不升的预算在 `docs/refactor/edge-budget.json`：**每切一条边，在同一笔提交里改那一行**
  （预算在 docs/ 不在 tests/js，所以不撞闸 A 的 A1）。预算值必须等于当前计数、且不大于 base 实测值
- 3 条 app.js 内部桥走例外表（`edge-ratchet.mjs` 的 `BRIDGE_EXCEPTIONS`）：带 owner + 到期点、
  上限 3、归零即过期。**总条数始终 13**——改总数等于悄悄放宽

**待办：三个视图模块的 `exit()` 都是零调用点的导出（2026-10-29 记）**

`reading-view.js` / `preview-view.js` / `index-view.js` 都导出了 `exit`，但 **`showView` 从来没有调用过它**
（`grep '\.exit()' app.js` = 0）。按 R8 的精神，"有导出没入口"本身就是要解释的东西。
- 现状不红：R8 只锁"导出名单 ⊆ STABLE ∪ TEMPORARY 且总数只降"，不锁调用点。
- **没去接它是刻意的**：`showView → exit()` 是改行为（退出时要不要断 IntersectionObserver、
  要不要清草稿/面板），要单独一轮 + 证据，不能混在搬运里。
- 谁要动它：先在 §19 待办登记，接的时候补"退出后观察器已断/状态已清"的行为断言，
  否则又是一条"接上了但没人验证"的线。

**视图模块的对外接口（R6 / R2）**

- **R6**：每个 `static/*-view.js` 只许露**一个** `window.XxxYyy = …`，名字由文件名决定
  （`preview-view.js` → `PreviewView`）。两个接口 = 调用方不知道该记哪个，导出面也没法守。
  `window.__b2t*` 是调试/统计埋点，不算接口，但进例外表 `WINDOW_HOOK_EXCEPTIONS`：
  带 owner + 到期点、`MAX` 只降不升、**条目必须真的还在源码里**（删埋点同批删表项）。
  新增一个未登记的 `window.__b2tXxx` 也红——接口面就是这么被"顺手挂个调试对象"撑大的。
- **R2**：`x-view.js` 里不许出现 `window.YView`（Y ≠ X）的任何引用，跨视图能力一律走 `init(deps)`。
  直接摸对方的全局对象 = 把"模块先加载"的时序假设从 app.js 搬进模块之间，又变成运气。
- 两条现在都只有一个模块可查（`reading-view.js` → `ReadingView`），R2 暂时空转；
  **现在上闸的意义是：第二个模块出现时它已经在了**，不靠谁记得补。
- 两条各带自检：喂合成的 `preview-view.js`（名字错 / 两个接口 / 引用 `window.ReadingView`）
  必须红，正例必须绿——闸必须能被样例喂红，否则"绿"只是"扫描器没看见"。

**拆第二个视图模块时的两条硬规矩（preview 试点踩过）**

- **A. 接口函数用箭头 `const` 定义，别再写 `function init(...)`。**
  R4-dup 判"同名函数只许一份真实现"：`reading-view.js` 已有 `function init/enter/exit/getCurrent`，
  `preview-view.js` 再写 `function init` 就是两份真实现 → 红。
  `preview-view.js` 用 `const init = (deps) => {…}` 绕开了它。**这不是取巧，是模块契约**：
  第二个模块起，接口函数一律 `const`（Architect 会写进 §20；本节先记一笔）。
- **B. 每个视图拆完，R5 的 `OWNERS` 表要补该视图的状态。**
  表里没登记的状态**不会被检查**——`preview` 的 27 个状态现在不在表内，所以 R5 是绿的，
  但那不叫"合规"，叫"没覆盖"。整段搬完必须同批登记（owner = `preview-view.js`），
  否则下一次「一状态两处写」它一声不响。

**导出棘轮按模块建（D-100）**

`VIEW_EXPORTS` 一张表，每个 `*-view.js` 一条上限 + 一份导出名清单：

```
reading-view.js  ReadingView  6  init enter exit getCurrent reload toggleFollow
preview-view.js  PreviewView  3  init enter exit
index-view.js    IndexView    4  init enter exit refresh
```

- **起始值 = 落盘时的导出数**，只降不升；**导出名也一起锁**（多一个 / 少一个 / 改名都红）——
  只锁数量的话，`exit` 改名成 `leave` 照样绿。
- 磁盘上出现没登记的 `*-view.js` → 红（和 `VIEW_STATE_PREFIXES` 同一个形态：新视图落盘必须同批登记）；
  表里登记了但文件不在 → 也算过期。
- 为什么：R8 原来只锁 `ReadingView`，第二、第三个模块落盘后谁的导出数都没人管——
  它们可以一路长成上帝对象而 R8 一直绿。
- 模块加载失败（语法错 / 顶层就抛）会被报成一条可读的问题，不让整条测试炸在 vm 里。

**机检覆盖：11/11**
（R1 R2 R3 R4 R5 R6 R7 R8 R9 R11 R12；**R10 是评审清单、不能机检，不计入分母**）

**闸 A · 特征测试契约**

- 静态部分（A1/A1b/A3）在 `boundary.test.mjs` 的 R12：产品提交不许碰 `tests/js`；序列删除行 = 0；
  改旧断言必须单开 `test-contract:` 提交并登记 §18.6
- 运行部分（A2 回放 / A4 变异红）用 `tests/js/mutation-check.mjs`（同一份测试在 base worktree 上先绿、插变异后必须红）

## 不是本目录该干的事

- 端到端验收（真浏览器、真库）：`tests/e2e/`，QA 的地盘，不要在这里复制。
- 后端逻辑：`tests/unit`、`tests/integration`（pytest）。
- 单元测试绿 ≠ 产品对。渲染、导出、交互仍以 QA 的五条底线为准。
