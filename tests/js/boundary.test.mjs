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
//   这仓库一半 bug 是时序问题）；且 `reading-view.js` 的 `<script>` 必须在 `app.js` 之前。
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
import vm from "node:vm";

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

test("R4-dup（真实现份数=1）：同名函数只许一份真实现，其余必须是 ≤6 行的薄转发", () => {
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

// ---------------------------------------------------------------- R7：加载时序

/**
 * 这个仓库的加载顺序靠"经典脚本 + `reading-view.js` 在 `app.js` 之前"撑住。
 * `type="module"` 默认 deferred，会改 boot 时序——这仓库一半 bug 是时序问题。
 */
test("R7：index.html 不许出现 type=module，且模块先于 app.js 加载", () => {
  const indexPath = join(STATIC_DIR, "index.html");
  let html;
  try {
    html = readFileSync(indexPath, "utf8");
  } catch {
    assert.fail(`找不到 ${indexPath}：B2T_STATIC_DIR 指向的目录必须包含 index.html`);
    return;
  }
  const moduleTags = html.match(/<script[^>]*\btype\s*=\s*["']module["'][^>]*>/gi) || [];
  assert.deepEqual(
    moduleTags,
    [],
    "index.html 出现了 <script type=\"module\">：会改 boot 时序，本项目禁用",
  );
  const viewAt = html.indexOf("/static/reading-view.js");
  const appAt = html.indexOf("/static/app.js");
  assert.ok(viewAt !== -1, "index.html 里没有 reading-view.js 的 <script>");
  assert.ok(appAt !== -1, "index.html 里没有 app.js 的 <script>");
  assert.ok(
    viewAt < appAt,
    `reading-view.js 必须先在 app.js 之前加载（现在顺序反了：view=${viewAt} app=${appAt}）`,
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
 * 例外表：同文件同名真实现的**已知死代码**（冻结期不删，Chief 定的）。
 * 每条必须带 owner 与到期点；上限 3 条——三对正好占满，再多一条就红。
 */
const SAME_FILE_DUP_EXCEPTIONS = [
  { file: "app.js", name: "adoptBlockSuggestion", count: 2, owner: "Chief/DevLead", expires: "正文流① 搬完" },
  { file: "app.js", name: "adoptAllHighSuggestions", count: 2, owner: "Chief/DevLead", expires: "正文流① 搬完" },
  { file: "app.js", name: "rerenderReadingLine", count: 2, owner: "Chief/DevLead", expires: "正文流① 搬完" },
];
const SAME_FILE_DUP_EXCEPTION_MAX = 3;

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

test("R4b-same-file：同一文件内同名真实现（后者覆盖前者，未申报即红）", () => {
  // 例外表本身要合格：上限 3 条、每条带 owner 与到期点
  const allowed = new Set();
  const tableProblems = [];
  for (const entry of SAME_FILE_DUP_EXCEPTIONS) {
    if (!entry.owner) tableProblems.push(`例外 ${entry.name} 缺 owner`);
    if (!entry.expires) tableProblems.push(`例外 ${entry.name} 缺到期点`);
    allowed.add(`${entry.file}:${entry.name}`);
  }
  assert.ok(
    SAME_FILE_DUP_EXCEPTIONS.length <= SAME_FILE_DUP_EXCEPTION_MAX,
    `例外表 ${SAME_FILE_DUP_EXCEPTIONS.length} 条，超过上限 ${SAME_FILE_DUP_EXCEPTION_MAX}——超了要停下问 DevLead，不许扩`,
  );
  assert.deepEqual(tableProblems, [], tableProblems.join("；"));

  const problems = [];
  const files = readdirSync(STATIC_DIR).filter((name) => name.endsWith(".js"));
  const seen = new Set();
  for (const fileName of files) {
    const source = readFileSync(join(STATIC_DIR, fileName), "utf8");
    for (const [name, lines] of topLevelDeclarationsByName(source)) {
      const exception = SAME_FILE_DUP_EXCEPTIONS.find((item) => item.file === fileName && item.name === name);
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
  for (const entry of SAME_FILE_DUP_EXCEPTIONS) {
    if (!seen.has(`${entry.file}:${entry.name}`)) {
      problems.push(`例外表里的 ${entry.name} 在实际代码里没有重复了——到期请删除（到期点：${entry.expires}）`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("R4b-same-file 例外表：上限 3 条，每条带 owner 与到期点", () => {
  assert.ok(SAME_FILE_DUP_EXCEPTIONS.length <= SAME_FILE_DUP_EXCEPTION_MAX,
    `例外表 ${SAME_FILE_DUP_EXCEPTIONS.length} 条，超过上限 ${SAME_FILE_DUP_EXCEPTION_MAX}`);
  for (const entry of SAME_FILE_DUP_EXCEPTIONS) {
    assert.ok(entry.owner, `例外 ${entry.name} 缺 owner`);
    assert.ok(entry.expires, `例外 ${entry.name} 缺到期点`);
  }
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
const STABLE = ["init", "enter", "exit", "getCurrent", "reload", "toggleFollow"];
const TEMPORARY = ["splitPrefs", "applySplit", "saveSplit", "resetSplit", "setupSplit"]; // 到期：Slice 2 收尾
const PENDING_REMOVAL = [];   // 写路径 emit 已于 26ac481 删除；名单清空，写路径不许再加回来
const MAX_EXPORTS = 11;             // 只许改小（e5c4c37 删掉 on/emit 后收紧到 11）

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

test("对外导出棘轮：只许出现 STABLE ∪ TEMPORARY（+待删的写路径），总数只许降", () => {
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

test("对外导出棘轮：TEMPORARY 里每个都必须真的还在（到期是删，不是悄悄少一个）", () => {
  const keys = readingViewExportKeys();
  const missing = TEMPORARY.filter((name) => !keys.includes(name));
  assert.deepEqual(missing, [], `临时导出少了 ${missing.join("、")}：要么恢复，要么在 TEMPORARY 里说明它去哪了`);
});

test("对外导出棘轮：临时导出不超过 5 条（防止往 TEMPORARY 里塞第六个）", () => {
  assert.ok(TEMPORARY.length <= 5, `TEMPORARY 有 ${TEMPORARY.length} 条，上限 5`);
});

test("写路径 emit 不得再出现在公开对象上（事件只出不进）", () => {
  // 26ac481 收进模块内部、e5c4c37 连同 on/listeners 一起删掉。这条从"到期检查"转成常驻断言：
  // 谁再把写路径挂到 window.ReadingView 上（外部就能驱动重绘），立即红。
  const keys = readingViewExportKeys();
  assert.equal(keys.includes("emit"), false, "写路径 emit 又出现在公开对象上，等于给边界开后门");
  assert.equal(keys.includes("on"), false, "事件订阅缝已随 e5c4c37 删除，不许再挂 on");
  assert.deepEqual(PENDING_REMOVAL, [], "PENDING_REMOVAL 必须始终为空");
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
// - `adoptBlockSuggestion`：app.js 两份（后声明的生效）
// - `adoptAllHighSuggestions`：app.js 两份（后声明的生效）
// - `rerenderReadingLine`：app.js 两份——18912 是 `rerenderReadingLine(key)`，
//   19347 是 `rerenderReadingLine(entry)`；后者生效，所以**按 key 调用的那处会在运行时静默失效**。
//
// R1 的历史红：`B2T_VIEW_JS=/tmp/rv-7c1d00c.js node tests/js/run.mjs boundary` →
// `reading-view.js 引用了 5 处 app.js 的顶层声明`（currentView / measureReadingTops / readingPageNo×2 /
// updateReadingPage，行号 157–159），与 docs §6 记录的 5 处一致。
//
// 一个与本规则无关的既有发现（没在本测试里管，R4 只查**跨文件**同名）：
// app.js 自己有两份同名真实现 `adoptBlockSuggestion`（5999 / 12548）与
// `adoptAllHighSuggestions`（6021 / 12567）——后声明的覆盖前者。不是搬运造成的，但迟早要收拾。
