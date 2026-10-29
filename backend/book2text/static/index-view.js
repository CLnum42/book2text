/**
 * 目录确认视图模块（任务 94 · Slice I1：整段迁入）
 *
 * **经典脚本，不是 ES module**：`<script src="/static/index-view.js">` 在 app.js 之前加载，
 * 靠 `window.IndexView` 对外暴露（R6：一个文件只露一个接口对象）。`type="module"` 默认
 * deferred，会改 boot 时序——这个仓库一半 bug 是时序问题，拆的时候不动它。
 *
 * 用户要的是"394 页扫描件一眼看过去，能确认页码排得对不对"。所以这一屏是**连续页列**：
 * 页块只是固定宽高比的占位空壳（滚动高度靠它），图和块数据只给视口附近加载，
 * 滚出去的页立刻清掉版心 / 块框 / 首行框，离得远的页再把 img 的 src 摘掉。
 * 版心 / 块框 / 首行框与页面视图、预览共用同一套画法（`paintTileMargin` / `renderPageBlocks`），
 * 缩放四档也共用 `pageZoomIndex`——**一份状态，三个视图**，不许各写一套。
 *
 * **Slice I1（2026-10-29）**：41 个函数 + 23 个状态整段从 app.js 迁入，函数体**逐字节未改**，
 * 只把 app.js 的 25 个顶层符号 + 2 个页面视图 DOM 句柄换成 `injected.xxx`：
 *   状态 getter 6（project / detailPageNo / pageZoomIndex / pagesMarginOn / pagesOverlayOn / imageQualityMode）
 *   状态 setter 5（pageZoomIndex / pageZoomTouched / pagesMarginOn / pagesOverlayOn / imageQuality）
 *   isActive 1、共享常量 3、页面渲染服务 4、块缓存服务 4、页面开关服务 4、
 *   普通服务 6（apiJson / goToWorkflowStep / loadPageIndex / loadIndexBlocks /
 *   clearImagePlaceholder / setImageQuality）、跨子树句柄 2。
 * `el` 不进 deps（模块自带一行，§20.4）。
 *
 * **留在 app.js 的一小撮**（它们不是"目录视图的实现"，是别人的依赖）：
 * - 页码索引缓存 `pageIndexData / pageIndexProject`——预览也在读；
 * - `loadPageIndex` / `loadIndexBlocks` / `clearImagePlaceholder`——三个纯数据服务，
 *   阅读左栏与预览都在调；前两者**不碰任何 DOM**（I1 把 DOM 写点搬进了本模块）；
 * - `imageQualityMode` + localStorage + 设置面板 radio——页面视图 / 审校 / 预览都读这个档位。
 *
 * **接口 3 个**：`init(deps) / enter() / refresh()`（§20.6 签字 4 个，2026-10-29 实测后删 `exit` 降到 3）。
 * `refresh` 是 §20.1 允许的**业务方法**，5 个真实调用点
 * （页面视图切版心 ×2、切块框叠加层 ×2、boot 里清晰度档位初始化后 ×1）——原代码在前 4 处
 * 由外壳 `if (currentView === "index")` 替模块判断"我现在在不在"，`refresh` 把
 * 这个守卫搬回模块自己（§20「模块不许读 currentView」）。
 * **没有参数包**：守卫留在 `paintIndexDecorations()` 自己身上（它本来就有），
 * 写一次就够（§20.6 明确否决 `refresh({toggles:false})` 这类配置项化入口）。
 * **语义写死**（Chief 条件 ①）：`refresh()` 只重画装饰与开关态，不做数据加载、不做全量重建；
 * 换清晰度档要取图，所以走模块内的 `applyImageQuality()`，不走 `refresh()`。
 * `getCurrent` 按需——没有调用方，不加。
 *
 * **本模块不提供 `exit()`（2026-10-29 裁决，别补回来）**：`enter()` 幂等——监听只绑新元素、
 * 观察器非空即复用（本模块实测 3 轮 `showView` 来回切，新增 IO 0 次）。三个模块当初都导出了 `exit`，
 * 而 `showView` 从不调用它，是**永不执行的导出**（`.exit(` 全仓库 0 命中）。
 * 实测（真浏览器，按「元素 × 事件类型」数活着的处理函数）：重复 `enter()` 不重复绑、不重建观察器。
 * **将来若要断观察器**（已知缺口：切走视图后隐藏元素仍会回调，见 `docs/known-limitations.md` L-108），
 * 那时再引入 `exit()`，并附等价性证据与真实调用点。
 */
(function () {
  "use strict";

  /** 注入面：boot() 一次传齐；缺键时保持搬走前的语义（读不到就 no-op / 空值）。 */
  let injected = {};

  const el = (id) => document.getElementById(id);

let indexCurrentPage = null;
let indexJumpTimer = null;
/** 视口上下各预加载多少像素（约 ±3 页；628 高时一页约 700–900 px）。 */
const INDEX_NEAR_MARGIN = 2600;
/** 同时挂 `src` 的页图上限：再多就把离当前页最远的摘掉。 */
const INDEX_IMAGE_LIMIT = 20;

let indexTiles = new Map();
/** 目录确认当前页图用的档位（缩放变化时据此决定要不要重取）。 */
let indexImageProfile = "";
let indexPagesProject = null;
let indexNearPages = new Set();
/** 真正在视口里的页：版心 / 块框 / 首行框只给这些页画（任务 48）。 */
let indexVisiblePages = new Set();
let indexLoadedImages = new Set();
/** 每页图失败过几次（自动重试一次，还不行就在页块里给「点此重试」）。 */
const indexImageAttempts = new Map();
const INDEX_IMAGE_TIMEOUT_MS = 10000;
let indexBlocksByPage = new Map();
const indexBlocksPending = new Map();
let indexObserver = null;
let indexVisibleObserver = null;
let indexObserverMargin = 0;
/** 页图按"离当前页由近到远"排队，一次只解一张：跳页时不会一帧里解 7 张大图。 */
const indexImageQueue = [];
let indexImagePumping = false;
let indexTops = [];
let indexTopMap = new Map();
let indexScrollRaf = 0;
let indexResizeRaf = 0;


/** 进入目录确认步：有缓存就用缓存；没有就生成一次，然后停在"当前页"。 */
async function openPageIndex() {
  if (!injected.getProject()) return;
  // 目录确认默认开版心 + 块框：用户来这里就是要看"这一页的版心和块长什么样"。
  // 这两个开关和页面视图是同一份状态，在这里改，回去也生效。
  if (!injected.getPagesMarginOn()) {
    injected.setPagesMarginOn(true);
    injected.savePageMarginPreference();
    injected.getPagesMarginToggle()?.classList.add("is-on");
  }
  if (!injected.getPagesOverlayOn()) {
    injected.setPagesOverlayOn(true);
    injected.savePageOverlayPreference();
    injected.getPagesOverlayToggle()?.classList.add("is-on");
  }
  syncIndexToggles();
  if (!injected.getPageIndexData() || injected.getPageIndexProject() !== injected.getProject().project_id) {
    // 加载期间的"正在生成 / 清空列表 / 藏起空态"原本长在 app.js 的 `loadPageIndex` 里，
    // 那是三个 DOM 写点（R3：目录子树的 id 归本模块），随 Slice I1 搬到这里。
    // **时点不变**：仍在 await 之前，且加载没在跑的时候才写（原来 busy 早退时一个字都不写）。
    if (!injected.getPageIndexLoading()) {
      el("index-meta").textContent = "正在生成页码索引…";
      el("index-list").innerHTML = "";
      el("index-empty").hidden = true;
    }
    const result = await injected.loadPageIndex();
    if (result.status === "ok") renderPageIndex();
    else if (result.status === "error") {
      el("index-meta").textContent = `页码索引读取失败：${result.message}`;
    }
  } else {
    renderPageIndex();
  }
  syncIndexJumpState();
  const empty = el("index-empty");
  if (!injected.getPageIndexData() || !injected.getPageIndexData().pages.length) {
    empty.hidden = false;
    setIndexImageStatus("这一页还没有页码索引。");
    return;
  }
  empty.hidden = true;
  ensureIndexPages();
  applyIndexZoom();
  measureIndexTiles();
  const target =
    (indexCurrentPage &&
      injected.getProject().pages.some((item) => item.page_no === indexCurrentPage)
      ? indexCurrentPage
      : null) ||
    (injected.getDetailPageNo() !== null ? injected.getDetailPageNo() : null) ||
    injected.getPageIndexData().pages[0].page_no;
  openIndexPage(target, { scrollList: true });
  // 开页会清跳转提示；页序模式的"没有印刷页码"要在**开页之后**再摆一次
  syncIndexJumpState();
}

function renderPageIndex() {
  const list = el("index-list");
  const meta = el("index-meta");
  list.innerHTML = "";
  if (!injected.getPageIndexData()) {
    meta.textContent = "";
    renderIndexNotice(null);
    return;
  }
  const stats = injected.getPageIndexData().stats || {};
  const pageOrderOnly = indexIsPageOrderOnly();
  const bits = pageOrderOnly
    ? // 一页印刷页码都没有：这是一份 PDF 页序，别写成"0 页有印刷页码"让人以为是目录
      [`仅 PDF 页序 · ${stats.total || 0} 页`, "还没有印刷页码"]
    : [`${stats.total || 0} 页`, `${stats.numbered || 0} 页有印刷页码`];
  if (stats.chapters) bits.push(`${stats.chapters} 章`);
  if (injected.getPageIndexData().numbering_step === 2) bits.push("页码隔 2 递增");
  if (!pageOrderOnly && stats.missing) {
    // 缺页码分四类：前置/后置、目录页、回目页（都不印）、真没识别出来。前三类不是失败。
    if (stats.missing_front_back) bits.push(`${stats.missing_front_back} 页前置/后置`);
    if (stats.missing_toc) bits.push(`${stats.missing_toc} 页目录页`);
    if (stats.missing_chapter) bits.push(`${stats.missing_chapter} 页回目页`);
    if (stats.missing_unknown) bits.push(`${stats.missing_unknown} 页未识别页码`);
  }
  meta.textContent = bits.join(" · ");
  meta.title = (injected.getPageIndexData().notes || []).join("\n");

  renderIndexNotice(pageOrderOnly ? stats : null);

  const fragment = document.createDocumentFragment();
  for (const entry of injected.getPageIndexData().pages) {
    if (entry.chapter) {
      const head = document.createElement("li");
      head.className = "index-chapter";
      head.dataset.pageNo = String(entry.page_no);
      head.tabIndex = 0;
      const title = document.createElement("span");
      title.textContent = entry.chapter;
      const where = document.createElement("span");
      where.className = "muted";
      where.textContent = `PDF ${entry.page_no} 起`;
      head.append(title, where);
      fragment.append(head);
    }
    const row = document.createElement("li");
    if (pageOrderOnly) {
      // 只有页序：一行只写"PDF 第 N 页"，不摆"未识别页码"占位——那是目录才有的东西
      row.className = "index-row is-page-order";
      row.dataset.pageNo = String(entry.page_no);
      row.tabIndex = 0;
      row.title = `PDF 第 ${entry.page_no} 页（还没有印刷页码）`;
      const pdf = document.createElement("span");
      pdf.className = "index-row__pdf";
      pdf.textContent = `PDF 第 ${entry.page_no} 页`;
      const note = document.createElement("span");
      note.className = "index-row__note";
      note.textContent = "无印刷页码";
      row.append(pdf, note);
      fragment.append(row);
      continue;
    }
    const reason = entry.missing ? entry.missing_reason || "unknown" : null;
    // 前三类别叫"未识别"——它们本来就不印页码，写成失败会让人以为识别坏了
    row.className =
      "index-row" +
      (entry.missing ? " is-missing" : "") +
      (reason === "front_back" || reason === "toc" || reason === "chapter"
        ? " is-explain"
        : "");
    row.dataset.pageNo = String(entry.page_no);
    row.tabIndex = 0;
    const extraJump = (entry.jump || []).filter(
      (value) => !entry.printed.includes(value)
    );
    row.title = entry.missing
      ? reason === "front_back"
        ? `第 ${entry.page_no} 页是前置 / 后置页，本来就不印阿拉伯页码；照样可以点进去`
        : reason === "toc"
          ? `第 ${entry.page_no} 页是目录页，本来就不印阿拉伯页码；照样可以点进去`
          : reason === "chapter"
            ? `第 ${entry.page_no} 页是回目页（${entry.chapter || "回目首页"}），排版惯例不印页码；照样可以点进去`
            : `第 ${entry.page_no} 页没有识别到印刷页码，照样可以点进去`
      : `印刷页 ${entry.printed[0] || ""}` +
        (extraJump.length ? `（输入 ${extraJump.join(" / ")} 也会跳到这一页）` : "");
    const printed = document.createElement("span");
    printed.className = "index-row__printed";
    printed.textContent = entry.missing
      ? reason === "front_back"
        ? "前置/后置"
        : reason === "toc"
          ? "目录页"
          : reason === "chapter"
            ? "回目页"
            : "未识别页码"
      : entry.printed[0] || "";
    const pdf = document.createElement("span");
    pdf.className = "index-row__pdf";
    pdf.textContent = `PDF ${entry.page_no}`;
    row.append(printed, pdf);
    fragment.append(row);
  }
  list.append(fragment);
  highlightIndexRow(false);
}

/** 整本一页印刷页码都没有 = 这份列表只是 PDF 页序（还没识别 / 没定位页码）。 */
function indexIsPageOrderOnly() {
  const stats = (injected.getPageIndexData() && injected.getPageIndexData().stats) || {};
  if (typeof stats.page_order_only === "boolean") return stats.page_order_only;
  return !Number(stats.numbered || 0);
}

/** 页序模式的说明条：这不是目录，印刷页码还没出来。 */
function renderIndexNotice(stats) {
  const notice = el("index-notice");
  if (!notice) return;
  if (!stats) {
    notice.hidden = true;
    return;
  }
  el("index-notice-title").textContent = "尚未识别：下面只有 PDF 页序";
  el("index-notice-text").textContent =
    `共 ${stats.total || 0} 页，一页印刷页码都还没有。` +
    "印刷页码来自识别出的页码行（再经「页码定位」确认），所以这一步要等那两件事做完才有内容；" +
    "现在点任意一页只是按 PDF 页序翻页。";
  const go = el("index-notice-go");
  go.hidden = false;
  go.textContent = "打开「文字识别」";
  notice.hidden = false;
}


// ---------------------------------------------------------------- 右：连续页列（按需加载）

function indexPageRecord(pageNo) {
  if (!injected.getProject()) return null;
  return injected.getProject().pages.find((item) => item.page_no === pageNo) || null;
}

/** 页块只在换项目 / 页数变了时重建：394 个空壳，图与块都还是空的。 */
function ensureIndexPages() {
  if (!injected.getProject()) return;
  const total = injected.getProject().pages.length;
  const same = indexPagesProject === injected.getProject().project_id &&
    indexTiles.size === total &&
    el("index-pages") &&
    el("index-pages").querySelector(".index-page");
  if (same) return;
  buildIndexPages();
}

function buildIndexPages() {
  const wrap = el("index-pages");
  if (!wrap || !injected.getProject()) return;
  disconnectIndexObserver();
  // PageTile 的句柄挂在页块上；重建前先交还，别让注册表里留着指向旧 DOM 的记录。
  if (window.PageTile) {
    for (const tile of indexTiles.values()) {
      if (tile.__indexTile) window.PageTile.release(tile.__indexTile);
    }
  }
  wrap.innerHTML = "";
  indexTiles.clear();
  indexNearPages.clear();
  indexLoadedImages.clear();
  indexImageAttempts.clear();
  indexBlocksByPage.clear();
  indexBlocksPending.clear();
  indexTops = [];
  indexTopMap = new Map();
  const fragment = document.createDocumentFragment();
  for (const page of injected.getProject().pages) {
    const tile = document.createElement("div");
    tile.className = "index-page";
    tile.dataset.pageNo = String(page.page_no);
    // 图没到之前先占住真实比例：滚动条、二分定位和"滚到第 394 页"才稳定
    tile.style.aspectRatio = `${page.width_pt} / ${page.height_pt}`;

    const image = document.createElement("img");
    image.alt = `第 ${page.page_no} 页`;
    image.decoding = "async";

    // 和页面视图 / 目录确认原来那一套完全相同：版心 + 块框 + 首行标记
    const margin = document.createElement("div");
    margin.className = "page-margin";
    margin.hidden = true;
    const marginBox = document.createElement("div");
    marginBox.className = "page-margin__box";
    margin.append(marginBox);

    const overlay = document.createElement("div");
    overlay.className = "page-overlay page-overlay--readonly page-overlay--labeled";
    overlay.hidden = true;

    const firstline = document.createElement("div");
    firstline.className = "index-firstline";
    firstline.hidden = true;

    tile.append(image, margin, overlay, firstline);
    indexTiles.set(page.page_no, tile);
    fragment.append(tile);
  }
  wrap.append(fragment);
  indexPagesProject = injected.getProject().project_id;
  observeIndexTiles();
  window.__b2tIndexMetrics = {
    ...(window.__b2tIndexMetrics || {}),
    pages: indexTiles.size,
  };
}

function disconnectIndexObserver() {
  if (indexObserver) {
    indexObserver.disconnect();
    indexObserver = null;
  }
  if (indexVisibleObserver) {
    indexVisibleObserver.disconnect();
    indexVisibleObserver = null;
  }
}

/**
 * 两个观察者，各管一件事：
 * - near（上下放宽约 ±3 页）：只负责把图 / 块数据**提前拿到**，不画；
 * - visible（视口内）：负责画版心 / 块框 / 首行框，滚出去立刻清掉。
 * 这样滚动时每帧最多画 1–2 页，不会给 ±3 页一起重画。
 */
function observeIndexTiles() {
  const scroller = el("index-canvas");
  if (!scroller || typeof IntersectionObserver !== "function") return;
  const firstTile = indexTiles.values().next().value;
  const tileHeight = firstTile ? firstTile.getBoundingClientRect().height : 0;
  // "视口附近 ±3 页"按页高算（页高随缩放变），至少留半页防止页面太矮时错过
  const margin = tileHeight
    ? Math.max(600, Math.round(tileHeight * 3))
    : INDEX_NEAR_MARGIN;
  if (indexObserver && Math.abs(margin - indexObserverMargin) > 80) {
    indexObserver.disconnect();
    indexObserver = null;
  }
  if (!indexObserver) {
    indexObserverMargin = margin;
    indexObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const tile = entry.target;
          const pageNo = Number(tile.dataset.pageNo);
          if (entry.isIntersecting) {
            indexNearPages.add(pageNo);
            loadIndexTile(pageNo);
          } else if (indexNearPages.delete(pageNo)) {
            clearIndexTile(pageNo);
            // 已经离开几页之外的图不必再占解码内存
            if (Math.abs(pageNo - (indexCurrentPage || 1)) > 6) releaseIndexImage(pageNo);
          }
        }
        reportIndexMetrics();
      },
      { root: scroller, rootMargin: `${margin}px 0px`, threshold: 0 }
    );
  }
  if (!indexVisibleObserver) {
    indexVisibleObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const tile = entry.target;
          const pageNo = Number(tile.dataset.pageNo);
          if (entry.isIntersecting) {
            indexVisiblePages.add(pageNo);
            loadIndexTile(pageNo);
          } else if (indexVisiblePages.delete(pageNo)) {
            clearIndexDecorations(pageNo);
          }
        }
        reportIndexMetrics();
        updateIndexActiveFromScroll();
      },
      { root: scroller, rootMargin: "0px", threshold: 0 }
    );
  }
  for (const tile of indexTiles.values()) {
    indexObserver.observe(tile);
    indexVisibleObserver.observe(tile);
  }
}

function reportIndexMetrics() {
  const metrics = (window.__b2tIndexMetrics = window.__b2tIndexMetrics || {});
  metrics.nearPages = indexNearPages.size;
  metrics.visiblePages = indexVisiblePages.size;
  metrics.loadedImages = indexLoadedImages.size;
  metrics.blocksCached = indexBlocksByPage.size;
}

/** PageTile 的依赖（与 preview 同一组；init 可重复调用，模块会合并）。 */
function indexTileApi() {
  const api = window.PageTile;
  if (!api) return null;
  api.init({
    getProject: () => injected.getProject(),
    getImageUrl: (pageNo, size) => injected.pageImageUrl(pageNo, size),
    notify: (info) => {
      const text = info && (info.text || info.message) ? info.text || info.message : String(info);
      injected.showNoticeBar?.(text);
    },
  });
  return api;
}

/** PageTile status → 目录页块的显示态 + 原指标（imageMs / imageCount 口径不变）。 */
function applyIndexTileStatus(handle, info) {
  if (!handle || !handle.img) return;
  const pageNo = handle.pageNo;
  const image = handle.img;
  image.classList.toggle("is-ready", info.status === "ready");
  if (info.status === "ready") {
    delete image.dataset.imageFailed;
    indexLoadedImages.add(pageNo);
    const metrics = (window.__b2tIndexMetrics = window.__b2tIndexMetrics || {});
    const started = indexTileStartedAt.get(pageNo);
    if (started) {
      indexTileStartedAt.delete(pageNo);
      (metrics.imageMs = metrics.imageMs || []).push(Math.round(performance.now() - started));
      if (metrics.imageMs.length > 20) metrics.imageMs.shift();
      metrics.imageCount = (metrics.imageCount || 0) + 1;
    }
    reportIndexMetrics();
    if (pageNo === indexCurrentPage) setIndexImageStatus("");
    trimIndexImages();
  } else if (info.status === "missing") {
    const attempts = (indexImageAttempts.get(pageNo) || 0) + 1;
    indexImageAttempts.set(pageNo, attempts);
    if (attempts >= 2) markIndexImageFailed(pageNo);
  }
}

/** 每次起取图的时刻（PageTile 内部取图，仍按老口径记 imageMs）。 */
const indexTileStartedAt = new Map();

function ensureIndexImage(pageNo) {
  const tile = indexTiles.get(pageNo);
  if (!tile) return;
  const api = indexTileApi();
  if (api) {
    const size = injected.pageProfileFor(tile, pageNo);
    const exists = tile.__indexTile;
    if (exists && !exists.dead) {
      // 另一个视图也持有同一页时，PageTile 会把同一张图移到后挂的宿主；
      // 本视图再进来先交还句柄、重建，把图移回自己的页块。
      if (exists.img && exists.img.parentNode !== exists.el) {
        api.release(exists);
        delete tile.__indexTile;
      } else {
        if (exists.size !== size) api.update(exists, { size });
        return;
      }
    }
    // 一个页块只能有一张图：旧路径的占位 <img> 先摘掉
    const legacy = tile.querySelector("img");
    if (legacy) legacy.remove();
    let handle = null;
    handle = api.create(tile, {
      pageNo,
      size,
      onReady: (info) => applyIndexTileStatus(handle, info),
    });
    if (!handle) return;   // fail closed：缺依赖时不出瓷砖，也不出第二张图
    tile.__indexTile = handle;
    indexTileStartedAt.set(pageNo, performance.now());
    if (pageNo === indexCurrentPage) setIndexImageStatus(`正在渲染第 ${pageNo} 页…`);
    applyIndexTileStatus(handle, { status: handle.status });
    // 目录的近页（±3）本来就要图：不等观察器，直接作废触发一次取图。
    if (handle.status !== "ready") api.invalidate(pageNo, "image");
    return;
  }
  const image = tile.querySelector("img");
  if (!image || image.dataset.src || image.dataset.pending) return;
  // 任务 80：**先摘掉上一轮残留的 onload/onerror**，再挂占位图。
  // 否则占位图自己加载完会触发上一个闭包，把 thumb 标成 `is-ready` 并且不再排队取高清图。
  image.onload = null;
  image.onerror = null;
  // 先挂低分辨率占位（几十毫秒），高精度图在后面排队
  showIndexPlaceholder(pageNo, image);
  image.dataset.pending = "1";
  indexImageQueue.push(pageNo);
  pumpIndexImages();
}

/**
 * 一次只拉 / 解一张页图，按离当前页由近到远。
 * 实测：一次跳 300 页时同时给 7 页挂 src，会出现约 0.9 秒的长帧（7 张 150DPI 图一起解码）；
 * 排队后第一张（当前页）先出来，其余在后面的帧里补上。
 */
async function pumpIndexImages() {
  if (indexImagePumping) return;
  indexImagePumping = true;
  try {
    while (indexImageQueue.length) {
      const keepPage = indexCurrentPage || 1;
      indexImageQueue.sort(
        (a, b) => Math.abs(a - keepPage) - Math.abs(b - keepPage)
      );
      const pageNo = indexImageQueue.shift();
      const tile = indexTiles.get(pageNo);
      const image = tile && tile.querySelector("img");
      if (!image) continue;
      const url = injected.pageImageUrl(pageNo, injected.pageProfileFor(tile, pageNo));
      image.dataset.src = url;
      image.loading = "eager";
      const started = performance.now();
      if (pageNo === indexCurrentPage) setIndexImageStatus(`正在渲染第 ${pageNo} 页…`);
      const ok = await waitForImageLoad(image, url);
      delete image.dataset.pending;
      if (image.dataset.cancelled === "1") {
        // 加载途中滚走了：这次结果直接丢掉，图也收回（不留解码内存）
        delete image.dataset.cancelled;
        image.removeAttribute("src");
        delete image.dataset.src;
        image.classList.remove("is-ready");
        indexLoadedImages.delete(pageNo);
        continue;
      }
      if (!ok) {
        image.removeAttribute("src");
        delete image.dataset.src;
        const attempts = (indexImageAttempts.get(pageNo) || 0) + 1;
        indexImageAttempts.set(pageNo, attempts);
        if (attempts < 2 && injected.isActive()) {
          // 自动重试一次：不挡后面的页，600 ms 后自己回队列
          setTimeout(() => {
            if (injected.isActive() && indexTiles.has(pageNo)) ensureIndexImage(pageNo);
          }, 600);
        } else {
          markIndexImageFailed(pageNo);
        }
        continue;
      }
      image.classList.remove("is-ready");
      delete image.dataset.imageFailed;
      injected.clearImagePlaceholder(image);
      image.classList.add("is-ready");
      // 先解码再交给排版：解码不进滚动 / 跳页的那一帧
      try {
        await image.decode();
      } catch {
        /* decode() 失败不影响显示 */
      }
      indexLoadedImages.add(pageNo);
      const metrics = (window.__b2tIndexMetrics = window.__b2tIndexMetrics || {});
      (metrics.imageMs = metrics.imageMs || []).push(Math.round(performance.now() - started));
      if (metrics.imageMs.length > 20) metrics.imageMs.shift();
      metrics.imageCount = (metrics.imageCount || 0) + 1;
      reportIndexMetrics();
      if (pageNo === indexCurrentPage) setIndexImageStatus("");
      trimIndexImages();
      await new Promise((resolve) => setTimeout(resolve, 24));
    }
  } finally {
    indexImagePumping = false;
  }
}

function releaseIndexImage(pageNo) {
  const queued = indexImageQueue.indexOf(pageNo);
  if (queued >= 0) indexImageQueue.splice(queued, 1);
  const tile = indexTiles.get(pageNo);
  if (!tile) return;
  const handle = tile.__indexTile;
  if (handle && window.PageTile) {
    window.PageTile.release(handle);
    delete tile.__indexTile;
    indexLoadedImages.delete(pageNo);
    indexTileStartedAt.delete(pageNo);
    return;
  }
  const image = tile.querySelector("img");
  if (!image || !image.dataset.src) return;
  if (image.dataset.pending === "1") {
    // **还在加载**：现在摘 src 会让 onload/onerror 都不触发，泵就永远卡住（见 waitForImageLoad）。
    // 只做标记，等这次加载自己结束，由泵负责清理。
    image.dataset.cancelled = "1";
    return;
  }
  image.removeAttribute("src");
  delete image.dataset.src;
  image.classList.remove("is-ready");
  indexLoadedImages.delete(pageNo);
}

/**
 * 给一张页图挂 src，等它结束。**一定会 settle**：超时也算失败。
 *
 * 2026-10-28 用户看到"目录确认只有块框、页图全无"的根因就在这里：
 * 原来用 `new Promise(resolve => { image.onload=…; image.onerror=…; })`，而
 * `releaseIndexImage()`（滚远 / 跳页时调用）会把还在加载的图的 `src` 摘掉——
 * 摘掉 src 既不会触发 onload 也不会触发 onerror，那个 Promise **永远不 resolve**，
 * `pumpIndexImages()` 的 while 循环就卡死，`indexImagePumping` 一直是 true，
 * 于是这一次会话里**后面每一页都再也不会去拿图**（只有一片灰）。
 * 现在：加载中被释放只做标记，等它自己结束再清理；等待本身带超时，绝不悬空。
 */
function waitForImageLoad(image, url, timeoutMs = INDEX_IMAGE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
  });
}

/** 页图状态条：说清在等哪一页，而不是让用户对着一片灰猜。 */
function setIndexImageStatus(text) {
  const status = el("index-image-status");
  if (!status) return;
  if (!text) {
    status.hidden = true;
    status.textContent = "";
    return;
  }
  status.hidden = false;
  status.textContent = text;
}

/** 一页的图重试两次仍然失败：页块里放一个可点的重试，别留空白。 */
function markIndexImageFailed(pageNo) {
  const tile = indexTiles.get(pageNo);
  if (!tile) return;
  const image = tile.querySelector("img");
  if (image) {
    image.removeAttribute("src");
    delete image.dataset.src;
    image.classList.remove("is-ready");
    injected.clearImagePlaceholder(image);
  }
  delete indexTiles.get(pageNo)?.dataset.imageFailed;
  tile.dataset.imageFailed = "1";
  if (tile.querySelector(".index-image-retry")) return;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "index-image-retry";
  retry.textContent = "这一页的图像读不出来 · 点这里重试";
  retry.addEventListener("click", () => {
    retry.remove();
    delete tile.dataset.imageFailed;
    indexImageAttempts.delete(pageNo);
    ensureIndexImage(pageNo);
  });
  tile.append(retry);
  if (pageNo === indexCurrentPage) {
    setIndexImageStatus(`第 ${pageNo} 页的图像读不出来（渲染超时或失败）`);
  }
}

/**
 * 图是解码过的大图：内存里只留**当前页 ±10 页、最多 20 张**，更远的摘掉。
 *
 * 2026-10-28 拍板：不做磁盘缓存（一页 150 DPI 的 PNG 约 1.7 MB，490 页约 830 MB，
 * 只为省下 0.14–0.30 s/页，不划算）。内存窗口够覆盖审校时来回翻几页，
 * 窗口外的再要就从接口重取（HTTP 那边还有 5 分钟缓存）。
 */
function trimIndexImages(keepPage = indexCurrentPage || 1) {
  const ordered = [...indexLoadedImages].sort(
    (a, b) => Math.abs(b - keepPage) - Math.abs(a - keepPage)
  );
  while (
    (indexLoadedImages.size > INDEX_IMAGE_LIMIT ||
      (ordered.length && Math.abs(ordered[0] - keepPage) > injected.imageWindow)) &&
    ordered.length
  ) {
    const pageNo = ordered.shift();
    if (Math.abs(pageNo - keepPage) <= injected.imageWindow && indexLoadedImages.size <= INDEX_IMAGE_LIMIT) {
      continue;
    }
    releaseIndexImage(pageNo);
  }
}

/**
 * 低分辨率占位图（任务 62）：`size=thumb` 是 40 DPI，几十毫秒就能回来。
 * 用户点进来先看到"这一页大概是这个样子"，高精度图到了再替换——
 * 首图可见时间从实测 6.4 s 降到 1 s 以内。
 */
function showIndexPlaceholder(pageNo, image) {
  if (!image || image.dataset.placeholder === "1") return;
  if (image.classList.contains("is-ready") || image.dataset.src) return;
  image.dataset.placeholder = "1";
  image.classList.add("is-placeholder");
  image.src = injected.pageImageUrl(pageNo, "thumb");
}


function ensureIndexBlocks(pageNo) {
  if (indexBlocksByPage.has(pageNo)) {
    return Promise.resolve(indexBlocksByPage.get(pageNo));
  }
  const pending = indexBlocksPending.get(pageNo);
  if (pending) return pending;
  const promise = injected.loadIndexBlocks(pageNo)
    .then((blocks) => {
      indexBlocksByPage.set(pageNo, blocks || []);
      return blocks || [];
    })
    .finally(() => indexBlocksPending.delete(pageNo));
  indexBlocksPending.set(pageNo, promise);
  return promise;
}

/** 一页进入"附近"：先挂图、拿块；**只有它在视口里才画**。 */
async function loadIndexTile(pageNo) {
  const tile = indexTiles.get(pageNo);
  const page = indexPageRecord(pageNo);
  if (!tile || !page) return;
  ensureIndexImage(pageNo);
  if (indexVisiblePages.has(pageNo)) paintIndexTile(pageNo);
  if (indexBlocksByPage.has(pageNo)) {
    if (indexVisiblePages.has(pageNo)) paintIndexTile(pageNo);
    return;
  }
  const started = performance.now();
  const blocks = await ensureIndexBlocks(pageNo);
  if (!indexTiles.has(pageNo) || !injected.isActive()) return;
  window.__b2tIndexBlocksMs = Math.round(performance.now() - started);
  reportIndexMetrics();
  if (indexVisiblePages.has(pageNo)) paintIndexTile(pageNo);
}

/** 只清装饰（滚动离开视口时用），块缓存留着，滚回来不用重拉。 */
function clearIndexDecorations(pageNo) {
  const tile = indexTiles.get(pageNo);
  if (!tile) return;
  injected.clearPageBlocks(tile);
  injected.clearTileMargin(tile);
  const first = tile.querySelector(".index-firstline");
  if (first) first.hidden = true;
}

/** 一页离开"附近"：装饰清掉，块缓存也丢（图按上限 / 距离释放）。 */
function clearIndexTile(pageNo) {
  clearIndexDecorations(pageNo);
  indexBlocksByPage.delete(pageNo);
  reportIndexMetrics();
}

/** 版心 + 块框 + 首行标记：和页面视图调用同一套渲染函数。 */
function paintIndexTile(pageNo) {
  const tile = indexTiles.get(pageNo);
  const page = indexPageRecord(pageNo);
  if (!tile || !page) return;
  injected.paintTileMargin(tile, page);
  const blocks = indexBlocksByPage.get(pageNo) || [];
  const overlay = tile.querySelector(".page-overlay");
  if (injected.getPagesOverlayOn() && blocks.length) {
    if (!overlay || overlay._renderedBlocks !== blocks) {
      injected.renderPageBlocks(tile, blocks, { details: true });
    }
  } else {
    injected.clearPageBlocks(tile);
  }
  drawIndexFirstLine(tile, blocks, page);
}

/** 这一页的首行：淡蓝框，用来核对"这个印刷页码是不是这一页"（版心内第一行）。 */
function drawIndexFirstLine(tile, blocks, page) {
  const node = tile ? tile.querySelector(".index-firstline") : null;
  if (!node) return;
  let first = null;
  for (const block of blocks) {
    if (!block.include) continue;
    if (!injected.blockCountedInMargin(block, page)) continue;
    const line = (block.lines || []).find((item) => item && item.bbox);
    if (line) {
      first = line;
      break;
    }
  }
  if (!first) {
    node.hidden = true;
    return;
  }
  const [x0, y0, x1, y1] = first.bbox;
  node.style.left = `${x0 * 100}%`;
  node.style.top = `${y0 * 100}%`;
  node.style.width = `${(x1 - x0) * 100}%`;
  node.style.height = `${(y1 - y0) * 100}%`;
  node.hidden = false;
}

/** 开关变化时重画视口里的页（其他页保持干净）。 */
function paintIndexDecorations() {
  if (!injected.getProject() || !injected.isActive() || !indexTiles.size) return;
  for (const [pageNo] of indexTiles) {
    if (indexVisiblePages.has(pageNo)) paintIndexTile(pageNo);
    else clearIndexDecorations(pageNo);
  }
  syncIndexToggles();
}

/** 量页列的滚动内容偏移（缩放 / 窗口变化后要重量）。 */
function measureIndexTiles() {
  const scroller = el("index-canvas");
  if (!scroller) return;
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  indexTops = [];
  indexTopMap = new Map();
  for (const [pageNo, tile] of indexTiles) {
    const rect = tile.getBoundingClientRect();
    const entry = { pageNo, top: rect.top - base, height: rect.height };
    indexTops.push(entry);
    indexTopMap.set(pageNo, entry);
  }
  indexTops.sort((a, b) => a.pageNo - b.pageNo);
  window.__b2tIndexTops = indexTops;
  // 页高变了：±3 页的观察范围跟着重算
  observeIndexTiles();
}

/** 当前在视口里的页：取"视口上方 30%"落在一页里的那一页。 */
function indexPageAtScroll() {
  const scroller = el("index-canvas");
  if (!scroller || !indexTops.length) return indexCurrentPage || 1;
  const anchor = scroller.scrollTop + scroller.clientHeight * 0.3;
  let lo = 0;
  let hi = indexTops.length - 1;
  let best = indexTops[0].pageNo;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = indexTops[mid];
    if (entry.top <= anchor) {
      best = entry.pageNo;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function updateIndexActiveFromScroll() {
  const pageNo = indexPageAtScroll();
  if (!pageNo || pageNo === indexCurrentPage) return;
  indexCurrentPage = pageNo;
  updateIndexPageHeader(pageNo);
  highlightIndexRow(true);
}

/** 右边滚动 → 左边列表反向同步（一帧一次）。 */
function onIndexScroll() {
  if (indexScrollRaf) return;
  indexScrollRaf = requestAnimationFrame(() => {
    indexScrollRaf = 0;
    if (!injected.isActive() || !indexTiles.size) return;
    updateIndexActiveFromScroll();
  });
}

function scrollIndexToPage(pageNo) {
  const scroller = el("index-canvas");
  const entry = indexTopMap.get(pageNo);
  if (!scroller || !entry) return;
  const target = Math.max(0, entry.top - 8);
  if (Math.abs(scroller.scrollTop - target) < 2) return;
  scroller.scrollTop = target;
}

/** 页头那一行：印刷页 / 前置后置 / 目录页 / 回目页 / 真没识别出来，五种说法分开。 */
function indexPrintedLabel(entry) {
  if (!entry) return "";
  if (!entry.missing) return `印刷页 ${entry.printed[0] || ""}`;
  if (entry.missing_reason === "front_back") return "前置/后置页 · 不印页码";
  if (entry.missing_reason === "toc") return "目录页 · 不印页码";
  if (entry.missing_reason === "chapter") {
    return `回目页 · 不印页码${entry.chapter ? "（" + entry.chapter + "）" : ""}`;
  }
  return "未识别页码（照样可以审校 / 导出）";
}

function updateIndexPageHeader(pageNo) {
  const pageOrderOnly = Boolean(injected.getPageIndexData()) && indexIsPageOrderOnly();
  el("index-page-no").textContent = pageOrderOnly
    ? `PDF 第 ${pageNo} 页`
    : `第 ${pageNo} 页`;
  const entry =
    injected.getPageIndexData() && injected.getPageIndexData().pages.find((item) => item.page_no === pageNo);
  // 页头只写实际检测到的印刷页；"同一叶另一面"的跳转便利只放在列表行的 title 里。
  el("index-printed").textContent = pageOrderOnly
    ? "无印刷页码（只有 PDF 页序）"
    : indexPrintedLabel(entry);
  const pages = injected.getPageIndexData() ? injected.getPageIndexData().pages : [];
  const index = pages.findIndex((item) => item.page_no === pageNo);
  el("index-prev").disabled = index <= 0;
  el("index-next").disabled = index < 0 || index >= pages.length - 1;
}

/** 打开一页 = 滚到那一页（点列表 / 输入印刷页 / 上一下一页都走这里）。 */
function openIndexPage(pageNo, { scrollList = true } = {}) {
  if (!injected.getProject()) return;
  const page = indexPageRecord(pageNo);
  if (!page) return;
  indexCurrentPage = pageNo;
  // 页序模式的"没有印刷页码"说明是**常驻**的，翻页不该把它清掉
  if (!indexIsPageOrderOnly()) setIndexJumpStatus("");
  ensureIndexPages();
  if (!indexTopMap.size) measureIndexTiles();
  updateIndexPageHeader(pageNo);
  const image = indexTiles.get(pageNo)?.querySelector("img");
  if (image && image.classList.contains("is-ready")) {
    setIndexImageStatus("");
  } else if (indexTiles.get(pageNo)?.dataset.imageFailed === "1") {
    setIndexImageStatus(`第 ${pageNo} 页的图像读不出来（渲染超时或失败）`);
  } else {
    setIndexImageStatus(`正在渲染第 ${pageNo} 页…（第一次打开需要几秒）`);
  }
  scrollIndexToPage(pageNo);
  loadIndexTile(pageNo);
  highlightIndexRow(scrollList);
  syncIndexToggles();
}

function highlightIndexRow(scroll) {
  const list = el("index-list");
  for (const node of list.querySelectorAll(".is-current")) {
    node.classList.remove("is-current");
  }
  if (indexCurrentPage === null) return;
  // 回目头（.index-chapter）和页行共用 data-page-no：高亮只认页行
  const row = list.querySelector(
    `li.index-row[data-page-no="${indexCurrentPage}"]`
  );
  if (!row) return;
  row.classList.add("is-current");
  if (scroll) ensureIndexRowVisible(row);
}

/** 右边滚出来的当前页：列表行没完整露出来就把它滚到列表中间（反向同步）。 */
function ensureIndexRowVisible(row) {
  const list = el("index-list");
  if (!list || !row) return;
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  if (rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom) return;
  list.scrollTop +=
    rowRect.top - listRect.top - (listRect.height - rowRect.height) / 2;
}

function stepIndexPage(delta) {
  const total = injected.getProject() ? injected.getProject().pages.length : 0;
  if (!total) return;
  const next = Math.min(total, Math.max(1, (indexCurrentPage || 1) + delta));
  if (next === indexCurrentPage) return;
  openIndexPage(next, { scrollList: true });
}

/** 缩放与页面视图共用 pageZoomIndex；这里改的是整个页列的宽度。 */
/**
 * 缩放 / 窗口变化后重新判断档位：需要更高的档就把这一页的图作废重取。
 * 只在"需要的档变了"时动手（85%→70% 这种不需要重取，省一次渲染）。
 */
/** 清晰度：auto / standard / high，按浏览器记住（不写项目数据库）。 */
const IMAGE_QUALITY_LABELS = { auto: "自动", standard: "标准", high: "高清" };


function refreshIndexImageProfiles() {
  const tiles = [...indexTiles.values()].filter((tile) => tile.querySelector("img"));
  if (!tiles.length) return;
  const sample = tiles[0];
  const pageNo = Number(sample.dataset.pageNo);
  const wanted = injected.pageProfileFor(sample, pageNo);
  if (!indexImageProfile) {
    indexImageProfile = wanted;
    return;
  }
  if (wanted === indexImageProfile) return;
  indexImageProfile = wanted;
  indexLoadedImages.clear();
  for (const tile of tiles) {
    const image = tile.querySelector("img");
    delete image.dataset.src;
    delete image.dataset.pending;
    delete image.dataset.profile;
    image.removeAttribute("src");
    tile.querySelectorAll(".index-page__placeholder").forEach((node) => node.remove());
  }
  for (const pageNo of indexImageQueue.splice(0)) {
    // 队列里挂的旧档也一起作废，下面按新档重新排队
  }
  for (const visible of indexVisiblePages) ensureIndexImage(visible);
  if (indexCurrentPage) ensureIndexImage(indexCurrentPage);
}

function applyIndexZoom() {
  if (!indexTiles.size) return;
  const scale = injected.zoomScales[injected.getPageZoomIndex()] || 1;
  const width = `${Math.round(scale * 100)}%`;
  for (const tile of indexTiles.values()) tile.style.width = width;
  // 任务 72：缩放变了，**需要的像素数就变了**，档位必须跟着重算。
  // 原来只在建块时取一次图，85% 拉来的 `view` 图会被拉伸到 100% 的容器里 → 糊。
  refreshIndexImageProfiles();
  const label = el("index-zoom-label");
  if (label) {
    label.textContent = injected.getPageZoomIndex() >= injected.zoomScales.length - 1
      ? "适合宽度"
      : `${Math.round(scale * 100)}%`;
  }
  el("index-zoom-out").disabled = injected.getPageZoomIndex() <= 0;
  el("index-zoom-in").disabled = injected.getPageZoomIndex() >= injected.zoomScales.length - 1;
}

function changeIndexZoom(delta) {
  const next = Math.min(
    injected.zoomScales.length - 1,
    Math.max(0, injected.getPageZoomIndex() + delta)
  );
  if (next === injected.getPageZoomIndex()) return;
  injected.setPageZoomTouched(true);
  injected.setPageZoomIndex(next);
  applyIndexZoom();
  measureIndexTiles();
  paintIndexDecorations();
  // 页高变了：把当前页重新对到视口上方，别让它被缩放挤走
  scrollIndexToPage(indexCurrentPage || 1);
}


function syncIndexToggles() {
  const overlay = el("index-overlay-toggle");
  if (overlay) overlay.classList.toggle("is-on", injected.getPagesOverlayOn());
  const margin = el("index-margin-toggle");
  if (margin) margin.classList.toggle("is-on", injected.getPagesMarginOn());
}

function toggleIndexOverlay() {
  injected.togglePageBlocksOverlay();
  paintIndexDecorations();
}

function toggleIndexMargin() {
  injected.toggleMarginView();
  paintIndexDecorations();
}

function setIndexJumpStatus(text, isError = false, holdMs = 9000) {
  const node = el("index-jump-status");
  if (!node) return;
  node.textContent = text || "";
  node.hidden = !text;
  node.style.color = isError ? "var(--bad-fg)" : "";
  if (indexJumpTimer) clearTimeout(indexJumpTimer);
  if (text && holdMs > 0) indexJumpTimer = setTimeout(() => { node.hidden = true; }, holdMs);
}

/**
 * 页序模式下"按印刷页码跳转"必须停用：没有印刷页码，输入框就是骗人的。
 * 有页码时恢复，并把提示收起来。
 */
function syncIndexJumpState() {
  const input = el("index-jump-input");
  const go = el("index-jump-go");
  if (!input || !go) return;
  const pageOrderOnly = Boolean(injected.getPageIndexData()) && indexIsPageOrderOnly();
  input.disabled = pageOrderOnly;
  go.disabled = pageOrderOnly;
  input.placeholder = pageOrderOnly ? "还没有印刷页码" : "如 80";
  if (pageOrderOnly) {
    setIndexJumpStatus(
      "还没有印刷页码，不能按印刷页码跳；左边按 PDF 页序排列。",
      false,
      0
    );
  } else {
    setIndexJumpStatus("");
  }
}

/** 按印刷页码跳转：精确命中就跳；没有就跳到最接近的印刷页并如实说明。 */
function jumpToPrintedPage() {
  if (!injected.getPageIndexData() || !injected.getPageIndexData().pages.length) {
    setIndexJumpStatus("页码索引还没准备好。", true);
    return;
  }
  if (indexIsPageOrderOnly()) {
    setIndexJumpStatus("这本书还没有印刷页码，只能按 PDF 页序翻。", true);
    return;
  }
  const raw = el("index-jump-input").value || "";
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) {
    setIndexJumpStatus("请输入印刷页码，例如 80。", true);
    return;
  }
  const wanted = Number(digits);
  // 命中实际印刷页，或（编号隔 2 的书）同一叶的另一面；标签里不写后者。
  const exact = injected.getPageIndexData().pages.find((entry) =>
    (entry.jump || entry.printed).some((value) => Number(value) === wanted)
  );
  if (exact) {
    openIndexPage(exact.page_no, { scrollList: true });
    setIndexJumpStatus(
      `已跳到印刷页 ${wanted}（PDF ${exact.page_no}）。`
    );
    return;
  }
  let best = null;
  for (const entry of injected.getPageIndexData().pages) {
    for (const value of entry.jump || entry.printed) {
      const distance = Math.abs(Number(value) - wanted);
      if (!best || distance < best.distance) {
        best = { distance, pageNo: entry.page_no, value: Number(value) };
      }
    }
  }
  if (!best) {
    setIndexJumpStatus("这本书还没有可用的印刷页码。", true);
    return;
  }
  openIndexPage(best.pageNo, { scrollList: true });
  setIndexJumpStatus(
    `索引里没有印刷页 ${wanted}；已跳到最接近的 ${best.value}（PDF ${best.pageNo}）。`,
    true
  );
}

function setupPageIndex() {
  el("index-prev").addEventListener("click", () => stepIndexPage(-1));
  el("index-next").addEventListener("click", () => stepIndexPage(1));
  el("index-notice-go").addEventListener("click", () => injected.goToWorkflowStep("recognition"));
  el("index-zoom-out").addEventListener("click", () => changeIndexZoom(-1));
  el("index-zoom-in").addEventListener("click", () => changeIndexZoom(1));
  // 任务 72：清晰度出口。自动判定永远有人不满意，手动钉住比反复调阈值划算。
  el("index-quality")?.addEventListener("click", () => {
    const order = ["auto", "standard", "high"];
    applyImageQuality(order[(order.indexOf(injected.getImageQualityMode()) + 1) % order.length]);
  });
  for (const radio of document.querySelectorAll('input[name="reading-quality"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) applyImageQuality(radio.value);
    });
  }
  el("index-overlay-toggle").addEventListener("click", toggleIndexOverlay);
  el("index-margin-toggle").addEventListener("click", toggleIndexMargin);
  el("index-jump-go").addEventListener("click", jumpToPrintedPage);
  el("index-jump-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpToPrintedPage();
    }
  });
  el("index-canvas").addEventListener("scroll", onIndexScroll, { passive: true });
  el("index-list").addEventListener("click", (event) => {
    const row = event.target.closest("li[data-page-no]");
    if (!row) return;
    openIndexPage(Number(row.dataset.pageNo), { scrollList: true });
  });
  el("index-list").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("li[data-page-no]");
    if (!row) return;
    event.preventDefault();
    openIndexPage(Number(row.dataset.pageNo), { scrollList: true });
  });
  window.addEventListener("resize", () => {
    if (!injected.isActive() || indexResizeRaf) return;
    indexResizeRaf = requestAnimationFrame(() => {
      indexResizeRaf = 0;
      if (!injected.isActive() || !indexTiles.size) return;
      applyIndexZoom();
      measureIndexTiles();
      paintIndexDecorations();
      scrollIndexToPage(indexCurrentPage || 1);
    });
  });
}

  // ---------------------------------------------------------------- 对外接口

  /** 清晰度按钮的文字（原 `syncImageQualityUi` 里写 `#index-quality` 的那两行）。**纯文字**。 */
  function syncImageQualityButton() {
    const label = IMAGE_QUALITY_LABELS[injected.getImageQualityMode()] || "自动";
    const button = el("index-quality");
    if (button) button.textContent = `清晰度：${label}`;
  }

  /**
   * 用户改了清晰度档（原 `setImageQuality` 的前半段在 app.js，后半段在这里）。
   *
   * **这条路径不归 `refresh()`**：Chief 把 `refresh()` 的语义写死成"只重画装饰与开关态，
   * 不做数据加载"，而换档要作废已取页图并按新档重取（那是取图）。所以它挂在"用户改了档"
   * 这两个入口上（`#index-quality` 按钮 / 设置面板 radio），两者都在本模块里。
   * 也没有 `refresh({ quality: true })` 那种参数包（§20.6 已否决）。
   */
  function applyImageQuality(mode) {
    injected.setImageQuality(mode);
    syncImageQualityButton();
    // **只在本视图可见时**探查档位：`pageProfileFor` 要量瓷砖的 CSS 宽，隐藏时量到的是估算值
    // （`measureCssWidth` 的最后一条兜底），会算出一个假档位、白作废一遍图。
    // 隐藏期间改了档也没关系：进视图时 `openPageIndex → applyIndexZoom → refreshIndexImageProfiles`
    // 会按当时的真档位重算并作废。
    if (injected.isActive()) refreshIndexImageProfiles();
  }

  /** boot() 调一次：注入依赖 + 绑 #view-index 的事件（原 `setupPageIndex()` 原样搬入）。 */
  const init = (deps) => {
    injected = { ...injected, ...(deps || {}) };
    setupPageIndex();
  };

  /** 进入目录确认（原 `openPageIndex()`；有缓存用缓存，没有就生成一次）。 */
  const enter = () => openPageIndex();

  /**
   * **语义写死（Chief 批准 A 时的条件 ①）**：
   *   **只重画装饰与开关态。不做数据加载、不做全量重建、不读 `currentView`。**
   * 具体就三件，多一件都算超出契约：
   * - `syncIndexToggles()`：两个开关按钮按 `pagesMarginOn / pagesOverlayOn` 重摆 `is-on`
   *   （无条件，对应原 `togglePageBlocksOverlay` / `toggleMarginView` 里的显式调用）；
   * - `syncImageQualityButton()`：清晰度按钮的**文字**（纯文字，不取图）；
   * - `paintIndexDecorations()`：**自己守 active**（它开头就是
   *   `if (!project || !isActive() || !indexTiles.size) return;`），所以这里不写
   *   `active ? … : …` 的 ternary——守卫写一次就够，写两处迟早对不上。
   * **换清晰度档会取图，所以它不在 `refresh()` 里**，在 `applyImageQuality()`（见上）。
   */
  const refresh = () => {
    syncIndexToggles();
    syncImageQualityButton();
    paintIndexDecorations();
  };

  // 任务 94（2026-10-29 裁决）：**不导出 `exit`**。原来这里有一个"撤掉两帧 rAF"的 `exit`，
  // 但 `showView` 从不调用它（`.exit(` 全仓库 0 个调用点）——永不执行的导出会让棘轮松一格。
  // 实测重复 `enter()` 不重复绑监听、观察器 0 次重建（`observeIndexTiles` 认 `indexObserver` 非空就复用），
  // 所以今天不需要"离开时清理"这个口子。将来真要断观察器，再立一个有真实调用点的导出（§20.1）。
  window.IndexView = {
    init,
    enter,
    refresh,
  };
})();
