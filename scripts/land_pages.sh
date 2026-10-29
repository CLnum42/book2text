#!/bin/sh
# scripts/land_pages.sh —— `pages` 落盘的一键门（**不提交**：提交要人决定，这里只做门）。
#
# 为什么要有它：落盘是「生成 → 语法 → 自检 → 写入 → 闸 → 验收」六步，
# 手工做时最容易漏掉中间两步——今天已经出现过「写完没跑闸就以为好了」。
#
# 用法：
#   sh scripts/land_pages.sh                 # 全跑（会在最后一步 diff 出头文件，等你提交）
#   sh scripts/land_pages.sh --no-accept     # 跳过 accept_pages（模块刚落地、还没跑实机时用）
#
# 每一步失败都**停住并说明卡在哪条、怎么修**，绝不"继续跑完再说"。
set -u

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO" || exit 1
APP=backend/book2text/static/app.js
MODULE=backend/book2text/static/page-pages.js
MOVERS=docs/refactor/evidence/pages/movers.json
RULES=docs/refactor/evidence/pages/rules.py
GEN=docs/refactor/evidence/build_view.py
NODE=${NODE:-node}
PY=${PY:-python3}
SKIP_ACCEPT=0
[ "${1:-}" = "--no-accept" ] && SKIP_ACCEPT=1

step() { printf '\n— %s\n' "$1"; }
die()  { printf '\n✗ 卡在：%s\n  怎么修：%s\n' "$1" "$2" >&2; exit 1; }

command -v "$NODE" >/dev/null 2>&1 || die "找不到 node" "装 node 或 NODE=/path/to/node sh scripts/land_pages.sh"

# 0) 工作区只许有本刀的改动，别把别人的在制品卷进落盘
step "0) 落盘前状态"
dirty=$(git status --porcelain | grep -v "^ M $APP$" | grep -v "^ M backend/book2text/static/index.html$" | grep -v "^?? $MODULE$" || true)
if [ -n "$dirty" ]; then
  printf '%s\n' "$dirty" >&2
  die "工作区里有别人的改动" "先让它们提交或 stash（git stash push -- <路径>）；落盘必须在一棵干净树上做"
fi

# 1) 生成（干跑）：残余接缝 0 ∧ 三条反证 0 才允许继续
step "1) 干跑：残余接缝与反证"
LIST=$(mktemp); trap 'rm -f "$LIST"' EXIT
"$PY" - "$MOVERS" "$LIST" <<'PYEOF'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
open(sys.argv[2], "w").write("\n".join(x["name"] for x in data["movers"]) + "\n")
PYEOF
OUT=$("$PY" "$GEN" --movers "$LIST" --rules "$RULES" --name Pages --app "$APP" --out /tmp/b2t-land-dry 2>&1) || true
echo "$OUT" | tail -12
printf '%s' "$OUT" | grep -q '"residue": \[\]' || die "残余接缝不为 0（上面 residue 里有名字）" \
  "把缺的名字补进 rules.py 的 IDENT_FULL / MOVED_STATES，再重跑；**不许 --write**"
printf '%s' "$OUT" | grep -q '"anti": \[\]' || die "三条反证有红" \
  "按反证的话改：搬走的状态声明没删 / 注入的名字还裸引用 / 写点没走 setter"

# 2) 真写（生成器内部还会再跑一次 node --check，过了才 os.replace）
step "2) --write"
"$PY" "$GEN" --movers "$LIST" --rules "$RULES" --name Pages --app "$APP" --out /tmp/b2t-land --write >/tmp/b2t-land.out 2>&1 \
  || die "--write 失败（原文见 /tmp/b2t-land.out）" "先看 /tmp/b2t-land.out 最后 20 行"
tail -3 /tmp/b2t-land.out

# 3) 两文件语法 + index.html 的 script 标签（R7b 会拦漏）
step "3) 语法与加载"
"$NODE" --check "$APP" || die "app.js 语法错" "回滚：sh scripts/rollback_pages.sh，然后把报错原文贴出来"
"$NODE" --check "$MODULE" || die "page-pages.js 语法错" "回滚：sh scripts/rollback_pages.sh"
grep -q 'src="/static/page-pages.js"' backend/book2text/static/index.html \
  || die "index.html 没有 page-pages.js 的 <script>" \
         "在 merge-view.js 后、app.js 前加 <script src=\"/static/page-pages.js\"></script>（R7b 会拦）"

# 4) node 闸
step "4) node 闸（必须 0 fail）"
if ! "$NODE" tests/js/run.mjs >/tmp/b2t-land-node.out 2>&1; then
  # **闸红 = 自动回滚**：宁可回到绿，也不留半落盘状态（今天两次教训）
  sh scripts/rollback_pages.sh >/dev/null 2>&1 || true
  tail -6 /tmp/b2t-land-node.out >&2
  die "node 闸红了（已自动回滚，原文 /tmp/b2t-land-node.out）" \
      "行为用例红 → 夹具没载模块；R5/R8 红 → 三张登记表没同批"
fi
grep -E "ℹ (pass|fail)" /tmp/b2t-land-node.out | tail -2

# 5) 验收器
if [ "$SKIP_ACCEPT" = 0 ]; then
  step "5) accept_pages（判据来自名单，不写死数）"
  "$PY" scripts/accept_pages.py "$@" >/tmp/b2t-land-accept.out 2>&1
  rc=$?
  tail -12 /tmp/b2t-land-accept.out
  case "$rc" in
    0) echo "✓ 验收全过" ;;
    2) die "验收器 exit 2（前置不满足：多半是第三消费者没给 --acid）" \
            "实机跑 acid：python3 scripts/accept_pages.py --acid /tmp/acid.json；没有这两个数就是未验" ;;
    64) die "调用方式错（不是验收失败）" "只收 --acid / --expect-sha —— 修参数透传，别查产品" ;;
    *) die "验收器 exit 1（判据不过，原文见 /tmp/b2t-land-accept.out）" "按点名的条目改；改不动就回滚" ;;
  esac
fi

step "6) 下一步（脚本不替你提交）"
cat <<'EOF'
  1) git diff --stat               # 只该有 app.js / page-pages.js / index.html / 三张登记表
  2) 三张表同批：OWNERS（搬进模块的 10 个状态改 owner）/ VIEW_EXPORTS（page-pages.js 的 init,enter）/
     VIEW_STATE_PREFIXES（page-pages.js 一行）
  3) 提交：scripts/commit.sh -F <msg> -- <路径…>；首行 `move(pages):`
  4) **Approved-by 找 Architect**（这一笔是我自己做的，我不签自己）
  5) 实机 acid 由 Builder 跑；没给数就是「未验」，报告里不许写「已达标」
EOF
