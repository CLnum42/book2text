# `library` 切片定稿：归属清单（2026-10-29）

**性质**：这是 `view-library` 迁入模块前的**定稿依据**。所有"搬什么、留什么、注入什么、谁不归它"以本表为准。
**形态**：散落多簇（5 簇，2549–15602 行之间）→ 按**调用闭包**收集，不按行区间（§22 第 6 条）。

## 0. 一句话结论

闭包 **30 个函数 / 639 行**，但**只有 371 行真的属于这个视图**：

| 栏 | 函数 | 行数 | 占比 |
|---|---|---|---|
| **能搬** | 17 | **371** | 58% |
| **要留**（外壳拥有，只是被它调用） | 7 | **92** | 14% |
| **要注入** | 28 个接缝 | — | — |
| **不属于 library** | **6** | **176** | **28%** |

**28% 的粘合剂是"同一个提示元素"**——`#library-error` / `#library-warning` 恰好在目录页的 DOM 里，
六条任务包 / 备份 / 重跑流程因此被吸进了这个闭包。**DOM 挨着，不代表逻辑是一家。**

## 1. 能搬（17 个 / 371 行）

| 函数 | 行 | 备注 |
|---|---|---|
| `renderProjectList` | 94 | 项目卡列表（含 `progressRow` / `timeAgo` 等） |
| `openProject` | 70 | **唯一一个写跨视图状态的**：`pagesMarginOn` / `pagesOverlayOn` / `pageZoomTouched` → 走 setter 注入 |
| `createProjectFromFile` | 43 | 上传建项目 + 进度条 |
| `showLockConflict` | 32 | 项目锁冲突提示 |
| `deleteProject` | 27 | |
| `progressRow` | 24 | |
| `timeAgo` | 13 | 闭包里 0 个外部调用者 |
| `lockStateText` | 11 | |
| `recognitionExtra` / `reviewExtra` | 9 / 9 | 项目卡上的进度角标 |
| `lockStampText` | 7 | |
| `lastPositionText` | 7 | |
| `progressPercent` | 6 | |
| `currentProjectName` | 6 | |
| `lockSourceText` | 6 | |
| `lockSpanText` | 4 | |
| `ratioText` | 3 | |

**注意**：17 个里**只有 4 个名字带 library/Project**（`renderProjectList` / `openProject` / `createProjectFromFile` / `deleteProject`），
**另外 13 个名字里一个都没有**——这是 §22 第 6 条"名字匹配会漏"的直接证据（19 个新增、0 个前缀匹配）。

## 2. 要留（7 个 / 92 行，住在 `app.js`，由模块经注入调用）

| 函数 | 行 | 为什么留 |
|---|---|---|
| `closeProject` | 31 | 写 `currentProject` / `workflowStep` + `showView` → **项目生命周期归外壳** |
| `loadLibrary` | 14 | boot 调它（3 个组外调用者）→ 外壳入口 |
| `resumeLastPosition` | 15 | 纯路由（`showView`） |
| `openPageSetup` | 10 | 纯路由（`showView`） |
| `loadPageMarginPreference` | 7 | **写的是 pages 的状态** |
| `loadPageOverlayPreference` | 8 | 同上 |
| `loadReviewMarginPreference` | 7 | **写的是审校左栏的状态** |

**没有一条的名字是"library 私有"的。** 三个 `load*Preference` 尤其不能搬——搬进去就变成
"目录页管着别的视图的偏好"。

## 3. 要注入（28 个接缝）

分三类，落盘时按类处理：

- **共享常量**：`BLOCK_TYPE_LABELS`、`PAGE_TYPE_*`、`RECOGNITION_*`、`WORKFLOW_FILTERS` …
- **仍留 app.js 的叶子**：`showError`、`showNoticeBar`、`apiJson`、`openModal`/`closeModal`、
  `loadTasks`、`loadFinishSummary`、`loadSetupSuggestions`、`applyProjectSettings`、`fillDefinitionList`、
  `loadAutoApplyStatus`、`closePageDetail`、`closeTaskDrawer` …
- **跨视图状态 setter**（只此一处）：`setPagesMarginOn` / `setPagesOverlayOn` / `setPageZoomTouched`
  —— **这三个状态归 `pages`，library 只是写入方**（写进模块头，防止以后被认成 library 的）。

## 4. 不属于 library（6 个 / 176 行）

| 函数 | 行 | 真实归属 |
|---|---|---|
| `applyPackageMode` | 61 | 任务包批量导入 |
- |
| `restoreSelectedBackup` | 33 | 备份还原 |
| `rerunAuxiliary` | 24 | 第二引擎重跑 |
| `openPackageFile` | 24 | 任务包导入 |
| `loadPackageResults` | 23 | 任务包结果 |
| `downloadResultPackage` | 11 | 任务包下载 |

**去向（必须写明，否则两个月后会有人把它们塞进 library）**：
它们**留在 `app.js`**，成为"外壳里的任务包 / 备份 / 重跑流程"，只把"往目录页写一句话"
改成调 **`LibraryView.notify({ kind, text })`**。

**所以 `notify` 不是可选的好设计，是这 176 行的唯一出口**——没有它，这六条只能继续直接改 DOM，
也就是 R3 违规的源头。

## 5. 接口（§20.8 / §20.6 已签）

```js
window.LibraryView = { init, enter, notify };   // 3 个
```

- `notify({ kind, text })` —— 5 个外壳流程调（导入完成/失败、还原、重跑）；**写隐藏 DOM**；
  **`enter()` 不许清空 notice**（§22.8），只有 library 自己的操作能覆盖；
  library 自己那 5 个函数**直接调模块内部函数**，不走 `notify`。
- `enter()` —— 用注入的 getter 现取；**不许清空 notice**。

## 6. 验收（§22 + §22.7）

1. **逐字节**：搬走的 17 个函数**全量**过"正变换 + 逆变换"；改写处单列并锁定。
2. **闭包清单对账**：模块里的函数名 × 数量与"能搬 17 个"逐条对上——**散落集合漏了看不出来**（§22 第 6 条）。
3. **账对上**：`app.js` 减 N（≤371 + 转发行）+ 模块增 M，差额逐条列。
4. **⑦ 死导出检查**：`init` / `enter` / `notify` 各数一次调用点，0 就补或删。
5. **e2e（QA 已写，`cf035b7`）**：A 跨视图存活（锁文案）+ B 自己的操作能覆盖；
   负向自检证明它会红。**T6 修完（`032d7cb`）之后 B 可从 warning 扩到 error。**
6. **先跑完整验收再提交**。

## 7. 从这一刀学到、要带去 `pages` 的两件事

1. **归属分析要在估工期之前做，不是搬之前。** "2,637 行"是**围栏半径**，不是归属。
   library 的 639 行里 28% 不属于它——`pages` 的 2,637 行里有多少，**现在不知道**。
2. **归属分析本身是一项新成本**，估 `pages` 的 2.2× 时要把它算进去；
   同时 **2.2× 可能偏高**，因为真实搬移量显著小于围栏半径。
