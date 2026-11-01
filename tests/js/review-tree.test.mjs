// T0：审校左树的**可达性**——默认模式（按章节分组）必须能到达每一页。
//
// 缺陷（QA 2026-11-01 真机走查，§8 T0）：`renderReviewTree` 只在 `page.chapter === chapter.id`
// 时把页挂进树，`chapter` 匹配不到任何章节的页**永远没有行**。真书上 490 页里 29 页无归属，
// 其中 21 页背着全部 90 处待审 ⇒ 树顶写「90 处待审」，7 个回目全「✓ 完成」，默认模式下一页都点不到。
//
// 判据分两层，缺一层都不算：
//   模型层：`reviewTreeGroups(pages, chapters)` 的分组必须**不丢页**（集合与合计都比）
//   渲染层：**默认模式**（reviewTreeOnlyTodo === false）下，树上真能点到每一页
//
// ① 只在默认模式成立不算数一半：过滤模式（filter=true）那支本来就平铺全部 unacked>0 的页，
//    光靠它满足等于没验——所以每条用例都写清自己跑的是哪一支。
// ② 比集合不比合计：合计相等可以掩盖「少 5 页、多 5 处」这种互换；集合差集为空才是真的没丢。
// ③ 四组夹具：全有章节 / 全无章节 / 混合（就是这本书的形状）/ chapters 为空数组。
// ④ 防回归：filter=true 那支跑一组，行为不许变。

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApp, runInApp } from "./load-app.mjs";

const CHAPTERS_7 = Array.from({ length: 7 }, (_, index) => ({
  id: `c${index}`, title: `第${index + 1}回`, page_from: index * 60 + 1, page_to: index * 60 + 60,
}));

/**
 * 这本书的形状：490 页 / 7 章 / 29 页无归属（其中 21 页背着全部 90 处待审）。
 * 数字取自 QA 真机走查，不是编的；夹具里保持同样的比例，才能复现「树顶 90 处、默认模式 0 行」。
 */
function bookShape() {
  const pages = [];
  for (let pageNo = 1; pageNo <= 490; pageNo += 1) {
    const chapter = pageNo <= 461 ? `c${Math.floor((pageNo - 1) / 66)}` : null;
    pages.push({ page_no: pageNo, chapter, unacked: 0, acked: 0, total: 0 });
  }
  // 461 页之后那 29 页里，前 21 页是全部待审（90 处）的载体
  const orphans = pages.filter((page) => page.chapter === null);
  for (let index = 0; index < 21; index += 1) {
    orphans[index].unacked = index === 20 ? 30 : 3;   // 20×3 + 30 = 90
    orphans[index].total = orphans[index].unacked;
  }
  return { chapters: CHAPTERS_7, pages };
}

const ALL_CHAPTERED = {
  chapters: [{ id: "c0", title: "第一回" }, { id: "c1", title: "第二回" }],
  pages: [1, 2, 3, 4, 5, 6].map((pageNo) => ({
    page_no: pageNo, chapter: pageNo <= 3 ? "c0" : "c1", unacked: pageNo === 2 ? 5 : 0, acked: 0, total: 0,
  })),
};

const NO_CHAPTER_MATCH = {
  chapters: [{ id: "c0", title: "第一回" }, { id: "c1", title: "第二回" }],
  pages: [1, 2, 3, 4].map((pageNo) => ({ page_no: pageNo, chapter: null, unacked: pageNo, acked: 0, total: 0 })),
};

const NO_CHAPTERS = {
  chapters: [],
  pages: [7, 8, 9].map((pageNo) => ({ page_no: pageNo, chapter: "c0", unacked: pageNo === 8 ? 2 : 0, acked: 0, total: 0 })),
};

/** 在 app 上下文里调内核；函数不存在时红，并说清是"产品笔还没落"而不是"测试写错"。 */
function groupsOf(ctx, { pages, chapters }) {
  return runInApp(ctx, `reviewTreeGroups(${JSON.stringify(pages)}, ${JSON.stringify(chapters)})`);
}

const unionOfPages = (groups) => groups.flatMap((group) => (group.pages || []).map((page) => page.page_no));
const unackedSum = (groups) => groups.reduce((sum, group) => sum + (group.pages || []).reduce((n, page) => n + page.unacked, 0), 0);
const unackedPages = ({ pages }) => pages.filter((page) => page.unacked > 0).map((page) => page.page_no);
const allPages = ({ pages }) => pages.map((page) => page.page_no);

/** 造一个能走 DOM 的最小节点：`append` 要真的把孩子记下来，否则"渲染了什么"观察不到。 */
function domNode(tag) {
  const node = {
    tagName: String(tag || "div").toUpperCase(), className: "", textContent: "", title: "", type: "",
    hidden: false, style: {}, dataset: {}, children: [], _html: "",
    classList: {
      add: (...names) => { node.className = [node.className, ...names].filter(Boolean).join(" "); },
      remove: () => {}, toggle: () => {}, contains: () => false,
    },
    append: (...kids) => { for (const kid of kids) node.children.push(kid); },
    appendChild: (kid) => { node.children.push(kid); return kid; },
    remove: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
    scrollIntoView: () => {},
  };
  Object.defineProperty(node, "innerHTML", {
    get: () => node._html,
    set: (value) => { node._html = value; if (value === "") node.children.length = 0; },
  });
  return node;
}

/** 起一个能走 DOM 的树环境：list 收渲染结果，其余 id 给空节点。 */
function treeEnv(tree) {
  const ctx = loadApp({ require: ["renderReviewTree"] });
  const nodes = new Map();
  const list = domNode("ul");
  ctx.document.createElement = (tag) => domNode(tag);
  ctx.document.getElementById = (id) => {
    if (id === "review-tree-list") return list;
    if (!nodes.has(id)) nodes.set(id, domNode("div"));
    return nodes.get(id);
  };
  runInApp(ctx, `reviewTree = ${JSON.stringify(tree)};`);
  return { ctx, list };
}

/** 树上**页行**的页码（按可见标签取，等价于用户能点到的那几行）。 */
function pageRows(list) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const row = String(node.className || "");
    if (row.includes("review-tree__row--page")) {
      const label = (node.children || []).find((kid) => String(kid.className || "").includes("tree-page-no"));
      const hit = /(\d+)/.exec((label && label.textContent) || node.title || "");
      if (hit) found.push(Number(hit[1]));
    }
    for (const kid of node.children || []) walk(kid);
  };
  walk(list);
  return found;
}

/** 把树渲染一次，返回树上页行的页码（按默认/过滤两支分别跑）。 */
function renderedPageNos({ tree, onlyTodo }) {
  const { ctx, list } = treeEnv(tree);
  runInApp(ctx, `
    reviewTreeOnlyTodo = ${onlyTodo ? "true" : "false"};
    reviewTreeExpandedChapters.clear();
    for (const chapter of reviewTree.chapters) reviewTreeExpandedChapters.add(chapter.id);
    reviewTreeExpandedChapters.add(null);   // 未归章那一组的键：修好后它是 null
    // 扩展键约定可能不叫 null（例如 "未归章"）：有内核就把它的组 id 全展开，别让用例绑死一种写法
    if (typeof reviewTreeGroups === "function") {
      for (const group of reviewTreeGroups(reviewTree.pages, reviewTree.chapters)) reviewTreeExpandedChapters.add(group.id);
    }
    detailPageNo = null;
    renderReviewTree();
  `);
  return pageRows(list);
}

// ── 模型层：分组不丢页 ───────────────────────────────────────────────────

test("T0 模型（混合·这本书的形状）：7 章 + 1 个「未归章」组，29 页一页不少，且它在最后", () => {
  const ctx = loadApp({ require: ["computeCharSpans"] });
  const book = bookShape();
  assert.equal(typeof ctx.reviewTreeGroups, "function",
    "reviewTreeGroups 不存在——T0 的产品笔还没落（这是「产品没做到」，不是「测试写错」）");
  const groups = groupsOf(ctx, book);

  // **集合先判**：合计相等可以掩盖「少 5 页多 5 处」的互换，集合差集空才是真的没丢页。
  // 变异（删掉「未归章」分支）必须红在这里——红在「组数不对」只是结构提示，不是可达性。
  const rendered = new Set(unionOfPages(groups));
  const missing = allPages(book).filter((pageNo) => !rendered.has(pageNo));
  assert.deepEqual(missing, [],
    `分组丢了 ${missing.length} 页（例如 ${missing.slice(0, 5).join("、")}）——`
    + "默认模式下这些页在树上没有行，用户点不到");
  assert.equal(unionOfPages(groups).length, book.pages.length, "有页被收进多个组（重复收页会让人以为还有别的页要审）");
  assert.equal(unackedSum(groups), 90, "分组后的待审合计对不上");

  // 结构：分组数、「未归章」在最后、组内页数与待审数
  assert.equal(groups.length, 8, "分组数不是「7 章 + 未归章」");
  assert.equal(groups[groups.length - 1].id, null, "「未归章」组必须在最后，且 id 为 null");
  const orphanGroup = groups[groups.length - 1];
  assert.equal(orphanGroup.pages.length, 29, "无章节的 29 页没有被收进「未归章」组");
  assert.equal(orphanGroup.pages.reduce((sum, page) => sum + page.unacked, 0), 90,
    "「未归章」组里的待审数不是 90——那正是默认模式点不到的 90 处");
});

test("T0 模型（全有章节）：只有章节组，不出「未归章」组", () => {
  const ctx = loadApp({ require: ["computeCharSpans"] });
  const groups = groupsOf(ctx, ALL_CHAPTERED);
  assert.equal(groups.length, 2, "全有章节时分组数应等于章节数");
  assert.ok(!groups.some((group) => group.id === null), "没人无归属，却多出一个「未归章」组");
  assert.deepEqual([...unionOfPages(groups)].sort((a, b) => a - b), allPages(ALL_CHAPTERED), "全有章节也丢页了");
});

test("T0 模型（全无章节）：章节都空 ⇒ 只剩「未归章」一组，页一页不少", () => {
  const ctx = loadApp({ require: ["computeCharSpans"] });
  const groups = groupsOf(ctx, NO_CHAPTER_MATCH);
  assert.equal(groups.length, 1, "章节全空时应只剩「未归章」一组（空章跳过）");
  assert.equal(groups[0].id, null, "这一组的 id 应为 null");
  assert.deepEqual([...unionOfPages(groups)].sort((a, b) => a - b), allPages(NO_CHAPTER_MATCH), "全无章节丢页了");
});

test("T0 模型（chapters 为空数组）：平铺一组，不造假分组", () => {
  const ctx = loadApp({ require: ["computeCharSpans"] });
  const groups = groupsOf(ctx, NO_CHAPTERS);
  assert.equal(groups.length, 1, "chapters 为空时应当平铺成一组");
  assert.equal(groups[0].id, null, "平铺组的 id 应为 null");
  assert.deepEqual([...unionOfPages(groups)].sort((a, b) => a - b), allPages(NO_CHAPTERS), "平铺也丢页了");
});

// ── 渲染层：默认模式必须能点到每一页 ─────────────────────────────────────

test("T0 渲染（默认模式）：树上页行集合 == 全部页集合——29 页无归属不许消失", () => {
  const book = bookShape();
  const rendered = renderedPageNos({ tree: book, onlyTodo: false });
  assert.deepEqual([...new Set(rendered)].sort((a, b) => a - b), allPages(book),
    `默认模式（reviewTreeOnlyTodo=false）下树上的页集合与数据不一致：`
    + `缺 ${allPages(book).filter((no) => !rendered.includes(no)).length} 页，多 ${rendered.filter((no) => !allPages(book).includes(no)).length} 页`);
});

test("T0 渲染（过滤模式·防回归）：只看未完成 ⇒ 页行集合 == unacked>0 的页集合", () => {
  const book = bookShape();
  const rendered = renderedPageNos({ tree: book, onlyTodo: true });
  assert.deepEqual([...new Set(rendered)].sort((a, b) => a - b), unackedPages(book).sort((a, b) => a - b),
    "过滤模式（reviewTreeOnlyTodo=true）那支的行为变了——它本来就该列全所有 unacked>0 的页");
});

test("T0 渲染（回归·QA 真机）：当前页落在「未归章」组时，点回目行不许被下一帧复原", () => {
  // 回归成因（app.js:10000 附近）：判定用 `currentGroup.title &&`，而「未归章」组的 title 是「未归章」、
  // id 是 null ⇒ 当前页落在这一组时，每次 render 都满足 `!has(null)`，把展开集合清成 {null}。
  // 用户点回目行 → toggle 里改了集合 → 同一次 toggle 末尾的 render 又把它清掉 ⇒ 树点不动。
  // 修法是加 `currentGroup.id !== null`：只有真章节才强制展开。
  const book = bookShape();
  const orphanPageNo = book.pages.find((page) => page.chapter === null).page_no;
  const { ctx, list } = treeEnv(book);
  runInApp(ctx, `
    reviewTreeOnlyTodo = false;
    reviewTreeExpandedChapters.clear();
    detailPageNo = ${orphanPageNo};
    renderReviewTree();                 // 第一帧：当前页在「未归章」组
    toggleReviewTreeChapter("c2");      // 用户点第 3 回（这个函数末尾自己会再 render 一次）
  `);

  const expanded = runInApp(ctx, "[...reviewTreeExpandedChapters]");
  assert.ok(expanded.includes("c2"),
    `点完回目行的下一帧，展开集合被复原成 ${JSON.stringify(expanded)}——`
    + "当前页在「未归章」组时每一帧都把集合清成 {null}，用户点的章立刻折叠（树点不动）");

  const c2Pages = book.pages.filter((page) => page.chapter === "c2").map((page) => page.page_no);
  const shown = pageRows(list);
  const missing = c2Pages.filter((pageNo) => !shown.includes(pageNo));
  assert.deepEqual(missing, [],
    `点了第 3 回，它的 ${missing.length} 个页行没出现在树上——展开集合保住了，渲染却没跟上`);
});
