"""归一化与比对模块（说明书 8.7）。

**该模块不属于任何引擎，所有引擎共用，必须有完整单元测试**（说明书 8.7）。
第二引擎接入后，按行比对（说明书 8.5）也走这里。

归一化的步骤与顺序**由说明书 8.7 规定**，不是本模块的自由发挥::

    1. 统一换行与空白字符；去除行首尾空白
    2. 全角 ↔ 半角标点映射（仅在比对时使用，不修改原文本）
    3. 删除中日韩字符之间的空格（抵消 Windows OCR 的插空格行为）
    4. 常见等价符号归一化（引号、破折号写法）
    5. 拉丁字母大小写：默认**不**归一化（大小写属于原文）
    6. 英文行尾连字符：**不在此处处理**，交由导出规则的"断词还原"负责

比对结果三态（说明书 8.5 / 8.7）::

    identical            归一化前就相同（允许空白差异）
    format_only_differs  仅格式差异：归一化前不同、归一化后相同
    differs              实质差异

**本项目的实现决定（说明书未逐条规定，在此写明以便审计）：**

- ``format_only_differs`` 的判定按说明书 8.5 的表述实现：
  先做第 1 步（空白），相同即 ``identical``；再做第 2–4 步，相同即
  ``format_only_differs``；否则 ``differs``。
- 第 2 步只映射**标点**，不动汉字、字母与数字。
- 第 4 步把**破折号变体映射成同一个字符**（``— – ‒ ― −`` → ``-``），
  但**不合并连续破折号**——所以中文的 ``——`` 会变成 ``--``，
  与英文单个 ``-`` 仍不相同。合并会更激进且会改变长度，暂不做。
- 省略号 ``…`` 与 ``...`` **不作等价处理**（说明书没把它列为等价符号）。
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass

IDENTICAL = "identical"
FORMAT_ONLY_DIFFERS = "format_only_differs"
DIFFERS = "differs"

# `grade_line` 在三态之上再分出来的两级（见该函数）。**不写进数据库**：
# `block_line.diff_status` 存的是说明书 8.7 规定的三态；分级是读取时按
# "块里现在的文本"现算的——人工把那一行换成另一路之后，标记要跟着消失。
DIFFERS_CHARS = "differs_chars"
DIFFERS_PUNCT = "differs_punct"
NO_CANDIDATE = "no_candidate"

# 界面按这个顺序数（说明书 8.5 的"实质差异"再分粗细）
GRADES = (DIFFERS_CHARS, DIFFERS_PUNCT, NO_CANDIDATE, FORMAT_ONLY_DIFFERS)

# 全角标点 → 半角（说明书第 2 步）。只收标点，不含字母数字。
_FULLWIDTH_PUNCTUATION = {
    "，": ",", "。": ".", "！": "!", "？": "?", "；": ";", "：": ":",
    "（": "(", "）": ")", "【": "[", "】": "]", "｛": "{", "｝": "}",
    "、": ",", "～": "~", "￣": "~", "％": "%", "＆": "&", "＊": "*",
    "＋": "+", "－": "-", "＝": "=", "／": "/", "＼": "\\", "｜": "|",
    "＃": "#", "＠": "@", "＜": "<", "＞": ">", "＇": "'", "＂": '"',
    "，": ",", "．": ".", "：": ":", "；": ";", "？": "?", "！": "!",
}

# 等价符号归一化（说明书第 4 步）
_EQUIVALENT_SYMBOLS = {
    # 引号：各种写法归到直引号
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"', "\u2033": '"',
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
    "＂": '"', "＇": "'",
    # 破折号：变体归到 '-'，但不合并连续写法
    "\u2014": "-",  # em dash
    "\u2013": "-",  # en dash
    "\u2012": "-",  # figure dash
    "\u2015": "-",  # horizontal bar
    "\u2212": "-",  # minus sign
    "－": "-",
    "\u30fc": "-",  # 片假名长音符，常见误识别成破折号
    # 各类空白
    "\u00a0": " ", "\u3000": " ", "\u2002": " ", "\u2003": " ",
    "\u2009": " ", "\u200b": "", "\ufeff": "",
}


def _is_cjk(char: str) -> bool:
    """判断是否为"中日韩上下文"字符，用于第 3 步删空格。

    除了汉字、假名、中日韩标点与全角形式，还包含**弯引号**（``“ ” ‘ ’``）。

    **为什么弯引号也算（2026-10-14 由单元测试发现）：** 中文排版里引号紧贴汉字，
    如 ``他说：“好”``；而 ``“`` (U+201C) 不在中日韩标点区（U+3000–303F）。
    不把它算进来的话，``他说 ： “ 好 ” 。`` 这类插入的空格删不干净。

    **不会误伤英文：** 判定要求空格**两侧都是**中日韩上下文，
    所以 ``said “hi”`` 里字母与引号之间的空格会保留。
    """
    if not char:
        return False
    code = ord(char)
    return (
        0x3400 <= code <= 0x4DBF      # 扩展 A
        or 0x4E00 <= code <= 0x9FFF   # 基本区
        or 0xF900 <= code <= 0xFAFF   # 兼容表意
        or 0x3000 <= code <= 0x303F   # 中日韩标点（。、「」《》等）
        or 0xFF00 <= code <= 0xFFEF   # 全角形式（：，！等）
        or 0x3040 <= code <= 0x30FF   # 平假名 / 片假名
        or 0x2018 <= code <= 0x201D   # 弯引号 “ ” ‘ ’
    )


def unify_whitespace(text: str, *, keep_newlines: bool = True) -> str:
    """说明书第 1 步：统一换行与空白字符，去除行首尾空白。

    ``keep_newlines=False`` 时把换行也压成空格——整篇比对时用，
    这样 OCR 与金标准的**换行位置不同不会被算成错误**。
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(
        " " if unicodedata.category(char) in ("Zs", "Zl", "Zp") else char
        for char in text
    )
    text = "\n".join(" ".join(line.split()) for line in text.split("\n"))
    if not keep_newlines:
        text = " ".join(text.split())
    return text.strip()


def strip_spaces_between_cjk(text: str) -> str:
    """说明书第 3 步：删除中日韩字符之间的空格。

    只删"两侧都是中日韩字符"的空格——中英混排中 ``中文 English`` 之间的空格
    是真实存在的，不能删。
    """
    characters = list(text)
    result: list[str] = []
    index = 0
    total = len(characters)
    while index < total:
        char = characters[index]
        if char == " ":
            # 向前看：跳过连续空格，找到右侧的非空格字符
            run_end = index
            while run_end < total and characters[run_end] == " ":
                run_end += 1
            left = result[-1] if result else ""
            right = characters[run_end] if run_end < total else ""
            if _is_cjk(left) and _is_cjk(right):
                index = run_end          # 丢掉这串空格
                continue
        result.append(char)
        index += 1
    return "".join(result)


def normalize_fullwidth_punctuation(text: str) -> str:
    """说明书第 2 步：全角 ↔ 半角标点映射（只用于比对）。"""
    return "".join(_FULLWIDTH_PUNCTUATION.get(char, char) for char in text)


def normalize_equivalent_symbols(text: str) -> str:
    """说明书第 4 步：常见等价符号归一化。"""
    return "".join(_EQUIVALENT_SYMBOLS.get(char, char) for char in text)


def normalize_for_comparison(text: str, *, keep_newlines: bool = True) -> str:
    """按说明书 8.7 的第 1–4 步归一化。

    第 5 步（大小写）**默认不做**——大小写属于原文。需要宽松比对时
    调用方自行 ``casefold()``。第 6 步（行尾连字符）不在此处处理。
    """
    text = unify_whitespace(text, keep_newlines=keep_newlines)
    text = normalize_fullwidth_punctuation(text)
    text = normalize_equivalent_symbols(text)
    text = strip_spaces_between_cjk(text)
    # 归一化可能又引入多余空白（例如全角空格变成半角），最后再收一次
    return unify_whitespace(text, keep_newlines=keep_newlines)


def compare_line(reference: str, candidate: str) -> str:
    """比较两行，返回 ``identical`` / ``format_only_differs`` / ``differs``。

    对应说明书 8.5 的一致性判定：先归一化，再比较；
    格式差异**不计入分歧**，否则中文行会因为空格差异全被标成有分歧（说明书 8.6）。
    """
    if unify_whitespace(reference) == unify_whitespace(candidate):
        return IDENTICAL
    if normalize_for_comparison(reference) == normalize_for_comparison(candidate):
        return FORMAT_ONLY_DIFFERS
    return DIFFERS


def _is_significant(char: str) -> bool:
    """是不是"实质字符"：汉字、字母、数字算，空白与标点 / 符号只算排版。"""
    if char.isspace():
        return False
    return unicodedata.category(char)[0] not in ("P", "S")


def _significant_only(text: str) -> str:
    return "".join(char for char in text if _is_significant(char))


def grade_line(reference: str, candidate: str) -> str:
    """给两路结果再分一级，回答"这一处分歧值不值得看"（说明书 8.5 的延伸）。

    说明书 8.5 把差异分成"实质差异"与"格式差异"，落在 ``differs`` 里的仍然混着
    两类东西：**汉字 / 数字层面的不同**（可能是第一引擎真的认错了）与
    **标点层面的不同**（多半只是第二引擎的标点习惯，见 `docs/known-limitations.md` L-30
    的实测：两路分歧里七成是第二引擎自己的错，且集中在标点）。分级让审校能只按
    "汉字级"筛选，否则筛出来的多是噪声。

    返回四态之一：

    ====================  =========================================================
    ``identical``         归一化前就相同
    ``format_only_differs`` 仅格式差异（说明书 8.5 不计入分歧）
    ``differs_punct``     归一化后只剩标点 / 符号不同（"标点级"）
    ``differs_chars``     归一化后汉字、字母或数字不同（"汉字级"，值得看）
    ====================  =========================================================

    **空候选**（第二引擎什么也没读出来）不属于分歧：它没提供任何关于原文的信息，
    标它只会制造噪声。调用方应先判空，用 ``no_candidate`` 单独计数。
    """
    base = compare_line(reference, candidate)
    if base != DIFFERS:
        return base
    left = _significant_only(normalize_for_comparison(reference))
    right = _significant_only(normalize_for_comparison(candidate))
    return DIFFERS_PUNCT if left == right else DIFFERS_CHARS


# ---------------------------------------------------------------- 编辑距离与错误率

def levenshtein(reference: str, hypothesis: str) -> int:
    """字符级编辑距离（插入 / 删除 / 替换各计 1）。

    两行滚动数组实现，避免构建整个矩阵；几千字符的文本也能接受。
    """
    if reference == hypothesis:
        return 0
    if not reference:
        return len(hypothesis)
    if not hypothesis:
        return len(reference)

    previous = list(range(len(hypothesis) + 1))
    current = [0] * (len(hypothesis) + 1)

    for i, ref_char in enumerate(reference, start=1):
        current[0] = i
        for j, hyp_char in enumerate(hypothesis, start=1):
            cost = 0 if ref_char == hyp_char else 1
            current[j] = min(
                previous[j] + 1,        # 删除
                current[j - 1] + 1,     # 插入
                previous[j - 1] + cost,  # 替换
            )
        previous, current = current, previous
    return previous[len(hypothesis)]


def character_error_rate(reference: str, hypothesis: str) -> float:
    """CER = 编辑距离 / 参考文本长度。

    参考文本为空时返回 0.0（无内容即无错误），由调用方判断是否有意义。
    """
    if not reference:
        return 0.0
    return levenshtein(reference, hypothesis) / len(reference)


def word_error_rate(reference: str, hypothesis: str) -> float:
    """WER = 词级编辑距离 / 参考词数。适合评估英文。"""
    ref_words = reference.split()
    hyp_words = hypothesis.split()
    if not ref_words:
        return 0.0
    return levenshtein_tokens(ref_words, hyp_words) / len(ref_words)


def levenshtein_tokens(reference: list[str], hypothesis: list[str]) -> int:
    """序列级编辑距离（按 token 比较）。"""
    if reference == hypothesis:
        return 0
    if not reference:
        return len(hypothesis)
    if not hypothesis:
        return len(reference)

    previous = list(range(len(hypothesis) + 1))
    current = [0] * (len(hypothesis) + 1)
    for i, ref_token in enumerate(reference, start=1):
        current[0] = i
        for j, hyp_token in enumerate(hypothesis, start=1):
            cost = 0 if ref_token == hyp_token else 1
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
        previous, current = current, previous
    return previous[len(hypothesis)]


def normalize_whitespace_insensitive(text: str) -> str:
    """删除**全部**空白，用于准确率测量——**这不是说明书 8.7 的一部分**。

    **为什么需要它（2026-10-14 实测发现）：**

    说明书 8.7 第 3 步只规定"删除**中日韩字符之间**的空格"。但在实测合成语料时发现，
    大量差异出现在**中日韩与拉丁/数字的边界**上，而该规则覆盖不到::

        金标准：这份文档的格式是 PDF，编码是 UTF-8，换行符统一为 LF。
        识别：  这份文档的格式是PDF，编码是UTF-8，换行符统一为LF。

        金标准：论文引用了 Kuhn (1962) 与 Baker (1993) 两部经典文献。
        识别：  论文引用了Kuhn (1962) 与Baker(1993) 两部经典文献。

    这类差异是**排版约定**差异（中文里拉丁词两侧是否留空隙），不是内容识别错误。
    按 8.7 的字面规则它们会被计入 CER，从而高估错误率。中文 OCR 评估的通行做法
    是比对前去掉所有空白，这里提供该口径供测量使用。

    **重要：** 本函数**不替代** 8.7 的规则。测量时两种口径都要报，
    差值就是"中日韩/拉丁边界空格"造成的量。是否把这一条并入 8.7，
    属于说明书的修订问题，需要开发者决定（见 docs/accuracy-report.md）。
    """
    return "".join(char for char in text if not char.isspace())


@dataclass(frozen=True)
class TextScore:
    """一段文本的比对结果。"""

    reference_chars: int
    hypothesis_chars: int
    distance: int
    cer: float
    reference_words: int
    word_distance: int
    wer: float | None

    def to_dict(self) -> dict[str, object]:
        return {
            "reference_chars": self.reference_chars,
            "hypothesis_chars": self.hypothesis_chars,
            "distance": self.distance,
            "cer": round(self.cer, 6),
            "reference_words": self.reference_words,
            "word_distance": self.word_distance,
            "wer": None if self.wer is None else round(self.wer, 6),
        }


def score_text(reference: str, hypothesis: str, *, compute_wer: bool = True) -> TextScore:
    """计算一段文本的 CER 与 WER（参考文本应按调用方需要先归一化）。"""
    distance = levenshtein(reference, hypothesis)
    reference_words = reference.split()
    hypothesis_words = hypothesis.split()
    word_distance = (
        levenshtein_tokens(reference_words, hypothesis_words) if compute_wer else 0
    )
    return TextScore(
        reference_chars=len(reference),
        hypothesis_chars=len(hypothesis),
        distance=distance,
        cer=distance / len(reference) if reference else 0.0,
        reference_words=len(reference_words),
        word_distance=word_distance,
        wer=word_distance / len(reference_words) if (compute_wer and reference_words) else None,
    )
