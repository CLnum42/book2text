#!/bin/sh
# pages 刀 1 一键重落：rollback → --write → script 标签 → 双向烟测 → 闸 → accept
# 不提交、不推送。等 Chief 发话再跑；红了 set -e 直接停。
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
MOVERS=docs/refactor/evidence/pages/stage1-movers.json
RULES=docs/refactor/evidence/pages/rules.py
NODE_BIN=${NODE_BIN:-/opt/homebrew/bin}

echo "① rollback app.js / 删旧产物 / index.html 复原"
git show HEAD:backend/book2text/static/app.js > backend/book2text/static/app.js
rm -f backend/book2text/static/page-pages.js backend/book2text/static/pages-view.js   # 旧名 page-pages.js 是改名前的产物，防御性一并删（改名见 docs/refactor/pages-plan.md）
git show HEAD:backend/book2text/static/index.html > backend/book2text/static/index.html

echo "② --write"
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

echo "④ 双向烟测"
"$NODE_BIN/node" scripts/pages_smoke.mjs

echo "⑤ node 闸"
PATH="$NODE_BIN:$PATH" node tests/js/run.mjs

echo "⑥ pytest"
.venv/bin/python -m pytest -q

echo "⑦ accept_pages"
python3 scripts/accept_pages.py --stage 1 --movers "$MOVERS"
