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

// 当前刀**不再手写**（2026-10-30）：判据内部按 `max(登记表 landed, git 最大刀号)` 现算，
// 见 `tests/js/knife-registry.mjs` 的 `stageNow` / `stageSourceProblems`。
// 手工常数曾经停了三刀（`PAGES_STAGE=2` 让「到期不搬」空转），所以这个数字被删掉了。
// **总上限必须等于下面逐项 cap 之和**（2026-10-30 起的机检，见 boundary.test.mjs 的 R3 段）：
// 总上限比之和大的那部分，任何一项都认领不到 → 实际合计永远撞不到它 → 「合计上限」这条判据在空转。
// 156 → 155：账本笔删掉了 `selection-recognize`（按钮已删，cap 1），总数没跟着下调，这里补上。
export const PAGES_R3_TOTAL_CAP = 50;
export const PAGES_R3_PENDING = 0;
export const PAGES_R3_BLOCKED_MAX = 7;

//: stage = null 表示「待定（按搬它的刀）」；本期已归零。
export const PAGES_R3_EXEMPTIONS = [
  { id: "page-more-menu", cap: 4, stage: 6, 阻塞段: "setupLibrary 12669–12672、setupLibrary 12673–12676、setupLibrary 12680–12683、setupLibrary 12688–12692" },
  { id: "apply-high-suggestions", cap: 1, stage: 6, 阻塞段: "setupLibrary 12613" },
  { id: "aux-rerun", cap: 1, stage: 6, 阻塞段: "setupLibrary 12680–12683" },
  { id: "backups-open", cap: 1, stage: 6, 阻塞段: "setupLibrary 12673–12676" },
  { id: "selection-review-open", cap: 1, stage: 6, 阻塞段: "setupShell 1274–1278" },
  { id: "stats-open", cap: 1, stage: 6, 阻塞段: "setupShell 1261–1264" },
  { id: "word-boxes-open", cap: 1, stage: 6, 阻塞段: "setupLibrary 12669–12672" },
  { id: "layout-detect-open", cap: 1, stage: 6 },
  { id: "assign-list-toggle", cap: 3, stage: 8 },
  { id: "assign-open", cap: 3, stage: 8 },
  { id: "check-pending", cap: 2, stage: 8 },
  { id: "selection-check", cap: 2, stage: 8 },
  { id: "page-setup-bar", cap: 2, stage: 8 },
  { id: "panel-pagenum-settings", cap: 2, stage: 8 },
  { id: "panel-recognition-settings", cap: 2, stage: 8 },
  { id: "selection-actionbar", cap: 2, stage: 8 },
  { id: "pages-error", cap: 5, stage: 7 },
  { id: "pages-margin-toggle", cap: 4, stage: 6 },
  { id: "pages-overlay-toggle", cap: 4, stage: 6 },
  { id: "setup-panel", cap: 2, stage: 8 },
  { id: "selection-hint", cap: 1, stage: 8 },
  { id: "auto-apply-suggestions", cap: 1, stage: 8 },
  { id: "rec-margin-judgement", cap: 2, stage: 8 },
  { id: "selection-skip-checked", cap: 2, stage: 8 },
];
