#!/usr/bin/env python
"""第二本书的块类型建议实测（任务 40）。

复算 `docs/region-classification-eval.md` 第 8 节里《导读巴赫金》的数字：

- 对每个已识别页调用 `core/project/structure.suggest_block_types()`（与
  `GET .../block-suggestions` 同一条路径）；
- 与人工分类的块对照（`scripts/region-suggestions-labels-bakhin.json`，
  只含页码 / 块序 / 块 id / 类别，不含原文；未列出的块 = body）；
- 输出派生统计：检出率、正文误标率、标题建议、页码候选是否命中。

**材料受版权保护**：本脚本只打印统计与页码 / 块序，不打印块文本。
标签按 `block_id` 校验，项目重新识别后块 id 变了会直接报错，不会静默错配。

用法::

    .venv/bin/python scripts/measure_block_suggestions.py \
        --out docs/region-suggestions-bakhin.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from book2text.core.project import blocks as blocks_module
from book2text.core.project import library as project_library
from book2text.core.project import structure

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ID = "book2text.block-suggestion-eval.v1"
LABELS_SCHEMA_ID = "book2text.block-suggestion-labels.v1"
DEFAULT_LABELS = REPO_ROOT / "scripts" / "region-suggestions-labels-bakhin.json"

FURNITURE = ("header", "footer", "page_number")


def rate(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description="块类型建议的第二本书实测")
    parser.add_argument("--library", type=Path,
                        default=project_library.default_library_dir())
    parser.add_argument("--project", help="缺省用标签文件里的 project_id")
    parser.add_argument("--labels", type=Path, default=DEFAULT_LABELS)
    parser.add_argument("--out", type=Path, help="汇总 JSON（只含派生统计）")
    args = parser.parse_args()

    payload = json.loads(args.labels.read_text(encoding="utf-8"))
    if payload.get("schema") != LABELS_SCHEMA_ID:
        raise SystemExit(f"标签文件 schema 不对：{payload.get('schema')!r}")
    project_id = args.project or payload["project_id"]
    pages = list(payload["pages"])
    labels = {(item["page"], item["order"]): item for item in payload["labels"]}

    blocks = [block for block in blocks_module.list_blocks(project_id, library=args.library)
              if block.page_no in pages]
    by_key = {(block.page_no, block.order_index): block for block in blocks}
    for key, label in labels.items():
        block = by_key.get(key)
        if block is None:
            raise SystemExit(f"标签指向的块不存在：第 {key[0]} 页第 {key[1]} 块")
        if block.block_id != label["block_id"]:
            raise SystemExit(
                f"块 id 对不上：第 {key[0]} 页第 {key[1]} 块（项目重新识别过？）"
            )

    suggestions: dict[tuple[int, int], structure.BlockSuggestion] = {}
    per_page: list[dict] = []
    for page_no in pages:
        plan = structure.suggest_block_types(project_id, page_no, library=args.library)
        per_page.append({
            "page_no": page_no,
            "blocks": plan.blocks_scanned,
            "suggestions": len(plan.suggestions),
            "by_type": {
                kind: sum(1 for item in plan.suggestions if item.suggested_type == kind)
                for kind in (*FURNITURE, "heading")
            },
        })
        for item in plan.suggestions:
            suggestions[(page_no, item.order_index)] = item

    counts = {category: 0 for category in (*FURNITURE, "heading", "body")}
    gold: dict[tuple[int, int], str] = {}
    for key in by_key:
        category = labels[key]["category"] if key in labels else "body"
        gold[key] = category
        counts[category] += 1

    detection = {}
    for category in (*FURNITURE, "heading"):
        matched = [item for key, item in suggestions.items()
                   if gold.get(key) == category and item.suggested_type == category]
        detection[category] = {
            "total": counts[category],
            "suggested": len(matched),
            "high": sum(1 for item in matched if item.confidence == "high"),
            "recall": rate(len(matched), counts[category]),
            "high_rate": rate(sum(1 for item in matched if item.confidence == "high"),
                              counts[category]),
        }

    body_keys = [key for key, category in gold.items() if category == "body"]
    body_furniture = [
        (key, item) for key, item in suggestions.items()
        if gold.get(key) == "body" and item.suggested_type in FURNITURE
    ]
    body_heading = [
        (key, item) for key, item in suggestions.items()
        if gold.get(key) == "body" and item.suggested_type == "heading"
    ]

    missed_furniture = [
        key for key, category in gold.items()
        if category in FURNITURE and key not in suggestions
    ]
    wrong_type = [
        (key, item) for key, item in suggestions.items()
        if gold.get(key) in FURNITURE and item.suggested_type != gold[key]
    ]

    # 页码候选：块里印的页码（header 里的 page_number 或 page_number 块本身）
    hint_rows = []
    for key, label in labels.items():
        expected = label.get("page_number")
        if not expected:
            continue
        item = suggestions.get(key)
        hint = item.page_number_hint.text if item and item.page_number_hint else None
        hint_rows.append({
            "page": key[0],
            "order": key[1],
            "suggested_type": item.suggested_type if item else None,
            "expected": expected,
            "hint": hint,
            "ok": bool(hint) and hint.casefold() == expected.casefold(),
            "candidates": [c.text for c in item.page_number_candidates] if item else [],
            "candidates_ok": (
                [c.text for c in item.page_number_candidates] == label["candidates"]
                if item and "candidates" in label else None
            ),
        })

    summary = {
        "schema": SCHEMA_ID,
        "project_id": project_id,
        "pdf_file": payload.get("pdf_file"),
        "dpi": payload.get("dpi"),
        "pages": len(pages),
        "blocks": len(blocks),
        "counts": counts,
        "suggestions": len(suggestions),
        "detection": detection,
        "mislabel": {
            "body_total": len(body_keys),
            "to_furniture": len(body_furniture),
            "to_furniture_rate": rate(len(body_furniture), len(body_keys)),
            "to_heading": len(body_heading),
            "to_heading_rate": rate(len(body_heading), len(body_keys)),
        },
        "missed_furniture": [
            {"page": key[0], "order": key[1], "gold": gold[key]} for key in missed_furniture
        ],
        "wrong_type": [
            {"page": key[0], "order": key[1], "gold": gold[key],
             "suggested_type": item.suggested_type}
            for key, item in wrong_type
        ],
        "hints": hint_rows,
        "hint_ok": sum(1 for row in hint_rows if row["ok"]),
        "hint_total": len(hint_rows),
        "per_page": per_page,
    }

    print(f"{project_id} · {len(pages)} 页 / {len(blocks)} 块 · 建议 {len(suggestions)} 条\n")
    print("页  块  建议  页眉 页码 标题")
    for row in per_page:
        by_type = row["by_type"]
        print(f"{row['page_no']:>2} {row['blocks']:>3} {row['suggestions']:>4}"
              f" {by_type['header']:>5} {by_type['page_number']:>4} {by_type['heading']:>4}")
    print("\n金标准类别：" + " · ".join(f"{k} {v}" for k, v in counts.items()))
    for category, item in detection.items():
        print(f"检出 {category:<11} {item['suggested']}/{item['total']}"
              f"（{item['recall']:.1%}）· high {item['high']}（{item['high_rate']:.1%}）")
    print(f"正文误标（→页眉/页脚/页码） {len(body_furniture)}/{len(body_keys)}"
          f"（{rate(len(body_furniture), len(body_keys)):.2%}）")
    print(f"正文误标（→标题）           {len(body_heading)}/{len(body_keys)}"
          f"（{rate(len(body_heading), len(body_keys)):.2%}）")
    print(f"漏标（边缘家具）             {len(missed_furniture)}/{sum(counts[c] for c in FURNITURE)}")
    print(f"页码提示命中                 {summary['hint_ok']}/{summary['hint_total']}")
    for row in hint_rows:
        if not row["ok"]:
            print(f"  未命中：第 {row['page']} 页第 {row['order']} 块"
                  f"（expected={row['expected']} hint={row['hint']}）")

    if args.out:
        args.out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
        print(f"\n汇总写到 {args.out}（只含派生统计）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
