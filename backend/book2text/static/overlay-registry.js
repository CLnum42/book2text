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
    if (block.block_id) box.dataset.blockId = block.block_id;
    box.title = `${BLOCK_TYPE_LABELS[block.block_type] || block.block_type} · 第 ${block.order_index + 1} 块`;
    if (style.details !== false) box.append(buildOrderBadge(block.order_index));
    return box;
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
    layer.className = "overlay-layer page-overlay page-overlay--readonly";
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
    schedule();
  }

  function schedule() {
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

    handle.layer.hidden = visible === 0;
    handle.version = version;
    handle.geomHash = fnv1a(stableJSON(bboxes));
  }

  /** 只读诊断：版本、每类画了几个、几何指纹（不许有副作用）。 */
  function stats(pageNo) {
    const handle = handles.get(Number(pageNo));
    if (!handle) return { version: "", counts: {}, geomHash: "" };
    return { version: handle.version, counts: Object.assign({}, handle.counts), geomHash: handle.geomHash };
  }

  const api = { init, register, mount, unmount, paint, stats };
  window.OverlayLayer = api;
})();
