# 合并审校页面级验证 — 2026-10-29

被测：`d3d0c9a`（干净 worktree `/tmp/b2t-merge`；主仓工作区有未提交的 reading-view 改动，故不用主仓）
要验的两个 P0 修复（`08dda77`）：**进合并视图白屏** / **原图 URL `&injected.token=` 导致 401**

## 怎么造的真实现场

API 层：分派第 1 页 → 下载 `.b2tpkg` → 同库打开任务包（新增 `kind=package` 项目）
→ 助手端**改一处文本**（`第一回` → `第一回［QA改动］`）→ 导出 `.b2tres`。
浏览器层：`fetch` 真实导入（同 token、同 Content-Type）→ `mergeState = payload` → `showView("merge")`
→ 点左侧第一页 → 看原图。

## 结果

### 白屏：已修复

```
importStatus 200
viewVisible  true
title        合并审校结果：QA 合并验证
meta         第 1 页 · 结果 2
statChanged  变化 1 页
pagesChildren 1
textLen      525
errorText    （空）
```

第一次用"无改动"结果包时 `变化 0 页`、列表只有"没有符合条件的页面"，所以原图路径没走到——
那一次只能验白屏（已绿），验不到 401。改成有改动的结果包后两个都验到。

### 401：已修复

```
merge-image src  /api/projects/b2t_H6GXVG/pages/1/image?size=view&token=qa-20261029-182429-89120
hasTokenParam    true
naturalWidth     932          ← 图真的加载了，不是 401 占位
complete         true
canvasHidden     false
网络 401/403      0
```

URL 带 `&token=`，图片加载成功，全程没有 401。

## 文件

- `merge-no-change.json`：变化 0 页那次（只验白屏）
- `merge-with-change.json`：改一处后（白屏 + 401 都验到）
