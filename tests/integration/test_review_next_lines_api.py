"""`POST /api/projects/{id}/review/next-lines` 的集成测试。

这个接口是「下一处未审」的**唯一数据源**：按正文流顺序给未审行表 + 流外差异计数。
它今天已经翻车两次（`body: Any` 绑不上导致 options 被静默忽略；`outside_stream`
一开始只报一类），而这类逻辑用真浏览器连按验证要 20 分钟。这里是 2 秒版。

口径备忘（读代码确认，不是猜的）：

- `lines` 只收**汉字级**（`differs_chars`）未审行——标点级差异属于「按模式批量」面板，
  不进这条流（`routes_review.py` 里 `if item.get("level") == "differs_punct": continue`）。
- 在不在流里由**导出段**决定：`segments` 来自 `export/preview?segments_only=1`，
  和「显示 = 导出」同一个函数。所以被 `page_types` 挡掉的页、`include=0` 的块，
  它们的未审行不会出现在 `lines` 里。
- 不变量：`len(lines) + outside_stream.count == chars_unacked`。
- `outside_stream` 只收"marks 收进来了、但这段不在导出流里"的行。
  注意：**脚注/被排除块根本不进 marks**（`reading_marks._build_items` 只收
  `paragraph`/`heading` 且 `include=1`），所以它们既不在 `lines` 也不在
  `outside_stream`——见 `test_excluded_block_is_in_neither_list`。

**红过没有（复跑方法）**

在 `90d96fc^`（= `7352b5a`，`body: Any = None` 那版，"options 被静默忽略"事故）上：
7 例中 **1 例红**——`test_page_types_option_changes_the_stream_and_the_total`，
红因是 `wide.total == 4 != 5`（请求带 `page_types=["body","toc"]` 却拿不到多出来的那行）。
其余 6 例在旧版也绿：它们锁的是口径不变量和排序，不是那次事故。

复跑（主工作区的 editable 安装会盖掉旧代码，必须用 PYTHONPATH 顶掉）：

```
git worktree add --detach /tmp/b2t-red 90d96fc^
cp tests/integration/test_review_next_lines_api.py /tmp/b2t-red/tests/integration/
cd /tmp/b2t-red && PYTHONPATH=/tmp/b2t-red/backend <主仓库>/.venv/bin/python \
    -m pytest tests/integration/test_review_next_lines_api.py -q   # 1 failed, 6 passed
```

`options_echo` 是修复时才加的字段，所以**行为断言必须排在 echo 断言前面**，
否则旧版会红在 `KeyError: 'options_echo'` 上——那不是回归信号。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import recognition
from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine, FakeSecondEngine

# 假 OCR 每页固定三行、切成两块：块 0 = 两行，块 1 = 一行。
# 第二引擎按"块序 × 行序"逐行给候选文本，所以下面每页三个文本一一对应这三行。
SECOND_ENGINE_PAGES: dict[int, list[str]] = {
    # 块 0 两行都是汉字级差异（行 → 句），块 1 一致
    1: ["第一段第一句。", "第一段第二句。", "第二段第一行。"],
    2: ["第一段第一句。", "第一段第二句。", "第二段第一行。"],
    # 块 0 第 0 行汉字级；块 1 只有标点差异（。→ ！）
    3: ["第一段第一句。", "第一段第二行。", "第二段第一行！"],
}


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "下一处未审", "filename": pdf.name},
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


def run_second_engine(library_dir: Path, project_id: str, texts_by_page: dict[int, list[str]]) -> None:
    """按页跑第二引擎复核，造出"哪一行有差异、差在哪一级"。"""
    for page_no, texts in texts_by_page.items():
        recognition.run_auxiliary(
            library_dir / project_id, page_no, engine=FakeSecondEngine(texts)
        )


def next_lines(
    client: TestClient,
    headers: dict[str, str],
    project_id: str,
    *,
    page_types: list[str] | None = None,
) -> dict:
    body = {} if page_types is None else {"page_types": page_types}
    response = client.post(f"/api/projects/{project_id}/review/next-lines", json=body, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def marks(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/review/marks", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def line_key(item: dict) -> tuple[str, int]:
    return (item["block_id"], item["line_index"])


def set_page_type(library_dir: Path, project_id: str, page_no: int, page_type: str) -> None:
    """直接改库：把某页标成图注页等，验证 `page_types` 真的影响正文流。"""
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        conn.execute("UPDATE page SET page_type = ? WHERE page_no = ?", (page_type, page_no))
        conn.commit()


def set_block_include(library_dir: Path, project_id: str, page_no: int, include: bool) -> str:
    """直接改库：把某页块 0 标成"不纳入导出"，返回被改的 block_id。"""
    with db_module.open_database(library_dir / project_id, apply_migrations=False) as conn:
        page = conn.execute(
            "SELECT page_id FROM page WHERE page_no = ?", (page_no,)
        ).fetchone()
        block = conn.execute(
            "SELECT block_id FROM block WHERE page_id = ? ORDER BY order_index LIMIT 1",
            (page["page_id"],),
        ).fetchone()
        conn.execute("UPDATE block SET include = ? WHERE block_id = ?", (1 if include else 0, block["block_id"]))
        conn.commit()
        return str(block["block_id"])


@pytest.fixture
def book_with_marks(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, sample_pdf: Path,
    inprocess_jobs: FakeOcrEngine,
) -> tuple[str, Path]:
    """三页都识别好、且第二引擎造出差异的项目：汉字级 5 行 + 标点级 1 行。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1, 2, 3)
    run_second_engine(library_dir, project_id, SECOND_ENGINE_PAGES)
    return project_id, library_dir


# ---------------------------------------------------------------- 1. options 真的生效

def test_page_types_option_changes_the_stream_and_the_total(
    client: TestClient, auth_headers: dict[str, str], book_with_marks: tuple[str, Path]
) -> None:
    """把第 3 页标成目录页：`page_types` 只给 body 时它整页退出正文流。

    这条就是 `body: Any` 那次事故的回归：参数被静默忽略时，两次请求会返回
    **完全相同**的 total / options_echo，而 page 3 的行仍然留在 lines 里。
    为避免"total 没变"被误读成"这本书没有该类型的块"，这里先证明那行差异确实存在。

    页面类型只有五类（`library.PAGE_TYPES`：front/toc/body/body_excluded/back），
    没有 "caption"——所以用 `toc` 当"非正文页"。
    """
    project_id, library_dir = book_with_marks

    # 前提：第 3 页那行汉字差异真的存在（不然下面的 total 变化说明不了任何事）
    all_marks = marks(client, auth_headers, project_id)["items"]
    page3_chars = [item for item in all_marks if item["page_no"] == 3 and item["level"] == "differs_chars"]
    assert len(page3_chars) == 1, "前提不成立：第 3 页没有汉字级差异行"

    before = next_lines(client, auth_headers, project_id)
    assert before["total"] == 5  # 页 1(2) + 页 2(2) + 页 3(1)
    assert before["outside_stream"]["count"] == 0

    set_page_type(library_dir, project_id, 3, "toc")
    narrow = next_lines(client, auth_headers, project_id, page_types=["body"])
    wide = next_lines(client, auth_headers, project_id, page_types=["body", "toc"])

    # **行为断言在前**：参数被静默忽略时，这里会先红，红因是"total 没随 page_types 变"，
    # 而不是"options_echo 这个字段不存在"（那个字段是修复时才加的）。
    assert narrow["total"] == 4, (
        "body-only 应当只剩页 1、页 2 的 4 行——total 不变说明 page_types 没生效"
        f"（narrow.total={narrow['total']}, wide.total={wide['total']}）"
    )
    assert wide["total"] == 5, "把 toc 页放进流后应当补回第 3 页那 1 行"
    assert narrow["outside_stream"]["count"] == 1
    assert wide["outside_stream"]["count"] == 0

    # options 确实被解析了（echo 与请求一致），作为行为之外的第二个证据
    assert narrow["options_echo"]["page_types"] == ["body"]
    assert wide["options_echo"]["page_types"] == ["body", "toc"]
    # 那 1 行在两边的身份：narrow 在 outside_stream，wide 在 lines
    narrow_line = narrow["outside_stream"]["sample"][0]
    assert line_key(narrow_line) == line_key(page3_chars[0])
    assert line_key(narrow_line) not in [line_key(item) for item in narrow["lines"]]
    assert line_key(narrow_line) in [line_key(item) for item in wide["lines"]]


# ---------------------------------------------------------------- 2. 不变量

def test_lines_plus_outside_equals_chars_unacked(
    client: TestClient, auth_headers: dict[str, str], book_with_marks: tuple[str, Path]
) -> None:
    """`len(lines) + outside_stream.count == chars_unacked`，三种口径组合都要成立。"""
    project_id, library_dir = book_with_marks
    set_page_type(library_dir, project_id, 3, "toc")

    combos = (["body"], ["body", "toc"])
    for page_types in combos:
        payload = next_lines(client, auth_headers, project_id, page_types=page_types)
        assert len(payload["lines"]) + payload["outside_stream"]["count"] == payload["chars_unacked"], (
            f"page_types={page_types} 时口径对不上："
            f"lines={len(payload['lines'])} outside={payload['outside_stream']['count']} "
            f"chars_unacked={payload['chars_unacked']}"
        )
        assert payload["total"] == len(payload["lines"])
        assert payload["outside_stream"]["by_reason"] == {"not_in_stream": payload["outside_stream"]["count"]}


# ---------------------------------------------------------------- 3. 顺序

def test_lines_are_in_body_flow_order_across_pages(
    client: TestClient, auth_headers: dict[str, str], book_with_marks: tuple[str, Path]
) -> None:
    """两页各两行未审：先页 1 的两行（行序升序），再页 2 的两行。"""
    project_id, _ = book_with_marks
    payload = next_lines(client, auth_headers, project_id)
    keys = [line_key(item) for item in payload["lines"]]
    pages = [item["page_no"] for item in payload["lines"]]

    assert pages == [1, 1, 2, 2, 3], f"正文流顺序不对：{pages}"
    assert all(a["page_no"] < b["page_no"] or
               (a["page_no"] == b["page_no"] and a["line_index"] < b["line_index"])
               for a, b in zip(payload["lines"], payload["lines"][1:])), "lines 不是单调递增的"
    assert len(set(keys)) == len(keys), "同一行被返回了两次"


# ---------------------------------------------------------------- 4. 只给流内

def test_outside_line_appears_only_in_outside_stream(
    client: TestClient, auth_headers: dict[str, str], book_with_marks: tuple[str, Path]
) -> None:
    """被 page_types 挡在流外的未审行：只在 outside_stream，不在 lines。"""
    project_id, library_dir = book_with_marks
    set_page_type(library_dir, project_id, 3, "toc")
    payload = next_lines(client, auth_headers, project_id, page_types=["body"])

    outside = payload["outside_stream"]
    assert outside["count"] == 1
    keys = [line_key(item) for item in payload["lines"]]
    outside_keys = [line_key(item) for item in outside["sample"]]
    assert outside_keys and outside_keys[0] not in keys
    assert outside["sample"][0]["reason"] == "not_in_stream"
    assert outside["sample"][0]["page_no"] == 3


def test_excluded_block_is_in_neither_list(
    client: TestClient, auth_headers: dict[str, str], book_with_marks: tuple[str, Path]
) -> None:
    """`include=0` 的块：`lines` 和 `outside_stream` 里都没有它。

    实测口径：`reading_marks._build_items` 只收 `paragraph`/`heading` 且 `include=1` 的块，
    所以被排除的块**根本不进 marks**，也就不会出现在 `outside_stream`。
    `outside_stream` 只收"marks 收进来了、但没进导出流"的行（页面类型被挡、页码范围等）。
    前端因此不能靠 `outside_stream` 发现被排除块里的差异——这是现状，不是本用例的期望判断。
    """
    project_id, library_dir = book_with_marks
    excluded_block = set_block_include(library_dir, project_id, 1, include=False)
    payload = next_lines(client, auth_headers, project_id)

    all_marks = marks(client, auth_headers, project_id)["items"]
    assert excluded_block not in [item["block_id"] for item in all_marks], (
        "前提不成立：include=0 的块仍然出现在 marks 里"
    )
    assert excluded_block not in [item["block_id"] for item in payload["lines"]]
    assert excluded_block not in [item["block_id"] for item in payload["outside_stream"]["sample"]]
    # 被排除后，它那两行汉字差异也不再算进 chars_unacked（队列口径一致）
    assert payload["chars_unacked"] == 3
    assert len(payload["lines"]) + payload["outside_stream"]["count"] == payload["chars_unacked"]


# ---------------------------------------------------------------- 5. 标点排除

def test_punct_only_line_is_excluded_from_lines(
    client: TestClient, auth_headers: dict[str, str], book_with_marks: tuple[str, Path]
) -> None:
    """`differs_punct` 行不进 `lines`——但要先证明它作为标记**存在**（不是没算出来）。"""
    project_id, _ = book_with_marks
    all_marks = marks(client, auth_headers, project_id)["items"]
    punct_items = [item for item in all_marks if item["level"] == "differs_punct"]
    assert len(punct_items) == 1, "前提不成立：没有造出标点级差异"
    punct_key = line_key(punct_items[0])

    payload = next_lines(client, auth_headers, project_id)
    assert punct_key not in [line_key(item) for item in payload["lines"]]
    assert punct_key not in [line_key(item) for item in payload["outside_stream"]["sample"]]
    # 5 条汉字级（= chars_unacked）都在流内；标点那条既不占 lines 也不占 chars_unacked
    assert payload["chars_unacked"] == 5
    assert payload["total"] == 5
    assert len(all_marks) == 6, "marks 里应当是 5 条汉字级 + 1 条标点级"


# ---------------------------------------------------------------- 6. ack 之后消失

def test_acked_line_disappears_and_total_drops(
    client: TestClient, auth_headers: dict[str, str], book_with_marks: tuple[str, Path]
) -> None:
    """ack 一行后：total 减 1、该 key 不再出现、不变量仍然成立。"""
    project_id, _ = book_with_marks
    before = next_lines(client, auth_headers, project_id)
    target = before["lines"][0]
    assert before["total"] == 5

    response = client.post(
        f"/api/projects/{project_id}/blocks/{target['block_id']}/diff-ack",
        json={"line_index": target["line_index"], "ack": "kept"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text

    after = next_lines(client, auth_headers, project_id)
    assert after["total"] == before["total"] - 1
    assert after["chars_unacked"] == before["chars_unacked"] - 1
    assert line_key(target) not in [line_key(item) for item in after["lines"]]
    assert len(after["lines"]) + after["outside_stream"]["count"] == after["chars_unacked"]
