"""页码跳转索引（任务 37 / C 刀）：给「目录确认」一步用的印刷页码 → PDF 页列表。

用户要的不是书籍目录，是**能直接跳页的页码列表**：

> "如果没有连续的页码或者章节没关系，只有页码的话，就只给一个页码列表就行，
>  让我可以直接跳转到不同页面。"

这一组只读，不写库、不改识别 / 审校 / 导出：

1. **印刷页码**：优先读 `page.printed_page`（页码设置写进去的值）；没有就用页码候选
   （`page_numbers.collect_candidates`，只取页面下边带的纯数字行）。
   **不重新 OCR**。
2. **编号步长**：用相邻有页码页的 ``印刷页码差 / PDF 页差`` 中位数判断。
   这本书是 **2**——每页仍是单页，只是影印时按"叶"编号（一叶两个面，只拍了其中一面），
   所以页码隔 2 递增。**列表和页头只写实际检测到的那一个号**，不替书补出不存在的那一面；
   输入框接受"同一叶的另一面"（如 61 → PDF 30）作为跳转便利，不写进标签。
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
CHAPTER_RE = re.compile(r"^第[一二三四五六七八九十百零〇两]+回(?=\s|$)")
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
    numbering_step = _numbering_step(one_number)
    ratio = numbering_step
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
        # 跳转可接受的值：实际页号；编号隔 2 的书额外接受"同一叶的另一面"。
        # 这只影响输入框能不能命中，**不会**写进 printed 标签。
        jump: list[str] = []
        if page.printed_page:
            printed = [str(page.printed_page)]
            jump = list(printed)
            source = "manual"
        else:
            value = one_number.get(page.page_no)
            if value is not None:
                detected = [str(value)]
                printed = [str(value)]
                jump = [str(value)] + (
                    [str(value + 1)] if numbering_step == 2 else []
                )
                source = "candidate"
        # 缺页码要分三类叫法（任务 57）：前置 / 后置页本来就不印阿拉伯页码；
        # 回目首页不印页码是排版惯例；两者都不是识别失败，只有第三类才是。
        missing_reason = None
        if not printed:
            if page.page_type in ("front", "back"):
                missing_reason = "front_back"
            elif title:
                missing_reason = "chapter"
            else:
                missing_reason = "unknown"
        entries.append(
            {
                "page_no": page.page_no,
                "page_type": page.page_type,
                "printed": printed,
                "detected": detected,
                "jump": jump,
                "source": source,
                "chapter": title,
                "missing": not printed,
                "missing_reason": missing_reason,
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
    missing_front_back = sum(
        1 for entry in entries if entry["missing_reason"] == "front_back"
    )
    missing_chapter = sum(
        1 for entry in entries if entry["missing_reason"] == "chapter"
    )
    missing_unknown = sum(
        1 for entry in entries if entry["missing_reason"] == "unknown"
    )
    # 有页 ≠ 有索引：一页印刷页码都没读到的时候，这份列表只是 PDF 页序，
    # 不能当作"目录确认已完成"（否则步骤条会亮绿灯，用户却什么页码都没有）。
    page_order_only = numbered == 0
    payload = {
        "schema": INDEX_SCHEMA,
        "generated_at": project.updated_at,
        "numbering_step": numbering_step,
        "pages": entries,
        "chapters": chapters,
        "stats": {
            "total": len(entries),
            "numbered": numbered,
            "missing": len(entries) - numbered,
            # 缺页码的三类：前置 / 后置（不印）、回目页（惯例不印）、真没识别出来
            "missing_front_back": missing_front_back,
            "missing_chapter": missing_chapter,
            "missing_unknown": missing_unknown,
            "chapters": len(chapters),
            # `page_order_only`：整本还没有印刷页码，下面只是 PDF 页序。
            # 界面据此显示"尚未识别"空态，步骤条不许变绿。
            "page_order_only": page_order_only,
            "complete": not page_order_only,
        },
        "notes": _notes(
            numbering_step=numbering_step,
            numbered=numbered,
            entries=len(entries),
            front_back=missing_front_back,
            chapter=missing_chapter,
            unknown=missing_unknown,
        ),
    }
    _CACHE[project_id] = (now, signature, payload)
    return payload


def page_index_summary(project_id: str, *, library: Path | None = None) -> dict:
    """收尾面板用的小摘要（不含 394 行明细）。"""
    data = build_page_index(project_id, library=library)
    stats = data["stats"]
    return {
        **stats,
        "numbering_step": data["numbering_step"],
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


def _numbering_step(one_number: dict[int, int]) -> int:
    """全书的印刷页码步长（1 或 2）：相邻页的页码差 ÷ PDF 页差取中位数。

    注意：步长 2 **不代表**一张 PDF 页含两个印刷页。这本书实测每页就是单页
    （PDF 页 447.6×674.7 pt，比例 0.663），页码隔 2 是影印时按"叶"编号的规律。
    步长只用来解释编号规律与输入框的跳转便利，不往标签里补号。
    """
    ratios: list[float] = []
    ordered = sorted(one_number)
    for left, right in zip(ordered, ordered[1:]):
        gap = right - left
        delta = one_number[right] - one_number[left]
        if gap <= 0 or delta <= 0:
            continue
        ratios.append(delta / gap)
    if not ratios:
        return 1
    return 2 if statistics.median(ratios) >= 1.5 else 1


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


def _notes(
    *,
    numbering_step: int,
    numbered: int,
    entries: int,
    front_back: int = 0,
    chapter: int = 0,
    unknown: int = 0,
) -> list[str]:
    notes = []
    if numbering_step == 2:
        notes.append(
            "这本书的印刷页码隔 2 递增（影印按“叶”编号，一叶两个面只拍了其中一面）；"
            "列表只写每页实际检测到的那一个号。"
        )
    if numbered == 0:
        notes.append("这本书还没有可用的印刷页码，列表只能按 PDF 页序跳。")
    elif numbered < entries:
        bits = []
        if front_back:
            bits.append(f"{front_back} 页前置 / 后置（本来不印阿拉伯页码）")
        if chapter:
            bits.append(f"{chapter} 页回目页（排版惯例，回目首页不印页码）")
        if unknown:
            bits.append(f"{unknown} 页是真的没识别出页码")
        detail = "、".join(bits) if bits else f"{entries - numbered} 页没有印刷页码"
        notes.append(f"{detail}；这些页照样可以点进去。")
    return notes
