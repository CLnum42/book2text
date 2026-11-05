"""字级差异的写路径与行级 ack（第十一轮，验收 11 / 12）。

后端这一层测的是"数据算得对不对、写进去的是不是只那一处"：
前端那一份（`tests/js/line-diff-view.test.mjs`）测的是"这些数据画到哪儿去了"——
失败模式不同，两份都要有。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module
from book2text.core.project import recognition
from tests.fakes import FakeOcrEngine, FakeSecondEngine


def make_project(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    *,
    target_line: int = 0,
    mutate,
) -> tuple[str, str, str]:
    """识别第 1 页 + 第二引擎复核：把第 `target_line` 行按 `mutate` 改造成候选。

    返回 (project_id, block_id, 原文行文本)。
    """
    response = client.post(
        "/api/projects",
        params={"name": "字级 diff", "filename": sample_pdf.name},
        content=sample_pdf.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    project_id = response.json()["project"]["project_id"]
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text

    lines = blocks_module.list_block_lines(project_id, library=library_dir)
    assert len(lines) > target_line
    texts = [line.text for line in lines]
    original = texts[target_line]
    texts[target_line] = mutate(original)
    recognition.run_auxiliary(
        library_dir / project_id, 1, engine=FakeSecondEngine(texts)
    )
    return project_id, lines[target_line].block_id, original


def two_spots(text: str) -> str:
    """把第 2 个字与第 4 个字换掉 ⇒ 两处、彼此隔一个字。"""
    chars = list(text)
    for index, mark in ((1, "★"), (3, "◆")):
        chars[index] = mark if chars[index] != mark else "☆"
    return "".join(chars)


def one_spot(text: str) -> str:
    chars = list(text)
    chars[1] = "★" if chars[1] != "★" else "☆"
    return "".join(chars)


def line_diff(client: TestClient, headers, project_id: str, block_id: str, line_index: int) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/review/line-diff",
        params={"block_id": block_id, "line_index": line_index},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def decide(client: TestClient, headers, project_id: str, block_id: str, body: dict) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/review/line-diff/decide",
        json={"block_id": block_id, "line_index": 0, **body},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def stored_line(project_id: str, block_id: str, library_dir: Path, line_index: int = 0):
    for item in blocks_module.list_block_lines(project_id, library=library_dir, block_id=block_id):
        if item.line_index == line_index:
            return item
    raise AssertionError("找不到这一行")


@pytest.fixture
def two_spot_project(client, auth_headers, library_dir, sample_pdf, inprocess_jobs):
    return make_project(
        client, auth_headers, library_dir, sample_pdf, target_line=0, mutate=two_spots
    )


def test_line_diff_payload_shape(two_spot_project, client, auth_headers) -> None:
    project_id, block_id, original = two_spot_project
    payload = line_diff(client, auth_headers, project_id, block_id, 0)

    assert payload["line_text"] == original
    assert payload["candidate_text"] == two_spots(original)
    assert len(payload["runs"]) == 2, "两处应当是两段 run，不是一段"
    first = payload["runs"][0]
    assert first["kind"] == "replace"
    assert first["from"] == original[1]
    assert first["to"] == two_spots(original)[1]
    assert first["bbox"], "有字框时 bbox 不许为空"
    assert isinstance(first["box_indices"], list)


def test_adopt_one_spot_keeps_the_other_and_writes_no_ack(
    two_spot_project, client, auth_headers, library_dir: Path
) -> None:
    """验收 11：一行两处、只采用第一处 ⇒ 第二处仍在、行 ack 未写（未判完）。"""
    project_id, block_id, original = two_spot_project
    payload = line_diff(client, auth_headers, project_id, block_id, 0)
    first, second = payload["runs"]

    result = decide(
        client,
        auth_headers,
        project_id,
        block_id,
        {
            "action": "adopt",
            "a_start": first["a_start"],
            "a_end": first["a_end"],
            "b_start": first["b_start"],
            "b_end": first["b_end"],
            "expected_line_text": original,
            "judged": [],
        },
    )

    assert result["remaining"] == 1
    assert result["ack"] is None, "还有一处没判，不许写行级 ack"
    assert result["line_text"] == original[:1] + two_spots(original)[1] + original[2:]
    assert result["runs"][0]["a_start"] == second["a_start"] - 0  # 第二处仍在原位置（等长替换）

    line = stored_line(project_id, block_id, library_dir)
    assert line.diff_ack is None
    assert line.text == result["line_text"], "行文本要和块文本一起改（否则显示 ≠ 导出）"


def test_adopt_last_spot_writes_adopted_immediately(
    client, auth_headers, library_dir, sample_pdf, inprocess_jobs
) -> None:
    """验收 12：一行一处、采用后文本 == 候选 ⇒ 立刻写 ack='adopted'。"""
    project_id, block_id, original = make_project(
        client, auth_headers, library_dir, sample_pdf, target_line=0, mutate=one_spot
    )
    payload = line_diff(client, auth_headers, project_id, block_id, 0)
    assert len(payload["runs"]) == 1
    run = payload["runs"][0]

    result = decide(
        client,
        auth_headers,
        project_id,
        block_id,
        {
            "action": "adopt",
            "a_start": run["a_start"],
            "a_end": run["a_end"],
            "b_start": run["b_start"],
            "b_end": run["b_end"],
            "expected_line_text": original,
            "judged": [],
        },
    )

    assert result["remaining"] == 0
    assert result["ack"] == "adopted"
    assert result["line_text"] == one_spot(original)
    assert stored_line(project_id, block_id, library_dir).diff_ack == "adopted"


def test_keep_last_spot_writes_kept(
    client, auth_headers, library_dir, sample_pdf, inprocess_jobs
) -> None:
    """最后这一处选"保留" ⇒ ack='kept'（判完了，但仍与候选不同）。"""
    project_id, block_id, original = make_project(
        client, auth_headers, library_dir, sample_pdf, target_line=0, mutate=one_spot
    )
    payload = line_diff(client, auth_headers, project_id, block_id, 0)
    run = payload["runs"][0]

    result = decide(
        client,
        auth_headers,
        project_id,
        block_id,
        {
            "action": "keep",
            "a_start": run["a_start"],
            "a_end": run["a_end"],
            "b_start": run["b_start"],
            "b_end": run["b_end"],
            "expected_line_text": original,
            "judged": [],
        },
    )

    assert result["remaining"] == 0
    assert result["ack"] == "kept"
    assert result["line_text"] == original, "保留不许改文本"
    assert stored_line(project_id, block_id, library_dir).diff_ack == "kept"


def test_keep_first_of_two_does_not_finish_the_line(two_spot_project, client, auth_headers) -> None:
    project_id, block_id, original = two_spot_project
    payload = line_diff(client, auth_headers, project_id, block_id, 0)
    first = payload["runs"][0]

    result = decide(
        client,
        auth_headers,
        project_id,
        block_id,
        {
            "action": "keep",
            "a_start": first["a_start"],
            "a_end": first["a_end"],
            "b_start": first["b_start"],
            "b_end": first["b_end"],
            "expected_line_text": original,
            "judged": [],
        },
    )

    assert result["remaining"] == 1, "只判了一处，另一处还在"
    assert result["ack"] is None

    # 第二次把剩下的那处也判完（judged 带上第一处）⇒ 才写 ack
    second = result["runs"][0]
    done = decide(
        client,
        auth_headers,
        project_id,
        block_id,
        {
            "action": "keep",
            "a_start": second["a_start"],
            "a_end": second["a_end"],
            "b_start": second["b_start"],
            "b_end": second["b_end"],
            "expected_line_text": original,
            "judged": [first["a_start"]],
        },
    )
    assert done["remaining"] == 0
    assert done["ack"] == "kept"


def test_stale_line_text_is_rejected(two_spot_project, client, auth_headers) -> None:
    """乐观锁：调用方手里的行文本过期就拒绝，不静默覆盖。"""
    project_id, block_id, original = two_spot_project
    payload = line_diff(client, auth_headers, project_id, block_id, 0)
    run = payload["runs"][0]

    response = client.post(
        f"/api/projects/{project_id}/review/line-diff/decide",
        json={
            "block_id": block_id,
            "line_index": 0,
            "action": "adopt",
            "a_start": run["a_start"],
            "a_end": run["a_end"],
            "b_start": run["b_start"],
            "b_end": run["b_end"],
            "expected_line_text": original + "（旧）",
            "judged": [],
        },
        headers=auth_headers,
    )
    assert response.status_code in (400, 409)
    assert "刷新" in response.json()["error"]["detail"]


def test_adopted_run_disappears_after_adoption(two_spot_project, client, auth_headers) -> None:
    """采用过的那一处不该再出现（否则同一处能被判两次）。"""
    project_id, block_id, original = two_spot_project
    payload = line_diff(client, auth_headers, project_id, block_id, 0)
    first = payload["runs"][0]
    decide(
        client,
        auth_headers,
        project_id,
        block_id,
        {
            "action": "adopt",
            "a_start": first["a_start"],
            "a_end": first["a_end"],
            "b_start": first["b_start"],
            "b_end": first["b_end"],
            "expected_line_text": original,
        },
    )
    after = line_diff(client, auth_headers, project_id, block_id, 0)
    assert len(after["runs"]) == 1
    assert after["runs"][0]["a_start"] == payload["runs"][1]["a_start"]


def test_page_runs_come_back_in_one_call(two_spot_project, client, auth_headers) -> None:
    """页面级 runs：一次取一页，供红字与色块同步渲染用。"""
    project_id, block_id, original = two_spot_project
    response = client.get(
        f"/api/projects/{project_id}/review/line-runs",
        params={"page": 1},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["page_no"] == 1
    mine = [
        item
        for item in payload["items"]
        if item["block_id"] == block_id and item["line_index"] == 0
    ]
    assert len(mine) == 1
    assert len(mine[0]["runs"]) == 2
    assert mine[0]["level"] == "differs_chars"
    assert all("box_indices" in run for run in mine[0]["runs"])
