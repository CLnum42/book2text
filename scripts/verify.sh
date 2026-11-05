#!/bin/sh
# Book2Text 离线校验：把 pre-push 里的重活搬到这里，跑完**落一行 PASS 记录**。
#
# 为什么（规则 #34，2026-11-05 三次真事故）：pre-push 里跑 node + pytest 要 2–3 分钟，
# 而 git 在这两分钟里**一直握着远端连接**；GitHub 对端会先把空闲连接掐掉，于是
#   pre-push 全绿 → 推送阶段 `Connection to github.com closed by remote host` → 只能 `--no-verify`。
# 闸从"强制执行"退化成"自觉执行"。修法：重活离线跑、写记录；钩子只查记录（<1s）。
#
# 用法：
#   sh scripts/verify.sh            # 验 HEAD
#   sh scripts/verify.sh <sha>      # 验指定提交（推送前先验要推的那个 sha）
#
# 记录（追加到 git-common-dir/b2t-verify.log，各 worktree 共用一本账）：
#   VERIFY <sha> <tree> <time> PASS node=<tests>/<pass> pytest=<passed> STATIC_DIR=<路径>
#   键是 **sha**（内容寻址：任何 commit / rebase 都会变，记录自动失效——规则 #9 同一招）。
#
# 验的是**那棵树**，不是工作区（共享工作区随时是别人的半成品）：
#   · node 闸在 `git worktree add --detach <sha>` 的树里跑（contract-registry 要看 git 历史）；
#   · pytest 在 `git archive <sha>` 导出的树里跑，PYTHONPATH 指到这棵树，并**断言 STATIC_DIR 在树内**
#     （editable 安装会把 STATIC_DIR 指回主树——AGENTS.md 那条自检，漏了就是"验了别的版本"）。
#
# fail closed：缺 node / 缺 .venv / 导出失败 / STATIC_DIR 不在树内 ⇒ 退出非 0，**不写记录**。

set -u

usage() {
  echo "用法：sh scripts/verify.sh [sha]（默认 HEAD）" >&2
}

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "✗ verify：拿不到仓库根目录" >&2
  exit 2
}
cd "$REPO" || exit 2

TARGET=${1:-HEAD}
SHA=$(git rev-parse --verify "$TARGET^{commit}" 2>/dev/null) || {
  echo "✗ verify：解析不了 $TARGET 这个提交" >&2
  exit 2
}
SHORT=$(printf '%s' "$SHA" | cut -c1-8)
TREE_OID=$(git rev-parse "$SHA^{tree}")
COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || COMMON="$REPO/.git"
MAIN_ROOT=$(dirname "$COMMON")
LOG="$COMMON/b2t-verify.log"

# ---- 找 node（与钩子同一张路径表；hook 的 PATH 通常不含 ~/.local/bin）----
NODE=""
for c in "$(command -v node 2>/dev/null)" "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  echo "✗ verify：找不到 node（查过 PATH / \$HOME/.local/bin / /opt/homebrew/bin / /usr/local/bin / /usr/bin）" >&2
  exit 2
fi

PY=""
for c in "$REPO/.venv/bin/python" "$MAIN_ROOT/.venv/bin/python"; do
  if [ -x "$c" ]; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "✗ verify：找不到 .venv/bin/python（当前树与主树都找过）" >&2
  exit 2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/b2t-verify.XXXXXX") || {
  echo "✗ verify：建不了临时目录" >&2
  exit 2
}
# 任何退出路径都拆干净（2026-10-29 教训：清理只写在成功路径会留残影）
cleanup() {
  git worktree remove --force "$WORK/tree" >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

echo "… verify：验的是 $SHORT 这棵树（不是工作区），node 闸 + pytest" >&2

# ---- ① node 闸（worktree：registry 要读 git 历史）----
if ! git worktree add -q --detach "$WORK/tree" "$SHA" 2>"$WORK/add.log"; then
  echo "✗ verify：导出 $SHORT 的 worktree 失败" >&2
  tail -n 5 "$WORK/add.log" >&2
  exit 2
fi
NSTART=$(date +%s)
( cd "$WORK/tree" && env -u B2T_APP_JS -u B2T_VIEW_JS -u B2T_STATIC_DIR \
    "$NODE" tests/js/run.mjs ) >"$WORK/node.log" 2>&1
NODE_RC=$?
NODE_TESTS=$(grep -E '^ℹ tests ' "$WORK/node.log" | tail -n 1 | awk '{print $3}')
NODE_PASS=$(grep -E '^ℹ pass ' "$WORK/node.log" | tail -n 1 | awk '{print $3}')
if [ "$NODE_RC" -ne 0 ] || [ -z "$NODE_TESTS" ] || [ -z "$NODE_PASS" ]; then
  echo "✗ verify：node 闸红了（$(( $(date +%s) - NSTART ))s，退出码 $NODE_RC）——未写记录" >&2
  echo "  验的是 $SHORT 这棵树，不是工作区。" >&2
  tail -n 30 "$WORK/node.log" >&2
  exit 1
fi
( cd "$WORK/tree" && "$NODE" tests/js/contract-registry.mjs --strict --allow-transitional-base ) >"$WORK/registry.log" 2>&1
REG_RC=$?
if [ "$REG_RC" -ne 0 ]; then
  echo "✗ verify：contract-registry --strict 红了（退出码 $REG_RC）——未写记录" >&2
  tail -n 20 "$WORK/registry.log" >&2
  exit 1
fi
echo "✓ verify：node 闸全绿（$NODE_TESTS tests / $NODE_PASS pass，$(( $(date +%s) - NSTART ))s）" >&2

# ---- ② pytest（导出的树 + PYTHONPATH + STATIC_DIR 断言）----
# mkdir 之后立刻 pwd -P：macOS 的 /var → /private/var，不归一化会让下面的"在树内"永远不匹配
TREE=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/b2t-verify-tree.XXXXXX")" && pwd -P) || {
  echo "✗ verify：建不了导出目录" >&2
  exit 2
}
if ! git archive "$SHA" | tar -x -C "$TREE"; then
  echo "✗ verify：导出 $SHORT 的树失败" >&2
  rm -rf "$TREE"
  exit 2
fi
STATIC_DIR=$( cd "$TREE" && PYTHONPATH="$TREE/backend" \
    "$PY" -c 'from book2text import paths; print(paths.STATIC_DIR)' 2>/dev/null || echo "?" )
case "$STATIC_DIR" in
  "$TREE"*) : ;;
  *)
    echo "✗ verify：STATIC_DIR 指向 $STATIC_DIR，不是 $SHORT 这棵树（$TREE）" >&2
    echo "  这不是测试红，是验错了树——未写记录。" >&2
    rm -rf "$TREE"
    exit 2
    ;;
esac
PSTART=$(date +%s)
( cd "$TREE" && PYTHONPATH="$TREE/backend" "$PY" -m pytest -q ) >"$WORK/pytest.log" 2>&1
PY_RC=$?
PY_PASSED=$(grep -oE '[0-9]+ passed' "$WORK/pytest.log" | tail -n 1 | awk '{print $1}')
rm -rf "$TREE"
if [ "$PY_RC" -ne 0 ]; then
  echo "✗ verify：pytest 红了（$(( $(date +%s) - PSTART ))s）——未写记录" >&2
  tail -n 30 "$WORK/pytest.log" >&2
  exit 1
fi
if [ -z "$PY_PASSED" ]; then
  # 退出码 0 但没有 "N passed" = 一个用例都没收集到，不是绿
  echo "✗ verify：pytest 退出码 0 但没有任何 'N passed' ⇒ 视为没跑到——未写记录" >&2
  tail -n 20 "$WORK/pytest.log" >&2
  exit 1
fi
echo "✓ verify：pytest 全绿（$PY_PASSED passed，$(( $(date +%s) - PSTART ))s）" >&2

# ---- ③ 落记录（只有全绿才写）----
printf 'VERIFY %s %s %s PASS node=%s/%s pytest=%s STATIC_DIR=%s\n' \
  "$SHA" "$TREE_OID" "$(date '+%FT%T')" "$NODE_TESTS" "$NODE_PASS" "$PY_PASSED" "$STATIC_DIR" >>"$LOG" || {
  echo "✗ verify：写不了记录 $LOG" >&2
  exit 2
}

echo ""
echo "✓ verify：$SHORT 全绿，记录已写"
echo "  记录：$(tail -n 1 "$LOG")"
echo "  下一步：git push（pre-push 只查这条记录，<1s）"
