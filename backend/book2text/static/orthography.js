/**
 * 字符规范化（任务 49）—— `window.Orthography`
 *
 * 三组括号 + 半角标点 + 引号配平，都是"两路一致"所以进不了差异队列的隐形错。
 * 先只读分析（改多少行 / 多少字、引号能修几处、还剩几处配不平），确认后整批写库；
 * 写的是 `block.text`，和人工编辑同一条事件链，一次撤销就能全退。
 *
 * 宿主：root = `#orthography-panel`（顶层 mask）；两个入口按钮在清理面板里，留外壳转发。
 * 清理步骤的状态条（`#cleanup-orthography-status` / `#cleanup-lines-status`）归清理面板，
 * 经注入 `setCleanupStatus` 写；写完之后整批刷新的动作 `afterCleanupApplied` 也由外壳给。
 * 写盘：GET/POST `/cleanup/orthography`（括号/标点/引号）、GET/POST `/cleanup/orthography/lines`、
 *       GET `/cleanup/orthography/unbalanced`（只读清单）。
 */

(function () {
  "use strict";

  let injected = {};
  let root = null;
  const part = (id) => (root ? root.querySelector(`#${id}`) : null);

async function runOrthographyCleanup() {
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") return;
  const base = `/api/projects/${injected.getCurrentProject().project_id}/cleanup/orthography`;
  injected.setCleanupStatus("cleanup-orthography-status", "正在扫描括号 / 引号…");
  let plan;
  try {
    plan = await injected.apiJson(base);
  } catch (error) {
    injected.setCleanupStatus("cleanup-orthography-status", `扫描失败：${error.message}`, true);
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
  injected.setCleanupStatus("cleanup-orthography-status", `计划：${detail}`);
  if (!stats.blocks_changed) {
    injected.setCleanupStatus("cleanup-orthography-status", `没有要改的：${detail}`);
    return;
  }
  const ok = window.confirm(
    `改 ${stats.blocks_changed} 个块的文字？\n\n` +
      `· ${detail}\n` +
      `· 涉及 ${stats.pages} 页、${stats.chars_changed} 个字符\n\n` +
      "只改原文里的括号/标点/引号，不改块的类型、框和审校状态；整批可撤销。"
  );
  if (!ok) {
    injected.setCleanupStatus("cleanup-orthography-status", `未写入：${detail}`);
    return;
  }
  injected.setCleanupStatus("cleanup-orthography-status", "正在写入…");
  try {
    const result = await injected.apiJson(base, { method: "POST" });
    const s = result.stats || {};
    injected.setCleanupStatus(
      "cleanup-orthography-status",
      `已改 ${result.changed || 0} 块、${s.chars_changed || 0} 字（${s.pages || 0} 页）；` +
        `引号自动修 ${s.quote_autofix || 0} 处，仍配不平 ${s.unbalanced || 0} 处。`
    );
    await injected.afterCleanupApplied();
  } catch (error) {
    injected.setCleanupStatus("cleanup-orthography-status", `写入失败：${error.message}`, true);
  }
}

async function runLinesCleanup() {
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") return;
  const base = `/api/projects/${injected.getCurrentProject().project_id}/cleanup/orthography/lines`;
  injected.setCleanupStatus("cleanup-lines-status", "正在扫描行文本与第二引擎…");
  let plan;
  try {
    plan = await injected.apiJson(base);
  } catch (error) {
    injected.setCleanupStatus("cleanup-lines-status", `扫描失败：${error.message}`, true);
    return;
  }
  const stats = plan.stats || {};
  if (!stats.changed) {
    injected.setCleanupStatus(
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
    injected.setCleanupStatus("cleanup-lines-status", "未写入。");
    return;
  }
  injected.setCleanupStatus("cleanup-lines-status", "正在写入行文本与 diff…");
  try {
    const result = await injected.apiJson(base, { method: "POST" });
    const s = result.stats || {};
    injected.setCleanupStatus(
      "cleanup-lines-status",
      `已改 ${result.changed || 0} 行；format_only ${s.before?.format_only_differs || 0} → ` +
        `${s.after?.format_only_differs || 0}，differs ${s.before?.differs || 0} → ` +
        `${s.after?.differs || 0}` +
        (result.revert_file ? `；回滚文件 backups/${result.revert_file.split("/").pop()}` : "")
    );
    await injected.afterCleanupApplied();
  } catch (error) {
    injected.setCleanupStatus("cleanup-lines-status", `写入失败：${error.message}`, true);
  }
}

async function openOrthographyPanel() {
  if (!injected.getCurrentProject()) return;
  const list = part("orthography-list");
  list.innerHTML = "<li class=\"muted\">正在扫描引号…</li>";
  injected.openModal("orthography-panel");
  part("orthography-meta").textContent = "";
  part("orthography-footnote").textContent = "";
  let data;
  try {
    data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/cleanup/orthography/unbalanced`
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
  part("orthography-meta").textContent =
    `${entries.length} 处 · ${data.pages || 0} 页` +
    (suspects ? ` · 其中 ${suspects} 处是自动修引号可能改错的，优先看` : "");
  part("orthography-footnote").textContent = entries.length
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
      injected.closeModal("orthography-panel");
      injected.openReviewPage(entry.page_no);
    });
    row.append(where, kind, snippet, open);
    fragment.append(row);
  }
  list.append(fragment);
}

  let wired = false;
  function wireOrthography() {
    part("orthography-close").addEventListener("click", () => injected.closeModal("orthography-panel"));
    part("orthography-done").addEventListener("click", () => injected.closeModal("orthography-panel"));
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || null;
    if (!wired && root) {
      wired = true;
      wireOrthography();
    }
    return api;
  }

  const api = {
    init,
    runOrthographyCleanup,
    runLinesCleanup,
    openOrthographyPanel,
  };
  window.Orthography = api;
})();
