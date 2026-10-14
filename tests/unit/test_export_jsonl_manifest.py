"""JSONL 与 manifest 输出测试（说明书 9.5）。

说明书 13.2 明确要求"校验 JSONL 每行都是有效 JSON"，
说明书 9.5 明确列出 manifest 必须包含的字段（项目名、源文件名与 SHA-256、
导出时间、应用版本、导出范围、启用的规则、断词还原位置列表、统计数据）。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from book2text.core.export import jsonl, manifest
from book2text.core.export.segments import (
    BLOCK_TYPE_PARAGRAPH,
    ReviewSummary,
    Segment,
    SegmentHyphenation,
)


def segment(
    text: str,
    *,
    seq: int = 1,
    segment_id: str = "b1",
    pages: tuple[int, ...] = (1,),
    block_ids: tuple[str, ...] = ("b1",),
    review: ReviewSummary | None = None,
    hyphenations: tuple[SegmentHyphenation, ...] = (),
) -> Segment:
    return Segment(
        seq=seq,
        segment_id=segment_id,
        block_type=BLOCK_TYPE_PARAGRAPH,
        text=text,
        pages=pages,
        block_ids=block_ids,
        review=review
        or ReviewSummary(all_confirmed=False, unreviewed=1, uncertain=0, modified=None),
        hyphenations=hyphenations,
    )


# ================================================================
# 说明书 9.5 JSONL
# ================================================================

def test_every_line_is_valid_json() -> None:
    """说明书 13.2 点名的校验项。"""
    content = jsonl.render_jsonl([
        segment("第一段", seq=1),
        segment("第二段", seq=2, segment_id="b2"),
        segment("第三段", seq=3, segment_id="b3"),
    ])
    lines = content.splitlines()
    assert len(lines) == 3
    for line in lines:
        json.loads(line)  # 不抛异常即有效


def test_one_line_per_segment() -> None:
    content = jsonl.render_jsonl([segment("甲"), segment("乙", seq=2, segment_id="b2")])
    assert len(content.splitlines()) == 2
    assert content.endswith("\n")


def test_empty_segments_give_empty_string() -> None:
    assert jsonl.render_jsonl([]) == ""


def test_text_with_newlines_stays_on_one_line() -> None:
    """段文本里的换行必须被转义，否则会破坏"一行一段"的结构。"""
    content = jsonl.render_jsonl([segment("第一行\n第二行")])
    assert len(content.splitlines()) == 1
    assert json.loads(content)["text"] == "第一行\n第二行"


def test_record_has_the_spec_fields() -> None:
    """字段形状照说明书 9.5 的示例。"""
    content = jsonl.render_jsonl(
        [segment("In the early years …", pages=(87, 88), block_ids=("a", "b"))],
        page_labels={87: "71", 88: "72"},
        engine_id="rapidocr",
        engine_version="3.10.0",
    )
    record = json.loads(content)
    assert record["schema"] == "book2text.segment.v1"
    assert record["segment_id"] == "b1"
    assert record["seq"] == 1
    assert record["type"] == "paragraph"
    assert record["text"] == "In the early years …"
    assert record["block_ids"] == ["a", "b"]
    assert record["source"] == {"engine": "rapidocr", "engine_version": "3.10.0"}


def test_pages_are_objects_with_page_no_and_label() -> None:
    """说明书示例里 pages 是 ``[{"page_no": 87, "page_label": "71"}]``。"""
    content = jsonl.render_jsonl(
        [segment("正文", pages=(87, 88))], page_labels={87: "71", 88: "72"}
    )
    assert json.loads(content)["pages"] == [
        {"page_no": 87, "page_label": "71"},
        {"page_no": 88, "page_label": "72"},
    ]


def test_page_label_empty_when_unknown() -> None:
    content = jsonl.render_jsonl([segment("正文", pages=(5,))])
    assert json.loads(content)["pages"] == [{"page_no": 5, "page_label": ""}]


def test_review_block_matches_the_spec() -> None:
    content = jsonl.render_jsonl([
        segment(
            "正文",
            review=ReviewSummary(
                all_confirmed=False, unreviewed=1, uncertain=0, modified=True
            ),
        )
    ])
    assert json.loads(content)["review"] == {
        "all_confirmed": False,
        "unreviewed": 1,
        "uncertain": 0,
        "modified": True,
    }


def test_source_is_empty_strings_when_engine_unknown() -> None:
    """拿不到引擎信息时如实置空，不编造。"""
    content = jsonl.render_jsonl([segment("正文")])
    assert json.loads(content)["source"] == {"engine": "", "engine_version": ""}


def test_non_ascii_is_not_escaped() -> None:
    content = jsonl.render_jsonl([segment("中文内容")])
    assert "中文内容" in content


# ================================================================
# 说明书 9.5 manifest
# ================================================================

def test_manifest_has_all_required_fields() -> None:
    """说明书 9.5 列出的字段一个都不能少。"""
    moment = datetime(2025, 3, 1, 14, 32, tzinfo=timezone.utc)
    built = manifest.build_manifest(
        app_version="0.0.0",
        scope=manifest.ExportScope(page_numbers=(87, 88), format="txt"),
        rules={"exclude_header_footer": True},
        segments=[segment("正文", pages=(87, 88))],
        data_file="clean.txt",
        source=manifest.SourceInfo(
            project_name="红楼梦", file_name="source.pdf", sha256="deadbeef"
        ),
        exported_at=moment,
    )

    # 项目名、源文件名与 SHA-256
    assert built["project"] == {
        "name": "红楼梦",
        "source_file_name": "source.pdf",
        "source_sha256": "deadbeef",
    }
    # 导出时间
    assert built["exported_at"] == "2025-03-01T14:32:00+00:00"
    # 应用版本
    assert built["app_version"] == "0.0.0"
    # 导出范围
    assert built["scope"]["pages"] == [87, 88]
    assert built["scope"]["format"] == "txt"
    # 启用的规则
    assert built["rules"] == {"exclude_header_footer": True}
    # 断词还原位置列表（本用例没有）
    assert built["hyphenations_restored"] == []
    # 统计数据
    assert built["stats"]["segment_count"] == 1
    assert built["stats"]["char_count"] == 2
    assert built["stats"]["page_count"] == 2


def test_manifest_export_id_follows_the_directory_naming() -> None:
    """说明书 12.1 的导出目录是 ``exports/20250301-1432_txt/``。"""
    moment = datetime(2025, 3, 1, 14, 32, tzinfo=timezone.utc)
    assert manifest.export_id(moment, "txt") == "20250301-1432_txt"
    assert manifest.export_id(moment, "jsonl") == "20250301-1432_jsonl"


def test_manifest_lists_hyphenations_with_context() -> None:
    """说明书 9.2：断词还原位置要能人工抽查，所以必须带上下文。"""
    record = SegmentHyphenation(
        block_id="p3-b6",
        scope="block",
        position=12,
        left_fragment="self-",
        right_fragment="evident",
        hyphen="-",
    )
    built = manifest.build_manifest(
        app_version="0.0.0",
        scope=manifest.ExportScope(page_numbers=(1,), format="txt"),
        rules={},
        segments=[segment("this is selfevident", hyphenations=(record,))],
        data_file="clean.txt",
    )

    entries = built["hyphenations_restored"]
    assert len(entries) == 1
    entry = entries[0]
    assert entry["segment_id"] == "b1"
    assert entry["seq"] == 1
    assert entry["block_id"] == "p3-b6"
    assert entry["scope"] == "block"
    assert entry["left_fragment"] == "self-"
    assert entry["right_fragment"] == "evident"
    assert built["stats"]["hyphenations_restored"] == 1


def test_manifest_collects_hyphenations_from_all_segments() -> None:
    first = SegmentHyphenation("b1", "block", 3, "self-", "evident", "-")
    second = SegmentHyphenation("b2", "segment", 40, "Anglo-", "Saxon", "-")
    built = manifest.build_manifest(
        app_version="0.0.0",
        scope=manifest.ExportScope(page_numbers=(1, 2), format="jsonl"),
        rules={},
        segments=[
            segment("甲", seq=1, hyphenations=(first,)),
            segment("乙", seq=2, segment_id="b2", pages=(2,), hyphenations=(second,)),
        ],
        data_file="segments.jsonl",
    )
    assert [e["block_id"] for e in built["hyphenations_restored"]] == ["b1", "b2"]
    assert [e["scope"] for e in built["hyphenations_restored"]] == ["block", "segment"]
    assert built["stats"]["hyphenations_restored"] == 2


def test_manifest_files_list_includes_the_data_file_and_itself() -> None:
    built = manifest.build_manifest(
        app_version="0.0.0",
        scope=manifest.ExportScope(page_numbers=(1,), format="txt"),
        rules={},
        segments=[segment("正文")],
        data_file="clean.txt",
    )
    assert built["files"] == ["clean.txt", "manifest.json"]


def test_manifest_marks_missing_project_info_explicitly() -> None:
    """没有项目模型时字段留空，并给出说明——不能默默给个空字符串。"""
    built = manifest.build_manifest(
        app_version="0.0.0",
        scope=manifest.ExportScope(page_numbers=(1,), format="txt"),
        rules={},
        segments=[segment("正文")],
        data_file="clean.txt",
    )
    assert built["project"]["name"] == ""
    assert any("为空字符串" in note for note in built["notes"])


def test_manifest_stats_are_consistent_with_segments() -> None:
    built = manifest.build_manifest(
        app_version="0.0.0",
        scope=manifest.ExportScope(page_numbers=(1, 2), format="txt"),
        rules={},
        segments=[
            segment("甲甲", seq=1, block_ids=("a", "b"), pages=(1, 2)),
            segment("乙", seq=2, segment_id="c", pages=(2,)),
        ],
        data_file="clean.txt",
    )
    stats = built["stats"]
    assert stats["segment_count"] == 2
    assert stats["block_count"] == 3
    assert stats["char_count"] == 3
    assert stats["merged_segments"] == 1
    assert stats["pages"] == [1, 2]


def test_manifest_is_json_serializable() -> None:
    built = manifest.build_manifest(
        app_version="0.0.0",
        scope=manifest.ExportScope(page_numbers=(1,), format="txt"),
        rules={"page_markers": False},
        segments=[segment("中文正文")],
        data_file="clean.txt",
        exported_at=datetime(2025, 3, 1, 14, 32, tzinfo=timezone.utc),
    )
    payload = json.dumps(built, ensure_ascii=False)
    assert "中文正文" not in payload  # manifest 不含段文本，只有统计
    assert json.loads(payload)["export_id"] == "20250301-1432_txt"


def test_jsonl_hyphenation_records_are_not_duplicated_into_segment_fields() -> None:
    """段记录只放说明书列出的字段；断词还原放在 manifest 里，不混进 JSONL。"""
    record = SegmentHyphenation("b1", "block", 3, "self-", "evident", "-")
    content = jsonl.render_jsonl([segment("selfevident", hyphenations=(record,))])
    assert "hyphen" not in json.loads(content)
    assert set(json.loads(content)) == {
        "schema", "segment_id", "seq", "type", "text",
        "pages", "block_ids", "review", "source",
    }
