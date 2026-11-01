# 验收记录 2026-11-02：片 1（overlay registry）+ 刀 C（page-index）

> 规则（2026-11-02 定）：**通过 / 未验分开写**；未验必须写阻塞原因与证据位置。
> 只在对话里说“我跑过”按**未验**计；环境起不来同理。
> 验收人：DevLead（独立核，不与 Builder 共用读数）。

## 一、片 1：overlay registry（`20264a4`；`b050063` 上代码未变）

### 通过（代码层，DevLead 在 `20264a4` 独立核）

```
app.js 12,638；git diff f722096 20264a4 -- app.js = 0
page-tile.js 409；全仓 paintOverlays 0
preview-view.js 1,112；page-overlay / _renderedBlocks / renderPageBlocks 各 0
overlay-registry.js 264 = 194 代码 + 46 注释 + 24 空行；el( / getElementById( / querySelector( 各 0；
  window.OverlayLayer；findOrderSpot / layoutLabel / drawDiffLayer 各 0
酸测试 5/5 绿；DOMAIN_MODULES 已登记 overlay-registry.js → OverlayLayer
deps 173 · PagesView 36 · R3 total 0 / ids 0 · node 209/207/0/2
```

### 通过（真机，QA 读数；DevLead 未复跑浏览器）

```
490/490 页有 .overlay-layer、带 page-overlay--readonly、zIndex 全 "2"、pointerEvents 全 "none"
hits zIndex 3 > 2；console 0
20264a4..b050063 对 preview-view.js / page-tile.js / overlay-registry.js / app.css 的 diff 为空
  ⇒ 这些读数对 b050063 同样成立，不需要重跑
```

### 未验（阻塞：ego-browser 服务无响应）

```
· .box 的 pointerEvents 逐点
· 类型框色逐类型（heading/paragraph/figure）
· elementFromPoint 甲/乙两组
· 开关不复用（图层数不涨）
· 块框清单旧/新对比
原因：ego-browser 无响应（另一 Bot 会话占 18 分钟后服务未恢复，最小探针 90s/120s 不返回）；
      不重启共享 GUI，等用户在场。
证据位置：QA 报告（对话）+ 其产物目录；恢复后补测并按新证据追加本表。
```

## 二、刀 C：page-index 服务模块（`b050063`）

提交链：`6e9d495`（Temp-Relax 放宽笔）→ `003b787`（产品）→ `b050063`（收紧笔）。

### 通过（代码层，DevLead 独立核）

```
顶层函数 496 → 490，移出恰好：loadPageIndex / loadIndexBlocks / clearImagePlaceholder /
  loadImageQuality / setImageQuality / syncImageQualityUi，新增 0
四个 let（pageIndexData / pageIndexProject / pageIndexLoading / imageQualityMode）在 app.js 各 0 次；
  四个都在 page-index.js（:32/:34/:36/:38）
deps 173（键名与条数不变；getPageIndex* / loadPageIndex / loadIndexBlocks / clearImagePlaceholder /
  getImageQualityMode / setImageQuality 全部转发到 window.PageIndexService）
page-index.js 172 = 103 代码 + 50 注释 + 19 空行；el( / getElementById( / querySelector( 各 0；
  window.PageIndexService（11 个导出）
app.js 12,584（−54）；index.html:1859 在 app.js 之前
Temp-Relax 残留 0（boundary / test_ui_assets 各 0）
node 221 / 219 pass / 0 fail / 2 skipped；R3 total 0 / ids 0
```

### 判定：两条 python 断言是“搬运假红”，不是放宽

```
· "/page-index"：原查 app.js → 改查 page-index.js；**同一个字符串**，只是收窄到模块文件
· "function loadIndexBlocks("：改查 page-index.js 的 "function loadBlocks("（函数在模块里改名）；
  仍断言“实现存在”，且 app.js 的转发器另外由 deps 覆盖
JS 侧（index-view-behavior）是同一性质：loadApp require 去掉已搬走的函数、
resetState 重跑模块源码拿干净实例；新增 page-index.test.mjs 补三件服务语义
（块缓存只有一份 → 同页两次只发一次请求 / 并发 loadIndex 第二次仍 busy / 档位 radio 由模块同步）。
```

### 与书 §4 的一处偏离（更严，记录在案）

书里写 `init({ apiJson, getCurrentProject, getSettingsRoot })`、radio 由 root 子树查；
实际实现是 `getQualityRadios: () => document.querySelectorAll('input[name="reading-quality"]')`
——壳里按 **name** 查好把列表给模块，模块连 `querySelector` 都是 0 次（域模块闸零豁免）。
按 name 不按 id ⇒ R3 不新增引用（实测 0/0）。判为更好的形态，不回改。

### 未验（阻塞：ego-browser 无响应，同片 1）

```
· 档位 radio（三档切换后 setImageQuality / syncImageQualityUi 的实际显示）
· localStorage 保持（换档后重开仍在）
· 预览块框档位跟随（preview 的 getImageQualityMode 读数）
处理：已并入 QA 正在跑的同一轮；结论回来后在“真机”一节追加，未回前按未验。
```

## 三、结论

```
片 1：代码层通过；真机部分通过、5 项未验（ego 阻塞）
刀 C：代码层通过；真机 3 项未验（ego 阻塞）
两把刀都“代码可结、真机未结”——验收表按此口径引用，不得写成“全部通过”。
```
