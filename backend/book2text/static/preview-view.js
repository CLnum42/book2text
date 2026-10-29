/**
 * 预览视图模块（任务 94 · Slice P2：整段迁入）
 *
 * **经典脚本，不是 ES module**：`<script src="/static/preview-view.js">` 在 app.js 之前加载，
 * 靠 `window.PreviewView` 对外暴露（R6：一个文件只露一个接口对象）。`type="module"` 默认
 * deferred，会改 boot 时序——这个仓库一半 bug 是时序问题，拆的时候不动它。
 *
 * 用户要求：预览就是**导出结果的实时副本**，不能另写一套段落合并逻辑。
 * 所以这里只调 `POST /export/preview`（与导出同一个组装器、同一份 options），
 * 把返回的 segments 直接铺开：段边界、跨页段、版心外排掉了多少，都在这一页上。
 *
 * 任务 47（J 刀）：左边从"单页裸图"换成**连续页条**。
 * - 每页直接复用页面视图 / 目录确认的 `paintTileMargin()` / `renderPageBlocks()`；
 *   版心 / 块框开关与缩放沿用 `pagesMarginOn` / `pagesOverlayOn` / `pageZoomIndex` 同一份状态。
 * - 悬停右栏一段 → 右栏这一段浅绿，左边这一段命中的块（跨页段是两页的块）标浅绿。
 *   浅绿用青绿（teal），和审校的淡红 / 淡绿 / 淡蓝三色区分开。
 * - 右栏滚动 → 左边跟到这一段所在的页（页不变就不换图）；左栏滚动 → 右栏定位到那页第一段。
 *   两边用 `previewSyncDriver` 防止互相驱动成环。
 * - 右栏 1139 段**不逐段挂监听**：悬停 / 点击都事件代理到 `#preview-segs`。
 *
 * **Slice P2（2026-10-29）**：43 个函数（37 个新搬 + P1 已搬的 6 个）+ 27 个状态整段从 app.js
 * 迁入。函数体**逐字节未改**，只把 app.js 的 28 个顶层符号 + 2 个页面视图 DOM 句柄换成
 * `injected.xxx`（状态 getter 8、setter 4、isActive 1、常量 2、服务 2、页面视图叶子函数 14、
 * 跨子树句柄 2）。app.js 只剩 4 处接缝：
 *   `showView` → `enter()`；
 *   `afterCleanupApplied` → 先 `enter({ invalidate: true })` 丢缓存、末尾 `enter({ force: true })`
 *   按新数据重开（分两步是为保住"await 期间读不到旧预览数据"的原有时间点）；
 *   `afterContinuationChange` → `enter({ invalidate: true })`（**只丢缓存、不重开**——
 *   原代码这里就没有重开，改成 force 会多一次网络 + 渲染）；
 *   `boot` → `init(deps)`。
 * `setupPageMore`（工具条「⋯」）不属于本视图，原地留在 app.js。
 *
 * **依赖一律走 `init(deps)` 注入，注入句柄不注入值**（§13 / §20.4）：
 * - 状态只给 getter；有写点的 4 个页面视图共享状态另给 setter
 *   （`pageZoomIndex / pageZoomTouched / pagesMarginOn / pagesOverlayOn`——它们是三步共用的，
 *   不能搬进本模块）；
 * - 仍留在 app.js 的页面视图函数给回调；`el` 不进 deps，模块自带一行（§20.4）；
 * - 页面视图的 DOM（`pages-margin-toggle` / `pages-overlay-toggle`）给句柄 getter，
 *   模块不碰 `#view-pages` 的 id（R3）。
 *
 * **两个调试埋点随代码进来**：`__b2tPreviewTileTops`（measurePreviewTiles）与
 * `__b2tPreviewMetrics`（recordPreviewMetric）是 QA 口径，不是模块接口；按 R6
 * "出现即登记"要登记进 `WINDOW_HOOK_EXCEPTIONS`（已报 TestDev，MAX 7→9）。
 *
 * **接口 2 个**（§20.1）：`init(deps) / enter(params)`。
 * `getCurrent` 按需——preview 没有调用方，不加（加了就是为将来预留）。

 * **本模块不提供 `exit()`（2026-10-29 裁决，别补回来）**：`enter()` 幂等——监听只绑新元素、
 * 观察器非空即复用（`reading` 是建 1 断 1，稳定不增）。三个模块当初都导出了 `exit`，
 * 而 `showView` 从不调用它，是**永不执行的导出**（`.exit(` 全仓库 0 命中）。
 * 实测（真浏览器，按「元素 × 事件类型」数活着的处理函数）：重复 `enter()` 不重复绑、不重建观察器。
 * **将来若要断观察器**（已知缺口：切走视图后隐藏元素仍会回调，见 `docs/known-limitations.md` L-108），
 * 那时再引入 `exit()`，并附等价性证据与真实调用点。写"为什么没有"是为了挡住下一个把它当缺失生命周期补回来的人。
 */
(function () {
  "use strict";

  /** 注入面：boot() 一次传齐；缺键时保持搬走前的语义（读不到就 no-op / 空值）。 */
  let injected = {};

  const el = (id) => document.getElementById(id);

let previewData = null;
let previewProject = null;
let previewOptions = null;
let previewOptionsSignature = null;
let previewLoading = false;
let previewPageNo = null;
let previewActiveSeq = null;
let previewOnlySpan = false;
let previewSegmentNodes = new Map();
let previewSegmentsBySeq = new Map();
let previewFirstSeqByPage = new Map();
/** 左边连续页条：page_no → 页块；`previewTileTops` 是滚动位置二分用的几何缓存。 */
let previewTiles = new Map();
let previewTileTops = [];
let previewTileTopMap = new Map();
let previewPagesProject = null;
let previewLoadedPages = new Set();
let previewTileBlocks = new Map();
const previewBlocksPending = new Map();
let previewActiveBlocks = [];
const previewHitTiles = new Set();
let previewHitToken = 0;
let previewRightRaf = 0;
let previewLeftRaf = 0;
let previewPendingHover = 0;
let previewSyncDriver = null;
let previewSyncUntil = 0;
let previewImageStartedAt = new Map();

/** 量一帧里的几何：页块的滚动内容偏移与高度（缩放 / 窗口变化后要重量）。 */
function measurePreviewTiles() {
  const scroller = el("preview-pdf-scroll");
  if (!scroller) return;
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  previewTileTops = [];
  previewTileTopMap = new Map();
  for (const [pageNo, tile] of previewTiles) {
    const rect = tile.getBoundingClientRect();
    const entry = { pageNo, top: rect.top - base, height: rect.height };
    previewTileTops.push(entry);
    previewTileTopMap.set(pageNo, entry);
  }
  previewTileTops.sort((a, b) => a.pageNo - b.pageNo);
  // 调试口径：和 `__b2tIndexBlocksMs` 一样，给浏览器实测用，不参与业务判断
  window.__b2tPreviewTileTops = previewTileTops;
  // 缩放 / 窗口变化会改页高：跨页分界线的位置要按新几何重新摆
  if (previewActiveSeq !== null) {
    const segment = previewSegmentsBySeq.get(previewActiveSeq);
    if (segment) showPreviewJunction(segment);
  }
}

function recordPreviewMetric(key, value) {
  const metrics = (window.__b2tPreviewMetrics = window.__b2tPreviewMetrics || {});
  const list = (metrics[key] = metrics[key] || []);
  list.push(value);
  if (list.length > 20) list.shift();
  // 累计次数（列表只留最近 20 条，次数要单调递增才能验"页不换就不重新加载"）
  metrics[`${key}Count`] = (metrics[`${key}Count`] || 0) + 1;
}

function previewPageRecord(pageNo) {
  if (!injected.getProject()) return null;
  return injected.getProject().pages.find((item) => item.page_no === pageNo) || null;
}

function markPreviewDriver(driver) {
  previewSyncDriver = driver;
  previewSyncUntil = performance.now() + 350;
}

function previewDriverActive(driver) {
  return previewSyncDriver === driver && performance.now() < previewSyncUntil;
}

// ---------------------------------------------------------------- 左：连续页条

/** 建全书页块（每页一个：图 + 版心 + 块框 + 段落命中层）。只在换项目 / 页数变了时重建。 */
function buildPreviewPages() {
  const wrap = el("preview-pages");
  if (!wrap || !injected.getProject()) return;
  // 跨页分界线是静态节点（id 有登记），重建页块时留着，别一起清掉
  const junction = wrap.querySelector(".preview-junction");
  // PageTile 的句柄挂在页块上；重建前先交还，别让注册表里留着指向旧 DOM 的记录。
  if (window.PageTile) {
    for (const tile of previewTiles.values()) {
      if (tile.__previewTile) window.PageTile.release(tile.__previewTile);
    }
  }
  wrap.innerHTML = "";
  previewTiles.clear();
  previewTileTops = [];
  previewTileTopMap = new Map();
  previewLoadedPages.clear();
  previewTileBlocks.clear();
  previewBlocksPending.clear();
  previewActiveBlocks = [];
  previewHitTiles.clear();
  const fragment = document.createDocumentFragment();
  for (const page of injected.getProject().pages) {
    const tile = document.createElement("div");
    tile.className = "preview-page";
    tile.dataset.pageNo = String(page.page_no);
    // 图没加载出来之前也占住真实比例，滚动条与二分定位才不会跳
    tile.style.aspectRatio = `${page.width_pt} / ${page.height_pt}`;

    const image = document.createElement("img");
    image.alt = `第 ${page.page_no} 页`;
    image.loading = "lazy";
    image.decoding = "async";

    const margin = document.createElement("div");
    margin.className = "page-margin";
    margin.hidden = true;
    const marginBox = document.createElement("div");
    marginBox.className = "page-margin__box";
    margin.append(marginBox);

    // 和页面视图 / 目录确认同一套块框（--readonly：只画，不给拖 / 选）
    const overlay = document.createElement("div");
    overlay.className = "page-overlay page-overlay--readonly";
    overlay.hidden = true;

    // 当前段落的块命中的浅绿层：在块框之上、不接鼠标
    const hits = document.createElement("div");
    hits.className = "preview-page__hits";
    hits.hidden = true;

    tile.append(image, margin, overlay, hits);
    previewTiles.set(page.page_no, tile);
    fragment.append(tile);
  }
  wrap.append(fragment);
  if (junction) {
    junction.hidden = true;
    wrap.append(junction);
  }
}

/** PageTile 的依赖：一次 init 可重复调用（模块会合并）。 */
function previewTileApi() {
  const api = window.PageTile;
  if (!api) return null;
  api.init({
    getProject: () => injected.getProject(),
    // 契约名是 getImageUrl(pageNo, size)；预览原来的 pageImageUrl(no, profile) 同义。
    getImageUrl: (pageNo, size) => injected.pageImageUrl(pageNo, size),
    notify: (info) => {
      const text = info && (info.text || info.message) ? info.text || info.message : String(info);
      injected.showNoticeBar?.(text);
    },
  });
  return api;
}

/** 把 PageTile 的 status 翻成预览要的显示态（`.is-ready` 由 CSS 决定显不显示）。 */
function applyPreviewTileStatus(handle, info) {
  if (!handle || !handle.img) return;
  const pageNo = handle.pageNo;
  const image = handle.img;
  image.classList.toggle("is-ready", info.status === "ready");
  if (info.status === "ready") {
    const started = previewImageStartedAt.get(pageNo);
    if (started) {
      previewImageStartedAt.delete(pageNo);
      recordPreviewMetric("imageMs", Math.round(performance.now() - started));
    }
    if (pageNo === previewPageNo) {
      const status = el("preview-image-status");
      if (status) status.hidden = true;
    }
  } else if (info.status === "missing" && pageNo === previewPageNo) {
    const status = el("preview-image-status");
    if (status) {
      status.hidden = false;
      status.textContent = `第 ${pageNo} 页的图像读不出来。`;
    }
  }
}

function ensurePreviewImage(pageNo) {
  const tile = previewTiles.get(pageNo);
  if (!tile) return;
  const api = previewTileApi();
  if (api) {
    const size = injected.pageProfileFor(tile, pageNo);
    const exists = tile.__previewTile;
    if (exists && !exists.dead) {
      // 另一个视图也持有同一页时，PageTile 会把同一张图移到后挂的宿主；
      // 本视图再进来先交还句柄、重建，把图移回自己的页块。
      if (exists.img && exists.img.parentNode !== exists.el) {
        api.release(exists);
        delete tile.__previewTile;
      } else {
      // 缩放会换档：升档由 PageTile 自己重取，降档沿用已缓存的更清晰那张。
        if (exists.size !== size) api.update(exists, { size });
        return;
      }
    }
    // 旧路径留下的占位 <img> 先摘掉：一个页块只能有一张图（酸测试数的就是它）。
    const legacy = tile.querySelector("img");
    if (legacy) legacy.remove();
    let handle = null;
    handle = api.create(tile, {
      pageNo,
      size,
      onReady: (info) => applyPreviewTileStatus(handle, info),
    });
    if (!handle) return;   // fail closed：缺依赖时不出瓷砖，也不出第二张图
    tile.__previewTile = handle;
    previewLoadedPages.add(pageNo);
    previewImageStartedAt.set(pageNo, performance.now());
    applyPreviewTileStatus(handle, { status: handle.status });
    // 预览的窗口页是「当前 ±1」必定要看到的：不等 IntersectionObserver（页块加载前高度为 0，
    // 观察器可能永远不触发，图就永远 pending）。直接作废触发一次取图，与接线前的 eager 语义一致。
    if (handle.status !== "ready") api.invalidate(pageNo, "image");
    return;
  }
  // 老路径（index.html 还没加载 page-tile.js 时的降级，行为与接线前一致）
  const image = tile.querySelector("img");
  if (!image || image.dataset.src) return;
  const url = injected.pageImageUrl(pageNo, injected.pageProfileFor(tile, pageNo));
  image.dataset.src = url;
  // 窗口内（当前页 ±1 / 当前段跨的页）要马上有图：lazy 会把视口外一屏的页压住，
  // 跨页段两页交界时就会先看到空白再等图。
  image.loading = "eager";
  previewLoadedPages.add(pageNo);
  previewImageStartedAt.set(pageNo, performance.now());
  image.onload = () => {
    image.classList.add("is-ready");
    const started = previewImageStartedAt.get(pageNo);
    if (started) {
      previewImageStartedAt.delete(pageNo);
      recordPreviewMetric("imageMs", Math.round(performance.now() - started));
    }
    if (pageNo === previewPageNo) {
      const status = el("preview-image-status");
      if (status) status.hidden = true;
    }
  };
  image.onerror = () => {
    if (pageNo === previewPageNo) {
      const status = el("preview-image-status");
      if (status) {
        status.hidden = false;
        status.textContent = `第 ${pageNo} 页的图像读不出来。`;
      }
    }
  };
  image.src = url;
}

/** 离得远的页把 src 摘掉，别把 394 张大图都留在解码内存里；浏览器缓存还在，回来很快。 */
function releasePreviewImages(anchor) {
  if (previewLoadedPages.size <= 6) return;
  const keep = new Set([anchor - 4, anchor - 3, anchor - 2, anchor - 1, anchor, anchor + 1, anchor + 2, anchor + 3, anchor + 4]);
  for (const pageNo of [...previewLoadedPages]) {
    if (keep.has(pageNo)) continue;
    const tile = previewTiles.get(pageNo);
    if (!tile) continue;
    const handle = tile.__previewTile;
    if (handle && window.PageTile) {
      window.PageTile.release(handle);
      delete tile.__previewTile;
      previewLoadedPages.delete(pageNo);
      continue;
    }
    const image = tile.querySelector("img");
    if (image) {
      image.removeAttribute("src");
      delete image.dataset.src;
      image.classList.remove("is-ready");
    }
    previewLoadedPages.delete(pageNo);
  }
}

/** 目录确认的块懒加载是纯取块（带缓存），预览直接复用同一份缓存。 */
function ensurePreviewBlocks(pageNo) {
  if (previewTileBlocks.has(pageNo)) {
    return Promise.resolve(previewTileBlocks.get(pageNo));
  }
  const pending = previewBlocksPending.get(pageNo);
  if (pending) return pending;
  const promise = injected.loadIndexBlocks(pageNo)
    .then((blocks) => {
      previewTileBlocks.set(pageNo, blocks || []);
      return blocks || [];
    })
    .finally(() => previewBlocksPending.delete(pageNo));
  previewBlocksPending.set(pageNo, promise);
  return promise;
}

/** 画一页的版心 + 块框（同一套渲染，不另写）。 */
function paintPreviewTile(pageNo, { repaint = false } = {}) {
  const tile = previewTiles.get(pageNo);
  const page = previewPageRecord(pageNo);
  if (!tile || !page) return;
  injected.paintTileMargin(tile, page);
  const overlay = tile.querySelector(".page-overlay");
  if (!overlay) return;
  if (!injected.getPagesOverlayOn()) {
    injected.clearPageBlocks(tile);
    return;
  }
  const blocks = previewTileBlocks.get(pageNo);
  if (!blocks || !blocks.length) return;
  if (!repaint && overlay._renderedBlocks === blocks) return;
  injected.renderPageBlocks(tile, blocks, { details: true });
}

/** 只给当前页 ±1 画图 / 块框；离屏的页立刻清干净，393 页不会一起渲染。 */
function syncPreviewWindow({ repaint = false } = {}) {
  if (!injected.getProject() || !injected.isActive() || !previewPageNo) return;
  if (!previewTiles.size) buildPreviewPages();
  const total = injected.getProject().pages.length;
  const want = new Set();
  for (const delta of [-1, 0, 1]) {
    const pageNo = previewPageNo + delta;
    if (pageNo >= 1 && pageNo <= total && previewTiles.has(pageNo)) want.add(pageNo);
  }
  // 当前段跨的页也要在窗口里：跨页段的块可能落在当前页之外的那一页
  const activeSegment = previewActiveSeq !== null
    ? previewSegmentsBySeq.get(previewActiveSeq)
    : null;
  for (const page of (activeSegment && activeSegment.pages) || []) {
    if (previewTiles.has(page.page_no)) want.add(page.page_no);
  }
  for (const [pageNo, tile] of previewTiles) {
    if (want.has(pageNo)) continue;
    injected.clearPageBlocks(tile);
    injected.clearTileMargin(tile);
  }
  for (const pageNo of want) {
    ensurePreviewImage(pageNo);
    paintPreviewTile(pageNo, { repaint });
    if (!previewTileBlocks.has(pageNo)) {
      ensurePreviewBlocks(pageNo).then(() => {
        if (!injected.isActive()) return;
        if (Math.abs(pageNo - (previewPageNo || 1)) > 1) return;
        paintPreviewTile(pageNo, { repaint: true });
        drawPreviewHits();
      });
    }
  }
  releasePreviewImages(previewPageNo);
  updatePreviewPageUI();
  drawPreviewHits();
}

function applyPreviewZoom() {
  if (!previewTiles.size) return;
  const scale = injected.zoomScales[injected.getPageZoomIndex()] || 1;
  const width = `${Math.round(scale * 100)}%`;
  for (const tile of previewTiles.values()) tile.style.width = width;
  const label = el("preview-zoom-label");
  if (label) {
    label.textContent = injected.getPageZoomIndex() >= injected.zoomScales.length - 1
      ? "适合宽度"
      : `${Math.round(scale * 100)}%`;
  }
  el("preview-zoom-out").disabled = injected.getPageZoomIndex() <= 0;
  el("preview-zoom-in").disabled = injected.getPageZoomIndex() >= injected.zoomScales.length - 1;
  syncPreviewToggles();
}

/** 缩放与页面视图 / 目录确认共用 `pageZoomIndex`；这里只改预览宽度，不动网格。 */
function changePreviewZoom(delta) {
  const next = Math.min(
    injected.zoomScales.length - 1,
    Math.max(0, injected.getPageZoomIndex() + delta)
  );
  if (next === injected.getPageZoomIndex()) return;
  injected.setPageZoomTouched(true);
  injected.setPageZoomIndex(next);
  applyPreviewZoom();
  measurePreviewTiles();
  syncPreviewWindow({ repaint: true });
  if (previewActiveSeq !== null) {
    const segment = previewSegmentsBySeq.get(previewActiveSeq);
    if (segment) scrollPreviewLeftToSegment(segment, previewActiveBlocks);
  }
}

function syncPreviewToggles() {
  const margin = el("preview-margin-toggle");
  if (margin) {
    margin.classList.toggle("is-on", injected.getPagesMarginOn());
    margin.setAttribute("aria-pressed", injected.getPagesMarginOn() ? "true" : "false");
  }
  const overlay = el("preview-overlay-toggle");
  if (overlay) {
    overlay.classList.toggle("is-on", injected.getPagesOverlayOn());
    overlay.setAttribute("aria-pressed", injected.getPagesOverlayOn() ? "true" : "false");
  }
}

function togglePreviewMargin() {
  injected.toggleMarginView();
  syncPreviewToggles();
  syncPreviewWindow({ repaint: true });
}

function togglePreviewOverlay() {
  injected.togglePageBlocksOverlay();
  syncPreviewToggles();
  syncPreviewWindow({ repaint: true });
}

// ---------------------------------------------------------------- 右：段落列表（与导出同一份 segments）

async function openPreview() {
  if (!injected.getProject()) return;
  // 结果预览默认开版心 + 块框：这一步就是拿来看"正文在版心里的哪一块"的。
  // 两个开关和页面视图 / 目录确认是同一份状态，在这里关掉，回去也是关的。
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
  injected.syncIndexToggles();
  // 审校的差异层样式是 body 级的（body.diff-mode）；离开审校不一定会清掉，
  // 预览的块框别被它压成细线。
  document.body.classList.remove("diff-mode");
  const options = injected.exportOptions();
  const signature = JSON.stringify(options);
  if (
    previewLoading ||
    (!previewData ||
      previewProject !== injected.getProject().project_id ||
      signature !== previewOptionsSignature)
  ) {
    await loadPreview(options, signature);
    return;
  }
  renderPreview();
  measurePreviewTiles();
  jumpPreviewToPage(previewTargetPage(), { scrollRight: true });
}

function previewTargetPage() {
  const total = injected.getProject() ? injected.getProject().pages.length : 0;
  const candidates = [previewPageNo, injected.getDetailPageNo(), 1];
  for (const value of candidates) {
    if (value && value >= 1 && value <= total) return value;
  }
  return 1;
}

async function loadPreview(options, signature) {
  if (!injected.getProject()) return;
  previewLoading = true;
  previewData = null;
  previewProject = null;
  el("preview-meta").textContent = "正在按导出设置组装正文…";
  el("preview-segs").innerHTML = "";
  el("preview-note").hidden = true;
  previewSegmentNodes.clear();
  previewSegmentsBySeq.clear();
  previewFirstSeqByPage.clear();
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getProject().project_id}/export/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      }
    );
    previewData = data;
    previewProject = injected.getProject().project_id;
    previewOptions = options;
    previewOptionsSignature = signature;
  } catch (error) {
    el("preview-meta").textContent = `预览失败：${error.message || "未知错误"}`;
    return;
  } finally {
    previewLoading = false;
  }
  renderPreview();
  measurePreviewTiles();
  jumpPreviewToPage(previewTargetPage(), { scrollRight: true });
}

/** 与 body.txt 同一套过滤：空段不出现；没开注释流时脚注不进正文。 */
function previewVisibleSegments() {
  if (!previewData) return [];
  const includeFootnotes = Boolean(previewOptions && previewOptions.include_footnotes);
  return (previewData.segments || []).filter((segment) => {
    if (!segment.text || !segment.text.trim()) return false;
    if (!includeFootnotes && segment.type === "footnote") return false;
    if (previewOnlySpan && (segment.pages || []).length < 2) return false;
    return true;
  });
}

function renderPreview() {
  if (!previewData) return;
  const segments = previewData.segments || [];
  const preflight = previewData.preflight || {};
  const marginBlocks = preflight.margin_blocks || {};
  const chars = segments.reduce((sum, segment) => sum + (segment.text || "").length, 0);
  const spans = segments.filter((segment) => (segment.pages || []).length > 1).length;
  const bits = [
    `组装 ${segments.length} 段`,
    `${chars} 字`,
    `跨页 ${spans} 段`,
  ];
  if (marginBlocks.excluded) bits.push(`版心外排除 ${marginBlocks.excluded} 块`);
  bits.push(preflight.margin_judgement ? "按版心判定" : "按块类型判定");
  const meta = el("preview-meta");
  meta.textContent = bits.join(" · ");
  const excludedByType = marginBlocks.excluded_by_type || {};
  const excludedText = Object.entries(excludedByType)
    .map(([type, count]) => `${injected.blockTypeLabels[type] || type} ${count}`)
    .join(" / ");
  meta.title =
    `与导出共用同一份 segments（${segments.length} 段）。` +
    (marginBlocks.excluded
      ? `版心外排除 ${marginBlocks.excluded} 块${excludedText ? `（${excludedText}）` : ""}。`
      : "") +
    (spans ? `跨页段 ${spans} 段，标「跨页续」。` : "当前没有跨页段。");

  if (previewPagesProject !== injected.getProject().project_id) {
    buildPreviewPages();
    previewPagesProject = injected.getProject().project_id;
  } else if (!previewTiles.size || previewTiles.size !== injected.getProject().pages.length) {
    buildPreviewPages();
  }
  applyPreviewZoom();

  const list = el("preview-segs");
  list.innerHTML = "";
  previewSegmentNodes.clear();
  previewSegmentsBySeq.clear();
  previewFirstSeqByPage.clear();
  const visible = previewVisibleSegments();
  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = previewOnlySpan
      ? "没有跨页段（导出组装里没有段落被页面切开）。"
      : "这一段导出设置下没有可预览的正文。";
    list.append(empty);
  }
  for (const segment of visible) {
    list.append(buildPreviewSegment(segment));
  }
  for (const segment of visible) {
    for (const page of segment.pages || []) {
      if (!previewFirstSeqByPage.has(page.page_no)) {
        previewFirstSeqByPage.set(page.page_no, segment.seq);
      }
    }
  }
  el("preview-only-span").checked = previewOnlySpan;
  recordPreviewMetric("segments", visible.length);
  if (!previewActiveSeq || !previewSegmentNodes.has(previewActiveSeq)) {
    previewActiveSeq = null;
  }
}

function buildPreviewSegment(segment) {
  const pages = (segment.pages || []).map((page) => page.page_no);
  const li = document.createElement("li");
  li.className = "preview-seg";
  li.dataset.seq = String(segment.seq);
  li.dataset.firstPage = String(pages[0] || "");
  li.dataset.pages = pages.join(" ");
  li.dataset.blockIds = (segment.block_ids || []).join(" ");

  const head = document.createElement("div");
  head.className = "preview-seg__head";
  const seq = document.createElement("span");
  seq.className = "preview-seg__seq";
  seq.textContent = `§${segment.seq}`;
  const where = document.createElement("span");
  where.textContent =
    pages.length > 1
      ? `第 ${pages[0]}–${pages[pages.length - 1]} 页`
      : `第 ${pages[0] || "?"} 页`;
  head.append(seq, where);
  if (pages.length > 1) {
    const span = document.createElement("span");
    span.className = "preview-seg__span";
    span.textContent = "跨页续";
    span.title = `这一段跨了第 ${pages.join(" / ")} 页`;
    head.append(span);
  }

  const text = document.createElement("p");
  text.className = "preview-seg__text";
  text.textContent = segment.text;
  li.append(head, text);
  previewSegmentNodes.set(segment.seq, li);
  previewSegmentsBySeq.set(segment.seq, segment);
  return li;
}

// ---------------------------------------------------------------- 联动：段 ↔ 页

function renderPreviewFollow(segment) {
  const node = el("preview-follow");
  if (!node) return;
  if (!segment) {
    node.textContent = "";
    node.title = "";
    return;
  }
  const pages = (segment.pages || []).map((page) => page.page_no);
  if (pages.length > 1) {
    node.textContent = `§${segment.seq} 跨页 ${pages[0]}–${pages[pages.length - 1]}`;
    node.title = `这一段跨了第 ${pages.join(" / ")} 页：左边两页的块都标绿`;
  } else {
    node.textContent = `§${segment.seq} · 第 ${pages[0] || "?"} 页`;
    node.title = "右边当前这一段；左边对应块标绿";
  }
}

function hidePreviewJunction() {
  const node = el("preview-junction");
  if (node) node.hidden = true;
}

/** 跨页段：在左边两页交界处放一条明显分界线（"能看出来是跨页"）。 */
function showPreviewJunction(segment) {
  const node = el("preview-junction");
  if (!node) return;
  const pages = (segment.pages || []).map((page) => page.page_no);
  if (pages.length < 2) {
    node.hidden = true;
    return;
  }
  const next = previewTileTopMap.get(pages[1]);
  const wrap = el("preview-pages");
  const scroller = el("preview-pdf-scroll");
  if (!next || !wrap || !scroller) {
    node.hidden = true;
    return;
  }
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const wrapTop = wrap.getBoundingClientRect().top - base;
  node.textContent = `跨页续 · 第 ${pages[0]} → ${pages[1]} 页 · 两页的块都标绿`;
  node.style.top = `${Math.max(0, Math.round(next.top - wrapTop - 13))}px`;
  node.hidden = false;
}

function clearPreviewHits() {
  for (const tile of previewHitTiles) {
    const hits = tile.querySelector(".preview-page__hits");
    if (hits) {
      hits.innerHTML = "";
      hits.hidden = true;
    }
  }
  previewHitTiles.clear();
}

/** 当前段命中的块：用 bbox 画浅绿框（行框是后端给的块框，不猜字符位置）。 */
function drawPreviewHits() {
  clearPreviewHits();
  for (const item of previewActiveBlocks) {
    const tile = previewTiles.get(item.pageNo);
    if (!tile || !item.block || !item.block.bbox) continue;
    const hits = tile.querySelector(".preview-page__hits");
    if (!hits) continue;
    const box = document.createElement("div");
    box.className = "preview-page__hit";
    injected.applyBoxElementRect(box, item.block.bbox);
    box.title = `第 ${item.pageNo} 页 · 这一段来自这个块`;
    hits.append(box);
    hits.hidden = false;
    previewHitTiles.add(tile);
  }
}

function clearPreviewActive() {
  if (previewActiveSeq !== null) {
    const previous = previewSegmentNodes.get(previewActiveSeq);
    if (previous) previous.classList.remove("is-current");
  }
  previewActiveSeq = null;
  previewActiveBlocks = [];
  previewHitToken += 1;
  drawPreviewHits();
  hidePreviewJunction();
  renderPreviewFollow(null);
}

/** 加载这一段所有页的块，挑出段落命中的块，画浅绿。 */
async function highlightPreviewSegment(segment) {
  const token = ++previewHitToken;
  const pageNos = (segment.pages || []).map((page) => page.page_no);
  renderPreviewFollow(segment);
  showPreviewJunction(segment);
  const wanted = new Set(segment.block_ids || []);
  const byPage = new Map();
  await Promise.all(
    pageNos.map(async (pageNo) => {
      byPage.set(pageNo, await ensurePreviewBlocks(pageNo));
    })
  );
  if (token !== previewHitToken) return [];
  const found = [];
  for (const pageNo of pageNos) {
    for (const block of byPage.get(pageNo) || []) {
      if (block.bbox && wanted.has(block.block_id)) found.push({ block, pageNo });
    }
  }
  previewActiveBlocks = found;
  drawPreviewHits();
  // 块框到了如果还没画（窗口同步拿的是缓存），补一次
  for (const pageNo of pageNos) {
    if (Math.abs(pageNo - (previewPageNo || 1)) <= 1) paintPreviewTile(pageNo);
  }
  return found;
}

/** 左边滚到某一段：单页段定位到块的上沿，跨页段把两页交界放到视口中央。 */
function scrollPreviewLeftToSegment(segment, hits) {
  const scroller = el("preview-pdf-scroll");
  if (!scroller || !previewTiles.size) return;
  const pages = (segment.pages || []).map((page) => page.page_no);
  let target = null;
  if (pages.length > 1) {
    // 段的第一处交界：跨 2 页就是唯一交界，跨 3 页以上从段的开头看
    const next = previewTileTopMap.get(pages[1]);
    if (next) target = next.top - scroller.clientHeight * 0.5;
  } else {
    const first = previewTileTopMap.get(pages[0]);
    if (!first) return;
    const hit = hits && hits.find((item) => item.pageNo === pages[0]);
    target = hit
      ? first.top + first.height * hit.block.bbox[1] - scroller.clientHeight * 0.28
      : first.top - 8;
  }
  if (target === null) return;
  markPreviewDriver("right");
  scroller.scrollTop = Math.max(0, target);
}

function scrollPreviewLeftToPage(pageNo) {
  const scroller = el("preview-pdf-scroll");
  const entry = previewTileTopMap.get(pageNo);
  if (!scroller || !entry) return;
  const target = Math.max(0, entry.top - 8);
  if (Math.abs(scroller.scrollTop - target) < 4) return;
  markPreviewDriver("right");
  scroller.scrollTop = target;
}

function setPreviewActive(seq, { scrollRight = false, scrollLeft = false, keepPage = false } = {}) {
  if (seq === null || seq === undefined) {
    clearPreviewActive();
    return;
  }
  const node = previewSegmentNodes.get(seq);
  const segment = previewSegmentsBySeq.get(seq);
  if (!node || !segment) return;
  if (previewActiveSeq !== seq) {
    const previous = previewActiveSeq !== null ? previewSegmentNodes.get(previewActiveSeq) : null;
    if (previous) previous.classList.remove("is-current");
    node.classList.add("is-current");
    previewActiveSeq = seq;
  }
  if (scrollRight) {
    markPreviewDriver("left");
    node.scrollIntoView({ block: "start", behavior: "auto" });
  }
  const firstPage = (segment.pages[0] || {}).page_no;
  if (!keepPage && firstPage) previewPageNo = firstPage;
  if (scrollLeft) scrollPreviewLeftToSegment(segment, []);
  syncPreviewWindow();
  highlightPreviewSegment(segment).then(() => {
    if (previewActiveSeq !== seq) return;
    if (scrollLeft) scrollPreviewLeftToSegment(segment, previewActiveBlocks);
  });
}

function updatePreviewPageUI() {
  const total = injected.getProject() ? injected.getProject().pages.length : 0;
  const pageNo = previewPageNo || 1;
  el("preview-page-no").textContent = `第 ${pageNo} 页`;
  el("preview-prev").disabled = pageNo <= 1;
  el("preview-next").disabled = pageNo >= total;
  updatePreviewPrintedLabel(pageNo);
}

/** 页头印刷页：目录确认的索引已经算过，直接借；没算过就懒加载一次。 */
function updatePreviewPrintedLabel(pageNo) {
  const label = el("preview-page-printed");
  if (!label || !injected.getProject()) return;
  if (injected.getPageIndexData() && injected.getPageIndexProject() === injected.getProject().project_id) {
    const entry = injected.getPageIndexData().pages.find((item) => item.page_no === pageNo);
    label.textContent = entry
      ? entry.missing
        ? "未识别页码"
        : `印刷页 ${entry.printed[0] || ""}`
      : "";
    return;
  }
  label.textContent = "";
  if (!injected.getPageIndexLoading()) {
    injected.loadPageIndex().then(() => updatePreviewPrintedLabel(previewPageNo));
  }
}

/** 左边翻页 / 左栏滚到某页 → 右边滚到这一页的第一段。 */
function jumpPreviewToPage(pageNo, { scrollRight = true } = {}) {
  if (!injected.getProject()) return;
  const total = injected.getProject().pages.length;
  if (!pageNo || pageNo < 1 || pageNo > total) return;
  previewPageNo = pageNo;
  updatePreviewPageUI();
  scrollPreviewLeftToPage(pageNo);
  syncPreviewWindow();
  if (!previewData) return;
  const note = el("preview-note");
  const seq = previewFirstSeqByPage.get(pageNo);
  if (seq === undefined) {
    note.hidden = false;
    note.textContent = previewOnlySpan
      ? `第 ${pageNo} 页没有跨页段。`
      : `第 ${pageNo} 页没有进入正文的段落（封面 / 空白 / 整页插图，或按当前导出设置被排除）。`;
    clearPreviewActive();
    return;
  }
  note.hidden = true;
  setPreviewActive(seq, { scrollRight, keepPage: true });
}

function stepPreviewPage(delta) {
  if (!injected.getProject()) return;
  const total = injected.getProject().pages.length;
  const next = Math.min(total, Math.max(1, (previewPageNo || 1) + delta));
  if (next === previewPageNo) return;
  jumpPreviewToPage(next, { scrollRight: true });
}

/** 右栏滚动 → 取视口顶端那一段（不逐段量矩形，elementFromPoint 是 O(1)）。 */
function previewSegmentAtTop() {
  const scroller = el("preview-scroll");
  if (!scroller) return null;
  const rect = scroller.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return null;
  if (typeof document.elementFromPoint === "function") {
    const hit = document.elementFromPoint(
      rect.left + Math.min(80, rect.width / 2),
      rect.top + 8
    );
    const node = hit && hit.closest ? hit.closest(".preview-seg") : null;
    if (node) return node;
  }
  const top = rect.top + 6;
  for (const node of scroller.querySelectorAll(".preview-seg")) {
    if (node.getBoundingClientRect().bottom >= top) return node;
  }
  return null;
}

function onPreviewScroll() {
  if (previewRightRaf) return;
  previewRightRaf = requestAnimationFrame(() => {
    previewRightRaf = 0;
    if (!injected.isActive() || !previewData) return;
    if (previewDriverActive("left")) return;
    const node = previewSegmentAtTop();
    if (!node) return;
    const seq = Number(node.dataset.seq);
    if (!previewSegmentsBySeq.has(seq) || seq === previewActiveSeq) return;
    markPreviewDriver("right");
    setPreviewActive(seq, { scrollLeft: true });
  });
}

/** 左栏滚动 → 右栏定位到这一页的第一段（不让右边的滚动再反过来推左边）。 */
function onPreviewLeftScroll() {
  if (previewLeftRaf) return;
  previewLeftRaf = requestAnimationFrame(() => {
    previewLeftRaf = 0;
    if (!injected.isActive() || !previewData) return;
    if (previewDriverActive("right")) return;
    const pageNo = previewPageAtScroll();
    if (!pageNo || pageNo === previewPageNo) return;
    markPreviewDriver("left");
    jumpPreviewToPage(pageNo, { scrollRight: true });
  });
}

function previewPageAtScroll() {
  const scroller = el("preview-pdf-scroll");
  if (!scroller || !previewTileTops.length) return previewPageNo || 1;
  const anchor = scroller.scrollTop + scroller.clientHeight * 0.3;
  let lo = 0;
  let hi = previewTileTops.length - 1;
  let best = previewTileTops[0].pageNo;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = previewTileTops[mid];
    if (entry.top <= anchor) {
      best = entry.pageNo;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** 右栏悬停：事件代理，一次 rAF 只处理最后停住的那一段。 */
function onPreviewSegHover(event) {
  const node = event.target.closest ? event.target.closest(".preview-seg") : null;
  if (!node) return;
  const seq = Number(node.dataset.seq);
  if (!previewSegmentsBySeq.has(seq) || seq === previewActiveSeq) return;
  if (seq === previewPendingHover) return;
  previewPendingHover = seq;
  requestAnimationFrame(() => {
    const pending = previewPendingHover;
    previewPendingHover = 0;
    if (!injected.isActive() || pending === previewActiveSeq) return;
    if (!previewSegmentsBySeq.has(pending)) return;
    // 悬停只做高亮，不拖左边滚动：鼠标停在右栏时左栏自己滚动（或右栏滚过去）
    // 都会不断触发 pointerover，让左边来回跳。要看左边就跟到那一段，点一下。
    setPreviewActive(pending, { keepPage: true });
  });
}

function onPreviewSegClick(event) {
  const node = event.target.closest ? event.target.closest(".preview-seg") : null;
  if (!node) return;
  const seq = Number(node.dataset.seq);
  if (!previewSegmentsBySeq.has(seq)) return;
  markPreviewDriver("right");
  setPreviewActive(seq, { scrollLeft: true });
}

function setupPreview() {
  el("preview-prev").addEventListener("click", () => stepPreviewPage(-1));
  el("preview-next").addEventListener("click", () => stepPreviewPage(1));
  el("preview-zoom-out").addEventListener("click", () => changePreviewZoom(-1));
  el("preview-zoom-in").addEventListener("click", () => changePreviewZoom(1));
  el("preview-margin-toggle").addEventListener("click", togglePreviewMargin);
  el("preview-overlay-toggle").addEventListener("click", togglePreviewOverlay);
  el("preview-scroll").addEventListener("scroll", onPreviewScroll, { passive: true });
  el("preview-pdf-scroll").addEventListener("scroll", onPreviewLeftScroll, { passive: true });
  el("preview-segs").addEventListener("pointerover", onPreviewSegHover);
  el("preview-segs").addEventListener("click", onPreviewSegClick);
  window.addEventListener("resize", () => {
    if (!injected.isActive()) return;
    requestAnimationFrame(() => {
      if (!injected.isActive()) return;
      applyPreviewZoom();
      measurePreviewTiles();
      syncPreviewWindow();
    });
  });
  el("preview-only-span").addEventListener("change", (event) => {
    previewOnlySpan = Boolean(event.target.checked);
    const keep = previewActiveSeq;
    renderPreview();
    measurePreviewTiles();
    if (keep !== null && previewSegmentNodes.has(keep)) {
      setPreviewActive(keep, { scrollRight: false, keepPage: true });
      return;
    }
    const first = previewVisibleSegments()[0];
    if (first) setPreviewActive(first.seq, { scrollRight: true });
    else clearPreviewActive();
  });
}

  // ---------------------------------------------------------------- 对外接口

  /** 丢掉预览缓存（数据变了但还没重开时用；原 app.js 里两处 `previewData = null; previewProject = null`）。 */
  function dropPreviewCache() {
    previewData = null;
    previewProject = null;
  }

  /** boot() 调一次：注入依赖 + 绑 #view-preview 的事件（原 `setupPreview()` 原样搬入）。 */
  const init = (deps) => {
    injected = { ...injected, ...(deps || {}) };
    setupPreview();
  };

  /**
   * 进入预览（对外唯一入口）。
   * - 无参：等同原来的 `openPreview()`（默认开版心 / 块框，按导出设置组装或复用缓存）。
   * - `{ force: true }`：丢缓存后重开；**不在预览视图时只丢缓存**——对齐原来
   *   `if (currentView === "preview") await loadPreview(...)` 的守卫，切走了就别在后台拉一遍。
   * - `{ invalidate: true }`：只丢缓存、不重开（跨页边界改了，但用户还在页面上）。
   */
  const enter = async (params) => {
    const options = params || {};
    if (options.invalidate) {
      dropPreviewCache();
      return;
    }
    if (options.force) {
      dropPreviewCache();
      if (!injected.isActive()) return;
      await loadPreview(injected.exportOptions(), JSON.stringify(injected.exportOptions()));
      return;
    }
    await openPreview();
  };

  // 任务 94（2026-10-29 裁决）：**不导出 `exit`**。
  // 原来这里有一个"离开预览时撤掉两帧 rAF"的 `exit`，但 `showView` 从不调用它
  // （`.exit(` 全仓库 0 个调用点），所以它是**永不执行的导出**——和死代码一样会让棘轮松一格。
  // 实测（见 docs/refactor/reading-view-boundary.md §19 T4 的证据）：重复 `enter()` 不重复绑监听、
  // 不重建观察器，所以今天不需要"离开时清理"这个口子。将来真要清理，再按 §20.1 重新立一个
  // 有真实调用点的导出（那时它会有 showView 的调用点），不是现在先挂着。
  window.PreviewView = {
    init,
    enter,
  };
})();
