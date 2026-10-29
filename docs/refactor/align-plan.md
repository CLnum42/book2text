# 指针对齐方案（只写不执行；执行需令牌）

> 现状：主工作区 `behind 2`，且盘上有 DevLead 未提交的 `rules.py` / `build_view.py` / `HANDOFF`。
> **主工作区一律不动**——`rebase` / `merge` 都会把它们搅进去；`merge` 已被列入禁用。

## 工具与位置

```
临时 worktree：/tmp/b2t-align-<时间戳>      （--detach origin/main）
清理：trap 'git worktree remove --force …; git worktree prune' EXIT   ← 写在退出路径，不写成功路径
```

## 顺序（直线历史，不用 merge）

1. `git fetch origin` → 记 `origin/main` 的 sha 为 BASE；
2. 临时 worktree `git worktree add --detach /tmp/b2t-align-XXXX origin/main`；
3. 按 **时间正序** `git log --reverse --format=%H BASE..<本地 tip>` 逐笔 `cherry-pick`；
4. 全部成功 → `git push origin HEAD:main`（**只这一步需要令牌**）；
5. 校验：`git cat-file -e <每个新 sha>` 且 `git merge-base --is-ancestor <新 sha> origin/main`；
6. 清理 worktree（`trap` 保证失败也清）。

## 冲突时谁停

**任何人都不许在临时 worktree 里手改内容解冲突。**
- 冲突 = 两笔在改同一个文件的同一处 → **停下，把冲突文件名与两侧 sha 报给 Chief**；
- 由文件作者决定：撤自己那笔 / 由对方重放 / 放弃该笔。

理由：**冲突手改等于在"对齐"这个动作里塞进一次未评审的编辑**，而那正是今天所有事故的形态。

## CAS（指针只在"同名同 tree"时换）

```sh
test "$(git rev-parse origin/main)" = "$EXPECT_BASE" || { echo "BASE 变了，重来"; exit 1; }
git push origin HEAD:main    # 非快进会被远端拒；远端拒 = BASE 变了
```

**不做 `update-ref` 直改本地 ref 之外的任何东西**；`update-ref` 只用于"确认无误后把本地 main 指到新 tip"，
前置断言：`git rev-parse HEAD^{tree}` 与目标 sha 的 tree 相同，且 `git diff --stat` 为 0。

## 已知的空壳（本次核实）

`118762b` / `bad4d94` / `ed74585` 三笔：`merge-base --is-ancestor` 为假，但
`git diff --stat origin/main..HEAD -- <各自涉及文件>` **为空** → **内容已在 origin/main，是空壳**。
对齐时**跳过它们**（cherry-pick 会报 "nothing to commit"，直接 `--skip`）。
