"""漏行检测的几何规则：用合成图直接测 `_detect`，不依赖 PDF 渲染。

集成测试用的是真 PDF 渲染，代价是"平台渲染差异会让边界值抖动"（Windows 上
1 像素的差别就能把刚好压线的条带筛掉）。规则本身用合成图钉住：白底黑条，
尺寸与位置都自己定，跨平台完全一致。
"""

from __future__ import annotations

from types import SimpleNamespace

from PIL import Image, ImageDraw

from book2text.core.project import ink_gaps

WIDTH, HEIGHT = 400, 600


def _page() -> Image.Image:
    return Image.new("RGB", (WIDTH, HEIGHT), (255, 255, 255))


def _bar(image: Image.Image, box: tuple[int, int, int, int]) -> None:
    ImageDraw.Draw(image).rectangle(box, fill=(20, 20, 20))


def _line(block_id: str, box) -> SimpleNamespace:
    return SimpleNamespace(
        block_id=block_id,
        block_type="paragraph",
        bbox=(box[0] / WIDTH, box[1] / HEIGHT, box[2] / WIDTH, box[3] / HEIGHT),
    )


def _covered(block_id: str, box) -> SimpleNamespace:
    """一条覆盖用的"行"（block 与 line 同一个对象即可）。"""
    return _line(block_id, box)


def _detect(image, blocks, lines):
    return ink_gaps._detect(image, blocks, lines)


def test_an_uncovered_text_line_is_reported_with_its_box() -> None:
    image = _page()
    _bar(image, (40, 100, 360, 112))  # 第三行：没有被任何行框覆盖
    _bar(image, (40, 200, 360, 212))
    _bar(image, (40, 300, 360, 312))
    lines = [_line("a", (40, 200, 360, 212)), _line("b", (40, 300, 360, 312))]
    result = _detect(image, lines, lines)
    assert len(result["candidates"]) == 1, result
    box = result["candidates"][0]["bbox"]
    assert box[0] <= 40 / WIDTH + 1e-4 and box[2] >= 360 / WIDTH - 1e-4
    assert box[1] <= 100 / HEIGHT + 1e-4 and box[3] >= 112 / HEIGHT - 1e-4


def test_all_lines_covered_reports_nothing() -> None:
    image = _page()
    barges = ((40, 100, 360, 112), (40, 200, 360, 212), (40, 300, 360, 312))
    for box in barges:
        _bar(image, box)
    lines = [_line(str(index), box) for index, box in enumerate(barges)]
    assert _detect(image, lines, lines)["candidates"] == []


def test_a_tight_line_box_does_not_produce_a_band() -> None:
    """行框比字紧（条带落在行框的竖直范围里）→ 不报：这行其实有框。"""
    image = _page()
    _bar(image, (40, 100, 360, 112))
    lines = [_line("tight", (40, 98, 360, 114))]  # 框住整条墨迹
    assert _detect(image, lines, lines)["candidates"] == []


def test_vertical_bars_and_table_borders_are_not_reported() -> None:
    """表格竖线 + 文字是"高"的条带：宽高比不够，靠这条挡掉。"""
    image = _page()
    _bar(image, (300, 100, 306, 200))  # 竖线
    _bar(image, (250, 150, 262, 162))  # 竖线旁边的一个小数字块
    lines = [_line("body", (40, 300, 360, 312))]
    assert _detect(image, lines, lines)["candidates"] == []


def test_the_outer_margin_is_ignored() -> None:
    """页面最外侧 3% 的墨迹（扫描仪边缘、裁切黑边）不报。"""
    image = _page()
    _bar(image, (20, 4, 380, 16))  # y 0.007–0.027，落在上边 3% 里
    lines = [_line("body", (40, 300, 360, 312))]
    assert _detect(image, lines, lines)["candidates"] == []


def test_figure_and_decoration_blocks_cover_their_area() -> None:
    """插图 / 装饰块盖住的区域不算漏行（图不是字）。"""
    image = _page()
    _bar(image, (100, 200, 300, 260))
    figure = SimpleNamespace(
        block_id="fig",
        block_type="figure",
        bbox=(100 / WIDTH, 200 / HEIGHT, 300 / WIDTH, 260 / HEIGHT),
    )
    body = _line("body", (40, 400, 360, 412))
    assert _detect(image, [figure, body], [body])["candidates"] == []


def test_a_block_without_lines_covers_its_area() -> None:
    """人工新增的块没有行记录，但它就是"这块已经处理过"的证据。"""
    image = _page()
    _bar(image, (100, 200, 300, 212))
    manual = SimpleNamespace(
        block_id="manual",
        block_type="paragraph",
        bbox=(100 / WIDTH, 200 / HEIGHT, 300 / WIDTH, 212 / HEIGHT),
    )
    body = _line("body", (40, 400, 360, 412))
    assert _detect(image, [manual, body], [body])["candidates"] == []


def test_otsu_threshold_separates_dark_text_from_paper() -> None:
    image = _page()
    _bar(image, (40, 100, 360, 112))
    gray = image.convert("L")
    threshold = ink_gaps._otsu_threshold(gray.histogram(), WIDTH * HEIGHT)
    assert 20 <= threshold <= 200
