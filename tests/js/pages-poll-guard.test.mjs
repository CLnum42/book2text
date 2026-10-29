// pages 的「轮询不许重载项目」防回归断言（2026-10-30）。
//
// **为什么用 grep 而不是调用图分析**：这条守的是"将来有人把 refreshProject 接进 pollTask"。
// 项目里没有调用图分析工具，而纯函数用例模拟不了"轮询 0.9s 跑着时会不会重载项目"这件事——
// grep 源码是本仓库唯一能只读、可重复、零依赖地钉住这段区间的手段（run.mjs 里其它静态判据同款）。
// 它不追求通用性，只守一个具体事实：pollTask 的函数体里不许出现 refreshProject。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("../../backend/book2text/static/app.js", import.meta.url));

/** 取某个顶层函数的函数体（到下一条顶层 `function` / `async function` 为止）。 */
export function topLevelBody(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^(?:async\s+)?function\s+[A-Za-z_$]/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n");
}

test("pollTask 的区间里不许出现 refreshProject（轮询每次重载项目会清空/漂移用户状态）", () => {
  const body = topLevelBody(readFileSync(APP, "utf8"), "pollTask");
  assert.ok(body, "在 app.js 里没定位到 pollTask——判据失效即红，不许静默跳过");
  assert.equal(
    body.includes("refreshProject"),
    false,
    "pollTask 里出现了 refreshProject：轮询每 0.9 秒重载项目会重置当前项目对象与选中状态——"
      + "要刷新页面状态请用 reloadProjectPages()，它不动选择",
  );
});

test("自检：把 refreshProject 插进 pollTask，本判据必须红", () => {
  const src = readFileSync(APP, "utf8");
  const body = topLevelBody(src, "pollTask");
  const mutated = body.replace("{", "{\n  refreshProject(currentProject.project_id);", 1);
  assert.equal(topLevelBody(mutated.replace(/^function pollTask/m, "function pollTask"), "pollTask").includes("refreshProject"), true);
});
