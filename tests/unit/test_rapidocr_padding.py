"""RapidOCR 原生层段错误的热修回归（2026-10-27，任务 57）。

**问题：**《鹿鼎记》`b2t_XPAT9E` 200 DPI 下，第 281 页（1069×1762）与第 299 页
（1066×1762）让 RapidOCR **稳定 SIGSEGV**（3/3），检测与整页识别都会崩。
补到 32 的倍数（1088×1792，右下补白、内容不平移）后同样两页 43 行、exit 0。

**这组测试守两件事：**

1. `pad_to_multiple()` 的尺寸与"内容不平移"约定（版心检测的 det 适配器仍在用）；
2. `resize_to_multiple()`（2026-11-04 起 OCR 主链路用它）：尺寸是 32 的倍数、返回处理后
   尺寸供归一化、已是倍数时不重采样；
3. 用**能复现崩溃的尺寸**（1069×1762）合成一张**有字**的图，走两个适配器都不崩、
   且坐标按处理后宽高归一化。这一条需要 OCR 运行时。

**为什么 OCR 主链路从补白换成缩放**（2026-11-04，CER 首测 p17）：补白让内容在画布里的
占比变小，det 得分因此掉到阈值下，「雨村因问：近日都中可有新闻没有？」整行消失；
缩放让引擎内部那次 resize 变成同尺寸 no-op，防崩性质不变。
"""

from __future__ import annotations

from PIL import Image, ImageDraw

import pytest

from book2text.core.ocr.base import PAD_MULTIPLE, pad_to_multiple, resize_to_multiple

# 真机上会崩的两个页面渲染尺寸（200 DPI）
CRASHING_SIZE = (1069, 1762)


# ---------------------------------------------------------------- 纯函数部分


def test_pad_multiple_rounds_up_to_32() -> None:
    image = Image.new("RGB", CRASHING_SIZE, "white")

    padded = pad_to_multiple(image)

    assert PAD_MULTIPLE == 32
    assert padded.size == (1088, 1792)
    assert image.size == CRASHING_SIZE, "原图不能被就地改尺寸"


def test_pad_keeps_content_at_origin() -> None:
    """内容留在左上角：这样引擎返回的像素坐标不需要平移。"""
    image = Image.new("RGB", (65, 61), "white")
    ImageDraw.Draw(image).rectangle([2, 3, 10, 9], fill="black")

    padded = pad_to_multiple(image)

    assert padded.size == (96, 64)
    assert padded.getpixel((2, 3)) == (0, 0, 0)
    # 右下补的是纸色白
    assert padded.getpixel((95, 63)) == (255, 255, 255)


def test_pad_is_a_noop_when_already_aligned() -> None:
    image = Image.new("RGB", (64, 96), "white")

    assert pad_to_multiple(image) is image


def test_resize_rounds_up_to_32_and_returns_processed_size() -> None:
    """OCR 主链路：缩放（不是补白），并把**处理后**尺寸交给归一化。"""
    image = Image.new("RGB", CRASHING_SIZE, "white")

    processed, size = resize_to_multiple(image)

    assert processed.size == (1088, 1792)
    assert size == (1088, 1792), "归一化必须按处理后尺寸——按原图除会整体缩水"
    assert image.size == CRASHING_SIZE, "原图不能被就地改尺寸"


def test_resize_is_a_noop_when_already_aligned() -> None:
    image = Image.new("RGB", (64, 96), "white")

    processed, size = resize_to_multiple(image)

    assert processed is image, "已是 32 的倍数时不许重采样（会白白糊 1%）"
    assert size == (64, 96)


# ---------------------------------------------------------------- 真引擎回归

#: macOS 自带的宋体；测试标了 macos_only，缺字体时退回黑条（不再断言"有字"）
_FONT_PATH = "/System/Library/Fonts/Supplemental/Songti.ttc"


def _text_page(size: tuple[int, int]) -> Image.Image:
    """造一页"有文字"的图，尺寸用真机上会崩的那个（1069×1762）。

    **必须是真字**：2026-11-04 之前的版本画的是 8 条黑条，补白路径会把黑条当行框
    返回 2 条垃圾行，于是"lines 非空"这条断言被垃圾满足——换成缩放后黑条不再被当行，
    测试才暴露出它从来没验过"真的认出字"。
    """
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    try:
        from PIL import ImageFont

        font = ImageFont.truetype(_FONT_PATH, 44)
    except OSError:
        font = None
    if font is None:
        for row in range(8):
            y = 120 + row * 90
            draw.rectangle([140, y, size[0] - 140, y + 42], fill=(30, 30, 30))
        return image
    lines = [
        "却说那女娲氏炼石补天之时",
        "于大荒山无稽崖炼成高十二丈",
        "见方二十四丈大的顽石三万六千",
        "五百零一块那娲皇只用了",
        "三万六千五百块单单剩下一块",
        "未用弃在青埂峰下",
    ]
    for row, text in enumerate(lines):
        draw.text((140, 140 + row * 90), text, fill=(20, 20, 20), font=font)
    return image


@pytest.mark.ocr
@pytest.mark.macos_only
def test_detection_survives_crashing_size() -> None:
    """1069×1762 以前 3/3 段错误；padding 之后必须正常返回行框。"""
    from book2text.core.layout.adapters import RapidOcrDetAdapter
    from book2text.core.layout.base import LayoutParams

    adapter = RapidOcrDetAdapter()
    available, reason = adapter.available()
    if not available:
        pytest.skip(f"未安装 OCR 引擎（uv sync --group ocr-eval）：{reason}")

    image = _text_page(CRASHING_SIZE)
    result = adapter.detect(image, LayoutParams(dpi=200))

    assert len(result.lines) >= 3
    assert result.image_width == CRASHING_SIZE[0]
    assert result.image_height == CRASHING_SIZE[1]
    for line in result.lines:
        # 按处理后宽高归一化：缩放不该把框压到 1069/1088
        assert 0.0 <= line.bbox.x0 < line.bbox.x1 <= 1.0
        assert 0.0 <= line.bbox.y0 < line.bbox.y1 <= 1.0


@pytest.mark.ocr
@pytest.mark.macos_only
def test_recognition_survives_crashing_size() -> None:
    """整页识别走的是另一个适配器，同样在 1069×1762 上崩过。"""
    from book2text.core.ocr.adapters.rapidocr import RapidOcrAdapter
    from book2text.core.ocr.base import OcrParams

    adapter = RapidOcrAdapter()
    available, reason = adapter.available()
    if not available:
        pytest.skip(f"未安装 OCR 引擎（uv sync --group ocr-eval）：{reason}")

    image = _text_page(CRASHING_SIZE)
    result = adapter.recognize(image, OcrParams())

    assert result.lines, "合成图上有 6 行真字，识别结果不应为空"
    assert any(line.text.strip() for line in result.lines), "识别出来的行没有文本"
    for line in result.lines:
        assert 0.0 <= line.bbox.x0 < line.bbox.x1 <= 1.0
        assert 0.0 <= line.bbox.y0 < line.bbox.y1 <= 1.0
