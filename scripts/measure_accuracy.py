#!/usr/bin/env python
"""对照金标准测准确率（CER / WER）。

金标准来自 `fixtures/gold/synthetic-corpus.json`（由 `make_gold_corpus.py` 生成）。
**这是合成语料**，结果代表"完美输入"下的上限，不代表真实扫描书——原因写在该脚本头部。

比对全部走 `core/ocr/compare.py`（说明书 8.7 规定的归一化与比对模块），
本脚本只负责取样与汇总。

运行前提：`uv sync --group ocr-eval`

用法::

    uv run python scripts/measure_accuracy.py
    uv run python scripts/measure_accuracy.py --dpi 200 --engine rapidocr
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image

from book2text.core.ocr import compare
from book2text.core.ocr.adapters import RapidOcrAdapter
from book2text.core.ocr.base import OcrParams

REPO_ROOT = Path(__file__).resolve().parents[1]
GOLD_PATH = REPO_ROOT / "fixtures" / "gold" / "synthetic-corpus.json"
DEFAULT_OUT = REPO_ROOT / "docs" / "accuracy-raw.json"


def join_page_text(lines: list[str]) -> str:
    """把一页的若干行拼成一段。

    用换行拼接，交给归一化处理：说明书 8.7 第 3 步会删掉中日韩字符之间的空格，
    所以**换行位置不同不会被算成错误**（中文）；英文的词间空格则保留。
    """
    return "\n".join(lines)


def _is_mostly_latin(line: str, threshold: float = 0.6) -> bool:
    """判断一行是否以拉丁字母为主。

    **为什么需要这个判断：** WER 按空白分词，而中文不用空格——对整篇中英混排文本
    直接算 WER 会得到毫无意义的数字（实测 42%）。因此 WER **只统计英文行**，
    中文部分的准确性由 CER 反映。
    """
    letters = sum(1 for char in line if char.isascii() and char.isalpha())
    stripped = [char for char in line if not char.isspace()]
    if not stripped:
        return False
    return letters / len(stripped) >= threshold


def measure(engine_name: str, dpi: int) -> dict:
    if not GOLD_PATH.is_file():
        raise SystemExit(f"找不到金标准：{GOLD_PATH}（先运行 scripts/make_gold_corpus.py）")

    gold = json.loads(GOLD_PATH.read_text(encoding="utf-8"))
    pdf_path = REPO_ROOT / gold["pdf_file"]

    if engine_name != "rapidocr":
        raise SystemExit(f"暂不支持的引擎：{engine_name}")
    adapter = RapidOcrAdapter()
    ok, reason = adapter.available()
    if not ok:
        raise SystemExit(f"引擎不可用：{reason}")

    document = pdfium.PdfDocument(str(pdf_path))
    pages: list[dict] = []
    english_gold: list[str] = []
    english_ocr: list[str] = []
    print(f"金标准 {gold['line_count']} 行 / {gold['char_count']} 字，PDF {gold['page_count']} 页 @ {dpi} DPI")
    print(f"引擎 {engine_name} {adapter.version()}\n")
    print(f"{'页':>3} {'行(金/识)':>11} {'字数':>6} {'严格':>8} {'8.7归一':>8} {'忽略空白':>9} {'整行对':>7} {'秒':>6}")
    print("-" * 76)

    for page_spec in gold["pages"]:
        page_no = page_spec["page"]
        gold_lines: list[str] = page_spec["lines"]

        page = document[page_no - 1]
        bitmap = page.render(scale=dpi / 72)
        image = bitmap.to_pil().convert("RGB")
        bitmap.close()
        page.close()

        started = time.perf_counter()
        result = adapter.recognize(image, OcrParams(dpi=dpi))
        elapsed = time.perf_counter() - started
        image.close()

        ocr_lines = [line.text for line in result.lines]
        gold_page_text = join_page_text(gold_lines)
        ocr_page_text = join_page_text(ocr_lines)

        # 严格：只统一空白，其余逐字符比对
        strict_gold = compare.unify_whitespace(gold_page_text, keep_newlines=False)
        strict_ocr = compare.unify_whitespace(ocr_page_text, keep_newlines=False)
        strict = compare.score_text(strict_gold, strict_ocr, compute_wer=False)

        # 归一化：按说明书 8.7 的第 1–4 步（格式差异不计为错误）
        norm_gold = compare.normalize_for_comparison(gold_page_text, keep_newlines=False)
        norm_ocr = compare.normalize_for_comparison(ocr_page_text, keep_newlines=False)
        normalized = compare.score_text(norm_gold, norm_ocr)

        # 忽略空白：额外的测量口径，用于剥离"中日韩/拉丁边界空格"这类排版差异
        # （说明书 8.7 未覆盖该边界，见 compare.normalize_whitespace_insensitive 的说明）
        nospace = compare.score_text(
            compare.normalize_whitespace_insensitive(norm_gold),
            compare.normalize_whitespace_insensitive(norm_ocr),
        )

        # 行级：仅当行数一致时逐行比对，否则如实标注"无法对齐"
        line_status = None
        exact_lines = None
        exact_lines_content = None
        if len(ocr_lines) == len(gold_lines):
            statuses = [
                compare.compare_line(g, o) for g, o in zip(gold_lines, ocr_lines)
            ]
            line_status = {
                "identical": statuses.count(compare.IDENTICAL),
                "format_only_differs": statuses.count(compare.FORMAT_ONLY_DIFFERS),
                "differs": statuses.count(compare.DIFFERS),
            }
            exact_lines = line_status["identical"]
            # 再算一个"忽略空白后整行一致"——空格问题会把前一个数字压得很低
            exact_lines_content = sum(
                1
                for gold_line, ocr_line in zip(gold_lines, ocr_lines)
                if compare.normalize_whitespace_insensitive(
                    compare.normalize_for_comparison(gold_line)
                )
                == compare.normalize_whitespace_insensitive(
                    compare.normalize_for_comparison(ocr_line)
                )
            )
            # 英文行单独收集，供 WER 使用（中文按空白分词没有意义）
            for gold_line, ocr_line in zip(gold_lines, ocr_lines):
                if _is_mostly_latin(gold_line):
                    english_gold.append(compare.normalize_for_comparison(gold_line))
                    english_ocr.append(compare.normalize_for_comparison(ocr_line))

        pages.append({
            "page": page_no,
            "gold_lines": len(gold_lines),
            "ocr_lines": len(ocr_lines),
            "lines_aligned": len(ocr_lines) == len(gold_lines),
            "strict": strict.to_dict(),
            "normalized": normalized.to_dict(),
            "whitespace_insensitive": nospace.to_dict(),
            "line_status": line_status,
            "exact_lines": exact_lines,
            "exact_lines_content": exact_lines_content,
            "elapsed_seconds": round(elapsed, 3),
            # 完整识别文本入档，便于事后审计而不必重跑 OCR
            "gold_text": gold_lines,
            "ocr_text": ocr_lines,
            "mismatched_examples": _examples(gold_lines, ocr_lines),
        })

        ratio = (
            f"{len(gold_lines)}/{len(ocr_lines)}" if len(ocr_lines) == len(gold_lines)
            else f"{len(gold_lines)}!={len(ocr_lines)}"
        )
        print(
            f"{page_no:>3} {ratio:>11} {strict.reference_chars:>6} "
            f"{strict.cer * 100:>8.3f}% {normalized.cer * 100:>8.3f}% "
            f"{nospace.cer * 100:>8.3f}% "
            f"{('—' if exact_lines is None else str(exact_lines)):>7} {elapsed:>6.2f}"
        )

    document.close()

    # 汇总：把各页的编辑距离相加再除以总字数——等价于"分页后累加"，
    # 与整篇一次性算略有差别（错误跨页时），在此注明。
    total_gold_chars = sum(p["strict"]["reference_chars"] for p in pages)
    strict_distance = sum(p["strict"]["distance"] for p in pages)
    norm_distance = sum(p["normalized"]["distance"] for p in pages)
    nospace_distance = sum(p["whitespace_insensitive"]["distance"] for p in pages)

    # WER 只对英文行计算（中文按空白分词没有意义）
    english_gold_text = " ".join(english_gold)
    english_ocr_text = " ".join(english_ocr)
    english_score = (
        compare.score_text(english_gold_text, english_ocr_text)
        if english_gold_text
        else None
    )

    aligned = [p for p in pages if p["lines_aligned"]]
    total_lines = sum(p["gold_lines"] for p in pages)
    total_exact = sum(p["exact_lines"] or 0 for p in aligned)
    aligned_lines = sum(p["gold_lines"] for p in aligned)
    total_exact_content = sum(p["exact_lines_content"] or 0 for p in aligned)

    summary = {
        "pages": len(pages),
        "gold_chars": total_gold_chars,
        "strict_cer": strict_distance / total_gold_chars if total_gold_chars else 0.0,
        "normalized_cer": norm_distance / total_gold_chars if total_gold_chars else 0.0,
        "whitespace_insensitive_cer": (
            nospace_distance / total_gold_chars if total_gold_chars else 0.0
        ),
        "english_gold_chars": len(english_gold_text),
        "english_gold_words": english_score.reference_words if english_score else 0,
        "english_cer": english_score.cer if english_score else None,
        "english_wer": english_score.wer if english_score else None,
        "gold_lines": total_lines,
        "pages_with_aligned_lines": len(aligned),
        "aligned_lines": aligned_lines,
        "exact_lines": total_exact,
        "exact_lines_content": total_exact_content,
        "line_accuracy": (total_exact / aligned_lines) if aligned_lines else None,
        "line_accuracy_content": (
            (total_exact_content / aligned_lines) if aligned_lines else None
        ),
        "ocr_seconds_total": round(sum(p["elapsed_seconds"] for p in pages), 2),
        "ocr_seconds_median": round(
            statistics.median([p["elapsed_seconds"] for p in pages]), 3
        ),
    }

    print("-" * 76)
    print(f"总字数 {summary['gold_chars']}")
    print(f"严格 CER（只统一空白）         {summary['strict_cer'] * 100:.3f}%")
    print(f"CER（说明书 8.7 归一化）       {summary['normalized_cer'] * 100:.3f}%")
    print(f"CER（忽略空白，内容准确率）    {summary['whitespace_insensitive_cer'] * 100:.3f}%")
    if summary["english_wer"] is not None:
        print(f"英文部分：CER {summary['english_cer'] * 100:.3f}%  "
              f"WER {summary['english_wer'] * 100:.3f}%  "
              f"（{summary['english_gold_words']} 词 / {summary['english_gold_chars']} 字）")
    if summary["line_accuracy"] is not None:
        print(f"整行完全一致（严格）        {summary['exact_lines']}/{summary['aligned_lines']} "
              f"= {summary['line_accuracy'] * 100:.2f}%")
        print(f"整行一致（忽略空白）        {summary['exact_lines_content']}/{summary['aligned_lines']} "
              f"= {summary['line_accuracy_content'] * 100:.2f}%"
              f"（{summary['pages_with_aligned_lines']}/{len(pages)} 页行数可对齐）")
    else:
        print("整行完全一致                无法对齐（识别行数与金标准不一致）")
    print(f"识别耗时 {summary['ocr_seconds_total']} 秒（中位 {summary['ocr_seconds_median']} 秒/页）")
    print()
    print("⚠ 这是**合成语料**：完美字体、无扫描退化。结果代表上限，不代表真实扫描书。")

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "scripts/measure_accuracy.py",
        "engine": engine_name,
        "engine_version": adapter.version(),
        "dpi": dpi,
        "gold_file": str(GOLD_PATH.relative_to(REPO_ROOT)),
        "pdf_file": gold["pdf_file"],
        "gold_kind": gold["kind"],
        "compare_module": "core/ocr/compare.py（说明书 8.7 的归一化步骤）",
        "caveats": [
            "金标准是合成语料，不是人工校对的真实扫描件",
            "结果代表完美输入下的上限，不能外推到真实旧书",
            "汇总 CER 由各页编辑距离累加得到，与整篇一次性计算略有差异（错误跨页时）",
            "行级统计仅在识别行数与金标准行数一致时计算；不一致的页不计入",
        ],
        "summary": summary,
        "pages": pages,
    }
    return payload


def _examples(gold_lines: list[str], ocr_lines: list[str], limit: int = 3) -> list[dict]:
    """挑几行差异示例，便于人工核对（不参与统计）。"""
    if len(gold_lines) != len(ocr_lines):
        return []
    out = []
    for index, (gold, ocr) in enumerate(zip(gold_lines, ocr_lines)):
        status = compare.compare_line(gold, ocr)
        if status != compare.IDENTICAL:
            out.append({"line": index + 1, "status": status, "gold": gold, "ocr": ocr})
            if len(out) >= limit:
                break
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="对照金标准测准确率")
    parser.add_argument("--engine", default="rapidocr")
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    payload = measure(args.engine, args.dpi)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n原始数据：{args.out.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
