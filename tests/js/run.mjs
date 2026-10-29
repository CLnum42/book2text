// 前端单元测试入口：node tests/js/run.mjs
//
// 只用 Node 内置能力（node:test / node:assert / node:vm），不装任何 npm 依赖，不需要 package.json 依赖，
// 也不引入构建步骤（D-046：前端不做构建）。
//
// 退出码：全绿 0，有用例失败 1。
// 环境变量：B2T_APP_JS 可指定被测 app.js 路径，用于对历史版本跑同一批用例（验证用例真的会红）。
import { test } from "node:test";

const startedAt = process.hrtime.bigint();

// 只报耗时和退出码，**不替 node:test 说"全绿"**：
// 之前用 beforeExit 判 process.exitCode，那时 node:test 还没写退出码，失败也报"全绿"。
process.on("exit", (code) => {
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
  console.log(`\n耗时 ${ms.toFixed(0)}ms，退出码 ${code}`);
});

// 可选参数：只跑某一个测试文件（对历史版本做定点复跑时用，例如
// `B2T_APP_JS=/tmp/app-7b803c5.js node tests/js/run.mjs compute-char-spans`
// ——那个版本还没有 readingDiffUnits，整套跑会在加载阶段就失败）。
const TEST_FILES = [
  ["reading-diff-units", () => import("./reading-diff-units.test.mjs")],
  ["compute-char-spans", () => import("./compute-char-spans.test.mjs")],
  ["reading-view-behavior", () => import("./reading-view-behavior.test.mjs")],
  ["index-view-behavior", () => import("./index-view-behavior.test.mjs")],
  ["boundary", () => import("./boundary.test.mjs")],
];
const selector = process.argv[2];
const selected = TEST_FILES.filter(([name]) => !selector || name.includes(selector));
if (!selected.length) {
  console.error(`没有匹配 ${selector} 的测试文件；可选：${TEST_FILES.map(([name]) => name).join(", ")}`);
  process.exit(2);
}
for (const [, load] of selected) await load();

// 显式引用一次，避免"文件没跑"和"跑了但全绿"看起来一样
if (typeof test !== "function") throw new Error("node:test 不可用");
