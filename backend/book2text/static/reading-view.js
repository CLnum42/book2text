/**
 * 审校视图模块（任务 94 · Slice 1）
 *
 * **经典脚本，不是 ES module**：`<script src="/static/reading-view.js">` 在 app.js 之前加载，
 * 靠 `window.ReadingView` 对外暴露。`type="module"` 默认 deferred，会改 boot 时序——
 * 这个仓库一半 bug 是时序问题，重构第一刀不动它。
 *
 * Slice 1 只搬"真正独立"的部分：三栏宽度与偏好、视图进入/退出外壳。
 * `readingData` / `readingProject` 被块内引用 18/7 次，单独搬声明会断引用，
 * 它们跟正文流渲染一起在 Slice 2 搬。
 */
(function () {
  "use strict";

  let injected = { el: null, storage: null };

  function el(id) {
    return injected.el ? injected.el(id) : document.getElementById(id);
  }

  function storage() {
    return injected.storage || window.localStorage;
  }

const READING_SPLIT_KEY = "b2t.readingSplit.v1";
const READING_SPLIT_DEFAULT = { tree: 232, pdf: 420 };
const READING_SPLIT_MIN = { tree: 150, pdf: 240, stream: 360 };
const READING_GRIP_TOTAL = 12;

let readingSplitState = null;

function readingSplitPrefs() {
  if (readingSplitState) return readingSplitState;
  let stored = null;
  try {
    stored = JSON.parse(storage().getItem(READING_SPLIT_KEY) || "null");
  } catch {
    stored = null;
  }
  readingSplitState = {
    tree: Number.isFinite(stored && stored.tree)
      ? Number(stored.tree)
      : READING_SPLIT_DEFAULT.tree,
    pdf: Number.isFinite(stored && stored.pdf)
      ? Number(stored.pdf)
      : READING_SPLIT_DEFAULT.pdf,
  };
  return readingSplitState;
}

function clampNumber(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** 把当前宽度写进 CSS 变量；窗口太窄时**只收显示值**，不改用户记住的宽度。 */
function applyReadingSplit() {
  const split = el("reading-split");
  if (!split) return;
  // 窄屏（<1120）是 CSS 的紧凑布局（树 44px、PDF 收起）：内联变量会盖过媒体查询，
  // 所以这时清掉内联值，把宽度交回样式表；宽屏再按用户拖的值铺开。
  if (window.innerWidth < 1120) {
    split.style.removeProperty("--reading-tree-w");
    split.style.removeProperty("--reading-pdf-w");
    return;
  }
  const prefs = readingSplitPrefs();
  let tree = prefs.tree;
  let pdf = prefs.pdf;
  const total = split.clientWidth
    ? split.clientWidth - READING_GRIP_TOTAL
    : 0;
  if (total > 0) {
    tree = clampNumber(tree, READING_SPLIT_MIN.tree, total - pdf - READING_SPLIT_MIN.stream);
    pdf = clampNumber(pdf, READING_SPLIT_MIN.pdf, total - tree - READING_SPLIT_MIN.stream);
  }
  split.style.setProperty("--reading-tree-w", `${Math.round(tree)}px`);
  split.style.setProperty("--reading-pdf-w", `${Math.round(pdf)}px`);
}

function saveReadingSplit() {
  try {
    storage().setItem(
      READING_SPLIT_KEY,
      JSON.stringify({ tree: Math.round(readingSplitPrefs().tree), pdf: Math.round(readingSplitPrefs().pdf) })
    );
  } catch {
    // 存不进去（隐私模式 / 配额满）不影响当前这次拖动
  }
}

function resetReadingSplit() {
  readingSplitState = { ...READING_SPLIT_DEFAULT };
  try {
    storage().removeItem(READING_SPLIT_KEY);
  } catch {
    // 忽略
  }
  applyReadingSplit();
}

/** 拖一条手柄：两种拖动各自只改自己那一栏，另一栏保持不动。 */
function setupReadingSplit() {
  const split = el("reading-split");
  if (!split || split.dataset.splitBound === "1") return;   // 幂等：init 多次也只绑一次
  split.dataset.splitBound = "1";
  const grips = [
    { node: el("reading-grip-tree"), key: "tree" },
    { node: el("reading-grip-pdf"), key: "pdf" },
  ];
  for (const grip of grips) {
    const node = grip.node;
    if (!node) continue;
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const start = readingSplitPrefs()[grip.key];
      node.setPointerCapture(event.pointerId);
      node.classList.add("is-active");
      document.body.classList.add("is-resizing-reading");
      const move = (moved) => {
        const prefs = readingSplitPrefs();
        const width = split.clientWidth - READING_GRIP_TOTAL;
        // 另一栏当前**生效**的宽度也按同样规则取，避免两栏一起越界
        const otherKey = grip.key === "tree" ? "pdf" : "tree";
        const other = clampNumber(
          prefs[otherKey],
          READING_SPLIT_MIN[otherKey],
          width - READING_SPLIT_MIN[otherKey] - READING_SPLIT_MIN.stream
        );
        const max = width - other - READING_SPLIT_MIN.stream;
        prefs[grip.key] = clampNumber(
          start + (moved.clientX - startX),
          READING_SPLIT_MIN[grip.key],
          max
        );
        applyReadingSplit();
      };
      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        node.classList.remove("is-active");
        document.body.classList.remove("is-resizing-reading");
        saveReadingSplit();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });
    // 双击回默认：拖歪了不用去清 localStorage
    node.addEventListener("dblclick", resetReadingSplit);
  }
  // R1（Architect 边界规则）：本文件在 app.js **之前**加载，不许出现 app.js 顶层符号。
  // 这里原来直接读 `currentView` / `readingPageNo`、调 `measureReadingTops()` /
  // `updateReadingPage()`——能跑只因为回调晚于 boot 触发，属于靠运气的时序。
  // 改成注入回调，由外壳决定视口变化时做什么。
  window.addEventListener("resize", () => {
    applyReadingSplit();
    injected.onViewportResize?.();
  });
}
  // ---------------------------------------------------------------- 对外接口

  function init(deps) {
    injected = { ...injected, ...(deps || {}) };
    setupReadingSplit();
  }

  function enter(projectId) {
    injected.enter?.(projectId);
  }

  function exit() {
    injected.exit?.();
  }

  function getCurrent() {
    return {
      projectId: injected.getProjectId ? injected.getProjectId() : null,
      pageNo: injected.getPageNo ? injected.getPageNo() : null,
    };
  }

  function toggleFollow() {
    injected.toggleFollow?.();
  }

  /** 正文流/标记需要按当前设置重建时由外壳触发（Architect 接口第 5 个）。 */
  function reload() {
    injected.reload?.();
  }

  window.ReadingView = {
    init,
    enter,
    exit,
    getCurrent,
    toggleFollow,
    reload,
    // 偏好与布局（app.js 仍通过薄转发调用，Slice 2 再彻底收进去）
    splitPrefs: readingSplitPrefs,
    applySplit: applyReadingSplit,
    saveSplit: saveReadingSplit,
    resetSplit: resetReadingSplit,
    setupSplit: setupReadingSplit,
  };
})();
