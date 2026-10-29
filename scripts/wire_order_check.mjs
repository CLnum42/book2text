#!/usr/bin/env node
// scripts/wire_order_check.mjs —— 刀 2.5 判据②：**调用点顺序 == 原段在 HEAD 里的先后**
//
// 用法：node scripts/wire_order_check.mjs [path]
//
// 为什么需要（Chief 2026-10-30）：段被拆成多个 wire 函数后，「一段一个函数」不再成立，
// 但**副作用顺序不能变**。判法：把每个 wire 函数的**第一行函数体**拿回 HEAD 版里找出它
// 原来的行号，再比「宿主里调用行的先后」与「HEAD 行号的先后」是不是同一个序列。
//
// 判定：
//   · 每个 wire 函数必须恰好有 1 处调用；否则红（抽了没接线 / 接了两次）
//   · 同一宿主内，调用行号升序 ⇒ 对应 HEAD 行号也必须升序；否则红（顺序被打乱）
// 退出码：0 = 顺序一致；1 = 顺序或调用数不对；2 = 环境问题。
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
// 基准树：**刀 2.5 开工前**那一版（a9c5b01，app.js 14,387 行）。
// 为什么不用 HEAD：刀 2.5 落盘后 HEAD 里已经有 wire 函数的函数体，
// 「首行在 HEAD 里的行号」会变成新位置，等于拿搬完之后的位置比搬之前的顺序——必然假红。
const BASE = (() => {
  const i = process.argv.indexOf("--base");
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : "a9c5b01";
})();
const PATH_SPEC = process.argv.slice(2).find((a) => a.endsWith(".js") && !a.startsWith("--")) || "backend/book2text/static/app.js";
const nowLines = readFileSync(join(REPO, PATH_SPEC), "utf8").split("\n");
let headLines;
try {
  headLines = execFileSync("git", ["-C", REPO, "show", `${BASE}:${PATH_SPEC}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\n");
} catch (e) {
  console.error(`✗ 读不到基准树 ${BASE} 的 ${PATH_SPEC}：${e.message}`);
  process.exit(2);
}

/** 找某行文本在 HEAD 里的行号（取第一处；找不到返回 -1）。 */
function headLineOf(text) {
  const needle = text.trim();
  if (!needle) return -1;
  const idx = headLines.findIndex((l) => l.trim() === needle);
  return idx < 0 ? -1 : idx + 1;
}

/** 当前树里，某行号属于哪个顶层函数（向上找最近的 `function name(`）。 */
function hostOf(lineNo) {
  for (let i = lineNo - 1; i >= 0; i -= 1) {
    const m = nowLines[i].match(/^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
    if (m) return m[1];
  }
  return "?";
}

const wires = [];
nowLines.forEach((line, i) => {
  const m = line.match(/^function\s+(wirePages[A-Za-z0-9_]+)\s*\(\s*\)\s*\{/);
  if (m) wires.push({ name: m[1], defLine: i + 1, body: nowLines[i + 1] || "" });
});

if (!wires.length) {
  console.error("✗ 一个 wirePagesXxx 都没找到");
  process.exit(2);
}

let fail = 0;
const rows = [];
for (const w of wires) {
  const callRe = new RegExp(`^\\s*${w.name}\\(\\);\\s*$`);
  const calls = [];
  nowLines.forEach((line, i) => {
    if (callRe.test(line)) calls.push({ line: i + 1, host: hostOf(i + 1) });
  });
  const headAt = headLineOf(w.body);
  if (calls.length !== 1) {
    console.log(`✗ ${w.name}：调用 ${calls.length} 处（必须恰好 1 处）`);
    fail = 1;
  }
  if (headAt < 0) {
    console.log(`✗ ${w.name}：函数体首行在 ${BASE} 里找不到（${w.body.trim().slice(0, 40)}…）`);
    fail = 1;
  }
  rows.push({
    name: w.name,
    host: calls[0] ? calls[0].host : "?",
    callLine: calls[0] ? calls[0].line : -1,
    headLine: headAt,
  });
}

// 按宿主分组，比「调用顺序」与「HEAD 顺序」
const byHost = new Map();
for (const r of rows) {
  if (!byHost.has(r.host)) byHost.set(r.host, []);
  byHost.get(r.host).push(r);
}
console.log(`段 → 宿主 → 当前调用行 → 原段在基准树 ${BASE} 的行`);
for (const [host, list] of byHost) {
  list.sort((a, b) => a.callLine - b.callLine);
  console.log(`\n[${host}]`);
  let prevHead = -1;
  for (const r of list) {
    const bad = r.headLine >= 0 && r.headLine < prevHead;
    if (bad) fail = 1;
    console.log(
      `  ${bad ? "✗" : "·"} ${r.name.padEnd(30)} 调用 :${String(r.callLine).padEnd(6)} base :${r.headLine}`
    );
    if (!bad) prevHead = r.headLine;
  }
}

if (fail) {
  console.log("\n✗ 顺序判据不通过（调用顺序与原段先后不一致，或调用数不对）");
  process.exit(1);
}
console.log(`\n✓ 顺序判据通过：${wires.length} 个 wire 函数，各 1 处调用，宿主内调用顺序与 ${BASE} 里的原段先后一致`);
