"""裁图送 OCR 引擎前的最小尺寸防护（任务 33 的稳定性底线）。

RapidOCR / ONNX Runtime 在退化的小图上会在 native 层段错误（exit 139），
Python 的 try/except 捕不到；这里只验证"不把过小的图送进去"。
"""

from __future__ import annotations

from PIL import Image

from book2text.core.ocr.base import BBox
from book2text.core.project import recognition


def test_tiny_line_crop_is_not_sent_to_engine() -> None:
    image = Image.new("RGB", (1000, 1000), "white")
    assert recognition._crop_line(image, BBox(0.5, 0.5, 0.5001, 0.5001)) is None
    assert recognition._crop_line(image, BBox(0.5, 0.5, 0.501, 0.504)) is None

    crop = recognition._crop_line(image, BBox(0.1, 0.1, 0.2, 0.15))
    assert crop is not None
    assert min(crop.size) >= recognition.CROP_MIN_PX
    assert crop.mode == "RGB"
    crop.close()
