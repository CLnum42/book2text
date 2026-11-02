/**
 * 导出面板（服务模块）——`window.ExportPanel`
 *
 * **root = `#export-panel`**（顶层 modal，不是 `#view-merge`）：按真实嵌套量过，那 30 个导出 id
 * 全在这个 mask 子树里，`#view-merge` 子树里是 0 个。形态照 `structure-tools.js`：root 由外壳给，
 * 模块只 `root.querySelector` / `part()`，**不出现 document 级查询**。
 *
 * 状态：5 份纯私有（lastExport / exportPreviewTimer / compareSegments / compareIndex /
 * comparePageBlocks）；外来：currentProject / projectExports / token；常量按值注入：
 * BLOCK_TYPE_LABELS / ApiError。
 *
 * 写盘动作的规矩：每个动作内部"请求 → 读回 → 重画"闭环；外壳只喊 `reload()` / `refreshPreflight()`
 * 各一次，不许在外壳里编排"先预检再历史"。`reload()` 内部顺序固定：先预检、后历史。
 *
 * **临时注入（死期 = 跨视图服务那刀）**：marginJudgementOn / setMarginJudgementSetting /
 * dismissMarginJudgementNotice —— 那三件搬出去之后改成模块导出，这一刀先按外壳注入接。
 */
(function () {
  "use strict";

  let injected = {};
  let root = null;

  const part = (id) => (root ? root.querySelector(`#${id}`) : null);
  const project = () => injected.getCurrentProject();

  // ---------------------------------------------------------------- 本模块自己的 5 份状态
  let lastExport = null;      // 最近一次生成的导出（含记录与 manifest）
  let exportPreviewTimer = null;
  let compareSegments = [];
  let compareIndex = -1;
  /** 来源页的块缓存：翻来翻去对照时不必反复拉同一页。 */
  const comparePageBlocks = new Map();

function exportOptions() {
  const formats = [...root.querySelectorAll('input[name="export-format"]:checked')]
    .map((input) => input.value);
  let format = "txt";
  if (formats.length === 2) format = "both";
  else if (formats.length === 1) format = formats[0];

  const pageTypes = [...root.querySelectorAll('input[name="export-page-type"]:checked')]
    .map((input) => input.value);

  const rangeText = part("export-range").value.trim();
  let pageNumbers = null;
  if (rangeText) {
    const { numbers, invalid } = injected.parsePageRange(rangeText);
    if (invalid.length) throw new injected.ApiError(`看不懂这段页码范围：${invalid.join("、")}`);
    pageNumbers = [...numbers];
  }

  return {
    format,
    confirmed_only: part("export-confirmed-only").checked,
    page_types: pageTypes,
    page_numbers: pageNumbers,
    page_markers: part("export-page-markers").checked,
    include_notes: part("export-include-notes").checked,
    exclude_header_footer: part("export-rule-header").checked,
    merge_lines_in_block: part("export-rule-merge").checked,
    restore_hyphenation: part("export-rule-hyphen").checked,
    normalize_newlines: part("export-rule-newlines").checked,
    strip_line_whitespace: part("export-rule-strip").checked,
  };
}

function preflightRows(data) {
  const streams = data.streams || {};
  const body = streams.body || { segments: data.segment_count || 0, chars: data.char_count || 0 };
  const noteStream = streams.notes || { notes: data.notes_count || 0, chars: data.notes_char_count || 0 };
  const meta = streams.meta || { pages: 0, printed_page_found: 0, printed_page_missing: [] };
  const mapping = data.page_number_mapping || {
    found: meta.printed_page_found || 0,
    total: meta.pages || 0,
    missing_pages: meta.printed_page_missing || [],
  };
  const includeNotes = Boolean((data.rules || {}).include_notes);
  const rows = [
    ["导出页数", `${data.exported_pages.length} 页`],
    ["正文段数", `${body.segments || 0} 段`],
    ["正文字数", `${body.chars || 0} 字`],
    ["注释条数", `${noteStream.notes || 0} 条${includeNotes ? "" : "（未导出）"}`],
    ["注释字数", `${noteStream.chars || 0} 字`],
    ["元数据页数", `${meta.pages || 0} 页`],
    ["页码映射", `${mapping.found || 0} / ${mapping.total || 0} 页`],
    ["跨块合并的段", `${data.merged_segments} 段`],
    ["断词还原", `${data.hyphenations_restored} 处`],
    ["未审校的段", `${data.unreviewed_segments} 段`],
    ["不确定的段", `${data.uncertain_segments} 段`],
    ["正文不收的块类型", data.excluded_block_types.length ? data.excluded_block_types.join("、") : "（无）"],
    ["整页版面确认", `${data.layout_confirmed_pages || 0} / ${data.layout_pages || 0} 页`],
  ];
  const workflowStatus = data.workflow_status || {};
  const preflightMarginPages = data.margin_pages || {};
  const undeterminedMargins = preflightMarginPages.undetermined || [];
  if (undeterminedMargins.length) {
    rows.push([
      "版心未定",
      `${undeterminedMargins.length} 页（还没有拟合框；不参与「按版心判定」，也不会拿默认版心顶替）`,
    ]);
  }
  if (workflowStatus.total) {
    rows.push([
      "工作流状态",
      `人工已确认 ${workflowStatus.human_confirmed || 0}` +
        ` · 自动通过 ${workflowStatus.auto_passed || 0}` +
        ` · 单引擎未复核 ${workflowStatus.single_engine || 0}` +
        ` · 版面未确认 ${workflowStatus.layout_unconfirmed || 0}` +
        ` · 识别失败 ${workflowStatus.recognition_failed || 0}`,
    ]);
  }
  if (data.margin_judgement) {
    const marginBlocks = data.margin_blocks || {};
    const marginNotes = data.margin_notes || {};
    const marginPages = data.margin_pages || {};
    const marginNumbers = data.margin_page_numbers || {};
    const excludedByType = marginBlocks.excluded_by_type || {};
    const excludedText = Object.entries(excludedByType)
      .map(([type, count]) => `${injected.BLOCK_TYPE_LABELS[type] || type} ${count}`)
      .join(" / ");
    rows.push([
      "版心判定",
      `内 ${marginBlocks.inside || 0} 块 · 外 ${marginBlocks.outside || 0} 块` +
        ` · 脚注/旁批 ${marginNotes.total || 0} 块（其中 ${marginNotes.inside || 0} 块在版心内）` +
        ` · 页码 ${marginNumbers.pages || 0} 页 · 未确认版心 ${(marginPages.unset || []).length} 页`,
    ]);
    rows.push([
      "版心外被排除",
      `${marginBlocks.excluded || 0} 块` + (excludedText ? `（${excludedText}）` : ""),
    ]);
  }
  return rows;
}

function preflightNotes(data) {

  const notes = [];
  if (!data.segment_count && !(noteStream.notes || 0)) {
    notes.push("按当前设置没有内容可以导出——检查页面类型、范围与「仅已确认」。");
  }
  if (mapping.total && (mapping.missing_pages || []).length) {
    const missing = mapping.missing_pages.slice(0, 12).join("、");
    const more = mapping.missing_pages.length > 12 ? " 等" : "";
    notes.push(
      `有 ${mapping.missing_pages.length} 页抽不到印刷页码（${missing}${more}）——` +
        "meta.json 里这些页的 printed_page 是 null，不拿 PDF 页号冒充。"
    );
  }
  if (!includeNotes) {
    notes.push("注释流默认不导出；勾选「同时导出注释」才会生成 notes.txt / notes.jsonl。");
  } else if (!(noteStream.notes || 0)) {
    notes.push("注释流为空（没有脚注 / 旁批块）——这是正常情况。");
  }
  if (undeterminedMargins.length) {
    const shown = undeterminedMargins.slice(0, 12).join("、");
    const more = undeterminedMargins.length > 12 ? " 等" : "";
    notes.push(
      `有 ${undeterminedMargins.length} 页版心未定（${shown}${more}）——这些页还没有可用的拟合框，` +
        "按版心判定时会跳过、不拿默认版心顶替。先跑「检测并定版心」再导出更稳妥。"
    );
  }
  if (data.margin_judgement) {
    const marginPages = data.margin_pages || {};
    const unsetPages = marginPages.unset || [];
    notes.push(
      `按版心判定已开启：版心外 ${data.margin_blocks?.outside || 0} 块不进正文，` +
        "书眉不写进 meta.json。"
    );
    if (marginPages.auto) {
      notes.push(
        "默认版心是自动推算、还没确认：只有显式「沿用全局」的页会用到它；" +
          "「每页自动拟合」的页读自己的框。想固定全局版心，在页面视图点「采用为默认版心」。"
      );
    }
    if (unsetPages.length) {
      const shown = unsetPages.slice(0, 12).join("、");
      const more = unsetPages.length > 12 ? " 等" : "";
      notes.push(
        `有 ${unsetPages.length} 页没有生效版心（${shown}${more}），已退回块类型判定；` +
          "这些页的书眉 / 页码仍可能进正文。"
      );
    }
  }
  if (data.unfinished_pages && data.unfinished_pages.length) {
    const shown = data.unfinished_pages.slice(0, 12).join("、");
    const more = data.unfinished_pages.length > 12 ? " 等" : "";
    notes.push(
      `有 ${data.unfinished_pages.length} 个导出页还没识别或识别失败（${shown}${more}），` +
        "导出的内容会缺这些页。"
    );
  }
  if (data.dropped_pages && data.dropped_pages.length) {
    notes.push(`按当前类型 / 范围过滤掉 ${data.dropped_pages.length} 页。`);
  }
  if (data.chrome_suspect_count && !data.margin_judgement) {
    const sample = (data.chrome_suspects || [])
      .slice(0, 3)
      .map((item) => `第 ${item.page_no} 页「${item.text.slice(0, 10)}」`)
      .join("、");
    notes.push(
      `有 ${data.chrome_suspect_count} 个块整块落在页面边缘（${sample} 等），` +
        "像是页眉 / 页码，但它们的类型还是「段落」，**会被导出**。" +
        "用上面的「结构工具」按位置规则预览并标注，就能把它们从导出里去掉。"
    );
  }
  if (data.layout_unconfirmed_pages && data.layout_unconfirmed_pages.length) {
    const shown = data.layout_unconfirmed_pages.slice(0, 12).join("、");
    const more = data.layout_unconfirmed_pages.length > 12 ? " 等" : "";
    notes.push(
      `还有 ${data.layout_unconfirmed_pages.length} 页版面未确认（${shown}${more}），` +
        "正文可能夹带页眉 / 页码 / 旁批；**导出不受影响**。" +
        "在审校视图点「确认本页版面」即可，改了块类型 / 框 / 顺序会自动回到未确认。"
    );
  }
  if (data.unreviewed_segments) {
    notes.push(
      `有 ${data.unreviewed_segments} 段还没审校——导出的是当前文本，` +
        "未审校的内容也在里面（要只导已确认的，勾上「仅已确认」）。"
    );
  }
  if (workflowStatus.auto_passed) {
    notes.push(
      `有 ${workflowStatus.auto_passed} 页是「自动通过（未经人工）」——` +
        "它们满足自动条件但没有人逐页确认；manifest.json 里记了这组状态快照。"
    );
  }
  if (workflowStatus.single_engine) {
    notes.push(
      `有 ${workflowStatus.single_engine} 页只有单引擎结果、没跑第二引擎复核。`
    );
  }
  return notes;
}

function renderPreflight(data) {
  injected.fillDefinitionList(part("export-preflight"), preflightRows(data));
  const notes = preflightNotes(data);
  const warning = part("export-note");
  warning.textContent = notes.join(" ");
  warning.hidden = notes.length === 0;
}

async function refreshPreflight() {
  if (!project()) return;
  let options;
  try {
    options = exportOptions();
  } catch (error) {
    injected.showError(part("export-error"), error);
    return;
  }
  part("export-error").hidden = true;
  part("export-scope").textContent = exportScopeText(options);
  try {
    const data = await injected.apiJson(`/api/projects/${project().project_id}/export/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    renderPreflight(data);
  } catch (error) {
    injected.showError(part("export-error"), error);
  }
}

function exportScopeText(options) {
  const format = { txt: "TXT", jsonl: "JSONL", both: "TXT + JSONL" }[options.format] || options.format;
  const parts = [format];
  if (options.page_numbers && options.page_numbers.length) {
    parts.push(`第 ${options.page_numbers[0]}–${options.page_numbers[options.page_numbers.length - 1]} 页（${options.page_numbers.length} 页）`);
  } else {
    parts.push("全书");
  }
  if (options.confirmed_only) parts.push("仅已确认");
  if (options.include_notes) parts.push("含注释");
  if (injected.marginJudgementOn()) {
    parts.push("按版心判定正文");
  }
  return parts.join(" · ");
}

async function loadExportPreview(options) {
  try {
    const data = await injected.apiJson(`/api/projects/${project().project_id}/export/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    renderCompare(data);
  } catch (error) {
    injected.showError(part("export-error"), error);
  }
}

function renderCompare(data) {
  compareSegments = data.segments || [];
  comparePageBlocks.clear();
  part("export-compare").hidden = false;
  part("compare-meta").textContent =
    `${compareSegments.length} 段 · ${data.preflight.char_count} 字 · ` +
    `${data.preflight.page_count} 页（按当前导出设置）`;

  const list = part("compare-segments");
  list.innerHTML = "";
  compareSegments.forEach((segment, index) => {
    const item = document.createElement("li");
    item.dataset.index = String(index);
    item.dataset.segmentId = segment.segment_id;

    const head = document.createElement("div");
    head.className = "compare__seg-head";
    const pages = (segment.pages || []).map((page) => `p.${page.page_no}`).join(",");
    const state = segment.all_confirmed
      ? "已确认"
      : segment.uncertain
      ? "不确定"
      : segment.unreviewed
      ? "未审"
      : "已确认";
    const extra = [
      `#${segment.seq}`,
      pages,
      segment.type === "heading" ? "标题" : "",
      state,
      segment.text !== (segment.ocr_text ?? segment.text) && segment.modified ? "已修改" : "",
      (segment.block_ids || []).length > 1 ? `${segment.block_ids.length} 块合并` : "",
    ].filter(Boolean);
    head.textContent = extra.join(" · ");

    const body = document.createElement("div");
    body.textContent = segment.text || "（空段）";

    item.append(head, body);
    item.addEventListener("click", () => selectSegment(index));
    list.append(item);
  });

  if (!compareSegments.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "按当前导出设置没有内容可以导出。";
    list.append(empty);
    return;
  }
  selectSegment(0);
}

async function selectSegment(index) {
  if (index < 0 || index >= compareSegments.length) return;
  compareIndex = index;
  for (const item of part("compare-segments").children) {
    const isCurrent = Number(item.dataset.index) === index;
    item.classList.toggle("is-current", isCurrent);
    if (isCurrent) item.scrollIntoView({ block: "nearest" });
  }

  const segment = compareSegments[index];
  const pageNo = (segment.pages && segment.pages[0] && segment.pages[0].page_no) || null;
  if (!pageNo) return;

  const blocks = await loadComparePage(pageNo);
  const sourceIds = new Set(segment.block_ids || []);
  drawCompareOverlay(blocks, sourceIds);
  part("compare-image-status").hidden = true;
}

async function loadComparePage(pageNo) {
  const projectId = project().project_id;
  if (!comparePageBlocks.has(pageNo)) {
    const data = await injected.apiJson(`/api/projects/${projectId}/pages/${pageNo}/blocks`);
    comparePageBlocks.set(pageNo, data.blocks || []);
  }
  const image = part("compare-image");
  const wanted = `/api/projects/${projectId}/pages/${pageNo}/image?size=view&token=${encodeURIComponent(injected.getToken())}`;
  if (image.dataset.pageNo !== String(pageNo)) {
    image.dataset.pageNo = String(pageNo);
    part("compare-image-status").textContent = "正在渲染来源页…";
    part("compare-image-status").hidden = false;
    part("compare-canvas").hidden = true;
    image.onload = () => {
      part("compare-image-status").hidden = true;
      part("compare-canvas").hidden = false;
    };
    image.onerror = () => {
      part("compare-image-status").textContent = "来源页渲染失败。";   // 先给固定文案：不留空白
    };
    // detail 迟到替换（同一个出口；取不到就保留上面那句）
    injected.attachRenderErrorDetail?.(image, {
      write: (text) => { part("compare-image-status").textContent = text; },
      fallback: "来源页渲染失败。",
    });
    image.src = wanted;
  }
  return comparePageBlocks.get(pageNo);
}

function drawCompareOverlay(blocks, sourceIds) {
  const overlay = part("compare-overlay");
  overlay.innerHTML = "";
  blocks.forEach((block) => {
    if (!block.bbox) return;
    const isSource = sourceIds.has(block.block_id);
    const [x0, y0, x1, y1] = block.bbox;
    const box = document.createElement("div");
    box.className = "box" + (isSource ? " box--source" : " box--dim");
    box.dataset.blockId = block.block_id;
    box.style.left = `${x0 * 100}%`;
    box.style.top = `${y0 * 100}%`;
    box.style.width = `${(x1 - x0) * 100}%`;
    box.style.height = `${(y1 - y0) * 100}%`;
    box.title = isSource ? "这一段来自这个块" : "本页的其它块";
    overlay.append(box);
  });
}

function schedulePreflight() {
  // 选项一变，对照面板里已有的分段就不再对应当前设置，先收起来避免误读
  part("export-compare").hidden = true;
  if (exportPreviewTimer) clearTimeout(exportPreviewTimer);
  exportPreviewTimer = setTimeout(() => refreshPreflight(), 350);
}

async function runExport() {
  if (!project()) return;
  part("export-error").hidden = true;
  let options;
  try {
    options = exportOptions();
  } catch (error) {
    injected.showError(part("export-error"), error);
    return;
  }
  try {
    const data = await injected.apiJson(`/api/projects/${project().project_id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    lastExport = data;
    renderExportRecord(data.record, data.files);
    await loadExports();
  } catch (error) {
    injected.showError(part("export-error"), error);
  }
}

function renderExportRecord(record, files = []) {
  part("export-result").hidden = false;
  part("export-result-meta").textContent =
    `${record.export_id} · ${record.segment_count} 段 · ${record.char_count} 字 · ` +
    `未审 ${record.unreviewed_count} 段 · ${record.created_at.slice(0, 16).replace("T", " ")}`;

  const list = part("export-files");
  list.innerHTML = "";
  for (const name of files.length ? files : record.file_paths) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = name;
    const download = document.createElement("a");
    download.href =
      `/api/projects/${project().project_id}/exports/${record.export_id}/download` +
      `?file=${encodeURIComponent(name)}&token=${encodeURIComponent(injected.getToken())}`;
    download.textContent = "下载";
    download.className = "btn btn--ghost";
    item.append(label, download);
    list.append(item);
  }
}

async function loadExports() {
  if (!project()) return;
  try {
    const data = await injected.apiJson(`/api/projects/${project().project_id}/exports`);
    injected.setProjectExports(data.exports || []);
    renderExportHistory(injected.getProjectExports());
    injected.syncWorkflowSteps();
  } catch (error) {
    injected.showError(part("export-error"), error);
  }
}

function renderExportHistory(records) {
  const list = part("export-history");
  list.innerHTML = "";
  part("export-history-empty").hidden = records.length > 0;
  for (const record of records) {
    const item = document.createElement("li");
    if (lastExport && lastExport.record.export_id === record.export_id) {
      item.classList.add("is-latest");
    }
    const text = document.createElement("span");
    text.textContent =
      `${record.created_at.slice(0, 16).replace("T", " ")} · ${record.format} · ` +
      `${record.segment_count} 段 · ${record.char_count} 字 · 未审 ${record.unreviewed_count} 段`;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn btn--ghost";
    open.textContent = "查看";
    open.addEventListener("click", () => renderExportRecord(record));
    item.append(text, open);
    list.append(item);
  }
}

async function revealExport(exportId) {
  try {
    await injected.apiJson(
      `/api/projects/${project().project_id}/exports/${exportId}/reveal`,
      { method: "POST" }
    );
  } catch (error) {
    injected.showError(part("export-error"), error);
  }
}

function setupPanel() {
  for (const input of root.querySelectorAll(
    'input[name="export-format"], input[name="export-page-type"], #export-confirmed-only,' +
      " #export-page-markers, #export-include-notes," +
      " #export-rule-header, #export-rule-merge, #export-rule-hyphen," +
      " #export-rule-newlines, #export-rule-strip"
  )) {
    input.addEventListener("change", schedulePreflight);
  }
  part("export-range").addEventListener("input", schedulePreflight);
  part("export-margin-judgement").addEventListener("change", (event) =>
    injected.setMarginJudgementSetting(event.target.checked)
  );
  // 这个节点在 chrome（#export-panel 子树外）⇒ 只能注入
  const marginNoticeOk = injected.getMarginJudgementOk();
  if (marginNoticeOk) {
    marginNoticeOk.addEventListener("click", injected.dismissMarginJudgementNotice);
  }
  part("export-btn").addEventListener("click", runExport);
  part("export-preview-btn").addEventListener("click", async () => {
    try {
      await loadExportPreview(exportOptions());
    } catch (error) {
      injected.showError(part("export-error"), error);
    }
  });
  part("compare-close").addEventListener("click", () => {
    part("export-compare").hidden = true;
  });
  part("export-reveal-btn").addEventListener("click", () => {
    if (lastExport) revealExport(lastExport.record.export_id);
  });
}

  /** 面板打开 / 重新进入导出步骤时用：先预检、后历史（顺序在模块里，外壳只喊一次）。 */
  async function reload() {
    await refreshPreflight();
    await loadExports();
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || null;
    return api;
  }

  const api = {
    init,
    setupPanel,
    refreshPreflight,
    reload,
    // 视图侧的两个真调用点（preview-view / reading-view 要当前勾选）
    exportOptions,
  };
  window.ExportPanel = api;
})();
