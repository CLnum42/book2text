// 刀号登记表 —— **刀号的唯一真值源**（2026-10-30 Chief 裁定）。
//
// 为什么要有这张表（两个真事故的形态）：
//   ① `stage2-movers-seed.md` 的到期刀格解析不了时，旧实现 `continue` 掉**整行**——
//      那一项变 unmapped，R3 的「到期刀 == 现算 max」就跳过它，**账本少一行、闸还是绿的**。
//      `刀10` / `刀5b` / `刀 5` 都会触发（旧正则 `/^刀(\d)$/` 只吃单数字）。
//   ② 刀号散落在三份文档、一份 seed、一张豁免表里手写，改一个号要改五处，漂了没人对账。
//
// 所以：**刀号只写在这里**。seed 里出现未登记的号 → 红（等于没有到期点）；文档按本表的
// `n` 引用；`PAGES_STAGE` 必须等于 `maxLandedKnife()`（标 landed 的最大者），常数不许手写。
//
// 增删条目 = 改账本：新增一刀要先在这里登记（status: "pending"），落盘那笔再改成 landed，
// 并同批把 `pages-r3-exemptions.mjs` 的 `PAGES_STAGE` 跟到新的 maxLandedKnife()。
export const KNIVES = [
  { n: 1, status: "landed", scope: "pages 视图开场搬迁（无独立施工图，见 git 历史）" },
  { n: 2, status: "landed", scope: "第二批 movers；PageTile 三函数归本刀（到期判据 = acid 通过）" },
  { n: 2.5, status: "landed", scope: "装配接线 14 段搬进 pages-view 的 init（docs/refactor/evidence/pages/knife2.5-split-plan.md）" },
  { n: 3, status: "landed", scope: "15 个版心函数 / 470 行（docs/refactor/pages/knife3-plan.md）" },
  { n: 4, status: "landed", scope: "8 个选择/识别/缩放函数 / 236 行（docs/refactor/pages/knife4-plan.md）" },
  { n: 5, status: "landed", scope: "31 个函数 / 651 行（docs/refactor/pages/knife5-plan.md）" },
  { n: 6, status: "landed", scope: "片段抽取 7 处 / 25 处写点（原「刀 5b」；knife5-plan.md §⑫）" },
  { n: 7, status: "landed", scope: "recognizePage 搬入 pages-view + 外壳能力 showPageDetailError（不新建 review-view.js，裁定见 docs/refactor/pages/knife-review-plan.md）" },
  { n: 8, status: "landed", scope: "knife-package：applyPackageMode / applyProjectSettings / applySplitBatch（docs/refactor/pages/knife-package-plan.md）" },
  { n: 9, status: "landed", scope: "删 5 个 0 调用点的死 T 键 + 转发器（export-ratchet.md §三/§十；另有 3 个 0 调用点键的接线搬走拆到 9.6）" },
  // 9.1–9.5：刀 9 的子刀（2026-10-30 Architect 拆；每个子刀一笔，闸不允许一刀多笔）。
  // T 键的死期就是「搬它宿主的那一刀」，所以这些号必须在这里登记——否则死期表写 9.3 会「未登记」。
  { n: 9.1, status: "pending", scope: "视图切换：showView / hydrateView（export-ratchet.md §十）" },
  { n: 9.2, status: "pending", scope: "任务轮询与可见性：pollTask / fetchPageBlocks / schedulePageVisibility" },
  { n: 9.3, status: "pending", scope: "版心一族（对话框 / 进度 / 瓷砖 / 拖动保存）" },
  { n: 9.4, status: "pending", scope: "页码一族（三个面板宿主 + 指标）" },
  { n: 9.5, status: "pending", scope: "选择 / 网格 / 步骤 / 收尾 / 其它" },
  { n: 9.6, status: "pending", scope: "渲染循环 / 版心撤销按钮的接线收回模块（export-ratchet.md §三 裁定 A、§十 9.6 行）。\n    注：Builder 实测两个泵的队列本身在外壳（fetchPageBlocks/pumpPageSuggestionQueue 的 .finally 都在外壳），\n    「搬调度器」不成立，9.6 的真实形态可能只剩 undoMarginEdit 一个键——已请 Architect 改判" },
  { n: 10, status: "pending", scope: "收口：R8 22 → 3（init / enter / exit）" },
];

/** 刀号是否已登记（`刀5b` 这种带字母的本来就解析不出来，到不了这一步）。 */
export function isRegisteredKnife(n) {
  return KNIVES.some((knife) => knife.n === Number(n));
}

/** 已落盘的最大刀号 —— `PAGES_STAGE` 的真值。 */
export function maxLandedKnife() {
  return KNIVES.filter((knife) => knife.status === "landed").reduce((max, knife) => Math.max(max, knife.n), 0);
}

/** 登记表里该刀号的条目（判据红文里要用它的名字，别让读红文的人回去翻文档）。 */
export function knifeOf(n) {
  return KNIVES.find((knife) => knife.n === Number(n)) || null;
}

/**
 * 一组 `git log --format=%s` 的输出 → 已落盘的最新 pages 刀号（一条都不匹配返回 null）。
 *
 * 刀号允许小数（`刀 2.5`），所以一律 `Number(...)`，**不许用 parseInt**：`parseInt("2.5")` = 2，
 * 会把 2.5 悄悄当成 2 —— 和 `刀5b` 那类「解析串位」是同一个坑的另一半。
 */
export function gitMaxKnifeFromLog(text) {
  let max = null;
  for (const line of String(text || "").split("\n")) {
    const m = /^move\(pages\):\s*刀\s*([0-9]+(?:\.[0-9]+)?)/.exec(line.trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    max = max === null ? n : Math.max(max, n);
  }
  return max;
}

/**
 * 判据内部现算的「当前刀」= 两个真值源的最大值。
 *
 * 为什么不读文件里的 `PAGES_STAGE` 常数（2026-10-30 定稿）：常数是人抄的，抄错/忘改就是一段判据
 * 在空转（`PAGES_STAGE=2` 停过三刀）。现算的两个源各自都有独立证据，且两者的差本身有意义（见下）。
 */
export function stageNow({ gitMax, registryMax }) {
  const git = Number(gitMax);
  const landed = Number(registryMax);
  if (!Number.isFinite(git)) return Number.isFinite(landed) ? landed : null;
  if (!Number.isFinite(landed)) return git;
  return Math.max(git, landed);
}

/**
 * `PAGES_STAGE` 的**两个真值源交叉校验**（2026-10-30 Chief 定稿：不二选一，且允许在途一刀）。
 *
 * `delta = 登记表 landed − git 最大刀号`：
 *   · `0`  → 绿：没有在途刀；
 *   · `1`  → 绿：**本笔正在落第 registryMax 刀**，git 历史里还看不到它（pre-commit 时 HEAD 是父提交）；
 *   · `>= 2` → 红：「登记表领先 N 刀，但 git 只到 M」——只改登记表没落 move 笔；
 *   · `< 0`  → 红：「登记表落后 git N 刀」——只落了笔没更新登记表。
 *
 * 为什么不是「读 COMMIT_EDITMSG 看正在提交的消息」：git 文档（githooks(5)）写明 pre-commit
 * 是 *before obtaining the proposed commit log message* 调用的，那时这个文件要么不存在、
 * 要么是**上一笔的残留**——残留的 `move(pages): 刀 9` 能让判据直接跳过九刀。
 * 「在途最多一刀」这个表述更本质，也不需要读任何文件。
 */
export function stageSourceProblems({ gitMax, registryMax }) {
  const landed = Number(registryMax);
  if (!(landed >= 1)) {
    return [
      `登记表里一刀都没标 landed（landed 最大=${registryMax}）——`
      + "不许用「清空登记表」把这条交叉校验变成通行证",
    ];
  }
  const delta = landed - Number(gitMax);
  if (delta === 0 || delta === 1) return [];
  if (delta >= 2) {
    return [
      `登记表领先 ${delta} 刀，但 git 只到 ${gitMax}——只改登记表没落 move 笔`
      + "（在途最多一刀：delta ≤ 1 才算「本笔正在落」）",
    ];
  }
  return [`登记表落后 git ${-delta} 刀——只落了笔没更新登记表`];
}
