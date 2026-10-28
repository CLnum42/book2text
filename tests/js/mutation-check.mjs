#!/usr/bin/env node
// A4 变异红（§18.2 闸 A）——一条命令给结论。
//
// 判据（DevLead 写进 §18.2，Chief 定案）：
//   两遍、同一份文件、同一个 base worktree。
//   ① 把新增的特征测试拷进 base 树，**不插变异**跑一遍 → 必须绿（这就是 A2 回放：它锁的是旧行为）
//   ② 在 base 树上给**被调用那一端**（callee）的函数体首行插一行 throw（临时，不进提交），
//      跑同一份测试 → 必须红（它真的依赖这条边的效果）
//   ③ 优先打 callee，不打 caller：打 caller 只能证明"测试跑到了这个函数"。
//
// 用法（在仓库任意位置都可以跑）：
//   node tests/js/mutation-check.mjs tests/js/xx.test.mjs --callee ensureReadingMarksWindow
//   node tests/js/mutation-check.mjs tests/js/xx.test.mjs --callee updateReadingPage --base ring-break-base
//   node tests/js/mutation-check.mjs tests/js/xx.test.mjs --callee foo --with tests/js/helper.mjs --keep
//
// 参数：
//   --callee <name>   base 树里被插入 throw 的函数名（必填；找不到 = 直接报错，不猜）
//   --base <ref>      base 的 ref，默认 $B2T_BASE_REF 或 ring-break-base（tag 由 DevLead 维护）
//   --worktree <dir>  复用已有的 base worktree（默认 $B2T_BASE_WORKTREE；都没有就临时建一个）
//   --with <file>     一起拷进 base 树的辅助文件，可重复
//   --keep            跑完保留临时 worktree（排查用）
//   --force           允许覆盖 base 树里已存在的同名文件（默认拒绝：那说明测试不是"新增"的）
//
// 退出码：A2 绿 + A4 红 = 0；任何一遍不符合 = 1；参数/环境错误 = 2。
//
// 已知边界：
// - 只认 base 树里的 `function NAME(` / `const NAME = function` / `const NAME = (…) =>` 三种声明；
//   注入点找不到就报错退出，不退回 caller（退回要人写理由，脚本不替人决定）。
// - callee 被多个调用方共用、隔离不到这条边时，A4 会红——但红的原因可能是别的边，这时的结论
//   要人读（脚本只给"红/绿"，判"是不是这条边"仍归 DevLead 验收）。
// - 表达式体箭头函数（`const f = () => x`，没有 `{}`）插不进语句，会直接报错；这类 callee 换名字或人工处理。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

function die(message, code = 2) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const positional = [];
const flags = { with: [] };
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const next = () => argv[++i];
  if (arg === "--callee") flags.callee = next();
  else if (arg === "--base") flags.base = next();
  else if (arg === "--worktree") flags.worktree = next();
  else if (arg === "--with") flags.with.push(next());
  else if (arg === "--keep") flags.keep = true;
  else if (arg === "--force") flags.force = true;
  else if (arg === "--help" || arg === "-h") flags.help = true;
  else if (arg.startsWith("-")) die(`未知参数：${arg}`);
  else positional.push(arg);
}

if (flags.help) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 30).join("\n"));
  process.exit(0);
}
if (positional.length !== 1) die("用法：node tests/js/mutation-check.mjs <测试文件> --callee <函数名> [--base <ref>]");
if (!flags.callee) die("缺 --callee：要插变异的是 base 树里被调用的那个函数，不是 caller");

const repoRoot = (() => {
  const out = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (out.status !== 0) die(`这里不是 git 仓库：${(out.stderr || "").trim()}`);
  return out.stdout.trim();
})();

const git = (args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

// ---------------------------------------------------------------- 参数与 base 树

const testFileArg = positional[0];
const testFileAbs = resolve(process.cwd(), testFileArg);
if (!existsSync(testFileAbs)) die(`找不到测试文件：${testFileArg}`);
const testFileRel = relative(repoRoot, testFileAbs);
if (testFileRel.startsWith("..") || isAbsolute(testFileRel)) die(`测试文件不在仓库里：${testFileArg}`);
if (!testFileRel.startsWith("tests/js/") || !testFileRel.endsWith(".test.mjs")) {
  die(`A4 只跑 tests/js/*.test.mjs，收到：${testFileRel}`);
}
const copyFiles = [testFileRel, ...flags.with.map((file) => {
  const abs = resolve(process.cwd(), file);
  const rel = relative(repoRoot, abs);
  if (!existsSync(abs) || rel.startsWith("..") || isAbsolute(rel)) die(`--with 文件不在仓库里：${file}`);
  return rel;
})];

const baseRef = flags.base || process.env.B2T_BASE_REF || "ring-break-base";
const baseResolved = git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
if (baseResolved.status !== 0) {
  die([
    `找不到 base ref：${baseRef}`,
    "  破环阶段的 base 是 L4 结束时打的 tag（DevLead 维护）。还没打就先显式指定，例如：",
    "    node tests/js/mutation-check.mjs tests/js/xx.test.mjs --callee foo --base HEAD",
    "  但 tag 之前的 --base HEAD 只能验证脚本自身能跑，不能当 A4 证据（base 不对，回放没有意义）。",
  ].join("\n"));
}
const baseSha = baseResolved.stdout.trim();

const providedWorktree = flags.worktree || process.env.B2T_BASE_WORKTREE;
const createdWorktree = !providedWorktree;
// 注意：不能先 mkdtemp 再交给 git worktree add——目录已存在，git 会拒绝；这里只拼一个不存在的路径。
const worktree = providedWorktree || join(tmpdir(), `b2t-a4-${process.pid}-${Date.now()}`);

let exitCode = 2;
try {
  if (createdWorktree) {
    const add = git(["worktree", "add", "--detach", worktree, baseSha]);
    if (add.status !== 0) die(`git worktree add 失败：${(add.stderr || "").trim()}`);
  }
  exitCode = run();
} finally {
  // 用 exitCode + finally 而不是 process.exit：否则 worktree 会漏（今晚已经漏过 9 个 space 的前科）
  if (!flags.keep && createdWorktree) {
    git(["worktree", "remove", "--force", worktree]);
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  }
}
process.exitCode = exitCode;

// ---------------------------------------------------------------- 主流程

function run() {
  const appRel = "backend/book2text/static/app.js";
  const appAbs = join(worktree, appRel);
  if (!existsSync(appAbs)) {
    console.error(`✗ base 树里没有 ${appRel}（ref=${baseRef}）`);
    return 2;
  }

  // 拷贝测试文件（默认拒绝覆盖：base 树里已有同名文件说明它不是"新增测试"，A2 的对象就不对）
  for (const rel of copyFiles) {
    const src = join(repoRoot, rel);
    const dst = join(worktree, rel);
    if (existsSync(dst) && !flags.force) {
      if (readFileSync(dst, "utf8") !== readFileSync(src, "utf8")) {
        console.error(`✗ base 树里已有 ${rel} 且内容不同——A4 的判据是"新增测试在 base 树上回放"，这不是新增；\n`
          + "  确认要覆盖请加 --force（覆盖后这次结论不能当 A4 证据）");
        return 2;
      }
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }

  const runOnce = () => {
    const env = { ...process.env };
    // 外层 shell 可能把 app.js 指到了工作区版本；base 回放必须用 base 树自己的文件
    for (const key of ["B2T_APP_JS", "B2T_STATIC_DIR", "B2T_VIEW_JS", "B2T_BASE_REF", "B2T_BASE_WORKTREE"]) delete env[key];
    const res = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...copyFiles], {
      cwd: worktree,
      encoding: "utf8",
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    const out = `${res.stdout || ""}\n${res.stderr || ""}`;
    const num = (re) => {
      const m = out.match(re);
      return m ? Number(m[1]) : null;
    };
    return { status: res.status, pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), out };
  };

  console.log("A4 变异红（§18.2 闸 A）");
  console.log(`  base      ${baseRef} @ ${baseSha.slice(0, 7)}   worktree ${worktree}`);
  console.log(`  测试      ${testFileRel}`);
  console.log(`  callee    ${flags.callee}`);
  console.log("");

  // ① 回放：不插变异必须绿
  const before = runOnce();
  const a2 = before.status === 0 && (before.pass ?? 0) >= 1 && (before.fail ?? 0) === 0;
  console.log(`① 回放（不插变异）：pass ${before.pass ?? "?"} / fail ${before.fail ?? "?"} → ${a2 ? "绿 ✓（A2）" : "红 ✗"}`);
  if (!a2) {
    printTail(before.out);
    console.log("\n结论：A2 红——这份测试在 base 树上就不绿，它锁的不是旧行为。A4 不适用，先改测试。");
    return 1;
  }

  // ② 变异：callee 函数体首行插 throw
  const source = readFileSync(appAbs, "utf8");
  const mutation = insertThrow(source, flags.callee);
  if (!mutation) {
    console.error(`✗ base 树里找不到 ${flags.callee} 的函数体注入点（只认 function / const … = function / const … = (…) =>）。\n`
      + "  A4 不替人决定退回 caller：确认名字写对了，或由 DevLead 批准后手写退回理由。");
    return 2;
  }
  writeFileSync(appAbs, mutation.source);
  const after = runOnce();
  const a4 = after.status !== 0 && (after.fail ?? 0) >= 1;
  console.log(`② 变异（${flags.callee} 首行插 throw，app.js:${mutation.line}）：pass ${after.pass ?? "?"} / fail ${after.fail ?? "?"} → ${a4 ? "红 ✓（A4）" : "仍是绿 ✗"}`);

  if (!a4) {
    printTail(after.out);
    console.log(`\n结论：假锁——插了 throw 测试还是绿，说明它没依赖 ${flags.callee}。单列报，这条边不算算完。`);
    return 1;
  }

  console.log(`\n结论：A2 绿 + A4 红 → ${testFileRel} 锁的是 ${flags.callee} 这条边的可观察效果（不是外壳调度）。`);
  if (flags.keep) console.log(`worktree 保留在 ${worktree}`);
  return 0;
}

// ---------------------------------------------------------------- 变异注入

/** 在 base 源码里给 callee 的函数体首行插一行 throw；返回 null 表示找不到注入点。 */
function insertThrow(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates = [
    new RegExp(`(?:async\\s+)?function\\s+${escaped}\\s*\\(`),
    new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s+)?function\\s*\\(`),
    new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(`),
  ];
  for (const re of candidates) {
    const match = re.exec(source);
    if (!match) continue;
    const hit = bodyBraceAfter(source, match.index + match[0].length - 1);
    if (!hit) continue;
    const line = source.slice(0, hit.index).split("\n").length;
    const lineStart = source.lastIndexOf("\n", hit.index) + 1;
    const indent = (source.slice(lineStart, hit.index).match(/^[ \t]*/) || [""])[0];
    const insert = `\n${indent}  throw new Error("A4 mutation: ${name}");`;
    const updated = source.slice(0, hit.index + 1) + insert + source.slice(hit.index + 1);
    return { source: updated, line };
  }
  return null;
}

/**
 * 从函数签名的 `(` 开始，跳过配对括号（默认参数里可能有 `{}`），返回函数体 `{` 的位置。
 * 也处理 `const f = a => {` 这种单参数箭头：先找 `=>`。
 */
function bodyBraceAfter(source, openParenIndex) {
  let index = openParenIndex;
  if (source[index] !== "(") {
    const arrow = source.indexOf("=>", index);
    if (arrow === -1) return null;
    const brace = source.indexOf("{", arrow + 2);
    return brace === -1 ? null : { index: brace };
  }
  let depth = 0;
  for (let k = index; k < source.length; k += 1) {
    if (source[k] === "(") depth += 1;
    else if (source[k] === ")") {
      depth -= 1;
      if (depth === 0) {
        index = k + 1;
        break;
      }
    }
  }
  const arrow = source.indexOf("=>", index);
  const brace = source.indexOf("{", index);
  if (brace === -1) return null;
  // 表达式体箭头函数（没有 `{`）插不进语句——返回 null 让调用方报错，别插到别处去
  if (arrow !== -1 && arrow < brace) return { index: brace };
  return { index: brace };
}

function printTail(output, lines = 25) {
  const all = output.trimEnd().split("\n");
  console.log(`\n—— 失败输出（末 ${lines} 行）——`);
  for (const line of all.slice(-lines)) console.log(`  ${line}`);
}
