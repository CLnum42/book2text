// 文档结构闸（§20.9 ⑫/⑬）：章节号必须可机检——**全层级**，不只是 `N.M`。
//
// 为什么要有这条：这份文档是拆模块的唯一规格书，`§20.9` 这类引用散落在测试文件、提交信息、
// Bot 的交接里。章节号一旦重复/倒退/跑错父节/被引用到不存在的位置，**所有引用一起失效**，
// 而且失效是静默的——没人会去核对 84 个编号。
//
// 口径（Doc 定、DevLead 全部接受）：
// 1. 抽取 `^(#{1,6})\s*(\d+(?:\.\d+)*)([a-z]?)`，**跳过 ``` 围栏**。
//    只扫 `#{2,3}` + `N.M` 是**选择性失明**：顶层 `## N.` 完全不进闸，重复 H1 也看不见
//    （当日实测：`N.M` 口径 58 条 vs 全量 84 条）。
// 2. 排序键 = 数字按段比较 + 字母后缀按字典序；文档顺序必须单调不减。
// 3. 红：重复编号、重复 H1、倒退、子节跑出父节（`13.2b` 的最近上层必须是 `13`）。
// 4. 断链：`§N` / `§N.M[后缀]` 的引用必须能在标题集合里找到。
// 5. 失败信息一行一条 `文件:行:节号`，**不打印整张标题表**（打印整表 = 没人看得懂哪行错了）。
//
// **不进闸的两条**（判据判不准的宁可不进——进了就是长期假红，比没闸更糟）：
// - 有序列表编号（多列表重编号会误报，先人工）；
// - "两处正文"（内容重复机器判不了）。
//
// 只读，不写文件；路径按本文件位置解析，不依赖 cwd（pre-commit 的工作目录不可信）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DOC_FILE = fileURLToPath(new URL("../../docs/refactor/reading-view-boundary.md", import.meta.url));

/** 抹掉围栏代码块（保留行号：只把内容清空，换行不动）。 */
export function stripFencedBlocks(text) {
  let inside = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inside = !inside;
        return "";
      }
      return inside ? "" : line;
    })
    .join("\n");
}

/**
 * 抽出编号标题：`{ line, level, id, title }`。`id` 形如 `13.2b`（数字 + 可选字母后缀）。
 * 未编号的标题不进序列，但 H1 的重复要单独看（那是"文档里有两个标题"）。
 */
export function parseHeadings(text) {
  const headings = [];
  stripFencedBlocks(text).split("\n").forEach((line, index) => {
    const match = /^(#{1,6})\s*(\d+(?:\.\d+)*)([a-z]?)\s*(.*)$/.exec(line);
    if (!match) return;
    headings.push({
      line: index + 1,
      level: match[1].length,
      id: `${match[2]}${match[3]}`,
      title: (match[4] || "").trim(),
    });
  });
  return headings;
}

/** 解析 `13.2b` → `{ parts: [13, 2], suffix: "b" }`。 */
function splitId(id) {
  const match = /^(\d+(?:\.\d+)*)([a-z]?)$/.exec(id);
  if (!match) return null;
  return { parts: match[1].split(".").map(Number), suffix: match[2] || "" };
}

/** 排序比较：数字按段比（缺段视为更小），再比字母后缀。 */
export function compareIds(a, b) {
  const left = splitId(a);
  const right = splitId(b);
  if (!left || !right) return 0;
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    const x = left.parts[index] ?? -1;
    const y = right.parts[index] ?? -1;
    if (x !== y) return x - y;
  }
  if (left.suffix === right.suffix) return 0;
  return left.suffix < right.suffix ? -1 : 1;
}

/**
 * 结构四问（重复编号 / 重复 H1 / 倒退 / 跑出父节）。
 * **纯函数**：自检夹具直接喂合成 markdown；返回 `行:节号 说明` 的字符串数组。
 */
export function structureProblems(markdown) {
  const problems = [];
  const headings = parseHeadings(markdown);

  // ① 重复编号
  const seen = new Map();
  for (const heading of headings) {
    if (seen.has(heading.id)) {
      problems.push(`${heading.line}:${heading.id} 重复编号（第 ${seen.get(heading.id)} 行已有同一个节号）`);
    } else {
      seen.set(heading.id, heading.line);
    }
  }

  // ② 重复 H1（两份相同的一级标题 = 文档里有两个"标题"，不是两个小节）
  const h1 = new Map();
  stripFencedBlocks(markdown)
    .split("\n")
    .forEach((line, index) => {
      if (!/^#\s+\S/.test(line)) return;
      const key = line.trim();
      if (h1.has(key)) {
        problems.push(`${index + 1}:#H1 与第 ${h1.get(key)} 行的一级标题完全相同（文档里出现了两个标题）`);
      } else {
        h1.set(key, index + 1);
      }
    });

  // ③ 倒退
  for (let index = 1; index < headings.length; index += 1) {
    const prev = headings[index - 1];
    const cur = headings[index];
    if (compareIds(prev.id, cur.id) > 0) {
      problems.push(`${cur.line}:${cur.id} 章节号倒退（上一节是 ${prev.id}，第 ${prev.line} 行）`);
    }
  }

  // ④ 跑出父节：`13.2b` 的最近上层标题必须是 `13`
  const lastAtDepth = new Map();   // 深度（数字段数）→ 最近的 id
  for (const heading of headings) {
    const parsed = splitId(heading.id);
    if (!parsed) continue;
    const depth = parsed.parts.length;
    if (depth > 1) {
      const parentId = parsed.parts.slice(0, depth - 1).join(".");
      const actualParent = lastAtDepth.get(depth - 1);
      if (actualParent !== parentId) {
        problems.push(
          `${heading.line}:${heading.id} 跑出父节（最近的上层是 ${actualParent ?? "（没有）"}，应为 ${parentId}）`,
        );
      }
    }
    lastAtDepth.set(depth, heading.id);
    // 更深层的历史要清掉，否则 `13.2` 之后出现 `13.3` 还留着旧的 `13.2.x`
    for (const key of [...lastAtDepth.keys()]) {
      if (key > depth) lastAtDepth.delete(key);
    }
  }

  return problems;
}

/**
 * 断链：`§N` / `§N.M[后缀]` 的引用必须能在标题集合里找到。纯函数，方便喂合成样例。
 */
export function danglingReferenceProblems(markdown) {
  const clean = stripFencedBlocks(markdown);
  const headings = parseHeadings(markdown);
  const ids = new Set(headings.map((item) => item.id));
  const chapters = new Set(headings.map((item) => item.id));
  const problems = [];
  const ref = /§\s*(\d+)(?:\.(\d+))?([a-z]*)/g;
  let match;
  while ((match = ref.exec(clean)) !== null) {
    const [, n, m, suffix] = match;
    const id = m === undefined ? n : `${Number(n)}.${Number(m)}${suffix || ""}`;
    if (!chapters.has(id)) {
      problems.push(`0:§${id} 悬空引用（文档里没有 §${id}）`);
    }
  }
  return [...new Set(problems)];
}

/** 真实文档的一次完整判定（失败信息按行排序，一行一条）。 */
export function documentProblems(markdown) {
  return [...structureProblems(markdown), ...danglingReferenceProblems(markdown)]
    .sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0]));
}

// ---------------------------------------------------------------- 自检夹具（⑬）

test("docs 自检①：13.2→13.2b→13.2c→13.3 判绿（后缀不许被抹掉）", () => {
  const good = ["## 13. 一章", "### 13.2 子节", "### 13.2b 后缀 b", "### 13.2c 后缀 c", "### 13.3 下一个"].join("\n");
  assert.deepEqual(
    structureProblems(good),
    [],
    "自检失败：带后缀的正常序列被判红——多半是抽取时丢了后缀（13.2b/c 会塌缩成 13.2 造出假重复）",
  );
});

test("docs 自检②：两个 13.3 判红", () => {
  const duplicate = ["## 13. 一章", "### 13.3 第一个", "### 13.3 第二个"].join("\n");
  assert.ok(structureProblems(duplicate).length > 0, "自检失败：两个 13.3 也放过");
});

test("docs 自检③：13.2→13.3→13.2b 判红（后缀插在父节之后）", () => {
  const regress = ["## 13. 一章", "### 13.2 子节", "### 13.3 下一个", "### 13.2b 退回去了"].join("\n");
  assert.ok(structureProblems(regress).length > 0, "自检失败：13.3 之后又出现 13.2b 也放过");
});

test("docs 自检④：两份相同 H1 判红", () => {
  const twoH1 = ["# 同一份标题", "## 1. 一章", "### 1.1 子节", "# 同一份标题", "## 2. 一章"].join("\n");
  assert.ok(structureProblems(twoH1).length > 0, "自检失败：两份相同 H1 也放过（只扫 N.M 的实现看不见它）");
});

test("docs 自检⑤：§X 指向不存在的节判红", () => {
  const text = ["## 13. 一章", "### 13.2 子节", "见 §13.2 和 §13，也见 §13.9"].join("\n");
  const problems = danglingReferenceProblems(text);
  assert.equal(problems.length, 1, `自检失败：应只报 §13.9 一处悬空，实际 ${problems.join("；")}`);
  assert.match(problems[0], /13\.9/);
});

// ---------------------------------------------------------------- 真实文档

test("docs 结构：编号不重复、H1 不重复、不倒退、不跑出父节、无悬空引用", () => {
  const markdown = readFileSync(DOC_FILE, "utf8");
  const problems = documentProblems(markdown);
  assert.deepEqual(
    problems,
    [],
    `文档结构问题（一行一条，格式 文件:行:节号 —— ${DOC_FILE}）：\n`
      + problems.map((item) => `${DOC_FILE}:${item}`).join("\n"),
  );
  // 解析自检：抽不到东西时上面那条会"零问题"假绿
  assert.ok(parseHeadings(markdown).length > 0, "一个编号标题都没抽到——抽取口径失效了（这条闸会假绿）");
});
