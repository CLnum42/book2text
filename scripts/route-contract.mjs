#!/usr/bin/env node
// **规则 #24：搬写时 URL 路径是隐形接口** —— 前端每个 `apiJson` / `fetch` 的路径段，
// 必须在后端 `@router` 里有对应路由（方法 + 路径）。对不上就红。
//
// 为什么要有它：协作刀把 `/package/results` 写成单数 ⇒ 点下载 404，而 10 条行为测试
// 唯一没覆盖的正好是它。路径段是**字符串**，搬函数时它不跟着类型检查走。
//
// 口径（逐条写死，别处不再各写一套）：
//   · 后端来源：`backend/book2text/api/*.py` 里的 `@router.<method>("…")`，
//     加上同文件 `APIRouter(prefix="…")` 的前缀拼成完整路径；
//   · 前端来源：`backend/book2text/static/*.js` 里的 `apiJson(…)` 与 `fetch(…)` 调用点
//     **两者都扫**——#24 的来源事故就在 fetch 里，只扫 apiJson 会漏掉它本来要防的那次；
//   · 实参**按括号配对取**（不用固定窗口：定窗取 `method:` 会把下一个调用的 POST 误算进来，
//     原型就报过一条假红）；缺省方法 = GET；
//   · 归一：`${…}` 与 `{…}` → `*`（一个 `*` 只匹配一个路径段），剥掉 `?query`；
//   · **非字面量 URL（变量、模板里拼不出来）必须计数上报**，不许静默跳过，否则规则会悄悄缩水；
//   · 三个数分开报：apiJson 调用点数 / fetch 调用点数 / 去重后的唯一 (method,path) 数；
//   · 只判**前端 ⊆ 后端**（前端调了不存在的路由 = 运行时 404）；"后端有、前端不用"不判。
//
// 用法：node scripts/route-contract.mjs [--json] [--self-test]
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const API_DIR = join(REPO, "backend/book2text/api");
const STATIC_DIR = join(REPO, "backend/book2text/static");

/** 归一化一条路径：去 query、`${…}`/`{…}` → `*`、去掉尾部斜杠（根路径除外）。 */
export function normalizePath(raw) {
  let path = String(raw || "");
  path = path.split("?")[0].split("#")[0];
  // **按段归一**：只要这一段里出现 `${…}` 或 `{…}`，整段就是 `*`。
  // 不能只把 `${…}` 替换成 `*`——`layout/plan${x}` 会变成 `plan*`，而后端是 `plan/{id}`，
  // 于是同一件事被写成两种形状，报出假红。
  path = path.split("/").map((segment) => (/\$\{|\{/.test(segment) ? "*" : segment)).join("/");
  path = path.replace(/\/+$/, "");
  return path || "/";
}

/** 后端路由集合：`Set<"METHOD path">`。 */
export function backendRoutes(apiDir = API_DIR) {
  const routes = new Set();
  const skipped = [];
  for (const file of readdirSync(apiDir).filter((name) => name.endsWith(".py"))) {
    const source = readFileSync(join(apiDir, file), "utf8");
    const prefixMatch = /APIRouter\(\s*prefix\s*=\s*"([^"]*)"/.exec(source);
    const prefix = prefixMatch ? prefixMatch[1] : "";
    for (const match of source.matchAll(/@router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
      const full = normalizePath(`${prefix}${match[2]}`);
      routes.add(`${match[1].toUpperCase()} ${full}`);
    }
    // 动态注册（add_api_route / 循环里拼路径）目前没有；出现就报出来，别让它静默漏掉
    if (/add_api_route\s*\(/.test(source)) skipped.push(`${file}: add_api_route`);
  }
  return { routes, skipped };
}

/** 从 `open` 指向的左括号开始，返回配对右括号的下标（认识字符串与转义）。 */
export function matchParen(source, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** 从实参里取字面量 URL：`"…"` / `'…'` / 模板字符串（含 `${}` 也接受，归一成 `*`）。 */
export function literalAt(args) {
  const trimmed = args.trimStart();
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let i = 1;
  while (i < trimmed.length) {
    if (trimmed[i] === "\\") { i += 2; continue; }
    if (trimmed[i] === quote) return { raw: trimmed.slice(1, i), template: quote === "`" };
    if (quote !== "`" && trimmed[i] === "\n") return null;
    i += 1;
  }
  return null;
}

/** 从实参文本里取方法：`method: "POST"`（在**同一层**实参里），缺省 GET。 */
export function methodIn(args) {
  const match = /\bmethod\s*:\s*["'`]([A-Za-z]+)["'`]/.exec(args);
  return match ? match[1].toUpperCase() : "GET";
}

/** 前端调用点。返回 { calls, apiJsonCount, fetchCount, skipped }。 */
export function frontendCalls(staticDir = STATIC_DIR) {
  const calls = [];
  const skipped = [];
  let apiJsonCount = 0;
  let fetchCount = 0;
  for (const file of readdirSync(staticDir).filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(join(staticDir, file), "utf8");
    for (const match of source.matchAll(/\b(apiJson|fetch)\s*\(/g)) {
      const name = match[1];
      // 跳过定义行：`function apiJson(` / `async function fetch(` 这种
      const lineStart = source.lastIndexOf("\n", match.index) + 1;
      const before = source.slice(lineStart, match.index);
      if (/\bfunction\s+$/.test(before)) continue;
      const open = source.indexOf("(", match.index);
      const close = matchParen(source, open);
      if (close < 0) { skipped.push(`${file}: ${name}( 括号不配对`); continue; }
      const args = source.slice(open + 1, close);
      if (name === "apiJson") apiJsonCount += 1; else fetchCount += 1;
      const literal = literalAt(args);
      if (!literal) { skipped.push(`${file}: ${name}( 首个实参不是字面量 URL`); continue; }
      const line = source.slice(0, match.index).split("\n").length;
      calls.push({ file, line, name, method: methodIn(args), path: normalizePath(literal.raw), raw: literal.raw });
    }
  }
  return { calls, apiJsonCount, fetchCount, skipped };
}

/**
 * 一条前端路径能不能被某条后端路由接住：**逐段比，`*` 匹配任意一段**。
 *
 * 为什么要逐段：模板字符串里拼出来的段（`/jobs/${id}/${action}`、`/${path}`）在静态分析里
 * 只能归成 `*`——按整串相等比会把它们全判成"后端没有这个路由"，那是假红。
 * 反过来，字面量写错一个字符（`/package/results` → `/result`）不受影响：两边都没有 `*`，就要逐字相等。
 */
export function pathMatches(callPath, routePath) {
  const a = String(callPath).split("/");
  const b = String(routePath).split("/");
  if (a.length !== b.length) return false;
  return a.every((segment, index) => segment === "*" || segment === b[index]);
}

/** 前端 ⊆ 后端。返回不匹配清单（每条带文件:行号与说明）。 */
export function routeMismatches({ calls, routes }) {
  const problems = [];
  const routeList = [...routes].map((key) => {
    const space = key.indexOf(" ");
    return { method: key.slice(0, space), path: key.slice(space + 1) };
  });
  for (const call of calls) {
    if (!call.path.startsWith("/api")) continue;   // 非 /api（图片、静态资源）不归这条规则
    const hit = routeList.some((route) => route.method === call.method && pathMatches(call.path, route.path));
    if (hit) continue;
    const sameMethod = routeList.filter((route) => route.method === call.method && pathMatches(call.path, route.path));
    const samePath = routeList.filter((route) => route.path === call.path || pathMatches(call.path, route.path));
    problems.push(`${call.file}:${call.line} ${call.name} 调了 ${call.method} ${call.path}——`
      + (samePath.length
        ? `后端只有 ${samePath.map((route) => `${route.method} ${route.path}`).join(" / ")}（方法对不上）`
        : "后端没有这个路由（路径对不上）"));
  }
  return problems;
}

/** 含 `${}`/`{}` 段的调用点（静态分析只能归成 `*`）——单独报，别混进"不匹配"。 */
export function dynamicCalls(calls) {
  return calls.filter((call) => call.path.split("/").includes("*"));
}

export function evaluate({ apiDir = API_DIR, staticDir = STATIC_DIR } = {}) {
  const { routes, skipped: backendSkipped } = backendRoutes(apiDir);
  const { calls, apiJsonCount, fetchCount, skipped } = frontendCalls(staticDir);
  const unique = new Map();
  for (const call of calls) unique.set(`${call.method} ${call.path}`, call);
  const problems = routeMismatches({ calls, routes });
  return {
    routes, calls, problems,
    apiJsonCount, fetchCount, uniqueCount: unique.size,
    dynamic: dynamicCalls(calls),
    skipped: [...skipped, ...backendSkipped],
  };
}

function main(argv) {
  const result = evaluate();
  if (argv.includes("--json")) {
    console.log(JSON.stringify({
      backendRoutes: result.routes.size,
      apiJsonCalls: result.apiJsonCount,
      fetchCalls: result.fetchCount,
      uniqueRoutes: result.uniqueCount,
      skipped: result.skipped,
      mismatches: result.problems,
    }, null, 2));
    process.exit(result.problems.length ? 1 : 0);
  }
  console.log(`后端路由 ${result.routes.size} 条`);
  console.log(`前端 apiJson 调用点 ${result.apiJsonCount} 个 · fetch 调用点 ${result.fetchCount} 个`);
  console.log(`去重后唯一 (method,path) ${result.uniqueCount} 个`);
  console.log(`含变量段（只能归成 \`*\`，逐段匹配）${result.dynamic.length} 个`
    + (result.dynamic.length ? `：\n  ${result.dynamic.map((call) => `${call.file}:${call.line} ${call.method} ${call.path}`).join("\n  ")}` : ""));
  console.log(`跳过（非字面量 URL / 括号不配对）${result.skipped.length} 个：`
    + (result.skipped.length ? `\n  ${result.skipped.join("\n  ")}` : "（无）"));
  console.log(`不匹配 ${result.problems.length} 条：`
    + (result.problems.length ? `\n  ${result.problems.join("\n  ")}` : "（无）"));
  process.exit(result.problems.length ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("route-contract.mjs")) main(process.argv.slice(2));
