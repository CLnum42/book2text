#!/bin/sh
# Book2Text 启动脚本（macOS）
#
# 双击运行，或在终端执行：./scripts/start.command
# 说明书第 10 节：两个平台的启动脚本只调用同一个 Python 入口。

cd "$(dirname "$0")/.." || exit 1

if ! command -v uv >/dev/null 2>&1; then
  echo "未找到 uv —— Book2Text 用它管理 Python 环境与依赖。"
  echo "安装方式：curl -LsSf https://astral.sh/uv/install.sh | sh"
  echo
  echo "按回车键关闭窗口…"
  read -r _ || true
  exit 1
fi

# 交给 Python 入口负责选端口、生成令牌、打开浏览器。
exec uv run book2text "$@"
