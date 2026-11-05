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

for f in "$HOOKS/pre-commit" "$HOOKS/commit-msg" "$HOOKS/post-commit" "$HOOKS/post-rewrite" "$HOOKS/pre-push"; do
  [ -f "$f" ] || { echo "✗ 缺 hook 脚本：$f" >&2; exit 1; }
  chmod +x "$f" 2>/dev/null || { echo "✗ 无法 chmod +x $f" >&2; exit 1; }
done

# ---- hooksPath 一律写**绝对路径**（2026-11-05）----
# 相对路径按"运行钩子的那棵树"解析：每个 worktree 用自己那份 scripts/git-hooks。实测
# builder / devlead 两个 worktree 的副本里没有 commit-msg（更早的 checkout）⇒ 钩子静默不跑，
# 新闸等于没装。绝对路径指向**主工作树**那一份（git-common-dir 的父目录；config 本来就
# worktree 共享），于是四个树永远用同一份、不会各自落后。代价：仓库整体搬家后重跑一次本脚本。
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
[ -n "$COMMON_DIR" ] || COMMON_DIR="$REPO/.git"
MAIN_ROOT=$(dirname "$COMMON_DIR")
HOOKS_ABS=$(cd "$MAIN_ROOT/scripts/git-hooks" 2>/dev/null && pwd -P) || {
  echo "✗ 主工作树里找不到 scripts/git-hooks（$MAIN_ROOT/scripts/git-hooks）" >&2
  exit 1
}
git config core.hooksPath "$HOOKS_ABS" || {
  echo "✗ 写不进 core.hooksPath" >&2
  exit 1
}
CUR=$(git config --get core.hooksPath)
[ "$CUR" = "$HOOKS_ABS" ] || { echo "✗ core.hooksPath=$CUR，期望 $HOOKS_ABS" >&2; exit 1; }
echo "✓ core.hooksPath = $CUR（绝对路径 → 全部 worktree 共用主树这一份）"

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
WT6ROOT=""
# 清理写在退出路径上：沙箱 + 自检 6 的临时 worktree（任何退出路径都要拆掉）
cleanup_all() {
  if [ -n "${WT6ROOT:-}" ] && [ -d "$WT6ROOT/tree" ]; then
    git -C "$REPO" worktree remove --force "$WT6ROOT/tree" >/dev/null 2>&1 || true
    git -C "$REPO" worktree prune >/dev/null 2>&1 || true
    rm -rf "$WT6ROOT"
  fi
  rm -rf "$SANDBOX"
}
trap cleanup_all EXIT INT TERM
cd "$SANDBOX" || exit 1
git init -q .
mkdir -p tests/js
git config core.hooksPath "$HOOKS_ABS"

GITC="git -c user.name=hookcheck -c user.email=hookcheck@local"

# 情形 1：套件红 → 必须拒绝提交
printf 'process.exit(1);\n' > tests/js/run.mjs
echo probe > a.txt
git add tests/js/run.mjs a.txt
if $GITC commit -q -m "should be rejected" >/dev/null 2>&1; then
  echo "✗ 自检失败：套件红着，提交却成功了——这个闸不会拒红" >&2
  exit 1
fi
echo "✓ 自检 1/6：套件红 → 拒绝提交"

# 情形 2：索引绿、工作区脏 → 必须通过（验的是索引，不是盘上）
printf 'process.exit(0);\n' > tests/js/run.mjs
git add tests/js/run.mjs
printf 'process.exit(1);\n' > tests/js/run.mjs      # 只改盘上，不 add
if ! $GITC commit -q -m "green index, dirty worktree" >/dev/null 2>&1; then
  echo "✗ 自检失败：索引是绿的，但工作区里未 add 的坏文件把提交挡住了" >&2
  echo "  说明闸还在验工作区——那正是 2026-10-29 那个洞" >&2
  exit 1
fi
echo "✓ 自检 2/6：索引绿 + 工作区脏 → 放行（验索引）"

# 情形 3：索引红（坏文件已 add）→ 必须拒绝
git add tests/js/run.mjs
echo probe2 > b.txt
git add b.txt
if $GITC commit -q -m "should be rejected 2" >/dev/null 2>&1; then
  echo "✗ 自检失败：坏文件已 add 进索引，提交却成功了" >&2
  exit 1
fi
echo "✓ 自检 3/6：索引红 → 拒绝提交"

# ---- 自检 5：commit-msg 真的拦"删 UI 入口不登记"吗（2026-11-05 新增的闸）----
# 这条闸只在 commit-msg 里有意义（pre-commit 拿不到正文），所以自检必须真走一次提交流程：
#   ① 新增 UI 入口 → 放行（没删东西）；
#   ② 删掉入口、正文没登记 → 必须拒绝，且报错要**点名那个 id**（只断言"退出码非 0"不够）；
#   ③ 同一笔改成登记了 Removed-UI → 必须放行。
printf 'process.exit(0);\n' > tests/js/run.mjs
git add tests/js/run.mjs
mkdir -p backend/book2text/static
printf '<div id="probe-id">x</div>\n' > backend/book2text/static/index.html
git add backend/book2text/static/index.html
if ! $GITC commit -q -m "加一个 UI 入口（不删东西）" >/dev/null 2>&1; then
  echo "✗ 自检 5 失败：没有删除 UI 入口，commit-msg 却拦了提交" >&2
  exit 1
fi
printf '\n' > backend/book2text/static/index.html
git add backend/book2text/static/index.html
if UIOUT=$($GITC commit -q -m "删一个 UI 入口（没登记）" 2>&1); then
  echo "✗ 自检 5 失败：删了 UI 入口且正文没写 Removed-UI，提交却成功了" >&2
  exit 1
fi
case "$UIOUT" in
  *probe-id*) : ;;
  *) echo "✗ 自检 5 失败：拒绝了，但报错没点名 id probe-id：$UIOUT" >&2; exit 1 ;;
esac
if ! $GITC commit -q -m "删一个 UI 入口" -m "Removed-UI: probe-id" >/dev/null 2>&1; then
  echo "✗ 自检 5 失败：正文登记了 Removed-UI，commit-msg 仍把提交挡了" >&2
  exit 1
fi
echo "✓ 自检 5/6：删 UI 入口未登记 → 拒绝并点名 id；登记后 → 放行"

# ---- 自检 6：别的 worktree 也要用得上同一份钩子（绝对路径 hooksPath）----
# 实测背景（2026-11-05 10:05）：builder / devlead 两个 worktree 的 scripts/git-hooks 里**没有**
# commit-msg（它们是更早的 checkout），而 core.hooksPath 写的是相对路径 ⇒ 按"运行钩子的那棵树"
# 解析 ⇒ 那两棵树上 `git hook run commit-msg` 直接 "cannot find a hook named commit-msg"，
# 新闸静默不跑。修法：hooksPath 写绝对路径，指向主工作树那一份。
#
# 这条自检必须能红：先造一个**缺 scripts/git-hooks 副本**的临时 worktree（复现那两棵树的形态），
# 在里面删一个 UI id 不登记 ⇒ 必须被拒且点名 id；补 Removed-UI 后 ⇒ 必须放行。
WT6ROOT=$(mktemp -d "${TMPDIR:-/tmp}/b2t-hookwt.XXXXXX") || { echo "✗ 自检 6：建不了临时目录" >&2; exit 1; }
if ! git -C "$REPO" worktree add -q --detach "$WT6ROOT/tree" HEAD >"$WT6ROOT/add.log" 2>&1; then
  echo "✗ 自检 6：建不了临时 worktree（这不是闸的问题，是工作区状态不对）" >&2
  tail -5 "$WT6ROOT/add.log" >&2
  exit 1
fi
rm -rf "$WT6ROOT/tree/scripts/git-hooks"      # ← 复现"这棵树里没有那份副本"
TARGET_ID=$( cd "$WT6ROOT/tree" && "$NODE" -e '
const fs = require("fs");
const path = require("path");
const dir = "backend/book2text/static";
const files = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile());
const all = files.map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
const htmlPath = path.join(dir, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).filter((id) => all.split(id).length - 1 === 1);
if (ids.length === 0) { console.error("没有只出现一次的 id"); process.exit(3); }
const id = ids[0];
const lines = html.split("\n");
const at = lines.findIndex((line) => line.includes(`id="${id}"`));
lines.splice(at, 1);
fs.writeFileSync(htmlPath, lines.join("\n"));
console.log(id);
' ) || { echo "✗ 自检 6：挑不到探针 id" >&2; exit 1; }
cd "$WT6ROOT/tree" || exit 1
git add backend/book2text/static/index.html
if git commit -q -m "自检6：删 UI 入口不登记" >"$WT6ROOT/out1.log" 2>&1; then
  echo "✗ 自检 6 失败：在临时 worktree 里删了 UI 入口（#${TARGET_ID}）且没登记，提交却成功了" >&2
  echo "  说明这棵树没有用上 commit-msg 钩子——hooksPath 还是相对路径？" >&2
  tail -5 "$WT6ROOT/out1.log" >&2
  exit 1
fi
if ! grep -q "$TARGET_ID" "$WT6ROOT/out1.log"; then
  echo "✗ 自检 6 失败：提交被拒了，但报错没点名 id ${TARGET_ID}" >&2
  tail -5 "$WT6ROOT/out1.log" >&2
  exit 1
fi
if ! git commit -q -m "自检6：删 UI 入口" -m "Removed-UI: $TARGET_ID" >"$WT6ROOT/out2.log" 2>&1; then
  echo "✗ 自检 6 失败：正文登记了 Removed-UI: ${TARGET_ID}，提交仍被挡" >&2
  tail -5 "$WT6ROOT/out2.log" >&2
  exit 1
fi
cd "$REPO" || exit 1
echo "✓ 自检 6/6：临时 worktree（缺 scripts/git-hooks 副本）→ 未登记被拒并点名 ${TARGET_ID}；登记后放行"

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
      "$T4"*) echo "✓ 自检 4/6：带 PYTHONPATH → STATIC_DIR 指在这棵树里" ;;
      *) echo "✗ 自检 4/6 失败：带 PYTHONPATH 仍指向 $SD_TREE（应在这棵树 $T4 里）" >&2; rm -rf "$T4"; exit 1 ;;
    esac
    case "$SD_RAW" in
      "$T4"*) echo "✗ 自检 4/6 失败：不带 PYTHONPATH 也指向这棵树——检查已失效（它必须指向真实工作区才说明会咬人）" >&2; rm -rf "$T4"; exit 1 ;;
      *) echo "✓ 自检 4/6：不带 PYTHONPATH → STATIC_DIR 指到 $SD_RAW（真实工作区）→ 闸会红，检查有效" ;;
    esac
  fi
  rm -rf "$T4"
else
  echo "… 自检 4/6 跳过（缺 .venv 或 app.js）"
fi

echo ""
echo "✓ 闸已安装并自检通过：$(git -C "$REPO" config --get core.hooksPath)"
echo "  提交时会跑「索引版的」tests/js/run.mjs（约 6s），红则拒提交。"
echo "  真需要绕过：git commit --no-verify -m \"…\" -m \"Bypass-Reason: <为什么>\""
