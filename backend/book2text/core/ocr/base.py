"""OCR 适配器接口（说明书 8.1）。

这一层只描述"引擎应该长什么样"，不含任何具体引擎的代码。

**坐标系（说明书 5.2）：** 所有 bbox 都是**归一化坐标** ``[x0, y0, x1, y1]``，
取值 0–1，相对于**应用 PDF ``/Rotate`` 之后的页面显示方向**，原点在左上。
归一化与渲染 DPI 无关：渲染出的图像乘以宽高即得像素坐标。
**把引擎输出的像素坐标转换成归一化坐标是适配器的责任**，见 `adapters/`。

**与说明书的偏差（已记录在 docs/decisions.md D-012）：** 说明书 8.1 里
``OcrResult`` 的字段是 ``blocks``。但说明书 8.4 同时说明"PP-OCR 核心流程只返回行、
不返回块"，块要由 ``core/structure/grouping.py`` 组合。``grouping.py`` 尚未实现，
因此本层如实只提供 ``lines``，**不伪造块**。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from PIL import Image


@dataclass(frozen=True)
class BBox:
    """归一化边界框，0–1，原点左上（说明书 5.2）。"""

    x0: float
    y0: float
    x1: float
    y1: float

    def as_list(self) -> list[float]:
        return [self.x0, self.y0, self.x1, self.y1]

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    def expanded(self, fraction: float) -> BBox:
        """向外扩张，用于裁行图。

        说明书 8.5 要求裁行图时"外扩约 2% 以保留笔画"，因此这里的结果
        **可能超出 0–1**——裁图时需要按图像边界再夹紧，不要在这里截断，
        否则会丢掉边缘笔画。
        """
        dx = self.width * fraction
        dy = self.height * fraction
        return BBox(self.x0 - dx, self.y0 - dy, self.x1 + dx, self.y1 + dy)


@dataclass(frozen=True)
class OcrLine:
    """一个文本行——对应说明书 5.3 的 BlockLine（不含块归属与分歧字段）。

    ``text`` 是引擎给出的**原文**。说明书 1.5 规定不得润色、补全、纠正原文，
    因此这里不做任何"修正"。
    """

    text: str
    bbox: BBox
    confidence: float | None = None


@dataclass(frozen=True)
class OcrParams:
    """识别参数（对应说明书 5.3 的 ``OCRRun.params_json``）。"""

    language: str = "ch"
    dpi: int = 300
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class OcrResult:
    engine_id: str
    engine_version: str
    lines: tuple[OcrLine, ...]
    image_width: int
    image_height: int
    elapsed_seconds: float
    raw: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class OcrEngine(Protocol):
    """说明书 8.1 的适配器接口。"""

    engine_id: str

    def version(self) -> str:
        """引擎版本字符串。"""

    def available(self) -> tuple[bool, str]:
        """``(是否可用, 不可用的原因)``。

        不可用时**必须**给出原因——这是引擎自检接口的依据（说明书 1.6）。
        """

    def supported_languages(self) -> list[str]:
        """引擎支持的语言标识。"""

    def recognize(
        self,
        image: Path | Image.Image,
        params: OcrParams,
    ) -> OcrResult:
        """识别一页，返回**带归一化 bbox 的行**。

        接受 ``Path`` 是为将来按说明书 8.2 渲染到 ``cache/ocr/`` 后再识别；
        现在为了少写一次磁盘，直接传内存中的 ``PIL.Image``。
        两者都必须走 `core/pdf/render.py` 的 ``render_page_image()`` 产出，
        以保证方向与尺寸和界面显示一致。
        """


class OcrEngineError(Exception):
    """引擎不可用或识别失败。"""


def normalize_quad(quad: Any, width: int, height: int) -> BBox:
    """把引擎返回的像素四边形转成归一化 bbox。

    - 取四点的外接矩形（引擎给的是旋转框，本项目只需轴对齐框）
    - 除以图像宽高；再夹紧到 0–1（引擎的框可能略微越界）
    """
    if width <= 0 or height <= 0:
        raise ValueError("图像宽高必须为正数")

    xs = [float(point[0]) for point in quad]
    ys = [float(point[1]) for point in quad]
    if not xs or not ys:
        raise ValueError("四边形为空")

    x0 = min(xs) / width
    y0 = min(ys) / height
    x1 = max(xs) / width
    y1 = max(ys) / height

    clamp = lambda value: min(1.0, max(0.0, value))  # noqa: E731 - 局部小工具
    return BBox(clamp(x0), clamp(y0), clamp(x1), clamp(y1))
