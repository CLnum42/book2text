// 审校页的特征测试（任务 94）：**锁现状**，为拆模块做前置。
//
// 铁规（Chief 定）：
// 1. 只锁**用户能感知的行为**，不锁 DOM 结构与函数名（拆模块时内部名字都会变）。
// 2. 判据用"跳转落在哪页 / 面板开没开 / 当前项 key / 已审计数 / 高亮在不在"这类。
// 3. 能在 node 里跑：vm 加载 + 打桩，不依赖真浏览器。
//
// 落点：main（Slice 1 已合入，模块骨架在 `static/reading-view.js`）。
// main 上还不存在的两项按条件 skip，见各用例的 reason——**不写成红**，main 必须一直绿。
//
// 现状：审校代码仍主要在 app.js 里，所以这里对**现有函数**打桩：
// `enterReviewStep` / `showView` / `gotoNextUnreviewed` / `updateReadingPage` /
// `readingEntryVisible` / `draftReading` / `readingDockSave` / `readingTreeSaveCollapsed`。
// 目标接口 `ReadingView.*`（见 docs/refactor/reading-view-boundary.md）落地后，这些用例
// 应当只改调用点、不改断言——断言写的是行为，不是实现。
//
// 打桩手段（见 README 的边界表）：顶层 `let` 用 `runInApp` 赋值；顶层函数直接 `ctx.fn = ...` 覆盖；
// `el()` 是 `const`，改它内部用的 `document.getElementById` 返回值。
//
// **红过没有**：这组是"锁现状"的特征测试，写的时候对着当前实现逐条核过，**没有历史 SHA 会红**
// （它们锁的是今天的行为，不是某个缺陷）。变异验证放在交付说明里：
// 改坏对应分支（去掉去重、去掉 min、去掉 filter 判断、跳过保存位置），对应用例必须红。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { loadApp, runInApp } from "./load-app.mjs";

const READING_VIEW_SRC = readFileSync(
  new URL("../../backend/book2text/static/reading-view.js", import.meta.url),
  "utf8",
);

/** 把模块骨架（经典脚本）载进同一个上下文，模拟 index.html 的加载顺序。 */
function installReadingView(target) {
  vm.runInContext(READING_VIEW_SRC, target, { filename: "reading-view.js" });
}

const ctx = loadApp({
  require: ["readingEntryVisible", "enterReviewStep"],
});

// ---------------------------------------------------------------- 最小假 DOM

const ELEMENTS = new Map();   // id → 假元素（同一 id 必须是同一个对象，否则监听器挂不住）

function fakeNode() {
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
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    clientWidth: 100,
    clientHeight: 100,
    offsetTop: 0,
    offsetHeight: 0,
    children: [],
    childNodes: [],
    append() {},
    appendChild() {},
    prepend() {},
    remove() {},
    replaceChildren() {},
    insertBefore() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== handler);
    },
    focus() {},
    select() {},
    scrollIntoView() {},
    scrollTo() {},
    closest: () => null,
    cloneNode: () => fakeNode(),
    querySelector: () => fakeNode(),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }),
  };
  node.parentElement = node;   // 自引用：足够让 `el(x).parentElement.classList` 这类读取不炸
  node.parentNode = node;
  node.nextSibling = null;
  node.previousSibling = null;
  node.firstElementChild = null;
  node.lastElementChild = null;
  return node;
}

const NOTICE_LOG = [];
const STORAGE = new Map();
const realStorage = {
  getItem: (key) => (STORAGE.has(String(key)) ? STORAGE.get(String(key)) : null),
  setItem: (key, value) => STORAGE.set(String(key), String(value)),
  removeItem: (key) => STORAGE.delete(String(key)),
  clear: () => STORAGE.clear(),
  key: (index) => [...STORAGE.keys()][index] ?? null,
  get length() { return STORAGE.size; },
};
let apiRouter = null;

function installStubs() {
  // 浏览器侧全局
  ctx.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
  ctx.getComputedStyle = () => ({ getPropertyValue: () => "" });
  ctx.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  ctx.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  ctx.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};
  ctx.dispatchEvent = () => true;
  ctx.scrollTo = () => {};
  ctx.innerHeight = 900;
  ctx.localStorage = realStorage;   // 加载器里的 localStorage 是 noop 桩，偏好读写要真存储
  ctx.innerWidth = 1400;

  ctx.document.getElementById = (id) => {
    if (!ELEMENTS.has(id)) ELEMENTS.set(id, fakeNode());
    return ELEMENTS.get(id);
  };
  ctx.document.querySelector = () => fakeNode();
  ctx.document.querySelectorAll = () => [];
  ctx.document.createElement = () => fakeNode();
  ctx.document.createDocumentFragment = () => fakeNode();
  ctx.document.createTextNode = (text) => Object.assign(fakeNode(), { textContent: String(text) });
  ctx.document.createRange = () => ({ selectNodeContents() {}, setStart() {}, setEnd() {} });
  ctx.document.body = fakeNode();

  // 网络：所有请求走一个可配置路由；默认拒绝，避免用例"看起来跑通其实在发请求"
  ctx.apiJson = async (url, options) => {
    if (!apiRouter) throw new Error(`用例没有配路由，却请求了 ${url}`);
    const handler = apiRouter(url, options);
    if (!handler) throw new Error(`路由没覆盖 ${url}`);
    return handler;
  };
  // 提示条是"用户能感知"的一部分：记下来给用例断言
  ctx.showNoticeBar = (text) => NOTICE_LOG.push(String(text));
  // 重活/无关链路：位置持久化、正文渲染、滚动跟随、工作流角标
  // 模拟 index.html 的加载顺序：reading-view.js 先于 app.js 的调用发生。
  // main 上 app.js 的 applyReadingSplit 等已改成薄转发，模块没载入就会报 applySplit undefined。
  installReadingView(ctx);
  ctx.savePosition = () => {};
  ctx.renderReading = () => {};
  ctx.queueAfterSteps = (fn) => (typeof fn === "function" ? fn() : undefined);
  ctx.pausePageThumbnails = () => {};
  ctx.closeTaskDrawer = () => {};
  ctx.syncWorkflowSteps = () => {};
  ctx.hydrateView = () => {};
  ctx.loadLanguageSummary = () => {};
  ctx.ensureReadingPages = () => {};
  ctx.updateReadingPage = (pageNo) => runInApp(ctx, `readingPageNo = ${Number(pageNo)};`);
}

/**
 * 点「下一处未审」按钮——L4 之后 gotoNextUnreviewed 搬进模块，
 * 公开入口是 `#reading-next-unreviewed` 的 click（reading-view.js:169 绑的本地函数）。
 * 返回的 promise 就是那次点击触发的异步处理（模块的 handler 是 async，addEventListener 拿到的是它本身）。
 */
async function clickReadingNext() {
  const node = ELEMENTS.get("reading-next-unreviewed");
  assert.ok(node, "找不到 #reading-next-unreviewed —— 模块 init 没绑上按钮");
  const handlers = node.listeners.click || [];
  assert.ok(handlers.length > 0, "#reading-next-unreviewed 没有绑 click 处理器");
  await Promise.all(handlers.map((handler) => handler({ type: "click" })));
}

/** 每条例行都从同一份干净状态出发。 */
function resetState() {
  ELEMENTS.clear();
  NOTICE_LOG.length = 0;
  apiRouter = null;
  runInApp(
    ctx,
    `currentView = "library";
     currentProject = { project_id: "p1", pages: [
       { page_no: 1, page_id: "pg1", width_pt: 612, height_pt: 792 },
       { page_no: 2, page_id: "pg2", width_pt: 612, height_pt: 792 },
       { page_no: 3, page_id: "pg3", width_pt: 612, height_pt: 792 },
     ] };
     readingData = { segments: [] }; readingProject = "p1";
     readingEntries = []; readingMarks = new Map(); readingDrafts = new Map(); readingInlineEdits = new Map();
     readingPageBlocks = new Map(); readingTiles = new Map(); readingPageCounts = new Map();
     readingGlobalCounts = null;
     readingPageNo = 1; readingCursorEntry = null; readingPanelKey = null;
     readingFilter = "all"; readingNextLog.length = 0; readingTreeData = null;
     localStorage.clear();`,
  );
}

/** 一行差异条目（entry = marks 里的一条）。 */
function makeEntry(blockId, lineIndex, pageNo, level = "differs_chars") {
  return { block_id: blockId, line_index: lineIndex, page_no: pageNo, level, current: "旧", candidate: "新" };
}

function setEntries(entries) {
  // 注意：`entries` 是宿主变量，vm 里看不到，所以只嵌一次 JSON，再在 vm 里读回来
  runInApp(ctx, `readingEntries = ${JSON.stringify(entries)};
    readingMarks = new Map(readingEntries.map((e) => [readingKey(e.block_id, e.line_index), e]));`);
}

function readState(code) {
  return runInApp(ctx, code);
}

installStubs();

/**
 * 给模块注入最小 deps（模拟 app.js 的 init 注入），让 `ReadingView.reload()` 能真正跑完一次加载。
 *
 * 为什么用它而不是 `await ctx.openReading()`：L3 把 openReading 搬进模块后，app.js 里已经没有它；
 * `ReadingView.enter()` 是 fire-and-forget（内部 `openReading()` 不带 await），等不到完成；
 * `reload()` 是公开的 async 入口，内部 `response → await openReading()`，是唯一能等到"加载完成"的口。
 * 状态仍在 app.js（R5 的 owner），所以 getter/setter 都映射回 vm 里的变量。
 */
function installReadingDeps() {
  const get = (expr) => runInApp(ctx, expr);
  const set = (expr, value) => runInApp(ctx, `${expr} = ${JSON.stringify(value)};`);
  // 观察器状态（Intersection / Resize）：模块自己 `new`，再 set 进来、get 回去；
  // 未建立时模块依赖 `get()` 为假值（`if (!get()) return;`）。
  // 通用 set 兜底是 `JSON.stringify(value)`——实例会变成 `{}`：随后 `.observe()` 直接 TypeError，
  // 或者 `if (get()) get().disconnect()` 判真后 `.disconnect` 也不是函数（2026-10-29 L5 落地红了 3 条）。
  // 所以这一类状态一律存实例本体，null 原样透传（用例只要求能 observe/unobserve/disconnect，
  // 观察是否真的生效属于浏览器行为，不在 node 层验）。
  let nearObserver = { observe() {}, unobserve() {}, disconnect() {} };
  let visibleObserver = { observe() {}, unobserve() {}, disconnect() {} };
  // 需要真实读写的状态（其余 get*/set* 一律给空实现：本用例只跑"加载一次"，不碰那些链路）
  const SPECIAL = {
    el: (id) => ctx.document.getElementById(id),
    getReadingNearObserver: () => nearObserver,
    setReadingNearObserver: (value) => {
      nearObserver = value;
    },
    getReadingVisibleObserver: () => visibleObserver,
    setReadingVisibleObserver: (value) => {
      visibleObserver = value;
    },
    // 块数据：loadIndexBlocks 仍住在 app.js（注入侧有转发），转发给它比重造一份假数据更真。
    // 通用兜底返回 undefined 会让 `ensureReadingBlocks` 里的 `.then` 直接炸。
    loadIndexBlocks: (pageNo) => ctx.loadIndexBlocks(pageNo),
    apiJson: (url, options) => ctx.apiJson(url, options),
    readingOptions: () => ({ page_types: ["body"], confirmed_only: false, page_numbers: null }),
    getProject: () => get("currentProject"),
    getProjectId: () => {
      const project = get("currentProject");
      return project ? project.project_id : null;
    },
    getPageNo: () => get("readingPageNo"),
    getMarks: () => get("readingMarks"),
    getDrafts: () => get("readingDrafts"),
    getInlineEdits: () => get("readingInlineEdits"),
    getReadingEntries: () => get("readingEntries"),
    getReadingPageCounts: () => get("readingPageCounts instanceof Map ? readingPageCounts : new Map()"),
    getReadingPageBlocks: () => get("readingPageBlocks instanceof Map ? readingPageBlocks : new Map()"),
    getReadingTiles: () => get("readingTiles instanceof Map ? readingTiles : new Map()"),
    // 这两个的返回值会被取 .length，空实现（undefined）会炸；映射回 vm 里的真实函数
    readingVisibleSegments: () => get("readingVisibleSegments()"),
    readingFlowPages: () => get("readingFlowPages()"),
    readingLineNode: () => null,
    // 队列链路：这些函数仍住在 app.js（L4 只搬了 gotoNextUnreviewed 本身），注入侧转发回去
    readingKey: (blockId, lineIndex) => ctx.readingKey(blockId, lineIndex),
    gotoReadingEntry: (entry) => ctx.gotoReadingEntry(entry),
    logReadingNext: (entry, extra) => ctx.logReadingNext(entry, extra),
    ensureReadingMarksWindow: (pageNo) => ctx.ensureReadingMarksWindow(pageNo),
    showNoticeBar: (text) => ctx.showNoticeBar(text),
    getReadingData: () => get("readingData"),
    getReadingProject: () => get("readingProject"),
    getReadingAutoJumpDone: () => get("readingAutoJumpDone"),
    getReadingOpenStartedAt: () => get("readingOpenStartedAt"),
    setReadingOpenStartedAt: (value) => set("readingOpenStartedAt", value),
    setReadingAutoJumpDone: (value) => set("readingAutoJumpDone", value),
    setReadingData: (value) => set("readingData", value),
    setReadingProject: (value) => set("readingProject", value),
    setMarks: (value) => set("readingMarks", value),
    setReadingEntries: (value) => set("readingEntries", value),
    setReadingMarksWindow: (value) => set("readingMarksWindow", value),
    setReadingGlobalCounts: (value) => set("readingGlobalCounts", value),
    setReadingPageCounts: (value) => set("readingPageCounts", value),
    setReadingFirstUnackedPage: (value) => set("readingFirstUnackedPage", value),
  };
  // 剩下两个观察器（readingObserver / readingResizeObserver）与 near/visible 同类：
  // 未建立时 get() 必须是假值，set 之后 get() 必须拿回同一个实例。统一按类生成，避免下一个再漏。
  const observerState = { readingObserver: null, readingResizeObserver: null };
  for (const key of Object.keys(observerState)) {
    const Name = key[0].toUpperCase() + key.slice(1);
    SPECIAL[`get${Name}`] = () => observerState[key];
    SPECIAL[`set${Name}`] = (value) => {
      observerState[key] = value ?? null;
    };
  }
  // 模块 spread 了 deps，所以必须把**用到的每个名字**都显式给出（Proxy 过不了 spread）
  const names = [...new Set([...READING_VIEW_SRC.matchAll(/injected\.([A-Za-z_]+)/g)].map((m) => m[1]))];
  const deps = {};
  for (const name of names) {
    if (SPECIAL[name]) {
      deps[name] = SPECIAL[name];
      continue;
    }
    // 未覆盖的名字：get*/is* 尝试按"去掉前缀、首字母小写"读 vm 里的同名状态（读不到就给 undefined）；
    // set* 同理写回；其余回调给空实现。这样 L4/L5 再搬东西时不用逐个补 deps。
    if (/^(get|is)/.test(name)) {
      const stateName = name.replace(/^(get|is)/, "").replace(/^./, (ch) => ch.toLowerCase());
      deps[name] = () => {
        try {
          return get(stateName);
        } catch {
          return undefined;
        }
      };
      continue;
    }
    if (/^set/.test(name)) {
      const stateName = name.replace(/^set/, "").replace(/^./, (ch) => ch.toLowerCase());
      deps[name] = (value) => {
        try {
          set(stateName, value);
        } catch {
          /* 未映射的 setter：忽略 */
        }
      };
      continue;
    }
    deps[name] = () => undefined;
  }
  ctx.ReadingView.init(deps);
}

// 计数修复（任务 93）移植到 main 后（d48b16d），这条自动开跑；没移植时 skip 并写明原因。
const progressNumbersSkip =
  typeof ctx.readingProgressNumbers === "function"
    ? false
    : "main 还没有 readingProgressNumbers（任务 93 的计数提取）；移植后这条自动开跑";

// splitPrefs / saveSplit 是**搬运期临时导出**（Architect：Slice 2 结束后
// `Object.keys(window.ReadingView)` 只许 7 个）。这条偏好用例借它们验证
// "三栏宽度重入后还在"；它们被移除时自动 skip，不许把临时导出当稳定接口锁住。
const splitApiSkip =
  typeof ctx.ReadingView?.splitPrefs === "function" && typeof ctx.ReadingView?.saveSplit === "function"
    ? false
    : "splitPrefs/saveSplit 临时导出已移除（Slice 2 收尾）；这条偏好用例要改用稳定接口重写";

// ---------------------------------------------------------------- 1. enter / exit

test("进入审校：视图切到 reading，且位置被记录", () => {
  resetState();
  readState('readingPageNo = 2;');
  ctx.enterReviewStep();
  assert.equal(readState("currentView"), "reading", "用户看到的主区域不是审校视图");
  assert.equal(readState("readingPageNo"), 2, "进入时把当前页丢了");
});

test("退出审校再回来：视图切换，但页码不被重置", () => {
  resetState();
  ctx.enterReviewStep();
  readState("readingPageNo = 3;");
  ctx.showView("pages");
  assert.equal(readState("currentView"), "pages");
  ctx.enterReviewStep();
  assert.equal(readState("currentView"), "reading");
  assert.equal(readState("readingPageNo"), 3, "回到审校时回到了别的页（用户会以为丢了位置）");
});

test("进入审校：正文段数按服务端返回的正文流渲染（4821 段就是 4821 段）", () => {
  resetState();
  readState('readingData = null; readingProject = null;');
  const segments = Array.from({ length: 4821 }, (_, index) => ({
    seq: index + 1, type: "paragraph", text: `第 ${index + 1} 段`, block_ids: [`b${index}`], line_spans: [],
  }));
  apiRouter = (url) => {
    if (url.includes("/export/preview")) return { segments, segment_count: segments.length };
    if (url.includes("/review/marks")) return { items: [], counts: { chars_total: 0, chars_unacked: 0 }, page_counts: {} };
    if (url.includes("/review/tree")) return { pages: [] };
    if (url.includes("/jobs")) return { active: null };
    return null;
  };
  ctx.refreshPunctGroups = () => {};
  return (async () => {
    // L3：openReading 搬进模块 → 走公开 async 入口 reload()，它内部 await 同一次加载。
    // 断言不变：读到的仍是 app.js 侧的 readingData（状态 owner 没变），段数必须等于服务端返回。
    installReadingDeps();
    await ctx.ReadingView.reload();
    assert.equal(readState("readingData.segments.length"), 4821, "正文段数没按服务端返回的正文流来");
    assert.equal(readState("readingProject"), "p1");
  })();
});

// ---------------------------------------------------------------- 2. 队列推进

test("队列推进：连续 3 次落在 3 个不同 key，页码单调不减", () => {
  resetState();
  const lines = [
    { block_id: "b1", line_index: 0, page_no: 1 },
    { block_id: "b2", line_index: 0, page_no: 2 },
    { block_id: "b3", line_index: 0, page_no: 3 },
  ];
  setEntries(lines.map((l) => makeEntry(l.block_id, l.line_index, l.page_no)));
  // 服务端"下一处"在真实链路里按游标返回；这里模拟同样的行为
  let calls = 0;
  apiRouter = (url) => {
    if (url.includes("/review/next-lines")) {
      calls += 1;
      return { lines, total: lines.length, outside_stream: { count: 0, sample: [] } };
    }
    return null;
  };
  ctx.ensureReadingMarksWindow = async () => {};

  return (async () => {
    installReadingDeps();
    const seen = [];
    for (let index = 0; index < 3; index += 1) {
      await clickReadingNext();
      const cursor = JSON.parse(readState("JSON.stringify([readingCursorEntry.block_id, readingCursorEntry.line_index, readingCursorEntry.page_no])"));
      seen.push({ key: `${cursor[0]}:${cursor[1]}`, page: cursor[2] });
    }
    assert.equal(new Set(seen.map((item) => item.key)).size, 3, `三次落点不是 3 个不同 key：${JSON.stringify(seen)}`);
    const pages = seen.map((item) => item.page);
    assert.deepEqual(pages, [...pages].sort((a, b) => a - b), `页码不是单调不减：${pages}`);
  })();
});

// ---------------------------------------------------------------- 3. 当前项

test("当前项：cursor 与最后一次跳转的目标一致（key / 页 / 行）", () => {
  resetState();
  const lines = [
    { block_id: "b1", line_index: 0, page_no: 1 },
    { block_id: "b9", line_index: 4, page_no: 2 },
  ];
  setEntries(lines.map((l) => makeEntry(l.block_id, l.line_index, l.page_no)));
  apiRouter = (url) => (url.includes("/review/next-lines")
    ? { lines, total: 2, outside_stream: { count: 0, sample: [] } }
    : null);
  ctx.ensureReadingMarksWindow = async () => {};

  return (async () => {
    installReadingDeps();
    await clickReadingNext();
    const first = JSON.parse(readState("JSON.stringify([readingCursorEntry.block_id, readingCursorEntry.line_index, readingCursorEntry.page_no])"));
    assert.deepEqual(first, ["b1", 0, 1]);
    await clickReadingNext();
    const second = JSON.parse(readState("JSON.stringify([readingCursorEntry.block_id, readingCursorEntry.line_index, readingCursorEntry.page_no])"));
    assert.deepEqual(second, ["b9", 4, 2], "当前项不是最后一次跳转的那条");
    assert.equal(readState("readingPageNo"), 2, "跳转后页码没跟上当前项");
  })();
});

// ---------------------------------------------------------------- 4. 已审计数

test("已审计数：接全书 counts，不随当前窗口变化", { skip: progressNumbersSkip }, () => {
  resetState();
  setEntries([makeEntry("a", 0, 1)]);
  runInApp(ctx, `readingGlobalCounts = { chars_total: 100, chars_unacked: 40 };
    readingDrafts = new Map([["a:0", { block_id: "a", line_index: 0 }]]);`);
  const wide = readState("JSON.stringify(readingProgressNumbers())");
  setEntries([makeEntry("a", 0, 1), makeEntry("b", 0, 2), makeEntry("c", 0, 3)]);
  const narrow = readState("JSON.stringify(readingProgressNumbers())");
  assert.deepEqual(JSON.parse(wide), { processed: 61, total: 100 });
  assert.deepEqual(JSON.parse(narrow), { processed: 61, total: 100 }, "换窗口后已审计数变了");
});

// ---------------------------------------------------------------- 5. 草稿

test("草稿：裁决一次 draftCount +1，同一条重复草稿不重复计数", () => {
  resetState();
  const entry = makeEntry("a", 1, 1);
  setEntries([entry]);
  ctx.draftReading(entry, "kept", null);
  assert.equal(readState("readingDrafts.size"), 1, "裁决后草稿数没 +1");
  ctx.draftReading(entry, "adopted", null);
  assert.equal(readState("readingDrafts.size"), 1, "同一条审了两次被算成两处草稿");
  assert.equal(readState('readingDrafts.get("a:1").ack'), "adopted", "重复裁决没覆盖成最后一次");
});

// ---------------------------------------------------------------- 6. 过滤器

test("过滤器：汉字级不混入标点条目；未审不混入已 ack / 已存草稿的条目", () => {
  resetState();
  const chars = makeEntry("a", 0, 1, "differs_chars");
  const punct = makeEntry("a", 1, 1, "differs_punct");
  const acked = { ...makeEntry("a", 2, 1), ack: "kept" };
  const drafted = makeEntry("a", 3, 1);
  setEntries([chars, punct, acked, drafted]);
  runInApp(ctx, `readingDrafts = new Map([["a:3", { block_id: "a", line_index: 3 }]]);`);

  // L2 笔2 把 setReadingFilter 搬进模块（app.js 定义数 0），这里不能再调它。
  // **只注入状态、不注入行为**：本用例锁的是"过滤器规则"（readingEntryVisible），
  // setter → 状态 的接线由 boundary.test.mjs 的静态断言与 QA 的页面级交互覆盖。
  runInApp(ctx, 'readingFilter = "chars";');
  assert.equal(readState(`readingEntryVisible(${JSON.stringify(chars)})`), true);
  assert.equal(readState(`readingEntryVisible(${JSON.stringify(punct)})`), false, "标点条目混进了汉字级队列");

  runInApp(ctx, 'readingFilter = "unacked";');
  assert.equal(readState(`readingEntryVisible(${JSON.stringify(acked)})`), false, "已审的条目还在未审队列里");
  assert.equal(readState(`readingEntryVisible(${JSON.stringify(drafted)})`), false, "已存草稿的条目还在未审队列里");
  assert.equal(readState(`readingEntryVisible(${JSON.stringify(punct)})`), true, "标点在未审视图里应当仍可见");

  runInApp(ctx, 'readingFilter = "all";');
  assert.equal(readState(`readingEntryVisible(${JSON.stringify(punct)})`), true);
});

// ---------------------------------------------------------------- 7. 偏好

test("偏好：三栏宽度写进 localStorage，重新加载模块后还在", { skip: splitApiSkip }, () => {
  resetState();
  installReadingView(ctx);
  ctx.ReadingView.init({});
  ctx.ReadingView.splitPrefs().tree = 300;
  ctx.ReadingView.saveSplit();
  const saved = readState("localStorage.getItem('b2t.readingSplit.v1')");
  assert.ok(saved && saved.includes("300"), `三栏宽度没写进 localStorage：${saved}`);

  // 模拟"模块重入"：新上下文共用同一份 localStorage，重新加载 reading-view.js
  const ctx2 = loadApp();
  ctx2.localStorage = realStorage;
  installReadingView(ctx2);
  const prefs = JSON.parse(vm.runInContext("JSON.stringify(window.ReadingView.splitPrefs())", ctx2));
  assert.equal(prefs.tree, 300, "重新加载后三栏宽度丢了");
});

test("偏好：左树折叠状态", {
  skip: "main 无此状态（左树折叠在暂停的 ux/dock 分支，属新功能，UX 冻结中）；合并后再开",
}, () => {});

// ---------------------------------------------------------------- 8. 失败不静默

test("没有下一处时不静默：明确说明，且不谎报进度", () => {
  resetState();
  setEntries([makeEntry("a", 0, 1)]);
  apiRouter = (url) => (url.includes("/review/next-lines")
    ? { lines: [], total: 0, outside_stream: { count: 0, sample: [] } }
    : null);
  ctx.ensureReadingMarksWindow = async () => {};

  return (async () => {
    installReadingDeps();
    const returned = await clickReadingNext();
    const log = JSON.parse(readState("JSON.stringify(readingNextLog)"));
    assert.equal(log[0].branch, "none", `没有下一处时记录的 branch 是 ${log[0].branch}`);
    assert.ok(NOTICE_LOG.length > 0, "没有下一处时用户什么都没看到（静默失败）");
    assert.match(NOTICE_LOG[NOTICE_LOG.length - 1], /已处理完|不在正文流/, "提示语没有说清是哪种情况");
    // 现状记录：当前实现返回 undefined（不是 {done:true}）——拆模块时要改成有返回值的契约
    assert.equal(returned, undefined, "当前实现没有返回值；这条锁的是现状，改契约时这里会红（预期）");
    assert.equal(readState("readingCursorEntry"), null, "没有下一处却把游标改了");
  })();
});

test("流外还有差异时要说数：不谎报“全部处理完”", () => {
  resetState();
  setEntries([makeEntry("a", 0, 1)]);
  apiRouter = (url) => (url.includes("/review/next-lines")
    ? { lines: [], total: 0, outside_stream: { count: 3, sample: [] } }
    : null);
  ctx.ensureReadingMarksWindow = async () => {};

  return (async () => {
    installReadingDeps();
    await clickReadingNext();
    assert.match(NOTICE_LOG[NOTICE_LOG.length - 1], /不在正文流/, "流外还有 3 处，却说全部处理完了");
  })();
});
