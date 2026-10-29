# 刀 2.5：把 8 个装配函数里的 pages 接线先拆出来（一页纸，2026-10-29）

> **原则**：只搬行、不改逻辑。抽出的 `wirePagesXxx()` 住 `app.js`，**刀 2 与装配点同批搬进 `pages-view.js` 的 `init`**。
> 基线：`app.js` 14,387 行（origin/main 树）；8 个装配函数对 `view-pages` id 的引用共 **58 处**。

## ① 拆法

**以 `setupLibrary` 为例**（`app.js:12425–12573`，149 行，其中 **38 行**引用 `view-pages` 的 id）：

- **抽什么**：把**连续成块的接线**抽成一个函数，例如 `12461–12474` 的"选区 / 筛选 / 检查"块 →
  `wirePagesSelection()`（无参、返回 void）。命名规则：`wirePages<区域名>`；
- **抽到哪**：抽出的函数**留在 `app.js`**（不直接写进模块——刀 2 之前模块还跑不起来）；
- **顺序**：原位留一行 `wirePagesSelection();`，**插入位置 = 原块第一行的位置**，副作用顺序因此不变（这是唯一不能错的地方）。

**8 个函数与预算**：`setupRecognitionSettings` 3 处 · `setupCollabControls` 2 · `setupPageMore` 2 ·
`setupPageNumberPanel` 2 · `setupShell` 2 · `setupExportPanel` 1 · `boot` 8 · `setupLibrary` 38 = **58**。

## ② 判据

- **行为等价**：`tests/js` 行为用例 · `pytest`（1,002）· QA 实机四步；每拆一个跑一次；
- **集合等价**：R3 对 `view-pages` 的引用数**每拆一个报一个下降数**，合计 58 → 0；
- **硬红线**：只搬行不改逻辑，判据是脚本（见下），**不是人眼看**。

### `scripts/move_only_check.sh` 的两版（第二版才是对的）

第一版 `uniq -c | awk '$1%2==1'` 有洞：**同一行本来就出现两次以上时，搬动后计数恰为偶数 → 漏判**。
正确做法是**删行集合 vs 加行集合的多重集差**：

```sh
comm -3 <(git diff -U0 -- backend/book2text/static/app.js | grep '^-' | grep -v '^---' | sed 's/^-//' | sed 's/[[:space:]]//g' | sort) \
        <(git diff -U0 -- backend/book2text/static/app.js | grep '^+' | grep -v '^+++' | sed 's/^+//' | sed 's/[[:space:]]//g' | sort)
```

**输出为空 = 行级移动；不为空就停。**

## ③ 验收（刀 2.5 自己怎么算完）

```
· 8 个装配函数里对 view-pages id 的引用 == 0
· 抽出的 wirePagesXxx 里「跨视图」引用 == 0（只碰 pages 的东西）
· 三闸绿（node / registry / pytest）+ QA 实机四步通
```

## ④ 风险与禁区（三个数已先量）

**交织行 = 0**：8 个函数里**没有一行**同时读 `view-pages` 与其他视图的 id。
→ "由模块提供粗操作替换"这条**降级为保留判据、当前 0 命中**，明早不会被一个不存在的问题绊住。

**`setupLibrary` 38 行里调用的外部函数 = 3 个**：`checkSelection` / `setPageZoom` / `startBatchRecognition`。
它们都是 pages 自己的流程函数（**不算跨视图**），但**住在 `app.js`** → wire 函数搬进模块后必须从 `init(deps)` 拿到：
**刀 2 的 deps 新增这 3 个名字**，写进名单，不写"等落盘再看"。

**禁区**：只许动这 8 个函数的函数体；不许顺手改别的行；交织行（当前 0 行）**不许拆半行**。

## ⑤ 拆的顺序（一批一个函数，可回滚）

先 `setupRecognitionSettings`（3 处、0 跨视图）试刀 → `setupCollabControls` / `setupPageMore` / `setupPageNumberPanel`（各 2）→
`setupShell` / `setupExportPanel`（各 2 / 1）→ `boot`（8）→ 最后 `setupLibrary`（38）。

每拆一个：`node 闸 + pytest + 数一次 R3`，**降了才拆下一个**。

## ⑥ 拆完后刀 2 名单长什么样（明早第一眼）

```
刀 2 = 8 个 wirePagesXxx（承载 58 处 id 引用）+ 3 条 PageTile（acid 到期）= 11 条
8 个装配函数本身不再进名单（各留一行 wire 调用）
deps 新增：checkSelection / setPageZoom / startBatchRecognition（+ 各 wire 区域自身用到的）
```

## ⑦ 判据换成 133 个 id 全集（2026-10-29 夜，DevLead 实测，量于快照 cc8552c7 / 14,398 行）

### ⅰ 为什么「只数 view-pages 子树」会假绿

实测 6 个面板的 id **不在 `view-pages` 子树里**（子树只有 127 个 id，19,095 字节）：

```
page-number-panel · assign-panel · backups-mask · word-boxes-panel · split-batch-panel · layout-detect-panel
```

它们挂在视图容器之外（modal 层）。后果有两个，都会让验收假绿：

1. **R3 = 58 只数了子树内的引用**，而抽出的 wire 段会同时带着面板 id；
2. 更硬的一条：**按子树 id 聚类时，只引面板 id 的那几行不会落进任何段**——实测 7 行
   （`setupPageNumberPanel:5866,5869` · `setupCollabControls:13488` · `setupLibrary:12453,12454,12556,12557`）。
   它们**看着像"已经不在段里"，其实没人管**。

**判据（刀 2.5 起用）**：`133 = 视图子树 127 ∪ 面板 6`，**在「8 个装配函数 + wirePagesXxx」里逐个对集**。

### ⅱ 22 段 → 16 可抽 / 6 留（待判那 1 段按"留"处置）

| 函数 | 可抽段（当前树行号） | 留外壳段 |
|---|---|---|
| `setupPageMore` | 6894–6895 | — |
| `setupPageNumberPanel` | 5864 · 5866 · 5869 · 5871 | — |
| `setupExportPanel` | 2223 | — |
| `setupShell` | — | 1261–1264 · 1274–1278 |
| `setupCollabControls` | — | 13482–13488 |
| `setupLibrary` | 12446–12448 · 12453–12454 · 12472–12473 · 12478–12482 · 12485–12508 · 12559–12562 · 12576–12578 | 12441 · 12523–12531 · 12548–12557 · 12567–12571 |
| `boot` | 14026–14027 · 14258–14259 · 14294 · 14296 · 14361–14362 | — |

`setupRecognitionSettings` 已由 Builder 拆完（`wirePagesRecognitionSettings`，3 处），不在上表。

### ⅲ 留外壳清单（刀 2.5 的验收物之一：不留清单，「留」会变成「忘了」）

| 段（当前树行号） | 为什么留（混了哪个别的视图的调用） | 处置 |
|---|---|---|
| `setupShell` 1261–1264 | `openModal` @1262（通用骨架）+ `loadSummary` @1263（项目摘要/workflow，属 shell/library） | 永久留 |
| `setupShell` 1274–1278 | `openPageDetail` @1277（页详情，别的视图） | 等页详情视图拆走再抽 |
| `setupCollabControls` 13482–13488 | `openAssignPanel` @13482 / `loadAssignments` @13486 / `closeModal("assign-panel")` @13488（分配协作视图） | 永久留（该函数不属 pages） |
| `setupLibrary` 12441 | `openSuggestionApplyPanel` @12441（建议应用面板，别的视图） | 等该面板拆走再抽 |
| `setupLibrary` 12523–12531 | `adoptAllHighSuggestions` @12527 → 调 `loadPageDetail`（别的视图） | 等页详情拆走再抽 |
| `setupLibrary` 12548–12557 | `openWordBoxesDialog` @12550 · `openBackups` @12554 · `closeModal("backups-mask")` @12556,12557 | 词框/备份各归其视图，永久留 |
| `setupLibrary` 12567–12571 | `openLayoutDetectDialog` @12570（版心检测面板，别的视图） | 等该面板拆走再抽 |

### ⅳ 目标数（R3 不可能归零，因为 7 段留外壳）

```
133 个 id 的引用全集          66 处 = 子树类 55 + 面板类 11
其中已由 Builder 拆走           3 处（wirePagesRecognitionSettings）
16 段可抽走                    39 处
────────────────────────────────────────
a = 搬走后装配函数里剩          24 处   ← 刀 2 的 R3 目标改成这个数
b = 7 段留外壳占其中            24 处   ← 留外壳的账，单独记，不算进"应该降到的目标"
```

（`a == b` 不是巧合：可抽段搬空之后，装配函数里剩下的就**全在**留外壳段里，没有第三种去处。）

### ⅴ deps 名单草案（25 键 = 22 函数 + 2 getter + 1 通用工具）

```
函数（22）：patchRecognitionSetting · openPageNumberPanel · openPageNumberReview ·
  setAutoApplySetting · checkSelection · renderPages · applyPageRangeInput · recognitionOf ·
  recognizeSelection · selectionPages · startBatchRecognition · clearPageSelection ·
  selectAllVisiblePages · confirmLayoutFromPanel · startAuxiliaryAll · toggleMarginView ·
  togglePageBlocksOverlay · confirmAllMargins · setPageZoom · rerunAuxiliary ·
  confirmAllUnconfirmed · confirmSelectedPages
getter（2）：currentProject（全局状态）· selectedPages（pages 状态，外壳有写点）
通用工具（1）：closeModal（面板关闭，被子树外 id 的接线用到）
```

**先不改 `rules.py`**：等 Builder 把 16 段抽完、行号稳定后一次写。
