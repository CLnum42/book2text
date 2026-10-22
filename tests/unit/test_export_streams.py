"""注释流与元数据的规则测试（第 37 号任务）。"""

from __future__ import annotations

from types import SimpleNamespace

from book2text.core.export import streams


def block(block_id, page_no, order, block_type, text, *, include=True, review="unreviewed", bbox=None):
    return SimpleNamespace(
        block_id=block_id,
        page_no=page_no,
        order_index=order,
        block_type=block_type,
        text=text,
        include=include,
        review_status=review,
        bbox=bbox,
    )


def test_printed_page_uses_page_number_block() -> None:
    value, source, candidates = streams.extract_printed_page(
        [block("b1", 1, 0, "page_number", "· 63 ·")]
    )
    assert value == "63"
    assert source == "page_number"
    assert candidates[0]["block_id"] == "b1"


def test_printed_page_accepts_roman_header() -> None:
    value, source, _ = streams.extract_printed_page(
        [block("b1", 1, 0, "header", "- iv -")]
    )
    assert value == "IV"
    assert source == "header"


def test_conflicting_candidates_return_null_not_a_guess() -> None:
    value, source, candidates = streams.extract_printed_page(
        [
            block("b1", 1, 0, "page_number", "63"),
            block("b2", 1, 1, "page_number", "64"),
        ]
    )
    assert value is None
    assert source is None
    assert [item["value"] for item in candidates] == ["63", "64"]


def test_page_label_alone_is_not_used_as_printed_page() -> None:
    value, source, _ = streams.extract_printed_page([])
    assert value is None
    assert source is None


def test_note_without_any_preceding_body_is_unlocated() -> None:
    notes = streams.build_notes(
        [block("n1", 1, 0, "footnote", "校注：此页只有注释。")],
        [],
        text_for_block=lambda item: item.text,
    )
    assert len(notes) == 1
    assert notes[0].located is False
    assert "未定位" in streams.render_notes_txt(notes)
    assert notes[0].to_dict()["reference"]["status"] == "unlocated"


def test_note_reference_points_at_nearest_previous_body_block() -> None:
    segments = [
        SimpleNamespace(segment_id="seg1", block_ids=["b1"]),
        SimpleNamespace(segment_id="seg2", block_ids=["b2"]),
    ]
    notes = streams.build_notes(
        [
            block("b1", 1, 0, "paragraph", "前一段"),
            block("b2", 1, 1, "paragraph", "就在注释前"),
            block("n1", 1, 2, "footnote", "注释正文"),
        ],
        segments,
        text_for_block=lambda item: item.text,
    )
    assert notes[0].reference_block_id == "b2"
    assert notes[0].reference_segment_id == "seg2"


def test_notes_jsonl_is_one_record_per_line() -> None:
    notes = [
        streams.NoteEntry(1, 1, "b1", "注一", None, None, None, False),
        streams.NoteEntry(2, 2, "b2", "注二", 2, "p2", "seg2", True),
    ]
    lines = streams.render_notes_jsonl(notes).strip().splitlines()
    assert len(lines) == 2
    assert '"schema":"book2text.note.v1"' in lines[0]
