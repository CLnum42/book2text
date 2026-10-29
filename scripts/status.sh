#!/bin/sh
# scripts/status.sh —— 机械状态，一条命令。
#
# 为什么要有它：同一个事实今晚出现过三个版本（3eddbda / 01200d8 / d6606b1），三次有人按旧快照空转。
# **根治方式不是更勤地问，是把机械那半变成一条命令**；人工那半（在等谁、下一件）在
# docs/refactor/STATUS.md，那里禁写会漂的数。
#
# 约束（每一条都有原因，别改）：
# 1) **只读**：不写任何文件（尤其不写 STATUS.md——写文件会把工作区弄脏，而它正是要报"脏不脏"）。
#    唯一的写操作是 `git fetch` 更新 .git/FETCH_HEAD，可用 `--no-fetch` 跳过。
# 2) **任意 cwd 可用**：用 `git rev-parse --show-toplevel` 定位仓库，不假设当前目录。
# 3) **默认先 fetch**：不 fetch 它自己就是"另一处会漂的源"。离线用 `sh scripts/status.sh --no-fetch`。
# 4) 缺项**明说"不存在"**，不留空——空行会被读成"0"或"没问题"。
# 5) 纯 shell + git，无新依赖。任何一条取不到 → 打印 `?` 并 **exit 0**
#    （它是仪表盘，不是闸：不能因为某个 agent 环境缺东西就把人卡住）。
#
# 用法：sh scripts/status.sh [--no-fetch]

set -u

FETCH=1
for arg in "$@"; do
  case "$arg" in
    --no-fetch) FETCH=0 ;;
    -h|--help)
      echo "用法：sh scripts/status.sh [--no-fetch]"
      exit 0
      ;;
  esac
done

# ── 0. 定位仓库（cwd 无关） ────────────────────────────────────────────────
# 先按**脚本自身位置**定位（这样从 `/tmp` 用绝对路径跑也能用），再退回 cwd。
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
REPO=""
if [ -n "${SCRIPT_DIR:-}" ] && [ -d "$SCRIPT_DIR/.." ]; then
  REPO=$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || true)
fi
if [ -z "$REPO" ]; then
  REPO=$(git rev-parse --show-toplevel 2>/dev/null || true)
fi
if [ -z "$REPO" ]; then
  echo "? 找不到仓库（当前目录：$(pwd)，脚本目录：${SCRIPT_DIR:-?}）"
  echo "  这个脚本必须在某份 checkout 的 scripts/ 下运行。"
  exit 0
fi
cd "$REPO" || { echo "? 进不去仓库目录：$REPO"; exit 0; }

# 千分位（POSIX sh 没有内置的，用 awk 兜）
fmt() {
  awk -v n="${1:-}" 'BEGIN{
    if (n !~ /^[0-9]+$/) { print "?"; exit }
    s = sprintf("%d", n); out = ""; len = length(s)
    for (i = 1; i <= len; i++) {
      out = out substr(s, i, 1)
      if ((len - i) % 3 == 0 && i < len) out = out ","
    }
    print out
  }'
}

# ── 1. 先 fetch（否则自己就是旧快照） ──────────────────────────────────────
if [ "$FETCH" = "1" ]; then
  git fetch -q 2>/dev/null || echo "? git fetch 失败（离线？可用 --no-fetch 跳过）"
fi

# ── 2. HEAD / origin/main / ahead / behind / 工作区 ────────────────────────
HEAD_SHA=$(git rev-parse --short HEAD 2>/dev/null) || HEAD_SHA="?"
ORIGIN_SHA=$(git rev-parse --short origin/main 2>/dev/null) || ORIGIN_SHA="?"

if [ "$ORIGIN_SHA" != "?" ]; then
  COUNTS=$(git rev-list --left-right --count origin/main...HEAD 2>/dev/null) || COUNTS=""
  if [ -n "$COUNTS" ]; then
    BEHIND=$(printf '%s' "$COUNTS" | awk '{print $1}')
    AHEAD=$(printf '%s' "$COUNTS" | awk '{print $2}')
  else
    BEHIND="?"; AHEAD="?"
  fi
else
  BEHIND="?"; AHEAD="?"
fi

STATUS_LINES=$(git status --porcelain 2>/dev/null) || STATUS_LINES=""
UNTRACKED=$(printf '%s\n' "$STATUS_LINES" | grep -c '^??' 2>/dev/null || true)
TRACKED_CHANGED=$(printf '%s\n' "$STATUS_LINES" | grep -vc '^??' 2>/dev/null || true)
: "${UNTRACKED:=0}"; "${TRACKED_CHANGED:=0}" 2>/dev/null || true
if [ -z "$STATUS_LINES" ]; then
  WORKSPACE="干净"
else
  WORKSPACE="脏（${TRACKED_CHANGED:-0} 个已跟踪改动 / ${UNTRACKED:-0} 个未跟踪）"
fi

printf 'HEAD        %s\n' "$HEAD_SHA"
printf 'origin/main %s\n' "$ORIGIN_SHA"
printf 'ahead %s / behind %s / 工作区 %s\n' "${AHEAD:-?}" "${BEHIND:-?}" "$WORKSPACE"

# ── 3. 各模块行数（缺的明说"不存在"） ─────────────────────────────────────
echo "---"
STATIC_DIR="$REPO/backend/book2text/static"
# 模块清单**从代码派生**，不手写：
#   磁盘上已有的 `*-view.js` ∪ `index.html` 里 `<script src="/static/x-view.js">` 引用的。
# 后者能让"页面引了但文件没落盘"这种真缺陷显示成 `不存在`（手写清单会漂，而且没人盯）。
MODULES="app.js"
VIEW_FILES=""
if [ -d "$STATIC_DIR" ]; then
  for f in "$STATIC_DIR"/*-view.js; do
    [ -e "$f" ] || continue
    VIEW_FILES="$VIEW_FILES $(basename "$f")"
  done
  if [ -f "$STATIC_DIR/index.html" ]; then
    REFERENCED=$(grep -oE '/static/[A-Za-z0-9_-]+-view\.js' "$STATIC_DIR/index.html" 2>/dev/null \
      | sed 's#/static/##' | sort -u)
    for name in $REFERENCED; do
      case " $VIEW_FILES " in
        *" $name "*) ;;
        *) VIEW_FILES="$VIEW_FILES $name" ;;   # 引用了但文件不在 → 下面会打印"不存在"
      esac
    done
  fi
fi
for name in $(printf '%s\n' $VIEW_FILES | sort -u); do
  MODULES="$MODULES $name"
done
# 名字列宽对齐（最长名字 + 2）
WIDTH=$(printf '%s\n' $MODULES | awk '{ if (length($0) > m) m = length($0) } END { print m + 2 }')
for name in $MODULES; do
  path="$STATIC_DIR/$name"
  if [ -f "$path" ]; then
    lines=$(wc -l <"$path" 2>/dev/null | tr -d ' ')
    printf "%-${WIDTH}s %9s\n" "$name" "$(fmt "$lines")"
  else
    printf "%-${WIDTH}s %9s\n" "$name" "不存在"
  fi
done

# ── 4. 闸：绕过次数 + 最近一次 pre-push pytest ────────────────────────────
echo "---"
COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null \
  || git rev-parse --git-common-dir 2>/dev/null || echo "")
[ -n "$COMMON" ] && [ "${COMMON#/}" = "$COMMON" ] && COMMON="$REPO/$COMMON"

BYPASS_LOG="$COMMON/b2t-gate-bypass.log"
if [ -f "$BYPASS_LOG" ]; then
  # **按第 3 列 tag 聚合**，不按行数：账本里有表头注释（`#`）和空行，
  # 按行数数会把它们算成"绕过"（2026-10-29 实测：按行数是 10，实际绕过 6）。
  # 格式：时间 \t sha \t tag \t branch@worktree \t 理由 \t subject
  COUNTS=$(awk -F'\t' '
    /^[[:space:]]*#/ { next }
    NF < 3 { next }
    {
      tag = $3
      if (tag == "BYPASS") bypass++
      else if (tag == "BYPASS-WITH-REASON") withReason++
      else if (tag == "REWRITE") { rewrite++; last = $1 }
      else if (tag == "MUTATION") mutation++
    }
    END {
      printf "%d|%d|%d|%d|%s\n", bypass + 0, withReason + 0, rewrite + 0, mutation + 0, (last == "" ? "-" : last)
    }
  ' "$BYPASS_LOG" 2>/dev/null)
  # 用 `|` 分隔取字段：时间列本身含空格（`2026-10-29 10:48:36`），按空白取会被截成日期
  BYPASS_N=$(printf '%s' "$COUNTS" | cut -d'|' -f1)
  REASON_N=$(printf '%s' "$COUNTS" | cut -d'|' -f2)
  REWRITE_N=$(printf '%s' "$COUNTS" | cut -d'|' -f3)
  MUTATION_N=$(printf '%s' "$COUNTS" | cut -d'|' -f4)
  REWRITE_LAST=$(printf '%s' "$COUNTS" | cut -d'|' -f5)
  TOTAL=$(( ${BYPASS_N:-0} + ${REASON_N:-0} ))
  printf '闸：绕过 %s 次（BYPASS %s / BYPASS-WITH-REASON %s）\n' "$TOTAL" "${BYPASS_N:-0}" "${REASON_N:-0}"
  if [ "${MUTATION_N:-0}" != "0" ]; then printf '    变异实验 %s 次（MUTATION，非绕过）\n' "$MUTATION_N"; fi
  if [ "${REWRITE_N:-0}" -gt 0 ]; then
    printf '    重写 %s 次（REWRITE，不计入绕过；最近一次 %s）\n' "$REWRITE_N" "$REWRITE_LAST"
  else
    printf '    重写 0 次（REWRITE，不计入绕过）\n'
  fi
else
  echo "闸：绕过 0 次（BYPASS 0 / BYPASS-WITH-REASON 0）——.git/b2t-gate-bypass.log 不存在"
  echo "    重写 0 次（REWRITE，不计入绕过）"
fi

# ── 4.5 闸 A 登记红灯（R12 登记段：不阻断提交，这里与 CI 负责看见） ──────────
# 只读、一行读数。缺 node 或脚本时明说，不用 0 冒充健康（仪表盘不是闸，见文件头约束 5）。
NODE=""
for c in "$(command -v node 2>/dev/null)" "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -n "$NODE" ] && [ -f "$REPO/tests/js/contract-registry.mjs" ]; then
  REG=$("$NODE" "$REPO/tests/js/contract-registry.mjs" 2>/dev/null) || REG=""
  printf '闸A登记  %s\n' "${REG:-?}"
  case "${REG:-}" in
    *红灯*|*✖*|*不合格*) printf '          修法：给点名那笔补 §18.6 登记（登记段规格见 §18.6 / §18.2.1）\n' ;;
  esac
else
  echo "闸A登记  ?（node 或 tests/js/contract-registry.mjs 缺失）"
fi

PYTEST_LOG="$COMMON/b2t-pytest.log"
if [ -f "$PYTEST_LOG" ]; then
  LAST=$(tail -n 1 "$PYTEST_LOG" 2>/dev/null)
  KIND=$(printf '%s' "$LAST" | awk -F'\t' '{ if ($1 == "RANGE") print "RANGE"; else if ($2 == "SKIP") print "SKIP"; else print "?" }')
  case "$KIND" in
    RANGE)
      # RANGE<TAB><sha><TAB><date><TAB><N files>
      SHA=$(printf '%s' "$LAST" | awk -F'\t' '{print $2}')
      COUNT=""
      if [ -f "$COMMON/b2t-pytest.out" ]; then
        COUNT=$(grep -oE '[0-9]+ passed' "$COMMON/b2t-pytest.out" 2>/dev/null | tail -n 1 | awk '{print $1}')
      fi
      printf '    最近一次 pre-push pytest：PASS %s（RANGE %s..HEAD）\n' "${COUNT:-?}" "${SHA:-?}"
      ;;
    SKIP)
      SHA=$(printf '%s' "$LAST" | awk -F'\t' '{print $1}')
      printf '    最近一次 pre-push pytest：SKIP（md-only，%s）\n' "${SHA:-?}"
      ;;
    *)
      printf '    最近一次 pre-push pytest：?\n'
      ;;
  esac
else
  echo "    最近一次 pre-push pytest：不存在（还没在装闸后推送过）"
fi

# ---- 并发信号（2026-10-29 Chief 加）：没人会主动报"我们俩在同一个树上动" ----
GITDIR_CONC=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo .git)
if [ -e "$GITDIR_CONC/index.lock" ]; then LOCK="有（index.lock 存在）"; else LOCK="无"; fi
COMMIT_10M=$(git log --since="10 minutes ago" --oneline 2>/dev/null | wc -l | tr -d ' ')
UNPUSHED=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
printf '并发       工作区锁 %s / 最近 10 分钟提交 %s 笔 / 未推 %s 笔\n' "$LOCK" "$COMMIT_10M" "$UNPUSHED"

exit 0
