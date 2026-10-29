# L-107 新判据：面板"是否曾经出现过" — 2026-10-29

被测：`a70fa06`（产品代码 = `51529b8`）
探针：`qa.py panel_lifecycle --times N` → `driver.mjs: panel_lifecycle_probe`
判据：每次点「下一处未审」**从点击那一刻**在 `#reading-panel-host` 上装 MutationObserver，
只记 DOM，不读任何私有状态。

## 第一次跑就抓到了，分类答案是"开了又被清掉"

第一轮 20 次：**19 次 `opened-still-there`，1 次 `opened-then-cleared`**（第 19 次 / 第 48 页）。
没有一次 `never-opened`。

```
i=19  label=48  verdict=opened-then-cleared
hadChildrenBeforeClick=1   add=2   remove=3
最终 host 子节点=0  hidden=true  面板可见=false  150ms 后补开=false
```

### 时间序列（34ms 内开/清 3 轮）

```
t=33054  removed 1   ← 旧面板被移除（开新面板前先清）
t=33054  hidden
t=33055  hidden
t=33055  added 1     ← 新面板挂上
t=33055  hidden
t=33065  removed 1   ← 10ms 后又被移除
t=33065  hidden
t=33065  added 1     ← 又挂上
t=33065  hidden
t=33088  removed 1   ← 23ms 后最后一次移除，host 空 + hidden
t=33088  hidden
```

### 同一次点击的 `__b2tNextLog`

```json
{"entryKey":"01M60A76WCZ7VVF1RJVJNK0DT8:4","entryPage":48,"pageNo":48,
 "panelKey":"01M60A76WCZ7VVF1RJVJNK0DT8:4","panelOpened":true,"lineFound":true,
 "window":{"page_from":38,"page_to":58},"blocks":0,"branch":"next-lines"}
```

## 这三条一起看，能排掉两个方向

1. **不是"openReadingPanel 没跑"**：`addedCount=2`，面板确实挂上去过。
2. **不是"晚一帧"**：150ms 后 host 仍空且 hidden；`reopened.panelVisible=false`。
3. **`settlePanel` 当时判的是"成功"**：`panelOpened=true`，且本轮日志里**没有 `branch:retry`**
   （retry 只在 `!settled` 时排 260ms）。也就是说：
   `openReadingPanel` → `settlePanel` 查到面板 → `clearPendingPanel()` → **之后面板才被清**，
   此时已经没有 pending 可补，260ms 重试也没排。

   这解释了"为什么 pending 是空的"：**不是状态丢失，是"结算成功之后面板又被重绘收尾清掉"**。

4. 顺带一条：`blocks: 0` —— 第 48 页的 `readingPageBlocks` 没加载到，而 marks 窗口是 38–58（含 48）。
   可能是"marks 到达 → 重绘"这条路径的触发条件，留给读代码的人。

## 复现率

| 轮次 | 结果 |
|---|---|
| 第 1 轮 20 次 | 19/20（1 次 opened-then-cleared） |
| 第 2 轮 20 次 | 20/20 |
| 第 3 轮 20 次 | 20/20 |
| 第 4 轮 40 次 | 40/40 |

合计 **1/100 ≈ 1%**，和 L-107 原来记的"1/20 量级"同向但更稀。位置也不固定（这次是第 19 次/第 48 页，
不是第 18 次/第 39 页）——再次印证不是"特定 entry"。

## 数据文件

- `first-failure-transcript.json`：第一轮那次失败的**完整输出转录**
  （原始 `panel-lifecycle.json` 被后续 run 覆盖；转录字段与探针输出逐项一致）
- `panel-lifecycle-2.json` / `panel-lifecycle-40.json`：后续两轮原始输出

## 遗留：还有一批"判据型"探测静默为 false，这轮没改

输出字段里的占位符已全部改成 `unreadable:<变量名>`（54 处）。
下面这批是**参与判据计算的**，改了会让 PASS/FAIL 变化，按"先标记后修"没动：

```
driver.mjs:162   inspect        data = readingData ? ... : null
driver.mjs:848   crop           segments = readingData?.segments || []
driver.mjs:854   crop           if (readingMarks.has(key))
driver.mjs:1897  l4?            inEntries / inMarks 判据（恒 false）
driver.mjs:2062  l4?            editingKey（恒 null）
driver.mjs:2113  l4?            entriesDone（恒 0）
driver.mjs:2231  crop           mark（恒 null）
driver.mjs:2287  label_watch    key / entry（恒 null）
driver.mjs:2314  label_watch    key / entry（恒 null）
driver.mjs:2350  ...            data（恒 null）
driver.mjs:2913  ...            data（恒 null）
driver.mjs:3091  next_probe     data（恒 null）
driver.mjs:3170  editing        editingKey（恒 null）
```

这些会让某些探针"看起来测过了、其实是空跑"。要不要逐个改成显式 `unreadable` 或改 DOM 判据，
需要你排优先级——尤其 1897 那组（`inEntries`/`inMarks`）是判据本体。
