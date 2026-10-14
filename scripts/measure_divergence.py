#!/usr/bin/env python
"""双路分歧测量（说明书 8.5 / 8.7）：把**产品里的口径**搬到真书上复算。

**为什么要有这个脚本。** 产品里报的"分歧率 / 汉字级 / 标点级"是**读取时现算**的
（见 `docs/decisions.md` D-039 / D-041），口径绑在 `core/ocr/compare.py` 的
`grade_line()` 上；而 `docs/ocr-evaluation.md` 第 8 节的离线测量当初用的是另一套归属统计。
两个口径要能对上，否则"产品里 5% 分歧"和"实测 29% 分歧"看起来像两个世界。

本脚本给出**同一口径下**的三类数字：

1. **分歧率**（原始 / 分级）——只需要两个引擎，**不需要金标准**；
2. **捕获率**（第一引擎的错行中，被标为分歧的比例；分汉字级 / 标点级）；
3. **"一致但都错"** 的比例（两路结果一致、但都与金标准不同——最危险的一类）。

后两项需要 `--gold`：一份**人工核对过**的分页文本，页间用 `〔PDF 第 N 页〕` 标记。
页面文本与 OCR 行之间用"前缀 + 后缀定位"对齐（见 `locate_in_gold`），
定不到位的行单独计数，**不混进分母**——否则对齐失败会被误当成识别错误。

**版权：** 输出只有派生统计；逐行明细只在显式给 `--details` 时写，且默认写到系统临时目录
（受版权保护的书不能进仓库，见 `.gitignore` 与 `docs/known-limitations.md`）。

运行前提：`uv sync --group ocr-eval`（第一引擎）+ macOS 的 pyobjc（第二引擎）。

用法::

    uv run python scripts/measure_divergence.py --pdf gold_standard/<书>_图像版.pdf --dpi 200
    uv run python scripts/measure_divergence.py --pdf ... --gold gold_standard/<书>_分页草稿.txt
    uv run python scripts/measure_divergence.py --pdf ... --pages 1-10 --details /tmp/lines.json
"""

from __future__ import annotations

import argparse
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import pypdfium2 as pdfium

from book2text.core.ocr import compare
from book2text.core.ocr.adapters import RapidOcrAdapter
from book2text.core.ocr.adapters.apple_vision import AppleVisionAdapter
from book2text.core.ocr.base import BBox, OcrParams
from book2text.core.pdf import render
from book2text.core.project.recognition import AUX_LINE_PADDING

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_ID = "book2text.divergence-measure.v1"
DEFAULT_DPI = 200
PAGE_MARKER = re.compile(r"^〔PDF 第\s*(\d+)\s*页〕\s*$")
# 定位时最少要匹配几个字：太短（1–2 字）会在整页里乱撞
MIN_ANCHOR = 4


# ---------------------------------------------------------------- 金标准

def load_gold_pages(path: Path) -> dict[int, str]:
    """把带 `〔PDF 第 N 页〕` 标记的金标准文本切成 {页码: 该页文本}。

    标记之前的抬头说明（如"本文件由…"）不属于任何一页，自动丢掉。
    """
    pages: dict[int, str] = {}
    current: int | None = None
    buffer: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        marker = PAGE_MARKER.match(line.strip())
        if marker:
            if current is not None:
                pages[current] = "\n".join(buffer).strip()
            current = int(marker.group(1))
            buffer = []
            continue
        if current is not None:
            buffer.append(line)
    if current is not None:
        pages[current] = "\n".join(buffer).strip()
    return pages


def search_key(text: str) -> str:
    """定位用的"骨架"：按说明书 8.7 归一化后去掉**所有**空白。

    换行、空格、全角半角都不参与定位——它们不影响"这一段在原文的哪里"。
    """
    normalized = compare.normalize_for_comparison(text, keep_newlines=False)
    return compare.normalize_whitespace_insensitive(normalized)


def locate_in_gold(line: str, gold_key: str, cursor: int) -> tuple[int, int] | None:
    """把一行定位到该页金标准里的一段，返回 `(start, end)`；定不到返回 None。

    做法：先找**前缀**（从整行往短了试，第一引擎开头就错时也能对上），
    再从找到的位置往后找**后缀**，两点之间就是这一行对应的原文区间。
    后缀找不到时退化成"取与这一行等长的一段"。

    ``cursor`` 是页内已消耗到的位置：OCR 行是阅读顺序，从上次的位置往后找，
    避免同一段被反复匹配。
    """
    key = search_key(line)
    if len(key) < MIN_ANCHOR:
        return None
    start = -1
    for size in range(len(key), MIN_ANCHOR - 1, -1):
        at = gold_key.find(key[:size], cursor)
        if at < 0:
            at = gold_key.find(key[:size])  # 允许回跳（分栏、错序）
        if at >= 0:
            start = at
            break
    if start < 0:
        return None
    if len(key) >= MIN_ANCHOR * 2:
        tail = gold_key.find(key[-MIN_ANCHOR:], start + MIN_ANCHOR)
        if tail >= 0:
            return start, tail + MIN_ANCHOR
    return start, min(start + len(key), len(gold_key))


# ---------------------------------------------------------------- 测量

def _grade(text: str, gold_key: str, span: tuple[int, int]) -> str | None:
    """这一行相对金标准的错误等级；对（或只有格式差异）返回 None。"""
    level = compare.grade_line(gold_key[span[0] : span[1]], search_key(text))
    return level if level in (compare.DIFFERS_CHARS, compare.DIFFERS_PUNCT) else None


def _blank_divergence() -> dict[str, int]:
    return {
        compare.IDENTICAL: 0,
        compare.FORMAT_ONLY_DIFFERS: 0,
        compare.DIFFERS_CHARS: 0,
        compare.DIFFERS_PUNCT: 0,
        compare.NO_CANDIDATE: 0,
    }


def measure_page(
    image,
    *,
    first_engine,
    second_engine,
    dpi: int,
    gold_text: str | None,
) -> dict:
    """测一页：第一引擎识别 → 逐行裁图 → 第二引擎 → 比对（可选：与金标准归属）。"""
    result = first_engine.recognize(image, OcrParams(dpi=dpi))
    divergence = _blank_divergence()
    attribution = {
        "both_ok": 0,
        "first_wrong_second_ok": 0,   # 第二引擎把第一引擎的错改对了
        "first_ok_second_wrong": 0,   # 第二引擎自己的错（按它的错误等级分）
        "both_wrong": 0,
        "both_wrong_agree": 0,        # 一致但都错：最危险的一类
        "both_wrong_disagree": 0,
        "located": 0,
        "unlocated": 0,
    }
    # 按等级细分（"汉字级"是不是比"标点级"更值得看，要靠这几组数字回答）
    by_grade = {
        "flagged": {compare.DIFFERS_CHARS: 0, compare.DIFFERS_PUNCT: 0},
        "rescue": {compare.DIFFERS_CHARS: 0, compare.DIFFERS_PUNCT: 0},
        "both_wrong_agree": {compare.DIFFERS_CHARS: 0, compare.DIFFERS_PUNCT: 0},
        "both_wrong_disagree": {compare.DIFFERS_CHARS: 0, compare.DIFFERS_PUNCT: 0},
    }
    capture = {"flagged": {compare.DIFFERS_CHARS: 0, compare.DIFFERS_PUNCT: 0},
               "total": {compare.DIFFERS_CHARS: 0, compare.DIFFERS_PUNCT: 0}}
    first_errors = {"total": 0, "chars": 0, "punct": 0}
    second_errors = {"total": 0, "chars": 0, "punct": 0}
    details: list[dict] = []

    gold_key = search_key(gold_text) if gold_text else ""
    cursor = 0

    for line in result.lines:
        first_text = line.text
        second_text = ""
        if line.bbox is not None:
            crop = _crop(image, line.bbox, dpi=dpi)
            try:
                second_text = _read_one_line(second_engine, crop)
            finally:
                crop.close()

        level = (
            compare.NO_CANDIDATE
            if not second_text.strip()
            else compare.grade_line(first_text, second_text)
        )
        divergence[level] = divergence.get(level, 0) + 1
        flagged = level in (compare.DIFFERS_CHARS, compare.DIFFERS_PUNCT)
        if flagged:
            by_grade["flagged"][level] += 1

        if not gold_key:
            continue
        span = locate_in_gold(first_text, gold_key, cursor)
        if span is None:
            attribution["unlocated"] += 1
            continue
        cursor = span[0]
        attribution["located"] += 1

        first_err = _grade(first_text, gold_key, span)
        second_err = _grade(second_text, gold_key, span) if second_text else "empty"
        if first_err is not None:
            first_errors["total"] += 1
            first_errors["chars" if first_err == compare.DIFFERS_CHARS else "punct"] += 1
            capture["total"][first_err] += 1
            if flagged:
                capture["flagged"][first_err] += 1
        if second_err not in (None, "empty"):
            second_errors["total"] += 1
            second_errors["chars" if second_err == compare.DIFFERS_CHARS else "punct"] += 1

        if first_err is None and second_err in (None, "empty"):
            attribution["both_ok"] += 1
        elif first_err is not None and second_err in (None, "empty"):
            attribution["first_wrong_second_ok"] += 1
            by_grade["rescue"][first_err] += 1
        elif first_err is None:
            attribution["first_ok_second_wrong"] += 1
        else:
            attribution["both_wrong"] += 1
            agreeing = not flagged
            attribution["both_wrong_agree" if agreeing else "both_wrong_disagree"] += 1
            key = "both_wrong_agree" if agreeing else "both_wrong_disagree"
            by_grade[key][first_err] += 1

        details.append({
            "first_text": first_text,
            "second_text": second_text,
            "level": level,
            "first_err": first_err,
            "second_err": second_err,
        })

    return {
        "lines": len(result.lines),
        "divergence": divergence,
        "attribution": attribution,
        "by_grade": by_grade,
        "capture": capture,
        "first_errors": first_errors,
        "second_errors": second_errors,
        "details": details,
    }


def _crop(image, bbox: BBox, *, dpi: int):
    """按行框裁一张小图（与产品里的 `run_auxiliary` 同一做法：外扩 2%）。"""
    width, height = image.size
    expanded = bbox.expanded(AUX_LINE_PADDING)
    x0 = max(0, int(expanded.x0 * width) - 2)
    y0 = max(0, int(expanded.y0 * height) - 2)
    x1 = min(width, int(expanded.x1 * width) + 2)
    y1 = min(height, int(expanded.y1 * height) + 2)
    return image.crop((x0, y0, x1, y1))


def _read_one_line(engine, crop) -> str:
    """一张行图 → 一行文本（与 `recognition._read_one_line` 同规则：取最长的一段）。"""
    try:
        result = engine.recognize(crop, OcrParams(dpi=0))
    except Exception:  # noqa: BLE001 - 单行失败不该中断整轮测量
        return ""
    texts = [line.text.strip() for line in result.lines if line.text.strip()]
    return max(texts, key=len) if texts else ""


def _parse_pages(spec: str | None, total: int) -> list[int]:
    if not spec:
        return list(range(1, total + 1))
    pages: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if "-" in chunk:
            start, end = chunk.split("-", 1)
            pages.extend(range(int(start), int(end) + 1))
        elif chunk:
            pages.append(int(chunk))
    return [page for page in pages if 1 <= page <= total]


def _sum(pages: list[dict], field: str, key: str | None = None) -> int:
    if key is None:
        return sum(page[field] for page in pages)
    return sum(page[field][key] for page in pages)


def main() -> int:
    parser = argparse.ArgumentParser(description="双路分歧测量（说明书 8.5 / 8.7 的口径）")
    parser.add_argument("--pdf", required=True, help="书页图像版 PDF（本地文件，不入库）")
    parser.add_argument("--gold", help="分页金标准文本（页间用〔PDF 第 N 页〕标记）")
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI, help=f"渲染 DPI（默认 {DEFAULT_DPI}）")
    parser.add_argument("--pages", help="只测这些页，如 1-10,15")
    parser.add_argument("--out", help="汇总 JSON 写到这里（只含派生统计）")
    parser.add_argument("--details", help="逐行明细写到这个文件（默认不写；勿写进仓库）")
    args = parser.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.is_file():
        raise SystemExit(f"找不到 PDF：{pdf_path}")

    first = RapidOcrAdapter()
    ok, reason = first.available()
    if not ok:
        raise SystemExit(f"第一引擎不可用：{reason}")
    second = AppleVisionAdapter()
    ok, reason = second.available()
    if not ok:
        raise SystemExit(f"第二引擎不可用：{reason}")

    document = pdfium.PdfDocument(str(pdf_path))
    page_numbers = _parse_pages(args.pages, len(document))
    gold_pages = load_gold_pages(Path(args.gold)) if args.gold else {}
    if args.gold:
        missing = [no for no in page_numbers if no not in gold_pages]
        if missing:
            print(f"注意：金标准里没有这些页，它们只算分歧不算归属：{missing}")

    print(f"{pdf_path.name} · {len(page_numbers)} 页 @ {args.dpi} DPI · "
          f"第一引擎 {first.engine_id} {first.version()} · 第二引擎 {second.engine_id} {second.version()}")

    started = time.perf_counter()
    results: list[dict] = []
    all_details: dict[str, list[dict]] = {}
    for page_no in page_numbers:
        image = render.render_page_image(pdf_path, page_no - 1, dpi=args.dpi)
        try:
            page = measure_page(
                image,
                first_engine=first,
                second_engine=second,
                dpi=args.dpi,
                gold_text=gold_pages.get(page_no),
            )
        finally:
            image.close()
        results.append(page)
        all_details[str(page_no)] = page.pop("details")
        attribution = page["attribution"]
        note = f" 归属 对{attribution['both_ok']}/捕{attribution['first_wrong_second_ok']}" \
               f"/二错{attribution['first_ok_second_wrong']}/都错{attribution['both_wrong']}" \
               if gold_pages else ""
        print(f"  第 {page_no:>3} 页 {page['lines']:>3} 行 · "
              f"分歧 {page['divergence'][compare.DIFFERS_CHARS] + page['divergence'][compare.DIFFERS_PUNCT]:>3}"
              f"（汉字级 {page['divergence'][compare.DIFFERS_CHARS]}"
              f" · 标点级 {page['divergence'][compare.DIFFERS_PUNCT]}）{note}")

    elapsed = time.perf_counter() - started
    lines = _sum(results, "lines")
    divergence = {level: _sum(results, "divergence", level) for level in _blank_divergence()}
    compared = (
        divergence[compare.IDENTICAL]
        + divergence[compare.FORMAT_ONLY_DIFFERS]
        + divergence[compare.DIFFERS_CHARS]
        + divergence[compare.DIFFERS_PUNCT]
    )
    diverging = divergence[compare.DIFFERS_CHARS] + divergence[compare.DIFFERS_PUNCT]

    summary: dict = {
        "schema": SCHEMA_ID,
        "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pdf_file": pdf_path.name,          # 只记文件名：材料本身受版权保护，不入库
        "dpi": args.dpi,
        "engine_first": f"{first.engine_id} {first.version()}",
        "engine_second": f"{second.engine_id} {second.version()}",
        "pages": len(page_numbers),
        "lines": lines,
        "elapsed_seconds": round(elapsed, 1),
        "divergence": {
            **divergence,
            "compared": compared,
            "diverging": diverging,
            "diverging_rate": round(diverging / compared, 4) if compared else 0.0,
            "chars_rate": round(divergence[compare.DIFFERS_CHARS] / compared, 4) if compared else 0.0,
            "punct_rate": round(divergence[compare.DIFFERS_PUNCT] / compared, 4) if compared else 0.0,
            "empty_rate": round(divergence[compare.NO_CANDIDATE] / lines, 4) if lines else 0.0,
        },
    }
    if gold_pages:
        attribution = {key: _sum(results, "attribution", key) for key in results[0]["attribution"]}
        capture = {
            "flagged": {
                level: sum(page["capture"]["flagged"][level] for page in results)
                for level in (compare.DIFFERS_CHARS, compare.DIFFERS_PUNCT)
            },
            "total": {
                level: sum(page["capture"]["total"][level] for page in results)
                for level in (compare.DIFFERS_CHARS, compare.DIFFERS_PUNCT)
            },
        }
        first_errors = {key: _sum(results, "first_errors", key) for key in results[0]["first_errors"]}
        second_errors = {key: _sum(results, "second_errors", key) for key in results[0]["second_errors"]}
        located = attribution["located"]
        flagged_total = (
            capture["flagged"][compare.DIFFERS_CHARS] + capture["flagged"][compare.DIFFERS_PUNCT]
        )
        rescue_chars = sum(page["by_grade"]["rescue"][compare.DIFFERS_CHARS] for page in results)
        rescue_punct = sum(page["by_grade"]["rescue"][compare.DIFFERS_PUNCT] for page in results)
        summary["gold"] = {
            "page_markers": len(gold_pages),
            "located_lines": located,
            "unlocated_lines": attribution["unlocated"],
            "attribution": attribution,
            "attribution_rate": {
                key: round(attribution[key] / located, 4) if located else 0.0
                for key in ("both_ok", "first_wrong_second_ok", "first_ok_second_wrong",
                            "both_wrong", "both_wrong_agree", "both_wrong_disagree")
            },
            "by_grade": {
                key: {level: sum(page["by_grade"][key][level] for page in results)
                      for level in (compare.DIFFERS_CHARS, compare.DIFFERS_PUNCT)}
                for key in ("flagged", "rescue", "both_wrong_agree", "both_wrong_disagree")
            },
            "capture_rate": {
                "overall": round(flagged_total / max(first_errors["total"], 1), 4),
                "chars": round(
                    capture["flagged"][compare.DIFFERS_CHARS] / max(first_errors["chars"], 1), 4
                ),
                "punct": round(
                    capture["flagged"][compare.DIFFERS_PUNCT] / max(first_errors["punct"], 1), 4
                ),
                "first_errors": first_errors,
                "second_errors": second_errors,
            },
            # 第二引擎把第一引擎的错**改对**的比例——与捕获率不是一回事（见文档第 9 节）
            "rescue_rate": {
                "chars": round(rescue_chars / max(first_errors["chars"], 1), 4),
                "punct": round(rescue_punct / max(first_errors["punct"], 1), 4),
            },
        }

    print("\n—— 汇总 ——")
    print(f"行数 {lines} · 一致 {divergence[compare.IDENTICAL]} · 仅格式 {divergence[compare.FORMAT_ONLY_DIFFERS]}"
          f" · 汉字级 {divergence[compare.DIFFERS_CHARS]} · 标点级 {divergence[compare.DIFFERS_PUNCT]}"
          f" · 没读出 {divergence[compare.NO_CANDIDATE]}")
    print(f"分歧率 {summary['divergence']['diverging_rate']:.2%}"
          f"（汉字级 {summary['divergence']['chars_rate']:.2%} · 标点级 {summary['divergence']['punct_rate']:.2%}）"
          f" · 分母是能比的行 {compared}")
    if gold_pages:
        rate = summary["gold"]["attribution_rate"]
        capture = summary["gold"]["capture_rate"]
        grades = summary["gold"]["by_grade"]
        rescue = summary["gold"]["rescue_rate"]
        print(f"可定位 {summary['gold']['located_lines']} 行（定不到 {summary['gold']['unlocated_lines']}）"
              f" · 两路都对 {rate['both_ok']:.1%} · 第一引擎错第二引擎对 {rate['first_wrong_second_ok']:.1%}"
              f" · 第一引擎对第二引擎错 {rate['first_ok_second_wrong']:.1%}"
              f" · 都错 {rate['both_wrong']:.1%}（其中两路一致 {rate['both_wrong_agree']:.1%}）")
        print(f"捕获率（说明书 8.7：第一引擎的错行被标为分歧的比例）：总体 {capture['overall']:.1%}"
              f"（汉字级 {capture['chars']:.1%} 于 {capture['first_errors']['chars']} 行，"
              f"标点级 {capture['punct']:.1%} 于 {capture['first_errors']['punct']} 行）")
        print(f"改对率（第二引擎把第一引擎的错改对的比例）：汉字级 {rescue['chars']:.1%} · "
              f"标点级 {rescue['punct']:.1%}")
        print(f"汉字级分歧 {grades['flagged'][compare.DIFFERS_CHARS]} 行 · 标点级分歧 "
              f"{grades['flagged'][compare.DIFFERS_PUNCT]} 行")
        print(f"第一引擎错 {capture['first_errors']['total']} 行 · 第二引擎错 {capture['second_errors']['total']} 行")
    print(f"用时 {elapsed:.1f} 秒")

    if args.out:
        out_path = Path(args.out)
        out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"汇总写到 {out_path}")
    if args.details:
        details_path = Path(args.details)
        details_path.write_text(
            json.dumps(all_details, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"逐行明细写到 {details_path}（含原文，别放进仓库）")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
