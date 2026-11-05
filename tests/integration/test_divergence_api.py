"""分歧标记的集成测试（说明书 8.5 的 MVP 落点）。

说明书 8.5 要求：**审校视图里有分歧的行高亮、显示另一路候选、点一下即可替换**
（作为对 `text` 的编辑），**疑难筛选增加"有分歧"条件**。

这里的重点是**标记跟着文本走**：标记由后端按"块里现在的文本"与第二引擎的候选现算
（`blocks.block_divergence`），不是照抄识别时写下的 `diff_status`——
所以换掉那一行之后标记要消失，人工改了字之后标记要跟着变化。

另外验证分级：`differs_chars`（汉字 / 数字）与 `differs_punct`（只有标点不同）、
`no_candidate`（第二引擎什么也没读出来）三种情况的计数与归类。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module
from book2text.core.project import recognition
from tests.fakes import FakeOcrEngine, FakeSecondEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "分歧标记", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [page_no], "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def page_blocks(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def page_payload(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["pages"][0]


def patch_block(
    client: TestClient, headers: dict[str, str], project_id: str, block: dict, patch: dict
) -> dict:
    response = client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={**patch, "expected_revision": block["revision"]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


def run_aux(
    library_dir: Path, project_id: str, texts: list[str], page_no: int = 1
) -> dict:
    return recognition.run_auxiliary(
        library_dir / project_id, page_no, engine=FakeSecondEngine(texts)
    )


@pytest.fixture
def recognized_page(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> str:
    """第 1 页已识别（假引擎：2 块 3 行——块 0 两行、块 1 一行）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id)
    return project_id


# ---------------------------------------------------------------- 没有复核过

def test_without_a_check_the_page_reports_not_checked(
    client: TestClient, auth_headers: dict[str, str], recognized_page: str
) -> None:
    """没复核过时 `checked` 为假——不能把"0 分歧"读成"两路一致"。"""
    page = page_payload(client, auth_headers, recognized_page)
    divergence = page["divergence"]
    assert divergence["checked"] is False
    assert divergence["lines"] == 0
    assert divergence["engine_id"] is None

    detail = page_blocks(client, auth_headers, recognized_page)["divergence"]
    assert detail["checked"] is False

    for block in page_blocks(client, auth_headers, recognized_page)["blocks"]:
        assert block["divergence"]["marks"] == []
        assert block["divergence"]["stale"] is False


# ---------------------------------------------------------------- 标记与分级

def test_marks_are_graded_and_attached_to_the_right_lines(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """一行汉字级、一行标点级、一行第二引擎没读出来：三种都要如实分开算。"""
    project_id = recognized_page
    before = blocks_module.list_block_lines(project_id, library=library_dir)
    run_aux(
        library_dir,
        project_id,
        [
            # 第 1 行：第二引擎把"段"读成"叚"（汉字级）
            before[0].text.replace("段", "叚"),
            # 第 2 行：只有标点不同（标点级）
            before[1].text.replace("。", "、"),
            # 第 3 行：什么也没读出来（不算分歧）
            "",
        ],
    )

    detail = page_blocks(client, auth_headers, project_id)
    block0, block1 = detail["blocks"]
    assert block0["divergence"]["chars"] == 1
    assert block0["divergence"]["punct"] == 1
    assert block0["divergence"]["lines"] == 2, "分歧行 = 汉字级 + 标点级"
    assert block0["diff_line_count"] == 2
    assert [
        (mark["line_index"], mark["level"]) for mark in block0["divergence"]["marks"]
    ] == [(0, "differs_chars"), (1, "differs_punct")]
    assert block0["divergence"]["marks"][0]["candidate"] == before[0].text.replace("段", "叚")

    assert block1["divergence"]["chars"] == 0
    assert block1["divergence"]["empty"] == 1, "第二引擎没读出来单独计数"
    assert block1["divergence"]["lines"] == 0
    assert block1["divergence"]["marks"][0]["candidate"] == ""

    # 页面级汇总是各块之和 + 复核记录
    assert detail["divergence"] == {
        "lines": 2,
        "identical": 0,
        "chars": 1,
        "punct": 1,
        "empty": 1,
        "format_only": 0,
        "acked": 0,
        "stale_blocks": 0,
        "checked": True,
        # 2026-11-05 假干净 bug：三态里的「需重算」与 stale（行结构对不上）是两个语义
        "needs_recheck": False,
        "engine_id": "fake-second",
        "checked_at": detail["divergence"]["checked_at"],
    }
    assert detail["divergence"]["checked_at"]


def test_page_payload_carries_divergence_for_the_triage_filter(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """说明书 8.5：疑难筛选要能按"有分歧"筛页——页面载荷就得带上这个数。"""
    project_id = recognized_page
    before = blocks_module.list_block_lines(project_id, library=library_dir)
    run_aux(
        library_dir,
        project_id,
        [before[0].text.replace("段", "叚"), before[1].text, before[2].text],
    )

    page = page_payload(client, auth_headers, project_id)
    assert page["divergence"]["checked"] is True
    assert page["divergence"]["chars"] == 1, "汉字级分歧：按它筛才是有意义的"
    assert page["divergence"]["lines"] == 1


# ---------------------------------------------------------------- 标记跟着文本走

def test_adopting_the_other_engine_clears_that_mark(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """说明书 8.5：点一下即可替换为另一路文本——替换之后这一行的标记消失。"""
    project_id = recognized_page
    before = blocks_module.list_block_lines(project_id, library=library_dir)
    candidate = before[0].text.replace("段", "叚")
    run_aux(library_dir, project_id, [candidate, before[1].text, before[2].text])

    block0 = page_blocks(client, auth_headers, project_id)["blocks"][0]
    assert block0["divergence"]["chars"] == 1

    # 界面上的"换成这一路"就是一次普通的改块（说明书 8.5：作为对 text 的编辑）
    lines = block0["text"].split("\n")
    lines[0] = candidate
    patch_block(client, auth_headers, project_id, block0, {"text": "\n".join(lines)})

    after = page_blocks(client, auth_headers, project_id)
    assert after["blocks"][0]["divergence"]["lines"] == 0, "换过去之后不该再标"
    assert after["blocks"][0]["divergence"]["marks"] == []
    assert after["divergence"]["lines"] == 0
    assert page_payload(client, auth_headers, project_id)["divergence"]["chars"] == 0


def test_editing_the_line_changes_the_mark(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """人工把字改对（而不是采用另一路）也要让标记跟着变——标记按当前文本算。"""
    project_id = recognized_page
    before = blocks_module.list_block_lines(project_id, library=library_dir)
    run_aux(library_dir, project_id, [before[0].text.replace("段", "叚")] + [b.text for b in before[1:]])

    block0 = page_blocks(client, auth_headers, project_id)["blocks"][0]
    assert block0["divergence"]["marks"][0]["level"] == "differs_chars"

    # 人工把第一行改成"只差标点"的样子：分歧从汉字级降为标点级
    lines = block0["text"].split("\n")
    lines[0] = before[0].text.replace("段", "叚").replace("。", "、")
    patch_block(client, auth_headers, project_id, block0, {"text": "\n".join(lines)})

    after = page_blocks(client, auth_headers, project_id)["blocks"][0]
    mark = next(m for m in after["divergence"]["marks"] if m["line_index"] == 0)
    assert mark["level"] == "differs_punct"
    assert mark["candidate"] == before[0].text.replace("段", "叚")
    assert after["divergence"]["chars"] == 0
    assert after["divergence"]["punct"] == 1


def test_line_structure_change_hides_marking_instead_of_pointing_at_the_wrong_line(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """人工在块里加了换行：行号对不上，宁可不标（`stale`）也不指错地方。"""
    project_id = recognized_page
    before = blocks_module.list_block_lines(project_id, library=library_dir)
    run_aux(library_dir, project_id, [before[0].text.replace("段", "叚")] + [b.text for b in before[1:]])

    block0 = page_blocks(client, auth_headers, project_id)["blocks"][0]
    assert block0["divergence"]["lines"] >= 1

    patch_block(client, auth_headers, project_id, block0, {"text": block0["text"].replace("\n", "\n\n")})

    after = page_blocks(client, auth_headers, project_id)
    assert after["blocks"][0]["divergence"]["stale"] is True
    assert after["blocks"][0]["divergence"]["marks"] == []
    assert after["blocks"][0]["divergence"]["lines"] == 0
    # 页面级把它记成"结构改过的块"，而不是悄悄算成 0 分歧
    assert after["divergence"]["stale_blocks"] == 1


def test_split_clears_the_divergence_info_of_the_cut_line(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """被从中间切开的那一行清空**分歧信息**；坐标按切点一分为二（任务 49）。

    第二引擎读的是原来那一整行，两个半边都不再对应它——所以两边的候选都要清掉，
    但坐标保留（否则多出一条"没有坐标的行"）。
    """
    project_id = recognized_page
    before = blocks_module.list_block_lines(project_id, library=library_dir)
    run_aux(library_dir, project_id, [before[0].text.replace("段", "叚")] + [b.text for b in before[1:]])
    after_aux = blocks_module.list_block_lines(project_id, library=library_dir)
    assert after_aux[0].aux_text, "先确认复核结果确实写进去了"

    block0 = page_blocks(client, auth_headers, project_id)["blocks"][0]
    offset = 3  # 切在"第一段"中间
    response = client.post(
        f"/api/projects/{project_id}/blocks/{block0['block_id']}/split",
        json={"offset": offset},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text

    lines = blocks_module.list_block_lines(project_id, library=library_dir)
    cut = lines[0]
    assert cut.bbox is not None, "切开的行留着左半边的坐标"
    assert cut.text == "第一段"
    assert cut.aux_text is None, "切开的那一行不再对应任何一整行，候选也要清掉"
    assert cut.diff_status is None
    # 后半条是新的行记录（属于新块），同样没有候选
    split_tail = lines[1]
    assert split_tail.bbox is not None
    assert split_tail.block_id != cut.block_id
    assert split_tail.text == "第一行。"
    assert split_tail.aux_text is None
    assert split_tail.line_index == 0
    # 后面的行跟着搬到新块，候选与行号都还在（它们还是完整的行）
    moved = lines[2]
    assert moved.aux_text is not None
    assert moved.block_id == split_tail.block_id
    assert moved.line_index == 1, "搬过去的行在新块里重新编号"


def test_divergence_counts_are_added_up_across_pages(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """`page_divergences` 是页面列表的供数口：一次给出每一页的分歧概况。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    recognize(client, auth_headers, project_id, 2)

    payload = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()
    pages = {page["page_no"]: page for page in payload["pages"]}
    assert pages[1]["divergence"]["checked"] is False
    assert pages[2]["divergence"]["checked"] is False

    lines = blocks_module.list_block_lines(project_id, library=library_dir, page_no=2)
    run_aux(
        library_dir,
        project_id,
        [lines[0].text.replace("段", "叚")] + [line.text for line in lines[1:]],
        page_no=2,
    )

    divergences = blocks_module.page_divergences(project_id, library=library_dir)
    page_ids = {page["page_no"]: page["page_id"] for page in payload["pages"]}
    assert divergences[page_ids[1]].checked is False
    assert divergences[page_ids[2]].checked is True
    assert divergences[page_ids[2]].chars == 1, "第 2 页只有第一行是汉字级分歧"
    assert divergences[page_ids[1]].chars == 0


def test_recheck_state_has_one_implementation_on_all_three_paths(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """2026-11-05 假干净 bug：三条路径必须给同一组 (checked, needs_recheck)。

    识别前复核过 ⇒ checked。**再识别一次**之后，旧复核比新文本旧 ⇒ 两条都为假、
    needs_recheck 为真。路由（page_divergence_summary）/ 索引 / review_status / stats
    以前各算各的（其中一处只看"有没有 aux run"），重识别后仍报"已复核 + 0 差异"。
    """
    from book2text.core.project import review_status, stats

    project_id = recognized_page
    run_aux(library_dir, project_id, ["段", "。", ""])

    first = page_blocks(client, auth_headers, project_id)["divergence"]
    assert (first["checked"], first["needs_recheck"]) == (True, False)

    # 重识别同一页：新的 primary run 比 aux 晚，行也不再带 aux_text
    recognize(client, auth_headers, project_id)

    route = page_blocks(client, auth_headers, project_id)["divergence"]
    page_id = blocks_module.list_pages(project_id, library=library_dir)[0].page_id
    index_state = blocks_module.divergence_index(
        project_id, library=library_dir
    ).by_page[page_id]
    finish = review_status.finish_summary(project_id, library=library_dir)["engine"]
    summary = stats.project_summary(project_id, library=library_dir).divergence

    # 三条路径同一组值：过期复核不算已复核，也不是"未复核"，而是"需重算"
    assert (route["checked"], route["needs_recheck"]) == (False, True)
    assert (index_state.checked, index_state.needs_recheck) == (False, True)
    assert finish["checked"] == 0
    assert finish["needs_recheck"] == 1
    assert summary.checked_pages == 0
    assert summary.needs_recheck_pages == 1
    # 谎报要消失：计数仍可能是 0，但要和"需重算"一起出现，不能单独报"0 差异"
    assert route["lines"] == 0
    assert finish["needs_recheck_pages"]


def test_stats_three_states_sum_to_body_pages(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """三态相加 = 正文页数（未复核 + 需重算 + 已复核有效）。"""
    from book2text.core.project import stats

    project_id = recognized_page
    summary = stats.project_summary(project_id, library=library_dir).divergence
    assert (
        summary.checked_pages + summary.needs_recheck_pages + summary.unchecked_pages
        == summary.body_pages
    )
    assert summary.unchecked_pages == summary.body_pages  # 还没复核

    run_aux(library_dir, project_id, ["段", "。", ""])
    summary = stats.project_summary(project_id, library=library_dir).divergence
    assert summary.checked_pages == 1
    assert (
        summary.checked_pages + summary.needs_recheck_pages + summary.unchecked_pages
        == summary.body_pages
    )
