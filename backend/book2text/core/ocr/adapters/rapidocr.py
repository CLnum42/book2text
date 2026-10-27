"""RapidOCR（ONNX 部署形态）适配器。

对应说明书 8.4 的第一引擎候选之一。macOS arm64 上的门槛实测见
`docs/ocr-evaluation.md`（行级坐标与每页耗时均已达标）。

**导入策略：** rapidocr / onnxruntime 合计约 300 MB，导入也慢，因此**延迟导入**——
`available()` 先用 `importlib.util.find_spec` 轻量探测，真正识别时才导入。
这样未安装 OCR 依赖的环境（例如只想看界面）不会被迫加载它们。
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from PIL import Image

from ..base import (
    BBox,
    OcrEngineError,
    OcrLine,
    OcrParams,
    OcrResult,
    normalize_quad,
    pad_to_multiple,
)

ENGINE_ID = "rapidocr"
_ENGINE_VERSION_FALLBACK = "unknown"

# 引擎默认往 stdout 打 INFO 级启动日志（"Using engine_name: ..."、**模型文件的绝对路径**），
# 而这些 stdout 在识别子进程里会被收进项目的任务日志——既吵，也违反说明书第 10 节
# "日志里不留个人绝对路径"的取向。构造时用引擎自己的参数把级别压到 WARNING
# （`RapidOCR.__init__` 会用 config 里的 Global.log_level 覆盖 logger 级别，
# 所以只在外面 setLevel 是没用的）。真正的错误仍然可见。
ENGINE_LOG_LEVEL = "warning"

logging.getLogger("RapidOCR").setLevel(logging.WARNING)
logging.getLogger("rapidocr").setLevel(logging.WARNING)


def _distribution_version() -> str:
    try:
        from importlib.metadata import version

        return version("rapidocr")
    except Exception:  # pragma: no cover - 元数据缺失不影响识别
        return _ENGINE_VERSION_FALLBACK


def _module_present(name: str) -> bool:
    from importlib.util import find_spec

    try:
        return find_spec(name) is not None
    except (ImportError, ValueError):
        return False


class RapidOcrAdapter:
    """实现 `core.ocr.base.OcrEngine` 协议。"""

    engine_id = ENGINE_ID

    def __init__(self) -> None:
        self._engine: Any = None

    # ---------------------------------------------------------------- 自检

    def version(self) -> str:
        return _distribution_version()

    def available(self) -> tuple[bool, str]:
        if not _module_present("rapidocr"):
            return False, "未安装 Python 包 rapidocr（uv sync --group ocr-eval）"
        if not _module_present("onnxruntime"):
            return False, "缺少推理后端 onnxruntime（uv sync --group ocr-eval）"
        return True, ""

    def supported_languages(self) -> list[str]:
        # RapidOCR 的默认 PP-OCR 模型为中英混排模型，同时可识别简体中文与英文。
        return ["ch", "en"]

    # ---------------------------------------------------------------- 识别

    def _ensure_engine(self) -> Any:
        if self._engine is not None:
            return self._engine

        ok, reason = self.available()
        if not ok:
            raise OcrEngineError(f"RapidOCR 不可用：{reason}")

        try:
            from rapidocr import RapidOCR
        except Exception as exc:  # pragma: no cover - 依赖损坏时
            raise OcrEngineError(f"导入 rapidocr 失败：{exc}") from exc

        try:
            self._engine = RapidOCR(params={"Global.log_level": ENGINE_LOG_LEVEL})
        except Exception as exc:
            raise OcrEngineError(f"初始化 RapidOCR 失败：{exc}") from exc
        return self._engine

    def recognize(self, image: Path | Image.Image, params: OcrParams) -> OcrResult:
        if isinstance(image, Path):
            try:
                with Image.open(image) as opened:
                    pil_image = opened.convert("RGB")
            except OSError as exc:
                raise OcrEngineError(f"无法打开图像 {image}：{exc}") from exc
        elif isinstance(image, Image.Image):
            pil_image = image.convert("RGB")
        else:
            raise OcrEngineError(f"不支持的图像类型：{type(image).__name__}")

        engine = self._ensure_engine()

        started = time.perf_counter()
        # 宽高不补到 32 的倍数会在原生层 SIGSEGV（真机 1069×1762 稳定复现）。
        # 补白只在右 / 下边，所以内容像素坐标不变——下面仍按**原图**宽高归一化。
        padded = pad_to_multiple(pil_image)
        try:
            output = engine(padded)
        except Exception as exc:
            raise OcrEngineError(f"RapidOCR 识别失败：{exc}") from exc
        elapsed = time.perf_counter() - started

        boxes = getattr(output, "boxes", None)
        texts = list(getattr(output, "txts", None) or [])
        scores = list(getattr(output, "scores", None) or [])

        width, height = pil_image.size
        lines: list[OcrLine] = []

        if boxes is not None and len(boxes) == len(texts):
            for index, quad in enumerate(boxes):
                try:
                    bbox: BBox = normalize_quad(quad, width, height)
                except (ValueError, TypeError, IndexError) as exc:
                    # 单个行框异常不应该让整页失败，但要留下痕迹。
                    logging.getLogger(__name__).warning(
                        "第 %d 个行框无法归一化，已跳过：%s", index, exc
                    )
                    continue
                confidence = float(scores[index]) if index < len(scores) else None
                lines.append(OcrLine(text=str(texts[index]), bbox=bbox, confidence=confidence))
        elif texts:
            # 引擎返回了文本但没有坐标：说明书 8.4 明确这种情形必须报告，
            # 不能静默降级。这里抛错而不是伪造坐标。
            raise OcrEngineError(
                "RapidOCR 返回了文本但没有行级坐标；按行比对的方案无法成立，"
                "请报告此问题（说明书 8.4）"
            )

        raw = {
            "engine": ENGINE_ID,
            "engine_name": "onnxruntime",
            "line_count": len(lines),
            "elapse": getattr(output, "elapse", None),
            "elapse_list": getattr(output, "elapse_list", None),
        }

        return OcrResult(
            engine_id=ENGINE_ID,
            engine_version=self.version(),
            lines=tuple(lines),
            image_width=width,
            image_height=height,
            elapsed_seconds=elapsed,
            raw=raw,
        )
