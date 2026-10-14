"""OCR 引擎适配器。

每个适配器实现 `core.ocr.base.OcrEngine` 协议，并**负责把引擎的像素坐标
转换为说明书 5.2 的归一化坐标**。新增引擎时在这里注册。
"""

from __future__ import annotations

from .rapidocr import RapidOcrAdapter

# 已接入的适配器。说明书 Phase 0 第 1 项尚未在 RapidOCR 与 PaddleOCR 之间选定，
# 因此这里只注册已实测过的那一个；其余候选在 Phase 0 结论出来后再加。
ADAPTERS = (RapidOcrAdapter,)

__all__ = ["RapidOcrAdapter", "ADAPTERS"]

from .apple_vision import AppleVisionAdapter  # noqa: E402
