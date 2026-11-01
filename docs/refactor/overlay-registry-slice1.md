# Overlay registry 第一片施工书（preview × blocks）

> **状态：草案，等 Chief 批；批了由 Builder 落盘**（§8 ⑤）。
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
| `preview-view.js` | 删自建 `.page-overlay`（181–184）；`tile.append` 去掉 overlay（191）；`paintPreviewTile` 改走 registry（363–372）；清屏路径改 `unmount`/`paint(active:[])`（394） | **净 −8 ~ −12 行** | `wc -l` 前后差；`page-overlay` 在该文件 0 次 |
| `page-tile.js` | 删 `injected.paintOverlays` 钩子（**207–209**） | **−3 行**（必删） | 全仓 `paintOverlays` 0 次 |
| `page-tile.js` | 顺带删随钩子一起死的字段：`overlays: opts.overlays`（**256**）· `state: null`（**257**）· `"overlays" in changes`（**276**）· `"state" in changes`（**277**） | **−4 行**（建议同批） | 不删 = 留下一条没人读的死数据（本项目的"只涨不消"） |
| `index.html` | 在 **page-tile.js 之后、step-timing.js 之前**加一行 | **+1 行** | 顺序见 §8 撞车规则 |
| `app.css` | `.overlay-layer { position:absolute; inset:0; z-index:2; pointer-events:none; }` | **+1 条规则** | 与 `.preview-page .page-overlay`（app.css:1956）同 z；`.preview-page__hits` 仍是 3（:1958） |

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
| ① 版本一致 | `const h = mount(host,{pageNo:12}); paint(h,{data:{blocks},active:["blocks"],styles}); 帧后` 断言 `stats(12).version === fingerprint({blocks})`，且 `container.children.every(el => el.dataset.version === stats(12).version)` | 把 `fingerprint` 改成恒返回 `"1"`；再改一个块字段 → ① 红 |
| ② 幂等（不重复画） | 同数据连续 paint 两次，帧后 `const first = container.lastChild.firstChild;` 再 paint → `container.lastChild.firstChild === first`（**节点身份**，不是数量） | 把交换改成"先 remove 再 append" → ② 红（中间态 firstChild 换了） |
| ③ 数量 | `stats(12).counts.blocks === blocks.filter(b => b.bbox).length`（**没有 bbox 的块不画**，与今天 renderPageBlocks 一致） | 去掉 `.filter(b => b.bbox)` → ③ 红 |
| ④ 旧路径归零（Chief 要求点名行） | `preview-view.js` 里 `page-overlay` **0 次**、`_renderedBlocks` **0 次**、`injected.renderPageBlocks` **0 次**；被删的三处原位置（`183` 容器创建 / `371` 缓存比较 / `372` 注入调用）在落盘后的文件里**各 0 次命中** | 把 `injected.renderPageBlocks` 留一句注释调用 → ④ 红（剥注释后仍能命中才算数：改成留一行真调用更直接） |
| ⑤ 图不受影响 | 同页同档 `img.src` 赋值次数 === **1**（`environment.srcWrites` 里 `size=...` 的条数；**不数网络**——`max-age=300` 会让重复请求命中缓存，按网络数会漏判） | 让 registry 自己建 `<img>` → ⑤ 红 |

**提交要求**：提交说明里逐行写「`preview-view.js:183` → 删自建容器」「`:371` → 删缓存比较」「`:372` → 删注入调用」，
与判据 ④ 一一对应。验收只看这一行 + `git show`，不看描述。

## 5. 与已批契约的**一处偏离**（要 Chief 点头）

契约 §4 写的是「注入 `getVersion(scopeKey)`」。片 1 按下面做，理由三条：

```
改为：版本由 registry 内部算 —— fingerprint(data) = FNV-1a(stableJSON(data))，输入是**本次 paint 的 data**。
① registry 手上没有 scopeKey → data 的映射：scopeKey 是 "blocks:12"，而 data 是视图给它的一页块；
   要按 scopeKey 取，等于让外壳再算一遍同源数据 —— 那就是两个来源（今天 _renderedBlocks 的病根）。
② 它hashes 的正好是它要画的那份 data ⇒ "版本描述的就是即将绘制的数据"，这是比注入更强的保证。
③ 不注入就不需要 app.js 参与 ⇒ 本片 app.js 0 行改动，与 Builder 的 B/C/D 完全不撞（见 §8）。
契约里"内容指纹、不是人工 bump"这条没有变；变的只是"指纹在哪算"。
```

## 6. 不许顺手改（本片清单）

```
① 不动 pages / reading 的块框与版心（它们仍用 injected.renderPageBlocks / paintTileMargin）
② 不动 renderPageBlocks 本身（它还在给另外两个视图用；等最后一个消费者搬走才删）
③ 不改 `.page-overlay` 的现有 CSS（preview 不再用它，但 pages / index 还在用）
④ 不给 registry 加 hitTest / invalidate / 数据加载（没有调用点）
⑤ 不动 page-tile.js 的 `ptile__overlays` 槽（留待用它的视图出现）
```

## 7. 验收对集（落盘时逐行填，基线从开工树现数）

| 项 | 期望 |
|---|---|
| 基线 | `git rev-parse --short HEAD` + 现数 app / preview / page-tile 行数（**不抄本文的数**） |
| app.js | **0 行改动**（本片不碰它） |
| preview-view.js | 净减（预算 −8 ~ −12）；`page-overlay` / `_renderedBlocks` / `renderPageBlocks` 各 0 次 |
| page-tile.js | −7 行（钩子 3 + 死字段 4）；全仓 `paintOverlays` 0 次 |
| deps | **本片不动**（preview 的两个键留到最后一个消费者搬走那一刀删，见 §6②） |
| 域模块闸 | `DOMAIN_MODULES` 加 `overlay-registry.js` 后零豁免通过（含 `.querySelector(` 为 0） |
| 酸测试 | 5 条全绿 + 5 条变异各自红（变异要跑一次给人看，不写"应该会红"） |
| 四闸 | node + pytest 全绿；R3 pages total 0 不变 |
| 真机 | preview 页块框与改前同位置同数量（同一本书同一页，截图对比）；`--readonly` 只画不可点 |

## 8. 谁做、怎么让（⑤ 的答案）

```
做：**Builder**。我不写产品代码——我的边界是书（形态、判据、改动面）。
让：
 ① 本片**不动 app.js**（§5 第三条理由顺带解决撞车）；Builder 的刀 B/C/D 在改 PagesView/IndexView 的 deps 块，
    本片一个字符都不碰它们，可以并行。
 ② 唯一的共享文件是 `index.html`：**本片那行紧挨 page-tile.js 之后**，Builder 的四个服务模块行排在它之后。
    谁先落都能 rebase，冲突只是一行位置。
 ③ `app.css` 的一行规则只有本片加；B/C/D 不动 CSS。
 ④ 顺序建议：本片先落（它验证服务模块能碰 DOM 的边界），B/C/D 随后；若 Builder 手上正在收尾，
   也可以反过来——只要 app.js 与 index.html 两处按 ② 的规则排。
```
