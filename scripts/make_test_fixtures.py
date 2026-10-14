#!/usr/bin/env python
"""生成测试用 PDF 夹具（内容自造，可安全入库）。

与 `make_scan_samples.py` 的区别：样本来自真实书籍（`test_books/` 不入库），
这里的夹具是合成的，用于验证渲染与坐标归一化。

运行（reportlab / pypdf 只在生成时需要，不进项目依赖）::

    uv run --with reportlab --with pypdf python scripts/make_test_fixtures.py

**旋转页夹具是怎么造的（踩过两个坑，务必沿用这个做法）：**

真实扫描书的"横放页"是这样存的：页面 MediaBox 是竖向，横向的内容被旋转 90° 塞进去，
再用 ``/Rotate`` 告诉阅读器"显示时顺时针转 90°"。本脚本照这个结构生成。

被否掉的两个做法，都实测过：

1. ``reportlab.setPageRotation()``——生成的文件在 PDFium 与 macOS PDFKit 里
   **都渲染不出内容**（墨迹像素为 0），是个坏文件。
2. ``pypdfium2`` 的 ``page.set_rotation()`` + ``save()``——它会把 MediaBox
   一起改成横向，于是 ``/Rotate`` 变成对"已经横过来的页"再转一次。
3. 直接往 PDF 字节里插 ``/Rotate``——会破坏交叉引用表的字节偏移，PDFium 读不到。
"""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, NumberObject
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = REPO_ROOT / "fixtures" / "pdf"

LANDSCAPE_LINES = [
    ("Helvetica-Bold", 34, "ROTATED PAGE - TOP LINE", 0),
    ("Helvetica", 20, "second line of the rotated page", 1),
    ("Helvetica", 20, "third line here", 2),
]


def build_landscape_pdf() -> bytes:
    """先做一页"内容横着、页面也横着"的正常 PDF。"""
    buffer = io.BytesIO()
    width, height = landscape(A4)  # 842 x 595
    pdf = canvas.Canvas(buffer, pagesize=(width, height))
    for font, size, text, row in LANDSCAPE_LINES:
        pdf.setFont(font, size)
        pdf.drawString(60, height - 110 - row * 60, text)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def build_rotated_fixture(out_path: Path, rotation: int = 90, render_dpi: int = 200) -> dict:
    """横向内容 → 逆时针转 90° 存进竖向页面 → 声明 /Rotate。

    阅读器应用 /Rotate（顺时针 90°）后，内容正好回到正立。
    """
    import pypdfium2 as pdfium

    # 1) 竖向页面，横向内容
    document = pdfium.PdfDocument(io.BytesIO(build_landscape_pdf()))
    page = document[0]
    bitmap = page.render(scale=render_dpi / 72)
    landscape_image = bitmap.to_pil().convert("RGB")
    bitmap.close()
    page.close()
    document.close()

    # 2) 逆时针转 90°，塞进竖向页面
    stored = landscape_image.rotate(90, expand=True)
    landscape_image.close()

    portrait_width, portrait_height = A4  # 595.28 x 841.89
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(portrait_width, portrait_height))
    image_io = io.BytesIO()
    stored.save(image_io, format="PNG")
    image_io.seek(0)
    pdf.drawImage(
        __import__("reportlab.lib.utils", fromlist=["ImageReader"]).ImageReader(image_io),
        0, 0, width=portrait_width, height=portrait_height,
    )
    pdf.showPage()
    pdf.save()
    stored.close()

    # 3) 写 /Rotate（MediaBox 保持竖向不动）
    reader = PdfReader(io.BytesIO(buffer.getvalue()))
    writer = PdfWriter()
    writer.add_page(reader.pages[0])
    writer.pages[0][NameObject("/Rotate")] = NumberObject(rotation)
    with out_path.open("wb") as handle:
        writer.write(handle)

    return {
        "landscape_px": None,
        "stored_px": stored.size,
        "rotation": rotation,
    }


def verify(out_path: Path) -> None:
    """复核：显示尺寸是横向，且默认渲染出来的文字是正立的。"""
    import numpy as np
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(out_path))
    page = document[0]
    width, height = page.get_size()
    rotation = page.get_rotation()
    print(f"  /Rotate = {rotation}（应为 90）")
    print(f"  显示尺寸 = {width:.0f} x {height:.0f} pt（应为横向 842x595）")

    bitmap = page.render(scale=120 / 72)
    image = bitmap.to_pil().convert("RGB")
    bitmap.close()
    page.close()
    document.close()

    ink = int((np.array(image.convert("L")) < 160).sum())
    print(f"  默认渲染 = {image.width}x{image.height}，墨迹像素 {ink}（应远大于 0）")

    target = Path("/tmp/rotated-page-90-render-check.png")
    image.save(target)
    print(f"  渲染快照：{target}（应能正着读出文字）")
    image.close()

    if rotation != 90:
        raise SystemExit("夹具的 /Rotate 不正确")
    if width < height:
        raise SystemExit("显示尺寸不是横向，说明 /Rotate 没生效")
    if ink == 0:
        raise SystemExit("默认渲染是空白页")


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUTPUT_DIR / "rotated-page-90.pdf"
    print(f"生成 {target.relative_to(REPO_ROOT)}")
    build_rotated_fixture(target)
    verify(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
