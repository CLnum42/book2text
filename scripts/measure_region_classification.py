#!/usr/bin/env python
"""行级版面归属判定：在 40 页真书上量"判得准不准"（离线实验）。

**这个脚本回答一个问题。** 产品现在的页眉 / 页脚 / 页码标注是**块级、在分段之后**做的
（`core/project/structure.py`），风险是页眉行与正文首行被拼进同一个块、整块被判成正文。
计划改成**行级、在分组之前**剔除。但在改产品之前，得先知道：只靠几何 + 跨页重复 +
文字形态三类信号，行级判得准不准？

**做法。**

1. **复现行集合**：与产品同一条路径——`core/pdf/render.py` 渲染 200 DPI，
   `RapidOCR` 适配器识别——拿到每行的 bbox 与文本。渲染 / 识别都不另写一套，
   否则结论无法迁移到产品。
2. **行级金标准**：OCR 行与按页标注的金标准文本对齐（前缀 + 后缀锚点，与
   `scripts/measure_divergence.py` 同一套 `locate_in_gold`），匹配上的判正文；
   匹配不上的**逐条人工分类**（`--labels` 指定的文件，页码 + 行号 + 类别，不含原文）。
3. **判定器**：`core/structure/regions.py` 的纯函数（几何 / 跨页重复 / 文字形态，
   输出 high / review 两档）。规则的唯一实现在产品代码里；`scripts/region_rules.py`
   只是 re-export 的兼容层（`scripts/` 不进打包，产品不能反过来 import 它）。
4. **度量**：各类检出率、正文误标率、非正文漏标率、剔除后正文 CER，
   以及失败案例清单。

**版权。** 仓库里只有派生统计：页码、类别、行号、比例、行文本的 8 位指纹。
逐行明细（含原文）只在显式给 `--details` 时写；"匹配不上"的审阅清单默认写到
系统临时目录。**不要**把含原文的明细放进仓库。
`docs/known-limitations.md` 与 `.gitignore` 有同样的约定。

**金标准的两个已知口径问题（本脚本处理了，报告里要写明）：**

- `金标准文本_分页草稿.txt` 在第一个 `〔PDF 第 N 页〕` 标记之前就是第 1 页，
  而 `measure_divergence.load_gold_pages` 会把这段丢掉；本脚本单独处理。
- 这份分页草稿**不含三处章首回目**（第 1 / 14 / 25 页），但全文金标准里有，
  且开发者已确认回目属于正文（`docs/ocr-evaluation.md` 6.2）。因此：
  对齐用分页草稿（回目会被判成"匹配不上"，由人工标 heading）；
  算 CER 用**全文金标准**（含回目），否则"剔除后正文 CER"会因为金标准本身缺字而虚高。

运行前提：`uv sync --group dev --group ocr-eval`（与 `evaluate_ocr.py` 相同）。

用法::

    # 第一次：识别 40 页并检查"匹配不上"的行（会写一份临时审阅清单）
    .venv/bin/python scripts/measure_region_classification.py

    # 按审阅清单人工分类，写进 labels 文件后重跑
    .venv/bin/python scripts/measure_region_classification.py --labels scripts/region-labels-hongloumeng-40p.json

    # 复跑不重新识别（OCR 结果缓存在系统临时目录）
    .venv/bin/python scripts/measure_region_classification.py --labels ... --out docs/region-classification-raw.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

# 复用既有的对齐口径（前缀 + 后缀锚点）：不另写一套定位器，否则两处会漂。
from measure_divergence import locate_in_gold, search_key  # noqa: E402

import region_rules  # noqa: E402
from book2text.core.ocr import compare  # noqa: E402
from book2text.core.ocr.adapters import RapidOcrAdapter  # noqa: E402
from book2text.core.ocr.base import OcrParams  # noqa: E402
from book2text.core.pdf import render  # noqa: E402

SCHEMA_ID = "book2text.region-classification.v1"
LABELS_SCHEMA_ID = "book2text.region-labels.v1"
DEFAULT_DPI = 200
DEFAULT_PDF = REPO_ROOT / "gold_standard" / "红楼梦第一卷_正文前40页_图像版.pdf"
DEFAULT_GOLD_DRAFT = (
    REPO_ROOT / "gold_standard" / "红楼梦第一卷_正文前40页_金标准文本_分页草稿.txt"
)
DEFAULT_GOLD_FULL = REPO_ROOT / "gold_standard" / "红楼梦第一卷_正文前40页_金标准文本.txt"
DEFAULT_LABELS = REPO_ROOT / "scripts" / "region-labels-hongloumeng-40p.json"

PAGE_MARKER = re.compile(r"^〔PDF 第\s*(\d+)\s*页〕\s*$")
# 分页草稿的抬头说明到这一行结束（下一行起是正文）
PREAMBLE_END = "原文件："

# 金标准类别。header / footer / page_number / other 是"页面上印的、但不是正文的东西"；
# heading 是正文结构，不算页眉页脚，**不能自动剔除**；body_missing 是金标准漏收的正文。
CATEGORY_HEADER = "header"
CATEGORY_FOOTER = "footer"
CATEGORY_PAGE_NUMBER = "page_number"
CATEGORY_HEADING = "heading"
CATEGORY_OTHER = "other"
CATEGORY_BODY = "body"
# 匹配不上、但人工确认是正文的行（金标准里有，只是对齐失败：短行、首字识别错、
# 全角括号没归一化等）。任务给的分类里没有这一档，单列出来，算进"正文"组。
CATEGORY_BODY_ALIGNED_MISS = "body_unaligned"
CATEGORY_BODY_MISSING = "body_missing"

GOLD_CATEGORIES = (
    CATEGORY_BODY,
    CATEGORY_BODY_ALIGNED_MISS,
    CATEGORY_BODY_MISSING,
    CATEGORY_HEADER,
    CATEGORY_FOOTER,
    CATEGORY_PAGE_NUMBER,
    CATEGORY_HEADING,
    CATEGORY_OTHER,
)
# 判"正文被误标"时，金标准漏收的正文也算正文（不能因为它不在金标准里就随便删）
BODY_GROUP = frozenset({CATEGORY_BODY, CATEGORY_BODY_ALIGNED_MISS, CATEGORY_BODY_MISSING})
# 该被剔除的页眉页脚页码
FURNITURE = frozenset({CATEGORY_HEADER, CATEGORY_FOOTER, CATEGORY_PAGE_NUMBER})


# ---------------------------------------------------------------- 金标准


def load_paged_gold(path: Path) -> dict[int, str]:
    """按 `〔PDF 第 N 页〕` 标记切分页金标准，**并把第一个标记之前的内容算作第 1 页**。

    分页草稿只有 39 个页边界（40 页之间），第 1 页没有标记；抬头说明（"本文件由
    Book2Text 按 OCR 对齐自动生成……"）不属于正文。两者用 `原文件：` 那一行分开。
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip().startswith(PREAMBLE_END):
            start = index + 1
            break
    if start is None:
        raise SystemExit(f"分页金标准里找不到抬头结束标记「{PREAMBLE_END}」：{path}")

    pages: dict[int, str] = {}
    current = 1
    buffer: list[str] = []
    for line in lines[start:]:
        marker = PAGE_MARKER.match(line.strip())
        if marker:
            if current in pages:
                raise SystemExit(f"分页金标准里页码重复：第 {current} 页")
            pages[current] = "\n".join(buffer).strip()
            current = int(marker.group(1))
            buffer = []
            continue
        buffer.append(line)
    pages[current] = "\n".join(buffer).strip()
    return pages


def gold_char_count(text: str) -> int:
    """去空白后的字数（与文档里"20060 字（去空白）"同一口径）。"""
    return len("".join(char for char in text if not char.isspace()))


# ---------------------------------------------------------------- OCR（缓存）


def _cache_path() -> Path:
    return Path(tempfile.gettempdir()) / "book2text-region-eval" / "ocr-lines.json"


def _ocr_pages(pdf_path: Path, dpi: int, adapter: RapidOcrAdapter,
               page_numbers: list[int]) -> dict:
    """用产品同一条路径渲染 + 识别，返回可缓存的原始结构。"""
    pages: list[dict] = []
    started = time.perf_counter()
    for page_no in page_numbers:
        image = render.render_page_image(pdf_path, page_no - 1, dpi=dpi)
        try:
            result = adapter.recognize(image, OcrParams(dpi=dpi))
            width, height = image.size
        finally:
            image.close()
        lines = []
        for line in result.lines:
            bbox = line.bbox
            lines.append({
                "text": line.text,
                "bbox": [bbox.x0, bbox.y0, bbox.x1, bbox.y1],
                "confidence": line.confidence,
            })
        # 阅读顺序：先上下、再左右。行级判定不依赖顺序；CER 的拼接需要它。
        lines.sort(key=lambda item: (item["bbox"][1], item["bbox"][0]))
        pages.append({
            "page_no": page_no,
            "width": width,
            "height": height,
            "lines": [{"index": index, **item} for index, item in enumerate(lines)],
        })
        print(f"  第 {page_no:>2} 页 · {len(lines):>2} 行 · {result.elapsed_seconds:.2f}s")
    return {
        "schema": SCHEMA_ID,
        "pdf_file": pdf_path.name,
        "dpi": dpi,
        "engine": f"{adapter.engine_id} {adapter.version()}",
        "pages": pages,
        "elapsed_seconds": round(time.perf_counter() - started, 1),
    }


def load_or_create_cache(pdf_path: Path, dpi: int, adapter: RapidOcrAdapter,
                         cache_path: Path, refresh: bool) -> dict:
    if cache_path.is_file() and not refresh:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if (cached.get("pdf_file") == pdf_path.name
                and cached.get("dpi") == dpi
                and cached.get("engine") == f"{adapter.engine_id} {adapter.version()}"):
            print(f"复用 OCR 缓存：{cache_path}（{cached['elapsed_seconds']}s）")
            return cached
        print("缓存与本次参数不符，重新识别")
    page_count = render.info(pdf_path).page_count
    print(f"{pdf_path.name} · {page_count} 页 @ {dpi} DPI · 第一引擎 {adapter.engine_id} "
          f"{adapter.version()}")
    cached = _ocr_pages(pdf_path, dpi, adapter, list(range(1, page_count + 1)))
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cached, ensure_ascii=False), encoding="utf-8")
    print(f"OCR 结果缓存到 {cache_path}（含原文，勿入仓库）")
    return cached


# ---------------------------------------------------------------- 对齐与标签


def build_page_lines(cached: dict) -> list[region_rules.PageLines]:
    pages = []
    for page in cached["pages"]:
        lines = tuple(
            region_rules.Line(text=item["text"], bbox=tuple(item["bbox"]))
            for item in page["lines"]
        )
        pages.append(region_rules.PageLines(page_no=page["page_no"], lines=lines))
    return pages


def align_to_gold(pages: list[region_rules.PageLines],
                  gold_pages: dict[int, str]) -> dict[tuple[int, int], tuple[int, int]]:
    """把每一行定位到该页金标准，返回 `{(page, index): (start, end)}`。

    定位口径与 `measure_divergence.py` 相同：前缀 + 后缀锚点，游标推进到本行的起点
    （允许轻微回跳）；短于 4 个字的行（页码、`红楼梦`、`第一回`）按设计定不到——
    它们正是要人工分类的。
    """
    located: dict[tuple[int, int], tuple[int, int]] = {}
    for page in pages:
        gold_text = gold_pages.get(page.page_no)
        if not gold_text:
            continue
        gold_key = search_key(gold_text)
        cursor = 0
        for index, line in enumerate(page.lines):
            span = locate_in_gold(line.text, gold_key, cursor)
            if span is None:
                continue
            cursor = span[0]  # 与 measure_divergence 一致：允许行间轻微回跳
            located[(page.page_no, index)] = span
    return located


def text_hash(text: str) -> str:
    """行文本的短指纹（只用于校验"标签对的是同一行"，不泄露原文）。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


def load_labels(path: Path) -> dict[tuple[int, int], dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != LABELS_SCHEMA_ID:
        raise SystemExit(f"标签文件 schema 不对：{payload.get('schema')!r}")
    labels: dict[tuple[int, int], dict] = {}
    for item in payload.get("labels", []):
        key = (int(item["page"]), int(item["line"]))
        category = item["category"]
        if category not in GOLD_CATEGORIES:
            raise SystemExit(f"未知类别 {category!r}：{key}")
        if key in labels:
            raise SystemExit(f"同一行标了两次：{key}")
        labels[key] = {"category": category, "text_hash": item.get("text_hash")}
    return labels


def build_gold_categories(pages: list[region_rules.PageLines],
                          located: dict[tuple[int, int], tuple[int, int]],
                          labels: dict[tuple[int, int], dict],
                          review_path: Path | None) -> tuple[dict[tuple[int, int], str],
                                                              list[dict]]:
    """给每一行定金标准类别；有匹配不上、又没标签的行就写审阅清单并要求补。"""
    categories: dict[tuple[int, int], str] = {}
    unlabeled: list[dict] = []
    for page in pages:
        for index, line in enumerate(page.lines):
            key = (page.page_no, index)
            if key in labels:
                label = labels[key]
                expected = label.get("text_hash")
                if expected and expected != text_hash(line.text):
                    raise SystemExit(
                        f"标签与本次 OCR 结果对不上：第 {key[0]} 页第 {key[1]} 行"
                        f"（指纹 {expected} != {text_hash(line.text)}）。"
                        "行号可能因 OCR 版本 / 平台漂移，请按 --review-dump 重新核对。"
                    )
                categories[key] = label["category"]
            elif key in located:
                categories[key] = CATEGORY_BODY
            else:
                unlabeled.append({
                    "page": page.page_no,
                    "line": index,
                    "bbox": [round(value, 4) for value in line.bbox],
                    "chars": len(line.text.strip()),
                    "text": line.text,
                })
    if unlabeled:
        destination = review_path or (
            Path(tempfile.gettempdir()) / "book2text-region-eval" / "review-unlocated.txt")
        destination.parent.mkdir(parents=True, exist_ok=True)
        rows = ["page\tline\tx0\ty0\tx1\ty1\tchars\ttext"]
        for item in unlabeled:
            rows.append(
                f"{item['page']}\t{item['line']}\t{item['bbox'][0]}\t{item['bbox'][1]}\t"
                f"{item['bbox'][2]}\t{item['bbox'][3]}\t{item['chars']}\t{item['text']}"
            )
        destination.write_text("\n".join(rows) + "\n", encoding="utf-8")
        print(f"\n有 {len(unlabeled)} 行匹配不上金标准，需要逐条人工分类。")
        print(f"审阅清单（含原文，系统临时目录）：{destination}")
        raise SystemExit(2)
    return categories, unlabeled


# ---------------------------------------------------------------- 度量


def _operating_point(verdict: region_rules.Verdict, point: str) -> bool:
    """这一行在这个操作点上是否会被自动剔除。"""
    if not verdict.is_non_body:
        return False
    if point == "high":
        return verdict.confidence == region_rules.CONFIDENCE_HIGH
    return True


def _blank_matrix(categories: list[str]) -> dict[str, dict[str, int]]:
    kinds = ["body", "header", "footer", "page_number"]
    return {category: {kind: 0 for kind in kinds} for category in categories}


def measure(pages: list[region_rules.PageLines],
            verdicts: list[region_rules.Verdict],
            categories: dict[tuple[int, int], str]) -> dict:
    verdict_by_key = {(verdict.page_no, verdict.index): verdict for verdict in verdicts}

    counts = {category: 0 for category in GOLD_CATEGORIES}
    confusion = _blank_matrix(list(GOLD_CATEGORIES))
    flagged_high = {category: 0 for category in GOLD_CATEGORIES}
    flagged_any = {category: 0 for category in GOLD_CATEGORIES}
    failures: dict[str, list[dict]] = {
        "mislabeled_body": [],     # 正文被自动剔除（最严重）
        "leaked_furniture": [],    # 非正文留在正文里
        "wrong_type": [],          # 判成别的家具类型（如页眉判成页脚）
        "heading_removed": [],     # 回目被自动剔除
    }

    for page in pages:
        for index, line in enumerate(page.lines):
            key = (page.page_no, index)
            category = categories[key]
            verdict = verdict_by_key[key]
            counts[category] += 1
            predicted = "body" if not verdict.is_non_body else verdict.kind
            confusion[category][predicted] += 1
            high = _operating_point(verdict, "high")
            any_flagged = _operating_point(verdict, "all")
            if high:
                flagged_high[category] += 1
            if any_flagged:
                flagged_any[category] += 1

            case = {
                "page": page.page_no,
                "line": index,
                "gold": category,
                "predicted": predicted,
                "confidence": verdict.confidence,
                "region": verdict.region,
                "signals": list(verdict.signals),
                "quote": line.text.strip()[:12],
            }
            if high and category in BODY_GROUP:
                failures["mislabeled_body"].append(case)
            if category in FURNITURE and not high:
                failures["leaked_furniture"].append(case)
            if category in FURNITURE and high and predicted != category:
                failures["wrong_type"].append(case)
            if category == CATEGORY_HEADING and high:
                failures["heading_removed"].append(case)

    body_total = sum(counts[category] for category in BODY_GROUP)
    furniture_total = sum(counts[category] for category in FURNITURE)

    def rate(numerator: int, denominator: int) -> float:
        return round(numerator / denominator, 4) if denominator else 0.0

    detection = {}
    for category in GOLD_CATEGORIES:
        detection[category] = {
            "total": counts[category],
            "high": flagged_high[category],
            "any_confidence": flagged_any[category],
            "high_rate": rate(flagged_high[category], counts[category]),
            "any_rate": rate(flagged_any[category], counts[category]),
        }

    return {
        "counts": counts,
        "confusion": confusion,
        "detection": detection,
        "mislabel": {
            "body_total": body_total,
            "high": len(failures["mislabeled_body"]),
            "high_rate": rate(len(failures["mislabeled_body"]), body_total),
            "all_confidence": sum(flagged_any[category] for category in BODY_GROUP),
            "all_confidence_rate": rate(
                sum(flagged_any[category] for category in BODY_GROUP), body_total),
        },
        "leak": {
            "furniture_total": furniture_total,
            "high": len(failures["leaked_furniture"]),
            "high_rate": rate(len(failures["leaked_furniture"]), furniture_total),
            "all_confidence": furniture_total - sum(
                flagged_any[category] for category in FURNITURE),
            "all_confidence_rate": rate(
                furniture_total - sum(flagged_any[category] for category in FURNITURE),
                furniture_total),
        },
        "heading": {
            "total": counts[CATEGORY_HEADING],
            "flagged_high": flagged_high[CATEGORY_HEADING],
            "flagged_any": flagged_any[CATEGORY_HEADING],
        },
        "failures": failures,
    }


def _cer(reference: str, hypothesis: str) -> dict:
    """按 `ocr-evaluation.md` 6.3 的口径：8.7 归一化后再去全部空白。"""
    reference_key = compare.normalize_whitespace_insensitive(
        compare.normalize_for_comparison(reference, keep_newlines=False))
    hypothesis_key = compare.normalize_whitespace_insensitive(
        compare.normalize_for_comparison(hypothesis, keep_newlines=False))
    distance = compare.levenshtein(reference_key, hypothesis_key)
    return {
        "cer": round(distance / len(reference_key), 4) if reference_key else 0.0,
        "distance": distance,
        "reference_chars": len(reference_key),
        "hypothesis_chars": len(hypothesis_key),
    }


def measure_cer(pages: list[region_rules.PageLines],
                verdicts: list[region_rules.Verdict],
                gold_full_text: str) -> dict:
    """剔除前后各算一次正文 CER。

    - ``before``：所有 OCR 行（书眉、页码都在里面）——当前产品块级规则之前的水平；
    - ``after_high``：只剔除 high 置信度的 header / footer / page_number
      （建议的操作点：review 留给人看）；
    - ``after_all``：连 review 也剔除——演示"把位置候选全自动应用"的代价。
    """
    verdict_by_key = {(verdict.page_no, verdict.index): verdict for verdict in verdicts}
    texts = {"before": [], "after_high": [], "after_all": []}
    for page in pages:
        for index, line in enumerate(page.lines):
            verdict = verdict_by_key[(page.page_no, index)]
            texts["before"].append(line.text)
            if not _operating_point(verdict, "high"):
                texts["after_high"].append(line.text)
            if not _operating_point(verdict, "all"):
                texts["after_all"].append(line.text)
    return {
        point: _cer(gold_full_text, "\n".join(lines))
        for point, lines in texts.items()
    }


def measure_export_cer(pages: list[region_rules.PageLines],
                       verdicts: list[region_rules.Verdict],
                       gold_full_text: str) -> dict:
    """按**导出路径**再算一遍 CER，用来和 `docs/ocr-evaluation.md` 的 0.71% 对比。

    行级口径（上面的 `measure_cer`）与导出路径的差别不只是"去不去掉书眉"：

    - 导出路径**先分组、再按块**判页眉页脚（`core/project/structure.py` 的
      页面比例规则 + high / review），然后块内用 `join_lines` 拼成段落；
    - 本函数用**同一批 OCR 行**在内存里复现这条路径：`group_lines` 分块、
      `structure` 的块级规则剔块、`join_lines` 拼段。不建项目、不写库、不改产品。

    三行结果：

    - ``export_before``：不剔除；
    - ``export_blocks``：**现状**——块级、分组之后、只剔 high；
    - ``export_lines``：**拟改**——行级、分组之前、只剔 high（剔除后重新分组）。
    """
    from book2text.core.export.joining import join_lines
    from book2text.core.ocr.base import BBox, OcrLine
    from book2text.core.project import structure
    from book2text.core.structure.grouping import group_lines

    verdict_by_key = {(verdict.page_no, verdict.index): verdict for verdict in verdicts}

    def to_ocr_lines(page: region_rules.PageLines, keep) -> list[OcrLine]:
        lines = []
        for index, line in enumerate(page.lines):
            if not keep(verdict_by_key[(page.page_no, index)]):
                continue
            lines.append(OcrLine(text=line.text, bbox=BBox(*line.bbox)))
        return lines

    def export(layouts) -> str:
        chunks = []
        for _page_no, blocks in layouts:
            for block in blocks:
                chunks.append(join_lines([line.text for line in block.lines]).text)
        return "\n".join(chunks)

    everything = lambda verdict: True  # noqa: E731 - 局部小谓词，不值得命名
    high_only = lambda verdict: not _operating_point(verdict, "high")  # noqa: E731

    layouts_before = [
        (page.page_no, group_lines(to_ocr_lines(page, everything)).blocks)
        for page in pages
    ]
    layouts_lines = [
        (page.page_no, group_lines(to_ocr_lines(page, high_only)).blocks)
        for page in pages
    ]

    # 现状的块级规则：与产品同一条路径（私有函数直接复用，保证口径一致）
    rules = structure.HeaderFooterRules()
    candidates: list[structure.Candidate] = []
    for page_no, blocks in layouts_before:
        for order, block in enumerate(blocks):
            if block.bbox is None:
                continue
            bbox = (block.bbox.x0, block.bbox.y0, block.bbox.x1, block.bbox.y1)
            region = structure._region_of(bbox, rules)
            if region is None:
                continue
            text = block.text.strip()
            if rules.max_chars is not None and len(text) > rules.max_chars:
                continue
            proposed, reason = structure._propose(text, region, rules)
            candidates.append(structure.Candidate(
                block_id=f"{page_no}-{order}", page_no=page_no, text=text, bbox=bbox,
                current_type="paragraph", proposed_type=proposed, region=region,
                reason=reason,
            ))
    high_ids = {
        candidate.block_id
        for candidate in structure._with_confidence(candidates)
        if candidate.confidence == structure.CONFIDENCE_HIGH
    }
    layouts_blocks = []
    for page_no, blocks in layouts_before:
        kept = [block for order, block in enumerate(blocks)
                if f"{page_no}-{order}" not in high_ids]
        layouts_blocks.append((page_no, kept))

    candidates_total = len(candidates)
    return {
        "export_before": _cer(gold_full_text, export(layouts_before)),
        "export_blocks": _cer(gold_full_text, export(layouts_blocks)),
        "export_lines": _cer(gold_full_text, export(layouts_lines)),
        "block_candidates": candidates_total,
        "block_high": len(high_ids),
        "blocks_total": sum(len(blocks) for _, blocks in layouts_before),
    }


# ---------------------------------------------------------------- 主流程


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


def main() -> int:
    parser = argparse.ArgumentParser(description="行级版面归属判定测量（离线实验）")
    parser.add_argument("--pdf", type=Path, default=DEFAULT_PDF)
    parser.add_argument("--gold-draft", type=Path, default=DEFAULT_GOLD_DRAFT,
                        help="按页标注的金标准（含回目缺口，用于对齐）")
    parser.add_argument("--gold-full", type=Path, default=DEFAULT_GOLD_FULL,
                        help="全文金标准（含回目，用于 CER）")
    parser.add_argument("--labels", type=Path, default=DEFAULT_LABELS,
                        help="人工分类结果（页码 + 行号 + 类别，不含原文）")
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    parser.add_argument("--pages", help="只测这些页，如 1-10")
    parser.add_argument("--cache", type=Path, default=_cache_path(),
                        help="OCR 缓存（含原文，默认系统临时目录）")
    parser.add_argument("--refresh", action="store_true", help="忽略缓存重新识别")
    parser.add_argument("--review-dump", type=Path,
                        help="匹配不上的行的审阅清单写到这里（含原文）")
    parser.add_argument("--out", type=Path, help="汇总 JSON 写到这里（只含派生统计）")
    parser.add_argument("--details", type=Path,
                        help="逐行明细写到这里（含原文；默认不写，勿放进仓库）")
    parser.add_argument("--skip-cer", action="store_true",
                        help="跳过 CER（整篇逐字编辑距离约 1 分钟/次，调试分类时可跳过）")
    args = parser.parse_args()

    if not args.pdf.is_file():
        raise SystemExit(f"找不到 PDF：{args.pdf}")
    if not args.gold_draft.is_file():
        raise SystemExit(f"找不到分页金标准：{args.gold_draft}")
    if not args.gold_full.is_file():
        raise SystemExit(f"找不到全文金标准：{args.gold_full}")

    adapter = RapidOcrAdapter()
    available, reason = adapter.available()
    if not available:
        raise SystemExit(f"RapidOCR 不可用：{reason}")

    cached = load_or_create_cache(args.pdf, args.dpi, adapter, args.cache, args.refresh)
    wanted = set(_parse_pages(args.pages, len(cached["pages"])))
    cached["pages"] = [page for page in cached["pages"] if page["page_no"] in wanted]

    pages = build_page_lines(cached)
    gold_pages = load_paged_gold(args.gold_draft)
    missing_gold = [page.page_no for page in pages if page.page_no not in gold_pages]
    if missing_gold:
        raise SystemExit(f"分页金标准缺这些页：{missing_gold}")
    gold_full_text = args.gold_full.read_text(encoding="utf-8")

    located = align_to_gold(pages, gold_pages)
    labels = load_labels(args.labels) if args.labels.is_file() else {}
    if not labels:
        print(f"没有标签文件（{args.labels}），所有匹配不上的行都需要人工分类")
    categories, _ = build_gold_categories(pages, located, labels, args.review_dump)

    rules = region_rules.Rules()
    started = time.perf_counter()
    verdicts = region_rules.classify_pages(pages, rules)
    classify_seconds = time.perf_counter() - started

    result = measure(pages, verdicts, categories)
    if args.skip_cer:
        result["cer"] = {}
        result["cer_export"] = {}
    else:
        result["cer"] = measure_cer(pages, verdicts, gold_full_text)
        result["cer_export"] = measure_export_cer(pages, verdicts, gold_full_text)

    lines_total = sum(len(page.lines) for page in pages)
    summary = {
        "schema": SCHEMA_ID,
        "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pdf_file": args.pdf.name,
        "dpi": args.dpi,
        "engine": cached["engine"],
        "pages": len(pages),
        "lines": lines_total,
        "located_lines": len(located),
        "manual_labels": len(labels),
        "ocr_seconds": cached.get("elapsed_seconds"),
        "classify_seconds": round(classify_seconds, 3),
        "rules": rules.to_dict(),
        "gold": {
            "paged_chars": gold_char_count("".join(gold_pages.values())),
            "full_text_chars": gold_char_count(gold_full_text),
            "heading_gap_chars": gold_char_count(gold_full_text)
            - gold_char_count("".join(gold_pages.values())),
        },
        **result,
    }

    print("\n—— 汇总 ——")
    print(f"{summary['pages']} 页 · {summary['lines']} 行 · 对齐上 {len(located)} 行 · "
          f"人工分类 {len(labels)} 行")
    print("金标准类别：" + " · ".join(
        f"{category} {count}" for category, count in result["counts"].items()))
    detection = result["detection"]
    for category in (CATEGORY_HEADER, CATEGORY_FOOTER, CATEGORY_PAGE_NUMBER, CATEGORY_HEADING):
        print(f"检出率 {category:<11} high {detection[category]['high']}/"
              f"{detection[category]['total']}（{detection[category]['high_rate']:.1%}）"
              f" · 含 review {detection[category]['any_rate']:.1%}")
    print(f"正文误标率（只剔 high）      {result['mislabel']['high']}/"
          f"{result['mislabel']['body_total']}（{result['mislabel']['high_rate']:.2%}）")
    print(f"正文误标率（high + review）  {result['mislabel']['all_confidence']}/"
          f"{result['mislabel']['body_total']}（{result['mislabel']['all_confidence_rate']:.2%}）")
    print(f"非正文漏标率（只剔 high）    {result['leak']['high']}/"
          f"{result['leak']['furniture_total']}（{result['leak']['high_rate']:.2%}）")
    for point in ("before", "after_high", "after_all"):
        cer = result["cer"].get(point)
        if cer:
            print(f"正文 CER {point:<11} {cer['cer']:.2%}"
                  f"（{cer['distance']} / {cer['reference_chars']} 字）")
    export = result["cer_export"]
    if export:
        print(f"导出路径 CER（复现）：before {export['export_before']['cer']:.2%} · "
              f"块级现状 {export['export_blocks']['cer']:.2%} · "
              f"行级拟改 {export['export_lines']['cer']:.2%}"
              f"（块级候选 {export['block_candidates']}，high {export['block_high']}）")

    if args.out:
        args.out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
        print(f"汇总写到 {args.out}（只含派生统计）")
    if args.details:
        rows = []
        verdict_by_key = {(v.page_no, v.index): v for v in verdicts}
        for page in pages:
            for index, line in enumerate(page.lines):
                verdict = verdict_by_key[(page.page_no, index)]
                rows.append({
                    "page": page.page_no,
                    "line": index,
                    "text": line.text,
                    "bbox": [round(value, 4) for value in line.bbox],
                    "gold": categories[(page.page_no, index)],
                    "predicted": verdict.kind,
                    "confidence": verdict.confidence,
                    "region": verdict.region,
                    "signals": list(verdict.signals),
                })
        args.details.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8")
        print(f"逐行明细写到 {args.details}（含原文，勿放进仓库）")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
