# Jev 验收 JSON 的字段契约（`book2text.jev-orders.v2`）

由 `scripts/accept_jev.py --dump-out <file>` 产出，给 OCREval/QA 算「前 N 行命中率」用。
**脚本不造指标**：它只给两种顺序与每行的真错标记，命中率是「前 N 行里 `is_error=true` 的比例」。

## 顶层

```jsonc
{
  "schema": "book2text.jev-orders.v2",
  "project_id": "b2t_H6GXVG",
  "threshold": 0.05,          // 「可疑」档的阈值（越低越可疑；≤ 阈值进第一档）
  "queue_lines": 64,          // 队列口径的行数（正文块 + 分歧行 + **未裁决**；与 next-lines 一致）
  "gold": { "file": "….txt", "is_error_method": "normalized_substring" } | null,
  "baseline":   [ <row>, … ], // 正文流原顺序（未跑 Jev 时用户看到的顺序）
  "jev_sorted": [ <row>, … ]  // 按 Jev 排序后（可疑档 → 其余分歧行；同档按 页码→块序→行序）
}
```

## 每一行 `<row>`

| 字段 | 类型 | 含义 |
|---|---|---|
| `line_id` | string | 行 id（`block_line.line_id`，ULID）——对库、对标记都用它 |
| `page_no` | int | 页码（1 起，PDF 顺序） |
| `block_order` | int | 该块在页内的块序（`block.order_index`） |
| `line_index` | int | 该行在块内的行序（0 起） |
| `jev_score` | number \| null | `prob_1`，0–1，**越低越可疑**；`null` = 这一行没跑过 |
| `text` | string | 当前正文（A 路，用户看到的文本） |
| `aux_text` | string | 第二引擎文本（B 路） |
| `is_error` | bool \| null | 是否真错；`null` = 没给 `--gold`，由验收方自己填 |
| `is_error_method` | string \| null | 目前只有 `"normalized_substring"`：把该行文本按 compare.py 归一化后，**不是金标准的子串** ⇒ 真错 |

## 怎么算命中率

```python
rows = data["jev_sorted"]
hit = sum(1 for r in rows[:50] if r["is_error"])
rate50 = hit / 50           # 前 50 行命中率；前 100 同理
```

## 已知口径与注意

- **行数对账（2026-11-05，同树同项目）**：`review_status.queue_items` 给
  `total 250 / unacked 64 / acked 186 / outside 4`；本脚本的 `--dump-out` 现在**恰好**是这 250 行
  （`queue_lines`）。早先的 255 = 250 + 4 版心外 + 1 行"块当前文本已被改成与 B 路一致、
  行记录还是旧文本"的陈旧行——已改用 `divergence_index` 的 marks，与队列同源。
- 261 是 OCREval 测量口径（含页面噪声/图注块），不是产品口径；基线也要按 250 重算。
- `is_error` 的 `normalized_substring` 是**代理判据**：OCR 行恰好是金标准子串就判对。
  如果 OCREval 有更准的逐行对齐，**以它的标记为准**（覆盖 `is_error` 再算）。
- `jev_score=null` 的行仍会在 `jev_sorted` 里，排在第二档（有分歧但没分数）——
  这正是"只跑了一半/没跑"时的可见状态。
