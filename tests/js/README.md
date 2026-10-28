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
- `run.mjs` —— 入口，只汇总耗时和退出码，不替 `node:test` 宣布"全绿"。

## 不是本目录该干的事

- 端到端验收（真浏览器、真库）：`tests/e2e/`，QA 的地盘，不要在这里复制。
- 后端逻辑：`tests/unit`、`tests/integration`（pytest）。
- 单元测试绿 ≠ 产品对。渲染、导出、交互仍以 QA 的五条底线为准。
