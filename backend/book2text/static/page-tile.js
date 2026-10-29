/**
 * PageTile —— 页瓷砖服务模块（契约：`docs/refactor/reading-view-boundary.md` §21）。
 *
 * **为什么它是模块**（§21.1 三条判据，缺一条就不该做）：
 *   唯一资源   —— 一个 `pageNo` 的图 URL / 尺寸档全局只有一份；
 *   唯一生命周期 —— 一个 `pageNo` 的 IntersectionObserver 只有一个，释放也只有一处；
 *   唯一失效语义 —— `invalidate(pageNo)` 一次作废，所有持有者同时看到新版本。
 * 今天 index / preview / reading 各注入一份渲染叶子（23 个注入点），同一页在网络上被取两次
 * ——这不是"将来会疼"，是基线实测（`docs/refactor/pagetile-baseline.md`）。
 *
 * **它不负责什么**（§21.6，写在这里挡人，别往里加）：
 *   不决定显示哪些页；不绑点击 / 拖拽 / 键盘；不画 diff（只给 `overlays` 插槽）；
 *   不写版心结果；不做批量选择；不管尺寸档从哪来（只接收，变化由视图调 `invalidate`）；
 *   不做预取策略；不读 `currentView`；**不按 id 找 DOM**（第一个参数永远是宿主元素）。
 *
 * **一个 pageNo 只有一个 `<img>`（§21.8 逼出来的）**：
 * 判据是"同一页同一档位的 `<img>.src` 赋值次数 = 1"，不是网络请求数——`/pages/N/image` 带
 * `Cache-Control: max-age=300`，第二次取图命中浏览器缓存，**用网络数会把重复取图判成通过**。
 * 既然按"赋值次数"判，那么两个消费者就不能各有一个 `<img>`（各赋一次 = 2）。
 * 所以：`handle.mount()` 是把**同一张图**挂进你的宿主（挂到别处 = 移动，不重新取图）。
 * 一个视图只在自己活跃时挂，切换视图时图跟着走——预览/目录/审校本来就不同时可见。
 * **接线规则（Architect 2026-10-29 §21.10）**：**先 `release` 再 `create`**，不许两个宿主
 * 同时持有同一页。两个宿主同挂时图会移动到最后挂的那个，旧宿主的瓷砖会**静默变空**——
 * `tileScanDetached` 只看 `host.isConnected`，旧宿主还连着，所以既不释放也不告警。
 * 这条代价由酸测试钉住（`tests/js/page-tile-acid.mjs`），不是靠记性。
 *
 * **跨子树宿主**：模块不认 id，也不属于任何 `<section>`；宿主由调用方给。
 */
(function () {
  "use strict";

  /** 合法尺寸档：从模糊到清晰。越界降级到 `view` 并提示一次（§21.7）。 */
  const SIZES = ["thumb", "view", "mid", "zoom"];
  const RANK = { thumb: 0, view: 1, mid: 2, zoom: 3 };
  const FALLBACK_SIZE = "view";
  /** 视口外多远开始取图。与三个视图原来的 `rootMargin` 同一量级，别改大（会抢带宽）。 */
  const ROOT_MARGIN = "200px";

  /** pageNo → { pageNo, size, status, url, img, observer, handles:Set, seq } */
  const registry = new Map();
  let injected = {};
  let ready = false;   // init 没给齐必需依赖 → create 一律返回 null（fail closed）
  let frameHandle = null;
  /** 只提示一次：同一个越界尺寸反复提示等于刷屏。 */
  const warnedSizes = new Set();

  const isFn = (value) => typeof value === "function";

  /**
   * 帧末跑（不同步释放：`appendChild` 移动节点会先"移除"再"插回"，同步释放会误杀）。
   *
   * 没有 `requestAnimationFrame` 的环境（单测的 node）退回 `setTimeout(16)`：
   * 那个定时器必须 `unref()`，否则"注册表非空就每帧扫"会让进程永远不退出。
   */
  function tileScheduleFrame() {
    if (frameHandle !== null) return;
    if (typeof requestAnimationFrame === "function") {
      frameHandle = requestAnimationFrame(() => {
        frameHandle = null;
        tileScanDetached();
        if (registry.size > 0) tileScheduleFrame();   // 注册表空了就停，不留常驻定时器
      });
      return;
    }
    const timer = setTimeout(() => {
      frameHandle = null;
      tileScanDetached();
      if (registry.size > 0) tileScheduleFrame();
    }, 16);
    if (timer && typeof timer.unref === "function") timer.unref();
    frameHandle = timer;
  }

  /**
   * 每帧扫一遍**当前 handle 集合**（不遍历 DOM）：宿主已经不在文档里 → 该 handle 出组。
   * 已知成本（§21.5）：注册表非空期间每帧一次 `isConnected` 扫描，量级约 20–40 个 handle。
   * **将来页面卡顿先量这里**，别从头查。
   */
  function tileScanDetached() {
    for (const record of [...registry.values()]) {
      for (const handle of [...record.handles]) {
        if (handle.host && handle.host.isConnected === false) tileRelease(handle);
      }
    }
  }

  function tileNotify(handle, payload) {
    if (!isFn(handle.onReady)) return;
    try {
      handle.onReady(payload);
    } catch (error) {
      // 一个消费者的回调炸了，不许带掉同一页的其他持有者
      if (isFn(injected.notify)) injected.notify({ kind: "error", text: String((error && error.message) || error) });
    }
  }

  function tileClampSize(size, pageNo) {
    if (SIZES.includes(size)) return size;
    const label = String(size);
    if (!warnedSizes.has(label)) {
      warnedSizes.add(label);
      if (isFn(injected.notify)) {
        injected.notify({ kind: "warn", text: `尺寸档 ${label || "(空)"} 不认识，已按 ${FALLBACK_SIZE} 取图（页 ${pageNo}）` });
      }
    }
    return FALLBACK_SIZE;
  }

  function tileSizeOf(handle) {
    const raw = handle.size === "auto" ? injected.getProfile(handle.host, handle.pageNo) : handle.size;
    return tileClampSize(raw, handle.pageNo);
  }

  /** 一组 handle 里最清晰的那一档：同一 pageNo 只有一份缓存，不能两个消费者各取一档。 */
  function tilePreferredSize(record) {
    let best = FALLBACK_SIZE;
    for (const handle of record.handles) {
      const size = tileClampSize(handle.size, record.pageNo);
      if (RANK[size] > RANK[best]) best = size;
    }
    return best;
  }

  function tilePageExists(pageNo) {
    const project = isFn(injected.getProject) ? injected.getProject() : null;
    if (!project) return false;
    const pages = project.pages || [];
    return pages.some((page) => Number(page.page_no) === Number(pageNo));
  }

  function tileMakeRecord(pageNo) {
    const img = document.createElement("img");
    img.className = "ptile__image";
    img.alt = "";
    img.decoding = "async";
    const record = {
      pageNo,
      size: null,
      status: "pending",
      url: null,
      img,
      observer: null,
      handles: new Set(),
      seq: 0,
      loading: false,   // 一次取图在途：观察器可能连续回调，别再赋一次 src
    };
    if (typeof IntersectionObserver === "function") {
      record.observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) tileLoad(record);
      }, { rootMargin: ROOT_MARGIN });
      record.observer.observe(img);
    }
    return record;
  }

  /** 只在这里给 `img.src` 赋值——全模块唯一一处取图入口（酸测试数的就是它）。 */
  function tileLoad(record) {
    if (!record.handles.size) return;
    if (record.loading) return;                              // 在途：重复回调不再取图
    if (record.url && record.status === "ready") return;     // 已经取到且没作废
    const size = tilePreferredSize(record);
    const build = urlBuilder();
    const url = build ? build(record.pageNo, size) : null;
    if (!url) return;
    record.size = size;
    record.url = url;
    record.status = "pending";
    record.seq += 1;
    record.img.dataset.status = "pending";
    record.img.onload = () => {
      record.loading = false;
      record.status = "ready";
      record.img.dataset.status = "ready";
      tilePublish(record);
    };
    record.img.onerror = () => {
      // 不抛，但**不许静默**：状态可读 + onReady 必须被调用（§21.7）
      record.loading = false;
      record.status = "missing";
      record.img.dataset.status = "missing";
      tilePublish(record);
    };
    for (const handle of record.handles) handle.el.classList.remove("is-missing");
    record.loading = true;
    record.img.src = url;
    tilePublish(record);
  }

  function tilePublish(record) {
    for (const handle of record.handles) {
      handle.size = record.size || handle.size;
      handle.status = record.status;
      handle.url = record.url;
      handle.el.dataset.status = record.status;
      handle.el.classList.toggle("is-missing", record.status === "missing");
      if (isFn(injected.paintOverlays)) {
        try {
          injected.paintOverlays(handle.slot, { pageNo: handle.pageNo, overlays: handle.overlays, state: handle.state });
        } catch (error) {
          if (isFn(injected.notify)) injected.notify({ kind: "error", text: String((error && error.message) || error) });
        }
      }
      tileNotify(handle, { status: handle.status, pageNo: handle.pageNo, size: handle.size, url: handle.url });
    }
  }

  function tileDispose(record) {
    if (record.observer) record.observer.disconnect();
    record.observer = null;
    if (record.img.parentNode) record.img.parentNode.removeChild(record.img);
    registry.delete(record.pageNo);
  }

  /**
   * 建一个瓷砖。`host` 是宿主元素（模块不按 id 找 DOM）。
   * @returns {object|null} 页不存在 / 参数不合法 → `null`（调用方据此显示"页不存在"，
   *   与"图还没到"必须可分辨：后者返回 handle，`handle.status === "pending"`）。
   */
  function tileCreate(host, options) {
    const opts = options || {};
    const pageNo = Number(opts.pageNo);
    if (!host || !Number.isFinite(pageNo)) return null;
    if (!ready) return null;                       // fail closed：缺依赖时不出瓷砖
    if (!tilePageExists(pageNo)) return null;

    const record = registry.get(pageNo) || tileMakeRecord(pageNo);
    registry.set(pageNo, record);

    const el = document.createElement("div");
    el.className = "ptile";
    const slot = document.createElement("div");
    slot.className = "ptile__overlays";
    el.append(record.img, slot);          // 同一张图：这里就是把"唯一资源"挂进宿主
    if (host.appendChild) host.appendChild(el);

    const handle = {
      pageNo,
      host,
      el,
      slot,
      img: record.img,
      size: tileClampSize(opts.size === "auto" || opts.size === undefined ? "auto" : opts.size, pageNo),
      status: record.status,
      url: record.url,
      overlays: opts.overlays || null,
      state: null,
      onReady: opts.onReady || null,
      dead: false,
    };
    handle.size = tileSizeOf(handle);
    record.handles.add(handle);
    el.dataset.status = record.status;
    tileScheduleFrame();
    // 没有观察器（老浏览器 / 单测环境）就没有"可见"信号：直接取图，不许永远 pending。
    if (!record.observer) tileLoad(record);
    tilePublish(record);
    return handle;
  }

  /** `patch`: size / overlays / state。尺寸档变化只可能让这一页**升档**，不会各取一份。 */
  function tileUpdate(handle, patch) {
    if (!handle || handle.dead) return null;   // 已出组的 handle 不自动复活（§21.5）
    const changes = patch || {};
    if ("size" in changes) handle.size = tileClampSize(changes.size, handle.pageNo);
    if ("overlays" in changes) handle.overlays = changes.overlays;
    if ("state" in changes) handle.state = changes.state;
    const record = registry.get(handle.pageNo);
    if (!record) return handle;
    const next = tilePreferredSize(record);
    if (next !== record.size) {
      record.url = null;                 // 升档 = 这一页的缓存作废一次
      record.status = "pending";
      tileLoad(record);
    } else {
      tilePublish(record);
    }
    return handle;
  }

  /**
   * 作废：`target` 是 pageNo 或 `"*"`；`reason` 是 image / profile / data。
   * 一次作废，所有持有者同时看到新版本——**且这一页只新增一次取图**。
   */
  function tileInvalidate(target, reason) {
    const why = reason || "image";
    const records = target === "*" ? [...registry.values()] : [registry.get(Number(target))].filter(Boolean);
    for (const record of records) {
      record.url = null;
      record.loading = false;
      record.status = "pending";
      record.img.dataset.status = "pending";
      record.img.removeAttribute("src");
      if (why === "profile" || why === "data") record.size = null;
      tilePublish(record);
      tileLoad(record);
    }
    return records.length;
  }

  /** 从组里移除一个 handle；**组空了才**释放缓存与 observer（§21.5）。 */
  function tileRelease(handle) {
    if (!handle || handle.dead) return;
    const record = registry.get(handle.pageNo);
    handle.dead = true;
    if (handle.el && handle.el.parentNode) handle.el.parentNode.removeChild(handle.el);
    if (!record) return;
    const heldImage = record.img.parentNode === handle.el || (handle.el && handle.el.contains && handle.el.contains(record.img));
    record.handles.delete(handle);
    if (record.handles.size === 0) {
      tileDispose(record);
      return;
    }
    // 图在被我拆掉的宿主里 → 交给还在组里的下一个持有者，别让另一处凭空变空
    if (heldImage) {
      const next = record.handles.values().next().value;
      if (next && next.el && next.el.appendChild) next.el.appendChild(record.img);
    }
    tileScheduleFrame();
  }

  /**
   * 取图 URL 的句柄。**过渡态**（2026-10-29，只活一笔）：测试侧还按旧名 `imageUrl` 传，
   * 而 A1 不许产品笔同时改 tests/js —— 所以这里先认两个名字，测试切到 `getImageUrl` 之后
   * 紧接着一笔把旧名字删掉。契约名只有 `getImageUrl`（Architect §21.10 ②）。
   */
  function urlBuilder() {
    if (isFn(injected.getImageUrl)) return injected.getImageUrl;
    if (isFn(injected.imageUrl)) return injected.imageUrl;
    return null;
  }

  /** 必需依赖：缺了就必须 fail closed（§21.10 ②），不许静默出一片空白瓷砖。 */
  const REQUIRED = ["getProject"];

  function tileInit(deps) {
    injected = { ...injected, ...(deps || {}) };
    const missing = REQUIRED.filter((key) => !isFn(injected[key]));
    if (!urlBuilder()) missing.push("getImageUrl");
    ready = missing.length === 0;
    if (!ready) {
      const text = `PageTile.init 缺少必需依赖：${missing.join("、")}——瓷砖不会出图`;
      if (isFn(injected.notify)) injected.notify({ kind: "error", text });
      else if (typeof console === "object" && console && isFn(console.error)) console.error(text);
    }
    return api;
  }

  const api = {
    init: tileInit,
    create: tileCreate,
    update: tileUpdate,
    invalidate: tileInvalidate,
    release: tileRelease,
  };
  window.PageTile = api;
})();
