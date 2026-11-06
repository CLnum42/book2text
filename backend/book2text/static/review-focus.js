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

  /** 空骨架：下一笔在这里渲染 5 行上下文与三档取景。 */
  function enter() {
    return api;
  }

  const api = { init, enter, renderCrop };

  window.ReviewFocus = api;
})();
