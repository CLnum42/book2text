"""Apple Vision（macOS 系统 OCR）适配器——**第二引擎**（说明书 8.5）。

为什么选它做 macOS 上的第二引擎（说明书 8.5 要求"独立血统"）：

- **它和 PP-OCR 不是一路的**：苹果自己的模型，不共享训练数据与算法，
  因此它的错误与第一引擎的错误**不相关**——这正是"按行比对找分歧"能起作用的前提；
- **不需要额外模型下载**：随系统提供，装两个 pyobjc 桥接包就能用；
- **不联网**：识别全在本机完成，符合"全部数据只在本机处理"。

几个必须写下来的取舍：

- **只在 accurate 级别支持中文**：`VNRequestTextRecognitionLevelFast` 只认 6 种拉丁语言，
  没有中文（实测）。所以本适配器固定用 accurate。
- **关掉语言纠正**（``usesLanguageCorrection = False``）：开着它会"顺手把文本改通顺"，
  而说明书 1.5 要求不得润色、补全、纠正原文；识别结果只是候选。
- **坐标要翻转**：Vision 的 ``boundingBox`` 是**左下角为原点**的归一化坐标，
  而本项目（说明书 5.2）统一用**左上角**原点——只在这一处翻转，其余层不再处理坐标系。

平台限制：仅 macOS（本机 macOS 14+ 实测）。Windows 的第二引擎是系统 OCR，未实现（L-13）。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

from PIL import Image

from ..base import BBox, OcrEngineError, OcrLine, OcrParams, OcrResult

ENGINE_ID = "apple_vision"

# 第一引擎是 PP-OCR 的中英混排模型，第二引擎的中文能力也要覆盖同样的范围
DEFAULT_LANGUAGES = ("zh-Hans", "en-US")

# 项目级"识别语言"（任务 54）→ Vision 的识别语言列表。
#   ch（中文，默认）/ mixed（中英混合）→ 中英都开；这是 Vision 的默认行为，也是原来的行为
#   en（英文）→ 只开英文，避免把英文单词按中文候选去猜
# 识别结果仍然是原文，不做语言纠正（`usesLanguageCorrection=False`）。
_LANGUAGE_SETS = {
    "ch": DEFAULT_LANGUAGES,
    "mixed": DEFAULT_LANGUAGES,
    "en": ("en-US",),
    # 任务 64：按页判定的结果（`core/ocr/language.py`）直接用 BCP-47 表达
    "zh-Hans": ("zh-Hans",),
    "en-US": ("en-US",),
    "auto": DEFAULT_LANGUAGES,
}


def vision_languages(language: str) -> tuple[str, ...]:
    """项目级语言代码 → Vision 的 BCP-47 列表；未知值用默认。"""
    return _LANGUAGE_SETS.get(language, DEFAULT_LANGUAGES)

_MODULE_NAMES = ("Vision", "Quartz")


def _module_present(name: str) -> bool:
    from importlib.util import find_spec

    try:
        return find_spec(name) is not None
    except (ImportError, ValueError):
        return False


class AppleVisionAdapter:
    """实现 `core.ocr.base.OcrEngine` 协议（说明书 8.1）。"""

    engine_id = ENGINE_ID

    def available(self) -> tuple[bool, str]:
        if sys.platform != "darwin":
            return False, f"仅 macOS 可用（当前平台：{sys.platform}）"
        missing = [name for name in _MODULE_NAMES if not _module_present(name)]
        if missing:
            return False, (
                "缺少 pyobjc 桥接包："
                + "、".join(f"pyobjc-framework-{name}" for name in missing)
                + "（uv sync --group ocr-eval）"
            )
        return True, ""

    def version(self) -> str:
        """系统版本可以代表 Vision 的模型版本（它随系统更新）。"""
        try:
            import platform

            return f"macOS {platform.mac_ver()[0]}"
        except Exception:  # pragma: no cover - 取不到系统版本不影响识别
            return "unknown"

    def supported_languages(self) -> list[str]:
        return list(DEFAULT_LANGUAGES)

    # ---------------------------------------------------------------- 识别

    def recognize(self, image: Path | Image.Image, params: OcrParams) -> OcrResult:
        ok, reason = self.available()
        if not ok:
            raise OcrEngineError(f"Apple Vision 不可用：{reason}")

        try:
            import Quartz
            import Vision
        except Exception as exc:  # pragma: no cover - 依赖损坏时
            raise OcrEngineError(f"导入 pyobjc 失败：{exc}") from exc

        pil_image = self._as_pil(image)
        width, height = pil_image.size

        cg_image = self._to_cg_image(Quartz, pil_image)
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        languages = vision_languages(params.language)
        request.setRecognitionLanguages_(list(languages))
        # 不做语言纠正：那等于替用户"润色"，说明书 1.5 明令禁止
        request.setUsesLanguageCorrection_(False)

        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, None)
        started = time.perf_counter()
        success, error = handler.performRequests_error_([request], None)
        elapsed = time.perf_counter() - started
        if not success:
            raise OcrEngineError(f"Vision 识别失败：{error}")

        lines: list[OcrLine] = []
        for observation in request.results() or []:
            candidates = observation.topCandidates_(1)
            if not candidates:
                continue
            best = candidates[0]
            text = str(best.string())
            if not text.strip():
                continue
            box = observation.boundingBox()
            lines.append(
                OcrLine(
                    text=text,
                    bbox=self._to_normalized(box, params=params),
                    confidence=float(best.confidence()),
                )
            )

        # Vision 不保证按阅读顺序返回：按"先上后左"排一遍，与第一引擎的可比
        lines.sort(key=lambda line: (round(line.bbox.y0, 3), line.bbox.x0))

        raw: dict[str, Any] = {
            "engine": ENGINE_ID,
            "engine_name": "system",
            "line_count": len(lines),
            "recognition_level": "accurate",
            "languages": list(languages),
            "uses_language_correction": False,
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

    # ---------------------------------------------------------------- 内部

    @staticmethod
    def _as_pil(image: Path | Image.Image) -> Image.Image:
        if isinstance(image, Path):
            try:
                with Image.open(image) as opened:
                    return opened.convert("RGB")
            except OSError as exc:
                raise OcrEngineError(f"无法打开图像 {image}：{exc}") from exc
        if isinstance(image, Image.Image):
            return image.convert("RGB")
        raise OcrEngineError(f"不支持的图像类型：{type(image).__name__}")

    @staticmethod
    def _to_cg_image(quartz: Any, image: Image.Image) -> Any:
        """PIL → CGImage：经 PNG 字节走，避免逐像素桥接的开销。"""
        import io

        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        data = buffer.getvalue()

        from Foundation import NSData  # pyobjc-framework-Cocoa

        ns_data = NSData.dataWithBytes_length_(data, len(data))
        source = quartz.CGImageSourceCreateWithData(ns_data, None)
        if source is None:
            raise OcrEngineError("无法把图像交给系统框架（CGImageSourceCreateWithData 失败）")
        cg_image = quartz.CGImageSourceCreateImageAtIndex(source, 0, None)
        if cg_image is None:
            raise OcrEngineError("无法把图像交给系统框架（CGImageSourceCreateImageAtIndex 失败）")
        return cg_image

    @staticmethod
    def _to_normalized(box: Any, *, params: OcrParams) -> BBox:
        """Vision 的归一化框（**左下角原点**）→ 本项目的（左上角原点，说明书 5.2）。

        只在这里翻转一次：上游给的是"已经应用 /Rotate 的显示方向"的图，
        下游所有层都按左上角原点理解坐标。
        """
        x0 = float(box.origin.x)
        y0 = float(box.origin.y)
        width = float(box.size.width)
        height = float(box.size.height)
        clamp = lambda value: min(1.0, max(0.0, value))  # noqa: E731 - 局部小工具

        left = clamp(x0)
        right = clamp(x0 + width)
        top = clamp(1.0 - (y0 + height))
        bottom = clamp(1.0 - y0)
        return BBox(left, top, right, bottom)
