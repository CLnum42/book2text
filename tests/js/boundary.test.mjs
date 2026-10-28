// 模块边界守门（R1 + R4）——规格来自 docs/refactor/reading-view-boundary.md §6。
//
// 纯文本静态检查，不加载 app.js、不依赖 DOM，毫秒级。
//
// **R1（依赖方向）**：`static/reading-view.js` 里不得出现 `app.js` 顶层声明过、且它**自己没有声明**的名字。
//   判定：S = app.js 的顶层声明名；L = reading-view.js 自己声明过的名字（任意缩进层级）；
//        I = reading-view.js 去注释/字符串后的标识符。断言 |I ∩ (S \ L)| == 0。
//   **第 3 步（L）不能省**：reading-view.js 自己声明了 `el`，app.js:28 也有 `const el`；
//   它还声明了 4 个 split 函数而 app.js 留着同名转发 stub。那是同名不同物，不是依赖。
//
// **R4（真实现份数 = 1）**：同名函数全仓库只许一份真实现；其余每份函数体 ≤6 行，
//   且只含 `window.ReadingView.x(...)` / `ReadingView.x(...)`。
//   这条取代了作废的"行数守恒（±30）"判据——IIFE 包装、依赖注入、转发 stub 都是搬运必然带的。
//
// **例外表**：`ALLOW` 必须为空；上限 3 条，每条要带 owner + 到期切片。
//
// **红过没有**（规格文档 §6 已记录，这里再复跑一次）：
// - R1 在 `7c1d00c`（Slice 1 原始提交）**红 5 处 / 4 个符号**：`reading-view.js:147` `currentView`
//   (app.js:105)、`:148` `measureReadingTops`、`:149` `readingPageNo`（两次）、`:149` `updateReadingPage`。
//   那 4 个符号全在同一个 resize 回调里——模块先于 app.js 加载，回调却要在 boot 之后才跑，
//   正是这个仓库一半 bug 的成因。
// - R1 在 `5d7e0ef`（改成注入 `onViewportResize`）**绿 0**。
// - R4 在下面三个变异上各红一次（矩阵见文件末尾「变异验证」）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// B2T_STATIC_DIR：把整个 static 目录指到别处（迁移复跑 / 变异验证用），默认仓库里的
const STATIC_DIR = process.env.B2T_STATIC_DIR
  || fileURLToPath(new URL("../../backend/book2text/static/", import.meta.url));
const APP_FILE = join(STATIC_DIR, "app.js");
// B2T_VIEW_JS：对历史版本跑同一条 R1（照 load-app.mjs 里 B2T_APP_JS 的做法）。
// 例：git show 7c1d00c:backend/book2text/static/reading-view.js > /tmp/rv-7c1d00c.js
//     B2T_VIEW_JS=/tmp/rv-7c1d00c.js node tests/js/run.mjs boundary
const VIEW_FILE = process.env.B2T_VIEW_JS || join(STATIC_DIR, "reading-view.js");

/** R1 例外表：必须为空；上限 3 条，每条要有 owner 与到期切片。 */
const ALLOW = [];

// ---------------------------------------------------------------- 文本工具

/**
 * 把注释与字符串字面量抹成空格，**保持长度与换行不变**，这样后续行号/列号还准。
 *
 * 支持的语法：`//`、`/* *\/`、`'…'`、`"…"`、模板字符串（整段抹掉，含 `${}` 里的表达式——
 * 已知取舍：模板里插值引用了 app.js 的名字不会被抓到。当前代码里没有这种用法，
 * 真出现了这条局限会在评审时被人工补上）。
 */
function stripCommentsAndStrings(source) {
  const out = source.split("");
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let k = i + 1;
      while (k < n) {
        if (source[k] === "\\") {
          k += 2;
          continue;
        }
        if (source[k] === quote) {
          k += 1;
          break;
        }
        k += 1;
      }
      blank(i, k);
      i = k;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

function lineOf(source, index) {
  let line = 1;
  for (let k = 0; k < index; k += 1) if (source[k] === "\n") line += 1;
  return line;
}

function columnOf(source, index) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return index - lineStart + 1;
}

/** app.js 顶层声明名 → 首次声明行。`^function` / `^async function` / `^(let|const|var)`，逗号拆多声明。 */
function topLevelDeclarations(source) {
  const found = new Map();
  const lines = source.split("\n");
  lines.forEach((raw, index) => {
    const line = raw.replace(/\/\/.*$/, "");
    const fn = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (fn) {
      if (!found.has(fn[1])) found.set(fn[1], index + 1);
      return;
    }
    const decl = /^(?:let|const|var)\s+(.+)$/.exec(line);
    if (!decl) return;
    // 多声明按逗号拆；解构声明（`const {a, b} = …`）跳过——不是"顶层名字"
    for (const part of decl[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) continue;
      const name = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (name && !found.has(name[1])) found.set(name[1], index + 1);
    }
  });
  return found;
}

/** 一个文件里声明过的名字（任意缩进层级）→ 首次声明的行号。 */
function declaredNames(stripped) {
  const found = new Map();
  const patterns = [
    /(?:^|[^\w$.])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|[^\w$])(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(stripped)) !== null) {
      if (!found.has(match[1])) found.set(match[1], lineOf(stripped, match.index));
    }
  }
  return found;
}

// ---------------------------------------------------------------- R1

test("R1：reading-view.js 不许引用 app.js 的顶层声明（模块先加载，引用即为时序隐患）", () => {
  const appSource = readFileSync(APP_FILE, "utf8");
  const viewSource = readFileSync(VIEW_FILE, "utf8");
  const appTop = topLevelDeclarations(appSource);
  const strippedView = stripCommentsAndStrings(viewSource);
  const viewOwn = declaredNames(strippedView);

  const allowed = new Set(ALLOW.map((item) => item.name));
  const violations = [];
  const identifier = /[A-Za-z_$][\w$]*/g;
  let match;
  while ((match = identifier.exec(strippedView)) !== null) {
    const name = match[0];
    if (!appTop.has(name)) continue;   // 不是 app.js 的顶层名字
    if (viewOwn.has(name)) continue;   // 模块自己声明了 → 同名不同物
    if (allowed.has(name)) continue;   // 例外表（必须为空）
    violations.push(
      `reading-view.js:${lineOf(strippedView, match.index)}:${columnOf(strippedView, match.index)} `
      + `用了 app.js:${appTop.get(name)} 的 ${name}`,
    );
  }

  assert.deepEqual(violations, [], `reading-view.js 引用了 ${violations.length} 处 app.js 的顶层声明`);
});

test("R1 例外表：为空，且不超过 3 条（每条要带 owner 与到期切片）", () => {
  assert.ok(ALLOW.length <= 3, `例外表 ${ALLOW.length} 条，超过上限 3`);
  assert.deepEqual(ALLOW, [], "例外表必须为空；真要破例，先让 Architect 在切片验收时加 owner 与到期切片");
});

// ---------------------------------------------------------------- R4

/** 提取所有 `function NAME(...) { … }` 的定义：名字、文件、行号、函数体原文。 */
function collectFunctionDefs(filePath) {
  const source = readFileSync(filePath, "utf8");
  const stripped = stripCommentsAndStrings(source);
  const defs = [];
  const head = /(?:^|[^\w$.])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = head.exec(stripped)) !== null) {
    const name = match[1];
    const openParen = stripped.indexOf("(", match.index);
    // 跳过参数列表，找到函数体的 `{`
    let depth = 0;
    let cursor = openParen;
    for (; cursor < stripped.length; cursor += 1) {
      if (stripped[cursor] === "(") depth += 1;
      else if (stripped[cursor] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const bodyStart = stripped.indexOf("{", cursor);
    if (bodyStart === -1) continue;
    let braces = 0;
    let bodyEnd = bodyStart;
    for (; bodyEnd < stripped.length; bodyEnd += 1) {
      if (stripped[bodyEnd] === "{") braces += 1;
      else if (stripped[bodyEnd] === "}") {
        braces -= 1;
        if (braces === 0) break;
      }
    }
    defs.push({
      name,
      file: filePath,
      line: lineOf(stripped, match.index),
      body: stripped.slice(bodyStart + 1, bodyEnd),          // 去注释/字符串后：判断"只含转发"
      bodyRaw: source.slice(bodyStart + 1, bodyEnd),         // 原文：数行数（注释行也算一行）
      source,
    });
  }
  return defs;
}

/**
 * 给一份函数定义分类：
 * - `stub`：≤6 行，且整段只有一个 ReadingView 转发调用 → 合法转发
 * - `stubTooLong`：内容看起来是转发，但超过 6 行 → 不合格（单独报行数，不混进"真实现"）
 * - `real`：真实现
 */
function classify(def) {
  // 行数用**原文**数：注释行、空行都算一行（先抹注释再数会被 trim 掉，7 行会误判成 1 行）。
  // 只裁掉紧贴大括号的首尾纯空行（`{\n…\n}` 这种）。
  const lines = def.bodyRaw.split("\n");
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const statement = def.body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/;$/, "")
    .trim();
  const forwards = /^(?:return\s+)?(?:window\.)?ReadingView\.[A-Za-z_$][\w$]*\s*\([\s\S]*\)$/.test(statement);
  if (!forwards) return { kind: "real" };
  if (lines.length > 6) return { kind: "stubTooLong", why: `函数体 ${lines.length} 行（上限 6）` };
  return { kind: "stub" };
}

test("R4：同名函数只许一份真实现，其余必须是 ≤6 行的薄转发", () => {
  const files = readdirSync(STATIC_DIR).filter((name) => name.endsWith(".js")).map((name) => join(STATIC_DIR, name));
  const byName = new Map();
  for (const file of files) {
    for (const def of collectFunctionDefs(file)) {
      const list = byName.get(def.name) || [];
      list.push(def);
      byName.set(def.name, list);
    }
  }

  const problems = [];
  for (const [name, defs] of byName) {
    const filesOfName = new Set(defs.map((item) => item.file));
    if (filesOfName.size < 2) continue;   // 只在一个文件里出现 → 不在本规则范围
    const classified = defs.map((item) => ({ def: item, verdict: classify(item) }));
    const real = classified.filter((item) => item.verdict.kind === "real").map((item) => item.def);
    const tooLong = classified.filter((item) => item.verdict.kind === "stubTooLong");
    const where = (item) => `${item.file.split("/").pop()}:${item.line}`;
    for (const item of tooLong) {
      problems.push(`函数 ${name} 的转发 ${where(item.def)} 不合格：${item.verdict.why}`);
    }
    if (real.length === 0) {
      problems.push(`函数 ${name} 找不到真实现（${defs.map(where).join(" / ")}）`);
      continue;
    }
    if (real.length > 1) {
      problems.push(`函数 ${name} 有两份真实现（${real.map(where).join(" / ")}）`);
      continue;
    }
  }

  assert.deepEqual(problems, [], problems.join("；"));
});

// ---------------------------------------------------------------- 变异验证（写进文件头，避免只在交付说明里）
//
// | 变异 | 实测（原始断言文本） |
// | --- | --- |
// | 把模块里 `applyReadingSplit` 的真实函数体复制进 app.js 的同名 stub | `函数 applyReadingSplit 有两份真实现（app.js:20872 / reading-view.js:56）` |
// | 把 app.js 的 stub 改成 7 行（调用 + 6 行注释） | `函数 applyReadingSplit 的转发 app.js:20872 不合格：函数体 7 行（上限 6）` |
// | 删掉 reading-view.js 里的真实现（只留转发） | `函数 applyReadingSplit 找不到真实现（app.js:20872 / reading-view.js:56）` |
// | 在 reading-view.js 里引用 `readingPageNo`（R1 的 7c1d00c 形态） | `reading-view.js 引用了 1 处 app.js 的顶层声明` |
//
// R1 的历史红：`B2T_VIEW_JS=/tmp/rv-7c1d00c.js node tests/js/run.mjs boundary` →
// `reading-view.js 引用了 5 处 app.js 的顶层声明`（currentView / measureReadingTops / readingPageNo×2 /
// updateReadingPage，行号 157–159），与 docs §6 记录的 5 处一致。
//
// 一个与本规则无关的既有发现（没在本测试里管，R4 只查**跨文件**同名）：
// app.js 自己有两份同名真实现 `adoptBlockSuggestion`（5999 / 12548）与
// `adoptAllHighSuggestions`（6021 / 12567）——后声明的覆盖前者。不是搬运造成的，但迟早要收拾。
