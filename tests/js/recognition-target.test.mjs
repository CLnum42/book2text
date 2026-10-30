// recognitionTarget 的常驻单元测试：6 态 + 3 条点击分派。
// 只走公共出口（renderRecognitionVerdict / rec-start-all 的监听），不新增导出。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadApp, runInApp, appModuleDeps } from "./load-app.mjs";

const SRC = readFileSync(fileURLToPath(new URL("../../backend/book2text/static/pages-view.js", import.meta.url)), "utf8");

function makeNode(id) {
  const classes = new Set();
  return {
    id, textContent: "", disabled: false, hidden: false, checked: false, dataset: {}, style: {},
    handlers: {}, children: [],
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    removeEventListener() {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    querySelector: () => null, querySelectorAll: () => [], appendChild() {}, closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }), focus() {},
    // :534 会读 state.parentElement 并往它身上 toggle is-ok/is-warn —— 父节点必须独立，不能是自己
    parentElement: null,
  };
}

function makeCtx(deps) {
  const els = new Map();
  const getElementById = (id) => {
    if (!els.has(id)) {
      const node = makeNode(id);
      node.parentElement = makeNode(`${id}-parent`);
      els.set(id, node);
    }
    return els.get(id);
  };
  const ctx = {
    document: { readyState: "complete", documentElement: makeNode("html"), getElementById,
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: makeNode("body") },
    console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "pages-view.js" });
  ctx.window.PagesView.init(Object.assign({}, deps));
  // 状态是 renderRecognitionVerdict 写出来的：公共出口跑一次
  ctx.window.PagesView.renderRecognitionVerdict();
  return { ctx, els, getElementById };
}

const recognized = (page) => ({ status: "recognized" });
const pendingStatus = () => ({ status: "unrecognized" });

function baseDeps(body, selection, statusOf) {
  return {
    marginBodyPages: () => body,
    selectionPages: () => selection,
    recognitionOf: statusOf,
    getCurrentProject: () => ({ project_id: "p1", kind: "book" }),
    getFinishSummary: () => null,
    getTaskJobId: () => null,
    getLastTaskData: () => null,
    AUX_SECONDS_PER_PAGE: 1,
    auxEstimateText: () => "约 1 秒/页",
    textLayerPages: () => 0,
    startBatchRecognition() {}, recognizeSelection() {}, startAuxiliaryAll() {},
  };
}

const button = (els) => els.get("rec-start-all");

test("态1 batch：有待识别、未选 → 「识别全部未识别页（N）」可点", () => {
  const body = [1, 2, 3].map((n) => ({ page_no: n, include: true }));
  const { els } = makeCtx(baseDeps(body, [], () => pendingStatus()));
  const b = button(els);
  assert.equal(b.textContent, "识别全部未识别页（3）");
  assert.equal(b.disabled, false);
});

test("态2 none：body 全已识别且未选 → 「无可识别页」disabled", () => {
  const body = [1, 2].map((n) => ({ page_no: n, include: true }));
  const { els } = makeCtx(baseDeps(body, [], recognized));
  const b = button(els);
  assert.equal(b.textContent, "无可识别页");
  assert.equal(b.disabled, true);
});

test("态7 empty：没有正文页（body=[]）→ 「无可识别页」disabled；与 none 输入不同、输出相同", () => {
  const { els } = makeCtx(baseDeps([], [], () => pendingStatus()));
  const b = button(els);
  assert.equal(b.textContent, "无可识别页");
  assert.equal(b.disabled, true, "没有正文页时不许可点");
});

test("态3 selection：选中 2 页、其中 1 未识别 → 「识别所选 2 页」；include=false 的不计入", () => {
  const sel = [{ page_no: 1, include: true }, { page_no: 2, include: true }, { page_no: 3, include: false }];
  const { els } = makeCtx(baseDeps([1, 2, 3].map((n) => ({ page_no: n, include: true })), sel,
    (p) => (p.page_no === 1 ? recognized(p) : pendingStatus())));
  const b = button(els);
  assert.equal(b.textContent, "识别所选 2 页", "include=false 的页必须被过滤掉");
  assert.equal(b.disabled, false);
});

test("态4 force：选中页全已识别 → 「重新识别所选 N 页」+ btn--danger", () => {
  const sel = [{ page_no: 1, include: true }, { page_no: 2, include: true }];
  const { els } = makeCtx(baseDeps([1, 2].map((n) => ({ page_no: n, include: true })), sel, recognized));
  const b = button(els);
  assert.equal(b.textContent, "重新识别所选 2 页");
  assert.equal(b.classList.contains("btn--danger"), true, "force 态必须带危险色");
});

test("态5 busy：activeJob.job_type=ocr → 「正在识别…」disabled", () => {
  const deps = Object.assign(baseDeps([1].map((n) => ({ page_no: n, include: true })), [], () => pendingStatus()), {
    getTaskJobId: () => "job-1",
    getLastTaskData: () => ({ job: { job_type: "ocr", status: "running" } }),
  });
  const { els } = makeCtx(deps);
  const b = button(els);
  assert.equal(b.textContent, "正在识别…");
  assert.equal(b.disabled, true);
});

test("态6 aux：activeJob.job_type=auxiliary → 按待识别数出文案", () => {
  const deps = Object.assign(baseDeps([1, 2].map((n) => ({ page_no: n, include: true })), [], () => pendingStatus()), {
    getTaskJobId: () => "job-2",
    getLastTaskData: () => ({ job: { job_type: "auxiliary", status: "running" } }),
  });
  const { els } = makeCtx(deps);
  const b = button(els);
  assert.equal(b.textContent, "开始识别（2 页）");
  assert.equal(b.disabled, false);
});

// ---- 三条分派：观察**真实请求体**，不观察「哪个桩被调用」 ----
//
// 判据变了（刀 4）：函数从 app.js 搬进 pages-view.js 之后，原来注入的 `recognizeSelection` /
// `startBatchRecognition` 桩不再被调用，但「点下去发起哪种请求」不会变。
// 所以改用 app 级脚手架：`loadApp()` 载模块 + app.js，`fetch` 桩只记录 `{url, body}`。
const PAGES_VIEW_SRC = SRC;

function appDispatchCtx({ body, selection, statusOf, skipChecked = true }) {
  const ctx = loadApp({ require: [] });
  const els = new Map();
  const getById = (id) => {
    if (!els.has(id)) els.set(id, makeNode(id));
    return els.get(id);
  };
  ctx.document.getElementById = getById;
  getById("selection-skip-recognized").checked = skipChecked;

  // 顶层 `let currentProject` 是可写的：用 runInApp 换成测试项目。
  runInApp(
    ctx,
    `currentProject = ${JSON.stringify({
      project_id: "p1",
      kind: "book",
      pages: body,
    })};`,
  );

  const requests = [];
  ctx.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, json: async () => ({ pages: [], job: { job_id: "job-1" } }) };
  };
  ctx.confirm = () => true;

  // 模块经 injected.* 读 app.js；app.js 自己的函数（startBatchRecognition / recognizeSelection）
  // 调的是**全局**同名函数。两边都要换成测试要控的那份，否则「桩只换了一边」：
  // 模块叫注入的那份、app.js 叫全局原始的那份，断言看到的就不是同一条路径。
  const dataDeps = {
    marginBodyPages: () => body,
    selectionPages: () => selection,
    recognitionOf: statusOf,
    humanTouchedPages: async () => [],
    warnUnconfirmed: () => true,
    confirmAction: async () => null,
    applyRecognizedPages() {},
    renderPages() {},
    openTaskDrawer() {},
    startTaskPolling() {},
    setJobStartBusy() {},
  };
  Object.assign(ctx, dataDeps);
  // 模块真正读的是 injected.*；这里换成 app.js 里的真实绑定，再覆盖测试要控的数据源。
  ctx.PagesView.init(Object.assign(appModuleDeps(ctx, PAGES_VIEW_SRC), dataDeps));
  return { ctx, els, requests };
}

const FULL_BODY = [1, 2].map((n) => ({ page_no: n, include: true }));
// handler 里调的是 async 函数但**不 await**（产品代码就是这样），所以点完要让微任务跑完再断言。
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("点击分派：batch → POST /jobs/ocr 的体是 { scope: \"unrecognized\" }", async () => {
  const { els, requests } = appDispatchCtx({ body: FULL_BODY, selection: [], statusOf: pendingStatus });
  const handler = (els.get("rec-start-all").handlers.click || [])[0];
  assert.equal(typeof handler, "function", "rec-start-all 必须绑上 click（wireAll 没跑？）");
  await handler();
  await flush();
  assert.equal(requests.length, 1, "点一次应只发一个请求");
  assert.match(requests[0].url, /\/jobs\/ocr$/);
  assert.deepEqual(requests[0].body, { scope: "unrecognized" });
});

test("点击分派：selection → body.skip_recognized 等于勾选框的 checked（不是硬编码 true）", async () => {
  const selection = [{ page_no: 1, include: true }, { page_no: 2, include: true }];
  const statusOf = (p) => (p.page_no === 1 ? recognized(p) : pendingStatus());
  const { els, requests } = appDispatchCtx({ body: FULL_BODY, selection, statusOf, skipChecked: true });
  await els.get("rec-start-all").handlers.click[0]();
  await flush();
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/jobs\/ocr$/);
  assert.deepEqual(requests[0].body, { pages: [1, 2], skip_recognized: true });
  assert.equal("force" in requests[0].body, false, "selection 不带 force");

  // 反方向：勾选框未勾 → 体里必须跟着变 false（证明读的是元素状态，不是常量）
  const other = appDispatchCtx({ body: FULL_BODY, selection, statusOf, skipChecked: false });
  await other.els.get("rec-start-all").handlers.click[0]();
  await flush();
  assert.equal(other.requests[0].body.skip_recognized, false);
});

test("点击分派：force → body.skip_recognized=false 且 body.force=true", async () => {
  const selection = [{ page_no: 1, include: true }];
  const { els, requests } = appDispatchCtx({ body: FULL_BODY, selection, statusOf: recognized });
  await els.get("rec-start-all").handlers.click[0]();
  await flush();
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/jobs\/ocr$/);
  assert.deepEqual(requests[0].body, { pages: [1], skip_recognized: false, force: true });
});
