# 变更日志

本文件记录 Book2Text 的对外可见变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

到目前为止**没有任何已发布版本**。以下条目按阶段累积在「未发布」中，MVP 完成后发布 0.1.0。

## [未发布]

### 新增 — 准确率测量工具链与合成金标准（2026-10-14）

首次具备"对照金标准测准确率"的能力。

- 新增 `core/ocr/compare.py`：**按说明书 8.7 规定的步骤与顺序**实现归一化
  （统一空白 → 全角半角标点 → 删除中日韩字符间的空格 → 等价符号），
  以及三态比对（identical / format_only_differs / differs）与 CER / WER。
  说明书要求该模块"必须有完整单元测试"——已配 51 项。
- 新增 `scripts/make_gold_corpus.py`：生成 3 页 / 82 行 / 2737 字的合成金标准语料
  与对应的**无文本层** PDF（`fixtures/gold/synthetic-corpus.json`）。
- 新增 `scripts/measure_accuracy.py`：对照金标准测量 CER / WER。
- 新增 `docs/accuracy-report.md` 与 `docs/accuracy-raw.json`（逐页逐行原始数据，
  含完整识别文本，可事后审计）。

**结果（合成语料，仅代表完美输入的上限）：** 内容 CER 1.634%、英文 CER/WER 0.000%、
整行一致（忽略空白）55.36%。

**发现一处说明书的规则空白：** 8.7 第 3 步只规定删除"中日韩字符之间"的空格，
覆盖不到**中日韩与拉丁/数字的边界**，而中英混排文本里后者占主导
（`是 PDF` 被识别成 `是PDF`）。去掉全部空白后编辑距离从 149 降到 46——
**原始 CER 里约三分之二是排版差异，不是识别错误**。
未擅自改规则：新增一个明确标注的额外测量口径，两个数字都报，
是否修订说明书列为**待开发者决定**（`docs/decisions.md` D-015）。

**同时记录的具体失败模式：** 生僻字（靰→靳、黢→黔）、形近字符（l→1、O→0、
ASCII→ASCⅡ）、破折号（—→一）、漏掉成对引号的后半；以及一处**单行完全崩溃**
（`书名号《红楼梦》、篇名〈葬花吟〉…` → `°，《》`，25 字只剩 4 字）
和一处**整行漏检**（页脚 `— 3 —` 未被检出）。

**这份语料不解除 Phase 0 的阻塞：** 它不能替代真实扫描件的人工金标准，
引擎选型仍需真实样本上的 CER。

### 新增 — 应用内识别：上传 → 渲染 → 带坐标的文本行（2026-10-14）

界面现在能对当前页做识别，并把**行框叠加在原图上**，点击文本行可定位到图上位置。

- 新增 `core/ocr/base.py`：适配器协议（说明书 8.1）、归一化 bbox 与 `OcrLine`、
  归一化原语 `normalize_quad()`。坐标规范按说明书 5.2（0–1、相对页面显示方向、与 DPI 无关）。
- 新增 `core/ocr/adapters/rapidocr.py`：RapidOCR 适配器，负责**把引擎的像素坐标
  转成归一化坐标**（说明书 5.2 明确要求由适配器负责）。延迟导入，未装 OCR 依赖时不加载。
- 新增识别接口 `POST /api/scratch/{id}/page/{n}/recognize`，返回逐行文本与归一化 bbox。
- 前端：行框覆盖层 + 文本行列表双向联动；归一化坐标直接换算成百分比定位，
  因此与显示尺寸、渲染 DPI 都无关。
- 新增 `scripts/make_test_fixtures.py` 与旋转页夹具 `fixtures/pdf/rotated-page-90.pdf`；
  新增 `fixtures/README.md` 说明夹具分类、版权与制作陷阱。
- 新增 `ocr-eval` 依赖组（`uv sync --group ocr-eval`），OCR 运行时仍不进核心依赖。

**关于 `/Rotate` 的一处纠正：** 我最初误判 PDFium 不应用 `/Rotate`、需要手工补旋转，
并据此改过代码。该结论基于一个**坏夹具**（reportlab 的 `setPageRotation()` 生成的
PDF 在 PDFium 与 macOS PDFKit 里都渲染不出内容）。实测澄清后结论相反：
**PDFium 已正确处理 `/Rotate`**，手工补旋转会让真实书籍里所有带 `/Rotate` 的页
被重复旋转。已撤销该改动并加回归测试。详见 `docs/decisions.md` D-014。

### 新增 — Phase 0 第 1 项：两个门槛项已达标（2026-10-14）

评估了第一引擎 **RapidOCR 3.10.0（ONNX 部署形态）**在 20 页样本上的表现。

- **门槛 G1（行级坐标）：达标**——20/20 页返回行级四点框 `(行数, 4, 2)`。
  说明书 8.5 的"按行比对"与 9.2 的"行合并规则"因此有了可行基础。
- **门槛 G2（每页耗时）：达标**——中位 2.04 秒/页、最大 3.67 秒/页（门槛 18 秒）。
  按中位外推 400 页约 13.6 分钟。
- 模型文件（PP-OCRv6）**随 wheel 内置，运行时无需联网**，符合说明书 4.2 的离线要求。
- 新增 `scripts/evaluate_ocr.py`（评估可复现）与 `docs/ocr-evaluation-raw.json`（逐页原始数据）。
- 新增 `docs/ocr-evaluation.md`，门槛在实测前写定，避免事后移动标准。
- 新增 `ocr-eval` 依赖组（`uv sync --group ocr-eval`）——OCR 选型未定，不放进核心依赖。

**注意：这不等于选型已定。** PaddleOCR 部署形态与版面组件都没测；
准确率（CER）因缺金标准**完全没有测**——文档里的"均分"是引擎自报置信度，不是准确率。

**顺带记录：** 峰值内存 **2686.6 MB**，是比速度更值得关注的指标；
引擎会把竖排书名、页脚页码也识别成文本行，印证了说明书 6.5 批量标注的必要性。

### 新增 — Phase 0 扫描样本（2026-10-14）

- 新增 `fixtures/pdf/sample-20p-300dpi.pdf`：**20 页、无文本层**的扫描样本
  （300 DPI 灰度，10.62 MB），实测文本层字符总数为 0，每页只含 1 个图像对象。
- 新增 `fixtures/pdf/sample-20p-300dpi.manifest.json`：逐页记录来源书、原书页码与覆盖类别。
- 新增 `scripts/make_scan_samples.py`：样本可复现生成，选页规则与参数固化在脚本内。
- 新增 `docs/scan-sample-set.md`：选页依据、覆盖度对照（7/9 类）与重要局限。

**样本提供的覆盖：** 普通单栏正文、章节标题、页眉页脚页码、脚注、英文专名数字标点、
中文、跨页段落（中英各一对，已实测确认承接）、复杂版面（插图 + 窄栏 + 竖排边栏），
另加参考文献页与索引页。

### 新增 — Phase 0 第 4 项「最小骨架」（2026-10-14）

应用现在**可以运行**了，但还不能识别文字。

- 建立 uv 项目（`pyproject.toml`、`uv.lock`），依赖：FastAPI、uvicorn、pypdfium2、platformdirs、Pillow。
- 本地服务：只监听 `127.0.0.1`；起始端口可配置，被占用时自动向后尝试；每次启动生成随机会话令牌，界面地址携带令牌，前端在 `X-B2T-Token` 请求头回传；同时校验 `Origin`（说明书 4.4）。
- 启动入口 `book2text`（等价于 `backend/book2text/main.py`）：选端口、生成令牌、打印启动横幅、自动打开浏览器。
- 上传 PDF：**流式**写入（边收边算 SHA-256，不把整个文件读进内存），校验 PDF magic bytes；原始文件不被修改（说明书 4.5）。
- 页面渲染：按 `thumb` / `view` / `zoom` 三档 DPI 渲染为 PNG（**DPI 为待验证的初值**）。
- **引擎自检**接口 `GET /api/app/info`：列出第一引擎（RapidOCR / PaddleOCR）、版面组件（RapidLayout / PP-DocLayout）、第二引擎（Apple Vision / Windows OCR / Tesseract）是否可用、版本与**不可用的原因**。
- 静态页面（手写 HTML + 原生 JS，无框架）：上传 PDF、显示页面图像、翻页、显示引擎自检表与当前限制。
- 双平台启动脚本：`scripts/start.command`（macOS，已实测）、`scripts/start.bat`（Windows，**未在 Windows 验证**）。
- 测试：`tests/unit/` 与 `tests/integration/` 共 **57 项，全部通过**，覆盖平台模块、PDF 渲染、引擎自检、上传存储（含路径穿越防护）与完整 HTTP 链路。
- 新增 `docs/technical-feasibility.md`（说明书 Phase 0 第 5 项的输出文件，**部分完成**）。
- 新增测试样本 `fixtures/pdf/synthetic-smoke-3pages.pdf`——合成文件，**仅用于验证链路，不能用于评估识别质量**。

### 新增 — 仓库初始化（2026-10-14）

- 初始化 Git 仓库，主分支 `main`。
- 按说明书 12.2 建立目录布局；说明书入库为 `docs/spec-v1.0.md`，UI 原型入库为 `docs/ui-mockups/`。
- 新增 `.gitattributes`：源码与文档统一 LF，`*.bat` 为 CRLF，二进制文件标记。
- 新增 `.gitignore`：兜底防护运行时数据、Python/Node 产物、编辑器与系统文件、密钥。
- 新增 `README.md`、`AGENTS.md`（说明书第 1 节同步副本）、`CHANGELOG.md`、`docs/development-log.md`、`docs/decisions.md`、`docs/known-limitations.md`。

### 变更 — Git 与 GitHub（2026-10-14）

- 配置全局 Git 提交身份为 `CLnum42 <CLnum42@users.noreply.github.com>`，与既有仓库的历史提交一致；用 `--reset-author` 改写了首次提交（`7da13d0` → `21c5a85`）。
- 建立 GitHub 远端 `git@github.com:CLnum42/book2text.git`（私有）。
- 认证方式为 SSH（`~/.ssh/id_ed25519`，ed25519），新增 `~/.ssh/config` 中的 `github.com` 条目；同时执行 `gh auth setup-git`。
- 开启 `push.autoSetupRemote`，新分支推送无需 `-u`。

### 已知问题

- **应用不能识别文字**：没有 OCR。产品名称里的 "2Text" 尚不成立。
- **没有项目与数据库**：上传的 PDF 只落在应用数据目录的临时 `scratch/` 下，不是正式项目。
- **没有审校、结构与导出功能**。
- **测试样本与人工校对金标准尚未制作**，Phase 0 第 1–3 项因此无法开始。现有测试 PDF 是合成文件，不能用于评估识别质量。
- **Windows 上没有任何内容被验证过**：`scripts/start.bat`、Windows OCR 分支、控制台 UTF-8 处理均未执行。
- 渲染 DPI 档位是待验证的初值，不是 Phase 0 样本测试得出的结论。
- PDF 库暂用 pypdfium2，`PyMuPDF` 一侧未实测，选型未定。
- `gh` CLI 的细粒度 PAT 范围为"仅选定仓库"，不含本仓库，`gh` 命令会返回 404（`docs/known-limitations.md` L-07）。`git` 命令不受影响。
- SSH 密钥未设口令（L-08）。
- 没有 CI，测试靠手动运行。
- 仓库为**私有**，许可证未定，暂时不得公开（`docs/decisions.md` D-006、D-008）。
