"""Apple Vision 的识别语言映射（任务 54）。

只测"项目级语言代码 → Vision 语言列表"的纯函数，不启动 Vision。
真机上的识别行为在 `tests/integration/test_secondary_engine_vision.py`（macOS）。
"""

from __future__ import annotations

from book2text.core.ocr.adapters import apple_vision


def test_english_restricts_to_english() -> None:
    assert apple_vision.vision_languages("en") == ("en-US",)


def test_chinese_and_mixed_keep_both_languages() -> None:
    """中文默认与中英混合都开中英两档：这是 Vision 原来的行为，不因任务 54 变差。"""
    assert apple_vision.vision_languages("ch") == apple_vision.DEFAULT_LANGUAGES
    assert apple_vision.vision_languages("mixed") == apple_vision.DEFAULT_LANGUAGES


def test_unknown_language_falls_back_to_default() -> None:
    assert apple_vision.vision_languages("xx") == apple_vision.DEFAULT_LANGUAGES


def test_adapter_for_engine_maps_to_real_adapters() -> None:
    """引擎设置真的映射到对应适配器（Apple Vision 在别的平台上不能构造时也不会跑）。"""
    from book2text.core.ocr.adapters.apple_vision import AppleVisionAdapter
    from book2text.core.ocr.adapters.rapidocr import RapidOcrAdapter
    from book2text.core.project import recognition

    assert isinstance(recognition.adapter_for_engine("rapidocr"), RapidOcrAdapter)
    assert isinstance(recognition.adapter_for_engine("apple_vision"), AppleVisionAdapter)
    assert isinstance(recognition.adapter_for_engine("dual"), RapidOcrAdapter)
