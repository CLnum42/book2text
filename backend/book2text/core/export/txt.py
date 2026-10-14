"""TXT 输出（说明书 9.4）。

说明书 9.4 的规定::

    - 编码 UTF-8（无 BOM），换行 LF。
    - 段与段之间空一行；标题前后各空一行。
    - 可选：在页面边界插入页码标记 〔p.87 / 印71〕（默认关闭）。
    - 可选：脚注以"页末附注"方式输出，放在包含该页结尾的段之后，
      以 ［注］ 开头（默认不导出脚注）。

**关于"标题前后各空一行"：** 说明书 9.1 第 3 条已规定标题块单独成段，
而本模块对所有段一律以一个空行分隔，因此标题前后天然各有一个空行，
不需要额外分支。这一点写在这里以免被误认为是漏实现。

**关于脚注：** 说明书 9.3 的排除规则里**不含**脚注（只排除页眉 / 页脚 / 页码），
但 9.4 又说脚注"默认不导出"。两处口径不一致。本模块按 9.4 的默认执行
（``include_footnotes=False``），并在 `docs/known-limitations.md` 记录了这处差异。
"页末附注"的排布形式**未实现**：它要求先能识别出脚注块，而块类型目前全是
`paragraph`（L-22）。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .segments import BLOCK_TYPE_FOOTNOTE, Segment


@dataclass(frozen=True)
class TxtOptions:
    page_markers: bool = False
    include_footnotes: bool = False


def page_marker(page_no: int, page_label: str | None = None) -> str:
    """页码标记，形如 ``〔p.87 / 印71〕``；没有印刷页码时省略后半段。"""
    if page_label:
        return f"〔p.{page_no} / 印{page_label}〕"
    return f"〔p.{page_no}〕"


def render_txt(
    segments: Sequence[Segment],
    *,
    options: TxtOptions | None = None,
    page_labels: Mapping[int, str] | None = None,
) -> str:
    """把段渲染成 TXT 文本。

    返回的字符串以 ``\\n`` 结尾、不含 BOM——编码成文件时用 UTF-8（无 BOM）即可。
    段与段之间恰好一个空行。
    """
    settings = options or TxtOptions()
    labels = page_labels or {}

    chunks: list[str] = []
    previous_page: int | None = None

    for segment in segments:
        if segment.block_type == BLOCK_TYPE_FOOTNOTE and not settings.include_footnotes:
            continue
        if not segment.text.strip():
            continue

        first_page = segment.pages[0] if segment.pages else None
        if (
            settings.page_markers
            and first_page is not None
            and first_page != previous_page
        ):
            chunks.append(page_marker(first_page, labels.get(first_page)))
        chunks.append(segment.text)

        if segment.pages:
            previous_page = segment.pages[-1]

    if not chunks:
        return ""
    # 段与段之间空一行：即用两个换行连接
    return "\n\n".join(chunks) + "\n"
