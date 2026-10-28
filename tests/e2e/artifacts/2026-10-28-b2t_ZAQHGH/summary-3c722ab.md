# 3c722ab 验收记录（QA）

- 被测：`3c722ab`（重绘后清掉 host 里无主的残留面板）
- 环境：worktree = `3c722ab` + 只有 tests/e2e 探针；全新副本（删 `cache/preview-segments.json`）；1423×900 dpr2
- `pytest -q`：1002 passed, 0 failed

## 10 轮 × 20 次：三方 200/200

| 轮 | 三方 | 页范围 |
|---|---|---|
| A | 20/20 | 1→49 |
| B | 20/20 | 50→99 |
| C | 20/20 | 102→135 |
| D | 20/20 | 136→172 |
| E | 20/20 | 173→203 |
| F | 20/20 | 205→228 |
| G | 20/20 | 229→275 |
| H | 20/20 | 277→327 |
| I | 20/20 | 332→368 |
| J | 20/20 | 372→455（末尾卡住，见下） |

面板 20/20 且 500ms 后仍在。**这 10 轮没有出现上一版那种整体重置**，所以
`3c722ab` 的“清残留面板”这次没有被触发到——不能算正向验证，但也没有回归。

`reset_diag`（A 轮前后各一次，正常态）：`readingProject=b2t_ZAQHGH`、
`currentProjectId=b2t_ZAQHGH`、`readingAutoJumpDone=true`、`readingDataSegments=4821`、
`panelInHost` 轮前 false → 轮后 true（面板正常打开）。

## 新发现（比页码更严重，建议单开）：队列卡在第 455 页一个渲染不出来的条目

J 轮第 18 次起，`下一处未审` 返回同一个条目，之后再也推进不了：

```
面板 455 / 顶部 455 / 左栏 455   panelKey 01M60BKDA3JEDXXFZ80Z96XKW9:1
targetExists=false  currentLines=0  is-current=0
branch next-lines(idx18) → pending-open(idx19/20)，entryPage 455
```

- 该 block 在库里存在：`01M60BKDA3JEDXXFZ80Z96XKW9`，187 字符，四行，
  内容 `circumspect. This is what the Shih-ching (Book of Odes) means in saying, ...`
- K、L 两轮（追加跑的）**20 次全部停在第 455 页**（`455->455`），三列一直等于 455/455/455，
  所以三方断言是绿的——**它是“按了没反应”，不是页码漂移**，我原来的判据抓不到，靠“页范围没前进”才发现。
- 推测：`gotoReadingEntry` 的 `ensureReadingLineRendered` 没能把这一行挂进 DOM，
  `readingLineNode(key)` 一直是 null，游标因此不前进。

## 关于“重置是重开项目还是只重画流”

这一批没复现重置，无法正面回答。仅有一条间接观测：K/L 卡住后我做的状态读取里
`readingProject` 仍是 `b2t_ZAQHGH`、`readingAutoJumpDone=true`、`readingDataSegments=4821`、
`panelInHost=false`，而 `label=第100页`、`marksWindow 90–110`、`streamSegs 24`——
像是**同一项目内的阅读态被重建**，不是切项目。下次复现时 `reset_diag` 会直接把四个值打出来。
