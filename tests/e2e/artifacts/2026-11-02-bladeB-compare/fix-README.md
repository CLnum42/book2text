# 2026-11-02 片 2 修复复验（main 3080f55 vs 旧树 f722096）

同一份库 `/tmp/b2t-qa4/lib`、同一个项目 `b2t_T7JH61`（490 页）、同一档位（网格 1423×900 / 截图 1200×800）。
新树 `3080f55`（`76ca9ff → 3080f55`，含 `bcd4445` 笔 C、`1b1d100`/`b85323d` 两笔修复），旧树 `f722096`（worktree `/tmp/b2t-wt-slice1`）。

跑完后 main 又前进到 `f886718`（docs 一笔）：`git diff --stat 3080f55..f886718 -- backend/book2text/static/` **为空**，所以本轮读数对当前 tip 仍成立（验的是静态文件，不是 docs）。

**§0.6 静态文件判定**：`7828683..3080f55` 改动 `app.js / index-view.js / overlay-registry.js / pages-view.js / reading-view.js`；
`preview-view.js` 未改，但 registry 的句柄唯一性改了（按宿主）。
本轮 ①–⑤ 全部重跑，不沿用上一轮读数。

## 结论

| # | 判据 | 读数 | 判定 |
|---|---|---|---|
| **①** | pages 页 1–6 块框 = 9/5/19/6/8/10 | 新树 **9 / 5 / 19 / 6 / 8 / 10**（layers 490、layers_with_children 490、stats.counts 有值），与旧树同页逐个相同 | **过** |
| **②** | 预览 → 回 pages：grid 图层不为 0、句柄不 dead、滚动/开关恢复 | in_preview `grid_layers 490`（旧 bug 为 0）、`preview_layers 490`；back_pages `grid_layers 490 / boxes 242`，页 1–6 = 9/5/19/6/8/10，`handle.dead=false`、`layer.isConnected=true`；滚动后 242、关开块框后 242 | **过** |
| **③** | 版心：开 → `--margin` + .box 不吃指针；关 → 立即（不滚动）回 `--labeled` + 吃指针 | 开（3.5s 后）：490/490 层带 `--margin`、242 框 pointerEvents **全 none**；关：点后 rAF 底下一帧开始变，实测落定 **443ms**（另两轮 120ms/1s），全程 `scrollTop 0→0`，页 1 回 `--labeled`、指针 **auto** | **过**（不依赖滚动；最慢 0.44s 是重画 242 框的耗时，不是"必须滚动"） |
| **④** | preview 逐框（含子节点） | 框数 9/5、4/5/6 页 6/8/10 与旧树相同；class/title/block_id/像素框 **0 处不同**；子节点：旧 = 号（页 1 有 6 个在框外）+ `box__label`，新 = 号（框外/框内分布**逐个相同**）、**无 label**（只读预览不建卡片） | **过**（唯一差异是设计上不建卡片） |
| **⑤** | reading / index 块框 + is-linked | reading：7 层 / 57 框（页 1–7 = 9/5/19/6/8/10/0），class `overlay-layer page-overlay page-overlay--readonly`（无号无卡片），指针 auto（CSS `#reading-pages .box`），悬停正文段 → `.box.is-linked` **1**，移开 → **0**；index：页 1 = 9 框、497 行、指针 auto、悬停卡片「#1 段落」，滚到页 2 = 5 框（页 1 清 0） | **过** |

console 红字：全部 0。

## ① pages 页 1–6（新树 fix）

```
before(打开项目): boxes 197 · layers 490
after toggle(off→on): boxes 87 · layers 490 · layers_with_children 490
页 1–6 可见瓷砖: 9 / 5 / 19 / 6 / 8 / 10
stats(1..6).counts: blocks 9/5/19/6/8/10（修复前恒 {}）
fetch: 63 次 /pages/N/blocks 全 200
旧树 f722096 同页: 9 / 5 / 19 / 6 / 8 / 10（tile-blocks-old.json，同库同项目）
```

## ② 预览 → 回 pages（这次修的根因）

```
after_open   grid_layers 490 · grid_boxes 39（刚进页面，画框中）· handle dead=false
in_preview   grid_layers 490（旧 bug: 0）· preview_layers 490 · preview_boxes 14
back_pages   grid_layers 490 · grid_boxes 242 · 页 1–8 = 9/5/19/6/8/10/0/8
             handle page1: dead=false · layer.isConnected=true · stats1 counts.blocks=9
after_scroll 242 · after_toggle 242 · console 0
```

（页 7 本来就 0 块：`/pages/7/blocks` 返回 0，不是缺框。）

## ③ 版心开关（不滚动）

```
baseline: 页1 --labeled · pointer auto · with_margin 0 · boxes 242
开版心:   页1 --margin · pointer none · 3.5s 后 490/490 层全 --margin · 242 框 auto=0
关版心:   点后同步读仍是 --margin（rAF 未跑，符合实现）
          120ms 一轮 / 443ms 一轮 落定：页1 --labeled · pointer auto · scrollTop 0→0
          关后残留：465 个无缓存图层的 class 仍是 --margin，但其中**有 .box 的 0 个**（无交互影响，滚动到会重画）
开版心时 1.8s 采样有 4 个图层尚未重画（随后 3.5s 采样 490/490），属重画在途，不是终态
```

## ④ preview 逐框（旧 vs 新）

```
两树相同：页 1:9、页 2:5、页 4:6、页 5:8、页 6:10
          class（box box--type-paragraph）、title、data-block-id、相对页面的像素框：逐项相等（0 处差异）
唯一差异：子节点
  旧：box__order（页 1 的 9 个里 6 个框外、3 个 --inside 兜底）+ box__label（悬停卡片）
  新：box__order（框外/框内分布与旧**逐个相同**）；没有 box__label
判读：只读预览不建卡片是现有设计（renderBlock 只在 styles.labeled 时建 label）；
     7828683 的"号恢复框外避让"现已落地（避让绑 details，见 overlay-registry.js:539）。
```

## ⑤ reading / index（刚迁进 registry）

```
reading（审校步，第 4 页）: layers 7 · boxes 57 · 页 1–7 = 9/5/19/6/8/10/0
  class = overlay-layer page-overlay page-overlay--readonly（无 --labeled，故无号/卡片）
  box pointerEvents = auto（#reading-pages .box 的既有规则，任务 77）
  is-linked: 悬停正文段 → linked 1 / is-hover 1；鼠标移开 → linked 0 / is-hover 0
index（目录确认，第 1 页）: rows 497 · page 1 layers 1 · boxes 9 · pointer auto · 悬停卡片「#1 段落」
  滚到页 2: 页 2 boxes 5、页 1 boxes 0（离屏清理正常）
```

## 未验 / 边界

- ③ 的"开"不是瞬时：需等 1–2 个重画周期（1.8s 采样时还有 4/490 未重画；3.5s 全量）。判据若要求"点完同一帧"，按实现做不到（paint 走 rAF）。
- ② 的滚动/开关是在"已经恢复"之后验证（242 → 242 不变），没有构造"先坏再修"的路径；旧 bug 的复现见上一轮 `stale-handle.json`。
- ⑤ 只看了 1 个 index 页（页 1→2）与 reading 的可见 7 页，没有全量遍历。
- ⑩ 的判据冲突（`--margin` 时指针 none）仍按上一轮报的走，本轮不重复。

## 文件（fix- 前缀，未覆盖旧读数）

```
tile-blocks-fix-new.json   23,545 B   ① 新树 pages 页 1–6 = 9/5/19/6/8/10 + stats/fetch
preview-boxes-fix-old.json 28,519 B   ④ 旧树逐框（class/title/id/px/子节点）
preview-boxes-fix-new.json 24,493 B   ④ 新树逐框（与旧树 0 处差异，仅无 label）
fix-preview-to-pages.json   4,932 B   ② 预览→pages 全流程（图层/句柄/滚动/开关）
fix-margin.json             1,484 B   ③ 开关三态（开/关即时/关后 120/500ms）
fix-margin-diag.json        4,962 B   ③ 第一轮诊断（开版心后 class 未跟新的现场）
fix-margin-diag2.json      10,594 B   ③ paint 调用日志（margin=true 的 paint 到达）
fix-margin-latency.json       496 B   ③ 关版心落定耗时（443ms，scrollTop 0→0）
fix-margin-residue.json       287 B   ③ 关后残留层（465 个，全部无 .box）
fix-margin-on-residue.json     236 B ③ 开后残留（3.5s 后 0 个不带 --margin 的层）
fix-reading-index.json      3,259 B   ⑤ reading/index 首轮
fix-reading-index2.json     5,583 B   ⑤ reading is-linked 双向 + index 卡片/滚动
fix-index-shot.json         1,770 B   ⑤ index 页 1→2 与悬停卡片
fix-pages-after-preview.jpg 237,897 B 1200×800  预览→pages 后 159 框（键帧 1）
fix-index-card.jpg          233,978 B 1200×800  目录页 1 的 9 框 + 悬停卡片「#1 段落」（键帧 2）
```

## 复现

```bash
cd "/Users/chenlin/DeepSeek Bot/book2text"      # HEAD=3080f55
PYTHONPATH="$PWD/backend" .venv/bin/python -c \
  "from book2text.main import main; raise SystemExit(main(['--port','8871','--no-browser','--library','/tmp/b2t-qa4/lib','--token','qa4']))"
# 旧树：cd /tmp/b2t-wt-slice1（f722096）同命令、--port 8872；两服务同开抢项目锁，对照时一次只开一个

ego-browser nodejs <<'EOF'
globalThis.OVERRIDE = { base: "http://127.0.0.1:8871", tag: "fix-new" };
await import("/tmp/b2t-probe/tile_blocks.mjs");        # ①
EOF
# ② /tmp/b2t-probe/fix_preview_to_pages.mjs
# ③ /tmp/b2t-probe/fix_margin.mjs · fix_margin_latency.mjs · margin_residue.mjs · margin_on_residue.mjs
# ④ preview_boxes.mjs（tag fix-old / fix-new，base 对应两棵树）
# ⑤ fix_reading_index.mjs · fix_reading_index2.mjs · fix_index_shot.mjs

# 等待条件（脚本内实现，不靠 sleep 判通过）：
#   pages 瓷砖 >100；pages 框 >0（25s 超时）；预览 #view-preview 非 hidden 且 .preview-page>0；
#   reading .reading-page .box>0；index #index-list 行>0 且 .index-page .box>0；
#   版心关落定：页 1 图层不含 --margin 且其 .box pointerEvents=auto，同时 scrollTop 不变
```
