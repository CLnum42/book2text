# 变更日志

本文件记录 Book2Text 的对外可见变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

到目前为止**没有任何已发布版本**。以下条目按阶段累积在「未发布」中，MVP 完成后发布 0.1.0。

## [未发布]

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
