"""行级版面归属判定的**候选规则**（离线实验，不进产品代码）。

这是 `scripts/measure_region_classification.py` 用的纯函数模块：给定每页的 OCR 行
（文本 + 归一化 bbox），判断每一行是 ``body`` / ``header`` / ``footer`` /
``page_number``，并标出把握程度（``high`` / ``review``）。

**为什么要有它。** 产品现在的页眉 / 页脚标注是**块级、在分段之后**做的
（`core/project/structure.py`）：一个块被标成页眉，整块都不进正文。风险是
页眉行与正文首行被拼进同一个块，于是整块被判成正文；反过来，块级位置规则
已经误伤过正文（`docs/ocr-evaluation.md` 6.3.1 的第 37 页）。本模块把判断
提前到**行级、分段之前**，并沿用产品已有的"high / review"两档口径：
只有 high 才会被自动剔除，review 留给人工确认。

**本模块不碰产品行为**：它没有被 `backend/` 引用，只在实验脚本与单元测试里用。
等测量结果出来，再由开发者决定怎么把结论搬进产品。

三类信号（说明书 6.5 的位置规则 + 说明书 8.7 的"重复性家具"思路）：

1. **几何**：以**本页正文文字块的边界**为参照，而不是整页边界——整页边界会把
   留白算进去，而不同书的留白宽度差得远。正文块取"与最多其他行横向重叠"的那一
   列，框取该列的最小外接矩形；落在框外一个"行高 / 字宽"容差内的行才是候选。
2. **跨页重复**：同一区域、同一位置、文本相似度 ≥ 0.6 的行在 ≥ 3 页出现
   （书眉、页脚是重复性家具；比较时忽略空白与阿拉伯数字，`第 3 回` 与 `第 4 回`
   是同一件家具）。
3. **文字形态**：纯数字 / 罗马数字（含 `· 62 ·` 这类装饰包裹）判页码——沿用
   `structure.looks_like_a_number`，保证与产品同一口径；另外用 `max_chars`
   给"短行"设上限，**长行即使落在边缘条带里也不动它**（这是第 37 页误伤的教训）。

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

from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable, Sequence

from book2text.core.project.structure import looks_like_a_number

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

def _normalize_for_repeat(text: str) -> str:
    """比较"是不是同一件家具"前，拉平空白与阿拉伯数字。

    书眉每页的页码 / 回数不同（`红楼梦 第 3 回`、`红楼梦 第 4 回`），
    但它们显然是同一件家具；数字不参与比较。与 `structure._normalize_for_repeat`
    同一口径，只是这里额外去掉了空白（竖排书眉的 OCR 常带空格）。
    """
    return "".join(char for char in text if not char.isspace() and not char.isdigit())


def _similar(left: str, right: str, threshold: float) -> bool:
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
    normalized = _normalize_for_repeat(candidate.line.text)
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
        if _similar(normalized, _normalize_for_repeat(other.line.text),
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
