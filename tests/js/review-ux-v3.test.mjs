// 审校屏 UX V3 的三条**行为**用例（Chief 2026-10-29 派单）。
//
// 判据只认「用户看到的」：
//   ① 一条 = 一处差异 —— 面板里出现的是差异片段（前后各 ±6 字），不是整行；
//      差异字有强调（加粗/下划线）；点「看整行」才展开整行。
//   ② 判决即前进 —— Enter/空格 之后：当前条已记录、下一条已加载、**面板没关**、视口没跳。
//      反面（历史 bug）：面板开着按 Enter **跳过当前条且不记录** —— 必须红。
//   ③ 默认焦点在「保留原文」—— 打开面板直接按 Enter 就是"保留原文并前进"，不需要先 Tab。
//
// 不判实现：不断言"调用了 advanceToNext()/draftReading()"，只断言面板文本、草稿记录、
// 面板还开着、面板换成了哪一条、焦点在哪个按钮、滚动位置变没变。
//
// ## 为什么默认 skip
//
// 仓库的 pre-commit 跑 `node tests/js/run.mjs`，**红了就拒提交**（AGENTS 1.5）。
// 这三条描述的是 UX V3 的**目标行为**，HEAD 上还没实现——写死成红会让所有人推不动。
// 所以默认 `skip`，并给一个强制开关：
//
//     B2T_REVIEW_UX_V3=1 node tests/js/run.mjs review-ux-v3     # 跑真断言（现在是红的）
//
// **落地后把 SKIP_REASON 改成 null 一行**，从此它就是挡人的闸。
// （同 `reading-view-behavior.test.mjs` 的既有口径：main 上还不存在的行为按条件 skip，不写成红。）
//
// ## 红/绿夹具（改动只在 /tmp 的副本上，不碰产品文件）
//
// 同一个文件、同一批断言，只换被测源码（`B2T_READING_VIEW_JS` 指向副本）：
//
//     # 历史 bug 版（e8a1ce3 之前：面板开着按 Enter 直接 gotoNextUnreviewed）
//     git show 'e8a1ce3^:backend/book2text/static/reading-view.js' > /tmp/rv-prefix.js
//     B2T_REVIEW_UX_V3=1 B2T_READING_VIEW_JS=/tmp/rv-prefix.js \
//       node tests/js/review-ux-v3.test.mjs      # ② 红「草稿数是 0——当前条被跳过且没记录」
//
//     # 把默认焦点挪到「采用候选」
//     → ③ 红「默认焦点在「采用候选」——回车会执行错的动作」
//
//     # 把 Enter 改成"关面板"
//     → ② 红「草稿数是 0——当前条被跳过且没记录」
//
// 反向也验过：临时副本里把三处目标行为都实现（±6 片段 + 保留原文聚焦 + 判决后开下一条）
// → 4 条全绿。所以这些断言不是"怎么写都不可能绿"。
import test from "node:test";
import assert from "node:assert/strict";
import { loadReadingView } from "./load-reading-view.mjs";

const FORCE = process.env.B2T_REVIEW_UX_V3 === "1";
const SKIP_REASON = FORCE
  ? false
  : "UX V3 行为尚未落地（面板 ±6 片段 / 判决即前进 / 默认焦点）；落地后去掉 skip，见文件头";

// 变异验证用：B2T_READING_VIEW_JS 指向 /tmp 里的改坏副本，跑同一批断言。
const MODULE_FILE = process.env.B2T_READING_VIEW_JS || undefined;

// ---------------------------------------------------------------- 薄假 DOM
//
// 与 reading-view-behavior.test.mjs 的"只记节点、不建树"不同：这里要判
// 「面板里现在显示哪一段字」「焦点在哪个按钮」，所以 append 必须真的建树，
// focus() 必须真的记到 document.activeElement。

const ALL_NODES = [];

function parseCompound(part) {
  return {
    tag: (part.match(/^([A-Za-z][\w-]*)/) || [])[1] || null,
    id: (part.match(/#([\w-]+)/) || [])[1] || null,
    classes: [...part.matchAll(/\.([\w-]+)/g)].map((match) => match[1]),
    dataKey: (part.match(/\[data-key="([^"]*)"\]/) || [])[1] ?? null,
  };
}

function matchesCompound(node, compound) {
  if (compound.tag && node.tagName !== compound.tag.toUpperCase()) return false;
  if (compound.id && node.id !== compound.id) return false;
  if (!compound.classes.every((name) => node.classList.contains(name))) return false;
  if (compound.dataKey !== null && node.dataset.key !== compound.dataKey) return false;
  return true;
}

function ancestorsOf(node) {
  const chain = [];
  for (let current = node.parentNode; current; current = current.parentNode) chain.push(current);
  return chain;
}

function makeDocument() {
  const byId = new Map();
  const listeners = {};
  const doc = {
    activeElement: null,
    readyState: "complete",
    hidden: false,
    body: null,
    addEventListener(type, handler) {
      (listeners[type] = listeners[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      listeners[type] = (listeners[type] || []).filter((item) => item !== handler);
    },
    dispatchKey(key, target) {
      for (const handler of listeners.keydown || []) {
        handler({ key, type: "keydown", target: target || doc.body || doc.activeElement || doc.body, preventDefault() {}, stopPropagation() {} });
      }
    },
    getElementById(id) {
      if (!byId.has(id)) {
        const node = makeElement("div");
        node.id = id;
        byId.set(id, node);
      }
      return byId.get(id);
    },
    createElement(tag) {
      return makeElement(tag);
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text), children: [], parentNode: null, append() {}, remove() {} };
    },
    createDocumentFragment() {
      return makeElement("#fragment");
    },
    createRange() {
      return { selectNodeContents() {}, setStart() {}, setEnd() {} };
    },
    querySelector(selector) {
      return findAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      return findAll(selector);
    },
  };

  function makeElement(tag) {
    const node = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      id: "",
      className: "",
      title: "",
      hidden: false,
      disabled: false,
      type: "",
      value: "",
      dataset: {},
      style: {},
      children: [],
      parentNode: null,
      listeners: {},
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 0,
      clientWidth: 600,
      clientHeight: 800,
      offsetTop: 0,
      offsetHeight: 0,
      _text: "",
      append(...kids) {
        for (const kid of kids) {
          if (kid) {
            kid.parentNode = node;
            node.children.push(kid);
          }
        }
      },
      appendChild(kid) {
        node.append(kid);
        return kid;
      },
      prepend(kid) {
        if (kid) {
          kid.parentNode = node;
          node.children.unshift(kid);
        }
      },
      replaceChildren(...kids) {
        for (const kid of node.children) kid.parentNode = null;
        node.children.length = 0;
        node.append(...kids);
      },
      insertBefore(kid) {
        node.append(kid);
      },
      remove() {
        if (node.parentNode) {
          node.parentNode.children = node.parentNode.children.filter((item) => item !== node);
          node.parentNode = null;
        }
      },
      addEventListener(type, handler) {
        (node.listeners[type] = node.listeners[type] || []).push(handler);
      },
      removeEventListener(type, handler) {
        node.listeners[type] = (node.listeners[type] || []).filter((item) => item !== handler);
      },
      click() {
        for (const handler of node.listeners.click || []) {
          handler({ type: "click", target: node, preventDefault() {} });
        }
      },
      focus() {
        doc.activeElement = node;
      },
      blur() {
        if (doc.activeElement === node) doc.activeElement = null;
      },
      select() {},
      setAttribute(key, value) {
        if (key === "class") node.className = String(value);
        else if (key === "id") node.id = String(value);
        else node.dataset[key] = String(value);
      },
      getAttribute(key) {
        if (key === "class") return node.className;
        if (key === "id") return node.id;
        return node.dataset[key] ?? null;
      },
      removeAttribute() {},
      closest(selector) {
        for (let current = node; current; current = current.parentNode) {
          if (matchesCompound(current, parseCompound(selector))) return current;
        }
        return null;
      },
      querySelector(selector) {
        return findAll(selector, node)[0] || null;
      },
      querySelectorAll(selector) {
        return findAll(selector, node);
      },
      scrollIntoView() {},
      scrollTo() {},
      setPointerCapture() {},
      releasePointerCapture() {},
      getBoundingClientRect: () => ({ width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800 }),
      get textContent() {
        return node.children.length ? node.children.map((kid) => kid.textContent).join("") : node._text;
      },
      set textContent(value) {
        node._text = String(value);
        node.children.length = 0;
      },
    };
    Object.defineProperty(node, "classList", {
      value: {
        add: (...names) => {
          const current = node.className.split(/\s+/).filter(Boolean);
          for (const name of names) if (!current.includes(name)) current.push(name);
          node.className = current.join(" ");
        },
        remove: (...names) => {
          node.className = node.className.split(/\s+/).filter((item) => item && !names.includes(item)).join(" ");
        },
        contains: (name) => node.className.split(/\s+/).includes(name),
        toggle: (name, force) => {
          const on = force === undefined ? !node.classList.contains(name) : Boolean(force);
          if (on) node.classList.add(name);
          else node.classList.remove(name);
          return on;
        },
      },
    });
    Object.defineProperty(node, "innerHTML", {
      get: () => "",
      set: () => {
        // 清空 = 真的从树上摘下来：否则 `#reading-panel-host .reading-panel`
        // 还能在"已清空"的宿主里找到旧面板（假 DOM 的经典假绿）。
        for (const kid of node.children) kid.parentNode = null;
        node.children.length = 0;
        node._text = "";
      },
    });
    ALL_NODES.push(node);
    return node;
  }

  function findAll(selector, root) {
    const parts = selector.trim().split(/\s+/).map(parseCompound);
    const last = parts[parts.length - 1];
    const pool = root ? collect(root) : ALL_NODES;
    return pool.filter(
      (node) =>
        matchesCompound(node, last) &&
        parts.slice(0, -1).every((compound) => ancestorsOf(node).some((parent) => matchesCompound(parent, compound))),
    );
  }

  doc.reset = () => {
    byId.clear();
    ALL_NODES.length = 0;
    doc.body = makeElement("body");
    doc.activeElement = null;
  };

  function collect(root) {
    const out = [];
    const walk = (node) => {
      for (const kid of node.children || []) {
        out.push(kid);
        walk(kid);
      }
    };
    walk(root);
    return out;
  }

  doc.body = makeElement("body");
  return doc;
}

// ---------------------------------------------------------------- 装模块

const document = makeDocument();
ALL_NODES.length = 0;
const loadOptions = { require: ["openReadingPanel", "draftReading", "readingKey"] };
if (MODULE_FILE) loadOptions.file = MODULE_FILE;
const { ctx, run, setInjected } = loadReadingView(loadOptions);
ctx.document = document;
ctx.localStorage = {
  _store: new Map(),
  getItem(key) { return this._store.has(String(key)) ? this._store.get(String(key)) : null; },
  setItem(key, value) { this._store.set(String(key), String(value)); },
  removeItem(key) { this._store.delete(String(key)); },
  clear() { this._store.clear(); },
  key(index) { return [...this._store.keys()][index] ?? null; },
  get length() { return this._store.size; },
};
ctx.requestAnimationFrame = (callback) => {
  callback(0);
  return 1;
};
ctx.cancelAnimationFrame = () => {};

const NOTICES = [];
let INITIALIZED = false;

/** 注入表：模块 spread 后要用的每个名字都得给（Proxy 过不了 spread）。 */
function installDependencies() {
  const state = {
    readingPageNo: 1,
    readingEntries: [],
    readingDrafts: new Map(),
    readingCursorEntry: null,
    readingPanelKey: null,
    readingEditingKey: null,
  };
  const deps = {
    el: (id) => document.getElementById(id),
    isReadingActive: () => true,
    getProject: () => ({ project_id: "p1" }),
    getProjectId: () => "p1",
    getCurrentView: () => "reading",
    exportOptions: () => ({ page_types: ["body"] }),
    apiJson: async () => ({ lines: [] }),
    showNoticeBar: (text) => NOTICES.push(String(text)),
    storage: ctx.localStorage,
    readingLineNode: () => null,
  };
  if (!INITIALIZED) {
    setInjected(deps);
    ctx.ReadingView.init(deps);
    INITIALIZED = true;
  }

  // 面板之外的重活全部打桩：本文件只判面板与焦点，不判渲染/滚动/进度条。
  // （打桩的是"别的链路"，不是被测的分支——被测的 openReadingPanel / keydown / draftReading 都是真的。）
  ctx.refreshReadingCurrentHighlight = () => {};
  ctx.centerReadingLinePair = () => {};
  ctx.rerenderReadingLine = () => {};
  ctx.renderReadingProgress = () => {};
  ctx.drawReadingPdfBox = () => {};
  ctx.updateReadingPage = () => {};
  ctx.noteReadingAction = () => {};
  return state;
}

let STATE = installDependencies();

/** 每条用例都从空状态出发。 */
function reset() {
  document.reset();
  NOTICES.length = 0;
  STATE = installDependencies();
  run(`readingPageNo = 1; readingPanelKey = null; readingEditingKey = null;
       readingEntries = []; readingDrafts = new Map(); readingCursorEntry = null;`);
}

/**
 * 造一条"行内改了一个字"的审校条目。
 * 行文本刻意埋了两个**只在远处出现**的记号（远处甲 / 远处乙），
 * 这样"面板里有没有出现远处 6 字以外的内容"可以直接用文本判断，不依赖 DOM 结构。
 */
function makeEntry(blockId, lineIndex, pageNo, { current, candidate, diffAt }) {
  return { block_id: blockId, line_index: lineIndex, page_no: pageNo, level: "differs_chars", current, candidate, diffAt };
}

const LINE_A = "远处甲的前半句在这里然后中间有个字变了接着后半句继续往后走远处乙";
const CAND_A = "远处甲的前半句在这里然后中间有个字换了接着后半句继续往后走远处乙";
const DIFF_INDEX = LINE_A.split("").findIndex((char, index) => char !== CAND_A.split("")[index]);

function openPanel(entry, others = []) {
  const entries = [entry, ...others];
  ctx.__entries = entries;
  run(`readingEntries = __entries; readingPageNo = ${entry.page_no};
       readingDrafts = new Map(); readingPanelKey = null;`);
  ctx.openReadingPanel(entry);
  return panelNode();
}

function panelNode() {
  return document.querySelector("#reading-panel-host .reading-panel");
}

function draftList() {
  return JSON.parse(run("JSON.stringify([...readingDrafts.values()])"));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function assertEmphasized(panel, changedChar) {
  const candidates = [];
  const walk = (node) => {
    if (node.textContent === changedChar) candidates.push(node);
    for (const kid of node.children || []) walk(kid);
  };
  walk(panel);
  const emphasized = candidates.some((node) => {
    if (/^(B|STRONG|U|MARK|INS|DEL)$/.test(node.tagName)) return true;
    if (/(^|\s)(diff|emph|changed|ins|del|hl|mark)(\s|$)/i.test(node.className)) return true;
    const style = node.style || {};
    const decoration = String(style.textDecoration || style.textDecorationLine || "");
    return /underline|line-through/i.test(decoration) || String(style.fontWeight || "") === "700";
  });
  assert.ok(
    emphasized,
    `差异字「${changedChar}」没有任何强调（加粗 / 下划线 / <b>/<u>/<mark>）——用户看不出哪个字变了`,
  );
}

// ---------------------------------------------------------------- ① 一条 = 一处差异

test("① 面板只显示差异片段（±6 字），不是整行；差异字有强调；「看整行」才展开整行", {
  skip: SKIP_REASON,
}, () => {
  reset();
  const entry = makeEntry("b1", 0, 1, { current: LINE_A, candidate: CAND_A });
  const panel = openPanel(entry);
  assert.ok(panel, "点了差异之后没有面板——用户无处判决");

  const text = panel.textContent;
  assert.ok(!text.includes(LINE_A), "面板里是整行（旧文本）——一条差异不该让用户重读整行");
  assert.ok(!text.includes(CAND_A), "面板里是整行（候选文本）——一条差异不该让用户重读整行");
  assert.ok(
    !text.includes("远处甲") && !text.includes("远处乙"),
    `面板里出现了距离差异超过 6 字的内容（远处甲/远处乙）：「${text}」——片段窗口不是 ±6 字`,
  );

  const oldChar = LINE_A[DIFF_INDEX];
  const newChar = CAND_A[DIFF_INDEX];
  assert.ok(text.includes(newChar), `面板里没有候选的那个字「${newChar}」：「${text}」`);
  assert.ok(text.includes(oldChar), `面板里没有原文的那个字「${oldChar}」：「${text}」`);
  assertEmphasized(panel, newChar);

  const expand = [...panel.querySelectorAll("button")].find((button) => /看整行/.test(button.textContent));
  assert.ok(expand, "面板上没有「看整行」——用户想核对上下文时没有出口");
  expand.click();
  assert.ok(panel.textContent.includes(CAND_A), "点了「看整行」之后面板里仍不是整行");
});

// ---------------------------------------------------------------- ② 判决即前进

test("② 判决即前进：Enter 之后当前条已记录、下一条已加载、面板没关、视口没跳", {
  skip: SKIP_REASON,
}, async () => {
  reset();
  const first = makeEntry("b1", 0, 1, { current: LINE_A, candidate: CAND_A });
  const second = makeEntry("b2", 0, 1, {
    current: "另一处的原文在这里有个不一样的字然后继续",
    candidate: "另一处的原文在这里有个不同的字然后继续",
  });
  openPanel(first, [second]);

  const stream = document.getElementById("reading-stream");
  stream.scrollTop = 320;
  const pageBefore = run("readingPageNo");

  document.dispatchKey("Enter");
  await tick();

  const drafts = draftList();
  assert.equal(drafts.length, 1, `按 Enter 之后草稿数是 ${drafts.length}（应为 1）——当前条被跳过且没记录`);
  assert.equal(drafts[0].ack, "kept", `Enter 记录的裁决是 ${drafts[0].ack}（应为 kept）`);
  assert.equal(`${drafts[0].block_id}:${drafts[0].line_index}`, "b1:0", "记录的不是当前这一条");

  const panel = panelNode();
  assert.ok(panel, "按 Enter 之后面板被关掉了——判决应当原地继续下一条");
  assert.equal(panel.dataset.key, "b2:0", `面板没有换到下一条（现在是 ${panel.dataset.key}）`);
  assert.equal(stream.scrollTop, 320, "判决之后正文视口跳了——用户会丢失位置感");
  assert.equal(run("readingPageNo"), pageBefore, "判决之后页码变了");
});

test("② 空格和 Enter 一样：记录当前条并前进（不关面板）", {
  skip: SKIP_REASON,
}, async () => {
  reset();
  const first = makeEntry("b1", 0, 1, { current: LINE_A, candidate: CAND_A });
  const second = makeEntry("b2", 0, 1, {
    current: "另一处的原文在这里有个不一样的字然后继续",
    candidate: "另一处的原文在这里有个不同的字然后继续",
  });
  openPanel(first, [second]);

  document.dispatchKey(" ", document.body);
  await tick();

  assert.equal(draftList().length, 1, "按空格之后当前条没有被记录");
  const panel = panelNode();
  assert.ok(panel, "按空格之后面板被关掉了");
  assert.equal(panel.dataset.key, "b2:0", "按空格之后没有前进到下一条");
});

// ---------------------------------------------------------------- ③ 默认焦点

test("③ 默认焦点在「保留原文」：打开面板直接按 Enter 就生效", {
  skip: SKIP_REASON,
}, async () => {
  reset();
  const entry = makeEntry("b1", 0, 1, { current: LINE_A, candidate: CAND_A });
  openPanel(entry);

  assert.ok(document.activeElement, "打开面板后没有任何元素拿到焦点——用户得先 Tab 才能回车");
  assert.equal(
    document.activeElement.textContent,
    "保留原文",
    `默认焦点在「${document.activeElement.textContent}」——回车会执行错的动作`,
  );

  document.dispatchKey("Enter");
  await tick();
  const drafts = draftList();
  assert.equal(drafts.length, 1, "焦点在「保留原文」时按 Enter 没有生效（没有记成裁决）");
  assert.equal(drafts[0].ack, "kept", "焦点在「保留原文」时按 Enter 记成了别的裁决");
});
