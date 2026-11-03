/**
 * 版心数据（服务模块，无自建 DOM）—— `window.MarginData`
 *
 * 这一块不是面板，是**被四个视图消费**的数据与几何层：pages / index / preview / reading
 * 各自把 tile 传进来（`paintTileMargin(tile, page)` / `clearTileMargin(tile)`）。
 *
 * ## tile 元素契约（第一行，别改）
 * - `tile` = 调用方自己的 `.page-tile` 元素；
 * - tile 内必须有 `.page-margin`（带 `hidden` 与两个悬挂属性 `_box` / `_pageNo`）；
 * - `.page-margin` 内必须有 `.page-margin__box`（`applyMarginRect` 往它写百分比 left/top/width/height）；
 * - `page` 是页记录；box = `[x0,y0,x1,y1]` 归一化 0..1，来自 `marginBoxOfPage(page)`；无 box ⇒ hidden；
 * - **缺字段静默返回**（tile 为 null、找不到 `.page-margin`、box 不是有限 4 元数），不抛错。
 *   这是**设计选择，不是遗漏**：滚动每帧都会走到这里，日志会把控制台淹掉。坏数据一律等同
 *   「无 box」（hidden + 不写样式），绝不把 `NaN%` / `undefined%` 写进 style；
 * - **缓存必须挂在那一个 margin 元素上**（`_box` + `_pageNo`）：滚动每帧都会走到，
 *   值没变就不写样式。不许改成模块内 Map——换视图会破缓存。
 *
 * 状态 3 个（都在外壳）：currentProject · pagesMarginOn · reviewMarginOn ⇒ 访问器注入，模块不留副本。
 * 写盘 0（只有两个 localStorage key，前缀 `b2t.pagesMargin.v1.<pid>` / `b2t.reviewMargin.v1.<pid>`）。
 */
(function () {
  "use strict";

  let injected = {};

  const S = {
    get pagesMarginOn() { return injected.getPagesMarginOn(); },
    set pagesMarginOn(value) { injected.setPagesMarginOn(value); },
    get reviewMarginOn() { return injected.getReviewMarginOn(); },
    set reviewMarginOn(value) { injected.setReviewMarginOn(value); },
  };

function pageMarginStorageKey() {
  return injected.getCurrentProject() ? `b2t.pagesMargin.v1.${injected.getCurrentProject().project_id}` : "";
}

function loadPageMarginPreference() {
  try {
    return localStorage.getItem(pageMarginStorageKey()) !== "0";
  } catch {
    return true;
  }
}

function savePageMarginPreference() {
  try {
    localStorage.setItem(pageMarginStorageKey(), S.pagesMarginOn ? "1" : "0");
  } catch {
    /* 隐私模式等写不进去：不影响本次会话 */
  }
}

/**
 * 版心框只认「有限 4 元数」。缺项、字符串、NaN、Infinity 一律等同「无 box」：
 * 这样脏数据不会变成 `NaN%` 写进 style（paint 与导出的 applyMarginRect 都靠它兜底）。
 */
function isValidMarginBox(box) {
  return (
    Array.isArray(box) &&
    box.length === 4 &&
    box.every((value) => typeof value === "number" && Number.isFinite(value))
  );
}

function marginBoxOfPage(page) {
  if (!page || page.margin_box_mode === "none") return null;
  if (page.margin_box_mode === "custom" || page.margin_box_mode === "auto") {
    return isValidMarginBox(page.margin_box) ? page.margin_box : null;
  }
  const project = injected.getCurrentProject();
  return project && isValidMarginBox(project.margin_box) ? project.margin_box : null;
}

function pageMarginMethod(page) {
  if (!page || page.margin_box_mode !== "auto") return null;
  if (!page.margin_box) return "undetermined";
  return page.margin_box_method || "fit";
}

function pageMarginSourceLabel(page) {
  if (!page) return "";
  if (page.margin_box_mode === "none") return "不适用";
  if (page.margin_box_mode === "custom") return "本页自定义";
  if (page.margin_box_mode === "auto") {
    const method = pageMarginMethod(page);
    if (method === "undetermined") {
      return pageHasFitLines(page)
        ? "未定（有正文行，还没拟合）"
        : "未定（没有可用的正文行）";
    }
    if (method === "bbox") return "本页包围盒（兜底）";
    return "自动拟合";
  }
  return "沿用默认版心";
}

function reviewMarginStorageKey() {
  return injected.getCurrentProject() ? `b2t.reviewMargin.v1.${injected.getCurrentProject().project_id}` : "";
}

function loadReviewMarginPreference() {
  try {
    return localStorage.getItem(reviewMarginStorageKey()) !== "0";
  } catch {
    return true;
  }
}

function saveReviewMarginPreference() {
  try {
    localStorage.setItem(reviewMarginStorageKey(), S.reviewMarginOn ? "1" : "0");
  } catch {
    /* 隐私模式等写不进去：不影响本次会话 */
  }
}

function blockCenter(block) {
  const bbox = block && block.bbox;
  if (!bbox || bbox.length !== 4) return null;
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function blockInsideMargin(block, page) {
  const box = marginBoxOfPage(page);
  if (!box) return true;
  const center = blockCenter(block);
  if (!center) return true;
  return (
    center[0] >= box[0] && center[0] <= box[2] &&
    center[1] >= box[1] && center[1] <= box[3]
  );
}

function blockCountedInMargin(block, page) {
  if (block && typeof block.margin_inside === "boolean") return block.margin_inside;
  return blockInsideMargin(block, page || injected.detailPageRecord());
}

function reviewMarginSplit(page, blocks) {
  const box = marginBoxOfPage(page);
  const inside = [];
  const outside = [];
  if (!box) return { box: null, inside: [...blocks], outside };
  for (const block of blocks) {
    (blockCountedInMargin(block, page) ? inside : outside).push(block);
  }
  return { box, inside, outside };
}

function applyMarginRect(boxEl, box) {
  if (!boxEl || !isValidMarginBox(box)) return;
  const [x0, y0, x1, y1] = box;
  boxEl.style.left = `${x0 * 100}%`;
  boxEl.style.top = `${y0 * 100}%`;
  boxEl.style.width = `${(x1 - x0) * 100}%`;
  boxEl.style.height = `${(y1 - y0) * 100}%`;
}

function paintTileMargin(tile, page) {
  const margin = tile ? tile.querySelector(".page-margin") : null;
  if (!margin) return;
  if (!S.pagesMarginOn || !page) {
    clearTileMargin(tile);
    return;
  }
  const box = marginBoxOfPage(page);
  margin.classList.toggle("page-margin--custom", page.margin_box_mode === "custom");
  margin.classList.toggle("page-margin--inherit", page.margin_box_mode !== "custom");
  if (!box) {
    margin.hidden = true;
    margin._box = null;
    return;
  }
  // 滚动时每帧都会走到这里：框没变就别再写样式（267 页滚动时不值得为同样的值刷 DOM）
  const same =
    margin._box &&
    box.length === margin._box.length &&
    box.every((value, index) => Math.abs(value - margin._box[index]) < 1e-6);
  margin._box = box;
  margin._pageNo = page.page_no;
  if (same && !margin.hidden) return;
  applyMarginRect(margin.querySelector(".page-margin__box"), box);
  margin.hidden = false;
}

function clearTileMargin(tile) {
  const margin = tile ? tile.querySelector(".page-margin") : null;
  if (!margin) return;
  if (margin.hidden && !margin._box) return;
  margin.hidden = true;
  margin._box = null;
}

function mergePageRecord(updated) {
  if (!injected.getCurrentProject() || !updated) return;
  const index = injected.getCurrentProject().pages.findIndex((page) => page.page_id === updated.page_id);
  if (index >= 0) {
    injected.getCurrentProject().pages[index] = { ...currentProject.pages[index], ...updated };
  }
}

function repaintTileMargin(page) {
  if (!page || !injected.getCurrentProject()) return;
  // #page-grid 归网格（片 3）⇒ 不在这里查别人的子树，由外壳给"按页号取 tile"
  const tile = injected.getTileByPageNo(page.page_no);
  if (tile) paintTileMargin(tile, page);
}

function percentOf(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatMarginBox(box) {
  // 脏 box 按「未设置」显示：否则面板里会出现「左 NaN% · 上 undefined%」这种读数
  if (!isValidMarginBox(box)) return "未设置";
  return `左 ${percentOf(box[0])} · 上 ${percentOf(box[1])} · 右 ${percentOf(box[2])} · 下 ${percentOf(box[3])}`;
}

function formatMarginTime(raw) {
  if (!raw) return "";
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return raw;
  return when.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function marginSourceText() {
  if (!injected.getCurrentProject() || !injected.getCurrentProject().margin_box) return "";
  if (globalMarginIsAuto()) {
    const when = formatMarginTime(injected.getCurrentProject().margin_box_set_at);
    return `自动推算${when ? ` · ${when}` : ""}`;
  }
  return "手动设置";
}

function marginBasisForUndetermined(page) {
  const lines = pageLayoutLines(page) + pageTextLines(page);
  if (lines > 0) {
    return `未定：这一页有 ${lines} 行正文，但还没有拟合出四边（「重置为本页自动」可重算）`;
  }
  return "未定：这一页还没有可用的正文行（检测行 / 识别行框都没有），拟合不出版心";
}

  /**
   * 任务收尾 / 页面重新打开时从服务端重读版心状态（自动推算写在识别子进程里）。
   *
   * 只在任务**结束后**调用一次：轮询中途不重读，免得把用户正在拖的框改回去。
   * 返回是否有变化这件事不重要——界面统一重画一遍，成本很低。
   */
  async function refreshMarginState() {
    const project = injected.getCurrentProject();
    if (!project) return;
    try {
      const data = await injected.apiJson(`/api/projects/${project.project_id}/margin-box`);
      project.margin_box = data.margin_box || null;
      project.margin_box_source = data.source || null;
      project.margin_box_set_at = data.set_at || null;
      project.margin_box_suggestion = data.suggestion || null;
      injected.setMarginSuggestion(data.suggestion || null);
      injected.setMarginAuditPage(null);
    } catch {
      return;
    }
    // 任务 36B：任务结束后再看一眼版心——刚补上检测行的页之前拟合失败过，允许再试一次。
    injected.getMarginFitTried().clear();
    // 刀 9.3：tiles / panel / 条件拟合三处写点搬进 onTaskFinished（外壳在本函数 await 之后调一次），
    // 顺序仍在"读回 margin-box"之后；两个画法归抽屉，本模块只经注入喊它们。
    injected.paintReviewMargin(injected.detailPageRecord());
    // 版心外块的淡色样式要按新框重算（只改 class，不重建输入框之外的东西）
    if (injected.getDetailPageNo() !== null) injected.drawDetailOverlay(injected.getReviewBlocks());
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    return api;
  }

  const api = {
    init,
    paintTileMargin,
    clearTileMargin,
    repaintTileMargin,
    applyMarginRect,
    marginBoxOfPage,
    pageMarginMethod,
    pageMarginSourceLabel,
    formatMarginBox,
    formatMarginTime,
    marginSourceText,
    marginBasisForUndetermined,
    mergePageRecord,
    blockCountedInMargin,
    blockInsideMargin,
    reviewMarginSplit,
    savePageMarginPreference,
    loadPageMarginPreference,
    loadReviewMarginPreference,
    saveReviewMarginPreference,
    refreshMarginState,
  };
  window.MarginData = api;
})();
