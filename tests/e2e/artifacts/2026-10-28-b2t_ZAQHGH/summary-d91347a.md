# d91347a 压力复测（QA）

被测：`d91347a`（marks 窗口“最新请求赢”）。干净单环境（`status` 确认）、全新副本、1423×900 dpr2、`pytest` 1002 passed。

## 四个数（120 连按，1→228 页）

| 指标 | 3c722ab（修复前） | d91347a（修复后） |
|---|---|---|
| 零推进次数 | 17/120 | **17/120** |
| `targetInEntries / targetInMarks` | 32/120 | **31/120** |
| 每 450ms rAF 帧数 | 1–7（中位 3） | **1–8（中位 3）** |
| marks 窗口跳回早期页 | 1-11(37) 2-22(38) 13-33(24) | **1-11(38) 2-22(38) 13-33(25)** |

点击全部到达元素（`clickHits == i`，0 次 click 错误）。**四个数没有变化**，所以“旧响应覆盖新窗口”不是真因。

## 真因（代码路径已定位）

`refreshReadingMarksPaint()`（app.js:18430）每次补 marks 后：

```
const segmentsToKeep = Math.max(readingRendered, 0);
renderReading({ reset: true });          // ← 从第 0 段开始重铺
while (readingRendered < segmentsToKeep) renderReading();
```

`renderReading({reset:true})` 不带 `startAt`，`readingRendered=0`，第一块只铺 `READING_CHUNK`
段（≈ 第 1–11 页），紧接着 18592 那段：

```
if (maxPage && !readingWindowHas(maxPage)) ensureReadingMarksWindow(maxPage);
```

`maxPage≈11` 不在当前窗口（阅读器在第 200 页）→ **去请求第 1–11 页的 marks** → 窗口被拉回
`1-11`；加载完再触发一次 `refreshReadingMarksPaint` → 又从第 0 段铺 → 又要 `11`。窗口就在
`1-11 / 2-22 / 13-33`（三个 chunk 的首段页）之间来回——正是观测到的分布。

所以不是“晚到的旧响应”，是**从第 0 段重建时按第一块的最大页去补窗口**。

## 建议

- `renderReading` 里那次 `ensureReadingMarksWindow(maxPage)` 只在**增量追加**（`reset=false`）时做，
  全量重建时跳过（重建时的 maxPage 只是第 0 段所在页，和用户位置无关）；
- 或 `refreshReadingMarksPaint` 改成 `renderReading({reset:true, startAt: max(0, segmentsToKeep - N)})`，
  只重铺可见区间——这同时能治第三个数（每 450ms 1–8 帧，300+ 段重建）。
