# 面板 id 的归属：351 个「不在任何 view section」的 id 归谁

> 裁定：Architect 2026-10-30。适用刀 7 / 刀 8 / 刀 9，以及**第一个"面板要变成模块"的刀**。
> 量数树：`f9e1b63`（= `500b86c` 的同一个 index.html，未动）。

## 量数（可复现）

```
index.html：唯一 id **682**（没有一个重复）；不在任何 <section id="view-*"> 里的 **351**（51.5%）
  其中 23 个 .mask 弹层 = **225** 个 id
  余 **126** = 顶栏 / 侧栏 / 通知条 / 首启卡 / 隐藏 input

最大的几块 mask：export-panel 33 · continuation-panel 21 · structure-panel 19 · assign-panel 15 ·
                 page-number-panel 14 · settings-panel 14 · word-boxes-mask 10 · split-batch-panel 8
```

复现：按 `<div class="mask" id="…">` 取子树做 div 配对；section 归属按 `parseViewSections` 同一算法。
Chief 数到 675 是口径差（是否计入重复/隐藏 input），**不影响结论**。

## 裁定一：现在（刀 7 / 8 / 9）——面板归外壳，不建表，不开任何豁免

1. `*-view.js` 零豁免**不变**：模块只许碰自己 `<section id="view-X">` 的 id。
2. 外壳（app.js）写自己的 chrome 是**合法**的，且**不要给外壳函数包能力壳**。
   能力的用途是"模块需要做一个跨域动作"；外壳做自己域里的事再包一层，只多一个名字，不多一分隔离。
3. **反模式（明确拒绝）**：给 `applyPackageMode` 造 7 个能力（`togglePackageBanner()` /
   `setPackageOpenVisible()` …）。那 7 个 id 一个都不在模块里，包完还是 app.js → app.js，
   唯一效果是把 7 行变成 7 个函数 + 7 个调用，并让下一个人以为"面板已经有归属机制了"。

## 裁定二：刀 8 落完时，`package-banner` / `package-open` 由谁引用、什么形态

```
谁：app.js（外壳）——具体在 applyPackageMode（12330）里
形态：el("package-banner").hidden = true / el("package-open").hidden = false
      （直接写，无能力壳，无 deps 键）
没有任何 *-view.js 引用它们；R3 也不会管它们（不在任何 view 子树里）
```

它们是**顶栏 chrome**：随项目打开而点亮/熄灭，与当前视图无关（导出面板同理，见下）。
这条答案对后面 341 个 id 的形态同样成立：**留在外壳、直接写、不进模块、不建表**——
只要它没有变成模块的那一天。

## 为什么否掉 D（`panel-owners.mjs` 归属表）

| 理由 | 证据 |
|---|---|
| **表是"声称"，section 是"包含"** | section 能自证（id 真的在那段 markup 里）；表不能。第一次使用就会写一句假话：让"package 模块"claim `package-banner`（顶栏通知条）——它不在那个模块的 DOM 里，也不在任何一个视图里 |
| **面板是覆盖层，与当前视图无关** | `openExportPanel()`（app.js:992-999）只做 `workflowStep = "export"` + `openModal("export-panel")`，**不切视图**。所以导出面板会在 pages 视图开着时弹出来。⇒ 这也是否掉 B 的长期版本的硬理由：把 33 个 id 塞进 `#view-preview`，面板在别的视图上就打不开 |
| **它会漂，且漂了不自证** | 与本项目已栽的豁免表（40 项陈账）、`PAGES_STAGE=2`（空转三刀）同源。表要求"表里记了但没人引用就红"这类补丁，而补丁本身又是一段要人维护的逻辑 |

## 长期形态 F：**markup 派生的面板宿主**（第一个面板模块时再上）

D 的动机是对的（面板迟早要有模块），但机制要换成"归属仍从 markup 推"：

```html
<!-- 现在 -->
<div class="mask" id="export-panel" hidden> … 33 个 id … </div>

<!-- F：外面包一层宿主 section，id 一个不动，JS 一行不改 -->
<section id="panel-export">
  <div class="mask" id="export-panel" hidden> … 33 个 id … </div>
</section>
```

- R3 的 expected 集合从 `section(id="view-X")` 扩成 `section(id="view-X") | section(id="panel-X")`；
  模块 `X-panel.js` 的接口对象 `XPanel`。
- **归属仍然可核**：这 33 个 id 真的在 `<section id="panel-export">` 里面。
- 不碰 JS：CSS 用 `.mask`（app.css:1201，不是 `div.mask`），`querySelectorAll(".mask")`（app.js:1026）
  是 class 口径，包一层 section 不影响样式与显示。
- 成本是一次性的：R5/R6/R7/R7b/R8/R13 的模块 glob 从 `*-view.js` 扩到 `*-panel.js`（六处）。
- **硬约束（必须机检）**：`panel-*` section 必须是 `view-*` 的**兄弟**，**不许嵌进 view section**
  —— 否则那个视图会白得 33 个 id（`parseViewSections` 按 `<section>` 深度切子树，嵌套会被算进去）。
- 第一块砖就是 `#export-panel`（33 个 id，最大一块），排在"成稿/导出"那一刀。

**F 落地之前不要预先建表、预先起 panel 模块**：先有 markup 里有那块宿主，再有模块。

## 撞墙时刻表（回答"会不会一刀刀撞"）

```
刀 7：不撞 —— 唯一跨域写点是 review 的 page-detail-error（1 个 id），走 1 个外壳能力
刀 8：不撞 —— 三个函数留外壳；pages 侧只收 3 个导出键（20 + 2 + 1 处写点）
刀 9：不撞 —— 「导出收口」动的是 R8 的键（61 → 22），不动 DOM
第一个面板模块：**这里撞**，第一块是 #export-panel 的 33 个 id → 上 F
```

## 反模式清单（写在这里，省得每刀重争一次）

```
✗ panel-owners.mjs 这类"手写归属表"（声称代替包含）
✗ 把 .mask 搬进 view section（面板就跟视图的显示绑定，别的视图上打不开）
✗ 给外壳函数造能力壳（7 个 id 包成 7 个函数：只增名，不增隔离）
✗ 模块里把别的域的 id 当字符串传给通用能力（`injected.closeModal("assign-panel")` 这类；
   现状 2 处，见 knife-review-plan.md 附二）
✗ 新建 `foo-panel.js` 却不带 `panel-foo` 宿主 section（那等于绕开 R3 的模块）
```

## 需要谁做什么

```
· 现在：无新判据（现状由 R3 模块侧 + 裸 id 字符串扫描守住）
· 刀 7 / 刀 8：按上面第一条执行，不新增归属机制
· F 落地时（TestDev）：六条闸的 glob 扩到 *-panel.js + 两条机检
  （panel section 必须与 view section 同级；panel 模块只碰自己 panel section）
```
