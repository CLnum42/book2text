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


#: 家具块里"噪声行"允许的最大长度（「红楼梦画」4 字；超过就不当噪声，宁可留着）
FURNITURE_LINE_MAX = 8
#: 句读标点：行里出现任何一个就说明它是正文，不是书眉
_SENTENCE_PUNCT = set("，。！？；：、（）《》「」『』【】…—“”‘’")


def is_furniture_block(lines: list[str]) -> bool:
    """整块是不是「书眉 + 页码」被 OCR 并成了一个正文块。

    现象（2026-11-04，红楼梦 40 页 p36）：竖排书眉「红楼梦 第三回」与页脚页码「72」
    被识别成一个 paragraph 块，导出正文里出现「红楼梦画\\n72」。其余 37 页同样的块靠
    "版心外"被排掉；p36 的版心拟合把左侧竖排栏包进了版心，只能靠这条形状判据兜底。

    判据（窄，只看形状不看书名）：
    - 至少两行（单行页码块已由 ``is_labeled_page_line`` 那条规则处理）；
    - 至少一行是整行页码（``Page 28`` / 裸数字）；
    - 其余每一行都是「短、无句读」的噪声行。

    反例（必须放行）：正文里含《红楼梦》的长段（有句读、行太长）；
    标题块「红楼梦 / 第三回」（没有页码行）——它们都不满足"至少一行页码"。
    """
    texts = [" ".join(line.split()) for line in lines if line and line.strip()]
    if len(texts) < 2:
        return False
    if not any(is_page_line(text) for text in texts):
        return False
    return all(is_page_line(text) or _is_short_noise(text) for text in texts)


def _is_short_noise(text: str) -> bool:
    """短且没有句读——书眉 / OCR 噪声的形状（「红楼梦画」「揚環賣」）。"""
    if len(text) > FURNITURE_LINE_MAX:
        return False
    return not any(char in _SENTENCE_PUNCT for char in text)


def strip_leading_header_line(lines: list[str]) -> list[str]:
    """摘掉首行页眉（只处理第一行；不是页眉就原样返回）。

    返回**新的列表**，不修改入参。
    """
    if not lines:
        return lines
    first = lines[0]
    compact = " ".join(first.split())
    if PAGE_LINE.match(compact) or BARE_PAGE_LINE.match(compact):
        # 置空而不是删除：`join_lines` 按位置记账，删一行会让整块的 line_index 前移，
        # 而 marks 用的是原块下标（567 条未审里 30 条受影响，25 条会静默画到隔壁行）。
        return [""] + list(lines[1:])
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


#: 短页码：裸罗马数字，或 `7b` 这种把 `76` 认成 `7b` 的 1–4 个字符
_SHORT_PAGE_TOKEN = re.compile(r"^[\divxlcdmIVXLCDM]{1,4}\w?$")
#: 贴边判定（归一化 x）：左侧栏外 / 右侧栏外
MARGIN_LEFT_MAX = 0.28
MARGIN_RIGHT_MIN = 0.70


def is_page_number_noise(text: str, bbox=None, *, first_line: bool = False) -> bool:
    """这一行是不是**纯页码**（审校队列里要排掉的噪声），两条并列判据。

    与 `is_page_line` 的区别：那条只给"每页第一行"这个结构性位置用，
    它认裸数字（正文里单独一行 `11` 会被误伤）。这里要判的是"整页任意位置的行"，
    所以裸数字必须**同时**贴边才算——书里真的有整行只有 `红楼梦` 的正文。

    - 带词页码：`Page xxi` / `Page104` / `P. 28`（大小写、有无空格都算）；
    - 裸短页码：整行 ≤4 字符、形如 `ix` / `7b`，**并且**它是这一块的第一行
      （`first_line=True`，即"页眉并进了首段"）、整行贴在页面左/右栏外
      （`bbox` 是归一化的 `[x0, y0, x1, y1]`）。位置 + 结构两条都满足才判，
      避免把正文中间单独一行的短词（`红楼梦` 那类）误伤。
    """
    compact = " ".join((text or "").split())
    if not compact:
        return False
    if is_labeled_page_line(compact):
        return True
    if first_line and len(compact) <= 4 and _SHORT_PAGE_TOKEN.match(compact):
        if bbox is not None and len(bbox) >= 4:
            if bbox[2] <= MARGIN_LEFT_MAX or bbox[0] >= MARGIN_RIGHT_MIN:
                return True
    return False
