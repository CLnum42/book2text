# 209afd4 任务 91 验收：D 组（键盘）先行

被测 `209afd4`，worktree = `209afd4` + 只有 tests/e2e 探针（`backend/` 无差异），
`git status --short` 源文件为空。全新副本、1423×900 dpr2、队列 567 汉字。
`pytest -q`：1002 passed。**按 DevLead 的规则，D6 挂了，A/B/C/E 未开始。**

## D6（连续判 20 条）— FAIL

干净起点：先 `Enter` 打开第一条，再连按 **20 次 `Enter`**（全程没有移动鼠标）：

```
草稿 readingDrafts：0 → 20        ✓ 20 条全部被记录
已审 计数：#reading-progress-text 已审 0 → 3   ✗ 应 +20
下区高度：276 全程不变             ✓
面板：20 次都前进（20 个不同 key）  ✓
```

而且计数会**倒退**（第一轮 20 次跑的逐次序列）：`0→1→2→3→4→5→4→5→6→…→12→3→4→1→0`。

原因：`renderReadingProgress()` 的"已审"= 服务端已提交数 + **当前 marks 窗口内**的草稿数
（`readingEntries.filter(readingEntryDone)`）。窗口一换（跳到别的页），之前的草稿就不在当前
`readingEntries` 里，计数掉下来；`#reading-dock-count` 更彻底，全程 `0 / 567`，完全不计草稿。

## D1–D5（逐项）

| 项 | 观察 | 判 |
|---|---|---|
| D1 Enter=保留并下一处 | 20 次全部前进，`__b2tNextLog` 有 branch | ✓ |
| D1 Space=采用并下一处 | 前进；`readingDrafts` +1 | ✓ |
| D1 E=编辑 | 进入编辑态，`contenteditable="plaintext-only"` | ✓ |
| D1 Esc=逐级退出 | **编辑态按一次 Esc：编辑退出 + 面板一起关掉（dockHidden=true）** | ✗ 不是逐级 |
| D2 编辑态 Enter | 不前进 ✓、退出编辑 ✓、改过的字进 `readingInlineEdits` | ✓ |
| D3 编辑态 Cmd+Enter | 前进 ✓ | ✓ |
| D4 Shift+Enter | 仍在编辑态、无换行、提示「行级文本不支持换行」 | ✓ |
| D5 记录链路 | 前进走 `gotoNextUnreviewed`，`__b2tNextLog` 有 branch | ✓ |

## 建议

1. 「已审」计数不能按窗口算：`readingDrafts` 是全局 Map，直接用它（+ 已提交数）算，或在切窗口时保留已落草稿的计数；
2. `#reading-dock-count` 要与「已审」同口径，至少把草稿算进去；
3. 编辑态 `Esc` 只退出编辑，面板留着；第二下 Esc 再收（现在一下全关）。
