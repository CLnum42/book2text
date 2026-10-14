# 变更日志

本文件记录 Book2Text 的对外可见变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

到目前为止**没有任何已发布版本**，应用还不能运行。以下条目按阶段累积在「未发布」中，MVP 完成后发布 0.1.0。

## [未发布]

### 新增

- 初始化 Git 仓库，主分支 `main`。
- 按说明书 12.2 建立目录布局：`docs/` 入库，`backend/`、`frontend/`、`tests/`、`fixtures/`、`scripts/` 按阶段逐步创建，不预建空模块。
- 入库开发说明书 V1.0（`docs/spec-v1.0.md`）与 6 个页面的 UI 原型（`docs/ui-mockups/`）。
- 新增 `.gitattributes`：源码与文档统一 LF，Windows 启动脚本 `*.bat` 保留 CRLF，二进制文件标记为 binary。
- 新增 `.gitignore`：忽略应用运行时数据（项目数据目录、`project.db`、缓存、导出、备份、日志）、Python 与 Node 产物、编辑器与系统文件、密钥文件。
- 新增 `README.md`、`AGENTS.md`（说明书第 1 节同步副本）、`docs/development-log.md`、`docs/decisions.md`、`docs/known-limitations.md`。

### 变更

- 配置全局 Git 提交身份为 `CLnum42 <CLnum42@users.noreply.github.com>`，与开发者既有仓库的历史提交一致；用 `--reset-author` 改写了首次提交（哈希 `7da13d0` → `21c5a85`）。
- 建立 GitHub 远端 `git@github.com:CLnum42/book2text.git`（私有）并推送 `main`。
- 认证方式为 SSH（`~/.ssh/id_ed25519`，ed25519），新增 `~/.ssh/config` 中的 `github.com` 条目；同时执行 `gh auth setup-git` 配置 HTTPS 凭据助手。
- 开启 `push.autoSetupRemote`，新分支推送无需 `-u`。

### 已知问题

- 应用**尚无任何功能代码**，没有可运行的启动命令。
- `gh` CLI 的细粒度 PAT 范围为"仅选定仓库"，不含本仓库，故 `gh` 命令会返回 404（见 `docs/known-limitations.md` L-07）。`git` 命令不受影响。
- SSH 密钥未设口令（见 `docs/known-limitations.md` L-08）。
- 仓库为**私有**，许可证未定，暂时不得公开（见 `docs/decisions.md` D-006、D-008）。
