# `library` 切片 · 搬前读数（干跑读数，一行一个数 + 出处命令）

> 规矩（Chief 2026-10-29）：**干跑读数必须落成文件，不许只在对话里。** 每个数后面跟产生它的命令。

## 1. 搬什么

| 数 | 值 | 出处 |
|---|---|---|
| 能搬函数 | **17 个** | `library-slice.md` §1（闭包四栏） |
| 能搬行数 | **371 行** | 逐个 `grep -n '^function <name>'` 取区间求和 |
| 注入映射条数 | **57 条** | `evidence/library/rules.py` 的 `IDENT` 长度 |

```
python3 -c "import importlib.util;spec=importlib.util.spec_from_file_location('r','docs/refactor/evidence/library/rules.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);print(len(m.IDENT), len(m.MOVERS))"
→ 57 17
```

## 2. 必须归零的 DOM 字面量（按 id 集合，不按前缀）

| 数 | 值 | 出处 |
|---|---|---|
| `view-library` 子树 id | **9 个** | 从 `index.html` 第 56–77 行抽 `id="…"` |
| `app.js` 仍引用 | **6 个 id / 24 处** | 同上集合逐个在 app.js 里查 |
| 其中外壳侧写点 | **10 处** | 按所属函数分组统计（见下） |
| 其中随 17 个函数搬走 | **8 处** |  |
| **验收口径** | **19 处 → 0** | 按「处」不按「函数」 |

```
create-progress 2 · library-empty 1 · library-error 13 · library-path 1
library-warning 6 · project-list 1     = 24 处
不带 library- 前缀的两个：project-list / create-progress（按前缀 grep 会漏）
```

外壳侧 7 个函数 / 10 处（搬不动，但必须改调 `LibraryView.notify`）：

```
loadLibrary 3 · closeProject 1 · openPackageFile 2 · applyPackageMode 1
loadPackageResults 1 · restoreSelectedBackup 1 · rerunAuxiliary 1
```

**「要留」不等于「可以继续写该视图的 DOM」**（§13.4）。

## 3. 落盘后要对的四个数

| 项 | 搬前 | 落地后应为 |
|---|---|---|
| `app.js` | **16,161 行** | ≈ 15,796（±20）；**减 <300 判"复制不是搬"，停** |
| `library-view.js` | 不存在 | ≈ 371 + 骨架 |
| 导出面 | 0 | `init` / `enter` / `notify` 恰 **3** |
| 名字对集 | — | 逐个 `grep -c "function <name>("`：app.js 0 / 模块 1 |

## 4. 接口与注入（集合，不报数字）

- 导出：`init(deps)` / `enter()` / `notify({kind, text})`
- 注入函数集合（28）：`apiJson` `showError` `showView→navigate` `closeModal` `openModal` `syncWorkflowSteps`
  `closeFinishPanel` `updateFinishChips` `stopTaskPolling` `closePageDetail` `closeTaskDrawer` `loadTasks`
  `loadSetupSuggestions` `loadAutoApplyStatus` `loadFinishSummary` `applyProjectSettings` `fillDefinitionList`
  `renderPages` `renderRecognitionSettings` `refreshPageStates` `refreshProject` `schedulePageVisibility`
  `queueAfterSteps` `saveBlob` `setSaveState` `pageMarginStorageKey` `pageOverlayStorageKey` `reviewMarginStorageKey`
- 注入常量集合：`currentProject→getProject()` `libraryProjects` `lockConflictTarget` `workflowStep` `workflowStepPinned`
  `projectSummary` `projectExports` `workflowSummary` `workflowConfirmationCounts` `pendingPageNos` `pendingPageCount`
  `setupSuggestions` `setupSuggestionsLoaded` `marginSuggestion` `finishSummary` `finishSummaryProject`
  `reviewMarginOn` `reviewBlockFilter` `backupSelected` `lastStepPanelKey` `workflowByPageId` `token` `LAST_VIEW_LABELS`
- **不进 deps**：`el`（模块自带一行）

## 5. 自检（脚本里写死，不靠人看）

1. **残余接缝标识符 = 0**（变换后再抽一遍标识符，任何 app.js 顶层符号裸着就停）
2. **`app.js` 减行 ≥ 300**，否则停（复制不是搬）
3. 17 个函数逐个"正变换命中 1 次 + 逆变换还原"
