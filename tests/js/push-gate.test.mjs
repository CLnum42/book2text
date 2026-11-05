// 规则 #34：**钩子里不放长活**（2026-11-05，三次推送被 SSH 掐断之后）。
//
// 三条判据（Chief 定的，全部机检）：
//   ① 钩子源码里 grep 不到 `run.mjs` / `pytest` —— 证明重活真的搬走了（不是"还跑着但很快"）；
//   ② 带记录的推送：钩子本身 < 5s（完整 `git push` 的 time 见报告，钩子是其中唯一由仓库控制的段）；
//   ③ 缺记录 ⇒ 拒绝，且打印的 `sh scripts/verify.sh <sha>` 直接可复制执行。
//
// 另有两条防退化的自检：旧的 `RANGE` 记录仍算数（兼容证据别动）；一个记录文件都没有 ⇒ 拒绝（fail closed）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOOK = join(REPO_ROOT, "scripts/git-hooks/pre-push");
const VERIFY = join(REPO_ROOT, "scripts/verify.sh");
const ZERO = "0".repeat(40);
const SHA = "1234567890abcdef1234567890abcdef12345678";

/** 造一个只有 .git 的沙箱仓库；返回 { dir, run(input) }。 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "b2t-pushgate."));
  // **必须清掉 GIT_* 环境变量**：pre-commit 跑套件时会设 `GIT_DIR=<真仓库>`（它要读历史），
  // 继承下来的话沙箱里的 `git init` / `git rev-parse` 全指向真仓库——
  // 沙箱测试会读到真仓库的记录，于是"没有记录"的用例根本没有沙箱（2026-11-05 实测踩到）。
  const cleanEnv = () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    return env;
  };
  const init = spawnSync("git", ["init", "-q", "."], { cwd: dir, encoding: "utf8", env: cleanEnv() });
  assert.equal(init.status, 0, `沙箱 git init 失败：${init.stderr}`);
  const run = (input) => {
    const started = Date.now();
    const result = spawnSync("sh", [HOOK], { cwd: dir, input, encoding: "utf8", env: cleanEnv() });
    return { ...result, ms: Date.now() - started };
  };
  return { dir, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 在沙箱的 git-common-dir 里写一行记录。 */
function writeRecord(dir, name, line) {
  const gitDir = join(dir, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, name), `${line}\n`, "utf8");
}

test("① 钩子源码里没有 run.mjs / pytest（重活已搬到 verify.sh）", () => {
  const source = readFileSync(HOOK, "utf8");
  assert.equal(/run\.mjs/.test(source), false, "pre-push 里还在跑 tests/js/run.mjs");
  assert.equal(/pytest/.test(source), false, "pre-push 里还出现 pytest（重活没搬走）");
  // 反面锚：verify.sh 里必须**有**这两样——否则"搬走"只是搬没了
  const verifier = readFileSync(VERIFY, "utf8");
  assert.match(verifier, /tests\/js\/run\.mjs/, "verify.sh 没跑 node 套件");
  assert.match(verifier, /-m pytest/, "verify.sh 没跑全量测试");
});

test("② 带 VERIFY 记录：钩子放行且耗时 < 5s", () => {
  const box = sandbox();
  try {
    writeRecord(box.dir, "b2t-verify.log", `VERIFY ${SHA} tree123 2026-11-05T10:00:00 PASS node=371/366 pytest=1077 STATIC_DIR=/tmp/x`);
    const result = box.run(`refs/heads/x ${SHA} refs/heads/x ${ZERO}\n`);
    assert.equal(result.status, 0, `有记录却拒绝推送：${result.stderr}`);
    assert.ok(result.ms < 5000, `钩子耗时 ${result.ms}ms，超过 5s（重活回来了？）`);
  } finally {
    box.cleanup();
  }
});

test("③ 缺记录：拒绝，且打印的 verify 命令可直接复制（带着完整 sha）", () => {
  const box = sandbox();
  try {
    writeRecord(box.dir, "b2t-verify.log", `VERIFY ${"f".repeat(40)} tree123 2026-11-05T10:00:00 PASS node=1/1 pytest=1 STATIC_DIR=/tmp/x`);
    const result = box.run(`refs/heads/x ${SHA} refs/heads/x ${ZERO}\n`);
    assert.equal(result.status, 1, "缺记录却放行了");
    assert.ok(result.stderr.includes(`sh scripts/verify.sh ${SHA}`),
      `报错里没有可直接复制执行的命令：${result.stderr}`);
  } finally {
    box.cleanup();
  }
});

test("兼容：旧的 RANGE 记录仍算数（历史证据别动）", () => {
  const box = sandbox();
  try {
    writeRecord(box.dir, "b2t-pytest.log", `RANGE\t${SHA}\t2026-11-04 22:00:00\t3 files`);
    const result = box.run(`refs/heads/x ${SHA} refs/heads/x ${ZERO}\n`);
    assert.equal(result.status, 0, `旧 RANGE 记录没被认：${result.stderr}`);
  } finally {
    box.cleanup();
  }
});

test("fail-closed：一个记录文件都没有 ⇒ 拒绝（不许「读不到就当通过」）", () => {
  const box = sandbox();
  try {
    const result = box.run(`refs/heads/x ${SHA} refs/heads/x ${ZERO}\n`);
    assert.equal(result.status, 1, "没有任何记录时放行了");
    assert.match(result.stderr, /fail closed/, `没说清是 fail closed：${result.stderr}`);
  } finally {
    box.cleanup();
  }
});

test("多个 ref 一起推：任何一个缺记录都拒绝", () => {
  const box = sandbox();
  try {
    const other = "abcdef1234567890abcdef1234567890abcdef12";
    writeRecord(box.dir, "b2t-verify.log", `VERIFY ${SHA} tree123 2026-11-05T10:00:00 PASS node=1/1 pytest=1 STATIC_DIR=/tmp/x`);
    const result = box.run(
      `refs/heads/x ${SHA} refs/heads/x ${ZERO}\nrefs/heads/y ${other} refs/heads/y ${ZERO}\n`,
    );
    assert.equal(result.status, 1, "一个 ref 缺记录却放行了整次推送");
    assert.ok(result.stderr.includes(other), "没点名缺记录的那一个 sha");
  } finally {
    box.cleanup();
  }
});

test("verify.sh 只在全绿之后才写记录（记录行为在失败分支之后）", () => {
  const source = readFileSync(VERIFY, "utf8");
  const pytestAt = source.indexOf("-m pytest");
  const recordAt = source.indexOf("VERIFY %s");
  assert.ok(pytestAt > 0 && recordAt > 0, "verify.sh 里找不到测试调用或记录行");
  assert.ok(recordAt > pytestAt, "记录写在测试之前——红了也会留 PASS 记录");
  // fail closed 的两条依赖检查必须在记录之前
  assert.ok(source.indexOf("找不到 node") < recordAt, "缺 node 的检查在记录之后");
  assert.ok(source.indexOf("找不到 .venv") < recordAt, "缺 .venv 的检查在记录之后");
});
