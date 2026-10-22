"use strict";

/**
 * Book2Text 的前端（原生 JS + 一份 CSS，无构建步骤）。
 *
 * 界面版式按 docs/ui-mockups/ 的效果图落地；说明书里的 Vue 3 + TS + Vite
 * 属于后续阶段的正式前端形态，当前有意不引入（见 docs/decisions.md D-046）。
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

// ---------------------------------------------------------------- 外壳：视图与对话框
//
// 界面是"单窗口应用"（说明书第 7 节的效果图）：顶栏 + 四个视图（项目库 / 页面 /
// 审校 / 合并审阅）+ 若干对话框。视图之间只切换 hidden，各视图内部状态各自保留。

const VIEWS = ["library", "pages", "review", "merge"];

let currentView = "library";

function showView(name) {
  if (!VIEWS.includes(name)) return;
  // 没有打开项目时，只有项目库是可达的
  const target = currentProject || name === "library" ? name : "library";
  currentView = target;
  document.body.dataset.view = target;
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== target;
  el("topbar-library").hidden = target !== "library";
  el("topbar-project").hidden = target === "library";
  el("review-pager").hidden = target !== "review";
  for (const button of el("view-tabs").querySelectorAll("[data-view-btn]")) {
    button.classList.toggle("is-on", button.dataset.viewBtn === target);
  }
  if (target !== "review") closeTaskDrawer();
  if (target === "pages" && currentProject) {
    // 回到页面视图时以数据库为准重拉一次：确认进度与类型不在前端缓存里说了算
    renderPageSetup();
    refreshPageStates();
    if (!setupSuggestionsLoaded && currentProject.kind !== "package") {
      loadSetupSuggestions();
    }
  }
}

/** 打开一个对话框（.mask）。同一时刻允许多层，但退出键只关最上面一个。 */
function openModal(id) {
  const node = el(id);
  if (!node) return;
  node.hidden = false;
}

function closeModal(id) {
  const node = el(id);
  if (!node) return;
  node.hidden = true;
  // 结构工具的候选勾选、导出对照这类"临时状态"随手收起来，下次打开是干净的
  if (id === "structure-panel") {
    structureCandidates = [];
    el("structure-result").hidden = true;
  }
  if (id === "export-panel") el("export-compare").hidden = true;
}

const openMasks = () => [...document.querySelectorAll(".mask")].filter((node) => !node.hidden);

/** 顶栏上的"新建项目"：先要个书名（可留空），再选 PDF。 */
function setupNewProjectModal() {
  const picker = el("new-project-file");
  const openPicker = () => picker.click();
  el("pick-pdf").addEventListener("click", () => {
    el("new-project-name").value = "";
    el("new-project-modal-error").hidden = true;
    openModal("new-project-mask");
    el("new-project-name").focus();
  });
  el("new-project-cancel").addEventListener("click", () => closeModal("new-project-mask"));
  el("new-project-cancel-x").addEventListener("click", () => closeModal("new-project-mask"));
  el("new-project-pick").addEventListener("click", openPicker);
  el("new-project-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") openPicker();
  });
}

function setupShell() {
  setupNewProjectModal();
  for (const button of el("view-tabs").querySelectorAll("[data-view-btn]")) {
    button.addEventListener("click", () => {
      showView(button.dataset.viewBtn);
      // 上次位置（说明书 7.2）：切到页面视图就记下"在页面视图"
      savePosition(button.dataset.viewBtn, detailPageNo);
      // 进审校视图总要有页可看：上次那一页 → 第一个没审完的页 → 第一页
      if (button.dataset.viewBtn === "review") ensureReviewPage();
    });
  }
  el("settings-open").addEventListener("click", () => openModal("settings-panel"));
  el("settings-close").addEventListener("click", () => closeModal("settings-panel"));
  el("stats-open").addEventListener("click", () => {
    openModal("stats-panel");
    loadSummary();
  });
  el("stats-close").addEventListener("click", () => closeModal("stats-panel"));
  el("structure-open").addEventListener("click", () => openModal("structure-panel"));
  el("structure-close").addEventListener("click", () => closeModal("structure-panel"));
  el("structure-cancel").addEventListener("click", () => closeModal("structure-panel"));
  el("export-open").addEventListener("click", async () => {
    openModal("export-panel");
    await refreshExportPreflight();
    await loadExports();
  });
  el("export-close").addEventListener("click", () => closeModal("export-panel"));
  el("export-cancel").addEventListener("click", () => closeModal("export-panel"));
  el("package-result-close").addEventListener("click", () => closeModal("package-result"));
  el("package-open").addEventListener("click", () => openModal("package-result"));
  el("selection-review-open").addEventListener("click", () => {
    const first = selectionPages()[0] || visiblePages()[0];
    showView("review");
    if (first) openPageDetail(first.page_no);
  });
  el("detail-close").addEventListener("click", () => showView("pages"));

  // 点遮罩空白处 = 关闭（点对话框内部不关）
  for (const mask of document.querySelectorAll(".mask")) {
    mask.addEventListener("mousedown", (event) => {
      if (event.target === mask && mask.id !== "first-run-card") closeModal(mask.id);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const masks = openMasks();
    if (masks.length && masks[0].id !== "first-run-card") {
      closeModal(masks[masks.length - 1].id);
    }
  });
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
  badge.className = `chip ${info.platform.supported ? "chip--gray" : "chip--bad"}`;

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
    page_types: el("structure-body-only").checked
      ? ["body"]
      : ["body", "body_excluded", "toc", "front", "back"],
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
    page_markers: el("export-page-markers").checked,
    exclude_header_footer: el("export-rule-header").checked,
    merge_lines_in_block: el("export-rule-merge").checked,
    restore_hyphenation: el("export-rule-hyphen").checked,
    normalize_newlines: el("export-rule-newlines").checked,
    strip_line_whitespace: el("export-rule-strip").checked,
  };
}

function renderPreflight(data) {
  const streams = data.streams || {};
  const body = streams.body || { segments: data.segment_count || 0, chars: data.char_count || 0 };
  const noteStream = streams.notes || { notes: data.notes_count || 0, chars: data.notes_char_count || 0 };
  const meta = streams.meta || { pages: 0, printed_page_found: 0, printed_page_missing: [] };
  const mapping = data.page_number_mapping || {
    found: meta.printed_page_found || 0,
    total: meta.pages || 0,
    missing_pages: meta.printed_page_missing || [],
  };
  const rows = [
    ["导出页数", `${data.exported_pages.length} 页`],
    ["正文段数", `${body.segments || 0} 段`],
    ["正文字数", `${body.chars || 0} 字`],
    ["注释条数", `${noteStream.notes || 0} 条`],
    ["注释字数", `${noteStream.chars || 0} 字`],
    ["元数据页数", `${meta.pages || 0} 页`],
    ["页码映射", `${mapping.found || 0} / ${mapping.total || 0} 页`],
    ["跨块合并的段", `${data.merged_segments} 段`],
    ["断词还原", `${data.hyphenations_restored} 处`],
    ["未审校的段", `${data.unreviewed_segments} 段`],
    ["不确定的段", `${data.uncertain_segments} 段`],
    ["正文不收的块类型", data.excluded_block_types.length ? data.excluded_block_types.join("、") : "（无）"],
    ["版面已确认", `${data.layout_confirmed_blocks || 0} / ${data.layout_blocks || 0} 块`],
  ];
  fillDefinitionList(el("export-preflight"), rows);

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
  if (!(noteStream.notes || 0)) {
    notes.push("注释流为空（没有脚注块）——这是正常情况。");
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
  if (!data.layout_confirmed_blocks) {
    notes.push(
      "整本还没有确认过任何版面块。自动分块在这本书上实测是准的，" +
        "**导出不受影响**；有疑问的页可以在审校视图里拖动块框、改类型、调顺序，再点「确认版面」。"
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
  el("export-scope").textContent = exportScopeText(options);
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

/** 一句话说清"按现在这些勾选，到底要导出什么"。 */
function exportScopeText(options) {
  const format = { txt: "TXT", jsonl: "JSONL", both: "TXT + JSONL" }[options.format] || options.format;
  const parts = [format];
  if (options.page_numbers && options.page_numbers.length) {
    parts.push(`第 ${options.page_numbers[0]}–${options.page_numbers[options.page_numbers.length - 1]} 页（${options.page_numbers.length} 页）`);
  } else {
    parts.push("全书");
  }
  if (options.confirmed_only) parts.push("仅已确认");
  return parts.join(" · ");
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
      " #export-page-markers," +
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

/**
 * 页面类型（五类，2026-10-22 用户拍板）：**去留由类型决定**，没有单独的纳入 / 排除开关。
 * 只有「正文」进识别与语料；其余四类都不进。
 */
const PAGE_TYPE_LABELS = {
  body: "正文", body_excluded: "正文排除", toc: "目录", front: "前置", back: "后置",
};
/** 右栏类型列表的顺序：正文 / 正文排除最常用，放前面。 */
const PAGE_TYPE_ORDER = ["body", "body_excluded", "toc", "front", "back"];

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
  unrecognized: "chip--gray",
  queued: "chip--warn",
  running: "chip--warn",
  recognized: "chip--ok",
  failed: "chip--bad",
  has_candidate: "chip--warn",
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
  chip.className = "chip " + (divergence.chars ? "chip--warn" : "chip--gray");
  chip.textContent = divergence.chars ? `≠ ${divergence.chars}` : "≈ 标点级";
  chip.title =
    `两路复核：${divergenceSummary(divergence)}\n` +
    "汉字级 = 两路在汉字 / 数字上不一致，标点级 = 只差标点 / 符号。\n" +
    "两类都值得看一眼：实测（40 页真书）标出的分歧里约八成是第二引擎自己的错（以汉字为主），" +
    "但标记能圈进第一引擎约 2/3 的错行——见 docs/ocr-evaluation.md 第 9 节";
  return chip;
}

/** 当前打开的是不是审校任务包项目（助手端，说明书 6.7.3）。 */
function isPackageProject() {
  return Boolean(currentProject && currentProject.kind === "package");
}

/**
 * 任务包里的页面：块是随包带进来的快照，**没有识别运行记录**。
 *
 * 后端按 `active_run_id` 推导识别状态，任务包里它为空，于是这些页会被算成
 * "未识别"——但助手明明有块可审。界面按"已带入 N 块"显示，免得助手以为
 * 要自己重新识别（任务包里也没有"重新识别"这个功能）。
 */
function packageBlocksOnly(page) {
  const recognition = recognitionOf(page);
  return (
    isPackageProject() &&
    recognition.status === "unrecognized" &&
    recognition.block_count > 0
  );
}

function recognitionText(page) {
  if (packageBlocksOnly(page)) {
    return `已带入 ${recognitionOf(page).block_count} 块`;
  }
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
    "chip " +
    (review.status === "done"
      ? "chip--ok"
      : review.status === "questioned"
      ? "chip--bad"
      : "chip--gray");
  chip.textContent =
    review.status === "questioned" ? `${label} ${review.uncertain}` : label;
  return chip;
}

function recognitionChip(page) {
  const recognition = recognitionOf(page);
  const chip = document.createElement("span");
  chip.className =
    "chip " +
    (packageBlocksOnly(page)
      ? "chip--gray"
      : RECOGNITION_CLASSES[recognition.status] || "chip--gray");
  chip.textContent = recognitionText(page);
  if (packageBlocksOnly(page)) {
    chip.title = "任务包里带进来的块（快照）。任务包不重新识别，直接审校。";
  } else if (recognition.last_error) {
    chip.title = `上次失败：${recognition.last_error}`;
  }
  return chip;
}

async function loadLibrary() {
  el("library-warning").hidden = true;
  try {
    const data = await apiJson("/api/projects");
    el("library-path").textContent = data.library_dir;
    renderProjectList(data.projects);
  } catch (error) {
    showError(el("library-error"), error);
  }
}

/** 进度条的百分比：分母为 0 时返回 0（还没纳入任何页）。 */
function progressPercent(done, total) {
  const top = Number(done || 0);
  const bottom = Number(total || 0);
  if (!bottom) return 0;
  return Math.min(100, Math.round((top / bottom) * 100));
}

/** "12 / 300 页"这行数字：字段缺失时按 0 算，不显示 undefined。 */
function ratioText(done, total) {
  return `${Number(done || 0)} / ${Number(total || 0)} 页`;
}

/** 上次编辑时间的口语写法：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
function timeAgo(stamp) {
  if (!stamp) return "还没打开过";
  const then = new Date(stamp);
  if (Number.isNaN(then.getTime())) return stamp.slice(0, 10);
  const minutes = Math.floor((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return stamp.slice(0, 10);
}

/** 项目库卡片（效果图 01）：封面、元信息、识别 / 审校两条进度、上次位置、继续 / 打开。 */
function renderProjectList(projects) {
  const list = el("project-list");
  list.innerHTML = "";
  el("library-empty").hidden = projects.length > 0;

  projects.forEach((entry, index) => {
    const card = document.createElement("li");
    card.className = "pcard" + (entry.lock_held ? " pcard--locked" : "");
    card.dataset.projectId = entry.project_id;

    const cover = document.createElement("div");
    cover.className = `pcard__cover v${index % 4}`;
    cover.textContent = entry.name.slice(0, 12);

    const body = document.createElement("div");
    body.className = "pcard__body";

    const title = document.createElement("div");
    title.className = "pcard__title";
    const name = document.createElement("span");
    name.textContent = `《${entry.name}》`;
    title.append(name);
    if (entry.kind === "package") {
      const chip = document.createElement("span");
      chip.className = "chip chip--blue";
      chip.textContent = "审校任务";
      chip.title = "助手端项目：别人分派给你的审校任务包";
      title.append(chip);
    }
    if (entry.lock_held) {
      const chip = document.createElement("span");
      chip.className = "chip chip--warn";
      chip.textContent = "使用中";
      chip.title = `${entry.lock_reason}：另一个窗口正在写这个项目`;
      title.append(chip);
    }
    if (entry.text_layer_hint) {
      const chip = document.createElement("span");
      chip.className = "chip chip--gray";
      chip.textContent = "可能已含文本";
      chip.title = `${entry.pages_with_text_layer} / ${entry.page_count} 页已有文本层，可能不需要识别`;
      title.append(chip);
    }

    const meta = document.createElement("div");
    meta.className = "pcard__meta";
    meta.textContent =
      `${entry.source_file_name} · 共 ${entry.page_count} 页 · 正文 ${entry.included_pages} 页` +
      ` · 上次编辑：${timeAgo(entry.updated_at)}`;

    body.append(title, meta, progressRow("识别", entry.recognized_pages, entry.included_pages, recognitionExtra(entry)));
    body.append(progressRow("审校", entry.reviewed_pages, entry.included_pages, reviewExtra(entry)));

    const loc = document.createElement("div");
    loc.className = "pcard__loc";
    loc.textContent = `⌖ 上次位置：${lastPositionText(entry)}`;
    body.append(loc);

    const actions = document.createElement("div");
    actions.className = "pcard__actions";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn btn--pri";
    open.textContent = "打开";
    open.addEventListener("click", () => openProject(entry.project_id));
    actions.append(open);
    if (entry.lock_held) {
      const readOnly = document.createElement("button");
      readOnly.type = "button";
      readOnly.className = "btn";
      readOnly.textContent = "只读打开";
      readOnly.addEventListener("click", () => openProject(entry.project_id, { readOnly: true }));
      const force = document.createElement("button");
      force.type = "button";
      force.className = "btn btn--danger";
      force.textContent = "强制打开";
      force.title = "有让两台电脑同时写入同一数据库的风险";
      force.addEventListener("click", () => openProject(entry.project_id, { force: true }));
      actions.append(readOnly, force);
    }

    card.append(cover, body, actions);
    list.append(card);
  });
}

/** "上次位置"的人话：审校 · 第 87 页（印 71）（说明书 7.2）。 */
const LAST_VIEW_LABELS = {
  library: "项目库",
  pages: "页面视图",
  review: "审校",
  structure: "结构工具",
  export: "导出",
};

function lastPositionText(entry) {
  if (!entry.last_view) return "还没有打开过";
  const view = LAST_VIEW_LABELS[entry.last_view] || entry.last_view;
  if (!entry.last_page_no) return view;
  const printed = entry.last_page_label ? `（印 ${entry.last_page_label}）` : "";
  return `${view} · 第 ${entry.last_page_no} 页${printed}`;
}

/** 识别进度右边那格：失败页数与文本层提示（都来自真实数据）。 */
function recognitionExtra(entry) {
  const parts = [];
  const failed = Number(entry.failed_pages || 0);
  if (failed) parts.push({ text: `⚠ 失败 ${failed}`, tone: "bad" });
  if (entry.included_pages && entry.recognized_pages >= entry.included_pages) {
    parts.push({ text: "已认完", tone: "ok" });
  }
  return parts;
}

function reviewExtra(entry) {
  const parts = [];
  const uncertain = Number(entry.uncertain_blocks || 0);
  if (uncertain) parts.push({ text: `不确定 ${uncertain} 块`, tone: "warn" });
  else if (entry.reviewed_pages && entry.reviewed_pages >= entry.included_pages) {
    parts.push({ text: "已审完", tone: "ok" });
  }
  return parts;
}

function progressRow(label, done, total, extras) {
  const row = document.createElement("div");
  row.className = "pcard__row";
  const lab = document.createElement("span");
  lab.className = "lab";
  lab.textContent = label;
  const bar = document.createElement("div");
  bar.className = "pbar" + (label === "审校" ? " pbar--ok" : "");
  const fill = document.createElement("i");
  fill.style.width = `${progressPercent(done, total)}%`;
  bar.append(fill);
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = ratioText(done, total);
  const extra = document.createElement("span");
  extra.className = "extra";
  const [first] = extras;
  if (first) {
    extra.textContent = first.text;
    extra.style.color = { bad: "var(--bad-text)", ok: "var(--ok-text)", warn: "var(--warn-text)" }[first.tone];
  }
  row.append(lab, bar, num, extra);
  return row;
}

async function createProjectFromFile(file) {
  const name = el("new-project-name").value.trim();
  el("library-error").hidden = true;
  el("new-project-modal-error").hidden = true;
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
    closeModal("new-project-mask");
    if (payload.text_layer_hint) {
      const warning = el("library-warning");
      warning.textContent =
        `这本 PDF 有 ${payload.pages_with_text_layer} 页已经带文本层，` +
        `可能不需要识别——建议先抽查几页再决定。`;
      warning.hidden = false;
    }
    await loadLibrary();
    await openProject(payload.project.project_id);
    // 新建项目：先让用户确认页面类型，再谈识别（说明书 6.2）
    await openPageSetup({ auto: true });
  } catch (error) {
    // 新建对话框开着就报在它里面，否则报在项目库上
    if (!el("new-project-mask").hidden) showError(el("new-project-modal-error"), error);
    else showError(el("library-error"), error);
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
    pagesOverlayOn =
      currentProject.kind !== "package" && loadPageOverlayPreference();
    setupSuggestionsLoaded = false;
    setupSuggestions = [];
    el("pages-overlay-toggle").classList.toggle("is-on", pagesOverlayOn);
    await loadLibrary();
    // 说明书 7.2：打开项目默认回到上次的位置（上次在审校就回审校那一页）
    await resumeLastPosition();
  } catch (error) {
    showError(el("library-error"), error);
  }
}

/** "继续"回到上次的视图与页面（说明书 7.2）。没有记录时落在页面视图。 */
async function resumeLastPosition() {
  const project = currentProject;
  if (!project) return;
  const view = project.last_view;
  // 项目载荷给的是 last_page_id（项目库列表给的是页码，两个接口字段不同）
  const page = project.last_page_id
    ? project.pages.find((item) => item.page_id === project.last_page_id)
    : null;
  if ((view === "review" || view === "structure") && page) {
    showView("review");
    await openPageDetail(page.page_no);
  } else {
    showView("pages");
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
  // 审校包项目（助手端）：横幅、隐藏不该有的功能、显示"导出审校结果"
  await applyPackageMode();
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

  const recognitionBits = [`已识别 ${pages.recognized || 0} / 正文 ${pages.included || 0} 页`];
  if (pages.unrecognized) recognitionBits.push(`未识别 ${pages.unrecognized}`);
  if (pages.failed) recognitionBits.push(`识别失败 ${pages.failed}`);
  if (pages.has_candidate) recognitionBits.push(`待选新结果 ${pages.has_candidate}`);
  list.append(...statsRow("识别", recognitionBits.join(" · ")));

  const reviewBits = [
    `块 ${review.blocks || 0}（纳入块 ${review.included || 0}）`,
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

  el("project-title").textContent = `《${project.name}》`;
  el("package-chip").hidden = project.kind !== "package";
  renderProjectMeta();
  renderPages();
  if (currentView === "library") showView("pages");
}

/**
 * 项目信息（项目 ID / 源文件 / SHA-256 / 文件夹路径）。
 *
 * 效果图里这些细节不占正屏，收在设置对话框的「当前项目」一节——要核来源时来这里看。
 */
function renderProjectMeta() {
  const project = currentProject;
  const list = el("project-meta");
  const section = el("project-meta-section");
  if (!project) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const pages = project.pages;
  const recognized = pages.filter(
    (page) => recognitionOf(page).status === "recognized"
  ).length;

  fillDefinitionList(list, [
    ["项目 ID", project.project_id],
    ["源文件", project.source_file_name],
    ["SHA-256", project.source_sha256],
    ["页数", `${project.page_count} 页`],
    ["识别进度", `已识别 ${recognized} / 正文 ${pages.filter((page) => page.include).length} 页`],
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

// 页面视图的缩放档位（第 38 号任务）：
// 网格 / 大网格 用 thumb 或 view，单列用 view，单页用 zoom；大图档才允许开块框。
const PAGE_ZOOM_LEVELS = [
  { label: "网格", cols: "auto", image: "thumb" },
  { label: "大网格", cols: 3, image: "view" },
  { label: "单列", cols: 1, image: "view" },
  { label: "单页", cols: 1, image: "zoom" },
];
let pageZoomIndex = 0;
let pagesOverlayOn = false;

/** 块框开关按项目记住；存在 localStorage，不写项目数据库。 */
function pageOverlayStorageKey() {
  return currentProject ? `b2t.pagesOverlay.${currentProject.project_id}` : "";
}

function loadPageOverlayPreference() {
  try {
    return localStorage.getItem(pageOverlayStorageKey()) === "1";
  } catch {
    return false;
  }
}

function savePageOverlayPreference() {
  try {
    localStorage.setItem(pageOverlayStorageKey(), pagesOverlayOn ? "1" : "0");
  } catch {
    /* 隐私模式等写不进去：不影响本次会话 */
  }
}
/** 当前在大图档下、与视口相交的页（块框只给这些页渲染）。 */
const visiblePageNos = new Set();
/** 块数据缓存：页号 → blocks；最多留 40 页，避免 267 页全塞内存。 */
const pageBlockCache = new Map();
const pageBlockCacheOrder = [];
const pageBlockPending = new Set();
const PAGE_BLOCK_CACHE_LIMIT = 40;

// ---------------------------------------------------------------- 块类型建议（只读）
//
// 接口只返回"建议类型 ≠ 当前类型"的块（`GET .../pages/{no}/block-suggestions`），
// 不写库、不改块类型。审校视图的块头徽章与页面视图的角标共用这份按页缓存：
// 只给**算过的页**显示，采用 / 改类型 / 识别完成后丢掉缓存重算。
// 它和"未审"是两回事：建议不进待办计数，只有点了「采用」才会改块类型。

const pageSuggestionCache = new Map(); // page_no → {suggestions, note}
const pageSuggestionOrder = [];
const pageSuggestionQueue = [];
const pageSuggestionPending = new Set();
const pageSuggestionFailed = new Set();
let pageSuggestionActive = 0;
const PAGE_SUGGESTION_CACHE_LIMIT = 200;
const PAGE_SUGGESTION_CONCURRENCY = 2;

function rememberPageSuggestions(pageNo, payload) {
  const existing = pageSuggestionOrder.indexOf(pageNo);
  if (existing >= 0) pageSuggestionOrder.splice(existing, 1);
  pageSuggestionCache.set(pageNo, payload);
  pageSuggestionOrder.push(pageNo);
  while (pageSuggestionOrder.length > PAGE_SUGGESTION_CACHE_LIMIT) {
    pageSuggestionCache.delete(pageSuggestionOrder.shift());
  }
  updateTileSuggestionMark(pageNo);
}

/** 丢掉一页的建议缓存（块类型 / 结构变了之后用）；页面视图的角标跟着变。 */
function forgetPageSuggestions(pageNo) {
  pageSuggestionCache.delete(pageNo);
  pageSuggestionFailed.delete(pageNo);
  const index = pageSuggestionOrder.indexOf(pageNo);
  if (index >= 0) pageSuggestionOrder.splice(index, 1);
  updateTileSuggestionMark(pageNo);
}

function forgetAllPageSuggestions() {
  pageSuggestionCache.clear();
  pageSuggestionOrder.length = 0;
  pageSuggestionFailed.clear();
  for (const tile of document.querySelectorAll("#page-grid .page-tile")) {
    paintTileSuggestionMark(tile, Number(tile.dataset.pageNo));
  }
}

/** 页面视图角标：只数 `high`（把握较大）；review 不标，免得整本书都是噪声。 */
function paintTileSuggestionMark(tile, pageNo) {
  const mark = tile ? tile.querySelector(".page-tile__suggest") : null;
  if (!mark) return;
  const entry = pageSuggestionCache.get(pageNo);
  const high = entry
    ? entry.suggestions.filter((item) => item.confidence === "high")
    : [];
  if (!high.length) {
    mark.hidden = true;
    mark.textContent = "";
    mark.removeAttribute("title");
    return;
  }
  const labels = [
    ...new Set(
      high.map((item) => BLOCK_TYPE_LABELS[item.suggested_type] || item.suggested_type)
    ),
  ];
  mark.hidden = false;
  // 用"建议 N"而不是只有数字 / 颜色：黑白截图与色盲都能读懂，也不会和页码混淆
  mark.textContent = `建议 ${high.length}`;
  mark.title =
    `这一页有 ${high.length} 条把握较大的块类型建议（${labels.join(" / ")}）：` +
    "进审校看块头徽章，点「采用」才会改类型；建议不会自动应用，也不算待办。";
}

function updateTileSuggestionMark(pageNo) {
  const tile = document.querySelector(
    `#page-grid .page-tile[data-page-no="${pageNo}"]`
  );
  if (tile) paintTileSuggestionMark(tile, pageNo);
}

async function fetchPageSuggestions(pageNo, { force = false } = {}) {
  if (!currentProject || currentProject.kind === "package") {
    return { suggestions: [], note: null };
  }
  if (!force && pageSuggestionCache.has(pageNo)) {
    return pageSuggestionCache.get(pageNo);
  }
  const data = await apiJson(
    `/api/projects/${currentProject.project_id}/pages/${pageNo}/block-suggestions`
  );
  const payload = {
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    note: data.note || null,
  };
  rememberPageSuggestions(pageNo, payload);
  return payload;
}

/** 排队算一页的建议；返回 true 表示这次真的排了新活（用于限量与续扫）。 */
function ensurePageSuggestion(pageNo) {
  const project = currentProject;
  if (!project || project.kind === "package") return false;
  if (
    pageSuggestionCache.has(pageNo) ||
    pageSuggestionPending.has(pageNo) ||
    pageSuggestionFailed.has(pageNo)
  ) {
    return false;
  }
  const page = project.pages.find((item) => item.page_no === pageNo);
  if (!page || !page.include || page.page_type !== "body") return false;
  if (recognitionOf(page).status !== "recognized") return false;
  pageSuggestionPending.add(pageNo);
  pageSuggestionQueue.push(pageNo);
  pumpPageSuggestionQueue();
  return true;
}

let suggestionScanQueued = 0;

function pumpPageSuggestionQueue() {
  while (
    pageSuggestionActive < PAGE_SUGGESTION_CONCURRENCY &&
    pageSuggestionQueue.length
  ) {
    const pageNo = pageSuggestionQueue.shift();
    pageSuggestionActive += 1;
    fetchPageSuggestions(pageNo)
      .catch(() => {
        // 建议是辅助信息：读不到就不标，不打断翻页；本次会话不再反复重试这一页
        pageSuggestionFailed.add(pageNo);
      })
      .finally(() => {
        pageSuggestionActive -= 1;
        pageSuggestionPending.delete(pageNo);
        if (pageSuggestionActive === 0 && !pageSuggestionQueue.length) {
          // 这一轮排过队、可能还有可见页没轮到（一次最多 12 页）：再扫一轮
          if (suggestionScanQueued > 0) {
            suggestionScanQueued = 0;
            scheduleSuggestionScan();
          }
        }
        pumpPageSuggestionQueue();
      });
  }
}

let suggestionScrollListening = false;
let suggestionScanTimer = null;

function ensureSuggestionScrollListener() {
  if (suggestionScrollListening) return;
  const scroller = el("page-grid")?.closest(".split__main");
  (scroller || window).addEventListener("scroll", scheduleSuggestionScan, {
    passive: true,
  });
  window.addEventListener("resize", scheduleSuggestionScan);
  suggestionScrollListening = true;
}

/** 网格档滚动时不必每帧算 267 个矩形：停下来再扫一次可见页。 */
function scheduleSuggestionScan() {
  if (suggestionScanTimer) clearTimeout(suggestionScanTimer);
  suggestionScanTimer = setTimeout(scanVisiblePageSuggestions, 140);
}

function scanVisiblePageSuggestions() {
  suggestionScanTimer = null;
  if (!currentProject || currentView !== "pages" || pageZoomIndex >= 2) return;
  const height = window.innerHeight;
  let budget = 12; // 一次最多算 12 页；还有没轮到的，队列空后会自动再扫一轮
  for (const tile of el("page-grid").querySelectorAll(".page-tile")) {
    if (budget <= 0) break;
    const rect = tile.getBoundingClientRect();
    if (rect.bottom < -120 || rect.top > height + 120) continue;
    // 算过 / 排队中的页不占名额，否则上面几屏的缓存会把下面的可见页永远饿死
    if (ensurePageSuggestion(Number(tile.dataset.pageNo))) {
      budget -= 1;
      suggestionScanQueued += 1;
    }
  }
}

/** 页面确认模式：汇总、建议与「确认所选」都在这个模式里出现。 */
let setupSuggestions = [];
let setupSuggestionsLoading = false;
let setupSuggestionsLoaded = false;

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
  el("selection-count").textContent = `${count} 页`;
  const selected = selectionPages();

  const numbers = [...selectedPages].sort((left, right) => left - right);
  const range = el("selection-range");
  if (!numbers.length) {
    range.textContent = "在网格里点一页开始选择";
  } else if (numbers.length === 1) {
    range.textContent = `第 ${numbers[0]} 页`;
  } else {
    const contiguous = numbers.length === numbers[numbers.length - 1] - numbers[0] + 1;
    range.textContent = contiguous
      ? `第 ${numbers[0]}–${numbers[numbers.length - 1]} 页`
      : `第 ${numbers.slice(0, 6).join("、")}${numbers.length > 6 ? " 等" : ""}（${numbers.length} 页）`;
  }

  renderTypePicker();
  renderSuggestionPanel();
  el("selection-recognize").disabled = count === 0 || !selected.some((page) => page.include);
  el("setup-confirm-selected").disabled = count === 0;
  el("selection-review-open").disabled = count === 0;
  el("assign-open").disabled = count === 0;
  el("selection-clear").hidden = count === 0;

  const hint = el("selection-hint");
  hint.hidden = true;
  if (count === 0) return;
  if (selected.every((page) => !page.include)) {
    hint.textContent =
      "选中的页都不是「正文」，不参与识别。要把它们纳入识别，把类型改成「正文」。";
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
    ` page-tile--ptype-${page.page_type}` +
    (page.include ? "" : " page-tile--excluded") +
    (page.has_text_layer ? " page-tile--textlayer" : "") +
    (busyPages.has(page.page_no) ? " page-tile--busy" : "") +
    (recognition.status === "failed" ? " page-tile--failed" : "") +
    (!page.page_confirmed && currentProject.kind !== "package" ? " page-tile--unconfirmed" : "") +
    (selectedPages.has(page.page_no) ? " page-tile--selected" : "")
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

  const overlay = document.createElement("div");
  overlay.className = "page-overlay page-overlay--readonly page-overlay--labeled";
  overlay.hidden = true;

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
    `&token=${encodeURIComponent(token)}`;
  if (pageZoomIndex < 2) image.src = image.dataset.thumbSrc;

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
    recognizePage(page);
  });

  const detailButton = document.createElement("button");
  detailButton.type = "button";
  detailButton.className = "btn";
  detailButton.textContent = "审校";
  detailButton.title = "看这一页的识别结果并开始审校";
  detailButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openPageDetail(page.page_no);
  });

  actions.append(recognizeButton, detailButton);
  thumb.append(image, overlay, check, suggestMark, actions);

  const meta = document.createElement("div");
  meta.className = "page-tile__meta";
  const label = document.createElement("div");
  label.className = "page-tile__label";
  const status = document.createElement("div");
  status.className = "page-tile__status";
  meta.append(label, status);

  tile.append(thumb, meta);
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
  paintTileSuggestionMark(tile, page.page_no);

  // 门牌：`p.87 · 正文`，印张页码进 tooltip（列宽只有一百多像素）
  const label = tile.querySelector(".page-tile__label");
  label.textContent = `p.${page.page_no}`;
  const kind = document.createElement("span");
  kind.textContent = ` · ${PAGE_TYPE_LABELS[page.page_type] || page.page_type}`;
  label.append(kind);

  const status = tile.querySelector(".page-tile__status");
  status.innerHTML = "";
  status.append(recognitionChip(page));
  const reviewChip = reviewBadge(page);
  if (reviewChip) status.append(reviewChip);
  const divergence = divergenceChip(page);
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

  const isBusy = busyPages.has(page.page_no);
  const button = tile.querySelector('button[data-action="recognize"]');
  button.textContent = isBusy ? "识别中…" : "识别";
  button.disabled = isBusy || !page.include;
  if (!page.include) {
    button.title = "不是「正文」类型，不参与识别。要把这一页纳入识别，把类型改成「正文」。";
  } else if (recognition.status === "recognized") {
    button.title = "重新识别这一页（已有人工成果时不会覆盖，只作为待选结果）";
  } else {
    button.title = "识别这一页（在后台任务里跑，进度看右下角）";
  }
}

// ---------------------------------------------------------------- 页面确认（说明书 6.2）

function pageSetupStats() {
  const pages = currentProject ? currentProject.pages : [];
  const counts = { body: 0, body_excluded: 0, toc: 0, front: 0, back: 0 };
  for (const page of pages) {
    if (page.page_type in counts) counts[page.page_type] += 1;
  }
  return {
    total: pages.length,
    body: counts.body,
    bodyExcluded: counts.body_excluded,
    toc: counts.toc,
    front: counts.front,
    back: counts.back,
    confirmed: pages.filter((page) => page.page_confirmed).length,
    unconfirmed: pages.filter((page) => !page.page_confirmed).length,
  };
}

function renderPageSetup() {
  const bar = el("page-setup-bar");
  if (!currentProject || currentProject.kind === "package") {
    bar.hidden = true;
    el("setup-panel").hidden = true;
    return;
  }
  const stats = pageSetupStats();
  bar.hidden = false;
  // 五类各报各的：总数 = 五类之和，别让人以为页数丢了
  el("setup-summary").textContent =
    `正文 ${stats.body} 页 · 正文排除 ${stats.bodyExcluded} 页` +
    ` · 前置 ${stats.front} 页 · 目录 ${stats.toc} 页 · 后置 ${stats.back} 页` +
    ` · 未确认 ${stats.unconfirmed} 页`;
  el("setup-panel").hidden = false;
  el("setup-progress").textContent = `${stats.confirmed} / ${stats.total} 已确认`;
  el("setup-summary-detail").textContent =
    `共 ${stats.total} 页；已确认 ${stats.confirmed} 页，未确认 ${stats.unconfirmed} 页。` +
    "点下面的类型直接改所选页；只有「正文」进识别与语料，确认只是状态标记，未确认也能识别。";
  el("setup-confirm-selected").disabled = selectedPages.size === 0;
  el("setup-confirm-all").disabled = stats.unconfirmed === 0;
  renderTypePicker();
  renderSuggestionPanel();
}

/** 打开确认界面：先回数据库拉一次页面，保证看到的进度不是前端缓存。 */
async function openPageSetup({ auto = false } = {}) {
  if (!currentProject || currentProject.kind === "package") return;
  showView("pages");
  await refreshPageStates();
  renderPages();
  await loadSetupSuggestions();
  if (auto) {
    el("setup-panel").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

async function loadSetupSuggestions() {
  if (!currentProject || currentProject.kind === "package") return;
  setupSuggestionsLoading = true;
  setupSuggestionsLoaded = true;
  setupSuggestions = [];
  renderSuggestionPanel();
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/suggestions`
    );
    setupSuggestions = data.suggestions || [];
  } catch {
    setupSuggestions = [];
  } finally {
    setupSuggestionsLoading = false;
    renderSuggestionPanel();
    renderTypePicker();
  }
}

/** 只看"选中的页"上的建议：建议区要贴着当前页，不常挂在最上面。 */
function selectedSuggestions() {
  if (!selectedPages.size) return [];
  return setupSuggestions.filter((item) => selectedPages.has(item.page_no));
}

function suggestionPagesByType() {
  const byType = new Map();
  for (const item of selectedSuggestions()) {
    if (!byType.has(item.suggested_type)) byType.set(item.suggested_type, []);
    byType.get(item.suggested_type).push(item.page_no);
  }
  return byType;
}

/**
 * 页面类型常驻列表：当前类型高亮 + "当前"文字，建议类型加淡色圆点。
 * 颜色只是辅助，文字标签始终在。
 */
function renderTypePicker() {
  const wrap = el("selection-types");
  if (!wrap) return;
  const selected = selectionPages();
  const types = new Set(selected.map((page) => page.page_type));
  const mixed = types.size > 1;
  const current = types.size === 1 ? [...types][0] : null;
  el("selection-type-state").textContent = !selected.length
    ? "先选页"
    : mixed
    ? `混合（${types.size} 种）`
    : `当前：${PAGE_TYPE_LABELS[current] || current}`;

  const suggested = suggestionPagesByType();
  wrap.innerHTML = "";
  for (const type of PAGE_TYPE_ORDER) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ptype ptype--${type}`;
    button.disabled = selected.length === 0;
    button.title = selected.length
      ? `把所选 ${selected.length} 页设为「${PAGE_TYPE_LABELS[type] || type}」`
      : "先在左边选页";
    if (current === type) button.classList.add("is-current");
    const dot = document.createElement("span");
    dot.className = "ptype__dot";
    const label = document.createElement("span");
    label.className = "ptype__label";
    label.textContent = PAGE_TYPE_LABELS[type] || type;
    button.append(dot, label);
    if (current === type) {
      const flag = document.createElement("span");
      flag.className = "ptype__flag";
      flag.textContent = "当前";
      button.append(flag);
    }
    if (suggested.has(type)) {
      button.classList.add("has-suggestion");
      const mark = document.createElement("span");
      mark.className = "ptype__suggest";
      mark.title = `建议第 ${suggested.get(type).join("、")} 页用这个类型`;
      button.append(mark);
    }
    button.addEventListener("click", () => patchSelectedPages({ page_type: type }));
    wrap.append(button);
  }
}

/** 建议区：只在选中页有建议时出现，条目就是"建议 vs 当前"的具体差别。 */
function renderSuggestionPanel() {
  const block = el("setup-suggestion-block");
  const note = el("setup-suggestion-note");
  const list = el("setup-suggestions");
  if (!block) return;
  const items = selectedSuggestions();
  if (setupSuggestionsLoading && selectedPages.size) {
    block.hidden = false;
    note.hidden = false;
    note.textContent = "正在根据已有数据给建议（只读，不会自动改任何页）…";
    list.innerHTML = "";
    return;
  }
  if (!items.length) {
    block.hidden = true;
    list.innerHTML = "";
    return;
  }
  block.hidden = false;
  note.hidden = false;
  note.textContent = "只给建议，点「采用」才改；圆点是建议类型，粗框是当前类型。";
  list.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("li");
    row.className = "setup-suggestion";
    const head = document.createElement("div");
    head.className = "setup-suggestion__head";
    const where = document.createElement("strong");
    where.textContent = `第 ${item.page_no} 页`;
    const target = document.createElement("span");
    target.className = "setup-suggestion__target";
    target.textContent = `建议：${PAGE_TYPE_LABELS[item.suggested_type] || item.suggested_type}`;
    const confidence = document.createElement("span");
    confidence.className = `chip setup-confidence setup-confidence--${item.confidence}`;
    confidence.textContent = `把握 ${item.confidence_label}`;
    head.append(where, target, confidence);
    const page = currentProject.pages.find((entry) => entry.page_no === item.page_no);
    if (page && page.page_type !== item.suggested_type) {
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "btn btn--sm";
      apply.textContent = "采用";
      apply.addEventListener("click", () => applySetupSuggestion(item, apply));
      head.append(apply);
    } else {
      const ok = document.createElement("span");
      ok.className = "muted";
      ok.textContent = "已是该类型";
      head.append(ok);
    }
    const reason = document.createElement("div");
    reason.className = "setup-suggestion__reason";
    reason.textContent = item.reason;
    row.append(head, reason);
    list.append(row);
  }
}

async function applySetupSuggestion(item, button) {
  if (!currentProject) return;
  button.disabled = true;
  el("pages-error").hidden = true;
  try {
    await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${item.page_id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_type: item.suggested_type }),
      }
    );
    // 页类型变了：这一页不再/开始属于"正文页建议范围"，旧建议与角标都要作废
    forgetPageSuggestions(item.page_no);
    await refreshPageStates();
    renderPages();
    await loadSetupSuggestions();
  } catch (error) {
    button.disabled = false;
    showError(el("pages-error"), error);
  }
}

async function confirmPageIds(pageIds) {
  if (!currentProject || !pageIds.length) return;
  el("pages-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_ids: pageIds }),
      }
    );
    for (const updated of data.pages) {
      const index = currentProject.pages.findIndex(
        (page) => page.page_id === updated.page_id
      );
      if (index >= 0) currentProject.pages[index] = updated;
    }
    renderPages();
    renderProjectMeta();
    el("setup-summary-detail").textContent = `已确认 ${data.confirmed} 页。`;
    await loadSetupSuggestions();
  } catch (error) {
    showError(el("pages-error"), error);
  }
}

function confirmSelectedPages() {
  const ids = selectionPages().map((page) => page.page_id);
  if (!ids.length) {
    el("setup-summary-detail").textContent = "先在左边网格里选几页，或点「确认全部未确认页」。";
    return;
  }
  return confirmPageIds(ids);
}

function confirmAllUnconfirmed() {
  if (!currentProject) return;
  const ids = currentProject.pages
    .filter((page) => !page.page_confirmed)
    .map((page) => page.page_id);
  if (!ids.length) {
    el("setup-summary-detail").textContent = "所有页面都已确认。";
    return;
  }
  return confirmPageIds(ids);
}

/**
 * 识别前的提醒：未确认不拦人，只问一次。
 * 返回 false 表示用户点了取消。
 */
function warnUnconfirmed(pages, action) {
  const unconfirmed = pages.filter((page) => !page.page_confirmed);
  if (!unconfirmed.length) return true;
  return window.confirm(
    `还有 ${unconfirmed.length} 页没有确认页面类型（正文 / 正文排除 / 目录 / 前置 / 后置）。` +
      `${action}仍会按现在的设置继续（只有「正文」进识别）——未确认不拦人。要现在继续吗？`
  );
}

// ---------------------------------------------------------------- 页面视图缩放与块框

function pageZoomLevel() {
  return PAGE_ZOOM_LEVELS[pageZoomIndex];
}

function pageImageUrl(pageNo, size) {
  return (
    `/api/projects/${currentProject.project_id}/pages/${pageNo}/image?size=${size}` +
    `&token=${encodeURIComponent(token)}`
  );
}

function pageBlockKey(pageNo) {
  return `${currentProject.project_id}:${pageNo}`;
}

function rememberPageBlocks(key, blocks) {
  const existing = pageBlockCacheOrder.indexOf(key);
  if (existing >= 0) pageBlockCacheOrder.splice(existing, 1);
  pageBlockCache.set(key, blocks);
  pageBlockCacheOrder.push(key);
  while (pageBlockCacheOrder.length > PAGE_BLOCK_CACHE_LIMIT) {
    const oldest = pageBlockCacheOrder.shift();
    pageBlockCache.delete(oldest);
  }
}

let pageScrollListening = false;
let pageScrollScheduled = false;

function ensurePageScrollListener() {
  if (pageScrollListening) return;
  const scroller = el("page-grid")?.closest(".split__main");
  (scroller || window).addEventListener("scroll", schedulePageVisibility, { passive: true });
  window.addEventListener("resize", schedulePageVisibility);
  pageScrollListening = true;
}

function schedulePageVisibility() {
  if (pageScrollScheduled) return;
  pageScrollScheduled = true;
  requestAnimationFrame(() => {
    pageScrollScheduled = false;
    updatePageVisibility();
  });
}

/**
 * 只给"离视口不远"的页设置大图 src；离屏的页清掉 src 与块框。
 *
 * 为什么不用 IntersectionObserver：真机 267 页用 scrollIntoView 跳页时，
 * observer 在部分滚动路径上不回调（同一页反复进出后只剩第一页的图）。
 * 这里用滚动事件 + requestAnimationFrame 兜底：每帧只做 267 次 getBoundingClientRect，
 * 换来确定的行为——滚动到哪一页就加载哪一页，离屏就释放。
 */
function updatePageVisibility() {
  if (!currentProject || pageZoomIndex < 2) return;
  const tiles = [...el("page-grid").querySelectorAll(".page-tile")];
  const nearLimit = 1400;
  const near = new Set();
  for (const tile of tiles) {
    const rect = tile.getBoundingClientRect();
    const pageNo = Number(tile.dataset.pageNo);
    if (rect.bottom <= -nearLimit || rect.top >= window.innerHeight + nearLimit) {
      continue;
    }
    near.add(pageNo);
    const image = tile.querySelector("img");
    if (image && image.dataset.largeSrc && image.getAttribute("src") !== image.dataset.largeSrc) {
      image.src = image.dataset.largeSrc;
    }
    const isVisible = rect.bottom > -60 && rect.top < window.innerHeight + 60;
    if (isVisible) {
      visiblePageNos.add(pageNo);
      // 建议角标只为可见页算；离屏的不拉，免得滚一本 267 页的书打满请求
      ensurePageSuggestion(pageNo);
    } else {
      visiblePageNos.delete(pageNo);
    }
    if (isVisible && pagesOverlayOn) ensurePageBlocks(pageNo);
    else clearPageBlocks(tile);
  }
  for (const tile of tiles) {
    const pageNo = Number(tile.dataset.pageNo);
    if (near.has(pageNo)) continue;
    visiblePageNos.delete(pageNo);
    const image = tile.querySelector("img");
    if (image) image.removeAttribute("src");
    clearPageBlocks(tile);
  }
}

function applyPageZoom() {
  const grid = el("page-grid");
  if (!grid) return;
  const level = pageZoomLevel();
  grid.classList.remove("page-grid--cols-3", "page-grid--single", "page-grid--page");
  if (pageZoomIndex === 1) grid.classList.add("page-grid--cols-3");
  if (pageZoomIndex === 2) grid.classList.add("page-grid--single");
  if (pageZoomIndex === 3) grid.classList.add("page-grid--page");

  el("pages-zoom-label").textContent = `${pageZoomIndex + 1}/${PAGE_ZOOM_LEVELS.length} · ${level.label}`;
  el("pages-zoom-out").disabled = pageZoomIndex === 0;
  el("pages-zoom-in").disabled = pageZoomIndex === PAGE_ZOOM_LEVELS.length - 1;
  const large = pageZoomIndex >= 2;
  el("pages-overlay-toggle").disabled = !large;
  el("pages-overlay-toggle").classList.toggle("is-on", pagesOverlayOn);

  const tiles = [...grid.querySelectorAll(".page-tile")];
  const byPage = new Map(currentProject.pages.map((page) => [page.page_no, page]));
  visiblePageNos.clear();

  if (large) {
    ensurePageScrollListener();
    for (const tile of tiles) {
      const pageNo = Number(tile.dataset.pageNo);
      const image = tile.querySelector("img");
      if (!image) continue;
      image.loading = "eager";
      image.dataset.largeSrc = pageImageUrl(pageNo, level.image);
      image.removeAttribute("src");
    }
    updatePageVisibility();
  } else {
    for (const tile of tiles) {
      clearPageBlocks(tile);
      const pageNo = Number(tile.dataset.pageNo);
      const page = byPage.get(pageNo);
      const image = tile.querySelector("img");
      if (!image || !page) continue;
      image.loading = "lazy";
      delete image.dataset.largeSrc;
      // 大网格用 view（150 DPI），网格用 thumb（40 DPI）：别把 40 DPI 的图拉大
      const gridSrc = pageImageUrl(pageNo, level.image);
      if (image.getAttribute("src") !== gridSrc) image.src = gridSrc;
    }
    // 网格 / 大网格档：滚动停下来再算可见页的建议角标（不每帧量 267 个矩形）
    ensureSuggestionScrollListener();
    scheduleSuggestionScan();
  }
}

function setPageZoom(delta) {
  const next = Math.min(
    PAGE_ZOOM_LEVELS.length - 1,
    Math.max(0, pageZoomIndex + delta)
  );
  if (next === pageZoomIndex) return;
  pageZoomIndex = next;
  applyPageZoom();
}

function togglePageBlocksOverlay() {
  if (pageZoomIndex < 2) return;
  pagesOverlayOn = !pagesOverlayOn;
  savePageOverlayPreference();
  el("pages-overlay-toggle").classList.toggle("is-on", pagesOverlayOn);
  if (pagesOverlayOn) {
    for (const pageNo of visiblePageNos) ensurePageBlocks(pageNo);
  } else {
    for (const tile of el("page-grid").querySelectorAll(".page-tile")) {
      clearPageBlocks(tile);
    }
  }
}

function ensurePageBlocks(pageNo) {
  if (!currentProject || !pagesOverlayOn || pageZoomIndex < 2) return;
  const key = pageBlockKey(pageNo);
  if (pageBlockCache.has(key)) {
    const tile = el("page-grid").querySelector(`.page-tile[data-page-no="${pageNo}"]`);
    const overlay = tile ? tile.querySelector(".page-overlay") : null;
    const blocks = pageBlockCache.get(key);
    // 可见性每帧都会调这里：同一批块已经画好就不要再重建 DOM / 重排标注
    if (tile && overlay && visiblePageNos.has(pageNo) && overlay._renderedBlocks !== blocks) {
      renderPageBlocks(tile, blocks);
    }
    return;
  }
  if (pageBlockPending.has(key)) return;
  pageBlockPending.add(key);
  apiJson(`/api/projects/${currentProject.project_id}/pages/${pageNo}/blocks`)
    .then((data) => {
      rememberPageBlocks(key, data.blocks || []);
      const tile = el("page-grid").querySelector(`.page-tile[data-page-no="${pageNo}"]`);
      if (tile && pagesOverlayOn && visiblePageNos.has(pageNo)) {
        renderPageBlocks(tile, pageBlockCache.get(key));
      }
    })
    .catch(() => {
      // 块框是辅助信息，读不到不该打断翻页
    })
    .finally(() => pageBlockPending.delete(key));
}

function renderPageBlocks(tile, blocks) {
  const overlay = tile.querySelector(".page-overlay");
  if (!overlay) return;
  overlay.innerHTML = "";
  overlay._renderedBlocks = blocks;
  overlay._lineBboxes = [];
  let count = 0;
  for (const block of blocks) {
    if (!block.bbox) continue;
    const box = document.createElement("div");
    box.className = `box box--type-${block.block_type}`;
    if (!block.include) box.classList.add("box--excluded");
    if (block.review_status === "uncertain") box.classList.add("box--uncertain");
    box._bbox = block.bbox;
    applyBoxElementRect(box, block.bbox);
    const index = block.order_index;
    box.title = `${boxTypeLabel(block)} · 第 ${index + 1} 块`;
    // 与审校视图同一套规则：默认只留颜色 + 小顺序号，悬停才出类型卡片
    box.append(buildBoxOrder(index));
    box.append(buildBoxLabel(block, index, null));
    overlay.append(box);
    count += 1;
  }
  overlay.hidden = count === 0;
  observeOverlaySize(overlay);
  // 同步摆一次，别等 rAF：块框刚画出来时可能正赶上滚动 / 缩放，晚一帧就会看到没摆好的号
  layoutOverlayAnnotations(overlay);
  scheduleOverlayLayout(overlay);
}

function clearPageBlocks(tile) {
  const overlay = tile.querySelector(".page-overlay");
  if (!overlay) return;
  overlay.innerHTML = "";
  overlay.hidden = true;
  overlay._renderedBlocks = null;
}

function renderPages() {
  const project = currentProject;
  if (!project) return;
  const pages = visiblePages();
  const all = project.pages;

  el("page-summary").textContent =
    `共 ${all.length} 页 · 正文 ${all.filter((page) => page.include).length} 页` +
    ` · 已识别 ${all.filter((page) => recognitionOf(page).status === "recognized").length} 页` +
    ` · 已确认 ${all.filter((page) => page.page_confirmed).length} 页` +
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
  applyPageZoom();
  renderPageSetup();
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
  renderPageSetup();
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
  if (!warnUnconfirmed([page], `识别第 ${page.page_no} 页`)) return;

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
  const pending = project.pages.filter(
    (page) => page.include && recognitionOf(page).status !== "recognized"
  );
  if (!warnUnconfirmed(pending, "识别全部未识别页")) return;
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
/** 最近一次任务载荷：抽屉关着时也要靠它把顶栏那个 pill 刷新（进度条在 pill 里）。 */
let lastTaskData = null;
/**
 * 已经为哪个任务主动弹过"失败"提示。
 *
 * 抽屉的开关**只由用户操作决定**（启动任务 / 点顶栏 pill / 点最近任务里的「查看」）；
 * 轮询只刷新内容，不打开抽屉。唯一的例外是任务失败：主动提示一次，
 * 同一个任务不会因为轮询或重进项目反复弹。
 */
let taskFailureAnnouncedFor = null;

function openTaskDrawer() {
  el("task-drawer").hidden = false;
}

function closeTaskDrawer() {
  el("task-drawer").hidden = true;
}

function taskChipClass(status) {
  if (status === "failed" || status === "interrupted") return "tpill is-failed";
  if (status && status !== "succeeded") return "tpill is-active";
  return "tpill";
}

/** 顶栏的任务 pill：一个圆点 + 文字 + 迷你进度条（效果图 02 的右上角）。 */
function paintTaskChip({ text, status, percent = null, title = "" }) {
  const chip = el("task-chip");
  chip.hidden = false;
  chip.className = taskChipClass(status);
  chip.title = title || text;
  chip.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = "tpill__dot";
  const label = document.createElement("span");
  label.textContent = text;
  chip.append(dot, label);
  if (percent !== null) {
    const mini = document.createElement("span");
    mini.className = "tpill__mini";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    mini.append(fill);
    chip.append(mini);
  }
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
  // 轮询只刷新抽屉 / 顶栏 pill 的内容：用户关掉抽屉之后，任务还在跑也不许自己弹回来。
  renderTask(data);

  if (!["queued", "running", "paused"].includes(data.job.status)) {
    stopTaskPolling();
    // 识别完块变了：页面视图的建议角标不能拿旧数据
    forgetAllPageSuggestions();
    await reloadProjectPages();
    await loadTasks();
    // loadTasks 在没有活动任务时会把抽屉内容换成"最近任务"。失败时把这次任务的
    // 失败页重新摆出来，**只主动开一次**；成功 / 取消只更新顶栏 pill。
    if (announceTaskFailure(data.job)) {
      renderTask(data);
      openTaskDrawer();
    }
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

/**
 * 任务结束后是否要主动提示：**只有失败 / 中断**才提示，同一个任务只提示一次。
 *
 * 返回 true 表示这一次应该把抽屉打开；调用方负责摆好这次的失败页再开，
 * 免得抽屉里显示的是"最近任务"而不是刚失败的那一批。
 */
function announceTaskFailure(job) {
  const failed = job.status === "failed" || job.status === "interrupted";
  if (!failed) return false;
  if (taskFailureAnnouncedFor === job.job_id) return false;
  taskFailureAnnouncedFor = job.job_id;
  return true;
}

function renderTask(data) {
  const job = data.job;
  lastTaskData = data;
  const label = JOB_STATUS_LABELS[job.status] || job.status;
  const typeLabel = JOB_TYPE_LABELS[job.job_type] || job.job_type;
  // 注意：这里**不**打开抽屉。renderTask 被轮询（每 1.2 秒）、刷新项目、
  // 任务结束后的 loadTasks 反复调用；之前它无条件 openTaskDrawer()，于是用户
  // 手动关掉抽屉后，下一轮轮询又把它弹回来——这就是"关掉后自动重开"的真实原因。
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

  paintTaskChip({
    text: `${typeLabel} ${label} ${job.done + job.failed}/${job.total}`,
    status: job.status,
    percent: job.percent,
    title: `${typeLabel}任务 · ${label}`,
  });
}

function renderRecentTasks(jobs) {
  const latest = jobs[0];
  lastTaskData = null;
  if (latest) {
    paintTaskChip({
      text: `任务：${JOB_STATUS_LABELS[latest.status] || latest.status}`,
      status: latest.status,
      title: `${JOB_TYPE_LABELS[latest.job_type] || latest.job_type} · 点开看详情`,
    });
  } else {
    paintTaskChip({ text: "任务：无", status: null, title: "这个项目还没有跑过任务" });
  }

  // 没有正在跑的任务：抽屉不摆半截进度条，改成说清"最近跑过什么"
  el("drawer-title").textContent = "任务";
  el("drawer-status").textContent = latest
    ? `最近一次：${JOB_STATUS_LABELS[latest.status] || latest.status}`
    : "还没有跑过任务";
  el("drawer-progress").hidden = !latest;
  el("drawer-fill").style.width = latest ? `${latest.percent}%` : "0%";
  el("drawer-counts").textContent = latest
    ? `${latest.done + latest.failed} / ${latest.total} 页 · 成功 ${latest.done}` +
      (latest.failed ? ` · 失败 ${latest.failed}` : "")
    : "";
  el("drawer-hint").textContent = latest
    ? "选中页面后点「识别所选」开始新任务，进度会显示在这里。"
    : "在页面视图里选中页面，再点「识别所选」开始。";
  el("drawer-hint").hidden = false;
  el("drawer-failures").innerHTML = "";
  for (const button of [el("job-pause"), el("job-resume"), el("job-retry"), el("job-cancel")]) {
    button.disabled = true;
  }
  el("drawer-error").hidden = true;

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
      view.className = "btn btn--sm btn--ghost";
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
/** 这一页所有识别行（含未归属 / 冲突的）。拖框吸附与虚线绘制都用它。 */
let detailLines = [];
let reviewSaveTimer = null;
let reviewPendingSave = null; // {block, text}：还没发出去的自动保存
/** 每个块编辑框最后的光标位置：拆分要用它（点菜单会让编辑框失焦）。 */
const cursorByBlock = new Map();
/**
 * 本页的块类型建议（只读）与按块索引。
 *
 * 与"未审"完全独立：有建议不会让块显示成待办，也不改 `review_status`；
 * 只有点「采用」才走 `PATCH block_type`（进事件表、可撤销）。
 */
let detailSuggestions = [];
let detailSuggestionByBlock = new Map();

const BLOCK_TYPE_LABELS = {
  heading: "标题", paragraph: "段落", header: "页眉", footer: "页脚",
  page_number: "页码", footnote: "脚注", caption: "图注",
  figure: "插图", decoration: "装饰", other: "其他",
};
/** 这些类型的块在导出时不输出文本（figure / decoration 是版面块，不是正文）。 */
const TEXT_FREE_BLOCK_TYPES = new Set(["figure", "decoration"]);
const CHROME_BLOCK_TYPES = new Set(["header", "footer", "page_number"]);
const REVIEW_STATUS_LABELS = {
  unreviewed: "未审", confirmed: "已确认", uncertain: "不确定",
};

async function openPageDetail(pageNo) {
  detailPageNo = pageNo;
  showView("review");
  el("page-detail-error").hidden = true;
  renderReviewPager();
  // 进页面就拉一次建议（不以缓存为准：别的页面改过类型后可能影响重复统计）
  await loadPageDetail(pageNo, { forceSuggestions: true });
  savePosition("review", pageNo);
}

/**
 * 进审校视图时先挑一页：上次那一页 → 第一个还没审完的页 → 第一页。
 *
 * 挑选顺序与"继续"一致（说明书 7.2 / 7.4）：用户从项目库点进来，
 * 落在最可能还要干活的那一页上。
 */
function ensureReviewPage() {
  if (!currentProject || detailPageNo !== null) return;
  const pages = currentProject.pages.filter((page) => page.include);
  if (!pages.length) return;
  const last = currentProject.last_page_no;
  const target =
    (last && pages.find((page) => page.page_no === last)) ||
    pages.find((page) => {
      const review = page.review || {};
      return (review.unreviewed || 0) > 0 || (review.uncertain || 0) > 0;
    }) ||
    pages[0];
  openPageDetail(target.page_no);
}

function closePageDetail() {
  detailPageNo = null;
  if (boxCreateMode) setBoxCreateMode(false);
  candidateRunId = null;
  auxData = null;
  el("aux-panel").hidden = true;
  el("candidate-panel").hidden = true;
}

/** 把"上次位置"写回项目（说明书 7.2 的"继续"）。写不进去也不影响当前操作。 */
function savePosition(view, pageNo) {
  if (!currentProject) return;
  const page = currentProject.pages.find((item) => item.page_no === pageNo);
  apiJson(`/api/projects/${currentProject.project_id}/position`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view, page_id: page ? page.page_id : null }),
  }).catch(() => {
    /* 位置只是"下次继续"的便利信息，记不上不该打断审校 */
  });
}

/**
 * 载入一页：块 + 这一页的块类型建议（只读）。
 *
 * 建议与块一起取回、一次渲染：徽章不会晚一步才冒出来，也不会因为异步到达
 * 把正在编辑的块重渲染一遍（那会顶掉光标）。
 * `forceSuggestions` 用于"刚进页面 / 改过类型或结构 / 撤销重做"——
 * 接口只返回差异，采用后重拉一次徽章就自然消失。
 */
async function loadPageDetail(pageNo, { forceSuggestions = false } = {}) {
  const project = currentProject;
  if (!project) return;
  const suggestionsPromise =
    project.kind === "package"
      ? Promise.resolve({ suggestions: [], note: null })
      : fetchPageSuggestions(pageNo, { force: forceSuggestions }).catch(() => ({
          suggestions: [],
          note: null,
        }));
  try {
    const data = await apiJson(
      `/api/projects/${project.project_id}/pages/${pageNo}/blocks`
    );
    const suggestions = await suggestionsPromise;
    if (detailPageNo !== null && detailPageNo !== pageNo) return;
    applyDetailSuggestions(suggestions);
    renderPageDetail(data);
  } catch (error) {
    showError(el("page-detail-error"), error);
  }
}

function applyDetailSuggestions(payload) {
  detailSuggestions =
    payload && Array.isArray(payload.suggestions) ? payload.suggestions : [];
  detailSuggestionByBlock = new Map(
    detailSuggestions.map((item) => [item.block_id, item])
  );
}

/** 只重拉建议、刷新块头徽章；不动块文本（结构 / 候选结果变了之后用）。 */
async function refreshDetailSuggestions() {
  if (detailPageNo === null || !currentProject) return;
  const pageNo = detailPageNo;
  forgetPageSuggestions(pageNo);
  let payload = null;
  try {
    payload = await fetchPageSuggestions(pageNo);
  } catch {
    return;
  }
  if (detailPageNo !== pageNo || !currentProject) return;
  applyDetailSuggestions(payload);
  renderSuggestionTools();
  renderReviewBlocks(reviewBlocks);
}

// ---------------------------------------------------------------- 翻页（审校视图顶栏）

/** 翻页时在哪一类页面之间走：默认全部正文页，也可以只看"还没审完"这类。 */
function pagerPages() {
  if (!currentProject) return [];
  const kind = el("review-jump-filter").value;
  return currentProject.pages.filter((page) => {
    if (!page.include) return false;
    if (!kind) return true;
    return matchesTriage(page, recognitionOf(page), kind);
  });
}

/** 顶栏的翻页控件：第 N 页（印 M）+ 上一页 / 下一页（说明书 7.4）。 */
function renderReviewPager() {
  const node = el("review-page-no");
  node.textContent = "";
  const page =
    currentProject && detailPageNo !== null
      ? currentProject.pages.find((item) => item.page_no === detailPageNo)
      : null;
  if (!page) {
    node.textContent = "—";
    el("review-prev").disabled = true;
    el("review-next").disabled = true;
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
  el("review-prev").disabled = index <= 0;
  el("review-next").disabled = index < 0 || index >= pages.length - 1;
}

function stepPage(delta) {
  const pages = pagerPages();
  if (!pages.length || detailPageNo === null) return;
  const index = pages.findIndex((item) => item.page_no === detailPageNo);
  const target = index < 0 ? pages[0] : pages[index + delta];
  if (target) openPageDetail(target.page_no);
}

// ---------------------------------------------------------------- 原图缩放与块框

/** null = 适合宽度；数字 = 相对"适合宽度"的倍数（说明书画面上只做这几档）。 */
let zoomLevel = null;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function fitWidth() {
  const scroll = el("viewer-scroll");
  return Math.max(280, scroll.clientWidth - 44);
}

function applyZoom() {
  const canvas = el("detail-canvas");
  const image = el("detail-image");
  if (!image || !image.naturalWidth) return;
  const base = fitWidth();
  const width = zoomLevel === null ? base : Math.round(base * zoomLevel);
  canvas.style.width = `${width}px`;
  el("zoom-fit").classList.toggle("is-on", zoomLevel === null);
  // 顺序号 / 悬停卡片是像素定位的：宽度变了要重新找空位
  scheduleOverlayLayout(el("detail-overlay"));
}

function zoomBy(delta) {
  const current = zoomLevel ?? 1;
  const at = ZOOM_STEPS.findIndex((value) => value >= current - 0.001);
  const index = Math.min(ZOOM_STEPS.length - 1, Math.max(0, (at < 0 ? 2 : at) + delta));
  zoomLevel = ZOOM_STEPS[index] === 1 ? null : ZOOM_STEPS[index];
  applyZoom();
}

function setupViewerTools() {
  el("zoom-in").addEventListener("click", () => zoomBy(1));
  el("zoom-out").addEventListener("click", () => zoomBy(-1));
  el("zoom-fit").addEventListener("click", () => {
    zoomLevel = null;
    applyZoom();
  });
  el("toggle-overlay").addEventListener("click", () => {
    const on = !el("toggle-overlay").classList.contains("is-on");
    el("toggle-overlay").classList.toggle("is-on", on);
    el("detail-overlay").hidden = !on;
    el("toggle-overlay").textContent = on ? "显示块框" : "块框已隐藏";
    if (on) scheduleOverlayLayout(el("detail-overlay"));
  });
  window.addEventListener("resize", () => {
    if (zoomLevel === null) applyZoom();
  });
}

function setupReviewPager() {
  el("review-prev").addEventListener("click", () => stepPage(-1));
  el("review-next").addEventListener("click", () => stepPage(1));
  el("review-jump-filter").addEventListener("change", renderReviewPager);
  el("review-jump").addEventListener("click", () => {
    const answer = window.prompt("跳到第几页？", detailPageNo ? String(detailPageNo) : "");
    if (!answer) return;
    const pageNo = Number(answer.trim());
    if (!Number.isInteger(pageNo) || !currentProject.pages.some((p) => p.page_no === pageNo)) {
      setSaveState(`没有第 ${answer.trim()} 页`, true);
      return;
    }
    openPageDetail(pageNo);
  });
}

function renderPageDetail(data) {
  const pageNo = data.page.page_no;
  reviewBlocks = data.blocks;
  detailLines = (data.blocks || []).flatMap((block) => block.lines || []);

  const recognition = recognitionOf(data.page);
  el("page-detail-title").textContent = `第 ${pageNo} 页`;
  el("page-detail-meta").textContent = reviewMetaText(data);

  renderReviewBanner(data, recognition);
  renderHistoryButtons(data.history);
  const hasCandidate = recognition.status === "has_candidate";
  el("candidate-open").hidden = !hasCandidate;
  if (!hasCandidate) {
    el("candidate-panel").hidden = true;
    candidateRunId = null;
  }
  el("detail-recognize").hidden = currentProject.kind === "package";
  el("aux-run").hidden = currentProject.kind === "package";
  renderReviewPager();

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
      applyZoom();
    };
    image.onerror = () => {
      el("detail-image-status").textContent = "这一页渲染失败。";
    };
    image.src =
      `/api/projects/${project_id()}/pages/${pageNo}/image?size=view` +
      `&token=${encodeURIComponent(token)}`;
  } else {
    applyZoom();
  }

  drawDetailLines();
  drawDetailOverlay(data.blocks);
  renderReviewBlocks(data.blocks);
  renderSuggestionTools();
}

function project_id() {
  return currentProject ? currentProject.project_id : "";
}

function reviewMetaText(data) {
  const review = data.review || {};
  const divergence = divergenceOf(data);
  const layoutLines = data.layout_lines || {};
  const parts = [
    PAGE_TYPE_LABELS[data.page.page_type] || data.page.page_type,
    `${review.block_count || 0} 块`,
    `未审 ${review.unreviewed || 0}`,
  ];
  if (review.layout_confirmed) {
    parts.push(`版面已确认 ${review.layout_confirmed}/${review.included || review.block_count || 0}`);
  }
  if (layoutLines.conflict) parts.push(`冲突 ${layoutLines.conflict} 行`);
  if (layoutLines.unassigned) parts.push(`未归属 ${layoutLines.unassigned} 行`);
  if (review.uncertain) parts.push(`不确定 ${review.uncertain}`);
  if (review.modified) parts.push(`已修改 ${review.modified}`);
  if (divergence.lines) parts.push(`两路分歧 ${divergence.lines} 行`);
  // 用的是哪个引擎（识别来源）放 tooltip，不占标题这一行
  if (data.active_run) {
    el("page-detail-meta").title =
      `本页识别来自 ${data.active_run.engine_id} ${data.active_run.engine_version}`;
  }
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
    messages.push(
      isPackageProject()
        ? "这一页的块是任务包里带进来的快照；任务包不做识别，直接审校即可。"
        : "这一页还没识别过。点右上角的「重新识别」。"
    );
  }
  if (recognition.status === "running" || recognition.status === "queued") {
    messages.push("这一页正在识别或排队中，完成后块会自动出现。");
  }
  if (review.uncertain) {
    messages.push(`本页有 ${review.uncertain} 个不确定块——确认整页时它们不会被自动确认。`);
  }
  const layoutLines = data.layout_lines || {};
  if (layoutLines.conflict) {
    messages.push(
      `有 ${layoutLines.conflict} 行同时落在两个块框里（黄色虚线）：已按重叠面积归给较大的那边，请核对。`
    );
  }
  if (layoutLines.unassigned) {
    messages.push(
      `有 ${layoutLines.unassigned} 行不在任何块框里（灰色虚线）：它们没有被删除，重新拖框就能收进来。`
    );
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
const HANDLE_CORNERS = ["nw", "ne", "sw", "se"];
/** 拖框时离文字行边界多近就吸附（像素）。 */
const DRAG_SNAP_PX = 8;
/** 小于这个像素位移就算点击（不是拖动）。 */
const BOX_DRAG_MIN_PX = 3;
const MIN_BOX_SIDE = 0.005;

let boxDrag = null;
let suppressBoxClick = false;

function lineEdges() {
  const xs = [];
  const ys = [];
  for (const line of detailLines) {
    if (!line.bbox) continue;
    xs.push(line.bbox[0], line.bbox[2]);
    ys.push(line.bbox[1], line.bbox[3]);
  }
  return { xs, ys };
}

/** 最近的候选边；超出容忍距离就保持原值。 */
function nearestEdge(value, candidates, tolerance) {
  let best = value;
  let bestDistance = tolerance;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** 整体平移时，找一条能让两条边之一对齐的位移（保持框的大小不变）。 */
function bestShift(edges, candidates, tolerance) {
  let shift = 0;
  let bestDistance = tolerance;
  for (const edge of edges) {
    for (const candidate of candidates) {
      const delta = candidate - edge;
      if (Math.abs(delta) < bestDistance) {
        bestDistance = Math.abs(delta);
        shift = delta;
      }
    }
  }
  return shift;
}

/**
 * 吸附：拖角时每条被拖的边单独吸附；整体拖动时找一个平移量，让框的一边贴住文字行边界。
 * **先吸附再夹到页面内**——否则贴边的行会把框顶出页面。
 */
function snapBox(raw, mode) {
  const image = el("detail-image");
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height) return raw;
  const { xs, ys } = lineEdges();
  const toleranceX = DRAG_SNAP_PX / rect.width;
  const toleranceY = DRAG_SNAP_PX / rect.height;
  let [x0, y0, x1, y1] = raw;

  if (mode === "move") {
    const shiftX = bestShift([x0, x1], xs, toleranceX);
    const shiftY = bestShift([y0, y1], ys, toleranceY);
    const width = x1 - x0;
    const height = y1 - y0;
    x0 = Math.min(Math.max(x0 + shiftX, 0), 1 - width);
    y0 = Math.min(Math.max(y0 + shiftY, 0), 1 - height);
    return [x0, y0, x0 + width, y0 + height];
  }

  if (mode.includes("w")) x0 = nearestEdge(x0, xs, toleranceX);
  if (mode.includes("e")) x1 = nearestEdge(x1, xs, toleranceX);
  if (mode.includes("n")) y0 = nearestEdge(y0, ys, toleranceY);
  if (mode.includes("s")) y1 = nearestEdge(y1, ys, toleranceY);

  x0 = Math.min(Math.max(x0, 0), 1 - MIN_BOX_SIDE);
  y0 = Math.min(Math.max(y0, 0), 1 - MIN_BOX_SIDE);
  x1 = Math.max(Math.min(x1, 1), x0 + MIN_BOX_SIDE);
  y1 = Math.max(Math.min(y1, 1), y0 + MIN_BOX_SIDE);
  return [x0, y0, x1, y1];
}

/** 开始拖框：mode 是 "move" 或四个角之一（nw / ne / sw / se）。 */
function startBoxDrag(event, block, boxElement, mode) {
  if (boxCreateMode || !el("toggle-overlay").classList.contains("is-on")) return;
  if (event.button !== undefined && event.button !== 0) return;
  const image = el("detail-image");
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height || !block.bbox) return;
  event.preventDefault();
  event.stopPropagation();
  boxDrag = {
    block,
    boxElement,
    mode,
    startX: event.clientX,
    startY: event.clientY,
    startBbox: [...block.bbox],
    bbox: [...block.bbox],
    rect,
    moved: false,
  };
  boxElement.classList.add("box--dragging");
  document.body.classList.add("box-dragging");
}

function onBoxPointerMove(event) {
  if (!boxDrag) return;
  const dx = (event.clientX - boxDrag.startX) / boxDrag.rect.width;
  const dy = (event.clientY - boxDrag.startY) / boxDrag.rect.height;
  if (Math.hypot(event.clientX - boxDrag.startX, event.clientY - boxDrag.startY) > BOX_DRAG_MIN_PX) {
    boxDrag.moved = true;
  }
  const [sx0, sy0, sx1, sy1] = boxDrag.startBbox;
  const mode = boxDrag.mode;
  let raw;
  if (mode === "move") {
    const width = sx1 - sx0;
    const height = sy1 - sy0;
    const nx0 = Math.min(Math.max(sx0 + dx, 0), 1 - width);
    const ny0 = Math.min(Math.max(sy0 + dy, 0), 1 - height);
    raw = [nx0, ny0, nx0 + width, ny0 + height];
  } else {
    raw = [
      mode.includes("w") ? sx0 + dx : sx0,
      mode.includes("n") ? sy0 + dy : sy0,
      mode.includes("e") ? sx1 + dx : sx1,
      mode.includes("s") ? sy1 + dy : sy1,
    ];
  }
  const bbox = snapBox(raw, mode);
  boxDrag.bbox = bbox;
  applyBoxElementRect(boxDrag.boxElement, bbox);
}

function applyBoxElementRect(box, bbox) {
  const [x0, y0, x1, y1] = bbox;
  box.style.left = `${x0 * 100}%`;
  box.style.top = `${y0 * 100}%`;
  box.style.width = `${(x1 - x0) * 100}%`;
  box.style.height = `${(y1 - y0) * 100}%`;
}

function onBoxPointerUp() {
  if (!boxDrag) return;
  const drag = boxDrag;
  boxDrag = null;
  drag.boxElement.classList.remove("box--dragging");
  document.body.classList.remove("box-dragging");
  if (!drag.moved) return; // 只是一次点击：交给 box 的 click 处理
  suppressBoxClick = true;
  const bbox = drag.bbox.map((value) => Math.round(value * 1e6) / 1e6);
  patchBlock(drag.block, { bbox });
}

function setupBoxDrag() {
  window.addEventListener("pointermove", onBoxPointerMove);
  window.addEventListener("pointerup", onBoxPointerUp);
  window.addEventListener("pointercancel", onBoxPointerUp);
}

// ---------------------------------------------------------------- 块框标注（默认不遮字）
//
// 横幅式标签放在框里任何位置都会吃掉正文（第 30 页"彼得格勒…"被盖住"彼得"）。
// 现在：
//   · 默认只留类型颜色（边框 + 框外侧左缘色条）与一个小顺序号；
//   · 顺序号自动找一个**不压任何块 / 行**的空位（框外上方、左右、下方）；
//   · 类型名 + 把握 + 「采用」+ 页码提示放进悬停 / 选中才出现的卡片，
//     卡片同样先找空位（上方 → 右 → 左 → 下方），找不到才退回框下方；
//   · 同一时刻只显示一张卡片（CSS :hover + 选中块互斥）。
// 位置按像素算、随缩放重算；用相对块框的 px 偏移，不写百分比。

const BOX_ORDER_WIDTH = 20;
const BOX_ORDER_HEIGHT = 13;
const BOX_ORDER_GAP = 3;
const BOX_LABEL_GAP = 6;

function boxTypeLabel(block) {
  return BLOCK_TYPE_LABELS[block.block_type] || block.block_type;
}

function pxRect(bbox, width, height) {
  return {
    x0: bbox[0] * width,
    y0: bbox[1] * height,
    x1: bbox[2] * width,
    y1: bbox[3] * height,
  };
}

function rectsOverlap(a, b, pad = 0) {
  return (
    a.x0 < b.x1 + pad &&
    a.x1 > b.x0 - pad &&
    a.y0 < b.y1 + pad &&
    a.y1 > b.y0 - pad
  );
}

/** 默认态的小顺序号；类型文字不在图上常驻（右侧块列表里有）。 */
function buildBoxOrder(index) {
  const order = document.createElement("span");
  order.className = "box__order";
  order.textContent = String(index + 1);
  return order;
}

/**
 * 悬停 / 选中卡片：类型 + 把握 + 「采用」+ 页码提示。
 * 只在鼠标停在该块、或该块被选中（`.box--active`）时出现，位置在框外。
 */
function buildBoxLabel(block, index, suggestion) {
  const label = document.createElement("div");
  label.className = "box__label";

  const head = document.createElement("div");
  head.className = "box__label-head";
  const no = document.createElement("span");
  no.className = "box__label-no";
  no.textContent = `#${index + 1}`;
  const type = document.createElement("strong");
  type.className = "box__label-type";
  type.textContent = boxTypeLabel(block);
  head.append(no, type);

  if (suggestion) {
    // 建议存在时写成"现在的类型 → 建议的类型"，否则"段落 · 把握较大"看不出在建议什么
    const arrow = document.createElement("span");
    arrow.className = "box__label-arrow";
    arrow.textContent = "→";
    const target = document.createElement("strong");
    target.className = `box__label-type box__label-type--${suggestion.suggested_type}`;
    target.textContent =
      BLOCK_TYPE_LABELS[suggestion.suggested_type] || suggestion.suggested_type;
    head.append(arrow, target);

    const confidence = document.createElement("span");
    confidence.className = `box__label-conf box__label-conf--${suggestion.confidence}`;
    confidence.textContent = suggestion.confidence_label;
    head.append(confidence);

    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "btn btn--sm box__label-apply";
    apply.textContent = "采用";
    apply.title = `把这一块改成「${BLOCK_TYPE_LABELS[suggestion.suggested_type] || suggestion.suggested_type}」（可撤销）`;
    apply.addEventListener("pointerdown", (event) => event.stopPropagation());
    apply.addEventListener("click", (event) => {
      event.stopPropagation();
      adoptBlockSuggestion(suggestion);
    });
    head.append(apply);
  }

  const notes = [];
  if (!block.include) notes.push("已排除");
  else if (TEXT_FREE_BLOCK_TYPES.has(block.block_type)) notes.push("不输出文本");
  else if (CHROME_BLOCK_TYPES.has(block.block_type)) notes.push("导出时排除");
  if (block.layout_confirmed) notes.push("版面已确认");
  if (block.review_status === "uncertain") notes.push("不确定");
  if (notes.length) {
    const note = document.createElement("span");
    note.className = "box__label-note";
    note.textContent = notes.join(" · ");
    head.append(note);
  }
  label.append(head);

  // 书眉里的页码只在悬停卡片里出现，不常驻压字
  if (suggestion) {
    const pageNumber = pageNumberHintChip(suggestion);
    if (pageNumber) {
      pageNumber.classList.add("box__label-hint");
      label.append(pageNumber);
    }
  }

  // 卡片自己不吃拖动；「采用」按钮另有处理
  label.addEventListener("pointerdown", (event) => event.stopPropagation());
  label.addEventListener("click", (event) => event.stopPropagation());
  return label;
}

/** 顺序号的位置：先找框边空位；密集页没有缝隙时退到页边留白（像行号）。 */
function findOrderSpot(own, obstacles, width, height) {
  const w = BOX_ORDER_WIDTH;
  const h = BOX_ORDER_HEIGHT;
  const gap = BOX_ORDER_GAP;
  const preferLeft = (own.x0 + own.x1) / 2 <= width / 2;
  const marginCandidates = preferLeft
    ? [[2, own.y0], [width - w - 2, own.y0]]
    : [[width - w - 2, own.y0], [2, own.y0]];
  const candidates = [
    [own.x1 - w, own.y0 - gap - h], // 右上（框外）
    [own.x0 - gap - w, own.y0], // 左上（框外）
    [own.x1 + gap, own.y0], // 右侧
    [own.x1 - w, own.y1 + gap], // 右下
    [own.x0 - gap - w, own.y1 + gap], // 左下
    ...marginCandidates, // 页边留白：密集页里唯一保证不压字的位置
  ];
  for (const [x, y] of candidates) {
    const rect = { x0: x, y0: y, x1: x + w, y1: y + h };
    if (x < 0 || y < 0 || rect.x1 > width || rect.y1 > height) continue;
    if (obstacles.some((obstacle) => rectsOverlap(rect, obstacle, 1))) continue;
    return rect;
  }
  return null;
}

/**
 * 悬停卡片的位置：优先贴着框的上 / 右 / 左 / 下；密集页这些位置都会压到
 * 相邻行，于是退到"本行旁边最宽的那条留白"（左右页边），再不行才去整页留白。
 * **任何候选都要避开所有行框**，所以卡片不会遮正文。
 */
function findLabelSpot(own, size, obstacles, width, height) {
  const gap = BOX_LABEL_GAP;
  const fitX = (x) => Math.min(Math.max(x, 0), Math.max(0, width - size.width));
  const fitY = (y) => Math.min(Math.max(y, 0), Math.max(0, height - size.height));

  // 本行留白：卡片纵向居中于本块，横向放到"与它同一横带的所有行"之外
  const bandY = Math.min(
    Math.max(own.y0 + (own.y1 - own.y0) / 2 - size.height / 2, 0),
    Math.max(0, height - size.height)
  );
  const band = obstacles.filter(
    (obstacle) => obstacle.y0 < bandY + size.height && obstacle.y1 > bandY
  );
  const bandRight = band.length ? Math.max(...band.map((item) => item.x1)) : own.x1;
  const bandLeft = band.length ? Math.min(...band.map((item) => item.x0)) : own.x0;

  const candidates = [
    { x0: fitX(own.x0), y0: own.y0 - gap - size.height },
    { x0: own.x1 + gap, y0: fitY(own.y0) },
    { x0: own.x0 - gap - size.width, y0: fitY(own.y0) },
    { x0: fitX(own.x0), y0: own.y1 + gap },
    // 本行旁边的页边（密集页：右边通常比左边宽）
    { x0: bandRight + gap, y0: bandY },
    { x0: bandLeft - gap - size.width, y0: bandY },
    // 整页留白（避开所有块框 / 行框）：顶部 → 底部 → 两侧
    { x0: 4, y0: 4 },
    { x0: width - size.width - 4, y0: 4 },
    { x0: (width - size.width) / 2, y0: 4 },
    { x0: 4, y0: height - size.height - 4 },
    { x0: width - size.width - 4, y0: height - size.height - 4 },
    { x0: 4, y0: fitY((height - size.height) / 2) },
    { x0: width - size.width - 4, y0: fitY((height - size.height) / 2) },
  ];
  for (const candidate of candidates) {
    const rect = {
      x0: candidate.x0,
      y0: candidate.y0,
      x1: candidate.x0 + size.width,
      y1: candidate.y0 + size.height,
    };
    if (rect.x0 < 0 || rect.y0 < 0 || rect.x1 > width || rect.y1 > height) continue;
    if (obstacles.some((obstacle) => rectsOverlap(rect, obstacle, 2))) continue;
    return rect;
  }
  // 实在没有空白：退到框下方（可能压到下一块，但至少不挡正在看的这一行）
  const x = fitX(own.x1 - size.width);
  const y = Math.min(Math.max(own.y1 + gap, 0), Math.max(0, height - size.height));
  return { x0: x, y0: y, x1: x + size.width, y1: y + size.height };
}

/**
 * 给一个 overlay 里的所有块框摆好顺序号与悬停卡片。
 * 图还没布局好（宽高为 0）时返回 false，调用方会在下一帧重试。
 */
function layoutOverlayAnnotations(overlay) {
  if (!overlay || !overlay.isConnected || overlay.hidden) return false;
  const rect = overlay.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (width < 60 || height < 60) return false;

  const obstacles = [];
  for (const box of overlay.querySelectorAll(".box")) {
    if (box._bbox) obstacles.push(pxRect(box._bbox, width, height));
  }
  for (const bbox of overlay._lineBboxes || []) {
    if (bbox) obstacles.push(pxRect(bbox, width, height));
  }

  for (const box of overlay.querySelectorAll(".box")) {
    if (!box._bbox) continue;
    const own = pxRect(box._bbox, width, height);
    const offsetX = box.clientLeft || 0;
    const offsetY = box.clientTop || 0;

    const order = box.querySelector(".box__order");
    if (order) {
      const spot = findOrderSpot(own, obstacles, width, height);
      order.classList.toggle("box__order--inside", !spot);
      const at = spot || { x0: own.x1 - BOX_ORDER_WIDTH - 2, y0: own.y0 + 2 };
      order.style.left = `${at.x0 - own.x0 - offsetX}px`;
      order.style.top = `${at.y0 - own.y0 - offsetY}px`;
      // 后面的顺序号也不许压到前面已经摆好的号
      obstacles.push({ x0: at.x0, y0: at.y0, x1: at.x0 + BOX_ORDER_WIDTH, y1: at.y0 + BOX_ORDER_HEIGHT });
    }

    const label = box.querySelector(".box__label");
    if (label) {
      const size = { width: label.offsetWidth, height: label.offsetHeight };
      if (!size.width || !size.height) continue;
      const spot = findLabelSpot(own, size, obstacles, width, height);
      label.style.left = `${spot.x0 - own.x0 - offsetX}px`;
      label.style.top = `${spot.y0 - own.y0 - offsetY}px`;
    }
  }
  return true;
}

/** 图还没出来时等它：每帧重试，直到 overlay 有尺寸（最多约 1.5 秒）。 */
function scheduleOverlayLayout(overlay, attempt = 0) {
  if (!overlay || overlay.hidden) return;
  const token = (overlay._layoutToken = (overlay._layoutToken || 0) + 1);
  requestAnimationFrame(() => {
    if (overlay._layoutToken !== token || !overlay.isConnected) return;
    if (layoutOverlayAnnotations(overlay)) return;
    if (attempt < 90) scheduleOverlayLayout(overlay, attempt + 1);
  });
}

/**
 * 尺寸变了就重新找空位（缩放、窗口变化）。
 *
 * 只靠 applyZoom 里排一帧不够：样式刚改完的那一帧，overlay 的矩形偶尔还是旧宽度，
 * 顺序号会按旧尺寸摆一次就不再重算（实测 4/4 档第一次放大有 3 个号压块）。
 */
let overlayResizeObserver = null;

function observeOverlaySize(overlay) {
  if (!overlay || typeof ResizeObserver === "undefined") return;
  if (!overlayResizeObserver) {
    overlayResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target.isConnected) scheduleOverlayLayout(entry.target);
      }
    });
  }
  if (!overlay._resizeObserved) {
    overlayResizeObserver.observe(overlay);
    overlay._resizeObserved = true;
  }
}

function drawDetailOverlay(blocks) {
  const overlay = el("detail-overlay");
  overlay.innerHTML = "";
  // 行框也当作障碍：顺序号 / 卡片不许压到任何一行（含未归属 / 冲突行）
  overlay._lineBboxes = (detailLines || [])
    .map((line) => line.bbox)
    .filter(Boolean);
  blocks.forEach((block, index) => {
    if (!block.bbox) return;
    const box = document.createElement("div");
    box.className = "box";
    box.classList.add(`box--type-${block.block_type}`);
    if (!block.include) box.classList.add("box--excluded");
    if (CHROME_BLOCK_TYPES.has(block.block_type)) box.classList.add("box--chrome");
    if (TEXT_FREE_BLOCK_TYPES.has(block.block_type)) box.classList.add("box--textfree");
    if (block.review_status === "uncertain") box.classList.add("box--uncertain");
    box.dataset.blockId = block.block_id;
    box.dataset.type = block.block_type;
    box._bbox = block.bbox;
    applyBoxElementRect(box, block.bbox);
    box.title =
      `${boxTypeLabel(block)} · 第 ${index + 1} 块 · 拖动移位、拖角缩放` +
      (block.layout_confirmed ? " · 版面已确认" : "");

    // 默认只给顺序号；类型 / 把握 / 采用 / 页码在悬停（或选中）卡片里
    const suggestion = detailSuggestionByBlock.get(block.block_id);
    box.append(buildBoxOrder(index));
    box.append(buildBoxLabel(block, index, suggestion));

    // 四个角是缩放手柄；手柄吃掉 pointerdown，免得同时触发整框拖动
    for (const corner of HANDLE_CORNERS) {
      const handle = document.createElement("span");
      handle.className = `box__handle box__handle--${corner}`;
      handle.title = "拖这个角缩放（会吸附到文字行边界）";
      handle.addEventListener("pointerdown", (event) =>
        startBoxDrag(event, block, box, corner)
      );
      box.append(handle);
    }

    box.addEventListener("pointerdown", (event) => startBoxDrag(event, block, box, "move"));
    box.addEventListener("click", (event) => {
      if (suppressBoxClick) {
        suppressBoxClick = false;
        return;
      }
      event.stopPropagation();
      const item = el("detail-blocks").querySelector(`li[data-block-id="${block.block_id}"]`);
      if (item) {
        selectReviewBlock(block.block_id);
        item.querySelector("textarea").focus();
        item.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
    overlay.append(box);
  });
  observeOverlaySize(overlay);
  // 先同步摆一次（getBoundingClientRect 会强制布局），再等下一帧处理"图还没出来"的情况
  layoutOverlayAnnotations(overlay);
  scheduleOverlayLayout(overlay);
}

/** 未归属 / 冲突的行：灰色 / 黄色虚线画在原图上，一条都不丢。 */
function drawDetailLines() {
  const layer = el("detail-lines");
  layer.innerHTML = "";
  for (const line of detailLines) {
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

// ---------------------------------------------------------------- 块类型建议（审校视图）
//
// 徽章只说"建议 + 把握"，不是待办：有建议的块仍然是"未审"，要人点「采用」
// 才走 PATCH block_type（进事件表、可撤销）；review 只能一条一条点。

function suggestionHighList() {
  return detailSuggestions.filter((item) => item.confidence === "high");
}

function renderSuggestionTools() {
  const button = el("suggestion-apply-all");
  if (!button) return;
  const high = suggestionHighList();
  if (!high.length) {
    button.hidden = true;
    button.textContent = "";
    button.removeAttribute("title");
    return;
  }
  const labels = [
    ...new Set(
      high.map((item) => BLOCK_TYPE_LABELS[item.suggested_type] || item.suggested_type)
    ),
  ];
  button.hidden = false;
  button.textContent = `采用全部建议（${high.length}）`;
  button.title =
    `本页有 ${high.length} 条把握较大的建议（${labels.join(" / ")}）：` +
    "一次改成对应类型，只改类型、不改审校状态；每一块都能单独撤销。";
}

/**
 * 书眉 / 页脚里夹着的页码：**只展示**。
 * 不自动拆块、不改文本；导出时 meta.json 会再按同一套规则抽一次。
 */
function pageNumberHintChip(suggestion) {
  const candidates = suggestion.page_number_candidates || [];
  if (!candidates.length) return null;
  const hint = suggestion.page_number_hint;
  const texts = candidates.map((item) => item.text).join(" / ");
  const chip = document.createElement("span");
  chip.className = "review-suggest__pagenum";
  chip.textContent = hint
    ? `含页码 ${hint.text}（候选 ${texts}）`
    : `页码候选 ${texts}`;
  chip.title =
    "页码提示只作参考：不会自动拆块或改文本。" +
    (hint ? `按页面外侧估计是 ${hint.text}，` : "") +
    "导出 meta.json 时会再按页码块 / 页眉页脚里的数字抽一次。";
  return chip;
}

function blockSuggestionBadge(suggestion) {
  const typeLabel =
    BLOCK_TYPE_LABELS[suggestion.suggested_type] || suggestion.suggested_type;
  const wrap = document.createElement("span");
  wrap.className = `review-suggest review-suggest--${suggestion.suggested_type}`;
  wrap.title =
    `建议：${typeLabel}（${suggestion.confidence_label}）\n` +
    (suggestion.reason || "") +
    "\n只改块类型：不改审校状态、不删文字；采用后可撤销。";

  const label = document.createElement("span");
  label.className = "review-suggest__label";
  label.textContent = `${typeLabel} · ${suggestion.confidence_label}`;
  wrap.append(label);

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "btn btn--sm review-suggest__apply";
  apply.textContent = "采用";
  apply.title = `把这一块改成「${typeLabel}」（可撤销）`;
  apply.addEventListener("click", (event) => {
    event.stopPropagation();
    adoptBlockSuggestion(suggestion);
  });
  wrap.append(apply);

  const pageNumber = pageNumberHintChip(suggestion);
  if (pageNumber) wrap.append(pageNumber);
  return wrap;
}

/** 采用一条建议：走现有 PATCH block_type，重拉本页建议后徽章自然消失。 */
async function adoptBlockSuggestion(suggestion) {
  if (!currentProject || detailPageNo === null) return;
  // 先把还没发出去的自动保存落库，免得随后的整页重渲染把刚打的字盖掉
  await flushPendingSave();
  const block = (reviewBlocks || []).find(
    (item) => item.block_id === suggestion.block_id
  );
  if (!block) {
    setSaveState("这一块已经不在本页了，先重新载入", true);
    return;
  }
  forgetPageSuggestions(detailPageNo);
  await patchBlock(block, { block_type: suggestion.suggested_type });
}

/**
 * 本页全部采用：**只对 high**（review 必须逐条点，避免把弱建议批量套上）。
 * 逐块 PATCH 同一个接口；中途失败不会静默，最后如实说改了几条。
 */
async function adoptAllHighSuggestions() {
  if (!currentProject || detailPageNo === null) return;
  const high = suggestionHighList();
  if (!high.length) return;
  await flushPendingSave();
  const targets = [];
  for (const item of high) {
    const block = (reviewBlocks || []).find(
      (entry) => entry.block_id === item.block_id
    );
    if (block) targets.push({ item, block });
  }
  if (!targets.length) return;
  const labels = [
    ...new Set(
      targets.map(
        (target) => BLOCK_TYPE_LABELS[target.item.suggested_type] || target.item.suggested_type
      )
    ),
  ];
  const ok = window.confirm(
    `本页有 ${targets.length} 条把握较大的建议（${labels.join(" / ")}）。\n\n` +
      "全部采用会把对应块改成建议类型——只改类型，不改审校状态，也不删文字；" +
      "每一块都能单独撤销。继续吗？"
  );
  if (!ok) return;

  const pageNo = detailPageNo;
  const projectId = currentProject.project_id;
  setSaveState("正在采用建议…");
  let changed = 0;
  let failed = 0;
  for (const { item } of targets) {
    const fresh = (reviewBlocks || []).find(
      (entry) => entry.block_id === item.block_id
    );
    if (!fresh) continue;
    try {
      await apiJson(`/api/projects/${projectId}/blocks/${item.block_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          block_type: item.suggested_type,
          expected_revision: fresh.revision,
        }),
      });
      changed += 1;
    } catch {
      failed += 1;
    }
  }
  forgetPageSuggestions(pageNo);
  setSaveState(
    failed
      ? `已采用 ${changed} 条，${failed} 条没改成（可能被别处改过）`
      : `已采用 ${changed} 条建议 ✓`,
    failed > 0
  );
  await loadPageDetail(pageNo);
  await refreshPageStates();
}

function blockCard(block, index, blocksCount) {
  const item = document.createElement("li");
  item.className = "review-block";
  item.dataset.blockId = block.block_id;
  item.dataset.index = String(index);
  if (!block.include) item.classList.add("review-block--excluded");
  if (CHROME_BLOCK_TYPES.has(block.block_type)) {
    item.classList.add("review-block--chrome");
  }
  if (TEXT_FREE_BLOCK_TYPES.has(block.block_type)) {
    item.classList.add("review-block--textfree");
  }
  const blockDivergence = divergenceOf(block);
  if (blockDivergence.chars) item.classList.add("review-block--divergence");

  const head = document.createElement("div");
  head.className = "review-block__head";

  const typeSelect = document.createElement("select");
  typeSelect.className = "review-block__type";
  typeSelect.title =
    "块类型（页眉 / 页脚 / 页码在导出时默认排除；插图 / 装饰不输出文本）";
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
    "chip " +
    (block.review_status === "confirmed"
      ? "chip--ok"
      : block.review_status === "uncertain"
      ? "chip--warn"
      : "chip--gray");
  status.textContent =
    block.review_status === "confirmed"
      ? "✓ 已确认"
      : REVIEW_STATUS_LABELS[block.review_status] || block.review_status;

  // 头一行：类型标签 + （靠右）状态与几个"要人看一眼"的标记（效果图 03）
  // 与类型本身有关的标记（导出时排除 / 已排除）贴着类型标签放左边，状态放右边
  const typeBits = [];
  if (!block.include) typeBits.push(["已排除", "chip--gray"]);
  else if (TEXT_FREE_BLOCK_TYPES.has(block.block_type)) {
    typeBits.push(["不输出文本", "chip--gray"]);
  } else if (CHROME_BLOCK_TYPES.has(block.block_type)) {
    typeBits.push(["导出时排除", "chip--gray"]);
  }
  const bits = [];
  if (block.layout_confirmed) bits.push(["✓ 版面已确认", "chip--ok"]);
  if (block.modified) bits.push(["● 已修改", "chip--warn"]);
  if (block.continues_to_next) bits.push(["↪ 延续到下页", "chip--blue"]);
  if (blockDivergence.lines) bits.push([`≠ 两路不一致 ${blockDivergence.lines} 行`, "chip--warn"]);
  // 行归属：改框之后每一行都有交代（assigned / conflict / unassigned）
  const blockLines = block.lines || [];
  const conflictLines = blockLines.filter((line) => line.layout_status === "conflict").length;
  const unassignedLines = blockLines.filter((line) => line.layout_status === "unassigned").length;
  if (conflictLines) bits.push([`冲突行 ${conflictLines}`, "chip--warn"]);
  if (unassignedLines) bits.push([`未归属行 ${unassignedLines}`, "chip--gray"]);
  // 说明书 6.4：无 bbox 的块要明确显示"无位置信息"，不绘制虚假高亮
  if (!block.bbox) bits.push(["无位置信息", "chip--gray"]);

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.append(typeSelect);
  // 块类型建议：紧贴类型下拉，轻量虚线徽章 + 逐条「采用」；没有建议的块什么都不显示
  const suggestion = detailSuggestionByBlock.get(block.block_id);
  if (suggestion) head.append(blockSuggestionBadge(suggestion));
  for (const [text, cls] of typeBits) {
    const chip = document.createElement("span");
    chip.className = `chip ${cls}`;
    chip.textContent = text;
    head.append(chip);
  }
  if (blockDivergence.chars) {
    const warn = document.createElement("span");
    warn.className = "chip chip--warn";
    warn.textContent = `≠ ${blockDivergence.lines} 行`;
    warn.title = "这一块有汉字级分歧，尽量核对";
    head.append(warn);
  }
  head.append(spacer);
  for (const [text, cls] of bits) {
    const chip = document.createElement("span");
    chip.className = `chip ${cls}`;
    chip.textContent = text;
    head.append(chip);
  }
  head.append(status);

  const textarea = document.createElement("textarea");
  textarea.className = "review-block__text";
  textarea.value = block.text;
  textarea.rows = textRows(block.text);
  textarea.spellcheck = false;
  if (!block.text) {
    textarea.placeholder = TEXT_FREE_BLOCK_TYPES.has(block.block_type)
      ? "（这是版面块：插图 / 装饰，不输出文本）"
      : "（这一块没有文本）";
  }
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
    button.className = "btn btn--sm";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", onClick);
    actions.append(button);
  };

  addButton(
    block.layout_confirmed ? "取消版面确认" : "✓ 确认版面",
    "确认这一块的框、类型与页内顺序（状态标记；不确认也能导出）",
    () => patchBlock(block, { layout_confirmed: !block.layout_confirmed })
  );
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
  more.className = "btn btn--sm review-block__more";
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

  // 块备注（说明书 7.9.2）：有备注显示 💬 与内容，没有就给一个"添加备注"
  const commentBox = document.createElement("div");
  commentBox.className = "review-block__comment";
  const renderComment = () => {
    commentBox.innerHTML = "";
    if (block.comment) {
      const text = document.createElement("span");
      text.textContent = `💬 ${block.comment}`;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn btn--sm btn--ghost";
      edit.textContent = "改备注";
      edit.addEventListener("click", () => askComment(block, block.comment));
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "btn btn--sm btn--ghost";
      clear.textContent = "删除";
      clear.addEventListener("click", () => patchBlock(block, { comment: "" }));
      commentBox.append(text, edit, clear);
    } else {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn btn--sm btn--ghost";
      add.textContent = "💬 加备注";
      add.title = "给这一块写一句说明或提问（会随结果包一起回传给负责人）";
      add.addEventListener("click", () => askComment(block, ""));
      commentBox.append(add);
    }
  };
  renderComment();   // 有备注显示内容 + 改 / 删；没有就显示「💬 加备注」
  if (!block.comment) commentBox.classList.add("review-block__comment--empty");

  const original = document.createElement("pre");
  original.className = "review-block__original";
  original.hidden = true;
  original.textContent = block.ocr_text;

  item.append(head, textarea);
  const divergenceSection = blockDivergenceSection(block, textarea);
  if (divergenceSection) item.append(divergenceSection);
  item.append(commentBox);
  item.append(actions, original);
  return item;

  function askComment(target, current) {
    const value = window.prompt("给这一块写一句备注（留空并确定就是删除）：", current);
    if (value === null) return;
    patchBlock(target, { comment: value });
  }
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
  // 右下角的"块 3 / 12"（效果图 03）：知道自己改到哪儿了
  const items = [...el("detail-blocks").querySelectorAll(".review-block")];
  const index = items.findIndex((item) => item.dataset.blockId === blockId);
  el("block-position").textContent = index < 0 ? "" : `块 ${index + 1} / ${items.length}`;
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
  // 保存完会整页重渲染：先把"正在改哪一块、光标在哪"记下来，回来再接上。
  // 不这么做的话，打字打到一半自动保存就会把光标顶掉。
  const focusBefore = captureEditorFocus();
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
    // 类型变了：这一页的建议要重算（接口只返回差异，采用后徽章自然消失）
    if ("block_type" in patch) forgetPageSuggestions(detailPageNo);
    await loadPageDetail(detailPageNo);
    restoreEditorFocus(focusBefore);
    await refreshPageStates();
  } catch (error) {
    if (error.code === "block_conflict") {
      setSaveState("这一页在别处被改过，已重新载入", true);
      forgetPageSuggestions(detailPageNo);
      await loadPageDetail(detailPageNo);
      return;
    }
    setSaveState(error.message || "保存失败", true);
  }
}

/** 记下当前正在编辑的块与光标位置（重渲染前调用）。 */
function captureEditorFocus() {
  const active = document.activeElement;
  if (!active || active.tagName !== "TEXTAREA" || !active.classList.contains("review-block__text")) {
    return null;
  }
  const item = active.closest(".review-block");
  if (!item) return null;
  return {
    blockId: item.dataset.blockId,
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

/** 重渲染之后把光标放回原来那一块（块没了就什么都不做）。 */
function restoreEditorFocus(snapshot) {
  if (!snapshot) return;
  const item = el("detail-blocks").querySelector(`li[data-block-id="${snapshot.blockId}"]`);
  const textarea = item && item.querySelector("textarea");
  if (!textarea) return;
  textarea.focus();
  try {
    textarea.setSelectionRange(snapshot.start, snapshot.end);
  } catch {
    /* 文本变短了之类的边界情况：光标放到末尾就好 */
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
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
    // 块的结构 / 顺序变了：本页建议重算（标题建议看块首文字，可能已经不同）
    forgetPageSuggestions(detailPageNo);
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
    // 换块可能改掉类型：先清掉旧建议，重渲染后再按新块重拉（不拿旧徽章糊弄）
    forgetPageSuggestions(detailPageNo);
    applyDetailSuggestions(null);
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
    await refreshDetailSuggestions();
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
    forgetPageSuggestions(detailPageNo);
    applyDetailSuggestions(null);
    renderPageDetail({
      page: data.page,
      blocks: data.blocks,
      review: data.review,
      history: data.history,
      runs: [],
      active_run: null,
    });
    await refreshDetailSuggestions();
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
    // 撤销 / 重做可能改回块类型：建议不能拿旧缓存
    forgetPageSuggestions(detailPageNo);
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
    // 说明书 7.4："确认本页后默认跳到下一个未完成的正文页"
    const next = nextUnfinishedPage(pageNo);
    if (next) await openPageDetail(next);
    else setSaveState("整本书都审完了 🎉");
  } catch (error) {
    showError(el("page-detail-error"), error);
  }
}

/** 下一个还没审完的正文页（有未审或不确定的块）。 */
function nextUnfinishedPage(afterPageNo) {
  const next = currentProject.pages.find((page) => {
    if (!page.include || page.page_no <= afterPageNo) return false;
    const review = page.review || {};
    return (review.unreviewed || 0) > 0 || (review.uncertain || 0) > 0;
  });
  return next ? next.page_no : null;
}

function setupReviewControls() {
  setupBoxDrag();
  // 点别处关掉所有"⋯ 更多"菜单（只挂一次，别每次渲染都加一个监听）
  document.addEventListener("click", () => {
    for (const menu of document.querySelectorAll("#detail-blocks .review-menu")) {
      menu.hidden = true;
    }
  });
  el("review-confirm").addEventListener("click", confirmCurrentPage);
  el("suggestion-apply-all").addEventListener("click", adoptAllHighSuggestions);
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

/** 批量改页面的类型（说明书 6.2 的批量操作，第 11 节的 PATCH /pages）。 */
async function patchSelectedPages(patch) {
  const project = currentProject;
  const pages = selectionPages();
  if (!project || !pages.length || !("page_type" in patch)) return;

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
    // 类型变了，建议范围跟着变：这些页的旧建议与角标作废
    for (const updated of data.pages) forgetPageSuggestions(updated.page_no);
    renderPages();
    renderProjectMeta();
    await loadSetupSuggestions();
  } catch (error) {
    showError(el("pages-error"), error);
  }
}

async function recognizeSelection() {
  const project = currentProject;
  const pages = selectionPages().filter((page) => page.include);
  if (!project || !pages.length) return;
  if (!warnUnconfirmed(pages, "识别所选页")) return;

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
  closePageDetail();
  closeTaskDrawer();
  stopTaskPolling();
  el("task-chip").hidden = true;
  el("project-meta-section").hidden = true;
  showView("library");
  await loadLibrary();
}

function setupLibrary() {
  const picker = el("new-project-file");
  picker.addEventListener("change", () => {
    if (picker.files && picker.files[0]) createProjectFromFile(picker.files[0]);
    picker.value = "";
  });
  el("project-close").addEventListener("click", closeProject);
  setupCollabControls();
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
  el("selection-recognize").addEventListener("click", recognizeSelection);
  el("pages-zoom-out").addEventListener("click", () => setPageZoom(-1));
  el("pages-zoom-in").addEventListener("click", () => setPageZoom(1));
  el("pages-overlay-toggle").addEventListener("click", togglePageBlocksOverlay);
  el("setup-confirm-selected").addEventListener("click", confirmSelectedPages);
  el("setup-confirm-all").addEventListener("click", confirmAllUnconfirmed);
  el("detail-recognize").addEventListener("click", () => {
    if (detailPageNo === null) return;
    const page = currentProject.pages.find((item) => item.page_no === detailPageNo);
    if (page) recognizePage(page);
  });
}


// ---------------------------------------------------------------- 协作：分派任务包（负责人）

let assignPreviewData = null;
let currentAssignments = [];
let mergeState = null;

function assignRequestBody() {
  return {
    pages: [...selectedPages].sort((left, right) => left - right),
    reviewer_name: el("assign-reviewer").value.trim(),
    with_context: el("assign-context").checked,
  };
}

async function openAssignPanel() {
  if (!currentProject) return;
  el("assign-panel").hidden = false;
  el("assign-error").hidden = true;
  const pages = assignRequestBody().pages;
  el("assign-meta").textContent = pages.length
    ? `选中的第 ${pages[0]}–${pages[pages.length - 1]} 页（${pages.length} 页）`
    : "先在页面网格里选中要分派的页面";
  await previewAssign();
  await loadAssignments();
}

async function previewAssign() {
  if (!currentProject) return;
  const body = assignRequestBody();
  if (!body.pages.length) {
    el("assign-preview").textContent = "还没有选中页面。";
    return;
  }
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/assignments/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    assignPreviewData = data;
    renderAssignPreview(data);
  } catch (error) {
    showError(el("assign-error"), error);
  }
}

function renderAssignPreview(data) {
  const list = el("assign-reviewer-names");
  list.innerHTML = "";
  for (const name of data.known_reviewers || []) {
    const option = document.createElement("option");
    option.value = name;
    list.append(option);
  }

  const box = el("assign-preview");
  box.innerHTML = "";
  const summary = document.createElement("div");
  summary.textContent =
    `可派 ${data.page_count} 页` +
    (data.context_pages.length ? ` ＋ 只读上下文 ${data.context_pages.length} 页` : "") +
    `；任务包约 ${(data.estimated_bytes / (1024 * 1024)).toFixed(1)} MB`;
  box.append(summary);
  if (data.skipped && data.skipped.length) {
    const skipped = document.createElement("div");
    skipped.className = "assign-preview__skipped";
    skipped.textContent =
      "会跳过：" +
      data.skipped.map((item) => `第 ${item.page_no} 页（${item.reason}）`).join("、");
    box.append(skipped);
  }
  el("assign-create").disabled = !data.page_count || !el("assign-reviewer").value.trim();
}

async function createAssignment() {
  if (!currentProject) return;
  el("assign-error").hidden = true;
  const body = {
    ...assignRequestBody(),
    note: el("assign-note").value,
    due_date: el("assign-due").value || null,
  };
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/assignments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaveState(`任务包已生成：${data.package_name}`);
    el("assign-download").hidden = false;
    el("assign-reveal").hidden = false;
    el("assign-download").dataset.assignmentId = data.assignment.assignment_id;
    el("assign-reveal").dataset.assignmentId = data.assignment.assignment_id;
    await loadAssignments();
    await refreshPageStates();
  } catch (error) {
    showError(el("assign-error"), error);
  }
}

async function loadAssignments() {
  if (!currentProject) return;
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/assignments`);
    currentAssignments = data.assignments || [];
    renderAssignments(data.known_reviewers || []);
  } catch (error) {
    showError(el("assign-error"), error);
  }
}

function renderAssignments(knownReviewers) {
  const list = el("assign-list");
  list.innerHTML = "";
  el("assign-list-empty").hidden = currentAssignments.length > 0;
  const names = el("assign-reviewer-names");
  if (names.options.length === 0) {
    for (const name of knownReviewers) {
      const option = document.createElement("option");
      option.value = name;
      names.append(option);
    }
  }

  for (const assignment of currentAssignments) {
    const item = document.createElement("li");
    const head = document.createElement("span");
    head.textContent =
      `${assignment.reviewer_name} · 第 ${assignment.page_nos.join("、")} 页` +
      ` · ${assignment.status_label}` +
      (assignment.imported_seq ? ` · 已导入第 ${assignment.imported_seq} 次结果` : "");
    if (assignment.due_date) head.textContent += ` · 截止 ${assignment.due_date}`;
    if (assignment.note) head.title = assignment.note;
    const spacer = document.createElement("span");
    spacer.className = "spacer";

    const actions = document.createElement("span");
    const button = (label, title, onClick, disabled = false) => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = "btn btn--ghost";
      node.textContent = label;
      node.title = title;
      node.disabled = disabled;
      node.addEventListener("click", onClick);
      actions.append(node);
    };
    const id = assignment.assignment_id;
    button("下载任务包", "保存 .b2tpkg，发给助手", () => downloadPackage(id));
    if (assignment.status !== "cancelled") {
      button("重新导出", "用分派时的快照重新生成一份", () => rebuildPackage(id));
      // 可以多次导入（助手分几次发进度）；序号与作废的校验在后端
      button(
        "导入结果",
        "选助手回传的 .b2tres 结果包，进入合并审阅",
        () => pickResultFile(id)
      );
      button("作废", "页面恢复为未分派；之后收到的结果需要明确确认才能导入", () =>
        cancelAssignment(id)
      );
      if (assignment.imported_seq > 0) {
        button("查看差异", "打开合并审阅视图", () => openMergeView(id));
      }
    } else {
      button(
        "导入结果",
        "任务包已作废：确认要导入的话，导入时会再问一次",
        () => pickResultFile(id, { allowCancelled: true })
      );
    }
    item.append(head, spacer, actions);
    list.append(item);
  }
}

async function downloadPackage(assignmentId) {
  const response = await fetch(
    `/api/projects/${project_id()}/assignments/${assignmentId}/package?token=${encodeURIComponent(token)}`,
    { headers: { "X-B2T-Token": token } }
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    showError(el("assign-error"), new ApiError(
      (payload && payload.error && payload.error.message) || `下载失败（HTTP ${response.status}）`
    ));
    return;
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename\*?=(?:utf-8'')?"?([^";]+)"?/i);
  saveBlob(blob, match ? decodeURIComponent(match[1]) : "任务包.b2tpkg");
  setSaveState("任务包已下载");
}

async function rebuildPackage(assignmentId) {
  el("assign-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${project_id()}/assignments/${assignmentId}/rebuild`,
      { method: "POST" }
    );
    setSaveState(`已重新导出：${data.package_name}`);
  } catch (error) {
    showError(el("assign-error"), error);
  }
}

async function revealPackage(assignmentId) {
  try {
    const data = await apiJson(
      `/api/projects/${project_id()}/assignments/${assignmentId}/reveal`,
      { method: "POST" }
    );
    if (!data.revealed) setSaveState(data.reason || "打不开文件夹", true);
  } catch (error) {
    showError(el("assign-error"), error);
  }
}

async function cancelAssignment(assignmentId) {
  if (!window.confirm("作废这个任务包？页面会恢复为未分派；之后收到的结果需要明确确认才能导入。")) {
    return;
  }
  el("assign-error").hidden = true;
  try {
    await apiJson(`/api/projects/${project_id()}/assignments/${assignmentId}/cancel`, {
      method: "POST",
    });
    setSaveState("任务包已作废");
    await loadAssignments();
    await refreshPageStates();
  } catch (error) {
    showError(el("assign-error"), error);
  }
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------- 协作：助手端

let packagePending = null; // 等待上传的结果包给哪个任务包（导入时用）

function setupPackageControls() {
  const picker = el("open-package-file");
  el("open-package").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    if (picker.files && picker.files[0]) openPackageFile(picker.files[0]);
    picker.value = "";
  });
  el("package-export-btn").addEventListener("click", exportResultPackage);
  el("result-file-input").addEventListener("change", onResultFileChosen);
}

async function openPackageFile(file) {
  el("library-error").hidden = true;
  setSaveState("正在打开任务包…");
  try {
    const response = await fetch(
      `/api/packages/open?filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "X-B2T-Token": token, "Content-Type": "application/zip" },
        body: file,
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload && payload.error) || {};
      throw new ApiError(error.message || `打开失败（HTTP ${response.status}）`, error.code, error.correlation_id, error.detail);
    }
    setSaveState("");
    await loadLibrary();
    await openProject(payload.project.project_id);
  } catch (error) {
    showError(el("library-error"), error);
  }
}

/** 审校包项目：显示任务横幅、藏掉不该有的功能、显示"导出审校结果"。 */
async function applyPackageMode() {
  const project = currentProject;
  if (!project) return;
  if (project.kind !== "package") {
    el("package-banner").hidden = true;
    el("package-open").hidden = true;
    closeModal("package-result");
    el("export-open").hidden = false;
    el("structure-open").hidden = false;
    el("selection-recognize").hidden = false;
    el("recognize-pending").hidden = false;
    el("selection-check").hidden = false;
    el("check-pending").hidden = false;
    el("selection-skip-checked").parentElement.hidden = false;
    el("setup-panel").hidden = false;
    el("page-setup-bar").hidden = false;
    el("assign-list-toggle").hidden = false;
    el("assign-open").hidden = false;
    return;
  }

  el("export-open").hidden = true;          // 助手不能导出 TXT / JSONL
  el("package-open").hidden = false;        // 但能导出审校结果包
  el("structure-open").hidden = true;       // 也没有页眉页脚工具
  el("assign-list-toggle").hidden = true;   // 助手不派活给别人
  el("assign-open").hidden = true;
  el("selection-recognize").hidden = true;
  el("recognize-pending").hidden = true;
  el("selection-check").hidden = true;
  el("check-pending").hidden = true;
  el("selection-skip-checked").parentElement.hidden = true;
  el("setup-panel").hidden = true;
  el("page-setup-bar").hidden = true;
  el("detail-recognize").hidden = true;
  el("aux-run").hidden = true;

  try {
    const data = await apiJson(`/api/projects/${project.project_id}/package`);
    const info = data.package;
    const banner = el("package-banner");
    banner.hidden = false;
    banner.textContent =
      `审校任务：第 ${info.page_nos.join("、")} 页` +
      (info.context_page_nos.length
        ? `（另附只读上下文第 ${info.context_page_nos.join("、")} 页）`
        : "") +
      ` · 来自 ${info.owner_name || "负责人"}` +
      (info.due_date ? ` · 截止 ${info.due_date}` : "") +
      (info.note ? ` · 说明：${info.note}` : "");
    el("package-result-meta").textContent = `${info.book_name} · 审校人 ${info.reviewer_name}`;
    await loadPackageResults(project.project_id);
  } catch (error) {
    showError(el("library-error"), error);
  }
}

async function loadPackageResults(projectId) {
  try {
    const data = await apiJson(`/api/projects/${projectId}/package/results`);
    const list = el("package-result-files");
    list.innerHTML = "";
    for (const item of data.results || []) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = `${item.name}（${(item.size / 1024).toFixed(0)} KB）`;
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      const download = document.createElement("button");
      download.type = "button";
      download.className = "btn btn--ghost";
      download.textContent = "下载";
      download.addEventListener("click", () => downloadResultPackage(projectId, item.name));
      li.append(name, spacer, download);
      list.append(li);
    }
  } catch (error) {
    showError(el("package-result-files") || el("library-error"), error);
  }
}

async function exportResultPackage() {
  if (!currentProject) return;
  el("package-result-meta").textContent = "导出中…";
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/package/result`, {
      method: "POST",
    });
    const summary = data.summary;
    const lines = [
      `已完成 ${summary.page_count - summary.unfinished_pages.length} 页` +
        `，未完成 ${summary.unfinished_pages.length} 页`,
      `不确定 ${summary.uncertain} 块`,
      `备注 ${summary.commented} 条`,
      `改过的块 ${summary.modified}`,
    ];
    window.alert(
      `结果包已生成：${data.file_name}\n\n${lines.join("\n")}\n\n` +
        "用下面的「下载」把它发给负责人。"
    );
    await loadPackageResults(currentProject.project_id);
  } catch (error) {
    showError(el("package-result-meta"), error);
  }
}

async function downloadResultPackage(projectId, fileName) {
  const response = await fetch(
    `/api/projects/${projectId}/package/results/${encodeURIComponent(fileName)}?token=${encodeURIComponent(token)}`,
    { headers: { "X-B2T-Token": token } }
  );
  if (!response.ok) {
    setSaveState("下载失败", true);
    return;
  }
  saveBlob(await response.blob(), fileName);
}

// ---------------------------------------------------------------- 协作：导入结果与合并审阅

function pickResultFile(assignmentId, { allowCancelled = false } = {}) {
  packagePending = { assignmentId, allowCancelled };
  el("result-file-input").click();
}

async function onResultFileChosen() {
  const input = el("result-file-input");
  const file = input.files && input.files[0];
  input.value = "";
  if (!file || !packagePending) return;
  const { allowCancelled } = packagePending;
  el("assign-error").hidden = true;
  setSaveState("正在导入结果包…");
  try {
    const response = await fetch(
      `/api/projects/${project_id()}/results?filename=${encodeURIComponent(file.name)}` +
        (allowCancelled ? "&allow_cancelled=true" : ""),
      {
        method: "POST",
        headers: { "X-B2T-Token": token, "Content-Type": "application/zip" },
        body: file,
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload && payload.error) || {};
      throw new ApiError(error.message || `导入失败（HTTP ${response.status}）`, error.code, error.correlation_id, error.detail);
    }
    setSaveState(`已导入第 ${payload.seq} 次结果`);
    mergeState = payload;
    renderMergeView(payload);
    await loadAssignments();
  } catch (error) {
    showError(el("assign-error"), error);
  } finally {
    packagePending = null;
  }
}

async function openMergeView(assignmentId) {
  if (!currentProject) return;
  el("merge-error").hidden = true;
  closeModal("assign-panel");   // 合并是整屏的视图，别让任务包对话框压在上面
  try {
    const data = await apiJson(
      `/api/projects/${project_id()}/assignments/${assignmentId}/merge`
    );
    mergeState = data;
    renderMergeView(data);
  } catch (error) {
    showError(el("assign-error"), error);
  }
}

/** 字符级差异：把 before/after 渲染成"删除线 + 高亮"的片段（说明书 7.9.3）。 */
function charDiff(before, after) {
  const left = String(before || "");
  const right = String(after || "");
  // 先剥掉共同的前后段，中间用 LCS 逐字比（行内文本通常只有几十字，够快也够准）
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1;
    endRight -= 1;
  }
  const prefix = left.slice(0, start);
  const suffix = left.slice(endLeft);
  const leftMid = left.slice(start, endLeft);
  const rightMid = right.slice(start, endRight);

  const fragment = document.createDocumentFragment();
  if (prefix) fragment.append(document.createTextNode(prefix));
  for (const [kind, text] of diffMiddle(leftMid, rightMid)) {
    if (!text) continue;
    if (kind === "same") {
      fragment.append(document.createTextNode(text));
    } else if (kind === "del") {
      const node = document.createElement("del");
      node.textContent = text;
      fragment.append(node);
    } else {
      const node = document.createElement("ins");
      node.textContent = text;
      fragment.append(node);
    }
  }
  if (suffix) fragment.append(document.createTextNode(suffix));
  return fragment;
}

/** 中间段的逐字比较：返回 [["same"|"del"|"ins", 文本], …]。 */
function diffMiddle(left, right) {
  const rows = left.length;
  const cols = right.length;
  if (rows * cols > 40000) {
    // 太长的行不做逐字比（避免卡界面），整段显示为替换
    return [["del", left], ["ins", right]];
  }
  const table = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  const push = (kind, char) => {
    const last = out[out.length - 1];
    if (last && last[0] === kind) last[1] += char;
    else out.push([kind, char]);
  };
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      push("same", left[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("del", left[i]);
      i += 1;
    } else {
      push("ins", right[j]);
      j += 1;
    }
  }
  while (i < rows) push("del", left[i++]);
  while (j < cols) push("ins", right[j++]);
  return out;
}

const MERGE_KIND_CLASS = {
  conflict: "is-conflict",
  structural: "is-structural",
};

function mergeVisiblePages() {
  if (!mergeState) return [];
  const filter = el("merge-filter").value;
  const handled = mergeHandled;
  return mergeState.changed_pages.filter((page) => {
    if (handled.has(page.page_id) && filter !== "all") return filter === "pending" ? false : true;
    if (filter === "conflict") return page.kind === "conflict";
    if (filter === "structural") return page.kind === "structural";
    if (filter === "block_level") return page.kind === "block_level";
    if (filter === "comments") return page.comment_count > 0;
    if (filter === "pending") return !handled.has(page.page_id);
    return true;
  });
}

let mergeHandled = new Set();
let mergeDecisions = new Map();

function renderMergeView(state) {
  mergeHandled = new Set();
  mergeDecisions = new Map();
  const counts = state.counts;
  el("merge-title").textContent = `合并审校结果：${state.reviewer_name}`;
  el("merge-meta").textContent =
    `第 ${(state.page_nos || []).join("、")} 页 · 结果 ${state.seq}`;
  el("merge-error").hidden = true;
  // 概要数字放在顶栏的四个小格子里（效果图 06）
  el("merge-stat-changed").innerHTML = `变化 <b>${counts.changed_pages}</b> 页`;
  el("merge-stat-blocks").innerHTML = `块级修改 <b>${counts.block_level}</b>`;
  el("merge-stat-conflict").innerHTML = `冲突 <b>${counts.conflict}</b>`;
  el("merge-stat-comments").innerHTML = `💬 备注 <b>${counts.comments}</b>`;
  el("merge-stat-conflict").hidden = false;
  el("merge-image-status").textContent = "点左边的一页，这里显示原图与助手的改动区域";
  el("merge-canvas").hidden = true;
  el("merge-caption").textContent = "";
  showView("merge");

  const list = el("merge-pages");
  list.innerHTML = "";
  for (const page of mergeVisiblePages()) {
    const item = document.createElement("li");
    item.dataset.pageId = page.page_id;
    item.className = MERGE_KIND_CLASS[page.kind] || "";
    if (mergeHandled.has(page.page_id)) item.classList.add("is-done");

    const mark = document.createElement("span");
    mark.className = "ic";
    mark.textContent = page.kind === "conflict" ? "⚠" : page.kind === "structural" ? "◧" : "●";
    if (page.kind === "conflict") mark.style.color = "var(--bad-text)";
    else if (page.kind === "block_level") mark.style.color = "var(--accent-text)";

    const no = document.createElement("span");
    no.className = "pg";
    no.textContent = `p.${page.page_no}`;
    const desc = document.createElement("span");
    desc.className = "ds";
    desc.textContent =
      page.kind === "conflict"
        ? `冲突 ${page.changed_blocks}`
        : page.kind_label + (page.changed_blocks ? ` ${page.changed_blocks}` : "") +
          (page.comment_count ? ` 💬${page.comment_count}` : "");

    item.append(mark, no, desc);
    item.addEventListener("click", () => showMergePage(page));
    list.append(item);
  }
  if (!list.children.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "没有符合条件的页面。";
    list.append(empty);
  }
  el("merge-accept-all").disabled = !state.changed_pages.some(
    (page) => !mergeHandled.has(page.page_id) && page.kind !== "conflict"
  );
  const first = mergeVisiblePages()[0];
  if (first) showMergePage(first);
}

function showMergePage(page) {
  const detail = el("merge-detail");
  mergeActivePageId = page.page_id;
  detail.innerHTML = "";
  for (const item of el("merge-pages").children) {
    item.classList.toggle("is-active", item.dataset.pageId === page.page_id);
  }

  const title = document.createElement("div");
  title.className = "merge-detail__head";
  title.innerHTML = "";
  const strong = document.createElement("b");
  strong.textContent = `第 ${page.page_no} 页`;
  title.append(strong, ` · ${page.kind_label}` + " · 逐条接受或拒绝");
  detail.append(title);

  const cards = document.createElement("div");
  cards.className = "merge-detail__cards";
  detail.append(cards);

  if (page.kind === "conflict") {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.style.padding = "12px 18px 0";
    hint.textContent =
      "这一页在你分派之后也改过——冲突项要单独决定（保留我的 / 采用助手的），或者先拒绝、之后手工改。";
    cards.append(hint);
  }
  if (page.kind === "structural") {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.style.padding = "12px 18px 0";
    hint.textContent = "这一页有块的增删 / 合并 / 拆分 / 重排，只能整页接受或拒绝。";
    cards.append(hint);
  }

  for (const change of page.block_changes) {
    cards.append(mergeBlockItem(page, change));
  }
  if (page.added_blocks.length) {
    const item = document.createElement("div");
    item.className = "merge-item";
    const head = document.createElement("div");
    head.className = "merge-item__head";
    head.textContent = `助手新增了 ${page.added_blocks.length} 块（接受这一页时会一起写入）`;
    item.append(head);
    for (const block of page.added_blocks) {
      const body = document.createElement("div");
      body.className = "merge-diff";
      const node = document.createElement("ins");
      node.textContent = block.text || "（空）";
      body.append(node);
      item.append(body);
    }
    cards.append(item);
  }
  if (page.removed_blocks.length) {
    const item = document.createElement("div");
    item.className = "merge-item";
    const head = document.createElement("div");
    head.className = "merge-item__head";
    head.textContent = `助手删除了 ${page.removed_blocks.length} 块（接受这一页时会一起删除，可撤销）`;
    item.append(head);
    cards.append(item);
  }

  // 底部操作条（效果图 06：右上角"接受所有无冲突的变化"，这里是逐页的接受 / 拒绝）
  const actions = document.createElement("div");
  actions.className = "merge-detail__foot";
  if (mergeHandled.has(page.page_id)) {
    const state = mergeDecisions.get(page.page_id);
    const done = document.createElement("span");
    done.className = "chip chip--ok";
    done.textContent =
      state && state.action === "reject" ? "已决定：拒绝本页" : "已决定：接受本页";
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "btn btn--sm btn--ghost";
    undo.textContent = "改回来";
    undo.addEventListener("click", () => {
      mergeDecisions.delete(page.page_id);
      mergeHandled.delete(page.page_id);
      showMergePage(page);
      renderMergeListView();
    });
    actions.append(done, undo);
  } else {
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "btn";
    reject.textContent = page.kind === "conflict" ? "保留我的" : "拒绝本页";
    reject.addEventListener("click", () =>
      decideMergePage(page, page.kind === "conflict" ? "keep_mine" : "reject")
    );
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "接受后的写入可整体撤销";
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "btn btn--pri";
    accept.textContent = "接受本页";
    accept.title = page.kind === "block_level" ? "接受这一页里助手的全部改动" : "结构变化 / 冲突按整页接受";
    accept.addEventListener("click", () => decideMergePage(page, "accept"));
    actions.append(reject, hint, accept);
  }
  detail.append(actions);
  renderMergeFooter();

  loadMergePageImage(page);
}

/** 中间那列：原图 + 助手改过的块高亮（效果图 06 的"修改对应区域高亮"）。 */
async function loadMergePageImage(page) {
  if (!currentProject) return;
  const status = el("merge-image-status");
  const canvas = el("merge-canvas");
  const image = el("merge-image");
  const caption = el("merge-caption");

  const changed = new Set((page.block_changes || []).map((change) => change.block_id));
  const added = new Set((page.added_blocks || []).map((block) => block.block_id));
  const removed = (page.removed_blocks || []).map((block) => block.block_id);

  let blocks = [];
  try {
    const data = await apiJson(
      `/api/projects/${project_id()}/pages/${page.page_no}/blocks`
    );
    blocks = data.blocks || [];
  } catch (error) {
    status.textContent = "这一页的块读不出来，下面照样能逐条决定。";
    status.hidden = false;
    return;
  }

  const wanted = `/api/projects/${project_id()}/pages/${page.page_no}/image?size=view` +
    `&token=${encodeURIComponent(token)}`;
  if (image.dataset.pageNo !== String(page.page_no)) {
    image.dataset.pageNo = String(page.page_no);
    canvas.hidden = true;
    status.textContent = "正在渲染…";
    status.hidden = false;
    image.onload = () => {
      status.hidden = true;
      canvas.hidden = false;
      drawMergeOverlay(blocks, changed, added, removed);
    };
    image.onerror = () => {
      status.textContent = "这一页渲染失败。";
    };
    image.src = wanted;
  } else {
    status.hidden = true;
    canvas.hidden = false;
    drawMergeOverlay(blocks, changed, added, removed);
  }

  const parts = [];
  if (changed.size) parts.push(`改动 ${changed.size} 块`);
  if (added.size) parts.push(`新增 ${added.size} 块`);
  if (removed.length) parts.push(`删除 ${removed.length} 块`);
  caption.textContent = parts.length
    ? `第 ${page.page_no} 页 · ${parts.join(" · ")}（蓝框＝改动，绿框＝新增）`
    : `第 ${page.page_no} 页 · 没有可高亮的位置信息`;
}

function drawMergeOverlay(blocks, changed, added, removed) {
  const overlay = el("merge-overlay");
  overlay.innerHTML = "";
  let drawn = 0;
  for (const block of blocks) {
    if (!block.bbox) continue;
    const isAdded = added.has(block.block_id);
    const isRemoved = removed.includes(block.block_id);
    const isChanged = changed.has(block.block_id);
    if (!isAdded && !isChanged) continue;   // 只画助手动过的地方，其余不干扰阅读
    drawn += 1;
    const [x0, y0, x1, y1] = block.bbox;
    const box = document.createElement("div");
    box.className = "box " + (isAdded ? "box--added" : "box--changed");
    if (isRemoved) box.className = "box box--removed";
    box.style.left = `${x0 * 100}%`;
    box.style.top = `${y0 * 100}%`;
    box.style.width = `${(x1 - x0) * 100}%`;
    box.style.height = `${(y1 - y0) * 100}%`;
    box.title = isAdded ? "助手新增的块" : "助手改过的块";
    overlay.append(box);
  }
  if (!drawn) {
    const note = document.createElement("div");
    note.className = "merge-caption";
    note.style.position = "absolute";
    note.style.bottom = "8px";
    note.style.left = "8px";
    note.textContent = "这些改动的块没有位置信息，无法在图上圈出来";
    overlay.append(note);
  }
}

function mergeBlockItem(page, change) {
  const item = document.createElement("div");
  item.className = "merge-item";
  const head = document.createElement("div");
  head.className = "merge-item__head";
  const label = document.createElement("span");
  label.textContent = change.conflict ? "⚠ 冲突" : "块级修改";
  label.className = "status " + (change.conflict ? "status--bad" : "status--warn");
  const fields = document.createElement("span");
  fields.className = "muted";
  fields.textContent = Object.values(change.field_labels).join(" / ");
  head.append(label, fields);
  item.append(head);

  const textChange = change.fields.text;
  if (textChange) {
    if (change.conflict) {
      const three = document.createElement("div");
      three.className = "merge-three";
      const cell = (caption, value) => {
        const box = document.createElement("div");
        const small = document.createElement("span");
        small.className = "label";
        small.textContent = caption;
        const body = document.createElement("div");
        body.textContent = value || "（空）";
        box.append(small, body);
        return box;
      };
      three.append(
        cell("分派时的原文", textChange.snapshot),
        cell("你现在的内容", textChange.mine),
        cell("助手的版本", textChange.theirs)
      );
      item.append(three);
    } else {
      const diff = document.createElement("div");
      diff.className = "merge-diff";
      diff.append(charDiff(textChange.snapshot, textChange.theirs));
      item.append(diff);
    }
  }

  for (const [field, values] of Object.entries(change.fields)) {
    if (field === "text") continue;
    const line = document.createElement("div");
    line.className = "merge-diff";
    line.textContent =
      `${change.field_labels[field] || field}：` +
      `${values.snapshot || "（空）"} → ${values.theirs || "（空）"}`;
    item.append(line);
  }
  if (change.fields.comment) {
    const note = document.createElement("p");
    note.className = "merge-note";
    note.textContent = `💬 ${page ? "" : ""}${change.fields.comment.theirs}`;
    item.append(note);
  }
  return item;
}

function decideMergePage(page, action) {
  mergeDecisions.set(page.page_id, { page_id: page.page_id, action });
  mergeHandled.add(page.page_id);
  // 决定完不跳走：留在这一页上再核对一遍，底部变成"已决定 + 改回来"
  showMergePage(page);
  renderMergeListView();
}

/** 页列表里当前展开的那一页（重建列表时用它把高亮找回来）。 */
let mergeActivePageId = null;

/** 一行页面的门牌：标记 + 页码 + 变化摘要（列表与重建共用）。 */
function mergePageRow(page) {
  const item = document.createElement("li");
  item.dataset.pageId = page.page_id;
  item.className = MERGE_KIND_CLASS[page.kind] || "";
  const decision = mergeDecisions.get(page.page_id);
  if (decision) item.classList.add("is-done");
  if (page.page_id === mergeActivePageId) item.classList.add("is-active");

  const mark = document.createElement("span");
  mark.className = "ic";
  mark.textContent = page.kind === "conflict" ? "⚠" : page.kind === "structural" ? "◧" : "●";
  if (page.kind === "conflict") mark.style.color = "var(--bad-text)";
  else if (page.kind === "block_level") mark.style.color = "var(--accent-text)";
  if (decision) mark.textContent = "✓";

  const no = document.createElement("span");
  no.className = "pg";
  no.textContent = `p.${page.page_no}`;

  const desc = document.createElement("span");
  desc.className = "ds";
  desc.textContent = decision
    ? decision.action === "accept"
      ? "已接受"
      : "已拒绝"
    : page.kind_label + (page.changed_blocks ? ` ${page.changed_blocks}` : "") +
      (page.comment_count ? ` 💬${page.comment_count}` : "");

  item.append(mark, no, desc);
  item.addEventListener("click", () => showMergePage(page));
  return item;
}

function renderMergeListView() {
  if (!mergeState) return;
  const list = el("merge-pages");
  list.innerHTML = "";
  for (const page of mergeVisiblePages()) list.append(mergePageRow(page));
  if (!list.children.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "没有符合条件的页面。";
    list.append(empty);
  }
  const pending = mergeState.changed_pages.filter(
    (page) => !mergeHandled.has(page.page_id) && page.kind !== "conflict"
  );
  el("merge-accept-all").disabled = !pending.length;
  el("merge-meta").textContent =
    `第 ${(mergeState.page_nos || []).join("、")} 页 · 结果 ${mergeState.seq}` +
    (mergeDecisions.size ? ` · 已决定 ${mergeDecisions.size} 页` : "");
  renderMergeFooter();
}

/** 合并视图底部的"提交"按钮：把决定一起写进主项目（一次一个 batch）。 */
function renderMergeFooter() {
  let footer = el("merge-footer");
  if (!footer) {
    footer = document.createElement("div");
    footer.id = "merge-footer";
    footer.className = "collab-actions";
    el("merge-panel").append(footer);
  }
  footer.innerHTML = "";
  if (!mergeDecisions.size) return;
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "btn btn--primary";
  submit.textContent = `提交 ${mergeDecisions.size} 页的决定（可撤销）`;
  submit.addEventListener("click", submitMergeDecisions);
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn btn--ghost";
  reset.textContent = "清空决定";
  reset.addEventListener("click", () => {
    mergeDecisions = new Map();
    mergeHandled = new Set();
    renderMergeListView();
  });
  footer.append(submit, reset);
}

async function submitMergeDecisions() {
  if (!currentProject || !mergeState || !mergeDecisions.size) return;
  const assignmentId = mergeState.assignment.assignment_id;
  el("merge-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${project_id()}/assignments/${assignmentId}/merge`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [...mergeDecisions.values()],
          reviewer_name: mergeState.reviewer_name,
        }),
      }
    );
    setSaveState(
      `已合并 ${data.accepted_pages} 页` +
        (data.rejected_pages ? `，保留现有 ${data.rejected_pages} 页` : "") +
        "（⌘/Ctrl + Z 可撤销）"
    );
    mergeDecisions = new Map();
    mergeHandled = new Set();
    mergeActivePageId = null;
    mergeState = null;
    await loadAssignments();
    await refreshProject(project_id());
    showView("pages");
  } catch (error) {
    showError(el("merge-error"), error);
  }
}

function setupCollabControls() {
  el("assign-open").addEventListener("click", openAssignPanel);
  el("assign-list-toggle").addEventListener("click", async () => {
    const panel = el("assign-panel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await loadAssignments();
  });
  el("assign-close").addEventListener("click", () => closeModal("assign-panel"));
  el("assign-reviewer").addEventListener("input", previewAssign);
  el("assign-context").addEventListener("change", previewAssign);
  el("assign-create").addEventListener("click", createAssignment);
  el("assign-download").addEventListener("click", (event) =>
    downloadPackage(event.target.dataset.assignmentId)
  );
  el("assign-reveal").addEventListener("click", (event) =>
    revealPackage(event.target.dataset.assignmentId)
  );
  el("merge-close").addEventListener("click", () => showView("pages"));
  el("merge-filter").addEventListener("change", renderMergeListView);
  el("merge-accept-all").addEventListener("click", acceptAllClean);
  setupPackageControls();
}

async function acceptAllClean() {
  if (!mergeState) return;
  const pending = mergeState.changed_pages.filter(
    (page) => !mergeHandled.has(page.page_id) && page.kind !== "conflict"
  );
  if (!pending.length) return;
  if (
    !window.confirm(
      `接受 ${pending.length} 页里没有冲突的变化？\n（块级修改与结构变化都会被写入，冲突项留给你单独处理；整批可撤销）`
    )
  ) {
    return;
  }
  for (const page of pending) {
    mergeDecisions.set(page.page_id, { page_id: page.page_id, action: "accept" });
    mergeHandled.add(page.page_id);
  }
  renderMergeListView();
}

// ---------------------------------------------------------------- 启动

function boot() {
  // Esc 清空选择（说明书 6.2 的选择方式之外的顺手约定）；对话框的 Esc 在 setupShell 里
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !openMasks().length && currentProject && selectedPages.size) {
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
  setupShell();
  setupLibrary();
  setupReviewPager();
  setupViewerTools();
  setupExportPanel();
  setupStructurePanel();
  showView("library");
  loadAppInfo();
  loadLibrary();
}

boot();
