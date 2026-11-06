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
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
// pages 的 R3 过渡豁免表（数据，不是逻辑）：一行一个 id → { 上限处数, 到期刀 }
import {
  PAGES_R3_EXEMPTIONS, PAGES_R3_TOTAL_CAP, PAGES_R3_PENDING, PAGES_R3_BLOCKED_MAX,
} from "./pages-r3-exemptions.mjs";
// 刀号登记表（刀号的唯一真值源）：seed 里出现未登记的号 → 红；当前刀 = stageNow()；
// 登记表与 git 只允许差在途一刀（delta ∈ {0,1}）——`PAGES_STAGE` 这个手写常数 2026-10-30 已删除
import {
  KNIVES, isRegisteredKnife, maxLandedKnife, gitMaxKnifeFromLog, stageSourceProblems, stageNow,
} from "./knife-registry.mjs";
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
  newModuleRegistrationProblems, registrationTableRanges, REGISTRATION_TABLES,
  exemptionDeltaProblems, keepShellSegmentLabels, moveGateProblems, moveScopeProblems,
  MOVE_EXEMPTION_BLOCKS, MOVE_EXEMPTION_BLOCKS_RETIRED,
} from "./feature-contract.mjs";
// R9 专用：保留模板 `${…}` 插值的去注释版本（本文件另有一份旧的去注释实现，只抹代码不抹模板）
import { codeOnly, functionBody, stripPreservingTemplateExpressions } from "./static-scan.mjs";

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

/**
 * **例外条目必须带审计字段**：`owner` + 到期点（R1 的措辞是「到期切片」，R4b 是「到期点」）。
 *
 * 为什么要有这个纯函数（2026-10-30）：
 *   · R4b 那条原来的校验写在 `for (const entry of SAME_FILE_DUP_EXCEPTIONS)` 里，而表是空表 ⇒
 *     **循环体从来没执行过一次**，删掉那两行 assert 四闸照样绿（死代码）；
 *   · R1 那条更糟：标题与注释都承诺「每条要带 owner 与到期切片」，代码里一个字段都没查（名不副实）。
 * 抽出来之后：真树用它、自检喂假表用它——**「空表合法」与「校验真的发生」是两件事**。
 */
export function exceptionEntryProblems(entries, { label = "例外表" } = {}) {
  const problems = [];
  (entries || []).forEach((entry, index) => {
    const name = (entry && (entry.id || entry.name)) || `#${index}`;
    if (!entry || !entry.owner) problems.push(`${label} 里的 ${name} 缺 owner——破例要有人负责`);
    const expires = entry && (entry.expires ?? entry.expiry ?? entry["到期切片"] ?? entry.slice);
    if (!expires) problems.push(`${label} 里的 ${name} 缺到期点——没有终点就是永久豁免`);
  });
  return problems;
}

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
  // 空表合法，但**校验要真的发生**：破例路径（注释里那句「先让 Architect 加 owner 与到期切片」）
  // 必须真有审计字段检查，否则破例就变成"谁想加就加、没人查"。
  const entryProblems = exceptionEntryProblems(ALLOW, { label: "R1 例外表" });
  assert.deepEqual(entryProblems, [], entryProblems.join("；"));
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
  // 转发器形态（Chief 2026-10-29 定三条，缺一不可）：
  //   a) 函数体只有一条语句，且是 return；
  //   b) return 的是 `window.<XxxView>.<fn>(…)` 或 `.apply/.call` 形式；
  //   c) **转发的名字必须等于本函数名**（foo 只能转给 foo）——否则借转发外形放行第二份真实现。
  const oneStatement = statement.split("\n").filter(Boolean).length === 1 && /^return\b/.test(statement);
  const forwardHit = /^(?:return\s+)(?:window\.)?([A-Za-z_$][\w$]*)View\.([A-Za-z_$][\w$]*)(?:\.(?:apply|call))?\s*\([\s\S]*\)$/.exec(statement);
  const forwards = oneStatement && forwardHit !== null && forwardHit[2] === def.name;
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
  // 模块生命周期入口是**每个视图模块各一份**，不是"重复实现"：
  // `window.XxxView = { init, enter }` 是约定形状（R8 锁的就是这个形状）。
  // 若把它们算进 R4-dup，第二个模块落盘就必红——这条排除与"同名逻辑函数只许一份"不冲突。
  const LIFECYCLE = new Set(["init", "enter", "reload", "notify", "open", "refresh"]);
  for (const [name, defs] of byName) {
    if (LIFECYCLE.has(name)) continue;
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
  const viewText = codeOnly(readFileSync(VIEW_FILE, "utf8"));
  const appText = codeOnly(readFileSync(APP_FILE, "utf8"));
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
  // 改名转发 → 不许豁免（借转发外形放行第二份真实现）
  const renamed = r4dupProblems([
    { file: "app.js", source: "function foo() { return window.PagesView.bar.apply(window.PagesView, arguments); }\n" },
    { file: "pages-view.js", source: "function foo() {\n  a();\n  b();\n  c();\n}\n" },
  ]);
  assert.ok(renamed.some((item) => item.includes("两份真实现") || item.includes("找不到真实现")),
    `R4-dup 自检失败：foo 转发给 bar 也放过了——同名条件没生效（${renamed.join("；")}）`);

  // 函数体夹 if / 多条语句 → 不是薄转发
  const sneaky = r4dupProblems([
    { file: "app.js", source: "function foo() {\n  if (x) return window.PagesView.foo.apply(window.PagesView, arguments);\n  return 2;\n}\n" },
    { file: "pages-view.js", source: "function foo() {\n  a();\n  b();\n}\n" },
  ]);
  assert.ok(sneaky.some((item) => item.includes("两份真实现")),
    `R4-dup 自检失败：夹了 if 的伪转发器被当成薄转发（${sneaky.join("；")}）`);

  // 转发器形态的词汇表：`window.PagesView.fn.apply(...)` 也必须认
  const applyShape = r4dupProblems([
    { file: "app.js", source: "function pausePageThumbnails() { return window.PagesView.pausePageThumbnails.apply(window.PagesView, arguments); }\n" },
    { file: "pages-view.js", source: "function pausePageThumbnails() {\n  a();\n  b();\n  c();\n  d();\n  e();\n  f();\n}\n" },
  ]);
  assert.deepEqual(applyShape, [], `R4-dup 自检失败：PagesView 的 .apply 转发没被认成薄转发——${applyShape.join("；")}`);

  const green = r4dupProblems([
    { file: "app.js", source: "function tick() {\n  return window.ReadingView.tick();\n}\n" },
    { file: "x-view.js", source: "function tick() {\n  return 2;\n}\n" },
  ]);
  assert.deepEqual(green, [], `R4-dup 自检失败：薄转发被误报——${green.join("；")}`);

  const single = r4dupProblems([{ file: "x-view.js", source: "function tick() { return 1; }\nfunction tick() { return 2; }\n" }]);
  assert.deepEqual(single, [], "R4-dup 自检失败：同一文件内的重名不归这条管（那是 R4b）");
});

/**
 * R7b 的判定内核（纯函数）——R7 只管 `*-view.js`，看不见**不是视图的模块**。
 *
 * 为什么需要它（2026-10-29 实测）：`page-tile.js` 写了 `window.PageTile`，但 `index.html`
 * 里没有它的 `<script>`，而消费者写的是 `const api = window.PageTile; if (!api) return null;`
 * —— 于是页面走降级路径、不报错，`node tests/js/run.mjs` 删掉那行 `<script>` 仍 **125 pass / 0 fail**。
 * **模块写了没加载**是这个仓库最危险的失败形态（静默、全绿、线上没变化），所以判据不能只盯视图。
 *
 * @param {string} html index.html 内容
 * @param {{file: string, exposes: string[]}[]} modules static 目录里除 app.js 外的 `*.js`
 */
function r7bProblems(html, modules) {
  const problems = [];
  if (!Array.isArray(modules)) {
    return ["R7b 拿不到模块名单——按红处理，空名单会让这条闸空转"];
  }
  const appAt = html.indexOf("/static/app.js");
  for (const { file, exposes } of modules) {
    if (!exposes || exposes.length === 0) continue;      // 不暴露 window 的脚本不用加载检查
    const at = html.indexOf(`/static/${file}`);
    if (at === -1) {
      problems.push(`${file} 暴露了 window.${exposes[0]}，但 index.html 里没有它的 <script>。`
        + `修法三步：① 在 index.html 加 <script src="/static/${file}"></script>；`
        + "② 放在 app.js 之前（和其余视图模块同一段）；③ 核对文件名拼写/大小写。"
        + "不修的话消费者会走 `if (!api) return null` 的降级路径：页面不报错、行为全没，静态门全绿");
      continue;
    }
    if (appAt !== -1 && at > appAt) {
      problems.push(`${file} 必须在 app.js 之前加载（现在顺序反了：module=${at} app=${appAt}）。`
        + `修法三步：① 把 <script src="/static/${file}"></script> 移到 app.js 之前；`
        + "② 确认只有一处 <script>（重复加载会执行两遍）；③ 挪完刷新页面看 window."
        + `${exposes[0]} 是否存在，而不是只看静态门`);
    }
  }
  return problems;
}

test("R7b：static/*.js 里暴露了 window.X 的，都必须在 index.html 里且在 app.js 之前", () => {
  const html = readFileSync(join(STATIC_DIR, "index.html"), "utf8");
  const modules = readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith(".js") && name !== "app.js")
    .sort()
    .map((file) => ({
      file,
      exposes: [...readFileSync(join(STATIC_DIR, file), "utf8").matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)]
        .map((match) => match[1]),
    }));
  const withGlobal = modules.filter((item) => item.exposes.length > 0);
  assert.ok(withGlobal.length >= 3,
    `只找到 ${withGlobal.length} 个暴露 window 的脚本（${withGlobal.map((i) => i.file).join("、")}）——目录指错了吧？`);
  const problems = r7bProblems(html, modules);
  assert.deepEqual(problems, [], problems.join("\n"));
});

/** R7b 自检（§20.9 ⑬）：漏加载 / 顺序反了 / 不暴露 window / 空名单。 */
test("R7b 自检：漏 <script> / 排在 app.js 之后 必须红；不暴露 window 的不判；空名单红", () => {
  const modules = [
    { file: "page-tile.js", exposes: ["PageTile"] },
    { file: "util.js", exposes: [] },
  ];
  const good = '<script src="/static/page-tile.js"></script>\n<script src="/static/app.js"></script>';
  assert.deepEqual(r7bProblems(good, modules), [], "R7b 自检失败：正常写法被误报");

  const missing = '<script src="/static/app.js"></script>';
  assert.ok(
    r7bProblems(missing, modules).some((item) => item.includes("page-tile.js")),
    "R7b 自检失败：删掉 <script> 也放过——这正是 2026-10-29 漏掉的那一行",
  );

  const after = '<script src="/static/app.js"></script>\n<script src="/static/page-tile.js"></script>';
  assert.ok(
    r7bProblems(after, modules).some((item) => item.includes("顺序反了")),
    "R7b 自检失败：模块排到 app.js 之后也放过",
  );

  assert.deepEqual(
    r7bProblems('<script src="/static/app.js"></script>', [{ file: "util.js", exposes: [] }]),
    [],
    "R7b 自检失败：不暴露 window 的脚本被要求加载",
  );

  assert.ok(r7bProblems(good, null).length > 0, "R7b 自检失败：空名单没判红（闸会空转）");
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
  { name: "__b2tIndexMetrics", owner: "QA", expires: "目录确认性能验收完成" },
  { name: "__b2tIndexBlocksMs", owner: "QA", expires: "目录确认性能验收完成" },
  { name: "__b2tIndexTops", owner: "QA", expires: "目录确认性能验收完成" },
];
const WINDOW_HOOK_MAX = 10;   // 只降不升（2026-11-04：preview-view.js 删掉，__b2tPreviewMetrics / __b2tPreviewTileTops 无源码 ⇒ 12 → 10）

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
  // 原来是 `for (const entry of 空表) { assert.ok(entry.owner) … }` —— **循环体从未执行过**（死代码）。
  const entryProblems = exceptionEntryProblems(SAME_FILE_DUP_EXCEPTIONS, { label: "R4b 例外表" });
  assert.deepEqual(entryProblems, [], entryProblems.join("；"));
});

test("例外条目自检：缺 owner 点名 / 缺到期点点名 / 合规条目绿 / 空表绿（但校验照跑）", () => {
  const ok = [{ name: "dup-a", owner: "DevLead", expires: "刀 10 收口" }];
  assert.deepEqual(exceptionEntryProblems(ok, { label: "自检" }), [],
    `例外条目自检失败：合规条目被误报——${exceptionEntryProblems(ok, { label: "自检" }).join("；")}`);

  const noOwner = exceptionEntryProblems([{ name: "dup-b", expires: "刀 10" }], { label: "自检" });
  assert.ok(noOwner.some((m) => m.includes("dup-b") && m.includes("缺 owner")),
    `例外条目自检失败：缺 owner 没点名——${noOwner.join("；")}`);

  const noExpiry = exceptionEntryProblems([{ name: "dup-c", owner: "QA" }], { label: "自检" });
  assert.ok(noExpiry.some((m) => m.includes("dup-c") && m.includes("缺到期点")),
    `例外条目自检失败：缺到期点没点名——${noExpiry.join("；")}`);

  // R1 的措辞是「到期切片」——同一个函数必须认它（真破例时字段名不同，别让校验静默放过）
  assert.deepEqual(
    exceptionEntryProblems([{ id: "slice-a", owner: "DevLead", "到期切片": "切片验收时" }], { label: "自检" }), [],
    "例外条目自检失败：「到期切片」这种写法被当成缺到期点",
  );

  // 空表：合法，但证明这里返回 [] 是"没有条目"，不是"没校验"
  assert.deepEqual(exceptionEntryProblems([], { label: "自检" }), [],
    "例外条目自检失败：空表不该报问题");
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
 * `stage2-movers-seed.md` 的行：`{host, wire, stage}`。
 *
 * **按列拆，不按「第 N 列是什么类型」写正则**：早期版本按 `\| \d+ \|` 匹配第 2 列，
 * 而真 seed 第 2 列是 id 清单 → 一个都匹不到 → `seedStages.size === 0`，下面两条判据
 * **整体跳过、空跑**，到期刀随便改闸都绿（2026-10-29 由 TestDev 变异抓到，当天修）。
 *
 * `wire` 列（可空）是给「host 名被 `wirePagesXxx` 取代」的搬迁期登记：
 * 一个 id 的接线从 `setupPageMore` 挪进 `wirePagesPageMore` 时，**显式写出来**，
 * 不许用「去掉 setup 前缀推 wire 名」那种启发式——推错的后果是红变绿。
 *
 * **候选行解析不了必须红，不许 `continue` 掉整行**（2026-10-30 Architect 抓到的坑）：
 * 旧实现是 `if (!host || !stage) continue;` —— 一行 `刀5b` / `刀 5` / `刀10`（旧正则只吃单数字）
 * 会让该 (函数, id) 变 unmapped，R3 的「到期刀 == 现算 max」就跳过它，
 * **账本少一行、闸还是绿的**。静默跳过是今天最贵的形态，所以这里改成：
 *   · 刀号格解析不了 → 红（带行号 + 原文）；
 *   · 刀号不在 `knife-registry.mjs` 登记表里 → 红（未登记的刀号 = 没有到期点，fail closed）。
 * 正则同时放宽到 `^刀(\d+(?:\.\d+)?)$`：小数（刀2.5）与多位数（刀10）都要能解析。
 */
export function parseSeedRows(text) {
  const rows = [];
  const problems = [];
  const lines = String(text || "").split("\n");
  lines.forEach((line, index) => {
    if (!line.startsWith("| `")) return;
    const lineNo = index + 1;
    const cells = line.split("|").map((cell) => cell.trim());   // ['', '`fn`', ids, range, '刀N', wire, '']
    const host = /^`([A-Za-z_$][\w$]*)`$/.exec(cells[1] || "");
    const rawStage = cells[4] || "";
    const stage = /^刀(\d+(?:\.\d+)?)$/.exec(rawStage);
    if (!host || !stage) {
      problems.push(
        `seed 第 ${lineNo} 行「${rawStage}」解析不了——整行会被跳过，到期刀会少算这一项`
        + `（原文：${line.trim()}）`,
      );
      return;
    }
    const n = Number(stage[1]);
    if (!isRegisteredKnife(n)) {
      problems.push(
        `seed 第 ${lineNo} 行刀号「${rawStage}」不在登记表 tests/js/knife-registry.mjs 里——`
        + "未登记的刀号等于没有到期点（原文：" + line.trim() + "）",
      );
      return;
    }
    // wire 列**一格可以挂多个名字**（一个宿主抽出多个接线函数，例如 setupLibrary 抽出 7 个）：
    // 用 、 或 , 分隔的反引号名字全收，别只取第一个——只取第一个会让其余名字静默缺失。
    const wires = [...(cells[5] || "").matchAll(/`([A-Za-z_$][\w$]*)`/g)].map((m) => m[1]);
    const ids = [...(cells[2] || "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    // **同一宿主允许多行**（每行挂同刀的那组 id）：setupLibrary 剩下的 id 分属刀 3/4/5，
    // 硬挤成一行就只能把刀 3/4 的项写成刀 5——那是悄悄放松棘轮，而且松的正好是没人看的项。
    rows.push({ host: host[1], ids, wires, stage: n });
  });
  return { rows, problems };
}

function seedFileText() {
  const file = fileURLToPath(new URL("../../docs/refactor/evidence/pages/stage2-movers-seed.md", import.meta.url));
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function pagesSeedRows() {
  return parseSeedRows(seedFileText()).rows;
}

/**
 * seed 原文里「到期刀」列的**上界**：所有 `| 刀N |` 格的 max，由文件现算（TestDev f58484b）。
 *
 * 为什么必须现算：上界原先是字面量 `1..5`，而刀 5 之后 seed 里会出现刀 6/7/8/10——
 * 写死会把合法的新刀号判成「解析串位」，最后只能靠改这个数字让它绿，等于判据可被手调。
 *
 * 为什么**不能**改成 `max(rows.map(r => r.stage))`：上界取自被验数据本身，这条判据就恒真。
 * 这里的取法与被验的行解析**相互独立**：行解析读第 5 列（`cells[4]`），这里扫原文的 `| 刀N |` 格
 * ——所以「解析器读了别的列 / 多读一行 / 列顺序漂了」这类不进解析器的漂移仍会被抓到。
 * 正则吃小数：`刀2.5` 是登记过的号（knife-registry.mjs）。
 */
export function seedStageUpperBound(seedText) {
  let max = 0;
  for (const m of String(seedText || "").matchAll(/\|\s*刀(\d+(?:\.\d+)?)\s*\|/g)) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** 每行刀号必须落在 `1..maxStage`（上界由 `seedStageUpperBound` 现算）；越界 = 解析串位。 */
export function seedStageRangeProblems(rows, maxStage) {
  return rows
    // 小数刀号（刀2.5）是登记过的号，不是串位：只要求"有限的、落在 1..上界"
    .filter((row) => !(Number.isFinite(row.stage) && row.stage >= 1 && row.stage <= maxStage))
    .map((row) => `seed 里 ${row.host} 的刀号 ${row.stage} 不在 1..${maxStage}——解析串位了`);
}

/** 一组提交首行 → 已落盘的最新 pages 刀号（解析器在 knife-registry，别抄第二份）。 */
export function pagesStageFromSubjects(subjects) {
  return gitMaxKnifeFromLog((subjects || []).join("\n"));
}

/**
 * git 里已落盘的最新 pages 刀号；**拿不到 git（pre-commit 验的是导出树）返回 null**。
 *
 * 为什么真值来自 git（2026-10-30 Chief/Architect 定）：提交首行是「代码真的动了」的唯一证据；
 * 账本推导会随推迟漂，而推迟本身是账本要记的东西。取不到 git 时**打印一行跳过**——不红、也不静默。
 */
export function pagesStageFromGit() {
  try {
    const out = execFileSync("git", ["log", "--format=%s", "-n", "2000"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return gitMaxKnifeFromLog(out);
  } catch {
    return null;   // 没有 git（pre-commit 的导出树）——调用方打印跳过
  }
}

/**
 * 判据用的「当前刀」：`max(登记表 landed, git 最大刀号)`，**不读文件里的 `PAGES_STAGE` 常数**。
 *
 * 为什么不再读 COMMIT_EDITMSG：git 文档 githooks(5) 明确 pre-commit 是在
 * *before obtaining the proposed commit log message* 之前调用的——那时该文件要么不存在，
 * 要么是**上一笔的残留**（残留一条 `move(pages): 刀 9` 就能让判据跳过九刀）。
 * 「在途最多一刀」由 `stageSourceProblems` 的 delta ≤ 1 承担，不需要读任何文件。
 */
const STAGE_NOW = (() => {
  const computed = stageNow({ gitMax: pagesStageFromGit(), registryMax: maxLandedKnife() });
  return Number.isFinite(computed) ? computed : maxLandedKnife();   // 拿不到 git 时退回登记表（不再有手写常数）
})();

/**
 * 账本侧的交叉校验：`当前刀 == min(seed 剩余到期刀) − 1`。
 *
 * **与 git / 登记表的比较不在这里**——那两条由 `stageSourceProblems` 的 delta 规则承担
 * （在途一刀是合法的；直接比 `当前刀 == gitMax` 会把正在落的那一刀判红）。表空不分支：
 * 没有 `min(∅)` 的歧义。
 */
export function pagesStageProblems({ stage, seedRows }) {
  const problems = [];
  const stages = (seedRows || []).map((row) => row.stage).filter((n) => Number.isFinite(n));
  if (stages.length === 0) return problems;
  const earliest = Math.min(...stages);
  if (Number(stage) !== earliest - 1) {
    problems.push(
      `当前刀=${stage}，但账本剩余最早的到期刀是 ${earliest}（按 seed 应是 ${earliest - 1}）`
      + "——账本与已落盘不一致",
    );
  }
  return problems;
}

/**
 * 「(函数名, id) → 刀号」：到期刀按 max 算。
 *
 * **必须连 id 一起查**：同一宿主可以有多行（每行挂同刀的一组 id），只按函数名查会在多行时
 * 取到"最后一行"或"第一行"，两种都错。
 * wire 名与 host 名等价（都映到所在行的刀号）——漏映一个，那个名字在到期刀 max 里就会被当成
 * unmapped 而静默跳过（这条漏洞 2026-10-29 修过一次，别退回去）。
 * id 列为空 = 通配（老的单行写法不吃亏）。
 */
export function seedStageOf(rows, fnName, id) {
  for (const row of rows) {
    if (row.host !== fnName && !row.wires.includes(fnName)) continue;
    const ids = row.ids || [];
    if (ids.length > 0 && !ids.includes(id)) continue;
    return row.stage;
  }
  return null;
}

/**
 * 同一宿主的**多行 id 集合必须不相交**：相交 = 同一个 id 被两个刀号认领，
 * 「到期 = 引用它的函数里最大的刀号」这条就定不出来（也就没法判它该在哪一刀搬走）。
 */
export function seedHostOverlapProblems(rows) {
  const problems = new Set();
  const byHost = new Map();
  for (const row of rows) {
    const list = byHost.get(row.host) || [];
    list.push(row);
    byHost.set(row.host, list);
  }
  for (const [host, list] of byHost) {
    if (list.length < 2) continue;
    const claimed = new Map();   // id -> 刀号
    for (const row of list) {
      for (const id of (row.ids || [])) {
        if (claimed.has(id)) {
          problems.add(
            `seed 里 ${host} 有 ${list.length} 行，但 id ${id} 被两行同时认领`
            + `（刀 ${claimed.get(id)} 与 刀 ${row.stage}）——同一宿主的 id 集合必须不相交，`
            + "否则「到期 = 引用它的函数的最大刀号」定不出来",
          );
        } else {
          claimed.set(id, row.stage);
        }
      }
    }
  }
  return [...problems];
}

/**
 * 留外壳清单（`knife2.5-split-plan.md` §ⅲ）：段号 → 原样标签（`setupLibrary 12548–12557`）。
 * 受阻项（带 `阻塞段:`）写的段号必须能在这里查到，否则"受阻"就是一句没人管的挡箭牌。
 */
function keepShellSegments() {
  const file = fileURLToPath(new URL("../../docs/refactor/evidence/pages/knife2.5-split-plan.md", import.meta.url));
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return new Set();
  }
  const labels = new Set();
  for (const line of text.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cell = line.split("|")[1] || "";
    const label = cell.replace(/[`*]/g, "").trim();
    if (!/^[A-Za-z_$][\w$]*\s+[\d–\-·\s]+$/.test(label)) continue;
    labels.add(label.replace(/\s+/g, " "));
  }
  return labels;
}

/**
 * seed 与实测的**两向覆盖**（不是严格集合相等）。
 *
 * 严格相等会把两份文件绑成必须同一笔提交：`app.js` 改成 `wirePagesXxx` 而 seed 还没登记 → 红；
 * 顺序错一步就红，而且看起来像"实现坏了"。分批落盘需要的是"改前、改后、中间态都绿"：
 *
 * ```
 * ① measured ⊆ (seed 名 ∪ 各行的 wire)                      —— 实测的每个函数都登记过
 * ② 每一行：自身名 或 它的 wire 至少一个在 measured 里        —— 没有"两头都不在"的丢失
 * ```
 *
 * 两条合起来等价于集合相等，但对提交顺序不敏感；③「host 与 wire 同时存在」是合法中间态（绿）。
 *
 * @returns {string[]} 问题清单（空 = 覆盖住）
 */
function seedCoverageProblems(measured, rows) {
  const problems = [];
  const declared = new Set();
  for (const row of rows) {
    declared.add(row.host);
    for (const wire of row.wires) declared.add(wire);
  }
  const onlyMeasured = [...measured].filter((name) => !declared.has(name));
  const onlySeed = rows
    .filter((row) => !measured.has(row.host) && !row.wires.some((wire) => measured.has(wire)))
    .map((row) => (row.wires.length ? `${row.host}（wire ${row.wires.join("/")} 也没出现）` : row.host));
  // **报错要能直接拿去修**：全部列出来，不截前 3 个。
  // 今天已经两次栽在"只报总数、要人另外跑脚本才数得全"（A1b 的「合计 8 行」是同一形态）。
  if (onlyMeasured.length > 0) {
    problems.push(
      `pages 的实测函数未在 seed 登记（${onlyMeasured.length} 个）：`
      + `${onlyMeasured.join("、")}——新函数要登记，旧名被取代要在 wire 列写清新的名字`,
    );
  }
  if (onlySeed.length > 0) {
    problems.push(
      `pages 的 seed 里有函数的自身名与 wire 名在实测里都不存在（${onlySeed.length} 个）：`
      + `${onlySeed.join("、")}——这是真丢函数，不是改名`,
    );
  }
  return problems;
}

/**
 * R3 的判定内核（纯函数：合成 html + 合成源码就能喂）。
 *
 * @param {{html: string, appSource: string, viewSources: {fileName: string, source: string}[],
 *          exemptions?: {id: string, owner?: string, expires?: string}[]}} input
 * @returns {string[]}
 */
function r3Problems({
  html, appSource, viewSources, exemptions = R3_EXEMPTIONS,
  // pages 走**另一张表**：到期按刀、上限按 id，和 reading 那 4 条（R3_MAX_EXEMPTIONS）互不影响。
  pagesExemptions = PAGES_R3_EXEMPTIONS, pagesStage = STAGE_NOW, pagesTotalCap = PAGES_R3_TOTAL_CAP,
  pagesPendingCap = PAGES_R3_PENDING,
  // 受阻项（带 `阻塞段:`）条数上限；硬顶 7 = 留外壳段数，抬它就等于放松棘轮
  pagesBlockedCap = PAGES_R3_BLOCKED_MAX,
  // seed 的**行**（host / wire / 刀）也要可注入：合成夹具（假 html / 假源码）里没有真函数名，
  // 不注入就会与真 seed 对不上，误报「seed 覆盖不到实测」。
  pagesSeed = pagesSeedRows(),
}) {
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
    for (const [id, occurrences] of domIdsIn(codeOnly(source))) {
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
  const appAllIds = domIdsIn(codeOnly(appSource));
  // reading 有"审校块内合法"的搬运期例外，其余视图零容忍
  const readingOnly = new Set(["reading"]);

  // app.js：**审校块外**不许引用 reading 子树的 id（块内是搬运期合法状态，不占豁免名额）
  const exempt = new Map(exemptions.map((item) => [item.id, item]));
  const readingIds = sections.get("reading");
  const appIds = domIdsIn(codeOnly(appSource));
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
  // 其它已落盘视图：app.js 里零引用（没有 block、没有豁免——它们的 DOM 全归模块）。
  // **pages 例外**：它按「逐 id 处数上限 + 到期刀」的过渡表放行（§r3-exemption-spec.md），
  // 表是数据不是逻辑；reading 那 4 条（R3_EXEMPTIONS / R3_MAX_EXEMPTIONS）语义不变，两张表互不影响。
  const pagesTable = new Map(pagesExemptions.map((item) => [item.id, item]));
  let pagesActualTotal = 0;
  for (const [viewName, ids] of shippedViews) {
    if (readingOnly.has(viewName)) continue;
    const table = viewName === "pages" ? pagesTable : new Map();
    for (const [id, occurrences] of appAllIds) {
      if (!ids.has(id)) continue;
      const entry = table.get(id);
      const expired = Boolean(entry) && entry.stage !== null && entry.stage <= pagesStage;
      const allowed = entry && !expired ? entry.cap : 0;
      if (viewName === "pages") pagesActualTotal += Math.min(occurrences.length, allowed);
      if (occurrences.length <= allowed) continue;
      for (const line of occurrences.slice(allowed)) {
        problems.push(
          `app.js:${line} 还引用着 view-${viewName} 的 id ${id}——这个视图已经有 `
          + `${viewName}-view.js，旧字面量必须收干净`
          + (entry ? `（登记上限 ${entry.cap} 处，实际 ${occurrences.length} 处）` : ""),
        );
      }
    }
  }
  // pages 过渡表的三条自检口径：总量上限、到期不搬、条目必须真实存在
  if (shippedViews.has("pages")) {
    if (pagesActualTotal > pagesTotalCap) {
      problems.push(`pages 的 R3 过渡豁免合计 ${pagesActualTotal} 处 > 上限 ${pagesTotalCap} 处——表或代码漂了`);
    }
    // **总上限必须等于逐项之和**（2026-10-30）：总上限比逐项之和大，就等于给「未登记的引用」
    // 留了空白——每项各自合规，多出来的处数没人认领，而「合计上限」这条判据从此在空转。
    const capSum = pagesExemptions.reduce((sum, item) => sum + (Number(item.cap) || 0), 0);
    if (pagesTotalCap !== capSum) {
      problems.push(
        `PAGES_R3_TOTAL_CAP=${pagesTotalCap}，但逐项 cap 之和=${capSum}——`
        + (pagesTotalCap > capSum
          ? `总上限比逐项之和大 ${pagesTotalCap - capSum} 处：给「未登记的引用」留了空白，`
            + "R3 的「合计上限」判据从此在空转（表上每项都合规，多出来的处数没人认领）"
          : `总上限比逐项之和小 ${capSum - pagesTotalCap} 处：逐项登记相加已超上限，表自相矛盾`),
      );
    }
    for (const item of pagesExemptions) {
      const occurrences = appAllIds.get(item.id) || [];
      // **下行判据：0 引用就删项**（2026-10-30）。表上只许挂 app.js 里真的还有引用的 id——
      // 只判「cap ≥ 实测」是单边的：一项随搬迁归零后不会被发现，就变成永久陈账
      // （实测：64 项里 40 项在 app.js 里 0 引用，id 早已只住在 pages-view.js），账本只涨不消。
      if (occurrences.length === 0) {
        problems.push(
          `豁免 ${item.id} 在 app.js 里有 0 处引用——陈账，删项（表上只许挂真的还有引用的 id）`,
        );
      }
      if (item.stage !== null && item.stage <= pagesStage && occurrences.length > 0) {
        problems.push(`豁免 ${item.id} 到期（刀 ${item.stage}）但 app.js 还引用着 ${occurrences.length} 处——到期不搬 = 红`);
      }
    }
    const seedRows = pagesSeed;
    // 同一宿主多行时 id 集合必须不相交（否则到期刀 max 定不出来）
    problems.push(...seedHostOverlapProblems(seedRows));

    // **函数集合两向覆盖**（见 `seedCoverageProblems` 的说明：不用严格相等，否则把
    // app.js 与 docs 两份文件绑成必须同一笔提交，分批落盘的中间态会被误判成实现坏了）。
    if (seedRows.length > 0) {
      const union = new Set();
      for (const id of pagesTable.keys()) {
        for (const line of appAllIds.get(id) || []) {
          const fn = ownerOfLine(line);
          if (fn) union.add(fn.name);
        }
      }
      problems.push(...seedCoverageProblems(union, seedRows));
    }

    // **到期刀不许手调**：必须等于「引用它的所有函数在 seed 里的最大刀号」。
    // 没有这条，谁都能为了让它早点到期把刀号填小——表就变成可调参数了。
    if (seedRows.length > 0) {
      for (const item of pagesExemptions) {
        if (item.stage === null) continue;
        const occurrences = appAllIds.get(item.id) || [];
        const stages = [];
        let unmapped = false;
        for (const line of occurrences) {
          const fn = ownerOfLine(line);
          // 连 id 一起查：同一宿主可能有多行（每行挂同刀的一组 id）
          const stage = fn ? seedStageOf(seedRows, fn.name, item.id) : null;
          if (stage === null) { unmapped = true; continue; }
          stages.push(stage);
        }
        if (unmapped || stages.length === 0) continue;   // seed 漏函数 / 顶层引用：判不了，跳过
        const expected = Math.max(...stages);
        if (item.stage !== expected) {
          problems.push(
            `豁免 ${item.id} 的到期刀 ${item.stage} ≠ 现算的 max ${expected}`
            + `（引用它的函数在 seed 里的最大刀号）——到期刀不许手调`,
          );
        }
      }
    }

    // 待定项本身是"没有到期日"的项：刀 1 允许有（名单还没出），刀 2 起必须为 0——
    // 定不出来就说明刀 2–5 的名单没出，那是真缺口，不许拿"待定"长期挂着。
    const pendingCount = pagesExemptions.filter((item) => item.stage === null).length;
    if (pagesStage >= 2 && pendingCount > 0) {
      problems.push(`刀 ${pagesStage} 已落盘，但豁免表里还有 ${pendingCount} 项「待定」——`
        + `刀 1 之后不许有待定（引用它的函数排进哪一刀，到期刀就是那一刀）`);
    }
    if (pendingCount > pagesPendingCap) {
      problems.push(`待定项 ${pendingCount} > 上限 ${pagesPendingCap}——待定数只降不升（和导出棘轮同形）`);
    }

    // 受阻项（带 `阻塞段:`）：字段没人读 = 没写。三条一起判，缺一条这个字段就是注释。
    const blockedItems = pagesExemptions.filter((item) => {
      const value = item["阻塞段"];
      return value !== undefined && value !== null && String(value).trim() !== "";
    });
    if (pagesBlockedCap > 7) {
      problems.push(`受阻项上限被抬到 ${pagesBlockedCap}（硬顶 7 = 留外壳段数）——只降不升`);
    }
    if (blockedItems.length > pagesBlockedCap) {
      problems.push(`受阻项 ${blockedItems.length} > 上限 ${pagesBlockedCap}——受阻只降不升`);
    }
    const segments = keepShellSegments();
    for (const item of blockedItems) {
      // **受阻项不写死某一刀**（TestDev f58484b）：条件是 `stage > pagesStage`——「还没到期」
      // 才有资格叫「受阻」；到期了还挂着「阻塞段」，那就是「到期不搬」换了个说法。
      // 原先写死 `!== 5`，而 5 只是当时那一刀的号：抬刀之后这条会逼人把数字改回去（判据变可手调）。
      if (!(Number.isFinite(item.stage) && item.stage > pagesStage)) {
        problems.push(
          `豁免 ${item.id} 带「阻塞段」但到期刀是 ${item.stage}（PAGES_STAGE=${pagesStage}）——`
          + "受阻项必须 stage > PAGES_STAGE：还没到期才有资格叫「受阻」，"
          + "到期了还靠留外壳段挂着就是「到期不搬」换了个说法",
        );
      }
      const raw = String(item["阻塞段"]).split(/[、,，+]|\s\+\s/).map((one) => one.trim()).filter(Boolean);
      // `setupLibrary 12669–12672 + 12673–12676` 这种写法：后续段省略函数名，按第一段的函数名补前缀
      const owner = (raw[0] || "").split(/\s+/)[0];
      const labels = raw.map((one) => (/\s/.test(one) ? one : `${owner} ${one}`.trim()));
      if (labels.length === 0) {
        problems.push(`豁免 ${item.id} 的「阻塞段」是空的——空字段等于没有理由`);
      }
      for (const label of labels) {
        if (!segments.has(label.replace(/\s+/g, " "))) {
          problems.push(
            `豁免 ${item.id} 的阻塞段「${label}」在留外壳清单里查不到`
            + `（knife2.5-split-plan.md §ⅲ，现有 ${segments.size} 段）——段号写错或清单漂了，判不了就是红`,
          );
        }
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

/**
 * pages 的 R3 过渡豁免表自检（三条，缺一条这张表就成了白名单）：
 * ① 去掉任意一个 id 的豁免 → 红；② 处数超上限 → 红；③ 到期（刀）之后仍有引用 → 红。
 */
test("R3 自检（pages 过渡表）：去掉一个 id / 超上限 / 到期未搬，都必须红", () => {
  const html = '<section id="view-reading"></section>'
    + '<section id="view-pages"><div id="a"></div><div id="b"></div></section>';
  const appSource = 'el("a"); el("a"); el("b");';
  const viewSources = [{ fileName: "pages-view.js", source: "" }];
  const base = {
    html, appSource, viewSources,
    // reading 的 4 条豁免是另一个机制，这张合成夹具里不掺进来
    exemptions: [],
    pagesStage: 1, pagesTotalCap: 3, pagesPendingCap: 2, pagesBlockedCap: 7,
    // 合成夹具里没有真函数名：seed 给空表，否则会与真 seed 对不上（误报「集合不等」）
    pagesSeed: [],
  };

  const green = r3Problems({
    ...base,
    pagesExemptions: [{ id: "a", cap: 2, stage: null }, { id: "b", cap: 1, stage: null }],
  });
  assert.deepEqual(green, [], `R3 pages 自检失败：合规表被误报——${green.join("；")}`);

  // ① 去掉 b 的豁免：b 还有 1 处引用 → 必须红
  const dropped = r3Problems({ ...base, pagesExemptions: [{ id: "a", cap: 2, stage: null }] });
  assert.ok(
    dropped.some((item) => item.includes("id b")),
    `R3 pages 自检失败：去掉一个 id 的豁免也放过——${dropped.join("；")}`,
  );

  // ② 处数超上限：a 实际 2 处，登记 1 处 → 必须红
  const over = r3Problems({
    ...base,
    pagesExemptions: [{ id: "a", cap: 1, stage: null }, { id: "b", cap: 1, stage: null }],
  });
  assert.ok(
    over.some((item) => item.includes("登记上限 1 处，实际 2 处")),
    `R3 pages 自检失败：超上限也放过——${over.join("；")}`,
  );

  // ④ 刀 2 起不许有待定项（定不出来 = 刀 2–5 名单没出）
  const pendingAtStage2 = r3Problems({
    ...base,
    pagesStage: 2,
    pagesExemptions: [{ id: "a", cap: 2, stage: 2 }, { id: "b", cap: 1, stage: null }],
  });
  assert.ok(
    pendingAtStage2.some((item) => item.includes("还有 1 项「待定」")),
    `R3 pages 自检失败：刀 2 还有待定项也放过——${pendingAtStage2.join("；")}`,
  );

  // ③ 到期未搬：a 的到期刀 = 2，当前刀 = 2 → 必须红
  const expired = r3Problems({
    ...base,
    pagesStage: 2,
    pagesExemptions: [{ id: "a", cap: 2, stage: 2 }, { id: "b", cap: 1, stage: null }],
  });
  assert.ok(
    expired.some((item) => item.includes("到期（刀 2）")),
    `R3 pages 自检失败：到期不搬也放过——${expired.join("；")}`,
  );

  // ⑤ 到期刀不许手调：a 被 painter（刀 2）与 bumper（刀 5）引用 → max = 5，填 2 必须红。
  //    这条判据 2026-10-29 之前**整块空跑**：seed 解析正则按「第 2 列是数字」写，真 seed 匹不到一行，
  //    `seedStages.size === 0` 让「到期刀 == max」和「seed/实测集合对集」两条一起跳过，闸照绿。
  const tuneBase = {
    html: '<section id="view-reading"></section>'
      + '<section id="view-pages"><div id="a"></div></section>',
    appSource: 'function painter() {\n  el("a");\n}\nfunction bumper() {\n  el("a");\n}\n',
    viewSources: [{ fileName: "pages-view.js", source: "" }],
    exemptions: [],
    pagesStage: 1, pagesTotalCap: 5, pagesPendingCap: 0,
    pagesSeed: [{ host: "painter", ids: [], wires: [], stage: 2 },
      { host: "bumper", ids: [], wires: [], stage: 5 }],
  };
  const tuned = r3Problems({ ...tuneBase, pagesExemptions: [{ id: "a", cap: 2, stage: 2 }] });
  assert.ok(
    tuned.some((item) => item.includes("到期刀 2 ≠ 现算的 max 5")),
    `R3 pages 自检失败：到期刀手调也放过——${tuned.join("；")}`,
  );

  // ⑥ 受阻项：到期刀**不再写死 5**，只要 stage > PAGES_STAGE 就合法（留外壳 = 有据可查地留）
  const blockedOk = r3Problems({
    ...base,
    pagesStage: 2,
    pagesExemptions: [
      { id: "a", cap: 2, stage: 3, 阻塞段: "setupShell 1261–1264" },
      { id: "b", cap: 1, stage: 3 },
    ],
  });
  assert.deepEqual(blockedOk, [],
    `R3 pages 自检失败：受阻项 stage 3 > PAGES_STAGE 2 也被拦——受阻项的刀号又写死了（${blockedOk.join("；")}）`);

  // ⑦ 受阻项到期了还挂着：stage <= PAGES_STAGE → 必须红（「到期不搬」换个说法）
  const blockedExpired = r3Problems({
    ...base,
    pagesStage: 2,
    pagesExemptions: [
      { id: "a", cap: 2, stage: 2, 阻塞段: "setupShell 1261–1264" },
      { id: "b", cap: 1, stage: 3 },
    ],
  });
  assert.ok(
    blockedExpired.some((item) => item.includes("还没到期才有资格叫「受阻」")),
    `R3 pages 自检失败：受阻项到期（stage 2 <= PAGES_STAGE 2）被放过——${blockedExpired.join("；")}`,
  );

  // ⑧ 总上限 > 逐项之和：给「未登记的引用」留了空白 → 必须红（否则「合计上限」这条判据在空转）
  const capSlack = r3Problems({
    ...base,
    pagesTotalCap: 4,   // 逐项 2 + 1 = 3
    pagesExemptions: [{ id: "a", cap: 2, stage: null }, { id: "b", cap: 1, stage: null }],
  });
  assert.ok(
    capSlack.some((item) => item.includes("给「未登记的引用」留了空白") && item.includes("空转")),
    `R3 pages 自检失败：总上限比逐项之和大也放过——${capSlack.join("；")}`,
  );

  // ⑨ 总上限 < 逐项之和：表自相矛盾 → 必须红
  const capShort = r3Problems({
    ...base,
    pagesTotalCap: 2,   // 逐项 2 + 1 = 3
    pagesExemptions: [{ id: "a", cap: 2, stage: null }, { id: "b", cap: 1, stage: null }],
  });
  assert.ok(
    capShort.some((item) => item.includes("逐项登记相加已超上限")),
    `R3 pages 自检失败：总上限比逐项之和小也放过——${capShort.join("；")}`,
  );
});

/**
 * R3 到期判据的**存在性**自检：seed 必须真的被解析出来。
 *
 * 为什么需要它：`r3Problems()` 里「到期刀 == 现算 max」「seed 与实测函数集合对集」两条
 * 都包在 `if (seedStages.size > 0)` 里——解析器一旦匹不到任何一行，**两条整块跳过**，
 * 闸照绿，表上 79 个到期日成了装饰。2026-10-29 真发生过：正则按「第 2 列是数字」写，
 * 而真 seed 第 2 列是 id 清单 → 匹配 0 行。这条自检让「判据存在」本身可被证伪。
 */
test("R3 自检（到期判据存在性）：seed 必须解析出函数→刀号，且与 seed 行数相等", () => {
  const file = fileURLToPath(new URL("../../docs/refactor/evidence/pages/stage2-movers-seed.md", import.meta.url));
  const text = readFileSync(file, "utf8");
  const rows = [...text.matchAll(/^\| `[A-Za-z_$][\w$]*` \|/gm)].length;
  const parsed = parseSeedRows(text);
  assert.deepEqual(parsed.problems, [], parsed.problems.join("\n"));
  // **seed 空：只在「豁免表也空」时才算落完整**（刀 8 的终态就是两边都空）。
  // 这条自检原本的立意是「解析器匹不到任何行 → 两条判据整块跳过 → 闸绿、判据变装饰」，
  // 所以两条都要判：seed 空但表还在 = seed 被误清空；表空但 seed 还有行 = 只清了表。
  if (rows === 0) {
    assert.equal(
      PAGES_R3_EXEMPTIONS.length, 0,
      `seed 里一行函数表都没有，但豁免表还挂着 ${PAGES_R3_EXEMPTIONS.length} 项——`
      + "这是「seed 被误清空」，不是落完整（落完整时表与 seed 同批清空）",
    );
    return;   // 两边都空：终态。下面所有以 seed 为准的判据都没有对象可判
  }
  assert.ok(
    PAGES_R3_EXEMPTIONS.length > 0,
    `豁免表是空的，但 seed 里还有 ${rows} 行函数——「表空了但 seed 还有行」是矛盾态：`
    + "先清表后清 seed 的中间态不该出现（落盘必须同批）",
  );
  assert.equal(
    parsed.rows.length, rows,
    `seed 有 ${rows} 行函数表，只解析出 ${parsed.rows.length} 个函数——解析又漂了，`
    + "「到期刀 == max」与「seed/实测覆盖」两条会整体空跑（闸绿、判据不存在）",
  );
  for (const row of parsed.rows) {
    // 刀号范围**不写死 1..5**（写死会在每一次增刀时变成拦路石，而且改它是"改判据"）：
    // 改为对照登记表——未登记的号在 parseSeedRows 里已经红过一次，这里只兜"解析串位"。
    assert.ok(isRegisteredKnife(row.stage),
      `seed 里 ${row.host} 的刀号 ${row.stage} 不在 knife-registry.mjs 登记表里——解析串位了`);
  }

  // 上界从 seed 原文现算（不写字面量）：与行解析是两个独立来源，抓"把行号/工数当刀号"的串位
  const maxStage = seedStageUpperBound(text);
  assert.ok(
    maxStage >= 1,
    `seed 的「到期刀」列里一格刀号都没扫到（上界=${maxStage}）——这条上界判据会恒真，`
    + "刀号写成行号、工数也照样绿（闸绿、判据不存在）",
  );
  const rangeProblems = seedStageRangeProblems(parsed.rows, maxStage);
  assert.deepEqual(rangeProblems, [], `seed 刀号越界——${rangeProblems.join("；")}`);

  // ② 合成 seed（最大刀 8）：上界现算 = 8 → 1..8 不报串位（刀 5 之后 seed 真的会有刀 6/7/8）
  const synthText = "| 函数 | 引用的 id | 行范围 | 到期刀 | wire |\n"
    + "| `zzSynth` | `a` | 1–2（2 行） | 刀8 |  |\n";
  const synth = parseSeedRows(synthText);
  assert.deepEqual(synth.problems, [],
    `合成 seed 本身不该有解析问题——有就说明自检走的不是真解析器：${synth.problems.join("；")}`);
  assert.equal(synth.rows.length, 1, "合成 seed 没解析出那一行——解析器与自检输入不同源");
  assert.equal(seedStageUpperBound(synthText), 8, "合成 seed 的上界没现算出 8——上界取法又写死了一处");
  const synthOk = seedStageRangeProblems(synth.rows, seedStageUpperBound(synthText));
  assert.deepEqual(synthOk, [],
    `上界现算成 8 却仍报串位——合法的新刀号被写死的 1..5 拦住：${synthOk.join("；")}`);

  // ③ 喂红：把上界写死回 1..5（2026-10-30 之前的老写法）→ 同一份合成 seed 必须红且点名串位
  const hardCoded = seedStageRangeProblems(synth.rows, 5);
  assert.ok(
    hardCoded.some((item) => item.includes("解析串位") && item.includes("zzSynth")),
    `上界写死成 1..5 却放过了刀 8——合法刀号夹带串位时这条判据就查不出来（${hardCoded.join("；") || "没报任何问题"}）`,
  );

  // ④ 串位形态：把行号当刀号（12608 = setupLibrary 的行范围起点）→ 超出上界 → 必须红
  const shifted = seedStageRangeProblems(
    [{ host: "setupLibrary", ids: [], wires: [], stage: 12608 }], maxStage,
  );
  assert.ok(
    shifted.some((item) => item.includes("setupLibrary") && item.includes("解析串位")),
    `行号当刀号被放过——上界判据没做工（${shifted.join("；") || "没报任何问题"}）`,
  );

  // ⑤ 小数刀号（刀2.5 在登记表里）不是串位：上界判据只要求"有限的、落在 1..上界"
  const decimal = seedStageRangeProblems([{ host: "setupLibrary", ids: [], wires: [], stage: 2.5 }], 8);
  assert.deepEqual(decimal, [], `刀2.5 是登记过的刀号，被当成串位——${decimal.join("；")}`);
});

/**
 * 刀号登记表两条自检（2026-10-30 Chief 裁定：刀号不该手写，也不该在解析不了时静默跳过）。
 *
 * 旧形态的两个失效互为镜像，所以两条都要喂红：
 * ```
 * ① 解析不了的那行被 `continue` 掉 → 该 (函数,id) 变 unmapped → 到期刀少算 → 闸绿账本少一行
 * ② 号本身没登记 → 到期点指向一个不存在的刀 → 一样绿
 * ```
 * 第三条是 Chief 点名的 `刀10`：旧正则 `/^刀(\d)$/` 只吃单数字，`刀10` 整行消失。
 */
test("刀号登记表自检：刀10 必须解析 / 解析不了必须红 / 未登记号必须红 / PAGES_STAGE 跟着 landed 走", () => {
  const row = (host, stage) => `| \`${host}\` | \`some-id\` | 1–2（2 行） | ${stage} |  |\n`;
  const header = "| 函数 | 引用的 id | 行范围 | 到期刀 | wire |\n|---|---|---|---|---|\n";

  // ① 多位数 × 小数（刀10.1）与纯小数（刀2.5）都必须解析得出来 —— 旧正则两条都吃掉整行
  //    2026-11-01：刀 10 拆成 10.1/10.2 两个子刀，"多位数"这条改用 10.1 验（同时覆盖多位数与小数）
  const wide = parseSeedRows(header + row("boot", "刀10.1") + row("setupLibrary", "刀2.5"));
  assert.deepEqual(wide.problems, [],
    `刀10.1 / 刀2.5 不该解析失败——${wide.problems.join("；")}`);
  assert.deepEqual(wide.rows.map((item) => item.stage), [10.1, 2.5],
    "刀10.1 / 刀2.5 解析出的刀号不对（旧正则 `^刀(\\d)$` 会把这两行整行跳过）");

  // ② 解析不了的**必须红**，且红文要带行号 + 原文（否则读红文的人不知道是哪一行）
  const broken = parseSeedRows(header + row("boot", "刀5b") + row("setupLibrary", "刀 5"));
  assert.equal(broken.rows.length, 0, "解析不了的行不许悄悄进 rows");
  assert.equal(broken.problems.length, 2, `两行解析不了应报两条红——${broken.problems.join("；")}`);
  assert.ok(broken.problems[0].includes("seed 第 3 行") && broken.problems[0].includes("刀5b")
    && broken.problems[0].includes("整行会被跳过"),
  `红文没带行号/原文——${broken.problems[0]}`);
  assert.ok(broken.problems[1].includes("seed 第 4 行") && broken.problems[1].includes("刀 5"),
    `带空格的「刀 5」也必须红——${broken.problems[1]}`);

  // ③ 未登记的号必须红（不是"解析不了"，是"解析出来了但没有这一刀"）
  const unregistered = parseSeedRows(header + row("boot", "刀99"));
  assert.equal(unregistered.rows.length, 0, "未登记的刀号不许进 rows（fail closed）");
  assert.ok(unregistered.problems[0].includes("不在登记表"), `未登记号没红——${unregistered.problems[0]}`);

  // ④ PAGES_STAGE 不是一个可以手写的常数：必须等于登记表里标 landed 的最大刀号
  const landed = maxLandedKnife();
  assert.ok(KNIVES.some((knife) => knife.status === "landed"), "登记表里一刀都没标 landed——表被清空了？");
  // 当前刀现在由 `stageNow()` 现算（登记表 landed 与 git 提交首行取 max），不再是手写常数
  assert.equal(STAGE_NOW, landed,
    `当前刀 = ${STAGE_NOW}，但登记表里已落盘的最大刀号是 ${landed}——`
    + "要么登记表落后 git（只落笔没更新登记表），要么有人把常数改回来了");
});

/**
 * 「wire 列」自检三条（缺一条这一列就成摆设）：
 *
 * ```
 * a. wire 写成不存在的名字、自身名也不在实测 → 红（真丢函数的形态）
 * b. 实测冒出既不在 seed 名、也不在任一 wire 列的名字 → 红（新函数没登记）
 * c. host 与 wire 同时在实测里 → 绿（搬迁期中间态，不许拦）
 * ```
 *
 * 为什么必须有 c：刀 2.5 是分批把接线从 `setupXxx` 挪进 `wirePagesXxx`，中间态合法；
 * 若判据要求"必须二选一"或"严格相等"，每一步都会被判红，最后只能靠绕过提交。
 */
test("R3 自检（seed wire 列）：坏的 wire 要红、多出的实测名要红、host+wire 并存要绿", () => {
  const rows = [
    { host: "setupPageMore", wires: ["wirePagesPageMore"], stage: 2 },
    { host: "setupCollabControls", wires: [], stage: 2 },
  ];
  // 搬迁后：实测只有 wire 名
  const moved = new Set(["wirePagesPageMore", "setupCollabControls"]);
  assert.deepEqual(seedCoverageProblems(moved, rows), [],
    `seed 自检失败：合法的 wire 登记被误报——${seedCoverageProblems(moved, rows).join("；")}`);

  // c：搬迁期中间态——host 与 wire 同时出现在实测里，必须绿
  const both = new Set(["setupPageMore", "wirePagesPageMore", "setupCollabControls"]);
  assert.deepEqual(seedCoverageProblems(both, rows), [],
    `seed 自检失败：host 与 wire 并存（搬迁中间态）被拦住——${seedCoverageProblems(both, rows).join("；")}`);

  // a：wire 写成不存在的名字，且自身也不在实测 → 必须是"真丢函数"
  const brokenWire = [
    { host: "setupPageMore", wires: ["wirePagesNope"], stage: 2 },
    { host: "setupCollabControls", wires: [], stage: 2 },
  ];
  const a = seedCoverageProblems(moved, brokenWire);
  assert.ok(
    a.some((item) => item.includes("setupPageMore（wire wirePagesNope 也没出现）")),
    `seed 自检失败：坏的 wire 列被放过——${a.join("；")}`,
  );

  // d：一格挂多个 wire（setupLibrary 抽出 7 个接线函数的真实形态）——任一命中即算"在"
  const multi = [{ host: "setupLibrary", wires: ["wirePagesFilters", "wirePagesPageGrid"], stage: 2 }];
  assert.deepEqual(seedCoverageProblems(new Set(["wirePagesPageGrid"]), multi), [],
    "seed 自检失败：一格多 wire 时，只命中其中一个也被判丢");
  assert.ok(
    seedCoverageProblems(new Set(), multi)[0].includes("setupLibrary（wire wirePagesFilters/wirePagesPageGrid 也没出现）"),
    "seed 自检失败：一格多 wire 全不命中时，报错没说清是哪几个 wire",
  );

  // b：实测里冒出一个没登记的新名字 → 必须红
  const extra = new Set(["wirePagesPageMore", "setupCollabControls", "brandNewWiring"]);
  const b = seedCoverageProblems(extra, rows);
  assert.ok(
    b.some((item) => item.includes("brandNewWiring")),
    `seed 自检失败：没登记的新函数被放过——${b.join("；")}`,
  );
});

test("R3 自检（seed 同宿主多行）：id 不相交判绿、id 相交判红、同一 id 两行判红", () => {
  const rows = [
    { host: "setupLibrary", ids: ["a", "b"], wires: [], stage: 4 },
    { host: "setupLibrary", ids: ["c"], wires: [], stage: 5 },
  ];
  assert.deepEqual(seedHostOverlapProblems(rows), [],
    `seed 自检失败：同宿主两行、id 不相交也被判红——${seedHostOverlapProblems(rows).join("；")}`);
  // 每行各查各的刀：只按函数名查会在多行时拿到同一个刀号（那就把刀 5 的项写成刀 4 了）
  assert.equal(seedStageOf(rows, "setupLibrary", "b"), 4);
  assert.equal(seedStageOf(rows, "setupLibrary", "c"), 5);

  const overlap = [
    { host: "setupLibrary", ids: ["a", "b"], wires: [], stage: 4 },
    { host: "setupLibrary", ids: ["b"], wires: [], stage: 5 },
  ];
  assert.ok(seedHostOverlapProblems(overlap).some((m) => m.includes("id b 被两行同时认领")),
    `seed 自检失败：id 相交被放过——${seedHostOverlapProblems(overlap).join("；")}`);

  const twice = [
    { host: "x", ids: ["a"], wires: [], stage: 2 },
    { host: "x", ids: ["a", "b"], wires: [], stage: 5 },
  ];
  assert.ok(seedHostOverlapProblems(twice).some((m) => m.includes("id a 被两行同时认领")),
    `seed 自检失败：同一 id 出现在两行被放过——${seedHostOverlapProblems(twice).join("；")}`);
});

test("R3 自检（blocked 阻塞段）：stage > PAGES_STAGE 且段号可查判绿，其余判红", () => {
  const base = {
    html: '<section id="view-reading"></section>'
      + '<section id="view-pages"><div id="a"></div></section>',
    appSource: 'function painter() {\n  el("a");\n}\n',
    viewSources: [{ fileName: "pages-view.js", source: "" }],
    exemptions: [],
    pagesStage: 2, pagesTotalCap: 1, pagesPendingCap: 0, pagesSeed: [],
    // **夹具自带上限，不读线上常数**：刀 6 把 7 个受阻项全删、BLOCKED_MAX 7→0，
    // 夹具若跟着线上常数走，"1 项受阻"的绿例会被判红——那是夹具依赖了被验的常数，不是判据坏了。
    pagesBlockedCap: 7,
  };
  const segment = [...keepShellSegmentLabels()][0];
  assert.ok(segment, "留外壳清单一段都读不出来——这条自检本身失效了");

  const green = r3Problems({ ...base, pagesExemptions: [{ id: "a", cap: 1, stage: 5, 阻塞段: segment }] });
  assert.deepEqual(green, [], `blocked 自检失败：合规受阻项被误报——${green.join("；")}`);

  // 到期刀不再是写死的 5：同样的 5，只要 PAGES_STAGE 还没到 5 就绿（上面那条），到了就红（这条）
  const atStage5 = r3Problems({
    ...base, pagesStage: 5, pagesExemptions: [{ id: "a", cap: 1, stage: 5, 阻塞段: segment }],
  });
  assert.ok(atStage5.some((m) => m.includes("受阻项必须 stage > PAGES_STAGE")),
    `blocked 自检失败：PAGES_STAGE=5 时 stage=5 的受阻项（已到期）被放过——${atStage5.join("；")}`);

  const badStage = r3Problems({ ...base, pagesExemptions: [{ id: "a", cap: 1, stage: 2, 阻塞段: segment }] });
  assert.ok(badStage.some((m) => m.includes("受阻项必须 stage > PAGES_STAGE")),
    `blocked 自检失败：stage=2 带阻塞段被放过——${badStage.join("；")}`);

  const badSegment = r3Problems({
    ...base, pagesExemptions: [{ id: "a", cap: 1, stage: 5, 阻塞段: "setupLibrary 9999–10000" }],
  });
  assert.ok(badSegment.some((m) => m.includes("在留外壳清单里查不到")),
    `blocked 自检失败：查不到的段号被放过——${badSegment.join("；")}`);

  const emptySegment = r3Problems({ ...base, pagesExemptions: [{ id: "a", cap: 1, stage: 5, 阻塞段: " " }] });
  assert.deepEqual(emptySegment.filter((m) => m.includes("受阻项必须 stage > PAGES_STAGE")), [],
    "空白阻塞段不该被当成受阻项（它根本没写理由）");

  const eight = Array.from({ length: 8 }, () => ({ id: "a", cap: 1, stage: 5, 阻塞段: segment }));
  const over = r3Problems({ ...base, pagesExemptions: eight });
  assert.ok(over.some((m) => m.includes("受阻项 8 > 上限 7")),
    `blocked 自检失败：8 项受阻被放过——${over.join("；")}`);

  const raised = r3Problems({ ...base, pagesExemptions: eight, pagesBlockedCap: 8 });
  assert.ok(raised.some((m) => m.includes("受阻项上限被抬到 8")),
    `blocked 自检失败：把上限抬到 8 被放过——${raised.join("；")}`);
});

test("当前刀由两源现算：两源交叉校验 + 账本核对（无 git 打印跳过，不红也不静默）", () => {
  const gitMax = pagesStageFromGit();
  if (gitMax === null) {
    // pre-commit 验的是 checkout-index 导出的临时树，那里没有自己的一份历史
    console.log("ℹ gate-switch: 无 git 历史，跳过当前刀的两源推导（pre-push 会跑）");
    return;
  }
  const registryMax = maxLandedKnife();
  const stage = stageNow({ gitMax, registryMax });
  const problems = [
    // 真值源交叉校验：delta 0 / 1 绿（1 = 正在落这一刀），≥2 与 <0 红
    ...stageSourceProblems({ gitMax, registryMax }),
    // 账本核对：当前刀 == min(seed 剩余到期刀) − 1
    ...pagesStageProblems({ stage, seedRows: pagesSeedRows() }),
  ];
  assert.ok(Number.isFinite(stage), `当前刀应是一个数（git=${gitMax} / 登记表=${registryMax}）`);
  assert.deepEqual(problems, [], problems.join("；"));
});

test("两源交叉校验自检：delta 0/1 绿、delta ≥2 红、delta <0 红、一刀未落盘红", () => {
  // 基准取今天的真值（刀 6 已落盘）：delta 0 = 6/6
  assert.deepEqual(stageSourceProblems({ gitMax: 6, registryMax: 6 }), [],
    "交叉校验自检失败：delta 0 被判红");

  // delta = 1：本笔正在落第 registryMax 刀，git 历史里还看不到它 → 绿（刀 6 那一笔就是这个形态）
  assert.deepEqual(stageSourceProblems({ gitMax: 6, registryMax: 7 }), [],
    "交叉校验自检失败：delta 1（在途一刀）被判红——那样每一刀的提交都过不去");

  // delta = 2：只改登记表没落 move 笔 → 红
  const ahead = stageSourceProblems({ gitMax: 6, registryMax: 8 });
  assert.ok(ahead.some((m) => m.includes("登记表领先 2 刀") && m.includes("git 只到 6")),
    `交叉校验自检失败：delta 2 被放过——${ahead.join("；")}`);

  // delta = -1：只落了笔没更新登记表 → 红
  const behind = stageSourceProblems({ gitMax: 7, registryMax: 6 });
  assert.ok(behind.some((m) => m.includes("登记表落后 git 1 刀")),
    `交叉校验自检失败：delta -1 被放过——${behind.join("；")}`);

  // 一刀都没标 landed → 红（不许清空登记表当通行证）
  const empty = stageSourceProblems({ gitMax: 5, registryMax: 0 });
  assert.ok(empty.some((m) => m.includes("一刀都没标 landed")),
    `交叉校验自检失败：清空登记表被当成绿——${empty.join("；")}`);

  // **子刀在途**（2026-10-30 Builder 撞出）：9.1 落在途时 delta = 0.1，
  // 旧写法只认 `=== 0 || === 1`，0.1 会落进"落后"分支并报成负数（-0.0999…）。
  assert.deepEqual(stageSourceProblems({ gitMax: 9, registryMax: 9.1 }), [],
    "交叉校验自检失败：子刀在途（delta 0.1）被判红——9.1/9.2… 每一刀都会撞这条");
  assert.deepEqual(stageSourceProblems({ gitMax: 9.1, registryMax: 9.2 }), [],
    "交叉校验自检失败：子刀之间的在途（delta 0.1）被判红");
  const overSub = stageSourceProblems({ gitMax: 9, registryMax: 10.5 });
  assert.ok(overSub.some((m) => m.includes("登记表领先 1.5 刀")),
    `交叉校验自检失败：子刀 + 领先超过一刀没红或数字不好看——${overSub.join("；")}`);
  const behindSub = stageSourceProblems({ gitMax: 9.2, registryMax: 9 });
  assert.ok(behindSub.some((m) => m.includes("登记表落后 git 0.2 刀")),
    `交叉校验自检失败：子刀落后没红或数字不好看（浮点尾巴没格式化）——${behindSub.join("；")}`);

  // 小数刀号用 Number（parseInt("2.5") = 2 会把 2.5 悄悄当 2）
  assert.deepEqual(stageSourceProblems({ gitMax: 2.5, registryMax: 2.5 }), [],
    "交叉校验自检失败：小数刀号被误判（是不是用了 parseInt？）");
  assert.equal(gitMaxKnifeFromLog("move(pages): 刀 2.5 装配\nmove(pages): 刀 5 x"), 5,
    "交叉校验自检失败：刀 2.5 解析错了");
  assert.equal(stageNow({ gitMax: 5, registryMax: 6 }), 6, "当前刀应取两源较大的那个");
});

const RETIRED_EDIT_MSG = ["COMMIT", "EDITMSG"].join("_");   // 拆开拼：本测试的源码不该命中自己

test(`已删除的那套不许有残留：去注释后的源码里不许再出现 ${RETIRED_EDIT_MSG}`, () => {
  const needle = RETIRED_EDIT_MSG;
  const files = ["boundary.test.mjs", "knife-registry.mjs", "feature-contract.mjs"];
  const hits = [];
  for (const file of files) {
    // **只去注释、保留字符串**：`readFileSync(join(dir, <那个文件名>))` 这种才是真读它的形态
    const code = codeOnly(readFileSync(join(A5_TEST_DIR, file), "utf8"));
    if (code.includes(needle)) hits.push(file);
  }
  assert.deepEqual(hits, [],
    `${hits.join("、")} 又出现 ${needle} 的**代码**引用：pre-commit 时那个文件是上一笔的残留消息，`
    + "读它会让判据跳过若干刀（旧的「正在提交的这一笔」方案正是因此被撤）");
});

test("seed 取样读的是「跑这份代码的那棵树」（pre-commit = 索引导出树），不是工作区/HEAD", () => {
  const seedFile = fileURLToPath(new URL("../../docs/refactor/evidence/pages/stage2-movers-seed.md", import.meta.url));
  const treeRoot = fileURLToPath(new URL("../../", import.meta.url));
  assert.ok(seedFile.startsWith(treeRoot),
    `seed 路径不在这棵树里（${seedFile}）——pre-commit 会拿错树比`);
  assert.ok(existsSync(seedFile), `seed 文件在这棵树里不存在：${seedFile}`);
  // 同一棵树：app.js 与 seed 必须来自同一个根，否则「索引版 seed」会跟「工作区 app.js」比
  assert.ok(APP_FILE.startsWith(treeRoot),
    `app.js 路径不在这棵树里（${APP_FILE}）——两种模式（工作区/导出树）会各读一半`);
});

test("账本核对自检：表非空且当前刀 ≠ min−1 → 红；表空不分支 → 绿", () => {
  const rows = [
    { host: "a", ids: [], wires: [], stage: 6 },
    { host: "b", ids: [], wires: [], stage: 8 },
  ];
  assert.deepEqual(pagesStageProblems({ stage: 5, seedRows: rows }), [],
    `账本核对自检失败：当前刀 5 = min(6)−1 也被判红——${pagesStageProblems({ stage: 5, seedRows: rows }).join("；")}`);

  const off = pagesStageProblems({ stage: 7, seedRows: rows });
  assert.ok(off.some((m) => m.includes("账本与已落盘不一致")),
    `账本核对自检失败：当前刀 7 与账本 min 6 不符也被放过——${off.join("；")}`);

  // 表空不分支：没有 min(∅) 的歧义
  assert.deepEqual(pagesStageProblems({ stage: 99, seedRows: [] }), [],
    "账本核对自检失败：表空时还在算 min(∅)");

  // 首行解析：只认 move(pages)，其它 move(<视图>) 不算；小数刀号能解析；没有就返回 null
  assert.equal(
    pagesStageFromSubjects(["move(pages): 刀 5 —— x", "move(pages): 刀 2.5 a", "move(index-tile): x"]), 5,
    "首行刀号解析错了（多认了别的视图或少认了小数刀）",
  );
  assert.equal(pagesStageFromSubjects(["docs: x", "fix(ui): y"]), null,
    "没有 move(pages) 首行时该返回 null");
});

/**
 * A1 白名单存在性判定内核（纯函数，自检喂假表）。
 *
 * 防的是：白名单里写了一个**不存在的名字** —— 判据看起来在点名，实际那个名字从来没被用过，
 * 对应的等级静默失效（`PAGES_R3_STAGE` 那次就是这么丢的）。
 * 空名单也红：**空表的循环体一次都不跑**，等于这条判据不存在（R4b 同型）。
 */
export function blockNameProblems({ names, tableSource, retired = [] }) {
  const problems = [];
  const table = String(tableSource || "");
  if (!names || names.length === 0) {
    problems.push("白名单为空——空表的循环体一次都不跑，这条判据等于不存在");
  }
  for (const name of names || []) {
    if (!new RegExp(`export const ${name}\\b`).test(table)) {
      problems.push(`白名单里的 ${name} 在豁免表里不存在——写错名字等于静默失效`);
    }
  }
  for (const name of retired || []) {
    if (new RegExp(`export const ${name}\\b`).test(table)) {
      problems.push(`已退役的 ${name} 又回到了豁免表——它已被现算取代，回来就等于重新打开「手工常数静默停用」的口子`);
    }
  }
  return problems;
}

test("A1 白名单存在性：MOVE_EXEMPTION_BLOCKS 里每个名字都必须是文件里真实存在的常量", () => {
  const tablePath = fileURLToPath(new URL("./pages-r3-exemptions.mjs", import.meta.url));
  const problems = blockNameProblems({
    names: MOVE_EXEMPTION_BLOCKS,
    retired: MOVE_EXEMPTION_BLOCKS_RETIRED,
    tableSource: readFileSync(tablePath, "utf8"),
  });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("A1 白名单存在性自检：不存在点名红 / 退役名字回来红 / 空名单红 / 合规绿", () => {
  const table = "export const PAGES_R3_TOTAL_CAP = 193;\nexport const PAGES_R3_EXEMPTIONS = [];\n";
  assert.deepEqual(blockNameProblems({ names: ["PAGES_R3_TOTAL_CAP"], tableSource: table }), [],
    "A1 自检失败：合规白名单被误报");

  const missing = blockNameProblems({ names: ["PAGES_R3_STAGE"], tableSource: table });
  assert.ok(missing.some((m) => m.includes("PAGES_R3_STAGE") && m.includes("不存在")),
    `A1 自检失败：点名一个不存在的常量被放过——${missing.join("；")}`);

  const back = blockNameProblems({ names: [], retired: ["PAGES_R3_STAGE"], tableSource: "export const PAGES_R3_STAGE = 2;\n" });
  assert.ok(back.some((m) => m.includes("已退役")),
    `A1 自检失败：退役的常量回到表里被放过——${back.join("；")}`);

  const empty = blockNameProblems({ names: [], tableSource: table });
  assert.ok(empty.some((m) => m.includes("白名单为空")),
    `A1 自检失败：空白名单被放过（循环体一次都不跑）——${empty.join("；")}`);
});

test("move: 自检（A1 认 Move-Gate 声明）：a 声明+收紧绿 / b 未声明红 / c 声明+放宽红 / e 块外改动红", () => {
  const table = (cap, extra = "") => ["export const PAGES_R3_TOTAL_CAP = 193;",
    "export const PAGES_R3_EXEMPTIONS = [", `  { id: "a", cap: ${cap}, stage: 2 },`, "];", extra].join("\n");
  const cases = (afterLines, parentLines, added = [[3, 3]], deleted = [[3, 3]]) => [{
    path: "tests/js/pages-r3-exemptions.mjs", addedRanges: added, deletedRanges: deleted,
    commitSource: afterLines, parentSource: parentLines,
  }];
  const files = ["backend/book2text/static/app.js", "tests/js/pages-r3-exemptions.mjs"];
  const run = (after, parent, declared, added, deleted) => moveScopeProblems({
    sha: "mov1234", files, changes: cases(after, parent, added, deleted), declaredPaths: declared,
  });
  const parent = table(10);
  // a：声明 + 只收紧 → 绿
  assert.deepEqual(run(table(5), parent, ["tests/js/pages-r3-exemptions.mjs"]), [],
    `A1 自检失败：声明 + 只收紧被判红——${run(table(5), parent, ["tests/js/pages-r3-exemptions.mjs"]).join("；")}`);
  // b：未声明 → 仍按三张表块判 → 红
  // 未声明时行为回到旧 A1：这个文件一块都解析不到 → 报「找不到登记表块」（同样是红）
  assert.ok(run(table(5), parent, []).some((m) => m.includes("找不到登记表块") || m.includes("不在登记表内")),
    `A1 自检失败：未声明改表被放过——${run(table(5), parent, []).join("；")}`);
  // c：声明 + 放宽（cap 10 → 11）→ 方向判据红
  assert.ok(run(table(11), parent, ["tests/js/pages-r3-exemptions.mjs"]).some((m) => m.includes("cap 合计")),
    `A1 自检失败：声明后放宽被放过——${run(table(11), parent, ["tests/js/pages-r3-exemptions.mjs"]).join("；")}`);
  // f：刀号登记表 KNIVES 是 A1 认的第四张表——块内（本刀 pending → landed）绿，块外仍红
  const reg = (rows, extra = "") => [
    "export const KNIVES = [",
    ...rows,
    "];",
    "export function stageSourceProblems() {",
    extra || "  return [];",
    "}",
  ].join("\n");
  const regCases = (afterLines, parentLines, added, deleted) => [{
    path: "tests/js/knife-registry.mjs", addedRanges: added, deletedRanges: deleted,
    commitSource: afterLines, parentSource: parentLines,
  }];
  const regFiles = ["backend/book2text/static/app.js", "tests/js/knife-registry.mjs"];
  const regDeclared = ["tests/js/knife-registry.mjs"];
  const regRun = (after, parentSrc, added, deleted) => moveScopeProblems({
    sha: "mov5678", files: regFiles, changes: regCases(after, parentSrc, added, deleted),
    declaredPaths: regDeclared,
  });
  const regParent = reg(['  { n: 5, status: "landed" },']);
  const regMoved = reg(['  { n: 6, status: "landed" },']);
  assert.deepEqual(regRun(regMoved, regParent, [[2, 2]], [[2, 2]]), [],
    `A1 自检失败：KNIVES 块内的落盘改动被判红——${regRun(regMoved, regParent, [[2, 2]], [[2, 2]]).join("；")}`);
  const regOutsideBody = reg(['  { n: 5, status: "landed" },'], "  const zz = 1;");
  const regOutsideProblems = regRun(regOutsideBody, regParent, [[5, 5]], [[5, 5]]);
  assert.ok(regOutsideProblems.some((m) => m.includes("不在登记表内")),
    `A1 自检失败：KNIVES 块外的改动被放过——放宽到 KNIVES 不等于放行整个文件（${regOutsideProblems.join("；") || "没报任何问题"}）`);

  // e：声明但改动落在块外（注释行）→ 仍红（口子只覆盖登记常量，不是整文件）
  const outside = table(5, "// 块外注释");
  assert.ok(run(outside, parent, ["tests/js/pages-r3-exemptions.mjs"], [[5, 5]], [[5, 5]])
    .some((m) => m.includes("不在登记表内") || m.includes("找不到登记表块")),
    `A1 自检失败：块外改动被放过——${run(outside, parent, ["tests/js/pages-r3-exemptions.mjs"]).join("；")}`);
});

test("Move-Gate 五条：未声明改 tests/js 红 / 空声明红 / 声明成立绿 / 删声明红 / cap 增大红", () => {
  const base = {
    subject: "move(pages): 刀 2.5 落盘",
    files: ["backend/book2text/static/app.js", "tests/js/boundary.test.mjs",
      "tests/js/pages-r3-exemptions.mjs"],
    exemptionTouched: true,
    directionChecked: true,
  };
  const declared = "move(pages): 刀 2.5 落盘\n\nMove-Gate: tests/js/boundary.test.mjs, tests/js/pages-r3-exemptions.mjs";

  // c：声明 + 只收紧 → 绿（c' 证明这个绿是声明换来的）
  assert.deepEqual(moveGateProblems({ ...base, message: declared }), [],
    `Move-Gate 自检失败：合法声明被判红——${moveGateProblems({ ...base, message: declared }).join("；")}`);

  // f：刀号登记表是数据不是判据代码，落盘那刀要改它 → 声明后必须放行（否则每刀都撞「白名单外」）
  const regBase = {
    subject: "move(pages): 刀 6 片段抽取",
    files: ["backend/book2text/static/app.js", "tests/js/knife-registry.mjs"],
    exemptionTouched: false,
    directionChecked: false,
  };
  const regDeclared = "move(pages): 刀 6 片段抽取\n\nMove-Gate: tests/js/knife-registry.mjs";
  assert.deepEqual(moveGateProblems({ ...regBase, message: regDeclared }), [],
    `Move-Gate 自检失败：登记表在白名单里却被判「白名单外」——${moveGateProblems({ ...regBase, message: regDeclared }).join("；")}`);
  const regOutside = moveGateProblems({ ...regBase, message: "Move-Gate: tests/js/nope.mjs" });
  assert.ok(regOutside.some((m) => m.includes("白名单外")),
    `Move-Gate 自检失败：白名单外的路径被放过——${regOutside.join("；")}`);

  // c'：同 c 内容、删掉 Move-Gate: 行 → ④ 改动 ⊆ 声明 必须红
  const noDecl = moveGateProblems({ ...base, message: "move(pages): 刀 2.5 落盘" });
  assert.deepEqual(noDecl, [], "没有 Move-Gate 行 = 不是 Move-Gate 笔（走原 A1，不该由这里报）");
  const partial = moveGateProblems({ ...base, message: "Move-Gate: tests/js/pages-r3-exemptions.mjs" });
  assert.ok(partial.some((m) => m.includes("没在 Move-Gate 里声明")),
    `Move-Gate 自检失败：改了 boundary 却没声明被放过——${partial.join("；")}`);

  // a：未声明却改 boundary → 红（④）
  const a = moveGateProblems({ ...base, message: "Move-Gate: tests/js/pages-r3-exemptions.mjs" });
  assert.ok(a.some((m) => m.includes("tests/js/boundary.test.mjs")),
    `Move-Gate 自检失败：未声明改动被放过——${a.join("；")}`);

  // b：声明了没改 → 红（③）
  const b = moveGateProblems({ ...base, message: "Move-Gate: tests/js/boundary.test.mjs, tests/js/feature-contract.mjs, tests/js/pages-r3-exemptions.mjs" });
  assert.ok(b.some((m) => m.includes("声明了 tests/js/feature-contract.mjs")),
    `Move-Gate 自检失败：空声明被放过——${b.join("；")}`);

  // d：声明 + cap 增大 → 红（① 方向判据）
  const d = moveGateProblems({
    ...base,
    message: declared,
    directionProblems: ["cap 合计（全表）: 17 → 18（+1）——move: 只许收紧"],
  });
  assert.ok(d.some((m) => m.includes("cap 合计（全表）")),
    `Move-Gate 自检失败：方向判据的红没传出来——${d.join("；")}`);

  // 白名单 + test-contract: 不认
  const offList = moveGateProblems({ ...base, message: "Move-Gate: backend/book2text/static/app.js" });
  assert.ok(offList.some((m) => m.includes("白名单外")), `白名单没拦住——${offList.join("；")}`);
  const contract = moveGateProblems({ ...base, subject: "test-contract: x", message: declared });
  assert.ok(contract.some((m) => m.includes("不认 Move-Gate")), `test-contract: 也认了 Move-Gate——${contract.join("；")}`);
});

test("move: 自检（豁免表按方向）：cap 分组增/新增项/提前释放/推迟缺段号都要红，收紧判绿", () => {
  const table = (entries) => [
    "export const PAGES_R3_TOTAL_CAP = 193;",
    "export const PAGES_R3_EXEMPTIONS = [",
    ...entries.map((one) => `  { id: "${one.id}", cap: ${one.cap}, stage: ${one.stage}${one.blocked ? `, 阻塞段: "${one.blocked}"` : ""} },`),
    "];",
  ].join("\n");
  const segment = [...keepShellSegmentLabels()][0];
  const before = table([
    { id: "a", cap: 10, stage: 2 },
    { id: "b", cap: 5, stage: 5 },
    { id: "gone", cap: 2, stage: 2 },
  ]);
  const run = (afterSource) => exemptionDeltaProblems({
    sha: "mov1234", oldSource: before, newSource: afterSource, keepListText: null,
  });

  // d 的正例：删一项 + 某项 2 → 5 带段号 + cap 分组不增 → 绿
  const tightened = table([
    { id: "a", cap: 5, stage: 2 },
    { id: "b", cap: 5, stage: 5, blocked: segment },
  ]);
  assert.deepEqual(run(tightened), [], `move: 自检失败：合法收紧被判红——${run(tightened).join("；")}`);

  // a：cap 某组 +1 → 红
  const capped = table([
    { id: "a", cap: 11, stage: 2 },
    { id: "b", cap: 5, stage: 5 },
    { id: "gone", cap: 2, stage: 2 },
  ]);
  assert.ok(run(capped).some((m) => m.includes("cap 合计（全表）") || m.includes("cap 合计 stage2:")),
    `move: 自检失败：cap 分组增加被放过——${run(capped).join("；")}`);

  // b：新增一项 → 红
  const added = table([
    { id: "a", cap: 10, stage: 2 },
    { id: "b", cap: 5, stage: 5 },
    { id: "gone", cap: 2, stage: 2 },
    { id: "newbie", cap: 1, stage: 5, blocked: segment },
  ]);
  assert.ok(run(added).some((m) => m.includes("豁免表新增 1 项（newbie）")),
    `move: 自检失败：新增豁免项被放过——${run(added).join("；")}`);

  // c-1：5 → 2 提前释放 → 红
  const early = table([
    { id: "a", cap: 10, stage: 2 },
    { id: "b", cap: 5, stage: 2 },
    { id: "gone", cap: 2, stage: 5 },
  ]);
  assert.ok(run(early).some((m) => m.includes("提前释放")),
    `move: 自检失败：提前释放被放过——${run(early).join("；")}`);

  // c-2：2 → 5 但不带阻塞段 → 红
  const noReason = table([
    { id: "a", cap: 10, stage: 5 },
    { id: "b", cap: 5, stage: 5 },
  ]);
  assert.ok(run(noReason).some((m) => m.includes("但没写「阻塞段」")),
    `move: 自检失败：推迟却不写阻塞段被放过——${run(noReason).join("；")}`);

  // c-3：段号查不到 → 红
  const badSegment = table([
    { id: "a", cap: 10, stage: 5, blocked: "setupLibrary 9999–10000" },
    { id: "b", cap: 5, stage: 5 },
    { id: "gone", cap: 2, stage: 2 },
  ]);
  assert.ok(run(badSegment).some((m) => m.includes("不在留外壳清单里")),
    `move: 自检失败：查不到的段号被放过——${run(badSegment).join("；")}`);
});

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
  indexTileStartedAt: "index-view.js",
  indexScrollBound: "index-view.js",
  indexWindowRaf: "index-view.js",
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
  readingIntents: "reading-view.js",
  readingIntentStats: "reading-view.js",
  readingFlushRaf: "reading-view.js",
  readingSplitState: "reading-view.js",
  // pages 刀 1：**owner 只给 rules.py 的 MOVED_STATES**（权威来源，别手抄、别按上一轮的 10 项）。
  // 其余状态仍归外壳：app.js 里的 setter lambda（`setPageBlockPending: (v) => { … }`）是合法写点，
  // 它们本来就不在 OWNERS 里。
  layoutBlockLoading: "pages-view.js",
  setupSuggestionsLoading: "pages-view.js",
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
 * R5 防漏检判定内核（纯函数，自检喂假模块源码）。
 *
 * 防的是：**这个模块根本没被检查，而闸是绿的**。两种形态：
 *   ① 模块的顶层声明一个都没命中前缀（前缀写坏 / 模块改成 IIFE 却没登记）⇒ 循环体不跑；
 *   ② 模块登记成 IIFE，但文件已经不是 IIFE 了（被摊平成平铺模块）⇒ 照样一条不判。
 * 空模块列表同样红：一个模块都没扫到时的绿，是最坏的一种绿。
 *
 * IIFE 模块的闭包内状态是**模块私有**的（不跨文件写），所以不进 OWNERS——但这条豁免必须是
 * **显式登记**的，不能靠「反正扫不到」默认成立。
 */
export function r5CoverageProblems({ modules, owners, prefixes, iifeModules = [] }) {
  const problems = [];
  if (!modules || modules.length === 0) {
    problems.push("一个视图模块都没扫到——这条判据在空转");
    return problems;
  }
  const iife = new Set(iifeModules);
  for (const { fileName, source } of modules) {
    const code = codeOnly(String(source || ""));
    const pattern = prefixes[fileName];
    if (!pattern) {
      problems.push(`${fileName}: 没有登记状态前缀——新视图落盘必须同批加 OWNERS 与 VIEW_STATE_PREFIXES 一行`);
      continue;
    }
    // **只看列 0**：模块状态/常量都在顶层；函数里的局部量不属于模块。前缀表再按各模块的命名空间过滤。
    const declared = [...code.matchAll(/^(?:let|const|var)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
    const matched = declared.filter((name) => pattern.test(name));
    const isIife = /^\s*\(\s*function\b/.test(code);
    if (isIife && iife.has(fileName) && matched.length === 0) continue;   // 显式登记：闭包私有 + 命名空间零命中
    if (isIife && !iife.has(fileName) && matched.length === 0) {
      problems.push(`${fileName} 是 IIFE，但列 0 声明一个都没命中状态前缀，且没登记进 IIFE 名单——`
        + "这条判据对它一条都不判，要先说清楚它的状态归谁管");
      continue;
    }
    if (!isIife && iife.has(fileName)) {
      problems.push(`${fileName} 登记成「IIFE 不扫」，但它已经不是 IIFE 了——这条判据对它是空转的`);
    }
    if (declared.length > 0 && matched.length === 0) {
      problems.push(`${fileName}: 顶层有 ${declared.length} 个声明，但状态前缀一个都没命中——定位失败，这条判据对它是空转的`);
      continue;
    }
    for (const name of matched) {
      if (!(name in owners)) {
        problems.push(`${fileName}: 状态 ${name} 声明在模块里，但 OWNERS 里没有——不登记 = 不检查，绿是假的`);
      } else if (owners[name] !== fileName) {
        problems.push(`${name} 的 owner 是 ${owners[name]}，但它声明在 ${fileName}`);
      }
    }
  }
  return problems;
}

/**
 * R5 防表过期判定内核（纯函数，自检喂假源码）。
 *
 * 防的是：OWNERS 里登记了一个**源码里已经没有**的状态 —— 表变成墓地，下一个人照着表找代码会扑空，
 * 而「一状态一 owner」这条判据对那个名字永远是绿（它已经不在了，当然没人违规写它）。
 * OWNERS 为空同样红：没有登记项时，上面的豁免与归属全部无处可依。
 */
export function r5StaleProblems({ sources, owners }) {
  const problems = [];
  const entries = Object.keys(owners || {});
  if (entries.length === 0) {
    problems.push("OWNERS 是空的——空表让「一状态一 owner」无处可依，等于这条判据不存在");
    return problems;
  }
  const declared = new Set();
  for (const source of sources || []) {
    const code = stripCommentsAndStrings(String(source || ""));
    for (const match of code.matchAll(/(?:^|[^\w$])(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) {
      declared.add(match[1]);
    }
  }
  for (const state of entries) {
    if (!declared.has(state)) {
      problems.push(`OWNERS 里的状态 ${state} 在源码里不存在了——删状态请同批删表项，别把表变成墓地`);
    }
  }
  return problems;
}

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
  "index-view.js": /^(index|INDEX_|IMAGE_QUALITY_LABELS$)/,
  // library-view.js 是 IIFE 形态：顶层状态全在闭包里（列 2），模块自己不留状态——
  // 状态一律走注入的 getter/setter（libraryProjects / lockConflictTarget 留在外壳）。
  "library-view.js": /^(library|LIBRARY_)/,
  // merge-view.js 也是 IIFE：mergeHandled / mergeDecisions / mergeActivePageId 全在闭包内
  "merge-view.js": /^(merge|MERGE_)/,
  // pages-view.js：IIFE 形态，状态都在闭包里；模块级常量（若将来有）按 pages/PAGES_ 命名空间。
  "pages-view.js": /^(pages|PAGES_)/,
};

/**
 * **「列 0 扫不到状态」的 IIFE 模块**：闭包内状态是模块私有的（不跨文件写），不进 OWNERS。
 *
 * 这份名单是**显式豁免**，不是「反正扫不到」：登记在册但文件已经不是 IIFE ⇒ 红。
 *
 * **已知缺口（2026-11-01 实测，不粉饰）**：`pages-view.js` 的列 0 声明有 22 个
 * （`layoutBlockLoading` / `overlayRenderQueue` / `PAGE_OVERLAY_FRAME_LIMIT` …），
 * 而它的状态前缀 `/^(pages|PAGES_)/` **一个都没命中**——也就是说这条判据到今天为止
 * 对 pages-view 一条都没判过，一直是空转绿。这次把它从「静默不判」改成「显式登记不判」，
 * 并加了「登记成 IIFE 但已摊平 ⇒ 红」。真正的覆盖要先统一 pages-view 的命名空间或缩进，
 * 那是收口（刀 11）之后的事，别在这笔里顺手改一张共享表的语义。
 */
const VIEW_STATE_IIFE = ["library-view.js", "merge-view.js", "pages-view.js"];

test("R5 防漏检：每个视图模块的顶层状态都必须在 OWNERS 里，且 owner 指向自己", () => {
  const modules = readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith("-view.js"))
    .sort()
    .map((fileName) => ({ fileName, source: readFileSync(join(STATIC_DIR, fileName), "utf8") }));
  const problems = r5CoverageProblems({
    modules, owners: OWNERS, prefixes: VIEW_STATE_PREFIXES, iifeModules: VIEW_STATE_IIFE,
  });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("R5 防漏检自检：未登记状态红 / owner 指错红 / 前缀一个都没命中红 / IIFE 登记对不上红 / 空模块红", () => {
  const prefixes = { "a-view.js": /^alpha/, "b-view.js": /^beta/ };
  const owners = { alphaOne: "a-view.js" };
  const mod = (fileName, source) => [{ fileName, source }];
  const run = (modules, own = owners, iife = []) => r5CoverageProblems({ modules, owners: own, prefixes, iifeModules: iife });

  assert.deepEqual(run(mod("a-view.js", "let alphaOne = 1;\n")), [],
    "R5 防漏检自检失败：合规模块被误报");

  const missing = run(mod("a-view.js", "let alphaOne = 1;\nlet alphaTwo = 2;\n"));
  assert.ok(missing.some((m) => m.includes("alphaTwo") && m.includes("OWNERS 里没有")),
    `R5 防漏检自检失败：声明了没登记的状态被放过——${missing.join("；")}`);

  const wrongOwner = run(mod("a-view.js", "let alphaOne = 1;\n"), { alphaOne: "b-view.js" });
  assert.ok(wrongOwner.some((m) => m.includes("owner 是 b-view.js")),
    `R5 防漏检自检失败：owner 指向别的文件被放过——${wrongOwner.join("；")}`);

  // **定位失败**：模块里明明有顶层声明，前缀却一个都没命中 → 循环体不跑，必须红
  const localed = run(mod("a-view.js", "let otherThing = 1;\n"));
  assert.ok(localed.some((m) => m.includes("一个都没命中") && m.includes("空转")),
    `R5 防漏检自检失败：前缀一个都没命中却绿（判据在空转）——${localed.join("；")}`);

  // IIFE 两种对不上：没登记 / 登记了但已经不是 IIFE
  const unlistedIife = run(mod("a-view.js", "(function () {\n  let x = 1;\n})();\n"));
  assert.ok(unlistedIife.some((m) => m.includes("是 IIFE") && m.includes("没登记进 IIFE 名单")),
    `R5 防漏检自检失败：IIFE 模块没登记也被放过——${unlistedIife.join("；")}`);
  const flattened = run(mod("a-view.js", "let alphaOne = 1;\n"), owners, ["a-view.js"]);
  assert.ok(flattened.some((m) => m.includes("已经不是 IIFE")),
    `R5 防漏检自检失败：登记成 IIFE 却已摊平（判据空转）被放过——${flattened.join("；")}`);

  const none = run([]);
  assert.ok(none.some((m) => m.includes("一个视图模块都没扫到")),
    `R5 防漏检自检失败：空模块列表被放过——${none.join("；")}`);
});

test("R5 防表过期：OWNERS 里的状态必须还存在（删了状态要同批删表项）", () => {
  const sources = readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((fileName) => readFileSync(join(STATIC_DIR, fileName), "utf8"));
  const problems = r5StaleProblems({ sources, owners: OWNERS });
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.ok(R5_EXCUSES.length <= R5_MAX_EXCUSES,
    `R5 豁免 ${R5_EXCUSES.length} 条，上限 ${R5_MAX_EXCUSES}——开口要显式加数字`);
});

test("R5 防表过期自检：状态没了红 / 都还在绿 / 注释里出现不算还在 / 空 OWNERS 红", () => {
  const owners = { readingFilter: "reading-view.js", readingTops: "reading-view.js" };
  assert.deepEqual(
    r5StaleProblems({ sources: ["let readingFilter = 1;\nlet readingTops = {};\n"], owners }), [],
    "R5 防表过期自检失败：都还在也被判红",
  );

  const gone = r5StaleProblems({ sources: ["let readingFilter = 1;\n"], owners });
  assert.ok(gone.some((m) => m.includes("readingTops") && m.includes("不存在了")),
    `R5 防表过期自检失败：状态已删、表项还在被放过——${gone.join("；")}`);

  // 只剩注释里提到 → 仍然算过期（剥注释，别把「提过」当「还在」）
  const commentOnly = r5StaleProblems({ sources: ["let readingFilter = 1;\n// let readingTops = {};\n"], owners });
  assert.ok(commentOnly.some((m) => m.includes("readingTops")),
    `R5 防表过期自检失败：注释里的名字被当成还在——${commentOnly.join("；")}`);

  const empty = r5StaleProblems({ sources: ["let x = 1;\n"], owners: {} });
  assert.ok(empty.some((m) => m.includes("OWNERS 是空的")),
    `R5 防表过期自检失败：空 OWNERS 被放过——${empty.join("；")}`);
});

// ---------------------------------------------------------------- 文档刀号（C 方案）

/**
 * **C 方案：带字母的刀号必须「看得见是名字」**（Architect `export-ratchet.md` §五 裁定）。
 *
 * 为什么单列一条：刀号登记表只认数字（`刀 9.1` 解析 9.1），带字母的旧名（`刀 5b`）
 * 在登记表里**不是刀号，是一句话里的名字**。裸写会让下一个读文档的人以为库里真有个 5b，
 * 而 seed 的解析器 `^刀(\d)$` 遇到它只会把整行跳过——静默少算一项。
 *
 * 判据形态：**剥掉引号/反引号里的内容**，剩下的正文里再扫 `刀 <数字>[字母]`；
 * 命中即红。这样「`刀 5b`」「「刀 5b」」两种「名字」写法都合规，裸写不合规。
 *
 * 只扫三份账本文件（`KNIFE_LEDGER_DOCS`）：全仓库扫会把代码里的正则示例也扫进来。
 */
export function stripQuotedSpans(text) {
  return String(text || "").replace(
    /(`[^`\n]*`|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|'[^'\n]*')/g,
    (span) => span.replace(/[^\n]/g, " "),   // 换成等长空格：行号一个都不许漂
  );
}

export function knifeLetterProblems({ docs }) {
  const problems = [];
  if (!docs || docs.length === 0) {
    problems.push("没有扫任何账本文件——空列表的循环体一次都不跑，这条判据等于不存在");
    return problems;
  }
  for (const { fileName, text } of docs) {
    if (typeof text !== "string" || text.length === 0) {
      problems.push(`${fileName}: 读不到内容——这条判据对它没判就绿了`);
      continue;
    }
    const bare = stripQuotedSpans(text).split("\n");
    bare.forEach((line, index) => {
      const hit = /刀\s*\d+(?:\.\d+)?[a-z]/.exec(line);
      if (!hit) return;
      problems.push(`${fileName}:${index + 1} 带字母的刀号「${hit[0].trim()}」写在引号外——`
        + "它是旧名不是刀号，请写成 `刀 5b` 或「刀 5b」，否则下一个人会以为库里真有这个号");
    });
  }
  return problems;
}

/** C 方案只扫这三份账本：刀号登记、切片计划、导出棘轮裁定。 */
const KNIFE_LEDGER_DOCS = [
  "docs/refactor/pages/knife-numbering.md",
  "docs/refactor/pages/knife6-plan.md",
  "docs/refactor/pages/export-ratchet.md",
];

test("文档刀号（C 方案）：带字母的刀号只许在引号/反引号里出现", () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const docs = KNIFE_LEDGER_DOCS.map((fileName) => {
    try {
      return { fileName, text: readFileSync(join(repo, fileName), "utf8") };
    } catch {
      return { fileName, text: "" };
    }
  });
  const problems = knifeLetterProblems({ docs });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("文档刀号自检：裸写红 / 反引号绿 / 中文引号绿 / 行号不漂 / 读不到内容红 / 空列表红", () => {
  const red = knifeLetterProblems({ docs: [{ fileName: "a.md", text: "第一行\n刀 5b（片段抽取） → 刀 6\n" }] });
  assert.ok(red.some((m) => m.includes("a.md:2") && m.includes("刀 5b")),
    `文档刀号自检失败：裸写的带字母刀号被放过——${red.join("；")}`);

  const codeRed = knifeLetterProblems({ docs: [{ fileName: "a.md", text: "```\n刀 5b → 刀 6\n```\n" }] });
  assert.ok(codeRed.some((m) => m.includes("刀 5b")),
    `文档刀号自检失败：代码块里的裸写被放过——${codeRed.join("；")}`);

  assert.deepEqual(
    knifeLetterProblems({ docs: [{ fileName: "a.md", text: "「刀 5b」和 `刀 5b` 都算名字\n" }] }), [],
    "文档刀号自检失败：引号/反引号里的旧名被判红（那是合规写法）",
  );

  // 行号不漂：前一行有跨行引号时，命中的行号必须还是第 3 行
  const drift = knifeLetterProblems({ docs: [{ fileName: "a.md", text: "`多行\n引用`\n刀 5b 裸写\n" }] });
  assert.ok(drift.some((m) => m.includes("a.md:3")),
    `文档刀号自检失败：剥引号后行号漂了——${drift.join("；")}`);

  const blank = knifeLetterProblems({ docs: [{ fileName: "a.md", text: "" }] });
  assert.ok(blank.some((m) => m.includes("读不到内容")),
    `文档刀号自检失败：读不到内容的文件被静默放过——${blank.join("；")}`);

  const none = knifeLetterProblems({ docs: [] });
  assert.ok(none.some((m) => m.includes("没有扫任何账本文件")),
    `文档刀号自检失败：空列表被放过——${none.join("；")}`);
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
 * §18.6「签名走 trailer」自检（DevLead 2026-10-29）：合成提交各喂一条。
 * 判据 1 缺 trailer → 红并点名字；2 等于作者 → 红（自己批自己）；3 是别人 → 绿（两种写法都认）。
 */
test("R12（A1 例外）：新服务模块 + 只改三张登记表 ⇒ 绿；越出登记表块 ⇒ 红", () => {
  // 死锁形态：只落模块 ⇒ 登记完整性红；先加登记 ⇒ 表里 readFileSync 一个不存在的文件直接抛；
  // 合成一笔 ⇒ A1 红。开口子按**范围**：只许动三张表的数组字面量，而且要真的把新模块登记进去。
  const boundarySource = [
    "const DOMAIN_MODULES = [",
    '  { file: "quality-stats.js", exposes: "QualityStats" },',
    '  { file: "brand-new.js", exposes: "BrandNew" },',
    "];",
    "const NON_DOMAIN_MODULES = [",
    '  { file: "page-tile.js", why: "组件不是域" },',
    "];",
    "const ALLOW_QUERY_SELECTOR_WHITELIST = [",
    '  "structure-tools.js",',
    "];",
    "test(\"x\", () => { assert.equal(1, 1); });",
  ].join("\n");
  const ranges = registrationTableRanges(boundarySource);
  assert.equal(ranges.length, 3, `三张登记表只解析到 ${ranges.length} 张——块边界必须从源码派生`);

  const module = { path: "backend/book2text/static/brand-new.js", source: "window.BrandNew = api;\n" };
  // 只在 DOMAIN_MODULES 里加一行（第 2 行之后）
  const inside = [{ path: "tests/js/boundary.test.mjs", addedRanges: [[3, 3]], deletedRanges: [], commitSource: boundarySource }];
  assert.deepEqual(
    newModuleRegistrationProblems({ addedModules: [module], testsChanges: inside }), [],
    "新模块 + 只改登记表被判红——这个口子不成立就会退回三方死锁",
  );

  // 同一笔顺手改一条断言（第最后一行，块外）⇒ 红并点名"越出登记表块"
  const outside = [{ path: "tests/js/boundary.test.mjs", addedRanges: [[12, 12]], deletedRanges: [], commitSource: boundarySource }];
  const bad = newModuleRegistrationProblems({ addedModules: [module], testsChanges: outside });
  assert.ok(bad.some((m) => m.includes("越出登记表块")),
    `顺手改断言被放过——${bad.join("；")}`);

  // 改了别的测试文件（哪怕一行）⇒ 红
  const otherFile = [
    { path: "tests/js/boundary.test.mjs", addedRanges: [[3, 3]], deletedRanges: [], commitSource: boundarySource },
    { path: "tests/js/review-tree.test.mjs", addedRanges: [[1, 1]], deletedRanges: [], commitSource: "x" },
  ];
  assert.ok(newModuleRegistrationProblems({ addedModules: [module], testsChanges: otherFile })
    .some((m) => m.includes("review-tree.test.mjs") && m.includes("越出登记表块")),
  "改了别的测试文件也被放行");

  // 没新增 window.X = api 模块 ⇒ 例外不成立（普通"产品 + tests"同笔仍然红）
  const notModule = { path: "backend/book2text/static/app.js", source: "const x = 1;\n" };
  assert.ok(newModuleRegistrationProblems({ addedModules: [notModule], testsChanges: inside })
    .some((m) => m.includes("例外不成立")), "没有新模块也给这个口子");

  // 新模块没被登记进去（只改了个空行）⇒ 红：口子要的是"落文件 + 登记"，不是"没越界就行"
  const blank = [{ path: "tests/js/boundary.test.mjs", addedRanges: [[12, 12]], deletedRanges: [], commitSource: boundarySource }];
  const missing = newModuleRegistrationProblems({ addedModules: [module], testsChanges: blank });
  assert.ok(missing.some((m) => m.includes("越出登记表块") || m.includes("没有出现在三张登记表里")),
    `新模块没登记也被放行——${missing.join("；")}`);
});

test("R12（A1 例外·视图）：新视图模块 + 只改五张视图表 ⇒ 绿；改 assert 数字 / 动白名单 / 占别人 section ⇒ 红", () => {
  // 实测背景（2026-11-06）：只按"三张服务表"开口子时，新建一个 *-view.js 会报 77 处"越出登记表块"。
  // 边界（Chief 写死）：允许 OWNERS / VIEW_STATE_PREFIXES / VIEW_EXPORTS / SECTION_OWNERS（新段）/ EXPORT_IDS；
  // **任何 assert 行都不在例外内**——"随搬迁同步"与"为了让测试变绿改数字"是同一行 diff，例外不能包容后者。
  const source = [
    "const DOMAIN_MODULES = [",
    '  { file: "quality-stats.js", exposes: "QualityStats" },',
    "];",
    "const NON_DOMAIN_MODULES = [",
    '  { file: "page-tile.js", why: "组件不是域" },',
    "];",
    "const ALLOW_QUERY_SELECTOR_WHITELIST = [",
    '  "structure-tools.js",',
    "];",
    "const OWNERS = {",
    '  fooView: "foo-view.js",',
    "};",
    "const VIEW_STATE_PREFIXES = {",
    '  "foo-": "foo-view.js",',
    "};",
    "const VIEW_EXPORTS = {",
    '  "foo-view.js": {',
    '    names: ["init", "enter"],',
    "    kinds: [",
    '      { kind: "init", callers: ["boot"] },',
    "    ],",
    "  },",
    "};",
    "const SECTION_OWNERS = [",
    "  {",
    '    name: "FOO",',
    '    files: ["foo-view.js"],',
    "  },",
    "];",
    "const EXPORT_IDS = [",
    '  "export-foo",',
    "];",
    'test("x", () => { assert.equal(subtree.length, 34); });',
  ].join("\n");
  const sourceLines = source.split("\n");
  const assertLine = sourceLines.findIndex((line) => line.includes("assert.equal")) + 1;
  assert.ok(assertLine > 0, "夹具里没有 assert 行——自检就证明不了「改 assert 会红」");

  const viewTables = registrationTableRanges(source, ["OWNERS", "VIEW_STATE_PREFIXES", "VIEW_EXPORTS", "SECTION_OWNERS", "EXPORT_IDS"]);
  assert.equal(viewTables.length, 5, `五张视图登记表只解析到 ${viewTables.length} 张——块边界必须从源码派生`);
  const serviceTables = registrationTableRanges(source);
  assert.equal(serviceTables.length, 3, `三张服务表只解析到 ${serviceTables.length} 张`);

  const viewModule = { path: "backend/book2text/static/foo-view.js", source: "(() => {\n  window.FooView = api;\n})();\n" };
  const rangesOf = (blocks) => blocks.map((block) => [block.start, block.end]);
  const inside = [{
    path: "tests/js/boundary.test.mjs",
    addedRanges: rangesOf(viewTables),
    deletedRanges: [],
    commitSource: source,
  }];
  assert.deepEqual(
    newModuleRegistrationProblems({ addedModules: [viewModule], testsChanges: inside }), [],
    "新视图模块 + 只改五张视图表被判红——77 处假红那个口子没开对",
  );

  // 红①：同一笔顺手把 assert 里的数字 34 改成 32（Chief 明确划在外面的形态）
  const assertEdit = [{
    path: "tests/js/boundary.test.mjs",
    addedRanges: [...rangesOf(viewTables), [assertLine, assertLine]],
    deletedRanges: [],
    commitSource: source,
  }];
  const assertProblems = newModuleRegistrationProblems({ addedModules: [viewModule], testsChanges: assertEdit });
  assert.ok(assertProblems.some((one) => one.includes("越出登记表块")),
    `改 assert 里的数字被放行了——那会分不清「搬家同步」与「改数字让测试变绿」：${assertProblems.join("；")}`);

  // 红②：顺手放宽 ALLOW_QUERY_SELECTOR_WHITELIST（视图例外里不含白名单）
  const whitelistLine = serviceTables.find((block) => block.name === "ALLOW_QUERY_SELECTOR_WHITELIST").start + 1;
  const whitelistEdit = [{
    path: "tests/js/boundary.test.mjs",
    addedRanges: [...rangesOf(viewTables), [whitelistLine, whitelistLine]],
    deletedRanges: [],
    commitSource: source,
  }];
  assert.ok(
    newModuleRegistrationProblems({ addedModules: [viewModule], testsChanges: whitelistEdit })
      .some((one) => one.includes("越出登记表块")),
    "视图模块那笔动了白名单也被放行——白名单不在这个例外里",
  );

  // 红③：改 SECTION_OWNERS 但那一行没点名新视图模块（只许加"新 section 那一段"）
  const sectionBlock = viewTables.find((block) => block.name === "SECTION_OWNERS");
  const strangerLine = Array.from({ length: sectionBlock.end - sectionBlock.start + 1 }, (_, index) => sectionBlock.start + index)
    .find((line) => !sourceLines[line - 1].includes("foo-view.js"));
  assert.ok(strangerLine, "SECTION_OWNERS 里没有不带新模块名的行——夹具不成立");
  const strangerEdit = [{
    path: "tests/js/boundary.test.mjs",
    addedRanges: [...rangesOf(viewTables), [strangerLine, strangerLine]],
    deletedRanges: [],
    commitSource: source,
  }];
  assert.ok(
    newModuleRegistrationProblems({ addedModules: [viewModule], testsChanges: strangerEdit })
      .some((one) => one.includes("没点名新视图模块")),
    "改了 SECTION_OWNERS 里别人的段也被放行",
  );

  // 不倒退：**服务模块**那笔仍只放三张服务表，动视图表 ⇒ 红
  const serviceModule = { path: "backend/book2text/static/brand-new.js", source: "window.BrandNew = api;\n" };
  const ownersLine = viewTables.find((block) => block.name === "OWNERS").start + 1;
  const crossKind = [{
    path: "tests/js/boundary.test.mjs",
    addedRanges: [[serviceTables[0].start, serviceTables[0].end], [ownersLine, ownersLine]],
    deletedRanges: [],
    commitSource: source,
  }];
  assert.ok(
    newModuleRegistrationProblems({ addedModules: [serviceModule], testsChanges: crossKind })
      .some((one) => one.includes("越出登记表块")),
    "服务模块那笔改视图表也放行了——口子被扩大成了「什么表都能改」",
  );
});

test("R12（A1 例外·加导出键）：产品加键 + STABLE/MAX 同笔 ⇒ 绿；只登记不加键 / 删旧键 / 多抬 MAX / 改 assert ⇒ 红", () => {
  // 卡死形态（实测 0339dc4）：给 ReadingView 加 selectEntry，同笔改 STABLE 与 MAX_EXPORTS 各一行
  // ⇒ 两处"改一行"被 A1b 记成 2 行未登记删除。拆三笔也走不通（先加 STABLE ⇒ R8 红）。
  const parentSource = [
    'const STABLE = ["init", "enter"];',
    "const TEMPORARY = [];",
    "const PENDING_REMOVAL = [];",
    "const MAX_EXPORTS = 2;",
    'test("x", () => { assert.equal(1, 1); });',
  ].join("\n");
  const commitSource = [
    "// 新增 selectEntry：差异列表点击的落点（签字与死亡条件见提交正文）",
    'const STABLE = ["init", "enter", "selectEntry"];',
    "const TEMPORARY = [];",
    "const PENDING_REMOVAL = [];",
    "const MAX_EXPORTS = 3;",
    'test("x", () => { assert.equal(1, 1); });',
  ].join("\n");
  const productWithKey = {
    path: "backend/book2text/static/reading-view.js",
    source: "(() => {\n  const api = { init, enter, selectEntry };\n  window.ReadingView = api;\n})();\n",
  };
  const productWithoutKey = {
    path: "backend/book2text/static/reading-view.js",
    source: "(() => {\n  const api = { init, enter };\n  window.ReadingView = api;\n})();\n",
  };
  const change = (addedRanges, deletedRanges, source = commitSource) => [{
    path: "tests/js/boundary.test.mjs",
    addedRanges,
    deletedRanges,
    commitSource: source,
    parentSource,
  }];
  const good = change([[1, 2], [5, 5]], [[1, 1], [4, 4]]);

  assert.deepEqual(
    newModuleRegistrationProblems({ addedModules: [], testsChanges: good, productSources: [productWithKey] }), [],
    "产品加键 + 同笔登记被判红——0339dc4 那种笔没法合法落地",
  );

  // 红①：只登记不加键（产品 api 里没有 selectEntry）⇒ 红
  const noKey = newModuleRegistrationProblems({ addedModules: [], testsChanges: good, productSources: [productWithoutKey] });
  assert.ok(noKey.some((one) => one.includes("没有出现在同笔产品代码")),
    `只登记不加键被放行——那正是 R8「登记了但不存在」要抓的形态：${noKey.join("；")}`);

  // 红②：删掉 STABLE 里已有的键（enter 消失）
  const deletedKeySource = [
    "// 顺手删个键",
    'const STABLE = ["init", "selectEntry"];',
    "const TEMPORARY = [];",
    "const PENDING_REMOVAL = [];",
    "const MAX_EXPORTS = 3;",
    'test("x", () => { assert.equal(1, 1); });',
  ].join("\n");
  const deletedKey = newModuleRegistrationProblems({
    addedModules: [], testsChanges: change([[1, 2], [5, 5]], [[1, 1], [4, 4]], deletedKeySource), productSources: [productWithKey],
  });
  assert.ok(deletedKey.some((one) => one.includes("删掉了 STABLE 里已有的键")),
    `删旧键被放行：${deletedKey.join("；")}`);

  // 红③：MAX 多抬一个数字（2 → 4，可本笔只加了 1 个键）
  const maxSource = commitSource.replace("const MAX_EXPORTS = 3;", "const MAX_EXPORTS = 4;");
  const overMax = newModuleRegistrationProblems({
    addedModules: [], testsChanges: change([[1, 2], [5, 5]], [[1, 1], [4, 4]], maxSource), productSources: [productWithKey],
  });
  assert.ok(overMax.some((one) => one.includes("MAX_EXPORTS")),
    `MAX 顺手多抬也被放行：${overMax.join("；")}`);

  // 红④：同笔顺手改一句 assert（第 6 行）
  const assertEdit = change([[1, 2], [5, 5], [6, 6]], [[1, 1], [4, 4]]);
  assert.ok(
    newModuleRegistrationProblems({ addedModules: [], testsChanges: assertEdit, productSources: [productWithKey] })
      .some((one) => one.includes("越出登记表块")),
    "改 assert 行也被放行——例外不许包容「改数字让测试变绿」",
  );

  // 不是"加键"形态（只抬 MAX、STABLE 没新增键）⇒ 仍按普通 A1 红，不许拿这个例外兜底
  const maxOnlySource = parentSource.replace("const MAX_EXPORTS = 2;", "const MAX_EXPORTS = 3;");
  const noNewKey = newModuleRegistrationProblems({
    addedModules: [], testsChanges: change([[4, 4]], [[4, 4]], maxOnlySource), productSources: [productWithKey],
  });
  assert.ok(noNewKey.some((one) => one.includes("例外不成立")),
    `没有新增键却拿这个口子兜底：${noNewKey.join("；")}`);
});

test("R12 自检：Approved-by trailer——缺 → 红 / 等于作者 → 红 / 别人 → 绿（含无空格写法）", () => {
  const docText = [
    "### 18.6 判据变更登记",
    "| 日期 | 判据 | 变更 | 批准人 | 提交 |",
    "|---|---|---|---|---|",
  ].join("\n");
  const base = {
    sha: "abc9999", subject: "test-contract: 合成", files: ["tests/js/boundary.test.mjs"],
    deletions: 2, docText, author: "CLnum42",
  };
  const body = "test-contract: 合成\n\n删：旧断言；补：更严的；变异：改坏一次红在目标行";

  const missing = commitContractProblems({ ...base, message: body });
  assert.ok(
    missing.registryProblems.some((item) => item.includes("没有 Approved-by trailer") && item.includes("abc9999")),
    `R12 自检失败：缺 Approved-by trailer 也放过——${missing.registryProblems.join("；")}`,
  );

  const selfSigned = commitContractProblems({ ...base, message: `${body}\n\nApproved-by: CLnum42` });
  assert.ok(
    selfSigned.registryProblems.some((item) => item.includes("自己签自己")),
    `R12 自检失败：自己批自己（Approved-by == %an）也放过——${selfSigned.registryProblems.join("；")}`,
  );

  const other = commitContractProblems({ ...base, message: `${body}\n\nApproved-by: DevLead` });
  assert.deepEqual(other.registryProblems, [],
    `R12 自检失败：别人签的还报红——${other.registryProblems.join("；")}`);
  assert.equal(other.exempt, true, "R12 自检失败：有签字的提交没被豁免 A1b");

  const noSpace = commitContractProblems({ ...base, message: `${body}\n\nApproved-by:DevLead` });
  assert.deepEqual(noSpace.registryProblems, [],
    `R12 自检失败：无空格写法（Approved-by:DevLead）没认出来——${noSpace.registryProblems.join("；")}`);

  // 判据 2：批准人必须在授权名单里。Builder 给自己签字 → 红（本仓库所有 Bot 共用同一个提交账号，
  // 「≠ %an」拦不住这个真实形态）。
  const builderSigned = commitContractProblems({ ...base, message: `${body}\n\nApproved-by: Builder` });
  assert.ok(
    builderSigned.registryProblems.some((item) => item.includes("不在授权名单") && item.includes("Builder")),
    `R12 自检失败：非授权签署人（Builder）也放过——${builderSigned.registryProblems.join("；")}`,
  );

  // 表格路径（历史笔）同样要查授权名单
  const tableDoc = [
    "### 18.6 判据变更登记",
    "| 日期 | 判据 | 变更 | 批准人 | 提交 |",
    "|---|---|---|---|---|",
    "| 2026-10-29 | X | 删：旧断言；补：更严的；变异：改坏一次红在目标行 | Builder | abc7777 |",
  ].join("\n");
  const tableBuilder = commitContractProblems({
    sha: "abc7777", subject: "move(x): 历史笔", files: ["tests/js/boundary.test.mjs"],
    deletions: 0, docText: tableDoc, author: "CLnum42",
  });
  assert.ok(
    tableBuilder.registryProblems.some((item) => item.includes("不在授权名单")),
    `R12 自检失败：表格里签署人越权也放过——${tableBuilder.registryProblems.join("；")}`,
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

// 第十一笔：selectEntry = 差异列表点击回程的唯一调用点（Architect 2026-11-06 签字 A）。
// 死亡条件（签字原文）：若"右侧正文面板"将来并入 review-focus，此键随面板一起死。
const STABLE = ["init", "enter", "getCurrent", "reload", "toggleFollow", "selectEntry"];   // exit 已于 8b0cfc7 删除（§19 T4 裁决：enter 幂等，exit 没有要救的东西）
const TEMPORARY = [];   // L6 收尾：splitPrefs/applySplit/saveSplit/resetSplit/setupSplit 已从公开对象删除
const PENDING_REMOVAL = [];   // 写路径 emit 已于 26ac481 删除；名单清空，写路径不许再加回来
const MAX_EXPORTS = 6;              // 5 → 6：selectEntry（Architect 签字 A，2026-11-06）

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
  "index-view.js": { names: ["init", "enter", "refresh"] },                // 3（D-100 签字；exit 于 8b0cfc7 删除）
  // 4：生命周期三件 + 一个域操作（D-100 完整形态；Chief 2026-10-29 裁定 B 签字）
  // open = 打开一个项目，外壳的锁冲突确认 / 任务包打开 / 备份还原都调它
  "library-view.js": { names: ["init", "enter", "notify", "open"] },
  // 2：init / enter（§20.10 定稿）；renderMergeView 不导出——外壳设 mergeState 后 showView 进
  "merge-view.js": { names: ["init", "enter"] },
  // 刀 1 落盘时 20 个键（**权威来源 = docs/refactor/evidence/pages/rules.py 的 INTERFACE**，
  // 不是按 app.js 现扫——回滚后的 app.js 里 `PagesView.` 是 0 个，扫出来是空的）。
  // 收敛棘轮：本刀 20 → 终点 3（enter / render / refresh，刀 5 收敛到此），刀 2–5 每刀**严格下降**；
  // 导出面必须**扁平**（api 直接挂函数，不许嵌套对象）——R6 只锁接口名，深度由本表 + 自检锁。
  "pages-view.js": { names: [
    "init",
    "loadFinishSummary", "renderRecognitionSettings", // 刀 4：2 个临时转发键，**死亡刀号 = 刀5**（§8.2：每键带死亡刀号，到点未死就红）。
    "applyPageZoom",         // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    "confirmAllUnconfirmed", // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 刀 5：18 个新转发键；死亡刀号**待 Architect 裁 kind** 后再定（不能一律改刀9：
    // 有些是永留的 capability）。机器的死期表是 EXPORT_DEATH_KNIFE，注释只是副本
    // 本刀死 1 个：renderPageSummary（0 个外壳调用者，模块内已直改呼，deps 键与 api 键一并删）。
    "checkSelection",   // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    "startLayoutDetection",   // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    "openPageSetup",   // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    "toggleMarginView",   // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    "togglePageBlocksOverlay",   // 死亡刀号 = 待裁定（Architect ratchet-two-kinds：transition 才有死期）
    // 刀 6：4 个操作入口（R8 53 → 57；Architect 2026-10-30 重签，曲线 34→36→40→53→**57**→22→3）。
    // `syncToolbarToggles` 是第一个**模块→模块**键：调用者是四个 view 模块，app.js 里恒 0 次——
    // 它的"到点必须死"不能再用「app.js 引用 = 0」判（那一出生就成立），改成全仓引用。
    "syncToolbarToggles",          // 死亡刀号 = 刀10（全仓 window.PagesView.syncToolbarToggles 引用 = 0 且不在 api 表）
    "showPagesError",              // 死亡刀号 = 刀9（app.js 引用 = 0 且不在 api 表）
    "pagesErrorMessage",           // 死亡刀号 = 刀9（同上）
    // 刀 7：recognizePage 搬进 pages 模块（R8 57 → 58）。到点判据：
    // app.js 里 window.PagesView.recognizePage 引用 = 0 且不在 api 表——
    // 今天两个调用者（buildTile / setupLibrary）都在外壳；刀 9 若还剩一个，这个键死不了。
    "recognizePage",               // 死亡刀号 = 刀9
    // 刀 8：三个 C 键（外壳的三个跨域编排留在 app.js，只把 pages 写点收成能力；R8 58 → 61）
    "setPackageModeChrome",        // C
    "syncProjectSettings",         // C
    "setSelectionHint",            // C
    // 刀 9.1：视图切换通知（L 类）。R8 净额 −4 +1
    "enter",
    // 刀 9.2：任务轮询的三个写点收成两个能力（C 类）。R8 53 − 3 + 2 = 52
    // 外壳只知道"任务在跑 / 刚结束"，job_type 分派与重画范围都归模块 ⇒ 永远有外壳调用者，不写死期。
    "onTaskProgress", "onRecognitionFinished",
    // 刀 9.3：版心一族的 12 个 T 死掉，换成 3 个事件能力（C 类）。R8 52 − 12 + 3 = 43
    "onTaskFinished", "onLayoutDetectStarted", "onWorkflowLoaded",
    // 刀 9.4：页码一族 3 个 T 死，换 2 个能力（C 类）。R8 43 − 3 + 2 = 42
    "onPageNumberChanged", "onPageNumberAnalysisReady",
    // 刀 9.5：选择/网格/步骤/收尾 11 键死，换 8 个事件能力（C 类）；checkSelection 转 C 不写死期。R8 42 − 11 + 8 = 39
    "onPageListChanged", "onProjectPagesReloaded", "onAuxReviewFinished", "onPageStatesRefreshed",
    "onAutoApplyStatusChanged", "onWorkflowStepChanged", "onPageBlocksInvalidated", "onPageSuggestionsInvalidated",
    // 刀 10a：块框队列/可见性调度搬进模块，3 个 T 死，换 1 个能力（C 类）。R8 39 − 3 + 1 = 36
    "onPagesNeedReflow",
    // 刀 10.2（最后一刀）：建议扫描队列搬进模块，最后一个 T 死，换 1 个能力（C 类）。R8 36 − 1 + 1 = 36；**T 归零**
    "onPagesShown",],
    // ---- 三类键（Architect ratchet-two-kinds，docs/refactor/pages/export-ratchet.md）----
    // L lifecycle 固定 3 个名字；T transitional 必须带死期（现留空，等 9a/9b 裁定）；
    // C capability 不写死期，登记 effective callers + 理由（清册就是上限，不是数字）。
    kinds: {
      init: { kind: "L" },
      enter: { kind: "L" },   // 刀 9.1 新增（视图切换通知，生命周期键）
      // 刀 9.6：undoMarginEdit 死（T 5 → 4）——版心撤销按钮的工厂搬进模块，click 直呼模块自己的 undoMarginEdit。
      // R8 39 − 1 + 0 = 38：它唯一的调用点是工厂里的 addEventListener（值位），按钮 DOM 归 #view-pages，接线归模块。
      loadFinishSummary: { kind: "C", callers: ["afterCleanupApplied", "afterContinuationChange", "boot", "confirmCurrentPage", "finishConfirmPages", "finishRevokeAutoPass", "finishRunAutoPass", "finishRunLayout", "openFinishPanel", "pollTask", "refreshProject", "setupReviewControls", "page-detail-editor.js", "library-view.js", "reading-view.js"], reason: "收尾状态被三个视图共用（13 个外壳函数 + library/reading 各调）" },
      renderRecognitionSettings: { kind: "C", callers: ["applyProjectSettings", "boot", "loadAppInfo", "library-view.js"], reason: "项目设置落在 pages 面板上" },
      applyPageZoom: { kind: "C", callers: ["fillDefinitionList", "goToWorkflowStep", "setPageZoom", "showView"], reason: "缩放三步共用（原按 T 记，Architect 转 C）" },
      confirmAllUnconfirmed: { kind: "C", callers: ["finishConfirmPages"], reason: "收尾面板发起（原按 T 记，Architect 转 C）" },
      checkSelection: { kind: "C", callers: ["setupReviewControls"], reason: "按钮 #finish-check-engine 在 index.html:1721（chrome，view section 之外）⇒ 模块引用越 R3，收成能力" },
      onRecognitionFinished: { kind: "C", callers: ["pollTask"], reason: "外壳只知「这几页刚认完」，重画什么由模块决定（收成能力后外壳仍是调用者）" },
      onPageListChanged: { kind: "C", callers: ["renderProject", "finishShowFallbackPages"], reason: "页面列表改了：整格重画" },
      // 刀 D：applyHeaderFooter 搬进 structure-tools.js，壳侧的调用者变成 boot 里那条 afterApply 闭包
      onProjectPagesReloaded: { kind: "C", callers: ["boot", "controlJob"], reason: "页面数据大面积变了：重拉列表再重画" },
      onAuxReviewFinished: { kind: "C", callers: ["page-detail-editor.js"], reason: "复核收尾：识别步状态要跟着变（S4 之后调用者是编辑面板模块）" },
      onPageStatesRefreshed: { kind: "C", callers: ["pollTask", "refreshPageStates"], reason: "页面状态刷新了：就地同步瓷砖状态" },
      onAutoApplyStatusChanged: { kind: "C", callers: ["suggestion-flow.js: refreshAutoApplyStatus"], reason: "自动应用状态变了：右栏角标重画（自动应用已随刀 C 搬进 suggestion-flow.js，loadAutoApplyStatus 现在只是外壳转发器）" },
      onWorkflowStepChanged: { kind: "C", callers: ["syncWorkflowSteps"], reason: "步骤条重算了：按新步骤重排右栏分区" },
      onPageBlocksInvalidated: { kind: "C", callers: ["suggestion-flow.js: refreshAfterTypeChanges"], reason: "块框缓存失效（只在没有指定页时全清；调用者在 suggestion-flow.js 里）" },
      onPageSuggestionsInvalidated: { kind: "C", callers: ["pollTask", "afterCleanupApplied", "applySplitBatch", "suggestion-flow.js: refreshAfterTypeChanges"], reason: "建议缓存失效（识别收尾 / 清理 / 类型变更 / 拆批）" },
      onPagesNeedReflow: { kind: "C", callers: ["showView", "applySplitBatch", "boot", "suggestion-flow.js: refreshAfterTypeChanges"], reason: "布局可能要重排：切回页面视图 / 块类型变了 / 拆分批量 / 打开项目——调度状态在模块里（boot 那条经 schedulePageVisibility 注入转发）" },
      onPagesShown: { kind: "C", callers: ["showView"], reason: "页面视图变成可见（回页面视图恢复建议预取）——不是\"队列排完\"，队列排完是模块内部行为" },
      onPageNumberAnalysisReady: { kind: "C", callers: ["loadPageNumberMetrics", "refreshPageNumberAnalysis"], reason: "页码分析到手后重画右栏指标（只读 pageNumberAnalysis）" },
      onPageNumberChanged: { kind: "C", callers: ["adoptPageNumberTemplate", "removePageNumberRange", "savePageNumberManual", "hydrateView"], reason: "页码写库成功后重读摘要并回一行状态（text 省略=只重读不报状态）" },
      onLayoutDetectStarted: { kind: "C", callers: ["startLayoutDetectFromDialog"], reason: "开始检测：判定文字 / 进度条归零 / 状态行三处写点收成一次（按钮在 #confirm-dialog，模块挂不了监听）" },
      onTaskFinished: { kind: "C", callers: ["pollTask"], reason: "任务收尾：版心重画 + 检测结论（外壳只知这个 job 结束了）" },
      onWorkflowLoaded: { kind: "C", callers: ["loadWorkflow"], reason: "工作流角标读完：版心缺口提示与检测入口文案跟着变" },
      onTaskProgress: { kind: "C", callers: ["pollTask"], reason: "外壳只知「任务在跑」，job_type 分派交给模块里的两个进度函数各自守卫" },
      openPageSetup: { kind: "C", callers: ["boot", "library-view.js"], reason: "首启 / 库页打开页面设置" },
      // 刀 9 已删 rerunAuxiliary（那 5 个键之一），别再回来 —— 冲突时取「新值 + 不复活已删键」
      // 10b：队列子系统剩下的一半——建议扫描队列搬进模块之后它就死（Architect 39eb012 改判；不是 C）
      startLayoutDetection: { kind: "C", callers: ["startLayoutDetectFromDialog"], reason: "版心检测对话框发起（原按 T 记，Architect 转 C）" },
      toggleMarginView: { kind: "C", callers: ["boot", "index-view.js"], reason: "三步共用的工具栏开关" },
      togglePageBlocksOverlay: { kind: "C", callers: ["boot", "index-view.js"], reason: "同上" },
      syncToolbarToggles: { kind: "C", callers: ["index-view.js", "library-view.js", "pages-view.js", "reading-view.js"], reason: "3 个视图模块 + boot 的 deps 行都要它 → 模块→模块，第一个此类键" },
      showPagesError: { kind: "C", callers: ["finishRevokeAutoPass"], reason: "收尾面板的任务失败要显示在页面错误条" },
      pagesErrorMessage: { kind: "C", callers: ["startLayoutDetectFromDialog"], reason: "版心检测对话框读错误文案" },
      recognizePage: { kind: "C", callers: ["buildTile", "setupLibrary"], reason: "单页识别可从页面网格和审校面板发起（刀 7 新增，跨域编排）" },
      setPackageModeChrome: { kind: "C", callers: ["applyPackageMode"], reason: "包模式开关时 pages 面板 10 个入口的显隐（刀 8；外壳决定，模块写）" },
      syncProjectSettings: { kind: "C", callers: ["applyProjectSettings"], reason: "项目设置落在 pages 面板上的两个勾选态（刀 8）" },
      setSelectionHint: { kind: "C", callers: ["applySplitBatch"], reason: "拆分批量应用后的选中提示（刀 8）" },
    },
  },
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

/**
 * **每个导出键的死亡刀号 —— 机器可读的唯一定义**（2026-10-30 Chief 裁定补机检）。
 *
 * 为什么要有它：`VIEW_EXPORTS` 里那句「// 死亡刀号 = 刀N」是**注释**，重编号之后没人更，
 * 于是 24 个键里 20 个仍活着、死期还写着刀5/刀6——**「到点未死」没有任何机检**，死亡刀号只是记账。
 * 现在：判据只认这张表，注释只是副本。
 *
 * 2026-10-30 重算：20 个仍活的键死期统一改 **刀 9（导出收口那一刀）**——依据是曲线 R8 61 → 22
 * 就是砍它们，不是拍脑袋；本来就写 刀9/刀10 的不动（showPagesError / pagesErrorMessage = 刀9，
 * syncToolbarToggles = 刀10；setMarginJudgementCheckbox 已在清理笔里删除，不在这套账里）。
 */
const EXPORT_DEATH_KNIFE = {
  // **从 kind 清册派生，不另存一份**（2026-10-30）：死期只写在一个地方——
  // `VIEW_EXPORTS["pages-view.js"].kinds[key].death`（T 才有）。抄第二份就是又开一个漂点。
  //
  // 44 个 T 的死期按 Architect `export-ratchet.md` §十：刀 9（8 个死 T）· 9.1（showView/hydrateView 4 个）
  // · 9.2（pollTask/fetchPageBlocks/schedulePageVisibility 5 个）· 9.3（版心一族 12 个）
  // · 9.4（页码一族 3 个）· 9.5（选择/网格/步骤/收尾 12 个）。语义与 R3 一致：**多宿主取 max**。
  "pages-view.js": Object.fromEntries(
    Object.entries(VIEW_EXPORTS["pages-view.js"].kinds)
      .filter(([, entry]) => entry.kind === "T" && entry.death !== null)
      .map(([key, entry]) => [key, entry.death]),
  ),
};
// **死期表「空」不再是一个到期点，而是一个终态**（2026-11-01 翻面，刀 10.2）：
// 以前是「到刀 9 表还空 ⇒ 红」（清册没落地），刀 10.2 之后 T 全部死光，空表**合法**。
// 于是判据不再看刀号（`EXPORT_DEATH_EXPIRES` 已删），改看清册自己：
//   T == 0            → 绿（终态：没有过渡键，就没有死期可填）
//   T > 0 且表空      → 红（不管当前哪一刀 —— 空表意味着「到点未死」在空转）
// 为什么不能留一个「到期刀」常数：翻面后它不再影响任何一条分支，却还挂在 `GATE_SWITCHES` 里
// 写着「死期表为空时是否已经到期」——那是**看着在管、实际不管**的手工常数，正是这半年在收的东西。

/**
 * 一个导出键**还活着吗** —— 三栏扫（Architect 2026-10-30 裁定；旧实现只扫第 ② 栏所以是瞎的）：
 *   ① 裸标识符（含**值位**）：`addEventListener("click", foo)` / `queueAfterSteps(foo)` —— 旧实现看不见；
 *   ② `PagesView.<key>`：外壳经接口调用；
 *   ③ 模块里的 `injected.<key>`：别的模块反过来调它（排除 pages-view 自己的自环——那不算"跨域还活着"，
 *      但这里只用来判"还活着"，自环也算活着，宁可多报也不漏报）。
 *
 * **先剥注释**：`updateSelectionPanel` 在 app.js:11794 的**注释**里出现过，Architect 第一版没剥，
 * 把注释算成引用、误报「4 个值位」（实际 3 个）。判据必须只认代码。
 */
export function exportKeyReferences({ key, appSource, modules = [] }) {
  const app = codeOnly(String(appSource || ""));
  const bareRe = new RegExp(`(?<![.\\w$])${key}\\b`, "g");          // 值位：前面不是 . / 标识符字符
  const apiRe = new RegExp(`(?:window\\.)?PagesView\\s*\\.\\s*${key}\\b`, "g");
  const bare = [...app.matchAll(bareRe)].length;
  const viaApi = [...app.matchAll(apiRe)].length;
  let viaModule = 0;
  for (const { source } of modules || []) {
    const code = codeOnly(String(source || ""));
    viaModule += [...code.matchAll(new RegExp(`injected\\s*\\.\\s*${key}\\b`, "g"))].length;
  }
  return { bare, viaApi, viaModule, total: bare + viaApi + viaModule };
}

/**
 * 「到点未死」判定内核（纯函数，自检喂合成样例）。
 *
 * 对每个声明了死亡刀号的键：若 `死亡刀号 <= 当前刀`，则
 *   · 它在 app.js 的引用必须 == 0；
 *   · 它不许还在 api 表里。
 * 两条有一条不满足就红，红文点名键 + 死亡刀号 + 当前刀 + 实际引用数。
 *
 * **不能被静默停用**：判据只从表取死期，不从注释——注释漂了不会让判据空转。
 *
 * `tCount` / `tPending` 由调用方**从 kinds 现数**传进来（不在函数里读文件，才能被自检喂假数）。
 * 空表是唯一「没有主体可遍历」的状态：那种状态下判不出东西，所以必须靠清册自报的 T 条数
 * 分辨「T 全死光了（终态）」和「表空了但还有 T（判据在空转）」——分不清就红，不许默认绿。
 */
export function exportDeathProblems({ deaths, stage, appSource, apiKeys, modules = [], tCount = null, tPending = null }) {
  const problems = [];
  const deathEntries = Object.entries(deaths || {});
  if (deathEntries.length === 0) {
    // 空表：**不再看刀号**（T==0 是终态，与当前哪一刀无关）。看的是清册自己说不说得通。
    if (tCount === null || tCount === undefined) {
      problems.push(
        "死期表为空，但调用方没传 tCount——这条判据分不清「T 已全部死光（终态）」与"
        + "「表空了但清册里还有 T（判据在空转）」，两种都不吭声就是默认让它空转",
      );
      return problems;
    }
    if (Number(tCount) === 0) return problems;   // 终态：没有过渡键，就没有死期可填
    if (Number(tPending) === 0) {
      problems.push(
        `死期表为空，但 kinds 里有 ${tCount} 个 T 且没有一个待定（pending 0）——自相矛盾：`
        + "EXPORT_DEATH_KNIFE 是从 kinds 现算的，有死期的 T 不可能是 0 条；空表只能说明派生被改坏了",
      );
    } else {
      problems.push(
        `死期表为空，但 kinds 里还有 ${tCount} 个 T（其中 ${tPending} 个待定）——`
        + "「到点未死」此刻在空转：表里没有主体，这条判据一条也判不到",
      );
    }
    return problems;
  }
  // **表的条数必须与清册对得上**（遍历主体不能只选表）：派生少了一条，那个键就静默不受判。
  if (tCount !== null && tPending !== null && Number(tCount) - Number(tPending) !== deathEntries.length) {
    problems.push(
      `死期表里有 ${deathEntries.length} 个键，但 kinds 里有 ${tCount} 个 T、其中 ${tPending} 个待定`
      + `（应为 ${Number(tCount) - Number(tPending)} 个）——派生漏了或多算，漏掉的那个键在这里不受判`,
    );
  }
  for (const [key, death] of deathEntries) {
    // **死期非法也要红，不许 continue 掉**：`Number("9b")` = NaN，而 `NaN <= stage` 恒 false，
    // 一行 continue 就让这个键永不判到点、且不报错（Architect 揪出的静默洞）。
    if (!Number.isFinite(Number(death)) || Number(death) <= 0) {
      problems.push(`导出键 ${key} 的死期 ${JSON.stringify(death)} 不是正数刀号——`
        + "Number() 得 NaN，`NaN <= stage` 恒 false，这个键永不判到点");
      continue;
    }
    if (!(Number(death) <= Number(stage))) continue;
    const refs = exportKeyReferences({ key, appSource, modules });
    const inApi = (apiKeys || []).includes(key);
    if (refs.total === 0 && !inApi) continue;
    const why = [];
    if (refs.total > 0) {
      const parts = [];
      if (refs.bare > 0) parts.push(`裸标识符 ${refs.bare} 处（值位也算）`);
      if (refs.viaApi > 0) parts.push(`PagesView.${key} ${refs.viaApi} 处`);
      if (refs.viaModule > 0) parts.push(`模块 injected.${key} ${refs.viaModule} 处`);
      why.push(`还活着：${parts.join(" / ")}`);
    }
    if (inApi) why.push("它仍在 api 表里");
    problems.push(`导出键 ${key} 的死亡刀号是 刀${death}，当前刀已到 刀${stage}——但 ${why.join("、")}：到点未死`);
  }
  return problems;
}

/** 死期待定的 T 个数的上限（只降不升；填一个降一个）。 */
const T_DEATH_PENDING_MAX = 0;   // 死期已按 Architect §十 全部填满（9 / 9.1–9.5），只许保持 0

/**
 * **每个导出键的 kind 必填，且 T / C 字段互斥**（Architect `export-ratchet.md` §八 ①）。
 *
 * T transitional：只许 `{ kind: "T", death }`（`death: null` = 待定，但要显式写出来）；带 callers = 混填。
 * C capability：只许 `{ kind: "C", callers, reason }`；**带 death = 混填**——C 永不死，
 *   写死期就等于给一个还得用的功能定了死日（历史上「20 个活键都在刀 9 死」就是这么错的）。
 * L lifecycle：不许带 death / callers。
 */
export function exportKindProblems({ names, kinds }) {
  const problems = [];
  const table = kinds || {};
  const has = (entry, field) => Object.prototype.hasOwnProperty.call(entry, field);
  for (const key of names) {
    const entry = table[key];
    if (!entry || !entry.kind) {
      problems.push(`导出键 ${key} 没有登记 kind（L/T/C）——三类不清就判不了死期`);
      continue;
    }
    if (entry.kind === "T") {
      if (has(entry, "callers")) problems.push(`导出键 ${key} 是 T（过渡键），却登记了 callers——T/C 字段混填`);
      if (!has(entry, "death")) {
        problems.push(`导出键 ${key} 是 T，却没写 death（哪怕是 null 代表待定，也要显式写出来）`);
      } else if (entry.death !== null) {
        // **死期本身也要校验**（Architect 揪出的静默洞）：死期是手写数据，改一个字符（9.3 → 9.3b）
        // 就让 `Number(death)` 变 NaN，而 `NaN <= stage` 恒 false ⇒ 这个键**永远不被判到点、还不报错**。
        // 这和 `PAGES_STAGE=2` 是同一类病：从「手工常数控制判据生效」变成「手写数据控制判据生效」。
        const death = entry.death;
        if (!Number.isFinite(Number(death)) || Number(death) <= 0) {
          problems.push(`导出键 ${key} 的死期 ${JSON.stringify(death)} 不是正数刀号——Number() 得 NaN，`
            + "`NaN <= stage` 恒 false，这个键永不判到点（而且不报错）");
        } else if (!isRegisteredKnife(Number(death))) {
          problems.push(`导出键 ${key} 的死期 刀${death} 不在 knife-registry 里——刀号唯一真值源是登记表，`
            + "写一个不存在的号（如 8.7）不会静默，但会让它「晚一刀到期」");
        }
      }
    } else if (entry.kind === "C") {
      if (has(entry, "death")) {
        problems.push(`导出键 ${key} 是 C（能力面），却写了 death——C 不写死期，写了就等于给还得用的功能定死日`);
      }
      if (!Array.isArray(entry.callers) || entry.callers.length === 0) {
        problems.push(`导出键 ${key} 是 C，必须登记非空 callers（清册就是上限，不是数字）`);
      }
      if (!entry.reason) problems.push(`导出键 ${key} 是 C，必须写 reason（为什么它是跨域能力）`);
    } else if (entry.kind === "L") {
      if (has(entry, "death") || has(entry, "callers")) {
        problems.push(`导出键 ${key} 是 L（生命周期），不许带 death/callers`);
      }
    } else {
      problems.push(`导出键 ${key} 的 kind=${entry.kind} 不认识（只许 L / T / C）`);
    }
  }
  for (const key of Object.keys(table)) {
    if (!names.includes(key)) problems.push(`kinds 里登记了 ${key}，但它不是这个模块的导出键——删掉`);
  }
  return problems;
}

/**
 * **终态五条之一：`L ⊇ {init, enter}`**（Architect 在刀 11 文档里留的最后一处缺口）。
 *
 * 为什么要有闸：这条以前是**数据事实，靠人看**——文档写着「必须机检」，而判据里没有一条
 * 只靠人眼的规则。它的过期形态很安静：某个视图模块的 `enter` 被改成 C（或从 names 里删掉），
 * 生命周期就断了，但 R8 只数条数、R6 只数接口名，两边都看不出来。
 *
 * 两条一起判：
 *   ① **names 里必须有 init 与 enter** —— L 键必须真的露在导出面上（没露出来就谈不上生命周期）；
 *   ② **登记了 kinds 的模块，这两个的 kind 必须是 L** —— C 永不死、T 有死期，都不是「生命周期」。
 * ②只对登记了 kinds 的模块生效（今天只有 pages-view.js），所以另加一条：一个都没登记就是空转红。
 */
export function lifeCycleProblems({ modules }) {
  const problems = [];
  if (!modules || modules.length === 0) {
    problems.push("一个视图模块都没扫到——这条判据在空转");
    return problems;
  }
  for (const { fileName, names = [], kinds = null } of modules) {
    for (const key of ["init", "enter"]) {
      if (!names.includes(key)) {
        problems.push(`${fileName} 的导出面里没有 ${key}——生命周期键必须露出来，否则它连"被调用"都做不到`);
        continue;
      }
      if (!kinds) continue;
      const entry = kinds[key];
      if (!entry) {
        problems.push(`${fileName} 登记了 kinds，但 ${key} 没登记 kind——不登记 = 不判`);
      } else if (entry.kind !== "L") {
        problems.push(`${fileName} 的 ${key} 是 ${entry.kind}，生命周期键必须是 L（C 永不死、T 有死期，都不该占着 init/enter）`);
      }
    }
  }
  if (!modules.some((module) => module && module.kinds)) {
    problems.push("没有任何视图模块登记 kinds——「init/enter 必须是 L」这一支一条都没判（名字那支判了，kind 那支空转）");
  }
  return problems;
}

test("R8（终态 L 键）：每个视图模块露 init/enter；登记了 kinds 的模块里这两个必须是 L", () => {
  const modules = Object.entries(VIEW_EXPORTS)
    .map(([fileName, entry]) => ({ fileName, names: entry.names || [], kinds: entry.kinds || null }));
  const problems = lifeCycleProblems({ modules });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("R8（终态 L 键）自检：缺 enter 红 / enter 被改成 C 红 / 登记 kinds 却没登记 kind 红 / 空模块红 / 无人登记 kinds 红", () => {
  const L = { init: { kind: "L" }, enter: { kind: "L" } };
  const ok = [{ fileName: "a-view.js", names: ["init", "enter"], kinds: L }];
  assert.deepEqual(lifeCycleProblems({ modules: ok }), [], "L 键自检失败：合规模块被误报");

  const missing = lifeCycleProblems({ modules: [{ fileName: "a-view.js", names: ["init"], kinds: { init: { kind: "L" } } }] });
  assert.ok(missing.some((m) => m.includes("没有 enter")),
    `L 键自检失败：enter 从 names 删掉被放过——${missing.join("；")}`);

  const asC = lifeCycleProblems({
    modules: [{ fileName: "a-view.js", names: ["init", "enter"], kinds: { init: { kind: "L" }, enter: { kind: "C", callers: ["x"], reason: "y" } } }],
  });
  assert.ok(asC.some((m) => m.includes("enter 是 C") && m.includes("必须是 L")),
    `L 键自检失败：enter 被改成 C 被放过——${asC.join("；")}`);

  const noKind = lifeCycleProblems({ modules: [{ fileName: "a-view.js", names: ["init", "enter"], kinds: { enter: { kind: "L" } } }] });
  assert.ok(noKind.some((m) => m.includes("init 没登记 kind")),
    `L 键自检失败：登记了 kinds 却漏登记 init 被放过——${noKind.join("；")}`);

  assert.ok(lifeCycleProblems({ modules: [] }).some((m) => m.includes("一个视图模块都没扫到")),
    "L 键自检失败：空模块列表被放过");

  const noTable = lifeCycleProblems({ modules: [{ fileName: "a-view.js", names: ["init", "enter"] }] });
  assert.ok(noTable.some((m) => m.includes("kind 那支空转")),
    `L 键自检失败：没有任何模块登记 kinds 时 kind 那支空转被放过——${noTable.join("；")}`);
});

test("R8（三类键）：每个导出键 kind 必填，T / C 字段互斥", () => {
  const entry = VIEW_EXPORTS["pages-view.js"];
  const problems = exportKindProblems({ names: entry.names, kinds: entry.kinds });
  assert.deepEqual(problems, [], problems.join("\n"));
  const pending = Object.values(entry.kinds).filter((item) => item.kind === "T" && item.death === null).length;
  assert.ok(pending <= T_DEATH_PENDING_MAX,
    `死期待定的 T 有 ${pending} 个，上限 ${T_DEATH_PENDING_MAX}——只许往下（填一个降一个）`);
  if (pending > 0) {
    console.log(`ℹ 死期待定的 T：${pending} 个（等 Architect 的 9a/9b 裁定；只许降）`);
  }
});

test("R8（三类键）自检：缺 kind 红 / T 带 callers 红 / C 带 death 红 / 未知 kind 红 / 多余键红", () => {
  const names = ["a", "b", "c"];
  const ok = {
    a: { kind: "L" },
    b: { kind: "T", death: null },
    c: { kind: "C", callers: ["x"], reason: "跨域" },
  };
  assert.deepEqual(exportKindProblems({ names, kinds: ok }), [],
    `三类键自检失败：合规清册被误报——${exportKindProblems({ names, kinds: ok }).join("；")}`);

  const noKind = exportKindProblems({ names, kinds: { ...ok, b: {} } });
  assert.ok(noKind.some((m) => m.includes("没有登记 kind")),
    `三类键自检失败：缺 kind 被放过——${noKind.join("；")}`);

  const tWithCallers = exportKindProblems({ names, kinds: { ...ok, b: { kind: "T", death: null, callers: ["x"] } } });
  assert.ok(tWithCallers.some((m) => m.includes("T/C 字段混填")),
    `三类键自检失败：T 带 callers（混填）被放过——${tWithCallers.join("；")}`);

  const cWithDeath = exportKindProblems({ names, kinds: { ...ok, c: { kind: "C", death: 9, callers: ["x"], reason: "r" } } });
  assert.ok(cWithDeath.some((m) => m.includes("C") && m.includes("却写了 death")),
    `三类键自检失败：C 带 death（混填）被放过——${cWithDeath.join("；")}`);

  const badKind = exportKindProblems({ names, kinds: { ...ok, a: { kind: "X" } } });
  assert.ok(badKind.some((m) => m.includes("不认识")),
    `三类键自检失败：未知 kind 被放过——${badKind.join("；")}`);

  // 死期本身的两条：不是正数刀号（NaN）/ 不在登记表里
  const nanDeath = exportKindProblems({ names, kinds: { ...ok, b: { kind: "T", death: "9b" } } });
  assert.ok(nanDeath.some((m) => m.includes("不是正数刀号") && m.includes("永不判到点")),
    `三类键自检失败：死期写成 "9b"（NaN）被放过——${nanDeath.join("；")}`);
  const unregisteredDeath = exportKindProblems({ names, kinds: { ...ok, b: { kind: "T", death: 8.7 } } });
  assert.ok(unregisteredDeath.some((m) => m.includes("不在 knife-registry 里")),
    `三类键自检失败：死期 8.7（未登记）被放过——${unregisteredDeath.join("；")}`);

  const extra = exportKindProblems({ names, kinds: { ...ok, d: { kind: "T", death: null } } });
  assert.ok(extra.some((m) => m.includes("不是这个模块的导出键")),
    `三类键自检失败：kinds 里多出非导出键被放过——${extra.join("；")}`);
});

test("R8（到点未死）：死亡刀号 <= 当前刀的导出键，必须 app.js 引用 0 且不在 api 表", () => {
  const deaths = EXPORT_DEATH_KNIFE["pages-view.js"] || {};   // T 全死后为空（终态，见 exportDeathProblems 注释）
  // 表自检：死期表里的每个键都必须真的在 VIEW_EXPORTS 的导出名里——拼错就等于这条判据不判它
  const declared = new Set(VIEW_EXPORTS["pages-view.js"].names);
  const unknown = Object.keys(deaths).filter((key) => !declared.has(key));
  assert.deepEqual(unknown, [],
    `EXPORT_DEATH_KNIFE 里的 ${unknown.join("、")} 不在 VIEW_EXPORTS 的导出名里——拼错就等于静默不判`);
  const { keys: apiKeys } = moduleExportKeys("pages-view.js");
  // T 的条数**现数**（空表时要靠它分辨「终态」与「在空转」，见内核注释）
  const kinds = VIEW_EXPORTS["pages-view.js"].kinds || {};
  const tEntries = Object.values(kinds).filter((item) => item && item.kind === "T");
  const tCount = tEntries.length;
  const tPending = tEntries.filter((item) => item.death === null).length;
  const modules = readdirSync(STATIC_DIR).filter((name) => /-view\.js$/.test(name))
    .map((fileName) => ({ fileName, source: readFileSync(join(STATIC_DIR, fileName), "utf8") }));
  const problems = exportDeathProblems({
    deaths, stage: STAGE_NOW, appSource: readFileSync(APP_FILE, "utf8"), apiKeys, modules, tCount, tPending,
  });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("R8（死期终态）：有 death 字段的键只能是 T；T 全部死光后，kinds 里不许再留任何 death", () => {
  const kinds = VIEW_EXPORTS["pages-view.js"].kinds || {};
  const withDeath = Object.entries(kinds)
    .filter(([, entry]) => entry && Object.prototype.hasOwnProperty.call(entry, "death"))
    .map(([key]) => key);
  const notT = withDeath.filter((key) => kinds[key].kind !== "T");
  assert.deepEqual(notT, [],
    `${notT.join("、")} 带了 death 字段但不是 T——死期只属于过渡键（C 永不死、L 是生命周期）`);
  const tCount = Object.values(kinds).filter((item) => item && item.kind === "T").length;
  if (tCount === 0) {
    // **终态断言**：T 全部死光之后，清册里一个 death 字段都不该留下——
    // 留下就等于「表格还在描述一件已经结束的事」，下一个人会以为还有过渡键没搬。
    assert.deepEqual(withDeath, [],
      `T 已经没有（终态），但 ${withDeath.join("、")} 上还留着 death 字段——清册该收干净`);
    return;
  }
  console.log(`ℹ 还有 ${tCount} 个 T 未死（刀 10.2 落盘前正常）：${Object.keys(kinds).filter((k) => kinds[k].kind === "T").join("、")}`);
});

test("R8（到点未死）三栏自检：只留转发器红 / 值位引用红 / 只有注释必须绿", () => {
  const deaths = { foo: 9 };
  const apiGone = [];   // api 键已删
  const base = { deaths, stage: 9, apiKeys: apiGone, modules: [], tCount: 1, tPending: 0 };

  // ① 只删了 api 键、转发器还在：`function foo() { return window.PagesView.foo.apply(...) }`
  const forwarderOnly = exportDeathProblems({
    ...base, appSource: "function foo() {\n  return window.PagesView.foo.apply(null, arguments);\n}\n",
  });
  assert.ok(forwarderOnly.some((m) => m.includes("foo") && m.includes("还活着") && m.includes("PagesView.foo")),
    `三栏自检失败：只留转发器没红（旧实现只数 PagesView.<key>，这里应当照样抓到）——${forwarderOnly.join("；")}`);

  // ② 值位引用：`addEventListener("click", foo)` —— 名字不在调用位，旧实现看不见
  const valuePosition = exportDeathProblems({
    ...base, appSource: 'el("btn").addEventListener("click", foo);\n',
  });
  assert.ok(valuePosition.some((m) => m.includes("裸标识符") && m.includes("值位也算")),
    `三栏自检失败：值位引用没红——${valuePosition.join("；")}`);

  // ③ 只有注释提到 → 必须绿（防"多报"；Architect 第一版就栽在这）
  const commentOnly = exportDeathProblems({
    ...base, appSource: "// 旧实现里这里调过 foo，后来改成直呼\nconst zz = 1;\n",
  });
  assert.deepEqual(commentOnly, [],
    `三栏自检失败：注释里的名字被算成引用（这条判据必须剥注释）——${commentOnly.join("；")}`);
});

test("R8（死期表翻面）：T==0 空表绿（终态）/ T>0 空表红（待定与自相矛盾分开说）/ 表非空照常判到点未死", () => {
  const base = { appSource: "", apiKeys: [] };

  // ① 终态：清册里已经没有 T，死期表必然空 → 绿。**与当前哪一刀无关**（旧的「到期刀」判据已删）
  assert.deepEqual(
    exportDeathProblems({ ...base, deaths: {}, stage: 9, tCount: 0, tPending: 0 }), [],
    "死期表翻面失败：T==0 的终态空表被判红",
  );
  assert.deepEqual(
    exportDeathProblems({ ...base, deaths: {}, stage: 10.2, tCount: 0, tPending: 0 }), [],
    "死期表翻面失败：终态应与刀号无关，刀 10.2 上仍绿",
  );

  // ② T 还有、死期待定 → 红「在空转」（带条数）
  const pendingOnly = exportDeathProblems({ ...base, deaths: {}, stage: 10, tCount: 2, tPending: 2 });
  assert.ok(pendingOnly.some((m) => m.includes("死期表为空") && m.includes("2 个 T") && m.includes("空转")),
    `死期表翻面失败：T>0 的空表被放过——${pendingOnly.join("；")}`);

  // ③ T 还有、却一个都不待定 → 自相矛盾（派生断了）：这个形态只有派生被改坏才可能出现
  const contradiction = exportDeathProblems({ ...base, deaths: {}, stage: 10, tCount: 1, tPending: 0 });
  assert.ok(contradiction.some((m) => m.includes("自相矛盾") && m.includes("派生被改坏")),
    `死期表翻面失败：T>0 + pending 0 + 空表（派生断了）被放过——${contradiction.join("；")}`);

  // ④ 调用方根本没传 tCount → 红（分不清终态与空转，默认绿就等于允许它空转）
  const unknown = exportDeathProblems({ ...base, deaths: {}, stage: 10 });
  assert.ok(unknown.some((m) => m.includes("没传 tCount")),
    `死期表翻面失败：空表 + 没传 tCount 被静默放过——${unknown.join("；")}`);

  // ⑤ 表非空 → 照常判「到点未死」（这刀不许把它顺手放松）
  const alive = exportDeathProblems({
    deaths: { applyPageZoom: 6 }, stage: 6, tCount: 1, tPending: 0,
    appSource: "function f() { PagesView.applyPageZoom(1); }", apiKeys: ["applyPageZoom"],
  });
  assert.ok(alive.some((m) => m.includes("到点未死")),
    `死期表翻面失败：表非空时「到点未死」没判——${alive.join("；")}`);

  // ⑥ 表条数与清册对不上（派生漏了一条）→ 红：漏掉的那个键在这里根本不受判
  const missing = exportDeathProblems({
    deaths: { applyPageZoom: 6 }, stage: 6, tCount: 2, tPending: 0,
    appSource: "function f() {}", apiKeys: [],
  });
  assert.ok(missing.some((m) => m.includes("派生漏了或多算")),
    `死期表翻面失败：表比清册少一条被放过（那个键静默不受判）——${missing.join("；")}`);
});

test("R8（到点未死）自检：到点还活着红 / 没到点绿 / 到点但已死绿", () => {
  const alive = "function f() { PagesView.applyPageZoom(2); }\n";
  const red = exportDeathProblems({
    deaths: { applyPageZoom: 6 }, stage: 6, appSource: alive, apiKeys: ["applyPageZoom"],
  });
  assert.ok(red.some((m) => m.includes("applyPageZoom") && m.includes("刀6") && m.includes("刀6")
    && m.includes("到点未死") && m.includes("1 处")),
  `到点未死自检失败：到点仍被引用却没红或红文缺数字——${red.join("；")}`);

  // 还没到点：绿（这就是今天的真实状态：死期 刀9 > 当前刀 6）
  assert.deepEqual(
    exportDeathProblems({ deaths: { applyPageZoom: 9 }, stage: 6, appSource: alive, apiKeys: ["applyPageZoom"] }),
    [], "到点未死自检失败：没到点就红了",
  );

  // 到点且已死（引用 0 + 不在 api）：绿
  assert.deepEqual(
    exportDeathProblems({ deaths: { applyPageZoom: 6 }, stage: 6, appSource: "function f() {}", apiKeys: [] }),
    [], "到点未死自检失败：到点且已死也被判红",
  );

  // 只在 api 表里、app.js 没引用 → 仍然红（半死不算死）
  const apiOnly = exportDeathProblems({
    deaths: { applyPageZoom: 6 }, stage: 6, appSource: "function f() {}", apiKeys: ["applyPageZoom"],
  });
  assert.ok(apiOnly.some((m) => m.includes("api 表")),
    `到点未死自检失败：只剩 api 键也被放过——${apiOnly.join("；")}`);
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

test("R8（清理）：已删的 setMarginJudgementCheckbox 不许回到 pages-view.js 或清册里", () => {
  const source = codeOnly(readFileSync(join(STATIC_DIR, "pages-view.js"), "utf8"));
  assert.equal(source.includes("setMarginJudgementCheckbox"), false,
    "它已 0 调用点并被删（清理对第 3 笔）——注释可以留一句，代码里不许回来");
  const entry = VIEW_EXPORTS["pages-view.js"];
  assert.equal(entry.names.includes("setMarginJudgementCheckbox"), false,
    "VIEW_EXPORTS 里还列着它——收紧没做完");
  assert.equal(Object.prototype.hasOwnProperty.call(entry.kinds, "setMarginJudgementCheckbox"), false,
    "kinds 里还登记着它——收紧没做完");
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
// 空表就该零名额：留几个空位等于给未来的探针预批豁免（和 SAME_FILE_DUP 那条同一个毛病）。
// 要开必须先显式抬这个数并在提交里写明理由——"忘了解一下"不许靠预留名额解决。
const A5_MAX_PROBE_FILES = 0;
/** 例外表：{ file, statement, owner, expires }；statement 是归一化后的语句指纹。现状零豁免。 */
const A5_EXCUSES = [];
const A5_MAX_EXCUSES = 0;

const A5_TEST_DIR = fileURLToPath(new URL("./", import.meta.url));

// ---------------------------------------------------------------- 元判据：闸开关登记表
//
// **每个能让一段判据「跳过 / 失效」的顶层常量，都必须在这里写清两件事**：
//   · source：它的真值从哪来（谁算出来的、什么时候会变）；
//   · check：它管的是哪一段判据。
//
// 为什么需要（2026-10-30）：一天里出现五个写死的数字让判据静默空转——
// `PAGES_STAGE=2` 停了三刀（「到期不搬 = 红」整段空转）、`A5_PROBE_FILES` / `A5_EXCUSES` 两张空表、
// seed 刀号上界 `1..5`、受阻项 `=== 5`。前两个到那时也没有任何机检。
// 一条由手工常数控制是否生效的判据，等于一条能被静默停用的判据。
// 「常数对不对」这条判不了；「这个常数有没有登记、有没有说清真值来源」判得了——这就是本段。
// **source 只写「来源」，不抄「现值」**（2026-10-30 加的一层）：抄一份现值就多一个漂点——
// 我在 BRIDGE_EXCEPTION_MAX 上抄了旧值 3（实际早已降成 1），落地几小时就对不上。
// 现值永远看常数那一行，本表只回答「它是谁算出来的、什么时候会变」。机检见 `gateSwitchProblems`。
const GATE_SWITCHES = [
  // 曾经的 `PAGES_STAGE` 常数已删除：当前刀现在由 `stageNow()`（登记表 landed 与 git 提交首行取 max）
  // 在她判据内部现算，不再是可以手调/静默停用的开关，所以这张表里没有它。
  { name: "BRIDGE_EXCEPTION_MAX", source: "edge-ratchet.mjs 里的上限常数，与同文件 BRIDGE_EXCEPTIONS 的条数绑定（只降不升）；现值见该行", check: "A2/边棘轮是否放过某条 app.js 内部桥" },
  { name: "SAME_FILE_DUP_EXCEPTION_MAX", source: "与本文件 SAME_FILE_DUP_EXCEPTIONS 的条数绑定（空表 = 不给名额）；现值见该行", check: "R4b 是否放过某个同文件重复定义" },
  { name: "WINDOW_HOOK_MAX", source: "与 R6 的 __b2t* 窗口钩子白名单条数绑定（只降不升）；现值见该行", check: "R6 是否放过某个全局窗口钩子" },
  { name: "PAGES_R3_BLOCKED_MAX", source: "由留外壳清单的段数决定（knife2.5-split-plan.md §ⅲ，只降不升）；现值见该行", check: "R3 受阻项（带「阻塞段」的豁免）条数上限" },
  { name: "R3_MAX_EXEMPTIONS", source: "人工下调并写明原因（只降不升）；现值见该行", check: "R3 豁免表最多能挂几项" },
  { name: "R9_WHITELIST", source: "浏览器全局白名单（document/window/…），人工追加", check: "R9 是否放过注入表达式里的某个未声明标识符" },
  { name: "MOVE_GATE_WHITELIST", source: "move: 笔允许改 tests/js 的登记表（feature-contract.mjs）", check: "move: 笔能否改动 tests/js 的某块" },
  { name: "A5_PROBE_FILES", source: "空表；登记项必须带 owner + YYYY-MM-DD 到期点（到期即红）", check: "A5 是否豁免某个探针测试文件" },
  { name: "A5_MAX_PROBE_FILES", source: "手工上限，只降不升；现值见该行", check: "A5 探针豁免条数上限" },
  { name: "A5_EXCUSES", source: "空表；每项带语句指纹 + owner + 到期点，指纹不再命中即红", check: "A5 是否放过某条断言" },
  { name: "A5_MAX_EXCUSES", source: "手工上限，只降不升；现值见该行", check: "A5 例外条数上限" },
  { name: "R5_EXCUSES", source: "空表；{ state, file, owner, expires }", check: "R5 是否放过某处「模块写外壳状态」" },
  { name: "R5_MAX_EXCUSES", source: "手工上限，只降不升；现值见该行", check: "R5 例外条数上限" },
  { name: "ALLOW_QUERY_SELECTOR_WHITELIST", source: "域模块里允许 root.querySelector 的具名名单；"
    + "与 DOMAIN_MODULES 的 allowQuerySelector 双向对集，加一个名字要同时改登记表与书（first-batch.md §1）",
    check: "域模块能不能拿根宿主自己查子树（最宽的一条 DOM 豁免）" },
  { name: "T_DEATH_PENDING_MAX", source: "Architect 的 9a/9b 裁定落地时点——每填一个 T 的死期就下调一次，"
    + "永不上调；清零那天删掉这个常数", check: "还有多少 T 键的死期是 null（待定），超上限就红" },
  // `EXPORT_DEATH_EXPIRES` 已删（2026-11-01，刀 10.2 翻面）：死期表判据不再看刀号，
  // T==0 是终态 —— 留着这个常数就是「看着在管、实际不管」的手工常数。
];

/** 「能让判据跳过/失效」的名字形态（Chief 2026-10-30 定，与登记表配套）。 */
const GATE_SWITCH_NAME = /(_STAGE|_MAX(_[A-Z0-9_]+)?|_EXCUSES|_PROBE_FILES|_WHITELIST|_ALLOW|_SKIP|_BYPASS)$/;

/** tests/js/** 顶层的大写常量名（`const X = ` / `export const X = `）。 */
export function gateSwitchNames(dir = A5_TEST_DIR) {
  const names = new Set();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".mjs"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=/gm)) names.add(m[1]);
  }
  return [...names].sort();
}

/** 顶层数值常数的现值（只取 `const X = 数字;`），用来判 source 有没有抄现值。 */
export function gateConstantValues(dir = A5_TEST_DIR) {
  const values = new Map();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".mjs"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(\d+(?:\.\d+)?)\s*;/gm)) {
      values.set(m[1], m[2]);
    }
  }
  return values;
}

/** 未登记的开关名 / 登记了却没写来源 / 登记了但代码里已经没有 / **source 里抄了现值** → 都是红。 */
export function gateSwitchProblems({ names, registry = GATE_SWITCHES, values = gateConstantValues() }) {
  const problems = [];
  const registered = new Map(registry.map((item) => [item.name, item]));
  for (const name of names) {
    if (!GATE_SWITCH_NAME.test(name) || registered.has(name)) continue;
    problems.push(
      `${name} 能让一段判据跳过/失效，但没登记进 GATE_SWITCHES——`
      + "先写清它的真值来源（谁算出来的、什么时候会变）和它管哪段判据",
    );
  }
  for (const item of registry) {
    if (!item.source || !item.check) {
      problems.push(`GATE_SWITCHES 里的 ${item.name} 缺 source/check——登记就要写清真值来源与它管哪段判据`);
    }
    if (!names.includes(item.name)) {
      problems.push(`GATE_SWITCHES 里登记的 ${item.name} 在 tests/js 里已经不存在——删掉它（别把表变成墓地）`);
    }
    // **source 里不许抄现值**（2026-10-30 第三层）：抄一份现值就多一个漂点——BRIDGE_EXCEPTION_MAX
    // 我抄了旧值 3（代码早已降成 1），落地几小时就对不上。现值永远看常数那一行。
    const value = values.get(item.name);
    if (value !== undefined) {
      const hit = new RegExp(`(^|[^\\d.])${value.replace(".", "\\.")}(?![\\d.])`).test(item.source || "");
      if (hit) {
        problems.push(`GATE_SWITCHES 里 ${item.name} 的 source 抄了现值 ${value}——只写来源，`
          + "现值看常数那一行（抄一份现值就多一个漂点）");
      }
    }
  }
  return problems;
}

test("GATE_SWITCHES：能让判据跳过/失效的顶层常数都必须登记真值来源", () => {
  const problems = gateSwitchProblems({ names: gateSwitchNames() });
  assert.deepEqual(problems, [], problems.join("；"));
});

// 自检：没有这一段，登记表就只是"写给人看的注释"——名字拼错、表项过期都不会有人发现。
test("GATE_SWITCHES 自检：未登记红 / 缺 source 红 / 已不存在红 / source 抄现值红 / 合规绿", () => {
  const values = new Map([["OK_MAX_X", "0"]]);
  const reg = [{ name: "OK_MAX_X", source: "手工上限，只降不升；现值见该行", check: "某段判据上限" }];
  const run = (args) => gateSwitchProblems({ values, ...args });
  assert.deepEqual(run({ names: ["OK_MAX_X"], registry: reg }), [],
    `GATE_SWITCHES 自检失败：合规登记被误报——${run({ names: ["OK_MAX_X"], registry: reg }).join("；")}`);

  const missing = run({ names: ["OK_MAX_X", "FOO_MAX"], registry: reg });
  assert.ok(missing.some((m) => m.includes("FOO_MAX") && m.includes("没登记")),
    `GATE_SWITCHES 自检失败：没登记的开关被放过——${missing.join("；")}`);

  const noSource = run({ names: ["BAR_STAGE"], registry: [{ name: "BAR_STAGE" }] });
  assert.ok(noSource.some((m) => m.includes("缺 source/check")),
    `GATE_SWITCHES 自检失败：登记了但没写来源也被放过——${noSource.join("；")}`);

  const graveyard = run({ names: [], registry: reg });
  assert.ok(graveyard.some((m) => m.includes("已经不存在")),
    `GATE_SWITCHES 自检失败：登记了已不存在的常数被放过（表变成墓地）——${graveyard.join("；")}`);

  // 第三层：source 里抄了现值 → 红。抄一份现值就多一个漂点（BRIDGE_EXCEPTION_MAX 抄成 3、实际 1）
  const copied = run({
    names: ["OK_MAX_X"],
    registry: [{ name: "OK_MAX_X", source: "手工上限 0，只降不升", check: "某段判据上限" }],
  });
  assert.ok(copied.some((m) => m.includes("抄了现值") && m.includes("OK_MAX_X")),
    `GATE_SWITCHES 自检失败：source 里抄了现值也放过——${copied.join("；")}`);
});

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

const A5_EXPIRES_FORMAT = "YYYY-MM-DD";

/** 到期点 → Date；不是 `YYYY-MM-DD`（或是不存在的日子，如 2026-02-31）返回 null。 */
function a5ExpiryDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (date.getUTCMonth() !== Number(m[2]) - 1 || date.getUTCDate() !== Number(m[3])) return null;
  return date;
}

function a5IsoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * 探针豁免表的判定内核（纯函数，自检喂合成条目）。返回问题列表，空数组 = 绿。
 *
 * 三条判据（2026-10-30 Chief 要求补后两条）：
 *   ① 名字带 probe 却没登记 → 红（不许靠命名自己开门）；
 *   ② **僵尸**：登记了但文件不存在 / 文件名里没有 probe（豁免没有命中物）→ 红；
 *   ③ **到期点到点**：`expires` 必须是 `YYYY-MM-DD` 且未到期；里程碑文本没法机检 → 红。
 *      这一条抄 `A5_EXCUSES` 的僵尸红：表项没有可判的终点，就等于永久豁免。
 */
function a5ProbeProblems({ files, entries = A5_PROBE_FILES, max = A5_MAX_PROBE_FILES, today = new Date() }) {
  const problems = [];
  const registered = new Set(entries.map((item) => item.file));
  for (const file of files) {
    if (/probe/i.test(file) && !registered.has(file)) {
      problems.push(`文件名含 probe 但没登记进 A5_PROBE_FILES：${file}——豁免要走表，不许靠文件名自己开门`);
    }
  }
  for (const item of entries) {
    if (!files.includes(item.file)) {
      problems.push(`A5 探针 ${item.file} 登记了但文件不存在——僵尸条目（豁免没有命中物），`
        + "删掉；别把表变成墓地");
      continue;
    }
    if (!/probe/i.test(item.file)) {
      problems.push(`A5 探针 ${item.file} 的文件名里没有 probe——这条豁免没有命中物`
        + "（它豁免的是「含 probe 的探针文件」），是白条");
    }
    if (!item.owner || !item.expires) {
      problems.push(`A5 探针 ${item.file} 缺 owner 或到期点`);
      continue;
    }
    const due = a5ExpiryDate(item.expires);
    if (due === null) {
      problems.push(`A5 探针 ${item.file} 的到期点「${item.expires}」不是 ${A5_EXPIRES_FORMAT} 日期`
        + "——里程碑文本没法机检，这条豁免等于永不到期（到期点必须能被程序比对）");
      continue;
    }
    if (due.getTime() <= today.getTime()) {
      problems.push(`A5 探针 ${item.file} 的到期点 ${item.expires} 已到（今天 ${a5IsoDate(today)}）`
        + "——到期就该删条目或续期，别让它变成永久豁免");
    }
  }
  if (entries.length > max) {
    problems.push(max === 0
      ? `A5 探针 ${entries.length} 条，上限 0——没有免检名额：要开必须显式抬高 A5_MAX_PROBE_FILES，`
        + "并在提交里写明理由（空表就该零名额，预留名额等于给未来的探针预批豁免）"
      : `A5 探针 ${entries.length} 条，上限 ${max}——开口要显式加数字`);
  }
  return problems;
}

test("A5 探针豁免：名字带 probe 必须登记；僵尸条目 / 到期已过 / 到期点没法机检 都要红", () => {
  const files = readdirSync(A5_TEST_DIR).filter((name) => name.endsWith(".test.mjs"));
  const problems = a5ProbeProblems({ files });
  assert.deepEqual(problems, [], problems.join("；"));
});

// 自检：没有这一条，探针表的四条判据全是"只在表为空时绿"的空转。
test("A5 探针自检：未登记红 / 僵尸红 / 到点红 / 到期点不是日期红 / 白条红 / 合规绿", () => {
  const files = ["a.test.mjs", "b.probe.test.mjs"];
  const ok = [{ file: "b.probe.test.mjs", owner: "TestDev", expires: "2099-01-01" }];
  // 合规条目要配名额才算合规（上限现在是 0：空表零名额）
  assert.deepEqual(a5ProbeProblems({ files, entries: ok, max: 4 }), [],
    `A5 探针自检失败：合规条目被误报——${a5ProbeProblems({ files, entries: ok, max: 4 }).join("；")}`);

  const run = (entries) => a5ProbeProblems({ files, entries });
  // 空表就零名额：同一条合规探针，cap 4 时绿、cap 0 时红——证明是 cap 在管，不是别的判据在管
  assert.deepEqual(a5ProbeProblems({ files, entries: ok, max: 4 }), [],
    `A5 探针自检失败：有名额时合规探针被误报——${a5ProbeProblems({ files, entries: ok, max: 4 }).join("；")}`);
  const noQuota = a5ProbeProblems({ files, entries: ok, max: 0 });
  assert.ok(noQuota.some((m) => m.includes("没有免检名额")),
    `A5 探针自检失败：空表 + cap 0 时加了一条探针也被放过——${noQuota.join("；")}`);

  assert.ok(run([]).some((m) => m.includes("没登记进 A5_PROBE_FILES")),
    `A5 探针自检失败：未登记的 probe 文件被放过——${run([]).join("；")}`);
  assert.ok(run([{ file: "gone.probe.test.mjs", owner: "x", expires: "2099-01-01" }])
    .some((m) => m.includes("僵尸条目")),
  "A5 探针自检失败：登记了不存在的文件没报僵尸");
  assert.ok(run([{ file: "b.probe.test.mjs", owner: "x", expires: "2020-01-01" }])
    .some((m) => m.includes("已到")),
  "A5 探针自检失败：到期点已过没红（这条是「永久豁免」的入口）");
  assert.ok(run([{ file: "b.probe.test.mjs", owner: "x", expires: "验收完成" }])
    .some((m) => m.includes("没法机检")),
  "A5 探针自检失败：里程碑文本到期点被当成合格（等于永远不到期）");
  assert.ok(run([{ file: "a.test.mjs", owner: "x", expires: "2099-01-01" }])
    .some((m) => m.includes("没有命中物")),
  "A5 探针自检失败：给非 probe 文件开豁免（白条）被放过");
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

/** 编辑距离：只用来在红文里点出「最接近的已声明键」（名字都很短，朴素的 DP 足够）。 */
/**
 * **R3 第四形态：字符串 id 偷渡**（Architect 2026-10-30 定稿）。
 *
 * 模块把别域的 id 当**字符串**递给通用能力：`injected.closeModal("new-project-mask")`。
 * R3 的三种形态（`el()` / `getElementById` / `querySelector`）都看不见这种写法——
 * 字符串里没有任何 DOM 取法，闸照绿，而模块实际上在操作别的视图/外壳的 DOM。
 *
 * 扫描输入必须是 `codeOnly`（**剥注释、保留字符串**）：
 *   · 剥注释：`pages-view.js` 里有 6 处 `el()` 只存在于注释里，不剥就会红在说明文字上；
 *   · 保留字符串：要抓的正是字符串，顺手把字符串剥了这条判据就没有对象。
 *
 * 两档红文分开（合成一句会把修的人带偏）：
 *   · 别的视图的 id → 跨域必须走注入能力；
 *   · 外壳 chrome（不在任何 section）→ 模块不许碰。
 */
function idOwnership(html) {
  const sections = parseViewSections(html);
  const owner = new Map();
  for (const [view, ids] of sections) for (const id of ids) owner.set(id, view);
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
    if (!owner.has(m[1])) owner.set(m[1], null);   // null = 外壳 chrome（不在任何 view section 里）
  }
  return owner;
}

export function stringIdSmuggleProblems({ html, modules }) {
  const owner = idOwnership(html);
  const problems = [];
  for (const { fileName, source } of modules) {
    const viewName = fileName.replace(/-view\.js$/, "");
    codeOnly(source).split("\n").forEach((line, index) => {
      for (const m of line.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)) {
        const literal = m[1] ?? m[2] ?? m[3];
        if (!literal || !owner.has(literal)) continue;
        const where = owner.get(literal);
        if (where === viewName) continue;
        if (where === null) {
          problems.push(`${fileName}:${index + 1} 把外壳 chrome 的 id "${literal}" 当字符串传`
            + "——外壳元素模块不许碰，要走注入的语义能力");
        } else {
          problems.push(`${fileName}:${index + 1} 把 view-${where} 的 id "${literal}" 当字符串传`
            + "——跨域必须走注入能力");
        }
      }
    });
  }
  return problems;
}

test("R3 第四形态（字符串 id 偷渡）：剥注释取字符串字面量，跨视图 / 外壳 chrome 都必须红", () => {
  const html = '<section id="view-pages"><div id="pages-error"></div></section>'
    + '<section id="view-review"><div id="page-detail-error"></div></section>'
    + '<div class="mask" id="package-result-meta"></div>';
  const scan = (source) => stringIdSmuggleProblems({
    html, modules: [{ fileName: "pages-view.js", source }],
  });

  // 本视图自己的 id 当字符串传：允许（还没收成语义能力之前，本域不算偷渡）
  assert.deepEqual(scan('injected.reportError("pages-error");'), [],
    `第四形态自检失败：本视图 id 被误判——${scan('injected.reportError("pages-error");').join("；")}`);

  // 别的视图的 id → 跨域档
  const cross = scan('injected.closeModal("page-detail-error");');
  assert.ok(cross.some((m) => m.includes("page-detail-error") && m.includes("view-review")
    && m.includes("跨域必须走注入能力")),
  `第四形态自检失败：跨视图字符串 id 没红或红文不对——${cross.join("；")}`);

  // 外壳 chrome 的 id → 另一档（不许合成一句）
  const chrome = scan('injected.closeModal("package-result-meta");');
  assert.ok(chrome.some((m) => m.includes("package-result-meta") && m.includes("外壳 chrome")
    && m.includes("模块不许碰")),
  `第四形态自检失败：外壳 chrome 字符串 id 没红或红文不对——${chrome.join("；")}`);

  // **注释里的不算**：扫描输入是 codeOnly（保留字符串）
  assert.deepEqual(scan('// injected.closeModal("page-detail-error")'), [],
    "第四形态自检失败：注释里的字符串被当真了（这条判据必须剥注释，否则会红在说明文字上）");

  // 不是 index.html 里任何 id 的字符串：不管（普通文案）
  assert.deepEqual(scan('const zz = "hello world";'), [],
    "第四形态自检失败：普通字符串被误判成 id");
});

test("R3 第四形态（实树）：模块里不许把别域 id 当字符串传", () => {
  const html = readFileSync(join(STATIC_DIR, "index.html"), "utf8");
  const modules = readdirSync(STATIC_DIR)
    .filter((name) => /-view\.js$/.test(name))
    .sort()
    .map((fileName) => ({ fileName, source: readFileSync(join(STATIC_DIR, fileName), "utf8") }));
  const problems = stringIdSmuggleProblems({ html, modules });
  assert.deepEqual(problems, [], problems.join("\n"));
});

function r13EditDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * 缺键红文的**两条线索**（2026-10-30 Chief 要求）：只说"缺这个键"修的人不知道该删还是该改。
 *   · 最接近的已声明键 → 拼错 / 改名；
 *   · `app.js` 里有没有同名符号 → 有 = 漏注入（刀 4 形态：改了直呼没删 deps 的反方向），
 *     没有 = 名字来源不明（刀 5 形态：删了 deps 没改直呼，名字可能是别人家的）。
 */
function r13MissingKeyHint({ name, passed, topLevel }) {
  const near = [...passed]
    .map((key) => [key, r13EditDistance(key, name)])
    .sort((x, y) => x[1] - y[1])[0];
  const clue = near && near[0] !== name && near[1] <= 3
    ? `deps 里最接近的键是 ${near[0]}（编辑距离 ${near[1]}）——是拼错还是改名？`
    : "deps 里没有名字相近的键——不是拼错，是真的没声明";
  const where = topLevel.has(name)
    ? `app.js 里有同名符号 ${name}——漏注入：deps 少写一行`
    : `app.js 里也没有符号 ${name}——名字来源不明，先确认它本该从哪来`;
  return `${clue}；${where}`;
}

/**
 * R13 判定内核（纯函数，自检喂合成源码）。
 *
 * 返回 `{ problems, optional }`：
 *   · `problems` = 必读形态缺键（红）；
 *   · `optional` = 可选形态缺键（**不红**，只打印）：`injected.X?.(` / `injected.X || 兜底`。
 *     理由（2026-10-30 Chief 裁定）：可选形态本来就允许缺键，判红会让既有代码库立刻红一片；
 *     但完全不报，`showNoticeBar` 那种「提示条悄悄不显示」就永远藏着。红与报要分开。
 */
function r13InjectionScan({ appSource, modules }) {
  const problems = [];
  const optional = [];
  if (!Array.isArray(modules) || modules.length === 0) {
    return {
      problems: ["R13 拿不到 view 模块名单（static 目录里没有 *-view.js）——空名单会让这条闸空转，按红处理"],
      optional,
    };
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
    // **全量扫 `injected.X`，不要求后面跟 `( / [ / .`**（2026-10-30）：旧正则带
    // `(?=[([.])`，只认调用位/属性位/下标位；而刀 4/刀 5 的「漏改一处直呼」多是**值位**
    // （`const s = injected.storage;` / `foo(injected.limit)` / `injected.flag ? a : b`）——
    // 整类看不见，闸照绿、运行时 undefined。这是 R13 旧口径的真实缺口，不是新加的花样。
    for (const m of text.matchAll(/injected\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      if (passed.has(name)) continue;
      const after = text.slice(m.index + m[0].length);
      const optionalCall = /^\s*\?\.\s*\(/.test(after);
      const optionalFallback = /^\s*\|\|/.test(after);
      const hint = r13MissingKeyHint({ name, passed, topLevel });
      if (optionalCall || optionalFallback) {
        optional.push(`${file}: injected.${name}（${optionalCall ? "?.(" : "|| 兜底"}）缺键——静默不生效。${hint}`);
      } else {
        problems.push(`${file}: 模块读了 injected.${name}（必读形态），但 init deps 里没有这个键`
          + `——运行时是 undefined（读它的地方会炸或静默错值）。${hint}`);
      }
    }
  }
  return { problems, optional };
}

/** 只要红的那一半（绝大多数调用点用它）；可选形态清单用 `r13InjectionScan` 取。 */
function r13InjectionProblems(args) {
  return r13InjectionScan(args).problems;
}

test("R13：注入表每个键都能解析（顶层/工厂作用域/全局白名单），模块必读的键都传了", () => {
  const appSource = readFileSync(APP_FILE, "utf8");
  const modules = readdirSync(STATIC_DIR)
    .filter((name) => /-view\.js$/.test(name))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(STATIC_DIR, file), "utf8") }));
  assert.ok(modules.length >= 2,
    `static 目录里只找到 ${modules.length} 个 *-view.js——目录指错了吧？空名单不能让这条闸变绿`);
  const scan = r13InjectionScan({ appSource, modules });
  assert.deepEqual(scan.problems, [], scan.problems.join("\n"));
  // 可选形态缺键**不红**，但必须打印出来：这类「静默不生效」既不抛错、也没人会发现
  for (const line of scan.optional) console.log(`ℹ R13 可选注入缺键（不红，静默不生效）：${line}`);
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

  // ⑥ 可选形态（`?.(` / `|| 兜底`）缺键：**不红**，但要进「静默不生效」清单。
  //    这是 2026-10-30 两级判据的另一半：可选形态本来就允许缺，全判红会让既有代码库立刻红一片；
  //    可完全不报，`injected.showNoticeBar?.(...)` 那种「提示条悄悄不显示」就永远藏着。
  const optionalScan = r13InjectionScan({
    appSource: appWith("    getProject: () => currentProject,"),
    modules: [moduleOf('  function f() { injected.ghostOpt?.(1); return injected.storage || window.localStorage; }')],
  });
  assert.deepEqual(optionalScan.problems, [],
    `R13 自检失败：可选形态缺键被当成红——${optionalScan.problems.join("；")}`);
  assert.ok(optionalScan.optional.some((line) => line.includes("ghostOpt") && line.includes("?.(")),
    `R13 自检失败：可选调用缺键没进清单——${optionalScan.optional.join("；")}`);
  assert.ok(optionalScan.optional.some((line) => line.includes("storage") && line.includes("|| 兜底")),
    `R13 自检失败：|| 兜底缺键没进清单——${optionalScan.optional.join("；")}`);

  // ⑦ 裸值位（后面既不是 ( 也不是 [ 也不是 .）缺键 → 必须红。
  //    旧正则 `(?=[([.])` 对这三种形态**整类看不见**，而刀 4/刀 5 的漏改直呼多是这个形状。
  const bareRed = r13InjectionProblems({
    appSource: appWith("    getProject: () => currentProject,"),
    modules: [moduleOf("  function f() { const x = injected.ghostBare; return x; }")],
  });
  assert.ok(bareRed.some((line) => line.includes("injected.ghostBare") && line.includes("必读形态")),
    `R13 自检失败：裸值位缺键被放过（旧正则那个缺口）——${bareRed.join("；")}`);

  // ⑧ 红文的两条线索：最接近的已声明键 / app.js 里有没有同名符号
  const hintRed = r13InjectionProblems({
    appSource: appWith("    lastViewLabels: LAST_VIEW_LABELS,", "const LAST_VIEW_LABELS = Object.freeze({});"),
    modules: [moduleOf("  function f() { return injected.lastViewLabel; }")],
  });
  assert.ok(hintRed.some((line) => line.includes("最接近的键是 lastViewLabels")),
    `R13 自检失败：红文没点出最接近的已声明键（修的人不知道该改名还是该补注入）——${hintRed.join("；")}`);
  const typoRed = r13InjectionProblems({
    appSource: appWith("    getProject: () => currentProject,"),
    modules: [moduleOf("  function f() { return injected.ghostNoWhere; }")],
  });
  assert.ok(typoRed.some((line) => line.includes("app.js 里也没有符号 ghostNoWhere")),
    `R13 自检失败：红文没说清「app.js 有没有同名符号」（漏注入 vs 拼错分不开）——${typoRed.join("；")}`);
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

// ---------------------------------------------------------------- 刀 11 开闸：页面视图收口三条机检
//
// 三条都站在"清完之后应该恒绿"的位置上，每条都带**喂坏样本必须红**的自检
// （判据自己能被证伪；只绿不红的判据等于空转）。
//
// ① deps 多键：PagesView 的 deps 里出现「模块 injected 读 0」的键 → 红。
//    **剥注释口径**：注释里提到 dep 名不算"模块读过"（否则一句说明就能把闸打绿/打红）。
// ② 0 引用顶层函数：app.js 顶层 function 在 app.js（剥注释）/ 各 *-view.js / tests 里全 0 引用 → 红。
// ③ 反向闸：导出名出现 `refresh`，或任一 C 键定义里出现 `scope:` / `op:` 字段 → 红。
//    （`refresh` 不建：它是"配置项化入口"，且在本项目已有写死的窄语义；C 键各绑单一动作，
//      一旦长出 scope/op 就等于把"调哪个函数"塞进载荷。）


/** 取出 `window.PagesView?.init({ … })` 这一段 deps 块的键名（按 `    name:` 行首缩进识别）。 */
function pagesDepsKeys(appSource) {
  const start = appSource.indexOf("window.PagesView?.init({");
  if (start < 0) return [];
  const end = appSource.indexOf("window.IndexView?.init({", start);
  const block = appSource.slice(start, end < 0 ? appSource.length : end);
  const keys = [];
  for (const line of block.split("\n")) {
    const m = /^ {4}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** ① 的判据：deps 里"模块 0 读"的键（剥注释后按 `injected.<键>` 全文匹配）。 */
export function deadPagesDepProblems({ appSource, moduleSource }) {
  const stripped = codeOnly(moduleSource || "");
  const dead = pagesDepsKeys(appSource).filter(
    (key) => !new RegExp(`injected\\.${key}\\b`).test(stripped),
  );
  return dead.map((key) => `pages-view 的 deps 里 \`${key}\` 模块 0 读——死注入，删掉（模块要读的键才注入）`);
}

/** ② 的判据：app.js 顶层 function 在 app / 各视图模块 / tests 里全 0 引用（除定义行本身）。 */
export function zeroRefFunctionProblems({ appSource, moduleSources = [], testsSource = "" }) {
  const stripped = codeOnly(appSource || "");
  const names = [...stripped.matchAll(/^(?:async )?function ([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]);
  const count = (text, name) => {
    const re = new RegExp(`\\b${name}\\b`, "g");
    return (String(text || "").match(re) || []).length;
  };
  const moduleText = moduleSources.join("\n");
  const problems = [];
  for (const name of names) {
    const inApp = count(stripped, name);
    const inViews = count(moduleText, name);
    const inTests = count(testsSource, name);
    if (inApp <= 1 && inViews === 0 && inTests === 0) {
      problems.push(`app.js 顶层函数 \`${name}\` 0 引用（app 只剩定义行、模块与 tests 都没有）——死代码，删掉或接上调用`);
    }
  }
  return problems;
}

/** ③ 的判据：导出名不许有 `refresh`；C 键定义里不许出现 scope:/op:（"调哪个函数"的载荷）。 */
export function terminalExportProblems({ names = [], kindsText = "" }) {
  const problems = [];
  if (names.includes("refresh")) {
    problems.push("导出名出现 `refresh`——刀 11 裁定不建它（配置项化入口 + 同词两义），改名或删掉");
  }
  const block = codeOnly(kindsText || "");
  for (const m of block.matchAll(/([A-Za-z_][A-Za-z0-9_]*):\s*\{\s*kind:\s*"C"([^}]*)\}/g)) {
    const [, name, rest] = m;
    if (/\bscope\s*:/.test(rest)) problems.push(`C 键 \`${name}\` 里出现 scope: 字段——"调哪个函数"不许塞进载荷`);
    if (/\bop\s*:/.test(rest)) problems.push(`C 键 \`${name}\` 里出现 op: 字段——同上`);
  }
  return problems;
}

test("刀 11 闸①：PagesView deps 里没有「模块 0 读」的死注入键（剥注释口径）", () => {
  const appSource = readFileSync(APP_FILE, "utf8");
  // 注意：VIEW_FILE 默认是 reading-view.js（R1 用），这里的闸查的是 **pages-view.js**
  const moduleSource = readFileSync(join(STATIC_DIR, "pages-view.js"), "utf8");
  assert.deepEqual(deadPagesDepProblems({ appSource, moduleSource }), []);
  // 自检：真 `injected.x` 算读过（绿）；只在注释里提到**不算**（红）——这正是剥注释口径的要点
  const fakeApp = "  window.PagesView?.init({\n    onlyInComment: onlyInComment,\n    reallyRead: reallyRead,\n  });\n  window.IndexView?.init({});\n";
  const realRead = "// onlyInComment 只在注释里出现\nconst v = injected.reallyRead();\n";
  assert.deepEqual(deadPagesDepProblems({ appSource: fakeApp, moduleSource: realRead }), [
    "pages-view 的 deps 里 `onlyInComment` 模块 0 读——死注入，删掉（模块要读的键才注入）",
  ], "只在注释里提到的 dep 必须判红（剥注释口径）");
  const bothRead = "// 说明\nconst a = injected.onlyInComment();\nconst b = injected.reallyRead();\n";
  assert.deepEqual(deadPagesDepProblems({ appSource: fakeApp, moduleSource: bothRead }), [], "真读过的两个键必须绿");
});

test("刀 11 闸②：app.js 顶层函数没有 0 引用的死代码", () => {
  const appSource = readFileSync(APP_FILE, "utf8");
  const moduleSources = readdirSync(STATIC_DIR)
    .filter((name) => /-view\.js$/.test(name))
    .map((name) => readFileSync(join(STATIC_DIR, name), "utf8"));
  // 测试源要覆盖**全部**测试（js + py）：只看 boundary 自己会把"只被其它测试引用"的函数误判成死代码
  const testsDir = fileURLToPath(new URL("..", import.meta.url));
  const collectTests = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__pycache__" ? [] : collectTests(full);
    return /\.(mjs|py)$/.test(entry.name) ? [readFileSync(full, "utf8")] : [];
  });
  const testsSource = collectTests(testsDir).join("\n");
  assert.deepEqual(zeroRefFunctionProblems({ appSource, moduleSources, testsSource }), []);
  // 自检：只定义不引用 → 红；被同文件调用 → 绿；只被 tests 引用 → 绿（不算全 0）
  // 夹具里必须留一个"从测试进来的根"，否则连根一起判死，验不出"叶子 vs 被引用"的区别
  const fake = "function orphanFn() {\n  return 1;\n}\nfunction calledFn() {\n  return 2;\n}\nfunction rootFn() {\n  return calledFn();\n}\nfunction testedFn() {\n  return 3;\n}\n";
  const problems = zeroRefFunctionProblems({ appSource: fake, moduleSources: ["x"], testsSource: "testedFn rootFn" });
  assert.equal(problems.length, 1, `只该报 orphanFn 一条——实际：${problems.join("；")}`);
  assert.ok(problems[0].includes("orphanFn"), problems[0]);
  assert.deepEqual(zeroRefFunctionProblems({ appSource: "function loopy() {\n  loopy();\n}\n" }), [], "自递归算有引用");
});

test("刀 11 闸③：不建 refresh 导出、C 键里没有 scope:/op: 载荷", () => {
  assert.deepEqual(terminalExportProblems({ names: VIEW_EXPORTS["pages-view.js"].names, kindsText: "" }), []);
  // 自检：三组坏样本各自红
  assert.equal(terminalExportProblems({ names: ["init", "refresh"], kindsText: "" }).length, 1, "refresh 导出必须红");
  assert.equal(terminalExportProblems({ names: ["init"], kindsText: 'a: { kind: "C", callers: ["x"], scope: 3 },' }).length, 1, "C 键里 scope: 必须红");
  assert.equal(terminalExportProblems({ names: ["init"], kindsText: 'a: { kind: "C", callers: ["x"], op: "paint" },' }).length, 1, "C 键里 op: 必须红");
  assert.deepEqual(
    terminalExportProblems({ names: ["init", "enter"], kindsText: 'a: { kind: "C", callers: ["x"], reason: "r" },' }),
    [],
    "合规的 C 键必须绿",
  );
});

// ---------------------------------------------------------------- 域模块（服务模块）：不按 id 找 DOM
//
// 形态见 `docs/refactor/appjs-domains/first-batch.md` §1：这些域不是视图，文件不叫 `*-view.js`，
// 也不许按 id 找 DOM（`el(` / `document.getElementById` 各 0 次）；`init()` 拿一个根宿主，
// 之后只在子树里 `querySelector`。四刀（A 质量统计 / B 页面确认 / C 目录确认 / D 结构工具）共用这条。
const DOMAIN_MODULES = [
  { file: "quality-stats.js", exposes: "QualityStats" },
  { file: "page-confirm.js", exposes: "PageConfirm" },
  // 片 1：图层容器由 registry 自己 createElement，宿主由视图 mount 时给 ⇒ 零豁免过这条闸
  { file: "overlay-registry.js", exposes: "OverlayLayer" },
  // 刀 C：radio 由外壳在自己的 root 子树里查好传进来 ⇒ 模块连 querySelector 都是 0 次
  { file: "page-index.js", exposes: "PageIndexService" },
  // 刀 D：17 个 structure-* 全在 #structure-panel 子树里，逐个传太笨 ⇒ 允许 root.querySelector，
  // 但 document.querySelector / getElementById / el( 仍然各 0 次（见下面 allowQuerySelector 的分支）
  { file: "structure-tools.js", exposes: "StructureTools", allowQuerySelector: true },
  // S1：root = #view-review，24 个归模块的 id 全在这棵子树里（§2 表），元素多到逐个传不现实。
  // 现状：剥注释后 el( / document.getElementById / document.querySelector 各 0 次；
  // root.querySelector 2 处（part() 与 querySelectorAll）+ 4 处元素级查询 ⇒ 走 allowQuerySelector 分支恰好合规。
  // **它此前根本没登记在这张表里** ⇒ 域模块闸从没查过它 —— 这正是下面「登记完整性」要关掉的洞。
  { file: "page-detail-editor.js", exposes: "PageDetailEditor", allowQuerySelector: true },
  // ③ 导出：root = #export-panel（顶层 modal，30 个导出 id 全在它子树里）；10 个 checkbox 逐个传不现实
  { file: "export-panel.js", exposes: "ExportPanel", allowQuerySelector: true },
  // ③ 跨视图服务：root = #suggestion-apply-panel（5 个 id 在子树里，part() 要 root.querySelector）；
  // chrome 通知条 6 个节点与审校页那个按钮都在 root 外 ⇒ 走 init 注入，模块里不出现那些 id。
  { file: "suggestion-flow.js", exposes: "SuggestionFlow", allowQuerySelector: true },
  // ③ 协作：**两个 root**按宿分组——#assign-panel（16 个 id）· #package-result（3 个 id）；
  // chrome 4 个节点（顶栏 3 + 通知条 1）走注入，模块里不出现那 4 个 id。
  { file: "collab.js", exposes: "Collab", allowQuerySelector: true },
  // ① 主刀收尾：核心抽屉（root = #view-review，与 editor 同一 root，靠 id 表分家；
  // 21 个抽屉 id 全在子树里 ⇒ 允许 root.querySelector）
  { file: "page-detail-drawer.js", exposes: "PageDetailDrawer", allowQuerySelector: true },
  // 片 1a：页码面板——**两个根**（#page-number-panel 9+3 个子 id / #page-number-review-panel 9 个），
  // 都是 body 直下的顶层 mask ⇒ 允许 root.querySelector。
  { file: "page-number-panel.js", exposes: "PageNumberPanel", allowQuerySelector: true },
  // 片 2：版心数据——**服务模块**（0 组自建 DOM、被四个视图消费）；tile 由调用方传进来，
  // 它只在**那个 tile 元素**里查 `.page-margin` / `.page-margin__box`（3 处元素级查询）
  // ⇒ 走 allowQuerySelector 分支（document 级查询仍然 0）。
  { file: "margin-data.js", exposes: "MarginData", allowQuerySelector: true },
  // 片 1b：批量拆分面板——root = #split-batch-panel（body 直下的 mask，8 个子 id）
  { file: "split-batch-panel.js", exposes: "SplitBatchPanel", allowQuerySelector: true },
  // 片 3a：页面网格——**瓦片工厂 + 块缓存**（服务模块，无 root）：页面记录由调用方给，
  // 它只在自己造出来的那个 tile 里查 label / status / 按钮（3 处元素级查询）
  // ⇒ 走 allowQuerySelector 分支（document 级查询仍然 0）。生产侧契约见文件头，
  // 与 margin-data.js 的消费侧契约对应。
  { file: "page-grid.js", exposes: "PageGrid", allowQuerySelector: true },
  // 片 3b：页面图像——缩放档位 / 图档选择 / 宽度测量（服务模块，无 root、不自建 DOM）：
  // element 由调用方给，模块只量宽 + 拼 URL ⇒ 连 querySelector 都是 0 次。
  { file: "page-media.js", exposes: "PageMedia" },
  // 第十一笔：正文审校 v3 的差异列表——root = #view-reading 里的列表容器（domain 模块；
  // 只用 root.querySelector 取 data-rcl 节点，不用 querySelectorAll，故不进白名单）
  { file: "review-cat-list.js", exposes: "ReviewCatList" },
  // 第十一笔：下方 5 行上下文 + 三档取景；元素由外壳注入（listEl 一类），renderCrop 由本模块导出
  { file: "review-focus.js", exposes: "ReviewFocus" },
  // 片 4：审校左栏目录树——root = #review-tree（第四个 owner TREE，6 个 id 全在子树里）
  { file: "review-tree.js", exposes: "ReviewTree", allowQuerySelector: true },
  // 片 5：跨页延续面板——root = #continuation-panel（顶层 mask，14 个 id 全在子树里）
  { file: "continuation-review.js", exposes: "ContinuationReview", allowQuerySelector: true },
  // 片 6：标点批量 + 整行乱码——两个顶层 mask 两个根（#punct-groups-mask / #garbled-mask）
  { file: "punct-batch.js", exposes: "PunctBatch", allowQuerySelector: true },
  // 片 7：锁冲突 / 废纸篓 / 项目备份——三个顶层 mask 三个根
  { file: "recovery-panels.js", exposes: "RecoveryPanels", allowQuerySelector: true },
  // 片 8：字框回填——root = #word-boxes-mask（顶层 mask）
  { file: "word-boxes.js", exposes: "WordBoxes", allowQuerySelector: true },
  // 片 9：字符规范化——root = #orthography-panel（顶层 mask）
  { file: "orthography.js", exposes: "Orthography", allowQuerySelector: true },
  // 片 10：检测版面外壳——root = #layout-detect-mask（顶层 mask）
  { file: "layout-detect.js", exposes: "LayoutDetect", allowQuerySelector: true },
];

/**
 * **允许 `root.querySelector` 的模块 —— 具名白名单**（Chief 2026-11-02 裁定）。
 *
 * 原来是「`allowQuerySelector` 的模块 ≤ 1 个」：那是个能扩容的上限，第二个模块只要把 1 改成 2
 * 就悄悄过了。现在改成双向对集：登记了这个能力却不在名单里 ⇒ 红；名单里有名字却没登记这个能力 ⇒ 红。
 * 第三个模块要 root 时，必须同时改这里、改登记表、改书（`first-batch.md` §1）——做不到「顺手加个名字」。
 */
const ALLOW_QUERY_SELECTOR_WHITELIST = [
  "structure-tools.js",
  "page-detail-editor.js",
  "export-panel.js",
  "suggestion-flow.js",
  "collab.js",
  "page-detail-drawer.js",
  "page-number-panel.js",
  "margin-data.js",
  "split-batch-panel.js",
  "page-grid.js",
  "review-tree.js",
  "continuation-review.js",
  "punct-batch.js",
  "recovery-panels.js",
  "word-boxes.js",
  "orthography.js",
  "layout-detect.js",
];

function querySelectorWhitelistProblems({ modules, whitelist }) {
  const problems = [];
  const named = new Set(whitelist || []);
  const byFile = new Map((modules || []).map((mod) => [mod.file, mod]));
  if (!whitelist || whitelist.length === 0) {
    problems.push("root.querySelector 白名单是空的——空表让「谁能查 root」无从判定");
  }
  for (const mod of modules || []) {
    if (mod.allowQuerySelector && !named.has(mod.file)) {
      problems.push(`${mod.file} 登记了 allowQuerySelector: true，但不在白名单里——要 root.querySelector 必须显式进名单（连带改书），不能登记时顺手写个 true`);
    }
  }
  for (const name of whitelist || []) {
    const mod = byFile.get(name);
    if (!mod) {
      problems.push(`白名单里的 ${name} 不是已登记的域模块——白名单不许留空壳`);
    } else if (!mod.allowQuerySelector) {
      problems.push(`白名单里的 ${name} 没有 allowQuerySelector: true——白名单与登记表不一致，两边必须对得上`);
    }
  }
  return problems;
}

/**
 * **不是域的服务模块**：同样挂 `window.X = api`，但形态不同、不归域模块闸管。
 * 每一行都要写清"为什么它不是域"——这条表就是"没登记就逃过闸"那层判据的合法出口。
 */
const NON_DOMAIN_MODULES = [
  { file: "page-tile.js", why: "组件不是域：没有 init(root)，自己 createElement 出瓷砖，生命周期由 pages/preview 持有" },
  { file: "step-timing.js", why: "纯计时工具：0 DOM、0 请求，只写只读全局对象 window.__b2tStepTiming" },
];

/**
 * **登记完整性：挂了 `window.X = api` 的 static 文件必须登记在两张表之一**（Chief 2026-11-02 裁定）。
 *
 * 防的是：一个服务模块落了盘、却没人把它加进 `DOMAIN_MODULES` —— 于是域模块闸对它是**静默不查**，
 * 而闸天天绿。`page-detail-editor.js` 在 S1 落地后就是这样过了整整一刀：不是"例外太多"，
 * 是**"不登记就逃过闸"**。`*-view.js` 按后缀排除（视图归 R2/R3/R6/R7，不归这张表）。
 */
function moduleRegistrationProblems({ files, domainModules, nonDomainModules }) {
  const problems = [];
  const domain = new Set((domainModules || []).map((mod) => mod.file));
  const nonDomain = new Set((nonDomainModules || []).map((mod) => mod.file));
  for (const file of domain) {
    if (nonDomain.has(file)) {
      problems.push(`${file} 同时登记在 DOMAIN_MODULES 与 NON_DOMAIN_MODULES——两张表互斥，选一张并写清理由`);
    }
  }
  // 空列表放到互斥判定之后：否则 files:[] 会提前 return，上面那一支永远判不到（顺序本身也是判据）
  if (!files || files.length === 0) {
    problems.push("static 下一个 .js 都没扫到——这条判据在空转");
    return problems;
  }
  for (const { fileName, source } of files) {
    if (/-view\.js$/.test(String(fileName || ""))) continue;
    const code = codeOnly(source || "");
    if (!/window\.[A-Za-z_$][\w$]*\s*=\s*api\b/.test(code)) continue;
    if (domain.has(fileName) || nonDomain.has(fileName)) continue;
    problems.push(`${fileName} 挂了 window.X = api（服务模块出口），但既不在 DOMAIN_MODULES 也不在 NON_DOMAIN_MODULES——`
      + "没登记就不受域模块闸检查，绿是假的");
  }
  return problems;
}

function domainDomProblems({ file, source, allowQuerySelector = false }) {
  const stripped = codeOnly(source || "");
  const problems = [];
  const checks = [
    ["el(", /\bel\s*\(/g, "init() 直接收下要写的元素，模块里不按 id 找 DOM"],
    ["document.getElementById(", /document\.getElementById\s*\(/g, "同上"],
  ];
  if (allowQuerySelector) {
    // 刀 D 的唯一例外：元素太多、又全在同一个 root 子树里（17 个 structure-*）⇒ 允许 root.querySelector，
    // 但 document 级的查询仍然一次都不许出现（那等于按 id 找全局 DOM）。
    checks.push([
      "document.querySelector(",
      /document\.querySelector(?:All)?\s*\(/g,
      "root 子树内可以查，document 全局查不行：宿主由 init 给",
    ]);
  } else {
    // v1.1（Chief 2026-11-01）：连 querySelector( 也归零——"拿根宿主再自己找"同样是按结构找 DOM
    checks.push([".querySelector(", /\.querySelector(?:All)?\s*\(/g, "根宿主/子树查询一律不要：元素由 init 传进来"]);
  }
  for (const [label, re, why] of checks) {
    const hits = (stripped.match(re) || []).length;
    if (hits) problems.push(`${file} 里出现 ${hits} 次 ${label}——${why}`);
  }
  return problems;
}

test("域模块（刀 A）：quality-stats.js 不按 id 找 DOM，四个函数已从 app.js 迁出", () => {
  // 「谁能查 root」用**具名白名单**双向对集，不再用一个能扩容的上限（`<= 1` 改个数字就过）。
  const whitelistProblems = querySelectorWhitelistProblems({
    modules: DOMAIN_MODULES, whitelist: ALLOW_QUERY_SELECTOR_WHITELIST,
  });
  assert.deepEqual(whitelistProblems, [], whitelistProblems.join("\n"));
  for (const mod of DOMAIN_MODULES) {
    const source = readFileSync(join(STATIC_DIR, mod.file), "utf8");
    const problems = domainDomProblems({ file: mod.file, source, allowQuerySelector: Boolean(mod.allowQuerySelector) });
    assert.deepEqual(problems, [], problems.join("\n"));
    assert.ok(
      source.includes(`window.${mod.exposes} = api`),
      `${mod.file} 必须挂 window.${mod.exposes}（服务模块的唯一出口，R7b 会查它的 <script> 在 app.js 之前）`,
    );
  }
  const appSource = codeOnly(readFileSync(APP_FILE, "utf8"));
  for (const name of ["statsRow", "percentText", "loadSummary", "renderSummary"]) {
    const stillDefined = new RegExp("^(?:async )?function " + name + "\\s*\\(", "m").test(appSource);
    assert.ok(!stillDefined, `app.js 里还定义着 ${name}——刀 A 之后它应在 quality-stats.js`);
  }
  const moduleSource = readFileSync(join(STATIC_DIR, "quality-stats.js"), "utf8");
  for (const name of ["statsRow", "percentText", "load", "render"]) {
    assert.ok(new RegExp("function " + name + "\\s*\\(").test(moduleSource), `quality-stats.js 里缺 ${name}`);
  }
  // 接口面只许有真调用者的三个：`render` 没有外部调用点（book §2 + Chief 第⑤条），不许导出
  const apiLine = /const api = \{([^}]*)\};/.exec(moduleSource);
  assert.ok(apiLine, "quality-stats.js 没找到 api 对象");
  assert.deepEqual(
    apiLine[1].split(",").map((x) => x.trim()).filter(Boolean),
    ["init", "load", "percentText"],
    "模块接口面多了/少了：render 没有真调用点就不许导出",
  );
});

test("域模块自检：有 allowQuerySelector 却不在白名单 ⇒ 红 / 白名单有名字却没这能力 ⇒ 红 / 空名单红", () => {
  const modules = [
    { file: "a.js" },
    { file: "b.js", allowQuerySelector: true },
  ];
  assert.deepEqual(
    querySelectorWhitelistProblems({ modules, whitelist: ["b.js"] }), [],
    "域模块白名单自检失败：合规的白名单被误报",
  );

  const smuggled = querySelectorWhitelistProblems({ modules, whitelist: [] });
  assert.ok(smuggled.some((m) => m.includes("b.js") && m.includes("不在白名单里")),
    `域模块白名单自检失败：登记了能力却没进白名单被放过——${smuggled.join("；")}`);

  const ghost = querySelectorWhitelistProblems({ modules, whitelist: ["b.js", "tool-x.js"] });
  assert.ok(ghost.some((m) => m.includes("tool-x.js") && m.includes("不是已登记的域模块")),
    `域模块白名单自检失败：白名单留了空壳名字被放过——${ghost.join("；")}`);

  const mismatch = querySelectorWhitelistProblems({ modules, whitelist: ["a.js", "b.js"] });
  assert.ok(mismatch.some((m) => m.includes("a.js") && m.includes("没有 allowQuerySelector")),
    `域模块白名单自检失败：白名单里的模块其实没这个能力被放过——${mismatch.join("；")}`);

  assert.ok(querySelectorWhitelistProblems({ modules, whitelist: [] }).some((m) => m.includes("空")),
    "域模块白名单自检失败：空名单被放过");
});

test("域模块登记完整性：挂了 window.X = api 的 static 文件必须登记在两张表之一", () => {
  const files = readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((fileName) => ({ fileName, source: readFileSync(join(STATIC_DIR, fileName), "utf8") }));
  const problems = moduleRegistrationProblems({ files, domainModules: DOMAIN_MODULES, nonDomainModules: NON_DOMAIN_MODULES });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("域模块登记完整性自检：没登记的模块红并点名 / 两张表同时登记红 / 视图按后缀排除 / 空列表红", () => {
  // 两张表各管各的：域模块进 DOMAIN，组件/工具进 NON_DOMAIN —— 这是合规的样子
  const domain = [{ file: "a.js" }];
  const nonDomain = [{ file: "b.js" }];
  const mod = (fileName, body) => [{ fileName, source: body }];

  assert.deepEqual(
    moduleRegistrationProblems({ files: mod("a.js", "window.A = api;\n"), domainModules: domain, nonDomainModules: nonDomain }), [],
    "登记完整性自检失败：两张表各登记一个的合规形态被误报",
  );

  const fake = moduleRegistrationProblems({
    files: mod("fake-module.js", "const api = {};\nwindow.Fake = api;\n"), domainModules: domain, nonDomainModules: nonDomain,
  });
  assert.ok(fake.some((m) => m.includes("fake-module.js") && m.includes("既不")),
    `登记完整性自检失败：没登记的模块被放过——${fake.join("；")}`);

  const both = moduleRegistrationProblems({
    files: [], domainModules: [{ file: "x.js" }], nonDomainModules: [{ file: "x.js" }],
  });
  assert.ok(both.some((m) => m.includes("x.js") && m.includes("互斥")),
    `登记完整性自检失败：同一模块在两张表里被放过——${both.join("；")}`);

  assert.deepEqual(
    moduleRegistrationProblems({ files: mod("pages-view.js", "window.PagesView = api;\n"), domainModules: [], nonDomainModules: [] }),
    [], "登记完整性自检失败：*-view.js 被算进这张表（视图归 R2/R3/R6/R7）",
  );

  const empty = moduleRegistrationProblems({ files: [], domainModules: domain, nonDomainModules: nonDomain });
  assert.ok(empty.some((m) => m.includes("空转")), "登记完整性自检失败：空列表被放过");
});

test("域模块（刀 B）：page-confirm.js 五个函数已从 app.js 迁出，接口面逐条对", () => {
  const appSource = codeOnly(readFileSync(APP_FILE, "utf8"));
  const moved = ["pageSetupStats", "firstUnfinishedPanel", "selectedSuggestions", "suggestionPagesByType", "warnUnconfirmed"];
  for (const name of moved) {
    assert.ok(
      !new RegExp("^(?:async )?function " + name + "\\s*\\(", "m").test(appSource),
      `app.js 里还定义着 ${name}——刀 B 之后它应在 page-confirm.js`,
    );
  }
  // 不进本刀的两个转发器与版面块的两个函数：必须还在 app.js
  for (const name of ["openPageSetup", "confirmAllUnconfirmed", "layoutBlockPageRecord", "highConfidenceCount"]) {
    assert.ok(
      new RegExp("^(?:async )?function " + name + "\\s*\\(", "m").test(appSource),
      `${name} 不在刀 B 的搬运范围（按归属判，不按段名）——它不该消失`,
    );
  }
  // 接口面**执行一遍**再断言（只读文本会漏"函数改名后 api 里挂了个 undefined"那种坏样本）
  const moduleSource = readFileSync(join(STATIC_DIR, "page-confirm.js"), "utf8");
  const sandbox = {
    console,
    window: {},
    document: { getElementById: () => null, createElement: () => ({}) },
  };
  sandbox.globalThis = sandbox;
  assert.doesNotThrow(
    () => vm.runInNewContext(moduleSource, sandbox, { filename: "page-confirm.js" }),
    "page-confirm.js 在自己的沙箱里执行就抛（改名的函数会让 api 对象里出现未定义标识符）",
  );
  const api = sandbox.window.PageConfirm;
  assert.ok(api && typeof api.init === "function", "page-confirm.js 没挂 window.PageConfirm.init");
  assert.deepEqual(
    Object.keys(api).sort(),
    ["firstUnfinishedPanel", "init", "pageSetupStats", "selectedSuggestions", "suggestionPagesByType", "warnUnconfirmed"].sort(),
    "page-confirm.js 接口面必须恰好是 init + 这五个函数（这五个都被 pages 注入调用）",
  );
  for (const [name, fn] of Object.entries(api)) {
    if (name === "init") continue;
    assert.equal(typeof fn, "function", `api.${name} 不是函数——改名/漏挂会在这里红`);
  }
});

test("域模块（刀 D）：structure-tools.js 七个函数已从 app.js 迁出，接口面逐条对", () => {
  const appSource = codeOnly(readFileSync(APP_FILE, "utf8"));
  const moved = [
    "structureRules", "previewHeaderFooter", "renderStructurePreview", "updateStructureApplyState",
    "applyHeaderFooter", "setupStructurePanel", "setAllStructureKeeps",
  ];
  for (const name of moved) {
    assert.ok(
      !new RegExp("^(?:async )?function " + name + "\\s*\\(", "m").test(appSource),
      `app.js 里还定义着 ${name}——刀 D 之后它应在 structure-tools.js`,
    );
  }
  // reset() 有两个真调用点（closeModal 关面板 / refreshProject 换项目）：它们是"这刀不是多余导出"的证据，
  // 谁把 reset 删了或把调用点搬走，这条会红。
  const resetCalls = (appSource.match(/window\.StructureTools\?\.reset\(\)/g) || []).length;
  assert.ok(resetCalls >= 2, `app.js 里 window.StructureTools?.reset() 只剩 ${resetCalls} 处——reset 的调用点不许悄悄消失`);

  // 接口面**执行一遍**再断言（只读文本会漏"函数改名后 api 里挂了个 undefined"）
  const moduleSource = readFileSync(join(STATIC_DIR, "structure-tools.js"), "utf8");
  const sandbox = {
    console,
    window: {},
    document: { getElementById: () => null, createElement: () => ({}) },
  };
  sandbox.globalThis = sandbox;
  assert.doesNotThrow(
    () => vm.runInNewContext(moduleSource, sandbox, { filename: "structure-tools.js" }),
    "structure-tools.js 在自己的沙箱里执行就抛（改名的函数会让 api 对象里出现未定义标识符）",
  );
  const api = sandbox.window.StructureTools;
  assert.ok(api && typeof api.init === "function", "structure-tools.js 没挂 window.StructureTools.init");
  assert.deepEqual(
    Object.keys(api).sort(),
    ["init", "setup", "preview", "apply", "setAllKeeps", "reset"].sort(),
    "接口面必须恰好是 init + setup/preview/apply/setAllKeeps/reset（reset 有真调用点，不是预留）",
  );
  for (const [name, fn] of Object.entries(api)) {
    if (name === "init") continue;
    assert.equal(typeof fn, "function", `api.${name} 不是函数——改名/漏挂会在这里红`);
  }
});

// ---------------------------------------------------------------- ① S1：一个 section 两个 owner

/** 归模块（S1 块编辑 / S2 框选新增块 / S3 版面确认；这张表是书 §2 的可机检形态）。 */
const EDITOR_IDS = [
  "detail-blocks", "block-position", "page-detail-error", "review-filter", "review-filter-note",
  "box-select-panel", "box-select-info", "box-select-text", "box-select-recognize",
  "box-select-confirm", "box-select-cancel", "box-select-status",
  "review-undo", "review-redo", "layout-panel", "layout-panel-status", "layout-confirm",
  "suggestion-apply-all",
  "aux-panel", "aux-summary", "aux-close", "aux-hint", "aux-lines", "aux-run", "detail-recognize",
  "ink-gap-bar", "ink-gap-text", "ink-gap-toggle", "box-select-rect", "detail-box-create",
];

/** 归外壳：同 subtree 里剩下的（S1 不搬）。两集必须不交、并集 == subtree 全部 id。 */
/** 归外壳：同 subtree 里剩下的（抽屉那刀之后 = 20）。三集两两不交、并集 == subtree 全部 id。 */
const SHELL_IDS = [
  "review-pager",
  "review-continuations",
  "review-banner",
  "detail-ink-gaps",
  "finish-open-review",
  "review-drawer-toggle",
  "review-more",
  "review-more-menu",
  "review-apply-all",
  "review-auto-pass",
  "review-auto-revoke",
  "review-footer-count",
  "detail-close",
  "review-confirm",
];

/** 归目录树（`review-tree.js`）：6 个，root = #review-tree，子树全归它（片 4）。 */
const TREE_IDS = [
  "review-tree",
  "review-tree-rail",
  "review-tree-stats",
  "review-tree-filter",
  "review-tree-scroll",
  "review-tree-list",
];

/** 归核心抽屉（`page-detail-drawer.js`）：21 个，按「谁写它」划，不按它在谁的 div 里。 */
const DRAWER_IDS = [
  "page-detail-title",
  "page-detail-meta",
  "review-prev",
  "review-page-no",
  "review-next",
  "review-jump",
  "review-jump-filter",
  "viewer-scroll",
  "detail-canvas",
  "detail-image",
  "detail-image-status",
  "detail-margin",
  "detail-lines",
  "detail-overlay",
  "detail-diff-layer",
  "zoom-in",
  "zoom-out",
  "zoom-fit",
  "toggle-overlay",
  "toggle-diff-marks",
  "review-margin-toggle",
];

/**
 * **一个 section 有 n 个 owner**（Chief 2026-11-02；抽屉那刀会把 #view-review 变成三个）。
 *
 * 旧判据写死了「两个 owner」：两集不交 + 并集 == 子树。三个 owner 时那套不成立，所以改成通用形式。
 * 五条判据（每支只红自己那条）：
 *   ① 两两不交——同一个 id 不许落在两个 owner 里；
 *   ② 并集 == 子树被引用 id 全集（两个方向都判：漏一个 / 多一个）；
 *   ③ 每个 owner 的文件里按 id 取的（part/el/querySelector/getElementById）⊆ **它自己**那张表；
 *   ④ 跨 owner class 写：模块不许 classList 改**别的 owner** 声明过的 class 前缀
 *      （要改就由 owner 自己提供 toggleCollapsed() 之类的方法）；
 *   ⑤ 落在子树里取 id 的文件，必须登记成某个 owner —— 多一个 owner 必须显式加，不能默认放行。
 *
 * `integrator: true` 的 owner（外壳 app.js）是**移交方**：它把元素交给模块、并清理自己的 DOM，
 * 所以 ③ 对它不成立（今天它引用 8 个 EDITOR id 正是移交点）。这条是数据里写明的性质，不是隐式豁免。
 */
export function sectionOwnerProblems({ owners, subtreeIds, modules }) {
  const problems = [];
  if (!owners || owners.length === 0) {
    problems.push("section 一个 owner 都没登记——空表让所有判据空转");
    return problems;
  }
  // ① 两两不交
  for (let i = 0; i < owners.length; i += 1) {
    for (let j = i + 1; j < owners.length; j += 1) {
      const right = new Set(owners[j].ids || []);
      for (const id of owners[i].ids || []) {
        if (right.has(id)) problems.push(`${id} 同时归属 ${owners[i].name} 与 ${owners[j].name}——一个 id 只能有一个 owner`);
      }
    }
  }
  // ② 并集 == 子树（两个方向）
  const union = new Set(owners.flatMap((owner) => owner.ids || []));
  for (const id of subtreeIds || []) {
    if (!union.has(id)) problems.push(`subtree 里的 ${id} 没有归属（${owners.length} 个 owner 都不认）`);
  }
  for (const id of union) {
    if (!(subtreeIds || []).includes(id)) problems.push(`归属表里的 ${id} 不在这个 section 的 subtree 里`);
  }
  // ③ 每个 owner 的文件里取 id ⊆ 自己的表
  const byFile = new Map((modules || []).map((mod) => [mod.fileName, mod.source]));
  for (const owner of owners) {
    if (owner.integrator) continue;   // 移交方：它把元素交给 owner，见函数头注释
    for (const fileName of owner.files || []) {
      const source = byFile.get(fileName);
      if (source === undefined) {
        problems.push(`${owner.name} 登记的文件 ${fileName} 读不到——这条判据对它空转`);
        continue;
      }
      for (const id of idRefsIn(source)) {
        if (!(subtreeIds || []).includes(id)) continue;   // 只判这个 section 的 id
        if ((owner.ids || []).includes(id)) continue;
        const other = owners.find((item) => item !== owner && (item.ids || []).includes(id));
        problems.push(`${fileName} 按 id 取了 ${id}，但它归 ${other ? other.name : "别的 owner"}——跨 owner 取 DOM 必须由 owner 提供方法`);
      }
    }
  }
  // ④ 跨 owner class 写
  for (const owner of owners) {
    if (owner.integrator) continue;
    for (const fileName of owner.files || []) {
      const source = byFile.get(fileName) || "";
      for (const token of classListTokens(source)) {
        const other = owners.find((item) => item !== owner
          && (item.classes || []).some((prefix) => token.startsWith(prefix)));
        if (other) {
          problems.push(`${fileName} 里 classList 改了 ${token}，那是 ${other.name} 的容器——`
            + "跨 owner 改 class 等于替别人管状态，应由 owner 自己提供 toggle 方法");
        }
      }
    }
  }
  // ⑤ 落在子树里取 id 的文件必须登记成 owner（多一个 owner 要显式加）
  const declaredFiles = new Set(owners.flatMap((owner) => owner.files || []));
  for (const { fileName, source } of modules || []) {
    const hits = idRefsIn(source || "").filter((id) => (subtreeIds || []).includes(id));
    if (hits.length === 0) continue;
    if (declaredFiles.has(fileName)) continue;
    problems.push(`${fileName} 取了这个 section 的 ${hits.length} 个 id（如 ${hits[0]}），但它不是已登记的 owner——`
      + "多一个 owner 必须显式加进归属表，不能默认放行");
  }
  return problems;
}

/** 源码里按 id 取 DOM 的四种写法：part("x") / el("x") / getElementById("x") / querySelector("#x")。 */
export function idRefsIn(source) {
  const found = new Set();
  for (const m of String(source || "").matchAll(/(?:part|el|getElementById)\("([^"]+)"\)/g)) found.add(m[1]);
  for (const m of String(source || "").matchAll(/querySelector\("#([^"]+)"\)/g)) found.add(m[1]);
  return [...found];
}

/** 源码里 classList.add/remove/toggle("token") 的 token 集合。 */
export function classListTokens(source) {
  const found = new Set();
  for (const m of String(source || "").matchAll(/classList\.(?:add|remove|toggle)\(\s*"([^"]+)"/g)) found.add(m[1]);
  return [...found];
}

/**
 * `#view-review` 的归属登记。**n 个 owner**：今天 2 个（EDITOR / SHELL），抽屉那刀落地后加第 3 个（DRAWER）。
 * 加 owner 必须在这张表里加一项——⑤ 会抓"有文件在碰这个 section 但没登记"。
 */
const SECTION_OWNERS = [
  {
    name: "EDITOR",
    ids: EDITOR_IDS,
    files: ["page-detail-editor.js"],
    // 这个 owner 的容器 class 前缀：别的模块 classList 改到它们 → ④ 红
    // `box--` **不在这张表里**：块框（`box--type-*` / `box--active`）由抽屉 createElement，
    // 而 editor 的选中高亮仍会 toggle `box--active`（既有跨写，本刀不重排）。
    // 两边都声明会让 ④ 互相误报 ⇒ 本刀把 `box--` 排除在 class 归属判据之外（不是放宽，是划清范围）。
    // **到期点 = 刀 12**（`tests/js/knife-registry.mjs`）：块框选中态改由抽屉的具名动作写之后，
    // 这一行连同上面的排除一起删，判据收回 `box--`。
    classes: ["review-block", "ink-gap"],
  },
  {
    name: "DRAWER",
    ids: DRAWER_IDS,
    files: ["page-detail-drawer.js"],
    // `box--` 暂不入表（跨写选中态）：到期点 = 刀 12，见下面 classes 那段说明
    classes: ["box__handle", "diff-mark", "line-box"],
  },
  {
    name: "TREE",
    ids: TREE_IDS,
    files: ["review-tree.js"],
    classes: ["review-tree__"],
  },
  {
    name: "SHELL",
    ids: SHELL_IDS,
    files: ["app.js"],
    // 外壳是**移交方**：boot 里把元素交给模块、并清理自己的 DOM（今天它引用 8 个 EDITOR id 正是移交点）
    integrator: true,
    classes: [],
  },
];

test("① S1：一个 section 有 n 个 owner——两两不交 · 并集 == subtree · 各自 id ⊆ 自己那张表 · 不漏登记", () => {
  const html = readFileSync(join(STATIC_DIR, "index.html"), "utf8");
  const start = html.indexOf('id="view-review"');
  const end = html.indexOf('id="view-reading"', start);
  const subtree = [...html.slice(start, end).matchAll(/id="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((id) => id !== "view-review");
  const modules = readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((fileName) => ({ fileName, source: readFileSync(join(STATIC_DIR, fileName), "utf8") }));
  const problems = sectionOwnerProblems({ owners: SECTION_OWNERS, subtreeIds: subtree, modules });
  assert.deepEqual(problems, [], problems.join("\n"));
  // 表本身自洽：owner 数 == 登记数（加 owner 必须改这张表，不能靠"没人查"）
  assert.equal(SECTION_OWNERS.length, 4,
    `#view-review 现在按 ${SECTION_OWNERS.length} 个 owner 判（editor / drawer / tree / shell）；少一张就是空表墓地`);

  // 模块里 el( / document.getElementById 仍须为 0（root.querySelector 是唯一取法）
  const moduleSource = readFileSync(join(STATIC_DIR, "page-detail-editor.js"), "utf8");
  const stripped = codeOnly(moduleSource);
  assert.equal((stripped.match(/\bel\s*\(/g) || []).length, 0, "page-detail-editor.js 里出现 el(");
  assert.equal((stripped.match(/document\.getElementById/g) || []).length, 0, "出现 document.getElementById");
  assert.equal((stripped.match(/document\.querySelector/g) || []).length, 0, "出现 document.querySelector");
});

test("① S1 自检（n=3）：挪 id 红① / 删 shell id 红② / 反向取 DOM 红③ / 改别人 class 红④ / 未登记模块红⑤", () => {
  const subtree = ["a", "b", "c", "d"];
  const owners = [
    { name: "EDITOR", ids: ["a", "b"], files: ["editor.js"], classes: ["editor-"] },
    { name: "DRAWER", ids: ["c"], files: ["drawer.js"], classes: ["drawer-"] },
    { name: "SHELL", ids: ["d"], files: ["app.js"], integrator: true, classes: [] },
  ];
  const modules = [
    { fileName: "editor.js", source: 'part("a");' },
    { fileName: "drawer.js", source: 'part("c");' },
    { fileName: "app.js", source: 'el("d");' },
  ];
  const run = (own = owners, mods = modules, ids = subtree) => sectionOwnerProblems({ owners: own, subtreeIds: ids, modules: mods });
  assert.deepEqual(run(), [], `三 owner 的合规形态被误报——${run().join("；")}`);

  // ① 同一个 id 落两个 owner
  assert.ok(run([owners[0], { ...owners[1], ids: ["c", "b"] }, owners[2]])
    .some((m) => m.includes("同时归属")), "同一 id 落两个 owner 没红");

  // ② 删掉一个 shell id ⇒ 并集 != 子树
  assert.ok(run([owners[0], owners[1], { ...owners[2], ids: [] }])
    .some((m) => m.includes("没有归属")), "subtree 里的 id 没人认没红");

  // ③ editor 反向取 drawer 的 id
  assert.ok(run(owners, modules.map((m) => (m.fileName === "editor.js" ? { ...m, source: 'part("c");' } : m)))
    .some((m) => m.includes("归 DRAWER")), "editor 取了 drawer 的 id 没红");

  // ④ editor 改 drawer 的容器 class
  assert.ok(run(owners, modules.map((m) => (m.fileName === "editor.js" ? { ...m, source: 'el.classList.toggle("drawer-collapsed", on);' } : m)))
    .some((m) => m.includes("drawer-collapsed")), "跨 owner 改 class 没红");

  // ⑤ 多一个模块碰这个 section 却没登记
  assert.ok(run(owners, [...modules, { fileName: "sneaky.js", source: 'part("a");' }])
    .some((m) => m.includes("sneaky.js")), "未登记 owner 没红");

  // 空 owner 表：判据不能空转
  assert.ok(run([], modules).some((m) => m.includes("空转")), "空 owner 表被放过");
});

/** 模块喊外壳的名字必须是注入键：裸写一个 app.js 顶层函数名就是"谁都能喊一下"的入口。 */
function godDoorProblems({ moduleSource, appSource, injectedKeys, ownExposes = null }) {
  const stripped = codeOnly(moduleSource).replace(/\binjected\.[A-Za-z_$][\w$]*/g, "injected.X");
  const topLevel = new Set([...codeOnly(appSource).matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const problems = [];
  for (const name of topLevel) {
    if (new RegExp(`(?:^|[^\\w.$])${name}\\s*\\(`, "m").test(stripped)) {
      problems.push(`模块里裸调了外壳函数 ${name}——要么注入，要么搬进来`);
    }
  }
  const declared = new Set(injectedKeys);
  for (const m of codeOnly(moduleSource).matchAll(/injected\.([A-Za-z_$][\w$]*)/g)) {
    if (!declared.has(m[1])) problems.push(`模块用了 injected.${m[1]}，但 boot 没注入`);
  }
  // **跨模块直呼也是神入口**（Architect 2026-11-02 自核发现）：原来只查"裸调外壳函数"与"injected 未注入"，
  // 所以模块里写 `window.PagesView?.onAuxReviewFinished()` 这一类既不算裸调、也不在注入面上，闸看不见。
  // 片 2 的 buildLabel 注入边界要拿这条当判据。
  // 只认**调用/取值位**（`window.X?.` / `window.X.`），并且排掉模块自己的 `window.<自己的名字> = api;`
  for (const hit of codeOnly(moduleSource).matchAll(/window\.([A-Z][A-Za-z0-9_$]*)\s*(?:\?\.|\.)/g)) {
    if (ownExposes && hit[1] === ownExposes) continue;
    problems.push(`模块里直接喊了 window.${hit[1]}——跨模块调用必须走注入，不许绕开外壳`);
  }
  // loadPageDetail 是"已有动作"（patchBlock / reviewAction 用它刷新本页），允许；
  // 抽屉的 renderPageDetail 与块列表的 renderReviewBlocks 不许反向喊——否则编辑→重画多出第二条路。
  for (const forbidden of ["renderPageDetail", "renderReviewBlocks"]) {
    if (new RegExp(`injected\\.${forbidden}\\b`).test(moduleSource)) {
      problems.push(`模块反向调了 injected.${forbidden}——编辑→重画只许经 renderBlocks / 已有动作`);
    }
  }
  return problems;
}

test("① S1：模块喊外壳的名字 ⊆ 注入键（神入口判据）", () => {
  const moduleSource = readFileSync(join(STATIC_DIR, "page-detail-editor.js"), "utf8");
  const appSource = readFileSync(APP_FILE, "utf8");
  const boot = appSource.slice(appSource.indexOf("window.PageDetailEditor?.init({"));
  const injectedKeys = [...boot.slice(0, boot.indexOf("\n  });")).matchAll(/^    ([A-Za-z_$][\w$]*)[:,]/gm)].map((m) => m[1]);
  assert.ok(injectedKeys.length > 0, "boot 里没找到 PageDetailEditor 的 init 块");
  assert.deepEqual(
    godDoorProblems({ moduleSource, appSource, injectedKeys, ownExposes: "PageDetailEditor" }), [],
    "模块里出现了不在注入面里的外壳名字",
  );
});

test("① S1 自检：裸调外壳函数 / 用未注入的键 / 反向重画，都必须红", () => {
  const appSource = "function renderReviewBlocks() {}\nfunction loadPageDetail() {}\n";
  assert.deepEqual(godDoorProblems({ moduleSource: 'injected.loadPageDetail();', appSource, injectedKeys: ["loadPageDetail"] }), []);
  assert.equal(godDoorProblems({ moduleSource: 'renderReviewBlocks();', appSource, injectedKeys: [] }).length >= 1, true, "裸调必须红");
  assert.equal(godDoorProblems({ moduleSource: 'injected.noSuchKey();', appSource, injectedKeys: [] }).length, 1, "未注入必须红");
  assert.equal(godDoorProblems({ moduleSource: 'injected.renderPageDetail();', appSource, injectedKeys: ["renderPageDetail"] }).length, 1, "反向重画必须红");
  // 跨模块直呼：既不是裸调外壳函数、也不在注入面 ⇒ 旧判据完全看不见
  const crossModule = godDoorProblems({ moduleSource: 'window.PagesView?.onAuxReviewFinished();', appSource, injectedKeys: [] });
  assert.ok(crossModule.some((m) => m.includes("window.PagesView") && m.includes("跨模块")),
    `跨模块直呼 window.PagesView 没被抓住——${crossModule.join("；")}`);
});

// ---------------------------------------------------------------- ① S3：导出面 + 注入面收口

/**
 * **导出的每个成员都必须有外壳调用点**（§1 ⑦：导出 = 有人喊）。
 *
 * 这条是从两次实际缺陷倒推出来的：S2 的 `setupBoxCreate`（只有 init 自己在 wired 守卫里调）、
 * S1 的 `showError` / `openBoxCreate` / `cancelBoxCreate`（只有模块内部用）都挂在了导出面上，
 * 而"没有调用点的导出"按定义就是**预留**——没有判据盯着，就会越挂越多。
 */
function exportCallSiteProblems({ apiKeys, appSource }) {
  const problems = [];
  const src = codeOnly(appSource);
  for (const key of apiKeys) {
    if (!new RegExp(`PageDetailEditor\\?\\.${key}\\s*\\(`).test(src)) {
      problems.push(`api.${key} 在 app.js 里一次都没被调用——没有调用点的导出就是"预留"（§1 ⑦）`);
    }
  }
  return problems;
}

/** boot 注入了、模块却一次都没读的键：死注入（传了没人用，读代码的人会被它骗）。 */
function deadInjectionProblems({ moduleSource, injectedKeys }) {
  const stripped = codeOnly(moduleSource);
  const problems = [];
  for (const key of injectedKeys) {
    if (!new RegExp(`injected\\.${key}\\b`).test(stripped)) {
      problems.push(`boot 注入了 ${key}，模块一次都没读——死注入`);
    }
  }
  return problems;
}

/** init 里的接线必须全在 `if (wired) return api;` 之后（重复 init 不许重复绑）。 */
function initWiringProblems({ moduleSource }) {
  const problems = [];
  const start = moduleSource.indexOf("function init(deps)");
  const end = moduleSource.indexOf("const api = {");
  if (start < 0 || end < 0 || end <= start) return ["找不到 init 与 api 的边界，这条判据在空转"];
  const body = moduleSource.slice(start, end);
  const guard = body.indexOf("if (wired) return api;");
  if (guard < 0) problems.push("init 里没有 wired 守卫——重复 init 会重复绑监听");
  const firstBind = body.search(/\bbind\(/);
  if (firstBind >= 0 && (guard < 0 || firstBind < guard)) {
    problems.push("init 的接线跑在 wired 守卫之前——重复 init 会重复绑");
  }
  return problems;
}

/** 沙箱里执行一遍模块拿真实导出面（只读文本会漏"函数改名后 api 里挂了个 undefined"）。 */
function editorApiKeys(moduleSource) {
  const sandbox = { console, window: {}, document: { createElement: () => ({}) } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(moduleSource, sandbox, { filename: "page-detail-editor.js" });
  const api = sandbox.window.PageDetailEditor;
  assert.ok(api && typeof api.init === "function", "page-detail-editor.js 没挂 window.PageDetailEditor.init");
  return Object.keys(api);
}

test("S3：三个函数已不在 app.js；模块导出面每个都有外壳调用点（§1 ⑦）", () => {
  const appSource = readFileSync(APP_FILE, "utf8");
  const moduleSource = readFileSync(join(STATIC_DIR, "page-detail-editor.js"), "utf8");
  for (const name of ["renderSuggestionTools", "renderLayoutPanel", "confirmPageLayout"]) {
    assert.ok(
      !new RegExp(`^(?:async )?function ${name}\\s*\\(`, "m").test(appSource),
      `app.js 里还定义着 ${name}——S3 之后它应在 page-detail-editor.js`,
    );
  }
  const apiKeys = editorApiKeys(moduleSource);
  for (const name of ["renderSuggestionTools", "renderLayoutPanel"]) {
    assert.ok(apiKeys.includes(name), `S3 的渲染入口 ${name} 没导出（renderPageDetail 喊不到它）`);
  }
  // confirmPageLayout 的唯一调用点是模块 init 自己接的 `layout-confirm` 按钮 ⇒ 私有，不进导出面
  assert.ok(!apiKeys.includes("confirmPageLayout"), "confirmPageLayout 不许导出——它的唯一调用点在模块内部");
  for (const name of ["setupBoxCreate", "showError", "openBoxCreate", "cancelBoxCreate"]) {
    assert.ok(!apiKeys.includes(name), `${name} 没有外壳调用点，不该挂在导出面上（§1 ⑦）`);
  }
  const problems = exportCallSiteProblems({ apiKeys, appSource });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("S3：boot 注入的每个键模块都真的读（死注入 = 传了没人用）", () => {
  const appSource = readFileSync(APP_FILE, "utf8");
  const moduleSource = readFileSync(join(STATIC_DIR, "page-detail-editor.js"), "utf8");
  const boot = appSource.slice(appSource.indexOf("window.PageDetailEditor?.init({"));
  const injectedKeys = [...boot.slice(0, boot.indexOf("\n  });")).matchAll(/^    ([A-Za-z_$][\w$]*)[:,]/gm)].map((m) => m[1]);
  assert.ok(injectedKeys.length > 0, "boot 里没找到 PageDetailEditor 的 init 块");
  const problems = deadInjectionProblems({ moduleSource, injectedKeys });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("剥离口径自检：正则字面量后面的注释必须被剥，注释不许顶替代码，字符串里的 // 不算注释", () => {
  // 2026-11-02 修的真 bug：`/[&<>"']/g` 里的 `"` 让"只认字符串"的状态机进了字符串态，
  // 它后面的整行 `//` 注释就不再被剥。两个方向同时出错：
  //   "必须为 0" 的判据 → 注释里提一句就假红；"必须出现" 的判据 → 注释里写一句就假绿（更危险）。
  const tricky = 'const re = /[&<>"\']/g; // fake() 只是注释\nconst keep = 1;\n';

  // ① 正则字面量后面的注释必须剥掉，代码必须留着
  const stripped = codeOnly(tricky);
  assert.ok(!stripped.includes("fake()"), "正则字面量后面的注释没被剥——后面的判据全都读得到注释");
  assert.ok(stripped.includes("const keep = 1;"), "代码被误删——剥多了会让活引用变成死引用（假红）");

  // ② 注释里写调用点 ⇒ 不许满足"每个导出都有调用点"
  const commentedCall = exportCallSiteProblems({
    apiKeys: ["openAuxWarning"],
    appSource: 'const re = /[&<>"\']/g; // window.PageDetailEditor?.openAuxWarning();\n',
  });
  assert.equal(commentedCall.length, 1,
    "注释里的调用点被当成真调用点——没人喊的导出会因此静默过关");

  // ③ 注释里写注入键 ⇒ 不许满足"注入键被读过"
  const commentedRead = deadInjectionProblems({
    moduleSource: 'const re = /[&<>"\']/g; // injected.deadKey 只是注释\nfunction f() { return 1; }\n',
    injectedKeys: ["deadKey"],
  });
  assert.equal(commentedRead.length, 1, "注释里的 injected.deadKey 被当成读过了——真死注入一句注释就能混过闸");

  // ④ 字符串里的 // 不是注释，字符串内容必须原样保留
  const url = codeOnly('const url = "https://example.com/x"; // 真注释\nconst after = 2;\n');
  assert.ok(url.includes('"https://example.com/x"'), "字符串里的 // 被当成注释截断了——调用文本会丢");
  assert.ok(!url.includes("真注释"), "行尾的真注释没被剥掉");
  assert.ok(url.includes("const after = 2;"), "剥注释时吃掉了下一行");
});

test("S3：init 的接线都在 wired 守卫之后（重复 init 不重复绑）", () => {
  const moduleSource = readFileSync(join(STATIC_DIR, "page-detail-editor.js"), "utf8");
  assert.deepEqual(initWiringProblems({ moduleSource }), []);
});

test("S3 自检：无人喊的导出 / 死注入 / 守卫外接线，都必须红", () => {
  const app = "window.PageDetailEditor?.init({});\nwindow.PageDetailEditor?.a();\n";
  assert.deepEqual(exportCallSiteProblems({ apiKeys: ["init", "a"], appSource: app }), []);
  assert.equal(exportCallSiteProblems({ apiKeys: ["a", "b"], appSource: app }).length, 1, "没人喊的导出必须红");
  assert.equal(exportCallSiteProblems({ apiKeys: ["a"], appSource: "// PageDetailEditor?.a()\n" }).length, 1,
    "只有注释里出现不算调用点");

  const mod = "function f() { injected.used(); }\n";
  assert.deepEqual(deadInjectionProblems({ moduleSource: mod, injectedKeys: ["used"] }), []);
  assert.equal(deadInjectionProblems({ moduleSource: mod, injectedKeys: ["unused"] }).length, 1, "死注入必须红");

  const good = "function init(deps) { if (wired) return api; bind('x', f); }\nconst api = { init };\n";
  assert.deepEqual(initWiringProblems({ moduleSource: good }), []);
  const bad = "function init(deps) { bind('x', f); if (wired) return api; }\nconst api = { init };\n";
  assert.equal(initWiringProblems({ moduleSource: bad }).length, 1, "守卫外的接线必须红");
  const noGuard = "function init(deps) { bind('x', f); }\nconst api = { init };\n";
  assert.equal(initWiringProblems({ moduleSource: noGuard }).length, 2, "没有守卫必须红（接线位置 + 缺守卫）");
});

// ---------------------------------------------------------------- ① S4：第二引擎复核收口

/**
 * **子树外的 id 只许经注入拿节点**（书 §12.3）。
 *
 * `aux-warning-*` 五个在 `#view-review` 之外的模态框里（全屏遮罩，挪进子树会改 z-index 栈）。
 * 模块里出现这五个字符串就等于"又按 id 找 DOM"，而 id 归属闸只认得子树里的 id，看不见它们。
 */
const AUX_OUTSIDE_IDS = [
  "aux-warning-mask", "aux-warning-title", "aux-warning-text",
  "aux-warning-wait", "aux-warning-error",
];

function outsideIdProblems({ moduleSource, ids = AUX_OUTSIDE_IDS }) {
  const stripped = codeOnly(moduleSource);
  return ids
    .filter((id) => stripped.includes(id))
    .map((id) => `模块里出现了子树外的 id ${id}——它只能经注入拿节点`);
}

test("S4：第二引擎复核 6 函数已不在 app.js；遮罩 id 不进模块；死状态 auxData 已删", () => {
  const appSource = readFileSync(APP_FILE, "utf8");
  const moduleSource = readFileSync(join(STATIC_DIR, "page-detail-editor.js"), "utf8");
  for (const name of [
    "activeAuxJob", "openAuxWarning", "waitForAuxThenReview",
    "runAuxiliary", "renderAuxiliary", "setupAuxControls",
  ]) {
    assert.ok(
      !new RegExp(`^(?:async )?function ${name}\\s*\\(`, "m").test(appSource),
      `app.js 里还定义着 ${name}——S4 之后它应在 page-detail-editor.js`,
    );
  }
  const idProblems = outsideIdProblems({ moduleSource });
  assert.deepEqual(idProblems, [], idProblems.join("\n"));
  // 死状态：auxData 两处写在 S4 一并删掉，两个文件都不许再有（零读的"状态"是噪音）
  const appCode = codeOnly(appSource);
  const moduleCode = codeOnly(moduleSource);
  assert.equal(/\bauxData\b/.test(appCode), false, "app.js 里还有 auxData——死状态该删");
  assert.equal(/\bauxData\b/.test(moduleCode), false, "模块里不许接一份 auxData");
  // auxWarningWaitToken 搬家：外壳 0 次、模块里仍是模块级 let（不是"顺手弄丢了"）
  assert.equal(/\bauxWarningWaitToken\b/.test(appCode), false, "app.js 里还有 auxWarningWaitToken");
  assert.ok(
    /let auxWarningWaitToken = 0;/.test(moduleCode),
    "模块里没有 auxWarningWaitToken 的声明——它该随 waitForAuxThenReview 搬进来",
  );
});

test("S4：导出面只多一个 openAuxWarning，其余五个与 adoptLine 都私有", () => {
  const moduleSource = readFileSync(join(STATIC_DIR, "page-detail-editor.js"), "utf8");
  const appSource = readFileSync(APP_FILE, "utf8");
  const apiKeys = editorApiKeys(moduleSource);
  assert.ok(apiKeys.includes("openAuxWarning"), "goToWorkflowStep 喊不到 openAuxWarning");
  for (const name of [
    "runAuxiliary", "renderAuxiliary", "activeAuxJob",
    "setupAuxControls", "waitForAuxThenReview", "adoptLine",
  ]) {
    assert.ok(!apiKeys.includes(name), `${name} 没有外壳调用点，不该在导出面（§1 ⑦）`);
  }
  assert.deepEqual(exportCallSiteProblems({ apiKeys, appSource }), []);
});

test("S4 自检：遮罩 id 写进模块必须红；注释里提到不算；无调用点的导出必须红", () => {
  assert.deepEqual(outsideIdProblems({ moduleSource: "const x = injected.getAuxWarningEls();" }), []);
  assert.equal(outsideIdProblems({ moduleSource: 'part("aux-warning-text");' }).length, 1, "子树外 id 必须红");
  assert.equal(
    outsideIdProblems({ moduleSource: "// aux-warning-mask 只是注释里提到" }).length, 0,
    "剥注释口径：注释里提到不算按 id 找 DOM",
  );
  const app = "window.PageDetailEditor?.init({});\nwindow.PageDetailEditor?.a();\n";
  assert.equal(exportCallSiteProblems({ apiKeys: ["a", "b"], appSource: app }).length, 1);
});

// ---------------------------------------------------------------- 片 2 笔 A：审校差异层与布局调度器解耦

/**
 * **笔 A 的判据**：共享调度器（块框用）不许再碰审校的差异层；审校那条自带 `drawDiffLayer`。
 *
 * 为什么不再只是"代码好看"：`scheduleOverlayLayout` 成功帧里那句 `drawDiffLayer()` 让
 * **页面视图每画一页瓦片的块框**都去重画一次审校的差异层（书 §3.1，Architect 更正过：多余重画
 * 来自这条链，不是 `observeOverlaySize` 的调用面——它有两个调用点，瓦片与审校各一）。
 */
test("① 抽屉回路唯一：onPageDetailChanged 全仓恰好 1 处调用 · 导出面没有 renderBlocks · editor 不反向调", () => {
  const drawer = codeOnly(readFileSync(join(STATIC_DIR, "page-detail-drawer.js"), "utf8"));
  const editor = codeOnly(readFileSync(join(STATIC_DIR, "page-detail-editor.js"), "utf8"));
  const app = codeOnly(readFileSync(APP_FILE, "utf8"));
  const problems = [];
  // 回路四条精确判据（数"出现几次"会被注入行的一行两命中骗到，所以逐条查）
  const decl = (app.match(/^function onPageDetailChanged\(/gm) || []).length;
  const wire = (app.match(/^\s+onPageDetailChanged: \(data\) => onPageDetailChanged\(data\),/gm) || []).length;
  const call = (drawer.match(/await injected\.onPageDetailChanged\(data\)/g) || []).length;
  if (decl !== 1) problems.push(`外壳里 onPageDetailChanged 的声明是 ${decl} 处（应为 1）`);
  if (wire !== 1) problems.push(`外壳递给模块的那行接线是 ${wire} 处（应为 1）`);
  if (call !== 1) problems.push(`抽屉里那一次回路调用是 ${call} 处（应为 1）——多一处就会互相触发`);
  if (/injected\.onPageDetailChanged/.test(app) || /injected\.onPageDetailChanged/.test(editor)) {
    problems.push("外壳或 editor 里也调了 injected.onPageDetailChanged——那就是第二条调用点");
  }
  if (!/await injected\.onPageDetailChanged\(data\)/.test(drawer)) {
    problems.push("抽屉里没有那一次 await injected.onPageDetailChanged(data)——blocks 交不出去");
  }
  if (/injected\.(renderBlocks|renderPageDetail)\b/.test(drawer)) {
    problems.push("抽屉里出现 renderBlocks / renderPageDetail——它只许喊 onPageDetailChanged");
  }
  if (/injected\.onPageDetailChanged|injected\.renderPageDetail/.test(editor)) {
    problems.push("editor 里出现反向入口（onPageDetailChanged / renderPageDetail）——会形成第二条回路");
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

function detailSplitProblems({ code }) {
  const problems = [];
  // 迁移窗口里共享调度器还在 app.js（只许 0 次 drawDiffLayer）；2.2 之后它整段消失，
  // 排帧全归 registry 的 schedule —— 两种形态都合法，但审校那条细节必须是 1 次。
  const shared = functionBody(code, "scheduleOverlayLayout");
  const detail = functionBody(code, "scheduleDetailOverlayLayout");
  if (!detail) {
    problems.push("app.js 里没有 scheduleDetailOverlayLayout——审校那条路径没人排帧了");
    return problems;
  }
  const diffIn = (body) => (body.match(/drawDiffLayer\s*\(/g) || []).length;
  if (shared && diffIn(shared) !== 0) {
    problems.push("共享调度器还在调 drawDiffLayer——瓦片布局又会去重画审校差异层");
  }

  if (diffIn(detail) !== 1) {
    problems.push(`审校调度器成功帧必须调一次 drawDiffLayer（现在 ${diffIn(detail)} 次）——漏了差异层不重画`);
  }
  const onDetail = (name) => (code.match(new RegExp(`${name}\\(\\s*el\\("detail-overlay"\\)\\s*\\)`, "g")) || []).length;
  const detailCalls = onDetail("scheduleDetailOverlayLayout");
  const sharedCalls = onDetail("scheduleOverlayLayout");
  if (detailCalls !== 3) {
    problems.push(`审校三处显式调用（applyZoom / setReviewOverlay / toggle-overlay）应各有 1 处 detail 版，现在 ${detailCalls} 处`);
  }
  if (sharedCalls !== 0) problems.push(`还有 ${sharedCalls} 处审校调用点挂在共享调度器上`);
  const drawDetail = functionBody(code, "drawDetailOverlay");
  if (!drawDetail) problems.push("app.js 里没有 drawDetailOverlay");
  else if (!/scheduleDetailOverlayLayout\(overlay\)/.test(drawDetail)) {
    problems.push("drawDetailOverlay 尾部还在用共享调度器——切页后差异层不会重画");
  }
  // 观察器那一路不在这里判：片 2 笔 B 把 ResizeObserver 收进 registry 的 schedule（自观察），
  // 迁移期间本文件里两种形态都合法。笔 B 的闸在下面按 registry 侧单独判。
  return problems;
}

test("片 2 笔 A：共享调度器 0 次 drawDiffLayer · 审校调度器 1 次 · 审校调用点全走 detail 版", () => {
  // 常态：审校那三处 drawDiffLayer 调用在抽屉模块里、共享/审校调度器定义在 registry，
  // 一条判据要同时看两个文件 ⇒ 合查（不是放宽：判据强度不变，只换取源）。
  const drawerPath = join(STATIC_DIR, "page-detail-drawer.js");
  let code = codeOnly(readFileSync(APP_FILE, "utf8"));
  try {
    // 抽屉经注入调（`injected.scheduleDetailOverlayLayout(...)`）⇒ 归一化成同一个名字再喂判据
    code += "\n" + codeOnly(readFileSync(drawerPath, "utf8"))
      .replace(/injected\.(scheduleDetailOverlayLayout|drawDiffLayer)/g, "$1")
      // 抽屉用 part() 取代 el()，判据的正则写的是 el("detail-overlay") ⇒ 归一化
      .replace(/part\("detail-overlay"\)/g, 'el("detail-overlay")');
  } catch { /* 模块还没落盘 */ }
  const problems = detailSplitProblems({ code });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("片 2 笔 A 自检：放回共享版 / 删掉审校版那行 / 审校调用点留在共享版 / 观察器不分派，都必须红", () => {
  const sample = (opts = {}) => {
    const sharedDiff = opts.sharedDiff ? "drawDiffLayer();" : "";
    const detailDiff = opts.detailDiff === false ? "" : "drawDiffLayer();";
    const third = opts.thirdShared ? 'scheduleOverlayLayout(el("detail-overlay"));' : 'scheduleDetailOverlayLayout(el("detail-overlay"));';
    const drawTail = opts.drawUsesShared ? "scheduleOverlayLayout(overlay);" : "scheduleDetailOverlayLayout(overlay);";
    return `
function scheduleOverlayLayout(overlay, attempt = 0) {
  requestAnimationFrame(() => { if (layoutOverlayAnnotations(overlay)) { ${sharedDiff} return; } });
}
function scheduleDetailOverlayLayout(overlay, attempt = 0) {
  requestAnimationFrame(() => { if (layoutOverlayAnnotations(overlay)) { ${detailDiff} return; } });
}
scheduleDetailOverlayLayout(el("detail-overlay"));
scheduleDetailOverlayLayout(el("detail-overlay"));
${third}
function drawDetailOverlay(blocks) { ${drawTail} }
`;
  };
  assert.deepEqual(detailSplitProblems({ code: sample() }), [], "合规样本被判红");
  for (const [opts, why] of [
    [{ sharedDiff: true }, "共享调度器调 drawDiffLayer 必须红"],
    [{ detailDiff: false }, "审校调度器不调 drawDiffLayer 必须红"],
    [{ thirdShared: true }, "审校调用点留在共享版必须红"],
    [{ drawUsesShared: true }, "drawDetailOverlay 尾部用共享版必须红"],
  ]) {
    assert.ok(detailSplitProblems({ code: sample(opts) }).length >= 1, why);
  }
});

// ---------------------------------------------------------------- 片 2 笔 B：避让链搬进 registry

/**
 * **避让数学全仓只许一份，且只许在 `overlay-registry.js`**（契约 §1 / 书 §3.3）。
 *
 * 迁移窗口里 app.js 允许留 ≤6 行的转发器（reading / index 还没迁）——
 * 转发器长过 6 行就说明"真实现"又长回去了，那正是这一条要抓的。
 */
function layoutMathProblems({ appCode, registryCode }) {
  const problems = [];
  for (const name of ["findOrderSpot", "findLabelSpot", "pxRect", "rectsOverlap"]) {
    if (new RegExp(`^function ${name}\\s*\\(`, "m").test(appCode)) {
      problems.push(`app.js 里还在定义 ${name}——避让数学只许在 overlay-registry.js`);
    }
    if (!functionBody(registryCode, name)) problems.push(`registry 里没有 ${name}——算法没搬全`);
  }
  for (const name of ["layoutOverlayAnnotations", "scheduleOverlayLayout"]) {
    // 2.2 落完之后这两个转发器必须彻底消失：reading / index 都走 registry 了，留着就是第二条路。
    if (functionBody(appCode, name)) {
      problems.push(`app.js 里还有 ${name} 的转发器——2.2 之后它该整段消失`);
    }
  }
  // 重试循环只有一份：app.js 0 次，registry 恰好 1 次
  const appRetries = (appCode.match(/attempt < 90/g) || []).length;
  const regRetries = (registryCode.match(/attempt < 90/g) || []).length;
  if (appRetries !== 0) problems.push(`app.js 里还有 ${appRetries} 处重试循环——排帧只许 registry 一份`);
  if (regRetries !== 1) problems.push(`registry 里的重试循环是 ${regRetries} 处，应恰好 1 处`);
  return problems;
}

test("片 2 笔 B：避让数学只在 overlay-registry.js（app.js 只剩 ≤6 行转发器）", () => {
  const appCode = codeOnly(readFileSync(APP_FILE, "utf8"));
  const registryCode = codeOnly(readFileSync(join(STATIC_DIR, "overlay-registry.js"), "utf8"));
  const problems = layoutMathProblems({ appCode, registryCode });
  assert.deepEqual(problems, [], problems.join("\n"));
});

/**
 * **registry 的 `layout` / `schedule` 分工**（契约 §API · 书 §3.3）：
 * layout = 一次摆（不排帧、不画、不碰 version）；schedule = 唯一重试 + 尺寸观察 + 成功回调一次。
 */
function registryApiProblems({ registryCode }) {
  const problems = [];
  const layoutBody = functionBody(registryCode, "layout");
  const scheduleBody = functionBody(registryCode, "schedule");
  const stepBody = functionBody(registryCode, "stepSchedule");
  const observeBody = functionBody(registryCode, "rememberLayout");
  if (!layoutBody) problems.push("registry 里没有 layout");
  else {
    for (const [needle, why] of [
      ["requestAnimationFrame", "layout 里出现了排帧"],
      ["drawDiffLayer", "layout 里出现了绘制"],
      ["version", "layout 里碰了 version"],
    ]) {
      if (new RegExp(needle).test(layoutBody)) problems.push(why);
    }
    if (!/boxesIn\(/.test(layoutBody)) problems.push("layout 没有遍历容器里的块框");
  }
  if (!scheduleBody) problems.push("registry 里没有 schedule");
  else {
    if (!/layoutTokens/.test(scheduleBody)) problems.push("schedule 没有 token 机制（同一容器会同时排两次）");
    if (!/rememberLayout/.test(scheduleBody)) problems.push("schedule 没有接尺寸观察");
  }
  if (!stepBody) problems.push("registry 里没有 stepSchedule");
  else {
    if (!/onLaidOut/.test(stepBody)) problems.push("stepSchedule 没有 onLaidOut（审校那条路径不会重画差异层）");
    if (!/attempt < 90/.test(stepBody)) problems.push("stepSchedule 没有 90 帧上限");
  }
  if (!observeBody || !/ResizeObserver/.test(observeBody)) problems.push("rememberLayout 没有 ResizeObserver");
  const apiLine = /const api = \{([^}]*)\}/.exec(registryCode);
  if (!apiLine) problems.push("registry 里找不到 api 对象");
  else if (!/\blayout\b/.test(apiLine[1]) || !/\bschedule\b/.test(apiLine[1])) {
    problems.push("api 里没有登记 layout / schedule（STABLE 两条）");
  }
  return problems;
}

test("片 2 笔 B：layout 只摆不排帧 / schedule 是唯一重试且带尺寸观察 / 两条都导出", () => {
  const registryCode = codeOnly(readFileSync(join(STATIC_DIR, "overlay-registry.js"), "utf8"));
  const problems = registryApiProblems({ registryCode });
  assert.deepEqual(problems, [], problems.join("\n"));
});

/**
 * **容器 class 的唯一写点 = registry**（书 §2.1 (a)）。
 *
 * `index-view` / `reading-view` 还在自己拼容器，2.2 迁完从这张白名单里删——
 * 白名单里出现"其实已经没有这个字符串"的文件也要红（防白名单留空壳）。
 */
const OVERLAY_CLASS_PENDING = [];

function overlayClassProblems({ files, pending = OVERLAY_CLASS_PENDING }) {
  const problems = [];
  const seen = new Set();
  for (const { fileName, source } of files) {
    if (fileName === "overlay-registry.js" || /-view\.js$/.test(fileName) === false) {
      // 非视图模块（app.js / 其它服务）：一处都不许有
      if (fileName !== "overlay-registry.js" && /page-overlay--(margin|labeled)/.test(source)) {
        problems.push(`${fileName} 里还在写 page-overlay--margin/--labeled——class 由 styles 决定`);
      }
      continue;
    }
    if (!/page-overlay--(margin|labeled)/.test(source)) continue;
    if (!pending.includes(fileName)) {
      problems.push(`${fileName} 里写了 page-overlay--margin/--labeled，但不在迁移白名单里`);
    } else {
      seen.add(fileName);
    }
  }
  void seen;
  return problems;
}

test("片 2 笔 B：page-overlay--margin / --labeled 的写入只在 registry（class 归 styles）", () => {
  const files = readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((fileName) => ({ fileName, source: codeOnly(readFileSync(join(STATIC_DIR, fileName), "utf8")) }));
  const problems = overlayClassProblems({ files });
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("片 2 笔 B 自检：app.js 长出真实现 / 转发器复活 / 重试循环两份 / layout 排帧 / class 写错地方，都必须红", () => {
  // 2.2 落完：app.js 里没有转发器了
  const okApp = `
const unrelated = 1;
`;
  // 注意：`functionBody` 对空函数体返回空串（假值），样本里必须给一行语句
  const okReg = `
function findOrderSpot() { return null; }
function findLabelSpot() { return null; }
function pxRect() { return null; }
function rectsOverlap() { return false; }
function layout(c) { return boxesIn(c); }
function schedule(c) { layoutTokens.get(c); rememberLayout(c); }
function stepSchedule(c, t, o, attempt) { requestAnimationFrame(() => { if (o.onLaidOut) return; }); if (attempt < 90) stepSchedule(c, t, o, attempt + 1); }
function rememberLayout(c) { new ResizeObserver(() => {}); }
const api = { init, layout, schedule };
`;
  assert.deepEqual(layoutMathProblems({ appCode: okApp, registryCode: okReg }), [], "合规样本被判红");
  assert.deepEqual(registryApiProblems({ registryCode: okReg }), [], "合规 registry 被判红");

  assert.ok(layoutMathProblems({ appCode: okApp + "function findOrderSpot() {}\n", registryCode: okReg }).length >= 1,
    "app.js 里长出真实现必须红");
  const backForwarder = okApp + "function layoutOverlayAnnotations(o) { return window.OverlayLayer?.layout(o, {}); }\n";
  assert.ok(layoutMathProblems({ appCode: backForwarder, registryCode: okReg }).length >= 1, "转发器复活必须红");
  assert.ok(layoutMathProblems({ appCode: okApp, registryCode: okReg.replace("if (a < 90)", "if (a < 90)") + "" }).length === 0);
  assert.ok(layoutMathProblems({ appCode: okApp + "const x = 1; // attempt < 90\n", registryCode: okReg }).length >= 1,
    "app.js 里第二份重试循环必须红（注释里的不算——codeOnly 已剥）");
  assert.ok(registryApiProblems({ registryCode: okReg.replace("layoutTokens.get(c);", "") }).length >= 1,
    "schedule 少了 token 必须红");
  assert.ok(registryApiProblems({ registryCode: okReg.replace("requestAnimationFrame", "setTimeout") }).length >= 0);

  const fakeFiles = (sources) => Object.entries(sources).map(([fileName, source]) => ({ fileName, source }));
  // 2.2 之后没有白名单：任何视图自己拼容器 class 都红
  assert.equal(overlayClassProblems({ files: fakeFiles({ "app.js": "const x = 1;", "index-view.js": "page-overlay--labeled" }) }).length, 1,
    "视图自己拼容器 class 必须红（index 已迁入 registry）");
  assert.ok(overlayClassProblems({ files: fakeFiles({ "app.js": "page-overlay--margin" }) }).length >= 1,
    "app.js 里写 class 必须红");
  assert.equal(overlayClassProblems({ files: fakeFiles({ "app.js": "", "preview-view.js": "page-overlay--labeled" }) }).length, 1,
    "白名单外的视图写 class 必须红（条目过期不再单独判：2.2 收紧笔会把条目删掉）");
});

// ---------------------------------------------------------------- 片 2 笔 C：旧渲染器归零 + 解耦

test("片 2 笔 C：renderPageBlocks / clearPageBlocks / _renderedBlocks 全仓归零", () => {
  const problems = [];
  for (const fileName of readdirSync(STATIC_DIR).filter((name) => name.endsWith(".js"))) {
    const code = codeOnly(readFileSync(join(STATIC_DIR, fileName), "utf8"));
    for (const needle of ["renderPageBlocks", "clearPageBlocks", "_renderedBlocks"]) {
      if (code.includes(needle)) problems.push(`${fileName} 里还有 ${needle}`);
    }
    if (fileName !== "overlay-registry.js" && /page-overlay--(readonly|labeled|margin)/.test(code)) {
      problems.push(`${fileName} 里还在拼容器 class——class 唯一写点是 registry`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("片 2 笔 C：避让跟 details 走、卡片跟 labeled 走（解耦不许被绑回去）", () => {
  const registryCode = codeOnly(readFileSync(join(STATIC_DIR, "overlay-registry.js"), "utf8"));
  const handle = functionBody(registryCode, "renderHandle");
  assert.ok(handle, "registry 里没有 renderHandle");
  assert.ok(/styles\.details !== false && visible > 0/.test(handle),
    "renderHandle 没有按 details 安排避让——preview 的号又会永远贴框内");
  assert.equal(/styles\.labeled &&/.test(handle), false, "避让又被绑回 labeled 了（两件事必须分开）");
  const renderBlockBody = functionBody(registryCode, "renderBlock");
  assert.ok(/style\.labeled && typeof injected\.buildLabel/.test(renderBlockBody),
    "卡片没有跟 labeled 走");
});

test("片 2 笔 C 自检：旧渲染器挪回视图 / 自己拼容器 / 避让绑回 labeled，都必须红", () => {
  const files = (sources) => Object.entries(sources).map(([fileName, source]) => ({ fileName, source }));
  const clean = { "app.js": "const a = 1;", "overlay-registry.js": "page-overlay--readonly" };
  const problemsOf = (sources) => {
    const out = [];
    for (const { fileName, source } of files(sources)) {
      for (const needle of ["renderPageBlocks", "clearPageBlocks", "_renderedBlocks"]) {
        if (source.includes(needle)) out.push(`${fileName}: ${needle}`);
      }
      if (fileName !== "overlay-registry.js" && /page-overlay--(readonly|labeled|margin)/.test(source)) {
        out.push(`${fileName}: class`);
      }
    }
    return out;
  };
  assert.deepEqual(problemsOf(clean), [], "合规样本被判红");
  assert.equal(problemsOf({ ...clean, "reading-view.js": "injected.renderPageBlocks(tile, blocks);" }).length, 1);
  assert.equal(problemsOf({ ...clean, "index-view.js": "overlay._renderedBlocks = blocks;" }).length, 1);
  assert.equal(problemsOf({ ...clean, "preview-view.js": 'overlay.className = "page-overlay--readonly";' }).length, 1);
});

// ---------------------------------------------------------------- ③ 导出面板：id 归属 / 导出面 / 注入双向

/** 模块按 id 取的 30 个（全部在 `#export-panel` 子树里，逐个对过 index.html）。 */
const EXPORT_IDS = [
  "export-scope", "export-error", "export-preflight", "export-note", "export-range",
  "export-confirmed-only", "export-page-markers", "export-include-notes", "export-margin-judgement",
  "export-rule-header", "export-rule-merge", "export-rule-hyphen", "export-rule-newlines",
  "export-rule-strip", "export-btn", "export-preview-btn", "export-result", "export-result-meta",
  "export-files", "export-reveal-btn", "export-history", "export-history-empty", "export-compare",
  "compare-meta", "compare-segments", "compare-close", "compare-image", "compare-image-status",
  "compare-canvas", "compare-overlay",
];
/** 外壳仍持有的 4 个（root 本身 / 关闭 / 取消 / 打开结构工具）。 */
const EXPORT_SHELL_IDS = ["export-panel", "export-close", "export-cancel", "structure-open"];

/** `#export-panel` 这个 mask 子树里的全部 id（按 div 配平切，不手写行号）。 */
function exportMaskIds(html) {
  const at = String(html).indexOf('id="export-panel"');
  if (at < 0) return [];
  const start = html.lastIndexOf("<div", at);
  let depth = 0;
  for (const match of html.slice(start).matchAll(/<div\b|<\/div>/g)) {
    if (match[0] === "<div") depth += 1;
    else {
      depth -= 1;
      if (depth === 0) {
        const sub = html.slice(start, start + match.index + match[0].length);
        return [...sub.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
      }
    }
  }
  return [];
}

test("③ 导出：一个 section 两个 owner（模块 30 / 外壳 4 · 并集 == #export-panel 子树）", () => {
  const moduleSource = readFileSync(join(STATIC_DIR, "export-panel.js"), "utf8");
  const html = readFileSync(join(STATIC_DIR, "index.html"), "utf8");
  const subtree = exportMaskIds(html);
  // Temp-Relax: 搬控件到 #pv-options（笔 3 收紧）
  // 放宽的是**枚举**不是下界：只认 32 或 34 两个值，别的数一律红（搬迁窗口：旧 34 → 新 32）。
  assert.ok(
    subtree.length === 32 || subtree.length === 34,
    `#export-panel 子树应有 32 或 34 个 id（搬迁窗口的枚举值），实测 ${subtree.length}`
  );
  const problems = sectionOwnerProblems({
    owners: [
      { name: "EXPORT", ids: EXPORT_IDS, files: ["export-panel.js"], classes: ["export-"] },
      { name: "SHELL", ids: EXPORT_SHELL_IDS, files: ["app.js"], integrator: true, classes: [] },
    ],
    subtreeIds: subtree,
    modules: readdirSync(STATIC_DIR).filter((name) => name.endsWith(".js"))
      .map((fileName) => ({ fileName, source: readFileSync(join(STATIC_DIR, fileName), "utf8") })),
  });
  // Temp-Relax: 搬控件到 #pv-options（笔 3 收紧）
  // 只放这两个具名 id 的"不再归属 export 子树"：搬过去之后它们在 #pv-options 里，
  // 旧断言会报「归属表里的 <id> 不在这个 section 的 subtree 里」。别的 id、别的毛病一律红。
  const movingIds = ["export-range", "export-confirmed-only"];
  const allowed = subtree.length === 32
    ? problems.filter((text) => !movingIds.some((id) => text.includes(`归属表里的 ${id} `)))
    : problems;
  assert.deepEqual(allowed, [], allowed.join("\n"));
});

test("③ 导出：导出面每个键都有调用点（§1 ⑦）", () => {
  const appSource = codeOnly(readFileSync(APP_FILE, "utf8"));
  const moduleSource = readFileSync(join(STATIC_DIR, "export-panel.js"), "utf8");
  const sandbox = { console, window: {}, document: { createElement: () => ({}) } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(moduleSource, sandbox, { filename: "export-panel.js" });
  const api = sandbox.window.ExportPanel;
  assert.ok(api && typeof api.init === "function", "export-panel.js 没挂 window.ExportPanel.init");
  const keys = Object.keys(api);
  // Temp-Relax: 搬控件到 #pv-options（笔 3 收紧）
  // 放宽的也是**枚举**：只认 5 键（旧，含 reload）或 4 键（新，reload 0 调用点删除），别的集合一律红。
  const fiveKeys = ["exportOptions", "init", "refreshPreflight", "reload", "setupPanel"].sort();
  const fourKeys = ["exportOptions", "init", "refreshPreflight", "setupPanel"].sort();
  const expected = keys.length === 4 ? fourKeys : fiveKeys;
  assert.deepEqual(keys.sort(), expected);
  const problems = [];
  for (const key of keys) {
    if (!new RegExp(`ExportPanel\\?\\.${key}\\s*\\(`).test(appSource)) {
      problems.push(`api.${key} 在 app.js 里没有调用点——导出面不许留"预留"`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("③ 导出：注入双向对（boot 传的键模块都读、模块读的键 boot 都传）", () => {
  const appSource = codeOnly(readFileSync(APP_FILE, "utf8"));
  const moduleSource = codeOnly(readFileSync(join(STATIC_DIR, "export-panel.js"), "utf8"));
  const boot = appSource.slice(appSource.indexOf("window.ExportPanel?.init({"));
  assert.ok(boot.length > 0, "boot 里没找到 ExportPanel 的 init 块");
  const block = boot.slice(0, boot.indexOf("\n  });"));
  const keys = [...block.matchAll(/^    ([A-Za-z_$][\w$]*)[:,]/gm)].map((m) => m[1]);
  assert.ok(keys.length > 0, "init 块里一个键都没解析到");
  const used = new Set([...moduleSource.matchAll(/injected\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const problems = [];
  for (const key of keys) {
    if (!used.has(key)) problems.push(`boot 注入了 ${key}，模块一次都没读——死注入`);
  }
  for (const key of used) {
    if (!keys.includes(key)) problems.push(`模块用了 injected.${key}，但 boot 没传——运行时是 undefined`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("③ 导出自检：模块写外壳 id / 导出面留空 / 注入少一个键，都必须红", () => {
  const moduleIds = ["export-scope"];
  const shellIds = ["export-close"];
  const subtree = ["export-scope", "export-close"];
  const owners = [
    { name: "EXPORT", ids: moduleIds, files: ["export-panel.js"], classes: ["export-"] },
    { name: "SHELL", ids: shellIds, files: ["app.js"], integrator: true, classes: [] },
  ];
  const run = (moduleSource, own = owners) => sectionOwnerProblems({
    owners: own, subtreeIds: subtree,
    modules: [{ fileName: "export-panel.js", source: moduleSource }, { fileName: "app.js", source: "" }],
  });
  assert.deepEqual(run('part("export-scope");'), []);
  assert.equal(run('part("export-close");').length, 1, "模块取外壳 id 必须红");
  assert.equal(run("", [owners[0], { ...owners[1], ids: [] }]).length, 1, "subtree 有 id 没归属必须红");
  // 导出面 / 注入双向的纯判定：用合成样本各喂一次
  const app = "window.ExportPanel?.a();\nwindow.ExportPanel?.init({\n    x: 1,\n  });\n";
  assert.match(app, /ExportPanel\?\.a\s*\(/);
  assert.equal(/ExportPanel\?\.b\s*\(/.test(app), false, "没人喊的导出必须红");
  const used = new Set(["x"]);
  assert.equal(used.has("x"), true);
  assert.equal(used.has("y"), false, "漏注入必须红");
});

// ---------------------------------------------------------------- 清洗刀：退役 id/状态归零

/** 清洗刀退役名单（书 §5 ②）：页内差异队列 + 块级候选对比 + 4 个零引用 id。 */
const DEAD_REVIEW_NAMES = [
  "diff-queue", "queue-adopt", "queue-keep", "queue-prev", "queue-mode", "diff-queue-toggle",
  "diff-queue-position", "diff-queue-meta", "diff-queue-text", "diff-queue-dots", "diff-queue-note",
  "candidate-panel", "candidate-meta", "candidate-apply", "candidate-decline", "candidate-close",
  "candidate-current", "candidate-new", "candidate-open", "candidateRunId", "applyQueueAckLocally",
];
/**
 * 这四个只是**退役的 id 属性**，元素 / class 都还在用（书 §1.3 / §4）：
 * `review-toolbar` 的 div 与 `.workspace-toolbar`、`review-split` 的 `.review-split` 布局、
 * `layout-info` 的 `.info-dot` 提示、`page-detail-warning` 整个空元素。
 * 所以判的是"还有没有人按这个 id 找它"，不是"这几个字还在不在文件里"。
 */
const DEAD_ID_ATTRIBUTES = ["review-toolbar", "review-split", "layout-info", "page-detail-warning"];

/** 静态文本里出现退役名就红（按词边界；`structure-candidates` 之类不算 `candidate-*`）。 */
function deadReviewProblems({ sources, names = DEAD_REVIEW_NAMES }) {
  const problems = [];
  for (const [file, source] of sources) {
    for (const name of names) {
      const hits = (source.match(new RegExp(`(?:^|[^\\w-])${name}(?:$|[^\\w-])`, "g")) || []).length;
      if (hits) problems.push(`${file} 里还有 ${hits} 次退役名 ${name}`);
    }
  }
  return problems;
}

test("清洗刀：退役的 review id / 状态在全仓 0 次（含 queue-mode 三处单独判）", () => {
  const staticFiles = readdirSync(STATIC_DIR)
    .filter((name) => name.endsWith(".js") || name === "index.html" || name === "app.css");
  const sources = staticFiles.map((name) => [name, readFileSync(join(STATIC_DIR, name), "utf8")]);
  assert.deepEqual(deadReviewProblems({ sources }), [], "退役名还有残留——删队列要删干净（书 §5 ②）");
  for (const name of DEAD_ID_ATTRIBUTES) {
    for (const [file, source] of sources) {
      const byId =
        (source.match(new RegExp(`id="${name}"`, "g")) || []).length +
        (source.match(new RegExp(`(?:el|getElementById|querySelector)\\("#?${name}"`, "g")) || []).length;
      assert.equal(byId, 0, `${file} 里还有按 id 找 ${name} 的地方——这个 id 已退役（元素/class 保留）`);
    }
  }

  // queue-mode 是 setQueueOpen 现加现删的类名，只删 CSS 不够：三个文件各判一次
  for (const name of ["app.js", "index.html", "app.css"]) {
    const source = readFileSync(join(STATIC_DIR, name), "utf8");
    assert.equal(
      (source.match(/queue-mode/g) || []).length,
      0,
      `${name} 里还有 queue-mode——它只由已删除的 setQueueOpen 现加现删，必须三处归零`,
    );
  }

  // 保留项仍在（书 §4 的"逐个点名"）：删错成"整段删 CSS"会在这里红
  const css = readFileSync(join(STATIC_DIR, "app.css"), "utf8");
  for (const token of [".alert--warn", ".info-dot", ".workspace-toolbar", ".review-split", ".diff-strip", ".review-footer-count"]) {
    assert.ok(css.includes(token), `app.css 里 ${token} 被顺手删掉了——它还有别的使用者（书 §4）`);
  }
  const page = readFileSync(join(STATIC_DIR, "index.html"), "utf8");
  assert.ok(page.includes('class="review-split"'), "review-split 只删 id 属性，class 布局必须保留");
  assert.ok(page.includes('class="workspace-toolbar"'), "review-toolbar 只删 id 属性，class 必须保留");
  assert.ok(page.includes('class="info-dot"'), "layout-info 只删 id 属性，元素（提示）必须保留");
  assert.ok(!page.includes("page-detail-warning"), "page-detail-warning 是整元素删（从未被写过）");
});

test("清洗刀自检：喂回一句 el(\"diff-queue\") 必须红；queue-mode 塞回 CSS 必须红", () => {
  assert.equal(
    deadReviewProblems({ sources: [["x.js", 'const node = el("diff-queue");']] }).length,
    1,
    "退役名塞回去必须红（否则这条闸是装饰）",
  );
  assert.deepEqual(
    deadReviewProblems({ sources: [["x.js", 'const node = el("structure-candidates");']] }),
    [],
    "structure-candidates / reading-panel__candidate 不是退役名，不许误伤",
  );
  assert.equal(
    deadReviewProblems({ sources: [["app.css", "body.queue-mode .diff-strip { display: none; }"]] }).length,
    1,
    "queue-mode 单独判也要能红",
  );
});

test("域模块自检：el( / getElementById / querySelector( 喂进坏样本必须红；纯数据模块算绿", () => {
  assert.deepEqual(
    domainDomProblems({ file: "x.js", source: 'function render(data) { return data.x; }' }),
    [],
    "完全不碰 DOM 的域模块必须绿",
  );
  assert.equal(
    domainDomProblems({ file: "x.js", source: 'const a = el("x");' }).length,
    1,
    "el( 必须红（刀 A 的变异判据：在模块里加一句 el(\"stats-list\") 就该红）",
  );
  assert.equal(
    domainDomProblems({ file: "x.js", source: 'const a = document.getElementById("x");' }).length,
    1,
    "document.getElementById 必须红",
  );
  assert.equal(
    domainDomProblems({ file: "x.js", source: 'const a = root.querySelector("#x");' }).length,
    1,
    "querySelector 也必须红（v1.1：元素由 init 传进来，不要根宿主再自己找）",
  );
  // 刀 D 的例外：登记了 allowQuerySelector 的模块允许 root.querySelector，但 document 级仍然红
  assert.deepEqual(
    domainDomProblems({ file: "x.js", source: 'const a = root.querySelector("#x");', allowQuerySelector: true }),
    [],
    "登记了例外的模块，root.querySelector 必须绿（否则 17 个 structure-* 逐个传就成了摆设）",
  );
  assert.equal(
    domainDomProblems({ file: "x.js", source: 'const a = document.querySelector("#x");', allowQuerySelector: true }).length,
    1,
    "例外只放 root——document.querySelector 在例外模块里也必须红",
  );
  assert.equal(
    domainDomProblems({ file: "x.js", source: 'const a = el("x");', allowQuerySelector: true }).length,
    1,
    "例外不放 el(：有例外也必须按 root 查，不许按 id 找全局",
  );
});
