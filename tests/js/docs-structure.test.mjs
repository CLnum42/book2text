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

// 覆盖三份：规格书 + 决策记录 + 已知限制。写死一份等于另外两份没有回合——
// `docs/decisions.md` 里真实的 D-100 撞号就是 Doc 人工翻出来的。
const DOC_FILES = [
  "docs/refactor/reading-view-boundary.md",
  "docs/decisions.md",
  "docs/known-limitations.md",
].map((rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url)));

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

/**
 * 排序口径（2026-10-29 定，写死在这里免得以后两个人各读各的）：
 * **字母后缀排在数字子节之前** —— `12.1 → 12.1b → 12.1.1`。
 * 理由：`12.1b` 是"12.1 这个位置的插入修订"，而 `12.1.1` 是下一层；插入件必须在层之前，
 * 否则"13.2b 必须排在 13.2 之后、13.3 之前"那条（§20.9 ⑫）就和它自相矛盾。
 * 当前文档没有这种并存，`compareIds` 用缺段 = -1 恰好得到这个顺序——用夹具把它钉住。
 */

/** 行内代码（`` `…` ``）里的 `§` 不是引用，是示例；扫之前抹掉，避免"示例里的三级编号"被当成断链。 */
export function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, (chunk) => " ".repeat(chunk.length));
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
    // 记账记**数字前缀**：`12.1b` 不是 `12.1.1` 的父节（父节是 `12.1`），
    // 否则"三级 + 字母后缀"并存时会把合法的 `12.1b → 12.1.1` 判成跑出父节。
    lastAtDepth.set(depth, parsed.parts.join("."));
    // 更深层的历史要清掉，否则 `13.2` 之后出现 `13.3` 还留着旧的 `13.2.x`
    for (const key of [...lastAtDepth.keys()]) {
      if (key > depth) lastAtDepth.delete(key);
    }
  }

  return problems;
}

/**
 * 断链：`§N` / `§N.M[后缀]`（**任意深度**）的引用必须能在标题集合里找到。
 *
 * - **全深度**：只认 `§N` / `§N.M` 的版本对 `§18.1.4` 只会去查 `§18.1`——那节存在，
 *   于是悬空引用装闸也照样绿（Doc 实测）。口径必须与标题抽取同宽。
 * - **跨文档并集**：`decisions.md` 里的 `§19` / `§21.8` 指的是规格书里的节，
 *   按单文件判会把它们全判成断链（假红）。
 * - **行号必须是真的**：格式承诺是 `文件:行:节号`，写死 0 等于"报错指不出位置"。
 * - 行内代码里的 `§` 是示例，先抹掉。
 *
 * @param {string} markdown 待查文档
 * @param {Set<string>} knownIds 三份文档的标题 id 并集
 * @returns {string[]} `行:§id …` 形式的说明
 */
export function danglingReferenceProblems(markdown, knownIds) {
  const problems = [];
  stripFencedBlocks(markdown).split("\n").forEach((rawLine, index) => {
    const line = stripInlineCode(rawLine);
    for (const match of line.matchAll(/§\s*(\d+(?:\.\d+)*)([a-z]?)/g)) {
      const id = `${match[1]}${match[2] || ""}`;
      if (!knownIds.has(id)) {
        problems.push(`${index + 1}:§${id} 悬空引用（三份文档里都没有 §${id}）`);
      }
    }
  });
  return [...new Set(problems)];
}

/**
 * ID 型编号（`D-100` / `L-106`）的重复检测。
 *
 * **只对 decisions.md 开红**（2026-10-29 决定）：`known-limitations.md` 的 `L-106` 故意挂了 6 层
 * （本体 + 递归版 + 第 3–6 层），那 6 层要不要收成一个号是 Architect 的事，**闸不替人决定**。
 * 等 L 收干净了再加 L 规则——那时不需要例外表。
 *
 * **标记也算 ID**：`## D-004 修订` 抽出来是 `D-004修订`，与 `D-004` 不是同一个编号
 * （decisions.md 真有这一行；不把"修订"算进 ID，第一天就红一条真没问题的）。
 */
const ID_HEADING = /^(#{2,3})\s+([A-Z]+-\d+[a-z]?)(\s*修订)?/;

/** 抽到多少个 ID 型编号标题（解析自检用）。 */
export function idHeadingCount(markdown) {
  return stripFencedBlocks(markdown)
    .split("\n")
    .filter((line) => ID_HEADING.test(line)).length;
}

export function idHeadingProblems(markdown) {
  const problems = [];
  const seen = new Map();
  stripFencedBlocks(markdown).split("\n").forEach((line, index) => {
    const match = ID_HEADING.exec(line);
    if (!match) return;
    const id = `${match[2]}${(match[3] || "").replace(/\s+/g, "")}`;
    if (seen.has(id)) {
      problems.push(`${index + 1}:${id} 重复编号（第 ${seen.get(id)} 行已有同一个 ID）`);
    } else {
      seen.set(id, index + 1);
    }
  });
  return problems;
}

/** 真实文档的一次完整判定（失败信息按行排序，一行一条）。 */
export function docSetProblems(docs) {
  const problems = [];
  const knownIds = new Set();
  for (const { file, markdown } of docs) {
    for (const heading of parseHeadings(markdown)) knownIds.add(heading.id);
  }
  for (const { file, markdown, idRule } of docs) {
    const label = file.split("/docs/").pop();
    for (const item of structureProblems(markdown)) problems.push(`${label}:${item}`);
    for (const item of danglingReferenceProblems(markdown, knownIds)) problems.push(`${label}:${item}`);
    if (idRule === "decisions") {
      for (const item of idHeadingProblems(markdown)) problems.push(`${label}:${item}`);
    }
  }
  return problems.sort((a, b) => {
    const [fileA, lineA] = a.split(":");
    const [fileB, lineB] = b.split(":");
    if (fileA !== fileB) return fileA < fileB ? -1 : 1;
    return Number(lineA) - Number(lineB);
  });
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

test("docs 自检⑤：§X 指向不存在的节判红，且报出**真实行号**", () => {
  const text = ["## 13. 一章", "### 13.2 子节", "见 §13.2 和 §13，也见 §13.9"].join("\n");
  const known = new Set(parseHeadings(text).map((item) => item.id));
  const problems = danglingReferenceProblems(text, known);
  assert.equal(problems.length, 1, `自检失败：应只报 §13.9 一处悬空，实际 ${problems.join("；")}`);
  assert.match(problems[0], /13\.9/);
  // 格式承诺是 `文件:行:节号`：行号写死 0 等于报错指不出位置
  const line = Number(problems[0].split(":")[0]);
  assert.ok(line > 0, `自检失败：悬空引用报的行号是 ${line}——真红时人拿不到位置，只能全篇 grep`);
  assert.equal(line, 3, `自检失败：行号对了但位置不对（应为第 3 行，实际 ${line}）`);
});

test("docs 自检⑥：三级引用只查前两级会假绿——§12.1.9 必须红（§12.1 存在）", () => {
  const text = ["## 12. 一章", "### 12.1 子节", "见 §12.1.9"].join("\n");
  const known = new Set(parseHeadings(text).map((item) => item.id));
  const problems = danglingReferenceProblems(text, known);
  assert.equal(problems.length, 1, `自检失败：三级引用的错字放过了——${problems.join("；") || "（零问题）"}`);
  assert.match(problems[0], /12\.1\.9/);
});

test("docs 自检⑦：行内代码里的 § 是示例，不算引用", () => {
  const text = ["## 12. 一章", "### 12.1 子节", "写法是 `§12.1.9` 这种（示例，不是引用）"].join("\n");
  const known = new Set(parseHeadings(text).map((item) => item.id));
  assert.deepEqual(danglingReferenceProblems(text, known), [], "自检失败：行内代码里的示例被当成断链");
});

test("docs 自检⑧：两个 ## D-100 判红，D-004 与 D-004 修订 不算重复", () => {
  const red = idHeadingProblems(["## D-100 | 第一条", "## D-100 | 第二条"].join("\n"));
  assert.ok(red.length > 0, "自检失败：两个 D-100 也放过——decisions.md 真的撞过号");
  const fine = idHeadingProblems([
    "## D-004 | 本体",
    "## D-004 修订 | 改了一条",
    "## D-111 | 另一个",
  ].join("\n"));
  assert.deepEqual(fine, [], `自检失败：修订版被当成撞号——${fine.join("；")}`);
});

test("docs 自检⑨：L-106 与 L-106b 是不同编号（后缀字母不并号）", () => {
  const problems = idHeadingProblems(["### L-106 本体", "### L-106b 插入件"].join("\n"));
  assert.deepEqual(problems, [], `自检失败：L-106 与 L-106b 被并成一个号——${problems.join("；")}`);
});

test("docs 自检⑩：排序口径——字母后缀在数字子节之前（12.1 → 12.1b → 12.1.1 判绿）", () => {
  const text = ["## 12. 一章", "### 12.1 子节", "### 12.1b 插入件", "### 12.1.1 下一层"].join("\n");
  assert.deepEqual(
    structureProblems(text),
    [],
    "自检失败：`12.1b` 与 `12.1.1` 的先后口径变了（本节头写着：后缀在前、子节在后）",
  );
});

// ---------------------------------------------------------------- 真实文档

const DOC_SET = DOC_FILES.map((file) => ({
  file,
  markdown: readFileSync(file, "utf8"),
  idRule: file.endsWith("decisions.md") ? "decisions" : null,
}));

test("docs 结构：三份文档的编号不重复、H1 不重复、不倒退、不跑出父节、无悬空引用", () => {
  const problems = docSetProblems(DOC_SET);
  assert.deepEqual(problems, [], `文档结构问题（一行一条）：\n${problems.join("\n")}`);
  // 解析自检：抽不到东西时上面那条会"零问题"假绿
  for (const { file, markdown } of DOC_SET) {
    const numeric = parseHeadings(markdown).length;
    const idCount = idHeadingCount(markdown);
    // decisions.md 只用 ID 型编号（D-xxx），known-limitations 两种都有——按"任一抽到"判解析是否工作
    assert.ok(
      numeric + idCount > 0,
      `${file} 数字编号与 ID 型编号都没抽到——抽取口径失效（这条闸会假绿）`,
    );
  }
});

test("docs 已知答案回归：decisions.md 里只有一个 D-100 标题（Doc 的 grep 口径曾数成两个）", () => {
  const decisions = DOC_SET.find((item) => item.file.endsWith("decisions.md"));
  const ids = parseHeadings(decisions.markdown).map((item) => item.id);
  // 已知答案：D-100 撞号后，「后台重活」那条已改成 D-111，所以标题里只剩一个 D-100。
  // 注意：正文里还有"原 D-100"这类说明文字——**按标题 ID 抽才对**，
  // `grep -oE 'D-[0-9]+'` 会把说明文字也算进去，得出"D-100 没修"的错结论（Doc 踩过）。
  assert.equal(ids.filter((id) => id === "D-100").length, 0,
    "编号标题里不该有 D-100（decisions 的 D 系列走 ID 型标题，不进数字序列）");
  assert.equal(idHeadingProblems(decisions.markdown).length, 0, "decisions.md 的 ID 型编号有重复");
});
