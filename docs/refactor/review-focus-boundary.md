# review-focus 边界（跨模块契约，2026-11-05）

> 唯一要落文件的原因：这一刀新增 1 个模块、同时动 app.js / reading-view.js / 外壳注入面（多 owner）。
> 其余一切（取景怎么画、面板长什么样）归实现，不写文档。

## 1. 切几个文件：**1 个**

```
review-focus.js   window.ReviewFocus
  一句话：给定"当前一条差异"（后端 runs 派生），渲染它的三种取景（单字 / 单行 / 多行），
          并提供三个动作：逐处导航、判定、手改输入。
  形态：UI 模块（有自己的 root），不是服务模块 ⇒ #17 的"DOM 面 = 0"不适用；
        只许在自己的 root 子树里取节点，不许写别人的 id（#6 归属表）。
```

**取景窗口不单开文件。** 判据是模块三问：唯一资源（无）· 唯一生命周期（无，随 focus 的 root）· 唯一失效语义（无）
——三条全无 ⇒ 它是**函数**（`renderCrop(bbox, zone) → Element`），不是模块。
若它要订阅 `ResizeObserver`，订阅挂在 focus root 的生命周期上（init / unmount 各一次），也不另起模块。
第二个调用方出现之前不抽（现在没有）。

## 2. "画差异色块"归 reading-view，**输入换成 runs**

```
留在 reading-view.js：paintReadingDiffBoxes（44 行）——它画的是页面级几何
  （跨行/跨块、字框与词框、多页窗口、滚动重画），归"页面画布"。搬进面板模块等于让面板去碰页图容器。
删除，不搬：
  app.js:3554 computeCharSpans（58 行）· reading-view.js:3732 readingDiffUnits（51 行）
  —— 它们是"把 marks 映射成字符下标"的旧算法；runs 自带 span ⇒ 两套口径都留着就是复发 #1。
改调用：reading-view 里 3 处 injected.computeCharSpans（2918 / 3370 / 3643）改成读 runs 的 spans。
```

## 3. review-tree.js：一行不改

队列目录保留。若需"跟着当前条目走"，由**外壳**在队列/选中变化时调 `ReviewFocus.show(item)`；
树不新增导出、不碰 focus 的 DOM、不反向调用。

## 4. 谁注入谁（方向只有一条：外壳 → 模块）

```
boot 里一次：
  ReviewFocus.init({ root, getItem, getQueuePos, getProject,
                     onNavigate, onVerdict, onManualEdit, requestImage })
  ReadingView.init({ ..., getDiffRuns: () => … })     // 只为页面色块，别的都别加
  ReviewTree                                          // 不动

读：getItem() → { pageNo, lineText, runs:[{start,end,kind,source}], bbox, verdict, candidate }
    getQueuePos() → { index, total }
写：onNavigate(delta) · onVerdict(kind) · onManualEdit(text) · requestImage(pageNo, size)

真相归外壳：队列与"当前条目"只有一份（外壳）；模块是纯投影，不缓存第二份（#7）。
动作流：树/热键 → 外壳改当前条目 → ReviewFocus.show(item) → 判/改 → 外壳写盘 → 读回 → 再 show()
```

## 5. 行数账与登记（判据）

```
不许"新文件 + 老的没动"：reading-view.js 与 app.js 落地后都必须降
  app.js        −58（computeCharSpans 删）
  reading-view  −51（readingDiffUnits 删）+ 3 处调用改 runs + 行内红字渲染若由面板接管则另计
  新文件        预计 250–350 行（面板 + 三取景 + 导航 + 判定 + 手改）
新模块落盘按 #19：新增 static/*.js + 三张登记表新增行同笔；用 root.querySelectorAll ⇒
  必须同时进 DOMAIN_MODULES 与 ALLOW_QUERY_SELECTOR_WHITELIST（白名单现有 3 个，这是第 4 个），
  三处 + 本文件写明理由。
```

## 6. 不做什么

```
不搬 review-tree；不做第二套"当前条目"状态；不让 focus 直呼 PageDetailEditor / PagesView / ReadingView；
不把页面级色块搬进面板；不为取景窗口单开模块（除非出现第二个调用方）。
```
