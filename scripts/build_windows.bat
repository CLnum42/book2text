@echo off
REM 打 Windows x64 的应用包（说明书 Phase 6）：双击启动、自动打开浏览器。
REM
REM     scripts\build_windows.bat
REM
REM 产物：dist\Book2Text\Book2Text.exe（onedir；未签名——SmartScreen 会提示，
REM 点「更多信息」→「仍要运行」）
REM
REM **注意：这个脚本没有在真机上验证过**（本项目只在 macOS 上打过包，见
REM docs/known-limitations.md 与 docs/development-plan 的记录）。Windows 侧
REM 需要实际跑一遍并把结果记进开发日志。
REM
REM 想连识别一起打进去（约 300 MB），先装 OCR 依赖：
REM
REM     uv sync --group ocr-eval

setlocal
cd /d "%~dp0.."
echo 仓库：%CD%

if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

uv run --with pyinstaller pyinstaller ^
  --noconfirm ^
  --clean ^
  --distpath dist ^
  --workpath build ^
  packaging\book2text.spec

if errorlevel 1 (
  echo 打包失败，请看上面的输出 >&2
  exit /b 1
)

echo.
echo 完成：%CD%\dist\Book2Text\Book2Text.exe
echo 双击启动即可；首次会被 SmartScreen 拦下，点「更多信息」→「仍要运行」。
endlocal
