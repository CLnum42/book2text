# Overlay 图层 registry：可施工契约

> **状态：草案，等 Chief 批；批了才有人动代码。** 作者 Architect，2026-11-01。
> 量数树：`main@20049f9`（app.js 12,755 · pages-view 3,907 · reading-view 3,680 · preview-view 1,088 · page-tile.js 18,254B）。
> 上游契约：`reading-view-boundary.md` §23（2026-10-29 定稿，未实现）。**本文不改 §23 的语义，只把它变成能开工的形态**，
> 并**改掉它的一条**（调度器归属，见 §7，附理由）。

## 0. 一句话

**一个全局 registry（渲染器按"视觉元素类型"注册一次）+ 每页一个图层句柄（host 由视图给）；
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
registry（window.OverlayLayer）  拥有：类型注册表、z 序、每页图层的 DOM、重画调度、版本比较
视图                            拥有：① 窗口内是哪几页 ② 这一步 active 哪些 type ③ 每种 type 的数据
PageTile                        拥有：那张 <img>、尺寸档、取图与释放（与本模块无引用关系）
```

**视图不拥有图层的 DOM**：视图只给一个宿主元素 + pageNo，`mount()` 之后图层 DOM 归 registry；
视图要清就 `unmount`，不许自己 `innerHTML = ""`。

## 3. ② API 草案（逐个：签名 / 谁调 / 何时）

```js
window.OverlayLayer = {
  init(deps),                                       // deps = { getVersion(scopeKey), notify(info) }
  register({ type, z, scaling, render, hitTest }),   // 全局一次：一种视觉元素一个渲染器
  unregister(type),                                  // 只给单测/清场，产品路径不许调
  mount(hostEl, { pageNo }),                         // → handle
  unmount(handle),
  paint(handle, { data, active, styles }),           // 视图：数据到了就叫，可按帧合并
  invalidate(handle, types),                         // 任何人：只置脏，不立即画
  stats(pageNo),                                     // 只读诊断：{ version, counts, geomHash }
};
```

| 成员 | 谁调 | 何时 | 约束 |
|---|---|---|---|
| `init` | **app.js 的 `boot()` 一次** | boot 最末、视图 init 之前 | 幂等；`getVersion` 只能有一份（多消费者各传一份 = 三个版本的开始） |
| `register` | boot 一次（模块自己登记内置类型） | `init` 之后、第一次 `paint` 之前 | `type` 全局唯一；重复注册 = 红 |
| `mount` | 视图 | `tile.create()` 之后（图不必到） | 宿主由视图给；**registry 不许按 class/id 找 DOM**（§21 同一条） |
| `unmount` | 视图 | `tile.release()` **之前** | 顺序硬约束；`paint` 遇到已脱离文档的宿主 = no-op + 一次 warn（§23.5c） |
| `paint` | 视图 | 数据到达 / `invalidate` 之后 | **不立即画**：登记到 registry 唯一的 rAF，帧末统一消费 |
| `invalidate` | 视图、协作层（写盘回调） | 一处数据变了 | 不碰 DOM，只置脏 |
| `stats` | e2e / 诊断 | 任意 | 只读，不许有任何副作用 |

**`render(item, style) → Element` 必须无状态**（只吃 item + style，不读全局，不读 `currentView`）；
**`hitTest(item, pagePoint) → boolean|null`** 只回答"命中谁"，点击做什么归视图（§23.6）。

**重画调度（本契约唯一一处改 §23 的地方）**：§23.2① 写"必须复用 `queueReadingIntent` + 帧末消费"。
那条**不成立**：`queueReadingIntent` 是 reading 视图的私有调度器，共享模块去依赖它 = R2 违规（模块依赖某个视图）。
改成：**registry 内部恰好一个 rAF 循环**，帧末对"已置脏的 handle × type"各画一次。
"不许有第二套调度器"的本意是**同一页的重画不许有第二个调度点**——这条不变：视图自己不许再排 rAF。

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
  一个 pageNo 在某一时刻只有一个"当前视图"持有它（§21.10 先 release 再 create 的同一族约束）
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
| ① | **版本一致** | 帧末 `stats(pageNo).version === getVersion("blocks:"+pageNo)`，且**每个**已绘元素 `dataset.version` 相同 | 防"旧 overlay 挂在新数据上"（§23.5 第 3 条） |
| ② | **不重复画（幂等）** | 同数据连续 paint 两次：元素数不变 **且 `firstChild` 是同一个节点**（节点身份） | 证明没有"清空再 append" |
| ③ | **数量** | `stats(pageNo).counts.blocks === data.filter(b => b.bbox).length` | 证明"数据是唯一真源" |
| ④ | **不回落旧路径** | preview 路径上 `.page-overlay` 的 `innerHTML = ""` 调用次数 = **0** | 证明真的换了实现，不是又包一层 |
| ⑤ | **图不受影响** | `img.src` 赋值次数仍 = 1（**不数网络**：`max-age=300` 会掩盖重复取图） | 证明两条缝没互相踩 |

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
