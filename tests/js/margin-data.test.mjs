// 片 2 补漏：版心数据的**坏输入契约**（tile / page / margin_box）。
//
// 锁四件：
// ① null tile、tile 缺 `.page-margin` → 静默 return，不抛；
// ② page 无 box（auto 但没 margin_box、项目也没默认）→ hidden=true、_box=null、样式未写；
// ③ margin_box 脏（缺项 / 字符串 / NaN / Infinity）→ **等同无 box**，样式里不许出现 NaN%;
// ④ 正向对照：合法 4 元数照旧写百分比，且同一 box 第二次不重写（滚动每帧都会走到）。
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const MODULE = readFileSync(
  new URL("../../backend/book2text/static/margin-data.js", import.meta.url),
  "utf8"
);

function setup({ project = { project_id: "b2t_TEST", margin_box: null } } = {}) {
  const store = new Map();
  const sandbox = {
    console,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    document: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MODULE, sandbox, { filename: "margin-data.js" });
  const api = sandbox.window.MarginData;
  const state = { project, pagesMarginOn: true, reviewMarginOn: true };
  api.init({
    getCurrentProject: () => state.project,
    getPagesMarginOn: () => state.pagesMarginOn,
    setPagesMarginOn: (value) => { state.pagesMarginOn = value; return value; },
    getReviewMarginOn: () => state.reviewMarginOn,
    setReviewMarginOn: (value) => { state.reviewMarginOn = value; return value; },
    getTileByPageNo: () => null,
  });
  return { api, state };
}

/** 最小 tile：只实现模块用到的 querySelector / classList / style。 */
function makeTile({ margin = true, boxEl = true } = {}) {
  const classes = new Set();
  const box = { style: {} };
  const marginEl = {
    hidden: false,
    _box: undefined,
    _pageNo: undefined,
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    querySelector: (sel) => (sel === ".page-margin__box" ? (boxEl ? box : null) : null),
  };
  return {
    marginEl,
    box,
    classes,
    querySelector: (sel) => (sel === ".page-margin" ? (margin ? marginEl : null) : null),
  };
}

const page = (extra = {}) => ({
  page_no: 1,
  width_pt: 600,
  height_pt: 800,
  margin_box_mode: "auto",
  ...extra,
});

/** 样式里出现了 NaN/undefined 就是脏数据漏到了 DOM。 */
function assertCleanStyle(style) {
  const text = JSON.stringify(style);
  assert.ok(!/NaN|undefined|Infinity/.test(text), `样式里出现脏值：${text}`);
}

test("坏输入：null tile / 缺 .page-margin → 静默 return，不抛", () => {
  const { api } = setup();
  assert.doesNotThrow(() => api.paintTileMargin(null, page({ margin_box_mode: "custom", margin_box: [0, 0, 1, 1] })));
  assert.doesNotThrow(() => api.clearTileMargin(null));
  const bare = makeTile({ margin: false });
  assert.doesNotThrow(() => api.paintTileMargin(bare, page({ margin_box_mode: "custom", margin_box: [0, 0, 1, 1] })));
  assert.doesNotThrow(() => api.clearTileMargin(bare));
});

test("坏输入：page 为空 / 无 box → hidden=true、_box=null、样式未写", () => {
  const { api } = setup();
  const tile = makeTile();
  assert.doesNotThrow(() => api.paintTileMargin(tile, null));
  assert.equal(tile.marginEl.hidden, true);
  assert.equal(tile.marginEl._box, null);

  api.paintTileMargin(tile, page());
  assert.equal(tile.marginEl.hidden, true, "auto 且页上没有 margin_box、项目也没有默认 ⇒ 不画");
  assert.equal(tile.marginEl._box, null);
  assert.deepEqual(tile.box.style, {});
});

test("脏 box：缺项 / 字符串 / NaN / Infinity 一律等同无 box，不许写出 NaN%", () => {
  const dirty = [
    [1, 2, 3],
    [1, 2, 3, 4, 5],
    ["a", "b", "c", "d"],
    [0, 0, NaN, 1],
    [0, 0, Infinity, 1],
    "0,0,1,1",
    { x0: 0, y0: 0, x1: 1, y1: 1 },
  ];
  for (const margin_box of dirty) {
    const { api } = setup();
    const tile = makeTile();
    api.paintTileMargin(tile, page({ margin_box_mode: "custom", margin_box }));
    assert.equal(tile.marginEl.hidden, true, `${JSON.stringify(margin_box)} 应等同无 box`);
    assert.equal(tile.marginEl._box, null);
    assert.deepEqual(tile.box.style, {});
    assertCleanStyle(tile.box.style);
  }
});

test("脏 box：项目级默认版心同样校验（不是只校验页上的）", () => {
  const { api } = setup({ project: { project_id: "b2t_TEST", margin_box: [0, 0, NaN, 1] } });
  const tile = makeTile();
  api.paintTileMargin(tile, page({ margin_box_mode: "inherit" }));
  assert.equal(tile.marginEl.hidden, true);
  assert.deepEqual(tile.box.style, {});
  assertCleanStyle(tile.box.style);
});

test("正向对照：合法 4 元数写百分比；同一 box 第二次不重写（滚动缓存）", () => {
  const { api } = setup();
  const tile = makeTile();
  api.paintTileMargin(tile, page({ margin_box_mode: "custom", margin_box: [0.1, 0.2, 0.9, 0.95] }));
  assert.equal(tile.marginEl.hidden, false);
  assert.deepEqual([...tile.marginEl._box], [0.1, 0.2, 0.9, 0.95]);
  const near = (actual, expected) =>
    assert.ok(Math.abs(parseFloat(actual) - expected) < 1e-9, `${actual} ≠ ${expected}%`);
  near(tile.box.style.left, 10);
  near(tile.box.style.top, 20);
  near(tile.box.style.width, 80);
  near(tile.box.style.height, 75);

  // 值没变就不该再写：把样式改成哨兵值，再画一次，哨兵必须还在
  tile.box.style.left = "sentinel";
  api.paintTileMargin(tile, page({ margin_box_mode: "custom", margin_box: [0.1, 0.2, 0.9, 0.95] }));
  assert.equal(tile.box.style.left, "sentinel", "同一 box 第二次不应重写样式");
});

test("applyMarginRect：直接喂脏 box 也不写（导出面同样兜底）", () => {
  const { api } = setup();
  const box = { style: {} };
  assert.doesNotThrow(() => api.applyMarginRect(box, [1, 2, 3]));
  assert.deepEqual(box.style, {});
  assert.doesNotThrow(() => api.applyMarginRect(null, [0, 0, 1, 1]));
});

test("formatMarginBox：脏 box 显示「未设置」，不出 NaN% 读数", () => {
  const { api } = setup();
  assert.equal(api.formatMarginBox([0, 0, NaN, 1]), "未设置");
  assert.equal(api.formatMarginBox(["a", "b", "c", "d"]), "未设置");
  assert.equal(api.formatMarginBox(null), "未设置");
  assert.equal(api.formatMarginBox([0, 0.1, 1, 0.9]), "左 0.0% · 上 10.0% · 右 100.0% · 下 90.0%");
});

test("clearTileMargin：画过之后清掉 → hidden=true、_box=null", () => {
  const { api } = setup();
  const tile = makeTile();
  api.paintTileMargin(tile, page({ margin_box_mode: "custom", margin_box: [0.1, 0.1, 0.9, 0.9] }));
  assert.equal(tile.marginEl.hidden, false);
  api.clearTileMargin(tile);
  assert.equal(tile.marginEl.hidden, true);
  assert.equal(tile.marginEl._box, null);
});
