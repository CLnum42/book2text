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
    setReadingFollow(event.target.checked);
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
  el("reading-submit").addEventListener("click", submitReadingDrafts);
  el("reading-undo").addEventListener("click", undoReadingSubmit);
  el("reading-prev").addEventListener("click", () => stepReadingPage(-1));
  el("reading-next").addEventListener("click", () => stepReadingPage(1));
  el("reading-filter").addEventListener("change", (event) =>
    setReadingFilter(event.target.value)
  );
  // 任务 66：「跟随 / 成稿」不再是按钮，分别进了「显示 ▾」的勾选与「待审红字」
  el("reading-follow-toggle")?.addEventListener("change", (event) => {
    setReadingFollow(event.target.checked);
  });
  el("reading-blindspot").addEventListener("click", () => {
    // C1 盲区出口：两路一致但可疑的行，去单页审校里逐行看
    injected.showView?.("review");
    injected.openPageDetail?.(injected.getPageNo());
  });
  el("reading-stream").addEventListener("scroll", onReadingScroll, { passive: true });
  el("reading-pdf-scroll").addEventListener("scroll", onReadingPdfScroll, { passive: true });
  // 悬停段落：右栏绿底 + 左边对应块绿框（只高亮，不滚）
  el("reading-stream").addEventListener("mouseover", (event) => {
    const seg = event.target.closest && event.target.closest(".reading-seg");
    injected.setReadingHover?.(seg ? seg.dataset.seq : null);
  });
  // 任务 82：用户"自己动过"只认真实输入事件（程序滚动不算），用于异步收尾时别抢用户的滚动位置
  for (const id of ["reading-pdf-scroll", "reading-stream", "reading-tree"]) {
    const node = el(id);
    if (!node) continue;
    node.addEventListener("wheel", markReadingUserMoved, { passive: true });
    node.addEventListener("pointerdown", markReadingUserMoved, { passive: true });
    node.addEventListener("keydown", markReadingUserMoved);
  }
  el("reading-stream").addEventListener("mouseleave", () => injected.setReadingHover?.(null));
  // 任务 76：**反向联动**——鼠标悬停左边 PDF 上的某个块，右侧对应段落亮起来。
  // 和"右→左"用同一套类名（`is-linked` / `is-hover`）、同一颜色，用户能看出是一条。
  el("reading-pages").addEventListener("mouseover", (event) => {
    const box = event.target.closest && event.target.closest(".box");
    if (!box || !box.dataset.blockId) return;
    setReadingHoverByBlock(box.dataset.blockId);
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
    startInlineEdit(line);
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

  // ---------------------------------------------------------------- 审校交互（任务 94 · L2）
  // 从 app.js 原样搬入；依赖全部由 init() 注入，模块本身不碰 app.js 的顶层符号。

function markReadingUserMoved() {
  injected.setReadingUserMovedAt(performance.now());
  injected.setReadingUserScrollSeq(injected.getReadingUserScrollSeq() + 1);
}

function startInlineEdit(line) {
  if (!line || injected.getReadingEditingKey() === line.dataset.key) return;
  injected.exitInlineEdit?.();
  injected.setReadingEditingKey(line.dataset.key);
  line.classList.add("is-editing");
  line.classList.add("is-current");
  line.setAttribute("contenteditable", "plaintext-only");
  line.focus();
  const mark = injected.getMarks().get(line.dataset.key);
  const pageNo = mark && mark.page_no ? mark.page_no : Number(line.dataset.page);
  if (pageNo && pageNo !== injected.getPageNo()) {
    injected.updateReadingPage?.(pageNo, { syncStream: false });
  }
  // 任务 76：**编辑某一行时，左侧要能看出"改的是图上哪一行"**。
  // 有差异标记就用标记的行框；没有标记（普通正文行）就去块缓存里找这一行的框。
  const lineBox = (mark && mark.bbox) || injected.readingLineBox?.(line.dataset.block, Number(line.dataset.line));
  if (lineBox) {
    injected.drawReadingPdfBox?.(lineBox, pageNo);
    injected.drawEditingLineBox?.(lineBox, pageNo);
    injected.markEditingLineBox?.(line.dataset.block, Number(line.dataset.line));
  }
  line.addEventListener("input", injected.onInlineInput);
  line.addEventListener("keydown", injected.onInlineKeydown);
  line.addEventListener("blur", () => {
    // 失焦只收起编辑态，草稿留着
    if (injected.getReadingEditingKey() === line.dataset.key) injected.exitInlineEdit?.();
  });
}

function setReadingFilter(value) {
  injected.setReadingFilterValue(value);
  injected.renderReading?.({ reset: true });
}

/** 悬停右栏某段：右边绿底、左边这一段的所有块绿框——**只高亮，不滚**。 */
/**
 * 左边悬停某个块 → 右边对应段落亮（`is-hover`），左边的块本身也标 `is-linked`。
 *
 * 只高亮、不滚动：用户只是"看看这块是右边哪一段"。找不到对应段（跨页 / 已过滤）
 * 就什么都不做，别把别处点亮。
 */
function setReadingHoverByBlock(blockId) {
  const segments = injected.readingVisibleSegments?.();
  const index = segments.findIndex((segment) =>
    (segment.line_spans || []).some((span) => span.block_id === blockId)
  );
  if (index < 0) {
    injected.setReadingHover?.(null);
    return;
  }
  const segment = segments[index];
  if (injected.getReadingHoveredSeq() === Number(segment.seq)) return;
  injected.setReadingHoveredSeq(Number(segment.seq));
  // 先把**两边**上一条的清干净：只清右侧会让左边留下旧的绿块（用户说"离开没取消选中"）
  for (const node of document.querySelectorAll("#reading-stream .reading-seg.is-hover")) {
    node.classList.remove("is-hover");
  }
  for (const box of document.querySelectorAll("#reading-pages .box.is-linked")) {
    box.classList.remove("is-linked");
  }
  const node = document.querySelector(`#reading-stream .reading-seg[data-seq="${segment.seq}"]`);
  if (!node) return;
  node.classList.add("is-hover");
  // 左边这一段的所有块一起亮（同一段常跨块）
  const blockIds = new Set((segment.line_spans || []).map((span) => span.block_id));
  for (const tile of document.querySelectorAll("#reading-pages .box")) {
    if (blockIds.has(tile.dataset.blockId)) tile.classList.add("is-linked");
  }
}

function onReadingPdfScroll() {
  if (injected.getReadingPdfScrollRaf()) return;
  injected.setReadingPdfScrollRaf(requestAnimationFrame(() => {
    injected.setReadingPdfScrollRaf(0);
    if (!injected.isReadingActive()) return;
    // 任务 72：**跟随开着的时候左栏滚动才该带动右侧**。原来这里写着
    // `if (readingFollow) return;`——正好反了：用户开着"跟随"滚左栏，右边完全不动。
    injected.updateReadingPageFromLeftScroll?.();
    injected.verifyReadingPageSync?.("leftScroll");
  }));
}

function setReadingFollow(on) {
  injected.setReadingFollowFlag(Boolean(on));
  const toggle = el("reading-follow-toggle");
  if (toggle) toggle.checked = injected.getReadingFollow();
  // 工具条上的那个「跟随：开/关」要一直跟状态一致（两处都能点）
  const chip = el("reading-follow-chip");
  if (chip) {
    chip.textContent = injected.getReadingFollow() ? "跟随：开" : "跟随：关";
    chip.classList.toggle("is-on", injected.getReadingFollow());
    chip.setAttribute("aria-pressed", injected.getReadingFollow() ? "true" : "false");
  }
  if (!injected.getReadingFollow()) injected.hideReadingPdfBox?.();
}

function onReadingScroll() {
  if (!injected.getReadingFollow() || injected.getReadingScrollRaf()) return;
  injected.setReadingScrollRaf(requestAnimationFrame(() => {
    injected.setReadingScrollRaf(0);
    if (!injected.getReadingFollow() || !injected.isReadingActive()) return;
    // 任务 72：左栏正在驱动（350 ms 锁内）就整个跳过——
    // 否则左栏刚把正文跳到第 60 页，这里按"正文顶部那一行"又把页码改回第 1 页。
    if (injected.readingDriverActive?.("left")) return;
    const stream = el("reading-stream");
    if (!stream) return;
    const rect = stream.getBoundingClientRect();
    const anchor = rect.top + rect.height * 0.35;
    // 按行矩形找"视口 35% 处的那一行"：行是 inline span，elementFromPoint 会落在
    // 段落的行距空白上，拿不到行元素。
    let line = null;
    for (const item of stream.querySelectorAll(".reading-line")) {
      if (item.getBoundingClientRect().bottom >= anchor) {
        line = item;
        break;
      }
    }
    if (!line) return;
    const key = line.dataset.key;
    const mark = injected.getMarks().get(key);
    const pageNo = Number(line.dataset.page);
    // 任务 88：**只挡"跳转落位中"的那几次写入**。
    //
    // `jumpReadingTo` / `centerReadingLinePair` 把正文滚到目标行的过程中，视口顶行还停在
    // 上一页（实测：跳第 142 页时顶行属于 141），这时同步写页码就会把 142 改成 141。
    // 落位完成后标志清空，之后任何滚动（相邻页、跨页、往回滚）都照常跟随——
    // 不用页差阈值（`≤1` 会把"滚一整页"也挡掉），也不看行节点矩形（重绘换掉节点会把页码钉死）。
    window.__b2tPagePin = window.__b2tPagePin || { held: 0, escape: 0 };
    let allowPageWrite = true;
    if (injected.getReadingJumpSettleKey()) {
      const target = injected.getReadingPanelKey() ? injected.readingLineNode?.(injected.getReadingJumpSettleKey()) : null;
      if (!target) {
        // 行没了 / 面板关了：别再等
        injected.setReadingJumpSettleKey(null);
      } else {
        const tr = target.getBoundingClientRect();
        const settled = tr.bottom > rect.top && tr.top < rect.bottom;
        if (settled) {
          // **落位那一帧也不许写**：目标行刚进视口时，35% 锚点还落在上一页最后一行
          // （QA 实测：跳 142，锚点行 141，同一个 rAF 里清掉标志又写页码 → 142 变 141，
          //  +1.5s 仍是 141）。清标志与写页码必须分到两次滚动事件里，这次先不写。
          injected.setReadingJumpSettleKey(null);
          allowPageWrite = false;
          window.__b2tPagePin.held += 1;
        } else {
          injected.setReadingJumpSettleTicks(injected.getReadingJumpSettleTicks() + 1);
          allowPageWrite = false;
          window.__b2tPagePin.held += 1;
          // 保底：一直落不了位（补行失败之类）就放行——宁可跟错一次，不能把页码冻住
          if (injected.getReadingJumpSettleTicks() >= 12) {
            injected.setReadingJumpSettleKey(null);
            window.__b2tPagePin.escape += 1;
          }
        }
      }
    }
    // 面板项那一行还在视口里 → 页码以面板项为准（D-105）。文档末尾没法再往下滚，
    // 35% 锚点会常态性落在上一页最后一行（QA 实测 142 页落位后锚点是 141），
    // 只靠落位窗口挡不住之后的滚动事件。
    // **行节点取不到时放行（fail-open）**：早先那版取不到就挡，重绘换掉节点后页码被永久钉死。
    if (allowPageWrite && injected.getReadingPanelKey()) {
      const pinLine = injected.readingLineNode?.(injected.getReadingPanelKey());
      if (pinLine) {
        const pr = pinLine.getBoundingClientRect();
        if (pr.bottom > rect.top && pr.top < rect.bottom) {
          allowPageWrite = false;
          window.__b2tPagePin.held += 1;
        }
      }
    }
    if (mark && mark.page_no && mark.page_no !== injected.getPageNo()) {
      if (!injected.readingDriverActive?.("left")) injected.markReadingDriver?.("right");
      if (allowPageWrite) injected.updateReadingPage?.(mark.page_no, { scrollLeft: true, syncStream: false });
    } else if (!mark && pageNo && pageNo !== injected.getPageNo()) {
      if (!injected.readingDriverActive?.("left")) injected.markReadingDriver?.("right");
      if (allowPageWrite) injected.updateReadingPage?.(pageNo, { scrollLeft: true, syncStream: false });
    }
    if (mark && mark.bbox) {
      if (mark.page_no !== injected.getPageNo()) {
        injected.setReadingPendingBox(mark.bbox);
      } else {
        injected.drawReadingPdfBox?.(mark.bbox, mark.page_no);
      }
    }
  }));
}

function stepReadingPage(delta) {
  const total = injected.getProject() ? injected.getProject().pages.length : 0;
  const next = Math.min(total, Math.max(1, injected.getPageNo() + delta));
  if (next === injected.getPageNo()) return;
  // 任务 95：翻页按钮是**明确的用户意图**，必须同时写页码。
  // 原来只 `scrollPdfColumnToPage(next)`，而 `updateReadingPageFromLeftScroll` 对
  // "程序滚动"有早退守卫（`readingUserScrollSeq === readingProgramScrollSeq`），
  // 于是 scrollTop 动了、label 和 readingPageNo 却停在原地（QA 基线复现：0→461 而页码仍是 1）。
  // 走 `updateReadingPage`：写页码 + 左栏定位 + 右栏跟随；守卫保持原样（它挡的是异步重绘回拽）。
  injected.updateReadingPage?.(next);
}

async function submitReadingDrafts() {
  if (!injected.getProject() || (!injected.getDrafts().size && !injected.getInlineEdits().size)) return;
  const items = [...injected.getDrafts().values()].map((draft) => ({
    block_id: draft.block_id,
    line_index: draft.line_index,
    ack: draft.ack,
    new_line_text:
      draft.ack === "kept" ? null : draft.text == null ? null : draft.text,
  }));
  // 任务 66：就地编辑按"行文本"提交；服务端会校验 block.text == join(行文本)
  for (const [key, edit] of injected.getInlineEdits()) {
    const [blockId, lineIndex] = key.split(":");
    items.push({
      block_id: blockId,
      line_index: Number(lineIndex),
      new_line_text: edit.text,
      ack: null,
    });
  }
  const ok = window.confirm(
    `提交 ${items.length} 处改动？\n\n采用/手改会改写块文本，保留只记「保留原文」；写库后可以一次撤销。`
  );
  if (!ok) return;
  const button = el("reading-submit");
  button.disabled = true;
  button.textContent = "提交中…";
  try {
    const result = await injected.apiJson?.(
      `/api/projects/${injected.getProject().project_id}/review/submit-drafts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      }
    );
    const failed = (result.results || []).filter((item) => !item.ok);
    const okKeys = new Set(
      (result.results || [])
        .filter((item) => item.ok)
        .map((item) => injected.readingKey?.(item.block_id, item.line_index))
    );
    for (const key of okKeys) injected.getDrafts().delete(key);
    injected.saveReadingDrafts?.();
    for (const key of okKeys) injected.getInlineEdits().delete(key);
    injected.saveReadingInlineEdits?.();
    if (failed.length) {
      window.alert(`${failed.length} 处提交失败，仍留在草稿里：\n${failed[0].error || ""}`);
    }
    injected.setReadingData(null);
    injected.setReadingProject(null);
    await injected.openReading?.();
    await injected.loadFinishSummary?.({ silent: true });
    injected.renderReadingProgress?.();
  } catch (error) {
    button.disabled = false;
    injected.renderReadingProgress?.();
    window.alert(`提交失败：${error.message || "未知错误"}`);
  }
}

async function undoReadingSubmit() {
  if (!injected.getProject()) return;
  if (!window.confirm("撤销上一次批量操作？（提交的草稿改动会退回提交前）")) return;
  try {
    await injected.apiJson?.(`/api/projects/${injected.getProject().project_id}/undo`, {
      method: "POST",
    });
    injected.setReadingData(null);
    injected.setReadingProject(null);
    await injected.openReading?.();
    await injected.loadFinishSummary?.({ silent: true });
  } catch (error) {
    window.alert(error.message || "没有可撤销的操作");
  }
}
  // ---------------------------------------------------------------- 对外接口

  /** 绑 #view-reading 里归审校的控件（§4 第 2 组）：原来由 page-index / 标点 / 乱码三处代码持有。 */
  function bindViewControls() {
    const follow = el("reading-follow-chip");
    if (follow && follow.dataset.rvBound !== "1") {
      follow.dataset.rvBound = "1";
      follow.addEventListener("click", () => toggleFollow());
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
    setReadingFollow(!injected.getReadingFollow());
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
