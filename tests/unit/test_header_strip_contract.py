"""`strip_leading_header_line` 的**返回值契约**（任务 89 的另一半）。

为什么单锁这一层：它是行索引错位的源头。契约以前是"把页眉行从列表里删掉"，
于是调用方 `_prepare` 只能拿缩短后的列表重新编号，整块的 `line_index` 前移 1；
而 `reading_marks` 用原块下标 → 差异静默画到隔壁行（567 条未审里 30 条受影响，25 条错位）。

现在的契约（Builder 的修法，`header_cleanup.py`）：**保持列表长度，把页眉行置空**。
空行本来就由 `join_lines` 跳过（不产生 span），所以"文本不带页眉"和"下标不丢"可以同时成立。

**红过没有**

- 前 3 条契约用例在 `d2e4d6c`（修法落地前）**已经复现是红的**：
  第 1 条返回长度 2 而不是 3（页眉被删），第 4 条 `_join_block` 给出 `[0, 1]` 而不是 `[1, 2]`；
  第 2、3 条当时也是绿（它们锁的是"另一条分支不许被改坏"和"没命中不许动"）。
- 修法落地后 4 条全绿。**这不是回归，是任务 89 的契约变更**：旧契约本身是缺陷源。
- 端到端那一路（导出段 → 标记 → next-lines）在
  `tests/integration/test_review_line_index_semantics.py`，两边一起看才有意义。
"""

from __future__ import annotations

from book2text.core.export import cleanup
from book2text.core.export import header_cleanup
from book2text.core.export import project as project_export

RULES = cleanup.CleanupRules()  # 五项规则全开（说明书 9.3 的默认）


def test_header_line_blanks_instead_of_deleting() -> None:
    """整行是页码：长度不变，首行变成空串，其余行**原样**保留。"""
    lines = ["Page 5", "aaa", "bbb"]
    stripped = header_cleanup.strip_leading_header_line(list(lines))

    assert len(stripped) == len(lines), f"列表长度变了：{len(lines)} → {len(stripped)}（行号会整体前移）"
    assert stripped[0] == "", f"首行应当置空，实际 {stripped[0]!r}"
    assert stripped[1:] == lines[1:], "页眉以外的行不许被改动"


def test_prefix_branch_keeps_length_and_strips_prefix() -> None:
    """行首是"页码 + 正文"：只摘前缀，长度不变（这条分支以前就没坏，锁住别被改坏）。"""
    lines = ["Page 3 这是正文的第一句话内容补充"]
    stripped = header_cleanup.strip_leading_header_line(list(lines))

    assert len(stripped) == len(lines), "前缀分支不许改变列表长度"
    assert stripped == ["这是正文的第一句话内容补充"], f"前缀没摘干净：{stripped!r}"


def test_prefix_shorter_than_threshold_is_left_alone() -> None:
    """"前缀 + 太短的尾巴"宁可不摘（`MIN_TAIL_CHARS` = 12）：别把正文里的短词当页眉删掉。"""
    lines = ["Page 3 aaa bbb"]  # 尾巴 "aaa bbb" 只有 7 个字符
    assert len("aaa bbb") < header_cleanup.MIN_TAIL_CHARS
    assert header_cleanup.strip_leading_header_line(list(lines)) == lines


def test_non_header_line_is_untouched() -> None:
    """不命中任何页码规则时原样返回——尤其不许"看起来像页眉"就动手。"""
    for lines in (["aaa", "bbb"], [], ["红楼梦", "第一回"]):
        assert header_cleanup.strip_leading_header_line(list(lines)) == lines


def test_join_block_after_strip_keeps_original_line_indices() -> None:
    """端到端那个数：置空后的列表交给 `_join_block`，`line_spans` 下标仍是 `[1, 2]`。

    这是用户能感知到的结果：`line_index` 对得上，差异才会画在它本来的那一行上。
    """
    lines = ["Page 5", "aaa bbb", "ccc ddd"]
    stripped = header_cleanup.strip_leading_header_line(list(lines))
    text, _hyphenations, spans = project_export._join_block(stripped, RULES)

    assert [span["line_index"] for span in spans] == [1, 2], (
        "line_spans 的下标不是原块下标——差异会画到隔壁行"
    )
    assert text == "aaa bbb ccc ddd", "页眉必须从正文里消失，且正文一字不差"
