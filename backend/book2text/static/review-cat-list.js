// 正文审校 v3：上方差异列表（四列：序号 / 单行取景 / 状态 / 正文）。
//
// 规格出处：`docs/ux/review-cat-list-v3.md`
//   §2  行 64 / 序号 32 / 取景窗 340×34（字高 22px、±8 字、按差异字居中）/ gutter 72 / 正文 15.5px 宋体
//   §6  三色语义：未审红 / 待提交黄 / 已确认绿（改过加行底纹；保留原文不染）
//   §8  文字列差异字落在中轴（左右两段等分、两端补「……」）
//
// 关键口径（2026-11-10 修）：
//   ① runs 必须**按页**取，不是只取第一行那一页——否则其余行没有差异区间，红标是空的（用户看不到要审的字）。
//   ② 取景窗缩放按「字高 22px」算：scale = 22 / (行框高 × 0.72)。旧写法按"填满 56px 高"算，
//      300dpi 的页图上字高被放大到 ~38px，一屏只剩 4–5 个糊字——这正是"看不到要审的内容"。
//
// 边界：只读投影——不拉队列、不存队列；行数据由外壳 setQueue() 注入；
//       取 runs 走外壳注入的 loadRuns(pageNo)（外壳负责缓存与 token），本模块不直呼别的模块。
(function () {
  "use strict";

  const RCL_FONT_PX = 22;        // 设计 §2：取景窗里的字高
  const RCL_GLYPH_RATIO = 0.72;  // 行框高度里字面占的比例（300dpi 页图实测）
  const RCL_CROP_H = 34;         // 取景窗高度
  const RCL_TEXT_RADIUS = 18;    // 差异两侧各取多少字
  const RCL_EAGER_ROWS = 16;     // 首屏先给这些行取 runs（其余靠滚动触发）

  let injected = {};
  let listEl = null;
  let counterEl = null;
  let rows = [];
  let total = 0;
  let currentKey = null;
  const nodes = new Map();        // key → <li>
  const pageRuns = new Map();     // pageNo → { byKey, imgW, imgH, url }
  const pageLoading = new Map();  // pageNo → Promise
  let observer = null;

  const rclClamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function rclKey(row) {
    return String((row && row.key) || `${row && row.blockId}:${row.lineIndex}`);
  }

  function rclStateCellLabel(row) {
    if (row && row.state === "confirmed") return "已确认";
    if (row && row.state === "draft") return "待提交";
    return "未审";
  }

  function rclStateSubLabel(row) {
    if (!row || row.state !== "confirmed") return "";
    return row.edited ? "改过" : "未改动";
  }

  function rclStateClass(row) {
    if (row && row.state === "confirmed") return row.edited ? "rcl-row--confirmed rcl-row--edited" : "rcl-row--confirmed";
    if (row && row.state === "draft") return "rcl-row--draft";
    return "rcl-row--unjudged";
  }

  // ---------------------------------------------------------------- 页级 runs
  function rclIndexPage(page) {
    const byKey = new Map();
    for (const item of (page && page.runs) || []) {
      byKey.set(`${item.block_id}:${item.line_index}`, item.runs || []);
    }
    return { byKey, imgW: Number(page && page.imgW) || 0, imgH: Number(page && page.imgH) || 0, url: (page && page.url) || "" };
  }

  function rclRunsFor(row) {
    const page = pageRuns.get(Number(row && row.pageNo));
    if (!page) return [];
    return page.byKey.get(`${row.blockId}:${row.lineIndex}`) || [];
  }

  /**
   * 兜底：页级 runs 还没到 / 这一行不在 line-runs 里时，用 current 与 candidate 现算差异区间。
   * **不依赖任何请求**——否则「那一段该红」就全靠接口，接口一缺整行就没有标记（2026-11-10 用户看到的正是这种）。
   * 只算首尾公共前缀/后缀，够定位一处差异；多段差异仍以接口的 runs 为准。
   */
  function rclFallbackRun(row) {
    const text = String((row && row.text) || "");
    const candidate = String((row && row.candidate) || "");
    if (!text || !candidate || text === candidate) return null;
    let start = 0;
    const limit = Math.min(text.length, candidate.length);
    while (start < limit && text[start] === candidate[start]) start += 1;
    let tail = 0;
    while (
      tail < limit - start
      && text[text.length - 1 - tail] === candidate[candidate.length - 1 - tail]
    ) tail += 1;
    const end = Math.max(start, text.length - tail);
    return {
      a_start: start,
      a_end: end,
      from: text.slice(start, end),
      to: candidate.slice(start, Math.max(start, candidate.length - tail)),
      bbox: null,
      fallback: true,
    };
  }

  /** 这一行用来标红 / 定位的 runs：接口优先，缺了用现算的兜底。 */
  function rclEffectiveRuns(row) {
    const runs = rclRunsFor(row);
    if (runs.length) return runs;
    const fallback = rclFallbackRun(row);
    return fallback ? [fallback] : [];
  }

  function rclEnsureRuns(row) {
    const pageNo = Number(row && row.pageNo);
    if (!pageNo || typeof injected.loadRuns !== "function") return;
    if (pageRuns.has(pageNo) || pageLoading.has(pageNo)) return;
    const task = Promise.resolve(injected.loadRuns(pageNo))
      .then((page) => {
        pageLoading.delete(pageNo);
        pageRuns.set(pageNo, rclIndexPage(page));
        rclRefreshPage(pageNo);
      })
      .catch(() => { pageLoading.delete(pageNo); });
    pageLoading.set(pageNo, task);
  }

  /** 一页的 runs 到了：只重画这一页的行（不整表重画，免得滚动位置跳）。 */
  function rclRefreshPage(pageNo) {
    for (const [key, node] of [...nodes.entries()]) {
      const row = rows.find((item) => rclKey(item) === key);
      if (!row || Number(row.pageNo) !== Number(pageNo)) continue;
      const next = rclRowElement(row, Number(node.dataset.position) || 1);
      node.replaceWith(next);
      nodes.set(key, next);
      if (observer) observer.observe(next);
    }
  }

  // ---------------------------------------------------------------- 取景（左列）
  function rclCropWidth() {
    if (!listEl || typeof getComputedStyle !== "function") return 340;
    const raw = getComputedStyle(listEl).getPropertyValue("--rcl-crop-w").trim();
    const width = parseFloat(raw);
    return Number.isFinite(width) && width > 0 ? width : 340;
  }

  /**
   * 缩放：让**字高 ≈ 22px**。行框高（页图像素）= lineBbox 高 × imgH；
   * run.bbox 可能是零宽/矮框（插入、删标点），所以取两者较大值兜底，避免放大成巨字。
   */
  function rclCropScale(row, run, page) {
    const imgH = page.imgH || 0;
    const lineH = row && row.lineBbox ? Math.abs(row.lineBbox[3] - row.lineBbox[1]) * imgH : 0;
    const runH = run && run.bbox ? Math.abs(run.bbox[3] - run.bbox[1]) * imgH : 0;
    const boxH = Math.max(lineH, runH, 1);
    return rclClamp(RCL_FONT_PX / (boxH * RCL_GLYPH_RATIO), 0.2, 1.0);
  }

  function rclCropCell(row) {
    const cell = document.createElement("div");
    cell.className = "rcl-cell rcl-cell--crop";
    const runs = rclRunsFor(row);
    const run = runs[0] || null;
    let box = (run && run.bbox) || (row && row.lineBbox) || null;
    // 没有 runs（页级接口缺这一行）时：用兜底差异区间在行框里按字序插值，
    // 估计差异字的大致横坐标 —— 否则取景只会停在整行中点，看着不像"对准差异字"。
    if (!run && box && row.state !== "confirmed") {
      const fallback = rclFallbackRun(row);
      const length = String(row.text || "").length;
      if (fallback && length > 0) {
        const ratio = (fallback.a_start + fallback.a_end) / 2 / length;
        const x = box[0] + ratio * (box[2] - box[0]);
        box = [x, box[1], x, box[3]];
      }
    }
    const page = pageRuns.get(Number(row && row.pageNo));
    if (!box || !page || !page.url || !page.imgW || !page.imgH) {
      cell.classList.add("rcl-cell--missing");
      cell.textContent = row && row.noBoxes && !page ? "取景中…" : "—";
      return cell;
    }
    if (typeof injected.renderCrop !== "function") {
      cell.classList.add("rcl-cell--missing");
      cell.textContent = "—";
      return cell;
    }
    // 色块颜色跟状态走：未审红 / 待提交黄 / 已确认绿（与右侧文字标记同色系）
    const tone = row.state === "confirmed" ? "done" : row.state === "draft" ? "draft" : "machine";
    const highlights = (runs.length ? runs : [])
      .filter((item) => Array.isArray(item.bbox))
      .map((item) => ({ bbox: item.bbox, tone }));
    cell.append(
      injected.renderCrop(box, {
        width: rclCropWidth(),
        height: RCL_CROP_H,
        scale: rclCropScale(row, run, page),
        imgW: page.imgW,
        imgH: page.imgH,
        url: page.url,
        alt: `第 ${row.pageNo || "?"} 页`,
        highlights,
      })
    );
    return cell;
  }

  // ---------------------------------------------------------------- 正文（右列）
  /** 把 run 的 a 区间落到这一行的显示文本上；对不上就用 from 就近匹配（换行/空格可能差一个字）。 */
  function rclSpanOf(run, text) {
    const start = Number(run && run.a_start);
    const end = Number(run && run.a_end);
    const from = String((run && run.from) == null ? "" : run.from);
    if (!Number.isFinite(start) || start < 0 || start > text.length) return null;
    const width = Number.isFinite(end) ? Math.max(0, end - start) : from.length;
    if (text.slice(start, start + width) === from) return { start, end: start + width, run };
    if (from) {
      const near = text.indexOf(from, Math.max(0, start - 2));
      if (near >= 0) return { start: near, end: near + from.length, run };
    }
    return { start, end: start + width, run };
  }

  function rclMarkFor(row, span) {
    const mark = document.createElement("mark");
    const tone = row.state === "confirmed" ? "done" : row.state === "draft" ? "draft" : "machine";
    mark.className = `rcl-diff rcl-diff--${tone}`;
    if (span.end <= span.start) {
      mark.classList.add("rcl-diff--caret");   // 插入 / 删标点：零宽，画一个细竖标
    } else {
      mark.textContent = String(row.text || "").slice(span.start, span.end);
    }
    return mark;
  }

  function rclTextCell(row) {
    const cell = document.createElement("div");
    cell.className = "rcl-cell rcl-cell--text";
    const text = String((row && row.text) || "");
    const runs = rclEffectiveRuns(row);
    // 已确认·保留原文：判过但没改字 ⇒ 不染（§6）
    if (!runs.length || (row.state === "confirmed" && !row.edited)) {
      cell.textContent = text;
      return cell;
    }
    const spans = runs.map((run) => rclSpanOf(run, text)).filter(Boolean).sort((a, b) => a.start - b.start);
    if (!spans.length) {
      cell.textContent = text;
      return cell;
    }
    const first = spans[0];
    const anchorEnd = Math.max(first.end, first.start + 1);
    const from = Math.max(0, first.start - RCL_TEXT_RADIUS);
    const to = Math.min(text.length, anchorEnd + RCL_TEXT_RADIUS);

    const left = document.createElement("span");
    left.className = "rcl-text__side rcl-text__side--l";
    left.textContent = (from > 0 ? "……" : "") + text.slice(from, first.start);

    const middle = document.createElement("span");
    middle.className = "rcl-text__mid";
    middle.append(rclMarkFor(row, first));

    const right = document.createElement("span");
    right.className = "rcl-text__side rcl-text__side--r";
    let cursor = anchorEnd;
    for (const span of spans.slice(1)) {
      if (span.start < cursor || span.start >= to) continue;
      right.append(document.createTextNode(text.slice(cursor, span.start)));
      right.append(rclMarkFor(row, span));
      cursor = Math.max(cursor, span.end);
    }
    right.append(document.createTextNode(text.slice(cursor, to)));
    if (to < text.length) right.append(document.createTextNode("……"));

    cell.append(left, middle, right);
    return cell;
  }

  // ---------------------------------------------------------------- 双版本（设计 §9/§10）
  /**
   * 双版本标签（设计 §9/§10）：前 1 字 + **差异字（加粗着色）** + 后 1 字；
   * >3 字只报「整行 · N 字」不缩字号（§10.1）；这一侧没有字（纯插入/纯删除）写 ∅。
   */
  function rclVersionNode(text, start, end, run) {
    const fragment = document.createDocumentFragment();
    const source = String(text || "");
    const begin = Number.isFinite(start) ? start : -1;
    const finish = Number.isFinite(end) ? end : begin;
    const core = begin >= 0 ? source.slice(begin, Math.max(finish, begin)) : "";
    const length = core.length || (run ? rclRunLength(run) : 0);
    if (length > 3) {
      fragment.append(document.createTextNode(`整行 · ${length} 字`));
      return fragment;
    }
    if (!core) {
      fragment.append(document.createTextNode("∅"));
      return fragment;
    }
    if (begin > 0) fragment.append(document.createTextNode(source.slice(begin - 1, begin)));
    const mid = document.createElement("span");
    mid.className = "rcl-ver__core";
    mid.textContent = core;
    fragment.append(mid);
    if (finish < source.length) fragment.append(document.createTextNode(source.slice(finish, finish + 1)));
    return fragment;
  }

  function rclRunLength(run) {
    if (!run) return 0;
    const from = String(run.from == null ? "" : run.from);
    const to = String(run.to == null ? "" : run.to);
    return Math.max(from.length, to.length);
  }

  /** 候选侧：在 candidate 里找到 run.to 的位置；纯删除（to 为空）写 ∅，不拿候选首字冒充。 */
  function rclCandidateNode(row, run) {
    const candidate = String((row && row.candidate) || "");
    const to = String((run && run.to) == null ? "" : run.to);
    const fragment = document.createDocumentFragment();
    if (!candidate) { fragment.append(document.createTextNode("—")); return fragment; }
    if (!to) { fragment.append(document.createTextNode("∅")); return fragment; }
    const at = candidate.indexOf(to);
    return rclVersionNode(candidate, at < 0 ? 0 : at, (at < 0 ? 0 : at) + to.length, run);
  }

  function rclVersionsCell(row) {
    const cell = document.createElement("div");
    cell.className = "rcl-cell rcl-cell--versions";
    if (row.state === "confirmed") {
      const done = document.createElement("span");
      done.className = "rcl-done-note";
      done.textContent = row.edited ? "已确认 · 采用候选" : "已确认 · 保留原文";
      cell.append(done);
      return cell;
    }
    const runs = rclEffectiveRuns(row);
    const run = runs[0] || null;
    const span = run ? rclSpanOf(run, String(row.text || "")) : null;
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "rcl-ver rcl-ver--keep";
    keep.title = "保留当前文本（这一行按当前文本导出）";
    keep.append(span ? rclVersionNode(row.text, span.start, span.end, run) : document.createTextNode("保留"));

    const adopt = document.createElement("button");
    adopt.type = "button";
    adopt.className = "rcl-ver rcl-ver--adopt";
    adopt.title = "采用第二引擎的候选文本";
    adopt.append(run ? rclCandidateNode(row, run) : document.createTextNode("采用"));
    adopt.disabled = !String(row.candidate || "");
    adopt.title = adopt.disabled ? "这一行没有候选文本（第二引擎没给出）" : "采用第二引擎的候选文本";

    const ack = (value) => {
      if (typeof injected.onAck !== "function") return;
      keep.disabled = true;
      adopt.disabled = true;
      Promise.resolve(injected.onAck(row, value)).catch(() => {
        keep.disabled = false;
        adopt.disabled = false;
      });
    };
    keep.addEventListener("click", (event) => { event.stopPropagation(); ack("kept"); });
    adopt.addEventListener("click", (event) => { event.stopPropagation(); ack("adopted"); });
    cell.append(keep, adopt);
    return cell;
  }

  // ---------------------------------------------------------------- 行
  function rclIndexLabel(row, position) {
    return String(position);
  }

  function rclRowElement(row, position) {
    const item = document.createElement("li");
    item.className = `rcl-row ${rclStateClass(row)}`;
    item.dataset.key = rclKey(row);
    item.dataset.position = String(position);

    const index = document.createElement("span");
    index.className = "rcl-cell rcl-cell--index";
    index.textContent = rclIndexLabel(row, position);

    const state = document.createElement("span");
    state.className = "rcl-cell rcl-cell--state";
    const dot = document.createElement("span");
    dot.className = "rcl-dot";
    const label = document.createElement("span");
    label.className = "rcl-state__label";
    label.textContent = rclStateCellLabel(row);
    const sub = document.createElement("span");
    sub.className = "rcl-state__sub";
    sub.textContent = rclStateSubLabel(row);
    state.append(dot, label, sub);

    item.append(index, rclCropCell(row), state, rclTextCell(row), rclVersionsCell(row));
    item.addEventListener("click", () => {
      currentKey = item.dataset.key;
      rclHighlight();
      if (typeof injected.onSelect === "function") injected.onSelect(row);
    });
    nodes.set(item.dataset.key, item);
    return item;
  }

  function rclEmpty(message) {
    const p = document.createElement("p");
    p.className = "rcl-empty muted";
    p.textContent = message;
    return p;
  }

  function rclRender() {
    if (!listEl) return;
    if (observer) observer.disconnect();
    nodes.clear();
    listEl.innerHTML = "";
    if (!rows.length) {
      listEl.append(rclEmpty(total ? "这一页没有差异行。" : "还没有可审校的差异（先识别、再看第二引擎有没有复核）。"));
      rclRenderCounter();
      return;
    }
    const eager = Math.min(rows.length, RCL_EAGER_ROWS);
    rows.forEach((row, index) => {
      const node = rclRowElement(row, index + 1);
      listEl.append(node);
      if (index < eager) rclEnsureRuns(row);
      else if (observer) observer.observe(node);
    });
    rclHighlight();
    rclRenderCounter();
  }

  function rclRenderCounter() {
    if (!counterEl) return;
    const index = rows.findIndex((row) => rclKey(row) === String(currentKey));
    const position = index < 0 ? 0 : index + 1;
    const counts = injected.counts || null;
    const tail = counts && Number(counts.chars_unacked) === 0 && Number(counts.punct_unacked) > 0
      ? ` · 汉字已判完，还剩 ${Number(counts.punct_unacked)} 处标点待批量判`
      : "";
    counterEl.textContent = `当前第 ${position} / ${total || rows.length}${tail}`;
  }

  function rclHighlight() {
    for (const node of nodes.values()) node.classList.remove("rcl-row--current");
    const node = nodes.get(String(currentKey));
    if (node) node.classList.add("rcl-row--current");
    rclRenderCounter();
  }

  function rclCurrentRow() {
    return rows.find((row) => rclKey(row) === String(currentKey)) || null;
  }

  // ---------------------------------------------------------------- 对外
  function setQueue(payload) {
    const data = payload || {};
    rows = Array.isArray(data.rows) ? data.rows : [];
    total = Number.isFinite(Number(data.total)) ? Number(data.total) : rows.length;
    if (data.counts) injected.counts = data.counts;
    if (Number.isInteger(data.currentIndex) && data.currentIndex >= 0 && rows[data.currentIndex]) {
      currentKey = rclKey(rows[data.currentIndex]);
    } else if (!currentKey && rows.length) {
      currentKey = rclKey(rows[0]);
    }
    rclRender();
    if (typeof injected.onCurrent === "function") injected.onCurrent(rclCurrentRow());
    return api;
  }

  function show(item) {
    if (item && item.key !== undefined && item.key !== null) currentKey = String(item.key);
    rclHighlight();
    const node = nodes.get(String(currentKey));
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
    return api;
  }

  function init(deps) {
    const options = deps || {};
    injected = Object.assign({}, injected, options);
    listEl = options.listEl || listEl;
    counterEl = options.counterEl || counterEl;
    if (options.listEl && typeof IntersectionObserver === "function" && !observer) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const row = rows.find((item) => rclKey(item) === entry.target.dataset.key);
            if (row) rclEnsureRuns(row);
          }
        },
        { root: listEl, rootMargin: "240px 0px" }
      );
    }
    return api;
  }

  const api = { init, setQueue, show };

  window.ReviewCatList = api;
})();
