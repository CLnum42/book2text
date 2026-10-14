"""页眉页脚批量标注的集成测试（说明书 6.5）。

规则是位置的（顶部 / 底部区域）+ 文本条件（数字形态、字数上限）；
流程是**预览 → 人工确认 → 一次批量应用**，整批可撤销，
而且**已被人工改过类型的块不会被覆盖**（靠事件表判定）。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import structure
from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "结构工具", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, *pages: int) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": list(pages), "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def add_block(
    library_dir: Path,
    project_id: str,
    *,
    page_no: int,
    text: str,
    bbox: list[float],
    block_type: str = "paragraph",
) -> str:
    """直接往库里塞一个块：造出"页眉""页码"这类真实书页上才有的东西。"""
    from book2text.core.storage.ulid import new_ulid

    block_id = new_ulid()
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        page = conn.execute("SELECT page_id FROM page WHERE page_no = ?", (page_no,)).fetchone()
        order = conn.execute(
            "SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM block WHERE page_id = ?",
            (page["page_id"],),
        ).fetchone()["next"]
        conn.execute(
            """
            INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,
                               ocr_text, text, review_status, include, continues_to_next,
                               revision, created_at, updated_at)
            VALUES (?, ?, 'ocr', ?, ?, ?, ?, ?, 'unreviewed', 1, 0, 0, ?, ?)
            """,
            (
                block_id,
                page["page_id"],
                order,
                str(bbox).replace("'", '"'),
                block_type,
                text,
                text,
                "2026-01-01T00:00:00+00:00",
                "2026-01-01T00:00:00+00:00",
            ),
        )
        conn.commit()
    return block_id


def preview(client: TestClient, headers: dict[str, str], project_id: str, **rules):
    return client.post(
        f"/api/projects/{project_id}/structure/header-footer/preview",
        json=rules,
        headers=headers,
    )


def apply(client: TestClient, headers: dict[str, str], project_id: str, items: list[dict]):
    return client.post(
        f"/api/projects/{project_id}/structure/header-footer/apply",
        json={"items": items},
        headers=headers,
    )


@pytest.fixture
def page_with_chrome(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> tuple[str, dict[str, str]]:
    """第 1 页上做出三样东西：页眉、页码、正文。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)

    header = add_block(
        library_dir, project_id, page_no=1, text="第三章 · 历史的写法", bbox=[0.1, 0.02, 0.9, 0.05]
    )
    number = add_block(
        library_dir, project_id, page_no=1, text="· 62 ·", bbox=[0.45, 0.96, 0.55, 0.98]
    )
    long_paragraph = add_block(
        library_dir, project_id,
        page_no=1,
        text="这是一段很长的正文，它整块落在页面顶部区域里但它显然是正文不是页眉。",
        bbox=[0.1, 0.01, 0.9, 0.07],
    )
    return project_id, {"header": header, "number": number, "long": long_paragraph}


# ---------------------------------------------------------------- 数字判定

@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("62", True),
        ("· 62 ·", True),
        ("- iv -", True),
        ("IV", True),
        ("[12]", True),
        ("第三章", False),
        ("红楼梦/00000", False),
        ("第一段第一行。", False),
        ("", False),
        ("iv 是罗马数字但这里还有别的字", False),
    ],
)
def test_number_detection(text: str, expected: bool) -> None:
    assert structure.looks_like_a_number(text) is expected


# ---------------------------------------------------------------- 预览

def test_preview_proposes_types_by_region(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    project_id, ids = page_with_chrome
    data = preview(client, auth_headers, project_id).json()

    by_block = {item["block_id"]: item for item in data["candidates"]}
    assert ids["header"] in by_block
    assert by_block[ids["header"]]["proposed_type"] == "header"
    assert by_block[ids["header"]]["region"] == "top"
    assert ids["number"] in by_block
    assert by_block[ids["number"]]["proposed_type"] == "page_number"
    assert by_block[ids["number"]]["region"] == "bottom"
    assert data["candidate_count"] == 2
    assert data["by_type"] == {"header": 1, "page_number": 1}
    assert data["pages_scanned"] == 3, "样例 PDF 三页都是正文页（都在作用范围里）"
    assert data["sample_pages"] == [1]


def test_preview_skips_long_blocks(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    """字数条件：区域里的长段落不算页眉（说明书 6.5 的"字数少于 N"）。"""
    project_id, ids = page_with_chrome
    data = preview(client, auth_headers, project_id).json()

    skipped = {item["block_id"]: item for item in data["skipped"]}
    assert ids["long"] in skipped
    assert "字数" in skipped[ids["long"]]["reason"]

    # 把上限放开，它就会被当成页眉——这条规则的作用因此可见
    loose = preview(client, auth_headers, project_id, max_chars=None).json()
    assert ids["long"] in {item["block_id"] for item in loose["candidates"]}


def test_preview_does_not_touch_anything(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, page_with_chrome
) -> None:
    project_id, ids = page_with_chrome
    preview(client, auth_headers, project_id)

    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT block_type FROM block WHERE block_id = ?", (ids["header"],)
        ).fetchone()
        events = conn.execute("SELECT COUNT(*) AS n FROM event").fetchone()["n"]
    assert row["block_type"] == "paragraph", "预览不改任何东西"
    assert events == 0


def test_left_and_right_margin_regions(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome, library_dir: Path
) -> None:
    """竖排书眉贴在页面一侧（既不在顶部也不在底部），只有左右区域捞得到它。

    本项目的样本书就是这样：左栏印「红楼梦／第X回」，靠上下区域永远找不到。
    """
    project_id, ids = page_with_chrome
    # 一块竖排书眉：整块贴在左侧
    sidebar = add_block(
        library_dir, project_id, page_no=1, text="红楼梦／第三十一回", bbox=[0.0, 0.05, 0.08, 0.9]
    )
    # 一块贴在右侧的边注
    right_note = add_block(
        library_dir, project_id, page_no=1, text="见下页注", bbox=[0.93, 0.3, 1.0, 0.4]
    )

    data = preview(client, auth_headers, project_id).json()
    by_block = {item["block_id"]: item for item in data["candidates"]}
    assert by_block[sidebar]["region"] == "left"
    assert by_block[sidebar]["proposed_type"] == "header"
    assert "左侧" in by_block[sidebar]["reason"]
    assert by_block[right_note]["region"] == "right"

    # 把左右区域关掉（设为 0）就找不到它们了
    narrow = preview(client, auth_headers, project_id, left_ratio=0, right_ratio=0).json()
    found = {item["block_id"] for item in narrow["candidates"]}
    assert sidebar not in found
    assert right_note not in found


def test_preview_respects_page_types(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    """说明书 6.5：作用范围默认"全部纳入的正文页"。"""
    project_id, _ids = page_with_chrome
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    client.patch(
        f"/api/projects/{project_id}/pages",
        json={"page_ids": [pages[0]["page_id"]], "page_type": "front"},
        headers=auth_headers,
    )

    body_only = preview(client, auth_headers, project_id).json()
    assert body_only["candidate_count"] == 0, "第 1 页不再是正文页，它上面的页眉页码都不该被标"
    assert body_only["pages_scanned"] == 2, "只剩第 2、3 页是正文页"

    with_front = preview(client, auth_headers, project_id, page_types=["front"]).json()
    assert with_front["candidate_count"] == 2, "把前置页纳入范围就又能标了"
    assert with_front["pages_scanned"] == 1


def test_preview_never_overrides_manually_typed_blocks(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    """说明书 6.5：已被人工修改过类型的块不会被覆盖。"""
    project_id, ids = page_with_chrome
    # 人工把那个页眉改成了"图注"（走改块接口，会记 set_type 事件）
    client.patch(
        f"/api/projects/{project_id}/blocks/{ids['header']}",
        json={"block_type": "caption"},
        headers=auth_headers,
    )

    data = preview(client, auth_headers, project_id).json()
    assert ids["header"] not in {item["block_id"] for item in data["candidates"]}
    skipped = {item["block_id"]: item for item in data["skipped"]}
    assert "已经" in skipped[ids["header"]]["reason"]


def test_preview_needs_a_project(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    assert preview(client, auth_headers, "b2t_ZZZZZZ").status_code == 404


# ---------------------------------------------------------------- 应用

def test_apply_sets_types_and_records_one_batch(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, page_with_chrome
) -> None:
    project_id, ids = page_with_chrome
    data = preview(client, auth_headers, project_id).json()
    items = [
        {"block_id": item["block_id"], "block_type": item["proposed_type"]}
        for item in data["candidates"]
    ]

    response = apply(client, auth_headers, project_id, items)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["changed"] == 2
    assert result["by_type"] == {"header": 1, "page_number": 1}
    assert result["pages"] == [1]
    assert result["history"]["undo"] == 1

    blocks = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"]
    by_id = {block["block_id"]: block for block in blocks}
    assert by_id[ids["header"]]["block_type"] == "header"
    assert by_id[ids["number"]]["block_type"] == "page_number"
    assert by_id[ids["long"]]["block_type"] == "paragraph", "被跳过的不动"

    # 整批共享一个 batch_id（撤销按 batch 走）
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT DISTINCT batch_id FROM event WHERE action = 'set_type'"
        ).fetchall()
    assert len(rows) == 1


def test_apply_can_be_undone_as_a_whole(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    """说明书 6.5 第 4 条：作为一个 batch 写入 Event，可整体撤销。"""
    project_id, ids = page_with_chrome
    data = preview(client, auth_headers, project_id).json()
    apply(
        client,
        auth_headers,
        project_id,
        [
            {"block_id": item["block_id"], "block_type": item["proposed_type"]}
            for item in data["candidates"]
        ],
    )

    undone = client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    assert undone.status_code == 200, undone.text

    blocks = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"]
    by_id = {block["block_id"]: block for block in blocks}
    assert by_id[ids["header"]]["block_type"] == "paragraph", "撤销一次全退回去"
    assert by_id[ids["number"]]["block_type"] == "paragraph"


def test_apply_only_touches_what_was_confirmed(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    """预览里"逐个取消"的语义：没传回来的块不动。"""
    project_id, ids = page_with_chrome
    data = preview(client, auth_headers, project_id).json()
    header_item = next(item for item in data["candidates"] if item["block_id"] == ids["header"])

    apply(
        client,
        auth_headers,
        project_id,
        [{"block_id": header_item["block_id"], "block_type": header_item["proposed_type"]}],
    )
    blocks = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["blocks"]
    by_id = {block["block_id"]: block for block in blocks}
    assert by_id[ids["header"]]["block_type"] == "header"
    assert by_id[ids["number"]]["block_type"] == "paragraph", "用户取消的那个没动"


def test_apply_with_nothing_is_refused(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    project_id, _ids = page_with_chrome
    response = apply(client, auth_headers, project_id, [])
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "nothing_to_apply"


def test_apply_rejects_a_bad_type(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    project_id, ids = page_with_chrome
    response = apply(
        client, auth_headers, project_id, [{"block_id": ids["header"], "block_type": "乱写"}]
    )
    assert response.status_code == 400
    assert "未知的块类型" in response.json()["error"]["detail"]


def test_applied_blocks_are_protected_on_a_second_run(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    """标注过一次的块不会在第二次预览里重复出现（它已经不是段落了）。"""
    project_id, ids = page_with_chrome
    data = preview(client, auth_headers, project_id).json()
    apply(
        client,
        auth_headers,
        project_id,
        [
            {"block_id": item["block_id"], "block_type": item["proposed_type"]}
            for item in data["candidates"]
        ],
    )

    again = preview(client, auth_headers, project_id).json()
    assert again["candidate_count"] == 0
    assert ids["header"] not in {item["block_id"] for item in again["candidates"]}


def test_undo_brings_the_candidates_back(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    """标注 → 撤销 → 再预览：那些块应当重新出现在候选里。

    批量工具自己的改动记 `actor=system`，不算"人工改过"——
    否则用户撤销一次之后，这些块就再也标不上了（实测踩到）。
    """
    project_id, _ids = page_with_chrome
    data = preview(client, auth_headers, project_id).json()
    apply(
        client,
        auth_headers,
        project_id,
        [
            {"block_id": item["block_id"], "block_type": item["proposed_type"]}
            for item in data["candidates"]
        ],
    )
    assert preview(client, auth_headers, project_id).json()["candidate_count"] == 0, (
        "标过之后它们已经不是段落了"
    )

    client.post(f"/api/projects/{project_id}/undo", headers=auth_headers)
    again = preview(client, auth_headers, project_id).json()
    assert again["candidate_count"] == 2, "撤销之后又能标了"


def test_manual_type_change_is_protected_but_batch_is_not(
    client: TestClient, auth_headers: dict[str, str], page_with_chrome
) -> None:
    project_id, ids = page_with_chrome
    # 人工把页眉改成图注
    client.patch(
        f"/api/projects/{project_id}/blocks/{ids['header']}",
        json={"block_type": "caption"},
        headers=auth_headers,
    )
    data = preview(client, auth_headers, project_id).json()
    assert ids["header"] not in {item["block_id"] for item in data["candidates"]}

    # 再人工改回段落：**仍然**是"被人定过类型"，工具不覆盖人的选择
    client.patch(
        f"/api/projects/{project_id}/blocks/{ids['header']}",
        json={"block_type": "paragraph"},
        headers=auth_headers,
    )
    again = preview(client, auth_headers, project_id).json()
    assert ids["header"] not in {item["block_id"] for item in again["candidates"]}
    skipped_again = {item["block_id"]: item for item in again["skipped"]}
    assert "类型被人改过" in skipped_again[ids["header"]]["reason"]

    # 而从来没人定过类型的那个块照旧入选
    assert ids["number"] in {item["block_id"] for item in again["candidates"]}


def test_structure_endpoints_require_token(client: TestClient) -> None:
    assert client.post("/api/projects/b2t_ZZZZZZ/structure/header-footer/preview").status_code == 401
    assert client.post("/api/projects/b2t_ZZZZZZ/structure/header-footer/apply", json={}).status_code == 401
