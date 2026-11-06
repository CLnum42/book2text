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

  /** 这一行在段里对应的来源行（block_id / line_index）；找不到就是派生行（只读）。 */
  function pvLineSpan(segment, start) {
    const spans = Array.isArray(segment && segment.line_spans) ? segment.line_spans : [];
    return spans.find((item) => Number(item && item.start) === Number(start)) || null;
  }

  function pvDraftKey(blockId, lineIndex) {
    return `${blockId}#${lineIndex}`;
  }

  function pvPendingCount() {
    return injected.pvState ? injected.pvState.size : 0;
  }

  /** 点一行进编辑：contenteditable，失焦/Enter 收草稿；Enter 直接提交这一处。 */
  function pvStartEdit(row, span, key) {
    const state = injected.pvState;
    if (!state) return;
    // 上一次编辑没收尾（例如元素被重画掉了）不留锁：新点的一行直接接手
    state.editingKey = key;
    row.contentEditable = "true";
    row.classList.add("is-editing");
    row.focus();
    const range = document.createRange();
    range.selectNodeContents(row);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    // 三种收尾：Enter = 收成草稿并**立刻提交这一处**；失焦 = 收成草稿（待提交）；
    // Esc = 丢弃这次输入。草稿是页内内存态，顶栏计数与离开守卫都读它。
    const finish = async (mode) => {
      if (state.editingKey !== key) return;
      const text = row.textContent || "";
      state.editingKey = null;
      row.contentEditable = "false";
      row.classList.remove("is-editing");
      if (mode === "cancel") {
        pvRenderProduct();
        pvUpdateChrome();
        return;
      }
      state.set(key, text);
      pvRenderProduct();
      pvUpdateChrome();
      if (mode === "commit") {
        await pvSubmitDrafts([{ blockId: span.block_id, lineIndex: Number(span.line_index), text }]);
      }
    };

    // 只要改过就是草稿：不依赖 blur（焦点没落上时 blur 根本不触发，实测会静默丢草稿）
    row.addEventListener("input", () => {
      const state = injected.pvState;
      if (!state || state.editingKey !== key) return;
      state.set(key, row.textContent || "");
      pvUpdateFoot();
      const topPending = pvPart("preview-pending");
      if (topPending) topPending.textContent = `待提交 ${state.size} 处`;
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    row.addEventListener("blur", () => { finish("draft"); }, { once: true });
  }

  /** 一次 batch 提交（第 2 笔只有一处；第 3 笔会传多行）。 */
  async function pvSubmitDrafts(items) {
    if (!items.length) return { ok: 0, failed: 0 };
    const state = injected.pvState;
    try {
      await injected.apiJson(`/api/projects/${previewProjectId}/review/submit-drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((item) => ({
            block_id: item.blockId,
            line_index: item.lineIndex,
            new_line_text: item.text,
          })),
        }),
      });
      for (const item of items) state.delete(pvDraftKey(item.blockId, item.lineIndex));
      pvUpdateChrome();
      await pvLoad();   // 成品变了：重取，不拿旧 payload
      return { ok: items.length, failed: 0 };
    } catch (error) {
      injected.showError && injected.showError(pvPart("preview-status"), error);
      return { ok: 0, failed: items.length };
    }
  }

  /** 有未提交时离开的守卫：提交并离开 / 放弃修改 / 留在这里（Esc 也是留下）。 */
  function pvGuardLeave(proceed) {
    const count = pvPendingCount();
    if (!count) { proceed(); return; }
    injected.confirmLeave && injected.confirmLeave(count, {
      onCommit: async () => {
        const state = injected.pvState;
        const items = [...state.entries()].map(([key, text]) => {
          const [blockId, lineIndex] = key.split("#");
          return { blockId, lineIndex: Number(lineIndex), text };
        });
        await pvSubmitDrafts(items);
        proceed();
      },
      onDiscard: () => {
        injected.pvState.clear();
        pvRenderProduct();
        pvUpdateChrome();
        proceed();
      },
    });
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
    if (injected.pvState) injected.pvState.editingKey = null;
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
        const span = pvLineSpan(segment, line.start);
        if (span) {
          row.dataset.blockId = span.block_id;
          row.dataset.lineIndex = String(span.line_index);
          const key = pvDraftKey(span.block_id, span.line_index);
          const draft = injected.pvState && injected.pvState.get(key);
          row.textContent = (draft !== undefined ? draft : line.text) || "（空行）";
          if (draft !== undefined) row.classList.add("is-pending");
          if (injected.pvState && injected.pvState.multi && injected.pvState.selected.has(key)) {
            row.classList.add("is-selected");
          }
          row.title = "点这一行改字；Enter 提交这一处";
          row.addEventListener("click", (event) => {
            event.stopPropagation();
            const state = injected.pvState;
            if (state.multi) {
              if (state.selected.has(key)) state.selected.delete(key);
              else state.selected.add(key);
              row.classList.toggle("is-selected", state.selected.has(key));
              pvUpdateChrome();
              return;
            }
            pvStartEdit(row, span, key);
          });
        } else {
          // 没有行区间（跨块拼接处的派生行）：只读，不假装能改
          row.textContent = line.text || "（空行）";
          row.classList.add("pv-seg__line--readonly");
        }
        card.append(row);
      }
      list.append(card);
    }
  }

  function pvUpdateFoot() {
    const foot = root && root.querySelector(".pv-foot");
    if (!foot) return;
    const state = injected.pvState || {};
    const count = pvPendingCount();
    const selectedPending = state.selected
      ? [...state.selected].filter((key) => state.has(key)).length
      : 0;
    const status = foot.querySelector(".pv-foot__status");
    if (status) {
      status.textContent = state.multi
        ? `已选 ${state.selected ? state.selected.size : 0} 行，其中 ${selectedPending} 处待提交`
        : `待提交 ${count} 处`;
    }
    const multi = foot.querySelector(".pv-foot__multi");
    if (multi) multi.textContent = state.multi ? "退出多选" : "多选";
    const submit = foot.querySelector(".pv-foot__submit");
    if (submit) {
      const ready = state.multi ? selectedPending : count;
      submit.textContent = ready ? `提交这 ${ready} 处` : "全部提交";
      submit.disabled = !ready;
    }
    const discard = foot.querySelector(".pv-foot__discard");
    if (discard) discard.disabled = !count;
  }

  function pvUpdateChrome() {
    pvUpdateFoot();
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
      const count = pvPendingCount();
      pending.textContent = count ? `待提交 ${count} 处` : "待提交 0 处";
      pending.classList.toggle("is-hot", count > 0);
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

  /** 底栏（§12.4）：待提交数 · 多选 · 放弃 · 全部提交 · 撤销这一批。动态建，不占 index.html 的 id。 */
  function pvBuildFoot() {
    if (!root || root.querySelector(".pv-foot")) return;
    const foot = document.createElement("div");
    foot.className = "pv-foot";
    const status = document.createElement("span");
    status.className = "pv-foot__status muted";
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const multi = document.createElement("button");
    multi.type = "button";
    multi.className = "btn btn--sm pv-foot__multi";
    multi.textContent = "多选";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "btn btn--sm pv-foot__discard";
    discard.textContent = "放弃";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn btn--sm pv-foot__submit";
    submit.textContent = "全部提交";
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "btn btn--sm pv-foot__undo";
    undo.textContent = "撤销这一批";
    undo.hidden = true;
    foot.append(status, spacer, multi, discard, submit, undo);
    root.append(foot);

    multi.addEventListener("click", () => {
      const state = injected.pvState;
      state.multi = !state.multi;
      if (!state.multi) state.selected = new Set();
      pvRenderProduct();
      pvUpdateChrome();
    });
    discard.addEventListener("click", () => {
      const state = injected.pvState;
      state.clear();
      state.selected = new Set();
      pvRenderProduct();
      pvUpdateChrome();
    });
    submit.addEventListener("click", () => pvSubmitSelected());
    undo.addEventListener("click", () => pvUndoBatch());
  }

  /** 提交：多选模式下只提交选中的草稿，否则提交全部；一个 batch，撤销一次全退。 */
  async function pvSubmitSelected() {
    const state = injected.pvState;
    const entries = [...state.entries()].filter(([key]) => !state.multi || state.selected.has(key));
    if (!entries.length) return;
    const items = entries.map(([key, text]) => {
      const [blockId, lineIndex] = key.split("#");
      return { blockId, lineIndex: Number(lineIndex), text };
    });
    const result = await pvSubmitDrafts(items);
    if (result && result.ok) {
      state.selected = new Set();
      const undo = root && root.querySelector(".pv-foot__undo");
      if (undo) undo.hidden = false;
    }
  }

  /** 撤销这一批：/undo 按 batch 全退（提交时的 batch 就是撤销单位）。 */
  async function pvUndoBatch() {
    try {
      await injected.apiJson(`/api/projects/${previewProjectId}/undo`, { method: "POST" });
      const undo = root && root.querySelector(".pv-foot__undo");
      if (undo) undo.hidden = true;
      await pvLoad();
    } catch (error) {
      injected.showError && injected.showError(pvPart("preview-status"), error);
    }
  }

  /** 顶栏两个按钮：返回审校 / 返回（回到进来之前的视图）。只绑一次。 */
  function pvWireChrome() {
    const back = pvPart("preview-back");
    if (back && !back.dataset.pvWired) {
      back.dataset.pvWired = "1";
      back.addEventListener("click", () => pvGuardLeave(() => injected.goBack && injected.goBack()));
    }
    const toReview = pvPart("preview-to-review");
    if (toReview && !toReview.dataset.pvWired) {
      toReview.dataset.pvWired = "1";
      toReview.addEventListener("click", () => pvGuardLeave(() => injected.goReview && injected.goReview()));
    }
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = (deps && deps.root) || root || document.getElementById("view-preview");
    if (!injected.pvState) injected.pvState = new Map();
    if (!injected.pvState.selected) injected.pvState.selected = new Set();
    if (injected.pvState.multi === undefined) injected.pvState.multi = false;
    pvBuildFoot();
    window.addEventListener("beforeunload", pvBeforeUnload);
    pvWireChrome();
    // 导出选项那一组控件就在本视图的 #pv-options 里：把根交给导出模块（它不自己找，避免跨根取 DOM）
    window.ExportPanel?.init({ optionsRoot: pvPart("pv-options") });
    return api;
  }

  /** 浏览器级守卫：有草稿时 beforeunload 拦一次（页面内切视图由两个按钮负责）。 */
  function pvBeforeUnload(event) {
    if (!pvPendingCount()) return;
    event.preventDefault();
    event.returnValue = "有未提交的修改，离开会丢失";
  }

  const api = { init, enter };

  window.PreviewView = api;
})();
