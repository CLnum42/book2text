#!/usr/bin/env python
"""生成**合成金标准语料**：一段已知文本 + 由它渲染出的无文本层 PDF。

**这个语料能证明什么、不能证明什么（重要）：**

- ✅ 能验证**比对工具链本身是否正确**（没有已知答案就没法验证 CER 的实现）。
- ✅ 能给出一个**上限基线**：引擎在"完美输入"上的表现。
- ✅ 能测全角/半角标点、中英混排、数字、引号破折号等具体字符类别的表现。
- ❌ **不能**代表真实扫描书。真实旧书有倾斜、噪点、透印、低对比度，
  在这里测得的准确率会明显偏乐观。Phase 0 的引擎选型仍需要
  **人工校对的真实扫描金标准**（见 docs/scan-sample-set.md 第 5 节）。

因此本语料的定位是：**给比对工具做校准、给准确率画一条上限线**，
不是替代真实样本。

运行（reportlab 只在生成时需要）::

    uv run --with reportlab python scripts/make_gold_corpus.py
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

REPO_ROOT = Path(__file__).resolve().parents[1]
PDF_DIR = REPO_ROOT / "fixtures" / "pdf"
GOLD_DIR = REPO_ROOT / "fixtures" / "gold"

BASENAME = "synthetic-corpus"
RENDER_DPI = 300
CJK_FONT = "STSong-Light"

PAGE_HEADER = "Book2Text 合成金标准语料"
PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN_X = 62
BODY_TOP = PAGE_HEIGHT - 118
BODY_LINE_HEIGHT = 25.2
BODY_FONT_SIZE = 13
MAX_BODY_LINES = 26

# ---------------------------------------------------------------------------
# 语料正文：按类别分块，每块的行会被依次铺到页面上。
# 刻意覆盖：中文散文、中文标点、数字与日期、英文、中英混排、
#           半角标点的中文行、引号与破折号变体、书名号、省略号。
# ---------------------------------------------------------------------------
SECTIONS: list[tuple[str, list[str]]] = [
    ("中文散文与标点", [
        "第一天清晨，山谷里还浮着薄薄的雾，远处的松林像浸在水里一样模糊。",
        "他把窗推开一条缝，冷空气涌进来，桌上的纸页被吹得哗哗作响。",
        "“你看，”她指着远处说，“那才是真正的春天。”",
        "他沉默了很久，最后只回了一句：“也许吧。”",
        "院子里那棵老槐树已经有三十年没人修剪过，枝叶压得很低。",
        "雨停之后，屋檐上还在滴水，一滴，两滴，打在青石板上。",
        "那年冬天格外冷，河面结了厚厚的冰，孩子们在上面跑来跑去。",
        "《论语》里有一句话，他抄在笔记本的扉页上，用了整整十年。",
        "所谓“知之为知之，不知为不知”，说起来容易，做起来很难。",
        "厨房里飘出饭香，母亲在灶台前忙碌，锅铲碰着铁锅，叮当作响。",
        "他忽然想起小时候的事，那时候还没有这条马路，也没有这些楼。",
        "傍晚的云被夕照染成橘色，一片一片，慢慢沉到山后面去。",
        "书房的门半掩着，灯光从门缝里漏出来，在地上画出一道细长的亮线。",
        "她说这话的时候并没有看他，只是低头把杯子里的茶叶拨到一边。",
        "整条街的店铺都关了门，只有拐角那家面馆还亮着，冒着白汽。",
        "他把信读了三遍，然后折好，放回信封，什么也没有说。",
        "码头上的缆绳被水汽浸得发黑，几只海鸟停在木桩上，一动不动。",
        "春天来得比往年迟，桃花开了又谢，谢了又开，好像总也不甘心。",
        "会议开了整整一个下午，最后决定把这件事往后推，推到明年再说。",
        "旧唱片机还能转，只是针头有些钝了，放出来的声音带着沙沙的杂音。",
        "走廊尽头的窗户正对着操场，下课铃一响，人影就涌了出来。",
        "他习惯在每一本书的最后一页写下日期和地点，像是在给时间做记号。",
    ]),
    ("生僻字与繁简混排（OCR 错误通常集中在这里）", [
        "鸂鶒、鸬鹚、鹈鹕都是水鸟的名称，笔画繁复，容易识错。",
        "他写了一个“龘”字，说是从旧碑上拓下来的，笔画多达四十八画。",
        "饕餮纹是商周青铜器上常见的装饰，纹样对称而繁密。",
        "瓠、匏、瓢三个字都指葫芦一类的器物，古书里常混用。",
        "靰鞡、靛蓝、黢黑这些词在方言文献里出现频率并不低。",
        "《康熙字典》收录四万七千余字，其中大量是异体与僻字。",
        "纂、篡、攥三个字音近形似，校对时最容易张冠李戴。",
        "疆、缰、僵、礓，同一部首的字在低分辨率下几乎无法区分。",
    ]),
    ("数字、日期与度量", [
        "据统计，2024 年全国共有 12847 家相关企业，同比增长 6.3%。",
        "这项实验持续了 37 天，采集样本 2156 份，有效率约为 92.8%。",
        "1949 年 10 月 1 日，是一个被反复书写的日期。",
        "书稿共 428 页，正文约 31.6 万字，附图 74 幅。",
        "温度从 -12.5℃ 升到 3.4℃，用了不到 9 个小时。",
        "第三次修订版把第 12 章到第 18 章整体前移，页码因此全部重排。",
        "误差控制在 ±0.02 毫米以内，这个精度已经接近设备极限。",
        "三项指标分别为 0.87、0.92 与 0.79，权重依次是 0.5、0.3、0.2。",
        "列车时刻表上写着 07:42 发车，实际晚点 23 分钟。",
        "该地区海拔 3120 米，年均降水量 486 毫米。",
    ]),
    ("英文段落", [
        "The quick brown fox jumps over the lazy dog, again and again.",
        "A careful reader will notice that the second edition omits three footnotes.",
        "In 1971, the committee published its findings in a slim volume of 84 pages.",
        "She said, \"I don't think that's quite right,\" and turned to page 42.",
        "The argument is elegant but rests on an assumption nobody has tested.",
        "Chapter Three examines the relationship between text and commentary.",
        "Whether the hypothesis holds under different conditions remains unclear.",
        "Typography matters: an em dash—like this one—reads differently from a hyphen.",
        "The catalogue lists 1,248 titles, of which roughly 12% are out of print.",
        "He preferred the older spelling, though the modern form had long prevailed.",
        "Marginalia in a seventeenth-century hand crowd the outer edges of the page.",
        "No single manuscript preserves the text in its entirety.",
    ]),
    ("中英混排", [
        "深度学习的英文是 deep learning，与之相关的还有 machine translation。",
        "他把 Random Forest 和 Gradient Boosting 都试了一遍，效果差别不大。",
        "这份文档的格式是 PDF，编码是 UTF-8，换行符统一为 LF。",
        "论文引用了 Kuhn (1962) 与 Baker (1993) 两部经典文献。",
        "在 macOS 与 Windows 上，路径分隔符分别是 / 与 \\。",
        "接口返回的字段名为 bbox，取值是归一化坐标 [x0, y0, x1, y1]。",
        "校对时要注意 b 与 6、l 与 1、O 与 0 这三组形近字符。",
        "该函数返回 True 或 False，失败时抛出 ValueError 异常。",
        "他给变量起名叫 temp_list，虽然 PEP 8 建议用更具描述性的名字。",
    ]),
    ("半角标点的中文行（用于检验全角/半角归一化）", [
        "这一段故意使用半角标点, 逗号和句点都是 ASCII 的.",
        "括号也用半角 (像这样), 冒号写成 half-width: 就是这样.",
        "引号用直引号 \"像这样\", 而不是中文的弯引号.",
    ]),
    ("引号、破折号与省略号变体", [
        "他说——“这件事我来办”——然后就走了。",
        "书名号《红楼梦》、篇名〈葬花吟〉、引号“双”与‘单’。",
        "破折号有时写成 — 一个, 有时写成 —— 两个, 排版并不统一。",
        "省略号有两种写法：… 和 ……，原书里两种都出现过。",
        "英文的撇号在 don't、it's、1900's 里都要保留。",
    ]),
]


def build_pages() -> list[dict[str, object]]:
    """把语料铺到页面上，产出一页一行结构的金标准。"""
    lines: list[str] = []
    current_section = ""
    for section, section_lines in SECTIONS:
        lines.append(f"【{section}】")
        current_section = section
        lines.extend(section_lines)

    pages: list[dict[str, object]] = []
    cursor = 0
    page_no = 1
    while cursor < len(lines):
        chunk = lines[cursor : cursor + MAX_BODY_LINES]
        cursor += len(chunk)

        # 每页可看到的全部文字，顺序与实际渲染一致：页眉 → 正文 → 页脚
        page_lines = [PAGE_HEADER, *chunk, f"— {page_no} —"]
        pages.append({
            "page": page_no,
            "header": PAGE_HEADER,
            "body": chunk,
            "footer": f"— {page_no} —",
            "lines": page_lines,
        })
        page_no += 1
    return pages


def render_source_pdf(pages: list[dict[str, object]]) -> bytes:
    """用 reportlab 渲染成"干净的原稿 PDF"（这一步有文本层，后面会去掉）。"""
    pdfmetrics.registerFont(UnicodeCIDFont(CJK_FONT))

    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    for page in pages:
        pdf.setFont(CJK_FONT, 9)
        pdf.drawString(MARGIN_X, PAGE_HEIGHT - 72, str(page["header"]))

        pdf.setFont(CJK_FONT, BODY_FONT_SIZE)
        y = BODY_TOP
        for line in page["body"]:  # type: ignore[union-attr]
            pdf.drawString(MARGIN_X, y, str(line))
            y -= BODY_LINE_HEIGHT

        pdf.setFont(CJK_FONT, 9)
        pdf.drawCentredString(PAGE_WIDTH / 2, 52, str(page["footer"]))
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def to_image_pdf(source_pdf: bytes, out_path: Path) -> None:
    """渲染为位图后重新拼装——这样就**没有文本层**了，与扫描件一致。"""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(source_pdf)
    images: list[Image.Image] = []
    for index in range(len(document)):
        page = document[index]
        bitmap = page.render(scale=RENDER_DPI / 72)
        images.append(bitmap.to_pil().convert("L"))
        bitmap.close()
        page.close()
    document.close()

    first, rest = images[0], images[1:]
    buffer = BytesIO()
    first.save(
        buffer, format="PDF", resolution=RENDER_DPI, quality=88,
        save_all=True, append_images=rest,
    )
    out_path.write_bytes(buffer.getvalue())
    for image in images:
        image.close()


def main() -> int:
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    GOLD_DIR.mkdir(parents=True, exist_ok=True)

    pages = build_pages()
    total_lines = sum(len(page["lines"]) for page in pages)  # type: ignore[arg-type]
    total_chars = sum(
        len(line) for page in pages for line in page["lines"]  # type: ignore[union-attr]
    )
    print(f"语料：{len(pages)} 页，{total_lines} 行，{total_chars} 字")

    source = render_source_pdf(pages)
    pdf_path = PDF_DIR / f"{BASENAME}.pdf"
    to_image_pdf(source, pdf_path)

    gold_path = GOLD_DIR / f"{BASENAME}.json"
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "scripts/make_gold_corpus.py",
        "kind": "synthetic",  # 合成语料，不是人工校对的真实扫描件
        "render_dpi": RENDER_DPI,
        "page_count": len(pages),
        "line_count": total_lines,
        "char_count": total_chars,
        "pdf_file": f"fixtures/pdf/{pdf_path.name}",
        "categories": [section for section, _ in SECTIONS],
        "why_this_exists": [
            "验证比对工具链（归一化、编辑距离、CER/WER）本身是否正确",
            "给出引擎在完美输入上的上限基线",
        ],
        "what_it_cannot_prove": [
            "不代表真实扫描书的识别率——真实旧书有倾斜、噪点、透印、低对比度",
            "不能替代人工校对的真实扫描金标准（Phase 0 引擎选型仍需要它）",
        ],
        "pages": pages,
    }
    gold_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    # 人眼可读的纯文本版（便于快速核对）
    txt_path = GOLD_DIR / f"{BASENAME}.txt"
    txt_path.write_text(
        "\n".join(
            line for page in pages for line in page["lines"]  # type: ignore[union-attr]
        )
        + "\n",
        encoding="utf-8",
    )

    # 复核：输出的 PDF 必须没有文本层
    import pypdfium2 as pdfium

    check = pdfium.PdfDocument(str(pdf_path))
    chars = 0
    for index in range(len(check)):
        page = check[index]
        chars += page.get_textpage().count_chars()
        page.close()
    check.close()

    print(f"PDF：{pdf_path.relative_to(REPO_ROOT)}（{pdf_path.stat().st_size / 1024:.0f} KB）")
    print(f"  页数 {len(pages)}，文本层字符数 {chars}（应为 0）")
    print(f"金标准：{gold_path.relative_to(REPO_ROOT)}")
    print(f"纯文本：{txt_path.relative_to(REPO_ROOT)}")
    if chars != 0:
        raise SystemExit("输出仍有文本层")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
