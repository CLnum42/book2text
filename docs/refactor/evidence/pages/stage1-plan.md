# `pages` 刀一（渲染与加载）执行清单

> 依据：`docs/refactor/pages-plan.md`（5 刀顺序）+ `semantic-ops.md`（操作 1 = 987 行 / 16 函数）。
> 本文只列可核对的：函数名与调用者行号都从 `HEAD:app.js` 现算。

## ① 刀一要搬的函数与调用者

### 1a. 归并表点名的 6 个

| 函数 | 行数 | 调用者（app.js:行 → 所在函数） |
|---|---:|---|
| `loadLayoutBlocks` | 40 | `5535→scheduleLayoutBlocks` · `5700→confirmLayoutFromPanel` |
| `loadSetupSuggestions` | 19 | `235→showView` · `4220→openPageSetup` · `4389→applySetupSuggestion` · `4416→confirmPageIds` |
| `refreshRecognizedPages` | 25 | `7195→pollTask` · `7216→pollTask` |
| `renderLayoutBlocks` | 101 | `615→renderStepPanels` · `5528→scheduleLayoutBlocks` · `5532→scheduleLayoutBlocks` · `5543→loadLayoutBlocks` |
| `renderMarginPanel` | 116 | `609→renderStepPanels` · `760→ensureMarginFitted` · `3859→updateSelectionPanel` · `5087→toggleMarginView` |
| `renderPageSetup` | 28 | `232→showView` · `6883→renderPages` · `6911→syncPageStates` |

### 1b. 剩下的 10 个：**阻塞在这里，不编**

`semantic-ops.md` 操作 1 那格是 `loadLayoutBlocks、loadSetupSuggestions、refreshRecognizedPages、renderLayoutBlocks、renderMarginPanel、renderPageSetup…`——**省略号后面还有 10 个没列名**（16 − 6）。
按「不许只写数字」的要求，这 10 个必须由 Architect 补齐，或给一条可机读的派生规则（例如「操作 1 = 这 6 个的 `stays` 被调用者传递闭包，取到 987 行」）。
**补齐之前刀一不能开工**：照 6 个搬只落 400 行上下，其余仍在 app.js 里渲染，R3 也降不到 §③ 的档位。

## ② 每个函数搬走后 `app.js` 那几行变成什么

| 情形 | 那一行变成什么 | 判据 |
|---|---|---|
| **调用者同批进模块** | 整段删掉，**不留转发器** | 模块里该名字恰好 1 处定义 |
| **调用者留外壳**（`boot`/`setupShell`/`setupLibrary`/`showView` 这些装配点） | 调用点改成 `window.PagesView.<语义操作>(…)`，一个语义操作一个出口；转发器不保留 | 每个出口在 `VIEW_EXPORTS` 逐个登记 |
| 只在模块内部被调（4 个无调用者） | 整段删掉 | R4-dup 的「真实现份数 = 1」 |

**禁止**：给 63 个函数各留一条转发器——那正是 `LANDING.md §6` 记的 `undefined.apply` 形态。

## ③ 刀一允许 R3 降到哪一档

| 时点 | `view-pages` 字面量处数（`accept_pages.py ②`） |
|---|---|
| 现在（基线） | **270 处 / 116 个 id** |
| 刀 1 落完 | **必须 < 216 处**（降幅 ≥20%），且**不许新增 R3 豁免** |
| 刀 5 落完 | **0 处** |

> 20% 是「刀 1 占 stays 部分 987/1,696」按比例给的**下限**，不是目标；实际降多少以落盘实测为准并写进验收报告。

## ④ 回滚判据

```
sh scripts/rollback_pages.sh     # 复原 app.js + index.html、删 page-pages.js
node tests/js/run.mjs            # 必须 fail 0
git log --oneline -1             # 记下回到的那个 sha，写进本文件「刀 1 已回滚」一行
```
**干净的定义**：`git status --porcelain` 只剩别人的改动 + `page-pages.js` 不存在 + node 闸 `fail 0`。
**回滚后必须通知**：Builder 停 acid、TestDev 停夹具调整、Chief 一句带 pass/fail 数（开发协调群）。

## ⑤ 明天开工顺序

1. §1b 的 10 个补齐 → 逐个算调用者 → 确认哪些调用者要同批进模块；
2. 三张登记表先改（`OWNERS` / `VIEW_EXPORTS` 五出口 / `VIEW_STATE_PREFIXES`）；
3. `land_pages.sh`（第 0 步会拦「工作区里有别人的 M」）；
4. 落盘后立刻 `accept_pages.py --acid`（缺 acid = 未验，不许当通过）；
5. 一笔 `move(pages): 渲染与加载`，`Approved-by` 找 Architect。
