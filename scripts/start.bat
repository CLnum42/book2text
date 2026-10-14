@echo off
REM Book2Text 启动脚本（Windows）
REM
REM 双击运行，或在命令行执行：scripts\start.bat
REM 说明书第 10 节：两个平台的启动脚本只调用同一个 Python 入口。
REM
REM 注意：本文件未在 Windows 上运行验证过。

REM 让控制台按 UTF-8 显示，否则此脚本与 Python 输出的中文会是乱码。
chcp 65001 >nul

setlocal
cd /d "%~dp0.."

where uv >nul 2>nul
if errorlevel 1 (
  echo 未找到 uv —— Book2Text 用它管理 Python 环境与依赖。
  echo 安装方式（PowerShell^）：powershell -c "irm https://astral.sh/uv/install.ps1 ^| iex"
  echo.
  pause
  exit /b 1
)

REM 交给 Python 入口负责选端口、生成令牌、打开浏览器。
uv run book2text %*

if errorlevel 1 pause
endlocal
