/**
 * 字框回填（任务 59）—— `window.WordBoxes`
 *
 * 只补 `block_line.word_boxes`：文本 / 第二引擎 / 分歧裁决 / 跨页延续 / 版心都不动。
 * 分批同步调用（每批 2 页，约 9 秒）；关掉对话框 = 停在当前批，再点就从没字框的行继续。
 *
 * 宿主：root = `#word-boxes-mask`（顶层 mask）；入口 `#word-boxes-open` 在页面视图的 ⋯ 菜单里，
 * 由视图经注入调 `openWordBoxesDialog`。
 * 状态随迁：wordBoxesPlan · wordBoxesRunning。
 * 写盘 3 条：GET /word-boxes（计划）· POST /word-boxes/backfill {limit:2}（循环到没有新页）·
 *            POST /word-boxes/clear（撤销）；回填/撤销之后清块缓存并重读计划（重画计划/进度/提示）。
 */

(function () {
  "use strict";

  let injected = {};
  let root = null;
  const part = (id) => (root ? root.querySelector(`#${id}`) : null);

let wordBoxesPlan = null;
let wordBoxesRunning = false;

async function openWordBoxesDialog() {
  if (!injected.getCurrentProject()) return;
  wordBoxesPlan = null;
  part("word-boxes-error").hidden = true;
  part("word-boxes-note").hidden = true;
  part("word-boxes-progress").hidden = true;
  part("word-boxes-plan").textContent = "正在读取回填计划…";
  part("word-boxes-start").disabled = true;
  injected.openModal("word-boxes-mask");
  await refreshWordBoxesPlan();
}

async function refreshWordBoxesPlan() {
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/word-boxes`
    );
    wordBoxesPlan = data;
    renderWordBoxesPlan(data);
  } catch (error) {
    part("word-boxes-plan").textContent = `回填计划读取失败：${error.message || "未知错误"}`;
    part("word-boxes-start").disabled = true;
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
      `<div class="layout-plan__row"><span>预计耗时</span><strong>${injected.formatDuration(plan.estimated_seconds)}</strong></div>`
    );
  }
  part("word-boxes-plan").innerHTML = rows.join("");
  const note = part("word-boxes-note");
  note.textContent = pages
    ? "回填只写字框，不改任何文字与判定；中途关掉没关系，再点会从没字框的行继续。" +
      (plan.ocr_pages ? "需要识别的页会真的跑一遍识别（只取字框，不落库）。" : "")
    : "全书都有字框了。";
  note.hidden = false;
  const button = part("word-boxes-start");
  button.disabled = pages === 0 || wordBoxesRunning;
  button.textContent = pages ? `开始回填（${pages} 页）` : "没有要回填的行";
}

async function startWordBoxesBackfill() {
  if (!injected.getCurrentProject() || wordBoxesRunning) return;
  wordBoxesRunning = true;
  part("word-boxes-error").hidden = true;
  part("word-boxes-progress").hidden = false;
  part("word-boxes-start").disabled = true;
  const button = part("word-boxes-start");
  button.textContent = "正在回填…";
  let donePages = 0;
  let matched = 0;
  let unmatched = 0;
  const totalPages = Number(wordBoxesPlan?.pages || 0);
  const startedAt = performance.now();
  try {
    while (true) {
      const data = await injected.apiJson(
        `/api/projects/${injected.getCurrentProject().project_id}/word-boxes/backfill`,
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
      part("word-boxes-fill").style.width = `${percent}%`;
      part("word-boxes-text").textContent =
        `已回填 ${donePages} / ${totalPages} 页 · 已配对 ${matched} 行 · 未配对 ${unmatched} 行`;
      if (!data.updated_pages) break;
      if (Number(data.remaining_pages || 0) === 0) break;
    }
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    part("word-boxes-text").textContent =
      `回填完成：${donePages} 页 · 配对 ${matched} 行 · 未配对 ${unmatched} 行 · ${seconds} 秒`;
    await refreshWordBoxesPlan();
    // 字框变了：让审校流下次打开时重新取块
    if (typeof pageBlockCache !== "undefined") injected.clearPageBlockCache();
  } catch (error) {
    part("word-boxes-error").textContent = `回填中断：${error.message || "未知错误"}`;
    part("word-boxes-error").hidden = false;
  } finally {
    wordBoxesRunning = false;
    button.textContent = "继续回填";
  }
}

async function clearWordBoxes() {
  if (!injected.getCurrentProject()) return;
  const button = part("word-boxes-clear");
  button.disabled = true;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/word-boxes/clear`,
      { method: "POST" }
    );
    part("word-boxes-note").textContent = `已撤销：清掉 ${data.cleared_lines || 0} 行的字框（其它字段没动过）。`;
    part("word-boxes-note").hidden = false;
    await refreshWordBoxesPlan();
    if (typeof pageBlockCache !== "undefined") injected.clearPageBlockCache();
  } catch (error) {
    part("word-boxes-error").textContent = `撤销失败：${error.message || "未知错误"}`;
    part("word-boxes-error").hidden = false;
  } finally {
    button.disabled = false;
  }
}

  let wired = false;
  function wireWordBoxes() {
    part("word-boxes-cancel").addEventListener("click", () => injected.closeModal("word-boxes-mask"));
    part("word-boxes-cancel-x").addEventListener("click", () => injected.closeModal("word-boxes-mask"));
    part("word-boxes-start").addEventListener("click", startWordBoxesBackfill);
    part("word-boxes-clear").addEventListener("click", clearWordBoxes);
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || null;
    if (!wired && root) {
      wired = true;
      wireWordBoxes();
    }
    return api;
  }

  const api = {
    init,
    openWordBoxesDialog,
  };
  window.WordBoxes = api;
})();
