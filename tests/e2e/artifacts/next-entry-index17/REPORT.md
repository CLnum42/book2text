# index 17（第 18 条）现场取证 — 2026-10-29

被测：`a70fa06`（产品代码 = `51529b8`；a70fa06 只改注释）
环境：`qa.py up` 新库 `b2t_ZAQHGH`（662 页），1423×900 dpr2
探针：`next_entry_probe`（新增，见 `browser/driver.mjs`）

## 结论先说

1. **第 18 条不是跨页段**：`segPages = "39"`，单页。DevLead 最怀疑的跨页假设**不成立**。
2. **不是标点级**：`differs_chars`。且 `review/next-lines` 本身就把 `level == "differs_punct"` 过滤掉了，这条路径不可能出标点级。
3. **这条 entry 本身能正常打开面板**：新环境连点 20 次，第 18 次 `panelVisible=true / panelKey=有值 / lineInDom=true`。
4. **60 次连点 0 失败**：没复现。同一条 entry 在 `c28f32d` 红、`51529b8` 红、本例绿 → 竞态，不是数据相关 bug。
5. **"同一个位置"其实是"同一个队列序号"**：第二段 60 次连点的第 18 次落在另一条 entry（第 94 页），因为游标接着走。新环境每次队列顺序固定，第 18 次自然是同一条。

## 四个量（新环境第一次 20 连点，i=18）

| 量 | 值 |
|---|---|
| key | `01M60A5PJBMD2S7J9THR3P1M23:0` |
| page_no | 39 |
| level | `differs_chars`（汉字级） |
| 段页码 | `"39"` → 单页段，非跨页 |
| branch（`__b2tNextLog[0]`） | `next-lines` |
| 面板 | `panelVisible=true`、`panelKey=01M60A5PJBMD2S7J9THR3P1M23:0` |
| 目标行 | 在 DOM，`data-level=differs_chars`、`data-page=39` |

## 两处探针失效（比 index 17 本身更值得修）

### A. smoke 失败项的诊断字段恒为 null（已修）

`qa.py` 的 `brief` 从 `failures` 元素里取 `item.get("snapshot")`，但 `failures` 元素是**摊平的**
（`index/page/panel/dominant/panelVisible/highlight/...`），没有 `snapshot` 键。

后果：每次 smoke 的 next20 失败项除 `index` 外**全是 null**，
`final-accept-c28f32d/smoke.json` 与 `quality-51529b8/smoke.json` 里 index 17 那条
`{"index":17,"label":null,"panel":null,"dominant":null,"panelVisible":null,"highlight":null,"reason":null}`
就是这个 bug 的输出，**不是页面状态为空**。

`final-accept-c28f32d` 那次 `_pagesync_check` 的 failures 结构本来有 12 个键，
`label` 这个键名只出现在 brief 里——这是判据，不是巧合。

已修：brief 改取 failures 元素自身的字段，并补 `branch / highlightKey / blocks`。

### B. driver 里 22 个模块变量探测全部恒 `undefined`（未修，只报）

`reading-view.js` 是 IIFE（`(function(){...})()`）。L7–L12 把状态全搬进模块后，
`page.evaluate` 的 `typeof readingXxx` 一律是 `undefined`：

```
readingData / readingEntries / readingMarks / readingPageNo / readingFilter
readingPendingPanelKey / readingPendingPanelEntry / readingJumpSettleKey
readingJumpSettleTicks / readingUserScrollSeq / readingProgramScrollSeq
readingSyncDriver / readingSyncUntil / readingRendered / readingVisibleSegments
readingOptions / readingKey / readingMarksWindow / logReadingNext
readingDraftStorageKey / readingReloadAfterBatch / readingEditingKey
```

`probe_globals` 实测：22/22 全 `undefined`；`window.ReadingView` 只有 5 个键
（`init/enter/getCurrent/toggleFollow/reload`）。

受影响字段（现在恒为占位符，报告里看起来像"状态是空的"）：
`settleKey / userSeq / programSeq`（pageSyncSnapshot）、`pendingKey / pendingEntry / editKey`（next20Probe）、
`marksMapSize / marksWindow / entries / visibleSegments / filter`（marks 审计）、`readingRendered`。

L7–L12 之前这些字段有真实值（旧 artifact 里 `settleKey` 是具体 key、`pendingKey=None`），
所以 **`23b0102` 报告里"pendingKey=None → 状态丢失"那条判据的基础已经变了**：
现在读到的是"读不到"，不是"值为 null"。

与 L3 的 `typeof readingLineBox` 同类：**探测失效但不报错，报告里看不出来**。
建议：要么从 `window.ReadingView` 增加只读诊断导出，要么把 driver 里这些探测删掉/改成 DOM 判据。

## 原始数据

- `next-entry-probe.json`：新环境 20 连点（第 18 条即 index 17）
- `next-entry-probe-60.json`：同环境再连点 60 次（0 失败）
