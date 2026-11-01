# 第一批域模块化：施工书

> **版本 v1.1（2026-11-01）**：v1 有 5 处错，全部由 DevLead 独立测量指出、Chief 复验前两条。逐条见 §0.1。
> **状态：草案，等 Chief 批。** 作者 Architect，2026-11-01。量数树 `main@4676772`（app.js 12,755 行 / 505 顶层函数 / **146** 份列 0 的顶层 `let`·`var`（口径见下））。
> 上位文档：`docs/refactor/appjs-domain-map.md`（③ 的域表与判据）。本文件是它第一批的**施工单**。
> **状态变量口径**：只数**列 0** 的 `let`/`var`（146 份）；缩进 2 格的 51 份在某个顶层块里，不计入"外来状态"判据——
> 口径一变，域表那列的"外来状态"数就不可比（今天已经有过一次 254 / 146 的口径误会）。
> **每一刀都独立可验收**：不并刀、不搭便车（`knife-numbering.md` §一 的老规矩）。

## 0.1 v1 → v1.1 的 5 处更正（v1 错的，别照旧稿施工）

| # | v1 | v1.1 | 证据 / 后果 |
|---|---|---|---|
| ① | 刀 A 的 `loadSummary` 只列 3 处调用点 | **4 处**，且按值位/调用位分开：`app.js:1099`（调用位）· `:2546`（值位，`queueAfterSteps(() => loadSummary())`）· `:4949`（调用位）· **`:10994`（值位，`el("stats-refresh").addEventListener("click", loadSummary)`）** | `:10994` 在 `setupLibrary()`（10961）里，而 boot:12397 调 `setupLibrary()` ⇒ 不改就**启动即 ReferenceError、整站白屏**。它不报编译错，只在运行时抛 |
| ② | deps「186 → 186」 | **173 → 173** | 186 是刀 10b 的数；刀 11 删了 13 条死键。复现：`b61634d` = 186 / `20049f9` = 173 / 当前 = 173 |
| ③ | 「模块里 `el(` 各 0 次」写成验收句 | **要写成 tests/js 断言 + 一条变异**，否则只是人工 grep | 本项目的老毛病：判据写在文档里、没人执行 |
| ④ | 模块 `init({ root })` | **`init({ list, note })`**（刀 A 不要 root），且 `list`/`note` 可能为 `null` | 单测 harness 的 `getElementById` 恒返回 `null`（`tests/js/load-app.mjs:116`）⇒ 不判空，单测里一进 `load()` 就炸 |
| ⑤ | 导出 `render(data)` | **不导出**（内部函数） | 它没有真调用点；`preview-view` 的 `exit` 就是"0 调用点的导出"被删的先例 |

**为什么我自己没抓到 ①**：v1 的扫描只走了调用位，`addEventListener("click", loadSummary)` 是**值位**。
而"三栏（定义位/值位/调用位）"这条正是我写进 §7 的口径——**书写者和执行者用了两套标准**。
v1.1 起，每刀的引用清单必须**逐条标出它属于哪一栏**，不标就等于没扫。

## 0. 范围与顺序

```
刀 A  质量统计    quality-stats.js   4 个函数 / 101 行   自己 0 个状态（最干净，先做）
刀 B  页面确认    page-confirm.js    5 个函数 /  49 行   0 个 DOM id
刀 C  目录确认    page-index.js      6 个函数 /  58 行   带 3 份共享状态（唯一"要搬状态"的一刀）
刀 D  结构工具    structure-tools.js 7 个函数 / 156 行   17 个 dialog id + 2 处写盘（最重，放最后）
——    任务抽屉    ——                                3 行 / 1 个函数，**建议不拆**（§6）
```

**为什么 A 先做**：`quality-stats` 是这批唯一"自己 0 个状态"的域——搬完它不需要新增任何状态访问器，
只搬函数 + 一处 `list.innerHTML`。它验证的是**模块骨架与注入形态**，不是难度。

## 1. 通用形态（四刀的公共契约，先定死，别每刀现议）

**① 服务模块不是视图模块。** 新文件**不叫 `*-view.js`**（R3 对 `*-view.js` 是零豁免：只能引用自己
`<section>` 的 id；这些域的 DOM 在 dialog 里，硬套就得伪造一个 section）。命名与挂载：

```
quality-stats.js → window.QualityStats     page-confirm.js → window.PageConfirm
page-index.js    → window.PageIndexService structure-tools.js → window.StructureTools
index.html：四行 <script>，位置在 page-tile.js 之后、app.js 之前（经典脚本，不许 type="module"）
```

**② 模块不许按 id 找 DOM。** 校验方式：模块源码里 `document.getElementById` 与 `el(` 各 **0 次**。
需要 DOM 的模块在 `init()` 时拿到**一个根宿主元素**，只许在该子树内 `querySelector`：

```
quality-stats   **不用 root**：外壳查好 el("stats-list") / el("stats-note") 直接传（v1.1）
structure-tools root = el("structure-panel")  （17 个 structure-* 全在它子树里；17 个元素逐个传太笨）
page-confirm    不用 root（纯数据）
page-index      root = 设置面板里装三档 radio 的那个容器（只用来 querySelectorAll 一组 radio）
```

**③ 打开/关闭遮罩留在外壳。** `openModal/closeModal` 是全局 chrome 行为，模块只负责"拉数据 + 画"。
所以 `openStatsPanel()`（app.js）在刀 A 之后仍然存在，内容变成 `openModal("stats-panel"); window.QualityStats?.load();`。

**④ 注入只走两条**：`getX()` 状态访问器 / 动作函数。**不许**给模块 setter 让它改外壳状态
（除了本来就只有它在写的那份状态，见刀 C 的做法：状态整个搬走，外壳改成 `getX()` 读模块）。

**⑤ deps 条数一刀都不许变**：**173 → 173**（v1 写的 186 是刀 10b 的数，见 §0.1 ②）。搬走的函数**仍然经注入**进视图模块，只把 boot 里那些键的
右侧值从 `pageSetupStats: pageSetupStats` 改成 `pageSetupStats: (...args) => window.PageConfirm.pageSetupStats(...args)`。
（这条同时保护 R13 与 R8：本批不动 `PagesView` 的导出面，36 还是 36。）

**⑥ 空值守卫（四刀通用）**：`init` 拿到的元素 / root 在**单测 harness 里恒为 `null`**
（`tests/js/load-app.mjs:116` 的 `getElementById` 返回 `null`）。所以每个公共方法的**第一句**判空：
`if (!list) return;` / `if (!root) return;`。不判空的后果不是"单测红得难看"，是**模块在单测里一调就抛**，
然后所有人开始给测试加豁免——那正是豁免表只涨不消的起点。

**⑦ 导出面只放有真调用点的成员**（§0.1 ⑤ 的通用形式）：内部函数不导出；
每导出一个成员，书上就要能指出**谁在什么位置调它**。"先导出、以后可能有人用"是同一类病
（`preview-view` 的 `exit()` 就是这么来的：0 个调用点，最后被删掉）。


## 2. 刀 A：质量统计 → `quality-stats.js`

**搬什么（按名字，行号只作对照，落盘时按名字定位）**

| 函数 | 行 | 行数 | 归属判定 |
|---|---|---|---|
| `statsRow` | 2557 | 8 | 进本刀（只被 renderSummary 经展开调 `...statsRow(...)`——grep 容易漏，见 §7 口径） |
| `percentText` | 2566 | 3 | 进本刀，并**导出**给 `pages-view` 用（它在 pages deps 里，右侧值改成模块） |
| `loadSummary` | 2570 | 12 | 进本刀 |
| `renderSummary` | 2583 | 78 | 进本刀 |
| ~~`renderProject`~~ | 2662 | 12 | **不进**：它写 `#project-title` / `#package-chip`、调 `PagesView.onPageListChanged`，属"项目信息/外壳"，不是统计 |
| ~~`renderProjectMeta`~~ | 2680 | 24 | **不进**：同上，属设置对话框的「当前项目」一节 |

**段头注释改名（只改注释，同批做）**：`// ---- 质量统计（说明书 8.5 / 13.4）` 这一段里现在还住着
`renderProject` / `renderProjectMeta`（41 行，属项目头与项目信息）。刀 A 之后段里只剩注释与搬空的痕迹时，
注释改成 **`// ---- 项目头与项目信息`**——名字不跟着内容改，下一个人按段名找统计会找到项目信息。

**新模块 API**

```js
window.QualityStats = {
  // v1.1：不要 root——它只用两个元素，外壳直接查好传进来（模块里因此连 querySelector 都是 0 次）
  init({ list, note, apiJson, getCurrentProject, setProjectSummary, syncWorkflowSteps }),
  load(),                    // 拉 /api/projects/{id}/summary → 内部 render；读不到就静默（今天的行为）
  percentText(value),        // 唯一导出的纯函数：pages-view:415 经注入用它（真调用点，见 §0.1 ⑤）
};
// render(data) 不导出：只有 load() 调它，没有外部调用点
```

**空值守卫**：`list` / `note` 在单测 harness 里恒为 `null`（`load-app.mjs:116` 的 `getElementById` 返回 null）。
`load()` 与内部 `render()` 的第一句都是 `if (!list) return;`——否则单测一调就炸。

**调用点改造（逐处）**

**四处引用，逐条标栏（v1 漏了第 4 条，见 §0.1 ①）**：

```
栏    位置                现在的写法                                        改成
调用位 app.js:1099        loadSummary();                                    window.QualityStats?.load()
值位   app.js:2546        queueAfterSteps(() => loadSummary());             queueAfterSteps(() => window.QualityStats?.load())
调用位 app.js:4949        await loadSummary();   // 任务结束后统计会变        await window.QualityStats?.load()
值位   app.js:10994       el("stats-refresh").addEventListener("click", loadSummary)
                          ← 在 setupLibrary() 里，boot:12397 调用 ⇒ 不改就启动白屏
                                                                             el("stats-refresh").addEventListener("click", () => window.QualityStats?.load())
值位   app.js:12480       percentText: percentText,   // pages deps           percentText: (...a) => window.QualityStats.percentText(...a)
定义位 app.js:2557/2566/2570/2583                                        四个函数整体移出
```

**值位为什么必须先处理**：`addEventListener("click", loadSummary)` 传的是**函数对象本身**，
函数一移走，`loadSummary` 就是个未定义标识符——它在 `setupLibrary()` 执行时就抛，
而 `setupLibrary()` 在 boot 里 ⇒ **不是点刷新才坏，是启动就坏**。

**验收判据（可机检）**

```
① app.js 里不再定义 statsRow / percentText / loadSummary / renderSummary（按函数名集合相减，不数总数）
② **要有闸，不是人工 grep**（v1.1，见 §0.1 ③）：`tests/js/boundary.test.mjs` 加一条
   `moduleDomProblems(source)`——剥注释后 `el(` / `document.getElementById(` / `querySelector(` 各 0 次；
   配一条自检：喂进 `el("x")` 的假源码必须报红。`quality-stats.js` 上必须返回 `[]`
③ deps **173** 不变；PagesView 导出 36 不变；R3 pages total 0 不变
④ 行为等价：打开统计面板，`#stats-list` 的 dt/dd 文本与改前逐字相同（真机一次，附截图/文本）
⑤ 变异：在 quality-stats.js 里加一句 `el("stats-list")` → 判据 ② 必须红（证明门是活的）
```

## 3. 刀 B：页面确认 → `page-confirm.js`

**搬什么**

| 函数 | 行 | 行数 | 归属判定 |
|---|---|---|---|
| `pageSetupStats` | 3340 | 17 | 进本刀（被 pages-view 注入） |
| `firstUnfinishedPanel` | 3362 | 12 | 进本刀（被 pages-view 注入） |
| `selectedSuggestions` | 3382 | 4 | 进本刀（被 pages-view 注入） |
| `suggestionPagesByType` | 3387 | 8 | 进本刀（被 pages-view 注入） |
| `warnUnconfirmed` | 3412 | 8 | 进本刀（被 pages-view 注入，internal `window.confirm` 保留） |
| ~~`openPageSetup`~~ | 3378 | 1 | **不进**：它是 `window.PagesView.openPageSetup.apply(...)` 的转发器（library-view:247 经注入调它），属"跨视图能力"，不是本域逻辑 |
| ~~`confirmAllUnconfirmed`~~ | 3406 | 1 | **不进**：同上，是转发器（finishConfirmPages:10501 调它） |
| ~~`layoutBlockPageRecord`~~ | 3778 | 5 | **不进**：是"版面块/建议"的东西，章节名里带"页面确认步"不代表归属（**按归属判，不按所在段判**） |
| ~~`highConfidenceCount`~~ | 3786 | 3 | **不进**：同上 |

⇒ 真身 **5 个函数 / 49 行**。段里那 51 行减去两个转发器 2 行——**这就是"按段数"与"按归属数"的差**。

**新模块 API**

```js
window.PageConfirm = {
  init({ getCurrentProject, marginBoxOfPage, recognitionOf }),
  pageSetupStats(),        // → {total, body, bodyExcluded, toc, front, back, confirmed, unconfirmed}
  firstUnfinishedPanel(),  // → "page-type" | "margin" | "recognition"
  selectedSuggestions(),   // 需要外部给"选中页集合 + 建议列表"
  suggestionPagesByType(),
  warnUnconfirmed(pages, action),
};
```

`selectedSuggestions` 读 `selectedPages` / `setupSuggestions` 两份外壳状态 ⇒ 这两份改成注入的
`getSelectedPages()` / `getSetupSuggestions()`（**只读**，不搬状态）。若这两份将来归 pages-view，
本模块的注入自动跟着换成模块访问器，接口不变。

**验收判据**

```
① app.js 里 5 个函数名 0 次（定义位）；page-confirm.js 里 `el(` / `document.` 各 0 次（纯数据模块）
② deps **173** 不变（5 个键仍在，右侧值换成模块转发）
③ 行为等价：同一个 project，pageSetupStats() 的 8 个字段逐字相同；firstUnfinishedPanel() 在
    "全部已确认 / 有未确认版心 / 有未识别" 三种数据上返回同一个值（三条夹具）
④ 变异：把 pageSetupStats 的 unconfirmed 恒返回 0 → 判据 ③ 必须红
```

## 4. 刀 C：目录确认 → `page-index.js`（唯一"搬状态"的一刀）

**搬什么**

| 函数 | 行 | 行数 | 备注 |
|---|---|---|---|
| `loadPageIndex` | 5493 | 18 | 读 `pageIndexLoading` / 写 `pageIndexData`、`pageIndexProject` |
| `loadIndexBlocks` | 5545 | 14 | 页面块缓存共用（pages / preview 都读） |
| `clearImagePlaceholder` | 5516 | 5 | 操作传入的 `<img>`（**无 id**，安全） |
| `loadImageQuality` | 5521 | 4 | 读 localStorage → `imageQualityMode` |
| `setImageQuality` | 5526 | 10 | 写 localStorage + `imageQualityMode` + `syncImageQualityUi` |
| `syncImageQualityUi` | 5537 | 7 | `querySelectorAll('input[name="reading-quality"]')` ⇒ 需要 root |

**三份状态随模块搬走**（这是本刀唯一危险点）：

```
pageIndexData · pageIndexProject · pageIndexLoading  +  imageQualityMode
→ 全部搬进 image-quality 侧（模块内 let），app.js 里改成 getX() 注入
   app.js 现有 deps 键 getPageIndexData / getPageIndexProject / getPageIndexLoading 右侧值
   从 (() => pageIndexData) 换成 (() => window.PageIndexService?.getData())，**键名与条数都不变**
```

**新模块 API**

```js
window.PageIndexService = {
  init({ apiJson, getCurrentProject, getSettingsRoot }),   // getSettingsRoot → 三档 radio 的容器
  loadIndex(),            // 原 loadPageIndex：返回 {status} 语义不变（"busy" 要保留）
  loadBlocks(pageNo),
  clearImagePlaceholder(image),
  getData(), getProject(), isLoading(),          // 给 deps 读
  getImageQuality(), setImageQuality(mode),      // 写盘 + 同步 radio
};
```

**验收判据**

```
① app.js 里 `pageIndexData` / `pageIndexProject` / `pageIndexLoading` / `imageQualityMode`
   四个顶层 let **0 次**（定义位与引用位都归零）——这条比函数名更硬：状态不许留双份
② deps **173** 不变；loadPageIndex / loadIndexBlocks / clearImagePlaceholder / getImageQualityMode /
   setImageQuality 五个键仍在，右侧值换模块
③ "busy" 语义保留：并发两次 loadIndex()，第二次仍返回 {status:"busy"}（一条单测）
④ radio 只在 root 子树里查：模块里 `document.querySelectorAll` 0 次，
   改成 `root.querySelectorAll('input[name="reading-quality"]')`
⑤ 变异：在 app.js 里留一句 `pageIndexData = null` → 判据 ① 必须红
```

## 5. 刀 D：结构工具 → `structure-tools.js`

**搬什么**：`structureRules`(13) · `previewHeaderFooter`(17) · `renderStructurePreview`(70) ·
`updateStructureApplyState`(6) · `applyHeaderFooter`(35) · `setupStructurePanel`(6) · `setAllStructureKeeps`(9)
= **7 个函数 / 156 行**，全在 `#structure-panel` 子树里（17 个 `structure-*` id）。

**新模块 API**

```js
window.StructureTools = {
  init({ root, apiJson, getCurrentProject, notify }),
  setup(),                     // 原 setupStructurePanel：在 root 内部绑 4 个按钮
  preview(),                   // POST /structure/preview → renderStructurePreview
  apply(),                     // POST /structure/apply（写盘！可撤销）
  setAllKeeps(keep),
};
```

**写盘两处必须按"动作"命名**（`knife-numbering.md` §七：调用位不许挂在无关请求之后）：
`preview()` 与 `apply()` 各自"请求 → 读回 → 重画"在模块内部连起来，外壳不参与顺序编排。

**验收判据**

```
① app.js 里 7 个函数名 0 次；structure-tools.js 里 `el(` / `getElementById` 各 0 次，
   17 个 structure-* id 只在 index.html 与模块的 root.querySelector 里出现
② deps **173** 不变（本刀不新增注入键：root 与 apiJson 由 init 传，不进 deps 表）
③ 写盘等价：一次预览 + 一次应用，请求体与改前逐字段相同（抓一份请求体对集）
④ 撤销仍在：应用后调 `undoAutoApply` 的路径不变（它不归本刀，但要在真机上验一次能撤）
⑤ 变异：把 setup() 里的 root.querySelector 换成 document.getElementById("structure-all") → 判据 ① 必须红
```

## 6. 任务抽屉：建议**不拆**

```
openTaskDrawer() 只有 3 行（4589），一个函数、一个 id（#task-drawer）、0 状态、0 写盘。
拆它 = 新增一个 40 行的模块骨架换 3 行代码，且它没有任何"域"可言（谁都能开抽屉）。
建议：留到"外壳切服务"那一批，和 `#confirm-dialog` / `#stats-panel` 的开关一起收进一个 shell-services 模块。
现在拆 = 为凑清单做设计选择（本项目最反对的那件事）。
```

## 7. 每刀的公共验收（四刀同一张表，落盘时逐行填）

| 项 | 期望 | 怎么验 |
|---|---|---|
| app.js 行数 | 每刀 −(函数行 + 骨架抵消) | `wc -l`，落盘前记一次、后记一次 |
| 新模块行数 | 骨架 ≤ 40 行 + 搬入行 | `wc -l` |
| 函数名集合 | app.js 少 K 个、模块多 K 个；**集合相减** | 两个集合贴出来，不报总数 |
| deps | **173 → 173**（一刀都不许变；v1 写的 186 是刀 10b 的数） | 数 `window.PagesView?.init({` 到下一个 `?.init({` 的 `key:` 行 |
| PagesView 导出 | **36**（T0/C34/L2） | `tests/js/boundary.test.mjs` 跑绿 |
| R3 | pages total 0 / ids 0 | `node scripts/r3_pages_count.mjs --json` |
| 四闸 | node + pytest 全绿 | `node tests/js/run.mjs` / `PYTHONPATH="$PWD/backend" .venv/bin/python -m pytest -q` |
| 模块 DOM 面 | `el(` / `document.getElementById` 各 0 次 | 静态 grep（**先剥注释**，口径同 R3） |
| 模块 DOM 面（**要有闸**） | 本刀模块里 `el(` / `getElementById(` 0 次（刀 D 另允许 `root.querySelector(`） | `tests/js/boundary.test.mjs` 的 `moduleDomProblems(source)` + 一条喂坏样本自检；**不接受人工 grep** |
| 变异 | 每刀一条"喂坏样本必须红" | 落在 tests/js 里，跟着该刀的闸一起提交 |

**扫引用的口径（这条吃过亏，写死）**：三栏各扫一遍——定义位 / 值位（`addEventListener(..., f)`、
`requestAnimationFrame(f)`、回调参数、`?.`、**展开调用 `...f(...)`**）/ 调用位。
`statsRow` 就是隐形的：它只被 `...statsRow(...)` 用，`grep "statsRow("` 一个都看不见。

## 8. 顺序与风险（只给这几条，不排期）

```
① A 先做，因为它验证骨架；A 绿了 B/C/D 才有共同前提（模块形态定死）
② C 是唯一搬状态的刀，单独一笔、单独验收（状态归零那条判据是它独有的）
③ D 最重（17 个 id + 2 处写盘），放最后；它失败不影响 A/B/C 的价值
④ 四刀都不许"顺手"改行为：这批是**搬家**，任何行为修正都另开刀（否则回滚时不知道是哪件事坏的）
⑤ 任务抽屉不拆 —— 谁要拆，先回答"它作为一个模块，唯一资源 / 唯一生命周期 / 唯一失效语义是什么"，
   答不出来就不是模块（§21 判据）
```
