/**
 * 页面图像（片 3b）：缩放档位 + 图档选择 + 宽度测量 —— `window.PageMedia`
 *
 * ## 缩放四档（第 38 号任务）与图档（任务 62 / 72）
 *
 * ```
 * 档位   label    cols   image 档位
 *   0     网格    auto   thumb
 *   1     大网格  3      view
 *   2     单列    1      mid
 *   3     单页    1      zoom2
 * ```
 *
 * 图档顺序 `IMAGE_PROFILE_ORDER = view → mid → zoom → zoom2`；DPI 表 `renderProfiles`
 * 由 `/api/app/info` 在启动时覆盖（`applyRenderProfiles()`）——**前后端只留一份真值**，
 * 前端不再写死一份。`pageImageUrl()` 拼出来的 URL 逐字不变（`size` 只换档名）。
 *
 * ## 状态（归本模块）
 *
 * `PAGE_ZOOM_LEVELS` / `pageZoomIndex` / `pageZoomTouched` / `renderProfiles` / `IMAGE_PROFILE_ORDER`
 * 都在这里；外壳与视图经访问器读写。`zoomLevels` 暴露的是常量数组本身（注入方要 `.length`）。
 * 写盘 0；本模块只拼 URL，发请求的是调用方设置 `img.src` 的那一行。
 */

(function () {
  "use strict";

  let injected = {};

  // 网格 / 大网格 用 thumb 或 view，单列用 mid，单页用 zoom2；大图档才允许开块框。
  const PAGE_ZOOM_LEVELS = [
    { label: "网格", cols: "auto", image: "thumb" },
    { label: "大网格", cols: 3, image: "view" },
    { label: "单列", cols: 1, image: "mid" },
    { label: "单页", cols: 1, image: "zoom2" },
  ];
  let pageZoomIndex = 0;
  // 用户自己改过缩放之后，切步骤不再按"每步默认缩放"动它（任务 36B）。
  let pageZoomTouched = false;

  /** 页图档位 → DPI；启动时用 `/api/app/info` 的值覆盖（前后端只留一份真值）。 */
  let renderProfiles = { thumb: 40, view: 150, mid: 220, zoom: 300, zoom2: 350 };
  const IMAGE_PROFILE_ORDER = ["view", "mid", "zoom", "zoom2"];

  function pageZoomLevel() {
    return PAGE_ZOOM_LEVELS[pageZoomIndex];
  }

  /** 某一档在一页上渲染出来的**像素宽度**（页面宽度 pt → px）。 */
  function profileWidthPx(profile, widthPt) {
    const dpi = Number(renderProfiles[profile] || 150);
    return Math.round(((Number(widthPt) || 612) / 72) * dpi);
  }

  function pageWidthPt(pageNo) {
    const project = injected.getCurrentProject();
    const page = project
      ? (project.pages || []).find((item) => item.page_no === pageNo)
      : null;
    return page ? Number(page.width_pt) || 612 : 612;
  }

  /**
   * 按"这张图实际要显示多少设备像素"选档（任务 72）。
   *
   * **上一版用窗口宽度判断是错的**：真正决定清晰度的是容器 CSS 宽度 × devicePixelRatio。
   * 实测（612pt 页、dpr 2、目录确认）：940px 窗口 + 140% 缩放时容器 830 CSS px、
   * 需要 1660 设备像素，而规则给了 `view`（1275px）→ **比例 0.77，被拉大 1.3 倍**。
   * 现在按比例选：需要 1660 → 取 `mid`（1870px），比例 1.13。
   */
  function detailImageProfile(cssWidth, widthPt) {
    // 刀 C：档位状态搬进 page-index.js；这里每次现读（模块未载入时退回 auto，与搬走前默认值一致）
    const quality = injected.getImageQuality() || "auto";
    if (quality === "standard") return "view";
    if (quality === "high") return "zoom";
    const dpr = injected.getDevicePixelRatio();
    const need = Math.max(0, Number(cssWidth) || 0) * dpr;
    if (!need) return "view";
    for (const profile of IMAGE_PROFILE_ORDER) {
      if (profileWidthPx(profile, widthPt) >= need) return profile;
    }
    // 都不够时给最高档（不再写死 "zoom"：加档后最高档变了，写死会让 350 这一档永远拿不到）
    return IMAGE_PROFILE_ORDER[IMAGE_PROFILE_ORDER.length - 1];
  }

  /** 对一个页块取档：量它的 CSS 宽，配这一页的 pt 宽。 */
  function pageProfileFor(element, pageNo) {
    const cssWidth = measureCssWidth(element);
    return detailImageProfile(cssWidth, pageWidthPt(pageNo));
  }

  /**
   * 量一个元素"将来会显示成多宽"（CSS px）。
   *
   * 优先 `getBoundingClientRect`；隐藏 / 还没布局时退回 `offsetWidth`、父元素宽度，
   * 最后按视口估一个（宁可给高一档，也不要因为量到 0 而拿到最模糊的图）。
   */
  function measureCssWidth(element) {
    if (!element) return 0;
    const rect = element.getBoundingClientRect();
    if (rect.width > 1) return rect.width;
    const offset = element.offsetWidth || 0;
    if (offset > 1) return offset;
    const parent = element.parentElement;
    if (parent) {
      const parentRect = parent.getBoundingClientRect();
      if (parentRect.width > 1) return parentRect.width;
    }
    return Math.max(320, injected.getViewportWidth() * 0.5);
  }

  function pageImageUrl(pageNo, size) {
    return (
      `/api/projects/${injected.getCurrentProject().project_id}/pages/${pageNo}/image?size=${size}` +
      `&token=${encodeURIComponent(injected.getToken())}`
    );
  }

  function setPageZoom(delta) {
    const next = Math.min(
      PAGE_ZOOM_LEVELS.length - 1,
      Math.max(0, pageZoomIndex + delta)
    );
    if (next === pageZoomIndex) return;
    // 用户自己改过缩放之后，切步骤不再按"每步默认缩放"动它（任务 36B）。
    pageZoomTouched = true;
    pageZoomIndex = next;
    injected.applyPageZoom();
  }

  function applyRenderProfiles(profiles) {
    if (!profiles || typeof profiles !== "object") return;
    renderProfiles = { ...renderProfiles, ...profiles };
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    return api;
  }

  const api = {
    init,
    pageZoomLevel,
    pageProfileFor,
    pageImageUrl,
    setPageZoom,
    detailImageProfile,
    pageWidthPt,
    getPageZoomIndex: () => pageZoomIndex,
    setPageZoomIndex: (value) => { pageZoomIndex = value; return value; },
    getPageZoomTouched: () => pageZoomTouched,
    setPageZoomTouched: (value) => { pageZoomTouched = value; return value; },
    applyRenderProfiles,
    zoomLevels: PAGE_ZOOM_LEVELS,
  };
  window.PageMedia = api;
})();
