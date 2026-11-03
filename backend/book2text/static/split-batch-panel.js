/**
 * 批量拆分书眉页码（`window.SplitBatchPanel`）
 *
 * 书眉 / 页脚和页码被 OCR 成一个块时，逐块拆太慢。这里三步：
 * 算预览（dry_run，只读）→ 人看影响多少页 / 块 → 确认后才写。整批共用一条 batch（服务端），
 * 所以在审校视图点一次「撤销」就整批回退。
 *
 * **root = `#split-batch-panel`**（body 直下的 mask，8 个子 id：close/summary/error/scope/list/note/
 * cancel/apply）。入口按钮 `#split-page-numbers` 在 `#split-panel`（页面设置面板里）⇒ **归外壳**，
 * 本模块里不出现这个 id。
 *
 * 2 处写盘都在模块内闭环：GET 预览 → `renderSplitBatchPreview` + 摘要；
 * POST 执行 → 关面板 + `refreshPageStates` + `forgetPageBlocks`。
 */
(function () {
  "use strict";

  let injected = {};
  let root = null;

  const part = (id) => (root ? root.querySelector(`#${id}`) : null);

function splitBatchScope() {
  const selected = [...selectedPages].sort((left, right) => left - right);
  if (selected.length) {
    return { pages: selected, label: `选中的 ${selected.length} 页` };
  }
  const body = injected.getCurrentProject().pages.filter((page) => page.include).map((page) => page.page_no);
  return { pages: body, label: `全部正文页（${body.length} 页）` };
}

async function openSplitBatchPanel() {
  if (!injected.getCurrentProject()) return;
  const scope = splitBatchScope();
  if (!scope.pages.length) return;
  part("split-batch-error").hidden = true;
  part("split-batch-note").hidden = true;
  part("split-batch-list").innerHTML = "";
  part("split-batch-summary").textContent = "正在计算…";
  part("split-batch-scope").textContent = `范围：${scope.label}`;
  part("split-batch-apply").disabled = true;
  part("split-batch-apply").textContent = "执行拆分";
  injected.openModal("split-batch-panel");
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/split-page-numbers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_numbers: scope.pages, dry_run: true }),
      }
    );
    renderSplitBatchPreview(data);
  } catch (error) {
    part("split-batch-summary").textContent = "算不出来";
    injected.showError(part("split-batch-error"), error);
  }
}

/** 预览：影响多少页 / 块 + 前几条（用户点执行之前必须看到范围）。 */
function renderSplitBatchPreview(data) {
  const blocks = data.blocks || 0;
  const pages = data.pages || 0;
  part("split-batch-summary").textContent = blocks
    ? `会影响 ${pages} 页 · ${blocks} 块（下面按页序列出前 ${Math.min(8, blocks)} 条）`
    : `没有找到需要拆的块（扫了 ${data.pages_considered || 0} 页）`;
  const list = part("split-batch-list");
  list.innerHTML = "";
  for (const item of data.items || []) {
    const li = document.createElement("li");
    const typeLabel = injected.BLOCK_TYPE_LABELS[item.block_type] || item.block_type;
    const where = item.position === "start" ? "块首" : "块尾";
    li.textContent =
      `第 ${item.page_no} 页 · ${typeLabel}：${item.text} → 拆出页码 ${item.number}（${where}）`;
    li.title =
      `拆分后：${injected.BLOCK_TYPE_LABELS[item.head_type] || item.head_type} + ` +
      `${injected.BLOCK_TYPE_LABELS[item.tail_type] || item.tail_type}`;
    list.append(li);
  }
  const apply = part("split-batch-apply");
  apply.disabled = blocks === 0;
  apply.textContent = blocks ? `执行拆分（${blocks} 块）` : "没有可拆的块";
  const skipped = data.skipped_context_pages || [];
  if (skipped.length) {
    part("split-batch-note").textContent = `跳过了 ${skipped.length} 页只读上下文页`;
    part("split-batch-note").hidden = false;
  }
}

async function applySplitBatch() {
  if (!injected.getCurrentProject()) return;
  const scope = splitBatchScope();
  const button = part("split-batch-apply");
  button.disabled = true;
  button.textContent = "正在拆分…";
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/split-page-numbers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_numbers: scope.pages, dry_run: false }),
      }
    );
    injected.closeModal("split-batch-panel");
    // 块变了：这些页的块框缓存与建议角标都不能再用旧的
    for (const pageNo of data.pages_affected || []) injected.forgetPageBlocks(pageNo);
    injected.onPageSuggestionsInvalidated();
    await injected.refreshPageStates();
    injected.onPagesNeedReflow();
    // 刀 8：选中提示的写点收进 pages 模块（文案仍由外壳拼）
    injected.setSelectionHint(
      `已拆分 ${data.blocks} 块（${(data.pages_affected || []).length} 页）。` +
        "整批算一个操作：到「审校」视图点「撤销」可以一次回退。"
    );
    if (injected.getDetailPageNo() !== null && (data.pages_affected || []).includes(injected.getDetailPageNo())) {
      await injected.loadPageDetail(injected.getDetailPageNo(), { forceSuggestions: true });
    }
  } catch (error) {
    injected.showError(part("split-batch-error"), error);
    button.disabled = false;
    button.textContent = "重试执行";
  }
}

  /** 面板自己的三处接线（关闭 / 取消 / 执行）——DOM 在本模块 root 里，接线也归本模块。 */
  function setupSplitBatchControls() {
    part("split-batch-close")?.addEventListener("click", () => injected.closeModal("split-batch-panel"));
    part("split-batch-cancel")?.addEventListener("click", () => injected.closeModal("split-batch-panel"));
    part("split-batch-apply")?.addEventListener("click", applySplitBatch);
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || null;
    setupSplitBatchControls();
    return api;
  }

  const api = {
    init,
    openSplitBatchPanel,
  };
  window.SplitBatchPanel = api;
})();
