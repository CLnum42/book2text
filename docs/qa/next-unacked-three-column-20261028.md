# 「下一处未审」none=5/20：三列对照（2026-10-28 18:20）

**结论：三列全部对得上，问题不在数据口径，在时序。**
「那些未审行不在正文流 line_spans 里」这一说法**不成立**；据此写的
`next-lines` 文档说明需要改。

## 量的是什么

- 项目：`b2t_ZAQHGH`（662 页英文书），源库 `~/Documents/Book2Text/b2t_ZAQHGH`。
- 只读副本：sqlite backup 到临时库后，用后端同一套函数计算（不写源库）。
- 正文流：`core/export/project.py:preview_segments_json`，`ExportOptions()` 默认
  （= 阅读视图 `readingOptions()` 的段集），再套前端 `readingVisibleSegments()` 的过滤：
  `text.trim()` 非空、`type != footnote`。
- 队列：`core/project/reading_marks.py:marks_data` → `review_status.queue_items()`
  （与 `/review/marks` 的 `page_counts`、`/review/tree`、顶栏分母同一个源）。
- 时点：2026-10-28 18:20，源库 `project.db` mtime 12:56、`-wal` 0 字节
  （= 与 QA 18:05 起跑时的数据一致：567 汉字未审）。

## 三列对照（卡住的 4 页 / 5 条）

| 页 | `readingEntries` 有没有该页的键 | 服务端 queue 同页 | 对得上？ |
|---:|---|---|---|
| 11 | **有**：第 7 次点击 `lineFound=true`、`entryPage=11`、面板已开 | `chars_unacked=1`，条目 `S5PBG5 L1`，**在流里** | 是 |
| 14 | **有**：第 10、11 次点击各找到 1 条（`CH9AB9 L7 / L12`） | `chars_unacked=2`，两条都在流里 | 是 |
| 18 | **有**：第 17 次点击 `lineFound=true` | `chars_unacked=1`，在流里 | 是 |
| 23 | **有**：第 19 次点击 `lineFound=true` | `chars_unacked=1`，在流里 | 是 |

离线复算（同一份数据）：全书未审汉字 **567** 条，其中在正文流 **562** 条，
流外只有 **5** 条（页 48/106/499/621/630，其中 3 页整页都在流外）。
页 11/14/18/23 的每一条都在流内。

> 第 7/10/11/17/19 次点击的证据来自 `tests/e2e/artifacts/2026-10-28-b2t_ZAQHGH/next20-4e8c9dd.json`：
> `branch=retry, lineFound=true`，而 retry 只可能在 `gotoReadingEntry` 找到并铺出该行之后发生。

## 真正的分界点在「第 8 次」

- 打开时 marks 窗口 = 第 1–11 页（`first_unacked_page=1`，radius 10）。
- 这个窗口里的未审汉字行**恰好 7 条**：(1,0) (1,1) (4,0) (8,0) (9,4) (9,6) (11,1)。
- 5 份复跑 artifact 里有 4 份 `first-none = 8`；前 7 次点击走的正是这 7 条。
- 第 8 次是第一次必须「补窗口」的点击：`readingNextPageWithUnacked()` 给出下一页 →
  `await ensureReadingMarksWindow(page)` → 再在 `readingEntries` 里找。
- `ensureReadingMarksWindow()` 在 `readingMarksLoading` 为真时**把页号塞进
  `readingMarksQueued` 后立即 return**；调用方的 `await` 于是拿不到新数据，
  对着旧窗口的 entries 找 → 找不到 → `branch: none`。这是竞态，不是口径。

## 顺带查到：日志里的 `retry` 一直是假信号

`gotoReadingEntry()` 判断面板是否建起来用的是
`#reading-stream .reading-panel`，但面板早已搬到 `#reading-panel-host`
（独立 host，正是为了不被重绘清掉）。这个选择器永远匹配不到，于是：

- 每一次成功的跳转都被记成 `branch: retry / reason: no-line`；
- 260ms 后 `openReadingPanel()` 会被**再调一次**（关掉重建）；
- `readingPendingPanelKey` 永远清不掉，重绘后还会继续补开。

所以 QA 报表里 `retry 15/20` 不能当失败信号；`none` 才是。

## 命令

```bash
# 离线复算（只读副本，不碰源库）
sqlite3 "file:$HOME/Documents/Book2Text/b2t_ZAQHGH/project.db?mode=ro" ".backup /tmp/.../project.db"
# 再用 book2text.core.project.reading_marks.marks_data +
#   book2text.core.export.project.preview_segments_json 复算
```

## 对修复的含义

1. `next-lines` 作为唯一数据源可以保留（顺带解决「流外 5 条」的诚实报数），
   **但它单独治不了这个 bug**：新代码只是把 `none` 换成 `missing`。
2. 必须同时让 `ensureReadingMarksWindow()` 共享进行中的 promise（回来再决定找不找），
   不能"排队后立即返回"。
3. 面板存在性判断改成 `#reading-panel-host .reading-panel`，否则日志继续骗人、
   面板每 260ms 被重建一次。
4. 验收：干净副本 20 连点 × 3 轮，`none=0` **且** `missing=0`，每次 `progressed=true`；
   若流内已空而 `chars_unacked>0`，提示必须写「流内已无未审；另有 5 处不在正文流里」，
   不许写"全部处理完"。
