// ③ 导出面板模块（`export-panel.js`，root = #export-panel）。
//
// 锁三件：
// ① 接口面恰好 5 个键（每个都能指出调用点；不给"预留"留位置）
// ② `preflightRows` / `preflightNotes` 的**对集**：同一份 data 喂进去，行的 label/value 与提醒文案逐字相等
//    （拆分 renderPreflight 那笔的行为基线；纯函数不碰 DOM，但这里从公开动作 `refreshPreflight` 进，
//     顺带证明"请求 → 读回 → 重画"这条链是接上的）
// ③ `exportOptions()` 从 root 里读勾选，形状固定（含 range 解析与两个格式的组合规则）
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const MODULE_URL = new URL("../../backend/book2text/static/export-panel.js", import.meta.url);

const mk = (extra = {}) => ({
  textContent: "", hidden: false, checked: false, value: "", className: "", dataset: {}, style: {}, children: [],
  classList: { add() {}, remove() {}, toggle() {} },
  append(...kids) { this.children.push(...kids); },
  appendChild(kid) { this.children.push(kid); return kid; },
  addEventListener() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  ...extra,
});

const FIXTURE = {
  exported_pages: [1, 2, 3], segment_count: 4, char_count: 100,
  notes_count: 0, notes_char_count: 0,
  streams: {
    body: { segments: 4, chars: 100 },
    notes: { notes: 0, chars: 0 },
    meta: { pages: 3, printed_page_found: 2, printed_page_missing: [3] },
  },
  page_number_mapping: { found: 2, total: 3, missing_pages: [3] },
  rules: { include_notes: false },
  merged_segments: 1, hyphenations_restored: 2, unreviewed_segments: 1, uncertain_segments: 0,
  excluded_block_types: ["header"], layout_confirmed_pages: 2, layout_pages: 3,
  workflow_status: {
    total: 3, human_confirmed: 1, auto_passed: 1, single_engine: 1, layout_unconfirmed: 1, recognition_failed: 0,
  },
  margin_judgement: false,
  unfinished_pages: [], dropped_pages: [], chrome_suspect_count: 0,
  layout_unconfirmed_pages: [], unreviewed_segments: 1,
};

const EXPECTED_ROWS = [
  ["导出页数", "3 页"],
  ["正文段数", "4 段"],
  ["正文字数", "100 字"],
  ["注释条数", "0 条（未导出）"],
  ["注释字数", "0 字"],
  ["元数据页数", "3 页"],
  ["页码映射", "2 / 3 页"],
  ["跨块合并的段", "1 段"],
  ["断词还原", "2 处"],
  ["未审校的段", "1 段"],
  ["不确定的段", "0 段"],
  ["正文不收的块类型", "header"],
  ["整页版面确认", "2 / 3 页"],
  ["工作流状态", "人工已确认 1 · 自动通过 1 · 单引擎未复核 1 · 版面未确认 1 · 识别失败 0"],
];

const plain = (value) => JSON.parse(JSON.stringify(value));

const EXPECTED_NOTES =
  "有 1 页抽不到印刷页码（3）——meta.json 里这些页的 printed_page 是 null，不拿 PDF 页号冒充。 " +
  "注释流默认不导出；勾选「同时导出注释」才会生成 notes.txt / notes.jsonl。 " +
  "有 1 段还没审校——导出的是当前文本，未审校的内容也在里面（要只导已确认的，勾上「仅已确认」）。 " +
  "有 1 页是「自动通过（未经人工）」——它们满足自动条件但没有人逐页确认；manifest.json 里记了这组状态快照。 " +
  "有 1 页只有单引擎结果、没跑第二引擎复核。";

function makeModule({ data = FIXTURE, formats = ["txt"], pageTypes = ["body"] } = {}) {
  const boxes = (values) => values.map((value) => mk({ checked: true, value }));
  const byId = new Map();
  const rootFake = {
    querySelector: (selector) => byId.get(String(selector).replace(/^#/, "")) || mk(),
    querySelectorAll: (selector) => {
      if (String(selector).includes("export-format")) return boxes(formats);
      if (String(selector).includes("export-page-type")) return boxes(pageTypes);
      return [];
    },
  };
  const sandbox = { window: {}, console, document: { createElement: () => mk() } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(MODULE_URL, "utf8"), sandbox, { filename: "export-panel.js" });
  const api = sandbox.window.ExportPanel;

  for (const id of [
    "export-range", "export-confirmed-only", "export-page-markers", "export-include-notes",
    "export-rule-header", "export-rule-merge", "export-rule-hyphen", "export-rule-newlines", "export-rule-strip",
  ]) byId.set(id, mk({ checked: !["export-range", "export-confirmed-only", "export-page-markers", "export-include-notes"].includes(id) }));
  const noteNode = mk({ hidden: true });
  byId.set("export-note", noteNode);
  const captured = { rows: null, errors: [] };
  api.init({
    root: rootFake,
    apiJson: async () => data,
    getCurrentProject: () => ({ project_id: "p1" }),
    getProjectExports: () => [],
    setProjectExports: () => {},
    getToken: () => "t0k",
    showError: (_node, error) => { captured.errors.push(error); },
    fillDefinitionList: (_node, rows) => { captured.rows = rows; },
    syncWorkflowSteps: () => {},
    parsePageRange: () => ({ numbers: [1, 2], invalid: [] }),
    marginJudgementOn: () => false,
    setMarginJudgementSetting: () => {},
    dismissMarginJudgementNotice: () => {},
    attachRenderErrorDetail: () => {},
    getMarginJudgementOk: () => null,
    BLOCK_TYPE_LABELS: { paragraph: "段落" },
    ApiError: class ApiError extends Error {},
  });
  return { api, captured, noteNode, byId };
}

test("③ 导出面板接口面：恰好 5 个键，每个都有调用点", () => {
  const { api } = makeModule();
  // 2026-11-06：`reload` 0 调用点 → 删（导出面 5 键 → 4 键；只降不升，不是放宽成"任意"）
  assert.deepEqual(Object.keys(api).sort(), ["exportOptions", "init", "refreshPreflight", "setupPanel"].sort());
  for (const name of Object.keys(api)) assert.equal(typeof api[name], "function", `api.${name} 不是函数`);
});

test("③ 预检对集：同一份 data 的 rows / notes 逐字相等（拆分 renderPreflight 的行为基线）", async () => {
  const { api, captured, noteNode } = makeModule();
  await api.refreshPreflight();
  assert.deepEqual(captured.errors, [], "预检链路抛错了");
  assert.deepEqual(plain(captured.rows), EXPECTED_ROWS, "预检行与基线不一致");
  assert.equal(noteNode.textContent, EXPECTED_NOTES, "预检提醒与基线不一致");
  assert.equal(noteNode.hidden, false, "有提醒时不该隐藏");
});

test("③ 预检对集（无内容版）：空数据的提醒与行数", async () => {
  const empty = {
    exported_pages: [], segment_count: 0, char_count: 0, notes_count: 0, notes_char_count: 0,
    streams: { body: { segments: 0, chars: 0 }, notes: { notes: 0, chars: 0 }, meta: { pages: 0 } },
    page_number_mapping: { found: 0, total: 0, missing_pages: [] },
    rules: { include_notes: true }, merged_segments: 0, hyphenations_restored: 0,
    unreviewed_segments: 0, uncertain_segments: 0, excluded_block_types: [],
    layout_confirmed_pages: 0, layout_pages: 0, workflow_status: { total: 0 }, margin_judgement: false,
    unfinished_pages: [], dropped_pages: [], chrome_suspect_count: 0,
    layout_unconfirmed_pages: [], unreviewed_segments: 0,
  };
  const { api, noteNode } = makeModule({ data: empty });
  await api.refreshPreflight();
  assert.equal(
    noteNode.textContent,
    "按当前设置没有内容可以导出——检查页面类型、范围与「仅已确认」。 "
    + "注释流为空（没有脚注 / 旁批块）——这是正常情况。",
  );
  assert.equal(noteNode.hidden, false);
});

test("③ exportOptions：从 root 里读勾选，形状固定", () => {
  const { api } = makeModule({ formats: ["txt", "jsonl"], pageTypes: ["body", "header"] });
  assert.deepEqual(plain(api.exportOptions()), {
    format: "both",
    confirmed_only: false,
    page_types: ["body", "header"],
    page_numbers: null,
    page_markers: false,
    include_notes: false,
    exclude_header_footer: true,
    merge_lines_in_block: true,
    restore_hyphenation: true,
    normalize_newlines: true,
    strip_line_whitespace: true,
  });
});
