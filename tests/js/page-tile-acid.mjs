// PageTile 酸测试（§21.8）——**模块存在理由的证明**，不是行为单测。
//
// 判据（D-109 口径，别改成网络请求数）：同一页同一档位的 `<img>.src` 赋值次数 = 1、
// observer 个数 = 1、`release` 一个不影响另一个、超页数不泄漏、移动宿主不重新取图。
// 由 `scripts/acid_pagetile.py` 调起：它负责"模块不存在/API 缺失"这类前置判断，
// 这里只判可数量的三件与两条泄漏面，最后打一行 `RESULT {…}` 给 Python 判。
import { makeDeps, makeEnvironment } from "./tile-harness.mjs";

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail });

function srcCount(environment, size) {
  return environment.srcWrites.filter((item) => item.url.includes(`size=${size}`)).length;
}

function tileNodes(body) {
  const found = [];
  const walk = (node) => {
    if (!node || !node.children) return;
    for (const child of node.children) {
      if (String(child.className).includes("ptile")) found.push(child);
      walk(child);
    }
  };
  walk(body);
  return found;
}

// ① 两个消费者 + 一处 invalidate：两次观察后一共只取 2 次图（首次 1 + 作废后 1）
{
  const environment = makeEnvironment();
  const tiles = environment.loadTile();
  tiles.init(makeDeps(environment));
  const a = tiles.create(environment.mount(), { pageNo: 1, size: "view" });
  const b = tiles.create(environment.mount(), { pageNo: 1, size: "view" });
  environment.show();
  environment.settle();
  const first = srcCount(environment, "view");
  record("同页两消费者首次取图 = 1", first === 1, `实际 ${first}`);

  const observers = environment.observers.length;
  record("同页 observer = 1", observers === 1, `实际 ${observers}`);

  const urlBefore = a.url;
  tiles.invalidate(1, "image");
  environment.show();
  environment.settle();
  const afterInvalidate = srcCount(environment, "view");
  record("一处 invalidate 只新增 1 次取图", afterInvalidate === first + 1, `实际 ${afterInvalidate}`);
  record("两处同时更新到同一 url", a.url === urlBefore && b.url === urlBefore, `a=${a.url} b=${b.url}`);

  const heldImage = b.img.parentNode === b.el;
  tiles.release(a);
  const otherStillShows = b.img.parentNode === b.el && b.dead === false;
  record("release 一个不影响另一个的显示", heldImage && otherStillShows && environment.observers[0].disconnects === 0,
    `held=${heldImage} other=${otherStillShows} disconnects=${environment.observers[0].disconnects}`);
}

// ② 泄漏面：建 N 个 → 宿主全摘 → 注册表与 observer 回 0
{
  const environment = makeEnvironment({ pages: [1, 2, 3] });
  const tiles = environment.loadTile();
  tiles.init(makeDeps(environment));
  const handles = [1, 2, 3].map((pageNo) => tiles.create(environment.mount(), { pageNo, size: "thumb" }));
  environment.show();
  environment.settle();
  // 摘掉所有宿主（模拟页面视图被整体替换）
  for (const handle of handles) {
    if (handle.el.parentNode && handle.el.parentNode.parentNode) {
      handle.el.parentNode.parentNode.removeChild(handle.el.parentNode);
    }
  }
  await environment.tick(80);
  const left = tileNodes(environment.body).length;
  const disconnects = environment.observers.map((observer) => observer.disconnects);
  record("宿主全移除后注册表与 observer 回 0",
    left === 0 && disconnects.every((count) => count === 1),
    `剩 ${left} 个瓷砖 / disconnect ${disconnects.join(",")}`);
}

// ③ 移动宿主：不释放、不重新取图
{
  const environment = makeEnvironment();
  const tiles = environment.loadTile();
  tiles.init(makeDeps(environment));
  const host = environment.mount();
  const handle = tiles.create(host, { pageNo: 2, size: "view" });
  environment.show();
  environment.settle();
  const before = srcCount(environment, "view");
  const other = environment.mount();
  other.appendChild(handle.el);
  await environment.tick(60);
  const after = srcCount(environment, "view");
  record("移动宿主不释放、不重新取图",
    handle.dead === false && after === before,
    `dead=${handle.dead} src ${before}→${after}`);
}

const failed = checks.filter((item) => !item.ok);
console.log(`RESULT ${JSON.stringify({ ok: failed.length === 0, checks })}`);
for (const item of checks) {
  console.log(`${item.ok ? "✔" : "✖"} ${item.name}（${item.detail}）`);
}
process.exit(failed.length === 0 ? 0 : 1);
