"""字符规范化（任务 49 / M 刀）：三组括号、半角标点、引号配平。

背景（Extractor 全书字符扫描，两路一致，审校永远抓不到）：

- `<` `>` 182/182 → 实际印的是单书名号 `〈` `〉`（金标准 7 对可证）；
- `[` `]` 54/53 → `［` `］`（直角方括号，`［甲戌］`）；
- `{` `}` 51/51 → `〔` `〕`（龟甲括号，校勘补字 `贾{菌}`）；
- 半角 `! ? . ' -` 24 处 → `！？。’—`（第二引擎本来就是全角）；
- 引号：`“` 2921 / `”` 2724、`‘` 186 / `’` 350，其中 117 处闭单引号的最近前导
  引号是 `“` —— 开单引号被两路都读成了双引号。

两路读成同一个错，差异队列里永远不会出现，所以只能**按形态修数据**：

- 三组括号 + 半角标点：**只在中文语境**（两侧是汉字或中文标点）替换，
  数字 / ASCII 旁边的尖括号不动（防御性的：这本书没有代码，但别误伤）；
- 引号：整本书按阅读顺序扫一遍，用配平栈判；`’` 前面最近的未闭合引号是 `“`
  才把它改成 `‘`（这就是那 117 处），其余**真不配平的进"引号不配平"清单**，
  不硬配（配错比不配更糟）。

只改 `block.text`（导出与审校编辑用的是这一份），不动 `block_line`（那是 OCR 原始
证据）。批量写库一个 batch，可一次撤销。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ..ocr import compare as compare_module
from ..storage import db as db_module
from . import blocks as blocks_module
from . import editing
from . import library as library_module
from . import margin_box as margin_box_module

# 正文块类型：书眉 / 页脚 / 页码 / 插图 / 装饰不参与（那些是版心外的噪声）
BODY_TYPES = frozenset({"paragraph", "heading", "footnote", "caption", "other"})

# 中文标点（含成对的括号 / 引号）——"中文语境"的判定依据
CJK_PUNCT = set(
    "，。、；：？！“”‘’（）《》〈〉「」『』【】〔〕［］—-…·％"
)
# 括号本身也算"中文语境"：`。><十八日`、`〔静虚}[与` 这种连在一起的括号，
# 两边的邻居正好是另一个括号，不能因为邻居是括号就跳过。
BRACKET_CHARS = set("<>[]{}＜＞［］｛｝")
# 中文正文里会贴着括号出现的符号（度数、千分号之类），算"中文语境"；
# `a < b` 这种两侧都是空格/字母的代码不动。
CONTEXT_SYMBOLS = set("°℃%‰○●◎※")
# ASCII 字母 / 数字 / 代码符号：旁边是这些就当代码/公式，绝不动
ASCII_UNSAFE = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    "=+*/\\_|&$@#%\"`^~"
)

OPENING_BRACKETS = {
    "<": "〈",
    "＜": "〈",
    "[": "［",
    "［": "［",
    "{": "〔",
    "｛": "〔",
}
CLOSING_BRACKETS = {
    ">": "〉",
    "＞": "〉",
    "]": "］",
    "］": "］",
    "}": "〕",
    "｝": "〕",
}
# 打开括号后面可以接的字符：汉字 / 中文标点
TRAILING_OK = set(" \t\n，。、；：？！》〉」』】〕］”’")

HALF_TO_FULL = {
    "!": "！",
    "?": "？",
    ".": "。",
    "'": "’",
    "-": "—",
}


def _is_cjk(ch: str) -> bool:
    if not ch:
        return False
    code = ord(ch)
    return (
        0x4E00 <= code <= 0x9FFF
        or 0x3400 <= code <= 0x4DBF
        or code == 0x3007  # 〇
        or 0x20000 <= code <= 0x2A6DF
    )


def _is_cjk_context(ch: str) -> bool:
    return bool(ch) and (
        _is_cjk(ch) or ch in CJK_PUNCT or ch in BRACKET_CHARS or ch in CONTEXT_SYMBOLS
    )


def _bracket_safe(ch: str) -> bool:
    """括号的邻居是不是"中文语境"：只要不是 ASCII 字母 / 数字 / 代码符号就算。"""
    return not ch or ch not in ASCII_UNSAFE


@dataclass
class _BlockText:
    page_no: int
    block_id: str
    original: str
    chars: list[str]
    changed: dict[int, tuple[str, str]] = field(default_factory=dict)  # 位置 → (旧, 新)

    @property
    def text(self) -> str:
        return "".join(self.chars)


def _prev_char(items: list[_BlockText], index: int, offset: int) -> str:
    if offset > 0:
        return items[index].chars[offset - 1]
    if index > 0:
        return items[index - 1].chars[-1] if items[index - 1].chars else ""
    return ""


def _next_char(items: list[_BlockText], index: int, offset: int) -> str:
    buf = items[index].chars
    if offset + 1 < len(buf):
        return buf[offset + 1]
    if index + 1 < len(items):
        return items[index + 1].chars[0] if items[index + 1].chars else ""
    return ""


@dataclass
class _Quote:
    kind: str  # "double" | "single"
    index: int
    offset: int


def _scan(project_id: str, *, library: Path) -> tuple[list[_BlockText], dict]:
    """按阅读顺序扫一遍正文块：括号 / 半角标点就地修，引号用栈跨块配平。"""
    target_library = library
    project = library_module.load_project(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    page_by_no = {page.page_no: page for page in pages}

    items: list[_BlockText] = []
    for block in blocks_module.list_blocks(project_id, library=target_library):
        if not block.include:
            continue
        if block.block_type not in BODY_TYPES:
            continue
        if not (block.text or "").strip():
            continue
        page = page_by_no.get(block.page_no)
        # 版心外的书眉 / 噪声不动：它们不是正文
        if page is not None and not margin_box_module.block_inside_margin(
            project, page, block.bbox
        ):
            continue
        items.append(
            _BlockText(
                page_no=block.page_no,
                block_id=block.block_id,
                original=block.text,
                chars=list(block.text),
            )
        )

    stats = {
        "blocks": len(items),
        "brackets": {"〈〉": 0, "［］": 0, "〔〕": 0},
        "punct": {},
        "quote_autofix": 0,
    }

    # ---- 三组括号 + 半角标点（局部替换，只看两侧上下文）----
    for index, item in enumerate(items):
        buf = item.chars
        for offset, ch in enumerate(buf):
            if ch in CLOSING_BRACKETS:
                prev = _prev_char(items, index, offset)
                nxt = _next_char(items, index, offset)
                # 只要两侧不是 ASCII 字母/数字/代码符号，就当中文里的括号还原。
                # 这样 `。><十八日`、`〔静虚}[与`、`勾\n<°` 都能还原，
                # 而 `a < b`、`[1]`、`x[i]` 这种代码/公式一律不碰。
                new = CLOSING_BRACKETS[ch]
                if (
                    new != ch
                    and _bracket_safe(prev)
                    and _bracket_safe(nxt)
                    and (_is_cjk_context(prev) or _is_cjk_context(nxt))
                ):
                    item.changed[offset] = (ch, new)
                    buf[offset] = new
                    _bump_bracket(stats, new)
                continue
            if ch in OPENING_BRACKETS:
                prev = _prev_char(items, index, offset)
                nxt = _next_char(items, index, offset)
                opening = OPENING_BRACKETS[ch]
                if (
                    opening != ch
                    and _bracket_safe(prev)
                    and _bracket_safe(nxt)
                    and (_is_cjk_context(prev) or _is_cjk_context(nxt))
                ):
                    item.changed[offset] = (ch, opening)
                    buf[offset] = opening
                    _bump_bracket(stats, opening)
                continue
            if ch in HALF_TO_FULL:
                prev = _prev_char(items, index, offset)
                nxt = _next_char(items, index, offset)
                replace = False
                if ch in "!?":
                    replace = _is_cjk_context(prev) or _is_cjk_context(nxt)
                elif ch == ".":
                    replace = _is_cjk_context(prev) and (
                        not nxt or _is_cjk_context(nxt) or nxt in " \t\n，。、；：？！》〉」』】〕］”’"
                    )
                elif ch == "'":
                    replace = _is_cjk_context(prev) or _is_cjk_context(nxt)
                elif ch == "-":
                    # 中文里的破折号常被读成 `--`：两侧任一边是中文、另一边是另一个
                    # 半角连字符时才替换，数字 / 英文连字符不碰
                    replace = (
                        _is_cjk_context(prev) and (_is_cjk_context(nxt) or nxt == "-")
                    ) or (_is_cjk_context(nxt) and prev == "-")
                if replace:
                    item.changed[offset] = (ch, HALF_TO_FULL[ch])
                    buf[offset] = HALF_TO_FULL[ch]
                    stats["punct"][ch] = stats["punct"].get(ch, 0) + 1

    # ---- 引号配平（跨块，按 Extractor 的 117 规则）----
    # 两路都把开单引号读成了开双引号：闭单引号 `’` 附近最近的引号字符是 `“`，
    # 那个 `“` 其实是 `‘`（Extractor 核过页面放大图，117 处明确、金标准 40 页 0/0）。
    # 只改这 117 处；改完仍配不平的进清单，不整本硬配。
    quote_positions: list[tuple[int, int, str]] = []
    for index, item in enumerate(items):
        for offset, ch in enumerate(item.chars):
            if ch in "“”‘’":
                quote_positions.append((index, offset, ch))

    def _scan_quotes() -> tuple[list[tuple[int, int, str]], list[tuple[int, int, str]]]:
        """返回（没开号的闭引号, 没闭合的开引号）。"""
        stack: list[tuple[int, int, str]] = []
        closes: list[tuple[int, int, str]] = []
        for index, offset, ch in quote_positions:
            if ch in "“‘":
                stack.append((index, offset, ch))
            elif ch == "”":
                if stack and stack[-1][2] == "“":
                    stack.pop()
                else:
                    closes.append((index, offset, ch))
            else:  # ’
                if stack and stack[-1][2] == "‘":
                    stack.pop()
                else:
                    closes.append((index, offset, ch))
        return closes, stack

    closes, _opens = _scan_quotes()
    # 转之前哪些 ” 本来就没配平：用来区分"自动修出来的孤儿"和"本来就配不平的"
    pre_double_closes = {
        (index, offset) for index, offset, ch in closes if ch == "”"
    }
    converted: set[tuple[int, int]] = set()
    for index, offset, ch in closes:
        if ch != "’":
            continue
        position = next(
            (
                pos
                for pos, entry in enumerate(quote_positions)
                if entry[0] == index and entry[1] == offset
            ),
            None,
        )
        if position is None or position == 0:
            continue
        prev_index, prev_offset, prev_ch = quote_positions[position - 1]
        if prev_ch != "“" or (prev_index, prev_offset) in converted:
            continue
        target = items[prev_index]
        if target.chars[prev_offset] != "“":
            continue
        target.changed[prev_offset] = ("“", "‘")
        target.chars[prev_offset] = "‘"
        quote_positions[position - 1] = (prev_index, prev_offset, "‘")
        converted.add((prev_index, prev_offset))
        stats["quote_autofix"] += 1

    unmatched: list[dict] = []
    closes, opens = _scan_quotes()
    position_of = {
        (index, offset): position
        for position, (index, offset, _ch) in enumerate(quote_positions)
    }
    for index, offset, ch in closes:
        suspect = False
        if ch == "”":
            # 两种都能认出"自动修引号改出来的孤儿"：
            # 1) 在原始文本上扫：转之前配平、转之后没配平；
            # 2) 在已修好的文本上扫：它前面最近的引号字符是闭单引号 `’`
            #    （说明那个开双引号已经被改成开单引号了）。
            position = position_of.get((index, offset))
            suspect = (index, offset) not in pre_double_closes or (
                position is not None
                and position > 0
                and quote_positions[position - 1][2] == "’"
            )
        unmatched.append(_unmatched(items[index], offset, ch, "close", suspect=suspect))
    for index, offset, ch in opens:
        unmatched.append(_unmatched(items[index], offset, ch, "open"))

    return items, {"stats": stats, "unmatched": unmatched}


def _bump_bracket(stats: dict, char: str) -> None:
    for key in ("〈〉", "［］", "〔〕"):
        if char in key:
            stats["brackets"][key] += 1
            return


def _unmatched(
    item: _BlockText, offset: int, char: str, kind: str, *, suspect: bool = False
) -> dict:
    text = item.text
    start = max(0, offset - 12)
    end = min(len(text), offset + 13)
    snippet = text[start:end].replace("\n", " ")
    return {
        "page_no": item.page_no,
        "block_id": item.block_id,
        "kind": kind,
        "char": char,
        "offset": offset,
        "snippet": ("…" if start else "") + snippet + ("…" if end < len(text) else ""),
        # 自动修的 117 处里有可能改错的（把原来配好的 ” 变成孤儿）：清单里优先看
        "suspect": suspect,
    }


def analyze(project_id: str, *, library: Path | None = None) -> dict:
    """只读计划：要改哪些块、改多少字，以及真配不平的引号。"""
    target_library = library if library is not None else library_module.default_library_dir()
    items, result = _scan(project_id, library=target_library)
    stats = result["stats"]
    changes: list[dict] = []
    changed_chars = 0
    pages: set[int] = set()
    for item in items:
        text = item.text
        if text == item.original:
            continue
        diffs = [
            {"offset": offset, "from": pair[0], "to": pair[1]}
            for offset, pair in sorted(item.changed.items())
            if pair[0] != pair[1]
        ]
        changed_chars += len(diffs)
        pages.add(item.page_no)
        changes.append(
            {
                "page_no": item.page_no,
                "block_id": item.block_id,
                "before": item.original,
                "after": text,
                "changes": len(diffs),
            }
        )
    stats.update(
        {
            "blocks_changed": len(changes),
            "chars_changed": changed_chars,
            "pages": len(pages),
            "unbalanced": len(result["unmatched"]),
        }
    )
    return {
        "stats": stats,
        "changes": changes,
        "unbalanced": result["unmatched"],
        "pages": sorted(pages),
    }


def apply(
    project_id: str,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> dict:
    """执行：改 `block.text`，整批一个 batch（可一次撤销）。"""
    target_library = library if library is not None else library_module.default_library_dir()
    items, result = _scan(project_id, library=target_library)
    stats = result["stats"]
    events = []
    pages: set[int] = set()
    batch_id = None
    changed = 0
    for item in items:
        text = item.text
        if text == item.original:
            continue
        _block, block_events = editing.update_block(
            project_id,
            item.block_id,
            library=target_library,
            text=text,
            actor_name=actor_name,
            batch_id=batch_id,
        )
        if block_events:
            batch_id = block_events[0].batch_id
            events.extend(block_events)
            pages.add(item.page_no)
            changed += 1
    return {
        "stats": {
            **stats,
            "blocks_changed": changed,
            "chars_changed": sum(len(entry.changed) for entry in items if entry.text != entry.original),
            "pages": len(pages),
            "unbalanced": len(result["unmatched"]),
        },
        "unbalanced": result["unmatched"],
        "changed": changed,
        "pages": sorted(pages),
        "events": events,
        "batch_id": batch_id,
    }


def unbalanced(project_id: str, *, library: Path | None = None) -> dict:
    """只读：真配不平的引号（不硬配，交给人看）。"""
    target_library = library if library is not None else library_module.default_library_dir()
    _items, result = _scan(project_id, library=target_library)
    entries = result["unmatched"]
    return {
        "count": len(entries),
        "entries": entries,
        "pages": len({entry["page_no"] for entry in entries}),
    }


# ---------------------------------------------------------------- 行级：文本 + 第二引擎 + diff 重算

def _normalize_local_line(text: str) -> tuple[str, int]:
    """单行局部规范化（括号 / 半角标点，行内上下文）。返回（新文本, 改动字符数）。

    和 `_scan` 里那套规则一致；行首 / 行尾的空邻居按"允许"处理。
    引号不在这里改（引号是按全书配平定的，见 `lines_plan` 的映射）。
    """
    chars = list(text or "")
    changed = 0
    for offset in range(len(chars)):
        ch = chars[offset]
        prev = chars[offset - 1] if offset else ""
        nxt = chars[offset + 1] if offset + 1 < len(chars) else ""
        if ch in CLOSING_BRACKETS:
            new = CLOSING_BRACKETS[ch]
            if (
                new != ch
                and _bracket_safe(prev)
                and _bracket_safe(nxt)
                and (_is_cjk_context(prev) or _is_cjk_context(nxt))
            ):
                chars[offset] = new
                changed += 1
            continue
        if ch in OPENING_BRACKETS:
            new = OPENING_BRACKETS[ch]
            if (
                new != ch
                and _bracket_safe(prev)
                and _bracket_safe(nxt)
                and (_is_cjk_context(prev) or _is_cjk_context(nxt))
            ):
                chars[offset] = new
                changed += 1
            continue
        if ch in HALF_TO_FULL:
            replace = False
            if ch in "!?":
                replace = _is_cjk_context(prev) or _is_cjk_context(nxt)
            elif ch == ".":
                replace = _is_cjk_context(prev) and (
                    not nxt
                    or _is_cjk_context(nxt)
                    or nxt in " \t\n，。、；：？！》〉」』】〕］”’"
                )
            elif ch == "'":
                replace = _is_cjk_context(prev) or _is_cjk_context(nxt)
            elif ch == "-":
                replace = (
                    _is_cjk_context(prev) and (_is_cjk_context(nxt) or nxt == "-")
                ) or (_is_cjk_context(nxt) and prev == "-")
            if replace:
                chars[offset] = HALF_TO_FULL[ch]
                changed += 1
    return "".join(chars), changed


def _line_rows(directory: Path) -> list:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        return conn.execute(
            "SELECT line_id, block_id, line_index, text, aux_text, diff_status, diff_ack"
            " FROM block_line ORDER BY block_id, line_index"
        ).fetchall()


def lines_plan(project_id: str, *, library: Path | None = None) -> dict:
    """只读：行文本 / 第二引擎文本要改哪些、diff 状态会怎么变。

    关键点：审校的差异标记是**实时**拿 `block.text` 的每一行和 `block_line.aux_text`
    比较出来的。所以只改块文本、不改 aux，会让每个括号行从 identical 变成
    "标点级分歧"——队列反而变长。这里两路一起规范化，再按同一套 `compare_line`
    重算状态。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    items, _result = _scan(project_id, library=target_library)
    by_block = {item.block_id: item for item in items}
    directory = library_module.project_dir(target_library, project_id)
    rows = _line_rows(directory)

    grouped: dict[str, list] = {}
    for row in rows:
        grouped.setdefault(row["block_id"], []).append(row)

    entries: list[dict] = []
    before_counts: dict[str, int] = {}
    after_counts: dict[str, int] = {}
    stats = {
        "lines": 0,
        "text_changed": 0,
        "aux_changed": 0,
        "status_changed": 0,
        "skipped_ack": 0,
        "unaligned_blocks": 0,
        "unaligned_lines": 0,
    }
    for block_id, block_rows in grouped.items():
        block_rows.sort(key=lambda row: row["line_index"])
        item = by_block.get(block_id)
        parts = item.text.split("\n") if item else None
        aligned = bool(item) and len(parts) == len(block_rows)
        if item and not aligned:
            stats["unaligned_blocks"] += 1
        starts: list[int] = []
        position = 0
        for part in parts or []:
            starts.append(position)
            position += len(part) + 1
        for row in block_rows:
            stats["lines"] += 1
            if row["diff_ack"]:
                stats["skipped_ack"] += 1
                continue
            old_text = row["text"] or ""
            old_aux = row["aux_text"]
            if aligned:
                new_text = parts[row["line_index"]]
            else:
                stats["unaligned_lines"] += 1
                new_text, _changed = _normalize_local_line(old_text)
            new_aux = old_aux
            if old_aux is not None:
                normalized_aux, _changed = _normalize_local_line(old_aux)
                aux_chars = list(normalized_aux)
                if aligned:
                    # 引号按"这一行里第几个开双引号"映射到第二引擎：
                    # 两路字符数可能不同，按偏移映射会错位；按序号映射才稳。
                    # 转换位置直接从"原始行文本 → 规范化后的块文本"推出来：
                    # 块文本已经是修好的，不能再指望 _scan 还认得这次改动。
                    ordinals: set[int] = set()
                    for position, (before, after) in enumerate(zip(old_text, new_text)):
                        if before == "“" and after == "‘":
                            ordinals.add(old_text.count("“", 0, position))
                    if ordinals:
                        seen = 0
                        for position, ch in enumerate(aux_chars):
                            if ch != "“":
                                continue
                            if seen in ordinals:
                                aux_chars[position] = "‘"
                            seen += 1
                new_aux = "".join(aux_chars)
            before_key = row["diff_status"] or "none"
            before_counts[before_key] = before_counts.get(before_key, 0) + 1
            if old_aux is not None:
                new_status = compare_module.compare_line(new_text, new_aux)
            else:
                new_status = row["diff_status"]
            after_key = new_status or "none"
            after_counts[after_key] = after_counts.get(after_key, 0) + 1
            text_changed = new_text != old_text
            aux_changed = new_aux != old_aux
            status_changed = new_status != row["diff_status"]
            if not (text_changed or aux_changed or status_changed):
                continue
            if text_changed:
                stats["text_changed"] += 1
            if aux_changed:
                stats["aux_changed"] += 1
            if status_changed:
                stats["status_changed"] += 1
            entries.append(
                {
                    "line_id": row["line_id"],
                    "block_id": block_id,
                    "line_index": row["line_index"],
                    "before_text": old_text,
                    "before_aux": old_aux,
                    "before_status": row["diff_status"],
                    "after_text": new_text,
                    "after_aux": new_aux,
                    "after_status": new_status,
                }
            )
    stats["before"] = before_counts
    stats["after"] = after_counts
    stats["changed"] = len(entries)
    return {"stats": stats, "entries": entries}


def apply_lines(
    project_id: str,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> dict:
    """执行：改 `block_line.text` / `aux_text` / `diff_status`（同一事务）。

    返回的 `entries` 由调用方写成回滚文件（行级改动不进块事件撤销栈）。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    plan = lines_plan(project_id, library=target_library)
    entries = plan["entries"]
    if not entries:
        return {"stats": plan["stats"], "changed": 0, "entries": []}
    directory = library_module.project_dir(target_library, project_id)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        for entry in entries:
            conn.execute(
                "UPDATE block_line SET text = ?, aux_text = ?, diff_status = ?"
                " WHERE line_id = ?",
                (
                    entry["after_text"],
                    entry["after_aux"],
                    entry["after_status"],
                    entry["line_id"],
                ),
            )
        conn.commit()
    return {
        "stats": plan["stats"],
        "changed": len(entries),
        "entries": entries,
    }
