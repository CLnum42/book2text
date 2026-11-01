// 目录确认视图（index-view.js）的特征测试：锁 **Slice I1 那次行为改动**。
//
// 改动是什么：`loadPageIndex` 原来是"取数据 + 写三处目录 DOM（index-meta / index-list / index-empty）
// + 顺手 renderPageIndex()"一锅端；搬进模块后它变成**纯数据服务**，只返回
// `{status: "ok" | "error" | "busy"}`，渲染归模块的 `openPageIndex`。
//
// 为什么必须锁：预览也会调 `injected.loadPageIndex()`（`preview-view.js` 里刷新印刷页码标签那条）。
// 如果渲染又被人塞回数据服务里，**用户在预览页翻页时，目录列表会被反复重画**——
// 这不是崩溃，是每次切回来都要重新滚一遍、还可能闪一下；只有"事后看一眼 DOM"能发现。
//
// 三条：
// 1. 预览那条路径调 `loadPageIndex()` 时，目录 DOM 一个字节都不写（哨兵断言）；
// 2. 回目录时（`openPageIndex` 等完数据）**确实**渲染了——不然第一条可以靠"永远不渲染"骗过；
// 3. `busy` 分支：加载在飞时再调一次，仍然一个字不写，且返回 `{status:"busy"}`（不是 error）。
//
// 环境：node + vm + 最小假 DOM，不依赖真浏览器（渲染仍由 QA 的端到端验收兜底）。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { loadApp, runInApp } from "./load-app.mjs";

// B2T_INDEX_JS：把被测模块指到别处（变异验证用；与 load-app 的 B2T_APP_JS 同一口径）
const INDEX_SRC = readFileSync(
  process.env.B2T_INDEX_JS
    || new URL("../../backend/book2text/static/index-view.js", import.meta.url),
  "utf8",
);

// 放宽期（刀 C 的产品笔落盘前）这个文件还不存在：用 existsSync 兜住，收紧笔改成必须存在
const PAGE_INDEX_PATH = new URL("../../backend/book2text/static/page-index.js", import.meta.url);
const PAGE_INDEX_SRC = existsSync(PAGE_INDEX_PATH) ? readFileSync(PAGE_INDEX_PATH, "utf8") : "";

const ctx = loadApp({ require: [] });

// ---------------------------------------------------------------- 最小假 DOM

const ELEMENTS = new Map();

function fakeNode() {
  const node = {
    listeners: {},
    dataset: {},
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    hidden: false,
    textContent: "",
    title: "",
    htmlWrites: 0,     // innerHTML 被赋值几次（"列表被清空/重写"的另一种形态）
    value: "",
    disabled: false,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    clientWidth: 1400,
    clientHeight: 900,
    offsetTop: 0,
    offsetHeight: 0,
    children: [],
    appended: 0,          // 被 append / appendChild 的次数（"列表有没有被重画"用这个数）
    append(...items) {
      for (const item of items) {
        this.appended += 1;
        this.children.push(item);
      }
    },
    appendChild(item) {
      this.append(item);
      return item;
    },
    prepend(...items) {
      this.append(...items);
    },
    remove() {},
    replaceChildren(...items) {
      this.children = [];
      this.append(...items);
    },
    insertBefore(item) {
      this.append(item);
      return item;
    },
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
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
  // innerHTML 用访问器：赋一次值就记一次，否则 `list.innerHTML = ""` 这种"清空重画"
  // 在假 DOM 上完全看不出来（append 计数为 0，测试会假绿）。
  let html = "";
  Object.defineProperty(node, "innerHTML", {
    get: () => html,
    set: (value) => {
      html = String(value);
      node.htmlWrites += 1;
      node.children = [];
    },
  });
  node.parentElement = node;
  node.parentNode = node;
  node.nextSibling = null;
  node.previousSibling = null;
  node.firstElementChild = null;
  node.lastElementChild = null;
  return node;
}

/** 目录页的三个 DOM 点：`index-meta` / `index-list` / `index-empty`。 */
const el = (id) => {
  if (!ELEMENTS.has(id)) ELEMENTS.set(id, fakeNode());
  return ELEMENTS.get(id);
};

let apiRouter = null;

function installStubs() {
  ctx.document.getElementById = el;
  ctx.document.querySelector = () => fakeNode();
  ctx.document.querySelectorAll = () => [];
  ctx.document.createElement = () => fakeNode();
  ctx.document.createDocumentFragment = () => fakeNode();
  ctx.document.createTextNode = (text) => Object.assign(fakeNode(), { textContent: String(text) });
  ctx.document.body = fakeNode();
  ctx.performance = { now: () => 0 };
  ctx.getComputedStyle = () => ({ getPropertyValue: () => "" });
  ctx.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};
  ctx.innerWidth = 1400;
  ctx.innerHeight = 900;
  ctx.requestAnimationFrame = (fn) => {
    if (typeof fn === "function") fn();
    return 1;
  };
  ctx.cancelAnimationFrame = () => {};
  ctx.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
    clear() {},
  };
  ctx.apiJson = async (url) => {
    if (!apiRouter) throw new Error(`用例没有配路由，却请求了 ${url}`);
    const handler = apiRouter(url);
    if (!handler) throw new Error(`路由没覆盖 ${url}`);
    return handler;
  };
}

/** 刀 C：page-index.js 的状态在它自己的闭包里；重跑源码就是"换一份干净实例"。 */
function installPageIndexModule() {
  vm.runInContext(PAGE_INDEX_SRC, ctx, { filename: "page-index.js" });
  ctx.PageIndexService.init({
    apiJson: (url) => ctx.apiJson(url),
    getCurrentProject: () => runInApp(ctx, "currentProject"),
    getQualityRadios: () => [],
    blocksKey: (pageNo) => runInApp(ctx, "pageBlockKey")(pageNo),
    blocksGet: () => undefined,
    blocksRemember: () => {},
  });
}

/** 把模块骨架载进 app 上下文（模拟 index.html 的加载顺序：模块先于 app.js 的调用）。 */
function installIndexView() {
  vm.runInContext(INDEX_SRC, ctx, { filename: "index-view.js" });
}

/**
 * 给模块注入最小 deps。口径与生产一致：
 * - 仍住 app.js 的（pageIndexData / pageIndexProject / pageIndexLoading / loadPageIndex …）直接映射过去；
 * - 已在模块里的（indexTiles 之类）先按模块状态读，读不到再退回 app.js。
 */
function installIndexDeps() {
  const app = (expr) => runInApp(ctx, expr);
  const special = {
    el: (id) => el(id),
    apiJson: (url) => ctx.apiJson(url),
    loadPageIndex: () => loadIndexForTest(),
    loadIndexBlocks: () => Promise.resolve([]),
    clearImagePlaceholder: () => {},
    getProject: () => app("currentProject"),
    getPageIndexData: () => pageIndexDataOf(),
    getPageIndexProject: () => pageIndexProjectOf(),
    getPageIndexLoading: () => pageIndexLoadingOf(),
    getPagesMarginOn: () => app("pagesMarginOn"),
    setPagesMarginOn: (value) => app(`pagesMarginOn = ${Boolean(value)};`),
    savePageMarginPreference: () => {},
    getPagesOverlayOn: () => app("pagesOverlayOn"),
    setPagesOverlayOn: (value) => app(`pagesOverlayOn = ${Boolean(value)};`),
    savePageOverlayPreference: () => {},
    getPagesMarginToggle: () => el("pages-margin-toggle"),
    getPagesOverlayToggle: () => el("pages-overlay-toggle"),
    getDetailPageNo: () => null,
    getPageZoomIndex: () => 0,
    setPageZoomIndex: () => {},
    setPageZoomTouched: () => {},
    getImageQualityMode: () => "auto",
    setImageQuality: () => {},
    isActive: () => app(`currentView === "index"`),
    goToWorkflowStep: () => {},
    pageImageUrl: () => "",
    pageProfileFor: () => ({}),
    imageWindow: () => [1, 2],
    zoomScales: () => [1],
    paintTileMargin: () => {},
    renderPageBlocks: () => {},
    blockCountedInMargin: () => false,
    clearTileMargin: () => {},
    clearPageBlocks: () => {},
    toggleMarginView: () => {},
    togglePageBlocksOverlay: () => {},
  };
  // 其余名字给空实现；get*/set* 先按模块状态读写（本文件用得到的都已在 special 里）
  const names = [...new Set([...INDEX_SRC.matchAll(/injected\.([A-Za-z_]+)/g)].map((m) => m[1]))];
  const deps = {};
  for (const name of names) {
    if (special[name]) {
      deps[name] = special[name];
      continue;
    }
    if (/^(get|is)/.test(name)) {
      const stateName = name.replace(/^(get|is)/, "").replace(/^./, (ch) => ch.toLowerCase());
      deps[name] = () => {
        try {
          return vm.runInContext(stateName, ctx);
        } catch {
          return undefined;
        }
      };
      continue;
    }
    if (/^set/.test(name)) {
      const stateName = name.replace(/^set/, "").replace(/^./, (ch) => ch.toLowerCase());
      deps[name] = (value) => {
        ctx.__setValue = value;
        try {
          vm.runInContext(`${stateName} = __setValue;`, ctx);
        } catch {
          /* 未映射的 setter：忽略 */
        }
      };
      continue;
    }
    deps[name] = () => undefined;
  }
  ctx.window.IndexView.init(deps);
}

// ---------------------------------------------------------------- 公共准备

// 真实的 /page-index 返回形状：printed 是数组，missing 为真时 missing_reason 说明原因
const PAGES = [
  { page_no: 1, printed: [], missing: true, missing_reason: "front_back", jump: [] },
  { page_no: 2, printed: ["1"], missing: null, jump: [] },
  { page_no: 3, printed: ["2"], missing: null, jump: [] },
];

function resetState() {
  ELEMENTS.clear();
  apiRouter = null;
  ctx.__setValue = undefined;
  runInApp(
    ctx,
    `currentView = "index";
     currentProject = { project_id: "p1", pages: [
       { page_no: 1, page_id: "pg1", width_pt: 612, height_pt: 792 },
       { page_no: 2, page_id: "pg2", width_pt: 612, height_pt: 792 },
       { page_no: 3, page_id: "pg3", width_pt: 612, height_pt: 792 },
     ] };

     pagesMarginOn = false; pagesOverlayOn = false;`,
  );
  // 刀 C：页码索引的状态在 page-index.js 里，重跑一次模块源码 = 拿到一份全新实例
  if (PAGE_INDEX_SRC) installPageIndexModule();
  else runInApp(ctx, "pageIndexData = null; pageIndexProject = null; pageIndexLoading = false;");
  apiRouter = (url) => {
    if (url.includes("/page-index")) {
      return { pages: PAGES, stats: { total: 3, numbered: 2 } };
    }
    return null;
  };
}

// ── 刀 C 放宽垫片：page-index.js 落盘前走 app.js，落盘后走服务模块。
// 收紧笔会把这一整段删掉、改成只调模块（见该笔提交说明）。
const pageIndexService = () => ctx.PageIndexService || null;
function loadIndexForTest() {
  return pageIndexService() ? pageIndexService().loadIndex() : ctx.loadPageIndex();
}
const pageIndexDataOf = () =>
  pageIndexService() ? pageIndexService().getData() : runInApp(ctx, "pageIndexData");
const pageIndexProjectOf = () =>
  pageIndexService() ? pageIndexService().getProject() : runInApp(ctx, "pageIndexProject");
const pageIndexLoadingOf = () =>
  pageIndexService() ? pageIndexService().isLoading() : runInApp(ctx, "pageIndexLoading");

/** 目录页当前的"指纹"：meta 文字 + 列表被 append 的次数。 */
function indexDomFingerprint() {
  const list = el("index-list");
  return { meta: el("index-meta").textContent, appended: list.appended, htmlWrites: list.htmlWrites };
}

// ---------------------------------------------------------------- 用例

test("loadPageIndex 只取数：预览那条路径调它，目录 DOM 一个字节都不写", () => {
  resetState();
  installIndexDeps();
  return (async () => {
    // 先渲染一次目录（模拟用户已经在目录确认页看过列表）
    await ctx.window.IndexView.enter();
    const before = indexDomFingerprint();
    assert.ok(before.appended > 0, "目录第一次进来就没渲染任何行——后面的哨兵断言会失去意义");

    // 哨兵：之后谁再写这两处，值就会变
    el("index-meta").textContent = "SENTINEL-META";
    el("index-list").appended = 0;
    el("index-list").htmlWrites = 0;

    // 预览刷新印刷页码标签时做的就是这一行（preview-view.js 的 injected.loadPageIndex()）
    const result = await loadIndexForTest();

    // 跨 realm：vm 里造的对象原型不同，deepStrictEqual 会判不等——只比 status 字符串
    assert.equal(result.status, "ok", "loadPageIndex 的返回值不是纯状态对象");
    assert.equal(el("index-meta").textContent, "SENTINEL-META",
      "预览期间目录的 meta 被重写了——渲染又被塞回数据服务里了");
    assert.equal(el("index-list").appended, 0,
      "预览期间目录列表被重画了——用户每次从预览切回来都要重新滚一遍");
    assert.equal(el("index-list").htmlWrites, 0,
      "预览期间目录列表被清空/重写过（innerHTML 赋值）");
  })();
});

test("回目录时确实渲染：openPageIndex 等完数据后列表不空、meta 是真统计", () => {
  resetState();
  installIndexDeps();
  return (async () => {
    await ctx.window.IndexView.enter();
    // resetState() 已换了一份新的 page-index 实例（无缓存），这次进入会真的走"加载 → 渲染"
    el("index-meta").textContent = "";
    el("index-list").appended = 0;
    el("index-list").htmlWrites = 0;

    await ctx.window.IndexView.enter();

    assert.match(el("index-meta").textContent, /3 页/, `回目录后 meta 没被渲染：${el("index-meta").textContent}`);
    assert.ok(el("index-list").appended > 0, "回目录后目录列表是空的——渲染被从 openPageIndex 里删掉了");
  })();
});

test("busy 分支：加载在飞时再调一次，一个字不写且返回 busy（不是 error）", () => {
  resetState();
  installIndexDeps();
  return (async () => {
    // 刀 C 之后状态在模块闭包里 ⇒ 用"并发两次"制造在飞；放宽期（模块未落盘）写老状态变量
    const inflight = pageIndexService() ? pageIndexService().loadIndex() : null;
    if (!pageIndexService()) runInApp(ctx, "pageIndexLoading = true;");
    el("index-meta").textContent = "SENTINEL-META";
    el("index-list").appended = 0;
    el("index-list").htmlWrites = 0;

    const result = await loadIndexForTest();

    assert.equal(result.status, "busy", "busy 分支现在返回的不是 busy");
    assert.equal(el("index-meta").textContent, "SENTINEL-META", "busy 时写了 meta——原行为是早退什么都不写");
    assert.equal(el("index-list").appended, 0, "busy 时重画了列表");
    assert.equal(el("index-list").htmlWrites, 0, "busy 时清空/重写了列表");
    if (inflight) await inflight;   // 收尾：让第一次加载自己结束
  })();
});

installStubs();
installIndexView();
