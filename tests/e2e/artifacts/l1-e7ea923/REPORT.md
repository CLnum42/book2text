# L1 第二笔（e7ea923）验证：setupReading 搬进模块后，按钮还活着吗

- 被测：`e7ea923`（worktree = 该提交 + 只有 tests/e2e 探针，`backend/` 无差异）
- 环境：全新副本、1423×900 dpr2、队列 859（567+292）

## 处理器接线（`handlers_probe`，每项要有可观测效果）

| 控件 | 结果 | 证据 |
|---|---|---|
| 过滤器 `#reading-filter` | PASS | `all -> chars` |
| 显示菜单 `#reading-display-open` | PASS | 打开=true，点空白关=true |
| 更多菜单 `#reading-more-open` | PASS | 打开=true，点空白关=true |
| 待审红字 `#reading-pending-toggle` | PASS | `hide-pending: false -> true` |
| 提交 `#reading-submit` | PASS | 0 草稿时 `disabled`（符合预期） |
| 撤销 `#reading-undo` | PASS | 点击弹出确认框（处理器活着），已取消 |
| 盲区出口 `#reading-blindspot` | PASS | `view reading -> review` |
| 键盘 `Enter` | PASS | 面板 key 换到下一处 |
| 键盘 `Esc` | PASS | 面板关掉（panelKey → null） |
| 翻页 `#reading-next` / `#reading-prev` | **不更新页码（基线也有）** | 点 next 后 `scrollTop 0→461`，但 `label` 与 `readingPageNo` 都停在 1 |

**翻页这条不是 L1 第二笔引入的**：在基线上用同一个探针点 `#reading-next`，
同样 `scrollTop` 变了、`label` 不变（`第1页`，`pageNo 1`）。原因在
`updateReadingPageFromLeftScroll()` 的"程序滚动不写页码"早退（`readingUserScrollSeq === readingProgramScrollSeq`），
而 `scrollPdfColumnToPage()` 自己不更新页码——**这是 f4e2637 那套守卫留下的既有缺陷**，
只是以前没测过翻页按钮（一直测的是「下一处未审」）。

## smoke（新口径）

```
smoke 42/45（K1 1 条、K2 1 条单列；其余 43 条：42 过 / 1 失败）
控制台错误 0 条
```

- 控制台错误：**0**（新断言生效，单列一行）
- `?checktext=1` 自检：**0 失败**（`__b2tTextCheckFails` = 0）
- 除 K1/K2 外多 1 条失败：`三方一致：点左树条目（第 50 页）` —— 面板 47 / 顶部 46 / 左栏 47，
  是老的"顶部差 1"形态；基线 smoke 这条是 PASS，本次出现一次，需复跑确认是否偶发。

## 结论

- `setupReading` 的 30 个绑定**没有因为搬到 `init()` 而失效**（九个可测控件全部有可观测反应）。
- 翻页按钮"点了页码不动"是**基线就有的缺陷**，建议单开；它不是这次搬迁引入的，也不该算 L1 的回归。
