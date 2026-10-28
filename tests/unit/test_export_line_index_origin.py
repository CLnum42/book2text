"""行拼接 / 合并阶段的**行索引语义**（纯函数层）。

锁的是三件事，防止将来"修索引错位"时改坏别人：

1. `join_lines` 返回的 `line_index` 是**入参列表的下标**：空行被跳过但下标照旧
   （`["a", "", "b"]` → `[0, 2]`，不是 `[0, 1]`）。
2. `_join_block` 返回的 `line_index` **等于它收到的行的下标**——它自己**不删行**。
   所以"页眉被删 → 索引前移"不是这里发生的：`_prepare` 先调
   `header_cleanup.strip_leading_header_line` 把列表缩短，再交给 `_join_block`。
   实测（本文件第 2 条用例）：`_join_block(["Page 5","aaa bbb","ccc ddd"], ...)`
   得到的是 `[0, 1, 2]`，`Page 5` 原样留在文本里。
3. `clean_lines` 与输入一对一（只规范化，不删行）；`strip_leading_header_line`
   才会缩短列表（`["Page 5", ...]` → `[...]`）。

**红色用例不在本文件**：把"断言 [1,2]"挂到 `_join_block` 上永远会绿（它没有删行的能力），
挂到"手工拼两步"的写法上则依赖修法落在哪一层。真正锁住产品行为的是
`tests/integration/test_review_line_index_semantics.py`（走识别 → 导出段 → 标记 → next-lines
的真实调用链，现在红 3 条）。
"""

from __future__ import annotations

from book2text.core.export import cleanup
from book2text.core.export import project as project_export
from book2text.core.export import joining
from book2text.core.export import header_cleanup

RULES = cleanup.CleanupRules()  # 五项规则全开（说明书 9.3 的默认）


def test_join_lines_keeps_index_of_skipped_blank_line() -> None:
    """空行不产生 span，但后面那行的 `line_index` 仍是它在入参里的下标。"""
    result = joining.join_lines(["a", "", "b"])
    assert [(span["line_index"], span["start"], span["end"]) for span in result.line_spans] == [
        (0, 0, 1),
        (2, 2, 3),
    ]
    assert result.text == "a b"


def test_join_block_does_not_drop_the_header_line_itself() -> None:
    """`_join_block` 不认页眉：它给什么就拼什么，索引从 0 数。

    这条是**现状与分工**的记录：页眉剔除发生在调用方（`_prepare`），
    所以索引错位的责任也在那一层，不在拼接层。
    """
    lines = ["Page 5", "aaa bbb", "ccc ddd"]
    text, _hyphenations, spans = project_export._join_block(list(lines), RULES)
    assert [span["line_index"] for span in spans] == [0, 1, 2]
    assert text == "Page 5 aaa bbb ccc ddd"


def test_clean_lines_is_one_to_one() -> None:
    """9.3 的清理规则只规范化单行，不删行——删行会让下标整体偏移。"""
    lines = ["Page 5", "aaa bbb", "   ", "ccc ddd"]
    cleaned = cleanup.clean_lines(lines, RULES)
    assert len(cleaned) == len(lines)
    assert cleaned == ["Page 5", "aaa bbb", "", "ccc ddd"]


def test_strip_leading_header_line_shortens_the_list() -> None:
    """真正缩短列表的是 `strip_leading_header_line`：这就是索引前移 1 的来源。"""
    lines = ["Page 5", "aaa bbb", "ccc ddd"]
    stripped = header_cleanup.strip_leading_header_line(list(lines))
    assert stripped == ["aaa bbb", "ccc ddd"]
    # 保住原行号要靠调用方（当前没有保住）：再交给 `_join_block` 时下标已从 0 开始
    _text, _hyphenations, spans = project_export._join_block(stripped, RULES)
    assert [span["line_index"] for span in spans] == [0, 1]
