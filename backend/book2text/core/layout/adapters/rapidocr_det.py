"""RapidOCR 的**只检测**适配器（任务 58）。

做法：复用已经安装的 RapidOCR，调用时显式关掉分类与识别：

```python
engine(image, use_det=True, use_cls=False, use_rec=False)
```

`RapidOCR.__call__` 的 `update_params` 会把这些开关写到实例上，因此同一实例
后续再调用时必须继续显式传参；本适配器只做检测，不会把状态泄漏给
`core/ocr/adapters/rapidocr.py`（那是另一个实例）。

**代价（真机实测，200 DPI 单页）：** 只检测约 1.5 秒，整页识别约 4.8 秒，
检测占整页识别约 31%。也就是说"只检测"省掉的是识别模型那一段，
检测模型本身仍要跑——这是版面检测必须付的成本，不是白拿。
"""

from __future__ import annotations

import logging
import time
from importlib.util import find_spec
from pathlib import Path
from typing import Any

from PIL import Image

from ...ocr.base import normalize_quad, pad_to_multiple
from ..base import LayoutEngineError, LayoutLine, LayoutParams, LayoutResult

ENGINE_ID = "rapidocr_det"
_ENGINE_VERSION_FALLBACK = "unknown"
ENGINE_LOG_LEVEL = "warning"

logging.getLogger("RapidOCR").setLevel(logging.WARNING)
logging.getLogger("rapidocr").setLevel(logging.WARNING)


def _module_present(name: str) -> bool:
    try:
        return find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _distribution_version() -> str:
    try:
        from importlib.metadata import version

        return version("rapidocr")
    except Exception:  # pragma: no cover - 元数据缺失不影响检测
        return _ENGINE_VERSION_FALLBACK


class RapidOcrDetAdapter:
    """实现 `core.layout.base.LayoutEngine`。"""

    engine_id = ENGINE_ID

    def __init__(self) -> None:
        self._engine: Any = None

    def version(self) -> str:
        return _distribution_version()

    def available(self) -> tuple[bool, str]:
        if not _module_present("rapidocr"):
            return False, "未安装 Python 包 rapidocr（uv sync --group ocr-eval）"
        if not _module_present("onnxruntime"):
            return False, "缺少推理后端 onnxruntime（uv sync --group ocr-eval）"
        return True, ""

    def _ensure_engine(self) -> Any:
        if self._engine is not None:
            return self._engine
        ok, reason = self.available()
        if not ok:
            raise LayoutEngineError(f"版面检测引擎不可用：{reason}")
        try:
            from rapidocr import RapidOCR
        except Exception as exc:  # pragma: no cover - 依赖损坏时
            raise LayoutEngineError(f"导入 rapidocr 失败：{exc}") from exc
        try:
            self._engine = RapidOCR(params={"Global.log_level": ENGINE_LOG_LEVEL})
        except Exception as exc:
            raise LayoutEngineError(f"初始化 RapidOCR 失败：{exc}") from exc
        return self._engine

    def detect(self, image: Path | Image.Image, params: LayoutParams) -> LayoutResult:
        if isinstance(image, Path):
            try:
                with Image.open(image) as opened:
                    pil_image = opened.convert("RGB")
            except OSError as exc:
                raise LayoutEngineError(f"无法打开图像 {image}：{exc}") from exc
        elif isinstance(image, Image.Image):
            pil_image = image.convert("RGB")
        else:
            raise LayoutEngineError(f"不支持的图像类型：{type(image).__name__}")

        engine = self._ensure_engine()
        started = time.perf_counter()
        # 宽高不补到 32 的倍数会在原生层 SIGSEGV（真机 1069×1762 稳定复现）。
        # 补白只在右 / 下边，所以内容像素坐标不变——下面仍按**原图**宽高归一化。
        padded = pad_to_multiple(pil_image)
        try:
            output = engine(padded, use_det=True, use_cls=False, use_rec=False)
        except Exception as exc:
            raise LayoutEngineError(f"RapidOCR 检测失败：{exc}") from exc
        elapsed = time.perf_counter() - started

        boxes = getattr(output, "boxes", None)
        scores = list(getattr(output, "scores", None) or [])
        width, height = pil_image.size
        lines: list[LayoutLine] = []
        if boxes is not None:
            for index, quad in enumerate(boxes):
                try:
                    bbox = normalize_quad(quad, width, height)
                except (ValueError, TypeError, IndexError) as exc:
                    logging.getLogger(__name__).warning(
                        "第 %d 个检测框无法归一化，已跳过：%s", index, exc
                    )
                    continue
                lines.append(
                    LayoutLine(
                        bbox=bbox,
                        confidence=float(scores[index]) if index < len(scores) else None,
                    )
                )

        # 阅读顺序：先按行（y 中心 1% 容差），再按左边界。双栏书的理想顺序
        # 需要栏检测，这一刀不做（见 docs/known-limitations.md L-71）。
        lines.sort(key=lambda item: (round((item.bbox.y0 + item.bbox.y1) / 2, 2), item.bbox.x0))
        ordered = tuple(
            LayoutLine(bbox=line.bbox, confidence=line.confidence, reading_order=index)
            for index, line in enumerate(lines)
        )

        raw = {
            "engine": ENGINE_ID,
            "mode": "det_only",
            "use_det": True,
            "use_cls": False,
            "use_rec": False,
            "line_count": len(ordered),
            "elapse": getattr(output, "elapse", None),
        }
        return LayoutResult(
            engine_id=ENGINE_ID,
            engine_version=self.version(),
            lines=ordered,
            image_width=width,
            image_height=height,
            elapsed_seconds=elapsed,
            raw=raw,
        )


__all__ = ["ENGINE_ID", "RapidOcrDetAdapter"]
