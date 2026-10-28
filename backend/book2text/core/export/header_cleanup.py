"""页眉 / 页码行的剔除（任务 74）。

**为什么需要**：这本书（《安乐哲 译本处理》662 页）的页眉印的是 `Page 28`，
识别把它落成了一个普通 `paragraph` 块（整块就这一行），或者并进了正文首段。
于是它既进导出正文、又被版心拟合当成"顶边那一行"——用户看到的是
「页码几乎全被识别在版心内部」。

**为什么是窄规则**：只从**每页第一个块的第一行**看。全书行级正则替换踩过坑
（正文里真的存在整行是"红楼梦"的情况），而页眉的位置是结构性的：它就是页的第一行。

判据（大小写不敏感，允许前后破折号）：

- 整行就是 `Page 28` / `P. 28` / `- 28 -` → 整行摘掉；
- 行首是 `Page 28 ` 后面还跟着正文（OCR 把页眉与首段并成了一行）→ **只摘前缀**，
  剩下的正文保留（这种情况 `strip_leading_header_line` 会返回去掉前缀后的行）。
"""

from __future__ import annotations

import re

#: 页码的"编号部分"：阿拉伯数字或罗马数字（这本书前置部分印的是 i–xix）
_NUMBER = r"(?:\d{1,4}|[ivxlcdm]{1,7})"
#: 整行就是页码（带词 / 带点 / 带破折号都算）
PAGE_LINE = re.compile(rf"^(?:page|p\.?)\s*[-–—]?\s*{_NUMBER}\s*[-–—]?$", re.IGNORECASE)
#: 整行就是裸数字（`28` / `- 28 -`）—— 只在"每页第一个块的第一行"才会用到
BARE_PAGE_LINE = re.compile(r"^[-–—\s]*\d{1,4}[-–—\s]*$")
#: 行首是页码、后面还跟着正文（OCR 把页眉并进了首段）
PAGE_PREFIX = re.compile(rf"^(?:page|p\.?)\s*[-–—]?\s*{_NUMBER}\s+(?=\S)", re.IGNORECASE)
#: 并进正文时，前缀后面至少要有这么长才算"正文"（避免把 "Page 3" 之后的短词当正文）
MIN_TAIL_CHARS = 12


def is_page_line(text: str) -> bool:
    """这一行是不是"整行只有页码"。"""
    compact = " ".join((text or "").split())
    return bool(PAGE_LINE.match(compact) or BARE_PAGE_LINE.match(compact))


def is_labeled_page_line(text: str) -> bool:
    """整行是**带词**的页码（`Page 28` / `P. 28` / `Page viii`）。

    与 `is_page_line` 的区别：**不认裸数字**。裸数字只在"每页第一个块的第一行"这个
    位置才当页眉（那里是结构性位置）；出现在任意位置的裸数字很可能就是正文里的一个数
    （测试里就有一页正文块只有 `11`）。
    """
    return bool(PAGE_LINE.match(" ".join((text or "").split())))


def strip_leading_header_line(lines: list[str]) -> list[str]:
    """摘掉首行页眉（只处理第一行；不是页眉就原样返回）。

    返回**新的列表**，不修改入参。
    """
    if not lines:
        return lines
    first = lines[0]
    compact = " ".join(first.split())
    if PAGE_LINE.match(compact) or BARE_PAGE_LINE.match(compact):
        return lines[1:]
    match = PAGE_PREFIX.match(compact)
    if match:
        tail = compact[match.end():].strip()
        # 前缀后面得真的跟着一段正文，否则宁可不摘（`Page 3` 单独成行那种上面已处理）
        if len(tail) >= MIN_TAIL_CHARS:
            return [tail] + list(lines[1:])
    return lines


def merged_header_prefix(text: str) -> str | None:
    """如果首行是"页码 + 正文"并在一起，返回页码那一截（用于报数 / 诊断）。"""
    match = PAGE_PREFIX.match(" ".join((text or "").split()))
    return match.group(0).strip() if match else None
