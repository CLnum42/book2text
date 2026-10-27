"""字框回填的行配对（任务 59）：文本相似度为主，IoU 验证，配不上不硬塞。"""

from __future__ import annotations

from book2text.core.project.word_boxes import CandidateLine, match_lines


def cand(text: str, y0: float, x0: float = 0.1, x1: float = 0.9) -> CandidateLine:
    return CandidateLine(
        text=text,
        bbox=(x0, y0, x1, y0 + 0.02),
        words=tuple((ch, (x0, y0, x1, y0 + 0.02), None) for ch in text),
    )


def row(text: str, y0: float) -> dict:
    return {"text": text, "bbox": (0.1, y0, 0.9, y0 + 0.02)}


def test_matches_by_text_and_position() -> None:
    rows = [row("第一行", 0.10), row("第二行", 0.13)]
    cands = [cand("第一行", 0.10), cand("第二行", 0.13)]

    pairs = match_lines(rows, cands)

    assert pairs[0].text == "第一行"
    assert pairs[1].text == "第二行"


def test_does_not_force_a_match_when_text_and_position_disagree() -> None:
    rows = [row("完全不同的内容", 0.10)]
    cands = [cand("another sentence", 0.60)]

    assert match_lines(rows, cands) == {}


def test_extra_candidate_lines_do_not_shift_the_rest() -> None:
    rows = [row("第一行", 0.10), row("第二行", 0.13)]
    cands = [cand("页眉", 0.02), cand("第一行", 0.10), cand("第二行", 0.13)]

    pairs = match_lines(rows, cands)

    assert pairs[0].text == "第一行"
    assert pairs[1].text == "第二行"
