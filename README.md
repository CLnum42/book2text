# Book2Text

将**没有可用文本层的扫描版 PDF 图书**转换为经过人工审校、可追溯、保留结构信息的文本资产的本地网页应用。

产品形态是「Python 本地服务 + 浏览器界面」：用户双击启动脚本，浏览器打开 `127.0.0.1` 上的界面，全部数据保存在本机。它不是 OCR 包装器——核心价值在于**高效、可靠的人工审校**与**可追溯的数据**。

---

## 当前状态

> **从导入到导出再到核对都走通了：识别跑在后台任务里、能选页、能审校改字与改结构、能采用新结果，第二引擎的分歧能逐行标出并一键换候选，导出写进项目的 exports/，还能点一段跳回来源页与来源块。**

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
| **真实书的准确率（40 页 / 20108 字）** | ✅ 实测：**导出正文 CER 0.71%**（200 DPI，含页眉页码按位置排除），见 [`docs/ocr-evaluation.md`](docs/ocr-evaluation.md) 第 6–7 节（材料受版权保护，未入库） |
| **识别默认 DPI** | ✅ 由样本实测决定：**200**（300 DPI 时正文 CER 1.31%，200 DPI 时 1.08%；见 D-037） |
| **第二引擎（Apple Vision，说明书 8.5）** | ✅ 已接入：可按行复核、逐行看两路候选并采用。**实测它比第一引擎弱**（整页 CER 2.16% vs 1.08%；被标出的分歧里约八成是它自己的错）——功能保留但不承诺互补 |
| **分歧标记进审校视图（说明书 8.5 的落点）** | ✅ 可用：有分歧的块逐行标出**汉字级 / 标点级**与另一路候选，点「换成这一路」换过去（可撤销）、点行号在编辑框里选中那一行；缩略图打 `≠ N`；疑难筛选有「有分歧（汉字级）」与「有分歧（含标点级）」 |
| **第二引擎批量复核（接进任务执行器）** | ✅ 可用：「第二引擎复核所选」「复核全部未复核页」——跑在后台任务里，能暂停 / 继续 / 取消 / 重试失败页、中断恢复；默认跳过已复核的页 |
| **质量统计（说明书 8.5 / 13.4）** | ✅ 可用：项目视图里一张卡片——识别、审校（含人工修改率）、两路复核（**分歧率**：已复核页 / 比过的行 / 一致 / 仅格式 / 汉字级 / 标点级）、任务失败率；算不出来的指标（CER、捕获率、每页审校时间……）**如实列出并写明原因** |
| **什么时候该开第二引擎（判断依据）** | ✅ 已实测成文：捕获率 **64.6%**（能圈进第一引擎约 2/3 的错行）、改对率 24.6%、一致但都错 2.5%；还有一条口径修正——分级不减少噪声。见 [`docs/ocr-evaluation.md`](docs/ocr-evaluation.md) 第 9 节 |
| **识别落进项目（Phase 2 开头）** | ✅ 可用：识别按钮 → 块与行落库 → 重启还在；原始输出存 `ocr_runs/` |
| **任务执行器（Phase 2 主体）** | ✅ 可用：识别跑在**子进程**里；批量、进度、暂停 / 继续 / 取消、重试失败页、中断恢复 |
| **挑选页面与批量操作（Phase 2 收尾）** | ✅ 可用：单击 / Shift 范围 / ⌘ 多选 / 页码输入；批量设类型、纳入排除、识别所选、按类型与识别状态筛选 |
| **审校：编辑块与确认整页（Phase 3）** | ✅ 可用：块文本可编辑 + 自动保存、确认 / 不确定 / 排除 / 类型 / 延续、恢复原文、确认本页并跳下一处、撤销 / 重做；每次修改都进 Event 表 |
| **审校：结构编辑（Phase 3）** | ✅ 可用：与上一块合并、在光标处拆分、上移 / 下移、新增块、软删除；都记事件、都能撤销 |
| **审校：新结果对比与采用（Phase 3）** | ✅ 可用：页面有"待选新结果"时左右对比 → 采用（可撤销）/ 保留现有；疑难筛选（还没审完 / 有不确定 / 识别失败 / 有待选结果） |
| **导出接到项目上（Phase 4）** | ✅ 可用：预检（实时摘要）+ 预览 + 生成 TXT / JSONL + manifest，写进 `exports/<export_id>/`，可下载、可在文件夹中显示；每次导出有记录。**临时上传那一套已删除** |
| **导出对照模式（段 → 块 → 页溯源）** | ✅ 可用：左原图、右导出形态的连续段文本，点一段跳到来源页并高亮来源块 |
| **页眉页脚页码批量标注（说明书 6.5）** | ✅ 可用：位置规则 + 文本条件 → 预览（可逐个取消）→ 批量应用、整批可撤销、不覆盖人工改过的类型 |
| 逐块采用、框选新增块、页眉页脚预览的图上高亮 | ⬜ 未开始（Phase 3 余下） |
| 缩略图 Job、虚拟滚动、项目删除 | ⬜ 未开始（Phase 1 余下） |
| Phase 0 第 1 项：PaddleOCR 对比与版面组件 | ⬜ 未开始 |
| Phase 0 第 1–2 项：**真实扫描件**的准确率 | 🔶 有真实书数字（导出正文 CER 0.71%），但材料是干净栅格化，仍缺带扫描退化的样本；页边界与书眉页码的口径待确认 |
| Phase 0 第 5 项：可行性文档 | 🔶 部分完成：`docs/technical-feasibility.md` |
| Phase 5（审校任务包）、Phase 6（打包分发） | ⬜ 未开始（Phase 0–4 与 Phase 8 Step 1 的主体在路上，见下） |

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
- **审校**：双击某一页打开审校视图（左图右文）——块文本可直接编辑、停手自动保存；
  确认 / 标不确定 / 排除 / 改类型 / 标记延续；改过的块能看 OCR 原文也能恢复原文；
  **⌘/Ctrl + Enter** 确认本页并跳到下一处未完成；**⌘/Ctrl + Z** 撤销（撤销栈只在本次运行里）。
  每一次修改都写进项目的事件表，可追溯。
- **改结构**：每个块的 **⋯ 更多** 里有 与上一块合并 / 在光标处拆分 / 上移 / 下移 /
  在此块后新增 / 删除——同样都能撤销。
- **新识别结果**：页面"有待选新结果"时可以**左右对比**现有块与新结果，
  选择**采用**（可撤销）或**保留现有**；顶部"疑难"筛选能在需要处理的页之间跳转。
- **导出**：在项目里选格式（TXT / JSONL / 两者）、范围、页面类型、内容类型与清理规则，
  预检摘要实时算；生成后文件写进项目的 `exports/`，可以下载或在访达 / 资源管理器里打开，
  每次导出都有记录（段数、字数、未审段数）。
- **导出对照**：点"对照预览"——左边原图、右边导出形态的连续段文本；
  点任意一段，左边跳到来源页并把**来源块**框出来（段 → 块 → 页的溯源）。
- **页眉页脚批量标注**：结构工具面板里按位置规则（顶部 / 底部区域）与文本条件
  （数字形态、字数上限）预览会标注哪些块，逐条确认后一次批量应用（可整体撤销）。
- **两路分歧**：选中几页（或整本）点「第二引擎复核所选」/「复核全部未复核页」——
  后台任务逐页复核，可以暂停 / 取消；也可以在审校视图里点「第二引擎复核」单页复核（macOS 用系统自带的 Apple Vision）。
  有分歧的块会**逐行**列出"汉字级 / 标点级"与另一路候选——点行号就在编辑框里选中那一行，
  点「换成这一路」把这一行换过去（普通编辑，可撤销）。缩略图上有 `≠ N` 标记，
  顶部「疑难」筛选可以按分歧筛页（汉字级 / 含标点级两条）；项目上方的「质量统计」卡片
  汇总整本书复核了多少行、分歧率多少。**开之前建议先读
  [`docs/ocr-evaluation.md`](docs/ocr-evaluation.md) 第 9 节**——什么时候值得开、
  标记能圈进多少错行、哪些场景别指望它。
  **实测第二引擎比第一引擎弱**（分歧里七成是它自己的标点习惯），所以候选只作参考。

**现在还不能做什么：** 逐块采用新结果、在图上框选位置新增块、
页眉页脚预览的图上高亮、断词还原的逐处人工校正、缩略图缓存与虚拟滚动。
捕获率与「一致但都错」需要人工金标准，只能在离线测量里给（见 L-30 第 4 条）。见
[`docs/known-limitations.md`](docs/known-limitations.md) L-22、L-29、L-25、L-30。

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
uv run pytest -q                 # 运行测试（518 项；未装 OCR 依赖时自动跳过需要引擎的那些）
```

项目的原始 PDF 只被读取，导出的成果写在项目的 `exports/` 下。**原始文件不会被修改。**

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
