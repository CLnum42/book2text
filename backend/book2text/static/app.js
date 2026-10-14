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
  renderProject();
  // 任务可能还在跑（比如刷新了页面），把抽屉里的进度接回来
  await loadTasks();
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
  const onlyIncluded = el("pages-only-included").checked;

  return project.pages.filter((page) => {
    if (onlyIncluded && !page.include) return false;
    if (typeFilter && page.page_type !== typeFilter) return false;
    if (recognitionFilter && recognitionOf(page).status !== recognitionFilter) return false;
    return true;
  });
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
  running: "识别中",
  paused: "已暂停",
  succeeded: "已完成",
  failed: "有失败页",
  cancelled: "已取消",
  interrupted: "已中断",
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
      body: JSON.stringify({ pages: [page.page_no] }),
    });
    applyRecognizedPages(data.pages);
    openTaskDrawer();
    startTaskPolling(data.job.job_id);
  } catch (error) {
    showError(el("pages-error"), error);
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
  openTaskDrawer();

  const current = data.current_page_no ? ` · 当前第 ${data.current_page_no} 页` : "";
  const interrupted = data.alive === false && ["queued", "running", "paused"].includes(job.status);
  const aliveNote = interrupted ? "（识别进程已不在——点取消或继续收拾它）" : "";
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
      `${when} · ${JOB_STATUS_LABELS[job.status] || job.status} · ` +
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
  const parts = [
    PAGE_TYPE_LABELS[data.page.page_type] || data.page.page_type,
    `${review.block_count || 0} 块`,
    `未审 ${review.unreviewed || 0}`,
  ];
  if (review.uncertain) parts.push(`不确定 ${review.uncertain}`);
  if (review.modified) parts.push(`已修改 ${review.modified}`);
  if (data.active_run) parts.push(`${data.active_run.engine_id} ${data.active_run.engine_version}`);
  return parts.join(" · ");
}

function renderReviewBanner(data, recognition) {
  const banner = el("review-banner");
  const messages = [];
  const review = data.review || {};
  if (recognition.status === "has_candidate") {
    messages.push(
      "这一页有更新的识别结果，但它已有人工成果，系统没有覆盖——采用 / 保留的对比还没做（下一步）。"
    );
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

  item.append(head, textarea, actions, original);
  return item;
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
  reviewSaveTimer = setTimeout(() => {
    reviewSaveTimer = null;
    patchBlock(block, { text });
  }, 700);
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
  el("detail-close").addEventListener("click", closePageDetail);
  setupReviewControls();
  el("recognize-pending").addEventListener("click", () => startBatchRecognition("unrecognized"));
  setupTaskDrawer();

  // 筛选与选择（说明书 6.2）
  el("filter-type").addEventListener("change", renderPages);
  el("filter-recognition").addEventListener("change", renderPages);
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
  setupDropzone();
  setupViewerControls();
  loadAppInfo();
  loadLibrary();
}

boot();
