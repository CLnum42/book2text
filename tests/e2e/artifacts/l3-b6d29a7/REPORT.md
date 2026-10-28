# L3（b6d29a7）验证：openReading 搬进模块后的冷启/热启

被测 `b6d29a7`（worktree = 该提交 + 只有 tests/e2e 探针）。全新副本、1423×900 dpr2。
`pytest 1002 / tests/js 56（54 pass 2 skip）` 是 DevLead 侧读数，本轮未复跑。

## 1. 冷启（打开项目 → 进审校）

```
API 顺序（只看审校三套）: preview → marks → tree
  过滤后的序列：… , "preview", …, "marks", …, "tree", …
正文流: segs 32（首块）/ readingData.segments 4821
落点: label 1 / pageNo 1 / scrollTop 18（≈0）
请求总数 18（含 open / finish-summary / summary / blocks 等启动请求）
控制台错误 0
```

## 2. 热启（切到「页面确认」再切回审校）

```
reading 三套 API 新请求: 0（列表里没有 preview / marks / tree）
（clear 之后出现的 10 条全是 pages 视图自己的 blocks / block-suggestions / position）
scrollTop: 0 → 0（保持）
segs 32 → 32、readingRendered 32 → 32（没有重复累积）
console 0
```

结论：`openReading` 的 `readingProject === projectId && readingData` 早退按设计生效。

## 3. 用户动过不抢位置

```
真实 wheel 后: label 6 / pageNo 6 / scrollTop 1500
等 3s（含异步补 marks）后: 同样 1500 → stolenBy 0
```

## 4. smoke（新口径）+ 自检

```
smoke 42/45（K1 1 条、K2 1 条单列；其余 43 条：42 过 / 1 失败）
控制台错误 0 条
另外失败：三方一致：点左树条目（第 50 页）—— 面板 47 / 顶部 46 / 左栏 47
?checktext=1 自检：0 失败
```

**注意**：`点左树条目（第 50 页）` 这个差 1 形态又出现了（`e7ea923` 上出现过一次、随后复跑 3 次都是 51/51/51）。
统计上已经不是"0/3 的一次性噪声"级别，建议单开跟踪（形态固定：顶部比面板/左栏少 1）。
