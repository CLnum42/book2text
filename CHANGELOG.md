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

### 已知问题

- 提交身份使用 Git 系统默认回退值 `陈林 <chenlin@MacBook-Air-2.local>`（全局配置未设置）。推送到任何远端仓库前需改为真实邮箱，详见 `docs/known-limitations.md`。
- 仓库已初始化但**尚无任何功能代码**，没有可运行的启动命令。
