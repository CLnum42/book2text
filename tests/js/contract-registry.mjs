#!/usr/bin/env node
// R12 登记段（闸 A）：只读，**不阻断提交**。
//
// 为什么单独一个入口：§18.6 只有 DevLead 能加行，登记天然是两人的事。放进 pre-commit 会让
// 每次契约变更都要接力，接不上就有人 `--no-verify`——绕过记录比漏检更难查（§18.2 A3 拆两段）。
// 所以登记只在**看得见的地方**红：`scripts/status.sh` 一行读数 + CI 的 `--strict`。
//
// 用法：
//   node tests/js/contract-registry.mjs                  # 仪表盘：一行读数，永远 exit 0
//   node tests/js/contract-registry.mjs --strict         # CI：有未登记 / base 不是回放基 → exit 1
//   node tests/js/contract-registry.mjs --base HEAD      # 换基点（自检 / 变异用）
//   node tests/js/contract-registry.mjs --strict --allow-transitional-base
//                                                        # 过渡期：base 不是回放基时只警告，仍查登记
//   node tests/js/contract-registry.mjs --strict --base <sha> --doc /tmp/x.md
//                                                        # 变异验证：真实提交 + 改坏的登记表副本
//
// 读数口径（与闸 A 完全同源，不另算一套）：`<base>..HEAD` 里每个 test-contract: / move: 提交，
// 是否在 §18.6 有登记行且带「删：/补：/变异：」三样；未登记的删除行合计。
//
// **base 不是回放基时不报「登记齐全」**（DevLead 2026-10-29）：`ring-break-base` 现在指向 L0
// （static 下只有 reading-view.js），拿它的 `base..HEAD`（173 笔）当结论会把「这段历史没有
// 未登记的 test-contract」说成「登记齐全」。所以那种情况下输出前缀是「过渡范围」，`--strict` 默认红。
import { baseTreeGap, evaluateFeatureContract } from "./feature-contract.mjs";

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const allowTransitional = argv.includes("--allow-transitional-base");
const baseIndex = argv.indexOf("--base");
const baseTag = baseIndex === -1 ? "ring-break-base" : argv[baseIndex + 1];
if (baseIndex !== -1 && !baseTag) {
  console.error("✖ --base 缺值");
  process.exit(2);
}
// --doc：喂 /tmp 里的登记表副本（变异验证用：真实提交 + 改坏的登记表），不碰仓库文档。
const docIndex = argv.indexOf("--doc");
const docPath = docIndex === -1 ? null : argv[docIndex + 1];
if (docIndex !== -1 && !docPath) {
  console.error("✖ --doc 缺值");
  process.exit(2);
}

const gap = baseTreeGap({ baseTag });
const { problems, registryProblems, commitCount } = evaluateFeatureContract({ baseTag, docPath });

const shasOf = (items) => items
  .map((item) => (item.match(/\b([0-9a-f]{7})\b/) || [])[1])
  .filter((sha) => Boolean(sha))
  .filter((sha, index, all) => all.indexOf(sha) === index);
const registryLine = registryProblems.length === 0
  ? "0 条登记不合格"
  : `${registryProblems.length} 条登记不合格（${shasOf(registryProblems).join("、") || "见 --strict"}）`;

// ① base 不是回放基：数字只能当「过渡范围」，不能当「登记齐全」的结论
if (gap) {
  const line = `✖ ${gap}；过渡范围 ${baseTag}..HEAD（${commitCount} 笔）：${registryLine}——不许当「登记齐全」用`;
  if (strict && !allowTransitional) {
    console.error(line);
    for (const item of registryProblems) console.error(`  ${item}`);
    console.error("  过渡期确实要放行：加 --allow-transitional-base（会写明是过渡读数）");
    process.exit(1);
  }
  console.log(`${line}${allowTransitional ? "（按 --allow-transitional-base 放行）" : ""}`);
  process.exit(0);
}

// ② base 合格：正常读数
if (commitCount === 0 && problems.length > 0) {
  // 读不出来 ≠ 0 笔红灯——不许用 0 冒充健康
  if (strict) {
    console.error(`✖ R12 登记段读不出来：${problems.join("；")}`);
    process.exit(1);
  }
  console.log(`?（${problems[0]}）`);
  process.exit(0);
}

if (registryProblems.length === 0) {
  console.log(`0 笔不合格（${baseTag}..HEAD（${commitCount} 笔）登记齐全）`);
  process.exit(0);
}

if (strict) {
  console.error(`✖ R12 登记段：${registryProblems.length} 条不合格`);
  for (const item of registryProblems) console.error(`  ${item}`);
  process.exit(1);
}
console.log(`${registryProblems.length} 条红灯（${shasOf(registryProblems).join("、") || "见详情"}）——详情 node tests/js/contract-registry.mjs --strict`);
process.exit(0);
