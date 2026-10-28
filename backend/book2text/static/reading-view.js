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
    onReadingViewportResize();
  });
}

  // ---------------------------------------------------------------- 审校外壳（任务 94 · Slice 2）
  // 从 app.js 原样搬入；依赖全部由 init() 注入，模块本身不碰 app.js 的顶层符号。

function setupReading() {
  el("reading-next-unreviewed").addEventListener("click", gotoNextUnreviewed);
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
      renderReading({ reset: true });
    });
  }
  el("reading-discard-all").addEventListener("click", () => {
    const count = injected.getInlineEdits().size + injected.getDrafts().size;
    if (!count) return;
    if (!window.confirm(`放弃全部 ${count} 处未提交改动？（不可恢复）`)) return;
    injected.getInlineEdits().clear();
    saveReadingInlineEdits();
    injected.getDrafts().clear();
    saveReadingDrafts();
    renderReading({ reset: true });
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
    injected.navigate?.("review");
    injected.openPageDetail?.(injected.getPageNo());
  });
  el("reading-stream").addEventListener("scroll", onReadingScroll, { passive: true });
  el("reading-pdf-scroll").addEventListener("scroll", onReadingPdfScroll, { passive: true });
  // 悬停段落：右栏绿底 + 左边对应块绿框（只高亮，不滚）
  el("reading-stream").addEventListener("mouseover", (event) => {
    const seg = event.target.closest && event.target.closest(".reading-seg");
    setReadingHover(seg ? seg.dataset.seq : null);
  });
  // 任务 82：用户"自己动过"只认真实输入事件（程序滚动不算），用于异步收尾时别抢用户的滚动位置
  for (const id of ["reading-pdf-scroll", "reading-stream", "reading-tree"]) {
    const node = el(id);
    if (!node) continue;
    node.addEventListener("wheel", markReadingUserMoved, { passive: true });
    node.addEventListener("pointerdown", markReadingUserMoved, { passive: true });
    node.addEventListener("keydown", markReadingUserMoved);
  }
  el("reading-stream").addEventListener("mouseleave", () => setReadingHover(null));
  // 任务 76：**反向联动**——鼠标悬停左边 PDF 上的某个块，右侧对应段落亮起来。
  // 和"右→左"用同一套类名（`is-linked` / `is-hover`）、同一颜色，用户能看出是一条。
  el("reading-pages").addEventListener("mouseover", (event) => {
    const box = event.target.closest && event.target.closest(".box");
    if (!box || !box.dataset.blockId) return;
    setReadingHoverByBlock(box.dataset.blockId);
  });
  el("reading-pages").addEventListener("mouseleave", () => setReadingHover(null));
  // 从块移到块外的空白：pointerout 里判断"相关目标已经不在任何块里"就清，
  // 否则空白区域没有 mouseleave 可等，高亮会一直留着。
  el("reading-pages").addEventListener("pointerout", (event) => {
    const to = event.relatedTarget;
    if (to && to.closest && to.closest("#reading-pages .box")) return;
    if (to && to.closest && to.closest("#reading-pages")) return;
    setReadingHover(null);
  });
  el("reading-stream").addEventListener("click", (event) => {
    const markEl = event.target.closest && event.target.closest(".reading-mark");
    if (!markEl) return;
    const mark = injected.getMarks().get(markEl.dataset.key);
    if (mark) openReadingPanel(mark);
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
        rerenderReadingLine(line.dataset.key);
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
        exitInlineEdit();
      } else if (event.key === "Enter" && (event.altKey || event.metaKey)) {
        event.preventDefault();
        exitInlineEdit();
        gotoNextUnreviewed();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      gotoNextUnreviewed();
    } else if (event.key === "Escape") {
      closeReadingPanel();
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
  await openReading();
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
  exitInlineEdit();
  injected.setReadingEditingKey(line.dataset.key);
  line.classList.add("is-editing");
  line.classList.add("is-current");
  line.setAttribute("contenteditable", "plaintext-only");
  line.focus();
  const mark = injected.getMarks().get(line.dataset.key);
  const pageNo = mark && mark.page_no ? mark.page_no : Number(line.dataset.page);
  if (pageNo && pageNo !== injected.getPageNo()) {
    updateReadingPage(pageNo, { syncStream: false });
  }
  // 任务 76：**编辑某一行时，左侧要能看出"改的是图上哪一行"**。
  // 有差异标记就用标记的行框；没有标记（普通正文行）就去块缓存里找这一行的框。
  const lineBox = (mark && mark.bbox) || readingLineBox(line.dataset.block, Number(line.dataset.line));
  if (lineBox) {
    drawReadingPdfBox(lineBox, pageNo);
    drawEditingLineBox(lineBox, pageNo);
    markEditingLineBox(line.dataset.block, Number(line.dataset.line));
  }
  line.addEventListener("input", onInlineInput);
  line.addEventListener("keydown", onInlineKeydown);
  line.addEventListener("blur", () => {
    // 失焦只收起编辑态，草稿留着
    if (injected.getReadingEditingKey() === line.dataset.key) exitInlineEdit();
  });
}

function setReadingFilter(value) {
  injected.setReadingFilterValue(value);
  renderReading({ reset: true });
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
    setReadingHover(null);
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
    updateReadingPageFromLeftScroll();
    verifyReadingPageSync("leftScroll");
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
  if (!injected.getReadingFollow()) hideReadingPdfBox();
}

function onReadingScroll() {
  if (!injected.getReadingFollow() || injected.getReadingScrollRaf()) return;
  injected.setReadingScrollRaf(requestAnimationFrame(() => {
    injected.setReadingScrollRaf(0);
    if (!injected.getReadingFollow() || !injected.isReadingActive()) return;
    // 任务 72：左栏正在驱动（350 ms 锁内）就整个跳过——
    // 否则左栏刚把正文跳到第 60 页，这里按"正文顶部那一行"又把页码改回第 1 页。
    if (readingDriverActive("left")) return;
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
      if (!readingDriverActive("left")) markReadingDriver("right");
      if (allowPageWrite) updateReadingPage(mark.page_no, { scrollLeft: true, syncStream: false });
    } else if (!mark && pageNo && pageNo !== injected.getPageNo()) {
      if (!readingDriverActive("left")) markReadingDriver("right");
      if (allowPageWrite) updateReadingPage(pageNo, { scrollLeft: true, syncStream: false });
    }
    if (mark && mark.bbox) {
      if (mark.page_no !== injected.getPageNo()) {
        injected.setReadingPendingBox(mark.bbox);
      } else {
        drawReadingPdfBox(mark.bbox, mark.page_no);
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
  updateReadingPage(next);
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
    saveReadingDrafts();
    for (const key of okKeys) injected.getInlineEdits().delete(key);
    saveReadingInlineEdits();
    if (failed.length) {
      window.alert(`${failed.length} 处提交失败，仍留在草稿里：\n${failed[0].error || ""}`);
    }
    injected.setReadingData(null);
    injected.setReadingProject(null);
    await openReading();
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
    await openReading();
    await injected.loadFinishSummary?.({ silent: true });
  } catch (error) {
    window.alert(error.message || "没有可撤销的操作");
  }
}
  // ---------------------------------------------------------------- 审校打开 / 行编辑（任务 94 · L3）
  // 从 app.js 原样搬入；依赖全部由 init() 注入，模块本身不碰 app.js 的顶层符号。

/**
 * 打开阅读流的异步阶段（正文预览 → marks → 重画）里，用户是不是自己动过？
 *
 * **不能拿 scrollTop 比较**：打开时页码跟随、图片就位都会程序性地滚一下，
 * 那样会被误判成"用户动过"（实测：于是永远不跳到第一处未审页）。
 * 这里只认真实输入事件（wheel / pointerdown / keydown）。
 */
function readingMovedSinceOpen(sinceMs) {
  return injected.getReadingUserMovedAt() > sinceMs;
}

async function openReading() {
  if (!injected.getProject()) return;
  // 三栏宽度在打开时套一次：视图刚显示出来才量得到真实宽度
  applyReadingSplit();
  const projectId = injected.getProject().project_id;
  if (injected.getReadingProject() === projectId && injected.getReadingData()) {
    renderReading({ reset: true });
    injected.renderReadingProgress?.();
    ensureReadingPages();
    measureReadingTops();
    if (injected.getPageNo()) updateReadingPage(injected.getPageNo(), { scrollLeft: true });
    injected.refreshPunctGroups?.();
    return;
  }
  const started = performance.now();
  injected.setReadingOpenStartedAt(started);
  // 任务 81：记下打开时的滚动位置。marks 是异步来的，它回来时会按"第一处未审页"跳一次——
  // 如果这期间用户已经自己滚走了，就不能再把他拽回去（QA 复跑时正是被这一跳拽回第 1 页）。
  const openedAt = injected.getReadingOpenStartedAt();
  const firstOpenForProject = injected.getReadingProject() !== projectId || !injected.getReadingAutoJumpDone();
  const stream = el("reading-stream");
  stream.innerHTML = '<p class="muted reading-empty">正在按导出设置组装正文…</p>';
  el("reading-tree").innerHTML = "";
  let preview;
  try {
    preview = await injected.apiJson?.(
      `/api/projects/${projectId}/export/preview?segments_only=1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(readingOptions()),
      }
    );
  } catch (error) {
    stream.innerHTML = "";
    const p = document.createElement("p");
    p.className = "muted reading-empty";
    p.textContent = `正文流加载失败：${error.message || "未知错误"}`;
    stream.append(p);
    return;
  }
  injected.setReadingData(preview);
  injected.setReadingProject(projectId);
  injected.setMarks(new Map());
  injected.setReadingEntries([]);
  injected.setReadingMarksWindow(null);
  injected.setReadingGlobalCounts(null);
  injected.setReadingPageCounts(new Map());
  injected.setReadingFirstUnackedPage(null);
  // 先出正文（无红字），红字随后补：点击到正文可见不用等 marks / tree
  renderReading({ reset: true });
  const metrics = (window.__b2tReadingMetrics = window.__b2tReadingMetrics || {});
  metrics.openedAt = Math.round(started);
  metrics.firstPaintMs = Math.round(performance.now() - started);
  metrics.segments = injected.readingVisibleSegments?.().length;
  // 任务 67：只拉**第一处未审页 ±10** 的 marks（`first=1` 让服务端自己定位），
  // 不再等 1.52 MB 的全书 marks；tree（左栏每页计数）单独拉，不挡红字。
  let marks;
  try {
    marks = await injected.apiJson?.(`/api/projects/${projectId}/review/marks?first=1`);
  } catch (error) {
    metrics.error = String(error.message || error);
    return;
  }
  metrics.marksMs = Math.round(performance.now() - started);
  applyReadingMarksPayload(marks);
  loadReadingDrafts();
  loadReadingInlineEdits();
  restoreInlineEditsPrompt();
  renderReading({ reset: true });
  injected.renderReadingProgress?.();
  metrics.firstMarkMs = Math.round(performance.now() - started);
  metrics.entries = injected.getReadingEntries().length;
  metrics.window = marks.window;
  metrics.counts = marks.counts;
  ensureReadingPages();
  measureReadingTops();
  metrics.openMs = Math.round(performance.now() - started);
  // 标点差异面板的数字（后台拉，不挡正文）：主队列只放汉字差异，其余在这里按模式判
  injected.refreshPunctGroups?.();
  injected.refreshGarbledLines?.();
  let page =
    marks.first_unacked_page ||
    injected.getReadingEntries()[0]?.page_no ||
    injected.getProject().pages[0]?.page_no ||
    1;
  // 任务 82：`first_unacked_page` 可能是前置页（第 1–37 页）——它们在队列里、
  // 但不在正文流里，跳过去右边是一片空。落到正文流里第一处有差异的页。
  const flowPages = readingFlowPages();
  if (!flowPages.has(page)) {
    // 用全书每页计数找"正文流里第一处还有未审差异的页"（marks 窗口在别的页时，
    // `readingEntries` 是空的，不能靠它）
    const candidate = [...injected.getReadingPageCounts().keys()]
      .map((key) => Number(key))
      .filter((no) => flowPages.has(no) && Number(injected.getReadingPageCounts().get(String(no))?.unacked || 0) > 0)
      .sort((a, b) => a - b)[0];
    if (candidate) page = candidate;
  }
  // 用户在这几秒里自己滚过了：保留他的位置，不跳到"第一处未审页"
  // 自动跳页**只允许发生一次**（任务 85）：marks 迟到 / 块到达 / 窗口重铺都不许再跳。
  if (firstOpenForProject && !injected.getReadingAutoJumpDone() && !readingMovedSinceOpen(openedAt)) {
    injected.setReadingAutoJumpDone(true);
    updateReadingPage(page);
  }
  // 左树后补（只影响左栏计数，不影响正文与红字）
  injected.apiJson?.(`/api/projects/${projectId}/review/tree`)
    .then((tree) => {
      injected.setReadingTreeData(tree);
      renderReadingTree();
      metrics.treeMs = Math.round(performance.now() - started);
      metrics.treeUnacked = tree.stats ? tree.stats.unacked : null;
    })
    .catch(() => {});
}

/** 点正文 = 落光标、该行成为当前行（块边界不可跨越：一行一个编辑区）。 */
/** 从块缓存里取某一行的框（没有就返回 null）。 */
function readingLineBox(blockId, lineIndex) {
  if (!blockId) return null;
  const pageNo = Number(injected.readingLineNode?.(`${blockId}:${lineIndex}`)?.dataset?.page || 0);
  const blocks = pageNo ? injected.getReadingPageBlocks().get(pageNo) : null;
  if (!blocks) return null;
  const block = blocks.find((item) => item.block_id === blockId);
  const line = block && (block.lines || [])[lineIndex];
  return line && line.bbox ? line.bbox : null;
}

/**
 * 左侧标出"我正在这个块里改一行"：块框给一层很淡的琥珀。
 * 真正的**行标记**是 `#reading-pdf-box`（按行框画的那个橙框），这里不重复造。
 */
function markEditingLineBox(blockId) {
  for (const node of document.querySelectorAll("#reading-pages .box.is-editing-block")) {
    node.classList.remove("is-editing-block");
  }
  if (!blockId) return;
  for (const node of document.querySelectorAll(`#reading-pages .box[data-block-id="${blockId}"]`)) {
    node.classList.add("is-editing-block");
  }
}

function exitInlineEdit() {
  const node = injected.getReadingEditingKey() ? injected.readingLineNode?.(injected.getReadingEditingKey()) : null;
  if (node) {
    const key = node.dataset.key;
    clearTimeout(Number(node.dataset.editTimer || 0));
    saveInlineEdit(node);
    node.removeAttribute("contenteditable");
    node.classList.remove("is-editing");
    node.classList.remove("is-current");
    node.removeEventListener("input", onInlineInput);
    node.removeEventListener("keydown", onInlineKeydown);
  }
  // 退出编辑：左侧的"正在改这一行"标记一起收掉
  for (const box of document.querySelectorAll("#reading-pages .box.is-editing-block")) {
    box.classList.remove("is-editing-block");
  }
  for (const node of document.querySelectorAll("#reading-pages .reading-edit-line")) node.remove();
  injected.setReadingEditingKey(null);
  if (injected.getReadingRepaintPending()) {
    injected.setReadingRepaintPending(false);
    refreshReadingMarksPaint();
  }
}

function onInlineKeydown(event) {
  if (event.key === "Enter" && (event.altKey || event.metaKey)) {
    // ⌥↵ / ⌘↵：收草稿并跳下一处
    event.preventDefault();
    exitInlineEdit();
    gotoNextUnreviewed();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    exitInlineEdit();
    return;
  }
  // 普通回车 = 段内换行（contenteditable 默认行为），不拦
}

/** 跟随时的"当前行框"：画在页列里对应那一页上（页列是 position: relative）。 */
/**
 * 在左侧页块里画出"正在编辑的这一行"（任务 76）。
 *
 * 不依赖 `#reading-pdf-box`：那个节点在重建页列时会被 `wrap.innerHTML = ""` 清掉，
 * 复用它会时有时无。这里每条页块自己挂一个 `.reading-edit-line`，位置按行框算。
 */
function drawEditingLineBox(bbox, pageNo) {
  for (const node of document.querySelectorAll("#reading-pages .reading-edit-line")) node.remove();
  const tile = injected.getReadingTiles().get(pageNo);
  if (!tile || !Array.isArray(bbox) || bbox.length !== 4) return;
  const [x0, y0, x1, y1] = bbox;
  const width = tile.clientWidth || tile.getBoundingClientRect().width;
  const height = tile.clientHeight || tile.getBoundingClientRect().height;
  if (!width || !height) return;
  const node = document.createElement("div");
  node.className = "reading-edit-line";
  node.style.left = `${Math.round(x0 * width)}px`;
  node.style.top = `${Math.round(y0 * height)}px`;
  node.style.width = `${Math.round((x1 - x0) * width)}px`;
  node.style.height = `${Math.round((y1 - y0) * height)}px`;
  tile.append(node);
}
  // ---------------------------------------------------------------- 队列 / 草稿 / 视口（任务 94 · L4）
  // 从 app.js 原样搬入；依赖全部由 init() 注入，模块本身不碰 app.js 的顶层符号。

function onReadingViewportResize() {
  if (!injected.isReadingActive()) return;
  measureReadingTops();
  if (injected.getPageNo()) updateReadingPage(injected.getPageNo(), { scrollLeft: true });
}

function loadReadingInlineEdits() {
  injected.setReadingInlineEdits(new Map());
  try {
    const raw = localStorage.getItem(readingInlineStorageKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const item of data.items || []) {
      if (!item || !item.key || item.text == null) continue;
      injected.getInlineEdits().set(item.key, {
        base: item.base || "",
        text: item.text,
        at: item.at || Date.now(),
      });
    }
  } catch {
    injected.setReadingInlineEdits(new Map());
  }
}

/** 重开项目时有未提交的就地编辑：给一次"恢复 / 丢弃"（切换视图不算丢，所以只在首次加载问）。 */
function restoreInlineEditsPrompt() {
  if (!injected.getInlineEdits().size) return;
  const count = injected.getInlineEdits().size;
  const when = new Date(
    Math.min(...[...injected.getInlineEdits().values()].map((item) => item.at || Date.now()))
  );
  const label = `${when.getMonth() + 1}-${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  if (window.confirm(`有 ${count} 处未提交的正文改动（${label}）。\n\n「确定」= 恢复它们；「取消」= 丢弃。`)) {
    return;
  }
  injected.getInlineEdits().clear();
  saveReadingInlineEdits();
}

function loadReadingDrafts() {
  injected.setReadingDrafts(new Map());
  try {
    const raw = localStorage.getItem(injected.readingDraftStorageKey?.());
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const item of data.items || []) {
      if (!item || !item.block_id) continue;
      injected.getDrafts().set(injected.readingKey?.(item.block_id, item.line_index), item);
    }
  } catch {
    injected.setReadingDrafts(new Map());
  }
}

function onInlineInput(event) {
  const line = event.currentTarget;
  // 每行一个定时器：全局一个的话，连着改三行只有最后一行会落草稿
  clearTimeout(Number(line.dataset.editTimer || 0));
  const timer = setTimeout(() => saveInlineEdit(line), 350);
  line.dataset.editTimer = String(timer);
}

/** 量页列的滚动偏移（建列 / 缩放 / 窗口变化后）。 */
function measureReadingTops() {
  const scroller = el("reading-pdf-scroll");
  if (!scroller) return;
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  injected.setReadingTops([]);
  for (const [pageNo, tile] of injected.getReadingTiles()) {
    const rect = tile.getBoundingClientRect();
    injected.getReadingTops().push({ pageNo, top: rect.top - base });
  }
  injected.getReadingTops().sort((a, b) => a.pageNo - b.pageNo);
}

async function gotoNextUnreviewed() {
  if (!injected.getReadingData()) return;
  // **唯一数据源：服务端按正文流顺序给出的未审行表**。
  // 不再用"页级计数 + 已加载 marks"自己找：页级口径包含流外的行（脚注/被排除块），
  // 找到页却找不到行就会报"没有下一处"。实测 567 条未审汉字 = 流内 562 + 流外 5
  // （流外在页 48/106/499/621/630）。早先说的"卡在 11/14/18/23"已推翻：那几页的行
  // 都在流内，none 是补 marks 窗口的竞态，由 ensureReadingMarksWindow 共享在飞请求修掉。
  let payload;
  try {
    payload = await injected.apiJson?.(`/api/projects/${injected.getProject().project_id}/review/next-lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(readingOptions()),
    });
  } catch (error) {
    logReadingNext(null, { branch: "error", reason: String(error.message || error) });
    injected.showNoticeBar?.(`找下一处失败：${error.message || "未知错误"}`);
    return;
  }
  const lines = payload.lines || [];
  const usable = lines.filter(
    (line) => !injected.getDrafts().has(injected.readingKey?.(line.block_id, line.line_index))
  );
  const outside = payload.outside_stream || { count: 0, sample: [] };
  if (!usable.length) {
    logReadingNext(null, { branch: "none", total: payload.total, outside: outside.count });
    // 队列里还有差异、只是不在正文流里：必须把数说出来，不许说"全部处理完"
    if (Number(outside.count) > 0) {
      injected.showNoticeBar?.(
        `正文流内已无未审；另有 ${outside.count} 处差异不在正文流里（前置页 / 脚注 / 被排除的块）`
      );
    } else {
      injected.showNoticeBar?.("全书未审已处理完 · 可以去「成稿模式」通读一遍，或者直接导出");
    }
    return;
  }
  const keyOf = (line) => injected.readingKey?.(line.block_id, line.line_index);
  const cursorKey = injected.getReadingCursorEntry()
    ? injected.readingKey?.(injected.getReadingCursorEntry().block_id, injected.getReadingCursorEntry().line_index)
    : null;
  let cursor = cursorKey ? usable.findIndex((line) => keyOf(line) === cursorKey) : -1;
  let target;
  if (cursor >= 0) {
    target = usable[(cursor + 1) % usable.length];
  } else {
    // 没有游标：从当前位置往后第一处，再绕回开头
    const page = Number(injected.getPageNo() || 0);
    const after = usable.findIndex((line) => Number(line.page_no) >= page);
    target = usable[after >= 0 ? after : 0];
  }
  if (!target) return;
  await ensureReadingMarksWindow(target.page_no);
  const entry = injected.getReadingEntries().find(
    (item) => item.block_id === target.block_id && item.line_index === target.line_index
  );
  if (!entry) {
    // 服务端说这行在流里、前端却查不到条目：只可能是 marks 窗口还没到，不静默、不谎报完成
    logReadingNext(target, { branch: "missing", reason: "entry-not-in-window" });
    injected.showNoticeBar?.("这一处差异的标记还没加载完，稍等一下再按一次「下一处未审」");
    return;
  }
  injected.setReadingCursorEntry(entry);
  gotoReadingEntry(entry);
  logReadingNext(entry, { branch: "next-lines" });
}
  // ---------------------------------------------------------------- 审校环（任务 94 · L5）
  // 从 app.js 原样搬入；依赖由 init() 注入。状态仍归 app.js：
  // 读状态走注入的 getter，写状态走注入的 setter，队列状态归模块自己。

function readingOptions() {
  // 阅读流固定按"全书正文"取段：不受导出面板里的页码范围 / 仅已确认影响，
  // 否则队列分母和左树、收尾面板会对不上。
  const options = injected.exportOptions();
  return { ...options, confirmed_only: false, page_numbers: null };
}

// ---------------------------------------------------------------- 破环：审校意图队列（§12.1.1）
//
// 渲染只读状态，不直接调加载器、不直接改页码：把"这一帧还想补的事"按 kind 入队，
// 帧末由 flushReadingIntents() 统一消费。每个 kind 只保留"当前愿望"（后写覆盖先写），
// 所以长度 ≤ 6 是**结构上限**。队列归审校，L5 时整段搬进 reading-view.js。
const READING_INTENT_KINDS = ["marks", "blocks", "panel", "jump", "goto", "scroll"];
const readingIntents = new Map();
const readingIntentStats = { dropped: 0, coalesced: 0 };
let readingFlushRaf = 0;

/** 清空队列；dropped=true 表示"这次是丢弃"（!active / exit / 换项目），计入统计。 */
function clearReadingIntents(dropped = false) {
  if (dropped) readingIntentStats.dropped += readingIntents.size;
  readingIntents.clear();
  if (readingFlushRaf) {
    cancelAnimationFrame(readingFlushRaf);
    readingFlushRaf = 0;
  }
}

/** 单点写入：kind 只能是这 6 个；同 kind 直接覆盖，不排队。 */
function queueReadingIntent(kind, payload) {
  if (!READING_INTENT_KINDS.includes(kind)) {
    throw new Error(`unknown reading intent: ${kind}`);
  }
  if (readingIntents.has(kind)) readingIntentStats.coalesced += 1;
  // blocks 是唯一允许数组的 payload：一次悬浮可能覆盖多页，入队时按 Set 去重。
  if (kind === "blocks") payload = { pageNos: [...new Set(payload.pageNos || [])] };
  readingIntents.set(kind, payload);
  if (!readingFlushRaf) readingFlushRaf = requestAnimationFrame(flushReadingIntents);
}

/** 单点消费：固定顺序 marks → blocks → panel → jump → goto → scroll；一帧最多一次。 */
function flushReadingIntents() {
  readingFlushRaf = 0;
  if (!injected.getProject() || injected.getCurrentView() !== "reading") {
    clearReadingIntents(true);
    return;
  }
  // 先快照再清空：flush 期间新入队的愿望留给下一帧，不递归。
  const intents = new Map(readingIntents);
  readingIntents.clear();
  if (intents.has("marks")) ensureReadingMarksWindow(intents.get("marks").pageNo);
  if (intents.has("blocks")) {
    for (const pageNo of intents.get("blocks").pageNos) ensureReadingBlocks(pageNo);
  }
  if (intents.has("panel")) retryReadingPendingPanel();
  if (intents.has("jump")) jumpReadingTo(intents.get("jump").segmentIndex);
  if (intents.has("goto")) {
    const intent = intents.get("goto");
    updateReadingPage(intent.pageNo, { scrollLeft: intent.scrollLeft, syncStream: intent.syncStream });
  }
  if (intents.has("scroll")) scrollReadingToPage(intents.get("scroll").pageNo);
  if (readingIntents.size && !readingFlushRaf) {
    readingFlushRaf = requestAnimationFrame(flushReadingIntents);
  }
}

/**
 * 吃掉一次 `/review/marks` 的返回（全书或窗口都一样）。
 *
 * 任务 67：`entries` 只由**已加载的窗口**生成；进度数字用返回里的全书 `counts`，
 * 否则窗口一换进度条就会跟着缩水（用户会以为先前审的丢了）。
 */
function applyReadingMarksPayload(payload) {
  injected.setReadingMarks( new Map());
  for (const mark of payload.items || []) {
    injected.getReadingMarks().set(injected.readingKey(mark.block_id, mark.line_index), mark);
  }
  injected.setReadingMarksWindow( payload.window || null);
  injected.setReadingGlobalCounts( payload.counts || null);
  injected.setReadingPageCounts( new Map(Object.entries(payload.page_counts || {})));
  injected.setReadingFirstUnackedPage( payload.first_unacked_page ?? null);
  rebuildReadingEntries();
}

function rebuildReadingEntries() {
  injected.setReadingEntries( []);
  if (!injected.getReadingData()) return;
  const punctWatch = injected.punctReviewSet();
  for (const segment of injected.readingVisibleSegments()) {
    const spans = segment.line_spans || [];
    for (let i = 0; i < spans.length; i += 1) {
      const span = spans[i];
      const mark = injected.getReadingMarks().get(injected.readingKey(span.block_id, span.line_index));
      if (!mark) continue;
      // 主队列只放含汉字差异的行；纯标点 / 空格按模式批量判（任务 61），
      // 只有被用户点了「逐条看」的那几种模式才回到主队列。
      if (mark.level === "differs_punct" && !punctWatch.has(mark.pattern_key)) continue;
      injected.getReadingEntries().push({
        ...mark,
        seq: segment.seq,
        span_index: i,
        page_no: mark.page_no || span.page_no,
      });
    }
  }
  // 左树的条目级列表跟着 marks 窗口走：窗口换了，这一页下面的条目也要换
  if (injected.getReadingTreeData()) renderReadingTree();
}

function readingWindowHas(pageNo) {
  if (!injected.getReadingMarksWindow()) return false;
  return pageNo >= injected.getReadingMarksWindow().page_from && pageNo <= injected.getReadingMarksWindow().page_to;
}

/**
 * 切到窗口外的一页时，补拉那一页 ±10 的 marks。
 *
 * 只重画已经铺出来的那几段（`READING_CHUNK` = 8 段，几十毫秒），并保持滚动位置——
 * 直接 `renderReading({reset:true})` 会把用户滚到的地方弹回文首。
 *
 * 并发语义：**共享在飞的请求，且目标页真正进窗口才 resolve**。旧写法在有请求在飞时
 * 只把页号塞进 `readingMarksQueued` 就 `return`，调用方的 `await` 立刻通过、拿到的是
 * 旧窗口——20 连点的第 8 次正好是第一次必须补窗口（窗口 1–11 里恰好 7 条未审），
 * 于是对着旧 entries 找行，报 `branch:none`。这是竞态，不是口径。
 */
async function ensureReadingMarksWindow(pageNo) {
  if (!injected.getProject() || !injected.getReadingData()) return;
  if (!pageNo || readingWindowHas(pageNo)) return;
  // 最多三轮：等在飞 → 自己发 → 确认。失败重试有上限，也不把异常抛给调用方。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (injected.getReadingMarksInFlight()) {
      await injected.getReadingMarksInFlight();
    } else {
      const pending = loadReadingMarksWindow(pageNo).then(
        () => true,
        () => false
      );
      injected.setReadingMarksInFlight( pending);
      let ok = false;
      try {
        ok = await pending;
      } finally {
        if (injected.getReadingMarksInFlight() === pending) injected.setReadingMarksInFlight( null);
      }
      // 请求成功、窗口却还不含该页：页码越界被服务端裁掉，再发也一样。
      if (ok) return;
    }
    if (readingWindowHas(pageNo)) return;
  }
}

async function loadReadingMarksWindow(pageNo) {
  // **最新请求赢**：QA 120 连按实测，第 200 页时 marks 窗口会跳回 1-11 / 2-22 / 13-33，
  // 结果是面板 key 既不在 readingMarks 也不在 readingEntries，行节点渲染不出来、
  // 游标原地打转（17/120 次点击零推进）。早期页的请求晚到就该被丢掉。
  const seq = (injected.setReadingMarksRequestSeq(injected.getReadingMarksRequestSeq() + 1));
  const payload = await injected.apiJson(
    `/api/projects/${injected.getProject().project_id}/review/marks?page=${pageNo}`
  );
  if (seq !== injected.getReadingMarksRequestSeq()) return;   // 过期响应：已经被更晚的请求取代
  applyReadingMarksPayload(payload);
  // 正在编辑某一行时**不重画**：重画会换掉那个 DOM 节点，光标和没落草稿的输入
  // 一起丢（任务 67 实测：翻页补 marks 正好撞上用户点进一行，编辑态瞬间消失）。
  // 红字晚一点到没关系，退出编辑时补画。
  if (injected.getReadingEditingKey()) {
    injected.setReadingRepaintPending( true);
  } else {
    refreshReadingMarksPaint();
  }
  injected.renderReadingProgress();
}

function refreshReadingMarksPaint() {
  const stream = el("reading-stream");
  if (!stream || !injected.getReadingData()) return;
  // 跳页途中（左栏在驱动）不重画：重画会把滚动位置恢复成"作废前的位置"，
  // 刚跳到的第 80 页会被弹回第 1 页（任务 72 实测）。
  if (readingDriverActive("left")) {
    injected.setReadingRepaintPending( true);
    return;
  }
  const pageAtSave = injected.getPageNo();
  const top = stream.scrollTop;
  // 重画会把面板与"当前行"一起清掉（`renderReading({reset:true})` 里 `readingPanelKey=null`）。
  // 记住它，重画完成后恢复——否则用户刚点开的那一处会凭空消失、位置也回到页首。
  const panelKey = injected.getReadingPanelKey();
  const panelEntry = panelKey
    ? injected.getReadingEntries().find((entry) => injected.readingKey(entry.block_id, entry.line_index) === panelKey)
    : null;
  const segmentsToKeep = Math.max(injected.getReadingRendered(), 0);
  // **只重铺尾部一段**：从第 0 段重建 300+ 段 DOM 是主要卡顿来源（QA：1-8 帧/450ms）。
  // 保留最后 24 段（≈ 两屏），铺到原来的段数为止；滚动位置随后由 openReadingPanel 居中恢复。
  const fromSeg = Math.max(0, segmentsToKeep - 24);
  renderReading({ reset: true, startAt: fromSeg });
  let guard = 0;
  while (injected.getReadingRendered() < segmentsToKeep && guard < 400) {
    renderReading();
    guard += 1;
  }
  // 重画期间页码被改过（用户又跳了）就不恢复旧位置，否则等于把人拽回去。
  // 只重铺尾部时（fromSeg>0）绝对滚动位置没有意义，交给 openReadingPanel 居中恢复。
  if (fromSeg === 0 && injected.getPageNo() === pageAtSave) stream.scrollTop = top;
  if (panelEntry && injected.getPageNo() === pageAtSave) {
    // 重画可能把目标行刷出渲染范围（`reset` 从第 0 段顺序铺，`segmentsToKeep` 只按
    // 段数恢复）：面板照开（面板不依赖行节点），但那一行不在 DOM 里 → 用户看到面板、
    // 看不到差异在哪（QA 20 次里 7 次 `is-current = 0`）。先补行，再开面板。
    const line = ensureReadingLineRendered(panelEntry);
    openReadingPanel(panelEntry);
    if (!line) {
      injected.showNoticeBar(
        `这一处差异所在的行不在当前正文窗口里（第 ${panelEntry.page_no} 页第 ${panelEntry.line_index + 1} 行），已尝试展开`
      );
    }
  }
}

/**
 * 目标行必须真的在 DOM 里，才谈得上"高亮"。
 *
 * `renderReading` 是**从第 0 段顺序往后铺**的（`readingRendered` 计数）。跳到第 500 段
 * 之后再 `reset` 重画，目标行就落在铺出来的范围外——面板照开，光标行却不存在。
 * 这里按目标行所在段重铺一次再查；查不到返回 null，由调用方给显式提示，
 * 绝不"只开面板了事"。
 */
function ensureReadingLineRendered(entry) {
  if (!entry) return null;
  const key = injected.readingKey(entry.block_id, entry.line_index);
  const existing = injected.readingLineNode(key);
  if (existing) return existing;
  const segments = injected.readingVisibleSegments();
  let index = -1;
  if (entry.seq !== null && entry.seq !== undefined) {
    index = segments.findIndex((segment) => Number(segment.seq) === Number(entry.seq));
  }
  if (index < 0) {
    // 左树条目没有 `seq`：按 line_span 反查它属于哪一段
    index = segments.findIndex((segment) =>
      (segment.line_spans || []).some(
        (span) =>
          span.block_id === entry.block_id && Number(span.line_index) === Number(entry.line_index)
      )
    );
  }
  if (index < 0) return null;
  setPanel(entry);
  renderReading({ reset: true, startAt: Math.max(0, index - 1) });
  return injected.readingLineNode(key);
}

function renderReading({ reset = false, startAt = null } = {}) {
  const stream = el("reading-stream");
  if (!stream || !injected.getReadingData()) return;
  if (reset) {
    stream.innerHTML = "";
    injected.setReadingRendered( startAt != null ? Math.max(0, startAt) : 0);
    injected.setReadingSegmentNodes( []);
    // 只清 DOM 引用：`readingPendingPanelEntry` 跨重绘存活，末尾由 retryReadingPendingPanel 恢复
    injected.setReadingPanelKey( null);
    if (injected.getReadingObserver()) injected.getReadingObserver().disconnect();
    injected.setReadingObserver( null);
  }
  const segments = injected.readingVisibleSegments();
  if (!segments.length) {
    stream.innerHTML = '<p class="muted reading-empty">按当前导出设置没有可读的正文。</p>';
    return;
  }
  const end = Math.min(segments.length, injected.getReadingRendered() + injected.READING_CHUNK);
  const firstNew = injected.getReadingRendered();
  const fragment = document.createDocumentFragment();
  for (let index = injected.getReadingRendered(); index < end; index += 1) {
    const node = buildReadingSegment(segments[index]);
    injected.getReadingSegmentNodes()[index] = node;
    fragment.append(node);
  }
  stream.append(fragment);
  injected.setReadingRendered( end);
  removeReadingSentinel();
  // 任务 84：`reset` 会把面板元素和 `readingPanelKey` 一起清掉。**挂起的"待开面板"
  // 必须跨过重绘**——DOM 重建完之后如果那一行挂上了，就把面板重新开出来。
  queueReadingIntent("panel", {});
  // 任务 77：**重画之后把悬停状态补回来**。右栏重建（切页补 marks / 滚动补段）会把
  // `is-hover` 一起冲掉，用户看到的是"鼠标还停在块上、右边的绿没了"。
  if (injected.getReadingHoveredSeq() !== null && injected.getReadingHoveredSeq() !== undefined) {
    const hovered = stream.querySelector(
      `.reading-seg[data-seq="${injected.getReadingHoveredSeq()}"]`
    );
    if (hovered) hovered.classList.add("is-hover");
  }
  if (end < segments.length) stream.append(buildReadingSentinel());
  // 任务 67：滚动会把后面的段铺出来，那些页可能在 marks 窗口外——补一块再画红字。
  // **全量重建（reset）时绝不能这么干**：QA 120 连按实测，`refreshReadingMarksPaint`
  // 先 reset 从第 0 段铺，这里就按"这一块的最大页"（≈11）去要窗口，窗口被拉回 1-11；
  // 加载完又触发一次重画，又从第 0 段铺……用户在 200 页，窗口在 1-11/2-22/13-33 之间打转，
  // 面板 key 不在任何已加载窗口里 → 17/120 次点击零推进、rAF 只有 1-8 帧/450ms。
  if (!reset && injected.getReadingMarksWindow() && end > firstNew) {
    let maxPage = 0;
    for (let index = firstNew; index < end; index += 1) {
      for (const page of segments[index].pages || []) {
        if (page.page_no > maxPage) maxPage = page.page_no;
      }
    }
    if (maxPage && !readingWindowHas(maxPage)) queueReadingIntent("marks", { pageNo: maxPage });
  }
  // 重绘会重建 `.reading-line` 节点，`is-current` 跟着一起没了；`readingPanelKey`
  // 也在 `reset` 里被清空、由 `retryReadingPendingPanel()` 恢复。所以**每次重绘之后
  // 都要按当前状态回补一次**——它幂等，别指望"某一次 openReadingPanel 的副作用"能活过重绘。
  // （QA 实测：目标行在 DOM 里、面板开着，`is-current` 却是 0，就是这么丢的。）
  injected.refreshReadingCurrentHighlight();
  // 面板 DOM 在独立 host 里，`reset` 碰不到它：如果这次重绘既没有 `readingPanelKey`
  // 也没有待恢复的面板，残留的旧面板就再也对不上了。
  // QA 现场：正文和顶部已回到第 1 页，`#reading-panel-host` 里还挂着第 368 页的旧面板，
  // 因为 `openReadingPanel` 看到"已有面板"就不重建。
  if (!injected.getReadingPanelKey() && !injected.getReadingPendingPanelEntry() && !injected.getReadingPendingPanelKey()) {
    hideReadingPanelHost();
  }
}

function buildReadingSentinel() {
  const node = document.createElement("div");
  node.className = "reading-sentinel";
  node.dataset.role = "sentinel";
  if (!injected.getReadingObserver()) {
    injected.setReadingObserver( new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        // 哨兵本身就在 rootMargin 里：一帧只补一块，别让回调递归把整本一次铺出来
        if (injected.getReadingAppendScheduled()) return;
        injected.setReadingAppendScheduled( true);
        requestAnimationFrame(() => {
          injected.setReadingAppendScheduled( false);
          renderReading();
        });
      },
      { root: el("reading-stream"), rootMargin: "800px 0px" }
    ));
  }
  injected.getReadingObserver().observe(node);
  return node;
}

function saveInlineEdit(line) {
  const key = line.dataset.key;
  const base = line.dataset.baseText || "";
  // 渲染用连续切片（行尾带 join_lines 的分隔符），但**这一行的字**不含它：
  // 保存前把尾部空白去掉，否则会把分隔符写进 block_line.text，
  // 提交时块文本 == 行拼接 的校验会失败（那条校验是对的）。
  const text = (line.innerText || "").replace(/\n$/, "").replace(/\s+$/, "");
  if (!text || text === base) {
    injected.getReadingInlineEdits().delete(key);
  } else {
    injected.getReadingInlineEdits().set(key, { base, text, at: Date.now() });
  }
  saveReadingInlineEdits();
  line.classList.toggle("is-inline-edited", injected.getReadingInlineEdits().has(key));
  injected.renderReadingProgress();
}

function centerReadingLinePair(entry) {
  const key = injected.readingKey(entry.block_id, entry.line_index);
  const stream = el("reading-stream");
  const line = injected.readingLineNode(key);
  if (stream && line) {
    const lineRect = line.getBoundingClientRect();
    const streamRect = stream.getBoundingClientRect();
    scrollScrollerToCenter(
      stream,
      lineRect.top - streamRect.top + stream.scrollTop,
      lineRect.height
    );
  }
  const scroller = el("reading-pdf-scroll");
  const tile = entry.page_no ? injected.getReadingTiles().get(entry.page_no) : null;
  if (scroller && tile && entry.bbox) {
    // 先挂抑制：下面这行会触发 scroll 事件，不抑制的话"左→右跟随"会把右栏拉回这一页页首
    suppressReadingFollow();
    verifyReadingPageSync("centerLine");
    const tileRect = tile.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const tileTop = tileRect.top - scrollerRect.top + scroller.scrollTop;
    const lineCenter = ((entry.bbox[1] + entry.bbox[3]) / 2) * tileRect.height;
    const lineHeight = Math.max(2, (entry.bbox[3] - entry.bbox[1]) * tileRect.height);
    scrollScrollerToCenter(scroller, tileTop + lineCenter - lineHeight / 2, lineHeight);
  }
}

function openReadingPanel(entry) {
  closeReadingPanel();
  const key = injected.readingKey(entry.block_id, entry.line_index);
  const line = injected.readingLineNode(key);
  // 窗口化渲染的竞态：跳转后那一行可能还没挂上 DOM。
  // 面板本来只需要 `mark`（候选文本）与 `bbox`，**不依赖行节点**——
  // 行节点只用来定位与样式。所以找不到就降级挂到正文流顶部，绝不让用户"跳过去了但没有面板"。
  injected.setReadingPanelKey( key);
  const panel = document.createElement("div");
  panel.className = "reading-panel";
  panel.dataset.key = injected.getReadingPanelKey();
  const head = document.createElement("div");
  head.className = "reading-panel__head";
  const label = document.createElement("strong");
  label.textContent = `第 ${entry.page_no} 页 · 第 ${entry.line_index + 1} 行第二路：`;
  head.append(label);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-btn";
  close.title = "收起";
  close.textContent = "✕";
  close.addEventListener("click", closeReadingPanel);
  head.append(close);
  const candidate = document.createElement("p");
  candidate.className = "reading-panel__candidate";
  candidate.textContent = entry.candidate || "（第二路没有文字）";
  const actions = document.createElement("div");
  actions.className = "reading-panel__actions";
  const adopt = document.createElement("button");
  adopt.type = "button";
  adopt.className = "btn btn--pri btn--sm";
  adopt.textContent = "采用候选";
  adopt.addEventListener("click", () => draftReading(entry, "adopted", entry.candidate));
  const keep = document.createElement("button");
  keep.type = "button";
  keep.className = "btn btn--sm";
  keep.textContent = "保留原文";
  keep.addEventListener("click", () => draftReading(entry, "kept", null));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn btn--sm";
  edit.textContent = "自己改";
  edit.addEventListener("click", () => startReadingEdit(entry, panel));
  actions.append(adopt, keep, edit);
  panel.append(head, candidate, actions);
  // **结构上不可能被清掉**：面板挂进 `#reading-panel-host`，它不在 `#reading-stream` 里，
  // `renderReading({reset:true})` 怎么 `innerHTML=""` 都碰不到它。
  const host = el("reading-panel-host");
  if (!host) return;
  host.innerHTML = "";
  host.append(panel);
  host.hidden = false;
  injected.refreshReadingCurrentHighlight();
  if (entry.page_no && entry.page_no !== injected.getPageNo()) {
    updateReadingPage(entry.page_no, { scrollLeft: false, syncStream: false });
  }
  // 左右同时把这一行放到视口中央（右侧由 centerReadingLinePair 负责，不用 scrollIntoView：
  // 它在这套布局里会挑错滚动祖先）
  centerReadingLinePair(entry);
  // 打开候选时把这一行的行框画到左 PDF 上（显式动作，不依赖跟随开关）
  if (entry.bbox) {
    if (entry.page_no !== injected.getPageNo()) {
      injected.setReadingPendingBox( entry.bbox);
    } else {
      drawReadingPdfBox(entry.bbox, entry.page_no);
    }
  }
  // 行节点可能在这一帧之后才挂上（补窗口 / 重铺）：下一帧按同一个 key 再补一次高亮。
  // 面板元素在独立 host 里、跨重绘存活，所以这里不需要重开面板，只需要重挂 class。
  requestAnimationFrame(() => {
    if (injected.getReadingPanelKey() === key) injected.refreshReadingCurrentHighlight();
  });
}

function renderReadingTree() {
  const tree = el("reading-tree");
  if (!tree || !injected.getReadingTreeData()) return;
  const scrollTop = tree.scrollTop;
  tree.innerHTML = "";
  const stats = injected.getReadingTreeData().stats || {};
  const head = document.createElement("div");
  head.className = "reading-tree__head";
  const queueTotal = stats.total_items ?? stats.unacked ?? 0;
  head.textContent = `队列 ${queueTotal} 处`;
  if (stats.outside_items) head.title = `版心外 ${stats.outside_items} 处不进队列`;
  const outside = document.createElement("span");
  outside.className = "reading-tree__outside";
  outside.textContent =
    `版心外 ${stats.outside_items || 0}` +
    (stats.other_items ? ` · 其他 ${stats.other_items}` : "");
  outside.title = "版心外的差异与脚注 / 图注等非正文块不进阅读流队列";
  head.append(outside);
  tree.append(head);
  const flowPages = readingFlowPages();
  // 当前页自动展开：用户不用先找页、再展开，进来就能看到"这一页有哪几处、分别是什么"
  if (injected.getPageNo()) injected.getReadingTreeOpen().add(injected.getPageNo());
  const pages = injected.getReadingTreeData().pages || [];
  const fragment = document.createDocumentFragment();
  for (const page of pages) {
    if (!page.total && !page.unacked) continue;
    const wrap = document.createElement("div");
    wrap.className = "reading-tree__page";
    wrap.dataset.page = String(page.page_no);
    const open = injected.getReadingTreeOpen().has(page.page_no);
    if (open) wrap.classList.add("is-open");

    const row = document.createElement("button");
    row.type = "button";
    row.className = "reading-tree__row";
    row.dataset.page = String(page.page_no);
    if (page.unacked === 0) row.classList.add("is-done");
    const no = document.createElement("span");
    no.className = "reading-tree__no";
    const chevron = document.createElement("span");
    chevron.className = "reading-tree__chevron";
    chevron.textContent = "▶";
    no.append(chevron, document.createTextNode(`第 ${page.page_no} 页`));
    const count = document.createElement("span");
    count.className = "reading-tree__count";
    count.textContent = page.unacked ? `${page.unacked} 处` : "✓";
    row.append(no, count);

    const items = document.createElement("div");
    items.className = "reading-tree__items";
    items.hidden = !open;
    const entries = open ? readingEntriesForPage(page.page_no) : [];
    if (open && !entries.length) {
      const empty = document.createElement("div");
      empty.className = "reading-tree__item";
      empty.style.cursor = "default";
      const chars = Number(page.chars || 0);
      const punct = Number(page.punct || 0);
      empty.textContent = !flowPages.has(page.page_no)
        ? "这一页不在正文流里（前置页 / 版心外），导出不会包含它"
        : chars === 0 && punct > 0
          ? `这一页只有标点/空格差异（${punct} 处）——用工具条上的「标点差异」批量判`
          : "这一页的差异还没加载…";
      items.append(empty);
    }
    for (const entry of entries) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "reading-tree__item";
      item.dataset.key = injected.readingKey(entry.block_id, entry.line_index);
      const done = readingEntryDone(entry);
      if (done) item.classList.add("is-done");
      if (item.dataset.key === injected.getReadingPanelKey()) item.classList.add("is-current");
      const lineNo = document.createElement("span");
      lineNo.className = "reading-tree__line";
      lineNo.textContent = `行${entry.line_index + 1}`;
      item.append(lineNo, buildReadingTreePreview(entry));
      if (done) {
        const flag = document.createElement("span");
        flag.className = "reading-tree__flag";
        flag.textContent = "✓";
        item.append(flag);
      }
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        gotoReadingEntry(entry);
      });
      items.append(item);
    }

    row.addEventListener("click", () => {
      // 点头部：既导航到这一页，也展开/收起它
      if (injected.getReadingTreeOpen().has(page.page_no)) injected.getReadingTreeOpen().delete(page.page_no);
      else injected.getReadingTreeOpen().add(page.page_no);
      queueReadingIntent("scroll", { pageNo: page.page_no });
      renderReadingTree();
      // 这一页不在已加载的 marks 窗口里：补那一页 ±10，回来再铺条目
      if (
        injected.getReadingTreeOpen().has(page.page_no) &&
        !readingEntriesForPage(page.page_no).length &&
        flowPages.has(page.page_no)
      ) {
        ensureReadingMarksWindow(page.page_no).then(() => renderReadingTree());
      }
    });
    wrap.append(row, items);
    fragment.append(wrap);
  }
  tree.append(fragment);
  tree.scrollTop = scrollTop;
}

function scrollReadingToPage(pageNo) {
  const segments = injected.readingVisibleSegments();
  let index = segments.findIndex((segment) =>
    (segment.pages || []).some((page) => page.page_no === pageNo)
  );
  if (index < 0) return;
  jumpReadingTo(index);
  const node = injected.getReadingSegmentNodes()[index];
  if (!node) return;
  // **直接滚 `#reading-stream`**（它自己就是滚动容器，overflow:auto）。
  // `scrollIntoView` 在这里会挑到别的祖先滚动，正文实际没动——实测点左树
  // 页码变了、正文还停在第一页，就是这么来的。
  const stream = el("reading-stream");
  if (stream) {
    const top =
      node.getBoundingClientRect().top -
      stream.getBoundingClientRect().top +
      stream.scrollTop -
      8;
    stream.scrollTop = Math.max(0, top);
  } else {
    node.scrollIntoView({ block: "start", behavior: "auto" });
  }
  updateReadingPage(pageNo);
  markReadingTreeCurrent(pageNo);
}

function markReadingTreeCurrent(pageNo) {
  const tree = el("reading-tree");
  if (!tree) return;
  const wasOpen = injected.getReadingTreeOpen().has(pageNo);
  injected.getReadingTreeOpen().add(pageNo);        // 当前页永远展开：进来就能看到这一页有哪几处
  for (const row of tree.querySelectorAll(".reading-tree__row.is-current")) {
    row.classList.remove("is-current");
  }
  const row = tree.querySelector(`.reading-tree__row[data-page="${pageNo}"]`);
  if (row) row.classList.add("is-current");
  const pageEl = tree.querySelector(`.reading-tree__page[data-page="${pageNo}"]`);
  if (pageEl) pageEl.classList.add("is-open");
  // 换了页 / 上一页刚展开：条目要重新铺一次（只重画这一页，不动别的）
  if (!wasOpen || !pageEl || !pageEl.querySelector(".reading-tree__item[data-key]")) {
    renderReadingTree();
    const again = el("reading-tree").querySelector(`.reading-tree__row[data-page="${pageNo}"]`);
    if (again) {
      again.classList.add("is-current");
      again.scrollIntoView({ block: "nearest" });
    }
  }
  return;
}

/**
 * 跳到某个段：**不要**从头渲染到它（跨 800 段会卡 1 秒）。
 * 清掉正文流，从目标段前 2 段开始重新铺窗口——DOM 始终只挂视口附近的几十段。
 */
function jumpReadingTo(segmentIndex) {
  const segments = injected.readingVisibleSegments();
  if (segmentIndex < 0 || segmentIndex >= segments.length) return;
  // 目标段已经在 DOM 里就直接用；不在就从它前 2 段重新铺窗口。
  if (injected.getReadingSegmentNodes()[segmentIndex]) return;
  renderReading({ reset: true, startAt: Math.max(0, segmentIndex - 2) });
}

function ensureReadingPages() {
  if (!injected.getProject()) return;
  if (injected.getReadingStackProject() === injected.getProject().project_id && injected.getReadingTiles().size) return;
  buildReadingPages();
  observeReadingColumnResize();
}

/** 重建页列（换项目时）：490 个空壳，图和块都还空着。 */
function buildReadingPages() {
  const wrap = el("reading-pages");
  if (!wrap || !injected.getProject()) return;
  disconnectReadingObservers();
  wrap.innerHTML = "";
  const box = el("reading-pdf-box");
  injected.getReadingTiles().clear();
  injected.getReadingPageBlocks().clear();
  injected.getReadingBlockPromises().clear();
  injected.getReadingLoadedImages().clear();
  injected.setReadingImageQueue( []);
  injected.getReadingNearSet().clear();
  injected.getReadingVisibleSet().clear();
  injected.setReadingTops( []);
  const fragment = document.createDocumentFragment();
  for (const page of injected.getProject().pages) {
    const tile = document.createElement("div");
    tile.className = "reading-page";
    tile.dataset.pageNo = String(page.page_no);
    tile.style.aspectRatio = `${page.width_pt} / ${page.height_pt}`;
    const image = document.createElement("img");
    image.alt = `第 ${page.page_no} 页`;
    image.decoding = "async";
    const margin = document.createElement("div");
    margin.className = "page-margin";
    margin.hidden = true;
    const marginBox = document.createElement("div");
    marginBox.className = "page-margin__box";
    margin.append(marginBox);
    const overlay = document.createElement("div");
    overlay.className = "page-overlay page-overlay--readonly";
    overlay.hidden = true;
    tile.append(image, margin, overlay);
    injected.getReadingTiles().set(page.page_no, tile);
    fragment.append(tile);
  }
  wrap.append(fragment);
  // 页列重建会清空容器：字级色块层与跟随行框要重新挂回去
  const diffLayer = document.createElement("div");
  diffLayer.className = "reading-diff-layer";
  diffLayer.id = "reading-diff-layer";
  wrap.append(diffLayer);
  if (box) wrap.append(box);
  injected.setReadingStackProject( injected.getProject().project_id);
  observeReadingTiles();
}

function observeReadingTiles() {
  const scroller = el("reading-pdf-scroll");
  if (!scroller || typeof IntersectionObserver !== "function") return;
  const firstTile = injected.getReadingTiles().values().next().value;
  const tileHeight = firstTile ? firstTile.getBoundingClientRect().height : 0;
  const margin = tileHeight
    ? Math.max(600, Math.round(tileHeight * 2.5))
    : injected.READING_NEAR_MARGIN;
  injected.setReadingNearObserver( new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const tile = entry.target;
        const pageNo = Number(tile.dataset.pageNo);
        if (entry.isIntersecting) {
          injected.getReadingNearSet().add(pageNo);
          ensureReadingTile(pageNo);
        } else if (injected.getReadingNearSet().delete(pageNo)) {
          if (Math.abs(pageNo - (injected.getPageNo() || 1)) > injected.INDEX_IMAGE_WINDOW) releaseReadingImage(pageNo);
        }
      }
    },
    { root: scroller, rootMargin: `${margin}px 0px`, threshold: 0 }
  ));
  injected.setReadingVisibleObserver( new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const tile = entry.target;
        const pageNo = Number(tile.dataset.pageNo);
        if (entry.isIntersecting) {
          injected.getReadingVisibleSet().add(pageNo);
          ensureReadingTile(pageNo);
          injected.paintReadingTile(pageNo);
        } else if (injected.getReadingVisibleSet().delete(pageNo)) {
          clearReadingDecorations(pageNo);
        }
      }
      if (!injected.getReadingFollow()) updateReadingPageFromLeftScroll();
    },
    { root: scroller, rootMargin: "0px", threshold: 0 }
  ));
  for (const tile of injected.getReadingTiles().values()) {
    injected.getReadingNearObserver().observe(tile);
    injected.getReadingVisibleObserver().observe(tile);
  }
}

function refreshReadingImageProfiles(force = false) {
  const tiles = [...injected.getReadingTiles().values()];
  const sample = tiles.find((tile) => Number(tile.dataset.pageNo) === injected.getPageNo()) || tiles[0];
  if (!sample) return;
  const pageNo = Number(sample.dataset.pageNo);
  const wanted = injected.pageProfileFor(sample, pageNo);
  if (!force && (!injected.getReadingImageProfile() || wanted === injected.getReadingImageProfile())) {
    injected.setReadingImageProfile( wanted);
    return;
  }
  injected.setReadingImageProfile( wanted);
  // 任务 79：**不要先摘 src 再重取**——那会让页图空白一下（用户看到闪白）。
  // 先在离屏 Image 里把新档下完，加载完再换上去，旧图一直可见。
  for (const pageNo of [...injected.getReadingLoadedImages()]) warmSwapReadingImage(pageNo, wanted);
  // 页列宽度一变，tile 的宽高都跟着变：同一个 `scrollTop` 会落到别的页上。
  // 按"当前页码"重新锚定一次（用户的心智是"我在第几页"），再核对。
  if (injected.getPageNo()) scrollPdfColumnToPage(injected.getPageNo());
  verifyReadingPageSync("resize");
}

function observeReadingColumnResize() {
  const wrap = el("reading-pages");
  if (!wrap || injected.getReadingResizeObserver() || typeof ResizeObserver === "undefined") return;
  let timer = 0;
  injected.setReadingResizeObserver( new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (injected.getCurrentView() === "reading") refreshReadingImageProfiles();
    }, 250);
  }));
  injected.getReadingResizeObserver().observe(wrap);
}

function ensureReadingTile(pageNo) {
  ensureReadingImage(pageNo);
  ensureReadingBlocks(pageNo).then(() => injected.paintReadingTile(pageNo));
}

function retryReadingPendingPanel() {
  // 面板已经在宿主里（重绘碰不到它），但 `readingPanelKey` 可能被 reset 清成了 null：
  // 把当前项恢复回来，高亮才跟着回来。
  if (!injected.getReadingPendingPanelEntry() && !injected.getReadingPanelKey()) {
    const host = el("reading-panel-host");
    const stub = host && host.querySelector(".reading-panel");
    const key = stub && stub.dataset.key;
    if (key) { injected.setReadingPanelKey( key); injected.refreshReadingCurrentHighlight(); }
    return;
  }
  if (!injected.getReadingPendingPanelEntry()) return;
  const entry = injected.getReadingPendingPanelEntry();
  const key = injected.readingKey(entry.block_id, entry.line_index);
  if (!injected.readingLineNode(key)) return;      // 行还没挂上，等下一次数据到达
  clearPendingPanel();
  openReadingPanel(entry);
  logReadingNext(entry, { branch: "pending-open", reason: "data-arrived" });
}

function ensureReadingBlocks(pageNo) {
  if (injected.getReadingPageBlocks().has(pageNo)) return Promise.resolve(injected.getReadingPageBlocks().get(pageNo));
  const pending = injected.getReadingBlockPromises().get(pageNo);
  if (pending) return pending;
  const promise = injected.loadIndexBlocks(pageNo)
    .then((blocks) => {
      injected.getReadingPageBlocks().set(pageNo, blocks || []);
      // **块到了就重画**：差异行框/字框要 `readingPageBlocks` 非空才画得出来。
      // 跳转那一瞬块还没到 → `paintReadingDiffBoxes` 直接 return（一个框都不画），
      // 行节点也没有 → 面板开不出来。"面板与高亮同时消失"就是这一条（任务 84）。
      if (pageNo === injected.getPageNo()) {
        injected.paintReadingTile(pageNo);
        retryReadingPendingPanel();
      }
      return blocks || [];
    })
    .finally(() => injected.getReadingBlockPromises().delete(pageNo));
  injected.getReadingBlockPromises().set(pageNo, promise);
  return promise;
}

function setReadingHover(seq) {
  // `seq` 可能来自 dataset（字符串）：先统一成数字，否则异步回来时比对永远不相等
  const target = seq === null || seq === undefined || seq === ""
    ? null
    : Number(seq);
  if (target === injected.getReadingHoveredSeq()) return;
  for (const node of document.querySelectorAll("#reading-stream .reading-seg.is-hover")) {
    node.classList.remove("is-hover");
  }
  for (const box of document.querySelectorAll("#reading-pages .box.is-linked")) {
    box.classList.remove("is-linked");
  }
  injected.setReadingHoveredSeq( target);
  if (target === null) {
    for (const node of document.querySelectorAll("#reading-diff-layer .reading-diff-box")) {
      node.remove();
    }
    return;
  }
  const node = document.querySelector(`#reading-stream .reading-seg[data-seq="${target}"]`);
  if (node) node.classList.add("is-hover");
  const segment = (injected.readingVisibleSegments() || []).find((item) => item.seq === target);
  if (!segment) return;
  const pageNos = new Set((segment.line_spans || []).map((span) => span.page_no));
  for (const pageNo of pageNos) {
    ensureReadingBlocks(pageNo).then(() => {
      if (injected.getReadingHoveredSeq() !== target) return;
      injected.paintReadingTile(pageNo);
      injected.paintReadingDiffBoxes(pageNo);
    });
  }
}

function markReadingCurrentTile(pageNo) {
  for (const tile of document.querySelectorAll("#reading-pages .reading-page.is-current")) {
    tile.classList.remove("is-current");
  }
  const tile = injected.getReadingTiles().get(pageNo);
  if (tile) tile.classList.add("is-current");
}

/**
 * 左栏（PDF 页列）滚动 → 右侧正文跟到这一页的第一段（任务 72）。
 *
 * 用户原话：「滑动 PDF 页，右边文字不会跟着滑动」。之前只有"右带动左"，
 * 反向只有页码文字在变，正文不动。这里补上页级反向同步（故意不做行级映射：
 * 页级已经够用，行级要维护一条额外的对应表，容易错位）。
 *
 * **防打架**：同一个 `readingSyncDriver` 互斥——左先动就锁 350 ms，
 * 这段时间右栏自己的 scroll 回调不反向驱动左栏（否则会来回拉扯）。
 */
function updateReadingPageFromLeftScroll() {
  if (!injected.getReadingTops().length) return;
  const scroller = el("reading-pdf-scroll");
  if (!scroller) return;
  const anchor = scroller.scrollTop + scroller.clientHeight * 0.25;
  let best = injected.getReadingTops()[0];
  for (const entry of injected.getReadingTops()) {
    if (entry.top <= anchor) best = entry;
    else break;
  }
  if (!best) return;
  if (best.pageNo === injected.getPageNo()) return;
  // **跳转落位期间左栏一律不写**：`gotoReadingEntry` 自己的滚动会触发这里，
  // 此时左栏锚点还停在上一页，写进去就把刚定位好的页码改掉（QA run F：
  // gotoEntry 写 118 → leftScroll 写 117，两个回调隔着几十毫秒，后者赢）。
  if (injected.getReadingJumpSettleKey()) return;
  // **这次滚动是谁发的，才是判据**——不是差值阈值，也不是"面板开没开"。
  //
  // QA 十轮 196/200 抓到的两处漏挡都出在"用 |Δ| 判"上：
  //   · |Δ|==2 直接放过（C 轮 面板 59 / 左栏算出 61 → 顶部与左栏都成 61）；
  //   · |Δ|==1 本该挡，但补窗口前 `readingMarks.get(panelKey)` 是 undefined，
  //     整段保护被跳过（H 149/148、I 194/193）。
  // 而"面板开着就一律不写"又会把用户真正滚左栏时的跟随也挡掉（smoke：滚到 120 页，顶部仍 99）。
  //
  // 所以只看事件来源：`scrollPdfColumnToPage()` 是**我们**滚的，它会把当时的用户事件计数
  // 记进 `readingProgramScrollSeq`；左栏回调里两者相等 → 这次滚动没有用户输入参与 → 不写页码。
  // 用户 wheel / pointerdown / keydown 会让 `readingUserScrollSeq` +1，之后左栏滚动照常跟随。
  if (injected.getReadingUserScrollSeq() === injected.getReadingProgramScrollSeq()) return;
  injected.setReadingPageNo( best.pageNo);
  el("reading-page-no").textContent = `第 ${best.pageNo} 页`;
  markReadingCurrentTile(best.pageNo);
  markReadingTreeCurrent(best.pageNo);
  if (
    injected.getReadingFollow() &&
    performance.now() > injected.getReadingSuppressFollowUntil() &&
    !readingDriverActive("left")
  ) {
    markReadingDriver("left");
    scrollStreamToPage(best.pageNo);
  }
}

/**
 * 把右侧正文滚到"这一页的第一段"，并把这一段设为当前段。
 * 页级就够：用户要的是"翻到这一页"，不是精确到某一行。
 */
function scrollStreamToPage(pageNo) {
  if (!injected.getReadingData()) return;
  const segments = injected.readingVisibleSegments();
  if (!segments.length) return;
  let index = segments.findIndex((segment) =>
    (segment.line_spans || []).some((span) => Number(span.page_no) >= pageNo)
  );
  if (index < 0) index = segments.length - 1;
  jumpReadingTo(index);
  const node = injected.getReadingSegmentNodes()[index];
  if (!node) return;
  node.scrollIntoView({ block: "start", behavior: "auto" });
  setReadingHover(String(segments[index].seq));
  markReadingTreeCurrent(pageNo);
  // 跳的过程中正文会触发自己的 scroll 回调，可能把页码改回去：这里钉一下
  injected.setReadingPageNo( pageNo);
  const label = el("reading-page-no");
  if (label) label.textContent = `第 ${pageNo} 页`;
  markReadingCurrentTile(pageNo);
}

function verifyReadingPageSync(reason = "", { fix = true } = {}) {
  clearTimeout(injected.getReadingPageSyncTimer());
  injected.setReadingPageSyncTimer( setTimeout(() => {
    if (injected.getCurrentView() !== "reading" || !injected.getPageNo()) return;
    const scroller = el("reading-pdf-scroll");
    if (!scroller) return;
    // 用户正在自己滚左栏：这时候"顶部那一页"本来就会短暂等于中间页，别纠正（会打架）
    if (performance.now() - injected.getReadingUserMovedAt() < 400) return;
    // 用和"左栏滚动 → 页码"同一个锚点（视口 25% 处的那一页），否则会把顶部露出
    // 46px 的上一页判成当前页（实测 label 39 / tilePage 38 那种假不一致）
    const top = scroller.getBoundingClientRect().top;
    // 用**视口中心**判定"当前是哪一页"：居中定位时当前行就在中心；
    // 用 25% 会把"页面顶部落在中心线以下"的正常情况判成上一页（实测 20 次里 17 次误报）
    // 主导页 = **覆盖视口面积最大的 tile**（QA 定；固定 25% 线会常态性假阴性）
    let tilePage = null;
    let bestArea = 0;
    const viewTop = top;
    const viewBottom = top + scroller.clientHeight;
    for (const [pageNo, tile] of injected.getReadingTiles()) {
      const rect = tile.getBoundingClientRect();
      const overlap = Math.min(rect.bottom, viewBottom) - Math.max(rect.top, viewTop);
      if (overlap > bestArea) {
        bestArea = overlap;
        tilePage = pageNo;
      }
    }
    // 三方一致：当前差异项所在页 == 顶部页码 == 左侧可见页。
    // 只看前两个数会漏掉真正错的情况（面板第 13 页、顶部与左侧都是第 28 页 → ok:true）。
    const panelMark = injected.getReadingPanelKey() ? injected.getReadingMarks().get(injected.getReadingPanelKey()) : null;
    const panelPage = panelMark && panelMark.page_no ? Number(panelMark.page_no) : null;
    const ok = tilePage === injected.getPageNo() && (!panelPage || panelPage === injected.getPageNo());
    const record = {
      reason,
      label: injected.getPageNo(),
      tilePage,
      panelPage,
      ok,
      scrollTop: Math.round(scroller.scrollTop),
      at: Date.now(),
    };
    // 留最近 5 次（用户报"左右不对应"时，前一次的状态往往才是线索）
    injected.getReadingPageSyncLog().unshift(record);
    injected.getReadingPageSyncLog().length = Math.min(injected.getReadingPageSyncLog().length, 5);
    window.__b2tPageSync = record;
    window.__b2tPageSyncLog = injected.getReadingPageSyncLog();
    if (fix && !ok && !injected.getReadingPageSyncFixing()) {
      // **纠正，不只是记录**。以"当前差异项所在页"为准（那才是用户正在看的东西）
      injected.setReadingPageSyncFixing( true);
      if (panelPage && panelPage !== injected.getPageNo()) {
        queueReadingIntent("goto", { pageNo: panelPage, scrollLeft: true, syncStream: false });
      } else {
        scrollPdfColumnToPage(injected.getPageNo());
      }
      // 纠正本身会再触发一次滚动：150 ms 后补一次核对（只核对、不再纠正，避免来回抖）
      setTimeout(() => {
        injected.setReadingPageSyncFixing( false);
        verifyReadingPageSync("afterFix", { fix: false });
      }, 150);
    }
  }, 130));
}

function updateReadingPage(pageNo, { scrollLeft = true, syncStream = true } = {}) {
  if (!injected.getProject()) return;
  const total = injected.getProject().pages.length;
  if (!pageNo || pageNo < 1 || pageNo > total) return;
  injected.setReadingPageNo( pageNo);
  // 任务 67：翻到窗口外的页就补那一页 ±10 的 marks（异步，不挡翻页）
  if (injected.getReadingData()) ensureReadingMarksWindow(pageNo);
  hideReadingPdfBox();
  el("reading-page-no").textContent = `第 ${pageNo} 页`;
  el("reading-prev").disabled = pageNo <= 1;
  el("reading-next").disabled = pageNo >= total;
  ensureReadingPages();
  ensureReadingTile(pageNo);
  markReadingCurrentTile(pageNo);
  if (scrollLeft) scrollPdfColumnToPage(pageNo);
  // 任务 72：点左树 / 翻页按钮 → 右侧正文跟到这一页第一段（页级反向同步的另一半）。
  // 只在"不是右栏自己在驱动"时做，否则会互相拉扯。
  if (syncStream && injected.getReadingFollow() && injected.getReadingData() && !readingDriverActive("right")) {
    markReadingDriver("left");
    scrollStreamToPage(pageNo);
  }
  if (injected.getReadingPendingBox()) {
    drawReadingPdfBox(injected.getReadingPendingBox(), pageNo);
    injected.setReadingPendingBox( null);
  }
  markReadingTreeCurrent(pageNo);
  verifyReadingPageSync("updateReadingPage");
}

function gotoReadingEntry(entry) {
  if (!entry || !entry.page_no) return;
  // **先驱动"我在第几页"**：顶部页码 + 左侧 PDF + 左树高亮。
  // 原来这里先找行、找不到就 `return`，于是页码和左侧 PDF 根本没动——
  // 用户看到的是"面板第 13 页、顶部第 28 页、左边第 28 页"（现场就是这么来的）。
  setPanel(entry);      // 跨 reset 存活：重绘后由 retryReadingPendingPanel 补开
  // 边 9 不切（顺序依赖）：updateReadingPage 必须在 openReadingPanel 之前发起。
  // 入队后它里面的 ensureReadingMarksWindow 会拖到面板打开之后，marks 回来的重绘
  // 会把刚开的面板按"无 key + 无 pending"的清尾规则藏掉（QA 四态对照：回同步 60/60）。
  updateReadingPage(entry.page_no, { syncStream: false, scrollLeft: false });
  suppressReadingFollow();
  scrollPdfColumnToPage(entry.page_no);
  const segments = injected.readingVisibleSegments();
  const index = segments.findIndex((segment) => segment.seq === entry.seq);
  // 边 8 不切（顺序依赖）：jump 的 reset 必须早于下面的 openReadingPanel。
  // 入队后它在帧末跑，reset 会把刚开的面板按"无 key + 无 pending"的清尾规则藏掉（QA：2/60）。
  if (index >= 0) jumpReadingTo(index);
  const key = injected.readingKey(entry.block_id, entry.line_index);
  let line = injected.readingLineNode(key);
  if (!line) {
    // 目标段不在已挂载的窗口里：按它的下标重铺一次（不固定 sleep，靠渲染完成后再查）。
    // 走同一个 helper，顺带覆盖"条目没有 seq"（左树）的情况。
    line = ensureReadingLineRendered(entry);
  }
  if (line) centerReadingLinePair(entry);
  if (!injected.getReadingDrafts().has(key)) openReadingPanel(entry);
  // 从这里开始到目标行真正进视口之前，页码同步一律不写（否则会被顶行的上一页改写）
  injected.setReadingJumpSettleKey( key);
  injected.setReadingJumpSettleTicks( 0);
  const settled = settlePanel(entry);
  // 偶发"跳到了但没有面板/没有当前项"（QA 2/20）：面板没建起来就再开一次，
  // 并把原因记进 __b2tNextLog。第二次仍失败也记下来，不静默。
  if (!settled) {
    let reason = "no-line";
    const seg = injected.readingVisibleSegments()[index];
    if (!seg) reason = "no-segment";
    else if (!injected.readingLineNode(key)) reason = "line-not-mounted";
    setTimeout(() => {
      if (!document.querySelector("#reading-panel-host .reading-panel")) openReadingPanel(entry);
      logReadingNext(entry, { branch: "retry", reason, retried: true });
    }, 260);
  }
  verifyReadingPageSync("gotoEntry");
}

  // ---------------------------------------------------------------- 审校环·图片泵（任务 94 · L6 刀1）
  // 从 app.js 原样搬入；依赖由 init() 注入。状态仍归 app.js（get/set）。

/** 预热新档，加载完再换上去（换的时候旧图还在，不闪白）。 */
function warmSwapReadingImage(pageNo, profile) {
  const tile = injected.getReadingTiles().get(pageNo);
  const image = tile ? tile.querySelector("img") : null;
  if (!image) return;
  const url = injected.pageImageUrl(pageNo, profile);
  if (image.src && image.src.endsWith(url)) return;
  const warm = new Image();
  warm.onload = () => {
    image.src = url;
    image.classList.add("is-ready");
    delete image.dataset.pending;
  };
  warm.onerror = () => {
    // 新档拿不到就保持旧图，不制造空白
  };
  warm.src = url;
}

function ensureReadingImage(pageNo) {
  const tile = injected.getReadingTiles().get(pageNo);
  if (!tile) return;
  const image = tile.querySelector("img");
  if (!image || injected.getReadingLoadedImages().has(pageNo) || image.dataset.pending) return;
  // 任务 80：同目录确认——先摘掉上一轮残留的 onload/onerror，再挂占位图。
  // 否则占位图加载完会触发旧闭包，把 thumb 标成 `is-ready`，这一页就永远停在模糊的缩略图上。
  image.onload = null;
  image.onerror = null;
  showReadingPlaceholder(pageNo, image);
  image.dataset.pending = "1";
  injected.getReadingImageQueue().push(pageNo);
  pumpReadingImages();
}

/** 图一张一张解：一次跳 300 页时同时解 7 张大图会出一帧近 1 秒的长帧。 */
function pumpReadingImages() {
  if (injected.getReadingImagePumping()) return;
  injected.setReadingImagePumping( true);
  const step = () => {
    const pageNo = injected.getReadingImageQueue().shift();
    if (!pageNo) {
      injected.setReadingImagePumping( false);
      return;
    }
    const tile = injected.getReadingTiles().get(pageNo);
    if (!tile) {
      step();
      return;
    }
    const image = tile.querySelector("img");
    if (!image) {
      step();
      return;
    }
    injected.getReadingLoadedImages().add(pageNo);
    image.onload = () => {
      // 占位图（thumb）自己的加载**不算**这一页好了：只有目标档位到了才收尾。
      // 否则会在排队等待期间被旧闭包抢先触发，把缩略图标成 `is-ready`。
      if ((image.getAttribute("src") || "").includes("size=thumb")) return;
      image.classList.add("is-ready");
      delete image.dataset.pending;
      // 任务 80：占位类一起摘（它带 blur(1.5px)，留着就成了"高清图 + 永久模糊"）
      injected.clearImagePlaceholder(image);
      const status = el("reading-image-status");
      if (status) status.hidden = true;
      injected.paintReadingTile(pageNo);
      step();
    };
    image.onerror = () => {
      delete image.dataset.pending;
      // 取图失败：**不能把模糊的缩略图留在那里冒充最终图**（用户分不清"糊"和"还没来"），
      // 也不能把这一页留在 readingLoadedImages 里——那样它再也不会被重取。
      injected.clearImagePlaceholder(image);
      image.classList.remove("is-ready");
      image.removeAttribute("src");
      injected.getReadingLoadedImages().delete(pageNo);
      const attempts = Number(tile.dataset.imageAttempts || 0) + 1;
      tile.dataset.imageAttempts = String(attempts);
      if (attempts <= 2 && injected.getCurrentView() === "reading" && injected.getReadingTiles().has(pageNo)) {
        setTimeout(() => {
          if (injected.getCurrentView() === "reading" && injected.getReadingTiles().has(pageNo)) ensureReadingImage(pageNo);
        }, 600);
      } else {
        markReadingImageFailed(pageNo);
      }
      step();
    };
    // 任务 75：**量外层页块**，不要量 `<img>` 自己。图在加载完成前是隐藏的
    // （`display:none` / 还没 `is-ready`），`getBoundingClientRect().width` 是 **0**
    // → need=0 → 永远拿到 `view`（150 DPI）。目录确认用的是外层 wrap，所以那边是好的。
    const profile = injected.pageProfileFor(tile, pageNo);
    image.src = injected.pageImageUrl(pageNo, profile);
  };
  step();
}

function releaseReadingImage(pageNo) {
  const tile = injected.getReadingTiles().get(pageNo);
  const image = tile ? tile.querySelector("img") : null;
  if (!image) return;
  // 摘 `src` 不会触发 onload/onerror：先把闭包摘掉，免得下一张图（或占位图）误触发旧逻辑
  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
  image.classList.remove("is-ready");
  injected.clearImagePlaceholder(image);
  delete image.dataset.pending;
  injected.getReadingLoadedImages().delete(pageNo);
}

/**
 * 三次取图都失败：留一张**不带模糊**的低分辨率占位 + 一个可点的重试。
 *
 * 不留"模糊的缩略图"——用户分不清"这张图糊"和"还没加载完"；
 * 也不留一块空白——那等于告诉用户"这一页不存在"。
 */
function markReadingImageFailed(pageNo) {
  const tile = injected.getReadingTiles().get(pageNo);
  if (!tile) return;
  const image = tile.querySelector("img");
  if (image) {
    // 摘掉闭包再挂缩略图：否则缩略图也失败时会再触发本函数，attempts 会自激涨到几万次
    image.onload = null;
    image.onerror = null;
    injected.clearImagePlaceholder(image);
    image.classList.remove("is-ready");
    if (!image.getAttribute("src")) image.src = injected.pageImageUrl(pageNo, "thumb");
  }
  tile.dataset.imageFailed = "1";
  if (tile.querySelector(".reading-image-retry")) return;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "index-image-retry reading-image-retry";
  retry.textContent = "这一页的图像读不出来 · 点这里重试";
  retry.addEventListener("click", () => {
    retry.remove();
    delete tile.dataset.imageFailed;
    delete tile.dataset.imageAttempts;
    ensureReadingImage(pageNo);
  });
  tile.append(retry);
  if (pageNo === injected.getPageNo()) {
    const status = el("reading-image-status");
    if (status) {
      status.hidden = false;
      status.textContent = `第 ${pageNo} 页的图像读不出来（渲染超时或失败）`;
    }
  }
}

function clearReadingDecorations(pageNo) {
  const tile = injected.getReadingTiles().get(pageNo);
  if (!tile) return;
  injected.clearPageBlocks(tile);
  injected.clearTileMargin(tile);
}

function disconnectReadingObservers() {
  if (injected.getReadingNearObserver()) injected.getReadingNearObserver().disconnect();
  if (injected.getReadingVisibleObserver()) injected.getReadingVisibleObserver().disconnect();
  injected.setReadingNearObserver( null);
  injected.setReadingVisibleObserver( null);
}

  // ---------------------------------------------------------------- 审校环·编辑 / 树预显 / 正文段（任务 94 · L6 刀2）
  // 从 app.js 原样搬入；依赖由 init() 注入。状态仍归 app.js（get/set）。

function saveReadingInlineEdits() {
  try {
    const items = [...injected.getReadingInlineEdits().entries()].map(([key, value]) => ({
      key,
      base: value.base,
      text: value.text,
      at: value.at,
    }));
    localStorage.setItem(
      readingInlineStorageKey(),
      JSON.stringify({ items, savedAt: Date.now() })
    );
  } catch {
    /* 存不下不影响当前会话 */
  }
}

function startReadingEdit(entry, panel) {
  const key = injected.readingKey(entry.block_id, entry.line_index);
  const line = injected.readingLineNode(key);
  if (!line) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "reading-panel__input";
  input.value = line.textContent.replace(/草稿.*$/, "").trim();
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn--pri btn--sm";
  save.textContent = "存草稿";
  save.addEventListener("click", () => draftReading(entry, null, input.value));
  const row = document.createElement("div");
  row.className = "reading-panel__edit";
  row.append(input, save);
  panel.append(row);
  input.focus();
  input.select();
}

function hideReadingPanelHost() {
  // 只清 DOM，不动 pending / key：给"重绘后没有待恢复面板"的收尾用
  const host = el("reading-panel-host");
  if (host && host.querySelector(".reading-panel")) {
    host.innerHTML = "";
    host.hidden = true;
  }
}

/**
 * 一条差异的预览：差异前后各留 10 个字，差异部分用 `<mark>` 标出来。
 *
 * 只做显示：文本全部来自 `segment.text` 的切片，不拼、不补、不占位。
 */
function buildReadingTreePreview(entry) {
  const wrap = document.createElement("span");
  wrap.className = "reading-tree__preview";
  const lineText = readingEntryLineText(entry);
  if (!lineText) {
    wrap.textContent = (entry.candidate || "").slice(0, 40) || "（这一页的差异还没加载）";
    return wrap;
  }
  const spans = injected.computeCharSpans(lineText, entry.candidate || "");
  if (!spans.length) {
    wrap.textContent = lineText.slice(0, 40);
    return wrap;
  }
  const first = spans[0];
  const from = Math.max(0, first.aStart - 10);
  const to = Math.min(lineText.length, Math.max(first.aEnd, first.aStart + 1) + 10);
  if (from > 0) wrap.append(document.createTextNode("…"));
  if (first.aStart > from) {
    wrap.append(document.createTextNode(lineText.slice(from, first.aStart)));
  }
  const mark = document.createElement("mark");
  mark.textContent = lineText.slice(first.aStart, Math.max(first.aEnd, first.aStart + 1));
  wrap.append(mark);
  if (to > Math.max(first.aEnd, first.aStart + 1)) {
    wrap.append(document.createTextNode(lineText.slice(Math.max(first.aEnd, first.aStart + 1), to)));
  }
  if (to < lineText.length) wrap.append(document.createTextNode("…"));
  return wrap;
}

/** 这一页在已加载窗口里的差异条目（按文档顺序）。 */
function readingEntriesForPage(pageNo) {
  return injected.getReadingEntries()
    .filter((entry) => entry.page_no === pageNo && injected.readingEntryVisible(entry))
    .sort((a, b) => {
      const oa = readingMarkOrder(a);
      const ob = readingMarkOrder(b);
      for (let i = 0; i < oa.length; i += 1) {
        if (oa[i] !== ob[i]) return oa[i] - ob[i];
      }
      return 0;
    });
}

function readingEntryDone(entry) {
  if (entry.ack) return true;
  return injected.getReadingDrafts().has(injected.readingKey(entry.block_id, entry.line_index));
}

/** 正文流里出现过的页号（前置页 / 版心外的页不在里面）。 */
function readingFlowPages() {
  const set = new Set();
  for (const segment of injected.getReadingData() ? injected.getReadingData().segments || [] : []) {
    for (const page of segment.pages || []) set.add(page.page_no);
  }
  return set;
}

function removeReadingSentinel() {
  const stream = el("reading-stream");
  if (!stream) return;
  for (const node of stream.querySelectorAll(".reading-sentinel")) node.remove();
}

  // ---------------------------------------------------------------- 审校环·滚动与页框叶子（任务 94 · L6 刀3）
  // 从 app.js 原样搬入；依赖由 init() 注入。状态仍归 app.js（get/set）。

function buildReadingSegment(segment) {
  const node = document.createElement("div");
  node.className = "reading-seg";
  node.dataset.seq = String(segment.seq);
  const pages = (segment.pages || []).map((page) => page.page_no);
  if (pages.length) node.dataset.pages = pages.join(" ");
  if (injected.getReadingProof() && pages.length) {
    const range = document.createElement("span");
    range.className = "reading-proof__pages";
    range.textContent =
      pages.length > 1 ? `第 ${pages[0]}–${pages[pages.length - 1]} 页` : `第 ${pages[0]} 页`;
    node.append(range);
  }
  const spans = segment.line_spans || [];
  if (!spans.length) {
    node.append(document.createTextNode(segment.text));
    return node;
  }
  // 任务 82：**连续切片**——每一行拿 `[cursor, 下一行起点)`，cursor 一路向后不跳不叠。
  // 这样把整段切成 N 段连续的切片，拼起来逐字等于 `segment.text`：
  // 行间分隔符（join_lines 补的空格）自然落在前一行末尾，既不会丢、也不会重复。
  // 之前"每行只切 [start,end] + 额外补 gap 节点"的做法，在 line_spans 有重叠/重复时
  // 会让同一个字符既在 gap 里、又在相邻行切片里——实测出现 `laboreefficient`。
  let cursor = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const start = Math.max(cursor, Number(spans[i].start) || 0);
    const nextStart =
      i + 1 < spans.length
        ? Math.max(start, Number(spans[i + 1].start) || start)
        : segment.text.length;
    const piece = segment.text.slice(start, nextStart);
    const line = injected.buildReadingLine(segment, span_at(spans, i), piece);
    // 任务 66：块边界要**看得见**。跨页段在视觉上是一段连贯的话，
    // 实际是两个块；不标出来，用户会以为能跨过去改（这本书有 312 个跨页段）。
    if (i + 1 < spans.length && spans[i + 1].block_id !== spans[i].block_id) {
      line.classList.add("is-block-end");
      line.title = "此处是块 / 页边界，下一段属于另一个块（编辑不会跨过去）";
    }
    node.append(line);
  }
  checkReadingSegmentText(node, segment);
  return node;
}

/** 把 `scroller` 滚到"让 `target` 的中点落在视口垂直中央"，贴边时夹住不抖。 */
function scrollScrollerToCenter(scroller, targetTop, targetHeight) {
  if (!scroller) return;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const wanted = targetTop + targetHeight / 2 - scroller.clientHeight / 2;
  scroller.scrollTop = Math.max(0, Math.min(wanted, max));
}

/** 我们自己滚左栏（居中）时，别让"左→右跟随"把右栏拽回页首。 */
function suppressReadingFollow(ms = 700) {
  injected.setReadingSuppressFollowUntil( performance.now() + ms);
}

/** 把**左侧 PDF 页列**滚到某一页（任务 72 前它也叫 scrollReadingToPage，
 *  同名把"右侧正文跳到这一页"那份覆盖掉了 —— 点左树不跳页就是它造成的）。 */
function scrollPdfColumnToPage(pageNo) {
  const scroller = el("reading-pdf-scroll");
  const tile = injected.getReadingTiles().get(pageNo);
  if (!scroller || !tile) return;
  const top = tile.offsetTop - scroller.clientHeight * 0.06;
  const target = Math.max(0, top);
  // 这次滚动是我们发的：把用户事件计数记下来，左栏回调据此判定"不是用户在滚"
  injected.setReadingProgramScrollSeq( injected.getReadingUserScrollSeq());
  if (Math.abs(scroller.scrollTop - target) > 8) scroller.scrollTop = target;
}

/** 左→右 / 右→左的互斥标记：谁先动谁锁 350 ms。 */
function markReadingDriver(driver) {
  injected.setReadingSyncDriver( driver);
  injected.setReadingSyncUntil( performance.now() + 350);
}

function readingDriverActive(driver) {
  return injected.getReadingSyncDriver() === driver && performance.now() < injected.getReadingSyncUntil();
}

function hideReadingPdfBox() {
  const box = el("reading-pdf-box");
  if (box) box.hidden = true;
  injected.setReadingPendingBox( null);
}

function drawReadingPdfBox(bbox, pageNo) {
  const box = el("reading-pdf-box");
  const tile = injected.getReadingTiles().get(pageNo);
  if (!box || !tile || !Array.isArray(bbox) || bbox.length !== 4) return;
  const [x0, y0, x1, y1] = bbox;
  const width = tile.clientWidth || tile.getBoundingClientRect().width;
  const height = tile.clientHeight || tile.getBoundingClientRect().height;
  box.style.left = `${Math.round(x0 * width)}px`;
  box.style.top = `${Math.round(tile.offsetTop + y0 * height)}px`;
  box.style.width = `${Math.round((x1 - x0) * width)}px`;
  box.style.height = `${Math.round((y1 - y0) * height)}px`;
  box.hidden = false;
}

/** 记一条「下一处未审」的现场（最近 20 条），下次偶发失败时一条日志定位。 */
function logReadingNext(entry, extra = {}) {
  injected.getReadingNextLog().unshift({
    at: Date.now(),
    entryKey: entry ? injected.readingKey(entry.block_id, entry.line_index) : null,
    entryPage: entry ? entry.page_no : null,
    pageNo: injected.getPageNo(),
    panelKey: injected.getReadingPanelKey(),
    panelOpened: Boolean(document.querySelector("#reading-panel-host .reading-panel")),
    lineFound: entry ? Boolean(injected.readingLineNode(injected.readingKey(entry.block_id, entry.line_index))) : false,
    window: injected.getReadingMarksWindow(),
    blocks: entry ? (injected.getReadingPageBlocks().get(entry.page_no) || []).length : null,
    ...extra,
  });
  injected.getReadingNextLog().length = Math.min(injected.getReadingNextLog().length, 20);
  window.__b2tNextLog = injected.getReadingNextLog();
}

  // ---------------------------------------------------------------- 审校环叶子（任务 94 · L7）
  // 从 app.js 原样搬入；依赖由 init() 注入。状态仍归 app.js（get/set）。

/** 就地编辑草稿的存储键（与逐行裁决草稿分开：一个是改字，一个是裁决）。 */
function readingInlineStorageKey() {
  return injected.getProject() ? `b2t.readingInline.${injected.getProject().project_id}` : "";
}

function readingMarkOrder(entry) {
  return [Number(entry.seq) || 0, Number(entry.span_index) || 0, Number(entry.page_no) || 0];
}

function checkReadingSegmentText(node, segment) {
  if (!textCheckEnabled()) return;
  // 角标 / 折叠提示 / 页范围这些是**渲染附加物**，不属于正文，比较前摘掉
  const clone = node.cloneNode(true);
  for (const extra of clone.querySelectorAll(
    ".reading-chip, .reading-fold, .reading-proof__pages, .reading-mark__hint"
  )) {
    extra.remove();
  }
  const shown = clone.textContent || "";
  const expected = segment.text || "";
  if (shown === expected) return;
  let i = 0;
  while (i < shown.length && i < expected.length && shown[i] === expected[i]) i += 1;
  const from = Math.max(0, i - 20);
  console.error(
    `[文本自检] 第 ${segment.seq} 段右栏显示与导出不一致（第 ${i} 个字符起）\n` +
      `  显示: …${shown.slice(from, i + 20)}…\n` +
      `  导出: …${expected.slice(from, i + 20)}…`
  );
  window.__b2tTextCheckFails = (window.__b2tTextCheckFails || 0) + 1;
}

function span_at(spans, index) {
  return spans[index];
}

function draftReading(entry, ack, text) {
  const key = injected.readingKey(entry.block_id, entry.line_index);
  injected.getReadingDrafts().set(key, {
    block_id: entry.block_id,
    line_index: entry.line_index,
    page_no: entry.page_no,
    ack,
    text: text == null ? undefined : text,
    old_text: entry.current || "",
    at: new Date().toISOString(),
  });
  saveReadingDrafts();
  closeReadingPanel();
  rerenderReadingLine(entry);
  injected.renderReadingProgress();
}

function readingEntryLineText(entry) {
  for (const segment of injected.readingVisibleSegments() || []) {
    if (segment.seq !== entry.seq) continue;
    for (const span of segment.line_spans || []) {
      if (span.block_id !== entry.block_id || span.line_index !== entry.line_index) continue;
      return segment.text.slice(span.start, span.end);
    }
  }
  return "";
}

/** 低分辨率占位（同目录确认）：先让用户看到"像什么"，高精度随后替换。 */
function showReadingPlaceholder(pageNo, image) {
  if (!image || image.dataset.placeholder === "1") return;
  if (image.classList.contains("is-ready") || image.getAttribute("src")) return;
  image.dataset.placeholder = "1";
  image.classList.add("is-placeholder");
  image.src = injected.pageImageUrl(pageNo, "thumb");
}

  // ---------------------------------------------------------------- 审校环·草稿 / 进度 / 面板（任务 94 · L8）
  // 从 app.js 原样搬入；依赖由 init() 注入。状态仍归 app.js（get/set）。

function saveReadingDrafts() {
  try {
    localStorage.setItem(
      injected.readingDraftStorageKey(),
      JSON.stringify({
        at: new Date().toISOString(),
        items: [...injected.getReadingDrafts().values()],
      })
    );
  } catch {
    /* localStorage 满了也不该挡审校 */
  }
}

/**
 * **常驻自检：右栏显示的字必须和导出的一字不差**（任务 79，默认关闭）。
 *
 * 开法：地址栏加 `?checktext=1`，或在控制台 `window.__b2tTextCheck = true`。
 *
 * 为什么需要：这类 bug（字符规范化只改块不改行、行文本没同步、行间空格被丢）
 * **不抛异常、不弄红测试、也不让 CER 变差**——只会让用户审到错的东西。
 * 已经被咬过三次，所以每次验收都把它打开。
 */
function textCheckEnabled() {
  if (window.__b2tTextCheck) return true;
  try {
    return new URLSearchParams(location.search).get("checktext") === "1";
  } catch {
    return false;
  }
}

function closeReadingPanel() {
  const host = el("reading-panel-host");
  if (host) { host.innerHTML = ""; host.hidden = true; }
  injected.setReadingJumpSettleKey( null);
  // 用户主动关 = 真的关；重绘导致的移除走 renderReading，不清 pending
  clearPendingPanel();
  const stream = el("reading-stream");
  if (!stream) return;
  for (const node of stream.querySelectorAll(".reading-panel")) node.remove();
  injected.setReadingPanelKey( null);
  injected.refreshReadingCurrentHighlight();
}

function rerenderReadingLine(entry) {
  const key = injected.readingKey(entry.block_id, entry.line_index);
  const line = injected.readingLineNode(key);
  if (!line) return;
  const segment = injected.readingVisibleSegments().find((seg) =>
    (seg.line_spans || []).some(
      (span) => injected.readingKey(span.block_id, span.line_index) === key
    )
  );
  if (!segment) return;
  const span = (segment.line_spans || []).find(
    (item) => injected.readingKey(item.block_id, item.line_index) === key
  );
  const fresh = injected.buildReadingLine(segment, span);
  line.replaceWith(fresh);
}

/** 挂起"重绘后要补开的面板"：key 由 entry 推出，entry 跨 reset 存活（重绘后由 retryReadingPendingPanel 补开）。 */
function setPanel(entry) {
  injected.setReadingPendingPanelKey( injected.readingKey(entry.block_id, entry.line_index));
  injected.setReadingPendingPanelEntry( entry);
}

/** 清掉挂起项：用户主动关面板，或补开 / 落位已经成功。 */
function clearPendingPanel() {
  injected.setReadingPendingPanelKey( null);
  injected.setReadingPendingPanelEntry( null);
}

/**
 * 跳转落位结算：面板已经开出来就清挂起；没开出来就重新挂起并返回 false，
 * 交给调用方安排重试（期间任何一次重绘都由 retryReadingPendingPanel 补开）。
 */
function settlePanel(entry) {
  if (document.querySelector("#reading-panel-host .reading-panel")) {
    clearPendingPanel();
    return true;
  }
  setPanel(entry);
  return false;
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
    // 未 init 时保持搬走前的 no-op（原 enter 注入项没接上时也是空转）；生产 boot 必注入 getProject
    if (!injected.getProject) return;
    clearReadingIntents(true);
    injected.setReviewOverlaysForReading?.();
    openReading();
  }

  function exit() {
    clearReadingIntents(true);
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
    // 偏好与布局已回收为模块内部函数（Slice 2 收尾）：app.js 侧 0 个消费者，
    // 5 个临时转发导出已删除——公开接口收敛到 6 个稳定项，只降不升。
  };
})();
