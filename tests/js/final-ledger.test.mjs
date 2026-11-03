// 终局账本的判据：**每个数字都要能复算，且读不出来必须报"读不出"而不是 0**。
//
// 这份账本要给最终报告用，所以它的风险不是"算错一次"，而是"静默给个 0 / 给个旧数"：
//   · 解析器认不出新格式 ⇒ 少了那一栏，报告里就少一个数；
//   · 用 0 兜底 ⇒ 报告里写"pytest 0 passed"，比缺一项更糟。
// 所以这里逐项喂合成文本，并且专门断言"坏输入 ⇒ null"（fail-closed），再用真树核一遍数量级。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  lineCount,
  topLevelFunctionCount,
  windowApiModuleCount,
  parseNodeTotals,
  parsePytestTotals,
  parseRegistryTotals,
  parseRulesTable,
} from "../../scripts/final-ledger.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STATIC_DIR = join(REPO_ROOT, "backend/book2text/static");

test("行数口径：换行符个数（末尾无换行也算一行），空文件是 0", () => {
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\nb"), 2);
  assert.equal(lineCount(""), 0);
});

test("顶层函数口径：只数行首顶格，不数缩进嵌套 / 非函数", () => {
  const source = [
    "function topOne() {",
    "  function nested() {",
    "  }",
    "}",
    "async function topAsync() {",
    "}",
    "const notFn = function () {};",
  ].join("\n");
  assert.equal(topLevelFunctionCount(source), 2, "缩进的那个不算、函数表达式也不算");
});

test("window.X = api 的模块数：只认赋值形态，注释里提到不算（用真文件集合喂）", () => {
  const count = windowApiModuleCount([
    { source: "window.Foo = api;" },
    { source: "  window.Bar = api;" },
    { source: "// window.Baz = api; 这句是注释，别数" },
    { source: "window.Qux = { init() {} };" },
  ]);
  assert.equal(count, 2, `只该数两个真赋值，实际 ${count}`);
});

test("node / pytest / registry 解析：合成输出各解析一次", () => {
  const nodeOut = "ℹ tests 352\nℹ pass 347\nℹ fail 0\nℹ skipped 5\n耗时 32s，退出码 0\n";
  assert.deepEqual(parseNodeTotals(nodeOut), { tests: 352, pass: 347, fail: 0, skipped: 5 });
  assert.equal(parsePytestTotals("1042 passed, 1 warning in 146.19s (0:02:26)").passed, 1042);
  assert.deepEqual(parseRegistryTotals("0 笔不合格（ring-break-base..HEAD（643 笔）登记齐全）"), { unregistered: 0, commits: 643 });
  assert.deepEqual(parseRegistryTotals("3 条红灯（abc1234、def5678）——详情 node tests/js/contract-registry.mjs --strict"), null,
    "非 --strict 的摘要行解析不了就该返回 null（不许猜 commit 数）");
});

test("fail-closed：坏输入一律 null，不做 0 兜底", () => {
  assert.equal(parseNodeTotals("全部通过！"), null);
  assert.equal(parsePytestTotals("collected 0 items"), null);
  assert.equal(parseRegistryTotals(""), null);
  assert.equal(parseRulesTable("没有表格"), null);
});

test("rules 表：只数第一格是纯数字的行；机检只看状态格里的「已机检」", () => {
  const text = [
    "# 标题",
    "| # | 规则 | 判据 | 反例 | 状态 |",
    "|---|---|---|---|---|",
    "| 1 | 判据看代码 0 | 剥注释 | 例 | 已机检 |",
    "| 2 | 自检要能区分 | 喂坏 | 例 | 已机检（TestDev） |",
    "| 3 | 归属 | 人工看 | 例 | 人工：Architect 判 |",
    "| 28 | 根自己 | 已机检（dom-root-scope） | 例 | 待提交（工作区） |",
  ].join("\n");
  const rules = parseRulesTable(text);
  assert.equal(rules.total, 4);
  assert.equal(rules.machine, 2, "只有状态格写「已机检」的才算机检（判据格里提到机检但状态是待提交/人工的不算）");
});

test("真树核数量级：账本在现树上读得出合理的数（防路径/正则写错后静默给 0）", () => {
  const app = readFileSync(join(STATIC_DIR, "app.js"), "utf8");
  const files = readdirSync(STATIC_DIR).filter((name) => name.endsWith(".js"));
  assert.ok(lineCount(app) > 1000, `app.js 只有 ${lineCount(app)} 行——路径或读取写错了？`);
  assert.ok(topLevelFunctionCount(app) > 50, `app.js 顶层函数只数到 ${topLevelFunctionCount(app)} 个——正则写错了？`);
  assert.ok(files.length > 5, `static 下只数到 ${files.length} 个 .js——路径写错了？`);
});
