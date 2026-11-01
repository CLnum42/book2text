/**
 * 页详情编辑面板（S1：块列表编辑）——`window.PageDetailEditor`
 *
 * 书：`docs/refactor/review/page-detail-console-plan.md`（① 主刀 · S1）。
 * **非视图服务模块**：核心抽屉（load/render/pager/viewer/diff）仍由外壳画，画完调
 * `renderBlocks(blocks)` 交块列表；模块只碰 §2 表里归模块的 id（root = `#view-review`，只 root.querySelector）。
 *
 * 状态归属（Chief 2026-11-02 裁决 A）：**纯私有状态跟随搬**（detailSuggestions /
 * reviewPendingSave / reviewSaveTimer / boxDraft / inkGapsShown），外壳仍在读写的走注入
 * （detailPageNo / reviewBlocks / currentProject / activeReviewBlockId / detailSuggestionByBlock /
 * detailNumberHints / cursorByBlock / diffStripOpen / boxCreateMode / detailInkGaps /
 * detailLayoutConfirmed）——每处读写都经注入，模块里不存副本。
 *
 * 接口面（T）：见文件末尾 api 对象；导出只留"外壳有真调用点"的成员（§1 ⑦）。
 * 模块喊外壳的一律走 init 注入，两者不混。
 */
(function () {
  "use strict";

  let injected = {};
  let root = null;

  // ---------------------------------------------------------------- 跟随搬的 3 份（只服务本模块）
  let detailSuggestions = [];
  let reviewPendingSave = null; // {block, text}：还没发出去的自动保存
  let reviewSaveTimer = null;

  const part = (id) => (root ? root.querySelector(`#${id}`) : null);

  function escapeMarkup(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  /** page-detail-error 的唯一写入口（外壳经导出的 showError 调它）。 */
  function showEditorError(error) {
    const node = part("page-detail-error");
    if (!node) return;
    const bits = [(error && error.message) || String(error)];
    if (error && error.correlationId) bits.push(`<code>错误编号 ${error.correlationId}</code>`);
    if (error && error.detail) bits.push(`<code>${escapeMarkup(error.detail)}</code>`);
    node.innerHTML = bits.join(" ");
    node.hidden = false;
  }

function applyDetailSuggestions(payload) {
  detailSuggestions =
    payload && Array.isArray(payload.suggestions) ? payload.suggestions : [];
  injected.setDetailSuggestionByBlock(new Map(
    detailSuggestions.map((item) => [item.block_id, item])
  ));
  // 页码提示单独一份：块类型**已经是** header / footer / page_number 时也要有
  // （类型建议只返回"与当前类型不同"的块，光靠它，采用之后拆分按钮就消失了）
  injected.setDetailNumberHints(new Map(
    (payload && Array.isArray(payload.page_numbers) ? payload.page_numbers : []).map(
      (item) => [item.block_id, item]
    )
  ));
}

async function refreshDetailSuggestions({ force = false } = {}) {
  if (injected.getDetailPageNo() === null || !injected.getCurrentProject()) return;
  const pageNo = injected.getDetailPageNo();
  if (force) injected.forgetPageSuggestions(pageNo);
  let payload = null;
  try {
    payload = await injected.fetchPageSuggestions(pageNo);
  } catch {
    return;
  }
  if (injected.getDetailPageNo() !== pageNo || !injected.getCurrentProject()) return;
  applyDetailSuggestions(payload);
  renderSuggestionTools();
  // 建议是异步补算的：用户正在编辑框里打字时不要重建块列表（那会顶掉光标）。
  // 徽章等下一次渲染再出现，数据已经更新。
  const active = document.activeElement;
  const editing =
    active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
  if (!editing) renderReviewBlocks(injected.getReviewBlocks());
  renderLayoutPanel();
}

function blockNeedsReview(block) {
  if (injected.getDetailSuggestionByBlock().has(block.block_id)) return true;
  const divergence = injected.divergenceOf(block);
  return Boolean(divergence && divergence.lines);
}

function suggestionHighList() {
  return detailSuggestions.filter((item) => item.confidence === "high");
}

function pageNumberHintChip(suggestion) {
  const candidates = suggestion.page_number_candidates || [];
  if (!candidates.length) return null;
  const hint = suggestion.page_number_hint;
  const texts = candidates.map((item) => item.text).join(" / ");
  const chip = document.createElement("span");
  chip.className = "review-suggest__pagenum";
  chip.textContent = hint
    ? `含页码 ${hint.text}（候选 ${texts}）`
    : `页码候选 ${texts}`;
  chip.title =
    "页码提示只作参考：不会自动拆块或改文本。" +
    (hint ? `按页面外侧估计是 ${hint.text}，` : "") +
    "导出 meta.json 时会再按页码块 / 页眉页脚里的数字抽一次。";
  return chip;
}

function blockSuggestionBadge(suggestion) {
  const typeLabel =
    injected.BLOCK_TYPE_LABELS[suggestion.suggested_type] || suggestion.suggested_type;
  const wrap = document.createElement("span");
  wrap.className = `review-suggest review-suggest--${suggestion.suggested_type}`;
  wrap.title =
    `建议：${typeLabel}（${suggestion.confidence_label}）\n` +
    (suggestion.reason || "") +
    "\n只改块类型：不改审校状态、不删文字；采用后可撤销。";

  const label = document.createElement("span");
  label.className = "review-suggest__label";
  label.textContent = `${typeLabel} · ${suggestion.confidence_label}`;
  wrap.append(label);

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "btn btn--sm review-suggest__apply";
  apply.textContent = "采用";
  apply.title = `把这一块改成「${typeLabel}」（可撤销）`;
  apply.addEventListener("click", (event) => {
    event.stopPropagation();
    adoptBlockSuggestion(suggestion);
  });
  wrap.append(apply);

  // 页码提示只进悬停说明，不占块头宽度（design 3.3：块头只留四样）。
  const pageNumber = pageNumberHintChip(suggestion);
  if (pageNumber) wrap.title += `\n${pageNumber.textContent}\n${pageNumber.title}`;
  return wrap;
}

async function adoptBlockSuggestion(suggestion) {
  if (!injected.getCurrentProject() || injected.getDetailPageNo() === null) return;
  // 先把还没发出去的自动保存落库，免得随后的整页重渲染把刚打的字盖掉
  await flushPendingSave();
  const block = (injected.getReviewBlocks() || []).find(
    (item) => item.block_id === suggestion.block_id
  );
  if (!block) {
    injected.setSaveState("这一块已经不在本页了，先重新载入", true);
    return;
  }
  injected.forgetPageSuggestions(injected.getDetailPageNo());
  await patchBlock(block, { block_type: suggestion.suggested_type });
}

async function adoptAllHighSuggestions() {
  if (!injected.getCurrentProject() || injected.getDetailPageNo() === null) return;
  const high = suggestionHighList();
  if (!high.length) return;
  await flushPendingSave();
  const targets = [];
  for (const item of high) {
    const block = (injected.getReviewBlocks() || []).find(
      (entry) => entry.block_id === item.block_id
    );
    if (block) targets.push({ item, block });
  }
  if (!targets.length) return;
  const labels = [
    ...new Set(
      targets.map(
        (target) => injected.BLOCK_TYPE_LABELS[target.item.suggested_type] || target.item.suggested_type
      )
    ),
  ];
  const ok = window.confirm(
    `本页有 ${targets.length} 条把握较大的建议（${labels.join(" / ")}）。\n\n` +
      "全部采用会把对应块改成建议类型——只改类型，不改审校状态，也不删文字；" +
      "每一块都能单独撤销。继续吗？"
  );
  if (!ok) return;

  const pageNo = injected.getDetailPageNo();
  const projectId = injected.getCurrentProject().project_id;
  injected.setSaveState("正在采用建议…");
  let changed = 0;
  let failed = 0;
  for (const { item } of targets) {
    const fresh = (injected.getReviewBlocks() || []).find(
      (entry) => entry.block_id === item.block_id
    );
    if (!fresh) continue;
    try {
      await injected.apiJson(`/api/projects/${projectId}/blocks/${item.block_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          block_type: item.suggested_type,
          expected_revision: fresh.revision,
        }),
      });
      changed += 1;
    } catch {
      failed += 1;
    }
  }
  injected.forgetPageSuggestions(pageNo);
  injected.setSaveState(
    failed
      ? `已采用 ${changed} 条，${failed} 条没改成（可能被别处改过）`
      : `已采用 ${changed} 条建议 ✓`,
    failed > 0
  );
  await injected.loadPageDetail(pageNo);
  await injected.refreshPageStates();
}

function blockCard(block, index, blocksCount) {
  const item = document.createElement("li");
  item.className = "review-block";
  item.dataset.blockId = block.block_id;
  item.dataset.index = String(index);
  if (!block.include) item.classList.add("review-block--excluded");
  if (injected.CHROME_BLOCK_TYPES.has(block.block_type)) {
    item.classList.add("review-block--chrome");
  }
  if (injected.TEXT_FREE_BLOCK_TYPES.has(block.block_type)) {
    item.classList.add("review-block--textfree");
  }
  const blockDivergence = injected.divergenceOf(block);
  if (blockDivergence.chars) item.classList.add("review-block--divergence");
  // 任务 53：中心点在版心外的块（页眉 / 页脚 / 页码 / 版心外的注文）
  const cardPage = injected.detailPageRecord();
  const cardOutside = !injected.blockInsideMargin(block, cardPage);
  if (cardOutside) item.classList.add("review-block--outside-margin");

  const head = document.createElement("div");
  head.className = "review-block__head";

  const typeSelect = document.createElement("select");
  typeSelect.className = "review-block__type";
  typeSelect.title =
    "块类型（页眉 / 页脚 / 页码在导出时默认排除；插图 / 装饰不输出文本）";
  for (const [value, label] of Object.entries(injected.BLOCK_TYPE_LABELS)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    typeSelect.append(option);
  }
  typeSelect.value = block.block_type;
  typeSelect.addEventListener("change", () =>
    patchBlock(block, { block_type: typeSelect.value })
  );

  const status = document.createElement("span");
  status.className =
    "review-block__status" +
    (block.review_status === "confirmed"
      ? " review-block__status--ok"
      : block.review_status === "uncertain"
      ? " review-block__status--warn"
      : "");
  status.textContent =
    block.review_status === "confirmed"
      ? "✓ 已确认"
      : injected.REVIEW_STATUS_LABELS[block.review_status] || block.review_status;

  // 块头只留四样：类型 / 建议 / 差异数 / 状态；位置与排除原因降为一行灰字。
  const metaBits = [];
  if (cardOutside) metaBits.push("版心外");
  if (!block.include) metaBits.push("已排除");
  else if (injected.TEXT_FREE_BLOCK_TYPES.has(block.block_type)) metaBits.push("不输出正文");
  else if (injected.CHROME_BLOCK_TYPES.has(block.block_type)) metaBits.push("只进元数据");
  else if (injected.NOTE_BLOCK_TYPES.has(block.block_type)) metaBits.push("进注释流");
  if (block.modified) metaBits.push("已修改");
  if (block.continues_to_next) metaBits.push("延续下页");
  const blockLines = block.lines || [];
  const conflictLines = blockLines.filter((line) => line.layout_status === "conflict").length;
  const unassignedLines = blockLines.filter((line) => line.layout_status === "unassigned").length;
  if (conflictLines) metaBits.push(`冲突行 ${conflictLines}`);
  if (unassignedLines) metaBits.push(`未归属行 ${unassignedLines}`);
  if (!block.bbox) metaBits.push("无位置信息");

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  head.append(typeSelect);
  const suggestion = injected.getDetailSuggestionByBlock().get(block.block_id);
  if (suggestion) head.append(blockSuggestionBadge(suggestion));
  head.append(spacer);
  if (metaBits.length) {
    const meta = document.createElement("span");
    meta.className = "review-block__meta";
    meta.textContent = metaBits.join(" · ");
    head.append(meta);
  }
  head.append(status);

  const textarea = document.createElement("textarea");
  textarea.className = "review-block__text";
  textarea.value = block.text;
  textarea.spellcheck = false;
  if (!block.text) {
    textarea.placeholder = injected.TEXT_FREE_BLOCK_TYPES.has(block.block_type)
      ? "（这是版面块：插图 / 装饰，不输出文本）"
      : "（这一块没有文本）";
  }
  // 拆分要用"光标在哪"，而点菜单会让编辑框失焦，因此先把位置记下来
  const rememberCursor = () => {
    injected.getCursorByBlock().set(block.block_id, textarea.selectionStart || 0);
  };
  textarea.addEventListener("select", rememberCursor);
  textarea.addEventListener("keyup", rememberCursor);
  textarea.addEventListener("click", rememberCursor);
  textarea.addEventListener("blur", rememberCursor);
  textarea.addEventListener("input", () => {
    autoSizeTextarea(textarea);
    scheduleBlockSave(block, textarea.value);
  });
  textarea.addEventListener("focus", () => selectReviewBlock(block.block_id, { scroll: false }));
  textarea.addEventListener("keydown", (event) => {
    // 编辑框内保留浏览器原生的文字撤销（说明书 7.5）；Alt+↑/↓ 在块之间跳
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      focusSiblingBlock(index, event.key === "ArrowDown" ? 1 : -1);
    }
  });

  const actions = document.createElement("div");
  actions.className = "review-block__actions";
  const addButton = (label, title, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn--sm";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", onClick);
    actions.append(button);
  };

  if (block.review_status !== "confirmed") {
    addButton("✓ 确认", "把这个块标为已确认", () =>
      patchBlock(block, { review_status: "confirmed" })
    );
  }
  addButton(
    block.review_status === "uncertain" ? "取消不确定" : "? 不确定",
    "标记 / 取消不确定（⌘/Ctrl + Shift + U）",
    () =>
      patchBlock(block, {
        review_status: block.review_status === "uncertain" ? "unreviewed" : "uncertain",
      })
  );
  addButton(
    block.include ? "排除" : "纳入",
    "排除 / 纳入导出（⌘/Ctrl + Shift + E）",
    () => patchBlock(block, { include: !block.include })
  );
  addButton(
    block.continues_to_next ? "取消延续" : "↪ 延续",
    "标记为延续到下一页（跨页段落）",
    () => patchBlock(block, { continues_to_next: !block.continues_to_next })
  );
  if (block.modified) {
    addButton("恢复原文", "把文本恢复成 OCR 原文（原文一直保留着）", () =>
      patchBlock(block, { text: block.ocr_text })
    );
    addButton("看原文", "展开 / 收起 OCR 原文", (event) => {
      const original = item.querySelector(".review-block__original");
      original.hidden = !original.hidden;
      event.target.textContent = original.hidden ? "看原文" : "收起原文";
    });
  }

  // "⋯ 更多"：结构操作（说明书 6.4 的合并 / 拆分 / 上移下移 / 新增 / 删除）
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn btn--sm review-block__more";
  more.textContent = "⋯ 更多";
  more.title = "结构操作：合并 / 拆分 / 上移下移 / 新增 / 删除";
  const menu = document.createElement("div");
  menu.className = "review-menu";
  menu.hidden = true;
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    // 同时只开一个菜单（先记下要不要开，再统一设状态——反着写会把刚打开的又关掉）
    const willOpen = menu.hidden;
    for (const other of root.querySelectorAll("#detail-blocks .review-menu")) {
      other.hidden = true;
    }
    menu.hidden = !willOpen;
  });

  const menuItem = (label, title, onClick, disabled = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "review-menu__item";
    button.textContent = label;
    button.title = title;
    button.disabled = disabled;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.hidden = true;
      onClick();
    });
    menu.append(button);
    return button;
  };
  menuItem(
    "与上一块合并",
    "合并到上一块：文本以换行连接、坐标取并集（说明书 R4）",
    () => injected.structureAction(block, "merge-prev"),
    index === 0
  );
  menuItem(
    "在光标处拆分",
    "在编辑框里的光标位置切开这一块（先把光标放到要拆开的地方）",
    () => injected.structureAction(block, "split", { offset: injected.getCursorByBlock().get(block.block_id) })
  );
  // 书眉里粘着的页码（`2谁是巴赫金?11`）：只在这一块真的有"贴着块首 / 块尾"的
  // 页码候选时才出现，点了才拆——和"采用建议"一样，建议不等于自动执行。
  const numberHint = injected.pageNumberSplitHint(block);
  if (numberHint) {
    menuItem(
      `把页码 ${numberHint.text} 拆出去`,
      `把${numberHint.position === "start" ? "块首" : "块尾"}的 ${numberHint.text} 拆成独立的「页码」块，` +
        "剩下的部分保持原类型；两块各有自己的框，可撤销。",
      () => injected.structureAction(block, "split-page-number", { candidate_text: numberHint.text })
    );
  }
  menuItem("上移", "与上一块交换位置", () => injected.structureAction(block, "move", { direction: "up" }), index === 0);
  menuItem(
    "下移",
    "与下一块交换位置",
    () => injected.structureAction(block, "move", { direction: "down" }),
    index === blocksCount - 1
  );
  menuItem("在此块后新增一块", "新增一个空块（没有位置信息，可在图上框选位置待做）", () =>
    injected.structureAction(block, "create")
  );
  menuItem(
    "删除这一块",
    "软删除：块不会真的消失，撤销可以恢复（说明书 5.1）",
    () => {
      if (window.confirm("删除这一块？删除是软删除，可以用「撤销」恢复。")) {
        injected.structureAction(block, "delete");
      }
    }
  );
  actions.append(more);
  item.append(menu);

  // 块备注（说明书 7.9.2）：有备注显示 💬 与内容，没有就给一个"添加备注"
  const commentBox = document.createElement("div");
  commentBox.className = "review-block__comment";
  const renderComment = () => {
    commentBox.innerHTML = "";
    if (block.comment) {
      const text = document.createElement("span");
      text.textContent = `💬 ${block.comment}`;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn btn--sm btn--ghost";
      edit.textContent = "改备注";
      edit.addEventListener("click", () => askComment(block, block.comment));
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "btn btn--sm btn--ghost";
      clear.textContent = "删除";
      clear.addEventListener("click", () => patchBlock(block, { comment: "" }));
      commentBox.append(text, edit, clear);
    } else {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn btn--sm btn--ghost";
      add.textContent = "💬 加备注";
      add.title = "给这一块写一句说明或提问（会随结果包一起回传给负责人）";
      add.addEventListener("click", () => askComment(block, ""));
      commentBox.append(add);
    }
  };
  renderComment();   // 有备注显示内容 + 改 / 删；没有就显示「💬 加备注」
  if (!block.comment) commentBox.classList.add("review-block__comment--empty");

  const original = document.createElement("pre");
  original.className = "review-block__original";
  original.hidden = true;
  original.textContent = block.ocr_text;

  item.append(head, textarea);
  const divergenceSection = blockDivergenceSection(block, textarea);
  if (divergenceSection) item.append(divergenceSection);
  item.append(commentBox);
  item.append(actions, original);
  requestAnimationFrame(() => autoSizeTextarea(textarea));
  return item;

  function askComment(target, current) {
    const value = window.prompt("给这一块写一句备注（留空并确定就是删除）：", current);
    if (value === null) return;
    patchBlock(target, { comment: value });
  }
}

function blockDivergenceSection(block, textarea) {
  const divergence = injected.divergenceOf(block);
  const marks = (divergence.marks || []).filter((mark) => mark.level !== "format_only_differs");
  if (!marks.length && !divergence.stale) return null;

  const box = document.createElement("div");
  box.className = "diff-strip" + (divergence.chars ? "" : " diff-strip--punct");

  const head = document.createElement("div");
  head.className = "diff-strip__head";
  const count = document.createElement("span");
  count.className = "diff-strip__count";
  const acked = Number(divergence.acked || 0);
  count.textContent = divergence.stale
    ? "两路差异已收起"
    : divergence.lines
      ? `两路差异 ${divergence.lines} 行` + (acked ? ` · 已确认 ${acked}` : "")
      : acked
        ? `没有待处理差异 · 已确认 ${acked}`
        : "两路没有实质分歧";
  const info = document.createElement("button");
  info.type = "button";
  info.className = "diff-strip__info";
  info.textContent = "ⓘ";
  info.title =
    "实测量过：第二引擎比第一引擎弱——被标出的分歧里约八成是它自己的错" +
    "（以汉字错误为主），但标记能圈进第一引擎约 2/3 的错行。" +
    "所以标记只回答「看哪里」，候选只作参考（改对率约 1/4），换不换由你判断。";
  info.addEventListener("click", (event) => event.stopPropagation());
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "diff-strip__toggle";
  toggle.textContent = injected.getDiffStripOpen().has(block.block_id) ? "收起 ⌃" : "展开 ⌄";
  head.append(count, info, spacer, toggle);
  box.append(head);

  if (divergence.stale) {
    const note = document.createElement("p");
    note.className = "diff-strip__note";
    note.textContent = "这一块的行结构改过（增删过换行），逐行标记会指错地方，已暂时收起——重新识别这一页就能重新得到标记。";
    box.append(note);
    return box;
  }

  const body = document.createElement("div");
  body.className = "diff-strip__body";
  body.hidden = !injected.getDiffStripOpen().has(block.block_id);
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (injected.getDiffStripOpen().has(block.block_id)) injected.getDiffStripOpen().delete(block.block_id);
    else injected.getDiffStripOpen().add(block.block_id);
    injected.syncDiffStrip(block.block_id);
  });

  const order = { differs_chars: 0, differs_punct: 1, no_candidate: 2 };
  const ordered = [...marks].sort(
    (a, b) =>
      Number(Boolean(a.ack)) - Number(Boolean(b.ack)) ||
      (order[a.level] ?? 9) - (order[b.level] ?? 9) ||
      a.line_index - b.line_index
  );
  for (const mark of ordered.slice(0, injected.MAX_DIVERGENCE_ROWS)) {
    const row = document.createElement("div");
    row.className = "diff-row" + (mark.ack ? " is-acked" : "");
    row.dataset.blockId = block.block_id;
    row.dataset.lineIndex = String(mark.line_index);
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.title =
      `第 ${mark.line_index + 1} 行\n第一路：${truncate(mark.current || "", 80)}\n` +
      `第二路：${truncate(mark.candidate || "（没读出）", 80)}`;

    const where = document.createElement("span");
    where.className = "diff-row__no";
    where.textContent = `第 ${mark.line_index + 1} 行`;
    const level = document.createElement("span");
    level.className = "diff-row__level";
    level.textContent =
      injected.diffLevelLabel(mark.level) +
      (mark.ack === "kept" ? " · 已保留" : mark.ack === "adopted" ? " · 已采纳" : "");

    const text = document.createElement("span");
    text.className = "diff-row__text";
    if (mark.level === "no_candidate") {
      text.textContent = "第二路没读出这一行";
    } else {
      text.append(diffRowFragment(mark));
    }
    row.append(where, level, text);

    if (mark.candidate && !mark.ack) {
      const adopt = document.createElement("button");
      adopt.type = "button";
      adopt.className = "diff-row__adopt";
      adopt.textContent = "换第二路";
      adopt.title = "把这一行换成第二引擎的文本（一次普通编辑，可撤销）";
      adopt.addEventListener("click", (event) => {
        event.stopPropagation();
        adoptLine(block, mark.line_index, mark.candidate);
      });
      row.append(adopt);
    }

    const go = () => injected.activateDiff(block.block_id, mark.line_index, 0);
    row.addEventListener("click", go);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        go();
      }
    });
    body.append(row);
  }
  if (marks.length > injected.MAX_DIVERGENCE_ROWS) {
    const rest = document.createElement("p");
    rest.className = "diff-strip__note";
    rest.textContent = `还有 ${marks.length - injected.MAX_DIVERGENCE_ROWS} 行，按「第二引擎复核」看全部。`;
    body.append(rest);
  }
  box.append(body);
  return box;
}

function diffCompareLines(mark) {
  const current = String(mark.current || "");
  const candidate = String(mark.candidate || "");
  const spans = injected.computeCharSpans(current, candidate);
  const fragment = document.createDocumentFragment();
  const row = (text, key, label) => {
    const line = document.createElement("div");
    line.className = `diff-line diff-line--${key}`;
    const tag = document.createElement("span");
    tag.className = "diff-line__label";
    tag.textContent = label;
    const body = document.createElement("span");
    body.className = "diff-line__text";
    let pos = 0;
    for (const span of spans) {
      const start = key === "a" ? span.aStart : span.bStart;
      const end = key === "a" ? span.aEnd : span.bEnd;
      if (start > pos) body.append(document.createTextNode(text.slice(pos, start)));
      if (end > start) {
        const markEl = document.createElement("mark");
        markEl.className = "diff-char";
        markEl.textContent = text.slice(start, end);
        body.append(markEl);
      }
      pos = Math.max(pos, end);
    }
    if (pos < text.length) body.append(document.createTextNode(text.slice(pos)));
    line.append(tag, body);
    return line;
  };
  if (!spans.length) {
    const note = document.createElement("div");
    note.className = "diff-line__note";
    note.textContent =
      "这一行两路一致或第二路多字，没有可逐字对比的差异；看整行即可。";
    fragment.append(note);
    return fragment;
  }
  fragment.append(row(current, "a", mark.ack === "kept" ? "原文·已保留" : "原文"));
  if (candidate) fragment.append(row(candidate, "b", "候选"));
  return fragment;
}

function diffRowFragment(mark) {
  const fragment = document.createDocumentFragment();
  const current = String(mark.current || "");
  const candidate = String(mark.candidate || "");
  const spans = injected.computeCharSpans(current, candidate).filter((span) => span.aEnd > span.aStart);
  if (!spans.length) {
    const note = document.createElement("span");
    note.className = "diff-strip__note";
    note.textContent = "（第二路多字，待 line_diff）";
    fragment.append(note);
    return fragment;
  }
  spans.slice(0, 2).forEach((span, index) => {
    if (index) fragment.append(document.createTextNode(" … "));
    const prefix = current.slice(Math.max(0, span.aStart - 8), span.aStart);
    const suffix = current.slice(span.aEnd, span.aEnd + 8);
    if (span.aStart > 8 || index) fragment.append(document.createTextNode("…"));
    if (prefix) fragment.append(document.createTextNode(prefix));
    const a = document.createElement("span");
    a.className = "diff-a";
    a.textContent = current.slice(span.aStart, span.aEnd);
    const arrow = document.createElement("span");
    arrow.className = "diff-arrow";
    arrow.textContent = "→";
    const b = document.createElement("span");
    b.className = "diff-b";
    b.textContent = candidate.slice(span.bStart, span.bEnd) || "（删）";
    fragment.append(a, arrow, b);
    if (suffix) fragment.append(document.createTextNode(suffix));
    if (span.aEnd < current.length - 2) fragment.append(document.createTextNode("…"));
  });
  return fragment;
}

function truncate(text, limit) {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function autoSizeTextarea(textarea) {
  if (!textarea || !textarea.isConnected) return;
  textarea.style.height = "auto";
  const style = window.getComputedStyle(textarea);
  const lineHeight = parseFloat(style.lineHeight) || 21.45;
  const min = lineHeight * 3 + 14;
  const max = lineHeight * 20 + 14;
  const height = Math.min(Math.max(textarea.scrollHeight, min), max);
  textarea.style.height = `${height}px`;
}

function renderReviewBlocks(blocks) {
  const list = part("detail-blocks");
  list.innerHTML = "";
  const page = injected.detailPageRecord();
  // 任务 53：默认只列版心内的块；版心外 / 全部可切换。过滤只影响"显示哪些卡片"，
  // 所有块仍在 `injected.getReviewBlocks()` 里、原图上的框也照画——切过去就能编辑 / 采用 / 框选。
  const split = injected.reviewMarginSplit(page, blocks);
  const mode = injected.effectiveReviewFilter(page);
  let visible = blocks;
  if (mode === "pending") {
    // 默认只审版心内：版心外的书眉 / 页码差异不进待处理（任务 34）
    visible = split.inside.filter(blockNeedsReview);
  } else if (split.box && mode === "inside") visible = split.inside;
  else if (split.box && mode === "outside") visible = split.outside;
  injected.renderReviewFilter(split, mode);

  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    const pageReasons = injected.pendingPageReasons();
    if (!blocks.length) {
      empty.textContent = "这一页没有块。";
    } else if (mode === "pending") {
      empty.textContent =
        "这一页没有需要处理的块。" +
        (pageReasons.length
          ? `页面级还有：${pageReasons.join(" / ")}（右侧可确认版面 / 查看漏行）。`
          : "切到「全部」仍可查看和编辑所有块。");
    } else if (!split.box) {
      empty.textContent = "这一页没有块。";
    } else {
      const label = mode === "outside" ? "版心外" : "版心内";
      empty.textContent =
        `这一页没有${label}的块。` +
        (mode === "inside" && split.outside.length
          ? `切到「版心外 ${split.outside.length}」或「全部 ${blocks.length}」可以查看。`
          : "切到「全部」可以查看所有块。");
    }
    list.append(empty);
    return;
  }
  visible.forEach((block, index) =>
    list.append(blockCard(block, index, visible.length))
  );
}

function selectReviewBlock(blockId, options = {}) {
  injected.setActiveReviewBlockId(blockId);
  for (const item of part("detail-blocks").children) {
    item.classList.toggle("active", item.dataset.blockId === blockId);
  }
  for (const box of injected.getDetailOverlay().children) {
    const isActive = box.dataset.blockId === blockId;
    box.classList.toggle("box--active", isActive);
    // 只滚 #viewer-scroll（design 4.2），不要用 scrollIntoView 连带滚整页。
    if (isActive && options.scroll !== false) injected.scrollViewerTo(box);
  }
  // 当前块的差异条默认展开。
  injected.getDiffStripOpen().add(blockId);
  injected.syncDiffStrip(blockId);
  injected.updateDiffActive();
  injected.drawDiffLayer();
  // 右下角的"块 3 / 12"（效果图 03）：知道自己改到哪儿了
  const items = [...part("detail-blocks").querySelectorAll(".review-block")];
  const index = items.findIndex((item) => item.dataset.blockId === blockId);
  part("block-position").textContent = index < 0 ? "" : `块 ${index + 1} / ${items.length}`;
}

function focusSiblingBlock(index, delta) {
  const items = [...part("detail-blocks").querySelectorAll(".review-block")];
  const target = items[index + delta];
  if (target) {
    target.querySelector("textarea").focus();
    target.scrollIntoView({ block: "nearest" });
  }
}

function scheduleBlockSave(block, text) {
  injected.setSaveState("正在输入…");
  if (reviewSaveTimer) clearTimeout(reviewSaveTimer);
  reviewPendingSave = { block, text };
  reviewSaveTimer = setTimeout(() => {
    flushPendingSave();
  }, 700);
}

async function flushPendingSave() {
  if (reviewSaveTimer) {
    clearTimeout(reviewSaveTimer);
    reviewSaveTimer = null;
  }
  const pending = reviewPendingSave;
  reviewPendingSave = null;
  if (pending) await patchBlock(pending.block, { text: pending.text });
}

async function adoptLine(block, lineIndex, candidate) {
  if (!block) return;
  if (!candidate) {
    injected.setSaveState("第二引擎没读出这一行，没有可采用的候选", true);
    return;
  }
  await flushPendingSave();
  // 上面可能刚保存过并重载了页面，用重载后的块（revision 才是最新的）
  const fresh =
    (injected.getReviewBlocks() || []).find((item) => item.block_id === block.block_id) || block;
  const lines = String(fresh.text).split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) {
    injected.setSaveState("这一块的行号对不上了，先重新载入", true);
    return;
  }
  lines[lineIndex] = candidate;
  await patchBlock(fresh, { text: lines.join("\n") });
}

async function patchBlock(block, patch) {
  if (!injected.getCurrentProject()) return;
  injected.setSaveState("保存中…");
  // 保存完会整页重渲染：先把"正在改哪一块、光标在哪"记下来，回来再接上。
  // 不这么做的话，打字打到一半自动保存就会把光标顶掉。
  const focusBefore = captureEditorFocus();
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/blocks/${block.block_id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...patch,
          // 乐观并发检查（说明书第 11 节）：拿手上的版本去对，冲突就报错而不是覆盖
          expected_revision: block.revision,
        }),
      }
    );
    injected.setSaveState("已保存 ✓");
    // 类型变了：这一页的建议要重算（接口只返回差异，采用后徽章自然消失）
    if ("block_type" in patch) injected.forgetPageSuggestions(injected.getDetailPageNo());
    await injected.loadPageDetail(injected.getDetailPageNo());
    restoreEditorFocus(focusBefore);
    await injected.refreshPageStates();
  } catch (error) {
    if (error.code === "block_conflict") {
      injected.setSaveState("这一页在别处被改过，已重新载入", true);
      injected.forgetPageSuggestions(injected.getDetailPageNo());
      await injected.loadPageDetail(injected.getDetailPageNo());
      return;
    }
    injected.setSaveState(error.message || "保存失败", true);
  }
}

function captureEditorFocus() {
  const active = document.activeElement;
  if (!active || active.tagName !== "TEXTAREA" || !active.classList.contains("review-block__text")) {
    return null;
  }
  const item = active.closest(".review-block");
  if (!item) return null;
  return {
    blockId: item.dataset.blockId,
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

function restoreEditorFocus(snapshot) {
  if (!snapshot) return;
  const item = injected.ensureBlockListed(snapshot.blockId);
  const textarea = item && item.querySelector("textarea");
  if (!textarea) return;
  textarea.focus();
  try {
    textarea.setSelectionRange(snapshot.start, snapshot.end);
  } catch {
    /* 文本变短了之类的边界情况：光标放到末尾就好 */
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }
}

async function reviewAction(path) {
  if (!injected.getCurrentProject()) return null;
  part("page-detail-error").hidden = true;
  try {
    const data = await injected.apiJson(`/api/projects/${injected.getCurrentProject().project_id}/${path}`, {
      method: "POST",
    });
    injected.setSaveState(data.direction === "undo" ? "已撤销" : "已重做");
    // 撤销 / 重做可能改回块类型与结构：本页块框缓存与建议都不能拿旧的
    injected.forgetPageBlocks(injected.getDetailPageNo());
    await injected.loadPageDetail(injected.getDetailPageNo());
    await injected.refreshPageStates();
    return data;
  } catch (error) {
    showEditorError(error);
    return null;
  }
}


  // ---------------------------------------------------------------- S2：框选新增块（15 函数 / 238 行）
  //
  // 搬进来的私有状态（外壳没有读点）：boxDraft · inkGapsShown · BOX_MIN_WIDTH / BOX_MIN_HEIGHT。
  // 借用的两份：boxCreateMode（外壳 closePageDetail / drawDetailOverlay 读）· detailInkGaps
  // （外壳 pendingPageReasons / renderReviewHeadline 读）——都走注入，模块不留副本。

  let boxDraft = null; // 归一化坐标 {x0, y0, x1, y1}，拖拽中不断更新
  let inkGapsShown = false;
  const BOX_MIN_WIDTH = 0.02;
  const BOX_MIN_HEIGHT = 0.01;

async function createBlockFromBox() {
  const box = boxDraftRect();
  if (!injected.getCurrentProject() || injected.getDetailPageNo() === null || !box) return;
  part("page-detail-error").hidden = true;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/${injected.getDetailPageNo()}/blocks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: part("box-select-text").value, bbox: box }),
      }
    );
    injected.setSaveState("已新增块（可撤销）");
    const created = data.created;
    part("box-select-text").value = "";
    setBoxCreateMode(false);
    // 与"在此块后新增"走同一条刷新路径（新建接口的响应里没有整页载荷）
    await injected.loadPageDetail(injected.getDetailPageNo());
    await injected.refreshPageStates();
    if (created) {
      // 框选出来的块可能落在版心外（比如补一个书眉）：自动切到「全部」，
      // 别让用户以为"创建成功但列表里什么都没有"。
      const item = injected.ensureBlockListed(created.block_id);
      if (item) {
        item.querySelector("textarea").focus();
        item.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  } catch (error) {
    showEditorError(error);
  }
}

async function recognizeBoxRegion() {
  const box = boxDraftRect();
  if (!injected.getCurrentProject() || injected.getDetailPageNo() === null || !box) return;
  const button = part("box-select-recognize");
  const status = part("box-select-status");
  const pageNo = injected.getDetailPageNo();
  button.disabled = true;
  status.textContent = "识别中…";
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/${pageNo}/recognize-region`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox: box }),
      }
    );
    if (injected.getDetailPageNo() !== pageNo) return;
    if (data.text) {
      part("box-select-text").value = data.text;
      part("box-select-text").focus();
      status.textContent =
        `认出 ${data.lines.length} 行（${data.elapsed_seconds}s）· 可以改，再点「创建这一块」`;
    } else {
      status.textContent = "这块里没认出文字；可以直接打字，或换个框";
    }
  } catch (error) {
    status.textContent = error.message || "识别失败";
    showEditorError(error);
  } finally {
    button.disabled = false;
  }
}

function drawInkGapMarks() {
  const layer = injected.getDetailInkGaps();
  layer.innerHTML = "";
  layer.hidden = !inkGapsShown || !injected.getDetailInkGapsState().length;
  if (layer.hidden) return;
  injected.getDetailInkGapsState().forEach((item, index) => {
    const [x0, y0, x1, y1] = item.bbox;
    const rect = document.createElement("button");
    rect.type = "button";
    rect.className = "ink-gap";
    rect.style.left = `${x0 * 100}%`;
    rect.style.top = `${y0 * 100}%`;
    rect.style.width = `${(x1 - x0) * 100}%`;
    rect.style.height = `${(y1 - y0) * 100}%`;
    rect.title =
      `可能漏了这一行（墨迹占页宽 ${(item.ink_ratio * 100).toFixed(1)}%）：` +
      "点一下把它框起来，用「识别这块」认字";
    rect.addEventListener("click", (event) => {
      event.stopPropagation();
      startRegionRecognition(item.bbox);
    });
    layer.append(rect);
  });
}

function onBoxMouseUp(event) {
  if (!boxDraft) return;
  const point = normalizedPoint(event);
  if (point) {
    boxDraft.x1 = point.x;
    boxDraft.y1 = point.y;
  }
  const box = boxDraftRect();
  if (!box || box[2] - box[0] < BOX_MIN_WIDTH || box[3] - box[1] < BOX_MIN_HEIGHT) {
    // 太小（多半是误点）：撤掉，不弹面板
    boxDraft = null;
    part("box-select-rect").hidden = true;
    return;
  }
  drawBoxDraft(); // 定住最后的样子，等用户填文字
  part("box-select-info").textContent =
    `已框选：横向 ${(box[0] * 100).toFixed(0)}–${(box[2] * 100).toFixed(0)}%、` +
    `纵向 ${(box[1] * 100).toFixed(0)}–${(box[3] * 100).toFixed(0)}%（相对这一页）`;
  part("box-select-panel").hidden = false;
  part("box-select-text").focus();
}

async function loadInkGaps(pageNo) {
  injected.setDetailInkGapsState([]);
  inkGapsShown = false;
  renderInkGapBar();
  if (!injected.getCurrentProject() || injected.getCurrentProject().kind === "package") return;
  try {
    const data = await injected.apiJson(
      `/api/projects/${injected.getCurrentProject().project_id}/pages/${pageNo}/ink-gaps`
    );
    if (injected.getDetailPageNo() !== pageNo) return;
    injected.setDetailInkGapsState((data.candidates || []).filter(
      (item) => Array.isArray(item.bbox) && item.bbox.length === 4
    ));
    renderInkGapBar();
    // 漏行是页面级的待处理理由：过滤条与页头结论要跟着变，但不重建正在编辑的列表
    injected.refreshReviewFilterOnly();
    injected.renderReviewHeadline();
  } catch {
    // 辅助信息：读不到不打断审校
  }
}

function setupBoxCreate() {
  const canvas = injected.getDetailCanvas();
  canvas.addEventListener("mousedown", onBoxMouseDown);
  window.addEventListener("mousemove", onBoxMouseMove);
  window.addEventListener("mouseup", onBoxMouseUp);
  part("box-select-confirm").addEventListener("click", createBlockFromBox);
  part("box-select-recognize").addEventListener("click", recognizeBoxRegion);
  part("ink-gap-toggle").addEventListener("click", () => {
    inkGapsShown = !inkGapsShown;
    renderInkGapBar();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && injected.getBoxCreateMode()) setBoxCreateMode(false);
  });
}

function renderInkGapBar() {
  const bar = part("ink-gap-bar");
  if (!inkGapBarVisible(injected.getDetailInkGapsState().length)) {
    bar.hidden = true;
    inkGapsShown = false;
    drawInkGapMarks();
    return;
  }
  bar.hidden = false;
  part("ink-gap-text").textContent =
    `可能漏了 ${injected.getDetailInkGapsState().length} 处：这几行有字，但没有任何块框住`;
  part("ink-gap-toggle").textContent = inkGapsShown ? "收起标记" : "在图上标出";
  drawInkGapMarks();
}

function setBoxCreateMode(on) {
  injected.setBoxCreateMode(on);
  part("detail-box-create").classList.toggle("btn--primary", on);
  injected.getDetailCanvas().classList.toggle("page-canvas--selecting", on);
  if (!on) {
    boxDraft = null;
    part("box-select-rect").hidden = true;
    part("box-select-panel").hidden = true;
    part("box-select-status").textContent = "";
  } else {
    injected.setSaveState("在页面上拖出要新增的区域（Esc 取消）");
  }
}

function drawBoxDraft() {
  const box = boxDraftRect();
  const rect = part("box-select-rect");
  if (!box) {
    rect.hidden = true;
    return;
  }
  rect.hidden = false;
  rect.style.left = `${box[0] * 100}%`;
  rect.style.top = `${box[1] * 100}%`;
  rect.style.width = `${(box[2] - box[0]) * 100}%`;
  rect.style.height = `${(box[3] - box[1]) * 100}%`;
}

function startRegionRecognition(bbox) {
  if (!injected.getBoxCreateMode()) setBoxCreateMode(true);
  boxDraft = { x0: bbox[0], y0: bbox[1], x1: bbox[2], y1: bbox[3] };
  drawBoxDraft();
  part("box-select-panel").hidden = false;
  part("box-select-info").textContent =
    `已框选：横向 ${(bbox[0] * 100).toFixed(0)}–${(bbox[2] * 100).toFixed(0)}%、` +
    `纵向 ${(bbox[1] * 100).toFixed(0)}–${(bbox[3] * 100).toFixed(0)}%（来自漏行标记）`;
  part("box-select-text").value = "";
  part("box-select-text").focus();
  recognizeBoxRegion();
}

function onBoxMouseDown(event) {
  if (!injected.getBoxCreateMode() || event.button !== 0) return;
  const point = normalizedPoint(event);
  if (!point) return;
  event.preventDefault();
  boxDraft = { x0: point.x, y0: point.y, x1: point.x, y1: point.y };
  part("box-select-panel").hidden = true;
  part("box-select-status").textContent = "";
  drawBoxDraft();
}

function normalizedPoint(event) {
  const image = injected.getDetailImage();
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1),
    y: Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1),
  };
}

function boxDraftRect() {
  if (!boxDraft) return null;
  return [
    Math.min(boxDraft.x0, boxDraft.x1),
    Math.min(boxDraft.y0, boxDraft.y1),
    Math.max(boxDraft.x0, boxDraft.x1),
    Math.max(boxDraft.y0, boxDraft.y1),
  ];
}

function onBoxMouseMove(event) {
  if (!boxDraft) return;
  const point = normalizedPoint(event);
  if (!point) return;
  boxDraft.x1 = point.x;
  boxDraft.y1 = point.y;
  drawBoxDraft();
}

function inkGapBarVisible(count) {
  return count > 0;
}

  // ---------------------------------------------------------------- 接线 + 接口

  function openBoxCreate() {
    if (typeof injected.setBoxCreateMode === "function") injected.setBoxCreateMode(true);
  }

  function cancelBoxCreate() {
    if (typeof injected.setBoxCreateMode === "function") injected.setBoxCreateMode(false);
  }

  /** reviewBlockFilter / reviewFilterExplicit 的写点收成能力（外壳 setReviewBlockFilter 调它）。 */
  function setFilter(mode, explicit = false) {
    if (!["pending", "inside", "outside", "all"].includes(mode)) return;
    if (typeof injected.setReviewBlockFilter === "function") injected.setReviewBlockFilter(mode);
    if (explicit && typeof injected.setReviewFilterExplicit === "function") {
      injected.setReviewFilterExplicit(true);
    }
    renderReviewBlocks(injected.getReviewBlocks());
  }

  /** 包模式：模块自己那两个入口的显隐（原 applyPackageMode 里的两行）。 */
  function applyPackageChrome(on) {
    const recognize = part("detail-recognize");
    if (recognize) recognize.hidden = Boolean(on);
    const auxRun = part("aux-run");
    if (auxRun) auxRun.hidden = Boolean(on);
  }

  // ---------------------------------------------------------------- S3：建议工具 + 版面确认
  //
  // 「采用全部高把握建议」按钮与版面面板都在 #view-review 子树里，和块列表同一个 owner。
  // `detailLayoutConfirmed` 是外壳状态（renderPageDetail 写），模块只读、走注入。

  function renderSuggestionTools() {
    const button = part("suggestion-apply-all");
    if (!button) return;
    const high = suggestionHighList();
    if (!high.length) {
      button.hidden = true;
      button.textContent = "";
      button.removeAttribute("title");
      return;
    }
    const labels = [
      ...new Set(
        high.map((item) => injected.BLOCK_TYPE_LABELS[item.suggested_type] || item.suggested_type)
      ),
    ];
    button.hidden = false;
    button.textContent = `采用全部高把握建议（${high.length}）`;
    button.title =
      `本页有 ${high.length} 条把握较大的建议（${labels.join(" / ")}）：` +
      "一次改成对应类型，只改类型、不改审校状态；每一块都能单独撤销。";
  }

  /** 版面面板：页面确认（这页算不算正文）与版面确认（这页里哪些块算正文）分开说。 */
  function renderLayoutPanel(data = null) {
    const panel = part("layout-panel");
    if (!panel) return;
    const project = injected.getCurrentProject();
    if (!project || project.kind === "package") {
      panel.hidden = true;
      return;
    }
    const reviewBlocks = injected.getReviewBlocks();
    const blockCount =
      (data && data.review && data.review.block_count) ||
      (data && data.blocks ? data.blocks.length : reviewBlocks.length);
    const high = suggestionHighList().length;
    const confirmed = data && data.page
      ? Boolean(data.page.layout_confirmed)
      : injected.getDetailLayoutConfirmed();
    panel.hidden = false;
    const status = part("layout-panel-status");
    status.textContent =
      `本页版面：${blockCount} 块 · 高把握建议 ${high} · ${confirmed ? "✓ 已确认" : "未确认"}`;
    status.classList.toggle("is-ok", confirmed);
    const button = part("layout-confirm");
    button.textContent = confirmed ? "✓ 版面已确认" : "确认本页版面";
    button.disabled = confirmed;
  }

  async function confirmPageLayout() {
    const project = injected.getCurrentProject();
    const pageNo = injected.getDetailPageNo();
    if (!project || pageNo === null) return;
    const button = part("layout-confirm");
    button.disabled = true;
    injected.setSaveState("正在确认版面…");
    try {
      await injected.apiJson(
        `/api/projects/${project.project_id}/pages/${pageNo}/layout/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page_numbers: [pageNo] }),
        }
      );
      injected.setSaveState("版面已确认 ✓");
      await injected.loadPageDetail(pageNo);
      await injected.refreshPageStates();
    } catch (error) {
      injected.setSaveState(error.message || "版面确认失败", true);
      showEditorError(error);
    }
  }

  let wired = false;

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    root = injected.root || null;
    // 这块面板的元素在整个生命周期里都是同一批（换页只重绘、不换 DOM）⇒ 接线只做一次；
    // 即便被重复 init，也不许重复绑（否则一次点击/拖动触发两次）。
    if (wired) return api;
    wired = true;
    setupBoxCreate();
    const bind = (id, handler) => {
      const node = part(id);
      if (node) node.addEventListener("click", handler);
    };
    bind("review-undo", () => reviewAction("undo"));
    bind("review-redo", () => reviewAction("redo"));
    bind("suggestion-apply-all", () => adoptAllHighSuggestions());
    bind("detail-box-create", () => openBoxCreate());
    bind("box-select-cancel", () => cancelBoxCreate());
    bind("layout-confirm", () => confirmPageLayout());
    return api;
  }

  const api = {
    init,
    renderBlocks: renderReviewBlocks,
    setFilter,
    setPackageModeChrome: applyPackageChrome,
    setBoxCreateMode,
    loadInkGaps,
    // S3：面板自己的两个渲染入口（外壳在 renderPageDetail 里画完核心抽屉后喊它们）
    renderSuggestionTools,
    renderLayoutPanel,
    // 下面这批是"外壳仍有真调用点"的成员（§1 ⑦：每导出一个成员就要能指出谁在哪调它）。
    // 书 §3 的 T 清单是预测；不导出就得在外壳复制实现，所以这里只留 app.js 真喊得到的名字。
    // 移出导出面的（只剩模块内部调用）：showError · openBoxCreate · cancelBoxCreate ·
    // setupBoxCreate · suggestionHighList（S3 之后 app.js 那两处调用都随函数进了模块）。
    applyDetailSuggestions,
    refreshDetailSuggestions,
    blockNeedsReview,
    pageNumberHintChip,
    adoptBlockSuggestion,
    adoptAllHighSuggestions,
    truncate,
    selectReviewBlock,
    flushPendingSave,
    adoptLine,
    patchBlock,
    reviewAction,
  };
  window.PageDetailEditor = api;
})();
