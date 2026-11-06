// 预览导出页（第 6 步）：三栏 = 左书籍目录 / 中 PDF 原文 / 右成品文本。
//
// **第 1 笔只读**：能看、能对（点成品某段 ⇒ 左目录高亮那一页、中栏滚到那一页），不能改。
// 编辑、待提交、批量提交、离开守卫是后续几笔的事；这一笔不写库、不存草稿。
//
// 成品只有一条来源：`POST /export/preview?segments_only=1`（与导出同一份 options）。
// 这一层不自己拼文本——「预览 = 导出」靠的就是同一份 segments。
//
// 位置只有一份（`currentSegmentId`）：左目录、中栏、右栏都从它派生。
// 各自记一个位置就是"一边点、另一边不动"的根源。
//
// 依赖注入（外壳给）：
//   root            #view-preview（本模块独占的子树；内部一律 root.querySelector）
//   apiJson         (path, init) 带鉴权的 fetch
//   getProject      当前项目（含 pages: [{page_no, page_label}]）
//   exportOptions   与导出面板同一份选项
//   showError       (node, error) 统一错误显示
//   goBack          「返回」：回到进入这一页之前的视图
//   goReview        「返回审校」：回第 5 步
//   getPendingCount 待提交处数（第 1 笔恒为 0，接口留给后续几笔）
(function () {
  "use strict";

  let injected = {};
  let root = null;

  // 7 份私有状态（OWNERS 登记在 tests/js/boundary.test.mjs；R5 只看**列 0** 的模块绑定，
  // 所以这几行不缩进——别为了整齐把它们缩进去，闸会当成"这个模块没有状态"）
let previewProjectId = null;   // 成品属于哪个项目：换项目要清空，不许拿旧 payload
let previewSegments = [];      // 成品段（唯一来源：/export/preview）
let previewSegmentCount = null; // 服务端报的段数：必须与 segments.length 相等
let previewCurrentSegmentId = null; // 当前位置（三栏共用的唯一一份）
let previewPages = [];         // 中栏的页（来自 currentProject.pages）
let previewLoading = false;
let previewRequestSeq = 0;     // 连点两次加载只认最后一次（别让旧响应盖新页）

  function pvPart(name) {
    return root ? root.querySelector(`#${name}`) : null;
  }

  // ---------------------------------------------------------------- 段与行
  /** 段的首个来源页（成品左目录按页分组、中栏按页滚动都靠它）。 */
  function pvSegmentPageNo(segment) {
    const pages = (segment && segment.pages) || [];
    const first = pages[0];
    return first && Number.isFinite(Number(first.page_no)) ? Number(first.page_no) : null;
  }

  /** 段内按 line_spans 切行；没有 span 时整段一行（空段显示占位，不吞行）。 */
  function pvSegmentLines(segment) {
    const text = String((segment && segment.text) || "");
    const spans = Array.isArray(segment && segment.line_spans) ? segment.line_spans : [];
    if (!spans.length) return [{ text: text, start: 0 }];
    const out = [];
    for (const span of spans) {
      const start = Number(span && span.start);
      const end = Number(span && span.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      out.push({ text: text.slice(start, end), start: start });
    }
    return out.length ? out : [{ text: text, start: 0 }];
  }

  function pvPageLabel(pageNo) {
    const page = previewPages.find((item) => Number(item.page_no) === pageNo);
    return (page && page.page_label) || `第 ${pageNo} 页`;
  }

  // ---------------------------------------------------------------- 三个面板
  function pvRenderDirectory() {
    const list = pvPart("pv-dir");
    if (!list) return;
    list.innerHTML = "";
    const byPage = new Map();
    for (const segment of previewSegments) {
      const pageNo = pvSegmentPageNo(segment);
      if (pageNo === null) continue;
      if (!byPage.has(pageNo)) byPage.set(pageNo, []);
      byPage.get(pageNo).push(segment);
    }
    if (!byPage.size) {
      const empty = document.createElement("p");
      empty.className = "pv-empty";
      empty.textContent = previewLoading ? "正在组装成品…" : "还没有可预览的正文段。";
      list.append(empty);
      return;
    }
    for (const [pageNo, items] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "pv-dir__page";
      row.dataset.pageNo = String(pageNo);
      row.textContent = `${pvPageLabel(pageNo)} · ${items.length} 段`;
      if (previewCurrentSegmentId && items.some((item) => item.segment_id === previewCurrentSegmentId)) {
        row.classList.add("is-current");
      }
      row.addEventListener("click", () => pvSelectSegment(items[0].segment_id, { scrollPdf: true }));
      list.append(row);
    }
  }

  function pvRenderPdf() {
    const column = pvPart("pv-pdf");
    if (!column) return;
    column.innerHTML = "";
    for (const page of previewPages) {
      const pageNo = Number(page.page_no);
      const box = document.createElement("figure");
      box.className = "pv-page";
      box.dataset.pageNo = String(pageNo);
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      // 页图走 <img>，带不了请求头 ⇒ token 放查询串（与页面视图 / 抽屉同一写法）
      const token = injected.getToken ? injected.getToken() : "";
      img.src = `/api/projects/${previewProjectId}/pages/${pageNo}/image?size=view&token=${encodeURIComponent(token)}`;
      img.alt = pvPageLabel(pageNo);
      const tag = document.createElement("figcaption");
      tag.className = "pv-page__no";
      tag.textContent = pvPageLabel(pageNo);
      box.append(img, tag);
      column.append(box);
    }
  }

  function pvRenderProduct() {
    const list = pvPart("pv-product");
    if (!list) return;
    list.innerHTML = "";
    if (previewLoading) {
      list.textContent = "正在按导出设置组装成品…";
      return;
    }
    if (!previewSegments.length) {
      list.textContent = "这本书还没有可导出的正文段（先识别、再确认版心）。";
      return;
    }
    for (const segment of previewSegments) {
      const card = document.createElement("article");
      card.className = "pv-seg";
      card.dataset.segmentId = segment.segment_id;
      if (segment.segment_id === previewCurrentSegmentId) card.classList.add("is-current");
      card.addEventListener("click", () => pvSelectSegment(segment.segment_id, { scrollPdf: true }));
      for (const line of pvSegmentLines(segment)) {
        const row = document.createElement("p");
        row.className = "pv-seg__line";
        row.textContent = line.text || "（空行）";
        card.append(row);
      }
      list.append(card);
    }
  }

  function pvUpdateChrome() {
    const status = pvPart("preview-status");
    const index = previewSegments.findIndex((item) => item.segment_id === previewCurrentSegmentId);
    const total = previewSegments.length;
    if (status) {
      status.textContent = previewLoading
        ? "正在组装成品…"
        : (index >= 0 ? `第 ${index + 1} / ${total} 段` : `共 ${total} 段`);
    }
    const pending = pvPart("preview-pending");
    if (pending) {
      const count = Number(injected.getPendingCount ? injected.getPendingCount() : 0) || 0;
      pending.textContent = `待提交 ${count} 处`;
    }
    // 第 1 笔只有只读：导出一律灰着，且写明原因（不做一个点了没反应的亮按钮）
    const exportButton = pvPart("preview-export");
    if (exportButton) {
      exportButton.disabled = true;
      exportButton.title = "第 1 笔只有只读预览：导出按钮在后续几笔接上成品提交之后才可用";
    }
  }

  // ---------------------------------------------------------------- 位置
  function pvSelectSegment(segmentId, options) {
    const segment = previewSegments.find((item) => item.segment_id === segmentId);
    if (!segment) return;
    previewCurrentSegmentId = segmentId;
    pvRenderProduct();
    pvRenderDirectory();
    pvUpdateChrome();
    const pageNo = pvSegmentPageNo(segment);
    if (options && options.scrollPdf && pageNo !== null) {
      const target = pvPart("pv-pdf");
      const page = target && target.querySelector(`.pv-page[data-page-no="${pageNo}"]`);
      if (page && page.scrollIntoView) page.scrollIntoView({ block: "start" });
    }
  }

  // ---------------------------------------------------------------- 数据
  async function pvLoad() {
    const seq = ++previewRequestSeq;
    previewLoading = true;
    pvRenderProduct();
    pvUpdateChrome();
    let options = {};
    try {
      options = injected.exportOptions ? injected.exportOptions() : {};
    } catch (error) {
      options = {};
      injected.showError && injected.showError(pvPart("preview-status"), error);
    }
    try {
      const data = await injected.apiJson(
        `/api/projects/${previewProjectId}/export/preview?segments_only=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options),
        }
      );
      if (seq !== previewRequestSeq) return; // 过期响应：别让旧成品盖掉新项目
      previewSegments = (data && data.segments) || [];
      previewSegmentCount = Number(data && data.segment_count);
      if (!previewCurrentSegmentId && previewSegments.length) {
        previewCurrentSegmentId = previewSegments[0].segment_id;
      }
      pvReportCount();
    } catch (error) {
      if (seq !== previewRequestSeq) return;
      previewSegments = [];
      previewSegmentCount = null;
      const list = pvPart("pv-product");
      if (list) list.textContent = `成品加载失败：${(error && error.message) || "未知错误"}`;
    } finally {
      if (seq !== previewRequestSeq) return;
      previewLoading = false;
      pvRenderDirectory();
      pvRenderProduct();
      pvUpdateChrome();
    }
  }

  /** 段数对账：界面上报的段数必须与服务端 `segment_count` 相等（不相等就是少读了一段）。 */
  function pvReportCount() {
    if (previewSegmentCount === null || Number.isNaN(previewSegmentCount)) return;
    if (previewSegmentCount !== previewSegments.length) {
      console.warn(
        `[preview] 段数不一致：服务端 ${previewSegmentCount} / 前端 ${previewSegments.length}`
      );
    }
  }

  function enter() {
    const project = injected.getProject ? injected.getProject() : null;
    const nextId = project ? project.project_id : null;
    previewPages = (project && project.pages) || [];
    if (nextId !== previewProjectId) {
      previewProjectId = nextId;
      previewSegments = [];
      previewSegmentCount = null;
      previewCurrentSegmentId = null;
      pvRenderPdf();
      pvRenderDirectory();
      pvLoad();
      return;
    }
    pvRenderPdf();
    pvRenderDirectory();
    pvRenderProduct();
    pvUpdateChrome();
    // 回来时重取一次：识别 / 改动之后成品会变，界面不能停在旧 payload 上
    pvLoad();
  }

  /** 顶栏两个按钮：返回审校 / 返回（回到进来之前的视图）。只绑一次。 */
  function pvWireChrome() {
    const back = pvPart("preview-back");
    if (back && !back.dataset.pvWired) {
      back.dataset.pvWired = "1";
      back.addEventListener("click", () => injected.goBack && injected.goBack());
    }
    const toReview = pvPart("preview-to-review");
    if (toReview && !toReview.dataset.pvWired) {
      toReview.dataset.pvWired = "1";
      toReview.addEventListener("click", () => injected.goReview && injected.goReview());
    }
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = (deps && deps.root) || root || document.getElementById("view-preview");
    pvWireChrome();
    // 导出选项那一组控件就在本视图的 #pv-options 里：把根交给导出模块（它不自己找，避免跨根取 DOM）
    window.ExportPanel?.init({ optionsRoot: pvPart("pv-options") });
    return api;
  }

  const api = { init, enter };

  window.PreviewView = api;
})();
