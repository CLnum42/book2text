# 测试夹具说明

本目录的 PDF 用于自动化测试。**分两类，来源与版权状态不同，不可混用。**

## 1. 合成夹具（内容自造，无版权问题）

| 文件 | 内容 | 生成方式 |
|---|---|---|
| `synthetic-smoke-3pages.pdf` | 3 页 A4 英文文本，用于验证"能上传、能渲染" | reportlab 临时环境生成（`uv run --with reportlab`） |
| `rotated-page-90.pdf` | 1 页，横向内容竖着存 + 声明 `/Rotate=90`，用于验证旋转页的坐标归一化 | `scripts/make_test_fixtures.py` |

**重新生成旋转页夹具：**

```bash
uv run --with reportlab --with pypdf python scripts/make_test_fixtures.py
```

**制作旋转页夹具时踩过的坑（务必沿用上面的脚本，不要自己造）：**

1. **不要用 reportlab 的 `setPageRotation()`**——它生成的文件在 PDFium 与
   macOS PDFKit 里**都渲染不出任何内容**（实测墨迹像素为 0）。
2. **不要用 `pypdfium2` 的 `page.set_rotation()` + `save()`**——它会把 MediaBox
   一起改成横向，于是 `/Rotate` 变成对"已经横过来的页"再转一次。
3. **不要直接往 PDF 字节里插 `/Rotate`**——会破坏交叉引用表的字节偏移，PDFium 读不到。

正确做法（脚本里就是这么做的）：把横向内容旋转 90° 后放进竖向页面，
再写 `/Rotate`——这正是真实扫描书的存储方式。

## 2. 合成金标准语料（内容自造，无版权问题）

| 文件 | 内容 |
|---|---|
| `../pdf/synthetic-corpus.pdf` | 3 页，无文本层，由下表的金标准文本渲染而成 |
| `gold/synthetic-corpus.json` | **金标准**：逐页逐行的确切文本（机器可读） |
| `gold/synthetic-corpus.txt` | 同一内容的纯文本版，便于人眼核对 |

**生成：** `uv run --with reportlab python scripts/make_gold_corpus.py`

**用途：** 校准比对工具链、给出准确率上限基线。结果见
[`docs/accuracy-report.md`](../docs/accuracy-report.md)。

**⚠ 它不能替代真实扫描件的金标准。** 语料是完美字体、无扫描退化，
在其上测得的准确率会明显偏乐观；Phase 0 的引擎选型仍需要人工校对的真实扫描页。

## 3. 真实书籍样本（受版权保护）

| 文件 | 内容 |
|---|---|
| `sample-20p-300dpi.pdf` | 20 页，无文本层，来自两本真实书籍 |
| `sample-20p-300dpi.manifest.json` | 逐页来源与覆盖类别 |

选页依据、覆盖度对照与全部局限见 [`docs/scan-sample-set.md`](../docs/scan-sample-set.md)。
生成脚本为 `scripts/make_scan_samples.py`，但**它依赖不入库的 `test_books/`**，
因此全新克隆后无法重跑——脚本同时作为样本来源的书面记录。

⚠ **版权：** 该样本包含受版权保护书籍的页面片段。与 `docs/decisions.md` D-005 一致，
仓库目前为**私有**，可以存放；**转为公开之前必须移除或替换**。

## 相关文档

- `docs/scan-sample-set.md` —— 样本的选页依据与覆盖缺口
- `docs/ocr-evaluation.md` —— 在这些样本上的引擎实测结果
- `docs/decisions.md` D-005 / D-006 / D-008 —— 版权与可见性决策
