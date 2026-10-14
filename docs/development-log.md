# 开发日志

按说明书 1.2 的报告模板逐条记录每次开发任务。**新的记录追加在最上面。**

模板字段：任务目标 / 当前状态 / 实施计划 / 实现与验证 / 用户操作说明 / 下一步建议。
未在真实环境运行过的测试一律注明，不得把未运行的测试写成通过。

---

## 2026-10-14 — 任务 0：初始化 Git 仓库

### 任务目标

为 Book2Text 建立 Git 仓库，并让仓库目录布局符合开发说明书 V1.0 第 12.2 节，使后续每个 Phase 都能在版本管理下逐切片推进。本任务不写任何功能代码。

### 当前状态

- 目录中已有两份输入材料：开发说明书 V1.0（1286 行）与 6 个页面的 UI 原型（HTML + PNG）。
- 尚未安装 Python / uv / Node.js，无 `pyproject.toml`，无任何应用代码。
- 此前该目录**不是** Git 仓库（`git status` 返回 `fatal: not a git repository`）。

### 实施计划

1. 按说明书 12.2 整理目录：说明书移入 `docs/spec-v1.0.md`，UI 原型移入 `docs/ui-mockups/`。
2. 新建 `.gitignore`：兜底防护运行时数据（`b2t_*/`、`project.db`、缓存、导出、备份、日志），忽略 Python / Node 产物、密钥、编辑器与系统文件。
3. 新建 `.gitattributes`：源码与文档统一 LF，`*.bat` 为 CRLF，二进制文件标记 binary（说明书第 10 节）。
4. 新建 `README.md`（含真实进度表）、`AGENTS.md`（说明书第 1 节同步副本）。
5. 补建 `CHANGELOG.md`、`docs/decisions.md`、`docs/known-limitations.md`，并写入本次决策。
6. `git init -b main`，完成首次提交。
7. **不在范围内：** Python 环境与依赖（`pyproject.toml` / `uv.lock`）、后端与前端骨架、测试样本与金标准——这些属于 Phase 0，按说明书 12.2「不预建空模块」暂不创建。

### 实现与验证

实际执行的命令与真实结果：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 检查工作目录 | `ls -la` | 1 个 .md 说明书 + `ui-mockups/` 目录 |
| 检查 Git 环境 | `git --version` | `git version 2.50.1 (Apple Git-155)` |
| 检查 Git 身份 | `git config --list --show-origin` | 全局**未设置** `user.name` / `user.email`；`init.defaultbranch=main` |
| 测试身份回退 | `git var GIT_AUTHOR_IDENT` | 返回 `陈林 <chenlin@MacBook-Air-2.local>`（见下方"未验证 / 待处理"） |
| 检查文本编码与换行 | `file` + `grep -c $'\r'` | 说明书为 UTF-8、0 个 CR，已是 LF，无需转换 |
| 整理目录 | `mkdir -p docs && mv ...` | 13 个文件全部就位，根目录不再有散落文件 |
| 初始化仓库 | `git init -b main` | 见提交记录 |

**未验证 / 待处理项（必须诚实记录）：**

1. **本任务没有在 Windows 上验证过任何内容。** 换行与路径策略只在 macOS 上检查；Windows 侧的实际检出效果属于 Phase 0 的验收内容。
2. **Git 提交身份是系统默认回退值**（`陈林 <chenlin@MacBook-Air-2.local>`）。该邮箱是主机名回退值，不是真实邮箱。当前仓库无远端，可以接受；**推送到任何远端仓库之前必须修正**，否则提交历史会带上无效邮箱。修正方式见"用户操作说明"。
3. 仓库尚未配置远端（`git remote` 为空），也未决定托管平台。
4. `.gitattributes` 的换行规则**尚未用真实的多平台克隆验证过**——目前仓库里没有需要跨平台检出的代码文件，"两个平台检出结果一致"这个结论要等 Phase 0 在两个平台各自克隆后才能确认。
5. 说明书第 1 节的同步副本为人工抽取，已核对首尾行；但"说明书更新后 `AGENTS.md` 是否仍然一致"没有自动校验机制，需要人工维护。

### 用户操作说明

**验证仓库状态：**

```bash
cd /Users/chenlin/Desktop/软件开发/book2text
git log --oneline          # 应看到首次提交
git status                 # 应为 clean
git ls-files               # 应列出说明书、UI 原型、文档与配置文件
git check-attr text eol -- README.md scripts/start.bat
```

**在推送远端之前修正提交身份（重要）：**

```bash
cd /Users/chenlin/Desktop/软件开发/book2text
git config user.name  "你的名字"
git config user.email "你的邮箱@example.com"
git commit --amend --reset-author --no-edit   # 改写首次提交的作者信息
```

**回退方式：** 本任务只新增文件，未修改、未删除说明书与 UI 原型的任何内容（仅移动路径）。如需完全回退，删除 `.git/` 目录并把 `docs/spec-v1.0.md`、`docs/ui-mockups/` 移回根目录即可。

### 下一步建议

**安装 Python 3.11+ 与 uv，然后开始 Phase 0 第 4 项「最小骨架」。**

理由：Phase 0 的第 1–3 项（第一引擎与版面组件实测、第二引擎逐平台实测、PDF 库选定）都以测试样本与金标准为前置输入，而这两份输入尚未准备；第 4 项最小骨架是唯一立即可以动手的部分，且它能同时验证"两个平台用启动脚本跑通 FastAPI + 静态页面 + 上传 PDF 显示首页图"这条主干路径，是后续所有实测的载体。
