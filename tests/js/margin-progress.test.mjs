// 版心检测进度：**数据 → 文案**这一层（引擎在不在跑，是 QA 真机那条的事）。
//
// 为什么单独一层：真机验的是"引擎真的在跑时数字会涨"，这里验的是"数字来了以后显示对不对"。
// 后者能覆盖前者覆盖不到的边界（缺字段 / done > total / total = 0）——那些形态在真机上很难碰，
// 但一条 NaN 印在界面上，用户一眼就能看见。
//
// 入口只用公共能力 `onTaskProgress(data)`（刀 9.2 起外壳只给数据、由模块决定画什么）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = readFileSync(
  fileURLToPath(new URL("../../backend/book2text/static/pages-view.js", import.meta.url)), "utf8",
);

const makeNode = (id) => ({
  id, textContent: "", hidden: false, style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  appendChild() {}, append() {}, closest: () => null, focus() {},
});

/** 起一个最小环境，喂一份 job payload，返回界面上的两处读数。 */
function renderProgress(data) {
  const els = new Map();
  const ctx = {
    document: {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeNode(id));
        return els.get(id);
      },
      body: makeNode("body"), documentElement: makeNode("html"), activeElement: makeNode("active"),
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      createElement: (tag) => makeNode(tag),
    },
    console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}, setTimeout: () => 0, clearTimeout() {},
    innerHeight: 800,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "pages-view.js" });
  const deps = {};
  for (const name of new Set([...SRC.matchAll(/injected\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))) {
    deps[name] = () => undefined;
  }
  Object.assign(deps, {
    getCurrentProject: () => ({ pages: [] }),
    estimateRemainingSeconds: () => 0,
    formatDuration: () => "0 秒",
    pageImageUrl: () => "",
  });
  ctx.window.PagesView.init(deps);
  ctx.window.PagesView.onTaskProgress(data);
  return {
    text: els.get("margin-fit-text") ? els.get("margin-fit-text").textContent : "",
    width: els.get("margin-fit-fill") ? els.get("margin-fit-fill").style.width : "",
  };
}

const layout = (fields) => ({ job: { job_type: "layout", status: "running", ...fields } });

test("进度文案（三态）：空 0/N / 中途 k/N / 满 N/N 各写各的，且百分比跟着走", () => {
  const empty = renderProgress(layout({ done: 0, failed: 0, total: 200 }));
  assert.equal(empty.text, "正在检测版面… 0 / 200 页", "空态文案不对");
  assert.equal(empty.width, "0%", "空态进度条不是 0%");

  const middle = renderProgress(layout({ done: 37, failed: 0, total: 200 }));
  assert.equal(middle.text, "正在检测版面… 37 / 200 页", "中途文案不对");
  assert.equal(middle.width, "19%", "中途百分比不对（37/200 应四舍五入成 19%）");

  const full = renderProgress(layout({ done: 200, failed: 0, total: 200 }));
  assert.equal(full.text, "正在检测版面… 200 / 200 页", "满态文案不对");
  assert.equal(full.width, "100%", "满态进度条不是 100%");
});

test("进度文案（失败也算做过）：done 与 failed 相加，暂停加后缀", () => {
  const withFailed = renderProgress(layout({ done: 30, failed: 7, total: 200 }));
  assert.equal(withFailed.text, "正在检测版面… 37 / 200 页", "failed 没算进已做页数");

  const paused = renderProgress(layout({ done: 50, failed: 0, total: 200, status: "paused" }));
  assert.equal(paused.text, "正在检测版面… 50 / 200 页（已暂停）", "暂停态没标（已暂停）");
});

test("进度文案（不是版心任务不写）：auxiliary / 已结束的任务不许动这块文案", () => {
  const aux = renderProgress({ job: { job_type: "auxiliary", status: "running", done: 5, failed: 0, total: 200 } });
  assert.equal(aux.text, "", "识别任务把版心进度条写了");
  const doneJob = renderProgress(layout({ done: 5, failed: 0, total: 200, status: "succeeded" }));
  assert.equal(doneJob.text, "", "已经结束的任务还在写「正在检测」");
});

test("进度文案（数字取任务、不取项目）：项目页数与任务 total 不一致时，以 payload 为准", () => {
  // 任务开始后还能加页/删页，所以「当前项目有多少页」不等于「这次检测要跑多少页」。
  // 显示必须跟任务走，否则进度会莫名其妙地超过 100% 或永远差几页。
  const drifted = renderProgress(layout({ done: 200, failed: 0, total: 200 }));
  assert.equal(drifted.text, "正在检测版面… 200 / 200 页", "任务跑完后仍在按项目页数写文案");
  assert.equal(drifted.width, "100%", "任务跑完但进度条没到 100%");
});

test("进度文案（退化 total = 0）：0 / 0 页、进度条 0%，不许 NaN", () => {
  const zero = renderProgress(layout({ done: 0, failed: 0, total: 0 }));
  assert.equal(zero.text, "正在检测版面… 0 / 0 页", "total = 0 的文案不对");
  assert.equal(zero.width, "0%", "total = 0 时进度条不是 0%（除零会出 NaN%）");
});

test("进度文案（退化缺字段）：total 缺字段不许印 undefined，done 缺字段不许印 NaN", () => {
  const noTotal = renderProgress(layout({ done: 5, failed: 0 }));
  assert.ok(!noTotal.text.includes("undefined"), `total 缺字段时文案印出了 undefined：${noTotal.text}`);
  assert.ok(!noTotal.width.includes("NaN"), `total 缺字段时宽度是 ${noTotal.width}`);

  const noDone = renderProgress(layout({ failed: 0, total: 200 }));
  assert.ok(!noDone.text.includes("NaN"), `done 缺字段时文案印出了 NaN：${noDone.text}`);
  assert.ok(!noDone.width.includes("NaN"), `done 缺字段时宽度是 ${noDone.width}`);
});

test("进度文案（退化 done > total）：显示夹在 100%，不许出现 300 / 200 页这种读数", () => {
  const over = renderProgress(layout({ done: 300, failed: 0, total: 200 }));
  assert.equal(over.width, "100%", `done > total 时宽度没夹住：${over.width}`);
  assert.ok(!/300 \/ 200/.test(over.text), `done > total 时文案照抄了超出的读数：${over.text}`);
});
