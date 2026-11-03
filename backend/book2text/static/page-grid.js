/**
 * 页面网格（片 3a）：瓦片生产 + 块缓存 —— `window.PageGrid`
 *
 * ## 生产侧契约（与 `margin-data.js` 的消费侧契约对应，改一处必须同时改另一处）
 *
 * `buildTile(page, project)` 造出的子树，**顺序与层级都有意义**：
 *
 * ```
 * .page-tile[data-page-id][data-page-no]
 *   ├ .page-tile__thumb（aspect-ratio = width_pt / height_pt）
 *   │   ├ img[data-thumb-src]（loading=lazy；pageZoomIndex < 2 时才在这里给 src）
 *   │   ├ .page-margin[hidden] > .page-margin__box > 8 × .page-margin__handle[data-edge]
 *   │   ├ .page-tile__check
 *   │   ├ .page-tile__suggest
 *   │   └ .page-tile__actions > 识别 / 审校 两个按钮
 *   └ .page-tile__meta > .page-tile__label + .page-tile__status
 * ```
 *
 * - 版心在块框 overlay **之前**：overlay 由 registry 挂到 tile 上，打开块框时色框画在压暗层上面；
 * - `applyTileState()` 只改这棵树里已有的节点（轮询时用，不重建 DOM）；
 * - 本模块**不查全局 DOM**：tile 由调用方给、页面记录由调用方给（同 page-tile.js 的组件形态）。
 *
 * ## 状态
 *
 * `currentProject` / `selectedPages` / `busyPages` / `pageZoomIndex` 归外壳 ⇒ 注入访问器；
 * 块缓存四个结构也归外壳 ⇒ 注入**同一份活对象**（Map / Array / 常量），模块只读写、不替换。
 * 写盘 0；请求只发生在调用方（本模块只拼缩略图 URL，不发请求）。
 */

(function () {
  "use strict";

  let injected = {};

  /** 页面上该显示的门牌（类型 / 印张 / 状态），构建与刷新共用。 */
  function tileTitle(page) {
    const workflow = injected.workflowOf(page);
    const workflowNote = workflow
      ? `\n工作流：${workflow.stage_label}${workflow.layout ? ` · ${workflow.layout.line_count} 行` : ""}`
      : "";
    const marginNote = `\n版心：${injected.pageMarginSourceLabel(page)}`;
    return (
      `第 ${page.page_no} 页 · ${injected.PAGE_TYPE_LABELS[page.page_type] || page.page_type}` +
      ` · ${page.width_pt}×${page.height_pt} pt` +
      (page.rotation ? ` · 旋转 ${page.rotation}°` : "") +
      workflowNote +
      marginNote +
      "\n单击选中（Shift 选一段、⌘/Ctrl 加减一页），双击看识别结果"
    );
  }

  function tileClassName(page) {
    const recognition = injected.recognitionOf(page);
    return (
      "page-tile" +
      ` page-tile--ptype-${page.page_type}` +
      (page.include ? "" : " page-tile--excluded") +
      (page.has_text_layer ? " page-tile--textlayer" : "") +
      (injected.getBusyPages().has(page.page_no) ? " page-tile--busy" : "") +
      (recognition.status === "failed" ? " page-tile--failed" : "") +
      (!page.page_confirmed && injected.getCurrentProject().kind !== "package"
        ? " page-tile--unconfirmed"
        : "") +
      (injected.getSelectedPages().has(page.page_no) ? " page-tile--selected" : "")
    );
  }

  function buildTile(page, project) {
    const tile = document.createElement("div");
    tile.dataset.pageId = page.page_id;
    tile.dataset.pageNo = String(page.page_no);

    const thumb = document.createElement("div");
    thumb.className = "page-tile__thumb";
    // 与页面真实显示比例一致：overlay 用百分比定位，固定 1:1.414 会让非 A4 页错位
    thumb.style.aspectRatio = `${page.width_pt} / ${page.height_pt}`;

    const check = document.createElement("div");
    check.className = "page-tile__check";
    check.textContent = "✓";

    const image = document.createElement("img");
    // 说明书 6.1 要求缩略图由后台 Job 生成并缓存；缩略图任务还没做，
    // 这里按需渲染（不写缓存），浏览器侧靠 Cache-Control 复用。
    // 大图档由滚动 + requestAnimationFrame（updatePageVisibility）决定何时设置 src，
    // 离屏会清掉以释放解码内存。
    image.loading = "lazy";
    image.decoding = "async";
    image.alt = `第 ${page.page_no} 页`;
    image.dataset.thumbSrc =
      `/api/projects/${project.project_id}/pages/${page.page_no}/image?size=thumb` +
      `&token=${encodeURIComponent(injected.getToken())}`;
    // 渲染失败时把后端那句人话显示出来（与 PageTile 同一套实现，不复制）
    injected.attachRenderErrorDetail?.(image, { container: tile });
    if (injected.getPageZoomIndex() < 2) image.src = image.dataset.thumbSrc;

    // 版心框（默认隐藏）：框外压暗、8 个把手可拖。放在块框 overlay 之前，
    // 这样打开块框时色框画在压暗层上面，两者可以同时看。
    const margin = document.createElement("div");
    margin.className = "page-margin";
    margin.hidden = true;
    const marginBox = document.createElement("div");
    marginBox.className = "page-margin__box";
    for (const edge of ["n", "s", "w", "e", "nw", "ne", "sw", "se"]) {
      const handle = document.createElement("span");
      handle.className = `page-margin__handle page-margin__handle--${edge}`;
      handle.dataset.edge = edge;
      handle.title = "拖动调整版心（会吸附到正文行边界）";
      marginBox.append(handle);
    }
    margin.append(marginBox);

    const actions = document.createElement("div");
    actions.className = "page-tile__actions";

    // 块类型建议角标（只在算过的可见页出现，只数 high）：右上角，和左上角的
    // 选中勾、左缘的类型色条、橙色未确认虚线都不冲突；"建议 N"不靠颜色也能读。
    const suggestMark = document.createElement("span");
    suggestMark.className = "page-tile__suggest";
    suggestMark.hidden = true;

    const recognizeButton = document.createElement("button");
    recognizeButton.type = "button";
    recognizeButton.className = "btn";
    recognizeButton.dataset.action = "recognize";
    recognizeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      // 刀 7：recognizePage 已搬进 pages 模块（外壳只留调用点）
      injected.recognizePage(page);
    });

    const detailButton = document.createElement("button");
    detailButton.type = "button";
    detailButton.className = "btn";
    detailButton.textContent = "审校";
    detailButton.title = "看这一页的识别结果并开始审校";
    detailButton.addEventListener("click", (event) => {
      event.stopPropagation();
      injected.openPageDetail?.(page.page_no);
    });

    actions.append(recognizeButton, detailButton);
    thumb.append(image, margin, check, suggestMark, actions);

    const meta = document.createElement("div");
    meta.className = "page-tile__meta";
    const label = document.createElement("div");
    label.className = "page-tile__label";
    const status = document.createElement("div");
    status.className = "page-tile__status";
    meta.append(label, status);

    tile.append(thumb, meta);
    tile.addEventListener("dblclick", (event) => {
      event.preventDefault();
      injected.openPageDetail?.(page.page_no);
    });
    return tile;
  }

  /** 就地刷新一个瓷砖的状态（轮询时用，不重建 DOM）。 */
  function applyTileState(tile, page) {
    const recognition = injected.recognitionOf(page);
    tile.className = tileClassName(page);
    tile.title = tileTitle(page);
    injected.paintTileSuggestionMark(tile, page.page_no);

    // 门牌：`p.87 · 正文`，印张页码进 tooltip（列宽只有一百多像素）
    const label = tile.querySelector(".page-tile__label");
    label.textContent = `p.${page.page_no}`;
    const kind = document.createElement("span");
    kind.textContent = ` · ${injected.PAGE_TYPE_LABELS[page.page_type] || page.page_type}`;
    label.append(kind);

    const status = tile.querySelector(".page-tile__status");
    status.innerHTML = "";
    status.append(injected.recognitionChip(page));
    const workflow = injected.workflowChip(page);
    if (workflow) status.append(workflow);
    const reviewChip = injected.reviewBadge(page);
    if (reviewChip) status.append(reviewChip);
    const divergence = injected.divergenceChip(page);
    if (divergence) status.append(divergence);
    if (page.is_context) {
      // 审校包里的只读上下文页（说明书 6.7.2）：助手的项目里也要一眼看出来
      const chip = document.createElement("span");
      chip.className = "status status--muted";
      chip.textContent = "只读上下文";
      chip.title = "任务包附带的只读上下文页，用来判断跨页段落，不能编辑";
      status.append(chip);
    } else if (page.assignment) {
      // 主项目里"已分派给谁"（说明书 6.7.6）
      const chip = document.createElement("span");
      chip.className = "status status--muted";
      chip.textContent = `${page.assignment.reviewer_name} · 审校中`;
      chip.title =
        `已分派给 ${page.assignment.reviewer_name}（${page.assignment.status_label}）：` +
        "现在改这一页会在合并时产生冲突";
      status.append(chip);
    }
    if (page.page_confirmed) {
      const chip = document.createElement("span");
      chip.className = "status status--ok";
      chip.textContent = "✓ 已确认";
      chip.title = "这一页的类型已人工确认";
      status.append(chip);
    }

    const isBusy = injected.getBusyPages().has(page.page_no);
    const button = tile.querySelector('button[data-action="recognize"]');
    button.textContent = isBusy ? "识别中…" : "识别";
    button.disabled = isBusy || !page.include;
    if (!page.include) {
      button.title = "不是「正文」类型，不参与识别。要把这一页纳入识别，把类型改成「正文」。";
    } else if (recognition.status === "recognized") {
      button.title = "重新识别这一页（不会覆盖，这次结果先不采用）";
    } else {
      button.title = "识别这一页（在后台任务里跑，进度看右下角）";
    }
  }

  function pageBlockKey(pageNo) {
    return `${injected.getCurrentProject().project_id}:${pageNo}`;
  }

  function rememberPageBlocks(key, blocks) {
    const existing = injected.pageBlockCacheOrder.indexOf(key);
    if (existing >= 0) injected.pageBlockCacheOrder.splice(existing, 1);
    injected.pageBlockCache.set(key, blocks);
    injected.pageBlockCacheOrder.push(key);
    while (injected.pageBlockCacheOrder.length > injected.PAGE_BLOCK_CACHE_LIMIT) {
      const oldest = injected.pageBlockCacheOrder.shift();
      injected.pageBlockCache.delete(oldest);
    }
  }

  /**
   * 丢掉一页的块缓存（识别刚完成、重新识别、块被换掉之后用）。
   *
   * 同时把这一页的"作废代次" +1：没有它，一个早发晚到的旧响应会在作废之后
   * 又把旧块写回缓存，用户就得等下一次刷新才能看到新的框。
   * 这一页的块类型建议也一起丢掉——块都变了，建议得重算。
   */
  function forgetPageBlocks(pageNo) {
    const key = pageBlockKey(pageNo);
    injected.pageBlockVersions.set(key, (injected.pageBlockVersions.get(key) || 0) + 1);
    injected.pageBlockCache.delete(key);
    const index = injected.pageBlockCacheOrder.indexOf(key);
    if (index >= 0) injected.pageBlockCacheOrder.splice(index, 1);
    injected.forgetPageSuggestions(pageNo);
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    return api;
  }

  const api = {
    init,
    buildTile,
    applyTileState,
    pageBlockKey,
    rememberPageBlocks,
    forgetPageBlocks,
  };
  window.PageGrid = api;
})();
