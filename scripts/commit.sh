#!/bin/sh
# Book2Text 提交包装：撞上 git 的并发锁就退避重试。
#
# 为什么需要它（2026-10-29 实测）：3–4 个 agent 共用同一个工作树，
# DevLead 一次推送连撞两次 `index.lock`（Builder 在并发提交），第三次才过；我自己也撞过一次。
# **这不是偶发，是并发常态。**
#
# 用法（与 git commit 同形，参数原样透传）：
#   scripts/commit.sh -m "<msg>" -- <paths…>
#
# 三条边界：
#   1) **只重试"锁"**（`index.lock` / `cannot lock ref` / `Another git process`）。
#      闸红（pre-commit 非零）**不重试**——重试红闸只会拖时间，还会被误读成并发问题。
#   2) git 锁退避 0.3 → 0.6 → 1.2 → 2.4 → 4.8 秒，最多 5 次（总上限约 9.3s）。
#   3) 提交锁（下面那把）**等多久按时间算**，默认 600s，可用 `B2T_LOCK_WAIT=<秒>` 覆盖。
#
# 提交锁为什么要有 holder（2026-11-02）：
# 那把锁是 `mkdir` 出来的空目录，**看不出谁持有**。今晚一群人轮流撞上，只能靠人眼看进程表猜
# "是不是又有僵尸锁"。现在锁目录里写一份 holder（pid / 开始时间 / 工作树），
# 等锁时直接打印「谁持有、持有多久、进程还活着吗」；**pid 已死且持有超过 30s ⇒ 判定僵尸锁并接管**，
# 报错永远带上来源、时间、多久以前、进程死活 —— 不允许再出现"锁在，但没人知道是谁"。
set -u

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "✗ 不在 git 仓库里" >&2; exit 1; }
cd "$REPO" || exit 1

LOCK_RE='index\.lock|cannot lock ref|Another git process|Is another git process running'
LOCK_WAIT=${B2T_LOCK_WAIT:-600}
STALE_GRACE=30          # pid 已死、且锁持有超过这么多秒 ⇒ 判僵尸锁

# ---- 只把 `--` 之后的路径交给 git add（消息、开关原样留给 git commit） ----
add_paths() {
  seen=0
  for a in "$@"; do
    if [ "$seen" = 1 ]; then printf '%s\0' "$a"; fi
    if [ "$a" = "--" ]; then seen=1; fi
  done
}

run_once() {
  if add_paths "$@" | grep -qz .; then
    add_paths "$@" | xargs -0 git add -- 2>&1 || return $?
  fi
  git commit "$@" 2>&1
}

# ---- 提交锁：串行化「pre-commit 写 MARK → commit → post-commit 读 MARK」----
# 锁的位置：**git-common-dir**（2026-10-30 修）。
# 原先是 `$REPO/.git/b2t-commit.lock`，而 linked worktree 的 `.git` 是**文件** →
# `mkdir` 必然 ENOTDIR → 空等后报「提交锁等待超时」，worktree 里根本提交不了。
# 为什么不放本 worktree 的 git-dir：锁要串行化的是「pre-commit 写 MARK → commit → post-commit 读 MARK」，
# 而 MARK 在 common dir（多 worktree 共用一本账）——锁跟着 MARK 走，否则两个 worktree 仍会互相踩。
COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
[ -n "$COMMON" ] || COMMON="$REPO/.git"
if [ ! -d "$COMMON" ]; then
  echo "✗ commit.sh：git-common-dir 不是目录（$COMMON）——放不了提交锁，直接退出（不空等）" >&2
  exit 1
fi
LOCKDIR="$COMMON/b2t-commit.lock"

holder_field() {   # holder_field <key> → 值（没有就是空）
  sed -n "s/^$1=//p" "$LOCKDIR/holder" 2>/dev/null | head -1
}

describe_holder() {   # 一行人话：谁持有、多久、死活、来源
  hp=$(holder_field pid)
  hs=$(holder_field start)
  hw=$(holder_field worktree)
  now=$(date +%s)
  if [ -z "$hp" ]; then
    echo "holder 缺失（可能是旧版 commit.sh 或别的工具 mkdir 出来的），无法判断持有者"
    return
  fi
  if [ -n "$hs" ] && [ "$hs" -gt 0 ] 2>/dev/null; then
    held=$((now - hs))
    when=$(date -r "$hs" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "epoch $hs")
  else
    held="未知"; when="未知"
  fi
  if kill -0 "$hp" 2>/dev/null; then alive="进程存活"; else alive="进程已不存在"; fi
  echo "pid=$hp · 已持有 ${held}s（写于 $when，约 $(( held < 0 ? 0 : held ))s 前）· $alive · 来源 worktree=${hw:-未知}"
}

acquire_lock() {
  start=$(date +%s)
  last_note=""
  while :; do
    if mkdir "$LOCKDIR" 2>/dev/null; then
      { printf 'pid=%s\n' "$$"; printf 'start=%s\n' "$(date +%s)"; printf 'worktree=%s\n' "$REPO"; } > "$LOCKDIR/holder" 2>/dev/null
      trap 'rm -f "$LOCKDIR/holder" 2>/dev/null; rmdir "$LOCKDIR" 2>/dev/null' EXIT INT TERM
      return 0
    fi
    now=$(date +%s)
    waited=$((now - start))
    info=$(describe_holder)
    hp=$(holder_field pid)
    hs=$(holder_field start)
    held=0
    [ -n "$hs" ] && held=$((now - hs))

    # 僵尸锁接管：pid 已死 且 锁已持有 > STALE_GRACE 秒
    if [ -n "$hp" ] && ! kill -0 "$hp" 2>/dev/null && [ "$held" -gt "$STALE_GRACE" ]; then
      echo "⚠ 接管僵尸提交锁：$LOCKDIR" >&2
      echo "  持有者：$info" >&2
      echo "  判定依据：pid 已不存在且锁已持有 ${held}s（> ${STALE_GRACE}s 宽限），来源 worktree=$(holder_field worktree)" >&2
      rm -f "$LOCKDIR/holder" 2>/dev/null
      rmdir "$LOCKDIR" 2>/dev/null || rm -rf "$LOCKDIR" 2>/dev/null
      continue
    fi

    if [ "$waited" -ge "$LOCK_WAIT" ]; then
      echo "✗ 提交锁等待超时（等了 ${waited}s，上限 ${LOCK_WAIT}s，可用 B2T_LOCK_WAIT 覆盖）" >&2
      echo "  锁路径：$LOCKDIR" >&2
      echo "  持有者：$info" >&2
      echo "  处理：若是僵尸锁（进程已不存在），确认后可手工 rm -rf 该目录；不确定就找 Chief/DevLead。" >&2
      exit 1
    fi
    # 每 10s 打印一次现状（第一次立刻打），别刷屏也别闷着
    if [ -z "$last_note" ] || [ $((waited - last_note)) -ge 10 ]; then
      echo "… 提交锁被占用：$info；本进程已等 ${waited}s（上限 ${LOCK_WAIT}s）" >&2
      last_note=$waited
    fi
    sleep 1
  done
}

acquire_lock

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
