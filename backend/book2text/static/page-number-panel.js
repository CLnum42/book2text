/**
 * 页码面板（项目级页码识别 / 模板 / 范围 / 手动映射）—— `window.PageNumberPanel`
 *
 * **两个根**：`#page-number-panel`（9 个子 id + 内嵌 `#page-number-result` 的 3 个）与
 * `#page-number-review-panel`（9 个）——两者都是 body 直下的顶层 mask，都是本模块真正拥有的 DOM。
 * `node scripts/id-host-map.mjs` 的口径：`(no id ancestor) → 2 个`、`page-number-panel → 9`、
 * `page-number-result → 3`、`page-number-review-panel → 9`。
 *
 * **三个入口按钮归外壳**（`selectpanel-recognition-status` 的「识别全部」、`panel-advanced` 的两个勾选），
 * 本模块里不出现 `rec-start-all` / `selection-check` / `check-pending` 这三个 id。
 *
 * 状态：`pageNumberMetricsLoading` / `pageNumberReviewFilter` 只被本模块读写 ⇒ 模块私有（实测：
 * 全仓没有壳内引用）；`pageNumberAnalysis` 外壳仍在读（`getPageNumberAnalysis` 注入给 PagesView）
 * ⇒ 留壳，走 `S.pageNumberAnalysis` 的访问器，模块不留副本。
 *
 * 6 处写盘全部在模块内闭环（请求 → 读回 → 重画自己那两个根）；跨模块两件事按事件命名注入：
 * `onPageNumberAnalysisReady`（分析就绪，页面视图要重画徽章）与 `onPageNumberChanged(text)`
 * （写盘之后通知页面视图刷新）。`window.confirm` 三处保留（浏览器 API，不是跨模块）。
 */
(function () {
  "use strict";

  let injected = {};
  let root = null;
  let reviewRoot = null;

  const part = (id) => (root ? root.querySelector(`#${id}`) : null);
  const reviewPart = (id) => (reviewRoot ? reviewRoot.querySelector(`#${id}`) : null);

  /** 只在本模块内读写。 */
  let pageNumberMetricsLoading = false;
  let pageNumberReviewFilter = "all";

  // 异常分类的顺序与中文名（只被本模块用；随函数一起搬过来）
const PN_ANOMALY_ORDER = ["no_candidate", "ambiguous", "jump", "offset_break", "duplicate"];
const PN_ANOMALY_LABELS = {
  no_candidate: "没有候选",
  ambiguous: "候选打架",
  jump: "页码不连续",
  offset_break: "偏移突变",
  duplicate: "重复页码",
  not_recognized: "未识别",
};

/** 外壳仍在读的状态 ⇒ 访问器。 */
const S = {
    get pageNumberAnalysis() { return injected.getPageNumberAnalysis(); },
    set pageNumberAnalysis(value) { injected.setPageNumberAnalysis(value); },
  };

async function loadPageNumberMetrics() {
  if (!injected.getCurrentProject() || S.pageNumberAnalysis || pageNumberMetricsLoading) {
    injected.onPageNumberAnalysisReady();
    return;
  }
  pageNumberMetricsLoading = true;
  try {
    S.pageNumberAnalysis = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/page-numbers`
    );
    injected.onPageNumberAnalysisReady();
  } catch {
    injected.onPageNumberAnalysisReady();
  } finally {
    pageNumberMetricsLoading = false;
  }
}

async function openPageNumberPanel() {
  if (!injected.getCurrentProject()) return;
  injected.openModal("page-number-panel");
  const body = root ? root.querySelector(".mbody") : null;
  if (body) body.scrollTop = 0;
  part("page-number-error").hidden = true;
  part("page-number-template-count").textContent = "";
  part("page-number-templates").innerHTML = "";
  const loading = document.createElement("li");
  loading.className = "muted";
  loading.textContent = "正在从已识别页里收集页码候选…";
  part("page-number-templates").append(loading);
  part("page-number-empty").hidden = true;
  part("page-number-result").hidden = true;
  await refreshPageNumberAnalysis();
}

async function refreshPageNumberAnalysis() {
  if (!injected.getCurrentProject()) return;
  try {
    S.pageNumberAnalysis = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/page-numbers`
    );
  } catch (error) {
    injected.showError(part("page-number-error"), error);
    return;
  }
  renderPageNumberAnalysis(S.pageNumberAnalysis);
  injected.onPageNumberAnalysisReady();
}

function pageNumberReliableChip(template) {
  const chip = document.createElement("span");
  chip.className = "chip " + (template.reliable ? "chip--ok" : "chip--warn");
  chip.textContent = template.reliable ? "数值连续" : "数值存疑";
  chip.title = template.reliable
    ? "相邻页的页码差与 PDF 页差一致，偏移稳定"
    : "模板位置成立，但页码数值不连续 / 偏移不恒定，采用前请核对";
  return chip;
}

function renderPageNumberTemplates(data) {
  const list = part("page-number-templates");
  list.innerHTML = "";
  const templates = data.templates || [];
  part("page-number-template-count").textContent = templates.length
    ? `${templates.length} 个 · 按覆盖页数排序`
    : "";
  if (!templates.length) {
    part("page-number-empty").hidden = false;
    return;
  }
  part("page-number-empty").hidden = true;
  for (const template of templates) {
    const item = document.createElement("li");
    item.className = "pn-template";

    const head = document.createElement("div");
    head.className = "pn-template__head";
    const label = document.createElement("span");
    label.className = "pn-template__label";
    label.textContent = template.label;
    const meta = document.createElement("span");
    meta.className = "pn-template__meta";
    const samples = (template.sample_pages || []).slice(0, 4).join("、");
    meta.textContent =
      `覆盖 ${template.coverage} 页` + (samples ? ` · 示例：第 ${samples} 页` : "");
    head.append(label, pageNumberReliableChip(template), meta);

    const adopt = document.createElement("button");
    adopt.type = "button";
    adopt.className = "btn btn--sm btn--pri";
    adopt.textContent = template.reliable ? "设为默认并填充" : "仍设为默认（不建议）";
    adopt.title = "整本默认模板；页码范围套用请用右边的按钮";
    adopt.addEventListener("click", () => adoptPageNumberTemplate(template));
    head.append(adopt);

    const rangeButton = document.createElement("button");
    rangeButton.type = "button";
    rangeButton.className = "btn btn--sm";
    rangeButton.textContent = "用于页码范围…";
    rangeButton.addEventListener("click", () => {
      form.hidden = !form.hidden;
    });
    head.append(rangeButton);
    item.append(head);

    const form = document.createElement("div");
    form.className = "pn-range-form";
    form.hidden = true;
    const total = Number(data.current?.total || 0);
    const fromInput = document.createElement("input");
    fromInput.type = "number";
    fromInput.className = "input";
    fromInput.min = "1";
    fromInput.max = String(total);
    fromInput.value = "1";
    fromInput.title = "起始 PDF 页（含）";
    const toInput = document.createElement("input");
    toInput.type = "number";
    toInput.className = "input";
    toInput.min = "1";
    toInput.max = String(total);
    toInput.value = String(Math.max(1, total));
    toInput.title = "结束 PDF 页（含）";
    const applyRange = document.createElement("button");
    applyRange.type = "button";
    applyRange.className = "btn btn--sm btn--pri";
    applyRange.textContent = "用这个模板填充这段";
    applyRange.addEventListener("click", () =>
      adoptPageNumberTemplate(template, {
        from_page: Number(fromInput.value),
        to_page: Number(toInput.value),
      })
    );
    const rangeHint = document.createElement("span");
    rangeHint.className = "muted";
    rangeHint.textContent = "第";
    const rangeHint2 = document.createElement("span");
    rangeHint2.className = "muted";
    rangeHint2.textContent = "页（含边界）";
    form.append(rangeHint, fromInput, document.createTextNode("–"), toInput, rangeHint2, applyRange);
    item.append(form);

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `查看示例页与页码序列（${template.values.length} 页）`;
    const values = document.createElement("ol");
    values.className = "pn-values";
    for (const row of template.values) {
      const entry = document.createElement("li");
      entry.textContent = `第 ${row.page_no} 页 → ${row.value}`;
      values.append(entry);
    }
    details.append(summary, values);
    item.append(details);

    if (template.notes && template.notes.length) {
      const notes = document.createElement("p");
      notes.className = "pn-template__notes";
      notes.textContent = template.notes.join(" ");
      item.append(notes);
    }
    list.append(item);
  }
}

function renderPageNumberAnomalies(current) {
  const box = part("page-number-anomalies");
  box.innerHTML = "";
  const groups = [
    ["no_candidate", "没有页码候选"],
    ["ambiguous", "候选打架（不猜，留空）"],
    ["jump", "页码不连续"],
    ["offset_break", "偏移突变"],
  ];
  for (const [key, label] of groups) {
    const items = (current.anomalies && current.anomalies[key]) || [];
    if (!items.length) continue;
    const group = document.createElement("div");
    group.className = "pn-anomaly-group";
    const title = document.createElement("h4");
    title.textContent = `${label} · ${items.length} 页`;
    const list = document.createElement("ul");
    for (const entry of items.slice(0, 30)) {
      const row = document.createElement("li");
      row.textContent = `第 ${entry.page_no} 页：${entry.reason}`;
      list.append(row);
    }
    if (items.length > 30) {
      const more = document.createElement("li");
      more.textContent = `还有 ${items.length - 30} 页…`;
      list.append(more);
    }
    group.append(title, list);
    box.append(group);
  }
  const notRecognized = current.not_recognized || { count: 0, pages: [] };
  if (notRecognized.count) {
    const group = document.createElement("div");
    group.className = "pn-anomaly-group";
    const title = document.createElement("h4");
    title.textContent = `未识别的页 · ${notRecognized.count} 页（单列，不算异常）`;
    const list = document.createElement("ul");
    const shown = (notRecognized.pages || []).slice(0, 40);
    const row = document.createElement("li");
    row.textContent =
      shown.map((no) => `第 ${no} 页`).join("、") +
      (notRecognized.count > shown.length
        ? ` 等（共 ${notRecognized.count} 页）`
        : "");
    list.append(row);
    group.append(title, list);
    box.append(group);
  }
  if (!box.children.length) {
    const ok = document.createElement("p");
    ok.className = "muted";
    ok.textContent = "没有异常页。";
    box.append(ok);
  }
}

function renderPageNumberAssignments(node, current, { editable = true } = {}) {
  if (!node) return;
  const assignments = current.assignments || [];
  node.innerHTML = "";
  if (!assignments.length) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  const title = document.createElement("div");
  title.className = "flabel";
  title.textContent = "哪几页用哪个模板";
  node.append(title);
  for (const segment of assignments) {
    const row = document.createElement("div");
    row.className = "pn-assign-row";
    const text = document.createElement("span");
    text.textContent =
      `第 ${segment.from_page}–${segment.to_page} 页 · ${segment.label}` +
      (segment.kind === "range" ? "（第二套）" : "（默认）");
    row.append(text);
    if (editable && segment.kind === "range") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn--sm";
      remove.textContent = "移除";
      remove.title = "移除这段页码范围，回到默认模板";
      remove.addEventListener("click", () =>
        removePageNumberRange(segment.from_page, segment.to_page)
      );
      row.append(remove);
    }
    node.append(row);
  }
  if (!current.default_template && (current.ranges || []).length) {
    const note = document.createElement("div");
    note.className = "muted";
    note.textContent = "没有整本默认模板：只有这些范围的页会被自动填充。";
    node.append(note);
  }
}

function renderPageNumberAnalysis(data) {
  renderPageNumberTemplates(data);
  const current = data.current || {};
  const counts = current.counts || {};
  part("page-number-meta").textContent =
    `已填 ${counts.filled || 0} / ${counts.total || 0} 页`;

  const result = part("page-number-result");
  // 没采用模板时，每个已识别页都会算"没有候选"，那不是异常，别铺一屏；
  // 只有"已采用模板 / 已填过页码 / 数值真的不连续"才展示当前映射与异常。
  const hasResult =
    Boolean(current.template) ||
    (counts.filled || 0) > 0 ||
    (counts.jump || 0) > 0 ||
    (counts.offset_break || 0) > 0;
  result.hidden = !hasResult;
  if (!hasResult) return;

  renderPageNumberAssignments(part("page-number-assignments"), current);
  part("page-number-current-summary").textContent = current.template
    ? `${current.template.label || "已采用模板"} · ${counts.filled || 0} 页`
    : `已填 ${counts.filled || 0} 页`;
  const mapping = part("page-number-mapping");
  mapping.innerHTML = "";
  const rows = (current.mapping || []).slice(0, 40);
  for (const row of rows) {
    const item = document.createElement("li");
    item.textContent = `第 ${row.page_no} 页 → ${row.printed_page}`;
    mapping.append(item);
  }
  if ((current.mapping || []).length > rows.length) {
    const more = document.createElement("li");
    more.className = "muted";
    more.textContent = `…共 ${current.mapping.length} 页`;
    mapping.append(more);
  }
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "还没有填充任何页。";
    mapping.append(empty);
  }
  renderPageNumberAnomalies(current);
}

async function adoptPageNumberTemplate(template, range = null) {
  if (!injected.getCurrentProject()) return;
  const scope = range
    ? `第 ${range.from_page}–${range.to_page} 页`
    : "整本默认模板";
  if (
    !confirm(
      `把「${template.label}」用作${scope}？\n` +
        "会按位置重新抽取相应页的印刷页码；手动值不会被覆盖。" +
        "数值不连续 / 偏移突变的页会列在异常里。" +
        (template.reliable ? "" : "\n\n注意：" + (template.notes || []).join(" "))
    )
  ) {
    return;
  }
  part("page-number-error").hidden = true;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/page-numbers/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, range }),
      }
    );
    S.pageNumberAnalysis = data;
    renderPageNumberAnalysis(data);
    // 审校面板的根就是这块 mask ⇒ 判断"开着吗"直接用根元素本身（querySelector 不匹配根自己）
    if (reviewRoot && !reviewRoot.hidden) renderPageNumberReview(data);
    await injected.onPageNumberChanged(
      `已按模板填充 ${data.applied?.filled ?? 0} 页` + (range ? `（${scope}）` : "")
    );
  } catch (error) {
    injected.showError(part("page-number-error"), error);
  }
}

async function removePageNumberRange(fromPage, toPage) {
  if (!injected.getCurrentProject()) return;
  if (!confirm(`移除第 ${fromPage}–${toPage} 页的第二套模板？这些页会回到默认模板。`)) {
    return;
  }
  part("page-number-error").hidden = true;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/page-numbers/ranges/remove`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_page: fromPage, to_page: toPage }),
      }
    );
    S.pageNumberAnalysis = data;
    renderPageNumberAnalysis(data);
    // 审校面板的根就是这块 mask ⇒ 判断"开着吗"直接用根元素本身（querySelector 不匹配根自己）
    if (reviewRoot && !reviewRoot.hidden) renderPageNumberReview(data);
    await injected.onPageNumberChanged(`已移除第 ${fromPage}–${toPage} 页的第二套模板`);
  } catch (error) {
    injected.showError(part("page-number-error"), error);
  }
}

function pageNumberIssueEntries(current) {
  const entries = [];
  for (const type of PN_ANOMALY_ORDER) {
    for (const item of (current.anomalies && current.anomalies[type]) || []) {
      entries.push({
        page_no: item.page_no,
        type,
        label: PN_ANOMALY_LABELS[type],
        reason: item.reason || "",
      });
    }
  }
  for (const pageNo of (current.not_recognized && current.not_recognized.pages) || []) {
    entries.push({
      page_no: pageNo,
      type: "not_recognized",
      label: PN_ANOMALY_LABELS.not_recognized,
      reason: "这一页还没有识别结果，不参与页码模板；可以手动填。",
    });
  }
  entries.sort((a, b) => a.page_no - b.page_no || a.type.localeCompare(b.type));
  return entries;
}

async function openPageNumberReview() {
  if (!injected.getCurrentProject()) return;
  injected.openModal("page-number-review-panel");
  reviewPart("page-number-review-error").hidden = true;
  reviewPart("page-number-review-meta").textContent = "";
  reviewPart("page-number-review-issues").innerHTML = "";
  reviewPart("page-number-review-table").innerHTML = "";
  await refreshPageNumberReview();
}

async function refreshPageNumberReview() {
  if (!injected.getCurrentProject()) return;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/page-numbers`
    );
    S.pageNumberAnalysis = data;
    renderPageNumberReview(data);
  } catch (error) {
    injected.showError(reviewPart("page-number-review-error"), error);
  }
}

function scrollToPageNumberRow(pageNo) {
  const row = reviewRoot ? reviewRoot.querySelector(
    `li[data-page-no="${pageNo}"]`
  ) : null;
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  const input = row.querySelector("input");
  if (input) input.focus();
}

function renderPageNumberFilters(current, entries) {
  const box = reviewPart("page-number-review-filters");
  box.innerHTML = "";
  const counts = { all: entries.length };
  for (const type of [...PN_ANOMALY_ORDER, "not_recognized"]) {
    counts[type] = entries.filter((entry) => entry.type === type).length;
  }
  const options = [
    ["all", `全部问题 ${counts.all}`],
    ...PN_ANOMALY_ORDER.map((type) => [type, `${PN_ANOMALY_LABELS[type]} ${counts[type]}`]),
    ["not_recognized", `未识别 ${counts.not_recognized}`],
  ];
  for (const [value, label] of options) {
    if (value !== "all" && !counts[value]) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn btn--sm ${pageNumberReviewFilter === value ? "is-on" : ""}`;
    button.textContent = label;
    button.addEventListener("click", () => {
      pageNumberReviewFilter = value;
      renderPageNumberReview(S.pageNumberAnalysis);
    });
    box.append(button);
  }
}

function renderPageNumberIssues(entries) {
  const list = reviewPart("page-number-review-issues");
  list.innerHTML = "";
  const filtered =
    pageNumberReviewFilter === "all"
      ? entries
      : entries.filter((entry) => entry.type === pageNumberReviewFilter);
  if (!filtered.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "这一类没有异常页。";
    list.append(empty);
    return;
  }
  for (const entry of filtered) {
    const item = document.createElement("li");
    item.textContent = `第 ${entry.page_no} 页 · ${entry.label}`;
    item.title = entry.reason;
    item.addEventListener("click", () => scrollToPageNumberRow(entry.page_no));
    list.append(item);
  }
}

function renderPageNumberReview(data, focusPage = null) {
  const current = data.current || {};
  const table = reviewPart("page-number-review-table");
  const scrollTop = table.scrollTop;
  const entries = pageNumberIssueEntries(current);
  renderPageNumberFilters(current, entries);
  renderPageNumberIssues(entries);
  renderPageNumberAssignments(reviewPart("page-number-review-assignments"), current);

  const mapping = new Map(
    (current.mapping || []).map((row) => [row.page_no, row])
  );
  const anomalies = new Map();
  for (const type of PN_ANOMALY_ORDER) {
    for (const item of (current.anomalies && current.anomalies[type]) || []) {
      const list = anomalies.get(item.page_no) || [];
      list.push(PN_ANOMALY_LABELS[type]);
      anomalies.set(item.page_no, list);
    }
  }
  const unrecognized = new Set(
    (current.not_recognized && current.not_recognized.pages) || []
  );
  const counts = current.counts || {};
  reviewPart("page-number-review-meta").textContent =
    `已填 ${counts.filled || 0} / ${counts.total || 0} 页` +
    (counts.manual ? ` · 手动 ${counts.manual} 页` : "");
  reviewPart("page-number-review-footnote").textContent =
    entries.length
      ? `共 ${entries.length} 个问题条目；左边只列异常 / 未识别页，正常的页不用点。`
      : "没有异常页。";

  table.innerHTML = "";
  const pages = [...(injected.getCurrentProject()?.pages || [])].sort((a, b) => a.page_no - b.page_no);
  for (const page of pages) {
    const row = document.createElement("li");
    row.dataset.pageNo = String(page.page_no);
    const issue = anomalies.get(page.page_no) || [];
    if (issue.length) row.classList.add("is-issue");
    if (unrecognized.has(page.page_no)) row.classList.add("is-unrecognized");

    const pageCell = document.createElement("span");
    pageCell.textContent = `第 ${page.page_no} 页`;
    const input = document.createElement("input");
    input.className = "input";
    input.type = "text";
    input.maxLength = 16;
    input.placeholder = "—";
    const record = mapping.get(page.page_no);
    input.value = record ? record.printed_page : "";
    input.dataset.original = input.value;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });
    input.addEventListener("blur", async () => {
      if (input.value.trim() === input.dataset.original) return;
      await savePageNumberManual(page.page_no, input.value.trim());
    });
    const source = document.createElement("span");
    source.textContent =
      record && record.source === "manual"
        ? "手动"
        : record && record.source === "template"
          ? "模板"
          : "";
    const status = document.createElement("span");
    status.className = "pn-status" + (issue.length ? " pn-status--bad" : "");
    status.textContent = issue.length
      ? issue.join(" / ")
      : unrecognized.has(page.page_no)
        ? "未识别"
        : record
          ? "正常"
          : "—";
    row.append(pageCell, input, source, status);
    table.append(row);
  }
  table.scrollTop = scrollTop;
  if (focusPage !== null) {
    requestAnimationFrame(() => scrollToPageNumberRow(focusPage));
  }
}

async function savePageNumberManual(pageNo, value) {
  if (!injected.getCurrentProject()) return;
  reviewPart("page-number-review-error").hidden = true;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/page-numbers/manual`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_no: pageNo, printed_page: value || null }),
      }
    );
    S.pageNumberAnalysis = data;
    renderPageNumberReview(data, pageNo);
    await injected.onPageNumberChanged(`第 ${pageNo} 页已改为手动映射`);
  } catch (error) {
    injected.showError(reviewPart("page-number-review-error"), error);
    // 失败时把输入框恢复成服务端的值
    if (S.pageNumberAnalysis) renderPageNumberReview(S.pageNumberAnalysis);
  }
}

function setupPageNumberPanel() {
  // 两个根各自的关闭按钮：`page-number-*` 在根 ①，`page-number-review-*` 在根 ②
  part("page-number-close")?.addEventListener("click", () =>
    injected.closeModal("page-number-panel")
  );
  part("page-number-done")?.addEventListener("click", () =>
    injected.closeModal("page-number-panel")
  );
  reviewPart("page-number-review-close")?.addEventListener("click", () =>
    injected.closeModal("page-number-review-panel")
  );
  reviewPart("page-number-review-done")?.addEventListener("click", () =>
    injected.closeModal("page-number-review-panel")
  );
}

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || null;
    reviewRoot = injected.reviewRoot || null;
    return api;
  }

  const api = {
    init,
    openPageNumberPanel,
    openPageNumberReview,
    setupPageNumberPanel,
    loadPageNumberMetrics,
  };
  window.PageNumberPanel = api;
})();
