# L4（7c20e43）验证

被测 `7c20e43`（worktree = 该提交 + 只有 tests/e2e 探针）。全新副本、1423×900 dpr2。
`pytest 1002 / tests/js 56（54 pass 2 skip）` 是 DevLead 侧读数，本轮未复跑。

## 1. 「下一处未审」四个分支

| 分支 | 结果 | 观测 |
|---|---|---|
| 有下一处 | PASS | 20 次点击 → **20 个不同 panelKey**，页码 1 → 49，没有 17/120 那种零推进 |
| 队列空了 | PASS | 把 next-lines mock 成空 → 提示「全书未审已处理完 · 可以去「成稿模式」通读一遍，或者直接导出」，**没有卡住** |
| 请求失败 | PASS | mock reject → 提示「找下一处失败：mock-network-down」，**不静默** |
| 20 次已审增长 | **N/A（main 不落草稿）** | 20 次后 `readingDrafts` 仍 0、进度「已审 0 / 567」；这是 main 的既有行为（dock 线才会 +20），不是 L4 的回归 |

## 2. 草稿恢复

localStorage 的格式是 `{"items":[{key,base,text,at}]}`（不是 map）。
放 2 条 → reload → 打开项目 → **出现 confirm「有 2 处未提交的正文改动…」** → 接受：

```
inline = 2、inlineMarks = 2（行上草稿标记）、进度「已审 2 / 567 条」
```

## 3. 视口变化（模块内 `onViewportResize`）

```
1423×900 → 1180×800:
  字号 15px / 行高 30.75px 不变（宽度变化不该改行高）
  .reading-seg 相邻重叠 0 → 0（正文不重叠、不错位）
  label/pageNo 1 → 1（不乱跳）
  改完尺寸滚一屏: label 1 → 3、scrollTop 916（滚动→页码映射仍正常）
```

## 4. 编辑态（`onInlineInput` 的 350ms 防抖）

点一行 → 进入编辑（`readingEditingKey=…BDJ4:0`）→ 输入 "QA" → 700ms 后
`readingInlineEdits.size = 1`、`.is-inline-edited` 标记 1 个（定时器生效）。

## 5. smoke + 自检

```
smoke 42/45（K1 1 条、K2 1 条单列；其余 43 条：42 过 / 1 失败）
控制台错误 0 条
?checktext=1 自检：0 失败
另外失败：三方一致：点左树条目（第 50 页）—— 面板 47 / 顶部 46 / 左栏 47
```

**`第 50 页` 差 1 这条在 L2/L3/L4 三次 smoke 里都出现了**（`e7ea923` 首次、其后复跑 3 次全 PASS）。
已经不是"0/3 一次性噪声"的量级，形态固定（顶部比面板/左栏少 1），建议单开跟踪。
