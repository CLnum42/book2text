/**
 * 协作（任务包 / 分派）—— `window.Collab`
 *
 * **两个 root，按宿分组**（不是 "#view-merge"——实测那棵子树里协作的 id 是 0 个）：
 *   ① `#assign-panel`（顶层 mask）16 个 id：分派对话框（assigned-* / result-file-input）
 *   ② `#package-result`（顶层 mask）3 个 id：审校结果包对话框（meta / files / export-btn）
 * 两个都是本模块真正拥有的 DOM，所以都作 root；`assignPart()` / `resultPart()` 只在各自子树里查。
 *
 * **外部节点 4 个**（chrome 顶栏与通知条，没有共同根、也不归本模块）⇒ 一组注入 `getChromeEls()`：
 *   打开任务包（input + 按钮）、导出审校结果按钮、任务包横幅。模块里不出现这 4 个 id 字符串。
 *
 * **两处显隐归外壳**（Chief 2026-11-02 裁定）：`structure-open` 在 `#export-panel` 子树里、
 * `finish-open-review` 在 `#view-review` 子树里，两个都不归本模块、也不注入 ⇒
 * `applyPackageMode()` **返回结果** `{ ok, packageMode }`，由唯一调用点（外壳 hydrate）写那两个节点。
 *
 * 状态：3 份纯私有（currentAssignments / packagePending / …）；
 * `mergeState` 是**外壳在读**的共享状态（合并视图模块经外壳取）⇒ 走注入的 get/set，模块不留副本。
 * 本刀删掉一份死状态（同 `auxData` 型，只写不读）：`assignPreviewData`（写 1 处、读 0 处）。
 *
 * 13 处写盘全部在模块内闭环：每个动作 "请求 → 读回 → 重画自己那两个 root"，外壳不编排顺序。
 * 跨模块的六个动作按语义命名注入（不许合成万能键）：
 *   libraryNotify(payload) / libraryEnter() / libraryOpen(projectId) / mergeEnter(assignmentId) /
 *   pagesPackageModeChrome(on) / editorPackageModeChrome(on)
 */
(function () {
  "use strict";

  let injected = {};
  let roots = { assign: null, result: null };

  /** 分派对话框子树（root ①）。 */
  const assignPart = (id) => (roots.assign ? roots.assign.querySelector(`#${id}`) : null);
  /** 审校结果包对话框子树（root ②）。 */
  const resultPart = (id) => (roots.result ? roots.result.querySelector(`#${id}`) : null);
  /** chrome 的 4 个节点：每次现取，不缓存（同 aux 遮罩 / 通知条的形态）。 */
  const chromeEls = () => injected.getChromeEls() || {};
  const project = () => injected.getCurrentProject();

  // ---------------------------------------------------------------- 本模块自己的状态
  /** 分派列表（GET /assignments 的结果）。 */
  let currentAssignments = [];
  /** 等待上传的结果包给哪个任务包（导入时用）。 */
  let packagePending = null;

  function assignRequestBody() {
    return {
      pages: [...injected.getSelectedPages()].sort((left, right) => left - right),
      reviewer_name: assignPart("assign-reviewer").value.trim(),
      with_context: assignPart("assign-context").checked,
    };
  }

  async function openAssignPanel() {
    if (!project()) return;
    roots.assign.hidden = false;
    assignPart("assign-error").hidden = true;
    const pages = assignRequestBody().pages;
    assignPart("assign-meta").textContent = pages.length
      ? `选中的第 ${pages[0]}–${pages[pages.length - 1]} 页（${pages.length} 页）`
      : "先在页面网格里选中要分派的页面";
    await previewAssign();
    await loadAssignments();
  }

  async function previewAssign() {
    if (!project()) return;
    const body = assignRequestBody();
    if (!body.pages.length) {
      assignPart("assign-preview").textContent = "还没有选中页面。";
      return;
    }
    try {
      const data = await injected.apiJson(
        `/api/projects/${injected.getProjectId()}/assignments/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      // 预览结果只用来画这一屏（原来还存一份 `assignPreviewData`，写 1 读 0 ⇒ 本刀删）
      renderAssignPreview(data);
    } catch (error) {
      injected.showError(assignPart("assign-error"), error);
    }
  }

  function renderAssignPreview(data) {
    const list = assignPart("assign-reviewer-names");
    list.innerHTML = "";
    for (const name of data.known_reviewers || []) {
      const option = document.createElement("option");
      option.value = name;
      list.append(option);
    }

    const box = assignPart("assign-preview");
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
    assignPart("assign-create").disabled = !data.page_count || !assignPart("assign-reviewer").value.trim();
  }

  async function createAssignment() {
    if (!project()) return;
    assignPart("assign-error").hidden = true;
    const body = {
      ...assignRequestBody(),
      note: assignPart("assign-note").value,
      due_date: assignPart("assign-due").value || null,
    };
    try {
      const data = await injected.apiJson(`/api/projects/${injected.getProjectId()}/assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      injected.setSaveState(`任务包已生成：${data.package_name}`);
      assignPart("assign-download").hidden = false;
      assignPart("assign-reveal").hidden = false;
      assignPart("assign-download").dataset.assignmentId = data.assignment.assignment_id;
      assignPart("assign-reveal").dataset.assignmentId = data.assignment.assignment_id;
      await loadAssignments();
      await injected.refreshPageStates();
    } catch (error) {
      injected.showError(assignPart("assign-error"), error);
    }
  }

  async function loadAssignments() {
    if (!project()) return;
    try {
      const data = await injected.apiJson(`/api/projects/${injected.getProjectId()}/assignments`);
      currentAssignments = data.assignments || [];
      renderAssignments(data.known_reviewers || []);
    } catch (error) {
      injected.showError(assignPart("assign-error"), error);
    }
  }

  function renderAssignments(knownReviewers) {
    const list = assignPart("assign-list");
    list.innerHTML = "";
    assignPart("assign-list-empty").hidden = currentAssignments.length > 0;
    const names = assignPart("assign-reviewer-names");
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
          button("查看差异", "打开合并审阅视图", () => injected.mergeEnter(id));
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
      `/api/projects/${injected.getProjectId()}/assignments/${assignmentId}/package?token=${encodeURIComponent(injected.getToken())}`,
      { headers: { "X-B2T-Token": injected.getToken() } }
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      injected.showError(assignPart("assign-error"), new injected.ApiError(
        (payload && payload.error && payload.error.message) || `下载失败（HTTP ${response.status}）`
      ));
      return;
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename\*?=(?:utf-8'')?"?([^";]+)"?/i);
    saveBlob(blob, match ? decodeURIComponent(match[1]) : "任务包.b2tpkg");
    injected.setSaveState("任务包已下载");
  }

  async function rebuildPackage(assignmentId) {
    assignPart("assign-error").hidden = true;
    try {
      const data = await injected.apiJson(
        `/api/projects/${injected.getProjectId()}/assignments/${assignmentId}/rebuild`,
        { method: "POST" }
      );
      injected.setSaveState(`已重新导出：${data.package_name}`);
    } catch (error) {
      injected.showError(assignPart("assign-error"), error);
    }
  }

  async function revealPackage(assignmentId) {
    try {
      const data = await injected.apiJson(
        `/api/projects/${injected.getProjectId()}/assignments/${assignmentId}/reveal`,
        { method: "POST" }
      );
      if (!data.revealed) injected.setSaveState(data.reason || "打不开文件夹", true);
    } catch (error) {
      injected.showError(assignPart("assign-error"), error);
    }
  }

  async function cancelAssignment(assignmentId) {
    if (!confirm("作废这个任务包？页面会恢复为未分派；之后收到的结果需要明确确认才能导入。")) {
      return;
    }
    assignPart("assign-error").hidden = true;
    try {
      await injected.apiJson(
        `/api/projects/${injected.getProjectId()}/assignments/${assignmentId}/cancel`,
        { method: "POST" }
      );
      injected.setSaveState("任务包已作废");
      await loadAssignments();
      await injected.refreshPageStates();
    } catch (error) {
      injected.showError(assignPart("assign-error"), error);
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

  // ---------------------------------------------------------------- 助手端：任务包
  function setupPackageControls() {
    const els = chromeEls();
    if (els.openPackageFile) {
      els.openPackage?.addEventListener("click", () => els.openPackageFile.click());
      els.openPackageFile.addEventListener("change", () => {
        const picker = els.openPackageFile;
        if (picker.files && picker.files[0]) openPackageFile(picker.files[0]);
        picker.value = "";
      });
    }
    resultPart("package-export-btn")?.addEventListener("click", exportResultPackage);
    assignPart("result-file-input")?.addEventListener("change", onResultFileChosen);
  }

  async function openPackageFile(file) {
    injected.libraryNotify({ kind: "error", text: "" });
    injected.setSaveState("正在打开任务包…");
    try {
      const response = await fetch(
        `/api/packages/open?filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "X-B2T-Token": injected.getToken(), "Content-Type": "application/zip" },
          body: file,
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = (payload && payload.error) || {};
        throw new injected.ApiError(
          error.message || `打开失败（HTTP ${response.status}）`,
          error.code,
          error.correlation_id,
          error.detail
        );
      }
      injected.setSaveState("");
      await injected.libraryEnter();
      await injected.libraryOpen(payload.project.project_id);
    } catch (error) {
      injected.libraryNotify({ kind: "error", error: error });
    }
  }

  /**
   * 包模式：本模块自己那两个 root 与 4 个 chrome 节点按模式显隐，
   * 并通知页面视图 / 审校面板同步它们自己的入口。
   *
   * **返回 `{ ok, packageMode }`**：`structure-open`（在 `#export-panel` 子树里）与
   * `finish-open-review`（在 `#view-review` 子树里）两个节点的显隐归外壳写——
   * 它们不归本模块、也不注入（Chief 2026-11-02 裁定）。动作只回答"是不是包模式"。
   */
  async function applyPackageMode() {
    const current = project();
    if (!current) return { ok: false, packageMode: false };
    const els = chromeEls();
    const isPackage = current.kind === "package";
    if (!isPackage) {
      if (els.banner) els.banner.hidden = true;
      if (els.packageOpen) els.packageOpen.hidden = true;
      injected.closeModal("package-result");
      injected.pagesPackageModeChrome(false);
      injected.syncWorkflowSteps();
      return { ok: true, packageMode: false };
    }

    if (els.packageOpen) els.packageOpen.hidden = false; // 但能导出审校结果包
    injected.closeFinishPanel();
    // 页面板上的 10 个入口 / 审校面板自己那两个入口
    injected.pagesPackageModeChrome(true);
    injected.syncWorkflowSteps();
    injected.editorPackageModeChrome(true);

    try {
      const data = await injected.apiJson(`/api/projects/${current.project_id}/package`);
      const info = data.package;
      const banner = els.banner;
      if (banner) {
        banner.hidden = false;
        banner.textContent =
          `审校任务：第 ${info.page_nos.join("、")} 页` +
          (info.context_page_nos.length
            ? `（另附只读上下文第 ${info.context_page_nos.join("、")} 页）`
            : "") +
          ` · 来自 ${info.owner_name || "负责人"}` +
          (info.due_date ? ` · 截止 ${info.due_date}` : "") +
          (info.note ? ` · 说明：${info.note}` : "");
      }
      resultPart("package-result-meta").textContent = `${info.book_name} · 审校人 ${info.reviewer_name}`;
      await loadPackageResults(current.project_id);
    } catch (error) {
      injected.libraryNotify({ kind: "error", error: error });
    }
    return { ok: true, packageMode: true };
  }

  async function loadPackageResults(projectId) {
    try {
      const data = await injected.apiJson(`/api/projects/${projectId}/package/results`);
      const list = resultPart("package-result-files");
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
      const box = resultPart("package-result-files");
      if (box) injected.showError(box, error);
      else injected.libraryNotify({ kind: "error", error: error });
    }
  }

  async function exportResultPackage() {
    const current = project();
    if (!current) return;
    resultPart("package-result-meta").textContent = "导出中…";
    try {
      const data = await injected.apiJson(`/api/projects/${current.project_id}/package/result`, {
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
      alert(
        `结果包已生成：${data.file_name}\n\n${lines.join("\n")}\n\n` +
          "用下面的「下载」把它发给负责人。"
      );
      await loadPackageResults(current.project_id);
      // 成功分支也要写终态：每个设了"进行中"文案的动作，成功与失败都要落到终态
      resultPart("package-result-meta").textContent = `已生成 ${data.file_name}，可在下面下载`;
    } catch (error) {
      injected.showError(resultPart("package-result-meta"), error);
    }
  }

  async function downloadResultPackage(projectId, fileName) {
    const response = await fetch(
      `/api/projects/${projectId}/package/results/${encodeURIComponent(fileName)}` +
        `?token=${encodeURIComponent(injected.getToken())}`,
      { headers: { "X-B2T-Token": injected.getToken() } }
    );
    if (!response.ok) {
      injected.setSaveState("下载失败", true);
      return;
    }
    saveBlob(await response.blob(), fileName);
  }

  // ---------------------------------------------------------------- 导入结果与合并审阅
  function pickResultFile(assignmentId, { allowCancelled = false } = {}) {
    packagePending = { assignmentId, allowCancelled };
    assignPart("result-file-input").click();
  }

  async function onResultFileChosen() {
    const input = assignPart("result-file-input");
    const file = input.files && input.files[0];
    input.value = "";
    if (!file || !packagePending) return;
    const { allowCancelled } = packagePending;
    assignPart("assign-error").hidden = true;
    injected.setSaveState("正在导入结果包…");
    try {
      const response = await fetch(
        `/api/projects/${injected.getProjectId()}/results?filename=${encodeURIComponent(file.name)}` +
          (allowCancelled ? "&allow_cancelled=true" : ""),
        {
          method: "POST",
          headers: { "X-B2T-Token": injected.getToken(), "Content-Type": "application/zip" },
          body: file,
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = (payload && payload.error) || {};
        throw new injected.ApiError(
          error.message || `导入失败（HTTP ${response.status}）`,
          error.code,
          error.correlation_id,
          error.detail
        );
      }
      injected.setSaveState(`已导入第 ${payload.seq} 次结果`);
      // mergeState 是外壳在读的共享状态（合并视图经外壳取）⇒ 走注入，模块不留副本
      injected.setMergeState(payload);
      injected.showView("merge");
      await loadAssignments();
    } catch (error) {
      injected.showError(assignPart("assign-error"), error);
      // 失败分支也要落终态：不然顶栏一直停在「正在导入结果包…」
      injected.setSaveState(`导入失败：${(error && error.message) || "未知错误"}`, true);
    } finally {
      packagePending = null;
    }
  }

  // ---------------------------------------------------------------- 接线
  function setupCollabControls() {
    // assign-open / assign-list-toggle 两个入口在 pages-view.js 里（DOM 归那边，动作归这里）
    assignPart("assign-close")?.addEventListener("click", () => injected.closeModal("assign-panel"));
    assignPart("assign-reviewer")?.addEventListener("input", previewAssign);
    assignPart("assign-context")?.addEventListener("change", previewAssign);
    assignPart("assign-create")?.addEventListener("click", createAssignment);
    assignPart("assign-download")?.addEventListener("click", (event) =>
      downloadPackage(event.target.dataset.assignmentId)
    );
    assignPart("assign-reveal")?.addEventListener("click", (event) =>
      revealPackage(event.target.dataset.assignmentId)
    );
    setupPackageControls();
  }

  /** 批量指派列表开关（pages-view.js 的入口经注入调）：翻的是本模块 root ①，不是别人的节点。 */
  async function toggleAssignList() {
    const panel = roots.assign;
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await loadAssignments();
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    const list = injected.roots || [];
    roots = { assign: list[0] || null, result: list[1] || null };
    return api;
  }

  const api = {
    init,
    openAssignPanel,
    toggleAssignList,
    loadAssignments,
    applyPackageMode,
    setupCollabControls,
  };
  window.Collab = api;
})();
