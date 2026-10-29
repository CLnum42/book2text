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
// - **对象边界**：`tests/js/**/*.md` 是文档（README 记机检覆盖率），不参与 A1/A1b/A3；
//   `*.mjs` 与数据夹具照判。理由见 §18.6 那一行：改一行读数不该被要求写「删/补/变异」，
//   否则登记表会被文档编辑灌满，下一个人就不再信它。
//
// 为什么这样：A1 挡「切边顺手改测试」，A1b 挡「分散到多笔里偷偷改」，A3 挡「改判据不登记」。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripCommentsAndStrings } from "./static-scan.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOC_REL = "docs/refactor/reading-view-boundary.md";

/**
 * 「算契约对象」的 `tests/js` 路径集合（给 git pathspec 用）：可执行断言 + 数据夹具，
 * **排除 `*.md`**。git pathspec 里的 `*` 会跨 `/` 匹配，所以 `tests/js/*.md` 覆盖任意层级的文档。
 */
const CONTRACT_SCOPE = ["tests/js/", ":(exclude)tests/js/*.md"];

/** 单个文件是否算契约对象（纯函数，自检与内核共用；`files` 来自 `git show --name-only`）。 */
export function isContractPath(file) {
  return typeof file === "string" && file.startsWith("tests/js/") && !/\.md$/i.test(file);
}

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
    deleted: /删[:：]\s*[^\s|—-]/.test(row),
    stricter: /补[:：]\s*[^\s|—-]/.test(row),
    mutation: /变异[:：]\s*[^\s|—-]/.test(row),
  };
}

/**
 * **`move:` 笔类（Chief 2026-10-29）**：搬运一个视图时，产品代码与三张登记表必须同批改，
 * 否则 A1 / A1b / A3 互相锁死（只落模块 → R5/R8 红；只改表 → R8 红；合成一笔 → A1 红）。
 *
 * 放行的判据不是"碰了哪张表"，而是"这笔改动是**必需的**"：
 * - 首行 `move(<视图>): …`；
 * - **必须同时**含 `backend/book2text/static/` 与 `tests/js/` 改动（空声明的 `move:` 是伪装）；
 * - `tests/js` 的**全部**变更行（增与删）必须落在三张登记表块内：
 *   `OWNERS` / `VIEW_STATE_PREFIXES` / `VIEW_EXPORTS`；
 * - 块边界**从源码派生**（`const NAME = {` → 配对 `};`），**不手写行号**——
 *   手工行号正是"会漂的副本"，任何一次插入就失效；
 * - 找不到块 → **红（fail closed）**，不许"解析不了就放行"；越界 → 红并打印 `文件:行`；
 * - **豁免表与上限一律不放行**（顶层 `const` 名字带 `EXCUS` 或 `MAX`）：那是削弱闸的旋钮，
 *   和"登记某个模块叫什么"是两回事。
 */
const MOVE_TABLES = ["OWNERS", "VIEW_STATE_PREFIXES", "VIEW_EXPORTS"];
const MOVE_FORBIDDEN = /(EXCUS|MAX)/;

/** 从源码派生顶层 `const NAME = { … };` 的块范围（`allowed` / `forbidden` 见上）。 */
export function tableBlockRanges(source) {
  const clean = stripCommentsAndStrings(source || "");
  const lines = clean.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^const\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[index]);
    if (!match) continue;
    const name = match[1];
    const allowed = MOVE_TABLES.includes(name);
    const forbidden = MOVE_FORBIDDEN.test(name);
    if (!allowed && !forbidden) continue;
    // 单行常量（`const R5_MAX_EXCUSES = 0;`）没有 `{}`：上限/豁免就是这种形态，
    // 要单独记成 1 行块，否则"动旋钮"会被误报成"表外改动"，报错文案指错方向。
    if (!/^const\s+[A-Za-z_$][\w$]*\s*=\s*\{/.test(lines[index])) {
      // 单行常量（上限/豁免）没有块体
      blocks.push({ name, allowed, forbidden, start: index + 1, end: index + 1 });
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      for (const ch of lines[cursor]) {
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) { end = cursor; break; }
        }
      }
      if (end !== -1) break;
    }
    if (end === -1) continue;   // 括号不配对：交给"找不到块"那条 red 兜底
    blocks.push({ name, allowed, forbidden, start: index + 1, end: end + 1 });
  }
  return blocks;
}

/**
 * `move:` 笔的放行判定（**纯函数**：调用方把 git 里刨出来的行范围喂进来）。
 * @param {{sha: string, files: string[], changes: {path: string, addedRanges: number[][],
 *          deletedRanges: number[][], commitSource: string, parentSource: string}[]}} input
 */
export function moveScopeProblems({ sha, files, changes }) {
  const short = sha.slice(0, 7);
  const problems = [];
  const touchesProduct = files.some((file) => file.startsWith("backend/book2text/static/"));
  const touchesTests = files.some(isContractPath);
  if (!touchesProduct || !touchesTests) {
    const missing = !touchesProduct ? "backend/book2text/static/" : "tests/js/";
    problems.push(`A1: ${short} 是 move: 笔，但没有改 ${missing}——空声明的 move: 是伪装`);
    return problems;
  }

  for (const change of changes) {
    const commitBlocks = tableBlockRanges(change.commitSource);
    const parentBlocks = tableBlockRanges(change.parentSource);
    const check = (ranges, blocks, side) => {
      for (const [from, to] of ranges) {
        for (let line = from; line <= to; line += 1) {
          const hit = blocks.find((item) => item.start <= line && line <= item.end);
          if (hit && hit.allowed) continue;
          if (hit && hit.forbidden) {
            problems.push(
              `A1: ${short} ${change.path}:${line} 落在 ${hit.name}（豁免表/上限）里——`
              + `move: 笔不许动削弱闸的旋钮`,
            );
            continue;
          }
          problems.push(
            `A1: ${short} ${change.path}:${line} 的${side}不在三张登记表内`
            + `（${MOVE_TABLES.join(" / ")}）——move: 笔只许改登记表`,
          );
        }
      }
    };
    if (!commitBlocks.some((item) => item.allowed) && !parentBlocks.some((item) => item.allowed)) {
      problems.push(
        `A1: ${short} ${change.path} 里找不到登记表块（${MOVE_TABLES.join(" / ")}）——`
        + `块边界解析失败就判红，不许放行`,
      );
      continue;
    }
    check(change.addedRanges, commitBlocks, "新增");
    check(change.deletedRanges, parentBlocks, "删除");
  }
  return problems;
}

/**
 * 单笔提交的契约判定（**纯函数**，自检夹具直接喂合成提交）。
 *
 * 为什么把内核提出来：闸 A 原来只有"现状绿"断言——`git rev-list base..HEAD` 跑出来 0 问题，
 * 但没人证明过"违规真的会红"。红灯只在历史里出现过一次（`1f57e8d` 把 tests/js 卷进产品提交），
 * 那次能红只是因为历史恰好有违规。合成样例才是可重复的证明。
 *
 * @param {{sha: string, subject: string, files: string[], deletions: number,
 *          deletedFiles?: string[], docText: string}} commit
 * @returns {{problems: string[], exempt: boolean}}
 */
export function commitContractProblems({
  sha, subject, files, deletions, deletedFiles = [], docText, moveChanges = null,
}) {
  const short = sha.slice(0, 7);
  const problems = [];
  const touchesProduct = files.some((file) => file.startsWith("backend/book2text/static/"));
  const touchesTests = files.some(isContractPath);
  const isMove = /^move[(:]/.test(subject);

  // A1：普通提交不许同时碰产品与 tests/js；`move:` 笔是**唯一**例外，
  // 但它有更严的代价：tests/js 的每一行改动都必须落在三张登记表里（见 moveScopeProblems）。
  if (isMove) {
    problems.push(...moveScopeProblems({ sha, files, changes: moveChanges || [] }));
  } else if (touchesProduct && touchesTests) {
    problems.push(`A1: ${short} 同时改了产品代码与 tests/js（${subject}）`);
  }

  // A3：改旧断言（有删除行）→ 必须单开 test-contract: 提交、并在 §18.6 写清三样。
  // 两个条件缺一不可：`deletions` 是**契约路径**的删除行（git 侧已排除 *.md），`touchesTests`
  // 是同一口径的"碰了契约路径"。只靠 deletions，内核在合成样例里会把"只改 README"判成改断言。
  let exempt = false;
  if (deletions > 0 && touchesTests) {
    if (!subject.startsWith("test-contract:") && !isMove) {
      problems.push(`A3: ${short} 改了 tests/js 的旧断言（删除 ${deletions} 行）但首行不是 test-contract:（${subject}）`);
    } else if (isMove && deletions === 0) {
      // move: 笔不删旧断言时也要登记（登记义务不降），走下面的三样检查
    } else if (isMove) {
      // move: 笔允许删 tests/js 的行（A1b 放行），但登记三样照旧
      if (!registeredIn1886(sha, docText)) {
        problems.push(`A3: ${short} 是 move: 笔但没登记在 §18.6`);
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

  // move: 笔的登记义务与删行无关（"登记义务不降"）：增删都查
  if (isMove && deletions === 0) {
    if (!registeredIn1886(sha, docText)) {
      problems.push(`A3: ${short} 是 move: 笔但没登记在 §18.6`);
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

  // A1b：只有**合规的 test-contract / move: 提交**可以删 tests/js 的行
  if (!exempt && deletedFiles.length > 0) {
    problems.push(`A1b: ${short} 删了 tests/js 的文件（${deletedFiles.join(", ")}）——删文件不算改断言`);
  }
  return { problems, exempt };
}

/** 从 git 刨 `move:` 笔在 tests/js 里的逐行变更（新增/删除的行范围 + 两个版本的源码）。 */
function moveChangesFromGit(sha) {
  const diff = git(["show", "--unified=0", "--format=", sha, "--", ...CONTRACT_SCOPE]);
  const byPath = new Map();
  let current = null;
  for (const line of diff.split("\n")) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      current = { path: fileMatch[1], addedRanges: [], deletedRanges: [] };
      byPath.set(current.path, current);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !current) continue;
    const oldStart = Number(hunk[1]);
    const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const newStart = Number(hunk[3]);
    const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
    if (oldCount > 0) current.deletedRanges.push([oldStart, oldStart + oldCount - 1]);
    if (newCount > 0) current.addedRanges.push([newStart, newStart + newCount - 1]);
  }
  const showOrEmpty = (spec) => {
    try {
      return git(["show", spec]);
    } catch {
      return "";
    }
  };
  return [...byPath.values()].map((change) => ({
    ...change,
    commitSource: showOrEmpty(`${sha}:${change.path}`),
    parentSource: showOrEmpty(`${sha}^:${change.path}`),
  }));
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
    const numstat = git(["show", "--numstat", "--format=", sha, "--", ...CONTRACT_SCOPE])
      .split("\n")
      .filter(Boolean);
    const deletions = numstat.reduce((sum, line) => sum + (Number(line.split("\t")[1]) || 0), 0);
    const verdict = commitContractProblems({
      sha,
      subject: git(["show", "-s", "--format=%s", sha]),
      files: git(["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean),
      deletions,
      deletedFiles: git(["show", "--name-status", "--diff-filter=D", "--format=", sha, "--", ...CONTRACT_SCOPE])
        .split("\n").filter(Boolean),
      docText,
      moveChanges: /^move[(:]/.test(git(["show", "-s", "--format=%s", sha]))
        ? moveChangesFromGit(sha)
        : null,
    });
    problems.push(...verdict.problems);
    if (!verdict.exempt) unregisteredDeletions += deletions;
  }

  if (unregisteredDeletions !== 0) {
    problems.push(`A1b: 非登记 test-contract 提交合计删除 tests/js ${unregisteredDeletions} 行（必须 0）`);
  }
  return { problems, commitCount: commits.length };
}
