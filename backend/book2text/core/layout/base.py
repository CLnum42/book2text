"""版面检测接口（`docs/workflow.md` 3.1）。

这一层只描述"检测引擎应该长什么样"，不含具体模型：

- **只输出几何，不输出文字。** 检测阶段拿到的行框是后续版心、页码、按行裁图
  识别的共同基础；如果检测模型顺带认字，就会污染第一引擎的输入（说明书 1.5）。
- **bbox 与 `core/ocr/base.BBox` 同口径**：归一化 0–1，相对 PDF 应用 `/Rotate`
  之后的显示方向，原点左上。这样检测行、OCR 行、块行可以直接按坐标比较。

`LayoutResult.regions` 还没有实现（这一刀只做文字行），字段留着是为了后续
图 / 表 / 装饰区域不用改接口。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from PIL import Image

from ..ocr.base import BBox


@dataclass(frozen=True)
class LayoutParams:
    """检测参数。``dpi`` 与识别用的一致，行框才能与 OCR 行 / 块行对齐。"""

    dpi: int = 200
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class LayoutLine:
    """一个检测到的文字行框（**不含文字**）。"""

    bbox: BBox
    confidence: float | None = None
    reading_order: int = 0


@dataclass(frozen=True)
class LayoutResult:
    engine_id: str
    engine_version: str
    lines: tuple[LayoutLine, ...]
    image_width: int
    image_height: int
    elapsed_seconds: float
    raw: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class LayoutEngine(Protocol):
    engine_id: str

    def version(self) -> str:
        """引擎版本字符串。"""

    def available(self) -> tuple[bool, str]:
        """``(是否可用, 不可用的原因)``；不可用时必须给原因（说明书 1.6）。"""

    def detect(self, image: Image.Image, params: LayoutParams) -> LayoutResult:
        """检测一页的文字行。**不得返回文字。**"""


class LayoutEngineError(Exception):
    """检测引擎不可用或检测失败。"""


__all__ = [
    "LayoutEngine",
    "LayoutEngineError",
    "LayoutLine",
    "LayoutParams",
    "LayoutResult",
    "BBox",
    "Image",
    "Path",
]
