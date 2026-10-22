"""页面确认建议的规则测试（说明书 6.2；只给建议，不自动应用）。"""

from __future__ import annotations

from PIL import Image

from book2text.core.project import page_setup


def signals(**changes):
    base = dict(
        page_id="p1",
        page_no=1,
        page_type="body",
        include=True,
        page_confirmed=False,
        has_text_layer=False,
        block_count=0,
        text="",
    )
    base.update(changes)
    return page_setup.PageSignals(**base)


def test_blank_page_is_high_confidence() -> None:
    suggestion = page_setup.suggest_page(signals(page_no=2), ink=0.002, project_has_blocks=True)
    assert suggestion is not None
    assert suggestion.suggested_type == "blank"
    assert suggestion.confidence == page_setup.CONFIDENCE_HIGH


def test_first_page_is_cover_when_not_blank() -> None:
    suggestion = page_setup.suggest_page(signals(page_no=1), ink=0.10, project_has_blocks=False)
    assert suggestion is not None
    assert suggestion.suggested_type == "cover"
    assert suggestion.confidence == page_setup.CONFIDENCE_MEDIUM


def test_new_project_does_not_suggest_front_for_every_page() -> None:
    """还没识别过时，不能仅凭"没有行"就把正文页建议成前置——那会把整本书带偏。"""
    assert page_setup.suggest_page(signals(page_no=2), ink=0.50, project_has_blocks=False) is None


def test_after_ocr_an_image_only_page_is_front() -> None:
    suggestion = page_setup.suggest_page(signals(page_no=5), ink=0.60, project_has_blocks=True)
    assert suggestion is not None
    assert suggestion.suggested_type == "front"
    assert suggestion.confidence == page_setup.CONFIDENCE_MEDIUM


def test_after_ocr_a_nearly_empty_page_is_blank_with_low_confidence() -> None:
    suggestion = page_setup.suggest_page(signals(page_no=7), ink=0.03, project_has_blocks=True)
    assert suggestion is not None
    assert suggestion.suggested_type == "blank"
    assert suggestion.confidence == page_setup.CONFIDENCE_LOW


def test_toc_keyword_suggests_toc() -> None:
    suggestion = page_setup.suggest_page(
        signals(page_no=3, block_count=4, text="目录\n第一回 甄士隐梦幻识通灵"),
        ink=None,
        project_has_blocks=True,
    )
    assert suggestion is not None
    assert suggestion.suggested_type == "toc"


def test_confirmed_and_excluded_pages_get_no_suggestion() -> None:
    assert page_setup.suggest_page(
        signals(page_no=2, page_confirmed=True), ink=0.001, project_has_blocks=True
    ) is None
    assert page_setup.suggest_page(
        signals(page_no=2, include=False), ink=0.001, project_has_blocks=True
    ) is None


def test_same_type_is_not_suggested_twice() -> None:
    assert page_setup.suggest_page(
        signals(page_no=2, page_type="blank"), ink=0.001, project_has_blocks=True
    ) is None


def test_ink_ratio_measures_dark_pixels() -> None:
    image = Image.new("L", (100, 100), 255)
    for x in range(10):
        for y in range(10):
            image.putpixel((x, y), 0)
    assert page_setup.ink_ratio(image) == 0.01
