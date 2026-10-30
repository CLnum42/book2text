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

## 五、规格（待 TestDev 落）：`PAGES_STAGE` 两个真值源交叉校验

**背景**：`main@743f5bc` 起 `PAGES_STAGE` 改由 **git 推导**（最大 `move(pages): 刀 N` 首行）；
`tests/js/knife-registry.mjs` 里另有一份 `landed` 标记。两源今天都是 5，但**没有任何东西比较它们**——
只改一边不会红。Chief 2026-10-30 裁定：**做成交叉校验，不二选一**（二选一会让另一个变成摆设）。

```
① 算 gitMax    = git log 里 `move(pages): 刀 N` 首行的最大 N
② 算 registryMax = KNIVES 里 status === "landed" 的最大 n
③ 两者不等 → 红，红文必须同时打印两边值：
   「PAGES_STAGE 的两个真值源不一致：git 最大刀号=5，登记表 landed=4——
     有人只改登记表没落 move 笔，或只落笔没更新登记表」
④ PAGES_STAGE 必须同时等于两者（保留现有 `PAGES_STAGE == maxLandedKnife()` 那条，作为"等于登记表"的证据）
```

**喂红四条**（合成，不依赖仓库状态）：

```
a) gitMax=5 / registryMax=4 → 红，且红文同时含「git 最大刀号=5」「登记表 landed=4」
b) gitMax=4 / registryMax=5 → 红（反向也要红：不能只判"git 更大"）
c) 两边都 5 → 绿
d) registry 里一刀都没标 landed → 红（不许"清空登记表"变成通行证）
```

**口径**：刀号允许小数（`刀2.5`）→ 用 `Number`，不用 `parseInt`；git 不可用时（pre-push 的导出树没有 `.git`）
→ 记 `SKIP` 并打印，**不许静默变绿**。

## 六、行号口径（2026-10-30，Chief 定的纪律）

施工图里的行号是**锚点**，不是标识——它每刀都会漂，所以：

```
① 每张图必须标「实测于 <sha>」（刀 6 / 刀 7 / 刀 8 的图都标了；没标 = 数没有出处）
② 落盘前必须重量，不许照抄上一刀的号
   （刀 6 之后 recognizePage 4962 → 4965 就是重量出来的；抄旧号会锚到别的语句上）
③ **报行号时必须说明是「原始行号」还是「剥注释后的偏移行号」**
   偏移行号唯一合法的用途是"同一份代码内部做相对比较"，**不许跨工具传递**。
```

为什么要有第 ③ 条（真实事故）：一次复核为了剥块注释用了
`.replace(/\/\*[\s\S]*?\*\//g, "")`，**连块注释里的换行一起删掉了**——
计数（23 种 / 37 处 / 13+3+7）完全正确，行号却整体偏移约 **377 行**，当成原始行号报出去。
计数对、行号错，是最容易过关的一种错：读的人只会去改错地方，闸还照样绿。
