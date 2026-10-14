# Book2Text

将**没有可用文本层的扫描版 PDF 图书**转换为经过人工审校、可追溯、保留结构信息的文本资产的本地网页应用。

产品形态是「Python 本地服务 + 浏览器界面」：用户双击启动脚本，浏览器打开 `127.0.0.1` 上的界面，全部数据保存在本机。它不是 OCR 包装器——核心价值在于**高效、可靠的人工审校**与**可追溯的数据**。

---

## 当前状态

> **识别与选页可用（Phase 2 完成）：批量跑在后台任务里、能暂停 / 取消、中断能接着做；审校与导出还没到。**

| 项目 | 状态 |
|---|---|
| Git 仓库与目录布局 | ✅ 已建立（2026-10-14） |
| GitHub 远端（私有） | ✅ 已推送：https://github.com/CLnum42/book2text |
| 开发说明书 V1.0 | ✅ 已入库：`docs/spec-v1.0.md` |
| UI 原型（6 个页面） | ✅ 已入库：`docs/ui-mockups/` |
| **Phase 0 第 4 项：最小骨架** | ✅ 可运行：服务、上传 PDF、显示页面图像、引擎自检 |
| **Phase 0 扫描样本（20 页，无文本层）** | ✅ 已生成：`fixtures/pdf/sample-20p-300dpi.pdf`，见 [`docs/scan-sample-set.md`](docs/scan-sample-set.md) |
| **Phase 0 第 1 项：两个门槛项** | ✅ **已达标**：行级坐标 20/20 页、中位 2.04 秒/页，见 [`docs/ocr-evaluation.md`](docs/ocr-evaluation.md) |
| **应用内识别（单页，行级坐标）** | ✅ 可用：上传 → 识别本页 → 文本行叠加在原图上 |
| **行 → 块（分段）** | ✅ 可用：按行距、缩进、对齐自动分段，块框叠加在原图上 |
| **行合并成段落文本（9.2）** | ✅ 可用：界面可切换"保留换行 / 拼成段落"预览 |
| **导出 TXT（9.1 / 9.3 / 9.4）** | ✅ **可导出文件**：段生成含跨页拼接、预检摘要、下载 |
| **导出 JSONL 与 manifest（9.5）** | ✅ **可导出文件**：每行一个段 + manifest 含断词还原位置 |
| **项目与数据库（Phase 1 数据基础）** | ✅ 可用：项目库、新建项目、页面记录、项目锁、自动备份 |
| **准确率测量工具链 + 合成金标准** | ✅ 已建立：内容 CER 1.63%、英文 0%，见 [`docs/accuracy-report.md`](docs/accuracy-report.md) |
| **识别落进项目（Phase 2 开头）** | ✅ 可用：识别按钮 → 块与行落库 → 重启还在；原始输出存 `ocr_runs/` |
| **任务执行器（Phase 2 主体）** | ✅ 可用：识别跑在**子进程**里；批量、进度、暂停 / 继续 / 取消、重试失败页、中断恢复 |
| **挑选页面与批量操作（Phase 2 收尾）** | ✅ 可用：单击 / Shift 范围 / ⌘ 多选 / 页码输入；批量设类型、纳入排除、识别所选、按类型与识别状态筛选 |
| 缩略图 Job、批量页面选择、页面类型标注 | ⬜ 未开始（Phase 1 余下 / Phase 2） |
| **把导出接到项目上** | ⬜ 未开始——导出仍走临时上传，范围限本次会话 |
| 人工合并 / 拆分块、块类型标注 | ⬜ 未开始（Phase 3） |
| Phase 0 第 1 项：PaddleOCR 对比与版面组件 | ⬜ 未开始 |
| Phase 0 第 1–2 项：**真实扫描件**的准确率 | ⬜ **被人工校对金标准卡住** |
| Phase 0 第 5 项：可行性文档 | 🔶 部分完成：`docs/technical-feasibility.md` |
| Phase 1–8 业务功能 | ⬜ 未开始 |

**现在能做什么：**
- 在**项目库**里新建项目（上传 PDF），项目**持久保存**，关掉应用再打开还在。
- **挑选页面**：单击选中、Shift 选一段、⌘ / Ctrl 加减一页，或输入页码范围
  （`1-12, 300-310`）；选中后可以批量设类型、纳入 / 排除，也可以只识别所选页。
  顶部可按**类型**与**识别状态**筛选。选 3–10 页时会提示可以当样本先试识别。
- **批量识别**：点"识别所选"或"识别全部未识别页"——任务跑在**子进程**里，
  右下角的**任务抽屉**显示进度与当前页，可以**暂停 / 继续 / 取消**，
  失败页可以**单独重试**。识别结果（块、行、坐标、引擎与耗时）落进项目数据库，
  刷新、重启都还在；双击某一页可看原图上的块框与该页的块文本。
- **中断不会丢成果**：识别到一半关掉应用（哪怕强制结束），不会有进程继续在后台写数据库；
  下次打开项目时那个任务是"中断"状态，点"继续"接着做没做完的页。
- 在**临时上传**区里识别当前页并生成、下载 TXT / JSONL（这一块只为导出活着，
  文件落在临时目录，刷新即丢）。

**现在还不能做什么：** 编辑与审校（块只能看不能改）、把导出接到项目上、
缩略图缓存与虚拟滚动。见
[`docs/known-limitations.md`](docs/known-limitations.md) L-10、L-25、L-26。

---

## 快速开始

```bash
uv sync --group ocr-eval  # 需要识别功能时；只看看界面可以跳过（约 300 MB）
uv run book2text          # 或双击 scripts/start.command（macOS）
```

浏览器会自动打开带会话令牌的地址；若没自动打开，把终端里打印的**界面地址**整条复制到浏览器
（**必须带 `?token=…`**，否则界面会提示缺少令牌）。按 Ctrl+C 停止。

```bash
uv run book2text --port 9000     # 换起始端口（被占用时自动向后尝试）
uv run book2text --no-browser    # 不自动打开浏览器
uv run pytest -q                 # 运行测试（449 项；未装 OCR 依赖时自动跳过需要引擎的那些）
```

上传的文件放在系统应用数据目录下的 `scratch/`（macOS 上是
`~/Library/Application Support/Book2Text/`），可以随时删除。**原始 PDF 不会被修改。**

---

## 开发环境要求

以下工具在本机 macOS 上**已安装并验证**（2026-10-14 实测）：

| 工具 | 实测版本 | 用途 |
|---|---|---|
| Git | 2.50.1 | 版本管理（身份与 SSH 已配置） |
| Python | 3.12.13 | 后端与核心层（说明书要求 3.11+） |
| uv | 0.12.3 | 环境与依赖锁定 |
| Node.js / npm | v26.8.2 / 11.19.1 | 目前未使用；Vue 3 前端阶段才需要 |
| Homebrew | 7.0.9 | 非必需 |

Windows 上还没有验证过任何内容，见 [`docs/known-limitations.md`](docs/known-limitations.md) 第 5 节。

---

## 目标平台

- macOS（Apple Silicon / arm64）
- Windows（x64）
- **不支持** Intel Mac 与 32 位 Windows

两个平台共用同一套代码，各自使用一个启动脚本。

---

## 技术栈（已定，依据说明书 4.2）

| 部分 | 选型 |
|---|---|
| 后端语言 | Python 3.11+ |
| Web 框架 | FastAPI + Uvicorn |
| 数据库 | SQLite，每个项目一个 `project.db`（WAL 模式） |
| PDF 渲染 | `pypdfium2` 或 `PyMuPDF`（Phase 0 选定） |
| 第一 OCR 引擎 | PP-OCR 系列（PaddleOCR / RapidOCR，Phase 0 选定部署形态） |
| 第二 OCR 引擎 | Apple Vision（macOS）/ Windows 自带 OCR / Tesseract（兜底） |
| 前端 | Vue 3 + TypeScript + Vite，构建产物由后端静态托管 |
| 环境管理 | `uv` |
| 分发 | MVP 用启动脚本；Phase 6 用 PyInstaller 双平台打包 |

---

## Git 与 GitHub

远端为 `git@github.com:CLnum42/book2text.git`（**私有**）。认证走 SSH，密钥位于 `~/.ssh/id_ed25519`。

```bash
git add -A && git commit -m "..." && git push    # push.autoSetupRemote 已开启，新分支无需 -u
git pull
```

两点需要注意（详见 [`docs/known-limitations.md`](docs/known-limitations.md)）：

- `gh` CLI 使用的细粒度 PAT 范围是"仅选定仓库"，**不包含本仓库**，因此 `gh repo view`、`gh issue` 等命令会返回 404。改用 `git` 命令不受影响。
- 许可证未定，**仓库不得转为公开**；公开前须先处理 `docs/decisions.md` 中的 D-005 与 D-006。

---

## 仓库结构

```text
book2text/
  README.md  AGENTS.md  CHANGELOG.md  pyproject.toml  uv.lock
  .gitignore  .gitattributes
  docs/
    spec-v1.0.md              # 开发说明书 V1.0（唯一权威依据）
    ui-mockups/               # 6 个页面的 HTML 原型与截图
    technical-feasibility.md  # Phase 0 第 5 项输出：已验证 / 未验证 / 平台差异 / 风险
    scan-sample-set.md        # 20 页扫描样本集：选页依据、覆盖度、局限
    development-log.md        # 开发日志（每次任务一条，按说明书 1.2 模板）
    decisions.md              # 决策记录
    known-limitations.md      # 已知限制与未验证事项
  backend/book2text/
    main.py                   # 启动入口：选端口、生成令牌、开浏览器
    paths.py                  # 包内路径常量
    api/                      # FastAPI 薄层：app / security / errors / routes_*
    core/
      platform.py             # 平台分支集中于此（说明书第 10 节）
      project/
        library.py            # 项目库：创建 / 列举 / 打开 / 页面（6.1 / 7.2 / 12.1）
        lock.py               # 项目锁 .lock（7.6）
      storage/
        db.py                 # SQLite 连接与备份（WAL、在线备份 API）
        migration.py          # 迁移框架
        migrations/           # 版本化迁移
        ulid.py               # 实体 ID（5.1）
        streaming.py          # 流式写入 + SHA-256
        scratch.py            # Phase 0 临时上传（待识别接入项目后移除）
      pdf/render.py           # PDF 打开与页面渲染（暂用 pypdfium2）
      ocr/
        base.py               # 适配器协议、归一化 bbox、OcrLine（说明书 8.1 / 5.2）
        adapters/rapidocr.py  # RapidOCR 实现
        compare.py            # 归一化与比对、CER/WER（说明书 8.7）
        selfcheck.py          # 引擎可用性自检
      structure/
        grouping.py           # 行 → 块：行距 / 缩进 / 对齐（说明书 8.1）
      storage/scratch.py      # Phase 0 临时上传目录（Phase 1 会被取代）
    static/                   # Phase 0 手写页面（Vue 落地后改为构建产物）
  scripts/                    # start.command（Mac）/ start.bat（Windows）
                              # make_scan_samples.py：从源书生成扫描样本
                              # make_test_fixtures.py：生成旋转页等测试夹具
                              # evaluate_ocr.py：门槛项测量
  tests/                      # conftest.py + unit/ + integration/
  fixtures/                   # 测试用 PDF（分类与版权说明见 fixtures/README.md）
```

尚未创建的目录按阶段逐步建立，**不预建空模块**（说明书 12.2）：`frontend/`（Vue 3），
以及 `core/` 下的 project / jobs / review / structure / export / collab 等，都还没到。

代码仓库之外，用户电脑上另有一个**项目库目录**，存放具体书籍项目的 `project.db`、原始 PDF、缓存与导出结果。该目录位于仓库之外，不会被 Git 跟踪。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/spec-v1.0.md`](docs/spec-v1.0.md) | 开发说明书 V1.0：架构、数据模型、功能、UX、OCR 策略、分阶段路线 |
| [`docs/technical-feasibility.md`](docs/technical-feasibility.md) | Phase 0 实测数据：已验证的能力、未验证事项、平台差异、风险 |
| [`docs/scan-sample-set.md`](docs/scan-sample-set.md) | 20 页扫描样本：逐页来源、覆盖度对照、重要局限 |
| [`docs/ocr-evaluation.md`](docs/ocr-evaluation.md) | OCR 引擎评估：门槛（实测前写定）与实测结果 |
| [`docs/accuracy-report.md`](docs/accuracy-report.md) | 合成金标准上的准确率：CER/WER、失败模式、说明书规则的一处空白 |
| [`AGENTS.md`](AGENTS.md) | 开发 Agent 的固定工作规则（说明书第 1 节同步副本） |
| [`docs/decisions.md`](docs/decisions.md) | 决策记录（架构与实现取舍的理由） |
| [`docs/development-log.md`](docs/development-log.md) | 每次开发任务的记录（含未验证项） |
| [`docs/known-limitations.md`](docs/known-limitations.md) | 已知限制与未验证事项（含已解除条目） |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更日志 |

---

## 开发方式

1. 阅读 [`AGENTS.md`](AGENTS.md)：每次开工前检查当前目录、Git 状态与说明书相关章节。
2. 对照 [`docs/spec-v1.0.md`](docs/spec-v1.0.md) 第 14 节的阶段路线，一次只做一个可运行、可验证的垂直切片。
3. 每次任务后更新 `docs/development-log.md`；涉及取舍时更新 `docs/decisions.md`。

## 许可

尚未确定。在确定之前，请勿将本仓库公开或对外分发。
