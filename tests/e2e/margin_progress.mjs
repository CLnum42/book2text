/**
 * 版心检测进度条真机探针（只读，不点按钮、不建任务、不留临时文件）。
 *
 * 验的是：布局检测任务（job_type="layout"）运行时，
 *   #margin-fit-progress / #margin-fit-fill / #margin-fit-text 是否跟着 job.done 真增长，
 * 以及检测期间该元素有没有被「自动拟合版心」的进度抢走（样本级判据）。
 *
 * 用法（配置从 globalThis.OVERRIDE 读，ego 的 nodejs 不传 argv/env）：
 *
 *   { echo 'globalThis.OVERRIDE={base:"http://127.0.0.1:8871",token:"qa4",project:"b2t_T7JH61",maxPages:40,intervalMs:1000}'; \
 *     cat tests/e2e/margin_progress.mjs; } | ego-browser nodejs
 *
 * 起任务仍按 runbook 手工做：随便在哪边起一个 M ≥ 20 的「检测版面」任务，
 * 探针会先等**新的** layout 任务出现（默认等 120 秒），再开始采样。
 *
 * 退出码：0 全过 · 1 J6 或 J8 不过（可直接当回归用）· 2 用法/前置不满足（没配置、等不到任务）。
 *
 * J8 的口径（Chief 2026-11-01 明确）：判的是**元素上同一时刻只有一个写者**，
 * 不是"自动拟合必须停下来"。拟合任务在后台继续请求 / 写盘、但元素上始终显示检测文案，
 * 属符合设计——探针只读 DOM，不数网络请求，所以不会把"后台还在跑"误判成红。
 * 判据定义与证据格式见 docs/real-machine-verification.md §6。
 */

const CFG = {
  base: null,          // 例：http://127.0.0.1:8871
  token: "qa4",
  project: null,       // 例：b2t_T7JH61
  maxPages: 40,        // 期望的任务页数（只用于 J4 的"样本够不够"判断与提示）
  intervalMs: 1000,    // 采样间隔
  jobWaitSeconds: 120, // 等新任务出现的上限
  settleSeconds: 6,    // 任务结束后再等多久读收尾（5 秒是 finishMarginDetectBar 的收起延时）
  maxSamples: 300,
  spaceName: "b2t-qa-margin-progress",
  navigate: true,     // true=探针自己打开应用；false=共用 space（由另一个动作脚本开页面并点按钮）
  ...(globalThis.OVERRIDE || {}),
};

const USAGE = `用法（ego 的 nodejs 不传 argv/env，配置走 globalThis.OVERRIDE）：

  { echo 'globalThis.OVERRIDE={base:"http://127.0.0.1:8871",token:"qa4",project:"b2t_T7JH61",maxPages:40,intervalMs:1000}'; \\
    cat tests/e2e/margin_progress.mjs; } | ego-browser nodejs

必填：base（含端口，或整条带 token 的 URL）· project
可选：token（默认 qa4）· maxPages（默认 40）· intervalMs（默认 1000）· jobWaitSeconds（默认 120）
      spaceName（默认 b2t-qa-margin-progress）· navigate（默认 true）

前置：目标项目上要**已经起了 / 马上起**一个 layout 任务，且起任务的那个页面要停在「版心确认」步
（J6/J8 只有在版心步才会复现：检测收尾会顺手跑自动拟合，两组文案抢同一个元素）。

推荐两进程共用同一个 space（探针只读，动作脚本负责点按钮；两者互不覆盖）：
  1) 先起探针（它只读、会等新任务）：
     { echo 'globalThis.OVERRIDE={base:"http://127.0.0.1:8871",token:"qa4",project:"b2t_T7JH61",spaceName:"b2t-qa-mp"}'; \
       cat tests/e2e/margin_progress.mjs; } | ego-browser nodejs
  2) 再在**同一个 spaceName** 里跑你的动作脚本：打开项目 → 选中 ≥20 页 → 版心步 →
     「⋯ → 检测版面… → 开始检测」。探针会从起跑开始采样。

探针只读 HTTP + 读 DOM：不建任务、不点按钮、不写项目数据。`;

if (!CFG.base || !CFG.project) {
  console.error(USAGE);
  process.exit(2);
}

const BASE = String(CFG.base).replace(/\/+$/, "");
const TOKEN = String(CFG.token || "qa4");

const task = await taskSpace(CFG.spaceName);
const page = task.page("p1");
let exitCode = 0;

function fmtPct(width) {
  const m = String(width || "").match(/([\d.]+)%/);
  return m ? Number(m[1]) : null;
}
function layoutN(text) {
  if (!text) return null;
  if (!/^正在检测版面…/.test(text) && !/^检测：/.test(text)) return null;
  const m = text.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { n: Number(m[1]), total: Number(m[2]) } : null;
}
const isFitText = (t) => /自动拟合/.test(String(t || ""));

// 读一次：DOM + 该项目的任务（同一 tick，避免两次读带来时间差）
async function readOnce() {
  return await page.evaluate(async (pid) => {
    const wrap = document.getElementById("margin-fit-progress");
    const fill = document.getElementById("margin-fit-fill");
    const text = document.getElementById("margin-fit-text");
    const out = {
      text: text ? text.textContent.trim() : null,
      hidden: wrap ? wrap.hidden : null,
      fill: fill ? fill.style.width : null,
      job: null,
      latestLayout: null,
    };
    try {
      const r = await fetch(`/api/projects/${pid}/jobs?limit=5`, {
        headers: { "X-B2T-Token": "qa4" },
      });
      const d = await r.json();
      const jobs = d.jobs || [];
      const active = d.active && d.active.job ? d.active.job : null;
      const pick = active && active.job_type === "layout" ? active : jobs.find((j) => j.job_type === "layout") || null;
      if (pick) out.job = { id: pick.job_id, status: pick.status, done: pick.done, failed: pick.failed || 0, total: pick.total };
      const anyLayout = jobs.find((j) => j.job_type === "layout");
      if (anyLayout) out.latestLayout = anyLayout.job_id;
    } catch (e) {
      out.jobError = String((e && e.message) || e);
    }
    return out;
  }, CFG.project);
}

const TERMINAL = ["succeeded", "failed", "cancelled", "interrupted"];

console.log(`== 版心检测进度条探针 ==`);
console.log(`base=${BASE} project=${CFG.project} interval=${CFG.intervalMs}ms maxPages=${CFG.maxPages}`);
console.log(`先等一个新的 layout 任务出现（去点「检测版面…」→「开始检测」），最多等 ${CFG.jobWaitSeconds}s…`);

let baselineJobId = null;
let samples = [];
let error = null;

try {
  if (CFG.navigate) {
    await page.goto(`${BASE}/?token=${encodeURIComponent(TOKEN)}`);
    await page.waitForFunction(
      () => Boolean(document.getElementById("project-list") || document.getElementById("workflow-steps")),
      null,
      { timeout: 60000 }
    );
  }
  // 先记下"进场前最新的一条 layout 任务"，后面只认新出现的
  const before = await page.evaluate(async (pid) => {
    try {
      const r = await fetch(`/api/projects/${pid}/jobs?limit=5`, { headers: { "X-B2T-Token": "qa4" } });
      const d = await r.json();
      const j = (d.jobs || []).find((x) => x.job_type === "layout");
      return j ? j.job_id : null;
    } catch (e) { return null; }
  }, CFG.project);
  baselineJobId = before;

  // 等新任务
  const waitStart = Date.now();
  let first = null;
  while (Date.now() - waitStart < CFG.jobWaitSeconds * 1000) {
    const snap = await readOnce();
    if (snap.job && snap.job.id !== baselineJobId) { first = snap; break; }
    await page.waitForTimeout(500);
  }
  if (!first) {
    console.error(`等不到新的 layout 任务（${CFG.jobWaitSeconds}s）。先在目标项目上点「⋯ → 检测版面… → 开始检测」。`);
    process.exit(2);
  }

  const job0 = first.job;
  console.log(`任务 ${job0.id}：total=${job0.total} status=${job0.status}`);
  if (job0.total === 0) {
    console.error("任务 total=0，没有可采样的进度。");
    process.exit(2);
  }

  // 采样
  const t0 = Date.now();
  let snap = first;
  samples.push({ t: 0, ...snap });
  while (samples.length < CFG.maxSamples) {
    if (snap.job && TERMINAL.includes(snap.job.status)) break;
    await page.waitForTimeout(CFG.intervalMs);
    snap = await readOnce();
    samples.push({ t: Math.round((Date.now() - t0) / 100) / 10, ...snap });
  }

  // 收尾：等 settleSeconds 后读最终态（J6）
  await page.waitForTimeout(CFG.settleSeconds * 1000);
  const final = await readOnce();

  // ---- 表格
  const header = ["t(s)", "文本", "N", "done", "failed", "status", "fill%", "hidden"];
  console.log("\n" + header.join("\t"));
  for (const s of samples) {
    const parsed = layoutN(s.text);
    console.log([
      s.t,
      JSON.stringify(s.text),
      parsed ? parsed.n : "",
      s.job ? s.job.done : "",
      s.job ? s.job.failed : "",
      s.job ? s.job.status : "",
      fmtPct(s.fill) === null ? "" : fmtPct(s.fill),
      s.hidden,
    ].join("\t"));
  }
  console.log(`[收尾 +${CFG.settleSeconds}s] text=${JSON.stringify(final.text)} hidden=${final.hidden} fill=${fmtPct(final.fill)}`);

  // ---- 判据
  const lastJob = samples[samples.length - 1].job || final.job;
  const total = lastJob ? lastJob.total : job0.total;
  const runSamples = samples.filter((s) => s.job && !TERMINAL.includes(s.job.status));
  const layoutSamples = samples.filter((s) => layoutN(s.text));
  const fitDuringRun = runSamples.filter((s) => isFitText(s.text));

  const v = {};
  // J1 起跑 0/M
  v.J1 = (() => {
    const p = layoutN(samples[0].text);
    return p ? p.n === 0 && p.total === total && samples[0].hidden === false : false;
  })();
  // J2 检测侧 N 单调
  v.J2 = (() => {
    const ns = layoutSamples.map((s) => layoutN(s.text).n);
    for (let i = 1; i < ns.length; i++) if (ns[i] < ns[i - 1]) return false;
    return ns.length >= 2;
  })();
  // J3 同步（±2，轮询差一拍）
  v.J3 = (() => {
    const rows = layoutSamples.filter((s) => s.job && !TERMINAL.includes(s.job.status));
    if (rows.length < 3) return "不过（样本不足）";
    for (const s of rows) {
      const p = layoutN(s.text);
      const trueDone = s.job.done + s.job.failed;
      if (Math.abs(p.n - trueDone) > 2) return false;
    }
    return true;
  })();
  // J4 增长：至少 3 个不同 N
  v.J4 = (() => {
    const ns = new Set(layoutSamples.map((s) => layoutN(s.text).n));
    if (total < 20) return "跳过（total<20）";
    return ns.size >= 3;
  })();
  // J5 宽度
  v.J5 = (() => {
    const rows = layoutSamples.filter((s) => s.job);
    if (!rows.length) return "不过（无样本）";
    for (const s of rows) {
      const p = layoutN(s.text);
      const pct = fmtPct(s.fill);
      if (pct === null) return false;
      const expect = Math.round((p.n / (s.job.total || total)) * 100);
      if (Math.abs(pct - expect) > 1) return false;
    }
    return true;
  })();
  // J6 收尾文案 + 收起
  v.J6 = (() => {
    const done = lastJob ? lastJob.done : null;
    const expected = done === null ? null : `检测：${done} / ${total} 页`;
    if (!expected) return "不过（读不到任务）";
    return final.text === expected && final.hidden === true;
  })();
  // J7 暂停：探针不点按钮
  v.J7 = "跳过（需要人工暂停/继续）";
  // J8 样本级：检测期间不许出现拟合文案；拟合分母不许变；宽度不许回跳
  v.J8 = (() => {
    if (fitDuringRun.length) return false;
    const fitTotals = new Set(
      samples.map((s) => {
        const m = String(s.text || "").match(/自动拟合版心… \d+ \/ (\d+)/);
        return m ? Number(m[1]) : null;
      }).filter((x) => x !== null)
    );
    if (fitTotals.size > 1) return false;
    let prev = null;
    for (const s of runSamples) {
      const pct = fmtPct(s.fill);
      if (pct === null) continue;
      if (prev !== null && pct < prev) return false;
      prev = pct;
    }
    return true;
  })();

  console.log("\n== 判据 ==");
  for (const k of ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8"]) {
    console.log(`${k}: ${v[k] === true ? "过" : v[k] === false ? "不过" : v[k]}`);
  }

  // 细节：J8 失败的证据
  if (v.J8 !== true) {
    console.log(`\nJ8 细节：检测期间 ${runSamples.length} 个样本里有 ${fitDuringRun.length} 个被拟合文案覆盖`);
    for (const s of fitDuringRun.slice(0, 6)) console.log(`  t=${s.t}s ${JSON.stringify(s.text)} | job=${s.job.status} ${s.job.done}/${s.job.total}`);
    const tots = [...new Set(samples.map((s) => (String(s.text || "").match(/自动拟合版心… \d+ \/ (\d+)/) || [])[1]).filter(Boolean))];
    if (tots.length > 1) console.log(`  拟合分母序列：${tots.join(" → ")}`);
  }
  if (v.J6 !== true) {
    console.log(`\nJ6 细节：结束后 ${CFG.settleSeconds}s 的文本与期望不符`);
    console.log(`  期望「检测：${lastJob ? lastJob.done : "?"} / ${total} 页」 hidden=true`);
    console.log(`  实际 ${JSON.stringify(final.text)} hidden=${final.hidden}`);
  }

  const j6Pass = v.J6 === true;
  const j8Pass = v.J8 === true;
  exitCode = j6Pass && j8Pass ? 0 : 1;
} catch (err) {
  error = String((err && err.stack) || err);
  console.error("探针异常：" + error);
  exitCode = 2;
} finally {
  try { await task.finish({ keep: [] }); } catch (e) { console.error("space 收尾失败：" + String((e && e.message) || e)); }
}

console.log(`\n退出码 ${exitCode}（0 全过 / 1 J6或J8不过 / 2 用法或前置不满足）`);
process.exit(exitCode);
