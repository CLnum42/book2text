"""纯标点 / 空格差异：按模式分组批量裁决（任务 61）。

用户现场（《红楼梦》3）：1676 条差异行里 710 行只差标点 / 空格，归成 64 种模式；
`；→，` 一种 293 行，`∅→‘` 119 行（RapidOCR 系统性地吞掉开头引号）。
逐条点这 710 行是纯体力活，而"全部采用候选"能一次修掉几百处真错。

这里钉住四件事：

1. 模式按**差异片段**分组，不是整行文本（否则 710 行 = 710 种"模式"）；
2. 采用 = 真的改文本（不是只写 ack），保留 = 只写 ack；
3. 一组一个 batch：撤销一次全退，数字回到原值；
4. 主队列只放含汉字差异——`review/marks` 给标点行带 `pattern_key`。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module
from book2text.core.project import punct_groups
from book2text.core.project import recognition
from tests.fakes import FakeOcrEngine, FakeSecondEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "标点分组", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def run_aux(library_dir: Path, project_id: str, texts: list[str]) -> None:
    recognition.run_auxiliary(
        library_dir / project_id, 1, engine=FakeSecondEngine(texts)
    )


@pytest.fixture
def punct_project(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> str:
    """第 1 页已识别 + 第二引擎复核：第 2 行只有标点不同（全角句号 → 顿号）。

    假引擎的两块三行：块 0 两行、块 1 一行；这里让第 2 行变成"标点级"差异，
    并把候选里的标点换回原样，用来验证"采用候选"确实写进了文本。
    """
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    lines = blocks_module.list_block_lines(project_id, library=library_dir)
    texts = [line.text for line in lines]
    texts[1] = texts[1].replace("。", "、")
    run_aux(library_dir, project_id, texts)
    return project_id


# ---------------------------------------------------------------- 纯函数

def test_fragments_finds_the_changed_segments_only() -> None:
    assert punct_groups.fragments("一盏；然后便至", "一盏，然后便至") == [("；", "，")]


def test_fragments_handles_insertion_and_repeats() -> None:
    # 原文少一个单引号，候选多一个（`∅→‘`）
    assert punct_groups.fragments("原是秘制的", "‘原是秘制的") == [("", "‘")]
    # 同一行里同样的改动出现两次，仍然只是一种片段
    assert punct_groups.fragments("甲；乙；丙", "甲，乙，丙") == [("；", "，")]


def test_pattern_key_names_the_empty_side_and_spaces() -> None:
    assert punct_groups.pattern_key([("；", "，")]) == "；→，"
    assert punct_groups.pattern_key([("", "‘")]) == "∅→‘"
    assert punct_groups.pattern_key([("", " ")]) == "∅→␣"
    assert punct_groups.pattern_key([("；", "，"), ("", "—")]) == "；→，|∅→—"


# ---------------------------------------------------------------- 分组

def test_groups_list_patterns_with_samples(
    client: TestClient, auth_headers: dict[str, str], punct_project: str
) -> None:
    data = client.get(
        f"/api/projects/{punct_project}/review/punct-groups", headers=auth_headers
    ).json()

    assert data["totals"]["groups"] >= 1
    assert data["totals"]["lines"] == data["totals"]["undecided_lines"]
    group = next(item for item in data["groups"] if item["pattern"] == "。→、")
    assert group["count"] == 1
    assert group["undecided"] == 1
    assert group["decided"] is False
    assert len(group["samples"]) == 1
    sample = group["samples"][0]
    assert "。" in sample["text"] and "、" in sample["candidate_text"]
    assert sample["page_no"] == 1


def test_marks_carry_pattern_key_only_for_punct(
    client: TestClient, auth_headers: dict[str, str], punct_project: str
) -> None:
    """主队列靠 `pattern_key` 把标点行分流到面板，汉字行不受影响。"""
    data = client.get(
        f"/api/projects/{punct_project}/review/marks", headers=auth_headers
    ).json()
    punct = [item for item in data["items"] if item["level"] == "differs_punct"]
    chars = [item for item in data["items"] if item["level"] == "differs_chars"]
    assert punct and punct[0]["pattern_key"] == "。→、"
    assert all(item["pattern_key"] for item in punct)
    assert all(item["pattern_key"] is None for item in chars)


# ---------------------------------------------------------------- 裁决

def test_adopt_rewrites_the_line_and_shrinks_the_group(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, punct_project: str
) -> None:
    before = client.get(
        f"/api/projects/{punct_project}/review/punct-groups", headers=auth_headers
    ).json()

    applied = client.post(
        f"/api/projects/{punct_project}/review/punct-groups/decide",
        json={"key": "。→、", "ack": "adopted"},
        headers=auth_headers,
    )

    assert applied.status_code == 200, applied.text
    assert applied.json()["applied"] == 1
    assert applied.json()["history"]["undo"] == 1
    # 文本真的换了（block.text 是编辑后的正文；block_line.text 是识别原文，不跟着改）
    texts = [block.text for block in blocks_module.list_blocks(punct_project, library=library_dir)]
    assert any("、" in text for text in texts)
    after = client.get(
        f"/api/projects/{punct_project}/review/punct-groups", headers=auth_headers
    ).json()
    assert after["totals"]["undecided_lines"] == before["totals"]["undecided_lines"] - 1
    assert all(item["pattern"] != "。→、" for item in after["groups"])


def test_keep_only_acks_without_touching_text(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, punct_project: str
) -> None:
    before = [
        block.text for block in blocks_module.list_blocks(punct_project, library=library_dir)
    ]

    applied = client.post(
        f"/api/projects/{punct_project}/review/punct-groups/decide",
        json={"key": "。→、", "ack": "kept"},
        headers=auth_headers,
    )

    assert applied.status_code == 200, applied.text
    after = [
        block.text for block in blocks_module.list_blocks(punct_project, library=library_dir)
    ]
    assert before == after, "保留原文不能改文本"
    groups = client.get(
        f"/api/projects/{punct_project}/review/punct-groups", headers=auth_headers
    ).json()["groups"]
    # 判过的组仍留在面板里（灰掉、可撤销），但未判数归零
    group = next(item for item in groups if item["pattern"] == "。→、")
    assert group["undecided"] == 0
    assert group["decided"] is True
    assert group["kept"] == 1


def test_undo_restores_both_text_and_counts(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, punct_project: str
) -> None:
    before_lines = [
        block.text for block in blocks_module.list_blocks(punct_project, library=library_dir)
    ]
    before = client.get(
        f"/api/projects/{punct_project}/review/punct-groups", headers=auth_headers
    ).json()["totals"]
    client.post(
        f"/api/projects/{punct_project}/review/punct-groups/decide",
        json={"key": "。→、", "ack": "adopted"},
        headers=auth_headers,
    )

    undone = client.post(f"/api/projects/{punct_project}/undo", headers=auth_headers)

    assert undone.status_code == 200, undone.text
    after_lines = [
        block.text for block in blocks_module.list_blocks(punct_project, library=library_dir)
    ]
    assert before_lines == after_lines
    after = client.get(
        f"/api/projects/{punct_project}/review/punct-groups", headers=auth_headers
    ).json()["totals"]
    assert after == before


def test_deciding_an_empty_pattern_is_reported(
    client: TestClient, auth_headers: dict[str, str], punct_project: str
) -> None:
    response = client.post(
        f"/api/projects/{punct_project}/review/punct-groups/decide",
        json={"key": "；→，", "ack": "adopted"},
        headers=auth_headers,
    )

    assert response.status_code == 400
    assert "没有待裁决" in response.json()["error"]["detail"]
