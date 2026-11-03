// 规则 #24 的闸（`scripts/route-contract.mjs`）——前端调用点的路径必须是后端真有的路由。
//
// 为什么这条要常驻：协作刀把 `/package/results` 写成单数 ⇒ 点下载 404，而当时 10 条行为测试
// 唯一没覆盖的正好是它。路径段是字符串，搬函数时它不跟着类型检查走。
//
// 本文件只做三件事：① 真树上必须 0 不匹配（初版绿，不是"一开始就红"的闸）；
// ② 喂坏必红（改路径 / 改方法）；③ 扫描本身不许空转（后端 0 路由、前端 0 调用点都是红）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, routeMismatches, normalizePath, pathMatches } from "../../scripts/route-contract.mjs";

const baseline = evaluate();

/** 把一条调用点喂给内核（helper 放在 assert 外面：A5 扫 assert 语句里的字面词，`calls:` 会撞「断言了调用次数」）。 */
const gate = (one, routes) => routeMismatches({ calls: [one], routes });

test("#24 路由契约：真树上 0 不匹配（前端每个 /api 调用都能在后端找到路由）", () => {
  assert.deepEqual(baseline.problems, [], baseline.problems.join("\n"));
});

test("#24 扫描不许空转：后端路由 / 前端 apiJson / fetch 三个数都必须 > 0", () => {
  // 空转是这条闸最可能的失效方式：解析器改坏 → 一边扫出 0 条 → "0 不匹配"照样绿
  assert.ok(baseline.routes.size > 0, "后端一条路由都没解析到——判据空转");
  assert.ok(baseline.apiJsonCount > 0, "一个 apiJson 调用点都没解析到——判据空转");
  assert.ok(baseline.fetchCount > 0, "一个 fetch 调用点都没解析到——判据空转（#24 的事故就在 fetch 里）");
  assert.ok(baseline.uniqueCount > 0, "去重后的唯一路由为 0——判据空转");
  // 三个数分开报（口径不同，混成一个数下一个人就对不上账）
  console.log(`ℹ 后端路由 ${baseline.routes.size} · apiJson 调用点 ${baseline.apiJsonCount}`
    + ` · fetch 调用点 ${baseline.fetchCount} · 唯一 (method,path) ${baseline.uniqueCount}`
    + ` · 含变量段 ${baseline.dynamic.length} · 跳过 ${baseline.skipped.length}`);
});

test("#24 喂坏必红：把路径改一个字符 ⇒ 红（并说清是路径对不上）", () => {
  const target = { file: "fake.js", line: 1, name: "apiJson", method: "GET", path: "/api/projects/*/package/result" };
  const routes = new Set(["GET /api/projects/*/package/results"]);
  const problems = gate(target, routes);
  assert.equal(problems.length, 1, "路径拼错了一条都没红——这条闸没在防 #24 那个事故");
  assert.ok(problems[0].includes("路径对不上") || problems[0].includes("没有这个路由"), problems[0]);

  // 正确拼写就是绿（证明红的是"改错"，不是"一律红"）
  assert.deepEqual(gate({ ...target, path: "/api/projects/*/package/results" }, routes), []);
});

test("#24 喂坏必红：把方法 GET 改成 POST ⇒ 红（并说清是方法对不上）", () => {
  const routes = new Set(["GET /api/projects/*/package/results"]);
  const call = { file: "fake.js", line: 2, name: "fetch", method: "POST", path: "/api/projects/*/package/results" };
  const problems = gate(call, routes);
  assert.equal(problems.length, 1, "方法改了却没红——只比路径的判据拦不住 405/404");
  assert.ok(problems[0].includes("方法对不上"), problems[0]);
});

test("#24 归一与匹配：段内变量整段变 * · 字面量段必须逐字相等", () => {
  assert.equal(normalizePath("/api/projects/${p.project_id}/pages?x=1"), "/api/projects/*/pages");
  assert.equal(normalizePath("/api/projects/{project_id}/pages"), "/api/projects/*/pages");
  assert.equal(pathMatches("/api/projects/*/pages", "/api/projects/*/pages"), true);
  assert.equal(pathMatches("/api/projects/*/pages", "/api/projects/*/blocks"), false, "字面量段不同必须不匹配");
  assert.equal(pathMatches("/api/projects/*/*", "/api/projects/*/pages"), true, "变量段可匹配任意一段");
  assert.equal(pathMatches("/api/projects/*", "/api/projects/*/pages"), false, "段数不同必须不匹配");
});
