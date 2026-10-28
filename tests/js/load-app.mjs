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
import { readFileSync } from "node:fs";
import vm from "node:vm";

const DEFAULT_APP_PATH = new URL("../../backend/book2text/static/app.js", import.meta.url);

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
  vm.runInContext(src, ctx, { filename: String(appPath) });

  // 自检：本文件要用的函数必须真的存在，别让用例在 undefined 上做无意义的断言。
  // 用 `require` 指定：对历史版本跑单个测试文件时，那个版本可能还没有别的函数
  // （例如 7b803c5 有 computeCharSpans、还没有 readingDiffUnits）。
  for (const name of options.require || ["readingDiffUnits"]) {
    if (typeof ctx[name] !== "function") {
      throw new Error(`load-app: ctx.${name} 不是函数——加载假设失效了，先查 app.js 的开头/结尾结构`);
    }
  }
  return ctx;
}
