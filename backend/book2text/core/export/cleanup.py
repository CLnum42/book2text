"""清理规则（说明书 9.3）。

说明书 9.3 的规则表::

    | 规则                  | 默认 | 说明 |
    |-----------------------|------|------|
    | 排除页眉 / 页脚 / 页码块 | 开   | 按块类型排除 |
    | 段内行合并             | 开   | 按 9.2 规则；关闭时保留原始换行 |
    | 英文断词还原           | 开   | 见 9.2 |
    | 规范化换行符           | 开   | 统一为 LF |
    | 去除行首尾多余空白     | 开   | 不改变行内字符 |

**说明书明确禁止提供的规则（不得提供，也不得默认开启）：**

    「全局替换引号或破折号、统一全角 / 半角、拼写纠正、删除"疑似重复行"」

这条禁令与产品的"原文优先"原则一致——这些操作都会改动原文。
`tests/unit/test_export_cleanup.py` 里有一项测试**锁定 `CleanupRules` 的字段集合**，
防止今后有人悄悄往这里加一条被禁止的规则。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, fields

# 说明书 9.3 明文禁止的规则（不得提供）。保留此常量供文档与测试引用。
FORBIDDEN_RULES = (
    "全局替换引号",
    "全局替换破折号",
    "统一全角半角",
    "拼写纠正",
    "删除疑似重复行",
)


@dataclass(frozen=True)
class CleanupRules:
    """五项清理规则的开关，默认值与说明书 9.3 一致（全部为开）。"""

    exclude_header_footer: bool = True
    merge_lines_in_block: bool = True
    restore_hyphenation: bool = True
    normalize_newlines: bool = True
    strip_line_whitespace: bool = True

    @property
    def excluded_block_types(self) -> frozenset[str]:
        """要排除的块类型。关闭时返回空集。"""
        if not self.exclude_header_footer:
            return frozenset()
        from .segments import DEFAULT_EXCLUDED_TYPES

        return DEFAULT_EXCLUDED_TYPES


def normalize_line(raw: str, rules: CleanupRules) -> str:
    """按规则处理单行：规范化换行符、去除首尾空白。"""
    line = raw
    if rules.normalize_newlines:
        line = line.replace("\r\n", "\n").replace("\r", "\n")
    if rules.strip_line_whitespace:
        line = line.strip()
    return line


def clean_lines(lines: Sequence[str], rules: CleanupRules) -> list[str]:
    """处理一个块的所有行。

    ``merge_lines_in_block`` 为假时保留原始换行——调用方应当直接用
    ``"\\n".join(结果)`` 作为块文本，而不是走 9.2 的合并。
    """
    return [normalize_line(line, rules) for line in lines]


def rules_field_names() -> tuple[str, ...]:
    """`CleanupRules` 的字段名。供测试锁定字段集合使用。"""
    return tuple(field.name for field in fields(CleanupRules))
