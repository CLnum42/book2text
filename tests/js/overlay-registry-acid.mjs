// Overlay registry 酸测试（片 1：`type: "blocks"` + 页面网格 / 目录 / 阅读三个消费者）
//
// **模块存在理由的证明，不是行为单测**（形态照 `page-tile-acid.mjs`）。五条判据各自对应
// 一个"错的实现也能让别的闸绿"的盲区；每条都能被一个变异打红（变异怎么跑见文件末尾注释）。
//
// 判据口径（契约 §6 / 施工书 §4）：版本是内容指纹；重画靠"先建后换"不清空；数量以数据为准
// （没有 bbox 的块不画）；旧路径必须归零（点名字段，不只数次数）；取图次数不受图层影响（判 Δ 不判绝对值）。
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { makeDeps, makeEnvironment } from "./tile-harness.mjs";

const STATIC = new URL("../../backend/book2text/static/", import.meta.url);
/** 变异测试用：把被测文件指到副本，产品代码一个字不动。 */
const MODULE_URL = process.env.B2T_OVERLAY_MODULE || new URL("overlay-registry.js", STATIC);

const BLOCKS = [
  { block_id: "b1", order_index: 0, block_type: "heading", bbox: [0.1, 0.1, 0.9, 0.16], include: true, review_status: "confirmed" },
  { block_id: "b2", order_index: 1, block_type: "paragraph", bbox: [0.1, 0.2, 0.9, 0.34], include: true, review_status: "unreviewed" },
  { block_id: "b3", order_index: 2, block_type: "figure", bbox: [0.1, 0.4, 0.6, 0.6], include: false, review_status: "uncertain" },
  { block_id: "b4", order_index: 3, block_type: "paragraph", bbox: null, include: true, review_status: "unreviewed" },
];

/** 极简注释剥离：字符扫描，认行注释与块注释，不碰字符串里的内容（够本文件用）。 */
function stripComments(source) {
  let out = "";
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out += char;
      if (char === "\\") { out += next ?? ""; index += 2; continue; }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; out += char; index += 1; continue; }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** 载入 registry 到一份沙箱里；rAF 由用例显式推帧（`settle()`），不靠真浏览器。 */
function loadRegistry(document) {
  const frames = [];
  const sandbox = {
    document,
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MODULE_URL, "utf8"), sandbox, { filename: "overlay-registry.js" });
  return {
    api: sandbox.OverlayLayer,
    frames,
    settle() {
      let guard = 0;
      while (frames.length && guard < 10) {
        const batch = frames.splice(0, frames.length);
        for (const callback of batch) callback();
        guard += 1;
      }
    },
  };
}

function makePage({ pageNo = 12 } = {}) {
  const environment = makeEnvironment();
  const host = environment.mount();
  const module = loadRegistry(environment.document);
  assert.equal(typeof module.api?.mount, "function", "overlay-registry.js 没暴露 window.OverlayLayer.mount");
  module.api.init({ notify: () => {} });
  const handle = module.api.mount(host, { pageNo });
  return { environment, host, module, handle, pageNo };
}

function containerOf(host) {
  return host.children.find((child) => String(child.className).includes("overlay-layer")) || null;
}

function paintedNodes(host) {
  const container = containerOf(host);
  const subtree = container && container.children[container.children.length - 1];
  return (subtree && subtree.children) || [];
}

// ① 版本一致（v1.1 起：三条断言，不能"自己跟自己比"）
test("① 版本是内容指纹：同内容不变、改一个 bbox 就变、元素上的版本与 stats 一致", () => {
  const { host, module, handle, pageNo } = makePage();
  module.api.paint(handle, { data: BLOCKS, active: ["blocks"], styles: { details: true } });
  module.settle();
  const first = module.api.stats(handle).version;
  assert.match(first, /^[0-9a-f]{8}$/, "版本应当是 8 位十六进制指纹");

  module.api.paint(handle, { data: BLOCKS.map((block) => ({ ...block })), active: ["blocks"], styles: { details: true } });
  module.settle();
  assert.equal(module.api.stats(handle).version, first, "(a) 同内容再 paint 一次，版本必须不变");

  const moved = BLOCKS.map((block, index) => (index === 1 ? { ...block, bbox: [0.1, 0.2, 0.9, 0.4] } : block));
  module.api.paint(handle, { data: moved, active: ["blocks"], styles: { details: true } });
  module.settle();
  const second = module.api.stats(handle).version;
  assert.notEqual(second, first, "(b) 改了一个块的 bbox，版本必须变——否则旧图层会挂在新数据上");

  const nodes = paintedNodes(host);
  assert.equal(nodes.length, 3, "有 bbox 的块才画（3 个）");
  for (const node of nodes) {
    assert.equal(node.dataset.version, second, "(c) 每个已绘元素的 dataset.version 必须等于 stats 的版本");
  }
});

// ② 幂等：同数据连续 paint 不重建（节点身份，不是数量）
test("② 同一份数据连续 paint 两次不改一个节点（没有清空重画）", () => {
  const { host, module, handle } = makePage();
  module.api.paint(handle, { data: BLOCKS, active: ["blocks"], styles: { details: true } });
  module.settle();
  const before = paintedNodes(host)[0];
  assert.ok(before, "第一次 paint 应当画出块框");

  module.api.paint(handle, { data: BLOCKS, active: ["blocks"], styles: { details: true } });
  module.settle();
  assert.equal(paintedNodes(host)[0], before, "同数据第二次 paint 必须命中幂等早退（节点身份不变）");

  const changed = BLOCKS.map((block, index) => (index === 0 ? { ...block, block_type: "footer" } : block));
  module.api.paint(handle, { data: changed, active: ["blocks"], styles: { details: true } });
  module.settle();
  assert.notEqual(paintedNodes(host)[0], before, "数据变了必须换一棵子树");
  assert.ok(paintedNodes(host)[0].className.includes("box--type-footer"), "换过的子树反映新数据");
});

// ③ 数量：以数据为准，没有 bbox 的块不画
test("③ counts.blocks 等于有 bbox 的块数，容器里的元素数与它一致", () => {
  const { host, module, handle, pageNo } = makePage();
  module.api.paint(handle, { data: BLOCKS, active: ["blocks"], styles: { details: true } });
  module.settle();
  const expected = BLOCKS.filter((block) => block.bbox).length;
  assert.equal(module.api.stats(handle).counts.blocks, expected, "stats(handle) 的块数必须等于有 bbox 的块数");
  assert.equal(paintedNodes(host).length, expected, "容器里真的画了这么多");

  module.api.paint(handle, { data: [], active: ["blocks"], styles: { details: true } });
  module.settle();
  assert.equal(module.api.stats(handle).counts.blocks, 0, "空数据要收起图层");
  assert.equal(containerOf(host).hidden, true, "没有块时容器 hidden");
});

// ④ 旧路径归零：点名字段（剥注释后仍 0 次），不只数次数
// 2026-11-04：preview-view.js 已按 L-117 删除，原先"它不自建 .page-overlay / 不比
// _renderedBlocks / 不调 inject.renderPageBlocks"三条随之作废（文件不在了，判据没有对象）。
test("④ 旧路径归零：page-tile.js 的 paintOverlays 死钩子必须删；overlay-registry 先于 app.js", () => {
  const tileSource = stripComments(readFileSync(new URL("page-tile.js", STATIC), "utf8"));
  assert.equal((tileSource.match(/paintOverlays/g) || []).length, 0, "page-tile.js 的 paintOverlays 死钩子必须删");

  const html = readFileSync(new URL("index.html", STATIC), "utf8");
  const overlay = html.indexOf("/static/overlay-registry.js");
  const app = html.indexOf("/static/app.js");
  assert.ok(overlay > 0, "index.html 缺 overlay-registry.js 的 <script>");
  assert.ok(overlay < app, "overlay-registry.js 必须在 app.js 之前加载");
});

// ⑤ 图不受影响：判 Δ（绝对值会把"没建 tile 的环境"也判绿/判红）
test("⑤ 挂图层并重复 paint 不新增取图（Δ == 0，不数网络）", () => {
  const { environment, host, module, handle } = makePage({ pageNo: 1 });
  const tiles = environment.loadTile();
  tiles.init(makeDeps(environment));
  tiles.create(host, { pageNo: 1, size: "view" });
  environment.show();
  environment.settle();
  const srcCount = () =>
    environment.srcWrites.filter((item) => String(item.url).includes("size=view")).length;
  const baseline = srcCount();
  assert.equal(baseline, 1, `基线：建一个 PageTile(size=view) 应当只取 1 次图（实际 ${baseline}）`);

  module.api.paint(handle, { data: BLOCKS, active: ["blocks"], styles: { details: true } });
  module.settle();
  module.api.paint(handle, { data: BLOCKS, active: ["blocks"], styles: { details: true } });
  module.settle();
  assert.equal(srcCount() - baseline, 0, "图层画了两遍，取图次数不许变（Δ 必须是 0）");
});

// 变异（各跑一次，红了才算数；产品代码只用副本，见 `B2T_OVERLAY_MODULE` / `B2T_PREVIEW_VIEW`）：
//   ① fingerprint 改成恒返回 "1"        → ①(b) 红
//   ② 删掉 renderHandle 里的同签名早退    → ② 红
//   ③ 去掉 renderHandle 里的 `!item.bbox` 过滤 → ③ 红
//   ④ 往 preview 副本里加一行 injected.renderPageBlocks(...) → ④ 红
//   ⑤ 让 renderBlock 自己建一个 <img> 并赋 src（size=view） → ⑤ 红

// ⑨-b/⑨-c（笔 C，QA 回归）：句柄按宿主唯一 + 死句柄自愈
test("⑨-b 句柄按宿主唯一：两个宿主 mount 同一页，两层都活着（preview 会一次 mount 全部页）", () => {
  const environment = makeEnvironment();
  const hostA = environment.mount();
  const hostB = environment.mount();
  const module = loadRegistry(environment.document);
  module.api.init({});
  const a = module.api.mount(hostA, { pageNo: 7 });
  const b = module.api.mount(hostB, { pageNo: 7 });
  assert.notEqual(a, b, "同一页在两个宿主上应当是两份句柄");
  assert.equal(a.dead, false, "后 mount 的把先前的句柄弄死了（按 pageNo 唯一的老实现会这样）");
  assert.ok(containerOf(hostA), "先 mount 的图层被摘掉了");
  module.api.paint(a, { data: BLOCKS, active: ["blocks"], styles: { details: true } });
  module.settle();
  assert.equal(a.counts.blocks, 3, "回到先 mount 的宿主后画不出来");
});

test("⑨-c 死句柄自愈：unmount 之后再 paint，重挂一层并画出来（不静默 no-op）", () => {
  const { host, module, handle } = makePage({ pageNo: 8 });
  module.api.paint(handle, { data: BLOCKS, active: ["blocks"], styles: { details: true } });
  module.settle();
  module.api.unmount(handle);
  assert.equal(handle.dead, true, "unmount 之后句柄应当死");
  module.api.paint(handle, { data: BLOCKS, active: ["blocks"], styles: { details: true } });
  module.settle();
  assert.equal(handle.dead, false, "paint 没有自愈死句柄");
  assert.ok(containerOf(host), "自愈后图层不在宿主里");
  assert.equal(handle.counts.blocks, 3, "自愈后没画出来");
});

// stats 的两个签名（Chief 2026-11-02 裁定）：判据只许用 stats(handle)；stats(pageNo) 只作诊断
test("stats(handle) 是判据形式；多宿主时 stats(pageNo) 返回最近 mount 的那一层", () => {
  const environment = makeEnvironment();
  const hostA = environment.mount();
  const hostB = environment.mount();
  const module = loadRegistry(environment.document);
  module.api.init({});
  const a = module.api.mount(hostA, { pageNo: 9 });
  module.api.paint(a, { data: BLOCKS, active: ["blocks"], styles: { details: true } });
  module.settle();
  const b = module.api.mount(hostB, { pageNo: 9 });
  module.api.paint(b, { data: BLOCKS.slice(0, 1), active: ["blocks"], styles: { details: true } });
  module.settle();

  assert.equal(module.api.stats(a).counts.blocks, 3, "stats(handleA) 必须报 A 自己的层");
  assert.equal(module.api.stats(b).counts.blocks, 1, "stats(handleB) 必须报 B 自己的层");
  assert.notEqual(module.api.stats(a).version, module.api.stats(b).version, "两层版本应当不同");
  // pageNo 形式：最近 mount 的是 B
  assert.equal(module.api.stats(9).counts.blocks, 1, "stats(pageNo) 多宿主时应报最近 mount 的那层（只作诊断）");
});
