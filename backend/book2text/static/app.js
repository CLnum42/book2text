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
  constructor(message, code, correlationId, detail, data) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.correlationId = correlationId;
    this.detail = detail;
    this.data = data;
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
      error.detail,
      error.data
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

const VIEWS = ["library", "pages", "index", "review", "reading", "preview", "merge"];

let currentView = "library";

// 任务 36A：工作流外壳。步骤条只显示有真实数据的五步；目录确认 / 结果预览
// 数据与功能都还没做，不摆出来（不显示无法执行的步骤）。
const WORKFLOW_STEPS = [
  { id: "pages", label: "页面确认", short: "页面" },
  // 任务 56（刀 2）：识别在前、版心在后。整页识别不读版心（版心过滤在组装 / 导出），
  // 而版心拟合要读行框——行框就是识别产出的 block_line.bbox。
  { id: "recognition", label: "文字识别", short: "识别" },
  { id: "margin", label: "版心确认", short: "版心" },
  { id: "index", label: "目录确认", short: "目录" },
  // L 刀：正文审校吸收结果预览（连续正文流），步骤 7 → 6
  { id: "review", label: "正文审校", short: "审校" },
  { id: "export", label: "文件导出", short: "导出" },
];
const PAGE_WORKFLOW_STEPS = ["pages", "recognition", "margin", "index"];
let workflowStep = null;
let workflowStepPinned = false;
let projectSummary = null;
let projectExports = [];

// 任务 36B：分步右栏。每步只显示自己的分区；版心步进来自动拟合未定的页。
let lastStepPanelKey = null;
let marginFitRunning = false;
/** 本次会话里已经尝试拟合过的页：拟合不出来（没有检测行）的页不要反复重试。 */
const marginFitTried = new Set();
/** 页面视图缩放是否被用户手动改过：改过之后切步骤一律不动缩放。 */
let pageZoomTouched = false;
/** 版心编辑的撤销栈（前端内存，最多 20 步）：拖动只写一次库，撤销也是写一次。 */
const marginUndoStack = [];

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
  visiblePageNos.clear();
}

/**
 * 视图专属数据的懒加载（任务 63）。
 *
 * 打开项目时会话只发「步骤条 + 项目载荷 + 当前视图」这三样；页面工作流角标、
 * 页码索引、导出预检这些**只属于某个视图**的请求，等用户真的切过去再发。
 * 490 页的书上，这三样加起来有 6 s 以上，以前它们跟着开机一起挤，
 * 步骤条要十几秒才亮。
 */
const viewHydrated = { pages: false, index: false, export: false };

/**
 * 启动队列（任务 63）：步骤条（`finish-summary`）没亮之前，视图专属的重请求
 * 一个都不发——490 页的书上它们加起来 10 s 以上，会把步骤条饿到十几秒。
 * `finishSummary` 一到就按入队顺序开跑。
 */
let bootQueue = [];
let stepsReady = false;

function queueAfterSteps(fn) {
  if (stepsReady) {
    fn();
    return;
  }
  bootQueue.push(fn);
}

function flushBootQueue() {
  const queued = bootQueue;
  bootQueue = [];
  for (const fn of queued) {
    try {
      fn();
    } catch (error) {
      console.warn("启动队列里的任务失败", error);
    }
  }
}

function resetViewHydration() {
  viewHydrated.pages = false;
  viewHydrated.index = false;
  viewHydrated.export = false;
}

async function hydrateView(name) {
  if (!currentProject) return;
  if (name === "pages" && !viewHydrated.pages) {
    viewHydrated.pages = true;
    await loadWorkflow();
  } else if (name === "index" && !viewHydrated.index) {
    viewHydrated.index = true;
    loadPageNumberSummary();
  } else if (name === "export" && !viewHydrated.export) {
    viewHydrated.export = true;
    await refreshExportPreflight();
    await loadExports();
  }
}

function showView(name) {
  if (!VIEWS.includes(name)) return;
  // 没有打开项目时，只有项目库是可达的
  const target = currentProject || name === "library" ? name : "library";
  const wasReview = currentView === "review";
  currentView = target;
  document.body.dataset.view = target;
  for (const view of VIEWS) el(`view-${view}`).hidden = view !== target;
  el("topbar-library").hidden = target !== "library";
  el("topbar-project").hidden = target === "library";
  el("review-pager").hidden = target !== "review";
  // 任务 43：不在页面视图就把网格缩略图停掉，审校 / 预览不跟后台渲染抢 CPU
  if (target !== "pages" && currentProject) pausePageThumbnails();
  // 换视图 = 当前步骤回落到该视图的默认步；用户点步骤条时才锁定。
  workflowStepPinned = false;
  syncWorkflowSteps();
  if (target !== "review") closeTaskDrawer();
  if (target === "pages" && currentProject) {
    // 这一视图的工作流角标 / 待处理页：进来才拉（骨架先显示，数字后到）
    queueAfterSteps(() => hydrateView("pages"));
    queueAfterSteps(() => loadLanguageSummary());
    // 回到页面视图时以数据库为准重拉一次：确认进度与类型不在前端缓存里说了算
    renderPageSetup();
    refreshPageStates();
    if (!setupSuggestionsLoaded && currentProject.kind !== "package") {
      loadSetupSuggestions();
    }
    // 回到页面视图：瓷砖位置要重新量（在审校视图里它们全是 0），块框按需补画
    pageTileMetrics = null;
    schedulePageVisibility();
    // 缩放是三步共用的：可能在目录确认步里改过，回来要按当前档位重排网格。
    applyPageZoom();
    // 任务 43：审校期间暂停的建议预取，回到页面视图再接着排。
    pumpPageSuggestionQueue();
  }
  if (target === "reading" && currentProject) {
    // 任务 94 Slice 2：进入审校只有一条路——ReadingView.enter()（§4 第 1 组）
    // R7 机检保证 reading-view.js 先于 app.js 加载，ReadingView 必然存在；
    // 原 else 分支（setReviewOverlaysForReading + openReading）与 enter 内部同序，是死路。
    window.ReadingView?.enter(currentProject.project_id);
  }
  if (target === "review" && currentProject) {
    // 任务 45：审校步默认只留差异层——版心与块框关掉，避免五套彩色打架
    if (!wasReview) {
      setReviewOverlay(false);
      setReviewMargin(false);
    }
    ensureReviewTree();
  }
  if (target === "index" && currentProject) {
    queueAfterSteps(() => hydrateView("index"));
    openPageIndex();
  }
  if (target === "preview" && currentProject) {
    openPreview();
  }
  if (target === "export" && currentProject) {
    queueAfterSteps(() => hydrateView("export"));
  }
}

/**
 * 任务 36A：某一步的完成 / 失败 / 微计数。**只读收尾面板与质量统计的现成数据**，
 * 不另算一套：
 * - 页面：finish-summary.page_type.complete
 * - 版心：finish-summary.margin.complete && undetermined=0（后端按 mode 判定，
 *   custom 页即使 margin_box_method=NULL 也算已定）
 * - 识别：主引擎 recognized(+has_candidate) = 正文页数、failed=0、第二引擎 checked=total
 *   **不看差异处理进度**，也不看空文本行（458 条空文本不影响这一步）
 * - 审校：needs_human=0 且 auto_passable=0 且版面 remaining=0
 * - 导出：至少一条 succeeded 的导出记录
 */
/**
 * 正在跑的**第二引擎**任务进度（实时，来自任务抽屉的轮询），没有就返回 null。
 *
 * 为什么单独拿：收尾面板在任务期间返回旧快照（不跟识别抢 CPU），而进度必须实时——
 * 两个数据源混用会出现「0/457 进行中」和「88/457」同屏的打架。
 */
function liveAuxProgress() {
  const job = lastTaskData && lastTaskData.job;
  if (!job || job.job_type !== "auxiliary") return null;
  if (!["queued", "running", "paused"].includes(job.status)) return null;
  return {
    done: Number(job.done || 0),
    total: Number(job.total || 0),
    failed: Number(job.failed || 0),
    status: job.status,
  };
}

function stepProgress(id) {
  const fs = finishSummary;
  const ps = projectSummary;
  let done = false;
  let failed = 0;
  let failedText = "";
  let skippable = false;
  let count = "—";
  let detail = "读取中…";
  if (id === "pages") {
    if (fs) {
      const p = fs.page_type || {};
      done = Boolean(p.complete);
      count = `${p.confirmed || 0}/${p.total || 0}`;
      detail = `页面类型已确认 ${count}`;
    }
  } else if (id === "margin") {
    if (fs) {
      const m = fs.margin || {};
      done = Boolean(m.complete) && Number(m.undetermined || 0) === 0;
      count = `${m.set || 0}/${m.total || 0}`;
      detail =
        `正文页版心已定 ${count}` +
        (m.fallback ? ` · ${m.fallback} 页本页包围盒兜底` : "") +
        (m.no_text ? ` · ${m.no_text} 页无文字跳过` : "") +
        (m.undetermined ? ` · ${m.undetermined} 页未定` : "");
    }
  } else if (id === "recognition") {
    if (ps && fs) {
      const p = ps.pages || {};
      const engine = fs.engine || {};
      const included = Number(p.included || 0);
      const primary = Math.min(
        included,
        Number(p.recognized || 0) + Number(p.has_candidate || 0)
      );
      failed = Number(p.failed || 0);
      const failedJobs = Number((ps.jobs || {}).failed || 0);
      failedText = failed
        ? `${failed} 页失败`
        : failedJobs
          ? `${failedJobs} 个任务失败`
          : "";
      if (!failed && failedJobs) failed = failedJobs;
      // 任务 58：完成判定只看主引擎。第二引擎是给审校的定位信号（可选），
      // 41 分钟的后台任务不该把这一步卡成灰。
      done = included > 0 && primary >= included && failed === 0;
      count = `${primary}/${included}`;
      // 任务 75：**进度类数字读实时任务，不读快照**。
      // 任务在跑时收尾面板给的是旧快照（为了不跟识别抢 CPU），里面 engine.checked
      // 还是 0，于是识别步显示「第二引擎 0/457 进行中」，抽屉却是 88/457 —— 两个数
      // 打架、还会随快照刷新一闪一闪。抽屉/顶栏拿的是实时 job，这里跟它对齐。
      const live = liveAuxProgress();
      const auxText = live
        ? `第二引擎 ${live.done}/${live.total}（进行中${live.failed ? ` · 失败 ${live.failed}` : ""}）`
        : `第二引擎 ${engine.checked || 0}/${engine.total || 0}` +
          (engine.aux_complete ? "（已跑完）" : "（可选，没跑完）");
      detail =
        `主引擎 ${primary}/${included}` +
        ` · ${auxText}` +
        (failedText ? ` · ${failedText}` : "");
    }
  } else if (id === "index") {
    // 任务 37：目录确认 = 页码跳转索引生成成功，人工操作 0 次。
    // 任务 73：三态——真的建出可用索引（绿 ✓）/ 这本书没有可用页码（可跳过，虚线灰）/
    // 有页码但还没确认（普通序号）。原来 `numbered > 0` 就算完成，1/662 也会变绿。
    if (fs) {
      const ix = fs.index || {};
      done = Boolean(ix.complete);
      skippable = !done && Boolean(ix.skippable);
      count = skippable ? "可跳过" : `${ix.numbered || 0}/${ix.total || 0}`;
      detail =
        `索引 ${ix.numbered || 0}/${ix.total || 0} 页有印刷页码` +
        (ix.chapters ? ` · ${ix.chapters} 章` : "") +
        (ix.numbering_step === 2 ? " · 页码隔 2 递增" : "") +
        (skippable
          ? " · 这本书没有可用页码，目录确认可以跳过（导出按 PDF 页序）"
          : ix.missing
            ? ` · ${ix.missing} 页缺页码（照样可点）`
            : "");
    }
  } else if (id === "review") {
    if (fs) {
      const r = fs.review || {};
      const layout = fs.layout || {};
      const needs = Number(r.needs_human || 0);
      const passable = Number(r.auto_passable || 0);
      const layoutLeft = Number(layout.remaining || 0);
      // 完成判定**只读后端** `r.complete`：它已经要求整条审校队列（汉字 + 标点）
      // 全部有裁决、跨页延续确认完；版面未确认仍然另外挡着。前端不再自己算一套。
      const continuation = Number(r.continuation_pending || 0);
      const charsLeft = Number(r.chars_pending || 0);
      const punctLeft = Number(r.punct_groups?.undecided_groups || 0);
      done = Boolean(r.complete) && layoutLeft === 0;
      // 英文书上"汉字"这个词本来就不对，而且它是**行数**不是字数：中英统一叫"条"
      count = charsLeft
        ? `差异剩 ${charsLeft} 条`
        : punctLeft
          ? `标点剩 ${punctLeft} 组`
          : needs
            ? `剩 ${needs} 页`
            : passable
              ? `可自动通过 ${passable} 页`
              : continuation
                ? `延续待确认 ${continuation}`
                : "已确认";
      detail =
        `差异 ${Number(r.chars_total || 0) - charsLeft}/${Number(r.chars_total || 0)} 条` +
        ` · 标点 ${Number(r.punct_groups?.decided_groups || 0)}/${Number(r.punct_groups?.groups || 0)} 组` +
        `（${punctLeft ? `${r.punct_groups?.undecided_lines || 0} 行待判` : "已判完"}）` +
        ` · 待人工 ${needs} 页 · 版面未确认 ${layoutLeft} 页` +
        (continuation ? ` · 跨页延续待确认 ${continuation} 处` : "");
    }
  } else if (id === "preview") {
    // 用户明确要求：结果预览不设完成态——它永远不是"已完成"，也不算失败。
    done = false;
    count = "";
    detail = "导出结果的实时副本；没有完成态，随时可以看";
  } else if (id === "export") {
    const succeeded = (projectExports || []).filter(
      (record) => record.status === "succeeded"
    );
    done = succeeded.length > 0;
    count = `${succeeded.length} 次`;
    const latest = succeeded[0];
    detail = latest
      ? `已成功导出 ${succeeded.length} 次 · 最近 ${latest.created_at.slice(0, 16).replace("T", " ")}`
      : "还没有成功导出";
  }
  return { done, failed, failedText, skippable, count, detail };
}

function autoWorkflowStep() {
  if (!currentProject) return null;
  const exportOpen = el("export-panel") && !el("export-panel").hidden;
  if (exportOpen) return "export";
  if (currentView === "review" || currentView === "reading") return "review";
  if (currentView === "index") return "index";
  if (currentView === "preview") return "preview";
  if (currentView !== "pages") return "review";
  for (const id of PAGE_WORKFLOW_STEPS) {
    if (!stepProgress(id).done) return id;
  }
  return "review";
}

/** 画步骤条（五步；目录确认 / 结果预览等有数据再加）。 */
function syncWorkflowSteps() {
  const nav = el("workflow-steps");
  if (!nav) return;
  const current = el("workflow-current");
  const hasProject = Boolean(currentProject);
  nav.hidden = !hasProject;
  if (current) current.hidden = !hasProject;
  if (!hasProject) {
    nav.innerHTML = "";
    if (current) current.textContent = "";
    return;
  }
  if (!workflowStepPinned) workflowStep = autoWorkflowStep();
  if (currentProject.kind === "package" && workflowStep === "export") {
    workflowStep = "review";
  }
  nav.innerHTML = "";
  const isPackage = currentProject.kind === "package";
  const visible = WORKFLOW_STEPS.filter(
    (step) => !(isPackage && (step.id === "export" || step.id === "preview"))
  );
  visible.forEach((step) => {
    const index = WORKFLOW_STEPS.findIndex((item) => item.id === step.id);
    const progress = stepProgress(step.id);
    const isCurrent = workflowStep === step.id;
    const failed = Number(progress.failed || 0) > 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workflow-step";
    button.dataset.workflowStep = step.id;
    if (isCurrent) {
      button.classList.add("is-current");
      button.setAttribute("aria-current", "step");
    }
    if (step.plain) button.classList.add("workflow-step--plain");
    if (failed) button.classList.add("is-failed");
    else if (progress.done) button.classList.add("is-done");
    else if (progress.skippable) button.classList.add("is-skippable");

    const badge = document.createElement("span");
    badge.className = "workflow-step__badge";
    badge.textContent = step.plain
      ? "▸"
      : failed
        ? "!"
        : progress.done
          ? "✓"
          : progress.skippable
            ? "–"
            : String(index + 1);

    const name = document.createElement("span");
    name.className = "workflow-step__name";
    const full = document.createElement("span");
    full.className = "workflow-step__full";
    full.textContent = step.label;
    const short = document.createElement("span");
    short.className = "workflow-step__short";
    short.textContent = step.short;
    name.append(full, short);

    const count = document.createElement("span");
    count.className = "workflow-step__count";
    count.textContent = step.plain
      ? ""
      : failed
        ? progress.failedText || `${progress.failed} 页失败`
        : isCurrent
          ? progress.count
          : "";

    button.title =
      step.plain
        ? `${step.label} · ${progress.detail}`
        : `${step.label} · ${failed ? "有失败" : progress.done ? "已完成" : "未完成"}` +
          ` · ${progress.detail}`;
    button.append(badge, name, count);
    nav.append(button);
  });

  if (current) {
    const step = WORKFLOW_STEPS.find((item) => item.id === workflowStep);
    if (step) {
      const index = WORKFLOW_STEPS.findIndex((item) => item.id === workflowStep) + 1;
      current.textContent = `${index} ${step.label}`;
    }
  }
  renderStepPanels();
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
  const onPages = Boolean(currentProject) && currentView === "pages";
  const step = currentProject ? workflowStep || "" : "";
  const pageStep = onPages && step === "pages";
  const marginStep = onPages && step === "margin";
  const recognitionStep = onPages && step === "recognition";
  // 目录确认也带版心开关（任务 46）：这一步要沿袭页面视图的版心/块框
  const indexStep = Boolean(currentProject) && currentView === "index";
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
  const keyChanged = key !== lastStepPanelKey;
  lastStepPanelKey = key;
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

/**
 * 底栏开关按步显示：版心步只要「版心」，页面确认 / 文字识别只要「块框」。
 *
 * 开关本身按项目记住（`b2t.pagesMargin.v1.*`），但**显示**跟着步骤走：
 * 不是版心步就把压暗关掉，免得把版心框叠在页面确认的网格上（这一步没有这个开关可关）。
 */
function syncStepToggles(marginStep) {
  const button = el("pages-margin-toggle");
  if (!currentProject) return;
  // 结果预览有自己的版心开关（任务 47）：这里只同步底栏按钮状态，
  // 不按"非版心步就关掉"的规则把用户刚关掉的版心又打开。
  if (currentView === "preview") {
    if (button) button.classList.toggle("is-on", pagesMarginOn);
    return;
  }
  // 正文审校是读稿主界面：版心 + 块框默认开着（任务 57），**不按步骤把它们压暗**。
  // 用户自己关掉也尊重——这里只同步底栏按钮状态。
  if (currentView === "reading") {
    if (button) button.classList.toggle("is-on", pagesMarginOn);
    return;
  }
  if (marginStep) {
    if (!pagesMarginOn) {
      pagesMarginOn = true;
      if (button) button.classList.add("is-on");
      refreshMarginTiles();
    }
    if (currentView === "index") paintIndexDecorations();
    return;
  }
  if (!pagesMarginOn) return;
  pagesMarginOn = false;
  if (button) button.classList.remove("is-on");
  for (const tile of document.querySelectorAll("#page-grid .page-tile")) {
    clearTileMargin(tile);
  }
  if (currentView === "index") paintIndexDecorations();
}

/** auto 页里还没有拟合框的那些页（= 版心未定）。 */
function marginUndeterminedPages() {
  if (!currentProject) return [];
  return currentProject.pages.filter(
    (page) => page.margin_box_mode === "auto" && !page.margin_box
  );
}

/** 这一页最近一次成功版面检测的行数（0 = 还没检测 / 一行都没检出）。 */
function pageLayoutLines(page) {
  return Number((page && page.layout_lines) || 0);
}

/** 这一页的识别行数（刀 1：版心可以回退 OCR 行拟合）。 */
function pageTextLines(page) {
  return Number((page && page.text_lines) || 0);
}

/** 这一页有没有可拟合的行框：检测行优先，没有就看识别行。 */
function pageHasFitLines(page) {
  return pageLayoutLines(page) + pageTextLines(page) > 0;
}

/**
 * 版心未定、而且**没有可用正文行**的页（拟合不出来，不是"还没轮到"）。
 *
 * 版心是从行框推出来的：检测行（`layout_run`）或者识别行（`block_line`）。
 * 两样都没有的页，拟合出来的只能是空——界面必须如实说"未定"，不能报"已拟合"。
 */
function marginPagesWithoutLines() {
  // 口径与版心步的四态一致：只为**正文页**算，识别过且确实没字的页算"跳过"不算未定
  return marginStepVerdict().noLines;
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
  if (!currentProject || currentProject.kind === "package") return;
  if (marginFitRunning) return;
  // 主按钮「全部确认」是人工动作：上一轮试过但没成的页也要再试一次
  if (manual) marginFitTried.clear();
  const pending = marginUndeterminedPages().filter(
    (page) => pageHasFitLines(page) && !marginFitTried.has(page.page_no)
  );
  if (!pending.length) {
    renderMarginStepVerdict();
    if (manual) {
      setMarginStatus(
        marginPagesWithoutLines().length
          ? `没有可生成的页：还差 ${marginPagesWithoutLines().length} 页没有正文行（要先识别）。`
          : "全书版心都已定，没有要生成的页。",
        false,
        12000
      );
    }
    return;
  }
  const startedAt = performance.now();
  marginFitRunning = true;
  renderMarginStepVerdict();
  for (const page of pending) marginFitTried.add(page.page_no);
  showMarginFitProgress(0, pending.length);
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
      const data = await apiJson(
        `/api/projects/${currentProject.project_id}/margin-box/fit-all`,
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
      showMarginFitProgress(attempted, attempted + remaining);
      if (!updated || remaining === 0) break;
    }
    await refreshPageStates();
    refreshMarginTiles();
    renderMarginPanel();
    if (typeof loadFinishSummary === "function") {
      await loadFinishSummary({ silent: true });
    }
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    const summary = marginFitSummaryText(fitted, fallback, undetermined, noText);
    setMarginStatus(manual ? `${summary} 耗时 ${elapsed} 秒。` : summary, false, 20000);
  } catch (error) {
    showError(el("pages-error"), error);
  } finally {
    marginFitRunning = false;
    hideMarginFitProgressSoon();
    refreshMarginDetectHint();
    renderMarginStepVerdict();
  }
}

/** 拟合结果的真实说法：只在**确实写出框**的页数上说"已拟合"。 */
function marginFitSummaryText(fitted, fallback, undetermined, noText) {
  const parts = [];
  const settled = fitted + fallback;
  if (settled > 0) {
    parts.push(
      `版心已生成：自动拟合 ${fitted} 页` +
        (fallback ? ` · 本页包围盒兜底 ${fallback} 页` : "")
    );
  }
  if (noText > 0) {
    parts.push(`${noText} 页没有文字（插图 / 空白），跳过`);
  }
  if (undetermined > 0) {
    parts.push(
      `${undetermined} 页还没有可用的正文行，版心未定` +
        (settled > 0 ? "" : "（这些页要先有行框，才能生成版心）")
    );
  }
  return parts.length ? `${parts.join(" · ")}。` : "";
}

function showMarginFitProgress(done, total) {
  const wrap = el("margin-fit-progress");
  if (!wrap) return;
  wrap.hidden = false;
  const percent = total ? Math.round((done / total) * 100) : 0;
  el("margin-fit-fill").style.width = `${percent}%`;
  el("margin-fit-text").textContent =
    done >= total
      ? `自动拟合完成：${total} 页`
      : `正在为 ${total} 页自动拟合版心… ${done} / ${total}`;
}

function hideMarginFitProgressSoon() {
  window.setTimeout(() => {
    const wrap = el("margin-fit-progress");
    if (wrap && !marginFitRunning) wrap.hidden = true;
  }, 1600);
}

/** 版面检测任务是否在跑（「⋯ → 检测版面」起的那个任务）——版心步的"生成中"状态要用。 */
let layoutDetectActive = false;

/** 正文页（版心只关心这些；非正文页不进分母，否则步骤条永远绿不了）。 */
function marginBodyPages() {
  if (!currentProject) return [];
  return currentProject.pages.filter((page) => page.include);
}

/**
 * 版心这一步的**四态**（任务 56 / 刀 2）：未准备 / 生成中 / 已拟合 / 有未定页。
 *
 * 判据只用真实数据：页上的 `margin_box`（已落库的框）、`text_lines` / `layout_lines`
 * （有没有可拟合的行）、以及正在跑的任务。**没有框就不许说"已定"**。
 */
function marginStepVerdict() {
  const body = marginBodyPages();
  const undeterminedAll = body.filter(
    (page) => page.margin_box_mode === "auto" && !page.margin_box
  );
  // 「无文字」的页（识别跑过、确实没读出字）不算未定，也不挡完成——与收尾面板
  // / 步骤条的判定同源（backend review_status 用 pages_with_text + 成功运行）。
  const noText = undeterminedAll.filter(
    (page) => !pageHasFitLines(page) && pageRecognized(page)
  );
  const noTextIds = new Set(noText.map((page) => page.page_no));
  const undetermined = undeterminedAll.filter((page) => !noTextIds.has(page.page_no));
  const needFit = undetermined.filter(pageHasFitLines);
  const noLines = undetermined.filter((page) => !pageHasFitLines(page));
  const withLines = body.filter(pageHasFitLines);
  const settled = body.length - undetermined.length;
  let key = "partial";
  if (layoutDetectActive || marginFitRunning) key = "working";
  else if (!withLines.length) key = "unprepared";
  else if (!undetermined.length) key = "fitted";
  return {
    key, body, undetermined, undeterminedAll, needFit, noLines, noText,
    settled, withLines,
  };
}

/** 这一页有没有成功识别过（recognized / has_candidate 都算）。 */
function pageRecognized(page) {
  const status = recognitionOf(page).status;
  return status === "recognized" || status === "has_candidate";
}

/** 版心步的"一句话 + 一个数字 + 一个主按钮"。 */
function renderMarginStepVerdict() {
  if (!currentProject) return;
  const v = marginStepVerdict();
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
      state.textContent = layoutDetectActive ? "正在检测版面…" : "正在生成版心…";
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

/** 主按钮「全部确认」：把有行、还没框的页一次生成完，并报耗时。 */
async function confirmAllMargins() {
  if (!currentProject || marginFitRunning) return;
  await ensureMarginFitted({ manual: true });
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
  if (!currentProject || currentProject.kind === "package") {
    hint.hidden = true;
    return;
  }
  const verdict = marginStepVerdict();
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

/** 「⋯」里的检测入口：名字里带上还差多少页，点开先看计划再决定跑不跑。 */
function refreshLayoutDetectEntry() {
  const item = el("layout-detect-open");
  if (!item) return;
  if (!currentProject || currentProject.kind === "package") {
    item.hidden = true;
    return;
  }
  item.hidden = false;
  const undetermined = marginUndeterminedPages().length;
  item.textContent = undetermined
    ? `检测版面…（${undetermined} 页还没有版心）`
    : "检测版面…";
}


// ---------------------------------------------------------------- 第二引擎：可选，不挡流程
//
// 任务 58：完成判定只看主引擎；第二引擎是给审校的定位信号。进审校前如果它还没跑完，
// 要说清楚"队列还会变"，并给一个"等它跑完再进"的入口。

/** 这一轮已经选了"先开始审校"就不再拦（第二引擎跑完 / 切项目时重置）。 */
let auxWarningSkipped = false;
let auxWarningWaitToken = 0;

function engineState() {
  return (finishSummary && finishSummary.engine) || {};
}

function auxNeedsWarning() {
  const engine = engineState();
  if (!engine.total) return false;
  if (engine.aux_complete) {
    auxWarningSkipped = false;
    return false;
  }
  return !auxWarningSkipped;
}

function enterReviewStep() {
  showView("reading");
  const where = window.ReadingView ? window.ReadingView.getCurrent() : null;
  if (where && where.pageNo) savePosition("review", where.pageNo);
}

async function activeAuxJob() {
  if (!currentProject) return null;
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/jobs`);
    const active = data.active || null;
    if (active && active.job_type === "auxiliary") return active;
    return null;
  } catch {
    return null;
  }
}

async function openAuxWarning() {
  const engine = engineState();
  const done = Number(engine.checked || 0);
  const total = Number(engine.total || 0);
  const job = await activeAuxJob();
  const running = Boolean(job);
  el("aux-warning-title").textContent = running ? "还在跑" : "还没跑完";
  el("aux-warning-text").textContent = running
    ? `第二引擎复核还在跑（${done} / ${total} 页）。它跑完之前，审校队列的差异条数还会变，` +
      "建议等它跑完再开始审。"
    : `第二引擎复核还没跑完（${done} / ${total} 页）。现在开始审校，差异队列之后还会变` +
      "（它只会标出两路对不上的行，不改字）。";
  const wait = el("aux-warning-wait");
  wait.disabled = false;
  wait.textContent = running ? "等它跑完再进" : "跑第二引擎，跑完再进";
  el("aux-warning-error").hidden = true;
  openModal("aux-warning-mask");
}

/** 等第二引擎跑完（没在跑就先起一个），然后进审校。 */
async function waitForAuxThenReview() {
  const token = ++auxWarningWaitToken;
  const button = el("aux-warning-wait");
  const error = el("aux-warning-error");
  error.hidden = true;
  button.disabled = true;
  button.textContent = "正在准备…";
  let job = await activeAuxJob();
  try {
    if (!job) {
      const data = await apiJson(
        `/api/projects/${currentProject.project_id}/jobs/auxiliary`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "unchecked", skip_checked: true }),
        }
      );
      job = data.job;
      openTaskDrawer();
      startTaskPolling(job.job_id);
    }
  } catch (exc) {
    error.textContent = `第二引擎没能开始：${exc.message || "未知错误"}`;
    error.hidden = false;
    button.disabled = false;
    button.textContent = "重试";
    return;
  }
  button.textContent = "等待第二引擎…";
  // 自己轮询这个任务（不依赖抽屉），跑完再进审校
  for (let i = 0; i < 720; i += 1) {
    if (token !== auxWarningWaitToken) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let data;
    try {
      data = await apiJson(
        `/api/projects/${currentProject.project_id}/jobs/${job.job_id}`
      );
    } catch {
      continue;
    }
    const j = data.job || {};
    button.textContent = `等待第二引擎… ${j.done || 0}/${j.total || 0}`;
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(j.status)) {
      if (j.status !== "succeeded" && j.failed) {
        error.textContent =
          `第二引擎结束了（${j.done} 页成功、${j.failed} 页失败）。` +
          "可以先开始审校，失败的页之后在「文字识别」里重试。";
        error.hidden = false;
      }
      break;
    }
  }
  if (token !== auxWarningWaitToken) return;
  await loadFinishSummary({ silent: true });
  renderRecognitionStatus();
  closeModal("aux-warning-mask");
  enterReviewStep();
}

// ---------------------------------------------------------------- 字框回填（任务 59）
//
// 只补 block_line.word_boxes：文本 / 第二引擎 / 分歧裁决 / 跨页延续 / 版心都不动。
// 分批同步调用（每批 2 页，约 9 秒）；关掉对话框 = 停在当前批，再点就从没字框的行继续。

let wordBoxesPlan = null;
let wordBoxesRunning = false;

async function openWordBoxesDialog() {
  if (!currentProject) return;
  wordBoxesPlan = null;
  el("word-boxes-error").hidden = true;
  el("word-boxes-note").hidden = true;
  el("word-boxes-progress").hidden = true;
  el("word-boxes-plan").textContent = "正在读取回填计划…";
  el("word-boxes-start").disabled = true;
  openModal("word-boxes-mask");
  await refreshWordBoxesPlan();
}

async function refreshWordBoxesPlan() {
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/word-boxes`
    );
    wordBoxesPlan = data;
    renderWordBoxesPlan(data);
  } catch (error) {
    el("word-boxes-plan").textContent = `回填计划读取失败：${error.message || "未知错误"}`;
    el("word-boxes-start").disabled = true;
  }
}

function renderWordBoxesPlan(plan) {
  const cov = plan.coverage || {};
  const pages = Number(plan.pages || 0);
  const rows = [];
  rows.push(
    `<div class="layout-plan__row"><span>字框覆盖率</span><strong>${((cov.coverage || 0) * 100).toFixed(1)}%</strong></div>`
  );
  rows.push(
    `<div class="layout-plan__row"><span>还没有字框</span><strong>${pages} 页 · ${plan.lines || 0} 行</strong></div>`
  );
  if (pages) {
    rows.push(
      `<div class="layout-plan__row"><span>文字层取 / 要识别</span><strong>${plan.text_layer_pages || 0} / ${plan.ocr_pages || 0} 页</strong></div>`
    );
    rows.push(
      `<div class="layout-plan__row"><span>预计耗时</span><strong>${formatDuration(plan.estimated_seconds)}</strong></div>`
    );
  }
  el("word-boxes-plan").innerHTML = rows.join("");
  const note = el("word-boxes-note");
  note.textContent = pages
    ? "回填只写字框，不改任何文字与判定；中途关掉没关系，再点会从没字框的行继续。" +
      (plan.ocr_pages ? "需要识别的页会真的跑一遍识别（只取字框，不落库）。" : "")
    : "全书都有字框了。";
  note.hidden = false;
  const button = el("word-boxes-start");
  button.disabled = pages === 0 || wordBoxesRunning;
  button.textContent = pages ? `开始回填（${pages} 页）` : "没有要回填的行";
}

async function startWordBoxesBackfill() {
  if (!currentProject || wordBoxesRunning) return;
  wordBoxesRunning = true;
  el("word-boxes-error").hidden = true;
  el("word-boxes-progress").hidden = false;
  el("word-boxes-start").disabled = true;
  const button = el("word-boxes-start");
  button.textContent = "正在回填…";
  let donePages = 0;
  let matched = 0;
  let unmatched = 0;
  const totalPages = Number(wordBoxesPlan?.pages || 0);
  const startedAt = performance.now();
  try {
    while (true) {
      const data = await apiJson(
        `/api/projects/${currentProject.project_id}/word-boxes/backfill`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 2 }),
        }
      );
      donePages += Number(data.updated_pages || 0);
      matched += Number(data.lines_matched || 0);
      unmatched += Number(data.lines_unmatched || 0);
      const percent = totalPages ? Math.round((donePages / totalPages) * 100) : 0;
      el("word-boxes-fill").style.width = `${percent}%`;
      el("word-boxes-text").textContent =
        `已回填 ${donePages} / ${totalPages} 页 · 已配对 ${matched} 行 · 未配对 ${unmatched} 行`;
      if (!data.updated_pages) break;
      if (Number(data.remaining_pages || 0) === 0) break;
    }
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    el("word-boxes-text").textContent =
      `回填完成：${donePages} 页 · 配对 ${matched} 行 · 未配对 ${unmatched} 行 · ${seconds} 秒`;
    await refreshWordBoxesPlan();
    // 字框变了：让审校流下次打开时重新取块
    if (typeof pageBlockCache !== "undefined") pageBlockCache.clear();
  } catch (error) {
    el("word-boxes-error").textContent = `回填中断：${error.message || "未知错误"}`;
    el("word-boxes-error").hidden = false;
  } finally {
    wordBoxesRunning = false;
    button.textContent = "继续回填";
  }
}

async function clearWordBoxes() {
  if (!currentProject) return;
  const button = el("word-boxes-clear");
  button.disabled = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/word-boxes/clear`,
      { method: "POST" }
    );
    el("word-boxes-note").textContent = `已撤销：清掉 ${data.cleared_lines || 0} 行的字框（其它字段没动过）。`;
    el("word-boxes-note").hidden = false;
    await refreshWordBoxesPlan();
    if (typeof pageBlockCache !== "undefined") pageBlockCache.clear();
  } catch (error) {
    el("word-boxes-error").textContent = `撤销失败：${error.message || "未知错误"}`;
    el("word-boxes-error").hidden = false;
  } finally {
    button.disabled = false;
  }
}

function goToWorkflowStep(id) {
  if (!currentProject) return;
  if (currentProject.kind === "package" && id === "export") return;
  if (id === "export") {
    openExportPanel();
    return;
  }
  const wasPages = currentView === "pages";
  if (id === "review") {
    // 第二引擎没跑完时先警告（它只影响队列稳定，不阻塞流程，但要让人知情）
    if (auxNeedsWarning()) {
      openAuxWarning();
      return;
    }
    enterReviewStep();
  } else if (id === "index") {
    // 目录确认是单页预览：没手动改过缩放时给 100%（与页面视图的"单页"同一档）。
    if (!pageZoomTouched && pageZoomIndex < 3) pageZoomIndex = 3;
    showView("index");
  } else if (id === "preview") {
    // 结果预览是逐页读正文：没手动改过缩放时给 100%（与目录确认同一档），
    // 缩放仍然是 `pageZoomIndex` 同一份状态。
    if (!pageZoomTouched && pageZoomIndex < 3) pageZoomIndex = 3;
    showView("preview");
  } else {
    showView("pages");
    savePosition("pages", detailPageNo);
  }
  // showView 会先把当前步回落到视图默认值；点步骤的意图在它之后锁定。
  workflowStep = id;
  workflowStepPinned = true;
  // 进「版心确认」时给一个整页档（网格缩略图看不清四边，也不方便拖）；
  // 用户自己动过缩放就一律不动——切步骤不能把缩放跳回去。
  if (!pageZoomTouched && id === "margin" && pageZoomIndex === 0) {
    pageZoomIndex = 3;
    applyPageZoom();
  }
  syncWorkflowSteps();
}

/** 导出面板入口（原顶栏「导出」按钮，任务 36A 起由「文件导出」步骤取代）。 */
async function openExportPanel() {
  if (!currentProject) return;
  workflowStep = "export";
  workflowStepPinned = true;
  syncWorkflowSteps();
  openModal("export-panel");
  await refreshExportPreflight();
  await loadExports();
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
  if (id === "export-panel") {
    el("export-compare").hidden = true;
    // 关掉导出面板 ≠ 还站在「文件导出」这一步：回到当前视图的默认步。
    workflowStepPinned = false;
    syncWorkflowSteps();
  }
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
  // 步骤条 = 唯一导航（任务 36A）：点步骤切到对应的现有视图。
  el("workflow-steps").addEventListener("click", (event) => {
    const button = event.target.closest("[data-workflow-step]");
    if (button) goToWorkflowStep(button.dataset.workflowStep);
  });
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

  // 任务 72：页图档位表由服务端给（40/150/220/300），别在前端再写一份
  if (info.render_profiles && typeof info.render_profiles === "object") {
    renderProfiles = { ...renderProfiles, ...info.render_profiles };
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

  // 识别设置要按当前平台的引擎可用性置灰（Windows 上 Apple Vision 不可用）
  appInfo = info;
  renderRecognitionSettings();
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
    include_notes: el("export-include-notes").checked,
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
      .map(([type, count]) => `${BLOCK_TYPE_LABELS[type] || type} ${count}`)
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
  if (options.include_notes) parts.push("含注释");
  if (marginJudgementOn()) {
    parts.push("按版心判定正文");
  }
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
    projectExports = data.exports || [];
    renderExportHistory(projectExports);
    syncWorkflowSteps();
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
      " #export-page-markers, #export-include-notes," +
      " #export-rule-header, #export-rule-merge, #export-rule-hyphen," +
      " #export-rule-newlines, #export-rule-strip"
  )) {
    input.addEventListener("change", schedulePreflight);
  }
  el("export-range").addEventListener("input", schedulePreflight);
  el("export-margin-judgement").addEventListener("change", (event) =>
    setMarginJudgementSetting(event.target.checked)
  );
  const recMargin = el("rec-margin-judgement");
  if (recMargin) {
    recMargin.addEventListener("change", (event) =>
      setMarginJudgementSetting(event.target.checked)
    );
  }
  const marginNoticeOk = el("margin-judgement-notice-ok");
  if (marginNoticeOk) {
    marginNoticeOk.addEventListener("click", dismissMarginJudgementNotice);
  }
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

/** 正在打开项目（还没决定"回到哪个视图"）：这段时间不要自动切页面视图。 */
let bootingProject = false;

/** 项目库列表的最近一次结果（错误对话框里要写项目名）。 */
let libraryProjects = [];

/**
 * 页面工作流状态（任务 58）。键是 page_id；没有这个项目的状态时为空。
 * 只用于**显示与筛选**：检测 / 识别 / 导出仍各走各的，状态不驱动流程。
 */
let workflowByPageId = new Map();
let workflowSummary = null;
let workflowConfirmationCounts = { human: 0, auto: 0, unknown: 0 };
/** 页面视图「待处理」的页集合（来自 /review/pending，不在前端另算一套）。 */
let pendingPageNos = new Set();
let pendingPageCount = 0;

function workflowOf(page) {
  return page ? workflowByPageId.get(page.page_id) || null : null;
}

/**
 * 页面类型（五类，2026-10-22 用户拍板）：**去留由类型决定**，没有单独的纳入 / 排除开关。
 * 只有「正文」进识别与语料；其余四类都不进。
 */
const PAGE_TYPE_LABELS = {
  body: "正文", body_excluded: "正文排除", toc: "目录", front: "前置", back: "后置",
};
/**
 * 右栏类型列表的顺序（任务 54）：按书的自然顺序 前置 → 目录 → 正文 → 正文排除 → 后置。
 * 用户明确要求这个顺序，不再把最常用的放前面。
 */
const PAGE_TYPE_ORDER = ["front", "toc", "body", "body_excluded", "back"];

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

/**
 * 版面检测角标（任务 58）：只在"卡住了"的页上出现，避免和识别徽章重复。
 * 已检测但没识别 → 灰；检测失败 → 红并带原因。
 */
function workflowChip(page) {
  const workflow = workflowOf(page);
  if (!workflow) return null;
  if (workflow.failed_stage) {
    const chip = document.createElement("span");
    chip.className = "chip chip--bad";
    chip.textContent = `${workflow.failed_stage_label || "检测"}失败`;
    chip.title = workflow.failure_reason || "这一页的版面检测失败";
    return chip;
  }
  if (workflow.stage === "human_confirmed" && workflow.confirm_mode === "auto") {
    const chip = document.createElement("span");
    chip.className = "chip chip--warn";
    chip.textContent = "自动通过（未经人工）";
    chip.title = "满足自动通过的全部条件，只做了状态标记；点开审校正可以撤销。";
    return chip;
  }
  if (workflow.stage === "human_confirmed" && workflow.confirm_mode === "human") {
    const chip = document.createElement("span");
    chip.className = "chip chip--ok";
    chip.textContent = "人工已确认";
    chip.title = "有人打开这一页并点了「确认本页」。";
    return chip;
  }
  if (workflow.stage === "detected") {
    const chip = document.createElement("span");
    chip.className = "chip chip--gray";
    chip.textContent = "已检测 · 未识别";
    chip.title =
      `工作流：${workflow.stage_label}（${workflow.layout ? workflow.layout.line_count + " 行" : "无行"}）\n` +
      "只检测了行框，还没有识别文字。";
    return chip;
  }
  return null;
}

// ---------------------------------------------------------------- 分歧（说明书 8.5）

/** 页面载荷与块载荷都带 `divergence`（后端按"块里现在的文本"现算，见 blocks.py）。 */
function divergenceOf(thing) {
  return thing.divergence || {
    lines: 0, chars: 0, punct: 0, empty: 0, format_only: 0, acked: 0,
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

/**
 * 双引擎策略（任务 54）：`mark` 只标分歧（默认）/ `candidates` 分歧行给候选（原行为）。
 *
 * 这只影响**审校界面怎么显示**：数据里的 `aux_text` / `diff_status` 始终照写，
 * 换成候选的接口也一直在。两种策略都不会自动采用任何一方（实测第二引擎更弱）。
 */
function divergenceCandidatesOn() {
  const settings = (currentProject && currentProject.settings) || {};
  return settings.dual_engine_strategy === "candidates";
}

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
    libraryProjects = data.projects || [];
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
      chip.textContent = entry.lock_expired ? "锁已过期" : "使用中";
      chip.title = entry.lock_reason || "这个项目正被另一个窗口 / 另一台电脑打开";
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
      force.textContent = entry.lock_expired ? "接管并打开" : "强制打开";
      force.title = entry.lock_expired
        ? "这把锁已经过期（持有者进程不在了），接管不会影响项目数据"
        : "有让两台电脑同时写入同一数据库的风险";
      force.addEventListener("click", () => openProject(entry.project_id, { force: true }));
      actions.append(readOnly, force);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn--danger";
    remove.textContent = "删除";
    remove.title = "移入废纸篓，可在废纸篓恢复";
    remove.addEventListener("click", () => deleteProject(entry));
    actions.append(remove);

    card.append(cover, body, actions);
    list.append(card);
  });
}

// ---------------------------------------------------------------- 项目删除 / 废纸篓（任务 35）

async function deleteProject(entry) {
  if (
    !window.confirm(
      `确定删除《${entry.name}》？\n\n` +
        "项目会移入废纸篓，数据仍在磁盘上，可随时恢复。"
    )
  ) {
    return;
  }
  el("library-error").hidden = true;
  try {
    await apiJson(`/api/projects/${entry.project_id}?confirm=true`, { method: "DELETE" });
    await loadLibrary();
  } catch (error) {
    // 被 `.lock` 挡住时不能只甩一句"正在使用中"：说清是谁、什么时候、锁是不是已经过期，
    // 过期的锁给一个「强制删除」（后端 `?force=true` 只接受过期锁）。
    if (
      (error.code === "project_lock_expired" || error.code === "project_busy") &&
      error.data &&
      error.data.lock
    ) {
      showLockConflict(entry, error.data.lock, "delete");
      return;
    }
    showError(el("library-error"), error);
  }
}

// ---------------------------------------------------------------- 项目锁冲突（任务 60）
//
// 用户 2026-10-27 在删除项目时看到"该项目正被另一台电脑使用：MacBook-Air-2.local"，
// 而那台"电脑"就是本机改了名、锁是应用被强杀后留下的死锁。所以这里不再只说"被占用"：
//
//   来源 —— 本机 / 本机以前的名字 / 另一台电脑
//   时间 —— 最后一次心跳（多久以前）
//   状态 —— 进程已不存在（锁已过期） / 进程还在写
//
// 过期 → 可以强制删除（或强制打开）；真占用 → 不给强制，先说清要先关掉谁。

let lockConflictTarget = null;

function lockStampText(value) {
  if (!value) return "时间未知";
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return value.slice(0, 16);
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(then.getMonth() + 1)}-${pad(then.getDate())} ${pad(then.getHours())}:${pad(then.getMinutes())}`;
}

function lockSourceText(lock) {
  const host = lock.hostname || "未知主机";
  if (lock.host_note === "本机") return `${host}（本机）`;
  if (lock.host_note === "本机以前的名字") return `${host}（本机以前的名字）`;
  return `${host}（另一台电脑）`;
}

/** "12 天前" → "12 天"（写进"已经 N 天没有心跳"这种句子时不能带"前"）。 */
function lockSpanText(lock) {
  const text = String(lock.age_text || "").replace(/前$/, "");
  return text || "很久";
}

function lockStateText(lock) {
  if (!lock.expired) {
    return lock.host_note === "另一台电脑"
      ? "另一台电脑的心跳正常，它还在写这个项目"
      : `进程 ${lock.pid} 还在写这个项目`;
  }
  if (lock.host_note === "另一台电脑") {
    return `已经 ${lockSpanText(lock)}没有心跳，这把锁已过期`;
  }
  return `进程 ${lock.pid} 已不存在，这把锁已过期`;
}

/** 画"锁挡住操作"的对话框。`action` 是 "delete" 或 "open"。 */
function showLockConflict(entry, lock, action) {
  lockConflictTarget = { entry, lock, action };
  const expired = Boolean(lock && lock.expired);
  const force = el("lock-conflict-force");
  el("lock-conflict-error").hidden = true;
  el("lock-conflict-title").textContent = expired
    ? "这把锁已过期，可以直接接管"
    : "项目正被另一个窗口使用";
  el("lock-conflict-text").textContent = expired
    ? "锁的持有进程已经不在了，留着它只会一直挡住你。接管这把锁不会动项目里的任何数据。"
    : "同一个项目同时被两处写入可能损坏数据库，所以这里不能替你决定。";
  fillDefinitionList(el("lock-conflict-facts"), [
    ["项目", `《${entry.name}》`],
    ["来源", lockSourceText(lock)],
    ["时间", `${lockStampText(lock.last_seen_at)}${lock.age_text ? `（${lock.age_text}）` : ""}`],
    ["状态", lockStateText(lock)],
  ]);
  const advice = el("lock-conflict-advice");
  if (action === "delete") {
    advice.textContent = expired
      ? "删除只是把项目移入废纸篓，数据仍在磁盘上，可以随时恢复。"
      : "先在那个窗口里关闭项目（或退出应用），再回来删除。";
  } else {
    advice.textContent = expired
      ? "确认那台电脑已经不再打开这个项目，再接管；接管后会以本机的锁继续。"
      : "如果那个窗口确实是你自己开的，请回那个窗口继续，别同时开两个。";
  }
  // 删除只对"过期锁"给强制；真占用一律不给。打开这条路本来就有「强制打开」。
  force.hidden = action === "open" ? false : !expired;
  force.textContent = action === "open" ? "强制打开" : "强制删除";
  openModal("lock-conflict-mask");
}

async function confirmLockConflict() {
  const target = lockConflictTarget;
  if (!target) return;
  const button = el("lock-conflict-force");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = target.action === "open" ? "正在打开…" : "正在删除…";
  el("lock-conflict-error").hidden = true;
  try {
    if (target.action === "open") {
      closeModal("lock-conflict-mask");
      await openProject(target.entry.project_id, { force: true });
    } else {
      await apiJson(
        `/api/projects/${target.entry.project_id}?confirm=true&force=true`,
        { method: "DELETE" }
      );
      closeModal("lock-conflict-mask");
      await loadLibrary();
    }
  } catch (error) {
    showError(el("lock-conflict-error"), error);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function closeLockConflict() {
  lockConflictTarget = null;
  closeModal("lock-conflict-mask");
}

async function openTrashPanel() {
  el("trash-error").hidden = true;
  openModal("trash-panel");
  await loadTrash();
}

async function loadTrash() {
  const list = el("trash-list");
  list.innerHTML = "";
  try {
    const data = await apiJson("/api/trash");
    el("trash-empty").hidden = data.projects.length > 0;
    for (const entry of data.projects) {
      const row = document.createElement("li");
      row.className = "trash-row";
      const main = document.createElement("div");
      main.className = "trash-row__main";
      const name = document.createElement("div");
      name.className = "trash-row__name";
      name.textContent = `《${entry.name}》`;
      const meta = document.createElement("div");
      meta.className = "trash-row__meta";
      meta.textContent =
        `${entry.page_count} 页` +
        (entry.source_file_name ? ` · ${entry.source_file_name}` : "") +
        ` · 删除于 ${formatMarginTime(entry.deleted_at) || "未知时间"}` +
        (entry.deleted_by ? ` · ${entry.deleted_by}` : "");
      main.append(name, meta);

      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "btn";
      restore.textContent = "恢复";
      restore.addEventListener("click", () => restoreTrashProject(entry));

      const purge = document.createElement("button");
      purge.type = "button";
      purge.className = "btn btn--danger";
      purge.textContent = "彻底删除";
      purge.addEventListener("click", () => purgeTrashProject(entry));

      row.append(main, restore, purge);
      list.append(row);
    }
  } catch (error) {
    showError(el("trash-error"), error);
  }
}

async function restoreTrashProject(entry) {
  el("trash-error").hidden = true;
  try {
    await apiJson(`/api/trash/${entry.project_id}/restore`, { method: "POST" });
    await loadTrash();
    await loadLibrary();
  } catch (error) {
    showError(el("trash-error"), error);
  }
}

async function purgeTrashProject(entry) {
  if (
    !window.confirm(
      `彻底删除《${entry.name}》？\n\n` +
        "项目文件夹会被真正删除，无法恢复。确认继续吗？"
    )
  ) {
    return;
  }
  el("trash-error").hidden = true;
  try {
    await apiJson(`/api/trash/${entry.project_id}?confirm=true`, { method: "DELETE" });
    await loadTrash();
  } catch (error) {
    showError(el("trash-error"), error);
  }
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
  bootingProject = true;

  try {
    const opened = await apiJson(
      `/api/projects/${projectId}/open?force=${force}&read_only=${readOnly}`,
      { method: "POST" }
    );
    // 打开项目的提示（强制接管了过期锁 / 覆盖了死锁 / 有任务被中断）先存着：
    // 下面 `loadLibrary()` 会用 `hidden = true` 清掉提示条，必须等它跑完再显示。
    const openWarning = opened.warning || "";
    // 注释流是这次导出的选项，不是项目设置：每次打开项目回到"不导出"的默认。
    // 必须在 refreshProject 之前复位——它会立刻发一次导出预检，用的是这个复选框的值。
    el("export-include-notes").checked = false;
    // 任务 62：步骤条的数字来自 finish-summary，它和项目载荷**并行**取，
    // 不要排在后面（490 页的书光项目载荷就 1.2 s）。返回后 `syncWorkflowSteps` 会再画一次。
    const finishPrefetch = loadFinishSummary({ silent: true });
    await refreshProject(projectId);
    // 任务 62：步骤条的数字只等 finish-summary。**先把它等到、把步骤条点亮**，
    // 再去开「上次的视图」——审校视图要组装整本导出预览（490 页实测 7 s），
    // 先跑它会把 finish-summary 饿在 CPU 后面，步骤条十几秒才亮。
    await finishPrefetch;
    applyProjectSettings();
    syncWorkflowSteps();
    await loadAutoApplyStatus();
    pagesOverlayOn = loadPageOverlayPreference();
    pagesMarginOn = loadPageMarginPreference();
    setupSuggestionsLoaded = false;
    setupSuggestions = [];
    // 识别收尾 / 打开项目时服务端会算一次版心；项目载荷里直接带着最近一次建议，
    // 不需要用户再点「推算版心」才知道建议是什么。
    marginSuggestion = currentProject.margin_box_suggestion || null;
    // 任务 36B：撤销栈与"已试过拟合"的页只对当前项目有意义。
    marginUndoStack.length = 0;
    marginFitTried.clear();
    lastStepPanelKey = null;
    pageZoomTouched = false;
    renderRecognitionSettings();
    reviewMarginOn = loadReviewMarginPreference();
    reviewBlockFilter = "pending";
    el("pages-overlay-toggle").classList.toggle("is-on", pagesOverlayOn);
    el("pages-margin-toggle").classList.toggle("is-on", pagesMarginOn);
    el("review-margin-toggle").classList.toggle("is-on", reviewMarginOn);
    // refreshProject 可能已经渲染过页面视图；默认"开"是在那之后才读出来的。
    // 任务 63：页面缩略图会立刻开始拉图（490 页要几十秒 CPU），所以也排到步骤条之后。
    queueAfterSteps(() => schedulePageVisibility());
    await loadLibrary();
    if (openWarning) {
      const warning = el("library-warning");
      warning.textContent = openWarning;
      warning.hidden = false;
    }
    // 说明书 7.2：打开项目默认回到上次的位置（上次在审校就回审校那一页）
    await resumeLastPosition();
    bootingProject = false;
  } catch (error) {
    bootingProject = false;
    if (
      (error.code === "project_lock_expired" || error.code === "project_busy") &&
      error.data &&
      error.data.lock
    ) {
      showLockConflict({ project_id: projectId, name: currentProjectName(projectId) }, error.data.lock, "open");
      return;
    }
    showError(el("library-error"), error);
  }
}

/** 错误对话框里要写项目名：项目列表已经加载过，查一下就行。 */
function currentProjectName(projectId) {
  const cached = (libraryProjects || []).find((item) => item.project_id === projectId);
  if (cached) return cached.name;
  if (currentProject && currentProject.project_id === projectId) return currentProject.name;
  return projectId;
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
    // L 刀：正文审校已经是阅读流，不再回到旧的单页审校视图
    showView("reading");
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
  // 任务 63：页面工作流角标、导出预检、导出记录都只属于某个视图，
  // 这里不再开机就拉（490 页实测这三样 6 s+，把步骤条饿到十几秒）。
  // 它们由 `hydrateView()` 在真正切到那个视图时加载。
  resetViewHydration();
  stepsReady = false;
  bootQueue = [];
  renderProject();
  // 任务可能还在跑（比如刷新了页面），把抽屉里的进度接回来
  await loadTasks();
  // 质量统计（说明书 8.5 / 13.4）：数字多、算起来比页面列表重；
  // 任务 63：排到步骤条点亮之后再拉
  queueAfterSteps(() => loadSummary());
  // 步骤条需要收尾面板与导出记录；这里补一次，避免只在页面视图里才加载
  await loadFinishSummary({ silent: true });
  syncWorkflowSteps();
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
  projectSummary = data;
  renderSummary(data);
  syncWorkflowSteps();
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
  // 任务 63：打开项目时**不要**先切到页面视图——那会把页面工作流 / 状态 / 建议
  // 三个重请求都拉起来，然后马上又被"上次的视图"切走。等 resumeLastPosition 决定。
  if (currentView === "library" && !bootingProject) showView("pages");
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
/** 版心视图开关（默认关，按项目记住）。打开后压暗版心外、画出版心框。 */
let pagesMarginOn = false;

/**
 * 块框开关按项目记住；存在 localStorage，不写项目数据库。
 *
 * 键从 v1 升到 v2：v1 的默认值是"关"，老用户存着 "0"；直接改默认值对他们无效。
 * 换新键后所有人重新体验一次"默认开"，关掉后仍按项目记住。
 */
function pageOverlayStorageKey() {
  return currentProject ? `b2t.pagesOverlay.v2.${currentProject.project_id}` : "";
}

function loadPageOverlayPreference() {
  try {
    const stored = localStorage.getItem(pageOverlayStorageKey());
    return stored === null ? true : stored === "1"; // 没存过 = 默认开
  } catch {
    return true;
  }
}

function savePageOverlayPreference() {
  try {
    localStorage.setItem(pageOverlayStorageKey(), pagesOverlayOn ? "1" : "0");
  } catch {
    /* 隐私模式等写不进去：不影响本次会话 */
  }
}

/**
 * 版心视图开关也按项目记住（与块框开关分开存：它们看的是两件事）。
 *
 * 任务 53 起默认**开**：版心会随识别自动算出来，用户要求"页面视图与审校视图都应该显示"，
 * 再让每次打开都先点一下开关就本末倒置了。用户关过一次就记住"关"（显式存 "0"）。
 */
function pageMarginStorageKey() {
  return currentProject ? `b2t.pagesMargin.v1.${currentProject.project_id}` : "";
}

function loadPageMarginPreference() {
  try {
    return localStorage.getItem(pageMarginStorageKey()) !== "0";
  } catch {
    return true;
  }
}

function savePageMarginPreference() {
  try {
    localStorage.setItem(pageMarginStorageKey(), pagesMarginOn ? "1" : "0");
  } catch {
    /* 隐私模式等写不进去：不影响本次会话 */
  }
}

/**
 * 一页实际生效的版心（与后端 `effective_margin_box` 同一口径）：
 * `none` → 无；`custom` → 本页；`auto` → **本页落库的框**（没有就是未定，
 * 绝不拿项目默认框顶替，任务 33）；`inherit` → 项目默认。
 */
function marginBoxOfPage(page) {
  if (!page || page.margin_box_mode === "none") return null;
  if (page.margin_box_mode === "custom") return page.margin_box || null;
  if (page.margin_box_mode === "auto") return page.margin_box || null;
  return (currentProject && currentProject.margin_box) || null;
}

/** auto 页的框是哪来的：fit（迭代拟合）/ bbox（本页包围盒兜底）/ 未定。 */
function pageMarginMethod(page) {
  if (!page || page.margin_box_mode !== "auto") return null;
  if (!page.margin_box) return "undetermined";
  return page.margin_box_method || "fit";
}

function pageMarginSourceLabel(page) {
  if (!page) return "";
  if (page.margin_box_mode === "none") return "不适用";
  if (page.margin_box_mode === "custom") return "本页自定义";
  if (page.margin_box_mode === "auto") {
    const method = pageMarginMethod(page);
    if (method === "undetermined") {
      return pageHasFitLines(page)
        ? "未定（有正文行，还没拟合）"
        : "未定（没有可用的正文行）";
    }
    if (method === "bbox") return "本页包围盒（兜底）";
    return "自动拟合";
  }
  return "沿用默认版心";
}

/** 审校视图的版心开关也按项目记住；默认开（任务 53：自动算出来就该直接显示）。 */
function reviewMarginStorageKey() {
  return currentProject ? `b2t.reviewMargin.v1.${currentProject.project_id}` : "";
}

function loadReviewMarginPreference() {
  try {
    return localStorage.getItem(reviewMarginStorageKey()) !== "0";
  } catch {
    return true;
  }
}

function saveReviewMarginPreference() {
  try {
    localStorage.setItem(reviewMarginStorageKey(), reviewMarginOn ? "1" : "0");
  } catch {
    /* 隐私模式等写不进去：不影响本次会话 */
  }
}

/** 块的几何中心（与导出 `block_center` 同口径）；没有框返回 null。 */
function blockCenter(block) {
  const bbox = block && block.bbox;
  if (!bbox || bbox.length !== 4) return null;
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

/**
 * 块的中心点是否在版心内（任务 53 的审校过滤）。
 *
 * 与导出第一层**同一规则**：看中心点，不看"框完全包含"；没有 bbox 的块按版心内处理
 * （宁可多审一块，也不把文字藏起来）；没有生效版心时全部算"版心内"（不隐藏任何块）。
 */
function blockInsideMargin(block, page) {
  const box = marginBoxOfPage(page);
  if (!box) return true;
  const center = blockCenter(block);
  if (!center) return true;
  return (
    center[0] >= box[0] && center[0] <= box[2] &&
    center[1] >= box[1] && center[1] <= box[3]
  );
}

/**
 * 任务 34：这一块是否计入审校口径（默认只审版心内）。
 * 后端页详情已经按同一函数算好 `margin_inside`；老响应没有这个字段时退回本地判断。
 */
function blockCountedInMargin(block, page) {
  if (block && typeof block.margin_inside === "boolean") return block.margin_inside;
  return blockInsideMargin(block, page || detailPageRecord());
}

/** 一页的块按版心内外分组（保持原有顺序；没有版心时全是"内"）。 */
function reviewMarginSplit(page, blocks) {
  const box = marginBoxOfPage(page);
  const inside = [];
  const outside = [];
  if (!box) return { box: null, inside: [...blocks], outside };
  for (const block of blocks) {
    (blockCountedInMargin(block, page) ? inside : outside).push(block);
  }
  return { box, inside, outside };
}

/** 当前审校页的项目记录（版心三态在 `currentProject.pages` 上）。 */
function detailPageRecord() {
  if (!currentProject || detailPageNo === null) return null;
  return currentProject.pages.find((item) => item.page_no === detailPageNo) || null;
}

/** 全局版心是不是自动推算的（决定审校里画虚线框、面板里提示"未确认"）。 */
function globalMarginIsAuto() {
  return Boolean(currentProject && currentProject.margin_box_source === "auto");
}

/**
 * 自动版心是不是**暂时不准**（页太少 / 不可靠）。
 *
 * 刚识别 2–3 页时（尤其前几页是扉页 / 版权页），自动框可能只框住半页。
 * 这时审校**默认不按它隐藏块**：宁可多列几块，也不能让正文被一个还没站稳的框藏起来。
 * 用户点过「版心内」就按用户的来；识别页数攒够后自动框不再"暂时"，默认回到版心内。
 */
function autoMarginProvisional(page) {
  if (!globalMarginIsAuto()) return false;
  if (page && page.margin_box_mode === "custom") return false;
  if (page && page.margin_box_mode === "auto" && page.margin_box) return false;
  const suggestion = currentProject ? currentProject.margin_box_suggestion : null;
  if (!suggestion) return true;
  const pages = Number(suggestion.pages || 0);
  return pages < 10 || !suggestion.reliable;
}

/** 实际生效的过滤档位（"暂时不准"的自动框 + 用户没点过 → 显示全部）。 */
function effectiveReviewFilter(page) {
  if (
    reviewBlockFilter === "inside" &&
    !reviewFilterExplicit &&
    autoMarginProvisional(page)
  ) {
    return "all";
  }
  return reviewBlockFilter;
}

// ---------------------------------------------------------------- 右栏四分区（任务 54）
//
// 页面设置 → 版心设置 → 页码设置 → 识别设置。每个分区是一个 <details>，
// 折叠状态按项目记在 localStorage（不写项目数据库：这是界面偏好，不是项目内容）。

// ---------------------------------------------------------------- 识别设置（任务 54）
//
// 项目级设置：引擎 / DPI / 语言 / 双引擎策略。服务端在**建识别任务时**读取它们
// （`recognition.create_ocr_job`），并写进任务参数；不是只存不用。

const RECOGNITION_DEFAULTS = {
  recognition_engine: "rapidocr",
  recognition_dpi: 200,
  recognition_language: "ch",
  dual_engine_strategy: "mark",
};
const RECOGNITION_ENGINE_LABELS = {
  rapidocr: "RapidOCR",
  apple_vision: "Apple Vision",
  dual: "双引擎比对",
};

/** 应用信息（`/api/app/info`）：用来判断 Apple Vision 在当前平台可不可用。 */
let appInfo = null;

function recognitionSetting(key) {
  const settings = (currentProject && currentProject.settings) || {};
  const value = settings[key];
  return value === undefined || value === null ? RECOGNITION_DEFAULTS[key] : value;
}

function engineProbe(engineId) {
  const probes = (appInfo && appInfo.engines && appInfo.engines.probes) || [];
  return probes.find((probe) => probe.engine_id === engineId) || null;
}

let recStatusTimer = null;

function setRecognitionStatus(text, isError = false) {
  const node = el("rec-status");
  if (!node) return;
  node.textContent = text || "";
  node.hidden = !text;
  node.style.color = isError ? "var(--bad-fg)" : "";
  if (recStatusTimer) clearTimeout(recStatusTimer);
  if (text) {
    recStatusTimer = setTimeout(() => {
      node.hidden = true;
    }, 6000);
  }
}

/** 把当前项目设置画进识别设置控件；不可用的引擎置灰并说明原因。 */
function renderRecognitionSettings() {
  if (!el("rec-engine")) return;
  const engine = String(recognitionSetting("recognition_engine"));
  const dpi = Number(recognitionSetting("recognition_dpi"));
  const language = String(recognitionSetting("recognition_language"));
  const strategy = String(recognitionSetting("dual_engine_strategy"));

  const vision = engineProbe("apple_vision");
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
    `${RECOGNITION_ENGINE_LABELS[engine] || engine} · ${dpi} DPI` +
    (engine === "dual" ? ` · ${strategy === "candidates" ? "给候选" : "只标分歧"}` : "");
}

/** 改一项识别设置：先写服务端，成功再更新本地；失败回显原值。 */
async function patchRecognitionSetting(key, value) {
  if (!currentProject) return;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/settings`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      }
    );
    currentProject.settings = data.settings || {
      ...(currentProject.settings || {}),
      [key]: value,
    };
    renderRecognitionSettings();
    setRecognitionStatus("已保存，下一次识别按新设置执行");
  } catch (error) {
    renderRecognitionSettings(); // 回显服务端的真实值
    setRecognitionStatus(error.message || "设置没保存成功", true);
    showError(el("pages-error"), error);
  }
}

function setupRecognitionSettings() {
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


/** 当前在视口内的页（块框只给这些页渲染）。 */
const visiblePageNos = new Set();
/**
 * 块数据缓存：`项目:页号` → blocks。
 *
 * 块数据很小（几十个块的类型与 bbox），80 页约几百 KB；缓存大一点，
 * 来回滚动时才不用重新请求。上限仍然要有，避免整本 400 页都留在内存里。
 */
const pageBlockCache = new Map();
const pageBlockCacheOrder = [];
/**
 * 每页块数据的"作废代次"。
 *
 * 增量刷新 / 识别完成时把它 +1：**在此之后返回的旧请求结果一律丢掉**。
 * 没有这一层，识别刚完成时一个早发的空结果会盖掉新的块，用户就得等下一次刷新。
 */
const pageBlockVersions = new Map();
const pageBlockPending = new Set();
const PAGE_BLOCK_CACHE_LIMIT = 80;
// 网格档可见页多：每帧最多真正画 3 页；离屏立刻清。
const PAGE_OVERLAY_FRAME_LIMIT = 3;
// 同时在途的块请求上限（只读、按页独立）。预取只能占其中一部分，
// 否则滚过去的页会把视口里真正要看的页的请求挤在后面。
const PAGE_BLOCK_FETCH_LIMIT = 6;
const PAGE_BLOCK_PREFETCH_LIMIT = 4;
const PAGE_BLOCK_PREFETCH_BURST = 8;
let pageBlockPrefetchInFlight = 0;
const overlayRenderQueue = [];
const overlayRenderQueued = new Set();
let overlayPumpScheduled = false;

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
    return { suggestions: [], page_numbers: [], note: null };
  }
  if (!force && pageSuggestionCache.has(pageNo)) {
    return pageSuggestionCache.get(pageNo);
  }
  const data = await apiJson(
    `/api/projects/${currentProject.project_id}/pages/${pageNo}/block-suggestions`
  );
  const payload = {
    suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
    // 页码提示与类型建议分开：块类型已经是 header 时也要能拆出页码
    page_numbers: Array.isArray(data.page_numbers) ? data.page_numbers : [],
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
  // 任务 43：角标建议只有页面视图用得到。审校 / 预览里不再发起新请求——
  // 否则正在审校时后台还在逐页跑 block-suggestions，一次按键要等几秒。
  // 已经在飞的请求（最多 PAGE_SUGGESTION_CONCURRENCY 个）会自己结束；
  // 回到页面视图时 showView 再把它接上。
  if (currentView !== "pages") return;
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

function scanVisiblePageSuggestions() {
  suggestionScanTimer = null;
  if (!currentProject || currentView !== "pages" || pageZoomIndex >= 2) return;
  const grid = el("page-grid");
  if (!grid) return;
  const scroller = pageScroller();
  const metrics =
    scroller && pageTileMetrics && pageTileMetrics.length === grid.querySelectorAll(".page-tile").length
      ? pageTileMetrics
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

/** 页面确认模式：汇总、建议与「确认所选」都在这个模式里出现。 */
let setupSuggestions = [];
let setupSuggestionsLoading = false;
let setupSuggestionsLoaded = false;

function visiblePages() {
  const project = currentProject;
  if (!project) return [];
  const typeFilter = el("filter-type").value;
  const recognitionFilter = el("filter-recognition").value;
  const workflowFilter = el("filter-workflow").value;
  const triageFilter = el("filter-triage").value;
  const onlyIncluded = el("pages-only-included").checked;

  return project.pages.filter((page) => {
    if (onlyIncluded && !page.include) return false;
    if (typeFilter && page.page_type !== typeFilter) return false;
    const recognition = recognitionOf(page);
    if (recognitionFilter && recognition.status !== recognitionFilter) return false;
    if (workflowFilter && !matchesWorkflow(page, workflowFilter)) return false;
    if (triageFilter && !matchesTriage(page, recognition, triageFilter)) return false;
    return true;
  });
}

/** 工作流筛选（任务 58）：状态只用于显示 / 筛选，不改变识别与导出。 */
function matchesWorkflow(page, kind) {
  const workflow = workflowOf(page);
  if (kind === "pending") return pendingPageNos.has(page.page_no);
  if (kind === "auto_passed") return Boolean(workflow && workflow.confirm_mode === "auto");
  if (kind === "human_confirmed") return Boolean(workflow && workflow.confirm_mode === "human");
  if (kind === "failed") return Boolean(workflow && workflow.failed_stage);
  if (!workflow) return false;
  if (kind === "unfinished") {
    return ["page_unconfirmed", "confirmed", "detected"].includes(workflow.stage);
  }
  return workflow.stage === kind;
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
  if (kind === "layout_unconfirmed") return !page.layout_confirmed;
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

/** 全选当前筛选（保留筛选外已选的页）。 */
function selectAllVisiblePages() {
  const pages = visiblePages();
  if (!pages.length) return;
  for (const page of pages) selectedPages.add(page.page_no);
  if (selectionAnchor === null) selectionAnchor = pages[0].page_no;
  renderPages();
}

/** 取消全选（当前筛选内外的选择一起清掉）。 */
function clearPageSelection() {
  if (!selectedPages.size) return;
  selectedPages.clear();
  selectionAnchor = null;
  renderPages();
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
  const selected = selectionPages();
  const numbers = [...selectedPages].sort((left, right) => left - right);
  const bodySelected = selected.filter((page) => page.include);
  const pendingBody = bodySelected.filter(
    (page) => recognitionOf(page).status === "unrecognized"
  );
  const pendingAll = currentProject
    ? currentProject.pages.filter(
        (page) => page.include && recognitionOf(page).status === "unrecognized"
      )
    : [];
  const stats = pageSetupStats();

  el("selection-count").textContent = count ? `已选 ${count} 页` : "未选择页面";
  const range = el("selection-range");
  if (!numbers.length) {
    range.textContent = "";
  } else if (numbers.length === 1) {
    const page = selected[0];
    const type = PAGE_TYPE_LABELS[page.page_type] || page.page_type;
    range.textContent =
      `第 ${numbers[0]} 页 · ${type} · ${page.page_confirmed ? "已确认" : "待确认"} · ` +
      RECOGNITION_LABELS[recognitionOf(page).status] || "";
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
      const type = PAGE_TYPE_LABELS[page.page_type] || page.page_type;
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
  if (workflowStep === "margin") {
    if (count !== 1) {
      next.textContent = "在左边点一页：版心框会画在页面上，四边 / 四角可拖";
    } else {
      const page = selected[0];
      const hasBox =
        Boolean(marginBoxOfPage(page)) || page.margin_box_mode === "none";
      if (page.margin_box_mode === "none") {
        next.textContent = "这一页标了「不适用版心」，整页都按正文处理";
      } else if (hasBox) {
        next.textContent =
          pageMarginMethod(page) === "bbox"
            ? "版心是本页正文行的包围盒（兜底）；拖动四边调整，不改也算已定"
            : "版心已按本页正文行生成；拖动四边调整，不改也算已定";
      } else if (pageHasFitLines(page)) {
        next.textContent = "这一页有正文行但还没有版心：点「重置为本页自动」重新生成";
      } else {
        // 两条文案都不许跟步骤顺序绑死（顺序还要调）：只说"没有行、所以生成不了"
        next.textContent =
          "这一页还没有可用的正文行（识别行 / 检测行都没有），版心暂时生成不了";
      }
    }
  } else if (workflowStep === "recognition") {
    next.textContent = count
      ? "识别完成后，去「正文审校」逐条看差异"
      : "这一步只看识别状态；差异在「正文审校」里逐条看";
  } else if (!count) {
    if (stats.unconfirmed > 0) {
      next.textContent = `${stats.unconfirmed} 页未确认 → 先确认页面类型`;
    } else if (pendingAll.length) {
      next.textContent = `${pendingAll.length} 页未识别 → 可以直接识别`;
    } else {
      next.textContent = "页面都准备好了，可以审校或导出";
    }
  } else if (count === 1) {
    const page = selected[0];
    if (!page.page_confirmed) next.textContent = "下一步：确认这一页算不算正文";
    else if (recognitionOf(page).status === "unrecognized") {
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

  // 底部主操作条：只算正文页；未选择时是"识别全部未识别页"。
  const primary = el("selection-recognize");
  const note = el("selection-primary-note");
  if (!count) {
    primary.textContent = pendingAll.length
      ? `识别全部未识别页（${pendingAll.length}）`
      : "没有待识别的页";
    primary.disabled = pendingAll.length === 0;
    note.textContent = pendingAll.length
      ? "全书动作；识别前可先排除封面 / 空白页"
      : "所有正文页都已识别";
  } else if (!bodySelected.length) {
    primary.textContent = "所选页都不是正文";
    primary.disabled = true;
    note.textContent = "把类型改成「正文」后才会出现在这里";
  } else {
    primary.textContent = `识别所选正文 ${bodySelected.length} 页`;
    primary.disabled = bodySelected.length === 0;
    const skipped = count - bodySelected.length;
    note.textContent = skipped
      ? `另 ${skipped} 页不是正文，会跳过`
      : pendingBody.length
        ? `其中 ${pendingBody.length} 页未识别`
        : "所选正文页都已识别；点击会重新识别";
  }
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
// ---------------------------------------------------------------- 页面网格

/** 页面上该显示的门牌（类型 / 印张 / 状态），构建与刷新共用。 */
function tileTitle(page) {
  const workflow = workflowOf(page);
  const workflowNote = workflow
    ? `\n工作流：${workflow.stage_label}${workflow.layout ? ` · ${workflow.layout.line_count} 行` : ""}`
    : "";
  const marginNote = `\n版心：${pageMarginSourceLabel(page)}`;
  return (
    `第 ${page.page_no} 页 · ${PAGE_TYPE_LABELS[page.page_type] || page.page_type}` +
    ` · ${page.width_pt}×${page.height_pt} pt` +
    (page.rotation ? ` · 旋转 ${page.rotation}°` : "") +
    workflowNote +
    marginNote +
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

  // 版心框（默认隐藏）：框外压暗、8 个把手可拖。放在块框 overlay 之前，
  // 这样打开块框时色框画在压暗层上面，两者可以同时看。
  const margin = document.createElement("div");
  margin.className = "page-margin";
  margin.hidden = true;
  const marginBox = document.createElement("div");
  marginBox.className = "page-margin__box";
  for (const edge of ["n", "s", "w", "e", "nw", "ne", "sw", "se"]) {
    const handle = document.createElement("span");
    handle.className = `page-margin__handle page-margin__handle--${edge}`;
    handle.dataset.edge = edge;
    handle.title = "拖动调整版心（会吸附到正文行边界）";
    handle.addEventListener("pointerdown", (event) =>
      startTileMarginDrag(event, page.page_no, marginBox, edge)
    );
    marginBox.append(handle);
  }
  margin.append(marginBox);

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
  thumb.append(image, margin, overlay, check, suggestMark, actions);

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
  const workflow = workflowChip(page);
  if (workflow) status.append(workflow);
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
  el("setup-confirm-selected").disabled = selectedPages.size === 0;
  el("setup-confirm-all").disabled = stats.unconfirmed === 0;
  el("setup-confirm-all").textContent = `全书… 确认全部未确认页（${stats.unconfirmed}）`;
  updateSelectionPanel();
  renderTypePicker();
  renderSuggestionPanel();
  initPanelAccordion();
  renderStepPanels();
  if (finishSummaryProject !== currentProject.project_id) {
    loadFinishSummary({ silent: true });
  }
}

let panelAccordionProject = null;

/** 默认展开"第一个未完成"的分区：未确认 → 版心 → 识别；都完成就留在页面类型。 */
function firstUnfinishedPanel() {
  const pages = currentProject ? currentProject.pages : [];
  if (pages.some((page) => !page.page_confirmed)) return "page-type";
  const bodyPages = pages.filter((page) => page.include);
  if (bodyPages.some((page) => page.margin_box_mode !== "none" && !marginBoxOfPage(page))) {
    return "margin";
  }
  if (bodyPages.some((page) => recognitionOf(page).status === "unrecognized")) {
    return "recognition";
  }
  return "page-type";
}

/** 右栏手风琴：一次只开一个；折叠状态按项目记，默认落在第一个未完成的分区。 */
function initPanelAccordion() {
  if (!currentProject) return;
  const groups = [...document.querySelectorAll("#setup-panel details[data-panel]")];
  if (!groups.length) return;
  const key = `b2t.panel.accordion.v1.${currentProject.project_id}`;
  if (panelAccordionProject !== currentProject.project_id) {
    panelAccordionProject = currentProject.project_id;
    let saved = null;
    try {
      saved = localStorage.getItem(key);
    } catch {
      saved = null;
    }
    const open = groups.find((group) => group.dataset.panel === saved) ||
      groups.find((group) => group.dataset.panel === firstUnfinishedPanel()) ||
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
    await loadSetupSuggestions();
  } catch (error) {
    showError(el("pages-error"), error);
  }
}

function confirmSelectedPages() {
  const ids = selectionPages().map((page) => page.page_id);
  if (!ids.length) {
    const hint = el("selection-hint");
    hint.textContent = "先在左边网格里选几页，或点「全书… 确认全部未确认页」。";
    hint.hidden = false;
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
    const hint = el("selection-hint");
    hint.textContent = "所有页面都已确认。";
    hint.hidden = false;
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

/**
 * 页图档位（任务 62）。
 *
 * 审校 / 目录确认的页图原来是固定 150 DPI（`view`）：447pt 宽的页渲染成约 931 px，
 * 而 Retina 屏上这一页显示约 880 CSS px = **1760 设备像素**，等于放大 2 倍，所以糊。
 * 现在按设备像素比选档：Retina + 够宽的窗口用 `zoom`（300 DPI），否则还是 `view`。
 * 体积靠 JPEG q=82 压下来（view 0.22 MB / zoom 0.62 MB，PNG 分别要 1.77 MB / 约 7 MB）。
 */
/** 页图档位 → DPI；启动时用 `/api/app/info` 的值覆盖（前后端只留一份真值）。 */
let renderProfiles = { thumb: 40, view: 150, mid: 220, zoom: 300 };
/** 清晰度：auto = 按实际需要的像素选档；standard / high = 用户手动钉住。 */
let imageQualityMode = "auto";
const IMAGE_PROFILE_ORDER = ["view", "mid", "zoom"];

/** 某一档在一页上渲染出来的**像素宽度**（页面宽度 pt → px）。 */
function profileWidthPx(profile, widthPt) {
  const dpi = Number(renderProfiles[profile] || 150);
  return Math.round(((Number(widthPt) || 612) / 72) * dpi);
}

function pageWidthPt(pageNo) {
  const page = currentProject
    ? (currentProject.pages || []).find((item) => item.page_no === pageNo)
    : null;
  return page ? Number(page.width_pt) || 612 : 612;
}

/**
 * 按"这张图实际要显示多少设备像素"选档（任务 72）。
 *
 * **上一版用窗口宽度判断是错的**：真正决定清晰度的是容器 CSS 宽度 × devicePixelRatio。
 * 实测（612pt 页、dpr 2、目录确认）：940px 窗口 + 140% 缩放时容器 830 CSS px、
 * 需要 1660 设备像素，而规则给了 `view`（1275px）→ **比例 0.77，被拉大 1.3 倍**。
 * 现在按比例选：需要 1660 → 取 `mid`（1870px），比例 1.13。
 */
function detailImageProfile(cssWidth, widthPt) {
  if (imageQualityMode === "standard") return "view";
  if (imageQualityMode === "high") return "zoom";
  const dpr = Number(window.devicePixelRatio || 1);
  const need = Math.max(0, Number(cssWidth) || 0) * dpr;
  if (!need) return "view";
  for (const profile of IMAGE_PROFILE_ORDER) {
    if (profileWidthPx(profile, widthPt) >= need) return profile;
  }
  return "zoom";
}

/** 对一个页块取档：量它的 CSS 宽，配这一页的 pt 宽。 */
function pageProfileFor(element, pageNo) {
  const cssWidth = measureCssWidth(element);
  return detailImageProfile(cssWidth, pageWidthPt(pageNo));
}

/**
 * 量一个元素"将来会显示成多宽"（CSS px）。
 *
 * 优先 `getBoundingClientRect`；隐藏 / 还没布局时退回 `offsetWidth`、父元素宽度，
 * 最后按视口估一个（宁可给高一档，也不要因为量到 0 而拿到最模糊的图）。
 */
function measureCssWidth(element) {
  if (!element) return 0;
  const rect = element.getBoundingClientRect();
  if (rect.width > 1) return rect.width;
  const offset = element.offsetWidth || 0;
  if (offset > 1) return offset;
  const parent = element.parentElement;
  if (parent) {
    const parentRect = parent.getBoundingClientRect();
    if (parentRect.width > 1) return parentRect.width;
  }
  return Math.max(320, Number(window.innerWidth || 0) * 0.5);
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

/**
 * 丢掉一页的块缓存（识别刚完成、重新识别、块被换掉之后用）。
 *
 * 同时把这一页的"作废代次" +1：没有它，一个早发晚到的旧响应会在作废之后
 * 又把旧块写回缓存，用户就得等下一次刷新才能看到新的框。
 * 这一页的块类型建议也一起丢掉——块都变了，建议得重算。
 */
function forgetAllPageBlocks() {
  pageBlockCache.clear();
  pageBlockCacheOrder.length = 0;
  for (const tile of document.querySelectorAll("#page-grid .page-tile")) {
    clearPageBlocks(tile);
  }
}

function forgetPageBlocks(pageNo) {
  const key = pageBlockKey(pageNo);
  pageBlockVersions.set(key, (pageBlockVersions.get(key) || 0) + 1);
  pageBlockCache.delete(key);
  const index = pageBlockCacheOrder.indexOf(key);
  if (index >= 0) pageBlockCacheOrder.splice(index, 1);
  forgetPageSuggestions(pageNo);
}

let pageScrollListening = false;
let pageScrollScheduled = false;
// 瓷砖在滚动内容里的位置：渲染 / 缩放时缓存一次，滚动时不再每帧量 267 个矩形。
let pageTileMetrics = null;

function pageScroller() {
  return el("page-grid")?.closest(".split__main") || null;
}

function capturePageTileMetrics() {
  const scroller = pageScroller();
  const grid = el("page-grid");
  if (!scroller || !grid) {
    pageTileMetrics = null;
    return;
  }
  const tiles = [...grid.querySelectorAll(".page-tile")];
  if (!tiles.length) {
    pageTileMetrics = null;
    return;
  }
  // 页面视图还没显示时（打开项目、从审校切过来之前）所有矩形都是 0：
  // 那样量出来的"每一页都在视口里"会让 267 页同时排队请求块数据，
  // 框画出来又被下一帧当成离屏清掉——用户看到的就是"块框迟迟不出来"。
  // 宁可不记，等视图可见后的下一次可见性计算再量（见 updatePageVisibility）。
  if (tiles[0].getBoundingClientRect().height <= 0) {
    pageTileMetrics = null;
    return;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  const scrollTop = scroller.scrollTop;
  pageTileMetrics = tiles.map((tile) => {
    const rect = tile.getBoundingClientRect();
    return {
      tile,
      pageNo: Number(tile.dataset.pageNo),
      top: rect.top - scrollerRect.top + scrollTop,
      height: rect.height,
    };
  });
}

function ensurePageScrollListener() {
  if (pageScrollListening) return;
  const scroller = pageScroller();
  (scroller || window).addEventListener("scroll", schedulePageVisibility, { passive: true });
  window.addEventListener("resize", () => {
    pageTileMetrics = null;
    schedulePageVisibility();
  });
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
  if (!currentProject) return;
  const scroller = pageScroller();
  if (!scroller) return;
  const grid = el("page-grid");
  const tiles = grid.querySelectorAll(".page-tile");
  if (!pageTileMetrics || pageTileMetrics.length !== tiles.length) {
    capturePageTileMetrics();
  }
  // 视图还没显示（openProject 里先渲染、再切视图）时量不出位置：等下一次。
  if (!pageTileMetrics) return;

  const large = pageZoomIndex >= 2;
  const scrollTop = scroller.scrollTop;
  const viewport = scroller.clientHeight;
  const nearLimit = 1400;
  const near = new Set();
  // 预取带：视口上下各约 1.5 屏。滚动的过程中就先把这一带的块数据拉回来，
  // 停下来时框已经在缓存里，不用等一轮网络。最多只排 PAGE_BLOCK_PREFETCH_BURST 页。
  const prefetchBand = Math.max(400, Math.min(1800, Math.round(viewport * 1.5)));
  const prefetchCandidates = [];
  let drawnSynchronously = 0;
  const byPage = new Map(currentProject.pages.map((page) => [page.page_no, page]));

  for (const item of pageTileMetrics) {
    const top = item.top;
    const bottom = top + item.height;
    const pageNo = item.pageNo;
    const isVisible = bottom > scrollTop - 60 && top < scrollTop + viewport + 60;
    if (isVisible) {
      visiblePageNos.add(pageNo);
      // 建议角标只为可见页算；大图档在可见性循环里算，网格档走 debounce 的 scan
      if (large) ensurePageSuggestion(pageNo);
      if (pagesMarginOn) {
        const page = byPage.get(pageNo);
        paintTileMargin(item.tile, page);
        // 单列 / 单页里拖版心要吸附到行边界：只给眼前这几页补块数据。
        // 网格档一屏十几页，不为"可能拖一下"给整屏发请求；有块缓存时照样吸附。
        if (large && page && recognitionOf(page).status === "recognized") {
          const key = pageBlockKey(pageNo);
          if (!pageBlockCache.has(key) && !pageBlockPending.has(key)) {
            fetchPageBlocks(pageNo, key);
          }
        }
      }
      if (pagesOverlayOn) {
        // 先画后补：数据已经在缓存里就这一帧直接画，不等下一个 rAF。
        // 仍然限量（每帧最多 PAGE_OVERLAY_FRAME_LIMIT 页），密集网格不会爆。
        const key = pageBlockKey(pageNo);
        const cached = pageBlockCache.get(key);
        const overlay = item.tile.querySelector(".page-overlay");
        if (
          cached &&
          overlay &&
          overlay._renderedBlocks !== cached &&
          drawnSynchronously < PAGE_OVERLAY_FRAME_LIMIT
        ) {
          renderPageBlocks(item.tile, cached);
          drawnSynchronously += 1;
        } else {
          queueOverlayRender(pageNo);
        }
      }
    } else {
      visiblePageNos.delete(pageNo);
      clearPageBlocks(item.tile);
      clearTileMargin(item.tile);
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
  for (const item of pageTileMetrics) {
    if (near.has(item.pageNo)) continue;
    visiblePageNos.delete(item.pageNo);
    const image = item.tile.querySelector("img");
    if (image) image.removeAttribute("src");
    clearPageBlocks(item.tile);
    clearTileMargin(item.tile);
  }
}

/**
 * 滚动中提前拉块数据：只挑**已识别**的页，按离视口由近到远，
 * 一次最多排 PAGE_BLOCK_PREFETCH_BURST 页；视口内的页优先（distance = 0）。
 */
function pumpPageBlockPrefetch(candidates) {
  if (!currentProject || currentView !== "pages" || !pagesOverlayOn || !candidates.length) return;
  if (pageBlockPending.size >= PAGE_BLOCK_FETCH_LIMIT) return;
  if (pageBlockPrefetchInFlight >= PAGE_BLOCK_PREFETCH_LIMIT) return;
  candidates.sort((a, b) => a.distance - b.distance);
  let byPage = null;
  let started = 0;
  for (const candidate of candidates) {
    if (started >= PAGE_BLOCK_PREFETCH_BURST) break;
    if (pageBlockPrefetchInFlight >= PAGE_BLOCK_PREFETCH_LIMIT) break;
    if (pageBlockPending.size >= PAGE_BLOCK_FETCH_LIMIT) break;
    const key = pageBlockKey(candidate.pageNo);
    if (pageBlockCache.has(key) || pageBlockPending.has(key)) continue;
    if (!byPage) byPage = new Map(currentProject.pages.map((page) => [page.page_no, page]));
    const page = byPage.get(candidate.pageNo);
    // 没识别过的页没有块：不为它们发请求，否则掠过整本书就是一串空响应
    if (!page || recognitionOf(page).status !== "recognized") continue;
    started += 1;
    fetchPageBlocks(candidate.pageNo, key, { prefetch: true });
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
  // 块框四档都可用：网格档只画色框（不画顺序号），单列 / 单页才带顺序号
  el("pages-overlay-toggle").disabled = false;
  el("pages-overlay-toggle").classList.toggle("is-on", pagesOverlayOn);
  // 版心视图四档都能看；单列 / 单页拖动更顺手
  el("pages-margin-toggle").disabled = false;
  el("pages-margin-toggle").classList.toggle("is-on", pagesMarginOn);

  const tiles = [...grid.querySelectorAll(".page-tile")];
  const byPage = new Map(currentProject.pages.map((page) => [page.page_no, page]));
  visiblePageNos.clear();
  resetOverlayQueue();

  if (pageZoomIndex >= 2) {
    for (const tile of tiles) {
      clearPageBlocks(tile);
      const pageNo = Number(tile.dataset.pageNo);
      const image = tile.querySelector("img");
      if (!image) continue;
      image.loading = "eager";
      image.dataset.largeSrc = pageImageUrl(pageNo, level.image);
      image.removeAttribute("src");
    }
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
    // 网格 / 大网格档的建议角标仍按"滚动停下再扫"的节奏
    ensureSuggestionScrollListener();
    scheduleSuggestionScan();
  }

  ensurePageScrollListener();
  pageTileMetrics = null;
  capturePageTileMetrics();
  updatePageVisibility();
}

function setPageZoom(delta) {
  const next = Math.min(
    PAGE_ZOOM_LEVELS.length - 1,
    Math.max(0, pageZoomIndex + delta)
  );
  if (next === pageZoomIndex) return;
  // 用户自己改过缩放之后，切步骤不再按"每步默认缩放"动它（任务 36B）。
  pageZoomTouched = true;
  pageZoomIndex = next;
  applyPageZoom();
}

function togglePageBlocksOverlay() {
  pagesOverlayOn = !pagesOverlayOn;
  savePageOverlayPreference();
  el("pages-overlay-toggle").classList.toggle("is-on", pagesOverlayOn);
  if (pagesOverlayOn) {
    for (const pageNo of visiblePageNos) queueOverlayRender(pageNo);
    schedulePageVisibility();
  } else {
    resetOverlayQueue();
    for (const tile of el("page-grid").querySelectorAll(".page-tile")) {
      clearPageBlocks(tile);
    }
  }
  syncIndexToggles();
  if (currentView === "index") paintIndexDecorations();
}

function resetOverlayQueue() {
  overlayRenderQueue.length = 0;
  overlayRenderQueued.clear();
}

/** 排队画一页的块框：已画过且缓存没变就跳过。 */
function queueOverlayRender(pageNo) {
  if (!currentProject || !pagesOverlayOn || !visiblePageNos.has(pageNo)) return;
  const tile = el("page-grid").querySelector(`.page-tile[data-page-no="${pageNo}"]`);
  const overlay = tile ? tile.querySelector(".page-overlay") : null;
  const blocks = pageBlockCache.get(pageBlockKey(pageNo));
  if (blocks && overlay && overlay._renderedBlocks === blocks) return;
  if (overlayRenderQueued.has(pageNo)) return;
  overlayRenderQueued.add(pageNo);
  overlayRenderQueue.push(pageNo);
  scheduleOverlayPump();
}

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
  if (!currentProject || !pagesOverlayOn) return;
  let drawn = 0;
  let waiting = false;
  while (drawn < PAGE_OVERLAY_FRAME_LIMIT && overlayRenderQueue.length) {
    const pageNo = overlayRenderQueue.shift();
    overlayRenderQueued.delete(pageNo);
    if (!visiblePageNos.has(pageNo)) continue;
    const tile = el("page-grid").querySelector(`.page-tile[data-page-no="${pageNo}"]`);
    const overlay = tile ? tile.querySelector(".page-overlay") : null;
    if (!tile || !overlay) continue;
    const key = pageBlockKey(pageNo);
    const blocks = pageBlockCache.get(key);
    if (blocks) {
      if (overlay._renderedBlocks !== blocks) {
        renderPageBlocks(tile, blocks);
        drawn += 1;
      }
      continue;
    }
    if (pageBlockPending.has(key)) continue;
    if (pageBlockPending.size >= PAGE_BLOCK_FETCH_LIMIT) {
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

function fetchPageBlocks(pageNo, key, { prefetch = false } = {}) {
  pageBlockPending.add(key);
  if (prefetch) pageBlockPrefetchInFlight += 1;
  const version = pageBlockVersions.get(key) || 0;
  apiJson(`/api/projects/${currentProject.project_id}/pages/${pageNo}/blocks`)
    .then((data) => {
      // 请求在途期间这一页被作废了（识别刚完成、重新识别）：结果是旧的，丢掉重拉
      if ((pageBlockVersions.get(key) || 0) !== version) {
        if (pagesOverlayOn && visiblePageNos.has(pageNo)) queueOverlayRender(pageNo);
        return;
      }
      rememberPageBlocks(key, data.blocks || []);
      if (pagesOverlayOn && visiblePageNos.has(pageNo)) queueOverlayRender(pageNo);
    })
    .catch(() => {
      // 块框是辅助信息，读不到不该打断翻页
    })
    .finally(() => {
      pageBlockPending.delete(key);
      if (prefetch) pageBlockPrefetchInFlight = Math.max(0, pageBlockPrefetchInFlight - 1);
      if (pagesOverlayOn) scheduleOverlayPump();
    });
}


function renderPageBlocks(tile, blocks, { details = pageZoomIndex >= 2 } = {}) {
  const overlay = tile.querySelector(".page-overlay");
  if (!overlay) return;
  overlay.innerHTML = "";
  overlay._renderedBlocks = blocks;
  overlay._lineBboxes = [];
  // 网格 / 大网格：只画色框。缩略图上 11px 的顺序号看不清，画了只是噪声。
  const showDetails = details;
  let count = 0;
  for (const block of blocks) {
    if (!block.bbox) continue;
    const box = document.createElement("div");
    box.className = `box box--type-${block.block_type}`;
    if (!block.include) box.classList.add("box--excluded");
    if (block.review_status === "uncertain") box.classList.add("box--uncertain");
    box._bbox = block.bbox;
    // 任务 57：悬停联动靠它把"这一段的行"映射到"左边的块框"
    if (block.block_id) box.dataset.blockId = block.block_id;
    applyBoxElementRect(box, block.bbox);
    const index = block.order_index;
    box.title = `${boxTypeLabel(block)} · 第 ${index + 1} 块`;
    if (showDetails) {
      // 与审校视图同一套规则：颜色 + 顺序号，悬停才出类型卡片
      box.append(buildBoxOrder(index));
      box.append(buildBoxLabel(block, index, null));
    }
    overlay.append(box);
    count += 1;
  }
  overlay.hidden = count === 0;
  if (!showDetails || !count) return;
  observeOverlaySize(overlay);
  // 同步摆一次，别等 rAF：块框刚画出来时可能正赶上滚动 / 缩放，晚一帧就会看到没摆好的号
  layoutOverlayAnnotations(overlay);
  scheduleOverlayLayout(overlay);
}

function clearPageBlocks(tile) {
  const overlay = tile.querySelector(".page-overlay");
  if (!overlay) return;
  // 离屏清理每帧都会调用：本来就空就别再写 DOM
  if (!overlay._renderedBlocks && overlay.hidden) return;
  overlay.innerHTML = "";
  overlay.hidden = true;
  overlay._renderedBlocks = null;
}

// ---------------------------------------------------------------- 版心视图
//
// 用户的设计（2026-10-23）：大多数书的正文都在版心里，页眉 / 页脚 / 页码在版心外。
// 所以先确认"正文在哪一块"，比每页改二三十个块省力。
// 这一刀只做**看得见、调得动**：版心不影响组装 / 导出 / 识别 / 块类型。

/** 拖动版心边时离文字行边界多近就吸附（像素，与块框同一口径）。 */
const MARGIN_SNAP_PX = 8;
/** 版心最短边（归一化）：再小就没有"正文区"的意义了。 */
const MIN_MARGIN_SIDE = 0.02;
const MARGIN_MODE_LABELS = {
  auto: "自动拟合", inherit: "沿用默认", custom: "本页自定义", none: "不适用",
};

let tileMarginDrag = null;
let marginSuggestion = null;
let marginAuditPage = null;
let marginAuditLoading = false;

function applyMarginRect(boxEl, box) {
  if (!boxEl) return;
  const [x0, y0, x1, y1] = box;
  boxEl.style.left = `${x0 * 100}%`;
  boxEl.style.top = `${y0 * 100}%`;
  boxEl.style.width = `${(x1 - x0) * 100}%`;
  boxEl.style.height = `${(y1 - y0) * 100}%`;
}

/** 画一页的版心框；没有生效版心（不适用 / 未设置）就收起来。 */
function paintTileMargin(tile, page) {
  const margin = tile ? tile.querySelector(".page-margin") : null;
  if (!margin) return;
  if (!pagesMarginOn || !page) {
    clearTileMargin(tile);
    return;
  }
  const box = marginBoxOfPage(page);
  margin.classList.toggle("page-margin--custom", page.margin_box_mode === "custom");
  margin.classList.toggle("page-margin--inherit", page.margin_box_mode !== "custom");
  // 版心开着时块框只作参考（悬停卡片让位给拖拽把手）
  const overlay = tile.querySelector(".page-overlay");
  if (overlay) overlay.classList.add("page-overlay--margin");
  if (!box) {
    margin.hidden = true;
    margin._box = null;
    return;
  }
  // 滚动时每帧都会走到这里：框没变就别再写样式（267 页滚动时不值得为同样的值刷 DOM）
  const same =
    margin._box &&
    box.length === margin._box.length &&
    box.every((value, index) => Math.abs(value - margin._box[index]) < 1e-6);
  margin._box = box;
  margin._pageNo = page.page_no;
  if (same && !margin.hidden) return;
  applyMarginRect(margin.querySelector(".page-margin__box"), box);
  margin.hidden = false;
}

function clearTileMargin(tile) {
  const margin = tile ? tile.querySelector(".page-margin") : null;
  if (!margin) return;
  const overlay = tile.querySelector(".page-overlay");
  if (overlay) overlay.classList.remove("page-overlay--margin");
  if (margin.hidden && !margin._box) return;
  margin.hidden = true;
  margin._box = null;
}

function toggleMarginView() {
  pagesMarginOn = !pagesMarginOn;
  savePageMarginPreference();
  const button = el("pages-margin-toggle");
  if (button) button.classList.toggle("is-on", pagesMarginOn);
  if (!currentProject) return;
  if (pagesMarginOn) {
    schedulePageVisibility();
  } else {
    for (const tile of document.querySelectorAll("#page-grid .page-tile")) {
      clearTileMargin(tile);
    }
  }
  syncIndexToggles();
  if (currentView === "index") paintIndexDecorations();
  renderMarginPanel();
}

/** 这一页所有识别行的边界（吸附用）。块缓存里就带着 `lines`。 */
function pageLineEdges(pageNo) {
  const blocks = pageBlockCache.get(pageBlockKey(pageNo)) || [];
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
    if (mode.includes("w")) x0 = nearestEdge(x0, edges.xs, toleranceX);
    if (mode.includes("e")) x1 = nearestEdge(x1, edges.xs, toleranceX);
    if (mode.includes("n")) y0 = nearestEdge(y0, edges.ys, toleranceY);
    if (mode.includes("s")) y1 = nearestEdge(y1, edges.ys, toleranceY);
  }
  return clampMarginBox([x0, y0, x1, y1]);
}

function startTileMarginDrag(event, pageNo, boxEl, mode) {
  if (!pagesMarginOn || !currentProject) return;
  if (event.button !== undefined && event.button !== 0) return;
  const page = currentProject.pages.find((item) => item.page_no === pageNo);
  const box = page ? marginBoxOfPage(page) : null;
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
  applyMarginRect(drag.boxEl, box);
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

function setupMarginDrag() {
  window.addEventListener("pointermove", onMarginPointerMove);
  window.addEventListener("pointerup", onMarginPointerUp);
  window.addEventListener("pointercancel", onMarginPointerUp);
}

/** 把接口返回的一页合并进本地列表（保留识别状态 / 审校进度等派生字段）。 */
function mergePageRecord(updated) {
  if (!currentProject || !updated) return;
  const index = currentProject.pages.findIndex((page) => page.page_id === updated.page_id);
  if (index >= 0) {
    currentProject.pages[index] = { ...currentProject.pages[index], ...updated };
  }
}

function repaintTileMargin(page) {
  if (!page || !currentProject) return;
  const tile = document.querySelector(
    `#page-grid .page-tile[data-page-no="${page.page_no}"]`
  );
  if (tile) paintTileMargin(tile, page);
}

/** 全局版心变了：只重画可见页（267 页全扫一遍没必要，可见性循环会兜底）。 */
function refreshMarginTiles() {
  if (!currentProject) return;
  const byPage = new Map(currentProject.pages.map((page) => [page.page_no, page]));
  for (const tile of document.querySelectorAll("#page-grid .page-tile")) {
    const pageNo = Number(tile.dataset.pageNo);
    if (pagesMarginOn && visiblePageNos.has(pageNo)) {
      paintTileMargin(tile, byPage.get(pageNo));
    } else {
      clearTileMargin(tile);
    }
  }
}

let marginStatusTimer = null;

function setMarginStatus(text, isError = false, holdMs = 9000) {
  const node = el("margin-status");
  if (!node) return;
  node.textContent = text || "";
  node.hidden = !text;
  node.style.color = isError ? "var(--bad-fg)" : "";
  if (marginStatusTimer) clearTimeout(marginStatusTimer);
  if (text) {
    marginStatusTimer = setTimeout(() => {
      node.hidden = true;
    }, holdMs);
  }
}

/**
 * 拖动保存（任务 36B）：松手才写一次库，**一律标 `mode=custom`**。
 *
 * 为什么自动页拖过也要变 custom：用户在自动框上调了四边，这个结果必须在下一次
 * 「自动拟合」时保住；只要 mode 还是 auto，重拟合就会把它冲掉。
 * 撤销走内存里的 `marginUndoStack`（一次拖动 = 一步）。
 */
async function savePageMargin(pageNo, box) {
  const page = currentProject
    ? currentProject.pages.find((item) => item.page_no === pageNo)
    : null;
  if (!page) return;
  const previousMode = page.margin_box_mode;
  if (previousMode === "none") return;
  marginUndoStack.push({
    pageNo,
    mode: previousMode,
    box: page.margin_box ? [...page.margin_box] : null,
  });
  trimMarginUndo();
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${pageNo}/margin-box`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ margin_box_mode: "custom", margin_box: box }),
      }
    );
    mergePageRecord(data.page);
    repaintTileMargin(data.page);
    setMarginStatus(
      `第 ${pageNo} 页的版心已保存（本页自定义）；` +
        (previousMode === "custom" ? "" : "自动拟合不会再覆盖它。")
    );
    renderMarginPanel();
  } catch (error) {
    marginUndoStack.pop();
    // 存不上就把框画回原值，别让界面上留着一个没保存的框
    repaintTileMargin(page);
    showError(el("pages-error"), error);
  }
}

// ---------------------------------------------------------------- 版心右栏

function percentOf(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatMarginBox(box) {
  if (!box) return "未设置";
  return `左 ${percentOf(box[0])} · 上 ${percentOf(box[1])} · 右 ${percentOf(box[2])} · 下 ${percentOf(box[3])}`;
}

/** 时间戳 → "10-23 08:04"（本地时区）；解析不了就原样显示。 */
function formatMarginTime(raw) {
  if (!raw) return "";
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return raw;
  return when.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 全局版心的来源说明（自动推算 / 手动设置），显示在右栏。 */
/** 默认版心的来源说明（只给显式「沿用默认」的页看，一行就够）。 */
function marginSourceText() {
  if (!currentProject || !currentProject.margin_box) return "";
  if (globalMarginIsAuto()) {
    const when = formatMarginTime(currentProject.margin_box_set_at);
    return `自动推算${when ? ` · ${when}` : ""}`;
  }
  return "手动设置";
}

/**
 * 版心未定的依据说明：**这一页到底有没有行**，说清楚。
 * 两处（面板首屏 / 审计回包）共用一句，免得后到的审计把首屏的实话盖回去。
 */
function marginBasisForUndetermined(page) {
  const lines = pageLayoutLines(page) + pageTextLines(page);
  if (lines > 0) {
    return `未定：这一页有 ${lines} 行正文，但还没有拟合出四边（「重置为本页自动」可重算）`;
  }
  return "未定：这一页还没有可用的正文行（检测行 / 识别行框都没有），拟合不出版心";
}

async function ensureMarginAudit(page) {
  const node = el("margin-audit");
  if (!node || !currentProject || !page) return;
  if (marginAuditPage === page.page_no && !marginAuditLoading) return;
  marginAuditPage = page.page_no;
  marginAuditLoading = true;
  node.hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${page.page_no}/margin-box/audit`
    );
    if (marginAuditPage !== page.page_no) return;
    const basis = el("margin-basis");
    const linesWord = data.lines_source === "layout" ? "检测行" : "识别行";
    if (basis && page.margin_box_mode === "auto") {
      const total = Number(data.total_lines || 0);
      const method = pageMarginMethod(page);
      if (method === "undetermined") {
        basis.textContent = marginBasisForUndetermined(page);
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
    marginAuditLoading = false;
  }
}

/**
 * 版心右栏（任务 36B 重写）。
 *
 * 只回答三件事：这一页现在的框是什么、怎么改回去、撤销。
 * 没有模式选择卡片，也没有折叠的「检测」按钮；进这一步时未定的页会自动拟合。
 */
function renderMarginPanel() {
  if (!currentProject) return;
  renderMarginStepVerdict();

  // 默认版心只作一行说明：现在每页用自己的检测行拟合，默认框只在显式「沿用默认」的页上生效。
  const defaultNode = el("margin-default");
  if (defaultNode) {
    const globalBox = currentProject.margin_box;
    defaultNode.textContent = globalBox
      ? `默认版心（只给「沿用默认」的页）：${formatMarginBox(globalBox)}` +
        (marginSourceText() ? ` · ${marginSourceText()}` : "")
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

  const selected = selectionPages();
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
  state.textContent = `第 ${page.page_no} 页 · 来源：${pageMarginSourceLabel(page)}`;
  const box = marginBoxOfPage(page);
  badge.hidden = false;
  const method = pageMarginMethod(page);
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
          ? marginBasisForUndetermined(page)
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

// ---------------------------------------------------------------- 版面块（页面确认步）
//
// 任务 36B：块类型建议与「确认本页版面」属于第 1 步（这页算不算正文、哪些块算正文），
// 以前混在审校视图里；现在页面确认步直接看得到，不用先切到版心或审校。
// 建议仍然**只读**：点「采用」才写 `block_type`（走正常块编辑接口，可撤销）。

let layoutBlockPage = null;
let layoutBlockLoading = false;
let layoutBlockPayload = null;

function layoutBlockPageRecord() {
  if (!currentProject) return null;
  const selected = selectionPages();
  return selected.length === 1 ? selected[0] : null;
}

function scheduleLayoutBlocks(force = false) {
  const page = layoutBlockPageRecord();
  if (!page) {
    layoutBlockPage = null;
    layoutBlockPayload = null;
    renderLayoutBlocks();
    return;
  }
  if (!force && layoutBlockPage === page.page_no && layoutBlockPayload) {
    renderLayoutBlocks();
    return;
  }
  loadLayoutBlocks(page.page_no);
}

async function loadLayoutBlocks(pageNo, { forceSuggestions = false } = {}) {
  if (!currentProject || currentProject.kind === "package") return;
  layoutBlockPage = pageNo;
  layoutBlockLoading = true;
  layoutBlockPayload = null;
  renderLayoutBlocks();
  try {
    // 先读块：块数与版面确认状态是本地数据，界面立刻有东西看。
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${pageNo}/blocks`
    );
    if (layoutBlockPage !== pageNo) return;
    layoutBlockPayload = {
      pageNo,
      blocks: Array.isArray(data.blocks) ? data.blocks : [],
      layoutConfirmed: Boolean(data.page && data.page.layout_confirmed),
      suggestions: [],
      suggestionsLoading: true,
    };
    layoutBlockLoading = false;
    renderLayoutBlocks();
    // 块类型建议要扫全书的重复项，慢一点（真书 2–5 秒）：
    // 有缓存先用缓存，采用 / 改类型之后再用 forceSuggestions 重算。
    const suggestions = await fetchPageSuggestions(pageNo, {
      force: forceSuggestions,
    }).catch(() => ({ suggestions: [] }));
    if (layoutBlockPage !== pageNo || !layoutBlockPayload) return;
    layoutBlockPayload = {
      ...layoutBlockPayload,
      suggestions: (suggestions && suggestions.suggestions) || [],
      suggestionsLoading: false,
    };
  } catch (error) {
    layoutBlockPayload = null;
    showError(el("pages-error"), error);
  } finally {
    layoutBlockLoading = false;
    renderLayoutBlocks();
  }
}

function renderLayoutBlocks() {
  const summary = el("layout-block-summary");
  const body = el("layout-block-body");
  const hint = el("layout-block-hint");
  const list = el("layout-block-suggestions");
  if (!summary || !body) return;
  if (!currentProject || currentProject.kind === "package") {
    summary.textContent = "";
    body.hidden = true;
    if (hint) hint.hidden = true;
    return;
  }
  const page = layoutBlockPageRecord();
  if (!page) {
    summary.textContent = "选一页查看";
    body.hidden = true;
    if (hint) hint.hidden = false;
    return;
  }
  summary.textContent = layoutBlockLoading
    ? "读取中…"
    : layoutBlockPayload
      ? layoutBlockPayload.suggestionsLoading
        ? `${layoutBlockPayload.blocks.length} 块 · 建议读取中…`
        : `${layoutBlockPayload.blocks.length} 块 · 高把握 ${highConfidenceCount(layoutBlockPayload.suggestions)}`
      : `第 ${page.page_no} 页`;
  if (layoutBlockLoading || !layoutBlockPayload) {
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
  const payload = layoutBlockPayload;
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
      `建议：${BLOCK_TYPE_LABELS[item.suggested_type] || item.suggested_type}`;
    const confidence = document.createElement("span");
    confidence.className = `chip setup-confidence setup-confidence--${item.confidence}`;
    confidence.textContent = item.confidence === "high" ? "把握较大" : "需确认";
    const adopt = document.createElement("button");
    adopt.type = "button";
    adopt.className = "btn btn--sm";
    adopt.textContent = "采用";
    adopt.title = `把这一块改成「${BLOCK_TYPE_LABELS[item.suggested_type] || item.suggested_type}」（可撤销）`;
    adopt.addEventListener("click", () => adoptBlockSuggestion(item, adopt));
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

function highConfidenceCount(suggestions) {
  return (suggestions || []).filter((item) => item.confidence === "high").length;
}

async function confirmLayoutFromPanel() {
  const page = layoutBlockPageRecord();
  if (!page || !currentProject) return;
  const button = el("layout-block-confirm");
  button.disabled = true;
  try {
    await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${page.page_no}/layout/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_numbers: [page.page_no] }),
      }
    );
    await refreshPageStates();
    await loadLayoutBlocks(page.page_no);
    await loadFinishSummary({ silent: true });
    setMarginStatus(`第 ${page.page_no} 页版面已确认。`);
  } catch (error) {
    button.disabled = false;
    showError(el("pages-error"), error);
  }
}

// ---------------------------------------------------------------- 文字识别（只读状态）
//
// 任务 36B：这一步只给数字（识别 / 第二引擎 / 差异），不在右栏做差异裁决；
// 裁决在「正文审校」。识别设置保留在下面折叠，否则引擎 / DPI 没有入口。

function renderRecognitionStatus() {
  const metrics = el("rec-status-metrics");
  const summary = el("rec-status-summary");
  if (!metrics) return;
  const pages = (projectSummary && projectSummary.pages) || {};
  const divergence = (projectSummary && projectSummary.divergence) || {};
  const engine = (finishSummary && finishSummary.engine) || {};
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
          ` · 标点级 ${divergence.punct || 0} · 分歧率 ${percentText(divergence.diverging_rate)}`
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
function renderRecognitionVerdict() {
  if (!currentProject) return;
  const body = marginBodyPages();
  const recognized = body.filter((page) =>
    ["recognized", "has_candidate"].includes(recognitionOf(page).status)
  ).length;
  const pending = Math.max(body.length - recognized, 0);
  // 第二引擎：分母与主引擎相同，只算**已识别**的正文页（第二引擎读第一引擎切的行图）
  const engine = (finishSummary && finishSummary.engine) || {};
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
  const activeJob = taskJobId && lastTaskData && lastTaskData.job
    ? lastTaskData.job
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
        `第二引擎复核全书（${auxPending} 页 · ${auxEstimateText(auxPending)}）`;
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
    const textPages = textLayerPages();
    if (auxPending && textPages) {
      auxNote.textContent =
        `这本书有 ${textPages} 页带文字层：第二引擎直接读文字层（不跑 Vision），几十秒就能跑完；` +
        "它只标分歧、不改字，跑不跑都不影响后面的步骤。";
    } else if (auxPending) {
      auxNote.textContent =
        "第二引擎独立复核一遍、只标分歧不改字；" +
        `按本机实测约 ${AUX_SECONDS_PER_PAGE} 秒/页。它不挡后面的步骤，可以先做别的。`;
    } else {
      auxNote.textContent = "两路都跑完了：主引擎出文字，第二引擎的分歧在「正文审校」里逐条看。";
    }
  }

  if (ocrRunning) {
    state.textContent = "正在识别…";
    line.textContent = "主引擎在后台逐页跑，进度在右侧任务抽屉里；可以先去做别的。";
    button.textContent = "正在识别…";
    button.disabled = true;
  } else if (auxRunning) {
    state.textContent = "正在复核…";
    line.textContent = "第二引擎在后台逐页复核（只标分歧、不改字），进度在右侧任务抽屉里。";
    button.textContent = pending ? `开始识别（${pending} 页）` : "全部已识别";
    button.disabled = !pending;
  } else if (!body.length) {
    state.textContent = "未准备";
    line.textContent = "还没有确认过正文页：先在第 1 步把页面类型确认好。";
    button.textContent = "开始识别";
    button.disabled = true;
  } else if (!pending) {
    state.textContent = auxPending ? "主引擎已完成" : "已识别";
    line.textContent = auxPending
      ? `正文 ${body.length} 页都识别过了，这一步算完成；第二引擎还有 ${auxPending} 页没复核` +
        "（可选，只影响审校时看不看得到两路分歧）。"
      : `正文 ${body.length} 页都识别过了，第二引擎也复核完了；差异在「正文审校」里逐条看。`;
    button.textContent = "全部已识别";
    button.disabled = true;
  } else {
    state.textContent = recognized ? "部分已识别" : "未开始";
    line.textContent =
      `正文 ${body.length} 页里还有 ${pending} 页没有识别。` +
      "识别不读版心，版心要等识别出行框之后才生成得了。";
    button.textContent = `开始识别（${pending} 页）`;
    button.disabled = false;
  }
}

// 第二引擎单页耗时（本机实测：Apple Vision × 4.3–6.2 秒，取 5.7 秒/页；
// 读文字层那条路在 490 页的书上实测 436 页 / 43 秒 = 0.10 秒/页，含写库与比对）
const AUX_SECONDS_PER_PAGE = 5.7;
const AUX_TEXT_LAYER_SECONDS_PER_PAGE = 0.1;

/** 这一本里有多少页可以直接读文字层（任务 58）。 */
function textLayerPages() {
  const pages = (projectSummary && projectSummary.pages) || {};
  return Number(pages.text_layer_pages || 0);
}

/** 估时文字：文字层的页按几十毫秒算，其余按 Vision 的实测值算。 */
function auxEstimateText(pages) {
  const textPages = Math.min(pages, textLayerPages());
  const enginePages = Math.max(pages - textPages, 0);
  const seconds =
    textPages * AUX_TEXT_LAYER_SECONDS_PER_PAGE + enginePages * AUX_SECONDS_PER_PAGE;
  return formatDuration(seconds);
}

/** 第二引擎复核全书：只跑还没复核过的已识别正文页。 */
async function startAuxiliaryAll() {
  if (!currentProject) return;
  const status = el("rec-status");
  if (status) status.hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/jobs/auxiliary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "unchecked", skip_checked: true }),
      }
    );
    openTaskDrawer();
    startTaskPolling(data.job.job_id);
  } catch (error) {
    // 第二引擎不可用时必须当面说清（说明书 8.6：不假装还在比对）
    if (status) {
      status.textContent = `第二引擎没能开始：${error.message || "未知错误"}`;
      status.style.color = "var(--bad-fg)";
      status.hidden = false;
    }
  }
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
    const eta = estimateRemainingSeconds(data);
    line.textContent =
      `第二引擎复核中：${done} / ${job.total} 页` +
      (job.status === "paused" ? "（已暂停）" : eta > 0 ? ` · 还需${formatDuration(eta)}` : "") +
      "。进度也在右侧任务抽屉里。";
  }
}

/** 撤销按钮：只撤销本次会话里的版心拖动 / 重置，一次一步。 */
function marginUndoButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  const entry = marginUndoStack[marginUndoStack.length - 1] || null;
  button.textContent = "撤销";
  button.disabled = !entry;
  button.title = entry
    ? `撤销第 ${entry.pageNo} 页的版心改动`
    : "还没有可撤销的版心改动";
  button.addEventListener("click", undoMarginEdit);
  return button;
}

/** 点「下一页」：换到下一页（翻页本身不写库，版心不动就是已定）。 */
function selectNextPage(pageNo) {
  if (!currentProject) return;
  const pages = visiblePages();
  const index = pages.findIndex((page) => page.page_no === pageNo);
  const target = pages[index + 1] || pages[index] || null;
  if (!target) return;
  selectedPages.clear();
  selectedPages.add(target.page_no);
  selectionAnchor = target.page_no;
  renderPages();
  const tile = document.querySelector(
    `#page-grid .page-tile[data-page-no="${target.page_no}"]`
  );
  if (tile) tile.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * 重置为「本页自动」：先 PATCH 回 auto（丢掉自定义），再按检测行拟合。
 * 只处理 auto / inherit / custom 的页；不适用不动。
 */
async function resetMarginsToAuto(pages) {
  const targets = (pages || []).filter(
    (page) => page.margin_box_mode !== "none" && page.margin_box_mode !== undefined
  );
  if (!currentProject || !targets.length) return;
  for (const page of targets) {
    marginUndoStack.push({
      pageNo: page.page_no,
      mode: page.margin_box_mode,
      box: page.margin_box ? [...page.margin_box] : null,
    });
  }
  trimMarginUndo();
  try {
    if (targets.length === 1) {
      const page = targets[0];
      await apiJson(
        `/api/projects/${currentProject.project_id}/pages/${page.page_no}/margin-box`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ margin_box_mode: "auto", margin_box: null }),
        }
      );
      const fitted = await apiJson(
        `/api/projects/${currentProject.project_id}/pages/${page.page_no}/margin-box/fit`,
        { method: "POST" }
      );
      await refreshPageStates();
      refreshMarginTiles();
      renderMarginPanel();
      setMarginStatus(
        fitted.undetermined
          ? `第 ${page.page_no} 页还没有检测行，版心暂时未定。`
          : `第 ${page.page_no} 页已按检测行重新拟合。`
      );
      return;
    }
    await apiJson(
      `/api/projects/${currentProject.project_id}/margin-box/pages`,
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
    const fit = await apiJson(
      `/api/projects/${currentProject.project_id}/margin-box/fit-all`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ only_missing: true }),
      }
    );
    for (const page of targets) marginFitTried.delete(page.page_no);
    await refreshPageStates();
    refreshMarginTiles();
    renderMarginPanel();
    setMarginStatus(
      `已把 ${targets.length} 页改回自动拟合：${fit.fitted || 0} 页拟合，` +
        `${fit.fallback || 0} 页兜底，${fit.undetermined || 0} 页还没有检测行。`
    );
  } catch (error) {
    showError(el("pages-error"), error);
  }
}

function trimMarginUndo() {
  while (marginUndoStack.length > 20) marginUndoStack.shift();
}

/** 撤销一次版心改动：auto 页重拟合，其它页写回原来的四边。 */
async function undoMarginEdit() {
  const entry = marginUndoStack.pop();
  if (!entry || !currentProject) return;
  try {
    if (entry.mode === "auto" || entry.mode === "inherit") {
      await apiJson(
        `/api/projects/${currentProject.project_id}/pages/${entry.pageNo}/margin-box`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ margin_box_mode: entry.mode, margin_box: null }),
        }
      );
      if (entry.mode === "auto") {
        await apiJson(
          `/api/projects/${currentProject.project_id}/pages/${entry.pageNo}/margin-box/fit`,
          { method: "POST" }
        );
      }
    } else {
      await apiJson(
        `/api/projects/${currentProject.project_id}/pages/${entry.pageNo}/margin-box`,
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
    await refreshPageStates();
    refreshMarginTiles();
    renderMarginPanel();
    setMarginStatus(`已撤销第 ${entry.pageNo} 页的版心改动。`);
  } catch (error) {
    marginUndoStack.push(entry);
    showError(el("pages-error"), error);
  }
}

/**
 * 任务收尾 / 页面重新打开时从服务端重读版心状态（自动推算写在识别子进程里）。
 *
 * 只在任务**结束后**调用一次：轮询中途不重读，免得把用户正在拖的框改回去。
 * 返回是否有变化这件事不重要——界面统一重画一遍，成本很低。
 */
async function refreshMarginState() {
  if (!currentProject) return;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/margin-box`
    );
    currentProject.margin_box = data.margin_box || null;
    currentProject.margin_box_source = data.source || null;
    currentProject.margin_box_set_at = data.set_at || null;
    currentProject.margin_box_suggestion = data.suggestion || null;
    marginSuggestion = data.suggestion || null;
    marginAuditPage = null;
  } catch {
    return;
  }
  // 任务 36B：任务结束后再看一眼版心——刚补上检测行的页之前拟合失败过，允许再试一次。
  marginFitTried.clear();
  refreshMarginTiles();
  renderMarginPanel();
  if (currentView === "pages" && workflowStep === "margin") ensureMarginFitted();
  paintReviewMargin(detailPageRecord());
  // 版心外块的淡色样式要按新框重算（只改 class，不重建输入框之外的东西）
  if (detailPageNo !== null) drawDetailOverlay(reviewBlocks);
}

/** 全部改为每页自动拟合：inherit / auto 参与，custom / none 不动。 */
/** 把一页的自定义版心写进项目默认，并把这一页改回「沿用默认」。 */
// ---------------------------------------------------------------- 页码设置（任务 55）
//
// 用户 2026-10-23：大多数页码坐标稳定，不该逐页确认——聚出位置模板 → 确认一次 →
// 全书自动填充 → 只把异常页推给人。这一刀不做逐页手动改映射，也不接导出。

let pageNumberAnalysis = null;
let pageNumberStatusTimer = null;

function setPageNumberStatus(text, isError = false) {
  const node = el("page-number-status");
  if (!node) return;
  node.textContent = text || "";
  node.hidden = !text;
  node.style.color = isError ? "var(--bad-fg)" : "";
  if (pageNumberStatusTimer) clearTimeout(pageNumberStatusTimer);
  if (text) {
    pageNumberStatusTimer = setTimeout(() => {
      node.hidden = true;
    }, 9000);
  }
}

/** 右栏摘要：已采用的模板与已填页数（小接口，不跑聚类）。 */
let pageNumberMetricsLoading = false;

function renderPageNumberMetrics(summary = null) {
  const summaryNode = el("page-number-summary");
  const metrics = el("page-number-metrics");
  const review = el("page-number-review-open");
  if (!summaryNode || !metrics) return;
  const data = summary || {};
  const current = (pageNumberAnalysis && pageNumberAnalysis.current) || {};
  const counts = current.counts || {};
  const filled = current.filled ?? data.filled ?? 0;
  const total = current.total ?? data.total ?? (currentProject ? currentProject.pages.length : 0);
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

async function loadPageNumberMetrics() {
  if (!currentProject || pageNumberAnalysis || pageNumberMetricsLoading) {
    renderPageNumberMetrics();
    return;
  }
  pageNumberMetricsLoading = true;
  try {
    pageNumberAnalysis = await apiJson(
      `/api/projects/${currentProject.project_id}/page-numbers`
    );
    renderPageNumberMetrics();
  } catch {
    renderPageNumberMetrics();
  } finally {
    pageNumberMetricsLoading = false;
  }
}

async function loadPageNumberSummary() {
  if (!currentProject) return;
  const node = el("page-number-summary");
  if (!node) return;
  if (!node.textContent || !node.children.length) {
    node.textContent = "正在读取页码状态…";
  }
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/page-numbers/summary`
    );
    renderPageNumberMetrics(data);
    loadPageNumberMetrics();
  } catch {
    node.textContent = "未定位 · 可跳过";
    renderPageNumberMetrics();
  }
}

async function openPageNumberPanel() {
  if (!currentProject) return;
  openModal("page-number-panel");
  const body = document.querySelector("#page-number-panel .mbody");
  if (body) body.scrollTop = 0;
  el("page-number-error").hidden = true;
  el("page-number-template-count").textContent = "";
  el("page-number-templates").innerHTML = "";
  const loading = document.createElement("li");
  loading.className = "muted";
  loading.textContent = "正在从已识别页里收集页码候选…";
  el("page-number-templates").append(loading);
  el("page-number-empty").hidden = true;
  el("page-number-result").hidden = true;
  await refreshPageNumberAnalysis();
}

async function refreshPageNumberAnalysis() {
  if (!currentProject) return;
  try {
    pageNumberAnalysis = await apiJson(
      `/api/projects/${currentProject.project_id}/page-numbers`
    );
  } catch (error) {
    showError(el("page-number-error"), error);
    return;
  }
  renderPageNumberAnalysis(pageNumberAnalysis);
  renderPageNumberMetrics();
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
  const list = el("page-number-templates");
  list.innerHTML = "";
  const templates = data.templates || [];
  el("page-number-template-count").textContent = templates.length
    ? `${templates.length} 个 · 按覆盖页数排序`
    : "";
  if (!templates.length) {
    el("page-number-empty").hidden = false;
    return;
  }
  el("page-number-empty").hidden = true;
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
  const box = el("page-number-anomalies");
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
  el("page-number-meta").textContent =
    `已填 ${counts.filled || 0} / ${counts.total || 0} 页`;

  const result = el("page-number-result");
  // 没采用模板时，每个已识别页都会算"没有候选"，那不是异常，别铺一屏；
  // 只有"已采用模板 / 已填过页码 / 数值真的不连续"才展示当前映射与异常。
  const hasResult =
    Boolean(current.template) ||
    (counts.filled || 0) > 0 ||
    (counts.jump || 0) > 0 ||
    (counts.offset_break || 0) > 0;
  result.hidden = !hasResult;
  if (!hasResult) return;

  renderPageNumberAssignments(el("page-number-assignments"), current);
  el("page-number-current-summary").textContent = current.template
    ? `${current.template.label || "已采用模板"} · ${counts.filled || 0} 页`
    : `已填 ${counts.filled || 0} 页`;
  const mapping = el("page-number-mapping");
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
  if (!currentProject) return;
  const scope = range
    ? `第 ${range.from_page}–${range.to_page} 页`
    : "整本默认模板";
  if (
    !window.confirm(
      `把「${template.label}」用作${scope}？\n` +
        "会按位置重新抽取相应页的印刷页码；手动值不会被覆盖。" +
        "数值不连续 / 偏移突变的页会列在异常里。" +
        (template.reliable ? "" : "\n\n注意：" + (template.notes || []).join(" "))
    )
  ) {
    return;
  }
  el("page-number-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/page-numbers/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, range }),
      }
    );
    pageNumberAnalysis = data;
    renderPageNumberAnalysis(data);
    if (!el("page-number-review-panel").hidden) renderPageNumberReview(data);
    await loadPageNumberSummary();
    setPageNumberStatus(
      `已按模板填充 ${data.applied?.filled ?? 0} 页` + (range ? `（${scope}）` : "")
    );
  } catch (error) {
    showError(el("page-number-error"), error);
  }
}

async function removePageNumberRange(fromPage, toPage) {
  if (!currentProject) return;
  if (!window.confirm(`移除第 ${fromPage}–${toPage} 页的第二套模板？这些页会回到默认模板。`)) {
    return;
  }
  el("page-number-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/page-numbers/ranges/remove`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_page: fromPage, to_page: toPage }),
      }
    );
    pageNumberAnalysis = data;
    renderPageNumberAnalysis(data);
    if (!el("page-number-review-panel").hidden) renderPageNumberReview(data);
    await loadPageNumberSummary();
    setPageNumberStatus(`已移除第 ${fromPage}–${toPage} 页的第二套模板`);
  } catch (error) {
    showError(el("page-number-error"), error);
  }
}

// ---------------------------------------------------------------- 页码审校（任务 56）
//
// 自动填充之后，正常页不用一页页点；左边只列异常 / 未识别页，右边是可编辑的
// PDF 页 ↔ 印刷页映射表。手动改的值写 source=manual，后续模板重算不会覆盖。

const PN_ANOMALY_ORDER = ["no_candidate", "ambiguous", "jump", "offset_break", "duplicate"];
const PN_ANOMALY_LABELS = {
  no_candidate: "没有候选",
  ambiguous: "候选打架",
  jump: "页码不连续",
  offset_break: "偏移突变",
  duplicate: "重复页码",
  not_recognized: "未识别",
};
let pageNumberReviewFilter = "all";

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
  if (!currentProject) return;
  openModal("page-number-review-panel");
  el("page-number-review-error").hidden = true;
  el("page-number-review-meta").textContent = "";
  el("page-number-review-issues").innerHTML = "";
  el("page-number-review-table").innerHTML = "";
  await refreshPageNumberReview();
}

async function refreshPageNumberReview() {
  if (!currentProject) return;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/page-numbers`
    );
    pageNumberAnalysis = data;
    renderPageNumberReview(data);
  } catch (error) {
    showError(el("page-number-review-error"), error);
  }
}

function scrollToPageNumberRow(pageNo) {
  const row = document.querySelector(
    `#page-number-review-table li[data-page-no="${pageNo}"]`
  );
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  const input = row.querySelector("input");
  if (input) input.focus();
}

function renderPageNumberFilters(current, entries) {
  const box = el("page-number-review-filters");
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
      renderPageNumberReview(pageNumberAnalysis);
    });
    box.append(button);
  }
}

function renderPageNumberIssues(entries) {
  const list = el("page-number-review-issues");
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
  const table = el("page-number-review-table");
  const scrollTop = table.scrollTop;
  const entries = pageNumberIssueEntries(current);
  renderPageNumberFilters(current, entries);
  renderPageNumberIssues(entries);
  renderPageNumberAssignments(el("page-number-review-assignments"), current);

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
  el("page-number-review-meta").textContent =
    `已填 ${counts.filled || 0} / ${counts.total || 0} 页` +
    (counts.manual ? ` · 手动 ${counts.manual} 页` : "");
  el("page-number-review-footnote").textContent =
    entries.length
      ? `共 ${entries.length} 个问题条目；左边只列异常 / 未识别页，正常的页不用点。`
      : "没有异常页。";

  table.innerHTML = "";
  const pages = [...(currentProject?.pages || [])].sort((a, b) => a.page_no - b.page_no);
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
  if (!currentProject) return;
  el("page-number-review-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/page-numbers/manual`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_no: pageNo, printed_page: value || null }),
      }
    );
    pageNumberAnalysis = data;
    renderPageNumberReview(data, pageNo);
    await loadPageNumberSummary();
    setPageNumberStatus(`第 ${pageNo} 页已改为手动映射`);
  } catch (error) {
    showError(el("page-number-review-error"), error);
    // 失败时把输入框恢复成服务端的值
    if (pageNumberAnalysis) renderPageNumberReview(pageNumberAnalysis);
  }
}

function setupPageNumberPanel() {
  el("page-number-open").addEventListener("click", openPageNumberPanel);
  el("page-number-close").addEventListener("click", () =>
    closeModal("page-number-panel")
  );
  el("page-number-done").addEventListener("click", () =>
    closeModal("page-number-panel")
  );
  el("page-number-review-open").addEventListener("click", openPageNumberReview);
  el("page-number-review-close").addEventListener("click", () =>
    closeModal("page-number-review-panel")
  );
  el("page-number-review-done").addEventListener("click", () =>
    closeModal("page-number-review-panel")
  );
}

/**
 * 顶部那行统计：任务进行中它每分钟都要变，所以单独成一个函数，
 * 轮询的就地刷新（syncPageStates）也能更新，不必为了一个数字重建整格。
 */
function renderPageSummary() {
  const project = currentProject;
  if (!project) return;
  const all = project.pages;
  const shown = visiblePages().length;
  el("page-summary").textContent =
    `共 ${all.length} 页 · 正文 ${all.filter((page) => page.include).length} 页` +
    ` · 已识别 ${all.filter((page) => recognitionOf(page).status === "recognized").length} 页` +
    ` · 已确认 ${all.filter((page) => page.page_confirmed).length} 页` +
    (shown !== all.length ? ` · 当前显示 ${shown} 页` : "");
}

function renderPages() {
  const project = currentProject;
  if (!project) return;
  const pages = visiblePages();

  renderPageSummary();

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
    applyTileState(tile, page);
  });
  renderPageSummary();
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
  layout: "版面检测",
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
/**
 * 增量刷新用：这个任务里已经处理过"识别完成"的页。
 *
 * 每页只处理一次——轮询每 0.9 秒一次，不记的话同一页会被反复丢缓存、反复重画。
 */
let taskRefreshedJobId = null;
let taskRefreshedPages = null;
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
  if (taskJobId !== jobId) {
    // 换了任务：增量刷新的"已经处理过"从头算
    taskRefreshedJobId = null;
    taskRefreshedPages = null;
  }
  taskJobId = jobId;
  stopTaskPolling();
  // 900ms：单页识别完成后，界面最多等一轮轮询就能知道（加上块请求约 1 秒内出框）。
  // 任务载荷只是一次很小的数据库读，900ms 对本地单机服务没有压力。
  taskTimer = setInterval(pollTask, 900);
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
  // 检测任务在版心分区里也留一行进度（"做了多少 / 还要多久"），别让人只盯着抽屉
  if (data.job.job_type === "layout") updateMarginDetectProgress(data);
  if (data.job.job_type === "auxiliary") updateRecognitionAuxProgress(data);

  if (!["queued", "running", "paused"].includes(data.job.status)) {
    stopTaskPolling();
    // 版面检测不产生块：只刷新页面状态与工作流角标，不走识别那套"重载块"。
    if (data.job.job_type === "layout") {
      await refreshPageStates();
      await loadWorkflow();
      // 任务 59：检测收尾会自动用检测行推算一次版心，读回来让框 / 建议立刻出现
      await refreshMarginState();
      if (currentView === "pages") syncPageStates();
      await loadTasks();
      reportLayoutDetectOutcome(data);
      if (announceTaskFailure(data.job)) {
        renderTask(data);
        openTaskDrawer();
      }
      return;
    }
    // 收尾：最后一个框也是"刚认完的页"。整格重建 267 个瓷砖要一秒多，
    // 而这里真正变的只有页面状态与刚认完那几页的块：就地刷新 + 按增量补框。
    // refreshRecognizedPages 会先把这几页的旧块作废
    const donePages = collectNewlySucceededPages(data);
    // 识别完块变了：页面视图的建议角标不能拿旧数据
    forgetAllPageSuggestions();
    await refreshPageStates();
    // 任务 58：识别完成后工作流会记「已识别①」，把角标读回来
    await loadWorkflow();
    // 任务 53：识别子进程在收尾时自动算了一次版心（写在数据库里）。
    // 这里把新版心 / 建议读回来，页面视图与审校视图都会跟着重画。
    await refreshMarginState();
    await refreshRecognizedPages(donePages, { reloadDetail: false });
    if (detailPageNo !== null && !donePages.includes(detailPageNo)) {
      await loadPageDetail(detailPageNo, { forceSuggestions: true });
    }
    await loadTasks();
    // loadTasks 在没有活动任务时会把抽屉内容换成"最近任务"。失败时把这次任务的
    // 失败页重新摆出来，**只主动开一次**；成功 / 取消只更新顶栏 pill。
    if (announceTaskFailure(data.job)) {
      renderTask(data);
      openTaskDrawer();
    }
    await loadSummary(); // 任务结束后统计会变（复核行数、任务失败率）
    // 任务 69：任务在跑期间收尾面板给的是旧快照（不跟识别抢 CPU），
    // 任务一结束必须重算一次，否则步骤条会一直停在快照上。
    await loadFinishSummary({ silent: true });
    // 自动应用由识别子进程在结算后写入：这里等一轮再查，新出现的那一条会弹提示
    await loadAutoApplyStatus({ announce: true, jobId: data.job.job_id });
  } else {
    // 进度在变，页面状态也在变：不重拉图，只刷状态。
    // 两件事互不依赖（页面状态 vs 块数据），并行发，别让块框多等一个往返。
    const donePages = collectNewlySucceededPages(data);
    await Promise.all([refreshPageStates(), refreshRecognizedPages(donePages)]);
  }
}

/**
 * 这一轮轮询里"刚识别成功"的页（同一个任务里每页只返回一次）。
 *
 * 判据是任务单元的状态（`items[].status === "succeeded"`），不是进度数字：
 * 进度只告诉我们做了几页，告诉不了**是哪几页**。逐页单元状态是真实数据，
 * 页识别完成的那一刻它就从 running 变成 succeeded。
 */
function collectNewlySucceededPages(data) {
  const jobId = data.job?.job_id || null;
  if (taskRefreshedJobId !== jobId) {
    taskRefreshedJobId = jobId;
    taskRefreshedPages = new Set();
  }
  if (!taskRefreshedPages) taskRefreshedPages = new Set();
  const done = [];
  for (const item of data.items || []) {
    if (item.status !== "succeeded") continue;
    const pageNo = Number(item.page_no);
    if (!Number.isFinite(pageNo) || taskRefreshedPages.has(pageNo)) continue;
    taskRefreshedPages.add(pageNo);
    done.push(pageNo);
  }
  return done;
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
  for (const pageNo of pageNos) forgetPageBlocks(pageNo);
  if (currentView === "pages") {
    for (const pageNo of pageNos) {
      const tile = el("page-grid").querySelector(`.page-tile[data-page-no="${pageNo}"]`);
      if (tile) clearPageBlocks(tile);
      if (visiblePageNos.has(pageNo)) {
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
    currentView === "review" &&
    detailPageNo !== null &&
    pageNos.includes(detailPageNo)
  ) {
    await reloadDetailAfterRecognition(detailPageNo);
  }
}

async function reloadDetailAfterRecognition(pageNo) {
  if (detailPageNo !== pageNo) return;
  // 正在输入：先把这一块存掉，再用识别结果重绘（顺序反过来会丢掉刚打的字）
  await flushPendingSave();
  if (detailPageNo !== pageNo) return;
  await loadPageDetail(pageNo, { forceSuggestions: true });
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

// ---------------------------------------------------------------- 工作流状态（任务 58）

/**
 * 页面视图的"工作流"筛选。顺序按主链，数字来自 `/workflow` 的实时统计。
 * 这一组只影响显示；即使不选，检测 / 识别也照常各走各的。
 */
const WORKFLOW_FILTERS = [
  { value: "", label: "全部", count: "total" },
  { value: "pending", label: "待处理", count: "pending" },
  { value: "auto_passed", label: "自动通过（未经人工）", count: "auto" },
  { value: "human_confirmed", label: "人工已确认", count: "human" },
  { value: "unfinished", label: "未走完", count: "unfinished" },
  { value: "page_unconfirmed", label: "待确认页面", count: "page_unconfirmed" },
  { value: "confirmed", label: "已确认（待检测）", count: "confirmed" },
  { value: "detected", label: "已检测（未识别）", count: "detected" },
  { value: "ocr1_done", label: "已识别①", count: "ocr1_done" },
  { value: "failed", label: "有失败", count: "failed" },
  { value: "excluded", label: "不参与", count: "excluded" },
];

async function loadWorkflow() {
  const project = currentProject;
  if (!project) return;
  if (project.kind === "package") {
    workflowByPageId = new Map();
    workflowSummary = null;
    workflowConfirmationCounts = { human: 0, auto: 0, unknown: 0 };
    pendingPageNos = new Set();
    pendingPageCount = 0;
    renderWorkflowFilter({}, {});
    renderLayoutStatus();
    return;
  }
  try {
    const [data, pending] = await Promise.all([
      apiJson(`/api/projects/${project.project_id}/workflow`),
      apiJson(`/api/projects/${project.project_id}/review/pending`).catch(() => ({
        count: 0,
        pages: [],
      })),
    ]);
    workflowByPageId = new Map((data.pages || []).map((item) => [item.page_id, item]));
    workflowSummary = data.summary || null;
    workflowConfirmationCounts = data.confirmation_counts || { human: 0, auto: 0, unknown: 0 };
    pendingPageNos = new Set((pending.pages || []).map((item) => item.page_no));
    pendingPageCount = pending.count || 0;
    renderWorkflowFilter(data.counts || {}, data.summary || {});
  } catch {
    // 状态索引读不到时按"没有角标"处理，不影响识别 / 审校 / 导出
    workflowByPageId = new Map();
    workflowSummary = null;
    workflowConfirmationCounts = { human: 0, auto: 0, unknown: 0 };
    pendingPageNos = new Set();
    pendingPageCount = 0;
    renderWorkflowFilter({}, {});
  }
  renderLayoutStatus();
}

function renderWorkflowFilter(counts, summary) {
  const select = el("filter-workflow");
  if (!select) return;
  const current = select.value;
  select.innerHTML = "";
  for (const item of WORKFLOW_FILTERS) {
    const option = document.createElement("option");
    option.value = item.value;
    const number =
      item.value === "pending"
        ? pendingPageCount
        : item.value === "auto_passed"
        ? workflowConfirmationCounts.auto
        : item.value === "human_confirmed"
        ? workflowConfirmationCounts.human
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

function renderLayoutStatus() {
  // 检测入口在「⋯」里（PM：不占版心步的主位）；这里只更新它的文案与版心的缺口提示。
  refreshMarginDetectHint();
  refreshLayoutDetectEntry();
}

/** 版面检测入口：建任务 → 抽屉 + 轮询（任务 58）。 */
async function startLayoutDetection({ pages = null, scope = null, prepare = false }) {
  if (!currentProject) return;
  el("pages-error").hidden = true;
  const body = pages
    ? { pages, skip_detected: false, prepare }
    : { scope: scope || "body", prepare };
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/jobs/layout`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    renderTask(data);
    openTaskDrawer();
    startTaskPolling(data.job.job_id);
    return data;
  } catch (error) {
    showError(el("pages-error"), error);
    return null;
  }
}

// ---------------------------------------------------------------- 检测版面（⋯ 里的小入口）
//
// PM 的意见：检测一跑几分钟、用户也判断不了检测行对不对，**不该占版心步的主位**。
// 所以入口在右上角「⋯ → 检测版面…」，点开先看计划（几页 / 大概多久）再决定跑不跑。
// 后端用 `prepare` 模式：有检测行的页只补拟合，没有的才真检测。

let layoutPlanCache = null;

/** 打开检测对话框：先取计划，再让用户决定。 */
async function openLayoutDetectDialog() {
  if (!currentProject) return;
  layoutPlanCache = null;
  el("layout-detect-error").hidden = true;
  el("layout-detect-note").hidden = true;
  el("layout-detect-plan").textContent = "正在读取检测计划…";
  el("layout-detect-start").disabled = true;
  el("layout-detect-start").textContent = "开始检测";
  openModal("layout-detect-mask");
  await refreshLayoutDetectPlan();
}

async function refreshLayoutDetectPlan() {
  if (!currentProject) return;
  try {
    const plan = await apiJson(
      `/api/projects/${currentProject.project_id}/layout/plan`
    );
    layoutPlanCache = plan;
    renderLayoutDetectPlan(plan);
  } catch (error) {
    el("layout-detect-plan").textContent =
      `检测计划读取失败：${error.message || "未知错误"}`;
    el("layout-detect-start").disabled = true;
  }
}

/** 秒 → "约 2 分 10 秒"（粗一点，别给出假精度）。 */
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `约 ${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `约 ${minutes} 分 ${rest} 秒` : `约 ${minutes} 分钟`;
}

function renderLayoutDetectPlan(plan) {
  const detect = (plan.need_detection || []).length;
  const fit = (plan.need_fit || []).length;
  const rows = [];
  rows.push(
    `<div class="layout-plan__row"><span>正文页</span><strong>${plan.body_pages || 0}</strong></div>`
  );
  rows.push(
    `<div class="layout-plan__row"><span>已有检测结果</span><strong>${plan.detected || 0}</strong></div>`
  );
  rows.push(
    `<div class="layout-plan__row"><span>这次要检测</span><strong>${detect}</strong></div>`
  );
  if (fit) {
    rows.push(
      `<div class="layout-plan__row"><span>只补拟合版心</span><strong>${fit}</strong></div>`
    );
  }
  if (detect) {
    const perPage = Number(plan.seconds_per_page || 0);
    rows.push(
      `<div class="layout-plan__row"><span>预计耗时</span><strong>${formatDuration(plan.estimated_seconds)}</strong></div>`
    );
    rows.push(
      `<div class="layout-plan__row layout-plan__row--muted"><span>单页约</span><span>${perPage.toFixed(2)} 秒</span></div>`
    );
  }
  el("layout-detect-plan").innerHTML = rows.join("");

  const note = el("layout-detect-note");
  const bits = [];
  if (detect) {
    bits.push(
      plan.estimate_source === "history"
        ? "耗时按这本书已经跑过的检测实测中位数估算"
        : "这本书还没跑过检测，耗时按本机实测速度估算"
    );
    bits.push("跑的过程中可以暂停 / 取消，进度在右侧任务抽屉里");
  } else {
    bits.push("正文页都有检测行了，不需要再检测");
  }
  if (fit) bits.push(`另有 ${fit} 页已有检测行，只补拟合版心，不会重检测`);
  note.textContent = bits.join("；") + "。";
  note.hidden = false;

  const start = el("layout-detect-start");
  start.disabled = detect + fit === 0;
  start.textContent = detect ? `开始检测（${detect} 页）` : fit ? `只补拟合（${fit} 页）` : "没有要做的";
}

async function startLayoutDetectFromDialog() {
  if (!currentProject || !layoutPlanCache) return;
  const plan = layoutPlanCache;
  const pages = [...(plan.need_detection || []), ...(plan.need_fit || [])];
  if (!pages.length) return;
  el("layout-detect-error").hidden = true;
  el("layout-detect-start").disabled = true;
  el("layout-detect-start").textContent = "正在建任务…";
  const data = await startLayoutDetection({ pages, prepare: true });
  if (!data || !data.job) {
    // 失败原因就地显示：以前错误写进 #pages-error，对话框一关就看不见了，
    // 用户的感觉是"点了没反应"——这正是 P1-3 要修的。
    const node = el("layout-detect-error");
    node.textContent =
      (el("pages-error") && el("pages-error").textContent) || "任务没建成，原因未知。";
    node.hidden = false;
    el("layout-detect-start").disabled = false;
    el("layout-detect-start").textContent = "重试";
    return;
  }
  layoutDetectActive = true;
  renderMarginStepVerdict();
  closeModal("layout-detect-mask");
  showMarginDetectProgress(0, data.job.total || pages.length);
  setMarginStatus(
    `开始检测 ${data.job.total || pages.length} 页版面（只检测，不识别文字）…`,
    false,
    60000
  );
}

/** 检测任务在跑：在版心分区里显示"做了多少 / 还要多久"。 */
function updateMarginDetectProgress(data) {
  const job = data && data.job;
  if (!job || job.job_type !== "layout") return;
  const active = ["queued", "running", "paused"].includes(job.status);
  if (!active) return;
  const done = job.done + job.failed;
  showMarginDetectProgress(done, job.total || 0);
  const eta = estimateRemainingSeconds(data);
  el("margin-fit-text").textContent =
    `正在检测版面… ${done} / ${job.total} 页` +
    (job.status === "paused"
      ? "（已暂停）"
      : eta > 0
        ? ` · 还需${formatDuration(eta)}`
        : "");
}

/** 按已经跑出来的速度估剩余时间；样本太少时不给假精度。 */
function estimateRemainingSeconds(data) {
  const job = data.job || {};
  const done = Number(job.done || 0) + Number(job.failed || 0);
  const remaining = Number(job.total || 0) - done;
  if (!job.started_at || done < 2 || remaining <= 0) return 0;
  const started = Date.parse(job.started_at);
  if (!Number.isFinite(started)) return 0;
  const elapsed = (Date.now() - started) / 1000;
  if (elapsed <= 0) return 0;
  return (elapsed / done) * remaining;
}

function showMarginDetectProgress(done, total) {
  const wrap = el("margin-fit-progress");
  if (!wrap) return;
  wrap.hidden = false;
  const percent = total ? Math.round((done / total) * 100) : 0;
  el("margin-fit-fill").style.width = `${percent}%`;
  el("margin-fit-text").textContent = `正在检测版面… ${done} / ${total} 页`;
}

/** 检测任务结算：把结果说清楚（成功多少、失败多少、版心补了多少、是不是崩了）。 */
function reportLayoutDetectOutcome(data) {
  const job = data && data.job;
  if (!job || job.job_type !== "layout") return;
  layoutDetectActive = false;
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
  const stillEmpty = marginPagesWithoutLines().length;
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

/** 检测结束时进度条停在真实进度上，过一会儿收起来（别留在界面上像个假进度）。 */
function finishMarginDetectBar(done, total) {
  const wrap = el("margin-fit-progress");
  if (!wrap) return;
  el("margin-fit-fill").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  el("margin-fit-text").textContent = `检测：${done} / ${total} 页`;
  window.setTimeout(() => {
    const node = el("margin-fit-progress");
    if (node && !marginFitRunning) node.hidden = true;
  }, 5000);
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
  const typeLabel =
    job.job_type === "layout" && job.params && job.params.mode === "prepare"
      ? "页面准备"
      : JOB_TYPE_LABELS[job.job_type] || job.job_type;
  // 注意：这里**不**打开抽屉。renderTask 被轮询（每 0.9 秒）、刷新项目、
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
  if (running) {
    // 任务 68：识别把 CPU 吃到只剩 2 个核给界面。用户会感觉"翻页慢一点"，
    // 说出来他就不会以为坏了；也顺便说明为什么没有占满整机。
    hints.push("识别进行中，界面可能变慢一点（已经给界面留了核，不会卡死）。");
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

// ---------------------------------------------------------------- 目录确认（页码跳转索引，任务 37 / 任务 48）
//
// 用户要的不是书籍目录，是"能直接跳页的页码列表"：左边印刷页码 → PDF 页，
// 右边**连续多页**，像 PDF 阅读器那样一页接一页往下滚；点一条就滚到那一页。
// 数据来自后端 /page-index（优先 page.printed_page，否则页码候选；有缓存），
// 界面只读：不改任何东西。
//
// 任务 48（K1）：右边从"单页 + 翻页按钮"换成**连续页列**。
// - 394 个页块只是占位空壳（固定宽高比，滚动高度与"滚到第 394 页"都靠它）；
//   **图和块数据只给视口附近 ±3 页**加载，用 IntersectionObserver 判断远近，
//   滚出去的页立刻清掉版心 / 块框 / 首行框，离得远的页再把 img 的 src 摘掉。
// - 版心 / 块框 / 首行框还是页面视图同一套（`paintTileMargin` / `renderPageBlocks`）。
// - 右边滚 → 左边列表**反向同步**：当前页那一行高亮，并滚进列表可视区。
// - 缩放四档作用在整个页列上，仍然与页面视图 / 结果预览共用 `pageZoomIndex`。

let pageIndexData = null;
let pageIndexProject = null;
let pageIndexLoading = false;
let indexCurrentPage = null;
let indexJumpTimer = null;
const INDEX_ZOOM_SCALES = [0.55, 0.7, 0.85, 1];
/** 视口上下各预加载多少像素（约 ±3 页；628 高时一页约 700–900 px）。 */
const INDEX_NEAR_MARGIN = 2600;
/** 同时挂 `src` 的页图上限：再多就把离当前页最远的摘掉。 */
const INDEX_IMAGE_LIMIT = 20;
/** 内存里保留当前页 ±N 页的图（任务 62：翻回去不用再等）。 */
const INDEX_IMAGE_WINDOW = 10;

let indexTiles = new Map();
/** 目录确认当前页图用的档位（缩放变化时据此决定要不要重取）。 */
let indexImageProfile = "";
let indexPagesProject = null;
let indexNearPages = new Set();
/** 真正在视口里的页：版心 / 块框 / 首行框只给这些页画（任务 48）。 */
let indexVisiblePages = new Set();
let indexLoadedImages = new Set();
/** 每页图失败过几次（自动重试一次，还不行就在页块里给「点此重试」）。 */
const indexImageAttempts = new Map();
const INDEX_IMAGE_TIMEOUT_MS = 10000;
let indexBlocksByPage = new Map();
const indexBlocksPending = new Map();
let indexObserver = null;
let indexVisibleObserver = null;
let indexObserverMargin = 0;
/** 页图按"离当前页由近到远"排队，一次只解一张：跳页时不会一帧里解 7 张大图。 */
const indexImageQueue = [];
let indexImagePumping = false;
let indexTops = [];
let indexTopMap = new Map();
let indexScrollRaf = 0;
let indexResizeRaf = 0;

async function loadPageIndex() {
  if (!currentProject || pageIndexLoading) return;
  pageIndexLoading = true;
  pageIndexData = null;
  pageIndexProject = null;
  el("index-meta").textContent = "正在生成页码索引…";
  el("index-list").innerHTML = "";
  el("index-empty").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/page-index`
    );
    pageIndexData = data;
    pageIndexProject = currentProject.project_id;
  } catch (error) {
    el("index-meta").textContent = `页码索引读取失败：${error.message || "未知错误"}`;
    return;
  } finally {
    pageIndexLoading = false;
  }
  renderPageIndex();
}

/** 进入目录确认步：有缓存就用缓存；没有就生成一次，然后停在"当前页"。 */
async function openPageIndex() {
  if (!currentProject) return;
  // 目录确认默认开版心 + 块框：用户来这里就是要看"这一页的版心和块长什么样"。
  // 这两个开关和页面视图是同一份状态，在这里改，回去也生效。
  if (!pagesMarginOn) {
    pagesMarginOn = true;
    savePageMarginPreference();
    el("pages-margin-toggle")?.classList.add("is-on");
  }
  if (!pagesOverlayOn) {
    pagesOverlayOn = true;
    savePageOverlayPreference();
    el("pages-overlay-toggle")?.classList.add("is-on");
  }
  syncIndexToggles();
  if (!pageIndexData || pageIndexProject !== currentProject.project_id) {
    await loadPageIndex();
  } else {
    renderPageIndex();
  }
  syncIndexJumpState();
  const empty = el("index-empty");
  if (!pageIndexData || !pageIndexData.pages.length) {
    empty.hidden = false;
    setIndexImageStatus("这一页还没有页码索引。");
    return;
  }
  empty.hidden = true;
  ensureIndexPages();
  applyIndexZoom();
  measureIndexTiles();
  const target =
    (indexCurrentPage &&
      currentProject.pages.some((item) => item.page_no === indexCurrentPage)
      ? indexCurrentPage
      : null) ||
    (detailPageNo !== null ? detailPageNo : null) ||
    pageIndexData.pages[0].page_no;
  openIndexPage(target, { scrollList: true });
  // 开页会清跳转提示；页序模式的"没有印刷页码"要在**开页之后**再摆一次
  syncIndexJumpState();
}

function renderPageIndex() {
  const list = el("index-list");
  const meta = el("index-meta");
  list.innerHTML = "";
  if (!pageIndexData) {
    meta.textContent = "";
    renderIndexNotice(null);
    return;
  }
  const stats = pageIndexData.stats || {};
  const pageOrderOnly = indexIsPageOrderOnly();
  const bits = pageOrderOnly
    ? // 一页印刷页码都没有：这是一份 PDF 页序，别写成"0 页有印刷页码"让人以为是目录
      [`仅 PDF 页序 · ${stats.total || 0} 页`, "还没有印刷页码"]
    : [`${stats.total || 0} 页`, `${stats.numbered || 0} 页有印刷页码`];
  if (stats.chapters) bits.push(`${stats.chapters} 章`);
  if (pageIndexData.numbering_step === 2) bits.push("页码隔 2 递增");
  if (!pageOrderOnly && stats.missing) {
    // 缺页码分四类：前置/后置、目录页、回目页（都不印）、真没识别出来。前三类不是失败。
    if (stats.missing_front_back) bits.push(`${stats.missing_front_back} 页前置/后置`);
    if (stats.missing_toc) bits.push(`${stats.missing_toc} 页目录页`);
    if (stats.missing_chapter) bits.push(`${stats.missing_chapter} 页回目页`);
    if (stats.missing_unknown) bits.push(`${stats.missing_unknown} 页未识别页码`);
  }
  meta.textContent = bits.join(" · ");
  meta.title = (pageIndexData.notes || []).join("\n");

  renderIndexNotice(pageOrderOnly ? stats : null);

  const fragment = document.createDocumentFragment();
  for (const entry of pageIndexData.pages) {
    if (entry.chapter) {
      const head = document.createElement("li");
      head.className = "index-chapter";
      head.dataset.pageNo = String(entry.page_no);
      head.tabIndex = 0;
      const title = document.createElement("span");
      title.textContent = entry.chapter;
      const where = document.createElement("span");
      where.className = "muted";
      where.textContent = `PDF ${entry.page_no} 起`;
      head.append(title, where);
      fragment.append(head);
    }
    const row = document.createElement("li");
    if (pageOrderOnly) {
      // 只有页序：一行只写"PDF 第 N 页"，不摆"未识别页码"占位——那是目录才有的东西
      row.className = "index-row is-page-order";
      row.dataset.pageNo = String(entry.page_no);
      row.tabIndex = 0;
      row.title = `PDF 第 ${entry.page_no} 页（还没有印刷页码）`;
      const pdf = document.createElement("span");
      pdf.className = "index-row__pdf";
      pdf.textContent = `PDF 第 ${entry.page_no} 页`;
      const note = document.createElement("span");
      note.className = "index-row__note";
      note.textContent = "无印刷页码";
      row.append(pdf, note);
      fragment.append(row);
      continue;
    }
    const reason = entry.missing ? entry.missing_reason || "unknown" : null;
    // 前三类别叫"未识别"——它们本来就不印页码，写成失败会让人以为识别坏了
    row.className =
      "index-row" +
      (entry.missing ? " is-missing" : "") +
      (reason === "front_back" || reason === "toc" || reason === "chapter"
        ? " is-explain"
        : "");
    row.dataset.pageNo = String(entry.page_no);
    row.tabIndex = 0;
    const extraJump = (entry.jump || []).filter(
      (value) => !entry.printed.includes(value)
    );
    row.title = entry.missing
      ? reason === "front_back"
        ? `第 ${entry.page_no} 页是前置 / 后置页，本来就不印阿拉伯页码；照样可以点进去`
        : reason === "toc"
          ? `第 ${entry.page_no} 页是目录页，本来就不印阿拉伯页码；照样可以点进去`
          : reason === "chapter"
            ? `第 ${entry.page_no} 页是回目页（${entry.chapter || "回目首页"}），排版惯例不印页码；照样可以点进去`
            : `第 ${entry.page_no} 页没有识别到印刷页码，照样可以点进去`
      : `印刷页 ${entry.printed[0] || ""}` +
        (extraJump.length ? `（输入 ${extraJump.join(" / ")} 也会跳到这一页）` : "");
    const printed = document.createElement("span");
    printed.className = "index-row__printed";
    printed.textContent = entry.missing
      ? reason === "front_back"
        ? "前置/后置"
        : reason === "toc"
          ? "目录页"
          : reason === "chapter"
            ? "回目页"
            : "未识别页码"
      : entry.printed[0] || "";
    const pdf = document.createElement("span");
    pdf.className = "index-row__pdf";
    pdf.textContent = `PDF ${entry.page_no}`;
    row.append(printed, pdf);
    fragment.append(row);
  }
  list.append(fragment);
  highlightIndexRow(false);
}

/** 整本一页印刷页码都没有 = 这份列表只是 PDF 页序（还没识别 / 没定位页码）。 */
function indexIsPageOrderOnly() {
  const stats = (pageIndexData && pageIndexData.stats) || {};
  if (typeof stats.page_order_only === "boolean") return stats.page_order_only;
  return !Number(stats.numbered || 0);
}

/** 页序模式的说明条：这不是目录，印刷页码还没出来。 */
function renderIndexNotice(stats) {
  const notice = el("index-notice");
  if (!notice) return;
  if (!stats) {
    notice.hidden = true;
    return;
  }
  el("index-notice-title").textContent = "尚未识别：下面只有 PDF 页序";
  el("index-notice-text").textContent =
    `共 ${stats.total || 0} 页，一页印刷页码都还没有。` +
    "印刷页码来自识别出的页码行（再经「页码定位」确认），所以这一步要等那两件事做完才有内容；" +
    "现在点任意一页只是按 PDF 页序翻页。";
  const go = el("index-notice-go");
  go.hidden = false;
  go.textContent = "打开「文字识别」";
  notice.hidden = false;
}


// ---------------------------------------------------------------- 右：连续页列（按需加载）

function indexPageRecord(pageNo) {
  if (!currentProject) return null;
  return currentProject.pages.find((item) => item.page_no === pageNo) || null;
}

/** 页块只在换项目 / 页数变了时重建：394 个空壳，图与块都还是空的。 */
function ensureIndexPages() {
  if (!currentProject) return;
  const total = currentProject.pages.length;
  const same = indexPagesProject === currentProject.project_id &&
    indexTiles.size === total &&
    el("index-pages") &&
    el("index-pages").querySelector(".index-page");
  if (same) return;
  buildIndexPages();
}

function buildIndexPages() {
  const wrap = el("index-pages");
  if (!wrap || !currentProject) return;
  disconnectIndexObserver();
  wrap.innerHTML = "";
  indexTiles.clear();
  indexNearPages.clear();
  indexLoadedImages.clear();
  indexImageAttempts.clear();
  indexBlocksByPage.clear();
  indexBlocksPending.clear();
  indexTops = [];
  indexTopMap = new Map();
  const fragment = document.createDocumentFragment();
  for (const page of currentProject.pages) {
    const tile = document.createElement("div");
    tile.className = "index-page";
    tile.dataset.pageNo = String(page.page_no);
    // 图没到之前先占住真实比例：滚动条、二分定位和"滚到第 394 页"才稳定
    tile.style.aspectRatio = `${page.width_pt} / ${page.height_pt}`;

    const image = document.createElement("img");
    image.alt = `第 ${page.page_no} 页`;
    image.decoding = "async";

    // 和页面视图 / 目录确认原来那一套完全相同：版心 + 块框 + 首行标记
    const margin = document.createElement("div");
    margin.className = "page-margin";
    margin.hidden = true;
    const marginBox = document.createElement("div");
    marginBox.className = "page-margin__box";
    margin.append(marginBox);

    const overlay = document.createElement("div");
    overlay.className = "page-overlay page-overlay--readonly page-overlay--labeled";
    overlay.hidden = true;

    const firstline = document.createElement("div");
    firstline.className = "index-firstline";
    firstline.hidden = true;

    tile.append(image, margin, overlay, firstline);
    indexTiles.set(page.page_no, tile);
    fragment.append(tile);
  }
  wrap.append(fragment);
  indexPagesProject = currentProject.project_id;
  observeIndexTiles();
  window.__b2tIndexMetrics = {
    ...(window.__b2tIndexMetrics || {}),
    pages: indexTiles.size,
  };
}

function disconnectIndexObserver() {
  if (indexObserver) {
    indexObserver.disconnect();
    indexObserver = null;
  }
  if (indexVisibleObserver) {
    indexVisibleObserver.disconnect();
    indexVisibleObserver = null;
  }
}

/**
 * 两个观察者，各管一件事：
 * - near（上下放宽约 ±3 页）：只负责把图 / 块数据**提前拿到**，不画；
 * - visible（视口内）：负责画版心 / 块框 / 首行框，滚出去立刻清掉。
 * 这样滚动时每帧最多画 1–2 页，不会给 ±3 页一起重画。
 */
function observeIndexTiles() {
  const scroller = el("index-canvas");
  if (!scroller || typeof IntersectionObserver !== "function") return;
  const firstTile = indexTiles.values().next().value;
  const tileHeight = firstTile ? firstTile.getBoundingClientRect().height : 0;
  // "视口附近 ±3 页"按页高算（页高随缩放变），至少留半页防止页面太矮时错过
  const margin = tileHeight
    ? Math.max(600, Math.round(tileHeight * 3))
    : INDEX_NEAR_MARGIN;
  if (indexObserver && Math.abs(margin - indexObserverMargin) > 80) {
    indexObserver.disconnect();
    indexObserver = null;
  }
  if (!indexObserver) {
    indexObserverMargin = margin;
    indexObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const tile = entry.target;
          const pageNo = Number(tile.dataset.pageNo);
          if (entry.isIntersecting) {
            indexNearPages.add(pageNo);
            loadIndexTile(pageNo);
          } else if (indexNearPages.delete(pageNo)) {
            clearIndexTile(pageNo);
            // 已经离开几页之外的图不必再占解码内存
            if (Math.abs(pageNo - (indexCurrentPage || 1)) > 6) releaseIndexImage(pageNo);
          }
        }
        reportIndexMetrics();
      },
      { root: scroller, rootMargin: `${margin}px 0px`, threshold: 0 }
    );
  }
  if (!indexVisibleObserver) {
    indexVisibleObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const tile = entry.target;
          const pageNo = Number(tile.dataset.pageNo);
          if (entry.isIntersecting) {
            indexVisiblePages.add(pageNo);
            loadIndexTile(pageNo);
          } else if (indexVisiblePages.delete(pageNo)) {
            clearIndexDecorations(pageNo);
          }
        }
        reportIndexMetrics();
        updateIndexActiveFromScroll();
      },
      { root: scroller, rootMargin: "0px", threshold: 0 }
    );
  }
  for (const tile of indexTiles.values()) {
    indexObserver.observe(tile);
    indexVisibleObserver.observe(tile);
  }
}

function reportIndexMetrics() {
  const metrics = (window.__b2tIndexMetrics = window.__b2tIndexMetrics || {});
  metrics.nearPages = indexNearPages.size;
  metrics.visiblePages = indexVisiblePages.size;
  metrics.loadedImages = indexLoadedImages.size;
  metrics.blocksCached = indexBlocksByPage.size;
}

function ensureIndexImage(pageNo) {
  const tile = indexTiles.get(pageNo);
  if (!tile) return;
  const image = tile.querySelector("img");
  if (!image || image.dataset.src || image.dataset.pending) return;
  // 任务 80：**先摘掉上一轮残留的 onload/onerror**，再挂占位图。
  // 否则占位图自己加载完会触发上一个闭包，把 thumb 标成 `is-ready` 并且不再排队取高清图。
  image.onload = null;
  image.onerror = null;
  // 先挂低分辨率占位（几十毫秒），高精度图在后面排队
  showIndexPlaceholder(pageNo, image);
  image.dataset.pending = "1";
  indexImageQueue.push(pageNo);
  pumpIndexImages();
}

/**
 * 一次只拉 / 解一张页图，按离当前页由近到远。
 * 实测：一次跳 300 页时同时给 7 页挂 src，会出现约 0.9 秒的长帧（7 张 150DPI 图一起解码）；
 * 排队后第一张（当前页）先出来，其余在后面的帧里补上。
 */
async function pumpIndexImages() {
  if (indexImagePumping) return;
  indexImagePumping = true;
  try {
    while (indexImageQueue.length) {
      const keepPage = indexCurrentPage || 1;
      indexImageQueue.sort(
        (a, b) => Math.abs(a - keepPage) - Math.abs(b - keepPage)
      );
      const pageNo = indexImageQueue.shift();
      const tile = indexTiles.get(pageNo);
      const image = tile && tile.querySelector("img");
      if (!image) continue;
      const url = pageImageUrl(pageNo, pageProfileFor(tile, pageNo));
      image.dataset.src = url;
      image.loading = "eager";
      const started = performance.now();
      if (pageNo === indexCurrentPage) setIndexImageStatus(`正在渲染第 ${pageNo} 页…`);
      const ok = await waitForImageLoad(image, url);
      delete image.dataset.pending;
      if (image.dataset.cancelled === "1") {
        // 加载途中滚走了：这次结果直接丢掉，图也收回（不留解码内存）
        delete image.dataset.cancelled;
        image.removeAttribute("src");
        delete image.dataset.src;
        image.classList.remove("is-ready");
        indexLoadedImages.delete(pageNo);
        continue;
      }
      if (!ok) {
        image.removeAttribute("src");
        delete image.dataset.src;
        const attempts = (indexImageAttempts.get(pageNo) || 0) + 1;
        indexImageAttempts.set(pageNo, attempts);
        if (attempts < 2 && currentView === "index") {
          // 自动重试一次：不挡后面的页，600 ms 后自己回队列
          setTimeout(() => {
            if (currentView === "index" && indexTiles.has(pageNo)) ensureIndexImage(pageNo);
          }, 600);
        } else {
          markIndexImageFailed(pageNo);
        }
        continue;
      }
      image.classList.remove("is-ready");
      delete image.dataset.imageFailed;
      clearImagePlaceholder(image);
      image.classList.add("is-ready");
      // 先解码再交给排版：解码不进滚动 / 跳页的那一帧
      try {
        await image.decode();
      } catch {
        /* decode() 失败不影响显示 */
      }
      indexLoadedImages.add(pageNo);
      const metrics = (window.__b2tIndexMetrics = window.__b2tIndexMetrics || {});
      (metrics.imageMs = metrics.imageMs || []).push(Math.round(performance.now() - started));
      if (metrics.imageMs.length > 20) metrics.imageMs.shift();
      metrics.imageCount = (metrics.imageCount || 0) + 1;
      reportIndexMetrics();
      if (pageNo === indexCurrentPage) setIndexImageStatus("");
      trimIndexImages();
      await new Promise((resolve) => setTimeout(resolve, 24));
    }
  } finally {
    indexImagePumping = false;
  }
}

function releaseIndexImage(pageNo) {
  const queued = indexImageQueue.indexOf(pageNo);
  if (queued >= 0) indexImageQueue.splice(queued, 1);
  const tile = indexTiles.get(pageNo);
  if (!tile) return;
  const image = tile.querySelector("img");
  if (!image || !image.dataset.src) return;
  if (image.dataset.pending === "1") {
    // **还在加载**：现在摘 src 会让 onload/onerror 都不触发，泵就永远卡住（见 waitForImageLoad）。
    // 只做标记，等这次加载自己结束，由泵负责清理。
    image.dataset.cancelled = "1";
    return;
  }
  image.removeAttribute("src");
  delete image.dataset.src;
  image.classList.remove("is-ready");
  indexLoadedImages.delete(pageNo);
}

/**
 * 给一张页图挂 src，等它结束。**一定会 settle**：超时也算失败。
 *
 * 2026-10-28 用户看到"目录确认只有块框、页图全无"的根因就在这里：
 * 原来用 `new Promise(resolve => { image.onload=…; image.onerror=…; })`，而
 * `releaseIndexImage()`（滚远 / 跳页时调用）会把还在加载的图的 `src` 摘掉——
 * 摘掉 src 既不会触发 onload 也不会触发 onerror，那个 Promise **永远不 resolve**，
 * `pumpIndexImages()` 的 while 循环就卡死，`indexImagePumping` 一直是 true，
 * 于是这一次会话里**后面每一页都再也不会去拿图**（只有一片灰）。
 * 现在：加载中被释放只做标记，等它自己结束再清理；等待本身带超时，绝不悬空。
 */
function waitForImageLoad(image, url, timeoutMs = INDEX_IMAGE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
  });
}

/** 页图状态条：说清在等哪一页，而不是让用户对着一片灰猜。 */
function setIndexImageStatus(text) {
  const status = el("index-image-status");
  if (!status) return;
  if (!text) {
    status.hidden = true;
    status.textContent = "";
    return;
  }
  status.hidden = false;
  status.textContent = text;
}

/** 一页的图重试两次仍然失败：页块里放一个可点的重试，别留空白。 */
function markIndexImageFailed(pageNo) {
  const tile = indexTiles.get(pageNo);
  if (!tile) return;
  const image = tile.querySelector("img");
  if (image) {
    image.removeAttribute("src");
    delete image.dataset.src;
    image.classList.remove("is-ready");
    clearImagePlaceholder(image);
  }
  delete indexTiles.get(pageNo)?.dataset.imageFailed;
  tile.dataset.imageFailed = "1";
  if (tile.querySelector(".index-image-retry")) return;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "index-image-retry";
  retry.textContent = "这一页的图像读不出来 · 点这里重试";
  retry.addEventListener("click", () => {
    retry.remove();
    delete tile.dataset.imageFailed;
    indexImageAttempts.delete(pageNo);
    ensureIndexImage(pageNo);
  });
  tile.append(retry);
  if (pageNo === indexCurrentPage) {
    setIndexImageStatus(`第 ${pageNo} 页的图像读不出来（渲染超时或失败）`);
  }
}

/**
 * 图是解码过的大图：内存里只留**当前页 ±10 页、最多 20 张**，更远的摘掉。
 *
 * 2026-10-28 拍板：不做磁盘缓存（一页 150 DPI 的 PNG 约 1.7 MB，490 页约 830 MB，
 * 只为省下 0.14–0.30 s/页，不划算）。内存窗口够覆盖审校时来回翻几页，
 * 窗口外的再要就从接口重取（HTTP 那边还有 5 分钟缓存）。
 */
function trimIndexImages(keepPage = indexCurrentPage || 1) {
  const ordered = [...indexLoadedImages].sort(
    (a, b) => Math.abs(b - keepPage) - Math.abs(a - keepPage)
  );
  while (
    (indexLoadedImages.size > INDEX_IMAGE_LIMIT ||
      (ordered.length && Math.abs(ordered[0] - keepPage) > INDEX_IMAGE_WINDOW)) &&
    ordered.length
  ) {
    const pageNo = ordered.shift();
    if (Math.abs(pageNo - keepPage) <= INDEX_IMAGE_WINDOW && indexLoadedImages.size <= INDEX_IMAGE_LIMIT) {
      continue;
    }
    releaseIndexImage(pageNo);
  }
}

/**
 * 低分辨率占位图（任务 62）：`size=thumb` 是 40 DPI，几十毫秒就能回来。
 * 用户点进来先看到"这一页大概是这个样子"，高精度图到了再替换——
 * 首图可见时间从实测 6.4 s 降到 1 s 以内。
 */
function showIndexPlaceholder(pageNo, image) {
  if (!image || image.dataset.placeholder === "1") return;
  if (image.classList.contains("is-ready") || image.dataset.src) return;
  image.dataset.placeholder = "1";
  image.classList.add("is-placeholder");
  image.src = pageImageUrl(pageNo, "thumb");
}

/**
 * 摘掉占位状态。**`is-placeholder` 这个类必须一起摘**——它带着 `filter: blur(1.5px)`，
 * 只删 `dataset.placeholder` 会把模糊永久留在最后的清晰图上（用户看到的就是"糊"，
 * 而 `naturalWidth ÷ (CSS 宽 × dpr)` 却是 1.66，量比例永远查不出来）。
 */
function clearImagePlaceholder(image) {
  if (!image) return;
  delete image.dataset.placeholder;
  image.classList.remove("is-placeholder");
}

function ensureIndexBlocks(pageNo) {
  if (indexBlocksByPage.has(pageNo)) {
    return Promise.resolve(indexBlocksByPage.get(pageNo));
  }
  const pending = indexBlocksPending.get(pageNo);
  if (pending) return pending;
  const promise = loadIndexBlocks(pageNo)
    .then((blocks) => {
      indexBlocksByPage.set(pageNo, blocks || []);
      return blocks || [];
    })
    .finally(() => indexBlocksPending.delete(pageNo));
  indexBlocksPending.set(pageNo, promise);
  return promise;
}

/** 一页进入"附近"：先挂图、拿块；**只有它在视口里才画**。 */
async function loadIndexTile(pageNo) {
  const tile = indexTiles.get(pageNo);
  const page = indexPageRecord(pageNo);
  if (!tile || !page) return;
  ensureIndexImage(pageNo);
  if (indexVisiblePages.has(pageNo)) paintIndexTile(pageNo);
  if (indexBlocksByPage.has(pageNo)) {
    if (indexVisiblePages.has(pageNo)) paintIndexTile(pageNo);
    return;
  }
  const started = performance.now();
  const blocks = await ensureIndexBlocks(pageNo);
  if (!indexTiles.has(pageNo) || currentView !== "index") return;
  window.__b2tIndexBlocksMs = Math.round(performance.now() - started);
  reportIndexMetrics();
  if (indexVisiblePages.has(pageNo)) paintIndexTile(pageNo);
}

/** 只清装饰（滚动离开视口时用），块缓存留着，滚回来不用重拉。 */
function clearIndexDecorations(pageNo) {
  const tile = indexTiles.get(pageNo);
  if (!tile) return;
  clearPageBlocks(tile);
  clearTileMargin(tile);
  const first = tile.querySelector(".index-firstline");
  if (first) first.hidden = true;
}

/** 一页离开"附近"：装饰清掉，块缓存也丢（图按上限 / 距离释放）。 */
function clearIndexTile(pageNo) {
  clearIndexDecorations(pageNo);
  indexBlocksByPage.delete(pageNo);
  reportIndexMetrics();
}

/** 版心 + 块框 + 首行标记：和页面视图调用同一套渲染函数。 */
function paintIndexTile(pageNo) {
  const tile = indexTiles.get(pageNo);
  const page = indexPageRecord(pageNo);
  if (!tile || !page) return;
  paintTileMargin(tile, page);
  const blocks = indexBlocksByPage.get(pageNo) || [];
  const overlay = tile.querySelector(".page-overlay");
  if (pagesOverlayOn && blocks.length) {
    if (!overlay || overlay._renderedBlocks !== blocks) {
      renderPageBlocks(tile, blocks, { details: true });
    }
  } else {
    clearPageBlocks(tile);
  }
  drawIndexFirstLine(tile, blocks, page);
}

/** 这一页的首行：淡蓝框，用来核对"这个印刷页码是不是这一页"（版心内第一行）。 */
function drawIndexFirstLine(tile, blocks, page) {
  const node = tile ? tile.querySelector(".index-firstline") : null;
  if (!node) return;
  let first = null;
  for (const block of blocks) {
    if (!block.include) continue;
    if (!blockCountedInMargin(block, page)) continue;
    const line = (block.lines || []).find((item) => item && item.bbox);
    if (line) {
      first = line;
      break;
    }
  }
  if (!first) {
    node.hidden = true;
    return;
  }
  const [x0, y0, x1, y1] = first.bbox;
  node.style.left = `${x0 * 100}%`;
  node.style.top = `${y0 * 100}%`;
  node.style.width = `${(x1 - x0) * 100}%`;
  node.style.height = `${(y1 - y0) * 100}%`;
  node.hidden = false;
}

/** 开关变化时重画视口里的页（其他页保持干净）。 */
function paintIndexDecorations() {
  if (!currentProject || currentView !== "index" || !indexTiles.size) return;
  for (const [pageNo] of indexTiles) {
    if (indexVisiblePages.has(pageNo)) paintIndexTile(pageNo);
    else clearIndexDecorations(pageNo);
  }
  syncIndexToggles();
}

/** 量页列的滚动内容偏移（缩放 / 窗口变化后要重量）。 */
function measureIndexTiles() {
  const scroller = el("index-canvas");
  if (!scroller) return;
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  indexTops = [];
  indexTopMap = new Map();
  for (const [pageNo, tile] of indexTiles) {
    const rect = tile.getBoundingClientRect();
    const entry = { pageNo, top: rect.top - base, height: rect.height };
    indexTops.push(entry);
    indexTopMap.set(pageNo, entry);
  }
  indexTops.sort((a, b) => a.pageNo - b.pageNo);
  window.__b2tIndexTops = indexTops;
  // 页高变了：±3 页的观察范围跟着重算
  observeIndexTiles();
}

/** 当前在视口里的页：取"视口上方 30%"落在一页里的那一页。 */
function indexPageAtScroll() {
  const scroller = el("index-canvas");
  if (!scroller || !indexTops.length) return indexCurrentPage || 1;
  const anchor = scroller.scrollTop + scroller.clientHeight * 0.3;
  let lo = 0;
  let hi = indexTops.length - 1;
  let best = indexTops[0].pageNo;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = indexTops[mid];
    if (entry.top <= anchor) {
      best = entry.pageNo;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function updateIndexActiveFromScroll() {
  const pageNo = indexPageAtScroll();
  if (!pageNo || pageNo === indexCurrentPage) return;
  indexCurrentPage = pageNo;
  updateIndexPageHeader(pageNo);
  highlightIndexRow(true);
}

/** 右边滚动 → 左边列表反向同步（一帧一次）。 */
function onIndexScroll() {
  if (indexScrollRaf) return;
  indexScrollRaf = requestAnimationFrame(() => {
    indexScrollRaf = 0;
    if (currentView !== "index" || !indexTiles.size) return;
    updateIndexActiveFromScroll();
  });
}

function scrollIndexToPage(pageNo) {
  const scroller = el("index-canvas");
  const entry = indexTopMap.get(pageNo);
  if (!scroller || !entry) return;
  const target = Math.max(0, entry.top - 8);
  if (Math.abs(scroller.scrollTop - target) < 2) return;
  scroller.scrollTop = target;
}

/** 页头那一行：印刷页 / 前置后置 / 目录页 / 回目页 / 真没识别出来，五种说法分开。 */
function indexPrintedLabel(entry) {
  if (!entry) return "";
  if (!entry.missing) return `印刷页 ${entry.printed[0] || ""}`;
  if (entry.missing_reason === "front_back") return "前置/后置页 · 不印页码";
  if (entry.missing_reason === "toc") return "目录页 · 不印页码";
  if (entry.missing_reason === "chapter") {
    return `回目页 · 不印页码${entry.chapter ? "（" + entry.chapter + "）" : ""}`;
  }
  return "未识别页码（照样可以审校 / 导出）";
}

function updateIndexPageHeader(pageNo) {
  const pageOrderOnly = Boolean(pageIndexData) && indexIsPageOrderOnly();
  el("index-page-no").textContent = pageOrderOnly
    ? `PDF 第 ${pageNo} 页`
    : `第 ${pageNo} 页`;
  const entry =
    pageIndexData && pageIndexData.pages.find((item) => item.page_no === pageNo);
  // 页头只写实际检测到的印刷页；"同一叶另一面"的跳转便利只放在列表行的 title 里。
  el("index-printed").textContent = pageOrderOnly
    ? "无印刷页码（只有 PDF 页序）"
    : indexPrintedLabel(entry);
  const pages = pageIndexData ? pageIndexData.pages : [];
  const index = pages.findIndex((item) => item.page_no === pageNo);
  el("index-prev").disabled = index <= 0;
  el("index-next").disabled = index < 0 || index >= pages.length - 1;
}

/** 打开一页 = 滚到那一页（点列表 / 输入印刷页 / 上一下一页都走这里）。 */
function openIndexPage(pageNo, { scrollList = true } = {}) {
  if (!currentProject) return;
  const page = indexPageRecord(pageNo);
  if (!page) return;
  indexCurrentPage = pageNo;
  // 页序模式的"没有印刷页码"说明是**常驻**的，翻页不该把它清掉
  if (!indexIsPageOrderOnly()) setIndexJumpStatus("");
  ensureIndexPages();
  if (!indexTopMap.size) measureIndexTiles();
  updateIndexPageHeader(pageNo);
  const image = indexTiles.get(pageNo)?.querySelector("img");
  if (image && image.classList.contains("is-ready")) {
    setIndexImageStatus("");
  } else if (indexTiles.get(pageNo)?.dataset.imageFailed === "1") {
    setIndexImageStatus(`第 ${pageNo} 页的图像读不出来（渲染超时或失败）`);
  } else {
    setIndexImageStatus(`正在渲染第 ${pageNo} 页…（第一次打开需要几秒）`);
  }
  scrollIndexToPage(pageNo);
  loadIndexTile(pageNo);
  highlightIndexRow(scrollList);
  syncIndexToggles();
}

function highlightIndexRow(scroll) {
  const list = el("index-list");
  for (const node of list.querySelectorAll(".is-current")) {
    node.classList.remove("is-current");
  }
  if (indexCurrentPage === null) return;
  // 回目头（.index-chapter）和页行共用 data-page-no：高亮只认页行
  const row = list.querySelector(
    `li.index-row[data-page-no="${indexCurrentPage}"]`
  );
  if (!row) return;
  row.classList.add("is-current");
  if (scroll) ensureIndexRowVisible(row);
}

/** 右边滚出来的当前页：列表行没完整露出来就把它滚到列表中间（反向同步）。 */
function ensureIndexRowVisible(row) {
  const list = el("index-list");
  if (!list || !row) return;
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  if (rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom) return;
  list.scrollTop +=
    rowRect.top - listRect.top - (listRect.height - rowRect.height) / 2;
}

function stepIndexPage(delta) {
  const total = currentProject ? currentProject.pages.length : 0;
  if (!total) return;
  const next = Math.min(total, Math.max(1, (indexCurrentPage || 1) + delta));
  if (next === indexCurrentPage) return;
  openIndexPage(next, { scrollList: true });
}

/** 缩放与页面视图共用 pageZoomIndex；这里改的是整个页列的宽度。 */
/**
 * 缩放 / 窗口变化后重新判断档位：需要更高的档就把这一页的图作废重取。
 * 只在"需要的档变了"时动手（85%→70% 这种不需要重取，省一次渲染）。
 */
/** 清晰度：auto / standard / high，按浏览器记住（不写项目数据库）。 */
const IMAGE_QUALITY_LABELS = { auto: "自动", standard: "标准", high: "高清" };

function loadImageQuality() {
  const saved = localStorage.getItem("b2t.imageQuality");
  imageQualityMode = ["auto", "standard", "high"].includes(saved) ? saved : "auto";
}

function setImageQuality(mode) {
  if (!["auto", "standard", "high"].includes(mode)) return;
  imageQualityMode = mode;
  localStorage.setItem("b2t.imageQuality", mode);
  syncImageQualityUi();
  // 档位变了：把已经取过的页图作废，按新档重取（标准 → 高清时才会真的重取）
  indexImageProfile = "";
  indexLoadedImages.clear();
  for (const tile of indexTiles.values()) {
    const image = tile.querySelector("img");
    if (!image) continue;
    delete image.dataset.src;
    delete image.dataset.pending;
    image.removeAttribute("src");
  }
  for (const visible of indexVisiblePages) ensureIndexImage(visible);
  if (indexCurrentPage) ensureIndexImage(indexCurrentPage);
  // 其它视图（页面视图 / 审校左栏）下次取图时会读到新的档位
}

function syncImageQualityUi() {
  const label = IMAGE_QUALITY_LABELS[imageQualityMode] || "自动";
  const button = el("index-quality");
  if (button) button.textContent = `清晰度：${label}`;
  for (const radio of document.querySelectorAll('input[name="reading-quality"]')) {
    radio.checked = radio.value === imageQualityMode;
  }
}

function refreshIndexImageProfiles() {
  const tiles = [...indexTiles.values()].filter((tile) => tile.querySelector("img"));
  if (!tiles.length) return;
  const sample = tiles[0];
  const pageNo = Number(sample.dataset.pageNo);
  const wanted = pageProfileFor(sample, pageNo);
  if (!indexImageProfile) {
    indexImageProfile = wanted;
    return;
  }
  if (wanted === indexImageProfile) return;
  indexImageProfile = wanted;
  indexLoadedImages.clear();
  for (const tile of tiles) {
    const image = tile.querySelector("img");
    delete image.dataset.src;
    delete image.dataset.pending;
    delete image.dataset.profile;
    image.removeAttribute("src");
    tile.querySelectorAll(".index-page__placeholder").forEach((node) => node.remove());
  }
  for (const pageNo of indexImageQueue.splice(0)) {
    // 队列里挂的旧档也一起作废，下面按新档重新排队
  }
  for (const visible of indexVisiblePages) ensureIndexImage(visible);
  if (indexCurrentPage) ensureIndexImage(indexCurrentPage);
}

function applyIndexZoom() {
  if (!indexTiles.size) return;
  const scale = INDEX_ZOOM_SCALES[pageZoomIndex] || 1;
  const width = `${Math.round(scale * 100)}%`;
  for (const tile of indexTiles.values()) tile.style.width = width;
  // 任务 72：缩放变了，**需要的像素数就变了**，档位必须跟着重算。
  // 原来只在建块时取一次图，85% 拉来的 `view` 图会被拉伸到 100% 的容器里 → 糊。
  refreshIndexImageProfiles();
  const label = el("index-zoom-label");
  if (label) {
    label.textContent = pageZoomIndex >= INDEX_ZOOM_SCALES.length - 1
      ? "适合宽度"
      : `${Math.round(scale * 100)}%`;
  }
  el("index-zoom-out").disabled = pageZoomIndex <= 0;
  el("index-zoom-in").disabled = pageZoomIndex >= INDEX_ZOOM_SCALES.length - 1;
}

function changeIndexZoom(delta) {
  const next = Math.min(
    INDEX_ZOOM_SCALES.length - 1,
    Math.max(0, pageZoomIndex + delta)
  );
  if (next === pageZoomIndex) return;
  pageZoomTouched = true;
  pageZoomIndex = next;
  applyIndexZoom();
  measureIndexTiles();
  paintIndexDecorations();
  // 页高变了：把当前页重新对到视口上方，别让它被缩放挤走
  scrollIndexToPage(indexCurrentPage || 1);
}

/** 取一页的块（带页面视图的块缓存；预览也复用这一份）。 */
async function loadIndexBlocks(pageNo) {
  const key = pageBlockKey(pageNo);
  if (pageBlockCache.has(key)) return pageBlockCache.get(key);
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${pageNo}/blocks`
    );
    const blocks = data.blocks || [];
    rememberPageBlocks(key, blocks);
    return blocks;
  } catch {
    return [];
  }
}

function syncIndexToggles() {
  const overlay = el("index-overlay-toggle");
  if (overlay) overlay.classList.toggle("is-on", pagesOverlayOn);
  const margin = el("index-margin-toggle");
  if (margin) margin.classList.toggle("is-on", pagesMarginOn);
}

function toggleIndexOverlay() {
  togglePageBlocksOverlay();
  paintIndexDecorations();
}

function toggleIndexMargin() {
  toggleMarginView();
  paintIndexDecorations();
}

function setIndexJumpStatus(text, isError = false, holdMs = 9000) {
  const node = el("index-jump-status");
  if (!node) return;
  node.textContent = text || "";
  node.hidden = !text;
  node.style.color = isError ? "var(--bad-fg)" : "";
  if (indexJumpTimer) clearTimeout(indexJumpTimer);
  if (text && holdMs > 0) indexJumpTimer = setTimeout(() => { node.hidden = true; }, holdMs);
}

/**
 * 页序模式下"按印刷页码跳转"必须停用：没有印刷页码，输入框就是骗人的。
 * 有页码时恢复，并把提示收起来。
 */
function syncIndexJumpState() {
  const input = el("index-jump-input");
  const go = el("index-jump-go");
  if (!input || !go) return;
  const pageOrderOnly = Boolean(pageIndexData) && indexIsPageOrderOnly();
  input.disabled = pageOrderOnly;
  go.disabled = pageOrderOnly;
  input.placeholder = pageOrderOnly ? "还没有印刷页码" : "如 80";
  if (pageOrderOnly) {
    setIndexJumpStatus(
      "还没有印刷页码，不能按印刷页码跳；左边按 PDF 页序排列。",
      false,
      0
    );
  } else {
    setIndexJumpStatus("");
  }
}

/** 按印刷页码跳转：精确命中就跳；没有就跳到最接近的印刷页并如实说明。 */
function jumpToPrintedPage() {
  if (!pageIndexData || !pageIndexData.pages.length) {
    setIndexJumpStatus("页码索引还没准备好。", true);
    return;
  }
  if (indexIsPageOrderOnly()) {
    setIndexJumpStatus("这本书还没有印刷页码，只能按 PDF 页序翻。", true);
    return;
  }
  const raw = el("index-jump-input").value || "";
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) {
    setIndexJumpStatus("请输入印刷页码，例如 80。", true);
    return;
  }
  const wanted = Number(digits);
  // 命中实际印刷页，或（编号隔 2 的书）同一叶的另一面；标签里不写后者。
  const exact = pageIndexData.pages.find((entry) =>
    (entry.jump || entry.printed).some((value) => Number(value) === wanted)
  );
  if (exact) {
    openIndexPage(exact.page_no, { scrollList: true });
    setIndexJumpStatus(
      `已跳到印刷页 ${wanted}（PDF ${exact.page_no}）。`
    );
    return;
  }
  let best = null;
  for (const entry of pageIndexData.pages) {
    for (const value of entry.jump || entry.printed) {
      const distance = Math.abs(Number(value) - wanted);
      if (!best || distance < best.distance) {
        best = { distance, pageNo: entry.page_no, value: Number(value) };
      }
    }
  }
  if (!best) {
    setIndexJumpStatus("这本书还没有可用的印刷页码。", true);
    return;
  }
  openIndexPage(best.pageNo, { scrollList: true });
  setIndexJumpStatus(
    `索引里没有印刷页 ${wanted}；已跳到最接近的 ${best.value}（PDF ${best.pageNo}）。`,
    true
  );
}

function setupPageIndex() {
  el("index-prev").addEventListener("click", () => stepIndexPage(-1));
  el("index-next").addEventListener("click", () => stepIndexPage(1));
  el("index-notice-go").addEventListener("click", () => goToWorkflowStep("recognition"));
  el("index-zoom-out").addEventListener("click", () => changeIndexZoom(-1));
  el("index-zoom-in").addEventListener("click", () => changeIndexZoom(1));
  // 任务 72：清晰度出口。自动判定永远有人不满意，手动钉住比反复调阈值划算。
  el("index-quality")?.addEventListener("click", () => {
    const order = ["auto", "standard", "high"];
    setImageQuality(order[(order.indexOf(imageQualityMode) + 1) % order.length]);
  });
  for (const radio of document.querySelectorAll('input[name="reading-quality"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) setImageQuality(radio.value);
    });
  }
  el("index-overlay-toggle").addEventListener("click", toggleIndexOverlay);
  el("index-margin-toggle").addEventListener("click", toggleIndexMargin);
  el("index-jump-go").addEventListener("click", jumpToPrintedPage);
  el("index-jump-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpToPrintedPage();
    }
  });
  el("index-canvas").addEventListener("scroll", onIndexScroll, { passive: true });
  el("index-list").addEventListener("click", (event) => {
    const row = event.target.closest("li[data-page-no]");
    if (!row) return;
    openIndexPage(Number(row.dataset.pageNo), { scrollList: true });
  });
  el("index-list").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("li[data-page-no]");
    if (!row) return;
    event.preventDefault();
    openIndexPage(Number(row.dataset.pageNo), { scrollList: true });
  });
  window.addEventListener("resize", () => {
    if (currentView !== "index" || indexResizeRaf) return;
    indexResizeRaf = requestAnimationFrame(() => {
      indexResizeRaf = 0;
      if (currentView !== "index" || !indexTiles.size) return;
      applyIndexZoom();
      measureIndexTiles();
      paintIndexDecorations();
      scrollIndexToPage(indexCurrentPage || 1);
    });
  });
}

// ---------------------------------------------------------------- 结果预览（任务 38 / 任务 47）
//
// 用户要求：预览就是**导出结果的实时副本**，不能另写一套段落合并逻辑。
// 所以这里只调 `POST /export/preview`（与导出同一个组装器、同一份 options），
// 把返回的 segments 直接铺开：段边界、跨页段、版心外排掉了多少，都在这一页上。
//
// 任务 47（J 刀）：左边从"单页裸图"换成**连续页条**。
// - 每页直接复用页面视图 / 目录确认的 `paintTileMargin()` / `renderPageBlocks()`；
//   版心 / 块框开关与缩放沿用 `pagesMarginOn` / `pagesOverlayOn` / `pageZoomIndex` 同一份状态。
// - 悬停右栏一段 → 右栏这一段浅绿，左边这一段命中的块（跨页段是两页的块）标浅绿。
//   浅绿用青绿（teal），和审校的淡红 / 淡绿 / 淡蓝三色区分开。
// - 右栏滚动 → 左边跟到这一段所在的页（页不变就不换图）；左栏滚动 → 右栏定位到那页第一段。
//   两边用 `previewSyncDriver` 防止互相驱动成环。
// - 右栏 1139 段**不逐段挂监听**：悬停 / 点击都事件代理到 `#preview-segs`。

let previewData = null;
let previewProject = null;
let previewOptions = null;
let previewOptionsSignature = null;
let previewLoading = false;
let previewPageNo = null;
let previewActiveSeq = null;
let previewOnlySpan = false;
let previewSegmentNodes = new Map();
let previewSegmentsBySeq = new Map();
let previewFirstSeqByPage = new Map();
/** 左边连续页条：page_no → 页块；`previewTileTops` 是滚动位置二分用的几何缓存。 */
let previewTiles = new Map();
let previewTileTops = [];
let previewTileTopMap = new Map();
let previewPagesProject = null;
let previewLoadedPages = new Set();
let previewTileBlocks = new Map();
const previewBlocksPending = new Map();
let previewActiveBlocks = [];
const previewHitTiles = new Set();
let previewHitToken = 0;
let previewRightRaf = 0;
let previewLeftRaf = 0;
let previewPendingHover = 0;
let previewSyncDriver = null;
let previewSyncUntil = 0;
let previewImageStartedAt = new Map();

/** 量一帧里的几何：页块的滚动内容偏移与高度（缩放 / 窗口变化后要重量）。 */
function measurePreviewTiles() {
  const scroller = el("preview-pdf-scroll");
  if (!scroller) return;
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  previewTileTops = [];
  previewTileTopMap = new Map();
  for (const [pageNo, tile] of previewTiles) {
    const rect = tile.getBoundingClientRect();
    const entry = { pageNo, top: rect.top - base, height: rect.height };
    previewTileTops.push(entry);
    previewTileTopMap.set(pageNo, entry);
  }
  previewTileTops.sort((a, b) => a.pageNo - b.pageNo);
  // 调试口径：和 `__b2tIndexBlocksMs` 一样，给浏览器实测用，不参与业务判断
  window.__b2tPreviewTileTops = previewTileTops;
  // 缩放 / 窗口变化会改页高：跨页分界线的位置要按新几何重新摆
  if (previewActiveSeq !== null) {
    const segment = previewSegmentsBySeq.get(previewActiveSeq);
    if (segment) showPreviewJunction(segment);
  }
}

function recordPreviewMetric(key, value) {
  const metrics = (window.__b2tPreviewMetrics = window.__b2tPreviewMetrics || {});
  const list = (metrics[key] = metrics[key] || []);
  list.push(value);
  if (list.length > 20) list.shift();
  // 累计次数（列表只留最近 20 条，次数要单调递增才能验"页不换就不重新加载"）
  metrics[`${key}Count`] = (metrics[`${key}Count`] || 0) + 1;
}

function previewPageRecord(pageNo) {
  if (!currentProject) return null;
  return currentProject.pages.find((item) => item.page_no === pageNo) || null;
}

function markPreviewDriver(driver) {
  previewSyncDriver = driver;
  previewSyncUntil = performance.now() + 350;
}

function previewDriverActive(driver) {
  return previewSyncDriver === driver && performance.now() < previewSyncUntil;
}

// ---------------------------------------------------------------- 左：连续页条

/** 建全书页块（每页一个：图 + 版心 + 块框 + 段落命中层）。只在换项目 / 页数变了时重建。 */
function buildPreviewPages() {
  const wrap = el("preview-pages");
  if (!wrap || !currentProject) return;
  // 跨页分界线是静态节点（id 有登记），重建页块时留着，别一起清掉
  const junction = wrap.querySelector(".preview-junction");
  wrap.innerHTML = "";
  previewTiles.clear();
  previewTileTops = [];
  previewTileTopMap = new Map();
  previewLoadedPages.clear();
  previewTileBlocks.clear();
  previewBlocksPending.clear();
  previewActiveBlocks = [];
  previewHitTiles.clear();
  const fragment = document.createDocumentFragment();
  for (const page of currentProject.pages) {
    const tile = document.createElement("div");
    tile.className = "preview-page";
    tile.dataset.pageNo = String(page.page_no);
    // 图没加载出来之前也占住真实比例，滚动条与二分定位才不会跳
    tile.style.aspectRatio = `${page.width_pt} / ${page.height_pt}`;

    const image = document.createElement("img");
    image.alt = `第 ${page.page_no} 页`;
    image.loading = "lazy";
    image.decoding = "async";

    const margin = document.createElement("div");
    margin.className = "page-margin";
    margin.hidden = true;
    const marginBox = document.createElement("div");
    marginBox.className = "page-margin__box";
    margin.append(marginBox);

    // 和页面视图 / 目录确认同一套块框（--readonly：只画，不给拖 / 选）
    const overlay = document.createElement("div");
    overlay.className = "page-overlay page-overlay--readonly";
    overlay.hidden = true;

    // 当前段落的块命中的浅绿层：在块框之上、不接鼠标
    const hits = document.createElement("div");
    hits.className = "preview-page__hits";
    hits.hidden = true;

    tile.append(image, margin, overlay, hits);
    previewTiles.set(page.page_no, tile);
    fragment.append(tile);
  }
  wrap.append(fragment);
  if (junction) {
    junction.hidden = true;
    wrap.append(junction);
  }
}

function ensurePreviewImage(pageNo) {
  const tile = previewTiles.get(pageNo);
  if (!tile) return;
  const image = tile.querySelector("img");
  if (!image || image.dataset.src) return;
  const url = pageImageUrl(pageNo, pageProfileFor(tile, pageNo));
  image.dataset.src = url;
  // 窗口内（当前页 ±1 / 当前段跨的页）要马上有图：lazy 会把视口外一屏的页压住，
  // 跨页段两页交界时就会先看到空白再等图。
  image.loading = "eager";
  previewLoadedPages.add(pageNo);
  previewImageStartedAt.set(pageNo, performance.now());
  image.onload = () => {
    image.classList.add("is-ready");
    const started = previewImageStartedAt.get(pageNo);
    if (started) {
      previewImageStartedAt.delete(pageNo);
      recordPreviewMetric("imageMs", Math.round(performance.now() - started));
    }
    if (pageNo === previewPageNo) {
      const status = el("preview-image-status");
      if (status) status.hidden = true;
    }
  };
  image.onerror = () => {
    if (pageNo === previewPageNo) {
      const status = el("preview-image-status");
      if (status) {
        status.hidden = false;
        status.textContent = `第 ${pageNo} 页的图像读不出来。`;
      }
    }
  };
  image.src = url;
}

/** 离得远的页把 src 摘掉，别把 394 张大图都留在解码内存里；浏览器缓存还在，回来很快。 */
function releasePreviewImages(anchor) {
  if (previewLoadedPages.size <= 6) return;
  const keep = new Set([anchor - 4, anchor - 3, anchor - 2, anchor - 1, anchor, anchor + 1, anchor + 2, anchor + 3, anchor + 4]);
  for (const pageNo of [...previewLoadedPages]) {
    if (keep.has(pageNo)) continue;
    const tile = previewTiles.get(pageNo);
    if (!tile) continue;
    const image = tile.querySelector("img");
    if (image) {
      image.removeAttribute("src");
      delete image.dataset.src;
      image.classList.remove("is-ready");
    }
    previewLoadedPages.delete(pageNo);
  }
}

/** 目录确认的块懒加载是纯取块（带缓存），预览直接复用同一份缓存。 */
function ensurePreviewBlocks(pageNo) {
  if (previewTileBlocks.has(pageNo)) {
    return Promise.resolve(previewTileBlocks.get(pageNo));
  }
  const pending = previewBlocksPending.get(pageNo);
  if (pending) return pending;
  const promise = loadIndexBlocks(pageNo)
    .then((blocks) => {
      previewTileBlocks.set(pageNo, blocks || []);
      return blocks || [];
    })
    .finally(() => previewBlocksPending.delete(pageNo));
  previewBlocksPending.set(pageNo, promise);
  return promise;
}

/** 画一页的版心 + 块框（同一套渲染，不另写）。 */
function paintPreviewTile(pageNo, { repaint = false } = {}) {
  const tile = previewTiles.get(pageNo);
  const page = previewPageRecord(pageNo);
  if (!tile || !page) return;
  paintTileMargin(tile, page);
  const overlay = tile.querySelector(".page-overlay");
  if (!overlay) return;
  if (!pagesOverlayOn) {
    clearPageBlocks(tile);
    return;
  }
  const blocks = previewTileBlocks.get(pageNo);
  if (!blocks || !blocks.length) return;
  if (!repaint && overlay._renderedBlocks === blocks) return;
  renderPageBlocks(tile, blocks, { details: true });
}

/** 只给当前页 ±1 画图 / 块框；离屏的页立刻清干净，393 页不会一起渲染。 */
function syncPreviewWindow({ repaint = false } = {}) {
  if (!currentProject || currentView !== "preview" || !previewPageNo) return;
  if (!previewTiles.size) buildPreviewPages();
  const total = currentProject.pages.length;
  const want = new Set();
  for (const delta of [-1, 0, 1]) {
    const pageNo = previewPageNo + delta;
    if (pageNo >= 1 && pageNo <= total && previewTiles.has(pageNo)) want.add(pageNo);
  }
  // 当前段跨的页也要在窗口里：跨页段的块可能落在当前页之外的那一页
  const activeSegment = previewActiveSeq !== null
    ? previewSegmentsBySeq.get(previewActiveSeq)
    : null;
  for (const page of (activeSegment && activeSegment.pages) || []) {
    if (previewTiles.has(page.page_no)) want.add(page.page_no);
  }
  for (const [pageNo, tile] of previewTiles) {
    if (want.has(pageNo)) continue;
    clearPageBlocks(tile);
    clearTileMargin(tile);
  }
  for (const pageNo of want) {
    ensurePreviewImage(pageNo);
    paintPreviewTile(pageNo, { repaint });
    if (!previewTileBlocks.has(pageNo)) {
      ensurePreviewBlocks(pageNo).then(() => {
        if (currentView !== "preview") return;
        if (Math.abs(pageNo - (previewPageNo || 1)) > 1) return;
        paintPreviewTile(pageNo, { repaint: true });
        drawPreviewHits();
      });
    }
  }
  releasePreviewImages(previewPageNo);
  updatePreviewPageUI();
  drawPreviewHits();
}

function applyPreviewZoom() {
  if (!previewTiles.size) return;
  const scale = INDEX_ZOOM_SCALES[pageZoomIndex] || 1;
  const width = `${Math.round(scale * 100)}%`;
  for (const tile of previewTiles.values()) tile.style.width = width;
  const label = el("preview-zoom-label");
  if (label) {
    label.textContent = pageZoomIndex >= INDEX_ZOOM_SCALES.length - 1
      ? "适合宽度"
      : `${Math.round(scale * 100)}%`;
  }
  el("preview-zoom-out").disabled = pageZoomIndex <= 0;
  el("preview-zoom-in").disabled = pageZoomIndex >= INDEX_ZOOM_SCALES.length - 1;
  syncPreviewToggles();
}

/** 缩放与页面视图 / 目录确认共用 `pageZoomIndex`；这里只改预览宽度，不动网格。 */
function changePreviewZoom(delta) {
  const next = Math.min(
    INDEX_ZOOM_SCALES.length - 1,
    Math.max(0, pageZoomIndex + delta)
  );
  if (next === pageZoomIndex) return;
  pageZoomTouched = true;
  pageZoomIndex = next;
  applyPreviewZoom();
  measurePreviewTiles();
  syncPreviewWindow({ repaint: true });
  if (previewActiveSeq !== null) {
    const segment = previewSegmentsBySeq.get(previewActiveSeq);
    if (segment) scrollPreviewLeftToSegment(segment, previewActiveBlocks);
  }
}

function syncPreviewToggles() {
  const margin = el("preview-margin-toggle");
  if (margin) {
    margin.classList.toggle("is-on", pagesMarginOn);
    margin.setAttribute("aria-pressed", pagesMarginOn ? "true" : "false");
  }
  const overlay = el("preview-overlay-toggle");
  if (overlay) {
    overlay.classList.toggle("is-on", pagesOverlayOn);
    overlay.setAttribute("aria-pressed", pagesOverlayOn ? "true" : "false");
  }
}

function togglePreviewMargin() {
  toggleMarginView();
  syncPreviewToggles();
  syncPreviewWindow({ repaint: true });
}

function togglePreviewOverlay() {
  togglePageBlocksOverlay();
  syncPreviewToggles();
  syncPreviewWindow({ repaint: true });
}

// ---------------------------------------------------------------- 右：段落列表（与导出同一份 segments）

async function openPreview() {
  if (!currentProject) return;
  // 结果预览默认开版心 + 块框：这一步就是拿来看"正文在版心里的哪一块"的。
  // 两个开关和页面视图 / 目录确认是同一份状态，在这里关掉，回去也是关的。
  if (!pagesMarginOn) {
    pagesMarginOn = true;
    savePageMarginPreference();
    el("pages-margin-toggle")?.classList.add("is-on");
  }
  if (!pagesOverlayOn) {
    pagesOverlayOn = true;
    savePageOverlayPreference();
    el("pages-overlay-toggle")?.classList.add("is-on");
  }
  syncIndexToggles();
  // 审校的差异层样式是 body 级的（body.diff-mode）；离开审校不一定会清掉，
  // 预览的块框别被它压成细线。
  document.body.classList.remove("diff-mode");
  const options = exportOptions();
  const signature = JSON.stringify(options);
  if (
    previewLoading ||
    (!previewData ||
      previewProject !== currentProject.project_id ||
      signature !== previewOptionsSignature)
  ) {
    await loadPreview(options, signature);
    return;
  }
  renderPreview();
  measurePreviewTiles();
  jumpPreviewToPage(previewTargetPage(), { scrollRight: true });
}

function previewTargetPage() {
  const total = currentProject ? currentProject.pages.length : 0;
  const candidates = [previewPageNo, detailPageNo, 1];
  for (const value of candidates) {
    if (value && value >= 1 && value <= total) return value;
  }
  return 1;
}

async function loadPreview(options, signature) {
  if (!currentProject) return;
  previewLoading = true;
  previewData = null;
  previewProject = null;
  el("preview-meta").textContent = "正在按导出设置组装正文…";
  el("preview-segs").innerHTML = "";
  el("preview-note").hidden = true;
  previewSegmentNodes.clear();
  previewSegmentsBySeq.clear();
  previewFirstSeqByPage.clear();
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/export/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      }
    );
    previewData = data;
    previewProject = currentProject.project_id;
    previewOptions = options;
    previewOptionsSignature = signature;
  } catch (error) {
    el("preview-meta").textContent = `预览失败：${error.message || "未知错误"}`;
    return;
  } finally {
    previewLoading = false;
  }
  renderPreview();
  measurePreviewTiles();
  jumpPreviewToPage(previewTargetPage(), { scrollRight: true });
}

/** 与 body.txt 同一套过滤：空段不出现；没开注释流时脚注不进正文。 */
function previewVisibleSegments() {
  if (!previewData) return [];
  const includeFootnotes = Boolean(previewOptions && previewOptions.include_footnotes);
  return (previewData.segments || []).filter((segment) => {
    if (!segment.text || !segment.text.trim()) return false;
    if (!includeFootnotes && segment.type === "footnote") return false;
    if (previewOnlySpan && (segment.pages || []).length < 2) return false;
    return true;
  });
}

function renderPreview() {
  if (!previewData) return;
  const segments = previewData.segments || [];
  const preflight = previewData.preflight || {};
  const marginBlocks = preflight.margin_blocks || {};
  const chars = segments.reduce((sum, segment) => sum + (segment.text || "").length, 0);
  const spans = segments.filter((segment) => (segment.pages || []).length > 1).length;
  const bits = [
    `组装 ${segments.length} 段`,
    `${chars} 字`,
    `跨页 ${spans} 段`,
  ];
  if (marginBlocks.excluded) bits.push(`版心外排除 ${marginBlocks.excluded} 块`);
  bits.push(preflight.margin_judgement ? "按版心判定" : "按块类型判定");
  const meta = el("preview-meta");
  meta.textContent = bits.join(" · ");
  const excludedByType = marginBlocks.excluded_by_type || {};
  const excludedText = Object.entries(excludedByType)
    .map(([type, count]) => `${BLOCK_TYPE_LABELS[type] || type} ${count}`)
    .join(" / ");
  meta.title =
    `与导出共用同一份 segments（${segments.length} 段）。` +
    (marginBlocks.excluded
      ? `版心外排除 ${marginBlocks.excluded} 块${excludedText ? `（${excludedText}）` : ""}。`
      : "") +
    (spans ? `跨页段 ${spans} 段，标「跨页续」。` : "当前没有跨页段。");

  if (previewPagesProject !== currentProject.project_id) {
    buildPreviewPages();
    previewPagesProject = currentProject.project_id;
  } else if (!previewTiles.size || previewTiles.size !== currentProject.pages.length) {
    buildPreviewPages();
  }
  applyPreviewZoom();

  const list = el("preview-segs");
  list.innerHTML = "";
  previewSegmentNodes.clear();
  previewSegmentsBySeq.clear();
  previewFirstSeqByPage.clear();
  const visible = previewVisibleSegments();
  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = previewOnlySpan
      ? "没有跨页段（导出组装里没有段落被页面切开）。"
      : "这一段导出设置下没有可预览的正文。";
    list.append(empty);
  }
  for (const segment of visible) {
    list.append(buildPreviewSegment(segment));
  }
  for (const segment of visible) {
    for (const page of segment.pages || []) {
      if (!previewFirstSeqByPage.has(page.page_no)) {
        previewFirstSeqByPage.set(page.page_no, segment.seq);
      }
    }
  }
  el("preview-only-span").checked = previewOnlySpan;
  recordPreviewMetric("segments", visible.length);
  if (!previewActiveSeq || !previewSegmentNodes.has(previewActiveSeq)) {
    previewActiveSeq = null;
  }
}

function buildPreviewSegment(segment) {
  const pages = (segment.pages || []).map((page) => page.page_no);
  const li = document.createElement("li");
  li.className = "preview-seg";
  li.dataset.seq = String(segment.seq);
  li.dataset.firstPage = String(pages[0] || "");
  li.dataset.pages = pages.join(" ");
  li.dataset.blockIds = (segment.block_ids || []).join(" ");

  const head = document.createElement("div");
  head.className = "preview-seg__head";
  const seq = document.createElement("span");
  seq.className = "preview-seg__seq";
  seq.textContent = `§${segment.seq}`;
  const where = document.createElement("span");
  where.textContent =
    pages.length > 1
      ? `第 ${pages[0]}–${pages[pages.length - 1]} 页`
      : `第 ${pages[0] || "?"} 页`;
  head.append(seq, where);
  if (pages.length > 1) {
    const span = document.createElement("span");
    span.className = "preview-seg__span";
    span.textContent = "跨页续";
    span.title = `这一段跨了第 ${pages.join(" / ")} 页`;
    head.append(span);
  }

  const text = document.createElement("p");
  text.className = "preview-seg__text";
  text.textContent = segment.text;
  li.append(head, text);
  previewSegmentNodes.set(segment.seq, li);
  previewSegmentsBySeq.set(segment.seq, segment);
  return li;
}

// ---------------------------------------------------------------- 联动：段 ↔ 页

function renderPreviewFollow(segment) {
  const node = el("preview-follow");
  if (!node) return;
  if (!segment) {
    node.textContent = "";
    node.title = "";
    return;
  }
  const pages = (segment.pages || []).map((page) => page.page_no);
  if (pages.length > 1) {
    node.textContent = `§${segment.seq} 跨页 ${pages[0]}–${pages[pages.length - 1]}`;
    node.title = `这一段跨了第 ${pages.join(" / ")} 页：左边两页的块都标绿`;
  } else {
    node.textContent = `§${segment.seq} · 第 ${pages[0] || "?"} 页`;
    node.title = "右边当前这一段；左边对应块标绿";
  }
}

function hidePreviewJunction() {
  const node = el("preview-junction");
  if (node) node.hidden = true;
}

/** 跨页段：在左边两页交界处放一条明显分界线（"能看出来是跨页"）。 */
function showPreviewJunction(segment) {
  const node = el("preview-junction");
  if (!node) return;
  const pages = (segment.pages || []).map((page) => page.page_no);
  if (pages.length < 2) {
    node.hidden = true;
    return;
  }
  const next = previewTileTopMap.get(pages[1]);
  const wrap = el("preview-pages");
  const scroller = el("preview-pdf-scroll");
  if (!next || !wrap || !scroller) {
    node.hidden = true;
    return;
  }
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const wrapTop = wrap.getBoundingClientRect().top - base;
  node.textContent = `跨页续 · 第 ${pages[0]} → ${pages[1]} 页 · 两页的块都标绿`;
  node.style.top = `${Math.max(0, Math.round(next.top - wrapTop - 13))}px`;
  node.hidden = false;
}

function clearPreviewHits() {
  for (const tile of previewHitTiles) {
    const hits = tile.querySelector(".preview-page__hits");
    if (hits) {
      hits.innerHTML = "";
      hits.hidden = true;
    }
  }
  previewHitTiles.clear();
}

/** 当前段命中的块：用 bbox 画浅绿框（行框是后端给的块框，不猜字符位置）。 */
function drawPreviewHits() {
  clearPreviewHits();
  for (const item of previewActiveBlocks) {
    const tile = previewTiles.get(item.pageNo);
    if (!tile || !item.block || !item.block.bbox) continue;
    const hits = tile.querySelector(".preview-page__hits");
    if (!hits) continue;
    const box = document.createElement("div");
    box.className = "preview-page__hit";
    applyBoxElementRect(box, item.block.bbox);
    box.title = `第 ${item.pageNo} 页 · 这一段来自这个块`;
    hits.append(box);
    hits.hidden = false;
    previewHitTiles.add(tile);
  }
}

function clearPreviewActive() {
  if (previewActiveSeq !== null) {
    const previous = previewSegmentNodes.get(previewActiveSeq);
    if (previous) previous.classList.remove("is-current");
  }
  previewActiveSeq = null;
  previewActiveBlocks = [];
  previewHitToken += 1;
  drawPreviewHits();
  hidePreviewJunction();
  renderPreviewFollow(null);
}

/** 加载这一段所有页的块，挑出段落命中的块，画浅绿。 */
async function highlightPreviewSegment(segment) {
  const token = ++previewHitToken;
  const pageNos = (segment.pages || []).map((page) => page.page_no);
  renderPreviewFollow(segment);
  showPreviewJunction(segment);
  const wanted = new Set(segment.block_ids || []);
  const byPage = new Map();
  await Promise.all(
    pageNos.map(async (pageNo) => {
      byPage.set(pageNo, await ensurePreviewBlocks(pageNo));
    })
  );
  if (token !== previewHitToken) return [];
  const found = [];
  for (const pageNo of pageNos) {
    for (const block of byPage.get(pageNo) || []) {
      if (block.bbox && wanted.has(block.block_id)) found.push({ block, pageNo });
    }
  }
  previewActiveBlocks = found;
  drawPreviewHits();
  // 块框到了如果还没画（窗口同步拿的是缓存），补一次
  for (const pageNo of pageNos) {
    if (Math.abs(pageNo - (previewPageNo || 1)) <= 1) paintPreviewTile(pageNo);
  }
  return found;
}

/** 左边滚到某一段：单页段定位到块的上沿，跨页段把两页交界放到视口中央。 */
function scrollPreviewLeftToSegment(segment, hits) {
  const scroller = el("preview-pdf-scroll");
  if (!scroller || !previewTiles.size) return;
  const pages = (segment.pages || []).map((page) => page.page_no);
  let target = null;
  if (pages.length > 1) {
    // 段的第一处交界：跨 2 页就是唯一交界，跨 3 页以上从段的开头看
    const next = previewTileTopMap.get(pages[1]);
    if (next) target = next.top - scroller.clientHeight * 0.5;
  } else {
    const first = previewTileTopMap.get(pages[0]);
    if (!first) return;
    const hit = hits && hits.find((item) => item.pageNo === pages[0]);
    target = hit
      ? first.top + first.height * hit.block.bbox[1] - scroller.clientHeight * 0.28
      : first.top - 8;
  }
  if (target === null) return;
  markPreviewDriver("right");
  scroller.scrollTop = Math.max(0, target);
}

function scrollPreviewLeftToPage(pageNo) {
  const scroller = el("preview-pdf-scroll");
  const entry = previewTileTopMap.get(pageNo);
  if (!scroller || !entry) return;
  const target = Math.max(0, entry.top - 8);
  if (Math.abs(scroller.scrollTop - target) < 4) return;
  markPreviewDriver("right");
  scroller.scrollTop = target;
}

function setPreviewActive(seq, { scrollRight = false, scrollLeft = false, keepPage = false } = {}) {
  if (seq === null || seq === undefined) {
    clearPreviewActive();
    return;
  }
  const node = previewSegmentNodes.get(seq);
  const segment = previewSegmentsBySeq.get(seq);
  if (!node || !segment) return;
  if (previewActiveSeq !== seq) {
    const previous = previewActiveSeq !== null ? previewSegmentNodes.get(previewActiveSeq) : null;
    if (previous) previous.classList.remove("is-current");
    node.classList.add("is-current");
    previewActiveSeq = seq;
  }
  if (scrollRight) {
    markPreviewDriver("left");
    node.scrollIntoView({ block: "start", behavior: "auto" });
  }
  const firstPage = (segment.pages[0] || {}).page_no;
  if (!keepPage && firstPage) previewPageNo = firstPage;
  if (scrollLeft) scrollPreviewLeftToSegment(segment, []);
  syncPreviewWindow();
  highlightPreviewSegment(segment).then(() => {
    if (previewActiveSeq !== seq) return;
    if (scrollLeft) scrollPreviewLeftToSegment(segment, previewActiveBlocks);
  });
}

function updatePreviewPageUI() {
  const total = currentProject ? currentProject.pages.length : 0;
  const pageNo = previewPageNo || 1;
  el("preview-page-no").textContent = `第 ${pageNo} 页`;
  el("preview-prev").disabled = pageNo <= 1;
  el("preview-next").disabled = pageNo >= total;
  updatePreviewPrintedLabel(pageNo);
}

/** 页头印刷页：目录确认的索引已经算过，直接借；没算过就懒加载一次。 */
function updatePreviewPrintedLabel(pageNo) {
  const label = el("preview-page-printed");
  if (!label || !currentProject) return;
  if (pageIndexData && pageIndexProject === currentProject.project_id) {
    const entry = pageIndexData.pages.find((item) => item.page_no === pageNo);
    label.textContent = entry
      ? entry.missing
        ? "未识别页码"
        : `印刷页 ${entry.printed[0] || ""}`
      : "";
    return;
  }
  label.textContent = "";
  if (!pageIndexLoading) {
    loadPageIndex().then(() => updatePreviewPrintedLabel(previewPageNo));
  }
}

/** 左边翻页 / 左栏滚到某页 → 右边滚到这一页的第一段。 */
function jumpPreviewToPage(pageNo, { scrollRight = true } = {}) {
  if (!currentProject) return;
  const total = currentProject.pages.length;
  if (!pageNo || pageNo < 1 || pageNo > total) return;
  previewPageNo = pageNo;
  updatePreviewPageUI();
  scrollPreviewLeftToPage(pageNo);
  syncPreviewWindow();
  if (!previewData) return;
  const note = el("preview-note");
  const seq = previewFirstSeqByPage.get(pageNo);
  if (seq === undefined) {
    note.hidden = false;
    note.textContent = previewOnlySpan
      ? `第 ${pageNo} 页没有跨页段。`
      : `第 ${pageNo} 页没有进入正文的段落（封面 / 空白 / 整页插图，或按当前导出设置被排除）。`;
    clearPreviewActive();
    return;
  }
  note.hidden = true;
  setPreviewActive(seq, { scrollRight, keepPage: true });
}

function stepPreviewPage(delta) {
  if (!currentProject) return;
  const total = currentProject.pages.length;
  const next = Math.min(total, Math.max(1, (previewPageNo || 1) + delta));
  if (next === previewPageNo) return;
  jumpPreviewToPage(next, { scrollRight: true });
}

/** 右栏滚动 → 取视口顶端那一段（不逐段量矩形，elementFromPoint 是 O(1)）。 */
function previewSegmentAtTop() {
  const scroller = el("preview-scroll");
  if (!scroller) return null;
  const rect = scroller.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return null;
  if (typeof document.elementFromPoint === "function") {
    const hit = document.elementFromPoint(
      rect.left + Math.min(80, rect.width / 2),
      rect.top + 8
    );
    const node = hit && hit.closest ? hit.closest(".preview-seg") : null;
    if (node) return node;
  }
  const top = rect.top + 6;
  for (const node of scroller.querySelectorAll(".preview-seg")) {
    if (node.getBoundingClientRect().bottom >= top) return node;
  }
  return null;
}

function onPreviewScroll() {
  if (previewRightRaf) return;
  previewRightRaf = requestAnimationFrame(() => {
    previewRightRaf = 0;
    if (currentView !== "preview" || !previewData) return;
    if (previewDriverActive("left")) return;
    const node = previewSegmentAtTop();
    if (!node) return;
    const seq = Number(node.dataset.seq);
    if (!previewSegmentsBySeq.has(seq) || seq === previewActiveSeq) return;
    markPreviewDriver("right");
    setPreviewActive(seq, { scrollLeft: true });
  });
}

/** 左栏滚动 → 右栏定位到这一页的第一段（不让右边的滚动再反过来推左边）。 */
function onPreviewLeftScroll() {
  if (previewLeftRaf) return;
  previewLeftRaf = requestAnimationFrame(() => {
    previewLeftRaf = 0;
    if (currentView !== "preview" || !previewData) return;
    if (previewDriverActive("right")) return;
    const pageNo = previewPageAtScroll();
    if (!pageNo || pageNo === previewPageNo) return;
    markPreviewDriver("left");
    jumpPreviewToPage(pageNo, { scrollRight: true });
  });
}

function previewPageAtScroll() {
  const scroller = el("preview-pdf-scroll");
  if (!scroller || !previewTileTops.length) return previewPageNo || 1;
  const anchor = scroller.scrollTop + scroller.clientHeight * 0.3;
  let lo = 0;
  let hi = previewTileTops.length - 1;
  let best = previewTileTops[0].pageNo;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = previewTileTops[mid];
    if (entry.top <= anchor) {
      best = entry.pageNo;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** 右栏悬停：事件代理，一次 rAF 只处理最后停住的那一段。 */
function onPreviewSegHover(event) {
  const node = event.target.closest ? event.target.closest(".preview-seg") : null;
  if (!node) return;
  const seq = Number(node.dataset.seq);
  if (!previewSegmentsBySeq.has(seq) || seq === previewActiveSeq) return;
  if (seq === previewPendingHover) return;
  previewPendingHover = seq;
  requestAnimationFrame(() => {
    const pending = previewPendingHover;
    previewPendingHover = 0;
    if (currentView !== "preview" || pending === previewActiveSeq) return;
    if (!previewSegmentsBySeq.has(pending)) return;
    // 悬停只做高亮，不拖左边滚动：鼠标停在右栏时左栏自己滚动（或右栏滚过去）
    // 都会不断触发 pointerover，让左边来回跳。要看左边就跟到那一段，点一下。
    setPreviewActive(pending, { keepPage: true });
  });
}

function onPreviewSegClick(event) {
  const node = event.target.closest ? event.target.closest(".preview-seg") : null;
  if (!node) return;
  const seq = Number(node.dataset.seq);
  if (!previewSegmentsBySeq.has(seq)) return;
  markPreviewDriver("right");
  setPreviewActive(seq, { scrollLeft: true });
}

/** 任务 39（E 刀）：工具条上的「⋯」——诊断（质量统计）/ 协作（任务包）。 */
function setupPageMore() {
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

function setupPreview() {
  el("preview-prev").addEventListener("click", () => stepPreviewPage(-1));
  el("preview-next").addEventListener("click", () => stepPreviewPage(1));
  el("preview-zoom-out").addEventListener("click", () => changePreviewZoom(-1));
  el("preview-zoom-in").addEventListener("click", () => changePreviewZoom(1));
  el("preview-margin-toggle").addEventListener("click", togglePreviewMargin);
  el("preview-overlay-toggle").addEventListener("click", togglePreviewOverlay);
  el("preview-scroll").addEventListener("scroll", onPreviewScroll, { passive: true });
  el("preview-pdf-scroll").addEventListener("scroll", onPreviewLeftScroll, { passive: true });
  el("preview-segs").addEventListener("pointerover", onPreviewSegHover);
  el("preview-segs").addEventListener("click", onPreviewSegClick);
  window.addEventListener("resize", () => {
    if (currentView !== "preview") return;
    requestAnimationFrame(() => {
      if (currentView !== "preview") return;
      applyPreviewZoom();
      measurePreviewTiles();
      syncPreviewWindow();
    });
  });
  el("preview-only-span").addEventListener("change", (event) => {
    previewOnlySpan = Boolean(event.target.checked);
    const keep = previewActiveSeq;
    renderPreview();
    measurePreviewTiles();
    if (keep !== null && previewSegmentNodes.has(keep)) {
      setPreviewActive(keep, { scrollRight: false, keepPage: true });
      return;
    }
    const first = previewVisibleSegments()[0];
    if (first) setPreviewActive(first.seq, { scrollRight: true });
    else clearPreviewActive();
  });
}

// ---------------------------------------------------------------- 审校视图（本页）

let detailPageNo = null;
let detailImagePageNo = null;
let reviewBlocks = [];
/** 任务 34：这一页的版心上下文（box / applied / 未定 / 版心外差异数），来自页详情。 */
let detailMargin = null;
/** 这一页所有识别行（含未归属 / 冲突的）。拖框吸附与虚线绘制都用它。 */
let detailLines = [];
/**
 * 差异高亮的渲染状态（任务 63）。
 *
 * 前端 LCS **只在渲染层用**：`computeCharSpans()` 的结果不落库、不参与计数与状态判断；
 * 差异的权威口径永远是后端的分级（将来 `line_diff` 表落地后改为读后端 spans，
 * 删掉这里的前端 LCS，不允许两套口径长期并存）。
 */
let diffMarksMode = "all";           // all | todo | off（任务 45：三态）
let activeDiff = null;               // {blockId, lineIndex, spanIndex}
let activeReviewBlockId = null;
const diffStripOpen = new Set();
/** 页内差异队列（任务 65）：一次只给一处，状态只在本页有效。 */
let diffQueue = [];
let queueIndex = -1;
/** 等差异队列处理完再补算建议 / 漏行的页（任务 43）。 */
let pendingPageAux = null;
let queueOpen = true;
const queueDecisions = new Map(); // key -> "adopted" | "kept"
let lastQueueDecisionKey = null;
let queuePageNo = null;
let detailHistoryState = { undo: 0, redo: 0 };
/** 收尾面板（任务 66）：数字全部来自 /review/finish-summary。 */
let finishSummary = null;
let finishSummaryProject = null;
let finishSummaryLoading = false;
/** 加载途中又有人要求刷新：跑完再补一次，别把新计数丢掉。 */
let finishSummaryAgain = false;
let finishLayoutRemaining = [];
let finishLayoutRunning = false;
let finishLayoutStop = false;
let finishLayoutBase = 0;
let finishLayoutTotalAll = 0;
let finishAutoRemaining = [];
let finishAutoRunning = false;
let finishAutoStop = false;
let finishAutoApplied = [];
let finishAutoTotalAll = 0;
let finishAutoDoneAll = 0;
let finishAutoSkipped = 0;
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
/** 块 id → 页码候选提示（`page_numbers`）：只读，供「把页码拆出去」按钮用。 */
let detailNumberHints = new Map();
/** 最近一次渲染的整页版面确认状态（候选对比等局部刷新时不要拿旧的页面列表覆盖）。 */
let detailLayoutConfirmed = false;
/** 本页工作流确认状态（人工 / 自动 / 未确认），来自块载荷的 `workflow`。 */
let detailWorkflow = null;
/**
 * 审校视图的版心显示开关（任务 53）：默认开，按项目记住。
 * 只是**显示**——版心不参与导出（见 `export_margin_box` 的说明）。
 */
let reviewMarginOn = true;
/** 块列表的过滤档位：`inside`（默认）/ `outside` / `all`。只影响列表，不删数据。 */
let reviewBlockFilter = "pending";
/** 用户是否亲手点过过滤条：分"默认档位"与"用户明确要看版心内"。 */
let reviewFilterExplicit = false;

const BLOCK_TYPE_LABELS = {
  heading: "标题", paragraph: "段落", header: "页眉", footer: "页脚",
  page_number: "页码", footnote: "脚注", caption: "图注",
  figure: "插图", decoration: "装饰", margin_note: "旁批", other: "其他",
};
/** 这些类型的块在导出时不输出文本（figure / decoration 是版面块，不是正文）。 */
const TEXT_FREE_BLOCK_TYPES = new Set(["figure", "decoration"]);
const CHROME_BLOCK_TYPES = new Set(["header", "footer", "page_number"]);
/** 这些块进注释流（不属正文，但不丢文字）。 */
const NOTE_BLOCK_TYPES = new Set(["footnote", "margin_note"]);
const REVIEW_STATUS_LABELS = {
  unreviewed: "未审", confirmed: "已确认", uncertain: "不确定",
};

async function openPageDetail(pageNo) {
  detailPageNo = pageNo;
  detailWorkflow = null;
  // 换页回到默认档位「待处理」：上一页切到「全部」不该带到下一页
  reviewBlockFilter = "pending";
  reviewFilterExplicit = false;
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
  pendingPageAux = null;
  detailPageNo = null;
  detailWorkflow = null;
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
  // 任务 43：先用缓存里的建议把页面画出来，**不再为建议 / 漏行等一次全库重复统计**——
  // 它们会和逐条裁决抢 CPU：第 370 页实测，一边算建议一边按键，单键从 56 ms 涨到 300–470 ms。
  // 有差异队列的页，等队列处理完再补算（那时用户不按队列键了）；没有队列的页立即补算。
  const cachedSuggestions =
    project.kind === "package" ? null : pageSuggestionCache.get(pageNo);
  applyDetailSuggestions(
    cachedSuggestions || { suggestions: [], page_numbers: [], note: null }
  );
  pendingPageAux = null;
  try {
    const data = await apiJson(
      `/api/projects/${project.project_id}/pages/${pageNo}/blocks`
    );
    if (detailPageNo !== null && detailPageNo !== pageNo) return;
    renderPageDetail(data);
    if (queueHasPendingItems()) {
      pendingPageAux = pageNo;
    } else {
      runPageAux(pageNo, { forceSuggestions });
    }
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
  // 页码提示单独一份：块类型**已经是** header / footer / page_number 时也要有
  // （类型建议只返回"与当前类型不同"的块，光靠它，采用之后拆分按钮就消失了）
  detailNumberHints = new Map(
    (payload && Array.isArray(payload.page_numbers) ? payload.page_numbers : []).map(
      (item) => [item.block_id, item]
    )
  );
}

/** 这一页还有没处理的差异（队列非空且有未裁决项）。 */
function queueHasPendingItems() {
  if (!diffQueue.length) return false;
  return queueCounts().remaining > 0;
}

/** 队列空出来以后再补算建议 / 漏行：页面一打开不算，避免和按键抢 CPU。 */
function runPageAux(pageNo, { forceSuggestions = false } = {}) {
  if (pendingPageAux !== null && pendingPageAux !== pageNo) return;
  pendingPageAux = null;
  if (detailPageNo !== pageNo) return;
  loadInkGaps(pageNo); // 不 await：漏行提示是辅助信息，晚一点出来不影响审校
  refreshDetailSuggestions({ force: forceSuggestions });
}

/** 只重拉建议、刷新块头徽章；不动块文本（结构 / 候选结果变了之后用）。 */
async function refreshDetailSuggestions({ force = false } = {}) {
  if (detailPageNo === null || !currentProject) return;
  const pageNo = detailPageNo;
  if (force) forgetPageSuggestions(pageNo);
  let payload = null;
  try {
    payload = await fetchPageSuggestions(pageNo);
  } catch {
    return;
  }
  if (detailPageNo !== pageNo || !currentProject) return;
  applyDetailSuggestions(payload);
  renderSuggestionTools();
  // 建议是异步补算的：用户正在编辑框里打字时不要重建块列表（那会顶掉光标）。
  // 徽章等下一次渲染再出现，数据已经更新。
  const active = document.activeElement;
  const editing =
    active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
  if (!editing) renderReviewBlocks(reviewBlocks);
  renderLayoutPanel();
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

function setReviewOverlay(on) {
  const button = el("toggle-overlay");
  if (!button) return;
  button.classList.toggle("is-on", Boolean(on));
  el("detail-overlay").hidden = !on;
  button.textContent = on ? "显示块框" : "块框已隐藏";
  if (on) scheduleOverlayLayout(el("detail-overlay"));
}

function setReviewMargin(on) {
  reviewMarginOn = Boolean(on);
  const button = el("review-margin-toggle");
  if (button) {
    button.classList.toggle("is-on", reviewMarginOn);
    button.textContent = reviewMarginOn ? "显示版心" : "版心已隐藏";
  }
  if (detailPageNo !== null) paintReviewMargin(detailPageRecord() || null);
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
  el("toggle-diff-marks").addEventListener("click", () => {
    // 三态：未审+已审 → 仅未审 → 关（任务 45 / H 刀）
    diffMarksMode =
      diffMarksMode === "all" ? "todo" : diffMarksMode === "todo" ? "off" : "all";
    drawDiffLayer();
  });
  // 任务 53：审校视图也显示版心，默认开；关掉只影响显示。
  el("review-margin-toggle").addEventListener("click", toggleReviewMargin);
  // 任务 45：采纳/保留计数挪进右栏队列卡（底栏 400px 放不下五项，计数和队列同源更合适）
  {
    const queueTop = document.querySelector("#diff-queue .diff-queue__top");
    const countNode = el("review-footer-count");
    if (queueTop && countNode) queueTop.append(countNode);
  }
  el("review-tree-filter").addEventListener("click", () =>
    setReviewTreeOnlyTodo(!reviewTreeOnlyTodo)
  );
  el("review-tree-rail").addEventListener("click", () =>
    el("review-tree").classList.add("is-open")
  );
  el("review-drawer-toggle").addEventListener("click", () => {
    el("review-drawer-toggle").textContent = el("view-review")
      .querySelector(".editor")
      .classList.toggle("is-collapsed")
      ? "▴"
      : "▾";
  });
  for (const button of el("review-filter").querySelectorAll("[data-margin-filter]")) {
    button.addEventListener("click", () => setReviewBlockFilter(button.dataset.marginFilter));
  }
  window.addEventListener("resize", () => {
    if (zoomLevel === null) applyZoom();
  });
}

function setupReviewAutoPass() {
  el("review-auto-pass").addEventListener("click", async () => {
    if (!currentProject || detailPageNo === null) return;
    const pageNo = detailPageNo;
    setSaveState("正在检查自动通过条件…");
    try {
      const result = await apiJson(
        `/api/projects/${currentProject.project_id}/pages/${pageNo}/auto-pass`,
        { method: "POST" }
      );
      setSaveState("已自动通过（未经人工）✓");
      detailWorkflow = {
        stage: "human_confirmed",
        confirm_mode: "auto",
        stage_label: result.stage_label || "自动通过（未经人工）",
      };
      await loadPageDetail(pageNo);
      await refreshPageStates();
      await loadWorkflow();
    } catch (error) {
      const reasons = error?.detail || error?.message || "条件不满足";
      setSaveState(`不能自动通过：${reasons}`, true);
    }
  });
  el("review-auto-revoke").addEventListener("click", async () => {
    if (!currentProject || detailPageNo === null) return;
    const pageNo = detailPageNo;
    setSaveState("正在撤销自动通过…");
    try {
      await apiJson(
        `/api/projects/${currentProject.project_id}/pages/${pageNo}/auto-pass/revoke`,
        { method: "POST" }
      );
      setSaveState("已撤销自动通过，回到待处理");
      await loadPageDetail(pageNo, { forceSuggestions: true });
      await refreshPageStates();
      await loadWorkflow();
    } catch (error) {
      setSaveState(error.message || "撤销失败", true);
    }
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

// ---------------------------------------------------------------- 审校视图的版心（任务 53）
//
// 用户 2026-10-23：「版心计算的结果，应同步到审校页面，审校内容，默认只审校版心内部的内容」。
// 这里画框 + 过滤列表；**不写库、不影响导出**（自动框只做显示，导出见 `export_margin_box`）。

/** 画 / 收起审校原图上的版心。只读：没有任何把手。 */
function paintReviewMargin(page) {
  const layer = el("detail-margin");
  const canvas = el("detail-canvas");
  if (!layer || !canvas) return;
  const box = reviewMarginOn && page ? marginBoxOfPage(page) : null;
  const show = Boolean(box);
  layer.hidden = !show;
  canvas.classList.toggle("has-margin", show);
  if (!show) {
    layer._box = null;
    return;
  }
  const mode = page.margin_box_mode;
  layer.classList.toggle("page-margin--custom", mode === "custom");
  layer.classList.toggle(
    "page-margin--auto",
    mode !== "custom" &&
      !(mode === "auto" && page.margin_box) &&
      globalMarginIsAuto()
  );
  applyMarginRect(layer.querySelector(".page-margin__box"), box);
}

function toggleReviewMargin() {
  reviewMarginOn = !reviewMarginOn;
  saveReviewMarginPreference();
  const button = el("review-margin-toggle");
  if (button) {
    button.classList.toggle("is-on", reviewMarginOn);
    button.textContent = reviewMarginOn ? "显示版心" : "版心已隐藏";
  }
  paintReviewMargin(detailPageRecord());
}

/** 切换块列表的过滤档位（只重画列表，不动原图 / 编辑状态之外的东西）。 */
function setReviewBlockFilter(mode) {
  if (!["pending", "inside", "outside", "all"].includes(mode)) return;
  reviewBlockFilter = mode;
  reviewFilterExplicit = true;
  renderReviewBlocks(reviewBlocks);
}

/** 这一块是否需要人处理：类型建议 / 两路分歧（数据源与块头徽章、分歧标记一致）。 */
function blockNeedsReview(block) {
  if (detailSuggestionByBlock.has(block.block_id)) return true;
  const divergence = divergenceOf(block);
  return Boolean(divergence && divergence.lines);
}

/** 本页页面级的待处理原因（块列表之外，来自版面 / 漏行 / 识别状态）。 */
function pendingPageReasons() {
  const reasons = [];
  if (!detailLayoutConfirmed) reasons.push("版面未确认");
  if (detailInkGaps.length) reasons.push(`漏行候选 ${detailInkGaps.length}`);
  const page = detailPageRecord();
  const recognition = page ? recognitionOf(page) : null;
  if (recognition && recognition.status === "failed") reasons.push("识别失败");
  return reasons;
}

function pendingBlockCount(blocks) {
  return blocks.filter(blockNeedsReview).length;
}

/**
 * 过滤条：待处理（默认）/ 版心内 / 版心外 / 全部，各带数量。
 *
 * 数量语义：待处理是其中**需要处理**的块；版心内 + 版心外 = 全部。
 * 页面级问题（版面未确认 / 漏行 / 识别失败）在按钮下方单独说明，不硬算成块。
 */
function renderReviewFilter(split, mode) {
  const bar = el("review-filter");
  if (!bar) return;
  const page = detailPageRecord();
  const blocks = reviewBlocks || [];
  // 任务 34：待处理只数版心内的块；版心外的差异不进队列，但要在下面写清未计入多少处。
  const pending = split.inside.filter(blockNeedsReview).length;
  const counts = {
    pending,
    inside: split.inside.length,
    outside: split.outside.length,
    all: blocks.length,
  };
  const labels = { pending: "待处理", inside: "版心内", outside: "版心外", all: "全部" };
  for (const button of bar.querySelectorAll("[data-margin-filter]")) {
    const buttonMode = button.dataset.marginFilter;
    button.textContent = `${labels[buttonMode]} ${counts[buttonMode] ?? 0}`;
    button.classList.toggle("is-on", mode === buttonMode);
    button.disabled = buttonMode === "outside" && counts.outside === 0;
  }
  const notes = [];
  const margin = detailMargin;
  if (!split.box) {
    notes.push(
      margin && margin.none
        ? "本页不适用版心：整页都计入"
        : "本页版心未定：整页都计入（先跑页面准备）"
    );
  }
  const outsideLines = (aggregateDivergence().outside || {}).lines || 0;
  if (outsideLines) {
    notes.push(`版心外 ${outsideLines} 处差异未计入（切到「版心外」查看）`);
  }
  const pageReasons = pendingPageReasons();
  if (pageReasons.length) notes.push(`页面级：${pageReasons.join(" / ")}`);
  if (pending && counts.outside) {
    notes.push("待处理只算版心内；版心外 + 版心内 = 全部块");
  }
  el("review-filter-note").textContent = notes.join("；");
  bar.hidden = false;
}

/** 只刷新过滤条（漏行是异步到达的，不能因此重建正在编辑的块列表）。 */
function refreshReviewFilterOnly() {
  if (!reviewBlocks || !reviewBlocks.length) return;
  const page = detailPageRecord();
  const split = reviewMarginSplit(page, reviewBlocks);
  renderReviewFilter(split, effectiveReviewFilter(page));
}

/**
 * 按块 id 找到列表项；如果它被"版心内"过滤挡住了，自动切到"全部"再找。
 *
 * 这是"隐藏不等于不可操作"的兜底：框选新增 / 撤销回到某个块时，即使这个块
 * 在版心外，也要能立刻看到并编辑，而不是悄悄什么也没发生。
 */
function ensureBlockListed(blockId) {
  let item = el("detail-blocks").querySelector(`li[data-block-id="${blockId}"]`);
  if (item) return item;
  if (reviewBlockFilter === "all") return null;
  reviewBlockFilter = "all";
  reviewFilterExplicit = true;
  renderReviewBlocks(reviewBlocks);
  return el("detail-blocks").querySelector(`li[data-block-id="${blockId}"]`);
}

function renderPageDetail(data) {
  const pageNo = data.page.page_no;
  reviewBlocks = data.blocks;
  detailMargin = data.margin || null;
  detailLines = (data.blocks || []).flatMap((block) => block.lines || []);
  activeReviewBlockId = null;
  activeDiff = null;
  diffStripOpen.clear();

  const recognition = recognitionOf(data.page);
  el("page-detail-title").textContent = `第 ${pageNo} 页`;
  el("page-detail-meta").title = data.active_run
    ? `本页识别来自 ${data.active_run.engine_id} ${data.active_run.engine_version}`
    : "";

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
      // 块框默认关着，没有 scheduleOverlayLayout 来顺手重画差异层：图出来自己画
      drawDiffLayer();
    };
    image.onerror = () => {
      el("detail-image-status").textContent = "这一页渲染失败。";
    };
    image.src =
      `/api/projects/${project_id()}/pages/${pageNo}/image?size=view` +
      `&token=${encodeURIComponent(token)}`;
  } else {
    applyZoom();
    drawDiffLayer();
  }

  detailLayoutConfirmed = Boolean(data.page && data.page.layout_confirmed);
  detailWorkflow = data.workflow || null;
  // 版心要在块框之前画：块框的"版心外"淡色样式取决于画布上的 has-margin 类
  paintReviewMargin(detailPageRecord() || data.page);
  el("review-margin-toggle").classList.toggle("is-on", reviewMarginOn);
  el("review-margin-toggle").textContent = reviewMarginOn ? "显示版心" : "版心已隐藏";
  drawDetailLines();
  drawDetailOverlay(data.blocks);
  renderReviewBlocks(data.blocks);
  // 默认把第一个有差异的块设为当前块（展开差异条，但不抢滚动位置）。
  const firstDiffBlock = (data.blocks || []).find((block) => blockHasDrawableDiff(block));
  if (firstDiffBlock) selectReviewBlock(firstDiffBlock.block_id, { scroll: false });
  initDiffQueue();
  renderReviewHeadline();
  renderSuggestionTools();
  renderLayoutPanel(data);
  renderReviewWorkflowStatus();
  // 任务 45：当前页自动展开、当前条目滚到约 40%（条目用刚渲染的块重建，别拿上一页的）
  reviewTreeItems.set(pageNo, treeItemsFromBlocks(reviewBlocks));
  syncReviewTreeToPage(pageNo, { scroll: true });
}

/** 审校顶栏的自动通过 / 撤销按钮：只切按钮，不改任何块。 */
function renderReviewWorkflowStatus() {
  const workflow = detailWorkflow || {};
  const auto = workflow.stage === "human_confirmed" && workflow.confirm_mode === "auto";
  const confirmed = workflow.stage === "human_confirmed";
  // 已确认（人工 / 自动）或撤销过的页不再显示「自动通过本页」；人工确认按钮仍在底部。
  el("review-auto-pass").hidden = confirmed || Boolean(workflow.auto_pass_excluded);
  el("review-auto-revoke").hidden = !auto;
  el("review-auto-pass").disabled = !reviewBlocks.length;
}

function project_id() {
  return currentProject ? currentProject.project_id : "";
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
  const workflow = data.workflow || {};
  if (workflow.stage === "human_confirmed" && workflow.confirm_mode === "auto") {
    messages.push(
      "本页是「自动通过（未经人工）」：系统只做了状态标记，没有改动任何文字。" +
        "可以点顶栏「撤销自动通过」回到待处理；页面视图的「自动通过（未经人工）」筛选可查看全部清单。"
    );
  } else if (workflow.stage === "human_confirmed" && workflow.confirm_mode === "human") {
    messages.push("本页是人工确认的（点过「确认本页并下一页」）。");
  } else if (workflow.auto_pass_excluded) {
    messages.push("这一页撤销过自动通过，之后不再自动标记；请人工确认。");
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
  // 差异计数只在页头一行结论里出现；横幅不再重复。
  const divergence = divergenceOf(data);
  if (!divergence.lines && divergence.stale_blocks) {
    messages.push(
      `有 ${divergence.stale_blocks} 个块的行结构改过，逐行分歧标记对这些块不再可靠。`
    );
  }
  banner.textContent = messages.join(" ");
  banner.hidden = messages.length === 0;
}

function renderHistoryButtons(history) {
  const state = history || { undo: 0, redo: 0 };
  detailHistoryState = { undo: state.undo || 0, redo: state.redo || 0 };
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

const BOX_ORDER_WIDTH = 22;
const BOX_ORDER_HEIGHT = 16;
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
  else if (TEXT_FREE_BLOCK_TYPES.has(block.block_type)) notes.push("不输出正文");
  else if (CHROME_BLOCK_TYPES.has(block.block_type)) notes.push("只进元数据");
  else if (NOTE_BLOCK_TYPES.has(block.block_type)) notes.push("进注释流");
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
    if (layoutOverlayAnnotations(overlay)) {
      // 差异标记与顺序号在**同一个 rAF** 里重算，滚动 / 缩放时不会各走一帧。
      drawDiffLayer();
      return;
    }
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

// ---------------------------------------------------------------- 差异联动（任务 63）

const DIFF_LEVELS = new Set(["differs_chars", "differs_punct"]);
const DIFF_LCS_MAX_CELLS = 40000;

/** 这一块有没有"能画出来"的差异：等级可画，且 A 上确实有字（纯插入暂不画）。 */
function blockHasDrawableDiff(block) {
  const marks = divergenceOf(block).marks || [];
  return marks.some(
    (mark) =>
      !mark.ack &&
      DIFF_LEVELS.has(mark.level) &&
      computeCharSpans(mark.current, mark.candidate).some((span) => span.aEnd > span.aStart)
  );
}

/** 字符推进宽度（em）：CJK / 全角 1.0，ASCII 字母数字 0.52，ASCII 标点 0.30，空格 0.26。 */
function charAdvance(ch) {
  if (!ch) return 0;
  if (/\s/.test(ch)) return 0.26;
  const code = ch.codePointAt(0);
  if (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x3000 && code <= 0x303f)
  ) {
    return 1.0;
  }
  if (/[A-Za-z0-9]/.test(ch)) return 0.52;
  if (code < 128) return 0.30;
  return 0.60;
}

function textAdvance(text, start = 0, end = null) {
  const value = String(text || "");
  const stop = end === null || end === undefined ? value.length : Math.min(end, value.length);
  let total = 0;
  for (let i = Math.max(0, start); i < stop; i += 1) total += charAdvance(value[i]);
  return total;
}

/**
 * 单行 LCS，返回 A 上需要标记的字符区间。
 *
 * **只在渲染层用**：结果不落库、不参与计数；`line_diff` 表落地后改读后端 spans，
 * 删掉这个函数。行内 ≤160 字，DP 的格子数有上限，超长行整行标记。
 */
function computeCharSpans(current, candidate) {
  const a = String(current || "");
  const b = String(candidate || "");
  if (!a || !b || a === b) return [];
  // 等长（绝大多数行）用逐字比较就够，不必跑 LCS：长行上能把一次渲染从几百毫秒压到几毫秒
  if (a.length === b.length) {
    const spans = [];
    let index = 0;
    while (index < a.length) {
      if (a[index] === b[index]) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < a.length && a[index] !== b[index]) index += 1;
      spans.push({ aStart: start, aEnd: index, bStart: start, bEnd: index, kind: "replace" });
    }
    return spans;
  }
  if (a.length * b.length > DIFF_LCS_MAX_CELLS) {
    return [{ aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length, kind: "replace" }];
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const spans = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const aStart = i;
    const bStart = j;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) break;
      if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) j += 1;
      else i += 1;
    }
    if (i > aStart || j > bStart) {
      spans.push({
        aStart,
        aEnd: i,
        bStart,
        bEnd: j,
        kind: i > aStart && j > bStart ? "replace" : i > aStart ? "delete" : "insert",
      });
    }
  }
  return spans;
}

/** 把 A 的字符区间换算成页面像素（按字符推进宽度估算，向外扩 0.15em）。 */
function diffLevelLabel(level) {
  if (level === "differs_chars") return "汉字级";
  if (level === "differs_punct") return "标点级";
  if (level === "no_candidate") return "第二路没读出";
  return "仅格式差异";
}

function findDiffMark(blockId, lineIndex, spanIndex) {
  return el("detail-diff-layer").querySelector(
    `.diff-mark[data-block-id="${blockId}"][data-line-index="${lineIndex}"][data-span="${spanIndex}"]`
  );
}

/** 在页面上画所有可画的差异标记；整页 / 当前块两种模式。 */
/** 这一行有几段差异（用于行尾角标；只算文本，不碰坐标）。 */
function lineDiffSpanCount(mark) {
  const spans = computeCharSpans(mark.current, mark.candidate).filter(
    (span) => span.aEnd > span.aStart || span.bEnd > span.bStart
  );
  return Math.max(1, spans.length);
}

/** 在页面上画差异：**整行色块**（block_line.bbox，零盲切），三色状态。
 *
 * 全书没有字符级坐标（RapidOCR 只有行框、Apple Vision 连坐标都没有），
 * 所以不用"行宽/字数"去切字符——那会盖到空白或隔壁字。逐字差异放在
 * 右栏文本面板（DOM span）里看。行尾加「n 处」角标。
 */
function drawDiffLayer(attempt = 0) {
  const layer = el("detail-diff-layer");
  if (!layer) return;
  const canvas = el("detail-canvas");
  const toggle = el("toggle-diff-marks");
  if (!canvas || canvas.hidden) {
    layer.innerHTML = "";
    document.body.classList.remove("diff-mode");
    if (toggle) toggle.disabled = true;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 60 || rect.height < 60) {
    if (attempt < 30) requestAnimationFrame(() => drawDiffLayer(attempt + 1));
    return;
  }
  layer.innerHTML = "";
  layer.classList.toggle("is-narrow", rect.width < 480);
  const queueLength = diffQueue.length;
  const queuePos = queueIndex >= 0 ? queueIndex + 1 : 0;
  let total = 0;
  let drawn = 0;
  const pageRecord = detailPageRecord();
  for (const block of reviewBlocks) {
    const divergence = divergenceOf(block);
    if (divergence.stale || !(divergence.marks || []).length) continue;
    // 任务 34：版心外的差异不进审校口径（书眉 / 页码），别在页面上画
    if (!blockCountedInMargin(block, pageRecord)) continue;
    for (const mark of divergence.marks) {
      if (!DIFF_LEVELS.has(mark.level)) continue;
      if (diffMarksMode === "off") continue;
      if (diffMarksMode === "todo" && mark.ack) continue;
      total += 1;
      const line = (block.lines || [])[mark.line_index];
      if (!line || !line.bbox) continue;
      if (line.layout_status === "conflict" || line.layout_status === "unassigned") continue;
      const bbox = line.bbox;
      const left = Math.max(0, bbox[0] * rect.width - 1);
      const top = bbox[1] * rect.height + 1;
      const width = Math.max(4, (bbox[2] - bbox[0]) * rect.width + 2);
      const height = Math.max(6, (bbox[3] - bbox[1]) * rect.height - 2);
      const node = document.createElement("div");
      node.className = "diff-mark";
      if (mark.level === "differs_punct") node.classList.add("diff-mark--punct");
      if (mark.ack) node.classList.add("diff-mark--done");
      const isActive =
        activeDiff &&
        activeDiff.blockId === block.block_id &&
        activeDiff.lineIndex === mark.line_index;
      if (isActive) node.classList.add("is-active");
      node.dataset.blockId = block.block_id;
      node.dataset.lineIndex = String(mark.line_index);
      node.dataset.span = "0";
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.width = `${width}px`;
      node.style.height = `${height}px`;
      const count = lineDiffSpanCount(mark);
      const end = document.createElement("span");
      end.className = "diff-mark__end";
      if (isActive) {
        end.classList.add("is-current");
        end.textContent = queuePos ? `${queuePos}/${queueLength}` : `${count} 处`;
      } else if (mark.ack) {
        end.classList.add("is-done");
        end.textContent = "已保留";
      } else {
        end.textContent = `${count} 处`;
      }
      node.append(end);
      node.title =
        `第 ${mark.line_index + 1} 行 · ${diffLevelLabel(mark.level)} · ` +
        (mark.ack ? "已保留原文（仍是差异）" : `${count} 处差异`) +
        `\n第一路：${truncate(mark.current, 60)}` +
        `\n第二路：${truncate(mark.candidate || "（没读出）", 60)}`;
      node.setAttribute("role", "button");
      node.setAttribute("aria-hidden", "true");
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        activateDiff(block.block_id, mark.line_index, 0);
      });
      layer.append(node);
      drawn += 1;
    }
  }
  document.body.classList.toggle("diff-mode", drawn > 0);
  if (toggle) {
    toggle.disabled = total === 0 && diffMarksMode !== "off";
    toggle.textContent = `差异：${
      diffMarksMode === "all" ? "未审+已审" : diffMarksMode === "todo" ? "仅未审" : "关"
    }`;
    toggle.classList.toggle("is-on", drawn > 0);
  }
}

function flashDiffElement(node) {
  if (!node || typeof node.animate !== "function") return;
  node.animate(
    [{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }],
    { duration: 480, easing: "ease-in-out" }
  );
}

/** 只滚 #viewer-scroll，不动整页（design 4.2：不要用 scrollIntoView）。 */
function scrollViewerTo(node) {
  if (!node) return;
  const scroll = el("viewer-scroll");
  const sr = scroll.getBoundingClientRect();
  const nr = node.getBoundingClientRect();
  const top = scroll.scrollTop + (nr.top - sr.top) - scroll.clientHeight * 0.4;
  scroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function scrollRowIntoList(row) {
  if (!row) return;
  const list = el("detail-blocks");
  const lr = list.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  if (rr.top < lr.top) list.scrollTop += rr.top - lr.top - 8;
  else if (rr.bottom > lr.bottom) list.scrollTop += rr.bottom - lr.bottom + 8;
}

/** 在编辑框里选中某行的某段字符（不滚动页面）。 */
function selectSpanInTextarea(textarea, lineIndex, start, end) {
  if (!textarea) return;
  const lines = textarea.value.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) offset += lines[i].length + 1;
  const len = lines[lineIndex].length;
  const from = offset + Math.max(0, Math.min(start ?? 0, len));
  const to = offset + Math.max(0, Math.min(end ?? len, len));
  textarea.focus();
  textarea.setSelectionRange(from, Math.max(from, to));
}

/** 展开某块的差异条（不重新渲染整页）。 */
function syncDiffStrip(blockId) {
  const item = el("detail-blocks").querySelector(`li[data-block-id="${blockId}"]`);
  const strip = item && item.querySelector(".diff-strip");
  if (!strip) return;
  const open = diffStripOpen.has(blockId);
  const body = strip.querySelector(".diff-strip__body");
  const toggle = strip.querySelector(".diff-strip__toggle");
  if (body) body.hidden = !open;
  if (toggle) toggle.textContent = open ? "收起 ⌃" : "展开 ⌄";
}

function updateDiffActive() {
  for (const row of el("detail-blocks").querySelectorAll(".diff-row")) {
    const active =
      activeDiff &&
      row.dataset.blockId === activeDiff.blockId &&
      Number(row.dataset.lineIndex) === activeDiff.lineIndex;
    row.classList.toggle("is-active", Boolean(active));
  }
  for (const mark of el("detail-diff-layer").querySelectorAll(".diff-mark")) {
    const active =
      activeDiff &&
      mark.dataset.blockId === activeDiff.blockId &&
      Number(mark.dataset.lineIndex) === activeDiff.lineIndex &&
      (activeDiff.spanIndex === null || Number(mark.dataset.span) === activeDiff.spanIndex);
    mark.classList.toggle("is-active", Boolean(active));
  }
}

/**
 * 选中一处差异：左右两侧共用一个状态。
 * 只滚 #viewer-scroll；右栏滚它自己的列表。
 */
function activateDiff(blockId, lineIndex, spanIndex = 0, options = {}) {
  const block = (reviewBlocks || []).find((item) => item.block_id === blockId);
  if (!block) return;
  const divergence = divergenceOf(block);
  const mark = (divergence.marks || []).find((item) => item.line_index === lineIndex);
  if (!mark) return;
  const spans = computeCharSpans(mark.current, mark.candidate).filter((span) => span.aEnd > span.aStart);
  const span = spans[spanIndex] || spans[0] || null;
  diffStripOpen.add(blockId);
  ensureBlockListed(blockId);
  selectReviewBlock(blockId, { scroll: false });
  activeDiff = { blockId, lineIndex, spanIndex: spanIndex ?? 0 };
  syncDiffStrip(blockId);
  updateDiffActive();
  drawDiffLayer();
  requestAnimationFrame(() => {
    const node = findDiffMark(blockId, lineIndex, activeDiff.spanIndex);
    if (node) {
      scrollViewerTo(node);
      flashDiffElement(node);
    }
    const row = el("detail-blocks").querySelector(
      `.diff-row[data-block-id="${blockId}"][data-line-index="${lineIndex}"]`
    );
    scrollRowIntoList(row);
  });
  const item = el("detail-blocks").querySelector(`li[data-block-id="${blockId}"]`);
  const textarea = item && item.querySelector("textarea");
  if (textarea) {
    if (span) selectSpanInTextarea(textarea, lineIndex, span.aStart, span.aEnd);
    else selectSpanInTextarea(textarea, lineIndex, 0, null);
  }
}

function handleDiffMarkClick(blockId, lineIndex, spanIndex) {
  activateDiff(blockId, lineIndex, spanIndex);
}

// ---------------------------------------------------------------- 页内差异队列（任务 65）

function queueKey(item) {
  return `${item.blockId}::${item.lineIndex}`;
}

function buildDiffQueue() {
  const items = [];
  const page = detailPageRecord();
  (reviewBlocks || []).forEach((block, blockIndex) => {
    // 任务 34：队列默认只含版心内；版心外的差异仍画在图上、可在「版心外」展开查看。
    if (!blockCountedInMargin(block, page)) return;
    const divergence = divergenceOf(block);
    if (divergence.stale) return;
    for (const mark of divergence.marks || []) {
      if (!DIFF_LEVELS.has(mark.level) || mark.ack) continue;
      items.push({
        blockId: block.block_id,
        blockIndex,
        lineIndex: mark.line_index,
        level: mark.level,
        current: mark.current,
        candidate: mark.candidate || "",
        key: `${block.block_id}::${mark.line_index}`,
      });
    }
  });
  items.sort(
    (a, b) => a.blockIndex - b.blockIndex || a.lineIndex - b.lineIndex
  );
  return items;
}

function queueCounts() {
  let adopted = 0;
  let kept = 0;
  for (const item of diffQueue) {
    const decision = queueDecisions.get(item.key);
    if (decision === "adopted") adopted += 1;
    else if (decision === "kept") kept += 1;
  }
  return { adopted, kept, remaining: diffQueue.length - adopted - kept };
}

function nextPendingQueueIndex(from) {
  for (let i = from + 1; i < diffQueue.length; i += 1) {
    if (!queueDecisions.has(diffQueue[i].key)) return i;
  }
  for (let i = 0; i <= from; i += 1) {
    if (!queueDecisions.has(diffQueue[i].key)) return i;
  }
  return -1;
}

function aggregateDivergence() {
  const page = detailPageRecord();
  const inside = { lines: 0, chars: 0, punct: 0, acked: 0 };
  const outside = { lines: 0, chars: 0, punct: 0, acked: 0 };
  for (const block of reviewBlocks || []) {
    const divergence = divergenceOf(block);
    if (divergence.stale) continue;
    const bucket = blockCountedInMargin(block, page) ? inside : outside;
    bucket.acked += Number(divergence.acked || 0);
    for (const mark of divergence.marks || []) {
      if (mark.ack) continue;
      if (mark.level === "differs_chars") bucket.chars += 1;
      else if (mark.level === "differs_punct") bucket.punct += 1;
    }
  }
  inside.lines = inside.chars + inside.punct;
  outside.lines = outside.chars + outside.punct;
  inside.outside = outside;
  return inside;
}

/** 页头一行结论：类型 + 版心内差异 + 版心外未计入 + 版面 / 漏行。 */
function renderReviewHeadline() {
  const page = detailPageRecord();
  if (!page) return;
  const counts = aggregateDivergence();
  const outside = counts.outside || { lines: 0 };
  const margin = detailMargin;
  const bits = [PAGE_TYPE_LABELS[page.page_type] || page.page_type];
  if (counts.lines) {
    bits.push(
      `${counts.lines} 处待处理差异（汉字 ${counts.chars} · 标点 ${counts.punct}）` +
        (counts.acked ? ` · 已确认 ${counts.acked}` : "")
    );
  } else if (counts.acked) {
    bits.push(`无待处理差异 · 已确认 ${counts.acked}`);
  } else if (outside.lines) {
    bits.push("无版心内差异");
  } else {
    bits.push("无差异");
  }
  // 任务 34：版心外的书眉 / 页码差异不进队列，但要在页头如实写出来。
  if (outside.lines) bits.push(`版心外 ${outside.lines} 处未计入`);
  if (margin && margin.none) bits.push("整页计入（不适用版心）");
  else if (margin && margin.undetermined) bits.push("整页计入（版心未定）");
  if (!detailLayoutConfirmed) bits.push("版面未确认");
  if (detailInkGaps.length) bits.push(`漏行 ${detailInkGaps.length}`);
  el("page-detail-meta").textContent = bits.join(" · ");
}

function queueDotFor(item) {
  const dot = document.createElement("span");
  dot.className = "diff-queue__dot";
  const decision = queueDecisions.get(item.key);
  if (decision === "adopted") dot.classList.add("is-done");
  else if (decision === "kept") dot.classList.add("is-kept");
  if (queueIndex >= 0 && diffQueue[queueIndex] === item) dot.classList.add("is-current");
  dot.title = `第 ${diffQueue.indexOf(item) + 1} 处`;
  return dot;
}

function renderQueueFooter() {
  const node = el("review-footer-count");
  if (!node) return;
  if (!diffQueue.length) {
    node.textContent = "";
    return;
  }
  const counts = queueCounts();
  node.textContent = `采纳 ${counts.adopted} · 保留 ${counts.kept} · 还剩 ${counts.remaining} 处`;
}

/** 队列视觉：一次只显示当前一处；完成时给一句结论。 */
function renderDiffQueue() {
  const bar = el("diff-queue");
  const toggle = el("diff-queue-toggle");
  if (!bar || !toggle) return;
  const counts = queueCounts();
  const hasQueue = diffQueue.length > 0;
  toggle.hidden = !hasQueue;
  toggle.textContent = `差异 ${counts.lines || aggregateDivergence().lines} ${queueOpen ? "▴" : "▾"}`;
  toggle.title = queueOpen ? "收起差异队列，回到按块浏览" : "打开页内差异队列";
  document.body.classList.toggle("queue-mode", queueOpen && hasQueue);
  bar.hidden = !hasQueue || !queueOpen;
  renderQueueFooter();
  renderReviewHeadline();
  if (!hasQueue) return;

  const countsNow = queueCounts();
  const item = queueIndex >= 0 ? diffQueue[queueIndex] : null;
  const complete = !item || countsNow.remaining === 0;
  // 任务 43：队列处理完（或用户收起队列）后，再补算建议 / 漏行
  if ((complete || !queueOpen) && pendingPageAux === queuePageNo) {
    runPageAux(queuePageNo, { forceSuggestions: true });
  }
  if (!queueOpen) return;
  bar.classList.toggle("is-complete", complete);
  const position = el("diff-queue-position");
  const meta = el("diff-queue-meta");
  const text = el("diff-queue-text");
  const note = el("diff-queue-note");
  const dots = el("diff-queue-dots");
  const adopt = el("queue-adopt");
  const keep = el("queue-keep");
  const prev = el("queue-prev");
  text.innerHTML = "";
  dots.innerHTML = "";
  for (const entry of diffQueue) dots.append(queueDotFor(entry));

  if (complete) {
    position.textContent = "本页已处理完";
    meta.textContent = `${diffQueue.length} 处`;
    text.textContent =
      `本页 ${diffQueue.length} 处已处理完（采纳 ${countsNow.adopted} · 保留 ${countsNow.kept}）· 去下一处`;
    note.textContent = "点右下角「确认本页并下一页」继续；保留原文已记入这一行。";
    adopt.hidden = true;
    keep.hidden = true;
    prev.hidden = true;
    return;
  }

  position.textContent = `第 ${queueIndex + 1} / ${diffQueue.length} 处`;
  const block = (reviewBlocks || []).find((entry) => entry.block_id === item.blockId);
  const blockLabel = block
    ? `第 ${(reviewBlocks || []).indexOf(block) + 1} 块`
    : "未知块";
  meta.textContent = `${diffLevelLabel(item.level)} · ${blockLabel} · 第 ${item.lineIndex + 1} 行`;
  text.append(diffCompareLines(item));
  note.textContent = "队列只在页内推进；「保留原文」会记进这一行，离开本页再回来不会重复出现。";
  adopt.hidden = false;
  keep.hidden = false;
  prev.hidden = false;
  adopt.disabled = !item.candidate;
  keep.disabled = false;
  prev.disabled = !queueDecisions.size;
}

/** 队列选中的那一处：切块、标记 active，但不滚动、不抢 textarea 焦点。 */
function focusQueueItem(item, options = {}) {
  if (!item) return;
  selectReviewBlock(item.blockId, { scroll: false });
  activeDiff = { blockId: item.blockId, lineIndex: item.lineIndex, spanIndex: 0 };
  updateDiffActive();
  drawDiffLayer();
  if (options.scroll) {
    const mark = findDiffMark(item.blockId, item.lineIndex, 0);
    if (mark) scrollViewerTo(mark);
  }
}

function initDiffQueue() {
  diffQueue = buildDiffQueue();
  queueDecisions.clear();
  queuePageNo = detailPageNo;
  lastQueueDecisionKey = null;
  queueIndex = diffQueue.length ? 0 : -1;
  queueOpen = diffQueue.length > 0;
  if (queueIndex >= 0) focusQueueItem(diffQueue[queueIndex]);
  renderDiffQueue();
}

/** 保存一行裁决后只更新这一块与队列，不 loadPageDetail、不重建列表。 */
function applyQueueAckLocally(block, item, ack, newText, returnedBlock) {
  if (ack === "adopted" && newText !== undefined) {
    block.text = newText;
  }
  if (returnedBlock) {
    block.revision = returnedBlock.revision ?? block.revision;
    block.modified = returnedBlock.modified ?? block.modified;
    block.updated_at = returnedBlock.updated_at ?? block.updated_at;
  }
  const divergence = divergenceOf(block);
  const mark = (divergence.marks || []).find(
    (entry) => entry.line_index === item.lineIndex
  );
  if (ack === "adopted") {
    divergence.marks = (divergence.marks || []).filter(
      (entry) => entry.line_index !== item.lineIndex
    );
  } else if (mark) {
    mark.ack = "kept";
  }
  divergence.acked = Number(divergence.acked || 0) + 1;
  divergence.chars = divergence.marks.filter(
    (entry) => !entry.ack && entry.level === "differs_chars"
  ).length;
  divergence.punct = divergence.marks.filter(
    (entry) => !entry.ack && entry.level === "differs_punct"
  ).length;
  divergence.empty = divergence.marks.filter(
    (entry) => !entry.ack && entry.level === "no_candidate"
  ).length;
  divergence.format_only = divergence.marks.filter(
    (entry) => !entry.ack && entry.level === "format_only_differs"
  ).length;
  divergence.lines = divergence.chars + divergence.punct;
  block.divergence = divergence;
  // 任务 45：只改这一行与页行计数，不重建树
  updateReviewTreeAfterAck(block, item, ack);

  const card = el("detail-blocks").querySelector(`li[data-block-id="${block.block_id}"]`);
  if (card) {
    if (ack === "adopted") {
      const textarea = card.querySelector("textarea");
      if (textarea) {
        textarea.value = newText;
        autoSizeTextarea(textarea);
      }
    }
    const strip = card.querySelector(".diff-strip");
    if (strip) {
      const row = strip.querySelector(
        `.diff-row[data-line-index="${item.lineIndex}"]`
      );
      if (row) {
        row.classList.add("is-acked");
        const level = row.querySelector(".diff-row__level");
        if (level) {
          level.textContent =
            diffLevelLabel(mark ? mark.level : item.level) +
            (ack === "kept" ? " · 已保留" : " · 已采纳");
        }
        const adopt = row.querySelector(".diff-row__adopt");
        if (adopt) adopt.remove();
      }
      const count = strip.querySelector(".diff-strip__count");
      if (count) {
        count.textContent = divergence.lines
          ? `两路差异 ${divergence.lines} 行`
          : divergence.acked
            ? `没有待处理差异 · 已确认 ${divergence.acked}`
            : "两路没有实质分歧";
      }
      if (!strip.querySelector(".diff-row")) strip.remove();
    }
  }
  refreshReviewFilterOnly();
}

async function ackQueueLine(block, lineIndex, ack, text = null) {
  return apiJson(
    `/api/projects/${currentProject.project_id}/blocks/${block.block_id}/diff-ack`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line_index: lineIndex, ack, text }),
    }
  );
}

let queueActionRunning = false;

async function adoptQueueCurrent() {
  if (queueActionRunning) return;
  const item = queueIndex >= 0 ? diffQueue[queueIndex] : null;
  if (!item) return;
  const key = item.key;
  if (reviewPendingSave) {
    await flushPendingSave();
    const index = diffQueue.findIndex((entry) => entry.key === key);
    if (index < 0) return;
    queueIndex = index;
  }
  const current = diffQueue[queueIndex];
  const block = (reviewBlocks || []).find((entry) => entry.block_id === current.blockId);
  if (!block) return;
  if (!current.candidate) {
    setSaveState("第二引擎没读出这一行，没有可采用的候选", true);
    return;
  }
  const lines = String(block.text).split("\n");
  if (current.lineIndex < 0 || current.lineIndex >= lines.length) {
    setSaveState("这一块的行号对不上了，先重新载入", true);
    return;
  }
  lines[current.lineIndex] = current.candidate;
  const newText = lines.join("\n");
  queueActionRunning = true;
  setSaveState("正在采纳…");
  try {
    const data = await ackQueueLine(
      block,
      current.lineIndex,
      "adopted",
      newText
    );
    applyQueueAckLocally(block, current, "adopted", newText, data.block);
    queueDecisions.set(key, "adopted");
    lastQueueDecisionKey = key;
    if (data.history) {
      detailHistoryState = data.history;
      renderHistoryButtons(detailHistoryState);
    }
    queueIndex = nextPendingQueueIndex(queueIndex);
    if (queueIndex >= 0) {
      focusQueueItem(diffQueue[queueIndex]);
    } else {
      activeDiff = null;
      updateDiffActive();
      drawDiffLayer();
    }
    renderDiffQueue();
    focusQueueBar();
    setSaveState("已采纳第二路 ✓");
  } catch (error) {
    setSaveState(error.message || "采纳失败", true);
  } finally {
    queueActionRunning = false;
  }
}

async function keepQueueCurrent() {
  if (queueActionRunning) return;
  const item = queueIndex >= 0 ? diffQueue[queueIndex] : null;
  if (!item) return;
  const block = (reviewBlocks || []).find((entry) => entry.block_id === item.blockId);
  if (!block) return;
  queueActionRunning = true;
  setSaveState("正在保留原文…");
  try {
    const data = await ackQueueLine(block, item.lineIndex, "kept");
    applyQueueAckLocally(block, item, "kept", null, data.block);
    queueDecisions.set(item.key, "kept");
    lastQueueDecisionKey = item.key;
    if (data.history) {
      detailHistoryState = data.history;
      renderHistoryButtons(detailHistoryState);
    }
    queueIndex = nextPendingQueueIndex(queueIndex);
    if (queueIndex >= 0) {
      focusQueueItem(diffQueue[queueIndex]);
    } else {
      activeDiff = null;
      updateDiffActive();
      drawDiffLayer();
    }
    renderDiffQueue();
    focusQueueBar();
    setSaveState("已保留原文 ✓");
  } catch (error) {
    setSaveState(error.message || "保留失败", true);
  } finally {
    queueActionRunning = false;
  }
}

function previousQueueItem() {
  for (let i = queueIndex - 1; i >= 0; i -= 1) {
    const decision = queueDecisions.get(diffQueue[i].key);
    if (decision === "adopted") continue;
    if (decision === "kept" || !decision) {
      queueDecisions.delete(diffQueue[i].key);
      queueIndex = i;
      focusQueueItem(diffQueue[i]);
      renderDiffQueue();
      focusQueueBar();
      setSaveState("已回到上一处");
      return;
    }
  }
  setSaveState("已经是第一处；已采纳的请用 ⌘/Ctrl+Z 撤销", true);
}

function setQueueOpen(open) {
  queueOpen = Boolean(open) && diffQueue.length > 0;
  renderDiffQueue();
}

function focusQueueBar() {
  const bar = el("diff-queue");
  if (bar && !bar.hidden) bar.focus({ preventScroll: true });
}

function captureQueueSnapshot() {
  if (!diffQueue.length || queuePageNo !== detailPageNo) return null;
  return {
    pageNo: queuePageNo,
    items: diffQueue.map((item) => ({ ...item })),
    decisions: new Map(queueDecisions),
    index: queueIndex,
    decisionKey: lastQueueDecisionKey,
    listScroll: el("detail-blocks").scrollTop,
    viewerScroll: el("viewer-scroll").scrollTop,
  };
}

/** 撤销一处裁决后：用重载后的未处理差异重建队列，把被撤销那处设为当前。 */
function restoreQueueAfterUndo(snapshot) {
  if (!snapshot || snapshot.pageNo !== detailPageNo) return;
  const key = snapshot.decisionKey;
  // 以撤销后的真实块状态重建队列（不能沿用撤销前那 10 项：被撤销的那处要回来）。
  diffQueue = buildDiffQueue();
  queueDecisions.clear();
  queueOpen = diffQueue.length > 0;
  const index = key ? diffQueue.findIndex((item) => item.key === key) : -1;
  queueIndex =
    index >= 0
      ? index
      : Math.max(0, Math.min(snapshot.index, diffQueue.length - 1));
  lastQueueDecisionKey = null;
  if (queueIndex >= 0) focusQueueItem(diffQueue[queueIndex]);
  renderDiffQueue();
  el("detail-blocks").scrollTop = snapshot.listScroll || 0;
  el("viewer-scroll").scrollTop = snapshot.viewerScroll || 0;
}
function drawDetailOverlay(blocks) {
  const overlay = el("detail-overlay");
  overlay.innerHTML = "";
  // 行框也当作障碍：顺序号 / 卡片不许压到任何一行（含未归属 / 冲突行）
  overlay._lineBboxes = (detailLines || [])
    .map((line) => line.bbox)
    .filter(Boolean);
  const page = detailPageRecord();
  blocks.forEach((block, index) => {
    if (!block.bbox) return;
    const box = document.createElement("div");
    box.className = "box";
    box.classList.add(`box--type-${block.block_type}`);
    // 任务 53：按块中心点标出"版心外"；样式只在版心显示时生效（见 app.css）
    if (!blockInsideMargin(block, page)) box.classList.add("box--outside-margin");
    if (!block.include) box.classList.add("box--excluded");
    if (CHROME_BLOCK_TYPES.has(block.block_type)) box.classList.add("box--chrome");
    if (TEXT_FREE_BLOCK_TYPES.has(block.block_type)) box.classList.add("box--textfree");
    if (block.review_status === "uncertain") box.classList.add("box--uncertain");
    box.dataset.blockId = block.block_id;
    box.dataset.type = block.block_type;
    box._bbox = block.bbox;
    applyBoxElementRect(box, block.bbox);
    box.title =
      `${boxTypeLabel(block)} · 第 ${index + 1} 块 · 拖动移位、拖角缩放`;

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
      // 点到一个被"版心内"过滤挡住的块：先切到「全部」，让它出现在列表里
      const item = ensureBlockListed(block.block_id);
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
  button.textContent = `采用全部高把握建议（${high.length}）`;
  button.title =
    `本页有 ${high.length} 条把握较大的建议（${labels.join(" / ")}）：` +
    "一次改成对应类型，只改类型、不改审校状态；每一块都能单独撤销。";
}

/** 版面面板：页面确认（这页算不算正文）与版面确认（这页里哪些块算正文）分开说。 */
function renderLayoutPanel(data = null) {
  const panel = el("layout-panel");
  if (!panel) return;
  if (!currentProject || currentProject.kind === "package") {
    panel.hidden = true;
    return;
  }
  const blockCount =
    (data && data.review && data.review.block_count) ||
    (data && data.blocks ? data.blocks.length : reviewBlocks.length);
  const high = suggestionHighList().length;
  const confirmed = data && data.page
    ? Boolean(data.page.layout_confirmed)
    : detailLayoutConfirmed;
  panel.hidden = false;
  const status = el("layout-panel-status");
  status.textContent =
    `本页版面：${blockCount} 块 · 高把握建议 ${high} · ${confirmed ? "✓ 已确认" : "未确认"}`;
  status.classList.toggle("is-ok", confirmed);
  const button = el("layout-confirm");
  button.textContent = confirmed ? "✓ 版面已确认" : "确认本页版面";
  button.disabled = confirmed;
}

async function confirmPageLayout() {
  if (!currentProject || detailPageNo === null) return;
  const pageNo = detailPageNo;
  const button = el("layout-confirm");
  button.disabled = true;
  setSaveState("正在确认版面…");
  try {
    await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${pageNo}/layout/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_numbers: [pageNo] }),
      }
    );
    setSaveState("版面已确认 ✓");
    await loadPageDetail(pageNo);
    await refreshPageStates();
  } catch (error) {
    setSaveState(error.message || "版面确认失败", true);
    showError(el("page-detail-error"), error);
  }
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

  // 页码提示只进悬停说明，不占块头宽度（design 3.3：块头只留四样）。
  const pageNumber = pageNumberHintChip(suggestion);
  if (pageNumber) wrap.title += `\n${pageNumber.textContent}\n${pageNumber.title}`;
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
  // 任务 53：中心点在版心外的块（页眉 / 页脚 / 页码 / 版心外的注文）
  const cardPage = detailPageRecord();
  const cardOutside = !blockInsideMargin(block, cardPage);
  if (cardOutside) item.classList.add("review-block--outside-margin");

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
    "review-block__status" +
    (block.review_status === "confirmed"
      ? " review-block__status--ok"
      : block.review_status === "uncertain"
      ? " review-block__status--warn"
      : "");
  status.textContent =
    block.review_status === "confirmed"
      ? "✓ 已确认"
      : REVIEW_STATUS_LABELS[block.review_status] || block.review_status;

  // 块头只留四样：类型 / 建议 / 差异数 / 状态；位置与排除原因降为一行灰字。
  const metaBits = [];
  if (cardOutside) metaBits.push("版心外");
  if (!block.include) metaBits.push("已排除");
  else if (TEXT_FREE_BLOCK_TYPES.has(block.block_type)) metaBits.push("不输出正文");
  else if (CHROME_BLOCK_TYPES.has(block.block_type)) metaBits.push("只进元数据");
  else if (NOTE_BLOCK_TYPES.has(block.block_type)) metaBits.push("进注释流");
  if (block.modified) metaBits.push("已修改");
  if (block.continues_to_next) metaBits.push("延续下页");
  const blockLines = block.lines || [];
  const conflictLines = blockLines.filter((line) => line.layout_status === "conflict").length;
  const unassignedLines = blockLines.filter((line) => line.layout_status === "unassigned").length;
  if (conflictLines) metaBits.push(`冲突行 ${conflictLines}`);
  if (unassignedLines) metaBits.push(`未归属行 ${unassignedLines}`);
  if (!block.bbox) metaBits.push("无位置信息");

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.append(typeSelect);
  const suggestion = detailSuggestionByBlock.get(block.block_id);
  if (suggestion) head.append(blockSuggestionBadge(suggestion));
  head.append(spacer);
  if (metaBits.length) {
    const meta = document.createElement("span");
    meta.className = "review-block__meta";
    meta.textContent = metaBits.join(" · ");
    head.append(meta);
  }
  head.append(status);

  const textarea = document.createElement("textarea");
  textarea.className = "review-block__text";
  textarea.value = block.text;
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
    autoSizeTextarea(textarea);
    scheduleBlockSave(block, textarea.value);
  });
  textarea.addEventListener("focus", () => selectReviewBlock(block.block_id, { scroll: false }));
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
  // 书眉里粘着的页码（`2谁是巴赫金?11`）：只在这一块真的有"贴着块首 / 块尾"的
  // 页码候选时才出现，点了才拆——和"采用建议"一样，建议不等于自动执行。
  const numberHint = pageNumberSplitHint(block);
  if (numberHint) {
    menuItem(
      `把页码 ${numberHint.text} 拆出去`,
      `把${numberHint.position === "start" ? "块首" : "块尾"}的 ${numberHint.text} 拆成独立的「页码」块，` +
        "剩下的部分保持原类型；两块各有自己的框，可撤销。",
      () => structureAction(block, "split-page-number", { candidate_text: numberHint.text })
    );
  }
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
  requestAnimationFrame(() => autoSizeTextarea(textarea));
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
  const marks = (divergence.marks || []).filter((mark) => mark.level !== "format_only_differs");
  if (!marks.length && !divergence.stale) return null;

  const box = document.createElement("div");
  box.className = "diff-strip" + (divergence.chars ? "" : " diff-strip--punct");

  const head = document.createElement("div");
  head.className = "diff-strip__head";
  const count = document.createElement("span");
  count.className = "diff-strip__count";
  const acked = Number(divergence.acked || 0);
  count.textContent = divergence.stale
    ? "两路差异已收起"
    : divergence.lines
      ? `两路差异 ${divergence.lines} 行` + (acked ? ` · 已确认 ${acked}` : "")
      : acked
        ? `没有待处理差异 · 已确认 ${acked}`
        : "两路没有实质分歧";
  const info = document.createElement("button");
  info.type = "button";
  info.className = "diff-strip__info";
  info.textContent = "ⓘ";
  info.title =
    "实测量过：第二引擎比第一引擎弱——被标出的分歧里约八成是它自己的错" +
    "（以汉字错误为主），但标记能圈进第一引擎约 2/3 的错行。" +
    "所以标记只回答「看哪里」，候选只作参考（改对率约 1/4），换不换由你判断。";
  info.addEventListener("click", (event) => event.stopPropagation());
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "diff-strip__toggle";
  toggle.textContent = diffStripOpen.has(block.block_id) ? "收起 ⌃" : "展开 ⌄";
  head.append(count, info, spacer, toggle);
  box.append(head);

  if (divergence.stale) {
    const note = document.createElement("p");
    note.className = "diff-strip__note";
    note.textContent = "这一块的行结构改过（增删过换行），逐行标记会指错地方，已暂时收起——重新识别这一页就能重新得到标记。";
    box.append(note);
    return box;
  }

  const body = document.createElement("div");
  body.className = "diff-strip__body";
  body.hidden = !diffStripOpen.has(block.block_id);
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (diffStripOpen.has(block.block_id)) diffStripOpen.delete(block.block_id);
    else diffStripOpen.add(block.block_id);
    syncDiffStrip(block.block_id);
  });

  const order = { differs_chars: 0, differs_punct: 1, no_candidate: 2 };
  const ordered = [...marks].sort(
    (a, b) =>
      Number(Boolean(a.ack)) - Number(Boolean(b.ack)) ||
      (order[a.level] ?? 9) - (order[b.level] ?? 9) ||
      a.line_index - b.line_index
  );
  for (const mark of ordered.slice(0, MAX_DIVERGENCE_ROWS)) {
    const row = document.createElement("div");
    row.className = "diff-row" + (mark.ack ? " is-acked" : "");
    row.dataset.blockId = block.block_id;
    row.dataset.lineIndex = String(mark.line_index);
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.title =
      `第 ${mark.line_index + 1} 行\n第一路：${truncate(mark.current || "", 80)}\n` +
      `第二路：${truncate(mark.candidate || "（没读出）", 80)}`;

    const where = document.createElement("span");
    where.className = "diff-row__no";
    where.textContent = `第 ${mark.line_index + 1} 行`;
    const level = document.createElement("span");
    level.className = "diff-row__level";
    level.textContent =
      diffLevelLabel(mark.level) +
      (mark.ack === "kept" ? " · 已保留" : mark.ack === "adopted" ? " · 已采纳" : "");

    const text = document.createElement("span");
    text.className = "diff-row__text";
    if (mark.level === "no_candidate") {
      text.textContent = "第二路没读出这一行";
    } else {
      text.append(diffRowFragment(mark));
    }
    row.append(where, level, text);

    if (mark.candidate && !mark.ack) {
      const adopt = document.createElement("button");
      adopt.type = "button";
      adopt.className = "diff-row__adopt";
      adopt.textContent = "换第二路";
      adopt.title = "把这一行换成第二引擎的文本（一次普通编辑，可撤销）";
      adopt.addEventListener("click", (event) => {
        event.stopPropagation();
        adoptLine(block, mark.line_index, mark.candidate);
      });
      row.append(adopt);
    }

    const go = () => activateDiff(block.block_id, mark.line_index, 0);
    row.addEventListener("click", go);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        go();
      }
    });
    body.append(row);
  }
  if (marks.length > MAX_DIVERGENCE_ROWS) {
    const rest = document.createElement("p");
    rest.className = "diff-strip__note";
    rest.textContent = `还有 ${marks.length - MAX_DIVERGENCE_ROWS} 行，按「第二引擎复核」看全部。`;
    body.append(rest);
  }
  box.append(body);
  return box;
}

/** 一行差异的内联片段：…前文[和→或]后文…；只渲染 A 上有字的 span。 */
/** 右栏文本面板：原文 / 候选两整行，**逐字**高亮差异（DOM span，不碰图像坐标）。 */
function diffCompareLines(mark) {
  const current = String(mark.current || "");
  const candidate = String(mark.candidate || "");
  const spans = computeCharSpans(current, candidate);
  const fragment = document.createDocumentFragment();
  const row = (text, key, label) => {
    const line = document.createElement("div");
    line.className = `diff-line diff-line--${key}`;
    const tag = document.createElement("span");
    tag.className = "diff-line__label";
    tag.textContent = label;
    const body = document.createElement("span");
    body.className = "diff-line__text";
    let pos = 0;
    for (const span of spans) {
      const start = key === "a" ? span.aStart : span.bStart;
      const end = key === "a" ? span.aEnd : span.bEnd;
      if (start > pos) body.append(document.createTextNode(text.slice(pos, start)));
      if (end > start) {
        const markEl = document.createElement("mark");
        markEl.className = "diff-char";
        markEl.textContent = text.slice(start, end);
        body.append(markEl);
      }
      pos = Math.max(pos, end);
    }
    if (pos < text.length) body.append(document.createTextNode(text.slice(pos)));
    line.append(tag, body);
    return line;
  };
  if (!spans.length) {
    const note = document.createElement("div");
    note.className = "diff-line__note";
    note.textContent =
      "这一行两路一致或第二路多字，没有可逐字对比的差异；看整行即可。";
    fragment.append(note);
    return fragment;
  }
  fragment.append(row(current, "a", mark.ack === "kept" ? "原文·已保留" : "原文"));
  if (candidate) fragment.append(row(candidate, "b", "候选"));
  return fragment;
}

function diffRowFragment(mark) {
  const fragment = document.createDocumentFragment();
  const current = String(mark.current || "");
  const candidate = String(mark.candidate || "");
  const spans = computeCharSpans(current, candidate).filter((span) => span.aEnd > span.aStart);
  if (!spans.length) {
    const note = document.createElement("span");
    note.className = "diff-strip__note";
    note.textContent = "（第二路多字，待 line_diff）";
    fragment.append(note);
    return fragment;
  }
  spans.slice(0, 2).forEach((span, index) => {
    if (index) fragment.append(document.createTextNode(" … "));
    const prefix = current.slice(Math.max(0, span.aStart - 8), span.aStart);
    const suffix = current.slice(span.aEnd, span.aEnd + 8);
    if (span.aStart > 8 || index) fragment.append(document.createTextNode("…"));
    if (prefix) fragment.append(document.createTextNode(prefix));
    const a = document.createElement("span");
    a.className = "diff-a";
    a.textContent = current.slice(span.aStart, span.aEnd);
    const arrow = document.createElement("span");
    arrow.className = "diff-arrow";
    arrow.textContent = "→";
    const b = document.createElement("span");
    b.className = "diff-b";
    b.textContent = candidate.slice(span.bStart, span.bEnd) || "（删）";
    fragment.append(a, arrow, b);
    if (suffix) fragment.append(document.createTextNode(suffix));
    if (span.aEnd < current.length - 2) fragment.append(document.createTextNode("…"));
  });
  return fragment;
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

/** 编辑框自适应高度：3–20 行；超过 20 行内部滚动（design 3.3）。 */
function autoSizeTextarea(textarea) {
  if (!textarea || !textarea.isConnected) return;
  textarea.style.height = "auto";
  const style = window.getComputedStyle(textarea);
  const lineHeight = parseFloat(style.lineHeight) || 21.45;
  const min = lineHeight * 3 + 14;
  const max = lineHeight * 20 + 14;
  const height = Math.min(Math.max(textarea.scrollHeight, min), max);
  textarea.style.height = `${height}px`;
}

function renderReviewBlocks(blocks) {
  const list = el("detail-blocks");
  list.innerHTML = "";
  const page = detailPageRecord();
  // 任务 53：默认只列版心内的块；版心外 / 全部可切换。过滤只影响"显示哪些卡片"，
  // 所有块仍在 `reviewBlocks` 里、原图上的框也照画——切过去就能编辑 / 采用 / 框选。
  const split = reviewMarginSplit(page, blocks);
  const mode = effectiveReviewFilter(page);
  let visible = blocks;
  if (mode === "pending") {
    // 默认只审版心内：版心外的书眉 / 页码差异不进待处理（任务 34）
    visible = split.inside.filter(blockNeedsReview);
  } else if (split.box && mode === "inside") visible = split.inside;
  else if (split.box && mode === "outside") visible = split.outside;
  renderReviewFilter(split, mode);

  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    const pageReasons = pendingPageReasons();
    if (!blocks.length) {
      empty.textContent = "这一页没有块。";
    } else if (mode === "pending") {
      empty.textContent =
        "这一页没有需要处理的块。" +
        (pageReasons.length
          ? `页面级还有：${pageReasons.join(" / ")}（右侧可确认版面 / 查看漏行）。`
          : "切到「全部」仍可查看和编辑所有块。");
    } else if (!split.box) {
      empty.textContent = "这一页没有块。";
    } else {
      const label = mode === "outside" ? "版心外" : "版心内";
      empty.textContent =
        `这一页没有${label}的块。` +
        (mode === "inside" && split.outside.length
          ? `切到「版心外 ${split.outside.length}」或「全部 ${blocks.length}」可以查看。`
          : "切到「全部」可以查看所有块。");
    }
    list.append(empty);
    return;
  }
  visible.forEach((block, index) =>
    list.append(blockCard(block, index, visible.length))
  );
}

function selectReviewBlock(blockId, options = {}) {
  activeReviewBlockId = blockId;
  for (const item of el("detail-blocks").children) {
    item.classList.toggle("active", item.dataset.blockId === blockId);
  }
  for (const box of el("detail-overlay").children) {
    const isActive = box.dataset.blockId === blockId;
    box.classList.toggle("box--active", isActive);
    // 只滚 #viewer-scroll（design 4.2），不要用 scrollIntoView 连带滚整页。
    if (isActive && options.scroll !== false) scrollViewerTo(box);
  }
  // 当前块的差异条默认展开。
  diffStripOpen.add(blockId);
  syncDiffStrip(blockId);
  updateDiffActive();
  drawDiffLayer();
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
  const item = ensureBlockListed(snapshot.blockId);
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
/**
 * 这一块里"能拆出来"的页码候选：必须贴着块首或块尾（两边都有字 = 夹在中间，不拆）。
 * 只用于菜单文案与传参；服务端会自己再判一次。
 */
function pageNumberSplitHint(block) {
  const entry =
    detailNumberHints.get(block.block_id) || detailSuggestionByBlock.get(block.block_id);
  if (!entry) return null;
  const text = block.text || "";
  const usable = (entry.page_number_candidates || []).filter((item) => {
    if (!Number.isInteger(item.start) || !Number.isInteger(item.end)) return false;
    const before = text.slice(0, item.start).trim();
    const after = text.slice(item.end).trim();
    return Boolean(before) !== Boolean(after);
  });
  if (!usable.length) return null;
  const hint = entry.page_number_hint;
  const match =
    hint && usable.find((item) => item.text === hint.text && item.start === hint.start);
  const chosen = match || usable[usable.length - 1];
  return {
    text: chosen.text,
    position: text.slice(0, chosen.start).trim() ? "end" : "start",
  };
}

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
    } else if (operation === "split-page-number") {
      data = await apiJson(
        `/api/projects/${projectId}/blocks/${block.block_id}/split-page-number`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidate_text: payload.candidate_text || null }),
        }
      );
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
    setSaveState(operation === "split-page-number" ? "页码已拆出，可撤销" : "已保存 ✓");
    // 块的结构 / 顺序变了：本页的块框缓存与本页建议都作废
    // （页面视图那边不能继续显示拆分前的旧框）
    forgetPageBlocks(detailPageNo);
    await loadPageDetail(detailPageNo);
    await refreshPageStates();
    // 新增的块直接聚焦，省一次点击（落在版心外就自动切到「全部」）
    if (operation === "create" && data && data.created) {
      const item = ensureBlockListed(data.created.block_id);
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
    await refreshDetailSuggestions({ force: true });
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
    el("box-select-status").textContent = "";
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
  el("box-select-status").textContent = "";
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
      // 框选出来的块可能落在版心外（比如补一个书眉）：自动切到「全部」，
      // 别让用户以为"创建成功但列表里什么都没有"。
      const item = ensureBlockListed(created.block_id);
      if (item) {
        item.querySelector("textarea").focus();
        item.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  } catch (error) {
    showError(el("page-detail-error"), error);
  }
}

// ---------------------------------------------------------------- 漏行检测与框选识别
//
// 检测阶段偶尔会漏一行（那行字在页面上、但没有 block_line）。补救有两步：
// 1) 只读接口 `GET /pages/{no}/ink-gaps` 找"有墨迹、没有任何行框覆盖"的横条；
// 2) 点候选 → 框选面板预填这块区域 → 「识别这块」调局部重识别（**不落库**），
//    文字填进输入框，用户可改，最后仍走现有的「创建这一块」。

let detailInkGaps = [];
let inkGapsShown = false;

function inkGapBarVisible(count) {
  return count > 0;
}

async function loadInkGaps(pageNo) {
  detailInkGaps = [];
  inkGapsShown = false;
  renderInkGapBar();
  if (!currentProject || currentProject.kind === "package") return;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${pageNo}/ink-gaps`
    );
    if (detailPageNo !== pageNo) return;
    detailInkGaps = (data.candidates || []).filter(
      (item) => Array.isArray(item.bbox) && item.bbox.length === 4
    );
    renderInkGapBar();
    // 漏行是页面级的待处理理由：过滤条与页头结论要跟着变，但不重建正在编辑的列表
    refreshReviewFilterOnly();
    renderReviewHeadline();
  } catch {
    // 辅助信息：读不到不打断审校
  }
}

function renderInkGapBar() {
  const bar = el("ink-gap-bar");
  if (!inkGapBarVisible(detailInkGaps.length)) {
    bar.hidden = true;
    inkGapsShown = false;
    drawInkGapMarks();
    return;
  }
  bar.hidden = false;
  el("ink-gap-text").textContent =
    `可能漏了 ${detailInkGaps.length} 处：这几行有字，但没有任何块框住`;
  el("ink-gap-toggle").textContent = inkGapsShown ? "收起标记" : "在图上标出";
  drawInkGapMarks();
}

function drawInkGapMarks() {
  const layer = el("detail-ink-gaps");
  layer.innerHTML = "";
  layer.hidden = !inkGapsShown || !detailInkGaps.length;
  if (layer.hidden) return;
  detailInkGaps.forEach((item, index) => {
    const [x0, y0, x1, y1] = item.bbox;
    const rect = document.createElement("button");
    rect.type = "button";
    rect.className = "ink-gap";
    rect.style.left = `${x0 * 100}%`;
    rect.style.top = `${y0 * 100}%`;
    rect.style.width = `${(x1 - x0) * 100}%`;
    rect.style.height = `${(y1 - y0) * 100}%`;
    rect.title =
      `可能漏了这一行（墨迹占页宽 ${(item.ink_ratio * 100).toFixed(1)}%）：` +
      "点一下把它框起来，用「识别这块」认字";
    rect.addEventListener("click", (event) => {
      event.stopPropagation();
      startRegionRecognition(item.bbox);
    });
    layer.append(rect);
  });
}

/** 从漏行候选 / 手动框选进入"识别这块"：先把框画出来，再自动认一次。 */
function startRegionRecognition(bbox) {
  if (!boxCreateMode) setBoxCreateMode(true);
  boxDraft = { x0: bbox[0], y0: bbox[1], x1: bbox[2], y1: bbox[3] };
  drawBoxDraft();
  el("box-select-panel").hidden = false;
  el("box-select-info").textContent =
    `已框选：横向 ${(bbox[0] * 100).toFixed(0)}–${(bbox[2] * 100).toFixed(0)}%、` +
    `纵向 ${(bbox[1] * 100).toFixed(0)}–${(bbox[3] * 100).toFixed(0)}%（来自漏行标记）`;
  el("box-select-text").value = "";
  el("box-select-text").focus();
  recognizeBoxRegion();
}

/** 只识别框里的这一块：不落库，结果写进输入框等用户确认。 */
async function recognizeBoxRegion() {
  const box = boxDraftRect();
  if (!currentProject || detailPageNo === null || !box) return;
  const button = el("box-select-recognize");
  const status = el("box-select-status");
  const pageNo = detailPageNo;
  button.disabled = true;
  status.textContent = "识别中…";
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${pageNo}/recognize-region`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox: box }),
      }
    );
    if (detailPageNo !== pageNo) return;
    if (data.text) {
      el("box-select-text").value = data.text;
      el("box-select-text").focus();
      status.textContent =
        `认出 ${data.lines.length} 行（${data.elapsed_seconds}s）· 可以改，再点「创建这一块」`;
    } else {
      status.textContent = "这块里没认出文字；可以直接打字，或换个框";
    }
  } catch (error) {
    status.textContent = error.message || "识别失败";
    showError(el("page-detail-error"), error);
  } finally {
    button.disabled = false;
  }
}

function setupBoxCreate() {
  el("detail-box-create").addEventListener("click", () => setBoxCreateMode(!boxCreateMode));
  const canvas = el("detail-canvas");
  canvas.addEventListener("mousedown", onBoxMouseDown);
  window.addEventListener("mousemove", onBoxMouseMove);
  window.addEventListener("mouseup", onBoxMouseUp);
  el("box-select-confirm").addEventListener("click", createBlockFromBox);
  el("box-select-recognize").addEventListener("click", recognizeBoxRegion);
  el("ink-gap-toggle").addEventListener("click", () => {
    inkGapsShown = !inkGapsShown;
    renderInkGapBar();
  });
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
    await refreshDetailSuggestions({ force: true });
    await refreshPageStates();
  } catch (error) {
    showError(el("page-detail-error"), error);
  }
}

async function reviewAction(path) {
  if (!currentProject) return null;
  el("page-detail-error").hidden = true;
  const queueSnapshot = path === "undo" ? captureQueueSnapshot() : null;
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/${path}`, {
      method: "POST",
    });
    setSaveState(data.direction === "undo" ? "已撤销" : "已重做");
    // 撤销 / 重做可能改回块类型与结构：本页块框缓存与建议都不能拿旧的
    forgetPageBlocks(detailPageNo);
    await loadPageDetail(detailPageNo);
    if (queueSnapshot) restoreQueueAfterUndo(queueSnapshot);
    await refreshPageStates();
    // 刷新页面状态后再对齐一次：避免异步渲染把刚恢复的队列覆盖成旧快照。
    if (queueSnapshot) restoreQueueAfterUndo(queueSnapshot);
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
    // 收尾面板 / 步骤条的计数要跟着动：不 await，翻到下一页不等这次聚合
    // （394 页的项目 finish-summary 要 1–2 秒；在飞时再触发会被合并成一次补跑）。
    loadFinishSummary({ silent: true });
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

// ---------------------------------------------------------------- 收尾面板（任务 66）

function finishChipText() {
  // 任务 69：识别在跑时服务端给的是**旧快照**（不重算 662 页），这里要说明白，
  // 否则用户会以为"刚认完的页怎么没算进去"。
  const suffix = finishSummary && finishSummary.stale ? " · 更新中" : "";
  return finishSummary ? `收尾 ${finishSummary.k}/6${suffix}` : "收尾 —/6";
}

function updateFinishChips() {
  for (const id of ["finish-open", "finish-open-review"]) {
    const node = el(id);
    if (!node) continue;
    node.textContent = finishChipText();
    node.classList.toggle("is-incomplete", Boolean(finishSummary) && finishSummary.k < 6);
    node.classList.toggle("is-done", Boolean(finishSummary) && finishSummary.k === 6);
    node.title = finishSummary && finishSummary.stale
      ? "识别进行中，这里的数字是上一次算好的快照（不跟识别抢 CPU）。识别结束后自动变准。"
      : "";
  }
  const note = el("finish-stale-note");
  if (note) note.hidden = !(finishSummary && finishSummary.stale);
}

function finishIcon(id, state) {
  const node = el(id);
  if (!node) return;
  node.textContent = state === "ok" ? "✓" : state === "warn" ? "!" : "·";
  node.classList.toggle("is-ok", state === "ok");
  node.classList.toggle("is-warn", state === "warn");
}

async function loadFinishSummary({ silent = false } = {}) {
  if (!currentProject) return;
  if (finishSummaryLoading) {
    // 已经有一次在跑：记下"跑完再来一次"，别把这一次（例如刚确认完跨页延续）
    // 直接丢掉——丢掉就会在界面上留下旧计数。
    finishSummaryAgain = true;
    return;
  }
  finishSummaryLoading = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/review/finish-summary`
    );
    finishSummary = data;
    finishSummaryProject = currentProject.project_id;
    if (!stepsReady) {
      stepsReady = true;
      flushBootQueue();
    }
    updateFinishChips();
    renderFinishPanel();
    syncWorkflowSteps();
  } catch (error) {
    if (!silent) showError(el("pages-error"), error);
  } finally {
    finishSummaryLoading = false;
    if (finishSummaryAgain) {
      finishSummaryAgain = false;
      loadFinishSummary({ silent: true });
    }
  }
}

function renderFinishPanel() {
  if (!finishSummary) return;
  const data = finishSummary;
  el("finish-project-name").textContent = data.project?.name || "";

  const pageType = data.page_type;
  finishIcon("finish-icon-page-type", pageType.complete ? "ok" : "warn");
  el("finish-page-type-status").textContent = `${pageType.confirmed} / ${pageType.total} 已确认`;
  el("finish-page-type-sub").textContent =
    pageType.confirmed >= pageType.total
      ? "所有页面类型都已确认"
      : `还有 ${pageType.total - pageType.confirmed} 页未确认`;
  const confirmPages = el("finish-confirm-pages");
  confirmPages.hidden = pageType.complete;
  confirmPages.textContent = `确认全部未确认页（${pageType.total - pageType.confirmed}）`;
  confirmPages.disabled = pageType.complete;

  const margin = data.margin;
  finishIcon("finish-icon-margin", margin.complete ? "ok" : "warn");
  el("finish-margin-status").textContent = `${margin.set} / ${margin.total} 已定`;
  const marginNotes = [];
  if (margin.fallback) marginNotes.push(`${margin.fallback} 页退本页包围盒`);
  if (margin.no_text) marginNotes.push(`${margin.no_text} 页无文字，跳过`);
  if (margin.undetermined) marginNotes.push(`${margin.undetermined} 页未定（还没有拟合框）`);
  el("finish-margin-sub").textContent = marginNotes.length
    ? marginNotes.join(" · ")
    : "每页都有生效版心";
  const fallbackCount =
    (margin.fallback_pages || []).length + (margin.undetermined_pages || []).length;
  const fallback = el("finish-margin-pages");
  fallback.hidden = fallbackCount === 0;
  fallback.textContent = `查看兜底 / 未定页（${fallbackCount}）`;

  const layout = data.layout;
  finishIcon("finish-icon-layout", layout.complete ? "ok" : "warn");
  el("finish-layout-status").textContent = `${layout.confirmed} / ${layout.total} 已确认`;
  el("finish-layout-sub").textContent =
    layout.remaining > 0 ? `还差 ${layout.remaining} 页正文版面` : "所有正文页版面已确认";
  const layoutButton = el("finish-confirm-layout");
  layoutButton.hidden = layout.remaining === 0;
  layoutButton.disabled = finishLayoutRunning || layout.remaining === 0;
  layoutButton.textContent = layout.remaining ? `确认全部正文页版面` : "版面已全部确认";

  const pn = data.page_numbers;
  finishIcon("finish-icon-pagenum", pn.located ? "ok" : "warn");
  el("finish-pagenum-status").textContent = pn.located ? "已定位" : "未定位（可跳过）";
  el("finish-pagenum-sub").textContent =
    `已填 ${pn.filled} / ${pn.total} 页 · 可跳过、不挡导出`;
  el("finish-open-pagenum").textContent = pn.located ? "核对页码…" : "定位页码…";

  const review = data.review;
  // 任务 42 / 61：完成判定只读后端 `review.complete`（含跨页延续 + 整条差异队列）。
  const continuationCount = Number(review.continuation_pending || 0);
  const reviewDone = Boolean(review.complete);
  const charsTotal = Number(review.chars_total || 0);
  const charsLeft = Number(review.chars_pending || 0);
  const punctGroups = review.punct_groups || {};
  const punctLeft = Number(punctGroups.undecided_groups || 0);
  finishIcon("finish-icon-review", reviewDone ? "ok" : "warn");
  // 两行：汉字差异一行、标点差异一行（显示分开，判定合并）
  el("finish-review-status").textContent =
    `汉字差异 ${charsTotal - charsLeft} / ${charsTotal}` +
    ` · 标点差异 ${Number(punctGroups.decided_groups || 0)} / ${Number(punctGroups.groups || 0)} 组`;
  el("finish-review-sub").textContent =
    (punctLeft
      ? `标点还有 ${punctLeft} 组 · ${Number(punctGroups.undecided_lines || 0)} 行没判（可按模式批量）· `
      : "标点差异已判完 · ") +
    `${review.auto_passable} 页可直接通过 · ${review.needs_human} 页要人看` +
    ` · 已确认 ${review.confirmed} / ${review.total} 页正文` +
    (continuationCount ? ` · 跨页延续待确认 ${continuationCount} 处` : "");
  const auto = el("finish-auto-pass");
  auto.hidden = review.auto_passable === 0;
  auto.disabled = finishAutoRunning || review.auto_passable === 0;
  auto.textContent = `标记 ${review.auto_passable} 页自动通过`;
  if (data.layout.remaining > 0 && review.auto_passable > 0) {
    auto.title = "先确认版面，否则这些页会被自动通过条件拒绝";
  } else {
    auto.title = "只写「自动通过（未经人工）」状态，不改任何块文字";
  }

  const engine = data.engine;
  finishIcon("finish-icon-engine", engine.aux_complete ? "ok" : "warn");
  el("finish-engine-status").textContent =
    `${engine.checked} / ${engine.total} 已复核` + (engine.aux_complete ? "" : " · 可选");
  el("finish-engine-sub").textContent =
    `比过 ${engine.compared_lines} 行 · 分歧率 ${(engine.diverging_rate * 100).toFixed(1)}%` +
    (engine.empty_lines ? ` · 没读出 ${engine.empty_lines} 行` : "");
  const check = el("finish-check-engine");
  check.hidden = engine.aux_complete;
  check.textContent = `复核全部未复核页（${engine.total - engine.checked}）`;

  const bottom = el("finish-bottom-note");
  if (
    continuationCount === 0 &&
    review.needs_human === 0 &&
    review.auto_passable === 0
  ) {
    bottom.textContent = "所有正文页都已确认，可以导出；预检会记录实际状态。";
  } else if (review.needs_human === 0 && review.auto_passable === 0) {
    bottom.textContent =
      `还有 ${continuationCount} 处跨页延续要人确认（决定段落是否跨页合并）；` +
      "确认完这一项，正文审校才算完成。";
  } else if (review.needs_human === 0) {
    bottom.textContent =
      `还有 ${review.auto_passable} 页可直接通过（未经人工）。` +
      `先点「标记自动通过」；或现在导出，预检会记录这些页未经人工确认。`;
  } else {
    bottom.textContent =
      `还有 ${review.needs_human} 页需要人看。` +
      `或者现在导出，预检会记录 ${review.needs_human} 页未经人工确认。`;
  }
  el("finish-start-review").textContent = review.needs_human
    ? `从第 ${review.needs_human_pages[0] || 1} 页开始审校`
    : "回到第 1 页审校";

  // 任务 42：跨页延续第三桶的两个入口（审校工具条计数 + 数据清理行）
  const continuationChip = el("review-continuations");
  if (continuationChip) {
    continuationChip.hidden = continuationCount === 0;
    continuationChip.textContent = `跨页延续待确认 ${continuationCount}`;
  }
  const continuationOpen = el("cleanup-continuation-review-open");
  if (continuationOpen) {
    continuationOpen.disabled = continuationCount === 0;
    continuationOpen.textContent = continuationCount
      ? `逐条确认（${continuationCount}）…`
      : "全部已确认";
  }
  const continuationStatus = el("cleanup-continuation-review-status");
  if (continuationStatus) {
    continuationStatus.textContent = continuationCount
      ? `还有 ${continuationCount} 处自动判不了：页末行走满版心，但末字是句末标点。`
      : `全书 ${review.continuation_total || 0} 个页边界都已确认。`;
  }
}

// ---------------------------------------------------------------- 数据清理（任务 41）
//
// 收尾面板里的两个批量动作：跨页延续自动判定（F1）与家具块类型清理（F2）。
// 都是"先看计划 → 确认 → 整批写入一个 batch"，撤销走同一个撤销栈。

function setCleanupStatus(id, text, isError = false) {
  const node = el(id);
  if (!node) return;
  node.textContent = text;
  node.style.color = isError ? "var(--bad-fg)" : "";
}

async function runContinuationCleanup() {
  if (!currentProject || currentProject.kind === "package") return;
  const base = `/api/projects/${currentProject.project_id}/cleanup/continuations`;
  setCleanupStatus("cleanup-continuation-status", "正在分析页边界…");
  let plan;
  try {
    plan = await apiJson(base);
  } catch (error) {
    setCleanupStatus("cleanup-continuation-status", `分析失败：${error.message}`, true);
    return;
  }
  const stats = plan.stats || {};
  const ok = window.confirm(
    `自动判定跨页延续？\n\n` +
      `全书 ${stats.boundaries || 0} 个页边界：\n` +
      `· ${stats.continue || 0} 条判定为延续（标「延续」）\n` +
      `· ${stats.end || 0} 条判定为结束（标「不延续」）\n` +
      `· ${stats.review || 0} 条留给人工（进审校队列）\n` +
      `· ${stats.manual || 0} 条你标注过，不覆盖\n\n` +
      "只改「延续」标记，不改文字；整批可撤销。"
  );
  if (!ok) {
    setCleanupStatus(
      "cleanup-continuation-status",
      `计划：${stats.continue || 0} 延续 / ${stats.end || 0} 结束 / ${stats.review || 0} 待人工（未写入）`
    );
    return;
  }
  setCleanupStatus("cleanup-continuation-status", "正在写入…");
  try {
    const result = await apiJson(base, { method: "POST" });
    const s = result.stats || {};
    setCleanupStatus(
      "cleanup-continuation-status",
      `已标 ${s.continue || 0} 条延续 / ${s.end || 0} 条结束；${s.review || 0} 条待人工；` +
        `实际改动 ${result.changed || 0} 块。`
    );
    await afterCleanupApplied();
  } catch (error) {
    setCleanupStatus("cleanup-continuation-status", `写入失败：${error.message}`, true);
  }
}

async function runFurnitureCleanup() {
  if (!currentProject || currentProject.kind === "package") return;
  const base = `/api/projects/${currentProject.project_id}/cleanup/furniture`;
  setCleanupStatus("cleanup-furniture-status", "正在扫描家具块…");
  let plan;
  try {
    plan = await apiJson(base);
  } catch (error) {
    setCleanupStatus("cleanup-furniture-status", `扫描失败：${error.message}`, true);
    return;
  }
  const stats = plan.stats || {};
  if (!stats.blocks) {
    setCleanupStatus("cleanup-furniture-status", "没有发现整块都是家具的块。");
    return;
  }
  const byType = stats.by_type || {};
  const typeText = Object.entries(byType)
    .map(([type, count]) => `${BLOCK_TYPE_LABELS[type] || type} ${count}`)
    .join(" / ");
  const ok = window.confirm(
    `把 ${stats.blocks} 个「整块都是书眉 / 页码」的块改类型？\n\n` +
      `· ${typeText}\n` +
      `· 涉及 ${stats.pages} 页、${stats.chars} 字（这些字目前会混进正文）\n\n` +
      "只改块类型，不删文字、不按行拆；整批可撤销。"
  );
  if (!ok) {
    setCleanupStatus(
      "cleanup-furniture-status",
      `计划：${stats.blocks} 块（${typeText}），未写入`
    );
    return;
  }
  setCleanupStatus("cleanup-furniture-status", "正在写入…");
  try {
    const result = await apiJson(base, { method: "POST" });
    const s = result.stats || {};
    setCleanupStatus(
      "cleanup-furniture-status",
      `已改 ${result.changed || 0} 块（${typeText}），涉及 ${s.pages || 0} 页。`
    );
    await afterCleanupApplied();
  } catch (error) {
    setCleanupStatus("cleanup-furniture-status", `写入失败：${error.message}`, true);
  }
}

// ---------------------------------------------------------------- 字符规范化（任务 49）
//
// 三组括号 + 半角标点 + 引号配平，都是"两路一致"所以进不了差异队列的隐形错。
// 先只读分析（改多少行 / 多少字、引号能修几处、还剩几处配不平），确认后整批写库；
// 写的是 `block.text`，和人工编辑同一条事件链，一次撤销就能全退。

async function runOrthographyCleanup() {
  if (!currentProject || currentProject.kind === "package") return;
  const base = `/api/projects/${currentProject.project_id}/cleanup/orthography`;
  setCleanupStatus("cleanup-orthography-status", "正在扫描括号 / 引号…");
  let plan;
  try {
    plan = await apiJson(base);
  } catch (error) {
    setCleanupStatus("cleanup-orthography-status", `扫描失败：${error.message}`, true);
    return;
  }
  const stats = plan.stats || {};
  const brackets = stats.brackets || {};
  const punct = stats.punct || {};
  const punctText = Object.entries(punct)
    .map(([ch, count]) => `${ch}×${count}`)
    .join("、");
  const detail =
    `括号 ${brackets["〈〉"] || 0} 个 → 〈〉、${brackets["［］"] || 0} 个 → ［］、` +
    `${brackets["〔〕"] || 0} 个 → 〔〕` +
    (punctText ? `；半角标点 ${punctText}` : "") +
    `；引号自动修 ${stats.quote_autofix || 0} 处，仍配不平 ${stats.unbalanced || 0} 处（进清单，不硬配）`;
  setCleanupStatus("cleanup-orthography-status", `计划：${detail}`);
  if (!stats.blocks_changed) {
    setCleanupStatus("cleanup-orthography-status", `没有要改的：${detail}`);
    return;
  }
  const ok = window.confirm(
    `改 ${stats.blocks_changed} 个块的文字？\n\n` +
      `· ${detail}\n` +
      `· 涉及 ${stats.pages} 页、${stats.chars_changed} 个字符\n\n` +
      "只改原文里的括号/标点/引号，不改块的类型、框和审校状态；整批可撤销。"
  );
  if (!ok) {
    setCleanupStatus("cleanup-orthography-status", `未写入：${detail}`);
    return;
  }
  setCleanupStatus("cleanup-orthography-status", "正在写入…");
  try {
    const result = await apiJson(base, { method: "POST" });
    const s = result.stats || {};
    setCleanupStatus(
      "cleanup-orthography-status",
      `已改 ${result.changed || 0} 块、${s.chars_changed || 0} 字（${s.pages || 0} 页）；` +
        `引号自动修 ${s.quote_autofix || 0} 处，仍配不平 ${s.unbalanced || 0} 处。`
    );
    await afterCleanupApplied();
  } catch (error) {
    setCleanupStatus("cleanup-orthography-status", `写入失败：${error.message}`, true);
  }
}

/** 行文本 + 第二引擎 + 行级 diff 重算（必须在字符规范化之后跑）。 */
async function runLinesCleanup() {
  if (!currentProject || currentProject.kind === "package") return;
  const base = `/api/projects/${currentProject.project_id}/cleanup/orthography/lines`;
  setCleanupStatus("cleanup-lines-status", "正在扫描行文本与第二引擎…");
  let plan;
  try {
    plan = await apiJson(base);
  } catch (error) {
    setCleanupStatus("cleanup-lines-status", `扫描失败：${error.message}`, true);
    return;
  }
  const stats = plan.stats || {};
  if (!stats.changed) {
    setCleanupStatus(
      "cleanup-lines-status",
      `没有要改的行（共 ${stats.lines || 0} 行；format_only ${stats.after?.format_only_differs ?? 0}）。`
    );
    return;
  }
  const before = stats.before || {};
  const after = stats.after || {};
  const ok = window.confirm(
    `改 ${stats.changed} 行的文本并重算行级 diff？\n\n` +
      `· 行文本 ${stats.text_changed} 行、第二引擎 ${stats.aux_changed} 行、状态变化 ${stats.status_changed} 行\n` +
      `· format_only_differs：${before.format_only_differs || 0} → ${after.format_only_differs || 0}\n` +
      `· differs：${before.differs || 0} → ${after.differs || 0}\n` +
      (stats.skipped_ack ? `· 跳过 ${stats.skipped_ack} 行有人工裁决（ack）的行\n` : "") +
      "\n行级改动不进块撤销栈，会写一份回滚文件到项目的 backups/ 目录。"
  );
  if (!ok) {
    setCleanupStatus("cleanup-lines-status", "未写入。");
    return;
  }
  setCleanupStatus("cleanup-lines-status", "正在写入行文本与 diff…");
  try {
    const result = await apiJson(base, { method: "POST" });
    const s = result.stats || {};
    setCleanupStatus(
      "cleanup-lines-status",
      `已改 ${result.changed || 0} 行；format_only ${s.before?.format_only_differs || 0} → ` +
        `${s.after?.format_only_differs || 0}，differs ${s.before?.differs || 0} → ` +
        `${s.after?.differs || 0}` +
        (result.revert_file ? `；回滚文件 backups/${result.revert_file.split("/").pop()}` : "")
    );
    await afterCleanupApplied();
  } catch (error) {
    setCleanupStatus("cleanup-lines-status", `写入失败：${error.message}`, true);
  }
}

/** 引号不配平清单：只读，逐条跳到审校页自己判断。 */
async function openOrthographyPanel() {
  if (!currentProject) return;
  const list = el("orthography-list");
  list.innerHTML = "<li class=\"muted\">正在扫描引号…</li>";
  openModal("orthography-panel");
  el("orthography-meta").textContent = "";
  el("orthography-footnote").textContent = "";
  let data;
  try {
    data = await apiJson(
      `/api/projects/${currentProject.project_id}/cleanup/orthography/unbalanced`
    );
  } catch (error) {
    list.innerHTML = "";
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = `扫描失败：${error.message}`;
    list.append(item);
    return;
  }
  const entries = (data.entries || []).slice().sort(
    (a, b) => Number(Boolean(b.suspect)) - Number(Boolean(a.suspect))
  );
  const suspects = entries.filter((entry) => entry.suspect).length;
  list.innerHTML = "";
  el("orthography-meta").textContent =
    `${entries.length} 处 · ${data.pages || 0} 页` +
    (suspects ? ` · 其中 ${suspects} 处是自动修引号可能改错的，优先看` : "");
  el("orthography-footnote").textContent = entries.length
    ? "不硬配：这些位置只提示，改不改由人判断"
    : "没有配不平的引号。";
  if (!entries.length) {
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = "没有配不平的引号。";
    list.append(item);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const row = document.createElement("li");
    row.className = "orthography-row";
    const where = document.createElement("span");
    where.className = "orthography-row__page";
    where.textContent = `第 ${entry.page_no} 页`;
    const kind = document.createElement("span");
    kind.className = `orthography-row__kind orthography-row__kind--${entry.kind}`;
    kind.textContent = entry.kind === "open" ? "缺闭合" : "缺开号";
    if (entry.suspect) {
      row.classList.add("orthography-row--suspect");
      const badge = document.createElement("span");
      badge.className = "orthography-row__suspect";
      badge.textContent = "自动修可能改错";
      kind.after(badge);
    }
    const snippet = document.createElement("span");
    snippet.className = "orthography-row__text";
    snippet.textContent = entry.snippet;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn btn--sm";
    open.textContent = "看原文";
    open.addEventListener("click", () => {
      closeModal("orthography-panel");
      showView("review");
      openPageDetail(entry.page_no);
    });
    row.append(where, kind, snippet, open);
    fragment.append(row);
  }
  list.append(fragment);
}

/** 批量写完：刷新收尾状态 / 页面状态，丢掉预览与建议缓存（数据变了）。 */
async function afterCleanupApplied() {
  previewData = null;
  previewProject = null;
  forgetAllPageSuggestions();
  await refreshPageStates();
  await loadFinishSummary({ silent: true });
  if (detailPageNo !== null) {
    await loadPageDetail(detailPageNo, { forceSuggestions: true });
  }
  if (currentView === "preview") {
    await loadPreview(exportOptions(), JSON.stringify(exportOptions()));
  }
}

async function undoLastCleanup() {
  if (!currentProject) return;
  if (!window.confirm("撤销上一次批量操作？（延续标记或家具块类型会恢复原样）")) return;
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/undo`, {
      method: "POST",
    });
    const note = el("cleanup-undo-note");
    if (note) {
      note.textContent = `已撤销：${data.changed_blocks || 0} 块`;
      note.hidden = false;
    }
    await afterCleanupApplied();
  } catch (error) {
    const note = el("cleanup-undo-note");
    if (note) {
      note.textContent = error.message || "没有可撤销的操作";
      note.hidden = false;
    }
  }
}

// ---------------------------------------------------------------- 跨页延续（任务 43 G 刀）
//
// 一条页边界 = 一条判断：左边上下两页原图（打开就停在交界处，两行加淡蓝框），
// 右边只有依据和三个动作。键盘 1 / 2 / Z / ↑ / ↓，判完自动跳下一条。
// 没确认完之前，正文审校不算完成（后端 finish-summary.review.complete 带这条）。

let continuationState = null;
let continuationZoom = 1;

async function openContinuationReview() {
  if (!currentProject || currentProject.kind === "package") return;
  openModal("continuation-panel");
  await loadContinuationReview();
}

async function loadContinuationReview() {
  const error = el("continuation-error");
  error.hidden = true;
  let data;
  try {
    data = await apiJson(
      `/api/projects/${currentProject.project_id}/cleanup/continuations/pending`
    );
  } catch (failure) {
    showError(error, failure);
    return;
  }
  continuationState = {
    total: Number(data.count || (data.entries || []).length),
    all: (data.entries || []).map((entry) => ({ ...entry, decision: null })),
    index: 0,
    history: [],
    saving: false,
    pendingDecisions: [],
  };
  continuationZoom = 1;
  renderContinuationPanel({ scroll: true });
}

function continuationCurrent() {
  const state = continuationState;
  if (!state || !state.all.length) return null;
  return state.all[state.index] || state.all[0] || null;
}

function continuationRemaining() {
  const state = continuationState;
  if (!state) return 0;
  return state.all.filter((entry) => entry.decision === null).length;
}

/** 左：上页（末行框）→ 分界线 → 下页（首行框）。 */
function continuationPageBlock(pageNo, bbox, tagText) {
  const page = currentProject.pages.find((item) => item.page_no === pageNo);
  const wrap = document.createElement("div");
  wrap.className = "continuation-page";
  if (page) wrap.style.aspectRatio = `${page.width_pt} / ${page.height_pt}`;
  const image = document.createElement("img");
  image.alt = `第 ${pageNo} 页`;
  image.src = pageImageUrl(pageNo, detailImageProfile(wrap.clientWidth || 600, page.width_pt));
  wrap.append(image);
  if (Array.isArray(bbox) && bbox.length === 4) {
    const mark = document.createElement("div");
    mark.className = "continuation-line";
    mark.title = `第 ${pageNo} 页${tagText}`;
    mark.style.left = `${bbox[0] * 100}%`;
    mark.style.top = `${bbox[1] * 100}%`;
    mark.style.width = `${(bbox[2] - bbox[0]) * 100}%`;
    mark.style.height = `${(bbox[3] - bbox[1]) * 100}%`;
    const tag = document.createElement("span");
    tag.className = "continuation-line__tag";
    tag.textContent = tagText;
    mark.append(tag);
    wrap.append(mark);
  }
  return wrap;
}

function buildContinuationPages(entry) {
  const pages = el("continuation-pages");
  pages.innerHTML = "";
  pages.append(continuationPageBlock(entry.page_no, entry.last_bbox, "末行"));
  const divider = document.createElement("div");
  divider.className = "continuation-divider";
  divider.textContent = `第 ${entry.page_no} 页 / 第 ${entry.next_page_no} 页`;
  pages.append(divider);
  pages.append(continuationPageBlock(entry.next_page_no, entry.next_bbox, "首行"));
  applyContinuationZoom(entry);
}

function applyContinuationZoom(entry = continuationCurrent()) {
  const pages = el("continuation-pages");
  if (!pages) return;
  pages.style.width = `${Math.round(continuationZoom * 100)}%`;
  el("continuation-zoom-label").textContent =
    continuationZoom === 1 ? "" : `${Math.round(continuationZoom * 100)}%`;
  centerContinuationJunction(true);
  if (entry) prefetchContinuationPages(entry);
}

/** 打开 / 翻条 / 缩放后都停在交界处：上页滚到底、下页滚到顶。 */
function centerContinuationJunction(immediate = false) {
  const scroll = el("continuation-scroll");
  if (!scroll) return;
  const apply = () => {
    const pages = el("continuation-pages");
    const marks = pages ? [...pages.querySelectorAll(".continuation-line")] : [];
    const scrollRect = scroll.getBoundingClientRect();
    if (marks.length === 2) {
      // 让"末行底边 → 首行顶边"这段落在视口中央：两行都看得见。
      const first = marks[0].getBoundingClientRect();
      const second = marks[1].getBoundingClientRect();
      const span = second.top - first.bottom;
      if (span < scrollRect.height - 12) {
        const middle = (first.bottom + second.top) / 2;
        scroll.scrollTop += middle - (scrollRect.top + scrollRect.height / 2);
        scroll.scrollLeft = 0;
        return;
      }
    }
    const divider = pages
      ? pages.querySelector(".continuation-divider")
      : null;
    if (divider) {
      scroll.scrollTop = Math.max(
        0,
        divider.offsetTop - scroll.clientHeight / 2 + divider.offsetHeight / 2
      );
      scroll.scrollLeft = 0;
    }
  };
  apply();
  if (!immediate) requestAnimationFrame(apply);
}

function prefetchContinuationPages(entry) {
  if (!entry) return;
  // 下一张卡片的两页先拉进缓存，翻条不用等
  for (const pageNo of [entry.page_no, entry.next_page_no]) {
    const image = new Image();
    image.src = pageImageUrl(pageNo, detailImageProfile(600, pageWidthPt(pageNo)));
  }
}

function continuationEvidenceRow(label, text, sub) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  const main = document.createElement("span");
  main.textContent = text || "—";
  dd.append(main);
  if (sub) {
    const small = document.createElement("span");
    small.className = "muted";
    small.textContent = sub;
    dd.append(small);
  }
  return [dt, dd];
}

function renderContinuationPanel({ scroll = false } = {}) {
  const state = continuationState;
  if (!state) return;
  const entry = continuationCurrent();
  const remaining = continuationRemaining();
  const complete = remaining === 0;
  el("continuation-complete").hidden = !complete;
  if (complete) {
    el("continuation-complete").querySelector("strong").textContent =
      `${state.total} 条全部确认`;
  }
  el("continuation-meta").textContent = complete
    ? "已全部确认"
    : `已确认 ${state.total - remaining} / ${state.total}`;
  el("continuation-footnote").textContent = complete
    ? "正文审校的「跨页延续」闸门已放行"
    : `还剩 ${remaining} 条 · ↑ / ↓ 翻条 · 1 / 2 判`;

  if (!entry) {
    el("continuation-progress").textContent = "没有待确认的页边界";
    el("continuation-state").textContent = "";
    el("continuation-evidence").innerHTML = "";
    el("continuation-pages").innerHTML = "";
    return;
  }

  el("continuation-progress").textContent =
    `第 ${state.index + 1} / ${state.all.length} 条`;
  const decided = entry.decision !== null;
  el("continuation-state").textContent = decided
    ? entry.decision
      ? "已标延续"
      : "已标结束"
    : `第 ${entry.page_no} → ${entry.next_page_no} 页`;
  el("continuation-continue").disabled = decided || Boolean(state.saving);
  el("continuation-end").disabled = decided || Boolean(state.saving);
  el("continuation-revert").disabled = state.history.length === 0 && !decided;

  const evidence = el("continuation-evidence");
  evidence.innerHTML = "";
  // 用户 2026-10-27：面板上只留两行原文——上页末行、下页首行。
  // 机器判定的那两个依据用户不需要看，已删掉。
  evidence.append(
    ...continuationEvidenceRow("上页末行", `…${entry.last_text}`, `第 ${entry.page_no} 页最后一行`),
    ...continuationEvidenceRow("下页首行", entry.next_text, `第 ${entry.next_page_no} 页第一行`)
  );
  buildContinuationPages(entry);
  if (scroll) centerContinuationJunction();
}

/** 判完自动跳下一条还没判的；都判完就停在最后一条。 */
function advanceContinuation() {
  const state = continuationState;
  if (!state) return;
  for (let step = 1; step <= state.all.length; step += 1) {
    const index = (state.index + step) % state.all.length;
    if (state.all[index].decision === null) {
      state.index = index;
      return;
    }
  }
  state.index = Math.min(state.index, state.all.length - 1);
}

async function markContinuation(continues) {
  const state = continuationState;
  const entry = continuationCurrent();
  if (!state || !entry) return;
  // 键盘连按时上一笔还在写库：记下最后一下，等请求回来再判下一条，
  // 否则同一处会被重复提交、后面的按键被吞掉。
  if (state.saving) {
    // 队列而不是"只记最后一下"：连按 16 下就排 16 个决定，一下都不丢
    state.pendingDecisions.push(Boolean(continues));
    return;
  }
  if (entry.decision !== null) return;
  state.saving = true;
  const error = el("continuation-error");
  error.hidden = true;
  try {
    const result = await apiJson(
      `/api/projects/${currentProject.project_id}/cleanup/continuations/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block_id: entry.block_id, continues }),
      }
    );
    entry.decision = Boolean(continues);
    entry.continues_to_next = Boolean(result.continues_to_next);
    state.history.push(entry.block_id);
    advanceContinuation();
    renderContinuationPanel({ scroll: true });
    afterContinuationChange(entry.page_no);
  } catch (failure) {
    showError(error, failure);
  } finally {
    state.saving = false;
    const next = state.pendingDecisions.shift();
    if (next !== undefined && continuationRemaining() > 0) {
      markContinuation(next);
    }
  }
}

async function revertContinuation() {
  const state = continuationState;
  if (!state) return;
  state.pendingDecisions.length = 0;
  const current = continuationCurrent();
  const blockId =
    current && current.decision !== null
      ? current.block_id
      : state.history[state.history.length - 1];
  if (!blockId) return;
  const entry = state.all.find((item) => item.block_id === blockId);
  if (!entry) return;
  const error = el("continuation-error");
  error.hidden = true;
  try {
    const result = await apiJson(
      `/api/projects/${currentProject.project_id}/cleanup/continuations/reopen`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block_id: blockId }),
      }
    );
    entry.decision = null;
    entry.continues_to_next = Boolean(result.continues_to_next);
    state.history = state.history.filter((id) => id !== blockId);
    if (result.bucket !== "review") {
      // 放回后自动判定已经能定了：从这一轮里移走
      const index = state.all.indexOf(entry);
      state.all = state.all.filter((item) => item.block_id !== blockId);
      state.total = Math.max(0, state.total - 1);
      state.index = Math.min(index, Math.max(0, state.all.length - 1));
    } else {
      state.index = state.all.indexOf(entry);
    }
    renderContinuationPanel({ scroll: true });
    afterContinuationChange(entry.page_no);
  } catch (failure) {
    showError(error, failure);
  }
}

function stepContinuation(delta) {
  const state = continuationState;
  if (!state || !state.all.length) return;
  state.index = Math.min(
    Math.max(0, state.index + delta),
    state.all.length - 1
  );
  renderContinuationPanel({ scroll: true });
}

/** 改过跨页边界：导出的段落结构变了，刷新收尾状态与预览缓存（后台，不挡翻条）。 */
function afterContinuationChange() {
  previewData = null;
  previewProject = null;
  loadFinishSummary({ silent: true });
}

const CONTINUATION_ZOOMS = [1, 1.25, 1.5, 2];

function stepContinuationZoom(delta) {
  const index = CONTINUATION_ZOOMS.indexOf(continuationZoom);
  const next =
    index < 0
      ? 0
      : Math.min(Math.max(index + delta, 0), CONTINUATION_ZOOMS.length - 1);
  continuationZoom = CONTINUATION_ZOOMS[next];
  applyContinuationZoom();
}

function resetContinuationZoom() {
  continuationZoom = 1;
  applyContinuationZoom();
}

/** 键盘优先：面板开着时 1 / 2 / Z / ↑ / ↓ 接管。 */
function onContinuationKeydown(event) {
  const panel = el("continuation-panel");
  if (!panel || panel.hidden) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key;
  if (key === "1") {
    event.preventDefault();
    event.stopImmediatePropagation();
    markContinuation(true);
  } else if (key === "2") {
    event.preventDefault();
    event.stopImmediatePropagation();
    markContinuation(false);
  } else if (key === "z" || key === "Z") {
    event.preventDefault();
    event.stopImmediatePropagation();
    revertContinuation();
  } else if (key === "ArrowDown") {
    event.preventDefault();
    event.stopImmediatePropagation();
    stepContinuation(1);
  } else if (key === "ArrowUp") {
    event.preventDefault();
    event.stopImmediatePropagation();
    stepContinuation(-1);
  }
}

// ---------------------------------------------------------------- 审校左栏目录树（任务 45 / H 刀）
//
// 一棵树：回目 → 页 → 条目。页行只显示"几处"（无差异页只留页码），条目懒加载。
// 数据来自 GET /review/tree（每页 unacked/acked）；条目明细仍走 pages/{n}/blocks。
// 每次裁决只改本行与页行计数，不重建整棵树——按键手感不能退。

let reviewTree = null;
let reviewTreeProjectId = null;
let reviewTreeLoading = false;
let reviewTreeOnlyTodo = false;
let reviewTreeExpandedChapters = new Set();
let reviewTreeExpandedPage = null;
let reviewTreeItems = new Map(); // pageNo -> [item]
let reviewTreePageRows = new Map(); // pageNo -> {row, count, state, page}
let reviewTreeChapterRows = new Map(); // chapterId -> {count, li}
let reviewTreeItemRows = new Map(); // `${blockId}:${lineIndex}` -> {row, dot, item}
const TREE_DIFF_LEVELS = new Set(["differs_chars", "differs_punct", "no_candidate"]);

async function ensureReviewTree() {
  if (!currentProject) return;
  if (reviewTree && reviewTreeProjectId === currentProject.project_id) {
    syncReviewTreeToPage(detailPageNo, { scroll: false });
    return;
  }
  if (reviewTreeLoading) return;
  reviewTreeLoading = true;
  const t0 = performance.now();
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/review/tree`
    );
    reviewTree = data;
    reviewTreeProjectId = currentProject.project_id;
    reviewTreeItems.clear();
    reviewTreePageRows.clear();
    reviewTreeChapterRows.clear();
    reviewTreeItemRows.clear();
    reviewTreeExpandedChapters.clear();
    reviewTreeExpandedPage = null;
    const fetchMs = performance.now() - t0;
    const b0 = performance.now();
    renderReviewTree();
    window.__b2tTreeMetrics = {
      fetchMs: Math.round(fetchMs),
      buildMs: Math.round(performance.now() - b0),
      pages: (data.pages || []).length,
      chapters: (data.chapters || []).length,
    };
  } catch (error) {
    showError(el("page-detail-error"), error);
  } finally {
    reviewTreeLoading = false;
  }
}

function treeItemsFromBlocks(blocks) {
  const items = [];
  (blocks || []).forEach((block, blockIndex) => {
    const divergence = divergenceOf(block);
    if (divergence.stale) return;
    if (!blockCountedInMargin(block, null)) return;
    for (const mark of divergence.marks || []) {
      if (!TREE_DIFF_LEVELS.has(mark.level)) continue;
      const line = (block.lines || [])[mark.line_index];
      items.push({
        blockId: block.block_id,
        blockIndex,
        lineIndex: mark.line_index,
        level: mark.level,
        ack: mark.ack || null,
        current: String(mark.current || ""),
        candidate: String(mark.candidate || ""),
        lineText: String((line && line.text) || mark.current || ""),
      });
    }
  });
  return items;
}

async function loadReviewTreeItems(pageNo) {
  if (reviewTreeItems.has(pageNo)) return;
  // 当前页正在打开时 reviewBlocks 可能还是上一页的：只认块自己也属于这一页的数据
  const blocks = reviewBlocks || [];
  if (
    pageNo === detailPageNo &&
    blocks.length &&
    blocks.every((block) => block.page_no === pageNo)
  ) {
    reviewTreeItems.set(pageNo, treeItemsFromBlocks(blocks));
    return;
  }
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/pages/${pageNo}/blocks`
    );
    reviewTreeItems.set(pageNo, treeItemsFromBlocks(data.blocks));
  } catch {
    reviewTreeItems.set(pageNo, []);
  }
}

/** 条目摘要：只取差异片段两侧各 3 字（文本层面，不碰坐标）。 */
function treeItemSummary(item) {
  const a = String(item.current || "");
  const b = String(item.candidate || "");
  const spans = computeCharSpans(a, b).filter(
    (span) => span.aEnd > span.aStart || span.bEnd > span.bStart
  );
  if (!spans.length) return truncate(item.lineText || a, 22);
  const span = spans[0];
  const prefix = a.slice(Math.max(0, span.aStart - 3), span.aStart);
  const suffix = a.slice(span.aEnd, span.aEnd + 3);
  const left = a.slice(span.aStart, span.aEnd) || "∅";
  const right = b.slice(span.bStart, span.bEnd) || "∅";
  return `${span.aStart > 3 ? "…" : ""}${prefix}${left}→${right}${suffix}${
    span.aEnd < a.length - 3 ? "…" : ""
  }`;
}

function treeLevelLabel(level) {
  if (level === "differs_chars") return "汉";
  if (level === "differs_punct") return "标";
  return "?";
}

function treeChapterOfPage(pageNo) {
  const page = (reviewTree?.pages || []).find((item) => item.page_no === pageNo);
  return page ? page.chapter : null;
}

function renderReviewTree() {
  const list = el("review-tree-list");
  if (!list || !reviewTree) return;
  list.innerHTML = "";
  reviewTreePageRows.clear();
  reviewTreeChapterRows.clear();
  reviewTreeItemRows.clear();
  const pages = reviewTree.pages || [];
  const chapters = reviewTree.chapters || [];
  const byNo = new Map(pages.map((page) => [page.page_no, page]));
  const currentNo = detailPageNo;
  const currentChapter = currentNo ? treeChapterOfPage(currentNo) : null;
  if (currentChapter && !reviewTreeOnlyTodo) {
    // 默认只展开当前回目；翻页时旧回目自动折叠
    if (!reviewTreeExpandedChapters.has(currentChapter)) {
      reviewTreeExpandedChapters.clear();
      reviewTreeExpandedChapters.add(currentChapter);
    }
  }
  const totalUnacked = pages.reduce((sum, page) => sum + page.unacked, 0);
  el("review-tree-stats").textContent = `${totalUnacked} 处待审`;

  const appendPage = (page, parent) => {
    const li = document.createElement("li");
    li.className = "review-tree__page";
    const row = document.createElement("div");
    row.className = "review-tree__row review-tree__row--page";
    if (page.page_no === currentNo) row.classList.add("is-current");
    row.title = `第 ${page.page_no} 页 · ${page.unacked} 处待审`;
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "review-tree__caret";
    caret.textContent = reviewTreeExpandedPage === page.page_no ? "▾" : "▸";
    if (page.unacked + page.acked === 0) caret.classList.add("is-empty");
    caret.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleReviewTreePage(page.page_no);
    });
    const pageNo = document.createElement("span");
    pageNo.className = "tree-page-no";
    pageNo.textContent = `第 ${page.page_no} 页`;
    const state = document.createElement("span");
    state.className = "tree-state";
    const count = document.createElement("span");
    count.className = "tree-count";
    if (page.unacked > 0) {
      count.textContent = `${page.unacked} 处`;
    } else if (page.acked > 0) {
      count.textContent = "✓";
      count.classList.add("is-done");
    }
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    row.append(caret, pageNo, spacer, state, count);
    row.addEventListener("click", () => {
      openPageDetail(page.page_no);
    });
    li.append(row);
    reviewTreePageRows.set(page.page_no, { row, count, state, page });

    if (reviewTreeExpandedPage === page.page_no) {
      const cached = reviewTreeItems.get(page.page_no);
      if (!cached) {
        const loading = document.createElement("div");
        loading.className = "review-tree__empty";
        loading.textContent = "正在加载条目…";
        li.append(loading);
        loadReviewTreeItems(page.page_no).then(() => {
          if (reviewTreeExpandedPage === page.page_no) renderReviewTree();
        });
        return li;
      }
      const itemsOl = document.createElement("ol");
      itemsOl.className = "review-tree__items";
      for (const item of cached) {
        const itemLi = document.createElement("li");
        const itemRow = document.createElement("div");
        itemRow.className = "review-tree__row review-tree__row--item";
        if (
          activeDiff &&
          activeDiff.blockId === item.blockId &&
          activeDiff.lineIndex === item.lineIndex
        ) {
          itemRow.classList.add("is-current");
        }
        if (item.ack) itemRow.classList.add("is-done");
        const dot = document.createElement("span");
        dot.className = "tree-dot";
        if (item.ack) dot.classList.add("is-done");
        if (
          activeDiff &&
          activeDiff.blockId === item.blockId &&
          activeDiff.lineIndex === item.lineIndex
        ) {
          dot.classList.add("is-current");
        }
        const lineNo = document.createElement("span");
        lineNo.className = "tree-line";
        lineNo.textContent = `L${item.lineIndex + 1}`;
        const level = document.createElement("span");
        level.className = "tree-level";
        level.textContent = treeLevelLabel(item.level);
        const summary = document.createElement("span");
        summary.className = "tree-summary";
        summary.textContent = treeItemSummary(item);
        if (item.ack === "kept") summary.textContent += " ✓已保留";
        itemRow.append(dot, lineNo, level, summary);
        itemRow.title = `${item.lineText}\n原：${item.current}\n候选：${item.candidate}`;
        itemRow.addEventListener("click", () => openTreeItem(page.page_no, item));
        itemLi.append(itemRow);
        itemsOl.append(itemLi);
        reviewTreeItemRows.set(`${item.blockId}:${item.lineIndex}`, {
          row: itemRow,
          dot,
          item,
          pageNo: page.page_no,
        });
      }
      if (!cached.length) {
        const empty = document.createElement("div");
        empty.className = "review-tree__empty";
        empty.textContent = "这一页没有可处理的差异";
        itemsOl.append(empty);
      }
      li.append(itemsOl);
    }
    return li;
  };

  if (reviewTreeOnlyTodo) {
    const todo = pages.filter((page) => page.unacked > 0);
    if (!todo.length) {
      const empty = document.createElement("li");
      empty.className = "review-tree__empty";
      empty.textContent = "全部页都没有待处理的差异了。";
      list.append(empty);
    }
    for (const page of todo) list.append(appendPage(page, list));
  } else if (!chapters.length) {
    for (const page of pages) list.append(appendPage(page, list));
  } else {
    for (const chapter of chapters) {
      const chapterPages = pages.filter((page) => page.chapter === chapter.id);
      if (!chapterPages.length) continue;
      const remaining = chapterPages.reduce((sum, page) => sum + page.unacked, 0);
      const li = document.createElement("li");
      li.className = "review-tree__chapter";
      const row = document.createElement("div");
      row.className = "review-tree__row review-tree__row--chapter";
      const caret = document.createElement("span");
      caret.className = "caret";
      caret.textContent = reviewTreeExpandedChapters.has(chapter.id) ? "▾" : "▸";
      const title = document.createElement("span");
      title.className = "tree-title";
      title.textContent = chapter.title;
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      const count = document.createElement("span");
      count.className = "tree-count";
      if (remaining > 0) {
        count.textContent = `${remaining} 处`;
      } else {
        count.textContent = "✓ 完成";
        count.classList.add("is-done");
      }
      row.append(caret, title, spacer, count);
      row.addEventListener("click", () => toggleReviewTreeChapter(chapter.id));
      li.append(row);
      if (reviewTreeExpandedChapters.has(chapter.id)) {
        for (const page of chapterPages) li.append(appendPage(page, li));
      }
      list.append(li);
      reviewTreeChapterRows.set(chapter.id, { count, li, chapter });
    }
  }
  syncReviewTreeToPage(currentNo, { scroll: true });
}

function toggleReviewTreeChapter(chapterId) {
  if (reviewTreeExpandedChapters.has(chapterId)) {
    reviewTreeExpandedChapters.delete(chapterId);
  } else {
    reviewTreeExpandedChapters.clear();
    reviewTreeExpandedChapters.add(chapterId);
  }
  renderReviewTree();
}

function toggleReviewTreePage(pageNo) {
  if (reviewTreeExpandedPage === pageNo) {
    reviewTreeExpandedPage = null;
  } else {
    reviewTreeExpandedPage = pageNo;
  }
  renderReviewTree();
}

function setReviewTreeOnlyTodo(only) {
  reviewTreeOnlyTodo = Boolean(only);
  el("review-tree-filter").textContent = reviewTreeOnlyTodo
    ? "显示全部页"
    : "只看未完成";
  el("review-tree-filter").classList.toggle("is-on", reviewTreeOnlyTodo);
  renderReviewTree();
}

/** 当前页 / 当前条目在树里定位：展开 + 高亮 + 滚到约 40%。 */
function syncReviewTreeToPage(pageNo, { scroll = false } = {}) {
  if (!reviewTree || !pageNo) return;
  const chapter = treeChapterOfPage(pageNo);
  if (chapter && !reviewTreeExpandedChapters.has(chapter) && !reviewTreeOnlyTodo) {
    reviewTreeExpandedChapters.clear();
    reviewTreeExpandedChapters.add(chapter);
    renderReviewTree();
    return;
  }
  if (reviewTreeExpandedPage !== pageNo && !reviewTreeOnlyTodo) {
    reviewTreeExpandedPage = pageNo;
    renderReviewTree();
    return;
  }
  const pageRow = reviewTreePageRows.get(pageNo);
  for (const [, entry] of reviewTreePageRows) {
    entry.row.classList.toggle("is-current", entry.page.page_no === pageNo);
  }
  const activeKey = activeDiff ? `${activeDiff.blockId}:${activeDiff.lineIndex}` : null;
  const activeRow = activeKey ? reviewTreeItemRows.get(activeKey) : null;
  const firstUnacked = [...reviewTreeItemRows.values()].find(
    (entry) => entry.pageNo === pageNo && !entry.item.ack
  );
  const target = activeRow || firstUnacked;
  for (const [, entry] of reviewTreeItemRows) {
    const isCurrent =
      activeDiff &&
      entry.item.blockId === activeDiff.blockId &&
      entry.item.lineIndex === activeDiff.lineIndex;
    entry.row.classList.toggle("is-current", Boolean(isCurrent));
    entry.dot.classList.toggle("is-current", Boolean(isCurrent));
  }
  if (scroll) {
    const scroller = el("review-tree-scroll");
    const anchor = target ? target.row : pageRow ? pageRow.row : null;
    if (scroller && anchor) {
      const top = anchor.offsetTop - scroller.clientHeight * 0.4;
      scroller.scrollTop = Math.max(0, top);
    }
  }
}

function updateReviewTreeAfterAck(block, item, ack) {
  if (!reviewTree) return;
  const key = `${block.block_id}:${item.lineIndex}`;
  const pageRow = reviewTreePageRows.get(block.page_no);
  const pageData = (reviewTree.pages || []).find((page) => page.page_no === block.page_no);
  if (pageData && pageData.unacked > 0) pageData.unacked -= 1;
  if (pageData) pageData.acked += 1;
  if (pageRow && pageData) {
    if (pageData.unacked > 0) {
      pageRow.count.textContent = `${pageData.unacked} 处`;
      pageRow.count.classList.remove("is-done");
    } else {
      pageRow.count.textContent = "✓";
      pageRow.count.classList.add("is-done");
    }
    pageRow.row.title = `第 ${pageData.page_no} 页 · ${pageData.unacked} 处待审`;
  }
  const chapterEntry = pageData ? reviewTreeChapterRows.get(pageData.chapter) : null;
  if (chapterEntry) {
    const remaining = (reviewTree.pages || [])
      .filter((page) => page.chapter === pageData.chapter)
      .reduce((sum, page) => sum + page.unacked, 0);
    if (remaining > 0) {
      chapterEntry.count.textContent = `${remaining} 处`;
      chapterEntry.count.classList.remove("is-done");
    } else {
      chapterEntry.count.textContent = "✓ 完成";
      chapterEntry.count.classList.add("is-done");
    }
  }
  const entry = reviewTreeItemRows.get(key);
  if (entry) {
    entry.item.ack = ack;
    if (ack === "adopted") {
      entry.row.remove();
      reviewTreeItemRows.delete(key);
      const cached = reviewTreeItems.get(block.page_no) || [];
      reviewTreeItems.set(
        block.page_no,
        cached.filter(
          (cachedItem) =>
            !(cachedItem.blockId === block.block_id && cachedItem.lineIndex === item.lineIndex)
        )
      );
    } else {
      entry.row.classList.add("is-done");
      entry.dot.classList.add("is-done");
      const summary = entry.row.querySelector(".tree-summary");
      if (summary && !summary.textContent.includes("✓已保留")) {
        summary.textContent += " ✓已保留";
      }
    }
  }
  if (reviewTreeOnlyTodo && pageData && pageData.unacked === 0) {
    renderReviewTree();
  }
}

async function openTreeItem(pageNo, item) {
  if (detailPageNo !== pageNo) {
    await openPageDetail(pageNo);
  }
  const index = diffQueue.findIndex(
    (entry) => entry.blockId === item.blockId && entry.lineIndex === item.lineIndex
  );
  if (index >= 0) {
    queueIndex = index;
    if (!queueOpen) {
      queueOpen = true;
      renderDiffQueue();
    }
    focusQueueItem(diffQueue[index], { scroll: true });
    renderDiffQueue();
  } else {
    activateDiff(item.blockId, item.lineIndex, 0);
  }
  syncReviewTreeToPage(pageNo, { scroll: true });
}

/** `[` / `]`：上一处 / 下一处差异（跨块，不跨页）。 */
function stepReviewDiff(delta) {
  if (!diffQueue.length) return;
  if (!queueOpen) {
    queueOpen = true;
    renderDiffQueue();
  }
  let index = queueIndex;
  if (delta > 0) {
    index = nextPendingQueueIndex(queueIndex);
    if (index < 0) return;
  } else {
    for (let i = queueIndex - 1; i >= 0; i -= 1) {
      if (!queueDecisions.has(diffQueue[i].key)) {
        index = i;
        break;
      }
    }
    if (index === queueIndex) return;
  }
  queueIndex = index;
  focusQueueItem(diffQueue[queueIndex], { scroll: true });
  renderDiffQueue();
  syncReviewTreeToPage(detailPageNo, { scroll: true });
}

function openFinishPanel() {
  if (!currentProject || currentProject.kind === "package") return;
  const drawer = el("finish-drawer");
  drawer.hidden = false;
  if (!finishSummary || finishSummaryProject !== currentProject.project_id) {
    el("finish-project-name").textContent = currentProject.name || "";
  } else {
    renderFinishPanel();
  }
  loadFinishSummary();
}

function closeFinishPanel() {
  const drawer = el("finish-drawer");
  if (drawer) drawer.hidden = true;
}

async function finishConfirmPages() {
  await confirmAllUnconfirmed();
  await loadFinishSummary({ silent: true });
}

function finishShowFallbackPages() {
  if (!finishSummary) return;
  const pages = [
    ...(finishSummary.margin.fallback_pages || []),
    ...(finishSummary.margin.undetermined_pages || []),
  ];
  if (!pages.length) return;
  selectedPages.clear();
  for (const no of pages) selectedPages.add(no);
  selectionAnchor = pages[0];
  closeFinishPanel();
  showView("pages");
  renderPages();
}

async function finishRunLayout() {
  if (!finishSummary || finishLayoutRunning) return;
  const pages = finishLayoutRemaining.length
    ? finishLayoutRemaining
    : (finishSummary.layout.pending_pages || []);
  if (!pages.length) return;
  const resumingLayout = finishLayoutRemaining.length > 0;
  finishLayoutRunning = true;
  finishLayoutStop = false;
  if (!resumingLayout) {
    finishLayoutBase = finishSummary.layout.confirmed;
    finishLayoutTotalAll = finishSummary.layout.total;
  }
  el("finish-layout-progress").hidden = false;
  el("finish-layout-resume").hidden = true;
  el("finish-layout-stop").hidden = false;
  el("finish-confirm-layout").disabled = true;
  const bar = el("finish-layout-bar");
  bar.max = pages.length;
  bar.value = 0;
  const text = el("finish-layout-progress-text");
  let done = 0;
  for (let index = 0; index < pages.length; index += 25) {
    if (finishLayoutStop) break;
    const chunk = pages.slice(index, index + 25);
    text.textContent =
      `正在确认版面… ${finishLayoutBase + done} / ${finishLayoutTotalAll} 页`;
    try {
      await apiJson(
        `/api/projects/${currentProject.project_id}/pages/${chunk[0]}/layout/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page_numbers: chunk }),
        }
      );
    } catch (error) {
      text.textContent = error.message || "确认版面失败";
      finishLayoutRunning = false;
      el("finish-layout-stop").hidden = true;
      el("finish-layout-resume").hidden = false;
      return;
    }
    done += chunk.length;
    bar.value = done;
    text.textContent =
      `正在确认版面… ${finishLayoutBase + done} / ${finishLayoutTotalAll} 页`;
    finishLayoutRemaining = pages.slice(done);
    finishSummary.layout.confirmed = finishLayoutBase + done;
    finishSummary.layout.remaining = finishLayoutRemaining.length;
    finishSummary.layout.pending_pages = [...finishLayoutRemaining];
    el("finish-layout-status").textContent =
      `${finishSummary.layout.confirmed} / ${finishSummary.layout.total} 已确认`;
    el("finish-layout-sub").textContent = finishLayoutRemaining.length
      ? `还差 ${finishLayoutRemaining.length} 页正文版面`
      : "所有正文页版面已确认";
  }
  finishLayoutRunning = false;
  el("finish-layout-stop").hidden = true;
  if (finishLayoutRemaining.length) {
    finishLayoutBase += done;
    el("finish-layout-resume").hidden = false;
    text.textContent =
      `已停止：本次确认 ${done} 页，还剩 ${finishLayoutRemaining.length} 页；已确认的不会回退。`;
  } else {
    text.textContent =
      `已确认剩余 ${done} 页版面；全书 ${finishLayoutTotalAll} / ${finishLayoutTotalAll} 页已完成，已确认的不会回退。`;
    finishLayoutRemaining = [];
    await loadFinishSummary({ silent: true });
  }
  el("finish-confirm-layout").disabled = false;
  // 任务 43：批量确认改了「版面未确认」这个页头状态。已经打开着的那一页
  // 要重载一次页详情（否则页头一直写着没确认，用户以为没生效）。
  if (detailPageNo !== null && !finishLayoutRemaining.includes(detailPageNo)) {
    await loadPageDetail(detailPageNo, { forceSuggestions: false });
  }
}

async function finishConfirmLayout() {
  if (!finishSummary) return;
  finishLayoutRemaining = [];
  await finishRunLayout();
}

function finishStopLayout() {
  finishLayoutStop = true;
}

async function finishResumeLayout() {
  if (!finishLayoutRemaining.length) return;
  await finishRunLayout();
}

async function finishRunAutoPass() {
  if (!finishSummary || finishAutoRunning) return;
  const pages = finishAutoRemaining.length
    ? finishAutoRemaining
    : (finishSummary.review.auto_passable_pages || []);
  if (!pages.length) return;
  if (!finishAutoRemaining.length) {
    const ok = window.confirm(
      `把 ${pages.length} 页标记为「自动通过（未经人工）」？\n` +
        "只写状态，不改任何块文字；条件不满足的页会被后端跳过。"
    );
    if (!ok) return;
  }
  const resumingAuto = finishAutoRemaining.length > 0;
  finishAutoRunning = true;
  finishAutoStop = false;
  if (!resumingAuto) {
    finishAutoTotalAll = pages.length;
    finishAutoDoneAll = 0;
    finishAutoSkipped = 0;
    finishAutoApplied = [];
  }
  el("finish-auto-progress").hidden = false;
  el("finish-auto-resume").hidden = true;
  el("finish-auto-stop").hidden = false;
  el("finish-auto-revoke").hidden = true;
  el("finish-auto-pass").disabled = true;
  const bar = el("finish-auto-bar");
  bar.max = pages.length;
  bar.value = 0;
  const text = el("finish-auto-progress-text");
  let done = 0;
  for (let index = 0; index < pages.length; index += 10) {
    if (finishAutoStop) break;
    const chunk = pages.slice(index, index + 10);
    text.textContent =
      `正在标记自动通过… ${finishAutoDoneAll + done} / ${finishAutoTotalAll} 页`;
    try {
      const data = await apiJson(
        `/api/projects/${currentProject.project_id}/review/auto-pass`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page_numbers: chunk }),
        }
      );
      const applied = data.applied || [];
      finishAutoApplied.push(...applied);
      finishAutoSkipped += (data.skipped || []).length;
      finishSummary.review.auto_passable = Math.max(
        0,
        finishSummary.review.auto_passable - applied.length
      );
      finishSummary.review.auto_passable_pages =
        finishSummary.review.auto_passable_pages.filter(
          (no) => !applied.includes(no)
        );
      finishSummary.review.confirmed += applied.length;
      renderFinishPanel();
    } catch (error) {
      text.textContent = error.message || "标记自动通过失败";
      finishAutoRunning = false;
      el("finish-auto-stop").hidden = true;
      el("finish-auto-resume").hidden = false;
      return;
    }
    done += chunk.length;
    finishAutoDoneAll += chunk.length;
    bar.value = finishAutoDoneAll;
    text.textContent =
      `正在标记自动通过… ${finishAutoDoneAll} / ${finishAutoTotalAll} 页`;
    finishAutoRemaining = pages.slice(done);
  }
  finishAutoRunning = false;
  el("finish-auto-stop").hidden = true;
  el("finish-auto-revoke").hidden = finishAutoApplied.length === 0;
  if (finishAutoRemaining.length) {
    el("finish-auto-resume").hidden = false;
    text.textContent =
      `已停止：本次标记 ${finishAutoApplied.length} 页，还剩 ${finishAutoRemaining.length} 页。`;
  } else {
    finishAutoRemaining = [];
    text.textContent =
      `已标记 ${finishAutoApplied.length} 页自动通过` +
      (finishAutoSkipped ? `；${finishAutoSkipped} 页条件不满足被跳过` : "") +
      "。只写状态，未改任何块文字。";
    await loadFinishSummary({ silent: true });
    el("finish-auto-revoke").hidden = finishAutoApplied.length === 0;
  }
  el("finish-auto-pass").disabled = false;
}

async function finishStartAutoPass() {
  finishAutoRemaining = [];
  await finishRunAutoPass();
}

function finishStopAutoPass() {
  finishAutoStop = true;
}

async function finishResumeAutoPass() {
  if (!finishAutoRemaining.length) return;
  await finishRunAutoPass();
}

async function finishRevokeAutoPass() {
  if (!finishAutoApplied.length) return;
  const ok = window.confirm(
    `撤销这一批 ${finishAutoApplied.length} 页的自动通过？（只撤「自动通过」，人工确认不动）`
  );
  if (!ok) return;
  try {
    await apiJson(
      `/api/projects/${currentProject.project_id}/review/auto-pass/revoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_numbers: finishAutoApplied }),
      }
    );
    finishAutoApplied = [];
    el("finish-auto-revoke").hidden = true;
    await loadFinishSummary({ silent: true });
  } catch (error) {
    showError(el("pages-error"), error);
  }
}

function finishOpenPageNumbers() {
  closeFinishPanel();
  openPageNumberPanel();
}

function finishStartReview() {
  if (!finishSummary) return;
  const target = finishSummary.review.needs_human_pages[0] || 1;
  closeFinishPanel();
  showView("review");
  openPageDetail(target);
}

function finishOpenExport() {
  closeFinishPanel();
  openExportPanel();
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
  el("layout-confirm").addEventListener("click", confirmPageLayout);
  el("candidate-open").addEventListener("click", openCandidateCompare);
  el("candidate-apply").addEventListener("click", () => decideCandidate("apply"));
  el("candidate-decline").addEventListener("click", () => decideCandidate("decline"));
  el("candidate-close").addEventListener("click", () => {
    el("candidate-panel").hidden = true;
  });
  el("review-undo").addEventListener("click", () => reviewAction("undo"));
  el("review-redo").addEventListener("click", () => reviewAction("redo"));
  for (const id of ["finish-open", "finish-open-review"]) {
    el(id).addEventListener("click", openFinishPanel);
  }
  el("finish-close").addEventListener("click", closeFinishPanel);
  el("finish-refresh").addEventListener("click", () => loadFinishSummary());
  el("finish-confirm-pages").addEventListener("click", finishConfirmPages);
  el("finish-margin-pages").addEventListener("click", finishShowFallbackPages);
  el("finish-confirm-layout").addEventListener("click", finishConfirmLayout);
  el("finish-layout-stop").addEventListener("click", finishStopLayout);
  el("finish-layout-resume").addEventListener("click", finishResumeLayout);
  el("finish-open-pagenum").addEventListener("click", finishOpenPageNumbers);
  el("finish-auto-pass").addEventListener("click", finishStartAutoPass);
  el("finish-auto-stop").addEventListener("click", finishStopAutoPass);
  el("finish-auto-resume").addEventListener("click", finishResumeAutoPass);
  el("finish-auto-revoke").addEventListener("click", finishRevokeAutoPass);
  el("finish-check-engine").addEventListener("click", () => {
    closeFinishPanel();
    checkSelection("unchecked");
  });
  el("cleanup-continuation-run").addEventListener("click", runContinuationCleanup);
  el("cleanup-furniture-run").addEventListener("click", runFurnitureCleanup);
  el("cleanup-orthography-run").addEventListener("click", runOrthographyCleanup);
  el("cleanup-orthography-review").addEventListener("click", openOrthographyPanel);
  el("cleanup-lines-run").addEventListener("click", runLinesCleanup);
  el("orthography-close").addEventListener("click", () => closeModal("orthography-panel"));
  el("orthography-done").addEventListener("click", () => closeModal("orthography-panel"));
  el("cleanup-undo").addEventListener("click", undoLastCleanup);
  el("cleanup-continuation-review-open").addEventListener("click", openContinuationReview);
  el("review-continuations").addEventListener("click", openContinuationReview);
  el("continuation-close").addEventListener("click", () => closeModal("continuation-panel"));
  el("continuation-done").addEventListener("click", () => closeModal("continuation-panel"));
  el("continuation-continue").addEventListener("click", () => markContinuation(true));
  el("continuation-end").addEventListener("click", () => markContinuation(false));
  el("continuation-revert").addEventListener("click", revertContinuation);
  el("continuation-prev").addEventListener("click", () => stepContinuation(-1));
  el("continuation-next").addEventListener("click", () => stepContinuation(1));
  el("continuation-zoom-out").addEventListener("click", () => stepContinuationZoom(-1));
  el("continuation-zoom-in").addEventListener("click", () => stepContinuationZoom(1));
  el("continuation-zoom-fit").addEventListener("click", resetContinuationZoom);
  document.addEventListener("keydown", onContinuationKeydown);
  // 窗口高度变了（比如从大窗口拖小）也把交界处重新对到中间
  window.addEventListener("resize", () => {
    const panel = el("continuation-panel");
    if (panel && !panel.hidden && continuationState) centerContinuationJunction(true);
  });
  el("finish-start-review").addEventListener("click", finishStartReview);
  el("finish-export").addEventListener("click", finishOpenExport);
  el("diff-queue-toggle").addEventListener("click", () => setQueueOpen(!queueOpen));
  el("queue-adopt").addEventListener("click", adoptQueueCurrent);
  el("queue-keep").addEventListener("click", keepQueueCurrent);
  el("queue-prev").addEventListener("click", previousQueueItem);

  const moreMenu = el("review-more-menu");
  el("review-more").addEventListener("click", (event) => {
    event.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
  });
  for (const item of moreMenu.querySelectorAll("button")) {
    item.addEventListener("click", () => {
      moreMenu.hidden = true;
    });
  }
  document.addEventListener("click", (event) => {
    if (moreMenu.hidden) return;
    if (moreMenu.contains(event.target) || event.target === el("review-more")) return;
    moreMenu.hidden = true;
  });

  document.addEventListener("keydown", (event) => {
    if (!currentProject || detailPageNo === null) return;
    const active = document.activeElement || {};
    const inEditor = ["TEXTAREA", "INPUT", "SELECT"].includes(active.tagName);
    const inQueue = Boolean(active.closest && active.closest("#diff-queue"));
    const inOtherButton = active.tagName === "BUTTON" && !inQueue;
    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.key === "Enter") {
      event.preventDefault();
      confirmCurrentPage();
      return;
    }
    // 任务 45：`[` / `]` 上一处 / 下一处（跨块，不跨页）
    if (!inEditor && !inOtherButton && (event.key === "[" || event.key === "]")) {
      event.preventDefault();
      stepReviewDiff(event.key === "]" ? 1 : -1);
      return;
    }
    // 队列键位：Enter / Space 采纳，⌫ 保留，← 回上一处。
    // 只在队列展开、焦点不在编辑框 / 其它按钮时接管，避免抢按钮的原生 Enter / Space。
    if (queueOpen && diffQueue.length && !inEditor && !inOtherButton) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        adoptQueueCurrent();
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        keepQueueCurrent();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        previousQueueItem();
        return;
      }
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

async function recognizeSelection(force = false) {
  const project = currentProject;
  const pages = selectionPages().filter((page) => page.include);
  if (!project || !pages.length) return;
  if (!warnUnconfirmed(pages, "识别所选页")) return;
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
  const marginNotice = el("margin-judgement-notice");
  if (marginNotice) marginNotice.hidden = true;
  finishSummary = null;
  finishSummaryProject = null;
  projectSummary = null;
  projectExports = [];
  workflowStep = null;
  workflowStepPinned = false;
  updateFinishChips();
  workflowByPageId = new Map();
  workflowSummary = null;
  workflowConfirmationCounts = { human: 0, auto: 0, unknown: 0 };
  pendingPageNos = new Set();
  pendingPageCount = 0;
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
  el("trash-open").addEventListener("click", openTrashPanel);
  el("trash-close").addEventListener("click", () => closeModal("trash-panel"));
  setupCollabControls();
  el("apply-high-suggestions").addEventListener("click", openSuggestionApplyPanel);
  el("review-apply-all").addEventListener("click", openSuggestionApplyPanel);
  el("suggestion-apply-close").addEventListener("click", () => closeModal("suggestion-apply-panel"));
  el("suggestion-apply-cancel").addEventListener("click", () => closeModal("suggestion-apply-panel"));
  el("suggestion-apply-run").addEventListener("click", runSuggestionApply);
  el("auto-apply-suggestions").addEventListener("change", (event) =>
    setAutoApplySetting(event.target.checked)
  );
  el("auto-apply-undo").addEventListener("click", () =>
    undoAutoApply(el("auto-apply-notice").dataset.autoApplyId)
  );
  el("auto-apply-dismiss").addEventListener("click", hideAutoApplyNotice);
  el("split-batch-close").addEventListener("click", () => closeModal("split-batch-panel"));
  el("split-batch-cancel").addEventListener("click", () => closeModal("split-batch-panel"));
  el("split-batch-apply").addEventListener("click", applySplitBatch);
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
  el("selection-check").addEventListener("click", () => checkSelection(null));
  el("check-pending").addEventListener("click", () => checkSelection("unchecked"));
  el("stats-refresh").addEventListener("click", loadSummary);
  setupTaskDrawer();

  // 筛选与选择（说明书 6.2）
  el("filter-type").addEventListener("change", renderPages);
  el("filter-recognition").addEventListener("change", renderPages);
  el("filter-workflow").addEventListener("change", renderPages);
  el("filter-triage").addEventListener("change", renderPages);
  el("pages-only-included").addEventListener("change", renderPages);
  // 点页面网格的空白处取消选择：只认"不在任何页瓷砖里"的点击，
  // 所以单击页 / 拖版心把手 / 页内按钮都不会误触发。
  el("page-grid").addEventListener("click", (event) => {
    if (!currentProject) return;
    if (event.target.closest(".page-tile")) return;
    if (event.target.closest(".page-margin__handle")) return;
    clearPageSelection();
  });
  el("page-range-select").addEventListener("click", applyPageRangeInput);
  el("page-range").addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyPageRangeInput();
  });
  el("selection-all").addEventListener("click", selectAllVisiblePages);
  el("selection-select-all").addEventListener("click", selectAllVisiblePages);
  el("selection-clear").addEventListener("click", clearPageSelection);
  el("selection-recognize").addEventListener("click", () => {
    if (!selectedPages.size) {
      startBatchRecognition("unrecognized");
      return;
    }
    const body = selectionPages().filter((page) => page.include);
    const pending = body.filter((page) => recognitionOf(page).status === "unrecognized");
    recognizeSelection(body.length > 0 && pending.length === 0);
  });
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
  el("pages-zoom-out").addEventListener("click", () => setPageZoom(-1));
  el("pages-zoom-in").addEventListener("click", () => setPageZoom(1));
  el("pages-overlay-toggle").addEventListener("click", togglePageBlocksOverlay);
  el("pages-margin-toggle").addEventListener("click", toggleMarginView);
  el("layout-block-apply-all").addEventListener("click", adoptAllHighSuggestions);
  el("layout-block-confirm").addEventListener("click", confirmLayoutFromPanel);
  el("margin-confirm-all").addEventListener("click", confirmAllMargins);
  el("rec-start-all").addEventListener("click", () => startBatchRecognition("unrecognized"));
  el("rec-aux-all").addEventListener("click", startAuxiliaryAll);
  el("aux-warning-skip").addEventListener("click", () => {
    auxWarningSkipped = true;
    closeModal("aux-warning-mask");
    enterReviewStep();
  });
  el("aux-warning-cancel").addEventListener("click", () => closeModal("aux-warning-mask"));
  el("aux-warning-wait").addEventListener("click", waitForAuxThenReview);
  el("garbled-close").addEventListener("click", closeGarbledPanel);
  el("garbled-adopt").addEventListener("click", () => decideGarbledLines("adopted"));
  el("garbled-keep").addEventListener("click", () => decideGarbledLines("kept"));
  el("punct-groups-close").addEventListener("click", () => closeModal("punct-groups-mask"));
  el("punct-groups-done").addEventListener("click", () => closeModal("punct-groups-mask"));
  el("punct-groups-undo").addEventListener("click", undoPunctBatch);
  el("lock-conflict-close").addEventListener("click", closeLockConflict);
  el("lock-conflict-cancel").addEventListener("click", closeLockConflict);
  el("lock-conflict-force").addEventListener("click", confirmLockConflict);
  el("word-boxes-open").addEventListener("click", () => {
    el("page-more-menu").hidden = true;
    openWordBoxesDialog();
  });
  el("backups-open").addEventListener("click", () => {
    el("page-more-menu").hidden = true;
    openBackups();
  });
  el("backups-close").addEventListener("click", () => closeModal("backups-mask"));
  el("backups-cancel").addEventListener("click", () => closeModal("backups-mask"));
  el("backups-restore").addEventListener("click", restoreSelectedBackup);
  el("aux-rerun").addEventListener("click", () => {
    el("page-more-menu").hidden = true;
    rerunAuxiliary();
  });
  el("word-boxes-cancel").addEventListener("click", () => closeModal("word-boxes-mask"));
  el("word-boxes-cancel-x").addEventListener("click", () => closeModal("word-boxes-mask"));
  el("word-boxes-start").addEventListener("click", startWordBoxesBackfill);
  el("word-boxes-clear").addEventListener("click", clearWordBoxes);
  el("layout-detect-open").addEventListener("click", () => {
    // 点 ⋯ 里的条目：先收起菜单，再开对话框（模板遮罩不能挂在菜单里）
    el("page-more-menu").hidden = true;
    openLayoutDetectDialog();
  });
  el("layout-detect-cancel").addEventListener("click", () => closeModal("layout-detect-mask"));
  el("layout-detect-cancel-x").addEventListener("click", () => closeModal("layout-detect-mask"));
  el("layout-detect-start").addEventListener("click", startLayoutDetectFromDialog);
  setupMarginDrag();
  el("setup-confirm-selected").addEventListener("click", confirmSelectedPages);
  el("split-page-numbers").addEventListener("click", openSplitBatchPanel);
  el("setup-confirm-all").addEventListener("click", confirmAllUnconfirmed);
  el("detail-recognize").addEventListener("click", () => {
    if (detailPageNo === null) return;
    const page = currentProject.pages.find((item) => item.page_no === detailPageNo);
    if (page) recognizePage(page);
  });
}


// ---------------------------------------------------------------- 全库采用高把握建议
//
// 用户的原话是"有没有办法自动识别页眉页脚？而不是我每一页手动改？"
// 建议其实已经算出来了（只读），这里给它一个"一次全用上"的入口：
// 先扫描（dry_run，不写库）看影响多少页 / 块，确认后整批应用（一个 batch，可整体撤销）。
// 另有项目级开关"识别完成后自动应用"：由**识别子进程**在任务收尾时执行，
// 每次记一条 auto_apply_run，界面顶部有提示条 + 一键撤销（见 D-064）。

let suggestionApplyPlan = null;
/** 最近一次自动应用（GET /auto-apply 的结果）。 */
let latestAutoApply = null;
/** 已经提示过的自动应用 id：同一个不重复弹。 */
let autoApplyAnnouncedId = null;

/** 任务 34：按版心判定正文默认开；只有显式存了 false 才是关。 */
function marginJudgementOn() {
  const settings = (currentProject && currentProject.settings) || {};
  const value = settings.margin_box_judgement;
  return value === undefined || value === null ? true : Boolean(value);
}

function applyProjectSettings() {
  const settings = (currentProject && currentProject.settings) || {};
  el("auto-apply-suggestions").checked = Boolean(settings.auto_apply_high_suggestions);
  // 导出面板 / 识别设置里的同一个项目级开关（任务 51 / 34）：默认开
  el("export-margin-judgement").checked = marginJudgementOn();
  const recMargin = el("rec-margin-judgement");
  if (recMargin) recMargin.checked = marginJudgementOn();
  // 识别设置（任务 54）：引擎 / DPI / 语言 / 双引擎策略
  renderRecognitionSettings();
  renderMarginJudgementNotice();
}

/** 任务 34：默认打开「按版心判定」后，老项目第一次打开给一句说明。 */
function renderMarginJudgementNotice() {
  const bar = el("margin-judgement-notice");
  if (!bar) return;
  const settings = (currentProject && currentProject.settings) || {};
  bar.hidden = Boolean(settings.margin_judgement_notice) || !marginJudgementOn();
}

async function dismissMarginJudgementNotice() {
  el("margin-judgement-notice").hidden = true;
  if (!currentProject) return;
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ margin_judgement_notice: true }),
    });
    currentProject.settings = data.settings;
  } catch {
    /* 提示关不掉不该影响使用 */
  }
}

function autoApplyTypeText(byType) {
  const labels = { header: "页眉", footer: "页脚", page_number: "页码", margin_note: "旁批" };
  return Object.entries(byType || {})
    .map(([type, count]) => `${labels[type] || type} ${count}`)
    .join(" / ");
}

/** 右栏那行"上次自动应用：N 页 M 块（可撤销）"。 */
function renderAutoApplyStatus(run) {
  latestAutoApply = run;
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
    `上次自动应用：${run.pages} 页 ${run.blocks} 块（${autoApplyTypeText(run.by_type)}）` +
    ` · ${when} · ${run.status === "undone" ? "已撤销" : "可撤销"}`;
  node.append(text);
  if (run.status === "applied") {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "btn btn--sm btn--ghost";
    undo.textContent = "撤销这次自动应用";
    undo.addEventListener("click", () => undoAutoApply(run.auto_apply_id));
    node.append(undo);
  }
}

async function loadAutoApplyStatus({ announce = false, jobId = null } = {}) {
  if (!currentProject || currentProject.kind === "package") return;
  let data;
  try {
    data = await apiJson(`/api/projects/${currentProject.project_id}/auto-apply`);
  } catch {
    return;
  }
  const run = data.latest || null;
  renderAutoApplyStatus(run);
  if (!announce || !jobId) {
    if (run) autoApplyAnnouncedId = run.auto_apply_id;
    return;
  }
  if (run && run.job_id === jobId && run.status === "applied") {
    if (autoApplyAnnouncedId !== run.auto_apply_id) {
      autoApplyAnnouncedId = run.auto_apply_id;
      showAutoApplyNotice(run);
      // 块类型变了：页面视图的框与建议角标不能再用旧的
      refreshAfterTypeChanges([]);
    }
    return;
  }
  // 子进程是在任务结算**之后**才写自动应用记录的：再等一轮
  const key = `announced:${jobId}`;
  const attempts = Number(sessionStorage.getItem(key) || "0");
  if (attempts < 3) {
    sessionStorage.setItem(key, String(attempts + 1));
    setTimeout(() => loadAutoApplyStatus({ announce, jobId }), 900);
  }
}

/**
 * 顶部提示条。`undoId` 有值时显示「撤销这次自动应用」按钮
 * （手工整批应用的撤销在审校视图的撤销栈里，所以不显示这个按钮）。
 */
function showNoticeBar(text, { undoId = null } = {}) {
  el("auto-apply-notice-text").textContent = text;
  el("auto-apply-notice").hidden = false;
  el("auto-apply-notice").dataset.autoApplyId = undoId || "";
  el("auto-apply-undo").hidden = !undoId;
}

function showAutoApplyNotice(run) {
  showNoticeBar(
    `识别完成后自动应用了 ${run.pages} 页 ${run.blocks} 块（${autoApplyTypeText(run.by_type)}）。` +
      "不满意可以整批撤销。",
    { undoId: run.auto_apply_id }
  );
}

function hideAutoApplyNotice() {
  el("auto-apply-notice").hidden = true;
}

/** 类型变了之后统一收尾：丢块框缓存 / 建议缓存，就地刷新状态。 */
function refreshAfterTypeChanges(pageNos) {
  if (pageNos && pageNos.length) {
    for (const pageNo of pageNos) forgetPageBlocks(pageNo);
  } else {
    forgetAllPageBlocks();
  }
  forgetAllPageSuggestions();
  refreshPageStates();
  schedulePageVisibility();
}

async function undoAutoApply(autoApplyId) {
  if (!currentProject || !autoApplyId) return;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/auto-apply/${autoApplyId}/undo`,
      { method: "POST" }
    );
    hideAutoApplyNotice();
    refreshAfterTypeChanges(data.pages_affected || []);
    if (detailPageNo !== null) await loadPageDetail(detailPageNo, { forceSuggestions: true });
    await loadAutoApplyStatus();
    notifyApplied(
      `已撤销这次自动应用（${data.pages} 页 ${data.blocks} 块），块类型回到自动应用之前。`
    );
  } catch (error) {
    showError(el("page-detail-error"), error);
  }
}

/** 结果提示：页面视图用右栏的提示条，审校视图用顶栏的保存状态。 */
function notifyApplied(text) {
  // 顶部提示条比右栏的临时提示更持久（右栏那行会被 updateSelectionPanel 重画）
  showNoticeBar(text);
  setSaveState(text);
}

async function setAutoApplySetting(on) {
  if (!currentProject) return;
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
    const data = await apiJson(`/api/projects/${currentProject.project_id}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_apply_high_suggestions: Boolean(on) }),
    });
    currentProject.settings = data.settings;
    applyProjectSettings();
    notifyApplied(
      on
        ? "已打开：之后完成的识别任务会自动应用高把握建议（顶部有提示，可撤销）。"
        : "已关闭：识别完成后只给建议，不改块类型。"
    );
  } catch (error) {
    checkbox.checked = !on;
    showError(el("selection-hint"), error);
  }
}

/**
 * 项目级「按版心判定正文」（任务 51 / 34）。**默认开**；显式关掉才按块类型判定，
 * 行为与升级前一致。切换后立刻重跑导出预检；正文 / 元数据的形状由服务端按同一设置算。
 */
async function setMarginJudgementSetting(enabled) {
  if (!currentProject) return;
  const checkbox = el("export-margin-judgement");
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ margin_box_judgement: Boolean(enabled) }),
    });
    currentProject.settings = data.settings;
    applyProjectSettings();
    await refreshExportPreflight();
  } catch (error) {
    checkbox.checked = !enabled;
    const rec = el("rec-margin-judgement");
    if (rec) rec.checked = !enabled;
    showError(el("export-error"), error);
  }
}

async function openSuggestionApplyPanel() {
  if (!currentProject) return;
  el("suggestion-apply-error").hidden = true;
  el("suggestion-apply-summary").textContent = "正在扫描全部正文页…";
  el("suggestion-apply-types").innerHTML = "";
  el("suggestion-apply-samples").innerHTML = "";
  el("suggestion-apply-run").disabled = true;
  el("suggestion-apply-run").textContent = "应用";
  openModal("suggestion-apply-panel");
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/suggestions/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true }),
      }
    );
    renderSuggestionApplyPreview(data);
  } catch (error) {
    el("suggestion-apply-summary").textContent = "扫描失败";
    showError(el("suggestion-apply-error"), error);
  }
}

function renderSuggestionApplyPreview(data) {
  suggestionApplyPlan = data;
  const blocks = data.blocks || 0;
  const pages = data.pages || 0;
  el("suggestion-apply-summary").textContent = blocks
    ? `扫描了 ${data.pages_scanned} 页 / ${data.blocks_scanned} 块：会改 ${pages} 页 · ${blocks} 块`
    : `扫描了 ${data.pages_scanned} 页 / ${data.blocks_scanned} 块：没有需要改的块（已经都是对的，或者都还"需确认"）`;
  const types = el("suggestion-apply-types");
  types.innerHTML = "";
  for (const [type, count] of Object.entries(data.by_type || {})) {
    const pill = document.createElement("span");
    pill.className = `suggestion-type suggestion-type--${type}`;
    pill.textContent = `${BLOCK_TYPE_LABELS[type] || type} ${count}`;
    types.append(pill);
  }
  const list = el("suggestion-apply-samples");
  list.innerHTML = "";
  for (const item of data.samples || []) {
    const li = document.createElement("li");
    li.textContent =
      `第 ${item.page_no} 页 · ${BLOCK_TYPE_LABELS[item.current_type] || item.current_type}` +
      ` → ${BLOCK_TYPE_LABELS[item.suggested_type] || item.suggested_type}：${item.text}`;
    list.append(li);
  }
  const run = el("suggestion-apply-run");
  run.disabled = blocks === 0;
  run.textContent = blocks ? `应用（${blocks} 块）` : "没有可应用的";
}

async function runSuggestionApply() {
  if (!currentProject) return;
  const button = el("suggestion-apply-run");
  button.disabled = true;
  button.textContent = "正在应用…";
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/suggestions/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: false }),
      }
    );
    closeModal("suggestion-apply-panel");
    refreshAfterTypeChanges(data.pages_affected || []);
    if (detailPageNo !== null && (data.pages_affected || []).includes(detailPageNo)) {
      await loadPageDetail(detailPageNo, { forceSuggestions: true });
    }
    notifyApplied(
      `已采用 ${data.blocks} 块高把握建议（${data.pages} 页，第 ${data.history.undo} 个可撤销操作）。` +
        "整批可撤销：审校视图点「撤销」。"
    );
  } catch (error) {
    showError(el("suggestion-apply-error"), error);
    button.disabled = false;
    button.textContent = "重试应用";
  }
}

// ---------------------------------------------------------------- 批量拆分书眉页码
//
// 书眉 / 页脚和页码被 OCR 成一个块（`2谁是巴赫金?11`）时，逐块拆太慢。
// 这里三步：算预览（dry_run，只读）→ 人看影响多少页 / 块 → 确认后才写。
// 整批共用一条 batch（服务端），所以在审校视图点一次「撤销」就整批回退。

/** 批量范围：选了页就只做这些页，没选就是全部正文页。 */
function splitBatchScope() {
  const selected = [...selectedPages].sort((left, right) => left - right);
  if (selected.length) {
    return { pages: selected, label: `选中的 ${selected.length} 页` };
  }
  const body = currentProject.pages.filter((page) => page.include).map((page) => page.page_no);
  return { pages: body, label: `全部正文页（${body.length} 页）` };
}

async function openSplitBatchPanel() {
  if (!currentProject) return;
  const scope = splitBatchScope();
  if (!scope.pages.length) return;
  el("split-batch-error").hidden = true;
  el("split-batch-note").hidden = true;
  el("split-batch-list").innerHTML = "";
  el("split-batch-summary").textContent = "正在计算…";
  el("split-batch-scope").textContent = `范围：${scope.label}`;
  el("split-batch-apply").disabled = true;
  el("split-batch-apply").textContent = "执行拆分";
  openModal("split-batch-panel");
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/split-page-numbers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_numbers: scope.pages, dry_run: true }),
      }
    );
    renderSplitBatchPreview(data);
  } catch (error) {
    el("split-batch-summary").textContent = "算不出来";
    showError(el("split-batch-error"), error);
  }
}

/** 预览：影响多少页 / 块 + 前几条（用户点执行之前必须看到范围）。 */
function renderSplitBatchPreview(data) {
  const blocks = data.blocks || 0;
  const pages = data.pages || 0;
  el("split-batch-summary").textContent = blocks
    ? `会影响 ${pages} 页 · ${blocks} 块（下面按页序列出前 ${Math.min(8, blocks)} 条）`
    : `没有找到需要拆的块（扫了 ${data.pages_considered || 0} 页）`;
  const list = el("split-batch-list");
  list.innerHTML = "";
  for (const item of data.items || []) {
    const li = document.createElement("li");
    const typeLabel = BLOCK_TYPE_LABELS[item.block_type] || item.block_type;
    const where = item.position === "start" ? "块首" : "块尾";
    li.textContent =
      `第 ${item.page_no} 页 · ${typeLabel}：${item.text} → 拆出页码 ${item.number}（${where}）`;
    li.title =
      `拆分后：${BLOCK_TYPE_LABELS[item.head_type] || item.head_type} + ` +
      `${BLOCK_TYPE_LABELS[item.tail_type] || item.tail_type}`;
    list.append(li);
  }
  const apply = el("split-batch-apply");
  apply.disabled = blocks === 0;
  apply.textContent = blocks ? `执行拆分（${blocks} 块）` : "没有可拆的块";
  const skipped = data.skipped_context_pages || [];
  if (skipped.length) {
    el("split-batch-note").textContent = `跳过了 ${skipped.length} 页只读上下文页`;
    el("split-batch-note").hidden = false;
  }
}

async function applySplitBatch() {
  if (!currentProject) return;
  const scope = splitBatchScope();
  const button = el("split-batch-apply");
  button.disabled = true;
  button.textContent = "正在拆分…";
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/split-page-numbers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_numbers: scope.pages, dry_run: false }),
      }
    );
    closeModal("split-batch-panel");
    // 块变了：这些页的块框缓存与建议角标都不能再用旧的
    for (const pageNo of data.pages_affected || []) forgetPageBlocks(pageNo);
    forgetAllPageSuggestions();
    await refreshPageStates();
    schedulePageVisibility();
    const hint = el("selection-hint");
    hint.hidden = false;
    hint.textContent =
      `已拆分 ${data.blocks} 块（${(data.pages_affected || []).length} 页）。` +
      "整批算一个操作：到「审校」视图点「撤销」可以一次回退。";
    if (detailPageNo !== null && (data.pages_affected || []).includes(detailPageNo)) {
      await loadPageDetail(detailPageNo, { forceSuggestions: true });
    }
  } catch (error) {
    showError(el("split-batch-error"), error);
    button.disabled = false;
    button.textContent = "重试执行";
  }
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
    el("structure-open").hidden = false;
    el("selection-recognize").hidden = false;
    el("selection-actionbar").hidden = false;
    el("finish-open-review").hidden = false;
    el("selection-check").hidden = false;
    el("check-pending").hidden = false;
    el("selection-skip-checked").parentElement.hidden = false;
    el("setup-panel").hidden = false;
    el("panel-recognition-settings").hidden = false;
    el("panel-pagenum-settings").hidden = false;
    el("page-setup-bar").hidden = false;
    el("assign-list-toggle").hidden = false;
    el("assign-open").hidden = false;
    syncWorkflowSteps();
    return;
  }

  el("package-open").hidden = false;        // 但能导出审校结果包
  el("structure-open").hidden = true;       // 也没有页眉页脚工具
  el("assign-list-toggle").hidden = true;   // 助手不派活给别人
  el("assign-open").hidden = true;
  el("selection-actionbar").hidden = true;
  el("finish-open-review").hidden = true;
  closeFinishPanel();
  el("selection-check").hidden = true;
  el("check-pending").hidden = true;
  el("selection-skip-checked").parentElement.hidden = true;
  el("setup-panel").hidden = true;
  el("panel-recognition-settings").hidden = true;  // 任务包不做识别
  el("panel-pagenum-settings").hidden = true;      // 任务包也不改页码映射
  el("page-setup-bar").hidden = true;
  syncWorkflowSteps();
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

// ---------------------------------------------------------------- 恢复备份（任务 65）

let backupsData = null;
let backupSelected = null;

async function openBackups() {
  backupSelected = null;
  el("backups-error").hidden = true;
  openModal("backups-mask");
  await loadBackups();
}

async function loadBackups() {
  const list = el("backups-list");
  list.innerHTML = "";
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/backups`);
    backupsData = data.backups || [];
  } catch (error) {
    showError(el("backups-error"), error);
    return;
  }
  el("backups-foot").textContent = backupsData.length
    ? `共 ${backupsData.length} 份`
    : "这个项目还没有备份";
  el("backups-restore").disabled = true;
  for (const item of backupsData) {
    const row = document.createElement("li");
    row.className = "backup-row";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "backup-pick";
    radio.value = item.name;
    radio.addEventListener("change", () => {
      backupSelected = item;
      el("backups-restore").disabled = false;
    });
    const main = document.createElement("div");
    main.className = "backup-row__main";
    const title = document.createElement("div");
    title.textContent = `${formatMarginTime(item.created_at) || item.name} · ${humanBytes(item.size)}`;
    const note = document.createElement("div");
    note.className = "muted";
    note.textContent = `${item.note} · ${item.name}`;
    main.append(title, note);
    row.append(radio, main);
    list.append(row);
  }
}

async function restoreSelectedBackup() {
  if (!backupSelected || !currentProject) return;
  const projectId = currentProject.project_id;
  const ok = window.confirm(
    `用「${backupSelected.name}」覆盖当前项目库？\n\n` +
      "· 会丢掉这份备份之后的所有改动\n" +
      "· 恢复前会把当前库再备份一份（「恢复前的安全备份」）\n" +
      "· 恢复后会自动重新打开项目"
  );
  if (!ok) return;
  el("backups-error").hidden = true;
  const button = el("backups-restore");
  button.disabled = true;
  button.textContent = "正在恢复…";
  try {
    // 恢复要求没有写入方：先关项目
    await apiJson(`/api/projects/${projectId}/close`, { method: "POST" }).catch(() => null);
    const data = await apiJson(
      `/api/projects/${projectId}/backups/${encodeURIComponent(backupSelected.name)}/restore?confirm=true`,
      { method: "POST" }
    );
    closeModal("backups-mask");
    await openProject(projectId);
    const warning = el("library-warning");
    warning.textContent = `已恢复备份 ${data.from}；恢复前的库另存为 ${data.safety_backup}`;
    warning.hidden = false;
  } catch (error) {
    showError(el("backups-error"), error);
  } finally {
    button.disabled = false;
    button.textContent = "恢复选中的备份";
  }
}

// ---------------------------------------------------------------- 语言分布（任务 64）

async function loadLanguageSummary() {
  const node = el("rec-language-summary");
  if (!node || !currentProject) return;
  try {
    const data = await apiJson(`/api/projects/${currentProject.project_id}/aux/languages`);
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

// ---------------------------------------------------------------- 重跑第二引擎（任务 64）
//
// 用户拍板：以后一律用第二引擎（Vision），不用文字层。已有项目的 aux 是文字层，
// 这里给一个"换掉"的动作：先备份（服务端做），只覆盖 aux_text / diff_status，
// 已裁决的行不覆盖；分批可续（就是个普通的复核任务）。

async function rerunAuxiliary() {
  if (!currentProject) return;
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
    const data = await apiJson(`/api/projects/${currentProject.project_id}/aux/rerun`, {
      method: "POST",
    });
    const warning = el("library-warning");
    warning.textContent =
      `已建复核任务（Vision · 按页语言）。备份：${data.backup_path}`;
    warning.hidden = false;
    await loadTasks();
  } catch (error) {
    showError(el("pages-error"), error);
  }
}

// ---------------------------------------------------------------- 标点差异 · 按模式批量（任务 61）
//
// 用户现场（红楼梦 3）：1676 条差异行里 710 行只差标点 / 空格，归成 64 种模式；
// `；→，` 一种就 293 行，`∅→‘` 119 行（RapidOCR 系统性地吞掉开头引号）。
// 逐条点这 710 行是纯体力活，而"全部采用候选"能一次修掉几百处真错。
//
// 主队列（左树 / 进度 / 下一处未审）只放含汉字差异的行；这里按模式判，
// 判完写的是**行级 diff_ack**（和逐条审同一份数据），所以队列数字、导出、撤销全同步。

let punctGroupsData = null;
let punctGroupsProject = null;
let punctLastBatch = null;
let punctBusy = false;

function punctReviewStorageKey() {
  return currentProject ? `b2t.punctPerLine.${currentProject.project_id}` : "";
}

/** 被用户点了「逐条看」的模式：这些行回到主队列，逐条审。 */
function punctReviewSet() {
  try {
    const raw = localStorage.getItem(punctReviewStorageKey());
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function savePunctReviewSet(set) {
  try {
    localStorage.setItem(punctReviewStorageKey(), JSON.stringify([...set]));
  } catch {
    /* 存不下不影响功能：只是下次打开又要选一次 */
  }
}

function punctGroupByKey(key) {
  return (punctGroupsData?.groups || []).find((group) => group.key === key) || null;
}

// ── 整行乱码（2026-10-28）────────────────────────────────────────────────
//
// 识别有时把一整行打散成字母碎片（`phind,  n ons o ns a n onad`），候选是完整句子。
// 这类行会直接进语料，比个别错字严重，所以单独一类、支持批量采用候选。

let garbledData = null;
let garbledProject = "";

async function refreshGarbledLines() {
  if (!currentProject) return null;
  const projectId = currentProject.project_id;
  try {
    const data = await apiJson(`/api/projects/${projectId}/review/garbled-lines`);
    garbledData = data;
    garbledProject = projectId;
  } catch (error) {
    garbledData = null;
  }
  renderGarbledBadge();
  return garbledData;
}

function renderGarbledBadge() {
  const badge = el("reading-garbled-count");
  if (!badge) return;
  const lines = Number(garbledData?.totals?.lines || 0);
  badge.textContent = String(lines);
  const button = el("reading-garbled-open");
  if (button) button.hidden = lines === 0;
}

function renderGarbledList() {
  const list = el("garbled-list");
  const summary = el("garbled-summary");
  if (!list) return;
  list.innerHTML = "";
  const totals = garbledData?.totals || { lines: 0, candidates: 0, pages: 0 };
  const items = garbledData?.items || [];
  if (summary) {
    const pct = totals.candidates
      ? ((totals.lines / totals.candidates) * 100).toFixed(2)
      : "0.00";
    summary.textContent =
      `疑似 ${totals.lines} 行（占 ${totals.candidates} 行有候选的 ${pct}%），分布在 ${totals.pages} 页。` +
      (items.length < totals.lines ? `下面只列前 ${items.length} 行。` : "");
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "garbled-row";
    const head = document.createElement("div");
    head.className = "garbled-row__head";
    head.textContent = `第 ${item.page_no} 页 · 第 ${item.line_index + 1} 行 · 长度比 ${item.length_ratio}`;
    const cur = document.createElement("div");
    cur.className = "garbled-row__cur";
    cur.textContent = item.text;
    const cand = document.createElement("div");
    cand.className = "garbled-row__cand";
    cand.textContent = item.candidate;
    li.append(head, cur, cand);
    list.append(li);
  }
  const foot = el("garbled-foot");
  if (foot) foot.textContent = `共 ${totals.lines} 行，一次全判；可撤销`;
}

function openGarbledPanel() {
  if (!garbledData) return;
  const mask = el("garbled-mask");
  if (!mask) return;
  const box = el("garbled-error");
  if (box) box.hidden = true;
  renderGarbledList();
  mask.hidden = false;
}

function closeGarbledPanel() {
  const mask = el("garbled-mask");
  if (mask) mask.hidden = true;
}

async function decideGarbledLines(ack) {
  if (!currentProject) return;
  const box = el("garbled-error");
  try {
    const result = await apiJson(
      `/api/projects/${currentProject.project_id}/review/garbled-lines/decide`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ack }),
      }
    );
    closeGarbledPanel();
    // 裁决落到行上：marks / 计数 / 进度都要重拉（走既有的"整批之后重开阅读流"）
    await window.ReadingView.reload();
    await refreshGarbledLines();
    showNoticeBar(
      ack === "adopted"
        ? `已采用候选 ${result.applied} 行${result.skipped ? `（跳过 ${result.skipped}）` : ""}`
        : `已标记保留原文 ${result.applied} 行`
    );
  } catch (error) {
    if (box) showError(box, error);
  }
}

async function refreshPunctGroups() {
  if (!currentProject) return null;
  const projectId = currentProject.project_id;
  try {
    const data = await apiJson(`/api/projects/${projectId}/review/punct-groups`);
    punctGroupsData = data;
    punctGroupsProject = projectId;
  } catch (error) {
    punctGroupsData = { groups: [], totals: { groups: 0, lines: 0, undecided_lines: 0, undecided_groups: 0 } };
    const box = el("punct-groups-error");
    if (box) showError(box, error);
  }
  renderPunctGroupBadge();
  return punctGroupsData;
}

/** 顶栏按钮上的数字：还剩多少行没判（判完就只剩模式数）。 */
function renderPunctGroupBadge() {
  const counts = punctGroupsData?.totals || { undecided_lines: 0, undecided_groups: 0 };
  const set = punctReviewSet();
  const perLine = (punctGroupsData?.groups || [])
    .filter((group) => set.has(group.key))
    .reduce((sum, group) => sum + group.undecided, 0);
  const badge = el("reading-punct-count");
  if (badge) {
    badge.textContent = perLine
      ? `${counts.undecided_lines} 行`
      : counts.undecided_groups
        ? `${counts.undecided_lines} 行 · ${counts.undecided_groups} 组`
        : "已判完";
  }
  const button = el("reading-punct-open");
  if (button) {
    button.classList.toggle("is-on", Boolean(counts.undecided_groups));
    button.title = counts.undecided_groups
      ? `还有 ${counts.undecided_groups} 种标点模式没判（${counts.undecided_lines} 行）`
      : "标点差异都已裁决";
  }
}

async function openPunctGroups() {
  el("punct-groups-error").hidden = true;
  openModal("punct-groups-mask");
  if (punctGroupsProject !== (currentProject && currentProject.project_id) || !punctGroupsData) {
    await refreshPunctGroups();
  }
  renderPunctGroups();
}

function renderPunctGroups() {
  const list = el("punct-groups-list");
  if (!list) return;
  list.innerHTML = "";
  const data = punctGroupsData;
  if (!data) return;
  const set = punctReviewSet();
  const totals = data.totals || {};
  const pending = (data.groups || []).filter((group) => group.undecided && !set.has(group.key));
  el("punct-groups-summary").textContent =
    `${totals.lines || 0} 行纯标点 / 空格差异 · ${totals.groups || 0} 种模式 · ` +
    (pending.length
      ? `还有 ${pending.length} 种没判（${pending.reduce((sum, g) => sum + g.undecided, 0)} 行）`
      : "全部判完了");
  el("punct-groups-foot").textContent = punctLastBatch
    ? `最近一次：${punctLastBatch.label}`
    : "";
  el("punct-groups-undo").disabled = !punctLastBatch;

  if (!(data.groups || []).length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "这本书没有纯标点 / 空格差异。";
    list.append(empty);
    return;
  }
  for (const group of data.groups) {
    const perLine = set.has(group.key);
    const row = document.createElement("li");
    row.className = "punct-group" + (group.undecided && !perLine ? "" : " is-done");

    const head = document.createElement("div");
    head.className = "punct-group__head";
    const pattern = document.createElement("code");
    pattern.className = "punct-group__pattern";
    pattern.textContent = group.pattern;
    const count = document.createElement("span");
    count.className = "punct-group__count";
    count.textContent = `${group.count} 行`;
    const state = document.createElement("span");
    state.className = "chip chip--gray";
    if (perLine) {
      state.textContent = "已转为逐条";
    } else if (!group.undecided) {
      state.textContent = group.adopted ? `已采用 ${group.adopted} 行` : `已保留 ${group.kept} 行`;
      state.className = "chip chip--green";
    } else if (group.adopted || group.kept) {
      state.textContent = `已判 ${group.adopted + group.kept} / ${group.count}`;
      state.className = "chip chip--warn";
    } else {
      state.textContent = "未判";
      state.className = "chip chip--warn";
    }
    head.append(pattern, count, state);
    if (group.hint) {
      const hint = document.createElement("span");
      hint.className = "chip chip--warn";
      hint.textContent = group.hint;
      hint.title = "这条是系统给的判断依据，不是硬约束；逐条看可以自己定";
      head.append(hint);
    }

    const samples = document.createElement("ul");
    samples.className = "punct-group__samples";
    for (const sample of group.samples || []) {
      const item = document.createElement("li");
      const page = document.createElement("span");
      page.className = "punct-group__page";
      page.textContent = `第 ${sample.page_no} 页`;
      const text = document.createElement("span");
      text.className = "punct-group__text";
      text.textContent = sample.text.length > 60 ? `${sample.text.slice(0, 60)}…` : sample.text;
      item.append(page, text);
      item.title = `原文：${sample.text}\n候选：${sample.candidate_text}`;
      samples.append(item);
    }

    const actions = document.createElement("div");
    actions.className = "punct-group__actions";
    const adopt = document.createElement("button");
    adopt.type = "button";
    adopt.className = "btn btn--sm btn--pri";
    adopt.textContent = "全部采用候选";
    adopt.disabled = Boolean(perLine) || punctBusy;
    adopt.addEventListener("click", () => decidePunctGroup(group, "adopted"));
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn btn--sm";
    keep.textContent = "全部保留原文";
    keep.disabled = Boolean(perLine) || punctBusy;
    keep.addEventListener("click", () => decidePunctGroup(group, "kept"));
    const oneByOne = document.createElement("button");
    oneByOne.type = "button";
    oneByOne.className = "btn btn--sm";
    oneByOne.textContent = perLine ? "收回主队列" : "逐条看";
    oneByOne.title = "把这几种模式的行放回主队列，逐条审";
    oneByOne.addEventListener("click", () => {
      const next = punctReviewSet();
      if (perLine) next.delete(group.key);
      else next.add(group.key);
      savePunctReviewSet(next);
      renderPunctGroups();
      window.ReadingView.reload();
    });
    actions.append(adopt, keep, oneByOne);

    row.append(head, samples, actions);
    list.append(row);
  }
}

async function decidePunctGroup(group, ack) {
  if (punctBusy || !currentProject) return;
  punctBusy = true;
  el("punct-groups-error").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/review/punct-groups/decide`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: group.key, ack }),
      }
    );
    punctLastBatch = {
      label: `${group.pattern} ${ack === "adopted" ? "全部采用" : "全部保留"} ${data.applied} 行`,
      batchId: data.batch_id,
    };
    await refreshPunctGroups();
    renderPunctGroups();
    await window.ReadingView.reload();
  } catch (error) {
    showError(el("punct-groups-error"), error);
  } finally {
    punctBusy = false;
  }
}

async function undoPunctBatch() {
  if (!currentProject || punctBusy) return;
  punctBusy = true;
  el("punct-groups-error").hidden = true;
  try {
    await apiJson(`/api/projects/${currentProject.project_id}/undo`, { method: "POST" });
    punctLastBatch = null;
    await refreshPunctGroups();
    renderPunctGroups();
    await window.ReadingView.reload();
  } catch (error) {
    showError(el("punct-groups-error"), error);
  } finally {
    punctBusy = false;
  }
}

/** 批量裁决改了正文：整条阅读流重开一次（marks / 树 / 进度都跟着变）。 */

// ---------------------------------------------------------------- 启动

// ---------------------------------------------------------------- 阅读审校（L 刀：连续正文流）
//
// 与导出同一份 segments（含 line_spans）：段是排版单位、行是审校单位。
// 差异只在行内用红字标出来（汉字级实线 / 标点级虚线）；点红字在该行下面
// 展开候选面板。采用 / 保留 / 手改**全部先落草稿**（localStorage），
// 顶部「提交 N 处改动」才写库（后端一个 batch，撤销一次全退）。

// 窗口一次只铺 8 段：跳转时重建整个窗口也只要几十毫秒（24 段会到 1 秒）
const READING_CHUNK = 8;
let readingData = null;
let readingProject = null;
let readingTreeData = null;
let readingMarks = new Map();
let readingEntries = [];
// 任务 67：marks 只按页窗口加载（当前页 ±10）。全书 4435 条 = 1.52 MB / 0.90 s，
// 开机首屏红字全卡在那；窗口化后 1.7 ms / ~72 KB。计数和"下一处"靠下面这三个全书数字。
let readingMarksWindow = null;        // {page_from, page_to}；null = 还没加载
let readingGlobalCounts = null;       // {chars_total, chars_unacked, punct_total, punct_unacked, ...}
let readingPageCounts = new Map();    // page_no(string) → {total, unacked, acked, chars*, punct*}
let readingFirstUnackedPage = null;
let readingMarksInFlight = null;      // 在飞的补窗口请求；并发调用共享同一个 promise
let readingRepaintPending = false;   // 编辑期间欠着的一次重画
// 任务 72：左↔右同步互斥（谁先动谁锁 350 ms，另一个方向只跟随不反向驱动）
let readingSyncDriver = null;
let readingSyncUntil = 0;

let readingDrafts = new Map();
let readingFilter = "all";
let readingPageNo = 1;
let readingRendered = 0;
let readingSegmentNodes = [];
let readingPanelKey = null;
// 跳转后等待目标行落位的 key：只挡这一段页码写入（见 onReadingScroll）
let readingJumpSettleKey = null;
let readingJumpSettleTicks = 0;
let readingCursorEntry = null;   // 上一次跳到的 entry（窗口换了 index 就不算数）
let readingObserver = null;
let readingImageToken = 0;
let readingOpenStartedAt = 0;
const readingSpanCache = new Map();
let readingAppendScheduled = false;
let readingFollow = true;
let readingProof = false;
// 任务 66：就地编辑（按行编辑、草稿按块/按行存）
let readingInlineEdits = new Map();   // key(block:line) → {base, text, at}
let readingEditingKey = null;
let readingMarkupLevel = "all";      // all / simple / none（纯视图开关）
let readingPendingOn = true;          // 待审红字（原「成稿」= 取消它）
let readingInlineTimer = 0;
let readingScrollRaf = 0;
let readingPendingBox = null;
let readingPreflightData = null;

function readingKey(blockId, lineIndex) {
  return `${blockId}:${lineIndex}`;
}

function readingDraftStorageKey() {
  return currentProject ? `b2t.readingDrafts.${currentProject.project_id}` : "";
}


/**
 * 进「正文审校」默认开版心 + 块框（任务 57）。
 *
 * 这里是读稿主界面：用户要看到"这一段的字在左边哪一块上"。块框用页面视图同一份状态；
 * 两个开关都只改显示，不写库。
 */
function setReviewOverlaysForReading() {
  if (!pagesMarginOn) {
    pagesMarginOn = true;
    savePageMarginPreference();
    el("pages-margin-toggle")?.classList.add("is-on");
  }
  if (!pagesOverlayOn) {
    pagesOverlayOn = true;
    savePageOverlayPreference();
    el("pages-overlay-toggle")?.classList.add("is-on");
  }
  // 已经画过的页要按新开关重画一遍（否则要等下一次滚动才出框）
  for (const pageNo of readingVisibleSet) paintReadingTile(pageNo);
}

/** 阅读流左栏（PDF 页列）当前滚动位置；没有左栏时按 0。 */
let readingAutoJumpDone = false;

/** 用户最后一次**自己**在审校视图里动手（滚轮 / 按下 / 按键）的时刻。 */
let readingUserMovedAt = 0;
/** 用户真实输入触发的滚动序号；`readingProgramScrollSeq` 是程序滚动的序号，
 * 两者不等说明"这次滚动是用户滚的"，左右跟随据此判断。 */
let readingUserScrollSeq = 0;
let readingProgramScrollSeq = 0;


let readingMarksRequestSeq = 0;


function readingVisibleSegments() {
  if (!readingData) return [];
  let includeFootnotes = false;
  try {
    includeFootnotes = Boolean(exportOptions().include_footnotes);
  } catch {
    includeFootnotes = false;
  }
  return (readingData.segments || []).filter((segment) => {
    if (!segment.text || !segment.text.trim()) return false;
    if (!includeFootnotes && segment.type === "footnote") return false;
    return true;
  });
}


function readingEntryVisible(entry) {
  const draft = readingDrafts.get(readingKey(entry.block_id, entry.line_index));
  if (readingFilter === "chars" && entry.level !== "differs_chars") return false;
  if (readingFilter === "unacked") {
    if (entry.ack) return false;
    if (draft) return false;
  }
  return true;
}


/**
 * 把一个差异字符区间扩成"字 / 词"单位（任务 59）。
 *
 * - 中文：一个字就是单位，不扩（本来就只标差异字）；
 * - 英文：引擎给的是**词级**框，扩到整词边界（`Ladyship's` 一框就整词标）；
 * - 没有字框也不影响这一步：词边界从文本本身算，字框只用于页面上的色块。
 */
function expandToWordRange(text, start, end) {
  if (!/[A-Za-z]/.test(text.slice(start, end))) return { start, end, word: false };
  let left = start;
  while (left > 0 && /[A-Za-z'’\-]/.test(text[left - 1])) left -= 1;
  let right = end;
  while (right < text.length && /[A-Za-z'’\-]/.test(text[right])) right += 1;
  return { start: left, end: right, word: true };
}


function readingLineText(segment, span) {
  return segment.text.slice(span.start, span.end);
}

/**
 * 一行被就地编辑过 → 按当前修订档渲染（任务 66）。
 *
 * - `all`：删除红删除线 + 插入绿下划线；连续 >12 字的改动折叠成「⟦替换 N 字⟧」
 * - `simple`：只显示终稿 + 左边距琥珀条 + 段首 ▸（点 ▸ 临时切回 all）
 * - `none`：终稿无痕，但**改过的行左侧仍有一个小圆点**（不然改错了看不出来）
 */
function paintInlineRevision(line, inline) {
  const key = line.dataset.key;
  line.classList.add("is-inline-edited");
  line.dataset.revBase = inline.base;
  line.dataset.revText = inline.text;
  const chip = document.createElement("span");
  chip.className = "reading-chip reading-chip--edit";
  chip.textContent = "草稿";
  if (readingMarkupLevel === "none") {
    line.textContent = inline.text;
    line.append(chip);
    line.classList.add("is-changed-dot");
    return;
  }
  if (readingMarkupLevel === "simple") {
    line.textContent = inline.text;
    line.append(chip);
    line.classList.add("is-changed-bar");
    return;
  }
  const spans = computeCharSpans(inline.base, inline.text);
  const replaced =
    spans.reduce((sum, span) => sum + Math.max(span.aEnd - span.aStart, span.bEnd - span.bStart), 0);
  line.classList.add("is-changed-bar");
  if (replaced > 12) {
    // 长改动：折叠，点一下展开（展开是临时状态，不改数据）
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "reading-fold";
    fold.textContent = `⟦替换 ${replaced} 字 · 点击展开⟧`;
    fold.dataset.key = key;
    if (line.dataset.expanded !== "1") {
      line.append(fold, chip);
      return;
    }
    fold.remove();
  }
  line.append(document.createTextNode(inline.text.slice(0, 0)));
  let cursor = 0;
  for (const span of spans) {
    if (span.aStart > cursor) {
      line.append(document.createTextNode(inline.text.slice(cursor, span.bStart)));
    }
    if (span.aEnd > span.aStart) {
      const delEl = document.createElement("del");
      delEl.className = "reading-del";
      delEl.textContent = inline.base.slice(span.aStart, span.aEnd);
      line.append(delEl);
    }
    if (span.bEnd > span.bStart) {
      const insEl = document.createElement("ins");
      insEl.className = "reading-ins";
      insEl.textContent = inline.text.slice(span.bStart, span.bEnd);
      line.append(insEl);
    }
    cursor = span.bEnd;
  }
  if (cursor < inline.text.length) {
    line.append(document.createTextNode(inline.text.slice(cursor)));
  }
  line.append(chip);
}


function buildReadingLine(segment, span, displayText = null) {
  const key = readingKey(span.block_id, span.line_index);
  const mark = readingMarks.get(key);
  const draft = readingDrafts.get(key);
  const line = document.createElement("span");
  line.className = "reading-line";
  line.dataset.key = key;
  line.dataset.block = span.block_id;
  line.dataset.line = String(span.line_index);
  line.dataset.page = String(span.page_no);
  // `text` = 逻辑行文本（行自己的字，用于编辑与写回）；
  // `displayText` = 这一行在连续切片里实际占的字符（含行尾分隔符）。
  // **编辑仍然基于 text**，所以保存时不会把分隔符写进库里。
  const text = readingLineText(segment, span);
  line.dataset.baseText = text;
  const baseText = displayText == null ? text : displayText;
  if (mark) {
    line.dataset.level = mark.level;
    line.classList.add("is-diff");
  }
  // 就地编辑过的行：按修订三档渲染（只改显示，不改数据）
  const inline = readingInlineEdits.get(key);
  if (inline && inline.text !== inline.base) {
    paintInlineRevision(line, inline);
    return line;
  }
  if (draft) {
    line.classList.add("is-draft");
    line.textContent = draft.text != null ? draft.text : baseText;
    const chip = document.createElement("span");
    chip.className = "reading-chip";
    chip.textContent = draft.ack === "adopted" ? "草稿 · 已采用" : draft.ack === "kept" ? "草稿 · 保留" : "草稿";
    line.append(chip);
    return line;
  }
  if (mark && mark.ack === "kept") {
    line.classList.add("is-kept");
  }
  if (mark && mark.ack === "adopted") {
    line.classList.add("is-kept");
  }
  if (!mark || !readingEntryVisible(mark)) {
    line.textContent = baseText;
    return line;
  }
  // 红字：只包差异字符（汉字级实线 / 标点级虚线）
  const cacheKey = `${key}\u0000${baseText}\u0000${mark.candidate || ""}`;
  let charSpans = readingSpanCache.get(cacheKey);
  if (!charSpans) {
    charSpans = computeCharSpans(baseText, mark.candidate || "");
    readingSpanCache.set(cacheKey, charSpans);
  }
  if (!charSpans.length) {
    line.textContent = baseText;
    return line;
  }
  // 任务 81：**先把差异区间并成互不重叠的并集，再按顺序拼一次**。
  // 原来是在循环里"发现重叠就把文字追加给上一个 mark"，`cursor` 与追加区间一旦错位
  // 就会重复字符（实测 `laborefficient` 被显示成 `laboreefficient`）——
  // 这类"显示 ≠ 导出"已经被咬过四次，不能再靠逐次判断补丁。
  const ranges = [];
  for (const charSpan of charSpans) {
    // 英文扩到整词（引擎给的是词级框）；中文保持单字
    const range = expandToWordRange(baseText, charSpan.aStart, charSpan.aEnd);
    const last = ranges[ranges.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      last.word = last.word || range.word;
    } else {
      ranges.push({ start: range.start, end: range.end, word: range.word });
    }
  }

  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      line.append(document.createTextNode(baseText.slice(cursor, range.start)));
    }
    const markEl = document.createElement("mark");
    markEl.className =
      "reading-mark " +
      (mark.level === "differs_punct" ? "reading-mark--punct" : "reading-mark--chars") +
      (range.word ? " reading-mark--word" : "") +
      (mark.ack ? " is-acked" : "") +
      (key === readingPanelKey ? " is-current" : "");
    // 任务 81：**占位不许进 textContent**。空区间（原文这里没有字、候选那边有）
    // 只需要"这里有个插入位置"的视觉标记，不是字符；原来用 `|| " "` 塞了空格，
    // 右栏就比导出多一个空格（`lcc: :pp` vs `lcc::pp`）。
    const slice = baseText.slice(range.start, range.end);
    if (slice) {
      markEl.textContent = slice;
    } else {
      markEl.classList.add("reading-mark--insert");
      markEl.setAttribute("aria-label", "这里缺字（候选有、原文没有）");
    }
    markEl.dataset.key = key;
    markEl.title = range.word ? "英文按词标：这个词里有差异" : "";
    line.append(markEl);
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < baseText.length) {
    line.append(document.createTextNode(baseText.slice(cursor)));
  }
  return line;
}

/**
 * 「已审 / 总数」的唯一口径：库里已判 + 本次会话草稿（**全局，不按 marks 窗口**）。
 *
 * 旧实现只数当前窗口里的 `readingEntries`，换一次窗口之前的草稿就不算了——
 * QA 实测"20 次 Enter 后已审从 0 涨到 3 又跌回 0"，根因就是它。
 */
function readingProgressNumbers() {
  const counts = readingGlobalCounts;
  const draftKeys = new Set([...readingDrafts.keys(), ...readingInlineEdits.keys()]);
  if (!counts) {
    return { processed: draftKeys.size, total: readingEntries.length };
  }
  const total = Number(counts.chars_total || 0);
  const doneInDb = Math.max(0, total - Number(counts.chars_unacked || 0));
  return { processed: Math.min(total, doneInDb + draftKeys.size), total };
}

function renderReadingProgress() {
  // 任务 67：marks 只加载窗口，`readingEntries` 不再是全书 —— 进度数字必须用
  // 服务端给的全书计数，否则换一次窗口进度条就缩水一次（用户会以为审过的丢了）。
  const { processed, total } = readingProgressNumbers();
  const drafts = readingDrafts.size + readingInlineEdits.size;
  // 标点计数不在这里：角标文本由 `renderPunctGroupBadge()` 写 `reading-punct-count`，
  // 进度条只算"汉字差异条数"（`readingProgressNumbers()`，不含标点）。
  el("reading-progress-text").textContent = `已审 ${processed} / ${total} 条`;
  const fill = el("reading-progress-fill");
  fill.style.width = total ? `${Math.round((processed / total) * 100)}%` : "0%";
  fill.classList.toggle("is-done", total > 0 && processed >= total);
  const chip = el("reading-draft-chip");
  chip.hidden = drafts === 0;
  chip.textContent = `未提交 ${drafts}`;
  const submit = el("reading-submit");
  submit.disabled = drafts === 0;
  submit.textContent = drafts ? `提交 ${drafts} 处` : "提交 0 处";
  el("reading-submit").classList.toggle("is-ready", drafts > 0);
}


/**
 * 任务 82：选中一条差异 → **左侧 PDF 的这一行、右侧正文的这一行都落在视口垂直中央**。
 *
 * 用户原话："选中右边的差异后，左边的 PDF 高亮行的位置不定，建议点击差异修改，
 * 该行就直接跳到页面中间，保持统一的位置。" 这是肌肉记忆需求——每次同一位置，
 * 扫视时不用重新找。贴边（第一页 / 最后一页）夹住即可，不做二次补偿（会抖）。
 */
let readingSuppressFollowUntil = 0;


function readingLineNode(key) {
  const stream = el("reading-stream");
  return stream ? stream.querySelector(`.reading-line[data-key="${key}"]`) : null;
}


/**
 * 当前审校项的"两边同款"高亮（任务 61）。
 *
 * 用户原话：「左边 pdf 里应该把选中的行高亮出来，右边也高亮出对应的行（左右最好用同样的
 * 颜色和高亮方式，如方框框选）」。所以这里只做一件事：把 `readingPanelKey` 那一条
 * 在**文本流**和**页面上**都标成 `is-current`（琥珀实线框 + 浅底），其余差异维持弱化红。
 * 只改样式，不滚页、不动跟随。
 */
function refreshReadingCurrentHighlight() {
  for (const node of document.querySelectorAll("#reading-stream .reading-line.is-current")) {
    node.classList.remove("is-current");
  }
  for (const node of document.querySelectorAll("#reading-stream .reading-mark.is-current")) {
    node.classList.remove("is-current");
  }
  if (readingPanelKey) {
    const line = readingLineNode(readingPanelKey);
    if (line) {
      line.classList.add("is-current");
      for (const mark of line.querySelectorAll(".reading-mark")) mark.classList.add("is-current");
    }
  }
  for (const item of document.querySelectorAll("#reading-tree .reading-tree__item.is-current")) {
    if (item.dataset.key !== readingPanelKey) item.classList.remove("is-current");
  }
  if (readingPanelKey) {
    const item = document.querySelector(`#reading-tree .reading-tree__item[data-key="${readingPanelKey}"]`);
    if (item) item.classList.add("is-current");
  }
  // 页面上只有已加载块的页画过差异框：重画这些页 + 当前 key 所在页
  for (const pageNo of readingPageBlocks.keys()) paintReadingDiffBoxes(pageNo);
  if (readingPageNo) paintReadingDiffBoxes(readingPageNo);
}


/** 左树里"展开了的页"（条目级展开状态）。 */
const readingTreeOpen = new Set();


// ---------------------------------------------------------------- 阅读审校左栏：连续页列
//
// 任务 57。用户原话："左边目前是裸 PDF，应该显示版心和文本识别框。而且应该可以上下
// 滚动，而不是只有右边文字可以上下滚动，左边不能滚动。"
//
// 做法与目录确认 / 结果预览同一套：页块是空壳（先占住真实比例），图和块只给视口
// 附近 ±3 页挂上；版心 + 块框复用 `paintTileMargin` / `renderPageBlocks`。
// 跟随开着时右栏滚到哪一页、左边滚到哪一页；关掉后左边自己滚，互不打扰。

let readingTiles = new Map();
let readingPageBlocks = new Map();
let readingBlockPromises = new Map();
let readingLoadedImages = new Set();
let readingImageQueue = [];
let readingImagePumping = false;
let readingNearObserver = null;
let readingVisibleObserver = null;
let readingNearSet = new Set();
let readingVisibleSet = new Set();
let readingStackProject = null;
let readingTops = [];
let readingHoveredSeq = null;
let readingPdfScrollRaf = 0;

const READING_NEAR_MARGIN = 900;


/** 一页要的东西：图 + 块数据；两个都到齐才画框。 */
/**
 * 审校页取的档位（任务 78）。和目录确认一样，**宽度变了就得重算并重取**：
 * 左侧页列被拖宽 / 窗口变大 / 折叠左树之后，原来那张 `view` 图会被拉伸到新宽度上。
 */
let readingImageProfile = "";
let readingResizeObserver = null;


/** 跳转时没开出来的面板：挂起 key，等"块/行到达"再试，不靠定时器猜。 */
let readingPendingPanelKey = null;
let readingPendingPanelEntry = null;


/** 画一页的版心 + 块框（复用页面视图那套渲染，不另写）。 */
function paintReadingTile(pageNo) {
  const tile = readingTiles.get(pageNo);
  const page = readingPageRecord(pageNo);
  if (!tile || !page) return;
  paintTileMargin(tile, page);
  const blocks = readingPageBlocks.get(pageNo) || [];
  const overlay = tile.querySelector(".page-overlay");
  if (!overlay) return;
  if (pagesOverlayOn && blocks.length) {
    if (overlay._renderedBlocks !== blocks) renderPageBlocks(tile, blocks, { details: false });
    applyReadingLinked(pageNo);
  } else {
    clearPageBlocks(tile);
  }
  // 当前页：顺便把差异字 / 词画成色块（只画差异，相同字不画）
  if (pageNo === readingPageNo) paintReadingDiffBoxes(pageNo);
}

function readingPageRecord(pageNo) {
  if (!currentProject) return null;
  return currentProject.pages.find((item) => item.page_no === pageNo) || null;
}


/** 当前悬停段涉及的所有块 id（跨页段两页都算）。 */
function readingHoveredBlockIds() {
  const segment = readingHoveredSeq !== null
    ? (readingVisibleSegments() || []).find((item) => item.seq === readingHoveredSeq)
    : null;
  if (!segment) return null;
  return new Set((segment.line_spans || []).map((span) => span.block_id));
}

/** 给某一页的块框套上"联动"样式。 */
function applyReadingLinked(pageNo) {
  const ids = readingHoveredBlockIds();
  const tile = readingTiles.get(pageNo);
  if (!tile) return;
  for (const box of tile.querySelectorAll(".box[data-block-id]")) {
    box.classList.toggle("is-linked", Boolean(ids && ids.has(box.dataset.blockId)));
  }
}

/**
 * 字级色块（任务 59）：把这一段里每行的差异字画到左边页面上。
 *
 * - 有字框：按差异字 / 词画小色块（中文单字、英文整词）；
 * - 没有字框（老数据、回填失败）：退化成整行一个虚线框，不整页不标；
 * - 只画差异，同行的相同字一个都不画。
 */
const wordBoxMappingStats = { offset: 0, position: 0, positionMiss: 0, missSamples: [] };
window.__b2tWordBoxStats = wordBoxMappingStats;

function readingDiffUnits(lineText, candidate, wordBoxes) {
  const spans = computeCharSpans(lineText || "", candidate || "");
  if (!spans.length) return { ranges: [], kind: null };
  const kind = spans.some((span) => span.kind !== "replace") ? "punct" : "chars";
  if (!wordBoxes || !wordBoxes.length) return { ranges: null, kind };
  // 字框的文本拼起来应与行文本一致；按累加长度把差异区间映射到字框下标
  // 任务 86：两条分支，**中文走旧的偏移映射，英文走位置映射**。
  // 旧代码"拼接长度相等就按偏移画"看着土，但对中文是对的——先想清楚它为什么能工作，
  // 再决定哪条路给谁走（实测：中文逐字框拼接长度等于行文本长度）。
  const concatLength = wordBoxes.reduce((sum, unit) => sum + String(unit.text || "").length, 0);
  const starts = [];
  if (concatLength === (lineText || "").length) {
    // 分支 1：纯偏移（中文 / 无空格插入的场景），没有查找、不可能 miss
    let offset = 0;
    for (const unit of wordBoxes) {
      starts.push(offset);
      offset += String(unit.text || "").length;
    }
    wordBoxMappingStats.offset += 1;
  } else {
    // 分支 2：按位置找词（英文：词间空格不属于任何框），找不到就整行退化
    let cursor = 0;
    for (const unit of wordBoxes) {
      const word = String(unit.text || "");
      if (!word) {
        starts.push(cursor);
        continue;
      }
      const at = (lineText || "").indexOf(word, cursor);
      if (at < 0) {
        wordBoxMappingStats.positionMiss += 1;
        if (wordBoxMappingStats.missSamples.length < 3) {
          wordBoxMappingStats.missSamples.push(String(lineText || "").slice(0, 60));
        }
        return { ranges: null, kind };
      }
      starts.push(at);
      cursor = at + word.length;
    }
    wordBoxMappingStats.position += 1;
  }
  const wanted = new Set();
  for (const span of spans) {
    for (let index = 0; index < wordBoxes.length; index += 1) {
      const start = starts[index];
      const end = start + String(wordBoxes[index].text || "").length;
      if (end > span.aStart && start < span.aEnd) wanted.add(index);
    }
  }
  return { ranges: [...wanted].sort((a, b) => a - b), kind };
}

function paintReadingDiffBoxes(pageNo) {
  const layer = el("reading-diff-layer");
  const tile = readingTiles.get(pageNo);
  if (!layer) return;
  for (const node of layer.querySelectorAll(".reading-diff-box")) node.remove();
  if (!tile) return;
  const blocks = readingPageBlocks.get(pageNo) || [];
  if (!blocks.length) return;
  const width = tile.clientWidth || tile.getBoundingClientRect().width;
  const height = tile.clientHeight || tile.getBoundingClientRect().height;
  if (!width || !height) return;
  const top = tile.offsetTop;
  const addBox = (bbox, className) => {
    const node = document.createElement("div");
    node.className = "reading-diff-box" + (className ? " " + className : "");
    node.style.left = `${Math.round(bbox[0] * width)}px`;
    node.style.top = `${Math.round(top + bbox[1] * height)}px`;
    node.style.width = `${Math.max(2, Math.round((bbox[2] - bbox[0]) * width))}px`;
    node.style.height = `${Math.max(2, Math.round((bbox[3] - bbox[1]) * height))}px`;
    layer.append(node);
  };
  // 这一页上**所有可见的差异行**：只画差异字 / 词，相同字一个都不画
  for (const block of blocks) {
    if (!block.lines) continue;
    for (let index = 0; index < block.lines.length; index += 1) {
      const line = block.lines[index];
      const key = readingKey(block.block_id, index);
      const mark = readingMarks.get(key);
      if (!mark || !readingEntryVisible(mark)) continue;
      // 三态：当前审校项（琥珀实线框）/ 已审（淡绿）/ 其他未审（弱化红）
      const state = key === readingPanelKey ? " is-current" : mark.ack ? " is-acked" : "";
      const words = line.word_boxes ? JSON.parse(line.word_boxes) : [];
      const { ranges, kind } = readingDiffUnits(line.text || "", mark.candidate || "", words);
      // **行层常驻**（用户要求：一眼看到"这一行有差异"），字层画在它上面看"差在这几个字"。
      // 原来只有"拿不到字框"时才退化出一行，于是绝大多数行只有零散字块、没有行框。
      if (line.bbox) addBox(line.bbox, "reading-diff-box--line" + state);
      if (ranges === null) continue;
      for (const wordIndex of ranges) {
        const bbox = words[wordIndex] && words[wordIndex].bbox;
        if (bbox) addBox(bbox, (kind === "punct" ? "reading-diff-box--punct" : "") + state);
      }
    }
  }
}


let readingPageSyncTimer = 0;
let readingPageSyncFixing = false;

/**
 * P0（2026-10-28）：**左栏顶部可见的那一页必须等于顶部页码**。
 *
 * 用户截图里左 PDF 是第 40 页、顶部写第 50 页、右栏是第 50 页的内容——三者对不上，
 * 他就没法审。这条不变量以前没有任何地方检查：程序跳页、跟随、重画各走各的。
 * 这里在每次页码变化后一帧做一次核对，不一致就纠正一次，并把结果暴露在
 * `window.__b2tPageSync` 上供 QA 断言（{label, tilePage, ok}）。
 */
const readingPageSyncLog = [];


const readingNextLog = [];


// ---------------------------------------------------------------- 阅读审校三栏宽度（P1-4）
//
// 用户："左边的 pdf 图片太小，看不清楚，能不能左右窗口可以拖动？"
// 三栏 = 左树 / PDF / 正文。两条 6px 的手柄可拖，宽度记在 localStorage；
// 最小宽度卡住，别拖到正文没字、或 PDF 看不见；窄屏（<1120）不显示手柄（CSS 管）。

function boot() {
  // 任务 94 Slice 1：审校视图模块初始化（依赖由此注入，模块内部不直接碰这些全局）
  window.ReadingView?.init({
    el,
    getPageNo: () => readingPageNo,
    getProjectId: () => (currentProject ? currentProject.project_id : null),
    exit: () => showView("pages"),
    onPunctGroups: () => openPunctGroups(),
    onGarbledPanel: () => openGarbledPanel(),
    // 任务 94 Slice 2（第一笔）：readingReloadAfterBatch 搬进模块后要读写的审校状态 / 回调
    setReadingProject: (value) => { readingProject = value; },
    setReadingData: (value) => { readingData = value; },
    setMarks: (value) => { readingMarks = value; },
    renderPunctGroupBadge: () => renderPunctGroupBadge(),
    // 任务 94 Slice 2（第二笔）：setupReading 的依赖——只注入句柄与 getter/setter，不注入值
    getMarks: () => readingMarks,
    getPendingOn: () => readingPendingOn,
    setPendingOn: (value) => { readingPendingOn = value; },
    getMarkupLevel: () => readingMarkupLevel,
    setMarkupLevel: (value) => { readingMarkupLevel = value; },
    getInlineEdits: () => readingInlineEdits,
    getDrafts: () => readingDrafts,
    getReadingEditingKey: () => readingEditingKey,
    isReadingActive: () => currentView === "reading",
    renderReadingProgress: () => renderReadingProgress(),
    navigate: (name) => showView(name),
    openPageDetail: (pageNo) => openPageDetail(pageNo),
    // 任务 94 L2：10 个交互函数搬进模块后的状态句柄与回调（只注入句柄 / getter-setter，不注入值）
    getProject: () => currentProject,
    getReadingFollow: () => readingFollow,
    getReadingFirstUnackedPage: () => readingFirstUnackedPage,
    getReadingGlobalCounts: () => readingGlobalCounts,
    getReadingImageQueue: () => readingImageQueue,
    setReadingFollowFlag: (value) => { readingFollow = value; },
    setReadingUserMovedAt: (value) => { readingUserMovedAt = value; },
    getReadingUserScrollSeq: () => readingUserScrollSeq,
    setReadingUserScrollSeq: (value) => { readingUserScrollSeq = value; },
    setReadingEditingKey: (value) => { readingEditingKey = value; },
    setReadingFilterValue: (value) => { readingFilter = value; },
    getReadingHoveredSeq: () => readingHoveredSeq,
    setReadingHoveredSeq: (value) => { readingHoveredSeq = value; },
    getReadingPdfScrollRaf: () => readingPdfScrollRaf,
    setReadingPdfScrollRaf: (value) => { readingPdfScrollRaf = value; },
    getReadingScrollRaf: () => readingScrollRaf,
    setReadingScrollRaf: (value) => { readingScrollRaf = value; },
    getReadingJumpSettleKey: () => readingJumpSettleKey,
    setReadingJumpSettleKey: (value) => { readingJumpSettleKey = value; },
    getReadingJumpSettleTicks: () => readingJumpSettleTicks,
    setReadingJumpSettleTicks: (value) => { readingJumpSettleTicks = value; },
    getReadingPanelKey: () => readingPanelKey,
    setReadingPendingBox: (value) => { readingPendingBox = value; },
    readingVisibleSegments: () => readingVisibleSegments(),
    readingLineNode: (key) => readingLineNode(key),
    apiJson: (path, options) => apiJson(path, options),
    readingKey: (blockId, lineIndex) => readingKey(blockId, lineIndex),
    loadFinishSummary: (options) => loadFinishSummary(options),
    // 任务 94 L3：openReading / 行编辑辅助搬进模块后的状态句柄与回调
    getReadingProject: () => readingProject,
    getReadingData: () => readingData,
    getReadingOpenStartedAt: () => readingOpenStartedAt,
    setReadingOpenStartedAt: (value) => { readingOpenStartedAt = value; },
    getReadingAutoJumpDone: () => readingAutoJumpDone,
    setReadingAutoJumpDone: (value) => { readingAutoJumpDone = value; },
    getReadingEntries: () => readingEntries,
    setReadingEntries: (value) => { readingEntries = value; },
    setReadingMarksWindow: (value) => { readingMarksWindow = value; },
    setReadingGlobalCounts: (value) => { readingGlobalCounts = value; },
    getReadingPageCounts: () => readingPageCounts,
    setReadingPageCounts: (value) => { readingPageCounts = value; },
    setReadingFirstUnackedPage: (value) => { readingFirstUnackedPage = value; },
    setReadingTreeData: (value) => { readingTreeData = value; },
    getReadingRepaintPending: () => readingRepaintPending,
    setReadingRepaintPending: (value) => { readingRepaintPending = value; },
    getReadingUserMovedAt: () => readingUserMovedAt,
    getReadingTiles: () => readingTiles,
    getReadingPageBlocks: () => readingPageBlocks,
    refreshPunctGroups: () => refreshPunctGroups(),
    refreshGarbledLines: () => refreshGarbledLines(),
    setReviewOverlaysForReading: () => setReviewOverlaysForReading(),
    // 任务 94 L4：队列 / 草稿加载 / 视口处理搬进模块后的句柄
    setReadingInlineEdits: (value) => { readingInlineEdits = value; },
    setReadingDrafts: (value) => { readingDrafts = value; },
    getReadingTops: () => readingTops,
    setReadingTops: (value) => { readingTops = value; },
    getReadingCursorEntry: () => readingCursorEntry,
    setReadingCursorEntry: (value) => { readingCursorEntry = value; },
    showNoticeBar: (text) => showNoticeBar(text),
    readingDraftStorageKey: () => readingDraftStorageKey(),
    // 任务 94 L5：审校环搬进模块后的状态句柄（状态仍归 app.js，get+set 成对）
    getCurrentView: () => currentView,
    getReadingAppendScheduled: () => readingAppendScheduled,
    getReadingBlockPromises: () => readingBlockPromises,
    getReadingDrafts: () => readingDrafts,
    getReadingImageProfile: () => readingImageProfile,
    getReadingInlineEdits: () => readingInlineEdits,
    getReadingLoadedImages: () => readingLoadedImages,
    getReadingMarks: () => readingMarks,
    getReadingMarksInFlight: () => readingMarksInFlight,
    getReadingMarksRequestSeq: () => readingMarksRequestSeq,
    getReadingMarksWindow: () => readingMarksWindow,
    getReadingNearObserver: () => readingNearObserver,
    getReadingNearSet: () => readingNearSet,
    getReadingObserver: () => readingObserver,
    getReadingPageSyncFixing: () => readingPageSyncFixing,
    getReadingPageSyncLog: () => readingPageSyncLog,
    getReadingPageSyncTimer: () => readingPageSyncTimer,
    getReadingPendingBox: () => readingPendingBox,
    getReadingPendingPanelEntry: () => readingPendingPanelEntry,
    getReadingPendingPanelKey: () => readingPendingPanelKey,
    getReadingProgramScrollSeq: () => readingProgramScrollSeq,
    getReadingRendered: () => readingRendered,
    getReadingResizeObserver: () => readingResizeObserver,
    getReadingSegmentNodes: () => readingSegmentNodes,
    getReadingStackProject: () => readingStackProject,
    getReadingSuppressFollowUntil: () => readingSuppressFollowUntil,
    getReadingTreeData: () => readingTreeData,
    getReadingTreeOpen: () => readingTreeOpen,
    getReadingVisibleObserver: () => readingVisibleObserver,
    getReadingVisibleSet: () => readingVisibleSet,
    setReadingAppendScheduled: (value) => { readingAppendScheduled = value; },
    setReadingImageProfile: (value) => { readingImageProfile = value; },
    setReadingImageQueue: (value) => { readingImageQueue = value; },
    setReadingMarks: (value) => { readingMarks = value; },
    setReadingMarksInFlight: (value) => { readingMarksInFlight = value; },
    setReadingMarksRequestSeq: (value) => { readingMarksRequestSeq = value; return value; },
    setReadingNearObserver: (value) => { readingNearObserver = value; },
    setReadingObserver: (value) => { readingObserver = value; },
    setReadingPageNo: (value) => { readingPageNo = value; },
    setReadingPageSyncFixing: (value) => { readingPageSyncFixing = value; },
    setReadingPageSyncTimer: (value) => { readingPageSyncTimer = value; },
    setReadingPanelKey: (value) => { readingPanelKey = value; },
    setReadingRendered: (value) => { readingRendered = value; },
    setReadingResizeObserver: (value) => { readingResizeObserver = value; },
    setReadingSegmentNodes: (value) => { readingSegmentNodes = value; },
    setReadingStackProject: (value) => { readingStackProject = value; },
    setReadingVisibleObserver: (value) => { readingVisibleObserver = value; },
    // 任务 94 L5：审校环里仍留在 app.js 的叶子函数（模块经注入调用）
    exportOptions: (...args) => exportOptions(...args),
    loadIndexBlocks: (...args) => loadIndexBlocks(...args),
    pageProfileFor: (...args) => pageProfileFor(...args),
    paintReadingDiffBoxes: (...args) => paintReadingDiffBoxes(...args),
    paintReadingTile: (...args) => paintReadingTile(...args),
    punctReviewSet: (...args) => punctReviewSet(...args),
    refreshReadingCurrentHighlight: (...args) => refreshReadingCurrentHighlight(...args),
    // 任务 94 L5：模块要读的常量
    INDEX_IMAGE_WINDOW: INDEX_IMAGE_WINDOW,
    READING_CHUNK: READING_CHUNK,
    READING_NEAR_MARGIN: READING_NEAR_MARGIN,
    // L6 刀1：状态 getter
    getReadingImagePumping: () => readingImagePumping,
    // L6 刀1：状态 setter（有写点才给）
    setReadingImagePumping: (value) => { readingImagePumping = value; return value; },
    // L6 刀1：仍留在 app.js 的叶子函数
    clearImagePlaceholder: (...args) => clearImagePlaceholder(...args),
    clearPageBlocks: (...args) => clearPageBlocks(...args),
    clearTileMargin: (...args) => clearTileMargin(...args),
    pageImageUrl: (...args) => pageImageUrl(...args),
    // L6 刀2：仍留在 app.js 的叶子函数
    computeCharSpans: (...args) => computeCharSpans(...args),
    readingEntryVisible: (...args) => readingEntryVisible(...args),
    // L6 刀3：状态 getter
    getReadingNextLog: () => readingNextLog,
    getReadingProof: () => readingProof,
    getReadingSyncDriver: () => readingSyncDriver,
    getReadingSyncUntil: () => readingSyncUntil,
    // L6 刀3：状态 setter（有写点才给）
    setReadingProgramScrollSeq: (value) => { readingProgramScrollSeq = value; return value; },
    setReadingSuppressFollowUntil: (value) => { readingSuppressFollowUntil = value; return value; },
    setReadingSyncDriver: (value) => { readingSyncDriver = value; return value; },
    setReadingSyncUntil: (value) => { readingSyncUntil = value; return value; },
    // L6 刀3：仍留在 app.js 的叶子函数
    buildReadingLine: (...args) => buildReadingLine(...args),
    // L6 刀7：仍留在 app.js 的叶子函数
    // L6 刀8：状态 setter（有写点才给）
    setReadingPendingPanelEntry: (value) => { readingPendingPanelEntry = value; return value; },
    setReadingPendingPanelKey: (value) => { readingPendingPanelKey = value; return value; },
  });
  // Esc 清空选择（说明书 6.2 的选择方式之外的顺手约定）；对话框的 Esc 在 setupShell 里
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !openMasks().length && currentProject && selectedPages.size) {
      clearPageSelection();
      return;
    }
    if (!currentProject || document.body.dataset.view !== "pages" || openMasks().length) return;
    const active = document.activeElement || {};
    const inEditor =
      ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) || active.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !inEditor) {
      event.preventDefault();
      selectAllVisiblePages();
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
  setupReviewAutoPass();
  setupViewerTools();
  setupRecognitionSettings();
  setupPageNumberPanel();
  setupPageIndex();
  setupPreview();
  // 三栏拖动由 reading-view.js 的 init() 负责（任务 94），这里不再重复绑定
  setupPageMore();
  setupExportPanel();
  setupStructurePanel();
  showView("library");
  loadImageQuality();
  syncImageQualityUi();
  loadAppInfo();
  loadLibrary();
}

boot();
