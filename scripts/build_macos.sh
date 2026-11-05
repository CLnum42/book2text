#!/usr/bin/env bash
# 打 macOS arm64 的应用包（说明书 Phase 6）：双击启动、自动打开浏览器。
#
#     bash scripts/build_macos.sh                 # 默认：连 Jev 引擎与模型一起打（约 3.0 GB）
#     bash scripts/build_macos.sh --no-jev-models # 轻包（约 315 MB）：只带引擎，不带 2.68 GB 模型
#
# 产物：dist/Book2Text.app（onedir 的 .app 包；**ad-hoc 签名**——首次打开要右键 →「打开」）
#
# Jev 那两个东西是这一笔的重点（2026-11-05，第 5 笔）：
#
#   · 引擎：brew 的 llama.cpp 0.8.0（10 个 Mach-O，约 24 MB），由 `scripts/bundle_jev_engine.py`
#     改成 `@loader_path` 引用并逐个 ad-hoc 重签——不重签的话 Gatekeeper 报的是"签名无效"，
#     比"未签名"更难解释。
#   · 模型：`~/Library/Application Support/Book2Text/jev`（2.68 GB），默认整目录复制进包。
#     这是**一次性成本**：用户本机用，不做分发；换机器就把这 2.68 GB 一起搬过去。
#
# 想连识别一起打进去（约 300 MB），先装 OCR 依赖：
#
#     uv sync --group ocr-eval
#
# 没装也能打包，只是打出来的应用里识别会如实报"引擎不可用"（说明书 1.6）。
set -euo pipefail

BUNDLE_MODELS=1
for arg in "$@"; do
  case "$arg" in
    --no-jev-models) BUNDLE_MODELS=0 ;;
    -h|--help) sed -n '1,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（可用：--no-jev-models）" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
echo "仓库：$REPO_ROOT"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "这个脚本只用于 macOS（详情见 docs/manual-owner.md）" >&2
  exit 1
fi

rm -rf build dist

# --with pyinstaller：不把打包工具写进项目依赖（说明书 12.2 的"不预建空模块"同理）
uv run --with pyinstaller pyinstaller \
  --noconfirm \
  --clean \
  --distpath dist \
  --workpath build \
  packaging/book2text.spec

# ---------------------------------------------------------------- Jev：引擎与模型
APP="$REPO_ROOT/dist/Book2Text.app"
RESOURCES="$APP/Contents/Resources"

echo
echo "== 收入 Jev 引擎（@loader_path + 逐个 ad-hoc 重签）=="
python3 "$REPO_ROOT/scripts/bundle_jev_engine.py" --out "$RESOURCES/jev-engine"

JEV_MODEL_SRC="${B2T_JEV_MODEL_DIR:-$HOME/Library/Application Support/Book2Text/jev}"
if [ "$BUNDLE_MODELS" -eq 1 ]; then
  if [ -f "$JEV_MODEL_SRC/manifest.json" ]; then
    echo "== 收入 Jev 模型：$JEV_MODEL_SRC（2.68 GB）=="
    mkdir -p "$RESOURCES/jev"
    rsync -a "$JEV_MODEL_SRC"/ "$RESOURCES/jev"/
  else
    echo "✗ 要带模型但找不到 $JEV_MODEL_SRC/manifest.json" >&2
    echo "  先按 docs/jev.md 把模型放进私域目录，或改用 --no-jev-models" >&2
    exit 3
  fi
else
  echo "== --no-jev-models：不带 2.68 GB 模型（/ready 会如实说模型缺失）=="
fi

echo
echo "== 整包 ad-hoc 重签（嵌套 Mach-O 已各自签过，这里补 bundle 的封条）=="
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo
echo "完成：$APP"
du -sh "$APP"
echo "双击打开即可（首次会被系统拦下，请右键 →「打开」）；"
echo "也可以命令行验证：open dist/Book2Text.app"
