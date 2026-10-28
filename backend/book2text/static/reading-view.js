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

  // ---------------------------------------------------------------- 审校外壳（任务 94 · Slice 2）
  // 从 app.js 原样搬入；依赖全部由 init() 注入，模块本身不碰 app.js 的顶层符号。

function setupReading() {
  el("reading-next-unreviewed").addEventListener("click", injected.gotoNextUnreviewed);
  const closeReadingMenus = () => {
    el("reading-display-menu").hidden = true;
    el("reading-more-menu").hidden = true;
  };
  el("reading-display-open").addEventListener("click", (event) => {
    event.stopPropagation();
    const hidden = el("reading-display-menu").hidden;
    closeReadingMenus();
    el("reading-display-menu").hidden = !hidden;
  });
  el("reading-more-open").addEventListener("click", (event) => {
    event.stopPropagation();
    const hidden = el("reading-more-menu").hidden;
    closeReadingMenus();
    el("reading-more-menu").hidden = !hidden;
  });
  el("reading-pending-toggle").addEventListener("change", (event) => {
    injected.setPendingOn?.(event.target.checked);
    el("view-reading").classList.toggle("hide-pending", !injected.getPendingOn());
  });
  el("reading-follow-toggle").addEventListener("change", (event) => {
    injected.setReadingFollow?.(event.target.checked);
  });
  for (const radio of document.querySelectorAll('input[name="reading-markup"]')) {
    radio.addEventListener("change", (event) => {
      injected.setMarkupLevel?.(event.target.value);
      injected.renderReading?.({ reset: true });
    });
  }
  el("reading-discard-all").addEventListener("click", () => {
    const count = injected.getInlineEdits().size + injected.getDrafts().size;
    if (!count) return;
    if (!window.confirm(`放弃全部 ${count} 处未提交改动？（不可恢复）`)) return;
    injected.getInlineEdits().clear();
    injected.saveReadingInlineEdits?.();
    injected.getDrafts().clear();
    injected.saveReadingDrafts?.();
    injected.renderReading?.({ reset: true });
    injected.renderReadingProgress?.();
  });
  el("reading-help").addEventListener("click", () => {
    window.alert(
      "审校快捷键\n\n" +
        "↵  浏览态：下一处未审；编辑态：段内换行\n" +
        "⌥↵ 编辑态：收草稿并跳下一处\n" +
        "Esc 退出编辑 / 关面板\n" +
        "⌘Z 编辑中：字级撤销\n\n" +
        "中文按字标差异，英文按词标（引擎给的就是词框）。"
    );
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest || !event.target.closest(".rt-menu-wrap")) closeReadingMenus();
  });
  el("reading-submit").addEventListener("click", injected.submitReadingDrafts);
  el("reading-undo").addEventListener("click", injected.undoReadingSubmit);
  el("reading-prev").addEventListener("click", () => injected.stepReadingPage?.(-1));
  el("reading-next").addEventListener("click", () => injected.stepReadingPage?.(1));
  el("reading-filter").addEventListener("change", (event) =>
    injected.setReadingFilter?.(event.target.value)
  );
  // 任务 66：「跟随 / 成稿」不再是按钮，分别进了「显示 ▾」的勾选与「待审红字」
  el("reading-follow-toggle")?.addEventListener("change", (event) => {
    injected.setReadingFollow?.(event.target.checked);
  });
  el("reading-blindspot").addEventListener("click", () => {
    // C1 盲区出口：两路一致但可疑的行，去单页审校里逐行看
    injected.showView?.("review");
    injected.openPageDetail?.(injected.getPageNo());
  });
  el("reading-stream").addEventListener("scroll", injected.onReadingScroll, { passive: true });
  el("reading-pdf-scroll").addEventListener("scroll", injected.onReadingPdfScroll, { passive: true });
  // 悬停段落：右栏绿底 + 左边对应块绿框（只高亮，不滚）
  el("reading-stream").addEventListener("mouseover", (event) => {
    const seg = event.target.closest && event.target.closest(".reading-seg");
    injected.setReadingHover?.(seg ? seg.dataset.seq : null);
  });
  // 任务 82：用户"自己动过"只认真实输入事件（程序滚动不算），用于异步收尾时别抢用户的滚动位置
  for (const id of ["reading-pdf-scroll", "reading-stream", "reading-tree"]) {
    const node = el(id);
    if (!node) continue;
    node.addEventListener("wheel", injected.markReadingUserMoved, { passive: true });
    node.addEventListener("pointerdown", injected.markReadingUserMoved, { passive: true });
    node.addEventListener("keydown", injected.markReadingUserMoved);
  }
  el("reading-stream").addEventListener("mouseleave", () => injected.setReadingHover?.(null));
  // 任务 76：**反向联动**——鼠标悬停左边 PDF 上的某个块，右侧对应段落亮起来。
  // 和"右→左"用同一套类名（`is-linked` / `is-hover`）、同一颜色，用户能看出是一条。
  el("reading-pages").addEventListener("mouseover", (event) => {
    const box = event.target.closest && event.target.closest(".box");
    if (!box || !box.dataset.blockId) return;
    injected.setReadingHoverByBlock?.(box.dataset.blockId);
  });
  el("reading-pages").addEventListener("mouseleave", () => injected.setReadingHover?.(null));
  // 从块移到块外的空白：pointerout 里判断"相关目标已经不在任何块里"就清，
  // 否则空白区域没有 mouseleave 可等，高亮会一直留着。
  el("reading-pages").addEventListener("pointerout", (event) => {
    const to = event.relatedTarget;
    if (to && to.closest && to.closest("#reading-pages .box")) return;
    if (to && to.closest && to.closest("#reading-pages")) return;
    injected.setReadingHover?.(null);
  });
  el("reading-stream").addEventListener("click", (event) => {
    const markEl = event.target.closest && event.target.closest(".reading-mark");
    if (!markEl) return;
    const mark = injected.getMarks().get(markEl.dataset.key);
    if (mark) injected.openReadingPanel?.(mark);
  });
  // 任务 66：点正文 = 落光标；点标记 = 开候选面板（标记优先，光标不落）
  el("reading-stream").addEventListener("click", (event) => {
    if (!injected.isReadingActive()) return;
    const target = event.target;
    if (target.closest && target.closest(".reading-mark")) return;
    const fold = target.closest && target.closest(".reading-fold");
    if (fold) {
      const line = fold.closest(".reading-line");
      if (line) {
        line.dataset.expanded = line.dataset.expanded === "1" ? "0" : "1";
        injected.rerenderReadingLine?.(line.dataset.key);
      }
      return;
    }
    const line = target.closest && target.closest(".reading-line");
    if (!line) return;
    if (event.detail > 1) return;   // 双击 = 原生选词
    injected.startInlineEdit?.(line);
  });
  document.addEventListener("keydown", (event) => {
    if (!injected.isReadingActive()) return;
    if (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    if (injected.getReadingEditingKey()) {
      if (event.key === "Escape") {
        event.preventDefault();
        injected.exitInlineEdit?.();
      } else if (event.key === "Enter" && (event.altKey || event.metaKey)) {
        event.preventDefault();
        injected.exitInlineEdit?.();
        injected.gotoNextUnreviewed?.();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      injected.gotoNextUnreviewed?.();
    } else if (event.key === "Escape") {
      injected.closeReadingPanel?.();
    }
  });
}

/**
 * 标点 / 乱码批次裁决后整条流重开（§4 第 3 组）。
 *
 * **归属在审校，不在标点**：这个函数原来长在标点代码段里，直接写 `readingProject` /
 * `readingData` / `readingMarks`——两个模块各写一份审校状态，正是"重绘互相吃掉"的根。
 * 现在它和 `openReading()` 放在一起；外部只调 `ReadingView.reload()`。
 */
async function readingReloadAfterBatch() {
  injected.setReadingProject?.(null);
  injected.setReadingData?.(null);
  injected.setMarks?.(new Map());
  await injected.openReading?.();
  injected.renderPunctGroupBadge?.();
}

  // ---------------------------------------------------------------- 对外接口

  /** 绑 #view-reading 里归审校的控件（§4 第 2 组）：原来由 page-index / 标点 / 乱码三处代码持有。 */
  function bindViewControls() {
    const follow = el("reading-follow-chip");
    if (follow && follow.dataset.rvBound !== "1") {
      follow.dataset.rvBound = "1";
      follow.addEventListener("click", () => injected.toggleFollow?.());
    }
    const punct = el("reading-punct-open");
    if (punct && punct.dataset.rvBound !== "1") {
      punct.dataset.rvBound = "1";
      punct.addEventListener("click", () => injected.onPunctGroups?.());
    }
    const garbled = el("reading-garbled-open");
    if (garbled && garbled.dataset.rvBound !== "1") {
      garbled.dataset.rvBound = "1";
      garbled.addEventListener("click", () => injected.onGarbledPanel?.());
    }
  }

  function init(deps) {
    injected = { ...injected, ...(deps || {}) };
    setupReadingSplit();
    setupReading();
    bindViewControls();
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
  async function reload() {
    await readingReloadAfterBatch();
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
