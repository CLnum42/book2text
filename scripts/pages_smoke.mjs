#!/usr/bin/env node
// pages 落盘的双向烟测：外壳调用 ↔ 模块 api 键，缺一边都是运行时 undefined.apply，
// 而 node / pytest / accept 三条闸都看不见（那是"闸全绿、产品坏"）。
//
// 用法：node scripts/pages_smoke.mjs [modulePath] [appPath]
// 判据：两个差集都为空；有差集时 exit 1 并逐条打印。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const modulePath = resolve(process.argv[2] || `${repo}/backend/book2text/static/pages-view.js`);
const appPath = resolve(process.argv[3] || `${repo}/backend/book2text/static/app.js`);

const moduleSource = readFileSync(modulePath, "utf8");
const appSource = readFileSync(appPath, "utf8");

// 模块 api：取最后一个 `const api = {` 到对应的 `  };`
const apiStart = moduleSource.lastIndexOf("const api = {");
if (apiStart < 0) {
  console.error(`✗ ${modulePath} 里找不到 const api = {`);
  process.exit(2);
}
const bodyStart = apiStart + "const api = {".length;
const bodyEnd = moduleSource.indexOf("\n  };", bodyStart);
if (bodyEnd < 0) {
  console.error("✗ api 对象没有结束行 `  };`");
  process.exit(2);
}
const apiKeys = moduleSource
  .slice(bodyStart, bodyEnd)
  .split("\n")
  .map((line) => line.trim().replace(/,$/, ""))
  .filter(Boolean)
  .map((line) => line.split(":")[0].trim());

// 兼容 `PagesView.x` 与 `PagesView?.x`（可选链也是真实调用点）
const shellKeys = [...new Set([...appSource.matchAll(/PagesView\??\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
const shellOnly = shellKeys.filter((key) => !apiKeys.includes(key));
const moduleOnly = apiKeys.filter((key) => !shellKeys.includes(key));
const duplicateExports = (moduleSource.match(/window\.PagesView\s*=/g) || []).length;

const result = {
  module: modulePath.replace(`${repo}/`, ""),
  app: appPath.replace(`${repo}/`, ""),
  apiKeys: apiKeys.length,
  shellRefs: shellKeys.length,
  windowPagesViewAssignments: duplicateExports,
  shellOnly,
  moduleOnly,
};
console.log(JSON.stringify(result, null, 1));

const bad = shellOnly.length > 0 || moduleOnly.length > 0 || duplicateExports !== 1;
if (bad) {
  if (shellOnly.length) console.error(`✗ 外壳调用了模块没有的键：${shellOnly.join("、")}（运行时 undefined.apply）`);
  if (moduleOnly.length) console.error(`✗ 模块有键但外壳没有调用点：${moduleOnly.join("、")}（导出面多了/调用点漏了）`);
  if (duplicateExports !== 1) console.error(`✗ window.PagesView 赋值 ${duplicateExports} 次（应恰 1 次）`);
  process.exit(1);
}
console.log("✓ 双向烟测通过：两边差集都空，window.PagesView 恰一处");
