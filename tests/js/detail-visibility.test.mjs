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

import { loadApp } from "./load-app.mjs";

const APP_FILE = process.env.B2T_APP_JS
  || fileURLToPath(new URL("../../backend/book2text/static/app.js", import.meta.url));

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

test("① showView 的「非 review」分支必须调 closePageDetail()（否则状态活过它的视图）", () => {
  const lines = readFileSync(APP_FILE, "utf8").split("\n");
  const range = topLevelFunctionRange(lines, "showView");
  assert.ok(range, `app.js 里找不到顶层 function showView( —— 结构变了，先修这条判据（${APP_FILE}）`);
  const body = lines.slice(range[0] - 1, range[1]);
  // 不钉"函数末尾"：Builder 把清理放在 `if (target !== "review") { closeTaskDrawer(); closePageDetail(); }` 里。
  // 判据只要求：**在"离开 review"这个分支的块里**出现 closePageDetail()。
  let found = false;
  body.forEach((line, index) => {
    if (!/if\s*\([^)]*!==\s*"review"/.test(line)) return;
    // 取这个 if 的花括号块（同行 { 或下一行 {）
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
  assert.ok(found,
    "showView 离开 review 时没清 detailPageNo——状态活过了它的视图，错误会写进看不见的元素"
    + "（单向不变量：detailPageNo !== null ⇒ currentView === \"review\"）");
});

test("② `detailPageNo = null` 的赋值点只许两处：声明 + closePageDetail 内", () => {
  const source = readFileSync(APP_FILE, "utf8");
  const lines = source.split("\n");
  const range = topLevelFunctionRange(lines, "closePageDetail");
  assert.ok(range, "app.js 里找不到顶层 function closePageDetail( —— 结构变了，先修这条判据");
  const hits = assignmentHits(source, "detailPageNo").filter((hit) => /=\s*null\b/.test(hit.code));
  const inClose = hits.filter((hit) => hit.line >= range[0] && hit.line <= range[1]);
  assert.equal(hits.length, 1,
    `detailPageNo = null 的赋值点是 ${hits.length} 处（${hits.map((h) => h.line).join(" / ")}）——`
    + "只许 closePageDetail 内那一处；别的地方清它，等于又给「谁负责清」开了第二个答案");
  assert.equal(inClose.length, 1,
    `detailPageNo = null 出现在 ${hits[0].line} 行，不在 closePageDetail（${range[0]}–${range[1]}）里——`
    + "清状态的唯一入口必须是 closePageDetail");
});

test("③ `lastDetailPageNo = ` 恰好 1 处，且只在 openPageDetail 里（数量 + 位置两个条件）", () => {
  const source = readFileSync(APP_FILE, "utf8");
  const lines = source.split("\n");
  const range = topLevelFunctionRange(lines, "openPageDetail");
  assert.ok(range, "app.js 里找不到顶层 function openPageDetail( —— 结构变了，先修这条判据");
  const hits = assignmentHits(source, "lastDetailPageNo");
  assert.equal(hits.length, 1,
    `lastDetailPageNo 的赋值点是 ${hits.length} 处（${hits.map((h) => h.line).join(" / ")}）——`
    + "它必须是只写一次的「回忆」，否则 detailPageNo 那个「两个真源」的问题会在这里重演");
  assert.ok(hits[0].line >= range[0] && hits[0].line <= range[1],
    `lastDetailPageNo 在 ${hits[0].line} 行被赋值，不在 openPageDetail（${range[0]}–${range[1]}）里——`
    + "它必须是只写一次的「回忆」，否则又变成第二个真源");
});

test("④ 运行时：showView(\"pages\") 之后 detailPageNo 必须为 null（行为判据）", () => {
  const ctx = loadApp();
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
    // 前置：模拟"详情开着"（读法见下：detailPageNo 是顶层 let，不挂全局对象，但 runInContext 能读词法绑定）
    detailPageNo = 1;
  `, ctx);
  vm.runInContext('showView("pages");', ctx);
  const after = vm.runInContext("detailPageNo", ctx);
  assert.equal(after, null,
    `showView("pages") 之后 detailPageNo = ${JSON.stringify(after)}——状态活过了它的视图：`
    + "错误会写进看不见的元素（这是 Builder 真机验收撞到的那个 bug 的形态）");
});
