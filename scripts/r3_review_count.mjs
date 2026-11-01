#!/usr/bin/env node
// scripts/r3_review_count.mjs —— **只读**统计 `view-review` 子树 id 在 app.js 里的引用处数。
// 由 scripts/r3_pages_count.mjs 复制并把 view-pages 换成 view-review（口径逐字相同）。
//
// 为什么单独一个脚本（Chief 2026-10-29）：同一张表，Architect 数与闸的数差 −31，
// 224 / 193 谁对没人能判——**根子是两套口径**。这个脚本的唯一理由：
// 口径写成代码、只读一棵树、跑两次逐字相同，任何人（Architect / TestDev / Builder）跑出的数可比。
//
// 口径 = 闸 R3 的三种形态，**与 tests/js/boundary.test.mjs 的 domIdsIn 逐字一致**：
//   el("x") / getElementById("x") / querySelector("#x")（先剥注释；字符串保留）
// 不读豁免表、不读配置——一份输入（app.js），一份输出。
//
// 用法：
//   node scripts/r3_review_count.mjs                    # 每 id 处数（降序）+ 合计 + 种数
//   node scripts/r3_review_count.mjs --lines page-grid  # 该 id 每一处：行号 + 所在顶层函数
//   node scripts/r3_review_count.mjs --json             # 机读（对集用）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const APP = join(REPO, "backend/book2text/static/app.js");
const HTML = join(REPO, "backend/book2text/static/index.html");

function stripCommentsOnly(source) {
  const out = source.split("");
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const REGEX_PRECEDERS = "([{=,:;!&|?+-*%~^<>";
  const looksLikeRegex = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(source[k])) k -= 1;
    if (k < 0) return true;
    return REGEX_PRECEDERS.includes(source[k]);
  };
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop); i = stop;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop); i = stop;
    } else if (ch === "/" && looksLikeRegex(i)) {
      let k = i + 1; let inClass = false;
      while (k < n) {
        const cur = source[k];
        if (cur === "\\") { k += 2; continue; }
        if (cur === "[") inClass = true;
        else if (cur === "]") inClass = false;
        else if (cur === "/" && !inClass) { k += 1; break; }
        else if (cur === "\n") break;
        k += 1;
      }
      blank(i, k); i = k;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch; let k = i + 1;
      while (k < n) {
        if (source[k] === "\\") { k += 2; continue; }
        if (source[k] === quote) { k += 1; break; }
        k += 1;
      }
      i = k;   // 字符串保留
    } else i += 1;
  }
  return out.join("");
}

function domIdsIn(jsStripped) {
  const found = new Map();   // id -> 所有出现行（块外判定必须看全部出现，不能只看首次）
  const patterns = [
    /\bel\(\s*["']([^"']+)["']\s*\)/g,
    /getElementById\(\s*["']([^"']+)["']\s*\)/g,
    /querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)[^"']*["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(jsStripped)) !== null) {
      const list = found.get(m[1]) || [];
      list.push(lineOf(jsStripped, m.index));
      found.set(m[1], list);
    }
  }
  return found;
}

function lineOf(source, index) {
  let line = 1;
  for (let k = 0; k < index; k += 1) if (source[k] === "\n") line += 1;
  return line;
}

/** `<section id="view-review">` 子树里的 id（含根）。 */
function pagesIds(html) {
  const match = /<section\b[^>]*\bid="view-review"[^>]*>/i.exec(html);
  if (!match) throw new Error('index.html 里没有 <section id="view-review">');
  let depth = 1;
  const cursor = match.index + match[0].length;
  for (const tag of html.slice(cursor).matchAll(/<(\/?)section\b/gi)) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) {
      const slice = html.slice(match.index, cursor + tag.index + tag[0].length);
      return new Set([...slice.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    }
  }
  throw new Error('<section id="view-review"> 没有闭合');
}

/** 顶层函数区间（行号 + 名字），给 --lines 定位"这一处在哪个函数里"。 */
function topLevelFunctions(stripped) {
  const all = stripped.split("\n");
  const fns = [];
  const startRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
  for (let i = 0; i < all.length; i += 1) {
    const m = startRe.exec(all[i]);
    if (!m) continue;
    let depth = 0, end = i;
    for (let j = i; j < all.length; j += 1) {
      for (const ch of all[j]) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      if (depth === 0 && j > i) { end = j; break; }
    }
    fns.push({ name: m[1], start: i + 1, end: end + 1 });
  }
  return fns;
}

/** 每一处的取法（el / getElementById / querySelector）——判"搬漏"还是"口径差"就看这个。 */
function occurrencesWithForm(stripped, id) {
  const forms = [
    ["el", /\bel\(\s*["']([^"']+)["']\s*\)/g],
    ["getElementById", /getElementById\(\s*["']([^"']+)["']\s*\)/g],
    ["querySelector", /querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)[^"']*["']\s*\)/g],
  ];
  const out = [];
  for (const [form, pattern] of forms) {
    let m;
    while ((m = pattern.exec(stripped)) !== null) {
      if (m[1] === id) out.push({ line: lineOf(stripped, m.index), form });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

const appSource = readFileSync(APP, "utf8");
const stripped = stripCommentsOnly(appSource);
const ids = pagesIds(readFileSync(HTML, "utf8"));
const found = domIdsIn(stripped);
const rows = [...ids].map((id) => ({ id, count: (found.get(id) || []).length }))
  .filter((row) => row.count > 0)
  .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
const total = rows.reduce((sum, row) => sum + row.count, 0);

const argv = process.argv.slice(2);
if (argv.includes("--json")) {
  // 每个 id 带上**引用它的函数集合**（行号 + 取法 + 函数名）：Architect 要拿它建反向映射，
  // 不要再各自解析一遍——每多一套解析就多一次口径。
  const fns = topLevelFunctions(stripped);
  const detailed = rows.map((row) => {
    const occurrences = occurrencesWithForm(stripped, row.id).map((item) => {
      const fn = fns.filter((entry) => entry.start <= item.line && item.line <= entry.end).pop();
      return { line: item.line, form: item.form, function: fn ? fn.name : null };
    });
    return {
      id: row.id,
      count: row.count,
      functions: [...new Set(occurrences.map((o) => o.function).filter(Boolean))].sort(),
      occurrences,
    };
  });
  console.log(JSON.stringify({
    file: "backend/book2text/static/app.js",
    appLines: appSource.split("\n").length - (appSource.endsWith("\n") ? 1 : 0),
    total,
    ids: rows.length,
    rows: detailed,
  }, null, 1));
  process.exit(0);
}
const lineIndex = argv.indexOf("--lines");
if (lineIndex !== -1) {
  const want = argv[lineIndex + 1];
  if (!want) { console.error("✖ --lines 缺 id"); process.exit(64); }
  const strippedForLines = stripCommentsOnly(appSource);
  const list = occurrencesWithForm(strippedForLines, want);
  const fns = topLevelFunctions(strippedForLines);
  console.log(`${want}: ${list.length} 处`);
  for (const item of list) {
    const fn = fns.filter((entry) => entry.start <= item.line && item.line <= entry.end).pop();
    console.log(`  :${item.line}  ${item.form}()  ${fn ? fn.name + "()" : "（顶层代码）"}`);
  }
  process.exit(0);
}
console.log(`app.js 里 view-review 子树 id：${rows.length} 种 / ${total} 处`);
console.log("口径：el(id) / getElementById(id) / querySelector(All)(#id)，先剥注释后计数（与闸 R3 一致）");
for (const row of rows) console.log(`  ${row.id}\t${row.count}`);
