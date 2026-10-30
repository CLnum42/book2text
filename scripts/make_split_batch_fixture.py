#!/usr/bin/env python
"""生成「可分块的页脚页码」夹件：`fixtures/pdf/synthetic-split-3pages.pdf`。

**它用来验什么**（别和 `synthetic-smoke-3pages.pdf` 混用）：

- `synthetic-smoke-3pages.pdf` 只验「能上传、能渲染」，页面里没有可拆的页码；
- 这一份**专供「拆分书眉页码」那条路径**：每页页脚是一行 `Book2Text 1/2/3`（短、贴页面底部、
  块尾是数字），识别之后每页都是 `['paragraph', 'paragraph', 'page_number']` 的形状，
  于是「拆页号」面板的预览能列出 3 条、`执行拆分` 可点、点完落库的块类型真的变成 `page_number`。
  刀 8 的验收缺口就是「面板开关没验到」，靠这份夹件补的（见 docs/known-limitations.md L-113）。

**为什么用 PIL 而不是 reportlab**：这台机器上没有 reportlab（`fixtures/README.md` 里
`synthetic-smoke-3pages.pdf` 是靠 `uv run --with reportlab` 临时环境生成的）。PIL 是既有依赖，
`Image.save(..., "PDF")` 直接把位图页拼成图像型 PDF——同时也天然没有文本层，与真实扫描件同形。

**结构等价，字节不等价**：PDF 里有创建时间戳，两次运行**得到的字节不同**。
所以判据只认结构：3 页、每页（识别后）3 块、页脚页码 1/2/3 能被拆成独立 `page_number`。
不要在文档里承诺"跑脚本得到同一份文件"。

用法::

    .venv/bin/python scripts/make_split_batch_fixture.py              # 写 fixtures/pdf/…
    .venv/bin/python scripts/make_split_batch_fixture.py --out /tmp/x.pdf --pages 5

独立重跑：只依赖 Pillow，不依赖 test_books/、不依赖 OCR 引擎、不依赖服务在跑。
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# A4 @200dpi：与项目里的渲染档位（view = 150 / mid = 220 / zoom = 300）同一量级，
# 但取 200 是为了让识别器稳定读出页脚那行小字（150 也读得出，200 更稳）。
DPI = 200
PAGE_W, PAGE_H = 1654, 2339

FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def _font(size: int = 48) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def build_page(page_no: int, font) -> Image.Image:
    """一页 = 两行正文 + 一行页脚 `Book2Text N`（页脚贴底部，落在「上下 12% 带」里）。"""
    image = Image.new("RGB", (PAGE_W, PAGE_H), "white")
    draw = ImageDraw.Draw(image)
    draw.text((150, 200), f"Chapter {page_no} body text", font=font, fill="black")
    draw.text((150, 400), "This paragraph is the body of the page.", font=font, fill="black")
    # 页脚：短、块尾是页码 —— 这正是 `_page_number_split_plan` 认的形态
    draw.text((150, PAGE_H - 120), f"Book2Text {page_no}", font=font, fill="black")
    return image


def main() -> int:
    parser = argparse.ArgumentParser(description="生成可分块的页脚页码夹件（3 页，页码可拆）")
    parser.add_argument("--out", type=Path, default=None, help="输出 PDF（默认 fixtures/pdf/synthetic-split-3pages.pdf）")
    parser.add_argument("--pages", type=int, default=3, help="页数（默认 3）")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    out = args.out or (root / "fixtures" / "pdf" / "synthetic-split-3pages.pdf")
    out.parent.mkdir(parents=True, exist_ok=True)

    font = _font()
    pages = [build_page(no, font) for no in range(1, args.pages + 1)]
    pages[0].save(out, "PDF", save_all=True, append_images=pages[1:], resolution=float(DPI))

    size = out.stat().st_size
    print(f"写入 {out}（{args.pages} 页，{size} 字节，{DPI} dpi）")
    print("结构判据：3 页 / 每页识别后 3 块 / 页脚页码 1..N 可拆成独立 page_number 块")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
