"""包内路径常量。

集中在一处解析，避免各模块各写一遍 `Path(__file__).parent...`。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

PACKAGE_DIR: Path = Path(__file__).resolve().parent

# 打包运行（PyInstaller）时，静态文件随 `--add-data` 放进 `_MEIPASS/book2text/static`；
# 源码运行时就在包目录旁边。两处都找一下，谁在就用谁（说明书 6.1 的界面由后端托管）。
_CANDIDATES = [PACKAGE_DIR / "static"]
if getattr(sys, "frozen", False):  # pragma: no cover - 打包后才有
    _MEIPASS = Path(getattr(sys, "_MEIPASS", PACKAGE_DIR))
    _CANDIDATES.insert(0, _MEIPASS / "book2text" / "static")

STATIC_DIR: Path = next((path for path in _CANDIDATES if path.is_dir()), _CANDIDATES[0])


def app_data_dir() -> Path:
    """应用私域数据目录（模型包、引擎 pid 文件放这里，**不放 /tmp**）。

    macOS：`~/Library/Application Support/Book2Text`
    Windows：`%APPDATA%\\Book2Text`
    其他：`$XDG_DATA_HOME/Book2Text`（默认 `~/.local/share/Book2Text`）

    只算路径，不建目录——调用方要写盘时自己 `mkdir(parents=True)`。
    """
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif os.name == "nt":  # pragma: no cover - Windows 上没有 Jev（llama.cpp 走 Metal）
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    else:  # pragma: no cover - 同上
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "Book2Text"
