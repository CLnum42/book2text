# 审校页页图"糊"：`is-placeholder` 的模糊从来没被摘掉（任务 80）

日期：2026-10-28　提交：本次（见文末）

## 任务目标

用户第四次报"页图糊"。前几轮都在量**分辨率**（`naturalWidth ÷ (CSS 宽 × dpr)`），
量出来一直是 ≥1.0，于是每次都判"已经清楚"。这次先量**模糊**，再动手。

## 当前状态（修前实测）

条件固定：窗口 **1423 × 900 CSS px / dpr 2**，审校视图（`reading`），用户看到的页列宽 **384 CSS px**。

| 页 | `size=` | naturalWidth | CSS 宽 | 比例 | `img.className` | `getComputedStyle(img).filter` |
|---:|---|---:|---:|---:|---|---|
| 1 | `view` | 1275 | 384 | **1.66** | `is-placeholder is-ready` | **`blur(1.5px)`** |
| 14 | `view` | 1275 | 384 | **1.66** | `is-placeholder is-ready` | **`blur(1.5px)`** |

目录确认（`index`）也一样：85% 时 `size=mid` / 1870 / 914.6 / **1.02**，
但 `filter` 同样是 `blur(1.5px)`。

**结论：不是缩略图没被替换，也不是档位选错——是高清图上盖着一层永久模糊。**
`is-placeholder` 这个类带 `filter: blur(1.5px)`（dpr 2 下等于 3 个设备像素），
而代码里**没有任何一处**在加载完成后把它摘掉：`delete image.dataset.placeholder`
只删了 data 属性，类的样式照旧生效。

同一页把类摘掉前后（第 14 页，同一几何、同一张图）：

| | 拉普拉斯方差 | 横向梯度均值 |
|---|---:|---:|
| 修前（`blur(1.5px)`） | 540.6 | 1.04 |
| 修后（`none`） | **1977.5** | **9.11** |

对比图：`docs/screenshots/reading-page-image-blur-before-after.png`。

## 全部加类 / 删类路径（修前）

| 位置 | 做什么 | 修前是否清类 |
|---|---|---|
| `showReadingPlaceholder` | 给 `<img>` 挂 `thumb` + 加 `is-placeholder` | —（加） |
| `showIndexPlaceholder` | 同上 | —（加） |
| `pumpReadingImages` 的 `onload` | 高清图到了：加 `is-ready`、`delete dataset.placeholder` | **否（漏）** |
| `pumpIndexImages` 成功分支 | 同上 | **否（漏）** |
| `releaseReadingImage` | 滚远/跳页：摘 `src`、删 `is-ready` | **否（漏，类留到下一张图）** |
| `markIndexImageFailed` | 取图失败：摘 `src` | **否（漏）** |
| 页列重建（`innerHTML=""`） | 新建 `<img>` | 不继承旧状态（无影响） |

**为什么四次都没查出来**：QA 的断言只看 `naturalWidth ÷ (CSS宽 × dpr)`，
模糊是 `filter` 上的事，两者完全独立；而"糊"的观感恰好被 `1.66` 这个很好看的数掩盖了。

## 实现（三处 JS + 一处 CSS）

1. 新增 `clearImagePlaceholder(image)`：同时删 `dataset.placeholder` **和** `is-placeholder` 类。
   在四条收尾路径上调用：`pumpIndexImages` 成功、`markIndexImageFailed`、
   `pumpReadingImages` 的 `onload`、`releaseReadingImage`、`markReadingImageFailed`。
2. **结构约束（防复发）**：CSS 里把模糊限定到"src 真的是缩略图"时才生效——
   ```css
   .index-page img.is-placeholder[src*="size=thumb"],
   .reading-page img.is-placeholder[src*="size=thumb"] { display: block; filter: blur(1.5px); }
   ```
   只要 `src` 换成非 `thumb` 的图，**无论类有没有被摘，模糊都不可能再出现**。
3. **占位图抢跑**：`ensureIndexImage` / `ensureReadingImage` 在挂占位图前先
   `image.onload = null; image.onerror = null`，`onload` 里再加一条
   "src 还含 `size=thumb` 就直接返回"，避免排队等待期间被上一轮的旧闭包把缩略图标成 `is-ready`。
4. **取图失败不再留假图**：失败重试 2 次后，`markReadingImageFailed` 留一张**不带模糊**的缩略图
   + 一个可点的「这一页的图像读不出来 · 点这里重试」按钮（原来会永远留一张模糊的缩略图）；
   同时把该页从 `readingLoadedImages` 里删掉，重进视口还能自动重取。

## 验证

### 1. 结构约束（DOM 层直接验）

| 操作 | `src` | `is-placeholder` 类 | `filter` |
|---|---|---|---|
| 类加上 + 图是 thumb | `thumb` | 有 | **`blur(1.5px)`** |
| 类**刻意留着**，只把 src 换成高清 | `view` | 有 | **`none`** |
| 类摘掉、src 仍是 thumb | `thumb` | 无 | `none` |

第二行就是"防复发"的核心：**不依赖 JS 记得摘类**。

### 2. 有没有"高清图 + 模糊"的一帧

用 `requestAnimationFrame` 连续采样 24 帧，从 thumb 切到高清（类故意不摘）：
**`size=view` 且 `filter !== none` 的帧数 = 0**。

### 3. 修后比例 + 比例/filter 同时报（用户窗口 1423×900 / dpr 2）

| 视图 | 缩放 | 页块 CSS 宽 | `size=` | naturalWidth | 比例 | filter |
|---|---|---:|---|---:|---:|---|
| 审校（第 1 页） | — | 384 | `view` | 1275 | **1.66** | **none** |
| 审校（第 14 页） | — | 384 | `view` | 1275 | **1.66** | **none** |
| 审校（第 500 页） | — | 384 | `view` | 1275 | **1.66** | **none** |
| 目录确认 | 85% | 914.6 | `mid` | 1870 | **1.02** | **none** |
| 目录确认 | 适合宽度 | 1076 | `zoom` | 2550 | **1.18** | **none** |

### 4. 取图失败路径（CDP `Network.setBlockedURLs` 屏蔽第 500 页的图）

| 时刻 | 状态 |
|---|---|
| 失败后 | `size=thumb`、`naturalWidth=0`、**`filter=none`**（不再是模糊假图）、重试按钮在、`attempts=4` |
| 解除屏蔽、点重试 +1.5 s | `size=view`、1275、**比例 1.66**、`filter=none`、按钮消失 |

另外修掉一个自激循环：失败后挂缩略图时如果连缩略图也失败，`onerror` 会再次进同一函数，
`attempts` 在 4 秒里涨到 **67618** 次；现在挂缩略图前先摘闭包，**attempts=4** 就停住。

## 未验证 / 边界

- "占位图的 load 抢先触发旧闭包"这条是**从代码结构推出来的**，没有构造出真实复现
  （要同时满足"排队等待 + 上一轮闭包残留 + thumb 先到"）；现在用 `onload=null` +
  `src 含 thumb 就返回` 两道拦住，标为**结构上已封，未实测复现**。
- 用户真机上如果是**旧版本页面**（没重启应用的浏览器缓存），仍然会看到糊；
  这次改动只改静态文件，**刷新页面即可**，不需要重拷项目数据。

## 用户操作说明

1. 应用重启（或刷新页面，静态资源带版本号时会自动取新的）。
2. 打开 `b2t_ZAQHGH` → 审校 → 页图应该立刻是清晰的（不再有 3 个设备像素的柔边）。
3. 如果某页确实读不出图，页面上会出现「这一页的图像读不出来 · 点这里重试」，点一下重取。
4. 回退：`git revert <本次提交>`（只动 `app.js` / `app.css`，不涉及项目数据）。

## 下一步建议

把"页图清晰度"这条验收固定成三件一起报：**比例 ≥1.0 / `filter === "none"` / 不带 `is-placeholder`**
（QA 已写进 `images --selftest`），以后缺一条都不算通过。
