#!/usr/bin/env node
// R12 登记段（闸 A）：只读，**不阻断提交**。
//
// 为什么单独一个入口：§18.6 只有 DevLead 能加行，登记天然是两人的事。放进 pre-commit 会让
// 每次契约变更都要接力，接不上就有人 `--no-verify`——绕过记录比漏检更难查（§18.2 A3 拆两段）。
// 所以登记只在**看得见的地方**红：`scripts/status.sh` 一行读数 + CI 的 `--strict`。
//
// 用法：
//   node tests/js/contract-registry.mjs            # 仪表盘：一行读数，永远 exit 0
//   node tests/js/contract-registry.mjs --strict   # CI：有未登记 → exit 1，并逐条列出
//
// 读数口径（与闸 A 完全同源，不另算一套）：`ring-break-base..HEAD` 里每个 test-contract: /
// move: 提交，是否在 §18.6 有登记行且带「删：/补：/变异：」三样；未登记的删除行合计。
import { evaluateFeatureContract } from "./feature-contract.mjs";

const strict = process.argv.includes("--strict");
const { problems, registryProblems, commitCount } = evaluateFeatureContract();

if (commitCount === 0 && problems.length > 0) {
  // 基点没打 / tag 缺失：这不是"0 笔红灯"，是读不出来——不许用 0 冒充健康
  if (strict) {
    console.error(`✖ R12 登记段读不出来：${problems.join("；")}`);
    process.exit(1);
  }
  console.log(`?（${problems[0]}）`);
  process.exit(0);
}

if (registryProblems.length === 0) {
  console.log(`0 笔（${commitCount} 笔提交的 §18.6 登记齐全）`);
  process.exit(0);
}

if (strict) {
  console.error(`✖ R12 登记段：${registryProblems.length} 条不合格`);
  for (const item of registryProblems) console.error(`  ${item}`);
  process.exit(1);
}

const shas = registryProblems
  .map((item) => (item.match(/\b([0-9a-f]{7})\b/) || [])[1])
  .filter((sha) => Boolean(sha))
  .filter((sha, index, all) => all.indexOf(sha) === index);
console.log(`${registryProblems.length} 条红灯（${shas.length ? shas.join("、") : "见详情"}）——详情 node tests/js/contract-registry.mjs --strict`);
process.exit(0);
