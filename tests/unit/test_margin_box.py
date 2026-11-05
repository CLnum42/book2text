"""版心推算与校验（任务 50）的单元测试。

算法是纯函数 `suggest_from_page_boxes`：这里用手写的行框覆盖
"抖动、短行、书眉页码、页数太少、边缘离散"几种情况，不建整本书。
真书上的效果在 `tests/integration/test_margin_box_api.py` 与真浏览器验收里。
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from book2text.core.project import margin_box
from book2text.core.project.library import Page, Project


def _page(no: int, mode: str = "inherit", box=None) -> Page:
    return Page(
        page_id=f"p{no}",
        page_no=no,
        page_label="",
        width_pt=595.0,
        height_pt=842.0,
        rotation=0,
        page_type="body",
        include=True,
        has_text_layer=False,
        margin_box=box,
        margin_box_mode=mode,
    )


def _project(box=None) -> Project:
    return Project(
        project_id="b2t_TEST01",
        name="测试",
        source_file_name="a.pdf",
        source_sha256="x",
        page_count=10,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
        schema_version=11,
        margin_box=box,
    )


def _body_lines(no: int, *, left=0.10, right=0.90, top=0.10, bottom=0.90) -> list[list[float]]:
    """一页 5 行正文（每行宽度都过短行阈值）。"""
    return [
        [left, top + index * 0.18, right, top + index * 0.18 + 0.02]
        for index in range(5)
    ]


def test_normalize_rejects_bad_geometry() -> None:
    with pytest.raises(margin_box.MarginBoxError):
        margin_box.normalize_margin_box([0.9, 0.1, 0.2, 0.9])
    with pytest.raises(margin_box.MarginBoxError):
        margin_box.normalize_margin_box([0.1, 0.1, 0.9, 1.2])
    with pytest.raises(margin_box.MarginBoxError):
        margin_box.normalize_margin_box([0.49, 0.1, 0.50, 0.9])  # 太窄
    with pytest.raises(margin_box.MarginBoxError):
        margin_box.normalize_margin_box([0.1, 0.1, 0.9])


def test_normalize_accepts_and_rounds() -> None:
    assert margin_box.normalize_margin_box(None) is None
    assert margin_box.normalize_margin_box([0.12345678, 0.2, 0.9, 0.95]) == (
        0.123457,
        0.2,
        0.9,
        0.95,
    )


def test_suggestion_is_stable_against_ocr_jitter() -> None:
    """边缘 ±0.003 的抖动不该改变结果：最密窗口取中位数。"""
    page_boxes = {}
    for page_no in range(1, 21):
        jitter = (page_no % 5 - 2) * 0.0015
        page_boxes[page_no] = _body_lines(
            page_no, left=0.10 + jitter, right=0.90 + jitter, top=0.10, bottom=0.90
        )
    result = margin_box.suggest_from_page_boxes(page_boxes)
    assert result.reliable is True
    assert result.pages == 20
    assert result.margin_box is not None
    # 建议框向外让了 2%（防止 OCR 抖动切字）；识别到的原始边缘在 edges 里
    left, top, right, bottom = result.margin_box
    assert left == pytest.approx(0.10 - margin_box.EDGE_PADDING, abs=0.004)
    assert right == pytest.approx(0.90 + margin_box.EDGE_PADDING, abs=0.004)
    assert top == pytest.approx(0.10 - margin_box.EDGE_PADDING, abs=0.002)
    assert bottom == pytest.approx(0.84 + margin_box.EDGE_PADDING, abs=0.002)
    assert result.edges["left"].value == pytest.approx(0.10, abs=0.004)
    assert result.edges["right"].value == pytest.approx(0.90, abs=0.004)
    assert result.confidence == "high"


def test_short_lines_and_edge_bands_do_not_pull_the_box() -> None:
    """页眉 / 页码那种短行与页面边缘行被剔除；居中标题也不改变左边缘。"""
    page_boxes = {}
    for page_no in range(1, 11):
        boxes = _body_lines(page_no)
        boxes.append([0.65, 0.03, 0.80, 0.05])  # 书眉：页面最上
        boxes.append([0.48, 0.96, 0.52, 0.98])  # 页码：页面最下
        boxes.append([0.40, 0.30, 0.60, 0.32])  # 居中短行（宽度 20%）
        page_boxes[page_no] = boxes
    result = margin_box.suggest_from_page_boxes(page_boxes)
    assert result.margin_box is not None
    assert result.edges["left"].value == pytest.approx(0.10, abs=0.002), (
        "短行不能把左边缘拉到 0.4"
    )
    assert result.edges["top"].value == pytest.approx(0.10, abs=0.002), (
        "书眉不能把上边缘拉到 0.03"
    )
    assert result.edges["bottom"].value == pytest.approx(0.84, abs=0.002), (
        "页码不能把下边缘拉到 0.98（正文最后一行的底是 0.84）"
    )


def test_too_few_pages_is_reported_as_unreliable() -> None:
    result = margin_box.suggest_from_page_boxes(
        {no: _body_lines(no) for no in range(1, 4)}
    )
    assert result.reliable is False
    assert result.confidence == "low"
    assert any("少于 5 页" in note for note in result.notes)


def test_large_edge_spread_is_reported_as_unreliable() -> None:
    """每页左右边缘差很多（双栏 / 旁批 / 拼版）→ 如实说不可靠。"""
    page_boxes = {
        no: _body_lines(no, left=0.05 + (no % 10) * 0.045, right=0.90)
        for no in range(1, 21)
    }
    result = margin_box.suggest_from_page_boxes(page_boxes)
    assert result.reliable is False
    assert result.confidence == "low"
    assert any("覆盖" in note or "离散较大" in note for note in result.notes)


def test_no_lines_gives_no_box() -> None:
    result = margin_box.suggest_from_page_boxes({1: []})
    assert result.margin_box is None
    assert result.reliable is False
    assert result.pages == 0


def test_effective_margin_box_three_modes() -> None:
    project = _project(box=(0.1, 0.1, 0.9, 0.9))
    assert margin_box.effective_margin_box(project, _page(1)) == (0.1, 0.1, 0.9, 0.9)
    assert margin_box.effective_margin_box(
        project, _page(2, mode="custom", box=(0.2, 0.2, 0.8, 0.8))
    ) == (0.2, 0.2, 0.8, 0.8)
    assert margin_box.effective_margin_box(project, _page(3, mode="none")) is None
    # custom 页缺四边（历史坏数据）时不要退回全局：那会显示一个不是用户设置的框
    assert margin_box.effective_margin_box(project, _page(4, mode="custom", box=None)) is None


def test_auto_page_never_falls_back_to_global_box() -> None:
    """任务 33：auto 页没有落库框 = 未定；不拿项目默认框顶替，也不进导出。"""
    project = _project(box=(0.1, 0.1, 0.9, 0.9))
    page = _page(5, mode="auto", box=None)
    assert margin_box.effective_margin_box(project, page) is None
    assert margin_box.export_margin_box(project, page) is None
    # 有本页框时，界面 / 导出读同一份
    page_with_box = _page(6, mode="auto", box=(0.2, 0.15, 0.8, 0.85))
    assert margin_box.effective_margin_box(project, page_with_box) == (0.2, 0.15, 0.8, 0.85)
    assert margin_box.export_margin_box(project, page_with_box) == (0.2, 0.15, 0.8, 0.85)


def test_auto_source_label_reports_method() -> None:
    project = _project(box=(0.1, 0.1, 0.9, 0.9))
    page = _page(7, mode="auto", box=(0.2, 0.15, 0.8, 0.85))
    assert margin_box.page_margin_source_label(project, page) == "自动拟合"
    page = replace(page, margin_box_method="bbox")
    assert margin_box.page_margin_source_label(project, page) == "本页包围盒（兜底）"
    page = replace(page, margin_box=None)
    assert margin_box.page_margin_source_label(project, page) == "未定（还没有拟合框）"


def test_margin_judgement_defaults_on_and_explicit_off_wins() -> None:
    """任务 34：没有存过设置 = 开；只有显式存 false 才关。"""
    from book2text.core.project import library as library_module

    project = _project(box=(0.1, 0.1, 0.9, 0.9))
    assert library_module.margin_judgement_enabled(project) is True
    with_off = replace(project, settings={"margin_box_judgement": False})
    assert library_module.margin_judgement_enabled(with_off) is False
    with_on = replace(project, settings={"margin_box_judgement": True})
    assert library_module.margin_judgement_enabled(with_on) is True


def test_block_inside_margin_uses_page_box_and_never_global() -> None:
    """任务 34：审校与导出同一个判断；auto 页没有框时整页都算（不拿全局框）。"""
    from book2text.core.project import library as library_module

    project = _project(box=(0.1, 0.1, 0.9, 0.9))
    page = _page(1, mode="auto", box=(0.2, 0.2, 0.8, 0.8))
    assert margin_box.block_inside_margin(project, page, [0.3, 0.3, 0.5, 0.5]) is True
    assert margin_box.block_inside_margin(project, page, [0.0, 0.0, 0.05, 0.05]) is False
    # 没有 bbox 的块：宁可多审，不藏
    assert margin_box.block_inside_margin(project, page, None) is True
    # auto 页没有本页框 = 未定：整页都算，绝不拿全局框顶替
    undetermined = _page(2, mode="auto", box=None)
    assert margin_box.block_inside_margin(project, undetermined, [0.0, 0.0, 0.05, 0.05]) is True
    # none 页也整页都算
    none_page = _page(3, mode="none")
    assert margin_box.block_inside_margin(project, none_page, [0.0, 0.0, 0.05, 0.05]) is True
    assert library_module.margin_judgement_enabled(project) is True


# ---------------------------------------------------------------- 页边重复行不进拟合（2026-11-05）


def _header_page_lines(header=(0.20, 0.052, 0.62, 0.072)):
    """一页正文 + 一条顶端书眉（书眉宽 < 45%，本来不该参与长行起步）。"""
    body = [(0.10, 0.12 + index * 0.032, 0.90, 0.14 + index * 0.032) for index in range(8)]
    return [header, *body], [(header[0] - 0.002, header[1] - 0.002, header[2] + 0.002, header[3] + 0.002)]


def test_furniture_line_is_kept_out_of_the_fitted_box() -> None:
    """真机 p98：页眉被"够得着就并进来"吸进版心 ⇒ 给了排除矩形后 y0 必须是正文第一行。"""
    lines, rects = _header_page_lines()
    plain = margin_box.fit_page_margin_box(lines)
    assert plain.box is not None
    assert plain.box[1] < 0.09, "构造失败：没有矩形时页眉本来就被吸进来了"

    fitted = margin_box.fit_page_margin_box(lines, rects=rects)
    assert fitted.box is not None
    assert fitted.box[1] >= 0.115, f"页眉仍被并进版心：{fitted.box}"
    assert fitted.box[1] <= 0.125, f"版心被推得太低（正文第一行在 0.12）：{fitted.box}"


def test_furniture_removal_falls_back_when_the_box_stops_covering_the_body() -> None:
    """真机 p221（表格页）：剔掉书眉后长行起点全在下半页，框从 y0=0.53 才开始。

    判据：退回"全行拟合 + 切掉页边带"后，正文行（含表格里那些短行）仍在框内，书眉在框外。
    """
    header = (0.39, 0.063, 0.88, 0.087)
    table = [
        (0.15, 0.11 + index * 0.025, 0.40, 0.13 + index * 0.025) for index in range(10)
    ] + [
        (0.52, 0.11 + index * 0.025, 0.87, 0.13 + index * 0.025) for index in range(10)
    ]
    body = [(0.10, 0.53 + index * 0.035, 0.90, 0.55 + index * 0.035) for index in range(8)]
    rects = [(header[0] - 0.002, header[1] - 0.002, header[2] + 0.002, header[3] + 0.002)]
    fitted = margin_box.fit_page_margin_box([header, *table, *body], rects=rects)
    assert fitted.box is not None
    # 书眉中心必须在框外
    cx = (header[0] + header[2]) / 2
    cy = (header[1] + header[3]) / 2
    assert not (fitted.box[0] <= cx <= fitted.box[2] and fitted.box[1] <= cy <= fitted.box[3])
    # 表格与正文都要留在框内（否则就是"剔掉页眉、顺手扔掉半页正文"）
    for box in table + body:
        assert fitted.box[0] - 1e-9 <= (box[0] + box[2]) / 2 <= fitted.box[2] + 1e-9
        assert fitted.box[1] - 1e-9 <= (box[1] + box[3]) / 2 <= fitted.box[3] + 1e-9


def test_furniture_guard_skips_pages_where_the_candidates_eat_the_body() -> None:
    """护栏：一页上被剔的行 > 30% ⇒ 放弃剔除（候选把正文吃进去了）。"""
    lines, rects = _header_page_lines()
    # 把矩形放大到盖住大半页行：正常页面不该出现，出现时必须放弃剔除
    greedy = [(0.0, 0.0, 1.0, 0.5)]
    fitted = margin_box.fit_page_margin_box(lines, rects=greedy)
    plain = margin_box.fit_page_margin_box(lines)
    assert fitted.box == plain.box, "护栏没生效：把正文行一起剔掉了"


# ---------------------------------------------------------------- 标题不被挤到框外（2026-11-05）


def test_short_title_far_above_the_first_long_line_is_inside_the_box() -> None:
    """真机 p61：小结标题与第一行长行隔 1.7 个行高，旧逻辑"够得着"够不到 ⇒ 标题被扔掉。

    新判据：横向用长行定义"栏"，纵向取栏内所有非家具行的并集。
    """
    body = [(0.16, 0.2288 + index * 0.032, 0.88, 0.2488 + index * 0.032) for index in range(6)]
    title = (0.432, 0.1512, 0.548, 0.1815)      # 居中短行，比第一行长行高 0.05
    fitted = margin_box.fit_page_margin_box([title, *body])
    assert fitted.box is not None
    assert fitted.box[1] <= 0.1512, f"标题被挤到框外：{fitted.box}"


def test_furniture_zone_drops_a_broken_header_by_position() -> None:
    """真机 p29：页眉被 OCR 读成「论21」，模板对不上候选，靠**同奇偶的位置带**剔掉。"""
    header = (0.786, 0.0665, 0.876, 0.0842)
    body = [(0.21, 0.1154 + index * 0.03, 0.83, 0.1361 + index * 0.03) for index in range(6)]
    bands = {("top", "odd"): (0.0, 0.0, 1.0, 0.098)}

    dropped = margin_box.drop_furniture_zone_lines(
        [header, *body], parity="odd", bands=bands
    )
    assert header not in dropped and len(dropped) == len(body)

    # 奇偶不对：不动（偶数页页眉位置不同）
    kept = margin_box.drop_furniture_zone_lines([header, *body], parity="even", bands=bands)
    assert header in kept
    # 长行即使在带里也不剔（正文偶尔从页边带开始）
    wide = (0.10, 0.05, 0.90, 0.07)
    assert wide in margin_box.drop_furniture_zone_lines([wide], parity="odd", bands=bands)
    # 没有位置带（没有候选）：原样返回
    assert margin_box.drop_furniture_zone_lines([header, *body], parity="odd", bands=None) == [header, *body]


# ---------------------------------------------------------------- 双栏 / 双页合一取界（2026-11-05）


def test_dual_column_box_covers_both_columns() -> None:
    """真机 H6GXVG p14：长行只在右栏，旧取界 x0≈0.51 把左栏整块扔掉（回目因此进不了正文）。

    有内部栏缝 ⇒ 左右界取两侧最外沿；没有 ⇒ 单栏，行为不变。
    """
    left = [(0.10, 0.12 + i * 0.03, 0.42, 0.14 + i * 0.03) for i in range(6)]
    right = [(0.52, 0.10 + i * 0.03, 0.98, 0.12 + i * 0.03) for i in range(8)]
    assert margin_box.column_gutter(left + right) == (0.42, 0.52)

    dual = margin_box.fit_box_from_lines(left + right)
    assert dual is not None
    assert dual[0] < 0.10 and dual[2] > 0.97, f"左栏没被包进来：{dual}"

    single = margin_box.fit_box_from_lines(right)
    assert single is not None
    assert single[0] > 0.45, f"单栏页被撑宽了：{single}"


def test_gutter_must_be_computed_after_furniture_removal() -> None:
    """顺序判据（真机 p1 / p14）：书眉横跨栏缝时，**剔前没有栏缝、剔后才有**。

    先剔再算这一步没生效的话，双页合一会判成单栏、只框右半。
    """
    header = (0.28, 0.05, 0.72, 0.08)          # 居中书眉，横跨栏缝
    left = [(0.10, 0.15 + i * 0.03, 0.42, 0.17 + i * 0.03) for i in range(6)]
    right = [(0.52, 0.15 + i * 0.03, 0.98, 0.17 + i * 0.03) for i in range(6)]
    assert margin_box.column_gutter([header, *left, *right]) is None
    assert margin_box.column_gutter([*left, *right]) == (0.42, 0.52)


def test_single_column_page_keeps_quantile_edges() -> None:
    """单栏论文（YR5EJ0 全本 0/230 误判）：没有 8% 内部空带的页不许被当成双栏。"""
    lines = [(0.11, 0.10 + i * 0.03, 0.89, 0.12 + i * 0.03) for i in range(12)]
    assert margin_box.column_gutter(lines) is None
    box = margin_box.fit_box_from_lines(lines)
    assert box is not None
    assert 0.07 < box[0] < 0.13 and 0.87 < box[2] < 0.93


def test_edge_narrow_line_cannot_fake_a_column_gutter() -> None:
    """页码/竖排书名这类"窄 + 贴页边"的行不参与栏缝（真机 b2t_5DDDAP p4）。

    真实形态：正文列 x 0.153–0.93，页码贴在左下 x 0.018–0.065。它们之间那条空带
    宽 8.8% ≥ 阈值，于是被判成"栏缝"⇒ 双栏分支把整列页码并进版心，x0 掉到 0.0167。
    修法：`column_gutter` 自己先排掉这种行（不依赖调用方剔干净）。
    """
    body = [(0.153, 0.06 + i * 0.03, 0.93, 0.08 + i * 0.03) for i in range(20)]
    page_number = (0.018, 0.966, 0.065, 0.987)          # 窄（0.047）+ 左下角
    title = (0.027, 0.562, 0.058, 0.690)                # 竖排书名，窄 + 左侧

    assert margin_box._is_edge_narrow(page_number) is True
    assert margin_box._is_edge_narrow(title) is True
    assert margin_box._is_edge_narrow(body[0]) is False, "正文长行不该被当成页边窄行"

    assert margin_box.column_gutter([*body, page_number, title]) is None, "页码不许再伪造栏缝"
    box = margin_box.fit_box_from_lines([*body, page_number, title])
    assert box is not None
    assert 0.13 < box[0] < 0.16, f"x0 应回到正文列（约 0.137），实际 {box[0]}"


def test_edge_narrow_filter_keeps_a_real_two_column_gutter() -> None:
    """别把真双栏也滤掉：两栏行都够宽（>0.2），栏缝照旧。"""
    left = [(0.10, 0.15 + i * 0.03, 0.42, 0.17 + i * 0.03) for i in range(6)]
    right = [(0.52, 0.15 + i * 0.03, 0.98, 0.17 + i * 0.03) for i in range(6)]

    assert margin_box.column_gutter([*left, *right]) == (0.42, 0.52)
