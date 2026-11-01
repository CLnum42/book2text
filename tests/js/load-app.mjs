// 零侵入加载 app.js（前端单元测试的脚手架，不改被测源码一行）。
//
// 为什么能这样做：backend/book2text/static/app.js 是**经典脚本**（index.html 用 <script src> 引入，
// 不是 ES module），文件开头 "use strict";，没有 IIFE 包裹。所以用 node:vm 执行后，
// 顶层 function 声明会成为全局对象的属性，可以直接 ctx.readingDiffUnits(...) 调用。
//
// 已知边界（别越界）：
// 1. 只有**顶层 function 声明**能这样测。`let`/`var`/`const` 声明的顶层变量不会挂到 ctx 上
//    （const/let 在 vm 的全局词法环境里，var 才挂 global）——依赖模块级状态的函数不能直接测。
//    例外：源码主动挂到 window 上的东西（如 window.__b2tWordBoxStats）可以通过 ctx.window 读到。
// 2. 需要 document / location 等浏览器对象的函数不能测。第一阶段只测**纯函数**：参数进、值出。
// 3. 文件末尾那次 boot() 会被剥掉（见下）。这只是测试脚手架的一次性处理，不是改源码：
//    app.js 本身、index.html、后端一律不碰。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";

const DEFAULT_APP_PATH = new URL("../../backend/book2text/static/app.js", import.meta.url);

const STATIC_DIR = fileURLToPath(new URL("../../backend/book2text/static/", import.meta.url));

/** 从源码里的 `injected.X` 生成一份最小注入表（模块 init 只是存起来，不会在载入时调用它们）。 */
function moduleDeps(ctx, source) {
  const names = [...new Set([...source.matchAll(/injected\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  const deps = {};
  for (const name of names) {
    deps[name] = name === "el"
      ? (id) => ctx.document.getElementById(id)
      : () => undefined;
  }
  return deps;
}

/**
 * 在 app.js **之前**载入视图模块（index.html 的顺序：模块先、app.js 后）。
 *
 * **载的是真实模块**（不是替身/桩）：替身会把"模块少一个函数"变成绿——那正是这套夹具被撤回过的理由。
 * 模块不存在时**不抛**：打印一行「<名字> 未载入，跳过加载」并记进报告，由用例自己决定 skip——
 * **skip 要能被看见，不许静默当通过**。
 */
export function preloadModules(ctx, names, moduleDir = STATIC_DIR) {
  const report = [];
  for (const name of names) {
    const file = join(moduleDir, name);
    if (!existsSync(file)) {
      console.log(`… ${name} 未载入，跳过加载（模块尚未落盘）`);
      report.push({ name, loaded: false, reason: "missing" });
      continue;
    }
    const source = readFileSync(file, "utf8");
    vm.runInContext(source, ctx, { filename: file });
    // api 名从源码里取 `window.X = api`：**不能**用"第一个带 init 的对象"猜——
    // 先载 PagesView 之后，第二个模块会被认成 PagesView，于是把它的 deps 又 init 到 PagesView 上。
    const declared = /window\.([A-Za-z_$][\w$]*)\s*=\s*api\b/.exec(source);
    const apiName = declared ? declared[1] : null;
    if (!apiName || !ctx[apiName] || typeof ctx[apiName].init !== "function") {
      throw new Error(`preloadModules: 载入了 ${name}，但没找到 window.Xxx = { init() } 接口——模块结构变了`);
    }
    ctx[apiName].init(moduleDeps(ctx, source));
    report.push({ name, loaded: true, api: apiName });
  }
  return report;
}

/** 文件末尾的 boot() 调用：必须在最后，且前面只有空白。 */
const BOOT_CALL_TAIL = /\nboot\(\);[ \t]*\r?\n?[ \t]*$/;

/**
 * 把 app.js 载入一个 vm 上下文，返回该上下文的全局对象。
 *
 * @param {{ appPath?: string }} [options] appPath 默认仓库里的 app.js；
 *   传别的路径就可以对历史上某个版本跑同一批用例（验证用例真的会红）。
 * @returns {object} ctx，可直接 ctx.readingDiffUnits(...)
 */
export function loadApp(options = {}) {
  // B2T_APP_JS：对历史版本（git show <commit>:...app.js > /tmp/x.js）跑同一批用例，
  // 用来证明用例在那个版本上真的会红。不设就用仓库里的 app.js。
  const appPath = options.appPath || process.env.B2T_APP_JS || DEFAULT_APP_PATH;
  let src = readFileSync(appPath, "utf8");

  // 剥掉末尾的 boot()：它一启动就要真 DOM / 路由，测试里不需要，也不该让它去碰网络。
  // 剥不掉就报错，不猜——否则容易在错误的上下文里"看起来测过了"。
  if (!BOOT_CALL_TAIL.test(src)) {
    throw new Error(
      `load-app: 没找到文件末尾的 boot(); —— app.js 的结尾结构变了，需要人工确认剥除点（${appPath}）`,
    );
  }
  src = src.replace(BOOT_CALL_TAIL, "\n");

  const noop = () => {};
  // 顶层第 14 行是 `const token = new URLSearchParams(location.search).get("token")`。
  // URLSearchParams 必须给，否则脚本在第 14 行就中断，后面所有顶层 const/let 全部停在 TDZ，
  // 函数虽然能拿到（声明提升），一调用就 ReferenceError: Cannot access 'x' before initialization。
  const fakeNode = {
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {},
    dataset: {},
    append: noop,
    appendChild: noop,
    remove: noop,
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
    clientWidth: 0,
    clientHeight: 0,
    offsetTop: 0,
    textContent: "",
    innerHTML: "",
  };
  const document = {
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ ...fakeNode }),
    body: fakeNode,
    head: fakeNode,
    documentElement: fakeNode,
    readyState: "complete",
    hidden: false,
  };

  const sandbox = {
    console,
    // 顶层代码的执行依赖：缺一个就可能在某个 const 上中断，把 TDZ 留到用例里才炸
    URL,
    URLSearchParams,
    setTimeout: noop,
    clearTimeout: noop,
    setInterval: noop,
    clearInterval: noop,
    requestAnimationFrame: noop,
    cancelAnimationFrame: noop,
    fetch: () => new Promise(() => {}), // 永挂：不发请求，也不让 await 立刻往下走
    document,
    location: { href: "http://localhost/", search: "", pathname: "/", hash: "" },
    navigator: { userAgent: "node" },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    Event,
    CustomEvent,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  // **顺序固定**：模块先、app.js 后（与 index.html 的 <script> 顺序一致）。
  // 默认预载 pages-view.js：app.js 现在真的调 window.PagesView，不载就是 undefined.renderPageSetup。
  // 刀 B 起 page-confirm.js 也要预载：pages 经 app.js 的转发器调 `injected.pageSetupStats()`，
  // 不载这个模块，转发器会返回 undefined（renderPageSetup 读 stats.body 直接 TypeError）。
  ctx.__preloadedModules = preloadModules(
    ctx,
    options.modules || ["pages-view.js", "page-confirm.js"],
    options.moduleDir || STATIC_DIR,
  );
  vm.runInContext(src, ctx, { filename: String(appPath) });

  // 自检：本文件要用的函数必须真的存在，别让用例在 undefined 上做无意义的断言。
  // 用 `require` 指定：对历史版本跑单个测试文件时，那个版本可能还没有别的函数
  // （例如 7b803c5 有 computeCharSpans、还没有 readingDiffUnits）。
  // 默认只要 `computeCharSpans`：`readingDiffUnits` 已在 L11 搬进 reading-view.js，
  // 纯函数单测改从 `load-reading-view.mjs` 拿（模块只露 6 个导出，R8 不许为测试加口子）。
  // **app.js 载入后重 init 一次模块**：模块先载、app.js 后跑，模块首次 init 拿到的 deps
  // 是 () => undefined 的桩（那时 app.js 顶层绑定还不存在）。这里用 appModuleDeps 把真实顶层
  // 绑定重做一遍注入——同一个 injected 状态源，不重建实例。所有走 loadApp 的测试统一生效，
  // 不再让每条测试自己调（Builder 预演 showView('merge') 红在 injected.visiblePageNos 就是这原因）。
  for (const entry of ctx.__preloadedModules || []) {
    if (!entry || !entry.loaded) continue;
    const dir = options.moduleDir || STATIC_DIR;
    const moduleSource = readFileSync(join(dir, entry.name), "utf8");
    const mod = ctx[entry.api];
    if (mod && typeof mod.init === "function") mod.init(appModuleDeps(ctx, moduleSource));
  }

  for (const name of options.require || ["computeCharSpans"]) {
    if (typeof ctx[name] !== "function") {
      throw new Error(`load-app: ctx.${name} 不是函数——加载假设失效了，先查 app.js 的开头/结尾结构`);
    }
  }
  return ctx;
}

/**
 * 在**同一个上下文里**再执行一段脚本——用来给模块级状态打桩。
 *
 * 为什么需要：`loadApp` 返回的 ctx 上取不到顶层 `let`/`const`（它们在全局词法环境里），
 * 但同一个 context 里后续执行的脚本**能看见并赋值**它们（顶层 `let` 是可写的）。
 * 所以 `runInApp(ctx, "readingMarks = new Map([])")` 可以打桩。
 *
 * 边界：
 * - 顶层 `let`/`var` → 可以整个重新赋值；
 * - 顶层 `const`（如 `const el = (id) => document.getElementById(id)`）→ 改不了，
 *   但它们**用到的东西**可以改（例如改 `document.getElementById` 的返回值）；
 * - 顶层函数声明（会成为全局对象属性）可以直接 `ctx.fn = ...` 覆盖。
 */
export function runInApp(ctx, code) {
  return vm.runInContext(code, ctx, { filename: "stub.js" });
}

/**
 * **用 app.js 里的真实绑定**给视图模块重做一次 `init(deps)`。
 *
 * 为什么需要（刀 4 起）：模块经 `injected.X` 读 app.js 的顶层绑定，而 `loadApp` 是
 * 「先载模块、后载 app.js」——`preloadModules` 里那次 init 拿到的是 `() => undefined` 桩。
 * 函数搬进模块后，测试要观察真实行为，就得在 app.js 载入之后用真绑定再 init 一次。
 *
 * 与 `preloadModules` 的区别：**不重跑模块源码**（不新建第二个模块实例），只换 deps。
 * 模块的 `init` 是 `Object.assign({}, injected, deps)`，所以不会出现「两份状态」。
 *
 * 取值顺序：同上下文里的同名顶层绑定 → 找不到就按 getter/setter 形态合成
 * （`getX` → `() => X`、`setX` → 写 `x`）→ 仍不行就给 `() => undefined` 桩（与旧行为一致）。
 */
export function appModuleDeps(ctx, source) {
  const names = [...new Set([...String(source).matchAll(/injected\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  const read = (expr) => {
    try {
      return vm.runInContext(expr, ctx);
    } catch {
      return undefined;
    }
  };
  const write = (state, value) => {
    ctx.__b2tAppValue = value;
    try {
      vm.runInContext(`${state} = __b2tAppValue`, ctx);
    } catch {
      /* 该状态不在顶层（或不可写）：保持原值，不抛 */
    }
  };
  const deps = {};
  for (const name of names) {
    if (name === "el") {
      deps[name] = (id) => ctx.document.getElementById(id);
      continue;
    }
    const value = read(name);
    if (typeof value === "function") {
      deps[name] = value;
      continue;
    }
    if (value !== undefined && value !== null) {
      deps[name] = value;
      continue;
    }
    // 刀 A/B 起：有些键的真身已搬进服务模块（app.js 只在 deps 里留转发器）。这里按服务模块接口面再找一次，
    // 找不到才给 `() => undefined` 桩——否则 pages-view 会对着 undefined 崩（renderPageSetup 读 stats.body）。
    const serviceApi = ["PageConfirm", "QualityStats"].find(
      (api) => ctx[api] && typeof ctx[api][name] === "function",
    );
    if (serviceApi) {
      deps[name] = (...args) => ctx[serviceApi][name](...args);
      continue;
    }
    const rest = name.length > 3 ? name[3].toLowerCase() + name.slice(4) : "";
    if (name.startsWith("get") && rest && read(`typeof ${rest}`) !== "undefined") {
      deps[name] = () => read(rest);
      continue;
    }
    if (name.startsWith("set") && rest && read(`typeof ${rest}`) !== "undefined") {
      deps[name] = (next) => {
        write(rest, next);
        return next;
      };
      continue;
    }
    deps[name] = () => undefined;
  }
  return deps;
}
