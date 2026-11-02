# Overlay registry 第二片施工书：pages × reading × index 的块框迁移 + 还债

> **状态：草案，等 Chief 批（§0 有一处扩围要他点头）；批了由 Builder 落盘。**
> 上位：`overlay-registry-contract.md`（契约）· `overlay-registry-slice1.md`（片 1，已落 `98a492d`）。
> **基线 = 开工时那棵树的实测值**，不从本文抄。本文写于 `059955c`：app.js **10,402** · pages-view **3,952** ·
> reading-view **3,686** · index-view 见 §1 · overlay-registry.js **264** · preview-view **1,112**。

## 0. 范围：三处扩围说明（第一处要 Chief 点头）

```
片 2a  registry 长出"块框全套"：盒子 + 顺序号 + 判重（版本）+ 143 行避让排布；pages 迁进来
片 2b  reading 迁进来 + 把它的 is-linked 装饰收成白名单
片 2c  **index 也迁进来**（★需确认）→ 然后才能删掉 app.js 的 renderPageBlocks / clearPageBlocks
```

**★ 为什么 index 必须进本片（不是贪大）**：143 行避让排布现在只服务 `renderPageBlocks`（app.js:3089 → 3150 一带）。
`renderPageBlocks` 今天还有 **4 个消费者**：reading、pages、index、preview（preview 已在片 1 换道）。
只要 index 还在用旧渲染器，避让链就**不能整体搬走**——搬走则 index 的顺序号没人摆，留一份则**同一套算法两份并存**
（契约 §1 明令禁止的"两套路径"，也正是片 1 否掉 A 方案的理由）。
index 的迁移面很小（§4：1 处容器 + 1 处调用 + 2 个 deps 键），比"两份算法"便宜得多。

## 1. 实测：四个消费者的块框路径（按名字定位，行号只作对照）

| 消费者 | 容器谁建 | 调用点 | styles 差异 | 交互 | 数据源 |
|---|---|---|---|---|---|
| preview（片 1 已迁） | registry | — | `details:true` | 只读（`--readonly`） | `previewTileBlocks` |
| **pages** | app.js `buildTile`（2723–2818，容器在 **2734**） | pages-view **885**（另有 **7 处** `clearPageBlocks`：86/893/926/1869/1879/2425/2477） | `details = pageZoomIndex >= 2`（默认参数） | **可 hover**：`page-overlay--labeled` ⇒ `app.css:901` 让 `.box` 吃指针，出 `.box__label` 卡片；**点击不绑盒**（选页是 #page-grid 委托，`app.css:901` 注释写明"点击仍冒泡到 tile"） | `pageBlockCache`（经 `pageBlockKey`） |
| **reading** | reading-view **2028** | reading-view **3544**（`details:false`；清屏 2579/3547） | `details:false` | 只读；**另有 `is-linked` 装饰**：3529 事后在 `.box` 上 toggle 类，604/2178 全清 | `readingPageBlocks` |
| **index** | index-view **337** | index-view **826**（`details:true`） | `details:true` | 只读 | `indexBlocksByPage` |

三个消费者**都用 `.page-overlay` 找容器 + `overlay._renderedBlocks !== blocks` 判重**——这正是契约 §1 说的
"同一份版本缓存散在多个文件"（片 1 之后仍剩 app.js:3059/3096/3099 · index-view:826 · pages-view:882/2489/2522 ·
reading:3544 共 8 处）。

## 2. 三条形态决策（本片新增，逐条给理由）

### 2.1 容器 class 由 `styles` 决定，不由消费者自己拼

现状三种写法：pages `page-overlay page-overlay--readonly page-overlay--labeled`（2734）·
reading `page-overlay page-overlay--readonly`（2028）· preview（registry）`overlay-layer page-overlay page-overlay--readonly`。
片 1 的 registry 把 class 写死在 `overlay-registry.js:129`，接 pages 就必须能加 `--labeled`：

```
paint(handle, { data, active, styles })
styles = { details: boolean,      // 画顺序号 **并排避让**（框外有空位就框外，没有才退回框内）
           labeled: boolean,      // **只**决定要不要建悬停卡片（并加 --labeled，让 .box 吃指针）
           marginMode: boolean }  // 加 page-overlay--margin（app.css:903：容器与 .box 都不吃指针）
容器 class = "overlay-layer page-overlay page-overlay--readonly" + (labeled ? " page-overlay--labeled" : "")
             + (marginMode ? " page-overlay--margin" : "")
```

`page-overlay--margin` 今天是 **`paintTileMargin`（3126）里 `overlay.classList.add`（3138）**、
**`clearTileMargin`（3156 起；`classList.remove` 在 3160）**——两个函数都靠 `tile.querySelector(".page-overlay")`
捞容器再改 class。registry 接管容器之后，这两处就是**对别人家节点的写**（跨 owner）。

**本片把它收成 styles 的一项**：`paintTileMargin` / `clearTileMargin` 删掉那两行 class 操作，
容器 class 由 `paint(handle, {styles:{marginMode}})` 一处决定；视图在"版心开关变化 / 每帧重画"时带上这个字段。

**两个字段的职责不能串（Chief 2026-11-02 裁决）**：

```
details ⇒ 画顺序号 + 排避让   （框外有空位就框外，没有才退回框内）
labeled ⇒ 额外建悬停卡片      （以及 --labeled 让 .box 吃指针）
preview = { details: true, labeled: false } ⇒ 号照样避让，只是没有卡片
```

**为什么必须分开**：实现里曾把"避让排版"绑在 `labeled` 上（`labeled ⇒ 排避让 + 建卡片`），
而 preview 只传 `details` ⇒ 它的号永远 inside ⇒ §6.1 ③「四视图逐号同类」稳定红。
分开之后 preview 与 pages/reading/index 在"号怎么摆"这件事上完全同类，差异只剩"有没有卡片"。
理由：registry 拥有容器 ⇒ 容器的 class 只能有一个写点（否则又回到"多处写同一份状态"）。
代价：styles 里多一个布尔，指纹随之变——版心开关是低频操作，重画一页的块框可以接受。

**两条机检（Chief ①）**：

```
(a) 容器 class 唯一写点：静态扫全部模块 + app.js，凡对 registry 容器的 class 写入逐个点名；
    `paintTileMargin:3138` / `clearTileMargin:3160` 两行必须消失（删掉它们是在本片预算里）。
    判据形态：`grep -n "page-overlay--margin\|classList.*page-overlay" *.js` 只剩 overlay-registry.js 一处。
(b) styles 直通容器：同页同数据、只把 styles.details 由 true 改 false ⇒ 容器的 class 必须跟着变
    （`--labeled` 随 labeled 变、`--margin` 随 marginMode 变），且 `stats(pageNo).version` 必须变（styles 进指纹）。
    变异：把 style→class 的同步删掉 ⇒ (b) 红。
```

### 2.2 `.box__label` 由**注入的纯构建器**生成，不搬进 registry

`buildBoxLabel`（5850–5920，71 行）**不能搬进 registry**：它最后一段调
`window.PageDetailEditor?.pageNumberHintChip(suggestion)`（**5908 是 `if (suggestion)`，调用在 5909**；原版写的 5910 与我们改的 5911 都不对）——那是**模块→模块**引用，registry 拿不了。

```
init({ buildLabel })            // 外壳注入 buildBoxLabel（纯构建器：吃 block/index/suggestion，返回 Element）
render(item, style)：当 style.details 时，label 用 injected.buildLabel(item, style) 生成
```

**这是 §5.5「render 只许读两个参数」的唯一例外**，写清楚边界：允许的是**无状态纯构建器**
（不读时间、不读全局、不读 currentView）；一旦它开始读变化的状态，指纹就抓不到 → 必须改成 data/styles 的字段。
**边界要写成可判的（Chief ②）**：

```
· 纯函数：只吃 (block, index, styles)；不读 window、不读模块状态、不缓存
· init 一次、之后不许替换（替换 = 允许运行期换渲染器，那是另一个设计）
· 闸：模块源码里出现 window.PageDetailEditor / window.PagesView 等模块名 → 红
```

**⚠ 这条闸今天不存在**（我核过 `boundary.test.mjs:5878–5890`）：`godDoorProblems` 只查两件事——
① 模块里裸调 app.js 顶层函数；② 模块用了 `injected.X` 而 boot 没注入。**它不查 `window.X`**。
所以本片的 test-contract 那一笔要补 3 行：非视图服务模块源码里出现 `window.<已知模块名>`
（PagesView / ReadingView / PreviewView / IndexView / LibraryView / MergeView / PageDetailEditor / PageTile / OverlayLayer）
⇒ 红，并带一条喂坏样本自检。补完 `godDoor` 才真的"管到这里"。

### 2.3 reading 的 `is-linked` 是**声明式装饰例外**，不触发重画

hover 联动今天是这样：`applyReadingLinked`（3525–3531）对 `tile.querySelectorAll(".box[data-block-id]")` 逐个
`classList.toggle("is-linked", …)`，另有 604/2178 两处全清。

```
为什么不用 styles 重画：hover 是瞬态、每秒可能十几次；重画会重建节点 ⇒ 节点身份变、CSS 过渡断、
   hover 目标丢失（片 1 的幂等判据正是盯节点身份的）。而且指纹会因 hover 抖动，版本失去意义。
裁定：is-linked 允许由视图在**绘制之后**直接 toggle，但只许这一个类名、只许在 registry 生成的 .box 上。
闸（可机检）：除 registry 外，任何模块对 `.box` 的 classList 写入只许是 "is-linked"；
              出现第二个类名 / 出现 style 写入 / 出现 innerHTML 写入 ⇒ 红。
```

**两条判据（Chief ③）**：toggle 之后必须同时成立——

```
(a) `stats(pageNo).version` 不变（装饰不进指纹，否则 hover 每次都变版本）
(b) `container.lastChild.firstChild` 身份不变（没有重画：装饰不是第二次 render）
变异：把 is-linked 改成走 styles 重画 ⇒ (a)(b) 同时红。这两条一起才证明"它只是装饰"。
```

**这是唯一的例外**，写进契约 §23.6 的"不负责"旁边：hover 装饰不归 registry，但也**不许变成第二个画家**。

### 2.4 index 的迁移面（Chief 要求写进本节）

```
容器   index-view.js:337 `overlay.className = "page-overlay page-overlay--readonly page-overlay--labeled"`
       ⇒ 删；改成 tile 建好后 `window.OverlayLayer.mount(tile, { pageNo })`
调用   index-view.js:826 `if (!overlay || overlay._renderedBlocks !== blocks) injected.renderPageBlocks(...)`
       ⇒ `paint(handle, { data:{blocks}, active: getPagesOverlayOn() ? ["blocks"] : [], styles:{ details:true, labeled:true } })`
deps   app.js:10152 / 10155 两个键（clearPageBlocks / renderPageBlocks）⇒ 删
不动   `drawIndexFirstLine(tile, blocks, page)`（首行提示，另一条链）与 `indexBlocksByPage`（数据源仍归 index-view）
收益   与 preview 同形（details:true / labeled:true / 只读），所以它是四个消费者里最便宜的一个
```

## 3. 还债：143 行避让排布 + 拆掉 `drawDiffLayer` 耦合

### 3.1 拆 `drawDiffLayer` 耦合（**笔 A 已落**：`2df2cd0` 实现 + `eec53b9` 闸）

**为什么必须先拆**：`scheduleOverlayLayout` 有两个主人——块框 overlay（`renderPageBlocks:3089`）与审校的
`#detail-overlay`；它成功那帧调 `drawDiffLayer()`。直接搬进 registry = 把审校视图的副作用搬进共享模块。

**落成什么形状**（Builder 实际实现，我核过）：

```
scheduleOverlayLayout(overlay)          共享调度器（**6052**），拆完只剩"摆号"——`drawDiffLayer()` 已从它体内移出
scheduleDetailOverlayLayout(overlay)    审校本地调度器，摆完在**同一个 rAF** 里调 drawDiffLayer()
                                       两条共用 `overlay._layoutToken` ⇒ 同一容器永远只有一个调度在跑
observeOverlaySize(overlay, schedule)   第二参数 + `overlayScheduleByTarget` WeakMap 按目标分派
                                       ⇒ "同一个观察器服务两种层级"是**显式**的，不靠猜
```

**审校侧的调用面（实测 `eec53b9`：四处显式 + 一处观察器分派）**：

```
5215  scheduleDetailOverlayLayout(el("detail-overlay"))      进入审校视图
5232  scheduleDetailOverlayLayout(el("detail-overlay"))      版心开关 on
5257  scheduleDetailOverlayLayout(el("detail-overlay"))      块框开关 on
6535  observeOverlaySize(overlay, scheduleDetailOverlayLayout)   观察器按目标分派
6538  scheduleDetailOverlayLayout(overlay)                   drawDetailBlocks 尾部（切页后重画差异层）
```

**⚠ 漏改的后果是静默失效，不是红**：只改前三处，**切页（6538）与缩放（6535）两条路径不会重画差异层**——
差异标记是 px 定位、按 canvas 宽度算的，不重画就停在旧位置，而且**没有任何断言会红**。
这句话比清单本身重要，复核时按行号逐个点。

**顺带修掉一个真实的多余重画（Chief ④）**：拆之前，tile 每画一页 → `scheduleOverlayLayout` 成功那帧 →
`drawDiffLayer()`（重画**审校**的差异层）。拆完这条副作用消失 ⇒ 这不是纯搬家，是修 bug。
（事实更正：`observeOverlaySize` 本来就有两个调用点——`3086` 网格瓦片与 `6535` 审校 `drawDetailBlocks`；
成本来自 `scheduleOverlayLayout`，不是来自观察器的调用面。）

**拆完必须先跑一次机检（Chief ⑤）**：审校的差异层仍正常。现在有闸了——`eec53b9` 断言三件事：
共享调度器里 `drawDiffLayer` **0 次**、审校本地调度器 **1 次**、调用点只走 `scheduleDetailOverlayLayout` 版本。
补一条最小行为断言即可：`scheduleDetailOverlayLayout` 后 `drawDiffLayer` 被调 1 次。

**笔 B 还剩的**：把 `scheduleOverlayLayout` / `observeOverlaySize` / `layoutOverlayAnnotations` / `findOrderSpot` /
`findLabelSpot` / `pxRect` / `rectsOverlap` / 两个常量（共 161 行）搬进 registry，并按契约 §3 导出
`layout(container, {lineBboxes})` 与 `schedule(container, {onLaidOut})`；审校侧改为
`OverlayLayer.schedule(el("detail-overlay"), { onLaidOut: drawDiffLayer })`——**`onLaidOut` 这个参数就是为本处设计的**。

### 3.2 避让链搬家（逐函数实测；笔 B 开工前按当时树复核一遍）

| 函数 | 行 | 行数 | 说明 |
|---|---|---|---|
| `findOrderSpot` | 5923–5946 | 24 | 顺序号找空位（框外） |
| `findLabelSpot` | 5953–6001 | 49 | 卡片找空位 |
| `layoutOverlayAnnotations` | 6007–6049 | 43 | 摆号 + 摆卡片（读 `box._bbox`） |
| `scheduleOverlayLayout` | 6052–6064 | 13 | 90 帧重试（**拆掉 drawDiffLayer 之后**只剩布局） |
| `observeOverlaySize` | 6074–6087 | 14 | ResizeObserver |
| `pxRect` | 5820–5827 | 8 | 只有这条链用（6016/6019/6024） |
| `rectsOverlap` | 5829–5836 | 8 | 只有这条链用（5942/5994） |
| `BOX_ORDER_WIDTH` / `BOX_ORDER_HEIGHT` | 5811 / 5812 | 2 | 只有 `findOrderSpot` 与 `layoutOverlayAnnotations` 用 |
| **合计** | | **161** | 五个函数 143 + 四个"只被这条链用"的东西 18（契约里记的 143 只算了函数） |

迁移要点：
```
· `overlayResizeObserver` 是单例、按元素 observe：搬进 registry 后改成"一个观察器 + Map(元素→handle)"，
  卸载时 unobserve（否则 400 个 tile 重建成 400 个死引用——片 1 的 unmount 已经埋了这个坑，本片补上）
· `layoutOverlayAnnotations` 用 `box._bbox` / `box.dataset.blockId`：`_bbox` 是私有挂载，搬的时候改成
  `box.dataset` 或 handle 内部 Map —— **不许再往 DOM 上挂对象属性**（那正是"第二份状态"）
· 调度仍是 registry 那一个 rAF：避让只是"帧内多一趟"，不许再开第二个 rAF
```

### 3.3 新导出 `layout(container, { lineBboxes })`（Chief 2026-11-02 批）

**为什么需要**：审校的 `#detail-overlay` 不是 registry handle（它是审查视图自己画的差异层容器），
但审校的调度器要用 `layoutOverlayAnnotations`。不给口子，那 161 行就得在 app.js 留一份 = 两套算法。

```
API: layout(container, { lineBboxes })
  · 只做"摆现有 DOM"：不画、不登记 rAF、不碰 version、不改 data、不加 class（除摆位用的 inline style）
  · 幂等：同一容器同参数调两次，元素位置不变
  · 障碍物**只从参数来**（lineBboxes），不许读别人的私有属性（今天 layoutOverlayAnnotations 读 box._bbox，
    那段搬进 registry 时改成内部 Map；外部容器走 lineBboxes 这个显式参数）
  · 判据：`scheduleDetailOverlayLayout` 调 layout 之后，`#detail-overlay` 里的 `.box__order` 位置与改前一致

笔 B（2.2）落完之后：**"避让数学"全仓只许存在于 overlay-registry.js**
  app.js 里 findOrderSpot / findLabelSpot / layoutOverlayAnnotations / pxRect / rectsOverlap 定义 **0 次**
  （转发器 ≤6 行，且 2.2 末必须删掉）；判据：`grep -c "^function (findOrderSpot|findLabelSpot|layoutOverlayAnnotations|pxRect|rectsOverlap)"` = 0
```

## 4. 改动面预算

| 文件 | 动作 | 预算 |
|---|---|---|
| `overlay-registry.js` | + 容器 class 由 styles 决定（2.1）· + buildLabel 注入（2.2）· + 避让链 **161 行**（3.2，含 pxRect/rectsOverlap/两个常量）· + 新导出 `layout(...)`（3.3）· + `_bbox` 改内部 Map | **264 → ≤ 490**（264 + 161 避让全套 + 40 class/label + 20 观察器 = **485**；上限 490，**别去压分项——三项都是实测值**。契约记的 143 漏了 `pxRect`/`rectsOverlap`/两个常量） |
| `app.js` | 删 `renderPageBlocks`(36) / `clearPageBlocks`(9)；`buildTile` 里容器创建那 3 行（2734 一带）删掉、改 mount；`scheduleOverlayLayout`/`observeOverlaySize`/`layoutOverlayAnnotations`/`findOrderSpot`/`findLabelSpot` 搬走（143）；`paintTileMargin`(3138) / `clearTileMargin`(3160) 里两行 class 操作删掉、改 styles | **−190 ~ −200**（renderPageBlocks 会留到 2c 末才整段删，见 §0） |
| `pages-view.js` | 885 改 registry paint；**7 处** `clearPageBlocks`（86/893/926/1869/1879/2425/2477）改 `paint(active:[])`；882/2489/2522 的 `_renderedBlocks` 判重删掉（版本归 registry） | **−15 ~ −25** |
| `reading-view.js` | 3544/3547/2579 改 registry；2028 容器删；`is-linked` 三处保留（2.3） | **−10 ~ −15** |
| `index-view.js` | 337 容器删；826 改 registry；`drawIndexFirstLine` 不动 | **−8 ~ −12** |
| `app.js` deps | ReadingView / PagesView / IndexView / PreviewView 四个注入块里的 `renderPageBlocks` / `clearPageBlocks`，共 **8 个键**删掉（preview 那两个是片 1 遗留） | **删 8 个键，但 `deps 173 → 171`（−2）**：173 的口径只数 `window.PagesView?.init({…})` 那一个块，8 个里只有 pages 那 2 个在里面；另外 6 个在 ReadingView(34) / IndexView(34) / PreviewView(33) 的块里，**不改变 173 这个数**。写进提交说明，别让验收入拿 173−8=165 去对 |
| `index.html` / `app.css` | **不动**（class 全复用现有规则） | 0 |

## 5. 酸测试（在片 1 五条之上加四条）

片 1 的五条（版本/幂等/数量/旧路径归零/img Δ）**全部保留**，把消费者从 preview 扩到 pages/reading/index。新增：

| # | 断言 | 变异（必红） |
|---|---|---|
| ⑥ **避让生效** | 同页 8 个框、位置故意重叠：帧后相邻两个 `.box__order` 的 `left/top` **不相等**（都摆开了） | 让 `findOrderSpot` 恒返回原点 ⇒ ⑥ 红 |
| ⑦ **框外摆放（片 1 的债）** | `details:true` 时，`.box__order` 至少有 1 个的 `left` < 0 或 `top` < 0（即"框外"），且 order 的 `position` 计算值不是 static | 把 order 改成"框内右上角"（片 1 的临时做法）⇒ ⑦ 红 |
| ⑧ **marginMode 只走 styles** | `paint(..., {styles:{marginMode:true}})` 后容器有 `page-overlay--margin`；`styles.marginMode:false` 后没了 | 在 shell 里直接 `classList.add` ⇒ 闸（容器 class 唯一写点）红 |
| ⑨ **装饰白名单** | reading 路径：除 registry 外对 `.box` 的 classList 写入只出现 `is-linked`（静态扫 + 运行时 spy） | 在 reading 里给 `.box` 加第二个类 ⇒ ⑨ 红 |

## 6. 真机判据：把"块框"与"序号摆放"分开验（Chief ③）

片 1 只验了前者，序号摆放被推迟 —— 本片两组都要，而且**不许合并成一句"看起来一样"**：

```
A 组（片 1 已验，本片扩到三个视图，回归用）
  A1 位置：同一本书同一页，块框的 left/top/width/height 与改前逐框相等（读 DOM 的 style，不截图）
  A2 类型色：heading #4338ca / paragraph #2563eb / figure #15803d 与改前一致（getComputedStyle 的 border-color）
  A3 数量：`stats(pageNo).counts.blocks` == 有 bbox 的块数
  A4 hits 层级：`.preview-page__hits` 仍在块框之上（preview）；reading 的 `#reading-diff-layer` 不受影响

B 组（片 1 欠的债，本片首次验）
  B1 框外摆放：zoom≥2 时顺序号在框**外**（有 left/top < 0 的实例），与改前同页逐号位置差 ≤ 2px
  B2 hover 卡片：pages 上悬停某块 → `.box__label` 出现且**不被其它号覆盖**（findLabelSpot 生效）
  B3 hover 联动：reading 悬停 → 对应 `.box.is-linked` 出现，移开消失（片 1 之后这条路径没动过，回归用）
```

### 6.1 整体判据：同页四视图逐框对集（Chief 补，v1.1 按可执行性重写）

四个视图共用同一个渲染器，所以要有一次跨视图对集。但**原来的写法（"坐标逐项一致 ≤1px"）不可执行**，
两个原因（Chief 自纠）：

```
① .box 的 inline style 是百分比 ⇒ 跨视图可比；
   但 .box__order / .box__label 的 left/top 是 **px**，由 pxRect 用**容器宽高**乘出来。
   四个视图容器宽度各不相同（pages 的 tile 是 min(680px,100%) · reading/index 各自列宽 · preview 又不同）
   ⇒ 同一份数据、同一个渲染器，四处的序号 px **必然不同** ⇒ "逐项一致"是假红。
② 更深一层（**根因，§6.1 唯一值得长文解释的地方**）：**位号是尺度的函数**——
   容器变窄时找不到框外空位就**退回框内**（`layoutOverlayAnnotations:6032` 那句
   `const at = spot || { x0: own.x1 - BOX_ORDER_WIDTH - 2, y0: own.y0 + 2 }` 就是退回分支）。
   所以"同一渲染器 + 不同宽度 ⇒ 同一位号"**本来就不成立**：这不是判据执行得粗，是判据本身不成立。
   写成这一句，下一个人不会再去比绝对 px。
```

**改成两条可执行的**：

```
① 箱体几何（跨视图直接比）：读每个 .box 的 **inline style 百分比字符串**
   （`left/top/width/height` 形如 "12.345%"），四个视图**逐字相等**；不读 computed px。
   变异：给 pages 的 styles 多塞一个 items 少 1 条 ⇒ 数量与字符串集合立刻不一致 ⇒ 红

② 序号/卡片（要先统一尺度）：把四个视图的容器宽度**统一到同一个值（680px）**再比，三个细节写死：

   · **怎么统一**：四个容器都是块级、宽度来自 CSS ⇒ QA 直接 `style.width = "680px"` 覆盖即可
     （`.box` 是百分比定位会跟着缩放；`.box__order` 是 px 会随容器重算 ⇒ 这才是同尺度比较）
   · **量完必须恢复 inline width 原值**：否则 pages 的 grid 被撑坏，后面所有判据跟着假红
   · **比什么**：统一宽度后**高度也会变**（tile 的 aspect-ratio 来自图片，preview / pages 的图档不同时
     自然高度不同）⇒ 只比**"序号相对它所属 box 的偏移"**（`order.left - box.left` 这类），
     **不比绝对 left/top**。逐项差 ≤ **2px**（浮点与取整容差）。
   **四视图同等适用（Chief 2026-11-02 裁决）**：不再有"preview 的号恒 inside"这种例外——
   片 2 把避让恢复之后，`details:true` 的四个视图都会"框外有空位就框外、没有才退回框内"，
   所以同一页在四个视图里**逐号同类**是成立的判据（前提是尺寸已统一到 680px）。
   只有当某视图**读不到 680px**（不是"它的号天生不同"）才降级，分类**给死定义**（否则不可判）：

      分类 = { top, right, bottom, left, inside }   五类
        top/right/bottom/left = 号在框外的哪一侧（按号中心相对 box 边的方向）
        inside               = 框内（findOrderSpot 找不到空位时那条退回分支，见根因②）
      判据 = 四个视图**逐号同类**
   降级的适用范围写死：**只对"读不到 680px"的视图降级**，其余视图仍走 680px 的 px 对集；
   降级项要在验收记录里点名（哪几个视图降了、为什么），不许整条判据一起降级。
   **边界（Chief 补）**：降级视图 **≥2 个** ⇒ "剩下三个视图比 px"就落空了 ⇒ **本判据作废**，
   先解决尺寸统一再验；不许 QA 现场各写各的（回头对不上账）。

判据：① 全部逐字相等；② 在 680px 下的**四个视图**逐项 ≤2px，降级视图落位分类一致。
变异：把 layout 的"框外优先"改成"恒框内" ⇒ ② 的落位分类立刻不一致 ⇒ 红。
```

**它比任何单视图回归都值钱**：单视图只能证明"没坏"，这一条证明"真的是同一个渲染器"——
而且**判据本身必须尊重"尺度相关"这个事实**，否则它只会红一次然后被关掉。

### 6.2 指针两态（⑩，Chief 2026-11-02 判）

**写成两态，别写"带 labeled 与 margin 就能吃"**：

```
① 有 --labeled 且**没有** --margin  ⇒ .box 吃指针   getComputedStyle(box).pointerEvents === "auto"
② 有 --margin                      ⇒ .box 不吃      === "none"（容器也是 none）
```

**为什么必须分两态**：`app.css:901`（`--readonly.--labeled .box { pointer-events:auto }`）与
`app.css:903`（`.page-overlay.--margin, .page-overlay.--margin .box { pointer-events:none }`）是两条规则，
**特异度相同（各 3 个类）、903 在后 ⇒ 两者同时命中时 903 胜**。写成"两个类都有就能吃"会得出反的结论。

```
判据：① 在 pages（labeled、无 margin）上取 .box 的 computed pointerEvents === "auto"
     ② 切到版心视图（marginMode:true）后，同一个 .box === "none"，容器也是 "none"
变异：把 styles.marginMode 写死 false ⇒ ② 红（版心期间块框还吃指针，会挡住拖拽把手）
```

## 7. 不许顺手改

```
① 不动 `.box` / `.box__order` / `.box__label` 的 CSS（app.css 本片 0 行改动）
② 不动 reading 的 `#reading-diff-layer`（差异色块是另一条链，paintReadingDiffBoxes 不归本片）
③ 不把 `buildBoxLabel` 搬进 registry（它调 PageDetailEditor，模块→模块）
④ 不把 `is-linked` 改成 styles 重画（hover 抖版本、重建节点）
⑤ 不删 `previewTileBlocks` / `readingPageBlocks` / `indexBlocksByPage` / `pageBlockCache`（数据源仍归各视图/外壳，
   registry 只吃 paint 传进来的 data）
⑥ 本片不实现 `invalidate` / `hitTest`（仍无调用点）
```

## 8. 顺序与谁做

```
建议两笔落，各自可独立验收：
  2.1  拆 drawDiffLayer 耦合（§3.1）+ registry 长避让链 + pages 迁入
  2.2  reading + index 迁入 + 删 renderPageBlocks/clearPageBlocks + 六个 deps 键
（两笔都在 2.1 绿之后才动 2.2；2.2 落完 `_renderedBlocks` 应全仓 0 次）

做：Builder。我不写产品代码。
撞车：本片动 app.js（deps 六键 + 删函数）与 pages/reading/index 三个模块 ⇒ 与别的刀不可并行；
     index.html 与 app.css 不动。
```
