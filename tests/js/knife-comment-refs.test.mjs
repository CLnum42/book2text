// 注释里引用的刀号必须是登记表里的真号（2026-11-03，DevLead 派）。
//
// 真事故的形态：Builder 在 `boundary.test.mjs` 写了两处「到期点 = 刀 12」，而当时
// `knife-registry.mjs` 里没有 12 —— **node 全绿、registry 0 笔不合格**。原因很具体：
// 现有的刀号判据只解析 **seed 行**（`| 宿主 | 到期刀 |` 那种表格格），注释里的引用它看不见。
//
// 注释里写一个不存在的到期点，不是"文档笔误"，是**不可执行的承诺**：半年后有人按它去查
// 「到点该删什么」，登记表里查不到这一刀，这条承诺永远不会有到点，也没有任何闸会红。
//
// 判据（只判**承诺形态**，不判叙事）：
//   ① 取注释文本（`comment-scan.mjs` 的 `commentOnly`：代码/字符串/正则抹掉，长度与换行不变；
//      它是 `static-scan.mjs` 那三个剥离器的互补口径）；
//   ② 在注释里抓 `到期点|到期刀|到期日|死期|死亡刀号|到点` 紧跟 `刀 N` 的形态（分隔符 `= : ：是 为` 可有可无）；
//   ③ 该号必须在 `knife-registry.mjs` 里（landed / pending 都算），**或者它是某个已登记子刀的父刀**
//      （刀 10 拆成 10.1/10.2 之后，写「刀10」仍指向真工作；写「刀 99」什么都不指向）；
//   ④ 不在 ⇒ 红，点名 `文件:行` 与号。
//
// 为什么**不**判全量「出现即要登记」（DevLead 给的退档口径，实测数据支持这个收窄）：
// 现树注释里出现刀号 **228 处**，其中承诺形态只有 **10 处**；其余是历史叙事（"刀 11 那一刀搬的"）
// 与计数（"本刀 20 键 → 终点 3"），后者根本不是刀号。一把"全是刀号"的尺子会产出 20 处假红，
// 假红的下场是被关掉。已知缺口：`刀 5b` 这类带字母的号、以及"刀 9 那一刀"式叙事里的号，
// 这条判据不判——它们的定义位在 seed 判据那边。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { commentOnly } from "./comment-scan.mjs";
import { KNIVES } from "./knife-registry.mjs";

const TESTS_JS_DIR = fileURLToPath(new URL("./", import.meta.url));
const STATIC_DIR = process.env.B2T_STATIC_DIR
  || fileURLToPath(new URL("../../backend/book2text/static/", import.meta.url));

/**
 * 承诺形态。三个要点，每个都对应一种真实写法：
 * - 关键词只认 `死亡刀号`（`死期` 单独出现在叙事里太多，但 `死期 刀9` 那种也真实存在 ⇒ 用可选分隔符一并认）；
 * - 分隔符可选：`到期点 = 刀 12`（Builder 的写法）、`死期 刀9`、`到期刀：刀 5` 都是承诺；
 * - 号必须紧跟 `刀`：`本刀 20 键` 里的 20 是计数，不是号——少这一条就假红一片。
 */
export const KNIFE_COMMITMENT = /(?:到期点|到期刀|到期日|死期|死亡刀号|到点)\s*(?:是|为|[=:：])?\s*刀\s*([0-9]+(?:\.[0-9]+)?)/g;

/** 号 N 能不能落到真刀上：N 本身登记过，或存在以 N 为整数部分的子刀（刀 10 → 10.1）。 */
export function knifeResolves(n, registered) {
  const num = Number(n);
  if (!Number.isFinite(num)) return false;
  return registered.some((r) => r === num || (r > num && Math.floor(r) === num));
}

/** 一组 `{ file, text }` → 注释里的承诺引用（保持文件顺序与行号）。 */
export function knifeCommentRefs({ sources }) {
  const refs = [];
  for (const { file, text } of sources || []) {
    const comments = commentOnly(text);
    comments.split("\n").forEach((line, index) => {
      KNIFE_COMMITMENT.lastIndex = 0;
      let match;
      while ((match = KNIFE_COMMITMENT.exec(line))) {
        refs.push({ file, line: index + 1, n: Number(match[1]), text: line.trim() });
      }
    });
  }
  return refs;
}

/**
 * 判据内核。返回空数组 = 绿。
 *
 * fail-closed 三档（缺任一条，判据都可能空转成"一直绿"）：
 * - 一个文件都没扫到 ⇒ 红（路径写错时不许静默放过）；
 * - 登记表为空 ⇒ 红（清空登记表会让**任何**号都"登记过"）；
 * - 全树一处承诺都没有 ⇒ 红（扫描器/正则坏了就是这个症状，不能当成"没违规"）。
 */
export function knifeCommentRefProblems({ sources, registered }) {
  const problems = [];
  if (!Array.isArray(sources) || sources.length === 0) {
    return ["一个文件都没扫到——刀号引用的判据空转了（先查扫描路径）"];
  }
  if (!Array.isArray(registered) || registered.length === 0) {
    return ["刀号登记表是空的——不许用清空登记表把这条判据变成通行证"];
  }
  const refs = knifeCommentRefs({ sources });
  if (refs.length === 0) {
    return ["全树没有一处承诺形态的刀号引用——扫描器或正则坏了？（不是「没有违规」）"];
  }
  for (const ref of refs) {
    if (knifeResolves(ref.n, registered)) continue;
    problems.push(
      `${ref.file}:${ref.line} 引用了未登记的刀号 ${ref.n}`
      + `（knife-registry.mjs 里既没有 ${ref.n}，也没有 ${ref.n}.x 这样的子刀）——`
      + "注释里许的到期点不可执行：到点该删什么、谁来判，登记表里查不到",
    );
  }
  return problems;
}

const registeredKnives = () => KNIVES.map((knife) => knife.n);

function realTreeSources() {
  const sources = [];
  for (const file of readdirSync(TESTS_JS_DIR).sort()) {
    if (file.endsWith(".mjs")) {
      sources.push({ file: `tests/js/${file}`, text: readFileSync(join(TESTS_JS_DIR, file), "utf8") });
    }
  }
  for (const file of readdirSync(STATIC_DIR).sort()) {
    if (file.endsWith(".js")) {
      sources.push({ file: `static/${file}`, text: readFileSync(join(STATIC_DIR, file), "utf8") });
    }
  }
  return sources;
}

test("注释里的到期点全部指向登记过的刀号（真树）", () => {
  const sources = realTreeSources();
  const problems = knifeCommentRefProblems({ sources, registered: registeredKnives() });
  assert.deepEqual(problems, [], `注释里引用了未登记的刀号：\n${problems.join("\n")}`);
  // 防空转：真树上一处承诺都没有 = 扫描器坏了。现树是 10 处（boundary 5 · pages-view 5），
  // 这里只要 >0，别把条数钉死（有人补一句 死期 注释不该让判据红）。
  const refs = knifeCommentRefs({ sources });
  assert.ok(refs.length > 0, "真树上一处承诺形态的刀号引用都没扫到——判据在空转");
});

test("自检：注释里写一个没登记的到期点 → 红并点名 文件:行", () => {
  // 事故原文形态：Builder 那两行的措辞（当时登记表里还没有 12）。
  const problems = knifeCommentRefProblems({
    sources: [{ file: "a.mjs", text: "// 到期点 = 刀 12（tests/js/knife-registry.mjs）：块框选中态…\n" }],
    registered: [11],
  });
  assert.equal(problems.length, 1, `应当恰好红一条，实际：${JSON.stringify(problems)}`);
  assert.match(problems[0], /a\.mjs:1/, "红文必须点名文件与行号");
  assert.match(problems[0], /刀号 12/, "红文必须点名号");
});

test("自检：已登记的号（含 pending）都绿", () => {
  for (const n of [11, 12]) {
    const problems = knifeCommentRefProblems({
      sources: [{ file: "a.mjs", text: `// 到期点 = 刀 ${n}\n// 死期：刀${n}\n` }],
      registered: [1, 11, 12],
    });
    assert.deepEqual(problems, [], `刀 ${n} 已登记（${n === 12 ? "pending 也算登记过" : "landed"}），不该红`);
  }
});

test("自检：字符串字面量与模板里的承诺不算（那是文案，不是承诺）", () => {
  const source = [
    'const message = "到期点 = 刀 99";',
    "const other = `死期 = 刀 98`;",
    "// 真正的注释在这里，没有号",
  ].join("\n");
  const refs = knifeCommentRefs({ sources: [{ file: "a.mjs", text: source }] });
  assert.deepEqual(refs, [], "字符串/模板里的号被当成承诺了——commentOnly 剥错了对象");
  // 注意：这里**不**调内核断言"绿"——这份源码一处真承诺都没有，内核会按空转报红（那是对的，
  // 见 fail-closed 那条）。字符串不算数这件事，用「一处引用都没抓到」来判。
});

test("自检：叙事与计数不算（刀 11 那一刀 / 本刀 20 键）", () => {
  const source = [
    "// 刀 11 那一刀搬的，不是本轮的事",
    "// 收敛棘轮：本刀 20 键 → 终点 3",
    "// 刀 2–5 每刀严格下降",
  ].join("\n");
  const refs = knifeCommentRefs({ sources: [{ file: "a.mjs", text: source }] });
  assert.deepEqual(refs, [], `叙事/计数被当成承诺了：${JSON.stringify(refs)}`);
});

test("自检：父刀已拆成子刀仍算有效，没有子刀的号照样红", () => {
  // 刀 10 拆成 10.1/10.2 ⇒ 真树里「死亡刀号 = 刀10」这两处不该红（否则是假红）。
  const parent = knifeCommentRefProblems({
    sources: [{ file: "a.js", text: "// 死亡刀号 = 刀10（全仓引用 = 0 且不在 api 表）\n" }],
    registered: [10.1, 10.2, 11],
  });
  assert.deepEqual(parent, [], "刀 10 有 10.1/10.2 两把子刀，写父刀号仍指向真工作");
  const dangling = knifeCommentRefProblems({
    sources: [{ file: "a.js", text: "// 死亡刀号 = 刀99\n" }],
    registered: [10.1, 10.2, 11],
  });
  assert.equal(dangling.length, 1, "99 没有任何子刀，必须红");
  assert.match(dangling[0], /刀号 99/);
});

test("自检：行号不漂（前面有跨行模板与正则里的引号）", () => {
  // 这一行之前故意放三样会骗朴素状态机的东西：跨行模板、正则字面量里的引号、字符串里的 `//`。
  const source = [
    "const tpl = `第一行",
    "// 这行在模板里，不是注释：到期点 = 刀 77",
    "第三行`;",
    'const re = /[&<>"\']/g;',
    'const url = "https://example.com//x";',
    "// 到期点 = 刀 99",
  ].join("\n");
  const refs = knifeCommentRefs({ sources: [{ file: "a.mjs", text: source }] });
  assert.equal(refs.length, 1, `只该抓到真注释那一处，实际：${JSON.stringify(refs)}`);
  assert.equal(refs[0].line, 6, `行号漂了：期望 6，实际 ${refs[0].line}`);
});

test("fail-closed：没扫到文件 / 登记表为空 / 一处承诺都没有 → 都红", () => {
  assert.equal(knifeCommentRefProblems({ sources: [], registered: [11] }).length, 1);
  assert.equal(knifeCommentRefProblems({ sources: [{ file: "a.mjs", text: "// 到期点 = 刀 11" }], registered: [] }).length, 1);
  assert.equal(
    knifeCommentRefProblems({ sources: [{ file: "a.mjs", text: "// 没有承诺\n" }], registered: [11] }).length,
    1,
    "一处承诺都没扫到必须红——那是扫描器坏了，不是「没有违规」",
  );
});
