/**
 * StepTiming —— 步骤耗时与卡点插桩（2026-10-29）。
 *
 * **只读统计，不改行为**：不写 DOM、不发请求、不拦事件、不改任何返回值；
 * 调用方在关键位置 `enter / leave / bump / progress` 一下，数据进 `window.__b2tStepTiming`。
 * 形态照 `__b2tIndexMetrics` / `__b2tReadingMetrics`：一个只读全局对象，QA 与单测直接读。
 *
 * 口径（Chief 2026-10-29 定稿，改字段前先改这节）：
 * - `ms` 是**墙钟**，只算 `enter` 到 `leave` 之间；同一时刻只有一步是 `current`；
 * - 重复 `enter` 同一步**不重复计时**（视图重绘会反复调，不能把重绘算成用户时间）；
 * - `totalMs` = 各步 `ms` 之和；
 * - **卡住 = 无进展**：一次动作后 500ms 内，进度键（`pageNo` / 已判条数 / 面板开合）没变化
 *   → `stalls + 1`；同一步连续 3 次 → `stuck: true`；`longestStallMs` 记最长的那次；
 * - `idleOver60s` / `longestIdleMs` **只作发现**（无动作间隔），**不参与"卡住"判定**。
 *
 * **进度键必须由接入点传进来**（Architect 2026-10-29）：模块只接收调用方递来的快照，
 * **不许自己去读别的模块状态**——否则它立刻变成第二个写点。
 *
 * **同一个 500ms 判定只能挂一个定时器**：每次动作先 `clearTimeout` 上一次，`leave` 清空。
 * 40 页审校动辄上百次动作，一次动作一个 timer 就是上百个隐形状态源，而且只在手快时出现。
 *
 * 不负责什么：不判"这一步该多久"、不判好坏、不上报、不落盘。它只产生数。
 */
(function () {
  "use strict";

  const IDLE_MS = 60 * 1000;
  const STALL_MS = 500;
  const STUCK_AFTER = 3;
  const ACTIONS = ["page", "judge", "panel", "back"];

  let clock = () => Date.now();
  // 没有定时器的环境（某些单测沙箱）里，卡住判定自动降级为关闭，但**不许让页面崩**：
  // 只读统计模块崩掉，比少一个指标坏得多。
  let setTimer = typeof setTimeout === "function" ? (fn, ms) => setTimeout(fn, ms) : () => null;
  let clearTimer = typeof clearTimeout === "function" ? (id) => clearTimeout(id) : () => {};
  let stallTimer = null;
  let live = null;

  const now = () => {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  };

  /** 进度键的规范化：同一个快照内容算同一把键（对象引用不同不算"变了"）。 */
  function keyOf(progress) {
    if (progress === undefined || progress === null) return "";
    try {
      return JSON.stringify(progress);
    } catch (error) {
      return String(progress);
    }
  }

  function makeStep(name) {
    return {
      name,
      visits: 0,
      ms: 0,
      enteredAt: null,
      leftAt: null,
      lastActionAt: null,
      progressKey: "",
      progressAt: null,
      stalls: 0,
      consecutiveStalls: 0,
      stuck: false,
      longestStallMs: 0,
      idleOver60s: 0,
      longestIdleMs: 0,
      actions: {},
    };
  }

  function recordOf(step) {
    if (!live.steps[step]) live.steps[step] = makeStep(step);
    return live.steps[step];
  }

  function cancelStall() {
    if (stallTimer !== null) {
      clearTimer(stallTimer);
      stallTimer = null;
    }
  }

  /**
   * 挂上这一次的 500ms 判定。**先取消上一次**——同一个 500ms 判定同时只允许一个定时器。
   * 触发时比对进度键：变了 = 有进展，不计；没变 = 一次"卡住"。
   */
  function armStall(record) {
    cancelStall();
    const keyAtArm = record.progressKey;
    const stepName = record.name;
    stallTimer = setTimer(() => {
      stallTimer = null;
      if (!live.current || live.current !== stepName) return;   // 已经切走：这一步的判定作废
      const current = recordOf(stepName);
      if (keyOf(live.progress) !== keyAtArm) {
        current.consecutiveStalls = 0;                          // 有进展
        return;
      }
      const at = now();
      current.stalls += 1;
      current.consecutiveStalls += 1;
      const since = current.progressAt === null ? STALL_MS : Math.max(0, at - current.progressAt);
      if (since > current.longestStallMs) current.longestStallMs = since;
      if (current.consecutiveStalls >= STUCK_AFTER) current.stuck = true;
    }, STALL_MS);
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
    record.progressAt = at;
    record.progressKey = keyOf(live.progress);
    live.current = name;
    return name;
  }

  /** 离开某一步（默认当前步）。没进过就不记，绝不凭空造时间；同时清掉挂着的判定。 */
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
    if (live.current === name) {
      live.current = null;
      if (stallTimer !== null) cancelStall();
    }
    return spent;
  }

  /**
   * 更新进度快照（被动输入，不是动作）：由接入点递进 `pageNo` / 已判条数 / 面板开合的当前值。
   * 键变了 = 有进展 → 连续 stall 清零。**不取消**已经挂上的 500ms 判定（那一次仍要看结果）。
   */
  function timingProgress(progress) {
    const name = live.current;
    if (!name) return null;
    const record = recordOf(name);
    const key = keyOf(progress);
    live.progress = progress;
    if (key !== record.progressKey) {
      record.progressKey = key;
      record.progressAt = now();
      record.consecutiveStalls = 0;
    }
    return record.progressKey;
  }

  /**
   * 记一次动作。`action` 约定 `page` / `judge` / `panel` / `back`（别的名字照记，分析只认四个）。
   * 第二个参数可选：顺手递一份进度快照，等价于先 `progress(snapshot)`。
   * @returns {string|null} 记到哪一步了，没有当前步时返回 null（不替调用方猜）
   */
  function bump(action, progress) {
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
    if (progress !== undefined) timingProgress(progress);
    armStall(record);
    return name;
  }

  /** 只读快照：深拷贝，改它不会污染正在进行的统计。 */
  function snapshot() {
    return {
      totalMs: live.totalMs,
      current: live.current,
      steps: JSON.parse(JSON.stringify(live.steps)),
      actions: ACTIONS.slice(),
    };
  }

  /**
   * @param {{now?: () => number, setTimeout?: Function, clearTimeout?: Function, steps?: string[]}} [deps]
   *   `now` / 定时器只在单测里注入；`steps` 预建（没访问过的步骤也出现在快照里，分母才稳定）。
   */
  function timingInit(deps) {
    const options = deps || {};
    cancelStall();
    if (typeof options.now === "function") clock = options.now;
    if (typeof options.setTimeout === "function") setTimer = options.setTimeout;
    if (typeof options.clearTimeout === "function") clearTimer = options.clearTimeout;
    live = { totalMs: 0, current: null, progress: null, steps: {} };
    window.__b2tStepTiming = live;
    for (const step of options.steps || []) recordOf(String(step));
    return api;
  }

  const api = { init: timingInit, enter: timingEnter, leave: timingLeave, bump, progress: timingProgress, snapshot };

  timingInit();               // 默认就绪：没 init 也能安全调用（只读统计不许让页面崩）
  window.StepTiming = api;
})();
