#!/usr/bin/env python
"""从 test_books/ 的真实书籍生成 Phase 0 扫描样本（无文本层）。

**为什么需要这个脚本：** 样本必须可复现、可追溯。金标准校对时要能回答
"样本第 7 页对应原书哪一页"，Phase 0 的实测结论也要能追回具体页。
所以选页规则固化在这里，每次运行都产出同样的 PDF 与同样的清单。

**它是怎么做的：** 把选中的页在 300 DPI 下渲染成灰度位图，再拼成一个
图像型 PDF。渲染这一步就天然去掉了文本层——输出 PDF 的每页都只是一张位图。

**运行前提：** `test_books/` 里有源书（该目录不入库，见 .gitignore），
因此全新克隆后本脚本无法直接运行。它同时也是样本来源的书面记录。

用法::

    uv run python scripts/make_scan_samples.py
    uv run python scripts/make_scan_samples.py --dpi 400 --quality 90
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = REPO_ROOT / "test_books"
OUTPUT_DIR = REPO_ROOT / "fixtures" / "pdf"

HLM = "《红楼梦》双语对照 2_正文_中文部分.pdf"
AMES = "安乐哲 译本处理.PDF"

DEFAULT_DPI = 300
DEFAULT_QUALITY = 85


@dataclass(frozen=True)
class SamplePage:
    source: str
    page: int          # 源文件中的页码，从 1 开始
    category: str      # 说明书 13.1 要求的覆盖类别
    note: str


@dataclass
class Selection:
    pages: list[SamplePage] = field(default_factory=list)

    def by_source(self) -> dict[str, list[SamplePage]]:
        grouped: dict[str, list[SamplePage]] = {}
        for page in self.pages:
            grouped.setdefault(page.source, []).append(page)
        return grouped


# ---------------------------------------------------------------------------
# 选页（说明书 13.1 的覆盖要求见 docs/scan-sample-set.md）
#
# 顺序即样本 PDF 中的顺序。跨页段落的两半必须相邻且顺序正确，
# 否则没法用它验证说明书 9.2 的跨页拼接。
# ---------------------------------------------------------------------------
SELECTION = Selection(
    pages=[
        # —— 《红楼梦》：中文、窄栏双栏版面、章节标题带插图 ——
        SamplePage(HLM, 1, "章节标题 + 复杂版面", "第二十七回回目；左栏标题与插图、右栏正文"),
        SamplePage(HLM, 31, "普通单栏正文", "纯正文页，页脚有页码"),
        SamplePage(HLM, 60, "章节标题", "第三十一回回目，正文从其下方开始（跨页段落前半）"),
        SamplePage(HLM, 61, "跨页段落", "与上一页构成同一段落（跨页段落后半）"),
        SamplePage(HLM, 121, "普通单栏正文", "纯正文页"),
        SamplePage(HLM, 147, "章节标题 + 复杂版面", "第三十八回回目 + 整幅插图 + 正文"),
        SamplePage(HLM, 151, "普通单栏正文", "纯正文页"),
        SamplePage(HLM, 211, "复杂版面", "正文右下角有插图"),
        SamplePage(HLM, 301, "普通单栏正文", "纯正文页"),
        SamplePage(HLM, 361, "特殊排版", "正文含对联等缩进变化，右下有小插图"),
        # —— 安乐哲《The Art of Rulership》：英文、页眉、脚注、书目、索引 ——
        SamplePage(AMES, 9, "普通单栏正文（英文）", "英文正文（跨页段落前半）"),
        SamplePage(AMES, 10, "跨页段落（英文）", "与上一页构成同一段落（跨页段落后半）"),
        SamplePage(AMES, 56, "页眉页码 + 正文", "右上红色页眉 Page N，正文含斜体罗马字与上标脚注号"),
        SamplePage(AMES, 166, "普通单栏正文（英文）", "密集正文页"),
        SamplePage(AMES, 221, "正文 + 脚注", "正文下方开始出现编号脚注"),
        SamplePage(AMES, 469, "脚注密集", "大半页为编号脚注"),
        SamplePage(AMES, 511, "脚注密集", "大半页为编号脚注"),
        SamplePage(AMES, 551, "脚注密集 + 页眉", "脚注行数最多的一页（13 行）"),
        SamplePage(AMES, 606, "参考文献", "书目条目，悬挂缩进"),
        SamplePage(AMES, 661, "索引", "索引页，短行多、缩进层级多"),
    ]
)


def render_page_gray(document: pdfium.PdfDocument, page_index: int, dpi: int) -> Image.Image:
    page = document[page_index]
    try:
        bitmap = page.render(scale=dpi / 72)
        try:
            return bitmap.to_pil().convert("L")
        finally:
            bitmap.close()
    finally:
        page.close()


def build(dpi: int, quality: int) -> tuple[Path, Path]:
    missing = [p.source for p in SELECTION.pages if not (SOURCE_DIR / p.source).is_file()]
    if missing:
        raise SystemExit(
            "找不到源书，无法生成样本："
            + "、".join(sorted(set(missing)))
            + f"\n请把源书放入 {SOURCE_DIR}/（该目录不入库）"
        )

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    pdf_path = OUTPUT_DIR / f"sample-20p-{dpi}dpi.pdf"
    manifest_path = OUTPUT_DIR / f"sample-20p-{dpi}dpi.manifest.json"

    images: list[Image.Image] = []
    manifest_pages: list[dict[str, object]] = []

    for order, item in enumerate(SELECTION.pages, start=1):
        source_path = SOURCE_DIR / item.source
        document = pdfium.PdfDocument(str(source_path))
        try:
            width_pt, height_pt = document.get_page_size(item.page - 1)
            image = render_page_gray(document, item.page - 1, dpi)
        finally:
            document.close()

        images.append(image)
        manifest_pages.append(
            {
                "sample_page": order,
                "source_file": item.source,
                "source_page": item.page,
                "category": item.category,
                "note": item.note,
                "pixel_size": [image.width, image.height],
                "page_size_pt": [round(width_pt, 2), round(height_pt, 2)],
            }
        )
        print(f"  [{order:>2}/20] {item.source[:14]:<16} p{item.page:<4} -> {image.width}x{image.height}  {item.category}")

    first, rest = images[0], images[1:]
    buffer = BytesIO()
    first.save(
        buffer,
        format="PDF",
        resolution=dpi,
        quality=quality,
        save_all=True,
        append_images=rest,
    )
    pdf_path.write_bytes(buffer.getvalue())

    for image in images:
        image.close()

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "scripts/make_scan_samples.py",
        "dpi": dpi,
        "jpeg_quality": quality,
        "color_mode": "L（灰度）",
        "page_count": len(manifest_pages),
        "output_file": pdf_path.name,
        "output_bytes": pdf_path.stat().st_size,
        "source_dir": str(SOURCE_DIR.relative_to(REPO_ROOT)),
        "source_books": {
            HLM: "《红楼梦》双语对照（正文·中文部分）",
            AMES: "Roger T. Ames, The Art of Rulership: A Study of Ancient Chinese Political Thought",
        },
        "caveats": [
            "源书是原生数字排版 PDF，不是扫描件；本样本是它的干净栅格化结果。",
            "因此不含真实扫描的倾斜、噪点、透印、低对比度等退化，OCR 结果会偏乐观。",
            "两本源书都不含中英混排页面，故本样本无法覆盖该类别。",
            "源 PDF 的文本层不可靠（存在错字，如「蘅芜」被写成「祷芜」），不能用作金标准。",
        ],
        "pages": manifest_pages,
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return pdf_path, manifest_path


def verify(pdf_path: Path) -> None:
    """确认输出确实没有文本层——这是本脚本存在的全部意义。"""
    document = pdfium.PdfDocument(str(pdf_path))
    try:
        count = len(document)
        chars = []
        for index in range(count):
            page = document[index]
            try:
                chars.append(page.get_textpage().count_chars())
            finally:
                page.close()
        total = sum(chars)
        sizes = {tuple(round(v) for v in document.get_page_size(i)) for i in range(count)}
    finally:
        document.close()

    print(f"\n输出：{pdf_path.relative_to(REPO_ROOT)}  ({pdf_path.stat().st_size / 1024 / 1024:.2f} MB)")
    print(f"页数：{count}（应为 20）")
    print(f"文本层字符总数：{total}（应为 0）")
    print(f"页面尺寸种类：{len(sizes)}  {sorted(sizes)}")
    if count != len(SELECTION.pages):
        raise SystemExit(f"页数不对：{count}")
    if total != 0:
        raise SystemExit(f"输出仍有文本层：共 {total} 个字符")


def main() -> int:
    parser = argparse.ArgumentParser(description="从 test_books/ 生成 Phase 0 扫描样本")
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI, help=f"渲染 DPI（默认 {DEFAULT_DPI}）")
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY, help=f"JPEG 质量（默认 {DEFAULT_QUALITY}）")
    args = parser.parse_args()

    print(f"渲染参数：DPI={args.dpi}  灰度  JPEG质量={args.quality}")
    print(f"选页共 {len(SELECTION.pages)} 页，来自 {len(SELECTION.by_source())} 本源书\n")

    pdf_path, manifest_path = build(args.dpi, args.quality)
    verify(pdf_path)
    print(f"清单：{manifest_path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
