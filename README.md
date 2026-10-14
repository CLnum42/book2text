# Book2Text

将**没有可用文本层的扫描版 PDF 图书**转换为经过人工审校、可追溯、保留结构信息的文本资产的本地网页应用。

产品形态是「Python 本地服务 + 浏览器界面」：用户双击启动脚本，浏览器打开 `127.0.0.1` 上的界面，全部数据保存在本机。它不是 OCR 包装器——核心价值在于**高效、可靠的人工审校**与**可追溯的数据**。

---

## 当前状态

> **仓库初始化完成，尚无任何功能代码。**

| 项目 | 状态 |
|---|---|
| Git 仓库与目录布局 | ✅ 已建立（2026-10-14） |
| GitHub 远端（私有） | ✅ 已推送：https://github.com/CLnum42/book2text |
| 开发说明书 V1.0 | ✅ 已入库：`docs/spec-v1.0.md` |
| UI 原型（6 个页面） | ✅ 已入库：`docs/ui-mockups/` |
| Phase 0 技术可行性验证 | ⬜ 未开始 |
| Phase 1–8 业务功能 | ⬜ 未开始 |

**目前没有可运行的启动命令。** 启动方式将在 Phase 0 最小骨架完成后写入本文件。

Phase 0 的前置输入（20–40 页测试 PDF 与 5–10 页人工校对金标准）由开发者在 Phase 0 开始前准备，目前尚未完成。

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

## 开发环境要求

| 工具 | 用途 | 说明 |
|---|---|---|
| Git | 版本管理 | 已配置 |
| Python 3.11+ | 后端与核心层 | **Phase 0 开始前安装** |
| uv | 环境与依赖锁定 | 同上 |
| Node.js（LTS） | 仅前端开发与构建需要 | 最终用户不需要 |

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
  README.md  AGENTS.md  CHANGELOG.md  .gitignore  .gitattributes
  docs/
    spec-v1.0.md            # 开发说明书 V1.0（唯一权威依据）
    ui-mockups/             # 6 个页面的 HTML 原型与截图
    development-log.md      # 开发日志
    decisions.md            # 决策记录
    known-limitations.md    # 已知限制
  backend/book2text/        # 本地服务（Phase 0 起逐步创建）
  frontend/                 # Vue 3 + TS 源码（Phase 1 起）
  scripts/                  # start.command（Mac）/ start.bat（Windows）
  tests/                    # unit / integration / e2e
  fixtures/                 # pdf 测试样本、gold 人工校对金标准
```

尚未创建的目录按阶段逐步建立，**不预建空模块**（说明书 12.2）。

代码仓库之外，用户电脑上另有一个**项目库目录**，存放具体书籍项目的 `project.db`、原始 PDF、缓存与导出结果。该目录位于仓库之外，不会被 Git 跟踪。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/spec-v1.0.md`](docs/spec-v1.0.md) | 开发说明书 V1.0：架构、数据模型、功能、UX、OCR 策略、分阶段路线 |
| [`AGENTS.md`](AGENTS.md) | 开发 Agent 的固定工作规则（说明书第 1 节同步副本） |
| [`docs/decisions.md`](docs/decisions.md) | 决策记录（含本次仓库初始化的 5 条决策） |
| [`docs/development-log.md`](docs/development-log.md) | 每次开发任务的记录 |
| [`docs/known-limitations.md`](docs/known-limitations.md) | 已知限制与未验证事项 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更日志 |

---

## 开发方式

1. 阅读 [`AGENTS.md`](AGENTS.md)：每次开工前检查当前目录、Git 状态与说明书相关章节。
2. 对照 [`docs/spec-v1.0.md`](docs/spec-v1.0.md) 第 14 节的阶段路线，一次只做一个可运行、可验证的垂直切片。
3. 每次任务后更新 `docs/development-log.md`；涉及取舍时更新 `docs/decisions.md`。

## 许可

尚未确定。在确定之前，请勿将本仓库公开或对外分发。
