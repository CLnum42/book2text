"""版面归属规则：共用底层 + 行级判定（产品与实验脚本不再各存一份）。

- **共用底层**：文字形态、页码候选、标题标记、重复相似度都在这里。
  `core/project/structure.py`（块级：结构工具 + 只读块类型建议）与
  `scripts/measure_region_classification.py`（行级实验）都 import 本模块；
- **行级判定** `classify_pages()` 是任务 34 的实验粒度；产品里的建议走**块级**
  （`structure.suggest_block_types`），因为 40 页实测块级导出 CER 更好
  （0.68% vs 0.71%，见 `docs/region-classification-eval.md`）。块级几何仍在
  `structure.py`，与批量工具同一条 `_region_of / _propose` 路径。

三类信号（说明书 6.5 的位置规则 + 说明书 8.7 的"重复性家具"思路）：

1. **几何**：以**本页正文文字块的边界**为参照，而不是整页边界——整页边界会把
   留白算进去，而不同书的留白宽度差得远。正文块取"与最多其他行横向重叠"的那一
   列，框取该列的最小外接矩形；落在框外一个"行高 / 字宽"容差内的行才是候选。
2. **跨页重复**：同一区域、同一位置、文本相似度 ≥ 0.6 的行在 ≥ 3 页出现
   （书眉、页脚是重复性家具；比较时忽略空白与阿拉伯数字，`第 3 回` 与 `第 4 回`
   是同一件家具）。
3. **文字形态**：纯数字 / 罗马数字（含 `· 62 ·` 这类装饰包裹）判页码——由本模块的
   `looks_like_a_number()` 判定，`structure.py` 也从这里 import，保证同一口径；
   另外用 `max_chars` 给"短行"设上限，**长行即使落在边缘条带里也不动它**
   （这是第 37 页误伤的教训）。

**已知的判不准的地方（测量报告里要用数字说明）：**

- **章首回目与书眉在几何上无法区分**：本书第 1、14、25 页的回目排在正文左侧，
  与"左栏竖排书眉"落在同一条带里。回目是正文结构（heading），不是页眉；
  因此它只能拿到 ``review``，**不会被自动剔除**。规则不解决标题识别，
  只保证"不误删"。
- 居中页脚若落在正文列内，会被当成正文的顶 / 底行、框到正文框里，
  几何信号就失效；这时只剩文字形态与跨页重复可用。
- 两页之间的正文列换边（本书的章首页正文在右、普通页在左）不影响本规则，
  因为框是**逐页**估的。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable, Sequence

KIND_BODY = "body"
KIND_HEADER = "header"
KIND_FOOTER = "footer"
KIND_PAGE_NUMBER = "page_number"

CONFIDENCE_HIGH = "high"
CONFIDENCE_REVIEW = "review"

# 条带宽度：相对**本页正文块**的行高中位数 / 字宽中位数，而不是页高 / 页宽。
# 0.25 行高：正文块的首行、末行自己的 bbox 会越过这个容差，因此不会被自己的边框住。
DEFAULT_BAND_LINES = 0.25
DEFAULT_BAND_CHARS = 0.25
# "短行"上限，沿用说明书 6.5 的默认值（结构工具里的 DEFAULT_MAX_CHARS）
DEFAULT_MAX_CHARS = 20
# 跨页重复的判定，沿用 structure.py 的两个常量
REPEAT_THRESHOLD = 3
REPEAT_SIMILARITY = 0.6
# "同一位置"的容差：bbox 中心点的归一化距离（占页宽 / 页高的比例）。
# 书眉是印刷位置固定的家具，OCR 框的抖动远小于这个值。
REPEAT_POSITION_TOLERANCE = 0.05

# 纯数字 / 罗马数字（允许常见的装饰字符包着，如 "· 62 ·"、"- iv -"）。
# 这个正则原来在 `structure.py`；移到这里是为了让产品与实验脚本共用一份实现。
_NUMBER_PATTERN = re.compile(
    r"^[\s.·•\-–—_=~*()\[\]{}【】〔〕「」『』<>]*"
    r"(\d{1,4}|[ivxlcdmIVXLCDM]{1,12})"
    r"[\s.·•\-–—_=~*()\[\]{}【】〔〕「」『』<>]*$"
)


def looks_like_a_number(text: str) -> bool:
    """纯数字或罗马数字（允许被装饰字符包着、允许 OCR 把数字拆行）。

    ``"14\n1"`` 这种是 OCR 把一行的数字读成两截，实质仍是数字——先去掉空白再判断。
    """
    return bool(_NUMBER_PATTERN.match(re.sub(r"\s+", "", text)))


@dataclass(frozen=True)
class Line:
    """一行 OCR 结果。bbox 是归一化坐标（左上原点，0–1）。"""

    text: str
    bbox: tuple[float, float, float, float]

    @property
    def center(self) -> tuple[float, float]:
        x0, y0, x1, y1 = self.bbox
        return ((x0 + x1) / 2, (y0 + y1) / 2)

    @property
    def width(self) -> float:
        return self.bbox[2] - self.bbox[0]

    @property
    def height(self) -> float:
        return self.bbox[3] - self.bbox[1]


@dataclass(frozen=True)
class PageLines:
    page_no: int
    lines: tuple[Line, ...]


@dataclass(frozen=True)
class Frame:
    """一页的正文文字块边界（归一化坐标）。"""

    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    def to_dict(self) -> dict[str, float]:
        return {"x0": round(self.x0, 4), "y0": round(self.y0, 4),
                "x1": round(self.x1, 4), "y1": round(self.y1, 4)}


@dataclass(frozen=True)
class Rules:
    """可调参数。默认值就是本次实验用的值（报告里要写明）。"""

    band_lines: float = DEFAULT_BAND_LINES
    band_chars: float = DEFAULT_BAND_CHARS
    max_chars: int | None = DEFAULT_MAX_CHARS
    repeat_threshold: int = REPEAT_THRESHOLD
    repeat_similarity: float = REPEAT_SIMILARITY
    repeat_position: float = REPEAT_POSITION_TOLERANCE

    def to_dict(self) -> dict[str, object]:
        return {
            "band_lines": self.band_lines,
            "band_chars": self.band_chars,
            "max_chars": self.max_chars,
            "repeat_threshold": self.repeat_threshold,
            "repeat_similarity": self.repeat_similarity,
            "repeat_position": self.repeat_position,
        }


@dataclass(frozen=True)
class Verdict:
    """一行被判成什么、有多大把握、依据是什么。"""

    page_no: int
    index: int
    kind: str
    confidence: str | None  # body 没有把握程度；候选才有 high / review
    region: str | None      # top / bottom / left / right
    signals: tuple[str, ...]

    @property
    def is_non_body(self) -> bool:
        return self.kind != KIND_BODY

    def to_dict(self) -> dict[str, object]:
        return {
            "page_no": self.page_no,
            "index": self.index,
            "kind": self.kind,
            "confidence": self.confidence,
            "region": self.region,
            "signals": list(self.signals),
        }


# ---------------------------------------------------------------- 几何

def _overlap_ratio(a: tuple[float, float, float, float],
                   b: tuple[float, float, float, float]) -> float:
    """两个横向区间 [x0, x1] 的重叠长度占较短者的比例（与 grouping 同口径）。"""
    width_a = a[2] - a[0]
    width_b = b[2] - b[0]
    if width_a <= 0 or width_b <= 0:
        return 0.0
    overlap = min(a[2], b[2]) - max(a[0], b[0])
    if overlap <= 0:
        return 0.0
    return overlap / min(width_a, width_b)


def _median(values: Sequence[float], fallback: float) -> float:
    clean = sorted(value for value in values if value > 0)
    if not clean:
        return fallback
    middle = len(clean) // 2
    if len(clean) % 2:
        return clean[middle]
    return (clean[middle - 1] + clean[middle]) / 2


def estimate_body_frame(lines: Sequence[Line]) -> Frame | None:
    """估一页的正文文字块边界。

    做法：先找出"与最多其他行横向重叠"的那一行（正文字列通常最长、行数最多），
    再把与它横向重叠 ≥ 0.5 的行算作正文列，取这一列的最小外接矩形。

    **为什么按列而不是按整页**：本书的正文列逐页换边（章首页在右、普通页在左），
    整页的中位数会把两半混在一起；按"与最多行重叠的那一行"锚定，换边不影响。
    单行页（没有"列"可言）退化成整页——这时没有候选可言，返回 `None`。
    """
    if not lines:
        return None
    best_index = 0
    best_score = -1.0
    for index, line in enumerate(lines):
        score = sum(
            1
            for other_index, other in enumerate(lines)
            if other_index != index and _overlap_ratio(line.bbox, other.bbox) >= 0.5
        )
        # 并列时取更宽的那一行（正文字列比标题、书眉宽）
        if score > best_score or (score == best_score and line.width > lines[best_index].width):
            best_index = index
            best_score = score
    if best_score <= 0:
        return None
    reference = lines[best_index].bbox
    column = [line for line in lines if _overlap_ratio(reference, line.bbox) >= 0.5]
    return Frame(
        x0=min(line.bbox[0] for line in column),
        y0=min(line.bbox[1] for line in column),
        x1=max(line.bbox[2] for line in column),
        y1=max(line.bbox[3] for line in column),
    )


def _bands(line: Line, frame: Frame, line_height: float, char_width: float,
           rules: Rules) -> tuple[str, ...]:
    """这一行落在正文框外的哪几条带里（按 top → bottom → left → right 排）。"""
    signals: list[str] = []
    if line.bbox[3] <= frame.y0 + rules.band_lines * line_height:
        signals.append("top")
    if line.bbox[1] >= frame.y1 - rules.band_lines * line_height:
        signals.append("bottom")
    if line.bbox[2] <= frame.x0 - rules.band_chars * char_width:
        signals.append("left")
    if line.bbox[0] >= frame.x1 + rules.band_chars * char_width:
        signals.append("right")
    return tuple(signals)


# ---------------------------------------------------------------- 重复性家具

def normalize_for_repeat(text: str) -> str:
    """比较"是不是同一件家具"前，拉平空白与阿拉伯数字。

    书眉每页的页码 / 回数不同（`红楼梦 第 3 回`、`红楼梦 第 4 回`），
    但它们显然是同一件家具；数字不参与比较。结构工具的重复判定也走这里，
    两边只保留一份实现（顺带把竖排书眉 OCR 常带的多余空白也去掉）。
    """
    return "".join(char for char in text if not char.isspace() and not char.isdigit())


def similar_text(left: str, right: str, threshold: float) -> bool:
    """两段文字是否"像同一句"。

    **3 个字以内要求逐字相等**：`第一回` / `第二回` / `第三回` 的相似度是 2/3 = 0.67，
    刚好过 0.6 的门槛——但这三行是**章题**，不是重复性家具。短到 3 个字时，
    相似度已经没有判别力（差一个字就是 33%），只能要求相等；`红楼梦` 这类
    3 字书眉在本书里 OCR 大多逐字一致，不一致的退化成 review（宁可交给人看）。
    """
    if not left or not right:
        return False
    if left == right:
        return True
    if min(len(left), len(right)) <= 3:
        return False
    return SequenceMatcher(None, left, right).ratio() >= threshold


@dataclass(frozen=True)
class _Candidate:
    page_no: int
    index: int
    line: Line
    region: str
    signals: tuple[str, ...]


def _candidates(page: PageLines, rules: Rules) -> tuple[list[_Candidate], Frame | None]:
    frame = estimate_body_frame(page.lines)
    if frame is None:
        return [], None
    body = [line for line in page.lines if _overlap_ratio(
        (frame.x0, frame.y0, frame.x1, frame.y1), line.bbox) >= 0.5]
    line_height = _median([line.height for line in body],
                          _median([line.height for line in page.lines], 0.02))
    char_width = _median(
        [line.width / len(line.text) for line in body if line.text.strip() and line.width > 0],
        line_height * 0.6,
    )
    found: list[_Candidate] = []
    for index, line in enumerate(page.lines):
        if not line.text.strip():
            continue
        signals = _bands(line, frame, line_height, char_width, rules)
        if not signals:
            continue
        found.append(_Candidate(page.page_no, index, line, signals[0], signals))
    return found, frame


def _is_repeated(candidate: _Candidate, all_candidates: Iterable[_Candidate],
                 rules: Rules) -> tuple[bool, int]:
    """同一位置、文本相似的行出现在多少个不同的页上（含本页）。

    **不要求 region 相同**：region 是"落在哪条带"的机械结论，同一条竖排书眉
    可能因为页面差异一会儿算左侧、一会儿算底部（实测第 24 页），按 region 分组会
    把它拆成孤例。位置（bbox 中心）本身已经是更严格的约束。
    """
    normalized = normalize_for_repeat(candidate.line.text)
    center_x, center_y = candidate.line.center
    pages: set[int] = {candidate.page_no}
    for other in all_candidates:
        if other.page_no == candidate.page_no:
            continue
        other_x, other_y = other.line.center
        if abs(other_x - center_x) > rules.repeat_position:
            continue
        if abs(other_y - center_y) > rules.repeat_position:
            continue
        if similar_text(normalized, normalize_for_repeat(other.line.text),
                    rules.repeat_similarity):
            pages.add(other.page_no)
    return len(pages) >= rules.repeat_threshold, len(pages)


# ---------------------------------------------------------------- 主入口

def classify_pages(pages: Sequence[PageLines], rules: Rules | None = None) -> list[Verdict]:
    """给每页的每一行判类型 + 把握程度。

    没有落在正文框外任何条带里的行是 ``body``；其余按三类信号判，规则是：

    - 纯数字 / 罗马数字 → ``page_number``，**high**（正文里极少整行只有一个数）；
    - 在边缘条带里、字数 ≤ max_chars、且跨页重复 → ``header`` / ``footer``，**high**；
    - 在边缘条带里、字数 ≤ max_chars、但不重复 → **review**（"位置对"不等于
      "它就是页眉"，见 `docs/ocr-evaluation.md` 6.3.1）；
    - 字数超过上限的长行 → ``body``（保护正文：块级规则曾把 19 字的段末行标成页脚，
      导致正文从导出里消失）。

    ``region`` 的优先级与产品一致：top → bottom → left → right
    （先报"顶部"比先报"左侧"更贴近人的说法）。
    """
    active = rules or Rules()
    per_page = [_candidates(page, active) for page in pages]
    all_candidates = [candidate for found, _ in per_page for candidate in found]

    verdicts: list[Verdict] = []
    for page, (found, _frame) in zip(pages, per_page):
        by_index = {candidate.index: candidate for candidate in found}
        for index, line in enumerate(page.lines):
            candidate = by_index.get(index)
            if candidate is None:
                verdicts.append(Verdict(page.page_no, index, KIND_BODY, None, None, ()))
                continue
            if looks_like_a_number(line.text):
                verdicts.append(Verdict(page.page_no, index, KIND_PAGE_NUMBER,
                                        CONFIDENCE_HIGH, candidate.region,
                                        candidate.signals + ("number_form",)))
                continue
            if active.max_chars is not None and len(line.text.strip()) > active.max_chars:
                verdicts.append(Verdict(page.page_no, index, KIND_BODY, None,
                                        candidate.region,
                                        candidate.signals + ("too_long",)))
                continue
            repeated, page_count = _is_repeated(candidate, all_candidates, active)
            kind = KIND_HEADER if candidate.region in ("top", "left", "right") else KIND_FOOTER
            confidence = CONFIDENCE_HIGH if repeated else CONFIDENCE_REVIEW
            signals = candidate.signals + (
                f"repeat:{page_count}" if repeated else "repeat:<3",)
            verdicts.append(Verdict(page.page_no, index, kind, confidence,
                                    candidate.region, signals))
    return verdicts


# ---------------------------------------------------------------- 页码候选与标题

@dataclass(frozen=True)
class NumberCandidate:
    """书眉 / 页脚里的一段数字。

    **它只是候选，不是结论。** 第二本书第 30 页的书眉是 ``2 谁是巴赫金? 11``：
    ``2`` 是节号、``11`` 是页码，只靠文字分不出哪个是页码，因此两个都返回，
    由界面标成"可能是页码"交给人选。正文块里的数字**不会**进这里——只有被判成
    页眉 / 页脚 / 页码的候选块才提取。
    """

    text: str
    start: int
    end: int
    kind: str  # "arabic" | "roman"
    value: int

    def to_dict(self) -> dict[str, object]:
        return {
            "text": self.text,
            "start": self.start,
            "end": self.end,
            "kind": self.kind,
            "value": self.value,
        }


_ARABIC_TOKEN = re.compile(r"\d{1,4}")
# 罗马数字必须是**独立的字母串**（前后不是拉丁字母），否则英文单词里的
# i / v / x / l / c / d / m 会被当成数字。
_ROMAN_TOKEN = re.compile(r"(?<![A-Za-z])([ivxlcdmIVXLCDM]{1,12})(?![A-Za-z])")
# 页码的罗马数字不会太大；上限同时把 "mix"（1009）、"civ"（104）这类英文单词挡掉
_MAX_ROMAN_PAGE = 100
_ROMAN_VALUES = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}


def _roman_value(token: str) -> int:
    total = 0
    previous = 0
    for char in reversed(token.lower()):
        value = _ROMAN_VALUES[char]
        if value < previous:
            total -= value
        else:
            total += value
            previous = value
    return total


def _to_roman(value: int) -> str:
    table = (
        (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"),
        (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"),
        (5, "V"), (4, "IV"), (1, "I"),
    )
    out = ""
    for number, token in table:
        while value >= number:
            out += token
            value -= number
    return out


def _is_canonical_roman(token: str) -> bool:
    value = _roman_value(token)
    if value <= 0 or value > _MAX_ROMAN_PAGE:
        return False
    return _to_roman(value) == token.upper()


def page_number_candidates(text: str) -> tuple[NumberCandidate, ...]:
    """从一段书眉 / 页脚文字里找出所有"可能是页码"的数字。

    阿拉伯数字与罗马数字都收；罗马数字要求是**规范写法**、独立成词、值 ≤ 100
    （挡住英文单词里的字母组合）。返回按出现位置排序，去重（同位置只留一个）。
    """
    found: list[NumberCandidate] = []
    for match in _ARABIC_TOKEN.finditer(text):
        found.append(NumberCandidate(
            text=match.group(), start=match.start(), end=match.end(),
            kind="arabic", value=int(match.group()),
        ))
    for match in _ROMAN_TOKEN.finditer(text):
        token = match.group()
        if not _is_canonical_roman(token):
            continue
        found.append(NumberCandidate(
            text=token, start=match.start(), end=match.end(),
            kind="roman", value=_roman_value(token),
        ))
    found.sort(key=lambda item: (item.start, item.end))
    return tuple(found)


def page_number_hint(candidates: Sequence[NumberCandidate],
                     bbox: tuple[float, float, float, float]) -> NumberCandidate | None:
    """从候选里挑一个"最可能是页码"的，只作为提示。

    书眉的页码一般印在**页面外侧**：左半页的书眉（如 ``10 导读巴赫金``）页码在开头，
    右半页的书眉（如 ``2 谁是巴赫金? 11``）页码在末尾。居中书眉按末尾算
    （居中排版的页码习惯收尾）。
    """
    if not candidates:
        return None
    center = (bbox[0] + bbox[2]) / 2
    if center < 0.5:
        return candidates[0]
    return candidates[-1]


# 章 / 回 / 节 / 篇 / 卷，后面可以是阿拉伯数字或中文数字；**整行**只有这个
_CHAPTER_TITLE = re.compile(r"^第\s*[0-9一二三四五六七八九十百零〇]{1,4}\s*[回章节篇部卷]\s*$")
# 常见的独立标题词（精确匹配）
_HEADING_EXACT = frozenset({
    "序", "跋", "前言", "序言", "导言", "引言", "绪论", "目录", "结语", "结论",
    "后记", "附录", "参考文献", "致谢", "译后记", "译者的话", "凡例", "索引",
    "出版说明", "进阶阅读书目",
})
# 可以出现在标题末尾的词（"丛书编者前言" 这类），只收多字词，避免 "秩序" 误中 "序"
_HEADING_SUFFIX = frozenset(word for word in _HEADING_EXACT if len(word) >= 2)


def looks_like_heading(text: str) -> bool:
    """像标题吗？（只用于给 review 建议，不参与任何自动剔除）

    判据故意很窄：**块首行**是 `第X回 / 第X章 / 第X节`，或整行是常见标题词
    （"目录""前言""参考文献"…）。这样不会把正文段落里出现的"第二章"当成标题；
    代价是**认不出没有这类标记的标题**（第二本书的“彼得格勒、涅韦尔和维捷布斯克”
    这种小节标题就认不出——它没有编号，只能靠版面模型的字号 / 字重）。
    """
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    if not lines or len(lines) > 3:
        return False
    first = lines[0]
    if len(first) > 20:
        return False
    compact = "".join(first.split())
    if _CHAPTER_TITLE.match(compact):
        return True
    if compact in _HEADING_EXACT:
        return True
    return any(compact.endswith(word) and len(compact) <= len(word) + 6
               for word in _HEADING_SUFFIX)
