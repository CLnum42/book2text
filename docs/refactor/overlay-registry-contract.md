# Overlay 图层 registry：可施工契约

> **状态：草案，等 Chief 批；批了才有人动代码。** 作者 Architect，2026-11-01。
> 量数树：`main@20049f9`（app.js 12,755 · pages-view 3,907 · reading-view 3,680 · preview-view 1,088 · page-tile.js 18,254B）。
> 上游契约：`reading-view-boundary.md` §23（2026-10-29 定稿，未实现）。**本文不改 §23 的语义，只把它变成能开工的形态**，
> 并**改掉它的一条**（调度器归属，见 §7，附理由）。

## 0. 一句话

**一个全局 registry（渲染器按"视觉元素类型"注册一次）+ **每个宿主**一个图层句柄（host 由视图给）；
版本是内容指纹（纯函数），重画是"先建后换"，重画调度只有 registry 里那一个 rAF。**

## 1. 为什么现在做（实测，不是判断）

```
① 同一份"版本缓存"今天散在 6 个文件、9 处：`overlay._renderedBlocks`
   app.js:3574 / :3611 / :3614 · pages-view:877 / :2457 / :2490 · preview-view:371 ·
   reading-view:3544 · index-view:826
   ——它没有定义、没有类型、没有清理责任人；一处忘了比，就静默不重画（或重复画）。
② 四个地方各自造图层容器：app.js:3191（页面网格的 buildTile）· index-view:337 ·
   preview-view:183 · reading-view:2028
   ——同一个 `.page-overlay` 类名，四份实现，样式的合法性靠"大家都照着抄"。
③ 绘制函数留在外壳、被四个视图经 `injected.` 调用（§23.1 说的"8 叶子 × 5 消费者"）：
   renderPageBlocks（app.js:3570）· paintTileMargin（:3641）· applyTileState（:3278）·
   paintTileSuggestionMark（:3025）
④ 今天的重画是 **清空再逐个 append**：`renderPageBlocks` 第一句就是 `overlay.innerHTML = ""`（app.js:3572）
   ——§23.5 明令禁止的那个形态（撕裂来源）。
⑤ PageTile 里的 overlay 缝是**死的**：`injected.paintOverlays`（page-tile.js:207–209）
   全仓 **0 个提供者**；preview 建句柄时只传 `{pageNo, size, onReady}`（preview-view:266–270），
   从不传 `overlays`/`state`。`.ptile__overlays` 也没有任何 CSS。
   ⇒ 这是一条"两套路径"的雏形，按本项目惯例必须**删掉其中一条**。
```

## 2. ① 归属：谁拥有它

| 被问 | 裁定 | 理由 |
|---|---|---|
| 一个 view 一份？ | **不是** | 那正是今天的形态（四份容器 + 六处缓存），同一页在三个视图里长得不一样 |
| 一个 scope 一份？ | **不是** | scope 只是"这次画哪几个 type"，不是所有权单位 |
| 跨视图共享？ | **是** | 渲染器按类型全局一份；层级（z 序）与命中测试只有一处管（§23.3） |

**所有权三层，写清楚，别混**：

```
registry（window.OverlayLayer）  拥有：类型注册表、z 序、**每个宿主的**图层 DOM、重画调度、版本比较
视图                            拥有：① 窗口内是哪几页 ② 这一步 active 哪些 type ③ 每种 type 的数据
PageTile                        拥有：那张 <img>、尺寸档、取图与释放（与本模块无引用关系）
```

**视图不拥有图层的 DOM**：视图只给一个宿主元素 + pageNo，`mount()` 之后图层 DOM 归 registry；
视图要清就 `unmount`，不许自己 `innerHTML = ""`。

**唯一性是"一个宿主一个图层"，不是"一页一个图层"（2026-11-02 真机证伪后改）**：

```
正确不变量：hostEl → handle，一对一；同一页可以有**多个宿主**（每个视图各一份），互不影响
错误假设（已作废）：pageNo → handle。原实现 `Map<pageNo, handle>` + "同页再 mount 就 unmount 旧的"
实测后果：preview 的 buildPreviewPages 给 490 页每页都 mount ⇒ 把同号的 pages 句柄全部顶掉（unmount）
          ⇒ 回到 pages 时 `grid_layers 490 → 0`、`tile.__overlayHandle` 成死句柄、paint 静默 no-op
⇒ pageNo 降级为**元数据**（进 stats / 诊断 / dataset），**不做唯一键**；唯一键是 hostEl 的引用
```

**为什么这条错得隐蔽**：四个视图各自 mount 同一批页号时，单视图测试全绿（每次 mount 都建立在"别人没挂"的前提下）；
只有"两个视图同时挂着"才会露出——而 preview 一次性挂满 490 页，正好构造了这个场景。

## 3. ② API 草案（逐个：签名 / 谁调 / 何时）

**十项**——**登记面 10 项，今天实现 6 项**，这个差不是笔误（`window.OverlayLayer` 现在只挂
`init` / `register` / `mount` / `unmount` / `paint` / `stats`，片 1 实测）：

```
已实现 6：init · register · mount · unmount · paint · stats
未实现 4：unregister（只给单测） · invalidate（无调用点） · layout · schedule（片 2 要加）
          ——「没有调用点不导出」是刀 A 定下的规矩，所以未实现的四项不写空壳
```

片 2 之后应为 **8 项**（+`layout` +`schedule`）。

```js
window.OverlayLayer = {
  init(deps),                                       // deps = { buildLabel, notify }（片 2 起；getVersion 归内部指纹）
  register({ type, z, scaling, render, hitTest }),   // 全局一次：一种视觉元素一个渲染器
  unregister(type),                                  // 只给单测/清场，产品路径不许调（未实现）
  mount(hostEl, { pageNo }),                         // → handle
  unmount(handle),
  paint(handle, { data, active, styles }),           // 视图：数据到了就叫，可按帧合并
  invalidate(handle, types),                         // 任何人：只置脏，不立即画（未实现）
  layout(container, { lineBboxes }),                 // 一次摆：幂等、不画、不碰 version、不排帧（片 2 新增）
  schedule(container, { onLaidOut }),                // 排到可测为止：token + rAF + 90 帧重试，成功回调（片 2 新增）
  stats(handle),                                     // ★ 判据唯一可用形式：{ version, counts, geomHash }
  stats(pageNo),                                     // ⚠ 诊断专用（多宿主时有歧义，见 §3.1）
};
```

| 成员 | 谁调 | 何时 | 约束 |
|---|---|---|---|
| `init` | **app.js 的 `boot()` 一次** | boot 最末、视图 init 之前 | 幂等；`getVersion` 只能有一份（多消费者各传一份 = 三个版本的开始） |
| `register` | boot 一次（模块自己登记内置类型） | `init` 之后、第一次 `paint` 之前 | `type` 全局唯一；重复注册 = 红 |
| `mount` | 视图 | `tile.create()` 之后（图不必到） | 宿主由视图给；**registry 不许按 class/id 找 DOM**（§21 同一条）；**唯一键 = hostEl，`pageNo` 只是元数据**（同页多宿主合法） |
| `unmount` | 视图 | `tile.release()` **之前** | 顺序硬约束；宿主从 DOM 消失 = no-op + 一次 warn（§23.5c）；**但句柄还在、只是 layer 掉了 = 自愈重挂**（见下方不变量） |
| `paint` | 视图 | 数据到达 / `invalidate` 之后 | **不立即画**：登记到 registry 唯一的 rAF，帧末统一消费 |
| `invalidate` | 视图、协作层（写盘回调） | 一处数据变了 | 不碰 DOM，只置脏 |
| `stats(handle)` | **判据（酸测试 / e2e 断言）** | 帧末之后 | 只读，不许有任何副作用；**同页多宿主时唯一无歧义的形式** |
| `stats(pageNo)` | **诊断（人看一眼）** | 任意 | 只读；**判据不许用它**（多宿主时语义歧义，见 §3.1） |
| `layout` | 视图 / 审校详情（`#detail-overlay` 不是 handle） | 数据到了、容器里的节点已存在时 | **一次摆**：幂等、不画、不碰 version、不排帧；障碍物只从 `lineBboxes` 参数来，**不许读别人的私有属性** |
| `schedule` | 视图 / 审校详情 | 内容刚建、图可能还没出来时 | **排到可测为止**：token 取消前一次 + rAF + 90 帧重试；成功后调 `onLaidOut`。同一容器只许一个调度 |

**`layout` / `schedule` 的分工（别以为是冗余）**：

```
layout   = 一次摆（"现在就摆一下"）：幂等、无调度、无重试；给"节点已经在 DOM 里、尺寸已经可测"的场合
schedule = 排到可测为止（"以后摆，摆到测得出为止"）：token + rAF + 90 帧；给"刚建好、图/字体还没落"的场合
两者都只做**定位**，不做绘制；paint 内部就用 schedule ⇒ **重试循环全仓只有一份**。
```

**为什么必须导出（不是临时口子）**：

```
· 审校的 #detail-overlay 不是 registry handle（review 自己画那个容器），但它的顺序号/卡片同样要避让排布
  ⇒ 没有 layout/schedule，那 161 行就得在 app.js 留一份 = 两套算法（契约 §1 否掉 A 的同一个理由）
· 过渡期内 reading / index 仍走旧的 renderPageBlocks，也需要同一套"排到可测"；
  若转发器自己再写一遍 90 帧重试，同样变成两份
· 片 2 之后审校那条路径**长期**需要它 ⇒ 按 STABLE 登记、不写死期
```

### 3.1 `stats` 的两个签名：判据用 handle，诊断用 pageNo（Chief 2026-11-02 定）

```
stats(handle)   ← 唯一可用于判据的形式。同页多宿主时唯一无歧义（handle 就是那一层）
stats(pageNo)   ← 保留，但只作诊断：多宿主时返回**最近 mount 的那一层**（lastByPage）
                  文档与代码注释都必须写「判据不许用它」
```

**(a) 为什么留两个**：同页多宿主是**合法状态**（preview 与 pages 可以同时挂着同一页 490 个句柄），
`stats(pageNo)` 在这种状态下语义天然歧义——留着当判据就是给下一个人埋坑。
但直接删会破坏既有酸测试与诊断脚本，所以降级为"看一眼用"。

**(b) 多宿主时 `stats(pageNo)` 的具体行为**：

```
· 返回 `lastByPage.get(pageNo)` 那一层（即该页**最近一次 mount** 的句柄的 stats）
· **不 warn、不抛**——它是诊断口，噪音只会让人不敢用
· 该页一层都没挂着 → 返回 null（与"有层但 counts 为 0"必须可分辨）
```

**(c) 与 ④b 判据的关系**：④b（同页两宿主互不影响）**必须用 handle 形式写**：

```
✅ 正确：const a = mount(hostA,{pageNo:12}); const b = mount(hostB,{pageNo:12});
        paint(a, …); 断言 stats(a).counts.blocks > 0 && stats(b).counts.blocks === 0
        unmount(a);  断言 stats(b) 仍是 b 那一层（version/counts 不变）
❌ 错误：unmount(a) 后去断言 stats(12) —— 那时它返回的是 b（lastByPage 仍指向 b），
        这条断言在"两个 handle 互相影响"的实现下也可能绿 ⇒ 判不出 ④b 要判的东西
```

**判据的通用规则**（写进 §6 抬头）：**凡断言"某一层"的状态，一律 `stats(handle)`；
`stats(pageNo)` 只允许出现在"人看一眼"的诊断输出里**——出现即视为判据写错。

**死句柄自愈（2026-11-02 新增不变量）**：`paint(handle)` 时若 `handle.layer` 已脱离文档
（宿主被替换 / 视图重建了瓷砖但没 unmount / 句柄被顶掉后又被复用），**registry 必须就地重新 mount**——
在新宿主上重建 layer 并把 `handle.layer` 指过去，然后照常画。**不许静默 no-op**。

```
为什么：静默 no-op 的失败是"画不出来但也不报错"，四闸全绿、真机上是一片空白。
今天 §23.5c 写的是"遇到脱离文档的宿主 → no-op + warn"——那条是给"视图忘了先 unmount 就 release"留的兜底，
  但它把"句柄还活着、宿主换了"这种情况也一起吞了。两者必须分开：
  · 视图忘了 unmount 且宿主从 DOM 消失（tile 被删）→ no-op + warn（保持 §23.5c）
  · 句柄还在、宿主换了/被复用（layer 不在文档里）→ **重新 mount**（自愈），不 warn 不静默
判据：把 handle.layer 从 DOM 摘掉（或整体替换宿主节点的子节点），再 paint 一次 ⇒
      layer 回到宿主里、counts 与 version 正常；不许"没报错但也没画"。
```

**`render(item, style) → Element` 必须无状态**（只吃 item + style，不读全局，不读 `currentView`）；
**`hitTest(item, pagePoint) → boolean|null`** 只回答"命中谁"，点击做什么归视图（§23.6）。

**重画调度（本契约唯一一处改 §23 的地方）**：§23.2① 写"必须复用 `queueReadingIntent` + 帧末消费"。
那条**不成立**：`queueReadingIntent` 是 reading 视图的私有调度器，共享模块去依赖它 = R2 违规（模块依赖某个视图）。
改成：**registry 内部恰好一个 rAF 循环**，帧末对"已置脏的 handle × type"各画一次。
"不许有第二套调度器"的本意是**同一页的重画不许有第二个调度点**——这条不变：视图自己不许再排 rAF。

**同一容器只许一个调度（片 2 明确）**：`schedule(container, …)` 用容器上的 token 取消前一次——
重复调用不是叠加，是"后一次取代前一次"。判据（可机检）：对同一容器连调 `schedule` 三次，
`onLaidOut` 只被调 **1** 次（前两次被 token 作废）。

**重试循环全仓只有一份（可机检）**：

```
判据：app.js 里 `attempt < 90` 命中 **0** 次；`attempt` 这个参数名只出现在 overlay-registry.js
      （片 2 落完之后；过渡期内允许 app.js 有转发器，但转发器 ≤6 行且不许自己写重试）
```

## 4. ③ dataVersion：内容指纹

**来源**：注入的 `getVersion(scopeKey)`（纯函数，§23.4b 已定；不改）。

**scopeKey 约定**：`${type}:${pageNo}`，一页一类一份。例：`blocks:12`、`marks:12`、`margin:12`。
**scopeKey 不许带视图名**——同一页的块框在三个视图里是同一份数据，带视图名就等于承认"三个口径"。

**怎么比**（`paint` 时，逐 type）：

```
v     = getVersion(scopeKey)          // 帧末对"即将绘制的 key"算一次，成本随屏幕内容走
s     = stableJSON(styles)            // 样式也是渲染输入：样式变了必须重画，否则"1× 和 2× 是两个东西"
if (handle.painted[type] === `${v}|${s}`) → 跳过（幂等）
else → 重画该 type，写完把 painted[type] 设成新值，并把 dataVersion 写到每个元素的 dataset
```

**不一致时谁负责重画**：**registry**。视图只负责"数据变了叫一声"（`invalidate` 或再 `paint` 一次），
不许自己判断"要不要重画"——今天那 9 处 `_renderedBlocks` 比较就是"视图替 registry 干了这活"。

**写盘路径的约束**（9.3 的教训，`knife-numbering.md` §七）：`invalidate` 不许挂在无关请求之后；
写盘成功 → 读回 → 紧接 invalidate。

## 5. ④ 与 PageTile 的关系

```
两个模块，谁也不引谁（§23.3 已定，本文不改）
  PageTile 只认宿主元素；OverlayLayer 也只认宿主元素 + pageNo
  **两者对"同页多宿主"的答案相反，别混**：
    PageTile 的图是"一页一张"——同页两个宿主会**移动**那张 img（§21.10：先 release 再 create）；
    OverlayLayer 的图层是"一个宿主一份"——同页 490 个宿主就是 490 个图层，互不影响（本条 2026-11-02 改）
```

**裁定：删掉 `injected.paintOverlays` 钩子**（page-tile.js:207–209）。理由三条：

```
① 它全仓 0 提供者（§1 ⑤），是死缝，留着就是"第二套路径"的入口；
② 它把绘制时机绑在 tilePublish（图到了才画）——而 overlay 的数据与图无关，块框该在文字到达时就出；
③ 它是第二套调度点：tilePublish 是同步回调，registry 帧末消费，两者会互相打脸。
```

**`.ptile__overlays` 槽**：保留 DOM（无害），降级为"**一个合法的宿主元素**"——视图可以把
`handle.slot` 传给 `mount()`，也可以传自己的容器。**它不是唯一宿主**，因为页面网格的瓷砖今天由
外壳的 `buildTile`（app.js:3180）建、且没走 PageTile ⇒ 强制唯一宿主等于先把 buildTile 也搬了（那是另一刀）。

## 6. ⑤ 第一片可施工切片

**片：`type: "blocks"`，第一个消费者 = preview-view。**（不是 pages，理由见下）

```
为什么是 preview：它今天只画"只读块框"这一种 overlay（preview-view:363–372），需求最窄；
   而且它是**唯一已经在用 PageTile 的视图**（preview-view:266），一刀同时验证两条缝。
为什么不先动 pages：pages 的 overlay 带选中/拖拽/命中（版心把手、块框标注、建议标记），
   一刀切会把"图层"和"交互"混在一起——那正是 §23.1 说今天的病根。
```

施工面（预估，批了再核）：

```
新增  backend/book2text/static/overlay-layer.js        （约 180–220 行，含骨架与内置寄存器）
改    index.html:1854 之后一行 <script src="/static/overlay-layer.js">（在 page-tile.js 之后、app.js 之前）
改    preview-view.js：create 之后 mount，数据到了 paint，release 之前 unmount；删掉自己的 .page-overlay 建法
删    page-tile.js:207–209 的 paintOverlays 钩子（同批，避免两条路径并存）
```

**酸测试（`tests/js/overlay-registry-acid.mjs`，形态照 `tests/js/page-tile-acid.mjs`：模块存在理由的证明，不是行为单测）**

| # | 判据 | 怎么数（可用口径） | 为什么它证明模块必要 |
|---|---|---|---|
| ① | **版本一致** | 帧末 `stats(handle).version === getVersion("blocks:"+pageNo)`，且**每个**已绘元素 `dataset.version` 相同 | 防"旧 overlay 挂在新数据上"（§23.5 第 3 条） |
| ② | **不重复画（幂等）** | 同数据连续 paint 两次：元素数不变 **且 `firstChild` 是同一个节点**（节点身份） | 证明没有"清空再 append" |
| ③ | **数量** | `stats(handle).counts.blocks === data.filter(b => b.bbox).length` | 证明"数据是唯一真源" |
| ④ | **不回落旧路径**（Chief 补：必须点名删的是哪一行） | preview 路径上 `.page-overlay` 的 `innerHTML = ""` 调用次数 = **0**；且下面三行在落盘后的源码里各 **0 次命中**：`preview-view.js:183`（自建 `.page-overlay` 容器）· `:371`（`overlay._renderedBlocks === blocks` 的缓存比较）· `:372`（`injected.renderPageBlocks` 的调用）；`_renderedBlocks` 在 `preview-view.js` 里 0 次 | "次数 = 0" 可能只是换了个写法（比如改成 `replaceChildren()`）；**点名行号 + 点名字段**才排除这种 |
| ④b | **同页多宿主（2026-11-02 新增）** | 同一 `pageNo` 在两个宿主上各 `mount` → 得两个 handle；`paint(A)` 不影响 B 的 layer；`unmount(A)` 后 B 仍在、`stats(b)` 仍报 B（**用 handle，不用 pageNo**） | 证明唯一键是 **hostEl** 不是 pageNo——这条错就是 preview 490 页把 pages 句柄顶掉、`grid_layers 490 → 0` 的根因 |
| ⑤ | **图不受影响** | `img.src` 赋值次数仍 = 1（**不数网络**：`max-age=300` 会掩盖重复取图） | 证明两条缝没互相踩 |

**提交要求（活证据，不是自述）**：片 1 的提交说明里必须有一行「删掉的旧路径」，逐行写
`文件:行 → 删了什么`，并与判据 ④ 的清单一一对应。验收人只看这一行与 `git show`，不看描述。

**反例注入（每条判据都要能红，否则它是装饰）**：

```
把 getVersion 改成恒返回 "1"     → ① 必红（数据变了版本没变）
把 paint 改成先 innerHTML="" 再建 → ② 必红（firstChild 变）
把 count 判据的 filter 去掉        → ③ 必红（无 bbox 的块不该画）
```

## 7. ⑥ 不负责清单（实现层的诱惑点，写在这里挡人）

**不负责**（§23.6 原样，加两条实现级的）：

```
不拥有 PDF 图与尺寸档（PageTile）· 不做缩放/滚动（视图或画布）· 不决定显示哪些页（视图）
· 不读业务数据（视图传进来）· 不做命中后的行为（只回答命中谁）
· 不做装饰标注的避让排布（layoutOverlayAnnotations 那类，归渲染器自己）
· 不写 localStorage / 不发请求 / 不读 currentView
```

**六个诱惑点，逐个说"别"**：

```
① 让 registry 自己取数（fetch / apiJson）→ 它就成了第二个数据层，版本指纹会有第二个来源
② 在 registry 里判断"现在是哪个视图"→ 越界；视图用 active/style 表达，不用全局状态表达
③ 让 registry 按 `.page-overlay` / id 找 DOM → §21 同一条：第一个参数永远是宿主元素
④ 加 bumpVersion() 人工版本 → §23.4b 已否：忘 bump 什么都不增长，没有闸会红
⑤ 为"当前步骤"注册不同的渲染器 → §23.2② 已否：步骤只决定 active 集合与 styles
⑥ 让 registry 顺手修数据（去重 / 排序改数据本身）→ 排序可以（渲染顺序），改数据不行
```

## 8. 施工顺序与验收（不含后续切片）

```
片 1（本契约）：overlay-layer.js 骨架 + type "blocks" + preview 一个消费者 + 5 条酸测试
片 2：pages 的块框切进来（此时才动 buildTile 与 .page-overlay，命中/选中另说）
片 3：reading 的块框；然后 margin / marks / 置信度标签各一片
每一片都问一次：**旧路径的代码是不是真的删了**（判据 ④ 就是为这个存在）
```

**这条切片的成功不是"能画"，是"画得可数"**：版本、数量、幂等、旧路径归零、图不受影响——五条都红得了、也绿得了。
