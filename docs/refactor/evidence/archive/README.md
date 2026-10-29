# 已删除 worktree 的证据存档（2026-10-29）

这 5 个 `/tmp` 下的临时 worktree 在删除前，把**工作区改动**（`git diff`）与**未跟踪文件**
（名字 + 内容）落成了文件。删树是为了止损：它们各持一份 `.git` 状态，钩子会从**它们所在的树**
读文件——当天账本被 `b2t-mut` 污染（7 条 cherry-pick 被记成 BYPASS）就是这么来的。

| 树 | 基点 | 改了什么 | 证据 |
|---|---|---|---|
| `b2t-mut` | `4de5a8c` | `tests/js/boundary.test.mjs`（变异实验）+ 未跟踪 `module.js`（65 KB 夹具） | `b2t-mut.diff` / `b2t-mut.untracked.txt` |
| `b2t-mv` | `dd835c4` | `app.js` / `merge-view.js` / `tests/e2e/browser/driver.mjs` | `b2t-mv.diff` |
| `b2t-page` | `ec5efca` | `reading-view.js` | `b2t-page.diff` |
| `b2t-r7b` | `3fd8188` | `index.html` + `boundary.test.mjs` | `b2t-r7b.diff` |
| `b2t-stall` | `7293267` | `step-timing.js` | `b2t-stall.diff` |

**这些是消融/变异实验的现场，不是产品改动**——不要拿它们当分支合回。要复现：
`git worktree add /tmp/复现名 <基点> --detach`，再 `git apply` 对应 `.diff`（未跟踪夹具在 `.untracked.txt` 里）。

删树后 `git worktree list` 只剩主目录 + `wt-a2`（当时 10 分钟内有文件改动，疑在跑，未删）。
