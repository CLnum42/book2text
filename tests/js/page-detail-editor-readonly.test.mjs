// 包模式「只读上下文页」的三条判据（2026-11-03，DevLead 派；产品笔 b7ab65a / 507a150）。
//
// 背景：包项目里随任务包附带的页是**只读上下文页**（`detailPageRecord().is_context`）：
// ① 控件禁用 + 列表顶部一条只读标识；② 强改时把控件回滚、不发请求；③ 打开/切页复位错误条与保存标签
// （同页保存后重渲染不能把「已保存 ✓」立刻抹掉）。真机六条过了，但产品笔不许碰 tests/js，当时零覆盖。
//
// **口径：只断言行为，不断言调用次数/注入面**（§18.2 A5）。这是第一版被 A5 闸拦下的原因
// （那一版断言了 `apiJson` 被调几次）。这里判三样**用户看得见的东西**：
//   · 控件值（下拉 / 文本框被回滚成原值，还是保留用户改的值）；
//   · 只读提示的**文案**（强改被拦下时要变成「这次改动没有保存，控件已回滚」）；
//   · 保存标签与错误条（翻页复位、同页重渲染不清）。
// 入口一律走公共 API（`api.patchBlock` / `api.renderBlocks`），不调模块内部函数——内部改名不会假红。
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const STATIC_DIR = process.env.B2T_STATIC_DIR
  || fileURLToPath(new URL("../../backend/book2text/static/", import.meta.url));
const MODULE_PATH = join(STATIC_DIR, "page-detail-editor.js");

const READONLY_TEXT = "只读上下文页：这一页随任务包附带，用来判断跨页段落；控件已禁用，改动不会保存。";
const ROLLED_BACK_TEXT = "只读上下文页：这次改动没有保存，控件已回滚。";

function makeNode(extra = {}) {
  const node = {
    tag: "div", className: "", textContent: "", hidden: false, dataset: {}, style: {},
    children: [], disabled: false,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined ? this._set.has(c) : !on) this._set.delete(c); else this._set.add(c); },
      contains(c) { return this._set.has(c); },
    },
    append(...kids) { node.children.push(...kids); },
    appendChild(kid) { node.children.push(kid); return kid; },
    prepend(kid) { node.children.unshift(kid); },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {}, scrollIntoView() {},
    getBoundingClientRect() { return { width: 0, height: 0 }; },
    ...extra,
  };
  Object.defineProperty(node, "innerHTML", { get: () => "", set: () => { node.children = []; } });
  return node;
}

/** 块卡里的控件：li > select.review-block__type + textarea.review-block__text。 */
function makeItem({ selectValue = "paragraph", textValue = "原文" } = {}) {
  const select = makeNode({ value: selectValue });
  const textarea = makeNode({ value: textValue });
  const item = makeNode({
    dataset: { blockId: "b1" },   // 回滚靠 `li[data-block-id="…"]` 定位到这张块卡
    querySelector: (sel) => {
      if (sel === "select.review-block__type") return select;
      if (sel === "textarea.review-block__text") return textarea;
      return null;
    },
  });
  return { item, select, textarea };
}

/**
 * 最小台架：假 DOM（`#detail-blocks` / `#page-detail-error` / 保存标签）+ 模块注入面。
 * 注入面写成"会真的改 DOM"的适配器（`setSaveState` 写保存标签），断言读的是用户看得见的节点，
 * 不是"某个函数被调了几次"。
 */
function makeEditor({ isContext = false, item = null, pageNo = 10 } = {}) {
  const errorNode = makeNode({ hidden: true, textContent: "" });
  const saveLabel = makeNode({ textContent: "" });
  const page = { no: pageNo };

  const findChild = (predicate) => {
    const walk = (nodes) => {
      for (const node of nodes) {
        if (predicate(node)) return node;
        const found = walk(node.children || []);
        if (found) return found;
      }
      return null;
    };
    return walk(listNode.children);
  };
  const listNode = makeNode({
    querySelector(sel) {
      const byId = /^li\[data-block-id="([^"]+)"\]$/.exec(sel);
      if (byId) return findChild((node) => node.dataset && node.dataset.blockId === byId[1]);
      if (sel === '[data-readonly-note="1"]') return findChild((node) => node.dataset && node.dataset.readonlyNote === "1");
      return null;
    },
    querySelectorAll: () => [],
  });

  const byId = new Map([["detail-blocks", listNode], ["page-detail-error", errorNode]]);
  // 未知 id 返回空节点（不是 null）：init 会给模块自己的其它控件接线，返回 null 会让台架直接炸。
  const root = { querySelector: (sel) => byId.get(sel.replace(/^#/, "")) || makeNode(), querySelectorAll: () => [] };
  const sandbox = {
    window: { addEventListener() {}, removeEventListener() {} },
    document: { createElement: () => makeNode(), activeElement: null, addEventListener() {} },
    console, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MODULE_PATH, "utf8"), sandbox, { filename: "page-detail-editor.js" });
  const api = sandbox.PageDetailEditor;
  api.init({
    root,
    apiJson: async () => ({ ok: true }),
    getCurrentProject: () => ({ project_id: "p" }),
    getDetailPageNo: () => page.no,
    getReviewBlocks: () => [],
    getDetailOverlay: () => ({ children: [] }),
    getDetailCanvas: () => makeNode(),
    getDetailImage: () => makeNode(),
    getDetailInkGaps: () => makeNode(),
    getBoxCreateMode: () => false,
    setBoxCreateMode: () => false,
    getDetailInkGapsState: () => [],
    setDetailInkGapsState: () => [],
    getAuxWarningEls: () => ({ mask: makeNode(), title: makeNode(), text: makeNode(), wait: makeNode(), error: makeNode() }),
    detailPageRecord: () => ({ page_no: page.no, is_context: isContext }),
    // 真实适配器：保存标签是用户看得见的节点（app 侧就是这么写的），断言读它而不是数调用
    setSaveState: (text) => { saveLabel.textContent = text; },
    reviewMarginSplit: () => ({ inside: [], outside: [], box: null }),
    effectiveReviewFilter: () => "all",
    renderReviewFilter: () => {},
    pendingPageReasons: () => [],
    forgetPageSuggestions: () => {},
    loadPageDetail: async () => {},
    refreshPageStates: async () => {},
    refreshReviewFilterOnly: () => {},
    renderReviewHeadline: () => {},
    loadInkGaps: () => {},
    ensureBlockListed: () => {},
    setActiveReviewBlockId: () => {},
    getDiffStripOpen: () => new Set(),
    getDetailSuggestionByBlock: () => new Map(),
    setDetailSuggestionByBlock: () => {},
    setDetailNumberHints: () => {},
    getCursorByBlock: () => new Map(),
    scrollViewerTo: () => {},
    syncDiffStrip: () => {},
    updateDiffActive: () => {},
    drawDiffLayer: () => {},
    BLOCK_TYPE_LABELS: {}, TEXT_FREE_BLOCK_TYPES: new Set(), CHROME_BLOCK_TYPES: new Set(),
    NOTE_BLOCK_TYPES: new Set(), REVIEW_STATUS_LABELS: {}, PAGE_TYPE_LABELS: {}, MAX_DIVERGENCE_ROWS: 40,
  });
  const readonlyNote = () => listNode.querySelector('[data-readonly-note="1"]');
  return { api, page, errorNode, saveLabel, listNode, readonlyNote };
}

const block = { block_id: "b1", block_type: "paragraph", text: "原始文本" };

test("① 上下文页：强改下拉 → 控件回原值 + 只读提示改成「这次改动没有保存」，保存标签不动", () => {
  const { item, select } = makeItem({ selectValue: "heading" });
  const editor = makeEditor({ isContext: true, item });
  editor.api.renderBlocks([]);           // 先渲染出只读标识（用户看到的那一条）
  assert.equal(editor.readonlyNote()?.textContent, READONLY_TEXT, "只读标识的文案不对（渲染阶段）");
  editor.listNode.append(item);          // renderBlocks 会清空列表；块卡在它之后挂上（真实顺序）

  editor.api.patchBlock(block, { block_type: "heading" });
  assert.equal(select.value, "paragraph", "下拉没有回滚到 block.block_type——控件会停在没保存的值上");
  assert.equal(editor.readonlyNote().textContent, ROLLED_BACK_TEXT,
    "强改被拦下后提示没改成「这次改动没有保存，控件已回滚」");
  assert.equal(editor.saveLabel.textContent, "", "上下文页不该出现保存状态（用户会以为存进去了）");
});

test("① 上下文页：强改文本框 → 回到原文本", () => {
  const { item, textarea } = makeItem({ textValue: "改过的文字" });
  const editor = makeEditor({ isContext: true, item });
  editor.api.renderBlocks([]);
  editor.listNode.append(item);
  editor.api.patchBlock(block, { text: "改过的文字" });
  assert.equal(textarea.value, "原始文本", "文本框没有回滚到 block.text");
});

test("① 反向锚：任务页同样改法要保留新值并显示「已保存 ✓」（证明上面不是「永远回滚」）", async () => {
  const { item, select } = makeItem({ selectValue: "heading" });
  const editor = makeEditor({ isContext: false, item });
  editor.api.renderBlocks([]);
  await editor.api.patchBlock(block, { block_type: "heading" });
  assert.equal(select.value, "heading", "任务页的改动被回滚了——那不是只读页该有的行为");
  assert.equal(editor.saveLabel.textContent, "已保存 ✓", "任务页保存后没有「已保存 ✓」（用户看不到保存结果）");
});

test("② 控件缺失（li 里没有 select/textarea / 连 li 都没有）：静默返回，不抛", async () => {
  const bare = makeNode({ querySelector: () => null });
  const noControls = makeEditor({ isContext: true, item: bare });
  await assert.doesNotReject(
    async () => noControls.api.patchBlock(block, { block_type: "heading" }),
    "控件缺失时抛异常了——回滚路径不许炸在错误处理里",
  );
  const noItem = makeEditor({ isContext: true, item: null });
  await assert.doesNotReject(async () => noItem.api.patchBlock(block, { block_type: "heading" }));
});

test("③ 翻页四次复位：10→11→12→13 每次清错误条与保存标签；同页重渲染不抹「已保存 ✓」", () => {
  const editor = makeEditor({ isContext: false, pageNo: 10 });
  const flip = (no) => { editor.page.no = no; editor.api.renderBlocks([]); };

  flip(10);
  assert.equal(editor.saveLabel.textContent, "", "打开第 10 页时保存标签没复位");
  assert.equal(editor.errorNode.hidden, true, "打开第 10 页时错误条没隐藏");

  // 模拟"刚保存完"：标签是「已保存 ✓」，错误条还挂着上一次的文本
  editor.saveLabel.textContent = "已保存 ✓";
  editor.errorNode.hidden = false;
  editor.errorNode.textContent = "上一条错误";
  editor.api.renderBlocks([]);
  assert.equal(editor.saveLabel.textContent, "已保存 ✓", "同页重渲染把「已保存 ✓」抹掉了——用户看不到保存结果");
  assert.equal(editor.errorNode.hidden, false, "同页重渲染把错误条清了（只有切页才该清）");

  for (const no of [11, 12, 13]) {
    editor.saveLabel.textContent = "已保存 ✓";
    editor.errorNode.hidden = false;
    editor.errorNode.textContent = "上一条错误";
    flip(no);
    assert.equal(editor.saveLabel.textContent, "", `翻到第 ${no} 页时保存标签没复位`);
    assert.equal(editor.errorNode.hidden, true, `翻到第 ${no} 页时错误条没隐藏`);
    assert.equal(editor.errorNode.textContent, "", `翻到第 ${no} 页时错误条只隐藏没清文本`);
  }
});
