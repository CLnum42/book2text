# 2026-11-02 协作刀真机验收（结论 / 读数 / 未验）

环境：QA 库 `/tmp/b2t-qa4/lib`，独立 worktree 起服务（不在主树），视口 1423×900。
两棵树：原始验收 `e0dce3d`；下载/终态复验 `3a7d7ba`（origin/main 已推，等于本地 main tip）。

## 结论（e0dce3d）

| # | 判据 | 结果 | 关键读数 |
|---|---|---|---|
| ① | 指派面板：打开→预览→建分派→列表刷新→取消 | 过 | 预览「可派 2 页 ＋ 只读上下文 2 页」；建分派列表 1→2、页 9/10 出现「QA协作刀 · 审校中」；下载任务包 413,760 B 合法 zip；取消后列表「已作废」、徽标同步消失；重新导出不增条目 |
| ② | 任务包模式：横幅 + 隐藏 structure-open / finish-open-review + 能导出结果包 | 过 | 横幅「审校任务：第 11、12 页（另附只读上下文第 10、13 页） · 来自 QA · 说明：协作刀导入用」；`structure-open.hidden=true`（父 #export-panel）、`finish-open-review.hidden=true`（父 #view-review）；导出结果 4 KB 入列表 |
| ③ | 包文件导入：.b2tpkg → 新项目 → 横幅/列表 | 过 | 新项目 `b2t_C2MQ9A`（kind=package，4 页：10/11/12/13，2 个只读上下文）；库列表新增；横幅/chip/`package-open` 正确 |
| ④ | 结果包下载 | e0dce3d 未过；3a7d7ba 已过 | 旧：单数 `/package/result/` → 404；新读数见下「复验」 |
| ⑤ | console 0（含 unhandledrejection） | 过 | 全部探针 0 |

DevLead 四条：**A 过**（两个 mask 的 Esc / 遮罩空白 / X 都关、无孤儿 mask；Esc 顺带清页面多选是旧行为）；
**B 过**（坏扩展名 / 坏 zip 都在面板报错，列表 3→3）；**C 过**（normal false/false ↔ package true/true 两轮）；
**D 取消分派过**（列表 + 页 9/10 徽标同步）；**撤销自动通过未验**（见下）。

## 复验（3a7d7ba）

```
④ 下载成功：GET /api/projects/b2t_C2MQ9A/package/results/<name>（复数）→ 200
   download 事件触发；path() 落盘 4,348 B 合法 zip（result.json / events.json / summary.json）
④ 下载失败（把列表里第一个结果包临时改名 → 同一按钮 → 404）：
   save「下载失败」；inline style.color = var(--bad-fg)；computed rgb(185, 28, 28)；文件已复原
⑤ 导出成功：meta「已生成 识别进度测试_11–12_QA协作刀2_结果4_20261103.b2tres，可在下面下载」
   （<文件名> 已替换为真名，不是占位符）
⑤ 坏包导入：save「导入失败：结果包导入失败」+ 红字（var(--bad-fg)）；
   面板错误条「结果包导入失败 错误编号 97f6350f5f61 这不是一个结果包（zip 读不开）」
console：0
备注：下载成功分支仍不写 save 文案（成功时 save 为空）；「下载失败」不再出现。
```

## 未验（含缺什么样本）

**撤销自动通过 → 徽标同步**：当前库 0 页可自动通过，所以这条没验。需要的样本：

```
至少 2 页同时满足：include=正文 · recognized（非 failed/unrecognized）· layout_confirmed=true ·
margin 已定（margin_box_mode/box 有值）· 无未处理 divergence · suggestion_count=0 · 无 ink_gap ·
已跑第二引擎（aux_checked=true）· 未被 auto_pass_excluded。
一页用于「自动通过 → 撤销」（看徽标 自动通过（未经人工）→ 待处理 是否同步），另一页作对照。
现库实测：page 7 只差 layout+margin（且没有文字行）；page 100 确认版面 + 跑第二引擎后出现 divergence；
其余页至少带 unrecognized / layout_unconfirmed / margin_unconfirmed / suggestions / divergence / single_engine 之一。
```

其余未验：助手回传 `.b2tres` 的成功导入（→ 合并审阅，没有真实结果包）；包模式下 pages 面板另外 ~10 个入口、
审校面板另外 2 个入口的单独显隐（只验了 `structure-open` / `finish-open-review` 与 `package-open`/banner/chip）；
导出结果包的内容正确性（只验了列表/命名/下载）。

## 文件

- `assign-panel.jpg`（分派面板：3 条分派 + 预览 + 坏包报错）、`package-mode.jpg`（任务包项目：横幅 + chip + 4 页）
- `result.json`（机读结论；含 `post_fix`）
- 原始明细读数（9 个探针 JSON、task.b2tpkg 等）在 `/tmp/b2t-qa/2026-11-02-collab/`
