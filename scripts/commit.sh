#!/bin/sh
# Book2Text 提交包装：撞上 git 的并发锁就退避重试。
#
# 为什么需要它（2026-10-29 实测）：3–4 个 agent 共用同一个工作树，
# DevLead 一次推送连撞两次 `index.lock`（Builder 在并发提交），第三次才过；我自己也撞过一次。
# **这不是偶发，是并发常态。**
#
# 用法（与 git commit 同形，参数原样透传）：
#   scripts/commit.sh -m "<msg>" -- <paths…>
#   scripts/commit.sh -m "<msg>" -m "<body>" -- <paths…>
#
# 三条边界：
#   1) **只重试"锁"**（`index.lock` / `cannot lock ref` / `Another git process`）。
#      闸红（pre-commit 非零）**不重试**——重试红闸只会拖时间，还会被误读成并发问题。
#   2) 退避 0.3 → 0.6 → 1.2 → 2.4 → 4.8 秒，最多 5 次（总上限约 9.3s）。
#   3) 耗尽后打印最后一次原文，退出码沿用 git 的。
set -u

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "✗ 不在 git 仓库里" >&2; exit 1; }
cd "$REPO" || exit 1

LOCK_RE='index\.lock|cannot lock ref|Another git process|Is another git process running'

# ---- 只把 `--` 之后的路径交给 git add（消息、开关原样留给 git commit） ----
add_paths() {
  seen=0
  for a in "$@"; do
    if [ "$seen" = 1 ]; then printf '%s\0' "$a"; fi
    if [ "$a" = "--" ]; then seen=1; fi
  done
}

# add 也要进重试：它同样会抢 `index.lock`（实测第一次失败就死在 add 上）。
run_once() {
  if add_paths "$@" | grep -qz .; then
    add_paths "$@" | xargs -0 git add -- 2>&1 || return $?
  fi
  git commit "$@" 2>&1
}

# ---- 并发串行化（2026-10-29 假 BYPASS 事故）----
# pre-commit 写 .git/b2t-gate-pass、post-commit 读它比对 tree。两个 Bot 同时提交时
# **后写覆盖先写** → 通过的那笔被记成 BYPASS。修法：把「pre-commit → commit → post-commit」
# 整段用一把锁串起来。macOS 无 flock 命令，用 mkdir 的原子性做锁（可移植）。
LOCKDIR="$REPO/.git/b2t-commit.lock"
n=0
while ! mkdir "$LOCKDIR" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 600 ]; then echo "✗ 提交锁等待超时（.git/b2t-commit.lock 存在）" >&2; exit 1; fi
  sleep 0.2
done
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT INT TERM

i=1
for d in 0.3 0.6 1.2 2.4 4.8; do
  out=$(run_once "$@")
  rc=$?
  if [ "$rc" -eq 0 ]; then
    [ -n "$out" ] && printf '%s\n' "$out" >&2
    exit 0
  fi
  if ! printf '%s' "$out" | grep -qE "$LOCK_RE"; then
    printf '%s\n' "$out" >&2
    exit "$rc"
  fi
  if [ "$i" -ge 5 ]; then
    echo "✗ 连续 5 次撞上 git 锁（最后一次原文）：" >&2
    printf '%s\n' "$out" >&2
    exit "$rc"
  fi
  echo "… 撞到 git 锁，${d}s 后重试（$i/5）" >&2
  sleep "$d"
  i=$((i + 1))
done
exit 1
