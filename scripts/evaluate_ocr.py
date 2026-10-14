#!/usr/bin/env python
"""OCR 引擎评估脚本（说明书 Phase 0 第 1–2 项）。

在扫描样本上逐页跑识别，测量**门槛项**（行级坐标、每页耗时）与只记录不设门槛的
指标（内存、行数分布、置信度）。结果写成 JSON，供 `docs/ocr-evaluation.md` 引用，
保证文档里的数字可追溯到原始数据。

**不评估准确率**：那需要人工校对金标准，本脚本不生成金标准、也不猜 CER。

运行前提：先装评估依赖（选型未定，所以不放进核心依赖）::

    uv sync --group ocr-eval

用法::

    uv run python scripts/evaluate_ocr.py
    uv run python scripts/evaluate_ocr.py --engine rapidocr --dpi 300
"""

from __future__ import annotations

import argparse
import json
import platform
import resource
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pypdfium2 as pdfium

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLE_PDF = REPO_ROOT / "fixtures" / "pdf" / "sample-20p-300dpi.pdf"
MANIFEST = REPO_ROOT / "fixtures" / "pdf" / "sample-20p-300dpi.manifest.json"
DEFAULT_OUT = REPO_ROOT / "docs" / "ocr-evaluation-raw.json"

# 门槛来自 docs/ocr-evaluation.md 第 1 节（实测前写定）
GATE_PAGE_SECONDS = 18.0


def peak_memory_mb() -> float:
    # macOS 上 ru_maxrss 单位是字节，Linux 上是 KB。本脚本只在 macOS 上跑过。
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return usage / 1024 / 1024 if sys.platform == "darwin" else usage / 1024


def build_engine(name: str):
    if name == "rapidocr":
        from rapidocr import RapidOCR

        started = time.perf_counter()
        engine = RapidOCR()
        return engine, time.perf_counter() - started
    raise SystemExit(f"暂不支持的引擎：{name}（目前只接入了 rapidocr）")


def run(engine_name: str, dpi: int, out_path: Path) -> dict:
    if not SAMPLE_PDF.is_file():
        raise SystemExit(f"找不到样本：{SAMPLE_PDF}")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    pages_meta = {p["sample_page"]: p for p in manifest["pages"]}

    engine, init_seconds = build_engine(engine_name)
    document = pdfium.PdfDocument(str(SAMPLE_PDF))
    total_pages = len(document)

    page_records = []
    print(f"引擎 {engine_name} 初始化 {init_seconds:.2f} s；样本 {total_pages} 页 @ {dpi} DPI\n")
    print(f"{'页':>3} {'渲染(s)':>8} {'识别(s)':>8} {'行数':>5} {'均分':>6}  类别")
    print("-" * 78)

    for index in range(total_pages):
        page = document[index]
        try:
            render_start = time.perf_counter()
            bitmap = page.render(scale=dpi / 72)
            image = bitmap.to_pil().convert("RGB")
            render_seconds = time.perf_counter() - render_start
        finally:
            page.close()

        try:
            ocr_start = time.perf_counter()
            result = engine(image)
            ocr_seconds = time.perf_counter() - ocr_start
        finally:
            image.close()
            bitmap.close()

        boxes = getattr(result, "boxes", None)
        texts = list(getattr(result, "txts", None) or [])
        scores = [float(s) for s in (getattr(result, "scores", None) or [])]

        # G1 判据：每个文本行都有自己的坐标
        has_line_boxes = boxes is not None and len(boxes) == len(texts) and len(texts) > 0
        box_shape = None
        if boxes is not None and len(boxes):
            import numpy as np

            box_shape = list(np.asarray(boxes).shape)

        # 行高分布：从四点框推算，用于侧面核对"行"的粒度是否合理
        line_heights = []
        if boxes is not None:
            import numpy as np

            arr = np.asarray(boxes, dtype=float)
            if arr.ndim == 3 and arr.shape[1] == 4:
                line_heights = [
                    float(arr[i, :, 1].max() - arr[i, :, 1].min()) for i in range(arr.shape[0])
                ]

        meta = pages_meta.get(index + 1, {})
        record = {
            "sample_page": index + 1,
            "source_file": meta.get("source_file"),
            "source_page": meta.get("source_page"),
            "category": meta.get("category"),
            "render_seconds": round(render_seconds, 3),
            "ocr_seconds": round(ocr_seconds, 3),
            "line_count": len(texts),
            "has_line_boxes": has_line_boxes,
            "box_shape": box_shape,
            "score_mean": round(statistics.fmean(scores), 4) if scores else None,
            "score_min": round(min(scores), 4) if scores else None,
            "line_height_median": round(statistics.median(line_heights), 1) if line_heights else None,
            "first_lines": texts[:3],
        }
        page_records.append(record)

        flag = "" if ocr_seconds <= GATE_PAGE_SECONDS else "  ← 超门槛"
        print(
            f"{index + 1:>3} {render_seconds:>8.2f} {ocr_seconds:>8.2f} "
            f"{len(texts):>5} {record['score_mean'] if record['score_mean'] is not None else '-':>6}  "
            f"{(record['category'] or '')[:24]}{flag}"
        )

    document.close()

    ocr_times = [r["ocr_seconds"] for r in page_records]
    totals = {
        "pages": total_pages,
        "ocr_seconds_total": round(sum(ocr_times), 2),
        "ocr_seconds_median": round(statistics.median(ocr_times), 3),
        "ocr_seconds_max": round(max(ocr_times), 3),
        "ocr_seconds_min": round(min(ocr_times), 3),
        "render_seconds_total": round(sum(r["render_seconds"] for r in page_records), 2),
        "lines_total": sum(r["line_count"] for r in page_records),
        "pages_without_line_boxes": [
            r["sample_page"] for r in page_records if not r["has_line_boxes"]
        ],
    }

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "scripts/evaluate_ocr.py",
        "engine": engine_name,
        "engine_init_seconds": round(init_seconds, 3),
        "dpi": dpi,
        "sample": str(SAMPLE_PDF.relative_to(REPO_ROOT)),
        "platform": {
            "system": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "gates": {
            "G1_line_level_coordinates": {
                "criterion": "每个文本行都有自己的坐标",
                "passed": not totals["pages_without_line_boxes"],
                "detail": f"{totals['pages'] - len(totals['pages_without_line_boxes'])}/{totals['pages']} 页返回行级四点框",
            },
            "G2_seconds_per_page": {
                "criterion": f"≤ {GATE_PAGE_SECONDS} 秒/页",
                "passed": totals["ocr_seconds_max"] <= GATE_PAGE_SECONDS,
                "detail": f"最大 {totals['ocr_seconds_max']} 秒，中位 {totals['ocr_seconds_median']} 秒",
            },
        },
        "peak_memory_mb": round(peak_memory_mb(), 1),
        "model_files_bundled": "rapidocr 的 ONNX 模型随 wheel 内置，运行时无需联网下载",
        "not_measured": [
            "CER / 准确率（缺人工校对金标准）",
            "分歧率 / 捕获率（需第二引擎）",
            "Windows 平台（未在 Windows 上运行过）",
            "真实扫描件（样本是干净栅格化结果）",
        ],
        "totals": totals,
        "pages": page_records,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("-" * 78)
    print(f"识别耗时合计 {totals['ocr_seconds_total']} s（中位 {totals['ocr_seconds_median']} s/页，"
          f"最大 {totals['ocr_seconds_max']} s）")
    print(f"渲染耗时合计 {totals['render_seconds_total']} s")
    print(f"识别行数合计 {totals['lines_total']} 行")
    print(f"峰值内存 {payload['peak_memory_mb']} MB")
    print()
    for name, gate in payload["gates"].items():
        mark = "达标" if gate["passed"] else "未达标"
        print(f"  {name}: {mark} —— {gate['criterion']}；{gate['detail']}")
    print(f"\n原始数据：{out_path.relative_to(REPO_ROOT)}")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="OCR 引擎评估（门槛项测量）")
    parser.add_argument("--engine", default="rapidocr", help="引擎名（目前只支持 rapidocr）")
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    run(args.engine, args.dpi, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
