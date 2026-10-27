"""字框回填（任务 59）：给已有的行补上逐字 / 逐词框。

**只写 `block_line.word_boxes`，别的字段一个都不碰。** 红楼梦 3 上有 F 刀的跨页延续、
M 刀的字符规范化、394 页版心——重跑识别有把它们冲掉的风险，所以已有项目走回填：
拿一次识别的**行结果**（或可搜索 PDF 的文字层），按 **bbox IoU + 文本相似度**把结果行
配到已有的 `block_line`，只把字框写进去。

三条约定（验收会逐条核对）：

1. 已有人工成果一律不碰：`text` / `aux_text` / `diff_status` / `diff_ack` /
   `continues_to_next` / `continues_reviewed` / 块类型 / 版心，全都不写。
2. 配不上的行**跳过并计数**，不硬塞（宁可这行没有字框，也不要错位的字框）。
3. 可中断可续：只处理 `word_boxes IS NULL` 的行，分批调用即可续跑；
   第一次写入前把 `project.db` 备份到 `backups/`。
"""

from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from ..ocr.adapters import RapidOcrAdapter
from ..ocr.base import OcrParams
from ..pdf import render
from ..storage import db as db_module
from . import library as library_module

WORD_BOXES_SCHEMA = "book2text.word-boxes.v1"

# 配对门槛：文本相似度为主，bbox IoU 作为验证与加分
MATCH_MIN_SIMILARITY = 0.35
MATCH_MIN_IOU = 0.5
MATCH_TEXT_WEIGHT = 0.7
MATCH_IOU_WEIGHT = 0.3

# 估时（本机实测，200 DPI）：跑一次识别 ~4.6 秒/页；读文字层 ~0.02 秒/页
OCR_SECONDS_PER_PAGE = 4.6
TEXT_LAYER_SECONDS_PER_PAGE = 0.02


@dataclass(frozen=True)
class CandidateLine:
    """一次识别的行（或文字层的一行）：文本 + 行框 + 行内字 / 词框。"""

    text: str
    bbox: tuple[float, float, float, float] | None
    words: tuple[tuple[str, tuple[float, float, float, float], float | None], ...]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _normalize(text: str) -> str:
    return "".join(ch.lower() for ch in (text or "") if not ch.isspace())


def _similarity(left: str, right: str) -> float:
    a, b = _normalize(left), _normalize(right)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _iou(left, right) -> float:
    if not left or not right:
        return 0.0
    x0 = max(left[0], right[0])
    y0 = max(left[1], right[1])
    x1 = min(left[2], right[2])
    y1 = min(left[3], right[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    area_a = max((left[2] - left[0]) * (left[3] - left[1]), 0.0)
    area_b = max((right[2] - right[0]) * (right[3] - right[1]), 0.0)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def match_lines(
    rows: list[dict], candidates: list[CandidateLine]
) -> dict[int, CandidateLine]:
    """把候选行配给已有行：阅读顺序 + 文本相似度为主，IoU 加分与验证。

    ``rows`` 每项需要有 ``text`` 与 ``bbox``（归一化）；返回 ``{行下标: 候选}``。
    """
    if not rows or not candidates:
        return {}
    n, m = len(rows), len(candidates)
    gap = -0.12
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i * gap
    for j in range(1, m + 1):
        dp[0][j] = j * gap

    def score(row: dict, cand: CandidateLine) -> tuple[float, float, float]:
        sim = _similarity(row.get("text") or "", cand.text)
        iou = _iou(row.get("bbox"), cand.bbox)
        return MATCH_TEXT_WEIGHT * sim + MATCH_IOU_WEIGHT * iou - 0.2, sim, iou

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            value, sim, iou = score(rows[i - 1], candidates[j - 1])
            best = max(dp[i - 1][j] + gap, dp[i][j - 1] + gap)
            if sim >= MATCH_MIN_SIMILARITY or iou >= MATCH_MIN_IOU:
                best = max(best, dp[i - 1][j - 1] + value)
            dp[i][j] = best

    pairs: dict[int, int] = {}
    i, j = n, m
    while i > 0 and j > 0:
        value, sim, iou = score(rows[i - 1], candidates[j - 1])
        acceptable = sim >= MATCH_MIN_SIMILARITY or iou >= MATCH_MIN_IOU
        if acceptable and abs(dp[i][j] - (dp[i - 1][j - 1] + value)) < 1e-9:
            pairs[i - 1] = j - 1
            i -= 1
            j -= 1
        elif abs(dp[i][j] - (dp[i - 1][j] + gap)) < 1e-9:
            i -= 1
        else:
            j -= 1
    return {index: candidates[pairs[index]] for index in pairs}


def _word_boxes_json(cand: CandidateLine) -> str | None:
    if not cand.words:
        return None
    return json.dumps(
        [
            {
                "text": text,
                "bbox": [round(value, 5) for value in bbox],
                "confidence": None if confidence is None else round(float(confidence), 4),
            }
            for text, bbox, confidence in cand.words
        ],
        ensure_ascii=False,
    )


# ---------------------------------------------------------------- 数据准备


def _box_from_json(raw) -> tuple[float, float, float, float] | None:
    try:
        values = json.loads(raw) if isinstance(raw, str) else raw
        if not values or len(values) != 4:
            return None
        return tuple(float(value) for value in values)
    except (TypeError, ValueError):
        return None


def _text_layer_candidates(
    source: Path, page_index: int
) -> list[CandidateLine]:
    """可搜索 PDF：字框直接从文字层取（pypdfium2 的逐字框），不跑 OCR。"""
    lines = render.page_text_chars(source, page_index)
    if not lines:
        return []
    # 退化文字层（不可见文字的零高度字符框）不当字框用：那种框画不出色块、
    # 也定位不了字。回退识别（见 `backfill` 里的分支）。
    heights = [
        abs(char_bbox[3] - char_bbox[1])
        for _text, _bbox, units in lines
        for _char, char_bbox in units
    ]
    if heights:
        real = sum(1 for height in heights if height > 0.002)
        if real / len(heights) < 0.5:
            return []
    return [
        CandidateLine(
            text=text,
            bbox=bbox,
            words=tuple((char, char_bbox, None) for char, char_bbox in chars),
        )
        for text, bbox, chars in lines
    ]


def text_layer_usable(source: Path, page_index: int) -> bool:
    """这一页的文字层能不能当字框来源（有字、且字符框不是退化的零高度）。"""
    try:
        lines = render.page_text_chars(source, page_index)
    except render.PdfError:
        return False
    if not lines:
        return False
    heights = [
        abs(char_bbox[3] - char_bbox[1])
        for _text, _bbox, units in lines
        for _char, char_bbox in units
    ]
    if not heights:
        return False
    real = sum(1 for height in heights if height > 0.002)
    return real / len(heights) >= 0.5


def _ocr_candidates(source: Path, page_index: int, dpi: int = 200) -> list[CandidateLine]:
    """扫描件：跑一次识别（只取结果，不落库）。"""
    image = render.render_page_image(source, page_index, dpi=dpi)
    try:
        result = RapidOcrAdapter().recognize(image, OcrParams(dpi=dpi))
    finally:
        image.close()
    return [
        CandidateLine(
            text=line.text,
            bbox=(line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1),
            words=tuple(
                (
                    word.text,
                    (word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1),
                    word.confidence,
                )
                for word in line.words
            ),
        )
        for line in result.lines
    ]


def _ensure_schema(directory: Path) -> None:
    """确保迁移跑到最新（老项目第一次回填时补上 word_boxes 列）。"""
    with db_module.open_database(directory) as conn:
        conn.commit()


def _pages_rows(directory: Path, page_id: str) -> list[dict]:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            """
            SELECT l.line_id, l.line_index, l.text, l.bbox, b.order_index
            FROM block_line l JOIN block b ON b.block_id = l.block_id
            WHERE b.page_id = ? AND b.deleted_at IS NULL
            ORDER BY b.order_index, l.line_index
            """,
            (page_id,),
        ).fetchall()
    return [
        {
            "line_id": row["line_id"],
            "text": row["text"] or "",
            "bbox": _box_from_json(row["bbox"]),
        }
        for row in rows
    ]


def _lines_missing_boxes(directory: Path, page_id: str, *, only_ids=None) -> int:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) AS n FROM block_line l JOIN block b ON b.block_id = l.block_id
            WHERE b.page_id = ? AND b.deleted_at IS NULL AND l.word_boxes IS NULL
            """,
            (page_id,),
        ).fetchone()
    return int(row["n"] if row else 0)


# ---------------------------------------------------------------- 对外


def analyze(project_id: str, *, library: Path | None = None) -> dict:
    """要看多少页 / 多少行、预计多久（不写库）。"""
    target = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target)
    _ensure_schema(directory)
    pages = library_module.list_pages(project_id, library=target)
    body = [page for page in pages if page.include]
    missing_pages: list[int] = []
    missing_lines = 0
    text_layer_pages = 0
    for page in body:
        count = _lines_missing_boxes(directory, page.page_id)
        if not count:
            continue
        missing_pages.append(page.page_no)
        missing_lines += count
        if page.has_text_layer and text_layer_usable(
            library_module.require_project_dir(project_id, library=target)
            / library_module.SOURCE_DIR_NAME
            / library_module.SOURCE_FILE_NAME,
            page.page_no - 1,
        ):
            text_layer_pages += 1
    ocr_pages = len(missing_pages) - text_layer_pages
    return {
        "pages": len(missing_pages),
        "lines": missing_lines,
        "text_layer_pages": text_layer_pages,
        "ocr_pages": ocr_pages,
        "estimated_seconds": int(
            round(
                text_layer_pages * TEXT_LAYER_SECONDS_PER_PAGE
                + ocr_pages * OCR_SECONDS_PER_PAGE
            )
        ),
        "missing_pages": missing_pages[:200],
    }


def _backup_once(directory: Path) -> Path:
    """第一次写入前备份 project.db（同一次回填只备份一次）。"""
    backups = directory / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    target = backups / f"project-before-word-boxes-{stamp}.db"
    if not target.exists():
        shutil.copy2(directory / "project.db", target)
    return target


def backfill(
    project_id: str,
    *,
    library: Path | None = None,
    pages: list[int] | None = None,
    limit: int | None = None,
) -> dict:
    """给已有行补字框。**只写 `block_line.word_boxes`。**

    只处理 ``word_boxes IS NULL`` 的行，所以分批调用可以续跑；
    第一次写入前备份数据库；返回匹配率、未匹配行数与备份路径。
    """
    target = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target)
    _ensure_schema(directory)
    source = directory / library_module.SOURCE_DIR_NAME / library_module.SOURCE_FILE_NAME
    all_pages = library_module.list_pages(project_id, library=target)
    by_no = {page.page_no: page for page in all_pages}
    wanted: list = []
    for page_no in pages or sorted(by_no):
        page = by_no.get(page_no)
        if page is None or not page.include:
            continue
        if not _lines_missing_boxes(directory, page.page_id):
            continue
        wanted.append(page)
    batch = wanted[:limit] if limit is not None else wanted
    if not batch:
        return {
            "updated_pages": 0,
            "lines_total": 0,
            "lines_matched": 0,
            "lines_unmatched": 0,
            "remaining_pages": 0,
            "backup_path": None,
            "elapsed_seconds": 0.0,
        }

    backup = None
    started = time.perf_counter()
    total = matched = unmatched = 0
    unmatched_samples: list[dict] = []
    for page in batch:
        rows = _pages_rows(directory, page.page_id)
        if not rows:
            continue
        if page.has_text_layer:
            candidates = _text_layer_candidates(source, page.page_no - 1)
            if not candidates:  # 文字层读不出来 / 退化（旋转 / 不可见文字）→ 退回识别
                candidates = _ocr_candidates(source, page.page_no - 1)
        else:
            candidates = _ocr_candidates(source, page.page_no - 1)
        pairs = match_lines(rows, candidates)
        updates = []
        for index, row in enumerate(rows):
            total += 1
            cand = pairs.get(index)
            payload = _word_boxes_json(cand) if cand is not None else None
            if payload is None:
                unmatched += 1
                if len(unmatched_samples) < 20:
                    unmatched_samples.append(
                        {"page_no": page.page_no, "text": (row["text"] or "")[:60]}
                    )
                # 记一个空数组 = "试过了，没有可用字框"。不记的话下一页/下一轮会
                # 反复选中同一批页（未配对行永远 NULL），回填就卡在原地。
                updates.append(("[]", row["line_id"]))
                continue
            matched += 1
            updates.append((payload, row["line_id"]))
        if updates:
            if backup is None:
                backup = _backup_once(directory)
            with db_module.open_database(directory, apply_migrations=False) as conn:
                conn.executemany(
                    "UPDATE block_line SET word_boxes = ? WHERE line_id = ? AND word_boxes IS NULL",
                    updates,
                )
                conn.execute("UPDATE project SET updated_at = ?", (_now(),))
                conn.commit()

    remaining = 0
    for page in wanted[len(batch):]:
        remaining += 1
    return {
        "updated_pages": len(batch),
        "lines_total": total,
        "lines_matched": matched,
        "lines_unmatched": unmatched,
        "match_rate": round(matched / total, 4) if total else 0.0,
        "unmatched_samples": unmatched_samples,
        "remaining_pages": remaining,
        "backup_path": str(backup) if backup else None,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
    }


def coverage(project_id: str, *, library: Path | None = None) -> dict:
    """字框覆盖率（验收用）。"""
    target = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target)
    _ensure_schema(directory)
    pages = library_module.list_pages(project_id, library=target)
    body = [page for page in pages if page.include]
    ids = [page.page_id for page in body]
    with db_module.open_database(directory, apply_migrations=False) as conn:
        placeholders = ", ".join("?" for _ in ids)
        row = conn.execute(
            f"""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN l.word_boxes IS NOT NULL AND l.word_boxes NOT IN ('[]', '')
                            THEN 1 ELSE 0 END) AS with_boxes
            FROM block_line l JOIN block b ON b.block_id = l.block_id
            WHERE b.page_id IN ({placeholders}) AND b.deleted_at IS NULL
            """,
            tuple(ids),
        ).fetchone()
        sample = conn.execute(
            f"""
            SELECT l.word_boxes FROM block_line l JOIN block b ON b.block_id = l.block_id
            WHERE b.page_id IN ({placeholders}) AND b.deleted_at IS NULL
              AND l.word_boxes IS NOT NULL AND l.word_boxes NOT IN ('[]', '') LIMIT 1
            """,
            tuple(ids),
        ).fetchone()
    total = int(row["total"] or 0)
    with_boxes = int(row["with_boxes"] or 0)
    words = 0
    if sample and sample["word_boxes"]:
        try:
            words = len(json.loads(sample["word_boxes"]))
        except (TypeError, ValueError):
            words = 0
    return {
        "lines_total": total,
        "lines_with_boxes": with_boxes,
        "coverage": round(with_boxes / total, 4) if total else 0.0,
        "first_line_units": words,
    }


def clear(project_id: str, *, library: Path | None = None) -> dict:
    """撤销回填：把所有行的 `word_boxes` 置空（其它字段本来就没动）。"""
    target = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target)
    _ensure_schema(directory)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        updated = conn.execute(
            "UPDATE block_line SET word_boxes = NULL WHERE word_boxes IS NOT NULL"
        ).rowcount
        conn.execute("UPDATE project SET updated_at = ?", (_now(),))
        conn.commit()
    return {"cleared_lines": int(updated)}
