// 模块边界守门（R1/R3/R4/R4b/R5/R7/R8/R9/R13）+ 特征测试契约（A5）——
// 规格来自 docs/refactor/reading-view-boundary.md §6、§16、§17、§18.2。
//
// 纯文本静态检查，不加载 app.js、不依赖 DOM，毫秒级。
//
// **R1（依赖方向）**：`static/reading-view.js` 里不得出现 `app.js` 顶层声明过、且它**自己没有声明**的名字。
//   只看**自由引用**：属性访问 `a.name` / `a?.name` 与对象字面量 key 都不算（`injected.gotoNextUnreviewed`
//   不是对全局 gotoNextUnreviewed 的引用；把注入键改成别名反而让名字和真函数对不上）。
//   判定：S = app.js 的顶层声明名；L = reading-view.js 自己声明过的名字（任意缩进层级）；
//        I = reading-view.js 去注释/字符串后的标识符。断言 |I ∩ (S \ L)| == 0。
//   **第 3 步（L）不能省**：reading-view.js 自己声明了 `el`，app.js:28 也有 `const el`；
//   它还声明了 4 个 split 函数而 app.js 留着同名转发 stub。那是同名不同物，不是依赖。
//
// **R4-dup（真实现份数 = 1）**：跨文件同名函数只许一份真实现；其余每份函数体 ≤6 行，
//   且只含 `window.ReadingView.x(...)` / `ReadingView.x(...)`。
//   这条取代了作废的"行数守恒（±30）"判据——IIFE 包装、依赖注入、转发 stub 都是搬运必然带的。
//   注意编号：Architect 文档里的 R4 是"共享状态只注入不缓存"，这里是 R4-dup，别混。
//
// **R4b-same-file**：同一文件里同名顶层声明出现两次及以上 → 后者覆盖前者，未申报即红。
//   只看**缩进 0**：函数内部的两个 `const row = …` 是不同作用域，不互相覆盖
//   （当前 app.js 里 `row` 6560/13064、`target` 8338/10445 就都是缩进 2 的局部变量）。
//   别名也算同名：顶层 `const foo = (…) =>` 与 `function foo(…)` 同属一个作用域。
//
// **R7**：`index.html` 不许出现 `<script type="module">`（默认 deferred，会改 boot 时序，
//   这仓库一半 bug 是时序问题）；且 `static/*-view.js` **每一个**的 `<script>` 都必须在 `app.js` 之前。
//   名单**不手写**：从 static 目录列 `*-view.js`。library 落盘时漏了 library-view.js 的标签，
//   静态门全绿、页面目录页永远空着——手写名单就是那次漏法的成因，名单必须从目录来。
//
// **例外表**：`ALLOW` 必须为空；上限 3 条，每条要带 owner + 到期切片。
//
// **两条守卫互补**（同一次误删的两个方向，单条只覆盖一半）：
// - R9 抓"用了没声明"：`readingTreeOpen` 在 19374 被引用、全文件无声明；
// - R5 抓"声明没了但 OWNERS 表还挂着"：`readingTreeOpen` 的 owner 是 app.js，状态却不存在。
// 删一个声明，两条会同时红。同理 R3（块外引用）与 R4b（同文件重名覆盖）也是一对。
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
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import {
  BRIDGE_EXCEPTIONS,
  BRIDGE_EXCEPTION_MAX,
  checkBridgeExceptions,
  evaluateEdges,
  evaluateEdgeSources,
  moduleShowViewInSource,
} from "./edge-ratchet.mjs";
import {
  evaluateFeatureContract, commitContractProblems, tableBlockRanges, isContractPath,
} from "./feature-contract.mjs";
// R9 专用：保留模板 `${…}` 插值的去注释版本（本文件另有一份旧的去注释实现，只抹代码不抹模板）
import { stripPreservingTemplateExpressions } from "./static-scan.mjs";

// B2T_STATIC_DIR：把整个 static 目录指到别处（迁移复跑 / 变异验证用），默认仓库里的
const STATIC_DIR = process.env.B2T_STATIC_DIR
  || fileURLToPath(new URL("../../backend/book2text/static/", import.meta.url));
// B2T_APP_JS：把 app.js 指到别处（历史版本复跑 / 变异验证），和 load-app.mjs 同一个变量名
const APP_FILE = process.env.B2T_APP_JS || join(STATIC_DIR, "app.js");
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
 * 支持的语法：`//`、`/* *\/`、`'…'`、`"…"`、模板字符串、**正则字面量**（`/["']/` 这种不认会把
 * 后面一大片代码当成字符串吞掉——app.js 里就有）。模板字符串整段抹掉，含 `${}` 里的表达式——
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
  // 正则字面量的判定：前一个有效字符是这些（或行首 / return 之类关键字）时，`/` 开的是正则
  const REGEX_PRECEDERS = "([{=,:;!&|?+-*%~^<>";
  const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|instanceof|case|in|of|void|delete|new|throw)\s*$/;
  const looksLikeRegex = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(source[k])) k -= 1;
    if (k < 0) return true;
    if (REGEX_PRECEDERS.includes(source[k])) return true;
    return KEYWORD_BEFORE_REGEX.test(source.slice(Math.max(0, k - 12), k + 1));
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
    } else if (ch === "/" && looksLikeRegex(i)) {
      // 正则字面量：跳过转义与字符类 `[...]`，找到收尾的 `/`
      let k = i + 1;
      let inClass = false;
      while (k < n) {
        const cur = source[k];
        if (cur === "\\") {
          k += 2;
          continue;
        }
        if (cur === "[") inClass = true;
        else if (cur === "]") inClass = false;
        else if (cur === "/" && !inClass) {
          k += 1;
          break;
        } else if (cur === "\n") {
          break;   // 没闭合就按除法处理，别吞掉整份文件
        }
        k += 1;
      }
      blank(i, k);
      i = k;
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

/**
 * 只去注释与正则字面量，**保留字符串**——提取 `el("id")` / `querySelector("#id")` 要用到字符串。
 * 正则字面量同样要识别，否则 `/["']/` 会把后面的字符串当成未闭合字符串吞掉。
 */
function stripCommentsOnly(source) {
  const out = source.split("");
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const REGEX_PRECEDERS = "([{=,:;!&|?+-*%~^<>";
  const looksLikeRegex = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(source[k])) k -= 1;
    if (k < 0) return true;
    return REGEX_PRECEDERS.includes(source[k]);
  };
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop); i = stop;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop); i = stop;
    } else if (ch === "/" && looksLikeRegex(i)) {
      let k = i + 1; let inClass = false;
      while (k < n) {
        const cur = source[k];
        if (cur === "\\") { k += 2; continue; }
        if (cur === "[") inClass = true;
        else if (cur === "]") inClass = false;
        else if (cur === "/" && !inClass) { k += 1; break; }
        else if (cur === "\n") break;
        k += 1;
      }
      blank(i, k); i = k;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch; let k = i + 1;
      while (k < n) {
        if (source[k] === "\\") { k += 2; continue; }
        if (source[k] === quote) { k += 1; break; }
        k += 1;
      }
      i = k;   // 字符串保留
    } else i += 1;
  }
  return out.join("");
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

/**
 * R1 的判定内核（纯函数，自检夹具直接喂合成源码）。
 * @returns {string[]} 违规列表；空 = 合规
 */
function r1Problems(appSource, viewSource, fileName = "reading-view.js") {
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
    // **属性访问不是自由引用**：`injected.gotoNextUnreviewed` / `a?.name` 里的名字
    // 与全局绑定无关（与 R5/R9 同一条口径）。这里漏掉会把所有"注入键=真函数名"误报成依赖。
    if ((strippedView[match.index - 1] || "") === ".") continue;
    // 对象字面量的 key（`{ gotoNextUnreviewed: 1 }`）也不是引用
    const prevChar = strippedView.slice(Math.max(0, match.index - 8), match.index).trimEnd().slice(-1);
    const nextChar = strippedView.slice(match.index + name.length).trimStart().slice(0, 1);
    if ((prevChar === "{" || prevChar === ",") && nextChar === ":") continue;
    violations.push(
      `${fileName}:${lineOf(strippedView, match.index)}:${columnOf(strippedView, match.index)} `
      + `用了 app.js:${appTop.get(name)} 的 ${name}`,
    );
  }
  return violations;
}

test("R1：reading-view.js 不许引用 app.js 的顶层声明（模块先加载，引用即为时序隐患）", () => {
  const appSource = readFileSync(APP_FILE, "utf8");
  const viewSource = readFileSync(VIEW_FILE, "utf8");
  const violations = r1Problems(appSource, viewSource);
  assert.deepEqual(violations, [], `reading-view.js 引用了 ${violations.length} 处 app.js 的顶层声明`);
});

/** R1 自检（§20.9 ⑬：闸必须能被样例喂红）。 */
test("R1 自检：模块调 app.js 的裸函数必须红，属性访问 / 自己声明 / 对象 key 必须不红", () => {
  const app = "function gotoNextUnreviewed() { return 1; }\nconst sharedState = { a: 1 };\n";
  // 红：裸调用
  assert.ok(
    r1Problems(app, "function tick() { gotoNextUnreviewed(); }").length > 0,
    "R1 自检失败：模块里裸调 app.js 顶层函数也放过",
  );
  // 红：裸地读 app.js 的顶层状态
  assert.ok(
    r1Problems(app, "function tick() { return sharedState; }").length > 0,
    "R1 自检失败：模块里裸读 app.js 顶层状态也放过",
  );
  // 绿：属性访问（注入键 = 真函数名，这是生产写法）
  assert.deepEqual(
    r1Problems(app, "function tick() { injected.gotoNextUnreviewed(); }"),
    [],
    "R1 自检失败：injected.xxx 被误报成依赖",
  );
  // 绿：模块自己声明了同名符号
  assert.deepEqual(
    r1Problems(app, "function gotoNextUnreviewed() { return 2; }\nfunction tick() { gotoNextUnreviewed(); }"),
    [],
    "R1 自检失败：模块自己声明同名函数也被误报",
  );
  // 绿：对象字面量的 key
  assert.deepEqual(
    r1Problems(app, "const deps = { gotoNextUnreviewed: 1 };"),
    [],
    "R1 自检失败：对象 key 被误报成引用",
  );
});

test("R1 例外表：为空，且不超过 3 条（每条要带 owner 与到期切片）", () => {
  assert.ok(ALLOW.length <= 3, `例外表 ${ALLOW.length} 条，超过上限 3`);
  assert.deepEqual(ALLOW, [], "例外表必须为空；真要破例，先让 Architect 在切片验收时加 owner 与到期切片");
});

// ---------------------------------------------------------------- R4

/** 提取所有 `function NAME(...) { … }` 的定义：名字、文件、行号、函数体原文。 */
function collectFunctionDefsFromSource(filePath, source) {
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

/** 从磁盘收同名函数定义（自检夹具用不了文件，所以内核走 `...FromSource`）。 */
function collectFunctionDefs(filePath) {
  return collectFunctionDefsFromSource(filePath, readFileSync(filePath, "utf8"));
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

/** R4-dup 的判定内核（纯函数：`[{file, source}]` → 违规）。 */
function r4dupProblems(fileSources) {
  const byName = new Map();
  for (const { file, source } of fileSources) {
    for (const def of collectFunctionDefsFromSource(file, source)) {
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
  return problems;
}

test("R4-dup（真实现份数=1）：同名函数只许一份真实现，其余必须是 ≤6 行的薄转发", () => {
  const problems = r4dupProblems(
    readdirSync(STATIC_DIR)
      .filter((name) => name.endsWith(".js"))
      .map((name) => ({ file: join(STATIC_DIR, name), source: readFileSync(join(STATIC_DIR, name), "utf8") })),
  );
  assert.deepEqual(problems, [], problems.join("；"));

  // R4-dup 延伸：**重开的唯一入口是模块的 reload()**（L1 第一笔 eb02997 之后）
  // app.js 不许再长回自己的实现，也不许绕过模块直接调内部函数。
  // 用去注释后的代码判：注释里提到 readingReloadAfterBatch 是允许的（说明历史），代码里不许出现。
  const appCode = stripCommentsAndStrings(readFileSync(APP_FILE, "utf8"));
  const viewCode = stripCommentsAndStrings(readFileSync(VIEW_FILE, "utf8"));
  const appImpl = (appCode.match(/^(?:async\s+)?function readingReloadAfterBatch\s*\(/gm) || []).length;
  const appMentions = (appCode.match(/\breadingReloadAfterBatch\b/g) || []).length;
  const viewImpls = (viewCode.match(/(?:^|\n)\s*(?:async\s+)?function readingReloadAfterBatch\s*\(/g) || []).length;
  const reloadCalls = (appCode.match(/window\.ReadingView\.reload\s*\(/g) || []).length;
  assert.equal(appImpl, 0, "app.js 里又长出了 readingReloadAfterBatch 的实现——重开必须只走模块 reload()");
  assert.equal(appMentions, 0, `app.js 仍提到 readingReloadAfterBatch（${appMentions} 处）：本地实现或绕过模块的直接调用都不许`);
  assert.equal(viewImpls, 1, `reading-view.js 里 readingReloadAfterBatch 的定义应恰好 1 处，实际 ${viewImpls}`);
  assert.ok(reloadCalls >= 1, "app.js 里找不到 window.ReadingView.reload() 调用——重开入口断了");

  // R4-dup 延伸：**过滤器 setter 的接线不许断**（L2 笔2 把 setReadingFilter 搬进模块后）
  // 模块里：filter 控件 change → 本地 setReadingFilter(value) → injected.setReadingFilterValue(value)
  // 外壳里：注入回调把值写进 readingFilter（状态 owner = app.js，R5 管归属）
  // 为什么放在这里而不是特征测试：A5 禁止特征测试断言调用次数/注入面；
  // 这条是纯静态接线检查，抓的是"搬完之后 setter 链路断了"这类回归。
  // 注意：viewCode 是**去字符串**后的文本，`el("reading-filter")` 的字符串已被抹空。
  // 断言里要匹配字符串字面量，必须用只去注释的版本。
  const viewText = stripCommentsOnly(readFileSync(VIEW_FILE, "utf8"));
  const appText = stripCommentsOnly(readFileSync(APP_FILE, "utf8"));
  assert.ok(
    /el\("reading-filter"\)\.addEventListener\("change"/.test(viewText),
    "reading-view.js 里找不到 reading-filter 的 change 监听",
  );
  assert.ok(
    /setReadingFilter\(\s*event\.target\.value\s*\)/.test(viewText),
    "reading-view.js 的 filter 监听没有把值交给 setReadingFilter",
  );
  // L12：状态迁进模块后不再有 `injected.setReadingFilterValue` 这条链。
  // 继续断言注入回调 = 让"状态搬家"本身把测试撞红。改成锁**行为**：
  // 值写进模块内的 `readingFilter`，且同一函数里立刻重画（用户看到的列表才会变）。
  assert.ok(
    /function setReadingFilter\(value\)\s*\{\s*readingFilter = value;/.test(viewText),
    "reading-view.js 的 setReadingFilter 没把值写进 readingFilter",
  );
  assert.ok(
    /readingFilter = value;[\s\S]{0,80}renderReading\(\{ reset: true \}\)/.test(viewText),
    "setReadingFilter 改了 filter 却没重画——用户看到的列表不会变",
  );
  assert.ok(
    !/setReadingFilterValue\s*:/.test(appText),
    "app.js 里还留着 setReadingFilterValue 注入项——状态已在模块内，这条注入是死接线",
  );
});

// ---------------------------------------------------------------- R7：加载时序

/**
 * 这个仓库的加载顺序靠"经典脚本 + `reading-view.js` 在 `app.js` 之前"撑住。
 * `type="module"` 默认 deferred，会改 boot 时序——这仓库一半 bug 是时序问题。
 */
/**
 * R7 的判定内核（纯函数，自检夹具喂合成 html + 合成文件名单）。
 *
 * `viewFiles` 必须是**目录里真实存在**的 `*-view.js` 名单——不传就红（fail closed）：
 * 空名单会让"每个模块都有 script"变成恒真，闸会退化成空转。
 */
function r7Problems(html, viewFiles) {
  const problems = [];
  if (!Array.isArray(viewFiles) || viewFiles.length === 0) {
    return ["R7 拿不到 view 文件名单（static 目录里没有 *-view.js）——空名单会让这条闸空转，按红处理"];
  }
  const moduleTags = html.match(/<script[^>]*\btype\s*=\s*["']module["'][^>]*>/gi) || [];
  if (moduleTags.length > 0) {
    problems.push(`index.html 出现了 <script type="module">：会改 boot 时序，本项目禁用（${moduleTags.join("、")}）`);
  }
  const appAt = html.indexOf("/static/app.js");
  if (appAt === -1) problems.push("index.html 里没有 app.js 的 <script>");
  for (const file of viewFiles) {
    const at = html.indexOf(`/static/${file}`);
    if (at === -1) {
      problems.push(`index.html 里没有 ${file} 的 <script>——文件存在但没加载，window 接口是 undefined，`
        + "模块里全是 ?. 空转，页面静默空白而所有静态门全绿");
      continue;
    }
    if (appAt !== -1 && at > appAt) {
      problems.push(`${file} 必须在 app.js 之前加载（现在顺序反了：view=${at} app=${appAt}）`);
    }
  }
  // 反向：index.html 加载了 static 目录里不存在的 *-view.js（拼错文件名 = 404 静默）
  for (const match of html.matchAll(/\/static\/([\w.-]+-view\.js)/g)) {
    if (!viewFiles.includes(match[1])) {
      problems.push(`index.html 加载了 /static/${match[1]}，但 static 目录里没有这个文件（文件名拼错了？）`);
    }
  }
  return problems;
}

/** R4-dup 自检（§20.9 ⑬）。 */
test("R4-dup 自检：两份真实现必须红，≤6 行转发必须绿，单文件同名不归它管", () => {
  const red = r4dupProblems([
    { file: "app.js", source: "function tick() {\n  return 1;\n}\n" },
    { file: "x-view.js", source: "function tick() {\n  return 2;\n}\n" },
  ]);
  assert.ok(red.some((item) => item.includes("两份真实现")), `R4-dup 自检失败：两份真实现也放过——${red.join("；")}`);

  // 注意：`classify()` 认的转发桩形态目前**只认 ReadingView**
  // （`window.ReadingView.x(...)`）；别的模块的转发会被判成真实现。这是已知限制，
  // 试点的做法是"第一个模块之外的转发不让存在"（切片时不切"调用方还在 app.js"的函数）。
  const green = r4dupProblems([
    { file: "app.js", source: "function tick() {\n  return window.ReadingView.tick();\n}\n" },
    { file: "x-view.js", source: "function tick() {\n  return 2;\n}\n" },
  ]);
  assert.deepEqual(green, [], `R4-dup 自检失败：薄转发被误报——${green.join("；")}`);

  const single = r4dupProblems([{ file: "x-view.js", source: "function tick() { return 1; }\nfunction tick() { return 2; }\n" }]);
  assert.deepEqual(single, [], "R4-dup 自检失败：同一文件内的重名不归这条管（那是 R4b）");
});

test("R7：每个 static/*-view.js 都必须在 app.js 之前加载（名单从目录来）", () => {
  const indexPath = join(STATIC_DIR, "index.html");
  let html;
  try {
    html = readFileSync(indexPath, "utf8");
  } catch {
    assert.fail(`找不到 ${indexPath}：B2T_STATIC_DIR 指向的目录必须包含 index.html`);
    return;
  }
  const viewFiles = readdirSync(STATIC_DIR).filter((name) => /-view\.js$/.test(name)).sort();
  assert.ok(viewFiles.length >= 2,
    `static 目录里只找到 ${viewFiles.length} 个 *-view.js（${viewFiles.join("、")}）——目录指错了吧？`);
  const problems = r7Problems(html, viewFiles);
  assert.deepEqual(problems, [], problems.join("\n"));
});

/** R7 自检（§20.9 ⑬）。 */
test("R7 自检：少一个 view / 顺序反了 / type=module / 空名单都必须红，正常写法必须绿", () => {
  const views = ["reading-view.js", "preview-view.js", "library-view.js"];
  const good = [
    '<script src="/static/reading-view.js"></script>',
    '<script src="/static/preview-view.js"></script>',
    '<script src="/static/library-view.js"></script>',
    '<script src="/static/app.js"></script>',
  ].join("\n");
  assert.deepEqual(r7Problems(good, views), [], "R7 自检失败：正常写法被误报");

  const missingOne = good.replace('<script src="/static/library-view.js"></script>\n', "");
  assert.ok(
    r7Problems(missingOne, views).some((item) => item.includes("library-view.js")),
    "R7 自检失败：删掉 library-view.js 的 script 也放过——这正是落盘时漏掉的那种",
  );

  const reordered = [
    '<script src="/static/library-view.js"></script>',
    '<script src="/static/app.js"></script>',
    '<script src="/static/reading-view.js"></script>',
  ].join("\n");
  assert.ok(
    r7Problems(reordered, views).some((item) => item.includes("顺序反了")),
    "R7 自检失败：view 排到 app.js 之后也放过",
  );

  assert.ok(
    r7Problems('<script type="module" src="/static/app.js"></script>\n<script src="/static/reading-view.js"></script>', ["reading-view.js"]).length > 0,
    "R7 自检失败：type=module 也放过",
  );

  assert.ok(
    r7Problems(good, []).length > 0,
    "R7 自检失败：空名单被当成绿——名单为空时这条闸会空转",
  );

  assert.ok(
    r7Problems('<script src="/static/ghost-view.js"></script>\n<script src="/static/app.js"></script>', ["reading-view.js"])
      .some((item) => item.includes("ghost-view.js")),
    "R7 自检失败：加载了不存在的 *-view.js 也放过（拼错文件名 = 404 静默）",
  );
});

// ---------------------------------------------------------------- R6 / R2：视图模块的对外接口

/**
 * **规格：docs/refactor/reading-view-boundary.md §20**
 *
 * - **R6（一个文件一个窗口接口对象）**：`static/*-view.js` 里对 `window.XxxYyy =` 的赋值必须**恰好 1 处**，
 *   且名字由文件名决定（`preview-view.js` → `PreviewView`，`reading-view.js` → `ReadingView`）。
 *   为什么：接口是模块唯一的对外面；两个接口对象 = 调用方不知道该记哪个，导出面也没法守（R8）。
 * - **R2（视图间互引）**：`x-view.js` 里不许出现 `window.YView`（Y ≠ X）的任何引用。
 *   跨视图能力一律走 `init(deps)` 注入——直接摸对方的全局对象，等于把"模块先加载"的时序假设
 *   从 app.js 搬到模块之间，谁先加载谁后加载又变成运气。
 *
 * 两条都是**纯文本**判定（去注释/字符串后扫），喂合成样例就能红（见各自的"自检"用例）。
 */
function expectedInterfaceName(fileName) {
  const base = fileName.replace(/\.js$/, "").replace(/-view$/, "");
  return base.split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("") + "View";
}

/**
 * 例外表：**调试/统计埋点**（`window.__b2t*`）。它们不是"模块接口"，是给 QA 与单测看的旁路数据。
 *
 * 但也不许无限长：每条带 owner 与到期点，`MAX` 只降不升，**条目必须真的还在源码里**
 * （删埋点要同批删表项——和 R4b/R3 的例外表同一条纪律：表不许变成墓地）。
 * 新增一个 `window.__b2tXxx = …` 而不登记 = 红：接口面就是这么一点点被埋点撑大的。
 */
const WINDOW_HOOK_EXCEPTIONS = [
  { name: "__b2tWordBoxStats", owner: "TestDev", expires: "字框映射问题关闭" },
  { name: "__b2tPagePin", owner: "DevLead", expires: "页同步问题关闭" },
  { name: "__b2tReadingMetrics", owner: "QA", expires: "审校性能验收完成" },
  { name: "__b2tPageSync", owner: "QA", expires: "页同步验收完成" },
  { name: "__b2tPageSyncLog", owner: "QA", expires: "页同步验收完成" },
  { name: "__b2tNextLog", owner: "QA", expires: "队列验收完成" },
  { name: "__b2tTextCheckFails", owner: "QA", expires: "文本核对验收完成" },
  { name: "__b2tPreviewMetrics", owner: "QA", expires: "预览性能验收完成" },
  { name: "__b2tPreviewTileTops", owner: "QA", expires: "预览性能验收完成" },
  { name: "__b2tIndexMetrics", owner: "QA", expires: "目录确认性能验收完成" },
  { name: "__b2tIndexBlocksMs", owner: "QA", expires: "目录确认性能验收完成" },
  { name: "__b2tIndexTops", owner: "QA", expires: "目录确认性能验收完成" },
];
const WINDOW_HOOK_MAX = 12;   // 只降不升

/** R6 的判定内核（独立出来，好让自检喂合成样例）。 */
function windowInterfaceProblems(fileName, source) {
  const text = stripCommentsAndStrings(source);
  // 只认"整条 window.NAME = 值"（`window.addEventListener(…)` 是调用，不是赋值；
  // `window.foo.bar = …` 是 foo 内部的事，也不算露接口）
  const assigned = [...text.matchAll(/(?<![\w$.])window\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)]
    .map((match) => match[1]);
  // 先按**命名约定**滤掉埋点，再看还剩几个接口对象。
  // 第一版只滤"已登记"的埋点，于是新埋点会被报成"露了 3 个接口对象（…、PreviewView）"——
  // 文案把下一个人带偏（他会去数接口，而不是去登记埋点）。顺序必须是：先分类，再判数量。
  const interfaces = assigned.filter((name) => !name.startsWith("__b2t"));
  const expected = expectedInterfaceName(fileName);
  const problems = [];
  if (interfaces.length === 0) problems.push(`${fileName}: 没有 window.XxxYyy = … 接口对象——模块对外没有面`);
  if (interfaces.length > 1) {
    problems.push(`${fileName}: 露了 ${interfaces.length} 个 window 接口对象（${interfaces.join("、")}），一个文件只许 1 个`);
  }
  for (const name of interfaces) {
    if (name !== expected) problems.push(`${fileName}: 接口对象叫 ${name}，按文件名应为 ${expected}`);
  }
  return problems;
}

/**
 * 埋点三件事（只对**真实文件**跑；合成样例里没有那些埋点，跑它只会误报）：
 * ① 新埋点必须登记；② 登记了但源码里没有 = 表过期；③ 条目数必须等于 MAX（只降不升）。
 */
function windowHookProblems(fileName, source) {
  const text = stripCommentsAndStrings(source);
  const assigned = [...text.matchAll(/(?<![\w$.])window\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)]
    .map((match) => match[1]);
  const registered = new Set(WINDOW_HOOK_EXCEPTIONS.map((item) => item.name));
  const problems = [];
  // 判据是"**出现即登记**"，不是"每个 view 文件都得有这 7 个埋点"。
  // 一个文件里没有任何埋点完全合法（preview-view.js 就没有）；有就必须登记。
  for (const name of assigned) {
    if (name.startsWith("__b2t") && !registered.has(name)) {
      problems.push(`${fileName}: 未登记的 window 埋点 ${name} —— 新增埋点要进 WINDOW_HOOK_EXCEPTIONS（带 owner 与到期点）`);
    }
  }
  return problems;
}

/**
 * 例外表本身的两条（**跨所有 view 文件**判，不能按文件判）：
 * 登记了但全仓库都没有 → 表过期；条目数必须等于 MAX（只降不升）。
 */
function hookTableProblems(allSources) {
  const assigned = new Set(
    allSources.flatMap(({ source }) => [...stripCommentsAndStrings(source)
      .matchAll(/(?<![\w$.])window\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)]
      .map((match) => match[1])),
  );
  const problems = [];
  for (const item of WINDOW_HOOK_EXCEPTIONS) {
    if (!assigned.has(item.name)) {
      problems.push(`例外表挂着不存在的埋点 ${item.name} —— 删埋点请同批删表项`);
    }
  }
  if (WINDOW_HOOK_EXCEPTIONS.length !== WINDOW_HOOK_MAX) {
    problems.push(`埋点例外 ${WINDOW_HOOK_EXCEPTIONS.length} 条，MAX=${WINDOW_HOOK_MAX}：删条目必须同批改 MAX（只降不升）`);
  }
  return problems;
}

/** R2 的判定内核（独立出来，好让自检喂合成样例）。 */
function crossViewProblems(fileName, source) {
  const own = expectedInterfaceName(fileName);
  const text = stripCommentsAndStrings(source);
  const problems = [];
  for (const match of text.matchAll(/(?<![\w$.])window\s*\.\s*([A-Za-z_$][\w$]*View)\b/g)) {
    if (match[1] === own) continue;                       // 自己的接口
    problems.push(
      `${fileName}: 引用了别的视图的接口 window.${match[1]}——跨视图能力必须走 init(deps) 注入`,
    );
  }
  return problems;
}

const VIEW_MODULES = readdirSync(STATIC_DIR).filter((name) => name.endsWith("-view.js")).sort();

test("R6：每个视图模块恰好露一个 window.XxxView，名字由文件名决定", () => {
  assert.ok(VIEW_MODULES.length > 0, `static 目录里一个 *-view.js 都没有（${STATIC_DIR}）——这条闸会空转`);
  const problems = [];
  const allSources = VIEW_MODULES.map((fileName) => ({
    fileName,
    source: readFileSync(join(STATIC_DIR, fileName), "utf8"),
  }));
  for (const { fileName, source } of allSources) {
    problems.push(...windowInterfaceProblems(fileName, source));
    problems.push(...windowHookProblems(fileName, source));
  }
  problems.push(...hookTableProblems(allSources));
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("R2：视图模块之间不许直接引用对方的 window 接口", () => {
  assert.ok(VIEW_MODULES.length > 0, `static 目录里一个 *-view.js 都没有（${STATIC_DIR}）——这条闸会空转`);
  const problems = [];
  for (const fileName of VIEW_MODULES) {
    problems.push(...crossViewProblems(fileName, readFileSync(join(STATIC_DIR, fileName), "utf8")));
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

/**
 * 两条的自检（L-106 第四层：闸必须能被样例喂红）。
 * 合成样例 = 将来第二个模块最可能的两种错法：接口名字错、跨视图直接摸对方全局对象。
 */
test("R6/R2 自检：接口名字错、多露一个接口、跨视图引用，都必须红", () => {
  // R6：名字错
  assert.ok(
    windowInterfaceProblems("preview-view.js", "window.ReadingView = { init };").length > 0,
    "R6 自检失败：preview-view.js 露 ReadingView 也放过了——名字没按文件名校验",
  );
  // R6：没露接口
  assert.ok(
    windowInterfaceProblems("preview-view.js", "function init() {}").length > 0,
    "R6 自检失败：模块一个接口对象都没有也放过",
  );
  // R6：露了两个
  assert.ok(
    windowInterfaceProblems("preview-view.js", "window.PreviewView = {};\nwindow.Helper = {};").length > 0,
    "R6 自检失败：一个文件两个 window 接口对象也放过",
  );
  // R6：正例必须绿
  assert.deepEqual(
    windowInterfaceProblems("preview-view.js", "window.PreviewView = { init, enter };"),
    [],
    "R6 自检失败：正例被误报",
  );
  // R6：未登记的 window 埋点也必须红（否则接口面会被"顺手挂个调试对象"一点点撑大）
  assert.ok(
    windowHookProblems("preview-view.js", "window.__b2tNewThing = 1;").some((item) => item.includes("未登记")),
    "R6 自检失败：新增未登记的 __b2t 埋点也放过",
  );
  // R6：未登记埋点必须被报成"埋点"，不能混进"接口对象"的计数里（顺序错了就把人带偏）
  const mixed = "window.PreviewView = {};\nwindow.__b2tNew = 1;";
  assert.deepEqual(
    windowInterfaceProblems("preview-view.js", mixed),
    [],
    "R6 自检失败：未登记埋点被当成了接口对象——接口计数里只该有 PreviewView",
  );
  assert.ok(
    windowHookProblems("preview-view.js", mixed).some((item) => item.includes("未登记的 window 埋点")),
    "R6 自检失败：同一个未登记埋点，埋点检查却没报出来",
  );
  // R6：一个文件**没有任何埋点**必须合法（preview-view.js 就是这样）——
  // 第一版按"每文件必须有 7 个"判，第二个模块一出现就假红 7 条。
  assert.deepEqual(
    windowHookProblems("preview-view.js", "window.PreviewView = { init };"),
    [],
    "R6 自检失败：没有埋点的合法模块被误报",
  );
  // R6：表过期要按**全仓库**判，不能按单个文件判
  assert.ok(
    hookTableProblems([{ fileName: "preview-view.js", source: "window.PreviewView = {};" }]).length > 0,
    "R6 自检失败：所有 view 文件里都没有登记过的埋点，表过期却没红",
  );

  // R2：跨视图引用
  assert.ok(
    crossViewProblems("preview-view.js", "window.ReadingView.reload();").length > 0,
    "R2 自检失败：preview-view.js 里摸 window.ReadingView 也放过——这正是要挡的写法",
  );
  // R2：自己的接口、以及注释/字符串里的同名字样都不许误报
  assert.deepEqual(
    crossViewProblems("preview-view.js", "window.PreviewView.init();"),
    [],
    "R2 自检失败：引用自己的接口被误报",
  );
  assert.deepEqual(
    crossViewProblems("reading-view.js", "// 这里说明 window.PreviewView 由 preview 模块提供\nwindow.ReadingView = {};"),
    [],
    "R2 自检失败：注释里提到别的视图也误报",
  );
});

// ---------------------------------------------------------------- R4b：同文件同名真实现

/**
 * 同一文件里同名声明出现两次及以上（**只看顶层，缩进 0**）→ 后者覆盖前者，是实打实的重定义。
 *
 * 为什么只看顶层：函数内部的两个 `const row = …` 是不同作用域，不会互相覆盖。
 * 当前 app.js 里就有 2 个这样的假阳性（`row` 6560/13064、`target` 8338/10445，都在缩进 2），
 * 所以判据是"缩进 0 + 同名"，不是"全文同名"。
 *
 * 别名也算：`const foo = (…) =>` 与 `function foo(…)` 同名同样算重定义（顶层两者都在同一作用域）。
 *
 * 基线：这三个是**已知缺陷、冻结期不修**（DevLead 记在 docs/known-limitations.md）。
 * 基线只记"文件 + 名字 + 份数"，不记行号——行号会随改动漂移，漂一次红一次没意义。
 * 新增一个未申报的同名对立即红；已知对减少也红（逼着删基线条目，不许悄悄消失）。
 */
/**
 * 例外表：同文件同名真实现的**已知死代码**。
 *
 * 2026-10-29 清空：最后一条 `rerenderReadingLine`（app.js 里 2 份，第二份是死定义）
 * 随 L9 一起删掉了。到期就删条目、同批把上限收到 0——留着一条指向已删代码的例外，
 * 就是"例外表挂着不存在的东西"，等于给未来的一次重名留了免检名额。
 */
const SAME_FILE_DUP_EXCEPTIONS = [];
const SAME_FILE_DUP_EXCEPTION_MAX = 0;

/** 顶层（缩进 0）声明：`function NAME(` 与 `NAME = (…) =>` / `= function`。 */
function topLevelDeclarationsByName(source) {
  const found = new Map();
  source.split("\n").forEach((raw, index) => {
    if (!raw || /^\s/.test(raw)) return;   // 只看缩进 0
    const fn = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(raw);
    const alias = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(raw);
    const name = fn ? fn[1] : alias ? alias[1] : null;
    if (!name) return;
    const list = found.get(name) || [];
    list.push(index + 1);
    found.set(name, list);
  });
  return found;
}

/** R4b 的判定内核（纯函数：`[{fileName, source}]` + 例外表 → 违规）。 */
function r4bProblems(fileSources, exceptions, maxExceptions) {
  const problems = [];
  if (exceptions.length > maxExceptions) {
    problems.push(`例外表 ${exceptions.length} 条，超过上限 ${maxExceptions}——超了要停下问 DevLead，不许扩`);
  }
  const allowed = new Set();
  for (const entry of exceptions) {
    if (!entry.owner) problems.push(`例外 ${entry.name} 缺 owner`);
    if (!entry.expires) problems.push(`例外 ${entry.name} 缺到期点`);
    allowed.add(`${entry.file}:${entry.name}`);
  }
  const seen = new Set();
  for (const { fileName, source } of fileSources) {
    for (const [name, lines] of topLevelDeclarationsByName(source)) {
      const exception = exceptions.find((item) => item.file === fileName && item.name === name);
      if (lines.length < 2) {
        if (exception) {
          problems.push(
            `函数 ${name} 的已知重复不见了（例外 ${exception.count} 份，现在 ${lines.length} 份：`
            + `${fileName}:${lines.join("、")}）——若已修复，请从例外表删除（到期点：${exception.expires}）`,
          );
        }
        continue;
      }
      if (!exception) {
        problems.push(
          `函数 ${name} 在同一文件有两份真实现（${lines.map((line) => `${fileName}:${line}`).join(" / ")}）`,
        );
        continue;
      }
      seen.add(`${fileName}:${name}`);
      if (lines.length !== exception.count) {
        problems.push(
          `函数 ${name} 的同文件重复份数变了（例外 ${exception.count}，实际 ${lines.length}：`
          + `${lines.map((line) => `${fileName}:${line}`).join(" / ")}）`,
        );
      }
    }
  }
  // 例外表防过期：申报了但代码里没有这个重复
  for (const entry of exceptions) {
    if (!seen.has(`${entry.file}:${entry.name}`)) {
      problems.push(`例外 ${entry.file}:${entry.name} 在代码里找不到对应的重复——表过期了，请删条目`);
    }
  }
  return problems;
}

test("R4b（同文件重名覆盖）：同一文件内同名真实现（后者覆盖前者，未申报即红）", () => {
  const fileSources = readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((fileName) => ({ fileName, source: readFileSync(join(STATIC_DIR, fileName), "utf8") }));
  const problems = r4bProblems(fileSources, SAME_FILE_DUP_EXCEPTIONS, SAME_FILE_DUP_EXCEPTION_MAX);
  assert.deepEqual(problems, [], problems.join("；"));
});

/** R4b 自检（§20.9 ⑬）。 */
test("R4b 自检：同文件两份真实现必须红，缩进 0 才算，例外表过期也要红", () => {
  const red = r4bProblems(
    [{ fileName: "app.js", source: "function tick() {\n  return 1;\n}\nfunction tick() {\n  return 2;\n}\n" }],
    [],
    0,
  );
  assert.ok(red.some((item) => item.includes("两份真实现")), `R4b 自检失败：同文件两份真实现也放过——${red.join("；")}`);

  const indented = r4bProblems(
    [{ fileName: "app.js", source: "function outer() {\n  const row = 1;\n  const row = 2;\n}\n" }],
    [],
    0,
  );
  assert.deepEqual(indented, [], `R4b 自检失败：函数内的局部重名被误报——${indented.join("；")}`);

  const stale = r4bProblems(
    [{ fileName: "app.js", source: "function tick() {\n  return 1;\n}\n" }],
    [{ file: "app.js", name: "tick", count: 2, owner: "x", expires: "y" }],
    1,
  );
  assert.ok(stale.some((item) => item.includes("表过期")), `R4b 自检失败：例外表过期也放过——${stale.join("；")}`);
});

test("R4b 例外表：上限 3 条，每条带 owner 与到期点", () => {
  assert.ok(SAME_FILE_DUP_EXCEPTIONS.length <= SAME_FILE_DUP_EXCEPTION_MAX,
    `例外表 ${SAME_FILE_DUP_EXCEPTIONS.length} 条，超过上限 ${SAME_FILE_DUP_EXCEPTION_MAX}`);
  for (const entry of SAME_FILE_DUP_EXCEPTIONS) {
    assert.ok(entry.owner, `例外 ${entry.name} 缺 owner`);
    assert.ok(entry.expires, `例外 ${entry.name} 缺到期点`);
  }
});


// ---------------------------------------------------------------- R9：no-undef（app.js）

/**
 * **规格（Chief）：`static/app.js` 里被引用、但全文件没有声明的标识符 = 红。**
 *
 * 为什么必须有这条：静态检查永远抓不到"引用了一个已删的声明"——`node --check` 过、单测也过，
 * 真跑起来才 `ReferenceError`。实例：`09e6af3` 删 52 行死函数时把紧挨着的
 * `const readingTreeOpen = new Set();` 一起带走，而它还被用 6 次 → 进审校页打开左树直接崩。
 *
 * 口径（三件套，写死）：
 * - 作用域：`static/app.js` 单文件（`B2T_APP_JS` 可指到别处复跑）。
 * - 口径：去注释与字符串（**正则字面量单独处理**，否则 `/["']/` 会吞掉后半个文件）；只查**裸标识符**。
 * - 排除：关键字；浏览器/语言内建（白名单很短，每条带理由）；属性访问 `a.name`、可选链 `a?.name`；
 *   对象字面量的 key 与方法名；形参 / catch 参数 / 解构绑定的本地名。
 *
 * 精度取舍（实测记录）：纯文本做完整 no-undef 会误报——本文件实测把**解构形参默认值**
 * （`{ manual = false }`）算漏后还剩 3 个假阳性，补齐形参解析后 HEAD 为 0。
 * 第一版只认"高置信度引用形态"（成员访问 `.` / 调用 `(` / 赋值目标 `=`），
 * 不认对象方法定义与 shorthand；这条口径写在注释里，将来要扩先改这里。
 */
const R9_WHITELIST = new Set([
  // 浏览器宿主对象 / API（页面里天然存在，不需要在 app.js 声明）
  "window", "document", "console", "navigator", "location", "history", "screen", "localStorage",
  "sessionStorage", "performance", "fetch", "getComputedStyle", "matchMedia", "scrollTo",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "setTimeout",
  "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "structuredClone",
  "IntersectionObserver", "ResizeObserver", "MutationObserver", "DOMParser", "XMLSerializer",
  "Notification", "Audio", "Image", "Blob", "File", "FileReader", "FormData", "AbortController",
  "TextEncoder", "TextDecoder", "atob", "btoa", "crypto", "CSS", "devicePixelRatio",
  "Event", "CustomEvent", "KeyboardEvent", "PointerEvent", "DragEvent", "XMLHttpRequest",
  // 语言内建
  "Math", "JSON", "Promise", "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp",
  "Error", "TypeError", "RangeError", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Intl",
  "URL", "URLSearchParams", "Uint8Array", "Int32Array", "Float32Array", "ArrayBuffer", "DataView",
  "undefined", "NaN", "Infinity", "globalThis", "encodeURIComponent", "decodeURIComponent",
  "parseInt", "parseFloat", "isNaN", "isFinite", "arguments",
]);
const R9_KEYWORDS = new Set((
  "const new class extends super this function return await let null try catch if throw typeof "
  + "false for of true else in do while switch case default break continue delete void instanceof "
  + "yield async static get set from as import export constructor var debugger with finally"
).split(" "));

/** 声明集合：let/const/var/function/class + 形参（含解构/默认值）+ catch + 解构声明。 */
function r9DeclaredNames(stripped) {
  const declared = new Set();
  for (const m of stripped.matchAll(/(?<![\w$.])(?:let|const|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    declared.add(m[1]);
  }
  // 形参：按逗号全深度拆（默认值里的对象字面量拆开也没关系——多声明只会少报，不会多报）
  const addParams = (text) => {
    for (const part of text.split(",")) {
      const beforeDefault = part.split("=")[0];
      for (const id of beforeDefault.matchAll(/[A-Za-z_$][\w$]*/g)) {
        if (!R9_KEYWORDS.has(id[0])) declared.add(id[0]);
      }
    }
  };
  for (const m of stripped.matchAll(/function\s*[A-Za-z_$\w$]*\s*\(/g)) {
    let depth = 0;
    let k = m.index + m[0].length - 1;
    const startK = k;
    for (; k < stripped.length; k += 1) {
      if (stripped[k] === "(") depth += 1;
      else if (stripped[k] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    addParams(stripped.slice(startK + 1, k));
  }
  // 类里的 constructor 与普通方法：参数同样是本地声明（第一版只收 function/箭头，于是
  // `constructor(message, code, correlationId, …)` 里的 message/correlationId 被误报成未声明）
  for (const m of stripped.matchAll(/(?:^|[^\w$.])(?:static\s+)?(?:async\s+)?(?:constructor|get|set|[A-Za-z_$][\w$]*)\s*\((?![^()]*=>)/g)) {
    let depth = 0;
    let k = m.index + m[0].length - 1;
    const startK = k;
    for (; k < stripped.length; k += 1) {
      if (stripped[k] === "(") depth += 1;
      else if (stripped[k] === ")") { depth -= 1; if (depth === 0) break; }
    }
    const head = m[0].trimEnd();
    // 只认"方法定义"形态：`)` 后面紧跟 `{`；调用（`foo(bar)` 后面是 `;` 或 `)`）不算。
    // 还要排除控制流关键字：`if (x) {` / `for (…) {` 形态和控制流长得很像，
    // 把它们当方法定义会把 x 当成"已声明"——自检里 `if (__ghostCond)` 就是这么变绿的。
    const nameMatch = /([A-Za-z_$][\w$]*)\s*\($/.exec(head);
    if (!nameMatch) continue;
    // constructor / get / set 本身在关键字表里，但它们是方法名，不是控制流
    if (R9_KEYWORDS.has(nameMatch[1]) && !["constructor", "get", "set"].includes(nameMatch[1])) continue;
    const afterParen = stripped.slice(k + 1).trimStart().slice(0, 1);
    if (afterParen !== "{") continue;
    addParams(stripped.slice(startK + 1, k));
  }
  for (const m of stripped.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(m[1]);
  for (const m of stripped.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
  for (const m of stripped.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of stripped.matchAll(/(?:let|const|var)\s*[\[{]([^}\]]*)[\]}]/g)) {
    for (const id of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) declared.add(id[0]);
  }
  return declared;
}

/**
 * no-undef 的判定内核（独立出来，好让自检喂合成样例——见 R9 自检）。
 *
 * **口径**：任何"不是声明、不是属性、不是对象字面量 key/method/label"的标识符都算引用。
 * 第一版只认"成员访问 / 调用 / 赋值目标"，于是这三类全绿：
 *   `setTimeout(__ghost, 0)`（实参）、`if (__ghost)`（条件）、`` `${__ghost.has(1)}` ``（模板插值）
 * ——`readingTreeOpen` 那次是靠 `.add()` 形态才被抓到，换个写法就漏。
 */
function r9NoUndefProblems(source, fileName = "app.js") {
  // 用"保留 ${…}"的版本：整段模板一起抹掉，插值里的标识符就隐形了
  const stripped = stripPreservingTemplateExpressions(source);
  const declared = r9DeclaredNames(stripped);

  const problems = new Map();   // name -> 首次引用行
  for (const m of stripped.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = m[0];
    if (declared.has(name) || R9_WHITELIST.has(name) || R9_KEYWORDS.has(name)) continue;
    const beforeChar = stripped[m.index - 1] || "";
    if (beforeChar === "." || beforeChar === "#") continue;  // 属性访问 / 私有字段（`a?.b` 也算）
    if (/[\w$]/.test(beforeChar)) continue;                 // 数字字面量的尾巴：0x1F / 1e5
    const prevChar = stripped.slice(Math.max(0, m.index - 8), m.index).trimEnd().slice(-1);
    const after = stripped.slice(m.index + name.length);
    const nextChar = after.trimStart().slice(0, 1);
    // 对象字面量的 key / label（`{ name: … }`、`name:`）；method 简写（`{ name() {} }`）
    if (nextChar === ":") continue;
    if (nextChar === "(" && (prevChar === "{" || prevChar === ",")) continue;
    if (!problems.has(name)) problems.set(name, lineOf(stripped, m.index));
  }
  return [...problems].map(
    ([name, line]) => `标识符 ${name} 在 ${fileName}:${line} 被引用，但全文件没有声明（可能是删函数时连带的活声明）`,
  );
}

test("R9：app.js 里被引用但没声明的标识符一律红（no-undef）", () => {
  const source = readFileSync(APP_FILE, "utf8");
  const messages = r9NoUndefProblems(source, APP_FILE.split("/").pop());
  assert.deepEqual(messages, [], messages.join("\n"));
});

/**
 * R9 自检（L-106 第四层：闸必须能被样例喂红）。
 * 合成样例里**必须红**的形态就是第一版漏掉的那三种 + 成员访问（对照）；
 * 必须**不红**的是防误报底线。没有这条，R9 的"绿"只是"扫描器没看见"。
 */
test("R9 自检：裸引用三类必须红，六种非引用必须不红", () => {
  const mustRed = {
    "实参传引用": "function f() { setTimeout(__ghostArg, 0); }",
    "条件里的裸引用": "function f() { if (__ghostCond) { return 1; } return 0; }",
    "模板插值里的引用": "function f() { return `${__ghostTpl.has(1)}`; }",
    "成员访问（对照）": "function f() { return __ghostMember.has(1); }",
  };
  for (const [label, code] of Object.entries(mustRed)) {
    const messages = r9NoUndefProblems(code);
    assert.ok(messages.length > 0, `R9 自检失败：${label}没红——扫描器看不见它，这段代码里就等于没有守卫`);
  }
  const mustGreen = {
    "属性访问": "function f(obj) { return obj.__known; }",
    "可选链属性": "function f(obj) { return obj?.__known; }",
    "对象字面量 key": "function f() { return { __known: 1 }; }",
    "method 简写": "function f() { return { __known() { return 1; } }; }",
    "已声明": "function f() { const __known = 1; return __known; }",
    "形参": "function f(__known) { return __known; }",
  };
  for (const [label, code] of Object.entries(mustGreen)) {
    const messages = r9NoUndefProblems(code);
    assert.deepEqual(messages, [], `R9 自检失败：${label}被误报——${messages.join("；")}`);
  }
});

// ---------------------------------------------------------------- R3：DOM 归属

/**
 * **规格：docs/refactor/reading-view-boundary.md §16（判法 = 引用所在函数是否归 reading）**
 *
 * 为什么不是全 app.js：审校块（`阅读审校（L 刀` 起、`function boot(` 前止）里那 30 个引用
 * 是**搬运期的合法状态**（L1–L12 会搬走）。如果按 id 全量豁免，以后块里新写一句
 * `el("reading-stream")` 会因为 id 已在表里而**一声不响**——守卫空转。
 *
 * 实测（本机 2026-10-28）：`view-reading` 子树 39 个 id、`app.js` 引用 34 个
 * （块内 30 + 块外 4）、5 个完全没被引用。块外那 4 个是 2 个函数
 * （`renderGarbledBadge` / `renderPunctGroupBadge`）→ 4 行豁免，到期 `正文流① 搬完`。
 *
 * 判法：引用行 → 找到**包围它的顶层函数区间** → 该区间是否整个落在审校块内。
 * 块范围**每次运行重算**（不写死行号）：含 `阅读审校（L 刀` 的行 → `function boot(` 前一行。
 * - 归 reading 的函数 → 合法（这些函数随 L1–L12 搬走），**不占豁免**；
 * - 不归 reading（含**顶层代码**，不在任何函数里）→ 一律红，除非在 4 条豁免里。
 * 为什么不用"行号在块内"：顶层代码落在块的行区间里但不是 reading 的函数，按行判会被放过。
 * 模块文件（`*-view.js`）零豁免：id 必须能在自己 `<section id="view-X">` 子树里找到。
 */
const R3_EXEMPTIONS = [
  { id: "reading-garbled-count", line: 17647, owner: "app.js", expires: "punct 整体搬完" },
  { id: "reading-garbled-open", line: 17651, owner: "app.js", expires: "punct 整体搬完" },
  { id: "reading-punct-count", line: 17753, owner: "app.js", expires: "punct 整体搬完" },
  { id: "reading-punct-open", line: 17761, owner: "app.js", expires: "punct 整体搬完" },
];
const R3_MAX_EXEMPTIONS = 4;   // 只降不升；条目数变了必须同批改这里

/**
 * 顶层函数区间：`^(async )?function NAME(` 起，按花括号配对找结束行。
 * 用于"某行属于哪个函数"（R3 判引用位置）。
 */
function topLevelFunctionRanges(stripped) {
  const lines = stripped.split("\n");
  const ranges = [];
  lines.forEach((text, index) => {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(text);
    if (!m) return;
    const startLine = index + 1;
    // 从这一行开始按花括号配对（先找到函数体的 `{`）
    let depth = 0;
    let started = false;
    let endLine = startLine;
    for (let k = index; k < lines.length; k += 1) {
      for (const ch of lines[k]) {
        if (ch === "{") {
          depth += 1;
          started = true;
        } else if (ch === "}") {
          depth -= 1;
        }
      }
      if (started && depth === 0) {
        endLine = k + 1;
        break;
      }
    }
    ranges.push({ name: m[1], start: startLine, end: endLine });
  });
  return ranges;
}

/**
 * 审校块的范围：含 `阅读审校（L 刀` 的那一行 → `function boot(` 的前一行。
 * **每次运行重算**，不写死行号（§15 第 5 条：按名字定位）。
 */
function readingBlockRange(source) {
  const lines = source.split("\n");
  let start = 0;
  let end = 0;
  lines.forEach((text, index) => {
    if (!start && text.includes("阅读审校（L 刀")) start = index + 1;
    if (!end && /^function boot\(/.test(text)) end = index;   // 前一行
  });
  if (!start || !end || end <= start) return null;
  return { start, end };
}

/** 解析 index.html：view 名 → 该 `<section>` 子树里的 id 集合（按标签深度找同层 `</section>`）。 */
function parseViewSections(html) {
  const sections = new Map();
  const openTag = /<section\b[^>]*\bid="view-([\w-]+)"[^>]*>/gi;
  let match;
  while ((match = openTag.exec(html)) !== null) {
    const viewName = match[1];
    let depth = 1;
    let cursor = openTag.lastIndex;
    let end = html.length;
    const tag = /<\/?section\b/gi;
    tag.lastIndex = cursor;
    let tagMatch;
    while ((tagMatch = tag.exec(html)) !== null) {
      if (tagMatch[0][1] === "/") {
        depth -= 1;
        if (depth === 0) {
          end = tagMatch.index;
          break;
        }
      } else {
        depth += 1;
      }
    }
    const subtree = html.slice(match.index, end);
    sections.set(viewName, new Set([...subtree.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])));
  }
  return sections;
}

/** JS 里引用的 DOM id：`el("x")` / `getElementById("x")` / `querySelector("#x")`。 */
function domIdsIn(jsStripped) {
  const found = new Map();   // id -> 所有出现行（块外判定必须看全部出现，不能只看首次）
  const patterns = [
    /\bel\(\s*["']([^"']+)["']\s*\)/g,
    /getElementById\(\s*["']([^"']+)["']\s*\)/g,
    /querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)[^"']*["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(jsStripped)) !== null) {
      const list = found.get(m[1]) || [];
      list.push(lineOf(jsStripped, m.index));
      found.set(m[1], list);
    }
  }
  return found;
}

/**
 * R3 的判定内核（纯函数：合成 html + 合成源码就能喂）。
 *
 * @param {{html: string, appSource: string, viewSources: {fileName: string, source: string}[],
 *          exemptions?: {id: string, owner?: string, expires?: string}[]}} input
 * @returns {string[]}
 */
function r3Problems({ html, appSource, viewSources, exemptions = R3_EXEMPTIONS }) {
  const sections = parseViewSections(html);
  const problems = [];
  if (!sections.has("reading")) {
    problems.push('index.html 里找不到 <section id="view-reading">');
    return problems;
  }

  // 模块文件：零豁免
  for (const { fileName, source } of viewSources) {
    const viewName = fileName.replace(/-view\.js$/, "");
    const expected = sections.get(viewName) || new Set();
    for (const [id, occurrences] of domIdsIn(stripCommentsOnly(source))) {
      if (!expected.has(id)) {
        for (const line of occurrences) problems.push(`${fileName}:${line} 引用了不属于 view-${viewName} 的 id ${id}`);
      }
    }
  }

  // **已落盘的视图，app.js 一个字面量都不许留**（R3 是"这一刀"的验收闸）。
  // 为什么按"有没有模块文件"开关，而不是按视图名写死：写死会漏掉下一个视图；
  // 有 `x-view.js` 就说明该视图的 DOM 归模块了，app.js 再 el("x-…") 就是旧字面量没清干净。
  const shippedViews = new Map();
  for (const { fileName } of viewSources) {
    const viewName = fileName.replace(/-view\.js$/, "");
    const ids = sections.get(viewName);
    if (ids) shippedViews.set(viewName, ids);
  }
  const appAllIds = domIdsIn(stripCommentsOnly(appSource));
  // reading 有"审校块内合法"的搬运期例外，其余视图零容忍
  const readingOnly = new Set(["reading"]);

  // app.js：**审校块外**不许引用 reading 子树的 id（块内是搬运期合法状态，不占豁免名额）
  const exempt = new Map(exemptions.map((item) => [item.id, item]));
  const readingIds = sections.get("reading");
  const appIds = domIdsIn(stripCommentsOnly(appSource));
  // L12：审校块已经 0 行（函数全搬走），`阅读审校（L 刀` 标记随之删除。
  // 所以"找不到块"是**结构达成后的正常状态**，不是红：此时 app.js 里任何对 reading 子树的引用
  // 都属于"块外"，按豁免表判。若将来有人又把审校代码写回 app.js，那些引用同样会被判越界。
  const block = readingBlockRange(appSource);
  const functionRanges = topLevelFunctionRanges(stripCommentsAndStrings(appSource));
  const ownerOfLine = (line) => {
    const hit = functionRanges.filter((item) => item.start <= line && line <= item.end);
    if (!hit.length) return null;                       // 顶层代码：不归任何函数
    return hit[hit.length - 1];                          // 最靠后的那个（区间不重叠时等价）
  };
  const isReadingOwned = (line) => {
    if (!block) return false;                           // 没有审校块：所有引用都在"块外"
    const fn = ownerOfLine(line);
    if (!fn) return false;                              // 顶层代码不归 reading
    return fn.start >= block.start && fn.end <= block.end;
  };
  const outsideIds = new Map();   // id -> 违规行号列表（不属于 reading 的引用）
  for (const [id, occurrences] of appIds) {
    if (!readingIds.has(id)) continue;                  // 不是 reading 子树的 id，不归 R3 管
    const violations = occurrences.filter((line) => !isReadingOwned(line));
    if (!violations.length) continue;                   // 全部在 reading 自己的函数里
    outsideIds.set(id, violations);
    if (!exempt.has(id)) {
      for (const line of violations) {
        const fn = ownerOfLine(line);
        const where = fn ? `函数 ${fn.name}（${fn.start}-${fn.end}）不归 reading` : "顶层代码不归 reading";
        problems.push(`app.js:${line} 引用了 view-reading 的 id ${id}，但${where}，且豁免表里没有它`);
      }
    }
  }
  // 其它已落盘视图：app.js 里零引用（没有 block、没有豁免——它们的 DOM 全归模块）
  for (const [viewName, ids] of shippedViews) {
    if (readingOnly.has(viewName)) continue;
    for (const [id, occurrences] of appAllIds) {
      if (!ids.has(id)) continue;
      for (const line of occurrences) {
        problems.push(
          `app.js:${line} 还引用着 view-${viewName} 的 id ${id}——这个视图已经有 `
          + `${viewName}-view.js，旧字面量必须收干净`,
        );
      }
    }
  }

  // 豁免表防过期：每条必须还在被引用
  for (const item of exemptions) {
    if (!outsideIds.has(item.id)) {
      problems.push(`豁免 ${item.id} 已经不再被非 reading 代码引用——到期了请同批删除（到期点：${item.expires}）`);
    }
    if (!item.owner) problems.push(`豁免 ${item.id} 缺 owner`);
    if (!item.expires) problems.push(`豁免 ${item.id} 缺到期点`);
  }
  return problems;
}

test("R3：模块文件只许碰自己 section 的 id；app.js 对 reading 子树的引用必须在豁免表里", () => {
  const html = readFileSync(join(STATIC_DIR, "index.html"), "utf8");
  const viewSources = readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith("-view.js"))
    .map((fileName) => ({ fileName, source: readFileSync(join(STATIC_DIR, fileName), "utf8") }));
  const problems = r3Problems({
    html,
    appSource: readFileSync(APP_FILE, "utf8"),
    viewSources,
  });
  assert.equal(
    R3_EXEMPTIONS.length,
    R3_MAX_EXEMPTIONS,
    `豁免 ${R3_EXEMPTIONS.length} 条，MAX=${R3_MAX_EXEMPTIONS}：删条目必须同批改 MAX（只降不升）`,
  );
  assert.deepEqual(problems, [], problems.join("\n"));
});

/**
 * R3 自检（§20.9 ⑬：闸必须能被样例喂红）。
 * 四问：模块碰别的视图的 id → 红；app.js 块外碰 reading 的 id → 红；
 * 审校块内的函数引用 → 绿（搬运期合法）；豁免表里那条 → 绿但不许过期。
 */
test("R3 自检：跨视图 id / 块外引用必须红，块内引用与豁免必须绿", () => {
  const html = [
    '<section id="view-reading">',
    '  <div id="reading-stream"></div>',
    '  <div id="reading-garbled-count"></div>',
    '</section>',
    '<section id="view-preview">',
    '  <div id="preview-segs"></div>',
    '</section>',
  ].join("\n");
  const exemptions = [{ id: "reading-garbled-count", owner: "app.js", expires: "测试夹具" }];

  // 红：模块碰了别的视图的 id
  const crossView = r3Problems({
    html,
    appSource: "",
    viewSources: [{ fileName: "preview-view.js", source: 'el("reading-stream");' }],
    exemptions: [],
  });
  assert.ok(crossView.some((item) => item.includes("reading-stream")), "R3 自检失败：模块跨视图引用 id 也放过");

  // 红：app.js 里不归 reading 的函数碰 reading 子树的 id
  const blockOutside = r3Problems({
    html,
    appSource: 'function probeOutside() {\n  return el("reading-stream");\n}\n',
    viewSources: [],
    exemptions: [],
  });
  assert.ok(blockOutside.some((item) => item.includes("reading-stream")), "R3 自检失败：块外引用也放过");

  // 绿：同一处引用，但函数落在审校块里（搬运期合法状态）
  const insideBlock = r3Problems({
    html,
    appSource: [
      '// 阅读审校（L 刀）开始',
      'function probeInside() {',
      '  return el("reading-stream");',
      '}',
      'function boot() {}',
    ].join("\n"),
    viewSources: [],
    exemptions: [],
  });
  assert.deepEqual(insideBlock, [], `R3 自检失败：审校块内的引用被误报——${insideBlock.join("；")}`);

  // 红：library 落盘了，app.js 还留着 library 的字面量（library 那一刀的验收形态）
  const libraryHtml = [
    '<section id="view-library">',
    '  <div id="library-empty"></div>',
    '</section>',
    '<section id="view-reading"><div id="reading-stream"></div></section>',
  ].join("\n");
  const libraryLeftover = r3Problems({
    html: libraryHtml,
    appSource: 'function probeLibrary() {\n  return el("library-empty");\n}\n',
    viewSources: [{ fileName: "library-view.js", source: 'el("library-empty");' }],
    exemptions: [],
  });
  assert.ok(
    libraryLeftover.some((item) => item.includes("library-empty") && item.includes("旧字面量必须收干净")),
    `R3 自检失败：library 落盘后 app.js 还留着字面量也放过——${libraryLeftover.join("；")}`,
  );

  // 绿：同一个 library 视图，app.js 收干净了
  const libraryClean = r3Problems({
    html: libraryHtml,
    appSource: "function probeOther() { return 1; }\n",
    viewSources: [{ fileName: "library-view.js", source: 'el("library-empty");' }],
    exemptions: [],
  });
  assert.deepEqual(libraryClean, [], `R3 自检失败：收干净了还被误报——${libraryClean.join("；")}`);

  // 绿：豁免表里那条（但条目必须真被引用，否则算过期）
  const exempted = r3Problems({
    html,
    appSource: 'function probeBadge() {\n  return el("reading-garbled-count");\n}\n',
    viewSources: [],
    exemptions,
  });
  assert.deepEqual(exempted, [], `R3 自检失败：豁免条目被误报——${exempted.join("；")}`);
});

// ---------------------------------------------------------------- R5：一状态一 owner

/**
 * **规格：docs/refactor/reading-view-boundary.md §17（口径原文照抄，别以后争）**
 *
 * - 作用域：全仓库 JS（static/app.js + static/*-view.js），按文件归属。
 * - 口径：去注释与字符串；赋值点 = `NAME =` / `+=` / `-=` / `++` / `--`；
 *   **排除** `==` / `===`、声明行（`let NAME =`）、以及 `NAME.set/.add/.push/.delete`
 *   这类原地变更（第一版不查原地变更）。
 * - 对象：被测 SHA 的源码树。
 * - 断言：每条的所在文件 == owner（OWNERS 来源 = 文档 §3）。
 * - 两条防表过期：OWNERS 里的状态必须还存在；搬层必须同批改 owner。
 *
 * **有意设计的红（别为了变绿改回去）**：搬层时某个状态的声明/写点会从 app.js 挪到
 * reading-view.js。那时 OWNERS 表项必须**同批**改成 reading-view.js，否则 R5 会红——
 * 这是规则在提醒"owner 变了"，不是误报。把表改回 app.js 只会制造一个假绿。
 *
 * 现状（2026-10-28）：65 个状态 owner = app.js，`readingSplitState` owner = reading-view.js；
 * 违规 0 / 豁免 0。
 */
/**
 * 状态 → owner（一份状态只许有一个 owner）。
 *
 * **2026-10-29 L12 ①（状态迁移）**：审校的 64 个状态整段迁进 `reading-view.js`，
 * 表项 owner 从 `app.js` 全量改成模块；`readingImageToken` / `readingInlineTimer` /
 * `readingPreflightData` 三个零引用状态同批删除，表项也一起删（删状态不删表项 = 表变墓地）。
 * 这条表就是 §3 归属清单在测试里的副本：**搬层必须同批改表**，否则 R5 会红。
 */
const OWNERS = {
  readingTreeOpen: "reading-view.js",
  readingTreeExpandedChapters: "reading-view.js",
  readingTreeChapterAuto: "reading-view.js",
  readingJudgeTimes: "reading-view.js",
  readingAdvancing: "reading-view.js",
  readingPanelOpenedAt: "reading-view.js",
  readingData: "reading-view.js",
  readingProject: "reading-view.js",
  readingEntries: "reading-view.js",
  readingSegmentNodes: "reading-view.js",
  readingRendered: "reading-view.js",
  readingTops: "reading-view.js",
  readingObserver: "reading-view.js",
  readingAppendScheduled: "reading-view.js",
  readingSpanCache: "reading-view.js",
  readingOpenStartedAt: "reading-view.js",
  readingAutoJumpDone: "reading-view.js",
  readingMarks: "reading-view.js",
  readingMarksWindow: "reading-view.js",
  readingGlobalCounts: "reading-view.js",
  readingPageCounts: "reading-view.js",
  readingFirstUnackedPage: "reading-view.js",
  readingMarksInFlight: "reading-view.js",
  readingMarksRequestSeq: "reading-view.js",
  readingTreeData: "reading-view.js",
  readingFilter: "reading-view.js",
  readingCursorEntry: "reading-view.js",
  readingTiles: "reading-view.js",
  readingPageBlocks: "reading-view.js",
  readingBlockPromises: "reading-view.js",
  readingLoadedImages: "reading-view.js",
  readingImageQueue: "reading-view.js",
  readingImagePumping: "reading-view.js",
  readingImageProfile: "reading-view.js",
  readingNearObserver: "reading-view.js",
  readingVisibleObserver: "reading-view.js",
  readingNearSet: "reading-view.js",
  readingVisibleSet: "reading-view.js",
  readingResizeObserver: "reading-view.js",
  readingStackProject: "reading-view.js",
  readingHoveredSeq: "reading-view.js",
  readingPdfScrollRaf: "reading-view.js",
  readingPanelKey: "reading-view.js",
  readingPendingPanelKey: "reading-view.js",
  readingPendingPanelEntry: "reading-view.js",
  readingJumpSettleKey: "reading-view.js",
  readingJumpSettleTicks: "reading-view.js",
  readingPendingBox: "reading-view.js",
  readingDrafts: "reading-view.js",
  readingInlineEdits: "reading-view.js",
  readingEditingKey: "reading-view.js",
  readingRepaintPending: "reading-view.js",
  readingPageNo: "reading-view.js",
  readingSyncDriver: "reading-view.js",
  readingSyncUntil: "reading-view.js",
  readingScrollRaf: "reading-view.js",
  readingUserMovedAt: "reading-view.js",
  readingUserScrollSeq: "reading-view.js",
  readingProgramScrollSeq: "reading-view.js",
  readingSuppressFollowUntil: "reading-view.js",
  readingPageSyncTimer: "reading-view.js",
  readingPageSyncFixing: "reading-view.js",
  readingPageSyncLog: "reading-view.js",
  readingNextLog: "reading-view.js",
  readingFollow: "reading-view.js",
  readingProof: "reading-view.js",
  readingMarkupLevel: "reading-view.js",
  readingPendingOn: "reading-view.js",
  indexCurrentPage: "index-view.js",
  indexJumpTimer: "index-view.js",
  INDEX_NEAR_MARGIN: "index-view.js",
  INDEX_IMAGE_LIMIT: "index-view.js",
  indexTiles: "index-view.js",
  indexImageProfile: "index-view.js",
  indexPagesProject: "index-view.js",
  indexNearPages: "index-view.js",
  indexVisiblePages: "index-view.js",
  indexLoadedImages: "index-view.js",
  indexImageAttempts: "index-view.js",
  INDEX_IMAGE_TIMEOUT_MS: "index-view.js",
  indexBlocksByPage: "index-view.js",
  indexBlocksPending: "index-view.js",
  indexObserver: "index-view.js",
  indexVisibleObserver: "index-view.js",
  indexObserverMargin: "index-view.js",
  indexImageQueue: "index-view.js",
  indexImagePumping: "index-view.js",
  indexTops: "index-view.js",
  indexTopMap: "index-view.js",
  indexScrollRaf: "index-view.js",
  indexResizeRaf: "index-view.js",
  // 图片清晰度的标签表：**暂驻** index 段（跟着 index 整段搬进来的，不是目录状态）。
  // 到期点 = 建 `core/display-prefs`（三个视图都读它）时，这条 owner 要跟着改成那个模块。
  // 不标这一行的话，名字对上了就算覆盖——那是"看似登记、实则没想清楚归属"。
  IMAGE_QUALITY_LABELS: "index-view.js",
  READING_CHUNK: "reading-view.js",
  READING_NEAR_MARGIN: "reading-view.js",
  wordBoxMappingStats: "reading-view.js",
  READING_SPLIT_KEY: "reading-view.js",
  READING_SPLIT_DEFAULT: "reading-view.js",
  READING_SPLIT_MIN: "reading-view.js",
  READING_GRIP_TOTAL: "reading-view.js",
  READING_INTENT_KINDS: "reading-view.js",
  previewData: "preview-view.js",
  previewProject: "preview-view.js",
  previewOptions: "preview-view.js",
  previewOptionsSignature: "preview-view.js",
  previewLoading: "preview-view.js",
  previewPageNo: "preview-view.js",
  previewActiveSeq: "preview-view.js",
  previewOnlySpan: "preview-view.js",
  previewSegmentNodes: "preview-view.js",
  previewSegmentsBySeq: "preview-view.js",
  previewFirstSeqByPage: "preview-view.js",
  previewTiles: "preview-view.js",
  previewTileTops: "preview-view.js",
  previewTileTopMap: "preview-view.js",
  previewPagesProject: "preview-view.js",
  previewLoadedPages: "preview-view.js",
  previewTileBlocks: "preview-view.js",
  previewBlocksPending: "preview-view.js",
  previewActiveBlocks: "preview-view.js",
  previewHitTiles: "preview-view.js",
  previewHitToken: "preview-view.js",
  previewRightRaf: "preview-view.js",
  previewLeftRaf: "preview-view.js",
  previewPendingHover: "preview-view.js",
  previewSyncDriver: "preview-view.js",
  previewSyncUntil: "preview-view.js",
  previewImageStartedAt: "preview-view.js",
  readingIntents: "reading-view.js",
  readingIntentStats: "reading-view.js",
  readingFlushRaf: "reading-view.js",
  readingSplitState: "reading-view.js",
};
const R5_MAX_EXCUSES = 0;   // 现状零豁免；将来开口必须显式改这个数
const R5_EXCUSES = [];      // { state, file, owner, expires }

/**
 * 某文件里某状态的赋值点行号。
 *
 * 用**全位置**匹配而不是行首锚定：`{ readingPageNo = 5; }` 这种同行写法同样要抓到
 * （变异验证踩过：行首锚定会漏掉它）。排除：
 * - 属性写 `obj.NAME =`（lookbehind 排除 `.`）
 * - 比较 `==` / `===` / 箭头 `=>`（负向前瞻）
 * - 声明行 `let NAME =`（前缀是 let/const/var）
 */
function assignmentLines(stripped, name) {
  const lines = [];
  const pattern = new RegExp(`(?<![\\w$.])${name}\\s*(?:\\+\\+|--|\\+=|-=|=)(?![=>])`, "g");
  let match;
  while ((match = pattern.exec(stripped)) !== null) {
    const before = stripped.slice(Math.max(0, match.index - 12), match.index);
    if (/(?:let|const|var)\s*$/.test(before)) continue;   // 声明行
    lines.push(lineOf(stripped, match.index));
  }
  return lines;
}

/** R5 的判定内核（纯函数：`[{fileName, source}]` + OWNERS → 违规）。 */
function r5Problems(fileSources, owners) {
  const problems = [];
  for (const { fileName, source } of fileSources) {
    const stripped = stripCommentsAndStrings(source);
    for (const [state, owner] of Object.entries(owners)) {
      if (owner !== fileName) {
        // 非 owner 文件里出现写点 = 违规（原地变更不在本版口径内）
        for (const line of assignmentLines(stripped, state)) {
          problems.push(`${state} 的 owner 是 ${owner}，${fileName}:${line} 写了它`);
        }
      }
    }
  }
  return problems;
}

test("R5：一状态一 owner——每个状态的赋值点只能出现在 owner 文件里", () => {
  const problems = r5Problems(
    readdirSync(STATIC_DIR)
      .filter((name) => name.endsWith(".js"))
      .map((fileName) => ({ fileName, source: readFileSync(join(STATIC_DIR, fileName), "utf8") })),
    OWNERS,
  );
  assert.deepEqual(problems, [], problems.join("\n"));
});

/** R5 自检（§20.9 ⑬）。 */
test("R5 自检：非 owner 文件写状态必须红，owner 文件写必须绿，声明行不算赋值", () => {
  const owners = { readingFilter: "reading-view.js" };
  const red = r5Problems(
    [{ fileName: "app.js", source: "function tick() {\n  readingFilter = \"chars\";\n}\n" }],
    owners,
  );
  assert.ok(red.some((item) => item.includes("写了它")), `R5 自检失败：非 owner 写状态也放过——${red.join("；")}`);

  const green = r5Problems(
    [{ fileName: "reading-view.js", source: "function tick() {\n  readingFilter = \"chars\";\n}\n" }],
    owners,
  );
  assert.deepEqual(green, [], `R5 自检失败：owner 自己写被误报——${green.join("；")}`);

  const declaration = r5Problems(
    [{ fileName: "app.js", source: "let readingFilter = \"all\";\n" }],
    owners,
  );
  assert.deepEqual(declaration, [], "R5 自检失败：声明行被当成赋值");
});

/**
 * 每个视图模块的**状态前缀**。新增一个视图（`index-view.js` …）必须同批在这里加一行、
 * 并把它的状态登记进 OWNERS——否则它整段都不在检查范围内，R5 绿 = 没覆盖（这是最坏的一种绿）。
 * 这条注册表本身就是那条纪律的闸：磁盘上出现未登记的 `*-view.js` 直接红。
 */
const VIEW_STATE_PREFIXES = {
  // 判据：模块**列 0** 的绑定都属于这个模块。除了 `readingXxx` 状态，还包括模块级常量
  // （`READING_CHUNK` / `INDEX_NEAR_MARGIN` / `IMAGE_QUALITY_LABELS` …）——它们同样是
  // "这个模块的东西"，漏登记一样会变成没覆盖。
  "reading-view.js": /^(reading|READING_|wordBoxMappingStats$)/,
  "preview-view.js": /^preview/,
  "index-view.js": /^(index|INDEX_|IMAGE_QUALITY_LABELS$)/,
  // library-view.js 是 IIFE 形态：顶层状态全在闭包里（列 2），模块自己不留状态——
  // 状态一律走注入的 getter/setter（libraryProjects / lockConflictTarget 留在外壳）。
  "library-view.js": /^(library|LIBRARY_)/,
  // merge-view.js 也是 IIFE：mergeHandled / mergeDecisions / mergeActivePageId 全在闭包内
  "merge-view.js": /^(merge|MERGE_)/,
};

test("R5 防漏检：每个视图模块的顶层状态都必须在 OWNERS 里，且 owner 指向自己", () => {
  const problems = [];
  const modules = readdirSync(STATIC_DIR).filter((name) => name.endsWith("-view.js")).sort();
  for (const fileName of modules) {
    const pattern = VIEW_STATE_PREFIXES[fileName];
    if (!pattern) {
      problems.push(`${fileName}: 没有登记状态前缀——新视图落盘必须同批加 OWNERS 与 VIEW_STATE_PREFIXES 一行`);
      continue;
    }
    const source = stripCommentsAndStrings(readFileSync(join(STATIC_DIR, fileName), "utf8"));
    // **只看列 0**：模块状态/常量都在顶层；函数里的局部量（`let index` / `const tile` 之类）
    // 不属于模块，收进来只会误报。前缀表再按各模块的命名空间过滤。
    const declared = [...source.matchAll(/^(?:let|const|var)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((match) => match[1])
      .filter((name) => pattern.test(name));
    for (const name of declared) {
      if (!(name in OWNERS)) {
        problems.push(`${fileName}: 状态 ${name} 声明在模块里，但 OWNERS 里没有——不登记 = 不检查，绿是假的`);
      } else if (OWNERS[name] !== fileName) {
        problems.push(`${name} 的 owner 是 ${OWNERS[name]}，但它声明在 ${fileName}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("R5 防表过期：OWNERS 里的状态必须还存在（删了状态要同批删表项）", () => {
  const files = readdirSync(STATIC_DIR).filter((name) => name.endsWith(".js"));
  const declared = new Set();
  for (const fileName of files) {
    const stripped = stripCommentsAndStrings(readFileSync(join(STATIC_DIR, fileName), "utf8"));
    for (const match of stripped.matchAll(/(?:^|[^\w$])(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) {
      declared.add(match[1]);
    }
  }
  const missing = Object.keys(OWNERS).filter((state) => !declared.has(state));
  assert.deepEqual(missing, [],
    `OWNERS 里的状态在源码里不存在了：${missing.join("、")}——删状态请同批删表项，别把表变成墓地`);
  assert.ok(R5_EXCUSES.length <= R5_MAX_EXCUSES,
    `R5 豁免 ${R5_EXCUSES.length} 条，上限 ${R5_MAX_EXCUSES}——开口要显式加数字`);
});

// ---------------------------------------------------------------- R11：闸 B（静态边棘轮）

/**
 * **§18.3 闸 B**：13 条边（4 桥 + 9 回调）的调用点合计只降不升。
 *
 * 棘轮怎么锁：预算表在 `docs/refactor/edge-budget.json`（**不在 tests/js**，所以切边提交可以
 * 同批改它而不撞闸 A 的 A1）。断言三条：
 * 1. 当前计数 == 预算值（少切了没改预算 → 红；偷偷把预算改大 → 第 2 条红）
 * 2. 预算值 <= `ring-break-base` 上的实测值（只降不升）
 * 3. 模块文件全文 `showView(` 也一起锁（破环后必须走注入的 `navigate()`）
 *
 * 基点计数每次从 tag 的树里现算（`git show`），不写死数字。
 */
test("R11（闸 B）：静态边棘轮 13 条只降不升（对照 ring-break-base 现算）", () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const budget = JSON.parse(
    readFileSync(new URL("../../docs/refactor/edge-budget.json", import.meta.url), "utf8"),
  );
  const gitShow = (ref, path) =>
    execFileSync("git", ["show", `${ref}:${path}`], { cwd: repo, encoding: "utf8" });

  const base = evaluateEdgeSources(
    gitShow(budget.baseTag, "backend/book2text/static/app.js"),
    gitShow(budget.baseTag, "backend/book2text/static/reading-view.js"),
  );
  const current = evaluateEdges(process.env.B2T_STATIC_DIR);
  const problems = [];
  // 桥例外表：3 条 app.js 内部桥，各自带 owner 与到期点；上限 3、只降不升、归零即过期
  if (BRIDGE_EXCEPTIONS.length > BRIDGE_EXCEPTION_MAX) {
    problems.push(`桥例外 ${BRIDGE_EXCEPTIONS.length} 条，上限 ${BRIDGE_EXCEPTION_MAX}`);
  }
  for (const entry of BRIDGE_EXCEPTIONS) {
    if (!entry.owner) problems.push(`桥例外 ${entry.name} 缺 owner`);
    if (!entry.expires) problems.push(`桥例外 ${entry.name} 缺到期点`);
  }
  problems.push(...checkBridgeExceptions(current));

  for (const item of current) {
    // 找不到 caller 函数体 ≠ 没有调用：改名/搬走时"看不见"必须红，否则预算归零的边永远绿
    if (item.missing) {
      problems.push(`${item.label}：${item.detail}——13 条边一条都不许凭空消失`);
      continue;
    }
    const expected = budget.edges[item.key];
    if (expected === undefined) {
      problems.push(`预算表里没有 ${item.key}——13 条边一条都不许漏`);
      continue;
    }
    if (item.count !== expected) {
      problems.push(`${item.label}：当前 ${item.count} 处，预算 ${expected} 处（切了就要同批改预算；没切不许改小）`);
    }
    const baseItem = base.find((entry) => entry.key === item.key);
    if (baseItem && expected > baseItem.count) {
      problems.push(`${item.label}：预算 ${expected} > base ${baseItem.count}——棘轮只许降`);
    }
  }
  const baseModuleShowView = moduleShowViewInSource(
    gitShow(budget.baseTag, "backend/book2text/static/reading-view.js"),
  );
  const currentModuleShowView = moduleShowViewInSource(
    readFileSync(process.env.B2T_VIEW_JS || VIEW_FILE, "utf8"),
  );
  if (currentModuleShowView !== budget.moduleShowView) {
    problems.push(`模块文件 showView( 当前 ${currentModuleShowView} 处，预算 ${budget.moduleShowView} 处`);
  }
  if (budget.moduleShowView > baseModuleShowView) {
    problems.push(`模块 showView 预算 ${budget.moduleShowView} > base ${baseModuleShowView}——只许降`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

/**
 * R11 自检（L-106 第四层：闸必须能被样例喂红）。
 * 三条合成样例分别对应三种"静默绿"：
 *   ① 调用在 → 必须数到 1（对照，证明扫描器看得见调用）
 *   ② caller 改名 → 必须报 missing（不是记 0）
 *   ③ caller 搬到第三份文件 → 仍然必须看得见（多文件扫描）
 */
test("R11 自检：调用必须数到；caller 改名必须红；搬到第三份文件仍要看得见", () => {
  const withCall = "function renderReading() {\n  ensureReadingMarksWindow(1);\n}\n";
  const empty = "function somethingElse() {}\n";
  const edgeKey = "edge:renderReading->ensureReadingMarksWindow";

  const found = evaluateEdgeSources(withCall, "").find((item) => item.key === edgeKey);
  assert.equal(found.missing, false, "R11 自检失败：调用明明在，却报找不到 caller 函数体");
  assert.equal(found.count, 1, "R11 自检失败：调用在，却数不到 1 处");

  const renamed = evaluateEdgeSources("function renderReadingRenamed() {\n  ensureReadingMarksWindow(1);\n}\n", "")
    .find((item) => item.key === edgeKey);
  assert.equal(renamed.missing, true, "R11 自检失败：caller 改名后没报 missing——这条边从此静默绿");

  const moved = evaluateEdgeSources(empty, "", [{ file: "new-view.js", source: withCall }])
    .find((item) => item.key === edgeKey);
  assert.equal(moved.missing, false, "R11 自检失败：函数搬进第三份文件就看不见了——切模块时这条闸会空转");
  assert.equal(moved.count, 1, "R11 自检失败：搬到第三份文件后数不到调用");
});

// ---------------------------------------------------------------- R12：闸 A（特征测试契约）

/**
 * **§18.2 闸 A 的静态部分**：A1（产品提交不许碰 tests/js）、A1b（序列删除行 0）、
 * A3（改判据必须单开 `test-contract:` 提交并登记 §18.6）。
 * A2（回放）/A4（变异红两遍）是运行期检查，形态是 `tests/js/mutation-check.mjs`。
 */
test("R12（闸 A）：pre-commit 只判形态——A1 / A3 形态 / A1b 形态", () => {
  const { problems, registryProblems, commitCount } = evaluateFeatureContract();
  const strict = process.env.B2T_CONTRACT_STRICT === "1";
  // 登记段：不拦提交（§18.6 只有 DevLead 能加行，单笔契约变更不能靠两人接力完成），
  // 但必须在输出里可见；CI 用 B2T_CONTRACT_STRICT=1 把它变成硬红，status.sh 单独读它。
  if (registryProblems.length > 0) {
    console.log(`\n✖ R12 登记红灯（不阻断提交，CI 用 B2T_CONTRACT_STRICT=1 拦）：\n  ${registryProblems.join("\n  ")}`);
  } else if (commitCount > 0) {
    console.log("✔ R12 登记：全部 test-contract / move: 提交都有合格登记");
  }
  if (strict) {
    assert.deepEqual(registryProblems, [],
      `${commitCount} 笔提交的 §18.6 登记不合格（CI 严格模式）：\n${registryProblems.join("\n")}`);
  }
  if (commitCount === 0) {
    // 基点刚打完、还没有切边提交：契约自然成立，但要把这个事实说出来
    assert.deepEqual(problems, [], problems.join("\n"));
    return;
  }
  assert.deepEqual(problems, [], `${commitCount} 笔提交里违反形态契约：\n${problems.join("\n")}`);
});

// ---------------------------------------------------------------- 对外导出棘轮

/**
 * 公开导出 `window.ReadingView` 的**只降不升**棘轮（Architect 规格）。
 *
 * 为什么不能等 Slice 2 收尾再加：收尾时的门禁等于没有门禁，中途长出来的第 14 个 key
 * 没人拦。这里把当前的份数钉住，只许改小；改大要 Architect 签字。
 *
 * `PENDING_REMOVAL` 是"已判定必须删、但还没删"的写路径。`emit` 已在 26ac481 删除，
 * 名单已清空；「写路径 emit 必须从公开对象上删掉」现在是常驻断言（不再 skip），
 * 谁把写路径加回来都会红。
 */
/**
 * R12 自检（§20.9 ⑬：闸必须能被样例喂红）。
 * 合成提交喂进 `commitContractProblems`：五类形态各一条，全绿那条用来防误报。
 */
test("R12 自检：产品卷测试必须红、未登记/非 test-contract 删除必须红、三样齐全必须绿", () => {
  const docText = [
    "### 18.6 判据变更登记",
    "| 日期 | 判据 | 变更 | 批准人 | 提交 |",
    "|---|---|---|---|---|",
    "| 2026-10-29 | X | 删：旧断言；补：更严的断言；变异：改坏一次红在目标行 | DevLead | abc1234 |",
    "| 2026-10-29 | Y | 删：旧断言 | DevLead | def5678 |",
  ].join("\n");

  // ① 产品 + tests/js 同一笔 → A1
  const mixed = commitContractProblems({
    sha: "1111111", subject: "refactor(x): 顺手", files: ["backend/book2text/static/app.js", "tests/js/boundary.test.mjs"],
    deletions: 0, docText,
  });
  assert.ok(mixed.problems.some((item) => item.startsWith("A1")), `R12 自检失败：产品卷测试也放过——${mixed.problems.join("；")}`);

  // ② test-contract 删了旧断言但没登记 → **形态段放行、登记段红灯**（两段式的全部意义）
  const unregistered = commitContractProblems({
    sha: "2222222", subject: "test-contract: 改判据", files: ["tests/js/boundary.test.mjs"],
    deletions: 3, docText,
  });
  assert.deepEqual(unregistered.problems, [],
    `R12 自检失败：未登记把 pre-commit 也挡住了——这正是要拆掉的那种接力死锁（${unregistered.problems.join("；")}）`);
  assert.ok(
    unregistered.registryProblems.some((item) => item.includes("没登记在 §18.6")),
    `R12 自检失败：未登记的 test-contract 删除没进红灯——${unregistered.registryProblems.join("；")}`,
  );
  assert.equal(unregistered.exempt, false, "R12 自检失败：未登记的提交不该被豁免 A1b");

  // ③ 登记了但缺「变异」→ A3
  // def5678 那行只写了「删：…」，缺「补 / 变异」两样
  const lacking = commitContractProblems({
    sha: "def5678", subject: "test-contract: 只写了一半", files: ["tests/js/boundary.test.mjs"],
    deletions: 2, docText,
  });
  assert.ok(
    lacking.registryProblems.some((item) => item.includes("登记缺")),
    `R12 自检失败：登记缺「变异证明」也放过——${lacking.registryProblems.join("；")}`,
  );

  // ⑤ tests/js/README.md 是文档：只改它（哪怕删行）不需要 test-contract，也不触发 A1b。
  //    这条对应 DevLead 2026-10-29 的裁定（§18.6 已登记）：改一行机检覆盖率不是改断言。
  const docOnly = commitContractProblems({
    sha: "3333333", subject: "docs(refactor): README 覆盖率 11/11 → 12/12",
    files: ["tests/js/README.md"], deletions: 1, docText,
  });
  assert.deepEqual(docOnly.problems, [],
    `R12 自检失败：只改 tests/js/README.md 被当成改断言——${docOnly.problems.join("；")}`);
  assert.deepEqual(docOnly.registryProblems, [],
    `R12 自检失败：只改 README 也进了登记红灯——${docOnly.registryProblems.join("；")}`);

  // ⑥ 文档和测试文件混在一笔、且有删除行、首行不是 test-contract → A3 仍然要红。
  //    排除 .md 不能把 *.mjs 一起放走，这是这条改动的边界。
  const mixedDoc = commitContractProblems({
    sha: "4444444", subject: "docs(refactor): 顺手改测试",
    files: ["tests/js/README.md", "tests/js/boundary.test.mjs"], deletions: 1, docText,
  });
  assert.ok(
    mixedDoc.problems.some((item) => item.startsWith("A3")),
    `R12 自检失败：混着 *.test.mjs 的删除被 .md 豁免一起放走了——${mixedDoc.problems.join("；")}`,
  );

  // ⑧ 形态段全绿 + 登记段红灯：契约变更单人可提交，红灯留给 CI / status.sh
  const split = commitContractProblems({
    sha: "5555555", subject: "test-contract: 改一条判据", files: ["tests/js/boundary.test.mjs"],
    deletions: 4, docText,
  });
  assert.deepEqual(split.problems, [], `R12 自检失败：形态段没放行 test-contract 提交——${split.problems.join("；")}`);
  assert.ok(split.registryProblems.length > 0, "R12 自检失败：未登记没进红灯");

  // ⑨ 登记齐全 → 两段都空且豁免
  const bothGreen = commitContractProblems({
    sha: "abc1234", subject: "test-contract: 合规", files: ["tests/js/boundary.test.mjs"],
    deletions: 2, docText,
  });
  assert.deepEqual(bothGreen.problems, [], "R12 自检失败：合规提交形态段误报");
  assert.deepEqual(bothGreen.registryProblems, [], "R12 自检失败：合规提交登记段误报");
  assert.equal(bothGreen.exempt, true, "R12 自检失败：合规提交没被豁免");

  // ⑦ 谓词本身：任意层级的 *.md 都不算，*.mjs 与数据夹具都算
  assert.equal(isContractPath("tests/js/README.md"), false, "R12 自检失败：README.md 被当成契约对象");
  assert.equal(isContractPath("tests/js/docs/notes.md"), false, "R12 自检失败：嵌套 .md 没被排除");
  assert.equal(isContractPath("tests/js/boundary.test.mjs"), true, "R12 自检失败：*.test.mjs 不算契约对象");
  assert.equal(isContractPath("tests/js/fixtures/x.json"), true, "R12 自检失败：数据夹具不算契约对象");
  assert.equal(isContractPath("backend/book2text/static/app.js"), false, "R12 自检失败：产品文件算进契约对象");

  // ④ 三样齐全 → 绿且豁免
  const ok = commitContractProblems({
    sha: "abc1234", subject: "test-contract: 合规", files: ["tests/js/boundary.test.mjs"],
    deletions: 5, docText,
  });
  assert.deepEqual(ok.problems, [], `R12 自检失败：合规提交被误报——${ok.problems.join("；")}`);
  assert.equal(ok.exempt, true, "R12 自检失败：合规的 test-contract 提交没有被豁免");

  // ⑤ 非 test-contract 删了 tests/js 的行 → A3；删文件 → A1b
  const productDeletes = commitContractProblems({
    sha: "3333333", subject: "refactor(y): 顺手删两行", files: ["tests/js/boundary.test.mjs"],
    deletions: 2, docText,
  });
  assert.ok(
    productDeletes.problems.some((item) => item.includes("首行不是 test-contract:")),
    `R12 自检失败：普通提交删测试行也放过——${productDeletes.problems.join("；")}`,
  );
  const fileGone = commitContractProblems({
    sha: "4444444", subject: "test-contract: 删文件", files: ["tests/js/x.test.mjs"],
    deletions: 1, deletedFiles: ["tests/js/x.test.mjs"], docText,
  });
  assert.deepEqual(fileGone.problems, [],
    `R12 自检失败：带 test-contract: 的删文件被形态段挡了（它只该进登记红灯）——${fileGone.problems.join("；")}`);
  assert.ok(
    fileGone.registryProblems.some((item) => item.startsWith("A1b")),
    `R12 自检失败：删 tests/js 的文件没登记也放过——${fileGone.registryProblems.join("；")}`,
  );
});

/**
 * `move:` 笔类自检（Chief 2026-10-29，三条缺一条这条收窄就是开天窗）。
 * 夹具都走**真内核**：`tableBlockRanges` 从合成源码派生块边界，`moveScopeProblems` 判放行。
 */
test("move: 自检：三张表内改判绿、越界改 assert 判红、动 MAX 旋钮判红、缺一边判红", () => {
  const tables = [
    "const OWNERS = {",
    '  alpha: "a-view.js",',
    "};",
    "const VIEW_STATE_PREFIXES = {",
    '  "a-view.js": /^alpha/,',
    "};",
    "const VIEW_EXPORTS = {",
    '  "a-view.js": { names: ["init"] },',
    "};",
    "const R5_MAX_EXCUSES = 0;",
    "test(\"X\", () => { assert.equal(1, 1); });",
  ].join("\n");
  const docText = [
    "### 18.6 判据变更登记",
    "| 日期 | 判据 | 变更 | 批准人 | 提交 |",
    "|---|---|---|---|---|",
    "| 2026-10-29 | move | 删：旧 owner；补：新 owner 指向模块；变异：撤回本笔红点名 a-view.js | DevLead | mov1234 |",
  ].join("\n");

  // ① 只改三张表 + 产品代码 → 绿
  const ok = commitContractProblems({
    sha: "mov1234",
    subject: "move(a): 搬 3 个函数 + 登记表",
    files: ["backend/book2text/static/a-view.js", "tests/js/boundary.test.mjs"],
    deletions: 1,
    docText,
    moveChanges: [{
      path: "tests/js/boundary.test.mjs",
      addedRanges: [[2, 2], [5, 5], [8, 8]],   // 三条登记行
      deletedRanges: [],
      parentSource: tables,
      commitSource: tables,
    }],
  });
  assert.deepEqual(ok.problems, [], `move: 自检失败：只改登记表也判红——${ok.problems.join("；")}`);

  // ② 顺手改一句 assert（表外）→ 红
  const sneaky = commitContractProblems({
    sha: "mov2345",
    subject: "move(a): 搬 3 个函数 + 登记表",
    files: ["backend/book2text/static/a-view.js", "tests/js/boundary.test.mjs"],
    deletions: 0,
    docText,
    moveChanges: [{
      path: "tests/js/boundary.test.mjs",
      addedRanges: [[2, 2], [12, 12]],          // 第 12 行是那句 assert（表外）
      deletedRanges: [],
      parentSource: tables,
      commitSource: tables,
    }],
  });
  assert.ok(
    sneaky.problems.some((item) => item.includes(":12")),
    `move: 自检失败：表外改 assert 也放行——${sneaky.problems.join("；")}`,
  );

  // ③ 动 R5_MAX_EXCUSES（削弱闸的旋钮）→ 红
  const weaken = commitContractProblems({
    sha: "mov3456",
    subject: "move(a): 搬 3 个函数 + 登记表",
    files: ["backend/book2text/static/a-view.js", "tests/js/boundary.test.mjs"],
    deletions: 0,
    docText,
    moveChanges: [{
      path: "tests/js/boundary.test.mjs",
      addedRanges: [[10, 10]],                  // R5_MAX_EXCUSES 那行
      deletedRanges: [],
      parentSource: tables,
      commitSource: tables,
    }],
  });
  assert.ok(
    weaken.problems.some((item) => item.includes("削弱闸的旋钮")),
    `move: 自检失败：改 MAX 上限也放行——${weaken.problems.join("；")}`,
  );

  // ④ 空声明（只改产品，没碰 tests/js）→ 红
  const fake = commitContractProblems({
    sha: "mov4567",
    subject: "move(a): 只搬代码",
    files: ["backend/book2text/static/a-view.js"],
    deletions: 0,
    docText,
    moveChanges: [],
  });
  assert.ok(
    fake.problems.some((item) => item.includes("空声明的 move: 是伪装")),
    `move: 自检失败：只改产品也放行——${fake.problems.join("；")}`,
  );

  // ⑤ 块边界从源码派生：表名对但括号不配对 → red（fail closed）
  const broken = tableBlockRanges("const OWNERS = {\n  alpha: \"a\",\n");
  assert.equal(broken.length, 0, "块边界解析在括号不配对时不该凭空造出一个块");
});

const STABLE = ["init", "enter", "getCurrent", "reload", "toggleFollow"];   // exit 已于 8b0cfc7 删除（§19 T4 裁决：enter 幂等，exit 没有要救的东西）
const TEMPORARY = [];   // L6 收尾：splitPrefs/applySplit/saveSplit/resetSplit/setupSplit 已从公开对象删除
const PENDING_REMOVAL = [];   // 写路径 emit 已于 26ac481 删除；名单清空，写路径不许再加回来
const MAX_EXPORTS = 5;              // 只许改小（8b0cfc7 删掉 exit 后收紧到 5）

/** 在干净的 vm 里加载模块，读出 `Object.keys(window.ReadingView)`（不加载 app.js）。 */
function readingViewExportKeys() {
  const sandbox = {
    window: null,
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(VIEW_FILE, "utf8"), sandbox, { filename: "reading-view.js" });
  return Object.keys((sandbox.window && sandbox.window.ReadingView) || {});
}

test("R8（导出棘轮）：只许出现 STABLE ∪ TEMPORARY（+待删的写路径），总数只许降", () => {
  const keys = readingViewExportKeys();
  const allowed = new Set([...STABLE, ...TEMPORARY, ...PENDING_REMOVAL]);
  const unexpected = keys.filter((key) => !allowed.has(key));
  assert.deepEqual(unexpected, [], `出现了未申报的公开导出：${unexpected.join("、")}（改大要 Architect 签字）`);
  assert.ok(
    keys.length <= MAX_EXPORTS + PENDING_REMOVAL.length,
    `公开导出现在 ${keys.length} 个，上限 ${MAX_EXPORTS + PENDING_REMOVAL.length}`,
  );
  // 稳定导出不许悄悄消失（那是 breaking change，先改 STABLE 并说明）
  const missingStable = STABLE.filter((key) => !keys.includes(key));
  assert.deepEqual(missingStable, [], `稳定导出现在没有 ${missingStable.join("、")}`);
});

test("R8（导出棘轮）：TEMPORARY 里每个都必须真的还在（到期是删，不是悄悄少一个）", () => {
  const keys = readingViewExportKeys();
  const missing = TEMPORARY.filter((name) => !keys.includes(name));
  assert.deepEqual(missing, [], `临时导出少了 ${missing.join("、")}：要么恢复，要么在 TEMPORARY 里说明它去哪了`);
});

test("R8（导出棘轮）：临时导出不超过 5 条（防止往 TEMPORARY 里塞第六个）", () => {
  assert.ok(TEMPORARY.length <= 5, `TEMPORARY 有 ${TEMPORARY.length} 条，上限 5`);
});

/**
 * **导出棘轮按模块建（D-100，Chief 批 A 时的条件 ③）**
 *
 * 为什么：上面那几条只锁 `ReadingView`。`PreviewView`（3）与 `IndexView`（4）落盘之后，
 * 谁的导出数都没人管——第二、第三个模块可以长成上帝对象，而 R8 一直绿。
 *
 * 口径：
 * - 每个 `*-view.js` 一条上限，**起始值 = 落盘时的导出数**，只降不升；
 * - **导出名集合也一起锁**（不只锁数量）：多一个、少一个、改名都红；
 * - 磁盘上出现没登记上限的 `*-view.js` → 直接红（和 `VIEW_STATE_PREFIXES` 同一个形态：
 *   新视图落盘必须同批登记）。表里登记了但文件不在 → 也算过期。
 * - 接口对象名由文件名决定（R6 已经锁了），这里只关心它下面挂了什么。
 */
const VIEW_EXPORTS = {
  "reading-view.js": { names: STABLE },                                    // 6
  "preview-view.js": { names: ["init", "enter"] },                          // 2
  "index-view.js": { names: ["init", "enter", "refresh"] },                // 3（D-100 签字；exit 于 8b0cfc7 删除）
  // 4：生命周期三件 + 一个域操作（D-100 完整形态；Chief 2026-10-29 裁定 B 签字）
  // open = 打开一个项目，外壳的锁冲突确认 / 任务包打开 / 备份还原都调它
  "library-view.js": { names: ["init", "enter", "notify", "open"] },
  // 2：init / enter（§20.10 定稿）；renderMergeView 不导出——外壳设 mergeState 后 showView 进
  "merge-view.js": { names: ["init", "enter"] },
};

/** 在干净的 vm 里加载某个视图模块，读出它的接口对象的 key（不加载 app.js）。 */
function moduleExportKeys(fileName) {
  const sandbox = {
    window: null,
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(STATIC_DIR, fileName), "utf8"), sandbox, { filename: fileName });
  const iface = expectedInterfaceName(fileName);
  return { iface, keys: Object.keys((sandbox.window && sandbox.window[iface]) || {}) };
}

/** 判定内核（独立出来，好让自检喂合成样例）。 */
function exportRatchetProblems(fileName, keys) {
  const entry = VIEW_EXPORTS[fileName];
  if (!entry) {
    return [`${fileName}: 没有登记导出上限——新视图落盘必须同批在 VIEW_EXPORTS 里登记（起始值 = 落盘时的导出数）`];
  }
  const expected = [...entry.names].sort();
  const actual = [...keys].sort();
  const added = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !actual.includes(key));
  const problems = [];
  if (added.length > 0) {
    problems.push(`${fileName}: 多出未申报的导出 ${added.join("、")}——改大要 Architect 签字，不是往表里加一行`);
  }
  if (missing.length > 0) {
    problems.push(`${fileName}: 少了已登记的导出 ${missing.join("、")}——那是 breaking change，先改表并说明`);
  }
  if (actual.length > expected.length) {
    problems.push(`${fileName}: 导出 ${actual.length} 个，上限 ${expected.length}（只降不升）`);
  }
  return problems;
}

test("R8（按模块）：每个视图模块的导出名与数量都只许等于登记值", () => {
  const modules = readdirSync(STATIC_DIR).filter((name) => name.endsWith("-view.js")).sort();
  assert.ok(modules.length > 0, `static 目录里一个 *-view.js 都没有（${STATIC_DIR}）——这条闸会空转`);
  const problems = [];
  for (const fileName of modules) {
    let loaded;
    try {
      loaded = moduleExportKeys(fileName);
    } catch (error) {
      // 模块自己加载不起来（语法错 / 顶层就抛）→ 报成可读的问题，而不是让整条测试炸在 vm 里
      problems.push(`${fileName}: 加载失败——${error.message}`);
      continue;
    }
    problems.push(...exportRatchetProblems(fileName, loaded.keys));
  }
  // 表里登记了但文件不在 = 表过期
  for (const fileName of Object.keys(VIEW_EXPORTS)) {
    if (!modules.includes(fileName)) {
      problems.push(`VIEW_EXPORTS 里登记了 ${fileName}，但 static 目录里没有这个文件——删表项`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("R8（按模块）自检：多一个 / 少一个 / 改名 / 未登记模块，都必须红", () => {
  const index = ["init", "enter", "refresh"];
  assert.ok(
    exportRatchetProblems("index-view.js", [...index, "debug"]).length > 0,
    "R8 自检失败：IndexView 多第 5 个导出也放过",
  );
  assert.ok(
    exportRatchetProblems("preview-view.js", ["init"]).length > 0,
    "R8 自检失败：PreviewView 少一个导出也放过",
  );
  assert.ok(
    exportRatchetProblems("preview-view.js", ["init", "leave"]).length > 0,
    "R8 自检失败：把 enter 改名成 leave 也放过——只锁数量的实现会漏这个",
  );
  assert.ok(
    exportRatchetProblems("probe-view.js", ["init"]).length > 0,
    "R8 自检失败：新模块没登记上限也放过",
  );
  assert.deepEqual(
    exportRatchetProblems("index-view.js", index),
    [],
    "R8 自检失败：正例被误报",
  );
});

test("R8（导出棘轮）：写路径 emit 不得再出现在公开对象上（事件只出不进）", () => {
  // 26ac481 收进模块内部、e5c4c37 连同 on/listeners 一起删掉。这条从"到期检查"转成常驻断言：
  // 谁再把写路径挂到 window.ReadingView 上（外部就能驱动重绘），立即红。
  const keys = readingViewExportKeys();
  assert.equal(keys.includes("emit"), false, "写路径 emit 又出现在公开对象上，等于给边界开后门");
  assert.equal(keys.includes("on"), false, "事件订阅缝已随 e5c4c37 删除，不许再挂 on");
  assert.deepEqual(PENDING_REMOVAL, [], "PENDING_REMOVAL 必须始终为空");
});

// ---------------------------------------------------------------- A5：特征测试契约（§18.2 闸 A）
//
// **A5：破环的特征测试只许锁「用户能感知的结果」，不许锁「谁在什么时候调的」。**
// 为什么：队列切完之后，9 条边的可观察效果都挪到帧末 flush 里（§12.1.1）。断言调用次数/顺序的
// 测试，切边之后会红——那时红的不是破环，是测试写错了；只能走 A3 单开提交改判据，等于把假红
// 当判据变更。所以这类断言要在一落地就拦掉，而不是等它变红。
//
// 口径（写死在这里，以后争的时候看这一段）：
// - 扫描对象：`tests/js/*.test.mjs`（破环新增的特征测试自动纳入），**不含本文件**——本文件拿合成
//   样例自测检测器，扫自己必然命中。
// - 判定以**语句**为单位：从 `assert` 到配对 `)`，在去注释/字符串后的文本上匹配三类标识符：
//   ① 调用计数（`calls` / `callCount` / `timesCalled` / `invocations` / `hitCount` …）
//   ② 调用顺序（`order` / `seq` / `sequence` / `trace` / `callLog` / `callStack` …）
//   ③ `mock` / `spy` / `stub` / `fake` 命名（注入面调用断言通常这么写）
//   命中即红。**基线站得住**：`let calls = 0; calls += 1;` 这种"数了但没断言"不在 assert 语句里，
//   不红——现有行为测试里就有这种写法（真实链路的副作用计数，不是契约）。
// - 探针豁免：C1–C4 的探针单独成文件、文件名含 `probe`，并登记在 `A5_PROBE_FILES`
//   （每条带 owner + 到期点）；**名字带 probe 但没登记 = 红**，防止拿命名绕过。
// - 例外表 `A5_EXCUSES` 现状为空、上限 0；条目按「文件 + 语句指纹」定位（行号漂移不误红），
//   **违规消失也要红**（表过期 = 有人已经改好，删表项）。
//
// 已知局限（不装看不见）：只认语句级文本。先存变量、隔几行再断言的拼装形态抓不到；
// 那种形态靠 A4 变异红兜底——它锁的若是注入面，切完队列后必然变红。
const A5_COUNTER = /\b(calls?|callCount|callsMade|invokedCount|invocations?|timesCalled|hitCount)\b/;
const A5_ORDER = /\b(order|seq|sequence|trace|callLog|callOrder|callStack)\b/;
const A5_MOCK = /\b(mock|spy|stub|fake)\w*/i;
/** 探针测试文件白名单：{ file, owner, expires }，上限见 A5_MAX_PROBE_FILES。 */
const A5_PROBE_FILES = [];
const A5_MAX_PROBE_FILES = 4;
/** 例外表：{ file, statement, owner, expires }；statement 是归一化后的语句指纹。现状零豁免。 */
const A5_EXCUSES = [];
const A5_MAX_EXCUSES = 0;

const A5_TEST_DIR = fileURLToPath(new URL("./", import.meta.url));

/** 取出源码里所有 `assert…(…)` 语句（跨行也算一条），文本已抹掉注释/字符串并压成一行。 */
function assertStatements(source) {
  const text = stripCommentsAndStrings(source);
  const out = [];
  const re = /\bassert\b/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const open = text.indexOf("(", match.index);
    if (open === -1) break;
    let depth = 0;
    let end = -1;
    for (let k = open; k < text.length; k += 1) {
      if (text[k] === "(") depth += 1;
      else if (text[k] === ")") {
        depth -= 1;
        if (depth === 0) { end = k; break; }
      }
    }
    if (end === -1) break;
    const line = text.slice(0, match.index).split("\n").length;
    out.push({ line, text: text.slice(match.index, end + 1).replace(/\s+/g, " ") });
    re.lastIndex = end + 1;
  }
  return out;
}

/** 一条断言语句为什么违规；合法返回 null。 */
function a5Reason(statement) {
  if (A5_MOCK.test(statement)) return "断言了 mock/spy/stub/fake（注入面调用）";
  if (A5_COUNTER.test(statement)) return "断言了调用次数";
  if (A5_ORDER.test(statement)) return "断言了调用顺序";
  return null;
}

test("A5：特征测试不许断言调用次数/顺序/注入面（§18.2 闸 A）", () => {
  const files = readdirSync(A5_TEST_DIR)
    .filter((name) => name.endsWith(".test.mjs") && name !== "boundary.test.mjs");
  const probe = new Set(A5_PROBE_FILES.map((item) => item.file));
  const violations = [];
  for (const file of files) {
    if (probe.has(file)) continue;
    for (const stmt of assertStatements(readFileSync(join(A5_TEST_DIR, file), "utf8"))) {
      const reason = a5Reason(stmt.text);
      if (reason) violations.push({ file, line: stmt.line, text: stmt.text, reason });
    }
  }
  const excused = new Set(A5_EXCUSES.map((item) => `${item.file}\u0000${item.statement}`));
  const real = violations.filter((v) => !excused.has(`${v.file}\u0000${v.text}`));
  assert.deepEqual(
    real.map((v) => `${v.file}:${v.line} ${v.reason}：${v.text.slice(0, 90)}`),
    [],
    "特征测试锁住的是实现，不是行为：切完队列后它会红，且只能走 A3 改判据（这条是为了不把假红当回退理由）",
  );
  assert.ok(A5_EXCUSES.length <= A5_MAX_EXCUSES,
    `A5 例外 ${A5_EXCUSES.length} 条，上限 ${A5_MAX_EXCUSES}——开口要显式加数字`);

  // 例外表不许过期：每条指纹必须真的还能命中一处违规
  const current = new Set(violations.map((v) => `${v.file}\u0000${v.text}`));
  const stale = A5_EXCUSES.filter((item) => !current.has(`${item.file}\u0000${item.statement}`));
  assert.deepEqual(stale.map((item) => `${item.file}：${item.statement.slice(0, 60)}`), [],
    "A5 例外表过期：违规已经不存在了，请删表项（别把表变成墓地）");
});

test("A5 配套：tests/js 下的每个测试文件都必须在 run.mjs 里注册", () => {
  // 反向的假绿：测试文件写了、闸也扫了，但没进 TEST_FILES 就永远不会被跑。
  // 这条不属闸 A 的判据，是它的地基——先保证"写了就一定会跑"。
  const files = readdirSync(A5_TEST_DIR).filter((name) => name.endsWith(".test.mjs"));
  const runner = readFileSync(join(A5_TEST_DIR, "run.mjs"), "utf8");
  const registered = new Set([...runner.matchAll(/\.\/([\w.-]+\.test\.mjs)/g)].map((m) => m[1]));
  const missing = files.filter((name) => !registered.has(name));
  assert.deepEqual(missing, [],
    `这些测试文件没在 run.mjs 的 TEST_FILES 里注册，写了也不会跑：${missing.join("、")}`);
});

test("A5 探针豁免：名字带 probe 的测试文件必须登记（防止用命名绕过）", () => {
  const files = readdirSync(A5_TEST_DIR).filter((name) => name.endsWith(".test.mjs"));
  const registered = new Set(A5_PROBE_FILES.map((item) => item.file));
  const unregistered = files.filter((name) => /probe/i.test(name) && !registered.has(name));
  assert.deepEqual(unregistered, [],
    "文件名含 probe 但没登记进 A5_PROBE_FILES：豁免要走表，不许靠文件名自己开门");
  const missing = A5_PROBE_FILES.filter((item) => !files.includes(item.file));
  assert.deepEqual(missing.map((item) => item.file), [], "A5_PROBE_FILES 里登记了不存在的文件");
  for (const item of A5_PROBE_FILES) {
    assert.ok(item.owner && item.expires, `A5 探针 ${item.file} 缺 owner 或到期点`);
  }
  assert.ok(A5_PROBE_FILES.length <= A5_MAX_PROBE_FILES,
    `A5 探针 ${A5_PROBE_FILES.length} 条，上限 ${A5_MAX_PROBE_FILES}`);
});

// 自检：没有这一条，A5 就是"从来不红的闸"。合成样例必须红，合法断言必须绿。
test("A5 自检：检测器在合成样例上必须红，在合法断言上必须绿", () => {
  const mustFire = [
    ["assert.equal(calls, 1);", "调用次数"],
    ["assert.equal(api.calls.length, 2);", "调用次数"],
    ["assert.deepEqual(order, ['a', 'b']);", "调用顺序"],
    ["assert.deepEqual(seq, [1, 2]);", "调用顺序"],
    ["assert.ok(spy.calledOnce);", "mock/spy"],
  ];
  for (const [snippet, want] of mustFire) {
    const stmts = assertStatements(snippet);
    assert.equal(stmts.length, 1, `自检：${snippet} 没被解析成一条 assert 语句`);
    const reason = a5Reason(stmts[0].text);
    assert.ok(reason && reason.includes(want), `自检失败：A5 没抓到「${snippet}」（reason=${reason}）`);
  }
  const mustPass = [
    "assert.equal(pages.length, 3);",
    "assert.deepEqual(pages, [1, 2, 3]);",
    "assert.equal(new Set(keys).size, 3);",
    "assert.equal(cursor.page, 2);",
  ];
  for (const snippet of mustPass) {
    const stmts = assertStatements(snippet);
    assert.equal(stmts.length, 1, `自检：${snippet} 没被解析成一条 assert 语句`);
    assert.equal(a5Reason(stmts[0].text), null, `自检失败：A5 误判了合法断言「${snippet}」`);
  }
  // 数了但没断言：现有行为测试里的真实写法，必须不红
  assert.deepEqual(assertStatements("let calls = 0; calls += 1;").map((s) => a5Reason(s.text)), []);
});

// ---------------------------------------------------------------- R13：注入表可解析
//
// **规格（Chief，2026-10-29，library 落盘后现场抓到的洞）**：外壳传给视图模块的注入表
// （`window.XView?.init({ … })`）里，每个键的值表达式引用的自由标识符，必须能在三处之一找到：
//   ① `app.js` 顶层声明（缩进 0 的 function/const/let/var/class）
//   ② 该注入块所在的工厂作用域（当前是 `boot()` 体内声明）
//   ③ 浏览器/语言内建白名单（复用 R9 的 `R9_WHITELIST`）
//
// **为什么 R9 挡不住**：R9 的口径是"**这个文件里**声明过没有"，不是"**这一处**能不能看见"。
// 生成器产出过 `getProject: () => project`——`project` 在别的函数里声明过，R9 绿，真页面
// `project is not defined`。注入表是外壳与模块唯一的数据通道，写错一条，这块页面静默空白，
// 而所有静态门与 1000+ 条测试全绿。
//
// 口径（写死，以后争的时候看这段）：
// - 对象：`static/*-view.js` 全部模块（名单从目录来，不手写）；每个必须在 app.js 里有且只有一处
//   `<接口名>.init({` 块，没有 = 红（模块拿不到 deps）。
// - 注入项一行一个 `key: expr` 或简写 `key`；**解析不了的行 = 红**（fail closed，不许静默跳过）。
// - 表达式里的本地名：箭头形参（`(...args)` / `(v)`）；`a.b` 的 `b` 是属性，不算引用。
// - 模块侧必读：`injected.NAME(` / `injected.NAME.` / `injected.NAME[` 三种形态，必读但没传 = 红
//   （运行时 TypeError）。`injected.NAME || 兜底` 与 `injected.NAME?.(…)` 是可选依赖，不算必读
//   ——reading-view 的 `injected.storage` 就是带 `|| window.localStorage` 兜底的写法。
// - 已知局限：工厂作用域的声明集合按"体内出现过就可见"取（宁松不误报），所以在 boot 的内层函数里
//   声明的名字会漏判；反过来跨函数作用域（这次的 `project`）一定红。

/** 从 `{` 起做花括号配对，返回配对的 `}` 位置；不配对返回 -1。 */
function matchingBrace(text, openIndex) {
  let depth = 0;
  for (let k = openIndex; k < text.length; k += 1) {
    if (text[k] === "{") depth += 1;
    else if (text[k] === "}") {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** 包住 index 的最内层函数体里声明过的名字；找不到函数返回 null。 */
function enclosingScopeNames(strippedApp, index) {
  const heads = [...strippedApp.matchAll(
    /(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  )];
  for (let i = heads.length - 1; i >= 0; i -= 1) {
    const head = heads[i];
    if (head.index > index) continue;
    const open = strippedApp.indexOf("{", head.index + head[0].length - 1);
    if (open === -1) continue;
    const close = matchingBrace(strippedApp, open);
    if (close === -1 || close < index) continue;
    const names = new Set();
    for (const decl of strippedApp.slice(open, close)
      .matchAll(/(?:let|const|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
      names.add(decl[1]);
    }
    return names;
  }
  return null;
}

/** R13 判定内核（纯函数，自检喂合成源码）。返回问题列表，空数组 = 绿。 */
function r13InjectionProblems({ appSource, modules }) {
  const problems = [];
  if (!Array.isArray(modules) || modules.length === 0) {
    return ["R13 拿不到 view 模块名单（static 目录里没有 *-view.js）——空名单会让这条闸空转，按红处理"];
  }
  const app = stripCommentsAndStrings(appSource);
  const topLevel = new Set();
  for (const m of app.matchAll(
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^class\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    topLevel.add(m[1] || m[2] || m[3]);
  }

  for (const { file, source } of modules) {
    const iface = expectedInterfaceName(file);
    const hit = new RegExp(`window\\s*\\.\\s*${iface}\\s*\\??\\.init\\s*\\(\\s*\\{`).exec(app);
    if (!hit) {
      problems.push(`${file}: app.js 里没有 window.${iface}.init({ … }) 注入块——模块存在却没人给它 deps`);
      continue;
    }
    const bodyStart = app.indexOf("{", hit.index);
    const bodyEnd = bodyStart === -1 ? -1 : matchingBrace(app, bodyStart);
    if (bodyEnd === -1) {
      problems.push(`${file}: ${iface} 的注入块花括号不配对，解析失败（fail closed）`);
      continue;
    }
    const scopeNames = enclosingScopeNames(app, hit.index);
    if (!scopeNames) {
      problems.push(`${file}: ${iface} 的注入块不在任何函数体内——口径只覆盖"工厂函数里的 init"，请确认结构`);
      continue;
    }
    const entries = [];
    for (const rawLine of app.slice(bodyStart + 1, bodyEnd).split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const pair = /^([A-Za-z_$][\w$]*)\s*:\s*(.+?),?$/.exec(line);
      if (pair) { entries.push([pair[1], pair[2]]); continue; }
      const shorthand = /^([A-Za-z_$][\w$]*),?$/.exec(line);
      if (shorthand) { entries.push([shorthand[1], shorthand[1]]); continue; }
      problems.push(`${file}: 注入项这一行解析不了（fail closed，别让它静默跳过）：${line.slice(0, 80)}`);
    }
    const passed = new Set(entries.map(([key]) => key));
    for (const [key, expr] of entries) {
      const locals = new Set();
      for (const m of expr.matchAll(/\(([^()]*)\)\s*=>/g)) {
        for (const id of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) locals.add(id[0]);
      }
      for (const m of expr.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) locals.add(m[1]);
      for (const m of expr.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const id = m[0];
        if (locals.has(id) || topLevel.has(id) || scopeNames.has(id)
          || R9_WHITELIST.has(id) || R9_KEYWORDS.has(id)) continue;
        const before = expr[m.index - 1] || "";
        if (before === "." || before === "$" || /[\w$]/.test(before)) continue;
        problems.push(`${file}: 注入键 ${key} 的表达式引用了 ${id}——它既不是 app.js 顶层声明、`
          + `也不在工厂作用域内、也不是全局白名单，运行时会 ReferenceError（${expr.trim().slice(0, 60)}）`);
      }
    }
    const text = stripPreservingTemplateExpressions(source);
    for (const m of text.matchAll(/injected\s*\.\s*([A-Za-z_$][\w$]*)\s*(?=[([.])/g)) {
      if (!passed.has(m[1])) {
        problems.push(`${file}: 模块读了 injected.${m[1]}（必读形态），但外壳注入表里没有这个键——运行时 TypeError`);
      }
    }
  }
  return problems;
}

test("R13：注入表每个键都能解析（顶层/工厂作用域/全局白名单），模块必读的键都传了", () => {
  const appSource = readFileSync(APP_FILE, "utf8");
  const modules = readdirSync(STATIC_DIR)
    .filter((name) => /-view\.js$/.test(name))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(STATIC_DIR, file), "utf8") }));
  assert.ok(modules.length >= 2,
    `static 目录里只找到 ${modules.length} 个 *-view.js——目录指错了吧？空名单不能让这条闸变绿`);
  const problems = r13InjectionProblems({ appSource, modules });
  assert.deepEqual(problems, [], problems.join("\n"));
});

// R13 自检（§20.9 ⑬：闸必须能被样例喂红）。变异样例就是 library 这次真实踩到的三种形态。
test("R13 自检：跨函数作用域的键 / 必读没传 / 解析失败 / 没有注入块 都必须红", () => {
  const moduleOf = (body) => ({
    file: "library-view.js",
    source: `(function () {\n  "use strict";\n  let injected = { el: null };\n  ${body}\n  window.LibraryView = {};\n})();\n`,
  });
  const appWith = (entries, extra = "") => `let currentProject = null;\nfunction apiJson() {}\n`
    + `function boot() {\n  window.LibraryView?.init({\n${entries}\n  });\n}\n${extra}\nboot();\n`;

  const goodEntries = [
    "    getProject: () => currentProject,",
    "    el: (id) => document.getElementById(id),",
    "    apiJson: (...args) => apiJson(...args),",
    "    lastViewLabels: LAST_VIEW_LABELS,",
  ].join("\n");
  const goodApp = appWith(goodEntries, "const LAST_VIEW_LABELS = Object.freeze({});");
  const goodModule = moduleOf("  function f() { return injected.getProject() || injected.el(\"x\") || injected.apiJson(1) || injected.lastViewLabels; }");
  assert.deepEqual(
    r13InjectionProblems({ appSource: goodApp, modules: [goodModule] }),
    [],
    "R13 自检失败：正常注入表被误报",
  );

  // ① 这次的洞：`project` 在别的函数里声明过，R9 绿、这一处看不见
  const scopeRed = r13InjectionProblems({
    appSource: appWith("    getProject: () => project,"),
    modules: [moduleOf("  function f() { return injected.getProject(); }")],
  });
  assert.ok(scopeRed.some((item) => item.includes("project") && item.includes("getProject")),
    `R13 自检失败：跨函数作用域的 project 也放过——${scopeRed.join("；")}`);

  // ② 模块必读、外壳没传 → 运行时 TypeError
  const missingRed = r13InjectionProblems({
    appSource: appWith("    getProject: () => currentProject,"),
    modules: [moduleOf("  function f() { return injected.ghostApi(1); }")],
  });
  assert.ok(missingRed.some((item) => item.includes("ghostApi")),
    `R13 自检失败：必读没传也放过——${missingRed.join("；")}`);

  // ③ 解析失败必须红（fail closed），不许静默跳过
  const parseRed = r13InjectionProblems({
    appSource: appWith("    getProject:\n      () => currentProject,"),
    modules: [moduleOf("  function f() { return 1; }")],
  });
  assert.ok(parseRed.some((item) => item.includes("解析不了")),
    `R13 自检失败：多行注入项被静默跳过——${parseRed.join("；")}`);

  // ④ 模块存在但没有注入块 → 模块拿不到 deps
  const noBlockRed = r13InjectionProblems({
    appSource: "function boot() {}\nboot();\n",
    modules: [moduleOf("  function f() { return 1; }")],
  });
  assert.ok(noBlockRed.some((item) => item.includes("注入块")),
    `R13 自检失败：没有注入块也放过——${noBlockRed.join("；")}`);

  // ⑤ 空名单 = 空转，必须红
  assert.ok(r13InjectionProblems({ appSource: goodApp, modules: [] }).length > 0,
    "R13 自检失败：空模块名单被当成绿");
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
// | R4b-same-file：新增一对同文件重复（`function renderReadingProgress` 再来一份） | `函数 renderReadingProgress 在同一文件有两份真实现（app.js:19092 / app.js:21117）` |
// | R4b-same-file：同名**箭头别名**（顶层 `const renderReadingProgress = () => {}`） | 同上（证明别名与 function 同权） |
// | R4b-same-file：修掉一对已知重复（例外过期） | `函数 rerenderReadingLine 的已知重复不见了（例外 2 份，现在 1 份：app.js:18912）——若已修复，请从例外表删除（到期点：正文流① 搬完）` |
// | R7：index.html 里给 app.js 加上 `type="module"` | `index.html 出现了 <script type="module">：会改 boot 时序，本项目禁用` |
// | R7：交换两个 `<script>` 的顺序 | `reading-view.js 必须先在 app.js 之前加载（现在顺序反了：view=93090 app=93049）` |
//
// 已知死代码三对（冻结期不删，例外表里带 owner 与到期点 `正文流① 搬完`）：
// - ~~`adoptBlockSuggestion` / `adoptAllHighSuggestions`：两份~~ 已删除（2026-10-28，前置死定义清掉，只剩后声明生效的那份）
// - `rerenderReadingLine`：app.js 两份——18912 是 `rerenderReadingLine(key)`，
//   19347 是 `rerenderReadingLine(entry)`；后者生效，所以**按 key 调用的那处会在运行时静默失效**。
//
// | R5：模块里写 app.js 的状态（`readingPageNo = 5;`） | `readingPageNo 的 owner 是 app.js，reading-view.js:185 写了它`（同时 R1 也红：模块引用了 app.js 顶层名） |
// | R5：外壳里写模块状态（`readingSplitState = null;`） | `readingSplitState 的 owner 是 reading-view.js，app.js:21011 写了它` |
// | R5：删掉状态但不删表项 | `OWNERS 里的状态在源码里不存在了：readingSplitState——删状态请同批删表项，别把表变成墓地` |
//
// | A5：临时测试文件里写 `assert.equal(calls, 1)` | `A5：… assert.equal(calls, 1)`（实测 2026-10-28，app.js 未动；同一文件还会撞「没在 run.mjs 里注册」） |
//
// 扫描器自身的坑（已修）：`stripCommentsAndStrings` 一开始不认**正则字面量**，
// app.js 里的 `/["']/` 会被当成字符串开头，把后面一大片代码抹掉——R5 的"状态是否存在"
// 因此误报 43 个。现在支持正则（含 `[...]` 字符类与转义），并且**全位置**匹配赋值点
// （行首锚定会漏掉 `{ readingPageNo = 5; }` 这种同行写法）。
//
// R1 的历史红：`B2T_VIEW_JS=/tmp/rv-7c1d00c.js node tests/js/run.mjs boundary` →
// `reading-view.js 引用了 5 处 app.js 的顶层声明`（currentView / measureReadingTops / readingPageNo×2 /
// updateReadingPage，行号 157–159），与 docs §6 记录的 5 处一致。
//
// 一个与本规则无关的既有发现（没在本测试里管，R4 只查**跨文件**同名）：
// 历史：app.js 曾有两份同名真实现 `adoptBlockSuggestion` 与 `adoptAllHighSuggestions`
// （后声明的覆盖前者），2026-10-28 已删除前置那份；`rerenderReadingLine` 的一对仍在冻结期。
