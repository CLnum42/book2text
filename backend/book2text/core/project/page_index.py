"""页码跳转索引（任务 37 / C 刀）：给「目录确认」一步用的印刷页码 → PDF 页列表。

用户要的不是书籍目录，是**能直接跳页的页码列表**：

> "如果没有连续的页码或者章节没关系，只有页码的话，就只给一个页码列表就行，
>  让我可以直接跳转到不同页面。"

这一组只读，不写库、不改识别 / 审校 / 导出：

1. **印刷页码**：优先读 `page.printed_page`（页码设置写进去的值）；没有就用页码候选
   （`page_numbers.collect_candidates`，只取页面下边带的纯数字行）。
   **不重新 OCR**。
2. **对开双页**：这本书每张 PDF 页拍了两个印刷页（左偶右奇）。用相邻有页码页的
   ``印刷页码差 / PDF 页差`` 的中位数判断：≈2 就是双页，≈1 是单页。
   双页时一个 PDF 页有两个印刷页码，列表里两个都显示，不硬压成一个。
3. **章首**：页面靠前的文字块第一行匹配 ``^第[一二三四五六七八九十百零〇两]+回``
   就记一个分组标题；没有就不硬造层级。
4. **缺页码的页**：照样列出，``printed=[]``，界面标「未识别页码」——缺页码不是失败。

索引生成要扫全书的块与行，所以按 ``project.updated_at + 页数`` 做进程内缓存
（60 秒过期；真正决定索引的编辑都会更新 ``project.updated_at``）。
"""

from __future__ import annotations

import re
import statistics
import time
from pathlib import Path

from ..storage import db as db_module
from . import library as library_module
from . import page_numbers as page_numbers_module

INDEX_SCHEMA = "book2text.page-index.v1"

# 页码候选只认页面下边带：上边带多半是书眉里的章节号，中部是插图里的数字。
BOTTOM_BAND = 0.85
# 章首匹配：第X回 / 第X回　（回目后面可能跟标题）
CHAPTER_RE = re.compile(r"^第[一二三四五六七八九十百零〇两]+回")
# 判断章首时看每页前几个文字块（书眉可能排在章题前面）
CHAPTER_LOOKAHEAD = 3

_CACHE_TTL_SECONDS = 60.0
# project_id → (生成时间, 签名, 结果)
_CACHE: dict[str, tuple[float, str, dict]] = {}


def build_page_index(project_id: str, *, library: Path | None = None) -> dict:
    """生成（或读缓存）页码跳转索引。只读。"""
    target_library = library if library is not None else library_module.default_library_dir()
    project = library_module.load_project(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    signature = f"{project.updated_at}|{len(pages)}|{sum(1 for p in pages if p.printed_page)}"
    cached = _CACHE.get(project_id)
    now = time.time()
    if cached and cached[1] == signature and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[2]

    directory = library_module.require_project_dir(project_id, library=target_library)
    candidates, _, _ = page_numbers_module.collect_candidates(
        project_id, library=target_library
    )
    chapter_texts = _chapter_texts(directory)
    one_number = _one_number_per_page(pages, candidates)
    two_up = _is_two_up(one_number)
    ratio = 2 if two_up else 1
    offset = _offset(one_number, ratio)
    # 兜底：页码候选只收"版心外"的纯数字行；这本书有 14 页的页脚被并进了正文块、
    # 落在版心内，候选收不到。这里补看**下边带的数字行**（不看版心），但只接受
    # 与全书规律吻合的值（printed = ratio × 页序 + offset），不猜。
    for page_no, value in _bottom_line_numbers(directory).items():
        if page_no in one_number:
            continue
        if value == ratio * page_no + offset:
            one_number[page_no] = value

    entries: list[dict] = []
    for page in pages:
        title = _chapter_of(chapter_texts.get(page.page_no))
        printed: list[str] = []
        detected: list[str] = []
        source = None
        if page.printed_page:
            printed = [str(page.printed_page)]
            source = "manual"
        else:
            value = one_number.get(page.page_no)
            if value is not None:
                detected = [str(value)]
                printed = _spread_numbers(value) if two_up else [str(value)]
                source = "candidate"
        entries.append(
            {
                "page_no": page.page_no,
                "printed": printed,
                "detected": detected,
                "source": source,
                "spread": bool(two_up and len(printed) > 1),
                "chapter": title,
                "missing": not printed,
            }
        )

    chapters = [
        {
            "title": entry["chapter"],
            "page_no": entry["page_no"],
            "printed": entry["printed"],
        }
        for entry in entries
        if entry["chapter"]
    ]
    numbered = sum(1 for entry in entries if not entry["missing"])
    payload = {
        "schema": INDEX_SCHEMA,
        "generated_at": project.updated_at,
        "two_up": two_up,
        "pages": entries,
        "chapters": chapters,
        "stats": {
            "total": len(entries),
            "numbered": numbered,
            "missing": len(entries) - numbered,
            "chapters": len(chapters),
            "complete": len(entries) > 0,
        },
        "notes": _notes(two_up=two_up, numbered=numbered, entries=len(entries)),
    }
    _CACHE[project_id] = (now, signature, payload)
    return payload


def page_index_summary(project_id: str, *, library: Path | None = None) -> dict:
    """收尾面板用的小摘要（不含 394 行明细）。"""
    data = build_page_index(project_id, library=library)
    stats = data["stats"]
    return {
        **stats,
        "two_up": data["two_up"],
        "chapter_pages": [chapter["page_no"] for chapter in data["chapters"]],
        "generated_at": data["generated_at"],
    }


def forget_page_index(project_id: str | None = None) -> None:
    """丢掉缓存（测试 / 需要强制重算时用）。"""
    if project_id is None:
        _CACHE.clear()
    else:
        _CACHE.pop(project_id, None)


# ---------------------------------------------------------------- 内部


def _bottom_numbers(candidates) -> list[tuple[int, float]]:
    """这一页下边带里像页码的数字：[(值, y)]，按 y 从下往上排。"""
    numbers: list[tuple[int, float]] = []
    for candidate in candidates:
        value = str(candidate.value or "").strip()
        if not value.isdigit():
            continue
        if candidate.y < BOTTOM_BAND:
            continue
        numbers.append((int(value), float(candidate.y)))
    numbers.sort(key=lambda item: item[1], reverse=True)
    return numbers


def _one_number_per_page(pages, candidates) -> dict[int, int]:
    """每页挑一个可信的印刷页码。

    大多数页只有一个候选；个别页的下边带会混进插图里的数字（真书 8 页出现过
    ``1`` / ``2`` / ``7``）。挑法：优先取与"上一页之后 1–2 个数"吻合的候选，
    否则取最靠下的那个——不猜、不硬凑。
    """
    picked: dict[int, int] = {}
    previous: int | None = None
    for page in pages:
        numbers = _bottom_numbers(candidates.get(page.page_no, []))
        if not numbers:
            continue
        if previous is not None:
            expected = {previous + 1, previous + 2}
            matched = [value for value, _ in numbers if value in expected]
            value = matched[0] if matched else numbers[0][0]
        else:
            value = numbers[0][0]
        picked[page.page_no] = value
        previous = value
    return picked


def _is_two_up(one_number: dict[int, int]) -> bool:
    """相邻页的印刷页码差 / PDF 页差：≈2 说明一张 PDF 页含两个印刷页。"""
    ratios: list[float] = []
    ordered = sorted(one_number)
    for left, right in zip(ordered, ordered[1:]):
        gap = right - left
        delta = one_number[right] - one_number[left]
        if gap <= 0 or delta <= 0:
            continue
        ratios.append(delta / gap)
    if not ratios:
        return False
    return statistics.median(ratios) >= 1.5


def _offset(one_number: dict[int, int], ratio: int) -> int:
    """全书印刷页码规律：printed = ratio × 页序 + offset（真书 ratio=2, offset=0）。"""
    if not one_number:
        return 0
    values = sorted(one_number.items())
    middle = values[len(values) // 2]
    return middle[1] - ratio * middle[0]


def _bottom_line_numbers(directory: Path) -> dict[int, int]:
    """每页下边带里"整行只是一个数字"的行（不过滤版心，给缺页码的页兜底用）。

    同一页有多个时取最靠下的那个；插图里的数字通常更高，且后面会被
    "与全书规律吻合" 这一道挡住。
    """
    import json

    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            """
            SELECT p.page_no, l.text, l.bbox
            FROM page p
            JOIN block b ON b.page_id = p.page_id
            JOIN block_line l ON l.block_id = b.block_id
            WHERE b.deleted_at IS NULL AND b.include = 1
            """
        ).fetchall()
    found: dict[int, tuple[int, float]] = {}
    for page_no, text, raw_bbox in rows:
        value = (text or "").strip()
        if not value.isdigit() or len(value) > 4:
            continue
        try:
            bbox = json.loads(raw_bbox) if raw_bbox else None
        except (TypeError, ValueError):
            continue
        if not bbox or len(bbox) < 4:
            continue
        y = (float(bbox[1]) + float(bbox[3])) / 2
        if y < BOTTOM_BAND:
            continue
        current = found.get(int(page_no))
        if current is None or y > current[1]:
            found[int(page_no)] = (int(value), y)
    return {page_no: value for page_no, (value, _) in found.items()}


def _spread_numbers(value: int) -> list[str]:
    """对开双页：偶数是左页，奇数是右页。"""
    if value % 2 == 0:
        return [str(value), str(value + 1)]
    return [str(value - 1), str(value)]


def _chapter_texts(directory: Path) -> dict[int, str]:
    """每页前几个文字块的首行（升序），给章首匹配用。"""
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            """
            SELECT p.page_no, b.block_type, b.text, b.ocr_text
            FROM page p
            JOIN block b ON b.page_id = p.page_id
            WHERE b.deleted_at IS NULL AND b.include = 1
            ORDER BY p.page_no, b.order_index
            """
        ).fetchall()
    texts: dict[int, list[str]] = {}
    for page_no, block_type, text, ocr_text in rows:
        if block_type in ("header", "footer", "page_number", "decoration", "figure"):
            continue
        content = (text or "").strip() or (ocr_text or "").strip()
        if not content:
            continue
        bucket = texts.setdefault(int(page_no), [])
        if len(bucket) < CHAPTER_LOOKAHEAD:
            bucket.append(content)
    return {page_no: "\n".join(items) for page_no, items in texts.items()}


def _chapter_of(text: str | None) -> str | None:
    if not text:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        match = CHAPTER_RE.match(line)
        if match:
            return match.group(0)
    return None


def _notes(*, two_up: bool, numbered: int, entries: int) -> list[str]:
    notes = []
    if two_up:
        notes.append("每张 PDF 页拍了两个印刷页（左偶右奇），所以一行显示两个印刷页码。")
    if numbered == 0:
        notes.append("这本书还没有可用的印刷页码，列表只能按 PDF 页序跳。")
    elif numbered < entries:
        notes.append(f"{entries - numbered} 页没有识别到印刷页码，已标「未识别页码」，照样可以点进去。")
    return notes
