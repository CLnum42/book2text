"""行合并规则（说明书 9.2）：把块内换行、以及跨块拼接处拼成连续文本。

说明书 9.2 规定"块内换行和跨块拼接**使用同一规则**"，因此本模块只提供一个
基本操作 `join_pair(左, 右)`，块内拼接与未来的段生成（9.1）都走它。

规则表（说明书原文）::

    | 换行前                     | 换行后                     | 处理 |
    |----------------------------|----------------------------|------|
    | 中日韩字符或全角标点       | 中日韩字符或全角标点       | 直接连接，不加空格 |
    | 拉丁字母 + 行尾连字符 -    | 小写拉丁字母               | 断词还原开启：删连字符直接连；关闭：留连字符直接连 |
    | 拉丁字符或半角标点         | 拉丁字符                   | 加一个空格 |
    | 中日韩字符                 | 拉丁字符（或反之）         | 直接连接，不额外加空格 |

**本模块对说明书未覆盖情形的解释（写明以便审计，不是自由发挥）：**

1. **规则 3 右侧的"拉丁字符"含数字。** 英文用空格分词，"chapter" + "3 begins"
   需要空格。若只认字母，这类换行会拼成 "chapter3"，属明显错误。
2. **规则 3 右侧只算字母与数字，不算标点。** "abc," + "def" 应得 "abc, def"；
   而 "abc" + ", def" 若加空格会变成 "abc , def"，是错的，因此右侧为标点时不加空格。
3. **说明书未列出的组合一律不加空格。** 在说明书没要求的位置插入空格，
   比直接连接更容易破坏原文；直接连接至少不引入原文本没有的字符。
4. **规则 2 的补充：左侧以连字符结尾、右侧以大写拉丁字母或数字开头。**
   说明书只规定"拉丁字母 + 连字符"与"小写拉丁字母"的组合。此处按
   "**保留连字符并直接连接**"处理（即规则 2 关闭断词还原时的行为），因为：

   - ``Anglo-`` + ``Saxon`` 拼成 ``Anglo- Saxon`` 明显不对，``Anglo-Saxon`` 才对；
   - ``1990-`` + ``1995`` 是区间号，拼成 ``1990- 1995`` 同样不对。

   判据是"连字符两侧都是拉丁字母或数字，且它出现在行尾"——这在排版上就是
   "该词/该串在下一行继续"，因此直接连接。
5. **弯引号按标点归类。** 以便 ``word,” + 拉丁字母`` 能走规则 3 得到空格。

**续行不保留缩进：** 拼接前会去掉每行首尾空白（对应说明书 9.3 的"去除行首尾多余空白"）。
行内缩进是版面信息，不属于段落文本。
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Sequence

# 规则 2 里"行尾连字符"的候选字符。说明书写的是 `-`，但排版上
# 断词连字符也可能是 U+2010（hyphen）。两种都认，并在记录里写明用的是哪个。
_HYPHENS = "-‐"


@dataclass(frozen=True)
class HyphenationRestore:
    """一次被"英文断词还原"处理过的位置。

    说明书 9.2 要求"所有被英文断词还原处理过的位置都记录在 manifest.json 中，
    便于抽查（例如 ``self-`` + ``evident`` 这类真实连字符可能被误处理）"。
    本模块负责产出记录，写入 manifest 是导出模块的事（9.5）。
    """

    position: int          # 在拼接结果中的字符位置（还原后该词的首字符）
    left_fragment: str     # 例如 "self-"
    right_fragment: str    # 例如 "evident"
    hyphen: str            # 被删掉的连字符字符

    def to_dict(self) -> dict[str, object]:
        return {
            "position": self.position,
            "left_fragment": self.left_fragment,
            "right_fragment": self.right_fragment,
            "hyphen": self.hyphen,
        }


@dataclass(frozen=True)
class JoinResult:
    text: str
    hyphenations: tuple[HyphenationRestore, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "text": self.text,
            "hyphenations": [item.to_dict() for item in self.hyphenations],
        }


# ---------------------------------------------------------------- 字符分类

def is_cjk(char: str) -> bool:
    """是否为"中日韩字符或全角标点"（说明书 9.2 的措辞）。"""
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
    )


def is_latin_alnum(char: str) -> bool:
    """拉丁字母或数字（见模块说明第 1 条解释）。"""
    return char.isascii() and char.isalnum()


def is_punctuation(char: str) -> bool:
    """标点。弯引号（U+2018–201D）也算，见模块说明第 5 条。"""
    if not char:
        return False
    if char.isascii():
        return not char.isalnum()
    if 0x2018 <= ord(char) <= 0x201D:
        return True
    return unicodedata.category(char).startswith("P")


def _trailing_hyphen(text: str) -> tuple[str, str] | None:
    """若 ``text`` 以"拉丁字母或数字 + 连字符"结尾，返回 ``(前一字符, 连字符)``。

    含数字是为了覆盖 ``1990-`` 这类区间号断行（见模块说明第 4 条）。
    """
    if len(text) < 2 or text[-1] not in _HYPHENS:
        return None
    previous = text[-2]
    if not (previous.isascii() and previous.isalnum()):
        return None
    return previous, text[-1]


def tail_fragment(text: str, limit: int = 40) -> str:
    """取末尾一个"词"（以空白分隔），供断词还原记录使用。

    manifest 的用途是**人工抽查**（说明书 9.2），所以记录 ``self-`` 比记录整段文字有用。
    """
    stripped = text.rstrip()
    index = len(stripped)
    while index > 0 and not stripped[index - 1].isspace():
        index -= 1
    return stripped[index:][-limit:]


def head_fragment(text: str, limit: int = 40) -> str:
    """取开头一个"词"，与 `tail_fragment` 对称。"""
    stripped = text.lstrip()
    index = 0
    while index < len(stripped) and not stripped[index].isspace():
        index += 1
    return stripped[:index][:limit]


# ---------------------------------------------------------------- 核心规则

def join_pair(left: str, right: str, *, restore_hyphenation: bool = True) -> tuple[str, str, str | None]:
    """把两段文本按说明书 9.2 拼起来。

    返回 ``(拼接结果, 左侧片段, 被删掉的连字符或 None)``。
    左侧片段供调用方记录断词还原位置使用。
    """
    left = left.rstrip()
    right = right.lstrip()
    if not left:
        return right, "", None
    if not right:
        return left, "", None

    left_last = left[-1]
    right_first = right[0]

    # 规则 2：拉丁字母/数字 + 行尾连字符 | 拉丁字母或数字
    hyphen_info = _trailing_hyphen(left)
    if hyphen_info is not None and right_first.isascii() and right_first.isalnum():
        _previous, hyphen = hyphen_info
        if restore_hyphenation and right_first.islower():
            # 删掉连字符，直接连
            return left[:-1] + right, tail_fragment(left), hyphen
        # 关闭断词还原：保留连字符直接连；
        # 右侧是大写字母或数字时也走这里（模块说明第 4 条）
        return left + right, "", None

    # 规则 1 / 4：左侧是中日韩字符或全角标点 → 不加空格
    if is_cjk(left_last):
        return left + right, left, None

    # 规则 4：右侧是中日韩字符 → 不加空格
    if is_cjk(right_first):
        return left + right, left, None

    # 规则 3：拉丁字符或半角标点 | 拉丁字符（含数字）→ 加一个空格
    if is_latin_alnum(right_first) and (
        is_latin_alnum(left_last) or is_punctuation(left_last)
    ):
        return f"{left} {right}", left, None

    # 其余组合：不加空格（模块说明第 3 条）
    return left + right, left, None


def join_lines(
    lines: Sequence[str],
    *,
    restore_hyphenation: bool = True,
) -> JoinResult:
    """把若干行拼成一段连续文本。

    块内换行与跨块拼接都用它（说明书 9.2：两者使用同一规则）。
    """
    pieces: list[str] = []
    hyphenations: list[HyphenationRestore] = []
    text = ""

    for raw in lines:
        piece = raw.strip()
        if not piece:
            continue
        if not pieces:
            pieces.append(piece)
            text = piece
            continue

        merged, left_fragment, hyphen = join_pair(
            text, piece, restore_hyphenation=restore_hyphenation
        )
        if hyphen is not None:
            hyphenations.append(
                HyphenationRestore(
                    position=len(merged) - len(piece),
                    left_fragment=left_fragment,
                    right_fragment=head_fragment(piece),
                    hyphen=hyphen,
                )
            )
        pieces.append(piece)
        text = merged

    return JoinResult(text=text, hyphenations=tuple(hyphenations))
