/**
 * 结构工具（页眉 / 页脚 / 页码 → `window.StructureTools`）
 *
 * 书：`docs/refactor/appjs-domains/first-batch.md` §5（刀 D，第一批最重的一刀）。
 *
 * **它拿什么**：`init({ root, apiJson, getCurrentProject, notify, afterApply })`
 * —— root = `#structure-panel`（17 个 `structure-*` 全在它子树里），模块只在 root 内
 * `root.querySelector("#structure-xxx")`，不碰 document（`el(` / `getElementById` 各 0 次）。
 *
 * **两处写盘按"动作"命名**（`knife-numbering.md` §七）：
 *   preview() = 请求 → 读回 → `renderPreview()`   （一条链，外壳不编排顺序）
 *   apply()   = 请求 → 读回 → 写提示 / 收起结果 → `afterApply()`（外壳只提供"应用之后要做的两件事"：
 *               页面数据重拉 + 导出预检，顺序仍由本模块掌握）
 *   `apply()` 是**写盘**动作：一次批量标注，可整体撤销（撤销入口 `undoAutoApply` 不归本刀）。
 *
 * 预览结果（`candidates`，含逐个取消勾选的状态）随本刀搬进模块——它只服务于这四个动作。
 */
(function () {
  "use strict";

  let injected = {};
  /** 预览结果（含用户逐个取消的状态）。默认只勾"有把握"的。 */
  let candidates = [];

  const TYPE_LABELS = {
    header: "页眉", footer: "页脚", page_number: "页码",
    caption: "图注", footnote: "脚注", heading: "标题", other: "其他", paragraph: "段落",
  };

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    return api;
  }

  /** 面板内元素：只在 root 子树里查（不按 document 找，R3/域模块闸同一条口径）。 */
  function part(id) {
    const root = injected.root;
    if (!root || typeof root.querySelector !== "function") return null;
    return root.querySelector(`#${id}`);
  }

  function project() {
    return typeof injected.getCurrentProject === "function" ? injected.getCurrentProject() : null;
  }

  function escapeText(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  /** 与外壳 `showError` 同形（错误文案 + 错误编号 + 详情），但只写 root 里的错误条。 */
  function showPanelError(element, error) {
    if (!element) return;
    const parts = [(error && error.message) || String(error)];
    if (error && error.correlationId) parts.push(`<code>错误编号 ${error.correlationId}</code>`);
    if (error && error.detail) parts.push(`<code>${escapeText(error.detail)}</code>`);
    element.innerHTML = parts.join(" ");
    element.hidden = false;
  }

  function readRules() {
    const value = (id) => {
      const node = part(id);
      return node ? node.value : "";
    };
    const checked = (id) => {
      const node = part(id);
      return Boolean(node && node.checked);
    };
    return {
      top_ratio: Number(value("structure-top") || 0) / 100,
      bottom_ratio: Number(value("structure-bottom") || 0) / 100,
      left_ratio: Number(value("structure-left") || 0) / 100,
      right_ratio: Number(value("structure-right") || 0) / 100,
      max_chars: value("structure-max-chars") === "" ? null : Number(value("structure-max-chars")),
      page_types: checked("structure-body-only")
        ? ["body"]
        : ["body", "body_excluded", "toc", "front", "back"],
      detect_page_numbers: checked("structure-numbers"),
    };
  }

  /** preview()：请求 → 读回 → 重画（一条链）。 */
  async function preview() {
    const currentProject = project();
    if (!currentProject) return;
    const errorBox = part("structure-error");
    if (errorBox) errorBox.hidden = true;
    try {
      const data = await injected.apiJson(
        `/api/projects/${currentProject.project_id}/structure/header-footer/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(readRules()),
        }
      );
      renderStructureCandidates(data);
    } catch (error) {
      showPanelError(part("structure-error"), error);
    }
  }

  function renderStructureCandidates(data) {
    // 默认只勾"有把握"的（页码形态或跨页重复）；只出现一两次的留给人工判断——
    // 标错一个页脚，正文就会从导出里消失
    candidates = (data.candidates || []).map((item) => ({
      ...item,
      keep: item.confidence === "high",
    }));

    const resultBox = part("structure-result");
    if (resultBox) resultBox.hidden = false;
    const meta = part("structure-meta");
    if (meta) meta.textContent = `${data.pages_scanned} 页在作用范围内`;
    const byType = Object.entries(data.by_type || {})
      .map(([type, count]) => `${TYPE_LABELS[type] || type} ${count}`)
      .join(" · ");
    const summary = part("structure-summary");
    if (summary) {
      summary.textContent = data.candidate_count
        ? `找到 ${data.candidate_count} 个（默认勾选 ${data.high_confidence_count} 个有把握的）：${byType}`
        : "按当前规则没有需要标注的块";
    }

    const list = part("structure-candidates");
    if (!list) return;
    list.innerHTML = "";
    candidates.forEach((item, index) => {
      const li = document.createElement("li");
      li.dataset.index = String(index);
      if (!item.keep) li.classList.add("is-off");

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = item.keep;
      check.title =
        item.confidence === "high"
          ? "取消勾选 = 这次不标它"
          : "只在这一页出现，可能是正文的最后一行——确认它确实是页眉 / 页脚再勾";
      check.addEventListener("change", () => {
        candidates[index].keep = check.checked;
        li.classList.toggle("is-off", !check.checked);
        updateApplyState();
      });

      const metaNode = document.createElement("span");
      metaNode.className = "meta";
      metaNode.textContent =
        `第 ${item.page_no} 页 · ${TYPE_LABELS[item.current_type] || item.current_type}` +
        ` → ${TYPE_LABELS[item.proposed_type] || item.proposed_type}` +
        (item.confidence === "high" ? " · 有把握" : " · 需确认");

      const text = document.createElement("span");
      text.className = "text";
      text.textContent = item.text.slice(0, 60);

      li.append(check, metaNode, text);
      list.append(li);
    });

    // 被跳过的块（含原因）也如实列出来，免得用户以为漏了
    const note = part("structure-note");
    const notes = [];
    if (data.skipped_count) {
      const sample = (data.skipped || [])
        .slice(0, 3)
        .map((item) => `第 ${item.page_no} 页「${item.text.slice(0, 12)}」${item.reason}`)
        .join("；");
      notes.push(`有 ${data.skipped_count} 个块在区域内但没有动它：${sample}${data.skipped_count > 3 ? " 等" : ""}`);
    }
    if (!data.candidate_count) {
      notes.push("如果没有找到，试着把区域高度调大一点，或把「只作用于正文页」去掉。");
    }
    if (note) {
      note.textContent = notes.join(" ");
      note.hidden = notes.length === 0;
    }

    updateApplyState();
  }

  function updateApplyState() {
    const kept = candidates.filter((item) => item.keep);
    const button = part("structure-apply-btn");
    if (!button) return;
    button.disabled = kept.length === 0;
    button.textContent = kept.length ? `应用标注（${kept.length} 个块）` : "应用标注";
  }

  /** apply()：写盘动作。请求 → 读回 → 提示 / 收起 → 外壳的两件后处理。 */
  async function apply() {
    const currentProject = project();
    if (!currentProject) return;
    const kept = candidates.filter((item) => item.keep);
    if (!kept.length) return;
    const errorBox = part("structure-error");
    if (errorBox) errorBox.hidden = true;
    try {
      const data = await injected.apiJson(
        `/api/projects/${currentProject.project_id}/structure/header-footer/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: kept.map((item) => ({
              block_id: item.block_id,
              block_type: item.proposed_type,
            })),
          }),
        }
      );
      const byType = Object.entries(data.by_type || {})
        .map(([type, count]) => `${TYPE_LABELS[type] || type} ${count}`)
        .join(" · ");
      const note = part("structure-note");
      if (note) {
        note.textContent =
          `已标注 ${data.changed} 个块（${byType}），涉及 ${data.pages.length} 页。` +
          "这是一次批量操作，可以用「撤销」整体退回去。";
        note.hidden = false;
      }
      candidates = [];
      const resultBox = part("structure-result");
      if (resultBox) resultBox.hidden = true;
      const button = part("structure-apply-btn");
      if (button) button.disabled = true;
      if (typeof injected.afterApply === "function") await injected.afterApply();
    } catch (error) {
      showPanelError(part("structure-error"), error);
    }
  }

  /** 在 root 内部绑 4 个按钮（原 setupStructurePanel）。 */
  function setup() {
    const bind = (id, handler) => {
      const node = part(id);
      if (node) node.addEventListener("click", handler);
    };
    bind("structure-preview-btn", () => preview());
    bind("structure-apply-btn", () => apply());
    bind("structure-all", () => setAllKeeps(true));
    bind("structure-none", () => setAllKeeps(false));
  }

  function setAllKeeps(keep) {
    candidates = candidates.map((item) => ({ ...item, keep }));
    const list = part("structure-candidates");
    if (list) {
      for (const li of list.children) {
        const index = Number(li.dataset.index);
        const input = li.querySelector("input");
        if (input) input.checked = candidates[index].keep;
        li.classList.toggle("is-off", !candidates[index].keep);
      }
    }
    updateApplyState();
  }

  /** 面板关掉时收起临时状态（原 closeModal 里那段：候选清空、结果区隐藏、按钮复位）。 */
  function reset() {
    candidates = [];
    const resultBox = part("structure-result");
    if (resultBox) resultBox.hidden = true;
    updateApplyState();
  }

  const api = { init, setup, preview, apply, setAllKeeps, reset };
  window.StructureTools = api;
})();
