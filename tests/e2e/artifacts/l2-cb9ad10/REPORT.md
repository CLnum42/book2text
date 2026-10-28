# L2（cb9ad10 / 90e667e）交互验证

被测：`90e667e`（L2 笔 2 的测试提交，含 `cb9ad10`；worktree = 该提交 + 只有 tests/e2e 探针）。
全新副本、1423×900 dpr2。`tests/js 56/54/0/2`、`pytest 1002` 是 DevLead 侧的数，未在本轮复跑。

## 十个交互（clean 环境跑一次，每项看可观测效果）

| # | 项 | 结果 | 观测 |
|---|---|---|---|
| 1 | 过滤器 all/chars/unacked | PASS | `entries 7/7/7`、`segs 8/32/32`（filter 生效，段落数与筛选同步） |
| 2 | 翻页 next/prev | PASS | `label/pageNo/pdfTop: 1/1/0 → 2/2/461` |
| 3 | 进入编辑 | PASS | `readingEditingKey=…XMC3ZC:0`，`contenteditable=true` |
| 4 | 提交 | **FAIL** | 面板打开、blur、连按 4 次 Enter：`readingDrafts` 始终 **0**，进度「已审 0 / 567」不动 |
| 5 | 撤销 | **FAIL（4 的连锁）** | 无草稿可提交 → 点撤销弹 `没有可撤销的操作` |
| 6 | 悬停 | PASS | `readingHoveredSeq 23 → null`，`.is-hover` 1→0，`.is-linked` 1→0 |
| 7 | 跟随开关 | PASS | `follow true→false`，chip `跟随：开 → 跟随：关` |
| 8 | 右栏滚动同步 | PASS | 顶部 4 → 7（scrollTop 1379→2579） |
| 9 | 用户动过不抢位置 | PASS | 1.2s 后 scrollTop 2579 → 2579 |
| 10 | 左右联动 | PASS | 顶部 7→9；pdfTop 3006→3906；正文 2579→3508 |

**8/10 通过**（4 和 5 是同一根因）。

## #4 的定性：不是 L2 引入的（有对照）

同一个探针（打开一条 → blur → 连按 Enter）在三个版本上结果一致：

| 版本 | 连按 Enter 后 drafts | 进度 |
|---|---|---|
| `df77f19`（L1 之前的 main 基线） | 0 | 已审 0 / 567 |
| `eb02997`（L1 第一笔） | 0 | 已审 0 / 567 |
| `90e667e`（L2） | 0 | 已审 0 / 567 |

所以 **main 上「Enter 保留并下一处」只前进、不落草稿** 是既有缺陷（D6 那类"批量漏审"），
不是 L1/L2 的回归。对照：在 `ux/dock` 线（`f192e09`）上同一操作 drafts +20、已审 +20 正常，
说明 dock 那条线有修过、main 没有——需要单开把 dock 的修法带回 main。

## smoke（新口径）

```
smoke 43/45（K1 1 条、K2 1 条单列；其余 43 条：43 过 / 0 失败）
控制台错误 0 条
```

- 控制台零错误：0 条
- `?checktext=1` 自检：0 失败（`__b2tTextCheckFails` = 0）
