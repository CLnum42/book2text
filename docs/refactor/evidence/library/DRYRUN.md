# `library` 切片 · 搬前读数（干跑读数，一行一个数 + 出处命令）

> 规矩（Chief 2026-10-29）：**干跑读数必须落成文件，不许只在对话里。** 每个数后面跟产生它的命令。
>
> **⚠ 2026-10-29 裁定 B 之后本文件的 17 / 371 已不是这一刀的范围**：锁冲突整块（5 函数 / 60 行）
> 留外壳 → 实际搬 **12 个 / 311 行**，`app.js` 净减 291。本文件保留为**搬前读数**（它当时是对的），
> 落地后的读数与逐条理由见 `../../library-slice.md` §11。

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
| 其中 error/warning 写点 | **19 处**（error 13 + warning 6） |
| └ 随 17 个函数搬走 | **9 处**：`deleteProject` 2 · `createProjectFromFile` 3 · `openProject` 4 |
| └ 留在外壳，必须改调 `notify` | **10 处**：`loadLibrary` 3 · `closeProject` 1 · `openPackageFile` 2 · `applyPackageMode` 1 · `loadPackageResults` 1 · `restoreSelectedBackup` 1 · `rerunAuxiliary` 1 |
| 另外 5 处字面量（非写点） | `create-progress` 2（随 `createProjectFromFile` 搬）· `library-empty` 1 + `project-list` 1（随 `renderProjectList` 搬）· `library-path` 1（`loadLibrary`，留） |
| **验收口径** | 字面量 **24 → 0**（R3）；写点 **19 → 0**（notify 改齐） |

```
create-progress 2 · library-empty 1 · library-error 13 · library-path 1
library-warning 6 · project-list 1     = 24 处
不带 library- 前缀的两个：project-list / create-progress（按前缀 grep 会漏）
```

**按函数归属（精确函数边界量法，命令见文末）**：

```
createProjectFromFile 5 · loadLibrary 4 · openProject 4 · deleteProject 2
openPackageFile 2 · renderProjectList 2 · closeProject 1 · applyPackageMode 1
loadPackageResults 1 · restoreSelectedBackup 1 · rerunAuxiliary 1   = 24
```

**「要留」不等于「可以继续写该视图的 DOM」**（§13.4）：`loadLibrary` / `closeProject` 搬不动，但它们写的仍是 library 的 DOM，必须改调 `notify`。

**出处命令**（逐处归因，精确到函数边界）：
`python3 - <<'PY'` 读 `app.js`，对每个 id 找含 `"id"` 的行，再按「列 0 `function` → 第一个列 0 `}`」求所属函数。

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
