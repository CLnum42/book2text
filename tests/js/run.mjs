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

// node:test 在本进程里注册用例，跑完自动设置退出码
await import("./reading-diff-units.test.mjs");

// 显式引用一次，避免"文件没跑"和"跑了但全绿"看起来一样
if (typeof test !== "function") throw new Error("node:test 不可用");
