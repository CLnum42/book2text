// `view-pages` 的 R3 过渡豁免表 —— **数据，不是逻辑**（一行一个 id → { 上限处数, 到期刀 }）。
//
// caps：`node scripts/r3_pages_count.mjs` 在落盘后的稳定树（app.js 14,387）实测，79 项 / 193 处；
// 预估 186 只用于对差（实测 − 预估 = +7 = 7 处 querySelector 取法；el-only 口径下两边一致）。
//
// 到期刀 = 引用该 id 的**所有**函数在 `stage2-movers-seed.md` 里的**最大刀号**：
// 「最后一个引用它的函数搬走」才算真的清掉（min 只是「开始变」，会给出做不到的截止日）。
// 闸里有两条独立自检：① 每项到期刀 == 现算 max；② seed 的 69 个函数 == 表里 id 的 functions 并集
// （后者挡「换了 seed 但表没重算」——那种漂不会红，只会让整张表偏早或偏晚）。
//
// 待定项数 = 0（刀 2 起待定即红；待定数只降不升）。
// **文档真空（谁都没写，先记在这）**：`semantic-ops.md` 把装配点列成「不进模块」，
// 但装配点里对 view-pages 的 DOM 接线不搬进 `init`，这些 id 就永远到不了期——
// 两张文档之间的这条缝，是这张表存在的理由。

//: 当前落盘到第几刀——每刀落盘时改这一个数，到期判据随之生效。
export const PAGES_STAGE = 2;
export const PAGES_R3_TOTAL_CAP = 156;
export const PAGES_R3_PENDING = 0;
export const PAGES_R3_BLOCKED_MAX = 7;

//: stage = null 表示「待定（按搬它的刀）」；本期已归零。
export const PAGES_R3_EXEMPTIONS = [
  { id: "page-more-menu", cap: 4, stage: 5, 阻塞段: "setupLibrary 12669–12672、setupLibrary 12673–12676、setupLibrary 12680–12683、setupLibrary 12688–12692" },
  { id: "apply-high-suggestions", cap: 1, stage: 5, 阻塞段: "setupLibrary 12613" },
  { id: "aux-rerun", cap: 1, stage: 5, 阻塞段: "setupLibrary 12680–12683" },
  { id: "backups-open", cap: 1, stage: 5, 阻塞段: "setupLibrary 12673–12676" },
  { id: "selection-review-open", cap: 1, stage: 5, 阻塞段: "setupShell 1274–1278" },
  { id: "stats-open", cap: 1, stage: 5, 阻塞段: "setupShell 1261–1264" },
  { id: "word-boxes-open", cap: 1, stage: 5, 阻塞段: "setupLibrary 12669–12672" },
  { id: "rec-dual-strategy", cap: 3, stage: 3 },
  { id: "rec-engine", cap: 2, stage: 3 },
  { id: "layout-detect-open", cap: 2, stage: 3 },
  { id: "margin-confirm-all", cap: 1, stage: 3 },
  { id: "page-number-review-open", cap: 1, stage: 3 },
  { id: "page-number-summary", cap: 2, stage: 3 },
  { id: "rec-language", cap: 1, stage: 3 },
  { id: "auto-apply-status", cap: 1, stage: 3 },
  { id: "margin-confidence", cap: 1, stage: 3 },
  { id: "margin-detect-hint", cap: 1, stage: 3 },
  { id: "margin-verdict-line", cap: 1, stage: 3 },
  { id: "margin-verdict-state", cap: 1, stage: 3 },
  { id: "page-number-metrics", cap: 1, stage: 3 },
  { id: "page-summary", cap: 1, stage: 3 },
  { id: "rec-aux-num", cap: 1, stage: 3 },
  { id: "rec-engine-note", cap: 1, stage: 3 },
  { id: "rec-language-summary", cap: 1, stage: 3 },
  { id: "rec-strategy-label", cap: 1, stage: 3 },
  { id: "rec-strategy-note", cap: 1, stage: 3 },
  { id: "rec-summary", cap: 1, stage: 3 },
  { id: "rec-verdict-line", cap: 1, stage: 3 },
  { id: "assign-list-toggle", cap: 3, stage: 4 },
  { id: "assign-open", cap: 3, stage: 4 },
  { id: "check-pending", cap: 2, stage: 4 },
  { id: "selection-check", cap: 2, stage: 4 },
  { id: "layout-block-confirm", cap: 1, stage: 4 },
  { id: "page-range", cap: 1, stage: 4 },
  { id: "page-setup-bar", cap: 2, stage: 4 },
  { id: "pages-zoom-in", cap: 1, stage: 4 },
  { id: "pages-zoom-out", cap: 1, stage: 4 },
  { id: "panel-pagenum-settings", cap: 2, stage: 4 },
  { id: "panel-recognition-settings", cap: 2, stage: 4 },
  { id: "selection-actionbar", cap: 2, stage: 4 },
  { id: "selection-recognize", cap: 1, stage: 4 },
  { id: "pages-zoom-label", cap: 1, stage: 4 },
  { id: "selection-skip-recognized", cap: 1, stage: 4 },
  { id: "pages-error", cap: 26, stage: 5 },
  { id: "page-grid", cap: 14, stage: 5 },
  { id: "pages-margin-toggle", cap: 8, stage: 5 },
  { id: "pages-overlay-toggle", cap: 7, stage: 5 },
  { id: "margin-fit-progress", cap: 5, stage: 5 },
  { id: "setup-panel", cap: 5, stage: 5 },
  { id: "selection-hint", cap: 4, stage: 5 },
  { id: "auto-apply-suggestions", cap: 2, stage: 5 },
  { id: "filter-workflow", cap: 2, stage: 5 },
  { id: "margin-fit-fill", cap: 3, stage: 5 },
  { id: "margin-fit-text", cap: 3, stage: 5 },
  { id: "rec-margin-judgement", cap: 2, stage: 5 },
  { id: "rec-status", cap: 3, stage: 5 },
  { id: "selection-skip-checked", cap: 3, stage: 5 },
  { id: "filter-recognition", cap: 1, stage: 5 },
  { id: "filter-triage", cap: 1, stage: 5 },
  { id: "filter-type", cap: 1, stage: 5 },
  { id: "pages-only-included", cap: 1, stage: 5 },
  { id: "margin-audit", cap: 1, stage: 5 },
  { id: "margin-basis", cap: 1, stage: 5 },
  { id: "margin-status", cap: 1, stage: 5 },
  { id: "page-number-status", cap: 1, stage: 5 },
];
