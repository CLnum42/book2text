#!/usr/bin/env node
// scripts/wire_coverage_check.mjs —— 刀 2.5 判据：**段表里判「可抽」的段，其 id 必须全被 wirePagesXxx 覆盖**
//
// 用法：
//   node scripts/wire_coverage_check.mjs                    # 查工作区 app.js
//   node scripts/wire_coverage_check.mjs --file <某棵树的 app.js>
//
// 为什么需要（Chief 2026-10-30）：`auto-apply-suggestions` / `selection-check` / `check-pending`
// 三段被漏抽，而**闸不红、测试不红、move_only_check 不红、wire_ids 对集也不红**——
// 因为那几条判据只核「我已经切出来的东西」，不核「段表里说可抽的东西」。
// 这条判据把「段表意图」当输入、「wire 函数覆盖」当输出，差一个就点名。
//
// 段表在这里是**按 id 记的**，不按行号：行号会随每次抽取漂（已经漂过 11 / 46 行），
// 而 id 集合是稳定的，也正是判据真正关心的东西。
//
// 退出码：0 = 全覆盖；1 = 有段没被覆盖（会点名段与 id）；2 = 环境问题。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const fileArgIdx = process.argv.indexOf("--file");
const FILE =
  fileArgIdx > 0 && process.argv[fileArgIdx + 1]
    ? process.argv[fileArgIdx + 1]
    : join(REPO, "backend/book2text/static/app.js");

// ---- 段表（意图记录；口径 = el/getElementById/querySelector(#id)）----------------
// extractable：判「可抽」，必须被某个 wirePagesXxx 覆盖。
const EXTRACTABLE = [
  { seg: "setupRecognitionSettings", ids: ["rec-engine", "rec-language", "rec-dual-strategy"] },
  { seg: "setupPageMore", ids: ["page-more", "page-more-menu"] },
  { seg: "setupPageNumberPanel", ids: ["page-number-open", "page-number-review-open"] },
  { seg: "setupExportPanel", ids: ["rec-margin-judgement"] },
  { seg: "setupLibrary·auto-apply", ids: ["auto-apply-suggestions"] },
  { seg: "setupLibrary·selection-check", ids: ["selection-check"] },
  { seg: "setupLibrary·check-pending", ids: ["check-pending"] },
  {
    seg: "setupLibrary·筛选",
    ids: ["filter-type", "filter-recognition", "filter-workflow", "filter-triage", "pages-only-included"],
  },
  { seg: "setupLibrary·page-grid", ids: ["page-grid"] },
  { seg: "setupLibrary·page-range", ids: ["page-range-select", "page-range"] },
  {
    seg: "setupLibrary·选择",
    ids: ["selection-all", "selection-select-all", "selection-clear", "selection-recognize"],
  },
  { seg: "setupLibrary·selection-more", ids: ["selection-more", "selection-more-menu"] },
  {
    seg: "setupLibrary·面板",
    ids: [
      "pages-zoom-out", "pages-zoom-in", "pages-overlay-toggle", "pages-margin-toggle",
      "layout-block-apply-all", "layout-block-confirm", "margin-confirm-all",
      "rec-start-all", "rec-aux-all",
    ],
  },
  { seg: "setupLibrary·确认页", ids: ["setup-confirm-selected", "split-page-numbers", "setup-confirm-all"] },
];

// notExtractable：段表里判「可抽」但实测抽不动（原因写清，避免下次又被当成遗漏）。
const NOT_EXTRACTABLE = [
  {
    seg: "boot·ReadingView.init / IndexView.init / LibraryView.init / PreviewView.init 的 deps",
    ids: ["pages-margin-toggle", "pages-overlay-toggle"],
    reason: "形态是 `getPagesMarginToggle: () => el(\"…\")`，抽出去必须改行；且 build_view.py 把 init({…}) 装配块列为原样保留",
  },
];

/** 剥注释与字符串：等长空白化（索引与原文一一对应）。 */
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
      blank(i, k); i = k; continue;
    }
    if (ch === "/" && next === "*") {
      let k = i + 2;
      while (k < n && !(src[k] === "*" && src[k + 1] === "/")) k += 1;
      blank(i, Math.min(k + 2, n)); i = Math.min(k + 2, n); continue;
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
      blank(i, k); i = k; continue;
    }
    i += 1;
  }
  return out.join("");
}

/** 返回函数体在**原文**里的 [start, end) 下标（用剥字符串后的文本定位括号，索引与原文一一对应）。 */
function functionBodySpan(src, fnName) {
  const re = new RegExp(`function\\s+${fnName}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf("{", m.index + m[0].length);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) return [open, i + 1]; }
  }
  return null;
}

function idsIn(text) {
  const out = new Set();
  const patterns = [
    /\bel\(\s*["'`]([\w-]+)["'`]\s*\)/g,
    /\bgetElementById\(\s*["'`]([\w-]+)["'`]\s*\)/g,
    /\bquerySelector(?:All)?\(\s*["'`]#([\w-]+)["'`]/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.add(m[1]);
  return out;
}

const source = readFileSync(FILE, "utf8");
const stripped = stripCommentsAndStrings(source);
const wireNames = [...stripped.matchAll(/function\s+(wirePages[A-Za-z0-9_]+)\s*\(\s*\)\s*\{/g)].map((m) => m[1]);
if (!wireNames.length) {
  console.error("✗ 一个 wirePagesXxx 都没找到");
  process.exit(2);
}

const coveredBy = new Map(); // id -> [wire 函数名]
for (const fn of wireNames) {
  const span = functionBodySpan(stripped, fn);
  if (!span) continue;
  // 注意：id 本身是字符串，必须在**原文**里数，不能在剥过字符串的文本里数
  for (const id of idsIn(source.slice(span[0], span[1]))) {
    if (!coveredBy.has(id)) coveredBy.set(id, []);
    coveredBy.get(id).push(fn);
  }
}

let fail = 0;
console.log(`段表可抽段 ${EXTRACTABLE.length} 个 / wirePagesXxx ${wireNames.length} 个（文件：${FILE}）`);
for (const { seg, ids } of EXTRACTABLE) {
  const missing = ids.filter((id) => !coveredBy.has(id));
  if (missing.length) {
    fail = 1;
    console.log(`✗ ${seg}：未覆盖 ${missing.length} 个 id → ${missing.join(" / ")}`);
  } else {
    console.log(`· ${seg}：${ids.length} 个 id 全覆盖`);
  }
}

// 反向：wire 函数里出现了段表没有的 id（可能是顺手多抽，也可能是段表漏记）
const known = new Set(EXTRACTABLE.flatMap((s) => s.ids));
const notListed = [...coveredBy.keys()].filter((id) => !known.has(id)).sort();
if (notListed.length) {
  console.log(`⚠ wire 函数里出现段表未登记的 id（不算红，但要核对）：${notListed.join(" / ")}`);
}
for (const n of NOT_EXTRACTABLE) {
  console.log(`· 不抽：${n.seg}（${n.ids.join(" / ")}）—— ${n.reason}`);
}

if (fail) {
  console.log("\n✗ 覆盖判据不通过：有可抽段没进任何 wirePagesXxx");
  process.exit(1);
}
console.log(`\n✓ 覆盖判据通过：${wireNames.length} 个 wire 函数覆盖了段表里全部可抽段的 id`);
