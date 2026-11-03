// 前端单元测试入口：node tests/js/run.mjs
//
// 只用 Node 内置能力（node:test / node:assert / node:vm），不装任何 npm 依赖，不需要 package.json 依赖，
// 也不引入构建步骤（D-046：前端不做构建）。
//
// 退出码：全绿 0，有用例失败 1。
// 环境变量：B2T_APP_JS 可指定被测 app.js 路径，用于对历史版本跑同一批用例（验证用例真的会红）。
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
/**
 * 回读「绕过提交闸」的留痕（§20.9 ⑬）。
 *
 * `pre-commit` 红则拒提交；`--no-verify` 能跳，但 `post-commit` 会往
 * `.git/b2t-gate-bypass.log` 追加一行（`时间 \t sha \t TAG \t 理由 \t 标题`）。
 * **没有这条回读，"留痕"只是留给自己看**——所以每次跑套件都把它报出来。
 *
 * 只 warn 不红：绕过是有正当用途的（例如被测文档有缺陷、而修复要走别人的回合），
 * 把"绕过"本身当失败会逼人把闸拆掉。判据是"有没有理由"，不是"有没有绕过"。
 */
function reportBypassLog(days = 7) {
  const logPath = fileURLToPath(new URL("../../.git/b2t-gate-bypass.log", import.meta.url));
  let text;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return;   // 没有日志（新克隆 / CI）：正常，不吵
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = text
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter((cells) => cells.length >= 5)
    .filter((cells) => {
      const at = Date.parse(cells[0].replace(" ", "T"));
      return Number.isFinite(at) && at >= cutoff;
    });
  if (rows.length === 0) return;
  const noReason = rows.filter((cells) => cells[2] === "NO-REASON").length;
  console.log(`\n⚠ 近 ${days} 天有 ${rows.length} 笔提交绕过了 pre-commit 闸（其中 ${noReason} 笔没写理由）：`);
  for (const [at, sha, tag, reason, subject] of rows) {
    console.log(`  ${at}  ${sha}  ${tag}  ${reason}  ${subject}`);
  }
  console.log("  （绕过不阻塞；但 NO-REASON 的要在提交信息里补 Bypass-Reason: <为什么>）");
}

reportBypassLog();

const TEST_FILES = [
  ["reading-diff-units", () => import("./reading-diff-units.test.mjs")],
  ["compute-char-spans", () => import("./compute-char-spans.test.mjs")],
  ["reading-view-behavior", () => import("./reading-view-behavior.test.mjs")],
  ["recognition-target", () => import("./recognition-target.test.mjs")],
  ["index-view-behavior", () => import("./index-view-behavior.test.mjs")],
  ["page-tile", () => import("./page-tile.test.mjs")],
  ["step-timing", () => import("./step-timing.test.mjs")],
  ["merge-p0", () => import("./merge-p0.test.mjs")],
  ["review-ux-v3", () => import("./review-ux-v3.test.mjs")],
  ["docs-structure", () => import("./docs-structure.test.mjs")],
  ["boundary", () => import("./boundary.test.mjs")],
  ["pages-wire", () => import("./pages-wire.test.mjs")],
  ["pages-poll-guard", () => import("./pages-poll-guard.test.mjs")],
  ["pages-visibility", () => import("./pages-visibility.test.mjs")],
  ["margin-progress", () => import("./margin-progress.test.mjs")],
  ["overlay-registry-acid", () => import("./overlay-registry-acid.mjs")],
  ["export-panel", () => import("./export-panel.test.mjs")],
  ["suggestion-flow", () => import("./suggestion-flow.test.mjs")],
  ["collab", () => import("./collab.test.mjs")],
  ["page-index", () => import("./page-index.test.mjs")],
  ["structure-tools", () => import("./structure-tools.test.mjs")],
  ["page-detail-editor-state", () => import("./page-detail-editor-state.test.mjs")],
  ["review-tree", () => import("./review-tree.test.mjs")],
  ["route-contract", () => import("./route-contract.test.mjs")],
  ["module-wiring", () => import("./module-wiring.test.mjs")],
  ["detail-visibility", () => import("./detail-visibility.test.mjs")],
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
