// P2 运行时等价：旧（基线 app.js 内联实现）vs 新（preview-view.js + init 注入）
// 覆盖四类：openPreview 进视图 / loadPreview 强制重开 / 滚动联动 / 视口变化。
//
// 用法：
//   node docs/refactor/evidence/preview-p2/runtime.mjs
//   B2T_BASELINE=7125dd5 node docs/refactor/evidence/preview-p2/runtime.mjs
//
// 基线默认 7125dd5（P1 之前的最后一版，43 个函数还全在 app.js 里）。
// 旧侧用仓库里的 tests/js/load-app.mjs 只读加载（不复制、不改测试）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BASELINE = process.env.B2T_BASELINE || "7125dd5";
const OLD_APP = join(mkdtempSync(join(tmpdir(), "preview-p2-")), "app-baseline.js");
writeFileSync(
  OLD_APP,
  execFileSync("git", ["-C", ROOT, "show", `${BASELINE}:backend/book2text/static/app.js`], { encoding: "utf8" }),
);
const { loadApp, runInApp } = await import(pathToFileURL(join(ROOT, "tests/js/load-app.mjs")).href);

const MODULE = join(ROOT, "backend/book2text/static/preview-view.js");

// ---------------- 假 DOM ----------------
function makeDom() {
  const nodes = new Map();
  const mk = (tag) => {
    const n = {
      tagName: String(tag || "div").toUpperCase(), id: "", className: "", title: "",
      textContent: "", hidden: false, checked: false, disabled: false, src: "", alt: "",
      style: {}, dataset: {}, children: [],
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, v) { if (v === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
                       else { v ? this._s.add(c) : this._s.delete(c); } return this._s.has(c); },
        contains(c) { return this._s.has(c); },
      },
      append(...kids) { for (const k of kids) { if (!k) continue; if (k._fragment) n.children.push(...k.children); else n.children.push(k); } },
      prepend(...kids) { n.children.unshift(...kids); },
      appendChild(k) { n.append(k); return k; },
      remove() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800 }; },
      addEventListener(t, fn) { (n._l = n._l || {}); (n._l[t] = n._l[t] || []).push(fn); },
      removeEventListener() {}, closest() { return null; },
      scrollIntoView() {}, focus() {}, blur() {}, click() {},
      clientWidth: 600, clientHeight: 800, scrollTop: 0, scrollHeight: 1600,
      offsetTop: 0, offsetWidth: 600, offsetHeight: 800,
    };
    Object.defineProperty(n, "innerHTML", {
      get() { return n._html || ""; },
      set(v) { n._html = v; if (!v) n.children.length = 0; },
    });
    return n;
  };
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, mk("div")); return nodes.get(id); },
    createElement(tag) { return mk(tag); },
    createDocumentFragment() { const f = mk("#fragment"); f._fragment = true; return f; },
    body: mk("body"),
    addEventListener() {}, removeEventListener() {},
    elementFromPoint() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return { document, nodes, mk };
}

function snapshot(dom) {
  const out = {};
  for (const [id, n] of [...dom.nodes].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[id] = {
      text: n.textContent, html: n._html || "", hidden: n.hidden, checked: n.checked,
      cls: [...n.classList._s].sort().join(" "), kids: n.children.length,
      scrollTop: n.scrollTop, width: n.style.width || "",
    };
  }
  return out;
}

const FIXTURE = {
  project: { project_id: "p1", pages: [{ page_no: 1 }, { page_no: 2 }] },
  data: {
    segments: [
      { seq: 1, text: "第一段", pages: [{ page_no: 1 }], block_ids: [11], type: "paragraph" },
      { seq: 2, text: "第二段跨页", pages: [{ page_no: 1 }, { page_no: 2 }], block_ids: [12, 13], type: "paragraph" },
    ],
    preflight: { margin_blocks: { excluded: 2, excluded_by_type: { paragraph: 1 } }, margin_judgement: true },
  },
  options: { include_footnotes: false, x: 1 },
  index: { pages: [{ page_no: 1, printed: ["i"], missing: false }, { page_no: 2, printed: ["1"], missing: false }] },
};

const brief = (x) => {
  if (x && typeof x === "object") {
    if (x.dataset && x.dataset.pageNo) return "page:" + x.dataset.pageNo;
    if (x.dataset && x.dataset.seq) return "seq:" + x.dataset.seq;
    if (Array.isArray(x)) return "array:" + x.length;
    if (x.id) return "id:" + x.id;
    return "obj";
  }
  return x;
};
function makeLog() { const log = []; log.push_ = (...a) => log.push(a.map(brief)); return log; }

// ---------------- 旧实现 ----------------
let REAL = null;
function realConstants(oldCtx) {
  if (REAL) return REAL;
  REAL = {
    zoomScales: JSON.parse(runInApp(oldCtx, "JSON.stringify(INDEX_ZOOM_SCALES)")),
    labels: JSON.parse(runInApp(oldCtx, "JSON.stringify(BLOCK_TYPE_LABELS)")),
  };
  return REAL;
}

function buildOld() {
  const log = makeLog();
  const dom = makeDom();
  const ctx = loadApp({ appPath: OLD_APP, require: [] });
  ctx.document = dom.document;
  ctx.requestAnimationFrame = (fn) => { fn(); return 1; };
  ctx.cancelAnimationFrame = () => {};
  if (!ctx.performance) ctx.performance = { now: () => 0 };
  ctx.apiJson = async (path, opts) => { log.push_("api", path, JSON.parse(opts.body)); return FIXTURE.data; };
  ctx.exportOptions = () => { log.push_("exportOptions"); return FIXTURE.options; };
  for (const name of ["savePageMarginPreference", "savePageOverlayPreference", "syncIndexToggles",
    "paintTileMargin", "renderPageBlocks", "clearPageBlocks", "clearTileMargin", "applyBoxElementRect",
    "toggleMarginView", "togglePageBlocksOverlay"]) {
    ctx[name] = (...a) => { log.push_(name, ...a); };
  }
  ctx.loadIndexBlocks = (...a) => { log.push_("loadIndexBlocks", ...a); return Promise.resolve([]); };
  ctx.loadPageIndex = (...a) => { log.push_("loadPageIndex", ...a); return Promise.resolve(); };
  ctx.addEventListener = () => {};
  if (typeof ctx.setupPreview === "function") ctx.setupPreview();
  ctx.pageImageUrl = (p, kind) => { log.push_("pageImageUrl", p, kind); return `url:${p}:${kind}`; };
  ctx.pageProfileFor = (p) => { log.push_("pageProfileFor", p); return { width: 1000, height: 1400 }; };
  ctx.__log = log; ctx.__dom = dom;
  realConstants(ctx);
  return ctx;
}

// ---------------- 新实现 ----------------
function buildNew() {
  const log = makeLog();
  const dom = makeDom();
  const state = {
    project: FIXTURE.project, view: "preview", detailPageNo: null,
    pageIndexData: FIXTURE.index, pageIndexLoading: false, pageIndexProject: "p1",
    pageZoomIndex: 2, pageZoomTouched: false, pagesMarginOn: false, pagesOverlayOn: false,
  };
  const listeners = {};
  const sandbox = {
    console, document: dom.document,
    requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame: () => {},
    performance: { now: () => 0 },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: () => {},
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MODULE, "utf8"), sandbox, { filename: "preview-view.js" });
  const deps = {
    isActive: () => state.view === "preview",
    getProject: () => state.project,
    getDetailPageNo: () => state.detailPageNo,
    getPageIndexData: () => state.pageIndexData,
    getPageIndexLoading: () => state.pageIndexLoading,
    getPageIndexProject: () => state.pageIndexProject,
    getPageZoomIndex: () => state.pageZoomIndex,
    getPagesMarginOn: () => state.pagesMarginOn,
    getPagesOverlayOn: () => state.pagesOverlayOn,
    setPageZoomIndex: (v) => { state.pageZoomIndex = v; return v; },
    setPageZoomTouched: (v) => { state.pageZoomTouched = v; return v; },
    setPagesMarginOn: (v) => { state.pagesMarginOn = v; return v; },
    setPagesOverlayOn: (v) => { state.pagesOverlayOn = v; return v; },
    getPagesMarginToggle: () => dom.document.getElementById("pages-margin-toggle"),
    getPagesOverlayToggle: () => dom.document.getElementById("pages-overlay-toggle"),
    zoomScales: REAL.zoomScales, blockTypeLabels: REAL.labels,
    exportOptions: () => { log.push_("exportOptions"); return FIXTURE.options; },
    apiJson: async (path, opts) => { log.push_("api", path, JSON.parse(opts.body)); return FIXTURE.data; },
    applyBoxElementRect: (...a) => log.push_("applyBoxElementRect", ...a),
    clearPageBlocks: (...a) => log.push_("clearPageBlocks", ...a),
    clearTileMargin: (...a) => log.push_("clearTileMargin", ...a),
    paintTileMargin: (...a) => log.push_("paintTileMargin", ...a),
    renderPageBlocks: (...a) => log.push_("renderPageBlocks", ...a),
    loadIndexBlocks: (...a) => { log.push_("loadIndexBlocks", ...a); return Promise.resolve([]); },
    loadPageIndex: (...a) => { log.push_("loadPageIndex", ...a); return Promise.resolve(); },
    pageImageUrl: (p, kind) => { log.push_("pageImageUrl", p, kind); return `url:${p}:${kind}`; },
    pageProfileFor: (p) => { log.push_("pageProfileFor", p); return { width: 1000, height: 1400 }; },
    savePageMarginPreference: (...a) => log.push_("savePageMarginPreference", ...a),
    savePageOverlayPreference: (...a) => log.push_("savePageOverlayPreference", ...a),
    syncIndexToggles: (...a) => log.push_("syncIndexToggles", ...a),
    toggleMarginView: (...a) => log.push_("toggleMarginView", ...a),
    togglePageBlocksOverlay: (...a) => log.push_("togglePageBlocksOverlay", ...a),
  };
  sandbox.window.PreviewView.init(deps);
  return { api: sandbox.window.PreviewView, log, dom, state, listeners };
}

// ---------------- 对照 ----------------
function fire(dom, id, type, arg) {
  const node = dom.document.getElementById(id);
  for (const fn of (node._l && node._l[type]) || []) fn(arg);
}
async function flush() { for (let i = 0; i < 20; i += 1) await Promise.resolve(); }
const results = [];
function check(name, oldLog, newLog, oldSnap, newSnap) {
  const a = JSON.stringify(oldLog), b = JSON.stringify(newLog);
  const sa = JSON.stringify(oldSnap), sb = JSON.stringify(newSnap);
  const sameLog = a === b, sameDom = sa === sb;
  results.push(sameLog && sameDom);
  console.log(`${sameLog && sameDom ? "OK  " : "FAIL"} ${name}`);
  if (!sameLog) {
    const A = JSON.parse(a), B = JSON.parse(b);
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i += 1) {
      const x = JSON.stringify(A[i]), y = JSON.stringify(B[i]);
      if (x !== y) { console.log(`  首个差异 @${i}:\n    旧=${String(x).slice(0,300)}\n    新=${String(y).slice(0,300)}`); break; }
    }
    console.log(`  长度 旧=${A.length} 新=${B.length}`);
    console.log("  旧:", JSON.stringify(A));
    console.log("  新:", JSON.stringify(B));
  }
  if (!sameDom) {
    const ids = new Set([...Object.keys(oldSnap), ...Object.keys(newSnap)]);
    for (const id of [...ids].sort()) {
      if (JSON.stringify(oldSnap[id]) !== JSON.stringify(newSnap[id])) {
        console.log(`  DOM 差异 ${id}: 旧=${JSON.stringify(oldSnap[id])} 新=${JSON.stringify(newSnap[id])}`);
      }
    }
  }
}

// 1) openPreview 进视图（冷）
{
  const old = buildOld();
  runInApp(old, `currentProject = ${JSON.stringify(FIXTURE.project)}; currentView = "preview";
    pagesMarginOn = false; pagesOverlayOn = false; pageZoomIndex = 2; detailPageNo = null;
    pageIndexData = ${JSON.stringify(FIXTURE.index)}; pageIndexProject = "p1"; pageIndexLoading = false;
    previewData = null; previewProject = null; previewOptionsSignature = null; previewLoading = false;
    previewTiles = new Map(); previewTileTops = []; previewTileTopMap = new Map(); previewPageNo = null;
    previewLoadedPages = new Set(); previewTileBlocks = new Map(); previewPagesProject = null;`);
  await old.openPreview(); await flush();
  const neu = buildNew();
  await neu.api.enter(); await flush();
  check("openPreview 进视图（冷，含 api / 版心默认 / DOM 文本）", old.__log, neu.log, snapshot(old.__dom), snapshot(neu.dom));
}

// 1) openPreview 进视图（冷）
{
  const old = buildOld();
  runInApp(old, `currentProject = ${JSON.stringify(FIXTURE.project)}; currentView = "preview";
    pagesMarginOn = false; pagesOverlayOn = false; pageZoomIndex = 2; detailPageNo = null;
    pageIndexData = ${JSON.stringify(FIXTURE.index)}; pageIndexProject = "p1"; pageIndexLoading = false;
    previewData = null; previewProject = null; previewOptionsSignature = null; previewLoading = false;
    previewTiles = new Map(); previewTileTops = []; previewTileTopMap = new Map(); previewPageNo = null;
    previewLoadedPages = new Set(); previewTileBlocks = new Map(); previewPagesProject = null;`);
  await old.openPreview(); await flush(); old.__log.length = 0;
  await old.openPreview(); await flush();
  const neu = buildNew();
  await neu.api.enter(); await flush(); neu.log.length = 0;
  await neu.api.enter(); await flush();
  check("openPreview 二次进入（缓存命中，0 次 /export/preview）", old.__log, neu.log, snapshot(old.__dom), snapshot(neu.dom));
}

// 3) 强制重开（active） = afterCleanupApplied 的路径
{
  const old = buildOld();
  runInApp(old, `currentProject = ${JSON.stringify(FIXTURE.project)}; currentView = "preview";
    previewData = null; previewProject = null; previewLoading = false; pageZoomIndex = 2;
    pageIndexData = ${JSON.stringify(FIXTURE.index)}; pageIndexProject = "p1"; pageIndexLoading = false;
    previewTiles = new Map(); previewTileTops = []; previewTileTopMap = new Map(); previewPageNo = null;
    previewLoadedPages = new Set(); previewTileBlocks = new Map(); previewPagesProject = null;`);
  await old.loadPreview(old.exportOptions(), JSON.stringify(old.exportOptions())); await flush();
  const neu = buildNew();
  await neu.api.enter({ force: true }); await flush();
  check("enter({force:true}) = 旧 loadPreview 直调（不重跑版心默认）", old.__log, neu.log, snapshot(old.__dom), snapshot(neu.dom));
}

// 4) 只丢缓存（invalidate）→ 下一次 enter 才请求
{
  const old = buildOld();
  runInApp(old, `currentProject = ${JSON.stringify(FIXTURE.project)}; currentView = "pages";
    previewData = null; previewProject = null;`);
  const neu = buildNew();
  neu.state.view = "pages";
  neu.api.enter({ invalidate: true });
  old.previewData = null; old.previewProject = null;
  await flush();
  const same = JSON.stringify(old.__log) === JSON.stringify(neu.log);
  console.log(`${same ? "OK  " : "FAIL"} enter({invalidate:true})：0 次请求、只丢缓存`);
  results.push(same);
}

// 5) 视口变化（resize 监听体 → applyPreviewZoom / measurePreviewTiles / syncPreviewWindow）
{
  const old = buildOld();
  runInApp(old, `currentProject = ${JSON.stringify(FIXTURE.project)}; currentView = "preview";
    previewData = null; previewProject = null; previewLoading = false; pageZoomIndex = 2;
    pagesMarginOn = true; pagesOverlayOn = true; pageIndexData = ${JSON.stringify(FIXTURE.index)};
    pageIndexProject = "p1"; pageIndexLoading = false;
    previewTiles = new Map(); previewTileTops = []; previewTileTopMap = new Map(); previewPageNo = 1;
    previewLoadedPages = new Set(); previewTileBlocks = new Map(); previewPagesProject = null;`);
  await old.openPreview(); await flush(); old.__log.length = 0;
  if (runInApp(old, "currentView") === "preview") {
    old.applyPreviewZoom(); old.measurePreviewTiles(); old.syncPreviewWindow();
  }
  await flush();
  const neu = buildNew();
  neu.state.pagesMarginOn = true; neu.state.pagesOverlayOn = true;
  await neu.api.enter(); await flush(); neu.log.length = 0;
  for (const fn of neu.listeners.resize || []) fn();
  await flush();
  check("视口变化（resize 监听体：缩放/量高/窗口重排）", old.__log, neu.log, snapshot(old.__dom), snapshot(neu.dom));
}


// 6) 滚动联动（右栏滚动 → 左栏；右栏悬停/点击 → 左栏；左栏滚动 → 右栏跳页）
{
  const old = buildOld();
  runInApp(old, `currentProject = ${JSON.stringify(FIXTURE.project)}; currentView = "preview";
    pagesMarginOn = true; pagesOverlayOn = true; pageZoomIndex = 2; detailPageNo = null;
    pageIndexData = ${JSON.stringify(FIXTURE.index)}; pageIndexProject = "p1"; pageIndexLoading = false;
    previewData = null; previewProject = null; previewOptionsSignature = null; previewLoading = false;
    previewTiles = new Map(); previewTileTops = []; previewTileTopMap = new Map(); previewPageNo = null;
    previewLoadedPages = new Set(); previewTileBlocks = new Map(); previewPagesProject = null;`);
  await old.openPreview(); await flush();

  const neu = buildNew();
  neu.state.pagesMarginOn = true; neu.state.pagesOverlayOn = true;
  await neu.api.enter(); await flush();

  const segNode = { dataset: { seq: "2" } };
  const evt = { target: { closest: () => segNode } };
  old.__dom.document.elementFromPoint = () => ({ closest: () => segNode });
  neu.dom.document.elementFromPoint = () => ({ closest: () => segNode });

  // (a) 右栏滚动 → 左栏跟到这一段
  old.__log.length = 0; neu.log.length = 0;
  fire(old.__dom, "preview-scroll", "scroll");
  fire(neu.dom, "preview-scroll", "scroll");
  await flush();
  check("滚动联动 a：右栏滚动 → 左栏跟段", old.__log, neu.log, snapshot(old.__dom), snapshot(neu.dom));

  // (b) 右栏点击 → 左栏滚到这一段
  old.__log.length = 0; neu.log.length = 0;
  fire(old.__dom, "preview-segs", "click", evt);
  fire(neu.dom, "preview-segs", "click", evt);
  await flush();
  check("滚动联动 b：右栏点击 → 左栏滚到该段", old.__log, neu.log, snapshot(old.__dom), snapshot(neu.dom));

  // (c) 左栏滚动 → 右栏跳到该页第一段
  old.__dom.document.getElementById("preview-pdf-scroll").scrollTop = 300;
  neu.dom.document.getElementById("preview-pdf-scroll").scrollTop = 300;
  old.__log.length = 0; neu.log.length = 0;
  fire(old.__dom, "preview-pdf-scroll", "scroll");
  fire(neu.dom, "preview-pdf-scroll", "scroll");
  await flush();
  check("滚动联动 c：左栏滚动 → 右栏跳页", old.__log, neu.log, snapshot(old.__dom), snapshot(neu.dom));
}


// 7) 不在预览视图时 enter({force:true})：只丢缓存，不发请求（对齐旧 `if (currentView === "preview")` 守卫）
{
  const old = buildOld();
  runInApp(old, `currentProject = ${JSON.stringify(FIXTURE.project)}; currentView = "pages";
    previewData = { segments: [] }; previewProject = "p1"; previewOptionsSignature = "x";`);
  const neu = buildNew();
  neu.state.view = "pages";
  await neu.api.enter({ force: true });
  await flush();
  const okCalls = JSON.stringify(old.__log) === JSON.stringify(neu.log);
  console.log(`${okCalls ? "OK  " : "FAIL"} enter({force:true}) 非激活：0 次请求（旧=只清缓存）`);
  results.push(okCalls);
}

const ok = results.every(Boolean);
console.log(`\n${ok ? "全部等价" : "存在差异"}（${results.filter(Boolean).length}/${results.length}）`);
process.exit(ok ? 0 : 1);
