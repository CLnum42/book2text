# 1b3bb53 验收：A6 补完 + B 组被裁图崩溃阻断

被测 `1b3bb53`（worktree 干净、product 无差异），`pytest` 1002 passed，1423×900 dpr2。

## A6 — PASS（两项都过）

```
折叠: class reading-split is-tree-collapsed, rail 44×526, stream 947
点窄条: class → reading-split, tree 232, stream 759, prefs false
折叠态连按 6 次 Enter:
  面板 第1页 → 顶部1 / 主导1
  面板 第1页 → 顶部1 / 主导1
  面板 第4页 → 顶部4 / 主导4
  面板 第8页 → 顶部8 / 主导8
  面板 第9页 → 顶部9 / 主导9
  面板 第9页 → 顶部9 / 主导9
  class 始终 is-tree-collapsed, stream 始终 947
```

## B 组 — BLOCKED：裁图全挂（1b3bb53 引入的回归）

24 条抽样，**24/24 `#reading-dock-crop` 都是占位文字「放大图稍后接入」**，没有 `data-crop`。
手动调用 `readingCropPaint(entry)` 捕获到：

```
TypeError: Assignment to constant variable.
    at readingCropPlan (app.js:19424)
    at readingCropPaint (app.js:19448)
```

`app.js:19418` 声明了 `const windowW`、`const windowH`，19424/19425 又对它们赋值：

```
const windowH = gap ? rows * gap : bboxH * 2;
const windowW = gap ? (displayW * rows * gap * aspect) / displayH : 0.26;
...
windowW = Math.min(0.98, Math.max(0.08, windowW));   // ← TypeError
windowH = Math.min(0.98, Math.max(0.02, windowH));
```

这是 1b3bb53 改裁窗公式（`displayW/displayH`、40px 封顶）时带进来的：
`c922cb1` 里还是 `let windowW`（grep 已核），所以**只有 1b3bb53 起裁图完全画不出来**。
修法：这两个改回 `let`（或先 clamp 再 const）。

B1–B9 全部依赖 `data-crop`，因此 B 未开始；C/E 按“不过不进下一项”也未开始。
