# 刀 9 导出键账（逐键列名）—— **本表是事实清单；裁定见 `docs/refactor/pages/export-ratchet.md`**

> **Architect 已裁定（2026-10-30）**：导出键分**三类**，不是一个数——
> **L** lifecycle（`init`/`enter`/`refresh`，固定 3 个名字）· **T** transitional（带 `death: 刀N`，到点键与转发器都必须不存在）·
> **C** capability（触发者在别的域，**不写死期**，登记 `callers` + `Capability-Reason`；上限 = 清册条数，不拍数字）。
>
> 旧账里的两个数**作废**，以裁定为准：
>
> ```
> 39（= 61 − 22）  ✗  22 来自刀5 图的减法，从来没有"哪 22 个"的名单
> 3（终态）        ✗  reading-view 终态是 5 键（init/enter/getCurrent/reload/toggleFollow），不是 3
> ```
>
> 裁定重推的曲线（每个数的来历只有两种动作：删 0 调用点的键 / 搬 n 个调用点）：
>
> ```
> 今天 57 = 8 死T + 36 活T + 13 C
> 刀7  58 = 8 死T + 36 活T + 14 C   （+1 C：recognizePage）
> 刀8  61 = 8 死T + 36 活T + 17 C   （+3 C：setPackageModeChrome / syncProjectSettings / setSelectionHint）
> 刀9a 53 =            36 活T + 17 C （删 8 个 0 调用点的死 T：键 + 转发器一起删）
> 刀9b 19 =                    19 C  （搬 78 个调用点 / 41 个宿主 + 建 enter / refresh）
> 刀10 19                            （冻结清册 + 四条机检）
> ```
>
> 本文件保留的价值：**57 键 × 类别 / 死期 / app.js 调用点 / 模块引用** 四列是实测事实；
> 8 个死 T、39 个活 T、13 个 C 的**名单以裁定文档 §三/§四/§六 为准**（本表是它的原始数据来源之一）。

> **口径**：`VIEW_EXPORTS` 的 pages 侧 57 个键（`main@3e42894` 实测）。每键三列：
> **类别**（哪一刀新增的）· **app.js 调用点**（行号:宿主函数）· **模块引用**（`injected.<键>` 在 `*-view.js` 里出现次数）。
> **目标已改**：不再有「61 → 22 死 39 键」这个说法（见裁定 §五）；现在是 8 死T 立即删、36 活T 随宿主搬、13 C 进清册。
>
> 说明：`recognizePage`（刀 7，已落盘）与 3 个能力键（刀 8，未落盘）在本表里标「待落 / 待重新量」。

## 一、全表（57 键）

| 键 | 类别 | app.js 调用点 | 模块引用 |
|---|---|---|---|
| `init` | 老键 | boot:13065 | 0 |
| `ensureMarginFitted` | 老键 | ensureMarginFitted:603 | 0 |
| `loadLayoutBlocks` | 老键 | loadLayoutBlocks:4164 | 0 |
| `loadSetupSuggestions` | 老键 | loadSetupSuggestions:3531 | 0 |
| `refreshRecognizedPages` | 老键 | refreshRecognizedPages:5485 | 0 |
| `reloadProjectPages` | 老键 | reloadProjectPages:5061 | 0 |
| `renderLayoutBlocks` | 老键 | renderLayoutBlocks:4166 | 0 |
| `renderMarginPanel` | 老键 | renderMarginPanel:4131 | 0 |
| `renderPageSetup` | 老键 | renderPageSetup:3508 | 0 |
| `renderPages` | 老键 | renderPages:4932 | 0 |
| `renderRecognitionStatus` | 老键 | renderRecognitionStatus:4178 | 0 |
| `renderRecognitionVerdict` | 老键 | renderRecognitionVerdict:4186 | 0 |
| `renderSuggestionPanel` | 老键 | renderSuggestionPanel:3555 | 0 |
| `renderTypePicker` | 老键 | renderTypePicker:3552 | 0 |
| `savePageMargin` | 老键 | savePageMargin:4075 | 0 |
| `syncPageStates` | 老键 | syncPageStates:4940 | 0 |
| `undoMarginEdit` | 老键 | undoMarginEdit:4258 | 0 |
| `updateMarginDetectProgress` | 老键 | updateMarginDetectProgress:5721 | 0 |
| `updatePageVisibility` | 老键 | updatePageVisibility:3731 | 0 |
| `updateSelectionPanel` | 老键 | updateSelectionPanel:3293 | 0 |
| `loadFinishSummary` | 老键 | loadFinishSummary:9799 | 6 |
| `loadLanguageSummary` | 老键 | loadLanguageSummary:12610 | 0 |
| `loadPageNumberSummary` | 老键 | loadPageNumberSummary:4326 | 0 |
| `refreshLayoutDetectEntry` | 老键 | refreshLayoutDetectEntry:694 | 1 |
| `refreshMarginDetectHint` | 老键 | refreshMarginDetectHint:691 | 3 |
| `refreshMarginTiles` | 老键 | refreshMarginTiles:4062 | 2 |
| `renderAutoApplyStatus` | 老键 | renderAutoApplyStatus:11726 | 0 |
| `renderMarginStepVerdict` | 老键 | renderMarginStepVerdict:677 | 4 |
| `renderPageNumberMetrics` | 老键 | renderPageNumberMetrics:4306 | 0 |
| `renderRecognitionSettings` | 老键 | renderRecognitionSettings:2964 | 1 |
| `renderStepPanels` | 老键 | renderStepPanels:551 | 1 |
| `renderWorkflowFilter` | 老键 | renderWorkflowFilter:5568 | 0 |
| `updateRecognitionAuxProgress` | 老键 | updateRecognitionAuxProgress:4211 | 0 |
| `applyPageZoom` | 老键 | applyPageZoom:3759 | 0 |
| `confirmAllUnconfirmed` | 老键 | confirmAllUnconfirmed:3560 | 0 |
| `checkSelection` | 刀5 转发 | checkSelection:5058 | 0 |
| `finishMarginDetectBar` | 刀5 转发 | finishMarginDetectBar:5798 | 0 |
| `forgetAllPageBlocks` | 刀5 转发 | forgetAllPageBlocks:3684 | 0 |
| `forgetAllPageSuggestions` | 刀5 转发 | forgetAllPageSuggestions:3040 | 0 |
| `pageScroller` | 刀5 转发 | pageScroller:3700 | 0 |
| `pausePageThumbnails` | 刀5 转发 | pausePageThumbnails:142 | 0 |
| `pumpOverlayRender` | 刀5 转发 | pumpOverlayRender:3793 | 0 |
| `queueOverlayRender` | 刀5 转发 | queueOverlayRender:3781 | 0 |
| `rerunAuxiliary` | 刀5 转发 | rerunAuxiliary:12618 | 0 |
| `scanVisiblePageSuggestions` | 刀5 转发 | scanVisiblePageSuggestions:3165 | 0 |
| `setMarginStatus` | 刀5 转发 | setMarginStatus:4066 | 0 |
| `setPageNumberStatus` | 刀5 转发 | setPageNumberStatus:4301 | 0 |
| `showMarginDetectProgress` | 刀5 转发 | showMarginDetectProgress:5736 | 0 |
| `startLayoutDetection` | 刀5 转发 | startLayoutDetection:5577 | 0 |
| `visiblePages` | 刀5 转发 | visiblePages:3172 | 0 |
| `openPageSetup` | 刀5 转发 | openPageSetup:3529 | 1 |
| `toggleMarginView` | 刀5 转发 | toggleMarginView:3936 | 2 |
| `togglePageBlocksOverlay` | 刀5 转发 | togglePageBlocksOverlay:3773 | 2 |
| `syncToolbarToggles` | 刀6 新键 | boot:13011、boot:13341、boot:13362、boot:13444 | 4 |
| `showPagesError` | 刀6 新键 | finishRevokeAutoPass:11368 | 0 |
| `pagesErrorMessage` | 刀6 新键 | startLayoutDetectFromDialog:5703 | 0 |
| `setMarginJudgementCheckbox` | 刀6 新键 | setMarginJudgementSetting:11840 | 0 |
## 二、旧账的 39 键怎么来（**已作废**，保留只作历史）

```
18  刀5 转发键（逐个见上表「刀5 转发」）
 4  刀6 新键：syncToolbarToggles · showPagesError · pagesErrorMessage · setMarginJudgementCheckbox
 3  刀8 能力键：setPackageModeChrome · syncProjectSettings · setSelectionHint
 1  刀7：recognizePage
13  老键里的候选 = 61 − 22 − 18 − 4 − 3 − 1 = 13
    （**逐个是谁取决于刀 9 保留哪 22 个键**，而那 22 个要等刀 9 的图；本表先把 57 个键的
     调用者摆出来，选 22 个的时候有据可依，不用拍）
39  合计 = 61 − 22（**待定**：22 这个点本身已无推导依据）
```

## 三、我当时报的「8 个死不了的键」——**这次裁定的起点**（现按 T/C 重新分类）

判据：**死期取决于它的 app.js 调用者会不会在刀 9 搬走**。调用者是留在外壳的编排函数 → 那键就死不了。

```
setPackageModeChrome      ← applyPackageMode      （刀 8 之后本刀**永远留外壳**）
syncProjectSettings       ← applyProjectSettings  （同上）
setSelectionHint          ← applySplitBatch       （同上）
showPagesError            ← finishRevokeAutoPass  （外壳函数，未排任何一刀搬迁）
pagesErrorMessage         ← startLayoutDetectFromDialog（同上）
setMarginJudgementCheckbox← setMarginJudgementSetting（同上）
syncToolbarToggles        ← boot 的 4 个 deps 行    （boot 主体永留，4 行注入也不会自己消失）
recognizePage             ← buildTile:3394 · setupLibrary:11657（两个都是永留外壳的函数）
```

⇒ 这 8 个键不该有死期，它们是 **C（capability）**。a/b/c 三条候选路**已被裁定取代**：
裁定选了更根本的做法——把"两类混成一个数"拆成 **L / T / C 三类 + 清册**。
C 的完整清册（13 个）见 `export-ratchet.md §四`。

## 四、刀 9 的入场条件（本表的前提）

```
① TestDev 把 20 个「活着但写着死期」的键重算成刀 9 + 补「到点未死」机检（数据在 tests/js/boundary.test.mjs，非本文件）
② 上述 8 个"死不了的键"先定出路（a/b/c），否则刀 9 当天撞墙
③ 刀 7 / 刀 8 落盘后重量一遍本表（`recognizePage` 与 3 个能力键那时才有真实调用点）
```
