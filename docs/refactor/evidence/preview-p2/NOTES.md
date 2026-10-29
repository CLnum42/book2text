# 预览视图 P2 迁移记录（任务 94 · Slice P2）

基线 `7125dd5`（P1 之前）→ 交付状态：`app.js` + `preview-view.js` + `index.html` 三个产品文件。
证据脚本见本目录 [`README.md`](README.md)。

## 改了什么

- **43 个函数 + 27 个状态**整段从 `backend/book2text/static/app.js` 迁入
  `backend/book2text/static/preview-view.js`（本刀 37 个 + P1 已搬的 6 个联动函数）。
- **33 个注入键**（`init(deps)`）：状态 getter 8、setter 4（`pageZoomIndex / pageZoomTouched /
  pagesMarginOn / pagesOverlayOn` 是页面视图共享状态，有写点）、`isActive` 1、常量 2、
  服务 2（`exportOptions` / `apiJson`）、页面视图叶子函数 14、跨子树 DOM 句柄 2
  （`pages-margin-toggle` / `pages-overlay-toggle`，模块不碰 `#view-pages` 的 id）。
- **接口 3 个**：`init(deps) / enter(params) / exit()`。`getCurrent` 按需不留（0 调用方）。
- `enter` 的三种形态：无参 = 原 `openPreview()`；`{force:true}` = 丢缓存后重开、不在预览视图时
  只丢缓存；`{invalidate:true}` = 只丢缓存。
- app.js 行数 18,045 → **17,192**（本刀 17,963 → 17,192）；`preview-view.js` **997 行**；
  `grep -c "^let preview" app.js` = **0**；app.js 里 `el("preview-…")` = **0**。
- 接缝 4 个调用点：`showView` → `enter()`；`afterCleanupApplied` 开头 `invalidate` + 末尾 `force`；
  `afterContinuationChange` → `invalidate`；`boot` 删 `setupPreview()` 改 `init(deps)`。

## 怎么证明

- **逐字节 43/43**（`verify.py`）：43 个函数正变换后与基线逐字节相同、逆变换逐字节还原；
  27 个状态声明行原样；每个函数只定义一次；模板感知的 R1 镜像越界 0；R3 id 全在
  `#view-preview` 子树内。替换口径只有：26 个标识符、`currentView`、4 个写点整句、
  2 个跨子树 DOM 句柄——**其余一字未动**。
- **运行时等价 9/9**（`runtime.mjs`）：四类场景（`openPreview` 进视图 / `loadPreview` 强制重开 /
  滚动联动 a·b·c / 视口变化）+ 缓存命中 + 只在缓存失效 + 非激活 force。
  旧侧与 `tests/js` 用同一套 `load-app.mjs` vm 口径，同一假 DOM、同一批 stub。
- 机检（TestDev 的配套补丁已在同一工作区）：`tests/js` **63 条全绿（61 pass / 2 skip）**；
  pytest 全套 **1002 passed**。R6 登记了 `__b2tPreviewMetrics` / `__b2tPreviewTileTops`
  （`WINDOW_HOOK_MAX` 7→9），两个预览静态断言改成「app.js + preview-view.js 合查」，
  其中「预览打开时把开关置 true」按新形态断成两半（模块 `injected.setPagesMarginOn(true)`
  + app.js 的 setter 接线）。

## 两处偏离（与派工单写法不同，均为行为等价）

1. **`afterCleanupApplied` 分两步**：开头 `enter({ invalidate: true })`、末尾 `enter({ force: true })`。
   派工单写的是末尾一次 `force`。分两步是为了保住原代码「先 `previewData=null`、再连做三次
   `await`」的**时间点**——只末尾 force 的话，这几次 await 期间旧预览数据仍可被滚动联动读到。
2. **`afterContinuationChange` 用 `invalidate` 而不是 `force`**：原代码这里**只丢缓存、不重开**
   （注释原文「后台，不挡翻条」）。改成 force 会多一次 `/export/preview` + 渲染，属行为变化。

## 遗留

- `setupPageMore`（工具条「⋯」菜单）**未搬**，原位留在 app.js——它是外壳不是预览。
- **preview 的 27 个状态待登记进 `tests/js/boundary.test.mjs` 的 OWNERS 表**：现在表里只有
  reading 的 65 个状态，preview 这 27 个不受 R5 覆盖（不红 = 没覆盖，不是做对了）。
- `docs/development-log.md` 未记（随本次提交补）。

---

## 附：复跑输出（交付时原样）

```
$ python3 docs/refactor/evidence/preview-p2/verify.py
函数数: 43
正/逆变换 43/43: PASS
头/尾抽样: measurePreviewTiles setupPreview
状态块 27 行逐字节在模块中: PASS
R1 镜像（模板感知）越界: 无
模块 el id: ['preview-follow', 'preview-image-status', 'preview-junction', 'preview-margin-toggle',
'preview-meta', 'preview-next', 'preview-note', 'preview-only-span', 'preview-overlay-toggle',
'preview-page-no', 'preview-page-printed', 'preview-pages', 'preview-pdf-scroll', 'preview-prev',
'preview-scroll', 'preview-segs', 'preview-zoom-in', 'preview-zoom-label', 'preview-zoom-out'] 越界: 无
window 赋值: ['__b2tPreviewTileTops', '__b2tPreviewMetrics', 'PreviewView']

结论: PASS
```

```
$ node docs/refactor/evidence/preview-p2/runtime.mjs
OK   openPreview 进视图（冷，含 api / 版心默认 / DOM 文本）
OK   openPreview 二次进入（缓存命中，0 次 /export/preview）
OK   enter({force:true}) = 旧 loadPreview 直调（不重跑版心默认）
OK   enter({invalidate:true})：0 次请求、只丢缓存
OK   视口变化（resize 监听体：缩放/量高/窗口重排）
OK   滚动联动 a：右栏滚动 → 左栏跟段
OK   滚动联动 b：右栏点击 → 左栏滚到该段
OK   滚动联动 c：左栏滚动 → 右栏跳页
OK   enter({force:true}) 非激活：0 次请求（旧=只清缓存）

全部等价（9/9）
```
