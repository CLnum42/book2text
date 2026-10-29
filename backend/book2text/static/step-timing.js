/**
 * StepTiming —— 步骤耗时与卡点插桩（2026-10-29，用户口述基线需要分段数据）。
 *
 * **只读统计，不改行为**：本模块不写 DOM、不发请求、不拦事件、不改任何返回值；
 * 调用方在关键位置 `enter / leave / bump` 一下，数据进 `window.__b2tStepTiming`。
 *
 * 为什么要有它：用户说"全部弄完约 2 小时"，但**审校占多少、卡在哪一步，没人量过**。
 * 没有分段数据就重设计 = 靠感觉改（Chief 2026-10-29）。形态照 `__b2tIndexMetrics` /
 * `__b2tReadingMetrics`：一个只读全局对象，QA 与单测都能直接读。
 *
 * 口径（写死，防止下次又出两套数）：
 * - `ms` 是**墙钟**，只算 `enter` 到 `leave` 之间；同一时刻只有一步是 `current`；
 * - 重复 `enter` 同一步**不重复计时**（视图重绘会反复调，不能把重绘算成用户时间）；
 * - `totalMs` = 各步 `ms` 之和；一次会话的总时长由调用方自己记（`enter` 第一次之前的时间不算）；
 * - `idleOver60s`：同一步内两次动作间隔 ≥ 60 秒的次数——**这是"卡住"的可数替代指标**，
 *   比"用户感觉卡"可机检，也不和"连续 20 分钟不求助"冲突；
 * - `longestIdleMs`：同一步内最长的无动作间隔，用来判断"是卡了一次还是全程慢"。
 *
 * 键名（`actions`）：`page` 翻页 / `judge` 逐条判 / `panel` 差异面板切换 / `back` 回退上一步。
 * 只约定这四个，别的动作可以继续加（`bump("任意名字")`），但**分析时只认这四个**。
 *
 * 不负责什么：不算"这一步该多久"、不判好坏、不上报、不落盘。它只产生数。
 */
(function () {
  "use strict";

  const IDLE_MS = 60 * 1000;
  const ACTIONS = ["page", "judge", "panel", "back"];

  let clock = () => Date.now();
  let live = null;

  const now = () => {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  };

  function makeStep() {
    return {
      visits: 0,
      ms: 0,
      enteredAt: null,
      leftAt: null,
      lastActionAt: null,
      idleOver60s: 0,
      longestIdleMs: 0,
      actions: {},
    };
  }

  function recordOf(step) {
    if (!live.steps[step]) live.steps[step] = makeStep();
    return live.steps[step];
  }

  /** 进入某一步。已经在同一步里就什么都不做（重绘会反复调）。 */
  function timingEnter(step) {
    const name = String(step || "");
    if (!name || live.current === name) return live.current;
    if (live.current) timingLeave(live.current);
    const record = recordOf(name);
    const at = now();
    record.visits += 1;
    record.enteredAt = at;
    record.lastActionAt = at;
    live.current = name;
    return name;
  }

  /** 离开某一步（默认当前步）。没进过就不记，绝不凭空造时间。 */
  function timingLeave(step) {
    const name = String(step || live.current || "");
    if (!name) return null;
    const record = live.steps[name];
    if (!record || record.enteredAt === null) return null;
    const at = now();
    const spent = Math.max(0, at - record.enteredAt);
    record.ms += spent;
    record.leftAt = at;
    record.enteredAt = null;
    live.totalMs += spent;
    if (live.current === name) live.current = null;
    return spent;
  }

  /**
   * 记一次动作。`action` 约定见文件头；没有当前步时不记（不替调用方猜"这算哪一步"）。
   * @returns {string|null} 记到哪一步了，没记返回 null
   */
  function bump(action) {
    const name = live.current;
    if (!name) return null;
    const key = String(action || "");
    if (!key) return null;
    const record = recordOf(name);
    const at = now();
    if (record.lastActionAt !== null) {
      const idle = Math.max(0, at - record.lastActionAt);
      if (idle >= IDLE_MS) record.idleOver60s += 1;
      if (idle > record.longestIdleMs) record.longestIdleMs = idle;
    }
    record.actions[key] = (record.actions[key] || 0) + 1;
    record.lastActionAt = at;
    return name;
  }

  /** 只读快照：调用方拿到的是深拷贝，改它不会污染正在进行的统计。 */
  function snapshot() {
    return {
      totalMs: live.totalMs,
      current: live.current,
      steps: JSON.parse(JSON.stringify(live.steps)),
      actions: ACTIONS.slice(),
    };
  }

  /**
   * @param {{now?: () => number, steps?: string[]}} [deps]
   *   `now` 只在单测里注入假时钟；`steps` 预先建好（让没有访问过的步骤也能出现在快照里）。
   */
  function timingInit(deps) {
    const options = deps || {};
    if (typeof options.now === "function") clock = options.now;
    live = { totalMs: 0, current: null, steps: {} };
    window.__b2tStepTiming = live;
    for (const step of options.steps || []) recordOf(String(step));
    return api;
  }

  const api = { init: timingInit, enter: timingEnter, leave: timingLeave, bump, snapshot };

  timingInit();               // 默认就绪：没 init 也能安全调用（只读统计不许让页面崩）
  window.StepTiming = api;
})();
