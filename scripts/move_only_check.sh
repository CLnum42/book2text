#!/bin/sh
# move_only_check.sh —— 判「这一次改动只搬行、不改逻辑」
#
# 用法：
#   sh scripts/move_only_check.sh [path] [--expect-wire N]
#   默认 path = backend/book2text/static/app.js，默认 --expect-wire 1
#
# 为什么不是 plan 里那条裸 `comm -3`（2026-10-30 实测）：
#   抽 `wirePagesXxx()` 必然新增 4 类**结构胶水**——文档注释、`function wireXxx() {`、
#   调用行 `wireXxx();`、多出来的一个闭合 `}`。裸命令把这些全算成「新增了内容」，
#   于是**任何抽函数都不可能为空**，判据就退化成「永远红」而没人看。
#   所以这版把胶水单独计数，逻辑行要求**逐行同序完全相等**（比多重集更强：顺带挡住重排）。
#
# 胶水的额外约束（防止「只加函数不接线」或「只接线不搬」）：
#   · 函数头数 == 调用行数                      （一个 wire 函数必须恰有一处调用）
#   · 新增闭合 `}` 数 == 函数头数                （每个新函数恰多一个 `}`）
#   · 函数头数 == --expect-wire 给的数            （与名单对集，不按感觉）
#
# 退出码：0 = 只搬行；1 = 有逻辑行走样 / 胶水不配对；2 = 用法或环境错误。
set -u

PATH_SPEC="backend/book2text/static/app.js"
EXPECT_WIRE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --expect-wire) EXPECT_WIRE="${2:-1}"; shift 2 ;;
    --*) echo "✗ 未知参数：$1（可用：--expect-wire N）" >&2; exit 2 ;;
    *) PATH_SPEC="$1"; shift ;;
  esac
done

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "✗ 不在 git 仓库里" >&2; exit 2; }
cd "$REPO" || exit 2
[ -f "$PATH_SPEC" ] || { echo "✗ 找不到 $PATH_SPEC" >&2; exit 2; }

TMP=$(mktemp -d) || exit 2
trap 'rm -rf "$TMP"' EXIT

# 删 / 加 的原始行（去掉前缀、去掉全部空白，便于「同一行」比较）
git diff -U0 -- "$PATH_SPEC" \
  | grep '^-' | grep -v '^---' | sed 's/^-//' > "$TMP/del.raw"
git diff -U0 -- "$PATH_SPEC" \
  | grep '^+' | grep -v '^+++' | sed 's/^+//' > "$TMP/add.raw"

if [ ! -s "$TMP/del.raw" ] && [ ! -s "$TMP/add.raw" ]; then
  echo "✗ $PATH_SPEC 没有改动（判据无从判定，不是通过）" >&2
  exit 2
fi

# 分类：逻辑行 → *.logic（逐行同序比对）；胶水 → 计数
# 先建空文件：0 删除时 side=del 一个逻辑行都不会产出，缺文件会让 diff 报错而不是「空 = 相等」
: > "$TMP/del.logic"; : > "$TMP/add.logic"; : > "$TMP/del.brace"; : > "$TMP/add.brace"
classify() {
  awk -v side="$2" '
    { line = $0; gsub(/[[:space:]]/, "", line) }
    line == "" { next }                                   # 空行：惰性
    line ~ /^\/\// || line ~ /^\/\*/ || line ~ /^\*/ || line ~ /^\*\// { com++; next }  # 注释：惰性
    line ~ /^functionwirePages[A-Za-z0-9_]*\(\)\{$/ { hdr++; next }                    # 新函数头
    line ~ /^wirePages[A-Za-z0-9_]*\(\);$/ { call++; next }                            # 调用行
    line == "}" { brace++; print >> ("'"$TMP"'/" side ".brace"); next }                # 闭合花括号另计
    { print >> ("'"$TMP"'/" side ".logic") }
    END { printf "%d %d %d\n", com, hdr, call > ("'"$TMP"'/" side ".counts") }
  ' "$1"
}
# 注意：上面的 awk 里 hdr/call 只在 side=add 时有意义；del 侧出现即视为逻辑行（会被 diff 抓到）
classify "$TMP/del.raw" del
classify "$TMP/add.raw" add

read -r DEL_COM DEL_HDR DEL_CALL < "$TMP/del.counts"
read -r ADD_COM ADD_HDR ADD_CALL < "$TMP/add.counts"
DEL_BRACE=$(wc -l < "$TMP/del.brace" 2>/dev/null | tr -d ' ' || echo 0)
ADD_BRACE=$(wc -l < "$TMP/add.brace" 2>/dev/null | tr -d ' ' || echo 0)
DEL_LOGIC=$(wc -l < "$TMP/del.logic" 2>/dev/null | tr -d ' ' || echo 0)
ADD_LOGIC=$(wc -l < "$TMP/add.logic" 2>/dev/null | tr -d ' ' || echo 0)
DEL_ALL=$(wc -l < "$TMP/del.raw" | tr -d ' ')
ADD_ALL=$(wc -l < "$TMP/add.raw" | tr -d ' ')

echo "move_only_check: $PATH_SPEC"
echo "  删 $DEL_ALL 行 / 加 $ADD_ALL 行"
echo "  逻辑行：删 $DEL_LOGIC → 加 $ADD_LOGIC"
echo "  胶水（加侧）：注释 $ADD_COM、函数头 $ADD_HDR、调用 $ADD_CALL、新增 } $((ADD_BRACE - DEL_BRACE))"

FAIL=0

# ① 逻辑行：多重集必须相等（删的每一行都在「加」里出现同样的次数，反之亦然）
#    为什么不是「同一序列」：一次改动可能有多处插入点（先抽的函数在文件前段、
#    后面批次的在别处），全局序列会把「A 批删的行」和「B 批加的行」错位比较。
#    顺序由构造保证：每个 wire 调用都插在原块第一行的位置，块内行按原序整段复制。
sort "$TMP/del.logic" > "$TMP/del.logic.sorted"
sort "$TMP/add.logic" > "$TMP/add.logic.sorted"
if ! diff -u "$TMP/del.logic.sorted" "$TMP/add.logic.sorted" > "$TMP/logic.diff" 2>&1; then
  echo "✗ 逻辑行多重集不等（下面是有差异的行；'< 只在删侧' / '> 只在加侧'）："
  grep -E '^[<>]' "$TMP/logic.diff" | head -40
  FAIL=1
fi

# ①b DOM 引用不变：全文件的 `el("x")` / `getElementById("x")` / `querySelector("#x")` 处数，
#     与 HEAD 版逐 id 相等。这是「行级移动」在 DOM 层面的镜像（Chief 2026-10-30）：
#     代码行可以搬到别处，但**碰的 id 与处数一个不许多、一个不许少**。
NODE_BIN=$(command -v node || echo /opt/homebrew/bin/node)
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -x "$NODE_BIN" ] || command -v node >/dev/null 2>&1; then
  git show "HEAD:$PATH_SPEC" > "$TMP/head.js" 2>/dev/null
  if [ -s "$TMP/head.js" ]; then
    "$NODE_BIN" "$HERE/wire_ids.mjs" --file-ids "$TMP/head.js" | sort > "$TMP/ids.head"
    "$NODE_BIN" "$HERE/wire_ids.mjs" --file-ids "$PATH_SPEC" | sort > "$TMP/ids.now"
    if ! diff -u "$TMP/ids.head" "$TMP/ids.now" > "$TMP/ids.diff" 2>&1; then
      echo "✗ DOM 引用变了（'− 只在 HEAD' / '+ 只在当前树'）："
      grep -E '^[+-]' "$TMP/ids.diff" | grep -v '^[+-][+-][+-]' | head -20
      FAIL=1
    fi
  fi
fi

# ② 胶水配对
if [ "$ADD_HDR" -ne "$ADD_CALL" ]; then
  echo "✗ 函数头 $ADD_HDR 个，调用行 $ADD_CALL 个——不配对（加了函数没接线，或反过来）"
  FAIL=1
fi
if [ "$((ADD_BRACE - DEL_BRACE))" -ne "$ADD_HDR" ]; then
  echo "✗ 新增闭合 } = $((ADD_BRACE - DEL_BRACE))，函数头 = $ADD_HDR——不配对"
  FAIL=1
fi
if [ "$ADD_HDR" -ne "$EXPECT_WIRE" ]; then
  echo "✗ 新函数 $ADD_HDR 个，名单要求 $EXPECT_WIRE 个"
  FAIL=1
fi
if [ "$DEL_HDR" -ne 0 ] || [ "$DEL_CALL" -ne 0 ]; then
  echo "✗ 删除侧出现了函数头/调用行形态（$DEL_HDR / $DEL_CALL）——搬的方向不对"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "✗ 不通过：这个改动不只是搬行"
  exit 1
fi
echo "✓ 只搬行：逻辑行 $DEL_LOGIC 行多重集相等（$ADD_LOGIC 行新增），胶水 $ADD_HDR 组配对，DOM id 处数与 HEAD 一致"
exit 0
