# 2026-11-03 抽屉刀真机验收（结论）

**基线**：本地 main tip `f77c657`（static 与 `e3377c9` 逐字节相同）；测时 `origin/main` 仍 `c558a07`（未推）。
**结论：未通过（P0 阻塞）——应用起不来。** 七条真机项全部**未验**，下面只列已证实的根因与代码坐标。

## 阻塞 1（fatal）：boot 崩溃，项目库空白

```
Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')
  at setupReviewPager (page-detail-drawer.js:191)
  at boot (app.js:8202)
```

根因：`setupReviewPager()` 在 `PageDetailDrawer.init({ root: el("view-review") })`（app.js:8470）**之前**被调用
（app.js:8202）。模块的 `part()` 依赖 root，root 为 null ⇒ `part("review-prev")` 返回 null ⇒ 崩。
boot 在此中断，后面所有初始化（含项目库）都没跑：首屏项目卡 **0 个**（`#project-list` 空）。
`app.js:8202` 的调用是这一刀新加的；基线 `c558a07` 的 `setupReviewPager()` 是 app.js 内的独立函数（8711 行，不依赖模块 root）。

## 阻塞 2/3（诊断副本上暴露，非验收）：抽屉打开即中断，错误被二次吞掉

只把上面那条调用临时延后（诊断副本，非产品改动）后，点页面的「审校」按钮 → 抽屉视图打开、标题「第 9 页」，
但图/块列表全空（`#detail-canvas.hidden=true`、`#detail-blocks` 0 项、`#detail-overlay` 0 框），
`#page-detail-error` 仍 hidden——因为错误写入器本身也坏了：

```
renderPageDetail → injected.setEditorPackageModeChrome(...) → app.js:8557 wrapper
  → window.PageDetailEditor?.setEditorPackageModeChrome 不是函数（editor 导出的是 setPackageModeChrome）
catch → injected.showPageDetailError(...) → app.js:8558 wrapper
  → window.PageDetailEditor?.showPageDetailError 也不是函数（editor 只有内部 showEditorError）
  → 二次 TypeError（unhandled），原始错误被吞
```

静态对集：app.js 里所有 `window.PageDetailEditor?.X` 与 editor 的 `api` 导出逐个对，
**缺 2 个**：`setEditorPackageModeChrome`、`showPageDetailError`（drawer 侧 0 个缺失）。

## 代码层读数（未过真机，仅供修复参考）

- ⑥ 折叠：`PageDetailEditor.toggleCollapsed()` 已存在，返回 `editor.classList.toggle("is-collapsed")`；
  外壳按返回值写 ▴/▾。改动点在，但抽屉打不开，无法真机验证 class/可见性三态。
- ⑦ 关闭：当前实现只有 `#detail-close` 一条点击路径（app.js:975 与 7271 各绑一次，旧版也两条）；
  **没有** Esc / 点遮罩 的抽屉关闭处理器（全仓 Escape 只有 mask/confirm/reading/boxCreate 四处）；
  `closePageDetail()` 会 `closeAuxPanel()`，但**不清** `#page-detail-error`（只 `openPageDetail` 清）。
  与任务书说的「X / Esc / 点遮罩三条路径」不符，需要产品口径先定。

## 七条真机项

| # | 判据 | 结果 | 原因 |
|---|---|---|---|
| ① | 打开审校页：出图、标题/元信息/页号 | 未验 | boot 崩溃，页面无法进入 |
| ② | 翻页：图/块框/差异层跟着换页 | 未验 | 同上 |
| ③ | 缩放：块框与文字对齐 | 未验 | 同上 |
| ④ | 块框/差异开关不改节点身份 | 未验 | 同上 |
| ⑤ | 版心开关与残影 | 未验 | 同上 |
| ⑥ | 折叠三态（toggleCollapsed owner） | 未验 | 同上（代码在） |
| ⑦ | X / Esc / 遮罩 关闭收干净 | 未验 | 同上（且 Esc/遮罩路径代码里没有） |

## 方法与证据

诊断副本 `/tmp/b2t-wt-drawer-diag` 只做了两处**非验收**改动：把 app.js:8202 的调用延后到 boot 结束、
在 loadPageDetail 的 catch 里加一行 console.error 暴露被吞错误；产品文件未改（worktree 未提交）。
证据全部在 `/tmp/b2t-qa/2026-11-03-drawer/`：

- `boot-crash.json` / `boot-crash.jpg` — 首屏项目库 0 卡 + 完整异常栈
- `render-abort.json` / `drawer-blank.jpg` — 延后调用后：抽屉视图打开、标题/页号对、图与块全空、错误条仍 hidden
- 探针 `/tmp/b2t-probe/drawer_probe.mjs`（原树，boot 卡住）+ `drawer_probe_diag.mjs`（诊断副本）

**建议**：先修 boot 顺序（把 `setupReviewPager()` 移到 `PageDetailDrawer.init()` 之后，或让模块在 init 里自绑），
再补 `setEditorPackageModeChrome` / `showPageDetailError` 两个转发目标（对齐 editor 实际导出名），修完我重跑七条。

（注：`render-abort.json` 里还有一条 chrome-extension `inject.js` 的 "Receiving end does not exist"，属浏览器扩展噪声，不是应用错误。）


---

# 第二轮：修复后复验（`81aab9c`；线上 `c8b2573`）

**测的树**：`81aab9c`（`f77c657` + 热修 cherry-pick，DevLead 给的本地 main tip）。
即 `963498d` 的等价物：两次 `git diff` 的 md5 同为 `85f4b6007421c956fc229c6af6530cb7`。

**跑完时 `origin/main` = `c8b2573`**（`git log --oneline 81aab9c..origin/main`）：

```
c8b2573 fix(lock): 机器身份改成持久 UUID——判"同机"只认 id，删掉主机名前缀启发式
bab1aa8 test-contract: 锁的"同机"判据改成 machine_id——改写两条主机名用例、删掉 skip、补老锁用例
500e2c0 fix: 抽屉启动顺序与两处转发名（真机起不来的热修）
```

`500e2c0` 与 `81aab9c` 是同一份热修（diff md5 相同）。`git diff --stat 81aab9c..origin/main` = 5 个文件，
全部是 `backend/book2text/core/project/lock.py`、`main.py` 与 lock 测试，**static 0 改动** ⇒ 下面读数对将要推的树有效。
另在 `c8b2573` 上做了冒烟（§7 末）。

**环境**：独立 worktree `/tmp/b2t-wt-drawer-fix`，`PYTHONPATH=$PWD/backend`，端口 `8871`，token `qa4`，库 `/tmp/b2t-qa4/lib`；
`paths.STATIC_DIR = /private/tmp/b2t-wt-drawer-fix/backend/book2text/static`；
静态自检 3/3 命中本树热修符号（`injected.clearPageDetailError`=2、`showPageDetailError: showEditorError`=1、
`setupReviewPager` 在 `PageDetailDrawer.init` 之后）。

**结论：热修生效，抽屉可用。七条 6 通过；关闭路径按 Chief 口径记为「只有 `#detail-close`」，
Esc / 遮罩为口径差异（不是缺陷，读数已记）；另有一条既有缺陷（缩放错位）与包模式既有行为，单列。**

## 0. boot（上一轮 P0 是否真的好了）

- `setupReviewPager()` 现在在 `PageDetailDrawer.init({root})`（app.js:8469）之后（app.js:8562），热修注释写明原因。
- 实测：`#project-list .pcard` = **11**，`view-library` 可见，`#library-error` hidden，`pageerror`/`unhandledrejection` 0。
- 上一轮的崩溃栈（`page-detail-drawer.js:191` ← `app.js:8202`）不再出现。

## 1. 打开抽屉（page 4 / 6 / 11 各一次）——通过

page 4：`view-review` 可见；标题「第 4 页」；页号「第 4 页（印 D）」；meta「正文 · 3 处待处理差异（汉字 2 · 标点 1） · 版面未确认」；
`#detail-image` src=`/api/projects/b2t_T7JH61/pages/4/image?size=view&token=qa4`；`#detail-overlay .box` 6；错误条 hidden。
`#detail-blocks` 3 项——是「待处理」过滤（按钮自报「待处理 3 / 版心内 6 / 全部 10」），不是丢块。

## 2. 关闭路径

| 路径 | 动作 | 读数 | 判定 |
|---|---|---|---|
| X | `#detail-close` | → `view-pages`；`#view-review.hidden=true`；aux hidden；`.mask:not([hidden])` 0；error hidden | 通过 |
| Esc | `keyboard.press("Escape")` | 仍 `view-review`、页号仍「第 6 页」、error 不变 | 口径差异 |
| 换视图 | `button[data-workflow-step="margin"]` / `"pages"` | 抽屉关、view-review hidden、error hidden、aux hidden、masks 0 | 通过 |

**Esc / 遮罩的口径说明**（按 Chief 口径写进口径，不计缺陷）：抽屉是**视图**不是模态，实现里只有 `#detail-close` 一条关闭路径；
全仓 Escape 处理器 4 处（app.js:984 模态、app.js:3563 灯箱、page-detail-editor.js:1083 框选模式、pages-view.js:3528 多选），
没有一处关抽屉；`git show 9227d0c:app.js | grep Escape` 同样只有两条 ⇒ 旧树也没有。要 Esc / 点空白关闭需另开需求。
（DevLead 的判据表里写了 Esc，实测不关，读数保留在 `hotfix-result.json` 的 `2_close.escape`。）

**错误条清除（Builder 热修 ④）**：注入 `GET /pages/7/blocks` → 500（计数器 `__stubHits` 0→1）→ 打开第 7 页：
`#page-detail-error` hidden=false，文本「请求失败（HTTP 500）」；点 X → hidden=**true**。**通过**。
（注：只隐藏，`innerHTML` 仍是旧文案；hidden 态不显，下次错误会覆盖。记为小注。）

## 3. 翻页（prev / next / jump）——通过

```
第 4 页（印 D）→ next → 第 5 页（印 E）：标题 / img / 块框 6→8 同步；差异 3→3
第 5 页 → prev → 第 4 页（印 D）：框 8→6，img src 回页 4
第 4 页 → jump（prompt「跳到第几页？」输入 6）→ 第 6 页（印 F）：框 10，差异 3→**2**
```

差异层跟着换页重画（3→2），不是旧页残留。

## 4. 缩放与块框

- `zoom-in` 778→973→1167px；`zoom-fit` → 778px；**fit 时块框与图对齐 `max_dev = 0.01px`**。
- **`zoom > 100%` 时块框与文字横向错位**：125% `max_dev 33.3px`、150% `191.1px`（canvas 1167 而图封顶 932；
  `#detail-overlay` 是 `inset:0` 覆盖 canvas，框用百分比 ⇒ 被拉伸）。**对照 `9227d0c`（本刀之前）同库副本同页：
  125% 21.1px、150% 176.5px ⇒ 既有缺陷，不是本刀引入**（§8.1）。
- `toggle-overlay`：hidden false↔true，框数恒 10；14 个节点（image / canvas / 10 框 / 2 块 li）打标记后两轮**全部存活** ⇒ 页面不重建。**通过**。
- `toggle-diff-marks` 是**三态循环**：`差异：未审+已审` → `仅未审` → `关` → …；marks 2→2→0；层一直 `hidden=false`
  但 `pointer-events:none`，「关」时是 0 子节点空层（不遮点击）。**通过**（按三态读，不是 on/off）。

## 5. 版心开关——通过

`review-margin-toggle`：开 → `#detail-margin.hidden=false`（display block，框 658×932），canvas 加 `has-margin`；
关 → hidden=true、display none、`has-margin` 移除、`#detail-overlay .box--outside-margin` = 0 ⇒ **无残影**。

## 6. 折叠左抽屉（本轮重点）

折叠 CSS 只在 `@media (max-width: 1119px)` 生效（`.editor.is-collapsed`）；宽屏下按钮 `display:none`、class 翻转但无视觉变化（设计）。
把视口压到 1000×820 后实测（`toggleCollapsed()` 自己执行 class，外壳按返回值写 ▾/▴）：

```
初始：.editor h=279px，▾，phead 47 / layout-panel 46 / review-filter 39 / blks 91 / efoot 55，块列表可见
收：  .editor is-collapsed h=48px（贴底 y=772），▴，其余子节点 display:none，块列表不可见
开：  h=279px，▾，子节点恢复
收2/开2：同上，两轮一致
```

**通过**（点开 → 点收 → 再点开，class 与内容可见性都跟着变）。

## 7. 单一回路（改块类型）——通过

page 6 首块 `paragraph → heading → paragraph`（走块列表 select，编辑器动作）：

- 整页重画 **1 次**：`#detail-overlay` 子节点重建 1 簇；`renderBlocks` 调用 1 次，栈
  `onPageDetailChanged(app.js:8569) ← renderPageDetail(page-detail-drawer.js:183) ← loadPageDetail(drawer:115)`。
- 块列表被重画 **2 次**（t=44、t=207）：第一次 = 上面那条 `renderBlocks`；第二次 = `refreshDetailSuggestions → renderReviewBlocks`
  （**editor 内部**，建议刷新）。抽屉自身**不画** `#detail-blocks` ⇒ 没有「编辑器与抽屉各画一次」。
- 数据一致：PATCH 后 API `block_type` 与 DOM select 一致（heading → 改回 paragraph），`revision` 递增。
- 副读：块从「待处理」过滤里消失时会多一次列表重建（`ensureBlockListed` 兜底切「全部」），是设计。

## 8. console——通过

正常项目路径全程 `#page-detail-error` hidden；`pageerror` + `unhandledrejection` 0。
CDP `Runtime/Log` 重载后 error 共 6 条：2 条来自 Chrome 扩展（`chrome-extension://…`），
4 条是包模式下的 403 网络错误（§9）。应用自身 console 0。

## 9. 包模式（DevLead 指定重点）+ 最终树冒烟

- `b2t_C2MQ9A`（kind=package）：横幅「审校任务：第 11、12 页（另附只读上下文第 10、13 页） · 来自 QA · 说明：协作刀导入用」；
  `#structure-open.hidden=true`（父 `#export-panel`）、`#finish-open-review.hidden=true`（父 `#view-review`）、`#package-open` 可见。
- 打开第 11 页抽屉：图 src 已设；块列表 0（过滤=待处理 0；版心内 5、全部 5）；**错误条可见**
  「审校任务里不能做这个操作 … 这是助手端的审校任务包：不能识别、不能改页面类型 / 纳入、…」，
  对应 `GET /review/tree` → **403**；左侧目录统计残留上一项目的「97 处待审」。
- **对照 `9227d0c` 同路径**：同样 403、同样错误条、同样「97 处待审」⇒ **既有行为（包模式禁用 review/tree）**，不是本刀引入。
  但「包任务里能否真审」被错误条 + 0 块挡住，口径请 DevLead 定（列入未验）。
- 显隐两轮：进包（hidden/hidden）→ 回普通项目（`inline-flex` / `block`）→ 再进包（hidden/hidden）→ 再回（恢复）。**通过**，第二次不残留第一次。
- **最终树冒烟（`c8b2573`，worktree `/tmp/b2t-wt-final`）**：boot 11 卡；page 6 抽屉标题「第 6 页」、
  `naturalWidth 932` 且 complete、框 10、差异 2、error hidden、console 0 ⇒ 与 `81aab9c` 读数一致。

## 10. 未验 / 既有发现

**未验**

- 包模式下「实际审校 + 导出结果包」正流程：待处理过滤为 0，未验证切「全部」后能否编辑并导出（本刀范围外，但值得一条）。
- ⑦ 右侧文本面板的独立重画次数未单独计数（`renderBlocks` 只画列表）。
- 撤销自动通过 → 徽标同步：仍缺样本（沿用上一轮：库里没有同时满足 include=正文、recognized、layout_confirmed、
  margin 已定、无 divergence、suggestion_count=0、无 ink_gap、aux_checked、未 auto_pass_excluded 的 2 页）。

**既有发现（非本刀，供 DevLead 排期）**

1. 缩放 >100% 块框横向错位：125% 33.3px / 150% 191.1px（旧树 21.1 / 176.5）；根因 `applyZoom` 只设 canvas 宽、图封顶自然宽。
2. pages 视图块框会盖住页卡上的「识别 / 审校」按钮（`elementFromPoint` 命中 `.box`），必须先关块框才能点；新旧树同。
3. `#page-detail-error` 只 hidden 不清文本，切项目后旧文案仍留在 DOM（不影响显示）。
4. 进「正文审校」步骤会弹「第二引擎复核还没跑完」遮罩，须先关（设计如此）。
5. 宽屏下折叠按钮 `display:none`，class 翻转不可见（设计如此，窄视口才生效）。

## 11. 复现

```bash
cd /tmp/b2t-wt-drawer-fix   # 81aab9c（或 /tmp/b2t-wt-final = c8b2573）
PYTHONPATH="$PWD/backend" /Users/chenlin/DeepSeek\ Bot/book2text/.venv/bin/python -c \
  "from book2text.main import main; raise SystemExit(main(['--port','8871','--no-browser','--library','/tmp/b2t-qa4/lib','--token','qa4']))"
# http://127.0.0.1:8871/?token=qa4 → 打开《识别进度测试》(b2t_T7JH61) → 页面确认
#   → 悬停 p.6 页卡 → 点「审校」；折叠项把视口压到 <1120px 再点 ▾
```

## 12. 第二轮证据与副作用

| 文件 | 大小 | 说明 |
|---|---|---|
| `hotfix-drawer-page6.jpg` | 149,873 B | 热修后抽屉：图 + 10 块框 + 2 差异 + 版心框 |
| `hotfix-collapse-narrow.jpg` | 102,460 B | 窄视口（1000px）折叠态：editor 48px、▴、块列表不可见 |
| `hotfix-zoom150-misalign.jpg` | 149,636 B | 150% 缩放时块框横向错位（max_dev 191.1px，既有） |
| `hotfix-boot-library.jpg` | 74,738 B | 热修后首屏 11 张项目卡（第一轮此处为 0） |
| `hotfix-result.json` | — | 机读读数（七条 + 对照 + 包模式 + 折叠） |

**副作用**（共享测试库 `/tmp/b2t-qa4/lib`，均已复原）：page 6 首块 `block_type` 往返 `heading → paragraph`，
`revision` 1→5；该块从「待处理」里消失（page 6 待处理 3→2），`review_status` 仍 `unreviewed`。
`b2t_C2MQ9A` 打开过抽屉（未改数据）；项目位置记录随打开更新。

## 13. 复核：在 `c8b2573` 上整跑一遍（独立服务、独立会话）

上面的读数来自 `81aab9c`（与 `c8b2573` 的 static 逐字节相同）。为免「读数来自等价树」的口子，另起一棵
`/tmp/b2t-wt-final`（`c8b2573`）+ 独立 ego 会话，把七条**按同一判据重跑一次**，读数与上表一致：

| # | 判据 | `c8b2573` 读数 | 与 `81aab9c` |
|---|---|---|---|
| 0 | 首屏有卡 | `#project-list .pcard` = 11，library-error hidden | 一致 |
| 1 | 打开抽屉 | 第 6 页（印 F）· meta「正文 · 2 处待处理差异（汉字 2 · 标点 0） · 版面未确认」· img `naturalWidth 932` complete · 10 框 · 列表 2（待处理）· error hidden | 一致 |
| 2 | 翻页 | 6→7（0 框 / 0 差异，该页无块）→6（10 框 / 差异 2）→jump 4（6 框 / 差异 3）→6（10 框 / 差异 2） | 一致 |
| 3 | 缩放对齐 | fit `max_dev 0.01`；125% **33.34**；150% **191.13**（既有缺陷，见 §10） | 一致 |
| 4 | 块框 / 差异开关 | overlay hidden 翻转、框恒 10、14 节点存活；差异三态 `未审+已审 → 仅未审 → 关`，marks 2→2→0→2，`pointer-events:none` | 一致 |
| 5 | 版心开关 | 开 hidden=false/`has-margin`；关 hidden=true、class 移除、`box--outside-margin` 0 | 一致 |
| 6 | 折叠（窄视口 1000px） | 279→48（▴，子节点 none，块列表不可见）→279（▾）→48→279，两轮一致；宽屏按钮 `display:none`（设计） | 一致 |
| 7 | 关闭 `#detail-close` | 回 `view-pages`、view-review hidden、aux hidden、masks 0；**注入 `/pages/7/blocks` 500（hits=1）→ 错误条「请求失败（HTTP 500）」→ 关后 hidden=true** | 一致 |

包模式也在 `c8b2573` 上复跑了显隐两轮：进包（banner on / structure hidden / finish hidden / package-open 可见）→
回普通项目（banner off / structure 可见 / finish 可见 / package-open 隐藏）→ 再进 → 再回，两轮都对。
全程 `pageerror` / `unhandledrejection` 0。

证据：`verify-c8b2573-collapse.jpg`（本树窄视口折叠态）。
