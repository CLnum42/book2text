// 刀 D：structure-tools.js 的两处写盘（预览 / 应用）与"动作内闭环"
//
// 锁三件搬模块时最容易悄悄坏掉的事：
//   ① 预览请求体与搬走前逐字段相同（规则从 root 里的控件读出来，不是模块自带的常量）
//   ② 应用请求体只带勾选的候选、逐字段是 {block_id, block_type}；应用后 afterApply 必须被等一次
//   ③ 全选 / 全不选改的是候选状态与勾选态（面板内的 DOM），不碰 document
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const MODULE_URL = new URL("../../backend/book2text/static/structure-tools.js", import.meta.url);

function makeNode(tag = "div") {
  const node = {
    tag, className: "", textContent: "", hidden: false, disabled: false, checked: false, value: "",
    type: "", title: "", dataset: {}, children: [], listeners: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined ? this._set.has(c) : !on) this._set.delete(c); else this._set.add(c); },
      contains(c) { return this._set.has(c); },
    },
    append(...kids) { for (const kid of kids) node.children.push(kid); },
    appendChild(kid) { node.children.push(kid); return kid; },
    addEventListener(event, fn) { (node.listeners[event] ||= []).push(fn); },
    querySelector(selector) {
      if (selector === "input") {
        const walk = (n) => {
          for (const kid of n.children || []) {
            if (kid.tag === "input") return kid;
            const found = walk(kid);
            if (found) return found;
          }
          return null;
        };
        return walk(node);
      }
      return null;
    },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(node, "innerHTML", { get: () => "", set: () => { node.children = []; } });
  return node;
}

const IDS = [
  "structure-top", "structure-bottom", "structure-left", "structure-right", "structure-max-chars",
  "structure-numbers", "structure-body-only", "structure-error", "structure-result", "structure-meta",
  "structure-summary", "structure-candidates", "structure-note", "structure-apply-btn",
  "structure-preview-btn", "structure-all", "structure-none",
];

/** 起一份面板 DOM + 模块实例（root.querySelector 只认这些 id）。 */
function makePanel({ posts = [] } = {}) {
  const byId = new Map(IDS.map((id) => [id, makeNode(id.includes("btn") || id === "structure-all" ? "button" : "div")]));
  for (const id of ["structure-top", "structure-bottom", "structure-left", "structure-right", "structure-max-chars"]) {
    byId.get(id).tag = "input";
  }
  for (const id of ["structure-numbers", "structure-body-only"]) byId.get(id).tag = "input";
  byId.get("structure-numbers").checked = true;
  byId.get("structure-body-only").checked = true;
  byId.get("structure-top").value = "8";
  byId.get("structure-bottom").value = "8";
  byId.get("structure-left").value = "10";
  byId.get("structure-right").value = "10";
  byId.get("structure-max-chars").value = "20";

  const root = makeNode("section");
  root.querySelector = (selector) => (selector.startsWith("#") ? byId.get(selector.slice(1)) || null : null);

  let afterApplied = false;
  const sandbox = {
    document: { createElement: (tag) => makeNode(tag) },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MODULE_URL, "utf8"), sandbox, { filename: "structure-tools.js" });
  const api = sandbox.StructureTools;
  api.init({
    root,
    apiJson: async (url, options) => {
      posts.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith("/preview")) {
        return {
          pages_scanned: 12, candidate_count: 2, high_confidence_count: 1,
          by_type: { header: 1, page_number: 1 }, skipped_count: 0, skipped: [],
          candidates: [
            { block_id: "b1", page_no: 1, current_type: "paragraph", proposed_type: "header", confidence: "high", text: "第一章" },
            { block_id: "b2", page_no: 1, current_type: "paragraph", proposed_type: "page_number", confidence: "low", text: "1" },
          ],
        };
      }
      return { changed: 1, pages: [1], by_type: { header: 1 } };
    },
    getCurrentProject: () => ({ project_id: "b2t_TEST" }),
    // 宏任务留一个 tick：模块里少了 `await` 时标志在 apply() 返回前仍是 false——
    // 同步的 fake 会让"有没有 await"变得测不出来（DevLead 实测：去掉 await 仍 4/4 绿）。
    afterApply: async () => { await new Promise((r) => setTimeout(r, 0)); afterApplied = true; },
  });
  api.setup();
  return { api, root, byId, posts, hasAfterApplied: () => afterApplied };
}

test("① 预览请求体与搬走前逐字段相同（规则从 root 控件读）", async () => {
  const { api, posts } = makePanel();
  await api.preview();
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/structure\/header-footer\/preview$/);
  assert.deepEqual(posts[0].body, {
    top_ratio: 0.08, bottom_ratio: 0.08, left_ratio: 0.1, right_ratio: 0.1,
    max_chars: 20, page_types: ["body"], detect_page_numbers: true,
  });
});

test("② 应用请求体只带勾选的候选；应用后提示与按钮状态跟着变", async () => {
  const { api, posts, byId, hasAfterApplied } = makePanel();
  await api.preview();
  // 默认只勾"有把握"的那个（b1）；把 b2 也勾上 → items 两个
  api.setAllKeeps(true);
  await api.apply();
  assert.equal(posts.length, 2, "应当恰好一次预览 + 一次应用");
  assert.match(posts[1].url, /\/structure\/header-footer\/apply$/);
  assert.deepEqual(posts[1].body, {
    items: [
      { block_id: "b1", block_type: "header" },
      { block_id: "b2", block_type: "page_number" },
    ],
  });
  assert.equal(hasAfterApplied(), true, "应用后必须等 afterApply 完成（页面重拉 + 导出预检）");
  assert.match(byId.get("structure-note").textContent, /已标注 1 个块/);
  assert.equal(byId.get("structure-result").hidden, true, "应用后结果区要收起");
  assert.equal(byId.get("structure-apply-btn").disabled, true, "应用后按钮要禁用");
});

test("③ 全不选后按钮禁用、应用不发请求", async () => {
  const { api, posts, byId } = makePanel();
  await api.preview();
  api.setAllKeeps(false);
  assert.match(byId.get("structure-apply-btn").textContent, /^应用标注$/);
  assert.equal(byId.get("structure-apply-btn").disabled, true);
  await api.apply();
  assert.equal(posts.length, 1, "没有勾选时应用不该发请求");
});

test("④ reset：换项目 / 关面板后候选清空、结果区收起", async () => {
  const { api, byId } = makePanel();
  await api.preview();
  assert.equal(byId.get("structure-result").hidden, false);
  api.reset();
  assert.equal(byId.get("structure-result").hidden, true);
});
