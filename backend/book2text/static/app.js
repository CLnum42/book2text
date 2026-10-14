"use strict";

/**
 * Book2Text Phase 0 骨架的前端。
 *
 * 没有任何框架与构建步骤：说明书 Phase 0 第 4 项只要求「一个静态页面」，
 * 正式前端（Vue 3 + TS + Vite）属于 Phase 1 及以后。
 *
 * 令牌从 URL 查询参数取得，之后放进请求头（说明书 4.4）。
 * 图像接口也走 fetch 而不是 <img src>，因为 <img> 无法携带自定义请求头。
 */

const TOKEN_HEADER = "X-B2T-Token";
const token = new URLSearchParams(location.search).get("token") || "";

/** 后端返回的统一错误格式（说明书第 11 节）。 */
class ApiError extends Error {
  constructor(message, code, correlationId, detail) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.correlationId = correlationId;
    this.detail = detail;
  }
}

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 通信

async function apiFetch(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), [TOKEN_HEADER]: token },
  });
}

async function apiJson(path, options = {}) {
  const response = await apiFetch(path, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (payload && payload.error) || {};
    throw new ApiError(
      error.message || `请求失败（HTTP ${response.status}）`,
      error.code,
      error.correlation_id,
      error.detail
    );
  }
  return payload;
}

// ---------------------------------------------------------------- 工具

function humanBytes(size) {
  if (typeof size !== "number") return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function showError(element, error) {
  const parts = [error.message || String(error)];
  if (error.correlationId) {
    parts.push(`<code>错误编号 ${error.correlationId}</code>`);
  }
  if (error.detail) {
    parts.push(`<code>${escapeHtml(error.detail)}</code>`);
  }
  element.innerHTML = parts.join(" ");
  element.hidden = false;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function fillDefinitionList(node, pairs) {
  node.innerHTML = "";
  for (const [label, value] of pairs) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    node.append(dt, dd);
  }
}

// ---------------------------------------------------------------- 应用信息

async function loadAppInfo() {
  let info;
  try {
    info = await apiJson("/api/app/info");
  } catch (error) {
    showError(el("platform-warning"), error);
    return;
  }

  el("stage-tag").textContent = info.app.stage;
  el("version-label").textContent = `版本 ${info.app.version}`;

  const badge = el("platform-badge");
  badge.textContent = info.platform.supported
    ? `${info.platform.label} · 受支持`
    : `${info.platform.label} · 不受支持`;
  badge.className = `badge ${info.platform.supported ? "badge--ok" : "badge--bad"}`;

  if (!info.platform.supported) {
    const warning = el("platform-warning");
    warning.textContent = `当前平台不受支持：${info.platform.unsupported_reason}。可以继续查看界面，但识别与渲染行为未在此平台验证过。`;
    warning.hidden = false;
  }

  renderEngines(info.engines);
  renderLimits(info);
  renderSettings(info);
  renderFirstRun(info);
}

/** 设置（说明书 Phase 6）：我的名字 + 导出诊断日志。 */
function renderSettings(info) {
  const settings = info.settings || {};
  el("settings-name").value = settings.user_name || "";
  el("settings-note").textContent = settings.user_name
    ? `现在以「${settings.user_name}」的名义记录改动。诊断日志用于求助时贴给别人看（不含识别文本与个人目录路径）。`
    : "还没填名字：改动会记成「未署名」。名字保存在项目库目录下的 .settings.json。";
}

async function saveSettingsName() {
  try {
    const data = await apiJson("/api/app/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_name: el("settings-name").value }),
    });
    el("first-run-card").hidden = true;
    await loadAppInfo();
    setSaveState(data.user_name ? `已记下名字：${data.user_name}` : "已清空名字");
  } catch (error) {
    showError(el("platform-warning"), error);
  }
}

/** 首次运行的环境检查（说明书 Phase 6）：平台、PDF 后端、引擎，然后请用户填名字。 */
function renderFirstRun(info) {
  const settings = info.settings || {};
  el("first-run-card").hidden = !settings.first_run;
  if (!settings.first_run) return;

  const checks = [
    [`平台：${info.platform.label}`, info.platform.supported ? "受支持" : `不受支持——${info.platform.unsupported_reason}`],
    [`PDF 后端：pypdfium2 ${info.pdf_backend.version}`, "可用"],
    [`OCR 引擎：${info.engines.available_count} / ${info.engines.total_count} 项可用`,
      info.engines.available_count ? "可以开始识别" : "都不可用：装好依赖再识别（uv sync --group ocr-eval）"],
  ];
  const list = el("first-run-checks");
  list.innerHTML = "";
  for (const [what, state] of checks) {
    const item = document.createElement("li");
    item.textContent = `${what} —— ${state}`;
    list.append(item);
  }
  el("first-run-name").value = settings.user_name || "";
}

function renderEngines(report) {
  const roleLabels = {
    primary: "第一引擎（文本主识别）",
    layout: "版面组件（可选）",
    secondary: "第二引擎（独立血统）",
  };

  el("engine-summary").textContent =
    `${report.total_count} 项中 ${report.available_count} 项可用。${report.note}`;

  const tbody = el("engine-table").querySelector("tbody");
  tbody.innerHTML = "";

  for (const probe of report.probes) {
    const row = document.createElement("tr");

    const role = document.createElement("td");
    role.className = "role";
    role.textContent = roleLabels[probe.role] || probe.role;

    const label = document.createElement("td");
    label.textContent = probe.label;

    const status = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `status ${probe.available ? "status--ok" : "status--bad"}`;
    pill.textContent = probe.available ? "可用" : "不可用";
    status.append(pill);

    const version = document.createElement("td");
    version.textContent = probe.version || "—";

    const note = document.createElement("td");
    note.textContent = probe.reason || probe.note || "";

    row.append(role, label, status, version, note);
    tbody.append(row);
  }
}

function renderLimits(info) {
  const list = el("limits-list");
  list.innerHTML = "";
  for (const text of info.limits) {
    const item = document.createElement("li");
    item.textContent = text;
    list.append(item);
  }

  fillDefinitionList(el("env-meta"), [
    ["PDF 后端", `${info.pdf_backend.name} ${info.pdf_backend.version}${info.pdf_backend.selected ? "" : "（暂用，选型未定）"}`],
    ["Python", info.platform.python_version],
    ["操作系统", info.platform.os_version],
  ]);
}

/** 导出诊断日志（说明书 Phase 6）：下载一份脱敏的纯文本报告。 */
async function exportDiagnostics() {
  const button = el("diagnostics-export");
  button.disabled = true;
  try {
    const response = await fetch(`/api/app/diagnostics?token=${encodeURIComponent(token)}`, {
      headers: { "X-B2T-Token": token },
    });
    if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const name = match ? match[1] : "book2text-diagnostics.txt";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    el("settings-note").textContent = `已导出 ${name}（只下载到本机，不会上传）。`;
  } catch (error) {
    showError(el("platform-warning"), error);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- 第二引擎复核（说明书 8.5）

let auxData = null;

async function runAuxiliary() {
  if (!currentProject || detailPageNo === null) return;
  const pageNo = detailPageNo;
  el("page-detail-error").hidden = true;
  setSaveState("第二引擎复核中…");
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${pageNo}/auxiliary`,
      { method: "POST" }
    );
    auxData = data;
    setSaveState("复核完成");
    renderAuxiliary(data);
    await loadPageDetail(pageNo);
  } catch (error) {
    if (error.code === "secondary_engine_unavailable") {
      showError(el("page-detail-error"), error);
      setSaveState("第二引擎不可用", true);
      return;
    }
    showError(el("page-detail-error"), error);
    setSaveState("复核失败", true);
  }
}

function renderAuxiliary(data) {
  el("aux-panel").hidden = false;
  el("aux-summary").textContent =
    `${data.engine_id} ${data.engine_version} · ${data.line_count} 行 · ` +
    `一致 ${data.identical} / 仅格式 ${data.format_only_differs} / 有分歧 ${data.differs} · ` +
    `${data.elapsed_seconds} 秒`;
  el("aux-hint").textContent =
    "第二引擎按第一引擎切出的行图逐行复核。实测它比第一引擎弱" +
    "（中文正文 CER 2.16% vs 1.08%），候选只作参考——" +
    "块里已按等级逐行标出（汉字级 / 标点级），点「换成这一路」把那一行换过去（可撤销）。";

  const list = el("aux-lines");
  list.innerHTML = "";
  const differing = (data.differences || []).filter((item) => item.diff_status === "differs");
  if (!differing.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent =
      data.differences && data.differences.length
        ? "没有实质分歧（只有格式差异）。"
        : "这一页两路完全一致。";
    list.append(empty);
    return;
  }
  for (const item of differing) {
    const li = document.createElement("li");
    const pair = document.createElement("div");
    pair.className = "aux-pair";
    const a = document.createElement("div");
    a.className = "aux-a";
    a.textContent = `第一引擎：${item.text || "（空）"}`;
    const b = document.createElement("div");
    b.className = "aux-b";
    b.textContent = `第二引擎：${item.aux_text || "（没读出来）"}`;
    pair.append(a, b);

    const actions = document.createElement("div");
    actions.className = "aux-actions";
    const adopt = document.createElement("button");
    adopt.type = "button";
    adopt.className = "btn btn--ghost";
    adopt.textContent = "采用这一路";
    adopt.title = "把这一行换成第二引擎的文本（一次普通编辑，可撤销）";
    const block = (data.blocks || []).find((item2) => item2.block_id === item.block_id);
    adopt.addEventListener("click", () => adoptLine(block, item.line_index, item.aux_text));
    actions.append(adopt);

    li.append(pair, actions);
    list.append(li);
  }
}

function setupAuxControls() {
  el("aux-run").addEventListener("click", runAuxiliary);
  el("aux-close").addEventListener("click", () => {
    el("aux-panel").hidden = true;
  });
}

// ---------------------------------------------------------------- 结构工具（页眉 / 页脚 / 页码）

let structureCandidates = [];      // 预览结果（含用户逐个取消的状态）

function structureRules() {
  return {
    top_ratio: Number(el("structure-top").value || 0) / 100,
    bottom_ratio: Number(el("structure-bottom").value || 0) / 100,
    left_ratio: Number(el("structure-left").value || 0) / 100,
    right_ratio: Number(el("structure-right").value || 0) / 100,
    max_chars: el("structure-max-chars").value === "" ? null : Number(el("structure-max-chars").value),
    page_types: el("structure-body-only").checked ? ["body"] : ["body", "front", "toc", "appendix", "index"],
    detect_page_numbers: el("structure-numbers").checked,
  };
}

async function previewHeaderFooter() {
  if (!currentProject) return;
  el("structure-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/structure/header-footer/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(structureRules()),
      }
    );
    renderStructurePreview(data);
  } catch (error) {
    showError(el("structure-error"), error);
  }
}

const STRUCTURE_TYPE_LABELS = {
  header: "页眉", footer: "页脚", page_number: "页码",
  caption: "图注", footnote: "脚注", heading: "标题", other: "其他", paragraph: "段落",
};

function renderStructurePreview(data) {
  // 默认只勾"有把握"的（页码形态或跨页重复）；只出现一两次的留给人工判断——
  // 标错一个页脚，正文就会从导出里消失
  structureCandidates = (data.candidates || []).map((item) => ({
    ...item,
    keep: item.confidence === "high",
  }));

  el("structure-result").hidden = false;
  el("structure-meta").textContent = `${data.pages_scanned} 页在作用范围内`;
  const byType = Object.entries(data.by_type || {})
    .map(([type, count]) => `${STRUCTURE_TYPE_LABELS[type] || type} ${count}`)
    .join(" · ");
  el("structure-summary").textContent = data.candidate_count
    ? `找到 ${data.candidate_count} 个（默认勾选 ${data.high_confidence_count} 个有把握的）：${byType}`
    : "按当前规则没有需要标注的块";

  const list = el("structure-candidates");
  list.innerHTML = "";
  structureCandidates.forEach((item, index) => {
    const li = document.createElement("li");
    li.dataset.index = String(index);
    if (!item.keep) li.classList.add("is-off");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = item.keep;
    check.title =
      item.confidence === "high"
        ? "取消勾选 = 这次不标它"
        : "只在这一页出现，可能是正文的最后一行——确认它确实是页眉 / 页脚再勾";
    check.addEventListener("change", () => {
      structureCandidates[index].keep = check.checked;
      li.classList.toggle("is-off", !check.checked);
      updateStructureApplyState();
    });

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent =
      `第 ${item.page_no} 页 · ${STRUCTURE_TYPE_LABELS[item.current_type] || item.current_type}` +
      ` → ${STRUCTURE_TYPE_LABELS[item.proposed_type] || item.proposed_type}` +
      (item.confidence === "high" ? " · 有把握" : " · 需确认");

    const text = document.createElement("span");
    text.className = "text";
    text.textContent = item.text.slice(0, 60);

    li.append(check, meta, text);
    list.append(li);
  });

  // 被跳过的块（含原因）也如实列出来，免得用户以为漏了
  const note = el("structure-note");
  const notes = [];
  if (data.skipped_count) {
    const sample = (data.skipped || [])
      .slice(0, 3)
      .map((item) => `第 ${item.page_no} 页「${item.text.slice(0, 12)}」${item.reason}`)
      .join("；");
    notes.push(`有 ${data.skipped_count} 个块在区域内但没有动它：${sample}${data.skipped_count > 3 ? " 等" : ""}`);
  }
  if (!data.candidate_count) {
    notes.push("如果没有找到，试着把区域高度调大一点，或把「只作用于正文页」去掉。");
  }
  note.textContent = notes.join(" ");
  note.hidden = notes.length === 0;

  updateStructureApplyState();
}

function updateStructureApplyState() {
  const kept = structureCandidates.filter((item) => item.keep);
  const button = el("structure-apply-btn");
  button.disabled = kept.length === 0;
  button.textContent = kept.length ? `应用标注（${kept.length} 个块）` : "应用标注";
}

async function applyHeaderFooter() {
  if (!currentProject) return;
  const kept = structureCandidates.filter((item) => item.keep);
  if (!kept.length) return;
  el("structure-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/structure/header-footer/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: kept.map((item) => ({
            block_id: item.block_id,
            block_type: item.proposed_type,
          })),
        }),
      }
    );
    const byType = Object.entries(data.by_type || {})
      .map(([type, count]) => `${STRUCTURE_TYPE_LABELS[type] || type} ${count}`)
      .join(" · ");
    el("structure-note").textContent =
      `已标注 ${data.changed} 个块（${byType}），涉及 ${data.pages.length} 页。` +
      "这是一次批量操作，可以用「撤销」整体退回去。";
    el("structure-note").hidden = false;
    structureCandidates = [];
    el("structure-result").hidden = true;
    el("structure-apply-btn").disabled = true;
    await reloadProjectPages();
    await refreshExportPreflight();
  } catch (error) {
    showError(el("structure-error"), error);
  }
}

function setupStructurePanel() {
  el("structure-preview-btn").addEventListener("click", previewHeaderFooter);
  el("structure-apply-btn").addEventListener("click", applyHeaderFooter);
  el("structure-all").addEventListener("click", () => setAllStructureKeeps(true));
  el("structure-none").addEventListener("click", () => setAllStructureKeeps(false));
}

function setAllStructureKeeps(keep) {
  structureCandidates = structureCandidates.map((item) => ({ ...item, keep }));
  for (const li of el("structure-candidates").children) {
    const index = Number(li.dataset.index);
    li.querySelector("input").checked = structureCandidates[index].keep;
    li.classList.toggle("is-off", !structureCandidates[index].keep);
  }
  updateStructureApplyState();
}

// ---------------------------------------------------------------- 导出（项目）

let lastExport = null;      // 最近一次生成的导出（含记录与 manifest）
let exportPreviewTimer = null;

/** 收集导出面板上的选项（说明书 6.6 的每一项都在这里）。 */
function exportOptions() {
  const formats = [...document.querySelectorAll('input[name="export-format"]:checked')]
    .map((input) => input.value);
  let format = "txt";
  if (formats.length === 2) format = "both";
  else if (formats.length === 1) format = formats[0];

  const pageTypes = [...document.querySelectorAll('input[name="export-page-type"]:checked')]
    .map((input) => input.value);

  const rangeText = el("export-range").value.trim();
  let pageNumbers = null;
  if (rangeText) {
    const { numbers, invalid } = parsePageRange(rangeText);
    if (invalid.length) throw new ApiError(`看不懂这段页码范围：${invalid.join("、")}`);
    pageNumbers = [...numbers];
  }

  return {
    format,
    confirmed_only: el("export-confirmed-only").checked,
    page_types: pageTypes,
    page_numbers: pageNumbers,
    include_footnotes: el("export-footnotes").checked,
    include_captions: el("export-captions").checked,
    include_other: el("export-other").checked,
    page_markers: el("export-page-markers").checked,
    exclude_header_footer: el("export-rule-header").checked,
    merge_lines_in_block: el("export-rule-merge").checked,
    restore_hyphenation: el("export-rule-hyphen").checked,
    normalize_newlines: el("export-rule-newlines").checked,
    strip_line_whitespace: el("export-rule-strip").checked,
  };
}

function renderPreflight(data) {
  const rows = [
    ["导出页数", `${data.exported_pages.length} 页`],
    ["段数", `${data.segment_count} 段`],
    ["字数", `${data.char_count} 字`],
    ["跨块合并的段", `${data.merged_segments} 段`],
    ["断词还原", `${data.hyphenations_restored} 处`],
    ["未审校的段", `${data.unreviewed_segments} 段`],
    ["不确定的段", `${data.uncertain_segments} 段`],
    ["排除的块类型", data.excluded_block_types.length ? data.excluded_block_types.join("、") : "（无）"],
  ];
  fillDefinitionList(el("export-preflight"), rows);

  const notes = [];
  if (!data.segment_count) {
    notes.push("按当前设置没有内容可以导出——检查页面类型、范围与「仅已确认」。");
  }
  if (data.unfinished_pages && data.unfinished_pages.length) {
    const shown = data.unfinished_pages.slice(0, 12).join("、");
    const more = data.unfinished_pages.length > 12 ? " 等" : "";
    notes.push(
      `有 ${data.unfinished_pages.length} 个纳入页还没识别或识别失败（${shown}${more}），` +
        "导出的内容会缺这些页。"
    );
  }
  if (data.dropped_pages && data.dropped_pages.length) {
    notes.push(`按当前范围排除了 ${data.dropped_pages.length} 页。`);
  }
  if (data.chrome_suspect_count) {
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
  if (data.unreviewed_segments) {
    notes.push(
      `有 ${data.unreviewed_segments} 段还没审校——导出的是当前文本，` +
        "未审校的内容也在里面（要只导已确认的，勾上「仅已确认」）。"
    );
  }
  const warning = el("export-note");
  warning.textContent = notes.join(" ");
  warning.hidden = notes.length === 0;
}

async function refreshExportPreflight({ withPreview = false } = {}) {
  if (!currentProject) return;
  let options;
  try {
    options = exportOptions();
  } catch (error) {
    showError(el("export-error"), error);
    return;
  }
  el("export-error").hidden = true;
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/export/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    renderPreflight(data);
    if (withPreview) await loadExportPreview(options);
  } catch (error) {
    showError(el("export-error"), error);
  }
}

// ---------------------------------------------------------------- 导出对照（段 → 块 → 页）

let compareSegments = [];
let compareIndex = -1;
/** 来源页的块缓存：翻来翻去对照时不必反复拉同一页。 */
const comparePageBlocks = new Map();

async function loadExportPreview(options) {
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/export/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    renderCompare(data);
  } catch (error) {
    showError(el("export-error"), error);
  }
}

function renderCompare(data) {
  compareSegments = data.segments || [];
  comparePageBlocks.clear();
  el("export-compare").hidden = false;
  el("compare-meta").textContent =
    `${compareSegments.length} 段 · ${data.preflight.char_count} 字 · ` +
    `${data.preflight.page_count} 页（按当前导出设置）`;

  const list = el("compare-segments");
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
  for (const item of el("compare-segments").children) {
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
  el("compare-image-status").hidden = true;
}

/** 取某一页的块（带缓存），并把它渲染成对照用的底图。 */
async function loadComparePage(pageNo) {
  const projectId = currentProject.project_id;
  if (!comparePageBlocks.has(pageNo)) {
    const data = await apiJson(`/api/projects/${projectId}/pages/${pageNo}/blocks`);
    comparePageBlocks.set(pageNo, data.blocks || []);
  }
  const image = el("compare-image");
  const wanted = `/api/projects/${projectId}/pages/${pageNo}/image?size=view&token=${encodeURIComponent(token)}`;
  if (image.dataset.pageNo !== String(pageNo)) {
    image.dataset.pageNo = String(pageNo);
    el("compare-image-status").textContent = "正在渲染来源页…";
    el("compare-image-status").hidden = false;
    el("compare-canvas").hidden = true;
    image.onload = () => {
      el("compare-image-status").hidden = true;
      el("compare-canvas").hidden = false;
    };
    image.onerror = () => {
      el("compare-image-status").textContent = "来源页渲染失败。";
    };
    image.src = wanted;
  }
  return comparePageBlocks.get(pageNo);
}

function drawCompareOverlay(blocks, sourceIds) {
  const overlay = el("compare-overlay");
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
  el("export-compare").hidden = true;
  if (exportPreviewTimer) clearTimeout(exportPreviewTimer);
  exportPreviewTimer = setTimeout(() => refreshExportPreflight(), 350);
}

async function runExport() {
  if (!currentProject) return;
  el("export-error").hidden = true;
  let options;
  try {
    options = exportOptions();
  } catch (error) {
    showError(el("export-error"), error);
    return;
  }
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    lastExport = data;
    renderExportRecord(data.record, data.files);
    await loadExports();
  } catch (error) {
    showError(el("export-error"), error);
  }
}

function renderExportRecord(record, files = []) {
  el("export-result").hidden = false;
  el("export-result-meta").textContent =
    `${record.export_id} · ${record.segment_count} 段 · ${record.char_count} 字 · ` +
    `未审 ${record.unreviewed_count} 段 · ${record.created_at.slice(0, 16).replace("T", " ")}`;

  const list = el("export-files");
  list.innerHTML = "";
  for (const name of files.length ? files : record.file_paths) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = name;
    const download = document.createElement("a");
    download.href =
      `/api/projects/${currentProject.project_id}/exports/${record.export_id}/download` +
      `?file=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}`;
    download.textContent = "下载";
    download.className = "btn btn--ghost";
    item.append(label, download);
    list.append(item);
  }
}

async function loadExports() {
  if (!currentProject) return;
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/exports`);
    renderExportHistory(data.exports);
  } catch (error) {
    showError(el("export-error"), error);
  }
}

function renderExportHistory(records) {
  const list = el("export-history");
  list.innerHTML = "";
  el("export-history-empty").hidden = records.length > 0;
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
    await apiJson(
      `/api/projects/${currentProject.project_id}/exports/${exportId}/reveal`,
      { method: "POST" }
    );
  } catch (error) {
    showError(el("export-error"), error);
  }
}

function setupExportPanel() {
  for (const input of document.querySelectorAll(
    'input[name="export-format"], input[name="export-page-type"], #export-confirmed-only,' +
      " #export-footnotes, #export-captions, #export-other, #export-page-markers," +
      " #export-rule-header, #export-rule-merge, #export-rule-hyphen," +
      " #export-rule-newlines, #export-rule-strip"
  )) {
    input.addEventListener("change", schedulePreflight);
  }
  el("export-range").addEventListener("input", schedulePreflight);
  el("export-btn").addEventListener("click", runExport);
  el("export-preview-btn").addEventListener("click", async () => {
    try {
      await loadExportPreview(exportOptions());
    } catch (error) {
      showError(el("export-error"), error);
    }
  });
  el("compare-close").addEventListener("click", () => {
    el("export-compare").hidden = true;
  });
  el("export-reveal-btn").addEventListener("click", () => {
    if (lastExport) revealExport(lastExport.record.export_id);
  });
}

// ---------------------------------------------------------------- 项目库

/** 当前打开的项目（含页面列表）。 */
let currentProject = null;

const PAGE_TYPE_LABELS = {
  cover: "封面", toc: "目录", front: "前置", body: "正文",
  appendix: "附录", index: "索引", blank: "空白", other: "其他",
};

/**
 * 识别状态（说明书 5.3：状态不单独存储，由 OCRRun 与 Block 推导）。
 * 服务端给状态机标识，中文标签在这里——与 page_type 的处理方式一致。
 */
const RECOGNITION_LABELS = {
  unrecognized: "未识别",
  queued: "排队中",
  running: "识别中",
  recognized: "已识别",
  failed: "识别失败",
  has_candidate: "有待选新结果",
};

const RECOGNITION_CLASSES = {
  unrecognized: "",
  queued: "status--warn",
  running: "status--warn",
  recognized: "status--ok",
  failed: "status--bad",
  has_candidate: "status--warn",
};

function recognitionOf(page) {
  return page.recognition || {
    status: "unrecognized", block_count: 0, active_run_id: null,
    pending_run_id: null, run_count: 0, last_run_at: null, last_error: null,
  };
}

// ---------------------------------------------------------------- 分歧（说明书 8.5）

/** 页面载荷与块载荷都带 `divergence`（后端按"块里现在的文本"现算，见 blocks.py）。 */
function divergenceOf(thing) {
  return thing.divergence || {
    lines: 0, chars: 0, punct: 0, empty: 0, format_only: 0,
    stale_blocks: 0, checked: false, engine_id: null, checked_at: null,
    stale: false, marks: [],
  };
}

const DIVERGENCE_LEVEL_LABELS = {
  differs_chars: "汉字级",
  differs_punct: "标点级",
  no_candidate: "第二引擎没读出来",
  format_only_differs: "仅格式差异",
};

/** 把分歧概况说成一句人话；没有分歧时返回空串。 */
function divergenceSummary(divergence) {
  const parts = [];
  if (divergence.chars) parts.push(`汉字级 ${divergence.chars}`);
  if (divergence.punct) parts.push(`标点级 ${divergence.punct}`);
  if (divergence.empty) parts.push(`第二引擎没读出 ${divergence.empty}`);
  if (divergence.format_only) parts.push(`仅格式差异 ${divergence.format_only}`);
  return parts.join(" · ");
}

/** 缩略图上的分歧标记：只标**汉字级**（标点级太吵，看标题里的完整数字）。 */
function divergenceChip(page) {
  const divergence = divergenceOf(page);
  if (!divergence.lines) return null;
  const chip = document.createElement("span");
  chip.className = "status " + (divergence.chars ? "status--warn" : "status--muted");
  chip.textContent = divergence.chars ? `≠ ${divergence.chars}` : "≈ 标点级";
  chip.title =
    `两路复核：${divergenceSummary(divergence)}\n` +
    "汉字级 = 两路在汉字 / 数字上不一致，标点级 = 只差标点 / 符号。\n" +
    "两类都值得看一眼：实测（40 页真书）标出的分歧里约八成是第二引擎自己的错（以汉字为主），" +
    "但标记能圈进第一引擎约 2/3 的错行——见 docs/ocr-evaluation.md 第 9 节";
  return chip;
}

function recognitionText(page) {
  const recognition = recognitionOf(page);
  const label = RECOGNITION_LABELS[recognition.status] || recognition.status;
  return recognition.status === "recognized"
    ? `${label} · ${recognition.block_count} 块`
    : label;
}

const PAGE_REVIEW_LABELS = {
  not_started: "未审",
  in_progress: "审校中",
  done: "已审完",
  questioned: "有疑问",
};

/** 审校徽章：只在有块之后才有意义（没识别的页没什么可审）。 */
function reviewBadge(page) {
  const review = page.review;
  if (!review || !review.block_count) return null;
  const label = PAGE_REVIEW_LABELS[review.status];
  if (!label) return null;
  const chip = document.createElement("span");
  chip.className =
    "status " +
    (review.status === "done"
      ? "status--ok"
      : review.status === "questioned"
      ? "status--bad"
      : "");
  chip.textContent =
    review.status === "questioned" ? `${label} ${review.uncertain}` : label;
  return chip;
}

function recognitionChip(page) {
  const recognition = recognitionOf(page);
  const chip = document.createElement("span");
  chip.className = "status " + (RECOGNITION_CLASSES[recognition.status] || "");
  chip.textContent = recognitionText(page);
  if (recognition.last_error) chip.title = `上次失败：${recognition.last_error}`;
  return chip;
}

async function loadLibrary() {
  el("library-warning").hidden = true;
  try {
    const data = await apiJson("/api/projects");
    el("library-path").textContent = `（${data.library_dir}）`;
    renderProjectList(data.projects);
  } catch (error) {
    showError(el("library-error"), error);
  }
}

function renderProjectList(projects) {
  const list = el("project-list");
  list.innerHTML = "";
  el("library-empty").hidden = projects.length > 0;

  for (const entry of projects) {
    const item = document.createElement("li");
    item.className = "project-item" + (entry.lock_held ? " project-item--locked" : "");
    item.dataset.projectId = entry.project_id;

    const head = document.createElement("div");
    head.className = "project-item__head";

    const name = document.createElement("span");
    name.className = "project-item__name";
    name.textContent = `《${entry.name}》`;

    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent =
      `${entry.source_file_name} · ${entry.page_count} 页 · ` +
      `纳入 ${entry.included_pages} 页 · 已识别 ${entry.recognized_pages} 页`;

    head.append(name, meta);
    if (entry.lock_held) {
      const badge = document.createElement("span");
      badge.className = "status status--bad";
      badge.textContent = "使用中";
      badge.title = entry.lock_reason;
      head.append(badge);
    }
    if (entry.text_layer_hint) {
      const hint = document.createElement("span");
      hint.className = "status";
      hint.style.background = "var(--warn-bg)";
      hint.style.color = "var(--warn-fg)";
      hint.textContent = "可能已含文本";
      hint.title = `${entry.pages_with_text_layer} / ${entry.page_count} 页已有文本层`;
      head.append(hint);
    }

    const stats = document.createElement("div");
    stats.className = "project-item__stats muted";
    const last = entry.last_view
      ? `上次位置：${entry.last_view}`
      : "还没有打开过";
    stats.textContent =
      `${entry.project_id} · 创建于 ${entry.created_at.slice(0, 10)} · ${last}`;

    const actions = document.createElement("div");
    actions.className = "project-item__actions";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "btn btn--primary";
    openButton.textContent = "打开";
    openButton.addEventListener("click", () => openProject(entry.project_id));

    actions.append(openButton);
    if (entry.lock_held) {
      const readOnlyButton = document.createElement("button");
      readOnlyButton.type = "button";
      readOnlyButton.className = "btn";
      readOnlyButton.textContent = "只读打开";
      readOnlyButton.addEventListener("click", () =>
        openProject(entry.project_id, { readOnly: true })
      );
      const forceButton = document.createElement("button");
      forceButton.type = "button";
      forceButton.className = "btn btn--danger";
      forceButton.textContent = "强制打开";
      forceButton.title = "有让两台电脑同时写入同一数据库的风险";
      forceButton.addEventListener("click", () =>
        openProject(entry.project_id, { force: true })
      );
      actions.append(readOnlyButton, forceButton);
    }

    item.append(head, stats, actions);
    list.append(item);
  }
}

async function createProjectFromFile(file) {
  const name = el("new-project-name").value.trim();
  el("library-error").hidden = true;
  el("create-progress").hidden = false;

  try {
    const response = await fetch(
      `/api/projects?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "X-B2T-Token": token, "Content-Type": "application/pdf" },
        body: file,
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload && payload.error) || {};
      throw new ApiError(error.message || `新建失败（HTTP ${response.status}）`,
                         error.code, error.correlation_id, error.detail);
    }

    el("new-project-name").value = "";
    if (payload.text_layer_hint) {
      const warning = el("library-warning");
      warning.textContent =
        `这本 PDF 有 ${payload.pages_with_text_layer} 页已经带文本层，` +
        `可能不需要识别——建议先抽查几页再决定。`;
      warning.hidden = false;
    }
    await loadLibrary();
    await openProject(payload.project.project_id);
  } catch (error) {
    showError(el("library-error"), error);
  } finally {
    el("create-progress").hidden = true;
  }
}

async function openProject(projectId, { force = false, readOnly = false } = {}) {
  el("library-error").hidden = true;
  el("library-warning").hidden = true;

  try {
    const opened = await apiJson(
      `/api/projects/${projectId}/open?force=${force}&read_only=${readOnly}`,
      { method: "POST" }
    );
    if (opened.warning) {
      const warning = el("library-warning");
      warning.textContent = opened.warning;
      warning.hidden = false;
    }
    await refreshProject(projectId);
    await loadLibrary();
  } catch (error) {
    showError(el("library-error"), error);
  }
}

async function refreshProject(projectId) {
  const data = await apiJson(`/api/projects/${projectId}`);
  currentProject = { ...data.project, pages: data.pages, read_only: false };
  selectedPages.clear();
  selectionAnchor = null;
  closePageDetail();
  structureCandidates = [];
  el("structure-result").hidden = true;
  renderProject();
  // 任务可能还在跑（比如刷新了页面），把抽屉里的进度接回来
  await loadTasks();
  // 导出面板：预检 + 历史（说明书 6.6 要求预检摘要实时算）
  await refreshExportPreflight();
  await loadExports();
  // 质量统计（说明书 8.5 / 13.4）：数字多、算起来比页面列表重，单独一个请求拿
  await loadSummary();
}

// ---------------------------------------------------------------- 质量统计（说明书 8.5 / 13.4）

/** 一行的写法：左边条目、右边数字（`value` 为空则整行不显示）。 */
function statsRow(term, value, title = "") {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (title) dd.title = title;
  return [dt, dd];
}

function percentText(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

async function loadSummary() {
  if (!currentProject) return;
  let data;
  try {
    data = await apiJson(`/api/projects/${currentProject.project_id}/summary`);
  } catch {
    return; // 摘要读不到不该影响主流程
  }
  renderSummary(data);
}

function renderSummary(data) {
  const pages = data.pages || {};
  const review = data.review || {};
  const divergence = data.divergence || {};
  const jobs = data.jobs || {};
  const list = el("stats-list");
  list.innerHTML = "";

  const recognitionBits = [`已识别 ${pages.recognized || 0} / 纳入 ${pages.included || 0} 页`];
  if (pages.unrecognized) recognitionBits.push(`未识别 ${pages.unrecognized}`);
  if (pages.failed) recognitionBits.push(`识别失败 ${pages.failed}`);
  if (pages.has_candidate) recognitionBits.push(`待选新结果 ${pages.has_candidate}`);
  list.append(...statsRow("识别", recognitionBits.join(" · ")));

  const reviewBits = [
    `块 ${review.blocks || 0}（纳入 ${review.included || 0}）`,
    `已确认 ${review.confirmed || 0}`,
    `未审 ${review.unreviewed || 0}`,
  ];
  if (review.uncertain) reviewBits.push(`不确定 ${review.uncertain}`);
  reviewBits.push(
    `人工修改 ${review.modified || 0}（${percentText(review.modified_rate)}）`
  );
  list.append(
    ...statsRow("审校", reviewBits.join(" · "), "人工修改率 = 改过的块 / 纳入块（说明书 13.4）")
  );

  // 两路复核：没有复核过就如实说"还没复核"，不显示一堆 0
  if (!divergence.checked_pages) {
    list.append(
      ...statsRow("两路复核", "还没复核过（选中页面后点「第二引擎复核所选」）")
    );
  } else {
    const rateTitle =
      "分歧率 = 实质分歧行 / 能比的行（汉字级 + 标点级 ÷ 一致 + 仅格式 + 汉字级 + 标点级）；" +
      "第二引擎没读出来的行不进分母";
    const bits = [
      `已复核 ${divergence.checked_pages} / ${divergence.total_pages} 页`,
      `比过 ${divergence.compared_lines} 行`,
      `一致 ${divergence.identical}`,
      `仅格式 ${divergence.format_only}`,
      `汉字级 ${divergence.chars}`,
      `标点级 ${divergence.punct}`,
    ];
    if (divergence.empty) bits.push(`没读出 ${divergence.empty}`);
    bits.push(`分歧率 ${percentText(divergence.diverging_rate)}`);
    list.append(...statsRow("两路复核", bits.join(" · "), rateTitle));
    if (divergence.stale_blocks) {
      list.append(
        ...statsRow(
          "　",
          `有 ${divergence.stale_blocks} 个块的行结构改过，不参与上面的行统计`
        )
      );
    }
  }

  const jobBits = [
    `共 ${jobs.total || 0} 个`,
    `成功 ${jobs.succeeded || 0}`,
    `失败 ${jobs.failed || 0}（失败率 ${percentText(jobs.failure_rate)}）`,
  ];
  if (jobs.interrupted) jobBits.push(`中断 ${jobs.interrupted}`);
  if (jobs.cancelled) jobBits.push(`取消 ${jobs.cancelled}`);
  if (jobs.active) jobBits.push(`进行中 ${jobs.active}`);
  list.append(
    ...statsRow("任务", jobBits.join(" · "), "失败率 = 失败 / （成功 + 失败）；取消与中断不算成败")
  );

  // 算不出来的指标如实列出，不假装算过（说明书 1.7）
  const notMeasured = data.not_measured || [];
  const note = el("stats-note");
  note.hidden = notMeasured.length === 0;
  note.textContent = notMeasured.length
    ? "产品里算不出来的指标：" +
      notMeasured.map((item) => `${item.name}（${item.reason}）`).join("；")
    : "";
}

function renderProject() {
  const project = currentProject;
  if (!project) return;

  el("project-card").hidden = false;
  el("project-title").textContent = `《${project.name}》`;
  renderProjectMeta();
  renderPages();
}

function renderProjectMeta() {
  const project = currentProject;
  if (!project) return;
  const pages = project.pages;
  const recognized = pages.filter(
    (page) => recognitionOf(page).status === "recognized"
  ).length;

  fillDefinitionList(el("project-meta"), [
    ["项目 ID", project.project_id],
    ["源文件", project.source_file_name],
    ["SHA-256", project.source_sha256],
    ["页数", `${project.page_count} 页`],
    ["识别进度", `已识别 ${recognized} / 纳入 ${pages.filter((page) => page.include).length} 页`],
    ["数据库版本", `schema_version ${project.schema_version}`],
    ["项目文件夹", project.directory],
  ]);
}

// ---------------------------------------------------------------- 页面选择
//
// 说明书 6.2 的选择方式：单击（单选）、Shift + 单击（范围）、Mod + 单击（多选）、
// 输入页码范围（`1-12, 300-310`）。选择状态只存**页码**集合，
// 因此重新渲染网格、切换筛选都不会丢选择。

const selectedPages = new Set();
let selectionAnchor = null;

function visiblePages() {
  const project = currentProject;
  if (!project) return [];
  const typeFilter = el("filter-type").value;
  const recognitionFilter = el("filter-recognition").value;
  const triageFilter = el("filter-triage").value;
  const onlyIncluded = el("pages-only-included").checked;

  return project.pages.filter((page) => {
    if (onlyIncluded && !page.include) return false;
    if (typeFilter && page.page_type !== typeFilter) return false;
    const recognition = recognitionOf(page);
    if (recognitionFilter && recognition.status !== recognitionFilter) return false;
    if (triageFilter && !matchesTriage(page, recognition, triageFilter)) return false;
    return true;
  });
}

/** 疑难筛选（说明书 6.4）：在"需要处理"的页面之间跳转，厚书审校时最省时间。 */
function matchesTriage(page, recognition, kind) {
  const review = page.review || {};
  if (kind === "todo") {
    // 还没审完：有未审或不确定的块，或者根本没识别
    return (
      (review.unreviewed || 0) > 0 ||
      (review.uncertain || 0) > 0 ||
      recognition.status === "unrecognized" ||
      recognition.status === "failed"
    );
  }
  if (kind === "uncertain") return (review.uncertain || 0) > 0;
  if (kind === "failed") return recognition.status === "failed";
  if (kind === "candidate") return recognition.status === "has_candidate";
  // 分歧（说明书 8.5）：两条都留着——40 页真书实测（ocr-evaluation 第 9 节）里
  // **标点级的信噪比反而比汉字级高**（23.7% vs 13.3%），所以哪一条都不该被当成"噪声"
  if (kind === "divergence_chars") return (divergenceOf(page).chars || 0) > 0;
  if (kind === "divergence") return (divergenceOf(page).lines || 0) > 0;
  return true;
}

function selectOnly(pageNo) {
  selectedPages.clear();
  selectedPages.add(pageNo);
  selectionAnchor = pageNo;
}

function toggleSelection(pageNo) {
  if (selectedPages.has(pageNo)) {
    selectedPages.delete(pageNo);
  } else {
    selectedPages.add(pageNo);
  }
  selectionAnchor = pageNo;
}

function selectRangeTo(pageNo) {
  const pages = visiblePages();
  const anchorIndex = pages.findIndex((page) => page.page_no === selectionAnchor);
  const index = pages.findIndex((page) => page.page_no === pageNo);
  if (anchorIndex < 0 || index < 0) {
    selectOnly(pageNo);
    return;
  }
  const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
  for (let i = from; i <= to; i += 1) selectedPages.add(pages[i].page_no);
}

function handleTileClick(page, event) {
  if (event.shiftKey && selectionAnchor !== null) {
    selectRangeTo(page.page_no);
  } else if (event.metaKey || event.ctrlKey) {
    toggleSelection(page.page_no);
  } else {
    selectOnly(page.page_no);
  }
  renderPages();
}

/** 解析"1-12, 300-310"这样的页码范围（说明书 6.2）。 */
function parsePageRange(text) {
  const numbers = new Set();
  const invalid = [];
  for (const part of text.split(/[,，;；\s]+/)) {
    if (!part) continue;
    const match = part.match(/^(\d+)\s*[-—~～]\s*(\d+)$/);
    if (match) {
      let [from, to] = [Number(match[1]), Number(match[2])];
      if (from > to) [from, to] = [to, from];
      for (let n = from; n <= to; n += 1) numbers.add(n);
      continue;
    }
    if (/^\d+$/.test(part)) {
      numbers.add(Number(part));
      continue;
    }
    invalid.push(part);
  }
  return { numbers, invalid };
}

function applyPageRangeInput() {
  const project = currentProject;
  if (!project) return;
  const { numbers, invalid } = parsePageRange(el("page-range").value);
  const known = new Set(project.pages.map((page) => page.page_no));
  const unknown = [...numbers].filter((pageNo) => !known.has(pageNo));

  if (invalid.length || unknown.length) {
    const error = el("pages-error");
    error.textContent =
      (invalid.length ? `看不懂这段：${invalid.join("、")}。` : "") +
      (unknown.length ? `这些页码不存在：${unknown.slice(0, 8).join("、")}。` : "") +
      "可以写成 1-12 或 3,5,8。";
    error.hidden = false;
    return;
  }
  el("pages-error").hidden = true;

  selectedPages.clear();
  for (const pageNo of numbers) selectedPages.add(pageNo);
  selectionAnchor = numbers.size ? Math.min(...numbers) : null;
  renderPages();
}

function selectionPages() {
  return currentProject.pages.filter((page) => selectedPages.has(page.page_no));
}

function updateSelectionPanel() {
  const count = selectedPages.size;
  el("selection-count").textContent = `已选 ${count} 页`;
  const selected = selectionPages();
  const hasExcluded = selected.some((page) => !page.include);

  el("selection-set-type").disabled = count === 0;
  el("selection-include").disabled = count === 0 || !hasExcluded;
  el("selection-exclude").disabled = count === 0 || !selected.some((page) => page.include);
  el("selection-recognize").disabled = count === 0 || !selected.some((page) => page.include);

  const hint = el("selection-hint");
  hint.hidden = true;
  if (count === 0) return;
  if (selected.every((page) => !page.include)) {
    hint.textContent = "选中的页都排除了，不参与识别。先点「纳入」。";
    hint.hidden = false;
  } else if (count >= 3 && count <= 10) {
    // 说明书 6.3 的样本试识别：先认几页看看，再决定要不要整本识别
    hint.textContent =
      `选了 ${count} 页——可以先当样本试识别：认完点某一页的「结果」看看质量，` +
      "再决定要不要识别整本。样本结果不代表整本书。";
    hint.hidden = false;
  }
}

// ---------------------------------------------------------------- 页面网格

/** 页面上该显示的门牌（类型 / 印张 / 状态），构建与刷新共用。 */
function tileTitle(page) {
  return (
    `第 ${page.page_no} 页 · ${PAGE_TYPE_LABELS[page.page_type] || page.page_type}` +
    ` · ${page.width_pt}×${page.height_pt} pt` +
    (page.rotation ? ` · 旋转 ${page.rotation}°` : "") +
    "\n单击选中（Shift 选一段、⌘/Ctrl 加减一页），双击看识别结果"
  );
}

function tileClassName(page) {
  const recognition = recognitionOf(page);
  return (
    "page-tile" +
    (page.include ? "" : " page-tile--excluded") +
    (page.has_text_layer ? " page-tile--textlayer" : "") +
    (busyPages.has(page.page_no) ? " page-tile--busy" : "") +
    (recognition.status === "failed" ? " page-tile--failed" : "") +
    (selectedPages.has(page.page_no) ? " page-tile--selected" : "")
  );
}

function buildTile(page, project) {
  const tile = document.createElement("div");
  tile.dataset.pageId = page.page_id;
  tile.dataset.pageNo = String(page.page_no);

  const check = document.createElement("div");
  check.className = "page-tile__check";
  check.textContent = "✓";

  const image = document.createElement("img");
  // 说明书 6.1 要求缩略图由后台 Job 生成并缓存；缩略图任务还没做，
  // 这里按需渲染（不写缓存），浏览器侧靠 Cache-Control 复用。
  image.loading = "lazy";
  image.alt = `第 ${page.page_no} 页`;
  image.src =
    `/api/projects/${project.project_id}/pages/${page.page_no}/image?size=thumb` +
    `&token=${encodeURIComponent(token)}`;

  const label = document.createElement("div");
  label.className = "page-tile__label";

  const status = document.createElement("div");
  status.className = "page-tile__status";

  const actions = document.createElement("div");
  actions.className = "page-tile__actions";

  const recognizeButton = document.createElement("button");
  recognizeButton.type = "button";
  recognizeButton.className = "btn";
  recognizeButton.dataset.action = "recognize";
  recognizeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    recognizePage(page);
  });

  const detailButton = document.createElement("button");
  detailButton.type = "button";
  detailButton.className = "btn";
  detailButton.textContent = "结果";
  detailButton.title = "看这一页已保存的识别结果";
  detailButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openPageDetail(page.page_no);
  });

  actions.append(recognizeButton, detailButton);
  tile.append(check, image, label, status, actions);
  tile.addEventListener("click", (event) => handleTileClick(page, event));
  tile.addEventListener("dblclick", (event) => {
    event.preventDefault();
    openPageDetail(page.page_no);
  });
  return tile;
}

/** 就地刷新一个瓷砖的状态（轮询时用，不重建 DOM）。 */
function applyTileState(tile, page) {
  const recognition = recognitionOf(page);
  tile.className = tileClassName(page);
  tile.title = tileTitle(page);

  const printed = page.page_label ? ` · 印${page.page_label}` : "";
  tile.querySelector(".page-tile__label").textContent =
    `${page.page_no}${printed} · ${PAGE_TYPE_LABELS[page.page_type] || page.page_type}`;

  const status = tile.querySelector(".page-tile__status");
  status.innerHTML = "";
  status.append(recognitionChip(page));
  const reviewChip = reviewBadge(page);
  if (reviewChip) status.append(reviewChip);
  const divergence = divergenceChip(page);
  if (divergence) status.append(divergence);

  const isBusy = busyPages.has(page.page_no);
  const button = tile.querySelector('button[data-action="recognize"]');
  button.textContent = isBusy ? "识别中…" : "识别";
  button.disabled = isBusy || !page.include;
  if (!page.include) {
    button.title = "已排除，不参与识别。先选中它再点「纳入」";
  } else if (recognition.status === "recognized") {
    button.title = "重新识别这一页（已有人工成果时不会覆盖，只作为待选结果）";
  } else {
    button.title = "识别这一页（在后台任务里跑，进度看右下角）";
  }
}

function renderPages() {
  const project = currentProject;
  if (!project) return;
  const pages = visiblePages();
  const all = project.pages;

  el("page-summary").textContent =
    `共 ${all.length} 页 · 纳入 ${all.filter((page) => page.include).length} 页` +
    ` · 已识别 ${all.filter((page) => recognitionOf(page).status === "recognized").length} 页` +
    (pages.length !== all.length ? ` · 当前显示 ${pages.length} 页` : "");

  const grid = el("page-grid");
  grid.innerHTML = "";
  for (const page of pages) {
    const tile = buildTile(page, project);
    applyTileState(tile, page);
    grid.append(tile);
  }
  if (!pages.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "当前筛选下没有页面。";
    grid.append(empty);
  }
  updateSelectionPanel();
}

/**
 * 任务轮询时用：只更新已有瓷砖的状态，不重建 DOM。
 *
 * 一本 400 页的书如果每 1.2 秒重建 400 个瓷砖，浏览器的滚动与图片都会被反复折腾；
 * 而任务进行时变的基本只有状态徽章。页面集合变了（筛选 / 增删页）才整格重建。
 */
function syncPageStates() {
  const grid = el("page-grid");
  const pages = visiblePages();
  const tiles = [...grid.querySelectorAll(".page-tile")];

  if (tiles.length !== pages.length) {
    renderPages();
    return;
  }
  pages.forEach((page, index) => {
    const tile = tiles[index];
    if (tile.dataset.pageNo !== String(page.page_no)) {
      renderPages();
      return;
    }
    applyTileState(tile, page);
  });
  updateSelectionPanel();
}

// ---------------------------------------------------------------- 识别（项目）

/** 正在识别的页码。识别跑在后台任务里，这里只是"刚点了、还没轮到"的即时反馈。 */
const busyPages = new Set();

const JOB_STATUS_LABELS = {
  queued: "排队中",
  running: "进行中",
  paused: "已暂停",
  succeeded: "已完成",
  failed: "有失败页",
  cancelled: "已取消",
  interrupted: "已中断",
};

/** 任务类型（说明书 5.3 的 job_type）：识别与第二引擎复核共用一套任务机制。 */
const JOB_TYPE_LABELS = {
  ocr: "识别",
  auxiliary: "第二引擎复核",
};

async function recognizePage(page) {
  const project = currentProject;
  if (!project || busyPages.has(page.page_no)) return;

  el("pages-error").hidden = true;
  busyPages.add(page.page_no);
  renderPages();

  try {
    const data = await apiJson(`/api/projects/${project.project_id}/jobs/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 单页"识别"是明确要求认这一页：**不跳过**已识别的页（会走 R2）
      body: JSON.stringify({ pages: [page.page_no], skip_recognized: false }),
    });
    applyRecognizedPages(data.pages);
    openTaskDrawer();
    startTaskPolling(data.job.job_id);
  } catch (error) {
    // 审校视图开着时，错误显示在手边的那一块上（页面视图的错误条在网格上方，看不见）
    if (detailPageNo !== null) showError(el("page-detail-error"), error);
    else showError(el("pages-error"), error);
  } finally {
    busyPages.delete(page.page_no);
    renderPages();
  }
}

async function startBatchRecognition(scope) {
  const project = currentProject;
  if (!project) return;
  el("pages-error").hidden = true;
  try {
    const data = await apiJson(`/api/projects/${project.project_id}/jobs/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    applyRecognizedPages(data.pages);
    renderPages();
    openTaskDrawer();
    startTaskPolling(data.job.job_id);
  } catch (error) {
    showError(el("pages-error"), error);
  }
}

/** 用接口返回的页面（含最新识别状态）更新本地列表，不重拉整个项目。 */
function applyRecognizedPages(pages) {
  for (const updated of pages || []) {
    const index = currentProject.pages.findIndex(
      (page) => page.page_id === updated.page_id
    );
    if (index >= 0) currentProject.pages[index] = updated;
  }
}

/**
 * 第二引擎复核（说明书 8.5）：批量跑成后台任务，与识别共用任务抽屉。
 *
 * 与识别不同的两处都在提示里说清：**只有已识别的页**能复核（第二引擎读的是
 * 第一引擎切出的行图），且默认跳过已复核的页。
 */
async function checkSelection(scope) {
  const project = currentProject;
  if (!project) return;
  el("pages-error").hidden = true;

  let body;
  if (scope) {
    // 全部已识别但还没复核过的页（说明书 8.5：可以随时补跑）
    body = { scope };
  } else {
    const pages = selectionPages().filter((page) => page.include);
    if (!pages.length) return;
    body = {
      pages: pages.map((page) => page.page_no),
      skip_checked: el("selection-skip-checked").checked,
    };
  }
  try {
    const data = await apiJson(`/api/projects/${project.project_id}/jobs/auxiliary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    applyRecognizedPages(data.pages);
    renderPages();
    openTaskDrawer();
    startTaskPolling(data.job.job_id);
  } catch (error) {
    showError(el("pages-error"), error);
  }
}

/** 重新拉一次页面列表（任务跑完、页面状态大面积变化时用）。 */
async function reloadProjectPages() {
  if (!currentProject) return;
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/pages`);
    currentProject.pages = data.pages;
  } catch (error) {
    showError(el("pages-error"), error);
    return;
  }
  renderPages();
  renderProjectMeta();
  if (detailPageNo !== null) await loadPageDetail(detailPageNo);
}

// ---------------------------------------------------------------- 任务抽屉

let taskTimer = null;
let taskJobId = null;

function openTaskDrawer() {
  el("task-drawer").hidden = false;
  document.body.classList.add("task-drawer-open");
}

function closeTaskDrawer() {
  el("task-drawer").hidden = true;
  document.body.classList.remove("task-drawer-open");
}

function taskChipClass(status) {
  if (status === "failed" || status === "interrupted") return "badge badge--task is-failed";
  if (status && status !== "succeeded") return "badge badge--task is-active";
  return "badge badge--task";
}

/** 拉任务列表：有正在跑的就盯住它，否则只显示最近任务。 */
async function loadTasks({ openDrawer = false } = {}) {
  if (!currentProject) return;
  let data;
  try {
    data = await apiJson(`/api/projects/${currentProject.project_id}/jobs?limit=8`);
  } catch (error) {
    return; // 任务列表读不到不该影响主流程
  }
  if (openDrawer) openTaskDrawer();

  if (data.active) {
    renderTask(data.active);
    startTaskPolling(data.active.job.job_id);
  } else {
    taskJobId = null;
    stopTaskPolling();
    renderRecentTasks(data.jobs);
  }
}

function startTaskPolling(jobId) {
  taskJobId = jobId;
  stopTaskPolling();
  taskTimer = setInterval(pollTask, 1200);
  pollTask();
}

function stopTaskPolling() {
  if (taskTimer) clearInterval(taskTimer);
  taskTimer = null;
}

async function pollTask() {
  const project = currentProject;
  if (!project || !taskJobId) return;
  let data;
  try {
    data = await apiJson(`/api/projects/${project.project_id}/jobs/${taskJobId}`);
  } catch (error) {
    stopTaskPolling();
    return;
  }
  renderTask(data);

  if (!["queued", "running", "paused"].includes(data.job.status)) {
    stopTaskPolling();
    await reloadProjectPages();
    await loadTasks();
    await loadSummary(); // 任务结束后统计会变（复核行数、任务失败率）
  } else {
    // 进度在变，页面状态也在变：不重拉图，只刷状态
    await refreshPageStates();
  }
}

async function refreshPageStates() {
  const project = currentProject;
  if (!project) return;
  try {
    const data = await apiJson(`/api/projects/${project.project_id}/pages`);
    currentProject.pages = data.pages;
  } catch {
    return;
  }
  // 就地刷新：任务进行时变的基本只有状态徽章，没必要整格重建（400 页的书会很明显）
  syncPageStates();
  renderProjectMeta();
}

function renderTask(data) {
  const job = data.job;
  const label = JOB_STATUS_LABELS[job.status] || job.status;
  const typeLabel = JOB_TYPE_LABELS[job.job_type] || job.job_type;
  openTaskDrawer();
  el("drawer-title").textContent = `${typeLabel}任务`;

  const current = data.current_page_no ? ` · 当前第 ${data.current_page_no} 页` : "";
  const interrupted = data.alive === false && ["queued", "running", "paused"].includes(job.status);
  const aliveNote = interrupted ? `（${typeLabel}进程已不在——点取消或继续收拾它）` : "";
  el("drawer-status").textContent = `${label}${current}${aliveNote}`;

  el("drawer-fill").style.width = `${job.percent}%`;
  el("drawer-fill").style.background =
    job.status === "failed" || job.status === "interrupted" ? "var(--bad-fg)" : "var(--accent)";
  el("drawer-counts").textContent =
    `${job.done + job.failed} / ${job.total} 页 · 成功 ${job.done}` +
    (job.failed ? ` · 失败 ${job.failed}` : "");

  // 只显示技术上真实支持的操作（说明书 6.3）
  const running = job.status === "running" || job.status === "queued";
  el("job-pause").disabled = !running;
  el("job-resume").disabled = !["paused", "interrupted", "failed", "cancelled"].includes(
    job.status
  );
  el("job-retry").disabled = job.failed === 0 || (job.is_active && data.alive);
  el("job-cancel").disabled = !["queued", "running", "paused"].includes(job.status);

  const hints = [];
  if (job.status === "paused") {
    hints.push("已暂停：当前页做完后停下，点“继续”接着做。");
  }
  if (job.status === "failed" && job.failed) {
    hints.push("有页失败——点“重试失败页”只重做这些页，成功的页不会重做。");
  }
  if (job.status === "cancelled") {
    hints.push("已取消：已认完的页保留，点“继续”接着做没做完的。");
  }
  if (job.status === "interrupted") {
    hints.push("任务中断（应用被关闭或识别进程异常退出），点“继续”接着做没做完的。");
  }
  el("drawer-hint").textContent = hints.join(" ");
  el("drawer-hint").hidden = hints.length === 0;

  const failures = el("drawer-failures");
  failures.innerHTML = "";
  for (const item of data.failed_items) {
    const li = document.createElement("li");
    const head = document.createElement("div");
    const pageNo = document.createElement("span");
    pageNo.className = "page-no";
    pageNo.textContent = `第 ${item.page_no} 页`;
    head.append(pageNo);
    const reason = document.createElement("div");
    reason.className = "muted";
    reason.textContent = item.error_message || "原因未记录";
    li.append(head, reason);
    li.title = "点一下：跳到这一页";
    li.addEventListener("click", () => {
      const page = currentProject.pages.find((p) => p.page_no === item.page_no);
      if (page) openPageDetail(page.page_no);
    });
    failures.append(li);
  }

  const chip = el("task-chip");
  chip.hidden = false;
  chip.className = taskChipClass(job.status);
  chip.textContent = `任务：${label} ${job.done + job.failed}/${job.total}`;
  chip.title = `${typeLabel}任务`;
}

function renderRecentTasks(jobs) {
  el("task-chip").hidden = false;
  const latest = jobs[0];
  el("task-chip").className = latest ? taskChipClass(latest.status) : "badge badge--task";
  el("task-chip").textContent = latest
    ? `任务：${JOB_STATUS_LABELS[latest.status] || latest.status}`
    : "任务：无";

  const list = el("drawer-recent");
  list.innerHTML = "";
  el("drawer-recent-title").hidden = jobs.length === 0;
  for (const job of jobs) {
    const li = document.createElement("li");
    const when = (job.finished_at || job.created_at || "").slice(5, 16).replace("T", " ");
    const text = document.createElement("span");
    text.textContent =
      `${when} · ${JOB_TYPE_LABELS[job.job_type] || job.job_type} · ` +
      `${JOB_STATUS_LABELS[job.status] || job.status} · ` +
      `${job.done + job.failed}/${job.total} 页` +
      (job.failed ? `（失败 ${job.failed}）` : "");
    li.append(text);
    if (["failed", "interrupted", "cancelled", "paused"].includes(job.status)) {
      const view = document.createElement("button");
      view.type = "button";
      view.className = "btn btn--ghost";
      view.style.cssText = "font-size:11px;padding:1px 7px";
      view.textContent = "查看";
      view.addEventListener("click", async () => {
        const data = await apiJson(
          `/api/projects/${currentProject.project_id}/jobs/${job.job_id}`
        );
        renderTask(data);
      });
      li.append(view);
    }
    list.append(li);
  }
}

async function controlJob(action) {
  if (!taskJobId || !currentProject) return;
  el("drawer-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/jobs/${taskJobId}/${action}`,
      { method: "POST" }
    );
    renderTask(data);
    const stillActive = ["queued", "running", "paused"].includes(data.job.status);
    if (stillActive) {
      startTaskPolling(data.job.job_id);
    } else {
      stopTaskPolling();
      await reloadProjectPages();
      await loadTasks();
    }
  } catch (error) {
    showError(el("drawer-error"), error);
  }
}

function setupTaskDrawer() {
  el("task-chip").addEventListener("click", async () => {
    const drawer = el("task-drawer");
    if (!drawer.hidden) {
      closeTaskDrawer();
      return;
    }
    await loadTasks({ openDrawer: true });
  });
  el("drawer-close").addEventListener("click", closeTaskDrawer);
  el("job-pause").addEventListener("click", () => controlJob("pause"));
  el("job-resume").addEventListener("click", () => controlJob("resume"));
  el("job-cancel").addEventListener("click", () => controlJob("cancel"));
  el("job-retry").addEventListener("click", () => controlJob("retry-failed"));
}

// ---------------------------------------------------------------- 审校视图（本页）

let detailPageNo = null;
let detailImagePageNo = null;
let reviewBlocks = [];
let reviewSaveTimer = null;
let reviewPendingSave = null; // {block, text}：还没发出去的自动保存
/** 每个块编辑框最后的光标位置：拆分要用它（点菜单会让编辑框失焦）。 */
const cursorByBlock = new Map();

const BLOCK_TYPE_LABELS = {
  heading: "标题", paragraph: "段落", header: "页眉", footer: "页脚",
  page_number: "页码", footnote: "脚注", caption: "图注", other: "其他",
};
const REVIEW_STATUS_LABELS = {
  unreviewed: "未审", confirmed: "已确认", uncertain: "不确定",
};

async function openPageDetail(pageNo) {
  detailPageNo = pageNo;
  el("page-detail").hidden = false;
  el("page-detail-error").hidden = true;
  await loadPageDetail(pageNo);
  el("page-detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function closePageDetail() {
  detailPageNo = null;
  if (boxCreateMode) setBoxCreateMode(false);
  candidateRunId = null;
  auxData = null;
  el("aux-panel").hidden = true;
  el("candidate-panel").hidden = true;
  el("page-detail").hidden = true;
}

async function loadPageDetail(pageNo) {
  const project = currentProject;
  if (!project) return;
  try {
    const data = await apiJson(
      `/api/projects/${project.project_id}/pages/${pageNo}/blocks`
    );
    renderPageDetail(data);
  } catch (error) {
    showError(el("page-detail-error"), error);
  }
}

function renderPageDetail(data) {
  const pageNo = data.page.page_no;
  reviewBlocks = data.blocks;

  const review = data.review || {};
  const recognition = recognitionOf(data.page);
  el("page-detail-title").textContent = `第 ${pageNo} 页 · 审校`;
  el("page-detail-meta").textContent = reviewMetaText(data);

  renderReviewBanner(data, recognition);
  renderHistoryButtons(data.history);
  const hasCandidate = recognition.status === "has_candidate";
  el("candidate-entry").hidden = !hasCandidate;
  el("candidate-open").hidden = !hasCandidate;
  if (!hasCandidate) {
    el("candidate-panel").hidden = true;
    candidateRunId = null;
  }

  // 图像按 view 档渲染；同一页重复打开时不重新拉图
  if (detailImagePageNo !== pageNo) {
    detailImagePageNo = pageNo;
    el("detail-image-status").textContent = "正在渲染…";
    el("detail-image-status").hidden = false;
    el("detail-canvas").hidden = true;
    const image = el("detail-image");
    image.onload = () => {
      el("detail-image-status").hidden = true;
      el("detail-canvas").hidden = false;
    };
    image.onerror = () => {
      el("detail-image-status").textContent = "这一页渲染失败。";
    };
    image.src =
      `/api/projects/${project_id()}/pages/${pageNo}/image?size=view` +
      `&token=${encodeURIComponent(token)}`;
  }

  drawDetailOverlay(data.blocks);
  renderReviewBlocks(data.blocks);
}

function project_id() {
  return currentProject ? currentProject.project_id : "";
}

function reviewMetaText(data) {
  const review = data.review || {};
  const divergence = divergenceOf(data);
  const parts = [
    PAGE_TYPE_LABELS[data.page.page_type] || data.page.page_type,
    `${review.block_count || 0} 块`,
    `未审 ${review.unreviewed || 0}`,
  ];
  if (review.uncertain) parts.push(`不确定 ${review.uncertain}`);
  if (review.modified) parts.push(`已修改 ${review.modified}`);
  if (divergence.lines) parts.push(`两路分歧 ${divergence.lines} 行`);
  if (data.active_run) parts.push(`${data.active_run.engine_id} ${data.active_run.engine_version}`);
  return parts.join(" · ");
}

function renderReviewBanner(data, recognition) {
  const banner = el("review-banner");
  const messages = [];
  const review = data.review || {};
  if (recognition.status === "has_candidate") {
    messages.push("这一页有更新的识别结果，但它已有人工成果，系统没有覆盖——点下面的「对比新结果」决定采用还是保留。");
  }
  if (recognition.status === "failed" && recognition.last_error) {
    messages.push(`上次识别失败：${recognition.last_error}`);
  }
  if (recognition.status === "unrecognized") {
    messages.push("这一页还没识别过。点右上角的「重新识别」。");
  }
  if (recognition.status === "running" || recognition.status === "queued") {
    messages.push("这一页正在识别或排队中，完成后块会自动出现。");
  }
  if (review.uncertain) {
    messages.push(`本页有 ${review.uncertain} 个不确定块——确认整页时它们不会被自动确认。`);
  }
  // 第二引擎的分歧（说明书 8.5）：只在有实质分歧或还没复核过时提醒
  const divergence = divergenceOf(data);
  if (divergence.lines) {
    messages.push(
      `两路复核有 ${divergence.lines} 行不一致（${divergenceSummary(divergence)}）：` +
        "块里已逐行标出，另一路候选就写在旁边，点「换成这一路」即可换过去。"
    );
  } else if (divergence.stale_blocks) {
    messages.push(
      `有 ${divergence.stale_blocks} 个块的行结构改过，逐行分歧标记对这些块不再可靠。`
    );
  }
  banner.textContent = messages.join(" ");
  banner.hidden = messages.length === 0;
}

function renderHistoryButtons(history) {
  const state = history || { undo: 0, redo: 0 };
  el("review-undo").disabled = !state.undo;
  el("review-redo").disabled = !state.redo;
  el("review-undo").textContent = state.undo ? `撤销 (${state.undo})` : "撤销";
  el("review-redo").textContent = state.redo ? `重做 (${state.redo})` : "重做";
}

function setSaveState(text, isError = false) {
  const node = el("review-save-state");
  node.textContent = text;
  node.style.color = isError ? "var(--bad-fg)" : "";
}

/** 块框：归一化坐标 → 百分比定位，因此与显示尺寸、渲染 DPI 都无关。 */
function drawDetailOverlay(blocks) {
  const overlay = el("detail-overlay");
  overlay.innerHTML = "";
  blocks.forEach((block) => {
    if (!block.bbox) return;
    const [x0, y0, x1, y1] = block.bbox;
    const box = document.createElement("div");
    box.className = "box" + (block.include ? "" : " box--excluded");
    box.dataset.blockId = block.block_id;
    box.style.left = `${x0 * 100}%`;
    box.style.top = `${y0 * 100}%`;
    box.style.width = `${(x1 - x0) * 100}%`;
    box.style.height = `${(y1 - y0) * 100}%`;
    box.title = BLOCK_TYPE_LABELS[block.block_type] || block.block_type;
    box.addEventListener("click", () => {
      const item = el("detail-blocks").querySelector(`li[data-block-id="${block.block_id}"]`);
      if (item) {
        item.querySelector("textarea").focus();
        item.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
    overlay.append(box);
  });
}

function blockCard(block, index, blocksCount) {
  const item = document.createElement("li");
  item.className = "review-block";
  item.dataset.blockId = block.block_id;
  item.dataset.index = String(index);
  if (!block.include) item.classList.add("review-block--excluded");
  if (["header", "footer", "page_number"].includes(block.block_type)) {
    item.classList.add("review-block--chrome");
  }
  const blockDivergence = divergenceOf(block);
  if (blockDivergence.chars) item.classList.add("review-block--divergence");

  const head = document.createElement("div");
  head.className = "review-block__head";

  const typeSelect = document.createElement("select");
  typeSelect.className = "review-block__type";
  typeSelect.title = "块类型（页眉 / 页脚 / 页码在导出时默认排除）";
  for (const [value, label] of Object.entries(BLOCK_TYPE_LABELS)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    typeSelect.append(option);
  }
  typeSelect.value = block.block_type;
  typeSelect.addEventListener("change", () =>
    patchBlock(block, { block_type: typeSelect.value })
  );

  const status = document.createElement("span");
  status.className =
    "status " +
    (block.review_status === "confirmed"
      ? "status--ok"
      : block.review_status === "uncertain"
      ? "status--warn"
      : "");
  status.textContent = REVIEW_STATUS_LABELS[block.review_status] || block.review_status;

  const badges = document.createElement("span");
  badges.className = "muted review-block__badges";
  const bits = [];
  if (block.modified) bits.push("● 已修改");
  if (!block.include) bits.push("已排除");
  if (block.continues_to_next) bits.push("↪ 延续下页");
  if (blockDivergence.lines) bits.push(`≠ 两路不一致 ${blockDivergence.lines} 行`);
  // 说明书 6.4：无 bbox 的块要明确显示"无位置信息"，不绘制虚假高亮
  if (!block.bbox) bits.push("无位置信息");
  badges.textContent = bits.join(" · ");

  head.append(typeSelect, status, badges);

  const textarea = document.createElement("textarea");
  textarea.className = "review-block__text";
  textarea.value = block.text;
  textarea.rows = textRows(block.text);
  textarea.spellcheck = false;
  // 拆分要用"光标在哪"，而点菜单会让编辑框失焦，因此先把位置记下来
  const rememberCursor = () => {
    cursorByBlock.set(block.block_id, textarea.selectionStart || 0);
  };
  textarea.addEventListener("select", rememberCursor);
  textarea.addEventListener("keyup", rememberCursor);
  textarea.addEventListener("click", rememberCursor);
  textarea.addEventListener("blur", rememberCursor);
  textarea.addEventListener("input", () => {
    textarea.rows = textRows(textarea.value);
    scheduleBlockSave(block, textarea.value);
  });
  textarea.addEventListener("focus", () => selectReviewBlock(block.block_id));
  textarea.addEventListener("keydown", (event) => {
    // 编辑框内保留浏览器原生的文字撤销（说明书 7.5）；Alt+↑/↓ 在块之间跳
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      focusSiblingBlock(index, event.key === "ArrowDown" ? 1 : -1);
    }
  });

  const actions = document.createElement("div");
  actions.className = "review-block__actions";
  const addButton = (label, title, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn--ghost";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", onClick);
    actions.append(button);
  };

  if (block.review_status !== "confirmed") {
    addButton("✓ 确认", "把这个块标为已确认", () =>
      patchBlock(block, { review_status: "confirmed" })
    );
  }
  addButton(
    block.review_status === "uncertain" ? "取消不确定" : "? 不确定",
    "标记 / 取消不确定（⌘/Ctrl + Shift + U）",
    () =>
      patchBlock(block, {
        review_status: block.review_status === "uncertain" ? "unreviewed" : "uncertain",
      })
  );
  addButton(
    block.include ? "排除" : "纳入",
    "排除 / 纳入导出（⌘/Ctrl + Shift + E）",
    () => patchBlock(block, { include: !block.include })
  );
  addButton(
    block.continues_to_next ? "取消延续" : "↪ 延续",
    "标记为延续到下一页（跨页段落）",
    () => patchBlock(block, { continues_to_next: !block.continues_to_next })
  );
  if (block.modified) {
    addButton("恢复原文", "把文本恢复成 OCR 原文（原文一直保留着）", () =>
      patchBlock(block, { text: block.ocr_text })
    );
    addButton("看原文", "展开 / 收起 OCR 原文", (event) => {
      const original = item.querySelector(".review-block__original");
      original.hidden = !original.hidden;
      event.target.textContent = original.hidden ? "看原文" : "收起原文";
    });
  }

  // "⋯ 更多"：结构操作（说明书 6.4 的合并 / 拆分 / 上移下移 / 新增 / 删除）
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn btn--ghost review-block__more";
  more.textContent = "⋯ 更多";
  more.title = "结构操作：合并 / 拆分 / 上移下移 / 新增 / 删除";
  const menu = document.createElement("div");
  menu.className = "review-menu";
  menu.hidden = true;
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    // 同时只开一个菜单（先记下要不要开，再统一设状态——反着写会把刚打开的又关掉）
    const willOpen = menu.hidden;
    for (const other of document.querySelectorAll("#detail-blocks .review-menu")) {
      other.hidden = true;
    }
    menu.hidden = !willOpen;
  });

  const menuItem = (label, title, onClick, disabled = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "review-menu__item";
    button.textContent = label;
    button.title = title;
    button.disabled = disabled;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.hidden = true;
      onClick();
    });
    menu.append(button);
    return button;
  };
  menuItem(
    "与上一块合并",
    "合并到上一块：文本以换行连接、坐标取并集（说明书 R4）",
    () => structureAction(block, "merge-prev"),
    index === 0
  );
  menuItem(
    "在光标处拆分",
    "在编辑框里的光标位置切开这一块（先把光标放到要拆开的地方）",
    () => structureAction(block, "split", { offset: cursorByBlock.get(block.block_id) })
  );
  menuItem("上移", "与上一块交换位置", () => structureAction(block, "move", { direction: "up" }), index === 0);
  menuItem(
    "下移",
    "与下一块交换位置",
    () => structureAction(block, "move", { direction: "down" }),
    index === blocksCount - 1
  );
  menuItem("在此块后新增一块", "新增一个空块（没有位置信息，可在图上框选位置待做）", () =>
    structureAction(block, "create")
  );
  menuItem(
    "删除这一块",
    "软删除：块不会真的消失，撤销可以恢复（说明书 5.1）",
    () => {
      if (window.confirm("删除这一块？删除是软删除，可以用「撤销」恢复。")) {
        structureAction(block, "delete");
      }
    }
  );
  actions.append(more);
  item.append(menu);

  const original = document.createElement("pre");
  original.className = "review-block__original";
  original.hidden = true;
  original.textContent = block.ocr_text;

  item.append(head, textarea);
  const divergenceSection = blockDivergenceSection(block, textarea);
  if (divergenceSection) item.append(divergenceSection);
  item.append(actions, original);
  return item;
}

// ---------------------------------------------------------------- 分歧标记（说明书 8.5）

/** 一块里最多逐条列出几行分歧；再多就交给「第二引擎复核」面板。 */
const MAX_DIVERGENCE_ROWS = 8;

/**
 * 块里的分歧：逐行给出另一路的候选，点一下换过去（说明书 8.5 的 MVP 落点）。
 *
 * 标记是**块里现在的文本**与第二引擎候选的比较（后端算的），所以采纳之后
 * 这一行会自动从列表里消失——标记始终反映当下的状态。
 */
function blockDivergenceSection(block, textarea) {
  const divergence = divergenceOf(block);
  const marks = divergence.marks || [];
  if (!marks.length && !divergence.stale) return null;

  const box = document.createElement("div");
  box.className = "divergence";

  if (divergence.stale) {
    const note = document.createElement("p");
    note.className = "divergence__note";
    note.textContent =
      "这一块的行结构改过（增删过换行），逐行分歧标记会指错地方，已暂时收起——" +
      "重新识别这一页就能重新得到标记。";
    box.append(note);
    return box;
  }

  const head = document.createElement("div");
  head.className = "divergence__head";
  const badge = document.createElement("span");
  badge.className = "divergence__badge";
  badge.textContent = divergence.lines
    ? `≠ ${divergence.lines} 行两路不一致`
    : "两路没有实质分歧";
  const detail = document.createElement("span");
  detail.className = "muted";
  detail.textContent = divergenceSummary(divergence);
  head.append(badge, detail);
  box.append(head);

  const list = document.createElement("ol");
  list.className = "divergence__lines";
  for (const mark of marks.slice(0, MAX_DIVERGENCE_ROWS)) {
    const row = document.createElement("li");
    row.className = "divergence__line";

    const where = document.createElement("button");
    where.type = "button";
    where.className = "divergence__goto";
    where.textContent = `第 ${mark.line_index + 1} 行`;
    where.title = "在编辑框里选中这一行，和原图对照着看";
    where.addEventListener("click", () => selectLineInTextarea(textarea, mark.line_index));

    const level = document.createElement("span");
    level.className = `divergence__level divergence__level--${mark.level}`;
    level.textContent = DIVERGENCE_LEVEL_LABELS[mark.level] || mark.level;

    const candidate = document.createElement("span");
    candidate.className = "divergence__candidate";
    candidate.textContent = mark.candidate
      ? `第二引擎：${truncate(mark.candidate, 60)}`
      : "第二引擎没读出这一行（没有候选）";
    candidate.title = mark.candidate;

    row.append(where, level, candidate);
    if (mark.candidate) {
      const adopt = document.createElement("button");
      adopt.type = "button";
      adopt.className = "btn btn--ghost";
      adopt.textContent = "换成这一路";
      adopt.title = "把这一行换成第二引擎的文本（一次普通编辑，可撤销）";
      adopt.addEventListener("click", () =>
        adoptLine(block, mark.line_index, mark.candidate)
      );
      row.append(adopt);
    }
    list.append(row);
  }
  box.append(list);

  if (marks.length > MAX_DIVERGENCE_ROWS) {
    const rest = document.createElement("p");
    rest.className = "muted";
    rest.textContent =
      `还有 ${marks.length - MAX_DIVERGENCE_ROWS} 行，按「第二引擎复核」看全部。`;
    box.append(rest);
  }
  if (divergence.chars) {
    const hint = document.createElement("p");
    hint.className = "divergence__note";
    hint.textContent =
      "实测量过：第二引擎比第一引擎弱——被标出的分歧里约八成是它自己的错" +
      "（以汉字错误为主），但标记能圈进第一引擎约 2/3 的错行。" +
      "所以标记只回答「看哪里」，候选只作参考（改对率约 1/4），换不换由你判断。";
    box.append(hint);
  }
  return box;
}

/** 在编辑框里选中某一行——用浏览器原生的选中当"高亮"，不另做一套。 */
function selectLineInTextarea(textarea, lineIndex) {
  const lines = textarea.value.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  let start = 0;
  for (let i = 0; i < lineIndex; i += 1) start += lines[i].length + 1;
  textarea.focus();
  textarea.setSelectionRange(start, start + lines[lineIndex].length);
  textarea.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** 长文本截断（只在界面上截，标题里带全文）。 */
function truncate(text, limit) {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function textRows(text) {
  return Math.min(Math.max(String(text).split("\n").length, 2), 14);
}

function renderReviewBlocks(blocks) {
  const list = el("detail-blocks");
  list.innerHTML = "";
  if (!blocks.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "这一页没有块。";
    list.append(empty);
    return;
  }
  blocks.forEach((block, index) => list.append(blockCard(block, index, blocks.length)));
}

function selectReviewBlock(blockId) {
  for (const item of el("detail-blocks").children) {
    item.classList.toggle("active", item.dataset.blockId === blockId);
  }
  for (const box of el("detail-overlay").children) {
    const isActive = box.dataset.blockId === blockId;
    box.classList.toggle("box--active", isActive);
    if (isActive) box.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function focusSiblingBlock(index, delta) {
  const items = [...el("detail-blocks").querySelectorAll(".review-block")];
  const target = items[index + delta];
  if (target) {
    target.querySelector("textarea").focus();
    target.scrollIntoView({ block: "nearest" });
  }
}

// ---------------------------------------------------------------- 自动保存与撤销

/** 输入停下来再存：打字过程中不发请求（说明书 6.4 的"自动保存"）。 */
function scheduleBlockSave(block, text) {
  setSaveState("正在输入…");
  if (reviewSaveTimer) clearTimeout(reviewSaveTimer);
  reviewPendingSave = { block, text };
  reviewSaveTimer = setTimeout(() => {
    flushPendingSave();
  }, 700);
}

/**
 * 立刻把还没发的自动保存落库。
 *
 * 需要它是因为"替换某一行"这类操作会用**服务端的最新文本**重写整个块：
 * 不等输入落库就替换，会把刚打的字盖掉。
 */
async function flushPendingSave() {
  if (reviewSaveTimer) {
    clearTimeout(reviewSaveTimer);
    reviewSaveTimer = null;
  }
  const pending = reviewPendingSave;
  reviewPendingSave = null;
  if (pending) await patchBlock(pending.block, { text: pending.text });
}

/** 把某一行换成另一路的文本（说明书 8.5：作为对 text 的编辑，可撤销）。 */
async function adoptLine(block, lineIndex, candidate) {
  if (!block) return;
  if (!candidate) {
    setSaveState("第二引擎没读出这一行，没有可采用的候选", true);
    return;
  }
  await flushPendingSave();
  // 上面可能刚保存过并重载了页面，用重载后的块（revision 才是最新的）
  const fresh =
    (reviewBlocks || []).find((item) => item.block_id === block.block_id) || block;
  const lines = String(fresh.text).split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) {
    setSaveState("这一块的行号对不上了，先重新载入", true);
    return;
  }
  lines[lineIndex] = candidate;
  await patchBlock(fresh, { text: lines.join("\n") });
}

async function patchBlock(block, patch) {
  if (!currentProject) return;
  setSaveState("保存中…");
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/blocks/${block.block_id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...patch,
          // 乐观并发检查（说明书第 11 节）：拿手上的版本去对，冲突就报错而不是覆盖
          expected_revision: block.revision,
        }),
      }
    );
    setSaveState("已保存 ✓");
    await loadPageDetail(detailPageNo);
    await refreshPageStates();
  } catch (error) {
    if (error.code === "block_conflict") {
      setSaveState("这一页在别处被改过，已重新载入", true);
      await loadPageDetail(detailPageNo);
      return;
    }
    setSaveState(error.message || "保存失败", true);
  }
}

/** 结构操作：合并 / 拆分 / 上移下移 / 新增 / 删除（都改结构，都能撤销）。 */
async function structureAction(block, operation, payload = {}) {
  if (!currentProject) return;
  const projectId = currentProject.project_id;
  setSaveState("处理中…");
  try {
    let data;
    if (operation === "merge-prev") {
      data = await apiJson(`/api/projects/${projectId}/blocks/${block.block_id}/merge-prev`, {
        method: "POST",
      });
    } else if (operation === "split") {
      if (!payload.offset) {
        setSaveState("先把光标放到要拆开的位置", true);
        return;
      }
      data = await apiJson(`/api/projects/${projectId}/blocks/${block.block_id}/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset: payload.offset }),
      });
    } else if (operation === "move") {
      data = await apiJson(`/api/projects/${projectId}/blocks/${block.block_id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: payload.direction }),
      });
    } else if (operation === "create") {
      data = await apiJson(`/api/projects/${projectId}/pages/${detailPageNo}/blocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_no: detailPageNo, after_block_id: block.block_id }),
      });
    } else if (operation === "delete") {
      data = await apiJson(`/api/projects/${projectId}/blocks/${block.block_id}`, {
        method: "DELETE",
      });
    }
    cursorByBlock.clear();
    setSaveState("已保存 ✓");
    await loadPageDetail(detailPageNo);
    await refreshPageStates();
    // 新增的块直接聚焦，省一次点击
    if (operation === "create" && data && data.created) {
      const item = el("detail-blocks").querySelector(
        `li[data-block-id="${data.created.block_id}"]`
      );
      if (item) item.querySelector("textarea").focus();
    }
  } catch (error) {
    setSaveState(error.message || "操作失败", true);
    showError(el("page-detail-error"), error);
  }
}

// ---------------------------------------------------------------- 新识别结果对比（R2）

let candidateRunId = null;

async function openCandidateCompare() {
  if (!currentProject || detailPageNo === null) return;
  const projectId = currentProject.project_id;
  el("page-detail-error").hidden = true;
  try {
    const data = await apiJson(`/api/projects/${projectId}/pages/${detailPageNo}/candidate`);
    candidateRunId = data.run.run_id;
    renderCandidate(data);
  } catch (error) {
    showError(el("page-detail-error"), error);
  }
}

function renderCandidate(data) {
  const panel = el("candidate-panel");
  panel.hidden = false;
  const notes = [
    `${data.run.engine_id} ${data.run.engine_version}`,
    data.run.finished_at ? data.run.finished_at.slice(0, 19).replace("T", " ") : "",
    `${data.candidate.blocks.length} 块`,
    data.candidate.regrouped ? "（这次运行的原始输出里没有分段，按当前规则重新分了一次）" : "",
  ].filter(Boolean);
  el("candidate-meta").textContent = notes.join(" · ");

  fillCandidateColumn(el("candidate-current"), data.current.blocks, null);
  fillCandidateColumn(el("candidate-new"), data.candidate.blocks, data.current.blocks);
}

/** 右列（新结果）逐块标出"与现有不同"；左列是基准，不标。 */
function fillCandidateColumn(list, blocks, currentBlocks) {
  list.innerHTML = "";
  const currentTexts = currentBlocks
    ? new Set(currentBlocks.map((block) => block.text))
    : null;
  blocks.forEach((block, index) => {
    const item = document.createElement("li");
    const same = currentTexts ? currentTexts.has(block.text) : true;
    if (currentTexts && !same) item.classList.add("is-changed");
    if (currentBlocks && block.match && block.match.target_block_id) {
      item.dataset.targetBlockId = block.match.target_block_id;
    }
    const head = document.createElement("span");
    head.className = "muted";
    const note = currentTexts ? (same ? " · 与现有相同" : " · 不同") : "";
    head.textContent = `#${index + 1}${note}`;
    const body = document.createElement("div");
    body.textContent = block.text || "（空）";
    item.append(head, body);

    // 逐块采用（说明书 6.4）：只在这一列给按钮——左边是基准，没什么可"采用"的
    if (currentBlocks) item.append(candidateBlockActions(block, index));
    list.append(item);
  });
  if (!blocks.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "（没有块）";
    list.append(empty);
  }
}

/** 新结果里这一块的"换这一块 / 加进这一页"，以及它对应现有哪一块。 */
function candidateBlockActions(block, index) {
  const match = block.match || {};
  const footer = document.createElement("div");
  footer.className = "candidate__actions";
  const label = document.createElement("span");
  label.className = "muted";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn--ghost";

  if (match.target_block_id) {
    const targetNo = (match.target_index ?? 0) + 1;
    label.textContent = `对应现有 #${targetNo}` +
      (match.iou ? `（位置重合 ${(match.iou * 100).toFixed(0)}%）` : "（按顺序配对）");
    label.title = match.iou
      ? "按块框的位置配对：两版里这一块在页面上的位置重合度"
      : "块框信息不足，按块的先后顺序配对";
    button.textContent = match.same_text ? "换成这一块（文本相同）" : "换这一块";
    button.title = `把现有 #${targetNo} 换成新结果的这一块（可撤销，其余块不动）`;
    button.addEventListener("click", () =>
      applyCandidateBlock(index, match.target_block_id, button)
    );
  } else {
    label.textContent = "这次多出来的块";
    button.textContent = "加进这一页";
    button.title = "现有块里没有对应的：按位置插进阅读顺序（可撤销）";
    button.addEventListener("click", () => applyCandidateBlock(index, null, button));
  }
  footer.append(label, button);
  return footer;
}

/** 逐块采用：换掉对应的那一块（或把多出来的块加进来）。 */
async function applyCandidateBlock(candidateIndex, targetBlockId, button) {
  if (!currentProject || detailPageNo === null || !candidateRunId) return;
  const projectId = currentProject.project_id;
  el("page-detail-error").hidden = true;
  button.disabled = true;
  try {
    const data = await apiJson(
      `/api/projects/${projectId}/pages/${detailPageNo}/runs/${candidateRunId}/apply-block`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidate_index: candidateIndex,
          target_block_id: targetBlockId,
        }),
      }
    );
    setSaveState(`已换成新结果的第 ${candidateIndex + 1} 块（可撤销）`);
    reviewBlocks = data.blocks || [];
    renderPageDetail({
      page: data.page,
      blocks: data.blocks,
      review: data.review,
      history: data.history,
      runs: [],
      active_run: null,
    });
    // 换完之后对应关系可能变了（那一块已经与现有一致），重新拉一次对比
    await openCandidateCompare();
    await refreshPageStates();
  } catch (error) {
    button.disabled = false;
    showError(el("page-detail-error"), error);
  }
}

// ---------------------------------------------------------------- 框选新增块（说明书 6.4）

/** 框选模式：在页面上拖一个框 → 给漏检的区域补一个块（不框选就是"无位置信息"）。 */
let boxCreateMode = false;
let boxDraft = null; // 归一化坐标 {x0, y0, x1, y1}，拖拽中不断更新

/** 框选出来的区域至少要有这么大，免得误点一下就冒出一个块。 */
const BOX_MIN_WIDTH = 0.02;
const BOX_MIN_HEIGHT = 0.01;

function setBoxCreateMode(on) {
  boxCreateMode = on;
  el("detail-box-create").classList.toggle("btn--primary", on);
  el("detail-canvas").classList.toggle("page-canvas--selecting", on);
  if (!on) {
    boxDraft = null;
    el("box-select-rect").hidden = true;
    el("box-select-panel").hidden = true;
  } else {
    setSaveState("在页面上拖出要新增的区域（Esc 取消）");
  }
}

/** 鼠标位置 → 相对图像的归一化坐标（说明书 5.2：相对显示方向、0–1）。 */
function normalizedPoint(event) {
  const image = el("detail-image");
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1),
    y: Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1),
  };
}

function onBoxMouseDown(event) {
  if (!boxCreateMode || event.button !== 0) return;
  const point = normalizedPoint(event);
  if (!point) return;
  event.preventDefault();
  boxDraft = { x0: point.x, y0: point.y, x1: point.x, y1: point.y };
  el("box-select-panel").hidden = true;
  drawBoxDraft();
}

function onBoxMouseMove(event) {
  if (!boxDraft) return;
  const point = normalizedPoint(event);
  if (!point) return;
  boxDraft.x1 = point.x;
  boxDraft.y1 = point.y;
  drawBoxDraft();
}

function onBoxMouseUp(event) {
  if (!boxDraft) return;
  const point = normalizedPoint(event);
  if (point) {
    boxDraft.x1 = point.x;
    boxDraft.y1 = point.y;
  }
  const box = boxDraftRect();
  if (!box || box[2] - box[0] < BOX_MIN_WIDTH || box[3] - box[1] < BOX_MIN_HEIGHT) {
    // 太小（多半是误点）：撤掉，不弹面板
    boxDraft = null;
    el("box-select-rect").hidden = true;
    return;
  }
  drawBoxDraft(); // 定住最后的样子，等用户填文字
  el("box-select-info").textContent =
    `已框选：横向 ${(box[0] * 100).toFixed(0)}–${(box[2] * 100).toFixed(0)}%、` +
    `纵向 ${(box[1] * 100).toFixed(0)}–${(box[3] * 100).toFixed(0)}%（相对这一页）`;
  el("box-select-panel").hidden = false;
  el("box-select-text").focus();
}

/** 拖拽方向任意，统一成 (x0,y0,x1,y1)。 */
function boxDraftRect() {
  if (!boxDraft) return null;
  return [
    Math.min(boxDraft.x0, boxDraft.x1),
    Math.min(boxDraft.y0, boxDraft.y1),
    Math.max(boxDraft.x0, boxDraft.x1),
    Math.max(boxDraft.y0, boxDraft.y1),
  ];
}

function drawBoxDraft() {
  const box = boxDraftRect();
  const rect = el("box-select-rect");
  if (!box) {
    rect.hidden = true;
    return;
  }
  rect.hidden = false;
  rect.style.left = `${box[0] * 100}%`;
  rect.style.top = `${box[1] * 100}%`;
  rect.style.width = `${(box[2] - box[0]) * 100}%`;
  rect.style.height = `${(box[3] - box[1]) * 100}%`;
}

async function createBlockFromBox() {
  const box = boxDraftRect();
  if (!currentProject || detailPageNo === null || !box) return;
  el("page-detail-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${detailPageNo}/blocks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: el("box-select-text").value, bbox: box }),
      }
    );
    setSaveState("已新增块（可撤销）");
    const created = data.created;
    el("box-select-text").value = "";
    setBoxCreateMode(false);
    // 与"在此块后新增"走同一条刷新路径（新建接口的响应里没有整页载荷）
    await loadPageDetail(detailPageNo);
    await refreshPageStates();
    if (created) {
      const item = el("detail-blocks").querySelector(`li[data-block-id="${created.block_id}"]`);
      if (item) {
        item.querySelector("textarea").focus();
        item.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  } catch (error) {
    showError(el("page-detail-error"), error);
  }
}

function setupBoxCreate() {
  el("detail-box-create").addEventListener("click", () => setBoxCreateMode(!boxCreateMode));
  const canvas = el("detail-canvas");
  canvas.addEventListener("mousedown", onBoxMouseDown);
  window.addEventListener("mousemove", onBoxMouseMove);
  window.addEventListener("mouseup", onBoxMouseUp);
  el("box-select-confirm").addEventListener("click", createBlockFromBox);
  el("box-select-cancel").addEventListener("click", () => setBoxCreateMode(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && boxCreateMode) setBoxCreateMode(false);
  });
}

async function decideCandidate(decision) {
  if (!currentProject || detailPageNo === null || !candidateRunId) return;
  const projectId = currentProject.project_id;
  el("page-detail-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${projectId}/pages/${detailPageNo}/runs/${candidateRunId}/${decision}`,
      { method: "POST" }
    );
    el("candidate-panel").hidden = true;
    candidateRunId = null;
    setSaveState(decision === "apply" ? "已采用新结果（可撤销）" : "已保留现有结果");
    reviewBlocks = data.blocks || [];
    renderPageDetail({
      page: data.page,
      blocks: data.blocks,
      review: data.review,
      history: data.history,
      runs: [],
      active_run: null,
    });
    await refreshPageStates();
  } catch (error) {
    showError(el("page-detail-error"), error);
  }
}

async function reviewAction(path) {
  if (!currentProject) return null;
  el("page-detail-error").hidden = true;
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/${path}`, {
      method: "POST",
    });
    setSaveState(data.direction === "undo" ? "已撤销" : "已重做");
    await loadPageDetail(detailPageNo);
    await refreshPageStates();
    return data;
  } catch (error) {
    showError(el("page-detail-error"), error);
    return null;
  }
}

async function confirmCurrentPage() {
  if (detailPageNo === null) return;
  const pageNo = detailPageNo;
  el("page-detail-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${pageNo}/confirm`,
      { method: "POST" }
    );
    setSaveState(
      data.uncertain
        ? `已确认 ${data.confirmed} 块；本页仍有 ${data.uncertain} 个不确定项`
        : `已确认 ${data.confirmed} 块`
    );
    await refreshPageStates();
    // 说明书 7.4："确认本页后默认跳到下一个未完成的纳入页"
    const next = nextUnfinishedPage(pageNo);
    if (next) await openPageDetail(next);
    else setSaveState("整本书都审完了 🎉");
  } catch (error) {
    showError(el("page-detail-error"), error);
  }
}

/** 下一个还没审完的纳入页（有未审或不确定的块）。 */
function nextUnfinishedPage(afterPageNo) {
  const next = currentProject.pages.find((page) => {
    if (!page.include || page.page_no <= afterPageNo) return false;
    const review = page.review || {};
    return (review.unreviewed || 0) > 0 || (review.uncertain || 0) > 0;
  });
  return next ? next.page_no : null;
}

function setupReviewControls() {
  // 点别处关掉所有"⋯ 更多"菜单（只挂一次，别每次渲染都加一个监听）
  document.addEventListener("click", () => {
    for (const menu of document.querySelectorAll("#detail-blocks .review-menu")) {
      menu.hidden = true;
    }
  });
  el("review-confirm").addEventListener("click", confirmCurrentPage);
  el("candidate-open").addEventListener("click", openCandidateCompare);
  el("candidate-apply").addEventListener("click", () => decideCandidate("apply"));
  el("candidate-decline").addEventListener("click", () => decideCandidate("decline"));
  el("candidate-close").addEventListener("click", () => {
    el("candidate-panel").hidden = true;
  });
  el("review-undo").addEventListener("click", () => reviewAction("undo"));
  el("review-redo").addEventListener("click", () => reviewAction("redo"));

  document.addEventListener("keydown", (event) => {
    if (!currentProject || detailPageNo === null) return;
    const active = document.activeElement || {};
    const inEditor = ["TEXTAREA", "INPUT", "SELECT"].includes(active.tagName);
    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.key === "Enter") {
      event.preventDefault();
      confirmCurrentPage();
      return;
    }
    // 编辑框内保留浏览器原生的文字撤销（说明书 7.5）
    if (inEditor) return;
    if (mod && event.shiftKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      reviewAction("redo");
    } else if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      reviewAction("undo");
    }
  });
}

/** 批量改页面的类型 / 纳入（说明书 6.2 的批量操作，第 11 节的 PATCH /pages）。 */
async function patchSelectedPages(patch) {
  const project = currentProject;
  const pages = selectionPages();
  if (!project || !pages.length) return;

  el("pages-error").hidden = true;
  try {
    const data = await apiJson(`/api/projects/${project.project_id}/pages`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_ids: pages.map((page) => page.page_id), ...patch }),
    });
    for (const updated of data.pages) {
      const index = project.pages.findIndex((page) => page.page_id === updated.page_id);
      if (index >= 0) project.pages[index] = updated;
    }
    renderPages();
    renderProjectMeta();
  } catch (error) {
    showError(el("pages-error"), error);
  }
}

async function recognizeSelection() {
  const project = currentProject;
  const pages = selectionPages().filter((page) => page.include);
  if (!project || !pages.length) return;

  el("pages-error").hidden = true;
  const skip = el("selection-skip-recognized").checked;
  try {
    const data = await apiJson(`/api/projects/${project.project_id}/jobs/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pages: pages.map((page) => page.page_no),
        skip_recognized: skip,
      }),
    });
    applyRecognizedPages(data.pages);
    renderPages();
    openTaskDrawer();
    startTaskPolling(data.job.job_id);
  } catch (error) {
    showError(el("pages-error"), error);
  }
}

async function closeProject() {
  if (!currentProject) return;
  try {
    await apiJson(`/api/projects/${currentProject.project_id}/close`, { method: "POST" });
  } catch (error) {
    showError(el("library-error"), error);
    return;
  }
  currentProject = null;
  el("project-card").hidden = true;
  closePageDetail();
  closeTaskDrawer();
  stopTaskPolling();
  el("task-chip").hidden = true;
  await loadLibrary();
}

function setupLibrary() {
  const picker = el("new-project-file");
  el("pick-pdf").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    if (picker.files && picker.files[0]) createProjectFromFile(picker.files[0]);
    picker.value = "";
  });
  el("project-close").addEventListener("click", closeProject);
  el("settings-save").addEventListener("click", saveSettingsName);
  el("first-run-save").addEventListener("click", async () => {
    el("settings-name").value = el("first-run-name").value;
    await saveSettingsName();
  });
  el("first-run-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      el("settings-name").value = el("first-run-name").value;
      saveSettingsName();
    }
  });
  el("diagnostics-export").addEventListener("click", exportDiagnostics);
  el("detail-close").addEventListener("click", closePageDetail);
  setupReviewControls();
  setupBoxCreate();
  setupAuxControls();
  el("recognize-pending").addEventListener("click", () => startBatchRecognition("unrecognized"));
  el("selection-check").addEventListener("click", () => checkSelection(null));
  el("check-pending").addEventListener("click", () => checkSelection("unchecked"));
  el("stats-refresh").addEventListener("click", loadSummary);
  setupTaskDrawer();

  // 筛选与选择（说明书 6.2）
  el("filter-type").addEventListener("change", renderPages);
  el("filter-recognition").addEventListener("change", renderPages);
  el("filter-triage").addEventListener("change", renderPages);
  el("pages-only-included").addEventListener("change", renderPages);
  el("page-range-select").addEventListener("click", applyPageRangeInput);
  el("page-range").addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyPageRangeInput();
  });
  el("selection-all").addEventListener("click", () => {
    for (const page of visiblePages()) selectedPages.add(page.page_no);
    renderPages();
  });
  el("selection-clear").addEventListener("click", () => {
    selectedPages.clear();
    selectionAnchor = null;
    renderPages();
  });
  el("selection-set-type").addEventListener("click", () =>
    patchSelectedPages({ page_type: el("selection-type").value })
  );
  el("selection-include").addEventListener("click", () => patchSelectedPages({ include: true }));
  el("selection-exclude").addEventListener("click", () => patchSelectedPages({ include: false }));
  el("selection-recognize").addEventListener("click", recognizeSelection);
  el("detail-recognize").addEventListener("click", () => {
    if (detailPageNo === null) return;
    const page = currentProject.pages.find((item) => item.page_no === detailPageNo);
    if (page) recognizePage(page);
  });
}

// ---------------------------------------------------------------- 启动

function boot() {
  // Esc 清空选择（说明书 6.2 的选择方式之外的顺手约定）
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && currentProject && selectedPages.size) {
      selectedPages.clear();
      selectionAnchor = null;
      renderPages();
    }
  });
  if (!token) {
    const warning = el("platform-warning");
    warning.innerHTML = "缺少会话令牌。请使用启动时终端里打印的" +
      "<strong>完整界面地址</strong>（带 <code>?token=…</code>）打开本页。";
    warning.hidden = false;
  }
  setupLibrary();
  setupExportPanel();
  setupStructurePanel();
  loadAppInfo();
  loadLibrary();
}

boot();
