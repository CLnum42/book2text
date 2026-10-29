// tests/js/pages-wire.test.mjs —— 刀 2.5 落盘后：14 段 pages 接线**真的挂上了**没有。
//
// 为什么需要（2026-10-30 真事故）：`wireAll()` 被插在 `init` 的 `return api;` 之后，
// 语法对、注入键齐、三条静态闸全绿，而真机上 page-grid / pages-margin-toggle 的监听数全 0。
// 「未执行」这种形状静态闸问不出来——只能在运行时装个假 DOM，数一数监听真的挂上了没有。
//
// 三条断言：
//   ① 有 #view-pages + readyState="complete" → page-grid 与一个 filter 元素上的监听数 > 0
//   ② 本次被请求过的 id 去重数 ≥ 30（防「只绑了一半也算过」）
//   ③ 另起 ctx、getElementById("view-pages") 返回 null → 不抛，且跳过计数 +1
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { preloadModules } from "./load-app.mjs";

/** 最小节点：同一 id 必须是同一个对象，否则监听挂不住也数不到。 */
function makeNode() {
  const node = {
    listeners: {},
    dataset: {},
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    hidden: false,
    textContent: "",
    innerHTML: "",
    value: "",
    disabled: false,
    checked: false,
    addEventListener(type, handler) {
      (node.listeners[type] = node.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }),
    contains: () => false,
    closest: () => null,
    focus() {},
    appendChild() {},
  };
  node.parentElement = node;
  node.parentNode = node;
  return node;
}

/**
 * 造一个最小 vm 上下文（模块用的是**全局 document**，不是 injected.document）。
 * @param {{ hasPagesView?: boolean, readyState?: string }} opts
 */
function makeCtx({ hasPagesView = true, readyState = "complete" } = {}) {
  const ELEMENTS = new Map();
  const requested = [];
  const docListeners = {};
  const document = {
    readyState,
    documentElement: { dataset: {} },
    getElementById(id) {
      requested.push(id);
      if (id === "view-pages" && !hasPagesView) return null;
      if (!ELEMENTS.has(id)) ELEMENTS.set(id, makeNode());
      return ELEMENTS.get(id);
    },
    querySelector: () => makeNode(),
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    addEventListener(type, handler) {
      (docListeners[type] = docListeners[type] || []).push(handler);
    },
    removeEventListener() {},
  };
  const sandbox = { console, setTimeout, clearTimeout, document };
  const ctx = vm.createContext(sandbox);
  vm.runInContext("globalThis.window = globalThis;", ctx);
  return { ctx, elements: ELEMENTS, requested, docListeners };
}

/** 载入真实模块（真源码、真 init、真 deps），返回上下文。 */
function loadPagesModule(opts) {
  const built = makeCtx(opts);
  preloadModules(built.ctx, ["pages-view.js"]);
  return built;
}

const countListeners = (node) =>
  Object.values(node.listeners || {}).reduce((sum, list) => sum + list.length, 0);

test("① 有 #view-pages：14 段接线真的挂上了监听", () => {
  const { elements } = loadPagesModule({ hasPagesView: true, readyState: "complete" });
  const grid = elements.get("page-grid");
  assert.ok(grid, "page-grid 没被请求过——说明 wireAll 根本没跑");
  assert.ok(
    countListeners(grid) > 0,
    `page-grid 上一个监听都没有（wireAll 没执行，或元素被绑到 null 后静默跳过）`,
  );
  const filter = elements.get("filter-type");
  assert.ok(filter, "filter-type 没被请求过");
  assert.ok(countListeners(filter) > 0, "filter-type 上一个监听都没有");
  // 绿①的两个数（写进输出，报告里直接贴）
  console.log(`    绿①：page-grid 监听 ${countListeners(grid)} 个 / filter-type 监听 ${countListeners(filter)} 个`);
});

// 刀 2 落盘实测（2026-10-30）：38 个 id。**只许降**——降了就是某段没跑到；
// 合法新增要显式改这一行（不写 === 38：那会把合法新增判红，逼下一个人放宽口径）。
const EXPECTED_REQUESTED_IDS = 38;
// 所有节点上的监听总数（同上，只降不升）
const EXPECTED_LISTENERS = 35;  // 刀 2 落盘实测（2026-10-30）：35 个监听；只许降

test("② 被请求过的 id 去重数 ≥ 实测值（防只绑一半）", () => {
  const { requested } = loadPagesModule({ hasPagesView: true, readyState: "complete" });
  const distinct = new Set(requested);
  console.log(`    绿②：requested ids 去重 ${distinct.size} 个（期望 ≥ ${EXPECTED_REQUESTED_IDS}）`);
  assert.ok(
    distinct.size >= EXPECTED_REQUESTED_IDS,
    `只请求了 ${distinct.size} 个 id（< ${EXPECTED_REQUESTED_IDS}）——有段落没跑到，别拿「部分绑定」当通过`,
  );
});

test("③ 监听总数 ≥ 实测值（14 段缺一段就掉下来）", () => {
  const { elements } = loadPagesModule({ hasPagesView: true, readyState: "complete" });
  let totalListeners = 0;
  for (const node of elements.values()) totalListeners += countListeners(node);
  console.log(`    绿③：total listeners ${totalListeners}（期望 ≥ ${EXPECTED_LISTENERS}）`);
  assert.ok(
    totalListeners >= EXPECTED_LISTENERS,
    `总监听数 ${totalListeners} < ${EXPECTED_LISTENERS}——有 wirePagesXxx 没跑到`,
  );
});

test("④ 没有 #view-pages：不抛，跳过计数 +1", () => {
  const { ctx } = loadPagesModule({ hasPagesView: false, readyState: "complete" });
  assert.equal(
    typeof ctx.window.PagesView?.init,
    "function",
    "跳过 wireAll 之后模块必须仍然正常导出 api（守卫只跳过接线，不该影响 init）",
  );
  assert.equal(
    ctx.document.documentElement.dataset.pagesWireSkipped,
    "1",
    "没有 pages 视图时应当静默跳过并留一条诊断计数（dataset.pagesWireSkipped）",
  );
});
