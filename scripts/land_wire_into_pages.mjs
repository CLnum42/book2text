#!/usr/bin/env node
/**
 * scripts/land_wire_into_pages.mjs —— 刀 2 的一次性迁移：把 app.js 里 14 个 `wirePagesXxx`
 * 搬进 `pages-view.js`（私有函数 + `wireAll()`），并删掉 8 个宿主里的 14 行调用。
 *
 * 用法（**默认只写到 --out，不改真文件**）：
 *   node scripts/land_wire_into_pages.mjs --out /tmp/b2t-builder-wireinit
 *   node scripts/land_wire_into_pages.mjs --write        # 真落盘（本轮不用）
 *
 * 改写规则（§① R1：模块里不许出现 app.js 顶层名）：
 *   · 裸调用 `<fn>(` → `injected.<fn>(`，`fn` = app.js 的顶层函数名（脚本现扫，不靠手抄）
 *   · `currentProject` → `injected.getCurrentProject()`
 *   · `selectedPages`  → `injected.getSelectedPages()`
 *   局部变量（参数 / const / let / var）不参与改写。
 *
 * 三条判据（跑完打印）：
 *   ① R1：模块里是否还有 app.js 顶层名（裸引用）
 *   ② 行级：app.js 删掉的行与模块新增的行做多重集差（模块侧允许 `injected.` 前缀差异）
 *   ③ R3：`view-pages` 子树 id 在 app.js 里的处数（搬前 → 搬后）
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { join, dirname } from "node:path";

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const WRITE = args.includes("--write");
const OUT = getArg("--out", "");
const APP_REL = getArg("--app", "backend/book2text/static/app.js");
const MOD_REL = getArg("--module", "backend/book2text/static/pages-view.js");

if (args.includes("--check-only")) {
  const target = getArg("--module", "backend/book2text/static/pages-view.js");
  const text = readFileSync(target, "utf8");
  const problem = assertWireAllBeforeReturn(text);
  if (problem) { console.log(`✗ 自检（wireAll 位置）：${problem}`); process.exit(1); }
  console.log("✓ 自检（wireAll 位置）：在 init 体内且在第一个 return 之前");
  process.exit(0);
}

const appSrc = readFileSync(APP_REL, "utf8");
const modSrc = readFileSync(MOD_REL, "utf8");
const appLines = appSrc.split("\n");
const modLines = modSrc.split("\n");

// ---- 1. 找出 14 个 wire 函数（含紧贴上方的 /** … *\/ 注释）----------------------
const WIRE_RE = /^function (wirePages[A-Za-z0-9_]+)\(\) \{$/;
const wires = [];
appLines.forEach((line, i) => {
  const m = line.match(WIRE_RE);
  if (!m) return;
  // 向上吃掉注释块
  let start = i;
  if (appLines[start - 1] !== undefined && appLines[start - 1].trimEnd() === " */") {
    let k = start - 1;
    while (k >= 0 && !/^\s*\/\*\*/.test(appLines[k])) k -= 1;
    if (k >= 0) start = k;
  }
  // 配平花括号
  let depth = 0;
  let end = i;
  for (let k = i; k < appLines.length; k += 1) {
    for (const ch of appLines[k]) {
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) { end = k; break; }
      }
    }
    if (depth === 0 && k > i) break;
  }
  wires.push({ name: m[1], start, end, call: i });
});
if (wires.length !== 14) {
  console.error(`✗ 期望 14 个 wirePagesXxx，实际 ${wires.length} 个`);
  process.exit(2);
}

// ---- 2. app.js 顶层名（用于把裸调用改写成 injected.*）---------------------------
const topLevel = new Set();
for (const m of appSrc.matchAll(/^(?:async\s+)?function ([A-Za-z_$][\w$]*)\s*\(/gm)) topLevel.add(m[1]);
for (const m of appSrc.matchAll(/^(?:const|let|var) ([A-Za-z_$][\w$]*)\s*=/gm)) topLevel.add(m[1]);
for (const w of wires) topLevel.delete(w.name);

/** 每个函数体里的局部名（参数 / const / let / var），不参与改写。 */
function localsOf(body) {
  const locals = new Set();
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) locals.add(m[1]);
  for (const m of body.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().replace(/=.*$/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) locals.add(n);
    }
  }
  for (const m of body.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) locals.add(m[1]);
  return locals;
}

/**
 * 模块自己已经有的名字：不许改写成 injected.*（否则会把自己的本地函数改成注入）。
 * 这里**现扫模块**（`function X` / `const X`），不靠手抄——DevLead 捞出的 bug 就是
 * `renderPages` 是刀 1 已搬进模块的函数，被误改成 `injected.renderPages`：
 * R13 会报「注入表没这个键」，而模块里明明有同名函数，两条红一起把人往 deps 方向带。
 */
const MODULE_LOCAL = new Set(["el", "init", "api", "injected"]);
for (const m of modSrc.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) MODULE_LOCAL.add(m[1]);
for (const m of modSrc.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) MODULE_LOCAL.add(m[1]);

/** 把一段 app.js 代码改写成模块内可用的形态（裸顶层名 → injected.*）；注释行原样保留。 */
function rewrite(body) {
  const locals = localsOf(body);
  const applied = new Set();
  const varMap = { currentProject: "injected.getCurrentProject()", selectedPages: "injected.getSelectedPages()" };
  const rewriteLine = (line) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return line;   // 注释不参与改写
    let out = line;
    for (const [from, to] of Object.entries(varMap)) {
      if (locals.has(from) || MODULE_LOCAL.has(from)) continue;
      const re = new RegExp(`(?<![\\w$.])${from}(?![\\w$])`, "g");
      if (re.test(out)) { out = out.replace(re, to); applied.add(`${from} → ${to}`); }
    }
    for (const name of [...topLevel].filter((n) => !locals.has(n) && !MODULE_LOCAL.has(n)).sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`(?<![\\w$.])${name}(?=\\s*\\()`, "g");
      if (re.test(out)) { out = out.replace(re, `injected.${name}`); applied.add(`${name} → injected.${name}`); }
    }
    // 第二遍：裸引用（作为实参传出去，如 addEventListener("click", renderPages)）
    for (const name of [...topLevel].filter((n) => !locals.has(n) && !MODULE_LOCAL.has(n)).sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g");
      if (re.test(out)) { out = out.replace(re, `injected.${name}`); applied.add(`${name} → injected.${name}（引用）`); }
    }
    return out;
  };
  return { out: body.split("\n").map(rewriteLine).join("\n"), applied };
}

// ---- 3. 组装 -----------------------------------------------------------------
const moved = [];
const appKeep = [];
const cutRanges = wires.map((w) => [w.start, w.end]).sort((a, b) => a[0] - b[0]);
const inCut = new Set();
for (const [a, b] of cutRanges) for (let k = a; k <= b; k += 1) inCut.add(k);

const callLines = new Set();
for (const w of wires) {
  // 宿主里的调用行：`  wireXxx();`
  const idx = appLines.findIndex((l) => l.trim() === `${w.name}();`);
  if (idx < 0) { console.error(`✗ 找不到 ${w.name}() 的调用行`); process.exit(2); }
  callLines.add(idx);
}

for (let i = 0; i < appLines.length; i += 1) {
  if (inCut.has(i)) { moved.push(appLines[i]); continue; }
  if (callLines.has(i)) continue; // 宿主调用行整行删掉
  appKeep.push(appLines[i]);
}

const movedBodies = wires.map((w) => {
  const raw = appLines.slice(w.start, w.end + 1).join("\n");
  const { out, applied } = rewrite(raw);
  return { name: w.name, raw, out, applied };
});

const allApplied = new Set();
for (const b of movedBodies) for (const a of b.applied) allApplied.add(a);

const wireAll = [
  "/** 刀 2：14 段接线在本模块初始化时统一挂载（顺序 = 它们在 app.js 里的原顺序）。 */",
  "function wireAll() {",
  ...movedBodies.map((b) => `  ${b.name}();`),
  "}",
].join("\n");

// 插到 `window.PagesView = api;` 之前（IIFE 内，函数声明会提升）
const anchor = modLines.findIndex((l) => l.includes("window.PagesView = api;"));
if (anchor < 0) { console.error("✗ 模块里找不到 window.PagesView = api;"); process.exit(2); }
const modOut = [
  ...modLines.slice(0, anchor),
  "// ---------------------------------------------------------------- 刀 2：14 段 pages 接线",
  ...movedBodies.map((b) => b.out),
  "",
  wireAll,
  "",
  ...modLines.slice(anchor),
];

// init 末尾调 wireAll()：找 `function init(` 的函数体，插在最后一个 `}` 之前
const modText = modOut.join("\n");
const initIdx = modText.search(/^\s*function init\(/m);
if (initIdx < 0) { console.error("✗ 模块里找不到 function init("); process.exit(2); }
const openBrace = modText.indexOf("{", initIdx);
let depth = 0;
let initEnd = -1;
for (let k = openBrace; k < modText.length; k += 1) {
  if (modText[k] === "{") depth += 1;
  else if (modText[k] === "}") { depth -= 1; if (depth === 0) { initEnd = k; break; } }
}
// 插在 init 里**第一个 `return` 之前**：`init` 里有 `return api;`，
// 插在函数末尾的 `}` 之前会变成死代码（2026-10-30 实测：闸全绿、页面一个监听都没挂上）。
const initBody = modText.slice(openBrace, initEnd);
const returnRel = initBody.search(/\n\s*return\b/);
const callAt = returnRel >= 0 ? openBrace + returnRel : initEnd;
const withCall =
  modText.slice(0, callAt) +
  "\n  // 刀 2：deps 已赋值，统一挂 14 段 pages 接线（必须在 return 之前）\n  wireAll();\n" +
  modText.slice(callAt);


/**
 * 静态自检：`wireAll()` 必须在 `init` 体内、且在 init 的第一个 `return` 之前。
 * 为什么单列一条（2026-10-30，真事故）：插在 `return api;` 之后 → 整段是死代码，
 * 而语法对、注入键齐、引用全在——**三条闸全绿，真机上监听数全 0**。
 * 这种"未执行"的形状静态闸问不出来，只能在生成时断言位置。
 */
function assertWireAllBeforeReturn(text) {
  const initIdx = text.search(/^\s*function init\(/m);
  if (initIdx < 0) return "找不到 function init(";
  const open = text.indexOf("{", initIdx);
  const body = text.slice(open);
  const lines = body.split("\n");
  let depth = 0;
  let returnLine = -1;
  let callLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const atDepth = depth;
    // 逐字符累计深度（这一行结束后的深度）
    for (const ch of line) { if (ch === "{") depth += 1; else if (ch === "}") depth -= 1; }
    if (depth === 0 && i > 0) break;                       // init 结束
    // 只认 init 顶层（行首深度 1）的 return
    if (atDepth === 1 && /^\s*return\b/.test(line) && returnLine < 0) returnLine = i;
    if ((line.includes("wireAll();") || line.includes("wireWhenReady")) && callLine < 0) callLine = i;
  }
  if (callLine < 0) return "init 体内找不到 wireAll()（或 wireWhenReady）";
  if (returnLine >= 0 && callLine > returnLine) {
    return `装配调用在 init 顶层 return 之后（调用行 ${callLine} > return 行 ${returnLine}）—— 死代码，永远不执行`;
  }
  return null;
}

// ---- 4. 判据 -----------------------------------------------------------------
function domIds(text) {
  const ids = [];
  for (const re of [
    /\bel\(\s*["'`]([\w-]+)["'`]\s*\)/g,
    /\bgetElementById\(\s*["'`]([\w-]+)["'`]\s*\)/g,
    /\bquerySelector(?:All)?\(\s*["'`]#([\w-]+)["'`]/g,
  ]) for (const m of text.matchAll(re)) ids.push(m[1]);
  return ids;
}

// ① R1：模块里还有没有 app.js 顶层名的裸引用
const r1 = [];
const insertedCode = movedBodies.map((b) => b.out).join("\n") + "\n" + wireAll;
for (const line of insertedCode.split("\n")) {
  const code = line.replace(/\/\/.*$/, "");
  for (const name of topLevel) {
    if (MODULE_LOCAL.has(name)) continue;
    const re = new RegExp(`(?<![\\w$.'"\`])${name}(?![\\w$])`);
    if (re.test(code) && !code.includes(`injected.${name}`)) r1.push(`${name}  ← ${line.trim().slice(0, 60)}`);
  }
}

// ② 行级多重集（模块侧把 injected. 前缀归一化后再比）
const norm = (s) => s.replace(/injected\./g, "").replace(/\s+/g, "");
const delLines = moved.map(norm).filter((l) => l && !l.startsWith("*") && !l.startsWith("/*") && l !== "}");
const addLines = movedBodies.flatMap((b) => b.out.split("\n")).map(norm).filter((l) => l && !l.startsWith("*") && !l.startsWith("/*") && l !== "}");
const multisetDiff = (() => {
  const count = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const a = count(delLines), b = count(addLines);
  // 两处 getter 改名是**有意**的（§②′：回调体内读宿主状态必须走注入），列白名单；
  // 白名单之外出现一行差异就是红的理由。
  const ALLOWED = [
    ["if(!currentProject)return;", "if(!getCurrentProject())return;"],
    ["if(!selectedPages.size){", "if(!getSelectedPages().size){"],
  ];
  for (const [d, ad] of ALLOWED) {
    a.set(d, (a.get(d) || 0) - 1);
    b.set(ad, (b.get(ad) || 0) - 1);
  }
  const out = [];
  for (const [k, v] of a) if (v > 0 && (b.get(k) || 0) < v) out.push(`只在 app.js（丢）：${k}`);
  for (const [k, v] of b) if (v > 0 && (a.get(k) || 0) < v) out.push(`只在模块（多）：${k}`);
  return out;
})();

// ③ R3：口径与 scripts/r3_pages_count.mjs 一致——只数 `view-pages` 子树的 id
// 子树 id 集合直接问权威脚本（口径只能有一份：scripts/r3_pages_count.mjs）
const PAGES_IDS = new Set(
  (() => {
    try {
      const { execFileSync } = require("node:child_process");
      const json = execFileSync(process.execPath, ["scripts/r3_pages_count.mjs", "--json"], { encoding: "utf8" });
      return JSON.parse(json).rows.map((r) => r.id);
    } catch {
      return [];
    }
  })()
);
const subTreeIds = (text) => domIds(text).filter((id) => PAGES_IDS.has(id)).length;
const idsBefore = subTreeIds(appSrc);
const idsAfter = subTreeIds(appKeep.join("\n"));

// ---- 5. 输出 -----------------------------------------------------------------
const report = {
  wires: wires.length,
  movedLines: moved.length,
  appLinesBefore: appLines.length,
  appLinesAfter: appKeep.length,
  appRemoved: appLines.length - appKeep.length,
  moduleLinesBefore: modLines.length,
  moduleLinesAfter: withCall.split("\n").length,
  moduleAdded: withCall.split("\n").length - modLines.length,
  rewrites: [...allApplied].sort(),
  r1Problems: r1,
  multisetProblems: multisetDiff,
  idsBefore,
  idsAfter,
  idsExpectedAfter: idsBefore - 37,   // 14 段共 37 处 pages 子树 id（实测值）
};

console.log(JSON.stringify(report, null, 2));

if (OUT) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "app.js"), appKeep.join("\n"));
  writeFileSync(join(OUT, "pages-view.js"), withCall);
  console.log(`\n已写到 ${OUT}/app.js 与 ${OUT}/pages-view.js（未改真文件）`);
}
if (WRITE) {
  writeFileSync(APP_REL, appKeep.join("\n"));
  writeFileSync(MOD_REL, withCall);
  console.log("\n✓ 已写回真文件（--write）");
}
const initPosProblem = assertWireAllBeforeReturn(withCall);
if (initPosProblem) console.log(`✗ 自检（wireAll 位置）：${initPosProblem}`);
else console.log("✓ 自检（wireAll 位置）：在 init 体内且在第一个 return 之前");
const bad = r1.length > 0 || multisetDiff.length > 0 || idsAfter !== idsBefore - 37 || !!initPosProblem;
process.exit(bad ? 1 : 0);
