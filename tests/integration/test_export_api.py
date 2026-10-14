"""导出接口的集成测试（说明书 9.1 / 9.3 / 9.4）。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def block(
    block_id: str,
    lines: list[str],
    *,
    page_no: int = 1,
    order_index: int = 0,
    block_type: str = "paragraph",
    include: bool = True,
    continues_to_next: bool = False,
    review_status: str = "unreviewed",
) -> dict:
    return {
        "block_id": block_id,
        "page_no": page_no,
        "order_index": order_index,
        "block_type": block_type,
        "lines": lines,
        "include": include,
        "review_status": review_status,
        "continues_to_next": continues_to_next,
    }


def export(client: TestClient, headers: dict[str, str], blocks: list[dict], **options):
    payload = {"blocks": blocks, "options": options, "preview_chars": 100_000}
    return client.post("/api/export/txt", json=payload, headers=headers)


# ---------------------------------------------------------------- 基本

def test_export_requires_token(client: TestClient) -> None:
    response = client.post("/api/export/txt", json={"blocks": []})
    assert response.status_code == 401


def test_export_joins_lines_into_paragraphs(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = export(
        client,
        auth_headers,
        [block("a", ["第一行文字，", "第二行文字。"])],
    )
    assert response.status_code == 200
    data = response.json()
    assert data["text"] == "第一行文字，第二行文字。\n"
    assert data["preflight"]["segment_count"] == 1
    assert data["format"] == "txt"


def test_export_separates_segments_with_blank_line(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    data = export(
        client,
        auth_headers,
        [block("a", ["第一段。"]), block("b", ["第二段。"], order_index=1)],
    ).json()
    assert data["text"] == "第一段。\n\n第二段。\n"


def test_empty_input_gives_empty_text(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = export(client, auth_headers, [])
    assert response.status_code == 200
    assert response.json()["text"] == ""


def test_all_filtered_out_returns_explicit_error(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    """全被排除时必须报错并说明原因，不能静默给一个空文件。"""
    response = export(client, auth_headers, [block("a", ["内容"], include=False)])
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "nothing_to_export"
    assert response.json()["error"]["detail"]


# ---------------------------------------------------------------- 跨页拼接

def test_cross_page_merge(client: TestClient, auth_headers: dict[str, str]) -> None:
    """说明书成功标准：跨页段落被正确拼接。"""
    data = export(
        client,
        auth_headers,
        [
            block("upper", ["他只当是昨日金钏儿之事，他"], page_no=3, continues_to_next=True),
            block("lower", ["没好意思的，越发不理他。"], page_no=4),
        ],
    ).json()

    assert data["preflight"]["merged_segments"] == 1
    assert len(data["segments"]) == 1
    segment = data["segments"][0]
    assert segment["pages"] == [3, 4]
    assert segment["block_ids"] == ["upper", "lower"]
    assert segment["text"] == "他只当是昨日金钏儿之事，他没好意思的，越发不理他。"
    assert " " not in segment["text"], "中文跨页处不应插入空格"


def test_cross_page_merge_skips_excluded_blocks_between(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    """中间被排除的页码块不影响合并（说明书 9.1 第 2 条）。"""
    data = export(
        client,
        auth_headers,
        [
            block("upper", ["上半句"], page_no=1, order_index=0, continues_to_next=True),
            block("n", ["12"], page_no=1, order_index=1, block_type="page_number"),
            block("lower", ["下半句"], page_no=2, order_index=0),
        ],
    ).json()
    assert len(data["segments"]) == 1
    assert data["segments"][0]["block_ids"] == ["upper", "lower"]


def test_heading_stays_standalone(client: TestClient, auth_headers: dict[str, str]) -> None:
    data = export(
        client,
        auth_headers,
        [
            block("h", ["第三章"], block_type="heading", continues_to_next=True),
            block("p", ["正文开始。"], order_index=1),
        ],
    ).json()
    assert [s["text"] for s in data["segments"]] == ["第三章", "正文开始。"]


# ---------------------------------------------------------------- 排除与规则

def test_header_footer_excluded_by_default(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    data = export(
        client,
        auth_headers,
        [
            block("h", ["书名"], block_type="header"),
            block("p", ["正文"], order_index=1),
            block("f", ["页码"], order_index=2, block_type="footer"),
        ],
    ).json()
    assert data["text"] == "正文\n"
    assert data["preflight"]["input_blocks"] == 3
    assert data["preflight"]["segment_count"] == 1


def test_exclusion_can_be_turned_off(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    data = export(
        client,
        auth_headers,
        [block("h", ["书名"], block_type="header"), block("p", ["正文"], order_index=1)],
        exclude_header_footer=False,
    ).json()
    assert data["text"] == "书名\n\n正文\n"


def test_merge_lines_off_preserves_newlines(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    """说明书 9.3：关闭段内行合并时保留原始换行。"""
    data = export(
        client,
        auth_headers,
        [block("a", ["第一行", "第二行"])],
        merge_lines_in_block=False,
    ).json()
    assert data["text"] == "第一行\n第二行\n"


def test_hyphenation_restored_and_counted(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    data = export(
        client,
        auth_headers,
        [block("a", ["this is self-", "evident to anyone."])],
    ).json()
    assert data["text"] == "this is selfevident to anyone.\n"
    assert data["preflight"]["hyphenations_restored"] == 1


def test_hyphenation_off_keeps_the_hyphen(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    data = export(
        client,
        auth_headers,
        [block("a", ["this is self-", "evident to anyone."])],
        restore_hyphenation=False,
    ).json()
    assert data["text"] == "this is self-evident to anyone.\n"


def test_confirmed_only_scope(client: TestClient, auth_headers: dict[str, str]) -> None:
    data = export(
        client,
        auth_headers,
        [
            block("a", ["已确认"], review_status="confirmed"),
            block("b", ["未审校"], order_index=1),
        ],
        confirmed_only=True,
    ).json()
    assert data["text"] == "已确认\n"
    assert data["preflight"]["unreviewed_segments"] == 0


def test_page_markers_option(client: TestClient, auth_headers: dict[str, str]) -> None:
    data = export(
        client,
        auth_headers,
        [block("a", ["第一页"], page_no=1), block("b", ["第二页"], page_no=2, order_index=0)],
        page_markers=True,
    ).json()
    assert "〔p.1〕" in data["text"]
    assert "〔p.2〕" in data["text"]


def test_output_is_utf8_text_with_lf(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    data = export(client, auth_headers, [block("a", ["甲"]), block("b", ["乙"], order_index=1)]).json()
    assert "\r" not in data["text"]
    # JSON 响应本身就是 UTF-8；这里确认没有 BOM 混进文本
    assert not data["text"].startswith("\ufeff")


# ---------------------------------------------------------------- 预检摘要

def test_preflight_numbers_are_consistent(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    data = export(
        client,
        auth_headers,
        [
            block("a", ["甲"], page_no=1, continues_to_next=True),
            block("b", ["乙"], page_no=1, order_index=1),
            block("c", ["丙"], page_no=2, order_index=0),
        ],
    ).json()
    preflight = data["preflight"]

    assert preflight["input_blocks"] == 3
    assert preflight["segment_count"] == len(data["segments"])
    assert preflight["char_count"] == len(data["text"])
    assert preflight["page_count"] == 2
    assert preflight["pages"] == [1, 2]
    assert preflight["merged_segments"] == 1
    assert preflight["unreviewed_segments"] == preflight["segment_count"]
    assert "rules" in preflight


def test_preview_is_a_prefix_of_the_text(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = client.post(
        "/api/export/txt",
        json={
            "blocks": [
                block("a", ["第一段内容。"]),
                block("b", ["第二段内容。"], order_index=1),
            ],
            "options": {},
            "preview_chars": 5,
        },
        headers=auth_headers,
    )
    data = response.json()
    assert len(data["preview"]) == 5
    assert data["preview"] == data["text"][:5]
    assert len(data["text"]) > len(data["preview"]), "预览应短于全文"


def test_blocks_are_sorted_by_page_and_order(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    """乱序提交也应按 (page_no, order_index) 输出。"""
    data = export(
        client,
        auth_headers,
        [
            block("late", ["第三"], page_no=2, order_index=0),
            block("first", ["第一"], page_no=1, order_index=0),
            block("second", ["第二"], page_no=1, order_index=1),
        ],
    ).json()
    assert data["text"] == "第一\n\n第二\n\n第三\n"
