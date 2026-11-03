/**
 * 核心抽屉（审校视图的看图 / 翻页 / 差异层）—— `window.PageDetailDrawer`
 *
 * root = `#view-review`，**与 `page-detail-editor.js` 同一个 root**，靠 id 归属表分家：
 * 抽屉 21 个 id / 编辑器 30 个 / 外壳 20 个，两两不交、并集 == 子树（闸是唯一的防线）。
 *
 * 归属按「谁写它」，不按「它在谁的 div 里」：`page-detail-title` / `page-detail-meta` 物理上在
 * `.editor` 容器里（index.html:585），但内容由抽屉写 ⇒ 归抽屉。
 *
 * **状态：几乎全是共享的**。实测（按函数归属扫全仓）只有 `detailImagePageNo` 只被抽屉读写；
 * 书 §5 说「11 个可搬」是错的——`lastDetailPageNo` / `detailMargin` / `detailLines` /
 * `diffMarksMode` / `activeDiff` / `zoomLevel` / `reviewMarginOn` / `detailWorkflow` /
 * `suppressBoxClick` 全都有壳内引用（`showView` / `renderReviewTree` / `activateDiff` /
 * `zoomBy` / `onBoxPointerUp` …）。所以它们**留壳**，模块经 `S.x` 的 getter/setter 走注入，
 * 不留第二份。
 *
 * 三条回路/边界（书 §1.1 / §3 / §8）：
 *   ① `setupViewerTools` 按 owner 切四份：抽屉那六件 + resize 搬进来，树 / editor / 壳三份留壳
 *   ② `.editor` 的折叠由 editor 自己出 `toggleCollapsed()` —— 动作不写别人的 class，不开例外
 *   ③ 抽屉画完 DOM 喊一次 `injected.onPageDetailChanged(data)`，由外壳把 blocks 交给编辑器；
 *      抽屉导出面里没有 `renderBlocks`，编辑器也不反向调这里
 */
(function () {
  "use strict";

  let injected = {};
  let root = null;

  const part = (id) => (root ? root.querySelector(`#${id}`) : null);

  /** 只属于抽屉的状态。 */
  let detailImagePageNo = null;

  /**
   * 共享状态（外壳声明、外壳也在读写）⇒ 每个都走注入的 get/set，模块里**不留副本**。
   * 用 getter/setter 包一层，是为了让函数体里 `S.detailPageNo` 读和写是同一种写法
   * （搬迁时不用逐处判断读/写，减少"搬错一半"）。
   */
  const S = {
    get detailPageNo() { return injected.getDetailPageNo(); },
    set detailPageNo(value) { injected.setDetailPageNo(value); },
    get reviewBlocks() { return injected.getReviewBlocks(); },
    set reviewBlocks(value) { injected.setReviewBlocks(value); },
    get activeReviewBlockId() { return injected.getActiveReviewBlockId(); },
    set activeReviewBlockId(value) { injected.setActiveReviewBlockId(value); },
    get detailSuggestionByBlock() { return injected.getDetailSuggestionByBlock(); },
    get detailLayoutConfirmed() { return injected.getDetailLayoutConfirmed(); },
    set detailLayoutConfirmed(value) { injected.setDetailLayoutConfirmed(value); },
    get reviewBlockFilter() { return injected.getReviewBlockFilter(); },
    set reviewBlockFilter(value) { injected.setReviewBlockFilter(value); },
    get reviewFilterExplicit() { return injected.getReviewFilterExplicit(); },
    set reviewFilterExplicit(value) { injected.setReviewFilterExplicit(value); },
    get boxCreateMode() { return injected.getBoxCreateMode(); },
    get detailInkGaps() { return injected.getDetailInkGaps(); },
    get diffStripOpen() { return injected.getDiffStripOpen(); },
    get reviewTreeItems() { return injected.getReviewTreeItems(); },
    get lastDetailPageNo() { return injected.getLastDetailPageNo(); },
    set lastDetailPageNo(value) { injected.setLastDetailPageNo(value); },
    get detailMargin() { return injected.getDetailMargin(); },
    set detailMargin(value) { injected.setDetailMargin(value); },
    get detailLines() { return injected.getDetailLines(); },
    set detailLines(value) { injected.setDetailLines(value); },
    get diffMarksMode() { return injected.getDiffMarksMode(); },
    set diffMarksMode(value) { injected.setDiffMarksMode(value); },
    get activeDiff() { return injected.getActiveDiff(); },
    set activeDiff(value) { injected.setActiveDiff(value); },
    get zoomLevel() { return injected.getZoomLevel(); },
    set zoomLevel(value) { injected.setZoomLevel(value); },
    get reviewMarginOn() { return injected.getReviewMarginOn(); },
    set reviewMarginOn(value) { injected.setReviewMarginOn(value); },
    get detailWorkflow() { return injected.getDetailWorkflow(); },
    set detailWorkflow(value) { injected.setDetailWorkflow(value); },
    get suppressBoxClick() { return injected.getSuppressBoxClick(); },
    set suppressBoxClick(value) { injected.setSuppressBoxClick(value); },  };

  // ---------------------------------------------------------------- 搬进来的 20 个函数
async function openPageDetail(pageNo) {
  S.detailPageNo = pageNo;
  S.lastDetailPageNo = pageNo;
  S.detailWorkflow = null;
  // 换页回到默认档位「待处理」：上一页切到「全部」不该带到下一页
  S.reviewBlockFilter = "pending";
  S.reviewFilterExplicit = false;
  injected.showView("review");
  injected.clearPageDetailError();
  renderReviewPager();
  // 进页面就拉一次建议（不以缓存为准：别的页面改过类型后可能影响重复统计）
  await loadPageDetail(pageNo, { forceSuggestions: true });
  injected.savePosition("review", pageNo);
}

function closePageDetail() {
  S.detailPageNo = null;
  S.detailWorkflow = null;
  if (S.boxCreateMode) injected.setEditorBoxCreateMode(false);
  // aux-panel 与 page-detail-error 都在 editor 的表里 ⇒ 关它们由 editor 自己的动作做
  injected.closeAuxPanel();
  injected.clearPageDetailError();
}

async function loadPageDetail(pageNo, { forceSuggestions = false } = {}) {
  const project = injected.getCurrentProject();
  if (!project) return;
  // 先用缓存里的建议把页面画出来，不为建议 / 漏行等一次全库重复统计（会和逐条裁决抢 CPU）
  const cachedSuggestions =
    project.kind === "package" ? null : injected.getPageSuggestionCache().get(pageNo);
  injected.applyDetailSuggestions(
    cachedSuggestions || { suggestions: [], page_numbers: [], note: null }
  );
  try {
    const data = await injected.apiJson(
      `/api/projects/${project.project_id}/pages/${pageNo}/blocks`
    );
    if (S.detailPageNo !== null && S.detailPageNo !== pageNo) return;
    await renderPageDetail(data);
    // 补算建议 / 漏行（不 await：辅助信息晚一点出来不影响审校）
    injected.runPageAux(pageNo, { forceSuggestions });
  } catch (error) {
    // page-detail-error 在 editor 的表里 ⇒ 走它自己的错误入口
    injected.showPageDetailError(error);
  }
}

async function renderPageDetail(data) {
  const pageNo = data.page.page_no;
  S.reviewBlocks = data.blocks;
  S.detailMargin = data.margin || null;
  S.detailLines = (data.blocks || []).flatMap((block) => block.lines || []);
  S.activeReviewBlockId = null;
  S.activeDiff = null;
  S.diffStripOpen.clear();

  const recognition = injected.recognitionOf(data.page);
  part("page-detail-title").textContent = `第 ${pageNo} 页`;
  part("page-detail-meta").title = data.active_run
    ? `本页识别来自 ${data.active_run.engine_id} ${data.active_run.engine_version}`
    : "";

  injected.renderReviewBanner(data, recognition);
  injected.renderHistoryButtons(data.history);
  injected.setEditorPackageModeChrome(injected.getCurrentProject().kind === "package");
  renderReviewPager();

  // 图像按 view 档渲染；同一页重复打开时不重新拉图
  if (detailImagePageNo !== pageNo) {
    detailImagePageNo = pageNo;
    part("detail-image-status").textContent = "正在渲染…";
    part("detail-image-status").hidden = false;
    part("detail-canvas").hidden = true;
    const image = part("detail-image");
    image.onload = () => {
      part("detail-image-status").hidden = true;
      part("detail-canvas").hidden = false;
      applyZoom();
      // 块框默认关着，没有布局调度来顺手重画差异层：图出来自己画
      drawDiffLayer();
    };
    image.onerror = () => {
      part("detail-image-status").textContent = "这一页渲染失败。";   // 先给固定文案：不留空白
    };
    injected.attachRenderErrorDetail(image, {
      write: (text) => { part("detail-image-status").textContent = text; },
      fallback: "这一页渲染失败。",
    });
    image.src =
      `/api/projects/${injected.getProjectId()}/pages/${pageNo}/image?size=view` +
      `&token=${encodeURIComponent(injected.getToken())}`;
  } else {
    applyZoom();
    drawDiffLayer();
  }

  S.detailLayoutConfirmed = Boolean(data.page && data.page.layout_confirmed);
  S.detailWorkflow = data.workflow || null;
  // 版心要在块框之前画：块框的"版心外"淡色样式取决于画布上的 has-margin 类
  paintReviewMargin(injected.detailPageRecord() || data.page);
  part("review-margin-toggle").classList.toggle("is-on", S.reviewMarginOn);
  part("review-margin-toggle").textContent = S.reviewMarginOn ? "显示版心" : "版心已隐藏";
  drawDetailLines();
  drawDetailOverlay(data.blocks);
  // **单一回路**：抽屉画完自己的 DOM 后喊一次外壳的实现，由它把 blocks 交给编辑器
  // （renderBlocks + 选首个差异块 + 两个面板）。抽屉导出面里没有 renderBlocks，编辑器也不反向调这里。
  await injected.onPageDetailChanged(data);
  renderReviewHeadline();
  injected.renderReviewWorkflowStatus();
  // 任务 45：当前页自动展开、当前条目滚到约 40%（条目用刚渲染的块重建，别拿上一页的）
  S.reviewTreeItems.set(pageNo, injected.treeItemsFromBlocks(S.reviewBlocks));
  injected.syncReviewTreeToPage(pageNo, { scroll: true });
}

function setupReviewPager() {
  part("review-prev").addEventListener("click", () => injected.stepPage(-1));
  part("review-next").addEventListener("click", () => injected.stepPage(1));
  part("review-jump-filter").addEventListener("change", renderReviewPager);
  part("review-jump").addEventListener("click", () => {
    const answer = prompt("跳到第几页？", S.detailPageNo ? String(S.detailPageNo) : "");
    if (!answer) return;
    const pageNo = Number(answer.trim());
    if (!Number.isInteger(pageNo) || !injected.getCurrentProject().pages.some((p) => p.page_no === pageNo)) {
      injected.setSaveState(`没有第 ${answer.trim()} 页`, true);
      return;
    }
    openPageDetail(pageNo);
  });
}

function applyZoom() {
  const canvas = part("detail-canvas");
  const image = part("detail-image");
  if (!image || !image.naturalWidth) return;
  const base = fitWidth();
  const width = S.zoomLevel === null ? base : Math.round(base * S.zoomLevel);
  canvas.style.width = `${width}px`;
  // **图必须跟 canvas 同宽**：`max-width: 100%` 只封上限，封的是 canvas 宽；但图片自身不会
  // 被放大到超过 naturalWidth ⇒ 一旦 canvas 比 natural 宽（>100% 的档位），图就停在 natural，
  // 而块框是按 overlay 的百分比定位（overlay 撑满 canvas）⇒ 横向整体偏移。
  // 显式给图同一个宽，三者（canvas / image / overlay）才等比。
  image.style.width = `${width}px`;
  part("zoom-fit").classList.toggle("is-on", S.zoomLevel === null);
  // 顺序号 / 悬停卡片是像素定位的：宽度变了要重新找空位
  injected.scheduleDetailOverlayLayout(part("detail-overlay"));
}

function fitWidth() {
  const scroll = part("viewer-scroll");
  return Math.max(280, scroll.clientWidth - 44);
}

function setReviewOverlay(on) {
  const button = part("toggle-overlay");
  if (!button) return;
  button.classList.toggle("is-on", Boolean(on));
  part("detail-overlay").hidden = !on;
  button.textContent = on ? "显示块框" : "块框已隐藏";
  if (on) injected.scheduleDetailOverlayLayout(part("detail-overlay"));
}

function setReviewMargin(on) {
  S.reviewMarginOn = Boolean(on);
  const button = part("review-margin-toggle");
  if (button) {
    button.classList.toggle("is-on", S.reviewMarginOn);
    button.textContent = S.reviewMarginOn ? "显示版心" : "版心已隐藏";
  }
  if (S.detailPageNo !== null) paintReviewMargin(injected.detailPageRecord() || null);
}

function paintReviewMargin(page) {
  const layer = part("detail-margin");
  const canvas = part("detail-canvas");
  if (!layer || !canvas) return;
  const box = S.reviewMarginOn && page ? injected.marginBoxOfPage(page) : null;
  const show = Boolean(box);
  layer.hidden = !show;
  canvas.classList.toggle("has-margin", show);
  if (!show) {
    layer._box = null;
    return;
  }
  const mode = page.margin_box_mode;
  layer.classList.toggle("page-margin--custom", mode === "custom");
  layer.classList.toggle(
    "page-margin--auto",
    mode !== "custom" &&
      !(mode === "auto" && page.margin_box) &&
      injected.globalMarginIsAuto()
  );
  injected.applyMarginRect(layer.querySelector(".page-margin__box"), box);
}

function toggleReviewMargin() {
  S.reviewMarginOn = !S.reviewMarginOn;
  injected.saveReviewMarginPreference();
  const button = part("review-margin-toggle");
  if (button) {
    button.classList.toggle("is-on", S.reviewMarginOn);
    button.textContent = S.reviewMarginOn ? "显示版心" : "版心已隐藏";
  }
  paintReviewMargin(injected.detailPageRecord());
}

function renderReviewPager() {
  const node = part("review-page-no");
  node.textContent = "";
  const page =
    injected.getCurrentProject() && S.detailPageNo !== null
      ? injected.getCurrentProject().pages.find((item) => item.page_no === S.detailPageNo)
      : null;
  if (!page) {
    node.textContent = "—";
    part("review-prev").disabled = true;
    part("review-next").disabled = true;
    return;
  }
  node.append(`第 ${page.page_no} 页`);
  if (page.page_label) {
    const printed = document.createElement("span");
    printed.textContent = `（印 ${page.page_label}）`;
    node.append(printed);
  }
  const pages = pagerPages();
  const index = pages.findIndex((item) => item.page_no === page.page_no);
  part("review-prev").disabled = index <= 0;
  part("review-next").disabled = index < 0 || index >= pages.length - 1;
}

function pagerPages() {
  if (!injected.getCurrentProject()) return [];
  const kind = part("review-jump-filter").value;
  return injected.getCurrentProject().pages.filter((page) => {
    if (!page.include) return false;
    if (!kind) return true;
    return injected.matchesTriage(page, injected.recognitionOf(page), kind);
  });
}

function renderReviewHeadline() {
  const page = injected.detailPageRecord();
  if (!page) return;
  const counts = injected.aggregateDivergence();
  const outside = counts.outside || { lines: 0 };
  const margin = S.detailMargin;
  const bits = [injected.PAGE_TYPE_LABELS[page.page_type] || page.page_type];
  if (counts.lines) {
    bits.push(
      `${counts.lines} 处待处理差异（汉字 ${counts.chars} · 标点 ${counts.punct}）` +
        (counts.acked ? ` · 已确认 ${counts.acked}` : "")
    );
  } else if (counts.acked) {
    bits.push(`无待处理差异 · 已确认 ${counts.acked}`);
  } else if (outside.lines) {
    bits.push("无版心内差异");
  } else {
    bits.push("无差异");
  }
  // 任务 34：版心外的书眉 / 页码差异不进队列，但要在页头如实写出来。
  if (outside.lines) bits.push(`版心外 ${outside.lines} 处未计入`);
  if (margin && margin.none) bits.push("整页计入（不适用版心）");
  else if (margin && margin.undetermined) bits.push("整页计入（版心未定）");
  if (!S.detailLayoutConfirmed) bits.push("版面未确认");
  if (S.detailInkGaps.length) bits.push(`漏行 ${S.detailInkGaps.length}`);
  part("page-detail-meta").textContent = bits.join(" · ");
}

function drawDetailOverlay(blocks) {
  const overlay = part("detail-overlay");
  overlay.innerHTML = "";
  // 行框也当作障碍：顺序号 / 卡片不许压到任何一行（含未归属 / 冲突行）
  overlay._lineBboxes = (S.detailLines || [])
    .map((line) => line.bbox)
    .filter(Boolean);
  const page = injected.detailPageRecord();
  blocks.forEach((block, index) => {
    if (!block.bbox) return;
    const box = document.createElement("div");
    box.className = "box";
    box.classList.add(`box--type-${block.block_type}`);
    // 任务 53：按块中心点标出"版心外"；样式只在版心显示时生效（见 app.css）
    if (!injected.blockInsideMargin(block, page)) box.classList.add("box--outside-margin");
    if (!block.include) box.classList.add("box--excluded");
    if (injected.CHROME_BLOCK_TYPES.has(block.block_type)) box.classList.add("box--chrome");
    if (injected.TEXT_FREE_BLOCK_TYPES.has(block.block_type)) box.classList.add("box--textfree");
    if (block.review_status === "uncertain") box.classList.add("box--uncertain");
    box.dataset.blockId = block.block_id;
    box.dataset.type = block.block_type;
    box._bbox = block.bbox;
    injected.applyBoxElementRect(box, block.bbox);
    box.title =
      `${injected.boxTypeLabel(block)} · 第 ${index + 1} 块 · 拖动移位、拖角缩放`;

    // 默认只给顺序号；类型 / 把握 / 采用 / 页码在悬停（或选中）卡片里
    const suggestion = S.detailSuggestionByBlock.get(block.block_id);
    box.append(injected.buildBoxOrder(index));
    box.append(injected.buildBoxLabel(block, index, suggestion));

    // 四个角是缩放手柄；手柄吃掉 pointerdown，免得同时触发整框拖动
    for (const corner of injected.HANDLE_CORNERS) {
      const handle = document.createElement("span");
      handle.className = `box__handle box__handle--${corner}`;
      handle.title = "拖这个角缩放（会吸附到文字行边界）";
      handle.addEventListener("pointerdown", (event) =>
        injected.startBoxDrag(event, block, box, corner)
      );
      box.append(handle);
    }

    box.addEventListener("pointerdown", (event) => injected.startBoxDrag(event, block, box, "move"));
    box.addEventListener("click", (event) => {
      if (S.suppressBoxClick) {
        S.suppressBoxClick = false;
        return;
      }
      event.stopPropagation();
      // 点到一个被"版心内"过滤挡住的块：先切到「全部」，让它出现在列表里
      const item = injected.ensureBlockListed(block.block_id);
      if (item) {
        injected.selectReviewBlock(block.block_id);
        item.querySelector("textarea").focus();
        item.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
    overlay.append(box);
  });
  // 先同步摆一次（getBoundingClientRect 会强制布局），再等下一帧处理"图还没出来"的情况
  // 先同步摆一次（getBoundingClientRect 会强制布局），再等下一帧处理"图还没出来"的情况
  injected.layoutOverlay(overlay, { bboxOf: (box) => box._bbox, lineBboxes: overlay._lineBboxes });
  injected.scheduleDetailOverlayLayout(overlay);
}

function drawDetailLines() {
  const layer = part("detail-lines");
  layer.innerHTML = "";
  for (const line of S.detailLines) {
    if (!line.bbox) continue;
    if (line.layout_status !== "unassigned" && line.layout_status !== "conflict") continue;
    const [x0, y0, x1, y1] = line.bbox;
    const mark = document.createElement("div");
    mark.className = `line-box line-box--${line.layout_status}`;
    mark.style.left = `${x0 * 100}%`;
    mark.style.top = `${y0 * 100}%`;
    mark.style.width = `${(x1 - x0) * 100}%`;
    mark.style.height = `${(y1 - y0) * 100}%`;
    mark.title =
      (line.layout_status === "conflict" ? "冲突行" : "未归属行") +
      `：${line.text || "（这一行没有文本）"}`;
    layer.append(mark);
  }
}

function drawDiffLayer(attempt = 0) {
  const layer = part("detail-diff-layer");
  if (!layer) return;
  const canvas = part("detail-canvas");
  const toggle = part("toggle-diff-marks");
  if (!canvas || canvas.hidden) {
    layer.innerHTML = "";
    document.body.classList.remove("diff-mode");
    if (toggle) toggle.disabled = true;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 60 || rect.height < 60) {
    if (attempt < 30) requestAnimationFrame(() => drawDiffLayer(attempt + 1));
    return;
  }
  layer.innerHTML = "";
  layer.classList.toggle("is-narrow", rect.width < 480);
  let total = 0;
  let drawn = 0;
  const pageRecord = injected.detailPageRecord();
  for (const block of S.reviewBlocks) {
    const divergence = injected.divergenceOf(block);
    if (divergence.stale || !(divergence.marks || []).length) continue;
    // 任务 34：版心外的差异不进审校口径（书眉 / 页码），别在页面上画
    if (!injected.blockCountedInMargin(block, pageRecord)) continue;
    for (const mark of divergence.marks) {
      if (!injected.DIFF_LEVELS.has(mark.level)) continue;
      if (S.diffMarksMode === "off") continue;
      if (S.diffMarksMode === "todo" && mark.ack) continue;
      total += 1;
      const line = (block.lines || [])[mark.line_index];
      if (!line || !line.bbox) continue;
      if (line.layout_status === "conflict" || line.layout_status === "unassigned") continue;
      const bbox = line.bbox;
      const left = Math.max(0, bbox[0] * rect.width - 1);
      const top = bbox[1] * rect.height + 1;
      const width = Math.max(4, (bbox[2] - bbox[0]) * rect.width + 2);
      const height = Math.max(6, (bbox[3] - bbox[1]) * rect.height - 2);
      const node = document.createElement("div");
      node.className = "diff-mark";
      if (mark.level === "differs_punct") node.classList.add("diff-mark--punct");
      if (mark.ack) node.classList.add("diff-mark--done");
      const isActive =
        S.activeDiff &&
        S.activeDiff.blockId === block.block_id &&
        S.activeDiff.lineIndex === mark.line_index;
      if (isActive) node.classList.add("is-active");
      node.dataset.blockId = block.block_id;
      node.dataset.lineIndex = String(mark.line_index);
      node.dataset.span = "0";
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.width = `${width}px`;
      node.style.height = `${height}px`;
      const count = injected.lineDiffSpanCount(mark);
      const end = document.createElement("span");
      end.className = "diff-mark__end";
      if (isActive) {
        end.classList.add("is-current");
        end.textContent = `${count} 处`;
      } else if (mark.ack) {
        end.classList.add("is-done");
        end.textContent = "已保留";
      } else {
        end.textContent = `${count} 处`;
      }
      node.append(end);
      node.title =
        `第 ${mark.line_index + 1} 行 · ${injected.diffLevelLabel(mark.level)} · ` +
        (mark.ack ? "已保留原文（仍是差异）" : `${count} 处差异`) +
        `\n第一路：${injected.truncate(mark.current, 60)}` +
        `\n第二路：${injected.truncate(mark.candidate || "（没读出）", 60)}`;
      node.setAttribute("role", "button");
      node.setAttribute("aria-hidden", "true");
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        injected.activateDiff(block.block_id, mark.line_index, 0);
      });
      layer.append(node);
      drawn += 1;
    }
  }
  document.body.classList.toggle("diff-mode", drawn > 0);
  if (toggle) {
    toggle.disabled = total === 0 && S.diffMarksMode !== "off";
    toggle.textContent = `差异：${
      S.diffMarksMode === "all" ? "未审+已审" : S.diffMarksMode === "todo" ? "仅未审" : "关"
    }`;
    toggle.classList.toggle("is-on", drawn > 0);
  }
}

function findDiffMark(blockId, lineIndex, spanIndex) {
  return part("detail-diff-layer").querySelector(
    `.diff-mark[data-block-id="${blockId}"][data-line-index="${lineIndex}"][data-span="${spanIndex}"]`
  );
}

function scrollViewerTo(node) {
  if (!node) return;
  const scroll = part("viewer-scroll");
  const sr = scroll.getBoundingClientRect();
  const nr = node.getBoundingClientRect();
  const top = scroll.scrollTop + (nr.top - sr.top) - scroll.clientHeight * 0.4;
  scroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function updateDiffActive() {
  // 块列表（#detail-blocks）在 editor 的表里 ⇒ 那一半由 editor 自己的动作写，抽屉只更新差异层
  injected.highlightActiveDiff(S.activeDiff);
  for (const mark of part("detail-diff-layer").querySelectorAll(".diff-mark")) {
    const active =
      S.activeDiff &&
      mark.dataset.blockId === S.activeDiff.blockId &&
      Number(mark.dataset.lineIndex) === S.activeDiff.lineIndex &&
      (S.activeDiff.spanIndex === null || Number(mark.dataset.span) === S.activeDiff.spanIndex);
    mark.classList.toggle("is-active", Boolean(active));
  }
}


  // ---------------------------------------------------------------- 接线（抽屉那六件 + resize）
  /**
   * 只绑抽屉自己的六件与窗口 resize。
   * 同一个函数原来还绑树 / editor / 壳 三份（`review-tree-filter` / `review-tree-rail` /
   * `review-drawer-toggle` / editor 的 margin-filter / `review-pin`）——那三份**留壳**，
   * 各自带 owner 备注，不在本模块里出现它们的 id。
   */
  function setupViewerControls() {
    part("zoom-in")?.addEventListener("click", () => zoomBy(1));
    part("zoom-out")?.addEventListener("click", () => zoomBy(-1));
    part("zoom-fit")?.addEventListener("click", () => {
      S.zoomLevel = null;
      applyZoom();
    });
    // 保持与搬迁前逐字等价（三处显式 detail 调度：applyZoom / setReviewOverlay / 这里）
    part("toggle-overlay")?.addEventListener("click", () => {
      const on = !part("toggle-overlay").classList.contains("is-on");
      part("toggle-overlay").classList.toggle("is-on", on);
      part("detail-overlay").hidden = !on;
      part("toggle-overlay").textContent = on ? "显示块框" : "块框已隐藏";
      if (on) injected.scheduleDetailOverlayLayout(part("detail-overlay"));
    });
    part("toggle-diff-marks")?.addEventListener("click", () => {
      S.diffMarksMode =
        S.diffMarksMode === "all" ? "todo" : S.diffMarksMode === "todo" ? "off" : "all";
      drawDiffLayer();
    });
    part("review-margin-toggle")?.addEventListener("click", toggleReviewMargin);
    window.addEventListener?.("resize", () => {
      if (S.zoomLevel === null) applyZoom();
    });
  }

  /** 缩放一档（按钮用）。 */
  function zoomBy(delta) {
    const current = S.zoomLevel ?? 1;
    const index = injected.ZOOM_STEPS.indexOf(current);
    const next = Math.min(injected.ZOOM_STEPS.length - 1, Math.max(0, index + delta));
    S.zoomLevel = injected.ZOOM_STEPS[next] === 1 ? null : injected.ZOOM_STEPS[next];
    applyZoom();
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || null;
    setupViewerControls();
    return api;
  }

  const api = {
    init,
    openPageDetail,
    closePageDetail,
    loadPageDetail,
    setReviewOverlay,
    setReviewMargin,
    paintReviewMargin,
    drawDetailOverlay,
    renderReviewHeadline,
    pagerPages,
    drawDiffLayer,
    findDiffMark,
    scrollViewerTo,
    updateDiffActive,
    // applyZoom 摘掉：全仓没有外部调用点（缩放按钮的接线在模块自己的 setupViewerControls 里），
    // 内部照用。导出面只留"有人在外壳/别的模块喊"的成员。
    setupReviewPager,
  };
  window.PageDetailDrawer = api;
})();
