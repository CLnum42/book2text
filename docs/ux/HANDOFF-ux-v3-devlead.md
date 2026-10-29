# UX V3 交接（2026-10-29，DevLead）

**已落**：`reading-view.js` 两处最小改动（一笔提交，node 124/122 pass）。
**未落**：三项主体改动 + 实机验收。**本会话预算到顶，按"不留半改"的规矩停在这里。**

## 1. 已改（可回退点：提交 `fix(review-ux)`）

| 改了什么 | 位置 |
|---|---|
| **面板开着按 `Enter` 不再跳过当前条**：改为 `draftReading(entry,'kept',null)`；面板关着才 `gotoNextUnreviewed()` | `reading-view.js:467` 附近（`document keydown` 里） |
| **默认主按钮「采用候选」→「保留原文」** | `openReadingPanel` 里 `keep.className = "btn btn--pri btn--sm"`，`adopt` 去掉 `btn--pri` |

**这是用户报的那个 bug**："面板开着按 Enter 会跳过当前条且不记录"——原代码 `if (event.key === "Enter") gotoNextUnreviewed()` 无条件跳。

## 2. 剩下的三件（都没动，位置已定位）

| 项 | 位置 | 要做成什么 |
|---|---|---|
| **一条 = 一处差异** | `reading-view.js:1525 openReadingPanel(entry)` 里 `candidate` 那两行 | 只显示差异片段 ±6 字（`entry.before/after` 或 diff 计算），原文/候选各一行，差异字加粗+下划线；「看整行」按钮才展开全文 |
| **进度说人话** | `reading-view.js:2933 renderReadingProgress()`，`:2940` 就是 `` `已审 ${processed} / ${total} 条` `` | 主数字改成「待判 N 处」；判过 20 条后给「按最近 20 条速度，约剩 M 分钟」；汉字/标点两条独立轨 |
| **左树按章折叠** | `reading-view.js` 的 `renderReadingTree` | 章节行默认折叠，展开状态要能跨重绘（`readingTreeExpandedChapters` 已存在） |

## 3. 验收（Chief 定的终态，一条都没跑）

```
① 真页面连续判 20 条：无跳过、无错记、面板位置不动
② 「保留原文」是默认焦点（Enter 直接生效）
③ step-timing 里审校段的判决数 / 面板切换数 / stall 次数能读出来
④ 推送
```

**① 现在还不成立**：Enter 已能判决，但**没有实机连判 20 条**。报告里不许写"优化好了"。

## 4. 跑起来的命令

```bash
sh scripts/status.sh
.venv/bin/python tests/e2e/qa.py up && .venv/bin/python tests/e2e/qa.py prepare
.venv/bin/python tests/e2e/qa.py step review      # 进审校
node tests/js/run.mjs                             # 124 条
.venv/bin/python -m pytest -q                     # 1002 条
```

## 5. 一条边界（Chief 说过，我照办）

**`review` 的代码不要搬**——43/61/17 那份名单和 40 个纠缠函数都收进抽屉，UX 重写会把它们改写掉，那时纠缠自然解开。
