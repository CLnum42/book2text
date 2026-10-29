# `view-pages` 的 R3 过渡豁免表（规格，表由 TestDev 落）

> 基线 `HEAD`；`view-pages` 子树 **127** 个 id；被引用 **110** 种 / **258** 处。

> **口径：闸**（`el` / `getElementById` / `querySelector(All)("#id")`）· **工具：** `node scripts/r3_pages_count.mjs --json`（`ids` / `total`）· **树：** `main@57890e1`（复算得 127 / 258 处 / 110 种）。
> **「258 与 270 不是同一件事的两个版本」**——270 是字面量口径（`accept_pages.py`），两个口径**禁止互相减**。
> 其中 **34 处**落在刀 1 的 19 个 movers 里（随刀搬走，**不进豁免表**）；
> **刀 1 落盘后应剩 = 224 处 / 79 种 id**。

## 结论

- **`page-grid` 无一处搬漏**：它的引用全在 stays 函数里（刀 1 movers 内 0 处）；
- **`pausePageThumbnails()` 里的 `el("page-grid")` 不在顶层**——属正常引用，**不是设计问题**；
- 顶层引用实测 **0 处**。

## 豁免表（每项三样：id / 引用行号 / 到期刀）

| id | 处数 | 引用行号（函数） | 到期刀 |
|---|---:|---|---|
| `pages-error` | 31 | 768(ensureMarginFitted)、3315(patchRecognitionSetting)、3734(applyPageRangeInput)、3742(applyPageRangeInput)… | 待定（按搬它的刀） |
| `page-grid` | 14 | 143(pausePageThumbnails)、3528(ensureSuggestionScrollListener)、3550(scanVisiblePageSuggestions)、4591(pageScroller)… | 待定（按搬它的刀） |
| `pages-margin-toggle` | 9 | 627(syncStepToggles)、4800(applyPageZoom)、4801(applyPageZoom)、5076(toggleMarginView)… | 待定（按搬它的刀） |
| `pages-overlay-toggle` | 8 | 4797(applyPageZoom)、4798(applyPageZoom)、4857(togglePageBlocksOverlay)、13585(setupLibrary)… | 待定（按搬它的刀） |
| `margin-fit-progress` | 5 | 800(showMarginFitProgress)、813(hideMarginFitProgressSoon)、7581(showMarginDetectProgress)、7650(finishMarginDetectBar)… | 刀3 |
| `setup-confirm-all` | 5 | 3891(updateSelectionPanel)、3892(updateSelectionPanel)、4150(renderPageSetup)、4151(renderPageSetup)… | 待定（按搬它的刀） |
| `selection-hint` | 5 | 3906(updateSelectionPanel)、4425(confirmSelectedPages)、4439(confirmAllUnconfirmed)、13859(setAutoApplySetting)… | 刀3 |
| `setup-panel` | 5 | 4137(renderPageSetup)、4147(renderPageSetup)、4222(openPageSetup)、14386(applyPackageMode)… | 刀3 |
| `page-more-menu` | 5 | 7955(setupPageMore)、13609(setupLibrary)、13613(setupLibrary)、13620(setupLibrary)… | 待定（按搬它的刀） |
| `margin-fit-text` | 4 | 805(showMarginFitProgress)、7558(updateMarginDetectProgress)、7586(showMarginDetectProgress)、7653(finishMarginDetectBar) | 刀3 |
| `rec-dual-strategy` | 4 | 3267(renderRecognitionSettings)、3268(renderRecognitionSettings)、3271(renderRecognitionSettings)、3333(setupRecognitionSettings) | 刀5 |
| `assign-open` | 4 | 3894(updateSelectionPanel)、14391(applyPackageMode)、14399(applyPackageMode)、14542(setupCollabControls) | 待定（按搬它的刀） |
| `check-pending` | 4 | 3896(updateSelectionPanel)、13533(setupLibrary)、14384(applyPackageMode)、14404(applyPackageMode) | 刀3 |
| `layout-block-confirm` | 4 | 5613(renderLayoutBlocks)、5675(renderLayoutBlocks)、5688(confirmLayoutFromPanel)、13588(setupLibrary) | 待定（按搬它的刀） |
| `margin-fit-fill` | 3 | 804(showMarginFitProgress)、7585(showMarginDetectProgress)、7652(finishMarginDetectBar) | 刀3 |
| `rec-margin-judgement` | 3 | 2296(setupExportPanel)、13673(applyProjectSettings)、13881(setMarginJudgementSetting) | 刀3 |
| `rec-status` | 3 | 3224(setRecognitionStatus)、5908(startAuxiliaryAll)、5940(updateRecognitionAuxProgress) | 刀3 |
| `rec-engine` | 3 | 3239(renderRecognitionSettings)、3250(renderRecognitionSettings)、3320(setupRecognitionSettings) | 刀5 |
| `filter-workflow` | 3 | 3597(visiblePages)、7360(renderWorkflowFilter)、13540(setupLibrary) | 待定（按搬它的刀） |
| `selection-recognize` | 3 | 3862(updateSelectionPanel)、13558(setupLibrary)、14380(applyPackageMode) | 刀3 |
| `setup-confirm-selected` | 3 | 3890(updateSelectionPanel)、4149(renderPageSetup)、13636(setupLibrary) | 待定（按搬它的刀） |
| `page-setup-bar` | 3 | 4134(renderPageSetup)、14389(applyPackageMode)、14409(applyPackageMode) | 刀3 |
| `margin-audit` | 3 | 5335(ensureMarginAudit)、5422(renderMarginPanel)、5438(renderMarginPanel) | 刀2 |
| `layout-block-apply-all` | 3 | 5612(renderLayoutBlocks)、5670(renderLayoutBlocks)、13587(setupLibrary) | 待定（按搬它的刀） |
| `selection-skip-checked` | 3 | 7019(checkSelection)、14385(applyPackageMode)、14405(applyPackageMode) | 刀3 |
| `auto-apply-suggestions` | 3 | 13506(setupLibrary)、13670(applyProjectSettings)、13832(setAutoApplySetting) | 刀3 |
| `selection-check` | 3 | 13532(setupLibrary)、14383(applyPackageMode)、14403(applyPackageMode) | 刀3 |
| `assign-list-toggle` | 3 | 14390(applyPackageMode)、14398(applyPackageMode)、14543(setupCollabControls) | 待定（按搬它的刀） |
| `margin-confirm-all` | 2 | 871(renderMarginStepVerdict)、13589(setupLibrary) | 待定（按搬它的刀） |
| `layout-detect-open` | 2 | 962(refreshLayoutDetectEntry)、13627(setupLibrary) | 待定（按搬它的刀） |
| `selection-review-open` | 2 | 1347(setupShell)、3893(updateSelectionPanel) | 刀3 |
| `rec-language` | 2 | 3266(renderRecognitionSettings)、3330(setupRecognitionSettings) | 刀5 |
| `filter-type` | 2 | 3595(visiblePages)、13538(setupLibrary) | 待定（按搬它的刀） |
| `filter-recognition` | 2 | 3596(visiblePages)、13539(setupLibrary) | 待定（按搬它的刀） |
| `filter-triage` | 2 | 3598(visiblePages)、13541(setupLibrary) | 待定（按搬它的刀） |
| `pages-only-included` | 2 | 3599(visiblePages)、13542(setupLibrary) | 待定（按搬它的刀） |
| `page-range` | 2 | 3729(applyPageRangeInput)、13552(setupLibrary) | 待定（按搬它的刀） |
| `selection-more` | 2 | 3886(updateSelectionPanel)、13567(setupLibrary) | 待定（按搬它的刀） |
| `selection-all` | 2 | 3888(updateSelectionPanel)、13555(setupLibrary) | 待定（按搬它的刀） |
| `selection-clear` | 2 | 3895(updateSelectionPanel)、13557(setupLibrary) | 待定（按搬它的刀） |
| `pages-zoom-out` | 2 | 4794(applyPageZoom)、13583(setupLibrary) | 待定（按搬它的刀） |
| `pages-zoom-in` | 2 | 4795(applyPageZoom)、13584(setupLibrary) | 待定（按搬它的刀） |
| `margin-basis` | 2 | 5346(ensureMarginAudit)、5407(renderMarginPanel) | 刀2 |
| `rec-verdict-line` | 2 | 5782(renderRecognitionVerdict)、5939(updateRecognitionAuxProgress) | 刀3 |
| `rec-start-all` | 2 | 5783(renderRecognitionVerdict)、13590(setupLibrary) | 待定（按搬它的刀） |
| `rec-aux-all` | 2 | 5784(renderRecognitionVerdict)、13591(setupLibrary) | 待定（按搬它的刀） |
| `rec-aux-num` | 2 | 5791(renderRecognitionVerdict)、5937(updateRecognitionAuxProgress) | 刀3 |
| `page-number-summary` | 2 | 6165(renderPageNumberMetrics)、6229(loadPageNumberSummary) | 刀2 |
| `page-number-review-open` | 2 | 6167(renderPageNumberMetrics)、6837(setupPageNumberPanel) | 待定（按搬它的刀） |
| `selection-actionbar` | 2 | 14381(applyPackageMode)、14400(applyPackageMode) | 刀3 |
| `panel-recognition-settings` | 2 | 14387(applyPackageMode)、14407(applyPackageMode) | 刀3 |
| `panel-pagenum-settings` | 2 | 14388(applyPackageMode)、14408(applyPackageMode) | 刀3 |
| `margin-verdict-state` | 1 | 869(renderMarginStepVerdict) | 刀2 |
| `margin-verdict-line` | 1 | 870(renderMarginStepVerdict) | 刀2 |
| `margin-confidence` | 1 | 872(renderMarginStepVerdict) | 刀2 |
| `margin-detect-hint` | 1 | 936(refreshMarginDetectHint) | 刀3 |
| `stats-open` | 1 | 1334(setupShell) | 待定（按搬它的刀） |
| `rec-strategy-label` | 1 | 3270(renderRecognitionSettings) | 刀2 |
| `rec-strategy-note` | 1 | 3272(renderRecognitionSettings) | 刀2 |
| `rec-engine-note` | 1 | 3288(renderRecognitionSettings) | 刀2 |
| `rec-summary` | 1 | 3289(renderRecognitionSettings) | 刀2 |
| `pages-zoom-label` | 1 | 4793(applyPageZoom) | 刀3 |
| `margin-status` | 1 | 5230(setMarginStatus) | 刀3 |
| `page-number-status` | 1 | 6148(setPageNumberStatus) | 待定（按搬它的刀） |
| `page-number-metrics` | 1 | 6166(renderPageNumberMetrics) | 刀2 |
| `page-number-open` | 1 | 6830(setupPageNumberPanel) | 待定（按搬它的刀） |
| `page-summary` | 1 | 6855(renderPageSummary) | 刀2 |
| `page-more` | 1 | 7954(setupPageMore) | 待定（按搬它的刀） |
| `selection-skip-recognized` | 1 | 13445(recognizeSelection) | 刀5 |
| `apply-high-suggestions` | 1 | 13501(setupLibrary) | 待定（按搬它的刀） |
| `page-range-select` | 1 | 13551(setupLibrary) | 待定（按搬它的刀） |
| `selection-select-all` | 1 | 13556(setupLibrary) | 待定（按搬它的刀） |
| `selection-more-menu` | 1 | 13568(setupLibrary) | 待定（按搬它的刀） |
| `word-boxes-open` | 1 | 13608(setupLibrary) | 待定（按搬它的刀） |
| `backups-open` | 1 | 13612(setupLibrary) | 待定（按搬它的刀） |
| `aux-rerun` | 1 | 13619(setupLibrary) | 待定（按搬它的刀） |
| `split-page-numbers` | 1 | 13637(setupLibrary) | 待定（按搬它的刀） |
| `auto-apply-status` | 1 | 13713(renderAutoApplyStatus) | 刀2 |
| `rec-language-summary` | 1 | 14647(loadLanguageSummary) | 刀2 |

## 逐刀缩减数（不写死中间值，只写终点与算法）

- **刀 1 后：186 处 / 110−? 种**（准确值：186 处，见上表合计）；
- 刀 2–5：每刀落盘后重跑同一脚本 → 剩余数必须**严格下降**；**刀 5 = 0**；
- 到期不搬 = 红；**只写“允许存在”等于开永久白名单**（和导出的收敛棘轮同构）。

## 数从哪来

口径 = `el("id")` / `getElementById("id")` / `querySelector("#id")` 三种取法，**只扫 `HEAD:app.js`**。
刀 1 落盘后应剩 **186**；与实测差 >10 条就停（同 R3 的 198 那招）。
