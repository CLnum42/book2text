// 模块接线闸：① 跨模块转发名必须真实存在；② boot 里模块的 init 必须最先。
//
// 两处都是 2026-11-03 那次"主线被打断、四闸全绿"的直接成因：
//
//   闸 A：app.js 里 `window.PageDetailEditor?.setEditorPackageModeChrome(...)` 与
//        `window.PageDetailEditor?.showPageDetailError(...)` —— 前者 editor 的导出名是
//        `setPackageModeChrome`，后者 editor 根本没有这个导出。`?.` 可选链 ⇒ 不报错、
//        返回 undefined、调用变 no-op，错误还被 catch 吞掉。QA 靠手对集才发现。
//   闸 B：`PageDetailDrawer.setupReviewPager()` 在 `PageDetailDrawer.init()` **之前**
//        （8202 vs 8470），而 `part()` 依赖 init 给的 root ⇒ 一进审校就崩。
//
// 判据要点：
//   · 模块的 api 键集合**靠执行模块拿**（`window.X = api` 之后 Object.keys），不是正则抠文本——
//     抠文本会漏掉简写与多层对象（第一次原型就漏了 4 个模块，全显示 0 个键）；
//   · 扫描前**剥注释**：app.js 里有一句注释写着 `window.ReviewView.showError(error)`（未来计划），
//     不剥就会被当成真调用，报一条假红；
//   · boot 里**含 `=>` 的行不算**：依赖对象里的箭头函数是"以后才调"，不是 boot 期间的顺序
//     （不排除的话会报 10 条假红，全是 deps 转发）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { codeOnly } from "./static-scan.mjs";

const STATIC_DIR = process.env.B2T_STATIC_DIR
  || fileURLToPath(new URL("../../backend/book2text/static/", import.meta.url));
const APP_FILE = process.env.B2T_APP_JS || join(STATIC_DIR, "app.js");

/**
 * 在最小沙箱里执行模块，读出它挂在 window 上的 api 键集合（键名以**执行结果**为准）。
 *
 * 返回 `{ exports, owners, failures }`：
 *   - `owners`：**文本**里声明的 `window.<Name> = api`（模块名 → 文件），加载失败也认得它；
 *   - `exports`：执行成功后的键集合；
 *   - `failures`：**声明了导出、但执行时抛了**的模块（名字 → 错误）。
 *
 * 为什么要有 failures（Chief 2026-11-03 点名）：加载失败的模块如果没有键表，
 * 闸 A 会报"没有任何模块导出 X"或"api 里没有 key"——**满地被冤枉的假红**，
 * 然后这条闸就会被人以"误报太多"为由关掉。必须分开报："这个模块没验到"，不是"键不存在"。
 */
export function moduleExports(staticDir = STATIC_DIR) {
  const modules = new Map();
  const owners = new Map();
  const failures = new Map();
  for (const file of readdirSync(staticDir).filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(join(staticDir, file), "utf8");
    // 两种挂法都要认：服务模块 `window.X = api`、视图模块 `window.X = { … }`（收窄成 `= api` 会
    // 把 5 个 *-view.js 整个排除在外，于是它们的每次转发都被报成"没有这个模块"——我写坏过一次）
    const declared = /window\.([A-Z][A-Za-z0-9_$]*)\s*=/.exec(source);
    if (!declared) continue;
    owners.set(declared[1], file);
    const sandbox = {
      console,
      document: {
        getElementById: () => null,
        createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, addEventListener() {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    try {
      vm.runInNewContext(source, sandbox, { filename: file });
    } catch (error) {
      // **不静默跳过**：声明了 window.X = api 却跑不起来，就是"这个模块没验到"
      failures.set(declared[1], { file, error: String((error && error.message) || error).split("\n")[0].slice(0, 120) });
      continue;
    }
    for (const name of Object.keys(sandbox)) {
      if (!/^[A-Z]/.test(name)) continue;
      const value = sandbox[name];
      if (!value || typeof value !== "object") continue;
      if (!modules.has(name)) modules.set(name, { file, keys: new Set(Object.keys(value)) });
    }
  }
  return { exports: modules, owners, failures };
}

/** 闸 A：app.js 里 `window.<模块>[?].<键>` 的键必须在那个模块的 api 里。 */
export function forwarderProblems({ appSource, modules, failures = new Map(), owners = new Map() }) {
  const problems = [];
  const code = codeOnly(appSource);
  const lineOf = (index) => code.slice(0, index).split("\n").length;
  if (!modules || modules.size === 0) return ["一个模块的导出面都没读到——这条判据在空转"];
  // fail closed：声明了导出却加载失败的模块，单独一条红。它的键表是空的，但**不是"键不存在"**
  for (const [name, failure] of failures) {
    problems.push(`模块 ${name}（${failure.file}）没验到——它声明了 window.${name} = api，但执行时抛了：`
      + `${failure.error}。这是**判据缺口**，不是"转发名写错"，别照着它去改 app.js`);
  }
  for (const match of code.matchAll(/window\.([A-Z][A-Za-z0-9_$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) {
    const [, moduleName, key] = match;
    const info = modules.get(moduleName);
    if (!info) {
      // 名字在文本里声明过但没验到 ⇒ 已经由上面那条 fail-closed 报过，这里不再冤枉它
      if (failures.has(moduleName) || owners.has(moduleName)) continue;
      problems.push(`app.js:${lineOf(match.index)} window.${moduleName}?.${key}——`
        + `没有任何模块导出 ${moduleName}（模块名拼错，或它还没挂 window）`);
      continue;
    }
    if (info.keys.has(key)) continue;
    problems.push(`app.js:${lineOf(match.index)} window.${moduleName}?.${key}——`
      + `${info.file} 的 api 里没有 ${key}（有 ${[...info.keys].slice(0, 4).join(" / ")}…）；`
      + "`?.` 会让它静默变成 no-op");
  }
  return problems;
}

/** 取 `function NAME(` 的函数体行范围（花括号配对；用剥过注释/字符串的源码配平）。 */
export function functionBodyRange(source, name) {
  const code = codeOnly(source);
  const lines = code.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^function ${name}\\s*\\(`).test(line));
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && i > start) return { start: start + 1, end: i + 1 };
      }
    }
  }
  return null;
}

/** 闸 B：boot 里每个模块的首次 `X.init(` 必须早于该模块其它调用的首次出现。 */
export function bootOrderProblems({ appSource }) {
  const code = codeOnly(appSource);
  const lines = code.split("\n");
  const range = functionBodyRange(appSource, "boot");
  if (!range) return ["找不到 function boot( ——这条判据在空转"];
  const first = new Map();
  let seenAny = 0;
  for (let line = range.start; line <= range.end; line += 1) {
    const text = lines[line - 1] || "";
    seenAny += [...text.matchAll(/\b[A-Z][A-Za-z0-9_$]*\s*\??\.\s*[A-Za-z_$][\w$]*\s*\(/g)].length;
    if (text.includes("=>")) continue;   // 依赖里的箭头函数是"以后才调"，不算 boot 期间的顺序
    for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
      const [, moduleName, key] = match;
      if (!first.has(moduleName)) first.set(moduleName, new Map());
      if (!first.get(moduleName).has(key)) first.get(moduleName).set(key, line);
    }
  }
  const problems = [];
  for (const [moduleName, calls] of first) {
    const initLine = calls.get("init");
    const others = [...calls].filter(([key]) => key !== "init").sort((a, b) => a[1] - b[1]);
    if (initLine === undefined || others.length === 0) continue;
    if (others[0][1] < initLine) {
      problems.push(`boot 里先调了 ${moduleName}.${others[0][0]}（第 ${others[0][1]} 行），`
        + `而 ${moduleName}.init 在第 ${initLine} 行——init 之前用它的能力，root 还没给它`);
    }
  }
  // 空转判定看**整段 boot**（含箭头里那些）：整段一个模块调用都没有，才是扫描失效
  if (seenAny === 0) problems.push("boot 里一个模块调用都没扫到——这条判据在空转");
  return problems;
}

const { exports: MODULES, owners: MODULE_OWNERS, failures: LOAD_FAILURES } = moduleExports();

test("模块接线 A：app.js 里 window.<模块>?.<键> 的键必须真的在那个模块的 api 里", () => {
  const problems = forwarderProblems({
    appSource: readFileSync(APP_FILE, "utf8"), modules: MODULES, failures: LOAD_FAILURES, owners: MODULE_OWNERS,
  });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("模块接线 B：boot 里每个模块的 init 必须早于它的其它调用", () => {
  const problems = bootOrderProblems({ appSource: readFileSync(APP_FILE, "utf8") });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("模块接线自检 A：转发名写错 ⇒ 红并点名（含模块名与键）", () => {
  const modules = new Map([["PageDetailEditor", { file: "page-detail-editor.js", keys: new Set(["init", "setPackageModeChrome"]) }]]);
  const fake = "function boot() {\n  window.PageDetailEditor?.setEditorPackageModeChrome(1);\n}\n";
  const problems = forwarderProblems({ appSource: fake, modules });
  assert.equal(problems.length, 1, "转发名写错却没红——`?.` 会把它变成 no-op");
  assert.ok(problems[0].includes("app.js:2") && problems[0].includes("setEditorPackageModeChrome"),
    `红文没点名行号与键：${problems[0]}`);

  // 正确名字必须绿（证明红的是"写错"，不是"一律红"）
  assert.deepEqual(forwarderProblems({ appSource: "window.PageDetailEditor?.setPackageModeChrome(1);\n", modules }), []);
  // 模块名本身写错（拼错模块）也要红
  assert.ok(forwarderProblems({ appSource: "window.PageDetailEditr?.init(1);\n", modules })
    .some((message) => message.includes("没有任何模块导出 PageDetailEditr")), "模块名拼错没红");
  // 空模块表 ⇒ 判据空转，必须红
  assert.ok(forwarderProblems({ appSource: "", modules: new Map() }).length > 0, "空模块表被放过");
});

test("模块接线自检 B：把某个能力挪到 init 之前 ⇒ 红并点名", () => {
  const broken = 'function boot() {\n  PageDetailDrawer.setupReviewPager();\n  PageDetailDrawer.init({ root: el("x") });\n}\n';
  const problems = bootOrderProblems({ appSource: broken });
  assert.equal(problems.length, 1, "先调 setupReviewPager 再 init 却没红");
  assert.ok(problems[0].includes("setupReviewPager") && problems[0].includes("第 2 行"), problems[0]);

  // init 在前的正确顺序必须绿
  const good = 'function boot() {\n  PageDetailDrawer.init({ root: el("x") });\n  PageDetailDrawer.setupReviewPager();\n}\n';
  assert.deepEqual(bootOrderProblems({ appSource: good }), []);
  // 依赖里的箭头函数不算顺序（否则 deps 转发会报一堆假红）
  const deps = 'function boot() {\n  PagesView.init({ onTaskProgress: () => PagesView.onTaskProgress() });\n}\n';
  assert.deepEqual(bootOrderProblems({ appSource: deps }), []);
  // 没有 boot ⇒ 空转红
  assert.ok(bootOrderProblems({ appSource: "function notBoot() {}\n" }).length > 0, "找不到 boot 被放过");
});

test("模块接线自检 C（fail-closed）：模块顶层抛错 ⇒ 报「没验到」，不许报「键不存在」", () => {
  // 这是这条闸唯一可能退化成"满地假红然后被关掉"的口子：加载失败的模块没有键表，
  // 如果照常走键检查，就会报"api 里没有 key"——那是冤枉，改的人会去翻一个根本没问题的转发。
  const dir = mkdtempSync(join(tmpdir(), "b2t-modwiring-"));
  try {
    writeFileSync(join(dir, "boom.js"),
      'const api = { init() {} };\nwindow.Boom = api;\nthrow new Error("模块顶层就抛了");\n');
    writeFileSync(join(dir, "fine.js"),
      'const api = { init() {} };\nwindow.Fine = api;\n');
    const { exports, owners, failures } = moduleExports(dir);
    assert.equal(failures.size, 1, `加载失败没被记下来（failures=${failures.size}）——它会静默变成"键不存在"`);
    assert.ok(failures.has("Boom"), "失败模块名没记下来");
    assert.ok(owners.has("Boom"), "文本里声明过的模块名没记下来（失败时也要认得它）");
    assert.ok(!exports.has("Boom"), "加载失败的模块不该出现在导出面里");

    const problems = forwarderProblems({
      appSource: 'window.Boom?.init(1);\nwindow.Boom?.noSuchFn(2);\nwindow.Fine?.init(3);\n',
      modules: exports, failures, owners,
    });
    const text = problems.join("\n");
    assert.ok(text.includes("没验到"), `没有报"没验到"：${text}`);
    assert.ok(!text.includes("api 里没有 noSuchFn"), `把"没验到"错报成"键不存在"（假红）：${text}`);
    assert.ok(!problems.some((one) => one.includes("没有任何模块导出 Boom")), "把失败模块报成「不存在」（假红）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
