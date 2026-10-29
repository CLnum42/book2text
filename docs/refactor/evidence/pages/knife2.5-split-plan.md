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
