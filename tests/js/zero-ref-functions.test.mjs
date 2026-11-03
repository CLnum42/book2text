// 「全仓 0 引用的顶层函数」判据（2026-11-03，DevLead 派；补旧闸 ② 的洞）。
//
// 旧闸 ②（`boundary.test.mjs` 的「刀 11 闸②」）判的是同一个问题，但口径有三处让它漏：
//   ① 模块面只扫 `*-view.js` —— 服务模块（page-detail-editor / margin-data / page-media /
//      page-grid / split-batch-panel / suggestion-flow / structure-tools / collab / page-tile …）
//      一个都不在扫描面上；
//   ② **tests 的文本也算引用** —— 这是真洞：`tests/integration/test_ui_assets.py` 里一句
//      `assert "function updateReviewTreeAfterAck(" in script`（断言这个函数**存在**）就被算成
//      "被引用了"，于是一个产品里 0 调用的死函数被自己的存在性断言保活到片 4。**断言存在 ≠ 使用**。
//   ③ 注释与字符串也算引用 —— 一句说明就能把死函数判绿。
//
// 本判据的口径（DevLead 2026-11-03）：
//   扫描面 = app.js + **所有** static/*.js；计数用 `stripCommentsAndStrings`（注释/字符串/正则都不算），
//   **tests 不算引用**（断言存在不是调用）；`app.js` 里只剩定义行 = 0 引用。
//   0 引用 ⇒ 红，除非在具名豁免表里且带**已登记的刀号**（`knife-registry.mjs`，pending 也算）。
//
// 为什么豁免也要带刀号：不带到期点的豁免就是一张"永远不会删"的名单——登记表的口径是
// 「未登记刀号 = 没有到期点」（刀 12 就是这么来的）。
//
// 关于 `...fn(` 这个形态（DevLead 报「continuationEvidenceRow 0 引用」的那次）：
// 那两次调用是 `...continuationEvidenceRow(...)`（展开调用）。把 `...f(` 当成成员访问 `.f` 跳过的
// 扫描器会报 0 引用——**函数是活的，是扫描器瞎了**。所以下面自检里专门有一条展开调用必须算引用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { codeOnly, stripPreservingTemplateExpressions } from "./static-scan.mjs";
import { isRegisteredKnife } from "./knife-registry.mjs";

const STATIC_DIR = process.env.B2T_STATIC_DIR
  || fileURLToPath(new URL("../../backend/book2text/static/", import.meta.url));

/**
 * 具名豁免表：每个条目必须带**已登记的刀号**（到期点），且指向的函数必须真的还是 0 引用。
 * 表项过期（函数被删了 / 又有引用了）⇒ 红——豁免表只许沿着「删掉它」的方向收缩。
 */
export const ZERO_REF_EXEMPTIONS = [
  // 现树一条都没有（片 4 删掉 updateReviewTreeAfterAck 之后归零）。加条目要同时登记刀号。
];

/** 顶层 function 声明：`^(async )?function name(`（一行的开头，顶格）。 */
function topLevelFunctionNames(appSource) {
  const code = codeOnly(appSource || "");
  return [...code.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
}

/**
 * 一次扫描的「标识符 → 出现次数」直方图（定义行本身也算一次，调用方记得减掉）。
 *
 * **必须用保留模板 `${…}` 插值的那把尺子**（不是 `stripCommentsAndStrings`）：本仓大量调用写在
 * 模板里，例如 `${humanBytes(item.size)}`。整段模板一起抹掉，这些调用就隐形了 —— 第一版正是
 * 这样一次报出 6 个假死代码（humanBytes / escapeHtml / divergenceSummary / lockStampText /
 * lockSpanText / taskProgressPercent，全部其实都在用）。字符串里的同名文字仍不算引用（那是字符串）。
 *
 * 为什么做成直方图而不是「每个名字跑一遍全文正则」：253 个函数 × 21k 行 = 十几秒，
 * 一次扫描是毫秒级（实测整条判据从 8.7s 降到 0.2s）。
 */
function identifierCounts(source) {
  const stripped = stripPreservingTemplateExpressions(source || "");
  const counts = new Map();
  for (const match of stripped.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)(?![\w$])/g)) {
    counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  return counts;
}

/**
 * 判据内核。返回 `{ problems, names, dead }`：
 * - `problems`：0 引用且没有有效豁免的函数 / 豁免表本身的问题；
 * - `names`：扫到的顶层函数数（防空转用：一个都没扫到 = 扫描路径错了）；
 * - `dead`：全仓 0 引用的函数名（含被豁免的，报告口径用）。
 *
 * fail-closed：
 * - 扫不到 app.js 的顶层函数 ⇒ 红（路径写错时不许静默放过）；
 * - 扫描面一个模块都没有 ⇒ 红（"全仓"退化成"只看 app"时会多报假红）；
 * - 豁免表项缺刀号 / 刀号未登记 / 函数不存在 / 已不再是 0 引用 ⇒ 红。
 */
export function zeroRefProblems({ appSource, moduleSources = [], exemptions = [], knifeRegistered = isRegisteredKnife }) {
  if (!Array.isArray(moduleSources) || moduleSources.length === 0) {
    return { problems: ["扫描面里一个 static 模块都没有——「全仓 0 引用」会退化成「只看 app.js」，先查路径"], names: 0, dead: [] };
  }
  const names = topLevelFunctionNames(appSource);
  if (names.length === 0) {
    return { problems: ["app.js 里一个顶层 function 都没扫到——路径或正则写错了"], names: 0, dead: [] };
  }
  const appCounts = identifierCounts(appSource);
  const moduleCounts = identifierCounts(moduleSources.join("\n"));
  const dead = names.filter((name) => (appCounts.get(name) || 0) <= 1 && !moduleCounts.get(name));

  const problems = [];
  const exempt = new Map();
  for (const entry of exemptions) {
    if (!entry || typeof entry.name !== "string") {
      problems.push("豁免表里有一项没有 name——不许用空条目占位");
      continue;
    }
    if (!Number.isFinite(Number(entry.knife)) || !knifeRegistered(entry.knife)) {
      problems.push(`豁免项 ${entry.name} 的刀号 ${entry.knife} 不在 knife-registry 里——没有到期点的豁免等于永远不删`);
      continue;
    }
    if (!names.includes(entry.name)) {
      problems.push(`豁免项 ${entry.name} 指向的函数在 app.js 顶层不存在——表过期了，删掉这一项`);
      continue;
    }
    if (!dead.includes(entry.name)) {
      problems.push(`豁免项 ${entry.name} 已经不是 0 引用（有人用上了它）——把这一项从豁免表里删掉`);
      continue;
    }
    exempt.set(entry.name, entry);
  }
  for (const name of dead) {
    if (exempt.has(name)) continue;
    problems.push(`app.js 顶层函数 \`${name}\` 在全仓（app.js + 所有 static/*.js）0 引用——死代码，删掉或接上调用`);
  }
  return { problems, names: names.length, dead };
}

const readStatic = () => {
  const appSource = readFileSync(join(STATIC_DIR, "app.js"), "utf8");
  const modules = readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith(".js") && name !== "app.js")
    .sort()
    .map((name) => readFileSync(join(STATIC_DIR, name), "utf8"));
  return { appSource, modules };
};

test("全仓 0 引用的顶层函数必须删掉（或带到期刀号豁免）", () => {
  const { appSource, modules } = readStatic();
  const { problems, names, dead } = zeroRefProblems({ appSource, moduleSources: modules, exemptions: ZERO_REF_EXEMPTIONS });
  assert.deepEqual(problems, [], problems.join("\n"));
  console.log(`ℹ 0 引用判据：扫了 ${names} 个顶层函数 · 死代码 ${dead.length} 个 · 模块面 ${modules.length} 个文件`);
  assert.ok(names > 100, `只扫到 ${names} 个顶层函数——扫描面像是错的`);
});

test("自检：展开调用 `...fn(` 算引用（DevLead 报「continuationEvidenceRow 0 引用」的那次要能复现）", () => {
  // 现树 app.js:5003 的真实形态：`...continuationEvidenceRow("上页末行", …)`。
  // 把 `...f(` 当成成员访问 `.f` 跳过的扫描器会报 0 引用——那是扫描器瞎了，不是死代码。
  const appSource = [
    "function spreadCalled() {",
    "  return [1];",
    "}",
    "function caller() {",
    "  return [...spreadCalled()];",
    "}",
    "caller();",
  ].join("\n");
  const { dead } = zeroRefProblems({ appSource, moduleSources: ["// 空模块"], exemptions: [] });
  assert.ok(!dead.includes("spreadCalled"), "展开调用 `...fn(` 没被算成引用——这正是误报 0 引用的形态");
});

test("自检：只在注释 / 字符串里提到，不算引用；只被测试断言存在，也不算引用", () => {
  // 字符串形态 = `assert "function orphan() {" in script` 那种「断言存在」的测试（片 4 之前
  // updateReviewTreeAfterAck 就是被它保活的）。tests 根本不进扫描面，这里再钉一次口径。
  const appSource = [
    "function orphan() {",
    "  return 1;",
    "}",
    "const demo = \"orphan() 的用法以后再写\";",
    "// orphan 上面这句注释不算引用",
  ].join("\n");
  const { problems, dead } = zeroRefProblems({ appSource, moduleSources: ["const x = 1;"], exemptions: [] });
  assert.ok(dead.includes("orphan"), `孤儿函数没判死：${dead.join(",")}`);
  assert.ok(problems.some((one) => one.includes("orphan")), "孤儿函数必须红并点名");
});

test("自检：模块面里的真调用算引用（服务模块也算，不只看 *-view.js）", () => {
  const appSource = [
    "function usedByServiceModule() {",
    "  return 2;",
    "}",
  ].join("\n");
  const ok = zeroRefProblems({
    appSource,
    moduleSources: ["margin-data.js 的内容", "const v = usedByServiceModule();"],
    exemptions: [],
  });
  assert.deepEqual(ok.problems, [], `服务模块里的调用没算引用：${ok.problems.join("；")}`);
});

test("自检：豁免要带已登记刀号；表项过期要红", () => {
  const appSource = [
    "function deadA() { return 1; }",
    "function deadB() { return 2; }",
    "function alive() { return deadA(); }",
  ].join("\n");
  // alive 必须真的被引用，否则它自己也是死代码（夹具第一版就错在这：豁免 deadB 之后仍红在 alive）
  const modules = ["const x = alive();"];
  const base = { appSource, moduleSources: modules };

  // 带已登记刀号（12 是 pending，pending 也算登记）⇒ 绿
  assert.deepEqual(
    zeroRefProblems({ ...base, exemptions: [{ name: "deadB", knife: 12 }], knifeRegistered: (n) => [11, 12].includes(Number(n)) }).problems,
    [],
    "带已登记刀号的豁免被误判红",
  );
  // 刀号未登记 ⇒ 红
  const badKnife = zeroRefProblems({ ...base, exemptions: [{ name: "deadB", knife: 99 }], knifeRegistered: (n) => [11, 12].includes(Number(n)) });
  assert.ok(badKnife.problems.some((one) => one.includes("99")), `未登记刀号的豁免没红：${badKnife.problems.join("；")}`);
  // 缺刀号 ⇒ 红
  const noKnife = zeroRefProblems({ ...base, exemptions: [{ name: "deadB" }], knifeRegistered: () => true });
  assert.ok(noKnife.problems.some((one) => one.includes("没有到期点") || one.includes("不在 knife-registry")),
    `缺刀号的豁免没红：${noKnife.problems.join("；")}`);
  // 函数不存在 ⇒ 红（表过期）
  const gone = zeroRefProblems({ ...base, exemptions: [{ name: "noSuchFn", knife: 12 }], knifeRegistered: () => true });
  assert.ok(gone.problems.some((one) => one.includes("不存在")), `指向不存在函数的豁免没红：${gone.problems.join("；")}`);
  // 已经有引用了 ⇒ 红（豁免该撤）
  const revived = zeroRefProblems({ ...base, exemptions: [{ name: "alive", knife: 12 }], knifeRegistered: () => true });
  assert.ok(revived.problems.some((one) => one.includes("已经不是 0 引用")), `已有引用的豁免没红：${revived.problems.join("；")}`);
});

test("fail-closed：没有模块 / 没有顶层函数 ⇒ 红", () => {
  const noModules = zeroRefProblems({ appSource: "function a() {}", moduleSources: [], exemptions: [] });
  assert.equal(noModules.problems.length, 1);
  const noFunctions = zeroRefProblems({ appSource: "const a = 1;", moduleSources: ["const b = 2;"], exemptions: [] });
  assert.equal(noFunctions.problems.length, 1);
});

test("真树变异：把一处调用删掉（改成注释）⇒ 该函数必须红并点名", () => {
  // 拿真实 app.js：挑一个**只被调用一次**的顶层函数，把它那处调用注释掉，判据必须点名它。
  const { appSource, modules } = readStatic();
  const { dead } = zeroRefProblems({ appSource, moduleSources: modules, exemptions: [] });
  assert.deepEqual(dead, [], "现树本来就有死代码——先看上面的真树用例");
  const names = topLevelFunctionNames(appSource);
  const appCounts = identifierCounts(appSource);
  const moduleCounts = identifierCounts(modules.join("\n"));
  const counts = names
    .map((name) => ({ name, refs: (appCounts.get(name) || 0) - 1 + (moduleCounts.get(name) || 0) }))
    .filter((row) => row.refs === 1);
  assert.ok(counts.length > 0, "找不到「只被引用一次」的函数，变异没法做");
  const target = counts[0].name;
  // 把那唯一一处调用整行注释掉（只动这一行，其余字节不变）
  const lines = appSource.split("\n");
  const callLine = lines.findIndex((line) => new RegExp(`\\b${target}\\s*\\(`).test(line)
    && !new RegExp(`function\\s+${target}\\s*\\(`).test(line));
  assert.ok(callLine >= 0, `找不到 ${target} 的调用行`);
  lines[callLine] = `// ${lines[callLine]}`;
  const mutated = zeroRefProblems({ appSource: lines.join("\n"), moduleSources: modules, exemptions: [] });
  assert.ok(mutated.dead.includes(target), `删掉唯一调用后 \`${target}\` 没被判死（变异没咬住）`);
});
