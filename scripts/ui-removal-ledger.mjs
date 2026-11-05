#!/usr/bin/env node
// 「删掉 UI 入口必须在提交正文登记 Removed-UI」闸（2026-11-05，Chief 派、DevLead 出判据）。
//
// 为什么要有它：删掉的 UI id 不会让任何测试红——测试用的是"剩下那些"id。于是"这扇门去哪了"
// 只能靠人记得。这闸把记忆变成判据：**删了入口，就在提交正文里写一行**，写不出来说明删得不明白。
//
// 判据（DevLead 原文）：
//   作用域：每笔非 merge 提交，只看 backend/book2text/static/**（含 index.html）；tests/ 不扫。
//   候选 id 三种形态：`id="X"` · `getElementById("X")` · `querySelector(All)("#X")`。
//   removed = 本笔删除行里命中的 id 集合，再减去：
//     ① 本笔新增行里以**任何引号字符串**出现过的 id（'X' / "X" / `#X`）—— 搬家笔；
//     ② 本笔的树里该 id 仍以三种形态出现 —— 兜底。
//   同一笔"删了又加回"不算删除；动态拼接（`#${…}`）不判；class 不判。
//   登记：正文必须有一行 `Removed-UI: id1, id2`，且 **removed ⊆ 登记集合**（不是"有这一行就行"）。
//
// 两个入口（同一份实现）：
//   · `--staged --message <文件>`  ← commit-msg 钩子（**不是 pre-commit**：git 在 pre-commit 时刻
//     还没有提交信息，读 COMMIT_EDITMSG 读到的是上一笔——那是"先写标记后读标记"那个坑的变体）。
//   · `--range origin/main..HEAD`  ← pre-push 兜底（`--no-verify` 会跳过 commit-msg）。
//
// 为什么入口是 commit-msg 而不是 pre-commit（2026-11-05 实测，临时仓库）：
//   pre-commit 看到的 COMMIT_EDITMSG：第一笔为空、第二笔是**上一笔的消息**；
//   commit-msg 拿到的 $1 永远是**这一笔**的消息。只有后者能判"这篇正文登记了没有"。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCOPE = "backend/book2text/static";

/** 三种候选形态。动态拼接（`#${…}`）与带空格的复合选择器天然不匹配 ⇒ 按口径"不判"。 */
const ID_PATTERNS = [
  /\bid\s*=\s*["']([^"']+)["']/g,
  /\bgetElementById\(\s*["']([^"']+)["']\s*\)/g,
  /\bquerySelector(?:All)?\(\s*["'`]#([^"'`${\s]+)["'`]\s*\)/g,
];

/** 一段文本里命中的 id（三种形态）。 */
export function idsInText(text) {
  const out = new Set();
  const source = String(text || "");
  for (const pattern of ID_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const id = match[1];
      if (id && !id.includes("${")) out.add(id);
    }
  }
  return out;
}

/** 一段文本里"以引号字符串出现过"的 id（去掉前导 `#`；动态拼接不算）。 */
export function quotedIds(text) {
  const out = new Set();
  for (const match of String(text || "").matchAll(/(["'`])([^"'`\n]*)\1/g)) {
    let value = match[2].trim();
    if (!value || value.includes("${")) continue;
    if (value.startsWith("#")) value = value.slice(1);
    if (value) out.add(value);
  }
  return out;
}

/** 提交正文里的 `Removed-UI:` 行 → 登记集合（多行合并；逗号/空白分隔；容忍前导 `#`）。 */
export function registeredIds(message) {
  const out = new Set();
  for (const line of String(message || "").split("\n")) {
    const match = /^\s*Removed-UI\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    for (const token of match[1].split(/[,\s]+/)) {
      const id = token.trim().replace(/^#/, "");
      if (id) out.add(id);
    }
  }
  return out;
}

/** `-U0` 的 unified diff → `{ removed: [{file, line, text}], added: [{file, text}] }`（行号按旧文件）。 */
export function parseDiff(diffText) {
  const removed = [];
  const added = [];
  let file = null;
  let oldLine = 0;
  for (const raw of String(diffText || "").split("\n")) {
    if (raw.startsWith("--- a/")) { file = raw.slice(6); continue; }
    if (raw.startsWith("--- /dev/null")) continue;            // 新增文件：文件路径取 +++ 那行
    if (raw.startsWith("+++ b/")) { file = raw.slice(6); continue; }
    if (raw.startsWith("+++ /dev/null")) continue;            // 删除文件：路径保留 --- 那行的
    if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) oldLine = Number(match[1]);
      continue;
    }
    if (raw.startsWith("-")) {
      removed.push({ file, line: oldLine, text: raw.slice(1) });
      oldLine += 1;
    } else if (raw.startsWith("+")) {
      added.push({ file, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      oldLine += 1;
    }
  }
  return { removed, added };
}

/**
 * 核心判定（纯函数，自检直接喂合成 diff）。
 *
 * @param {{diff: string, message: string, treeIds?: Set<string>|string[]}} input
 *   `treeIds` = 这笔提交之后，static 树里仍以三种形态出现的 id（兜底：删了又留着不算删）。
 * @returns {{removedIds: string[], missing: string[], hits: {id: string, file: string, line: number}[]}}
 */
export function evaluateRemoval({ diff, message = "", treeIds = [] }) {
  const inTree = treeIds instanceof Set ? treeIds : new Set(treeIds || []);
  const { removed, added } = parseDiff(diff);

  const hits = new Map();   // id → 首次命中（报告要点名 file:line）
  for (const row of removed) {
    for (const id of idsInText(row.text)) {
      if (!hits.has(id)) hits.set(id, { file: row.file, line: row.line });
    }
  }
  const reAdded = new Set();
  for (const row of added) for (const id of quotedIds(row.text)) reAdded.add(id);

  const removedIds = [...hits.keys()]
    .filter((id) => !reAdded.has(id))      // ① 搬家：新增行里以引号字符串出现过
    .filter((id) => !inTree.has(id));      // ② 兜底：树里还在
  const registered = registeredIds(message);
  const missing = removedIds.filter((id) => !registered.has(id));
  return {
    removedIds,
    missing,
    hits: removedIds.map((id) => ({ id, ...hits.get(id) })),
  };
}

/** 一组 static 文件（`{path, text}`）→ 树里仍出现的 id 集合。 */
export function treeIdsOf(files) {
  const out = new Set();
  for (const file of files) for (const id of idsInText(file.text)) out.add(id);
  return out;
}

// ---------------------------------------------------------------- git 侧

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function stagedTreeIds() {
  const paths = git(["ls-files", "--", SCOPE]).split("\n").filter(Boolean);
  return treeIdsOf(paths.map((path) => ({ path, text: git(["show", `:${path}`]) })));
}

function commitTreeIds(sha) {
  const paths = git(["ls-tree", "-r", "--name-only", sha, "--", SCOPE]).split("\n").filter(Boolean);
  return treeIdsOf(paths.map((path) => ({ path, text: git(["show", `${sha}:${path}`]) })));
}

/** 一笔提交 → 判定结果。 */
export function evaluateCommit(sha) {
  const message = git(["log", "-1", "--format=%B", sha]);
  const diff = git(["show", "--format=", "-U0", "--no-color", sha, "--", SCOPE]);
  return evaluateRemoval({ diff, message, treeIds: commitTreeIds(sha) });
}

/** 暂存区 → 判定结果（`message` 来自 commit-msg 钩子给的正文文件）。 */
export function evaluateStaged(message) {
  const diff = git(["diff", "--cached", "-U0", "--no-color", "--", SCOPE]);
  return evaluateRemoval({ diff, message, treeIds: stagedTreeIds() });
}

// ---------------------------------------------------------------- 报文

/** 一段可行动的报错；没有问题返回 []。 */
export function formatProblems({ result, sha }) {
  if (!result.missing.length) return [];
  const label = sha ? sha.slice(0, 7) : "本次提交";
  const hasRegistration = result.missing.length !== result.removedIds.length;
  const head = hasRegistration
    ? `✖ ${label} 的 Removed-UI 漏了 ${result.missing.length} 个 id（删了 ${result.removedIds.length} 个，只登记了 ${result.removedIds.length - result.missing.length} 个）：`
    : `✖ ${label} 删除了 ${result.missing.length} 个 UI id，正文没有 Removed-UI：`;
  const lines = result.hits
    .filter((hit) => result.missing.includes(hit.id))
    .map((hit) => `    #${hit.id}   ${hit.file}:${hit.line}（删除行；新增行里未再出现，本笔的树里也没有）`);
  const fix = `  修法：在提交正文加一行 \`Removed-UI: ${[...result.removedIds].join(", ")}\``;
  return [`${head}\n${lines.join("\n")}\n${fix}`];
}

function main(argv) {
  const has = (flag) => argv.includes(flag);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : argv[index + 1];
  };
  const problems = [];
  try {
    if (has("--staged")) {
      const messagePath = value("--message");
      if (!messagePath) {
        console.error("✖ ui-removal：--staged 必须配 --message <提交信息文件>（commit-msg 的 $1）");
        return 2;
      }
      const message = readFileSync(messagePath, "utf8");
      const result = evaluateStaged(message);
      problems.push(...formatProblems({ result, sha: null }));
    } else if (has("--range")) {
      const range = value("--range");
      if (!range) {
        console.error("✖ ui-removal：--range 缺值（例：origin/main..HEAD）");
        return 2;
      }
      const shas = git(["rev-list", "--no-merges", range]).split("\n").filter(Boolean);
      for (const sha of shas) {
        const result = evaluateCommit(sha);
        problems.push(...formatProblems({ result, sha }));
      }
    } else {
      console.error("✖ 用法：--staged --message <file> | --range <base>..HEAD");
      return 2;
    }
  } catch (error) {
    // fail closed：读不到 git / 读不到文件都不许当"没有删除"
    console.error(`✖ ui-removal 闸自己跑不起来：${error.message}`);
    console.error("  这不是「通过」——跑不起来的闸不允许静默放过（fail closed）。");
    return 2;
  }
  if (problems.length) {
    console.error(problems.join("\n\n"));
    console.error("\n  （删 UI 入口要在正文留痕：谁、为什么删。删不出来就说明这一步没想清楚。）");
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
