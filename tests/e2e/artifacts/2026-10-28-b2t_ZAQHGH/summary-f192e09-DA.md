# f192e09 任务 91 验收：D 组 + A 组

被测 `f192e09`，worktree = 该提交 + 只有 tests/e2e 探针（`backend/` 无差异），源文件干净。
全新副本、1423×900 dpr2、队列 567 汉字。`pytest -q` 1002 passed。

## D 组

| 项 | 结果 |
|---|---|
| D6 20 次 Enter | **PASS**：已审 0→20 单调、dock `1..20 / 567` 同步、`readingDrafts` +20、下区 276 全程不变、20 个不同 panelKey |
| D1 Enter / Space / E | PASS（Space 前进且草稿 +1；E 进 `contenteditable="plaintext-only"`） |
| D1 Esc 逐级 | **FAIL**：编辑态按一次 Esc → 编辑退出 **且面板一起关掉**（`dockHidden=true`） |
| D2 编辑态 Enter | PASS（不前进、退出编辑、改动进 `readingInlineEdits`） |
| D3 Cmd+Enter | PASS（前进） |
| D4 Shift+Enter | PASS（仍在编辑、无换行、提示「行级文本不支持换行」） |
| D5 记录链路 | PASS（`__b2tNextLog` 有 branch） |

Esc 原因：行级 `onInlineKeydown`（app.js 约 18947）先吃掉 Escape 并 `exitInlineEdit()`，
事件继续冒泡到 document 时 `readingEditingKey` 已是 null、contenteditable 也被摘掉，
于是落到「关面板」分支。修法：行级 handler 里 `event.stopPropagation()`。

## A 组

| 项 | 实测 | 判 |
|---|---|---|
| A1 900 高度合计 | 48+44+526+6+276 = 900；下区默认 276 | PASS |
| A2 上区 | 526（≥246）；(526−18)/30.75 ≈ 16.5 行 | PASS（贴线） |
| A3 手柄 | 拖 −80 → 356；拖 +200 → 248（min）；双击 → 276；刷新后 336 记忆保留 | PASS |
| A4 628 | 下区 **276**（应 252）、上区 **258**（应 ≈282）；`lineH=75`、`rows=3`、`degrade="lineH>40"` | **FAIL** |
| A5 左树折叠 | 类名加上了（`is-tree-collapsed`）、偏好已存，但 `treeW` 仍 232、正文仍 759；**`#reading-tree-rail` 不在 DOM 里** | **FAIL** |
| A6 折叠态可用 | 无法测（A5 没折叠成功） | BLOCKED |
| A7 下区取代浮动面板 | `#reading-panel-host` 父节点是 `reading-dock__body`，列间插槽不存在 | PASS |

**A4 原因**：`readingDockPrefs()` 没有按视口高度改默认值，628 下仍返回 276；
`READING_DOCK_DEFAULT_HEIGHT` 是常量 276，没有 628 → 252 的分支。
**A5 原因（两个）**：
1. `applyReadingSplit()` 把 `--reading-tree-w: 232px` 写成 **内联样式**，
   `.reading-split.is-tree-collapsed { --reading-tree-w: 44px }` 盖不过内联值 → 宽度不变；
2. `renderReadingTree()` 重写 `#reading-tree` 内容时把静态的 `.reading-tree__rail` 一起冲掉
   （实测 `railExists=false`），所以折叠后也没有 44px 窄条。

## 更正一条我自己的误判

之前报「A3 按项目记忆失效、刷新回 276」是我的探针造成的：`qa.py prepare` 会清掉所有
`b2t.*` localStorage。用不清存储的 `page.reload()` 复测，336 保存并在刷新后保留 → A3 PASS。

## 未开始

按验收清单「任何一条不过，不许进下一项」，B/C/E 未开始（A4/A5 不过）。
