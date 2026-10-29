#!/bin/sh
# pages 落盘一键门（按刀参数；不提交、不推送）。
#
# 用法：
#   sh scripts/land_pages_stage1.sh 1
#   sh scripts/land_pages_stage1.sh 2 --acid /tmp/acid-stage2.json
#
# 名单按 stage 取 docs/refactor/evidence/pages/stage${N}-movers.json；
# stage 2 起 accept 必须带 --acid（真通过的那份），缺文件直接停。
set -eu
cd "$(dirname "$0")/.."

STAGE=${1:-1}
[ -n "$STAGE" ] || { echo "✗ 缺 stage"; exit 2; }
shift || true
ACID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --acid) [ $# -ge 2 ] || { echo "✗ --acid 缺文件"; exit 2; }; ACID=$2; shift 2 ;;
    *) echo "✗ 未知参数：$1"; exit 2 ;;
  esac
done

MOVERS=docs/refactor/evidence/pages/stage${STAGE}-movers.json
RULES=docs/refactor/evidence/pages/rules.py
NODE_BIN=${NODE_BIN:-/opt/homebrew/bin}
[ -f "$MOVERS" ] || { echo "✗ 名单不存在：$MOVERS"; exit 2; }
if [ "$STAGE" -ge 2 ] && { [ -z "$ACID" ] || [ ! -f "$ACID" ]; }; then
  echo "✗ stage $STAGE 起 accept 必须带 --acid <真通过的 JSON>（现在：${ACID:-未给}）"
  exit 2
fi

echo "① rollback 到 HEAD（app.js / index.html / 模块）"
git show HEAD:backend/book2text/static/app.js > backend/book2text/static/app.js
git show HEAD:backend/book2text/static/index.html > backend/book2text/static/index.html
rm -f backend/book2text/static/pages-view.js backend/book2text/static/page-pages.js

echo "② --write（stage $STAGE 名单）"
PATH="$NODE_BIN:$PATH" python3 docs/refactor/evidence/build_view.py \
  --movers "$MOVERS" --rules "$RULES" --name Pages --write

echo "③ index.html 加 pages-view.js（app.js 之前）"
python3 - <<'PY'
from pathlib import Path
p = Path("backend/book2text/static/index.html")
s = p.read_text(encoding="utf-8")
line = '  <script src="/static/pages-view.js"></script>\n'
if line not in s:
    anchor = '  <script src="/static/merge-view.js"></script>\n'
    assert s.count(anchor) == 1, "找不到 merge-view.js 的 script 锚点"
    s = s.replace(anchor, anchor + line, 1)
    p.write_text(s, encoding="utf-8")
print("script ok")
PY

echo "④ 双向烟测（含 VIEW_EXPORTS 逐名核对）"
"$NODE_BIN/node" scripts/pages_smoke.mjs

echo "⑤ node 闸"
PATH="$NODE_BIN:$PATH" node tests/js/run.mjs

echo "⑥ pytest"
.venv/bin/python -m pytest -q

echo "⑦ accept_pages --stage $STAGE"
SHA=$(shasum -a 256 "$MOVERS" | cut -d' ' -f1)
if [ "$STAGE" -ge 2 ]; then
  python3 scripts/accept_pages.py --stage "$STAGE" --movers "$MOVERS" --expect-sha "$SHA" --acid "$ACID"
else
  python3 scripts/accept_pages.py --stage "$STAGE" --movers "$MOVERS" --expect-sha "$SHA"
fi
