"""用 PDF 文字层当第二引擎（任务 58）。

**为什么**：可搜索 PDF 的文字层本身就是某一版 OCR 的产物（`b2t_RXQ39D` 的文字层就是
用户用 OCRmyPDF + Apple Vision 做的）。再花几十分钟跑一遍 Apple Vision 是重复劳动，
而且结果只是"同一套模型再看一遍"。文字层已经在 PDF 里，直接拿来当第二意见。

**配对不能只按坐标**：换一本书、换一个扫描件，文字层的行切分与第一引擎不一定一致
（可能多切一行、少切一行、断词位置不同）。所以：

1. 按**阅读顺序**做序列对齐（动态规划，允许两边各自跳过若干行）；
2. 得分以**文本相似度**为主；
3. **坐标只用来验证**：两行纵向有重叠就给一点加分，完全不重叠的配对会被压到
   匹配门槛以下（只有相似度高到能自证时才接受）。

没有文字层 / 页面旋转不是 0 时调用方回退到真正的第二引擎。
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher

from .base import BBox

# 区域重叠低于这个值就不加分（文字层与第一引擎的行框通常差 2–4pt，容差给足）
VERTICAL_OVERLAP_BONUS = 0.15
# 匹配的基础扣分：低于这个相似度的配对，只有在坐标也对得上时才值得接受
MATCH_PENALTY = 0.30
# 跳过一行 / 一条文字层行的代价。跳文字层更便宜：文字层常常把页眉页脚也切出来。
GAP_ROW = -0.15
GAP_LINE = -0.08
# 接受门槛：相似度不低于它，或者纵向重叠不低于 0.5（同一行、只是切分不同）
MIN_SIMILARITY = 0.20
MIN_OVERLAP = 0.50


@dataclass(frozen=True)
class TextLayerLine:
    text: str
    bbox: BBox


def _normalize(text: str) -> str:
    """比相似度时忽略空白与大小写（标点差异留给 compare_line 判 format_only）。"""
    return "".join(ch.lower() for ch in (text or "") if not ch.isspace())


def similarity(left: str, right: str) -> float:
    a, b = _normalize(left), _normalize(right)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _vertical_overlap(a: BBox, b: BBox) -> float:
    y0 = max(a[1], b[1])
    y1 = min(a[3], b[3])
    if y1 <= y0:
        return 0.0
    height = min(a[3] - a[1], b[3] - b[1])
    if height <= 0:
        return 0.0
    return (y1 - y0) / height


def _pair_score(row: dict, line: TextLayerLine) -> tuple[float, float, float]:
    """(得分, 相似度, 纵向重叠)。"""
    sim = similarity(row.get("text") or "", line.text)
    overlap = 0.0
    bbox = row.get("bbox")
    if bbox is not None and len(bbox) == 4:
        overlap = _vertical_overlap(tuple(bbox), line.bbox)
    score = sim - MATCH_PENALTY + (VERTICAL_OVERLAP_BONUS if overlap >= 0.3 else 0.0)
    return score, sim, overlap


def align_rows(rows: list[dict], lines: list[TextLayerLine]) -> list[str]:
    """把文字层的行配给第一引擎的行；返回每一行的 aux 文本（没配上的是空串）。

    ``rows`` 每项至少要有 ``text`` 和 ``bbox``（归一化）；顺序必须是阅读顺序。
    """
    if not rows:
        return []
    if not lines:
        return ["" for _ in rows]
    n, m = len(rows), len(lines)
    # dp[i][j]：前 i 行与前 j 条文字层行的最佳得分
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i * GAP_ROW
    for j in range(1, m + 1):
        dp[0][j] = j * GAP_LINE
    for i in range(1, n + 1):
        row = rows[i - 1]
        for j in range(1, m + 1):
            score, sim, overlap = _pair_score(row, lines[j - 1])
            best = max(
                dp[i - 1][j] + GAP_ROW,
                dp[i][j - 1] + GAP_LINE,
            )
            acceptable = sim >= MIN_SIMILARITY or overlap >= MIN_OVERLAP
            if acceptable:
                best = max(best, dp[i - 1][j - 1] + score)
            dp[i][j] = best

    # 回溯：拿到配对的 (行, 文字层行)
    pairs: dict[int, int] = {}
    i, j = n, m
    while i > 0 and j > 0:
        score, sim, overlap = _pair_score(rows[i - 1], lines[j - 1])
        acceptable = sim >= MIN_SIMILARITY or overlap >= MIN_OVERLAP
        if acceptable and abs(dp[i][j] - (dp[i - 1][j - 1] + score)) < 1e-9:
            pairs[i - 1] = j - 1
            i -= 1
            j -= 1
        elif abs(dp[i][j] - (dp[i - 1][j] + GAP_ROW)) < 1e-9:
            i -= 1
        else:
            j -= 1

    # ---- 补配：DP 是按顺序走的，个别行会因为"文字层多切了一行"被跳过。
    # 这里用坐标**验证**一遍：纵向几乎完全重叠、又没被用过的文字层行，配回去。
    used = set(pairs.values())
    for index in range(n):
        if index in pairs:
            continue
        bbox = rows[index].get("bbox")
        if bbox is None or len(bbox) != 4:
            continue
        best = None
        for line_index, line in enumerate(lines):
            if line_index in used:
                continue
            overlap = _vertical_overlap(tuple(bbox), line.bbox)
            if overlap < 0.6:
                continue
            sim = similarity(rows[index].get("text") or "", line.text)
            score = overlap + 0.2 * sim
            if best is None or score > best[0]:
                best = (score, line_index)
        if best is not None:
            pairs[index] = best[1]
            used.add(best[1])

    return [
        lines[pairs[index]].text if index in pairs else ""
        for index in range(n)
    ]
