// 「删掉 UI 入口必须在正文登记 Removed-UI」闸的判据（2026-11-05，Chief 派、DevLead 出判据）。
//
// 闸本身是两个入口共用的一份实现（`scripts/ui-removal-ledger.mjs`）：
//   commit-msg（staged + 这笔记正文）· pre-push（origin/main..<要推的 sha> 逐笔）。
// 本文件锁四件事，外加内核的单点自检：
//   ① 真历史样本 be61daf：删了 3 个 id、正文没登记 ⇒ 红，报错必须**点名 id 与行号**
//      （只断言"退出码非 0"不够——那正是"闸只证一部分就说通过"）；
//   ② 真历史样本 95dcdc7：id 从 app.js 搬进 review-tree.js ⇒ 绿（零误报）；
//   ③ 合成「同一笔删了 id="x" 又加回」⇒ 绿（删了又加回不算删）；
//   ④ 合成「正文登记了、但漏了一个 id」⇒ 红并点名漏的那个（比集合包含，不是"有这一行就行"）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// 追加 import 而不改既有那两行：非 test-contract 提交删 tests/js 的行会触发 A1b，
// 纯新增是唯一合规形态（同模块重复 import 在 ESM 里合法）。
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  evaluateRemoval,
  evaluateCommit,
  formatProblems,
  idsInText,
  quotedIds,
  registeredIds,
  parseDiff,
} from "../../scripts/ui-removal-ledger.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** 造一段 -U0 unified diff（只造判据要吃的部分）。 */
function diffOf({ file = "backend/book2text/static/index.html", removed = [], added = [] }) {
  const lines = [`--- a/${file}`, `+++ b/${file}`, `@@ -1,${removed.length} +1,${added.length} @@`];
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);
  return lines.join("\n") + "\n";
}

test("主入口判定：用带 `..` 的路径调用也必须真的跑（否则闸静默 exit 0 = 假绿）", () => {
  // 2026-11-05 实测的假绿：commit-msg 用 `$HOOKDIR/../ui-removal-ledger.mjs` 调进来，
  // 未归一化的 argv[1] 与 import.meta.url 不相等 ⇒ main() 不跑、退出码 0 —— 闸看起来装了，
  // 实际一次都没判过。无参数时正确行为是打印用法并 exit 2。
  const weirdPath = join(REPO_ROOT, "scripts", "..", "scripts", "ui-removal-ledger.mjs");
  const result = spawnSync(process.execPath, [weirdPath], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(result.status, 2, `带 .. 调用时没跑到 main()：status=${result.status} stderr=${(result.stderr || "").slice(0, 120)}`);
});

test("内核：三种 id 形态都认；动态拼接与 class 不判", () => {
  const ids = idsInText([
    '<div id="alpha">',
    'document.getElementById("beta")',
    'root.querySelector("#gamma")',
    'root.querySelectorAll("#delta")',
    // 以下是"不判"的三种：复合选择器（不是"某个 id"）、动态拼接（运行时才知道）、class
    'root.querySelectorAll("#epsilon .x")',
    'root.querySelector(`#${dynamicId}`)',
    '<div class="zeta">',
  ].join("\n"));
  assert.deepEqual([...ids].sort(), ["alpha", "beta", "gamma", "delta"].sort());
});

test("内核：登记行解析（多行合并、逗号/空白、容忍 # 前缀）", () => {
  const ids = registeredIds("标题\n\nRemoved-UI: a, b\n说明\nRemoved-UI: #c\n");
  assert.deepEqual([...ids].sort(), ["a", "b", "c"]);
});

test("内核：diff 行号按旧文件算（删除行在第 7、8 行就报 7、8）", () => {
  const diff = [
    "--- a/backend/book2text/static/index.html",
    "+++ b/backend/book2text/static/index.html",
    "@@ -7,2 +7,0 @@",
    '-<div id="one">',
    '-<div id="two">',
  ].join("\n");
  const { removed } = parseDiff(diff);
  assert.deepEqual(removed.map((row) => row.line), [7, 8]);
});

test("① 真历史样本 be61daf：删了 UI id 且正文没登记 ⇒ 红，点名 id 与行号", () => {
  const result = evaluateCommit("be61daf");
  const problems = formatProblems({ result, sha: "be61daf" });
  assert.equal(problems.length, 1, "应当报一条");
  assert.ok(result.missing.includes("confirm-dialog-check-input"), `没点名删除的 id：${result.missing.join(",")}`);
  assert.match(
    problems[0],
    /#confirm-dialog-check-input\s+backend\/book2text\/static\/index\.html:\d+/,
    `报错里没有「id + 文件 + 行号」：\n${problems[0]}`,
  );
  assert.match(problems[0], /修法：在提交正文加一行 `Removed-UI:/, "报错必须可行动（给出要加的那一行）");
});

test("② 真历史样本 95dcdc7：id 从 app.js 搬进 review-tree.js ⇒ 绿（零误报）", () => {
  const result = evaluateCommit("95dcdc7");
  assert.deepEqual(result.removedIds, [], `搬家笔被当成了删除：${result.removedIds.join(",")}`);
  assert.deepEqual(formatProblems({ result, sha: "95dcdc7" }), []);
});

test("② 反向锚：同一批 id 如果新增行里没有、树里也没有 ⇒ 必须红（证明绿不是空转）", () => {
  // 用同一个仓库、同一笔真实 diff 的内容，但把"新增行"与"树里还在"两条豁免都拿掉。
  const diff = git(["show", "--format=", "-U0", "95dcdc7", "--", "backend/book2text/static"]);
  const movedIds = [...parseDiff(diff).removed.flatMap((row) => [...idsInText(row.text)])];
  if (movedIds.length === 0) return;   // 这笔本身没有三种形态的 id 删除，反向锚不适用（见 ①/④）
  const stripped = evaluateRemoval({ diff, message: "", treeIds: [] });
  assert.ok(stripped.missing.length > 0, "把两条豁免都拿掉之后仍然没报——那 ② 的绿说明不了什么");
});

test("③ 合成：同一笔删了 id 又加回 ⇒ 绿", () => {
  const diff = diffOf({
    removed: ['<div id="moved-both-ways">'],
    added: ['<div id="moved-both-ways">'],
  });
  const result = evaluateRemoval({ diff, message: "", treeIds: [] });
  assert.deepEqual(result.missing, [], "删了又加回被当成删除");
});

test("③ 合成：新增行里以引号字符串出现（搬家）⇒ 从删除集合里减掉", () => {
  const diff = diffOf({
    removed: ['const node = document.getElementById("relocated");'],
    added: ['const node = root.querySelector("#relocated");'],
  });
  const result = evaluateRemoval({ diff, message: "", treeIds: [] });
  assert.deepEqual(result.missing, [], "搬家笔（新增行里有 #relocated）被当成删除");
});

test("③ 合成：树里还在 ⇒ 兜底豁免（删了引用但元素还在别的文件）", () => {
  const diff = diffOf({ removed: ['const node = document.getElementById("survivor");'] });
  const result = evaluateRemoval({ diff, message: "", treeIds: ["survivor"] });
  assert.deepEqual(result.missing, []);
});

test("④ 合成：正文登记了但漏了一个 id ⇒ 红，并点名漏的那个", () => {
  const diff = diffOf({
    removed: ['<div id="keep-me">', '<div id="forgot-me">'],
  });
  const result = evaluateRemoval({ diff, message: "标题\n\nRemoved-UI: keep-me\n", treeIds: [] });
  assert.deepEqual(result.missing, ["forgot-me"], `漏掉的集合不对：${result.missing.join(",")}`);
  const problems = formatProblems({ result, sha: "abcdef1234" });
  assert.match(problems[0], /漏了 1 个 id/, problems[0]);
  assert.match(problems[0], /#forgot-me\s+backend\/book2text\/static\/index\.html:2/, problems[0]);
});

test("④ 合成：登记行写全 ⇒ 绿（比集合，不是比字符串）", () => {
  const diff = diffOf({ removed: ['<div id="keep-me">', '<div id="also-me">'] });
  const result = evaluateRemoval({ diff, message: "Removed-UI: also-me, keep-me\n", treeIds: [] });
  assert.deepEqual(result.missing, []);
});
