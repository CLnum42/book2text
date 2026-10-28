# 边 9 临时回同步（实验态工作区，非 HEAD）——next20 三轮

工作区：`M backend/book2text/static/app.js`（`queueReadingIntent("goto") → updateReadingPage(entry.page_no, {syncStream:false, scrollLeft:false})`）
+ `M docs/refactor/edge-budget.json`；HEAD 仍是 `eb5c4b4`（只有 tests/e2e 提交）。
环境：全新副本、1423×900 dpr2。

## 结果

```
run1 20/20
run2 20/20
run3 20/20
合计 60/60；控制台错误 0
```

**没有失败样本**，所以本轮没有 pending 值 / 100ms 补开数据可报（N/A）。

## 对照（同一探针、同输入）

| 状态 | 结果 |
|---|---|
| `afe20fe`（ring-break-base，回退前基线） | 120/120 |
| `f41eabf`（边 8 切后） | 118/120 |
| `23b0102`（边 8 回退） | 59/60（pending=None，100ms 不补开） |
| **边 9 临时回同步（本轮）** | **60/60** |

按 DevLead 的判读规则：**60/60 → 边 9 就是触发器**。
建议按"顺序依赖边"单独回退边 9，然后开 L5。
