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

let currentUpload = null; // { upload_id, page_count, ... }
let currentPage = 0;
let currentImageUrl = null;
let lastFile = null;
let activeBlockIndex = -1;
let lastOcrData = null;

/** 每页的识别结果缓存。重新识别很慢，翻页来回看时不该重跑。 */
const ocrCache = new Map();
const ocrKey = (uploadId, pageIndex) => `${uploadId}:${pageIndex}`;

/** 块级标记：纳入导出 / 延续到下一页（说明书 5.3 的 include 与 continues_to_next）。 */
const blockFlags = new Map();
const flagKey = (pageIndex, blockIndex) => `${pageIndex}:${blockIndex}`;

function flagsOf(pageIndex, blockIndex) {
  return blockFlags.get(flagKey(pageIndex, blockIndex)) || {
    include: true,
    continues: false,
  };
}

function setFlag(pageIndex, blockIndex, patch) {
  blockFlags.set(flagKey(pageIndex, blockIndex), {
    ...flagsOf(pageIndex, blockIndex),
    ...patch,
  });
}

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
    showError(el("upload-error"), error);
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
    ["临时数据目录", info.data_dir],
  ]);
}

// ---------------------------------------------------------------- 上传

function setupDropzone() {
  const zone = el("dropzone");
  const input = el("file-input");

  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });

  input.addEventListener("change", () => {
    if (input.files && input.files[0]) startUpload(input.files[0]);
    input.value = "";
  });

  for (const type of ["dragenter", "dragover"]) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add("dropzone--over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove("dropzone--over");
    });
  }
  zone.addEventListener("drop", (event) => {
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (file) startUpload(file);
  });
}

function setProgress(loaded, total) {
  const wrap = el("progress-wrap");
  const fill = el("progress-fill");
  wrap.hidden = false;
  if (total > 0) {
    fill.style.width = `${Math.round((loaded / total) * 100)}%`;
    el("progress-text").textContent = `已上传 ${humanBytes(loaded)} / ${humanBytes(total)}`;
  } else {
    el("progress-text").textContent = `已上传 ${humanBytes(loaded)}`;
  }
}

function uploadWithProgress(file) {
  // 用 XMLHttpRequest 而不是 fetch：只有它能拿到上传进度（说明书 4.5 要求显示进度）。
  return new Promise((resolve, reject) => {
    const url = `/api/scratch/upload?filename=${encodeURIComponent(file.name)}`;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader(TOKEN_HEADER, token);
    xhr.setRequestHeader("Content-Type", "application/pdf");

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) setProgress(event.loaded, event.total);
    });

    xhr.addEventListener("load", () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload) {
        resolve(payload);
        return;
      }
      const error = (payload && payload.error) || {};
      reject(new ApiError(
        error.message || `上传失败（HTTP ${xhr.status}）`,
        error.code, error.correlation_id, error.detail
      ));
    });

    xhr.addEventListener("error", () => reject(new ApiError("网络错误：无法连接到本地服务")));
    xhr.addEventListener("abort", () => reject(new ApiError("上传已取消")));

    xhr.send(file);
  });
}

async function startUpload(file) {
  lastFile = file;
  el("upload-error").hidden = true;
  el("result-card").hidden = true;
  // 换文件就清掉上一次的识别缓存与块标记，避免串到新上传上
  ocrCache.clear();
  blockFlags.clear();
  lastOcrData = null;
  el("export-panel").hidden = true;
  setProgress(0, file.size);

  try {
    currentUpload = await uploadWithProgress(file);
  } catch (error) {
    el("progress-wrap").hidden = true;
    showError(el("upload-error"), error);
    return;
  }

  setProgress(file.size, file.size);
  el("progress-text").textContent = `上传完成，共 ${humanBytes(file.size)}`;

  currentPage = 0;
  renderUploadMeta();
  el("result-card").hidden = false;
  await showPage(0);
}

function renderUploadMeta() {
  const data = currentUpload;
  fillDefinitionList(el("upload-meta"), [
    ["文件名", data.original_name],
    ["大小", humanBytes(data.size_bytes)],
    ["页数", String(data.page_count)],
    ["首页尺寸", `${data.page_width_pt.toFixed(1)} × ${data.page_height_pt.toFixed(1)} pt`],
    ["SHA-256", data.sha256],
    ["上传编号", data.upload_id],
  ]);
}

// ---------------------------------------------------------------- 页面图像

async function showPage(index) {
  if (!currentUpload) return;
  const total = currentUpload.page_count;
  if (index < 0 || index >= total) return;

  currentPage = index;
  el("page-indicator").textContent = `第 ${index + 1} / ${total} 页`;
  el("prev-page").disabled = index === 0;
  el("next-page").disabled = index >= total - 1;

  const canvas = el("page-canvas");
  const image = el("page-image");
  const status = el("image-status");
  status.hidden = false;
  status.textContent = `正在渲染第 ${index + 1} 页…`;
  canvas.hidden = true;

  try {
    const response = await apiFetch(
      `/api/scratch/${currentUpload.upload_id}/page/${index}/image?size=view`
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const error = (payload && payload.error) || {};
      throw new ApiError(error.message || `渲染失败（HTTP ${response.status}）`,
                         error.code, error.correlation_id, error.detail);
    }
    const blob = await response.blob();

    if (currentImageUrl) URL.revokeObjectURL(currentImageUrl);
    currentImageUrl = URL.createObjectURL(blob);
    image.src = currentImageUrl;

    // 图像必须加载完成才能算准覆盖层的尺寸
    await new Promise((resolve) => {
      if (image.complete && image.naturalWidth > 0) resolve();
      else image.onload = () => resolve();
    });

    canvas.hidden = false;
    status.hidden = true;
  } catch (error) {
    status.textContent = "";
    showError(status, error);
    status.hidden = false;
    return;
  }

  const cached = ocrCache.get(ocrKey(currentUpload.upload_id, index));
  if (cached) renderOcr(cached);
  else clearOcr();
}

function clearOcr() {
  activeBlockIndex = -1;
  lastOcrData = null;
  el("ocr-panel").hidden = true;
  el("ocr-layout-warning").hidden = true;
  el("ocr-blocks").innerHTML = "";
  el("page-overlay").innerHTML = "";
}

// ---------------------------------------------------------------- 识别

async function recognizeCurrentPage() {
  if (!currentUpload) return;
  const button = el("recognize-btn");
  const status = el("image-status");

  button.disabled = true;
  button.textContent = "识别中…";
  el("upload-error").hidden = true;

  try {
    const data = await apiJson(
      `/api/scratch/${currentUpload.upload_id}/page/${currentPage}/recognize`,
      { method: "POST" }
    );
    ocrCache.set(ocrKey(currentUpload.upload_id, currentPage), data);
    renderOcr(data);
  } catch (error) {
    showError(el("upload-error"), error);
    if (status) status.hidden = true;
  } finally {
    button.disabled = false;
    button.textContent = "识别本页";
  }
}

function renderOcr(data) {
  const panel = el("ocr-panel");
  const list = el("ocr-blocks");

  lastOcrData = data;
  el("ocr-meta").textContent =
    `${data.engine_id} ${data.engine_version} · ${data.block_count} 块 / ${data.line_count} 行 · ` +
    `${data.elapsed_seconds} 秒 · 识别用图 ${data.image_width}×${data.image_height}`;

  const warning = el("ocr-layout-warning");
  if (data.reading_order_uncertain) {
    warning.textContent =
      (data.layout_notes || []).join("；") || "检测到疑似多栏，阅读顺序需要人工确认。";
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  list.innerHTML = "";
  data.blocks.forEach((block, index) => {
    const item = document.createElement("li");
    item.className = "ocr-block";
    item.dataset.index = String(index);

    const head = document.createElement("div");
    head.className = "ocr-block__head";

    const order = document.createElement("span");
    order.textContent = `#${block.order_index + 1}`;

    const meta = document.createElement("span");
    const columnNote = data.column_count > 1 ? ` · 第 ${block.column + 1} 栏` : "";
    const hyphenNote = (block.hyphenations || []).length
      ? ` · 断词还原 ${block.hyphenations.length} 处`
      : "";
    meta.textContent = `${block.block_type} · ${block.line_count} 行${columnNote}${hyphenNote}`;

    head.append(order, meta);

    // 块级标记（说明书 5.3 的 include / continues_to_next；6.4 的"排除"与"标记延续"）
    const flags = document.createElement("div");
    flags.className = "ocr-block__flags";

    const includeLabel = document.createElement("label");
    includeLabel.title = "取消勾选则该块不进入导出";
    const includeBox = document.createElement("input");
    includeBox.type = "checkbox";
    includeBox.checked = flagsOf(currentPage, index).include;
    includeLabel.append(includeBox, document.createTextNode("纳入"));

    const continuesLabel = document.createElement("label");
    continuesLabel.title = "标记本段延续到下一页，导出时会与下一块拼成同一段";
    const continuesBox = document.createElement("input");
    continuesBox.type = "checkbox";
    continuesBox.checked = flagsOf(currentPage, index).continues;
    continuesLabel.append(continuesBox, document.createTextNode("延续下页"));

    for (const box of [includeBox, continuesBox]) {
      box.addEventListener("click", (event) => event.stopPropagation());
    }
    includeBox.addEventListener("change", () => {
      setFlag(currentPage, index, { include: includeBox.checked });
      item.classList.toggle("ocr-block--excluded", !includeBox.checked);
      invalidateExport();
    });
    continuesBox.addEventListener("change", () => {
      setFlag(currentPage, index, { continues: continuesBox.checked });
      item.classList.toggle("ocr-block--continues", continuesBox.checked);
      invalidateExport();
    });

    flags.append(includeLabel, continuesLabel);
    head.append(flags);
    item.classList.toggle("ocr-block--excluded", !includeBox.checked);

    const text = document.createElement("div");
    text.className = "ocr-block__text";
    text.textContent = block.text;

    item.append(head, text);
    item.addEventListener("click", () => selectBlock(index));
    list.append(item);
  });

  activeBlockIndex = -1;
  panel.hidden = false;
  el("export-panel").hidden = false;
  invalidateExport();
  applyTextMode();
  drawOverlay(data);
}

/** 在"保留行内换行"与"拼成段落"（说明书 9.2）之间切换块的显示文本。 */
function applyTextMode() {
  if (!lastOcrData) return;
  const mode =
    (document.querySelector('input[name="ocr-text-mode"]:checked') || {}).value ||
    "lines";
  const cards = el("ocr-blocks").children;
  lastOcrData.blocks.forEach((block, index) => {
    const card = cards[index];
    if (!card) return;
    const target = card.querySelector(".ocr-block__text");
    if (target) target.textContent = mode === "joined" ? block.text_joined : block.text;
  });
}

function drawOverlay(data) {
  const overlay = el("page-overlay");
  overlay.innerHTML = "";
  if (!el("ocr-show-boxes").checked) return;

  // 归一化坐标 → 百分比定位，因此与显示尺寸、渲染 DPI 都无关
  (data.blocks || []).forEach((block, index) => {
    if (!block.bbox) return;
    const [x0, y0, x1, y1] = block.bbox;
    const box = document.createElement("div");
    box.className = "box";
    box.dataset.index = String(index);
    box.style.left = `${x0 * 100}%`;
    box.style.top = `${y0 * 100}%`;
    box.style.width = `${(x1 - x0) * 100}%`;
    box.style.height = `${(y1 - y0) * 100}%`;
    overlay.append(box);
  });
}

function selectBlock(index) {
  activeBlockIndex = index;

  for (const item of el("ocr-blocks").children) {
    item.classList.toggle("active", Number(item.dataset.index) === index);
  }
  for (const box of el("page-overlay").children) {
    const isActive = Number(box.dataset.index) === index;
    box.classList.toggle("box--active", isActive);
    if (isActive) box.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const item = el("ocr-blocks").querySelector(`li[data-index="${index}"]`);
  if (item) item.scrollIntoView({ block: "nearest" });
}

function setupViewerControls() {
  el("prev-page").addEventListener("click", () => showPage(currentPage - 1));
  el("next-page").addEventListener("click", () => showPage(currentPage + 1));
  el("recognize-btn").addEventListener("click", () => recognizeCurrentPage());
  el("ocr-show-boxes").addEventListener("change", () => {
    if (lastOcrData) drawOverlay(lastOcrData);
  });
  for (const radio of document.querySelectorAll('input[name="ocr-text-mode"]')) {
    radio.addEventListener("change", applyTextMode);
  }
  el("export-btn").addEventListener("click", runExport);
  el("export-download").addEventListener("click", downloadExportData);
  el("export-download-manifest").addEventListener("click", downloadExportManifest);
  el("export-page-markers").addEventListener("change", invalidateExport);
  for (const radio of document.querySelectorAll('input[name="export-format"]')) {
    radio.addEventListener("change", invalidateExport);
  }

  el("reveal-btn").addEventListener("click", async () => {
    if (!currentUpload) return;
    try {
      await apiJson(`/api/scratch/${currentUpload.upload_id}/reveal`, { method: "POST" });
    } catch (error) {
      showError(el("upload-error"), error);
    }
  });

  el("delete-btn").addEventListener("click", async () => {
    if (!currentUpload) return;
    const name = currentUpload.original_name;
    if (!confirm(`删除这次上传（${name}）？原始文件不在本机其他位置的话将无法恢复。`)) return;
    try {
      await apiJson(`/api/scratch/${currentUpload.upload_id}`, { method: "DELETE" });
    } catch (error) {
      showError(el("upload-error"), error);
      return;
    }
    // 该上传的识别缓存一并清掉，避免翻回旧编号时读到过期结果
    for (const key of [...ocrCache.keys()]) {
      if (key.startsWith(`${currentUpload.upload_id}:`)) ocrCache.delete(key);
    }
    if (currentImageUrl) {
      URL.revokeObjectURL(currentImageUrl);
      currentImageUrl = null;
    }
    currentUpload = null;
    clearOcr();
    el("result-card").hidden = true;
    el("progress-wrap").hidden = true;
  });
}

// ---------------------------------------------------------------- 导出

/** 上一次生成的产物：数据文件与 manifest.json 的内容。 */
let exportArtifacts = null;

/** 任何会影响输出的改动（块标记、格式、页码标记选项）都要让上一次的结果失效。 */
function invalidateExport() {
  exportArtifacts = null;
  el("export-downloads").hidden = true;
  el("export-preview").hidden = true;
  el("export-preflight").innerHTML = "";
  el("export-error").hidden = true;
  updateExportScope();
}

function currentExportFormat() {
  const checked = document.querySelector('input[name="export-format"]:checked');
  return checked ? checked.value : "txt";
}

function recognizedPages() {
  if (!currentUpload) return [];
  const pages = [];
  for (const key of ocrCache.keys()) {
    const [uploadId, pageIndex] = key.split(":");
    if (uploadId === currentUpload.upload_id) pages.push(Number(pageIndex) + 1);
  }
  return pages.sort((a, b) => a - b);
}

function updateExportScope() {
  const pages = recognizedPages();
  el("export-scope").textContent = pages.length
    ? `本次会话已识别 ${pages.length} 页（第 ${pages.join("、")} 页）`
    : "还没有识别任何页面";
}

/** 把已识别页面的块整理成导出请求体。 */
function collectExportBlocks() {
  const blocks = [];
  for (const [key, data] of ocrCache) {
    const [uploadId, pageIndexRaw] = key.split(":");
    if (uploadId !== currentUpload.upload_id) continue;
    const pageIndex = Number(pageIndexRaw);
    data.blocks.forEach((block, blockIndex) => {
      const flags = flagsOf(pageIndex, blockIndex);
      blocks.push({
        block_id: `p${pageIndex + 1}-b${block.order_index}`,
        page_no: pageIndex + 1,
        order_index: block.order_index,
        block_type: block.block_type,
        lines: block.lines.map((line) => line.text),
        include: flags.include,
        continues_to_next: flags.continues,
        review_status: "unreviewed",
      });
    });
  }
  return blocks.sort(
    (a, b) => a.page_no - b.page_no || a.order_index - b.order_index
  );
}

/** 从已识别的页面里取引擎信息与页标签，写进 manifest 与 JSONL 的 source。 */
function exportSourceInfo() {
  const info = { project_name: null, file_name: null, sha256: null };
  if (currentUpload) {
    info.file_name = currentUpload.original_name;
    info.sha256 = currentUpload.sha256;
  }
  for (const [key, data] of ocrCache) {
    if (currentUpload && key.startsWith(`${currentUpload.upload_id}:`)) {
      info.engine_id = data.engine_id;
      info.engine_version = data.engine_version;
      break;
    }
  }
  return info;
}

async function runExport() {
  if (!currentUpload) return;
  const blocks = collectExportBlocks();
  if (!blocks.length) {
    showError(el("export-error"), new ApiError("还没有识别任何页面，无法导出"));
    return;
  }

  const format = currentExportFormat();
  const button = el("export-btn");
  button.disabled = true;
  button.textContent = "生成中…";
  el("export-error").hidden = true;

  let data;
  try {
    data = await apiJson(`/api/export/${format}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks,
        options: { page_markers: el("export-page-markers").checked },
        source: exportSourceInfo(),
        preview_chars: 20000,
      }),
    });
  } catch (error) {
    showError(el("export-error"), error);
    exportArtifacts = null;
    el("export-downloads").hidden = true;
    return;
  } finally {
    button.disabled = false;
    button.textContent = "生成";
  }

  const content = format === "jsonl" ? data.jsonl : data.text;
  exportArtifacts = {
    dataName: data.filename,
    dataContent: content,
    manifestName: "manifest.json",
    manifestContent: JSON.stringify(data.manifest, null, 2) + "\n",
  };
  renderExport(data, blocks.length, format);
}

function renderExport(data, inputBlocks, format) {
  const pf = data.preflight;

  fillDefinitionList(el("export-preflight"), [
    ["格式", format === "jsonl" ? "JSONL（每行一个段）" : "TXT"],
    ["输入块", `${inputBlocks} 个`],
    ["段数", `${pf.segment_count} 段`],
    ["字数", `${pf.char_count} 字`],
    ["页面", `${pf.page_count} 页（第 ${pf.pages.join("、")} 页）`],
    ["跨块合并", `${pf.merged_segments} 段`],
    ["断词还原", `${pf.hyphenations_restored} 处`],
  ]);

  el("export-download").textContent = `下载 ${data.filename}`;
  el("export-downloads").hidden = false;
  el("export-preview").textContent = data.preview;
  el("export-preview").hidden = false;
}

function downloadBlob(name, content, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadExportData() {
  if (!exportArtifacts) return;
  const isJsonl = exportArtifacts.dataName.endsWith(".jsonl");
  downloadBlob(
    exportArtifacts.dataName,
    exportArtifacts.dataContent,
    isJsonl ? "application/x-ndjson" : "text/plain"
  );
}

function downloadExportManifest() {
  if (!exportArtifacts) return;
  downloadBlob(exportArtifacts.manifestName, exportArtifacts.manifestContent, "application/json");
}

// ---------------------------------------------------------------- 启动

function boot() {
  if (!token) {
    const warning = el("platform-warning");
    warning.innerHTML = "缺少会话令牌。请使用启动时终端里打印的" +
      "<strong>完整界面地址</strong>（带 <code>?token=…</code>）打开本页。";
    warning.hidden = false;
  }
  setupDropzone();
  setupViewerControls();
  loadAppInfo();
}

boot();
