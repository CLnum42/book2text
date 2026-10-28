# 审校页（#view-reading）模块边界 — 阶段 0

> 基线：`main@f500692`（产品代码 = `2d33dd4`，tag `run-2026-10-28`）。
> 规模：`app.js` 21,198 行；审校相关块约 **3,185 行**（18,003–21,187）；顶层状态 **61 个 `reading*` let/const**。

## 0. 架构前提（不许破）

- **用经典脚本 + 全局命名空间**，不用 `type="module"`：`window.ReadingView = {...}`，`index.html` 里按序 `<script>` 加载。
  ES module 默认 deferred，会改 boot 时序——这个仓库本周一半 bug 都是时序问题。
- 守 D-046：前端**不做构建步骤**。
- 迁移只搬归属，**不改行为**；要改行为另开一轮（带设计稿与验收判据）。

## 1. 状态归属（61 个）

| 簇 | 状态 | 数量 | 迁移风险 |
|---|---|---|---|
| **A 骨架** | `readingData` `readingProject` `readingStackProject` `readingSplitState` | 4 | 低 |
| **B 正文流与图片** | `readingRendered` `readingSegmentNodes` `readingObserver` `readingAppendScheduled` `readingTiles` `readingPageBlocks` `readingBlockPromises` `readingLoadedImages` `readingImageQueue` `readingImagePumping` `readingImageToken` `readingImageProfile` `readingNearObserver` `readingVisibleObserver` `readingNearSet` `readingVisibleSet` `readingResizeObserver` + `readingSpanCache`(const) | 18 | 中（DOM 归属） |
| **C marks 与队列** | `readingMarks` `readingEntries` `readingMarksWindow` `readingGlobalCounts` `readingPageCounts` `readingFirstUnackedPage` `readingMarksInFlight` `readingMarksRequestSeq` `readingTreeData` `readingTops` `readingFilter` `readingCursorEntry` | 12 | **高**（17/120 零推进源） |
| **D 面板与落位** | `readingPanelKey` `readingPendingPanelKey` `readingPendingPanelEntry` `readingJumpSettleKey` `readingJumpSettleTicks` | 5 | 高（跨重绘） |
| **E 草稿与编辑** | `readingDrafts` `readingInlineEdits` `readingEditingKey` `readingInlineTimer` `readingRepaintPending` | 5 | 中（写库链路） |
| **F 页码与滚动同步** | `readingPageNo` `readingSyncDriver` `readingSyncUntil` `readingScrollRaf` `readingPdfScrollRaf` `readingUserMovedAt` `readingUserScrollSeq` `readingProgramScrollSeq` `readingSuppressFollowUntil` `readingPageSyncTimer` `readingPageSyncFixing` `readingPendingBox` `readingOpenStartedAt` `readingAutoJumpDone` `readingHoveredSeq` | 15 | **高**（200/200 源） |
| **G 显示与偏好** | `readingFollow` `readingProof` `readingMarkupLevel` `readingPendingOn` `readingPreflightData` | 5 | 低 |

**结论：61 个里 59 个在块内自洽**，只有两个被块外读到（见 §2）——边界基本干净。

## 2. 已发现的两处越界（Slice 1 一并收掉）

| 位置 | 现在怎么用 | 改法 |
|---|---|---|
| `app.js:987` `enterReviewStep()` | 调 `savePosition("review", readingPageNo)` | 改调 `ReadingView.enter()`，由模块自己保存位置 |
| `app.js:9347` 工具条 `reading-follow-chip` | 直接 `setReadingFollow(!readingFollow)` | 监听搬进模块，对外只留 `ReadingView.toggleFollow()` |

## 3. 共享输入（模块只读，由外壳注入）

`currentProject`（28 处）、`el()`（105）、`apiJson`（8）、`exportOptions`（2）、`token`（2）、
`showNoticeBar`（5）、`localStorage`（10）、`performance.now`（12）、`currentView`（9）、
`showView`（1）、`openPageDetail`（1）。

**注入方式**：`ReadingView.init({ getProject, el, apiJson, getExportOptions, token, notify, storage, getView, showView, openPageDetail })`
外壳在 `boot()` 里调一次；模块内部不再直接碰这些全局。

## 4. 对外接口（唯一出口）

```
enter(projectId) / exit()
nextUnreviewed() / prevUnreviewed()
gotoPage(pageNo) / jumpToEntry({ blockId, lineIndex })
getCurrent() → { key, pageNo, lineIndex, done, total, draftCount }
submitDrafts() / undo() / toggleFollow()
on("change" | "drafts-changed" | "submitted" | "error", fn) → 退订
```

**禁止**：其他视图 `querySelector` `#view-reading` 内部、读模块内部状态、自己算正文流（D-106）。

## 5. Slice 1（半天标定）

搬 A 簇 + `#view-reading` 的 DOM 归属 + `enter/exit/getCurrent` 最小实现 + 收掉 §2 两处越界。
**验收**：`node tests/js` 与 `pytest` 全绿；特征测试全绿；smoke 的四个数（正文归一化哈希、字数、段数、差异条数）与基线逐项相同；diff 只含搬运与转发。
