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

/**
 * 刀 7：把错误写到**审校面板**的错误条（`#page-detail-error`）上——一个动作一个名字。
 *
 * `#page-detail-error` 属 `view-review`；review 还没有模块（刀 7 裁定不建，见
 * docs/refactor/pages/knife-review-plan.md 裁定一）⇒ 由外壳持有这个 id。
 * review 落模块时只换这个函数体（`window.ReviewView.showError(error)`），pages 侧的调用点不动。
 */
function showPageDetailError(error) {
  showError(el("page-detail-error"), error);
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

// 2026-11-04：`preview` 视图已整块删除（L-117）：`VIEWS` 里没有它、`#view-preview` 的 DOM 与
// `.preview-*` 样式也一并删了；`showView("preview")` 不再是合法视图（会直接 return）。
const VIEWS = ["library", "pages", "index", "review", "reading", "merge"];

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
/** 版心编辑的撤销栈（前端内存，最多 20 步）：拖动只写一次库，撤销也是写一次。 */
const marginUndoStack = [];

/** 任务 43：离开页面视图时停掉网格里在飞 / 排队的缩略图请求。
 *
 * 394 页的网格一次会排上百个 `size=thumb`；切到审校后它们还在后台渲染，
 * 一次按键要等几秒。图片清掉 src 后浏览器会取消排队中的请求，回来时
 * applyPageZoom() 会重新挂上（只加载视口附近的页）。
 */

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
    // 刀 9.4：只重读摘要、不报状态（能力的 text 省略就是这个含义，见模块头注释）
    window.PagesView?.onPageNumberChanged();
  } else if (name === "export" && !viewHydrated.export) {
    viewHydrated.export = true;
    await window.ExportPanel?.reload();
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
  // 任务 43：不在页面视图就把网格缩略图停掉，审校 / 预览不跟后台渲染抢 CPU。
  // 刀 9.1：这条与下面"进 pages 的准备"是**同一个入口**（视图切换通知）——
  // 别把两处合并到一处：合并会把 pages 的准备提前到 syncWorkflowSteps() / window.PageDetailDrawer?.closePageDetail() 之前，顺序就变了。
  if (target !== "pages" && currentProject) window.PagesView?.enter();
  // 换视图 = 当前步骤回落到该视图的默认步；用户点步骤条时才锁定。
  workflowStepPinned = false;
  syncWorkflowSteps();
  if (target !== "review") {
    closeTaskDrawer();
    // 刀 7 后补：`detailPageNo` 不许活过 review 视图。
    // 单向不变量：detailPageNo !== null ⇒ currentView === "review"（反向不要求：进 review 时
    // 先 showView("review") 再 window.PageDetailDrawer?.openPageDetail()，切过去那一瞬还是 null）。
    // 不清它的话，页面视图里点「识别」失败会把错误写进另一个视图里看不见的错误条
    // （真机实测：屏幕什么都不出现、四闸全绿）。「上次审校哪页」由 lastDetailPageNo 记着。
    window.PageDetailDrawer?.closePageDetail();
  }
  if (target === "pages" && currentProject) {
    // 这一视图的工作流角标 / 待处理页：进来才拉（骨架先显示，数字后到）
    queueAfterSteps(() => hydrateView("pages"));
    // 刀 9.1：回到页面视图时 pages 侧的进入准备（延迟语言汇总 / 同步页面设置 / 条件加载建议）
    // 全在模块的 enter() 里；本行位置不变，顺序与延迟性逐字保持。
    window.PagesView?.enter();
    // 回到页面视图时以数据库为准重拉一次：确认进度与类型不在前端缓存里说了算
    refreshPageStates();
    // 回到页面视图：瓷砖位置要重新量（在审校视图里它们全是 0），块框按需补画
    pageTileMetrics = null;
    window.PagesView?.onPagesNeedReflow();
    // 缩放是三步共用的：可能在目录确认步里改过，回来要按当前档位重排网格。
    applyPageZoom();
    // 任务 43：审校期间暂停的建议预取，回到页面视图再接着排。
    window.PagesView?.onPagesShown();
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
      window.PageDetailDrawer?.setReviewOverlay(false);
      window.PageDetailDrawer?.setReviewMargin(false);
    }
    window.ReviewTree?.ensureReviewTree();
  }
  if (target === "index" && currentProject) {
    // 任务 94 Slice I1：进目录确认只有一条路（§20.1）——模块内的 openPageIndex 由 enter 负责
    queueAfterSteps(() => hydrateView("index"));
    window.IndexView?.enter();
  }
  if (target === "merge" && currentProject) {
    // 任务 94 / §20.10：进合并视图只有一条路，数据由外壳设进 mergeState
    window.MergeView?.enter();
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
    // 插桩（只读）：没有项目就没有"步骤"，把当前步骤的计时收掉
    window.StepTiming?.leave();
    return;
  }
  if (!workflowStepPinned) workflowStep = autoWorkflowStep();
  if (currentProject.kind === "package" && workflowStep === "export") {
    workflowStep = "review";
  }
  // 插桩（只读，2026-10-29）：步骤进入/离开的唯一收敛点。
  // `syncWorkflowSteps` 每次导航与重画都会调，`StepTiming.enter` 对同一步幂等
  // （重绘不算用户时间）。目录/预览/合并没有独立步骤，时间归到当时的工作流步骤。
  window.StepTiming?.enter(workflowStep);
  nav.innerHTML = "";
  const isPackage = currentProject.kind === "package";
  const visible = WORKFLOW_STEPS.filter(
    (step) => !(isPackage && step.id === "export")
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
  window.PagesView?.onWorkflowStepChanged();
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

/**
 * 底栏开关按步显示：版心步只要「版心」，页面确认 / 文字识别只要「块框」。
 *
 * 开关本身按项目记住（`b2t.pagesMargin.v1.*`），但**显示**跟着步骤走：
 * 不是版心步就把压暗关掉，免得把版心框叠在页面确认的网格上（这一步没有这个开关可关）。
 */

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

/** 主按钮「全局识别 / 重新识别」的计划与确认窗在这之后搬进了 pages-view（2026-11-05）。 */
/**
 * 版心还差哪些页、为什么差。
 *
 * 这里只说**事实**（没有可用的正文行 → 拟合不出来），不说"下一步去识别"这类
 * 跟着步骤顺序变的话：检测入口在右上角「⋯ → 检测版面…」，不占这一步的主位。
 */

/** 「⋯」里的检测入口：名字里带上还差多少页，点开先看计划再决定跑不跑。 */


// ---------------------------------------------------------------- 第二引擎：可选，不挡流程
//
// 任务 58：完成判定只看主引擎；第二引擎是给审校的定位信号。进审校前如果它还没跑完，
// 要说清楚"队列还会变"，并给一个"等它跑完再进"的入口。

/** 这一轮已经选了"先开始审校"就不再拦（第二引擎跑完 / 切项目时重置）。 */
let auxWarningSkipped = false;

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

// ---------------------------------------------------------------- 字框回填（任务 59）
//
// 只补 block_line.word_boxes：文本 / 第二引擎 / 分歧裁决 / 跨页延续 / 版心都不动。
// 分批同步调用（每批 2 页，约 9 秒）；关掉对话框 = 停在当前批，再点就从没字框的行继续。

// 字框回填：已搬进 word-boxes.js（window.WordBoxes，root = #word-boxes-mask）。


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
      window.PageDetailEditor?.openAuxWarning();
      return;
    }
    enterReviewStep();
  } else if (id === "index") {
    // 目录确认是单页预览：没手动改过缩放时给 100%（与页面视图的"单页"同一档）。
    if (!window.PageMedia?.getPageZoomTouched() && window.PageMedia?.getPageZoomIndex() < 3) window.PageMedia?.setPageZoomIndex(3);
    showView("index");
  } else {
    showView("pages");
    savePosition("pages", lastDetailPageNo);
  }
  // showView 会先把当前步回落到视图默认值；点步骤的意图在它之后锁定。
  workflowStep = id;
  workflowStepPinned = true;
  // 进「版心确认」时给一个整页档（网格缩略图看不清四边，也不方便拖）；
  // 用户自己动过缩放就一律不动——切步骤不能把缩放跳回去。
  if (!window.PageMedia?.getPageZoomTouched() && id === "margin" && window.PageMedia?.getPageZoomIndex() === 0) {
    window.PageMedia?.setPageZoomIndex(3);
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
  await window.ExportPanel?.reload();
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
  if (id === "structure-panel") window.StructureTools?.reset();
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
  // 刀 6：stats-open / selection-review-open 的接线搬进 pages-view.js 的 wirePagesShellEntries()
  el("stats-close").addEventListener("click", () => closeModal("stats-panel"));
  el("structure-open").addEventListener("click", () => openModal("structure-panel"));
  el("structure-close").addEventListener("click", () => closeModal("structure-panel"));
  el("structure-cancel").addEventListener("click", () => closeModal("structure-panel"));

  el("export-close").addEventListener("click", () => closeModal("export-panel"));
  el("export-cancel").addEventListener("click", () => closeModal("export-panel"));
  el("package-result-close").addEventListener("click", () => closeModal("package-result"));
  el("package-open").addEventListener("click", () => openModal("package-result"));
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

/**
 * 刀 6：统计面板的**具名能力**（pages-view.js 的「统计」入口经注入调用）。
 *
 * 为什么不是把两行搬进模块：`stats-panel` 是全局 chrome id，模块碰它就是跨视图引用；
 * 把 id 换成参数（`chrome.toggle("stats-panel")` 式）更坏——意图会变成参数。
 */
function openStatsPanel() {
  openModal("stats-panel");
  window.QualityStats?.load();
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
    window.PageMedia?.applyRenderProfiles(info.render_profiles);
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

// ---------------------------------------------------------------- 结构工具（页眉 / 页脚 / 页码）

// 刀 D：结构工具（页眉 / 页脚 / 页码）的 7 个函数与预览候选状态已整体搬进
// `structure-tools.js`（window.StructureTools）。本文件只剩三处外壳接缝：
// `el("structure-panel")` 作为 root 交给模块、`closeModal` 收起临时状态、boot 调 setup()。




/** 收集导出面板上的选项（说明书 6.6 的每一项都在这里）。 */
/** 一句话说清"按现在这些勾选，到底要导出什么"。 */

/** 取某一页的块（带缓存），并把它渲染成对照用的底图。 */
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






// ---------------------------------------------------------------- 项目删除 / 废纸篓（任务 35）


// ---------------------------------------------------------------- 项目锁冲突（任务 60）
//
// 用户 2026-10-27 在删除项目时看到"该项目正被另一台电脑使用：<本机的旧主机名>"，
// 而那台"电脑"就是本机改了名、锁是应用被强杀后留下的死锁。所以这里不再只说"被占用"：
//
//   来源 —— 本机 / 本机以前的名字 / 另一台电脑
//   时间 —— 最后一次心跳（多久以前）
//   状态 —— 进程已不存在（锁已过期） / 进程还在写
//
// 过期 → 可以强制删除（或强制打开）；真占用 → 不给强制，先说清要先关掉谁。

// 锁冲突 / 废纸篓 / 项目备份：已搬进 recovery-panels.js（window.RecoveryPanels，三个 mask 三个根）。

/** "上次位置"的人话：审校 · 第 87 页（印 71）（说明书 7.2）。 */
const LAST_VIEW_LABELS = {
  library: "项目库",
  pages: "页面视图",
  review: "审校",
  structure: "结构工具",
  export: "导出",
};








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
  // **换项目必须清选择**：prune 只按 page_no 比，两个项目的页号会重号，
  // 不清就会把项目 A 的「第 2、5 页」带成项目 B 的选中页（假选择比丢选择更糟）。
  const switchedProject = Boolean(currentProject) && currentProject.project_id !== projectId;
  currentProject = { ...data.project, pages: data.pages, read_only: false };
  if (switchedProject) {
    selectedPages.clear();
    selectionAnchor = null;
  }
  // **保留选择**（2026-10-30，QA 实测：刷新项目会清掉用户刚选的页）：
  // 页面对象是重建的，所以按 page_no 重新映射，只丢弃已不存在的页——
  // 既不让旧对象残留，也不把用户的选择当垃圾扔掉。
  const alivePageNos = new Set((data.pages || []).map((item) => item.page_no));
  if (!switchedProject) {
    for (const pageNo of [...selectedPages]) {
      if (!alivePageNos.has(pageNo)) selectedPages.delete(pageNo);
    }
    if (selectionAnchor !== null && !alivePageNos.has(selectionAnchor)) selectionAnchor = null;
  }
  window.PageDetailDrawer?.closePageDetail();
  // 换项目 = 结构工具的预览候选作废（状态在 structure-tools.js 里）
  window.StructureTools?.reset();
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
  queueAfterSteps(() => window.QualityStats?.load());
  // 步骤条需要收尾面板与导出记录；这里补一次，避免只在页面视图里才加载
  await loadFinishSummary({ silent: true });
  syncWorkflowSteps();
  // 审校包项目（助手端）：横幅、隐藏不该有的功能、显示"导出审校结果"。
  // `structure-open`（#export-panel 子树）与 `finish-open-review`（#view-review 子树）不归协作模块、
  // 也不注入给它 ⇒ 动作只回答"是不是包模式"，这两个节点的显隐由拥有它们的外壳写。
  const packageMode = await window.Collab?.applyPackageMode();
  if (packageMode && packageMode.ok) {
    el("structure-open").hidden = Boolean(packageMode.packageMode);
    el("finish-open-review").hidden = Boolean(packageMode.packageMode);
  }
}

// ---------------------------------------------------------------- 项目头与项目信息（质量统计已迁到 quality-stats.js）

function renderProject() {
  const project = currentProject;
  if (!project) return;

  el("project-title").textContent = `《${project.name}》`;
  el("package-chip").hidden = project.kind !== "package";
  renderProjectMeta();
  window.PagesView?.onPageListChanged();
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
/**
 * 一页实际生效的版心（与后端 `effective_margin_box` 同一口径）：
 * `none` → 无；`custom` → 本页；`auto` → **本页落库的框**（没有就是未定，
 * 绝不拿项目默认框顶替，任务 33）；`inherit` → 项目默认。
 */
/** auto 页的框是哪来的：fit（迭代拟合）/ bbox（本页包围盒兜底）/ 未定。 */
/** 审校视图的版心开关也按项目记住；默认开（任务 53：自动算出来就该直接显示）。 */
/** 块的几何中心（与导出 `block_center` 同口径）；没有框返回 null。 */
/**
 * 块的中心点是否在版心内（任务 53 的审校过滤）。
 *
 * 与导出第一层**同一规则**：看中心点，不看"框完全包含"；没有 bbox 的块按版心内处理
 * （宁可多审一块，也不把文字藏起来）；没有生效版心时全部算"版心内"（不隐藏任何块）。
 */
/**
 * 任务 34：这一块是否计入审校口径（默认只审版心内）。
 * 后端页详情已经按同一函数算好 `margin_inside`；老响应没有这个字段时退回本地判断。
 */
/** 一页的块按版心内外分组（保持原有顺序；没有版心时全是"内"）。 */
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


/** 把当前项目设置画进识别设置控件；不可用的引擎置灰并说明原因。 */
function renderRecognitionSettings() { return window.PagesView.renderRecognitionSettings.apply(window.PagesView, arguments); }

/** 改一项识别设置：先写服务端，成功再更新本地；失败回显原值。 */

function setupRecognitionSettings() {
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

// ---------------------------------------------------------------- 块类型建议（只读）
//
// 接口只返回"建议类型 ≠ 当前类型"的块（`GET .../pages/{no}/block-suggestions`），
// 不写库、不改块类型。审校视图的块头徽章与页面视图的角标共用这份按页缓存：
// 只给**算过的页**显示，采用 / 改类型 / 识别完成后丢掉缓存重算。
// 它和"未审"是两回事：建议不进待办计数，只有点了「采用」才会改块类型。

const pageSuggestionCache = new Map(); // page_no → {suggestions, note}
const pageSuggestionOrder = [];
const pageSuggestionFailed = new Set();
const PAGE_SUGGESTION_CACHE_LIMIT = 200;

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

let setupSuggestions = [];

let setupSuggestionsLoaded = false;


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


function selectionPages() {
  return currentProject.pages.filter((page) => selectedPages.has(page.page_no));
}

// ---------------------------------------------------------------- 页面网格
//
// 瓦片生产（buildTile / applyTileState）与块缓存（pageBlockKey / remember / forget）
// 已搬进 page-grid.js（片 3a）。生产侧契约写在该文件头，消费侧在 margin-data.js 的头注释。

// ---------------------------------------------------------------- 页面确认（说明书 6.2）


let panelAccordionProject = null;

/** 右栏手风琴：一次只开一个；折叠状态按项目记，默认落在第一个未完成的分区。 */

/** 打开确认界面：先回数据库拉一次页面，保证看到的进度不是前端缓存。 */
async function openPageSetup() { return window.PagesView.openPageSetup.apply(window.PagesView, arguments); }


/**
 * 页面类型常驻列表：当前类型高亮 + "当前"文字，建议类型加淡色圆点。
 * 颜色只是辅助，文字标签始终在。
 */

/** 建议区：只在选中页有建议时出现，条目就是"建议 vs 当前"的具体差别。 */




function confirmAllUnconfirmed() { return window.PagesView.confirmAllUnconfirmed.apply(window.PagesView, arguments); }

// ---------------------------------------------------------------- 页面视图缩放与块框
//
// 缩放档位 / 图档选择 / 宽度测量已搬进 page-media.js（片 3b）。外壳只留
// `applyPageZoom()` 这层转发与页面视图自己的控件接线。

// 瓷砖在滚动内容里的位置：渲染 / 缩放时缓存一次，滚动时不再每帧量 267 个矩形。
let pageTileMetrics = null;

function applyPageZoom() { return window.PagesView.applyPageZoom.apply(window.PagesView, arguments); }

function togglePageBlocksOverlay() { return window.PagesView.togglePageBlocksOverlay.apply(window.PagesView, arguments); }


/** 排队画一页的块框：已画过且缓存没变就跳过。 */


/**
 * 每帧最多真正画 3 页：网格档一屏可能有十几页、每页几十个块，
 * 一次全画会卡；按页缓存 + 在途请求上限 3，滚过去的页立刻清。
 */



// ---------------------------------------------------------------- 版心视图
//
// 用户的设计（2026-10-23）：大多数书的正文都在版心里，页眉 / 页脚 / 页码在版心外。
// 所以先确认"正文在哪一块"，比每页改二三十个块省力。
// 这一刀只做**看得见、调得动**：版心不影响组装 / 导出 / 识别 / 块类型。

const MARGIN_MODE_LABELS = {
  auto: "自动拟合", inherit: "沿用默认", custom: "本页自定义", none: "不适用",
};

let marginSuggestion = null;
let marginAuditPage = null;
let marginAuditLoading = false;

/** 画一页的版心框；没有生效版心（不适用 / 未设置）就收起来。 */
function toggleMarginView() { return window.PagesView.toggleMarginView.apply(window.PagesView, arguments); }

/** 把接口返回的一页合并进本地列表（保留识别状态 / 审校进度等派生字段）。 */
/** 全局版心变了：只重画可见页（267 页全扫一遍没必要，可见性循环会兜底）。 */

let marginStatusTimer = null;


/**
 * 拖动保存（任务 36B）：松手才写一次库，**一律标 `mode=custom`**。
 *
 * 为什么自动页拖过也要变 custom：用户在自动框上调了四边，这个结果必须在下一次
 * 「自动拟合」时保住；只要 mode 还是 auto，重拟合就会把它冲掉。
 * 撤销走内存里的 `marginUndoStack`（一次拖动 = 一步）。
 */

// ---------------------------------------------------------------- 版心右栏

/** 时间戳 → "10-23 08:04"（本地时区）；解析不了就原样显示。 */
/** 全局版心的来源说明（自动推算 / 手动设置），显示在右栏。 */
/** 默认版心的来源说明（只给显式「沿用默认」的页看，一行就够）。 */
/**
 * 版心未定的依据说明：**这一页到底有没有行**，说清楚。
 * 两处（面板首屏 / 审计回包）共用一句，免得后到的审计把首屏的实话盖回去。
 */
/**
 * 版心右栏（任务 36B 重写）。
 *
 * 只回答三件事：这一页现在的框是什么、怎么改回去、撤销。
 * 没有模式选择卡片，也没有折叠的「检测」按钮；进这一步时未定的页会自动拟合。
 */

// ---------------------------------------------------------------- 版面块（页面确认步）
//
// 任务 36B：块类型建议与「确认本页版面」属于第 1 步（这页算不算正文、哪些块算正文），
// 以前混在审校视图里；现在页面确认步直接看得到，不用先切到版心或审校。
// 建议仍然**只读**：点「采用」才写 `block_type`（走正常块编辑接口，可撤销）。

let layoutBlockPage = null;

let layoutBlockPayload = null;

function layoutBlockPageRecord() {
  if (!currentProject) return null;
  const selected = selectionPages();
  return selected.length === 1 ? selected[0] : null;
}



function highConfidenceCount(suggestions) {
  return (suggestions || []).filter((item) => item.confidence === "high").length;
}


// ---------------------------------------------------------------- 文字识别（只读状态）
//
// 任务 36B：这一步只给数字（识别 / 第二引擎 / 差异），不在右栏做差异裁决；
// 裁决在「正文审校」。识别设置保留在下面折叠，否则引擎 / DPI 没有入口。


/**
 * 识别步的"一句话 + 一个数字 + 一个主按钮"（任务 56 / 刀 2）。
 *
 * 数字看正文页：已识别 / 正文页数。识别**不读版心**，所以这一步先跑完，
 * 版心那一步才有行框可用；这句话只说事实，不写"下一步去…"。
 */

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

/** 全部改为每页自动拟合：inherit / auto 参与，custom / none 不动。 */
/** 把一页的自定义版心写进项目默认，并把这一页改回「沿用默认」。 */
// ---------------------------------------------------------------- 页码设置（任务 55）
//
// 用户 2026-10-23：大多数页码坐标稳定，不该逐页确认——聚出位置模板 → 确认一次 →
// 全书自动填充 → 只把异常页推给人。这一刀不做逐页手动改映射，也不接导出。

let pageNumberAnalysis = null;
let pageNumberStatusTimer = null;


/** 右栏摘要：已采用的模板与已填页数（小接口，不跑聚类）。 */


// ---------------------------------------------------------------- 页码面板（任务 15 / 22 / 39）
//
// 已搬进 `page-number-panel.js`（`window.PageNumberPanel`）：两个根（#page-number-panel /
// #page-number-review-panel）+ 19 个函数，4 个导出；6 处写盘都在模块内闭环。
// `pageNumberAnalysis` 留壳（PagesView 经 getPageNumberAnalysis 读），模块走访问器不复制。


/**
 * 顶部那行统计：任务进行中它每分钟都要变，所以单独成一个函数，
 * 轮询的就地刷新（syncPageStates）也能更新，不必为了一个数字重建整格。
 */


/**
 * 任务轮询时用：只更新已有瓷砖的状态，不重建 DOM。
 *
 * 一本 400 页的书如果每 0.9 秒重建 400 个瓷砖，浏览器的滚动与图片都会被反复折腾；
 * 而任务进行时变的基本只有状态徽章。页面集合变了（筛选 / 增删页）才整格重建。
 */

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
  succeeded_with_skips: "完成（有跳过）",
  interrupted: "已中断",
};

/** 任务类型（说明书 5.3 的 job_type）：识别与第二引擎复核共用一套任务机制。 */
const JOB_TYPE_LABELS = {
  ocr: "识别",
  auxiliary: "第二引擎复核",
  layout: "版面检测",
};

// 发起中：从「点击」到 `startTaskPolling(job_id)` 之间按钮必须是禁用的。
// 真风险：这窗口里 taskJobId 还是 null，再点一次会在后端建出**第二个 job**。
let jobStartPending = false;
const JOB_START_BUTTONS = ["rec-start-all", "selection-check", "check-pending"];

function setJobStartBusy(busy) {
  for (const id of JOB_START_BUTTONS) {
    const node = el(id);
    if (!node) continue;
    node.disabled = busy;
    if (!busy) continue;
    if (!node.dataset.restoreText) node.dataset.restoreText = node.textContent || "";
    node.textContent = "发起中…";
  }
  if (!busy) {
    for (const id of JOB_START_BUTTONS) {
      const node = el(id);
      // 用 in 判断：原文案可能是空串，`if (dataset.restoreText)` 会把它当成"没存过"
      if (node && "restoreText" in node.dataset) {
        node.textContent = node.dataset.restoreText;
        delete node.dataset.restoreText;
      }
    }
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
async function checkSelection() { return window.PagesView.checkSelection.apply(window.PagesView, arguments); }

/** 重新拉一次页面列表（任务跑完、页面状态大面积变化时用）。 */

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

// ---------------------------------------------------------------- 通用确认框（规格 docs/ux/confirm-dialog-spec.md）
// 规则：固定 8 个槽位、只用 textContent 写（**禁止 innerHTML="" 重建**：那会连带清掉宿主层监听）。
// 返回值：安全键 → "safe"；危险键 → "danger"；Esc / 点遮罩 → null。
// 单键形态（不传 dangerText）禁止承载危险动作。
let confirmPending = null;

function confirmAction({ title, lead, list = [], detail = "", safeText, dangerText = "" }) {
  const mask = el("confirm-dialog-mask");
  if (!mask) return Promise.resolve(null);
  if (confirmPending) { confirmPending.close(null); }   // 单实例：连续触发不叠加

  el("confirm-dialog-title").textContent = title;
  el("confirm-dialog-lead").textContent = lead;
  const listNode = el("confirm-dialog-list");
  listNode.replaceChildren();
  for (const item of list) {
    const li = document.createElement("li");
    li.textContent = item;
    listNode.append(li);
  }
  listNode.hidden = list.length === 0;

  const toggle = el("confirm-dialog-detail-toggle");
  const detailNode = el("confirm-dialog-detail");
  detailNode.textContent = detail || "";
  detailNode.hidden = true;
  toggle.hidden = !detail;
  toggle.textContent = "详情";
  toggle.onclick = () => { detailNode.hidden = !detailNode.hidden; };

  const safe = el("confirm-dialog-safe");
  const danger = el("confirm-dialog-danger");
  safe.textContent = safeText;
  danger.hidden = !dangerText;
  danger.textContent = dangerText || "";
  danger.disabled = false;
  // 危险键：不默认聚焦（下面聚焦安全键）+ 不响应 Enter
  danger.onkeydown = (event) => { if (event.key === "Enter") event.preventDefault(); };

  mask.hidden = false;
  safe.focus();

  return new Promise((resolve) => {
    const close = (result) => {
      mask.hidden = true;
      safe.onclick = null;
      danger.onclick = null;
      mask.onclick = null;
      document.removeEventListener("keydown", onKey);
      confirmPending = null;
      resolve(result);
    };
    confirmPending = { close };
    const onKey = (event) => { if (event.key === "Escape") close(null); };
    safe.onclick = () => close("safe");
    danger.onclick = () => {
      danger.disabled = true;          // 防双击
      danger.textContent = "正在开始…";
      close("danger");
    };
    mask.onclick = (event) => { if (event.target === mask) close(null); };
    document.addEventListener("keydown", onKey);
  });
}

function closeTaskDrawer() {
  el("task-drawer").hidden = true;
}

/** 任务胶囊：宽屏「识别中 45/490 · 9.2%  ⏸ ✕」，窄屏「识别 45/490  ⏸ ✕」。 */
const CHIP_COMPACT_BREAKPOINT = 900;   // < 900px 切成紧凑形态
const CHIP_AUTO_HIDE_MS = 30000;       // 取消 / 失败的短痕迹留 30s

let lastChipInput = null;
let chipAutoHideTimer = null;
let chipResizeBound = false;
// 痕迹只由**状态跃迁**触发一次（真事故：轮询每轮把 cancelled 当新事件重画 → 计时器被无限续期，
// 取消后 33 秒仍在，重载页面还再冒出来一次）。
const chipActiveSeen = new Set();   // 本会话里「见过它活跃」的 job_id
const chipTraceKeys = new Set();    // 已经展示过的 `job_id:status`（同一跃迁不重复画）

function chipIsCompact() {
  return (typeof window !== "undefined" ? window.innerWidth : 0) < CHIP_COMPACT_BREAKPOINT;
}

/**
 * 百分比**一律由 done/total 现算**，不读 `job.percent`。
 * 真实事故：45/490 时 `job.percent` 是 6.7（后端按别的口径算的），分数却显示 45/490=9.2%——
 * 两个数在同一行里打架。同源之后这种矛盾在结构上不可能出现。
 */
function taskProgressPercent(job) {
  const total = Number(job && job.total) || 0;
  const done =
    (Number(job && job.done) || 0) +
    (Number(job && job.failed) || 0) +
    (Number(job && job.skipped) || 0);   // 跳过也算处理完：3 跳过 + 7 成功 / total 10 = 100%
  if (total <= 0) return 0;
  return Math.round((done / total) * 1000) / 10;
}

/** 动作名跟**任务**走，不跟视图变：识别（OCR）/ 检测（版面）/ 拟合（版面准备）/ 复核（第二引擎）。 */
function taskProgressVerb(job) {
  const type = job && job.job_type;
  if (type === "layout") {
    return job.params && job.params.mode === "prepare" ? "拟合" : "检测";
  }
  if (type === "auxiliary") return "复核";
  return "识别";
}

/**
 * 纯函数：胶囊文本。宽屏带 %、窄屏不带 %；两者用同一份 done/total。
 *
 * 三条退化口径（Chief 2026-10-30）——原则是**百分比必须能由屏幕上的分数推出来**：
 *   · total <= 0（还没拿到计划）→「识别中…」：0/0 是假分数，会让人以为完成了 0 页
 *   · done > total（范围中途变小）→「识别 495/490」：只给分数，不给 101.0% 这种自相矛盾的数
 *   · 0 < done <= total →「识别中 45/490 · 9.2%」
 */
function taskProgressText(job, data, options = {}) {
  const compact = options.compact === true;
  const verb = taskProgressVerb(job);
  const total = Number(job && job.total) || 0;
  const done =
    (Number(job && job.done) || 0) +
    (Number(job && job.failed) || 0) +
    (Number(job && job.skipped) || 0);
  if (total <= 0) return compact ? `${verb}…` : `${verb}中…`;
  const score = `${done}/${total}`;
  if (done > total) return `${verb} ${score}`;          // 溢出：不给百分比
  if (compact) return `${verb} ${score}`;
  return `${verb}中 ${score} · ${taskProgressPercent(job).toFixed(1)}%`;
}

/** 溢出时给 title 补一句原因（想让用户查得到「为什么没有百分比」）。 */
function taskProgressTitle(job, base) {
  const total = Number(job && job.total) || 0;
  const done = (Number(job && job.done) || 0) + (Number(job && job.failed) || 0);
  return total > 0 && done > total
    ? `${base} · 已完成页数超过计划页数（范围刚变过）`
    : base;
}

function taskChipClass(status) {
  if (status === "failed" || status === "interrupted" || status === "cancelled") return "tpill is-failed";
  if (status && status !== "succeeded") return "tpill is-active";
  return "tpill";
}

/** 空闲胶囊：就是入口本身（两个字，无数字、无进度、无 %）。**不隐藏**。 */
function paintIdleChip(title = "任务：点开看任务列表") {
  const chip = el("task-chip");
  if (!chip) return;
  lastChipInput = null;
  chip.hidden = false;
  chip.className = "tpill";
  chip.title = title;
  chip.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = "tpill__dot tpill__dot--idle";
  const label = document.createElement("span");
  label.className = "tpill__label";
  label.textContent = "任务";
  chip.append(dot, label);
}

/** 取消 / 失败后的短痕迹：留 30s，然后**回落成「任务」**（不是消失——入口必须常驻）。 */
function armChipAutoHide(ms = CHIP_AUTO_HIDE_MS) {
  clearTimeout(chipAutoHideTimer);
  chipAutoHideTimer = setTimeout(() => {
    paintIdleChip();
  }, ms);
}

function clearChipAutoHide() {
  clearTimeout(chipAutoHideTimer);
  chipAutoHideTimer = null;
}

/** 顶栏的任务胶囊：圆点 + 文本 +（进行中时）暂停/继续 + 取消。**同一个元素只有一个写者**。 */
function paintTaskChip(input) {
  const chip = el("task-chip");
  if (!chip) return;
  lastChipInput = input;
  const compact = chipIsCompact();
  const text = compact ? input.textCompact || input.text : input.text;
  chip.hidden = false;
  chip.className = taskChipClass(input.status);
  chip.title = input.title || text;
  chip.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = "tpill__dot";
  const label = document.createElement("span");
  label.className = "tpill__label";
  label.textContent = text;
  chip.append(dot, label);

  const job = input.job;
  const active = job && ["queued", "running", "paused"].includes(job.status);
  if (active && job.job_id) chipActiveSeen.add(job.job_id);
  if (active) {
    const paused = job.status === "paused";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tpill__ctl";
    toggle.textContent = paused ? "▶" : "⏸";
    toggle.title = paused ? "继续" : "暂停";
    toggle.setAttribute("aria-label", paused ? "继续任务" : "暂停任务");
    toggle.dataset.state = paused ? "resume" : "pause";
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      controlJob(paused ? "resume" : "pause");
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "tpill__ctl";
    cancel.textContent = "✕";
    cancel.title = "取消任务";
    cancel.setAttribute("aria-label", "取消任务");
    cancel.addEventListener("click", (event) => {
      event.stopPropagation();
      controlJob("cancel");
    });
    chip.append(toggle, cancel);
  }

  // 痕迹态（取消 / 失败 / 中断）也要能自己关掉：只给一个 ✕，别逼用户等 30 秒
  const terminal = ["cancelled", "failed", "interrupted"].includes(input.status);
  if (terminal) {
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "tpill__ctl";
    dismiss.textContent = "✕";
    dismiss.title = "关闭提示";
    dismiss.setAttribute("aria-label", "关闭提示");
    dismiss.dataset.state = "dismiss";
    dismiss.addEventListener("click", (event) => {
      event.stopPropagation();          // 别顺带把抽屉打开
      clearChipAutoHide();
      paintIdleChip();                  // 立刻回落成「任务」（入口常驻，不隐藏）
    });
    chip.append(dismiss);
  }

  // 切窄/切宽那一刻立刻重绘（不等 0.9s 轮询）
  if (!chipResizeBound) {
    chipResizeBound = true;
    window.addEventListener("resize", () => {
      if (lastChipInput) paintTaskChip(lastChipInput);
    });
  }
}

/** 拉任务列表：有正在跑的就盯住它，否则只显示最近任务。 */
async function loadTasks({ openDrawer = false } = {}) {
  if (!currentProject) return;
  let data;
  try {
    data = await apiJson(`/api/projects/${currentProject.project_id}/jobs?limit=8`);
  } catch (error) {
    // 任务列表读不到不该影响主流程；但胶囊是入口，不能因为一次接口失败就消失
    if (currentProject && !chipAutoHideTimer) paintIdleChip();
    return;
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
  // 检测 / 复核任务在版心分区与识别步里也留一行进度（"做了多少 / 还要多久"），别让人只盯着抽屉
  window.PagesView?.onTaskProgress(data);

  if (!["queued", "running", "paused"].includes(data.job.status)) {
    stopTaskPolling();
    // 刀 9.3：任务结束这一刻判定文字要立刻离开"检测中"——onTaskFinished 里的
    // renderMarginStepVerdict 经 marginStepVerdict(:679) 读 layoutDetectActive，晚一步就会画成"正在检测版面…"。
    layoutDetectActive = false;
    // 版面检测不产生块：只刷新页面状态与工作流角标，不走识别那套"重载块"。
    if (data.job.job_type === "layout") {
      await refreshPageStates();
      await loadWorkflow();
      // 任务 59：检测收尾会自动用检测行推算一次版心，读回来让框 / 建议立刻出现
      await window.MarginData?.refreshMarginState();
      // 刀 9.3：版心读回之后一次收尾——重画 tiles / panel / 条件拟合（ensureMarginFitted 会
      // POST fit-all 写盘，必须紧跟读回，不能挪到 loadTasks 之后），并给出检测结论。
      window.PagesView?.onTaskFinished(data);
      if (currentView === "pages") window.PagesView?.onPageStatesRefreshed();
      await loadTasks();
      if (announceTaskFailure(data.job)) {
        renderTask(data);
        openTaskDrawer();
      }
      return;
    }
    // 收尾：最后一个框也是"刚认完的页"。整格重建 267 个瓷砖要一秒多，
    // 而这里真正变的只有页面状态与刚认完那几页的块：就地刷新 + 按增量补框。
    // 收尾重画会先把这几页的旧块作废（模块内 refreshRecognizedPages）
    const donePages = collectNewlySucceededPages(data);
    // 识别完块变了：页面视图的建议角标不能拿旧数据
    window.PagesView?.onPageSuggestionsInvalidated();
    await refreshPageStates();
    // 任务 58：识别完成后工作流会记「已识别①」，把角标读回来
    await loadWorkflow();
    // 任务 53：识别子进程在收尾时自动算了一次版心（写在数据库里）。
    // 这里把新版心 / 建议读回来，页面视图与审校视图都会跟着重画。
    await window.MarginData?.refreshMarginState();
    // 刀 9.3：识别收尾同样走一次收尾能力（job_type != layout 时只重画版心、不碰检测结论）
    window.PagesView?.onTaskFinished(data);
    await window.PagesView?.onRecognitionFinished(donePages, { reloadDetail: false });
    if (detailPageNo !== null && !donePages.includes(detailPageNo)) {
      await window.PageDetailDrawer?.loadPageDetail(detailPageNo, { forceSuggestions: true });
    }
    await loadTasks();
    // loadTasks 在没有活动任务时会把抽屉内容换成"最近任务"。失败时把这次任务的
    // 失败页重新摆出来，**只主动开一次**；成功 / 取消只更新顶栏 pill。
    if (announceTaskFailure(data.job)) {
      renderTask(data);
      openTaskDrawer();
    }
    await window.QualityStats?.load(); // 任务结束后统计会变（复核行数、任务失败率）
    // 任务 69：任务在跑期间收尾面板给的是旧快照（不跟识别抢 CPU），
    // 任务一结束必须重算一次，否则步骤条会一直停在快照上。
    await loadFinishSummary({ silent: true });
    // 自动应用由识别子进程在结算后写入：这里等一轮再查，新出现的那一条会弹提示
    await window.SuggestionFlow?.announceAutoApplyAfterJob({ jobId: data.job.job_id });
  } else {
    // 进度在变，页面状态也在变：不重拉图，只刷状态。
    // 两件事互不依赖（页面状态 vs 块数据），并行发，别让块框多等一个往返。
    const donePages = collectNewlySucceededPages(data);
    await Promise.all([refreshPageStates(), window.PagesView?.onRecognitionFinished(donePages)]);
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

async function reloadDetailAfterRecognition(pageNo) {
  if (detailPageNo !== pageNo) return;
  // 正在输入：先把这一块存掉，再用识别结果重绘（顺序反过来会丢掉刚打的字）
  await window.PageDetailEditor?.flushPendingSave();
  if (detailPageNo !== pageNo) return;
  await window.PageDetailDrawer?.loadPageDetail(pageNo, { forceSuggestions: true });
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
  window.PagesView?.onPageStatesRefreshed();
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
    window.PagesView?.onWorkflowLoaded({}, {});
    return;
  }
  let filterCounts = {};
  let filterSummary = {};
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
    filterCounts = data.counts || {};
    filterSummary = data.summary || {};
  } catch {
    // 状态索引读不到时按"没有角标"处理，不影响识别 / 审校 / 导出
    workflowByPageId = new Map();
    workflowSummary = null;
    workflowConfirmationCounts = { human: 0, auto: 0, unknown: 0 };
    pendingPageNos = new Set();
    pendingPageCount = 0;
  }
  window.PagesView?.onWorkflowLoaded(filterCounts, filterSummary);
}


/** 版面检测入口：建任务 → 抽屉 + 轮询（任务 58）。 */
async function startLayoutDetection() { return window.PagesView.startLayoutDetection.apply(window.PagesView, arguments); }

// ---------------------------------------------------------------- 检测版面（⋯ 里的小入口）
//
// PM 的意见：检测一跑几分钟、用户也判断不了检测行对不对，**不该占版心步的主位**。
// 所以入口在右上角「⋯ → 检测版面…」，点开先看计划（几页 / 大概多久）再决定跑不跑。
// 后端用 `prepare` 模式：有检测行的页只补拟合，没有的才真检测。

// 检测版面：计划缓存与四个函数已搬进 layout-detect.js（window.LayoutDetect）。

/** 打开检测对话框：先取计划，再让用户决定。 */


/** 秒 → "约 2 分 10 秒"（粗一点，别给出假精度）。 */
function formatDuration(seconds) {
  const raw = Number(seconds) || 0;
  if (raw < 1) return "不到 1 秒";   // 含 0：页数 > 0 时永远不许出现「约 0 秒」
  const total = Math.max(0, Math.round(raw));
  if (total < 60) return `约 ${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `约 ${minutes} 分 ${rest} 秒` : `约 ${minutes} 分钟`;
}



/** 检测任务在跑：在版心分区里显示"做了多少 / 还要多久"。 */

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


/** 检测任务结算：把结果说清楚（成功多少、失败多少、版心补了多少、是不是崩了）。 */
/** 检测结束时进度条停在真实进度上，过一会儿收起来（别留在界面上像个假进度）。 */

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
  const skippedCount = Number(job.skipped) || 0;
  el("drawer-counts").textContent =
    `${job.done + job.failed + skippedCount} / ${job.total} 页 · 成功 ${job.done}` +
    (job.failed ? ` · 失败 ${job.failed}` : "") +
    (skippedCount ? ` · 跳过 ${skippedCount}（有人工改动）` : "");   // 有跳过才出现

  // 只显示技术上真实支持的操作（说明书 6.3）
  const running = job.status === "running" || job.status === "queued";
  el("job-pause").disabled = !running;
  el("job-resume").disabled = !["paused", "interrupted", "failed", "cancelled"].includes(
    job.status
  );
  el("job-retry").disabled = job.failed === 0 || (job.is_active && data.alive);
  el("job-cancel").disabled = !["queued", "running", "paused"].includes(job.status);

  const hints = [];
  if ((Number(job.skipped) || 0) > 0 && (job.status === "succeeded" || job.status === "succeeded_with_skips")) {
    hints.push(`识别完成 · ${Number(job.skipped)} 页已跳过（有人工改动）`);
  }
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
      if (page) window.PageDetailDrawer?.openPageDetail(page.page_no);
    });
    failures.append(li);
  }

  const chipActive = ["queued", "running", "paused"].includes(job.status);
  if (chipActive) {
    clearChipAutoHide();
    paintTaskChip({
      text: taskProgressText(job, data),
      textCompact: taskProgressText(job, data, { compact: true }),
      status: job.status,
      title: taskProgressTitle(job, `${typeLabel}任务 · ${label} · 点开看详情`),
      job,
    });
  } else if (job.status === "succeeded" || job.status === "succeeded_with_skips") {
    // 正常完成：回落成「任务」（常驻入口，不是隐藏）
    clearChipAutoHide();
    paintIdleChip();
  } else {
    // 异常结束（取消 / 失败 / 中断）：留一句短痕迹，30s 后消失。
    // 只由**这一次跃迁**触发：本会话没见过它活跃（例如页面刚重载、历史列表里那条旧 job）→ 不画。
    const traceKey = `${job.job_id || "?"}:${job.status}`;
    if (chipActiveSeen.has(job.job_id) && !chipTraceKeys.has(traceKey)) {
      chipTraceKeys.add(traceKey);
      const trace =
        job.status === "cancelled" ? "已取消"
          : job.status === "failed" ? "失败"
          : "已中断";
      paintTaskChip({
        text: `任务 · ${trace}`,
        status: job.status,
        title: `${typeLabel}任务${trace} · 点开看详情`,
      });
      armChipAutoHide();
    }
  }
}

function renderRecentTasks(jobs) {
  const latest = jobs[0];
  lastTaskData = null;
  if (latest && ["queued", "running", "paused"].includes(latest.status)) {
    clearChipAutoHide();
    paintTaskChip({
      text: taskProgressText(latest, lastTaskData),
      textCompact: taskProgressText(latest, lastTaskData, { compact: true }),
      status: latest.status,
      title: taskProgressTitle(latest, `${JOB_TYPE_LABELS[latest.job_type] || latest.job_type} · 点开看详情`),
      job: latest,
    });
  } else {
    // 历史任务（含 cancelled/failed）**不往胶囊上画**：痕迹是「刚才发生的事」，不是「历史列表」。
    // 没有活跃任务时胶囊回落成常驻入口「任务」——不隐藏，也不显示历史痕迹。
    // 正在倒数的痕迹不清计时器：列表刷新不该打断它。
    if (!chipAutoHideTimer) paintIdleChip();
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
      await window.PagesView?.onProjectPagesReloaded();
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

// ---------------------------------------------------------------- 目录确认（页码跳转索引，任务 37 / 任务 48 / 任务 94 · Slice I1）
//
// 目录视图的 41 个函数 + 23 个状态已整段搬进 `index-view.js`（任务 94 · Slice I1）。
// 刀 C：页码索引的状态与 6 个服务函数（`loadPageIndex` / `loadIndexBlocks` /
// `clearImagePlaceholder` / `loadImageQuality` / `setImageQuality` / `syncImageQualityUi`）
// 已整体搬进 `page-index.js`（`window.PageIndexService`）——状态也一起搬，本文件里
// 四份状态（页码索引三份 + 清晰度档）一个都不剩。
// 这里只留仍按常量注入给视图的两个面板参数（缩放四档 / 页图窗口）。
// 接缝：showView → `IndexView.enter()`；`IndexView.refresh()` 5 处（页面视图切版心 / 块框 ×4、
// boot 档位初始化后 ×1，另有预览 deps 里的一个 lambda 由外壳顺带调）；boot → `IndexView.init(deps)`。
// `refresh()` **不收参数**（§20.6）、**不做数据加载**（Chief 条件 ①）；换清晰度档走模块内
// `applyImageQuality()`（要取图），两个入口都在本模块里。
// 设计说明与函数实现见该文件头部。

const INDEX_ZOOM_SCALES = [0.55, 0.7, 0.85, 1];
/** 内存里保留当前页 ±N 页的图（任务 62：翻回去不用再等）。 */
const INDEX_IMAGE_WINDOW = 10;

// ---------------------------------------------------------------- 工具条的「⋯」菜单
//
// 结果预览（任务 38 / 47）已于 2026-11-04 按 L-117 删除（`preview-view.js` 与视图表登记一起走）。
// 这里只剩工具条的「⋯」菜单（`setupPageMore`，它是外壳不是预览，故原地不动）。

/** 任务 39（E 刀）：工具条上的「⋯」——诊断（质量统计）/ 协作（任务包）。 */
function setupPageMore() {
}


// ---------------------------------------------------------------- 审校视图（本页）

let detailPageNo = null;
// 刀 7 后补：`detailPageNo` 只属于 review 视图——**离开就清空**（showView 末尾那条）。
// 这个状态记「上次审校的页」，**只在 openPageDetail 里赋值、永不清空**，
// 给三个离开审校后仍要读它的地方用：页面视图的位置、目录确认的起点、结果预览的起点。
// 别处再给它赋值，它就变成第二个「当前页」真源。
let lastDetailPageNo = null;
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
/** 每个块编辑框最后的光标位置：拆分要用它（点菜单会让编辑框失焦）。 */
const cursorByBlock = new Map();
/**
 * 本页的块类型建议（只读）与按块索引。
 *
 * 与"未审"完全独立：有建议不会让块显示成待办，也不改 `review_status`；
 * 只有点「采用」才走 `PATCH block_type`（进事件表、可撤销）。
 */
let detailSuggestionByBlock = new Map();
/** 块 id → 页码候选提示（`page_numbers`）：只读，供「把页码拆出去」按钮用。 */
let detailNumberHints = new Map();
/** 最近一次渲染的整页版面确认状态（局部刷新时不要拿旧的页面列表覆盖）。 */
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
/** 补算建议 / 漏行（不 await：辅助信息晚一点出来不影响审校）。 */
function runPageAux(pageNo, { forceSuggestions = false } = {}) {
  if (detailPageNo !== pageNo) return;
  window.PageDetailEditor?.loadInkGaps(pageNo); // 不 await：漏行提示是辅助信息，晚一点出来不影响审校
  window.PageDetailEditor?.refreshDetailSuggestions({ force: forceSuggestions });
}

/** 只重拉建议、刷新块头徽章；不动块文本（结构 / 候选结果变了之后用）。 */
// ---------------------------------------------------------------- 翻页（审校视图顶栏）

/** 翻页时在哪一类页面之间走：默认全部正文页，也可以只看"还没审完"这类。 */
/** 顶栏的翻页控件：第 N 页（印 M）+ 上一页 / 下一页（说明书 7.4）。 */
function stepPage(delta) {
  const pages = window.PageDetailDrawer?.pagerPages();
  if (!pages.length || detailPageNo === null) return;
  const index = pages.findIndex((item) => item.page_no === detailPageNo);
  const target = index < 0 ? pages[0] : pages[index + delta];
  if (target) window.PageDetailDrawer?.openPageDetail(target.page_no);
}

// ---------------------------------------------------------------- 原图缩放与块框

/** null = 适合宽度；数字 = 相对"适合宽度"的倍数（说明书画面上只做这几档）。 */
let zoomLevel = null;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * 接线拆分（范例：一个函数写四个 owner 的 DOM，按 owner 切四份）。
 *
 * 原来这 42 行一次绑九件事。抽屉那六件（zoom-in / zoom-out / zoom-fit / toggle-overlay /
 * toggle-diff-marks / review-margin-toggle）与窗口 resize **已搬进 `page-detail-drawer.js`**；
 * 这里只剩三份，各自标了 owner 与死期。
 */
function setupViewerTools() {
  // owner = 审校左树（目录域）：过滤"只看未审"与展开左树 —— 树那刀搬走时一并带走
  el("review-tree-filter").addEventListener("click", () =>
    window.ReviewTree?.setReviewTreeOnlyTodo(!window.ReviewTree?.getReviewTreeOnlyTodo())
  );
  el("review-tree-rail").addEventListener("click", () =>
    el("review-tree").classList.add("is-open")
  );
  // owner = editor：折叠 `.editor` 是它自己容器的 class，由它自己的动作写（不开例外）
  el("review-drawer-toggle").addEventListener("click", () => {
    el("review-drawer-toggle").textContent = window.PageDetailEditor?.toggleCollapsed()
      ? "▴"
      : "▾";
  });
  // owner = editor：块列表的版心过滤按钮
  for (const button of el("review-filter").querySelectorAll("[data-margin-filter]")) {
    button.addEventListener("click", () => setReviewBlockFilter(button.dataset.marginFilter));
  }
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
      await window.PageDetailDrawer?.loadPageDetail(pageNo);
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
      await window.PageDetailDrawer?.loadPageDetail(pageNo, { forceSuggestions: true });
      await refreshPageStates();
      await loadWorkflow();
    } catch (error) {
      setSaveState(error.message || "撤销失败", true);
    }
  });
}


// ---------------------------------------------------------------- 审校视图的版心（任务 53）
//
// 用户 2026-10-23：「版心计算的结果，应同步到审校页面，审校内容，默认只审校版心内部的内容」。
// 这里画框 + 过滤列表；**不写库、不影响导出**（自动框只做显示，导出见 `export_margin_box`）。

/** 画 / 收起审校原图上的版心。只读：没有任何把手。 */
/** 切换块列表的过滤档位（只重画列表，不动原图 / 编辑状态之外的东西）。 */
function setReviewBlockFilter(mode) {
  // 写点收成模块能力（reviewBlockFilter / reviewFilterExplicit 仍在壳里，模块经注入写）
  window.PageDetailEditor?.setFilter(mode, true);
}

/** 这一块是否需要人处理：类型建议 / 两路分歧（数据源与块头徽章、分歧标记一致）。 */
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
  const pending = split.inside.filter((block) => window.PageDetailEditor?.blockNeedsReview(block)).length;
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
  const split = window.MarginData?.reviewMarginSplit(page, reviewBlocks);
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
  window.PageDetailEditor?.renderBlocks(reviewBlocks);
  return el("detail-blocks").querySelector(`li[data-block-id="${blockId}"]`);
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
  window.PageDetailEditor?.patchBlock(drag.block, { bbox });
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


function boxTypeLabel(block) {
  return BLOCK_TYPE_LABELS[block.block_type] || block.block_type;
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
      window.PageDetailEditor?.adoptBlockSuggestion(suggestion);
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
    const pageNumber = window.PageDetailEditor?.pageNumberHintChip(suggestion);
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

/**
 * 片 2：避让数学（顺序号找空位 / 卡片找空位 / 摆位 / 90 帧重试 / 尺寸观察）已经整体搬进
 * `overlay-registry.js`（唯一实现，契约 §1 不许两套）。这里只留薄转发，给还没迁完的
 * 审校的 `#detail-overlay` 用；
 * 2.2 把 reading / index 迁进 registry 之后，这三个转发器一起删。
 */
/** 审校侧：摆完号在同一帧重画差异层（排帧与尺寸观察都归 registry 的 schedule）。 */
function scheduleDetailOverlayLayout(overlay) {
  window.OverlayLayer?.schedule(overlay, {
    bboxOf: (box) => box._bbox,
    lineBboxes: overlay._lineBboxes,
    onLaidOut: () => window.PageDetailDrawer?.drawDiffLayer(),
  });
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
function flashDiffElement(node) {
  if (!node || typeof node.animate !== "function") return;
  node.animate(
    [{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }],
    { duration: 480, easing: "ease-in-out" }
  );
}

/** 只滚 #viewer-scroll，不动整页（design 4.2：不要用 scrollIntoView）。 */
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
  window.PageDetailEditor?.selectReviewBlock(blockId, { scroll: false });
  activeDiff = { blockId, lineIndex, spanIndex: spanIndex ?? 0 };
  syncDiffStrip(blockId);
  window.PageDetailDrawer?.updateDiffActive();
  window.PageDetailDrawer?.drawDiffLayer();
  requestAnimationFrame(() => {
    const node = window.PageDetailDrawer?.findDiffMark(blockId, lineIndex, activeDiff.spanIndex);
    if (node) {
      window.PageDetailDrawer?.scrollViewerTo(node);
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

// ---------------------------------------------------------------- 整页差异统计（页头文案用）

function aggregateDivergence() {
  const page = detailPageRecord();
  const inside = { lines: 0, chars: 0, punct: 0, acked: 0 };
  const outside = { lines: 0, chars: 0, punct: 0, acked: 0 };
  for (const block of reviewBlocks || []) {
    const divergence = divergenceOf(block);
    if (divergence.stale) continue;
    const bucket = window.MarginData?.blockCountedInMargin(block, page) ? inside : outside;
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
/** 未归属 / 冲突的行：灰色 / 黄色虚线画在原图上，一条都不丢。 */
// ---------------------------------------------------------------- 分歧标记（说明书 8.5）

/** 一块里最多逐条列出几行分歧；再多就交给「第二引擎复核」面板。 */
const MAX_DIVERGENCE_ROWS = 8;

/**
 * 块里的分歧：逐行给出另一路的候选，点一下换过去（说明书 8.5 的 MVP 落点）。
 *
 * 标记是**块里现在的文本**与第二引擎候选的比较（后端算的），所以采纳之后
 * 这一行会自动从列表里消失——标记始终反映当下的状态。
 */
/** 一行差异的内联片段：…前文[和→或]后文…；只渲染 A 上有字的 span。 */
/** 右栏文本面板：原文 / 候选两整行，**逐字**高亮差异（DOM span，不碰图像坐标）。 */
/** 长文本截断（只在界面上截，标题里带全文）。 */
/** 编辑框自适应高度：3–20 行；超过 20 行内部滚动（design 3.3）。 */
// ---------------------------------------------------------------- 自动保存与撤销

/** 输入停下来再存：打字过程中不发请求（说明书 6.4 的"自动保存"）。 */
/**
 * 立刻把还没发的自动保存落库。
 *
 * 需要它是因为"替换某一行"这类操作会用**服务端的最新文本**重写整个块：
 * 不等输入落库就替换，会把刚打的字盖掉。
 */
/** 把某一行换成另一路的文本（说明书 8.5：作为对 text 的编辑，可撤销）。 */
/** 记下当前正在编辑的块与光标位置（重渲染前调用）。 */
/** 重渲染之后把光标放回原来那一块（块没了就什么都不做）。 */
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
    window.PageGrid?.forgetPageBlocks(detailPageNo);
    await window.PageDetailDrawer?.loadPageDetail(detailPageNo);
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


/** 右列（新结果）逐块标出"与现有不同"；左列是基准，不标。 */
/** 新结果里这一块的"换这一块 / 加进这一页"，以及它对应现有哪一块。 */
/** 逐块采用：换掉对应的那一块（或把多出来的块加进来）。 */
// ---------------------------------------------------------------- 框选新增块（说明书 6.4）

/** 框选模式：在页面上拖一个框 → 给漏检的区域补一个块（不框选就是"无位置信息"）。 */
let boxCreateMode = false;

/** 框选出来的区域至少要有这么大，免得误点一下就冒出一个块。 */

/** 鼠标位置 → 相对图像的归一化坐标（说明书 5.2：相对显示方向、0–1）。 */
/** 拖拽方向任意，统一成 (x0,y0,x1,y1)。 */
// ---------------------------------------------------------------- 漏行检测与框选识别
//
// 检测阶段偶尔会漏一行（那行字在页面上、但没有 block_line）。补救有两步：
// 1) 只读接口 `GET /pages/{no}/ink-gaps` 找"有墨迹、没有任何行框覆盖"的横条；
// 2) 点候选 → 框选面板预填这块区域 → 「识别这块」调局部重识别（**不落库**），
//    文字填进输入框，用户可改，最后仍走现有的「创建这一块」。

let detailInkGaps = [];

/** 从漏行候选 / 手动框选进入"识别这块"：先把框画出来，再自动认一次。 */
/** 只识别框里的这一块：不落库，结果写进输入框等用户确认。 */
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
    if (next) await window.PageDetailDrawer?.openPageDetail(next);
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

async function loadFinishSummary() { return window.PagesView.loadFinishSummary.apply(window.PagesView, arguments); }

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


/** 行文本 + 第二引擎 + 行级 diff 重算（必须在字符规范化之后跑）。 */

/** 引号不配平清单：只读，逐条跳到审校页自己判断。 */

/** 批量写完：刷新收尾状态 / 页面状态，丢掉建议缓存（数据变了）。 */
async function afterCleanupApplied() {
  window.PagesView?.onPageSuggestionsInvalidated();
  await refreshPageStates();
  await loadFinishSummary({ silent: true });
  if (detailPageNo !== null) {
    await window.PageDetailDrawer?.loadPageDetail(detailPageNo, { forceSuggestions: true });
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
// 已搬进 `continuation-review.js`（`window.ContinuationReview`，root = #continuation-panel）。
// 入口按钮 #review-continuations / #cleanup-continuation-review-open 仍在外壳，接到导出。


// ---------------------------------------------------------------- 审校左栏目录树（任务 45 / H 刀）
//
// 已搬进 `review-tree.js`（`window.ReviewTree`，第四个 owner TREE：#review-tree 子树 6 个 id）。
// 9 个 reviewTree* 状态与 TREE_DIFF_LEVELS 一并随迁；死函数 updateReviewTreeAfterAck（0 引用）删除。


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
  window.PagesView?.onPageListChanged();
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
    await window.PageDetailDrawer?.loadPageDetail(detailPageNo, { forceSuggestions: false });
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
    window.PagesView.showPagesError(error);
  }
}

function finishOpenPageNumbers() {
  closeFinishPanel();
  window.PageNumberPanel?.openPageNumberPanel();
}

function finishStartReview() {
  if (!finishSummary) return;
  const target = finishSummary.review.needs_human_pages[0] || 1;
  closeFinishPanel();
  showView("review");
  window.PageDetailDrawer?.openPageDetail(target);
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
  el("cleanup-orthography-run").addEventListener("click", () => window.Orthography?.runOrthographyCleanup());
  el("cleanup-orthography-review").addEventListener("click", () => window.Orthography?.openOrthographyPanel());
  el("cleanup-lines-run").addEventListener("click", () => window.Orthography?.runLinesCleanup());
  el("cleanup-undo").addEventListener("click", undoLastCleanup);
  el("cleanup-continuation-review-open").addEventListener("click", () =>
    window.ContinuationReview?.openContinuationReview()
  );
  el("review-continuations").addEventListener("click", () =>
    window.ContinuationReview?.openContinuationReview()
  );
  el("finish-start-review").addEventListener("click", finishStartReview);
  el("finish-export").addEventListener("click", finishOpenExport);

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
    const inOtherButton = active.tagName === "BUTTON";
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
      window.PageDetailEditor?.reviewAction("redo");
    } else if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      window.PageDetailEditor?.reviewAction("undo");
    }
  });
}

/** 批量改页面的类型（说明书 6.2 的批量操作，第 11 节的 PATCH /pages）。 */

// 恢复粒度文案（PM 定稿；数字/计数由调用方传，模板不写死）
const RESTORE_DETAIL_TEXT =
  "恢复只把整本项目数据（块与审校状态）回到这份备份的时刻；那一刻之后的改动会丢。" +
  "识别原始输出、缩略图缓存、已导出的文件不在备份里，也不会回去。";

/** 查这些页里哪些有人工成果（接口 routes_projects.py:163）。查不到就按"没有"走旧路，不阻断用户。 */
async function humanTouchedPages(project, pages) {
  const nos = pages.map((page) => page.page_no);
  if (!nos.length) return [];
  try {
    const data = await apiJson(
      `/api/projects/${project.project_id}/pages/human-touched?pages=${nos.join(",")}`
    );
    return (data.pages || []).filter((row) => row.human_touched).map((row) => row.page_no);
  } catch (error) {
    return [];
  }
}


async function closeProject() {
  if (!currentProject) return;
  try {
    await apiJson(`/api/projects/${currentProject.project_id}/close`, { method: "POST" });
  } catch (error) {
    window.LibraryView?.notify({ kind: "error", error: error });
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
  window.PageDetailDrawer?.closePageDetail();
  closeTaskDrawer();
  stopTaskPolling();
  el("task-chip").hidden = true;
  el("project-meta-section").hidden = true;
  showView("library");
  await window.LibraryView?.enter();
}











function setupLibrary() {
  el("project-close").addEventListener("click", closeProject);
  el("trash-open").addEventListener("click", () => window.RecoveryPanels?.openTrashPanel());
  // 「分派任务包 / 任务包 / 导入结果」的 8 处接线已搬进 collab.js 的 setupCollabControls()
  // 刀 6：⋯ 菜单的四个条目（含"点完先收起菜单"）搬进 pages-view.js 的 wirePagesMoreMenuEntries()
  // 「全库采用 / 自动应用提示条 / 建议面板」那 6 处接线已搬进 suggestion-flow.js 的 init()
  // （按钮 DOM 归各自视图 / chrome，接线归跨视图服务）
  // 「批量拆分」面板的 close / cancel / apply 三处接线已搬进 split-batch-panel.js 的 init()
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
  el("detail-close").addEventListener("click", () => window.PageDetailDrawer?.closePageDetail());
  setupReviewControls();
  el("stats-refresh").addEventListener("click", () => window.QualityStats?.load());
  setupTaskDrawer();

  el("aux-warning-skip").addEventListener("click", () => {
    auxWarningSkipped = true;
    closeModal("aux-warning-mask");
    enterReviewStep();
  });
  el("aux-warning-cancel").addEventListener("click", () => closeModal("aux-warning-mask"));
  el("detail-recognize").addEventListener("click", () => {
    if (detailPageNo === null) return;
    const page = currentProject.pages.find((item) => item.page_no === detailPageNo);
    if (page) window.PagesView.recognizePage(page);
  });
}


// ---------------------------------------------------------------- 全库采用高把握建议
//
// 已搬进 `suggestion-flow.js`（`window.SuggestionFlow`）：通知条 / 自动应用状态 / 全库采用建议 /
// 版心判定开关。它是**跨 5 个视图的流程**，不是某一个 section 的服务；root 只认
// `#suggestion-apply-panel`，chrome 通知条与审校页的按钮经 init 注入。
// ---------------------------------------------------------------- 批量拆分书眉页码
//
// 书眉 / 页脚和页码被 OCR 成一个块（`2谁是巴赫金?11`）时，逐块拆太慢。
// 这里三步：算预览（dry_run，只读）→ 人看影响多少页 / 块 → 确认后才写。
// 整批共用一条 batch（服务端），所以在审校视图点一次「撤销」就整批回退。

/** 批量范围：选了页就只做这些页，没选就是全部正文页。 */
// ---------------------------------------------------------------- 批量拆分书眉页码
//
// 已搬进 `split-batch-panel.js`（`window.SplitBatchPanel`）：root = #split-batch-panel，
// 4 个函数 / 1 个导出；2 处写盘在模块内闭环。入口按钮 #split-page-numbers 归外壳（pages-view.js）。

// ---------------------------------------------------------------- 协作：分派任务包（负责人）
//
// 已搬进 `collab.js`（`window.Collab`）：**两个 root 按宿分组**——`#assign-panel`（16 个 id）与
// `#package-result`（3 个 id）；chrome 4 个节点（顶栏 3 + 通知条 1）走 init 注入。
// 13 处写盘全在模块内闭环；`structure-open` / `finish-open-review` 两个节点的显隐归外壳
// （`applyPackageMode()` 返回 `{ ok, packageMode }`，由唯一调用点写那两个节点）。
// 死状态 `assignPreviewData`（写 1 读 0）随本刀删除。
// `mergeState` **留在外壳**：合并视图模块经外壳取（getMergeState），协作模块经注入的
// setMergeState 写——两边都不复制一份，这是 S1 裁决 A（外壳仍在读写的状态走注入）。

/** 合并审阅状态（导入结果包之后由协作模块写入，合并视图模块经外壳读）。 */
let mergeState = null;

// 项目备份：已搬进 recovery-panels.js（window.RecoveryPanels）。

// ---------------------------------------------------------------- 语言分布（任务 64）


// ---------------------------------------------------------------- 重跑第二引擎（任务 64）
//
// 用户拍板：以后一律用第二引擎（Vision），不用文字层。已有项目的 aux 是文字层，
// 这里给一个"换掉"的动作：先备份（服务端做），只覆盖 aux_text / diff_status，
// 已裁决的行不覆盖；分批可续（就是个普通的复核任务）。


// ---------------------------------------------------------------- 标点差异 · 按模式批量（任务 61）
//
// 用户现场（红楼梦 3）：1676 条差异行里 710 行只差标点 / 空格，归成 64 种模式；
// `；→，` 一种就 293 行，`∅→‘` 119 行（RapidOCR 系统性地吞掉开头引号）。
// 逐条点这 710 行是纯体力活，而"全部采用候选"能一次修掉几百处真错。
//
// 主队列（左树 / 进度 / 下一处未审）只放含汉字差异的行；这里按模式判，
// 判完写的是**行级 diff_ack**（和逐条审同一份数据），所以队列数字、导出、撤销全同步。

// ---------------------------------------------------------------- 标点批量 / 整行乱码
//
// 已搬进 `punct-batch.js`（`window.PunctBatch`，两个根：#punct-groups-mask / #garbled-mask）。


/** 批量裁决改了正文：整条阅读流重开一次（marks / 树 / 进度都跟着变）。 */

// ---------------------------------------------------------------- 启动

// ---------------------------------------------------------------- 阅读审校三栏宽度（P1-4）
//
// 用户："左边的 pdf 图片太小，看不清楚，能不能左右窗口可以拖动？"
// 三栏 = 左树 / PDF / 正文。两条 6px 的手柄可拖，宽度记在 localStorage；
// 最小宽度卡住，别拖到正文没字、或 PDF 看不见；窄屏（<1120）不显示手柄（CSS 管）。

/** 字符规范化清单「看原文」：进审校并打开该页抽屉（抽屉未 init 时也不会炸）。 */
function openOrthographyReviewPage(pageNo) {
  showView("review");
  window.PageDetailDrawer?.openPageDetail(pageNo);
}

function boot() {
  // ③ 第二批：跨视图服务（建议流程）**先装**——导出模块在它之后 init，要它的两个导出
  // （`marginJudgementEnabled` / `setMarginJudgement`）；本模块反过来要导出的预检，
  // 用惰性箭头给（调用时才解引用），所以 init 顺序是单向的、没有环。
  window.SuggestionFlow?.init({
    // 自己的 root：#suggestion-apply-panel（顶层 mask，5 个 id 全在子树里）
    root: el("suggestion-apply-panel"),
    // chrome 通知条 6 个节点在 body 顶层（四个兄弟 noticebar，没有共同 id 祖先）
    // ⇒ 一组节点注入，模块里不出现这些 id（给它们包一层 div 会改布局，不做）
    getNoticeEls: () => ({
      autoApply: el("auto-apply-notice"),
      text: el("auto-apply-notice-text"),
      undo: el("auto-apply-undo"),
      dismiss: el("auto-apply-dismiss"),
      margin: el("margin-judgement-notice"),
      marginOk: el("margin-judgement-notice-ok"),
    }),
    // 审校页的「全库采用」按钮在 #view-review 子树里：节点归视图，接线归跨视图服务
    getReviewApplyAll: () => el("review-apply-all"),
    getCurrentProject: () => currentProject,
    getDetailPageNo: () => detailPageNo,
    apiJson: (...args) => apiJson(...args),
    showError: (node, error) => showError(node, error),
    // #page-detail-error 的唯一写入口在 page-detail-editor.js（刀 7 裁定），本模块经注入调它
    showPageDetailError: (error) => showPageDetailError(error),
    openModal: (...args) => openModal(...args),
    closeModal: (...args) => closeModal(...args),
    renderRecognitionSettings: (...args) => renderRecognitionSettings(...args),
    forgetPageBlocks: (...args) => window.PageGrid?.forgetPageBlocks(...args),
    refreshPageStates: (...args) => refreshPageStates(...args),
    loadPageDetail: (...args) => window.PageDetailDrawer?.loadPageDetail(...args),
    setSaveState: (...args) => setSaveState(...args),
    // 页面视图的五个能力（块框 / 建议缓存 / 重排 / 设置同步 / 自动应用角标）
    syncPagesProjectSettings: (...args) => window.PagesView?.syncProjectSettings(...args),
    onAutoApplyStatusChanged: (...args) => window.PagesView?.onAutoApplyStatusChanged(...args),
    onPageBlocksInvalidated: (...args) => window.PagesView?.onPageBlocksInvalidated(...args),
    onPageSuggestionsInvalidated: (...args) => window.PagesView?.onPageSuggestionsInvalidated(...args),
    onPagesNeedReflow: (...args) => window.PagesView?.onPagesNeedReflow(...args),
    // 惰性：导出模块在本块之后才 init
    refreshExportPreflight: () => window.ExportPanel?.refreshPreflight(),
    BLOCK_TYPE_LABELS,
  });
  // ③ 协作（任务包 / 分派）：**两个 root 按宿分组**——#assign-panel / #package-result 都是顶层 mask，
  // 都是它真正拥有的 DOM；chrome 那 4 个节点（顶栏 3 + 通知条 1）没有共同根 ⇒ 一组节点注入。
  window.Collab?.init({
    roots: [el("assign-panel"), el("package-result")],
    getChromeEls: () => ({
      openPackage: el("open-package"),
      openPackageFile: el("open-package-file"),
      packageOpen: el("package-open"),
      banner: el("package-banner"),
    }),
    getCurrentProject: () => currentProject,
    getProjectId: () => project_id(),
    getSelectedPages: () => selectedPages,
    getToken: () => token,
    apiJson: (...args) => apiJson(...args),
    showError: (node, error) => showError(node, error),
    showView: (...args) => showView(...args),
    syncWorkflowSteps: (...args) => syncWorkflowSteps(...args),
    closeModal: (...args) => closeModal(...args),
    refreshPageStates: (...args) => refreshPageStates(...args),
    setSaveState: (...args) => setSaveState(...args),
    closeFinishPanel: (...args) => closeFinishPanel(...args),
    // mergeState 归外壳（合并视图经外壳取）⇒ 模块只经这个 setter 写，不留副本
    setMergeState: (value) => { mergeState = value; return value; },
    // 跨模块六个动作，按语义命名（不许合成万能键）
    libraryNotify: (payload) => window.LibraryView?.notify(payload),
    libraryEnter: () => window.LibraryView?.enter(),
    libraryOpen: (projectId) => window.LibraryView?.open(projectId),
    mergeEnter: (assignmentId) => window.MergeView?.enter(assignmentId),
    pagesPackageModeChrome: (on) => window.PagesView?.setPackageModeChrome(on),
    editorPackageModeChrome: (on) => window.PageDetailEditor?.setPackageModeChrome(on),
    ApiError,
  });
  window.Collab?.setupCollabControls();
  // 任务 94 Slice 1：审校视图模块初始化（依赖由此注入，模块内部不直接碰这些全局）
  window.ReadingView?.init({
    el,
    getProjectId: () => (currentProject ? currentProject.project_id : null),
    exit: () => showView("pages"),
    onPunctGroups: () => window.PunctBatch?.openPunctGroups(),
    onGarbledPanel: () => window.PunctBatch?.openGarbledPanel(),
    // 任务 94 Slice 2（第一笔）：readingReloadAfterBatch 搬进模块后要读写的审校状态 / 回调
    renderPunctGroupBadge: () => window.PunctBatch?.renderPunctGroupBadge(),
    // 任务 94 Slice 2（第二笔）：setupReading 的依赖——只注入句柄与 getter/setter，不注入值
    isReadingActive: () => currentView === "reading",
    navigate: (name) => showView(name),
    openPageDetail: (pageNo) => window.PageDetailDrawer?.openPageDetail(pageNo),
    // 任务 94 L2：10 个交互函数搬进模块后的状态句柄与回调（只注入句柄 / getter-setter，不注入值）
    getProject: () => currentProject,
    apiJson: (path, options) => apiJson(path, options),
    loadFinishSummary: (options) => loadFinishSummary(options),
    // 片 5：ack 之后让左树那一行立刻变（不重取树）
    noteReviewAcks: (entries) => window.ReviewTree?.noteAcks(entries),
    // 任务 94 L3：openReading / 行编辑辅助搬进模块后的状态句柄与回调
    refreshPunctGroups: () => window.PunctBatch?.refreshPunctGroups(),
    refreshGarbledLines: () => window.PunctBatch?.refreshGarbledLines(),
    // 任务 94 L4：队列 / 草稿加载 / 视口处理搬进模块后的句柄
    showNoticeBar: (text) => window.SuggestionFlow?.showNotice(text),
    // 任务 94 L5：审校环搬进模块后的状态句柄（状态仍归 app.js，get+set 成对）
    getCurrentView: () => currentView,
    // 任务 94 L5：审校环里仍留在 app.js 的叶子函数（模块经注入调用）
    exportOptions: () => window.ExportPanel?.exportOptions(),
    loadIndexBlocks: (...args) => window.PageIndexService?.loadBlocks(...args),
    pageProfileFor: (...args) => window.PageMedia?.pageProfileFor(...args),
    punctReviewSet: () => window.PunctBatch?.punctReviewSet(),
    // 刀 6：页面工具栏两个开关的 is-on 同步（跨视图能力走注入——R2 不许模块直接引用 window.PagesView）
    syncToolbarToggles: () => window.PagesView?.syncToolbarToggles(),
    // 任务 94 L5：模块要读的常量
    INDEX_IMAGE_WINDOW: INDEX_IMAGE_WINDOW,
    // L6 刀1：状态 getter
    // L6 刀1：状态 setter（有写点才给）
    // L6 刀1：仍留在 app.js 的叶子函数
    clearImagePlaceholder: (...args) => window.PageIndexService?.clearImagePlaceholder(...args),
    clearTileMargin: (...args) => window.MarginData?.clearTileMargin(...args),
    pageImageUrl: (...args) => window.PageMedia?.pageImageUrl(...args),
    // L6 刀2：仍留在 app.js 的叶子函数
    computeCharSpans: (...args) => computeCharSpans(...args),
    // L6 刀3：状态 getter
    // L6 刀3：状态 setter（有写点才给）
    // L6 刀3：仍留在 app.js 的叶子函数
    // L6 刀7：仍留在 app.js 的叶子函数
    // L6 刀8：状态 setter（有写点才给）
    // L6 刀9：状态 getter
    // L6 刀9：仍留在 app.js 的叶子函数
    // L6 刀12：状态 getter
    getPagesMarginOn: () => pagesMarginOn,
    getPagesOverlayOn: () => pagesOverlayOn,
    // L6 刀12：状态 setter（有写点才给）
    setPagesMarginOn: (value) => { pagesMarginOn = value; return value; },
    setPagesOverlayOn: (value) => { pagesOverlayOn = value; return value; },
    // L6 刀12：仍留在 app.js 的叶子函数
    paintTileMargin: (...args) => window.MarginData?.paintTileMargin(...args),
    savePageMarginPreference: (...args) => window.MarginData?.savePageMarginPreference(...args),
    savePageOverlayPreference: (...args) => savePageOverlayPreference(...args),
  });
  if (!token) {
    const warning = el("platform-warning");
    warning.innerHTML = "缺少会话令牌。请使用启动时终端里打印的" +
      "<strong>完整界面地址</strong>（带 <code>?token=…</code>）打开本页。";
    warning.hidden = false;
  }
  setupShell();
  setupLibrary();
  // 页码面板：两个根（#page-number-panel / #page-number-review-panel）都是顶层 mask。
  // init 必须在这段的第一句——模块的 part() 要 root 已经交进去。
  window.PageNumberPanel?.init({
    root: el("page-number-panel"),
    reviewRoot: el("page-number-review-panel"),
    getCurrentProject: () => currentProject,
    getPageNumberAnalysis: () => pageNumberAnalysis,
    setPageNumberAnalysis: (value) => { pageNumberAnalysis = value; return value; },
    apiJson: (...args) => apiJson(...args),
    showError: (node, error) => showError(node, error),
    openModal: (...args) => openModal(...args),
    closeModal: (...args) => closeModal(...args),
    onPageNumberAnalysisReady: () => window.PagesView?.onPageNumberAnalysisReady(),
    onPageNumberChanged: (text) => window.PagesView?.onPageNumberChanged(text),
  });
  window.PageNumberPanel?.setupPageNumberPanel();
  // 批量拆分面板：root = #split-batch-panel（body 直下的 mask）。init 必须在这段的第一句。
  window.SplitBatchPanel?.init({
    root: el("split-batch-panel"),
    getCurrentProject: () => currentProject,
    getSelectedPages: () => selectedPages,
    getDetailPageNo: () => detailPageNo,
    apiJson: (...args) => apiJson(...args),
    openModal: (...args) => openModal(...args),
    closeModal: (...args) => closeModal(...args),
    showError: (node, error) => showError(node, error),
    forgetPageBlocks: (...args) => window.PageGrid?.forgetPageBlocks(...args),
    refreshPageStates: (...args) => refreshPageStates(...args),
    onPageSuggestionsInvalidated: (...args) => window.PagesView?.onPageSuggestionsInvalidated(...args),
    onPagesNeedReflow: (...args) => window.PagesView?.onPagesNeedReflow(...args),
    setSelectionHint: (...args) => window.PagesView?.setSelectionHint(...args),
    loadPageDetail: (...args) => window.PageDetailDrawer?.loadPageDetail(...args),
    BLOCK_TYPE_LABELS,
  });
  // 版心数据（服务模块）：四个视图各自把 tile 传进来，模块不自建 DOM。
  window.MarginData?.init({
    getCurrentProject: () => currentProject,
    getPagesMarginOn: () => pagesMarginOn,
    setPagesMarginOn: (value) => { pagesMarginOn = value; return value; },
    getReviewMarginOn: () => reviewMarginOn,
    setReviewMarginOn: (value) => { reviewMarginOn = value; return value; },
    getTileByPageNo: (pageNo) => document.querySelector(`#page-grid .page-tile[data-page-no="${pageNo}"]`),
    // 片 2d：任务收尾的版心重读搬进模块——读写状态走访问器，两个画法归抽屉（注入）
    apiJson: (...args) => apiJson(...args),
    detailPageRecord: (...args) => detailPageRecord(...args),
    getDetailPageNo: () => detailPageNo,
    getReviewBlocks: () => reviewBlocks,
    setMarginSuggestion: (value) => { marginSuggestion = value; return value; },
    setMarginAuditPage: (value) => { marginAuditPage = value; return value; },
    getMarginFitTried: () => marginFitTried,
    paintReviewMargin: (...args) => window.PageDetailDrawer?.paintReviewMargin(...args),
    drawDetailOverlay: (...args) => window.PageDetailDrawer?.drawDetailOverlay(...args),
  });
  // 片 10：检测版面的外壳（root = #layout-detect-mask）；layoutDetectActive 仍归外壳
  window.LayoutDetect?.init({
    root: el("layout-detect-mask"),
    getCurrentProject: () => currentProject,
    apiJson: (...args) => apiJson(...args),
    openModal: (...args) => openModal(...args),
    closeModal: (...args) => closeModal(...args),
    selectionPages: (...args) => selectionPages(...args),
    getSelectedPages: () => selectedPages,
    formatDuration: (...args) => formatDuration(...args),
    startLayoutDetection: (...args) => startLayoutDetection(...args),
    pagesErrorMessage: (...args) => window.PagesView?.pagesErrorMessage(...args),
    onLayoutDetectStarted: (...args) => window.PagesView?.onLayoutDetectStarted(...args),
    setLayoutDetectActive: (value) => { layoutDetectActive = value; return value; },
  });
  // 片 9：字符规范化（root = #orthography-panel）；两个入口在清理面板里，留外壳转发
  window.Orthography?.init({
    root: el("orthography-panel"),
    getCurrentProject: () => currentProject,
    apiJson: (...args) => apiJson(...args),
    openModal: (...args) => openModal(...args),
    closeModal: (...args) => closeModal(...args),
    setCleanupStatus: (...args) => setCleanupStatus(...args),
    afterCleanupApplied: () => afterCleanupApplied(),
    openReviewPage: (pageNo) => openOrthographyReviewPage(pageNo),
  });
  // 片 8：字框回填（root = #word-boxes-mask）；入口 #word-boxes-open 在页面视图 ⋯ 菜单
  window.WordBoxes?.init({
    root: el("word-boxes-mask"),
    getCurrentProject: () => currentProject,
    apiJson: (...args) => apiJson(...args),
    openModal: (...args) => openModal(...args),
    closeModal: (...args) => closeModal(...args),
    formatDuration: (...args) => formatDuration(...args),
    clearPageBlockCache: () => pageBlockCache.clear(),
  });
  // 片 7：锁冲突 / 废纸篓 / 项目备份（三个顶层 mask 三个根）；入口在库顶栏与 ⋯ 菜单
  window.RecoveryPanels?.init({
    lockRoot: el("lock-conflict-mask"),
    trashRoot: el("trash-panel"),
    backupsRoot: el("backups-mask"),
    getCurrentProject: () => currentProject,
    apiJson: (...args) => apiJson(...args),
    showError: (node, error) => showError(node, error),
    openModal: (...args) => openModal(...args),
    closeModal: (...args) => closeModal(...args),
    fillDefinitionList: (...args) => fillDefinitionList(...args),
    humanBytes: (...args) => humanBytes(...args),
    formatMarginTime: (...args) => window.MarginData?.formatMarginTime(...args),
    libraryOpen: (...args) => window.LibraryView?.open(...args),
    libraryEnter: (...args) => window.LibraryView?.enter(...args),
    libraryNotify: (...args) => window.LibraryView?.notify(...args),
  });
  // 片 6：标点批量 + 整行乱码（两个顶层 mask 两个根；角标节点归阅读视图，经注入给句柄）
  window.PunctBatch?.init({
    punctRoot: el("punct-groups-mask"),
    garbledRoot: el("garbled-mask"),
    getCurrentProject: () => currentProject,
    apiJson: (...args) => apiJson(...args),
    showError: (node, error) => showError(node, error),
    openModal: (...args) => openModal(...args),
    closeModal: (...args) => closeModal(...args),
    getReadingBadges: () => ({
      punctCount: el("reading-punct-count"),
      punctOpen: el("reading-punct-open"),
      garbledCount: el("reading-garbled-count"),
      garbledOpen: el("reading-garbled-open"),
    }),
    reloadReading: () => window.ReadingView.reload(),
    showNotice: (...args) => window.SuggestionFlow?.showNotice(...args),
  });
  // 片 5：跨页延续面板（root = #continuation-panel，顶层 mask）；状态与接线都归模块
  window.ContinuationReview?.init({
    root: el("continuation-panel"),
    getCurrentProject: () => currentProject,
    apiJson: (...args) => apiJson(...args),
    showError: (node, error) => showError(node, error),
    openModal: (...args) => openModal(...args),
    closeModal: (...args) => closeModal(...args),
    loadFinishSummary: (...args) => loadFinishSummary(...args),
    pageImageUrl: (...args) => window.PageMedia?.pageImageUrl(...args),
    detailImageProfile: (...args) => window.PageMedia?.detailImageProfile(...args),
    pageWidthPt: (...args) => window.PageMedia?.pageWidthPt(...args),
    onKeydown: (handler) => document.addEventListener("keydown", handler),
    onResize: (handler) => window.addEventListener("resize", handler),
  });
  // 片 4：审校左栏目录树（root = #review-tree，第四个 owner）；9 个 reviewTree* 状态随迁
  window.ReviewTree?.init({
    root: el("review-tree"),
    getCurrentProject: () => currentProject,
    getDetailPageNo: () => detailPageNo,
    getReviewBlocks: () => reviewBlocks,
    getActiveDiff: () => activeDiff,
    apiJson: (...args) => apiJson(...args),
    showPageDetailError: (...args) => window.PageDetailEditor?.showPageDetailError(...args),
    blockCountedInMargin: (...args) => window.MarginData?.blockCountedInMargin(...args),
    truncate: (...args) => window.PageDetailEditor?.truncate(...args),
    openPageDetail: (...args) => window.PageDetailDrawer?.openPageDetail(...args),
    activateDiff: (...args) => activateDiff(...args),
    computeCharSpans: (...args) => computeCharSpans(...args),
    divergenceOf: (...args) => divergenceOf(...args),
  });
  // 片 3b：缩放档位 / 图档选择 / 宽度测量（状态在模块里；外壳只给项目、token、dpr、视口宽）
  window.PageMedia?.init({
    getCurrentProject: () => currentProject,
    getToken: () => token,
    getImageQuality: () => window.PageIndexService?.getImageQuality() || "auto",
    getDevicePixelRatio: () => Number(window.devicePixelRatio || 1),
    getViewportWidth: () => Number(window.innerWidth || 0),
    applyPageZoom: () => window.PagesView?.applyPageZoom(),
  });
  // 片 3a：页面网格的瓦片生产 + 块缓存（服务模块，无 root）。buildTile 造的就是
  // margin-data.js 消费侧契约的那棵树，两边改一处必须同时改。
  window.PageGrid?.init({
    getCurrentProject: () => currentProject,
    getSelectedPages: () => selectedPages,
    getBusyPages: () => busyPages,
    getPageZoomIndex: () => window.PageMedia?.getPageZoomIndex(),
    getToken: () => token,
    PAGE_TYPE_LABELS,
    pageBlockCache,
    pageBlockCacheOrder,
    pageBlockVersions,
    PAGE_BLOCK_CACHE_LIMIT,
    workflowOf: (...args) => workflowOf(...args),
    recognitionOf: (...args) => recognitionOf(...args),
    paintTileSuggestionMark: (...args) => paintTileSuggestionMark(...args),
    recognitionChip: (...args) => recognitionChip(...args),
    workflowChip: (...args) => workflowChip(...args),
    reviewBadge: (...args) => reviewBadge(...args),
    divergenceChip: (...args) => divergenceChip(...args),
    forgetPageSuggestions: (...args) => forgetPageSuggestions(...args),
    pageMarginSourceLabel: (...args) => window.MarginData?.pageMarginSourceLabel(...args),
    attachRenderErrorDetail: (...args) => window.PageTile?.attachRenderErrorDetail?.(...args),
    recognizePage: (...args) => window.PagesView?.recognizePage(...args),
    openPageDetail: (...args) => window.PageDetailDrawer?.openPageDetail(...args),
  });
  window.PagesView?.init({
    adoptBlockSuggestion: (...args) => window.PageDetailEditor?.adoptBlockSuggestion(...args),
    apiJson: apiJson,
    applyProjectSettings: (...args) => window.SuggestionFlow?.projectSettingsApplied(...args),
    clearTileMargin: (...args) => window.MarginData?.clearTileMargin(...args),
    fetchPageSuggestions: fetchPageSuggestions,
    forgetPageSuggestions: forgetPageSuggestions,
    formatDuration: formatDuration,
    loadFinishSummary: loadFinishSummary,
    loadTasks: loadTasks,
    marginBodyPages: marginBodyPages,
    marginBoxOfPage: (...args) => window.MarginData?.marginBoxOfPage(...args),
    notifyApplied: (...args) => window.SuggestionFlow?.notifyApplied(...args),
    openTaskDrawer: openTaskDrawer,
    pageHasFitLines: pageHasFitLines,
    pageMarginMethod: (...args) => window.MarginData?.pageMarginMethod(...args),
    parsePageRange: parsePageRange,
    recognitionOf: recognitionOf,
    refreshPageStates: refreshPageStates,
    renderProjectMeta: renderProjectMeta,
    renderTask: renderTask,
    queueAfterSteps: queueAfterSteps,      // 刀 9.1：enter() 里延迟 loadLanguageSummary 用它
    showError: showError,
    showView: showView,
    startTaskPolling: startTaskPolling,
    AUX_SECONDS_PER_PAGE: AUX_SECONDS_PER_PAGE,
    BLOCK_TYPE_LABELS: BLOCK_TYPE_LABELS,
    PAGE_TYPE_LABELS: PAGE_TYPE_LABELS,
    PAGE_TYPE_ORDER: PAGE_TYPE_ORDER,
    RECOGNITION_LABELS: RECOGNITION_LABELS,
    getCurrentProject: () => currentProject,
    getCurrentView: () => currentView,
    getFinishSummary: () => finishSummary,
    getFinishSummaryProject: () => finishSummaryProject,
    getLastTaskData: () => lastTaskData,
    getLayoutBlockPage: () => layoutBlockPage,
    getLayoutBlockPayload: () => layoutBlockPayload,
    getMarginAuditLoading: () => marginAuditLoading,
    getMarginAuditPage: () => marginAuditPage,
    getMarginFitRunning: () => marginFitRunning,
    marginFitTried: marginFitTried,
    marginUndoStack: marginUndoStack,
    pageSuggestionCache: pageSuggestionCache,
    pageSuggestionFailed: pageSuggestionFailed,
    getPageTileMetrics: () => pageTileMetrics,
    getPageZoomIndex: () => window.PageMedia?.getPageZoomIndex(),
    getPagesMarginOn: () => pagesMarginOn,
    getPagesOverlayOn: () => pagesOverlayOn,
    getPanelAccordionProject: () => panelAccordionProject,
    getProjectSummary: () => projectSummary,
    getRecStatusTimer: () => recStatusTimer,
    getSelectedPages: () => selectedPages,
    getSelectionAnchor: () => selectionAnchor,
    getSetupSuggestionsLoaded: () => setupSuggestionsLoaded,
    getTaskJobId: () => taskJobId,
    visiblePageNos: visiblePageNos,
    getWorkflowStep: () => workflowStep,
    pageBlockPending: pageBlockPending,
    getPageBlockVersions: () => pageBlockVersions,
    getPageBlockCache: () => pageBlockCache,
    getDetailPageNo: () => detailPageNo,
    auxEstimateText: auxEstimateText,
    estimateRemainingSeconds: estimateRemainingSeconds,
    applyMarginRect: (...args) => window.MarginData?.applyMarginRect(...args),
    nearestEdge: nearestEdge,
    forgetPageBlocks: (...args) => window.PageGrid?.forgetPageBlocks(...args),
    formatMarginBox: (...args) => window.MarginData?.formatMarginBox(...args),
    highConfidenceCount: highConfidenceCount,
    layoutBlockPageRecord: layoutBlockPageRecord,
    loadPageDetail: (...args) => window.PageDetailDrawer?.loadPageDetail(...args),
    marginBasisForUndetermined: (...args) => window.MarginData?.marginBasisForUndetermined(...args),
    marginFitSummaryText: marginFitSummaryText,
    marginPagesWithoutLines: marginPagesWithoutLines,
    marginSourceText: (...args) => window.MarginData?.marginSourceText(...args),
    marginUndeterminedPages: marginUndeterminedPages,
    mergePageRecord: (...args) => window.MarginData?.mergePageRecord(...args),
    openMasks: openMasks,
    pageBlockKey: (...args) => window.PageGrid?.pageBlockKey(...args),
    pageMarginSourceLabel: (...args) => window.MarginData?.pageMarginSourceLabel(...args),
    pageSetupStats: (...args) => window.PageConfirm.pageSetupStats(...args),
    paintTileMargin: (...args) => window.MarginData?.paintTileMargin(...args),
    percentText: (...args) => window.QualityStats.percentText(...args),
    reloadDetailAfterRecognition: reloadDetailAfterRecognition,
    rememberPageBlocks: (...args) => window.PageGrid?.rememberPageBlocks(...args),
    repaintTileMargin: (...args) => window.MarginData?.repaintTileMargin(...args),
    selectedSuggestions: (...args) => window.PageConfirm.selectedSuggestions(...args),
    selectionPages: selectionPages,
    suggestionPagesByType: (...args) => window.PageConfirm.suggestionPagesByType(...args),
    textLayerPages: textLayerPages,
    buildTile: (...args) => window.PageGrid?.buildTile(...args),
    applyTileState: (...args) => window.PageGrid?.applyTileState(...args),
    adoptAllHighSuggestions: (...args) => window.PageDetailEditor?.adoptAllHighSuggestions(...args),
    openPageDetail: (...args) => window.PageDetailDrawer?.openPageDetail(...args),
    openPageNumberPanel: (...args) => window.PageNumberPanel?.openPageNumberPanel(...args),
    openPageNumberReview: (...args) => window.PageNumberPanel?.openPageNumberReview(...args),
    openSplitBatchPanel: (...args) => window.SplitBatchPanel?.openSplitBatchPanel(...args),
    // 刀 6：三段片段的具名能力（⋯ 菜单四项 / 统计入口 / 批量指派两个入口）
    // 模块只碰 view-pages 的 id；`stats-panel` / `assign-panel` 这类全局 chrome id 收在这三个能力里。
    openSuggestionApplyPanel: (...args) => window.SuggestionFlow?.openApplyPanel(...args),
    openWordBoxesDialog: (...args) => window.WordBoxes?.openWordBoxesDialog(...args),
    openBackups: (...args) => window.RecoveryPanels?.openBackups(...args),
    openLayoutDetectDialog: (...args) => window.LayoutDetect?.openLayoutDetectDialog(...args),
    openStatsPanel: openStatsPanel,
    openAssignPanel: (...args) => window.Collab?.openAssignPanel(...args),
    toggleAssignList: (...args) => window.Collab?.toggleAssignList(...args),
    paintTileSuggestionMark: paintTileSuggestionMark,
    // 刀 7：recognizePage 已搬进模块（外壳改调模块导出的同名键）；
    // 这里换上新能力 showPageDetailError（写 #page-detail-error 的那一个动作）
    showPageDetailError: showPageDetailError,
    setMarginJudgementSetting: (...args) => window.SuggestionFlow?.setMarginJudgement(...args),
    setPageZoom: (...args) => window.PageMedia?.setPageZoom(...args),
    busyPages: busyPages,
    setPanelAccordionProject: (value) => { panelAccordionProject = value; return value; },
    setMarginAuditLoading: (value) => { marginAuditLoading = value; return value; },
    setLayoutBlockPayload: (value) => { layoutBlockPayload = value; return value; },
    setLayoutBlockPage: (value) => { layoutBlockPage = value; return value; },
    setMarginFitRunning: (value) => { marginFitRunning = value; return value; },
    setMarginAuditPage: (value) => { marginAuditPage = value; return value; },
    setPageTileMetrics: (value) => { pageTileMetrics = value; return value; },
    setPagesMarginOn: (value) => { pagesMarginOn = value; return value; },
    setPagesOverlayOn: (value) => { pagesOverlayOn = value; return value; },
    setSelectionAnchor: (value) => { selectionAnchor = value; return value; },
    setSetupSuggestions: (value) => { setupSuggestions = value; return value; },
    setSetupSuggestionsLoaded: (value) => { setupSuggestionsLoaded = value; return value; },
    RECOGNITION_ENGINE_LABELS: RECOGNITION_ENGINE_LABELS,
    WORKFLOW_FILTERS: WORKFLOW_FILTERS,
    autoApplyTypeText: (...args) => window.SuggestionFlow?.formatAutoApplyTypes(...args),
    engineProbe: engineProbe,
    flushBootQueue: flushBootQueue,
    getFinishSummaryAgain: () => finishSummaryAgain,
    getFinishSummaryLoading: () => finishSummaryLoading,
    getLastStepPanelKey: () => lastStepPanelKey,
    getLayoutDetectActive: () => layoutDetectActive,
    getPageNumberAnalysis: () => pageNumberAnalysis,
    getPendingPageCount: () => pendingPageCount,
    getStepsReady: () => stepsReady,
    getWorkflowConfirmationCounts: () => workflowConfirmationCounts,
    indexRefresh: () => window.IndexView?.refresh(),   // 刀3：capability 注入（Architect 裁定②），不是顶层函数
    loadPageNumberMetrics: (...args) => window.PageNumberPanel?.loadPageNumberMetrics(...args),
    marginStepVerdict: marginStepVerdict,
    recognitionSetting: recognitionSetting,
    renderFinishPanel: renderFinishPanel,
    setFinishSummary: (value) => { finishSummary = value; return value; },
    setFinishSummaryAgain: (value) => { finishSummaryAgain = value; return value; },
    setFinishSummaryLoading: (value) => { finishSummaryLoading = value; return value; },
    setFinishSummaryProject: (value) => { finishSummaryProject = value; return value; },
    setLastStepPanelKey: (value) => { lastStepPanelKey = value; return value; },
    setStepsReady: (value) => { stepsReady = value; return value; },
    syncWorkflowSteps: syncWorkflowSteps,
    undoAutoApply: (...args) => window.SuggestionFlow?.undoAutoApply(...args),
    updateFinishChips: updateFinishChips,
    PAGE_ZOOM_LEVELS: window.PageMedia?.zoomLevels,
    RESTORE_DETAIL_TEXT: RESTORE_DETAIL_TEXT,
    applyRecognizedPages: applyRecognizedPages,
    confirmAction: confirmAction,
    humanTouchedPages: humanTouchedPages,
    pageImageUrl: (...args) => window.PageMedia?.pageImageUrl(...args),
    pageZoomLevel: (...args) => window.PageMedia?.pageZoomLevel(...args),
    warnUnconfirmed: (...args) => window.PageConfirm.warnUnconfirmed(...args),
    firstUnfinishedPanel: (...args) => window.PageConfirm.firstUnfinishedPanel(...args),
    getJobStartPending: () => jobStartPending,
    getMarginStatusTimer: () => marginStatusTimer,
    getPageNumberStatusTimer: () => pageNumberStatusTimer,
    libraryNotify: () => (...args) => window.LibraryView?.notify(...args),
    matchesTriage: matchesTriage,
    matchesWorkflow: matchesWorkflow,
    pageBlockCacheOrder: pageBlockCacheOrder,
    pageSuggestionOrder: pageSuggestionOrder,
    savePageMarginPreference: (...args) => window.MarginData?.savePageMarginPreference(...args),
    savePageOverlayPreference: savePageOverlayPreference,
    setJobStartBusy: setJobStartBusy,
    setJobStartPending: (value) => { jobStartPending = value; return value; },
    setMarginStatusTimer: (value) => { marginStatusTimer = value; return value; },
    setPageNumberStatusTimer: (value) => { pageNumberStatusTimer = value; return value; },
    setRecStatusTimer: (value) => { recStatusTimer = value; return value; },
  });
  setupReviewAutoPass();
  setupViewerTools();
  setupRecognitionSettings();
  // 任务 94 Slice P2：预览视图模块初始化。deps 只给**句柄**（状态 getter/setter + 页面视图的
  // 叶子函数），不注入值；模块不许把 getter 的返回值缓存到模块级变量（§13 / §20.4）。
  // 4 个 setter 对应唯一有写点的页面视图共享状态（预览与页面视图 / 目录确认共用一份）。
  // 任务 94 Slice I1：目录确认视图模块初始化。deps 只给**句柄**（状态 getter/setter +
  // 仍留在 app.js 的纯数据服务），不注入值；模块不许把 getter 的返回值缓存到模块级变量（§13 / §20.4）。
  window.IndexView?.init({
    // 提示条：index-view.js:468 用 injected.showNoticeBar?.(text)；
    // 缺这个键时可选调用不抛错，只是提示条静默不显示（2026-10-30 补）。
    showNoticeBar: (text) => window.SuggestionFlow?.showNotice(text),
    isActive: () => currentView === "index",
    getProject: () => currentProject,
    getLastDetailPageNo: () => lastDetailPageNo,
    // 图片清晰度档位：外壳持有（页面视图 / 审校 / 预览都读），模块只读 + 走外壳 setter 改
    getImageQualityMode: () => window.PageIndexService?.getImageQuality() || "auto",
    setImageQuality: (mode) => window.PageIndexService?.setImageQuality(mode),
    // 缩放四档（三步共用）
    getPageZoomIndex: () => window.PageMedia?.getPageZoomIndex(),
    setPageZoomIndex: (value) => window.PageMedia?.setPageZoomIndex(value),
    setPageZoomTouched: (value) => window.PageMedia?.setPageZoomTouched(value),
    // 版心 / 块框开关（三步共用）
    getPagesMarginOn: () => pagesMarginOn,
    setPagesMarginOn: (value) => { pagesMarginOn = value; return value; },
    getPagesOverlayOn: () => pagesOverlayOn,
    setPagesOverlayOn: (value) => { pagesOverlayOn = value; return value; },
    savePageMarginPreference: (...args) => window.MarginData?.savePageMarginPreference(...args),
    savePageOverlayPreference: (...args) => savePageOverlayPreference(...args),
    togglePageBlocksOverlay: (...args) => togglePageBlocksOverlay(...args),
    toggleMarginView: (...args) => toggleMarginView(...args),
    // 页码索引缓存（预览也在读同一份）
    getPageIndexData: () => window.PageIndexService?.getData(),
    getPageIndexProject: () => window.PageIndexService?.getProject(),
    getPageIndexLoading: () => window.PageIndexService?.isLoading(),
    loadPageIndex: (...args) => window.PageIndexService?.loadIndex(...args),
    // 页面渲染的共用叶子函数（页面视图、预览、目录三处一套）
    pageImageUrl: (...args) => window.PageMedia?.pageImageUrl(...args),
    pageProfileFor: (...args) => window.PageMedia?.pageProfileFor(...args),
    blockCountedInMargin: (...args) => window.MarginData?.blockCountedInMargin(...args),
    clearTileMargin: (...args) => window.MarginData?.clearTileMargin(...args),
    paintTileMargin: (...args) => window.MarginData?.paintTileMargin(...args),
    loadIndexBlocks: (...args) => window.PageIndexService?.loadBlocks(...args),
    clearImagePlaceholder: (...args) => window.PageIndexService?.clearImagePlaceholder(...args),
    // 导航
    goToWorkflowStep: (...args) => goToWorkflowStep(...args),
    // 常量
    zoomScales: INDEX_ZOOM_SCALES,
    imageWindow: INDEX_IMAGE_WINDOW,
    // 刀 6：页面工具栏两个开关的 is-on 同步（跨视图能力走注入——R2 不许模块直接引用 window.PagesView）
    syncToolbarToggles: () => window.PagesView?.syncToolbarToggles(),
  });
  window.LibraryView?.init({
    apiJson: (...args) => apiJson(...args),
    applyProjectSettings: (...args) => window.SuggestionFlow?.projectSettingsApplied(...args),
    // 刀 7 前置：不再把外壳 id 当字符串递给 closeModal（能力粒度 = 归属域 × 语义动作）
    closeNewProjectMask: () => closeModal("new-project-mask"),
    getExportIncludeNotes: () => el("export-include-notes"),
    getLibraryProjects: () => libraryProjects,
    getMarginFitTried: () => marginFitTried,
    getMarginUndoStack: () => marginUndoStack,
    getNewProjectError: () => el("new-project-modal-error"),
    getNewProjectMask: () => el("new-project-mask"),
    getNewProjectName: () => el("new-project-name"),
    getNewProjectPicker: () => el("new-project-file"),
    getPagesMarginOn: () => pagesMarginOn,
    getPagesOverlayOn: () => pagesOverlayOn,
    getProject: () => currentProject,
    getReviewMarginOn: () => reviewMarginOn,
    getReviewMarginToggle: () => el("review-margin-toggle"),
    lastViewLabels: LAST_VIEW_LABELS,
    // 刀 6：页面工具栏两个开关的 is-on 同步（跨视图能力走注入——R2 不许模块直接引用 window.PagesView）
    syncToolbarToggles: () => window.PagesView?.syncToolbarToggles(),
    loadAutoApplyStatus: (...args) => window.SuggestionFlow?.refreshAutoApplyStatus(...args),
    loadFinishSummary: (...args) => loadFinishSummary(...args),
    loadPageMarginPreference: (...args) => window.MarginData?.loadPageMarginPreference(...args),
    loadPageOverlayPreference: (...args) => loadPageOverlayPreference(...args),
    loadReviewMarginPreference: (...args) => window.MarginData?.loadReviewMarginPreference(...args),
    openPageSetup: (...args) => openPageSetup(...args),
    queueAfterSteps: (...args) => queueAfterSteps(...args),
    refreshProject: (...args) => refreshProject(...args),
    renderRecognitionSettings: (...args) => renderRecognitionSettings(...args),
    resumeLastPosition: (...args) => resumeLastPosition(...args),
    // 刀 10a：调度器已搬进 pages 模块，这里只把事件转过去（键名保持，library 侧不改）
    schedulePageVisibility: () => window.PagesView?.onPagesNeedReflow(),
    setBootingProject: (v) => { bootingProject = v; return v; },
    setLastStepPanelKey: (v) => { lastStepPanelKey = v; return v; },
    setLibraryProjects: (v) => { libraryProjects = v; return v; },
    setMarginSuggestion: (v) => { marginSuggestion = v; return v; },
    setPageZoomTouched: (v) => window.PageMedia?.setPageZoomTouched(v),
    setPagesMarginOn: (v) => { pagesMarginOn = v; return v; },
    setPagesOverlayOn: (v) => { pagesOverlayOn = v; return v; },
    setReviewBlockFilter: (v) => { reviewBlockFilter = v; return v; },
    setReviewMarginOn: (v) => { reviewMarginOn = v; return v; },
    setSetupSuggestions: (v) => { setupSuggestions = v; return v; },
    setSetupSuggestionsLoaded: (v) => { setupSuggestionsLoaded = v; return v; },
    showError: (...args) => showError(...args),
    showLockConflict: (...args) => window.RecoveryPanels?.showLockConflict(...args),
    syncWorkflowSteps: (...args) => syncWorkflowSteps(...args),
    token: token,
  });

  window.MergeView?.init({
    apiJson: (...args) => apiJson(...args),
    // 刀 7 前置：assign-panel 是外壳 chrome，id 不进模块（能力 = 关闭任务包对话框）
    closeAssignPanel: () => closeModal("assign-panel"),
    getAssignError: () => el("assign-error"),
    getMergeState: () => mergeState,
    getProject: () => currentProject,
    loadAssignments: (...args) => window.Collab?.loadAssignments(...args),
    navigate: (...args) => showView(...args),
    refreshProject: (...args) => refreshProject(...args),
    setMergeState: (value) => { mergeState = value; return value; },
    setSaveState: (...args) => setSaveState(...args),
    showError: (...args) => showError(...args),
    token: token,
  });

  // 刀 A：质量统计域模块（服务模块；遮罩开关仍留在本壳的 openStatsPanel 里）
  window.QualityStats?.init({
    list: el("stats-list"),
    note: el("stats-note"),
    apiJson: (...args) => apiJson(...args),
    getCurrentProject: () => currentProject,
    setProjectSummary: (value) => { projectSummary = value; return value; },
    syncWorkflowSteps: (...args) => syncWorkflowSteps(...args),
  });
  // 刀 B：页面确认域模块（纯数据；状态仍归外壳，模块只拿只读访问器）
  window.PageConfirm?.init({
    getCurrentProject: () => currentProject,
    marginBoxOfPage: (...args) => window.MarginData?.marginBoxOfPage(...args),
    recognitionOf: (...args) => recognitionOf(...args),
    getSelectedPages: () => selectedPages,
    getSetupSuggestions: () => setupSuggestions,
  });
  // 刀 C：页码索引 + 清晰度档（状态在模块里；块缓存仍在外壳，借三个回调读写同一份）
  window.PageIndexService?.init({
    apiJson: (...args) => apiJson(...args),
    getCurrentProject: () => currentProject,
    // 三档 radio 由外壳查好给模块（模块自己不碰 DOM ⇒ 域模块闸零豁免）。
    // 这里按 name 查、不点 section 的 id：与搬走前 syncImageQualityUi 的取法逐字相同（R3 不新增引用）。
    getQualityRadios: () => document.querySelectorAll('input[name="reading-quality"]'),
    blocksKey: (pageNo) => window.PageGrid?.pageBlockKey(pageNo),
    blocksGet: (key) => pageBlockCache.get(key),
    blocksRemember: (key, blocks) => window.PageGrid?.rememberPageBlocks(key, blocks),
  });
  // 片 2：块框的卡片构建器（纯函数，只吃 block/index；registry 在 labeled 时才会调它）
  window.OverlayLayer?.init({
    buildLabel: (block, index) => buildBoxLabel(block, index, null),
  });
  // ① S1：页详情编辑面板（root = #view-review；核心抽屉仍在外壳画，画完喊 renderBlocks）
  window.PageDetailEditor?.init({
    root: el("view-review"),
    apiJson: (...args) => apiJson(...args),
    getCurrentProject: () => currentProject,
    // 外壳仍在读写的状态（S1 的 5 份 + S2 的 2 份 + S3 的 detailLayoutConfirmed；
    // 不搬、不存副本，每处读写都走这里）
    getDetailPageNo: () => detailPageNo,
    getReviewBlocks: () => reviewBlocks,
    setActiveReviewBlockId: (value) => { activeReviewBlockId = value; return value; },
    getDetailSuggestionByBlock: () => detailSuggestionByBlock,
    setDetailSuggestionByBlock: (value) => { detailSuggestionByBlock = value; return value; },
    setDetailNumberHints: (value) => { detailNumberHints = value; return value; },
    getCursorByBlock: () => cursorByBlock,
    getDiffStripOpen: () => diffStripOpen,
    getDetailOverlay: () => el("detail-overlay"),
    getDetailCanvas: () => el("detail-canvas"),
    getDetailImage: () => el("detail-image"),
    getDetailInkGaps: () => el("detail-ink-gaps"),
    getBoxCreateMode: () => boxCreateMode,
    setBoxCreateMode: (on) => { boxCreateMode = Boolean(on); return boxCreateMode; },
    getDetailInkGapsState: () => detailInkGaps,
    setDetailInkGapsState: (value) => { detailInkGaps = value; return value; },
    getDetailLayoutConfirmed: () => detailLayoutConfirmed,
    refreshReviewFilterOnly: (...args) => refreshReviewFilterOnly(...args),
    renderReviewHeadline: (...args) => window.PageDetailDrawer?.renderReviewHeadline(...args),
    setReviewBlockFilter: (mode) => { reviewBlockFilter = mode; return mode; },
    setReviewFilterExplicit: (value) => { reviewFilterExplicit = value; return value; },
    // 模块喊外壳的动作（30 个，S4 起含第二引擎复核那一组）
    activateDiff: (...args) => activateDiff(...args),
    blockInsideMargin: (...args) => window.MarginData?.blockInsideMargin(...args),
    computeCharSpans: (...args) => computeCharSpans(...args),
    detailPageRecord: (...args) => detailPageRecord(...args),
    diffLevelLabel: (...args) => diffLevelLabel(...args),
    divergenceOf: (...args) => divergenceOf(...args),
    drawDiffLayer: (...args) => window.PageDetailDrawer?.drawDiffLayer(...args),
    effectiveReviewFilter: (...args) => effectiveReviewFilter(...args),
    ensureBlockListed: (...args) => ensureBlockListed(...args),
    // S4：第二引擎复核（警告框 → 等它跑完 → 回审校）
    engineState: (...args) => engineState(...args),
    enterReviewStep: (...args) => enterReviewStep(...args),
    // aux-warning-* 五个节点在 #view-review 子树外（全屏遮罩）⇒ 只给句柄，模块里不出现 id
    getAuxWarningEls: () => ({
      mask: el("aux-warning-mask"),
      title: el("aux-warning-title"),
      text: el("aux-warning-text"),
      wait: el("aux-warning-wait"),
      error: el("aux-warning-error"),
    }),
    openTaskDrawer: (...args) => openTaskDrawer(...args),
    startTaskPolling: (...args) => startTaskPolling(...args),
    onAuxReviewFinished: (...args) => window.PagesView?.onAuxReviewFinished(...args),
    fetchPageSuggestions: (...args) => fetchPageSuggestions(...args),
    forgetPageBlocks: (...args) => window.PageGrid?.forgetPageBlocks(...args),
    forgetPageSuggestions: (...args) => forgetPageSuggestions(...args),
    loadFinishSummary: (...args) => loadFinishSummary(...args),
    loadPageDetail: (...args) => window.PageDetailDrawer?.loadPageDetail(...args),
    pageNumberSplitHint: (...args) => pageNumberSplitHint(...args),
    pendingPageReasons: (...args) => pendingPageReasons(...args),
    refreshPageStates: (...args) => refreshPageStates(...args),
    renderReviewFilter: (...args) => renderReviewFilter(...args),
    reviewMarginSplit: (...args) => window.MarginData?.reviewMarginSplit(...args),
    scrollViewerTo: (...args) => window.PageDetailDrawer?.scrollViewerTo(...args),
    setSaveState: (...args) => setSaveState(...args),
    structureAction: (...args) => structureAction(...args),
    syncDiffStrip: (...args) => syncDiffStrip(...args),
    updateDiffActive: (...args) => window.PageDetailDrawer?.updateDiffActive(...args),
    // 常量按值注入（不包一层函数）
    BLOCK_TYPE_LABELS,
    TEXT_FREE_BLOCK_TYPES,
    CHROME_BLOCK_TYPES,
    NOTE_BLOCK_TYPES,
    REVIEW_STATUS_LABELS,
    MAX_DIVERGENCE_ROWS,
  });
  // ① 主刀收尾：核心抽屉（root = #view-review，与 editor 同一 root，靠 id 表分家）
  window.PageDetailDrawer?.init({
    root: el("view-review"),
    // 共享状态（外壳声明、外壳也在读写）⇒ 访问器注入，模块不留副本
    getActiveDiff: () => activeDiff,
    getActiveReviewBlockId: () => activeReviewBlockId,
    getBoxCreateMode: () => boxCreateMode,
    getCurrentProject: () => currentProject,
    getDetailInkGaps: () => detailInkGaps,
    getDetailLayoutConfirmed: () => detailLayoutConfirmed,
    getDetailLines: () => detailLines,
    getDetailMargin: () => detailMargin,
    getDetailPageNo: () => detailPageNo,
    getDetailSuggestionByBlock: () => detailSuggestionByBlock,
    getDetailWorkflow: () => detailWorkflow,
    getDiffMarksMode: () => diffMarksMode,
    getDiffStripOpen: () => diffStripOpen,
    getLastDetailPageNo: () => lastDetailPageNo,
    getPageSuggestionCache: () => pageSuggestionCache,
    getProjectId: () => project_id(),
    getReviewBlockFilter: () => reviewBlockFilter,
    getReviewBlocks: () => reviewBlocks,
    getReviewFilterExplicit: () => reviewFilterExplicit,
    getReviewMarginOn: () => reviewMarginOn,
    getReviewTreeItems: () => window.ReviewTree?.getReviewTreeItems(),
    getSuppressBoxClick: () => suppressBoxClick,
    getToken: () => token,
    getZoomLevel: () => zoomLevel,
    setActiveDiff: (value) => { activeDiff = value; return value; },
    setActiveReviewBlockId: (value) => { activeReviewBlockId = value; return value; },
    setDetailLayoutConfirmed: (value) => { detailLayoutConfirmed = value; return value; },
    setDetailLines: (value) => { detailLines = value; return value; },
    setDetailMargin: (value) => { detailMargin = value; return value; },
    setDetailPageNo: (value) => { detailPageNo = value; return value; },
    setDetailWorkflow: (value) => { detailWorkflow = value; return value; },
    setDiffMarksMode: (value) => { diffMarksMode = value; return value; },
    setLastDetailPageNo: (value) => { lastDetailPageNo = value; return value; },
    setSuppressBoxClick: (value) => { suppressBoxClick = value; return value; },
    setZoomLevel: (value) => { zoomLevel = value; return value; },
    // 常量按值注入（不包一层函数）
    CHROME_BLOCK_TYPES, DIFF_LEVELS, HANDLE_CORNERS, PAGE_TYPE_LABELS, TEXT_FREE_BLOCK_TYPES, ZOOM_STEPS,
    // 仍留在外壳的叶子函数 / 能力
    activateDiff: (...args) => activateDiff(...args),
    aggregateDivergence: (...args) => aggregateDivergence(...args),
    apiJson: (...args) => apiJson(...args),
    applyBoxElementRect: (...args) => applyBoxElementRect(...args),
    applyMarginRect: (...args) => window.MarginData?.applyMarginRect(...args),
    attachRenderErrorDetail: (...args) => window.PageTile?.attachRenderErrorDetail?.(...args),
    blockCountedInMargin: (...args) => window.MarginData?.blockCountedInMargin(...args),
    blockInsideMargin: (...args) => window.MarginData?.blockInsideMargin(...args),
    boxTypeLabel: (...args) => boxTypeLabel(...args),
    buildBoxLabel: (...args) => buildBoxLabel(...args),
    buildBoxOrder: (...args) => buildBoxOrder(...args),
    detailPageRecord: (...args) => detailPageRecord(...args),
    diffLevelLabel: (...args) => diffLevelLabel(...args),
    divergenceOf: (...args) => divergenceOf(...args),
    ensureBlockListed: (...args) => ensureBlockListed(...args),
    globalMarginIsAuto: (...args) => globalMarginIsAuto(...args),
    layoutOverlay: (...args) => window.OverlayLayer?.layout?.(...args),
    lineDiffSpanCount: (...args) => lineDiffSpanCount(...args),
    marginBoxOfPage: (...args) => window.MarginData?.marginBoxOfPage(...args),
    matchesTriage: (...args) => matchesTriage(...args),
    recognitionOf: (...args) => recognitionOf(...args),
    renderHistoryButtons: (...args) => renderHistoryButtons(...args),
    renderReviewBanner: (...args) => renderReviewBanner(...args),
    renderReviewWorkflowStatus: (...args) => renderReviewWorkflowStatus(...args),
    runPageAux: (...args) => runPageAux(...args),
    savePosition: (...args) => savePosition(...args),
    saveReviewMarginPreference: (...args) => window.MarginData?.saveReviewMarginPreference(...args),
    scheduleDetailOverlayLayout: (...args) => scheduleDetailOverlayLayout(...args),
    setReviewBlockFilter: (value) => { reviewBlockFilter = value; return value; },
    setReviewBlocks: (value) => { reviewBlocks = value; return value; },
    setReviewFilterExplicit: (value) => { reviewFilterExplicit = value; return value; },
    setReviewMarginOn: (value) => { reviewMarginOn = value; return value; },
    setSaveState: (...args) => setSaveState(...args),
    showView: (...args) => showView(...args),
    startBoxDrag: (...args) => startBoxDrag(...args),
    stepPage: (...args) => stepPage(...args),
    syncReviewTreeToPage: (...args) => window.ReviewTree?.syncReviewTreeToPage(...args),
    treeItemsFromBlocks: (...args) => window.ReviewTree?.treeItemsFromBlocks(...args),
    // editor 的能力（模块→模块一律经外壳接线，不直呼 window.PageDetailEditor）
    applyDetailSuggestions: (...args) => window.PageDetailEditor?.applyDetailSuggestions(...args),
    clearPageDetailError: (...args) => window.PageDetailEditor?.clearPageDetailError(...args),
    closeAuxPanel: (...args) => window.PageDetailEditor?.closeAuxPanel(...args),
    highlightActiveDiff: (...args) => window.PageDetailEditor?.highlightActiveDiff(...args),
    selectReviewBlock: (...args) => window.PageDetailEditor?.selectReviewBlock(...args),
    setEditorBoxCreateMode: (...args) => window.PageDetailEditor?.setBoxCreateMode(...args),
    setEditorPackageModeChrome: (...args) => window.PageDetailEditor?.setPackageModeChrome(...args),
    showPageDetailError: (...args) => window.PageDetailEditor?.showPageDetailError(...args),
    truncate: (...args) => window.PageDetailEditor?.truncate(...args),
    // 单一回路：抽屉画完喊这一声，由外壳把 blocks 交给编辑器
    onPageDetailChanged: (data) => onPageDetailChanged(data),
  });
  // 接线必须在 init 之后：模块的 part() 要 root 已经交进去（在 init 之前调 = null.addEventListener）
  window.PageDetailDrawer?.setupReviewPager();

/**
 * 抽屉画完自己的 DOM 之后喊这一次：由外壳把 blocks 交给编辑器（**单一回路**）。
 * 全仓 `onPageDetailChanged(` 的调用点恰好一处（抽屉里）；这里只做接线，不加第二处调用。
 */
function onPageDetailChanged(data) {
  window.PageDetailEditor?.renderBlocks(data.blocks);
  // 默认把第一个有差异的块设为当前块（展开差异条，但不抢滚动位置）
  const firstDiffBlock = (data.blocks || []).find((block) => blockHasDrawableDiff(block));
  if (firstDiffBlock) window.PageDetailEditor?.selectReviewBlock(firstDiffBlock.block_id, { scroll: false });
  window.PageDetailEditor?.renderSuggestionTools();
  window.PageDetailEditor?.renderLayoutPanel(data);
}
  // 三栏拖动由 reading-view.js 的 init() 负责（任务 94），这里不再重复绑定
  setupPageMore();
  // ③ 导出面板（root = #export-panel 那个顶层 modal；模块不碰 document 级查询）
  window.ExportPanel?.init({
    root: el("export-panel"),
    apiJson: (...args) => apiJson(...args),
    getCurrentProject: () => currentProject,
    getProjectExports: () => projectExports,
    setProjectExports: (value) => { projectExports = value; return value; },
    getToken: () => token,
    showError: (node, error) => showError(node, error),
    fillDefinitionList: (node, rows) => fillDefinitionList(node, rows),
    syncWorkflowSteps: (...args) => syncWorkflowSteps(...args),
    parsePageRange: (...args) => parsePageRange(...args),
    // 跨视图服务已搬进 suggestion-flow.js：这两件改指模块导出（本刀之前是临时注入）。
    // dismissMarginJudgementNotice / getMarginJudgementOk 已删——chrome 那个按钮的接线
    // 搬进 suggestion-flow.js 的 init（节点由它注入），导出模块不再碰 chrome 的节点。
    marginJudgementOn: (...args) => window.SuggestionFlow?.marginJudgementEnabled(...args),
    setMarginJudgementSetting: (...args) => window.SuggestionFlow?.setMarginJudgement(...args),
    attachRenderErrorDetail: (...args) => window.PageTile?.attachRenderErrorDetail?.(...args),
    BLOCK_TYPE_LABELS,
    ApiError,
  });
  window.ExportPanel?.setupPanel();
  // 刀 D：结构工具（17 个 structure-* 全在 #structure-panel 子树里，root 交给模块）
  window.StructureTools?.init({
    root: el("structure-panel"),
    apiJson: (...args) => apiJson(...args),
    getCurrentProject: () => currentProject,
    // apply() 之后的两件事由外壳给：页面数据重拉 + 导出预检；顺序在模块里（请求 → 读回 → 后处理）
    afterApply: async () => {
      await window.PagesView?.onProjectPagesReloaded();
      await window.ExportPanel?.refreshPreflight();
    },
  });
  window.StructureTools?.setup();
  showView("library");
  window.PageIndexService?.loadImageQuality();
  window.PageIndexService?.syncImageQualityUi();
  // 任务 94 Slice I1：#index-quality 的按钮文字归目录视图模块，
  // 外壳把档位读出来之后喊它一声（原来那两行由 syncImageQualityUi 直接写，R3 不越界了）。
  window.IndexView?.refresh();
  loadAppInfo();
  window.LibraryView?.enter();
}

boot();
