(function () {
  "use strict";
  let injected = {};
  const el = (id) => document.getElementById(id);

let layoutBlockLoading = false;

let setupSuggestionsLoading = false;

async function loadLayoutBlocks(pageNo, { forceSuggestions = false } = {}) {
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") return;
  injected.setLayoutBlockPage(pageNo);
  layoutBlockLoading = true;
  injected.setLayoutBlockPayload(null);
  renderLayoutBlocks();
  try {
    // 先读块：块数与版面确认状态是本地数据，界面立刻有东西看。
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/${pageNo}/blocks`
    );
    if (injected.getLayoutBlockPage() !== pageNo) return;
    const __layoutBlockPayload1 = {
      pageNo,
      blocks: Array.isArray(data.blocks) ? data.blocks : [],
      layoutConfirmed: Boolean(data.page && data.page.layout_confirmed),
      suggestions: [],
      suggestionsLoading: true,
    };
    injected.setLayoutBlockPayload(__layoutBlockPayload1);
    layoutBlockLoading = false;
    renderLayoutBlocks();
    // 块类型建议要扫全书的重复项，慢一点（真书 2–5 秒）：
    // 有缓存先用缓存，采用 / 改类型之后再用 forceSuggestions 重算。
    const suggestions = await injected.fetchPageSuggestions(pageNo, {
      force: forceSuggestions,
    }).catch(() => ({ suggestions: [] }));
    if (injected.getLayoutBlockPage() !== pageNo || !injected.getLayoutBlockPayload()) return;
    const __layoutBlockPayload2 = {
      ...layoutBlockPayload,
      suggestions: (suggestions && suggestions.suggestions) || [],
      suggestionsLoading: false,
    };
    injected.setLayoutBlockPayload(__layoutBlockPayload2);
  } catch (error) {
    injected.setLayoutBlockPayload(null);
    injected.showError(el("pages-error"), error);
  } finally {
    layoutBlockLoading = false;
    renderLayoutBlocks();
  }
}

async function loadSetupSuggestions() {
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") return;
  setupSuggestionsLoading = true;
  injected.setSetupSuggestionsLoaded(true);
  injected.setSetupSuggestions([]);
  renderSuggestionPanel();
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/suggestions`
    );
    injected.setSetupSuggestions(data.suggestions || []);
  } catch {
    injected.setSetupSuggestions([]);
  } finally {
    setupSuggestionsLoading = false;
    renderSuggestionPanel();
    renderTypePicker();
  }
}

/**
 * 识别到哪，框就出现在哪：刚认完的页当场换掉旧块。
 *
 * 页面视图里：可见的页立刻重画（缓存丢了就会重新拉），不打断翻页。
 * 审校视图里：正在看的那一页重新载入块列表——先把没落库的输入存掉，
 * 免得刷新把用户刚打的字盖掉。
 */
async function refreshRecognizedPages(pageNos, { reloadDetail = true } = {}) {
  if (!pageNos.length) return;
  for (const pageNo of pageNos) injected.forgetPageBlocks(pageNo);
  if (injected.getCurrentView() === "pages") {
    for (const pageNo of pageNos) {
      const tile = el("page-grid").querySelector(`.page-tile[data-page-no="${pageNo}"]`);
      if (tile) injected.clearPageBlocks(tile);
      if (injected.visiblePageNos.has(pageNo)) {
        injected.queueOverlayRender(pageNo);
        // 新页有块了，页面视图的「建议 N」角标要跟上（仍然只为可见页算）
        injected.ensurePageSuggestion(pageNo);
      }
    }
    injected.scheduleOverlayPump();
    return;
  }
  if (
    reloadDetail &&
    injected.getCurrentView() === "review" &&
    injected.getDetailPageNo() !== null &&
    pageNos.includes(injected.getDetailPageNo())
  ) {
    await injected.reloadDetailAfterRecognition(injected.getDetailPageNo());
  }
}

function renderLayoutBlocks() {
  const summary = el("layout-block-summary");
  const body = el("layout-block-body");
  const hint = el("layout-block-hint");
  const list = el("layout-block-suggestions");
  if (!summary || !body) return;
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") {
    summary.textContent = "";
    body.hidden = true;
    if (hint) hint.hidden = true;
    return;
  }
  const page = injected.layoutBlockPageRecord();
  if (!page) {
    summary.textContent = "选一页查看";
    body.hidden = true;
    if (hint) hint.hidden = false;
    return;
  }
  summary.textContent = layoutBlockLoading
    ? "读取中…"
    : injected.getLayoutBlockPayload()
      ? injected.getLayoutBlockPayload().suggestionsLoading
        ? `${injected.getLayoutBlockPayload().blocks.length} 块 · 建议读取中…`
        : `${injected.getLayoutBlockPayload().blocks.length} 块 · 高把握 ${injected.highConfidenceCount(injected.getLayoutBlockPayload().suggestions)}`
      : `第 ${page.page_no} 页`;
  if (layoutBlockLoading || !injected.getLayoutBlockPayload()) {
    body.hidden = false;
    if (hint) hint.hidden = true;
    el("layout-block-status").textContent = layoutBlockLoading
      ? "正在读取这一页的块与建议…"
      : "读取失败，点这一页重试。";
    list.innerHTML = "";
    el("layout-block-apply-all").hidden = true;
    el("layout-block-confirm").hidden = true;
    return;
  }
  body.hidden = false;
  const payload = injected.getLayoutBlockPayload();
  const high = payload.suggestions.filter((item) => item.confidence === "high");
  const suggestionsLoading = Boolean(payload.suggestionsLoading);
  el("layout-block-status").textContent =
    `本页版面：${payload.blocks.length} 块 · ` +
    (suggestionsLoading ? "建议读取中…" : `高把握建议 ${high.length}`) +
    ` · ${payload.layoutConfirmed ? "✓ 已确认" : "未确认"}`;
  const note = el("layout-block-note");
  if (note) {
    note.hidden = !suggestionsLoading;
    note.textContent = suggestionsLoading
      ? "块类型建议要扫全书相似文字，稍等一下；块数与版面状态已经是准的。"
      : "";
  }

  list.innerHTML = "";
  const ordered = payload.suggestions
    .slice()
    .sort((left, right) =>
      left.confidence === right.confidence
        ? left.order_index - right.order_index
        : left.confidence === "high"
          ? -1
          : 1
    );
  for (const item of ordered) {
    const row = document.createElement("li");
    row.className = "setup-suggestion";
    const head = document.createElement("div");
    head.className = "setup-suggestion__head";
    const where = document.createElement("strong");
    where.textContent = `第 ${item.order_index + 1} 块`;
    const target = document.createElement("span");
    target.className = "setup-suggestion__target";
    target.textContent =
      `建议：${injected.BLOCK_TYPE_LABELS[item.suggested_type] || item.suggested_type}`;
    const confidence = document.createElement("span");
    confidence.className = `chip setup-confidence setup-confidence--${item.confidence}`;
    confidence.textContent = item.confidence === "high" ? "把握较大" : "需确认";
    const adopt = document.createElement("button");
    adopt.type = "button";
    adopt.className = "btn btn--sm";
    adopt.textContent = "采用";
    adopt.title = `把这一块改成「${injected.BLOCK_TYPE_LABELS[item.suggested_type] || item.suggested_type}」（可撤销）`;
    adopt.addEventListener("click", () => injected.adoptBlockSuggestion(item, adopt));
    head.append(where, target, confidence, adopt);
    const reason = document.createElement("div");
    reason.className = "setup-suggestion__reason";
    reason.textContent = item.reason || "";
    row.append(head, reason);
    list.append(row);
  }

  const applyAll = el("layout-block-apply-all");
  applyAll.hidden = suggestionsLoading || high.length === 0;
  applyAll.textContent = `采用全部高把握建议（${high.length}）`;
  applyAll.disabled = high.length === 0;

  const confirm = el("layout-block-confirm");
  confirm.hidden = false;
  confirm.textContent = payload.layoutConfirmed ? "✓ 版面已确认" : "确认本页版面";
  confirm.disabled = payload.layoutConfirmed;
}

/**
 * 版心右栏（任务 36B 重写）。
 *
 * 只回答三件事：这一页现在的框是什么、怎么改回去、撤销。
 * 没有模式选择卡片，也没有折叠的「检测」按钮；进这一步时未定的页会自动拟合。
 */
function renderMarginPanel() {
  if (!injected.getCurrentProject()) return;
  injected.renderMarginStepVerdict();

  // 默认版心只作一行说明：现在每页用自己的检测行拟合，默认框只在显式「沿用默认」的页上生效。
  const defaultNode = el("margin-default");
  if (defaultNode) {
    const globalBox = injected.getCurrentProject().margin_box;
    defaultNode.textContent = globalBox
      ? `默认版心（只给「沿用默认」的页）：${injected.formatMarginBox(globalBox)}` +
        (injected.marginSourceText() ? ` · ${injected.marginSourceText()}` : "")
      : "默认版心：未设置（每页用自己的检测行拟合，用不到它）";
  }

  const state = el("margin-page-state");
  const badge = el("margin-page-badge");
  const edges = el("margin-edges");
  const basis = el("margin-basis");
  const actions = el("margin-page-actions");
  const next = el("margin-next");
  actions.innerHTML = "";
  badge.hidden = true;
  next.hidden = true;

  const selected = injected.selectionPages();
  injected.refreshMarginDetectHint();
  injected.refreshLayoutDetectEntry();

  if (!selected.length) {
    state.textContent = "未选择页面";
    edges.textContent = "在左边点一页：版心框会画在页面上，四边 / 四角可以直接拖。";
    basis.textContent = "";
    el("margin-audit").hidden = true;
    actions.append(injected.marginUndoButton());
    return;
  }

  if (selected.length > 1) {
    const picked = { auto: 0, inherit: 0, custom: 0, none: 0 };
    for (const page of selected) {
      picked[page.margin_box_mode] = (picked[page.margin_box_mode] || 0) + 1;
    }
    state.textContent = `已选 ${selected.length} 页`;
    edges.textContent =
      `自动 ${picked.auto} · 沿用默认 ${picked.inherit} · ` +
      `自定义 ${picked.custom} · 不适用 ${picked.none}`;
    basis.textContent =
      "「重置为本页自动」只改自动 / 沿用默认的页；自定义与不适用的页不动。";
    el("margin-audit").hidden = true;
    const targets = selected.filter(
      (page) => page.margin_box_mode === "auto" || page.margin_box_mode === "inherit"
    );
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn";
    reset.textContent = `重置为自动拟合（${targets.length}）`;
    reset.disabled = targets.length === 0;
    reset.title = "用每一页自己的检测行重新拟合；自定义 / 不适用不动";
    reset.addEventListener("click", () => injected.resetMarginsToAuto(targets));
    actions.append(reset, injected.marginUndoButton());
    return;
  }

  const page = selected[0];
  state.textContent = `第 ${page.page_no} 页 · 来源：${injected.pageMarginSourceLabel(page)}`;
  const box = injected.marginBoxOfPage(page);
  badge.hidden = false;
  const method = injected.pageMarginMethod(page);
  if (page.margin_box_mode === "none") {
    badge.textContent = "不适用";
    badge.className = "margin-step__badge is-warn";
  } else if (page.margin_box_mode === "custom") {
    badge.textContent = "已定 · 自定义";
    badge.className = "margin-step__badge";
  } else if (!box || method === "undetermined") {
    badge.textContent = "未定";
    badge.className = "margin-step__badge is-warn";
  } else {
    badge.textContent = method === "bbox" ? "已定 · 兜底" : "已定 · 自动拟合";
    badge.className = "margin-step__badge";
  }

  edges.textContent = box
    ? `左 ${(box[0] * 100).toFixed(1)}% · 上 ${(box[1] * 100).toFixed(1)}% — ` +
      `右 ${(box[2] * 100).toFixed(1)}% · 下 ${(box[3] * 100).toFixed(1)}%`
    : page.margin_box_mode === "none"
      ? "这一页标了「不适用」：不压暗、不参与版心判定。"
      : "这一页还没有版心：整页计入，不按版心排除任何内容。";

  basis.textContent =
    page.margin_box_mode === "none"
      ? "依据：整页插图 / 插页，不需要版心"
      : page.margin_box_mode === "custom"
        ? "来源：你拖出来的四边（只影响这一页）"
        : !box || method === "undetermined"
          ? injected.marginBasisForUndetermined(page)
          : method === "bbox"
            ? "来源：本页所有检测行的包围盒（行太少时的兜底）"
            : "来源：本页检测行自动拟合（不用默认版心）";

  injected.ensureMarginAudit(page);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn";
  reset.textContent = "重置为本页自动";
  reset.title = "丢掉这一页的自定义四边，用检测行重新拟合";
  reset.disabled = page.margin_box_mode === "auto" && Boolean(page.margin_box);
  reset.addEventListener("click", () => injected.resetMarginsToAuto([page]));
  actions.append(reset, injected.marginUndoButton());

  next.hidden = false;
  next.textContent = "下一页 ›";
  next.title = "版心不用逐页确认：不动就算已定，这里只是翻到下一页";
  next.onclick = () => injected.selectNextPage(page.page_no);
}

function renderPageSetup() {
  const bar = el("page-setup-bar");
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") {
    bar.hidden = true;
    el("setup-panel").hidden = true;
    return;
  }
  const stats = injected.pageSetupStats();
  bar.hidden = false;
  // 五类各报各的：总数 = 五类之和，别让人以为页数丢了
  el("setup-summary").textContent =
    `正文 ${stats.body} 页 · 正文排除 ${stats.bodyExcluded} 页` +
    ` · 前置 ${stats.front} 页 · 目录 ${stats.toc} 页 · 后置 ${stats.back} 页` +
    ` · 未确认 ${stats.unconfirmed} 页`;
  el("setup-panel").hidden = false;
  el("setup-progress").textContent = `${stats.confirmed} / ${stats.total} 已确认`;
  el("setup-confirm-selected").disabled = injected.getSelectedPages().size === 0;
  el("setup-confirm-all").disabled = stats.unconfirmed === 0;
  el("setup-confirm-all").textContent = `全书… 确认全部未确认页（${stats.unconfirmed}）`;
  updateSelectionPanel();
  renderTypePicker();
  renderSuggestionPanel();
  injected.initPanelAccordion();
  injected.renderStepPanels();
  if (injected.getFinishSummaryProject() !== injected.getCurrentProject().project_id) {
    injected.loadFinishSummary({ silent: true });
  }
}

function renderPages() {
  const project = injected.getCurrentProject();
  if (!project) return;
  const pages = injected.visiblePages();

  injected.renderPageSummary();

  const grid = el("page-grid");
  grid.innerHTML = "";
  for (const page of pages) {
    const tile = injected.buildTile(page, project);
    injected.applyTileState(tile, page);
    grid.append(tile);
  }
  if (!pages.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "当前筛选下没有页面。";
    grid.append(empty);
  }
  injected.applyPageZoom();
  renderPageSetup();
  updateSelectionPanel();
}

function renderRecognitionStatus() {
  const metrics = el("rec-status-metrics");
  const summary = el("rec-status-summary");
  if (!metrics) return;
  const pages = (injected.getProjectSummary() && injected.getProjectSummary().pages) || {};
  const divergence = (injected.getProjectSummary() && injected.getProjectSummary().divergence) || {};
  const engine = (injected.getFinishSummary() && injected.getFinishSummary().engine) || {};
  const included = Number(pages.included || 0);
  const recognized = Number(pages.recognized || 0);
  const failed = Number(pages.failed || 0);
  const checked = Number(engine.checked || 0);
  summary.textContent = included
    ? `主引擎 ${recognized}/${included}` +
      (failed ? ` · 失败 ${failed}` : "") +
      ` · 第二引擎 ${checked}/${included}`
    : "读取中…";

  const rows = [
    ["主引擎", `已识别 ${recognized} / 正文 ${included} 页` + (failed ? ` · 失败 ${failed} 页` : "")],
    [
      "第二引擎",
      included
        ? `已复核 ${checked} / ${included} 页` +
          (engine.aux_complete ? " · 已跑完" : " · 可选，还没跑完")
        : "—",
    ],
    [
      "差异",
      divergence.checked_pages
        ? `比过 ${divergence.compared_lines || 0} 行 · 汉字级 ${divergence.chars || 0}` +
          ` · 标点级 ${divergence.punct || 0} · 分歧率 ${injected.percentText(divergence.diverging_rate)}`
        : "还没有两路复核数据",
    ],
    [
      "空文本",
      `${engine.empty_lines || 0} 行没有读出文字（不计入完成判定）`,
    ],
  ];
  metrics.innerHTML = "";
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    metrics.append(dt, dd);
  }
  renderRecognitionVerdict();
}

/**
 * 识别步的"一句话 + 一个数字 + 一个主按钮"（任务 56 / 刀 2）。
 *
 * 数字看正文页：已识别 / 正文页数。识别**不读版心**，所以这一步先跑完，
 * 版心那一步才有行框可用；这句话只说事实，不写"下一步去…"。
 */
/**
 * 识别主按钮的目标与文案（**唯一出处**）。
 *
 * 为什么要有这个函数（2026-10-30）：以前「文案」和「disabled」在两段分支里各算一遍
 * （主识别按钮一段、底部条一段），改一处忘一处就会出现
 * 「按钮说能点、实际禁用」。现在四种状态由这里一次算出，刷新与点击都读它。
 *
 * 四种状态（有选中时按选中算，无选中时按全书算）：
 *   batch     无选择 + 有未识别 → 识别全部未识别页（N）
 *   selection 有选择 + 有未识别 → 识别所选 N 页
 *   force     有选择 + 全已识别 → 重新识别所选 N 页（危险色）
 *   none      全已识别          → 无可识别页（禁用）
 */
/** 正文页里还没识别的页数——主按钮、状态行、提示语都只许从这里取。 */
function bodyPending() {
  const body = injected.marginBodyPages();
  const recognized = body.filter((page) =>
    ["recognized", "has_candidate"].includes(injected.recognitionOf(page).status)
  ).length;
  return Math.max(body.length - recognized, 0);
}

function recognitionTarget() {
  const recognizedStatuses = ["recognized", "has_candidate"];
  const pending = bodyPending();          // 唯一出处（与状态行 / 提示语同源）

  // 进行中两态也要从这里产出（否则按钮文案又变成第二处写）
  const activeJob = injected.getTaskJobId() && injected.getLastTaskData() && injected.getLastTaskData().job
    ? injected.getLastTaskData().job
    : null;
  const activeJobRunning = Boolean(
    activeJob && ["queued", "running", "paused"].includes(activeJob.status)
  );
  if (activeJobRunning && activeJob.job_type === "ocr") {
    return { mode: "busy", text: "正在识别…", disabled: true, danger: false };
  }
  if (activeJobRunning && activeJob.job_type === "auxiliary") {
    return {
      mode: "aux",
      text: pending ? `开始识别（${pending} 页）` : "全部已识别",
      disabled: !pending,
      danger: false,
    };
  }
  if (injected.marginBodyPages().length === 0) {
    return { mode: "empty", text: "无可识别页", disabled: true, danger: false };
  }

  const selectedBody = injected.selectionPages().filter((page) => page.include);
  const selectedPending = selectedBody.filter(
    (page) => !recognizedStatuses.includes(injected.recognitionOf(page).status)
  ).length;

  if (selectedBody.length === 0) {
    if (pending > 0) {
      return { mode: "batch", text: `识别全部未识别页（${pending}）`, disabled: false, danger: false };
    }
    return { mode: "none", text: "无可识别页", disabled: true, danger: false };
  }
  if (selectedPending > 0) {
    return {
      mode: "selection",
      text: `识别所选 ${selectedBody.length} 页`,
      disabled: false,
      danger: false,
    };
  }
  return {
    mode: "force",
    text: `重新识别所选 ${selectedBody.length} 页`,
    disabled: false,
    danger: true,
  };
}

function renderRecognitionVerdict() {
  if (!injected.getCurrentProject()) return;
  const body = injected.marginBodyPages();
  const recognized = body.filter((page) =>
    ["recognized", "has_candidate"].includes(injected.recognitionOf(page).status)
  ).length;
  const pending = Math.max(body.length - recognized, 0);
  // 第二引擎：分母与主引擎相同，只算**已识别**的正文页（第二引擎读第一引擎切的行图）
  const engine = (injected.getFinishSummary() && injected.getFinishSummary().engine) || {};
  const auxChecked = Number(engine.checked || 0);
  const auxTotal = Number(engine.total || recognized || 0);
  const auxPending = Math.max(auxTotal - auxChecked, 0);
  const state = el("rec-verdict-state");
  const line = el("rec-verdict-line");
  const button = el("rec-start-all");
  const auxButton = el("rec-aux-all");
  const auxNote = el("rec-aux-note");
  el("rec-status-summary").textContent = `${recognized}/${body.length} 已识别`;
  if (!state || !line || !button) return;

  // 两路进度：主引擎 / 第二引擎各一行，写真实数字
  const primaryNum = el("rec-primary-num");
  const auxNum = el("rec-aux-num");
  const primaryState = el("rec-primary-state");
  const auxState = el("rec-aux-state");
  if (primaryNum) primaryNum.textContent = `${recognized}/${body.length}`;
  if (auxNum) auxNum.textContent = auxTotal ? `${auxChecked}/${auxTotal}` : "—";
  const activeJob = injected.getTaskJobId() && injected.getLastTaskData() && injected.getLastTaskData().job
    ? injected.getLastTaskData().job
    : null;
  const active = Boolean(
    activeJob && ["queued", "running", "paused"].includes(activeJob.status)
  );
  const ocrRunning = active && activeJob.job_type === "ocr";
  const auxRunning = active && activeJob.job_type === "auxiliary";
  if (primaryState) primaryState.textContent = ocrRunning ? "进行中…" : pending ? "还差 " + pending + " 页" : "✓";
  if (auxState) {
    auxState.textContent = auxRunning
      ? "进行中…"
      : auxPending
        ? "还差 " + auxPending + " 页"
        : auxTotal
          ? "✓"
          : "—";
  }

  const wrap = state.parentElement;
  const bothDone = pending === 0 && auxPending === 0 && auxTotal > 0;
  wrap.classList.toggle("is-ok", bothDone);
  wrap.classList.toggle("is-warn", !bothDone && !active);

  if (auxButton) {
    auxButton.hidden = false;
    if (auxRunning) {
      auxButton.textContent = "第二引擎复核中…";
      auxButton.disabled = true;
    } else if (!pending && auxPending) {
      auxButton.textContent =
        `第二引擎复核全书（${auxPending} 页 · ${injected.auxEstimateText(auxPending)}）`;
      auxButton.disabled = false;
    } else if (!auxPending && auxTotal) {
      auxButton.textContent = "第二引擎已跑完";
      auxButton.disabled = true;
    } else {
      auxButton.textContent = "第二引擎复核全书";
      auxButton.disabled = true;
    }
  }
  if (auxNote) {
    const textPages = injected.textLayerPages();
    if (auxPending && textPages) {
      auxNote.textContent =
        `这本书有 ${textPages} 页带文字层：第二引擎直接读文字层（不跑 Vision），几十秒就能跑完；` +
        "它只标分歧、不改字，跑不跑都不影响后面的步骤。";
    } else if (auxPending) {
      auxNote.textContent =
        "第二引擎独立复核一遍、只标分歧不改字；" +
        `按本机实测约 ${injected.AUX_SECONDS_PER_PAGE} 秒/页。它不挡后面的步骤，可以先做别的。`;
    } else {
      auxNote.textContent = "两路都跑完了：主引擎出文字，第二引擎的分歧在「正文审校」里逐条看。";
    }
  }

  if (ocrRunning) {
    state.textContent = "正在识别…";
    line.textContent = "主引擎在后台逐页跑，进度在右侧任务抽屉里；可以先去做别的。";
  } else if (auxRunning) {
    state.textContent = "正在复核…";
    line.textContent = "第二引擎在后台逐页复核（只标分歧、不改字），进度在右侧任务抽屉里。";
  } else if (!body.length) {
    state.textContent = "未准备";
    line.textContent = "还没有确认过正文页：先在第 1 步把页面类型确认好。";
  } else if (!pending) {
    state.textContent = auxPending ? "主引擎已完成" : "已识别";
    line.textContent = auxPending
      ? `正文 ${body.length} 页都识别过了，这一步算完成；第二引擎还有 ${auxPending} 页没复核` +
        "（可选，只影响审校时看不看得到两路分歧）。"
      : `正文 ${body.length} 页都识别过了，第二引擎也复核完了；差异在「正文审校」里逐条看。`;
  } else {
    // 有未识别页：目标按「有没有选中」算（recognitionTarget 是唯一出处）
    state.textContent = recognized ? "部分已识别" : "未开始";
    line.textContent =
      `正文 ${body.length} 页里还有 ${pending} 页没有识别。` +
      "识别不读版心，版心要等识别出行框之后才生成得了。";
  }

  // 按钮三样只由 recognitionTarget() 产出（文案 / 禁用 / 危险色同源）
  const target = recognitionTarget();
  button.textContent = target.text;
  button.disabled = target.disabled;
  button.classList.toggle("btn--danger", target.danger);
}

/** 建议区：只在选中页有建议时出现，条目就是"建议 vs 当前"的具体差别。 */
function renderSuggestionPanel() {
  const block = el("setup-suggestion-block");
  const note = el("setup-suggestion-note");
  const list = el("setup-suggestions");
  if (!block) return;
  const items = injected.selectedSuggestions();
  if (setupSuggestionsLoading && injected.getSelectedPages().size) {
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
    target.textContent = `建议：${injected.PAGE_TYPE_LABELS[item.suggested_type] || item.suggested_type}`;
    const confidence = document.createElement("span");
    confidence.className = `chip setup-confidence setup-confidence--${item.confidence}`;
    confidence.textContent = `把握 ${item.confidence_label}`;
    head.append(where, target, confidence);
    const page = injected.getCurrentProject().pages.find((entry) => entry.page_no === item.page_no);
    if (page && page.page_type !== item.suggested_type) {
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "btn btn--sm";
      apply.textContent = "采用";
      apply.addEventListener("click", () => injected.applySetupSuggestion(item, apply));
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

/**
 * 页面类型常驻列表：当前类型高亮 + "当前"文字，建议类型加淡色圆点。
 * 颜色只是辅助，文字标签始终在。
 */
function renderTypePicker() {
  const wrap = el("selection-types");
  if (!wrap) return;
  const selected = injected.selectionPages();
  const types = new Set(selected.map((page) => page.page_type));
  const mixed = types.size > 1;
  const current = types.size === 1 ? [...types][0] : null;
  el("selection-type-state").textContent = !selected.length
    ? "先选页"
    : mixed
    ? `混合（${types.size} 种）`
    : `当前：${injected.PAGE_TYPE_LABELS[current] || current}`;

  const suggested = injected.suggestionPagesByType();
  wrap.innerHTML = "";
  for (const type of injected.PAGE_TYPE_ORDER) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ptype ptype--${type}`;
    button.disabled = selected.length === 0;
    button.title = selected.length
      ? `把所选 ${selected.length} 页设为「${injected.PAGE_TYPE_LABELS[type] || type}」`
      : "先在左边选页";
    if (current === type) button.classList.add("is-current");
    const dot = document.createElement("span");
    dot.className = "ptype__dot";
    const label = document.createElement("span");
    label.className = "ptype__label";
    label.textContent = injected.PAGE_TYPE_LABELS[type] || type;
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
    button.addEventListener("click", () => injected.patchSelectedPages({ page_type: type }));
    wrap.append(button);
  }
}

/**
 * 任务轮询时用：只更新已有瓷砖的状态，不重建 DOM。
 *
 * 一本 400 页的书如果每 0.9 秒重建 400 个瓷砖，浏览器的滚动与图片都会被反复折腾；
 * 而任务进行时变的基本只有状态徽章。页面集合变了（筛选 / 增删页）才整格重建。
 */
function syncPageStates() {
  const grid = el("page-grid");
  const pages = injected.visiblePages();
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
    injected.applyTileState(tile, page);
  });
  injected.renderPageSummary();
  renderPageSetup();
  updateSelectionPanel();
}

/** 检测任务在跑：在版心分区里显示"做了多少 / 还要多久"。 */
function updateMarginDetectProgress(data) {
  const job = data && data.job;
  if (!job || job.job_type !== "layout") return;
  const active = ["queued", "running", "paused"].includes(job.status);
  if (!active) return;
  const done = job.done + job.failed;
  injected.showMarginDetectProgress(done, job.total || 0);
  const eta = injected.estimateRemainingSeconds(data);
  el("margin-fit-text").textContent =
    `正在检测版面… ${done} / ${job.total} 页` +
    (job.status === "paused"
      ? "（已暂停）"
      : eta > 0
        ? ` · 还需${injected.formatDuration(eta)}`
        : "");
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
  if (!injected.getCurrentProject()) return;
  const scroller = injected.pageScroller();
  if (!scroller) return;
  const grid = el("page-grid");
  const tiles = grid.querySelectorAll(".page-tile");
  if (!injected.getPageTileMetrics() || injected.getPageTileMetrics().length !== tiles.length) {
    injected.capturePageTileMetrics();
  }
  // 视图还没显示（openProject 里先渲染、再切视图）时量不出位置：等下一次。
  if (!injected.getPageTileMetrics()) return;

  const large = injected.getPageZoomIndex() >= 2;
  const scrollTop = scroller.scrollTop;
  const viewport = scroller.clientHeight;
  const nearLimit = 1400;
  const near = new Set();
  // 预取带：视口上下各约 1.5 屏。滚动的过程中就先把这一带的块数据拉回来，
  // 停下来时框已经在缓存里，不用等一轮网络。最多只排 PAGE_BLOCK_PREFETCH_BURST 页。
  const prefetchBand = Math.max(400, Math.min(1800, Math.round(viewport * 1.5)));
  const prefetchCandidates = [];
  let drawnSynchronously = 0;
  const byPage = new Map(injected.getCurrentProject().pages.map((page) => [page.page_no, page]));

  for (const item of injected.getPageTileMetrics()) {
    const top = item.top;
    const bottom = top + item.height;
    const pageNo = item.pageNo;
    const isVisible = bottom > scrollTop - 60 && top < scrollTop + viewport + 60;
    if (isVisible) {
      injected.visiblePageNos.add(pageNo);
      // 建议角标只为可见页算；大图档在可见性循环里算，网格档走 debounce 的 scan
      if (large) injected.ensurePageSuggestion(pageNo);
      if (injected.getPagesMarginOn()) {
        const page = byPage.get(pageNo);
        injected.paintTileMargin(item.tile, page);
        // 单列 / 单页里拖版心要吸附到行边界：只给眼前这几页补块数据。
        // 网格档一屏十几页，不为"可能拖一下"给整屏发请求；有块缓存时照样吸附。
        if (large && page && injected.recognitionOf(page).status === "recognized") {
          const key = injected.pageBlockKey(pageNo);
          if (!injected.getPageBlockCache().has(key) && !injected.getPageBlockPending().has(key)) {
            injected.fetchPageBlocks(pageNo, key);
          }
        }
      }
      if (injected.getPagesOverlayOn()) {
        // 先画后补：数据已经在缓存里就这一帧直接画，不等下一个 rAF。
        // 仍然限量（每帧最多 PAGE_OVERLAY_FRAME_LIMIT 页），密集网格不会爆。
        const key = injected.pageBlockKey(pageNo);
        const cached = injected.getPageBlockCache().get(key);
        const overlay = item.tile.querySelector(".page-overlay");
        if (
          cached &&
          overlay &&
          overlay._renderedBlocks !== cached &&
          drawnSynchronously < injected.getPAGE_OVERLAY_FRAME_LIMIT()
        ) {
          injected.renderPageBlocks(item.tile, cached);
          drawnSynchronously += 1;
        } else {
          injected.queueOverlayRender(pageNo);
        }
      }
    } else {
      injected.visiblePageNos.delete(pageNo);
      injected.clearPageBlocks(item.tile);
      injected.clearTileMargin(item.tile);
    }

    if (!large) {
      // 网格档离视口很远的页不预取（一屏十几页，±1.5 屏已经够）
      if (bottom > scrollTop - prefetchBand && top < scrollTop + viewport + prefetchBand) {
        const distance = top >= scrollTop && bottom <= scrollTop + viewport
          ? 0
          : Math.min(Math.abs(top - scrollTop), Math.abs(top - (scrollTop + viewport)));
        prefetchCandidates.push({ pageNo, distance });
      }
      continue;
    }
    if (bottom <= scrollTop - nearLimit || top >= scrollTop + viewport + nearLimit) {
      continue;
    }
    near.add(pageNo);
    const image = item.tile.querySelector("img");
    if (image && image.dataset.largeSrc && image.getAttribute("src") !== image.dataset.largeSrc) {
      image.src = image.dataset.largeSrc;
    }
  }

  injected.pumpPageBlockPrefetch(prefetchCandidates);

  if (!large) return;
  // 大图档：离视口很远的页释放大图，也清掉块框
  for (const item of injected.getPageTileMetrics()) {
    if (near.has(item.pageNo)) continue;
    injected.visiblePageNos.delete(item.pageNo);
    const image = item.tile.querySelector("img");
    if (image) image.removeAttribute("src");
    injected.clearPageBlocks(item.tile);
    injected.clearTileMargin(item.tile);
  }
}

function updateSelectionPanel() {
  const count = injected.getSelectedPages().size;
  const selected = injected.selectionPages();
  const numbers = [...selectedPages].sort((left, right) => left - right);
  const bodySelected = selected.filter((page) => page.include);
  const pendingBody = bodySelected.filter(
    (page) => injected.recognitionOf(page).status === "unrecognized"
  );
  const stats = injected.pageSetupStats();

  el("selection-count").textContent = count ? `已选 ${count} 页` : "未选择页面";
  const range = el("selection-range");
  if (!numbers.length) {
    range.textContent = "";
  } else if (numbers.length === 1) {
    const page = selected[0];
    const type = injected.PAGE_TYPE_LABELS[page.page_type] || page.page_type;
    range.textContent =
      `第 ${numbers[0]} 页 · ${type} · ${page.page_confirmed ? "已确认" : "待确认"} · ` +
      injected.RECOGNITION_LABELS[injected.recognitionOf(page).status] || "";
  } else {
    const contiguous = numbers.length === numbers[numbers.length - 1] - numbers[0] + 1;
    range.textContent = contiguous
      ? `第 ${numbers[0]}–${numbers[numbers.length - 1]} 页`
      : `第 ${numbers.slice(0, 6).join("、")}${numbers.length > 6 ? " 等" : ""}`;
  }
  if (numbers.length) {
    const visibleNos = new Set(injected.visiblePages().map((page) => page.page_no));
    const hidden = numbers.filter((no) => !visibleNos.has(no)).length;
    if (hidden) range.textContent += ` · 其中 ${hidden} 页不在当前筛选`;
  }

  // 类型分布只在"混合"时出现；类型齐就不占一行。
  const typeSummary = el("selection-types-summary");
  if (count > 1) {
    const byType = {};
    for (const page of selected) {
      const type = injected.PAGE_TYPE_LABELS[page.page_type] || page.page_type;
      byType[type] = (byType[type] || 0) + 1;
    }
    const entries = Object.entries(byType);
    typeSummary.textContent =
      entries.length > 1 ? `类型 ${entries.map(([k, v]) => `${k} ${v}`).join(" · ")}` : "";
  } else {
    typeSummary.textContent = "";
  }

  // 顶部"下一步"：只给一条，不重复 setupbar 的计数。**按这一页的真实状态说**，
  // 不按步骤顺序说：没有框的页不能写"已自动拟合"（这页连行框都没有，拟合不出来）。
  const next = el("selection-next");
  if (injected.getWorkflowStep() === "margin") {
    if (count !== 1) {
      next.textContent = "在左边点一页：版心框会画在页面上，四边 / 四角可拖";
    } else {
      const page = selected[0];
      const hasBox =
        Boolean(injected.marginBoxOfPage(page)) || page.margin_box_mode === "none";
      if (page.margin_box_mode === "none") {
        next.textContent = "这一页标了「不适用版心」，整页都按正文处理";
      } else if (hasBox) {
        next.textContent =
          injected.pageMarginMethod(page) === "bbox"
            ? "版心是本页正文行的包围盒（兜底）；拖动四边调整，不改也算已定"
            : "版心已按本页正文行生成；拖动四边调整，不改也算已定";
      } else if (injected.pageHasFitLines(page)) {
        next.textContent = "这一页有正文行但还没有版心：点「重置为本页自动」重新生成";
      } else {
        // 两条文案都不许跟步骤顺序绑死（顺序还要调）：只说"没有行、所以生成不了"
        next.textContent =
          "这一页还没有可用的正文行（识别行 / 检测行都没有），版心暂时生成不了";
      }
    }
  } else if (injected.getWorkflowStep() === "recognition") {
    next.textContent = count
      ? "识别完成后，去「正文审校」逐条看差异"
      : "这一步只看识别状态；差异在「正文审校」里逐条看";
  } else if (!count) {
    if (stats.unconfirmed > 0) {
      next.textContent = `${stats.unconfirmed} 页未确认 → 先确认页面类型`;
    } else if (bodyPending()) {
      next.textContent = `${bodyPending()} 页未识别 → 可以直接识别`;
    } else {
      next.textContent = "页面都准备好了，可以审校或导出";
    }
  } else if (count === 1) {
    const page = selected[0];
    if (!page.page_confirmed) next.textContent = "下一步：确认这一页算不算正文";
    else if (injected.recognitionOf(page).status === "unrecognized") {
      next.textContent = page.include ? "下一步：识别这一页" : "这一页不是正文，不参与识别";
    } else next.textContent = "下一步：在审校里核对文字";
  } else if (bodySelected.length === 0) {
    next.textContent = "所选页都不是正文，不参与识别";
  } else {
    next.textContent = pendingBody.length
      ? `下一步：识别所选正文里的 ${pendingBody.length} 页`
      : "所选正文页都已识别";
  }

  renderTypePicker();
  renderSuggestionPanel();
  renderMarginPanel();

  el("selection-more").disabled = false;
  const allVisible = injected.visiblePages();
  el("selection-all").textContent = `全选当前筛选结果（${allVisible.length}）`;

  el("setup-confirm-selected").disabled = count === 0;
  el("setup-confirm-all").disabled = stats.unconfirmed === 0;
  el("setup-confirm-all").textContent = `全书… 确认全部未确认页（${stats.unconfirmed}）`;
  el("selection-review-open").disabled = count === 0;
  el("assign-open").disabled = count === 0;
  el("selection-clear").hidden = count === 0;
  el("check-pending").disabled = false;

  // 分区头摘要（状态式）——未选择时也要显示全书口径。
  el("setup-progress").textContent = count
    ? `${selected.filter((page) => page.page_confirmed).length} 页已确认 · 全书 ${stats.confirmed} / ${stats.total}`
    : `${stats.confirmed} / ${stats.total} 已确认`;
  // 任务 36B：这两块跟着当前选择走（版面块只看单页；识别状态看全书）。
  injected.scheduleLayoutBlocks();
  renderRecognitionStatus();

  const hint = el("selection-hint");
  hint.hidden = true;
  if (count === 0) return;
  if (selected.every((page) => !page.include)) {
    hint.textContent =
      "选中的页都不是「正文」，不参与识别。要把它们纳入识别，把类型改成「正文」。";
    hint.hidden = false;
  } else if (count >= 3 && count <= 10) {
    hint.textContent =
      `选了 ${count} 页——可以先当样本试识别：认完点某一页的「结果」看看质量，` +
      "再决定要不要识别整本。样本结果不代表整本书。";
    hint.hidden = false;
  }

}

/**
 * 进「版心确认」时自动拟合未定的页。
 *
 * - 只碰 `mode=auto` 且还没有框的页：`.custom` 绝不覆盖，`.none` / `.inherit` 也不动；
 * - **不预先按"有没有行"筛页**：后端会回退识别行拟合（刀 1），无文字的页单独报
 *   `no_text`，不该由前端猜；猜错就会把整本没检测过的书误判成"没有行"；
 * - 一批 20 页一次请求，界面按批更新进度条（分批后不会假死）；
 * - 拟合失败的页记进 `marginFitTried`，本次会话不反复重试；任务结束 / 重新进这一步会清空。
 */
async function ensureMarginFitted({ manual = false } = {}) {
  injected.refreshMarginDetectHint();
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") return;
  if (injected.getMarginFitRunning()) return;
  // 主按钮「全部确认」是人工动作：上一轮试过但没成的页也要再试一次
  if (manual) injected.marginFitTried.clear();
  const pending = injected.marginUndeterminedPages().filter(
    (page) => injected.pageHasFitLines(page) && !injected.marginFitTried.has(page.page_no)
  );
  if (!pending.length) {
    injected.renderMarginStepVerdict();
    if (manual) {
      injected.setMarginStatus(
        injected.marginPagesWithoutLines().length
          ? `没有可生成的页：还差 ${injected.marginPagesWithoutLines().length} 页没有正文行（要先识别）。`
          : "全书版心都已定，没有要生成的页。",
        false,
        12000
      );
    }
    return;
  }
  const startedAt = performance.now();
  injected.setMarginFitRunning(true);
  injected.renderMarginStepVerdict();
  for (const page of pending) injected.marginFitTried.add(page.page_no);
  injected.showMarginFitProgress(0, pending.length);
  let attempted = 0;
  let fitted = 0;
  let fallback = 0;
  let undetermined = 0;
  let noText = 0;
  try {
    // **按后端返回的 remaining 收尾**，不按前端这份 pending 清单收尾：
    // 后端一批处理的是"所有缺框页"（含没有行的页），比 pending 多；
    // 拿 processed >= pending.length 当终点会提前停，留下一批有行却没生成的页
    // （TTBVW3 实测：267 页第一次点了只生成 219 页，剩 23 页）。
    while (true) {
      const data = await injected.apiJson(
        `/api/projects/${injected.getCurrentProject().project_id}/margin-box/fit-all`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ only_missing: true, limit: 20 }),
        }
      );
      const updated = Number(data.updated || 0);
      attempted += updated;
      fitted += Number(data.fitted || 0);
      fallback += Number(data.fallback || 0);
      undetermined += Number(data.undetermined || 0);
      noText += Number(data.no_text || 0);
      const remaining = Number(data.remaining || 0);
      injected.showMarginFitProgress(attempted, attempted + remaining);
      if (!updated || remaining === 0) break;
    }
    await injected.refreshPageStates();
    injected.refreshMarginTiles();
    renderMarginPanel();
    if (typeof injected.loadFinishSummary === "function") {
      await injected.loadFinishSummary({ silent: true });
    }
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    const summary = injected.marginFitSummaryText(fitted, fallback, undetermined, noText);
    injected.setMarginStatus(manual ? `${summary} 耗时 ${elapsed} 秒。` : summary, false, 20000);
  } catch (error) {
    injected.showError(el("pages-error"), error);
  } finally {
    injected.setMarginFitRunning(false);
    injected.hideMarginFitProgressSoon();
    injected.refreshMarginDetectHint();
    injected.renderMarginStepVerdict();
  }
}

/** 重新拉一次页面列表（任务跑完、页面状态大面积变化时用）。 */
async function reloadProjectPages() {
  if (!injected.getCurrentProject()) return;
  try {
    const data = await injected.apiJson(`/api/projects/${injected.getCurrentProject().project_id}/pages`);
    injected.getCurrentProject().pages = data.pages;
  } catch (error) {
    injected.showError(el("pages-error"), error);
    return;
  }
  renderPages();
  injected.renderProjectMeta();
  if (injected.getDetailPageNo() !== null) await injected.loadPageDetail(injected.getDetailPageNo());
}

/**
 * 拖动保存（任务 36B）：松手才写一次库，**一律标 `mode=custom`**。
 *
 * 为什么自动页拖过也要变 custom：用户在自动框上调了四边，这个结果必须在下一次
 * 「自动拟合」时保住；只要 mode 还是 auto，重拟合就会把它冲掉。
 * 撤销走内存里的 `marginUndoStack`（一次拖动 = 一步）。
 */
async function savePageMargin(pageNo, box) {
  const page = injected.getCurrentProject()
    ? injected.getCurrentProject().pages.find((item) => item.page_no === pageNo)
    : null;
  if (!page) return;
  const previousMode = page.margin_box_mode;
  if (previousMode === "none") return;
  injected.marginUndoStack.push({
    pageNo,
    mode: previousMode,
    box: page.margin_box ? [...page.margin_box] : null,
  });
  injected.trimMarginUndo();
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/${pageNo}/margin-box`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ margin_box_mode: "custom", margin_box: box }),
      }
    );
    injected.mergePageRecord(data.page);
    injected.repaintTileMargin(data.page);
    injected.setMarginStatus(
      `第 ${pageNo} 页的版心已保存（本页自定义）；` +
        (previousMode === "custom" ? "" : "自动拟合不会再覆盖它。")
    );
    renderMarginPanel();
  } catch (error) {
    injected.marginUndoStack.pop();
    // 存不上就把框画回原值，别让界面上留着一个没保存的框
    injected.repaintTileMargin(page);
    injected.showError(el("pages-error"), error);
  }
}

/** 撤销一次版心改动：auto 页重拟合，其它页写回原来的四边。 */
async function undoMarginEdit() {
  const entry = injected.marginUndoStack.pop();
  if (!entry || !injected.getCurrentProject()) return;
  try {
    if (entry.mode === "auto" || entry.mode === "inherit") {
      await injected.apiJson(
        `/api/projects/${injected.getCurrentProject().project_id}/pages/${entry.pageNo}/margin-box`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ margin_box_mode: entry.mode, margin_box: null }),
        }
      );
      if (entry.mode === "auto") {
        await injected.apiJson(
          `/api/projects/${injected.getCurrentProject().project_id}/pages/${entry.pageNo}/margin-box/fit`,
          { method: "POST" }
        );
      }
    } else {
      await injected.apiJson(
        `/api/projects/${injected.getCurrentProject().project_id}/pages/${entry.pageNo}/margin-box`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            margin_box_mode: entry.mode,
            margin_box: entry.box,
          }),
        }
      );
    }
    await injected.refreshPageStates();
    injected.refreshMarginTiles();
    renderMarginPanel();
    injected.setMarginStatus(`已撤销第 ${entry.pageNo} 页的版心改动。`);
  } catch (error) {
    injected.marginUndoStack.push(entry);
    injected.showError(el("pages-error"), error);
  }
}

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    // 刀 2：deps 已赋值，统一挂 14 段 pages 接线（**必须在 return api 之前**）。
    // DOM 还没解析完时（单测的合成 DOM / 脚本先于 body 执行）推迟到 DOMContentLoaded：
    // 否则 el(...) 是 null，绑监听会抛 TypeError——而抛在 init 里会连累整个 boot。
    const wireWhenReady = () => {
      // 页面里没有 pages 视图（单测的合成 DOM、或别的视图的页）→ 这些接线不适用，跳过。
      if (!document.getElementById("view-pages")) {
        // 诊断痕迹：静默 return 与「return 之后死代码」同类——看不见就等于没发生。
        // 记在 dataset 而不是 window：R6 规定一个模块文件只许露 1 个 window 接口对象。
        const root = document.documentElement;
        if (root) root.dataset.pagesWireSkipped = String(Number(root.dataset.pagesWireSkipped || 0) + 1);
        return;
      }
      wireAll();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", wireWhenReady, { once: true });
    } else {
      wireWhenReady();
    }
    return api;
  }

  // **api 的键 = 外壳实际调用的名字集合**（落盘后 `grep -oE 'PagesView\.[A-Za-z_]+' app.js | sort -u` 现扫；
  // 回滚后的 app.js 里是 0 个，所以这份 20 个来自 HANDOFF-stage1.md §4 记录的那次实测）。
  // 少一个键 → 外壳那处 `undefined.apply`，而 node / pytest / accept 三闸全看不见。
  // 收敛棘轮：本刀 20 键 → 终点 3（enter / render / refresh），靠刀 2-5 把 41 个调用者搬进来逐刀降。
  const api = {
    init,
    ensureMarginFitted,
    loadLayoutBlocks,
    loadSetupSuggestions,
    refreshRecognizedPages,
    reloadProjectPages,
    renderLayoutBlocks,
    renderMarginPanel,
    renderPageSetup,
    renderPages,
    renderRecognitionStatus,
    renderRecognitionVerdict,
    renderSuggestionPanel,
    renderTypePicker,
    savePageMargin,
    syncPageStates,
    undoMarginEdit,
    updateMarginDetectProgress,
    updatePageVisibility,
    updateSelectionPanel
  };
// ---------------------------------------------------------------- 刀 2：14 段 pages 接线
/**
 * 导出面板里「识别版心判定」这个开关的接线（刀 2.5 从 `setupExportPanel` 原样搬出）。
 *
 * 只碰 `view-pages` 的 id：`rec-margin-judgement`。
 * export 面板的其余 id（`export-*` / `compare-*`）在别的 section，留在 host 里不动。
 */
function wirePagesExportMarginJudgement() {
  const recMargin = el("rec-margin-judgement");
  if (recMargin) {
    recMargin.addEventListener("change", (event) =>
      injected.setMarginJudgementSetting(event.target.checked)
    );
  }
}
/**
 * 页面视图的识别设置控件接线（刀 2.5 从 `setupRecognitionSettings` 原样搬出）。
 *
 * 只碰 `view-pages` 的 id：`rec-engine` / `rec-dpi` / `rec-language` / `rec-dual-strategy`；
 * 读的都是 `patchRecognitionSetting`（住在 app.js），刀 2 进模块时经 `init(deps)` 取得。
 * 原位仍由 `setupRecognitionSettings()` 调用，副作用顺序不变。
 */
function wirePagesRecognitionSettings() {
  el("rec-engine").addEventListener("change", (event) =>
    injected.patchRecognitionSetting("recognition_engine", event.target.value)
  );
  for (const radio of document.querySelectorAll('#rec-dpi input[type="radio"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        injected.patchRecognitionSetting("recognition_dpi", Number(radio.value));
      }
    });
  }
  el("rec-language").addEventListener("change", (event) =>
    injected.patchRecognitionSetting("recognition_language", event.target.value)
  );
  el("rec-dual-strategy").addEventListener("change", (event) =>
    injected.patchRecognitionSetting("dual_engine_strategy", event.target.value)
  );
}
/**
 * 页面视图「页码」两个入口按钮的接线（刀 2.5 从 `setupPageNumberPanel` 原样搬出）。
 *
 * 只碰 `view-pages` 的 id：`page-number-open` / `page-number-review-open`。
 * 面板本体在 `view-merge`（`page-number-panel` / `page-number-review-panel` 及其关闭、完成按钮），
 * 那 4 行**留在 host 里不动**——搬进来就成了跨视图引用。
 *
 * 这两行原被 merge 的 4 行隔开，搬走后它们相对提前；目标是 4 个**不同**元素，
 * `addEventListener` 在各自元素上的注册先后不可观测，故不算行为变化。
 */
function wirePagesPageNumberPanel() {
  el("page-number-open").addEventListener("click", injected.openPageNumberPanel);
  el("page-number-review-open").addEventListener("click", injected.openPageNumberReview);
}
/**
 * 页面视图「更多」菜单的接线（刀 2.5 从 `setupPageMore` 原样搬出）。
 *
 * 只碰 `view-pages` 的 id：`page-more` / `page-more-menu`。
 * **整段搬**，而不是只搬那两行 `el(...)`：`button` / `menu` 被后面的定位与点击收起共用，
 * 只搬那两行就得改行（改成返回值出口），那就不再是「只搬行」。
 */
function wirePagesPageMore() {
  const button = el("page-more");
  const menu = el("page-more-menu");
  if (!button || !menu) return;
  const place = () => {
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth || 200;
    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    menu.style.left = `${Math.round(
      Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width))
    )}px`;
  };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) place();
  });
  for (const item of menu.querySelectorAll("button")) {
    item.addEventListener("click", () => {
      menu.hidden = true;
    });
  }
  document.addEventListener("click", (event) => {
    if (menu.hidden) return;
    if (menu.contains(event.target) || button.contains(event.target)) return;
    menu.hidden = true;
  });
}
/**
 * 筛选行（类型 / 识别 / 流程 / 待办 / 仅正文）（刀 2.5 从 `setupLibrary` 原样搬出）。
 *
 * 这一段只碰 `view-pages` 的 id，抽出来时行序未动。
 */
function wirePagesFilters() {
  // 筛选与选择（说明书 6.2）
  el("filter-type").addEventListener("change", renderPages);
  el("filter-recognition").addEventListener("change", renderPages);
  el("filter-workflow").addEventListener("change", renderPages);
  el("filter-triage").addEventListener("change", renderPages);
  el("pages-only-included").addEventListener("change", renderPages);
}
/**
 * 页网格空白处点按取消选择（刀 2.5 从 `setupLibrary` 原样搬出）。
 *
 * 这一段只碰 `view-pages` 的 id，抽出来时行序未动。
 */
function wirePagesPageGrid() {
  // 点页面网格的空白处取消选择：只认"不在任何页瓷砖里"的点击，
  // 所以单击页 / 拖版心把手 / 页内按钮都不会误触发。
  el("page-grid").addEventListener("click", (event) => {
    if (!injected.getCurrentProject()) return;
    if (event.target.closest(".page-tile")) return;
    if (event.target.closest(".page-margin__handle")) return;
    injected.clearPageSelection();
  });
}
/**
 * 页码区间输入（刀 2.5 从 `setupLibrary` 原样搬出）。
 *
 * 这一段只碰 `view-pages` 的 id，抽出来时行序未动。
 */
function wirePagesPageRange() {
  el("page-range-select").addEventListener("click", injected.applyPageRangeInput);
  el("page-range").addEventListener("keydown", (event) => {
    if (event.key === "Enter") injected.applyPageRangeInput();
  });
}
/**
 * 全选 / 反选 / 清空 / 选中识别（刀 2.5 从 `setupLibrary` 原样搬出）。
 *
 * 这一段只碰 `view-pages` 的 id，抽出来时行序未动。
 */
function wirePagesSelection() {
  el("selection-all").addEventListener("click", injected.selectAllVisiblePages);
  el("selection-select-all").addEventListener("click", injected.selectAllVisiblePages);
  el("selection-clear").addEventListener("click", injected.clearPageSelection);
}
/**
 * 「更多」下拉（选择区）（刀 2.5 从 `setupLibrary` 原样搬出）。
 *
 * 这一段只碰 `view-pages` 的 id，抽出来时行序未动。
 */
function wirePagesSelectionMore() {
  const more = el("selection-more");
  const moreMenu = el("selection-more-menu");
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
  });
  document.addEventListener("click", (event) => {
    if (moreMenu.hidden) return;
    if (moreMenu.contains(event.target) || event.target === more) return;
    moreMenu.hidden = true;
  });
  for (const item of moreMenu.querySelectorAll("button")) {
    item.addEventListener("click", () => {
      moreMenu.hidden = true;
    });
  }
}
/**
 * 缩放 / 块框 / 版心 / 布局 / 识别批量入口（刀 2.5 从 `setupLibrary` 原样搬出）。
 *
 * 这一段只碰 `view-pages` 的 id，抽出来时行序未动。
 */
function wirePagesPanes() {
  el("pages-zoom-out").addEventListener("click", () => injected.setPageZoom(-1));
  el("pages-zoom-in").addEventListener("click", () => injected.setPageZoom(1));
  el("pages-overlay-toggle").addEventListener("click", injected.togglePageBlocksOverlay);
  el("pages-margin-toggle").addEventListener("click", injected.toggleMarginView);
  el("layout-block-apply-all").addEventListener("click", injected.adoptAllHighSuggestions);
  el("layout-block-confirm").addEventListener("click", injected.confirmLayoutFromPanel);
  el("margin-confirm-all").addEventListener("click", injected.confirmAllMargins);
  el("rec-start-all").addEventListener("click", () => {
    // 目标由 recognitionTarget() 唯一决定（文案、禁用、点下去做什么，三处同源）
    const target = recognitionTarget();
    if (target.mode === "batch") {
      injected.startBatchRecognition("unrecognized");
      return;
    }
    if (target.mode === "selection") {
      injected.recognizeSelection(false);
      return;
    }
    if (target.mode === "force") {
      injected.recognizeSelection(true);
    }
  });
  el("rec-aux-all").addEventListener("click", injected.startAuxiliaryAll);
}
/**
 * 确认页三件（选中 / 拆页号 / 全部）（刀 2.5 从 `setupLibrary` 原样搬出）。
 *
 * 这一段只碰 `view-pages` 的 id，抽出来时行序未动。
 */
function wirePagesSetup() {
  el("setup-confirm-selected").addEventListener("click", injected.confirmSelectedPages);
  el("split-page-numbers").addEventListener("click", injected.openSplitBatchPanel);
  el("setup-confirm-all").addEventListener("click", injected.confirmAllUnconfirmed);
}
/**
 * 「高建议自动采用」开关的接线（刀 2.5 从 `setupLibrary` 原样搬出）。只碰 `view-pages` 的 id：`auto-apply-suggestions`。
 */
function wirePagesAutoApplySuggestions() {
  el("auto-apply-suggestions").addEventListener("change", (event) =>
    injected.setAutoApplySetting(event.target.checked)
  );
}
/**
 * 「检查选中」按钮的接线（刀 2.5 从 `setupLibrary` 原样搬出）。只碰 `view-pages` 的 id：`selection-check`。
 */
function wirePagesSelectionCheck() {
  el("selection-check").addEventListener("click", () => injected.checkSelection(null));
}
/**
 * 「检查未定」按钮的接线（刀 2.5 从 `setupLibrary` 原样搬出）。只碰 `view-pages` 的 id：`check-pending`。
 */
function wirePagesCheckPending() {
  el("check-pending").addEventListener("click", () => injected.checkSelection("unchecked"));
}

/** 刀 2：14 段接线在本模块初始化时统一挂载（顺序 = 它们在 app.js 里的原顺序）。 */
function wireAll() {
  wirePagesExportMarginJudgement();
  wirePagesRecognitionSettings();
  wirePagesPageNumberPanel();
  wirePagesPageMore();
  wirePagesFilters();
  wirePagesPageGrid();
  wirePagesPageRange();
  wirePagesSelection();
  wirePagesSelectionMore();
  wirePagesPanes();
  wirePagesSetup();
  wirePagesAutoApplySuggestions();
  wirePagesSelectionCheck();
  wirePagesCheckPending();
}

  window.PagesView = api;
})();
