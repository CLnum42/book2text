// 刀 10 之后的常驻回归：**可见页重算 / 块框重画 / 建议扫描的收尾闭环**。
//
// 为什么这三条要常驻：它们在刀 9–10 里搬了三次（外壳 → 模块 → 模块内重排），每次都是**真机**上
// 用「滚一滚看看」验的，一轮 20–30 分钟，而且看不见「第二次滚动后集合只加不减」这类慢漂。
// 这里把三条判据压到 2 秒级：注入 metrics + 环境里的 scroller / grid，参数进、值出。
//
// 边界（别越界）：
// 1. 这里断言的是**行为**：滚到哪页集合就是哪几页 / 这一帧画了几页块框 / 队列空后会不会再扫一轮。
//    不锁实现顺序，也不锁内部变量名。改队列实现但行为不变 → 这些用例应当仍绿。
// 2. 入口只用**公共能力**：`onPagesNeedReflow()`（切回页面视图时外壳喊的那句）与 `applyPageZoom()`。
//    没有为测试新增导出，也不碰 pages-view.js 一行。
// 3. 帧预算 3 是**产品预算**（密集网格一屏十几页，一次全画会卡），所以单独断言它是 3：
//    改它应当是有人主动做的决定，不该被一条读源码的断言顺手跟过去。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PATH = fileURLToPath(new URL("../../backend/book2text/static/pages-view.js", import.meta.url));
const SRC = readFileSync(PATH, "utf8");

/** 一页瓷砖：位置由 metrics 给定；`_renderedBlocks` 由注入的 renderPageBlocks 回写（真实渲染器也这么做）。 */
function makeTile(pageNo, top, height = 300) {
  const overlay = { _renderedBlocks: null };
  // 片 2：容器归 overlay registry（它 mount 到 .page-tile__thumb 里），
  // 测试用最小 thumb 节点；`__seedDataGetter` 让"已经画过同一份块"这个前置状态能传给假 registry。
  const thumb = {
    dataset: {}, children: [],
    appendChild(child) { this.children.push(child); return child; },
    append() {}, querySelector: () => null, querySelectorAll: () => [],
    __seedDataGetter: () => overlay._renderedBlocks,
  };
  return {
    dataset: { pageNo: String(pageNo) },
    _overlay: overlay,
    _thumb: thumb,
    textContent: "", hidden: false, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ top, bottom: top + height, height, left: 0, width: 100 }),
    querySelector: (selector) => {
      if (selector === ".page-overlay") return overlay;
      if (selector === ".page-tile__thumb") return thumb;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, appendChild() {}, append() {}, closest: () => null,
  };
}

const makeNode = (id) => ({
  id, textContent: "", disabled: false, hidden: false, checked: false, dataset: {}, style: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  appendChild() {}, append() {}, closest: () => null, focus() {},
});

/**
 * 最小可信环境：只给这两条判据真正读到的东西。
 *
 * 「可信」的判据是**被观察的那件事必须真发生**：`renderPageBlocks` 要回写 `_renderedBlocks`
 * （否则幂等判断永远为真、用例自己变成假绿），`fetchPageSuggestions` 要返回真 Promise
 * 并在成功时写回缓存（否则 `.finally` 的收尾闭环根本不跑，第二轮扫描还会重复扫前 12 页）。
 */
function makeHarness({ tileCount = 3, viewport = 500, zoomIndex = 0, overlayOn = false } = {}) {
  const tiles = Array.from({ length: tileCount }, (_, index) => makeTile(index + 1, index * 400));
  const scroller = {
    scrollTop: 0, clientHeight: viewport,
    getBoundingClientRect: () => ({ top: 0, bottom: viewport, height: viewport, left: 0, width: 100 }),
    addEventListener() {},
  };
  const grid = {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    // init() 会往网格上挂事件（wirePagesPageGrid）——这里只是让它挂，不模拟点击
    addEventListener() {}, removeEventListener() {}, dataset: {}, style: {},
    querySelectorAll: (selector) => (selector === ".page-tile" ? tiles : []),
    querySelector: (selector) => {
      const hit = /data-page-no="(\d+)"/.exec(selector);
      if (!hit) return null;
      return tiles.find((tile) => tile.dataset.pageNo === hit[1]) || null;
    },
    closest: (selector) => (selector === ".split__main" ? scroller : null),
  };

  const state = {
    project: {
      project_id: "p1", kind: "book",
      pages: tiles.map((tile) => ({ page_no: Number(tile.dataset.pageNo), include: true, page_type: "body" })),
    },
    metrics: tiles.map((tile, index) => ({ tile, pageNo: index + 1, top: index * 400, height: 300 })),
    cache: new Map(),
    pending: new Set(),
    visible: new Set(),
    painted: [],
    requests: [],
    timers: [],
    frames: [],
    suggestionCache: new Map(),
  };

  const deps = {
    getCurrentProject: () => state.project,
    getPageTileMetrics: () => state.metrics,
    setPageTileMetrics: (value) => { state.metrics = value; },
    getPageZoomIndex: () => zoomIndex,
    getPagesMarginOn: () => false,
    getPagesOverlayOn: () => overlayOn,
    getCurrentView: () => "pages",
    pageBlockKey: (pageNo) => `v${pageNo}`,
    getPageBlockCache: () => state.cache,
    pageBlockPending: state.pending,
    getPageBlockVersions: () => new Map(),
    visiblePageNos: state.visible,
    renderPageBlocks: (tile, blocks) => {
      state.painted.push(Number(tile.dataset.pageNo));
      tile._overlay._renderedBlocks = blocks;
    },
    clearPageBlocks() {}, clearTileMargin() {}, paintTileMargin() {},
    recognitionOf: () => ({ status: "recognized" }),
    ensurePageSuggestion: () => {},
    pageSuggestionCache: state.suggestionCache,
    pageSuggestionFailed: new Set(),
    // 成功时要真的写回缓存：真实实现（app.js 的 fetchPageSuggestions）就是这么做的，
    // 少了它第二轮扫描会重复扫前 12 页，这条用例就成了假的。
    fetchPageSuggestions: (pageNo) => new Promise((resolve) => {
      state.requests.push({
        pageNo,
        resolve: () => { state.suggestionCache.set(pageNo, []); resolve({ suggestions: [] }); },
      });
    }),
    pageZoomLevel: () => ({ label: "中", image: "thumb" }),
    PAGE_ZOOM_LEVELS: [{}, {}, {}, {}],
    apiJson: () => new Promise(() => {}),
  };

  const ctx = {
    document: {
      getElementById: (id) => (id === "page-grid" ? grid : makeNode(id)),
      body: makeNode("body"), documentElement: makeNode("html"), activeElement: makeNode("active"),
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      createElement: (tag) => makeNode(tag),
    },
    console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (fn) => { state.frames.push(fn); return state.frames.length; },
    cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { state.timers.push({ fn, ms }); return state.timers.length; },
    clearTimeout() {},
    innerHeight: viewport,
  };
  ctx.window = ctx;
  // 片 2：页面视图的块框交给 overlay registry。假 registry 只模拟两条被判据依赖的语义：
  // ① 同数据不重画（版本判重）；② 空数据只收起、不算"画了一次"。
  let overlayHandleSeq = 0;
  ctx.window.OverlayLayer = {
    init() {},
    mount(host, { pageNo } = {}) {
      overlayHandleSeq += 1;
      const seed = host && typeof host.__seedDataGetter === "function" ? host.__seedDataGetter() : null;
      return { pageNo: Number(pageNo), host, seq: overlayHandleSeq, lastData: seed === null ? undefined : seed };
    },
    paint(handle, { data } = {}) {
      if (!handle) return;
      const next = data || [];
      if (handle.lastData !== undefined && JSON.stringify(next) === JSON.stringify(handle.lastData)) return;
      handle.lastData = next;
      if (next.length) state.painted.push(handle.pageNo);
    },
    unmount() {},
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "pages-view.js" });
  ctx.window.PagesView.init(deps);

  return { api: ctx.window.PagesView, tiles, scroller, state };
}

/**
 * 走真实的滚动路径跑一帧可见性重算：外壳喊 `onPagesNeedReflow()` → 模块排一帧 rAF
 * → 这一帧里跑 `updatePageVisibility`。**只跑这一帧**，块框泵留到后面手动跑，
 * 否则「这一帧画了几页」会被下一帧的泵混进来。
 */
function reflow(harness) {
  const from = harness.state.frames.length;
  harness.api.onPagesNeedReflow();
  const batch = harness.state.frames.splice(from);
  assert.equal(batch.length, 1, "一次重算应当只排一帧（同一帧内多次滚动只排一次）");
  batch[0]();
}

/** 跑掉一帧排队中的回调（块框泵靠它）。 */
function runOneFrame(harness) {
  const fn = harness.state.frames.shift();
  assert.ok(fn, "这一帧没有排队的回调");
  fn();
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

// ── 可见页重算 ───────────────────────────────────────────────────────────

test("可见页（② 替换）：滚动后集合是「这一屏的页」，不是「见过的所有页」", () => {
  const harness = makeHarness({ tileCount: 3 });
  reflow(harness);
  assert.deepEqual([...harness.state.visible].sort(), [1, 2], "第一屏：1、2 号页在视口 + 60 容差内");

  // 滚到第 1000px：1、2 号页离屏，3 号页进视口
  harness.scroller.scrollTop = 1000;
  reflow(harness);
  assert.deepEqual([...harness.state.visible].sort(), [3],
    "第二屏只剩 3 号页——离屏的页必须从集合里删掉（只加不减 = 集合越滚越大，离屏页的块框永远不会被清）");
  assert.ok(!harness.state.visible.has(1), "1 号页已离屏，仍留在 visiblePageNos 里");
});

test("可见页（③ 可见 ≠ 预取）：预取带内的页不进集合，±60 容差边界照旧", () => {
  const harness = makeHarness({ tileCount: 3, viewport: 500 });
  reflow(harness);
  // 3 号页 top = 800：离视口下沿 500 还有 300px，超出 +60 容差 → 不可见；
  // 但它在预取带（视口 ±1.5 屏 = ±750）里，会被预取、但不许算作可见。
  assert.ok(!harness.state.visible.has(3),
    "预取带内的页被算成了可见页——可见与预取是两个集合，混在一起会让块框为离屏页排队");
  // 2 号页 top = 400、bottom = 700：bottom 越过视口下沿，但 top 在 +60 容差内 → 可见
  assert.ok(harness.state.visible.has(2), "±60 容差内的页应当算可见（边界定义变了要有人知道）");
});

test("可见页（④ 量不出来时不改集合）：metrics 为 null ⇒ 直接返回，不把已画的页判成离屏", () => {
  const harness = makeHarness({ tileCount: 0 });
  harness.state.metrics = null;
  harness.state.visible.add(5);
  reflow(harness);
  assert.deepEqual([...harness.state.visible], [5],
    "量不出位置时把集合清空 = 视图还没显示就把已画的块框全判成离屏（用户看到框迟迟不出现）");
});

// ── 块框重画 ─────────────────────────────────────────────────────────────

// 缓存形状与生产一致：`rememberPageBlocks(key, data.blocks || [])` 存的是**块数组**
// （片 2 之后块框走 overlay registry，paint 的 data 必须是数组）。
const cacheBlocks = (harness, pageNos) => {
  for (const pageNo of pageNos) harness.state.cache.set(`v${pageNo}`, [`b${pageNo}`]);
};

test("块框（① 幂等）：同数据不重画——已画过同一份块的页，这一帧一次都不画", () => {
  const harness = makeHarness({ tileCount: 2, viewport: 1000, overlayOn: true });
  cacheBlocks(harness, [1, 2]);
  for (const tile of harness.tiles) tile._overlay._renderedBlocks = harness.state.cache.get(`v${tile.dataset.pageNo}`);
  reflow(harness);
  assert.deepEqual(harness.state.painted, [],
    "缓存没变的页被重画了——每帧重画同一份块，密集网格会一直掉帧");
});

test("块框（② 帧预算）：一帧最多画 3 页，剩下的排到下一帧，且一页都不丢", () => {
  const harness = makeHarness({ tileCount: 5, viewport: 3000, overlayOn: true });
  cacheBlocks(harness, [1, 2, 3, 4, 5]);
  reflow(harness);
  const budget = Number(/const PAGE_OVERLAY_FRAME_LIMIT = (\d+);/.exec(SRC)[1]);
  assert.equal(budget, 3, "帧预算常量变了——3 是产品预算（密集网格一次全画会卡）");
  assert.equal(harness.state.painted.length, budget, "这一帧画的页数不等于帧预算");

  runOneFrame(harness);
  assert.deepEqual(harness.state.painted.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5],
    "下一帧没把排队的页画完——排队等于丢页，用户会看到几页没有框");
});

test("块框（③ 缓存缺失不空画）：没有块数据时这一帧一页都不画", () => {
  const harness = makeHarness({ tileCount: 3, viewport: 2000, overlayOn: true });
  reflow(harness);
  assert.deepEqual(harness.state.painted, [], "没有缓存的页被「画」了——空画会把下一帧的幂等判断喂成真");
  runOneFrame(harness);
  assert.deepEqual(harness.state.painted, [], "泵那一帧在没有块数据时也画了");
});

// ── 建议扫描的收尾闭环 ───────────────────────────────────────────────────

test("建议扫描（三条件）：一轮最多扫 12 页，队列排空后自己再扫一轮，后面的页不会被饿死", async () => {
  const harness = makeHarness({ tileCount: 20, viewport: 8000 });
  harness.api.applyPageZoom();
  const scheduled = harness.state.timers.filter((timer) => timer.ms === 60);
  assert.equal(scheduled.length, 1, "进入页面视图后应当排一次建议扫描");
  scheduled[0].fn();

  assert.equal(harness.state.requests.length, 2, "一轮扫描后应当只有并发上限（2）个请求在飞");
  const first = [];
  for (let guard = 0; guard < 40 && harness.state.requests.length; guard += 1) {
    const next = harness.state.requests.shift();
    first.push(next.pageNo);
    next.resolve();
    await flushMicrotasks();
  }
  assert.equal(first.length, 12, "一轮只扫 12 页（预算），第 13 页起要等下一轮");
  assert.deepEqual(harness.state.painted, [], "建议扫描不该画块框");

  // 队列空 + 在飞 0 + 这一轮排过队 ⇒ 自己再扫一轮（否则第 13–20 页永远没有角标）
  const rescans = harness.state.timers.filter((timer) => timer.ms === 60);
  assert.equal(rescans.length, 2, "队列排空后没有再排一轮扫描——第 13 页以后会被饿死");
  rescans[1].fn();

  const second = [];
  for (let guard = 0; guard < 40 && harness.state.requests.length; guard += 1) {
    const next = harness.state.requests.shift();
    second.push(next.pageNo);
    next.resolve();
    await flushMicrotasks();
  }
  assert.equal(second.length, 8, "第二轮应当补齐剩下的 8 页");
  assert.equal(new Set([...first, ...second]).size, 20, "两轮扫描的并集没有覆盖全部 20 页");
});
