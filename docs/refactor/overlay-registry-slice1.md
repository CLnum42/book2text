# Overlay registry 第一片施工书（preview × blocks）

> **版本 v1.5（2026-11-02）**：记一条 Builder 落盘时撞出来的量，Chief 裁 **B 方案**——
> preview 今天调 `renderPageBlocks(..., {details:true})`，每个框里的 `.box__label` 是**死 DOM**
> （preview 的 `.box` 是 `pointer-events:none`，永远 hover 不到；`app.css:854/866–867` 的 label 只在 hover/active 出现），
> 而 `.box__order` 今天走**避让排布**（框外摆放，躲开彼此的号）。
> **裁决：本片不搬避让排布**——registry 只画盒 + 顺序号**固定框内右上角**（复用 `app.css:847 .box__order--inside`），
> 不建 label。视觉唯一差异是序号位置。**片 2 必须把避让排布一并搬并恢复框外摆放**（见 §6 第 ⑥ 条）。
>
> **版本 v1.4（2026-11-02）**：v1.3 缺一条**书里没写死的前提**（DevLead 核出）——
> **`mount` 在哪调**。选 (a)：**在 `buildPreviewPages` 的建块循环里 mount**（就是替换 181–184 那个容器创建，
> 每 tile 一个），因为今天的 DOM 就是每 tile 一个 `.page-overlay`，faithful port 没有第二种解释；
> 配套把 **`unmount` 写在重建/清空那一笔里**（`previewTiles.clear()` 之前，与 PageTile 的 release 同一处），
> 否则 registry 会留着指向旧 DOM 的句柄。若改成懒建 (b)，真机⑤ 要换成"只查已存在的层"，两边必须一致。
> 另补 ④ 的前提：**先打开块框开关并等块画出来**（没有 `.box` 时取不到 computed style）。
>
> **版本 v1.3（2026-11-02）**：v1.2 新加的两处不成立（DevLead 核出）——
> ① 真机判据⑤「点块框空白处仍能选页」在 preview 上**恒真**（`.preview-page` 没有 click 监听，
> 页号由滚动驱动），是空转判据；改成 `getComputedStyle(容器).zIndex === "2"`，这条才抓得到"挂错宿主"。
> ② §2.1 那句「子树外也丢掉只读规则」**不准**：`app.css:899/900` 是全局 `.page-overlay--readonly` 规则，
> 子树外丢的是 **z-index（2 → 1）**，只读与 `.box` 的 pointer-events 仍由 899/900 保证。
> ③ 顺着 ① 我也查出**真机判据④同样是空转**：preview 里没有任何 `.box` / `hits` 的点击处理器
> （`preview-view.js` 的 click 只有工具栏与分段条，:1008–1017），"点块框不跳转"永远不会失败。
> 改成 `getComputedStyle(任一 .box).pointerEvents === "none"`——测的是 readonly 真的生效。
>
> **版本 v1.2（2026-11-02）**：v1.1 → v1.2 两处更正（DevLead 独立核出、Chief 在 `13987ce` 复核）——
> ① `page-tile.js` 的钩子是 **7 行不是 3 行**（catch/notify 是给它专用的），净删 **−11** 不是 −7；
> ② 酸测试⑤ 的 `srcCount == 1` **判不出来**（fixture 不建 PageTile 时是 0），改成判 **Δ**。
> 另外补三条 CSS 事实（`app.css:899–901`）⇒ 容器必须挂在 `.preview-page` 子树里（§2.1）。
> **已独立核对（DevLead，`13987ce`）**：`preview-view.js` 的 183/191/363/366/371/372/394 与
> `page-tile.js` 的 243/256/257/276/277 行号全对；CSS 结论（容器带 `page-overlay page-overlay--readonly`
> 且挂在 `.preview-page` 子树 ⇒ `app.css` 0 行改动）成立；结构判据（只 append、不 querySelector）成立。
>
> **版本 v1.1（2026-11-01）**：Chief 批了，附四条条件；v1.1 已全部吃进来——① 酸测试①从"自己跟自己比"改成三条真断言 + 变异跟到能红的那条；② Ⅱ 的变异改成"删同版本早退"；③ 指纹成本开工先量；④ **容器 class 必须照旧带 `page-overlay page-overlay--readonly`**（v1 那条只加 `.overlay-layer` 会掉类型色/边框/只画不可点，见 §2.1）。
> **状态：已批准，等 Builder 落盘**（§8 ⑤）。
> 上位契约：`docs/refactor/overlay-registry-contract.md`（2026-11-01 批准）。**本片只做它 §6 的"片 1"**。
> 格式照 `docs/refactor/appjs-domains/first-batch.md`（服务模块形态已由刀 A 跑通）。
> **基线 = 开工时那棵树的实测值**，不从本文抄：本文写于 `4231b03`（app.js **12,658** · preview-view **1,088** · page-tile.js **420** · quality-stats.js **141**）。

## 0. 范围

```
新文件   backend/book2text/static/overlay-registry.js   （window.OverlayLayer）
改       backend/book2text/static/preview-view.js       块框改走 registry
改       backend/book2text/static/page-tile.js          删 paintOverlays 死钩子
改       backend/book2text/static/index.html            一行 <script>
改       backend/book2text/static/app.css               .overlay-layer 一条规则
新增     tests/js/overlay-registry-acid.mjs             5 条酸测试 + 5 条变异
不动     app.js（本片 0 行改动，理由见 §5）
```

**片 1 只搬 `type: "blocks"`，只搬 preview 一个消费者**。pages / reading 的块框、版心、建议标记全都留在原地。

## 1. 形态：它过不过 `domainDomProblems`？

刀 A 之后新增的闸（`boundary.test.mjs` 的 `domainDomProblems`）要求非视图服务模块里
`el(` / `document.getElementById(` / `.querySelector(` **各 0 次**。**本模块应当、也能过这道闸**（⑤ 的答案）：

```
它拿什么：mount(hostEl, { pageNo }) —— host 由视图给（preview 给页块元素），不按 id/class 找。
为什么不许 querySelector：它不需要找任何东西——**图层容器是它自己 createElement 出来的**，
   句柄里一直握着那个容器的引用；要换内容就换"容器里的子树"，不去 DOM 里捞。
与刀 A 的差别一行说清：刀 A 只用两个已有元素（外壳查好传进去，连 root 都不用）；
   registry 要给"任意 host"挂图层，所以它必须有 host ——但**拿到 host 之后只 append，不查询**。
判据：DOMAIN_MODULES 里加一项 { file: "overlay-registry.js", exposes: "OverlayLayer" }，零豁免通过。
```

## 2. 改动面预算（①）

| 文件 | 动作 | 预算 | 判据 |
|---|---|---|---|
| `overlay-registry.js`（新） | 骨架 + 一个渲染器 + 指纹 + 诊断 | **≤ 240 行**（骨架 90 / blocks 渲染 60 / 指纹与稳定序列化 30 / stats 与 unmount 30） | `wc -l`；超 240 要写明多在哪 |
| 同上 | **那 60 行"blocks 渲染"里不含避让排布**（v1.5） | 避让排布 **不搬**：`findOrderSpot`(6426,24) · `findLabelSpot`(6456,49) · `layoutOverlayAnnotations`(6510,43) · `scheduleOverlayLayout`(6555,13) · `observeOverlaySize`(6577,14) = **函数体 143 行**（连其间注释约 165 行） | 若发现 registry 超 240 行且超在"摆号"上 ⇒ 说明有人把避让排布偷搬了一半 |
| `preview-view.js` | 删自建 `.page-overlay`（181–184）；`tile.append` 去掉 overlay（191）；`paintPreviewTile` 改走 registry（363–372）；清屏路径改 `paint(active:[])`（394） | **净 −8 ~ −12 行** | `wc -l` 前后差；`page-overlay` 在该文件 0 次 |
| `preview-view.js` **`mount` 的位置（写死，v1.4）** | **在 `buildPreviewPages()` 的建块循环里**：181–184 那三行的位置改成 `tile.__overlayLayer = window.OverlayLayer.mount(tile, { pageNo })`。**每 tile 一个**（今天也是每 tile 一个 `.page-overlay`） | +1 行（替换掉 3 行） | 真机⑤ 依赖这条：每个 `.preview-page` 都该有 `.overlay-layer` |
| `preview-view.js` **`unmount` 的位置（写死，v1.4）** | **重建/清空那一笔**：`previewTiles.clear()` 之前遍历 `tile.__overlayLayer` 逐个 `unmount`（与 148–152 释放 PageTile 句柄同一处、同一理由） | +4~6 行 | 不 unmount ⇒ 注册表留着指向旧 DOM 的句柄——PageTile 148 那条注释说的正是这件事 |
| `page-tile.js` | 删 `injected.paintOverlays` 钩子——**整个 if 块 207–213（7 行）**：`:207` if · `:208` try · `:209` 调用 · `:210` catch · `:211` notify · `:212` `}` · `:213` `}`。**catch/notify 是给这个钩子专用的，没有别的 try 可挂，必须一起删** | **−7 行**（必删） | 全仓 `paintOverlays` 0 次 |
| `page-tile.js` | 顺带删随钩子一起死的字段：`overlays: opts.overlays`（**256**）· `state: null`（**257**）· `"overlays" in changes`（**276**）· `"state" in changes`（**277**） | **−4 行**（建议同批） | 不删 = 留下一条没人读的死数据（本项目的"只涨不消"） |
| `page-tile.js` **合计** | 钩子 7 + 死字段 4 | **−11 行** | 净行数按 `wc -l` 前后差 |
| `index.html` | 在 **page-tile.js 之后、step-timing.js 之前**加一行 | **+1 行** | 顺序见 §8 撞车规则 |
| `app.css` | **不改**（v1 说加一条 `.overlay-layer` 规则——**错的**，见 §2.1） | **0 行** | 容器 class 照旧 `page-overlay page-overlay--readonly`，现有规则全部生效 |

### 2.1 容器 class 必须照旧带 `page-overlay page-overlay--readonly`（Chief 在 v1 里抓到的坑）

v1 让 registry 建一个 `div.overlay-layer` 再配一条新 CSS 规则——**那会掉样式**。盒的样式全部挂在 `.page-overlay` 下：

```
app.css:786      .page-overlay { position:absolute; inset:0; z-index:2 }
app.css:788      .page-overlay .box { … }                      ← 边框/背景基类
app.css:794–804  .page-overlay .box--type-heading/paragraph/figure…   ← 按类型的框色
app.css:899      .page-overlay--readonly { pointer-events:none; z-index:1 }        ← 只读变体的基准
app.css:900      .page-overlay--readonly .box { pointer-events:none; … }
app.css:901      .page-overlay--readonly.page-overlay--labeled .box { pointer-events:auto }
app.css:1956     .preview-page .page-overlay { z-index:2 }     ← preview 把只读容器的 z 从 1 抬到 2
app.css:1957     .preview-page .page-overlay--readonly .box { pointer-events:none }  ← "只画不可点"
app.css:1958     .preview-page__hits { z-index:3 }              ← hits 在块框之上
```

**两条一起成立才算对**：
1. 容器 class = `overlay-layer page-overlay page-overlay--readonly`；
2. 容器 **挂在 `.preview-page`（tile）子树里**——需要子树的是 **z-index 那一条**：
   `1956 .preview-page .page-overlay{z-index:2}` 是后代选择器，挂在子树外就没有它，容器退回 `899` 的
   `z-index:1`（**会落到 hits 之下或被其它层盖住**）。**只读与"块框不吃点击"不受影响**——
   `899/900` 是全局 `.page-overlay--readonly` 规则，与子树无关（`1957` 只是同规则的更高特异性重复）。
   片 1 的 `mount(hostEl)` 传的就是 tile 本身，天然满足；**这一条要点名写进 review**，因为"传错一个元素"不会红
   ——真机那条 `zIndex === "2"` 是它的兜底。

⇒ **registry 建的容器 = `div.overlay-layer page-overlay page-overlay--readonly`**（`overlay-layer` 只作标识/诊断钩子，不承担样式）；
**不新增**任何抢 z-index 的规则——`.preview-page .page-overlay{z-index:2}`（:1956）已经对。

**`ptile__overlays` 槽这次不动**（page-tile.js:243）：它是"一个合法宿主"，但片 1 的 host 是 preview 的页块元素，
不是这个槽。删它属于另一刀（等有视图真的用 PageTile 的槽时再定），**本片不删不宣**。

## 3. API（片 1 子集，只实现这六个）

```js
window.OverlayLayer = {
  init({ notify }),                                  // boot 之后由 preview 首次调用即可（幂等）
  register({ type, z, render }),                     // 片 1 只注册 "blocks"
  mount(hostEl, { pageNo }),                         // → handle；容器由本模块 create
  unmount(handle),
  paint(handle, { data, active, styles }),           // 登记到唯一 rAF，帧末消费
  stats(pageNo),                                     // { version, counts:{blocks:n}, geomHash }
};
```

**本片**不实现 `invalidate`、`hitTest`、`unregister`（没有调用点，按刀 A 的规矩不导出、不写空壳）。

## 4. 五条酸测试（写成断言 + 每条一个变异）

文件 `tests/js/overlay-registry-acid.mjs`，形态照 `tests/js/page-tile-acid.mjs`：**模块存在理由的证明**，
不是行为单测。夹具复用 `tests/js/tile-harness.mjs` 的 `makeElement`（它有 `append/appendChild/removeChild/
children/dataset/classList`）；**本模块不依赖 `insertBefore` / `replaceChildren`**——换内容是"先 append 新子树、
再 remove 旧子树"，两种 DOM 都成立。

| # | 断言（可执行的写法） | 变异（必须红） |
|---|---|---|
| ① 版本一致（v1.1：v1 那条是**自己跟自己比**，恒真） | 三条：**(a)** 同内容 paint 两次 → `v1 === v2`；**(b)** 改一个块的 `bbox` 再 paint → `v2 !== v1`；**(c)** 容器里每个元素 `dataset.version === stats(12).version` | `fingerprint` 改成恒返回 `"1"` ⇒ **(b) 必红**（v1 那版断言下它仍然绿——这是 Chief 抓到的漏洞） |
| ② 幂等（不重复画） | 同数据连续 paint 两次，帧后 `const first = container.lastChild.firstChild;` 再 paint → `container.lastChild.firstChild === first`（**节点身份**，不是数量） | **删掉同版本早退分支** ⇒ ② 红（v1 的变异走不到：同版本早退时交换那段根本不执行） |
| ③ 数量 | `stats(12).counts.blocks === blocks.filter(b => b.bbox).length`（**没有 bbox 的块不画**，与今天 renderPageBlocks 一致） | 去掉 `.filter(b => b.bbox)` → ③ 红 |
| ④ 旧路径归零（Chief 要求点名行） | `preview-view.js` 里 `page-overlay` **0 次**、`_renderedBlocks` **0 次**、`injected.renderPageBlocks` **0 次**；被删的三处原位置（`183` 容器创建 / `371` 缓存比较 / `372` 注入调用）在落盘后的文件里**各 0 次命中** | 把 `injected.renderPageBlocks` 留一句注释调用 → ④ 红（剥注释后仍能命中才算数：改成留一行真调用更直接） |
| ⑤ 图不受影响（v1.2：判 **Δ**，不再判绝对值） | **基线**：建一个 `PageTile(size="view")` + show/settle 一次 → `srcCount("view") === 1`；**再**挂 registry + 同数据 paint 两次 → `srcCount("view")` **仍 === 1**（即 **Δ == 0**）。仍然**不数网络**（`max-age=300` 会让重复请求命中缓存，按网络数会漏判） | registry 自己建 `<img>` → **Δ == 1** ⇒ 红 |

### 4.6 指纹成本：开工先量一个数（Chief 条件 c）

每次 `paint` 都要 `stableJSON + FNV-1a`。**开工第一件事**量两个数贴进提交说明：

```
① 单页块数上限：拿 512 页那本书，`Math.max(...pages.map(p => blocksOf(p).length))`
② 一次 fingerprint 的毫秒数：同一份 data 跑 1000 次取均值（node 或真机 console 都行）
```

**阈值**：一次 > **2ms**，或单页块数 > **2000** ⇒ 停下来先议（那时该按 `pageNo` 缓存指纹，或退到 §23.4b 的 (b) 方案）。
不超过就照现在做，**别等真机上卡了才回头**。

**提交要求**：提交说明里逐行写「`preview-view.js:183` → 删自建容器」「`:371` → 删缓存比较」「`:372` → 删注入调用」，
与判据 ④ 一一对应。验收只看这一行 + `git show`，不看描述。

## 5. 与已批契约的**一处偏离**（**已批**，2026-11-01；三条收紧已并入 §4）

契约 §4 写的是「注入 `getVersion(scopeKey)`」。片 1 按下面做，理由三条：

```
改为：版本由 registry 内部算 —— fingerprint(data) = FNV-1a(stableJSON(data))，输入是**本次 paint 的 data**。
① registry 手上没有 scopeKey → data 的映射：scopeKey 是 "blocks:12"，而 data 是视图给它的一页块；
   要按 scopeKey 取，等于让外壳再算一遍同源数据 —— 那就是两个来源（今天 _renderedBlocks 的病根）。
② 它hashes 的正好是它要画的那份 data ⇒ "版本描述的就是即将绘制的数据"，这是比注入更强的保证。
③ 不注入就不需要 app.js 参与 ⇒ 本片 app.js 0 行改动，与 Builder 的 B/C/D 完全不撞（见 §8）。
契约里"内容指纹、不是人工 bump"这条没有变；变的只是"指纹在哪算"。
```

## 5.5 `render` 必须无状态（review 判据，Chief 条件 ②）

指纹只覆盖 `{data, styles}`（§5）。如果渲染器偷读闭包 / 全局状态，**数据没变 ⇒ 不重画 ⇒ 界面不更新，
而五条酸测试全绿**——这是"版本一致"这条判据的盲区，闸抓不到，只能靠 review。

```
判据（人看的，写死在这里）：render(item, style) 只许读它的两个参数。
  任何额外输入（当前步骤、读数开关、选中态…）必须先变成 data 或 styles 的一部分。
review 清单：提交前把 render 函数体逐行过一遍，出现函数外的标识符（除字面量与纯工具函数）就停下。
反例形态：`if (currentStep === "review") box.classList.add("hot")` —— 指纹不变，画面该变却不变。
```

## 5.8 本片对渲染的简化：序号固定框内右上角（B 方案，Chief 裁决 2026-11-02）

```
本片画什么：盒子（位置/尺寸/类型色）+ 顺序号，号固定在框内右上角（复用 app.css:847 .box__order--inside）
本片不画：.box__label（类型卡片）——它在 preview 里今天就是死 DOM（.box 是 pointer-events:none，hover 不到）
本片不搬：避让排布（143 行函数体）——它自带第二个调度器（scheduleOverlayLayout 的 90 帧重试 + ResizeObserver），
         且成功帧里会调 drawDiffLayer()（审校视图的副作用）⇒ 违反"registry 内部恰好一个 rAF"
为什么不用 A（同一套算法两份并存到片 2）：契约 §1 禁的正是"两套路径"
为什么不用"注入 app.js 的 layoutOverlayAnnotations"：带进第二个调度器 + 夹带审校副作用，两条都越界
```

**视觉差异只有一处**：序号从框外（避让后）变成框内右上角。真机上要确认"框色/数量/位置/hits 层级"四条不变——
序号位置变了**不算回归**（它是有意简化），但要写进片 1 的提交说明，别让人以为是错位 bug。

## 6. 不许顺手改（本片清单）

```
① 不动 pages / reading 的块框与版心（它们仍用 injected.renderPageBlocks / paintTileMargin）
② 不动 renderPageBlocks 本身（它还在给另外两个视图用；等最后一个消费者搬走才删）
③ 不改 `.page-overlay` 的现有 CSS（preview 不再用它，但 pages / index 还在用）
④ 不给 registry 加 hitTest / invalidate / 数据加载（没有调用点）
⑤ 不动 page-tile.js 的 `ptile__overlays` 槽（留待用它的视图出现）
⑥ **片 2（pages / reading 迁进 registry）必须一并搬那 143 行避让排布，并把序号的框外摆放恢复**——
   否则片 1 这个简化会变成永久技术债：preview 的号永远在框内，pages 的号在框外，同一页在两个视图里长得不一样。
   判据写在片 2 的书里：`drawDiffLayer` 的调用点必须在迁移时重新安置（它是审校视图的副作用，不许跟着调度器进 registry）。
```

## 7. 验收对集（落盘时逐行填，基线从开工树现数）

| 项 | 期望 |
|---|---|
| 基线 | `git rev-parse --short HEAD` + 现数 app / preview / page-tile 行数（**不抄本文的数**） |
| app.js | **0 行改动**（本片不碰它） |
| preview-view.js | 净减（预算 −8 ~ −12）；`page-overlay` / `_renderedBlocks` / `renderPageBlocks` 各 0 次 |
| page-tile.js | **−11 行**（钩子 **7** 行 207–213 + 死字段 4 行）；全仓 `paintOverlays` 0 次 |
| deps | **本片不动**（preview 的两个键留到最后一个消费者搬走那一刀删，见 §6②） |
| 域模块闸 | `DOMAIN_MODULES` 加 `overlay-registry.js` 后零豁免通过（含 `.querySelector(` 为 0） |
| 酸测试 | 5 条全绿 + 5 条变异各自红（变异要跑一次给人看，不写"应该会红"） |
| 四闸 | node + pytest 全绿；R3 pages total 0 不变 |
| 真机 | ① 块框位置与数量与改前一致（同一本书同一页，截图对比）；② **按类型的框色与改前一致**（heading 靛 `#4338ca` / paragraph 蓝 `#2563eb` / figure 绿 `#15803d`）；③ **hits 浅绿层仍在块框之上**；④ **`getComputedStyle(任一 .box).pointerEvents === "none"`**（readonly 真的生效；原写法"点块框不跳转"在 preview 上是空转——没有任何 box 点击处理器）。**前提：先打开块框开关并等块画出来**，没有 `.box` 时取不到 computed style；⑤ **层级与归属**：真机 console 跑一段（不依赖任何交互）——`document.querySelectorAll(".preview-page").forEach(p => { const layer = p.querySelector(".overlay-layer"); 断言 layer 存在 && layer.classList.contains("page-overlay--readonly") && getComputedStyle(layer).zIndex === "2"; })`。挂在 `.preview-page` 子树外 ⇒ `1956` 不命中 ⇒ 退回 `899` 的 `1`，这条立刻红 |

## 8. 谁做、怎么让（⑤ 的答案）

```
做：**Builder**。我不写产品代码——我的边界是书（形态、判据、改动面）。
让：
 ① 本片**不动 app.js**（§5 第三条理由顺带解决撞车）；Builder 的刀 B/C/D 在改 PagesView/IndexView 的 deps 块，
    本片一个字符都不碰它们，可以并行。
 ② 唯一的共享文件是 `index.html`：**本片那行紧挨 page-tile.js 之后**，Builder 的四个服务模块行排在它之后。
    谁先落都能 rebase，冲突只是一行位置。
 ③ `app.css` **本片 0 行改动**（§2.1：容器照旧挂 `page-overlay page-overlay--readonly`，不新增规则）；B/C/D 也不动 CSS。
 ④ **顺序（Chief 定）**：刀 B（在做）→ **T0**（左树默认模式丢无章节页的缺陷修，小且卡 QA 复验）→ **本片** → 刀 C/D。
```
