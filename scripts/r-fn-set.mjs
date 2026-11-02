#!/usr/bin/env node
// **app.js 顶层函数集合差集**：哪几个函数被搬走了、哪几个是新加的。
//
// 为什么要有它（2026-11-02）：每搬一刀都要回答"这刀到底移出几个函数"，而人肉数会错——
// 今晚就出现过"11 个"实为 10 个（把级联删的那个重复计了一次）。更糟的是**用 grep 数名字**：
// 注入键名（`loadAutoApplyStatus: (...args) => …`）、调用点、注释里的名字全会被算成"函数还在"，
// 于是"移出 16"能数成"移出 31"或"移出 0"，两个方向的错都出现过。
//
// 口径（写死在这里，别处不要再各写一套）：
//   · **判据是「代码里的定义」**：`^(async )?function NAME(`，行首锚定；
//   · 「移出」= 旧版本有定义、新版本**没有这个定义**（不是"名字还出现在某处"）；
//   · 每个移出的名字附一次「旧定义残留」判定：新版本里还能不能找到 `function NAME(` ——
//     能找到就是真残留（说明它没搬干净），要单独列出来，不能混进"已移出"里；
//   · `--criterion=grep` 是**故意留着当反例的**：它按"名字是否出现过"判，会把注入键名/调用点算进来。
//     自检拿它做对照，证明判据换了，结论就错了。
//
// 用法：
//   node scripts/r-fn-set.mjs <旧 sha> [新 sha]      # 新 sha 默认 HEAD
//   node scripts/r-fn-set.mjs --criterion=grep <旧 sha> [新 sha]
//   node scripts/r-fn-set.mjs --self-test
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP_REL = "backend/book2text/static/app.js";
const REPO = fileURLToPath(new URL("..", import.meta.url));

/** 从某个版本读 app.js（工作树版本用 `HEAD` 之外的特殊值 `worktree`）。 */
export function sourceAt(ref) {
  if (ref === "worktree") return readFileSync(`${REPO}${APP_REL}`, "utf8");
  return execFileSync("git", ["show", `${ref}:${APP_REL}`], { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** **定义口径**（正确）：行首锚定的函数声明。返回 Map<name, line>。 */
export function functionDefs(source) {
  const defs = new Map();
  String(source || "").split("\n").forEach((line, index) => {
    const match = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) defs.set(match[1], index + 1);
  });
  return defs;
}

/** **grep 口径**（故意留的反例）：源码里出现过的标识符都算。会把注入键名/调用点算进来。 */
export function allIdentifiers(source) {
  const names = new Map();
  String(source || "").split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (!names.has(match[0])) names.set(match[0], index + 1);
    }
  });
  return names;
}

/**
 * 差集：移出 = 旧有新无；新增 = 新有旧无。
 * 另外给每个移出的名字做一次「旧定义残留」判定（新版本里还找得到 `function NAME(` 吗）。
 */
export function diffFunctionSets({ oldSource, newSource, criterion = "def" }) {
  const pick = criterion === "grep" ? allIdentifiers : functionDefs;
  const before = pick(oldSource);
  const after = pick(newSource);
  const removed = [...before.keys()].filter((name) => !after.has(name)).map((name) => ({ name, oldLine: before.get(name) }));
  const added = [...after.keys()].filter((name) => !before.has(name)).map((name) => ({ name, newLine: after.get(name) }));
  const newDefs = functionDefs(newSource);
  const leftovers = removed.filter((item) => newDefs.has(item.name))
    .map((item) => ({ ...item, newLine: newDefs.get(item.name) }));
  return { removed, added, leftovers, criterion };
}

export function renderDiff(result, { oldRef, newRef }) {
  const lines = [];
  lines.push(`旧 ${oldRef} → 新 ${newRef}（判据：${result.criterion === "grep" ? "grep 名字（反例口径）" : "函数定义"}）`);
  lines.push(`移出 ${result.removed.length} 个：`);
  for (const item of result.removed) lines.push(`  - ${item.name.padEnd(34)} 旧定义 line ${item.oldLine}`);
  if (!result.removed.length) lines.push("  （无）");
  lines.push(`新增 ${result.added.length} 个：`);
  for (const item of result.added) lines.push(`  + ${item.name.padEnd(34)} 新定义 line ${item.newLine}`);
  if (!result.added.length) lines.push("  （无）");
  lines.push(`旧定义残留检查：${result.leftovers.length} 个`
    + `${result.leftovers.length ? "（下面这些名字在新版本里**还有函数定义**，说明没搬干净）：" : "（每个都真的没有函数定义了）"}`);
  for (const item of result.leftovers) lines.push(`  ! ${item.name} 新定义 line ${item.newLine}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- 自检

const SELF_OLD = "d31825e";     // 跨视图服务落地之后、回滚之前
const SELF_NEW = "79804b1";     // 跨视图刀回滚之后（今天已知事实：移出 16 / 新增 0）

function check(actual, expected, what) {
  if (actual !== expected) { console.error(`✖ ${what}：期望 ${expected}，实际 ${actual}`); return false; }
  console.log(`✔ ${what} → ${actual}`);
  return true;
}

export function selfTest() {
  let ok = true;
  let oldSource;
  let newSource;
  try {
    oldSource = sourceAt(SELF_OLD);
    newSource = sourceAt(SELF_NEW);
  } catch (error) {
    console.error(`✖ 自检要的两个历史版本读不到（${SELF_OLD} / ${SELF_NEW}）：${error.message}`);
    return false;
  }
  const real = diffFunctionSets({ oldSource, newSource });
  ok = check(real.removed.length, 16, `已知事实（${SELF_OLD}→${SELF_NEW}）移出函数数`) && ok;
  ok = check(real.added.length, 0, `已知事实新增函数数`) && ok;
  ok = check(real.leftovers.length, 0, "移出的名字在新版本里没有残留定义") && ok;
  // 抽查三个名字：既验证"数对了"，也验证"名字对"（只对数的判据会被整齐的错数骗过）
  // 注意 setMarginJudgementCheckbox 是 pages-view 的导出键、不是 app.js 顶层函数——别拿它当样本
  for (const name of ["renderMarginJudgementNotice", "refreshAfterTypeChanges", "dismissMarginJudgementNotice"]) {
    ok = check(real.removed.some((item) => item.name === name), true, `移出名单里有 ${name}`) && ok;
  }
  // 反例口径：grep 名字会把注入键/调用点算进来，得出不同的数（这条就是"判据换不得"的证据）
  const grep = diffFunctionSets({ oldSource, newSource, criterion: "grep" });
  if (grep.removed.length <= real.removed.length) {
    console.error(`✖ 反例口径没有变多：grep=${grep.removed.length}，定义=${real.removed.length}`);
    ok = false;
  } else {
    console.log(`✔ 反例口径（grep 名字）多算到 ${grep.removed.length} 个（定义口径 ${real.removed.length} 个）——`
      + `多出来的是注入键名/调用点，不是函数定义`);
  }
  const polluted = grep.removed.filter((item) => !functionDefs(oldSource).has(item.name)).length;
  if (polluted === 0) {
    console.error("✖ 反例口径没有多出任何非定义名字——那它就不是反例，这条自检失效了");
    ok = false;
  } else {
    console.log(`✔ 反例口径里 ${polluted} 个名字在旧版本根本不是顶层函数定义（这就是 grep 口径的错法）`);
  }
  return ok;
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  if (argv.includes("--self-test")) {
    const ok = selfTest();
    console.log(ok ? "\n自检通过。" : "\n自检失败。");
    process.exit(ok ? 0 : 1);
  }
  const criterionArg = argv.find((arg) => arg.startsWith("--criterion="));
  const criterion = criterionArg ? criterionArg.split("=")[1] : "def";
  const rest = argv.filter((arg) => !arg.startsWith("--"));
  const [oldRef, newRef = "HEAD"] = rest;
  if (!oldRef) {
    console.error("用法：node scripts/r-fn-set.mjs <旧 sha> [新 sha] ｜ --self-test");
    process.exit(2);
  }
  const result = diffFunctionSets({ oldSource: sourceAt(oldRef), newSource: sourceAt(newRef), criterion });
  console.log(renderDiff(result, { oldRef, newRef }));
}

if (process.argv[1] && process.argv[1].endsWith("r-fn-set.mjs")) main(process.argv.slice(2));
