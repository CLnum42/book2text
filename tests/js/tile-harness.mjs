// PageTile 的测试环境（最小 DOM + 观察器）：单测与酸测试共用。
//
// 为什么自己写而不是装 jsdom：仓库不装 npm 依赖、没有构建步骤（D-046），
// `node tests/js/run.mjs` 只用 Node 内置能力。这里只实现 page-tile.js 真正用到的那一小片 DOM，
// **不是通用 DOM 实现**——多实现一层就多一层"测的是替身不是产品"的风险。
import { readFileSync } from "node:fs";
import vm from "node:vm";

const MODULE_PATH = new URL("../../backend/book2text/static/page-tile.js", import.meta.url);

/** 宿主元素上的 `.ptile` 节点：从宿主往下找第一层。 */
function tileOf(host) {
  return (host.children || []).find((child) => String(child.className).includes("ptile")) || null;
}

function makeElement(environment, tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: "",
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    _src: "",
    classList: {
      add(name) {
        if (!el.classList.contains(name)) el.className = `${el.className} ${name}`.trim();
      },
      remove(name) {
        el.className = el.className.split(/\s+/).filter((item) => item && item !== name).join(" ");
      },
      toggle(name, force) {
        const on = force === undefined ? !el.classList.contains(name) : Boolean(force);
        if (on) el.classList.add(name); else el.classList.remove(name);
        return on;
      },
      contains(name) {
        return el.className.split(/\s+/).includes(name);
      },
    },
    append(...nodes) {
      for (const node of nodes) el.appendChild(node);
    },
    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = el;
      el.children.push(node);
      return node;
    },
    removeChild(node) {
      const at = el.children.indexOf(node);
      if (at >= 0) el.children.splice(at, 1);
      if (node.parentNode === el) node.parentNode = null;
      return node;
    },
    contains(node) {
      let cursor = node;
      while (cursor) {
        if (cursor === el) return true;
        cursor = cursor.parentNode;
      }
      return false;
    },
    removeAttribute(name) {
      if (name === "src") el._src = "";
    },
    setAttribute(name, value) {
      if (name === "src") el.src = value;
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { width: 320, height: 420 };
    },
    focus() {},
  };
  const isImage = String(tag).toLowerCase() === "img";
  if (isImage) {
    Object.defineProperty(el, "src", {
      get: () => el._src,
      set(value) {
        el._src = String(value);
        el._settled = "";
        environment.srcWrites.push({ url: el._src });
      },
    });
  }
  if (isImage) environment.images.push(el);
  Object.defineProperty(el, "isConnected", {
    get() {
      let cursor = el;
      while (cursor) {
        if (cursor.__root) return true;
        cursor = cursor.parentNode;
      }
      return false;
    },
  });
  return el;
}

/**
 * 建一份测试环境：`document` / `IntersectionObserver` / 取图记录。
 * @param {{pages?: number[]}} [options]
 */
export function makeEnvironment(options = {}) {
  const environment = {
    srcWrites: [],
    observers: [],
    notifications: [],
    images: [],
  };
  const pages = (options.pages || [1, 2, 3]).map((pageNo) => ({ page_no: pageNo, width_pt: 612 }));
  const project = { project_id: "b2t_TEST", pages };

  const body = makeElement(environment, "body");
  body.__root = true;

  const document = {
    body,
    createElement: (tag) => makeElement(environment, tag),
  };

  class Observation {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      this.disconnects = 0;
      environment.observers.push(this);
    }

    observe(target) {
      this.targets.add(target);
    }

    unobserve(target) {
      this.targets.delete(target);
    }

    disconnect() {
      this.disconnects += 1;
      this.targets.clear();
    }

    /** 模拟"进入视口"：真实浏览器里由观察器自己回调。 */
    show() {
      if (!this.targets.size) return;
      this.callback([...this.targets].map((target) => ({ isIntersecting: true, target })), this);
    }
  }

  const loadTile = () => {
    const sandbox = {
      document,
      IntersectionObserver: Observation,
      setTimeout,
      clearTimeout,
      console,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(MODULE_PATH, "utf8"), sandbox, { filename: "page-tile.js" });
    return sandbox.PageTile;
  };

  const mount = () => {
    const host = makeElement(environment, "div");
    host.className = "consumer";
    body.appendChild(host);
    return host;
  };

  return {
    project,
    document,
    body,
    mount,
    tileOf,
    loadTile,
    get srcWrites() {
      return environment.srcWrites;
    },
    get observers() {
      return environment.observers;
    },
    get notifications() {
      return environment.notifications;
    },
    /**
     * 让"图到了"：真实浏览器里是 `img.onload` 自己触发；这里由用例显式推进，
     * 否则 ready/missing 两条状态永远测不到。
     */
    settle() {
      for (const img of environment.images) {
        if (!img._src || img._settled === img._src) continue;
        img._settled = img._src;
        if (typeof img.onload === "function") img.onload();
      }
    },
    /** 让所有观察器认为目标进了视口（真实浏览器里由 IO 自己触发）。 */
    show() {
      for (const observer of environment.observers) observer.show();
    },
    /** 等一帧：模块的"帧末扫宿主"在这条路径上跑。 */
    async tick(ms = 40) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

/** 一份开箱可用的依赖集：`imageUrl` 的形状与 app.js 的 `pageImageUrl` 一致（含 size 参数）。 */
export function makeDeps(environment, overrides = {}) {
  return {
    getProject: () => environment.project,
    getProfile: () => "view",
    imageUrl: (pageNo, size) => `/api/projects/b2t_TEST/pages/${pageNo}/image?size=${size}&token=t`,
    notify: (payload) => environment.notifications.push(payload),
    ...overrides,
  };
}
