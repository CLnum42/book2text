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
