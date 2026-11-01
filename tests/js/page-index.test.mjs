// 刀 C：page-index.js 的服务语义（状态搬走之后，外壳只经它读写）
//
// 锁两件"搬状态时最容易悄悄坏掉"的事：
//   ① 块缓存只有一份——`loadBlocks` 必须走外壳给的 blocksGet/blocksRemember，
//      所以同一页加载两次**只发一次请求**（模块不许自己再存一份缓存）；
//   ② 并发两次 `loadIndex()`，第二次仍是 `{status:"busy"}`（状态在模块闭包里，语义不比搬走前松）。
// 外加清晰度档：`setImageQuality` 写档位之后，radio 由模块同步（radio 列表也由外壳给）。
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const MODULE_URL = process.env.B2T_PAGE_INDEX_JS
  || new URL("../../backend/book2text/static/page-index.js", import.meta.url);
/** ⑤ 判据读的 app.js（变异时用 B2T_APP_JS 指到一份留了旧状态的副本）。 */
const APP_URL = process.env.B2T_APP_JS
  || new URL("../../backend/book2text/static/app.js", import.meta.url);

const PROJECT = { project_id: "b2t_TEST" };

/** 起一个模块实例：块缓存用一份真 Map（模拟外壳那一份），请求次数记在 counters 里。 */
function loadService({ pages = {}, failBlocks = false } = {}) {
  const cache = new Map();
  const counters = { index: 0, blocks: 0 };
  const sandbox = {
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
      setItem(key, value) { this.store.set(String(key), String(value)); },
    },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MODULE_URL, "utf8"), sandbox, { filename: "page-index.js" });
  const service = sandbox.PageIndexService;
  service.init({
    apiJson: async (url) => {
      if (url.endsWith("/page-index")) {
        counters.index += 1;
        return { pages: [{ page_no: 1 }], stats: { total: 1 } };
      }
      counters.blocks += 1;
      if (failBlocks) throw new Error("boom");
      const pageNo = Number(/\/(\d+)\/blocks$/.exec(url)[1]);
      return { blocks: pages[pageNo] || [] };
    },
    getCurrentProject: () => PROJECT,
    getQualityRadios: () => sandbox.__radios || [],
    blocksKey: (pageNo) => `${PROJECT.project_id}:${pageNo}`,
    blocksGet: (key) => cache.get(key),
    blocksRemember: (key, blocks) => {
      cache.set(key, blocks);
    },
  });
  return { service, counters, cache };
}

test("① 同一页加载两次只发一次请求（缓存是外壳那一份，模块不另存）", async () => {
  const { service, counters } = loadService({ pages: { 3: [{ block_id: "b1", bbox: [0, 0, 1, 1] }] } });
  const first = await service.loadBlocks(3);
  const second = await service.loadBlocks(3);
  assert.equal(counters.blocks, 1, `同一页应当只请求一次，实际 ${counters.blocks} 次——缓存没被复用`);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
});

test("② 并发两次 loadIndex：第二次仍是 busy（不是 error、不是 ok）", async () => {
  const { service, counters } = loadService();
  const inflight = service.loadIndex();
  const second = await service.loadIndex();
  assert.equal(second.status, "busy", `第二次并发必须是 busy，实际 ${second.status}`);
  const first = await inflight;
  assert.equal(first.status, "ok");
  assert.equal(counters.index, 1, "busy 那次不该真的再发请求");
  assert.equal(service.isLoading(), false, "收尾之后 isLoading 必须回到 false");
});

test("③ 清晰度档：写档位 → radio 由模块同步（radio 列表来自外壳）", () => {
  const { service } = loadService();
  const radios = [
    { value: "auto", checked: true },
    { value: "standard", checked: false },
    { value: "high", checked: false },
  ];
  // 模块拿的是外壳给的同一批对象
  vm.runInContext("void 0", vm.createContext({}));
  service.init({ getQualityRadios: () => radios });
  service.setImageQuality("high");
  assert.equal(service.getImageQuality(), "high");
  assert.deepEqual(radios.map((radio) => radio.checked), [false, false, true], "radio 没被同步到 high");
  service.setImageQuality("不认识");
  assert.equal(service.getImageQuality(), "high", "不认识的值必须被忽略（与搬走前一致）");
});

/** 极简注释剥离：只为了不把注释里提到的名字算成"引用"。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("⑤ 四份状态在 app.js 里定义位与引用位都归零（不许留双份）", () => {
  const source = stripComments(readFileSync(APP_URL, "utf8"));
  for (const name of ["pageIndexData", "pageIndexProject", "pageIndexLoading", "imageQualityMode"]) {
    const hits = (source.match(new RegExp(`\\b${name}\\b`, "g")) || []).length;
    assert.equal(hits, 0, `app.js 里还有 ${hits} 次 ${name}——状态必须整体搬走，不能留双份`);
  }
});

test("④ 块请求失败返回 []（读不到块不算错，与搬走前一致）", async () => {
  const { service } = loadService({ failBlocks: true });
  const blocks = await service.loadBlocks(9);
  assert.equal(blocks.length, 0, "取不到块必须返回空数组（不是 undefined / 不是抛）");
});
