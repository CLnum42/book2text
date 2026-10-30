#!/bin/sh
# Book2Text 提交闸安装器（幂等）。装完会做**真拒绝自检**：
# 在一个一次性仓库里故意让套件红一次，确认 hook 真的拒绝提交；
# 否则"装成功"只等于"配置写了"——那是今晚反复出现的那种假绿。
#
# 用法：sh scripts/install-hooks.sh
# 卸：  git config --unset core.hooksPath

set -u

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "✗ 不在 git 仓库里" >&2
  exit 1
}
HOOKS="$REPO/scripts/git-hooks"

for f in "$HOOKS/pre-commit" "$HOOKS/post-commit" "$HOOKS/post-rewrite" "$HOOKS/pre-push"; do
  [ -f "$f" ] || { echo "✗ 缺 hook 脚本：$f" >&2; exit 1; }
  chmod +x "$f" 2>/dev/null || { echo "✗ 无法 chmod +x $f" >&2; exit 1; }
done

git config core.hooksPath scripts/git-hooks || {
  echo "✗ 写不进 core.hooksPath" >&2
  exit 1
}
CUR=$(git config --get core.hooksPath)
[ "$CUR" = "scripts/git-hooks" ] || { echo "✗ core.hooksPath=$CUR，期望 scripts/git-hooks" >&2; exit 1; }
echo "✓ core.hooksPath = $CUR"

# 记一个安装时间戳：pre-commit 用它只对"装机之后"的已推提交做 pytest 对账，
# 免得把本 hook 出现之前的历史提交全报成"没跑过 pytest"。
# worktree 里 `$REPO/.git` 是文件（2026-10-30 修）：记账起点与 pre-commit 同口径，放 git-common-dir
COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
[ -n "$COMMON" ] || COMMON="$REPO/.git"
[ -d "$COMMON" ] || { echo "✗ git-common-dir 不是目录（$COMMON）" >&2; exit 1; }
date +%s >"$COMMON/b2t-hooks-installed"
echo "✓ 记账起点 b2t-hooks-installed = $(cat "$COMMON/b2t-hooks-installed")"

# ---------------- 真拒绝自检（一次性仓库，不碰真仓库） ----------------
NODE=""
for c in "$(command -v node 2>/dev/null)" "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  echo "✗ 找不到 node，自检无法进行——装上了也是永不红的闸" >&2
  exit 1
fi

SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/b2t-hookcheck.XXXXXX") || exit 1
trap 'rm -rf "$SANDBOX"' EXIT INT TERM
cd "$SANDBOX" || exit 1
git init -q .
mkdir -p tests/js
git config core.hooksPath "$HOOKS"

GITC="git -c user.name=hookcheck -c user.email=hookcheck@local"

# 情形 1：套件红 → 必须拒绝提交
printf 'process.exit(1);\n' > tests/js/run.mjs
echo probe > a.txt
git add tests/js/run.mjs a.txt
if $GITC commit -q -m "should be rejected" >/dev/null 2>&1; then
  echo "✗ 自检失败：套件红着，提交却成功了——这个闸不会拒红" >&2
  exit 1
fi
echo "✓ 自检 1/4：套件红 → 拒绝提交"

# 情形 2：索引绿、工作区脏 → 必须通过（验的是索引，不是盘上）
printf 'process.exit(0);\n' > tests/js/run.mjs
git add tests/js/run.mjs
printf 'process.exit(1);\n' > tests/js/run.mjs      # 只改盘上，不 add
if ! $GITC commit -q -m "green index, dirty worktree" >/dev/null 2>&1; then
  echo "✗ 自检失败：索引是绿的，但工作区里未 add 的坏文件把提交挡住了" >&2
  echo "  说明闸还在验工作区——那正是 2026-10-29 那个洞" >&2
  exit 1
fi
echo "✓ 自检 2/4：索引绿 + 工作区脏 → 放行（验索引）"

# 情形 3：索引红（坏文件已 add）→ 必须拒绝
git add tests/js/run.mjs
echo probe2 > b.txt
git add b.txt
if $GITC commit -q -m "should be rejected 2" >/dev/null 2>&1; then
  echo "✗ 自检失败：坏文件已 add 进索引，提交却成功了" >&2
  exit 1
fi
echo "✓ 自检 3/4：索引红 → 拒绝提交"

# ---- 自检 4：pre-push 的 pytest 真的读"那棵树"吗（变异）----
# 2026-10-29：pytest 一开始读工作区（editable 安装让 STATIC_DIR 指向真实仓库），
# 别人的在制品能把你拦住、你的红树也能全绿。修法是 PYTHONPATH + 断言。
# 这条自检把"修好之后还咬不咬人"固化下来——**别靠人记得跑**。
if [ -x "$REPO/.venv/bin/python" ] && [ -f "$REPO/backend/book2text/static/app.js" ]; then
  # 归一化：macOS 的 /var → /private/var（同 §22 那条规矩，这里也栽了一次）
  T4=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/b2t-staticcheck.XXXXXX")" && pwd -P)
  if git -C "$REPO" archive HEAD 2>/dev/null | tar -x -C "$T4" 2>/dev/null; then
    SD_TREE=$( cd "$T4" && PYTHONPATH="$T4/backend" "$REPO/.venv/bin/python" \
      -c 'from book2text import paths; print(paths.STATIC_DIR)' 2>/dev/null || echo "?" )
    SD_RAW=$( cd "$T4" && "$REPO/.venv/bin/python" \
      -c 'from book2text import paths; print(paths.STATIC_DIR)' 2>/dev/null || echo "?" )
    case "$SD_TREE" in
      "$T4"*) echo "✓ 自检 4/4：带 PYTHONPATH → STATIC_DIR 指在这棵树里" ;;
      *) echo "✗ 自检 4/4 失败：带 PYTHONPATH 仍指向 $SD_TREE（应在这棵树 $T4 里）" >&2; rm -rf "$T4"; exit 1 ;;
    esac
    case "$SD_RAW" in
      "$T4"*) echo "✗ 自检 4/4 失败：不带 PYTHONPATH 也指向这棵树——检查已失效（它必须指向真实工作区才说明会咬人）" >&2; rm -rf "$T4"; exit 1 ;;
      *) echo "✓ 自检 4/4：不带 PYTHONPATH → STATIC_DIR 指到 $SD_RAW（真实工作区）→ 闸会红，检查有效" ;;
    esac
  fi
  rm -rf "$T4"
else
  echo "… 自检 4/4 跳过（缺 .venv 或 app.js）"
fi

echo ""
echo "✓ 闸已安装并自检通过：$(git -C "$REPO" config --get core.hooksPath)"
echo "  提交时会跑「索引版的」tests/js/run.mjs（约 6s），红则拒提交。"
echo "  真需要绕过：git commit --no-verify -m \"…\" -m \"Bypass-Reason: <为什么>\""
