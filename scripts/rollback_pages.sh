#!/bin/sh
# scripts/rollback_pages.sh —— 把 `pages` 落盘退回上一个可推状态（30 秒）。
# 判据只有一条：node tests/js/run.mjs 回到 fail 0。回不去就说明还有文件没复原。
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO" || exit 1
git checkout -- backend/book2text/static/app.js backend/book2text/static/index.html 2>/dev/null
rm -f backend/book2text/static/page-pages.js
echo "— 已复原 app.js / index.html，删除 page-pages.js"
NODE=${NODE:-node}
"$NODE" tests/js/run.mjs 2>&1 | grep -E "ℹ (pass|fail)"
printf '\n回滚后必须通知（见 docs/refactor/evidence/pages/LANDING.md §三）：\n'
printf '  Builder   停 acid 实机测量（page-pages.js 已不存在）\n'
printf '  TestDev   夹具/闸先别按落盘后的形态调\n'
printf '  Chief     一句话 + 上面两行 pass/fail 数（发开发协调群）\n'
