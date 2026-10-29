#!/usr/bin/env node
/**
 * scripts/wire_init_probe.mjs —— 刀 2 落盘前/后的**运行时**探针：
 * 「pages 模块 init 跑的时候，每个 wirePagesXxx 要绑的 DOM 在不在了」
 *
 * 为什么需要（Chief 2026-10-30）：静态判据只能证明「id 在 index.html 里有」，
 * 证明不了「init 执行的那一刻它在」。而 init 常常在 `boot()` 里、DOM 还没挂完——
 * 那时 `el("x")` 返回 null，绑监听要么抛（吵），要么被 `if (!el) return` 静默吞掉：
 * **不报错、闸全绿、用户点了没反应**。这一条只有真开一次页面能抓。
 *
 * 判据（对每段、每个 id）：
 *   ① 元素存在                      → 否则红：`… 在 init 时不存在（绑到了 null）`
 *   ② 该元素上的监听数 == 段表声明   → 否则红：`… 绑上了但没有监听（init 时元素还不存在）`
 * 监听数用 CDP 的 `getEventListeners(el)`（DevTools 命令行 API）数，不用包装 addEventListener
 * ——包装只能数「之后」的，而这个探针要在 init **之后**才看，包装会漏掉 init 期间绑的。
 *
 * 跑法（ego-browser 提供 taskSpace / page 全局；纯 node 跑不了带段表的模式）：
 *   ego-browser nodejs < scripts/wire_init_probe.mjs
 *   B2T_PROBE_URL  （默认 http://127.0.0.1:8857/?token=h1）
 *   B2T_PROBE_SPACE（默认 b2t-builder-wireinit）
 *
 * 段表为空时：**不开浏览器、不建 space**，只打印「无段可查」并 exit 0（骨架状态可跑）。
 *
 * 退出码：0 = 全绿 / 无段可查；1 = 有段红；2 = 环境问题（连不上 / 没有 ego 全局）。
 */

// ---- 段表：**从模块现扫**（14 段落盘后就在 pages-view.js 里）--------------------
// 形态：{ wire: "wirePagesXxx", ids: [{ id: "page-more", listeners: 1 }] }
// listeners = 该段自己在这个 id 上绑的监听数；不改手抄，避免与代码漂移。
import { readFileSync as readSync } from "node:fs";
import { fileURLToPath } from "node:url";
// ego-browser 里 cwd 是 `/`（实测），相对路径读不到；必须由调用方给绝对路径。
// 路径来源：环境变量（有的封装不透传）→ 占位符（调用方 sed 替换成绝对路径）
const MODULE_PATH_RAW = process.env.B2T_MODULE || "__B2T_MODULE_PATH__";
const MODULE_PATH = MODULE_PATH_RAW.includes("__B2T_MODULE") ? "" : MODULE_PATH_RAW;

function buildSegments() {
  if (!MODULE_PATH) return { segments: [], error: "没给 B2T_MODULE（ego 里 cwd 是 `/`，相对路径读不到模块）" };
  let src = "";
  try { src = readSync(MODULE_PATH, "utf8"); } catch (e) { return { segments: [], error: `读不到 ${MODULE_PATH}：${e.code || e.message}` }; }
  const out = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^function (wirePages[A-Za-z0-9_]+)\(\) \{$/);
    if (!m) continue;
    let depth = 0; let end = i;
    for (let k = i; k < lines.length; k += 1) {
      for (const ch of lines[k]) { if (ch === "{") depth += 1; else if (ch === "}") { depth -= 1; if (depth === 0) { end = k; break; } } }
      if (depth === 0 && k > i) break;
    }
    const body = lines.slice(i, end + 1).join("\n");
    const varToId = new Map();
    for (const v of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*el\(\s*["'`]([\w-]+)["'`]\s*\)/g)) varToId.set(v[1], v[2]);
    const perId = new Map();
    const bump = (id) => perId.set(id, (perId.get(id) || 0) + 1);
    for (const mm of body.matchAll(/\bel\(\s*["'`]([\w-]+)["'`]\s*\)\s*\.addEventListener/g)) bump(mm[1]);
    for (const mm of body.matchAll(/([A-Za-z_$][\w$]*)\s*\.addEventListener/g)) {
      if (varToId.has(mm[1])) bump(varToId.get(mm[1]));
    }
    if (perId.size) out.push({ wire: m[1], ids: [...perId.entries()].map(([id, listeners]) => ({ id, listeners })) });
  }
  return { segments: out, error: null };
}

const { segments: SEGMENTS, error: SEGMENT_ERROR } = buildSegments();
if (SEGMENT_ERROR && !process.env.B2T_MODULE) {
  console.error(`✗ 段表读不到：${SEGMENT_ERROR}`);
  console.error('  跑法：B2T_MODULE="$PWD/backend/book2text/static/pages-view.js" ego-browser nodejs < scripts/wire_init_probe.mjs');
  process.exit(2);
}

const URL_DEFAULT = "http://127.0.0.1:8857/?token=h1";
const SPACE_DEFAULT = "b2t-builder-wireinit";

// 空表：骨架状态——不开浏览器、不建 space，直接报「无段可查」
if (!SEGMENTS.length) {
  console.log(`wire_init_probe: 段表为空 —— 无段可查${SEGMENT_ERROR ? `（${SEGMENT_ERROR}）` : ""}`);
  console.log("  形态：{ wire, ids: [{ id, listeners }] }；判据：元素存在 且 监听数 == 声明");
  process.exit(0);
}

const PROBE_URL = process.env.B2T_PROBE_URL || URL_DEFAULT;
const SPACE = process.env.B2T_PROBE_SPACE || SPACE_DEFAULT;

if (typeof taskSpace !== "function") {
  console.error(
    "✗ 没有 ego 全局（taskSpace）。带段表时必须用：ego-browser nodejs < scripts/wire_init_probe.mjs"
  );
  process.exit(2);
}

const problems = [];
let page;
let task;

/** 在页面里数一个元素上的监听（按类型）。CDP 命令行 API 的 getEventListeners 只在 CDP 生效。 */
async function listenerCounts(id) {
  const expr = `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const map = getEventListeners(el) || {};
    const out = {};
    for (const type of Object.keys(map)) out[type] = (map[type] || []).length;
    return out;
  })()`;
  const res = await page.cdp("Runtime.evaluate", {
    expression: expr,
    includeCommandLineAPI: true,
    returnByValue: true,
  });
  if (!res) return null;
  if (res.result && "value" in res.result) return res.result.value;
  if ("value" in res) return res.value;
  return null;
}

try {
  task = await taskSpace(SPACE);
  page = task.page("p1");
  await page.goto(PROBE_URL);
  // 等应用真的 boot 完：模块都 init 过、项目列表拉过一轮，才谈得上「init 时的 DOM」
  await page.waitForFunction(
    () =>
      typeof window !== "undefined" &&
      typeof window.PagesView === "object" &&
      document.readyState === "complete" &&
      !!document.getElementById("view-pages"),
    null,
    { timeout: 60000 }
  );
  // 再等两帧：init 之后的同步接线 + 一次 microtask 收尾
  await page.waitForFunction(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))),
    null,
    { timeout: 10000 }
  );

  for (const seg of SEGMENTS) {
    for (const want of seg.ids) {
      const counts = await listenerCounts(want.id);
      if (counts === null) {
        problems.push(`${seg.wire} 的 ${want.id} 在 init 时不存在（绑到了 null）`);
        continue;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total < want.listeners) {
        const detail = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ") || "一个都没有";
        problems.push(
          `${seg.wire} 的 ${want.id} 绑上了但没有监听（init 时元素还不存在；现元素上：${detail}，期望 ${want.listeners}）`
        );
      }
    }
  }
} catch (error) {
  console.error(`✗ 探针跑挂了：${(error && error.stack) || error}`);
  if (task) {
    try { await task.finish({ keep: [] }); } catch { /* 收尾失败不掩盖原始错误 */ }
  }
  process.exit(2);
}

// 收尾：无论红绿都关 space（团队规矩：不关会一路泄漏）
try {
  await task.finish({ keep: [] });
} catch (error) {
  console.error(`… space 收尾失败（不影响判据）：${(error && error.message) || error}`);
}

if (problems.length) {
  console.log(`✗ wire_init_probe：${problems.length} 处不对`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
const ids = SEGMENTS.reduce((n, s) => n + s.ids.length, 0);
console.log(`✓ wire_init_probe 通过：${SEGMENTS.length} 段 / ${ids} 个 id，元素都在且监听数符合声明`);
process.exit(0);
