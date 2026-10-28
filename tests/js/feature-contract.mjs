// 闸 A：特征测试契约（§18.2）的**静态**部分 —— A1 / A1b / A3。
//
// A2（回放）与 A4（变异红两遍）是运行期检查，形态是 `tests/js/mutation-check.mjs`
// （同一份测试在 base worktree 上先绿、再插变异必须红）。这里不重复造。
//
// 判据（对象 = 被测 SHA 的 git 序列 `ring-break-base..HEAD`）：
// - **A1**：任何一笔碰了产品代码（`backend/book2text/static/`）的提交，不得碰 `tests/js/`（新增也算）。
// - **A1b**：序列合计 `git diff --numstat base..HEAD -- tests/js` 删除行 = 0、删除文件 = 0。
// - **A3**：改了 `tests/js` 旧断言（有删除行）的提交必须：首行 `test-contract:`、不含产品代码、
//   且 sha 登记在 docs/refactor/reading-view-boundary.md §18.6。
//
// 为什么这样：A1 挡「切边顺手改测试」，A1b 挡「分散到多笔里偷偷改」，A3 挡「改判据不登记」。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOC_REL = "docs/refactor/reading-view-boundary.md";

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/** §18.6 登记表里是否出现过这个 sha（短或长都认）。 */
function registeredIn1886(sha, docText) {
  const short = sha.slice(0, 7);
  const table = docText.slice(docText.indexOf("### 18.6"));
  return table.includes(short) || table.includes(sha);
}

/**
 * 登记行的**内容**要求（Chief 2026-10-29）：光有 sha 不算登记，必须写清三样——
 * `删：…`（删了哪些断言）、`补：…`（换成了什么更严的）、`变异：…`（各改坏一次，红在哪）。
 * 理由：「删了几行」是替代指标，「改完还会不会咬人」才是根因。
 */
export function registrationContent(sha, docText) {
  const short = sha.slice(0, 7);
  const table = docText.slice(docText.indexOf("### 18.6"));
  const row = table
    .split("\n")
    .find((line) => line.trimStart().startsWith("|") && (line.includes(short) || line.includes(sha)));
  if (!row) return null;
  return {
    row,
    deleted: /删[:：]\s*\S/.test(row),
    stricter: /补[:：]\s*\S/.test(row),
    mutation: /变异[:：]\s*\S/.test(row),
  };
}

/**
 * @returns {{ problems: string[], commitCount: number }}
 */
export function evaluateFeatureContract({ baseTag = "ring-break-base" } = {}) {
  const problems = [];
  let unregisteredDeletions = 0;
  try {
    git(["rev-parse", "--verify", baseTag]);
  } catch {
    return { problems: [`找不到 tag ${baseTag}：闸 A 需要基点（DevLead 打 tag 后才能跑）`], commitCount: 0 };
  }
  const docText = readFileSync(`${REPO_ROOT}/${DOC_REL}`, "utf8");
  const commits = git(["rev-list", "--reverse", `${baseTag}..HEAD`]).split("\n").filter(Boolean);

  for (const sha of commits) {
    const short = sha.slice(0, 7);
    const files = git(["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean);
    const subject = git(["show", "-s", "--format=%s", sha]);
    const touchesProduct = files.some((file) => file.startsWith("backend/book2text/static/"));
    const touchesTests = files.some((file) => file.startsWith("tests/js/"));

    // A1
    if (touchesProduct && touchesTests) {
      problems.push(`A1: ${short} 同时改了产品代码与 tests/js（${subject}）`);
    }

    // A3：改旧断言（有删除行）→ 必须单开 test-contract: 提交、并在 §18.6 写清三样
    const numstat = git(["show", "--numstat", "--format=", sha, "--", "tests/js/"])
      .split("\n")
      .filter(Boolean);
    const deletions = numstat.reduce((sum, line) => sum + (Number(line.split("\t")[1]) || 0), 0);
    let exempt = false;
    if (deletions > 0) {
      if (!subject.startsWith("test-contract:")) {
        problems.push(`A3: ${short} 改了 tests/js 的旧断言（删除 ${deletions} 行）但首行不是 test-contract:（${subject}）`);
      } else {
        if (touchesProduct) problems.push(`A3: ${short} 是 test-contract 提交却动了产品代码`);
        if (!registeredIn1886(sha, docText)) {
          problems.push(`A3: ${short} 是 test-contract 提交但没登记在 §18.6`);
        } else {
          const reg = registrationContent(sha, docText);
          const lacking = [
            ["删了什么（删：…）", reg.deleted],
            ["补了什么更严的（补：…）", reg.stricter],
            ["变异证明（变异：…）", reg.mutation],
          ].filter(([, ok]) => !ok).map(([label]) => label);
          if (lacking.length > 0) {
            problems.push(`A3: ${short} 的 §18.6 登记缺 ${lacking.join("、")}——只写 sha 不算登记`);
          } else {
            exempt = true;
          }
        }
      }
    }
    // A1b（2026-10-29 改判）：只有**合规的 test-contract 提交**可以删 tests/js 的行；
    // 其余提交删一行都算破坏特征测试契约。原来数的是 base..HEAD 净删除，
    // 结果把 A3 给 test-contract 开的口子堵死了（登记了也照红）。
    if (!exempt) {
      unregisteredDeletions += deletions;
      const deletedFiles = git(["show", "--name-status", "--diff-filter=D", "--format=", sha, "--", "tests/js/"])
        .split("\n").filter(Boolean);
      if (deletedFiles.length > 0) {
        problems.push(`A1b: ${short} 删了 tests/js 的文件（${deletedFiles.join(", ")}）——删文件不算改断言`);
      }
    }
  }

  if (unregisteredDeletions !== 0) {
    problems.push(`A1b: 非登记 test-contract 提交合计删除 tests/js ${unregisteredDeletions} 行（必须 0）`);
  }
  return { problems, commitCount: commits.length };
}
