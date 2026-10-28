// 审校视图模块（`static/reading-view.js`）的**单元**加载器：零侵入，不碰产品代码。
//
// 为什么需要第二个加载器：模块是经典脚本，整体包在 `(function () { … })();` 里，
// 对外只露 `window.ReadingView` 的 6 个稳定项（R8）。可 L7–L12 把一批**纯函数**
// （`readingDiffUnits` / `readingKey` / `readingEntryVisible` …）搬了进去，它们没有公开导出，
// 而"为测试加导出"会破 R8。所以在测试侧把那层 IIFE 剥掉再跑：
// 顶层 `function` 声明在 vm 里就是全局属性 → `ctx.readingDiffUnits(...)` 直接可调。
//
// **这是测试脚手架的一次性处理，不是改源码**（与 load-app 剥 `boot();` 同一条口径）。
//
// 限制（与 load-app 同一条边界）：
// - 模块顶层 `let`/`const` 不挂到 ctx 上（VM 的全局词法环境）。要读/写它们用 `run(code)`。
// - 依赖注入的函数（`injected.xxx`）必须先 `setInjected({...})`；不注入就调用会炸，
//   这是有意的——不要给它默认桩，否则"忘了注入"会表现为逻辑错误而不是装配错误。
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = new URL("../../backend/book2text/static/reading-view.js", import.meta.url);

/** 剥掉 IIFE 包装：返回模块体（保留行号偏移不重要，报错会带文件名）。 */
export function stripModuleWrapper(source) {
  const head = "(function () {";
  const start = source.indexOf(head);
  if (start === -1) {
    throw new Error("load-reading-view: 找不到 `(function () {` 包装——模块结构变了，先人工确认剥除点");
  }
  const tail = source.lastIndexOf("})();");
  if (tail === -1) {
    throw new Error("load-reading-view: 找不到结尾的 `})();`——模块结构变了，先人工确认剥除点");
  }
  if (tail <= start) {
    throw new Error("load-reading-view: 包装首尾顺序不对，拒绝剥离");
  }
  return source.slice(start + head.length, tail);
}

/**
 * 加载模块体，返回 `{ ctx, run, setInjected }`。
 *
 * @param {{file?: string, require?: string[]}} [options]
 *   `require`：必须真的存在的顶层函数名。缺了就在加载时抛错，
 *   别让用例在 `undefined` 上做无意义的断言（这比"红一条"更早、更清楚）。
 */
export function loadReadingView(options = {}) {
  const file = options.file || fileURLToPath(DEFAULT_FILE);
  const source = readFileSync(file, "utf8");
  const body = stripModuleWrapper(source);

  const noop = () => {};
  const sandbox = {
    console,
    // 模块体在载入时只做"声明 + 挂 window.ReadingView"，下面这些是给函数体里的引用兜底用的；
    // 真跑 DOM 行为不在这个加载器的职责范围内（那是 reading-view-behavior 的假 DOM）。
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop } }),
      body: { classList: { add: noop, remove: noop } },
    },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    addEventListener: noop,
    removeEventListener: noop,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    performance: { now: () => Date.now() },
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    innerWidth: 1400,
    innerHeight: 900,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(body, ctx, { filename: file });

  for (const name of options.require || []) {
    if (typeof ctx[name] !== "function") {
      throw new Error(
        `load-reading-view: ctx.${name} 不是函数——它可能又搬走了，或者被改名了（先看 reading-view.js）`,
      );
    }
  }

  return {
    ctx,
    /** 在同一个上下文里执行一段代码（给顶层 `let`/`const` 赋值只能这么干）。 */
    run: (code) => vm.runInContext(code, ctx),
    /**
     * 把依赖对象塞进模块的 `injected`。
     * 走宿主变量中转：直接把对象当参数传进 vm 也行，但这样一次性替换整张注入表更接近生产
     * （`init(deps)` 就是 `injected = { ...injected, ...deps }`）。
     */
    setInjected: (deps) => {
      ctx.__injected = deps;
      vm.runInContext("injected = __injected;", ctx);
    },
  };
}
