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
| `setupLibrary` | 旧树标签，已由 14 个 `wirePagesXxx` 取代（见 ⅵ） | **不在此列旧行号**：留外壳段的当前标签见 §ⅲ（旧标签已作废，避免「段号可查」在错的东西上通过） |
| `boot` | 14026–14027 · 14258–14259 · 14294 · 14296 · 14361–14362 | — |

`setupRecognitionSettings` 已由 Builder 拆完（`wirePagesRecognitionSettings`，3 处），不在上表。

### ⅲ 留外壳清单（刀 2.5 的验收物之一：不留清单，「留」会变成「忘了」）

> **量于 `6372991` 的树**（`app.js` 14,517 行；14 个 `wirePagesXxx` 已抽完）。
> **重锚判据是 id 集合相等 + 首行去空白相同，不是行号平移**：行号每抽一次就漂，
> 旧版 §ⅲ 用的是 14,398 那棵树的标签，漂了约 166 行——**表照抄旧标签会让「段号可查」这条判据在错的东西上通过**。
> 机检脚本：`python3 scripts/reanchor_pages_shell.py --spec <旧清单.json>`（7/7 通过；判定主键 = 段内 id 集合）。

| 段（当前树，量于 `6372991`） | id 集合（机检主键） | 为什么留 | 处置 |
|---|---|---|---|
| `setupShell` 1261–1264 | `stats-open` | `openModal` @1262（通用骨架）+ `loadSummary` @1263（项目摘要/workflow） | 永久留 |
| `setupShell` 1274–1278 | `selection-review-open` | `openPageDetail` @1277（页详情，别的视图） | 等页详情视图拆走再抽 |
| `setupLibrary` 12613 | `apply-high-suggestions` | `openSuggestionApplyPanel` @12613（建议应用面板，别的视图） | 等该面板拆走再抽 |
| `setupLibrary` 12669–12672 | `page-more-menu`、`word-boxes-open` | `openWordBoxesDialog`（词框对话框，别的视图） | 永久留 |
| `setupLibrary` 12673–12676 | `backups-open`、`page-more-menu` | `openBackups` + `closeModal("backups-mask")`（备份/恢复，别的视图） | 永久留 |
| `setupLibrary` 12680–12683 | `aux-rerun`、`page-more-menu` | 辅助识别联动，面板未拆 | 等面板拆走再抽 |
| `setupLibrary` 12688–12692 | `layout-detect-open`、`page-more-menu` | `openLayoutDetectDialog`（版心检测面板，别的视图） | 等该面板拆走再抽 |

**可逐字引用的标签**（豁免表的 `阻塞段` 字段请直接用下面这 7 串，函数名与范围之间是**一个空格、无反引号**——
判据是「逐字出现在本清单里」，格式不一致就等于查不到）：

```
setupShell 1261–1264
setupShell 1274–1278
setupLibrary 12613
setupLibrary 12669–12672
setupLibrary 12673–12676
setupLibrary 12680–12683
setupLibrary 12688–12692
```

**`page-more-menu` 跨 4 段**（12669–12672 / 12673–12676 / 12680–12683 / 12688–12692），
所以豁免表里它的 `阻塞段` 必须写全 4 个标签，只写一个就到不了期。

**不在本表但同样留在壳里的**：`setupCollabControls` 13482–13488（分配协作视图，8 个引用全跨视图）
——它不是「受阻」，是**该函数整个不属 pages**，id 的到期刀按原 stage 4 走。

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

## ①-更正版 段表（取代上文 §① 的行号；旧行号一律作废）

> **量于：工作区 `app.js`（`HEAD=03b7ef7` + Builder 未提交的抽段改动），`app.js` 共 14497 行。**
> **抽段提交落盘后必须按定版重出一次**——行号会随提交漂移，**没有 sha 的行号等于误导**。

| wire 函数 | 行范围 | 行数 | 覆盖的 id（种数）|
|---|---|---:|---:|
| `wirePagesExportMarginJudgement` | 2250–2256 | 8 | 1 |
| `wirePagesRecognitionSettings` | 3267–3283 | 18 | 3 |
| `wirePagesPageNumberPanel` | 5899–5901 | 4 | 2 |
| `wirePagesPageMore` | 6928–6954 | 28 | 2 |
| `wirePagesFilters` | 12476–12482 | 8 | 5 |
| `wirePagesPageGrid` | 12490–12498 | 10 | 1 |
| `wirePagesPageRange` | 12506–12510 | 6 | 2 |
| `wirePagesSelection` | 12518–12530 | 14 | 4 |
| `wirePagesSelectionMore` | 12538–12554 | 18 | 2 |
| `wirePagesPanes` | 12562–12571 | 11 | 9 |
| `wirePagesSetup` | 12579–12582 | 5 | 3 |

合计：**11 个 wire 函数**；覆盖 id 种数 **34**
