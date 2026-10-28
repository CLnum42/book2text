# 23b0102（边 8 回退）确认

## 1. next20 三轮（60 次）

```
run1 20/20
run2 19/20 —— idx14：panelPage=None / label=88 / dom=88 / panelVisible=False
              pendingKey=None / pendingPanelEntry=null
              100ms 后重查：panelVisible 仍 False（**没补开**）
run3 20/20
合计 59/60
```

**回退没有消除症状**，而且抓到的形态是"**状态丢失**"而不是"晚一帧"：
`pendingKey` 是 `None`（不是有值等着恢复），100ms 后也没补开。

这和执行者给的机制（帧末 jump → reset → 守卫藏面板）对不上——那套机制会留下 pending 或能被
`retryReadingPendingPanel` 补回。需要再白盒看一遍，重点：
`openReadingPanel` 首行 `closeReadingPanel → clearPendingPanel` 之后，
谁把 `readingPendingPanelKey` 也清成了 null，以及 `gotoNextUnreviewed` 里
`entry` 查不到/面板没建起来时的重试分支为什么没接住这次。

## 2. smoke

```
smoke 41/45（K1 1 条、K2 0 条单列；其余 44 条：41 过 / 3 失败）
控制台错误 0 条
?checktext=1 自检：0 失败
另外失败：第 50 页差 1（47/46/47）+ 连按 20 次 index17 面板没开（连锁 2 条）
```

和回退前（f41eabf 41/45）**完全同形态**。
