// merge 视图两处 P0 的特征测试（2026-10-29，QA 在真实页面复现）。
//
// ① `showView('merge')` 必须只调 `MergeView.enter`：`cef331b` 把 merge 分支嵌进了
//    preview 的 `if` 块（少一个右括号），进合并视图是白屏。
// ② 原图 URL 的查询键必须是 `token=`：`merge-view.js` 写成 `&injected.token=`，
//    服务端 401，中间列永远「渲染失败」。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadApp } from "./load-app.mjs";

const MERGE_VIEW = process.env.B2T_MERGE_VIEW_JS
  || fileURLToPath(new URL("../../backend/book2text/static/merge-view.js", import.meta.url));

test("P0-①：showView('merge') 进的是合并视图，不是预览视图", () => {
  const ctx = loadApp();                       // B2T_APP_JS 可指向历史版本，用来验红
  // 不用调用计数（A5 禁止断言调用次数/顺序）：错误分支直接抛，正确分支写一个可观察标记。
  ctx.window.PreviewView = { enter: () => { throw new Error("showView('merge') 调了 PreviewView.enter"); } };
  ctx.window.MergeView = { enter: () => { ctx.document.body.dataset.mergeEntered = "1"; } };
  // currentProject 是顶层 let，只有 vm 内部能赋值（load-app 的已知边界）；
  // getElementById 默认返回 null，showView 会写 .hidden——给一个万能节点。
  vm.runInContext(`
    const makeNode = () => ({
      hidden: false, dataset: {}, style: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
      textContent: "", innerHTML: "", value: "", disabled: false,
      append(){}, appendChild(){}, addEventListener(){}, removeEventListener(){},
      setAttribute(){}, removeAttribute(){}, getAttribute(){ return null; },
      focus(){}, blur(){}, click(){}, closest(){ return null; },
      querySelector: () => null, querySelectorAll: () => [], children: [],
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
    });
    document.getElementById = makeNode;
    document.createElement = makeNode;
    currentProject = { project_id: 'p1' };
    currentView = 'pages';
  `, ctx);
  ctx.showView("merge");
  assert.equal(ctx.document.body.dataset.mergeEntered, "1",
    "showView('merge') 没有进合并视图：merge 分支被嵌在 preview 的 if 里（右括号少一个）");
});

test("P0-②：原图 URL 的键是 token=，不是 &injected.token=", () => {
  const src = readFileSync(MERGE_VIEW, "utf8");
  const bad = src.match(/&injected\.[A-Za-z_$][\w$]*=/g);
  assert.equal(bad, null, `URL 查询键写成了模板占位：${bad && bad.join("、")}——服务端会 401`);
  assert.match(src, /[?&]token=\$\{encodeURIComponent\(injected\.token\)\}/, "找不到正确形态 &token=${encodeURIComponent(injected.token)}");
});
