/**
 * 合并审校视图（任务 94 / D-100 定稿，2026-10-29 落盘）。
 *
 * 接口 2 个：`init` / `enter`。**没有 exit**：`enter()` 幂等（控制按钮只绑一次、
 * 重画只换内容），而 `showView` 从不调 exit——导出它就是永不执行的导出（§22.1）。
 *
 * 状态归属：
 * - `mergeHandled` / `mergeDecisions` / `mergeActivePageId` 归本模块；
 * - `mergeState` 归外壳（导入结果包 / 打开合并视图两处写），本模块只经
 *   `injected.getMergeState()` 现取，**不缓存副本**（§20.10 / ⑧）。
 *
 * 重置语义（§20.10 硬约束）：**只在「换了新数据」（state 对象身份变化）时重置裁决**。
 * 切走再回来不重置——否则「切走再回来，未提交的裁决被清空」是行为改变。
 */
(function () {
  "use strict";
  let injected = {};
  const el = (id) => document.getElementById(id);
  const projectId = () => (injected.getProject() || {}).project_id || "";
  const currentMergeState = () => injected.getMergeState();
  let mergeHandled = new Set();
  let mergeDecisions = new Map();
  let mergeActivePageId = null;
  let lastStateRef = null;
  let controlsBound = false;

  function charDiff(before, after) {
    const left = String(before || "");
    const right = String(after || "");
    // 先剥掉共同的前后段，中间用 LCS 逐字比（行内文本通常只有几十字，够快也够准）
    let start = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
    let endLeft = left.length;
    let endRight = right.length;
    while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
      endLeft -= 1;
      endRight -= 1;
    }
    const prefix = left.slice(0, start);
    const suffix = left.slice(endLeft);
    const leftMid = left.slice(start, endLeft);
    const rightMid = right.slice(start, endRight);

    const fragment = document.createDocumentFragment();
    if (prefix) fragment.append(document.createTextNode(prefix));
    for (const [kind, text] of diffMiddle(leftMid, rightMid)) {
      if (!text) continue;
      if (kind === "same") {
        fragment.append(document.createTextNode(text));
      } else if (kind === "del") {
        const node = document.createElement("del");
        node.textContent = text;
        fragment.append(node);
      } else {
        const node = document.createElement("ins");
        node.textContent = text;
        fragment.append(node);
      }
    }
    if (suffix) fragment.append(document.createTextNode(suffix));
    return fragment;
  }

  /** 中间段的逐字比较：返回 [["same"|"del"|"ins", 文本], …]。 */
  function diffMiddle(left, right) {
    const rows = left.length;
    const cols = right.length;
    if (rows * cols > 40000) {
      // 太长的行不做逐字比（避免卡界面），整段显示为替换
      return [["del", left], ["ins", right]];
    }
    const table = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = cols - 1; j >= 0; j -= 1) {
        table[i][j] =
          left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    const out = [];
    const push = (kind, char) => {
      const last = out[out.length - 1];
      if (last && last[0] === kind) last[1] += char;
      else out.push([kind, char]);
    };
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (left[i] === right[j]) {
        push("same", left[i]);
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        push("del", left[i]);
        i += 1;
      } else {
        push("ins", right[j]);
        j += 1;
      }
    }
    while (i < rows) push("del", left[i++]);
    while (j < cols) push("ins", right[j++]);
    return out;
  }

  const MERGE_KIND_CLASS = {
    conflict: "is-conflict",
    structural: "is-structural",
  };

  function mergeVisiblePages() {
    if (!currentMergeState()) return [];
    const filter = el("merge-filter").value;
    const handled = mergeHandled;
    return currentMergeState().changed_pages.filter((page) => {
      if (handled.has(page.page_id) && filter !== "all") return filter === "pending" ? false : true;
      if (filter === "conflict") return page.kind === "conflict";
      if (filter === "structural") return page.kind === "structural";
      if (filter === "block_level") return page.kind === "block_level";
      if (filter === "comments") return page.comment_count > 0;
      if (filter === "pending") return !handled.has(page.page_id);
      return true;
    });
  }


  function renderMergeView(state) {
    const counts = state.counts;
    el("merge-title").textContent = `合并审校结果：${state.reviewer_name}`;
    el("merge-meta").textContent =
      `第 ${(state.page_nos || []).join("、")} 页 · 结果 ${state.seq}`;
    el("merge-error").hidden = true;
    // 概要数字放在顶栏的四个小格子里（效果图 06）
    el("merge-stat-changed").innerHTML = `变化 <b>${counts.changed_pages}</b> 页`;
    el("merge-stat-blocks").innerHTML = `块级修改 <b>${counts.block_level}</b>`;
    el("merge-stat-conflict").innerHTML = `冲突 <b>${counts.conflict}</b>`;
    el("merge-stat-comments").innerHTML = `💬 备注 <b>${counts.comments}</b>`;
    el("merge-stat-conflict").hidden = false;
    el("merge-image-status").textContent = "点左边的一页，这里显示原图与助手的改动区域";
    el("merge-canvas").hidden = true;
    el("merge-caption").textContent = "";

    const list = el("merge-pages");
    list.innerHTML = "";
    for (const page of mergeVisiblePages()) {
      const item = document.createElement("li");
      item.dataset.pageId = page.page_id;
      item.className = MERGE_KIND_CLASS[page.kind] || "";
      if (mergeHandled.has(page.page_id)) item.classList.add("is-done");

      const mark = document.createElement("span");
      mark.className = "ic";
      mark.textContent = page.kind === "conflict" ? "⚠" : page.kind === "structural" ? "◧" : "●";
      if (page.kind === "conflict") mark.style.color = "var(--bad-text)";
      else if (page.kind === "block_level") mark.style.color = "var(--accent-text)";

      const no = document.createElement("span");
      no.className = "pg";
      no.textContent = `p.${page.page_no}`;
      const desc = document.createElement("span");
      desc.className = "ds";
      desc.textContent =
        page.kind === "conflict"
          ? `冲突 ${page.changed_blocks}`
          : page.kind_label + (page.changed_blocks ? ` ${page.changed_blocks}` : "") +
            (page.comment_count ? ` 💬${page.comment_count}` : "");

      item.append(mark, no, desc);
      item.addEventListener("click", () => showMergePage(page));
      list.append(item);
    }
    if (!list.children.length) {
      const empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "没有符合条件的页面。";
      list.append(empty);
    }
    el("merge-accept-all").disabled = !state.changed_pages.some(
      (page) => !mergeHandled.has(page.page_id) && page.kind !== "conflict"
    );
    const first = mergeVisiblePages()[0];
    if (first) showMergePage(first);
  }

  function showMergePage(page) {
    const detail = el("merge-detail");
    mergeActivePageId = page.page_id;
    detail.innerHTML = "";
    for (const item of el("merge-pages").children) {
      item.classList.toggle("is-active", item.dataset.pageId === page.page_id);
    }

    const title = document.createElement("div");
    title.className = "merge-detail__head";
    title.innerHTML = "";
    const strong = document.createElement("b");
    strong.textContent = `第 ${page.page_no} 页`;
    title.append(strong, ` · ${page.kind_label}` + " · 逐条接受或拒绝");
    detail.append(title);

    const cards = document.createElement("div");
    cards.className = "merge-detail__cards";
    detail.append(cards);

    if (page.kind === "conflict") {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.style.padding = "12px 18px 0";
      hint.textContent =
        "这一页在你分派之后也改过——冲突项要单独决定（保留我的 / 采用助手的），或者先拒绝、之后手工改。";
      cards.append(hint);
    }
    if (page.kind === "structural") {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.style.padding = "12px 18px 0";
      hint.textContent = "这一页有块的增删 / 合并 / 拆分 / 重排，只能整页接受或拒绝。";
      cards.append(hint);
    }

    for (const change of page.block_changes) {
      cards.append(mergeBlockItem(page, change));
    }
    if (page.added_blocks.length) {
      const item = document.createElement("div");
      item.className = "merge-item";
      const head = document.createElement("div");
      head.className = "merge-item__head";
      head.textContent = `助手新增了 ${page.added_blocks.length} 块（接受这一页时会一起写入）`;
      item.append(head);
      for (const block of page.added_blocks) {
        const body = document.createElement("div");
        body.className = "merge-diff";
        const node = document.createElement("ins");
        node.textContent = block.text || "（空）";
        body.append(node);
        item.append(body);
      }
      cards.append(item);
    }
    if (page.removed_blocks.length) {
      const item = document.createElement("div");
      item.className = "merge-item";
      const head = document.createElement("div");
      head.className = "merge-item__head";
      head.textContent = `助手删除了 ${page.removed_blocks.length} 块（接受这一页时会一起删除，可撤销）`;
      item.append(head);
      cards.append(item);
    }

    // 底部操作条（效果图 06：右上角"接受所有无冲突的变化"，这里是逐页的接受 / 拒绝）
    const actions = document.createElement("div");
    actions.className = "merge-detail__foot";
    if (mergeHandled.has(page.page_id)) {
      const state = mergeDecisions.get(page.page_id);
      const done = document.createElement("span");
      done.className = "chip chip--ok";
      done.textContent =
        state && state.action === "reject" ? "已决定：拒绝本页" : "已决定：接受本页";
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "btn btn--sm btn--ghost";
      undo.textContent = "改回来";
      undo.addEventListener("click", () => {
        mergeDecisions.delete(page.page_id);
        mergeHandled.delete(page.page_id);
        showMergePage(page);
        renderMergeListView();
      });
      actions.append(done, undo);
    } else {
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "btn";
      reject.textContent = page.kind === "conflict" ? "保留我的" : "拒绝本页";
      reject.addEventListener("click", () =>
        decideMergePage(page, page.kind === "conflict" ? "keep_mine" : "reject")
      );
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "接受后的写入可整体撤销";
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "btn btn--pri";
      accept.textContent = "接受本页";
      accept.title = page.kind === "block_level" ? "接受这一页里助手的全部改动" : "结构变化 / 冲突按整页接受";
      accept.addEventListener("click", () => decideMergePage(page, "accept"));
      actions.append(reject, hint, accept);
    }
    detail.append(actions);
    renderMergeFooter();

    loadMergePageImage(page);
  }

  /** 中间那列：原图 + 助手改过的块高亮（效果图 06 的"修改对应区域高亮"）。 */
  async function loadMergePageImage(page) {
    if (!injected.getProject()) return;
    const status = el("merge-image-status");
    const canvas = el("merge-canvas");
    const image = el("merge-image");
    const caption = el("merge-caption");

    const changed = new Set((page.block_changes || []).map((change) => change.block_id));
    const added = new Set((page.added_blocks || []).map((block) => block.block_id));
    const removed = (page.removed_blocks || []).map((block) => block.block_id);

    let blocks = [];
    try {
      const data = await injected.apiJson(
        `/api/projects/${projectId()}/pages/${page.page_no}/blocks`
      );
      blocks = data.blocks || [];
    } catch (error) {
      status.textContent = "这一页的块读不出来，下面照样能逐条决定。";
      status.hidden = false;
      return;
    }

    const wanted = `/api/projects/${projectId()}/pages/${page.page_no}/image?size=view` +
      `&token=${encodeURIComponent(injected.token)}`;
    if (image.dataset.pageNo !== String(page.page_no)) {
      image.dataset.pageNo = String(page.page_no);
      canvas.hidden = true;
      status.textContent = "正在渲染…";
      status.hidden = false;
      image.onload = () => {
        status.hidden = true;
        canvas.hidden = false;
        drawMergeOverlay(blocks, changed, added, removed);
      };
      image.onerror = () => {
        status.textContent = "这一页渲染失败。";
      };
      image.src = wanted;
    } else {
      status.hidden = true;
      canvas.hidden = false;
      drawMergeOverlay(blocks, changed, added, removed);
    }

    const parts = [];
    if (changed.size) parts.push(`改动 ${changed.size} 块`);
    if (added.size) parts.push(`新增 ${added.size} 块`);
    if (removed.length) parts.push(`删除 ${removed.length} 块`);
    caption.textContent = parts.length
      ? `第 ${page.page_no} 页 · ${parts.join(" · ")}（蓝框＝改动，绿框＝新增）`
      : `第 ${page.page_no} 页 · 没有可高亮的位置信息`;
  }

  function drawMergeOverlay(blocks, changed, added, removed) {
    const overlay = el("merge-overlay");
    overlay.innerHTML = "";
    let drawn = 0;
    for (const block of blocks) {
      if (!block.bbox) continue;
      const isAdded = added.has(block.block_id);
      const isRemoved = removed.includes(block.block_id);
      const isChanged = changed.has(block.block_id);
      if (!isAdded && !isChanged) continue;   // 只画助手动过的地方，其余不干扰阅读
      drawn += 1;
      const [x0, y0, x1, y1] = block.bbox;
      const box = document.createElement("div");
      box.className = "box " + (isAdded ? "box--added" : "box--changed");
      if (isRemoved) box.className = "box box--removed";
      box.style.left = `${x0 * 100}%`;
      box.style.top = `${y0 * 100}%`;
      box.style.width = `${(x1 - x0) * 100}%`;
      box.style.height = `${(y1 - y0) * 100}%`;
      box.title = isAdded ? "助手新增的块" : "助手改过的块";
      overlay.append(box);
    }
    if (!drawn) {
      const note = document.createElement("div");
      note.className = "merge-caption";
      note.style.position = "absolute";
      note.style.bottom = "8px";
      note.style.left = "8px";
      note.textContent = "这些改动的块没有位置信息，无法在图上圈出来";
      overlay.append(note);
    }
  }

  function mergeBlockItem(page, change) {
    const item = document.createElement("div");
    item.className = "merge-item";
    const head = document.createElement("div");
    head.className = "merge-item__head";
    const label = document.createElement("span");
    label.textContent = change.conflict ? "⚠ 冲突" : "块级修改";
    label.className = "status " + (change.conflict ? "status--bad" : "status--warn");
    const fields = document.createElement("span");
    fields.className = "muted";
    fields.textContent = Object.values(change.field_labels).join(" / ");
    head.append(label, fields);
    item.append(head);

    const textChange = change.fields.text;
    if (textChange) {
      if (change.conflict) {
        const three = document.createElement("div");
        three.className = "merge-three";
        const cell = (caption, value) => {
          const box = document.createElement("div");
          const small = document.createElement("span");
          small.className = "label";
          small.textContent = caption;
          const body = document.createElement("div");
          body.textContent = value || "（空）";
          box.append(small, body);
          return box;
        };
        three.append(
          cell("分派时的原文", textChange.snapshot),
          cell("你现在的内容", textChange.mine),
          cell("助手的版本", textChange.theirs)
        );
        item.append(three);
      } else {
        const diff = document.createElement("div");
        diff.className = "merge-diff";
        diff.append(charDiff(textChange.snapshot, textChange.theirs));
        item.append(diff);
      }
    }

    for (const [field, values] of Object.entries(change.fields)) {
      if (field === "text") continue;
      const line = document.createElement("div");
      line.className = "merge-diff";
      line.textContent =
        `${change.field_labels[field] || field}：` +
        `${values.snapshot || "（空）"} → ${values.theirs || "（空）"}`;
      item.append(line);
    }
    if (change.fields.comment) {
      const note = document.createElement("p");
      note.className = "merge-note";
      note.textContent = `💬 ${page ? "" : ""}${change.fields.comment.theirs}`;
      item.append(note);
    }
    return item;
  }

  function decideMergePage(page, action) {
    mergeDecisions.set(page.page_id, { page_id: page.page_id, action });
    mergeHandled.add(page.page_id);
    // 决定完不跳走：留在这一页上再核对一遍，底部变成"已决定 + 改回来"
    showMergePage(page);
    renderMergeListView();
  }


  /** 一行页面的门牌：标记 + 页码 + 变化摘要（列表与重建共用）。 */
  function mergePageRow(page) {
    const item = document.createElement("li");
    item.dataset.pageId = page.page_id;
    item.className = MERGE_KIND_CLASS[page.kind] || "";
    const decision = mergeDecisions.get(page.page_id);
    if (decision) item.classList.add("is-done");
    if (page.page_id === mergeActivePageId) item.classList.add("is-active");

    const mark = document.createElement("span");
    mark.className = "ic";
    mark.textContent = page.kind === "conflict" ? "⚠" : page.kind === "structural" ? "◧" : "●";
    if (page.kind === "conflict") mark.style.color = "var(--bad-text)";
    else if (page.kind === "block_level") mark.style.color = "var(--accent-text)";
    if (decision) mark.textContent = "✓";

    const no = document.createElement("span");
    no.className = "pg";
    no.textContent = `p.${page.page_no}`;

    const desc = document.createElement("span");
    desc.className = "ds";
    desc.textContent = decision
      ? decision.action === "accept"
        ? "已接受"
        : "已拒绝"
      : page.kind_label + (page.changed_blocks ? ` ${page.changed_blocks}` : "") +
        (page.comment_count ? ` 💬${page.comment_count}` : "");

    item.append(mark, no, desc);
    item.addEventListener("click", () => showMergePage(page));
    return item;
  }

  function renderMergeListView() {
    if (!currentMergeState()) return;
    const list = el("merge-pages");
    list.innerHTML = "";
    for (const page of mergeVisiblePages()) list.append(mergePageRow(page));
    if (!list.children.length) {
      const empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "没有符合条件的页面。";
      list.append(empty);
    }
    const pending = currentMergeState().changed_pages.filter(
      (page) => !mergeHandled.has(page.page_id) && page.kind !== "conflict"
    );
    el("merge-accept-all").disabled = !pending.length;
    el("merge-meta").textContent =
      `第 ${(currentMergeState().page_nos || []).join("、")} 页 · 结果 ${currentMergeState().seq}` +
      (mergeDecisions.size ? ` · 已决定 ${mergeDecisions.size} 页` : "");
    renderMergeFooter();
  }

  /** 合并视图底部的"提交"按钮：把决定一起写进主项目（一次一个 batch）。 */
  function renderMergeFooter() {
    const footer = el("merge-footer");
    footer.hidden = !mergeDecisions.size;
    footer.innerHTML = "";
    if (!mergeDecisions.size) return;
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "btn btn--primary";
    submit.textContent = `提交 ${mergeDecisions.size} 页的决定（可撤销）`;
    submit.addEventListener("click", submitMergeDecisions);
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn btn--ghost";
    reset.textContent = "清空决定";
    reset.addEventListener("click", () => {
      mergeDecisions = new Map();
      mergeHandled = new Set();
      renderMergeListView();
    });
    footer.append(submit, reset);
  }

  async function submitMergeDecisions() {
    if (!injected.getProject() || !currentMergeState() || !mergeDecisions.size) return;
    const assignmentId = currentMergeState().assignment.assignment_id;
    el("merge-error").hidden = true;
    try {
      const data = await injected.apiJson(
        `/api/projects/${projectId()}/assignments/${assignmentId}/merge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decisions: [...mergeDecisions.values()],
            reviewer_name: currentMergeState().reviewer_name,
          }),
        }
      );
      injected.setSaveState(
        `已合并 ${data.accepted_pages} 页` +
          (data.rejected_pages ? `，保留现有 ${data.rejected_pages} 页` : "") +
          "（⌘/Ctrl + Z 可撤销）"
      );
      mergeDecisions = new Map();
      mergeHandled = new Set();
      mergeActivePageId = null;
      injected.setMergeState(null);
      await injected.loadAssignments();
      await injected.refreshProject(projectId());
      injected.navigate("pages");
    } catch (error) {
      injected.showError(el("merge-error"), error);
    }
  }

  // ---------------------------------------------------------------- 整批接受（按钮处理器，原 setupCollabControls 里绑）
  async function acceptAllClean() {
    if (!currentMergeState()) return;
    const pending = currentMergeState().changed_pages.filter(
      (page) => !mergeHandled.has(page.page_id) && page.kind !== "conflict"
    );
    if (!pending.length) return;
    if (
      !window.confirm(
        `接受 ${pending.length} 页里没有冲突的变化？\n（块级修改与结构变化都会被写入，冲突项留给你单独处理；整批可撤销）`
      )
    ) {
      return;
    }
    for (const page of pending) {
      mergeDecisions.set(page.page_id, { page_id: page.page_id, action: "accept" });
      mergeHandled.add(page.page_id);
    }
    renderMergeListView();
  }

  /** 合并审阅的入口之一：按任务包取数（另一路是结果包导入，外壳直接设 state）。 */
  async function openMergeView(assignmentId) {
    const project = injected.getProject();
    if (!project) return;
    injected.closeModal("assign-panel");   // 合并是整屏的视图，别让任务包对话框压在上面
    try {
      const data = await injected.apiJson(
        `/api/projects/${projectId()}/assignments/${assignmentId}/merge`
      );
      injected.setMergeState(data);
      injected.navigate("merge");
    } catch (error) {
      injected.showError(injected.getAssignError(), error);
    }
  }

  /** 控制按钮只在 init 里绑一次：enter 可反复调用。 */
  const init = (deps) => {
    injected = deps || {};
    if (controlsBound) return;
    controlsBound = true;
    const bind = (id, event, handler) => {
      const node = el(id);
      if (node) node.addEventListener(event, handler);
    };
    bind("merge-close", "click", () => injected.navigate("pages"));
    bind("merge-filter", "change", renderMergeListView);
    bind("merge-accept-all", "click", acceptAllClean);
  };

  /** 进合并视图：现取外壳 state；换数据才重置裁决，再画。 */
  const enter = (assignmentId) => {
    if (assignmentId) return openMergeView(assignmentId);
    const state = currentMergeState();
    if (!state) return;
    if (state !== lastStateRef) {
      lastStateRef = state;
      mergeHandled = new Set();
      mergeDecisions = new Map();
      mergeActivePageId = null;
    }
    renderMergeView(state);
  };

  window.MergeView = {
    init,
    enter,
  };
})();
