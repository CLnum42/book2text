// PageTile 的行为单测（§21.4–§21.7）。数"取图次数 / observer 个数"的判据在
// `tests/js/page-tile-acid.mjs`（酸测试），这里只锁可观察行为：
// 返回 null 的条件、状态流转、唯一资源、升档、作废、释放、自动出组、不复活、缺失态。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDeps, makeEnvironment } from "./tile-harness.mjs";

/** 每个用例一套新环境：模块的注册表是模块级状态，跨用例共享会互相污染。 */
function setup(overrides) {
  const environment = makeEnvironment();
  const tiles = environment.loadTile();
  const deps = makeDeps(environment, overrides);
  tiles.init(deps);
  return { environment, tiles, deps };
}

test("create：页不存在返回 null，参数不合法也返回 null（「页不存在」与「图没到」必须可分辨）", () => {
  const { environment, tiles } = setup();
  const host = environment.mount();
  assert.equal(tiles.create(host, { pageNo: 99, size: "view" }), null);
  assert.equal(tiles.create(null, { pageNo: 1, size: "view" }), null);
  assert.equal(tiles.create(host, { pageNo: "x", size: "view" }), null);
});

test("create：先 pending，观察器报可见后 ready，onReady 收到 ready 与 url", async () => {
  const { environment, tiles } = setup();
  const host = environment.mount();
  const seen = [];
  const handle = tiles.create(host, { pageNo: 1, size: "view", onReady: (payload) => seen.push(payload) });
  assert.ok(handle, "页存在时必须返回 handle");
  assert.equal(handle.status, "pending");
  environment.show();
  environment.settle();
  assert.equal(handle.status, "ready");
  assert.equal(handle.url, "/api/projects/b2t_TEST/pages/1/image?size=view&token=t");
  assert.ok(seen.some((payload) => payload.status === "ready" && payload.size === "view"));
});

test("同一页两个消费者：共用同一个 img 节点（唯一资源），挂载即移动", () => {
  const { environment, tiles } = setup();
  const first = environment.mount();
  const second = environment.mount();
  const a = tiles.create(first, { pageNo: 2, size: "view" });
  environment.show();
  const b = tiles.create(second, { pageNo: 2, size: "view" });
  assert.equal(a.img, b.img);
  assert.equal(b.img.parentNode, b.el, "第二次 create 之后图挂在后一个宿主的瓷砖里");
  assert.equal(a.status, b.status);
});

test("同一页一个观察器：第二个消费者不再新建", () => {
  const { environment, tiles } = setup();
  const a = tiles.create(environment.mount(), { pageNo: 2, size: "view" });
  const b = tiles.create(environment.mount(), { pageNo: 2, size: "view" });
  assert.ok(a && b);
  assert.equal(environment.observers.length, 1);
});

test("update：升档时两个持有者都看到新档与新 url", () => {
  const { environment, tiles } = setup();
  const a = tiles.create(environment.mount(), { pageNo: 1, size: "view" });
  const b = tiles.create(environment.mount(), { pageNo: 1, size: "view" });
  environment.show();
  environment.settle();
  tiles.update(a, { size: "zoom" });
  assert.equal(a.size, "zoom");
  assert.equal(a.url, "/api/projects/b2t_TEST/pages/1/image?size=zoom&token=t");
  assert.equal(b.size, "zoom", "同一页只有一份缓存：升档对同页所有 handle 生效");
});

test("尺寸档越界：降级到 view，并只提示一次", () => {
  const { environment, tiles } = setup();
  const first = tiles.create(environment.mount(), { pageNo: 1, size: "巨大" });
  const second = tiles.create(environment.mount(), { pageNo: 2, size: "巨大" });
  assert.equal(first.size, "view");
  assert.equal(second.size, "view");
  const warned = environment.notifications.filter((payload) => payload.kind === "warn");
  assert.equal(warned.length, 1, "同一个越界尺寸反复提示等于刷屏");
});

test("invalidate：一次作废，两个持有者同时回到 pending，再可见后 url 不变", () => {
  const { environment, tiles } = setup();
  const a = tiles.create(environment.mount(), { pageNo: 1, size: "view" });
  const b = tiles.create(environment.mount(), { pageNo: 1, size: "view" });
  environment.show();
  environment.settle();
  const before = a.url;
  tiles.invalidate(1, "image");
  assert.equal(a.status, "pending");
  assert.equal(b.status, "pending");
  environment.show();
  environment.settle();
  assert.equal(a.url, before);
  assert.equal(a.status, "ready");
  assert.equal(b.status, "ready");
});

test("release：从组里移除该 handle，另一个仍在显示；已出组的 handle 不复活", () => {
  const { environment, tiles } = setup();
  const first = environment.mount();
  const second = environment.mount();
  const a = tiles.create(first, { pageNo: 1, size: "view" });
  const b = tiles.create(second, { pageNo: 1, size: "view" });
  environment.show();
  environment.settle();
  tiles.release(a);
  assert.equal(a.dead, true);
  assert.equal(b.img.parentNode, b.el, "图交给还在组里的持有者，别让另一处凭空变空");
  assert.equal(tiles.update(a, { size: "zoom" }), null, "已出组的 handle 不自动复活");
});

test("宿主从文档移除：帧末自动出组（不依赖调用方记得 release）", async () => {
  const { environment, tiles } = setup();
  const host = environment.mount();
  const handle = tiles.create(host, { pageNo: 3, size: "view" });
  environment.show();
  environment.body.removeChild(host);
  await environment.tick();
  assert.equal(handle.dead, true);
});

test("移动宿主（摘下来再插到别处）：不释放、状态不变", async () => {
  const { environment, tiles } = setup();
  const host = environment.mount();
  const handle = tiles.create(host, { pageNo: 3, size: "view" });
  environment.show();
  environment.settle();
  const other = environment.mount();
  other.appendChild(handle.el);          // 移动语义：先"移除"再"插回"
  await environment.tick();
  assert.equal(handle.dead, false);
  assert.equal(handle.status, "ready");
});

test("图缺失：状态 missing、瓷砖带 is-missing、onReady 必须被调用（不静默）", () => {
  const { environment, tiles } = setup();
  const seen = [];
  const host = environment.mount();
  const handle = tiles.create(host, { pageNo: 1, size: "view", onReady: (payload) => seen.push(payload) });
  environment.show();
  handle.img.onerror();
  assert.equal(handle.status, "missing");
  assert.equal(handle.el.classList.contains("is-missing"), true);
  assert.ok(seen.some((payload) => payload.status === "missing"));
});

test("缺必需依赖：fail closed——create 一律 null，并提示一次（不许静默出一片空白）", () => {
  const environment = makeEnvironment();
  const tiles = environment.loadTile();
  const notifications = [];
  tiles.init({
    getProject: () => environment.project,
    notify: (payload) => notifications.push(payload),
  });
  const handle = tiles.create(environment.mount(), { pageNo: 1, size: "view" });
  assert.equal(handle, null);
  assert.equal(notifications.length, 1);
  assert.ok(String(notifications[0].text).includes("getImageUrl"));
});

test("补齐依赖后重新 init：create 恢复正常（fail closed 不是永久坏掉）", () => {
  const environment = makeEnvironment();
  const tiles = environment.loadTile();
  tiles.init({ getProject: () => environment.project });
  assert.equal(tiles.create(environment.mount(), { pageNo: 1, size: "view" }), null);
  tiles.init(makeDeps(environment));
  const handle = tiles.create(environment.mount(), { pageNo: 1, size: "view" });
  assert.ok(handle, "补上 getImageUrl 之后应当出瓷砖");
});

test("没有 rAF：注册表清空后不再排扫（不许留常驻定时器）", () => {
  const queue = [];
  let scheduled = 0;
  const schedule = (fn) => {
    scheduled += 1;
    const entry = { fn, cancelled: false };
    queue.push(entry);
    return { unref() {}, entry };
  };
  const drainOne = () => {
    const entry = queue.shift();
    if (entry) entry.fn();
  };

  const environment = makeEnvironment({ setTimeout: schedule });
  const tiles = environment.loadTile();
  tiles.init(makeDeps(environment));
  const host = environment.mount();
  const handle = tiles.create(host, { pageNo: 1, size: "view" });
  environment.show();
  environment.settle();
  assert.equal(scheduled, 1);
  drainOne();                          // 注册表非空 → 扫完继续排
  assert.equal(scheduled, 2);

  environment.body.removeChild(host);   // 宿主没了
  drainOne();                           // 扫到空组 → 释放 → 注册表空
  const atEmpty = scheduled;
  drainOne();                           // 队列已空：不该再排
  assert.equal(scheduled, atEmpty, "注册表清空后还排扫 = 常驻定时器");
  assert.equal(handle.dead, true);
});
