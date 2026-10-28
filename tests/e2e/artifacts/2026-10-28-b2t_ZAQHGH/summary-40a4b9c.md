# 40a4b9c 验收记录（QA）

- 被测：`40a4b9c`（= `646417d` + 一个 `app.js` 提交，`backend/` 其余无改动）
- 环境：worktree `1ee27f9`/后续探针提交 = `40a4b9c` + 只有 `tests/e2e` 探针；
  两套全新副本（每套都删了 `cache/preview-segments.json`）；1423×900 dpr2；队列 859（汉字 567 + 标点 292）
- `pytest -q`（开跑前）：**1002 passed, 0 failed**

## 20 次连按（六轮 + smoke 一轮）

| 轮 | 三方一致 | 高亮 key | 面板/500ms | 三列不一致（面板, 顶部, 左栏） |
|---|---|---|---|---|
| A | 19/20 | 20/20 | 20/20 | (49,48,49) |
| B | 14/20 | 20/20 | 20/20 | (59,58,58) (64,63,63) (66,65,65) (70,69,69) (73,72,72) (99,98,99) |
| C | 19/20 | 20/20 | 20/20 | (131,130,130) |
| D | 17/20 | 20/20 | 20/20 | (149,148,149) (162,161,162) (172,171,172) |
| E | 20/20 | 20/20 | 20/20 | — |
| F | 18/20 | 20/20 | 20/20 | (118,117,117) (130,129,129) |
| smoke | 19/20 | 20/20 | 20/20 | 1 条快照为空（形态未复现） |

合计 **107/120**（89%）。其余判据均过：`none=0`、`missing=0`、面板 20/20 且 500ms 后仍在、
不许谎报完成（「已审 0 / 567 条」，pending 859）、`next-lines` 567 + outside 0 = 567。

## 文档末尾（跳 142）：仍漂，且 `settleKey` 不再清

```
落位  : 顶部 142 / 左栏 142 / 面板 142 / 锚点行 141 / 面板行在视口
        held=67  escape=0  settleKey=01M60AT0...:1  scrollTop 194260/196275
+500ms: 顶部 141 / 左栏 142 / 面板 142 / 锚点行 141 / 面板行不在视口
        held=67  settleKey 仍是同一个 key  scrollTop 193550（自己回滚了 710px）
+1.5s : 顶部 141 / 左栏 141 / 面板 142 / 锚点行 141
        held=68  settleKey 仍是同一个 key  scrollTop 193550
```

- 落位那一帧的修复**生效了**（142 站住了一瞬，不再一落位就 141）。
- 但落位后正文流自己回滚了 710px，面板行被挤出视口；`readingJumpSettleKey` 一直没清
  （面板行不在视口 → settle 分支不清、也不满 12 拍 → `escape=0`），页码却被写成了 141。
- `held` 在这版里是**每个被挡住的 rAF 都 +1**（滚动阶段 91 → 173 → 281），不是“每次跳转 +1”。

## 第二次写入是谁：`leftScroll`（左页列滚动回调）

run F 第 7 跳（面板 118）的 `__b2tPageSyncLog`：

```
gotoEntry : label 118  tilePage 118  ok true
leftScroll: label 117  tilePage 118  ok FALSE   ← 写的页码和它自己看到的页不一致
```

`updateReadingPageFromLeftScroll()` 用 `scrollTop + clientHeight*0.25` 取页，和 QA 的“主导页”口径不同；
它有一条保护「面板开着且 |panelMark.page_no − best.pageNo| ≤ 1 就不写」，
但**只有在 `readingPanelKey` 非空时才生效**。重绘会把 `readingPanelKey` 清空（`renderReading({reset:true})`），
在这个窗口里 `leftScroll` 就写了一个 117；之后 `readingPanelKey` 恢复、新规则“面板行在视口里就不写”
于是把这个**错值钉住**——`settleKey=None`、`held` 一直涨，页码永远不会自愈。

## 左树跳页：marks 数据有，DOM 里是 0（新发现，不是探针问题）

按左树跳到第 50 页（`page_sync tree`，两次 smoke 都 BLOCK 在这里）：

```
marksMapSize 22   markPages [45,59]   marksWindow {page_from:40,page_to:60}
segs 32  lines 82  marksInDom 0  filter=all  label=第50页  panelKey=null
```

mark 数据在、窗口覆盖第 50 页、正文流有 82 行，但**渲染出来的差异标记是 0**，等 1.5s 仍是 0。
用户从左边点一页过去，只看到正文，看不到任何要审的差异。
（先前的 BLOCK 是因为探针的回退用了 `scrollIntoView`（会滚错祖先）；已改成直接滚 `#reading-stream`，
改完仍然 0，说明不是探针。）

## smoke：35/42

- PASS：队列数/行和/分母、文本自检、20 次的面板 20/20、`none=0`、`missing=0`、不许谎报完成、高亮 20/20
- FAIL：20 次三方 19/20；「左栏滚到 120 页」「窗口尺寸变化」两路三方 + 高亮仍不一致
  （面板 99 / 顶部 105 / 左栏 106；面板 99 / 顶部 41 / 左栏 41）——用户主动滚走后面板仍开着，
  新规则“面板行滚出视口就恢复跟随”没有把这两路拉回一致，仍属语义冲突
- BLOCK：左树路径（上面的 marks=0）
