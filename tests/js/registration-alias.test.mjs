// §18.6 登记的两条放宽（2026-11-03，Chief 派）——都治「多一个来回」：
//
// ① **登记行认 cherry-pick 原始 sha**：cherry-pick 换 sha 会让登记当场过期，今天为此重签两次
//    （`32917c0` / `a0bba4a`）。`git cherry-pick -x` 会在正文留 `cherry picked from commit <原 sha>`，
//    那和集成后的 sha 是**同一个补丁的两个名字**，所以「提交」格写哪个都算登记。
//    口径要窄：只有正文里带 cherry-pick 落款才产生别名——否则随手抄一个 sha 就能把未登记混过闸。
//
// ② **授权签署人加 Chief**：登记原来只认 DevLead 一个人，所有 test-contract 都串行等同一人，
//    每笔多一个来回。Chief 是集成方（每笔进 main 前都在他手里过一遍），做第二双眼睛是合理的分离。
//    **不变的是那条铁律：作者不能签自己那笔**——它才是防作弊的关键，这份自检里专门钉了一条。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AUTHORIZED_SIGNERS,
  cherryPickOriginShas,
  commitContractProblems,
} from "./feature-contract.mjs";

/** §18.6 登记表：只写「提交」格里的 sha，行内容满足删/补/变异三样。 */
function docWith(shaCells) {
  return [
    "### 18.6 判据变更登记",
    "| 日期 | 判据 | 变更 | 批准人 | 提交 |",
    "|---|---|---|---|---|",
    ...shaCells.map((cell) => `| 2026-11-03 | X | 删：旧断言；补：更严的断言；变异：改坏一次红在目标行 | DevLead | ${cell} |`),
  ].join("\n");
}

const INTEGRATED = "abc1234";          // 集成后的 sha（cherry-pick 产生的新 sha）
const ORIGINAL = "deadbeef1234";       // cherry-pick -x 正文里留下的原 sha
const CHERRY_BODY = `test-contract: 某笔\n\n正文。\n\n(cherry picked from commit ${ORIGINAL})\n`;

const commit = (over) => commitContractProblems({
  sha: INTEGRATED,
  subject: "test-contract: 某笔改判据",
  files: ["tests/js/boundary.test.mjs"],
  deletions: 3,
  author: "CLnum42",
  ...over,
});

test("cherry-pick 原 sha 的解析：只认落款，不认正文里随便出现的 sha", () => {
  assert.deepEqual(cherryPickOriginShas(CHERRY_BODY), [ORIGINAL]);
  assert.deepEqual(cherryPickOriginShas("test-contract: x\n\n顺手修了 abc1234 这个 bug\n"), [],
    "正文里随便提到一个 sha 就被当别名了——那等于把「未登记」的闸门打开");
  assert.deepEqual(cherryPickOriginShas(null), []);
  assert.deepEqual(cherryPickOriginShas(""), []);
});

test("① 真数据：主线里那次 cherry-pick 的落款原样能被解析（别名不是纸上口径）", () => {
  // `4bba5e6` 是跨根闸那笔在 main 上的样子，正文末行带 `cherry picked from commit def7a10…`。
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const body = execFileSync("git", ["show", "-s", "--format=%B", "4bba5e6"], { cwd: repoRoot, encoding: "utf8" });
  const origins = cherryPickOriginShas(body);
  assert.equal(origins.length, 1, `主线这笔的 cherry-pick 落款没解析出来：${JSON.stringify(body.slice(-120))}`);
  const verdict = commit({
    sha: "4bba5e6",
    docText: docWith([origins[0]]),   // 登记行写的是**原 sha**
    message: body,
  });
  assert.deepEqual(verdict.registryProblems, [],
    `真 cherry-pick 正文 + 只写原 sha 的登记行被判不合格：${verdict.registryProblems.join("；")}`);
});

test("① 登记行只写原 sha ⇒ 绿（cherry-pick 换 sha 不再触发重签）", () => {
  const verdict = commit({ docText: docWith([ORIGINAL]), message: CHERRY_BODY });
  assert.deepEqual(verdict.registryProblems, [],
    `只写原 sha 仍被判未登记：${verdict.registryProblems.join("；")}`);
  assert.equal(verdict.exempt, true, "只写原 sha 的登记没被豁免 A1b");
});

test("① 登记行只写集成后的 sha ⇒ 绿（老写法不许退化）", () => {
  const verdict = commit({ docText: docWith([INTEGRATED]), message: CHERRY_BODY });
  assert.deepEqual(verdict.registryProblems, [], `只写集成 sha 仍红：${verdict.registryProblems.join("；")}`);
  assert.equal(verdict.exempt, true);
});

test("① 两个 sha 都不写 ⇒ 红，并且红文提示「可以写原 sha」", () => {
  const verdict = commit({ docText: docWith(["1111111"]), message: CHERRY_BODY });
  assert.equal(verdict.registryProblems.length, 1, `应当恰好一条未被登记：${verdict.registryProblems.join("；")}`);
  assert.match(verdict.registryProblems[0], /没登记在 §18\.6/);
  assert.ok(verdict.registryProblems[0].includes("原 sha"),
    `红文没告诉人"可以写 cherry-pick 原 sha"：${verdict.registryProblems[0]}`);
});

test("① 正文没有 cherry-pick 落款时，别的 sha 不能当别名（收窄口径的反例）", () => {
  const verdict = commit({ docText: docWith([ORIGINAL]), message: "test-contract: 某笔\n\n正文里提到 deadbeef1234\n" });
  assert.ok(verdict.registryProblems.some((one) => one.includes("没登记在 §18.6")),
    `正文里提到原 sha 就被当别名了：${verdict.registryProblems.join("；") || "(没有红灯)"}`);
});

test("② 授权签署人含 DevLead 与 Chief；表格登记行写 Chief ⇒ 绿", () => {
  assert.ok(AUTHORIZED_SIGNERS.includes("DevLead") && AUTHORIZED_SIGNERS.includes("Chief"),
    `授权名单不对：${AUTHORIZED_SIGNERS.join(" / ")}`);
  const docText = docWith([INTEGRATED]).replace("| DevLead |", "| Chief |");
  const verdict = commit({ docText, message: "test-contract: 某笔\n" });
  assert.deepEqual(verdict.registryProblems, [], `Chief 签的登记行被判不合格：${verdict.registryProblems.join("；")}`);
  assert.equal(verdict.exempt, true);
});

test("② Approved-by: Chief 的 trailer ⇒ 绿（不用再等 DevLead 一个人）", () => {
  const verdict = commit({
    docText: docWith([]),   // 没有登记行，只靠 trailer
    message: `test-contract: 某笔\n\n正文。\n\nApproved-by: Chief\n`,
  });
  assert.deepEqual(verdict.registryProblems, [], `Chief 的 trailer 没被认：${verdict.registryProblems.join("；")}`);
  assert.equal(verdict.exempt, true);
});

test("② 铁律不变：作者签自己那笔仍红（Approved-by == %an）", () => {
  const verdict = commit({
    docText: docWith([]),
    author: "Chief",
    message: `test-contract: 某笔\n\n正文。\n\nApproved-by: Chief\n`,
  });
  assert.ok(
    verdict.registryProblems.some((one) => one.includes("自己签自己")),
    `自己签自己没红：${verdict.registryProblems.join("；") || "(没有红灯)"}`,
  );
});

test("② 名单加人没有把「未授权的人」也放进来：Approved-by: Builder 仍红", () => {
  const verdict = commit({
    docText: docWith([]),
    message: `test-contract: 某笔\n\n正文。\n\nApproved-by: Builder\n`,
  });
  assert.ok(
    verdict.registryProblems.some((one) => one.includes("不在授权名单")),
    `Builder 自签被放过了：${verdict.registryProblems.join("；") || "(没有红灯)"}`,
  );
});
