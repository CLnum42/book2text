#!/usr/bin/env node
// 刀 2 落盘后**一次把豁免表改到位**：删清零项、把受阻项推到刀 5、cap 用实测值。
//
// 为什么要脚本：`cap` 只能落盘后量（`r3_pages_count.mjs` 的 `total`），手改必然改两遍，
// 而两遍就会漂成两个数（158 / 164 那次已经吃过一次）。
//
// 用法：
//   node scripts/apply_stage2_table.mjs            # 预演（只打印，不写文件）——默认
//   node scripts/apply_stage2_table.mjs --write    # 真写 pages-r3-exemptions.mjs
//
// 硬断言（任一条不成立 → 全部打印后 exit 1，且**不写文件**）：
//   · 表项数 79 → 65（删 14 项）
//   · Σ cap == total（相等，不是 ≤）
//   · 每个被删的 id：app.js 里引用 == 0
//   · 每个改 stage 的 id：app.js 里引用 > 0（否则该删不该改）
//   · 剩下的项（B + C）引用处数合计 == total（A 贡献 0）
//   · 受阻项条数 == 7 且每条 stage == 5、段号在留外壳清单里查得到
//
// 纪律：只改 `pages-r3-exemptions.mjs`（数据文件），不碰 `boundary.test.mjs`；
//       幂等（连跑两次，第二次报「无事可做」）；失败即停，不"跳过这一项继续"。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TABLE_FILE = `${REPO}/tests/js/pages-r3-exemptions.mjs`;
const COUNT_SCRIPT = `${REPO}/scripts/r3_pages_count.mjs`;
const KEEP_LIST = `${REPO}/docs/refactor/evidence/pages/knife2.5-split-plan.md`;

const WRITE = process.argv.includes("--write");
const EXPECT_ITEMS_BEFORE = 79;
const EXPECT_ITEMS_AFTER = 65;
const EXPECT_BLOCKED = 7;
const EXIT_FAIL = 1;

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);

/** ① 实测：cap 的唯一来源。 */
function measure() {
  const out = execFileSync(process.execPath, [COUNT_SCRIPT, "--json"], { encoding: "utf8" });
  const data = JSON.parse(out);
  const refs = new Map();
  for (const row of data.rows) refs.set(row.id, row.count);
  return { total: data.total, refs, appLines: data.appLines };
}

/** 表：一行一项（`{ id: "x", cap: 1, stage: 2 },`）；保持原文以便只做定点替换。 */
function readTable() {
  const text = readFileSync(TABLE_FILE, "utf8");
  const lines = text.split("\n");
  const entries = [];
  lines.forEach((line, index) => {
    const match = /\{ id: "([^"]+)", cap: (\d+), stage: (\d+|null)([^}]*)\}/.exec(line);
    if (!match) return;
    const blocked = (/(?:"阻塞段"|阻塞段)\s*:\s*"([^"]+)"/.exec(match[4] || "") || [])[1] || "";
    entries.push({
      id: match[1],
      cap: Number(match[2]),
      stage: match[3] === "null" ? null : Number(match[3]),
      blocked,
      index,
    });
  });
  const totalCapLine = lines.findIndex((line) => /export const PAGES_R3_TOTAL_CAP\s*=/.test(line));
  const stageLine = lines.findIndex((line) => /export const PAGES_STAGE\s*=/.test(line));
  return { text, lines, entries, totalCapLine, stageLine };
}

/** 留外壳清单：段号 + 所属装配函数（按函数名归属，行号会漂、函数名不会）。 */
function readKeepList() {
  const segments = [];
  for (const line of readFileSync(KEEP_LIST, "utf8").split("\n")) {
    if (!line.startsWith("| `")) continue;
    const label = (line.split("|")[1] || "").replace(/[`*]/g, "").trim().replace(/\s+/g, " ");
    const match = /^([A-Za-z_$][\w$]*)\s+([\d–\-·\s]+)$/.exec(label);
    if (match) segments.push({ fn: match[1], label });
  }
  return segments;
}

function main() {
  const { total, refs } = measure();
  const { lines, entries, totalCapLine, stageLine } = readTable();
  notes.push(`实测：total = ${total} · 表项 = ${entries.length}`);

  const sums = { before: entries.reduce((sum, item) => sum + item.cap, 0) };
  if (sums.before !== total && entries.length === EXPECT_ITEMS_BEFORE) {
    notes.push(`注意：当前 Σ cap = ${sums.before} ≠ 实测 ${total}（落盘前这是正常的，落盘后必须相等）`);
  }

  // 幂等：已经是落盘后的形态就什么都不做
  const alreadyApplied = entries.length === EXPECT_ITEMS_AFTER
    && entries.every((item) => (refs.get(item.id) || 0) > 0)
    && sums.before === total
    && entries.filter((item) => item.blocked).length === EXPECT_BLOCKED;
  if (alreadyApplied) {
    console.log(`无事可做：表已是落盘后的形态（${EXPECT_ITEMS_AFTER} 项 / Σ cap ${total} / 受阻 ${EXPECT_BLOCKED} 项）`);
    return 0;
  }

  // ② A 组：引用已清零 → 整项删除
  const drop = entries.filter((item) => (refs.get(item.id) || 0) === 0);
  // ③ B 组：还被引用、但到期刀是 2 → 推到 5 + 阻塞段
  const restage = entries.filter((item) => (refs.get(item.id) || 0) > 0 && item.stage === 2);
  const keep = entries.filter((item) => !drop.includes(item) && !restage.includes(item));

  if (drop.length !== 14) {
    fail(`A 组应为 14 项，实测 ${drop.length} 项（引用为 0 的：${drop.map((item) => item.id).join("、") || "无"}）`
      + "——落盘还没完成，或口径变了；不许跳过，先查清楚");
  }
  // B 组口径（2026-10-29 改）：7 项受阻在 ceaebd8 就已是 stage 5，
  // 「仍被引用但 stage 2」= 0 是**目标状态**，不是缺口。该守的是「受阻 7 项且 stage=5 且阻塞段可查」。
  const blockedEntries = entries.filter((item) => item.blocked && item.blocked.length > 0);
  if (restage.length !== 0) {
    fail(`B 组应为 0 项「仍被引用且 stage 2」，实测 ${restage.length} 项`
      + `（${restage.map((item) => item.id).join("、")}）——受阻项应已在上一笔推成 stage 5`);
  }
  if (blockedEntries.length !== EXPECT_BLOCKED) {
    fail(`受阻项应为 ${EXPECT_BLOCKED} 项（带阻塞段且 stage 5），实测 ${blockedEntries.length} 项`
      + `（${blockedEntries.map((item) => item.id).join("、") || "无"}）——停，先查清楚`);
  }
  for (const item of blockedEntries) {
    if (item.stage !== 5) fail(`受阻项 ${item.id} 的 stage 是 ${item.stage}，应为 5`);
  }

  // 每个要删的 id：引用必须真的 0；每个要改的 id：引用必须 > 0
  for (const item of drop) {
    if ((refs.get(item.id) || 0) !== 0) fail(`要删的 ${item.id} 在 app.js 里还有 ${refs.get(item.id)} 处引用——不该删`);
  }
  for (const item of restage) {
    if ((refs.get(item.id) || 0) <= 0) fail(`要改 stage 的 ${item.id} 在 app.js 里 0 处引用——它该删不该改`);
  }

  // 段号：按「持有该 id 引用的函数」在留外壳清单里找；page-more-menu 跨 4 段要写全
  const segments = readKeepList();
  const ownersOf = new Map();
  {
    const out = execFileSync(process.execPath, [COUNT_SCRIPT, "--json"], { encoding: "utf8" });
    for (const row of JSON.parse(out).rows) ownersOf.set(row.id, row.functions || []);
  }
  const blockedFor = new Map();
  for (const item of restage) {
    const owners = new Set(ownersOf.get(item.id) || []);
    const labels = segments.filter((segment) => owners.has(segment.fn)).map((segment) => segment.label);
    if (labels.length === 0) {
      fail(`受阻项 ${item.id} 在留外壳清单里找不到段号（引用者：${[...owners].join("、") || "无"}）`
        + "——没有段号就不许推到期刀");
      continue;
    }
    blockedFor.set(item.id, [...new Set(labels)]);
  }

  // ④ 生成新表
  const byIndex = new Map(entries.map((item) => [item.index, item]));
  const dropSet = new Set(drop.map((item) => item.id));
  const restageSet = new Set(restage.map((item) => item.id));
  const nextLines = [];
  lines.forEach((line, index) => {
    const item = byIndex.get(index);
    if (item && dropSet.has(item.id)) return;          // ② 整项删除
    if (item && restageSet.has(item.id)) {             // ③ 推 stage + 写阻塞段
      const reason = (blockedFor.get(item.id) || []).join("、");
      const capped = Math.min(item.cap, refs.get(item.id) || 0);
      nextLines.push(`  { id: "${item.id}", cap: ${capped}, stage: 5, 阻塞段: "${reason}" },`);
      return;
    }
    if (item) {                                        // ④ 逐 id 收紧：cap = min(cap, 实测 occ)
      const capped = Math.min(item.cap, refs.get(item.id) || 0);
      if (capped !== item.cap) {
        nextLines.push(line.replace(/cap: \d+/, `cap: ${capped}`));
        return;
      }
    }
    nextLines.push(line);
  });
  if (totalCapLine >= 0) nextLines[totalCapLine] = `export const PAGES_R3_TOTAL_CAP = ${total};`;
  if (stageLine >= 0) nextLines[stageLine] = "export const PAGES_STAGE = 2;";

  // 硬断言（在生成的文本上重算一遍，不信上面的中间结果）
  const after = [];
  nextLines.forEach((line) => {
    const match = /\{ id: "([^"]+)", cap: (\d+), stage: (\d+|null)([^}]*)\}/.exec(line);
    if (!match) return;
    const blocked = (/(?:"阻塞段"|阻塞段)\s*:\s*"([^"]+)"/.exec(match[4] || "") || [])[1] || "";
    after.push({ id: match[1], cap: Number(match[2]), stage: match[3] === "null" ? null : Number(match[3]), blocked });
  });
  if (after.length !== EXPECT_ITEMS_AFTER) {
    fail(`表项数应为 ${EXPECT_ITEMS_AFTER}，生成结果 ${after.length}——79 → 65 是这条的判据`);
  }
  const afterSum = after.reduce((sum, item) => sum + item.cap, 0);
  if (afterSum !== total) {
    fail(`Σ cap 应等于实测 ${total}，生成结果 ${afterSum}——落盘后没有比实测更宽的理由（不许 ≤）`);
  }
  for (const item of after) {
    const count = refs.get(item.id) || 0;
    if (count === 0) fail(`生成的表里还有 0 引用的 ${item.id}——该删的没删`);
    if (item.blocked && item.stage !== 5) fail(`受阻项 ${item.id} 的 stage 不是 5`);
    if (item.blocked) {
      for (const label of item.blocked.split(/[、,，]/).map((one) => one.trim()).filter(Boolean)) {
        if (!segments.some((segment) => segment.label === label)) {
          fail(`受阻项 ${item.id} 的段号「${label}」不在留外壳清单里`);
        }
      }
    }
  }
  const blockedCount = after.filter((item) => item.blocked).length;
  if (blockedCount !== EXPECT_BLOCKED) fail(`受阻项应为 ${EXPECT_BLOCKED} 项，生成结果 ${blockedCount} 项`);
  const keptRefs = after.reduce((sum, item) => sum + (refs.get(item.id) || 0), 0);
  if (keptRefs !== total) {
    fail(`A+B 的引用处数 + C 的处数应为 total ${total}，实测 ${keptRefs}——分桶没盖满`);
  }

  console.log(`预演：删 ${drop.length} 项（${drop.map((item) => item.id).join("、") || "无"}）`);
  console.log(`     推 stage 2 → 5：${restage.length} 项`);
  for (const item of restage) console.log(`       ${item.id} ← ${(blockedFor.get(item.id) || []).join("、") || "（缺段号）"}`);
  console.log(`     PAGES_R3_TOTAL_CAP = ${total} · PAGES_STAGE = 2 · 表项 ${entries.length} → ${after.length}`);
  for (const note of notes) console.log(`     ${note}`);

  if (problems.length > 0) {
    console.error(`\n[1] 断言失败 ${problems.length} 条（不写文件）：`);
    for (const message of problems) console.error(`    ✗ ${message}`);
    return EXIT_FAIL;
  }
  if (!WRITE) {
    console.log("\n[0] 预演通过（未写文件）。落盘后加 --write 执行。");
    return 0;
  }
  writeFileSync(TABLE_FILE, nextLines.join("\n"), "utf8");
  console.log("\n[0] 已写入 pages-r3-exemptions.mjs");
  return 0;
}

process.exit(main());
