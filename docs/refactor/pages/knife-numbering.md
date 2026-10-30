# 刀号登记表与重排（刀 5 之后）

> **状态**：已定（2026-10-30 Chief 裁定）。**机读真值源是 `tests/js/knife-registry.mjs`**，
> 本文件解释为什么这么排、以及重排后每一刀碰什么。两处若不一致，以 `.mjs` 为准并回来改本文件。

## 一、为什么要重排

原计划是 `review = 刀 6`、`package = 刀 7`，把「片段抽取」（原 `刀 5b`）挤成了**不在登记表里的号**。
而 seed 的到期刀格解析器只认 `^刀(\d)$`（单数字）——写 `刀5b` 会让**整行 seed 静默消失**，
那一项变 unmapped，「到期刀 == 现算 max」就跳过它：**账本少一行，闸还是绿的**。

⇒ 重排成连续整数，且刀号**进登记表**（`tests/js/knife-registry.mjs`）：
seed 里出现未登记的号 → 红；解析不了的行 → 红（带行号与原文）。
`PAGES_STAGE` 不再是可以手写的常数，必须等于登记表里标 `landed` 的最大刀号。

## 二、刀号表（重排后）

| 刀 | 名字 | 状态 | 碰什么 | 施工图 |
|---:|---|---|---|---|
| 1 | 开场搬迁 | 已落 | pages 视图开场 | （无独立图，见 git 历史） |
| 2 | 第二批 movers | 已落 | 含 PageTile 三函数（到期判据 = acid 通过） | `docs/refactor/evidence/pages/stage2-movers-seed.md` |
| 2.5 | 装配接线 | 已落 | 14 段 wire 搬进 `init` | `docs/refactor/evidence/pages/knife2.5-split-plan.md` |
| 3 | 版心 | 已落 | 15 个函数 / 470 行 | `knife3-plan.md` |
| 4 | 选择/识别/缩放 | 已落 | 8 个函数 / 236 行 | `knife4-plan.md` |
| 5 | 函数搬迁收尾 | 已落 | 31 个函数 / 651 行 | `knife5-plan.md` |
| 6 | 片段抽取 | 待落 | 7 处 / 25 处写点（原「刀 5b」） | `knife5-plan.md` §⑫ |
| 7 | knife-review | 待落 | `recognizePage` + review 具名入口 | `knife-review-plan.md` |
| 8 | knife-package | 待落 | `applyPackageMode` / `applyProjectSettings` / `applySplitBatch` | `knife-package-plan.md` |
| 9 | 导出收口 | 待落 | 死 31 个导出键（R8 53 → 22） | `knife5-plan.md` §8.1 |
| 10 | 收口 | 待落 | R8 22 → 3（`init` / `enter` / `exit`） | 待出图 |

**旧 → 新**（只有这三处变了，其余号不动）：

```
刀 5b（片段抽取）  → 刀 6
刀 6（knife-review）→ 刀 7
刀 7（knife-package）→ 刀 8
原来写的「导出收口刀 = 刀 6」→ 刀 9；「收口 = ?」→ 刀 10
```

## 三、D 的账：**24 项**（不是 14 项）

`PAGES_STAGE` 从 2 跟到 **5**（登记表里 `landed` 的最大者），到期判据随之生效。
凡是「到期刀 ≤ 5 且仍有引用」的豁免项都会当场变成「到期未搬」，
所以它们的到期刀必须同批推到真正会搬走它们的刀上——**实测 24 项**：

```
→ 刀 6（片段抽取）10 项
   page-more-menu · apply-high-suggestions · aux-rerun · backups-open · selection-review-open
   stats-open · word-boxes-open · pages-margin-toggle · pages-overlay-toggle · layout-detect-open

→ 刀 7（knife-review）1 项
   pages-error（引用它的最后一个是 recognizePage）

→ 刀 8（knife-package）13 项
   assign-list-toggle · assign-open · check-pending · selection-check · page-setup-bar
   panel-pagenum-settings · panel-recognition-settings · selection-actionbar
   rec-margin-judgement · auto-apply-suggestions · selection-hint · selection-skip-checked · setup-panel
```

外加 **1 项删除**：`selection-recognize`（引用归零，整项从表里删，`PAGES_R3_TOTAL_CAP` 同批下调）。

**为什么是 24 不是 14**：原来的 14 只是「刀 7 / 刀 8 那 14 个函数引用到的项」，
漏了刀 6 片段抽取那一批的 10 项——它们同样挡在 `PAGES_STAGE = 5` 前面。
按 14 项改，闸会在另外 10 项上红，而且红文的形态是"到期未搬"，看起来像漏搬函数，实际是账没跟。

## 四、两条机检（`tests/js/boundary.test.mjs`）

```
① 候选行解析不了 → 红，带行号与原文
   「seed 第 N 行「刀5b」解析不了——整行会被跳过，到期刀会少算这一项」
② 刀号未登记 → 红
   「seed 第 N 行刀号「刀99」不在登记表 tests/js/knife-registry.mjs 里——未登记的刀号等于没有到期点」
③ PAGES_STAGE 必须 == maxLandedKnife()：落盘那一笔要同批改登记表 + 这一行
```

三条各自带合成样例喂红（`刀10` 必须能解析 / 解析不了必须红 / 未登记号必须红），
因为这三条失效的形态都是「绿」，不喂红就分不清是判据在管还是空跑。
