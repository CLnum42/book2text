// ③ 跨视图服务：建议流程（`suggestion-flow.js`，root = #suggestion-apply-panel）。
//
// 锁五件（都是这一刀新增/改动带来的判据）：
// ① 接口面恰好 11 个键，每个都能指出调用点（无调用点 = 预留 = 红）
// ② 两个纯函数的行为基线：`marginJudgementEnabled`（未设置即默认开）与 `formatAutoApplyTypes`
// ③ **三件死状态全仓 0**：suggestionApplyPlan / latestAutoApply / 注入键 setLatestAutoApply
//    （同 S4 的 auxData 型：只写不读；这刀删掉，不许回来）
// ④ 节点归属：chrome 6 个 id 与三处"借来的" id（export-margin-judgement / export-error /
//    page-detail-error）在模块源码里必须 0 次；自己的 8 个 id 必须在
// ⑤ 模块里除 `window.SuggestionFlow = api` 外不许出现任何 `window.<模块名>`
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const MODULE_URL = new URL("../../backend/book2text/static/suggestion-flow.js", import.meta.url);
const STATIC = new URL("../../backend/book2text/static/", import.meta.url);
const APP = readFileSync(new URL("app.js", STATIC), "utf8");
const MODULE = readFileSync(MODULE_URL, "utf8");
const { codeOnly } = await import("./static-scan.mjs");

/** 模块自己取的那 8 个 id（root 的名字 + 7 个 part）。 */
const MODULE_IDS = [
  "suggestion-apply-panel",
  "suggestion-apply-summary",
  "suggestion-apply-error",
  "suggestion-apply-types",
  "suggestion-apply-samples",
  "suggestion-apply-run",
  "suggestion-apply-close",
  "suggestion-apply-cancel",
];

/** 经 init 注入的节点（模块源码里不许出现这 7 个 id）。 */
const INJECTED_IDS = [
  "auto-apply-notice", "auto-apply-notice-text", "auto-apply-undo", "auto-apply-dismiss",
  "margin-judgement-notice", "margin-judgement-notice-ok", "review-apply-all",
];

/** 不归本模块、也不注入本模块的节点（写它们的人分别是导出模块 / 审校面板模块）。 */
const FOREIGN_IDS = ["export-margin-judgement", "export-error", "page-detail-error"];

const mk = (extra = {}) => ({
  textContent: "", hidden: false, checked: false, value: "", className: "", dataset: {}, children: [],
  classList: { add() {}, remove() {}, toggle() {} },
  append(...kids) { this.children.push(...kids); },
  addEventListener() {},
  ...extra,
});

function makeModule(deps = {}) {
  const byId = new Map();
  const rootFake = {
    querySelector: (selector) => byId.get(String(selector).replace(/^#/, "")) || mk(),
    querySelectorAll: () => [],
  };
  const sandbox = { window: {}, console, document: { createElement: () => mk() }, sessionStorage: { getItem: () => "3", setItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MODULE, sandbox, { filename: "suggestion-flow.js" });
  const api = sandbox.window.SuggestionFlow;
  const notice = {
    autoApply: mk({ dataset: {} }), text: mk(), undo: mk(), dismiss: mk(), margin: mk(), marginOk: mk(),
  };
  const events = [];
  api.init({
    root: rootFake,
    getNoticeEls: () => notice,
    getReviewApplyAll: () => mk(),
    getCurrentProject: () => ({ project_id: "p1", settings: {} }),
    getDetailPageNo: () => null,
    apiJson: async () => ({}),
    showError: () => {},
    showPageDetailError: () => {},
    openModal: (name) => events.push(["openModal", name]),
    closeModal: (name) => events.push(["closeModal", name]),
    renderRecognitionSettings: () => events.push(["renderRecognitionSettings"]),
    forgetPageBlocks: () => {},
    refreshPageStates: () => {},
    loadPageDetail: async () => {},
    setSaveState: () => {},
    syncPagesProjectSettings: (value) => events.push(["syncPagesProjectSettings", value]),
    onAutoApplyStatusChanged: () => {},
    onPageBlocksInvalidated: () => {},
    onPageSuggestionsInvalidated: () => {},
    onPagesNeedReflow: () => {},
    refreshExportPreflight: async () => {},
    BLOCK_TYPE_LABELS: { paragraph: "段落", header: "页眉" },
    ...deps,
  });
  return { api, notice, events, byId, sandbox };
}

test("③ 跨视图：接口面恰好 11 个键，每个都必须是函数", () => {
  const { api } = makeModule();
  assert.deepEqual(Object.keys(api).sort(), [
    "announceAutoApplyAfterJob", "formatAutoApplyTypes", "init", "marginJudgementEnabled",
    "notifyApplied", "openApplyPanel", "projectSettingsApplied", "refreshAutoApplyStatus",
    "setMarginJudgement", "showNotice", "undoAutoApply",
  ].sort());
  for (const name of Object.keys(api)) assert.equal(typeof api[name], "function", `api.${name} 不是函数`);
});

test("③ 跨视图：每个导出在 app.js 里都有调用点（无调用点 = 预留 = 红）", () => {
  const { api } = makeModule();
  const code = codeOnly(APP);
  const problems = [];
  for (const key of Object.keys(api)) {
    if (!new RegExp(`SuggestionFlow\\?\\.${key}\\s*\\(`).test(code)) {
      problems.push(`api.${key} 在 app.js 里没有调用点——导出面不许留"预留"`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("③ 跨视图：marginJudgementEnabled 的「未设置即默认开」四种情形", () => {
  const judge = (settings) => {
    const { api } = makeModule({ getCurrentProject: () => ({ project_id: "p1", settings }) });
    return api.marginJudgementEnabled();
  };
  assert.equal(judge({}), true, "没设置过 ⇒ 默认开");
  assert.equal(judge({ margin_box_judgement: null }), true, "null ⇒ 当作没设置");
  assert.equal(judge({ margin_box_judgement: undefined }), true, "undefined ⇒ 当作没设置");
  assert.equal(judge({ margin_box_judgement: false }), false, "显式 false 才是关");
  assert.equal(judge({ margin_box_judgement: true }), true);
});

test("③ 跨视图：formatAutoApplyTypes 的类型名与拼接", () => {
  const { api } = makeModule();
  assert.equal(api.formatAutoApplyTypes({ header: 12, footer: 3 }), "页眉 12 / 页脚 3");
  assert.equal(api.formatAutoApplyTypes({ page_number: 2, margin_note: 1 }), "页码 2 / 旁批 1");
  assert.equal(api.formatAutoApplyTypes({ unknown_type: 5 }), "unknown_type 5", "不认识的类型回落成原名");
  assert.equal(api.formatAutoApplyTypes(null), "");
  assert.equal(api.formatAutoApplyTypes({}), "");
});

test("③ 跨视图：三份死状态在全仓 0 次（只写不读，同 auxData 型）", () => {
  const files = ["app.js", "suggestion-flow.js", "pages-view.js"];
  const sources = files.map((name) => codeOnly(readFileSync(new URL(name, STATIC), "utf8")));
  for (const dead of ["suggestionApplyPlan", "latestAutoApply", "setLatestAutoApply"]) {
    for (let i = 0; i < files.length; i += 1) {
      assert.equal(sources[i].includes(dead), false, `${files[i]} 里还有 ${dead}——死状态不许回来`);
    }
  }
});

const VOID_TAGS = new Set(["br", "img", "input", "hr", "meta", "link", "source", "track", "wbr"]);

/** 从 index.html 里取某个 id 元素的子树 id 全集（按标签深度配对，不看缩进）。 */
function subtreeIds(html, rootId) {
  const at = html.indexOf(`id="${rootId}"`);
  if (at < 0) return null;
  const start = html.lastIndexOf("<", at);
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  re.lastIndex = start;
  const ids = [];
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (closing) {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    const idMatch = /\bid="([^"]+)"/.exec(m[3]);
    if (idMatch) ids.push(idMatch[1]);
    if (m[4] !== "/" && !VOID_TAGS.has(tag)) depth += 1;
  }
  return ids;
}

test("③ 跨视图：一个 owner——#suggestion-apply-panel 子树 id 全集恰好是模块自己那 8 个", () => {
  const html = readFileSync(new URL("index.html", STATIC), "utf8");
  const subtree = subtreeIds(html, "suggestion-apply-panel");
  assert.ok(subtree && subtree.length > 0, "#suggestion-apply-panel 子树里一个 id 都没解析到");
  assert.deepEqual([...subtree].sort(), [...MODULE_IDS].sort(),
    `子树 id 与模块自己取的那 8 个对不上（子树：${subtree.join(", ")}）——多出来的说明外壳还在写它，少了说明 part() 断了`);
});

test("③ 跨视图：节点归属——chrome 6 个与三处借来的 id 在模块源码里各 0 次", () => {
  const code = codeOnly(MODULE);
  for (const id of [...INJECTED_IDS, ...FOREIGN_IDS]) {
    assert.equal(code.includes(`"${id}"`), false, `模块里出现了 "${id}"——它只能经 init 注入，或根本不归本模块`);
  }
  for (const id of MODULE_IDS) {
    assert.equal(code.includes(`"${id}"`), true, `模块没取自己的 ${id}——part() 那一路断了`);
  }
});

test("③ 跨视图：模块里除自己的 window.SuggestionFlow 外不出现任何 window.<模块名>", () => {
  const code = codeOnly(MODULE);
  const names = [...new Set([...code.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  assert.deepEqual(names, ["SuggestionFlow"], `模块里出现了别的 window 引用：${names.join(", ")}——跨模块只能走注入`);
});

test("③ 跨视图：注入双向对（boot 传的键模块都读、模块读的键 boot 都传）", () => {
  const code = codeOnly(APP);
  const boot = code.slice(code.indexOf("window.SuggestionFlow?.init({"));
  assert.ok(boot.length > 0, "boot 里没找到 SuggestionFlow 的 init 块");
  const block = boot.slice(0, boot.indexOf("\n  });"));
  const keys = [...block.matchAll(/^    ([A-Za-z_$][\w$]*)[,:]/gm)].map((m) => m[1]);
  assert.ok(keys.length > 0, "init 块里一个键都没解析到");
  const moduleCode = codeOnly(MODULE);
  const used = new Set([...moduleCode.matchAll(/injected\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const problems = [];
  for (const key of keys) if (!used.has(key)) problems.push(`boot 注入了 ${key}，模块一次都没读——死注入`);
  for (const key of used) if (!keys.includes(key)) problems.push(`模块用了 injected.${key}，但 boot 没传——运行时是 undefined`);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("③ 跨视图：showNotice 写的是三个注入节点（不是 document 级查询）", () => {
  const { api, notice } = makeModule();
  api.showNotice("已采用 3 块");
  assert.equal(notice.text.textContent, "已采用 3 块");
  assert.equal(notice.autoApply.hidden, false);
  assert.equal(notice.autoApply.dataset.autoApplyId, "", "纯提示不该带撤销 id");
  assert.equal(notice.undo.hidden, true, "没有撤销 id 时撤销按钮要藏起来");
});

test("③ 跨视图：setMarginJudgement 返回结果、不写别人的 DOM", async () => {
  // 失败：返回 { ok:false, error }，且不去碰导出面板 / 页面视图的节点
  const failing = makeModule({ apiJson: async () => { throw new Error("boom"); } });
  const bad = await failing.api.setMarginJudgement(false);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.message, "boom");
  // 成功：返回 { ok:true }，写回 settings，并按新设置重算页面视图那两个勾选态
  const received = [];
  const okModule = makeModule({
    apiJson: async () => ({ settings: { margin_box_judgement: true } }),
    syncPagesProjectSettings: (value) => received.push(value),
  });
  const good = await okModule.api.setMarginJudgement(true);
  assert.equal(good.ok, true, "成功要返回 { ok: true }");
  assert.equal("error" in good, false, "成功时不该带 error");
  assert.equal(okModule.api.marginJudgementEnabled(), true, "写回 settings 之后，读设置必须读到新值");
  // 沙箱里建的对象与测试侧原型不同 ⇒ 先转成普通对象再对集
  assert.deepEqual(JSON.parse(JSON.stringify(received.at(-1))), { autoApply: false, marginJudgement: true },
    "设置改成功后要按新设置重算页面视图那两个勾选态");
});
