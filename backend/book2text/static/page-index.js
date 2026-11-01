/**
 * 目录确认的页码索引服务（刀 C：6 个函数 / 58 行 + 4 份状态）
 *
 * 书：`docs/refactor/appjs-domains/first-batch.md` §4。这是第一批里**唯一搬状态的一刀**：
 * `pageIndexData` / `pageIndexProject` / `pageIndexLoading` / `imageQualityMode` 四份顶层状态
 * 整个搬进本模块的词法作用域——app.js 里**定义位与引用位都归零**（不是"留个 getter 读它"，
 * 那样会出现两份真相，正是这一刀要防的）。
 *
 * **为什么是服务模块，不是视图模块**：R3 对 `*-view.js` 零豁免（只能引用自己 section 的 id），
 * 而这里的 DOM 只有一个设置面板里的 radio 组。所以命名 `page-index.js`、出口 `window.PageIndexService`，
 * 元素由外壳经 `init` 给一个 root（book §1 ①/②），模块只在它的子树里查。
 *
 * 注入面（不注入值，只给访问器 / 动作）：
 *   apiJson · getCurrentProject · getQualityRadios（外壳在自己的 root 子树里查好的三档 radio）
 *   blocksKey / blocksGet / blocksRemember —— 块缓存只有一份，留在 app.js（pages / preview / 阅读共用）；
 *   本模块只借这三个回调读写它，不复制一份缓存（书 §4 判据②的"别复制一份缓存"）。
 *
 * 接口面只放**有真调用点**的成员（§1 ⑦）：loadIndex / loadBlocks / clearImagePlaceholder /
 * loadImageQuality / syncImageQualityUi / getData / getProject / isLoading / getImageQuality / setImageQuality。
 */
(function () {
  "use strict";

  let injected = {};

  // ---------------------------------------------------------------- 搬进来的四份状态
  //
  // 这四份原来是 app.js 的顶层 let。现在只住在这里：外壳经 getX() 读，写入也走本模块的动作
  // （loadIndex / loadImageQuality / setImageQuality）。别在 app.js 里留镜像值。

  /** 最近一次成功拉到的页码索引（换项目 / 重新拉时清空）。 */
  let pageIndexData = null;
  /** pageIndexData 属于哪个项目（防止拿旧项目的索引画新项目）。 */
  let pageIndexProject = null;
  /** 正在拉：并发第二次直接返回 busy。 */
  let pageIndexLoading = false;
  /** 页图清晰度档：auto = 按实际像素选档；standard / high = 用户手动钉住。 */
  let imageQualityMode = "auto";

  const QUALITY_MODES = ["auto", "standard", "high"];
  const QUALITY_STORAGE_KEY = "b2t.imageQuality";

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    return api;
  }

  // ---------------------------------------------------------------- 页码索引

  /**
   * 拉一页（项目）的页码索引。返回值语义与搬走前逐字一致：
   * `{status:"ok"}` / `{status:"busy"}`（已有一份在拉）/ `{status:"error", message}`。
   */
  async function loadIndex() {
    const project = typeof injected.getCurrentProject === "function" ? injected.getCurrentProject() : null;
    if (!project || pageIndexLoading) return { status: "busy" };
    pageIndexLoading = true;
    pageIndexData = null;
    pageIndexProject = null;
    try {
      const data = await injected.apiJson(`/api/projects/${project.project_id}/page-index`);
      pageIndexData = data;
      pageIndexProject = project.project_id;
      return { status: "ok" };
    } catch (error) {
      return { status: "error", message: (error && error.message) || "未知错误" };
    } finally {
      pageIndexLoading = false;
    }
  }

  /**
   * 取一页的块：先读共用块缓存（键与写回都走外壳给的回调），未命中才请求。
   * 失败返回 `[]`（与搬走前一致：读不到块不算错，视图按空列表画）。
   */
  async function loadBlocks(pageNo) {
    const key = typeof injected.blocksKey === "function" ? injected.blocksKey(pageNo) : null;
    const cached = key && typeof injected.blocksGet === "function" ? injected.blocksGet(key) : undefined;
    if (cached !== undefined && cached !== null) return cached;
    const project = typeof injected.getCurrentProject === "function" ? injected.getCurrentProject() : null;
    const projectId = project ? project.project_id : "";
    try {
      const data = await injected.apiJson(`/api/projects/${projectId}/pages/${pageNo}/blocks`);
      const blocks = data.blocks || [];
      if (key && typeof injected.blocksRemember === "function") injected.blocksRemember(key, blocks);
      return blocks;
    } catch {
      return [];
    }
  }

  /**
   * 摘掉占位状态。**`is-placeholder` 这个类必须一起摘**——它带着 `filter: blur(1.5px)`，
   * 只删 `dataset.placeholder` 会把模糊永久留在最后的清晰图上。
   */
  function clearImagePlaceholder(image) {
    if (!image) return;
    delete image.dataset.placeholder;
    image.classList.remove("is-placeholder");
  }

  // ---------------------------------------------------------------- 清晰度档

  function loadImageQuality() {
    let saved = null;
    try {
      saved = typeof localStorage === "undefined" ? null : localStorage.getItem(QUALITY_STORAGE_KEY);
    } catch {
      saved = null;
    }
    imageQualityMode = QUALITY_MODES.includes(saved) ? saved : "auto";
    return imageQualityMode;
  }

  function setImageQuality(mode) {
    if (!QUALITY_MODES.includes(mode)) return;
    imageQualityMode = mode;
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(QUALITY_STORAGE_KEY, mode);
    } catch {
      // 隐私模式 / 配额满：档位在本次会话仍生效，写盘失败不影响界面
    }
    syncImageQualityUi();
  }

  /**
   * 同步设置面板里的三档 radio。
   *
   * radio 列表由外壳给（`getQualityRadios()`，外壳在自己的 root 子树里查一次）：
   * 本模块因此**连 querySelector 都是 0 次**——域模块闸不需要为它开口子。
   */
  function syncImageQualityUi() {
    const radios = typeof injected.getQualityRadios === "function" ? injected.getQualityRadios() : null;
    if (!radios) return;
    for (const radio of radios) {
      radio.checked = radio.value === imageQualityMode;
    }
  }

  // ---------------------------------------------------------------- 给外壳读的状态

  function getData() {
    return pageIndexData;
  }

  function getProject() {
    return pageIndexProject;
  }

  function isLoading() {
    return pageIndexLoading;
  }

  function getImageQuality() {
    return imageQualityMode;
  }

  const api = {
    init,
    loadIndex,
    loadBlocks,
    clearImagePlaceholder,
    loadImageQuality,
    syncImageQualityUi,
    getData,
    getProject,
    isLoading,
    getImageQuality,
    setImageQuality,
  };
  window.PageIndexService = api;
})();
