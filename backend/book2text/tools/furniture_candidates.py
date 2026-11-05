"""页边重复候选：命令行清单（2026-11-05）。

只读、不落库、不改块类型——产品口径是"候选 + 人工确认"。

    PYTHONPATH=backend .venv/bin/python -m book2text.tools.furniture_candidates \
        --project b2t_YR5EJ0
    ... --json          # 机器可读
    ... --library DIR   # 库目录（默认 ~/Documents/Book2Text）
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ..core.project import furniture_candidates as candidates
from ..core.project import library as library_module


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="页边重复候选清单（只读）")
    parser.add_argument("--project", required=True)
    parser.add_argument("--library")
    parser.add_argument("--json", action="store_true", help="输出 JSON（默认人读表格）")
    args = parser.parse_args(argv)

    library = (
        library_module.default_library_dir()
        if args.library is None
        else Path(args.library)
    )
    rows = candidates.collect(args.project, library=library)
    meta = candidates.band_basis(args.project, library=library)
    if args.json:
        print(json.dumps({"candidates": rows, **meta}, ensure_ascii=False, indent=2))
        return 0
    print(
        f"项目 {args.project}：body 页 {meta['pages']}"
        f"（有版心 {meta['with_margin']} / 默认页边带 {meta['default_band']}）；候选 {len(rows)} 个"
    )
    for row in rows:
        note = "（默认页边带）" if row["used_default_band"] else ""
        print(
            f"  [{row['band']}/{row['parity']}] {row['count']} 页 / {row['lines']} 行"
            f"  → {row['suggested_type']}  置信 {row['confidence']}{note}"
        )
        print(f"      模板：{row['template']}")
        print(f"      样例：{row['sample_text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
