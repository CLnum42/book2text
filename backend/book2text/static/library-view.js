(function () {
  "use strict";
  let injected = {};
  const el = (id) => document.getElementById(id);

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
    await injected.apiJson(`/api/projects/${entry.project_id}?confirm=true`, { method: "DELETE" });
    await loadLibrary();
  } catch (error) {
    // 被 `.lock` 挡住时不能只甩一句"正在使用中"：说清是谁、什么时候、锁是不是已经过期，
    // 过期的锁给一个「强制删除」（后端 `?force=true` 只接受过期锁）。
    if (
      (error.code === "project_lock_expired" || error.code === "project_busy") &&
      error.data &&
      error.data.lock
    ) {
      injected.showLockConflict(entry, error.data.lock, "delete");
      return;
    }
    injected.showError(el("library-error"), error);
  }
}

function lastPositionText(entry) {
  if (!entry.last_view) return "还没有打开过";
  const view = injected.lastViewLabels[entry.last_view] || entry.last_view;
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
  const name = injected.getNewProjectName().value.trim();
  el("library-error").hidden = true;
  injected.getNewProjectError().hidden = true;
  el("create-progress").hidden = false;

  try {
    const response = await fetch(
      `/api/projects?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "X-B2T-Token": injected.token, "Content-Type": "application/pdf" },
        body: file,
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload && payload.error) || {};
      throw new ApiError(error.message || `新建失败（HTTP ${response.status}）`,
                         error.code, error.correlation_id, error.detail);
    }

    injected.getNewProjectName().value = "";
    // 刀 7 前置：外壳 id 不许当字符串传给通用能力（module 零豁免的字符串版缺口）⇒ 收成具名能力
    injected.closeNewProjectMask?.();
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
    await injected.openPageSetup({ auto: true });
  } catch (error) {
    // 新建对话框开着就报在它里面，否则报在项目库上
    if (!injected.getNewProjectMask().hidden) injected.showError(injected.getNewProjectError(), error);
    else injected.showError(el("library-error"), error);
  } finally {
    el("create-progress").hidden = true;
  }
}

async function openProject(projectId, { force = false, readOnly = false } = {}) {
  el("library-error").hidden = true;
  el("library-warning").hidden = true;
  injected.setBootingProject(true);

  try {
    const opened = await injected.apiJson(
      `/api/projects/${projectId}/open?force=${force}&read_only=${readOnly}`,
      { method: "POST" }
    );
    // 打开项目的提示（强制接管了过期锁 / 覆盖了死锁 / 有任务被中断）先存着：
    // 下面 `loadLibrary()` 会用 `hidden = true` 清掉提示条，必须等它跑完再显示。
    const openWarning = opened.warning || "";
    // 注释流是这次导出的选项，不是项目设置：每次打开项目回到"不导出"的默认。
    // 必须在 refreshProject 之前复位——它会立刻发一次导出预检，用的是这个复选框的值。
    injected.getExportIncludeNotes().checked = false;
    // 任务 62：步骤条的数字来自 finish-summary，它和项目载荷**并行**取，
    // 不要排在后面（490 页的书光项目载荷就 1.2 s）。返回后 `syncWorkflowSteps` 会再画一次。
    const finishPrefetch = injected.loadFinishSummary({ silent: true });
    await injected.refreshProject(projectId);
    // 任务 62：步骤条的数字只等 finish-summary。**先把它等到、把步骤条点亮**，
    // 再去开「上次的视图」——审校视图要组装整本导出预览（490 页实测 7 s），
    // 先跑它会把 finish-summary 饿在 CPU 后面，步骤条十几秒才亮。
    await finishPrefetch;
    injected.applyProjectSettings();
    injected.syncWorkflowSteps();
    await injected.loadAutoApplyStatus();
    injected.setPagesOverlayOn(injected.loadPageOverlayPreference());
    injected.setPagesMarginOn(injected.loadPageMarginPreference());
    injected.setSetupSuggestionsLoaded(false);
    injected.setSetupSuggestions([]);
    // 识别收尾 / 打开项目时服务端会算一次版心；项目载荷里直接带着最近一次建议，
    // 不需要用户再点「推算版心」才知道建议是什么。
    injected.setMarginSuggestion(injected.getProject().margin_box_suggestion || null);
    // 任务 36B：撤销栈与"已试过拟合"的页只对当前项目有意义。
    injected.getMarginUndoStack().length = 0;
    injected.getMarginFitTried().clear();
    injected.setLastStepPanelKey(null);
    injected.setPageZoomTouched(false);
    injected.renderRecognitionSettings();
    injected.setReviewMarginOn(injected.loadReviewMarginPreference());
    injected.setReviewBlockFilter("pending");
    // 刀 6：页面工具栏两个开关的 is-on 归页面视图模块（这里不再碰 #pages-margin-toggle / #pages-overlay-toggle）
    injected.syncToolbarToggles?.();
    injected.getReviewMarginToggle().classList.toggle("is-on", injected.getReviewMarginOn());
    // refreshProject 可能已经渲染过页面视图；默认"开"是在那之后才读出来的。
    // 任务 63：页面缩略图会立刻开始拉图（490 页要几十秒 CPU），所以也排到步骤条之后。
    injected.queueAfterSteps(() => injected.schedulePageVisibility());
    await loadLibrary();
    if (openWarning) {
      const warning = el("library-warning");
      warning.textContent = openWarning;
      warning.hidden = false;
    }
    // 说明书 7.2：打开项目默认回到上次的位置（上次在审校就回审校那一页）
    await injected.resumeLastPosition();
    injected.setBootingProject(false);
  } catch (error) {
    injected.setBootingProject(false);
    if (
      (error.code === "project_lock_expired" || error.code === "project_busy") &&
      error.data &&
      error.data.lock
    ) {
      injected.showLockConflict({ project_id: projectId, name: currentProjectName(projectId) }, error.data.lock, "open");
      return;
    }
    injected.showError(el("library-error"), error);
  }
}

/** 错误对话框里要写项目名：项目列表已经加载过，查一下就行。 */
function currentProjectName(projectId) {
  const cached = (injected.getLibraryProjects() || []).find((item) => item.project_id === projectId);
  if (cached) return cached.name;
  if (injected.getProject() && injected.getProject().project_id === projectId) return injected.getProject().name;
  return projectId;
}

async function loadLibrary() {
  // 上一次加载失败的错误要在这里清掉：刷新成功之后还挂着旧错误，用户会以为项目库还是坏的。
  // （其余四个操作 deleteProject / createProjectFromFile / openProject / openPackageFile 开头都清，只这里漏了）
  el("library-error").hidden = true;
  el("library-warning").hidden = true;
  try {
    const data = await injected.apiJson("/api/projects");
    el("library-path").textContent = data.library_dir;
    injected.setLibraryProjects(data.projects || []);
    renderProjectList(data.projects);
  } catch (error) {
    injected.showError(el("library-error"), error);
  }
}

  // ---------------------------------------------------------------- 对外接口
  /**
   * 挂上目录页自己的 DOM 接线（2026-10-29 Chief 裁定 B）。
   * 上传建项目是目录页的域操作：外壳不再调 createProjectFromFile——
   * 它写 `#create-progress`（在 view-library 子树里），外壳留着就撞 R3。
   * 列表点击 / 删除的接线本来就在 renderProjectList 里，随模块走。
   */
  const init = (deps) => {
    injected = { ...injected, ...(deps || {}) };
    const picker = injected.getNewProjectPicker();
    if (picker && !picker.dataset.b2tLibraryBound) {
      picker.dataset.b2tLibraryBound = "1";
      picker.addEventListener("change", () => {
        if (picker.files && picker.files[0]) createProjectFromFile(picker.files[0]);
        picker.value = "";
      });
    }
  };

  /** 进入/刷新目录页：取项目库并渲染（原 loadLibrary 的全部实现）。 */
  const enter = async () => { await loadLibrary(); };

  /** 域操作（D-100）：打开一个项目。外壳的锁冲突确认 / 任务包打开 / 备份还原走这里。 */
  const open = async (projectId, options) => await openProject(projectId, options);

  /**
   * 外壳流程往目录页写一句话（任务包导入/备份还原/重跑）。
   * - `text` 为空 = 收起；
   * - `error` 有值 = **按外壳的 showError 渲染**（含"错误编号"与 detail）。
   *   这条不能省：外壳原本就是 `showError(el("library-error"), error)`，只用 text
   *   会把错误编号丢掉，那是行为变化，不是搬运。
   */
  const notify = (payload) => {
    const { kind, text, error } = payload || {};
    const node = kind === "warning" ? el("library-warning") : el("library-error");
    if (!node) return;
    if (error) { injected.showError(node, error); return; }
    if (!text) { node.hidden = true; return; }
    node.textContent = String(text);
    node.hidden = false;
  };

  window.LibraryView = {
    init,
    enter,
    notify,
    open,
  };
})();
