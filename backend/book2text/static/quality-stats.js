/**
 * 质量统计域模块（刀 A）——`#stats-panel` 里那几行数字。
 *
 * 形态（`docs/refactor/appjs-domains/first-batch.md` §1）：
 * - **服务模块，不是视图模块**：文件不叫 `*-view.js`（R3 对视图模块零豁免，而这些 DOM 在 dialog 里）；
 * - **不按 id 找 DOM**：本文件里 `el(` / `document.getElementById` / `querySelector(` 各 0 次；
 *   `init()` 直接收下它要写的两个元素（`list` = `#stats-list`、`note` = `#stats-note`），
 *   不拿"根宿主"再自己找——刀 A 只用这两个元素，多一层 root 只是多一层间接；
 * - **打开/关闭遮罩留在外壳**：`openStatsPanel()` 仍是外壳的 `openModal("stats-panel")` + `QualityStats.load()`；
 * - **注入只走两条**：状态访问器 / 动作函数，不给 setter 让它改别的域的状态
 *   （唯一例外是它本来就写的那份 `projectSummary`，经 `setProjectSummary` 交回外壳）。
 */
(function () {
  "use strict";

  let injected = {};
  let listEl = null;
  let noteEl = null;

  /** 一行统计：`<dt>` 词 + `<dd>` 值（可选 title 作为解释）。 */
  function statsRow(term, value, title = "") {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (title) dd.title = title;
    return [dt, dd];
  }

  /** 百分比文案；`pages-view` 也用它，经 deps 注入本模块。 */
  function percentText(value) {
    return `${(Number(value || 0) * 100).toFixed(1)}%`;
  }

  /** 拉一次统计 → 写回外壳的 `projectSummary` → 重画 → 让步骤条跟上。读不到就静默。 */
  async function load() {
    const project = injected.getCurrentProject();
    if (!project) return;
    let data;
    try {
      data = await injected.apiJson(`/api/projects/${project.project_id}/summary`);
    } catch {
      return; // 摘要读不到不该影响主流程
    }
    injected.setProjectSummary(data);
    render(data);
    injected.syncWorkflowSteps();
  }

  function render(data) {
    if (!listEl) return; // 单测的合成 DOM 没传元素：没地方画就什么都不做
    const pages = data.pages || {};
    const review = data.review || {};
    const divergence = data.divergence || {};
    const jobs = data.jobs || {};
    const list = listEl;
    list.innerHTML = "";

    const recognitionBits = [`已识别 ${pages.recognized || 0} / 正文 ${pages.included || 0} 页`];
    if (pages.unrecognized) recognitionBits.push(`未识别 ${pages.unrecognized}`);
    if (pages.failed) recognitionBits.push(`识别失败 ${pages.failed}`);
    if (pages.has_candidate) recognitionBits.push(`待选新结果 ${pages.has_candidate}`);
    list.append(...statsRow("识别", recognitionBits.join(" · ")));

    const reviewBits = [
      `块 ${review.blocks || 0}（纳入块 ${review.included || 0}）`,
      `已确认 ${review.confirmed || 0}`,
      `未审 ${review.unreviewed || 0}`,
    ];
    if (review.uncertain) reviewBits.push(`不确定 ${review.uncertain}`);
    reviewBits.push(
      `人工修改 ${review.modified || 0}（${percentText(review.modified_rate)}）`
    );
    list.append(
      ...statsRow("审校", reviewBits.join(" · "), "人工修改率 = 改过的块 / 纳入块（说明书 13.4）")
    );

    // 两路复核：没有复核过就如实说"还没复核"，不显示一堆 0
    if (!divergence.checked_pages) {
      list.append(
        ...statsRow("两路复核", "还没复核过（选中页面后点「第二引擎复核所选」）")
      );
    } else {
      const rateTitle =
        "分歧率 = 实质分歧行 / 能比的行（汉字级 + 标点级 ÷ 一致 + 仅格式 + 汉字级 + 标点级）；" +
        "第二引擎没读出来的行不进分母";
      const bits = [
        `已复核 ${divergence.checked_pages} / ${divergence.total_pages} 页`,
        `比过 ${divergence.compared_lines} 行`,
        `一致 ${divergence.identical}`,
        `仅格式 ${divergence.format_only}`,
        `汉字级 ${divergence.chars}`,
        `标点级 ${divergence.punct}`,
      ];
      if (divergence.empty) bits.push(`没读出 ${divergence.empty}`);
      bits.push(`分歧率 ${percentText(divergence.diverging_rate)}`);
      list.append(...statsRow("两路复核", bits.join(" · "), rateTitle));
      if (divergence.stale_blocks) {
        list.append(
          ...statsRow(
            "　",
            `有 ${divergence.stale_blocks} 个块的行结构改过，不参与上面的行统计`
          )
        );
      }
    }

    const jobBits = [
      `共 ${jobs.total || 0} 个`,
      `成功 ${jobs.succeeded || 0}`,
      `失败 ${jobs.failed || 0}（失败率 ${percentText(jobs.failure_rate)}）`,
    ];
    if (jobs.interrupted) jobBits.push(`中断 ${jobs.interrupted}`);
    if (jobs.cancelled) jobBits.push(`取消 ${jobs.cancelled}`);
    if (jobs.active) jobBits.push(`进行中 ${jobs.active}`);
    list.append(
      ...statsRow("任务", jobBits.join(" · "), "失败率 = 失败 / （成功 + 失败）；取消与中断不算成败")
    );

    // 算不出来的指标如实列出，不假装算过（说明书 1.7）
    const notMeasured = data.not_measured || [];
    const note = noteEl;
    if (!note) return;
    note.hidden = notMeasured.length === 0;
    note.textContent = notMeasured.length
      ? "产品里算不出来的指标：" +
        notMeasured.map((item) => `${item.name}（${item.reason}）`).join("；")
      : "";
  }

  function init(deps) {
    injected = deps || {};
    listEl = injected.list || null;
    noteEl = injected.note || null;
    return api;
  }

  // 只导出真有调用点的三个：render 没有外部调用者（load 内部用），不占接口面
  const api = { init, load, percentText };
  window.QualityStats = api;
})();
