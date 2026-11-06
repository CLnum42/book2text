// 闸 A：特征测试契约（§18.2）的**静态**部分 —— A1 / A1b / A3。
//
// A2（回放）与 A4（变异红两遍）是运行期检查，形态是 `tests/js/mutation-check.mjs`
// （同一份测试在 base worktree 上先绿、再插变异必须红）。这里不重复造。
//
// 判据（对象 = 被测 SHA 的 git 序列 `ring-break-base..HEAD`）：
// - **A1**：任何一笔碰了产品代码（`backend/book2text/static/`）的提交，不得碰 `tests/js/`（新增也算）。
// - **A1b**：序列合计 `git diff --numstat base..HEAD -- tests/js` 删除行 = 0、删除文件 = 0。
// - **A3**：改了 `tests/js` 旧断言（有删除行）的提交必须：首行 `test-contract:`、不含产品代码、
//   且 sha 登记在 docs/refactor/reading-view-boundary.md §18.6。
// - **对象边界**：`tests/js/**/*.md` 是文档（README 记机检覆盖率），不参与 A1/A1b/A3；
//   `*.mjs` 与数据夹具照判。理由见 §18.6 那一行：改一行读数不该被要求写「删/补/变异」，
//   否则登记表会被文档编辑灌满，下一个人就不再信它。
//
// 为什么这样：A1 挡「切边顺手改测试」，A1b 挡「分散到多笔里偷偷改」，A3 挡「改判据不登记」。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripCommentsAndStrings } from "./static-scan.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOC_REL = "docs/refactor/reading-view-boundary.md";
/** 打 tag 时刻的 *-view.js 冻结记录（切 ring-break-base 时同批更新，见 §18.3）。 */
const REPLAY_BASE_RECORD = "tests/js/replay-base-modules.txt";

/**
 * 「算契约对象」的 `tests/js` 路径集合（给 git pathspec 用）：可执行断言 + 数据夹具，
 * **排除 `*.md`**。git pathspec 里的 `*` 会跨 `/` 匹配，所以 `tests/js/*.md` 覆盖任意层级的文档。
 */
const CONTRACT_SCOPE = ["tests/js/", ":(exclude)tests/js/*.md"];

/** 单个文件是否算契约对象（纯函数，自检与内核共用；`files` 来自 `git show --name-only`）。 */
export function isContractPath(file) {
  return typeof file === "string" && file.startsWith("tests/js/") && !/\.md$/i.test(file);
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/**
 * cherry-pick 换 sha 之后，这笔补丁在 `git cherry-pick -x` 正文里留下的**原 sha**。
 *
 * 为什么要认它（2026-11-03，Chief 裁定）：§18.6 登记行只认集成后的 sha，而 cherry-pick
 * 一换 sha 登记就当场过期 —— 今天为此重签了两次（`32917c0` / `a0bba4a`），每次多一个来回。
 * 原 sha 与集成后的 sha 是**同一个补丁的两个名字**，所以登记行两种值都接受。
 *
 * 口径收得很窄：只有提交正文里带 cherry-pick 落款时才产生别名，**不是「正文里出现任何 sha」**——
 * 否则随手抄一个 sha 就能把未登记混过闸（那正是这条判据要防的形态）。
 * 返回数组（同一笔被多次 cherry-pick 时会有多个原 sha）。
 */
export function cherryPickOriginShas(message) {
  if (typeof message !== "string") return [];
  const out = [];
  for (const match of message.matchAll(/cherry picked from commit ([0-9a-f]{7,40})\b/gi)) {
    if (!out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

/** 一行的「提交」格是否指向这笔提交：集成后的 sha 或它的 cherry-pick 原 sha（短或长）都算。 */
function rowNamesCommit(row, shas) {
  return shas.some((value) => Boolean(value) && (row.includes(value.slice(0, 7)) || row.includes(value)));
}

/** §18.6 登记表里是否出现过这个 sha（短或长都认；cherry-pick 原 sha 也算）。 */
function registeredIn1886(sha, docText, aliases = []) {
  const table = docText.slice(docText.indexOf("### 18.6"));
  return rowNamesCommit(table, [sha, ...aliases]);
}

/**
 * 登记行的**批准人**（§18.6 第五列）。按表头定位列，不写死列号——表宽变了不会静默错位。
 * 返回 null = 找不到该 sha 的登记行 / 表头没有「批准人」列。
 */
export function registrationApprover(sha, docText, aliases = []) {
  const table = docText.slice(docText.indexOf("### 18.6"));
  const rows = table.split("\n").filter((line) => line.trimStart().startsWith("|"));
  // 表头必须**整格**等于「批准人」：§18.6 上面还有个判据小表，里面也出现「批准人」字样，
  // 用 includes 会选中那张表（列号 -1 → 静默 null → 自己批自己永远绿）。
  const header = rows.find((line) => line.split("|").map((cell) => cell.trim()).includes("批准人"));
  if (!header) return null;
  const column = header.split("|").map((cell) => cell.trim()).indexOf("批准人");
  if (column < 0) return null;
  const row = rows.find((line) => rowNamesCommit(line, [sha, ...aliases]));
  if (!row) return null;
  const cell = row.split("|")[column];
  return cell === undefined ? null : cell.trim();
}

/**
 * §18.6「批准人 ∈ 授权签署人」：**DevLead / Chief**（2026-11-03 加 Chief）。
 * 为什么需要它：本仓库所有 Bot 共用一个提交账号（`CLnum42`），所以「批准人 ≠ %an」只能拦
 * "照抄作者字符串"；真实出事形态是 `Builder | aac4568`——干活的人给自己签字，那条规则判绿。
 *
 * 为什么加 Chief（Chief 2026-11-03 裁定）：登记原来只认 DevLead 一个人，所有 test-contract
 * 登记都串行等同一个人的回合并签名，每笔多一个来回。Chief 是**集成方**——每笔进 main 前都在
 * 他手里过一遍，他做第二双眼睛是有意义的分离，不是同一个人的两个签名。
 *
 * **不变的那条铁律：作者不能签自己那笔**（见下面 `commitContractProblems` 的 trailer 分支
 * 与 `registrationGap` 的「批准人 == 作者」判定）。它才是防作弊的关键；授权名单加人不动它。
 */
export const AUTHORIZED_SIGNERS = ["DevLead", "Chief"];

/** 签名人不在授权名单 → 一句人话；否则 null。 */
function unauthorizedSigner(sha, signer) {
  if (!signer || AUTHORIZED_SIGNERS.includes(signer)) return null;
  return `A3: ${sha.slice(0, 7)} 的签名人「${signer}」不在授权名单`
    + `（${AUTHORIZED_SIGNERS.join(" / ")}）——干活的人不能给自己签字`;
}

/**
 * `Approved-by:` trailer（§18.6 2026-10-29「签名走 trailer」）。
 * 容忍 `Approved-by: DevLead` 与 `Approved-by:DevLead` 两种写法；返回 null = 没有这个 trailer。
 */
export function approvedByTrailer(message) {
  if (typeof message !== "string") return null;
  const match = /^[ \t]*Approved-by[ \t]*:[ \t]*(\S.*?)[ \t]*$/im.exec(message);
  return match ? match[1].trim() : null;
}

/** 提交作者（显示名原样返回：可能含空格/中文，所以整串比，不切字段）。 */
export function commitAuthor(sha) {
  try {
    return git(["log", "-1", "--format=%an", sha]);
  } catch {
    return null;
  }
}

/**
 * 登记行的**内容**要求（Chief 2026-10-29）：光有 sha 不算登记，必须写清三样——
 * `删：…`（删了哪些断言）、`补：…`（换成了什么更严的）、`变异：…`（各改坏一次，红在哪）。
 * 理由：「删了几行」是替代指标，「改完还会不会咬人」才是根因。
 */
export function registrationContent(sha, docText, aliases = []) {
  const table = docText.slice(docText.indexOf("### 18.6"));
  const row = table
    .split("\n")
    .find((line) => line.trimStart().startsWith("|") && rowNamesCommit(line, [sha, ...aliases]));
  if (!row) return null;
  return {
    row,
    deleted: /删[:：]\s*[^\s|—-]/.test(row),
    stricter: /补[:：]\s*[^\s|—-]/.test(row),
    mutation: /变异[:：]\s*[^\s|—-]/.test(row),
  };
}

/**
 * **`move:` 笔类（Chief 2026-10-29）**：搬运一个视图时，产品代码与登记表必须同批改，
 * 否则 A1 / A1b / A3 互相锁死（只落模块 → R5/R8 红；只改表 → R8 红；合成一笔 → A1 红）。
 *
 * 放行的判据不是"碰了哪张表"，而是"这笔改动是**必需的**"：
 * - 首行 `move(<视图>): …`；
 * - **必须同时**含 `backend/book2text/static/` 与 `tests/js/` 改动（空声明的 `move:` 是伪装）；
 * - `tests/js` 的**全部**变更行（增与删）必须落在四张登记表块内：
 *   `OWNERS` / `VIEW_STATE_PREFIXES` / `VIEW_EXPORTS` / `KNIVES`；
 *   `KNIVES`（`tests/js/knife-registry.mjs` 的刀号登记表）也算登记表：`move:` 笔要靠它把本刀的
 *   `pending` 改成 `landed`，这是正常动作。**放宽到 KNIVES 不等于放行整个文件**——KNIVES 块外
 *   仍红。而且方向有另一道闸卡着：`registryMax − gitMax ∈ {0,1}`（见 `stageSourceProblems`），
 *   一笔 move: 顺手把刀 10 也标 landed 就是 delta ≥ 2 → 红。**A1 只管位置，delta 管方向**；
 * - 块边界**从源码派生**（`const NAME = {` → 配对 `};`），**不手写行号**——
 *   手工行号正是"会漂的副本"，任何一次插入就失效；
 * - 找不到块 → **红（fail closed）**，不许"解析不了就放行"；越界 → 红并打印 `文件:行`；
 * - **豁免表与上限一律不放行**（顶层 `const` 名字带 `EXCUS` 或 `MAX`）：那是削弱闸的旋钮，
 *   和"登记某个模块叫什么"是两回事。
 */
const MOVE_TABLES = ["OWNERS", "VIEW_STATE_PREFIXES", "VIEW_EXPORTS", "KNIVES"];
/** 豁免表文件里**允许被 move: 笔改**的顶层常量（方向由 exemptionDeltaProblems 判，A1 只管位置）。 */
export const MOVE_EXEMPTION_BLOCKS = [
  "PAGES_R3_EXEMPTIONS", "PAGES_R3_TOTAL_CAP", "PAGES_R3_PENDING", "PAGES_R3_BLOCKED_MAX",
];

/**
 * **已退役的登记块**：这些名字曾经是豁免表里的合法块，后来被现算取代（`PAGES_STAGE` 2026-10-30
 * 被 `stageNow()` 取代）。历史提交动过它们，**不能因此翻旧账**——A1 只判「有没有越过登记表」，
 * 不判「这个块还在不在」。但它们**不许再回到文件里**（见 boundary 的墓碑自检）。
 */
export const MOVE_EXEMPTION_BLOCKS_RETIRED = ["PAGES_STAGE"];
const MOVE_FORBIDDEN = /(EXCUS|MAX)/;
/** pages 的 R3 过渡豁免表（数据文件）。`move:` 笔**可以**改它，但只能往收紧的方向改。 */
const EXEMPTION_FILE = "pages-r3-exemptions.mjs";
const KEEP_LIST_REL = "docs/refactor/evidence/pages/knife2.5-split-plan.md";

/** 从豁免表源码里读 `{ id, cap, stage, 阻塞段? }`（一格一条，逐行匹配，不吃注释格式变化）。 */
export function parseExemptionEntries(source) {
  const entries = new Map();
  for (const match of String(source || "").matchAll(
    /\{\s*id:\s*"([^"]+)",\s*cap:\s*(\d+),\s*stage:\s*(\d+|null)([^}]*)\}/g,
  )) {
    const extra = match[4] || "";
    const blocked = (/(?:"阻塞段"|阻塞段)\s*:\s*"([^"]+)"/.exec(extra) || [])[1] || "";
    entries.set(match[1], {
      cap: Number(match[2]),
      stage: match[3] === "null" ? null : Number(match[3]),
      blocked,
    });
  }
  return entries;
}

/**
 * **`Move-Gate` 不是权限，是声明。**
 *
 * 它只做一件事：让一笔「产品 + tests/js + docs」的搬运提交**把改动范围写在提交信息里**，
 * 于是范围可以被机检。真正的守卫永远是**方向判据**（`exemptionDeltaProblems` 只许收紧）——
 * 声明本身不给任何豁免权：白名单外的路径一律红，方向不对一律红。
 *
 * 为什么需要它：搬运笔天然是「拆开哪一脚都红」的形态（app.js 单提 → seed 缺名红；
 * seed 单提 → 索引里没有新函数红；表单提 → 到期刀对不上红）。**只有一笔能过，而它必须被审。**
 * 这条口子只属于搬迁笔：首行 `test-contract:` 的提交**不认** `Move-Gate`。
 */
export const MOVE_GATE_WHITELIST = [
  "tests/js/boundary.test.mjs",
  "tests/js/feature-contract.mjs",
  "tests/js/pages-r3-exemptions.mjs",
  // 刀号登记表是**数据**不是判据代码：落盘那一刀要把它从 pending 改成 landed，
  // 这是 move: 笔的正常动作；不登记的话会撞「偷改判据」（白名单外）或被迫不声明（「偷改」）。
  "tests/js/knife-registry.mjs",
];

/** 从提交信息里读 `Move-Gate: a, b, c`；没有这行 → null（不是 Move-Gate 笔）。 */
export function moveGateDeclaration(message) {
  const match = /^[ \t]*Move-Gate[ \t]*:[ \t]*(.+)$/im.exec(String(message || ""));
  if (!match) return null;
  return match[1].split(/[,，]/).map((one) => one.trim()).filter(Boolean);
}

/**
 * Move-Gate 的四条机检（②「本笔后全套绿」由 pre-commit 的整套 node 闸承担——
 * 它在**索引树**上跑，正是"本笔后"那棵树；这里不假装能自己跑自己）。
 *
 * ```
 * ① 方向判据全过      —— 由调用方把 exemptionDeltaProblems 的结果传进来（没传就是没验）
 * ② 本笔后全套绿      —— pre-commit 承担（见上）
 * ③ 声明 ⊆ 实际改动   —— 声明了却没改 = 空声明（伪装）
 * ④ 改动 ⊆ 声明        —— 改了 tests/js 却没声明 = 偷改判据
 * ```
 */
export function moveGateProblems({ subject, message, files, directionProblems = [], directionChecked = false, exemptionTouched = false }) {
  const declared = moveGateDeclaration(message);
  if (declared === null) return [];
  const problems = [];
  const short = subject || "";
  if (short.startsWith("test-contract:")) {
    problems.push("Move-Gate 只属于搬迁笔：首行 test-contract: 的提交不认 Move-Gate——请单开 move: 笔");
  }
  const outside = declared.filter((path) => !MOVE_GATE_WHITELIST.includes(path));
  if (outside.length > 0) {
    problems.push(
      `Move-Gate 声明了白名单外的路径：${outside.join("、")}——白名单只有 `
      + `${MOVE_GATE_WHITELIST.join(" / ")}；写产品路径进来就能把 A1 绕掉`,
    );
  }
  const changed = new Set(files || []);
  const declaredButUnchanged = declared.filter((path) => !changed.has(path));
  if (declaredButUnchanged.length > 0) {
    problems.push(
      `Move-Gate 声明了 ${declaredButUnchanged.join("、")}，但本笔没改它——空声明是伪装`,
    );
  }
  const changedUndeclared = [...changed].filter((path) => isContractPath(path) && !declared.includes(path));
  if (changedUndeclared.length > 0) {
    problems.push(
      `本笔改了 tests/js 的 ${changedUndeclared.join("、")}，但没在 Move-Gate 里声明——偷改判据`,
    );
  }
  // 只有碰了豁免表才需要方向判据；碰了却没结果 = 没验（没验就是没验，不许默认通过）
  if (exemptionTouched && !directionChecked) {
    problems.push("Move-Gate ①：本笔碰了豁免表但方向判据没跑——没验就是没验");
  }
  problems.push(...directionProblems);
  return problems;
}

/** 留外壳清单的段号标签（`setupLibrary 12548–12557`），供「阻塞段」查得到。 */
export function keepShellSegmentLabels(text = null) {
  const source = text === null ? (() => {
    try {
      return readFileSync(`${REPO_ROOT}/${KEEP_LIST_REL}`, "utf8");
    } catch {
      return "";
    }
  })() : text;
  const labels = new Set();
  for (const line of source.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const label = (line.split("|")[1] || "").replace(/[`*]/g, "").trim().replace(/\s+/g, " ");
    if (/^[A-Za-z_$][\w$]*\s+[\d–\-·\s]+$/.test(label)) labels.add(label);
  }
  return labels;
}

/**
 * `move:` 笔对**豁免表**的放行判定：允许收紧、禁止放宽。
 *
 * 对象是「旧树 vs 新树的两份豁免表」，不是行号——行号会漂，内容不会。
 * ```
 * ① cap 不增：**按 stage 分组**比合计（总 cap 不增但某组暴增 = 在某个到期点上挖洞）
 * ② 表项数不增：按 id 集合，新增红、删除合法
 * ③ stage 只许往后推，被推迟项必须带 `阻塞段: <段号>`，且段号能在留外壳清单里查到
 * ```
 * ④ 生效范围：只由 `move:` 分支调用；`test-contract:` 仍按原 A1，不放宽。
 */
export function exemptionDeltaProblems({ sha, oldSource, newSource, keepListText = null }) {
  const short = String(sha).slice(0, 7);
  const problems = [];
  const before = parseExemptionEntries(oldSource);
  const after = parseExemptionEntries(newSource);
  if (before.size === 0 && after.size === 0) return problems;   // 这个文件里没有豁免表（例如别的数据文件）

  // ① cap 只许收紧。两条都要：
  //   a) **全表合计**不增；
  //   b) **留在原 stage 的项**按 stage 分组不增。
  //      注意不能拿「各 stage 分组原始合计」直接比：合法的「2 → 5 推迟」会把 cap 从 stage2 组
  //      挪进 stage5 组，stage5 必然变大——那不是挖洞，是移动。分组只比"没动 stage 的项"，
  //      "移动"由 ③（必须带可查的阻塞段）单独管。
  const stageKey = (stage) => (stage === null ? "null" : String(stage));
  const totalOf = (map) => [...map.values()].reduce((sum, entry) => sum + entry.cap, 0);
  const oldTotal = totalOf(before);
  const newTotal = totalOf(after);
  if (newTotal > oldTotal) {
    problems.push(
      `cap 合计（全表）: ${oldTotal} → ${newTotal}（+${newTotal - oldTotal}）——move: 只许收紧`,
    );
  }
  const stationaryByStage = (map, base) => {
    const out = new Map();
    for (const [id, entry] of map) {
      const was = base.get(id);
      if (!was || was.stage !== entry.stage) continue;   // 新增项由 ② 判、移动项由 ③ 判
      const key = stageKey(entry.stage);
      out.set(key, (out.get(key) || 0) + entry.cap);
    }
    return out;
  };
  const oldSums = stationaryByStage(before, before);
  const newSums = stationaryByStage(after, before);
  for (const key of new Set([...oldSums.keys(), ...newSums.keys()])) {
    const was = oldSums.get(key) || 0;
    const now = newSums.get(key) || 0;
    if (now > was) {
      problems.push(
        `cap 合计 stage${key}: ${was} → ${now}（+${now - was}）——move: 只许收紧，`
        + "按 stage 分组比（只比没动 stage 的项）：某组暴增等于在那个到期点上挖洞",
      );
    }
  }

  // ② 表项数不增（按 id 集合）
  const added = [...after.keys()].filter((id) => !before.has(id));
  if (added.length > 0) {
    problems.push(`豁免表新增 ${added.length} 项（${added.join("/")}）——move: 只许删除或收紧，不许新增豁免`);
  }

  // ③ stage 只许往后推 + 推迟必须带可查的阻塞段
  const labels = keepShellSegmentLabels(keepListText);
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) continue;                       // 新增已由 ② 判过
    if (was.stage === now.stage) continue;
    if (now.stage !== null && was.stage !== null && now.stage < was.stage) {
      problems.push(
        `豁免 ${id} 的到期刀 ${was.stage} → ${now.stage} 是**提前释放**——move: 只许往后推，`
        + "提前放走等于给这一项开新豁免",
      );
      continue;
    }
    if (!now.blocked) {
      problems.push(
        `豁免 ${id} 的到期刀是 ${now.stage}，但没写「阻塞段」——受阻项必须写明卡在哪一段`
        + "（推迟不写理由 = 无限期拖延）",
      );
      continue;
    }
    for (const label of now.blocked.split(/[、,，+]|\s\+\s/).map((one) => one.trim()).filter(Boolean)) {
      if (!labels.has(label.replace(/\s+/g, " "))) {
        problems.push(
          `豁免 ${id} 的阻塞段「${label}」不在留外壳清单里（${KEEP_LIST_REL} §ⅲ，现有 ${labels.size} 段）`
          + "——段号写错或清单漂了，判不了就是红",
        );
      }
    }
  }
  return problems;
}

/**
 * **三张登记表**（Chief 2026-11-02 口径）：新服务模块落盘时，允许同一笔改这三张表的**数组字面量**。
 * 范围按名字限定，不按"哪个文件"——越出这三处一行就红。
 */
export const REGISTRATION_TABLES = ["DOMAIN_MODULES", "NON_DOMAIN_MODULES", "ALLOW_QUERY_SELECTOR_WHITELIST"];

/**
 * **视图模块的登记表**（2026-11-06，Chief 派）：新建一个 `*-view.js` 时，它要登记的不是三张服务表，
 * 而是这五张。实测过：只按服务表开口子，新建视图模块会报 77 处"越出登记表块"。
 *
 * 边界（Chief 写死）：
 *   · 允许改：OWNERS / VIEW_STATE_PREFIXES / VIEW_EXPORTS / SECTION_OWNERS（只许"新 section 那一段"）/
 *     EXPORT_IDS；
 *   · 仍然禁止：改断言体、改任何 `assert` 行、放宽 STABLE / TEMPORARY / ALLOW_QUERY_SELECTOR_WHITELIST、
 *     动 MAX_EXPORTS 之类旋钮——这些都不在上面五张表里，行范围判据天然挡住。
 *   · `idRefsIn` 是**函数不是表**（按源码取 id 的 helper），没有需要登记的名单；真要加 helper 名
 *     得改函数体，那属于改判据，不在本例外内 —— 这里如实说明，不假装有张表。
 */
export const VIEW_REGISTRATION_TABLES = ["OWNERS", "VIEW_STATE_PREFIXES", "VIEW_EXPORTS", "SECTION_OWNERS", "EXPORT_IDS"];

/** 新增的模块是视图还是服务：按文件名后缀判（本仓 `*-view.js` 是视图，其余是服务模块）。 */
export function isViewModulePath(path) {
  return /-view\.js$/.test(String(path || ""));
}

/** 派生登记表的**数组字面量**行范围（口径同 `tableBlockRanges`：从源码算，不手写行号）。 */
export function registrationTableRanges(source, names = REGISTRATION_TABLES) {
  const wanted = names instanceof Set ? names : new Set(names || []);
  const clean = stripCommentsAndStrings(String(source || ""));
  const lines = clean.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    // 数组与对象都要认：服务表全是 `[...]`，视图表里 OWNERS / VIEW_STATE_PREFIXES / VIEW_EXPORTS 是 `{...}`
    const match = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*[\[{]/.exec(lines[index]);
    if (!match || !wanted.has(match[1])) continue;
    let depth = 0;
    let end = -1;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      for (const ch of lines[cursor]) {
        if (ch === "{" || ch === "[") depth += 1;
        else if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) { end = cursor; break; }
        }
      }
      if (end !== -1) break;
    }
    if (end !== -1) blocks.push({ name: match[1], start: index + 1, end: end + 1 });
  }
  return blocks;
}

/**
 * **A1 的唯一例外**（Chief 2026-11-02 裁定；2026-11-06 扩到视图模块）：新模块"落文件 + 登记"必须
 * 同笔做，否则三方死锁——只落模块 ⇒ 登记完整性红；先加登记 ⇒ 表里 readFileSync 一个不存在的文件
 * 直接抛；合成一笔 ⇒ A1 红（产品 + tests/js 不许同笔）。
 *
 * 开口子按**范围**、不按提交类型：当这一笔**新增**了 `static/*.js` 且该文件暴露 `window.X = api` 时，
 * 允许同一笔改 tests/js，但每一行改动都必须落在**该模块类型对应的登记表**里，而且新模块的名字
 * 必须真的出现在其中一张表里（"加了登记"是正向要求，不是"没越界就行"）。
 *
 * 两种模块、两套表（2026-11-06 实测：只按服务表开口子，新建视图模块会报 77 处"越出登记表块"）：
 *   · 服务模块（`!*-view.js`）→ DOMAIN_MODULES / NON_DOMAIN_MODULES / ALLOW_QUERY_SELECTOR_WHITELIST；
 *   · 视图模块（`*-view.js`）→ OWNERS / VIEW_STATE_PREFIXES / VIEW_EXPORTS / SECTION_OWNERS / EXPORT_IDS。
 *   同笔两种都新增 ⇒ 取并集。视图那条**不含** ALLOW_QUERY_SELECTOR_WHITELIST：放宽白名单不在例外内。
 *   `SECTION_OWNERS` 只放"新 section 那一段"（改到的行必须点名新视图模块）；`EXPORT_IDS` 整张表允许。
 *
 * 仍然禁止：改断言体、改任何 `assert` 行、放宽 STABLE / TEMPORARY / 白名单、动 MAX_EXPORTS 之类旋钮
 * ——它们都不在上面这些表里，行范围判据天然挡住。
 *
 * 判据只看**文件与行范围**（调用方从 git diff 刨好喂进来），不看提交信息里写了什么。
 */
export function newModuleRegistrationProblems({ addedModules, testsChanges, productSources = [] }) {
  const modules = (addedModules || []).filter((mod) => /window\.[A-Za-z_$][\w$]*\s*=\s*api\b/.test(String(mod.source || "")));
  if (modules.length === 0) {
    // 例外第二块：给已有模块加一个导出键（产品加键 + STABLE 登记 + MAX_EXPORTS 抬 1）
    const exportProblems = exportKeyAdditionProblems({ testsChanges, productSources });
    if (exportProblems !== null) return exportProblems;
    return ["A1: 同时改了产品代码与 tests/js，但没有「新增的 window.X = api 模块」——例外不成立（服务模块与视图模块都算，"
      + "也没有「给已有模块加一个导出键」的形态（STABLE 里没有新增键）；但文件里必须真的出现 `window.X = api`）"];
  }
  const changes = testsChanges || [];
  if (changes.length === 0) {
    return ["A1: 说是「新模块 + 登记」同笔，但读不到 tests/js 的改动范围——判不了就是红"];
  }

  // 服务模块 → 三张服务表；视图模块 → 五张视图表。同笔两种都有 ⇒ 取并集。
  const viewModules = modules.filter((mod) => isViewModulePath(mod.path));
  const serviceModules = modules.filter((mod) => !isViewModulePath(mod.path));
  const tableNames = new Set();
  if (serviceModules.length > 0) for (const name of REGISTRATION_TABLES) tableNames.add(name);
  if (viewModules.length > 0) for (const name of VIEW_REGISTRATION_TABLES) tableNames.add(name);
  const tableLabel = [...tableNames].join(" / ");
  const moduleBases = viewModules
    .map((mod) => String(mod.path || "").split("/").pop())
    .filter(Boolean);

  const boundary = changes.find((change) => String(change.path || "").endsWith("tests/js/boundary.test.mjs"));
  if (!boundary) {
    return [`A1: ${changes.map((change) => change.path).join("、")} 越出登记表块——`
      + `新模块那一笔只许改 tests/js/boundary.test.mjs 里的 ${tableLabel}`];
  }
  const blocks = registrationTableRanges(boundary.commitSource, [...tableNames]);
  if (blocks.length === 0) {
    return [`A1: 登记表（${tableLabel}）一张都没解析到——块边界解析失败就判红，不许放行`];
  }

  const problems = [];
  const rawLines = String(boundary.commitSource || "").split("\n");
  for (const change of changes) {
    if (change !== boundary) {
      problems.push(`A1: ${change.path} 越出登记表块——新模块那一笔只许改登记表（${tableLabel}），`
        + "别的测试改动要单开一笔");
      continue;
    }
    for (const range of [...(change.addedRanges || []), ...(change.deletedRanges || [])]) {
      const sectionLines = [];
      for (let line = range[0]; line <= range[1]; line += 1) {
        const block = blocks.find((item) => item.start <= line && line <= item.end);
        if (!block) {
          problems.push(`A1: ${change.path}:${line} 越出登记表块（${tableLabel}）——`
            + "新模块那一笔只许改这些登记表的字面量，断言体与旋钮都不许动");
          continue;
        }
        if (block.name === "SECTION_OWNERS") sectionLines.push(line);
      }
      // SECTION_OWNERS 只放"新 section 那一段"：**按整段看**——一段新增的 section 条目里
      // 必然有 `{` / `},` 这种不点名的结构行，所以不能逐行要求命中名字；整段合起来
      // 必须点名新视图模块，否则就是借新模块的名义改别人的归属（那是改判据，不在本例外内）。
      if (sectionLines.length > 0 && moduleBases.length > 0) {
        const text = sectionLines.map((line) => rawLines[line - 1] || "").join("\n");
        if (!moduleBases.some((base) => text.includes(base))) {
          problems.push(`A1: ${change.path}:${sectionLines[0]} 改了 SECTION_OWNERS 但整段没点名新视图模块`
            + `（${moduleBases.join(" / ")}）——只许加「新 section 那一段」`);
        }
      }
    }
  }

  for (const mod of modules) {
    const base = String(mod.path || "").split("/").pop();
    const registered = blocks.some((block) => rawLines.slice(block.start - 1, block.end).join("\n").includes(base));
    if (!registered) {
      problems.push(`A1: 新增模块 ${base} 没有出现在登记表（${tableLabel}）里——「落文件 + 登记」必须同笔完成，`
        + "否则登记完整性闸会认为它逃了闸");
    }
  }
  return problems;
}

/**
 * **A1 例外的第二块范围：给已有模块加一个导出键**（Chief 2026-11-06）。
 *
 * 卡死形态（实测 `0339dc4`）：产品给 ReadingView 加 `selectEntry`，同笔要把键写进 `STABLE`
 * 并把 `MAX_EXPORTS` 抬 1 —— 两者都是"改一行"（删 1 行 + 加 1 行），于是 R12 的 A1b 记 2 行
 * 未登记删除，红。而拆成三笔也走不通：先加 STABLE ⇒ R8 红（键还不存在）；产品同笔改表 ⇒ A1b 红。
 *
 * 边界（写死，别扩）：
 *   · 允许：本笔新增的键写进 `STABLE`（只许加，不许删已有键）+ `MAX_EXPORTS` 按新增键数抬高；
 *   · 禁止：删 STABLE 里已有的键、改其它旋钮（TEMPORARY / PENDING_REMOVAL / 任何上限）、改断言体；
 *   · 约束：新增的键必须在**同一笔的产品代码**里真的出现在 `const api = { … }` 上（不是只登记）。
 *
 * 返回 `null` = 这笔不是"加导出键"的形态（交给调用方报原来的 A1）；返回数组 = 判定结果。
 */
export function exportKeyAdditionProblems({ testsChanges, productSources = [] }) {
  const changes = testsChanges || [];
  const boundary = changes.find((change) => String(change.path || "").endsWith("tests/js/boundary.test.mjs"));
  if (!boundary) return null;

  const commitSource = String(boundary.commitSource || "");
  const parentSource = String(boundary.parentSource || "");
  const stableNow = arrayLiteralRange(commitSource, "STABLE");
  const stableBefore = arrayLiteralRange(parentSource, "STABLE");
  const maxNow = numberConstLine(commitSource, "MAX_EXPORTS");
  const maxBefore = numberConstLine(parentSource, "MAX_EXPORTS");
  if (!stableNow || !stableBefore || !maxNow || !maxBefore) return null;

  const keysNow = keysInArray(commitSource, stableNow);
  const keysBefore = keysInArray(parentSource, stableBefore);
  const addedKeys = [...keysNow].filter((key) => !keysBefore.has(key));
  if (addedKeys.length === 0) return null;   // 不是"加键"：交给原来的 A1 判定

  const problems = [];
  // ① 改动只许落在 STABLE / MAX_EXPORTS 那两行，或者纯注释行（注释不改判据）
  const rawCommit = commitSource.split("\n");
  const allowedNew = (line) => (stableNow.start <= line && line <= stableNow.end) || line === maxNow.line;
  const allowedOld = (line) => (stableBefore.start <= line && line <= stableBefore.end) || line === maxBefore.line;
  const isComment = (text) => /^\s*(\/\/|\*|\/\*)/.test(text);
  for (const range of boundary.addedRanges || []) {
    for (let line = range[0]; line <= range[1]; line += 1) {
      if (allowedNew(line) || isComment(rawCommit[line - 1] || "")) continue;
      problems.push(`A1: ${boundary.path}:${line} 越出登记表块——加导出键那一笔只许改 STABLE 与 MAX_EXPORTS`
        + "（外加纯注释行），断言体与别的旋钮都不许动");
    }
  }
  for (const range of boundary.deletedRanges || []) {
    for (let line = range[0]; line <= range[1]; line += 1) {
      if (allowedOld(line)) continue;
      problems.push(`A1: ${boundary.path}:${line} 越出登记表块——加导出键那一笔只许改 STABLE 与 MAX_EXPORTS`);
    }
  }

  // ② 不许删 STABLE 里已有的键：删除行里出现过的键，改完之后必须还在
  const deletedKeys = new Set();
  for (const range of boundary.deletedRanges || []) {
    for (let line = range[0]; line <= range[1]; line += 1) {
      if (!(stableBefore.start <= line && line <= stableBefore.end)) continue;
      for (const key of quotedKeysInLine(String(parentSource).split("\n")[line - 1] || "")) deletedKeys.add(key);
    }
  }
  const lost = [...deletedKeys].filter((key) => !keysNow.has(key));
  if (lost.length > 0) {
    problems.push(`A1: 删掉了 STABLE 里已有的键 ${lost.join("、")}——加导出只许加，删键要单独走 test-contract`);
  }

  // ③ MAX_EXPORTS 只许按"新增键数"抬高（抬高一个键就 +1，多抬一个数字也是红）
  if (maxNow.value !== maxBefore.value + addedKeys.length) {
    problems.push(`A1: MAX_EXPORTS ${maxBefore.value} → ${maxNow.value}，但本笔新增了 ${addedKeys.length} 个键`
      + "——上限只许按新增键数抬，不许顺手放宽");
  }

  // ④ 新键必须在同笔的产品代码里真的出现在 `const api = { … }` 上
  const modules = (productSources || []).filter((file) => /window\.[A-Za-z_$][\w$]*\s*=\s*api\b/.test(String(file.source || "")));
  for (const key of addedKeys) {
    if (modules.some((file) => apiObjectHasKey(file.source, key))) continue;
    problems.push(`A1: 新增的键 ${key} 没有出现在同笔产品代码的 \`const api = { … }\` 里——只登记不加键，`
      + "那正是 R8「登记了但不存在」要抓的形态");
  }

  // ⑤ 别的 tests/js 文件一行都不许动
  for (const change of changes) {
    if (change === boundary) continue;
    problems.push(`A1: ${change.path} 越出登记表块——加导出键那一笔只许改 boundary.test.mjs 的 STABLE 与 MAX_EXPORTS`);
  }
  return problems;
}

/** 顶层 `const NAME = [ … ];` 的行范围（结构在剥注释/字符串的文本上量，行号不变）。 */
function arrayLiteralRange(source, name) {
  const clean = stripCommentsAndStrings(String(source || ""));
  const lines = clean.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[`).test(lines[index])) continue;
    let depth = 0;
    let end = -1;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      for (const ch of lines[cursor]) {
        if (ch === "[" || ch === "{") depth += 1;
        else if (ch === "]" || ch === "}") {
          depth -= 1;
          if (depth === 0) { end = cursor; break; }
        }
      }
      if (end !== -1) break;
    }
    if (end !== -1) return { start: index + 1, end: end + 1 };
  }
  return null;
}

/** 顶层 `const NAME = <数字>;` → `{ line, value }`；找不到返回 null。 */
function numberConstLine(source, name) {
  const clean = stripCommentsAndStrings(String(source || ""));
  const lines = clean.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=\\s*(\\d+)`).exec(lines[index]);
    if (match) return { line: index + 1, value: Number(match[1]) };
  }
  return null;
}

/** 数组块里的字符串键（按行取，先去掉行尾 `//` 注释）。 */
function keysInArray(source, range) {
  const lines = String(source || "").split("\n");
  const keys = new Set();
  for (let line = range.start; line <= range.end; line += 1) {
    for (const key of quotedKeysInLine(lines[line - 1] || "")) keys.add(key);
  }
  return keys;
}

function quotedKeysInLine(line) {
  const withoutComment = String(line || "").replace(/\/\/.*$/, "");
  return [...withoutComment.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** 产品代码里 `const api = { … }` 块内是否真的有这个键（`key,` / `key:` / `"key":` 都算）。 */
function apiObjectHasKey(source, key) {
  const text = String(source || "");
  const start = text.indexOf("const api = {");
  if (start < 0) return false;
  const open = text.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let cursor = open; cursor < text.length; cursor += 1) {
    const ch = text[cursor];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) { end = cursor; break; }
    }
  }
  if (end < 0) return false;
  // **要带上收尾的 `}`**：slice(open, end) 会把它切掉，于是"最后一个键"永远匹配不到
  // （2026-11-06 实测：绿例被判"只登记不加键"，查了半天是这里差一个字符）。
  const block = text.slice(open, end + 1);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s{,(])(?:"|')?${escaped}(?:"|')?\\s*[,:}]`, "m").test(block)
    || new RegExp(`(^|[\\s{,(])${escaped}\\s*[,}]`, "m").test(block);
}

/** 从源码派生顶层 `const NAME = { … };` 的块范围（`allowed` / `forbidden` 见上）。 */
export function tableBlockRanges(source, { exemptionFile = false } = {}) {
  const clean = stripCommentsAndStrings(source || "");
  const lines = clean.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    // `export const` 也要认：豁免表整份都是 export 出来的（早期只写 `^const`，导致该文件一块都解析不到，
    // A1 于是报「找不到登记表块」——2026-10-29 由 DevLead 拿 9b48857 抓到）
    const match = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[index]);
    if (!match) continue;
    const name = match[1];
    // 豁免表里的常量只有**该文件**算 allowed；方向另由 exemptionDeltaProblems 判
    const allowed = MOVE_TABLES.includes(name)
      || (exemptionFile && (MOVE_EXEMPTION_BLOCKS.includes(name)
        || MOVE_EXEMPTION_BLOCKS_RETIRED.includes(name)));
    const forbidden = !allowed && MOVE_FORBIDDEN.test(name);
    if (!allowed && !forbidden) continue;
    // 单行常量（`const R5_MAX_EXCUSES = 0;`）没有 `{}`：上限/豁免就是这种形态，
    // 要单独记成 1 行块，否则"动旋钮"会被误报成"表外改动"，报错文案指错方向。
    if (!/^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*[\[{]/.test(lines[index])) {
      // 单行常量（上限/豁免）没有块体
      blocks.push({ name, allowed, forbidden, start: index + 1, end: index + 1 });
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      for (const ch of lines[cursor]) {
        if (ch === "{" || ch === "[") depth += 1;
        else if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) { end = cursor; break; }
        }
      }
      if (end !== -1) break;
    }
    if (end === -1) continue;   // 括号不配对：交给"找不到块"那条 red 兜底
    blocks.push({ name, allowed, forbidden, start: index + 1, end: end + 1 });
  }
  return blocks;
}

/**
 * `move:` 笔的放行判定（**纯函数**：调用方把 git 里刨出来的行范围喂进来）。
 * @param {{sha: string, files: string[], changes: {path: string, addedRanges: number[][],
 *          deletedRanges: number[][], commitSource: string, parentSource: string}[]}} input
 */
export function moveScopeProblems({ sha, files, changes, keepListText = null, declaredPaths = [] }) {
  const short = sha.slice(0, 7);
  const problems = [];
  const touchesProduct = files.some((file) => file.startsWith("backend/book2text/static/"));
  const touchesTests = files.some(isContractPath);
  if (!touchesProduct || !touchesTests) {
    const missing = !touchesProduct ? "backend/book2text/static/" : "tests/js/";
    problems.push(`A1: ${short} 是 move: 笔，但没有改 ${missing}——空声明的 move: 是伪装`);
    return problems;
  }

  for (const change of changes) {
    // **优先级：Move-Gate 声明 > A1 三张表块**——但只在 move: 笔、且**声明过**该路径时生效。
    // 未声明时行为不变（仍按三张表块判 → 红）。`test-contract:` / 普通提交不走这条分支。
    const exemptionFile = change.path.endsWith(EXEMPTION_FILE)
      && declaredPaths.some((path) => path.endsWith(EXEMPTION_FILE));
    const commitBlocks = tableBlockRanges(change.commitSource, { exemptionFile });
    const parentBlocks = tableBlockRanges(change.parentSource, { exemptionFile });
    const check = (ranges, blocks, side) => {
      for (const [from, to] of ranges) {
        for (let line = from; line <= to; line += 1) {
          const hit = blocks.find((item) => item.start <= line && line <= item.end);
          if (hit && hit.allowed) continue;
          if (hit && hit.forbidden) {
            // 豁免表例外：它**可以**被 move: 笔改，但只能往收紧的方向改（由 exemptionDeltaProblems 判方向）
            if (change.path.endsWith(EXEMPTION_FILE)) continue;
            problems.push(
              `A1: ${short} ${change.path}:${line} 落在 ${hit.name}（豁免表/上限）里——`
              + `move: 笔不许动削弱闸的旋钮`,
            );
            continue;
          }
          problems.push(
            `A1: ${short} ${change.path}:${line} 的${side}不在登记表内`
            + `（${MOVE_TABLES.join(" / ")}）——move: 笔只许改登记表`,
          );
        }
      }
    };
    if (!commitBlocks.some((item) => item.allowed) && !parentBlocks.some((item) => item.allowed)) {
      problems.push(
        `A1: ${short} ${change.path} 里找不到登记表块（${MOVE_TABLES.join(" / ")}）——`
        + `块边界解析失败就判红，不许放行`,
      );
      continue;
    }
    check(change.addedRanges, commitBlocks, "新增");
    check(change.deletedRanges, parentBlocks, "删除");
    if (change.path.endsWith(EXEMPTION_FILE)) {
      problems.push(...exemptionDeltaProblems({
        sha: short,
        oldSource: change.parentSource,
        newSource: change.commitSource,
        keepListText,
      }));
    }
  }
  return problems;
}

/** §18.6 登记判定：合格返回 null，否则返回一句人话（两段式里的「登记段」）。 */
function registrationGap(sha, docText, kindLabel, author = null, aliases = []) {
  const short = sha.slice(0, 7);
  if (!registeredIn1886(sha, docText, aliases)) {
    return `A3: ${short} 是 ${kindLabel}，但没登记在 §18.6`
      + "（登记行的「提交」格写集成后的 sha 或 cherry-pick 正文里的原 sha 都可以）";
  }
  // 判不了就是红：行在、列读不出（表头被改名/换表）→ 不能静默放行。
  const approver = registrationApprover(sha, docText, aliases);
  if (approver === null) {
    return `A3: ${short} 的 §18.6 登记行读不出「批准人」列——判不了就是红（表头是不是改了？）`;
  }
  // §18.6 判据 2：批准人必须是授权签署人（与"是不是作者"无关，所以不看 author）。
  const unauthorized = unauthorizedSigner(sha, approver);
  if (unauthorized) return unauthorized;
  // §18.6 判据 1：批准人 == 该笔提交作者 → 红（自己批自己）。整串比，不切字段。
  if (author && approver === author) {
    return `A3: ${short} 的 §18.6 登记「批准人」是它自己的提交作者（${author}）——自己签自己不算第二人复核`;
  }
  const reg = registrationContent(sha, docText, aliases);
  if (!reg) {
    return `A3: ${short} 出现在 §18.6 里但不是表格登记行——只出现在正文里不算登记`;
  }
  const lacking = [
    ["删了什么（删：…）", reg.deleted],
    ["补了什么更严的（补：…）", reg.stricter],
    ["变异证明（变异：…）", reg.mutation],
  ].filter(([, ok]) => !ok).map(([label]) => label);
  if (lacking.length > 0) {
    return `A3: ${short} 的 §18.6 登记缺 ${lacking.join("、")}——只写 sha 不算登记`;
  }
  return null;
}

/**
 * 单笔提交的契约判定（**纯函数**，自检夹具直接喂合成提交）。
 *
 * **两段式（Chief 2026-10-29 裁定，§18.6 已登记）**：把判据按「谁有权判」切开——
 * - `problems`（形态段）：**单人即可判**，pre-commit 拦。首行有没有 `test-contract:`、
 *   产品与 tests/js 有没有同笔、删文件有没有单开提交——都不需要第二个人签字。
 * - `registryProblems`（登记段）：**要第二人签**（§18.6 只有 DevLead 能加行），所以**不拦提交**，
 *   进 CI（`B2T_CONTRACT_STRICT=1`）和 `scripts/status.sh` 的可见红灯。
 *
 * 为什么必须切：A3 原来在 pre-commit 就要求"已经登记"，而登记只有 DevLead 能做——每次契约
 * 变更都得两人接力，谁接不上就有人 `--no-verify`，绕过记录比漏检更难查；更糟的是**登记提交
 * 自己也会被 A3 挡住**（它要登记的那笔还没登记）。切完以后，契约变更单人可提，登记红灯可见。
 *
 * @param {{sha: string, subject: string, files: string[], deletions: number,
 *          deletedFiles?: string[], docText: string}} commit
 * @returns {{problems: string[], registryProblems: string[], exempt: boolean}}
 */
export function commitContractProblems({
  sha, subject, files, deletions, deletedFiles = [], docText, moveChanges = null, author = null,
  message = null, addedStaticModules = [], testsChanges = [], productSources = [],
}) {
  const short = sha.slice(0, 7);
  const problems = [];            // 形态段：pre-commit 拦
  const registryProblems = [];    // 登记段：CI / status.sh 红灯，不拦提交
  const touchesProduct = files.some((file) => file.startsWith("backend/book2text/static/"));
  const touchesTests = files.some(isContractPath);
  const isMove = /^move[(:]/.test(subject);
  const isContract = subject.startsWith("test-contract:");

  // A1（形态）：普通提交不许同时碰产品与 tests/js；`move:` 笔是唯一例外，
  // 但它有更严的代价：tests/js 的每一行改动都必须落在登记表里（见 moveScopeProblems）。
  if (isMove) {
    problems.push(...moveScopeProblems({
      sha, files, changes: moveChanges || [], declaredPaths: moveGateDeclaration(message) || [],
    }));
    problems.push(...moveGateProblems({
      subject,
      message,
      files,
      // 方向判据由 moveScopeProblems 里的 exemptionDeltaProblems 承担（碰了豁免表就一定会算）
      directionProblems: [],
      exemptionTouched: files.some((file) => file.endsWith(EXEMPTION_FILE)),
      directionChecked: files.some((file) => file.endsWith(EXEMPTION_FILE)),
    }));
  } else if (touchesProduct && touchesTests) {
    // 唯一例外：新增 window.X = api 的服务模块，且 tests/js 的改动全落在三张登记表的数组字面量里
    // （按范围开口子，不按提交类型；判据只看文件与行范围，不看提交信息说了什么）。
    const exception = newModuleRegistrationProblems({ addedModules: addedStaticModules, testsChanges, productSources });
    if (exception.length) problems.push(...exception);
  }

  // A3 形态：改了契约路径的旧断言（有删除行）→ 首行必须是 test-contract:（单人可判）
  if (deletions > 0 && touchesTests && !isMove && !isContract) {
    problems.push(`A3: ${short} 改了 tests/js 的旧断言（删除 ${deletions} 行）但首行不是 test-contract:（${subject}）`);
  }
  // A3 形态：test-contract 提交不许动产品代码（单人可判）
  if (deletions > 0 && touchesTests && !isMove && isContract && touchesProduct) {
    problems.push(`A3: ${short} 是 test-contract 提交却动了产品代码`);
  }

  // 登记段：需要登记的提交 = 所有 `move:` 笔（登记义务与删行无关）+
  // 有删除行的 test-contract 提交。**判定放这里，不放形态段**。
  const needsRegistration = isMove || (deletions > 0 && touchesTests && isContract);
  // cherry-pick 会换 sha（`-x` 在正文留 `cherry picked from commit <原 sha>`）：
  // 登记行写原 sha 也算登记，否则集成一次就要重签一次（2026-11-03 为此重签两次）。
  const aliases = cherryPickOriginShas(message);
  let exempt = false;
  if (needsRegistration) {
    const kindLabel = isMove ? "move: 笔" : "test-contract 提交";
    const trailer = approvedByTrailer(message);
    if (trailer !== null) {
      // 新笔：签名走 trailer。值是别人 = 已复核；等于作者 = 自己批自己。
      if (author && trailer === author) {
        registryProblems.push(
          `A3: ${short} 的 Approved-by 是它自己的提交作者（${author}）——自己签自己不算第二人复核`,
        );
      } else {
        const unauthorized = unauthorizedSigner(sha, trailer);
        if (unauthorized) registryProblems.push(unauthorized);
        else exempt = true;
      }
    } else if (!registeredIn1886(sha, docText, aliases)) {
      // 既没有 trailer、也没有表格登记行 → 缺签字（历史笔不在此列，它们有登记行）
      registryProblems.push(
        `A3: ${short} 是 ${kindLabel}，但提交信息里没有 Approved-by trailer（也没登记在 §18.6）`
        + "——登记行的「提交」格写集成后的 sha 或 cherry-pick 正文里的原 sha 都可以",
      );
    } else {
      // 历史笔（trailer 规则之前）：回落到表格判定，两套并存，不一刀切。
      const gap = registrationGap(sha, docText, kindLabel, author, aliases);
      if (gap) registryProblems.push(gap);
      else exempt = true;
    }
  }

  // A1b：删 tests/js 的文件不算改断言。
  // 形态段：普通提交删文件 = 红（单人可判）；登记段：test-contract/move: 提交删文件，
  // 但登记不合格 = 红灯（删文件比删几行更重，登记义务不降）。
  if (deletedFiles.length > 0) {
    if (!isMove && !isContract) {
      problems.push(`A1b: ${short} 删了 tests/js 的文件（${deletedFiles.join(", ")}）——删文件不算改断言，必须单开 test-contract:`);
    } else if (!exempt) {
      registryProblems.push(`A1b: ${short} 删了 tests/js 的文件（${deletedFiles.join(", ")}）但 §18.6 登记不合格`);
    }
  }

  return { problems, registryProblems, exempt };
}

/** 从 git 刨 `move:` 笔在 tests/js 里的逐行变更（新增/删除的行范围 + 两个版本的源码）。 */
function moveChangesFromGit(sha) {
  const diff = git(["show", "--unified=0", "--format=", sha, "--", ...CONTRACT_SCOPE]);
  const byPath = new Map();
  let current = null;
  for (const line of diff.split("\n")) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      current = { path: fileMatch[1], addedRanges: [], deletedRanges: [] };
      byPath.set(current.path, current);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !current) continue;
    const oldStart = Number(hunk[1]);
    const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const newStart = Number(hunk[3]);
    const newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
    if (oldCount > 0) current.deletedRanges.push([oldStart, oldStart + oldCount - 1]);
    if (newCount > 0) current.addedRanges.push([newStart, newStart + newCount - 1]);
  }
  const showOrEmpty = (spec) => {
    try {
      return git(["show", spec]);
    } catch {
      return "";
    }
  };
  return [...byPath.values()].map((change) => ({
    ...change,
    commitSource: showOrEmpty(`${sha}:${change.path}`),
    parentSource: showOrEmpty(`${sha}^:${change.path}`),
  }));
}

/**
 * @returns {{ problems: string[], commitCount: number }}
 */
/**
 * base 树能不能当**回放基**（A2/A4 与 13/13 红证据的树）。
 *
 * 判据（DevLead 2026-10-29）：`ring-break-base:<static>` 下的 `*-view.js` 集合必须等于 HEAD 的集合。
 * 为什么只比这一项：tag 打早了（L0，static 下只有 `reading-view.js`）时，新测试在它上面会红在
 * 「`init` 注入不存在、模块没拆」，而不是「这条边切错了」——两种红混成一种，A2/A4 就失去意义。
 *
 * 返回问题描述；null = 可以当回放基。
 */
export function baseTreeGap({ baseTag = "ring-break-base" } = {}) {
  const statics = "backend/book2text/static";
  let baseSha;
  try {
    baseSha = git(["rev-parse", "--short", baseTag]);
  } catch {
    return `找不到 ${baseTag}（A2/A4 与 13/13 红证据都要它当回放基）`;
  }
  // expected 是**打 tag 时刻的冻结记录**，不是运行时的 HEAD：真 base 打下去之后 HEAD 还会
  // 合法地长新模块（下一个视图落盘），拿 HEAD 比会把合法增长判成"base 不对"（DevLead 2026-10-29）。
  let record;
  try {
    record = readFileSync(`${REPO_ROOT}/${REPLAY_BASE_RECORD}`, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .sort();
  } catch {
    return `没有 ${REPLAY_BASE_RECORD}：不知道打 tag 时刻 static/ 下应该有哪些 *-view.js，base 判定不能猜`;
  }
  if (record.length === 0) {
    return `${REPLAY_BASE_RECORD} 是空的——空集合会让这条自检恒真，按红处理`;
  }
  let baseFiles;
  try {
    baseFiles = git(["ls-tree", "--name-only", `${baseTag}:${statics}`]).split("\n").filter(Boolean);
  } catch {
    return `${baseTag} 里没有 ${statics}`;
  }
  const views = (files) => files.filter((file) => /-view\.js$/.test(file)).sort();
  const baseViews = views(baseFiles);
  if (baseViews.join(",") !== record.join(",")) {
    return `ring-break-base=${baseSha} 不是回放基：base 树 static/ 下 *-view.js = [${baseViews.join("、")}]，`
      + `打 tag 时刻应为 [${record.join("、")}]——在它上面跑 A2/A4 会红在「模块没拆」，不是「边切错了」`;
  }
  // 不再与运行时的 HEAD 比集合：HEAD 后来合法长模块是常态（下一个视图落盘），拿它比会误红。
  // 记录写错（多写/拼错一个模块）会与 base 树不等，上面那条会红，不需要额外的 ghost 检查。
  return null;
}

export function evaluateFeatureContract({ baseTag = "ring-break-base", docPath = null } = {}) {
  const problems = [];          // 形态段（pre-commit 拦）
  const registryProblems = [];  // 登记段（CI / status.sh 红灯）
  let unregisteredDeletions = 0;
  try {
    git(["rev-parse", "--verify", baseTag]);
  } catch {
    return { problems: [`找不到 tag ${baseTag}：闸 A 需要基点（DevLead 打 tag 后才能跑）`], registryProblems: [], commitCount: 0 };
  }
  // docPath：变异验证时喂 /tmp 里的改坏副本（真实提交 + 改坏的登记表），不碰仓库文档。
  const docText = readFileSync(docPath || `${REPO_ROOT}/${DOC_REL}`, "utf8");
  const commits = git(["rev-list", "--reverse", `${baseTag}..HEAD`]).split("\n").filter(Boolean);

  for (const sha of commits) {
    const numstat = git(["show", "--numstat", "--format=", sha, "--", ...CONTRACT_SCOPE])
      .split("\n")
      .filter(Boolean);
    const deletions = numstat.reduce((sum, line) => sum + (Number(line.split("\t")[1]) || 0), 0);
    const subject = git(["show", "-s", "--format=%s", sha]);
    const changedFiles = git(["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean);
    const touchesProduct = changedFiles.some((file) => file.startsWith("backend/book2text/static/"));
    const touchesTests = changedFiles.some(isContractPath);
    // 例外判据要的两种输入：① 本笔**新增**的 static 模块（含内容，判断它有没有暴露 window.X = api）；
    // ② tests/js 的改动行范围（只看范围，不看信息）。只在"产品 + tests/js 同笔"时去取，别给每笔加成本。
    let addedStaticModules = [];
    let testsChanges = [];
    let productSources = [];
    if (touchesProduct && touchesTests) {
      addedStaticModules = git(["show", "--name-status", "--diff-filter=A", "--format=", sha, "--", "backend/book2text/static/"])
        .split("\n").filter(Boolean)
        .map((line) => line.split("\t").pop())
        .map((path) => ({ path, source: (() => { try { return git(["show", `${sha}:${path}`]); } catch { return ""; } })() }));
      testsChanges = moveChangesFromGit(sha);
      // 加导出键那条例外要判"新键真的在产品代码的 api 对象上"——只取这笔改到的 static 文件
      productSources = changedFiles
        .filter((path) => path.startsWith("backend/book2text/static/"))
        .map((path) => ({ path, source: (() => { try { return git(["show", `${sha}:${path}`]); } catch { return ""; } })() }));
    }
    const verdict = commitContractProblems({
      sha,
      subject,
      files: changedFiles,
      addedStaticModules,
      testsChanges,
      productSources,
      deletions,
      deletedFiles: git(["show", "--name-status", "--diff-filter=D", "--format=", sha, "--", ...CONTRACT_SCOPE])
        .split("\n").filter(Boolean),
      docText,
      author: commitAuthor(sha),
      message: git(["show", "-s", "--format=%B", sha]),
      moveChanges: /^move[(:]/.test(subject) ? moveChangesFromGit(sha) : null,
    });
    problems.push(...verdict.problems);
    registryProblems.push(...verdict.registryProblems);
    if (!verdict.exempt) unregisteredDeletions += deletions;
  }

  if (unregisteredDeletions !== 0) {
    registryProblems.push(
      `A1b: 未登记的 test-contract / move: 提交合计删除 tests/js ${unregisteredDeletions} 行（登记齐了就是 0）`,
    );
  }
  return { problems, registryProblems, commitCount: commits.length };
}
