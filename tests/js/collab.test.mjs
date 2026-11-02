// ③ 协作模块（`collab.js`）：两个 root 按宿分组 + 13 处写盘 + 动作返回结果。
//
// 锁六件：
// ① 接口面恰好 6 个键，每个都能指出调用点（无调用点 = 预留 = 红）
// ② 双 root 归属：`#assign-panel` 子树 15 个 id、`#package-result` 子树 3 个 id，
//    模块里出现的 id 只能来自这两棵子树 + 两个 root 名本身（多一个就是"按别人的 id 找 DOM"）
// ③ 6 个外部 id（chrome 4 + 归外壳 2）在模块源码里各 0 次
// ④ 模块里除 `window.Collab = api` 外不出现任何 `window.<模块名>`
// ⑤ `applyPackageMode()` **返回** `{ ok, packageMode }`，两态都对；且不写那两个归外壳的节点
// ⑥ 死状态 `assignPreviewData` 全仓 0（写 1 读 0，同 auxData 型）
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const MODULE_URL = new URL("../../backend/book2text/static/collab.js", import.meta.url);
const STATIC = new URL("../../backend/book2text/static/", import.meta.url);
const APP = readFileSync(new URL("app.js", STATIC), "utf8");
const MODULE = readFileSync(MODULE_URL, "utf8");
const HTML = readFileSync(new URL("index.html", STATIC), "utf8");
const { codeOnly } = await import("./static-scan.mjs");

/** 宿主表：由 `scripts/id-host-map.mjs` 的口径（最近的带 id 祖先）实测后写在这里。 */
const ASSIGN_SUBTREE = [
  "assign-meta", "assign-close", "assign-reviewer", "assign-reviewer-names", "assign-due",
  "assign-context", "assign-note", "assign-preview", "assign-create", "assign-download",
  "assign-reveal", "assign-error", "assign-list", "assign-list-empty", "result-file-input",
];
// `#package-result` 子树 4 个：3 个归模块，`package-result-close` 归外壳
// （它的 click 接线在 setupShell 里，不在协作那 22 个函数里——同导出刀「一个子树两个 owner」）。
const RESULT_SUBTREE = ["package-result-close", "package-result-meta", "package-result-files", "package-export-btn"];
const RESULT_OWNED = ["package-result-meta", "package-result-files", "package-export-btn"];
const ROOT_IDS = ["assign-panel", "package-result"];
/** 不归本模块、也不注入的 6 个：chrome 4 个走注入组，2 个归外壳写。 */
const FOREIGN_IDS = [
  "open-package", "open-package-file", "package-open", "package-banner",
  "finish-open-review", "structure-open",
];

const mk = (extra = {}) => ({
  textContent: "", hidden: false, checked: false, value: "", className: "", dataset: {}, files: [],
  classList: { add() {}, remove() {}, toggle() {} },
  options: [],
  append(...kids) { (this.children ||= []).push(...kids); },
  addEventListener() {},
  click() {},
  remove() {},
  ...extra,
});

const VOID_TAGS = new Set(["br", "img", "input", "hr", "meta", "link", "source", "track", "wbr"]);

/** 某个 id 元素的子树 id 全集（不含自己），按标签深度配对。 */
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
  // 口径同 scripts/id-host-map.mjs：宿主 = 最近的带 id 祖先，**不含自己**
  return ids[0] === rootId ? ids.slice(1) : ids;
}

function makeModule({ current = { project_id: "p1", kind: "project" }, apiJson } = {}) {
  const byId = new Map();
  const rootFake = {
    querySelector: (selector) => {
      const id = String(selector).replace(/^#/, "");
      if (!byId.has(id)) byId.set(id, mk());
      return byId.get(id);
    },
  };
  const sandbox = {
    window: {}, console, document: { createElement: () => mk(), body: mk() },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    confirm: () => true, alert: () => {}, fetch: async () => ({ ok: true, json: async () => ({}), blob: async () => ({}) }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MODULE, sandbox, { filename: "collab.js" });
  const api = sandbox.window.Collab;
  const chrome = {
    openPackage: mk(), openPackageFile: mk(), packageOpen: mk(), banner: mk(),
  };
  const events = [];
  // 只记"收到的值"（不是调用次数）：A5 不许特征测试断言调用面
  const received = { pagesMode: [], editorMode: [] };
  api.init({
    roots: [rootFake, rootFake],
    getChromeEls: () => chrome,
    getCurrentProject: () => current,
    getProjectId: () => current && current.project_id,
    getSelectedPages: () => [1, 2, 3],
    getToken: () => "t0k",
    apiJson: apiJson || defaultApiJson(),
    showError: (node, error) => events.push(["showError", error]),
    showView: (name) => events.push(["showView", name]),
    syncWorkflowSteps: () => events.push(["syncWorkflowSteps"]),
    closeModal: (name) => events.push(["closeModal", name]),
    refreshPageStates: async () => events.push(["refreshPageStates"]),
    setSaveState: () => events.push(["setSaveState"]),
    closeFinishPanel: () => events.push(["closeFinishPanel"]),
    setMergeState: (value) => events.push(["setMergeState", value]),
    libraryNotify: (payload) => events.push(["libraryNotify", payload]),
    libraryEnter: async () => events.push(["libraryEnter"]),
    libraryOpen: async (id) => events.push(["libraryOpen", id]),
    mergeEnter: (id) => events.push(["mergeEnter", id]),
    pagesPackageModeChrome: (on) => received.pagesMode.push(on),
    editorPackageModeChrome: (on) => received.editorMode.push(on),
    ApiError: class ApiError extends Error {},
  });
  api.setupCollabControls();
  return { api, chrome, events, received, byId, sandbox };
}

function defaultApiJson() {
  return async (path) => {
    if (path.endsWith("/package")) {
      return {
        package: {
          page_nos: [1, 2], context_page_nos: [], owner_name: "甲",
          due_date: null, note: null, book_name: "书", reviewer_name: "乙",
        },
      };
    }
    if (path.endsWith("/package/results")) return { results: [] };
    if (path.endsWith("/assignments")) return { assignments: [], known_reviewers: [] };
    if (path.endsWith("/assignments/preview")) {
      return { page_count: 3, context_pages: [], estimated_bytes: 1024, known_reviewers: ["甲"], skipped: [] };
    }
    return {};
  };
}

test("③ 协作：接口面恰好 6 个键，每个都必须是函数", () => {
  const { api } = makeModule();
  assert.deepEqual(Object.keys(api).sort(), [
    "applyPackageMode", "init", "loadAssignments", "openAssignPanel",
    "setupCollabControls", "toggleAssignList",
  ].sort());
  for (const name of Object.keys(api)) assert.equal(typeof api[name], "function", `api.${name} 不是函数`);
});

test("③ 协作：每个导出在 app.js 里都有调用点（无调用点 = 预留 = 红）", () => {
  const { api } = makeModule();
  const code = codeOnly(APP);
  const problems = [];
  for (const key of Object.keys(api)) {
    if (!new RegExp(`Collab\\?\\.${key}\\s*\\(`).test(code)) {
      problems.push(`api.${key} 在 app.js 里没有调用点——导出面不许留"预留"`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("③ 协作：双 root 归属——assign-panel 15 个 / package-result 4 个（3 归模块 + 1 归外壳）", () => {
  const assign = subtreeIds(HTML, "assign-panel");
  const result = subtreeIds(HTML, "package-result");
  assert.deepEqual([...assign].sort(), [...ASSIGN_SUBTREE].sort(),
    `#assign-panel 子树 id 与归属表对不上（实测：${assign.join(", ")}）`);
  assert.deepEqual([...result].sort(), [...RESULT_SUBTREE].sort(),
    `#package-result 子树 id 与归属表对不上（实测：${result.join(", ")}）`);
  // 一个子树两个 owner：模块取 3 个，外壳那一处（package-result-close）不归模块
  const code = codeOnly(MODULE);
  for (const id of RESULT_OWNED) assert.equal(code.includes(`"${id}"`), true, `模块没取自己的 ${id}`);
  assert.equal(code.includes('"package-result-close"'), false, "package-result-close 归外壳，模块不许碰");
});

test("③ 协作：模块里出现的 id 只许来自两棵子树 + 两个 root 名", () => {
  const code = codeOnly(MODULE);
  const allowed = new Set([...ASSIGN_SUBTREE, ...RESULT_SUBTREE, ...ROOT_IDS]);
  const found = [...new Set([...code.matchAll(/"([a-z][a-z0-9]*(?:-[a-z0-9]+)+)"/g)].map((m) => m[1]))]
    .filter((token) => token.startsWith("assign-") || token.startsWith("package-") || token.startsWith("result-") || token.startsWith("finish-") || token.startsWith("structure-") || token.startsWith("open-"));
  const problems = found.filter((id) => !allowed.has(id))
    .map((id) => `模块里出现了 "${id}"——它不在这两棵子树里，只能经 init 注入，或根本不归本模块`);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("③ 协作：6 个外部 id 在模块源码里各 0 次", () => {
  const code = codeOnly(MODULE);
  for (const id of FOREIGN_IDS) {
    assert.equal(code.includes(`"${id}"`), false, `模块里出现了 "${id}"——chrome 4 个只能注入，另 2 个归外壳写`);
  }
});

test("③ 协作：模块里除自己的 window.Collab 外不出现任何 window.<模块名>", () => {
  const code = codeOnly(MODULE);
  const names = [...new Set([...code.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  assert.deepEqual(names, ["Collab"], `模块里出现了别的 window 引用：${names.join(", ")}——跨模块只能走注入`);
});

test("③ 协作：注入双向对（boot 传的键模块都读、模块读的键 boot 都传）", () => {
  const code = codeOnly(APP);
  const boot = code.slice(code.indexOf("window.Collab?.init({"));
  assert.ok(boot.length > 0, "boot 里没找到 Collab 的 init 块");
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

test("③ 协作：applyPackageMode 返回 { ok, packageMode }，两态都对", async () => {
  const plain = makeModule({ current: { project_id: "p1", kind: "project" } });
  const a = await plain.api.applyPackageMode();
  assert.equal(a.ok, true);
  assert.equal(a.packageMode, false, "普通项目 ⇒ packageMode:false");
  assert.equal(plain.received.pagesMode.at(-1), false, "非包模式要把页面视图的入口放开（on=false）");
  assert.equal(plain.events.some((e) => e[0] === "closeModal" && e[1] === "package-result"), true,
    "非包模式要关掉结果包对话框");

  const pkg = makeModule({ current: { project_id: "p2", kind: "package" } });
  const b = await pkg.api.applyPackageMode();
  assert.equal(b.ok, true);
  assert.equal(b.packageMode, true, "审校包项目 ⇒ packageMode:true");
  assert.equal(pkg.chrome.banner.hidden, false, "包模式要显示横幅");
  assert.ok(String(pkg.chrome.banner.textContent).includes("审校任务"));
  assert.equal(pkg.received.pagesMode.at(-1), true, "包模式要收掉页面视图的入口（on=true）");
  assert.equal(pkg.received.editorMode.at(-1), true, "包模式要收掉审校面板自己的两个入口");
});

test("③ 协作：没有项目时 applyPackageMode 返回 ok:false，且不碰任何节点", async () => {
  const none = makeModule({ current: null });
  const result = await none.api.applyPackageMode();
  assert.equal(result.ok, false);
  assert.equal(none.chrome.banner.hidden, false, "没有项目时不该隐藏横幅");
  assert.equal(none.received.pagesMode.at(-1), undefined, "没有项目时不该通知页面视图");
});

test("③ 协作：死状态 assignPreviewData 全仓 0 次", () => {
  for (const name of ["app.js", "collab.js"]) {
    assert.equal(codeOnly(readFileSync(new URL(name, STATIC), "utf8")).includes("assignPreviewData"), false,
      `${name} 里还有 assignPreviewData——死状态不许回来`);
  }
});

test("③ 协作：结果包下载的 URL 是 /package/results/<name>（复数——写成单数是 404 回归）", async () => {
  const urls = [];
  const mod = makeModule({
    current: { project_id: "p2", kind: "package" },
    apiJson: async (path) => {
      if (path.endsWith("/package")) {
        return {
          package: {
            page_nos: [1], context_page_nos: [], owner_name: "甲",
            due_date: null, note: null, book_name: "书", reviewer_name: "乙",
          },
        };
      }
      if (path.endsWith("/package/results")) return { results: [{ name: "r1.b2tres", size: 1024 }] };
      return {};
    },
  });
  // 结果列表里那个「下载」按钮要能点：给沙箱换一个会记录 handler 的 createElement，
  // 并捕获 fetch 打出的 URL（都在测试内替换，不改测试台架本身）
  mod.sandbox.document.createElement = () => {
    const node = mk();
    const handlers = [];
    node.addEventListener = (type, fn) => { if (type === "click") handlers.push(fn); };
    node.click = () => { for (const fn of handlers) fn({ target: node }); };
    return node;
  };
  mod.sandbox.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, blob: async () => ({}) };
  };
  await mod.api.applyPackageMode();
  const list = mod.byId.get("package-result-files");
  assert.ok(list && list.children.length === 1, "结果列表没渲染出那一行");
  const downloadButton = list.children[0].children.at(-1);
  downloadButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    urls.at(-1),
    "/api/projects/p2/package/results/r1.b2tres?token=t0k",
    "下载 URL 必须是 /package/results/<name>（复数，后端 routes_packages.py:108）；"
    + "写成单数 /package/result/ 会 404（62868c7 的 app.js:8584 本来就是复数）",
  );
});

/** 可触发事件的假节点（测试内用，不改 mk）：记录 handler 并暴露 fire()。 */
const mkEmitter = () => {
  const node = mk();
  const handlers = {};
  node.addEventListener = (type, fn) => { (handlers[type] ||= []).push(fn); };
  node.fire = (type, event = { target: node }) => { for (const fn of handlers[type] || []) fn(event); };
  node.click = () => node.fire("click");
  return node;
};

test("③ 协作：导出结果包成功后 #package-result-meta 落终态（不停在「导出中…」）", async () => {
  const mod = makeModule({
    current: { project_id: "p3", kind: "package" },
    apiJson: async (path) => {
      if (path.endsWith("/package")) {
        return {
          package: {
            page_nos: [1], context_page_nos: [], owner_name: "甲",
            due_date: null, note: null, book_name: "书", reviewer_name: "乙",
          },
        };
      }
      if (path.endsWith("/package/results")) return { results: [] };
      if (path.endsWith("/package/result")) {
        return {
          file_name: "r1.b2tres",
          summary: { page_count: 2, unfinished_pages: [], uncertain: 0, commented: 0, modified: 0 },
        };
      }
      return {};
    },
  });
  mod.sandbox.alert = () => {};
  const button = mkEmitter();
  mod.byId.set("package-export-btn", button);
  mod.api.setupCollabControls();
  await mod.api.applyPackageMode();
  button.fire("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const meta = mod.byId.get("package-result-meta");
  assert.notEqual(meta.textContent, "导出中…", "成功路径没写终态：停在「导出中…」");
  assert.ok(String(meta.textContent).includes("已生成"), `终态文案不对：${meta.textContent}`);
});

test("③ 协作：导入结果包失败后顶栏 save 状态落错误终态", async () => {
  const saves = [];
  const mod = makeModule({
    current: { project_id: "p4", kind: "project" },
    apiJson: async (path) => {
      if (path.endsWith("/assignments")) {
        return {
          assignments: [{
            assignment_id: "a1", reviewer_name: "甲", page_nos: [1], status: "pending",
            status_label: "已分派", imported_seq: 0, due_date: null, note: null,
          }],
          known_reviewers: ["甲"],
        };
      }
      return {};
    },
  });
  mod.api.init({ setSaveState: (text, isError) => saves.push([text, isError === true]) });
  mod.sandbox.fetch = async () => ({ ok: false, json: async () => ({ error: { message: "包已作废" } }) });
  const input = mkEmitter();
  input.files = [{ name: "r1.b2tres" }];
  mod.byId.set("result-file-input", input);
  mod.api.setupCollabControls();
  // 列表里的按钮是 createElement 造的：换成会记 handler 的节点，否则 click 绑不上
  mod.sandbox.document.createElement = () => mkEmitter();
  await mod.api.loadAssignments();
  // 列表里那一行的「导入结果」按钮 → pickResultFile（记下 packagePending）
  const list = mod.byId.get("assign-list");
  const importButton = list.children[0].children.at(-1).children.find((n) => n.textContent === "导入结果");
  assert.ok(importButton, "列表里没有「导入结果」按钮");
  importButton.click();
  input.fire("change");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const last = saves.at(-1);
  assert.ok(last, "失败后一次 save 状态都没写——顶栏会停在「正在导入结果包…」");
  assert.equal(last[1], true, "失败要写错误态（setSaveState 第二个参数 true）");
  assert.ok(String(last[0]).includes("导入失败"), `失败文案不对：${last[0]}`);
});
