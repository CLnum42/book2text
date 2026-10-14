# Book2Text

将**没有可用文本层的扫描版 PDF 图书**转换为经过人工审校、可追溯、保留结构信息的文本资产的本地网页应用。

产品形态是「Python 本地服务 + 浏览器界面」：用户双击启动脚本，浏览器打开 `127.0.0.1` 上的界面，全部数据保存在本机。它不是 OCR 包装器——核心价值在于**高效、可靠的人工审校**与**可追溯的数据**。

---

## 当前状态

> **Phase 0 的「最小骨架」已完成，可以运行了——但还不能识别文字。**

| 项目 | 状态 |
|---|---|
| Git 仓库与目录布局 | ✅ 已建立（2026-10-14） |
| GitHub 远端（私有） | ✅ 已推送：https://github.com/CLnum42/book2text |
| 开发说明书 V1.0 | ✅ 已入库：`docs/spec-v1.0.md` |
| UI 原型（6 个页面） | ✅ 已入库：`docs/ui-mockups/` |
| **Phase 0 第 4 项：最小骨架** | ✅ 可运行：服务、上传 PDF、显示页面图像、引擎自检 |
| Phase 0 第 1–3 项：引擎与 PDF 库实测 | ⬜ **被测试样本缺失卡住** |
| Phase 0 第 5 项：可行性文档 | 🔶 部分完成：`docs/technical-feasibility.md` |
| Phase 1–8 业务功能 | ⬜ 未开始 |

**现在能做什么：** 上传一个 PDF，逐页查看渲染出来的图像，看到引擎自检与环境状态。

**现在还不能做什么：** 把图像变成文字（没有 OCR），以及审校、结构编辑、导出。
产品名称里的 "2Text" 目前还不成立。

---

## 快速开始

```bash
uv run book2text          # 或双击 scripts/start.command（macOS）
```

浏览器会自动打开带会话令牌的地址；若没自动打开，把终端里打印的**界面地址**整条复制到浏览器
（**必须带 `?token=…`**，否则界面会提示缺少令牌）。按 Ctrl+C 停止。

```bash
uv run book2text --port 9000     # 换起始端口（被占用时自动向后尝试）
uv run book2text --no-browser    # 不自动打开浏览器
uv run pytest -q                 # 运行测试（57 项）
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
    development-log.md        # 开发日志（每次任务一条，按说明书 1.2 模板）
    decisions.md              # 决策记录
    known-limitations.md      # 已知限制与未验证事项
  backend/book2text/
    main.py                   # 启动入口：选端口、生成令牌、开浏览器
    paths.py                  # 包内路径常量
    api/                      # FastAPI 薄层：app / security / errors / routes_*
    core/
      platform.py             # 平台分支集中于此（说明书第 10 节）
      pdf/render.py           # PDF 打开与页面渲染（暂用 pypdfium2）
      ocr/selfcheck.py        # 引擎可用性自检
      storage/scratch.py      # Phase 0 临时上传目录（Phase 1 会被取代）
    static/                   # Phase 0 手写页面（Vue 落地后改为构建产物）
  scripts/                    # start.command（Mac）/ start.bat（Windows）
  tests/                      # conftest.py + unit/ + integration/
  fixtures/pdf/               # 测试用 PDF
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
