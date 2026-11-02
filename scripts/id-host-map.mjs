#!/usr/bin/env node
// **id → 宿主** 映射表：index.html 的真实嵌套，不是"视图 span"。
//
// 为什么要有它：施工书的"宿主表"连续三刀写错，错法是同一条——把「视图 span」当「DOM 宿主」：
//   导出刀说 7 个在 #view-merge、跨视图刀说 6 个在 chrome（实际 5 个 host 组）、协作刀说 20 个在 #view-merge，
//   实测**三次都是 0**。规则写成"先量子树、再定 root"也治不住，因为人还是会先看一眼书再落笔。
//   所以让脚本吐数，书里贴脚本输出。
//
// 口径（写死在这里，书里别另写一套）：
//   · 宿主 = **最近的、带 id 的祖先元素**（不含自己）。视图只是子树里的一个节点，不是宿主；
//   · 没有任何带 id 的祖先 ⇒ 显式输出 `(no id ancestor)`，源节点写 `body`——空着就等于把
//     "chrome 里的兄弟组"藏起来了，而"注入节点组"正是靠这一行判的；
//   · 输出按宿主分组，末尾 `宿主 → N 个 id`，可以整段贴进归属表。
//
// 用法：
//   node scripts/id-host-map.mjs structure-open package-banner      # 查指定 id
//   node scripts/id-host-map.mjs --root export-panel               # 查一棵子树
//   node scripts/id-host-map.mjs --all                             # 全表
//   node scripts/id-host-map.mjs --self-test                       # 自检（合成 fragment + 真 index.html 四条）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INDEX_PATH = fileURLToPath(new URL("../backend/book2text/static/index.html", import.meta.url));

/** HTML 里没有结束标签的元素：遇到它们不进栈（否则后面所有 id 的宿主都会错一层）。 */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * 解析一段 HTML，返回 `{ entries, errors }`：
 *   entries: [{ id, line, offset, host, hostLine, source }]   // host 为 null ⇒ 没有带 id 的祖先
 *   errors:  [string]                                        // 标签不配平就报，不静默猜
 *
 * **不用缩进、不用视图 span**：只按标签配平走栈。行号与字符偏移都从原文算，行号按 `\n` 计数。
 */
export function mapIdHosts(html) {
  const text = String(html || "");
  const entries = [];
  const errors = [];
  const stack = [];                    // [{ tag, id, line, offset }]，栈顶是当前元素
  const lineAt = (offset) => text.slice(0, offset).split("\n").length;

  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = tagRe.exec(text)) !== null) {
    const [whole, closing, rawName, attrs, selfClose] = match;
    if (whole.startsWith("<!--")) continue;
    const tag = rawName.toLowerCase();
    const offset = match.index;
    const line = lineAt(offset);
    if (closing) {
      // 从栈顶往下找同名标签；找不到就是"多了一个结束标签"，报错但不打断
      let index = stack.length - 1;
      while (index >= 0 && stack[index].tag !== tag) index -= 1;
      if (index < 0) {
        errors.push(`第 ${line} 行 </${tag}> 没有对应的开标签（字符偏移 ${offset}）`);
      } else {
        stack.length = index;            // 连它自己一起弹出
      }
      continue;
    }
    const idMatch = /\bid\s*=\s*"([^"]+)"/.exec(attrs) || /\bid\s*=\s*'([^']+)'/.exec(attrs);
    const id = idMatch ? idMatch[1] : null;
    if (id) {
      // 宿主 = **最近的带 id 的祖先**（栈从顶往下第一个有 id 的），不含自己
      let host = null;
      let hostLine = null;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].id) { host = stack[index].id; hostLine = stack[index].line; break; }
      }
      entries.push({ id, line, offset, host, hostLine, source: tag === "body" ? "body" : (host ? tag : "body") });
    }
    if (!VOID_TAGS.has(tag) && !selfClose) stack.push({ tag, id, line, offset });
  }
  if (stack.length) {
    errors.push(`有 ${stack.length} 个开标签没闭合：${stack.map((one) => `<${one.tag}>@${one.line}`).join("、")}`);
  }
  return { entries, errors };
}

/** 按宿主分组并把同一宿主的 id 连在一起输出（可直接贴进归属表）。 */
export function groupByHost(entries) {
  const order = [];
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.host || "(no id ancestor)";
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(entry);
  }
  return order.map((host) => ({ host, items: groups.get(host) }));
}

export function renderRows(entries) {
  const lines = [];
  for (const { host, items } of groupByHost(entries)) {
    lines.push(`## 宿主 ${host}${host === "(no id ancestor)" ? " / body" : ""} → ${items.length} 个 id`);
    for (const item of items) {
      lines.push(`  ${item.id.padEnd(28)} line ${String(item.line).padStart(5)} · offset ${String(item.offset).padStart(6)}`
        + ` · 宿主 ${item.host || "(no id ancestor)"}${item.hostLine ? ` (line ${item.hostLine})` : ""}`);
    }
    lines.push("");
  }
  lines.push("## 汇总");
  for (const { host, items } of groupByHost(entries)) lines.push(`${host} → ${items.length} 个 id`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- 自检（红/绿口径）

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    console.error(`✖ ${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    return false;
  }
  console.log(`✔ ${what} → ${JSON.stringify(actual)}`);
  return true;
}

/** 两条自检：① 合成 fragment 的嵌套；② 真 index.html 的四条宿主断言。 */
export function selfTest({ html, fragment = '<div id="a"><div id="b"><span id="x"></span></div></div>' } = {}) {
  let ok = true;
  const synth = mapIdHosts(fragment);
  const byId = new Map(synth.entries.map((entry) => [entry.id, entry]));
  ok = assertEqual(byId.get("x")?.host, "b", "合成 fragment：x 的宿主是最近的带 id 祖先 b") && ok;
  ok = assertEqual(byId.get("b")?.host, "a", "合成 fragment：b 的宿主是 a") && ok;
  ok = assertEqual(synth.errors.length, 0, "合成 fragment：没有配平错误") && ok;

  const real = mapIdHosts(html);
  const realById = new Map(real.entries.map((entry) => [entry.id, entry]));
  const hostOf = (id) => (realById.get(id) ? (realById.get(id).host || "(no id ancestor)") : "（没有这个 id）");
  ok = assertEqual(hostOf("structure-open"), "export-panel", "真 index.html：structure-open → #export-panel") && ok;
  ok = assertEqual(hostOf("package-banner"), "(no id ancestor)", "真 index.html：package-banner 没有带 id 的祖先") && ok;
  ok = assertEqual(hostOf("page-detail-error"), "view-review", "真 index.html：page-detail-error → #view-review") && ok;
  ok = assertEqual(hostOf("assign-close"), "assign-panel", "真 index.html：assign-close → #assign-panel") && ok;
  // **最近 ≠ 视图**：这条才是三刀写错的那个点（书里把 #view-pages 当宿主，实际是 #page-filters）。
  // 它同时是"最近祖先 vs 最外层祖先"的判别样本——改判最外层就会得到 view-pages ⇒ 红。
  ok = assertEqual(hostOf("filter-type"), "page-filters", "真 index.html：filter-type → #page-filters（不是 #view-pages）") && ok;
  ok = assertEqual(hostOf("assign-panel"), "(no id ancestor)", "真 index.html：assign-panel 自己是顶层 section，没有带 id 的祖先") && ok;
  ok = assertEqual(real.errors.length, 0, "真 index.html：标签配平无误") && ok;
  return ok;
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  const html = readFileSync(INDEX_PATH, "utf8");
  if (argv.includes("--self-test")) {
    const ok = selfTest({ html });
    console.log(ok ? "\n自检通过。" : "\n自检失败。");
    process.exit(ok ? 0 : 1);
  }
  const { entries } = mapIdHosts(html);
  let picked = entries;
  if (argv.includes("--all")) {
    picked = entries;
  } else if (argv[0] === "--root") {
    const root = argv[1];
    const ids = new Set([root]);
    // 先找 root 的直接子树：逐层扩展（宿主是已选中的 id）
    let grew = true;
    while (grew) {
      grew = false;
      for (const entry of entries) {
        if (ids.has(entry.id) || !ids.has(entry.host)) continue;
        ids.add(entry.id); grew = true;
      }
    }
    picked = entries.filter((entry) => ids.has(entry.id));
  } else if (argv.length) {
    const wanted = new Set(argv);
    picked = entries.filter((entry) => wanted.has(entry.id));
    const missing = argv.filter((id) => !entries.some((entry) => entry.id === id));
    if (missing.length) {
      console.error(`✖ 这些 id 在 index.html 里不存在：${missing.join("、")}`);
      process.exit(2);
    }
  } else {
    console.error("用法：node scripts/id-host-map.mjs <id…> | --root <id> | --all | --self-test");
    process.exit(2);
  }
  console.log(renderRows(picked));
}

if (process.argv[1] && process.argv[1].endsWith("id-host-map.mjs")) main(process.argv.slice(2));
