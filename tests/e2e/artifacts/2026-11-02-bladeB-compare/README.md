# 2026-11-02 片 2 笔 B 对照复验：⑨ / ⑩ / ⑪ / ⑤ / D（main 7828683 vs 旧树 f722096）

环境：两棵树各起一个服务，**同一份库 `/tmp/b2t-qa4/lib`、同一个项目 `b2t_T7JH61`（490 页）**。

```
新树  http://127.0.0.1:8871  PYTHONPATH=<主树>/backend  main 7828683
旧树  http://127.0.0.1:8872  PYTHONPATH=/tmp/b2t-wt-slice1/backend  f722096（片 1 之前的基线）
两边都先自检 STATIC_DIR 指向各自树（主树前半轮被另一服务占着端口/项目锁，跑对照时停一个起一个，见下）
```

**§0.6 静态文件判定**：`f722096..7828683` 对 `preview-view.js +64 / pages-view.js +88 / app.css +49` 有改动
（这正是片 1 与笔 B 的范围）；⑪ 用的 `reading-view.js` 在这段区间 **0 改动**（`git diff f722096..7828683 -- reading-view.js` 空），
所以 ⑪ 若有变化只能来自共享的 `renderPageBlocks` / 布局调度，不能来自 reading-view 自己。

## 结论先行

| # | 结论 | 一句话证据 |
|---|---|---|
| **⑨** | **回归，且有两个独立阻断** | 新树 pages 瓷砖框 **0**；旧树同项目同页 **9/5/19/6/8/10 个**（页 1–6）。手工补 `OverlayLayer.init({})` 后新树立刻画出 **242 个**框，页 1–6 与旧树逐个相同 ⇒ 不是"没数据" |
| ⑨-a | pages 路径从未调用 `OverlayLayer.init` | `preview-view.js:365` 在 `previewOverlayHandle` 里 init；`pages-view.js:811` 的 `overlayHandleFor` 只 mount。注册表里没有 `blocks` 渲染器 ⇒ `paint` 收到 9/19/26 块也不画，`layer.hidden` 恒 true |
| ⑨-b | 进过预览后，pages 的块框永久失效 | 预览 `buildPreviewPages` 给 490 页**每页都 mount**（preview-view.js:195），registry 按 pageNo 唯一，`mount` 会 `unmount` 同号的 pages 句柄；回 pages 后 `tile.__overlayHandle` 是 `dead:true` 的旧句柄，`paint` 静默 no-op。**490 → 0 层，滚动/开关都不恢复**；删掉旧句柄重画 → 159 框回来 |
| **⑩** | 产品路径无法验（被 ⑨ 挡死）；补 init 后：class ✓、指针 ✓、悬停卡片 ✓；但 `--margin` 时指针 none，与判据相反；版心关掉后 class 不撤 | 单列档 + 手工 init：9 框、`--labeled`、`pointerEvents:auto`、子节点 `box__order|box__label`，悬停卡片出现（label `visibility:visible`、文本「#1 段落」；按 ≤2 张规则未留截图）；开版心 → 加 `--margin`、指针 `none`（app.css:903）；关版心 → class 仍 `--margin`、指针仍 none，滚动触发重画后才回到 `--labeled/auto` |
| **⑪** | **没被笔 A 拆坏**：旧/新读数逐项相同 | 换页 9→10：标记 5→4，block_id/rect 全换（重画）；开关块框：标记 4 个、rect 不变；缩放（块框开）732→915：标记 89→111px / 551→689px，与顺序号同一帧落位；**块框关时缩放：915→1098 标记不动（旧树同）** ⇒ 既有问题，不是本片引入 |
| **⑤** | preview 逐框：数量/class/title/block_id/像素框**全同**；只有子节点不同 | 页 1:9、页 2:5、页 4:6、页 5:8、页 6:10，两树一致；新树每框只有 `box__order--inside`，旧树是 `box__order`（9 个里 6 个在框外避让）+ `box__label`（悬停卡片） |
| **D** | `PreviewView.enter()` 不切视图：**旧树也一样** ⇒ 既有/设计，不是回归 | 两树：调用后 visible 仍是 `["pages"]`，`preview-page` 已建 490 个、`preview-boxes:0`；正式入口 `showView("preview")` 两树都正常 |

## ⑨ 的三组读数（同一项目、同一档位、同一页）

```
旧树 8872（f722096）：打开项目 → pages 步 → 块框开
  before: grid boxes 224 · after toggle(off→on): 57
  页 1–6 可见瓷砖: 9 / 5 / 19 / 6 / 8 / 10
新树 8871（7828683）：同一路径
  before: boxes 0 · after toggle: 0 · 滚动 1200/2400 后仍是 0
  layers 490、layers_with_children 0；fetch 63 次 /pages/N/blocks 全部 200，返回 9/5/19/6/8/10/22/26…
  OverlayLayer.stats(57..64).counts 全为 {}
新树 + 手工 `OverlayLayer.init({})` + 开关重画：
  boxes 242 · layers_with_children 490 · 页 1–6: 9 / 5 / 19 / 6 / 8 / 10（与旧树逐个相同）
```

⑨-b 的时间线（`stale-handle.json`）：`after_open grid_layers 490 / boxes 0` → `in_preview grid_layers 0 / preview_layers 490`
→ `back_pages grid_layers 0`；`tile[data-page-no=1].__overlayHandle = {dead:true, layer.isConnected:false}`；
`delete` 490 个旧句柄 + 开关重画 → `grid_layers 490 / boxes 159`，新句柄 `dead:false`。

## ⑪ 明细（旧/新完全一致，故只列一份）

```
A 页 9：5 个标记，canvas 732×1103，首标记 x134 y371 201×16（overlay 默认关）
B 换页 → 页 10：4 个标记，首标记 x89 y199 551×20（block_id 已换成 10 页的）
C 开块框：标记 4 个、rect 不变；26 个 .box 出现，首框 35/63/516×18，顺序号在框外 529/44
C2 放大（块框开）：canvas 732→915；标记 89→111、551→689；顺序号 529→667、44→60（同一 rAF 落位）
D 关块框：标记 4 个、rect 不变（与 C2 相同）
E 再放大（块框关）：canvas 915→1098，标记仍是 111/689（**没有按 1098 重算**）
旧树全流程数值与上面逐项相同 ⇒ 不是笔 A 引入；记录为既有缺陷。
```

`detail-diff-*.json` 里有每个标记的 block_id / line / 像素框 / `end` 文案。

## ⑤ preview 逐框对比

对比口径：`.preview-page` 内每个 `.box` 取 `class / title / data-block-id / 相对页面的像素框 / 子节点 class`。

```
两树相同：框数 9, 5, (4/5/6 页) 6, 8, 10；class 全为 box box--type-paragraph；
          title、block_id、px 相对框逐项相等（脚本逐框比过，0 处差异）
不同（唯一）：子节点
  旧树：box__order（多在框外，页 1 的 9 个里 3 个 inside）+ box__label（悬停卡片）
  新树：box__order box__order--inside，没有 box__label
判读：新树是"只读预览不建卡片"的现有实现（renderBlock 只在 styles.labeled 时建 label），
     而 7828683 的提交说明写"preview 号恢复框外避让"——该条**只有文档**（该笔只改 docs/），
     代码 app.css / overlay-registry.js 未动，避让仍绑 labeled ⇒ 号仍然 inside。属"文档先行、实现未落"，
     不是本片引入的缺陷，按事实记录。
```

## D：enter 不切视图

两树：在 pages 视图里 `await PreviewView.enter()` → 2.5s 后 `visible:["pages"]`、`preview-page:490`、`preview-box:0`。
旧树相同 ⇒ 既有行为（enter 只负责数据，切换由 showView 做）。`showView("preview")` 两树都正常进预览。

## 未验 / 边界

- ⑩ 的悬停卡片：产品路径 0 框，测不到；上面"卡片出现"是**手工 init 后**的读数（截图），不能当作产品验收。
- ⑩ 的判据"带 `--labeled` 与 `--margin` 时 .box 能吃指针"与实现相反：app.css:903 规定 `--margin` 下
  整个图层与 `.box` 都 `pointer-events:none`；实测 `labeled` 单独 = auto，加 `--margin` = none。请裁决判据或实现（同 ③ 甲）。
- ⑪ 的"滚动"：详情页的标记是相对 canvas 绝对定位，滚动不改变相对坐标（viewport 坐标随 canvas 1:1 移动），
  本轮按"相对 canvas 的 rect"记录，滚动无需重画；若要求滚动时重画，需要另立判据。
- ② 的 heading/figure 颜色仍无样本（库内 1233 块全 paragraph），本轮未重测。
- 本轮不进 main、不 push；两服务验完已停。

## 文件

- `tile-blocks-new.json` / `tile-blocks-old.json` — ⑨ 主读数（含 fetch 日志、可见页框数、stats）
- `diag-paint.json` — 新树 `OverlayLayer.paint` 调用日志（证明 data_len=10/6/18… 已送达）
- `init-proof.json` — ⑨-a 根因实验（手工 init → 242 框，页 1–6 与旧树相同）
- `stale-handle.json` — ⑨-b 机制验证（进预览卸掉 490 句柄 → 旧句柄 dead → 删句柄后 159 框回来）
- `preview-to-pages.json` / `pages-after-preview.json` — 预览→pages 的两次复现（layers 490→0）
- `preview-boxes-old.json` / `preview-boxes-new.json` — ⑤ 逐框原始数据
- `detail-diff-old.json` / `detail-diff-new.json` — ⑪ 全流程原始数据（含每帧序列）
- `pages-pointer.json` / `pages-pointer2.json` — ⑩ class/指针/版心开关（产品路径 0 框 + 手工 init 后的对照）
- `pages-old.jpg`（1200×800，240 KB）— 旧树 pages：159 个框可见（键帧 1）
- `pages-new-boxes0.jpg`（1200×800，214.8 KB）— 新树 pages：0 个框（键帧 2）

## 复现

```bash
# 1) 两棵树各起一个（同时开会抢项目锁，对照时一次只开一个）
cd "/Users/chenlin/DeepSeek Bot/book2text"
PYTHONPATH="$PWD/backend" .venv/bin/python -c \
  "from book2text.main import main; raise SystemExit(main(['--port','8871','--no-browser','--library','/tmp/b2t-qa4/lib','--token','qa4']))"
cd /tmp/b2t-wt-slice1
PYTHONPATH="$PWD/backend" "/Users/chenlin/DeepSeek Bot/book2text/.venv/bin/python" -c \
  "from book2text.main import main; raise SystemExit(main(['--port','8872','--no-browser','--library','/tmp/b2t-qa4/lib','--token','qa4']))"

# 2) 探针（把 OVERRIDE 换 base / tag）
ego-browser nodejs <<'EOF'
globalThis.OVERRIDE = { base: "http://127.0.0.1:8872", tag: "old" };
await import("/tmp/b2t-probe/tile_blocks.mjs");
EOF
# ⑨ 旧树：tile-blocks-old.json；⑨ 新树：tag:"new"/8871
# ⑨-a 根因：init-proof.mjs（新树）
# ⑨-b 机制：stale_handle.mjs（新树）
# ⑤：preview_boxes.mjs（两棵树各一次）
# ⑪：detail_diff.mjs（两棵树各一次）
# ⑩：pages_pointer.mjs / pages_pointer2.mjs（新树）

# 3) 等待条件（脚本内已实现，不靠 sleep 判通过）
#   pages 瓷砖出现：`#page-grid .page-tile` > 100（本项目 490，约 1–2s）
#   pages 框：`#page-grid .page-tile .box` > 0（本轮新树 25s 超时仍未出现 → 判 0）
#   预览：`window.showView("preview")` 后 `#view-preview` 非 hidden 且 `.preview-page` > 0
#   页详情：`#view-review` 非 hidden、`#detail-canvas` 非 hidden、`#page-detail-title` 含「第 N 页」
#   差异标记：`#detail-diff-layer .diff-mark` > 0（页 9/10 各有 5/4 个）
```
