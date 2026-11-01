// S1：借用状态必须真的写回外壳（书 §4 裁决 A 的可红判据）
//
// 模块不搬这 5 份状态（activeReviewBlockId / diffStripOpen / detailSuggestionByBlock /
// detailNumberHints / cursorByBlock），每处读写都走注入；模块里**不许出现同名 let/const**。
// 本文件锁两件：① selectReviewBlock 把当前块写回外壳状态；② 模块源码里没有那 5 个名字的声明。
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const MODULE_URL = new URL("../../backend/book2text/static/page-detail-editor.js", import.meta.url);
const BORROWED = ["activeReviewBlockId", "diffStripOpen", "detailSuggestionByBlock", "detailNumberHints", "cursorByBlock"];

function makeNode(extra = {}) {
  const node = {
    tag: "div", className: "", textContent: "", hidden: false, dataset: {}, style: {},
    children: [], listeners: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined ? this._set.has(c) : !on) this._set.delete(c); else this._set.add(c); },
      contains(c) { return this._set.has(c); },
    },
    append(...kids) { node.children.push(...kids); },
    appendChild(kid) { node.children.push(kid); return kid; },
    addEventListener() {},
    querySelector(sel) {
      if (sel === "textarea") return { focus() {}, value: "" };
      return null;
    },
    querySelectorAll(sel) {
      if (sel === ".review-block") return node.children.filter((c) => c.dataset.blockId);
      return [];
    },
    focus() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { width: 0, height: 0 }; },
    ...extra,
  };
  Object.defineProperty(node, "innerHTML", { get: () => "", set: () => { node.children = []; } });
  return node;
}

function makeModule() {
  const state = { activeReviewBlockId: null, diffStripOpen: new Set(), cursorByBlock: new Map(), detailSuggestionByBlock: new Map(), detailNumberHints: new Map() };
  const blocks = [makeNode({ dataset: { blockId: "b1" } }), makeNode({ dataset: { blockId: "b2" } })];
  const overlay = [makeNode({ dataset: { blockId: "b1" } }), makeNode({ dataset: { blockId: "b2" } })];
  const byId = new Map([
    ["detail-blocks", { ...makeNode(), children: blocks, querySelectorAll: () => blocks }],
    ["block-position", makeNode()],
    ["page-detail-error", makeNode()],
  ]);
  const root = { querySelector: (sel) => byId.get(sel.replace(/^#/, "")) || makeNode(), querySelectorAll: () => [] };
  const sandbox = { window: { addEventListener() {}, removeEventListener() {} }, document: { createElement: () => makeNode(), activeElement: null, addEventListener() {} }, console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MODULE_URL, "utf8"), sandbox, { filename: "page-detail-editor.js" });
  const api = sandbox.PageDetailEditor;
  const calls = { scroll: 0, sync: 0, update: 0, diff: 0 };
  api.init({
    root,
    apiJson: async () => ({}),
    getCurrentProject: () => ({ project_id: "p" }),
    getDetailPageNo: () => 1,
    getReviewBlocks: () => [],
    getDetailOverlay: () => ({ children: overlay }),
    // S2 起 init 会接线框选（canvas / 按钮 / 空格键），这些入口给最小桩
    getDetailCanvas: () => makeNode(),
    getDetailImage: () => makeNode(),
    getDetailInkGaps: () => makeNode(),
    getBoxCreateMode: () => false,
    setBoxCreateMode: () => false,
    getDetailInkGapsState: () => [],
    setDetailInkGapsState: () => [],
    refreshReviewFilterOnly: () => {},
    renderReviewHeadline: () => {},
    loadInkGaps: () => {},
    ensureBlockListed: () => {},
    refreshPageStates: () => {},
    setSaveState: () => {},
    getActiveReviewBlockId: () => state.activeReviewBlockId,
    setActiveReviewBlockId: (value) => { state.activeReviewBlockId = value; return value; },
    getDiffStripOpen: () => state.diffStripOpen,
    getDetailSuggestionByBlock: () => state.detailSuggestionByBlock,
    setDetailSuggestionByBlock: (value) => { state.detailSuggestionByBlock = value; },
    setDetailNumberHints: (value) => { state.detailNumberHints = value; },
    getCursorByBlock: () => state.cursorByBlock,
    scrollViewerTo: () => { calls.scroll += 1; },
    syncDiffStrip: () => { calls.sync += 1; },
    updateDiffActive: () => { calls.update += 1; },
    drawDiffLayer: () => { calls.diff += 1; },
    BLOCK_TYPE_LABELS: {}, TEXT_FREE_BLOCK_TYPES: new Set(), CHROME_BLOCK_TYPES: new Set(),
    NOTE_BLOCK_TYPES: new Set(), REVIEW_STATUS_LABELS: {}, PAGE_TYPE_LABELS: {}, MAX_DIVERGENCE_ROWS: 40,
  });
  return { api, state, byId, blocks, overlay, calls };
}

test("① 模块选块 → 写回外壳状态（不是存在模块自己家里）", () => {
  const { api, state, byId, overlay } = makeModule();
  assert.equal(state.activeReviewBlockId, null);
  api.selectReviewBlock("b2");
  assert.equal(state.activeReviewBlockId, "b2", "selectReviewBlock 没把当前块写回外壳——模块存了一份自己的副本？");
  assert.equal(byId.get("detail-blocks").children[1].classList.contains("active"), true, "块卡没标 active");
  assert.equal(byId.get("detail-blocks").children[0].classList.contains("active"), false);
  assert.equal(overlay[1].classList.contains("box--active"), true, "原图上的框没标 active");
  assert.equal(byId.get("block-position").textContent, "块 2 / 2");
});

test("② 模块源码里没有那 5 个借用状态的声明（不许留副本）", () => {
  const source = readFileSync(MODULE_URL, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const name of BORROWED) {
    const declared = new RegExp(`\\b(?:let|const|var)\\s+${name}\\b`).test(source);
    assert.equal(declared, false, `模块里声明了 ${name}——借用状态要每处读写都走注入，不能存副本`);
  }
});
