# 开发日志

按说明书 1.2 的报告模板逐条记录每次开发任务。**新的记录追加在最上面。**

模板字段：任务目标 / 当前状态 / 实施计划 / 实现与验证 / 用户操作说明 / 下一步建议。
未在真实环境运行过的测试一律注明，不得把未运行的测试写成通过。

---

## 2026-10-14 — 任务 4：Phase 0 第 1 项的两个门槛项（不等金标准）

### 任务目标

开发者提问："能不能先不管金标准？先跑通工作流比较重要？"

我的判断：**金标准只卡住准确率（CER）**，而 Phase 0 第 1 项里真正的门槛项有两个——
"第一引擎能否返回行级坐标"与"每页耗时"——**这两个都不需要金标准**，跑一遍就有答案。
所以本轮不等金标准，先把项目最大的技术风险探掉。

**不在范围内：** 准确率评估（需金标准）；PaddleOCR 对比；版面组件；第二引擎；
把 OCR 接进应用（属 Phase 2）。

### 当前状态

- 任务 3 完成：20 页无文本层样本可用。
- 未安装任何 OCR 依赖。
- 应用内没有 OCR（L-10）。

### 实施计划

1. 选定候选引擎与依赖组织方式。
2. **按说明书要求先写定门槛，再实测**（避免事后移动标准）。
3. 探明库的 API（不凭记忆假设）。
4. 跑 20 页，测量门槛项与内存等指标。
5. 修正受影响的既有代码，记录结论与未做的事。

### 实现与验证

**依赖组织：** 引擎装进独立的 `ocr-eval` 依赖组，**不进核心依赖**——
选型未定，最终用户不该被强制安装 300 MB 的 OCR 运行时。
`uv sync --group ocr-eval` 后 venv 由 60 MB 增至 323 MB。

**先定门槛：** `docs/ocr-evaluation.md` 第 1 节在实测**之前**写定判据
（G1 行级坐标；G2 ≤ 18 秒/页，取自说明书"400 页 ≤ 2 小时"的示例）。
文中明确标注这是**建议值、需开发者确认**，且不把任何数字称为"达标"直到实测。

**API 实测（说明书 1.1）：** 确认 `rapidocr.RapidOCR()(img)` 返回 `RapidOCROutput`，
含 `boxes`（每行四点框）、`txts`、`scores`、`elapse`。因此行级坐标是**原生返回**的。

| 验证项 | 结果 |
|---|---|
| **G1 行级坐标** | **达标**：20/20 页返回 `(行数, 4, 2)` 四点框，像素坐标 |
| **G2 每页耗时** | **达标**：中位 **2.04 s**、最大 3.67 s、最小 0.84 s（门槛 18 s，余量约 5 倍） |
| 识别耗时合计 | 42.87 s / 20 页；渲染另计 1.01 s |
| 识别行数合计 | 456 行 |
| 模型文件 | `PP-OCRv6_det_small.onnx` 等**随 wheel 内置**，运行时**无需联网** |
| 峰值内存 | **2686.6 MB** |
| 引擎初始化 | 0.01 s |
| 既有测试 | `uv run pytest -q` → **57 passed**（安装 OCR 依赖后仍全过） |

**修正了一个我自己埋的错：** `core/ocr/selfcheck.py` 原本只探测
`rapidocr_onnxruntime`（1.x 的包名），而实际安装的是 `rapidocr`（3.x），
会把已装的引擎**误报成"未安装"**。已改为按候选列表探测，并附带报告推理后端是否存在。
修正后自检正确报出 `RapidOCR 3.10.0 可用`。

**顺带的观察：** 引擎把样本第 2 页的竖排书名「红楼梦」与页脚页码「62」
也识别成了独立文本行。这印证了说明书 6.5「批量标注页眉 / 页脚 / 页码」的必要性——
这些元素在识别阶段就是普通文本行，不处理会混进导出。

**未验证 / 待处理项：**

1. **准确率完全没测。** 文档里的"均分"（0.958–0.996）是引擎自报置信度，**不是准确率**。
   未做任何 CER 计算。
2. **PaddleOCR 部署形态未测**，版面组件未测——所以**选型未定**，
   不能仅凭本轮就说 RapidOCR 是第一引擎。
3. **未在 Windows 上运行任何内容。**
4. **样本是干净栅格化**，真实扫描页会更慢、更难；耗时数字偏乐观。
5. **峰值内存 2.7 GB 只记录、未评级**，整书批量时的内存行为未验证。
6. 只用 300 DPI 测过，说明书 8.2 要求的 DPI 取值（200 / 300 / 400）对比未做。

### 用户操作说明

```bash
uv sync --group ocr-eval                      # 装评估依赖（约 300 MB）
uv run python scripts/evaluate_ocr.py         # 跑 20 页，输出到 docs/ocr-evaluation-raw.json
uv run python scripts/evaluate_ocr.py --dpi 400   # 换 DPI 重测
```

**结果看这里：** `docs/ocr-evaluation.md`（结论与逐页数据）、
`docs/ocr-evaluation-raw.json`（原始数据，可追溯）。

**回退方式：** 删除 `scripts/evaluate_ocr.py`、`docs/ocr-evaluation*.{md,json}`，
并从 `pyproject.toml` 移除 `ocr-eval` 依赖组；应用本身不依赖它。

### 下一步建议

**先补人工校对金标准，然后做 PaddleOCR 对比。**

理由：现在"能不能做"已经有答案了，剩下的是"哪个更好"。而"更好"要靠 CER 判断，
CER 要靠金标准。同时 **PaddleOCR 对比**是 Phase 0 第 1 项明确要求的，
它的行级坐标与耗时判据已经有了，**即使没有金标准也能先比这两项**——
所以如果暂时不想做金标准，可以先跑 PaddleOCR，把耗时、内存、体积、安装难度比出来。

两件事都做完，Phase 0 第 1 项就可以给开发者一份完整的选型建议了。

---

## 2026-10-14 — 任务 3：制作 Phase 0 扫描样本（20 页，无文本层）

### 任务目标

用 `test_books/` 的两本真实书籍制作 Phase 0 的扫描样本：选 20 页，输出无文本层的 PDF。
用途是解锁被卡住的 Phase 0 第 1–3 项（OCR 引擎实测与 PDF 库对比）。

**不在范围内：** 人工校对金标准（需开发者本人对照图像逐字抄录）；OCR 引擎的安装与实测。

### 当前状态

- 任务 2 完成：骨架可运行，57 项测试通过。
- `test_books/` 有两本真实书（369 + 662 页），此前只测出它们**有文本层**，
  未做选页与样本制作。

### 实施计划

1. 先摸清两本书的结构：目录、章节位置、脚注密度、插图、跨页段落位置。
2. 确认源书性质（原生数字 vs 扫描）——它决定样本的真实性。
3. 按说明书 13.1 的覆盖要求选页。
4. 写可复现的生成脚本（选页规则与参数固化），输出 PDF 与逐页清单。
5. 独立验证：页数、文本层字符数、页面对象构成、跨页段落是否承接。
6. 记录覆盖缺口与性质局限。

### 实现与验证

**关键发现一：源书不是扫描件。** 对象分析显示红楼梦每页 20–60 个文本对象、
安乐哲每页 30–60 个，都是**矢量文本**。渲染出来是干净的排版文字。
所以样本是"干净栅格化"，**不含**真实扫描的倾斜、噪点、透印、对比度不均。

**关键发现二：源 PDF 的文本层不可靠。** 红楼梦第三十八回回目渲染出来是
"薛**蘅**芜讽和螃蟹咏"，文本层提取却是"薛**祷**芜讽和螃蟹咏"；第四十回
"三**宣**牙牌令"被提取成"三**宜**牙牌令"。**图像正确、文本层错字**，
说明字体 ToUnicode 映射有问题。

两个后果：① 该文本层**不能**用作金标准；② 反证了产品立论——已有文本层未必可信。

**关键发现三：两本书都不含中英混排。** 安乐哲全书 0 页含汉字（中文只用罗马字转写），
红楼梦该文件 0 页含拉丁字母。说明书 13.1 要求的"中文与中英混排"**无法覆盖**。

| 验证项 | 方式 | 真实结果 |
|---|---|---|
| 选页覆盖 | 按类别检索章节标题（27 处回目）、脚注密集页（31 页）、跨页段落（25 处） | 20 页覆盖 7/9 个要求类别 |
| 生成 | `uv run python scripts/make_scan_samples.py` | 20 页，10.62 MB |
| **文本层已去除** | 逐页 `get_textpage().count_chars()` | **字符总数 0** |
| 结构符合扫描件 | 逐页对象类型统计 | **每页只有 1 个图像对象**（无文本、无矢量路径） |
| 页面尺寸 | 与原书对比 | 447×674 pt / 612×792 pt，与原书一致 |
| 跨页段落承接 | 渲染样本 p3 末 + p4 首拼接查看 | p3 结尾"…他只当是昨日金钏儿之事，他" → p4 开头"没好意思的，越发不理他。"**同一句，正确承接** |
| 体积 | — | 10.62 MB（0.53 MB/页，与真实 300 DPI 扫描书量级相当） |

**未验证 / 待处理项：**

1. **没有金标准**，所以 CER / 分歧率 / 捕获率**一个都还算不出**，Phase 0 第 1–2 项仍不能开工。
2. **两个覆盖类别缺失**：中英混排、低清晰度或倾斜页面。
3. **样本不是真实扫描件**，在它上面测得的识别质量会偏乐观，不能外推到真实旧书。
4. `scripts/make_scan_samples.py` 依赖不入库的 `test_books/`，全新克隆后无法重跑
   （脚本同时作为样本来源的书面记录）。
5. 仍未在 Windows 上验证任何内容。

### 用户操作说明

**样本已就位，可直接用于 Phase 0：**

```bash
ls -lh fixtures/pdf/sample-20p-300dpi.pdf          # 20 页，10.62 MB
uv run python -c "import json;print(json.load(open('fixtures/pdf/sample-20p-300dpi.manifest.json'))['pages'][0])"
uv run python scripts/make_scan_samples.py         # 重新生成（需 test_books/）
```

**逐页来源与类别**见 `docs/scan-sample-set.md` 第 2 节；
**覆盖度对照与全部局限**见同文件第 3、4 节。

**回退方式：** 删除 `fixtures/pdf/sample-20p-300dpi.pdf` 与其 `.manifest.json` 即可。

### 下一步建议

**请开发者制作 5–10 页人工校对金标准。**

理由：样本已经够了，现在**唯一的**瓶颈是金标准。没有它，Phase 0 第 1–2 项算不出任何
CER、分歧率、捕获率，也就无法判断第一引擎是否达标——而"每页耗时"与"行级坐标"
这两个门槛项不实测就不能定方案。

抄录时必须**对照页面图像**，不能用源 PDF 的文本层（它有错字，会把 OCR 的正确输出判成错误）。
建议选取覆盖：中文正文、英文正文、脚注密集页、复杂版面页各 1–2 页。

同时请先定下量化门槛（如 400 页 ≤ 2 小时 → 每页 ≤ 18 秒），写在
`docs/ocr-evaluation.md` 开头，再开始实测——说明书 Phase 0 第 1 项要求先定门槛。

---

## 2026-10-14 — 任务 2：Phase 0 第 4 项「最小骨架」

### 任务目标

按说明书第 14 节 Phase 0 第 4 项，做出可运行的最小骨架：`uv` 环境 + FastAPI 服务 +
一个静态页面，页面可上传 PDF 并显示第一页图像，并带一个"引擎自检"接口
（列出第一 / 第二引擎是否可用、版本、不可用的原因）。

**不在范围内：** Phase 0 第 1–3 项（OCR 引擎实测、PDF 库对比）——被测试样本缺失卡住；
Phase 1 的项目库与数据库；OCR 识别、审校、结构、导出。

### 当前状态

- 任务 1 完成：仓库在 GitHub（私有），身份与 SSH 认证已配置。
- 当时已知环境：Python 3.12.13、uv 0.12.3、Node v26.8.2 **都已安装**
  （更正：任务 0 里写的"尚未安装 Python / uv / Node.js"是未经验证的错误结论，
  见下方"更正"）。
- 无任何应用代码，无 `pyproject.toml`。

### 实施计划

1. 按说明书 1.1 先实测第三方库 API，不凭记忆写代码。
2. 建 uv 项目与依赖。
3. core 层：`platform.py`（平台分支集中于此）、`pdf/render.py`、`ocr/selfcheck.py`、
   `storage/scratch.py`（Phase 0 临时上传）。
4. api 层：令牌与 Origin 校验、上传、页面图像、`app/info` 自检。
5. `main.py` 入口：选端口、生成令牌、打开浏览器。
6. 静态页面 + 双平台启动脚本。
7. 真机验证 + 自动化测试。
8. 更新文档。

### 实现与验证

**先实测再写代码**（说明书 1.1）。探测确认了：`PdfPage.render(scale=…)` 返回的
bitmap 只有 `to_pil()` / `to_numpy()` 两条编码路径，前者需要 Pillow（原本未安装）；
`PdfDocument` 提供 `get_page_size()` 与 **`get_page_label()`**，后者正是说明书
Phase 0 第 3 项要求的"页码标签读取"。

| 验证项 | 命令 / 方式 | 真实结果 |
|---|---|---|
| 依赖安装 | `uv sync` | fastapi 0.143、uvicorn 0.54、pypdfium2 5.14、Pillow 12.3，全部有 arm64 wheel，无编译 |
| API 实测 | 探针脚本 | `len(doc)`=3、`get_page_size`=595.28×841.89 pt、页码标签可读、`to_pil()` 可用 |
| 合成样本 | reportlab（临时环境，不进依赖） | `fixtures/pdf/synthetic-smoke-3pages.pdf`，3 页，3.2 KB |
| 单元 + 集成测试 | `uv run pytest -q` | **57 passed** |
| 安全层 | curl | 无令牌 401、错令牌 401、伪造 Origin 403、正确 200，错误格式含 `correlation_id` |
| 上传链路 | curl | 3 页 PDF → 页数 3、SHA-256 正确；`view` 档 1241×1754 PNG 194 KB |
| 错误路径 | curl | 越界 400、未知档位 400、非 PDF 400、路径穿越 404、删除后 404 |
| 端口回退 | 启两个服务请求同一端口 | 第一个占 8903，第二个自动落到 8904 |
| 启动脚本 | `./scripts/start.command` | 真实跑通，首页与自检接口均 200 |
| **界面端到端** | ego-browser 真实浏览器 | 上传 PDF → 显示首页图像（blob URL，1241×1754）、元数据正确、翻页到 3/3、按钮禁用状态正确、无报错 |
| 渲染耗时 | 5 次取中位 | thumb 3.2 ms / view 25.6 ms / zoom 86.5 ms（**合成文件，非扫描件**） |

**更正一条此前的错误结论：** 任务 0 与 `known-limitations.md` L-04 曾写
"未检测到 Python 3.11+、uv、Node.js"。写下时**我并未实际检查**，属凭假设下结论，
违反说明书 1.7。实测全部早已安装。L-04 已移入"已解除"并注明这次更正。

**本次主动修正的两个问题：**

1. 日志顺序：输出重定向到文件时 stdout 是块缓冲的，uvicorn 的 stderr 日志会跑到启动横幅前面。
   已在 `_print_banner` 后加 `sys.stdout.flush()`。
2. `.gitignore` 原本忽略了 `backend/book2text/static/`（按 D-004 视其为构建产物），
   但 Phase 0 那里放的是手写源文件，必须入库。已修订 D-004 并解除忽略。

**工作期间发现的输入材料：** 开发者在 15:42 放入了 `test_books/`，含两本真实书籍
（《红楼梦》双语对照 369 页、安乐哲译本 662 页）。已用它们取到真实渲染数据（见
`docs/technical-feasibility.md` 1.3 节：`view` 档 30–45 ms/页、PNG 250–415 KB）。

**但这两本书都不是扫描版**：采样 6 页的文本层字符数为 145–1174，说明它们有大量可提取文字，
而本项目针对的是"没有可用文本层的扫描版 PDF"。因此它们**不能**用于 Phase 0 第 1–2 项的
OCR 实测（有文本层就测不出 CER 与识别率），只能用于渲染与性能测试。

`test_books/` **未入库**，已加入 `.gitignore`（版权 + 13MB 体积 + 它是输入材料而非产物）。
详见 `docs/known-limitations.md` L-16。

**未验证 / 待处理项（必须诚实记录）：**

1. **Windows 上什么都没有验证过。** `scripts/start.bat`、`selfcheck.py` 的 Windows OCR
   分支（含语言包检测）、`explorer /select,`、控制台 UTF-8 处理——全部从未在 Windows 上执行。
   代码中已就地标注。
2. **渲染耗时数据来自合成 PDF**（矢量文字），不能外推到真实扫描页。扫描件上的耗时与
   每页缓存占用仍未测。
3. **没有真实扫描样本**，因此无法评估 150 DPI 是否够看清小字。
4. **前端没有自动化测试。** 界面靠浏览器手动跑了一遍，57 项 pytest 全部覆盖后端。
5. **没有 CI**，测试靠手动运行。
6. 测试会出现一条第三方弃用警告（starlette 的 `httpx` → `httpx2`），不影响结果。

### 用户操作说明

**启动（任选一种）：**

```bash
cd /Users/chenlin/Desktop/软件开发/book2text
uv run book2text              # 或双击 scripts/start.command
```

浏览器会自动打开带令牌的地址。若不自动打开，终端里打印的"界面地址"可直接复制使用
（**必须带 `?token=…`**，否则界面会提示缺少令牌）。按 Ctrl+C 停止。

常用参数：`--port 9000`（起始端口）、`--no-browser`（不自动开浏览器）。

**验证：**

```bash
uv run pytest -q                    # 应全部通过
uv run book2text --no-browser       # 然后访问打印出的地址，上传一个 PDF
```

界面上应显示：平台徽章、7 条引擎自检（当前 0 可用）、当前限制清单；
上传 PDF 后显示元数据与首页图像，可翻页。

**回退方式：** 本任务的改动全部是新增文件；删掉 `pyproject.toml`、`uv.lock`、
`backend/`、`scripts/`、`tests/`、`fixtures/`、`.venv/` 即可回到任务 1 的状态。
上传的文件在 `~/Library/Application Support/Book2Text/scratch/`，可直接删除。

### 下一步建议

**先补上 Phase 0 的前置输入：制作 20–40 页测试样本与 5–10 页人工校对金标准。**

理由：Phase 0 剩下的第 1–3 项**全部**依赖这份输入，而它是说明书 13.1 规定由开发者
在 Phase 0 开始前完成的人工工作。骨架（第 4 项）已经把"跑得起来"这件事解决了，
现在瓶颈完全在样本上——继续写代码只会加深"没有实测数据"的空白。

样本到位后，第 1 项的头两件事是：先量化门槛（如 400 页 ≤ 2 小时 → 每页 ≤ 18 秒），
再实测第一引擎**是否返回行级坐标**与每页耗时。这两项不达标就必须立刻报告并调整方案，
不能静默降级（说明书 8.4）。

---

## 2026-10-14 — 任务 1：配置 Git 身份、SSH 认证与 GitHub 远端

### 任务目标

让仓库能在 macOS 上与开发者的 GitHub 账号（`CLnum42`）正常协作：配置提交身份、打通认证、建立远端并推送。不写任何功能代码。

### 当前状态

- 任务 0 已完成：本地仓库 `main` 分支有 1 个提交（`21c5a85`），无远端。
- 本机已安装 `gh` 2.102.0 并登录为 `CLnum42`；全局 Git 身份**未配置**；无 SSH 密钥。
- 首次提交的作者是系统回退值 `陈林 <chenlin@MacBook-Air-2.local>`。

### 实施计划

1. 查清开发者既有提交身份，避免造出第二套身份。
2. 配置全局 `user.name` / `user.email`，并用 `--reset-author` 改写首次提交。
3. 建立 GitHub 远端并推送。
4. 打通认证（优先复用已有凭据，不行再引入 SSH）。
5. 更新文档，记录配置方式与新增限制。

### 实现与验证

| 步骤 | 做法 | 真实结果 |
|---|---|---|
| 身份调研 | `gh api repos/CLnum42/.../commits` 读取历史作者 | 既有身份为 `CLnum42 <CLnum42@users.noreply.github.com>` |
| 邮箱可用性验证 | 检查历史提交的关联账号 | 5 条提交全部正确关联到 `CLnum42`，noreply 格式有效 |
| 写入身份 | `git config --global user.name/user.email` | 生效；`git var GIT_AUTHOR_IDENT` 返回新身份 |
| 改写首次提交 | `git commit --amend --reset-author` | 作者与提交者均变为 `CLnum42 <CLnum42@users.noreply.github.com>`，哈希由 `7da13d0` 变为 `21c5a85` |
| 凭据助手 | `gh auth setup-git` | github.com 与 gist 的 helper 指向 `gh auth git-credential` |
| **HTTPS 路线** | `gh repo create` / `gh api -X POST user/repos` | **失败**：`Resource not accessible by personal access token (createRepository)`。该细粒度 PAT 范围为"仅选定仓库" |
| 仓库创建 | 浏览器网页端（ego-browser）创建 | **成功**，`CLnum42/book2text`，Private |
| PAT 对新仓库 | `gh api repos/CLnum42/book2text` | **404** —— 证实 HTTPS 推送对本仓库也不通 |
| SSH 密钥 | `ssh-keygen -t ed25519` 生成 `~/.ssh/id_ed25519`，写入 `~/.ssh/config` | 成功 |
| 密钥上链 | 浏览器网页端提交公钥 | 触发 GitHub **sudo 模式**，需要密码；由开发者本人完成验证 |
| SSH 认证测试 | `ssh -T git@github.com` | `Hi CLnum42! You've successfully authenticated` |
| 切换远端 | `git remote set-url origin git@github.com:CLnum42/book2text.git` | 成功，fetch/push 均指向 SSH |
| 推送 | `git push -u origin main` | **成功**，`main -> main`，跟踪关系已建立 |
| 网页端复核 | 打开仓库页面检查 | 私有 ✓、22 个文件在列 ✓、提交信息正确 ✓、1 个分支 ✓ |

**未验证 / 待处理项：**

1. **未做任何构建或运行验证**，与任务 0 相同，仓库中仍无应用代码。
2. **推送只在 macOS 上验证过。** Windows 侧从未克隆或推送过本仓库。
3. **`gh` 命令对本仓库会 404**（L-07）。这是 token 范围问题，本次未解决——解决它需要编辑 PAT 权限，有导致 `gh` 登录失效的风险，且不影响 `git` 命令，故暂缓。
4. **SSH 密钥无口令**（L-08）。这是为免交互推送做的取舍，已在文档中记录。
5. **未配置任何 CI。** GitHub Actions 未启用，推送不会触发自动检查。

### 用户操作说明

**日常使用（已可直接工作）：**

```bash
cd /Users/chenlin/Desktop/软件开发/book2text
git add -A && git commit -m "..." && git push     # push.autoSetupRemote 已开启，无需 -u
git pull
```

**验证 SSH 认证：** `ssh -T git@github.com` 应返回 `Hi CLnum42!`

**仓库地址：** https://github.com/CLnum42/book2text （私有，需登录后访问）

**回退方式：** 解除 SSH 只需在 GitHub 设置中删除标题为 `MacBook-Air-2` 的密钥，并删除本地 `~/.ssh/id_ed25519*` 与 `~/.ssh/config`；撤销身份配置用 `git config --global --unset user.name`（`user.email` 同理）。

### 下一步建议

**安装 Python 3.11+ 与 `uv`，开始 Phase 0 第 4 项「最小骨架」。**

理由同任务 0：Phase 0 第 1–3 项依赖尚未制作的测试样本与人工校对金标准，而第 4 项最小骨架是唯一可以立即动手、且是后续所有实测载体的部分。

---

## 2026-10-14 — 任务 0：初始化 Git 仓库

### 任务目标

为 Book2Text 建立 Git 仓库，并让仓库目录布局符合开发说明书 V1.0 第 12.2 节，使后续每个 Phase 都能在版本管理下逐切片推进。本任务不写任何功能代码。

### 当前状态

- 目录中已有两份输入材料：开发说明书 V1.0（1286 行）与 6 个页面的 UI 原型（HTML + PNG）。
- 无 `pyproject.toml`，无任何应用代码。
  （**更正 2026-10-14：** 此处原写"尚未安装 Python / uv / Node.js"，那是**未经验证的假设**，
  违反说明书 1.7。实测这些工具早已安装，详见任务 2 与 `known-limitations.md` L-04。）
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
