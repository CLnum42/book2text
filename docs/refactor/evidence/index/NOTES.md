# Slice I1（目录确认视图迁入 `index-view.js`）— 记录与读数

基线：`HEAD` = `55a7616`（原像取 `git show`，不读工作区）。
本刀改动三个产品文件：`index-view.js`（新）、`app.js`、`index.html`。

## 1. 结构读数

| 项 | 值 |
|---|---|
| `#view-index` HTML | 427–482，56 行，24 个 id |
| 原 app.js 段 | 8179–9343 = 1,165 行（含 15 行段落头注释，段落头丢弃、模块用自己的文件头） |
| 段内 | 52 个函数 + 29 个顶层声明 |
| 搬进模块 | 46 个函数 + 24 个状态/常量 |
| 留 app.js | 6 个函数（`loadPageIndex` / `loadIndexBlocks` / `clearImagePlaceholder` / `loadImageQuality` / `setImageQuality` / `syncImageQualityUi`）+ 5 个声明（3 个页码索引缓存 + `INDEX_ZOOM_SCALES` / `INDEX_IMAGE_WINDOW`） |
| `index-view.js` | 1,187 行（含 47 行文件头） |
| `app.js` | 17,192 → 16,159（净减 1,033） |
| 注入键 | 34 个 |
| 接口 | 4 个：`init / enter / exit / refresh` |

## 2. 逐字节证明（`verify.py`）

```
函数逐字节（正变换 1 次命中 + 逆变换还原）：46/46
其中改写 1 处：openPageIndex（加载分支的 DOM 写点换位）
状态 / 常量声明逐字节：24/24
接口：['init', 'enter', 'exit', 'refresh']
模块自己的 id：23 个（全部 index-*）
app.js 里 el("index-…") = 0
```

**唯一改写**：`openPageIndex` 的加载分支。原来 `loadPageIndex` 自己写三处 DOM
（`index-meta` / `index-list` / `index-empty`）并顺手 `renderPageIndex()`；
R3 规定目录子树的 id 归本模块，所以三个写点搬到 `openPageIndex` 里，
`loadPageIndex` 变成纯数据服务并返回 `{status}`（`ok` / `error` / `busy`）。
**时点不变**：仍在 `await` 之前写，且 `busy` 时一个字都不写（对齐原来首行早退）。
错误路径也照原样：写失败文案 → 落到下面"还没有页码索引"的空态分支。

## 3. 与 preview-p2 的口径差异（有意加强）

`preview-p2/rules.py` 的 `comment_mask` **只屏蔽注释**，字符串内部的同名标识符也会被替换。
本刀换成 `code_mask`：注释、字符串、模板文本都不可替换，但**保留 `${…}` 里的表达式**。
自检样例（`rules.forward`）：
```
if (currentView === "index") paintIndexDecorations();   → if (injected.isActive()) paintIndexDecorations();
const s = `a ${currentProject.project_id} b currentProject`;  → `a ${injected.getProject().project_id} b currentProject`
// currentProject 在注释里                              → 不动
```

## 4. 为什么 `refresh` 是第 4 个导出（§20.6 已签字）

原代码有 4 处由**外壳**替模块判断"我现在在不在"：
```
syncStepToggles           × 2：if (currentView === "index") paintIndexDecorations()
togglePageBlocksOverlay   × 1：syncIndexToggles() + 同一个守卫
toggleMarginView          × 1：同上
boot 里清晰度初始化后       × 1：原来 syncImageQualityUi() 直接写 #index-quality 的文字（R3 越界）
```

**Architect 批准的形态（§20.6，我的原提案被修正）**——守卫不留 `refresh` 里、也不加 ternary，
因为 `paintIndexDecorations()` 开头本来就有守卫（`!project || !isActive() || !indexTiles.size`）：

```js
const refresh = () => {
  syncIndexToggles();          // 无条件，对应原 togglePageBlocksOverlay / toggleMarginView 的显式调用
  syncImageQualityButton();    // 按钮文字 + 档位变化顺带作废页图
  paintIndexDecorations();     // 自己守 active
};
```

**`refresh()` 不收参数**（§20.6 明确否决 `refresh({toggles:false})` 这类参数包）。

**语义按 Chief 条件 ① 写死：只重画装饰与开关态，不做数据加载、不做全量重建、不读 `currentView`。**
实际就三件：开关按钮 `is-on`、清晰度按钮**文字**、`paintIndexDecorations()`（自己守 `isActive()`）。

所以**换清晰度档不归 `refresh()`**——它要作废已取页图并按新档重取（那是取图）。
它走模块内的 `applyImageQuality(mode)`：`injected.setImageQuality(mode)`（外壳写状态 + localStorage + radio）
→ `syncImageQualityButton()` → 可见时 `refreshIndexImageProfiles()`。
两个入口（`#index-quality` 按钮 / 设置面板 radio）**本来就在本模块里**，不用加导出、不加参数、不新记状态
（`pageProfileFor` 的结果里本来就带着档位——`detailImageProfile` 直接读 `imageQualityMode`，
所以现成的 `refreshIndexImageProfiles()` 就是"档位变了"的探测器）。

**认可的偏差（§20.6 记录在案）**：`syncStepToggles` 那 2 处原来只在 index 可见时画；
走 `refresh()` 后，index 隐藏时也会多一次 `syncIndexToggles()`（写 4 个按钮的 class，幂等、不可观察）。

替代方案（不新增导出、删掉这 4 处戳）审过：成立，但要改行为，且 index 隐藏期间
它的按钮 `is-on` / 清晰度文字会陈旧到下次进入——不拿一个新造的 UI 陈旧隐患换一个导出数字。

不采纳替代方案的完整理由记在 [`docs/decisions.md`](../../../decisions.md) **D-100**（Chief 条件 ④）。

**一条否决**：预览 deps 里那个 `syncIndexToggles` lambda **不算 `refresh()` 的调用点**，
也不许改成 preview 调 `window.IndexView.refresh()`（那是 R2 违规）。它保持"外壳在 boot 里注入一个
lambda"的形态，由外壳决定是否顺带调模块。

## 5. 运行时（真浏览器，`tests/e2e/qa.py`，最终代码 `7dda273`）

```
qa.py up / prepare / step index：
  view=index · bodyStep=index
  index-meta「662 页 · 1 页有印刷页码 · 661 页未识别页码」
  index-page-no「第 1 页」
  截图：页面图已加载、块框带类型配色 + 序号、版心/块框/清晰度/缩放条都在

qa.py smoke：43/45（K1 1 条、K2 0 条单列；其余 44 条：43 过 / 1 失败）
  控制台错误 0 条
  唯一失败 = K1「点左树条目（第 50 页）」三方 47/46/47（known-limitations 已登记的「顶部差 1」）
  导出（第 6 步）：662 页 / 653 页有正文 / 4821 段 / 753335 字 = 基线逐项相同
```

**结论**：43/45 与 `final-accept-c28f32d` 那次同构（那次的第二条是 L-107 的 1/20）。
本刀没引入新的 smoke 失败项。

**中途一次读数（41/45）说明**：那是 refresh 形态还没按 §20.6 修正前的版本，
除了 K1 还撞上了 L-107 的第 17 次面板没开（1/20）。两条都是已登记问题，都不是本刀引入的。

## 6. 待 TestDev 同批做

- `R5_OWNERS` 登记 24 条 index 状态（owner `index-view.js`）+ `VIEW_STATE_PREFIXES` 加一行；
- `R6` 登记 3 个埋点：`__b2tIndexMetrics` / `__b2tIndexBlocksMs` / `__b2tIndexTops`，`WINDOW_HOOK_MAX` 9 → 12；
- pytest 5 个用例改合查：`test_page_index_step_is_wired` / `test_index_view_reuses_page_rendering` /
  `test_page_index_scrolls_continuously_with_lazy_pages` /
  `test_index_image_recovery_and_current_diff_highlight_are_wired` / `test_page_number_labels_know_toc_pages`。
