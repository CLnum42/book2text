# 验收记录 2026-11-02：片 1（overlay registry）+ 刀 C（page-index）+ 刀 D（structure-tools）

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

## 三、刀 D：结构工具 → `structure-tools.js`（`24c8ea5`）

提交链：`b3105ba`（放宽笔：C 键 `onProjectPagesReloaded` 的 effective callers 先改登记）→
`e0a6dfb`（产品）→ `24c8ea5`（收紧笔：域模块闸的唯一例外 + 请求体对集 4 条）。

### 通过（代码层，DevLead 独立核）

```
基线 b050063 → 24c8ea5
app.js 12,584 → 12,426（−158）
顶层函数 490 → 483：差集恰 7 个、新增 0（口径：^(async )?function 名集合相减，行号为 b050063 的定义行）
  structureRules@1364 · previewHeaderFooter@1378 · renderStructurePreview@1401 ·
  updateStructureApplyState@1472 · applyHeaderFooter@1479 · setupStructurePanel@1515 · setAllStructureKeeps@1522
structureCandidates 在 app.js 0 次
structure-tools.js 271 = 220 代码 + 27 注释 + 24 空行
  （提交说明写 275，实测 271——以 wc -l + 三分解为准，275 作废）
模块 DOM 面（剥注释）：el( 0 · document.getElementById 0 · document.querySelector 0；
  只有 root.querySelector（:39 part()、:253 li.querySelector 读候选勾选态）
17 个 structure-* 被模块引用（value 7 + part 7 + bind 4，apply-btn 重复计数 1）
  #structure-panel 子树共 20 个 ⇒ 剩下 panel/close/cancel 与入口 structure-open 属外壳接缝，
  app.js 里共 5 处（:1023 / :1063–1065 / :11339 / :11348 / :12406），都是开合与 root 传递
reset 有 2 个真调用点：app.js:1023（closeModal）、app.js:2365（refreshProject）⇒ 收进接口面
index.html:1860（structure-tools.js）在 index.html:1861（app.js）之前
deps 173（window.PagesView?.init({ 的 4 空格 key 行；我的独立数法，与闸的分列无关）
四闸：node 225 / 223 pass / 0 fail / 2 skipped（45.6s）· pytest 1035 passed（123.27s，
  STATIC_DIR 打印为本 worktree 内）· R3 review 90 种 / 223 处（与 b050063 逐字相同）·
  contract-registry 465 笔 0 不合格 · audit_ui_asset_literals 会因搬运假红 0 ·
  Temp-Relax 代码 0（5 处全在 docs）
接口面 6 个：init / setup / preview / apply / setAllKeeps / reset
变异复跑：把 part() 的 root.querySelector 换成 document.getElementById ⇒ 只红域模块闸 1 条，
  报错原文「structure-tools.js 里出现 1 次 document.getElementById(——同上」；还原后 git diff 为空
```

### 例外裁决：`allowQuerySelector`（收，附两条限制）

```
闸里的唯一例外：{ structure-tools.js → StructureTools, allowQuerySelector: true }
  · 放行 root.querySelector（模块里 3 处，全在 #structure-panel 子树）
  · document.querySelector / document.getElementById / el( 在例外模块里仍然红
  · 三分支自检已带：root 绿 / document 红 / el( 红（boundary.test.mjs:5609 起）
裁决：**收**。书 §1② 本来就允许"在 root 子树内 querySelector"，闸此前比书更严；
  例外是把闸对齐书，不是给模块开后门。
两条限制已写进书 §7：
  ① 例外只给 structure-tools.js 这一个文件；
  ② 第二个模块要它 ⇒ 改书的规则并重审，**不许往 DOMAIN_MODULES 里加 allowQuerySelector 名字**。
缺口（记录，不在本轮做）：闸目前没有"allowQuerySelector 的模块 ≤1 个"的机检，唯一性靠书 + 评审。
  要机检只是一行：DOMAIN_MODULES.filter(m => m.allowQuerySelector).length === 1。
```

### 待补（已派 Builder，补完即结案；不影响产品代码正确性）

```
① A5 那个"二选一"，实际两条都没做：structure-tools.test.mjs:5 仍声称「应用后 afterApply 必须被等一次」，
   但全文件没有这条断言；calls（:73 建 / :99 自增 / :102 返回）是死变量，没有 assert 用它。
   已派：默认选 (a) 补不数调用的观察（let afterApplied = false ⇒ assert.equal(afterApplied, true)，
   A5 的 calls?/order|seq|trace/mock|spy|stub|fake 三类正则都不命中）；
   否则选 (b) 删 calls + 改第 5 行 + 缺口补进本表。
② structure-tools.js:6 头注释的 deps 里写着 notify，但全文件 0 读、app.js 也没注入 ⇒ 删这半句。
③ 闸缺口：刀 A / 刀 B 各有一条「N 名已从 app.js 迁出 + api 恰好」的常驻断言，刀 D 没有
   （只有通用域模块闸 + 行为测试）⇒ 补一条（moved 7 名 + api 恰好 6 个），
   变异：7 名之一加回 app.js ⇒ 必须红；从 api 删 reset ⇒ 必须红。
功能风险说明：afterApply 的时序不只是单元缺口——真机「应用后第 3 页块回到 paragraph」要靠 pages 重拉
  （afterApply 的第一件事），Builder 的 CDP 跑通了；但单元层确实没锁住"有没有 await"。
```

### 真机：未验（Builder 自测有读数，但未留档）

```
Builder 用 Chrome headless + CDP 跑了：打开面板 / 预览 380 候选 / 应用 372 块 /
  撤销后抽查第 3 页 24 块回到 paragraph；并留一个未追完的观察：撤销后再预览只剩 8 个候选。
判定：按 2026-11-02 的规矩「证据必须留档（命令 + 输出/截图路径进提交或 docs/evidence/），
  只在对话里说跑过 = 未验」，`24c8ea5` 内没有对应证据文件 ⇒ 记未验。
QA 复验请带这个问题：「8 个是不是应用前本来就不是 paragraph 的块」——
  取应用前 page_types=body 的候选集合，与撤销后再预览的 8 个对集（同 id 即同一批，不是丢失）。
```

## 四、结论

```
片 1：代码层通过；真机部分通过、5 项未验（ego 阻塞）
刀 C：代码层通过；真机 3 项未验（ego 阻塞）
刀 D：代码层通过（含唯一例外裁决）；真机未验（无留档）；三条文档/测试真实性待补（已派 Builder）
三把刀都是“代码可结、真机未结”——验收表按此口径引用，不得写成“全部通过”。
```
