# `library` 切片定稿：归属清单（2026-10-29）

**性质**：这是 `view-library` 迁入模块前的**定稿依据**。所有"搬什么、留什么、注入什么、谁不归它"以本表为准。
**形态**：散落多簇（5 簇，2549–15602 行之间）→ 按**调用闭包**收集，不按行区间（§22 第 6 条）。

## 0. 一句话结论

闭包 **30 个函数 / 639 行**，但**只有 371 行真的属于这个视图**：

| 栏 | 函数 | 行数 | 占比 |
|---|---|---|---|
| **能搬** | 17 → **12** | **371 → 311** | 58% → 49% |
| **要留**（外壳拥有，只是被它调用） | 7 → **12** | **92 → 152** | 14% → 24% |
| **要注入** | 28 个接缝 | — | — |
| **不属于 library** | **6** | **176** | **28%** |

> **2026-10-29 裁定 B（Chief）**：锁冲突整块（`showLockConflict` + 4 个 lock 文案，5 函数 / 60 行）
> **留外壳**——它画的是全局 modal（`#lock-conflict-*` 不属于任何 `<section>`），搬进模块必撞 R3；
> 模块改调 `injected.showLockConflict`。所以能搬 17→12、371→311；"要留"相应 7→12、92→152。
> 闭包总数不变（30 函数 / 639 行 = 311 + 152 + 176）。详见 §11。

**28% 的粘合剂是"同一个提示元素"**——`#library-error` / `#library-warning` 恰好在目录页的 DOM 里，
六条任务包 / 备份 / 重跑流程因此被吸进了这个闭包。**DOM 挨着，不代表逻辑是一家。**

## 1. 能搬（原 17 个 / 371 行；裁定 B 后 **12 个 / 311 行**）

| 函数 | 行 | 备注 |
|---|---|---|
| `renderProjectList` | 94 | 项目卡列表（含 `progressRow` / `timeAgo` 等） |
| `openProject` | 70 | **唯一一个写跨视图状态的**：`pagesMarginOn` / `pagesOverlayOn` / `pageZoomTouched` → 走 setter 注入 |
| `createProjectFromFile` | 43 | 上传建项目 + 进度条（上传接线随它进模块的 `init`） |
| `deleteProject` | 27 | |
| `progressRow` | 24 | |
| `timeAgo` | 13 | 闭包里 0 个外部调用者 |
| `recognitionExtra` / `reviewExtra` | 9 / 9 | 项目卡上的进度角标 |
| `lastPositionText` | 7 | |
| `progressPercent` | 6 | |
| `currentProjectName` | 6 | |
| `ratioText` | 3 | |

**已移出本栏（裁定 B）**：`showLockConflict` 32 / `lockStateText` 11 / `lockStampText` 7 /
`lockSourceText` 6 / `lockSpanText` 4 = **5 个 / 60 行 → 外壳**（画的是全局 modal；模块走注入）。
下面"名字匹配会漏"的统计是按**原 17 个**算的，量的是闭包与名字的关系，不随这一刀的范围变。

**注意：17 个里只有 4 个名字带 library/Project**（`renderProjectList` / `openProject` / `createProjectFromFile` / `deleteProject`），
**另外 13 个名字里一个都没有**。

| 口径 | 数字 |
|---|---|
| 按函数数 | 13 / 17 = **76% 会被名字匹配漏掉** |
| **按行数** | **311 / 371 = 84%** |

**这是 §22 第 6 条"名字匹配会漏"最硬的一组实证**，和"闭包比种子多 19 个、带前缀的 0 个"是同一结论的两个口径：
- 闭包口径：**该进来的 19 个里，靠名字一个都找不到**；
- 行数口径：**会搬的 371 行里，84% 在名字上看不出归属。**

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

## 3. 要注入（28 个接缝函数 + 常量分两类）

### 3.1 接缝函数 → 注入键（落盘时按此写模块头）

```js
// 外壳服务（调一次就走，无状态）
apiJson(8 处调用)          goToWorkflowStep / showView(3)      showError(10)
showNoticeBar?             closeModal(3) / openModal           setSaveState
saveBlob                   queueAfterSteps                     syncWorkflowSteps
refreshPageStates          schedulePageVisibility              refreshProject
closeFinishPanel           updateFinishChips                   stopTaskPolling
closePageDetail            closeTaskDrawer                     loadTasks
loadSetupSuggestions       loadAutoApplyStatus                 loadFinishSummary
applyProjectSettings       fillDefinitionList                  renderPages
renderRecognitionSettings  pageMarginStorageKey / pageOverlayStorageKey / reviewMarginStorageKey
```

**高频的三个（说明它们是真·外壳服务，不是顺手）**：`showError(10)` / `apiJson(8)` / `closeModal(3)`。

### 3.2 常量分两类（**别一律注入**）

| 类 | 常量 | 处理 |
|---|---|---|
| **留外壳，走 getter**（2026-10-29 改判） | `libraryProjects` · `lockConflictTarget` | **不搬**：`libraryProjects` 由外壳的 `loadLibrary()` 写入，而 `loadLibrary` 有 8 个调用点、一半在模块外（`boot` / `closeProject` / `openPackageFile`）→ 按 ⑧「模块不存副本」应**留外壳、模块用 `getLibraryProjects()` 现取**。`lockConflictTarget` 同理 |
| **注入（只读或 get/set）** | `currentProject` → `getProject()`；`workflowStep` · `workflowStepPinned` · `projectSummary` · `projectExports` · `workflowSummary` · `workflowConfirmationCounts` · `pendingPageNos` · `pendingPageCount` · `setupSuggestions` · `setupSuggestionsLoaded` · `marginSuggestion` · `finishSummary` · `finishSummaryProject` · `reviewMarginOn` · `reviewBlockFilter` · `pageZoomTouched` · `pagesMarginOn` · `pagesOverlayOn` · `marginFitTried` · `marginUndoStack` · `backupSelected` · `lastStepPanelKey` · `workflowByPageId` · `token` | 走 getter；有写点的成对给 setter |
| **不进 deps** | `el` | 模块自带一行（§20.4） |

**`pageZoomTouched` / `pagesMarginOn` / `pagesOverlayOn` 三个归 `pages`，library 只是写入方**（写进模块头）。

## 3.3 `notify` 的五个调用点（落地当笔必须一次改齐）

那 6 个"不属于 library"的函数里，**5 个会写提示元素**，它们要在同一笔里改成调 `LibraryView.notify`：

```
openPackageFile     → notify({kind:"error", text})
applyPackageMode    → notify({kind:"error", text})
loadPackageResults  → notify({kind:"error", text})
restoreSelectedBackup → notify({kind:"warning", text})
rerunAuxiliary      → notify({kind:"warning", text})
```

**为什么必须同笔**：模块一落盘，`app.js` 里就不许再出现 `library-*` 字面量（R3）——
**留一处就是当场红**，而且红在"你刚搬完、以为完事"的时刻。

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
window.LibraryView = { init, enter, notify, open };   // 4 个（D-100 完整形态）
```

- `open(projectId, options)` —— **域操作**：打开一个项目。外壳的锁冲突确认 / 任务包打开 /
  备份还原都调它（`confirmLockConflict` / `openPackageFile` / `restoreSelectedBackup`），
  外壳自己不再有 `openProject` 的实现或转发。
- `init(deps)` —— 除了合注入面，还**接管上传接线**（`#new-project-file` 的 `change` →
  `createProjectFromFile`）：上传建项目是目录页的域操作，外壳留着它就会因为写
  `#create-progress` 撞 R3。

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

---

## 8. 搬前基线（2026-10-29，落地后逐项对账；数字只为"对得上"，不是目标）

| 项 | 搬前 |
|---|---|
| `app.js` | **16,161 行** |
| `library-view.js` | **不存在** |
| 导出面 | `ReadingView` 5 · `PreviewView` 2 · `IndexView` 3 · `LibraryView` 0 · `MergeView` 0 |
| 模块文件数 | 3（reading / preview / index） |
| `node tests/js/run.mjs` | 全绿 |
| 能搬行数 | 371（17 函数）· 接缝 28 函数 + 常量两类 |

**预期的落地后读数**：`app.js` ≈ 16,161 − 371 − 转发段；`library-view.js` ≈ 371 + 骨架（文件头 + IIFE + 注入面约 60–80 行）。

**对账方式**：三项必须同时成立才算搬对——① 逐字节 17/17；② 闭包清单 17 个函数名逐条对上；③ 账（`app.js` 减 N ≤ 371 + 转发行，模块增 M，差额逐条列）。

---

## 9. 闭包方法的第三个漏法：**事件处理器**（2026-10-29，开搬前 5 分钟发现）

按 17 个名单逐一取位置时，发现同一段（2549–3096）里还躺着 **6 个函数 / 105 行**不在闭包里：

| 函数 | 行 | 碰的 id |
|---|---:|---|
| `loadTrash` | 42 | `trash-empty` / `trash-error` / `trash-list` |
| `confirmLockConflict` | 27 | `lock-conflict-error` / `lock-conflict-force` |
| `purgeTrashProject` | 17 | `trash-error` |
| `restoreTrashProject` | 10 | `trash-error` |
| `openTrashPanel` | 5 | `trash-error` |
| `closeLockConflict` | 4 | — |

**漏法的两个成因，都是结构性的**：

1. **闭包只到得了"被调用的"，到不了"被绑为事件处理器的"**——这 6 个没有调用者，
   靠 `addEventListener(…, loadTrash)` 或按钮 `onclick` 接上，**调用图里根本不存在这条边**。
2. **它们的 DOM 不在 `view-library` 段里**——`trash-*` / `lock-conflict-*` 在 **modal** 里（不属于任何 `<section>`），
   所以"碰不碰 view 的 id"这个种子判据也抓不到。

**因此 R3 不会强迫它们搬**（modals 不归 `view-library`），它们留在 `app.js` **不违规**。

**决定**：**本刀不含它们**。理由：
- 本刀的证据链是"17 个函数逐字节等价"，**名单一改，证据就要重做**；
- 它们是**另一件事**（锁冲突对话框 + 回收站面板），DOM 独立于目录页；
- 塞进来会让"371 行 → 476 行"且混进 modal 的生命周期，正是 §22 第 6 条要防的"硬塞"。

**记为下一刀**：`library` 第二笔 =「锁冲突 + 回收站」两个 modal（105 行）。

**方法要补一条（写进 §22 第 6 条）**：散落集合的收集除调用闭包外，**还要扫两类无调用者的函数**：
`addEventListener(…, fn)` 的实参、以及 HTML `onclick=` 里点名的函数。
**闭包到不了它们，但它们一定属于某个视图。**

## 10. 补记：这一步为什么值得停

**如果按 17 个名单直接搬**，`app.js` 里会留下 6 个"碰不到目录页 id、但语义上是目录页的东西"的函数，
而**没有任何闸会说它错**——它们合法、能跑、测试全绿。

**这和第 6 条那个漏法是同一种**：行区间漏了 `git diff` 看得见，**闭包漏了没人看得出来**。

## 11. 裁定 B 落地记录（2026-10-29，Chief）

**裁定**：全局 modal（`#lock-conflict-*`）归外壳——`showLockConflict` / `confirmLockConflict` 留 `app.js`，
模块走 `injected.showLockConflict`，`index.html` 的 modal 位置不动；`createProjectFromFile` 跟模块走，
上传接线搬进模块 `init`；接口加第 4 个导出 `open`。

### 11.1 落盘后与 §9 的关系（这条要先读，否则会以为 §9 被违反）

§9 说"本刀不含锁冲突 + 回收站（105 行）"——**裁定 B 之后仍然成立**：
`confirmLockConflict` / `closeLockConflict` / 回收站三个函数（`loadTrash` / `purgeTrashProject` /
`restoreTrashProject` / `openTrashPanel`）**一个都没搬**；唯一变化是 `showLockConflict` + 4 个 lock 文案
从"能搬"移到"要留"（外壳拥有、模块经注入调用）。§9 的"下一刀 = 锁冲突 + 回收站"**不再需要**，
锁冲突已经在终态位置上。

### 11.2 跨子树 DOM 句柄（模块零 id 字面量的代价）

`createProjectFromFile` / `openProject` 会碰 8 个不在 `view-library` 子树里的 id（R3 对模块零豁免），
一律改成注入的 getter 返回节点（§22.2 ④）：

```
getNewProjectPicker → #new-project-file      getNewProjectName  → #new-project-name
getNewProjectError  → #new-project-modal-error  getNewProjectMask → #new-project-mask
getExportIncludeNotes → #export-include-notes
getPagesOverlayToggle → #pages-overlay-toggle   getPagesMarginToggle → #pages-margin-toggle
getReviewMarginToggle → #review-margin-toggle
```

### 11.3 状态写点：11 个 setter，生成器必须"先写点后 IDENT"

`openProject` 里有 11 处状态写点（`pagesOverlayOn` / `marginSuggestion` / `setupSuggestions` …）。
生成器原来只处理 2 个，其余会生成 `injected.getX() = v` ——**那不是语法错误**：
Node 26 的 `node --check` 对"赋值目标不可写"**不报**（实测 `a.b() = 1` 也 PASS），只在运行时炸。
所以 `rules.SETTERS` 是**替换顺序**的一部分：先 setter，再 IDENT。

### 11.4 两处 `notify` 语义必须与原来一致

- **错误**：原来 `showError(el("library-error"), error)` 会写 `<code>错误编号 …</code>` 与 detail，
  只传 `text` 会把这层信息丢掉 → `notify({ kind:"error", error })` 由模块回调 `injected.showError` 渲染同一段；
- **收起**：原来 `el("library-error").hidden = true;` → `notify({ kind:"error", text: "" })`。

### 11.5 落盘读数（`accept_library.py` exit 0）

```
view-library 子树 id 9 个 / app.js 字面量 24 → 0（写点 19 → 0）
app.js 16,161 → 15,870（净减 291 = 311 搬走 − 20 注入块）
library-view.js 386 行 · 导出 4（init / enter / notify / open）· 注入键 45
12 个搬走函数：模块 1 处、app.js 0 处
```

### 11.6 这一刀暴露的两个闸洞（本刀修不了，报给闸的 owner）

1. **`index.html` 少了 `<script src="/static/library-view.js">` 时全闸不红**：R7 只校验
   `reading-view.js` 那一个 `<script>`。落盘后页面里 `window.LibraryView` 是 `undefined`，
   `init` / `enter` 全是 `?.` 空转——**目录页永远空着，而静态门全绿**。本刀已补上 script 标签。
   R7 应收敛为"每个 `*-view.js` 都必须在 app.js 之前有 `<script>`"。
2. **R9 是"文件里声明过没有"，不是"这一处能不能看见"**：`init` 的 deps 里生成过
   `getProject: () => project`（app.js 里没有 `project` 这个顶层变量），
   `project` 在别的函数里声明过 → R9 绿。**只有页面级验证抓到了它**（`project is not defined`）。
