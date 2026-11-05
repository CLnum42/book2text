/**
 * 标点批量与整行乱码（片 6）—— `window.PunctBatch`
 *
 * 两个顶层 mask，各自一个根：
 * - `#punct-groups-mask`（punct-groups-* 7 个 id）：按「标点模式」分组批量裁决；
 * - `#garbled-mask`（garbled-* 7 个 id）：整行被打散成字母碎片时的批量保留/采用。
 * 读审校顶栏的两个角标节点（`#reading-punct-*` / `#reading-garbled-*`）归阅读视图，
 * 经 `getReadingBadges()` 注入句柄，模块里不出现那 4 个 id。
 *
 * 状态随迁：punctGroupsData · punctGroupsProject · punctLastBatch · punctBusy ·
 * garbledData · garbledProject；另加 localStorage `b2t.punctPerLine.<pid>`（逐行看过的模式）。
 * 写盘：GET punct-groups / POST punct-groups/decide / undo、GET garbled-lines / POST garbled-lines/decide。
 */

(function () {
  "use strict";

  let injected = {};
  let punctRoot = null;
  let garbledRoot = null;
  const pPart = (id) => (punctRoot ? punctRoot.querySelector(`#${id}`) : null);
  const gPart = (id) => (garbledRoot ? garbledRoot.querySelector(`#${id}`) : null);

let punctGroupsData = null;
let punctGroupsProject = null;
let punctLastBatch = null;
let punctBusy = false;

function punctReviewStorageKey() {
  return injected.getCurrentProject() ? `b2t.punctPerLine.${injected.getCurrentProject().project_id}` : "";
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

// ── 整行乱码（2026-10-28）────────────────────────────────────────────────
//
// 识别有时把一整行打散成字母碎片（`phind,  n ons o ns a n onad`），候选是完整句子。
// 这类行会直接进语料，比个别错字严重，所以单独一类、支持批量采用候选。

let garbledData = null;
let garbledProject = "";

async function refreshGarbledLines() {
  if (!injected.getCurrentProject()) return null;
  const projectId = injected.getCurrentProject().project_id;
  try {
    const data = await injected.apiJson(`/api/projects/${projectId}/review/garbled-lines`);
    garbledData = data;
    garbledProject = projectId;
  } catch (error) {
    garbledData = null;
  }
  renderGarbledBadge();
  return garbledData;
}

function renderGarbledBadge() {
  const badge = injected.getReadingBadges().garbledCount;
  if (!badge) return;
  const lines = Number(garbledData?.totals?.lines || 0);
  badge.textContent = String(lines);
  const button = injected.getReadingBadges().garbledOpen;
  if (button) button.hidden = lines === 0;
}

function renderGarbledList() {
  const list = gPart("garbled-list");
  const summary = gPart("garbled-summary");
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
  const foot = gPart("garbled-foot");
  if (foot) foot.textContent = `共 ${totals.lines} 行，一次全判；可撤销`;
}

function openGarbledPanel() {
  if (!garbledData) return;
  const mask = garbledRoot;
  if (!mask) return;
  const box = gPart("garbled-error");
  if (box) box.hidden = true;
  renderGarbledList();
  mask.hidden = false;
}

function closeGarbledPanel() {
  const mask = garbledRoot;
  if (mask) mask.hidden = true;
}

async function decideGarbledLines(ack) {
  if (!injected.getCurrentProject()) return;
  const box = gPart("garbled-error");
  try {
    const result = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/review/garbled-lines/decide`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ack }),
      }
    );
    closeGarbledPanel();
    // 裁决落到行上：marks / 计数 / 进度都要重拉（走既有的"整批之后重开阅读流"）
    await injected.reloadReading();
    await refreshGarbledLines();
    injected.showNotice(
      ack === "adopted"
        ? `已采用候选 ${result.applied} 行${result.skipped ? `（跳过 ${result.skipped}）` : ""}`
        : `已标记保留原文 ${result.applied} 行`
    );
  } catch (error) {
    if (box) injected.showError(box, error);
  }
}

async function refreshPunctGroups() {
  if (!injected.getCurrentProject()) return null;
  const projectId = injected.getCurrentProject().project_id;
  try {
    const data = await injected.apiJson(`/api/projects/${projectId}/review/punct-groups`);
    punctGroupsData = data;
    punctGroupsProject = projectId;
  } catch (error) {
    punctGroupsData = { groups: [], totals: { groups: 0, lines: 0, undecided_lines: 0, undecided_groups: 0 } };
    const box = pPart("punct-groups-error");
    if (box) injected.showError(box, error);
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
  const badge = injected.getReadingBadges().punctCount;
  if (badge) {
    badge.textContent = perLine
      ? `${counts.undecided_lines} 行`
      : counts.undecided_groups
        ? `${counts.undecided_lines} 行 · ${counts.undecided_groups} 组`
        : "已判完";
  }
  const button = injected.getReadingBadges().punctOpen;
  if (button) {
    button.classList.toggle("is-on", Boolean(counts.undecided_groups));
    button.title = counts.undecided_groups
      ? `还有 ${counts.undecided_groups} 种标点模式没判（${counts.undecided_lines} 行）`
      : "标点差异都已裁决";
  }
}

async function openPunctGroups() {
  pPart("punct-groups-error").hidden = true;
  injected.openModal("punct-groups-mask");
  if (punctGroupsProject !== (injected.getCurrentProject() && injected.getCurrentProject().project_id) || !punctGroupsData) {
    await refreshPunctGroups();
  }
  renderPunctGroups();
}

function renderPunctGroups() {
  const list = pPart("punct-groups-list");
  if (!list) return;
  list.innerHTML = "";
  const data = punctGroupsData;
  if (!data) return;
  const set = punctReviewSet();
  const totals = data.totals || {};
  const pending = (data.groups || []).filter((group) => group.undecided && !set.has(group.key));
  pPart("punct-groups-summary").textContent =
    `${totals.lines || 0} 行纯标点 / 空格差异 · ${totals.groups || 0} 种模式 · ` +
    (pending.length
      ? `还有 ${pending.length} 种没判（${pending.reduce((sum, g) => sum + g.undecided, 0)} 行）`
      : "全部判完了");
  pPart("punct-groups-foot").textContent = punctLastBatch
    ? `最近一次：${punctLastBatch.label}`
    : "";
  pPart("punct-groups-undo").disabled = !punctLastBatch;

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
    head.append(pattern, count);
    // 后果标签：「全部采用候选」按下去会补字 / 换写法 / 删字——用户不必从箭头里自己读出来。
    // 删字用危险色：`、→∅` 那种一组 84 行，按一下删掉 84 个顿号。
    if (group.impact) {
      const impact = document.createElement("span");
      const tone = group.impact === "删字" ? " chip--bad"
        : group.impact === "补齐" ? " chip--ok"
          : " chip--gray";
      impact.className = `chip${tone} punct-group__impact`;
      impact.textContent = `采用=${group.impact}`;
      impact.title = group.impact_note || "「全部采用候选」按下去会发生什么";
      head.append(impact);
    }
    head.append(state);
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
      injected.reloadReading();
    });
    actions.append(adopt, keep, oneByOne);

    row.append(head, samples, actions);
    list.append(row);
  }
}

async function decidePunctGroup(group, ack) {
  if (punctBusy || !injected.getCurrentProject()) return;
  punctBusy = true;
  pPart("punct-groups-error").hidden = true;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/review/punct-groups/decide`,
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
    await injected.reloadReading();
  } catch (error) {
    showError(pPart("punct-groups-error"), error);
  } finally {
    punctBusy = false;
  }
}

async function undoPunctBatch() {
  if (!injected.getCurrentProject() || punctBusy) return;
  punctBusy = true;
  pPart("punct-groups-error").hidden = true;
  try {
    await injected.apiJson(`/api/projects/${injected.getCurrentProject().project_id}/undo`, { method: "POST" });
    punctLastBatch = null;
    await refreshPunctGroups();
    renderPunctGroups();
    await injected.reloadReading();
  } catch (error) {
    showError(pPart("punct-groups-error"), error);
  } finally {
    punctBusy = false;
  }
}

  let wired = false;
  function wirePunctPanels() {
    gPart("garbled-close").addEventListener("click", closeGarbledPanel);
    gPart("garbled-adopt").addEventListener("click", () => decideGarbledLines("adopted"));
    gPart("garbled-keep").addEventListener("click", () => decideGarbledLines("kept"));
    pPart("punct-groups-close").addEventListener("click", () => injected.closeModal("punct-groups-mask"));
    pPart("punct-groups-done").addEventListener("click", () => injected.closeModal("punct-groups-mask"));
    pPart("punct-groups-undo").addEventListener("click", undoPunctBatch);
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    punctRoot = injected.punctRoot || null;
    garbledRoot = injected.garbledRoot || null;
    if (!wired && punctRoot && garbledRoot) {
      wired = true;
      wirePunctPanels();
    }
    return api;
  }

  const api = {
    init,
    openPunctGroups,
    openGarbledPanel,
    refreshPunctGroups,
    refreshGarbledLines,
    renderPunctGroupBadge,
    punctReviewSet,
  };
  window.PunctBatch = api;
})();
