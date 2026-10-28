// readingDiffUnits(lineText, candidate, wordBoxes) 的单元测试。
//
// 被测函数：backend/book2text/static/app.js:19945（HEAD）。它决定"这一行的差异画在哪些字框上"，
// 改坏过一次：英文 13,876 行全部退化成整行色块。这里的用例就是把那次事故锁住。
//
// 语义备忘（读代码确认过，不是猜的）：
// - 两条映射分支：wordBoxes 的文本拼接长度 == 行文本长度 → 按偏移映射（中文逐字框）；
//   否则 → 在行文本里按位置找词（英文词间空格不属于任何框）。
// - 找不到词就**整行退化**：ranges = null（调用方拿到 null 只画行框，不画字块）。
// - kind 的真实含义是「差异区间里有没有纯插入/删除」，不是「差异是不是标点」：
//   "chars" = 全是替换，"punct" = 含插入或删除；没有差异时 kind = null。
//   kind 只用于挑 CSS class（reading-diff-box--punct）。
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./load-app.mjs";
import { loadReadingView } from "./load-reading-view.mjs";

// L11：`readingDiffUnits` 搬进 reading-view.js。它不是公开导出（R8 只有 6 个稳定项），
// 所以用模块单元加载器剥掉 IIFE 取到它；它依赖的两个注入项从 app.js 那个上下文里接过来：
// - `computeCharSpans` 仍住 app.js；
// - `getWordBoxMappingStats` 拿的是 app.js 挂到 window 上的同一个统计对象（分支计数靠它）。
const app = loadApp({ require: ["computeCharSpans"] });
const module = loadReadingView({ require: ["readingDiffUnits"] });
// L12：分支统计对象 `window.__b2tWordBoxStats` 也跟着函数搬进模块了 —— 从**模块上下文**读，
// 从 app.js 读只会拿到 undefined（然后所有分支计数断言都变成"没有埋点"的假红）。
const stats = module.ctx.window.__b2tWordBoxStats;
module.setInjected({
  computeCharSpans: app.computeCharSpans,
  getWordBoxMappingStats: () => stats,
});
const readingDiffUnits = module.ctx.readingDiffUnits;

/**
 * vm 里返回的数组/对象来自**另一个 realm**（不同的 Array/Object 原型），
 * assert.deepStrictEqual 会按原型判等而误报"same structure but not reference-equal"。
 * 这里做一次 JSON 归一化，比较的是值而不是原型。
 */
function norm(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 分支计数埋点在旧版 app.js 里不存在（window.__b2tWordBoxStats 是后加的）。
 * 缺了就明确说"这个版本没有埋点"，而不是抛一个看不出所以然的 TypeError。
 */
function requireStats() {
  if (!stats) {
    assert.fail("被测版本没有 window.__b2tWordBoxStats —— 无法用计数证明走了哪条分支");
  }
  return stats;
}

/** 逐字造字框：拼接长度等于行文本长度，走偏移分支。 */
function charBoxes(text) {
  return [...text].map((ch, index) => ({ text: ch, bbox: [index * 0.1, 0, index * 0.1 + 0.1, 1] }));
}

/** 逐词造字框：不含空格，拼接长度小于行文本长度，走位置分支。 */
function wordBoxes(lineText) {
  return lineText.split(" ").map((word, index) => ({ text: word, bbox: [index * 0.2, 0, index * 0.2 + 0.18, 1] }));
}

// 1. 中文等长逐字框 → 偏移分支
test("中文等长逐字框：走偏移分支，差异字落在一个框上", () => {
  const line = "春天来了。";
  requireStats();
  const offsetBefore = stats.offset;
  const result = readingDiffUnits(line, "春天来了！", charBoxes(line));
  assert.deepEqual(norm(result.ranges), [4]); // 第 5 个字「。」→「！」
  assert.equal(result.kind, "chars"); // 等长纯替换
  assert.equal(stats.offset, offsetBefore + 1, "应当走偏移分支（不增加位置分支计数）");
});

// 2. 英文多词、词间有空格 → 位置分支。【事故回归：旧版只按偏移算，这里返回 null 整行退化】
test("英文词框不含空格：走位置分支，不会整行退化", () => {
  const line = "The quick brown fox";
  requireStats();
  const positionBefore = stats.position;
  const result = readingDiffUnits(line, "The quick red fox", wordBoxes(line));
  // 旧版（5ad3599 及更早）在这里返回 ranges: null —— 这就是 13,876 行退化成整行的那个 bug
  assert.deepEqual(norm(result.ranges), [2]); // brown → red，只有第 3 个词
  assert.equal(result.kind, "punct"); // brown(5 字) → red(3 字)，含纯删除
  assert.equal(stats.position, positionBefore + 1, "应当走位置分支");
  assert.equal(stats.positionMiss, 0, "这四个词都能在行里找到，不该记 miss");
});

// 3. 没有字框：ranges 为 null（调用方退化画行框），但 kind 仍要为调用方算对
test("word_boxes 为空数组或 null：ranges 为 null，kind 仍正确", () => {
  assert.deepEqual(norm(readingDiffUnits("ABCD", "ABxD", [])), { ranges: null, kind: "chars" });
  assert.deepEqual(norm(readingDiffUnits("ABCD", "ABxD", null)), { ranges: null, kind: "chars" });
});

// 4. 词在行文本里找不到 → 整行退化，不许抛异常
test("某个字框的词在行里找不到：ranges 为 null 且不抛异常", () => {
  // 字框文本和行文本对不上（回填失败/数据脏）
  const result = readingDiffUnits("alpha beta", "alpha gamma", [
    { text: "alpha", bbox: [0, 0, 0.2, 1] },
    { text: "zzz", bbox: [0.2, 0, 0.4, 1] },
  ]);
  assert.deepEqual(norm(result), { ranges: null, kind: "chars" });
});

// 4b. 游标只向前推进：前面的词不能拿来复用
test("位置查找的游标只向后推进：逆序字框不会误命中前面的词", () => {
  // 字框顺序是 [beta, alpha]，找到 beta（位置 6）后游标到 10，alpha 在位置 0，不能再回去命中
  const result = readingDiffUnits("alpha beta", "alpha gamma", [
    { text: "beta", bbox: [0, 0, 0.2, 1] },
    { text: "alpha", bbox: [0.2, 0, 0.4, 1] },
  ]);
  assert.deepEqual(norm(result), { ranges: null, kind: "chars" });
});

// 5. 全角/半角码位不一致：破折号「——」vs「-」
test("全角破折号换成半角：两个全角码位都落进 ranges，不退化", () => {
  const line = "他说「好」——真的。";
  const result = readingDiffUnits(line, "他说「好」-真的。", charBoxes(line));
  // 差异是「——」(码位 5,6) → 「-」；两个全角破折号的框都要标出来
  assert.deepEqual(norm(result.ranges), [5, 6]);
  // 注意：这里 kind 是 "chars" 而不是 "punct"——LCS 把「——」→「-」算成一个替换区间，
  // 没有纯插入/删除，所以走 chars 样式。kind 反映的是区间形状，不是"差异是否标点"。
  assert.equal(result.kind, "chars");
});

// 5b. 全角引号换成半角直引号（等长替换）
test("全角引号换成半角直引号：两个引号框各自命中，不退化", () => {
  const line = "他说“好”。";
  const result = readingDiffUnits(line, '他说"好"。', charBoxes(line));
  assert.deepEqual(norm(result.ranges), [2, 4]); // “ → " (码位 2)，” → " (码位 4)
  assert.equal(result.kind, "chars");
});

// 6. 同一行重复词：游标必须推进，最后一处差异不能串到第一个框
test("重复词：差异落在最后一处，不串到第一个同名词框", () => {
  // 三个 "go" 的框起点是 0 / 3 / 6；只有第 3 个（起点 6）该被标出来
  const result = readingDiffUnits("go go go", "go go no", [
    { text: "go", bbox: [0, 0, 0.1, 1] },
    { text: "go", bbox: [0.1, 0, 0.2, 1] },
    { text: "go", bbox: [0.2, 0, 0.3, 1] },
  ]);
  assert.deepEqual(norm(result.ranges), [2]);
});

// 6b. 中文按词框（不是逐字框）时也要能走位置分支
test("中文按词框：拼接长度不等于行长度，走位置分支", () => {
  // 词框只覆盖前 4 个字，差异字「来」→「走」落在第二个词框里
  const result = readingDiffUnits("春天来了", "春天走了", [
    { text: "春天", bbox: [0, 0, 0.2, 1] },
    { text: "来了", bbox: [0.2, 0, 0.4, 1] },
  ]);
  assert.deepEqual(norm(result.ranges), [1]);
  assert.equal(result.kind, "chars");
});

test("差异字不在任何词框覆盖范围内：ranges 为空数组（调用方只画行框）", () => {
  // 「。」没有对应的词框，没有字框可标——这是行的退化，不是整行映射失败
  const result = readingDiffUnits("春天来了。", "春天来了！", [
    { text: "春天", bbox: [0, 0, 0.2, 1] },
    { text: "来了", bbox: [0.2, 0, 0.4, 1] },
  ]);
  assert.deepEqual(norm(result.ranges), []);
});

// 7. 纯替换（等长、无插入/删除）→ kind 为 "chars"
test("等长纯替换：kind 为 chars", () => {
  const line = "The cat sat";
  const result = readingDiffUnits(line, "The dog sat", wordBoxes(line));
  assert.deepEqual(norm(result.ranges), [1]); // cat → dog
  assert.equal(result.kind, "chars");
});

// 8. candidate 比 line 短 → 删除区间落在具体框上
test("candidate 更短：删除区间的字框被标出，kind 为 punct", () => {
  const line = "他说：「走。」";
  const result = readingDiffUnits(line, "他说：「走。", charBoxes(line));
  assert.deepEqual(norm(result.ranges), [6]); // 删掉末尾的 」
  assert.equal(result.kind, "punct");
});

// 8b. candidate 比 line 长 → 行尾插入：没有字框可标，ranges 为空数组（不是 null）
test("candidate 更长且差异在行尾：ranges 为空数组，kind 为 punct", () => {
  const result = readingDiffUnits("你好", "你好吗", charBoxes("你好"));
  assert.deepEqual(norm(result.ranges), []);
  assert.equal(result.kind, "punct");
});

// 9. 没有差异 / 空输入 → 不进入映射，ranges 为空，kind 为 null
test("行与候选相同、以及空输入：ranges 为空数组，kind 为 null", () => {
  const line = "同一行";
  assert.deepEqual(norm(readingDiffUnits(line, line, charBoxes(line))), { ranges: [], kind: null });
  assert.deepEqual(norm(readingDiffUnits("", "", [])), { ranges: [], kind: null });
});
