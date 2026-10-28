"""行索引不变式：导出段里的 `line_spans.line_index` 必须还是**原块行索引**。

这是 2026-10-28 DevLead 定位到的真 bug（`outside_stream` 那 5 条的真因）：

- `core/export/project.py::_prepare` 先 `header_cleanup.strip_leading_header_line(raw_lines)`
  把首行页眉（`Page 5`）**从列表里删掉**；
- 再交给 `_join_block` → `join_lines(cleaned)`，`enumerate` 从 0 重新数；
- 于是后面的行整体前移 1：`line_spans.line_index == [0,1]`；
- 而 `reading_marks` 的 `line_index` 用的是**原块行索引** `[1,2]`。

后果分两种（本文件两条都造出来了）：

1. 块内最后一行的索引越界 → 前端查不到行，只能记进 `outside_stream`（实测全书 5 条）；
2. 中间行**错位到别的行** → 差异被画到隔壁行上，还不报错（比越界隐蔽）。

`_join_block` 本身不会删行（见 `tests/unit/test_export_join_line_indices.py` 的绿色用例），
所以这些用例走**真实调用链**：识别 → 导出段 → 标记 → next-lines。

**红过没有**：写这组用例时全红（4 条里 3 条），红因就是上面两条。
修好后它们应当全部转绿，且不需要改用例——断言的都是"索引语义"，不是实现细节。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import executor as executor_module
from book2text.core.project import recognition
from tests.fakes import FakeOcrEngine, FakeSecondEngine

# 首行是页眉（`strip_leading_header_line` 会整行摘掉），后两行是正文。
# 三行行距都很小 → 合成**一个**块，正是"一个块里首行被删"的场景。
PAGE_LINES_WITH_HEADER = (
    ("Page 5", 0.10, 0.13),
    ("aaa bbb", 0.14, 0.17),
    ("ccc ddd", 0.18, 0.21),
)

# 第二引擎的候选：第 0 行照抄（页眉不算差异），第 1、2 行各改一个词 → 两条汉字级差异
SECOND_ENGINE_TEXTS = ["Page 5", "aaa xxx", "ccc yyy"]


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "行索引", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


@pytest.fixture
def page_with_header_line(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, sample_pdf: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> str:
    """一页一个块，块内三行：`Page 5` / `aaa bbb` / `ccc ddd`，后两行各有汉字级差异。"""
    engine = FakeOcrEngine(lines=PAGE_LINES_WITH_HEADER)
    monkeypatch.setattr(recognition, "RapidOcrAdapter", lambda: engine)

    def fake_start(self, directory, job_id):  # noqa: ANN001 - 与 Supervisor.start 同形
        recognition.run_job(directory, job_id, engine=engine)
        return 0

    monkeypatch.setattr(executor_module.Supervisor, "start", fake_start)

    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    recognition.run_auxiliary(
        library_dir / project_id, 1, engine=FakeSecondEngine(SECOND_ENGINE_TEXTS)
    )
    return project_id


def block_payload(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> dict:
    response = client.get(f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers)
    assert response.status_code == 200, response.text
    blocks = response.json()["blocks"]
    assert len(blocks) == 1, f"前提不成立：这一段应当合成一个块，实际 {len(blocks)} 块"
    return blocks[0]


def segments(client: TestClient, headers: dict[str, str], project_id: str) -> list[dict]:
    response = client.post(
        f"/api/projects/{project_id}/export/preview",
        params={"segments_only": 1},
        json={"format": "txt"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()["segments"]


def segment_for_block(segments_payload: list[dict], block_id: str) -> dict:
    matches = [seg for seg in segments_payload if block_id in seg.get("block_ids", [])]
    assert len(matches) == 1, f"应当恰好一段来自这个块，实际 {len(matches)} 段"
    return matches[0]


def marks(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/review/marks", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def next_lines(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.post(f"/api/projects/{project_id}/review/next-lines", json={}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def line_key(item: dict) -> tuple[str, int]:
    return (item["block_id"], item["line_index"])


# ---------------------------------------------------------------- 索引语义

def test_line_spans_keep_original_block_line_index(
    client: TestClient, auth_headers: dict[str, str], page_with_header_line: str
) -> None:
    """`Page 5` 被摘掉后，剩下两行的索引仍应是**原块里的 1 和 2**，不是 0 和 1。"""
    block = block_payload(client, auth_headers, page_with_header_line)
    assert block["text"].split("\n") == ["Page 5", "aaa bbb", "ccc ddd"], (
        f"前提不成立：块文本不是三行，而是 {block['text']!r}"
    )

    segment = segment_for_block(segments(client, auth_headers, page_with_header_line),
                                block["block_id"])
    indices = [span["line_index"] for span in segment["line_spans"]]
    assert indices == [1, 2], (
        "导出段的行索引跟着清理后的列表重新编号了（页眉被删 → 整体前移 1），"
        f"但 marks 用的是原块索引；实际 {indices}，应为 [1, 2]"
    )


def test_span_text_slice_equals_the_line_it_claims(
    client: TestClient, auth_headers: dict[str, str], page_with_header_line: str
) -> None:
    """每个 span 指的那一行，文本必须真的是块里那一行——错位到隔壁行也要抓住。"""
    block = block_payload(client, auth_headers, page_with_header_line)
    source_lines = block["text"].split("\n")
    segment = segment_for_block(segments(client, auth_headers, page_with_header_line),
                                block["block_id"])

    mismatches = []
    for span in segment["line_spans"]:
        index = span["line_index"]
        sliced = segment["text"][span["start"]:span["end"]]
        expected = source_lines[index] if index < len(source_lines) else "<越界>"
        if sliced != expected:
            mismatches.append({"line_index": index, "span_text": sliced, "block_line_text": expected})
    assert not mismatches, f"span 指向的行和它的文本对不上：{mismatches}"


def test_marks_line_index_maps_back_to_the_same_line(
    client: TestClient, auth_headers: dict[str, str], page_with_header_line: str
) -> None:
    """每条汉字级标记的 `line_index` 必须能在导出段里找到**同一行文本**的 span。

    两种坏法都算失败：索引越界（找不到）、索引错位（找到的是别的行）。
    """
    block = block_payload(client, auth_headers, page_with_header_line)
    source_lines = block["text"].split("\n")
    segment = segment_for_block(segments(client, auth_headers, page_with_header_line),
                                block["block_id"])
    span_by_index = {span["line_index"]: span for span in segment["line_spans"]}

    chars_marks = [item for item in marks(client, auth_headers, page_with_header_line)["items"]
                   if item["level"] == "differs_chars"]
    assert len(chars_marks) == 2, f"前提不成立：应有 2 条汉字级差异，实际 {len(chars_marks)}"

    problems = []
    for item in chars_marks:
        span = span_by_index.get(item["line_index"])
        if span is None:
            problems.append({"line_index": item["line_index"], "reason": "索引不在 line_spans 里（越界）"})
            continue
        sliced = segment["text"][span["start"]:span["end"]]
        if sliced != source_lines[item["line_index"]]:
            problems.append({
                "line_index": item["line_index"],
                "reason": "索引指向了别的行",
                "span_text": sliced,
                "block_line_text": source_lines[item["line_index"]],
            })
    assert not problems, f"标记的行索引映射不回同一行：{problems}"


# ---------------------------------------------------------------- 计数不变式

def test_next_lines_accounts_for_every_chars_mark(
    client: TestClient, auth_headers: dict[str, str], page_with_header_line: str
) -> None:
    """`len(lines) + outside_stream.count == chars_unacked`，且越界那条被显式计数。

    这条**现在是绿的**：越界的标记确实被 `outside_stream` 收走了，所以"会不会漏报"
    这层计数是自洽的；坏的是索引语义（上面三条），不是账目。
    """
    payload = next_lines(client, auth_headers, page_with_header_line)
    assert len(payload["lines"]) + payload["outside_stream"]["count"] == payload["chars_unacked"]
    assert payload["chars_unacked"] == 2
    # 越界的那条（原块第 2 行）只能进 outside_stream，前端画不出来
    assert payload["outside_stream"]["count"] == 1
    assert payload["outside_stream"]["sample"][0]["line_index"] == 2
    assert payload["total"] == len(payload["lines"])
