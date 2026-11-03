// 跨根取 DOM 的机械判据：`part("x")` 的 x 必须落在 root① 子树里，`reviewPart("x")` 必须落在 root② 子树里。
//
// 为什么要有它（2026-11-03，两刀里第二次）：`page-number-panel.js` 里 `part("page-number-review-close")`
// —— `part()` 在 root① 子树里查，而审校面板是 root② ⇒ 返回 null ⇒ `null.addEventListener` 在 boot 里抛
// ⇒ 首屏 0 卡。**静态闸全绿、真机一看就白**，和 #25/#26（转发名不存在 / init 顺序）是同一族：
// 跨边界取东西，名字对不上，静态看都"有那么个字符串"，运行时才炸。
//
// 判据：
//   ① 从模块源码认出「helper → 根变量」：`const part = (id) => (root ? root.querySelector(...)`
//      ⇒ part 用 root；`const reviewPart = ... reviewRoot ...` ⇒ reviewPart 用 reviewRoot；
//   ② 根变量 → 根 id：从 app.js 里该模块的 `init({ … root: el("page-number-panel"), reviewRoot: el(…) })` 取；
//   ③ id 集合**从 index.html 的真实嵌套算**（复用 scripts/id-host-map.mjs 的解析器，不另写一套）；
//   ④ 任何 `helper("x")` 的 x 不在对应子树里 ⇒ 红，点名 file:line 与两边。
//   ⑤ x **必须是根的后代**：x 等于根自己的 id 也红——「在子树里查某个 id」与「那个 id 就是子树根」
//      是两件事（2026-11-03 第 4 次同族事故），一句话：**归属对 ≠ 取法对**——
//      `page-number-review-panel` 确实归 root②（它就是 root②），归属那关是绿的，取的时候照样炸。
//      `root.querySelector("#自己")` 恒为 null
//      （只找后代），真机上 `.hidden` 抛 TypeError；上一版把根算进子树，所以这条是盲区。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mapIdHosts } from "../../scripts/id-host-map.mjs";
import { codeOnly } from "./static-scan.mjs";

const STATIC_DIR = process.env.B2T_STATIC_DIR
  || fileURLToPath(new URL("../../backend/book2text/static/", import.meta.url));
const APP_FILE = process.env.B2T_APP_JS || join(STATIC_DIR, "app.js");

/** 某个 id 的整棵子树（含自己），用 index.html 的真实嵌套算。 */
export function subtreeOf(entries, rootId) {
  const children = new Map();
  for (const entry of entries) {
    if (!children.has(entry.host)) children.set(entry.host, []);
    children.get(entry.host).push(entry.id);
  }
  const out = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/** 从 app.js 里某个模块的 init 块取「注入名 → el("id")」映射（root / reviewRoot 就是这么来的）。 */
export function initRootArgs(appSource, exposes) {
  const code = codeOnly(appSource);
  const start = code.indexOf(`${exposes}?.init({`) >= 0
    ? code.indexOf(`${exposes}?.init({`)
    : code.indexOf(`${exposes}.init({`);
  if (start < 0) return {};
  const open = code.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return {};
  const block = code.slice(open + 1, end);
  const out = {};
  for (const match of block.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(?:el|document\.getElementById)\(\s*"([^"]+)"\s*\)/g)) {
    out[match[1]] = match[2];
  }
  return out;
}

/** 模块里的 helper 定义：`const part = (id) => (root ? …)` → part 绑到 root。 */
export function helperRootVars(moduleSource) {
  const code = codeOnly(moduleSource);
  const out = new Map();
  for (const match of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*=>\s*\(?\s*([A-Za-z_$][\w$]*)\s*\?/g)) {
    out.set(match[1], match[2]);
  }
  return out;
}

/**
 * 判据内核：`helper("id")` 的 id 必须在 helper 所用根变量的子树里。
 * 返回 `{ problems, scanned }`（scanned = 真正判过的调用点数，用于报告口径）。
 */
export function rootScopeProblems({ modules, bootRoots, entries }) {
  const problems = [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let scanned = 0;
  for (const { file, source, exposes } of modules) {
    const helpers = helperRootVars(source);
    let roots = bootRoots.get(exposes) || {};
    if (helpers.size === 0) continue;
    // 没有任何 el("id") 形态的根（例如 root 由别处传）：退回模块自己 init 里的 `root = injected.root`
    const code = codeOnly(source);
    for (const [helper, rootVar] of helpers) {
      const rootId = roots[rootVar];
      if (!rootId) {
        // 找不到根 ⇒ 这条 helper 判不了。别静默放过：说清是"没解析到根"，不是"没问题"
        if (new RegExp(`\\b${helper}\\s*\\(\\s*"`).test(code)) {
          problems.push(`${file} 用了 ${helper}() 但解析不到根变量 ${rootVar} 对应的 id`
            + "（app.js 的 init 里应有 `" + rootVar + ': el("…")`）——这条调用没验到');
        }
        continue;
      }
      const allowed = subtreeOf(entries, rootId);
      const lineOf = (index) => code.slice(0, index).split("\n").length;
      for (const match of code.matchAll(new RegExp(`\\b${helper}\\s*\\(\\s*"([^"]+)"`, "g"))) {
        const id = match[1];
        scanned += 1;
        // 「在子树里查某个 id」与「那个 id 就是子树根」是两件事（2026-11-03，第 4 次同族事故）：
        // `root.querySelector("#自己的 id")` **恒为 null** —— querySelector 只找后代，不匹配根自己。
        // 上一版把根自己算进子树（`subtreeOf` 含根），于是 reviewPart("page-number-review-panel")
        // 过闸，真机上 `.hidden` 抛 TypeError ⇒ 跳过 onPageNumberChanged ⇒ 侧栏数字不更新。
        if (id === rootId) {
          problems.push(`${file}:${lineOf(match.index)} ${helper}("${id}")——`
            + `这个 id 就是根 #${rootId} 自身；root.querySelector("#自己") 恒为 null`
            + "（querySelector 只在后代里找，不匹配根自己），拿到 null 再 .hidden / .addEventListener 就抛。"
            + "要判根自己，用 root 属性/变量，不要走 querySelector");
          continue;
        }
        if (allowed.has(id)) continue;
        const owner = byId.get(id);
        problems.push(`${file}:${lineOf(match.index)} ${helper}("${id}")——这个 id 不在 ${helper} 用的根 `
          + `#${rootId} 子树里（${owner ? `它归 #${owner.host || "(no id ancestor)"}` : "index.html 里没有这个 id"}）；`
          + "跨根查询拿到的是 null，boot 里用它会直接抛");
      }
    }
  }
  return { problems, scanned };
}

function loadTree(staticDir) {
  const appSource = readFileSync(join(staticDir, "app.js"), "utf8");
  const html = readFileSync(join(staticDir, "index.html"), "utf8");
  const { entries } = mapIdHosts(html);
  const modules = [];
  for (const file of readdirSync(staticDir).filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(join(staticDir, file), "utf8");
    const exposes = /window\.([A-Z][A-Za-z0-9_$]*)\s*=/.exec(source)?.[1];
    if (!exposes) continue;
    if (!/=>\s*\(?\s*[A-Za-z_$][\w$]*\s*\?\s*[A-Za-z_$][\w$]*\.querySelector/.test(source)) continue;
    modules.push({ file, source, exposes });
  }
  const bootRoots = new Map(modules.map(({ exposes }) => [exposes, initRootArgs(appSource, exposes)]));
  return { entries, modules, bootRoots };
}

const TREE = loadTree(STATIC_DIR);

test("跨根取 DOM：part()/reviewPart() 的参数必须落在各自根的子树里", () => {
  const { problems, scanned } = rootScopeProblems(TREE);
  assert.deepEqual(problems, [], problems.join("\n"));
  console.log(`ℹ 跨根判据：扫了 ${TREE.modules.length} 个模块 · ${scanned} 个 helper 调用点`);
});

test("跨根取 DOM 自检（合成夹具）：part 取 root② 的 id ⇒ 红；reviewPart 取同一个 id ⇒ 绿", () => {
  // 夹具：两个根是兄弟（都不在对方子树里），正是 page-number-panel 的形状
  const html = [
    '<body>',
    '  <div id="root-one"><span id="one-a"></span></div>',
    '  <div id="root-two"><span id="two-a"></span></div>',
    '</body>',
  ].join("\n");
  const { entries } = mapIdHosts(html);
  const appSource = [
    "function boot() {",
    '  window.Panel?.init({ root: el("root-one"), reviewRoot: el("root-two") });',
    "}",
  ].join("\n");
  const moduleSource = [
    "(function () {",
    "  let root = null;",
    "  let reviewRoot = null;",
    "  const part = (id) => (root ? root.querySelector(`#${id}`) : null);",
    "  const reviewPart = (id) => (reviewRoot ? reviewRoot.querySelector(`#${id}`) : null);",
    "  window.Panel = { init() {} };",
    "})();",
  ].join("\n");
  const run = (body) => rootScopeProblems({
    modules: [{ file: "panel.js", source: `${moduleSource}\n${body}`, exposes: "Panel" }],
    bootRoots: new Map([["Panel", initRootArgs(appSource, "Panel")]]),
    entries,
  });

  // 坏：part 去查 root② 的 id（当初那次 boot 崩溃就是这个形状）
  const bad = run('part("two-a");');
  assert.ok(bad.problems.some((one) => one.includes('part("two-a")') && one.includes("#root-one")),
    `part 跨根查询没红：${bad.problems.join("；") || "(无)"}`);
  assert.ok(bad.problems.some((one) => one.includes("它归 #root-two")),
    `红文没说清这个 id 归哪个根：${bad.problems.join("；")}`);

  // 坏：id 就是根自己 ⇒ querySelector 恒为 null（今天这次真实回归的形状）
  const selfRoot = run('part("root-one"); reviewPart("root-two");');
  assert.equal(selfRoot.problems.length, 2, `根自己应各红一条，实际：${selfRoot.problems.join("；") || "(无)"}`);
  assert.ok(selfRoot.problems[0].includes('part("root-one")') && selfRoot.problems[0].includes("就是根 #root-one 自身"),
    `根自己的红文没说清是根自身：${selfRoot.problems[0]}`);
  assert.ok(selfRoot.problems[0].includes("恒为 null") && selfRoot.problems[0].includes("不要走 querySelector"),
    `根自己的红文没给出解法：${selfRoot.problems[0]}`);
  assert.ok(selfRoot.problems[1].includes("就是根 #root-two 自身"),
    `reviewPart 取 reviewRoot 自己没红：${selfRoot.problems[1]}`);

  // 好：同一个 id 走 reviewPart 就合法；part 查自己子树的 id 也合法
  assert.deepEqual(run('reviewPart("two-a"); part("one-a");').problems, [],
    "合规写法被误报——判据会把整条闸变成假红源");
});

test("跨根取 DOM 自检（真历史代码，可选）：934cfe8^ 红 / 934cfe8 绿", (t) => {
  const badDir = process.env.B2T_ROOT_SCOPE_BAD;
  const goodDir = process.env.B2T_ROOT_SCOPE_GOOD;
  if (!badDir || !goodDir) {
    console.log("… 跳过历史树自检：未设 B2T_ROOT_SCOPE_BAD / B2T_ROOT_SCOPE_GOOD（合成夹具那条已覆盖判据本体）");
    t.skip("未提供历史树目录");
    return;
  }
  const bad = rootScopeProblems(loadTree(badDir));
  assert.ok(bad.problems.some((one) => one.includes("page-number-review-close")),
    `修前那版没红：${bad.problems.join("；") || "(一条不匹配都没有)"}`);
  const good = rootScopeProblems(loadTree(goodDir));
  assert.deepEqual(good.problems, [], good.problems.join("\n"));
});

test("跨根取 DOM 自检（真代码，可选）：根自己那处必须红（934cfe8 / ca82b0f 的 :386/:412）", (t) => {
  const dir = process.env.B2T_ROOT_SCOPE_SELF;
  if (!dir) {
    console.log("… 跳过：未设 B2T_ROOT_SCOPE_SELF（指向有「reviewPart(根自己)」那版 static 目录）");
    t.skip("未提供目录");
    return;
  }
  const { problems } = rootScopeProblems(loadTree(dir));
  for (const line of [386, 412]) {
    assert.ok(
      problems.some((one) => one.includes(`page-number-panel.js:${line}`) && one.includes("就是根")),
      `page-number-panel.js:${line} 那处「reviewPart(根自己)」没红：${problems.join("；") || "(一条都没有)"}`,
    );
  }
});
