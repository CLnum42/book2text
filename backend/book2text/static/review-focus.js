// 审校页的取景与上下文（`window.ReviewFocus`）。
//
// 规格出处：`docs/ux/review-cat-list-v3.md`
//   §2  取景窗按差异字居中；上下文是**一整块三行页图**（640 宽，当前行 2px 蓝框）+ 右侧三行文本
//   §6  三色语义与列表同源（机器差异红 / 待提交黄 / 已确认绿）
//
// 两条口径（2026-11-10 修）：
//   ① 取景缩放按「字高 22px」算（`22 / (行框高 × 0.72)`），不是"填满窗口高"——
//      后者在 300dpi 页图上把字放大到 ~38px，只能看到 4–5 个糊字。
//   ② 页图窗口一律 clamp 在图片内，边缘渐隐；不 clamp 时靠页边的行会露出半屏空白。
//
// 数据：runs 由外壳注入的 `loadRuns(pageNo)` 按页取（与列表共用同一个缓存），本模块不直呼别的模块。
(function () {
  "use strict";

  const RF_FONT_PX = 22;
  const RF_GLYPH_RATIO = 0.72;
  const RF_CONTEXT_W = 480;
  const RF_CONTEXT_PAD = 12;

  let injected = {};
  const pageRuns = new Map();
  const pageLoading = new Map();
  let contextToken = 0;

  const rfClamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function rfKey(row) {
    return String((row && row.key) || `${row && row.blockId}:${row.lineIndex}`);
  }

  function rfIndexPage(page) {
    const byKey = new Map();
    for (const item of (page && page.runs) || []) {
      byKey.set(`${item.block_id}:${item.line_index}`, item.runs || []);
    }
    return { byKey, imgW: Number(page && page.imgW) || 0, imgH: Number(page && page.imgH) || 0, url: (page && page.url) || "" };
  }

  function rfRunsFor(row) {
    const page = pageRuns.get(Number(row && row.pageNo));
    if (!page) return [];
    return page.byKey.get(`${row.blockId}:${row.lineIndex}`) || [];
  }

  function rfLoad(pageNo) {
    if (typeof injected.loadRuns !== "function") return Promise.resolve(null);
    if (pageRuns.has(pageNo)) return Promise.resolve(pageRuns.get(pageNo));
    if (pageLoading.has(pageNo)) return pageLoading.get(pageNo);
    const task = Promise.resolve(injected.loadRuns(pageNo))
      .then((page) => {
        pageLoading.delete(pageNo);
        const indexed = rfIndexPage(page);
        pageRuns.set(pageNo, indexed);
        return indexed;
      })
      .catch(() => {
        pageLoading.delete(pageNo);
        return null;
      });
    pageLoading.set(pageNo, task);
    return task;
  }

  /**
   * 取景窗：`bbox` 只用来定中心（差异字），尺寸由调用方给。
   * 背景位移 clamp 到图片内，四周 6px 渐隐（设计用渐隐代替省略号，避免压字）。
   */
  function renderCrop(bbox, zone) {
    const box = Array.isArray(bbox) && bbox.length === 4 ? bbox : null;
    const options = zone || {};
    const width = Number(options.width) || 340;
    const height = Number(options.height) || 34;
    const imgW = Number(options.imgW) || 0;
    const imgH = Number(options.imgH) || 0;
    const scale = Number(options.scale) > 0 ? Number(options.scale) : 1;

    const host = document.createElement("div");
    host.className = "rf-crop";
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;

    if (!box || !imgW || !imgH || !options.url) {
      host.classList.add("rf-crop--missing");
      host.textContent = "—";
      return host;
    }

    const [x0, y0, x1, y1] = box;
    const imageW = imgW * scale;
    const imageH = imgH * scale;
    const centerX = ((x0 + x1) / 2) * imageW;
    const centerY = ((y0 + y1) / 2) * imageH;
    // 页边：**留白保轴**（设计 §6）。差异字必须停在取景中轴，不许因为裁切被推走：
    // 所以这里不再 clamp 横向位移，让图在页边处"用完"，缺的那截补虚线留白块。
    const wantedLeft = centerX - width / 2;
    const left = wantedLeft;
    const top = rfClamp(centerY - height / 2, 0, Math.max(0, imageH - height));
    const padLeft = Math.max(0, -wantedLeft);
    const padRight = Math.max(0, wantedLeft + width - imageW);

    const inner = document.createElement("div");
    inner.className = "rf-crop__image";
    inner.style.width = `${imageW}px`;
    inner.style.height = `${imageH}px`;
    inner.style.backgroundImage = `url("${options.url}")`;
    inner.style.backgroundSize = `${imageW}px ${imageH}px`;
    inner.style.backgroundPosition = `${-left}px ${-top}px`;
    host.append(inner);
    if (padLeft > 1) host.append(rfPad(padLeft, "left"));
    if (padRight > 1) host.append(rfPad(padRight, "right"));

    // 接排（2026-11-10 用户选 A）：这一行起点左侧 / 终点右侧的空白，
    // 用**上一行的末尾 / 下一行的开头**补满，差异字仍停在中轴。
    // 三片都取自同一张页图，只是裁不同的 y（行距按全书行高中位数）。
    const maskBox = Array.isArray(options.maskBox) && options.maskBox.length === 4 ? options.maskBox : null;
    const wrap = options.wrap || null;
    if (maskBox && wrap) {
      const cx0 = maskBox[0] * imageW - left;
      const cx1 = maskBox[2] * imageW - left;
      const pitch = Number(wrap.pitch) || 0;
      const colX0 = Number(wrap.colX0) || 0;
      const colX1 = Number(wrap.colX1) || 0;
      // 字宽（归一化）：用这一行的文本长度与行框宽估；切片边界要对齐到**字边界**，
      // 否则会在半个字上切断，看起来像坏图。
      const advance = Number(wrap.advance) > 0 ? Number(wrap.advance) : 0;
      const snap = (value, base) => (advance > 0
        ? base + Math.round((value - base) / advance) * advance
        : value);
      // 左：上一行的末尾，右对齐到当前行的起点
      if (cx0 > 6 && pitch > 0) {
        const w = Math.min(cx0, width);
        const sx1 = snap(Math.min(1, Math.max(colX1, maskBox[0])), colX0);
        const sx0 = Math.max(0, sx1 - w / (imageW || 1));
        host.append(rfSlice({
          width: w, left: cx0 - w,
          // 纵向基准要跟主图同一个窗口偏移 top，不是 maskBox 的行顶 ——
          // 用行顶算会差半个行高，切片就露出半截字（真机上看成"重影"）。
          bgX: -(sx0 * imageW), bgY: -(top - pitch * imageH),
          imageW, imageH, url: options.url, cls: "rf-slice--prev",
        }));
      }
      // 右：下一行的开头，左对齐到当前行的终点
      if (cx1 < width - 6 && pitch > 0) {
        const w = Math.min(width - cx1, width);
        const sx0 = snap(Math.max(0, Math.min(colX0, maskBox[0])), colX0);
        host.append(rfSlice({
          width: w, left: cx1,
          bgX: -(sx0 * imageW), bgY: -(top + pitch * imageH),
          imageW, imageH, url: options.url, cls: "rf-slice--next",
        }));
      }
      // 当前行的细底线：让人一眼看出哪一段属于这一行（接排后三行并排）
      host.append(rfLineMark(Math.max(0, cx0), Math.min(width, cx1)));
    } else if (maskBox) {
      const lineLeft = maskBox[0] * imageW - left;
      const lineRight = maskBox[2] * imageW - left;
      if (lineLeft > 1) host.append(rfMask(0, Math.min(lineLeft, width)));
      if (lineRight < width - 1) host.append(rfMask(Math.max(0, lineRight), width));
    }

    // 差异色块（2026-11-10 用户要求）：与右侧文字的红/黄/绿一一对应。
    // 用页图坐标 × 当前缩放，再减去取景位移 —— 与背景图同一套变换，不会错位。
    for (const item of Array.isArray(options.highlights) ? options.highlights : []) {
      const box4 = item && item.bbox;
      if (!Array.isArray(box4) || box4.length !== 4) continue;
      const tone = ["machine", "draft", "done"].includes(item.tone) ? item.tone : "machine";
      const block = document.createElement("span");
      block.className = `rf-crop__hl rf-crop__hl--${tone}`;
      block.style.left = `${box4[0] * imageW - left}px`;
      block.style.top = `${box4[1] * imageH - top}px`;
      // 零宽（插入 / 删标点）：给一个细条，否则色块宽度为 0 看不见
      block.style.width = `${Math.max(3, (box4[2] - box4[0]) * imageW)}px`;
      block.style.height = `${Math.max(4, (box4[3] - box4[1]) * imageH)}px`;
      host.append(block);
    }
    if (options.alt) host.title = options.alt;
    return host;
  }

  /** 页边留白块：虚线 + 淡蓝底 + 竖排「留白 Npx」，一眼能看出"这里没有内容"（设计 §6）。 */
  function rfPad(width, side) {
    const pad = document.createElement("span");
    pad.className = `rf-crop__pad rf-crop__pad--${side}`;
    pad.style.width = `${Math.round(width)}px`;
    pad.dataset.label = `留白 ${Math.round(width)}`;
    return pad;
  }

  /** 接排用的一小片页图（上一行末尾 / 下一行开头） */
  function rfSlice({ width, left, bgX, bgY, imageW, imageH, url, cls }) {
    const slice = document.createElement("span");
    slice.className = `rf-slice ${cls}`;
    slice.style.left = `${left}px`;
    slice.style.width = `${width}px`;
    slice.style.backgroundImage = `url("${url}")`;
    slice.style.backgroundSize = `${imageW}px ${imageH}px`;
    slice.style.backgroundPosition = `${bgX}px ${bgY}px`;
    return slice;
  }

  /** 当前行在接排条里的细底线 */
  function rfLineMark(startPx, endPx) {
    const mark = document.createElement("span");
    mark.className = "rf-line-mark";
    mark.style.left = `${startPx}px`;
    mark.style.width = `${Math.max(0, endPx - startPx)}px`;
    return mark;
  }

  /** 行边界外的遮罩：把隔壁栏 / 页边的字遮成纸色，保证取景里只剩这一行的字。 */
  function rfMask(startPx, endPx) {
    const mask = document.createElement("span");
    mask.className = "rf-crop__mask";
    mask.style.left = `${startPx}px`;
    mask.style.width = `${Math.max(0, endPx - startPx)}px`;
    return mask;
  }

  /** 一行文本，差异标出来（可多段）。已确认且没改字 ⇒ 不染。 */
  function rfTextLine(row, isCurrent) {
    const line = document.createElement("div");
    line.className = "rf-line" + (isCurrent ? " rf-line--current" : "");
    const text = String((row && row.text) || "");
    const runs = row && row.state === "confirmed" && !row.edited ? [] : rfRunsFor(row);
    if (!runs.length) {
      line.textContent = text;
      return line;
    }
    let cursor = 0;
    for (const run of runs) {
      const start = Number(run.a_start);
      const end = Number(run.a_end);
      const from = String(run.from == null ? "" : run.from);
      let at = Number.isFinite(start) ? start : -1;
      if (at < 0 || text.slice(at, at + Math.max(0, end - start)) !== from) {
        const near = from ? text.indexOf(from, Math.max(0, at)) : -1;
        if (near >= 0) at = near;
      }
      if (at < 0 || at < cursor) continue;
      const width = Math.max(0, (Number.isFinite(end) ? end : at + from.length) - at);
      line.append(document.createTextNode(text.slice(cursor, at)));
      const mark = document.createElement("mark");
      const tone = row.state === "confirmed" ? "done" : row.state === "draft" ? "draft" : "machine";
      mark.className = `rcl-diff rcl-diff--${tone}`;
      if (width > 0) mark.textContent = text.slice(at, at + width);
      else mark.classList.add("rcl-diff--caret");
      line.append(mark);
      cursor = at + width;
    }
    line.append(document.createTextNode(text.slice(cursor)));
    return line;
  }

  function rfMissingLine(message) {
    const p = document.createElement("p");
    p.className = "muted rf-empty";
    p.textContent = message;
    return p;
  }

  /**
   * 下方上下文：当前行 **±1 行连续正文**（一行前 / 当前 / 一行后），不是三条相邻差异行。
   * 三行来自同一段：`before` / `text` / `after`（外壳在 reading-view 里从 line_spans 切好）。
   * 页图取当前行 lineBbox 上下各扩一个行高 —— 行高一致时正好三行。
   */
  async function showContext(payload) {
    const host = injected.contextEl || null;
    if (!host) return api;
    const rows = (payload && payload.rows) || [];
    const currentIndex = Number.isInteger(payload && payload.currentIndex) ? payload.currentIndex : -1;
    if (!rows.length || currentIndex < 0) {
      host.innerHTML = "";
      host.append(rfMissingLine("选中一条差异后，这里显示它上下各一行。"));
      return api;
    }
    const token = ++contextToken;
    const row = rows[currentIndex];
    await rfLoad(Number(row.pageNo));
    if (token !== contextToken) return api;   // 期间又点了别的行：这一份已经过期

    host.innerHTML = "";
    const box = document.createElement("div");
    box.className = "rf-context";
    const media = document.createElement("div");
    media.className = "rf-context__media";
    const text = document.createElement("div");
    text.className = "rf-context__text";

    const page = pageRuns.get(Number(row.pageNo));
    const run = rfRunsFor(row)[0] || null;
    const lineBox = row.lineBbox || (run && run.bbox) || null;
    // 窄窗里 640 会撑破容器（min-content 无法再缩），按容器实际宽度收
    const contextW = Math.max(240, Math.min(RF_CONTEXT_W, (host.clientWidth || RF_CONTEXT_W) - 24));
    if (page && page.url && page.imgW && page.imgH && lineBox) {
      const lineH = Math.abs(lineBox[3] - lineBox[1]) || 0.02;
      const y0 = Math.max(0, lineBox[1] - lineH);
      const y1 = Math.min(1, lineBox[3] + lineH);
      const centerBox = (run && run.bbox) || lineBox;
      const cx = (centerBox[0] + centerBox[2]) / 2;
      const scale = rfClamp(RF_FONT_PX / (lineH * page.imgH * RF_GLYPH_RATIO), 0.2, 1.0);
      const imageH = Math.abs(y1 - y0) * page.imgH * scale;
      const tone = row.state === "confirmed" ? "done" : row.state === "draft" ? "draft" : "machine";
      const highlights = rfRunsFor(row)
        .filter((item) => Array.isArray(item.bbox))
        .map((item) => ({ bbox: item.bbox, tone }));
      media.append(
        renderCrop([cx, y0, cx, y1], {
          width: contextW,
          height: Math.max(40, Math.round(imageH)),
          scale,
          imgW: page.imgW,
          imgH: page.imgH,
          url: page.url,
          alt: `第 ${row.pageNo} 页 · 上下文`,
          highlights,
        })
      );
    } else {
      media.classList.add("rf-context__media--missing");
      media.textContent = "这一页还没有可用页图。";
    }

    const neighbour = (textValue, isCurrent) => {
      const line = document.createElement("div");
      line.className = "rf-line" + (isCurrent ? " rf-line--current" : "");
      line.textContent = textValue || "（这一行没有上下文：差异落在段首/段尾）";
      if (!textValue) line.classList.add("rf-line--empty");
      return line;
    };
    text.append(neighbour(row.before, false));
    text.append(rfTextLine(row, true));
    text.append(neighbour(row.after, false));

    box.append(media, text);
    host.append(box);
    return api;
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    return api;
  }

  function enter() {
    return api;
  }

  const api = { init, enter, renderCrop, showContext };

  window.ReviewFocus = api;
})();
