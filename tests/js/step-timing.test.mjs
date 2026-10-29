// StepTiming 单测：只锁"数对不对"，不断言调用次数/顺序。
// 假时钟由用例推进（`clock.at`），不依赖真实时间，跑得比一帧还快。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const MODULE = new URL("../../backend/book2text/static/step-timing.js", import.meta.url);

/** 可控定时器：模块的 500ms 判定必须在用例手里，不能等真实时间。 */
function makeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(fn, ms) {
      const entry = { fn, ms, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout(entry) {
      if (entry) entry.cancelled = true;
    },
    /** 跑最近挂上的那个（=当前有效的 500ms 判定）。 */
    run() {
      const entry = pending.pop();
      if (entry && !entry.cancelled) entry.fn();
    },
    active() {
      return pending.filter((entry) => !entry.cancelled);
    },
  };
}

function setup(options = {}) {
  const clock = { at: 1_000_000 };
  const timers = makeTimers();
  const sandbox = { window: {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MODULE, "utf8"), sandbox, { filename: "step-timing.js" });
  const timings = sandbox.StepTiming;
  timings.init({
    now: () => clock.at,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    steps: options.steps || ["review"],
  });
  return { clock, timers, timings, metrics: () => sandbox.__b2tStepTiming };
}

test("enter/leave：墙钟累计，重复 enter 不在同一步里重复计时", () => {
  const { clock, timings } = setup();
  timings.enter("review");
  clock.at += 5_000;
  timings.enter("review");            // 重绘会反复调：不许再记一次
  clock.at += 5_000;
  const spent = timings.leave();
  const step = timings.snapshot().steps.review;
  assert.equal(spent, 10_000);
  assert.equal(step.ms, 10_000);
  assert.equal(step.visits, 1);
});

test("切步骤：自动离开上一步，两步各自累计", () => {
  const { clock, timings } = setup({ steps: ["pages", "review"] });
  timings.enter("pages");
  clock.at += 3_000;
  timings.enter("review");            // 切到审校
  clock.at += 7_000;
  timings.leave();
  const shot = timings.snapshot();
  assert.equal(shot.steps.pages.ms, 3_000);
  assert.equal(shot.steps.review.ms, 7_000);
  assert.equal(shot.totalMs, 10_000);
  assert.equal(shot.current, null);
});

test("没有当前步时 bump 不记（不替调用方猜这算哪一步）", () => {
  const { timings } = setup();
  assert.equal(timings.bump("page"), null);
  assert.equal(Object.keys(timings.snapshot().steps.review.actions).length, 0);
});

test("bump：按动作名分别计数，未知动作也照记（分析时只认那四个）", () => {
  const { clock, timings } = setup();
  timings.enter("review");
  clock.at += 1_000;
  timings.bump("judge");
  timings.bump("judge");
  timings.bump("panel");
  timings.bump("自定义");
  const step = timings.snapshot().steps.review;
  assert.equal(step.actions.judge, 2);
  assert.equal(step.actions.panel, 1);
  assert.equal(step.actions["自定义"], 1);
});

test("卡住的可数口径：同一步内两次动作间隔 ≥ 60 秒记一次 idleOver60s", () => {
  const { clock, timings } = setup();
  timings.enter("review");
  clock.at += 61_000;                 // 盯着屏幕一分钟没动
  timings.bump("judge");
  clock.at += 30_000;                 // 半分钟不算
  timings.bump("judge");
  const step = timings.snapshot().steps.review;
  assert.equal(step.idleOver60s, 1);
  assert.equal(step.longestIdleMs, 61_000);
});

test("longestIdleMs 只记最长的一次（判断是卡一次还是全程慢）", () => {
  const { clock, timings } = setup();
  timings.enter("review");
  clock.at += 90_000;
  timings.bump("judge");
  clock.at += 70_000;
  timings.bump("judge");
  assert.equal(timings.snapshot().steps.review.longestIdleMs, 90_000);
});

test("snapshot 是深拷贝：改快照不影响正在进行的统计", () => {
  const { timings } = setup();
  timings.enter("review");
  const shot = timings.snapshot();
  shot.steps.review.actions.page = 99;
  shot.totalMs = -1;
  const again = timings.snapshot();
  assert.equal(again.steps.review.actions.page, undefined);
  assert.equal(again.totalMs, 0);
});

test("没访问过的预建步骤也在快照里（分母要稳定）", () => {
  const { timings } = setup({ steps: ["index", "review", "export"] });
  timings.enter("review");
  const shot = timings.snapshot();
  assert.deepEqual(Object.keys(shot.steps).sort(), ["export", "index", "review"]);
  assert.equal(shot.steps.export.ms, 0);
});

test("live 对象就是 window.__b2tStepTiming：QA 直接读它，不用先 snapshot", () => {
  const { clock, timings, metrics } = setup();
  timings.enter("review");
  clock.at += 2_000;
  timings.leave();
  assert.equal(metrics().totalMs, 2_000);
  assert.equal(metrics().steps.review.ms, 2_000);
});

// `stalls` / `stuck` / `consecutiveStalls` / `longestStallMs` 与那个 500ms 定时器
// 于 2026-10-29 整批删除（死因见 docs/known-limitations.md L-110：`bump()` 先更新进度键
// 再挂判定，判定基准已是"动作之后"的键 → 253 次动作产生 252 次 stall，恒等于动作数）。
// 这里改成**守住删除本身**：字段不许再冒出来，否则有人会把它当"卡住次数"读。
test("卡住口径已删除：快照里不许再出现 stalls / stuck / longestStallMs", () => {
  const { timings } = setup();
  timings.enter("review");
  timings.bump("judge", { pageNo: 3, judged: 1, panel: "" });
  const step = timings.snapshot().steps.review;
  for (const gone of ["stalls", "stuck", "consecutiveStalls", "longestStallMs"]) {
    assert.ok(!(gone in step), `字段 ${gone} 又回来了——这条判据已被证伪，别重新发明（L-110）`);
  }
  for (const kept of ["visits", "ms", "msSoFar", "idleOver60s", "longestIdleMs", "actions"]) {
    assert.ok(kept in step, `可用字段 ${kept} 被删掉了`);
  }
});

test("快照把当前步的进行中时间算进 msSoFar（否则跑完 40 页审校那格还是 0）", () => {
  const { clock, timings } = setup({ steps: ["pages", "review"] });
  timings.enter("pages");
  clock.at += 4_000;
  timings.enter("review");
  clock.at += 6_000;                  // 审校还没离开
  const shot = timings.snapshot();
  assert.equal(shot.steps.pages.ms, 4_000);
  assert.equal(shot.steps.pages.msSoFar, 4_000);
  assert.equal(shot.steps.review.ms, 0, "结算值还没到 leave，就该是 0");
  assert.equal(shot.steps.review.msSoFar, 6_000);
  assert.equal(shot.totalMs, 4_000);
  assert.equal(shot.totalMsSoFar, 10_000);
});
