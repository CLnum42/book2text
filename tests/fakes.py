"""测试用的假零件。

**假 OCR 引擎**：不加载模型、不看图像内容，按固定坐标返回几行文本。
用它把"识别 → 落库 → 状态机"这条链路跑得又快又确定；
真实引擎的端到端验证在 `tests/integration/test_recognition_engine.py` 与
`tests/integration/test_worker_subprocess.py`（需要 ocr 依赖，未装则跳过）。
"""

from __future__ import annotations

from book2text.core.ocr.base import BBox, OcrEngineError, OcrLine, OcrParams, OcrResult

# 三行文本，第二段与前一段之间留出明显行距 → 分段规则应切成 2 块
FAKE_LINES = (
    ("第一段第一行。", 0.10, 0.13),
    ("第一段第二行。", 0.14, 0.17),
    ("第二段第一行。", 0.26, 0.29),
)
FAKE_LEFT, FAKE_RIGHT = 0.10, 0.90


class FakeOcrEngine:
    """实现 `core.ocr.base.OcrEngine` 协议的最小引擎。"""

    engine_id = "fake"
    version_string = "fake-0.1"

    def __init__(
        self,
        *,
        lines: tuple[tuple[str, float, float], ...] = FAKE_LINES,
        fail_message: str | None = None,
        available: bool = True,
        reason: str = "",
    ) -> None:
        self._lines = lines
        self._fail_message = fail_message
        self._available = available
        self._reason = reason
        self.calls = 0

    def version(self) -> str:
        return self.version_string

    def available(self) -> tuple[bool, str]:
        return (True, "") if self._available else (False, self._reason)

    def supported_languages(self) -> list[str]:
        return ["ch", "en"]

    def recognize(self, image, params: OcrParams) -> OcrResult:
        self.calls += 1
        if self._fail_message:
            raise OcrEngineError(self._fail_message)
        width, height = image.size
        lines = tuple(
            OcrLine(text=text, bbox=BBox(FAKE_LEFT, y0, FAKE_RIGHT, y1), confidence=0.95)
            for text, y0, y1 in self._lines
        )
        return OcrResult(
            engine_id=self.engine_id,
            engine_version=self.version_string,
            lines=lines,
            image_width=width,
            image_height=height,
            elapsed_seconds=0.012,
            raw={"note": "fake", "line_count": len(lines)},
        )


class FailingEngine(FakeOcrEngine):
    """每次识别都失败——用来验证"失败原因可见"。"""

    def __init__(self, message: str = "模拟引擎崩了") -> None:
        super().__init__(fail_message=message)
