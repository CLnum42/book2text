# c922cb1 复验：D1 / A4 / A5 / A6

被测 `c922cb1`（worktree 干净、product 无差异），`pytest` 1002 passed，1423×900 dpr2。
**注意：A6 跑到一半被外部 `up` 顶掉（我的 run_dir 被删、`current.json` 指向 20261028-221454），
A6 的“折叠态仍可用”没跑完。**

## D1 Esc 逐级 — PASS

```
编辑态按 Esc : edit …:1 → None，panel 还在，dockHidden=false
再按一次 Esc : panel …:1 → None，dockHidden=true
```

## A4 628 默认高度 — PASS

清掉按项目记忆后，628 下打开面板：

```
innerH 628 / topbar 48 / toolbar 40 / split 282 / grip 6 / dock 252
prefs: {"b2t_ZAQHGH":{"h":252,...}}
48+40+282+6+252 = 628 ✓
```

之前测到 276 是因为本地记着用户拖过的 276（按规格“拖过的记忆优先”），不是默认值错。

## A5 左树折叠 — PASS

```
展开 : tree 232 / pdf 420 / stream 759   style --reading-tree-w: 232px（内联）
折叠 : rail 44×526 @x=0 / pdf 420 / stream 947
       style --reading-tree-w: 44px / class reading-split is-tree-collapsed
展开回 : tree 232 / stream 759
```

## A6 折叠态仍可用 — 部分

- 折叠后窄条 44px 在、页图档位跟着宽度重算：`size=view, naturalWidth=1275, cssWidth=384, ratio=1.66, filter=none` ✅
- **点窄条展开：FAIL**。真实鼠标点 `#reading-tree-rail` 中心，状态不变
  （`tree 0 / stream 947 / class 仍是 is-tree-collapsed`）。`app.js` 里 `#reading-tree-rail`
  只被 `readingTreeApplyCollapsed()` 用来写待审数，**没有 click 监听**；只有工具条的
  `#reading-tree-toggle` 能切换。
- “折叠期间 `scrollReadingToPage` / dominant 不变”没跑完（环境被顶掉）。
