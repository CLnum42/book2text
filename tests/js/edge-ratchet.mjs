#!/usr/bin/env node
// 闸 B：静态边棘轮（13 条）——§18.3。
//
// 判据（对象 = 被测源码树，纯文本扫描，不加载、不跑 DOM）：
// - 桥 4 条：`setupReading` / `openPageDetail` / `renderMergeView` / `submitMergeDecisions`
//   函数体内 `showView(` = 0，且模块文件里 `showView(` = 0（模块只能走注入的 `navigate()`）
// - 回调边 9 条：每条 `caller` 函数体内 `callee` 出现 = 0
// 棘轮：13 条合计预期 0；任何一条从 0 变 ≥1 = 红。
//
// 用法（在仓库任意位置）：
//   node tests/js/edge-ratchet.mjs                 # 期望 13/13 GREEN（切完后）
//   node tests/js/edge-ratchet.mjs --expect-red    # 期望 13/13 RED（ring-break-base 证据）
//   B2T_STATIC_DIR=/tmp/base-static node tests/js/edge-ratchet.mjs --expect-red
//
// 退出码：符合期望 = 0；不符合 = 1；环境/文件错误 = 2。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stripCommentsAndStrings, functionBody, countWord } from "./static-scan.mjs";

/**
 * 桥例外表（Chief 2026-10-28）：3 条 app.js 内部的桥暂时切不掉——各自的视图还没搬进模块。
 * **总条数仍是 13**（改总数等于悄悄放宽）；例外只允许这 3 条，每条带 owner 与到期点。
 * 只降不升：MAX=3；某条例外归零了却还挂在表里 = 过期，红。
 */
export const BRIDGE_EXCEPTIONS = [
  { name: "openPageDetail", owner: "DevLead", expires: "pages 视图搬进模块时" },
  { name: "renderMergeView", owner: "DevLead", expires: "merge 视图搬进模块时" },
  { name: "submitMergeDecisions", owner: "DevLead", expires: "merge 视图搬进模块时" },
];
export const BRIDGE_EXCEPTION_MAX = 3;

export const BRIDGES = [
  "setupReading",
  "openPageDetail",
  "renderMergeView",
  "submitMergeDecisions",
];

export const EDGES = [
  ["renderReading", "ensureReadingMarksWindow"],
  ["renderReading", "retryReadingPendingPanel"],
  ["renderReadingTree", "ensureReadingMarksWindow"],
  ["renderReadingTree", "scrollReadingToPage"],
  ["openReadingPanel", "updateReadingPage"],
  ["setReadingHover", "ensureReadingBlocks"],
  ["verifyReadingPageSync", "updateReadingPage"],
  ["gotoReadingEntry", "jumpReadingTo"],
  ["gotoReadingEntry", "updateReadingPage"],
];

/** 目录里两个源文件的路径。 */
export function staticPaths(staticDir) {
  const base = staticDir || fileURLToPath(new URL("../../backend/book2text/static/", import.meta.url));
  return { app: join(base, "app.js"), view: join(base, "reading-view.js"), base };
}

/**
 * 逐条算一遍。
 * @returns {{label: string, count: number, kind: "bridge" | "edge", detail?: string}[]}
 */
/**
 * 目录里**所有** JS 源文件（app.js 最先，其余按文件名）。
 *
 * 为什么不再写死两份：L1–L6 一直在把函数搬进新文件。写死 app.js + reading-view.js 的话，
 * 函数搬进第三份文件（`queue-view.js` 之类）那一刻，这条边就"查不到 caller" → 记 0 → 静默绿。
 * 切模块越勤，这个口子越大。
 */
export function allSources(staticDir) {
  const { app, base } = staticPaths(staticDir);
  const others = readdirSync(base).filter((name) => name.endsWith(".js") && name !== "app.js").sort();
  return [
    { file: "app.js", source: readFileSync(app, "utf8") },
    ...others.map((name) => ({ file: name, source: readFileSync(join(base, name), "utf8") })),
  ];
}

export function evaluateEdges(staticDir) {
  return evaluateSources(allSources(staticDir));
}

/** 按两份源码文本算 13 条边（测试也要用它读 ring-break-base 的树）。 */
export function evaluateEdgeSources(appSource, viewSource, extraSources = []) {
  return evaluateSources([
    { file: "app.js", source: appSource },
    { file: "reading-view.js", source: viewSource },
    ...extraSources.map((item) => (typeof item === "string" ? { file: "extra", source: item } : item)),
  ]);
}

/** 按"文件名 → 源码"的列表算 13 条边。 */
export function evaluateSources(sources) {
  const stripped = sources.map((item) => ({ file: item.file, text: stripCommentsAndStrings(item.source) }));
  // 同名函数以**第一个找到的**为准（app.js 在前）；找不到 = missing，**不是 0**
  const find = (name) => {
    for (const item of stripped) {
      const body = functionBody(item.text, name);
      if (body !== null) return { body, file: item.file };
    }
    return null;
  };
  const results = [];

  for (const name of BRIDGES) {
    const hit = find(name);
    const count = hit ? countWord(hit.body, "showView") : 0;
    results.push({
      key: `bridge:${name}`,
      label: `桥 ${name} → showView(`,
      count,
      kind: "bridge",
      missing: !hit,
      detail: hit ? `${hit.file} 体内 ${count} 处` : "缺函数（改名了，或整个函数不见了）",
    });
  }
  for (const [caller, callee] of EDGES) {
    const hit = find(caller);
    const count = hit ? countWord(hit.body, callee) : 0;
    results.push({
      key: `edge:${caller}->${callee}`,
      label: `边 ${caller} → ${callee}`,
      count,
      kind: "edge",
      missing: !hit,
      detail: hit ? `${hit.file} 体内 ${count} 处` : "缺 caller 函数体（改名了，或整个函数不见了）",
    });
  }
  return results;
}

/** 模块文件全文里 `showView` 出现几次（§18.3 的附加条件，不计入 13 条）。 */
export function moduleShowViewCount(staticDir) {
  const { view } = staticPaths(staticDir);
  return moduleShowViewInSource(readFileSync(view, "utf8"));
}

export function moduleShowViewInSource(viewSource) {
  return countWord(stripCommentsAndStrings(viewSource), "showView");
}

/** 例外表本身的校验：上限、owner、到期点、过期（已归零还挂着）。 */
export function checkBridgeExceptions(results) {
  const problems = [];
  if (BRIDGE_EXCEPTIONS.length > BRIDGE_EXCEPTION_MAX) {
    problems.push(`桥例外 ${BRIDGE_EXCEPTIONS.length} 条，上限 ${BRIDGE_EXCEPTION_MAX}——超了要问 Chief，不许扩`);
  }
  for (const item of BRIDGE_EXCEPTIONS) {
    if (!item.owner) problems.push(`桥例外 ${item.name} 缺 owner`);
    if (!item.expires) problems.push(`桥例外 ${item.name} 缺到期点`);
    const hit = results.find((entry) => entry.key === `bridge:${item.name}`);
    if (!hit) problems.push(`桥例外 ${item.name} 在 13 条里找不到——名字写错了`);
    else if (hit.missing) problems.push(`桥例外 ${item.name} 的函数体找不到（改名或搬走了）——找不到不等于已经切干净`);
    else if (hit.count === 0) problems.push(`桥例外 ${item.name} 已经归零（切掉了），请同批删除例外（到期点：${item.expires}）`);
  }
  return problems;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const expectRed = process.argv.includes("--expect-red");
  let results;
  try {
    results = evaluateEdges(process.env.B2T_STATIC_DIR);
  } catch (error) {
    console.error(`edge-ratchet: ${error.message}`);
    process.exit(2);
  }
  const red = results.filter((item) => item.count > 0 || item.missing);
  const green = results.filter((item) => item.count === 0);
  const exemptNames = new Set(BRIDGE_EXCEPTIONS.map((item) => item.name));
  const exemptProblems = expectRed ? [] : checkBridgeExceptions(results);
  console.log(`闸 B · 静态边棘轮 ${red.length}/${results.length} RED`);
  for (const item of results) {
    const isExempt = item.kind === "bridge" && exemptNames.has(item.key.replace(/^bridge:/, ""));
    // missing 一律红：函数改名/搬走时"找不到"不等于"没有调用"
    const flag = item.missing ? "MISS " : (item.count > 0 ? (isExempt ? "EXEMPT" : "RED  ") : "GREEN");
    console.log(`${flag} ${item.label}  （${item.detail}${isExempt ? "；例外，到期点见 BRIDGE_EXCEPTIONS" : ""}）`);
  }
  for (const problem of exemptProblems) console.log(`RED   例外表：${problem}`);
  const moduleShowView = moduleShowViewCount(process.env.B2T_STATIC_DIR);
  console.log(`${moduleShowView > 0 ? "RED  " : "GREEN"} 附加：reading-view.js 全文 showView( = ${moduleShowView} 处（不计入 13 条）`);
  console.log(`合计：${green.length}/${results.length} 条已归零，${red.length} 条仍有调用点`);
  // --expect-red：13 条全红 + 模块全文 showView > 0（base 上模块还在直接 showView）
  // 默认：13 条全绿 + 模块全文 showView = 0
  // 默认模式：非例外的边必须全绿；3 条例外允许红，但例外表本身必须合格
  const exemptRed = results.filter((item) => item.count > 0
    && item.kind === "bridge" && exemptNames.has(item.key.replace(/^bridge:/, ""))).length;
  const edgesOk = expectRed
    ? red.length === results.length
    : green.length + exemptRed === results.length && exemptProblems.length === 0;
  const moduleOk = expectRed ? moduleShowView > 0 : moduleShowView === 0;
  const ok = edgesOk && moduleOk;
  if (!ok) {
    console.error(
      expectRed
        ? `期望 --expect-red：13 条全红 + 模块 showView>0；实际 ${red.length}/${results.length} 红、模块 showView=${moduleShowView}`
        : `期望 13 条全绿 + 模块 showView=0；实际 ${red.length}/${results.length} 红、模块 showView=${moduleShowView}`,
    );
    process.exit(1);
  }
}
