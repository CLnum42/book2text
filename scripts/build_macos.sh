#!/usr/bin/env bash
# 打 macOS arm64 的应用包（说明书 Phase 6）：双击启动、自动打开浏览器。
#
#     bash scripts/build_macos.sh
#
# 产物：dist/Book2Text.app（onedir 的 .app 包；未签名——首次打开要右键 →「打开」）
#
# 想连识别一起打进去（约 300 MB），先装 OCR 依赖：
#
#     uv sync --group ocr-eval
#
# 没装也能打包，只是打出来的应用里识别会如实报"引擎不可用"（说明书 1.6）。
set -euo pipefail

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

echo
echo "完成：$REPO_ROOT/dist/Book2Text.app"
echo "双击打开即可（首次会被系统拦下，请右键 →「打开」）；"
echo "也可以命令行验证：open dist/Book2Text.app"
