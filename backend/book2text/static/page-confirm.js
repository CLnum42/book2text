/**
 * 页面确认域模块（刀 B）——"这一页算什么 / 还差哪一步"的判定与提示。
 *
 * 形态同刀 A（`docs/refactor/appjs-domains/first-batch.md` §1）：
 * - **服务模块，不是视图模块**：不叫 `*-view.js`；本文件里 `el(` / `document.getElementById` /
 *   `querySelector(` 各 0 次（这个域**完全是纯数据**，连 DOM 都不碰）；
 * - **注入只走两条**：状态访问器 / 动作函数，不给 setter；
 * - **状态不搬**：`selectedPages` / `setupSuggestions` 仍归外壳，这里只要只读访问器；
 * - `window.confirm` 保留（它不属于任何视图的 DOM）。
 *
 * 不进本域的两个转发器（`openPageSetup` / `confirmAllUnconfirmed`）与版面块的两个函数
 * （`layoutBlockPageRecord` / `highConfidenceCount`）按**归属**留在外壳/别处，不按段名划。
 */
(function () {
  "use strict";

  let injected = {};

  /** 五类页面各多少、确认了多少（页面确认步的抬头数字）。 */
  function pageSetupStats() {
    const project = injected.getCurrentProject();
    const pages = project ? project.pages : [];
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

  /** 第一步该把用户带到哪个面板：还有没确认页 → 类型；否则版心 / 识别。 */
  function firstUnfinishedPanel() {
    const project = injected.getCurrentProject();
    const pages = project ? project.pages : [];
    if (pages.some((page) => !page.page_confirmed)) return "page-type";
    const bodyPages = pages.filter((page) => page.include);
    if (bodyPages.some((page) => page.margin_box_mode !== "none" && !injected.marginBoxOfPage(page))) {
      return "margin";
    }
    if (bodyPages.some((page) => injected.recognitionOf(page).status === "unrecognized")) {
      return "recognition";
    }
    return "page-type";
  }

  /** 只看"选中的页"上的建议：建议区要贴着当前页，不常挂在最上面。 */
  function selectedSuggestions() {
    const selected = injected.getSelectedPages();
    if (!selected || !selected.size) return [];
    return (injected.getSetupSuggestions() || []).filter((item) => selected.has(item.page_no));
  }

  /** 选中页的建议按"建议类型"归组（用于「采用全部 high」那类批量动作）。 */
  function suggestionPagesByType() {
    const byType = new Map();
    for (const item of selectedSuggestions()) {
      if (!byType.has(item.suggested_type)) byType.set(item.suggested_type, []);
      byType.get(item.suggested_type).push(item.page_no);
    }
    return byType;
  }

  /** 识别前的提醒：未确认不拦人，只问一次。返回 false 表示用户点了取消。 */
  function warnUnconfirmed(pages, action) {
    const unconfirmed = pages.filter((page) => !page.page_confirmed);
    if (!unconfirmed.length) return true;
    return window.confirm(
      `还有 ${unconfirmed.length} 页没有确认页面类型（正文 / 正文排除 / 目录 / 前置 / 后置）。` +
        `${action}仍会按现在的设置继续（只有「正文」进识别）——未确认不拦人。要现在继续吗？`
    );
  }

  function init(deps) {
    injected = deps || {};
    return api;
  }

  const api = {
    init,
    pageSetupStats,
    firstUnfinishedPanel,
    selectedSuggestions,
    suggestionPagesByType,
    warnUnconfirmed,
  };
  window.PageConfirm = api;
})();
