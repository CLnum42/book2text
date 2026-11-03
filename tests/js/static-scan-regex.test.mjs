// 正则字面量的**旗标**不许漏进"代码"里（2026-11-03，Chief 派；Builder 在片 6 撞上）。
//
// 真事故：`String(text).replace(/[&<>"']/g, …)` 这种行，去注释/去字符串器在收尾的 `/` 处停下，
// 后面的旗标 `g` 原样留在"代码"里 ⇒ R9 把一个**根本不存在的标识符 `g`** 报成未定义变量。
// 以前 HEAD 能过，是因为被搬走的那片代码里恰好有个形参叫 `g`，把这个假标识符"定义"盖住了；
// 片 6 一搬走就冒出来。**底座误判要按底座修**——让产品改写成 `new RegExp(…)` 只是把地雷留在地里。
//
// 修法：认出 `/…/flags` 时，收尾的 `/` 之后把旗标 `[dgimsuvy]*` 一并抹掉。
// 顺带钉住两件事（这两条本来就对，但这正是这族判据最容易被"顺手简化"改坏的地方）：
//   · 字符类 `[…]` 里的 `/` **不是**终止符（`/[a/]b/` 是一整个字面量）；
//   · 字符类里的引号**不是**字符串边界（否则后面的整行代码会被当成字符串吞掉——漏报方向）。
//
// 为什么 `comment-scan.mjs` 的 `commentOnly` 不用改：它只保留注释、其余一律抹成空格，
// 旗标本来就落不进输出（本文件也钉了一条：含引号的正则之后，同一行的注释仍被认出来）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { codeOnly, stripCommentsAndStrings, stripPreservingTemplateExpressions } from "./static-scan.mjs";
import { commentOnly } from "./comment-scan.mjs";

const STATIC_DIR = process.env.B2T_STATIC_DIR
  || fileURLToPath(new URL("../../backend/book2text/static/", import.meta.url));

/** 三把"保留代码"的剥离器：旗标必须一起被抹掉。 */
const STRIPPERS = [
  ["codeOnly", codeOnly],
  ["stripCommentsAndStrings", stripCommentsAndStrings],
  ["stripPreservingTemplateExpressions", stripPreservingTemplateExpressions],
];

/** 文本里有没有这个**独立**标识符（`g` 不能命中 `string` 里的 g）。 */
function hasToken(text, token) {
  return new RegExp(`(?<![\\w$])${token}(?![\\w$])`).test(text);
}

test("① 含引号的正则字面量：旗标 g 不许漏成标识符（Chief 给的三个样本）", () => {
  const samples = [
    ["/[&<>\"']/g", 'const re = /[&<>"\']/g;', "g"],
    ["/a\"b/g", 'const re = /a"b/g;', "b"],
    ["/(['\"])x\\1/g", "const re = /(['\"])x\\1/g;", "x"],
  ];
  for (const [label, source, leaked] of samples) {
    for (const [name, strip] of STRIPPERS) {
      const out = strip(source);
      assert.equal(hasToken(out, leaked), false,
        `${name} 把正则 ${label} 里的 \`${leaked}\` 漏成了标识符：${JSON.stringify(out)}`);
      assert.ok(out.includes("const re ="), `${name} 连字面量前面的代码都吃掉了：${JSON.stringify(out)}`);
    }
  }
});

test("② 字符类里的 `/` 不是终止符：`/[a/]b/g` 是一个完整的字面量", () => {
  for (const [name, strip] of STRIPPERS) {
    const out = strip("const re = /[a/]b/g; const after = 1;");
    assert.equal(hasToken(out, "g"), false, `${name} 漏了旗标：${JSON.stringify(out)}`);
    assert.equal(hasToken(out, "b"), false, `${name} 把类里或类后的字符漏成了标识符：${JSON.stringify(out)}`);
    assert.ok(out.includes("after"), `${name} 把字面量之后的代码吞了：${JSON.stringify(out)}`);
  }
});

test("② 字符类里的引号不是字符串边界（漏报方向）：后面的真代码不许被吞掉", () => {
  for (const [name, strip] of STRIPPERS) {
    const out = strip('const re = /[&<>\'"]/g;\nconst keepMe = 1;\n');
    assert.ok(out.includes("keepMe"), `${name} 把后面的代码当成字符串吞掉了：${JSON.stringify(out)}`);
    assert.equal(hasToken(out, "g"), false, `${name} 漏了旗标：${JSON.stringify(out)}`);
  }
});

test("③ 旗标之后的成员访问与语句边界完好（`/x/g.test(s)` 的 `.test` 不能被吃掉）", () => {
  for (const [name, strip] of STRIPPERS) {
    const out = strip("const ok = /x/g.test(s); const after = 2;");
    assert.ok(out.includes(".test"), `${name} 把旗标之后的成员访问吃了：${JSON.stringify(out)}`);
    assert.ok(out.includes("after"), `${name} 把下一句吃了：${JSON.stringify(out)}`);
    assert.equal(hasToken(out, "g"), false, `${name} 漏了旗标：${JSON.stringify(out)}`);
  }
});

test("④ 常驻样本：static 里含引号的正则字面量，旗标位置在 codeOnly 输出里必须是空白", () => {
  // 只用 codeOnly 的树，扫所有 static/*.js：字面量形态 `/[ … ' 或 " … ]/flags`。
  const pattern = /\/(\[[^\]\n]*["'][^\]\n]*\])\/[dgimsuvy]+/g;
  let samples = 0;
  const offenders = [];
  for (const file of readdirSync(STATIC_DIR).filter((name) => name.endsWith(".js")).sort()) {
    const source = readFileSync(join(STATIC_DIR, file), "utf8");
    const out = codeOnly(source);
    for (const match of source.matchAll(pattern)) {
      samples += 1;
      const flags = match[0].slice(match[0].lastIndexOf("/") + 1);
      const from = match.index + match[0].length - flags.length;
      const kept = out.slice(from, from + flags.length);
      if (/[^\s]/.test(kept)) offenders.push(`${file}: 字面量 ${match[0]} 的旗标「${flags}」留在了代码里（${JSON.stringify(kept)}）`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
  assert.ok(samples > 0, "一个含引号的正则字面量都没扫到——常驻样本空转了（换个判据形态或查路径）");
});

test("④ 附带：commentOnly 不需要收旗标——它只留注释，含引号的正则之后那行注释仍被认出来", () => {
  const source = 'const re = /[&<>"\']/g; // 这条注释在正则后面\nconst after = 1;\n';
  const out = commentOnly(source);
  assert.ok(out.includes("这条注释在正则后面"), `注释没被认出来（正则把状态机带偏了）：${JSON.stringify(out)}`);
  assert.equal(out.includes("const after"), false, "commentOnly 把代码当注释留下了");
});
