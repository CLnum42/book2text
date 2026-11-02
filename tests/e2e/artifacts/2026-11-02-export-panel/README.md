# 2026-11-02 导出面板真机验收（main 62868c7）

环境：库 `/tmp/b2t-qa4/lib`，项目 `b2t_T7JH61`（490 页）；服务 8871（`PYTHONPATH=<主树>/backend`），
视口 1423×900（deviceScaleFactor 2）。基线 `62868c7`（跑前 fetch，`HEAD = origin`）。

**§0.6 静态判定**：`3080f55..62868c7` 的 static 变化 = `app.js -553`、`export-panel.js +585`（新文件）、
`index.html +1`、`overlay-registry.js +88`；`preview-view.js` 未改。本轮验的是这棵树。

**本轮产生的持久化副作用（都在 QA 库）**

```
③ 新建导出记录 20261102-1018_txt：body.txt 223,335 B / meta.json 381,969 B / manifest.json 19,349 B
④ 点掉提示后 b2t_T7JH61.settings.margin_judgement_notice = true（该项目的提示以后不再出现）
```

## 结论

| # | 判据 | 读数 | 判定 |
|---|---|---|---|
| **①** | 预检「行」与「提醒」两块都有内容 | 行 **17** 条（导出页数 487 / 正文段数 1068 / 正文字数 161264 / 页码映射 32/487 / 未审校 1068 / 版心未定 237 / 版心外排除 132 块 …）；提醒 `#export-note` **visible、763 字、高 360px**，覆盖 455 页无印刷页码 / 237 页版心未定 / 238 页无生效版心 / 386 页未识别 / 485 页版面未确认 / 1068 段未审校 / 79 页单引擎等；`#export-error` 隐藏 | **过**（上一轮"行有、提醒整块没有"未复现） |
| **②** | 对照预览：翻页 / 缩放后对比层跟着变、块框与文字对齐 | 面板对照：1068 段；初始 #1 p.4、来源图 206×311、6 框、1 个 `box--source`；选 #7 p.5 → 8 框、source 1；块框 vs bbox `max_dev 0`（p4/p5）。窗口 1423→760 响应式重排，来源图 206→275px，`max_dev` 仍 **0**；恢复 1423→206px、**0**。结果预览另测：p.4 命中层 1 框 → 翻页 p.5 命中层跟着换页 → 缩放 55%→70%（页宽 336→427）→ 命中层 `max_dev 0` | **过** |
| **③** | 导出一次：记录 → 历史刷新 → 「在文件夹中显示」可点 | 记录 `20261102-1018_txt · 1068 段 · 161264 字 · 未审 1068 段`；文件 `body.txt / meta.json / manifest.json`（磁盘上 223,335 / 381,969 / 19,349 B）；历史列表 1 条且 `is-latest`，「还没有导出过」隐藏；按钮可见/可点 → `POST /exports/…/reveal` → **200**，无错误条 | **过** |
| **④** | margin-judgement 提示：点掉后不再出现 | 打开项目时 `#margin-judgement-notice` 可见（83 字、按钮可见）→ 点「知道了」→ hidden，settings 写入 `margin_judgement_notice:true`；再开导出面板 / 关面板 / 刷新页面重新进项目，均 hidden | **过** |
| **⑤** | 空数据 / 无预检：面板不崩、提示合理 | `b2t_RDBXG4`（QA无正文页）：15 行全 0；提醒含「按当前设置没有内容可以导出——检查页面类型、范围与「仅已确认」」+「按当前类型 / 范围过滤掉 3 页」；生成预览 → `0 段 · 0 字 · 0 页` + 「按当前导出设置没有内容可以导出。」；点生成导出文件 → 后端拒绝并给错误条（错误编号 + 说明），历史不增，面板不崩 | **过** |
| **⑥** | console 红字 | 全部探针 0；无未处理 rejection | **过** |

## ① 预检两部分（面板打开）

```
行（#export-preflight）：17 条
  导出页数 487 页 · 正文段数 1068 段 · 正文字数 161264 字 · 注释条数 0 条（未导出）
  注释字数 0 字 · 元数据页数 487 页 · 页码映射 32/487 页 · 跨块合并 0 段 · 断词还原 19 处
  未审校的段 1068 段 · 不确定的段 0 段 · 正文不收的块类型 caption/decoration/figure/footer/…
  整页版面确认 2/487 页 · 版心未定 237 页 · 工作流状态 人工已确认 0 · 自动通过 0 · 单引擎未复核 79
  版心未确认 485 · 识别失败 3 · 版心判定 内 1068 块 · 外 132 块 · 脚注/旁批 0 块 · 页码 32 块 · 未确认版心 238 页
提醒（#export-note）：hidden=false，763 字，360px 高
  455 页无印刷页码 · 注释流默认不导出 · 237 页版心未定 · 按版心判定已开启（版心外 132 块不进正文）
  默认版心自动推算未确认 · 238 页没有生效版心 · 386 页未识别/失败 · 485 页版面未确认（不影响导出）
  1068 段未审校 · 79 页只有单引擎
#export-error：hidden
```

## ② 对照预览（导出面板）与结果预览

导出面板对照（点「生成预览」后）：

```
初始（自动选 #1 · p.4）：段 1068 · 来源图 206×311 · 覆盖层 206×311 · 6 框 · 1 个 source
  source block 01M6507200BA6953ANTBER27G7；块框归一化 vs 后端 bbox max_dev = 0
选 #7 · p.5：来源图切到 p.5 · 8 框 · 1 个 source（01M650BH5TAH2GJDY4KVWCAQYB）· max_dev 0
窗口 1423→760：面板响应式重排（.compare__body <900px 变单列），来源图 206→275px
  canvas/overlay 同步 275×415 · 8 框 · max_dev 0
恢复 1423：来源图 206×311 · max_dev 0
```

结果预览（另一种口径；注意 preview 视图现在没有 UI 入口，只能 `window.showView("preview")`）：

```
页 1（块框 14，可见页 1–2）→ 点 #preview-segs 段（p.4）：命中层 1 框，max_dev 0
#preview-next → 第 5 页：命中层跟到 p.5（1 框），max_dev 0；块框 33
#preview-zoom-in：55% → 70%，页宽 336→427；命中层 max_dev 0
#preview-zoom-out：回 55%，页宽 336；命中层 max_dev 0
```

## ③ 导出一次

```
POST /export → 记录 20261102-1018_txt（1068 段 / 161264 字 / 未审 1068 / 2026-11-02 10:18）
#export-files：body.txt · meta.json · manifest.json（每条带下载链接）
磁盘：/tmp/b2t-qa4/lib/b2t_T7JH61/exports/20261102-1018_txt/ 下 223,335 / 381,969 / 19,349 B
历史：#export-history 1 条且 .is-latest；#export-history-empty 隐藏
reveal：按钮 visible=true、disabled=false → 点击 → POST /exports/20261102-1018_txt/reveal → 200
        （macOS 后端会调 Finder 显示；本轮未核 Finder 窗口本身，只核接口 200 + 无错误条）
```

## ④ 版心判定提示

```
项目打开：hidden=false，文案 83 字，按钮「知道了」可见
点击后：  hidden=true；GET /api/projects/… → settings {"margin_judgement_notice": true}
导出面板打开 / 关闭 → hidden
page.reload() 后重新进项目 → hidden（设置持久化）
```

## ⑤ 空数据（b2t_RDBXG4）

```
预检：15 行全 0（导出页数 0 / 正文段数 0 / 正文字数 0 / 页码映射 0/0 …）
提醒：按当前设置没有内容可以导出——检查页面类型、范围与「仅已确认」。
      注释流默认不导出… · 按版心判定已开启：版心外 0 块 · 按当前类型 / 范围过滤掉 3 页。
生成预览：compare 打开，meta「0 段 · 0 字 · 0 页」，列表一条「按当前导出设置没有内容可以导出。」
生成导出文件：错误条（错误编号 2fcd10d1a242）「导出没有完成 … 按照当前设置没有任何内容可以导出：
      块可能全被排除、页面类型不在导出范围内，或「仅已确认」下没有已确认的块」；结果区不出现、历史不增
```

## 边界 / 未验

- ② 导出面板的「缩放」没有独立控件：用的是窗口宽 1423→760（面板 `max-width:100%`，`.compare__body` 在 <900px 变单列）。
  如果你指的是浏览器缩放或别的操作，告诉我再补。
- 结果预览视图现无 UI 入口（`WORKFLOW_STEPS` 里没有 preview），本轮是 `showView("preview")` 程序化进入；数值有效，但不是用户可达路径。
- 边角观察（不判缺陷）：`#compare-image-status` 在图片加载成功后 `hidden=true`，但 textContent 被写成 fallback「来源页渲染失败。」
  （`attachRenderErrorDetail` 的 load 分支会写 fallback 的既有行为）。用户看不到；只提醒后续别拿这段文案做判断。
- ④ 的提示已被点掉（settings 已写 true）；以后再验需要新项目或清掉该 setting。
- 未测：JSONL、仅已确认、页码范围、注释流勾选等选项分支；未测导出内容与源文的一致性（只验面板行为与记录）。

## 文件

```
export-open.json          3,137 B   ① 面板打开：17 行 / 提醒 763 字 / error hidden / scope
export-notice.json          843 B   ④ 提示可见 → 点掉 → 设置持久化 → 刷新后仍隐藏
export-compare.json     138,301 B   ② 对照预览：1068 段清单、翻页前后、缩放前后、逐框对齐 max_dev
preview-flip-zoom.json    4,140 B   ②（另一口径）结果预览翻页/缩放 + 命中层对齐
export-run.json           1,634 B   ③ 导出记录、文件、历史、reveal 200
export-empty.json         4,084 B   ⑤ 空数据：15 行 0、空态文案、空导出被拒
export-panel-open.jpg   243,946 B   1423×900 预检 17 行（键帧 1）
export-note.jpg         286,093 B   1423×900 提醒块 763 字全文 + 导出记录（键帧 2）
```

## 复现

```bash
cd "/Users/chenlin/DeepSeek Bot/book2text"      # HEAD=62868c7
PYTHONPATH="$PWD/backend" .venv/bin/python -c \
  "from book2text.main import main; raise SystemExit(main(['--port','8871','--no-browser','--library','/tmp/b2t-qa4/lib','--token','qa4']))"

ego-browser nodejs <<'EOF'
globalThis.OVERRIDE = {};
await import("/tmp/b2t-probe/export_open.mjs");        # ①（面板行+提醒）
EOF
# ① 提醒块截图：/tmp/b2t-probe/export_shot_note.mjs
# ② /tmp/b2t-probe/export_compare.mjs · preview_flip_zoom.mjs（preview 用 showView 进入）
# ③ /tmp/b2t-probe/export_run.mjs
# ④ /tmp/b2t-probe/export_notice.mjs
# ⑤ /tmp/b2t-probe/export_empty.mjs（项目 b2t_RDBXG4）
# ⑥ 每个探针都读 window.__errs + unhandledrejection

# 等待条件（脚本内实现）：
#   导出面板 #export-panel 非 hidden
#   预检 #export-preflight 有子节点（约 1–2s）
#   对照预览 #export-compare 非 hidden、#compare-segments 有子节点、#compare-image.dataset.pageNo 有值且 #compare-canvas 非 hidden
#   导出结果 #export-result 非 hidden（≤120s）且 #export-history 有子节点
#   提示点掉：#margin-judgement-notice.hidden === true
```
