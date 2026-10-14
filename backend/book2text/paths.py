"""包内路径常量。

集中在一处解析，避免各模块各写一遍 `Path(__file__).parent...`。
"""

from __future__ import annotations

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
