// 正文审校 v3：下方 5 行上下文 + 三档取景 + 逐处导航 + 判定 + 手改。
//
// **本笔只落 renderCrop 与空骨架**（Chief 2026-11-06 的顺序）：三档取景的数值换算、
// 逐处导航、判定、手改都在下一笔。**取景只此一份**——差异列表通过外壳注入调用这里的
// renderCrop，不许在列表里再长一份（契约 §2）。
//
// 取图约束（契约 §2/§3）：只用一次 `size=zoom` 的原图，靠 CSS 背景尺寸/位移定位到 bbox；
// 不 canvas 重画、不为裁图单独再发一次图请求。
(function () {
  "use strict";

  let injected = {};

  /**
   * 单行裁图：把 `bbox`（归一化 0–1）居中放进 `zone`（CSS px 的框）。
   *
   * @param {[number,number,number,number]} bbox
   * @param {{width:number,height:number,scale?:number,imgW:number,imgH:number,url:string,alt?:string}} zone
   * @returns {HTMLElement}
   */
  function renderCrop(bbox, zone) {
    const box = Array.isArray(bbox) && bbox.length === 4 ? bbox : null;
    const options = zone || {};
    const width = Number(options.width) || 240;
    const height = Number(options.height) || 56;
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

    const inner = document.createElement("div");
    inner.className = "rf-crop__image";
    inner.style.width = `${imageW}px`;
    inner.style.height = `${imageH}px`;
    inner.style.backgroundImage = `url("${options.url}")`;
    inner.style.backgroundSize = `${imageW}px ${imageH}px`;
    inner.style.backgroundPosition = `${-(centerX - width / 2)}px ${-(centerY - height / 2)}px`;
    host.append(inner);
    if (options.alt) host.title = options.alt;
    return host;
  }

  /** 空骨架：上下文 / 面板 / 取景宿主下一笔才接线，这里只收注入、保持幂等。 */
  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    return api;
  }

  /** 空骨架：三档取景 / 逐处导航 / 判定在下一笔。 */
  function enter() {
    return api;
  }

  function contextEl() {
    return injected.contextEl || null;
  }

  /** 一行上下文：左裁图（复用 renderCrop）+ 右正文（差异行标红）。 */
  function focusRow(row, isCurrent) {
    const item = document.createElement("div");
    item.className = "rf-row" + (isCurrent ? " rf-row--current" : "");
    const cropCell = document.createElement("div");
    cropCell.className = "rf-row__crop";
    const run = row && row.runs && row.runs[0];
    const box = (run && run.bbox) || (row && row.lineBbox) || null;
    if (box && typeof renderCrop === "function") {
      cropCell.append(
        renderCrop(box, {
          width: 120,
          height: 32,
          scale: 0.7,
          imgW: Number(row.imgW) || 0,
          imgH: Number(row.imgH) || 0,
          url: row.cropUrl || "",
        })
      );
    } else {
      cropCell.classList.add("rf-row__crop--missing");
      cropCell.textContent = "—";
    }
    const textCell = document.createElement("div");
    textCell.className = "rf-row__text";
    const text = String((row && row.text) || "");
    if (run && run.from) {
      const at = text.indexOf(run.from);
      if (at >= 0) {
        textCell.append(document.createTextNode(text.slice(0, at)));
        const mark = document.createElement("mark");
        mark.className = "rcl-diff";
        mark.textContent = run.from;
        textCell.append(mark, document.createTextNode(text.slice(at + run.from.length)));
      } else {
        textCell.textContent = text;
      }
    } else {
      textCell.textContent = text;
    }
    item.append(cropCell, textCell);
    return item;
  }

  /**
   * 下方 5 行上下文：rows 由外壳给（与列表同一份页级数据，不另发请求）。
   * 只读展示——当前行高亮、差异行标红；三档取景与逐处导航在下笔。
   */
  function showContext(payload) {
    const host = contextEl();
    if (!host) return api;
    const rows = (payload && payload.rows) || [];
    const currentIndex = Number.isInteger(payload && payload.currentIndex)
      ? payload.currentIndex
      : -1;
    host.innerHTML = "";
    if (!rows.length || currentIndex < 0) {
      const empty = document.createElement("p");
      empty.className = "muted rf-empty";
      empty.textContent = "选中一条差异后，这里显示它上下各两行。";
      host.append(empty);
      return api;
    }
    const from = Math.max(0, currentIndex - 2);
    const to = Math.min(rows.length, currentIndex + 3);
    for (let index = from; index < to; index += 1) {
      host.append(focusRow(rows[index], index === currentIndex));
    }
    return api;
  }

  const api = { init, enter, renderCrop, showContext };

  window.ReviewFocus = api;
})();
