"""对比「只检测行框」与现有 OCR 行框（任务 58 的验收脚本）。

用法：

```bash
.venv/bin/python scripts/evaluate_layout_lines.py <项目目录> [--pages 3,9,16]
```

只读：不改数据库、不写项目文件。对每个有 active OCR run 的页，按那次运行的 DPI
渲染、跑 `RapidOcrDetAdapter.detect()`，再与 `block_line` 的 bbox 做 IoU ≥ 0.5
的贪心匹配，打印覆盖率、漏检 / 多检与四边偏差的中位数 / 95 分位。

**为什么用同一个 det 模型对比：** 现有 OCR 的行框也是 RapidOCR det 产出的，
同 DPI 下应当逐框一致；这组数字用来判断"按检测行裁图识别"在几何上是否可行。
换检测模型 / 换 DPI 后的一致性**不在本脚本结论内**。
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import sys
import time
from pathlib import Path

from book2text.core.layout.adapters import RapidOcrDetAdapter
from book2text.core.layout.base import LayoutParams
from book2text.core.pdf import render


def _iou(a, b) -> float:
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", type=Path)
    parser.add_argument("--pages", default="", help="逗号分隔的页码；默认全部已识别页")
    args = parser.parse_args(argv)

    project = args.project_dir
    source_dir = project / "source"
    pdfs = sorted(source_dir.glob("*.pdf"))
    if not pdfs:
        print(f"找不到源 PDF：{source_dir}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(project / "project.db")
    conn.row_factory = sqlite3.Row
    query = """
        SELECT p.page_no, r.params_json
        FROM page p JOIN ocr_run r ON r.run_id = p.active_run_id
        ORDER BY p.page_no
    """
    runs = conn.execute(query).fetchall()
    wanted = {int(value) for value in args.pages.split(",") if value.strip()}
    if wanted:
        runs = [row for row in runs if row["page_no"] in wanted]

    engine = RapidOcrDetAdapter()
    total_ocr = total_det = matched = 0
    deviations: list[float] = []
    print("页  OCR行  检测行  匹配  漏检  多检  偏差中位%  耗时s")
    for row in runs:
        page_no = int(row["page_no"])
        dpi = int(json.loads(row["params_json"]).get("dpi") or 200)
        ocr = [
            json.loads(item["bbox"])
            for item in conn.execute(
                """
                SELECT l.bbox FROM block_line l
                JOIN block b ON b.block_id = l.block_id
                JOIN page p ON p.page_id = b.page_id
                WHERE p.page_no = ? AND b.deleted_at IS NULL
                """,
                (page_no,),
            )
        ]
        image = render.render_page_image(pdfs[0], page_no - 1, dpi=dpi)
        try:
            started = time.perf_counter()
            result = engine.detect(image, LayoutParams(dpi=dpi))
            elapsed = time.perf_counter() - started
        finally:
            image.close()
        detected = [line.bbox.as_list() for line in result.lines]

        pairs = []
        for index, a in enumerate(ocr):
            for other, b in enumerate(detected):
                value = _iou(a, b)
                if value > 0:
                    pairs.append((value, index, other))
        pairs.sort(reverse=True)
        used_ocr: set[int] = set()
        used_det: set[int] = set()
        page_dev: list[float] = []
        for value, index, other in pairs:
            if value < 0.5:
                break
            if index in used_ocr or other in used_det:
                continue
            used_ocr.add(index)
            used_det.add(other)
            a, b = ocr[index], detected[other]
            page_dev.append(max(abs(a[k] - b[k]) for k in range(4)) * 100)

        total_ocr += len(ocr)
        total_det += len(detected)
        matched += len(used_ocr)
        deviations.extend(page_dev)
        print(
            f"{page_no:>3} {len(ocr):>6} {len(detected):>7} {len(used_ocr):>5} "
            f"{len(ocr) - len(used_ocr):>5} {len(detected) - len(used_det):>5} "
            f"{statistics.median(page_dev):>9.4f} {elapsed:>7.2f}"
        )

    if total_ocr:
        ordered = sorted(deviations)
        p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))] if ordered else 0.0
        print(
            f"\n合计：OCR {total_ocr} 行，检测 {total_det} 行，匹配 {matched}，"
            f"覆盖率 {matched / total_ocr:.4f}，漏检 {total_ocr - matched}，"
            f"多检 {total_det - matched}"
        )
        print(
            f"偏差：中位 {statistics.median(deviations):.4f} 百分点，"
            f"95 分位 {p95:.4f}，最大 {max(deviations):.4f}"
        )
    else:
        print("没有已识别的页可比对。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
