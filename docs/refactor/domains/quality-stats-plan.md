# 刀 Q1 施工图：质量统计域搬出（app.js −102 行 · 新模块 3 导出）

> 基线 `main@72a8535`（app.js **12,755** / pages-view **3,952**）。
> 域表 `appjs-domain-map.md` 的「质量统计 151 行 / 6 函数」量的是**段**，不是**域**：段里 3 个函数属别的域。
> 按「为谁存在」剥完，本域 = **3 函数 / 98 行**；这是三批里最干净的一片（自己 0 个状态），适合第一次验证「域模块」的注入表形态。
> 行号全部实测于 `72a8535`；落盘前重量（`knife-numbering.md §六`）。
> **pages-view 的 3,907 是 `20049f9` 的数**——之后 `439055e` / `94d25f7` 两笔版心修复让它长到 3,952（+59/−14）；app.js 自 `20049f9` 起没动过，所以 2554–2704 的段界仍然对。

## 一、逐函数归属（6 个，判据 =「这函数为谁存在」）

| 函数 | 行 | 行数 | 判 | 依据（不是「碰了哪个 id」） |
|---|---|---:|---|---|
| `statsRow` | 2557–2564 | 8 | ✅ 本域 | 只被 `renderSummary` 调；建 `<dt>/<dd>` 对，质量统计专用 |
| `loadSummary` | 2570–2581 | 12 | ✅ 本域 | 拉 `/summary` → 写 `projectSummary` → 画 → 通知步骤条；4 个调用点全是「统计要重算」 |
| `renderSummary` | 2583–2660 | 78 | ✅ 本域 | 唯一读者是 `loadSummary`；输出「识别 / 审校 / 两路复核 / 任务」四行 + `not_measured` 提示 |
| `percentText` | 2566–2568 | 3 | ❌ 夹带 → **工具** | 被 pages-view:415（分歧率）经 `injected.percentText` 调；百分比格式化，不是统计专属 |
| `renderProject` | 2662–2673 | 12 | ❌ 夹带 → **项目库** | 只被 `refreshProject`:2541 调；写项目头 / 包徽章，并决定「打开项目后要不要切到 pages」 |
| `renderProjectMeta` | 2680–2703 | 24（+5 行注释） | ❌ 夹带 → **应用信息** | 填设置对话框「当前项目」一节；callers：`refreshPageStates`:5015、pages-view:1175/1982/2948 |

合计：本域 **98 行函数体 + 1 行 doc = 99**；夹带 **44**（`percentText` 3 + `renderProject` 12 + `renderProjectMeta` 24 + 注释 5）；段头 1 + 空行 7。

**结论一（写进书头）**：一个 `// ---- 质量统计` 段头不代表域。段里 3/6 个函数不归它——按段量会把域算大一半（151 vs 99）。

## 二、入口面：域表的「2 个对外入口」不是本域的

域表数到的 2 个「被 `*-view.js` 经 `injected.<名>` 调用」= `percentText`（pages-view:415）+ `renderProjectMeta`（pages-view:1175/1982/2948）——**两个都是夹带/工具，没有一个是质量统计的**。

本域真正的入口只有「拉一次摘要」这一个动作，4 个调用点全在壳里：

```
:1099   openStatsPanel         面板打开                 （同步，不 await）
:2546   refreshProject         queueAfterSteps(() => …) 打开 / 刷新项目（排在步骤条之后）
:4949   pollTask               await …                  任务结束（复核行数 / 任务失败率会变）
:10994  setupLibrary           stats-refresh 按钮 click
```

跨模块那一侧：`pages-view.js:3909` 点 `stats-open` → `injected.openStatsPanel()`；`openStatsPanel` 定义在 app.js:1097（物理位置在「字框回填」段尾，刀 6 从 `setupShell` 抽出时留在这里），`injected` 表在 :12502。**这个能力留壳**（见下）。

⇒ 本域函数 **0 个跨模块入口**；入口是壳能力 `openStatsPanel`（pages → 壳）。

### chrome 接线（决定能力键）

```
stats-open     index.html:159   ← 在 #view-pages 子树内，归 pages-view（已接线 :3909）
stats-panel    index.html:1340  ← 所有 view section 之外 = 外壳 chrome
stats-refresh  index.html:1345  ← chrome
stats-close    index.html:1346  ← chrome（app.js:1065 已接 closeModal）
stats-list     index.html:1350  ← 模块要写的容器，但 id 是 chrome
stats-note     index.html:1351  ← 同上
```

- 面板开 / 关只能留壳（`openStatsPanel` / `setupShell` 里那条 close）。
- `stats-list` / `stats-note` 的 **id 字符串不许出现在模块源码里**：R3 第四形态（`boundary.test.mjs` `stringIdSmuggleProblems`）会把「模块把外壳 chrome 的 id 当字符串传」判红，`el("stats-list")` 也算。
  ⇒ 两个容器走**注入的节点访问器**（`getStatsList()` / `getStatsNote()`），id 留在 app.js。

## 三、依赖：4 个外来状态，只有 2 个跟模块走

段内出现的外来顶层状态（机械扫描，`el` 是工具函数不算）：`currentProject`(:2058) · `projectSummary`(:134) · `currentView`(:116) · `bootingProject`(:2061)。

| 状态 | 段内用途 | 处置 |
|---|---|---|
| `currentProject` | `loadSummary` 的守卫 + URL | 留壳，注入 getter（`getCurrentProject` **已有**） |
| `projectSummary` | `loadSummary` 唯一写点 | 留壳，**新增 setter**（壳里 3 个读者：`stepProgress` :320 / `textLayerPages` :3811 / pages-view:389 经 `getProjectSummary`） |
| `currentView` | 只在 `renderProject`（夹带） | 不跟模块走 |
| `bootingProject` | 只在 `renderProject`（夹带） | 不跟模块走 |

**7 个注入键 = 3 复用 + 4 新增**：

```
复用：apiJson · getCurrentProject · percentText（:12480 已有）
新增：setProjectSummary · syncWorkflowSteps · getStatsList · getStatsNote
```

为什么 `percentText` 不进模块：它同时被 pages-view:415 用；搬进模块会让 pages-view 的 `injected.percentText` 指向另一个模块的导出（模块→模块绕壳），代价大于 3 行。**归工具段**（§六 第 4 步挪过去），模块只用注入的 `injected.percentText`。

## 四、环：不是读环，是「写后读」

```
写：load() → injected.setProjectSummary(data)      ← 原 :2578
读：injected.syncWorkflowSteps() → stepProgress()  ← 原 :2580；stepProgress 读 projectSummary(:320)
```

- **顺序必须保持** `setProjectSummary → render → syncWorkflowSteps`（原 :2578/:2579/:2580）。写在前、通知在后，否则步骤条读到旧摘要。
- **不新增 getter**：`renderSummary` 只吃 `/summary` 的 payload（`pages/review/divergence/jobs/not_measured`），不读壳的 `workflowSummary`（段内 0 处）或 `divergence` 状态（`divergence` 只作为 `data.divergence` 的局部 `const` 出现，11 处全是同一个对象）。
- `divergence` 数字的生产者在后端：`core/project/stats.py:229 project_summary()` → `GET /api/projects/<id>/summary`（`api/routes_projects.py:148`）→ `to_dict()`。**这一条写进模块头**，下一刀别去接壳的 divergence 状态。
- `projectSummary` 的清除点在 `closeProject` :10932（留壳），模块不负责清。
- **已知隐患，本刀不修**：原 `loadSummary` 在 `await` 之后不校验项目是否已切换（切项目期间返回的旧 summary 会写进 `projectSummary`）。**保持原样**；要修单独一刀，别混进「零行为变化」的刀里。

## 五、DOM 面

模块只写两个容器（`stats-list` / `stats-note`），不建 DOM、不加监听。`renderSummary` 里两行取元素改成注入访问器，其余逐字不动：

```js
const list = injected.getStatsList();     // 原 el("stats-list")
...
const note = injected.getStatsNote();     // 原 el("stats-note")
```

R3 三种形态 + 第四形态在模块上必须全 0：模块源码里**不许出现任何 index.html 的 id 字面量**。

## 六、切片：一片到底（98 行，不拆）

拆两片会留下「函数在模块、调用在壳」的过渡态，而这块只有 98 行，没有拆的必要。

```
1. 新建 backend/book2text/static/quality-view.js（≈140 行）
   - 头注释：边界（面板 chrome 留壳）· 环（写 projectSummary 再 syncWorkflowSteps）· divergence 来自 summary API
   - IIFE + injected；**不带 el()**（本模块没有任何自己的 id，带一个 0 调用的 helper 是死代码）
   - statsRow / loadSummary / renderSummary 逐字节搬入，只改 §三 的 7 处调用形态：
       currentProject → injected.getCurrentProject()（开头捕获成 const，理由：守卫与 URL 之间没有 await）
       apiJson → injected.apiJson
       projectSummary = data → injected.setProjectSummary(data)
       syncWorkflowSteps() → injected.syncWorkflowSteps()
       percentText → injected.percentText
       el("stats-list") → injected.getStatsList()
       el("stats-note") → injected.getStatsNote()
   - export：init / enter / load
       load()  = 原 loadSummary 的实体（async）
       enter() = 面板打开后的进入，唯一 caller 是 openStatsPanel；`await load()` 一行转发
       （enter 不是可选项：R8 终态闸要求每个视图模块露 init + enter，见 §八）
2. app.js 4 个调用点改直呼：
   :1099  loadSummary();                         → window.QualityView?.enter();
   :2546  queueAfterSteps(() => loadSummary());  → queueAfterSteps(() => window.QualityView?.load());
   :4949  await loadSummary();                   → await window.QualityView?.load();
   :10994 addEventListener("click", loadSummary) → addEventListener("click", () => window.QualityView?.load());
3. 删 2556–2564 / 2565 / 2570–2581 / 2582 / 2583–2660 / 2661（statsRow + loadSummary + renderSummary
   及其 doc 与尾随空行，逐段合计 102 行）；percentText 的 2566–2568 + 2569 空行**搬到工具段**，不计净减
4. 夹带归位（app.js 内平移，净 0）：
   - percentText(2566–2568) → 「工具」段（:98 fillDefinitionList 之后）
   - renderProject(2662–2673) + renderProjectMeta(2675–2703) → 原地保留（就在 refreshProject 之后），
     把段头 2554 从「质量统计（说明书 8.5 / 13.4）」改成「项目头与项目信息」；
     **段数仍是 64**，不新增段头
5. 启动处插 `window.QualityView?.init({ …7 键… })`：放在 `window.PagesView?.init({…})` 之后、
   IndexView 的 init 之前（:12586 与 :12587 之间）；本模块无视图切换依赖，位置只为可读
6. 登记（必须同批，缺一条闸就红）：
   - `tests/js/boundary.test.mjs`：`VIEW_EXPORTS["quality-view.js"] = { names: ["init","enter","load"] }`
   - 同文件 `VIEW_STATE_PREFIXES["quality-view.js"] = /^(quality|QUALITY_)/`
   - 同文件 `VIEW_STATE_IIFE` 加 `"quality-view.js"`（模块列 0 零声明）
   - `index.html`：`<script src="/static/quality-view.js"></script>`，在 pages-view.js 之后、app.js 之前
   - （建议，不影响判据）`tests/integration/test_ui_assets.py` 的 `VIEW_MODULE_FILES` 加 `"quality-view.js"`：
     那张表的口径是「已落盘的全部视图模块」，漏了不影响今天的断言，但以后有人锁模块源码就找不到它
7. 不动：pages-view.js（stats-open 接线已对）· 面板 DOM · `openStatsPanel` 的开/关 · 其他域的函数
```

## 七、行数预算（落盘后按实测对账）

```
净减 = 2556–2564 (9) + 2565 (1) + 2570–2581 (12) + 2582 (1) + 2583–2660 (78) + 2661 (1) = **102**
percentText 2566–2568 + 2569 空行 = 4 行：段内搬到工具段，净 **0**
⇒ app.js 12,755 − 102 = **12,653**（容差 ±5；差出去说明有东西被顺手改了）
quality-view.js ≈ 99（搬入）+ 35–45（脚手架）= 134–144 行
pages-view.js 3,952 不变
```

## 八、登记与闸（一条都不能漏，逐条给判据）

| 闸 | 要求 | 本刀结果 |
|---|---|---|
| R8 按模块 | 每个 `*-view.js` 的导出名 == 登记值 | 新登记 3（init/enter/load）；全表 52 → **55** |
| R8 终态 L 键 | **每个模块的 names 必须含 init 与 enter** | 因此 `enter` 必须真导出、真被调（openStatsPanel 是它的 caller） |
| R5 防漏检 | 每个模块要有 `VIEW_STATE_PREFIXES` 一行；IIFE 且列 0 零声明要进 `VIEW_STATE_IIFE` | 两条都加 |
| R6 | 一个文件只露一个 `window.XxxView`，名字由文件名派生 | `window.QualityView` |
| R2 / R4-dup | 模块不许直接摸别的 `window.XxxView`；同名真实现只许一份 | `load` 全仓无同名顶层函数；`enter` 在 `LIFECYCLE` 排除表里 |
| R3 四形态 | 模块源码 0 个 id（含字符串偷渡） | 两个 chrome 容器走注入访问器 |
| 刀 11 闸① | deps 里不许有「模块 0 读」的键 | 只对 pages-view 生效；本模块 7 键**逐一被读**，仍按同口径自查 |
| accept_pages | pages 四条判据 | 本刀不碰 view-pages id ⇒ 仍 `[0]` |
| audit_ui_asset_literals | 会因搬运假红的断言 | **0**（无测试锁这三个函数的源码；实测 `grep -rn "renderSummary\|loadSummary\|statsRow" tests/` 无命中） |

## 九、验收判据（数字 + 命令）

```
① app.js 12,755 → 12,653（±5）；pages-view.js 3,952 不变；quality-view.js 落盘
② R3：node scripts/r3_pages_count.mjs --json → total 0 / ids 0（不变）
③ R8：pages-view 36 不变；registry 0 笔不合格（写作时 413 笔，落盘时现核）
④ deps：PagesView 173 不变；QualityView 7（apiJson · getCurrentProject · setProjectSummary ·
   syncWorkflowSteps · percentText · getStatsList · getStatsNote），模块每个键至少读 1 次
⑤ node tests/js/run.mjs：**202 / 200 pass / 0 fail / 2 skipped** 起（+TestDev 的 3 条 → 205/203/0/2）
⑥ pytest：1035 passed（纯 JS 改动，数不变）
⑦ accept：python3 scripts/accept_pages.py --stage 2 --expect-sha 不变 → [0]
⑧ audit：会假红 0
```

## 十、真机（零行为变化，用文本快照判）

```
① 基线（落盘前，主树 HEAD 起服务）：打开项目 → ⋯ → 质量统计
   记 #stats-list 的 textContent（四行全文）+ #stats-note 的 hidden / textContent
② 落盘后同数据集再取一次：两段**逐字相同**（这是"行为不变"的判据，不是"看起来对"）
③ 点「刷新」：不报错，文本不变（同一份数据）
④ 识别一页 → 任务结束：已识别数 +1，面板数字跟着变（pollTask 那条路）
⑤ 切到目录确认再切回 → 重新打开统计：可用；关闭再开：正常（不闪空面板）
⑥ 断网 / 项目无 summary：面板不崩（原行为就是静默 return）
```

## 十一、不做什么

```
· 不修 stale summary（切项目期间的旧数据）——单独一刀
· 不搬 renderProject / renderProjectMeta（归项目库 / 应用信息，各自的刀）
· 不搬 percentText（工具段，pages-view 也在用）
· 不改面板 DOM、不改 openStatsPanel 的开/关、不动 pages-view.js
· 不扩闸（把刀 11 闸①「deps 死键」推广到所有模块）——新模块 7 键按同口径自查即可，推广另开一笔
· 不顺手改 renderSummary 的任何文案/字段（零行为变化是这刀的判据）
```

## 十二、复现命令

```bash
# 段与函数（本文件的每个行号）
git show 72a8535:backend/book2text/static/app.js | sed -n '2554,2704p'
wc -l backend/book2text/static/app.js backend/book2text/static/pages-view.js   # 12,755 / 3,952

# 外来状态（段内引用的顶层 let/var）
awk 'NR>=2554 && NR<=2704' backend/book2text/static/app.js | grep -n "currentProject\|projectSummary\|currentView\|bootingProject"

# 入口 callers
grep -n "loadSummary\|openStatsPanel" backend/book2text/static/app.js backend/book2text/static/pages-view.js

# R3 基线（本刀应保持 0/0）
node scripts/r3_pages_count.mjs --json

# 闸
node tests/js/run.mjs
PYTHONPATH="$PWD/backend" .venv/bin/python -c "from book2text import paths; print(paths.STATIC_DIR)"
PYTHONPATH="$PWD/backend" .venv/bin/python -m pytest -q
python3 scripts/accept_pages.py --stage 2
node tests/js/contract-registry.mjs
python3 scripts/audit_ui_asset_literals.py
```
