/**
 * 跨视图服务：建议流程 —— `window.SuggestionFlow`
 *
 * 这一块原来散在 app.js 里（16 函数），它不是"某一个 section 的服务"，而是**跨 5 个视图的流程**：
 * 通知条 / 自动应用状态 / 全库采用建议 / 版心判定开关。宿主不是一块 DOM，是**三处**：
 *
 *   ① 自己的 root：`#suggestion-apply-panel`（顶层 mask，5 个 id 全在子树里）⇒ `part()`
 *   ② chrome 通知条：`auto-apply-notice(-text/-undo/-dismiss)` 与 `margin-judgement-notice(-ok)`
 *      是 `body` 下四个**兄弟** noticebar，没有共同 id 祖先 ⇒ 只能经 `getNoticeEls()` 注入，
 *      本模块里不出现那 6 个 id（给它们包一层 div 会改布局，不做）
 *   ③ `#view-review` 的「全库采用」按钮（`review-apply-all`）：节点归视图，接线归本模块
 *      ⇒ 经 `getReviewApplyAll()` 注入（同 `pages-view.js` 里「按钮 DOM 归视图、接线归模块」的既有做法）
 *
 * 另外两处节点**不归本模块**（本刀之前 app.js 直接写它们，现在改成动作返回结果）：
 *   · `#export-margin-judgement` / `#export-error` 在 `#export-panel` 子树 ⇒ 导出模块自己渲染
 *   · `#page-detail-error` 在 `#view-review` 子树 ⇒ 走注入的 `showPageDetailError()`
 *     （`page-detail-editor.js` 已裁定是它的唯一写入口，本刀不新增所有权）
 *
 * 状态：只有 `autoApplyAnnouncedId` 一份真状态（读写都在本模块）。
 * 本刀删掉两份死状态（同 S4 的 `auxData` 型：只写不读）：
 *   · `suggestionApplyPlan`：写 1 处、读 0 处（`runSuggestionApply` 重新 POST，不读扫描结果）
 *   · `latestAutoApply`（连注入键 `setLatestAutoApply`）：写 1 处、读 0 处
 *
 * **init 顺序**（单向，写进这里防止下一个人绕成环）：`SuggestionFlow.init` 先装，
 * `ExportPanel.init` 后装——导出模块要本模块的 `marginJudgementEnabled` / `setMarginJudgement`；
 * 本模块要导出模块的 `refreshPreflight`，经注入的 `refreshExportPreflight()`
 * （外壳给的是惰性箭头 `() => window.ExportPanel?.refreshPreflight()`，调用时才解引用）。
 * 模块里除自己的 `window.SuggestionFlow = api` 外，不出现任何 `window.<模块名>`。
 */
(function () {
  "use strict";

  let injected = {};
  let root = null;

  const part = (id) => (root ? root.querySelector(`#${id}`) : null);
  const project = () => injected.getCurrentProject();
  /** chrome 通知条那 6 个节点：每次现取，不缓存（与 `page-detail-editor.js` 的 aux 遮罩同一形态）。 */
  const noticeEls = () => injected.getNoticeEls() || {};

  // ---------------------------------------------------------------- 本模块的唯一真状态
  /** 已经提示过的自动应用 id：同一个不重复弹。 */
  let autoApplyAnnouncedId = null;

  // ---------------------------------------------------------------- 版心判定（任务 34 / 51）
  /** 按版心判定正文默认开；只有显式存了 false 才是关。这个规则全仓只有这一处。 */
  function marginJudgementEnabled() {
    const current = project();
    const settings = (current && current.settings) || {};
    const value = settings.margin_box_judgement;
    return value === undefined || value === null ? true : Boolean(value);
  }

  /**
   * 项目设置变了：同步到各视图的控件上（外壳与视图模块只喊这一声）。
   * 值由本模块算（默认开那条规则不复制到别处）；只写本模块与该喊的模块，不写别人的节点。
   */
  function projectSettingsApplied() {
    const current = project();
    const settings = (current && current.settings) || {};
    // pages 面板上的两个勾选态收成能力（值算好交给它，规则不搬过去）
    injected.syncPagesProjectSettings({
      autoApply: Boolean(settings.auto_apply_high_suggestions),
      marginJudgement: marginJudgementEnabled(),
    });
    // 导出面板里那个同名的开关：节点在 #export-panel 子树里 ⇒ 归导出模块自己写
    // （它每次预检都会按真实设置同步勾选态；本模块只在设置改成功时喊一声 refreshPreflight）
    // 识别设置（任务 54）：引擎 / DPI / 语言 / 双引擎策略
    injected.renderRecognitionSettings();
    renderMarginJudgementNotice();
  }

  /** 默认打开「按版心判定」后，老项目第一次打开给一句说明。 */
  function renderMarginJudgementNotice() {
    const bar = noticeEls().margin;
    if (!bar) return;
    const current = project();
    const settings = (current && current.settings) || {};
    bar.hidden = Boolean(settings.margin_judgement_notice) || !marginJudgementEnabled();
  }

  async function dismissMarginNotice() {
    const bar = noticeEls().margin;
    if (bar) bar.hidden = true;
    const current = project();
    if (!current) return;
    try {
      const data = await injected.apiJson(`/api/projects/${current.project_id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ margin_judgement_notice: true }),
      });
      current.settings = data.settings;
    } catch {
      /* 提示关不掉不该影响使用 */
    }
  }

  /**
   * 项目级「按版心判定正文」（任务 51 / 34）。**默认开**；显式关掉才按块类型判定。
   *
   * **返回结果、不写别人的 DOM**：成功 `{ ok: true }`，失败 `{ ok: false, error }`。
   * 勾选态回滚与错误渲染由**拥有节点的那个模块**做（导出面板写 `#export-error`、
   * 页面视图写自己的错误条），本动作只回答「设置改没改成」。
   */
  async function setMarginJudgement(enabled) {
    const current = project();
    if (!current) return { ok: false, error: null };
    try {
      const data = await injected.apiJson(`/api/projects/${current.project_id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ margin_box_judgement: Boolean(enabled) }),
      });
      current.settings = data.settings;
      projectSettingsApplied();
      await injected.refreshExportPreflight();
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  // ---------------------------------------------------------------- 通知条
  /** 带「撤销这次自动应用」按钮的提示条（只有自动应用那一类用它）。 */
  function showUndoableNotice(text, undoId) {
    const els = noticeEls();
    if (els.text) els.text.textContent = text;
    if (els.autoApply) {
      els.autoApply.hidden = false;
      els.autoApply.dataset.autoApplyId = undoId || "";
    }
    if (els.undo) els.undo.hidden = !undoId;
  }

  /** 纯提示（读书 / 目录 / 预览 / 生成稿都喊这一个）。 */
  function showNotice(text) {
    showUndoableNotice(text, null);
  }

  function dismissAutoApplyNotice() {
    const els = noticeEls();
    if (els.autoApply) els.autoApply.hidden = true;
  }

  /** 块类型计数的中文拼装（「页眉 12 / 页脚 3」）。纯函数，页面视图也用它拼右栏那行。 */
  function formatAutoApplyTypes(byType) {
    const labels = { header: "页眉", footer: "页脚", page_number: "页码", margin_note: "旁批" };
    return Object.entries(byType || {})
      .map(([type, count]) => `${labels[type] || type} ${count}`)
      .join(" / ");
  }

  // ---------------------------------------------------------------- 自动应用状态
  /** 读一次「最近一次自动应用」并刷页面视图的角标（打开项目 / 撤销之后用）。 */
  async function refreshAutoApplyStatus() {
    const current = project();
    if (!current || current.kind === "package") return null;
    let data;
    try {
      data = await injected.apiJson(`/api/projects/${current.project_id}/auto-apply`);
    } catch {
      return null;
    }
    const run = data.latest || null;
    injected.onAutoApplyStatusChanged(run);
    if (run) autoApplyAnnouncedId = run.auto_apply_id;
    return run;
  }

  /**
   * 任务收尾：查「这一趟有没有新的自动应用」，有新的一条就弹提示。
   * 与 `refreshAutoApplyStatus()` 是两个动作，不是一个带布尔的函数——
   * 一个是「刷新状态」，一个是「刚跑完一个 job，等着播报它的结果」，调用点不同、失败也不同。
   */
  async function announceAutoApplyAfterJob({ jobId } = {}) {
    const current = project();
    if (!current || current.kind === "package") return;
    if (!jobId) return;
    let data;
    try {
      data = await injected.apiJson(`/api/projects/${current.project_id}/auto-apply`);
    } catch {
      return;
    }
    const run = data.latest || null;
    injected.onAutoApplyStatusChanged(run);
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
      setTimeout(() => announceAutoApplyAfterJob({ jobId }), 900);
    }
  }

  function showAutoApplyNotice(run) {
    showUndoableNotice(
      `识别完成后自动应用了 ${run.pages} 页 ${run.blocks} 块（${formatAutoApplyTypes(run.by_type)}）。` +
        "不满意可以整批撤销。",
      run.auto_apply_id
    );
  }

  /** 类型变了之后统一收尾：丢块框缓存 / 建议缓存，就地刷新状态。 */
  function refreshAfterTypeChanges(pageNos) {
    if (pageNos && pageNos.length) {
      for (const pageNo of pageNos) injected.forgetPageBlocks(pageNo);
    } else {
      injected.onPageBlocksInvalidated();
    }
    injected.onPageSuggestionsInvalidated();
    injected.refreshPageStates();
    injected.onPagesNeedReflow();
  }

  async function undoAutoApply(autoApplyId) {
    const current = project();
    if (!current || !autoApplyId) return;
    try {
      const data = await injected.apiJson(
        `/api/projects/${current.project_id}/auto-apply/${autoApplyId}/undo`,
        { method: "POST" }
      );
      dismissAutoApplyNotice();
      refreshAfterTypeChanges(data.pages_affected || []);
      const detailPageNo = injected.getDetailPageNo();
      if (detailPageNo !== null) await injected.loadPageDetail(detailPageNo, { forceSuggestions: true });
      await refreshAutoApplyStatus();
      notifyApplied(
        `已撤销这次自动应用（${data.pages} 页 ${data.blocks} 块），块类型回到自动应用之前。`
      );
    } catch (error) {
      // 审校面板的错误条：节点归 page-detail-editor.js，本模块经注入调它的唯一写入口
      injected.showPageDetailError(error);
    }
  }

  /** 结果提示：页面视图用右栏的提示条，审校视图用顶栏的保存状态。 */
  function notifyApplied(text) {
    // 顶部提示条比右栏的临时提示更持久（右栏那行会被 updateSelectionPanel 重画）
    showNotice(text);
    injected.setSaveState(text);
  }

  // ---------------------------------------------------------------- 全库采用建议
  async function openApplyPanel() {
    const current = project();
    if (!current) return;
    part("suggestion-apply-error").hidden = true;
    part("suggestion-apply-summary").textContent = "正在扫描全部正文页…";
    part("suggestion-apply-types").innerHTML = "";
    part("suggestion-apply-samples").innerHTML = "";
    part("suggestion-apply-run").disabled = true;
    part("suggestion-apply-run").textContent = "应用";
    injected.openModal("suggestion-apply-panel");
    try {
      const data = await injected.apiJson(
        `/api/projects/${current.project_id}/suggestions/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dry_run: true }),
        }
      );
      renderSuggestionApplyPreview(data);
    } catch (error) {
      part("suggestion-apply-summary").textContent = "扫描失败";
      injected.showError(part("suggestion-apply-error"), error);
    }
  }

  function renderSuggestionApplyPreview(data) {
    const blocks = data.blocks || 0;
    const pages = data.pages || 0;
    const labels = injected.BLOCK_TYPE_LABELS || {};
    part("suggestion-apply-summary").textContent = blocks
      ? `扫描了 ${data.pages_scanned} 页 / ${data.blocks_scanned} 块：会改 ${pages} 页 · ${blocks} 块`
      : `扫描了 ${data.pages_scanned} 页 / ${data.blocks_scanned} 块：没有需要改的块（已经都是对的，或者都还"需确认"）`;
    const types = part("suggestion-apply-types");
    types.innerHTML = "";
    for (const [type, count] of Object.entries(data.by_type || {})) {
      const pill = document.createElement("span");
      pill.className = `suggestion-type suggestion-type--${type}`;
      pill.textContent = `${labels[type] || type} ${count}`;
      types.append(pill);
    }
    const list = part("suggestion-apply-samples");
    list.innerHTML = "";
    for (const item of data.samples || []) {
      const li = document.createElement("li");
      li.textContent =
        `第 ${item.page_no} 页 · ${labels[item.current_type] || item.current_type}` +
        ` → ${labels[item.suggested_type] || item.suggested_type}：${item.text}`;
      list.append(li);
    }
    const run = part("suggestion-apply-run");
    run.disabled = blocks === 0;
    run.textContent = blocks ? `应用（${blocks} 块）` : "没有可应用的";
  }

  async function runSuggestionApply() {
    const current = project();
    if (!current) return;
    const button = part("suggestion-apply-run");
    button.disabled = true;
    button.textContent = "正在应用…";
    try {
      const data = await injected.apiJson(
        `/api/projects/${current.project_id}/suggestions/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dry_run: false }),
        }
      );
      injected.closeModal("suggestion-apply-panel");
      refreshAfterTypeChanges(data.pages_affected || []);
      const detailPageNo = injected.getDetailPageNo();
      if (detailPageNo !== null && (data.pages_affected || []).includes(detailPageNo)) {
        await injected.loadPageDetail(detailPageNo, { forceSuggestions: true });
      }
      notifyApplied(
        `已采用 ${data.blocks} 块高把握建议（${data.pages} 页，第 ${data.history.undo} 个可撤销操作）。` +
          "整批可撤销：审校视图点「撤销」。"
      );
    } catch (error) {
      injected.showError(part("suggestion-apply-error"), error);
      button.disabled = false;
      button.textContent = "重试应用";
    }
  }

  // ---------------------------------------------------------------- 接线（一次装好）
  function setupControls() {
    const els = noticeEls();
    if (els.undo) {
      els.undo.addEventListener("click", () => {
        const id = (els.autoApply && els.autoApply.dataset.autoApplyId) || "";
        undoAutoApply(id);
      });
    }
    if (els.dismiss) els.dismiss.addEventListener("click", dismissAutoApplyNotice);
    if (els.marginOk) els.marginOk.addEventListener("click", dismissMarginNotice);
    // 审校页的「全库采用」按钮：节点在 #view-review 子树里，接线归本模块
    const reviewApplyAll = injected.getReviewApplyAll();
    if (reviewApplyAll) reviewApplyAll.addEventListener("click", openApplyPanel);
    if (!root) return;
    for (const id of ["suggestion-apply-close", "suggestion-apply-cancel"]) {
      const closer = part(id);
      if (closer) closer.addEventListener("click", () => injected.closeModal("suggestion-apply-panel"));
    }
    const run = part("suggestion-apply-run");
    if (run) run.addEventListener("click", runSuggestionApply);
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || null;
    setupControls();
    return api;
  }

  const api = {
    init,
    // 版心判定：导出模块要前两个，页面视图要第二个（两个开关都喊它）
    marginJudgementEnabled,
    setMarginJudgement,
    // 项目设置同步（library / pages 打开项目后各喊一次）
    projectSettingsApplied,
    // 自动应用状态：两个动作，不是一个带布尔的函数
    refreshAutoApplyStatus,
    announceAutoApplyAfterJob,
    undoAutoApply,
    notifyApplied,
    formatAutoApplyTypes,
    // 通知条：纯提示一个名字（带撤销按钮那种只在本模块内部用）
    showNotice,
    // 全库采用建议（右栏入口 + 审校页按钮）
    openApplyPanel,
  };
  window.SuggestionFlow = api;
})();
