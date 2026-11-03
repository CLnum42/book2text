#!/usr/bin/env node
// 终局账本：**最终报告里每个数字的唯一可复算来源**（Chief 2026-11-03 派）。
//
// 一条命令出这些数，每项都标口径（口径不同 = 数字不同，这就是这份脚本存在的理由）：
//   app.js 行数 · app.js 顶层函数数 · static/*.js 文件数与总行数 · 挂 window.X = api 的模块数
//   node 条数与通过数 · pytest 条数 · registry 笔数与不合格数 · rules 条数与其中机检条数
//
// 用法：
//   node scripts/final-ledger.mjs                # 全跑（node 全量 + pytest + registry），约 3–4 分钟
//   node scripts/final-ledger.mjs --skip-tests   # 只算静态数（node/pytest 标「未跑」，不当 0）
//   node scripts/final-ledger.mjs --json         # 机读
//
// **读不出来就红**（exit 1）：某个数解析失败时打印「✖ 读不出来」，绝不用 0 冒充健康——
// 最终报告里一个假 0 比缺一项更糟。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// 复用测试侧那把"只用一把尺子"的剥注释器：本仓规则 #1 是「判据看代码 0，不看 grep 0」，
// 注释里写一句 `window.Baz = api` 不许算成模块（第一版就是被这句注释多算了 1 个）。
// 依赖方向：scripts → tests/js（static-scan 不反向依赖 scripts，无环）。
import { codeOnly } from "../tests/js/static-scan.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATIC_DIR = join(REPO_ROOT, "backend/book2text/static");
const RULES_FILE = join(REPO_ROOT, "docs/refactor/rules.md");

/** `wc -l` 等价：换行符个数（文件末尾没有换行时也按一行算）。 */
export function lineCount(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const newlines = (text.match(/\n/g) || []).length;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** 顶层函数声明数：`^(async )?function name(`（行首顶格，不认缩进的嵌套声明）。 */
export function topLevelFunctionCount(source) {
  return (String(source || "").match(/^(?:async )?function [A-Za-z_$][\w$]*\s*\(/gm) || []).length;
}

/** 挂 `window.X = api` 的模块文件数（口径：文件里出现 `window.<标识符> = api`）。 */
export function windowApiModuleCount(files) {
  return files.filter(({ source }) => /window\.[A-Za-z_$][\w$]*\s*=\s*api\b/.test(codeOnly(source))).length;
}

/** node 全量输出 → `{ tests, pass, fail, skipped }`；少一个数就返回 null（读不出来 ≠ 0）。 */
export function parseNodeTotals(text) {
  const pick = (label) => {
    const match = new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(String(text || ""));
    return match ? Number(match[1]) : null;
  };
  const out = { tests: pick("tests"), pass: pick("pass"), fail: pick("fail"), skipped: pick("skipped") };
  return Object.values(out).some((value) => value === null) ? null : out;
}

/** pytest `-q` 尾行 → `{ passed, failed, errors }`。 */
export function parsePytestTotals(text) {
  const source = String(text || "");
  const grab = (word) => {
    const match = new RegExp(`(\\d+) ${word}`).exec(source);
    return match ? Number(match[1]) : 0;
  };
  if (!/(\d+) passed/.test(source)) return null;
  return { passed: grab("passed"), failed: grab("failed"), errors: grab("error") };
}

/** contract-registry 输出 → `{ unregistered, commits }`（`N 笔不合格（base..HEAD（M 笔）…`）。 */
export function parseRegistryTotals(text) {
  const match = /(\d+)\s*笔不合格[^\n]*?（(\d+)\s*笔）/.exec(String(text || ""));
  if (!match) return null;
  return { unregistered: Number(match[1]), commits: Number(match[2]) };
}

/**
 * rules.md 的规则表 → `{ total, machine }`。
 * 口径：只数**第一格是纯数字**的行（表头/分隔行/正文行都不算）；
 * 「机检」= 最后一格（状态）里出现「已机检」——人工判定、待提交都算人工。
 */
export function parseRulesTable(text) {
  const rows = String(text || "").split("\n").filter((line) => line.trimStart().startsWith("|"));
  const out = [];
  for (const row of rows) {
    const cells = row.split("|").map((cell) => cell.trim());
    // cells[0] 是行首的空格段；cells[1] = #，cells[2] = 规则…cells[cells.length-2] = 状态
    if (!/^\d+$/.test(cells[1] || "")) continue;
    const status = cells[cells.length - 2] || "";
    out.push({ n: Number(cells[1]), machine: status.includes("已机检"), status });
  }
  if (out.length === 0) return null;
  return { total: out.length, machine: out.filter((row) => row.machine).length, rows: out };
}

/** 跑一条命令并收 stdout+stderr（失败也返回，让解析器判"读不出来"）。 */
function run(command, args, env = {}) {
  try {
    return execFileSync(command, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    return `${error.stdout || ""}\n${error.stderr || ""}`;
  }
}

function staticNumbers() {
  const appPath = join(STATIC_DIR, "app.js");
  if (!existsSync(appPath)) return { problem: `找不到 ${appPath}` };
  const app = readFileSync(appPath, "utf8");
  const files = readdirSync(STATIC_DIR).filter((name) => name.endsWith(".js")).sort()
    .map((name) => ({ name, source: readFileSync(join(STATIC_DIR, name), "utf8") }));
  return {
    appLines: lineCount(app),
    appFunctions: topLevelFunctionCount(app),
    staticFiles: files.length,
    staticLines: files.reduce((sum, file) => sum + lineCount(file.source), 0),
    windowApiModules: windowApiModuleCount(files.filter((file) => file.name !== "app.js")),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const skipTests = argv.includes("--skip-tests");
  const asJson = argv.includes("--json");
  const problems = [];

  const statics = staticNumbers();
  if (statics.problem) problems.push(statics.problem);

  let node = null;
  let pytest = null;
  let registry = null;
  if (!skipTests) {
    node = parseNodeTotals(run(process.execPath, ["tests/js/run.mjs"]));
    if (!node) problems.push("node 全量：输出里读不到 tests/pass/fail/skipped");
    pytest = parsePytestTotals(run(".venv/bin/python", ["-m", "pytest", "-q"], {
      PYTHONPATH: join(REPO_ROOT, "backend"),
    }));
    if (!pytest) problems.push("pytest：输出里读不到 passed");
  } else {
    node = { tests: null, pass: null, fail: null, skipped: null };
    pytest = { passed: null, failed: null, errors: null };
  }
  registry = parseRegistryTotals(run(process.execPath, ["tests/js/contract-registry.mjs", "--strict", "--allow-transitional-base"]));
  if (!registry) problems.push("registry：输出里读不到「N 笔不合格（…（M 笔）」");

  const rulesText = existsSync(RULES_FILE) ? readFileSync(RULES_FILE, "utf8") : "";
  const rules = parseRulesTable(rulesText);
  if (!rules) problems.push(`rules：${RULES_FILE} 里没解析出一行规则`);

  const ledger = {
    appLines: statics.appLines, appFunctions: statics.appFunctions,
    staticFiles: statics.staticFiles, staticLines: statics.staticLines,
    windowApiModules: statics.windowApiModules,
    node, pytest, registry,
    rules: rules && { total: rules.total, machine: rules.machine },
    problems,
  };

  if (asJson) {
    console.log(JSON.stringify(ledger, null, 2));
    if (problems.length) process.exit(1);
    return;
  }

  const show = (value) => (value === null || value === undefined ? "未跑/读不出" : String(value));
  const rows = [
    ["app.js 行数", show(statics.appLines), "wc -l 等价：换行符个数（末尾无换行也算一行）"],
    ["app.js 顶层函数数", show(statics.appFunctions), "行首顶格的 `function name(`（含 async），不数缩进嵌套"],
    ["static/*.js 文件数", show(statics.staticFiles), "static/ 目录下所有 .js（含 app.js）"],
    ["static/*.js 总行数", show(statics.staticLines), "同上文件集合的行数之和（含 app.js）"],
    ["挂 window.X = api 的模块数", show(statics.windowApiModules), "文件里出现 `window.<名> = api`（不含 app.js）"],
    ["node 用例", node ? show(node.tests) : "未跑", "`node tests/js/run.mjs` 的 `ℹ tests`"],
    ["node 通过", node ? show(node.pass) : "未跑", "同上 `ℹ pass`（另报 fail / skipped）"],
    ["node fail / skipped", node ? `${show(node.fail)} / ${show(node.skipped)}` : "未跑", "同上"],
    ["pytest 通过", pytest ? show(pytest.passed) : "未跑", "`.venv/bin/python -m pytest -q` 尾行 `N passed`"],
    ["registry 笔数", registry ? show(registry.commits) : "读不出", "`contract-registry.mjs --strict` 的 `ring-break-base..HEAD（M 笔）`"],
    ["registry 不合格", registry ? show(registry.unregistered) : "读不出", "同上，前面那个「N 笔不合格」"],
    ["rules 条数", rules ? show(rules.total) : "读不出", "rules.md 表里第一格是纯数字的行"],
    ["rules 机检条数", rules ? show(rules.machine) : "读不出", "状态列含「已机检」的行（人工/待提交不算）"],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log(`终局账本（${new Date().toISOString().slice(0, 10)} · HEAD ${run("git", ["rev-parse", "--short", "HEAD"]).trim()}）`);
  for (const [label, value, basis] of rows) {
    console.log(`${label.padEnd(width, " ")}  ${String(value).padStart(8, " ")}   ← ${basis}`);
  }
  if (skipTests) console.log("\n（--skip-tests：node / pytest 两栏是「未跑」，不是 0）");
  if (problems.length) {
    console.error("\n✖ 下列数字读不出来（不许用 0 冒充）：");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
