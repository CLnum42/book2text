/**
 * Overlay 图层 registry（片 1：type "blocks"，唯一消费者 = preview 视图）
 *
 * 契约：`docs/refactor/overlay-registry-contract.md`；施工书：`docs/refactor/overlay-registry-slice1.md`。
 *
 * **它拿什么**：`mount(hostEl, { pageNo })` —— host 由视图给（preview 给的是 `.preview-page` 那个
 * tile 元素本身）。拿到 host 之后**只 append，不查询**：图层容器是它自己 `createElement` 出来的，
 * 句柄里一直握着那个节点；换内容靠"先建新子树、再摘旧子树"，不清空重画。
 *
 * **容器 class = `overlay-layer page-overlay page-overlay--readonly`**：`overlay-layer` 只作标识 /
 * 诊断钩子，样式全靠 `.page-overlay` 那条作用域（`app.css` 本片 0 行改动）。容器必须挂在
 * `.preview-page` 子树里——`.preview-page .page-overlay{ z-index:2 }` 与
 * `.preview-page .page-overlay--readonly .box{ pointer-events:none }` 都是后代选择器，
 * 挂到子树外只会退回到 `--readonly` 的 `z-index:1`（只读规则本身是全局的，不丢）。
 *
 * **版本是内容指纹，不是人工 bump**：`fingerprint(data, styles) = FNV-1a(stableJSON({data, styles}))`，
 * 同签名直接跳过（幂等）。输入正好是"即将绘制的那份数据"，所以不存在第二个版本来源。
 * 成本实测（2026-11-02，真实最密页 24 块 / 13.8 KB）：1000 次均值 0.152 ms ≪ 2 ms 阈值。
 *
 * **`render(item, style)` 只许读它的两个参数**（§5.5）：任何额外输入（当前步骤、选中态…）
 * 必须先变成 `data` / `styles` 的一部分，否则指纹抓不到 → 数据没变就不重画 → 静默显示旧画面。
 *
 * 本片**不实现** `invalidate` / `hitTest` / `unregister`：没有调用点，按刀 A 的规矩不导出空壳。
 */
(function () {
  "use strict";

  let injected = {};
  /** type → { z, render(item, style) → Element }；一种视觉元素只注册一次。 */
  const registered = new Map();
  /** pageNo → handle（同一页只允许一个图层；诊断 stats 也走它）。 */
  const handles = new Map();
  /** 帧末待消费的 handle。 */
  const dirty = new Set();
  let rafId = 0;

  const BLOCK_TYPE_LABELS = {
    heading: "标题", paragraph: "段落", header: "页眉", footer: "页脚",
    page_number: "页码", footnote: "脚注", caption: "图注",
    figure: "插图", decoration: "装饰", margin_note: "旁批", other: "其他",
  };

  // ---------------------------------------------------------------- 指纹与稳定序列化

  /** 键序规范化后再序列化：同一份快照必须得到同一个字符串。 */
  function stableJSON(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(",")}}`;
  }

  /** 32 位 FNV-1a：够短、够快，只用来判"这份快照变没变"。 */
  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function fingerprint(data, styles) {
    return fnv1a(stableJSON({ data: data, styles: styles }));
  }

  // ---------------------------------------------------------------- 内置渲染器：blocks

  /** bbox 是归一化 0–1（相对 PDF 显示方向），画成百分比，和 `.box` 的定位口径一致。 */
  function applyRect(box, bbox) {
    const [x0, y0, x1, y1] = bbox;
    box.style.left = `${x0 * 100}%`;
    box.style.top = `${y0 * 100}%`;
    box.style.width = `${(x1 - x0) * 100}%`;
    box.style.height = `${(y1 - y0) * 100}%`;
  }

  /**
   * 顺序号：只读视图里框不可悬停、卡片永远不出现，所以序号固定贴在框内右上角
   * （CSS 的 `--inside` 形态）。框外的"避让排布"是交互视图（片 2 pages）才需要的能力。
   */
  function buildOrderBadge(index) {
    const order = document.createElement("span");
    order.className = "box__order box__order--inside";
    order.textContent = String(index + 1);
    order.style.top = "2px";
    order.style.right = "2px";
    return order;
  }

  function renderBlock(block, style) {
    const box = document.createElement("div");
    box.className = `box box--type-${block.block_type}`;
    if (!block.include) box.classList.add("box--excluded");
    if (block.review_status === "uncertain") box.classList.add("box--uncertain");
    applyRect(box, block.bbox);
    bboxByBox.set(box, block.bbox);
    if (block.block_id) box.dataset.blockId = block.block_id;
    box.title = `${BLOCK_TYPE_LABELS[block.block_type] || block.block_type} · 第 ${block.order_index + 1} 块`;
    if (style.details !== false) {
      box.append(buildOrderBadge(block.order_index));
      // 卡片只在"可交互"的视图里建（labeled = 能 hover）：preview 是只读缩略图，
      // 只画顺序号、不留一层永远看不见的卡片节点。
      if (style.labeled && typeof injected.buildLabel === "function") {
        box.append(injected.buildLabel(block, block.order_index));
      }
    }
    return box;
  }

  // ---------------------------------------------------------------- 块框的几何：避让排布（片 2）
  //
  // 整条避让链从 app.js 搬来（findOrderSpot / findLabelSpot / layout / schedule / 观察器 +
  // pxRect / rectsOverlap 与两个尺寸常数，实测 161 行）：契约 §1 不许"同一套算法两份"。
  //
  // 两个导出的分工（契约 §API · 书 §3.3）：
  //   layout(container, { lineBboxes, bboxOf })   一次摆：幂等、不画、不登记 rAF、不碰 version
  //   schedule(container, { …, onLaidOut })       排到可测为止（token + rAF + 90 帧）；成功后回调一次
  // `bboxOf` 是外部容器（审校 #detail-overlay）交出块框的唯一口子——registry 不读别人的私有属性；
  // 自己画的盒子走内部 WeakMap，卸载即随节点回收。

  const BOX_ORDER_WIDTH = 22;
  const BOX_ORDER_HEIGHT = 16;
  const BOX_ORDER_GAP = 3;
  const BOX_LABEL_GAP = 6;

  /** box 元素 → 归一化 bbox（只登记 registry 自己画的盒子；不往 DOM 上挂对象属性）。 */
  const bboxByBox = new WeakMap();
  /** 容器 → 当前调度 token：同一容器只许一个调度在跑（重复 schedule 取消前一次）。 */
  const layoutTokens = new WeakMap();
  /** 容器 → 观察参数（ResizeObserver 重摆时要用同一份 bboxOf / lineBboxes）。 */
  const layoutOptions = new WeakMap();
  /** 已 observe 的容器（unmount 时 unobserve，别留死引用）。 */
  const observedContainers = new Set();
  let resizeObserver = null;

  function pxRect(bbox, width, height) {
    return {
      x0: bbox[0] * width,
      y0: bbox[1] * height,
      x1: bbox[2] * width,
      y1: bbox[3] * height,
    };
  }

  function rectsOverlap(a, b, pad = 0) {
    return a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.y0 < b.y1 + pad && a.y1 > b.y0 - pad;
  }

  /** 顺序号的位置：先找框边空位；密集页没有缝隙时退到页边留白（像行号）。 */
  function findOrderSpot(own, obstacles, width, height) {
    const w = BOX_ORDER_WIDTH;
    const h = BOX_ORDER_HEIGHT;
    const gap = BOX_ORDER_GAP;
    const preferLeft = (own.x0 + own.x1) / 2 <= width / 2;
    const marginCandidates = preferLeft
      ? [[2, own.y0], [width - w - 2, own.y0]]
      : [[width - w - 2, own.y0], [2, own.y0]];
    const candidates = [
      [own.x1 - w, own.y0 - gap - h], // 右上（框外）
      [own.x0 - gap - w, own.y0], // 左上（框外）
      [own.x1 + gap, own.y0], // 右侧
      [own.x1 - w, own.y1 + gap], // 右下
      [own.x0 - gap - w, own.y1 + gap], // 左下
      ...marginCandidates, // 页边留白：密集页里唯一保证不压字的位置
    ];
    for (const [x, y] of candidates) {
      const rect = { x0: x, y0: y, x1: x + w, y1: y + h };
      if (x < 0 || y < 0 || rect.x1 > width || rect.y1 > height) continue;
      if (obstacles.some((obstacle) => rectsOverlap(rect, obstacle, 1))) continue;
      return rect;
    }
    return null;
  }

  /** 悬停卡片：优先贴框的上 / 右 / 左 / 下；密集页退到"本行旁边最宽的那条留白"。 */
  function findLabelSpot(own, size, obstacles, width, height) {
    const gap = BOX_LABEL_GAP;
    const fitX = (x) => Math.min(Math.max(x, 0), Math.max(0, width - size.width));
    const fitY = (y) => Math.min(Math.max(y, 0), Math.max(0, height - size.height));

    const bandY = Math.min(
      Math.max(own.y0 + (own.y1 - own.y0) / 2 - size.height / 2, 0),
      Math.max(0, height - size.height)
    );
    const band = obstacles.filter((obstacle) => obstacle.y0 < bandY + size.height && obstacle.y1 > bandY);
    const bandRight = band.length ? Math.max(...band.map((item) => item.x1)) : own.x1;
    const bandLeft = band.length ? Math.min(...band.map((item) => item.x0)) : own.x0;

    const candidates = [
      { x0: fitX(own.x0), y0: own.y0 - gap - size.height },
      { x0: own.x1 + gap, y0: fitY(own.y0) },
      { x0: own.x0 - gap - size.width, y0: fitY(own.y0) },
      { x0: fitX(own.x0), y0: own.y1 + gap },
      { x0: bandRight + gap, y0: bandY },
      { x0: bandLeft - gap - size.width, y0: bandY },
      { x0: 4, y0: 4 },
      { x0: width - size.width - 4, y0: 4 },
      { x0: (width - size.width) / 2, y0: 4 },
      { x0: 4, y0: height - size.height - 4 },
      { x0: width - size.width - 4, y0: height - size.height - 4 },
      { x0: 4, y0: fitY((height - size.height) / 2) },
      { x0: width - size.width - 4, y0: fitY((height - size.height) / 2) },
    ];
    for (const candidate of candidates) {
      const rect = {
        x0: candidate.x0,
        y0: candidate.y0,
        x1: candidate.x0 + size.width,
        y1: candidate.y0 + size.height,
      };
      if (rect.x0 < 0 || rect.y0 < 0 || rect.x1 > width || rect.y1 > height) continue;
      if (obstacles.some((obstacle) => rectsOverlap(rect, obstacle, 2))) continue;
      return rect;
    }
    // 实在没有空白：退到框下方（可能压到下一块，但至少不挡正在看的这一行）
    const x = fitX(own.x1 - size.width);
    const y = Math.min(Math.max(own.y1 + gap, 0), Math.max(0, height - size.height));
    return { x0: x, y0: y, x1: x + size.width, y1: y + size.height };
  }

  /**
   * 给一个容器的所有 `.box` 摆好顺序号与卡片（**一次摆，幂等**）。
   *
   * 只读两个参数：容器自己的矩形 + 调用方给的 bbox 来源；不画、不改 data、不碰 version、不排帧。
   * 图还没布局好（宽高 < 60）时返回 false，调用方在下一帧重试。
   */
  function layout(container, options = {}) {
    if (!container || !container.isConnected || container.hidden) return false;
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width < 60 || height < 60) return false;

    const bboxOf = typeof options.bboxOf === "function" ? options.bboxOf : (box) => bboxByBox.get(box);
    const boxes = boxesIn(container);
    const obstacles = [];
    for (const box of boxes) {
      const bbox = bboxOf(box);
      if (bbox) obstacles.push(pxRect(bbox, width, height));
    }
    for (const bbox of options.lineBboxes || []) {
      if (bbox) obstacles.push(pxRect(bbox, width, height));
    }

    for (const box of boxes) {
      const bbox = bboxOf(box);
      if (!bbox) continue;
      const own = pxRect(bbox, width, height);
      const offsetX = box.clientLeft || 0;
      const offsetY = box.clientTop || 0;

      const order = firstChildWithClass(box, "box__order");
      if (order) {
        const spot = findOrderSpot(own, obstacles, width, height);
        order.classList.toggle("box__order--inside", !spot);
        const at = spot || { x0: own.x1 - BOX_ORDER_WIDTH - 2, y0: own.y0 + 2 };
        order.style.left = `${at.x0 - own.x0 - offsetX}px`;
        order.style.top = `${at.y0 - own.y0 - offsetY}px`;
        // 后面的号也不许压到前面已经摆好的号
        obstacles.push({
          x0: at.x0, y0: at.y0, x1: at.x0 + BOX_ORDER_WIDTH, y1: at.y0 + BOX_ORDER_HEIGHT,
        });
      }

      const label = firstChildWithClass(box, "box__label");
      if (label) {
        const size = { width: label.offsetWidth, height: label.offsetHeight };
        if (!size.width || !size.height) continue;
        const spot = findLabelSpot(own, size, obstacles, width, height);
        label.style.left = `${spot.x0 - own.x0 - offsetX}px`;
        label.style.top = `${spot.y0 - own.y0 - offsetY}px`;
      }
    }
    return true;
  }

  /** 记住这份参数并确保容器被观察（尺寸变了用同一份参数重摆）。 */
  function rememberLayout(container, options) {
    layoutOptions.set(container, options);
    if (typeof ResizeObserver === "undefined") return;
    if (!resizeObserver) {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (!entry.target.isConnected) continue;
          schedule(entry.target, layoutOptions.get(entry.target) || {});
        }
      });
    }
    if (!observedContainers.has(container)) {
      resizeObserver.observe(container);
      observedContainers.add(container);
    }
  }

  /**
   * 排到容器可测为止（**唯一的重试循环**）：token 让同一容器只保留最后一次调度。
   * 成功后调一次 `onLaidOut`（审校拿它重画差异层）；它只作通知，不接绘制以外的东西。
   */
  function schedule(container, options = {}) {
    if (!container || container.hidden) return;
    const token = (layoutTokens.get(container) || 0) + 1;
    layoutTokens.set(container, token);
    rememberLayout(container, options);
    stepSchedule(container, token, options, 0);
  }

  function stepSchedule(container, token, options, attempt) {
    requestAnimationFrame(() => {
      if (layoutTokens.get(container) !== token || !container.isConnected) return;
      if (layout(container, options)) {
        if (typeof options.onLaidOut === "function") options.onLaidOut();
        return;
      }
      if (attempt < 90) stepSchedule(container, token, options, attempt + 1);
    });
  }

  /** 容器里的块框（registry 自己画的是「type 包装 → .box」，审校容器是直接的 .box）。 */
  function boxesIn(container) {
    const found = [];
    const visit = (node) => {
      for (const child of Array.from(node.children || [])) {
        if (!child.classList) continue;
        if (child.classList.contains("box")) found.push(child);
        else if (child.classList.contains("overlay-layer__type")) visit(child);
      }
    };
    visit(container);
    return found;
  }

  /** 某个盒子里按类名找唯一子元素（只认 .box__order / .box__label，不做选择器解析）。 */
  function firstChildWithClass(node, className) {
    for (const child of Array.from(node.children || [])) {
      if (child.classList && child.classList.contains(className)) return child;
    }
    return null;
  }

  /** 容器 class 由 styles 决定（唯一写点；壳里不再 classList.add/remove）。 */
  function layerClassName(styles = {}) {
    let className = "overlay-layer page-overlay page-overlay--readonly";
    if (styles.labeled) className += " page-overlay--labeled";
    if (styles.marginMode) className += " page-overlay--margin";
    return className;
  }

  // ---------------------------------------------------------------- 接口

  /** 幂等：重复 init 只合并 deps（注入句柄不注入值）。 */
  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    if (!registered.has("blocks")) {
      register({ type: "blocks", z: 2, render: renderBlock });
    }
    return api;
  }

  function register({ type, z, render } = {}) {
    if (!type || typeof render !== "function") {
      throw new Error("OverlayLayer.register: 需要 { type, render }");
    }
    if (registered.has(type)) throw new Error(`OverlayLayer.register: type "${type}" 重复注册`);
    registered.set(type, { z: Number.isFinite(Number(z)) ? Number(z) : 0, render });
  }

  /** 给一个宿主挂图层：容器由本模块创建并 append 到宿主（不按 id / class 找 DOM）。 */
  function mount(hostEl, { pageNo } = {}) {
    const no = Number(pageNo);
    if (!hostEl || !hostEl.appendChild || !Number.isFinite(no)) return null;
    const existing = handles.get(no);
    if (existing) unmount(existing);
    const layer = document.createElement("div");
    layer.className = layerClassName();
    layer.dataset.pageNo = String(no);
    layer.hidden = true;
    hostEl.appendChild(layer);
    const handle = {
      pageNo: no,
      host: hostEl,
      layer,
      /** type → 当前挂在 layer 里的子树（先建后换，不做清空重画）。 */
      types: new Map(),
      /** type → 上次绘制的签名（版本 + 样式），用来做幂等早退。 */
      painted: new Map(),
      counts: {},
      version: "",
      geomHash: "",
      pending: null,
      dead: false,
    };
    handles.set(no, handle);
    return handle;
  }

  function unmount(handle) {
    if (!handle || handle.dead) return;
    handle.dead = true;
    handle.pending = null;
    dirty.delete(handle);
    if (handles.get(handle.pageNo) === handle) handles.delete(handle.pageNo);
    if (resizeObserver && observedContainers.delete(handle.layer)) resizeObserver.unobserve(handle.layer);
    layoutTokens.delete(handle.layer);
    layoutOptions.delete(handle.layer);
    if (handle.layer.parentNode) handle.layer.parentNode.removeChild(handle.layer);
    handle.types.clear();
    handle.painted.clear();
    handle.counts = {};
    handle.version = "";
    handle.geomHash = "";
  }

  /** 视图：数据到了 / 变了就叫一声；不立即画，登记到本模块唯一的 rAF，帧末消费。 */
  function paint(handle, { data, active, styles } = {}) {
    if (!handle || handle.dead) return;
    handle.pending = {
      data: Array.isArray(data) ? data : [],
      active: Array.isArray(active) ? active : [],
      styles: styles || {},
    };
    dirty.add(handle);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (rafId) return;
    rafId = requestAnimationFrame(flush);
  }

  function flush() {
    rafId = 0;
    const batch = Array.from(dirty);
    dirty.clear();
    for (const handle of batch) {
      if (!handle.dead) renderHandle(handle);
    }
  }

  /** 帧末：对每个已置脏的 handle × type 各画一次；签名没变就一个像素都不写。 */
  function renderHandle(handle) {
    const pending = handle.pending;
    handle.pending = null;
    if (!pending) return;
    if (!handle.layer.isConnected) {
      // 宿主已经脱离文档（视图忘了先 unmount）：静默 no-op，并留一条诊断
      if (typeof injected.notify === "function") {
        injected.notify({ kind: "warn", text: `OverlayLayer: 第 ${handle.pageNo} 页的图层宿主已离开文档` });
      }
      return;
    }
    const { data, active, styles } = pending;
    const version = fingerprint(data, styles);
    const styleJSON = stableJSON(styles);
    const bboxes = [];
    let visible = 0;

    for (const type of active) {
      const spec = registered.get(type);
      if (!spec) continue;
      const signature = `${version}|${styleJSON}`;
      if (handle.painted.get(type) === signature) {
        visible += handle.counts[type] || 0;
        continue;
      }
      const subtree = document.createElement("div");
      subtree.className = `overlay-layer__type overlay-layer__type--${type}`;
      subtree.style.zIndex = String(spec.z);
      let count = 0;
      for (const item of data) {
        if (!item || !item.bbox) continue; // 没有 bbox 的块不画（与 renderPageBlocks 同口径）
        const node = spec.render(item, styles);
        if (!node) continue;
        node.dataset.version = version;
        subtree.append(node);
        bboxes.push(item.bbox);
        count += 1;
      }
      // 先 append 新子树、再摘旧子树：中间不会出现"空一帧"的撕裂
      handle.layer.append(subtree);
      const previous = handle.types.get(type);
      if (previous && previous !== subtree && previous.parentNode === handle.layer) {
        handle.layer.removeChild(previous);
      }
      handle.types.set(type, subtree);
      handle.painted.set(type, signature);
      handle.counts[type] = count;
      visible += count;
    }

    for (const [type, node] of Array.from(handle.types)) {
      if (active.includes(type)) continue;
      if (node.parentNode === handle.layer) handle.layer.removeChild(node);
      handle.types.delete(type);
      handle.painted.delete(type);
      handle.counts[type] = 0;
    }

    handle.layer.className = layerClassName(styles);
    handle.layer.hidden = visible === 0;
    handle.version = version;
    handle.geomHash = fnv1a(stableJSON(bboxes));
    // 只有可交互视图（labeled）才需要"框外避让"：只读缩略图的号固定在框内右上角。
    if (styles.labeled && styles.details !== false && visible > 0) schedule(handle.layer, {});
  }

  /** 只读诊断：版本、每类画了几个、几何指纹（不许有副作用）。 */
  function stats(pageNo) {
    const handle = handles.get(Number(pageNo));
    if (!handle) return { version: "", counts: {}, geomHash: "" };
    return { version: handle.version, counts: Object.assign({}, handle.counts), geomHash: handle.geomHash };
  }

  const api = { init, register, mount, unmount, paint, stats, layout, schedule };
  window.OverlayLayer = api;
})();
