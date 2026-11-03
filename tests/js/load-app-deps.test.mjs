// `appModuleDeps` 的常量映射（片 3b 登记时记下的欠账）。
//
// 背景：视图读 `injected.PAGE_ZOOM_LEVELS`，而常量真身在 `page-media.js` 的 `zoomLevels`
// 属性上——名字不一样，靠 `appModuleDeps` 里那 4 行映射接上。删掉那 4 行时整套 node 闸是
// 0 红（台架专用、当时无覆盖），所以这里补一条，让它以后删了会红。
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp, appModuleDeps } from "./load-app.mjs";

const PAGES_VIEW_SRC = readFileSync(
  new URL("../../backend/book2text/static/pages-view.js", import.meta.url),
  "utf8"
);

test("appModuleDeps：PAGE_ZOOM_LEVELS 取 PageMedia.zoomLevels（同引用）", () => {
  const ctx = loadApp({ require: [] });
  assert.ok(ctx.PageMedia, "page-media.js 没预载——映射会读不到常量");
  const deps = appModuleDeps(ctx, PAGES_VIEW_SRC);
  assert.equal(
    deps.PAGE_ZOOM_LEVELS,
    ctx.PageMedia.zoomLevels,
    "常量映射没接上：视图读 injected.PAGE_ZOOM_LEVELS 会是 undefined"
  );
});

test("appModuleDeps：PageMedia 缺失时 PAGE_ZOOM_LEVELS 落回桩，不抛", () => {
  const ctx = loadApp({ require: [] });
  ctx.PageMedia = null;
  const deps = appModuleDeps(ctx, PAGES_VIEW_SRC);
  assert.equal(typeof deps.PAGE_ZOOM_LEVELS, "function", "缺失时应当仍是可调用的桩");
  assert.equal(deps.PAGE_ZOOM_LEVELS(), undefined);
});
