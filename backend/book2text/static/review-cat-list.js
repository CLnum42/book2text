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

  const RCL_CROP_H = 34;         // 取景带高度
  // 两带共用的字宽。取景（扫描图）与正文（文字）**必须同字宽**：同一条字符窗口按同一格距摆放，
  // 差异字才会落在同一根竖线上；字号不同则右侧越走越偏（用户 2026-11-10 报的"上方和下方对不上"）。
  const RCL_TEXT_PX = 15.5;
  // 手改窗口：差异段前后各 8 字（用户 2026-11-10 定：小于整行、大于差异处）
  const RCL_EDIT_PAD = 8;
  // 正在手改的那一行（key）。放模块变量、不放 DOM：异步重绘不会把它冲掉
  let editingKey = null;
  let editingOriginal = "";
  let editingEl = null;
  /** 正文字宽：窄窗（≤900）CSS 把正文字号降到 14.5，取景必须跟着降——
   *  两带字宽不一致时，从中轴往两侧越走越偏（628 实测框左沿偏 39.5px）。 */
  function rclTextPx() {
    return typeof window !== "undefined" && window.innerWidth <= 900 ? 14.5 : RCL_TEXT_PX;
  }
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
  // 会话内记住"这一行判之前差异在哪"：采用候选后 current 已等于 candidate，接口不再给 runs，
  // 但用户要看到"这里改过"的绿块 —— 用完即弃，刷新页面就没了（库里只剩 diff_ack）。
  const adoptedSpans = new Map();
  // 采用候选后这一行就不再"差异"了（current == 候选），队列里会消失 —— 用户要看到它变绿，
  // 所以本次会话内把它留在列表里（刷新后仍会消失，那时它已经判完出队）。
  const adoptedRows = new Map();
  // 全书行高中位数（取景倍率按它算 ⇒ 整个列表字号一致；按页算会让不同页字号不同）
  let bookLineHeight = null;

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
   * 这一条差异的区间：用 **marks 的 current→candidate** 现算（首尾公共前后缀），
   * 再映射回整行 text 的坐标。
   *
   * 为什么要映射：`current` 是整行的**窗口文本**（±20 字），`text` 是整行。
   * 一行可能有多处差异（队列里是多条，每条一个 current/candidate），
   * 用户 2026-11-10 要求"只标中轴那一处"——所以每条只算自己那一处，
   * 不能像以前那样把整行所有 run 都画上（行 7 就同时红了两处）。
   *
   * **不依赖任何请求**：接口缺 runs 时也能标（2026-11-10 红标整片缺失就是靠这个兜底）。
   */
  function rclFallbackRun(row) {
    const whole = String((row && row.text) || "");
    const windowText = String((row && row.current) || "");
    const candidate = String((row && row.candidate) || "");
    if (!whole || !candidate) return null;
    const source = windowText && whole.includes(windowText) ? windowText : whole;
    if (source === candidate) return null;
    let start = 0;
    const limit = Math.min(source.length, candidate.length);
    while (start < limit && source[start] === candidate[start]) start += 1;
    // 公共后缀（首尾法）：先把"从尾部也能对上"的那一截排除
    let tail = 0;
    while (
      tail < limit - start
      && source[source.length - 1 - tail] === candidate[candidate.length - 1 - tail]
    ) tail += 1;
    let end = Math.max(start + 1, source.length - tail);
    // **等长替换只取第一段连续差异**（中轴那一处）：用户 2026-11-10 要求"一行里只标
    // 中轴的 working content"。一条 item 的 current/candidate 可能同时含两处（行 7 的
    // 竖→坚 + 桶→槅），首尾法会覆盖中间 16 字，红框横跨半行。
    if (source.length === candidate.length) {
      let first = start + 1;
      while (first < source.length && source[first] !== candidate[first]) first += 1;
      end = first;
    }
    const useEnd = Math.max(start + 1, end);
    // 窗口文本在整行里的偏移（找不到就退回整行坐标）
    const offset = source !== whole ? Math.max(0, whole.indexOf(source)) : 0;
    return {
      a_start: start + offset,
      a_end: useEnd + offset,
      from: source.slice(start, useEnd),
      to: candidate.slice(start, Math.max(start, useEnd)),
      bbox: null,
      fallback: true,
    };
  }

  /** 这一条差异的 run：区间接本章的 current/candidate；bbox 从页级 runs 里按 from 配对（贴字用）。 */
  function rclOwnRun(row) {
    const own = rclFallbackRun(row);
    const runs = rclRunsFor(row);
    if (!own) {
      // 已确认 / 没有候选：退回页级 runs 的第一段（这一行仍要显示一处色块）
      return runs.length ? runs[0] : null;
    }
    const hit = runs.find((item) => String(item.from) === own.from && Array.isArray(item.bbox))
      || runs.find((item) => Array.isArray(item.bbox));
    return { ...own, bbox: hit && hit.bbox ? hit.bbox : null };
  }

  /** 这一行用来标红 / 定位的 runs（只含**这一条**差异）。 */
  function rclEffectiveRuns(row) {
    const own = rclOwnRun(row);
    if (own) return [own];
    return [];
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

  // ---------------------------------------------------------------- 两带共用的字符窗口
  /**
   * 两带的宽度 = 这一列的实际宽度（取景带不再固定 340，和正文带一样宽）。
   * 实测口径：宽屏（>900）栅格 32 序号 + 72 状态 + 246 判定 + 3×6 间距 + 2×12 内边距；
   * 窄屏（≤900）栅格 28 + 72 + 2 列，两带跨 2–3 列。
   */
  let measuredBandWidth = 0;
  /** 按列表宽度算列宽（**不含缓存**）。首次渲染时列表还没有滚动条，算出来会偏大 15px，
   *  所以 rclRender 的首帧之后会再算一次并重画（见 rclRender 末尾）。 */
  function rclBandWidthRaw() {
    const width = listEl && listEl.clientWidth ? listEl.clientWidth : 0;
    if (!width) return 0;
    if (typeof window !== "undefined" && window.innerWidth <= 900) {
      // 窄屏栅格 28 / 72 / 两带跨 2–3 列：实测两带列宽 = 列表宽 − 50
      return Math.max(240, width - 50);
    }
    return Math.max(240, width - 32 - 72 - 246 - 18 - 24);
  }

  function rclBandWidth() {
    if (measuredBandWidth > 100) return measuredBandWidth;
    return rclBandWidthRaw() || 340;
  }

  /** 窗口字数：列宽 ÷ 字宽（两带共用这一个数）。
   *  减一个字的位置：正文左右两段各占 1fr，中间差异字占 auto，窗口满格时左段会被
   *  `text-overflow: ellipsis` 截掉最后半个字（真机：行 5 显示成「掉在地下…骨」）。 */
  function rclWindowChars(bandWidth) {
    const px = rclTextPx();
    return Math.max(8, Math.floor(((Number(bandWidth) || 340) - 2 * px) / px));
  }

  /**
   * 以**差异段中点**为中轴、长度 `chars` 的字符窗口（两带都按它渲染）。
   * 超出行首/行尾的部分用 `before` 末尾 / `after` 开头补（正文与取景用同一份字数，
   * 所以上方扫描图与下方文字永远是同一段内容）。
   * 返回的 start 可能为负（窗口左沿落在上一行），`padLeft/padRight` 是补不上的留白字数。
   */
  function rclWindow(row, chars) {
    const total = Math.max(8, Number(chars) || 40);
    const text = String((row && row.text) || "");
    const before = String((row && row.before) || "");
    const after = String((row && row.after) || "");
    const spans = rclEffectiveRuns(row)
      .map((run) => rclSpanOf(run, text))
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
    const first = spans[0] || null;
    const anchorStart = first ? first.start : Math.max(0, Math.floor(text.length / 2));
    const anchorEnd = first ? Math.max(first.end, first.start) : anchorStart;
    const center = (anchorStart + anchorEnd) / 2;
    const start = Math.round(center - total / 2);
    const end = start + total;
    const wantLeft = Math.max(0, -start);
    const wantRight = Math.max(0, end - text.length);
    const leftCount = Math.min(wantLeft, before.length);
    const rightCount = Math.min(wantRight, after.length);
    return {
      chars: total,
      spans,
      first,
      start,
      end,
      anchorStart,
      anchorEnd,
      leftCount,
      rightCount,
      leftText: before.slice(before.length - leftCount),
      rightText: after.slice(0, rightCount),
      curStart: Math.max(0, start),
      curEnd: Math.min(text.length, end),
      padLeft: wantLeft - leftCount,
      padRight: wantRight - rightCount,
    };
  }

  /**
   * 缩放：让**字高 ≈ 22px**。行框高（页图像素）= lineBbox 高 × imgH；
   * run.bbox 可能是零宽/矮框（插入、删标点），所以取两者较大值兜底，避免放大成巨字。
   */
  /**
   * 取景倍率：**按页用同一个行高**（该页所有行框高的中位数）。
   * 单行自己的行框高有 ±15% 抖动（双栏 / 标点行 / OCR 框松紧），拿它算 →
   * 同一页里每行字号都不同，就是用户说的"有的字大有的字小"。
   */
  function rclBookLineH(imgH) {
    if (bookLineHeight !== null) return bookLineHeight;
    const heights = rows
      .filter((item) => Array.isArray(item.lineBbox))
      .map((item) => Math.abs(item.lineBbox[3] - item.lineBbox[1]) * imgH)
      .filter((value) => value > 1)
      .sort((a, b) => a - b);
    bookLineHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
    return bookLineHeight;
  }

  /** 接排参数：行距 + 这一页正文列的左右沿（多行取 min/max，足够近似）。 */
  function rclWrapInfo(row, page) {
    const imgH = page.imgH || 0;
    const imgW = page.imgW || 0;
    if (!imgH || !imgW) return null;
    const samePage = rows.filter((item) => Number(item.pageNo) === Number(row.pageNo));
    // 左右沿用**中位数**而不是 min/max：min 会被页码 / 书眉行（x0≈0.018）拉走，
    // 取景的"上一行末尾 / 下一行开头"就裁到页边空白里去了。
    const median = (values) => {
      const list = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
      return list.length ? list[Math.floor(list.length / 2)] : null;
    };
    const xs0 = samePage.map((item) => (Array.isArray(item.lineBbox) ? item.lineBbox[0] : null));
    const xs1 = samePage.map((item) => (Array.isArray(item.lineBbox) ? item.lineBbox[2] : null));
    const lineH = rclBookLineH(imgH);
    if (!xs0.length || !xs1.length || !lineH) return null;
    // 行距：用**这一页各行的 y0 差**的中位数（行框高只是字盒高，不等于行距；
    // 用字盒高当行距会让切片落在两行之间，露出半截别的行 —— 真机就是这么糊的）
    const ys = samePage
      .map((item) => (Array.isArray(item.lineBbox) ? item.lineBbox[1] : null))
      .filter((v) => v !== null)
      .sort((a, b) => a - b);
    const deltas = [];
    for (let i = 1; i < ys.length; i += 1) {
      const d = ys[i] - ys[i - 1];
      if (d > 0.002) deltas.push(d);
    }
    deltas.sort((a, b) => a - b);
    const pitch = deltas.length ? deltas[Math.floor(deltas.length / 2)] : lineH / imgH;
    // 平均字宽（归一化）：这一行行框宽 ÷ 这一行字符数
    const textLen = String(row.text || "").length;
    const advance = textLen > 1 && Array.isArray(row.lineBbox)
      ? Math.abs(row.lineBbox[2] - row.lineBbox[0]) / textLen
      : 0;
    return {
      pitch,
      colX0: median(xs0),
      colX1: median(xs1),
      advance,
      // 页面上真正的上一行 / 下一行（后端按同页同栏 y 相邻给的 bbox）：取景切片用它定 y/x
      prevBbox: Array.isArray(row.prevBbox) ? row.prevBbox : null,
      nextBbox: Array.isArray(row.nextBbox) ? row.nextBbox : null,
      // 全书行高中位数（像素）：取景纵向缩放按它算 ⇒ 同一本书每一行的字号一致
      lineH,
    };
  }

  function rclCropCell(row) {
    const cell = document.createElement("div");
    cell.className = "rcl-cell rcl-cell--crop";
    // **这一条**差异（不是整行所有差异）：定位、色块都只围绕它，与正文中轴那一处一一对应
    const own = rclOwnRun(row);
    let box = (own && own.bbox) || (row && row.lineBbox) || null;
    // 没有页级 runs（接口缺这一行）时：用本条差异区间在行框里按字序插值，
    // 估计差异字的大致横坐标 —— 否则取景只会停在整行中点，看着不像"对准差异字"。
    if (own && !own.bbox && box) {
      const length = String(row.text || "").length;
      if (length > 0) {
        const ratio = (own.a_start + own.a_end) / 2 / length;
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
    // 色块用 **run.bbox（字形实际框）**：用户 2026-11-10 报"高亮框跟字没重合"，
    // 均匀字格的估算在标点/缩进行上会偏 1–2 个字。字形框就从 word_boxes 来，贴字。
    // 色块用**本条差异的字形框**（own.bbox）：取景窗口已锚定到这个框的中心，
    // 所以框也在取景中轴，与正文红标（同样居中）左沿只差「字形框宽 − 字格宽」的一半（≤1px）。
    // 若改用字符格，行内标点造成的累积偏差会让框偏 5–12px（真机实测）。
    const highlights = own
      ? [{ start: own.a_start, end: own.a_end, bbox: Array.isArray(own.bbox) ? own.bbox : null, tone }]
      : [];
    // 两带同一个字符窗口：正文怎么截、取景就怎么截；正文补了 before/after 的字数，
    // 取景的上一行末尾 / 下一行开头切片也用同样的字数（这才是"上方和下方一样"）。
    const bandWidth = rclBandWidth();
    const win = rclWindow(row, rclWindowChars(bandWidth));
    const wrap = rclWrapInfo(row, page);
    cell.append(
      injected.renderCrop(box, {
        width: bandWidth,
        height: RCL_CROP_H,
        fontPx: rclTextPx(),
        imgW: page.imgW,
        imgH: page.imgH,
        url: page.url,
        alt: `第 ${row.pageNo || "?"} 页`,
        highlights,
        // 只显示这一行自己的字（双栏页上窗口会框到隔壁栏）
        maskBox: row.lineBbox || null,
        // 接排参数：行距（这一页 y0 差的中位）+ 本文数窗口（left/rightCount 决定切片宽度）
        wrap: wrap
          ? {
            pitch: wrap.pitch,
            advance: wrap.advance,
            colX0: wrap.colX0,
            colX1: wrap.colX1,
            prevBbox: wrap.prevBbox,
            nextBbox: wrap.nextBbox,
            lineH: wrap.lineH,
            chars: win.chars,
            start: win.start,
            curStart: win.curStart,
            curEnd: win.curEnd,
            leftCount: win.leftCount,
            rightCount: win.rightCount,
          }
          : null,
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

  // ---------------------------------------------------------------- 手改一行（2026-11-10）
  //
  // 用户口径：两个 OCR 都错时人工输入；窗口 = 差异段前后各 8 字；只写回改过的内容；
  // 改完按"这一行 vs 第二路"重算，没改的差异仍然是未审（不被连带确认）。
  /** 手改窗口：差异段前后各 RCL_EDIT_PAD 字（行首/行尾自然截断）。 */
  function rclEditWindow(row) {
    const text = String((row && row.text) || "");
    const runs = rclEffectiveRuns(row);
    const first = runs[0] || null;
    if (!first) return null;
    const start = Math.max(0, first.a_start - RCL_EDIT_PAD);
    const end = Math.min(text.length, first.a_end + RCL_EDIT_PAD);
    return {
      start,
      end,
      text: text.slice(start, end),
      before: text.slice(0, start),
      after: text.slice(end),
      anchorAt: Math.max(0, first.a_start - start),
    };
  }

  /** 两段文本的第一段差异（首尾公共前后缀），给编辑态画黄块用。 */
  function rclFirstDiff(original, current) {
    const a = String(original || "");
    const b = String(current || "");
    let start = 0;
    const limit = Math.min(a.length, b.length);
    while (start < limit && a[start] === b[start]) start += 1;
    let tail = 0;
    while (tail < limit - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
    const diffEnd = Math.max(start, a.length - tail);
    const newEnd = Math.max(start, b.length - tail);
    return { start, oldEnd: diffEnd, end: newEnd };
  }

  /** 光标在编辑框里的**文本偏移**（跨文本节点累加）。 */
  function rclCaretOffset(el) {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return null;
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }

  function rclSetCaret(el, offset) {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel) return;
    let remaining = Math.max(0, offset);
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walk.nextNode();
    while (node) {
      if (remaining <= node.textContent.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= node.textContent.length;
      node = walk.nextNode();
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** 编辑态实时高亮：把"相对原窗口文本新增/改过的这一段"画成黄色块（与列表其它待提交同色）。 */
  function rclPaintEdit(el) {
    if (!el || !el.isConnected) return;
    const text = el.textContent;
    const caret = rclCaretOffset(el);
    const span = rclFirstDiff(editingOriginal, text);
    el.textContent = "";
    if (span.start > 0) el.append(document.createTextNode(text.slice(0, span.start)));
    if (span.end > span.start) {
      const mark = document.createElement("mark");
      mark.className = "rcl-diff rcl-diff--draft";
      mark.textContent = text.slice(span.start, span.end);
      el.append(mark);
    }
    if (span.end < text.length) el.append(document.createTextNode(text.slice(span.end)));
    if (caret !== null) rclSetCaret(el, caret);
  }

  function rclCommitEdit(row, advance) {
    const el = editingEl && editingEl.isConnected ? editingEl : null;
    if (!el) return;
    const win = rclEditWindow(row);
    const typed = el.textContent;
    const full = win ? win.before + typed + win.after : typed;
    editingKey = null;
    editingOriginal = "";
    editingEl = null;
    if (typeof injected.onEdit !== "function") return;
    const fromKey = rclKey(row);
    Promise.resolve(injected.onEdit(row, full, { advance: Boolean(advance) }))
      .then(() => {
        if (advance) rclAdvanceFrom(fromKey);
      })
      .catch(() => {
      // 失败：回到编辑态，别把用户打的字吞掉
      editingKey = rclKey(row);
      editingOriginal = win ? win.text : typed;
      rclRepaintRow(row);
    });
  }

  function rclCancelEdit(row) {
    editingKey = null;
    editingOriginal = "";
    rclRepaintRow(row);
  }

  function rclStartEdit(row) {
    const win = rclEditWindow(row);
    if (!win) return;
    editingKey = rclKey(row);
    editingOriginal = win.text;
    rclRepaintRow(row);
  }

  /** 提交后跳到**另一行**（不能停在刚改的这行——它可能还有没改的差异，仍在队列里）。 */
  function rclAdvanceFrom(fromKey) {
    const index = rows.findIndex((item) => rclKey(item) === fromKey);
    if (index >= 0) {
      for (let i = index + 1; i < rows.length; i += 1) {
        if (rows[i].state === "confirmed") continue;
        currentKey = rclKey(rows[i]);
        rclHighlight();
        const node = nodes.get(currentKey);
        if (node && typeof node.scrollIntoView === "function") {
          node.scrollIntoView({ block: "nearest" });
        }
        if (typeof injected.onSelect === "function") injected.onSelect(rows[i]);
        return;
      }
    }
    // 本列表里没有下一处了：交给外壳按服务端"下一处未审"找（可能跨页）
    if (typeof injected.onAdvance === "function") injected.onAdvance();
  }

  function rclEditCell(row) {
    const cell = document.createElement("div");
    cell.className = "rcl-cell rcl-cell--text rcl-cell--editing";
    const win = rclEditWindow(row);
    if (!win) return cell;
    const box = document.createElement("div");
    box.className = "rcl-edit";
    box.contentEditable = "true";
    box.spellcheck = false;
    box.textContent = win.text;
    const hint = document.createElement("span");
    hint.className = "rcl-edit__hint";
    hint.textContent = "Enter 提交并下一处 · Tab 只提交 · Esc 取消";
    box.addEventListener("input", () => rclPaintEdit(box));
    box.addEventListener("compositionend", () => rclPaintEdit(box));
    editingEl = box;
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        rclCancelEdit(row);
        return;
      }
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        rclCommitEdit(row, true);
        return;
      }
      if (event.key === "Tab" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        rclCommitEdit(row, false);
      }
    });
    cell.append(box, hint);
    requestAnimationFrame(() => {
      if (!box.isConnected) return;
      box.focus();
      rclSetCaret(box, win.anchorAt);
    });
    return cell;
  }

  /** 只重画这一行（保留其余节点与滚动位置）。 */
  function rclRepaintRow(row) {
    const key = rclKey(row);
    const node = nodes.get(key);
    if (!node) {
      rclRender();
      return;
    }
    const next = rclRowElement(row, Number(node.dataset.position) || 1);
    node.replaceWith(next);
    nodes.set(key, next);
    if (observer) observer.observe(next);
  }

  function rclTextCell(row) {
    if (editingKey === rclKey(row)) return rclEditCell(row);
    const cell = document.createElement("div");
    cell.className = "rcl-cell rcl-cell--text";
    const text = String((row && row.text) || "");
    const runs = rclEffectiveRuns(row);
    const remembered = adoptedSpans.get(rclKey(row));
    // 2026-11-10 用户口径：**两边始终都有高亮**，颜色只跟状态走（未审红 / 待提交黄 / 已确认绿）。
    // 「已确认·保留原文」也照样标——判过并不等于没差异，只是裁决成了"保留当前"。
    if (!runs.length) {
      if (remembered && remembered.text) {
        // 采用候选后文本已与候选一致：把"改成了什么"按绿色块画回来（本次会话内有效）
        const before = text.slice(0, remembered.start);
        const after = text.slice(remembered.start + remembered.text.length);
        const left = document.createElement("span");
        left.className = "rcl-text__side rcl-text__side--l";
        left.textContent = before;
        const middle = document.createElement("span");
        middle.className = "rcl-text__mid";
        const mark = document.createElement("mark");
        mark.className = "rcl-diff rcl-diff--done";
        mark.textContent = remembered.text;
        middle.append(mark);
        const right = document.createElement("span");
        right.className = "rcl-text__side rcl-text__side--r";
        right.textContent = after;
        cell.append(left, middle, right);
        return cell;
      }
      cell.textContent = text;
      return cell;
    }
    const spans = runs.map((run) => rclSpanOf(run, text)).filter(Boolean).sort((a, b) => a.start - b.start);
    if (!spans.length) {
      cell.textContent = text;
      return cell;
    }
    const first = spans[0];
    // **纯插入**（from 为空、a_start == a_end）时不能 +1：那会把插入位置上的那个字
    // 从右侧切掉，正文里就少一个字（真机：山羊血「崻峒」丸来 → 显示成「山羊血 丸来」）。
    const anchorEnd = first.end > first.start ? first.end : first.start;
    // 窗口与取景同源：同一段字符、同样的左右补字数（用户 2026-11-10：上方图应与下方文字一致）
    const win = rclWindow(row, rclWindowChars(rclBandWidth()));
    const from = win.curStart;
    const to = win.curEnd;

    const left = document.createElement("span");
    left.className = "rcl-text__side rcl-text__side--l";
    if (win.leftText) left.append(rclCtxNode(win.leftText, "prev"));
    if (from > 0) left.append(document.createTextNode("……"));
    left.append(document.createTextNode(text.slice(from, first.start)));

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
    if (win.rightText) right.append(rclCtxNode(win.rightText, "next"));

    cell.append(left, middle, right);
    return cell;
  }

  /** 接排上下文（上一行末尾 / 下一行开头）：淡色 + 虚线边，与取景里的淡化切片同义。 */
  function rclCtxNode(value, side) {
    const ctx = document.createElement("span");
    ctx.className = `rcl-text__ctx rcl-text__ctx--${side}`;
    ctx.textContent = String(value || "");
    return ctx;
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
    // 手改进行中：只剩「提交 / 取消」两个键（Enter/Tab/Esc 也做同样的事）
    if (editingKey === rclKey(row)) {
      const commit = document.createElement("button");
      commit.type = "button";
      commit.className = "rcl-ver rcl-ver--adopt";
      commit.textContent = "提交";
      commit.title = "写回这一行（Enter）；Tab 只提交不跳";
      commit.addEventListener("click", (event) => {
        event.stopPropagation();
        rclCommitEdit(row, true);
      });
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "rcl-ver";
      cancel.textContent = "取消";
      cancel.title = "放弃这次手改（Esc）";
      cancel.addEventListener("click", (event) => {
        event.stopPropagation();
        rclCancelEdit(row);
      });
      cell.append(commit, cancel);
      return cell;
    }
    if (row.state === "confirmed") {
      // 状态列已经写了「已确认 / 改过·未改动」，这里不再重复一遍同样的字；
      // 只有"采用候选"这种状态列表达不了的信息才留一行小字。
      if (row.edited) {
        const done = document.createElement("span");
        done.className = "rcl-done-note";
        done.textContent = "采用候选";
        cell.append(done);
      }
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
      let remembered = null;
      if (value === "adopted" && run) {
        // 采纳后 current 就会等于 candidate，接口不再给 runs：把"改成了什么"记在会话里，
        // 之后按绿色块画出来（位置取候选里那一段的位置）。
        const candidate = String(row.candidate || "");
        const to = String(run.to == null ? "" : run.to);
        const at = to ? candidate.indexOf(to) : -1;
        if (at >= 0) remembered = { start: at, text: to };
      }
      keep.disabled = true;
      adopt.disabled = true;
      Promise.resolve(injected.onAck(row, value))
        .then(() => {
          row.state = "confirmed";
          row.edited = value === "adopted";
          if (remembered) {
            adoptedSpans.set(rclKey(row), remembered);
            row.text = String(row.candidate || row.text || "");
            adoptedRows.set(rclKey(row), row);
          }
          // onAck 内部会 reload（新队列里已经没有这一行）⇒ 这里把它补回当前列表并重画，
          // 否则"采纳后变绿"根本看不见。
          const key = rclKey(row);
          if (!rows.some((item) => rclKey(item) === key)) {
            const at = Math.min(Number.isInteger(row.__rclIndex) ? row.__rclIndex : rows.length, rows.length);
            rows.splice(at, 0, row);
          }
          rclRender();
        })
        .catch(() => {
          keep.disabled = false;
          adopt.disabled = false;
        });
    };
    keep.addEventListener("click", (event) => { event.stopPropagation(); ack("kept"); });
    adopt.addEventListener("click", (event) => { event.stopPropagation(); ack("adopted"); });
    // 手改入口：两个 OCR 都错时用。双击正文 / E 键同效（见 rclRowElement 与键盘绑定）
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "rcl-ver rcl-ver--edit";
    edit.textContent = "✎";
    edit.title = "手动编辑这一行（也可以双击正文 / 按 E）";
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      rclStartEdit(row);
    });
    cell.append(keep, adopt, edit);
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

    // 上下排（2026-11-10 定稿）：取景带在上、正文带在下，两带共用同一列、差异字落在同一条竖线。
    // 栅格 = 序号 32 | 两带列 flex | 状态 72 | 判定 246；行高 71（34 取景 + 4 缝 + 25 正文 + 8 留白）。
    const bands = document.createElement("div");
    bands.className = "rcl-bands";
    // 带是**整列宽**的容器，取景块在带内居中（带自己不缩成 340，否则取景贴左、两带不同轴）
    const shotBand = document.createElement("div");
    shotBand.className = "rcl-band rcl-band--shot";
    shotBand.append(rclCropCell(row));
    const textBand = document.createElement("div");
    textBand.className = "rcl-band rcl-band--text";
    textBand.append(rclTextCell(row));
    bands.append(shotBand, textBand);
    item.append(index, bands, state, rclVersionsCell(row));
    item.addEventListener("click", () => {
      currentKey = item.dataset.key;
      rclHighlight();
      if (typeof injected.onSelect === "function") injected.onSelect(row);
    });
    // 双击正文 = 手改这一行（最快入口）；编辑中双击不重新进入
    item.addEventListener("dblclick", (event) => {
      if (editingKey) return;
      if (event.target && event.target.closest && event.target.closest(".rcl-edit")) return;
      event.preventDefault();
      if (row.state === "confirmed") return;
      currentKey = item.dataset.key;
      rclStartEdit(row);
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
      if (row.__rclIndex === undefined) row.__rclIndex = index;
      const node = rclRowElement(row, index + 1);
      listEl.append(node);
      if (index < eager) rclEnsureRuns(row);
      else if (observer) observer.observe(node);
    });
    rclHighlight();
    rclRenderCounter();
    // 首帧之后列宽才是最终值（滚动条出现会让它变窄 15px）。量到新值就把取景按新宽度重画一遍：
    // 否则取景按公式算的宽居中、正文按实际列宽居中，高亮框会差半条滚动条。
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        const width = rclBandWidthRaw();
        if (width > 100 && width !== measuredBandWidth) {
          measuredBandWidth = width;
          for (const [key, node] of [...nodes.entries()]) {
            const row = rows.find((item) => rclKey(item) === key);
            if (!row) continue;
            const next = rclRowElement(row, Number(node.dataset.position) || 1);
            node.replaceWith(next);
            nodes.set(key, next);
            if (observer) observer.observe(next);
          }
        }
      });
    }
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
    bookLineHeight = null;   // 队列换了：重新取全书行高中位数
    const incoming = Array.isArray(data.rows) ? data.rows : [];
    const present = new Set(incoming.map((row) => rclKey(row)));
    rows = incoming.slice();
    // 本次会话里采纳过的行（已出队）补回原位，保证"确认了就能看到绿色"
    for (const [key, row] of adoptedRows) {
      if (present.has(key)) continue;
      const at = Number.isInteger(row.__rclIndex) ? row.__rclIndex : rows.length;
      rows.splice(Math.min(at, rows.length), 0, row);
    }
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
    if (typeof document !== "undefined" && !init.keyBound) {
      init.keyBound = true;
      document.addEventListener("keydown", (event) => {
        if (event.key !== "e" && event.key !== "E") return;
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
        if (editingKey) return;
        const target = event.target;
        if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
        const row = rclCurrentRow();
        if (!row || row.state === "confirmed") return;
        event.preventDefault();
        rclStartEdit(row);
      });
    }
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
