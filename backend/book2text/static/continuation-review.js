/**
 * 跨页延续（片 5）—— `window.ContinuationReview`
 *
 * 一条页边界 = 一条判断：左边上下两页原图（打开就停在交界处，两行加淡蓝框），
 * 右边只有依据和三个动作。键盘 1 / 2 / Z / ↑ / ↓，判完自动跳下一条。
 * 没确认完之前，正文审校不算完成（后端 finish-summary.review.complete 带这条）。
 *
 * 宿主：root = `#continuation-panel`（顶层 mask，14 个 id 全在子树里）⇒ 允许 root.querySelector。
 * 入口按钮 `#review-continuations` / `#cleanup-continuation-review-open` 在别的 owner 里，
 * 由外壳接到导出的 `openContinuationReview()`。
 *
 * 状态：continuationState / continuationZoom 全在本模块；写盘 5 条
 * （GET pending / POST resolve / POST reopen 为主，另两条在 loadFinishSummary 之后由外壳刷）。
 * `continuationEvidenceRow` **不是死函数**：renderContinuationPanel 里有两处调用（上页末行 / 下页首行）。
 */

(function () {
  "use strict";

  let injected = {};
  let root = null;
  const part = (id) => (root ? root.querySelector(`#${id}`) : null);

let continuationState = null;
let continuationZoom = 1;

async function openContinuationReview() {
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") return;
  injected.openModal("continuation-panel");
  await loadContinuationReview();
}

async function loadContinuationReview() {
  const error = part("continuation-error");
  error.hidden = true;
  let data;
  try {
    data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/cleanup/continuations/pending`
    );
  } catch (failure) {
    injected.showError(error, failure);
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
  const page = injected.getCurrentProject().pages.find((item) => item.page_no === pageNo);
  const wrap = document.createElement("div");
  wrap.className = "continuation-page";
  if (page) wrap.style.aspectRatio = `${page.width_pt} / ${page.height_pt}`;
  const image = document.createElement("img");
  image.alt = `第 ${pageNo} 页`;
  image.src = injected.pageImageUrl(pageNo, injected.detailImageProfile(wrap.clientWidth || 600, page.width_pt));
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
  const pages = part("continuation-pages");
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
  const pages = part("continuation-pages");
  if (!pages) return;
  pages.style.width = `${Math.round(continuationZoom * 100)}%`;
  part("continuation-zoom-label").textContent =
    continuationZoom === 1 ? "" : `${Math.round(continuationZoom * 100)}%`;
  centerContinuationJunction(true);
  if (entry) prefetchContinuationPages(entry);
}

/** 打开 / 翻条 / 缩放后都停在交界处：上页滚到底、下页滚到顶。 */
function centerContinuationJunction(immediate = false) {
  const scroll = part("continuation-scroll");
  if (!scroll) return;
  const apply = () => {
    const pages = part("continuation-pages");
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
    image.src = injected.pageImageUrl(pageNo, injected.detailImageProfile(600, injected.pageWidthPt(pageNo)));
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
  part("continuation-complete").hidden = !complete;
  if (complete) {
    part("continuation-complete").querySelector("strong").textContent =
      `${state.total} 条全部确认`;
  }
  part("continuation-meta").textContent = complete
    ? "已全部确认"
    : `已确认 ${state.total - remaining} / ${state.total}`;
  part("continuation-footnote").textContent = complete
    ? "正文审校的「跨页延续」闸门已放行"
    : `还剩 ${remaining} 条 · ↑ / ↓ 翻条 · 1 / 2 判`;

  if (!entry) {
    part("continuation-progress").textContent = "没有待确认的页边界";
    part("continuation-state").textContent = "";
    part("continuation-evidence").innerHTML = "";
    part("continuation-pages").innerHTML = "";
    return;
  }

  part("continuation-progress").textContent =
    `第 ${state.index + 1} / ${state.all.length} 条`;
  const decided = entry.decision !== null;
  part("continuation-state").textContent = decided
    ? entry.decision
      ? "已标延续"
      : "已标结束"
    : `第 ${entry.page_no} → ${entry.next_page_no} 页`;
  part("continuation-continue").disabled = decided || Boolean(state.saving);
  part("continuation-end").disabled = decided || Boolean(state.saving);
  part("continuation-revert").disabled = state.history.length === 0 && !decided;

  const evidence = part("continuation-evidence");
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
  const error = part("continuation-error");
  error.hidden = true;
  try {
    const result = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/cleanup/continuations/resolve`,
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
    injected.showError(error, failure);
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
  const error = part("continuation-error");
  error.hidden = true;
  try {
    const result = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/cleanup/continuations/reopen`,
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
    injected.showError(error, failure);
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
  // 导出段落结构变了：只丢预览缓存、不重开（用户还在页面上，别拖一份 1.1 MB 的预览）
  injected.previewEnter({ invalidate: true });
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
  // 根就是 #continuation-panel 自己：querySelector 只找后代，不能 part(根自己的 id)
  const panel = root;
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

  /** 面板自己的接线（root 子树里的按钮 + 键盘 + resize），init 时只绑一次。 */
  function wirePanel() {
    part("continuation-close").addEventListener("click", () => injected.closeModal("continuation-panel"));
    part("continuation-done").addEventListener("click", () => injected.closeModal("continuation-panel"));
    part("continuation-continue").addEventListener("click", () => markContinuation(true));
    part("continuation-end").addEventListener("click", () => markContinuation(false));
    part("continuation-revert").addEventListener("click", revertContinuation);
    part("continuation-prev").addEventListener("click", () => stepContinuation(-1));
    part("continuation-next").addEventListener("click", () => stepContinuation(1));
    part("continuation-zoom-out").addEventListener("click", () => stepContinuationZoom(-1));
    part("continuation-zoom-in").addEventListener("click", () => stepContinuationZoom(1));
    part("continuation-zoom-fit").addEventListener("click", resetContinuationZoom);
    injected.onKeydown(onContinuationKeydown);
    // 窗口高度变了（比如从大窗口拖小）也把交界处重新对到中间
    injected.onResize(() => {
      const panel = root;
      if (panel && !panel.hidden && continuationState) centerContinuationJunction(true);
    });
  }

  let wired = false;
  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || null;
    if (!wired && root) {
      wired = true;
      wirePanel();
    }
    return api;
  }

  const api = {
    init,
    openContinuationReview,
  };
  window.ContinuationReview = api;
})();
