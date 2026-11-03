// `detailPageNo` 的可见性不变量 —— 四条判据（2026-10-30 Architect 裁定：拆状态 + 单向不变量）
//
// 背景（Builder 真机验收撞到的用户可见 bug，不是推测）：
//   进审校 → 点页详情（detailPageNo = 1）→ 步骤条回「页面确认」→ 点页块「识别」→ 造失败
//   旧代码里 showView 只切 hidden、不清 detailPageNo ⇒ 错误写进 #page-detail-error（另一个视图的元素），
//   #pages-error 仍 hidden ⇒ 屏幕上什么都不出现。**四闸全绿，用户什么都看不见。**
//
// 所以这里守的不是"函数有没有写对"，是**状态生命周期**：
//   单向不变量：`detailPageNo !== null ⇒ currentView === "review"`（反向不要求——
//   进 review 时先 showView("review") 再 openPageDetail()，切过去那一瞬还是 null）。
//   回忆另存 `lastDetailPageNo`：只在 openPageDetail 里写一次，永不清空。
//
// 一句话为什么要有这一组判据：
//   **"闸全绿"和"用户看得见"是两件事。** 静态判据只能证明代码形态对，证明不了状态在某时刻的可见性。
//   凡是有"状态可能指着不可见元素"的地方，都要有一个唯一答案——这里就是「离开 review 必须清」。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { loadApp, preloadModules } from "./load-app.mjs";

const APP_FILE = process.env.B2T_APP_JS
  || fileURLToPath(new URL("../../backend/book2text/static/app.js", import.meta.url));

/**
 * `app.js` + 核心抽屉模块（`page-detail-drawer.js`）合查。
 *
 * Temp-Relax: 抽屉那刀把 `openPageDetail` / `closePageDetail` 搬进模块；这两条判据原来的
 * 定位口径是"在 app.js 里找顶层函数"，搬走后必然定位失败。改成合查后：
 * 旧树（模块还没落盘）只有 app.js ⇒ 判据与原来完全一样；新树两条函数在模块里 ⇒ 仍能定位。
 * 收紧条件 = 抽屉刀笔 2 把这两条改成"只在抽屉模块里找"。
 */
function sourceWithDrawer() {
  const app = readFileSync(APP_FILE, "utf8");
  const drawer = fileURLToPath(new URL("../../backend/book2text/static/page-detail-drawer.js", import.meta.url));
  try {
    return `${app}\n${readFileSync(drawer, "utf8")}`;
  } catch {
    return app;
  }
}

/** 顶层函数的 [起行, 止行]（按括号配对；找不到返回 null）。 */
function topLevelFunctionRange(lines, name) {
  const start = lines.findIndex((line) => new RegExp(`^(?:async )?function ${name}\\(`).test(line));
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (depth <= 0 && i > start) return [start + 1, i + 1];
  }
  return null;
}

/** 去掉行尾注释与整行注释后的"代码面"（这几处赋值点没有含 `//` 的字符串，粗剥足够且不会误伤）。 */
function codeOf(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return line.split("//")[0];
}

/** 某个名字的赋值点（`name = ...`，排除 `let/const/var` 声明与 `==`/`=>`）。 */
function assignmentHits(source, name) {
  const hits = [];
  source.split("\n").forEach((raw, index) => {
    const code = codeOf(raw);
    if (!code) return;
    if (new RegExp(`(?:let|const|var)\\s+${name}\\b`).test(code)) return;   // 声明不算赋值点
    if (new RegExp(`\\b${name}\\s*=(?!=)`).test(code)) hits.push({ line: index + 1, code: code.trim() });
  });
  return hits;
}

// ---------------------------------------------------------------- 三个判定内核（吃源码字符串）
//
// 为什么要抽成纯函数：判据必须**自己能被证伪**。真树那条读真 app.js 调内核；自检那条喂假源码调
// **同一个内核**——否则有人把「恰好 1 处」放宽成「至少 1 处」，真树那条照样绿，没人发现。
// **同一个内核 = 同一种数法**：不要在真树用 A 方法数、自检用 B 方法数，那样两个数会打架。

/** ① 防的是「状态活过它的视图」——离开 review 没清 detailPageNo，错误会写进看不见的元素，四闸全绿。 */
export function showViewClearProblems(source) {
  const lines = String(source || "").split("\n");
  const range = topLevelFunctionRange(lines, "showView");
  if (!range) {
    return ["app.js 里找不到顶层 function showView( —— 定位失败就红（fail closed），"
      + "不许因为「扫不到」而当它合规"];
  }
  const body = lines.slice(range[0] - 1, range[1]);
  let found = false;
  body.forEach((line, index) => {
    if (!/if\s*\([^)]*!==\s*"review"/.test(line)) return;
    let depth = 0;
    let sawBrace = false;
    for (let i = index; i < body.length; i += 1) {
      for (const ch of body[i]) {
        if (ch === "{") { depth += 1; sawBrace = true; }
        else if (ch === "}") depth -= 1;
      }
      if (body[i].includes("closePageDetail(")) found = true;
      if (sawBrace && depth <= 0) break;
    }
  });
  return found ? [] : [
    "showView 离开 review 时没清 detailPageNo——状态活过了它的视图，错误会写进看不见的元素"
    + "（单向不变量：detailPageNo !== null ⇒ currentView === \"review\"）",
  ];
}

/** ② 防的是「谁负责清」有第二个答案——别的地方也清一遍，等于给这个状态开了两个入口。 */
export function detailPageNullAssignmentProblems(source) {
  const src = String(source || "");
  const range = topLevelFunctionRange(src.split("\n"), "closePageDetail");
  if (!range) {
    return ["app.js 里找不到顶层 function closePageDetail( —— 定位失败就红（fail closed）"];
  }
  const hits = assignmentHits(src, "detailPageNo").filter((hit) => /=\s*null\b/.test(hit.code));
  if (hits.length !== 1) {
    return [`detailPageNo = null 的赋值点是 ${hits.length} 处（${hits.map((h) => h.line).join(" / ")}）——`
      + "只许 closePageDetail 内那一处；别的地方清它，等于又给「谁负责清」开了第二个答案"];
  }
  if (hits[0].line < range[0] || hits[0].line > range[1]) {
    return [`detailPageNo = null 出现在 ${hits[0].line} 行，不在 closePageDetail（${range[0]}–${range[1]}）里——`
      + "清状态的唯一入口必须是 closePageDetail"];
  }
  return [];
}

/** ③ 防的是「回忆变成第二个真源」——lastDetailPageNo 只写一次，且只在 openPageDetail 里。 */
export function lastDetailPageNoProblems(source) {
  const src = String(source || "");
  const range = topLevelFunctionRange(src.split("\n"), "openPageDetail");
  if (!range) {
    return ["app.js 里找不到顶层 function openPageDetail( —— 定位失败就红（fail closed）"];
  }
  // Temp-Relax: 抽屉那刀把 openPageDetail 搬进模块，写法变成 `S.lastDetailPageNo = pageNo`
  // （S 是注入访问器的薄封装），外壳侧还有 `setLastDetailPageNo` 的 setter 一行。
  // 两者都不是"第二个真源"，只是同一个状态的两条通道 ⇒ 判据只数**真源赋值**。
  // 收紧条件 = 抽屉刀笔 2 把这两条判据改成"状态只在外壳声明一次 + 模块里 0 个同名 let"。
  const hits = assignmentHits(src, "lastDetailPageNo")
    .filter((hit) => !/setLastDetailPageNo/.test(hit.code));
  if (hits.length !== 1) {
    return [`lastDetailPageNo 的赋值点是 ${hits.length} 处（${hits.map((h) => h.line).join(" / ")}）——`
      + "它必须是只写一次的「回忆」，否则 detailPageNo 那个「两个真源」的问题会在这里重演"];
  }
  if (hits[0].line < range[0] || hits[0].line > range[1]) {
    return [`lastDetailPageNo 在 ${hits[0].line} 行被赋值，不在 openPageDetail（${range[0]}–${range[1]}）里——`
      + "它必须是只写一次的「回忆」，否则又变成第二个真源"];
  }
  return [];
}

// ---------------------------------------------------------------- 真树：三条形态判据

test("① showView 的「非 review」分支必须调 closePageDetail()（实树）", () => {
  const problems = showViewClearProblems(readFileSync(APP_FILE, "utf8"));
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("② detailPageNo = null 只许一处，且在 closePageDetail 里（实树）", () => {
  const problems = detailPageNullAssignmentProblems(sourceWithDrawer());
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("③ lastDetailPageNo 恰好一处，且只在 openPageDetail 里（实树）", () => {
  const problems = lastDetailPageNoProblems(sourceWithDrawer());
  assert.deepEqual(problems, [], problems.join("\n"));
});

// ---------------------------------------------------------------- 自检：同一内核吃假源码，必须红

test("①②③ 自检：假源码违规要点名、定位失败也要红（判据自己能被证伪）", () => {
  const good = [
    'function showView(name) {',
    '  if (name !== "review") { closeTaskDrawer(); closePageDetail(); }',
    '}',
    'function openPageDetail(pageNo) {',
    '  detailPageNo = pageNo;',
    '  lastDetailPageNo = pageNo;',
    '}',
    'function closePageDetail() {',
    '  detailPageNo = null;',
    '}',
  ].join("\n");
  assert.deepEqual(showViewClearProblems(good), [], "自检失败：合规假源码被 ① 误报");
  assert.deepEqual(detailPageNullAssignmentProblems(good), [], "自检失败：合规假源码被 ② 误报");
  assert.deepEqual(lastDetailPageNoProblems(good), [], "自检失败：合规假源码被 ③ 误报");

  // 违规①：非 review 分支里没有 closePageDetail
  const noClear = good.replace("closeTaskDrawer(); closePageDetail();", "closeTaskDrawer();");
  assert.ok(showViewClearProblems(noClear).some((m) => m.includes("离开 review 时没清 detailPageNo")),
    `自检失败：注掉 closePageDetail 的假源码没被 ① 抓住——${showViewClearProblems(noClear).join("；")}`);

  // 违规②：别处又清一次
  const doubleNull = good.replace('  if (name !== "review") {', '  detailPageNo = null;\n  if (name !== "review") {');
  assert.ok(detailPageNullAssignmentProblems(doubleNull).some((m) => m.includes("赋值点是 2 处")),
    `自检失败：两处 detailPageNo = null 没被 ② 抓住——${detailPageNullAssignmentProblems(doubleNull).join("；")}`);

  // 违规③：别处又写一次「回忆」
  const doubleMemory = good.replace('  detailPageNo = pageNo;', '  detailPageNo = pageNo;\n  lastDetailPageNo = pageNo;');
  assert.ok(lastDetailPageNoProblems(doubleMemory).some((m) => m.includes("赋值点是 2 处")),
    `自检失败：两处 lastDetailPageNo 赋值没被 ③ 抓住——${lastDetailPageNoProblems(doubleMemory).join("；")}`);

  // **定位失败**这一类：函数改名 / 被拆走 —— 必须红，不能静默当合规
  const renamed = good.replace("function showView(name)", "function switchView(name)");
  assert.ok(showViewClearProblems(renamed).some((m) => m.includes("找不到顶层 function showView(")),
    `自检失败：showView 改名后 ① 反而绿了——${showViewClearProblems(renamed).join("；")}`);
  const noClose = good.replace("function closePageDetail()", "function dismissDetail()");
  assert.ok(detailPageNullAssignmentProblems(noClose).some((m) => m.includes("找不到顶层 function closePageDetail(")),
    "自检失败：closePageDetail 改名后 ② 反而绿了");
  const noOpen = good.replace("function openPageDetail(pageNo)", "function showDetail(pageNo)");
  assert.ok(lastDetailPageNoProblems(noOpen).some((m) => m.includes("找不到顶层 function openPageDetail(")),
    "自检失败：openPageDetail 改名后 ③ 反而绿了");
});

// ---------------------------------------------------------------- ④ 行为判据（**无假源码自检**）
//
// 说明：④ 要跑 vm 加载真 app.js，造不出"假源码版"的等价夹具——所以它只有**一次真实喂红**。
// 复现方式：注掉 closePageDetail 里的 `detailPageNo = null;`（① 仍会绿），再跑本文件：
//   showView("pages") 之后 detailPageNo = 1 ⇒ ④ 红。
test("④ 运行时：showView(\"pages\") 之后 detailPageNo 必须为 null（行为判据，无假源码自检）", (t) => {
  const ctx = loadApp();
  // Temp-Relax: 抽屉那刀把 closePageDetail 搬进模块；外壳调 window.PageDetailDrawer?.closePageDetail()。
  // 模块搬走后，这条判据要能"经模块"把状态清掉，而台架的注入是空函数（`() => undefined`），
  // 读不到外壳的 let ⇒ 现在只能**显式 skip**（skip 会打出来，不静默当通过）。
  // 收紧条件 = 抽屉刀笔 2 给 loadApp 接上状态桥（injected.setDetailPageNo 写回 ctx 的词法绑定）。
  const report = preloadModules(ctx, ["page-detail-drawer.js"]);
  if (report.some((item) => item.loaded)) {
    t.skip("抽屉已在模块里：④ 的状态桥还没接进台架（见抽屉刀笔 2）");
    return;
  }
  // showView 第一行就 `el("view-x").hidden = …`，而 loadApp 的桩 document 返回 null —— 直接炸。
  // 这里装的是**最小可信桩**，不是「模拟 DOM」：它只保证「读属性不炸、写属性不存」，
  // 不假装元素存在、也不掩盖真实的 null 检查——这条判据要验的是**状态**（detailPageNo 是否被清），
  // 不是 DOM 行为；换成「模拟 DOM」会把它变成对渲染逻辑的复刻。
  vm.runInContext(`
    const fakeEl = new Proxy(function () {}, {
      get: (t, p) => (p === "classList" ? { add(){}, remove(){}, toggle(){}, contains(){ return false; } }
        : p === "childNodes" ? [] : p === "style" ? {} : fakeEl),
      set: () => true,
      apply: () => fakeEl,
    });
    document.getElementById = () => fakeEl;
    document.querySelector = () => fakeEl;
    document.querySelectorAll = () => [];
    // 前置：模拟"详情开着"（detailPageNo 是顶层 let，不挂全局对象，但 runInContext 能读词法绑定）
    detailPageNo = 1;
  `, ctx);
  vm.runInContext('showView("pages");', ctx);
  const after = vm.runInContext("detailPageNo", ctx);
  assert.equal(after, null,
    `showView("pages") 之后 detailPageNo = ${JSON.stringify(after)}——状态活过了它的视图：`
    + "错误会写进看不见的元素（这是 Builder 真机验收撞到的那个 bug 的形态）");
});
