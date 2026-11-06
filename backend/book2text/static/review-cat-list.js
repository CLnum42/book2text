// 正文审校 v3：上方差异列表（四列：序号 / 单行裁图 / 状态 / 正文）。
//
// 边界（docs/refactor/review-cat-boundary.md §2/§7）：
//   · 只读投影：不拉队列、不存队列、不存 runs —— 行数据全部由外壳 setQueue() 注入；
//   · 单向：renderCrop 由外壳注入（它归 review-focus），本模块不自己画图、不直呼别的模块；
//   · DOM 面 = 0：元素由 init 传进来（listEl / counterEl），模块不查 DOM、不持 root；
//   · 状态三态：未判 / 待提交 / 已确认（已确认且改过 = 绿 + 底纹），色值只在 CSS 里。
//
// 本文件不含接线（index.html / app.js / 登记表都不动），接线由外壳下一轮做。
(function () {
  "use strict";

  let injected = {};
  let listEl = null;
  let counterEl = null;
  let rows = [];
  let total = 0;
  let currentKey = null;
  const nodes = new Map(); // key → <li>

  /** 序号列：1..N（当前位置），不是任何 id。 */
  function rclIndexLabel(row, position) {
    return String(position);
  }

  /** 空态文案：队列为空 / 没字框 / 超长行 —— 三种都不许白屏。 */
  function rclMissingNote(row) {
    if (!row) return "";
    if (row.noBoxes) return "无字框";
    return "—";
  }

  function rclStateLabel(state) {
    if (state === "confirmed") return "已确认";
    if (state === "draft") return "待提交";
    return "未判";
  }

  function rclStateClass(state, edited) {
    if (state === "confirmed") return edited ? "rcl-row--confirmed rcl-row--edited" : "rcl-row--confirmed";
    if (state === "draft") return "rcl-row--draft";
    return "rcl-row--unjudged";
  }

  /** 这一行要居中的那一段：取第一个 run 的 a 侧区间；没有 runs 时返回 null（整行显示）。 */
  function rclFocusSpan(row) {
    const runs = (row && row.runs) || [];
    if (!runs.length) return null;
    const first = runs[0];
    const start = Number(first.a_start);
    const end = Number(first.a_end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start: start, end: Math.max(end, start), run: first };
  }

  /**
   * 这一处涉及的字数：max(len(from), len(to))；两侧都为空时退回 a 侧区间长度。
   * 用于 >3 字时显示「整行 · N 字」（spec §10.3），不从后端再取数。
   */
  function rclRunLength(run) {
    if (!run) return 0;
    const from = String(run.from == null ? "" : run.from);
    const to = String(run.to == null ? "" : run.to);
    const byText = Math.max(from.length, to.length);
    if (byText > 0) return byText;
    const start = Number(run.a_start);
    const end = Number(run.a_end);
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  }

  /**
   * 正文列片段：把差异放在中间，两端补「……」。
   * `radius` 是差异两侧各留多少字；超长行只取这一段，不在 DOM 里放整行。
   */
  function rclTextWindow(row, radius) {
    const text = String((row && row.text) || "");
    const span = rclFocusSpan(row);
    if (!text) return { before: "", changed: "", after: "", lead: false, trail: false };
    if (!span) return { before: text, changed: "", after: "", lead: false, trail: false };
    const from = Math.max(0, span.start - radius);
    const to = Math.min(text.length, span.end + radius);
    return {
      before: text.slice(from, span.start),
      changed: text.slice(span.start, Math.min(span.end, text.length)),
      after: text.slice(Math.min(span.end, text.length), to),
      lead: from > 0,
      trail: to < text.length,
    };
  }

  /** 正文列 DOM：两端「……」+ 差异字红标。 */
  function rclTextCell(row) {
    const cell = document.createElement("div");
    cell.className = "rcl-cell rcl-cell--text";
    const span0 = rclFocusSpan(row);
    const length = span0 ? rclRunLength(span0.run) : 0;
    if (length > 3) {
      // >3 字不显示原文，只报「整行 · N 字」（spec §10.3）
      cell.textContent = `整行 · ${length} 字`;
      cell.title = String((row && row.text) || "").slice(0, 200);
      return cell;
    }
    const window_ = rclTextWindow(row, 18);
    if (window_.lead) cell.append(document.createTextNode("……"));
    if (window_.before) cell.append(document.createTextNode(window_.before));
    if (window_.changed) {
      const mark = document.createElement("mark");
      mark.className = "rcl-diff";
      mark.textContent = window_.changed;
      cell.append(mark);
    }
    if (window_.after) cell.append(document.createTextNode(window_.after));
    if (window_.trail) cell.append(document.createTextNode("……"));
    return cell;
  }

  /** 裁图列：调外壳注入的 renderCrop（它归 review-focus），本模块不画图。 */
  function rclCropCell(row) {
    const cell = document.createElement("div");
    cell.className = "rcl-cell rcl-cell--crop";
    const span = rclFocusSpan(row);
    const bbox = (span && span.run && span.run.anchor_bbox) || (row && row.lineBbox) || null;
    if (!bbox) {
      cell.classList.add("rcl-cell--missing");
      cell.textContent = row && row.noBoxes ? "无字框" : "—";
      return cell;
    }
    if (typeof injected.renderCrop !== "function") {
      cell.classList.add("rcl-cell--missing");
      cell.textContent = "—";
      return cell;
    }
    cell.append(
      injected.renderCrop(bbox, {
        width: 240,
        height: 56,
        scale: 1,
        imgW: Number(row.imgW) || 0,
        imgH: Number(row.imgH) || 0,
        url: row.cropUrl || "",
        alt: `第 ${row.pageNo || "?"} 页`,
      })
    );
    return cell;
  }

  function rclRowElement(row, position) {
    const item = document.createElement("li");
    item.className = "rcl-row";
    item.dataset.key = String(row.key || row.lineId || position);
    item.classList.add(...rclStateClass(row.state, row.edited).split(" "));
    const index = document.createElement("span");
    index.className = "rcl-cell rcl-cell--index";
    index.textContent = rclIndexLabel(row, position);

    const state = document.createElement("span");
    state.className = "rcl-cell rcl-cell--state";
    state.textContent = rclStateLabel(row.state);

    item.append(index, rclCropCell(row), state, rclTextCell(row));
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
    const list = listEl;
    if (!listEl) return;
    nodes.clear();
    list.innerHTML = "";
    if (!rows.length) {
      list.append(rclEmpty(total ? "这一页没有差异行。" : "还没有可审校的差异（先识别、再看第二引擎有没有复核）。"));
      rclRenderCounter();
      return;
    }
    rows.forEach((row, index) => list.append(rclRowElement(row, index + 1)));
    rclHighlight();
    rclRenderCounter();
  }

  function rclRenderCounter() {
    const counter = counterEl;
    if (!counterEl) return;
    const index = Math.max(0, rows.findIndex((row) => String(row.key) === String(currentKey)));
    const position = currentKey === null ? 0 : index + 1;
    counter.textContent = `${position} / ${total || rows.length}`;
  }

  function rclHighlight() {
    for (const node of nodes.values()) node.classList.remove("rcl-row--current");
    const node = nodes.get(String(currentKey));
    if (node) node.classList.add("rcl-row--current");
    rclRenderCounter();
  }

  function setQueue(payload) {
    const data = payload || {};
    rows = Array.isArray(data.rows) ? data.rows : [];
    total = Number.isFinite(Number(data.total)) ? Number(data.total) : rows.length;
    if (Number.isInteger(data.currentIndex) && data.currentIndex >= 0 && rows[data.currentIndex]) {
      currentKey = String(rows[data.currentIndex].key);
    } else if (currentKey === null && rows.length) {
      currentKey = String(rows[0].key);
    }
    rclRender();
    return api;
  }

  function show(item) {
    if (item && item.key !== undefined && item.key !== null) {
      currentKey = String(item.key);
    }
    rclHighlight();
    const node = nodes.get(String(currentKey));
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
    return api;
  }

  function init(deps) {
    const options = deps || {};
    injected = Object.assign({}, injected, options);
    listEl = options.listEl || listEl;
    counterEl = options.counterEl || counterEl;
    return api;
  }

  const api = { init, setQueue, show };

  window.ReviewCatList = api;
})();
