"""拆分 bbox 退化：页码与正文同一行、且这行是块的最后一行。

真机形态（QA 夹具 `b2t_T7JH61` p.1）：

```
block.text = "THE STORY OF\\nTHE STONE 4"   bbox = [0.045052, 0.066169, 0.659694, 0.170758]
line0      = "THE STORY OF"                bbox = [0.045052, 0.066169, 0.659694, 0.115795]
line1      = "THE STONE 4"                 bbox = [0.046661, 0.117396, 0.612228, 0.170758]
拆后 tail  = [0.045052, 0.170758, 0.659694, 0.170758]   ← 高 0、x 是整块宽
```

根因：`_estimate_split_rects` 只在「被切开的那一行是唯一的行」时横切；
这里切在**最后一行**、比例 > 0.5 ⇒ 整行归前块、后块为空 ⇒ 走 `_split_base_estimate`，
`line_bottom = y1` ⇒ 零高。

四页数据（p.1 + p.32 / p.60 / p.88）抄自 QA 夹具；`post_*` 是修好后必须逐字保持的对照值。
**不依赖 `tests/e2e/artifacts/` 路径**（那里归 QA）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from book2text.core.project import editing
from book2text.core.storage import db as db_module
from book2text.core.storage.ulid import new_ulid

PROJECT_ID = "b2t_SPT001"
NOW = "2026-11-03T00:00:00+00:00"

# page_no -> 夹具记录。p.1 的 post 值不是预期（它就是缺陷），只给修复后应满足的关系；
# 其余三页的 post 值必须逐字不变。
CASES = {
    1: {
        "text": "THE STORY OF\nTHE STONE 4",
        "bbox": [0.045052, 0.066169, 0.659694, 0.170758],
        "lines": [
            ("THE STORY OF", [0.045052, 0.066169, 0.659694, 0.115795]),
            ("THE STONE 4", [0.046661, 0.117396, 0.612228, 0.170758]),
        ],
        "number": "4",
        "position": "end",
        "kind": "last_line",
    },
    32: {
        "text": "228\n送果品小郎惊叵测\nChapter 90",
        "bbox": [0.313757, 0.097118, 0.596138, 0.142476],
        "lines": [
            ("228", [0.525342, 0.097118, 0.596138, 0.118463]),
            ("送果品小郎惊叵测", [0.313757, 0.099787, 0.510056, 0.118997]),
            ("Chapter 90", [0.313757, 0.121665, 0.435237, 0.142476]),
        ],
        "number": "228",
        "position": "start",
        "head_bbox": [0.525342, 0.097118, 0.596138, 0.118463],
        "tail_bbox": [0.313757, 0.099787, 0.510056, 0.142476],
        "head_text": "228",
        "tail_text": "送果品小郎惊叵测\nChapter 90",
    },
    60: {
        "text": "27\n1",
        "bbox": [0.939662, 0.960512, 0.976669, 1.0],
        "lines": [
            ("27", [0.939662, 0.960512, 0.976669, 0.98079]),
            ("1", [0.946903, 0.981323, 0.969429, 1.0]),
        ],
        "number": "1",
        "position": "end",
        "head_bbox": [0.939662, 0.960512, 0.976669, 0.98079],
        "tail_bbox": [0.946903, 0.981323, 0.969429, 1.0],
        "head_text": "27",
        "tail_text": "1",
    },
    88: {
        "text": "55\n1",
        "bbox": [0.945294, 0.955176, 0.981496, 0.999466],
        "lines": [
            ("55", [0.945294, 0.955176, 0.981496, 0.975987]),
            ("1", [0.952534, 0.978122, 0.97506, 0.999466]),
        ],
        "number": "1",
        "position": "end",
        "head_bbox": [0.945294, 0.955176, 0.981496, 0.975987],
        "tail_bbox": [0.952534, 0.978122, 0.97506, 0.999466],
        "head_text": "55",
        "tail_text": "1",
    },
}


def _overlap(a, b, eps: float = 1e-9) -> bool:
    return (
        min(a[2], b[2]) - max(a[0], b[0]) > eps
        and min(a[3], b[3]) - max(a[1], b[1]) > eps
    )


def _build_library(tmp_path: Path) -> tuple[Path, dict[int, str]]:
    """建一个最小库：一页一行 project/page，四页各一个块 + 夹具里的行框。"""
    directory = tmp_path / PROJECT_ID
    directory.mkdir()
    block_ids: dict[int, str] = {}
    with db_module.open_database(directory) as conn:
        conn.execute(
            """
            INSERT INTO project (project_id, name, source_file_name, source_sha256,
                                 page_count, created_at, updated_at, schema_version)
            VALUES (?, '拆分 bbox', 'p1.pdf', ?, 4, ?, ?, 2)
            """,
            (PROJECT_ID, "x" * 64, NOW, NOW),
        )
        conn.executemany(
            """
            INSERT INTO page (page_id, page_no, page_label, width_pt, height_pt, rotation,
                              page_type, include, has_text_layer)
            VALUES (?, ?, '', 595.0, 842.0, 0, 'body', 1, 1)
            """,
            [(f"page{page_no}", page_no) for page_no in CASES],
        )
        for page_no, case in CASES.items():
            block_id = new_ulid()
            block_ids[page_no] = block_id
            conn.execute(
                """
                INSERT INTO block (
                    block_id, page_id, origin, order_index, block_type, bbox, ocr_text, text,
                    created_at, updated_at
                ) VALUES (?, ?, 'ocr', 0, 'paragraph', ?, ?, ?, ?, ?)
                """,
                (
                    block_id,
                    f"page{page_no}",
                    json.dumps(case["bbox"]),
                    case["text"],
                    case["text"],
                    NOW,
                    NOW,
                ),
            )
            conn.executemany(
                """
                INSERT INTO block_line (line_id, block_id, line_index, bbox, text)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (new_ulid(), block_id, index, json.dumps(bbox), text)
                    for index, (text, bbox) in enumerate(case["lines"])
                ],
            )
        conn.commit()
    return tmp_path, block_ids


def test_page_number_on_the_last_text_line_keeps_its_own_height(tmp_path: Path) -> None:
    """p.1：切在最后一行时，页码块必须落在那行自己的竖向范围内、x 从切点开始。"""
    library, block_ids = _build_library(tmp_path)
    case = CASES[1]
    line1 = case["lines"][-1][1]

    records, _events, info = editing.split_off_page_number(
        PROJECT_ID, block_ids[1], library=library
    )
    head, tail = records[0], records[1]

    assert info["number"] == case["number"]
    assert info["position"] == case["position"]

    # ① 两块都有面积：高度 ≥ SPLIT_MIN_SIDE（修前 tail 高 0）
    assert head.bbox[3] - head.bbox[1] >= editing.SPLIT_MIN_SIDE
    assert tail.bbox[3] - tail.bbox[1] >= editing.SPLIT_MIN_SIDE, (
        f"页码块被压成一条线：{tail.bbox}"
    )
    assert tail.bbox[2] - tail.bbox[0] >= editing.SPLIT_MIN_SIDE

    # ② 页码块的竖向范围 = 它那一行的行框，不是整块 + 一条线
    assert tail.bbox[1] == pytest.approx(line1[1], abs=1e-6)
    assert tail.bbox[3] == pytest.approx(line1[3], abs=1e-6)
    # x 从切点开始，不再继承整块宽
    assert tail.bbox[0] > line1[0], f"页码块 x 还是从块左边开始：{tail.bbox}"
    assert tail.bbox[2] <= line1[2] + 1e-9

    # ③ 前块让出页码：两块不重叠，且共用同一条切线
    assert head.bbox[2] == tail.bbox[0]
    assert not _overlap(head.bbox, tail.bbox)
    assert head.text == "THE STORY OF\nTHE STONE"
    assert tail.text == "4"
    assert tail.block_type == "page_number"


@pytest.mark.parametrize("page_no", [32, 60, 88])
def test_control_pages_keep_their_fixture_bbox(tmp_path: Path, page_no: int) -> None:
    """其余三页的拆后 bbox / 文案与夹具逐字相同——修一个不许动三个。"""
    library, block_ids = _build_library(tmp_path)
    case = CASES[page_no]

    records, _events, _info = editing.split_off_page_number(
        PROJECT_ID, block_ids[page_no], library=library
    )
    head, tail = records[0], records[1]

    assert list(head.bbox) == pytest.approx(case["head_bbox"], abs=1e-9)
    assert list(tail.bbox) == pytest.approx(case["tail_bbox"], abs=1e-9)
    assert head.text == case["head_text"]
    assert tail.text == case["tail_text"]
