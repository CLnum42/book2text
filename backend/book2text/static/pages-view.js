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
      if (tile) hidePageBlocks(tile);
      if (injected.visiblePageNos.has(pageNo)) {
        queueOverlayRender(pageNo);
        // 新页有块了，页面视图的「建议 N」角标要跟上（仍然只为可见页算）
        ensurePageSuggestion(pageNo);
      }
    }
    scheduleOverlayPump();
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
  renderMarginStepVerdict();

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
  refreshMarginDetectHint();
  refreshLayoutDetectEntry();

  if (!selected.length) {
    state.textContent = "未选择页面";
    edges.textContent = "在左边点一页：版心框会画在页面上，四边 / 四角可以直接拖。";
    basis.textContent = "";
    el("margin-audit").hidden = true;
    actions.append(marginUndoButton());
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
    reset.addEventListener("click", () => resetMarginsToAuto(targets));
    actions.append(reset, marginUndoButton());
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

  ensureMarginAudit(page);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn";
  reset.textContent = "重置为本页自动";
  reset.title = "丢掉这一页的自定义四边，用检测行重新拟合";
  reset.disabled = page.margin_box_mode === "auto" && Boolean(page.margin_box);
  reset.addEventListener("click", () => resetMarginsToAuto([page]));
  actions.append(reset, marginUndoButton());

  next.hidden = false;
  next.textContent = "下一页 ›";
  next.title = "版心不用逐页确认：不动就算已定，这里只是翻到下一页";
  next.onclick = () => selectNextPage(page.page_no);
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
  initPanelAccordion();
  renderStepPanels();
  if (injected.getFinishSummaryProject() !== injected.getCurrentProject().project_id) {
    injected.loadFinishSummary({ silent: true });
  }
}

function renderPages() {
  const project = injected.getCurrentProject();
  if (!project) return;
  const pages = visiblePages();

  renderPageSummary();

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
  applyPageZoom();
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
    button.addEventListener("click", () => patchSelectedPages({ page_type: type }));
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
    injected.applyTileState(tile, page);
  });
  renderPageSummary();
  renderPageSetup();
  updateSelectionPanel();
}

/** 检测任务在跑：在版心分区里显示"做了多少 / 还要多久"。 */
function updateMarginDetectProgress(data) {
  const job = data && data.job;
  if (!job || job.job_type !== "layout") return;
  const active = ["queued", "running", "paused"].includes(job.status);
  if (!active) return;
  // 只为显示兜底（不改进度语义：失败页算进 done 仍照旧）：
  //   字段缺失 → 0（原来会印 undefined / NaN）
  //   done 超 total → 夹到 total（原来 width 会到 150%）
  const total = Math.max(0, Number(job.total) || 0);
  const done = Math.min(total, Math.max(0, (Number(job.done) || 0) + (Number(job.failed) || 0)));
  marginProgressOwner = "detect"; // 检测优先：拟合照跑，但不写这组元素
  showMarginDetectProgress(done, total);
  const eta = injected.estimateRemainingSeconds(data);
  el("margin-fit-text").textContent =
    `正在检测版面… ${done} / ${total} 页` +
    (job.status === "paused"
      ? "（已暂停）"
      : eta > 0
        ? ` · 还需${injected.formatDuration(eta)}`
        : "");
}

// ---- 块框队列与可见性调度（刀 10a：调度器与调度状态从外壳搬进模块）----
//
// 为什么必须搬：滚动 / 缩放 / 排队本来就是 pages 自己的渲染循环，而调度状态原先留在外壳，
// 变成"一份状态两边写、一边读"（Architect 2026-10-30）。搬齐之后外壳只知道"布局可能要重排"。
// 上限常数一起搬：它们只被这里的两支循环读，留在外壳只能靠 getter 注入。
const PAGE_OVERLAY_FRAME_LIMIT = 3;
const PAGE_BLOCK_FETCH_LIMIT = 6;
const PAGE_BLOCK_PREFETCH_LIMIT = 4;
const PAGE_BLOCK_PREFETCH_BURST = 8;
const overlayRenderQueue = [];
const overlayRenderQueued = new Set();
let overlayPumpScheduled = false;
let pageScrollScheduled = false;
let pageBlockPrefetchInFlight = 0;

// ---- 块框绘制：registry（片 2 起页面视图是它的第二个消费者）----
//
// 容器由 registry 建（不再由 buildTile 拼 class），版本判重也在 registry；
// 这里只负责"这一页该显示哪份数据 + 什么形态"。

/** 一页的图层句柄：句柄挂在 tile 上（不按 class 找 DOM）。 */
function overlayHandleFor(tile) {
  const api = window.OverlayLayer;
  const pageNo = Number(tile && tile.dataset ? tile.dataset.pageNo : NaN);
  if (!api || !Number.isFinite(pageNo)) return null;
  if (!tile.__overlayHandle) {
    const thumb = tile.querySelector(".page-tile__thumb");
    if (!thumb) return null;
    tile.__overlayHandle = api.mount(thumb, { pageNo });
  }
  return tile.__overlayHandle;
}

/** 容器 class（labeled / margin）由 styles 决定——页面视图里没有第二处写这个 class。 */
function pageBlockStyles() {
  return {
    details: injected.getPageZoomIndex() >= 2,
    labeled: true,
    marginMode: injected.getPagesMarginOn(),
  };
}

function paintPageBlocks(tile, blocks) {
  const api = window.OverlayLayer;
  const handle = overlayHandleFor(tile);
  if (!api || !handle) return;
  api.paint(handle, {
    data: injected.getPagesOverlayOn() ? blocks || [] : [],
    active: ["blocks"],
    styles: pageBlockStyles(),
  });
}

/** 与原来的 clearPageBlocks 同义：图层自己收起。 */
function hidePageBlocks(tile) {
  paintPageBlocks(tile, []);
}

function resetOverlayQueue() {
  overlayRenderQueue.length = 0;
  overlayRenderQueued.clear();
}

/** 滚动的下一帧重算一次可见性（同一帧内多次滚动只排一次）。 */
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
  if (!injected.getCurrentProject()) return;
  const scroller = pageScroller();
  if (!scroller) return;
  const grid = el("page-grid");
  const tiles = grid.querySelectorAll(".page-tile");
  if (!injected.getPageTileMetrics() || injected.getPageTileMetrics().length !== tiles.length) {
    capturePageTileMetrics();
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
      if (large) ensurePageSuggestion(pageNo);
      if (injected.getPagesMarginOn()) {
        const page = byPage.get(pageNo);
        injected.paintTileMargin(item.tile, page);
        // 单列 / 单页里拖版心要吸附到行边界：只给眼前这几页补块数据。
        // 网格档一屏十几页，不为"可能拖一下"给整屏发请求；有块缓存时照样吸附。
        if (large && page && injected.recognitionOf(page).status === "recognized") {
          const key = injected.pageBlockKey(pageNo);
          if (!injected.getPageBlockCache().has(key) && !injected.pageBlockPending.has(key)) {
            fetchPageBlocks(pageNo, key);
          }
        }
      }
      if (injected.getPagesOverlayOn()) {
        // 先画后补：数据已经在缓存里就这一帧直接画，不等下一个 rAF。
        // 仍然限量（每帧最多 PAGE_OVERLAY_FRAME_LIMIT 页），密集网格不会爆。
        const key = injected.pageBlockKey(pageNo);
        const cached = injected.getPageBlockCache().get(key);
        if (cached && drawnSynchronously < PAGE_OVERLAY_FRAME_LIMIT) {
          paintPageBlocks(item.tile, cached);
          drawnSynchronously += 1;
        } else {
          queueOverlayRender(pageNo);
        }
      }
    } else {
      injected.visiblePageNos.delete(pageNo);
      hidePageBlocks(item.tile);
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

  pumpPageBlockPrefetch(prefetchCandidates);

  if (!large) return;
  // 大图档：离视口很远的页释放大图，也清掉块框
  for (const item of injected.getPageTileMetrics()) {
    if (near.has(item.pageNo)) continue;
    injected.visiblePageNos.delete(item.pageNo);
    const image = item.tile.querySelector("img");
    if (image) image.removeAttribute("src");
    hidePageBlocks(item.tile);
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
    const visibleNos = new Set(visiblePages().map((page) => page.page_no));
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
  const allVisible = visiblePages();
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
  scheduleLayoutBlocks();
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
  refreshMarginDetectHint();
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") return;
  if (injected.getMarginFitRunning()) return;
  // 检测在跑时不开新的拟合：它按"当前行"写盘，检测还在产出新行时拟出来的是半成品的框，
  // 而且 marginUndeterminedPages 只挑没框的页 ⇒ 半成品的框会被钉死。检测收尾会再调一次。
  if (injected.getLayoutDetectActive()) return;
  // 主按钮「全部确认」是人工动作：上一轮试过但没成的页也要再试一次
  if (manual) injected.marginFitTried.clear();
  const pending = injected.marginUndeterminedPages().filter(
    (page) => injected.pageHasFitLines(page) && !injected.marginFitTried.has(page.page_no)
  );
  if (!pending.length) {
    renderMarginStepVerdict();
    if (manual) {
      setMarginStatus(
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
  renderMarginStepVerdict();
  for (const page of pending) injected.marginFitTried.add(page.page_no);
  marginFitDisplayTotal = pending.length; // 显示分母冻结：服务端 remaining 在检测期间会一直涨
  showMarginFitProgress(0, marginFitDisplayTotal);
  let attempted = 0;
  let fitted = 0;
  let fallback = 0;
  let undetermined = 0;
  let noText = 0;
  let stoppedForDetect = false;
  try {
    // **按后端返回的 remaining 收尾**，不按前端这份 pending 清单收尾：
    // 后端一批处理的是"所有缺框页"（含没有行的页），比 pending 多；
    // 拿 processed >= pending.length 当终点会提前停，留下一批有行却没生成的页
    // （TTBVW3 实测：267 页第一次点了只生成 219 页，剩 23 页）。
    while (true) {
      // 检测开始了：在**下一批之前**停手（不是只停显示）——见入口那段注释
      if (injected.getLayoutDetectActive()) {
        stoppedForDetect = true;
        break;
      }
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
      showMarginFitProgress(attempted, marginFitDisplayTotal, remaining);
      if (!updated || remaining === 0) break;
    }
    await injected.refreshPageStates();
    refreshMarginTiles();
    renderMarginPanel();
    if (typeof injected.loadFinishSummary === "function") {
      await injected.loadFinishSummary({ silent: true });
    }
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    const summary = injected.marginFitSummaryText(fitted, fallback, undetermined, noText);
    // 半路给检测让位：不写"拟合了多少"的收尾话（检测收尾还会再拟一次）
    if (!stoppedForDetect) setMarginStatus(manual ? `${summary} 耗时 ${elapsed} 秒。` : summary, false, 20000);
  } catch (error) {
    injected.showError(el("pages-error"), error);
  } finally {
    injected.setMarginFitRunning(false);
    hideMarginFitProgressSoon();
    refreshMarginDetectHint();
    renderMarginStepVerdict();
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
  trimMarginUndo();
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
    setMarginStatus(
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
    refreshMarginTiles();
    renderMarginPanel();
    setMarginStatus(`已撤销第 ${entry.pageNo} 页的版心改动。`);
  } catch (error) {
    injected.marginUndoStack.push(entry);
    injected.showError(el("pages-error"), error);
  }
}

/** 撤销按钮：只撤销本次会话里的版心拖动 / 重置，一次一步。 */
function marginUndoButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  const entry = injected.marginUndoStack[injected.marginUndoStack.length - 1] || null;
  button.textContent = "撤销";
  button.disabled = !entry;
  button.title = entry
    ? `撤销第 ${entry.pageNo} 页的版心改动`
    : "还没有可撤销的版心改动";
  button.addEventListener("click", undoMarginEdit);
  return button;
}

/** 撤销栈只留最近 20 步（一次拖动 / 一次重置 = 一步）。 */
function trimMarginUndo() {
  while (injected.marginUndoStack.length > 20) injected.marginUndoStack.shift();
}

async function loadFinishSummary({ silent = false } = {}) {
  if (!injected.getCurrentProject()) return;
  if (injected.getFinishSummaryLoading()) {
    // 已经有一次在跑：记下"跑完再来一次"，别把这一次（例如刚确认完跨页延续）
    // 直接丢掉——丢掉就会在界面上留下旧计数。
    injected.setFinishSummaryAgain(true);
    return;
  }
  injected.setFinishSummaryLoading(true);
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/review/finish-summary`
    );
    injected.setFinishSummary(data);
    injected.setFinishSummaryProject(injected.getCurrentProject().project_id);
    if (!injected.getStepsReady()) {
      injected.setStepsReady(true);
      injected.flushBootQueue();
    }
    injected.updateFinishChips();
    injected.renderFinishPanel();
    injected.syncWorkflowSteps();
  } catch (error) {
    if (!silent) injected.showError(el("pages-error"), error);
  } finally {
    injected.setFinishSummaryLoading(false);
    if (injected.getFinishSummaryAgain()) {
      injected.setFinishSummaryAgain(false);
      loadFinishSummary({ silent: true });
    }
  }
}

async function loadLanguageSummary() {
  const node = el("rec-language-summary");
  if (!node || !injected.getCurrentProject()) return;
  try {
    const data = await injected.apiJson(`/api/projects/${injected.getCurrentProject().project_id}/aux/languages`);
    const counts = data.counts || {};
    const bits = [];
    if (counts["en-US"]) bits.push(`en-US ${counts["en-US"]} 页`);
    if (counts["zh-Hans"]) bits.push(`zh-Hans ${counts["zh-Hans"]} 页`);
    if (counts.mixed) bits.push(`中英混合 ${counts.mixed} 页`);
    node.hidden = false;
    node.textContent =
      bits.length
        ? `第二引擎语言：${bits.join(" · ")}` + (data.unknown ? ` · 未判定 ${data.unknown} 页` : " · 未判定 0 页")
        : "第二引擎语言：还没判定（识别 / 复核一次后自动判）";
  } catch {
    node.hidden = true;
  }
}

async function loadPageNumberSummary() {
  if (!injected.getCurrentProject()) return;
  const node = el("page-number-summary");
  if (!node) return;
  if (!node.textContent || !node.children.length) {
    node.textContent = "正在读取页码状态…";
  }
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/page-numbers/summary`
    );
    renderPageNumberMetrics(data);
    injected.loadPageNumberMetrics();
  } catch {
    node.textContent = "未定位 · 可跳过";
    renderPageNumberMetrics();
  }
}

/**
 * 页码数据变了（写库成功后）：重读摘要，再回一行状态。
 *
 * 契约：**`text` 省略 / 空串 = 只重读摘要、不报状态**（hydrateView 进目录确认那条就是这种调用）。
 * 顺序与 9.3 之前逐字一致：先 `await loadPageNumberSummary()`（它自己 catch，不会抛），再 setPageNumberStatus。
 * 摘要读失败也要报状态：`loadPageNumberSummary` 内部吞掉错误，所以这行一定会跑到。
 */
async function onPageNumberChanged(text = "") {
  await loadPageNumberSummary();
  if (text) setPageNumberStatus(text);
}

/** 页码分析数据到手（或已有缓存）：重画右栏指标（只读 pageNumberAnalysis，壳状态经注入读）。 */
function onPageNumberAnalysisReady() {
  renderPageNumberMetrics();
}

/** 「⋯」里的检测入口：名字里带上还差多少页，点开先看计划再决定跑不跑。 */
function refreshLayoutDetectEntry() {
  const item = el("layout-detect-open");
  if (!item) return;
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") {
    item.hidden = true;
    return;
  }
  item.hidden = false;
  const selected = injected.selectionPages().filter((page) => page.include);
  if (injected.getSelectedPages().size && !selected.length) {
    item.disabled = true;
    item.title = "所选页都不是正文；检测版面只对正文页生效";
    item.textContent = "检测版面…（所选页都不是正文）";
    return;
  }
  item.disabled = false;
  item.title = "";
  if (selected.length) {
    // 有选择：括号里的数字必须是"这次真的会跑的页数"（与对话框里那个数同源）
    const selectedNos = new Set(selected.map((page) => page.page_no));
    const runnable = injected.marginUndeterminedPages().filter((page) => selectedNos.has(page.page_no)).length;
    item.textContent = runnable
      ? `检测版面…（所选 ${selected.length} 页里 ${runnable} 页还没检测）`
      : `检测版面…（所选 ${selected.length} 页都已检测）`;
    return;
  }
  const undetermined = injected.marginUndeterminedPages().length;
  item.textContent = undetermined
    ? `检测版面…（${undetermined} 页还没有版心）`
    : "检测版面…";
}

/**
 * 版心还差哪些页、为什么差。
 *
 * 这里只说**事实**（没有可用的正文行 → 拟合不出来），不说"下一步去识别"这类
 * 跟着步骤顺序变的话：检测入口在右上角「⋯ → 检测版面…」，不占这一步的主位。
 */
function refreshMarginDetectHint() {
  const hint = el("margin-detect-hint");
  if (!hint) return;
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") {
    hint.hidden = true;
    return;
  }
  const verdict = injected.marginStepVerdict();
  const noLines = verdict.noLines.length;
  const undetermined = verdict.undetermined.length;
  if (!undetermined) {
    hint.hidden = true;
    return;
  }
  const bits = [`还有 ${undetermined} 页没有版心`];
  if (noLines) {
    bits.push(`其中 ${noLines} 页还没有正文行（识别行 / 检测行都没有）`);
    bits.push("版心是从行框推出来的，这些页要等识别出字，或者去右上角「⋯ → 检测版面…」跑一次检测");
  } else {
    bits.push("这些页都有正文行，点「全部确认」就能生成");
  }
  hint.textContent = bits.join("；") + "。";
  hint.hidden = false;
}

/** 全局版心变了：只重画可见页（267 页全扫一遍没必要，可见性循环会兜底）。 */
function refreshMarginTiles() {
  if (!injected.getCurrentProject()) return;
  const byPage = new Map(injected.getCurrentProject().pages.map((page) => [page.page_no, page]));
  for (const tile of document.querySelectorAll("#page-grid .page-tile")) {
    const pageNo = Number(tile.dataset.pageNo);
    if (injected.getPagesMarginOn() && injected.visiblePageNos.has(pageNo)) {
      injected.paintTileMargin(tile, byPage.get(pageNo));
    } else {
      injected.clearTileMargin(tile);
    }
    // 容器 class 由 styles 决定：版心开关变了就按新 styles 重画一次（数据没变，registry 会重算 class）
    const cachedBlocks = injected.getPageBlockCache().get(injected.pageBlockKey(pageNo));
    if (cachedBlocks) paintPageBlocks(tile, cachedBlocks);
  }
}

/** 右栏那行"上次自动应用：N 页 M 块（可撤销）"。 */
function renderAutoApplyStatus(run) {
  injected.setLatestAutoApply(run);
  const node = el("auto-apply-status");
  if (!run) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }
  node.hidden = false;
  node.innerHTML = "";
  const when = (run.created_at || "").slice(5, 16).replace("T", " ");
  const text = document.createElement("span");
  text.textContent =
    `上次自动应用：${run.pages} 页 ${run.blocks} 块（${injected.autoApplyTypeText(run.by_type)}）` +
    ` · ${when} · ${run.status === "undone" ? "已撤销" : "可撤销"}`;
  node.append(text);
  if (run.status === "applied") {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "btn btn--sm btn--ghost";
    undo.textContent = "撤销这次自动应用";
    undo.addEventListener("click", () => injected.undoAutoApply(run.auto_apply_id));
    node.append(undo);
  }
}

/** 版心步的"一句话 + 一个数字 + 一个主按钮"。 */
function renderMarginStepVerdict() {
  if (!injected.getCurrentProject()) return;
  const v = injected.marginStepVerdict();
  const state = el("margin-verdict-state");
  const line = el("margin-verdict-line");
  const button = el("margin-confirm-all");
  el("margin-confidence").textContent = `${v.settled}/${v.body.length} 已定`;
  if (!state || !line || !button) return;
  const wrap = state.parentElement;
  wrap.classList.toggle("is-warn", v.key === "partial");
  wrap.classList.toggle("is-ok", v.key === "fitted");
  button.hidden = false;
  switch (v.key) {
    case "unprepared":
      state.textContent = "未准备";
      line.textContent =
        `还没有识别出正文行（正文 ${v.body.length} 页）。版心按识别出的行框生成：` +
        "先在「文字识别」这一步跑识别，回来这里就自动出框。";
      button.textContent = "全部确认（先识别）";
      button.disabled = true;
      break;
    case "working":
      state.textContent = injected.getLayoutDetectActive() ? "正在检测版面…" : "正在生成版心…";
      line.textContent = `已定 ${v.settled} / ${v.body.length} 页；跑完会接着把剩下的生成掉。`;
      button.textContent = "正在处理…";
      button.disabled = true;
      break;
    case "fitted":
      state.textContent = "已拟合";
      line.textContent =
        `正文 ${v.body.length} 页的版心都在了` +
        (v.noText.length ? `；${v.noText.length} 页没有文字（插图 / 空白），跳过` : "") +
        "。拖动单页四边可以微调，不改也算已定。";
      button.textContent = "全书已定";
      button.disabled = true;
      break;
    default:
      state.textContent = "有未定页";
      if (!v.needFit.length) {
        // 只剩"没有行"的页：这里没有可生成的东西，别给一个点了没反应的按钮
        line.textContent =
          `还差 ${v.noLines.length} 页版心，这些页都还没有正文行：` +
          "先跑完「文字识别」，识别出行的页回来会自动出框。";
        button.textContent = "全部确认（先识别）";
        button.disabled = true;
        break;
      }
      line.textContent =
        `还差 ${v.undetermined.length} 页：${v.needFit.length} 页有正文行、可以直接生成` +
        (v.noLines.length ? `；${v.noLines.length} 页还没有正文行` : "") +
        "。";
      button.textContent = `全部确认（生成 ${v.needFit.length} 页）`;
      button.disabled = false;
      break;
  }
}

function renderPageNumberMetrics(summary = null) {
  const summaryNode = el("page-number-summary");
  const metrics = el("page-number-metrics");
  const review = el("page-number-review-open");
  if (!summaryNode || !metrics) return;
  const data = summary || {};
  const current = (injected.getPageNumberAnalysis() && injected.getPageNumberAnalysis().current) || {};
  const counts = current.counts || {};
  const filled = current.filled ?? data.filled ?? 0;
  const total = current.total ?? data.total ?? (injected.getCurrentProject() ? injected.getCurrentProject().pages.length : 0);
  const template = current.template || data.template || null;
  const ranges = current.ranges || data.ranges || [];
  const label = (template && (template.label || template.position)) || (ranges.length ? `${ranges.length} 段范围` : "");
  const hasTemplate = Boolean(template || ranges.length);
  const exceptions = hasTemplate
    ? (counts.no_candidate || 0) +
      (counts.ambiguous || 0) +
      (counts.jump || 0) +
      (counts.offset_break || 0) +
      (counts.duplicate || 0)
    : 0;
  summaryNode.textContent = template || ranges.length
    ? `${label}${filled ? ` · 已填 ${filled}` : ""}${exceptions ? ` · 异常 ${exceptions}` : ""}`
    : "未定位 · 可跳过";
  metrics.innerHTML = "";
  const row = (name, value) => {
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    dd.textContent = value;
    metrics.append(dt, dd);
  };
  row("模板", label || "未定位");
  row("已填", `${filled} / ${total} 页`);
  const detail = !hasTemplate
    ? "未定位（可跳过）"
    : exceptions
      ? `${exceptions} 页（无候选 ${counts.no_candidate || 0} · ` +
        `歧义 ${counts.ambiguous || 0} · 溢出 ${counts.jump || 0} · 重复 ${counts.duplicate || 0}）`
      : "无";
  row("异常", detail);
  review.hidden = exceptions === 0;
  review.textContent = exceptions ? `核对 ${exceptions} 页异常…` : "核对异常…";
}

/**
 * 顶部那行统计：任务进行中它每分钟都要变，所以单独成一个函数，
 * 轮询的就地刷新（syncPageStates）也能更新，不必为了一个数字重建整格。
 */
function renderPageSummary() {
  const project = injected.getCurrentProject();
  if (!project) return;
  const all = project.pages;
  const shown = visiblePages().length;
  el("page-summary").textContent =
    `共 ${all.length} 页 · 正文 ${all.filter((page) => page.include).length} 页` +
    ` · 已识别 ${all.filter((page) => injected.recognitionOf(page).status === "recognized").length} 页` +
    ` · 已确认 ${all.filter((page) => page.page_confirmed).length} 页` +
    (shown !== all.length ? ` · 当前显示 ${shown} 页` : "");
}

/** 把当前项目设置画进识别设置控件；不可用的引擎置灰并说明原因。 */
function renderRecognitionSettings() {
  if (!el("rec-engine")) return;
  const engine = String(injected.recognitionSetting("recognition_engine"));
  const dpi = Number(injected.recognitionSetting("recognition_dpi"));
  const language = String(injected.recognitionSetting("recognition_language"));
  const strategy = String(injected.recognitionSetting("dual_engine_strategy"));

  const vision = injected.engineProbe("apple_vision");
  const visionOk = Boolean(vision && vision.available);
  const visionReason = vision ? vision.reason || "当前平台不可用" : "还没拿到引擎自检结果";

  // 引擎：Apple Vision / 双引擎比对都需要第二引擎可用（Windows 上置灰）
  const engineSelect = el("rec-engine");
  engineSelect.value = engine;
  for (const option of engineSelect.options) {
    const needsVision = option.value === "apple_vision" || option.value === "dual";
    option.disabled = needsVision && !visionOk;
    option.title =
      needsVision && !visionOk
        ? `不可用：${visionReason}`
        : option.value === "dual"
          ? "第一路 RapidOCR，完成后自动用 Apple Vision 比对；耗时约为单引擎两倍"
          : "";
  }

  for (const radio of document.querySelectorAll('#rec-dpi input[type="radio"]')) {
    radio.checked = Number(radio.value) === dpi;
  }
  el("rec-language").value = language;
  el("rec-dual-strategy").value = strategy;
  el("rec-dual-strategy").disabled = engine !== "dual";
  const strategyOn = engine === "dual";
  el("rec-strategy-label").hidden = !strategyOn;
  el("rec-dual-strategy").hidden = !strategyOn;
  el("rec-strategy-note").hidden = !strategyOn;

  let note = "";
  if (engine === "apple_vision" && !visionOk) {
    note = `这一项在当前平台不可用（${visionReason}）；识别会返回"引擎不可用"，请换一个引擎。`;
  } else if (engine === "dual" && !visionOk) {
    note = `双引擎比对需要 Apple Vision（${visionReason}）；识别会返回"引擎不可用"，请换一个引擎。`;
  } else if (engine === "apple_vision") {
    note = "Apple Vision 作为第一引擎直接识别（不是第二引擎复核）。";
  } else if (engine === "dual") {
    note = "第一路 RapidOCR，识别完成后自动用 Apple Vision 逐页比对标分歧；耗时约为单引擎的两倍。";
  } else if (!visionOk) {
    note = `RapidOCR 是默认第一引擎（离线内置）。第二引擎在当前平台不可用：${visionReason}。`;
  } else {
    note = "RapidOCR 是默认第一引擎（离线内置）；Apple Vision 也可作为第一引擎或双引擎的第二路。";
  }
  el("rec-engine-note").textContent = note;
  el("rec-summary").textContent =
    `${injected.RECOGNITION_ENGINE_LABELS[engine] || engine} · ${dpi} DPI` +
    (engine === "dual" ? ` · ${strategy === "candidates" ? "给候选" : "只标分歧"}` : "");
}

/**
 * 任务 36B：右栏按步骤只显示本步的分区。
 *
 * 页面确认 = 页面类型 + 版面块（+ 页码，可跳过）
 * 版心确认 = 只有版心
 * 文字识别 = 识别状态（只读）+ 识别设置（折叠，engine / DPI 仍要能改）
 *
 * 分区本身还是原来那几块 DOM，只是按步显示；不改任何业务逻辑。
 */
function renderStepPanels() {
  const onPages = Boolean(injected.getCurrentProject()) && injected.getCurrentView() === "pages";
  const step = injected.getCurrentProject() ? injected.getWorkflowStep() || "" : "";
  const pageStep = onPages && step === "pages";
  const marginStep = onPages && step === "margin";
  const recognitionStep = onPages && step === "recognition";
  // 目录确认也带版心开关（任务 46）：这一步要沿袭页面视图的版心/块框
  const indexStep = Boolean(injected.getCurrentProject()) && injected.getCurrentView() === "index";
  document.body.dataset.workflowStep = step;

  const group = (id, visible) => {
    const node = el(id);
    if (!node) return;
    node.hidden = !visible;
  };
  group("panel-page-settings", pageStep);
  group("panel-layout-blocks", pageStep);
  group("panel-pagenum-settings", pageStep);
  group("panel-margin-settings", marginStep);
  group("panel-recognition-status", recognitionStep);
  group("panel-recognition-settings", recognitionStep);
  // 第二引擎复核留在后面的「功能归位」刀里；这一刀不摆出来。
  group("panel-advanced", false);

  // 换成另一个步骤时给一个默认展开的分区；同一步内的重画不抢用户手动收起的状态。
  const key = `${step}|${onPages}`;
  const primary = pageStep
    ? "panel-page-settings"
    : marginStep
      ? "panel-margin-settings"
      : recognitionStep
        ? "panel-recognition-status"
        : null;
  const keyChanged = key !== injected.getLastStepPanelKey();
  injected.setLastStepPanelKey(key);
  if (primary) {
    const node = el(primary);
    // 手风琴会在打开项目时按 localStorage 展开"上次那个分区"，而它可能属于另一个步骤、
    // 此刻是隐藏的——于是当前步骤一个分区都没展开。这种情况只修一次：可见分区全关着才动。
    const visibleGroups = [
      ...document.querySelectorAll("#setup-panel details[data-panel]"),
    ].filter((group) => !group.hidden);
    const anyVisibleOpen = visibleGroups.some((group) => group.open);
    if (node && (keyChanged || !anyVisibleOpen)) {
      for (const group of visibleGroups) group.open = group === node;
      node.open = true;
    }
  }

  syncStepToggles(marginStep || indexStep);
  if (marginStep) {
    renderMarginPanel();
    ensureMarginFitted();
  }
  if (pageStep) {
    // 从审校视图改过块再回到页面确认：建议与版面状态要重读一次，不用旧缓存。
    if (keyChanged) scheduleLayoutBlocks(true);
    else renderLayoutBlocks();
  }
  if (recognitionStep) renderRecognitionStatus();
}

function renderWorkflowFilter(counts, summary) {
  const select = el("filter-workflow");
  if (!select) return;
  const current = select.value;
  select.innerHTML = "";
  for (const item of injected.WORKFLOW_FILTERS) {
    const option = document.createElement("option");
    option.value = item.value;
    const number =
      item.value === "pending"
        ? injected.getPendingPageCount()
        : item.value === "auto_passed"
        ? injected.getWorkflowConfirmationCounts().auto
        : item.value === "human_confirmed"
        ? injected.getWorkflowConfirmationCounts().human
        : item.value === "failed"
        ? summary.failed
        : item.value === "unfinished"
        ? summary.unfinished
        : item.value === ""
        ? summary.total
        : counts[item.value];
    option.textContent =
      number === undefined || number === null
        ? item.label
        : `${item.label} ${number}`;
    select.append(option);
  }
  select.value = current;
  if (select.value !== current) select.value = "";
}

/**
 * 底栏开关按步显示：版心步只要「版心」，页面确认 / 文字识别只要「块框」。
 *
 * 开关本身按项目记住（`b2t.pagesMargin.v1.*`），但**显示**跟着步骤走：
 * 不是版心步就把压暗关掉，免得把版心框叠在页面确认的网格上（这一步没有这个开关可关）。
 */
function syncStepToggles(marginStep) {
  const button = el("pages-margin-toggle");
  if (!injected.getCurrentProject()) return;
  // 结果预览有自己的版心开关（任务 47）：这里只同步底栏按钮状态，
  // 不按"非版心步就关掉"的规则把用户刚关掉的版心又打开。
  if (injected.getCurrentView() === "preview") {
    if (button) button.classList.toggle("is-on", injected.getPagesMarginOn());
    return;
  }
  // 正文审校是读稿主界面：版心 + 块框默认开着（任务 57），**不按步骤把它们压暗**。
  // 用户自己关掉也尊重——这里只同步底栏按钮状态。
  if (injected.getCurrentView() === "reading") {
    if (button) button.classList.toggle("is-on", injected.getPagesMarginOn());
    return;
  }
  if (marginStep) {
    if (!injected.getPagesMarginOn()) {
      injected.setPagesMarginOn(true);
      if (button) button.classList.add("is-on");
      refreshMarginTiles();
    }
    injected.indexRefresh?.();
    return;
  }
  if (!injected.getPagesMarginOn()) return;
  injected.setPagesMarginOn(false);
  if (button) button.classList.remove("is-on");
  refreshMarginTiles();
  injected.indexRefresh?.();
}

/** 复核任务在跑：在识别步里显示"做到哪、还要多久"。 */
function updateRecognitionAuxProgress(data) {
  const job = data && data.job;
  if (!job || job.job_type !== "auxiliary") return;
  if (!["queued", "running", "paused"].includes(job.status)) return;
  const done = job.done + job.failed;
  const auxNum = el("rec-aux-num");
  if (auxNum) auxNum.textContent = `${done}/${job.total}`;
  const line = el("rec-verdict-line");
  const err = el("rec-status");
  // 有错误提示时不要用进度把它盖掉
  if (line && err && !err.hidden) return;
  if (line) {
    const eta = injected.estimateRemainingSeconds(data);
    line.textContent =
      `第二引擎复核中：${done} / ${job.total} 页` +
      (job.status === "paused" ? "（已暂停）" : eta > 0 ? ` · 还需${injected.formatDuration(eta)}` : "") +
      "。进度也在右侧任务抽屉里。";
  }
}

function applyPageRangeInput() {
  const project = injected.getCurrentProject();
  if (!project) return;
  const { numbers, invalid } = injected.parsePageRange(el("page-range").value);
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

  injected.getSelectedPages().clear();
  for (const pageNo of numbers) injected.getSelectedPages().add(pageNo);
  injected.setSelectionAnchor(numbers.size ? Math.min(...numbers) : null);
  renderPages();
}

function applyPageZoom() {
  const grid = el("page-grid");
  if (!grid) return;
  const level = injected.pageZoomLevel();
  grid.classList.remove("page-grid--cols-3", "page-grid--single", "page-grid--page");
  if (injected.getPageZoomIndex() === 1) grid.classList.add("page-grid--cols-3");
  if (injected.getPageZoomIndex() === 2) grid.classList.add("page-grid--single");
  if (injected.getPageZoomIndex() === 3) grid.classList.add("page-grid--page");

  el("pages-zoom-label").textContent = `${injected.getPageZoomIndex() + 1}/${injected.PAGE_ZOOM_LEVELS.length} · ${level.label}`;
  el("pages-zoom-out").disabled = injected.getPageZoomIndex() === 0;
  el("pages-zoom-in").disabled = injected.getPageZoomIndex() === injected.PAGE_ZOOM_LEVELS.length - 1;
  // 块框四档都可用：网格档只画色框（不画顺序号），单列 / 单页才带顺序号
  el("pages-overlay-toggle").disabled = false;
  el("pages-overlay-toggle").classList.toggle("is-on", injected.getPagesOverlayOn());
  // 版心视图四档都能看；单列 / 单页拖动更顺手
  el("pages-margin-toggle").disabled = false;
  el("pages-margin-toggle").classList.toggle("is-on", injected.getPagesMarginOn());

  const tiles = [...grid.querySelectorAll(".page-tile")];
  const byPage = new Map(injected.getCurrentProject().pages.map((page) => [page.page_no, page]));
  injected.visiblePageNos.clear();
  resetOverlayQueue();

  if (injected.getPageZoomIndex() >= 2) {
    for (const tile of tiles) {
      hidePageBlocks(tile);
      const pageNo = Number(tile.dataset.pageNo);
      const image = tile.querySelector("img");
      if (!image) continue;
      image.loading = "eager";
      image.dataset.largeSrc = injected.pageImageUrl(pageNo, level.image);
      image.removeAttribute("src");
    }
  } else {
    for (const tile of tiles) {
      hidePageBlocks(tile);
      const pageNo = Number(tile.dataset.pageNo);
      const page = byPage.get(pageNo);
      const image = tile.querySelector("img");
      if (!image || !page) continue;
      image.loading = "lazy";
      delete image.dataset.largeSrc;
      // 大网格用 view（150 DPI），网格用 thumb（40 DPI）：别把 40 DPI 的图拉大
      const gridSrc = injected.pageImageUrl(pageNo, level.image);
      if (image.getAttribute("src") !== gridSrc) image.src = gridSrc;
    }
    // 网格 / 大网格档的建议角标仍按"滚动停下再扫"的节奏
    ensureSuggestionScrollListener();
    scheduleSuggestionScan();
  }

  ensurePageScrollListener();
  injected.setPageTileMetrics(null);
  capturePageTileMetrics();
  updatePageVisibility();
}

async function applySetupSuggestion(item, button) {
  if (!injected.getCurrentProject()) return;
  button.disabled = true;
  el("pages-error").hidden = true;
  try {
    await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/${item.page_id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_type: item.suggested_type }),
      }
    );
    // 页类型变了：这一页不再/开始属于"正文页建议范围"，旧建议与角标都要作废
    injected.forgetPageSuggestions(item.page_no);
    await injected.refreshPageStates();
    renderPages();
    await loadSetupSuggestions();
  } catch (error) {
    button.disabled = false;
    injected.showError(el("pages-error"), error);
  }
}

function confirmAllUnconfirmed() {
  if (!injected.getCurrentProject()) return;
  const ids = injected.getCurrentProject().pages
    .filter((page) => !page.page_confirmed)
    .map((page) => page.page_id);
  if (!ids.length) {
    const hint = el("selection-hint");
    hint.textContent = "所有页面都已确认。";
    hint.hidden = false;
    return;
  }
  return confirmPageIds(ids);
}

async function confirmLayoutFromPanel() {
  const page = injected.layoutBlockPageRecord();
  if (!page || !injected.getCurrentProject()) return;
  const button = el("layout-block-confirm");
  button.disabled = true;
  try {
    await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/${page.page_no}/layout/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_numbers: [page.page_no] }),
      }
    );
    await injected.refreshPageStates();
    await loadLayoutBlocks(page.page_no);
    await loadFinishSummary({ silent: true });
    setMarginStatus(`第 ${page.page_no} 页版面已确认。`);
  } catch (error) {
    button.disabled = false;
    injected.showError(el("pages-error"), error);
  }
}

async function confirmPageIds(pageIds) {
  if (!injected.getCurrentProject() || !pageIds.length) return;
  el("pages-error").hidden = true;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_ids: pageIds }),
      }
    );
    for (const updated of data.pages) {
      const index = injected.getCurrentProject().pages.findIndex(
        (page) => page.page_id === updated.page_id
      );
      if (index >= 0) injected.getCurrentProject().pages[index] = updated;
    }
    renderPages();
    injected.renderProjectMeta();
    await loadSetupSuggestions();
  } catch (error) {
    injected.showError(el("pages-error"), error);
  }
}

function confirmSelectedPages() {
  const ids = injected.selectionPages().map((page) => page.page_id);
  if (!ids.length) {
    const hint = el("selection-hint");
    hint.textContent = "先在左边网格里选几页，或点「全书… 确认全部未确认页」。";
    hint.hidden = false;
    return;
  }
  return confirmPageIds(ids);
}

async function recognizeSelection(force = false) {
  const project = injected.getCurrentProject();
  const pages = injected.selectionPages().filter((page) => page.include);
  if (!project || !pages.length) return;

  // 有人工成果的页：先问，再让用户选「跳过」还是「仍要重识别」（后者会先备份整库）
  let targetPages = pages;
  let useForce = force;
  const touched = await injected.humanTouchedPages(project, pages);
  if (touched.length) {
    const remaining = pages.length - touched.length;
    const choice = await injected.confirmAction({
      title: `${touched.length} 页有人工改动`,
      lead:
        remaining > 0
          ? `重识别这 ${touched.length} 页会丢掉你改过的字，跳过则保留。`
          : `这 ${touched.length} 页都有人工改动，跳过则保留。`,
      list: [`那 ${touched.length} 页之后的改动会丢`, "原始输出与缓存不在备份里"],
      detail: injected.RESTORE_DETAIL_TEXT,
      safeText: remaining > 0 ? `跳过并识别剩下的 ${remaining} 页` : "跳过，不识别",
      dangerText: `仍要重识别这 ${touched.length} 页`,
    });
    if (choice === null) return;                 // Esc / 点遮罩：什么都不做
    if (choice === "safe") {
      targetPages = pages.filter((page) => !touched.includes(page.page_no));
      if (!targetPages.length) return;           // 全被跳过：不建任务
    } else {
      useForce = true;                           // 危险键：force=true（后端会先备份）
    }
  }

  if (!injected.warnUnconfirmed(targetPages, "识别所选页")) return;
  if (
    force &&
    !window.confirm(
      `选中的 ${pages.length} 页正文都已识别。重新识别会替换自动结果；` +
        "人工改过的块不会自动覆盖（沿用 R2 规则）。继续吗？"
    )
  ) {
    return;
  }

  el("pages-error").hidden = true;
  const skip = force ? false : el("selection-skip-recognized").checked;
  try {
    const data = await injected.apiJson(`/api/projects/${project.project_id}/jobs/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pages: targetPages.map((page) => page.page_no),
        skip_recognized: skip,
        ...(useForce ? { force: true } : {}),
      }),
    });
    injected.applyRecognizedPages(data.pages);
    renderPages();
    injected.openTaskDrawer();
    injected.startTaskPolling(data.job.job_id);
  } catch (error) {
    injected.showError(el("pages-error"), error);
  }
}

/**
 * 单页「识别」入口（刀 7 从 `app.js` 原样搬入，只改注入形态）。
 *
 * 同族的 `recognizeSelection`（:1917）/ `startBatchRecognition`（:2499）早就在本模块，
 * 形态一致：先清自己的错误条 → POST 建 job → 抽屉 + 轮询。
 * 体内唯一的跨域写点是 `catch` 里的审校面板错误条（`view-review` 的 id）⇒ 那个 id 不进模块，
 * 改走外壳注入的能力（app.js 里"把错误写到审校错误条"的那一个函数）。**必读形态、不带 `?.`**：
 * 写成可选调用会把错误静默吞掉，而 R13 只提示不红。
 */
async function recognizePage(page) {
  const project = injected.getCurrentProject();
  if (!project || injected.busyPages.has(page.page_no)) return;
  if (!injected.warnUnconfirmed([page], `识别第 ${page.page_no} 页`)) return;

  // 这一页有人工成果？先问，再让用户选「跳过」还是「仍要重识别」（后者 force，后端先备份整库）
  let useForce = false;
  const touched = await injected.humanTouchedPages(project, [page]);
  if (touched.length) {
    const choice = await injected.confirmAction({
      title: `第 ${page.page_no} 页有人工改动`,
      lead: "重识别这一页会丢掉你改过的字，跳过则保留。",
      list: ["这一页之后的改动会丢", "原始输出与缓存不在备份里"],
      detail: injected.RESTORE_DETAIL_TEXT,
      safeText: "跳过，不识别这一页",
      dangerText: `仍要重识别第 ${page.page_no} 页`,
    });
    if (choice === null) return;        // Esc / 点遮罩：什么都不做（不建任务）
    if (choice === "safe") return;      // 单页没有"剩下的页"可识别
    useForce = true;
  }

  el("pages-error").hidden = true;
  injected.busyPages.add(page.page_no);
  renderPages();

  try {
    const data = await injected.apiJson(
      `/api/projects/${project.project_id}/jobs/ocr`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 单页"识别"是明确要求认这一页：**不跳过**已识别的页（会走 R2）
        body: JSON.stringify({
          pages: [page.page_no],
          skip_recognized: false,
          ...(useForce ? { force: true } : {}),
        }),
      }
    );
    injected.applyRecognizedPages(data.pages);
    injected.openTaskDrawer();
    injected.startTaskPolling(data.job.job_id);
  } catch (error) {
    // 审校面板开着时错误显示在手边那一块；支路条件沿用 `refreshRecognizedPages` 的同一对 getter。
    if (injected.getDetailPageNo() !== null) injected.showPageDetailError(error);
    else showPagesError(error);          // 模块自己的错误条（刀 6 的既有入口）
  } finally {
    injected.busyPages.delete(page.page_no);
    renderPages();
  }
}

/** 任务 43：离开页面视图时停掉网格里在飞 / 排队的缩略图请求。
 *
 * 394 页的网格一次会排上百个 `size=thumb`；切到审校后它们还在后台渲染，
 * 一次按键要等几秒。图片清掉 src 后浏览器会取消排队中的请求，回来时
 * applyPageZoom() 会重新挂上（只加载视口附近的页）。
 */
function pausePageThumbnails() {
  const grid = el("page-grid");
  if (!grid) return;
  for (const image of grid.querySelectorAll("img[src]")) {
    image.removeAttribute("src");
  }
  injected.visiblePageNos.clear();
}

/**
 * 版心进度位的**归属**：检测与自动拟合共用同一组元素（#margin-fit-progress/-fill/-text）。
 *
 * 为什么需要它：两个写者都在跑时后写者覆盖前者——QA 实测 23 次采样里 15 次是拟合文案，
 * 检测的「完成」文案被下一批拟合盖掉。规则：**检测优先**（拟合照跑，只是不写显示）；
 * 检测收尾那 5 秒里仍归检测，之后按"谁还在跑"交回。
 */
let marginProgressOwner = null; // "detect" | "fit" | null

/** 拟合进度的显示分母（冻结值）：检测期间服务端的 remaining 会一直涨，夹值会让宽度来回跳。 */
let marginFitDisplayTotal = 0;

function showMarginFitProgress(done, total, remaining = 0) {
  const wrap = el("margin-fit-progress");
  if (!wrap) return;
  if (marginProgressOwner === "detect") return; // 检测在写这组元素：拟合照跑，不抢显示
  marginProgressOwner = "fit";
  wrap.hidden = false;
  const percent = total ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0;
  el("margin-fit-fill").style.width = `${percent}%`;
  const tail = remaining > total ? `（还剩 ${remaining} 页待拟合）` : "";
  el("margin-fit-text").textContent =
    done >= total
      ? `自动拟合完成：${total} 页`
      : `正在为 ${total} 页自动拟合版心… ${done} / ${total}${tail}`;
}

function hideMarginFitProgressSoon() {
  window.setTimeout(() => {
    if (marginProgressOwner === "detect") return; // 检测正在用这块位置
    const wrap = el("margin-fit-progress");
    if (wrap && !injected.getMarginFitRunning()) wrap.hidden = true;
  }, 1600);
}

function setRecognitionStatus(text, isError = false) {
  const node = el("rec-status");
  if (!node) return;
  node.textContent = text || "";
  node.hidden = !text;
  node.style.color = isError ? "var(--bad-fg)" : "";
  if (injected.getRecStatusTimer()) clearTimeout(injected.getRecStatusTimer());
  if (text) {
    const __recStatusTimer1 = setTimeout(() => {
      node.hidden = true;
    }, 6000);
    injected.setRecStatusTimer(__recStatusTimer1);
  }
}

/** 改一项识别设置：先写服务端，成功再更新本地；失败回显原值。 */
async function patchRecognitionSetting(key, value) {
  if (!injected.getCurrentProject()) return;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/settings`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      }
    );
    injected.getCurrentProject().settings = data.settings || {
      ...(injected.getCurrentProject().settings || {}),
      [key]: value,
    };
    renderRecognitionSettings();
    setRecognitionStatus("已保存，下一次识别按新设置执行");
  } catch (error) {
    renderRecognitionSettings(); // 回显服务端的真实值
    setRecognitionStatus(error.message || "设置没保存成功", true);
    injected.showError(el("pages-error"), error);
  }
}

function forgetAllPageSuggestions() {
  injected.pageSuggestionCache.clear();
  injected.pageSuggestionOrder.length = 0;
  injected.pageSuggestionFailed.clear();
  for (const tile of document.querySelectorAll("#page-grid .page-tile")) {
    injected.paintTileSuggestionMark(tile, Number(tile.dataset.pageNo));
  }
}

// ---- 建议角标队列（刀 10.2：整条建议队列从外壳搬进模块）----
//
// 搬的是"排队算哪几页"的调度；建议的**数据**（cache / order / failed）与取数仍在外壳——
// 审校详情（app.js 的 :5896 那一支）读同一份缓存，两份状态会比搬错更坏。
const PAGE_SUGGESTION_CONCURRENCY = 2;
const pageSuggestionQueue = [];
const pageSuggestionPending = new Set();
let pageSuggestionActive = 0;
let suggestionScanQueued = 0;
let suggestionScanTimer = null;
let suggestionScrollListening = false;

/** 排队算一页的建议；返回 true 表示这次真的排了新活（用于限量与续扫）。 */
function ensurePageSuggestion(pageNo) {
  const project = injected.getCurrentProject();
  if (!project || project.kind === "package") return false;
  if (
    injected.pageSuggestionCache.has(pageNo) ||
    pageSuggestionPending.has(pageNo) ||
    injected.pageSuggestionFailed.has(pageNo)
  ) {
    return false;
  }
  const page = project.pages.find((item) => item.page_no === pageNo);
  if (!page || !page.include || page.page_type !== "body") return false;
  if (injected.recognitionOf(page).status !== "recognized") return false;
  pageSuggestionPending.add(pageNo);
  pageSuggestionQueue.push(pageNo);
  pumpPageSuggestionQueue();
  return true;
}

function pumpPageSuggestionQueue() {
  // 任务 43：角标建议只有页面视图用得到。审校 / 预览里不再发起新请求——
  // 否则正在审校时后台还在逐页跑 block-suggestions，一次按键要等几秒。
  // 已经在飞的请求（最多 PAGE_SUGGESTION_CONCURRENCY 个）会自己结束；
  // 回到页面视图时由外壳喊 onPagesShown() 把它接上。
  if (injected.getCurrentView() !== "pages") return;
  while (pageSuggestionActive < PAGE_SUGGESTION_CONCURRENCY && pageSuggestionQueue.length) {
    const pageNo = pageSuggestionQueue.shift();
    pageSuggestionActive += 1;
    injected.fetchPageSuggestions(pageNo)
      .catch(() => {
        // 建议是辅助信息：读不到就不标，不打断翻页；本次会话不再反复重试这一页
        injected.pageSuggestionFailed.add(pageNo);
      })
      .finally(() => {
        pageSuggestionActive -= 1;
        pageSuggestionPending.delete(pageNo);
        // 收尾闭环（三条件逐字保留）：这一轮排过队、可能还有可见页没轮到（一次最多 12 页）⇒ 再扫一轮
        if (pageSuggestionActive === 0 && !pageSuggestionQueue.length) {
          if (suggestionScanQueued > 0) {
            suggestionScanQueued = 0;
            scheduleSuggestionScan();
          }
        }
        pumpPageSuggestionQueue();
      });
  }
}

/**
 * 网格档滚动时不必每帧算 267 个矩形：停下来 60ms 后扫一次可见页。
 *
 * 原来是 140ms：滚动停下到角标出现之间有肉眼可见的空档；改成 60ms，
 * 仍只扫一次（不是每帧），267 个瓷砖的位置也走 pageTileMetrics 缓存。
 */
function scheduleSuggestionScan() {
  if (suggestionScanTimer) clearTimeout(suggestionScanTimer);
  suggestionScanTimer = setTimeout(scanVisiblePageSuggestions, 60);
}

function ensureSuggestionScrollListener() {
  if (suggestionScrollListening) return;
  const scroller = el("page-grid")?.closest(".split__main");
  (scroller || window).addEventListener("scroll", scheduleSuggestionScan, {
    passive: true,
  });
  window.addEventListener("resize", scheduleSuggestionScan);
  suggestionScrollListening = true;
}

function scanVisiblePageSuggestions() {
  suggestionScanTimer = null;
  if (!injected.getCurrentProject() || injected.getCurrentView() !== "pages" || injected.getPageZoomIndex() >= 2) return;
  const grid = el("page-grid");
  if (!grid) return;
  const scroller = pageScroller();
  const metrics =
    scroller && injected.getPageTileMetrics() && injected.getPageTileMetrics().length === grid.querySelectorAll(".page-tile").length
      ? injected.getPageTileMetrics()
      : null;
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const viewport = scroller ? scroller.clientHeight : window.innerHeight;
  /**
   * 一页的竖直范围（相对视口）。有缓存的位置就用缓存：
   * 滚动停止时不必为 267 个瓷砖各做一次 getBoundingClientRect。
   */
  const byTile = metrics ? new Map(metrics.map((entry) => [entry.tile, entry])) : null;
  const boundsOf = (tile) => {
    const item = byTile ? byTile.get(tile) : null;
    if (!item) {
      if (byTile) return null;
      const rect = tile.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
    return { top: item.top - scrollTop, bottom: item.top - scrollTop + item.height };
  };
  let budget = 12; // 一次最多算 12 页；还有没轮到的，队列空后会自动再扫一轮
  for (const tile of grid.querySelectorAll(".page-tile")) {
    if (budget <= 0) break;
    const bounds = boundsOf(tile);
    if (!bounds) continue;
    if (bounds.bottom < -120 || bounds.top > viewport + 120) continue;
    // 算过 / 排队中的页不占名额，否则上面几屏的缓存会把下面的可见页永远饿死
    if (ensurePageSuggestion(Number(tile.dataset.pageNo))) {
      budget -= 1;
      suggestionScanQueued += 1;
    }
  }
}

function visiblePages() {
  const project = injected.getCurrentProject();
  if (!project) return [];
  const typeFilter = el("filter-type").value;
  const recognitionFilter = el("filter-recognition").value;
  const workflowFilter = el("filter-workflow").value;
  const triageFilter = el("filter-triage").value;
  const onlyIncluded = el("pages-only-included").checked;

  return project.pages.filter((page) => {
    if (onlyIncluded && !page.include) return false;
    if (typeFilter && page.page_type !== typeFilter) return false;
    const recognition = injected.recognitionOf(page);
    if (recognitionFilter && recognition.status !== recognitionFilter) return false;
    if (workflowFilter && !injected.matchesWorkflow(page, workflowFilter)) return false;
    if (triageFilter && !injected.matchesTriage(page, recognition, triageFilter)) return false;
    return true;
  });
}

/** 右栏手风琴：一次只开一个；折叠状态按项目记，默认落在第一个未完成的分区。 */
function initPanelAccordion() {
  if (!injected.getCurrentProject()) return;
  const groups = [...document.querySelectorAll("#setup-panel details[data-panel]")];
  if (!groups.length) return;
  const key = `b2t.panel.accordion.v1.${injected.getCurrentProject().project_id}`;
  if (injected.getPanelAccordionProject() !== injected.getCurrentProject().project_id) {
    injected.setPanelAccordionProject(injected.getCurrentProject().project_id);
    let saved = null;
    try {
      saved = localStorage.getItem(key);
    } catch {
      saved = null;
    }
    const open = groups.find((group) => group.dataset.panel === saved) ||
      groups.find((group) => group.dataset.panel === injected.firstUnfinishedPanel()) ||
      groups[0];
    for (const group of groups) group.open = group === open;
  }
  for (const group of groups) {
    if (group.dataset.accordionBound === "1") continue;
    group.dataset.accordionBound = "1";
    group.addEventListener("toggle", () => {
      if (!group.open) return;
      for (const other of groups) {
        if (other !== group) other.open = false;
      }
      try {
        localStorage.setItem(key, group.dataset.panel);
      } catch {
        // 存不了就只在本次会话里记住；不影响功能。
      }
    });
  }
}

/** 打开确认界面：先回数据库拉一次页面，保证看到的进度不是前端缓存。 */
async function openPageSetup({ auto = false } = {}) {
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") return;
  injected.showView("pages");
  await injected.refreshPageStates();
  renderPages();
  await loadSetupSuggestions();
  if (auto) {
    el("setup-panel").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/**
 * 丢掉一页的块缓存（识别刚完成、重新识别、块被换掉之后用）。
 *
 * 同时把这一页的"作废代次" +1：没有它，一个早发晚到的旧响应会在作废之后
 * 又把旧块写回缓存，用户就得等下一次刷新才能看到新的框。
 * 这一页的块类型建议也一起丢掉——块都变了，建议得重算。
 */
function forgetAllPageBlocks() {
  injected.getPageBlockCache().clear();
  injected.pageBlockCacheOrder.length = 0;
  for (const tile of document.querySelectorAll("#page-grid .page-tile")) {
    hidePageBlocks(tile);
  }
}

function pageScroller() {
  return el("page-grid")?.closest(".split__main") || null;
}

function capturePageTileMetrics() {
  const scroller = pageScroller();
  const grid = el("page-grid");
  if (!scroller || !grid) {
    injected.setPageTileMetrics(null);
    return;
  }
  const tiles = [...grid.querySelectorAll(".page-tile")];
  if (!tiles.length) {
    injected.setPageTileMetrics(null);
    return;
  }
  // 页面视图还没显示时（打开项目、从审校切过来之前）所有矩形都是 0：
  // 那样量出来的"每一页都在视口里"会让 267 页同时排队请求块数据，
  // 框画出来又被下一帧当成离屏清掉——用户看到的就是"块框迟迟不出来"。
  // 宁可不记，等视图可见后的下一次可见性计算再量（见 updatePageVisibility）。
  if (tiles[0].getBoundingClientRect().height <= 0) {
    injected.setPageTileMetrics(null);
    return;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  const scrollTop = scroller.scrollTop;
  const __pageTileMetrics1 = tiles.map((tile) => {
    const rect = tile.getBoundingClientRect();
    return {
      tile,
      pageNo: Number(tile.dataset.pageNo),
      top: rect.top - scrollerRect.top + scrollTop,
      height: rect.height,
    };
  });
  injected.setPageTileMetrics(__pageTileMetrics1);
}

function togglePageBlocksOverlay() {
  injected.setPagesOverlayOn(!injected.getPagesOverlayOn());
  injected.savePageOverlayPreference();
  el("pages-overlay-toggle").classList.toggle("is-on", injected.getPagesOverlayOn());
  if (injected.getPagesOverlayOn()) {
    for (const pageNo of injected.visiblePageNos) queueOverlayRender(pageNo);
    schedulePageVisibility();
  } else {
    resetOverlayQueue();
    for (const tile of el("page-grid").querySelectorAll(".page-tile")) {
      hidePageBlocks(tile);
    }
  }
  injected.indexRefresh?.();
}

/** 排队画一页的块框：已画过且缓存没变就跳过。 */
function queueOverlayRender(pageNo) {
  if (!injected.getCurrentProject() || !injected.getPagesOverlayOn() || !injected.visiblePageNos.has(pageNo)) return;
  // 没有缓存也要排队：泵负责去取（原来那个"没缓存就返回"会把预取整条路掐断）
  if (overlayRenderQueued.has(pageNo)) return;
  overlayRenderQueued.add(pageNo);
  overlayRenderQueue.push(pageNo);
  scheduleOverlayPump();
}

/** 滚动下一帧画块框（同一帧内多次排队只排一次）。 */
function scheduleOverlayPump() {
  if (overlayPumpScheduled) return;
  overlayPumpScheduled = true;
  requestAnimationFrame(pumpOverlayRender);
}

/**
 * 每帧最多真正画 3 页：网格档一屏可能有十几页、每页几十个块，
 * 一次全画会卡；按页缓存 + 在途请求上限 3，滚过去的页立刻清。
 */
function pumpOverlayRender() {
  overlayPumpScheduled = false;
  if (!injected.getCurrentProject() || !injected.getPagesOverlayOn()) return;
  let drawn = 0;
  let waiting = false;
  while (drawn < PAGE_OVERLAY_FRAME_LIMIT && overlayRenderQueue.length) {
    const pageNo = overlayRenderQueue.shift();
    overlayRenderQueued.delete(pageNo);
    if (!injected.visiblePageNos.has(pageNo)) continue;
    const tile = el("page-grid").querySelector(`.page-tile[data-page-no="${pageNo}"]`);
    if (!tile) continue;
    const key = injected.pageBlockKey(pageNo);
    const blocks = injected.getPageBlockCache().get(key);
    if (blocks) {
      paintPageBlocks(tile, blocks);
      drawn += 1;
      continue;
    }
    if (injected.pageBlockPending.has(key)) continue;
    if (injected.pageBlockPending.size >= PAGE_BLOCK_FETCH_LIMIT) {
      // 在途请求满了：放回队尾，等某个请求完成后再继续（不空转）
      overlayRenderQueue.push(pageNo);
      overlayRenderQueued.add(pageNo);
      waiting = true;
      break;
    }
    fetchPageBlocks(pageNo, key);
  }
  if (overlayRenderQueue.length && !waiting) scheduleOverlayPump();
}

/**
 * 拉一页的块数据（刀 10a 从外壳搬入）。
 *
 * 两层防错缺一不可：在途去重（`pageBlockPending`）挡住重复请求；
 * 作废代次（壳里的 `pageBlockVersions`）挡住"早发晚到"的旧响应——
 * 少了代次校验，识别刚完成时一个早发的空结果会盖掉新块。
 */
function fetchPageBlocks(pageNo, key, { prefetch = false } = {}) {
  injected.pageBlockPending.add(key);
  if (prefetch) pageBlockPrefetchInFlight += 1;
  const version = injected.getPageBlockVersions().get(key) || 0;
  injected.apiJson(`/api/projects/${injected.getCurrentProject().project_id}/pages/${pageNo}/blocks`)
    .then((data) => {
      // 请求在途期间这一页被作废了（识别刚完成、重新识别）：结果是旧的，丢掉重拉
      if ((injected.getPageBlockVersions().get(key) || 0) !== version) {
        if (injected.getPagesOverlayOn() && injected.visiblePageNos.has(pageNo)) queueOverlayRender(pageNo);
        return;
      }
      injected.rememberPageBlocks(key, data.blocks || []);
      if (injected.getPagesOverlayOn() && injected.visiblePageNos.has(pageNo)) queueOverlayRender(pageNo);
    })
    .catch(() => {
      // 块框是辅助信息，读不到不该打断翻页
    })
    .finally(() => {
      injected.pageBlockPending.delete(key);
      if (prefetch) pageBlockPrefetchInFlight = Math.max(0, pageBlockPrefetchInFlight - 1);
      if (injected.getPagesOverlayOn()) scheduleOverlayPump();
    });
}

/**
 * 滚动中提前拉块数据（刀 10a 从外壳搬入）：只挑**已识别**的页，按离视口由近到远，
 * 一次最多排 PAGE_BLOCK_PREFETCH_BURST 页；视口内的页优先（distance = 0）。
 */
function pumpPageBlockPrefetch(candidates) {
  if (!injected.getCurrentProject() || injected.getCurrentView() !== "pages" || !injected.getPagesOverlayOn() || !candidates.length) return;
  if (injected.pageBlockPending.size >= PAGE_BLOCK_FETCH_LIMIT) return;
  if (pageBlockPrefetchInFlight >= PAGE_BLOCK_PREFETCH_LIMIT) return;
  candidates.sort((a, b) => a.distance - b.distance);
  let byPage = null;
  let started = 0;
  for (const candidate of candidates) {
    if (started >= PAGE_BLOCK_PREFETCH_BURST) break;
    if (pageBlockPrefetchInFlight >= PAGE_BLOCK_PREFETCH_LIMIT) break;
    if (injected.pageBlockPending.size >= PAGE_BLOCK_FETCH_LIMIT) break;
    const key = injected.pageBlockKey(candidate.pageNo);
    if (injected.getPageBlockCache().has(key) || injected.pageBlockPending.has(key)) continue;
    if (!byPage) byPage = new Map(injected.getCurrentProject().pages.map((page) => [page.page_no, page]));
    const page = byPage.get(candidate.pageNo);
    // 没识别过的页没有块：不为它们发请求，否则掠过整本书就是一串空响应
    if (!page || injected.recognitionOf(page).status !== "recognized") continue;
    started += 1;
    fetchPageBlocks(candidate.pageNo, key, { prefetch: true });
  }
}

function toggleMarginView() {
  injected.setPagesMarginOn(!injected.getPagesMarginOn());
  injected.savePageMarginPreference();
  const button = el("pages-margin-toggle");
  if (button) button.classList.toggle("is-on", injected.getPagesMarginOn());
  if (!injected.getCurrentProject()) return;
  if (injected.getPagesMarginOn()) {
    schedulePageVisibility();
  } else {
    for (const tile of document.querySelectorAll("#page-grid .page-tile")) {
      injected.clearTileMargin(tile);
    }
  }
  injected.indexRefresh?.();
  renderMarginPanel();
}

function setMarginStatus(text, isError = false, holdMs = 9000) {
  const node = el("margin-status");
  if (!node) return;
  node.textContent = text || "";
  node.hidden = !text;
  node.style.color = isError ? "var(--bad-fg)" : "";
  if (injected.getMarginStatusTimer()) clearTimeout(injected.getMarginStatusTimer());
  if (text) {
    const __marginStatusTimer1 = setTimeout(() => {
      node.hidden = true;
    }, holdMs);
    injected.setMarginStatusTimer(__marginStatusTimer1);
  }
}

async function ensureMarginAudit(page) {
  const node = el("margin-audit");
  if (!node || !injected.getCurrentProject() || !page) return;
  if (injected.getMarginAuditPage() === page.page_no && !injected.getMarginAuditLoading()) return;
  injected.setMarginAuditPage(page.page_no);
  injected.setMarginAuditLoading(true);
  node.hidden = true;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/${page.page_no}/margin-box/audit`
    );
    if (injected.getMarginAuditPage() !== page.page_no) return;
    const basis = el("margin-basis");
    const linesWord = data.lines_source === "layout" ? "检测行" : "识别行";
    if (basis && page.margin_box_mode === "auto") {
      const total = Number(data.total_lines || 0);
      const method = injected.pageMarginMethod(page);
      if (method === "undetermined") {
        basis.textContent = injected.marginBasisForUndetermined(page);
      } else if (method === "bbox") {
        basis.textContent =
          `来源：本页所有${linesWord}的包围盒（兜底） · ${total} 条正文长行`;
      } else {
        basis.textContent =
          `来源：本页${linesWord}自动拟合 · 把握：${total >= 10 ? "较稳" : total >= 3 ? "偏少" : "不足"}` +
          `（${total} 条正文长行）`;
      }
    }
    const rescued = Number(data.rescued || 0);
    const outside = Number(data.outside || 0);
    if (rescued > 0) {
      node.textContent =
        `这页有 ${rescued} 块文字在版心框外（标题 / 章首等），已按"文字列里的字不删"保留；` +
        "导出不会少，值得看一眼。";
      node.hidden = false;
    } else if (outside > 0) {
      node.textContent =
        `这页有 ${outside} 行正文落在本页版心之外，可能拟合不准；` +
        "拖动版心核对一下。";
      node.hidden = false;
    } else {
      node.hidden = true;
    }
  } catch {
    node.hidden = true;
  } finally {
    injected.setMarginAuditLoading(false);
  }
}

/** 第二引擎复核全书：只跑还没复核过的已识别正文页。 */
async function startAuxiliaryAll() {
  if (!injected.getCurrentProject()) return;
  const status = el("rec-status");
  if (status) status.hidden = true;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/jobs/auxiliary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "unchecked", skip_checked: true }),
      }
    );
    injected.openTaskDrawer();
    injected.startTaskPolling(data.job.job_id);
  } catch (error) {
    // 第二引擎不可用时必须当面说清（说明书 8.6：不假装还在比对）
    if (status) {
      status.textContent = `第二引擎没能开始：${error.message || "未知错误"}`;
      status.style.color = "var(--bad-fg)";
      status.hidden = false;
    }
  }
}

/**
 * 重置为「本页自动」：先 PATCH 回 auto（丢掉自定义），再按检测行拟合。
 * 只处理 auto / inherit / custom 的页；不适用不动。
 */
async function resetMarginsToAuto(pages) {
  const targets = (pages || []).filter(
    (page) => page.margin_box_mode !== "none" && page.margin_box_mode !== undefined
  );
  if (!injected.getCurrentProject() || !targets.length) return;
  for (const page of targets) {
    injected.marginUndoStack.push({
      pageNo: page.page_no,
      mode: page.margin_box_mode,
      box: page.margin_box ? [...page.margin_box] : null,
    });
  }
  trimMarginUndo();
  try {
    if (targets.length === 1) {
      const page = targets[0];
      await injected.apiJson(
        `/api/projects/${injected.getCurrentProject().project_id}/pages/${page.page_no}/margin-box`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ margin_box_mode: "auto", margin_box: null }),
        }
      );
      const fitted = await injected.apiJson(
        `/api/projects/${injected.getCurrentProject().project_id}/pages/${page.page_no}/margin-box/fit`,
        { method: "POST" }
      );
      await injected.refreshPageStates();
      refreshMarginTiles();
      renderMarginPanel();
      setMarginStatus(
        fitted.undetermined
          ? `第 ${page.page_no} 页还没有检测行，版心暂时未定。`
          : `第 ${page.page_no} 页已按检测行重新拟合。`
      );
      return;
    }
    await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/margin-box/pages`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page_nos: targets.map((page) => page.page_no),
          margin_box_mode: "auto",
          margin_box: null,
        }),
      }
    );
    const fit = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/margin-box/fit-all`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ only_missing: true }),
      }
    );
    for (const page of targets) injected.marginFitTried.delete(page.page_no);
    await injected.refreshPageStates();
    refreshMarginTiles();
    renderMarginPanel();
    setMarginStatus(
      `已把 ${targets.length} 页改回自动拟合：${fit.fitted || 0} 页拟合，` +
        `${fit.fallback || 0} 页兜底，${fit.undetermined || 0} 页还没有检测行。`
    );
  } catch (error) {
    injected.showError(el("pages-error"), error);
  }
}

function setPageNumberStatus(text, isError = false) {
  const node = el("page-number-status");
  if (!node) return;
  node.textContent = text || "";
  node.hidden = !text;
  node.style.color = isError ? "var(--bad-fg)" : "";
  if (injected.getPageNumberStatusTimer()) clearTimeout(injected.getPageNumberStatusTimer());
  if (text) {
    const __pageNumberStatusTimer1 = setTimeout(() => {
      node.hidden = true;
    }, 9000);
    injected.setPageNumberStatusTimer(__pageNumberStatusTimer1);
  }
}

async function startBatchRecognition(scope) {
  const project = injected.getCurrentProject();
  if (!project) return;
  if (injected.getJobStartPending()) return;      // 连点/双击不会建第二个 job
  injected.setJobStartPending(true);
  injected.setJobStartBusy(true);
  const pending = project.pages.filter(
    (page) => page.include && injected.recognitionOf(page).status !== "recognized"
  );
  if (!injected.warnUnconfirmed(pending, "识别全部未识别页")) return;
  el("pages-error").hidden = true;
  try {
    const data = await injected.apiJson(`/api/projects/${project.project_id}/jobs/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    injected.applyRecognizedPages(data.pages);
    renderPages();
    injected.openTaskDrawer();
    injected.startTaskPolling(data.job.job_id);
  } catch (error) {
    injected.showError(el("pages-error"), error);
  } finally {
    injected.setJobStartPending(false);
    injected.setJobStartBusy(false);          // 成功 / 失败 / 异常都恢复，不卡在 disabled
  }
}

/**
 * 第二引擎复核（说明书 8.5）：批量跑成后台任务，与识别共用任务抽屉。
 *
 * 与识别不同的两处都在提示里说清：**只有已识别的页**能复核（第二引擎读的是
 * 第一引擎切出的行图），且默认跳过已复核的页。
 */
async function checkSelection(scope) {
  const project = injected.getCurrentProject();
  if (!project) return;
  if (injected.getJobStartPending()) return;
  injected.setJobStartPending(true);
  injected.setJobStartBusy(true);
  el("pages-error").hidden = true;

  let body;
  if (scope) {
    // 全部已识别但还没复核过的页（说明书 8.5：可以随时补跑）
    body = { scope };
  } else {
    const pages = injected.selectionPages().filter((page) => page.include);
    if (!pages.length) return;
    body = {
      pages: pages.map((page) => page.page_no),
      skip_checked: el("selection-skip-checked").checked,
    };
  }
  try {
    const data = await injected.apiJson(`/api/projects/${project.project_id}/jobs/auxiliary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    injected.applyRecognizedPages(data.pages);
    renderPages();
    injected.openTaskDrawer();
    injected.startTaskPolling(data.job.job_id);
  } catch (error) {
    injected.showError(el("pages-error"), error);
  } finally {
    injected.setJobStartPending(false);
    injected.setJobStartBusy(false);
  }
}

/** 版面检测入口：建任务 → 抽屉 + 轮询（任务 58）。 */
async function startLayoutDetection({ pages = null, scope = null, prepare = false }) {
  if (!injected.getCurrentProject()) return;
  el("pages-error").hidden = true;
  const body = pages
    ? { pages, skip_detected: false, prepare }
    : { scope: scope || "body", prepare };
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/jobs/layout`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    injected.renderTask(data);
    injected.openTaskDrawer();
    injected.startTaskPolling(data.job.job_id);
    return data;
  } catch (error) {
    injected.showError(el("pages-error"), error);
    return null;
  }
}

/** 进度条唯一的写入口：数值先用安全值收一次（0 ≤ done ≤ total，percent 0–100）。 */
function safeDetectCounts(done, total) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeDone = Math.min(safeTotal, Math.max(0, Number(done) || 0));
  return { done: safeDone, total: safeTotal, percent: safeTotal ? Math.min(100, Math.round((safeDone / safeTotal) * 100)) : 0 };
}

function showMarginDetectProgress(done, total) {
  const wrap = el("margin-fit-progress");
  if (!wrap) return;
  wrap.hidden = false;
  const safe = safeDetectCounts(done, total);
  el("margin-fit-fill").style.width = `${safe.percent}%`;
  el("margin-fit-text").textContent = `正在检测版面… ${safe.done} / ${safe.total} 页`;
}

/** 检测结束时进度条停在真实进度上，过一会儿收起来（别留在界面上像个假进度）。 */
function finishMarginDetectBar(done, total) {
  marginProgressOwner = "detect"; // 四条收尾分支都走这里：先占住，5 秒后再交回
  const wrap = el("margin-fit-progress");
  if (!wrap) return;
  // 同族兜底：收尾这条也吃同一份安全值（否则 5 / undefined、150% 一样会出现）
  const safe = safeDetectCounts(done, total);
  el("margin-fit-fill").style.width = `${safe.percent}%`;
  el("margin-fit-text").textContent = `检测：${safe.done} / ${safe.total} 页`;
  window.setTimeout(() => {
    // 5 秒窗口留给检测的收尾文案（J6）；之后再按"谁还在跑"把这组元素交回去
    marginProgressOwner = injected.getMarginFitRunning() ? "fit" : null;
    const node = el("margin-fit-progress");
    if (node && !injected.getMarginFitRunning()) node.hidden = true;
  }, 5000);
}

/** 批量改页面的类型（说明书 6.2 的批量操作，第 11 节的 PATCH /pages）。 */
async function patchSelectedPages(patch) {
  const project = injected.getCurrentProject();
  const pages = injected.selectionPages();
  if (!project || !pages.length || !("page_type" in patch)) return;

  el("pages-error").hidden = true;
  try {
    const data = await injected.apiJson(`/api/projects/${project.project_id}/pages`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_ids: pages.map((page) => page.page_id), ...patch }),
    });
    for (const updated of data.pages) {
      const index = project.pages.findIndex((page) => page.page_id === updated.page_id);
      if (index >= 0) project.pages[index] = updated;
    }
    // 类型变了，建议范围跟着变：这些页的旧建议与角标作废
    for (const updated of data.pages) injected.forgetPageSuggestions(updated.page_no);
    renderPages();
    injected.renderProjectMeta();
    await loadSetupSuggestions();
  } catch (error) {
    injected.showError(el("pages-error"), error);
  }
}

async function setAutoApplySetting(on) {
  if (!injected.getCurrentProject()) return;
  const checkbox = el("auto-apply-suggestions");
  if (on) {
    const ok = window.confirm(
      "打开后，「之后完成」的识别任务会自动把「把握较大」的页眉 / 页脚 / 页码建议用上" +
        "（只动 high：页码形态、跨页重复 ≥ 3 次的书眉页脚；标题与「需确认」不动）。\n\n" +
        "每次自动应用都会在顶部提示，可一键整批撤销。现在打开吗？"
    );
    if (!ok) {
      checkbox.checked = false;
      return;
    }
  }
  try {
    const data = await injected.apiJson(`/api/projects/${injected.getCurrentProject().project_id}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_apply_high_suggestions: Boolean(on) }),
    });
    injected.getCurrentProject().settings = data.settings;
    injected.applyProjectSettings();
    injected.notifyApplied(
      on
        ? "已打开：之后完成的识别任务会自动应用高把握建议（顶部有提示，可撤销）。"
        : "已关闭：识别完成后只给建议，不改块类型。"
    );
  } catch (error) {
    checkbox.checked = !on;
    injected.showError(el("selection-hint"), error);
  }
}

async function rerunAuxiliary() {
  if (!injected.getCurrentProject()) return;
  const ok = window.confirm(
    "用 Apple Vision 重跑第二引擎？\n\n" +
      "· 会先自动备份项目数据库\n" +
      "· 只覆盖第二引擎结果与差异状态；正文、块、版心、块类型不动\n" +
      "· 已裁决（保留/采用）的行会跳过\n" +
      "· 按页判定语言（中文页 zh-Hans / 英文页 en-US）\n\n" +
      "490 页大约 20–25 分钟，可以暂停 / 继续。"
  );
  if (!ok) return;
  try {
    const data = await injected.apiJson(`/api/projects/${injected.getCurrentProject().project_id}/aux/rerun`, {
      method: "POST",
    });
    injected.libraryNotify?.({ kind: "warning", text: String(`已建复核任务（Vision · 按页语言）。备份：${data.backup_path}`).trim() });
    await injected.loadTasks();
  } catch (error) {
    injected.showError(el("pages-error"), error);
  }
}

/**
 * 刀 6：页面工具栏两个开关（版心 / 块框）的 `is-on` 同步。
 *
 * 原来四个视图模块各自拿注入回来的 `getPagesMarginToggle()` 去 `classList.add("is-on")`——
 * 页面子树的 id 从四个模块的依赖里漏回 app.js（R3 8 处）。现在收成本模块一个入口：
 * 四个模块经注入的能力调 `injected.syncToolbarToggles?.()`（app.js 在四个 init 里各给一行
 * `syncToolbarToggles: () => window.PagesView.syncToolbarToggles()`——R2 不许模块直接引用
 * 别的视图接口），模块按注入的开关状态刷这两个按钮。
 *
 * 调用者：reading-view / index-view / preview-view / library-view；四处都在 `PagesView.init` 之后执行。
 */
function syncToolbarToggles() {
  const margin = el("pages-margin-toggle");
  if (margin) margin.classList.toggle("is-on", Boolean(injected.getPagesMarginOn()));
  const overlay = el("pages-overlay-toggle");
  if (overlay) overlay.classList.toggle("is-on", Boolean(injected.getPagesOverlayOn()));
}

/** 刀 6：把错误显示到页面视图的 `#pages-error`（原 `showError(el("pages-error"), error)`）。 */
function showPagesError(error) {
  injected.showError(el("pages-error"), error);
}

/** 刀 6：读 `#pages-error` 当前文本（版心检测对话框拿它做失败原因的兜底）。 */
function pagesErrorMessage() {
  const node = el("pages-error");
  return (node && node.textContent) || "";
}

/** 刀 6：写导出面板里「按版心判定正文」那个 checkbox 的勾选态。 */
function setMarginJudgementCheckbox(on) {
  const node = el("rec-margin-judgement");
  if (node) node.checked = Boolean(on);
}

/**
 * 刀 8：包模式（`applyPackageMode`）里"页面视图自己的入口"该藏还是该露。
 *
 * 那 10 个 id 都属 `view-pages`，但决定它们显隐的是外壳的**跨域编排**（任务包 vs 普通项目）。
 * 所以外壳留着判断，只把"写哪些 id、怎么写"这一层收进来——
 * 一个能力写它那个域里的多个 id 是允许的（同 `syncToolbarToggles`），不是把 id 豁免换成字符串豁免。
 */
function setPackageModeChrome(on) {
  const hidden = Boolean(on);
  el("selection-actionbar").hidden = hidden;
  el("selection-check").hidden = hidden;
  el("check-pending").hidden = hidden;
  const skip = el("selection-skip-checked");
  if (skip && skip.parentElement) skip.parentElement.hidden = hidden;
  el("setup-panel").hidden = hidden;
  el("panel-recognition-settings").hidden = hidden;
  el("panel-pagenum-settings").hidden = hidden;
  el("page-setup-bar").hidden = hidden;
  el("assign-list-toggle").hidden = hidden;
  el("assign-open").hidden = hidden;
}

/**
 * 刀 8：项目设置落在 pages 面板上的两个勾选态（`applyProjectSettings` 调用）。
 *
 * 传进来的两个值由外壳算好（`auto_apply_high_suggestions` 的真值规则、`marginJudgementOn()`
 * 的"未设置即默认开"），模块不复制那两条规则——复制就是第二个真源。
 */
function syncProjectSettings(settings) {
  const values = settings || {};
  el("auto-apply-suggestions").checked = Boolean(values.autoApply);
  const recMargin = el("rec-margin-judgement");
  if (recMargin) recMargin.checked = Boolean(values.marginJudgement);
}

/** 刀 8：拆分批量应用后的选中提示（`applySplitBatch` 调用）。文案由外壳拼，模块只负责写。 */
function setSelectionHint(text) {
  const hint = el("selection-hint");
  if (!hint) return;
  hint.hidden = false;
  hint.textContent = String(text);
}

// 刀 9.2：外壳只知道"任务在跑 / 刚结束"，pages 里要重画什么由模块自己决定。
// 两个进度函数各自按 job_type 早返回（margin 只认 layout、aux 只认 auxiliary），所以两行都调、不分派。
function onTaskProgress(data) {
  updateMarginDetectProgress(data);
  updateRecognitionAuxProgress(data);
}

// 两处调用只差这个参数：收尾重画不重载审校详情页，运行中按默认值。
async function onRecognitionFinished(pageNos, { reloadDetail = true } = {}) {
  await refreshRecognizedPages(pageNos, { reloadDetail });
}

// ---------------------------------------------------------------- 刀 9.3：版心一族（从外壳搬入）

/** 主按钮「全部确认」：把有行、还没框的页一次生成完，并报耗时。 */
async function confirmAllMargins() {
  if (!injected.getCurrentProject() || injected.getMarginFitRunning()) return;
  await ensureMarginFitted({ manual: true });
}

/** 版面块面板的调度：先记「正在看哪一页」，再决定重画还是重新拉。 */
function scheduleLayoutBlocks(force = false) {
  const page = injected.layoutBlockPageRecord();
  if (!page) {
    injected.setLayoutBlockPage(null);
    injected.setLayoutBlockPayload(null);
    renderLayoutBlocks();
    return;
  }
  if (!force && injected.getLayoutBlockPage() === page.page_no && injected.getLayoutBlockPayload()) {
    renderLayoutBlocks();
    return;
  }
  loadLayoutBlocks(page.page_no);
}

// ---- 版心拖拽（整簇）：入口监听改成 #page-grid 上的 pointerdown 委托，见 wirePagesPageGrid ----
/** 拖动版心边时离文字行边界多近就吸附（像素，与块框同一口径）。 */
const MARGIN_SNAP_PX = 8;
/** 版心最短边（归一化）：再小就没有"正文区"的意义了。 */
const MIN_MARGIN_SIDE = 0.02;

let tileMarginDrag = null;

function pageLineEdges(pageNo) {
  const blocks = injected.getPageBlockCache().get(injected.pageBlockKey(pageNo)) || [];
  const xs = [];
  const ys = [];
  for (const block of blocks) {
    for (const line of block.lines || []) {
      if (!line.bbox) continue;
      xs.push(line.bbox[0], line.bbox[2]);
      ys.push(line.bbox[1], line.bbox[3]);
    }
  }
  return { xs, ys };
}

function clampMarginBox(raw) {
  let [x0, y0, x1, y1] = raw;
  x0 = Math.min(Math.max(x0, 0), 1 - MIN_MARGIN_SIDE);
  y0 = Math.min(Math.max(y0, 0), 1 - MIN_MARGIN_SIDE);
  x1 = Math.min(1, Math.max(x1, x0 + MIN_MARGIN_SIDE));
  y1 = Math.min(1, Math.max(y1, y0 + MIN_MARGIN_SIDE));
  return [x0, y0, x1, y1];
}

/**
 * 拖版心时吸附到正文行边界。每条被拖的边单独吸（与块框的 `snapBox` 同一规则），
 * 先把边吸到行边界、再夹回页面内、最后保证最短边。
 */
function snapMarginBox(raw, mode) {
  const edges = tileMarginDrag ? pageLineEdges(tileMarginDrag.pageNo) : { xs: [], ys: [] };
  const rect = tileMarginDrag ? tileMarginDrag.rect : null;
  let [x0, y0, x1, y1] = raw;
  if (rect && rect.width && rect.height && (edges.xs.length || edges.ys.length)) {
    const toleranceX = MARGIN_SNAP_PX / rect.width;
    const toleranceY = MARGIN_SNAP_PX / rect.height;
    if (mode.includes("w")) x0 = injected.nearestEdge(x0, edges.xs, toleranceX);
    if (mode.includes("e")) x1 = injected.nearestEdge(x1, edges.xs, toleranceX);
    if (mode.includes("n")) y0 = injected.nearestEdge(y0, edges.ys, toleranceY);
    if (mode.includes("s")) y1 = injected.nearestEdge(y1, edges.ys, toleranceY);
  }
  return clampMarginBox([x0, y0, x1, y1]);
}

function startTileMarginDrag(event, pageNo, boxEl, mode) {
  if (!injected.getPagesMarginOn() || !injected.getCurrentProject()) return;
  if (event.button !== undefined && event.button !== 0) return;
  const project = injected.getCurrentProject();
  const page = project.pages.find((item) => item.page_no === pageNo);
  const box = page ? injected.marginBoxOfPage(page) : null;
  const thumb = boxEl ? boxEl.closest(".page-tile__thumb") : null;
  if (!page || !box || !thumb) return;
  const rect = thumb.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  event.preventDefault();
  event.stopPropagation();
  tileMarginDrag = {
    pageNo,
    boxEl,
    mode,
    startX: event.clientX,
    startY: event.clientY,
    startBox: [...box],
    box: [...box],
    rect,
    moved: false,
  };
  boxEl.classList.add("is-dragging");
  document.body.classList.add("margin-dragging");
}

function onMarginPointerMove(event) {
  if (!tileMarginDrag) return;
  const drag = tileMarginDrag;
  const dx = (event.clientX - drag.startX) / drag.rect.width;
  const dy = (event.clientY - drag.startY) / drag.rect.height;
  if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3) {
    drag.moved = true;
  }
  const [sx0, sy0, sx1, sy1] = drag.startBox;
  const raw = [
    drag.mode.includes("w") ? sx0 + dx : sx0,
    drag.mode.includes("n") ? sy0 + dy : sy0,
    drag.mode.includes("e") ? sx1 + dx : sx1,
    drag.mode.includes("s") ? sy1 + dy : sy1,
  ];
  const box = snapMarginBox(raw, drag.mode);
  drag.box = box;
  injected.applyMarginRect(drag.boxEl, box);
}

function onMarginPointerUp() {
  if (!tileMarginDrag) return;
  const drag = tileMarginDrag;
  tileMarginDrag = null;
  drag.boxEl.classList.remove("is-dragging");
  document.body.classList.remove("margin-dragging");
  if (!drag.moved) return;
  const box = drag.box.map((value) => Math.round(value * 1e6) / 1e6);
  savePageMargin(drag.pageNo, box);
}

/**
 * 拖拽的全局监听（pointerdown 走 #page-grid 的事件委托，不在这里挂）。
 *
 * 挂 `document` 而不是 `window`：指针事件一定发生在文档内、且会冒泡到 document，
 * 行为等价；而 node 闸的合成 DOM 有 document.addEventListener、没有 window.addEventListener
 * （那不是实现问题，是测试沙箱的最小面——不要去改那个沙箱）。
 */
function setupMarginDrag() {
  document.addEventListener("pointermove", onMarginPointerMove);
  document.addEventListener("pointerup", onMarginPointerUp);
  document.addEventListener("pointercancel", onMarginPointerUp);
}

// ---- 三个「任务 / 工作流 / 检测开始」事件能力（C 类，进清册，不写死期）----

/**
 * 一次任务收尾：外壳只知道"这个 job 结束了"，pages 侧要重画什么由模块决定。
 *
 * 顺序与原来逐字一致（9.3 之前分散在 refreshMarginState 的写点与 reportLayoutDetectOutcome 整段里）：
 *   ① 版心读回之后的重画：tiles → panel → 条件拟合（`ensureMarginFitted` 会 POST fit-all 写盘，
 *      所以它必须在 `await refreshMarginState()` 之后、且不被 loadTasks 之类的前置成功挡住）
 *   ② 版面检测的收尾结论：判定文字 / 进度条 / 四条分支（中断 / 取消 / 失败 / 完成）
 *
 * 只吃数据：`data` 是任务载荷（job_type / status / done / total / failed），没有"该调哪个函数"之类字段。
 */
function onTaskFinished(data) {
  refreshMarginTiles();
  renderMarginPanel();
  if (injected.getCurrentView() === "pages" && injected.getWorkflowStep() === "margin") {
    ensureMarginFitted();
  }
  const job = data && data.job;
  if (!job || job.job_type !== "layout") return;
  renderMarginStepVerdict();
  const total = Number(job.total || 0);
  const done = Number(job.done || 0);
  const failed = Number(job.failed || 0);
  const left = Math.max(total - done - failed, 0);
  const head = [];
  // **进程意外结束 ≠ 完成**：这时候说"检测完成"就是谎报（检测进程被页面内容崩掉时就是这样）
  if (job.status === "interrupted") {
    head.push(
      `版面检测中断：检测进程意外结束了（已完成 ${done} / ${total} 页，还剩 ${left} 页）。` +
        "失败页在任务抽屉里能看到页码；点「继续」只重做剩下的页。"
    );
    if (failed) {
      head.push(
        "如果每次都在同一页停下，是那一页让检测引擎崩了（不是你的操作问题），把页码记下来报给开发者。"
      );
    }
    setMarginStatus(head.join(" "), true, 30000);
    finishMarginDetectBar(done, total);
    return;
  }
  if (job.status === "cancelled") {
    setMarginStatus(
      `版面检测已取消：完成 ${done} 页，剩下的 ${left} 页没做。已经检出的行和版心都保留。`,
      false,
      20000
    );
    finishMarginDetectBar(done, total);
    return;
  }
  if (job.status === "failed" && !done) {
    setMarginStatus(
      "版面检测没有成功：原因见任务抽屉里的失败页。",
      true,
      30000
    );
    finishMarginDetectBar(done, total);
    return;
  }
  // 拟合结果按**刷新后的真实状态**说：检出 0 行的页拟合出来仍是空的，不能写成"已补拟合"
  const stillEmpty = injected.marginPagesWithoutLines().length;
  const tail = stillEmpty
    ? `还有 ${stillEmpty} 页这次没检出正文行（空白页 / 插图页常见），这些页的版心仍是未定。`
    : "版心已按检测行补拟合，回去看页面的四边。";
  setMarginStatus(
    (failed
      ? `版面检测完成：${total} 页里 ${failed} 页失败（原因在任务抽屉，重试只重做失败页）。`
      : `版面检测完成：${total} 页。`) + tail,
    failed > 0,
    30000
  );
  finishMarginDetectBar(done, total);
}

/** 版面检测点了「开始检测」：判定文字 + 进度条归零 + 状态行（原来的三处写点收成一次）。 */
function onLayoutDetectStarted(totalPages) {
  renderMarginStepVerdict();
  marginProgressOwner = "detect";
  showMarginDetectProgress(0, totalPages);
  setMarginStatus(`开始检测 ${totalPages} 页版面（只检测，不识别文字）…`, false, 60000);
}

/** 工作流角标读完：版心的缺口提示与检测入口文案跟着变（原来是 renderLayoutStatus 的两行写点）。 */
function onWorkflowLoaded(counts = {}, summary = {}) {
  // 刀 9.5：renderWorkflowFilter 并进来（外壳只给数据，不给"该调哪个函数"）
  renderWorkflowFilter(counts || {}, summary || {});
  refreshMarginDetectHint();
  refreshLayoutDetectEntry();
}

// ---------------------------------------------------------------- 刀 9.5：选择 / 网格 / 滚动（从外壳搬入）

function selectOnly(pageNo) {
  const selected = injected.getSelectedPages();
  selected.clear();
  selected.add(pageNo);
  injected.setSelectionAnchor(pageNo);
}

function toggleSelection(pageNo) {
  const selected = injected.getSelectedPages();
  if (selected.has(pageNo)) {
    selected.delete(pageNo);
  } else {
    selected.add(pageNo);
  }
  injected.setSelectionAnchor(pageNo);
}

function selectRangeTo(pageNo) {
  const pages = visiblePages();
  const anchor = injected.getSelectionAnchor();
  const anchorIndex = pages.findIndex((page) => page.page_no === anchor);
  const index = pages.findIndex((page) => page.page_no === pageNo);
  if (anchorIndex < 0 || index < 0) {
    selectOnly(pageNo);
    return;
  }
  const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
  const selected = injected.getSelectedPages();
  for (let i = from; i <= to; i += 1) selected.add(pages[i].page_no);
}

/** 全选当前筛选（保留筛选外已选的页）。 */
function selectAllVisiblePages() {
  const pages = visiblePages();
  if (!pages.length) return;
  const selected = injected.getSelectedPages();
  for (const page of pages) selected.add(page.page_no);
  if (injected.getSelectionAnchor() === null) injected.setSelectionAnchor(pages[0].page_no);
  renderPages();
}

/** 取消全选（当前筛选内外的选择一起清掉）。 */
function clearPageSelection() {
  const selected = injected.getSelectedPages();
  if (!selected.size) return;
  selected.clear();
  injected.setSelectionAnchor(null);
  renderPages();
}

function handleTileClick(page, event) {
  if (event.shiftKey && injected.getSelectionAnchor() !== null) {
    selectRangeTo(page.page_no);
  } else if (event.metaKey || event.ctrlKey) {
    toggleSelection(page.page_no);
  } else {
    selectOnly(page.page_no);
  }
  renderPages();
}

/** 点「下一页」：换到下一页（翻页本身不写库，版心不动就是已定）。 */
function selectNextPage(pageNo) {
  if (!injected.getCurrentProject()) return;
  const pages = visiblePages();
  const index = pages.findIndex((page) => page.page_no === pageNo);
  const target = pages[index + 1] || pages[index] || null;
  if (!target) return;
  // 多选时「下一页」只翻页，不改选择（2026-10-30：选 3 页按一下下一页，3 页变 1 页）
  const selected = injected.getSelectedPages();
  if (selected.size <= 1) {
    selected.clear();
    selected.add(target.page_no);
    injected.setSelectionAnchor(target.page_no);
  }
  renderPages();
  const tile = document.querySelector(
    `#page-grid .page-tile[data-page-no="${target.page_no}"]`
  );
  if (tile) tile.scrollIntoView({ block: "center", behavior: "smooth" });
}

let pageScrollListening = false;

function ensurePageScrollListener() {
  if (pageScrollListening) return;
  const scroller = pageScroller();
  // 沙箱（node 闸的合成 DOM）没有 window.addEventListener；真实浏览器有，行为不变
  (scroller || window).addEventListener?.("scroll", schedulePageVisibility, { passive: true });
  window.addEventListener?.("resize", () => {
    injected.setPageTileMetrics(null);
    schedulePageVisibility();
  });
  pageScrollListening = true;
}

// ---- 八个事件能力（C 类，进清册、不写死期；外壳只知道"发生了什么"，重画什么由这里决定）----

/** 页面列表改了（库卡片 / 目录兜底那两处）：整格重画。 */
function onPageListChanged() {
  renderPages();
}

/** 页面数据大面积变了（页眉页脚应用、任务控制之后）：重拉列表再重画。 */
async function onProjectPagesReloaded() {
  await reloadProjectPages();
}

/** 第二引擎复核收尾：识别步的状态文字要跟着变。 */
function onAuxReviewFinished() {
  renderRecognitionStatus();
}

/** 页面状态刷新了（轮询 / 壳的刷新）：就地把瓷砖状态同步掉。 */
function onPageStatesRefreshed() {
  syncPageStates();
}

/** 自动应用状态变了（任务结算后）：右栏角标重画。 */
function onAutoApplyStatusChanged(run) {
  renderAutoApplyStatus(run);
}

/** 步骤条重算了：按新步骤重排右栏分区。 */
function onWorkflowStepChanged() {
  renderStepPanels();
}

/** 块框缓存失效（只在"没有指定页"时全清；指定页的由外壳按页丢）。 */
function onPageBlocksInvalidated() {
  forgetAllPageBlocks();
}

/** 建议缓存失效（识别收尾 / 清理 / 类型变更 / 拆批之后）。 */
function onPageSuggestionsInvalidated() {
  forgetAllPageSuggestions();
}

/**
 * 布局可能要重排（刀 10a）：切回页面视图（瓷砖位置要重量）/ 块类型变了 / 拆分批量 / 打开项目之后。
 *
 * 外壳只知道"该重算了"，不再持有 `pageScrollScheduled` 那类调度状态；
 * 重算范围（只算视口附近的页）与"同帧只排一次"都在模块里。
 */
function onPagesNeedReflow() {
  schedulePageVisibility();
}

/**
 * 页面视图变成可见（刀 10.2）：回页面视图时把建议预取接上。
 *
 * 外壳只知道"视图刚显示"，不知道"队列排到哪"——那是模块自己的调度状态。
 * 语义是**视图可见**，不是"队列排完"：别把 ensurePageSuggestion 的入口并进来。
 */
function onPagesShown() {
  pumpPageSuggestionQueue();
}

/** Esc 清空选择 / Ctrl(⌘)+A 全选（9.5 从外壳的 keydown 搬入；对话框的 Esc 仍在 setupShell）。 */
function wirePagesKeyboard() {
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      !injected.openMasks().length &&
      injected.getCurrentProject() &&
      injected.getSelectedPages().size
    ) {
      clearPageSelection();
      return;
    }
    if (!injected.getCurrentProject() || document.body.dataset.view !== "pages" || injected.openMasks().length) return;
    const active = document.activeElement || {};
    const inEditor =
      ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) || active.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !inEditor) {
      event.preventDefault();
      selectAllVisiblePages();
    }
  });
}

/**
 * 视图切换通知：**当前视图切到 `getCurrentView()` 时，pages 侧做进入 / 离开的准备**。
 *
 * 名字叫 enter，但它也会被"离开 pages"那条路调用——`pausePageThumbnails` 的宿主就是这个切换点
 * （外壳 showView 里 `target !== "pages"` 那条）。**两处调用是同一件事（通知），别合并成一处**：
 * 合并会把 pages 的准备整体提前到 `syncWorkflowSteps()` / `closePageDetail()` 之前，顺序就变了。
 *
 * 进入 pages 时做的事，逐条对应原来 showView 里那三行（顺序与延迟性都不变）：
 *   ① `queueAfterSteps(() => loadLanguageSummary())` —— 仍延迟到步骤条之后
 *   ② `renderPageSetup()` —— 同步
 *   ③ `!setupSuggestionsLoaded && kind !== "package"` 时 `loadSetupSuggestions()`
 * 不属于它的（`hydrateView("pages")` 的 loadWorkflow / refreshPageStates / pageTileMetrics /
 * schedulePageVisibility / applyPageZoom（C 类）/ pumpPageSuggestionQueue）仍留外壳。
 */
function enter() {
  if (injected.getCurrentView() !== "pages") {
    // 离开 pages：停掉网格里在飞 / 排队的缩略图请求，别和审校、预览抢 CPU（任务 43）
    pausePageThumbnails();
    return;
  }
  injected.queueAfterSteps(() => loadLanguageSummary());
  renderPageSetup();
  const project = injected.getCurrentProject();
  if (!injected.getSetupSuggestionsLoaded() && project && project.kind !== "package") {
    loadSetupSuggestions();
  }
}

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    // 刀 2：deps 已赋值，统一挂 17 段 pages 接线（**必须在 return api 之前**）。
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
    loadFinishSummary,
    renderRecognitionSettings,
    applyPageZoom,
    confirmAllUnconfirmed,
    checkSelection,
    onPageBlocksInvalidated,
    onPageListChanged,
    onPageNumberAnalysisReady,
    onPageNumberChanged,
    onPageStatesRefreshed,
    onPageSuggestionsInvalidated,
    onPagesNeedReflow,
    onPagesShown,
    onProjectPagesReloaded,
    onRecognitionFinished,
    onTaskProgress,
    onWorkflowStepChanged,
    onLayoutDetectStarted,
    onTaskFinished,
    onWorkflowLoaded,
    onAuxReviewFinished,
    onAutoApplyStatusChanged,
    openPageSetup,
    startLayoutDetection,
    toggleMarginView,
    togglePageBlocksOverlay,
    // 刀 6：四处「外壳 → 模块」的操作入口（R8 53 → 57；逐键死亡刀号见 tests/js/boundary.test.mjs）
    // syncToolbarToggles 是**模块→模块**键（调用者是四个 view 模块），到点判据不能用「app.js 引用 = 0」。
    syncToolbarToggles,          // 死亡刀号 = 刀10（全仓引用 = 0 且不在 api 表）
    showPagesError,              // 死亡刀号 = 刀9（app.js 引用 = 0 且不在 api 表）
    pagesErrorMessage,           // 死亡刀号 = 刀9（同上）
    setMarginJudgementCheckbox,  // 死亡刀号 = 刀9（同上）
    // 刀 7：recognizePage 搬进本模块（刀 5 的 31 个 mover 同族：外壳两处调用点改直调）
    // 到点判据：`app.js` 里 `window.PagesView.recognizePage` 引用 = 0 且不在 api 表——
    // 今天两个调用者（buildTile / setupLibrary）都在外壳；刀 9 若还剩一个，这个键就死不了。
    recognizePage,               // 死亡刀号 = 刀9
    // 刀 8：三个外壳函数（applyPackageMode / applyProjectSettings / applySplitBatch）留在外壳，
    // 只把它们落在 pages 面板上的 23 处写点收成能力（R8 58 → 61）。三个都是 C：
    // 调用者在外壳的跨域编排里，不会"到点死"，所以不写死期。
    setPackageModeChrome,        // C：包模式开/关时 pages 面板入口的显隐（10 个 id）
    syncProjectSettings,         // C：项目设置 → pages 面板两个勾选态
    setSelectionHint,            // C：拆分批量的选中提示
    // 刀 9.1：视图切换通知（L 类，无死期）。它顶替的是"切到 pages 时 pages 侧的进入/离开准备"，
    // 所以 R8 净额 −4 +1：死 loadSetupSuggestions / renderPageSetup / loadLanguageSummary /
    // pausePageThumbnails，新增本键。
    enter,                       // L：生命周期键（不写 death）
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
    patchRecognitionSetting("recognition_engine", event.target.value)
  );
  for (const radio of document.querySelectorAll('#rec-dpi input[type="radio"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        patchRecognitionSetting("recognition_dpi", Number(radio.value));
      }
    });
  }
  el("rec-language").addEventListener("change", (event) =>
    patchRecognitionSetting("recognition_language", event.target.value)
  );
  el("rec-dual-strategy").addEventListener("change", (event) =>
    patchRecognitionSetting("dual_engine_strategy", event.target.value)
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
  // 版心拖拽的入口：事件委托（刀 9.3）。把手由外壳的 buildTile 建，但拖拽状态与位移都在本模块，
  // 所以监听必须挂在这里；新瓷砖自动覆盖，不需要逐块绑。
  el("page-grid").addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".page-margin__handle");
    if (!handle) return;
    const tile = handle.closest(".page-tile");
    if (!tile) return;
    startTileMarginDrag(
      event,
      Number(tile.dataset.pageNo),
      handle.closest(".page-margin__box"),
      handle.dataset.edge
    );
  });
  // 点页面网格的空白处取消选择：只认"不在任何页瓷砖里"的点击，
  // 所以单击页 / 拖版心把手 / 页内按钮都不会误触发。
  // 单击瓷砖的选中（刀 9.5：原来挂在 buildTile 的逐块 listener 上，改成委托；dblclick 不在这里）
  el("page-grid").addEventListener("click", (event) => {
    const tile = event.target.closest(".page-tile");
    if (!tile) return;
    const pageNo = Number(tile.dataset.pageNo);
    const project = injected.getCurrentProject();
    const page = project ? project.pages.find((item) => item.page_no === pageNo) : null;
    if (page) handleTileClick(page, event);
  });
  el("page-grid").addEventListener("click", (event) => {
    if (!injected.getCurrentProject()) return;
    if (event.target.closest(".page-tile")) return;
    if (event.target.closest(".page-margin__handle")) return;
    clearPageSelection();
  });
  // 拖拽的窗口级监听（pointermove / pointerup / pointercancel）随拖拽簇一起搬进模块
  setupMarginDrag();
}
/**
 * 页码区间输入（刀 2.5 从 `setupLibrary` 原样搬出）。
 *
 * 这一段只碰 `view-pages` 的 id，抽出来时行序未动。
 */
function wirePagesPageRange() {
  el("page-range-select").addEventListener("click", applyPageRangeInput);
  el("page-range").addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyPageRangeInput();
  });
}
/**
 * 全选 / 反选 / 清空 / 选中识别（刀 2.5 从 `setupLibrary` 原样搬出）。
 *
 * 这一段只碰 `view-pages` 的 id，抽出来时行序未动。
 */
function wirePagesSelection() {
  el("selection-all").addEventListener("click", selectAllVisiblePages);
  el("selection-select-all").addEventListener("click", selectAllVisiblePages);
  el("selection-clear").addEventListener("click", clearPageSelection);
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
  el("pages-overlay-toggle").addEventListener("click", togglePageBlocksOverlay);
  el("pages-margin-toggle").addEventListener("click", toggleMarginView);
  el("layout-block-apply-all").addEventListener("click", injected.adoptAllHighSuggestions);
  el("layout-block-confirm").addEventListener("click", confirmLayoutFromPanel);
  el("margin-confirm-all").addEventListener("click", confirmAllMargins);
  el("rec-start-all").addEventListener("click", () => {
    // 目标由 recognitionTarget() 唯一决定（文案、禁用、点下去做什么，三处同源）
    const target = recognitionTarget();
    if (target.mode === "batch") {
      startBatchRecognition("unrecognized");
      return;
    }
    if (target.mode === "selection") {
      recognizeSelection(false);
      return;
    }
    if (target.mode === "force") {
      recognizeSelection(true);
    }
  });
  el("rec-aux-all").addEventListener("click", startAuxiliaryAll);
}
/**
 * 确认页三件（选中 / 拆页号 / 全部）（刀 2.5 从 `setupLibrary` 原样搬出）。
 *
 * 这一段只碰 `view-pages` 的 id，抽出来时行序未动。
 */
function wirePagesSetup() {
  el("setup-confirm-selected").addEventListener("click", confirmSelectedPages);
  el("split-page-numbers").addEventListener("click", injected.openSplitBatchPanel);
  el("setup-confirm-all").addEventListener("click", confirmAllUnconfirmed);
}
/**
 * 「高建议自动采用」开关的接线（刀 2.5 从 `setupLibrary` 原样搬出）。只碰 `view-pages` 的 id：`auto-apply-suggestions`。
 */
function wirePagesAutoApplySuggestions() {
  el("auto-apply-suggestions").addEventListener("change", (event) =>
    setAutoApplySetting(event.target.checked)
  );
}
/**
 * 「检查选中」按钮的接线（刀 2.5 从 `setupLibrary` 原样搬出）。只碰 `view-pages` 的 id：`selection-check`。
 */
function wirePagesSelectionCheck() {
  el("selection-check").addEventListener("click", () => checkSelection(null));
}
/**
 * 「检查未定」按钮的接线（刀 2.5 从 `setupLibrary` 原样搬出）。只碰 `view-pages` 的 id：`check-pending`。
 */
function wirePagesCheckPending() {
  el("check-pending").addEventListener("click", () => checkSelection("unchecked"));
}

/**
 * 「⋯」菜单条目的接线（刀 6 从 `setupLibrary` 抽出 9 处）。
 *
 * 只碰 `view-pages` 的 id：`apply-high-suggestions` / `word-boxes-open` / `page-more-menu` /
 * `backups-open` / `aux-rerun` / `layout-detect-open`。
 * 点 ⋯ 里的条目 = 先收起菜单、再开对话框（模板遮罩不能挂在菜单里）——原来这段写了 4 遍。
 */
function hidePageMoreMenu() {
  const menu = el("page-more-menu");
  if (menu) menu.hidden = true;
}
function wirePagesMoreMenuEntries() {
  el("apply-high-suggestions").addEventListener("click", () => injected.openSuggestionApplyPanel());
  el("word-boxes-open").addEventListener("click", () => {
    hidePageMoreMenu();
    injected.openWordBoxesDialog();
  });
  el("backups-open").addEventListener("click", () => {
    hidePageMoreMenu();
    injected.openBackups();
  });
  el("aux-rerun").addEventListener("click", () => {
    hidePageMoreMenu();
    rerunAuxiliary();
  });
  el("layout-detect-open").addEventListener("click", () => {
    hidePageMoreMenu();
    injected.openLayoutDetectDialog();
  });
}

/**
 * 外壳里「统计」与「开始审校」两个入口的接线（刀 6 从 `setupShell` 抽出 2 处）。
 *
 * 只碰 `view-pages` 的 id：`stats-open` / `selection-review-open`。
 * 统计面板的开关是全局 chrome（`stats-panel` 不在 view-pages 子树）⇒ **收成具名能力**
 * `injected.openStatsPanel()`；在模块里写 `openModal("stats-panel")` 等于把 id 豁免换成字符串豁免。
 */
function wirePagesShellEntries() {
  el("stats-open").addEventListener("click", () => injected.openStatsPanel());
  el("selection-review-open").addEventListener("click", () => {
    const first = injected.selectionPages()[0] || visiblePages()[0];
    injected.showView("review");
    if (first) injected.openPageDetail(first.page_no);
  });
}

/**
 * 批量指派面板的两个入口（刀 6 从 `setupCollabControls` 抽出 2 处）。
 *
 * 只碰 `view-pages` 的 id：`assign-open` / `assign-list-toggle`。
 * 「指派列表开关」翻转的是 `assign-panel`（全局 chrome id）⇒ 整个动作收成具名能力
 * `injected.toggleAssignList()`，handler 不许整段搬进来。
 */
function wirePagesCollabEntries() {
  el("assign-open").addEventListener("click", () => injected.openAssignPanel());
  el("assign-list-toggle").addEventListener("click", () => injected.toggleAssignList());
}

/** 刀 2：17 段接线在本模块初始化时统一挂载（顺序 = 它们在 app.js 里的原顺序）。 */
function wireAll() {
  wirePagesExportMarginJudgement();
  wirePagesRecognitionSettings();
  wirePagesPageNumberPanel();
  wirePagesPageMore();
  wirePagesFilters();
  wirePagesPageGrid();
  wirePagesKeyboard();
  wirePagesPageRange();
  wirePagesSelection();
  wirePagesSelectionMore();
  wirePagesPanes();
  wirePagesSetup();
  wirePagesAutoApplySuggestions();
  wirePagesSelectionCheck();
  wirePagesCheckPending();
  wirePagesMoreMenuEntries();
  wirePagesShellEntries();
  wirePagesCollabEntries();
}

  window.PagesView = api;
})();
