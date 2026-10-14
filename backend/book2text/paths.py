"""包内路径常量。

集中在一处解析，避免各模块各写一遍 `Path(__file__).parent...`。
"""

from __future__ import annotations

from pathlib import Path

PACKAGE_DIR: Path = Path(__file__).resolve().parent
STATIC_DIR: Path = PACKAGE_DIR / "static"
