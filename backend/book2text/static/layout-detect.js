/**
 * 检测版面（外壳部分）—— `window.LayoutDetect`
 *
 * 入口：页面视图 ⋯ 菜单的「检测版面…」（`#layout-detect-open`，经注入调 openLayoutDetectDialog）。
 * 宿主：root = `#layout-detect-mask`（顶层 mask，7 个 id 全在子树里）。
 * 状态：layoutPlanCache 随迁；`layoutDetectActive` 仍归外壳（版心状态的键要读它）⇒ 注入 get/set。
 * 写盘：GET `/layout/plan`（有选中页时带 ?pages=）；开始检测走外壳的 startLayoutDetection
 *       （建任务），成功后调 onLayoutDetectStarted 让版心面板显示进度。
 */

(function () {
  "use strict";

  let injected = {};
  let root = null;
  const part = (id) => (root ? root.querySelector(`#${id}`) : null);
  let layoutPlanCache = null;

async function openLayoutDetectDialog() {
  if (!injected.getCurrentProject()) return;
  layoutPlanCache = null;
  part("layout-detect-error").hidden = true;
  part("layout-detect-note").hidden = true;
  part("layout-detect-plan").textContent = "正在读取检测计划…";
  part("layout-detect-start").disabled = true;
  part("layout-detect-start").textContent = "开始检测";
  injected.openModal("layout-detect-mask");
  await refreshLayoutDetectPlan();
}

async function refreshLayoutDetectPlan() {
  if (!injected.getCurrentProject()) return;
  // 有选择就只算选中的正文页（用户看到的数必须等于他实际要跑的事）；没选择一个字节都不改
  const selected = injected.selectionPages().filter((page) => page.include);
  if (injected.getSelectedPages().size && !selected.length) {
    part("layout-detect-plan").textContent = "所选页都不是正文；检测版面只对正文页生效";
    part("layout-detect-start").disabled = true;
    return;
  }
  const query = selected.length
    ? `?pages=${selected.map((page) => page.page_no).join(",")}`
    : "";
  try {
    const plan = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/layout/plan${query}`
    );
    layoutPlanCache = plan;
    renderLayoutDetectPlan(plan);
  } catch (error) {
    part("layout-detect-plan").textContent =
      `检测计划读取失败：${error.message || "未知错误"}`;
    part("layout-detect-start").disabled = true;
  }
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
  const needs = detect + fit;
  if (needs) {
    const perPage = Number(plan.seconds_per_page || 0);
    // 后端 estimated_seconds 是取整后的整数（0.387 会变成 0）：这里按页数×单页耗时兜底，
    // 保证「这次要跑的页数 > 0」时不会显示 0 秒。
    const estimated = Number(plan.estimated_seconds) || needs * perPage;
    rows.push(
      `<div class="layout-plan__row"><span>预计耗时</span><strong>${injected.formatDuration(estimated)}</strong></div>`
    );
    rows.push(
      `<div class="layout-plan__row layout-plan__row--muted"><span>单页约</span><span>${perPage.toFixed(2)} 秒</span></div>`
    );
  }
  part("layout-detect-plan").innerHTML = rows.join("");

  const note = part("layout-detect-note");
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

  const start = part("layout-detect-start");
  start.disabled = detect + fit === 0;
  start.textContent = detect ? `开始检测（${detect} 页）` : fit ? `只补拟合（${fit} 页）` : "没有要做的";
}

async function startLayoutDetectFromDialog() {
  if (!injected.getCurrentProject() || !layoutPlanCache) return;
  const plan = layoutPlanCache;
  const pages = [...(plan.need_detection || []), ...(plan.need_fit || [])];
  if (!pages.length) return;
  part("layout-detect-error").hidden = true;
  part("layout-detect-start").disabled = true;
  part("layout-detect-start").textContent = "正在建任务…";
  const data = await injected.startLayoutDetection({ pages, prepare: true });
  if (!data || !data.job) {
    // 失败原因就地显示：以前错误写进 #pages-error，对话框一关就看不见了，
    // 用户的感觉是"点了没反应"——这正是 P1-3 要修的。
    const node = part("layout-detect-error");
    node.textContent = injected.pagesErrorMessage() || "任务没建成，原因未知。";
    node.hidden = false;
    part("layout-detect-start").disabled = false;
    part("layout-detect-start").textContent = "重试";
    return;
  }
  injected.setLayoutDetectActive(true);
  // 刀 9.3：判定文字 / 进度条归零 / 状态行三处写点收成一次能力；三处只写版心面板，
  // 与 closeModal 互不依赖，所以调用位放在 closeModal 之前（verdict 的位置与今天相同）。
  injected.onLayoutDetectStarted(data.job.total || pages.length);
  injected.closeModal("layout-detect-mask");
}

  let wired = false;
  function wireLayoutDetect() {
    part("layout-detect-cancel").addEventListener("click", () => injected.closeModal("layout-detect-mask"));
    part("layout-detect-cancel-x").addEventListener("click", () => injected.closeModal("layout-detect-mask"));
    part("layout-detect-start").addEventListener("click", startLayoutDetectFromDialog);
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || null;
    if (!wired && root) {
      wired = true;
      wireLayoutDetect();
    }
    return api;
  }

  const api = {
    init,
    openLayoutDetectDialog,
  };
  window.LayoutDetect = api;
})();
