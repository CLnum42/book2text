#!/usr/bin/env node
// scripts/wire_ids.mjs —— 报「某个函数体里碰到的 DOM id 及其处数」，用于刀 2.5 的
// 「DOM 层面的行级移动」判据：
//
//   node scripts/wire_ids.mjs setupPageMore        > /tmp/ids.before
//   （搬行）
//   node scripts/wire_ids.mjs wirePagesPageMore    > /tmp/ids.after
//   diff /tmp/ids.before /tmp/ids.after            # 必须为空
//
// 为什么需要它（Chief 2026-10-30）：`page-number-panel` / `assign-panel` / `backups-mask` /
// `word-boxes-panel` / `split-batch-panel` / `layout-detect-panel` **不在 `view-pages` 子树里**，
// R3 的数看不见它们。`move_only_check` 只证明代码行没变，这一条证明**它碰的 DOM 也没变**。
//
// 口径与 R3 一致（`tests/js/boundary.test.mjs` 的 domIdsIn / scripts/r3_pages_count.mjs）：
//   el("x") / getElementById("x") / querySelector("#x") / querySelectorAll("#x")
// 先剥注释与字符串，再计数；所以 `querySelectorAll("button")` 这类不算。
//
// 输出：每行 `<id>\t<处数>`，按 id 排序（无 id 则无输出，diff 才能直接比）。
// 退出码：0 = 正常；2 = 用法错误或找不到函数。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const APP = join(REPO, "backend/book2text/static/app.js");

const name = process.argv[2];
const file = process.argv[3] || APP;
if (!name) {
  console.error("用法: node scripts/wire_ids.mjs <函数名> [文件]");
  console.error("      node scripts/wire_ids.mjs --file-ids [文件]   # 全文件 id 处数");
  process.exit(2);
}


/** 从一段源码里数 id；返回 Map<id, 处数>。 */
function countIds(text) {
  const counts = new Map();
  const bump = (id) => counts.set(id, (counts.get(id) || 0) + 1);
  const patterns = [
    /\bel\(\s*["'`]([\w-]+)["'`]\s*\)/g,
    /\bgetElementById\(\s*["'`]([\w-]+)["'`]\s*\)/g,
    /\bquerySelector(?:All)?\(\s*["'`]#([\w-]+)["'`]/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) bump(m[1]);
  }
  return counts;
}

function printCounts(counts) {
  for (const [id, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${id}\t${n}`);
  }
}

// --file-ids：整个文件（不是单个函数）的 id 处数——给 move_only_check 判「DOM 引用没变」
if (name === "--file-ids") {
  const target = process.argv[3] || APP;
  printCounts(countIds(readFileSync(target, "utf8")));
  process.exit(0);
}

/** 剥注释与字符串：**等长空白化**（保留换行），这样切出来的索引在原文里也成立。 */
function stripCommentsAndStrings(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      let k = i;
      while (k < n && src[k] !== "\n") k += 1;
      blank(i, k); i = k;
      continue;
    }
    if (ch === "/" && next === "*") {
      let k = i + 2;
      while (k < n && !(src[k] === "*" && src[k + 1] === "/")) k += 1;
      blank(i, Math.min(k + 2, n)); i = Math.min(k + 2, n);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let k = i + 1;
      while (k < n) {
        if (src[k] === "\\") { k += 2; continue; }
        if (src[k] === quote) { k += 1; break; }
        if (src[k] === "\n" && quote !== "`") break;
        k += 1;
      }
      blank(i, k); i = k;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** 取函数体（从第一个 `{` 到配平的 `}`），返回 [startIndex, endIndex)。 */
function functionBody(src, fnName) {
  const re = new RegExp(`function\\s+${fnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index + m[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return [open, i + 1];
    }
  }
  return null;
}

const source = readFileSync(file, "utf8");
const stripped = stripCommentsAndStrings(source);
const span = functionBody(stripped, name);
if (!span) {
  console.error(`✗ 找不到函数 ${name}（${file}）`);
  process.exit(2);
}
const body = source.slice(span[0], span[1]);
printCounts(countIds(body));
