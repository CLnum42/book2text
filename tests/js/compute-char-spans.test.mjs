// computeCharSpans(current, candidate) 的边界测试。
//
// 被测函数：backend/book2text/static/app.js:11574。它决定"哪几个字符算差异"，
// 是 readingDiffUnits 的上游；中文那 133 行栽在码位/偏移上，就是这一层的坐标口径问题。
//
// 语义（读代码 + 实测确认，不是猜的）：
// - 返回的 `aStart/aEnd/bStart/bEnd` 是 **UTF-16 code unit 下标**，不是码位、不是字素簇。
// - 等长（`a.length === b.length`）走**逐字快路径**：只产出 `replace`，永远不会出 insert/delete；
// - 不等长走 LCS；`a.length * b.length > 40000`（DIFF_LCS_MAX_CELLS）时整行兜底成一个 replace；
// - 空串 / 全同 / 一方为空 → 返回空数组（不 span 也不崩）。
//
// **红过没有**（复跑：`B2T_APP_JS=<那个版本的 app.js> node tests/js/run.mjs`）
//
// 1. 「等长换位」那条在 `7b803c5`（等长快路径引入之前）**已复现是红的**：
//    旧版走 LCS，给 `insert[0,0,0,1] + delete[1,2,2,2]` 两段；新版压成一个 `replace[0,2]`。
//    这是**有意的行为变更**（性能），不是回归——但它证明"快路径"这个分支真被锁住了。
//    复跑命令（该版本还没有 readingDiffUnits，所以按文件选跑，那 3 条会自动 skip）：
//      git show 7b803c5:backend/book2text/static/app.js > /tmp/app-7b803c5.js
//      B2T_APP_JS=/tmp/app-7b803c5.js node tests/js/run.mjs compute-char-spans
//    实测：8 pass / 1 fail / 3 skipped / 1 todo，唯一的红就是这条。
// 2. 代理对哨兵：**当前 HEAD 红**（main 上用条件 `skip`，修好后自动开跑），且在
//    `23bcc8a` / `7b803c5` / `dfd218d` 三个旧版本上同样红 → 不是回归，是长期潜伏缺陷。
//    证据：`𠀀`→`𠀁` 的 span 是 `[1,2]`，切在一个代理对中间；下游三处
//    `text.slice(span.aStart, span.aEnd)`（app.js:13111/13117/13069）会拿到孤立低代理。
//
// **任务 90 的契约变更（2026-10-28）**
//
// Builder 的修法 `alignSpansToCodePoints` 把 span 边界对齐到码位（整字扩宽、重叠合并），
// 所以这里有两条用例按"契约变了"重写，不是让测试迁就实现：
// - 「代理对整字替换」原来断言 `span === [1,2]`——**那正是缺陷本身**（旧契约）。
//   已删除，改成不变式：边界不许落在代理对之间，且按区间切片不许切出孤立代理。
//   不锁具体下标（[0,2] 还是别的对齐策略），否则合法的对齐方式变更会误红。
// - 「代理对混排」原来断言 `span === [2,3]`——同样是旧下标。现在只锁**映射到哪些字框**：
//   旧 `[2,3]` 与新 `[1,3]` 都只命中字框 1，`ranges` 都是 `[1]`。
//   实测 4 组场景（单字替换 / 与汉字混排 / 逐词框 / 代理对在行首），旧新 `ranges` 完全一致。
// 3. 其余用例在 HEAD 与上述三个旧版本上都是绿的——没有可以诚实标红的回归点，不硬凑。
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./load-app.mjs";
import { loadReadingView } from "./load-reading-view.mjs";

const ctx = loadApp({ require: ["computeCharSpans"] });
const computeCharSpans = ctx.computeCharSpans;
// 分支计数统计由 app.js 挂在 window 上（readingDiffUnits 注入的就是它）
const stats = ctx.window.__b2tWordBoxStats;
// L11：`readingDiffUnits` 搬进 reading-view.js 且没有公开导出（R8），改由模块单元加载器取到。
// 依赖注入照生产来：`computeCharSpans`（仍在 app.js）+ 统计对象。
const readingModule = loadReadingView({ require: [] });
readingModule.setInjected({
  computeCharSpans: ctx.computeCharSpans,
  getWordBoxMappingStats: () => stats,
});
// 只在真的没有这个函数时才 skip（对历史版本复跑用）；HEAD 上它必须在，
// 否则就是"应该跑的用例被悄悄跳过"——那等于覆盖倒退。
const readingDiffUnitsSkip =
  typeof readingModule.ctx.readingDiffUnits === "function" ? false : "该版本还没有 readingDiffUnits";

/** 经 readingDiffUnits 的 kind / ranges（跨 realm，比前要归一化）。 */
function diffUnits(lineText, candidate) {
  return plain(readingModule.ctx.readingDiffUnits(lineText, candidate, charBoxes(lineText)));
}

const span = (aStart, aEnd, bStart, bEnd, kind) => ({ aStart, aEnd, bStart, bEnd, kind });

/** 逐字造字框（码位切分，用来喂 readingDiffUnits）。 */
function charBoxes(text) {
  return [...text].map((ch, index) => ({ text: ch, bbox: [index * 0.1, 0, index * 0.1 + 0.1, 1] }));
}

/** 这个下标是不是落在一个代理对中间。 */
function splitsSurrogatePair(text, index) {
  if (index <= 0 || index >= text.length) return false;
  const prev = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/**
 * vm 里返回的数组/对象来自另一个 realm（不同原型），`deepStrictEqual` 会按原型判等误报。
 * 全部 JSON 归一化成宿主 realm 的普通值再比。（`[...spans].map` 也不够：内层数组仍可能是 vm 的）
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function norm(spans) {
  return plain(spans.map((item) => [item.aStart, item.aEnd, item.bStart, item.bEnd, item.kind]));
}

// ---------------------------------------------------------------- 1. 等长快路径 vs LCS

test("等长且纯替换：一个 replace 区间", () => {
  assert.deepEqual(norm(computeCharSpans("abcd", "abXd")), [[2, 3, 2, 3, "replace"]]);
});

test("等长换位（含插入+删除）被压成一个 replace：这就是快路径在跑", () => {
  // "ab" → "ba" 本质是"删 a + 补 a"，LCS 会拆成 insert+delete 两段（见 7b803c5 实测）；
  // 等长快路径只逐下标比，所以只有一段 replace。断言形状 = 断言走了哪条路。
  assert.deepEqual(norm(computeCharSpans("ab", "ba")), [[0, 2, 0, 2, "replace"]]);
  assert.deepEqual(norm(computeCharSpans("已知", "知已")), [[0, 2, 0, 2, "replace"]]);
});

test("不等长走 LCS：insert / delete / replace 三种 kind 都会出现", () => {
  assert.deepEqual(norm(computeCharSpans("abcde", "abde")), [[2, 3, 2, 2, "delete"]]);
  assert.deepEqual(norm(computeCharSpans("abde", "abcde")), [[2, 2, 2, 3, "insert"]]);
  assert.deepEqual(norm(computeCharSpans("abcd", "abXd")), [[2, 3, 2, 3, "replace"]]);
});

// ---------------------------------------------------------------- 2. 代理对（UTF-16 下标）

/**
 * 被测版本是否已经把 span 边界对齐到码位（任务 90 的修复）。
 * main 上还没修；`ux/dock` 分支里有 `alignSpansToCodePoints`。
 * 用条件 `skip` 而不是 `todo`：`todo` 在失败的 node 版本里会被算进 failing tests，
 * 让 main 的退出码变 1——main 必须一直绿，否则拆模块时分不清回归还是这个已知 todo。
 */
function spansAlignToCodePoints() {
  const dragon = "\u{20000}";
  const candidate = "\u{20001}";
  return computeCharSpans(dragon, candidate).every(
    (item) => !splitsSurrogatePair(dragon, item.aStart) && !splitsSurrogatePair(dragon, item.aEnd),
  );
}

const codePointSkip = spansAlignToCodePoints()
  ? false
  : "任务 90 未修：span 仍会切开代理对（修复在暂停的 UX 分支）；修好后这条自动开跑";

test("代理对：span 的边界不许落在代理对中间（不变式，不锁具体下标）", { skip: codePointSkip }, () => {
  // 旧契约就是这个缺陷本身：span=[1,2]（切在代理对中间），`slice(1,2)` 得到孤立低代理 U+DC00。
  // 新契约只要求"边界落在码位边界上"——不锁具体是 [0,2] 还是别的对齐策略，
  // 否则以后任何合法的对齐方式（整字扩宽 / 换成码位下标）都会让这条误红。
  const cases = [
    ["\u{20000}", "\u{20001}"],         // 单个代理对字整字替换
    ["甲\u{20000}乙", "甲\u{20001}乙"],   // 与普通汉字混排
    ["\u{20000}甲", "\u{20001}甲"],       // 代理对在行首
  ];
  const broken = [];
  for (const [line, candidate] of cases) {
    for (const item of computeCharSpans(line, candidate)) {
      for (const [side, text, index] of [
        ["aStart", line, item.aStart],
        ["aEnd", line, item.aEnd],
        ["bStart", candidate, item.bStart],
        ["bEnd", candidate, item.bEnd],
      ]) {
        if (splitsSurrogatePair(text, index)) broken.push([line, side, index]);
      }
      // 另一面：按区间切片不许切出孤立代理
      const sliced = [...line.slice(item.aStart, item.aEnd)];
      assert.ok(sliced.every((ch) => ch.length > 0), "切片出现空码位（孤立代理被吃掉了）");
      for (const ch of line.slice(item.aStart, item.aEnd)) {
        const code = ch.charCodeAt(0);
        assert.ok(!(code >= 0xdc00 && code <= 0xdfff), `切片结果是孤立低代理 U+${code.toString(16)}`);
      }
    }
  }
  assert.deepEqual(broken, [], "差异区间切开了代理对，按 aStart/aEnd 切片会得到孤立代理");
});

test("代理对混排：对齐前后都落在同一个字框上（锁字框集合，不锁 span 下标）", { skip: readingDiffUnitsSkip }, () => {
  const line = "甲\u{20000}乙";
  const candidate = "甲\u{20001}乙";
  // 契约：差异映射到**哪个字框**才是用户看得见的结果。
  // 旧 span [2,3]（切在代理对中间）与新 span [1,3]（对齐到整字）都只命中字框 1（文本是 𠀀），
  // 所以对齐不改变"画在哪"，只改变"切出来的字符完不完整"。
  const result = diffUnits(line, candidate);
  assert.deepEqual(result.ranges, [1]);
  assert.equal(charBoxes(line)[1].text, "\u{20000}", "字框 1 就是那个两 code unit 的字");
  // 顺带锁住：字框 0/2 不许被扩宽后的区间误选
  assert.equal(result.ranges.includes(0), false);
  assert.equal(result.ranges.includes(2), false);
});

// ---------------------------------------------------------------- 3. 组合字符

test("组合字符：预组合 vs 分解（视觉相同、长度不同）按 replace 处理", () => {
  // "café"(4) vs "cafe" + U+0301(5)：长度不等 → LCS
  assert.deepEqual(norm(computeCharSpans("caf\u00e9", "cafe\u0301")), [[3, 4, 3, 5, "replace"]]);
  assert.deepEqual(norm(computeCharSpans("cafe\u0301", "caf\u00e9")), [[3, 5, 3, 4, "replace"]]);
});

// ---------------------------------------------------------------- 4. 全角标点

test("破折号「——」→「-」：不等长，replace 区间覆盖两个全角码位", { skip: readingDiffUnitsSkip }, () => {
  const line = "他说「好」——真的。";
  const candidate = "他说「好」-真的。";
  assert.deepEqual(norm(computeCharSpans(line, candidate)), [[5, 7, 5, 6, "replace"]]);
  // 经 readingDiffUnits：kind 仍是 chars（区间里没有纯插入/删除），ranges 非空
  assert.deepEqual(diffUnits(line, candidate), { ranges: [5, 6], kind: "chars" });
});

test("全角引号「“”」→ 半角直引号：两个独立的 replace 区间", { skip: readingDiffUnitsSkip }, () => {
  const line = "他说“好”。";
  const candidate = '他说"好"。';
  assert.deepEqual(norm(computeCharSpans(line, candidate)), [
    [2, 3, 2, 3, "replace"],
    [4, 5, 4, 5, "replace"],
  ]);
  assert.deepEqual(diffUnits(line, candidate), { ranges: [2, 4], kind: "chars" });
});

// ---------------------------------------------------------------- 5. 空串 / 全同 / 一方为空

test("空串、全同、一方为空：返回空数组且不崩", () => {
  assert.deepEqual(norm(computeCharSpans("abc", "abc")), []);
  assert.deepEqual(norm(computeCharSpans("", "abc")), []);
  assert.deepEqual(norm(computeCharSpans("abc", "")), []);
  assert.deepEqual(norm(computeCharSpans("", "")), []);
  // 非字符串入参走 String() 兜底，不抛异常
  assert.deepEqual(norm(computeCharSpans(undefined, null)), []);
  assert.deepEqual(norm(computeCharSpans(123, 124)), [[2, 3, 2, 3, "replace"]]);
});

// ---------------------------------------------------------------- 6. 超长行

test("超长行（2000+ 字符，等长快路径）：单次 < 20ms", () => {
  const a = "甲".repeat(1500) + "乙".repeat(500);
  const b = "甲".repeat(1500) + "丙".repeat(500);
  const startedAt = performance.now();
  const spans = computeCharSpans(a, b);
  const elapsed = performance.now() - startedAt;
  // 只锁"差异区被覆盖"和耗时，不锁具体切分：等长快路径给 [1500,2000]，
  // 旧版走 LCS 兜底会给整行 [0,2000]——两种都能覆盖差异，这条用例不替哪条路站队。
  assert.ok(spans.some((item) => item.aEnd > 1500), "差异区没有被任何 span 覆盖");
  assert.ok(elapsed < 20, `跑了 ${elapsed.toFixed(1)}ms，超过 20ms（有人写了 O(n²)?）`);
});

test("超长行不等长（超过 LCS 上限）：整行兜底成一个 replace，且 < 20ms", () => {
  const a = "甲".repeat(1500) + "乙".repeat(500);
  const b = ("甲".repeat(1500) + "丙".repeat(500)).slice(0, 1999); // 2000 × 1999 = 3.998M > 40000
  const startedAt = performance.now();
  const spans = computeCharSpans(a, b);
  const elapsed = performance.now() - startedAt;
  assert.equal(spans.length, 1);
  assert.deepEqual(norm(spans), [[0, 2000, 0, 1999, "replace"]]);
  assert.ok(elapsed < 20, `跑了 ${elapsed.toFixed(1)}ms，超过 20ms`);
});

test("LCS 单元格上限（40000）的边界：超过就整行兜底，不超过就走 LCS", () => {
  // 用"共同前缀 + 不同尾巴"区分两条路：兜底会连共同前缀一起吞掉，LCS 会从差异处开始。
  const prefix = "甲".repeat(100);
  // 201 × 200 = 40200 > 40000 → 整行兜底（共同前缀也被吞进 replace）
  const over = computeCharSpans(prefix + "乙".repeat(101), prefix + "丙".repeat(100));
  assert.deepEqual(norm(over), [[0, 201, 0, 200, "replace"]]);
  // 199 × 200 = 39800 ≤ 40000 → 走 LCS，共同前缀保留，差异从下标 100 开始
  const under = computeCharSpans(prefix + "乙".repeat(99), prefix + "丙".repeat(100));
  assert.deepEqual(norm(under), [[100, 199, 100, 200, "replace"]]);
});
