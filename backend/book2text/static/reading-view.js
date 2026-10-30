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

 * **本模块不提供 `exit()`（2026-10-29 裁决，别补回来）**：`enter()` 幂等——监听只绑新元素、
 * 观察器非空即复用（`reading` 是建 1 断 1，稳定不增）。三个模块当初都导出了 `exit`，
 * 而 `showView` 从不调用它，是**永不执行的导出**（`.exit(` 全仓库 0 命中）。
 * 实测（真浏览器，按「元素 × 事件类型」数活着的处理函数）：重复 `enter()` 不重复绑、不重建观察器。
 * **将来若要断观察器**（已知缺口：切走视图后隐藏元素仍会回调，见 `docs/known-limitations.md` L-108），
 * 那时再引入 `exit()`，并附等价性证据与真实调用点。写"为什么没有"是为了挡住下一个把它当缺失生命周期补回来的人。
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

// ---------------------------------------------------------------- 审校状态（L12 · 从 app.js 整段迁入）
//
// 与导出同一份 segments（含 line_spans）：段是排版单位、行是审校单位。
// 差异只在行内用红字标出来（汉字级实线 / 标点级虚线）；点红字在该行下面
// 展开候选面板。采用 / 保留 / 手改**全部先落草稿**（localStorage），
// 顶部「提交 N 处改动」才写库（后端一个 batch，撤销一次全退）。

// 窗口一次只铺 8 段：跳转时重建整个窗口也只要几十毫秒（24 段会到 1 秒）
const READING_CHUNK = 8;
let readingData = null;
let readingProject = null;
let readingTreeData = null;
let readingMarks = new Map();
let readingEntries = [];
// 任务 67：marks 只按页窗口加载（当前页 ±10）。全书 4435 条 = 1.52 MB / 0.90 s，
// 开机首屏红字全卡在那；窗口化后 1.7 ms / ~72 KB。计数和"下一处"靠下面这三个全书数字。
let readingMarksWindow = null;        // {page_from, page_to}；null = 还没加载
let readingGlobalCounts = null;       // {chars_total, chars_unacked, punct_total, punct_unacked, ...}
let readingPageCounts = new Map();    // page_no(string) → {total, unacked, acked, chars*, punct*}
let readingFirstUnackedPage = null;
let readingMarksInFlight = null;      // 在飞的补窗口请求；并发调用共享同一个 promise
let readingRepaintPending = false;   // 编辑期间欠着的一次重画
// 任务 72：左↔右同步互斥（谁先动谁锁 350 ms，另一个方向只跟随不反向驱动）
let readingSyncDriver = null;
let readingSyncUntil = 0;

let readingDrafts = new Map();
let readingFilter = "all";
let readingPageNo = 1;
let readingRendered = 0;
let readingSegmentNodes = [];
let readingPanelKey = null;
// UX V3：左树按章折叠的展开状态（跨重绘存活）；默认只展开当前页所在章。
let readingTreeExpandedChapters = new Set();
let readingTreeChapterAuto = null;   // 上一次自动展开的章（用户手动折叠后不抢回来）
// UX V3：最近 20 次判决的时刻，用来算「约剩 M 分钟」；进程内有效，不落盘。
let readingJudgeTimes = [];
// UX V3：窗口边界上正在向服务端要「下一处未审」；这期间面板保持打开，Enter 先不重复判。
let readingAdvancing = false;
// 面板最近一次打开的时刻：换页/重绘与「刚开面板」同帧竞争时，用它区分“刚开的”与“残留的”。
let readingPanelOpenedAt = 0;
// 跳转后等待目标行落位的 key：只挡这一段页码写入（见 onReadingScroll）
let readingJumpSettleKey = null;
let readingJumpSettleTicks = 0;
let readingCursorEntry = null;   // 上一次跳到的 entry（窗口换了 index 就不算数）
let readingObserver = null;
let readingOpenStartedAt = 0;
const readingSpanCache = new Map();
let readingAppendScheduled = false;
let readingFollow = true;
let readingProof = false;
// 任务 66：就地编辑（按行编辑、草稿按块/按行存）
let readingInlineEdits = new Map();   // key(block:line) → {base, text, at}
let readingEditingKey = null;
let readingMarkupLevel = "all";      // all / simple / none（纯视图开关）
let readingPendingOn = true;          // 待审红字（原「成稿」= 取消它）
let readingScrollRaf = 0;
let readingPendingBox = null;


/** 阅读流左栏（PDF 页列）当前滚动位置；没有左栏时按 0。 */
let readingAutoJumpDone = false;

/** 用户最后一次**自己**在审校视图里动手（滚轮 / 按下 / 按键）的时刻。 */
let readingUserMovedAt = 0;
/** 用户真实输入触发的滚动序号；`readingProgramScrollSeq` 是程序滚动的序号，
 * 两者不等说明"这次滚动是用户滚的"，左右跟随据此判断。 */
let readingUserScrollSeq = 0;
let readingProgramScrollSeq = 0;


let readingMarksRequestSeq = 0;


/**
 * 任务 82：选中一条差异 → **左侧 PDF 的这一行、右侧正文的这一行都落在视口垂直中央**。
 *
 * 用户原话："选中右边的差异后，左边的 PDF 高亮行的位置不定，建议点击差异修改，
 * 该行就直接跳到页面中间，保持统一的位置。" 这是肌肉记忆需求——每次同一位置，
 * 扫视时不用重新找。贴边（第一页 / 最后一页）夹住即可，不做二次补偿（会抖）。
 */
let readingSuppressFollowUntil = 0;


/** 左树里"展开了的页"（条目级展开状态）。 */
const readingTreeOpen = new Set();


// ---------------------------------------------------------------- 阅读审校左栏：连续页列
//
// 任务 57。用户原话："左边目前是裸 PDF，应该显示版心和文本识别框。而且应该可以上下
// 滚动，而不是只有右边文字可以上下滚动，左边不能滚动。"
//
// 做法与目录确认 / 结果预览同一套：页块是空壳（先占住真实比例），图和块只给视口
// 附近 ±3 页挂上；版心 + 块框复用 `paintTileMargin` / `renderPageBlocks`。
// 跟随开着时右栏滚到哪一页、左边滚到哪一页；关掉后左边自己滚，互不打扰。

let readingTiles = new Map();
let readingPageBlocks = new Map();
let readingBlockPromises = new Map();
let readingLoadedImages = new Set();
let readingImageQueue = [];
let readingImagePumping = false;
let readingNearObserver = null;
let readingVisibleObserver = null;
let readingNearSet = new Set();
let readingVisibleSet = new Set();
let readingStackProject = null;
let readingTops = [];
let readingHoveredSeq = null;
let readingPdfScrollRaf = 0;

const READING_NEAR_MARGIN = 900;


/** 一页要的东西：图 + 块数据；两个都到齐才画框。 */
/**
 * 审校页取的档位（任务 78）。和目录确认一样，**宽度变了就得重算并重取**：
 * 左侧页列被拖宽 / 窗口变大 / 折叠左树之后，原来那张 `view` 图会被拉伸到新宽度上。
 */
let readingImageProfile = "";
let readingResizeObserver = null;


/** 跳转时没开出来的面板：挂起 key，等"块/行到达"再试，不靠定时器猜。 */
let readingPendingPanelKey = null;
let readingPendingPanelEntry = null;


/**
 * 字级色块（任务 59）：把这一段里每行的差异字画到左边页面上。
 *
 * - 有字框：按差异字 / 词画小色块（中文单字、英文整词）；
 * - 没有字框（老数据、回填失败）：退化成整行一个虚线框，不整页不标；
 * - 只画差异，同行的相同字一个都不画。
 */
const wordBoxMappingStats = { offset: 0, position: 0, positionMiss: 0, missSamples: [] };
window.__b2tWordBoxStats = wordBoxMappingStats;


let readingPageSyncTimer = 0;
let readingPageSyncFixing = false;

/**
 * P0（2026-10-28）：**左栏顶部可见的那一页必须等于顶部页码**。
 *
 * 用户截图里左 PDF 是第 40 页、顶部写第 50 页、右栏是第 50 页的内容——三者对不上，
 * 他就没法审。这条不变量以前没有任何地方检查：程序跳页、跟随、重画各走各的。
 * 这里在每次页码变化后一帧做一次核对，不一致就纠正一次，并把结果暴露在
 * `window.__b2tPageSync` 上供 QA 断言（{label, tilePage, ok}）。
 */
const readingPageSyncLog = [];


const readingNextLog = [];




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
    readingPendingOn = event.target.checked;
    el("view-reading").classList.toggle("hide-pending", !readingPendingOn);
  });
  el("reading-follow-toggle").addEventListener("change", (event) => {
    setReadingFollow(event.target.checked);
  });
  for (const radio of document.querySelectorAll('input[name="reading-markup"]')) {
    radio.addEventListener("change", (event) => {
      readingMarkupLevel = event.target.value;
      renderReading({ reset: true });
    });
  }
  el("reading-discard-all").addEventListener("click", () => {
    const count = readingInlineEdits.size + readingDrafts.size;
    if (!count) return;
    if (!window.confirm(`放弃全部 ${count} 处未提交改动？（不可恢复）`)) return;
    readingInlineEdits.clear();
    saveReadingInlineEdits();
    readingDrafts.clear();
    saveReadingDrafts();
    renderReading({ reset: true });
    renderReadingProgress();
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
    injected.openPageDetail?.(readingPageNo);
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
    const mark = readingMarks.get(markEl.dataset.key);
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
    if (readingEditingKey) {
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
    // **按键路由（别改回"全交原生"或"全拦"）**：
    // - Enter：焦点在面板按钮上时交给原生 click（按钮自己就是「保留原文」/「看整行」等，
    //   native 激活只判一次）。若这里也处理，keydown 与原生 click 会各判一次，
    //   一次跳两条（记录仍然只有一条）——这是 2026-10-29 修掉的"跳过"形态。
    // - 空格 / E：**必须由 document 接管**。空格是唯一会改正文的键（采用候选），
    //   落给焦点按钮就变成"保留原文"；E 同理要进编辑。所以先 preventDefault 再执行，
    //   且 entry 取 `panel._readingEntry`（不按 key 反查，见 openReadingPanel 的注释）。
    if (event.key === "Escape") {
      closeReadingPanel();
      return;
    }
    const panelNodeForKey = document.querySelector("#reading-panel-host .reading-panel");
    const panelEntryForKeys = (panelNodeForKey && panelNodeForKey._readingEntry) ||
      (readingPanelKey
        ? readingEntries.find((item) => readingKey(item.block_id, item.line_index) === readingPanelKey)
        : null);
    if (panelEntryForKeys && (event.key === " " || event.key === "e" || event.key === "E")) {
      event.preventDefault();
      if (event.key === " ") {
        draftReading(panelEntryForKeys, "adopted", panelEntryForKeys.candidate || null);
      } else {
        const panelNode = document.querySelector("#reading-panel-host .reading-panel");
        if (panelNode) startReadingEdit(panelEntryForKeys, panelNode);
      }
      return;
    }
    if (event.target && event.target.closest && event.target.closest("#reading-panel-host")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (readingAdvancing) return;
      // UX V3：面板开着时 Enter/空格 = "保留原文并下一处"（原来的写法无条件 gotoNextUnreviewed，
      // 于是面板开着按 Enter 会跳过当前条且不记录——这是那个既有 bug）。
      const panelForEnter = document.querySelector("#reading-panel-host .reading-panel");
      const panelEntry = (panelForEnter && panelForEnter._readingEntry) ||
        (readingPanelKey
          ? readingEntries.find((item) => readingKey(item.block_id, item.line_index) === readingPanelKey)
          : null);
      if (panelEntry) {
        // UX V3 键位（docs/ux/review-screen-ux-v3.md §7）：Enter=保留、空格=采用候选。
        if (event.key === " ") draftReading(panelEntry, "adopted", panelEntry.candidate || null);
        else draftReading(panelEntry, "kept", null);
        return;
      }
      if (event.key === "Enter") gotoNextUnreviewed();
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
  readingProject = null;
  readingData = null;
  readingMarks = new Map();
  await openReading();
  injected.renderPunctGroupBadge?.();
}

  // ---------------------------------------------------------------- 审校交互（任务 94 · L2）
  // 从 app.js 原样搬入；依赖全部由 init() 注入，模块本身不碰 app.js 的顶层符号。

function markReadingUserMoved() {
  readingUserMovedAt = performance.now();
  readingUserScrollSeq += 1;
}

function startInlineEdit(line) {
  if (!line || readingEditingKey === line.dataset.key) return;
  exitInlineEdit();
  readingEditingKey = line.dataset.key;
  line.classList.add("is-editing");
  line.classList.add("is-current");
  line.setAttribute("contenteditable", "plaintext-only");
  line.focus();
  const mark = readingMarks.get(line.dataset.key);
  const pageNo = mark && mark.page_no ? mark.page_no : Number(line.dataset.page);
  if (pageNo && pageNo !== readingPageNo) {
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
    if (readingEditingKey === line.dataset.key) exitInlineEdit();
  });
}

function setReadingFilter(value) {
  readingFilter = value;
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
  const segments = readingVisibleSegments();
  const index = segments.findIndex((segment) =>
    (segment.line_spans || []).some((span) => span.block_id === blockId)
  );
  if (index < 0) {
    setReadingHover(null);
    return;
  }
  const segment = segments[index];
  if (readingHoveredSeq === Number(segment.seq)) return;
  readingHoveredSeq = Number(segment.seq);
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
  if (readingPdfScrollRaf) return;
  readingPdfScrollRaf = requestAnimationFrame(() => {
    readingPdfScrollRaf = 0;
    if (!injected.isReadingActive()) return;
    // 任务 72：**跟随开着的时候左栏滚动才该带动右侧**。原来这里写着
    // `if (readingFollow) return;`——正好反了：用户开着"跟随"滚左栏，右边完全不动。
    updateReadingPageFromLeftScroll();
    verifyReadingPageSync("leftScroll");
  });
}

function setReadingFollow(on) {
  readingFollow = Boolean(on);
  const toggle = el("reading-follow-toggle");
  if (toggle) toggle.checked = readingFollow;
  // 工具条上的那个「跟随：开/关」要一直跟状态一致（两处都能点）
  const chip = el("reading-follow-chip");
  if (chip) {
    chip.textContent = readingFollow ? "跟随：开" : "跟随：关";
    chip.classList.toggle("is-on", readingFollow);
    chip.setAttribute("aria-pressed", readingFollow ? "true" : "false");
  }
  if (!readingFollow) hideReadingPdfBox();
}

function onReadingScroll() {
  if (!readingFollow || readingScrollRaf) return;
  readingScrollRaf = requestAnimationFrame(() => {
    readingScrollRaf = 0;
    if (!readingFollow || !injected.isReadingActive()) return;
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
    const mark = readingMarks.get(key);
    const pageNo = Number(line.dataset.page);
    // 任务 88：**只挡"跳转落位中"的那几次写入**。
    //
    // `jumpReadingTo` / `centerReadingLinePair` 把正文滚到目标行的过程中，视口顶行还停在
    // 上一页（实测：跳第 142 页时顶行属于 141），这时同步写页码就会把 142 改成 141。
    // 落位完成后标志清空，之后任何滚动（相邻页、跨页、往回滚）都照常跟随——
    // 不用页差阈值（`≤1` 会把"滚一整页"也挡掉），也不看行节点矩形（重绘换掉节点会把页码钉死）。
    window.__b2tPagePin = window.__b2tPagePin || { held: 0, escape: 0 };
    let allowPageWrite = true;
    if (readingJumpSettleKey) {
      const target = readingPanelKey ? readingLineNode(readingJumpSettleKey) : null;
      if (!target) {
        // 行没了 / 面板关了：别再等
        readingJumpSettleKey = null;
      } else {
        const tr = target.getBoundingClientRect();
        const settled = tr.bottom > rect.top && tr.top < rect.bottom;
        if (settled) {
          // **落位那一帧也不许写**：目标行刚进视口时，35% 锚点还落在上一页最后一行
          // （QA 实测：跳 142，锚点行 141，同一个 rAF 里清掉标志又写页码 → 142 变 141，
          //  +1.5s 仍是 141）。清标志与写页码必须分到两次滚动事件里，这次先不写。
          readingJumpSettleKey = null;
          allowPageWrite = false;
          window.__b2tPagePin.held += 1;
        } else {
          readingJumpSettleTicks += 1;
          allowPageWrite = false;
          window.__b2tPagePin.held += 1;
          // 保底：一直落不了位（补行失败之类）就放行——宁可跟错一次，不能把页码冻住
          if (readingJumpSettleTicks >= 12) {
            readingJumpSettleKey = null;
            window.__b2tPagePin.escape += 1;
          }
        }
      }
    }
    // 面板项那一行还在视口里 → 页码以面板项为准（D-105）。文档末尾没法再往下滚，
    // 35% 锚点会常态性落在上一页最后一行（QA 实测 142 页落位后锚点是 141），
    // 只靠落位窗口挡不住之后的滚动事件。
    // **行节点取不到时放行（fail-open）**：早先那版取不到就挡，重绘换掉节点后页码被永久钉死。
    if (allowPageWrite && readingPanelKey) {
      const pinLine = readingLineNode(readingPanelKey);
      if (pinLine) {
        const pr = pinLine.getBoundingClientRect();
        if (pr.bottom > rect.top && pr.top < rect.bottom) {
          allowPageWrite = false;
          window.__b2tPagePin.held += 1;
        }
      }
    }
    if (mark && mark.page_no && mark.page_no !== readingPageNo) {
      if (!readingDriverActive("left")) markReadingDriver("right");
      if (allowPageWrite) updateReadingPage(mark.page_no, { scrollLeft: true, syncStream: false });
    } else if (!mark && pageNo && pageNo !== readingPageNo) {
      if (!readingDriverActive("left")) markReadingDriver("right");
      if (allowPageWrite) updateReadingPage(pageNo, { scrollLeft: true, syncStream: false });
    }
    if (mark && mark.bbox) {
      if (mark.page_no !== readingPageNo) {
        readingPendingBox = mark.bbox;
      } else {
        drawReadingPdfBox(mark.bbox, mark.page_no);
      }
    }
  });
}

function stepReadingPage(delta) {
  const total = injected.getProject() ? injected.getProject().pages.length : 0;
  const next = Math.min(total, Math.max(1, readingPageNo + delta));
  if (next === readingPageNo) return;
  noteReadingAction("page");
  // 任务 95：翻页按钮是**明确的用户意图**，必须同时写页码。
  // 原来只 `scrollPdfColumnToPage(next)`，而 `updateReadingPageFromLeftScroll` 对
  // "程序滚动"有早退守卫（`readingUserScrollSeq === readingProgramScrollSeq`），
  // 于是 scrollTop 动了、label 和 readingPageNo 却停在原地（QA 基线复现：0→461 而页码仍是 1）。
  // 走 `updateReadingPage`：写页码 + 左栏定位 + 右栏跟随；守卫保持原样（它挡的是异步重绘回拽）。
  updateReadingPage(next);
}

async function submitReadingDrafts() {
  if (!injected.getProject() || (!readingDrafts.size && !readingInlineEdits.size)) return;
  const items = [...readingDrafts.values()].map((draft) => ({
    block_id: draft.block_id,
    line_index: draft.line_index,
    ack: draft.ack,
    new_line_text:
      draft.ack === "kept" ? null : draft.text == null ? null : draft.text,
  }));
  // 任务 66：就地编辑按"行文本"提交；服务端会校验 block.text == join(行文本)
  for (const [key, edit] of readingInlineEdits) {
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
        .map((item) => readingKey(item.block_id, item.line_index))
    );
    for (const key of okKeys) readingDrafts.delete(key);
    saveReadingDrafts();
    for (const key of okKeys) readingInlineEdits.delete(key);
    saveReadingInlineEdits();
    if (failed.length) {
      window.alert(`${failed.length} 处提交失败，仍留在草稿里：\n${failed[0].error || ""}`);
    }
    readingData = null;
    readingProject = null;
    noteReadingAction("back");
    await openReading();
    await injected.loadFinishSummary?.({ silent: true });
    renderReadingProgress();
  } catch (error) {
    button.disabled = false;
    renderReadingProgress();
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
    readingData = null;
    readingProject = null;
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
  return readingUserMovedAt > sinceMs;
}

async function openReading() {
  if (!injected.getProject()) return;
  // 三栏宽度在打开时套一次：视图刚显示出来才量得到真实宽度
  applyReadingSplit();
  const projectId = injected.getProject().project_id;
  if (readingProject === projectId && readingData) {
    renderReading({ reset: true });
    renderReadingProgress();
    ensureReadingPages();
    measureReadingTops();
    if (readingPageNo) updateReadingPage(readingPageNo, { scrollLeft: true });
    injected.refreshPunctGroups?.();
    return;
  }
  const started = performance.now();
  readingOpenStartedAt = started;
  // 任务 81：记下打开时的滚动位置。marks 是异步来的，它回来时会按"第一处未审页"跳一次——
  // 如果这期间用户已经自己滚走了，就不能再把他拽回去（QA 复跑时正是被这一跳拽回第 1 页）。
  const openedAt = readingOpenStartedAt;
  const firstOpenForProject = readingProject !== projectId || !readingAutoJumpDone;
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
  readingData = preview;
  readingProject = projectId;
  readingMarks = new Map();
  readingEntries = [];
  readingMarksWindow = null;
  readingGlobalCounts = null;
  readingPageCounts = new Map();
  readingFirstUnackedPage = null;
  // 先出正文（无红字），红字随后补：点击到正文可见不用等 marks / tree
  renderReading({ reset: true });
  const metrics = (window.__b2tReadingMetrics = window.__b2tReadingMetrics || {});
  metrics.openedAt = Math.round(started);
  metrics.firstPaintMs = Math.round(performance.now() - started);
  metrics.segments = readingVisibleSegments().length;
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
  renderReadingProgress();
  metrics.firstMarkMs = Math.round(performance.now() - started);
  metrics.entries = readingEntries.length;
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
    readingEntries[0]?.page_no ||
    injected.getProject().pages[0]?.page_no ||
    1;
  // 任务 82：`first_unacked_page` 可能是前置页（第 1–37 页）——它们在队列里、
  // 但不在正文流里，跳过去右边是一片空。落到正文流里第一处有差异的页。
  const flowPages = readingFlowPages();
  if (!flowPages.has(page)) {
    // 用全书每页计数找"正文流里第一处还有未审差异的页"（marks 窗口在别的页时，
    // `readingEntries` 是空的，不能靠它）
    const candidate = [...readingPageCounts.keys()]
      .map((key) => Number(key))
      .filter((no) => flowPages.has(no) && Number(readingPageCounts.get(String(no))?.unacked || 0) > 0)
      .sort((a, b) => a - b)[0];
    if (candidate) page = candidate;
  }
  // 用户在这几秒里自己滚过了：保留他的位置，不跳到"第一处未审页"
  // 自动跳页**只允许发生一次**（任务 85）：marks 迟到 / 块到达 / 窗口重铺都不许再跳。
  if (firstOpenForProject && !readingAutoJumpDone && !readingMovedSinceOpen(openedAt)) {
    readingAutoJumpDone = true;
    updateReadingPage(page);
  }
  // 左树后补（只影响左栏计数，不影响正文与红字）
  injected.apiJson?.(`/api/projects/${projectId}/review/tree`)
    .then((tree) => {
      readingTreeData = tree;
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
  const pageNo = Number(readingLineNode(`${blockId}:${lineIndex}`)?.dataset?.page || 0);
  const blocks = pageNo ? readingPageBlocks.get(pageNo) : null;
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
  const node = readingEditingKey ? readingLineNode(readingEditingKey) : null;
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
  readingEditingKey = null;
  if (readingRepaintPending) {
    readingRepaintPending = false;
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
  const tile = readingTiles.get(pageNo);
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
  if (readingPageNo) updateReadingPage(readingPageNo, { scrollLeft: true });
}

function loadReadingInlineEdits() {
  readingInlineEdits = new Map();
  try {
    const raw = localStorage.getItem(readingInlineStorageKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const item of data.items || []) {
      if (!item || !item.key || item.text == null) continue;
      readingInlineEdits.set(item.key, {
        base: item.base || "",
        text: item.text,
        at: item.at || Date.now(),
      });
    }
  } catch {
    readingInlineEdits = new Map();
  }
}

/** 重开项目时有未提交的就地编辑：给一次"恢复 / 丢弃"（切换视图不算丢，所以只在首次加载问）。 */
function restoreInlineEditsPrompt() {
  if (!readingInlineEdits.size) return;
  const count = readingInlineEdits.size;
  const when = new Date(
    Math.min(...[...readingInlineEdits.values()].map((item) => item.at || Date.now()))
  );
  const label = `${when.getMonth() + 1}-${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  if (window.confirm(`有 ${count} 处未提交的正文改动（${label}）。\n\n「确定」= 恢复它们；「取消」= 丢弃。`)) {
    return;
  }
  readingInlineEdits.clear();
  saveReadingInlineEdits();
}

function loadReadingDrafts() {
  readingDrafts = new Map();
  try {
    const raw = localStorage.getItem(readingDraftStorageKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const item of data.items || []) {
      if (!item || !item.block_id) continue;
      readingDrafts.set(readingKey(item.block_id, item.line_index), item);
    }
  } catch {
    readingDrafts = new Map();
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
  readingTops = [];
  for (const [pageNo, tile] of readingTiles) {
    const rect = tile.getBoundingClientRect();
    readingTops.push({ pageNo, top: rect.top - base });
  }
  readingTops.sort((a, b) => a.pageNo - b.pageNo);
}

async function gotoNextUnreviewed() {
  if (!readingData) return;
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
    (line) => !readingDrafts.has(readingKey(line.block_id, line.line_index))
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
  const keyOf = (line) => readingKey(line.block_id, line.line_index);
  const cursorKey = readingCursorEntry
    ? readingKey(readingCursorEntry.block_id, readingCursorEntry.line_index)
    : null;
  let cursor = cursorKey ? usable.findIndex((line) => keyOf(line) === cursorKey) : -1;
  let target;
  if (cursor >= 0) {
    target = usable[(cursor + 1) % usable.length];
  } else {
    // 没有游标：从当前位置往后第一处，再绕回开头
    const page = Number(readingPageNo || 0);
    const after = usable.findIndex((line) => Number(line.page_no) >= page);
    target = usable[after >= 0 ? after : 0];
  }
  if (!target) return;
  await ensureReadingMarksWindow(target.page_no);
  const entry = readingEntries.find(
    (item) => item.block_id === target.block_id && item.line_index === target.line_index
  );
  if (!entry) {
    // 服务端说这行在流里、前端却查不到条目：只可能是 marks 窗口还没到，不静默、不谎报完成
    logReadingNext(target, { branch: "missing", reason: "entry-not-in-window" });
    injected.showNoticeBar?.("这一处差异的标记还没加载完，稍等一下再按一次「下一处未审」");
    return;
  }
  readingCursorEntry = entry;
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
  readingMarks = new Map();
  for (const mark of payload.items || []) {
    readingMarks.set(readingKey(mark.block_id, mark.line_index), mark);
  }
  readingMarksWindow = payload.window || null;
  readingGlobalCounts = payload.counts || null;
  readingPageCounts = new Map(Object.entries(payload.page_counts || {}));
  readingFirstUnackedPage = payload.first_unacked_page ?? null;
  rebuildReadingEntries();
}

function rebuildReadingEntries() {
  readingEntries = [];
  if (!readingData) return;
  const punctWatch = injected.punctReviewSet();
  for (const segment of readingVisibleSegments()) {
    const spans = segment.line_spans || [];
    for (let i = 0; i < spans.length; i += 1) {
      const span = spans[i];
      const mark = readingMarks.get(readingKey(span.block_id, span.line_index));
      if (!mark) continue;
      // 主队列只放含汉字差异的行；纯标点 / 空格按模式批量判（任务 61），
      // 只有被用户点了「逐条看」的那几种模式才回到主队列。
      if (mark.level === "differs_punct" && !punctWatch.has(mark.pattern_key)) continue;
      readingEntries.push({
        ...mark,
        seq: segment.seq,
        span_index: i,
        page_no: mark.page_no || span.page_no,
      });
    }
  }
  // 左树的条目级列表跟着 marks 窗口走：窗口换了，这一页下面的条目也要换
  if (readingTreeData) renderReadingTree();
}

function readingWindowHas(pageNo) {
  if (!readingMarksWindow) return false;
  return pageNo >= readingMarksWindow.page_from && pageNo <= readingMarksWindow.page_to;
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
  if (!injected.getProject() || !readingData) return;
  if (!pageNo || readingWindowHas(pageNo)) return;
  // 最多三轮：等在飞 → 自己发 → 确认。失败重试有上限，也不把异常抛给调用方。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (readingMarksInFlight) {
      await readingMarksInFlight;
    } else {
      const pending = loadReadingMarksWindow(pageNo).then(
        () => true,
        () => false
      );
      readingMarksInFlight = pending;
      let ok = false;
      try {
        ok = await pending;
      } finally {
        if (readingMarksInFlight === pending) readingMarksInFlight = null;
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
  const seq = (readingMarksRequestSeq += 1);
  const payload = await injected.apiJson(
    `/api/projects/${injected.getProject().project_id}/review/marks?page=${pageNo}`
  );
  if (seq !== readingMarksRequestSeq) return;   // 过期响应：已经被更晚的请求取代
  applyReadingMarksPayload(payload);
  // 正在编辑某一行时**不重画**：重画会换掉那个 DOM 节点，光标和没落草稿的输入
  // 一起丢（任务 67 实测：翻页补 marks 正好撞上用户点进一行，编辑态瞬间消失）。
  // 红字晚一点到没关系，退出编辑时补画。
  if (readingEditingKey) {
    readingRepaintPending = true;
  } else {
    refreshReadingMarksPaint();
  }
  renderReadingProgress();
}

function refreshReadingMarksPaint() {
  const stream = el("reading-stream");
  if (!stream || !readingData) return;
  // 跳页途中（左栏在驱动）不重画：重画会把滚动位置恢复成"作废前的位置"，
  // 刚跳到的第 80 页会被弹回第 1 页（任务 72 实测）。
  if (readingDriverActive("left")) {
    readingRepaintPending = true;
    return;
  }
  const pageAtSave = readingPageNo;
  const top = stream.scrollTop;
  // 重画会把面板与"当前行"一起清掉（`renderReading({reset:true})` 里 `readingPanelKey=null`）。
  // 记住它，重画完成后恢复——否则用户刚点开的那一处会凭空消失、位置也回到页首。
  const panelKey = readingPanelKey;
  const panelEntry = panelKey
    ? readingEntries.find((entry) => readingKey(entry.block_id, entry.line_index) === panelKey)
    : null;
  const segmentsToKeep = Math.max(readingRendered, 0);
  // **只重铺尾部一段**：从第 0 段重建 300+ 段 DOM 是主要卡顿来源（QA：1-8 帧/450ms）。
  // 保留最后 24 段（≈ 两屏），铺到原来的段数为止；滚动位置随后由 openReadingPanel 居中恢复。
  const fromSeg = Math.max(0, segmentsToKeep - 24);
  renderReading({ reset: true, startAt: fromSeg });
  let guard = 0;
  while (readingRendered < segmentsToKeep && guard < 400) {
    renderReading();
    guard += 1;
  }
  // 重画期间页码被改过（用户又跳了）就不恢复旧位置，否则等于把人拽回去。
  // 只重铺尾部时（fromSeg>0）绝对滚动位置没有意义，交给 openReadingPanel 居中恢复。
  if (fromSeg === 0 && readingPageNo === pageAtSave) stream.scrollTop = top;
  if (panelEntry && readingPageNo === pageAtSave) {
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
  const key = readingKey(entry.block_id, entry.line_index);
  const existing = readingLineNode(key);
  if (existing) return existing;
  const segments = readingVisibleSegments();
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
  return readingLineNode(key);
}

function renderReading({ reset = false, startAt = null } = {}) {
  const stream = el("reading-stream");
  if (!stream || !readingData) return;
  if (reset) {
    stream.innerHTML = "";
    readingRendered = startAt != null ? Math.max(0, startAt) : 0;
    readingSegmentNodes = [];
    // 只清 DOM 引用：`readingPendingPanelEntry` 跨重绘存活，末尾由 retryReadingPendingPanel 恢复
    readingPanelKey = null;
    if (readingObserver) readingObserver.disconnect();
    readingObserver = null;
  }
  const segments = readingVisibleSegments();
  if (!segments.length) {
    stream.innerHTML = '<p class="muted reading-empty">按当前导出设置没有可读的正文。</p>';
    return;
  }
  const end = Math.min(segments.length, readingRendered + READING_CHUNK);
  const firstNew = readingRendered;
  const fragment = document.createDocumentFragment();
  for (let index = readingRendered; index < end; index += 1) {
    const node = buildReadingSegment(segments[index]);
    readingSegmentNodes[index] = node;
    fragment.append(node);
  }
  stream.append(fragment);
  readingRendered = end;
  removeReadingSentinel();
  // 任务 84：`reset` 会把面板元素和 `readingPanelKey` 一起清掉。**挂起的"待开面板"
  // 必须跨过重绘**——DOM 重建完之后如果那一行挂上了，就把面板重新开出来。
  queueReadingIntent("panel", {});
  // 任务 77：**重画之后把悬停状态补回来**。右栏重建（切页补 marks / 滚动补段）会把
  // `is-hover` 一起冲掉，用户看到的是"鼠标还停在块上、右边的绿没了"。
  if (readingHoveredSeq !== null && readingHoveredSeq !== undefined) {
    const hovered = stream.querySelector(
      `.reading-seg[data-seq="${readingHoveredSeq}"]`
    );
    if (hovered) hovered.classList.add("is-hover");
  }
  if (end < segments.length) stream.append(buildReadingSentinel());
  // 任务 67：滚动会把后面的段铺出来，那些页可能在 marks 窗口外——补一块再画红字。
  // **全量重建（reset）时绝不能这么干**：QA 120 连按实测，`refreshReadingMarksPaint`
  // 先 reset 从第 0 段铺，这里就按"这一块的最大页"（≈11）去要窗口，窗口被拉回 1-11；
  // 加载完又触发一次重画，又从第 0 段铺……用户在 200 页，窗口在 1-11/2-22/13-33 之间打转，
  // 面板 key 不在任何已加载窗口里 → 17/120 次点击零推进、rAF 只有 1-8 帧/450ms。
  if (!reset && readingMarksWindow && end > firstNew) {
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
  refreshReadingCurrentHighlight();
  // 面板 DOM 在独立 host 里，`reset` 碰不到它：如果这次重绘既没有 `readingPanelKey`
  // 也没有待恢复的面板，残留的旧面板就再也对不上了。
  // QA 现场：正文和顶部已回到第 1 页，`#reading-panel-host` 里还挂着第 368 页的旧面板，
  // 因为 `openReadingPanel` 看到"已有面板"就不重建。
  if (!readingPanelKey && !readingPendingPanelEntry && !readingPendingPanelKey) {
    // UX V3：判决即前进会触发「换页 + 重绘」，重绘把 key 清空后不能把刚开的面板当残留藏掉。
    // 只要宿主里的面板仍指向当前页（mark 的 page_no == readingPageNo），就认它是当前项。
    const host = el("reading-panel-host");
    const stub = host && host.querySelector(".reading-panel");
    const stubKey = stub && stub.dataset.key;
    // 刚开（2.5s 内）的面板是「判决即前进」刚换上的，reset 晚到一步不能把它当残留藏掉；
    // 只有明显过期的旧面板才隐藏。
    if (stubKey && performance.now() - readingPanelOpenedAt < 2500) {
      readingPanelKey = stubKey;
    } else {
      hideReadingPanelHost();
    }
  }
}

function buildReadingSentinel() {
  const node = document.createElement("div");
  node.className = "reading-sentinel";
  node.dataset.role = "sentinel";
  if (!readingObserver) {
    readingObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        // 哨兵本身就在 rootMargin 里：一帧只补一块，别让回调递归把整本一次铺出来
        if (readingAppendScheduled) return;
        readingAppendScheduled = true;
        requestAnimationFrame(() => {
          readingAppendScheduled = false;
          renderReading();
        });
      },
      { root: el("reading-stream"), rootMargin: "800px 0px" }
    );
  }
  readingObserver.observe(node);
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
    readingInlineEdits.delete(key);
  } else {
    readingInlineEdits.set(key, { base, text, at: Date.now() });
  }
  saveReadingInlineEdits();
  line.classList.toggle("is-inline-edited", readingInlineEdits.has(key));
  renderReadingProgress();
}

function centerReadingLinePair(entry) {
  const key = readingKey(entry.block_id, entry.line_index);
  const stream = el("reading-stream");
  const line = readingLineNode(key);
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
  const tile = entry.page_no ? readingTiles.get(entry.page_no) : null;
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

/**
 * UX V3 ①：一条 = 一处差异。
 * 取 before/after 的公共前后缀，差异段两侧各留 radius 个字；返回两行要显示的范围。
 * 不拼、不补：片段全部是原文切片，差异段逐字返回，渲染时再包强调。
 */
function readingDiffWindow(before, after, radius = 6) {
  const a = String(before || "");
  const b = String(after || "");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const aStart = head;
  const aEnd = a.length - tail;
  const bStart = head;
  const bEnd = b.length - tail;
  return {
    a, b,
    aFrom: Math.max(0, aStart - radius), aTo: Math.min(a.length, aEnd + radius), aStart, aEnd,
    bFrom: Math.max(0, bStart - radius), bTo: Math.min(b.length, bEnd + radius), bStart, bEnd,
  };
}

/** 一行片段：省略号 + 前后文 + 差异字（逐字 <b>，差异字必须有强调）。 */
function readingSnippetRow(label, text, from, start, end, to, full) {
  const row = document.createElement("div");
  row.className = "reading-panel__row";
  const tag = document.createElement("span");
  tag.className = "reading-panel__row-label";
  tag.textContent = label;
  const body = document.createElement("span");
  body.className = "reading-panel__row-text";
  const left = full ? 0 : from;
  const right = full ? text.length : to;
  if (left > 0) body.append(document.createTextNode("…"));
  if (start > left) body.append(document.createTextNode(text.slice(left, start)));
  const changed = text.slice(Math.min(start, end), Math.max(start, end));
  if (changed) {
    for (const char of changed) {
      const em = document.createElement("b");
      em.className = "reading-panel__changed";
      em.textContent = char;
      body.append(em);
    }
  } else {
    const empty = document.createElement("span");
    empty.className = "reading-panel__empty";
    empty.textContent = "∅";
    body.append(empty);
  }
  if (end < right) body.append(document.createTextNode(text.slice(end, right)));
  if (right < text.length) body.append(document.createTextNode("…"));
  row.append(tag, body);
  return row;
}

function openReadingPanel(entry) {
  closeReadingPanel();
  const key = readingKey(entry.block_id, entry.line_index);
  const line = readingLineNode(key);
  // 窗口化渲染的竞态：跳转后那一行可能还没挂上 DOM。
  // 面板本来只需要 `mark`（候选文本）与 `bbox`，**不依赖行节点**——
  // 行节点只用来定位与样式。所以找不到就降级挂到正文流顶部，绝不让用户"跳过去了但没有面板"。
  readingPanelKey = key;
  readingAdvancing = false;
  readingPanelOpenedAt = performance.now();
  const panel = document.createElement("div");
  panel.className = "reading-panel";
  panel.dataset.key = readingPanelKey;
  // **当前条目挂在面板 DOM 上，不靠 readingPanelKey 反查**（2026-10-29 实机 bug）。
  //
  // 为什么不能只存 key：marks 是按页窗口加载的，面板刚换页的那一瞬，
  // `readingPanelKey` 可能还不在当前 `readingEntries` 里。键盘分支若此时按 key 反查，
  // 会拿到 null → 空格落到焦点上的原生按钮（默认焦点是「保留原文」）→
  // **用户以为在「采用候选」，实际执行了「保留」——改错字，且不报错**。
  // 面板上的这一条永远是用户正在看的那条，所以 entry 跟着面板走。
  panel._readingEntry = entry;
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
  // UX V3 ①：默认只显示差异片段（前后各 ±6 字），「看整行」再展开全文。
  const snippet = document.createElement("div");
  snippet.className = "reading-panel__snippet";
  let panelExpanded = false;
  const beforeText = entry.current || "";
  const afterText = entry.candidate || "";
  const drawSnippet = () => {
    const window = readingDiffWindow(beforeText, afterText);
    const rows = [
      readingSnippetRow("原文", window.a, window.aFrom, window.aStart, window.aEnd, window.aTo, panelExpanded),
      readingSnippetRow("候选", window.b, window.bFrom, window.bStart, window.bEnd, window.bTo, panelExpanded),
    ];
    snippet.replaceChildren(...rows);
  };
  drawSnippet();
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "btn btn--sm reading-panel__expand";
  expand.textContent = "看整行";
  expand.addEventListener("click", () => {
    panelExpanded = !panelExpanded;
    expand.textContent = panelExpanded ? "收起整行" : "看整行";
    drawSnippet();
  });
  const actions = document.createElement("div");
  actions.className = "reading-panel__actions";
  const adopt = document.createElement("button");
  adopt.type = "button";
  adopt.className = "btn btn--sm";
  adopt.textContent = "采用候选";
  adopt.addEventListener("click", () => draftReading(entry, "adopted", entry.candidate));
  const keep = document.createElement("button");
  keep.type = "button";
  // UX V3：默认按钮是「保留原文」（80.9% 的判决是保留），不是「采用候选」。
  keep.className = "btn btn--pri btn--sm";
  keep.textContent = "保留原文";
  keep.addEventListener("click", () => draftReading(entry, "kept", null));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn btn--sm";
  edit.textContent = "自己改";
  edit.addEventListener("click", () => startReadingEdit(entry, panel));
  actions.append(adopt, keep, edit);
  panel.append(head, snippet, expand, actions);
  // **结构上不可能被清掉**：面板挂进 `#reading-panel-host`，它不在 `#reading-stream` 里，
  // `renderReading({reset:true})` 怎么 `innerHTML=""` 都碰不到它。
  const host = el("reading-panel-host");
  if (!host) return;
  host.innerHTML = "";
  host.append(panel);
  host.hidden = false;
  // UX V3 ③：默认焦点在「保留原文」——打开面板直接回车就是「保留原文并前进」。
  keep.focus();
  noteReadingAction("panel");
  refreshReadingCurrentHighlight();
  if (entry.page_no && entry.page_no !== readingPageNo) {
    updateReadingPage(entry.page_no, { scrollLeft: false, syncStream: false });
  }
  // 左右同时把这一行放到视口中央（右侧由 centerReadingLinePair 负责，不用 scrollIntoView：
  // 它在这套布局里会挑错滚动祖先）
  centerReadingLinePair(entry);
  // 打开候选时把这一行的行框画到左 PDF 上（显式动作，不依赖跟随开关）
  if (entry.bbox) {
    if (entry.page_no !== readingPageNo) {
      readingPendingBox = entry.bbox;
    } else {
      drawReadingPdfBox(entry.bbox, entry.page_no);
    }
  }
  // 行节点可能在这一帧之后才挂上（补窗口 / 重铺）：下一帧按同一个 key 再补一次高亮。
  // 面板元素在独立 host 里、跨重绘存活，所以这里不需要重开面板，只需要重挂 class。
  requestAnimationFrame(() => {
    if (readingPanelKey === key) refreshReadingCurrentHighlight();
  });
}

function renderReadingTree() {
  const tree = el("reading-tree");
  if (!tree || !readingTreeData) return;
  const scrollTop = tree.scrollTop;
  tree.innerHTML = "";
  const stats = readingTreeData.stats || {};
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
  // 页块展开后才补 marks 窗口（调用留在 renderReadingTree 里，不放 builder：
  // 边棘轮按函数名计边，挪进 builder 会让 renderReadingTree → ensureReadingMarksWindow 消失）。
  const expandLater = (pageNo) => {
    if (
      readingTreeOpen.has(pageNo) &&
      !readingEntriesForPage(pageNo).length &&
      flowPages.has(pageNo)
    ) {
      ensureReadingMarksWindow(pageNo).then(() => renderReadingTree());
    }
  };
  // 当前页自动展开：用户不用先找页、再展开，进来就能看到"这一页有哪几处、分别是什么"
  if (readingPageNo) readingTreeOpen.add(readingPageNo);
  const pages = readingTreeData.pages || [];
  const chapters = Array.isArray(readingTreeData.chapters) ? readingTreeData.chapters : [];
  const visiblePages = pages.filter((page) => page.total || page.unacked);
  const currentChapter = readingPageNo
    ? (pages.find((page) => page.page_no === readingPageNo) || {}).chapter || null
    : null;
  // UX V3：左树按章折叠。默认只展开当前页所在章；用户开合过的章跨重绘保留。
  if (currentChapter && readingTreeChapterAuto !== currentChapter) {
    readingTreeChapterAuto = currentChapter;
    readingTreeExpandedChapters.add(currentChapter);
  }
  if (chapters.length) {
    const chapterIds = new Set(chapters.map((chapter) => chapter.id));
    for (const chapter of chapters) {
      const kids = visiblePages.filter((page) => page.chapter === chapter.id);
      if (!kids.length) continue;
      const wrap = document.createElement("div");
      wrap.className = "reading-tree__chapter";
      wrap.dataset.chapter = chapter.id;
      const open = readingTreeExpandedChapters.has(chapter.id);
      wrap.classList.toggle("is-open", open);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "reading-tree__row reading-tree__row--chapter";
      const no = document.createElement("span");
      no.className = "reading-tree__no";
      const chevron = document.createElement("span");
      chevron.className = "reading-tree__chevron";
      chevron.textContent = open ? "▾" : "▶";
      no.append(chevron, document.createTextNode(chapter.title || `第 ${kids[0].page_no} 页起`));
      const count = document.createElement("span");
      count.className = "reading-tree__count";
      const sum = kids.reduce((total, page) => total + Number(page.unacked || 0), 0);
      count.textContent = sum ? `${sum} 处` : "✓";
      row.append(no, count);
      const items = document.createElement("div");
      items.className = "reading-tree__items";
      items.hidden = !open;
      row.addEventListener("click", () => {
        if (readingTreeExpandedChapters.has(chapter.id)) readingTreeExpandedChapters.delete(chapter.id);
        else readingTreeExpandedChapters.add(chapter.id);
        renderReadingTree();
      });
      if (open) {
        for (const page of kids) items.append(buildReadingTreePage(page, flowPages, expandLater));
      }
      wrap.append(row, items);
      tree.append(wrap);
    }
    for (const page of visiblePages) {
      if (page.chapter && chapterIds.has(page.chapter)) continue;
      tree.append(buildReadingTreePage(page, flowPages, expandLater));
    }
  } else {
    for (const page of visiblePages) tree.append(buildReadingTreePage(page, flowPages, expandLater));
  }
  tree.scrollTop = scrollTop;
}

/** 左树里的一个页块（UX V3：章下面按页铺，页块本身的行为与旧版一致）。 */
function buildReadingTreePage(page, flowPages, expandLater) {
const wrap = document.createElement("div");
wrap.className = "reading-tree__page";
wrap.dataset.page = String(page.page_no);
const open = readingTreeOpen.has(page.page_no);
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
  item.dataset.key = readingKey(entry.block_id, entry.line_index);
  const done = readingEntryDone(entry);
  if (done) item.classList.add("is-done");
  if (item.dataset.key === readingPanelKey) item.classList.add("is-current");
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
  if (readingTreeOpen.has(page.page_no)) readingTreeOpen.delete(page.page_no);
  else readingTreeOpen.add(page.page_no);
  queueReadingIntent("scroll", { pageNo: page.page_no });
  renderReadingTree();
  // 这一页不在已加载的 marks 窗口里：补那一页 ±10，回来再铺条目
  expandLater(page.page_no);
});
wrap.append(row, items);

  return wrap;
}

function scrollReadingToPage(pageNo) {
  const segments = readingVisibleSegments();
  let index = segments.findIndex((segment) =>
    (segment.pages || []).some((page) => page.page_no === pageNo)
  );
  if (index < 0) return;
  jumpReadingTo(index);
  const node = readingSegmentNodes[index];
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
  const wasOpen = readingTreeOpen.has(pageNo);
  readingTreeOpen.add(pageNo);        // 当前页永远展开：进来就能看到这一页有哪几处
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
  const segments = readingVisibleSegments();
  if (segmentIndex < 0 || segmentIndex >= segments.length) return;
  // 目标段已经在 DOM 里就直接用；不在就从它前 2 段重新铺窗口。
  if (readingSegmentNodes[segmentIndex]) return;
  renderReading({ reset: true, startAt: Math.max(0, segmentIndex - 2) });
}

function ensureReadingPages() {
  if (!injected.getProject()) return;
  if (readingStackProject === injected.getProject().project_id && readingTiles.size) return;
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
  readingTiles.clear();
  readingPageBlocks.clear();
  readingBlockPromises.clear();
  readingLoadedImages.clear();
  readingImageQueue = [];
  readingNearSet.clear();
  readingVisibleSet.clear();
  readingTops = [];
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
    readingTiles.set(page.page_no, tile);
    fragment.append(tile);
  }
  wrap.append(fragment);
  // 页列重建会清空容器：字级色块层与跟随行框要重新挂回去
  const diffLayer = document.createElement("div");
  diffLayer.className = "reading-diff-layer";
  diffLayer.id = "reading-diff-layer";
  wrap.append(diffLayer);
  if (box) wrap.append(box);
  readingStackProject = injected.getProject().project_id;
  observeReadingTiles();
}

function observeReadingTiles() {
  const scroller = el("reading-pdf-scroll");
  if (!scroller || typeof IntersectionObserver !== "function") return;
  const firstTile = readingTiles.values().next().value;
  const tileHeight = firstTile ? firstTile.getBoundingClientRect().height : 0;
  const margin = tileHeight
    ? Math.max(600, Math.round(tileHeight * 2.5))
    : READING_NEAR_MARGIN;
  readingNearObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const tile = entry.target;
        const pageNo = Number(tile.dataset.pageNo);
        if (entry.isIntersecting) {
          readingNearSet.add(pageNo);
          ensureReadingTile(pageNo);
        } else if (readingNearSet.delete(pageNo)) {
          if (Math.abs(pageNo - (readingPageNo || 1)) > injected.INDEX_IMAGE_WINDOW) releaseReadingImage(pageNo);
        }
      }
    },
    { root: scroller, rootMargin: `${margin}px 0px`, threshold: 0 }
  );
  readingVisibleObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const tile = entry.target;
        const pageNo = Number(tile.dataset.pageNo);
        if (entry.isIntersecting) {
          readingVisibleSet.add(pageNo);
          ensureReadingTile(pageNo);
          paintReadingTile(pageNo);
        } else if (readingVisibleSet.delete(pageNo)) {
          clearReadingDecorations(pageNo);
        }
      }
      if (!readingFollow) updateReadingPageFromLeftScroll();
    },
    { root: scroller, rootMargin: "0px", threshold: 0 }
  );
  for (const tile of readingTiles.values()) {
    readingNearObserver.observe(tile);
    readingVisibleObserver.observe(tile);
  }
}

function refreshReadingImageProfiles(force = false) {
  const tiles = [...readingTiles.values()];
  const sample = tiles.find((tile) => Number(tile.dataset.pageNo) === readingPageNo) || tiles[0];
  if (!sample) return;
  const pageNo = Number(sample.dataset.pageNo);
  const wanted = injected.pageProfileFor(sample, pageNo);
  if (!force && (!readingImageProfile || wanted === readingImageProfile)) {
    readingImageProfile = wanted;
    return;
  }
  readingImageProfile = wanted;
  // 任务 79：**不要先摘 src 再重取**——那会让页图空白一下（用户看到闪白）。
  // 先在离屏 Image 里把新档下完，加载完再换上去，旧图一直可见。
  for (const pageNo of [...readingLoadedImages]) warmSwapReadingImage(pageNo, wanted);
  // 页列宽度一变，tile 的宽高都跟着变：同一个 `scrollTop` 会落到别的页上。
  // 按"当前页码"重新锚定一次（用户的心智是"我在第几页"），再核对。
  if (readingPageNo) scrollPdfColumnToPage(readingPageNo);
  verifyReadingPageSync("resize");
}

function observeReadingColumnResize() {
  const wrap = el("reading-pages");
  if (!wrap || readingResizeObserver || typeof ResizeObserver === "undefined") return;
  let timer = 0;
  readingResizeObserver = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (injected.getCurrentView() === "reading") refreshReadingImageProfiles();
    }, 250);
  });
  readingResizeObserver.observe(wrap);
}

function ensureReadingTile(pageNo) {
  ensureReadingImage(pageNo);
  ensureReadingBlocks(pageNo).then(() => paintReadingTile(pageNo));
}

function retryReadingPendingPanel() {
  // 面板已经在宿主里（重绘碰不到它），但 `readingPanelKey` 可能被 reset 清成了 null：
  // 把当前项恢复回来，高亮才跟着回来。
  if (!readingPendingPanelEntry && !readingPanelKey) {
    const host = el("reading-panel-host");
    const stub = host && host.querySelector(".reading-panel");
    const key = stub && stub.dataset.key;
    if (key) { readingPanelKey = key; refreshReadingCurrentHighlight(); }
    return;
  }
  if (!readingPendingPanelEntry) return;
  const entry = readingPendingPanelEntry;
  const key = readingKey(entry.block_id, entry.line_index);
  if (!readingLineNode(key)) return;      // 行还没挂上，等下一次数据到达
  clearPendingPanel();
  openReadingPanel(entry);
  logReadingNext(entry, { branch: "pending-open", reason: "data-arrived" });
}

function ensureReadingBlocks(pageNo) {
  if (readingPageBlocks.has(pageNo)) return Promise.resolve(readingPageBlocks.get(pageNo));
  const pending = readingBlockPromises.get(pageNo);
  if (pending) return pending;
  const promise = injected.loadIndexBlocks(pageNo)
    .then((blocks) => {
      readingPageBlocks.set(pageNo, blocks || []);
      // **块到了就重画**：差异行框/字框要 `readingPageBlocks` 非空才画得出来。
      // 跳转那一瞬块还没到 → `paintReadingDiffBoxes` 直接 return（一个框都不画），
      // 行节点也没有 → 面板开不出来。"面板与高亮同时消失"就是这一条（任务 84）。
      if (pageNo === readingPageNo) {
        paintReadingTile(pageNo);
        retryReadingPendingPanel();
      }
      return blocks || [];
    })
    .finally(() => readingBlockPromises.delete(pageNo));
  readingBlockPromises.set(pageNo, promise);
  return promise;
}

function setReadingHover(seq) {
  // `seq` 可能来自 dataset（字符串）：先统一成数字，否则异步回来时比对永远不相等
  const target = seq === null || seq === undefined || seq === ""
    ? null
    : Number(seq);
  if (target === readingHoveredSeq) return;
  for (const node of document.querySelectorAll("#reading-stream .reading-seg.is-hover")) {
    node.classList.remove("is-hover");
  }
  for (const box of document.querySelectorAll("#reading-pages .box.is-linked")) {
    box.classList.remove("is-linked");
  }
  readingHoveredSeq = target;
  if (target === null) {
    for (const node of document.querySelectorAll("#reading-diff-layer .reading-diff-box")) {
      node.remove();
    }
    return;
  }
  const node = document.querySelector(`#reading-stream .reading-seg[data-seq="${target}"]`);
  if (node) node.classList.add("is-hover");
  const segment = (readingVisibleSegments() || []).find((item) => item.seq === target);
  if (!segment) return;
  const pageNos = new Set((segment.line_spans || []).map((span) => span.page_no));
  for (const pageNo of pageNos) {
    ensureReadingBlocks(pageNo).then(() => {
      if (readingHoveredSeq !== target) return;
      paintReadingTile(pageNo);
      paintReadingDiffBoxes(pageNo);
    });
  }
}

function markReadingCurrentTile(pageNo) {
  for (const tile of document.querySelectorAll("#reading-pages .reading-page.is-current")) {
    tile.classList.remove("is-current");
  }
  const tile = readingTiles.get(pageNo);
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
  if (!readingTops.length) return;
  const scroller = el("reading-pdf-scroll");
  if (!scroller) return;
  const anchor = scroller.scrollTop + scroller.clientHeight * 0.25;
  let best = readingTops[0];
  for (const entry of readingTops) {
    if (entry.top <= anchor) best = entry;
    else break;
  }
  if (!best) return;
  if (best.pageNo === readingPageNo) return;
  // **跳转落位期间左栏一律不写**：`gotoReadingEntry` 自己的滚动会触发这里，
  // 此时左栏锚点还停在上一页，写进去就把刚定位好的页码改掉（QA run F：
  // gotoEntry 写 118 → leftScroll 写 117，两个回调隔着几十毫秒，后者赢）。
  if (readingJumpSettleKey) return;
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
  if (readingUserScrollSeq === readingProgramScrollSeq) return;
  readingPageNo = best.pageNo;
  el("reading-page-no").textContent = `第 ${best.pageNo} 页`;
  markReadingCurrentTile(best.pageNo);
  markReadingTreeCurrent(best.pageNo);
  if (
    readingFollow &&
    performance.now() > readingSuppressFollowUntil &&
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
  if (!readingData) return;
  const segments = readingVisibleSegments();
  if (!segments.length) return;
  let index = segments.findIndex((segment) =>
    (segment.line_spans || []).some((span) => Number(span.page_no) >= pageNo)
  );
  if (index < 0) index = segments.length - 1;
  jumpReadingTo(index);
  const node = readingSegmentNodes[index];
  if (!node) return;
  node.scrollIntoView({ block: "start", behavior: "auto" });
  setReadingHover(String(segments[index].seq));
  markReadingTreeCurrent(pageNo);
  // 跳的过程中正文会触发自己的 scroll 回调，可能把页码改回去：这里钉一下
  readingPageNo = pageNo;
  const label = el("reading-page-no");
  if (label) label.textContent = `第 ${pageNo} 页`;
  markReadingCurrentTile(pageNo);
}

function verifyReadingPageSync(reason = "", { fix = true } = {}) {
  clearTimeout(readingPageSyncTimer);
  readingPageSyncTimer = setTimeout(() => {
    if (injected.getCurrentView() !== "reading" || !readingPageNo) return;
    const scroller = el("reading-pdf-scroll");
    if (!scroller) return;
    // 用户正在自己滚左栏：这时候"顶部那一页"本来就会短暂等于中间页，别纠正（会打架）
    if (performance.now() - readingUserMovedAt < 400) return;
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
    for (const [pageNo, tile] of readingTiles) {
      const rect = tile.getBoundingClientRect();
      const overlap = Math.min(rect.bottom, viewBottom) - Math.max(rect.top, viewTop);
      if (overlap > bestArea) {
        bestArea = overlap;
        tilePage = pageNo;
      }
    }
    // 三方一致：当前差异项所在页 == 顶部页码 == 左侧可见页。
    // 只看前两个数会漏掉真正错的情况（面板第 13 页、顶部与左侧都是第 28 页 → ok:true）。
    const panelMark = readingPanelKey ? readingMarks.get(readingPanelKey) : null;
    const panelPage = panelMark && panelMark.page_no ? Number(panelMark.page_no) : null;
    const ok = tilePage === readingPageNo && (!panelPage || panelPage === readingPageNo);
    const record = {
      reason,
      label: readingPageNo,
      tilePage,
      panelPage,
      ok,
      scrollTop: Math.round(scroller.scrollTop),
      at: Date.now(),
    };
    // 留最近 5 次（用户报"左右不对应"时，前一次的状态往往才是线索）
    readingPageSyncLog.unshift(record);
    readingPageSyncLog.length = Math.min(readingPageSyncLog.length, 5);
    window.__b2tPageSync = record;
    window.__b2tPageSyncLog = readingPageSyncLog;
    if (fix && !ok && !readingPageSyncFixing) {
      // **纠正，不只是记录**。以"当前差异项所在页"为准（那才是用户正在看的东西）
      readingPageSyncFixing = true;
      if (panelPage && panelPage !== readingPageNo) {
        queueReadingIntent("goto", { pageNo: panelPage, scrollLeft: true, syncStream: false });
      } else {
        scrollPdfColumnToPage(readingPageNo);
      }
      // 纠正本身会再触发一次滚动：150 ms 后补一次核对（只核对、不再纠正，避免来回抖）
      setTimeout(() => {
        readingPageSyncFixing = false;
        verifyReadingPageSync("afterFix", { fix: false });
      }, 150);
    }
  }, 130);
}

function updateReadingPage(pageNo, { scrollLeft = true, syncStream = true } = {}) {
  if (!injected.getProject()) return;
  const total = injected.getProject().pages.length;
  if (!pageNo || pageNo < 1 || pageNo > total) return;
  readingPageNo = pageNo;
  // 任务 67：翻到窗口外的页就补那一页 ±10 的 marks（异步，不挡翻页）
  if (readingData) ensureReadingMarksWindow(pageNo);
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
  if (syncStream && readingFollow && readingData && !readingDriverActive("right")) {
    markReadingDriver("left");
    scrollStreamToPage(pageNo);
  }
  if (readingPendingBox) {
    drawReadingPdfBox(readingPendingBox, pageNo);
    readingPendingBox = null;
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
  const segments = readingVisibleSegments();
  const index = segments.findIndex((segment) => segment.seq === entry.seq);
  // 边 8 不切（顺序依赖）：jump 的 reset 必须早于下面的 openReadingPanel。
  // 入队后它在帧末跑，reset 会把刚开的面板按"无 key + 无 pending"的清尾规则藏掉（QA：2/60）。
  if (index >= 0) jumpReadingTo(index);
  const key = readingKey(entry.block_id, entry.line_index);
  let line = readingLineNode(key);
  if (!line) {
    // 目标段不在已挂载的窗口里：按它的下标重铺一次（不固定 sleep，靠渲染完成后再查）。
    // 走同一个 helper，顺带覆盖"条目没有 seq"（左树）的情况。
    line = ensureReadingLineRendered(entry);
  }
  if (line) centerReadingLinePair(entry);
  if (!readingDrafts.has(key)) openReadingPanel(entry);
  // 从这里开始到目标行真正进视口之前，页码同步一律不写（否则会被顶行的上一页改写）
  readingJumpSettleKey = key;
  readingJumpSettleTicks = 0;
  const settled = settlePanel(entry);
  // 偶发"跳到了但没有面板/没有当前项"（QA 2/20）：面板没建起来就再开一次，
  // 并把原因记进 __b2tNextLog。第二次仍失败也记下来，不静默。
  if (!settled) {
    let reason = "no-line";
    const seg = readingVisibleSegments()[index];
    if (!seg) reason = "no-segment";
    else if (!readingLineNode(key)) reason = "line-not-mounted";
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
  const tile = readingTiles.get(pageNo);
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
  const tile = readingTiles.get(pageNo);
  if (!tile) return;
  const image = tile.querySelector("img");
  if (!image || readingLoadedImages.has(pageNo) || image.dataset.pending) return;
  // 任务 80：同目录确认——先摘掉上一轮残留的 onload/onerror，再挂占位图。
  // 否则占位图加载完会触发旧闭包，把 thumb 标成 `is-ready`，这一页就永远停在模糊的缩略图上。
  image.onload = null;
  image.onerror = null;
  showReadingPlaceholder(pageNo, image);
  image.dataset.pending = "1";
  readingImageQueue.push(pageNo);
  pumpReadingImages();
}

/** 图一张一张解：一次跳 300 页时同时解 7 张大图会出一帧近 1 秒的长帧。 */
function pumpReadingImages() {
  if (readingImagePumping) return;
  readingImagePumping = true;
  const step = () => {
    const pageNo = readingImageQueue.shift();
    if (!pageNo) {
      readingImagePumping = false;
      return;
    }
    const tile = readingTiles.get(pageNo);
    if (!tile) {
      step();
      return;
    }
    const image = tile.querySelector("img");
    if (!image) {
      step();
      return;
    }
    readingLoadedImages.add(pageNo);
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
      paintReadingTile(pageNo);
      step();
    };
    image.onerror = () => {
      delete image.dataset.pending;
      // 取图失败：**不能把模糊的缩略图留在那里冒充最终图**（用户分不清"糊"和"还没来"），
      // 也不能把这一页留在 readingLoadedImages 里——那样它再也不会被重取。
      injected.clearImagePlaceholder(image);
      image.classList.remove("is-ready");
      image.removeAttribute("src");
      readingLoadedImages.delete(pageNo);
      const attempts = Number(tile.dataset.imageAttempts || 0) + 1;
      tile.dataset.imageAttempts = String(attempts);
      if (attempts <= 2 && injected.getCurrentView() === "reading" && readingTiles.has(pageNo)) {
        setTimeout(() => {
          if (injected.getCurrentView() === "reading" && readingTiles.has(pageNo)) ensureReadingImage(pageNo);
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
  const tile = readingTiles.get(pageNo);
  const image = tile ? tile.querySelector("img") : null;
  if (!image) return;
  // 摘 `src` 不会触发 onload/onerror：先把闭包摘掉，免得下一张图（或占位图）误触发旧逻辑
  image.onload = null;
  image.onerror = null;
  image.removeAttribute("src");
  image.classList.remove("is-ready");
  injected.clearImagePlaceholder(image);
  delete image.dataset.pending;
  readingLoadedImages.delete(pageNo);
}

/**
 * 三次取图都失败：留一张**不带模糊**的低分辨率占位 + 一个可点的重试。
 *
 * 不留"模糊的缩略图"——用户分不清"这张图糊"和"还没加载完"；
 * 也不留一块空白——那等于告诉用户"这一页不存在"。
 */
function markReadingImageFailed(pageNo) {
  const tile = readingTiles.get(pageNo);
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
  if (pageNo === readingPageNo) {
    const status = el("reading-image-status");
    if (status) {
      status.hidden = false;
      status.textContent = `第 ${pageNo} 页的图像读不出来（渲染超时或失败）`;
    }
  }
}

function clearReadingDecorations(pageNo) {
  const tile = readingTiles.get(pageNo);
  if (!tile) return;
  injected.clearPageBlocks(tile);
  injected.clearTileMargin(tile);
}

function disconnectReadingObservers() {
  if (readingNearObserver) readingNearObserver.disconnect();
  if (readingVisibleObserver) readingVisibleObserver.disconnect();
  readingNearObserver = null;
  readingVisibleObserver = null;
}

  // ---------------------------------------------------------------- 审校环·编辑 / 树预显 / 正文段（任务 94 · L6 刀2）
  // 从 app.js 原样搬入；依赖由 init() 注入。状态仍归 app.js（get/set）。

function saveReadingInlineEdits() {
  try {
    const items = [...readingInlineEdits.entries()].map(([key, value]) => ({
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
  const key = readingKey(entry.block_id, entry.line_index);
  const line = readingLineNode(key);
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
  return readingEntries
    .filter((entry) => entry.page_no === pageNo && readingEntryVisible(entry))
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
  return readingDrafts.has(readingKey(entry.block_id, entry.line_index));
}

/** 正文流里出现过的页号（前置页 / 版心外的页不在里面）。 */
function readingFlowPages() {
  const set = new Set();
  for (const segment of readingData ? readingData.segments || [] : []) {
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
  if (readingProof && pages.length) {
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
    const line = buildReadingLine(segment, span_at(spans, i), piece);
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
  readingSuppressFollowUntil = performance.now() + ms;
}

/** 把**左侧 PDF 页列**滚到某一页（任务 72 前它也叫 scrollReadingToPage，
 *  同名把"右侧正文跳到这一页"那份覆盖掉了 —— 点左树不跳页就是它造成的）。 */
function scrollPdfColumnToPage(pageNo) {
  const scroller = el("reading-pdf-scroll");
  const tile = readingTiles.get(pageNo);
  if (!scroller || !tile) return;
  const top = tile.offsetTop - scroller.clientHeight * 0.06;
  const target = Math.max(0, top);
  // 这次滚动是我们发的：把用户事件计数记下来，左栏回调据此判定"不是用户在滚"
  readingProgramScrollSeq = readingUserScrollSeq;
  if (Math.abs(scroller.scrollTop - target) > 8) scroller.scrollTop = target;
}

/** 左→右 / 右→左的互斥标记：谁先动谁锁 350 ms。 */
function markReadingDriver(driver) {
  readingSyncDriver = driver;
  readingSyncUntil = performance.now() + 350;
}

function readingDriverActive(driver) {
  return readingSyncDriver === driver && performance.now() < readingSyncUntil;
}

function hideReadingPdfBox() {
  const box = el("reading-pdf-box");
  if (box) box.hidden = true;
  readingPendingBox = null;
}

function drawReadingPdfBox(bbox, pageNo) {
  const box = el("reading-pdf-box");
  const tile = readingTiles.get(pageNo);
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
  readingNextLog.unshift({
    at: Date.now(),
    entryKey: entry ? readingKey(entry.block_id, entry.line_index) : null,
    entryPage: entry ? entry.page_no : null,
    pageNo: readingPageNo,
    panelKey: readingPanelKey,
    panelOpened: Boolean(document.querySelector("#reading-panel-host .reading-panel")),
    lineFound: entry ? Boolean(readingLineNode(readingKey(entry.block_id, entry.line_index))) : false,
    window: readingMarksWindow,
    blocks: entry ? (readingPageBlocks.get(entry.page_no) || []).length : null,
    ...extra,
  });
  readingNextLog.length = Math.min(readingNextLog.length, 20);
  window.__b2tNextLog = readingNextLog;
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

/** UX V3 ②：判决后换到下一条未判的 entry（只在已加载窗口里找；窗口边界由 gotoNextUnreviewed 兜底）。 */
function nextReadingEntryInWindow(entry) {
  const key = readingKey(entry.block_id, entry.line_index);
  const list = readingEntries.filter((item) => readingEntryVisible(item));
  if (!list.length) return null;
  const index = list.findIndex((item) => readingKey(item.block_id, item.line_index) === key);
  const start = index >= 0 ? index + 1 : 0;
  for (let step = 0; step < list.length; step += 1) {
    const candidate = list[(start + step) % list.length];
    if (readingEntryDone(candidate)) continue;
    if (readingKey(candidate.block_id, candidate.line_index) === key) continue;
    return candidate;
  }
  return null;
}

function draftReading(entry, ack, text) {
  const key = readingKey(entry.block_id, entry.line_index);
  const stream = el("reading-stream");
  const oldLine = readingLineNode(key);
  const oldTop = oldLine && oldLine.getBoundingClientRect ? oldLine.getBoundingClientRect().top : null;
  readingDrafts.set(key, {
    block_id: entry.block_id,
    line_index: entry.line_index,
    page_no: entry.page_no,
    ack,
    text: text == null ? undefined : text,
    old_text: entry.current || "",
    at: new Date().toISOString(),
  });
  saveReadingDrafts();
  readingJudgeTimes.push(performance.now());
  if (readingJudgeTimes.length > 20) readingJudgeTimes.shift();
  noteReadingAction("judge");
  rerenderReadingLine(entry);
  renderReadingProgress();
  // UX V3 ②：判决即前进——面板不关，内容换下一条，当前行钉在视口同一高度。
  const next = nextReadingEntryInWindow(entry);
  if (!next) {
    // 窗口边界：面板**不关**（关了用户会以为被判丢了），向服务端要下一处；
    // 到达后 openReadingPanel 会原地换内容。
    readingAdvancing = true;
    (async () => {
      // 窗口边界换页会触发一次 reset；reset 与「开面板」同一帧竞争，
      // 偶尔会把刚开的面板当残留藏掉。这里按服务端队列重试到面板真的在（不跳过：
      // 已判的条目服务端 next-lines 会排除，重复调用只在同一条上重开）。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await gotoNextUnreviewed();
        if (document.querySelector("#reading-panel-host .reading-panel")) break;
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      readingAdvancing = false;
      if (!document.querySelector("#reading-panel-host .reading-panel")) retryReadingPendingPanel();
    })();
    return;
  }
  openReadingPanel(next);
  if (stream && oldTop !== null) {
    const nextLine = readingLineNode(readingKey(next.block_id, next.line_index));
    if (nextLine && nextLine.getBoundingClientRect) {
      stream.scrollTop += nextLine.getBoundingClientRect().top - oldTop;
    }
  }
}

function readingEntryLineText(entry) {
  for (const segment of readingVisibleSegments() || []) {
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
      readingDraftStorageKey(),
      JSON.stringify({
        at: new Date().toISOString(),
        items: [...readingDrafts.values()],
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
  readingJumpSettleKey = null;
  // 用户主动关 = 真的关；重绘导致的移除走 renderReading，不清 pending
  clearPendingPanel();
  const stream = el("reading-stream");
  if (!stream) return;
  for (const node of stream.querySelectorAll(".reading-panel")) node.remove();
  readingPanelKey = null;
  refreshReadingCurrentHighlight();
}

function rerenderReadingLine(entry) {
  const key = readingKey(entry.block_id, entry.line_index);
  const line = readingLineNode(key);
  if (!line) return;
  const segment = readingVisibleSegments().find((seg) =>
    (seg.line_spans || []).some(
      (span) => readingKey(span.block_id, span.line_index) === key
    )
  );
  if (!segment) return;
  const span = (segment.line_spans || []).find(
    (item) => readingKey(item.block_id, item.line_index) === key
  );
  const fresh = buildReadingLine(segment, span);
  line.replaceWith(fresh);
}

/** 挂起"重绘后要补开的面板"：key 由 entry 推出，entry 跨 reset 存活（重绘后由 retryReadingPendingPanel 补开）。 */
function setPanel(entry) {
  readingPendingPanelKey = readingKey(entry.block_id, entry.line_index);
  readingPendingPanelEntry = entry;
}

/** 清掉挂起项：用户主动关面板，或补开 / 落位已经成功。 */
function clearPendingPanel() {
  readingPendingPanelKey = null;
  readingPendingPanelEntry = null;
}

/**
 * 跳转落位结算：面板已经开出来就清挂起；没开出来就重新挂起并返回 false，
 * 交给调用方安排重试（期间任何一次重绘都由 retryReadingPendingPanel 补开）。
 */
function settlePanel(entry) {
  const key = readingKey(entry.block_id, entry.line_index);
  if (document.querySelector("#reading-panel-host .reading-panel")) {
    // UX V3：判决即前进会在「换页 + 重绘」的同一帧里开面板，reset 可能晚到一步。
    // 挂起项多留一拍：这段时间里任何 reset 都由 retryReadingPendingPanel 把面板补回来。
    setTimeout(() => {
      if (readingPanelKey === key) clearPendingPanel();
    }, 900);
    return true;
  }
  setPanel(entry);
  return false;
}

  // ---------------------------------------------------------------- 审校环·正文行 / 进度 / 高亮（任务 94 · L9 · buildReadingLine 红线）
  // 从 app.js 原样搬入；依赖由 init() 注入。状态仍归 app.js（get/set）。

function readingDraftStorageKey() {
  return injected.getProject() ? `b2t.readingDrafts.${injected.getProject().project_id}` : "";
}

function buildReadingLine(segment, span, displayText = null) {
  const key = readingKey(span.block_id, span.line_index);
  const mark = readingMarks.get(key);
  const draft = readingDrafts.get(key);
  const line = document.createElement("span");
  line.className = "reading-line";
  line.dataset.key = key;
  line.dataset.block = span.block_id;
  line.dataset.line = String(span.line_index);
  line.dataset.page = String(span.page_no);
  // `text` = 逻辑行文本（行自己的字，用于编辑与写回）；
  // `displayText` = 这一行在连续切片里实际占的字符（含行尾分隔符）。
  // **编辑仍然基于 text**，所以保存时不会把分隔符写进库里。
  const text = readingLineText(segment, span);
  line.dataset.baseText = text;
  const baseText = displayText == null ? text : displayText;
  if (mark) {
    line.dataset.level = mark.level;
    line.classList.add("is-diff");
  }
  // 就地编辑过的行：按修订三档渲染（只改显示，不改数据）
  const inline = readingInlineEdits.get(key);
  if (inline && inline.text !== inline.base) {
    paintInlineRevision(line, inline);
    return line;
  }
  if (draft) {
    line.classList.add("is-draft");
    line.textContent = draft.text != null ? draft.text : baseText;
    const chip = document.createElement("span");
    chip.className = "reading-chip";
    chip.textContent = draft.ack === "adopted" ? "草稿 · 已采用" : draft.ack === "kept" ? "草稿 · 保留" : "草稿";
    line.append(chip);
    return line;
  }
  if (mark && mark.ack === "kept") {
    line.classList.add("is-kept");
  }
  if (mark && mark.ack === "adopted") {
    line.classList.add("is-kept");
  }
  if (!mark || !readingEntryVisible(mark)) {
    line.textContent = baseText;
    return line;
  }
  // 红字：只包差异字符（汉字级实线 / 标点级虚线）
  const cacheKey = `${key}\u0000${baseText}\u0000${mark.candidate || ""}`;
  let charSpans = readingSpanCache.get(cacheKey);
  if (!charSpans) {
    charSpans = injected.computeCharSpans(baseText, mark.candidate || "");
    readingSpanCache.set(cacheKey, charSpans);
  }
  if (!charSpans.length) {
    line.textContent = baseText;
    return line;
  }
  // 任务 81：**先把差异区间并成互不重叠的并集，再按顺序拼一次**。
  // 原来是在循环里"发现重叠就把文字追加给上一个 mark"，`cursor` 与追加区间一旦错位
  // 就会重复字符（实测 `laborefficient` 被显示成 `laboreefficient`）——
  // 这类"显示 ≠ 导出"已经被咬过四次，不能再靠逐次判断补丁。
  const ranges = [];
  for (const charSpan of charSpans) {
    // 英文扩到整词（引擎给的是词级框）；中文保持单字
    const range = expandToWordRange(baseText, charSpan.aStart, charSpan.aEnd);
    const last = ranges[ranges.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      last.word = last.word || range.word;
    } else {
      ranges.push({ start: range.start, end: range.end, word: range.word });
    }
  }

  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      line.append(document.createTextNode(baseText.slice(cursor, range.start)));
    }
    const markEl = document.createElement("mark");
    markEl.className =
      "reading-mark " +
      (mark.level === "differs_punct" ? "reading-mark--punct" : "reading-mark--chars") +
      (range.word ? " reading-mark--word" : "") +
      (mark.ack ? " is-acked" : "") +
      (key === readingPanelKey ? " is-current" : "");
    // 任务 81：**占位不许进 textContent**。空区间（原文这里没有字、候选那边有）
    // 只需要"这里有个插入位置"的视觉标记，不是字符；原来用 `|| " "` 塞了空格，
    // 右栏就比导出多一个空格（`lcc: :pp` vs `lcc::pp`）。
    const slice = baseText.slice(range.start, range.end);
    if (slice) {
      markEl.textContent = slice;
    } else {
      markEl.classList.add("reading-mark--insert");
      markEl.setAttribute("aria-label", "这里缺字（候选有、原文没有）");
    }
    markEl.dataset.key = key;
    markEl.title = range.word ? "英文按词标：这个词里有差异" : "";
    line.append(markEl);
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < baseText.length) {
    line.append(document.createTextNode(baseText.slice(cursor)));
  }
  return line;
}

/**
 * 「已审 / 总数」的唯一口径：库里已判 + 本次会话草稿（**全局，不按 marks 窗口**）。
 *
 * 旧实现只数当前窗口里的 `readingEntries`，换一次窗口之前的草稿就不算了——
 * QA 实测"20 次 Enter 后已审从 0 涨到 3 又跌回 0"，根因就是它。
 */
function readingProgressNumbers() {
  const counts = readingGlobalCounts;
  const draftKeys = new Set([...readingDrafts.keys(), ...readingInlineEdits.keys()]);
  if (!counts) {
    return { processed: draftKeys.size, total: readingEntries.length };
  }
  const total = Number(counts.chars_total || 0);
  const doneInDb = Math.max(0, total - Number(counts.chars_unacked || 0));
  return { processed: Math.min(total, doneInDb + draftKeys.size), total };
}


/**
 * 插桩（只读，2026-10-29）：审校动作的**进度快照**。
 * 三个键就是 step-timing 判"卡住"的口径（pageNo / 已判条数 / 面板开合），
 * 由这里传进去——模块不许自己去读别的模块状态（Architect §21.10）。
 */
function stepTimingProgress() {
  let processed = 0;
  try {
    processed = Number(readingProgressNumbers().processed || 0);
  } catch (error) {
    processed = 0;                      // 统计读不到时不许影响审校
  }
  return { pageNo: readingPageNo, judged: processed, panel: readingPanelKey ? "open" : "" };
}

/** 记一次审校动作。`StepTiming` 不在时是 no-op；统计永远不许改变审校行为。 */
function noteReadingAction(action) {
  window.StepTiming?.bump(action, stepTimingProgress());
}

/**
 * UX V3 ③：进度说人话——主数字只留「待判 N 处」，判过 20 条给「约剩 M 分钟」，
 * 汉字 / 标点两条独立轨。
 *
 * `#reading-progress-text` 保留旧句子（已审 X / Y 条）给既有行为测试与排障对照；
 * 新增节点都是**运行时补**的（index.html 不动），拿不到父节点就安静跳过。
 */
function renderReadingProgressExtras(processed, total, counts) {
  const legacy = el("reading-progress-text");
  const group = legacy && legacy.parentNode;
  if (!group || typeof document.createElement !== "function") return;
  const ensure = (id, factory, before) => {
    let node = el(id);
    if (!node) {
      node = factory();
      node.id = id;
      const anchor = before ? legacy : legacy.nextSibling;
      if (group.insertBefore) group.insertBefore(node, anchor);
      else group.append(node);
    }
    return node;
  };
  const pending = ensure("reading-pending-text", () => {
    const node = document.createElement("strong");
    node.className = "reading-pending";
    return node;
  }, true);
  const pendingLeft = Math.max(0, total - processed);
  pending.textContent = `待判 ${pendingLeft} 处`;
  pending.title = `汉字差异：全书 ${total} 条，已判 ${processed} 条；标点差异在右侧独立轨`;
  pending.classList.toggle("is-done", total > 0 && pendingLeft === 0);

  const punctTotal = Number(counts && counts.punct_total ? counts.punct_total : 0);
  const punctLeft = Number(counts && counts.punct_unacked ? counts.punct_unacked : 0);
  let punct = group.querySelector ? group.querySelector('[data-reading="progress-punct"]') : null;
  if (!punct && punctTotal > 0) {
    punct = document.createElement("span");
    punct.dataset.reading = "progress-punct";
    punct.className = "muted reading-progress__punct";
    if (group.insertBefore) group.insertBefore(punct, legacy);
    else group.append(punct);
  }
  if (punct) {
    punct.hidden = punctTotal <= 0;
    punct.textContent = `标点 待判 ${Math.max(0, punctLeft)} 处 / ${punctTotal}`;
  }

  // 速度：最近 20 次判决的间隔（本会话真实事件时间，不估、不补）。
  const eta = ensure("reading-progress-eta", () => {
    const node = document.createElement("span");
    node.className = "muted reading-progress__eta";
    return node;
  }, false);
  const times = readingJudgeTimes;
  if (times.length >= 20 && pendingLeft > 0) {
    const span = times[times.length - 1] - times[0];
    const perItem = span / Math.max(1, times.length - 1);
    const minutes = Math.max(1, Math.ceil((pendingLeft * perItem) / 60000));
    eta.hidden = false;
    eta.textContent = `约剩 ${minutes} 分钟`;
  } else {
    eta.hidden = times.length < 20;
    eta.textContent = "";
  }
}

function renderReadingProgress() {
  // 任务 67：marks 只加载窗口，`readingEntries` 不再是全书 —— 进度数字必须用
  // 服务端给的全书计数，否则换一次窗口进度条就缩水一次（用户会以为审过的丢了）。
  const { processed, total } = readingProgressNumbers();
  const drafts = readingDrafts.size + readingInlineEdits.size;
  // 标点计数不在这里：角标文本由 `renderPunctGroupBadge()` 写 `reading-punct-count`，
  // 进度条只算"汉字差异条数"（`readingProgressNumbers()`，不含标点）。
  el("reading-progress-text").textContent = `已审 ${processed} / ${total} 条`;
  const fill = el("reading-progress-fill");
  fill.style.width = total ? `${Math.round((processed / total) * 100)}%` : "0%";
  fill.classList.toggle("is-done", total > 0 && processed >= total);
  const chip = el("reading-draft-chip");
  chip.hidden = drafts === 0;
  chip.textContent = `未提交 ${drafts}`;
  const submit = el("reading-submit");
  submit.disabled = drafts === 0;
  submit.textContent = drafts ? `提交 ${drafts} 处` : "提交 0 处";
  el("reading-submit").classList.toggle("is-ready", drafts > 0);
  try {
    renderReadingProgressExtras(processed, total, readingGlobalCounts);
  } catch (error) {
    // 进度增强不许影响审校主流程；排障走控制台，不新增 window 埋点（R6）。
    if (typeof console === "object" && console && console.warn) {
      console.warn("[reading-progress] 增强进度渲染失败：", error && error.message ? error.message : error);
    }
  }
}

/**
 * 当前审校项的"两边同款"高亮（任务 61）。
 *
 * 用户原话：「左边 pdf 里应该把选中的行高亮出来，右边也高亮出对应的行（左右最好用同样的
 * 颜色和高亮方式，如方框框选）」。所以这里只做一件事：把 `readingPanelKey` 那一条
 * 在**文本流**和**页面上**都标成 `is-current`（琥珀实线框 + 浅底），其余差异维持弱化红。
 * 只改样式，不滚页、不动跟随。
 */
function refreshReadingCurrentHighlight() {
  for (const node of document.querySelectorAll("#reading-stream .reading-line.is-current")) {
    node.classList.remove("is-current");
  }
  for (const node of document.querySelectorAll("#reading-stream .reading-mark.is-current")) {
    node.classList.remove("is-current");
  }
  if (readingPanelKey) {
    const line = readingLineNode(readingPanelKey);
    if (line) {
      line.classList.add("is-current");
      for (const mark of line.querySelectorAll(".reading-mark")) mark.classList.add("is-current");
    }
  }
  for (const item of document.querySelectorAll("#reading-tree .reading-tree__item.is-current")) {
    if (item.dataset.key !== readingPanelKey) item.classList.remove("is-current");
  }
  if (readingPanelKey) {
    const item = document.querySelector(`#reading-tree .reading-tree__item[data-key="${readingPanelKey}"]`);
    if (item) item.classList.add("is-current");
  }
  // 页面上只有已加载块的页画过差异框：重画这些页 + 当前 key 所在页
  for (const pageNo of readingPageBlocks.keys()) paintReadingDiffBoxes(pageNo);
  if (readingPageNo) paintReadingDiffBoxes(readingPageNo);
}

  // ---------------------------------------------------------------- 审校环·词边界 / 行文本 / 行内修订 / 行节点（任务 94 · L10）
  // 从 app.js 原样搬入；依赖由 init() 注入。状态仍归 app.js（get/set）。

/**
 * 把一个差异字符区间扩成"字 / 词"单位（任务 59）。
 *
 * - 中文：一个字就是单位，不扩（本来就只标差异字）；
 * - 英文：引擎给的是**词级**框，扩到整词边界（`Ladyship's` 一框就整词标）；
 * - 没有字框也不影响这一步：词边界从文本本身算，字框只用于页面上的色块。
 */
function expandToWordRange(text, start, end) {
  if (!/[A-Za-z]/.test(text.slice(start, end))) return { start, end, word: false };
  let left = start;
  while (left > 0 && /[A-Za-z'’\-]/.test(text[left - 1])) left -= 1;
  let right = end;
  while (right < text.length && /[A-Za-z'’\-]/.test(text[right])) right += 1;
  return { start: left, end: right, word: true };
}

function readingLineText(segment, span) {
  return segment.text.slice(span.start, span.end);
}

/**
 * 一行被就地编辑过 → 按当前修订档渲染（任务 66）。
 *
 * - `all`：删除红删除线 + 插入绿下划线；连续 >12 字的改动折叠成「⟦替换 N 字⟧」
 * - `simple`：只显示终稿 + 左边距琥珀条 + 段首 ▸（点 ▸ 临时切回 all）
 * - `none`：终稿无痕，但**改过的行左侧仍有一个小圆点**（不然改错了看不出来）
 */
function paintInlineRevision(line, inline) {
  const key = line.dataset.key;
  line.classList.add("is-inline-edited");
  line.dataset.revBase = inline.base;
  line.dataset.revText = inline.text;
  const chip = document.createElement("span");
  chip.className = "reading-chip reading-chip--edit";
  chip.textContent = "草稿";
  if (readingMarkupLevel === "none") {
    line.textContent = inline.text;
    line.append(chip);
    line.classList.add("is-changed-dot");
    return;
  }
  if (readingMarkupLevel === "simple") {
    line.textContent = inline.text;
    line.append(chip);
    line.classList.add("is-changed-bar");
    return;
  }
  const spans = injected.computeCharSpans(inline.base, inline.text);
  const replaced =
    spans.reduce((sum, span) => sum + Math.max(span.aEnd - span.aStart, span.bEnd - span.bStart), 0);
  line.classList.add("is-changed-bar");
  if (replaced > 12) {
    // 长改动：折叠，点一下展开（展开是临时状态，不改数据）
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "reading-fold";
    fold.textContent = `⟦替换 ${replaced} 字 · 点击展开⟧`;
    fold.dataset.key = key;
    if (line.dataset.expanded !== "1") {
      line.append(fold, chip);
      return;
    }
    fold.remove();
  }
  line.append(document.createTextNode(inline.text.slice(0, 0)));
  let cursor = 0;
  for (const span of spans) {
    if (span.aStart > cursor) {
      line.append(document.createTextNode(inline.text.slice(cursor, span.bStart)));
    }
    if (span.aEnd > span.aStart) {
      const delEl = document.createElement("del");
      delEl.className = "reading-del";
      delEl.textContent = inline.base.slice(span.aStart, span.aEnd);
      line.append(delEl);
    }
    if (span.bEnd > span.bStart) {
      const insEl = document.createElement("ins");
      insEl.className = "reading-ins";
      insEl.textContent = inline.text.slice(span.bStart, span.bEnd);
      line.append(insEl);
    }
    cursor = span.bEnd;
  }
  if (cursor < inline.text.length) {
    line.append(document.createTextNode(inline.text.slice(cursor)));
  }
  line.append(chip);
}

function readingLineNode(key) {
  const stream = el("reading-stream");
  return stream ? stream.querySelector(`.reading-line[data-key="${key}"]`) : null;
}

  // ---------------------------------------------------------------- 审校环·收口簇（L11+L12；display-prefs 暂驻，到期 = core/display-prefs 建立时）
  // 从 app.js 原样搬入；依赖由 init() 注入。状态仍归 app.js（get/set）。

function readingKey(blockId, lineIndex) {
  return `${blockId}:${lineIndex}`;
}

function readingVisibleSegments() {
  if (!readingData) return [];
  let includeFootnotes = false;
  try {
    includeFootnotes = Boolean(injected.exportOptions().include_footnotes);
  } catch {
    includeFootnotes = false;
  }
  return (readingData.segments || []).filter((segment) => {
    if (!segment.text || !segment.text.trim()) return false;
    if (!includeFootnotes && segment.type === "footnote") return false;
    return true;
  });
}

function readingEntryVisible(entry) {
  const draft = readingDrafts.get(readingKey(entry.block_id, entry.line_index));
  if (readingFilter === "chars" && entry.level !== "differs_chars") return false;
  if (readingFilter === "unacked") {
    if (entry.ack) return false;
    if (draft) return false;
  }
  return true;
}

/** 当前悬停段涉及的所有块 id（跨页段两页都算）。 */
function readingHoveredBlockIds() {
  const segment = readingHoveredSeq !== null
    ? (readingVisibleSegments() || []).find((item) => item.seq === readingHoveredSeq)
    : null;
  if (!segment) return null;
  return new Set((segment.line_spans || []).map((span) => span.block_id));
}

function readingDiffUnits(lineText, candidate, wordBoxes) {
  const spans = injected.computeCharSpans(lineText || "", candidate || "");
  if (!spans.length) return { ranges: [], kind: null };
  const kind = spans.some((span) => span.kind !== "replace") ? "punct" : "chars";
  if (!wordBoxes || !wordBoxes.length) return { ranges: null, kind };
  // 字框的文本拼起来应与行文本一致；按累加长度把差异区间映射到字框下标
  // 任务 86：两条分支，**中文走旧的偏移映射，英文走位置映射**。
  // 旧代码"拼接长度相等就按偏移画"看着土，但对中文是对的——先想清楚它为什么能工作，
  // 再决定哪条路给谁走（实测：中文逐字框拼接长度等于行文本长度）。
  const concatLength = wordBoxes.reduce((sum, unit) => sum + String(unit.text || "").length, 0);
  const starts = [];
  if (concatLength === (lineText || "").length) {
    // 分支 1：纯偏移（中文 / 无空格插入的场景），没有查找、不可能 miss
    let offset = 0;
    for (const unit of wordBoxes) {
      starts.push(offset);
      offset += String(unit.text || "").length;
    }
    wordBoxMappingStats.offset += 1;
  } else {
    // 分支 2：按位置找词（英文：词间空格不属于任何框），找不到就整行退化
    let cursor = 0;
    for (const unit of wordBoxes) {
      const word = String(unit.text || "");
      if (!word) {
        starts.push(cursor);
        continue;
      }
      const at = (lineText || "").indexOf(word, cursor);
      if (at < 0) {
        wordBoxMappingStats.positionMiss += 1;
        if (wordBoxMappingStats.missSamples.length < 3) {
          wordBoxMappingStats.missSamples.push(String(lineText || "").slice(0, 60));
        }
        return { ranges: null, kind };
      }
      starts.push(at);
      cursor = at + word.length;
    }
    wordBoxMappingStats.position += 1;
  }
  const wanted = new Set();
  for (const span of spans) {
    for (let index = 0; index < wordBoxes.length; index += 1) {
      const start = starts[index];
      const end = start + String(wordBoxes[index].text || "").length;
      if (end > span.aStart && start < span.aEnd) wanted.add(index);
    }
  }
  return { ranges: [...wanted].sort((a, b) => a - b), kind };
}

function readingPageRecord(pageNo) {
  if (!injected.getProject()) return null;
  return injected.getProject().pages.find((item) => item.page_no === pageNo) || null;
}

/** 给某一页的块框套上"联动"样式。 */
function applyReadingLinked(pageNo) {
  const ids = readingHoveredBlockIds();
  const tile = readingTiles.get(pageNo);
  if (!tile) return;
  for (const box of tile.querySelectorAll(".box[data-block-id]")) {
    box.classList.toggle("is-linked", Boolean(ids && ids.has(box.dataset.blockId)));
  }
}

/** 画一页的版心 + 块框（复用页面视图那套渲染，不另写）。 */
function paintReadingTile(pageNo) {
  const tile = readingTiles.get(pageNo);
  const page = readingPageRecord(pageNo);
  if (!tile || !page) return;
  injected.paintTileMargin(tile, page);
  const blocks = readingPageBlocks.get(pageNo) || [];
  const overlay = tile.querySelector(".page-overlay");
  if (!overlay) return;
  if (injected.getPagesOverlayOn() && blocks.length) {
    if (overlay._renderedBlocks !== blocks) injected.renderPageBlocks(tile, blocks, { details: false });
    applyReadingLinked(pageNo);
  } else {
    injected.clearPageBlocks(tile);
  }
  // 当前页：顺便把差异字 / 词画成色块（只画差异，相同字不画）
  if (pageNo === readingPageNo) paintReadingDiffBoxes(pageNo);
}

/**
 * 进「正文审校」默认开版心 + 块框（任务 57）。
 *
 * 这里是读稿主界面：用户要看到"这一段的字在左边哪一块上"。块框用页面视图同一份状态；
 * 两个开关都只改显示，不写库。
 */
function setReviewOverlaysForReading() {
  if (!injected.getPagesMarginOn()) {
    injected.setPagesMarginOn( true);
    injected.savePageMarginPreference();
  }
  if (!injected.getPagesOverlayOn()) {
    injected.setPagesOverlayOn( true);
    injected.savePageOverlayPreference();
  }
  // 刀 6：两个开关按钮的 is-on 归页面视图模块（这里不再碰 #pages-margin-toggle / #pages-overlay-toggle）。
  injected.syncToolbarToggles?.();
  // 已经画过的页要按新开关重画一遍（否则要等下一次滚动才出框）
  for (const pageNo of readingVisibleSet) paintReadingTile(pageNo);
}

function paintReadingDiffBoxes(pageNo) {
  const layer = el("reading-diff-layer");
  const tile = readingTiles.get(pageNo);
  if (!layer) return;
  for (const node of layer.querySelectorAll(".reading-diff-box")) node.remove();
  if (!tile) return;
  const blocks = readingPageBlocks.get(pageNo) || [];
  if (!blocks.length) return;
  const width = tile.clientWidth || tile.getBoundingClientRect().width;
  const height = tile.clientHeight || tile.getBoundingClientRect().height;
  if (!width || !height) return;
  const top = tile.offsetTop;
  const addBox = (bbox, className) => {
    const node = document.createElement("div");
    node.className = "reading-diff-box" + (className ? " " + className : "");
    node.style.left = `${Math.round(bbox[0] * width)}px`;
    node.style.top = `${Math.round(top + bbox[1] * height)}px`;
    node.style.width = `${Math.max(2, Math.round((bbox[2] - bbox[0]) * width))}px`;
    node.style.height = `${Math.max(2, Math.round((bbox[3] - bbox[1]) * height))}px`;
    layer.append(node);
  };
  // 这一页上**所有可见的差异行**：只画差异字 / 词，相同字一个都不画
  for (const block of blocks) {
    if (!block.lines) continue;
    for (let index = 0; index < block.lines.length; index += 1) {
      const line = block.lines[index];
      const key = readingKey(block.block_id, index);
      const mark = readingMarks.get(key);
      if (!mark || !readingEntryVisible(mark)) continue;
      // 三态：当前审校项（琥珀实线框）/ 已审（淡绿）/ 其他未审（弱化红）
      const state = key === readingPanelKey ? " is-current" : mark.ack ? " is-acked" : "";
      const words = line.word_boxes ? JSON.parse(line.word_boxes) : [];
      const { ranges, kind } = readingDiffUnits(line.text || "", mark.candidate || "", words);
      // **行层常驻**（用户要求：一眼看到"这一行有差异"），字层画在它上面看"差在这几个字"。
      // 原来只有"拿不到字框"时才退化出一行，于是绝大多数行只有零散字块、没有行框。
      if (line.bbox) addBox(line.bbox, "reading-diff-box--line" + state);
      if (ranges === null) continue;
      for (const wordIndex of ranges) {
        const bbox = words[wordIndex] && words[wordIndex].bbox;
        if (bbox) addBox(bbox, (kind === "punct" ? "reading-diff-box--punct" : "") + state);
      }
    }
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
    // 未 init 时保持搬走前的 no-op（原 enter 注入项没接上时也是空转）；生产 boot 必注入 getProject
    if (!injected.getProject) return;
    clearReadingIntents(true);
    setReviewOverlaysForReading();
    openReading();
  }

  // 任务 94（2026-10-29 裁决）：**不导出 `exit`**。原来这里是
  // `clearReadingIntents(true); injected.exit?.();`，但 `showView` 从不调用它
  // （`.exit(` 全仓库 0 个调用点）——永不执行的导出，会让棘轮松一格。
  // 实测重复 `enter()` 不重复绑监听、观察器"建 1 断 1"稳定，今天不需要离开时清理这个口子。
  // 将来真要"切走就丢掉欠着的 rAF / 断观察器"，再立一个有真实调用点的导出（§20.1）。

  function getCurrent() {
    return {
      projectId: injected.getProjectId ? injected.getProjectId() : null,
      pageNo: readingPageNo,
    };
  }

  function toggleFollow() {
    setReadingFollow(!readingFollow);
  }

  /** 正文流/标记需要按当前设置重建时由外壳触发（Architect 接口第 5 个）。 */
  async function reload() {
    await readingReloadAfterBatch();
  }

  window.ReadingView = {
    init,
    enter,
    getCurrent,
    toggleFollow,
    reload,
    // 偏好与布局已回收为模块内部函数（Slice 2 收尾）：app.js 侧 0 个消费者，
    // 5 个临时转发导出已删除——公开接口收敛到 6 个稳定项，只降不升。
  };
})();
