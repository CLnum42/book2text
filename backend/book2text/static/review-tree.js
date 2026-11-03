/**
 * 审校左栏目录树（片 4）—— `window.ReviewTree`
 *
 * ## 宿主（第四个 owner：TREE）
 *
 * `root = #review-tree`，子树 6 个 id 全归本模块：
 * `review-tree` / `-rail` / `-stats` / `-filter` / `-scroll` / `-list`。
 * 模块只在自己的子树里查（`part()` = `root.querySelector`），不按 id 碰别人的节点；
 * 唯一的外来写点是错误条，走注入 `showPageDetailError`（写 `#page-detail-error` 的那一个动作归 editor）。
 *
 * ## 状态（9 个，全归本模块）
 *
 * reviewTree · reviewTreeProjectId · reviewTreeLoading · reviewTreeExpandedChapters ·
 * reviewTreeExpandedPage · reviewTreeItems · reviewTreePageRows · reviewTreeChapterRows ·
 * reviewTreeItemRows · reviewTreeOnlyTodo（另加常量 TREE_DIFF_LEVELS）。
 * 外壳经 `getReviewTreeItems()` / `getReviewTreeOnlyTodo()` / `setReviewTreeOnlyTodo()` 读写。
 *
 * ## 写盘
 *
 * `ensureReviewTree()` 一条 GET `/review/tree`；条目明细仍走调用方（pages/{n}/blocks）。
 * 埋点 `window.__b2tTreeMetrics`（R6 已登记，字段名不许动）。
 */

(function () {
  "use strict";

  let injected = {};
  let root = null;

  const part = (id) => (root ? root.querySelector(`#${id}`) : null);

let reviewTree = null;
let reviewTreeProjectId = null;
let reviewTreeLoading = false;
let reviewTreeOnlyTodo = false;
let reviewTreeExpandedChapters = new Set();
let reviewTreeExpandedPage = null;
let reviewTreeItems = new Map(); // pageNo -> [item]
let reviewTreePageRows = new Map(); // pageNo -> {row, count, state, page}
let reviewTreeChapterRows = new Map(); // chapterId -> {count, li}
let reviewTreeItemRows = new Map(); // `${blockId}:${lineIndex}` -> {row, dot, item}
const TREE_DIFF_LEVELS = new Set(["differs_chars", "differs_punct", "no_candidate"]);

async function ensureReviewTree() {
  if (!injected.getCurrentProject()) return;
  if (reviewTree && reviewTreeProjectId === injected.getCurrentProject().project_id) {
    syncReviewTreeToPage(injected.getDetailPageNo(), { scroll: false });
    return;
  }
  if (reviewTreeLoading) return;
  reviewTreeLoading = true;
  const t0 = performance.now();
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/review/tree`
    );
    reviewTree = data;
    reviewTreeProjectId = injected.getCurrentProject().project_id;
    reviewTreeItems.clear();
    reviewTreePageRows.clear();
    reviewTreeChapterRows.clear();
    reviewTreeItemRows.clear();
    reviewTreeExpandedChapters.clear();
    reviewTreeExpandedPage = null;
    const fetchMs = performance.now() - t0;
    const b0 = performance.now();
    renderReviewTree();
    window.__b2tTreeMetrics = {
      fetchMs: Math.round(fetchMs),
      buildMs: Math.round(performance.now() - b0),
      pages: (data.pages || []).length,
      chapters: (data.chapters || []).length,
    };
  } catch (error) {
    injected.showPageDetailError(error);
  } finally {
    reviewTreeLoading = false;
  }
}

function treeItemsFromBlocks(blocks) {
  const items = [];
  (blocks || []).forEach((block, blockIndex) => {
    const divergence = divergenceOf(block);
    if (divergence.stale) return;
    if (!injected.blockCountedInMargin(block, null)) return;
    for (const mark of divergence.marks || []) {
      if (!TREE_DIFF_LEVELS.has(mark.level)) continue;
      const line = (block.lines || [])[mark.line_index];
      items.push({
        blockId: block.block_id,
        blockIndex,
        lineIndex: mark.line_index,
        level: mark.level,
        ack: mark.ack || null,
        current: String(mark.current || ""),
        candidate: String(mark.candidate || ""),
        lineText: String((line && line.text) || mark.current || ""),
      });
    }
  });
  return items;
}

async function loadReviewTreeItems(pageNo) {
  if (reviewTreeItems.has(pageNo)) return;
  // 当前页正在打开时 injected.getReviewBlocks() 可能还是上一页的：只认块自己也属于这一页的数据
  const blocks = injected.getReviewBlocks() || [];
  if (
    pageNo === injected.getDetailPageNo() &&
    blocks.length &&
    blocks.every((block) => block.page_no === pageNo)
  ) {
    reviewTreeItems.set(pageNo, treeItemsFromBlocks(blocks));
    return;
  }
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/${pageNo}/blocks`
    );
    reviewTreeItems.set(pageNo, treeItemsFromBlocks(data.blocks));
  } catch {
    reviewTreeItems.set(pageNo, []);
  }
}

/** 条目摘要：只取差异片段两侧各 3 字（文本层面，不碰坐标）。 */
function treeItemSummary(item) {
  const a = String(item.current || "");
  const b = String(item.candidate || "");
  const spans = computeCharSpans(a, b).filter(
    (span) => span.aEnd > span.aStart || span.bEnd > span.bStart
  );
  if (!spans.length) return injected.truncate(item.lineText || a, 22);
  const span = spans[0];
  const prefix = a.slice(Math.max(0, span.aStart - 3), span.aStart);
  const suffix = a.slice(span.aEnd, span.aEnd + 3);
  const left = a.slice(span.aStart, span.aEnd) || "∅";
  const right = b.slice(span.bStart, span.bEnd) || "∅";
  return `${span.aStart > 3 ? "…" : ""}${prefix}${left}→${right}${suffix}${
    span.aEnd < a.length - 3 ? "…" : ""
  }`;
}

function treeLevelLabel(level) {
  if (level === "differs_chars") return "汉";
  if (level === "differs_punct") return "标";
  return "?";
}

/**
 * 审校左树的分组（纯函数）：默认模式按章分组，没有章归属的页放末尾「未归章」。
 * 修前这些页根本不进树（永远点不到），而头部「N 处待审」算着它们——见计划书 §8 T0。
 * · chapters 空 → 一组平铺（id / title 皆 null）
 * · 否则：每个有页的章一组（空章跳过），末尾「未归章」一组（page.chapter 不在 chapters 里）
 */
function reviewTreeGroups(pages, chapters) {
  const pageList = pages || [];
  const chapterList = chapters || [];
  if (!chapterList.length) return [{ id: null, title: null, pages: pageList.slice() }];
  const known = new Set(chapterList.map((chapter) => chapter.id));
  const groups = [];
  for (const chapter of chapterList) {
    const chapterPages = pageList.filter((page) => page.chapter === chapter.id);
    if (chapterPages.length) groups.push({ id: chapter.id, title: chapter.title, pages: chapterPages });
  }
  const orphans = pageList.filter((page) => !known.has(page.chapter));
  if (orphans.length) groups.push({ id: null, title: "未归章", pages: orphans });
  return groups;
}

function renderReviewTree() {
  const list = part("review-tree-list");
  if (!list || !reviewTree) return;
  list.innerHTML = "";
  reviewTreePageRows.clear();
  reviewTreeChapterRows.clear();
  reviewTreeItemRows.clear();
  const pages = reviewTree.pages || [];
  const chapters = reviewTree.chapters || [];
  const byNo = new Map(pages.map((page) => [page.page_no, page]));
  const groups = reviewTreeOnlyTodo ? [] : reviewTreeGroups(pages, chapters);
  const currentNo = injected.getDetailPageNo();
  const currentGroup = groups.find((group) =>
    group.pages.some((page) => page.page_no === currentNo)
  );
  if (currentGroup && currentGroup.id !== null && !reviewTreeOnlyTodo) {
    // 默认只展开当前页所在的那一章；翻页时旧章自动折叠。
    // 「未归章」组不参与这条自动展开（id 为 null）：它一参与，每次 render 都会把展开集合清成
    // {null}，用户点任何回目都活不过一帧（QA 2026-11-02 真机复验的回归）。
    if (!reviewTreeExpandedChapters.has(currentGroup.id)) {
      reviewTreeExpandedChapters.clear();
      reviewTreeExpandedChapters.add(currentGroup.id);
    }
  }
  const totalUnacked = pages.reduce((sum, page) => sum + page.unacked, 0);
  part("review-tree-stats").textContent = `${totalUnacked} 处待审`;

  const appendPage = (page, parent) => {
    const li = document.createElement("li");
    li.className = "review-tree__page";
    const row = document.createElement("div");
    row.className = "review-tree__row review-tree__row--page";
    if (page.page_no === currentNo) row.classList.add("is-current");
    row.title = `第 ${page.page_no} 页 · ${page.unacked} 处待审`;
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "review-tree__caret";
    caret.textContent = reviewTreeExpandedPage === page.page_no ? "▾" : "▸";
    if (page.unacked + page.acked === 0) caret.classList.add("is-empty");
    caret.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleReviewTreePage(page.page_no);
    });
    const pageNo = document.createElement("span");
    pageNo.className = "tree-page-no";
    pageNo.textContent = `第 ${page.page_no} 页`;
    const state = document.createElement("span");
    state.className = "tree-state";
    const count = document.createElement("span");
    count.className = "tree-count";
    if (page.unacked > 0) {
      count.textContent = `${page.unacked} 处`;
    } else if (page.acked > 0) {
      count.textContent = "✓";
      count.classList.add("is-done");
    }
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    row.append(caret, pageNo, spacer, state, count);
    row.addEventListener("click", () => {
      injected.openPageDetail(page.page_no);
    });
    li.append(row);
    reviewTreePageRows.set(page.page_no, { row, count, state, page });

    if (reviewTreeExpandedPage === page.page_no) {
      const cached = reviewTreeItems.get(page.page_no);
      if (!cached) {
        const loading = document.createElement("div");
        loading.className = "review-tree__empty";
        loading.textContent = "正在加载条目…";
        li.append(loading);
        loadReviewTreeItems(page.page_no).then(() => {
          if (reviewTreeExpandedPage === page.page_no) renderReviewTree();
        });
        return li;
      }
      const itemsOl = document.createElement("ol");
      itemsOl.className = "review-tree__items";
      for (const item of cached) {
        const itemLi = document.createElement("li");
        const itemRow = document.createElement("div");
        itemRow.className = "review-tree__row review-tree__row--item";
        if (
          injected.getActiveDiff() &&
          injected.getActiveDiff().blockId === item.blockId &&
          injected.getActiveDiff().lineIndex === item.lineIndex
        ) {
          itemRow.classList.add("is-current");
        }
        if (item.ack) itemRow.classList.add("is-done");
        const dot = document.createElement("span");
        dot.className = "tree-dot";
        if (item.ack) dot.classList.add("is-done");
        if (
          injected.getActiveDiff() &&
          injected.getActiveDiff().blockId === item.blockId &&
          injected.getActiveDiff().lineIndex === item.lineIndex
        ) {
          dot.classList.add("is-current");
        }
        const lineNo = document.createElement("span");
        lineNo.className = "tree-line";
        lineNo.textContent = `L${item.lineIndex + 1}`;
        const level = document.createElement("span");
        level.className = "tree-level";
        level.textContent = treeLevelLabel(item.level);
        const summary = document.createElement("span");
        summary.className = "tree-summary";
        summary.textContent = treeItemSummary(item);
        if (item.ack === "kept") summary.textContent += " ✓已保留";
        itemRow.append(dot, lineNo, level, summary);
        itemRow.title = `${item.lineText}\n原：${item.current}\n候选：${item.candidate}`;
        itemRow.addEventListener("click", () => openTreeItem(page.page_no, item));
        itemLi.append(itemRow);
        itemsOl.append(itemLi);
        reviewTreeItemRows.set(`${item.blockId}:${item.lineIndex}`, {
          row: itemRow,
          dot,
          item,
          pageNo: page.page_no,
        });
      }
      if (!cached.length) {
        const empty = document.createElement("div");
        empty.className = "review-tree__empty";
        empty.textContent = "这一页没有可处理的差异";
        itemsOl.append(empty);
      }
      li.append(itemsOl);
    }
    return li;
  };

  if (reviewTreeOnlyTodo) {
    const todo = pages.filter((page) => page.unacked > 0);
    if (!todo.length) {
      const empty = document.createElement("li");
      empty.className = "review-tree__empty";
      empty.textContent = "全部页都没有待处理的差异了。";
      list.append(empty);
    }
    for (const page of todo) list.append(appendPage(page, list));
  } else {
    for (const group of groups) {
      if (!group.pages.length) continue;
      if (!group.title) {
        // chapters 空：平铺，没有章头
        for (const page of group.pages) list.append(appendPage(page, list));
        continue;
      }
      const remaining = group.pages.reduce((sum, page) => sum + page.unacked, 0);
      const li = document.createElement("li");
      li.className = "review-tree__chapter";
      const row = document.createElement("div");
      row.className = "review-tree__row review-tree__row--chapter";
      const caret = document.createElement("span");
      caret.className = "caret";
      caret.textContent = reviewTreeExpandedChapters.has(group.id) ? "▾" : "▸";
      const title = document.createElement("span");
      title.className = "tree-title";
      title.textContent = group.title;
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      const count = document.createElement("span");
      count.className = "tree-count";
      if (remaining > 0) {
        count.textContent = `${remaining} 处`;
      } else {
        count.textContent = "✓ 完成";
        count.classList.add("is-done");
      }
      row.append(caret, title, spacer, count);
      row.addEventListener("click", () => toggleReviewTreeChapter(group.id));
      li.append(row);
      if (reviewTreeExpandedChapters.has(group.id)) {
        for (const page of group.pages) li.append(appendPage(page, li));
      }
      list.append(li);
      reviewTreeChapterRows.set(group.id, {
        count,
        li,
        chapter: chapters.find((chapter) => chapter.id === group.id) || null,
      });
    }
  }
  syncReviewTreeToPage(currentNo, { scroll: true });
}

function toggleReviewTreeChapter(chapterId) {
  if (reviewTreeExpandedChapters.has(chapterId)) {
    reviewTreeExpandedChapters.delete(chapterId);
  } else {
    reviewTreeExpandedChapters.clear();
    reviewTreeExpandedChapters.add(chapterId);
  }
  renderReviewTree();
}

function toggleReviewTreePage(pageNo) {
  if (reviewTreeExpandedPage === pageNo) {
    reviewTreeExpandedPage = null;
  } else {
    reviewTreeExpandedPage = pageNo;
  }
  renderReviewTree();
}

function setReviewTreeOnlyTodo(only) {
  reviewTreeOnlyTodo = Boolean(only);
  part("review-tree-filter").textContent = reviewTreeOnlyTodo
    ? "显示全部页"
    : "只看未完成";
  part("review-tree-filter").classList.toggle("is-on", reviewTreeOnlyTodo);
  renderReviewTree();
}

/** 当前页 / 当前条目在树里定位：展开 + 高亮 + 滚到约 40%。 */
function syncReviewTreeToPage(pageNo, { scroll = false } = {}) {
  if (!reviewTree || !pageNo) return;
  const group = reviewTreeGroups(reviewTree.pages || [], reviewTree.chapters || []).find((item) =>
    item.pages.some((page) => page.page_no === pageNo)
  );
  if (group && group.id !== null && !reviewTreeExpandedChapters.has(group.id) && !reviewTreeOnlyTodo) {
    reviewTreeExpandedChapters.clear();
    reviewTreeExpandedChapters.add(group.id);
    renderReviewTree();
    return;
  }
  if (reviewTreeExpandedPage !== pageNo && !reviewTreeOnlyTodo) {
    reviewTreeExpandedPage = pageNo;
    renderReviewTree();
    return;
  }
  const pageRow = reviewTreePageRows.get(pageNo);
  for (const [, entry] of reviewTreePageRows) {
    entry.row.classList.toggle("is-current", entry.page.page_no === pageNo);
  }
  const activeKey = injected.getActiveDiff() ? `${injected.getActiveDiff().blockId}:${injected.getActiveDiff().lineIndex}` : null;
  const activeRow = activeKey ? reviewTreeItemRows.get(activeKey) : null;
  const firstUnacked = [...reviewTreeItemRows.values()].find(
    (entry) => entry.pageNo === pageNo && !entry.item.ack
  );
  const target = activeRow || firstUnacked;
  for (const [, entry] of reviewTreeItemRows) {
    const isCurrent =
      injected.getActiveDiff() &&
      entry.item.blockId === injected.getActiveDiff().blockId &&
      entry.item.lineIndex === injected.getActiveDiff().lineIndex;
    entry.row.classList.toggle("is-current", Boolean(isCurrent));
    entry.dot.classList.toggle("is-current", Boolean(isCurrent));
  }
  if (scroll) {
    const scroller = part("review-tree-scroll");
    const anchor = target ? target.row : pageRow ? pageRow.row : null;
    if (scroller && anchor) {
      const top = anchor.offsetTop - scroller.clientHeight * 0.4;
      scroller.scrollTop = Math.max(0, top);
    }
  }
}

async function openTreeItem(pageNo, item) {
  if (injected.getDetailPageNo() !== pageNo) {
    await injected.openPageDetail(pageNo);
  }
  // 清洗刀：页内差异队列删掉之后，条目定位直接靠块内差异条（activateDiff）
  activateDiff(item.blockId, item.lineIndex, 0);
  syncReviewTreeToPage(pageNo, { scroll: true });
}

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || (injected.getRootEl ? injected.getRootEl() : null);
    return api;
  }

  const api = {
    init,
    ensureReviewTree,
    treeItemsFromBlocks,
    syncReviewTreeToPage,
    setReviewTreeOnlyTodo,
    getReviewTreeItems: () => reviewTreeItems,
    getReviewTreeOnlyTodo: () => reviewTreeOnlyTodo,
  };
  window.ReviewTree = api;
})();
